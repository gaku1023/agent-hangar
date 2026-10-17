import {
  decodeEpochList,
  encodeEpochList,
  fromBase64Url,
  importPrivate,
  MAX_KEYBOXES_PER_PUT,
  openKeybox,
  randomEpochKey,
  RECOVERY_RECIPIENT,
  sealKeybox,
  toBase64Url,
  type DeviceOut,
  type KeyboxIn,
} from '@agent-hangar/shared';
import { MessageError, msg } from '../i18n/message.ts';
import { CloudError, type HttpCloudClient } from './client.ts';
import type { Keyring } from './keyring.ts';
import type { ConfigWriter, RosterStore } from './roster.ts';
import type { SyncStateStore } from './state.ts';

/**
 * PC の解除と世代の回し（設計書「解除と暗号鍵の再生成」）。
 *
 * 解除した PC が、次の順で行う。
 * (1) sync_state の rotation に `{ id, newEpoch, step }` を書く。
 * (2) `POST /devices/:id/revoke` で、その PC の端末トークンを無効にする。
 * (3) 新しい世代鍵を作り、Keyring と cloud.json に足す。今の世代はまだ進めない。
 * (4) 名簿からその PC を外す。
 * (5) 残りの PC とリカバリーキーに、世代 1 から n＋1 の全部を封じた keybox を置く。
 * (6) 以後の書き込みを新しい世代にし、名簿を新しい世代で封じ直す。
 * (7) rotation を消す。
 *
 * 各段の終わりに rotation の step を次の段へ進める。
 * アプリが途中で落ちたら、次の起動の resumeRotation が記録の段から続ける。
 * 新しい世代鍵は (3) で cloud.json に書いたものを使う（作り直すと、配った鍵と食い違う）。
 * (2) はやり直しても同じ結果になる（Worker は解除済みの端末をそのまま返す）。
 *
 * 新しい世代で書くのは (5) が済んでからである。
 * 配る前に新しい世代で封じた行は、落ちたまま起動しなければ、この PC のほかに誰も開けないからである。
 *
 * R2 の既存のファイルは上げ直さない（再暗号化しない）。
 * 解除した PC は過去の世代の鍵を持つが、端末トークンが無効なので Worker から取れない。
 * 世代を回した後に書き直したファイルは新しい鍵名になり、古い鍵名の本文は上げた PC が消す（sync/trashSweep.ts の sweepSupersededBlobs）。
 *
 * 2 台が同時に別の PC を解除して、同じ番号の世代を作ることがある。
 * (5) の前に自分宛ての keybox を読み、同じ番号の世代に別の鍵が配られていれば、自分の鍵を捨ててその鍵を受け入れ、次の番号で回し直す。
 * 読んでから置くまでの間に重なったときは見分けられない（残りの危うさ）。
 */

/** rotation の段。次に行う段を名乗る。 */
export type RotationStep = 'revoke' | 'key' | 'roster' | 'boxes' | 'switch';
export type Rotation = { id: string; newEpoch: number; step: RotationStep };

const STEPS: readonly RotationStep[] = ['revoke', 'key', 'roster', 'boxes', 'switch'];

/** 同じ番号の世代を他の PC に先に配られて、回し直す回数の上限。 */
export const ROTATION_MAX_RESTARTS = 3;

/** 世代の回しが使う線の口。 */
export type RotateWire = Pick<HttpCloudClient, 'revokeDevice' | 'listDevices' | 'putKeyboxes' | 'getKeyboxes'>;

export type RotateDeps = {
  client: RotateWire;
  roster: Pick<RosterStore, 'read' | 'update' | 'refreshKeyboxes' | 'invalidate'>;
  keyring: Keyring | Promise<Keyring>;
  state: SyncStateStore;
  /** cloud.json の読み書き。RosterStore に渡したものと同じもの。 */
  cfg: ConfigWriter;
  /** この PC の端末 ID。 */
  deviceId: string;
  /**
   * 他の PC が配った世代鍵が増えたときに呼ぶ（飛ばした行と本文の取り直し。sync/roster.ts の rosterRefresh と同じ道）。
   * 自分で作った世代では呼ばない。その世代で封じた行は、まだどこにも無いからである。
   */
  onGained?: () => void;
};

export type RevokePcOptions = RotateDeps & { id: string };

/** この PC 自身を解除しようとした。参加の解除（hangar cloud leave）の道を使う。 */
export class RevokeSelfError extends MessageError {
  constructor() {
    super(msg('sync.revoke.self'));
    this.name = 'RevokeSelfError';
  }
}

/** 解除しようとした端末が、Worker の一覧に無い。 */
export class RevokeNotFoundError extends MessageError {
  constructor() {
    super(msg('sync.revoke.notFound'));
    this.name = 'RevokeNotFoundError';
  }
}

/**
 * 設定のクラウド同期の「解除」（`POST /api/sync/cloud-devices/:id/revoke`）。解除した端末の行を返す。
 * Worker の一覧で種類を見て、PC なら revokePc で世代を回し、スマホなら端末トークンだけを無効にする。
 * スマホ用の鍵の世代を回すのはスマホの解除（PR 7）で、ここでは扱わない。
 * 一覧に無い端末は RevokeNotFoundError、自分自身は RevokeSelfError で断る。
 */
export async function revokeMember(o: RevokePcOptions): Promise<DeviceOut> {
  if (o.id === o.deviceId) throw new RevokeSelfError();
  const target = (await o.client.listDevices()).find((d) => d.id === o.id);
  if (!target) throw new RevokeNotFoundError();
  if (target.kind === 'mobile') return o.client.revokeDevice(o.id);
  return (await revokePc(o)) ?? target;
}

/** 途中の記録を読む。無いか、読めない形なら null（読めない形は上書きされるまで残す）。 */
export function readRotation(state: SyncStateStore): Rotation | null {
  const raw = state.get('rotation');
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Rotation> | null;
    if (v && typeof v.id === 'string' && v.id !== '' && Number.isSafeInteger(v.newEpoch) && (v.newEpoch as number) >= 2 && STEPS.includes(v.step as RotationStep)) {
      return { id: v.id, newEpoch: v.newEpoch as number, step: v.step as RotationStep };
    }
  } catch {
    // 下で知らせる。
  }
  console.error('[rotate] the rotation record in sync_state could not be read');
  return null;
}

const save = (state: SyncStateStore, r: Rotation): Rotation => {
  state.set('rotation', JSON.stringify(r));
  return r;
};

/**
 * PC を解除して、世代を回す。解除した端末の行を返す（Worker が知らない端末なら null）。
 * 途中の記録が残っていれば、先にそれを終わらせる。同じ PC の記録なら、その続きを行うだけである。
 * 失敗は投げ、記録は残す（次の起動か、次の解除で続ける）。
 */
export async function revokePc(o: RevokePcOptions): Promise<DeviceOut | null> {
  if (o.id === o.deviceId) throw new RevokeSelfError();
  const pending = readRotation(o.state);
  if (pending) {
    const device = await run(o, pending);
    if (pending.id === o.id) return device;
  }
  const ring = await o.keyring;
  // 他の PC が先に回した世代があれば、その次の番号にする。
  if (await o.roster.refreshKeyboxes()) o.onGained?.();
  const newEpoch = Math.max(...ring.epochs()) + 1;
  return run(o, save(o.state, { id: o.id, newEpoch, step: 'revoke' }));
}

/** 起動のときに、途中の記録があれば続きから終わらせる。終わらせたら true、記録が無ければ false。 */
export async function resumeRotation(o: RotateDeps): Promise<boolean> {
  const pending = readRotation(o.state);
  if (!pending) return false;
  await run(o, pending);
  return true;
}

async function run(o: RotateDeps, start: Rotation): Promise<DeviceOut | null> {
  const ring = await o.keyring;
  let rec = start;
  let device: DeviceOut | null = null;
  for (let restarts = 0; ; ) {
    if (rec.step === 'revoke') {
      try {
        device = await o.client.revokeDevice(rec.id);
      } catch (e) {
        // Worker の知らない端末は、もう認証できない。世代は回す（名簿に残っていれば、古い世代の鍵を持っている）。
        if (!(e instanceof CloudError && e.status === 404)) throw e;
      }
      rec = save(o.state, { ...rec, step: 'key' });
    }
    if (rec.step === 'key') {
      // 落ちた後の続きなら、(3) で cloud.json に書いた鍵を使う。
      const key = o.cfg.read().epochs[String(rec.newEpoch)] ?? randomEpochKey();
      await ring.addPending(rec.newEpoch, key);
      o.cfg.write(ring.toConfigPatch());
      rec = save(o.state, { ...rec, step: 'roster' });
    }
    if (rec.step === 'roster') {
      const id = rec.id;
      await o.roster.update((r) => ({ ...r, entries: r.entries.filter((e) => e.id !== id) }));
      rec = save(o.state, { ...rec, step: 'boxes' });
    }
    if (rec.step === 'boxes') {
      const theirs = await claimedByOther(o, ring, rec.newEpoch);
      if (theirs) {
        if (++restarts > ROTATION_MAX_RESTARTS) throw new Error(`epoch ${rec.newEpoch} kept being taken by another computer`);
        // 自分の鍵はまだ誰にも配っていない（自分宛ての箱が別の鍵なので）。捨てて、配られた鍵を受け入れる。
        ring.dropEpoch(rec.newEpoch);
        await ring.addEpochs({ epochs: theirs });
        o.cfg.write(ring.toConfigPatch());
        o.onGained?.();
        console.warn(`[rotate] another computer already rotated to epoch ${rec.newEpoch}; rotating again`);
        rec = save(o.state, { ...rec, newEpoch: Math.max(...ring.epochs()) + 1, step: 'key' });
        continue;
      }
      await deliver(o, ring, rec);
      rec = save(o.state, { ...rec, step: 'switch' });
    }
    if (rec.step === 'switch') {
      ring.useEpoch(rec.newEpoch);
      o.cfg.write(ring.toConfigPatch());
      // 名簿を新しい世代で封じ直す。(4) の名簿は前の世代で封じてあり、解除した PC の手元の鍵で開ける。
      await o.roster.update((r) => r);
      o.state.set('rotation', null);
      return device;
    }
  }
}

/**
 * 自分宛てのいちばん新しい keybox に、newEpoch の世代が別の鍵で入っていれば、その一覧を返す。
 * 箱が無い、古い、開けない、同じ鍵（前の試みで自分が置いた）なら null。
 */
async function claimedByOther(o: RotateDeps, ring: Keyring, newEpoch: number): Promise<Record<string, string> | null> {
  const { boxes } = await o.client.getKeyboxes();
  const box = boxes.reduce<(typeof boxes)[number] | null>((a, b) => (a === null || b.epoch > a.epoch ? b : a), null);
  if (!box || box.epoch < newEpoch) return null;
  let epochs: Record<string, string>;
  try {
    const sealed = fromBase64Url(box.sealed);
    if (!sealed) throw new Error('not base64url');
    const { keyPair } = o.cfg.read();
    epochs = decodeEpochList(await openKeybox(await importPrivate(keyPair.priv), keyPair.pub, { epoch: box.epoch, recipient: o.deviceId }, sealed)).epochs;
  } catch {
    console.warn(`[rotate] the newest keybox for this PC (epoch ${box.epoch}) could not be opened`);
    return null;
  }
  const theirs = epochs[String(newEpoch)];
  if (theirs === undefined || theirs === ring.toConfigPatch().epochs[String(newEpoch)]) return null;
  return epochs;
}

/**
 * (5) 残りの PC とリカバリーキーに、世代 1 から newEpoch までの全部を封じた keybox を置く。
 * GET /keyboxes は受け手ごとにいちばん新しい箱 1 つだけを返すので、新しい箱には過去の世代を全部入れる。
 *
 * 名簿は Worker から読み直す（(4) の後に他の PC が承認で足した PC にも配るため）。
 * 名簿の PC のうち、Worker が解除済みとするものには置かない。
 * PUT /keyboxes は知らない受け手が 1 つでも混ざると全部を断るので、断られた塊は Worker が今いるとする PC だけで置き直す。
 */
async function deliver(o: RotateDeps, ring: Keyring, rec: Rotation): Promise<void> {
  o.roster.invalidate();
  const { roster } = await o.roster.read();
  const devices = await o.client.listDevices();
  const revoked = new Set(devices.filter((d) => d.revokedAt !== null).map((d) => d.id));
  const active = new Set(devices.filter((d) => d.kind === 'pc' && d.revokedAt === null).map((d) => d.id));
  const epochs = Object.fromEntries(Object.entries(ring.toConfigPatch().epochs).filter(([n]) => Number(n) <= rec.newEpoch));
  const content = encodeEpochList({ epochs });
  const targets = roster.entries.filter((e) => e.kind === 'pc' && e.id !== rec.id && !revoked.has(e.id)).map((e) => ({ recipient: e.id, pub: e.pub }));
  if (roster.recoveryPub !== '') targets.push({ recipient: RECOVERY_RECIPIENT, pub: roster.recoveryPub });
  const boxes: KeyboxIn[] = await Promise.all(
    targets.map(async (t) => ({ epoch: rec.newEpoch, recipient: t.recipient, sealed: toBase64Url(await sealKeybox(t.pub, { epoch: rec.newEpoch, recipient: t.recipient }, content)) })),
  );
  for (let i = 0; i < boxes.length; i += MAX_KEYBOXES_PER_PUT) {
    const chunk = boxes.slice(i, i + MAX_KEYBOXES_PER_PUT);
    try {
      await o.client.putKeyboxes(chunk);
    } catch (e) {
      if (!(e instanceof CloudError && e.status === 400)) throw e;
      const kept = chunk.filter((b) => b.recipient === RECOVERY_RECIPIENT || active.has(b.recipient));
      console.warn(`[rotate] the Worker refused some keybox recipients; placing ${kept.length} of ${chunk.length} again`);
      if (kept.length > 0) await o.client.putKeyboxes(kept);
    }
  }
}
