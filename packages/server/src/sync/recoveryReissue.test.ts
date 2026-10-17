import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeEpochList,
  encodeEpochList,
  fromBase64Url,
  generateKeyPair,
  importPrivate,
  openKeybox,
  parseRecoveryKey,
  RECOVERY_RECIPIENT,
  recoverySecretTail,
  sealKeybox,
  toBase64Url,
  type KeyPairRaw,
} from '@agent-hangar/shared';
import { FakeWorker } from '../../../cli/test/fakeWorker.ts';
import type { CloudConfig } from '../config/cloud.ts';
import { HttpCloudClient } from './client.ts';
import { Keyring } from './keyring.ts';
import { RECOVERY_BOX_PUT_TRIES, RECOVERY_TAIL_MAX_MISSES, RecoveryDraftError, RecoveryKeyReissuer } from './recoveryReissue.ts';
import { normalizeRecoveryTail } from './recoveryTail.ts';
import { RosterStore, type ConfigWriter } from './roster.ts';
import type { SyncStateStore } from './state.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const URL_ = 'https://hangar.example.workers.dev';
const TOKEN_A = 'token-of-pc-a-0123456789abcdef0123456789';

type Hook = (method: string, path: string, body: Record<string, unknown> | null) => Promise<Response | null>;

/** sync_state の代わり。 */
function memState(): Pick<SyncStateStore, 'get' | 'set'> & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: (k) => m.get(k) ?? null,
    set: (k, v) => {
      if (v === null) m.delete(k);
      else m.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    },
  };
}

/** 世代 1 と 2 があり、pc-a が参加しているクラウド。recovery 宛ての keybox は世代ごとに古い公開鍵で置いてある。 */
async function cloud() {
  const worker = new FakeWorker();
  worker.devices.set('pc-a', { tokenHash: sha(TOKEN_A), revoked: false });
  const pairA = await generateKeyPair();
  const recovery = await generateKeyPair();
  const epochs: Record<string, string> = { '1': Buffer.alloc(32, 1).toString('base64url'), '2': Buffer.alloc(32, 2).toString('base64url') };
  let cfg: CloudConfig = {
    v: 2, url: URL_, cloudId: worker.cloudId, deviceToken: TOKEN_A, keyPair: pairA, epochs, currentEpoch: 2, phoneKey: null, rosterVersion: 0,
    workerName: 'hangar', accountId: '0123456789abcdef0123456789abcdef', dbName: 'hangar', bucketName: 'hangar-files', joinedAt: 1,
  };
  const writer: ConfigWriter = { read: () => cfg, write: (p) => { cfg = { ...cfg, ...p }; } };
  let hook: Hook | null = null;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const r = hook ? await hook((init?.method ?? 'GET').toUpperCase(), u.pathname, body) : null;
    return r ?? worker.fetch(input, init);
  }) as typeof fetch;
  const wire = new HttpCloudClient({ url: URL_, token: TOKEN_A, fetch: fetchFn });
  const keyring = await Keyring.fromConfig(cfg);
  const roster = new RosterStore(wire, keyring, writer, 'pc-a');
  await roster.update(() => ({ v: 1, entries: [{ id: 'pc-a', kind: 'pc', name: 'pc-a', os: 'darwin', pub: pairA.pub, joinedAt: 1 }], recoveryPub: recovery.pub, phoneKey: null }));
  for (const [epoch, list] of [[1, { '1': epochs['1']! }], [2, epochs]] as const) {
    worker.putBox({ epoch, recipient: RECOVERY_RECIPIENT, sealed: toBase64Url(await sealKeybox(recovery.pub, { epoch, recipient: RECOVERY_RECIPIENT }, encodeEpochList({ epochs: list }))) });
  }
  const state = memState();
  const clock = { t: 1_000_000 };
  const reissuer = new RecoveryKeyReissuer({ roster, keyring, wire, url: () => URL_, state, now: () => clock.t, sleep: async () => {} });
  return { worker, pairA, recovery, epochs, roster, keyring, wire, writer, state, clock, reissuer, setHook: (h: Hook | null) => { hook = h; } };
}

/** recovery 宛ての世代 epoch の箱を、その秘密鍵で開く。開けなければ null。 */
async function openRecoveryBox(worker: FakeWorker, pair: KeyPairRaw, epoch: number): Promise<Record<string, string> | null> {
  const box = worker.keyboxes.get(`${RECOVERY_RECIPIENT}:${epoch}`);
  if (!box) return null;
  try {
    return decodeEpochList(await openKeybox(await importPrivate(pair.priv), pair.pub, { epoch, recipient: RECOVERY_RECIPIENT }, fromBase64Url(box.sealed)!)).epochs;
  } catch {
    return null;
  }
}

/** 下書きの 4 行から鍵ペアを取り出す（公開鍵は名簿の recoveryPub で照合する）。 */
const draftPair = (text: string, pub: string): KeyPairRaw => ({ priv: parseRecoveryKey(text).priv, pub });

const wrongTail = (text: string): string => (recoverySecretTail(text) === 'ZZZZ' ? 'YYYY' : 'ZZZZ');

describe('normalizeRecoveryTail（末尾 4 文字の正規化。CLI とサーバーで同じ）', () => {
  it('全角、空白、ハイフン、小文字を同じ形にする', () => {
    expect(normalizeRecoveryTail(' ａｂ-c d ')).toBe('ABCD');
    expect(normalizeRecoveryTail('AB－CD')).toBe('ABCD');
  });
});

describe('RecoveryKeyReissuer.confirm', () => {
  it('末尾 4 文字は空白とハイフンと全角を許す', async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    const tail = recoverySecretTail(d.text);
    await c.reissuer.confirm(d.draftId, ` ${tail.slice(0, 2).toLowerCase()}-${tail.slice(2)} `);
    expect((await c.roster.read()).roster.recoveryPub).not.toBe(c.recovery.pub);
  });

  it(`同じ下書きで ${RECOVERY_TAIL_MAX_MISSES} 回外れたら下書きを無効にする`, async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    for (let i = 1; i < RECOVERY_TAIL_MAX_MISSES; i++) await expect(c.reissuer.confirm(d.draftId, wrongTail(d.text))).rejects.toMatchObject({ reason: 'tail-mismatch' });
    await expect(c.reissuer.confirm(d.draftId, wrongTail(d.text))).rejects.toMatchObject({ reason: 'too-many-tries' });
    await expect(c.reissuer.confirm(d.draftId, recoverySecretTail(d.text))).rejects.toMatchObject({ reason: 'no-draft' });
    expect((await c.roster.read()).roster.recoveryPub).toBe(c.recovery.pub);
  });

  it('同時に 2 回呼ばれても、進行中の確認を共有して 1 回だけ書く', async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    const before = c.worker.calls.filter((x) => x === 'PUT /roster').length;
    const tail = recoverySecretTail(d.text);
    const a = c.reissuer.confirm(d.draftId, tail);
    const b = c.reissuer.confirm(d.draftId, tail);
    expect(b).toBe(a);
    await Promise.all([a, b]);
    expect(c.worker.calls.filter((x) => x === 'PUT /roster').length - before).toBe(1);
  });

  it('全部の世代の recovery の箱を新しい公開鍵宛てに置き直す（中身はその世代までの世代鍵）', async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    await c.reissuer.confirm(d.draftId, recoverySecretTail(d.text));
    const pub = (await c.roster.read()).roster.recoveryPub;
    const fresh = draftPair(d.text, pub);
    expect(await openRecoveryBox(c.worker, fresh, 1)).toEqual({ '1': c.epochs['1'] });
    expect(await openRecoveryBox(c.worker, fresh, 2)).toEqual(c.epochs);
    // 古いリカバリーキーでは、どの世代の箱も開けない。
    expect(await openRecoveryBox(c.worker, c.recovery, 1)).toBeNull();
    expect(await openRecoveryBox(c.worker, c.recovery, 2)).toBeNull();
    expect(c.state.m.size).toBe(0);
  });

  it('名簿を書いた後に他の PC が世代を回しても、箱を置く直前に読み直して最新の世代まで置く', async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    const e3 = Buffer.alloc(32, 3).toString('base64url');
    const all = { ...c.epochs, '3': e3 };
    c.setHook(async (method, p) => {
      if (method === 'PUT' && p === '/roster') {
        // 確認が名簿を書く間に、他の PC が世代 3 を作り、pc-a 宛ての箱を置いた。
        c.worker.putBox({ epoch: 3, recipient: 'pc-a', sealed: toBase64Url(await sealKeybox(c.pairA.pub, { epoch: 3, recipient: 'pc-a' }, encodeEpochList({ epochs: all }))) });
        c.setHook(null);
      }
      return null;
    });
    await c.reissuer.confirm(d.draftId, recoverySecretTail(d.text));
    const fresh = draftPair(d.text, (await c.roster.read()).roster.recoveryPub);
    expect(await openRecoveryBox(c.worker, fresh, 3)).toEqual(all);
  });

  it(`箱の PUT が失敗したら ${RECOVERY_BOX_PUT_TRIES} 回まで試し、通れば印を残さない`, async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    let fails = RECOVERY_BOX_PUT_TRIES - 1;
    c.setHook(async (method, p) => (method === 'PUT' && p === '/keyboxes' && fails-- > 0 ? new Response('{"error":"boom"}', { status: 500 }) : null));
    await c.reissuer.confirm(d.draftId, recoverySecretTail(d.text));
    expect(await openRecoveryBox(c.worker, draftPair(d.text, (await c.roster.read()).roster.recoveryPub), 2)).toEqual(c.epochs);
    expect(c.state.m.size).toBe(0);
  });

  it('箱の PUT が失敗し続けたら印を残し、次の巡で名簿の公開鍵宛てに置き直して印を消す', async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    let tries = 0;
    c.setHook(async (method, p) => (method === 'PUT' && p === '/keyboxes' ? (tries++, new Response('{"error":"boom"}', { status: 500 })) : null));
    await expect(c.reissuer.confirm(d.draftId, recoverySecretTail(d.text))).rejects.toThrow();
    expect(tries).toBe(RECOVERY_BOX_PUT_TRIES);
    expect(c.state.get('recoveryBoxPending')).toBe('1');
    const pub = (await c.roster.read()).roster.recoveryPub;
    expect(pub).not.toBe(c.recovery.pub);
    expect(await openRecoveryBox(c.worker, draftPair(d.text, pub), 2)).toBeNull();

    // 次の巡。下書きが無くても（アプリを再起動した後でも）、名簿の公開鍵だけで置き直せる。
    c.setHook(null);
    const again = new RecoveryKeyReissuer({ roster: c.roster, keyring: c.keyring, wire: c.wire, url: () => URL_, state: c.state, sleep: async () => {} });
    await again.resumePending();
    expect(await openRecoveryBox(c.worker, draftPair(d.text, pub), 1)).toEqual({ '1': c.epochs['1'] });
    expect(await openRecoveryBox(c.worker, draftPair(d.text, pub), 2)).toEqual(c.epochs);
    expect(c.state.get('recoveryBoxPending')).toBeNull();
  });

  it('4xx は試し直さず、続く間は巡の度に打たずに 60 秒に 1 回だけ置き直す', async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    let puts = 0;
    c.setHook(async (method, p) => (method === 'PUT' && p === '/keyboxes' ? (puts++, new Response('{"error":"bad request"}', { status: 400 })) : null));
    await expect(c.reissuer.confirm(d.draftId, recoverySecretTail(d.text))).rejects.toThrow();
    expect(puts).toBe(1);
    expect(c.state.get('recoveryBoxPending')).toBe('1');
    // pull は 10 秒ごとに来る。60 秒たつまでは打たない。
    for (let i = 0; i < 5; i++) {
      c.clock.t += 10_000;
      await c.reissuer.resumePending();
    }
    expect(puts).toBe(1);
    c.clock.t += 10_000;
    await c.reissuer.resumePending();
    expect(puts).toBe(2);
    await c.reissuer.resumePending();
    expect(puts).toBe(2);
    expect(c.state.get('recoveryBoxPending')).toBe('1');
    // 通るようになれば、次の 60 秒の後に置いて印を消す。
    c.setHook(null);
    c.clock.t += 60_000;
    await c.reissuer.resumePending();
    expect(await openRecoveryBox(c.worker, draftPair(d.text, (await c.roster.read()).roster.recoveryPub), 2)).toEqual(c.epochs);
    expect(c.state.get('recoveryBoxPending')).toBeNull();
  });

  it('名簿の PUT が失敗したら印だけ残り、置き直しは名簿の今の公開鍵（古いキー）宛てになる', async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    c.setHook(async (method, p) => (method === 'PUT' && p === '/roster' ? new Response('{"error":"boom"}', { status: 500 }) : null));
    await expect(c.reissuer.confirm(d.draftId, recoverySecretTail(d.text))).rejects.toThrow();
    expect(c.state.get('recoveryBoxPending')).toBe('1');
    c.roster.invalidate();
    expect((await c.roster.read()).roster.recoveryPub).toBe(c.recovery.pub);

    c.setHook(null);
    const before = c.worker.calls.filter((x) => x === 'PUT /keyboxes').length;
    c.clock.t += 60_000;
    await c.reissuer.resumePending();
    expect(c.worker.calls.filter((x) => x === 'PUT /keyboxes').length - before).toBeGreaterThan(0);
    expect(await openRecoveryBox(c.worker, c.recovery, 1)).toEqual({ '1': c.epochs['1'] });
    expect(await openRecoveryBox(c.worker, c.recovery, 2)).toEqual(c.epochs);
    expect(await openRecoveryBox(c.worker, draftPair(d.text, c.recovery.pub), 2)).toBeNull();
    expect(c.state.get('recoveryBoxPending')).toBeNull();
  });

  it('進行中の確認に同じ下書きで来た 2 回目も末尾を照合し、外れは回数に数えない', async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    c.setHook(async (method, p) => {
      if (method === 'PUT' && p === '/roster') await gate;
      return null;
    });
    const a = c.reissuer.confirm(d.draftId, recoverySecretTail(d.text));
    for (let i = 0; i < RECOVERY_TAIL_MAX_MISSES; i++) {
      await expect(c.reissuer.confirm(d.draftId, wrongTail(d.text))).rejects.toMatchObject({ reason: 'tail-mismatch' });
    }
    open();
    await a;
    expect((await c.roster.read()).roster.recoveryPub).not.toBe(c.recovery.pub);
  });

  it('印が無ければ、巡の度には Worker に何も送らない', async () => {
    const c = await cloud();
    const before = c.worker.calls.length;
    await c.reissuer.resumePending();
    expect(c.worker.calls.length).toBe(before);
  });

  it('箱を置く間に他の PC が再発行したら、置いた後の名簿の公開鍵宛てに置き直す', async () => {
    const c = await cloud();
    const d = await c.reissuer.reissue();
    const other = await generateKeyPair();
    let once = true;
    c.setHook(async (method, p) => {
      if (method === 'PUT' && p === '/keyboxes' && once) {
        once = false;
        // 他の PC の再発行。名簿の recoveryPub を別の公開鍵にした（その PC の箱の PUT はまだ）。
        let cfg2 = { ...(c.writer.read()) };
        const w2: ConfigWriter = { read: () => cfg2, write: (x) => { cfg2 = { ...cfg2, ...x }; } };
        const other2 = new RosterStore(new HttpCloudClient({ url: URL_, token: TOKEN_A, fetch: c.worker.fetch }), await Keyring.fromConfig(cfg2), w2, 'pc-a');
        await other2.update((r) => ({ ...r, recoveryPub: other.pub }));
      }
      return null;
    });
    await c.reissuer.confirm(d.draftId, recoverySecretTail(d.text));
    expect(await openRecoveryBox(c.worker, other, 2)).toEqual(c.epochs);
  });

  it('下書きが無いときと期限切れは no-draft', async () => {
    const c = await cloud();
    await expect(c.reissuer.confirm('nope', 'AAAA')).rejects.toBeInstanceOf(RecoveryDraftError);
  });
});
