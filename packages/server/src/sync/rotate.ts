import {
  decodeEpochList,
  encodeEpochList,
  fromBase64Url,
  fromBase64UrlLen,
  importPrivate,
  JOIN_CODE_TTL_MS,
  MAX_KEYBOXES_PER_PUT,
  openKeybox,
  PHONE_KEY_LEN,
  randomEpochKey,
  RECOVERY_RECIPIENT,
  sealKeybox,
  sealPhoneKeybox,
  toBase64Url,
  type DeviceOut,
  type EpochClaim,
  type KeyboxIn,
  type Roster,
  type RosterEntry,
} from '@agent-hangar/shared';
import { MessageError, msg } from '../i18n/message.ts';
import { CloudError, RevokedError, type HttpCloudClient } from './client.ts';
import type { Keyring } from './keyring.ts';
import { sealRecoveryBoxes } from './recoveryReissue.ts';
import type { ConfigWriter, RosterStore } from './roster.ts';
import type { SyncStateStore } from './state.ts';

/**
 * PC の解除と世代の回し（設計書「解除と暗号鍵の再生成」）。
 *
 * 解除した PC が、次の順で行う。
 * (1) sync_state の rotation に `{ id, newEpoch, step, cloudId }` を書く。
 * (2) `POST /devices/:id/revoke` で、その PC の端末トークンを無効にする。
 * (3) 新しい世代鍵を作り、Keyring と cloud.json に足す。今の世代はまだ進めない。
 * (4) 名簿からその PC を外し、同じ書き換えで新しい世代の番号を確保する（名簿の epochClaim）。
 * (5) 残りの PC とリカバリーキーに、世代 1 から n＋1 の全部を封じた keybox を置く。
 * (6) 以後の書き込みを新しい世代にし、名簿を新しい世代で封じ直す。
 *     同じ書き換えで、名簿のスマホ用の鍵 M を次の世代にする。解除した PC は、手元の M で受信箱と起動のリクエストを開けるからである。
 *     新しい M は新しい世代で封じた名簿にだけ入れるので、解除した PC は D1 の写しからも読めない。
 *     M は (5) で名簿を読んだときの世代より先へ 1 度だけ進める（記録の phoneFrom。落ちた後の続きで 2 度回さない）。
 *     (5) の後で名簿に足された PC（参加の承認と重なった）がいれば、その PC にも keybox を置く。
 *     (5) の後でリカバリーキーが再発行されていれば（名簿の recoveryPub が (5) で封じた公開鍵と違えば）、新しい公開鍵宛てに全世代の recovery の箱を置き直す。
 *     最後に、名簿に残るスマホに今の M の keybox を置く（スマホの解除と同じ処理）。
 *     スマホの解除の記録（phoneRevoke）には触らない。
 * (7) rotation を消す。記録の next に積んだ PC があれば、消さずにその PC の記録に書き換えて (2) から続ける。
 *
 * 各段の終わりに rotation の step を次の段へ進める。
 * アプリが途中で落ちたら、次の起動の resumeRotation が記録の段から続ける。
 * 記録の cloudId が今のクラウドと違えば（作り直した後）、記録を捨てる。
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
 * 2 台が同時に別の PC を解除しても、世代の番号は (4) の名簿の条件付き更新で確保するので、同じ番号は取れない。
 * 409 で当て直すときに、他の PC が自分の番号以上を確保していれば、その次の番号に付け替える（鍵の中身は番号に依らないので作り直さない）。
 * 付け替えたときは、越えた世代の鍵を keybox で受け取ってから (5) に進む。
 * GET /keyboxes は受け手ごとにいちばん新しい箱だけを返すので、後の世代の箱に前の世代の鍵が入っていないと、前の世代の行を開けない PC が残るからである。
 */

/** rotation の段。次に行う段を名乗る。 */
export type RotationStep = 'revoke' | 'key' | 'roster' | 'boxes' | 'switch';
export type Rotation = {
  id: string;
  newEpoch: number;
  step: RotationStep;
  /** 記録を書いたときのクラウドの ID（cloud.json の cloudId）。 */
  cloudId: string;
  /** (4) で越えた、他の PC が確保した世代。その鍵を受け取ってから (5) に進む。by が空なら確保した PC は分からない。 */
  after?: EpochClaim;
  /** (5) で keybox を置いた PC。(6) の後に名簿と見比べ、増えた PC にも置く。 */
  sent?: string[];
  /** (5) で読んだ名簿のスマホ用の鍵 M の世代（M が無ければ 0）。(6) で、名簿の M がこの世代以下のときだけ次の世代にする。 */
  phoneFrom?: number;
  /** (5) で recovery の箱を封じた公開鍵。(6) の名簿の recoveryPub と違えば、全世代の recovery の箱を置き直す。 */
  recoveryPub?: string;
  /**
   * この回しを終えた後に、続けて解除して回す PC（積んだ順）。
   * この回しが越えた世代の鍵を待って止まっている間に、利用者が別の PC を解除したときに積む（revokeKnown）。
   * 端末トークンは積んだときに無効にしてあるが、続きは (2) からやり直す（やり直しても同じ結果になる）。
   */
  next?: string[];
};

const STEPS: readonly RotationStep[] = ['revoke', 'key', 'roster', 'boxes', 'switch'];

/** 同じ番号の世代を他の PC に先に配られて、回し直す回数の上限。 */
export const ROTATION_MAX_RESTARTS = 3;

/** keybox を置けない PC（承認の途中）と、越えた世代の鍵を待つ間隔と回数。合わせて 10 秒ほど。 */
export const DELIVER_RETRY_MS = 2000;
export const DELIVER_RETRIES = 5;

/**
 * 名簿にいて Worker にいない PC を、承認の途中で止まった名残とみなすまでの時間（名簿の joinedAt から）。
 * 承認は参加コードの期限（5 分）の内に行い、端末トークンの受け取りはその後 5 分まで待つ。PC の間の時計のずれの分を足す。
 */
export const JOIN_STALE_MS = 3 * JOIN_CODE_TTL_MS;

/** 起動のときの続きや解除が失敗して、記録が残ったときに、もう一度試すまでの間。 */
export const ROTATION_RETRY_MS = 5 * 60_000;

/** 世代の回しとスマホの解除が使う線の口。 */
export type RotateWire = Pick<HttpCloudClient, 'revokeDevice' | 'listDevices' | 'putKeyboxes' | 'getKeyboxes' | 'putPhoneKeyboxes'>;

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
  /** 試し直しの間を待つ。試験が差し替える。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** スマホの解除で作る次の世代の M。既定は 32 バイトの乱数。試験が差し替える。 */
  newPhoneKey?: () => Uint8Array;
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

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 設定のクラウド同期の「解除」（`POST /api/sync/cloud-devices/:id/revoke`）。解除した端末の行を返す。
 * Worker の一覧で種類を見て、PC なら revokePc で世代を回し、スマホなら revokePhone でスマホ用の鍵 M だけを次の世代にする。
 * 一覧に無い端末は RevokeNotFoundError、自分自身は RevokeSelfError で断る。
 * すでに解除した端末には何もせず、今の行を返す。
 */
export async function revokeMember(o: RevokePcOptions): Promise<DeviceOut> {
  if (o.id === o.deviceId) throw new RevokeSelfError();
  const target = (await o.client.listDevices()).find((d) => d.id === o.id);
  if (!target) throw new RevokeNotFoundError();
  if (target.kind === 'mobile') {
    if (target.revokedAt !== null) return target;
    return (await revokePhone(o)) ?? (await deviceRow(o, o.id)) ?? target;
  }
  const done = await revokeKnown(o, target);
  if (!done) throw new RevokeNotFoundError();
  return done;
}

/**
 * スマホの解除の途中の記録（sync_state の phoneRevoke）。解除するスマホの ID と、記録を書いたときのクラウドの ID。
 * PC の回し（rotation）と違って段を持たない。どの段も、やり直しても同じ結果になるからである（runPhone の注）。
 */
type PhoneRevokeRecord = { id: string; cloudId: string };

/**
 * スマホの解除の途中の記録を読む。無いか読めなければ null。
 * 記録の cloudId が今のクラウドと違えば（作り直した後）、記録を消して null を返す。
 */
export function readPhoneRevoke(state: SyncStateStore, cloudId: string): { id: string } | null {
  const raw = state.get('phoneRevoke');
  if (raw === null) return null;
  let v: Partial<PhoneRevokeRecord> | null = null;
  try {
    v = JSON.parse(raw) as Partial<PhoneRevokeRecord> | null;
  } catch {
    // 下で知らせる。
  }
  if (!v || typeof v.id !== 'string' || v.id === '') {
    console.error('[rotate] the phone removal record in sync_state could not be read');
    return null;
  }
  if (v.cloudId !== cloudId) {
    console.warn('[rotate] dropped a phone removal record left from another cloud');
    state.set('phoneRevoke', null);
    return null;
  }
  return { id: v.id };
}

/**
 * スマホを解除する（設計書「スマホの解除」）。解除した端末の行を返す（Worker が知らない端末なら null）。
 * (1) sync_state の phoneRevoke に記録を書き、(2) `POST /devices/:id/revoke` で端末トークンを無効にする。
 * (3) 名簿からそのスマホを外し、同じ書き換えで名簿の phoneKey を M[m+1] に差し替える。他の PC は名簿を読んだときに写す（RosterStore.adoptPhoneKey）。
 * (4) 名簿に残るスマホのうち Worker が解除していないものの公開鍵に M[m+1] を封じ、`PUT /phone-keyboxes` に置く。
 * (5) 記録を消す。
 * PC の世代鍵は回さない。解除したスマホは PC の行を読めないからである。
 * 残りのスマホは受信箱の素の世代が手元より新しいと keybox を読み直すので、接続は切れない。
 * 受信箱の書き手は、世代が進むと同じ中身でも書き直す（mobile/publisher.ts。次のきっかけか、60 秒の安全網で）。
 * 失敗は投げ、記録は残す。次の起動の resumeRotation と、5 分おきの試し直しが続きを行う。
 */
export async function revokePhone(o: RevokePcOptions): Promise<DeviceOut | null> {
  if (o.id === o.deviceId) throw new RevokeSelfError();
  const cloudId = o.cfg.read().cloudId;
  const left = readPhoneRevoke(o.state, cloudId);
  // 記録は 1 件分しか持てない。別のスマホの記録が残っていれば、上書きする前にその解除を終わらせる。
  if (left && left.id !== o.id) await runPhone(o, left.id, true);
  // 同じスマホの記録が残っていれば、前の解除の続きである（画面の「もう一度試す」）。
  const resumed = left?.id === o.id;
  o.state.set('phoneRevoke', JSON.stringify({ id: o.id, cloudId } satisfies PhoneRevokeRecord));
  return runPhone(o, o.id, resumed);
}

/**
 * スマホの解除の (2) から (5)。
 * どの段もやり直してよい。Worker は解除済みの端末をそのまま返す。
 * 名簿にまだそのスマホがいれば、外すのと M を回すのを 1 回の書き換えで行うので、名簿にいないなら M はもう回してある
 * （か、そのスマホは M を受け取る前に解除された。接続の直後に解除されたスマホは、pairer が名簿から外す）。
 * keybox は名簿の今の M を置くので、置き直しても同じか、より新しい世代になる。
 * 置くのは、ここで M を回したときと、記録の続き（resumed）のときだけである。
 * 名簿にいないスマホの初めての解除では、M も keybox も前のままでよい。
 */
async function runPhone(o: RotateDeps, id: string, resumed: boolean): Promise<DeviceOut | null> {
  let device: DeviceOut | null = null;
  try {
    device = await o.client.revokeDevice(id);
  } catch (e) {
    if (!(e instanceof CloudError && e.status === 404)) throw e;
  }
  // 他の PC が世代を回した直後なら、名簿はこの PC のまだ知らない世代で封じてある。先に keybox を読み直す（revokeKnown と同じ）。
  if (await o.roster.refreshKeyboxes()) o.onGained?.();
  o.roster.invalidate();
  const listed = (r: Roster): boolean => r.entries.some((e) => e.id === id && e.kind === 'phone');
  let { roster } = await o.roster.read();
  const rotate = listed(roster);
  if (rotate) {
    // fn は当て直しのたびに呼ばれるので、M[m+1] の候補は外で 1 回だけ作る。
    const fresh = toBase64Url(o.newPhoneKey?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(PHONE_KEY_LEN)));
    const done = await o.roster.update((r) => {
      if (!listed(r)) return r;
      return { ...r, entries: r.entries.filter((e) => !(e.id === id && e.kind === 'phone')), phoneKey: r.phoneKey ? { epoch: r.phoneKey.epoch + 1, key: fresh } : null };
    });
    roster = done.roster;
  }
  if (!rotate && !resumed) {
    o.state.set('phoneRevoke', null);
    return device;
  }
  await deliverPhoneKey(o, roster, id);
  o.state.set('phoneRevoke', null);
  return device;
}

/**
 * (4) 名簿の今の M を、名簿に残るスマホ（解除した id を除く）のうち Worker が解除していないものに置く。
 * PUT /phone-keyboxes は解除されたスマホが 1 つでも混ざると全部を断るので、400 なら一覧を読み直して 1 度だけ置き直す。
 */
async function deliverPhoneKey(o: RotateDeps, roster: Roster, revoked: string): Promise<void> {
  const pk = roster.phoneKey;
  const phones = roster.entries.filter((e) => e.kind === 'phone' && e.id !== revoked);
  if (!pk || phones.length === 0) return;
  const m = fromBase64UrlLen(pk.key, PHONE_KEY_LEN, 'phone key');
  const put = async (): Promise<void> => {
    const devices = await o.client.listDevices();
    const live = phones.filter((e) => devices.some((d) => d.id === e.id && d.kind === 'mobile' && d.revokedAt === null));
    const boxes: KeyboxIn[] = await Promise.all(live.map(async (e) => ({ epoch: pk.epoch, recipient: e.id, sealed: toBase64Url(await sealPhoneKeybox(e.pub, e.id, pk.epoch, m)) })));
    for (let i = 0; i < boxes.length; i += MAX_KEYBOXES_PER_PUT) await o.client.putPhoneKeyboxes(boxes.slice(i, i + MAX_KEYBOXES_PER_PUT));
  };
  try {
    await put();
  } catch (e) {
    if (!(e instanceof CloudError && e.status === 400)) throw e;
    console.warn('[rotate] the Worker refused some phone keybox recipients; placing them again for the phones still connected');
    await put();
  }
}

/**
 * 途中の記録を読む。無いか、読めない形なら null（読めない形は上書きされるまで残す）。
 * 記録の cloudId が今のクラウドと違えば（作り直した後）、記録を消して null を返す。
 */
export function readRotation(state: SyncStateStore, cloudId: string): Rotation | null {
  const raw = state.get('rotation');
  if (raw === null) return null;
  let v: Partial<Rotation> | null = null;
  try {
    v = JSON.parse(raw) as Partial<Rotation> | null;
  } catch {
    // 下で知らせる。
  }
  if (v && typeof v.id === 'string' && v.id !== '' && Number.isSafeInteger(v.newEpoch) && (v.newEpoch as number) >= 2 && STEPS.includes(v.step as RotationStep)) {
    if (v.cloudId !== cloudId) {
      console.warn('[rotate] dropped a rotation record left from another cloud');
      state.set('rotation', null);
      return null;
    }
    const a = v.after as Partial<EpochClaim> | undefined;
    return {
      id: v.id,
      newEpoch: v.newEpoch as number,
      step: v.step as RotationStep,
      cloudId,
      ...(a && Number.isSafeInteger(a.epoch) && typeof a.by === 'string' ? { after: { epoch: a.epoch as number, by: a.by } } : {}),
      ...(Array.isArray(v.sent) && v.sent.every((s) => typeof s === 'string') ? { sent: [...v.sent] } : {}),
      ...(Number.isSafeInteger(v.phoneFrom) ? { phoneFrom: v.phoneFrom as number } : {}),
      ...(typeof v.recoveryPub === 'string' ? { recoveryPub: v.recoveryPub } : {}),
      ...(Array.isArray(v.next) && v.next.length > 0 && v.next.every((s) => typeof s === 'string' && s !== '') ? { next: [...v.next] } : {}),
    };
  }
  console.error('[rotate] the rotation record in sync_state could not be read');
  return null;
}

const save = (state: SyncStateStore, r: Rotation): Rotation => {
  state.set('rotation', JSON.stringify(r));
  return r;
};

const deviceRow = async (o: RotateDeps, id: string): Promise<DeviceOut | null> => (await o.client.listDevices()).find((d) => d.id === id) ?? null;

/**
 * PC を解除して、世代を回す。解除した端末の行を返す（Worker が知らない端末なら null）。
 * 途中の記録が残っていれば、先にそれを終わらせる。同じ PC の記録なら、その続きを行うだけである。
 * すでに解除した PC なら何もしない（世代を空回りさせない）。
 * 失敗は投げ、記録は残す（次の起動か、次の解除で続ける）。
 */
export async function revokePc(o: RevokePcOptions): Promise<DeviceOut | null> {
  return revokeKnown(o, undefined);
}

async function revokeKnown(o: RevokePcOptions, known: DeviceOut | undefined): Promise<DeviceOut | null> {
  if (o.id === o.deviceId) throw new RevokeSelfError();
  const pending = readRotation(o.state, o.cfg.read().cloudId);
  if (pending) {
    let device: DeviceOut | null;
    let queued = pending.id === o.id || (pending.next?.includes(o.id) ?? false);
    try {
      device = await run(o, pending);
    } catch (e) {
      if (pending.id === o.id || !(e instanceof ClaimNotArrivedError)) throw e;
      device = await revokeWhileWaiting(o, pending);
      queued = true;
    }
    if (queued) return device?.id === o.id ? device : await deviceRow(o, o.id);
  }
  const target = known && !pending ? known : await deviceRow(o, o.id);
  if (target && target.revokedAt !== null) return target;
  const ring = await o.keyring;
  // 他の PC が先に回した世代があれば、その次の番号にする。
  if (await o.roster.refreshKeyboxes()) o.onGained?.();
  const newEpoch = Math.max(...ring.epochs()) + 1;
  const device = await run(o, save(o.state, { id: o.id, newEpoch, step: 'revoke', cloudId: o.cfg.read().cloudId }));
  return device?.id === o.id ? device : await deviceRow(o, o.id);
}

/**
 * 途中の回しが、越えた世代の鍵を待って止まっているときの解除。
 * 待っている相手（世代を確保した PC）を利用者が解除しようとしているなら、記録の (5) の前で止まったままでは解除に着けない。
 * そこで、その PC を記録の next に積み、(2) の端末トークンの無効化だけを先に行ってから、途中の回しを試し直す。
 * 確保した PC が解除済みになれば、待ちは配りに進む。続けて、積んだ PC の回しを行う。
 * 別の PC の解除でも同じ順で行う。待ちがまだ解けなければ投げるが、積んだ解除は記録の続きで行う。
 */
async function revokeWhileWaiting(o: RevokePcOptions, pending: Rotation): Promise<DeviceOut | null> {
  const cloudId = o.cfg.read().cloudId;
  const cur = readRotation(o.state, cloudId) ?? pending;
  const next = cur.next ?? [];
  // 端末トークンより先に記録へ積む。無効にした後で落ちても、回しを忘れない。
  save(o.state, { ...cur, next: next.includes(o.id) ? next : [...next, o.id] });
  try {
    await o.client.revokeDevice(o.id);
  } catch (e) {
    if (!(e instanceof CloudError && e.status === 404)) throw e;
  }
  console.warn('[rotate] revoked a computer while waiting for an epoch key; retrying the rotation in progress');
  return run(o, readRotation(o.state, cloudId) ?? cur);
}

/** 起動のときに、途中の記録（PC の回しとスマホの解除）があれば続きから終わらせる。終わらせたら true、記録が無ければ false。 */
export async function resumeRotation(o: RotateDeps): Promise<boolean> {
  const cloudId = o.cfg.read().cloudId;
  const pending = readRotation(o.state, cloudId);
  if (pending) await run(o, pending);
  const phone = readPhoneRevoke(o.state, cloudId);
  if (phone) await runPhone(o, phone.id, true);
  return pending !== null || phone !== null;
}

/** 途中の記録（PC の回しかスマホの解除）が残っているか。 */
export function rotationPending(state: SyncStateStore, cloudId: string): boolean {
  return readRotation(state, cloudId) !== null || readPhoneRevoke(state, cloudId) !== null;
}

/** 回しの続きを、間を置いて試し直してよい失敗か。解除済みの自分（RevokedError）では試し直さない。 */
export function retriesRotation(e: unknown): boolean {
  return !(e instanceof RevokedError);
}

/** 試し直しの予約の口。試験は手で回す。 */
export type RotationRetryTimers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

/**
 * 回しの続きの試し直し（boot/sync.ts）。
 * start は起動のときに 1 回だけ続きを試し、失敗したら ROTATION_RETRY_MS 後に試し直す。
 * failed は、動いている間の解除が失敗したときに呼ぶ。記録が残っていれば、同じ間で試し直しを予約する。
 * 解除済みの自分（RevokedError）では予約しない。予約は 1 つだけ持つ。
 */
export function rotationRetrier(o: { resume: () => Promise<boolean>; pending: () => boolean; timers: RotationRetryTimers }): { start(): void; failed(e: unknown): void; stop(): void } {
  let handle: unknown = null;
  let stopped = false;
  const schedule = (e: unknown): void => {
    if (stopped || handle !== null || !retriesRotation(e)) return;
    handle = o.timers.set(attempt, ROTATION_RETRY_MS);
  };
  function attempt(): void {
    handle = null;
    o.resume().catch((e: unknown) => {
      console.error('[rotate] could not finish rotating the epoch key; trying again later', e instanceof Error ? e.message : e);
      schedule(e);
    });
  }
  return {
    start: attempt,
    failed: (e) => {
      if (o.pending()) schedule(e);
    },
    stop: () => {
      stopped = true;
      if (handle !== null) o.timers.clear(handle);
      handle = null;
    },
  };
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
      rec = await claimAndRemove(o, ring, rec);
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
        rec = save(o.state, { id: rec.id, newEpoch: Math.max(...ring.epochs()) + 1, step: 'key', cloudId: rec.cloudId, ...(rec.next ? { next: rec.next } : {}) });
        continue;
      }
      await awaitClaimed(o, ring, rec);
      // 名簿は Worker から読み直す（(4) の後に他の PC が承認で足した PC にも配るため）。
      o.roster.invalidate();
      const { roster } = await o.roster.read();
      const sent = await deliver(o, ring, rec, roster, null);
      rec = save(o.state, { ...rec, step: 'switch', sent, phoneFrom: roster.phoneKey?.epoch ?? 0, recoveryPub: roster.recoveryPub });
    }
    if (rec.step === 'switch') {
      // 他の PC のより新しい世代を受け取っていれば、そちらで書き続ける（その箱には、この世代の鍵も入っている）。
      if (ring.current().epoch < rec.newEpoch) ring.useEpoch(rec.newEpoch);
      o.cfg.write(ring.toConfigPatch());
      // 名簿を新しい世代で封じ直し、同じ書き換えで M を次の世代にする。(4) の名簿は前の世代で封じてあり、解除した PC の手元の鍵で開ける。
      // 版の条件付き更新なので、返る名簿はこの時点の最新である。
      // M は (5) で読んだ世代より先へ 1 度だけ進める。記録に phoneFrom が無ければ（この版より前の記録）、ここで回す。
      // fn は当て直しのたびに呼ばれるので、M の候補は外で 1 回だけ作る。
      const phoneFrom = rec.phoneFrom ?? Number.MAX_SAFE_INTEGER;
      const freshM = toBase64Url(o.newPhoneKey?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(PHONE_KEY_LEN)));
      const latest = await o.roster.update((r) => (r.phoneKey && r.phoneKey.epoch <= phoneFrom ? { ...r, phoneKey: { epoch: r.phoneKey.epoch + 1, key: freshM } } : r));
      // (5) で読んだ後に名簿に足された PC（参加の承認と重なった）にも置く。承認した PC が新しい世代を知らずに箱を置いたことがあるため。
      if (rec.sent === undefined) {
        await deliver(o, ring, rec, latest.roster, null);
      } else {
        const sent = new Set(rec.sent);
        const added = remainingPcs(latest.roster, rec.id).filter((e) => !sent.has(e.id)).map((e) => e.id);
        if (added.length > 0) {
          console.warn(`[rotate] ${added.length} computer(s) joined while rotating; placing the new epoch key for them too`);
          await deliver(o, ring, rec, latest.roster, new Set(added));
        }
      }
      // (5) の後でリカバリーキーが再発行されていれば、(5) の recovery の箱は古い公開鍵宛てである。
      // 再発行した PC がこの世代を知る前に箱を置き終えていると、いちばん新しい recovery の箱が古い公開鍵宛てのまま残る。
      const pub = latest.roster.recoveryPub;
      if (pub !== '' && pub !== rec.recoveryPub) {
        console.warn('[rotate] the recovery key was reissued while rotating; placing the recovery keyboxes again for the new key');
        const boxes = await sealRecoveryBoxes(pub, ring);
        for (let i = 0; i < boxes.length; i += MAX_KEYBOXES_PER_PUT) await o.client.putKeyboxes(boxes.slice(i, i + MAX_KEYBOXES_PER_PUT));
        rec = save(o.state, { ...rec, recoveryPub: pub });
      }
      // 名簿に残るスマホに今の M を置く。落ちても、記録の (6) から続きで置き直す（M は回し直さない）。
      await deliverPhoneKey(o, latest.roster, rec.id);
      const [nextId, ...rest] = rec.next ?? [];
      if (nextId === undefined) {
        o.state.set('rotation', null);
        return device;
      }
      // 積んだ PC の回しを、続けて (2) から行う。番号はこの回しの次にする（他の PC が先に回していれば、その次）。
      if (await o.roster.refreshKeyboxes()) o.onGained?.();
      rec = save(o.state, { id: nextId, newEpoch: Math.max(...ring.epochs()) + 1, step: 'revoke', cloudId: rec.cloudId, ...(rest.length > 0 ? { next: rest } : {}) });
      device = null;
      restarts = 0;
    }
  }
}

const remainingPcs = (roster: Roster, revoked: string): RosterEntry[] => roster.entries.filter((e) => e.kind === 'pc' && e.id !== revoked);

/**
 * (4) 名簿からその PC を外し、同じ書き換えで新しい世代の番号を確保する。
 * 他の PC が自分の番号以上を確保していれば、その次の番号にし、越えた世代を after に残す。
 * 自分が前の試みで確保した番号なら、それを使う（書き換えの後、記録を進める前に落ちた）。
 * 番号が変わったら、(3) の鍵をその番号に付け替える。
 */
async function claimAndRemove(o: RotateDeps, ring: Keyring, rec: Rotation): Promise<Rotation> {
  const id = rec.id;
  const me = o.deviceId;
  let n = rec.newEpoch;
  let after = rec.after;
  await o.roster.update((r) => {
    const c = r.epochClaim;
    if (c && c.epoch >= n) {
      if (c.by !== me) {
        n = c.epoch + 1;
        after = { epoch: c.epoch, by: c.by };
      } else if (c.epoch > n) {
        n = c.epoch;
        after = { epoch: c.epoch - 1, by: '' };
      }
    }
    return { ...r, entries: r.entries.filter((e) => e.id !== id), epochClaim: { epoch: n, by: me } };
  });
  if (n !== rec.newEpoch) {
    if (!ring.at(n)) {
      // (3) の鍵はまだ誰にも配っていない。見つからなければ作り直してよい。
      const key = ring.toConfigPatch().epochs[String(rec.newEpoch)] ?? randomEpochKey();
      if (ring.at(rec.newEpoch)) ring.dropEpoch(rec.newEpoch);
      await ring.addPending(n, key);
      o.cfg.write(ring.toConfigPatch());
    }
    console.warn(`[rotate] another computer claimed epoch ${rec.newEpoch}; this rotation uses epoch ${n}`);
  }
  return { ...rec, newEpoch: n, ...(after ? { after } : {}) };
}

/** (4) で越えた世代の鍵が、待っても来ない（確保した PC がまだ配っていない）。記録は (5) の前に残る。 */
export class ClaimNotArrivedError extends Error {
  constructor(epoch: number) {
    super(`epoch ${epoch} that another computer is rotating to has not arrived yet`);
    this.name = 'ClaimNotArrivedError';
  }
}

/**
 * (4) で越えた世代の鍵を、keybox で受け取るまで待つ。
 * その世代を確保した PC は、その世代の箱をこの PC にも置く。
 * 置かれる前に自分の箱を配ると、受け手のいちばん新しい箱に越えた世代の鍵が入らない。
 * 確保した PC が解除されているか Worker にいなければ、待つのをやめる（もう箱を置けないので）。
 * 解除を見た後にもう一度 keybox を読み直すので、解除の前に置かれた箱は取りこぼさない。
 * 待っても来なければ ClaimNotArrivedError を投げる（記録は残す）。
 */
async function awaitClaimed(o: RotateDeps, ring: Keyring, rec: Rotation): Promise<void> {
  const after = rec.after;
  if (!after || ring.at(after.epoch)) return;
  const sleep = o.sleep ?? realSleep;
  const gone = async (): Promise<boolean> => {
    if (after.by === '') return false;
    const by = await deviceRow(o, after.by);
    return !by || by.revokedAt !== null;
  };
  for (let i = 0; ; i++) {
    const left = await gone();
    if (await o.roster.refreshKeyboxes()) o.onGained?.();
    if (ring.at(after.epoch)) return;
    if (left) {
      console.warn(`[rotate] epoch ${after.epoch} never arrived from a computer that has left; delivering without it`);
      return;
    }
    if (i >= DELIVER_RETRIES) break;
    await sleep(DELIVER_RETRY_MS);
  }
  throw new ClaimNotArrivedError(after.epoch);
}

/**
 * 自分宛てのいちばん新しい keybox に、newEpoch の世代が別の鍵で入っていれば、その一覧を返す。
 * 箱が無い、古い、開けない、同じ鍵（前の試みで自分が置いた）なら null。
 * 番号は名簿で確保するので、ふつうは起きない（確保を入れる前の名簿で回した PC と重なったときの備え）。
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
 * (5) 名簿の残りの PC とリカバリーキーに、世代 1 から newEpoch までの全部を封じた keybox を置く。置いた PC の ID を返す。
 * GET /keyboxes は受け手ごとにいちばん新しい箱 1 つだけを返すので、新しい箱には過去の世代を全部入れる。
 * only を渡せば、その PC だけに置く（リカバリーキーには置かない）。
 *
 * 名簿の PC のうち、Worker が解除済みとするものには置かない。
 * PUT /keyboxes は知らない受け手が 1 つでも混ざると全部を断るので、断られた塊は Worker が今いるとする PC だけで置き直す。
 * Worker にまだいない PC は、承認の途中（端末トークンをまだ受け取っていない）なので捨てない。
 * DELIVER_RETRY_MS おきに DELIVER_RETRIES 回まで試し直し、置けなければ投げる（記録は残し、続きの試し直しが拾う）。
 * 名簿に入ってから JOIN_STALE_MS を過ぎた PC だけは、承認の途中で止まった名残として飛ばす。
 */
async function deliver(o: RotateDeps, ring: Keyring, rec: Rotation, roster: Roster, only: Set<string> | null): Promise<string[]> {
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const epochs = Object.fromEntries(Object.entries(ring.toConfigPatch().epochs).filter(([n]) => Number(n) <= rec.newEpoch));
  const content = encodeEpochList({ epochs });
  const seal = async (recipient: string, pub: string): Promise<KeyboxIn> => ({ epoch: rec.newEpoch, recipient, sealed: toBase64Url(await sealKeybox(pub, { epoch: rec.newEpoch, recipient }, content)) });
  let devices = await o.client.listDevices();
  const revoked = (id: string): boolean => devices.some((d) => d.id === id && d.revokedAt !== null);
  const active = (id: string): boolean => devices.some((d) => d.id === id && d.kind === 'pc' && d.revokedAt === null);
  const wanted = remainingPcs(roster, rec.id).filter((e) => (only ? only.has(e.id) : true) && !revoked(e.id));
  const boxes = await Promise.all(wanted.map((e) => seal(e.id, e.pub)));
  if (!only && roster.recoveryPub !== '') boxes.push(await seal(RECOVERY_RECIPIENT, roster.recoveryPub));
  const sent: string[] = [];
  const put = async (list: KeyboxIn[]): Promise<void> => {
    for (let i = 0; i < list.length; i += MAX_KEYBOXES_PER_PUT) {
      const chunk = list.slice(i, i + MAX_KEYBOXES_PER_PUT);
      await o.client.putKeyboxes(chunk);
      sent.push(...chunk.map((b) => b.recipient).filter((r) => r !== RECOVERY_RECIPIENT));
    }
  };
  let waiting: KeyboxIn[] = [];
  for (let i = 0; i < boxes.length; i += MAX_KEYBOXES_PER_PUT) {
    const chunk = boxes.slice(i, i + MAX_KEYBOXES_PER_PUT);
    try {
      await put(chunk);
    } catch (e) {
      if (!(e instanceof CloudError && e.status === 400)) throw e;
      const kept = chunk.filter((b) => b.recipient === RECOVERY_RECIPIENT || active(b.recipient));
      console.warn(`[rotate] the Worker refused some keybox recipients; placing ${kept.length} of ${chunk.length} now`);
      if (kept.length > 0) await put(kept);
      waiting.push(...chunk.filter((b) => !kept.includes(b)));
    }
  }
  const joinedAt = new Map(wanted.map((e) => [e.id, e.joinedAt]));
  const stale = waiting.filter((b) => now() - (joinedAt.get(b.recipient) ?? 0) > JOIN_STALE_MS);
  if (stale.length > 0) console.warn(`[rotate] skipped ${stale.length} roster entr(ies) left by an approval that did not finish`);
  waiting = waiting.filter((b) => !stale.includes(b));
  for (let i = 0; waiting.length > 0 && i < DELIVER_RETRIES; i++) {
    await sleep(DELIVER_RETRY_MS);
    devices = await o.client.listDevices();
    waiting = waiting.filter((b) => !revoked(b.recipient));
    const ready = waiting.filter((b) => active(b.recipient));
    if (ready.length > 0) await put(ready);
    waiting = waiting.filter((b) => !ready.includes(b));
  }
  if (waiting.length > 0) throw new Error(`${waiting.length} computer(s) on the roster are not ready to receive the epoch key yet`);
  return sent;
}
