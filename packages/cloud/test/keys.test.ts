import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_KEYBOXES_PER_PUT, RECOVERY_RECIPIENT, ROSTER_MARKER_K, type KeyboxesOut, type RosterOut } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { addPcDevice, startCloud, type CloudHarness } from './harness.ts';

const BOOT = 'bootstrap-token-0123456789abcdef';
const SEALED = 'c2VhbGVkLXJvc3Rlci0x';
const SEALED_2 = 'c2VhbGVkLXJvc3Rlci0y';

let cloud: CloudHarness;
let tokA: string;
let tokB: string;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const put = (token: string, path: string, body: unknown) => send(path, { method: 'PUT', headers: auth(token), body: JSON.stringify(body) });
const getRoster = (token: string) => send('/roster', { headers: auth(token) });
const putRoster = (token: string, ifVersion: number, sealed = SEALED, epoch = 1) => put(token, '/roster', { ifVersion, epoch, sealed });
const getBoxes = (token: string, recipient?: string) => send(`/keyboxes${recipient === undefined ? '' : `?recipient=${recipient}`}`, { headers: auth(token) });
const putBoxes = (token: string, boxes: unknown[]) => put(token, '/keyboxes', { boxes });

type MarkerRow = { seq: number; k: string; op: string; device_id: string; epoch: number; sealed: ArrayBuffer | number[] | string };
const markers = async () => (await cloud.env.DB.prepare('select * from rows where k = ?').bind(ROSTER_MARKER_K).all<MarkerRow>()).results;
const sealedLength = (v: MarkerRow['sealed']) => (typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : v.byteLength);

const start = async (bootHash?: string) => {
  resetSchemaCache();
  cloud = await startCloud(bootHash === undefined ? {} : { BOOTSTRAP_TOKEN_HASH: bootHash });
  resetSchemaCache();
  await ensureSchema(cloud.env);
  tokA = await addPcDevice(cloud.env, 'pc-a');
  tokB = await addPcDevice(cloud.env, 'pc-b');
};

afterEach(async () => {
  await cloud.dispose();
});

describe('名簿（GET と PUT /roster）', () => {
  beforeEach(async () => start());

  it('名簿が無ければ GET は 404', async () => {
    expect((await getRoster(tokA)).status).toBe(404);
  });

  it('ifVersion が合えば版が 1 進む', async () => {
    const r1 = await putRoster(tokA, 0);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ version: 1 });
    const g1 = await getRoster(tokB);
    expect(g1.status).toBe(200);
    expect((await g1.json()) as RosterOut).toEqual({ version: 1, sealed: SEALED });
    // 封じた中身は base64url の文字ではなく、バイト列の BLOB で持つ。
    expect(await cloud.env.DB.prepare('select typeof(sealed) t, hex(sealed) h from roster').first()).toEqual({ t: 'blob', h: Buffer.from(SEALED, 'base64url').toString('hex').toUpperCase() });

    const r2 = await putRoster(tokB, 1, SEALED_2);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ version: 2 });
    expect((await (await getRoster(tokA)).json()) as RosterOut).toEqual({ version: 2, sealed: SEALED_2 });
  });

  it('合わなければ 409 で今の版を返し、名簿を書き換えない', async () => {
    // 名簿の無いところへ版 1 を前提に書く。
    const none = await putRoster(tokA, 1);
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ version: 0 });
    expect((await getRoster(tokA)).status).toBe(404);

    expect((await putRoster(tokA, 0)).status).toBe(200);
    // 2 回目の ifVersion: 0 は、もう名簿があるので断る。
    const again = await putRoster(tokB, 0, SEALED_2);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ version: 1 });
    const ahead = await putRoster(tokB, 5, SEALED_2);
    expect(ahead.status).toBe(409);
    expect(await ahead.json()).toEqual({ version: 1 });
    expect((await (await getRoster(tokA)).json()) as RosterOut).toEqual({ version: 1, sealed: SEALED });
  });

  it('同じ版から同時に 2 台が書くと、片方だけが通り、もう片方は 409', async () => {
    expect((await putRoster(tokA, 0)).status).toBe(200);
    const [a, b] = await Promise.all([putRoster(tokA, 1, SEALED), putRoster(tokB, 1, SEALED_2)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect(await lost.json()).toEqual({ version: 2 });
    expect(((await (await getRoster(tokA)).json()) as RosterOut).version).toBe(2);
  });

  it('PUT /roster で ~roster の行の seq が進み、行は 1 つだけ（sealed は空、epoch は本文の値）', async () => {
    expect(await markers()).toEqual([]);
    expect((await putRoster(tokA, 0, SEALED, 1)).status).toBe(200);
    const m1 = await markers();
    expect(m1).toHaveLength(1);
    expect(m1[0]).toMatchObject({ op: 'upsert', device_id: 'pc-a', epoch: 1 });
    expect(sealedLength(m1[0]!.sealed)).toBe(0);

    expect((await putRoster(tokB, 1, SEALED_2, 2)).status).toBe(200);
    const m2 = await markers();
    expect(m2).toHaveLength(1);
    expect(m2[0]!.seq).toBeGreaterThan(m1[0]!.seq);
    expect(m2[0]).toMatchObject({ device_id: 'pc-b', epoch: 2 });

    // 409 で断った書き込みでは、印の行は動かない。
    expect((await putRoster(tokA, 1)).status).toBe(409);
    expect((await markers())[0]!.seq).toBe(m2[0]!.seq);
  });

  it('形の違う本文は 400 で、名簿も印の行も作らない', async () => {
    for (const body of [
      { ifVersion: -1, epoch: 1, sealed: SEALED },
      { ifVersion: 1.5, epoch: 1, sealed: SEALED },
      { ifVersion: 0, sealed: SEALED },
      { ifVersion: 0, epoch: 0, sealed: SEALED },
      { ifVersion: 0, epoch: 1, sealed: '' },
      { ifVersion: 0, epoch: 1, sealed: 'not base64url!' },
      { ifVersion: 0, epoch: 1, sealed: 'a'.repeat(70_000) },
    ]) {
      expect((await put(tokA, '/roster', body)).status).toBe(400);
    }
    expect((await getRoster(tokA)).status).toBe(404);
    expect(await markers()).toEqual([]);
  });
});

describe('keybox（GET と PUT /keyboxes）', () => {
  beforeEach(async () => start());

  const box = (recipient: string, epoch = 1, sealed = Buffer.from(`box-for-${recipient}`).toString('base64url')) => ({ epoch, recipient, sealed });

  it('自分宛ての keybox を読める（recipient を省くと自分宛て）', async () => {
    const w = await putBoxes(tokA, [box('pc-a'), box('pc-b'), box(RECOVERY_RECIPIENT)]);
    expect(w.status).toBe(200);
    const mine = await getBoxes(tokB, 'pc-b');
    expect(mine.status).toBe(200);
    expect((await mine.json()) as KeyboxesOut).toEqual({ boxes: [{ epoch: 1, sealed: box('pc-b').sealed }] });
    expect((await (await getBoxes(tokA)).json()) as KeyboxesOut).toEqual({ boxes: [{ epoch: 1, sealed: box('pc-a').sealed }] });
  });

  it('他人宛ての keybox は読めない', async () => {
    expect((await putBoxes(tokA, [box('pc-a'), box('pc-b')])).status).toBe(200);
    expect((await getBoxes(tokB, 'pc-a')).status).toBe(403);
    expect((await getBoxes(tokA, 'pc-b')).status).toBe(403);
  });

  it('世代と受け手の組で上書きし、いちばん新しい世代の 1 つだけを返す', async () => {
    expect((await putBoxes(tokA, [box('pc-b', 2, 'c2Vjb25k'), box('pc-b', 1, 'Zmlyc3Q')])).status).toBe(200);
    expect((await putBoxes(tokB, [box('pc-b', 1, 'Zmlyc3QtYWdhaW4')])).status).toBe(200);
    // 中身は世代 1 から n までの鍵の一覧なので、古い世代の箱は返さない。
    expect((await (await getBoxes(tokB)).json()) as KeyboxesOut).toEqual({ boxes: [{ epoch: 2, sealed: 'c2Vjb25k' }] });
    const stored = await cloud.env.DB.prepare('select epoch, typeof(sealed) t, hex(sealed) h from keyboxes order by epoch').all<{ epoch: number; t: string; h: string }>();
    // 封じた中身はバイト列の BLOB で持ち、世代 1 は後の書き込みで上書きされている。
    expect(stored.results).toEqual([
      { epoch: 1, t: 'blob', h: Buffer.from('Zmlyc3QtYWdhaW4', 'base64url').toString('hex').toUpperCase() },
      { epoch: 2, t: 'blob', h: Buffer.from('c2Vjb25k', 'base64url').toString('hex').toUpperCase() },
    ]);
  });

  it('自分宛ての keybox が無ければ空の配列', async () => {
    expect((await (await getBoxes(tokB)).json()) as KeyboxesOut).toEqual({ boxes: [] });
  });

  it('受け手は解除されていない PC か recovery だけで、上限は 20 件', async () => {
    await cloud.env.DB.prepare("insert into devices (id, kind, token_hash, joined_at) values ('phone-1', 'mobile', 'h-phone', 1)").run();
    await cloud.env.DB.prepare("update devices set revoked_at = 1 where id = 'pc-b'").run();
    for (const boxes of [
      [box('pc-z')],
      [box('pc-b')],
      [box('phone-1')],
      [box('pc-a'), box('pc-z')],
      [],
      [{ epoch: 0, recipient: 'pc-a', sealed: 'eA' }],
      [{ epoch: 1, recipient: 'pc-a', sealed: '' }],
      [{ epoch: 1, recipient: 'pc-a', sealed: 'not base64url!' }],
      [{ epoch: 1, recipient: '../pc-a', sealed: 'eA' }],
      Array.from({ length: MAX_KEYBOXES_PER_PUT + 1 }, (_, i) => box('pc-a', i + 1)),
    ]) {
      expect((await putBoxes(tokA, boxes)).status).toBe(400);
    }
    expect((await put(tokA, '/keyboxes', { nope: true })).status).toBe(400);
    const n = await cloud.env.DB.prepare('select count(*) n from keyboxes').first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect((await putBoxes(tokA, Array.from({ length: MAX_KEYBOXES_PER_PUT }, (_, i) => box('pc-a', i + 1)))).status).toBe(200);
  });
});

describe('認証と種類', () => {
  beforeEach(async () => start());

  it('解除された端末は 401', async () => {
    expect((await putRoster(tokA, 0)).status).toBe(200);
    expect((await send('/devices/pc-b/revoke', { method: 'POST', headers: auth(tokA) })).status).toBe(200);
    for (const res of [await getRoster(tokB), await putRoster(tokB, 1), await getBoxes(tokB), await putBoxes(tokB, [{ epoch: 1, recipient: 'pc-a', sealed: 'eA' }])]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'revoked' });
    }
  });

  it('トークンが無ければ 401、スマホのトークンは 403', async () => {
    expect((await send('/roster')).status).toBe(401);
    expect((await send('/keyboxes')).status).toBe(401);
    const phone = 'phone-token-0123456789abcdef';
    await cloud.env.DB.prepare("insert into devices (id, kind, token_hash, joined_at) values ('phone-1', 'mobile', ?, 1)").bind(await sha256Hex(phone)).run();
    expect((await getRoster(phone)).status).toBe(403);
    expect((await getBoxes(phone)).status).toBe(403);
  });
});

describe('recovery 宛ての keybox は bootstrap の直後の端末だけが読める', () => {
  beforeEach(async () => start(await sha256Hex(BOOT)));

  const bootstrap = (deviceId: string) => send('/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, token: BOOT }) });
  const recoveryBox = { epoch: 1, recipient: RECOVERY_RECIPIENT, sealed: 'cmVjb3Zlcnk' };

  it('bootstrap した端末は、名簿か keybox を書くまで recovery 宛てを読める', async () => {
    expect((await putBoxes(tokA, [recoveryBox])).status).toBe(200);
    // ふつうの PC は recovery を名乗れない。
    expect((await getBoxes(tokA, RECOVERY_RECIPIENT)).status).toBe(403);
    expect((await bootstrap('pc-new')).status).toBe(201);
    const r = await getBoxes(BOOT, RECOVERY_RECIPIENT);
    expect(r.status).toBe(200);
    expect((await r.json()) as KeyboxesOut).toEqual({ boxes: [{ epoch: 1, sealed: recoveryBox.sealed }] });
    // 読むだけなら何度でも読める。
    expect((await getBoxes(BOOT, RECOVERY_RECIPIENT)).status).toBe(200);
    expect((await putRoster(BOOT, 0)).status).toBe(200);
    expect((await getBoxes(BOOT, RECOVERY_RECIPIENT)).status).toBe(403);
  });

  it('keybox を書いた後も読めない', async () => {
    expect((await putBoxes(tokA, [recoveryBox])).status).toBe(200);
    expect((await bootstrap('pc-new')).status).toBe(201);
    expect((await putBoxes(BOOT, [{ epoch: 1, recipient: 'pc-new', sealed: 'bmV3' }])).status).toBe(200);
    expect((await getBoxes(BOOT, RECOVERY_RECIPIENT)).status).toBe(403);
  });

  it('409 で断られた名簿の書き込みでは閉じない', async () => {
    expect((await putRoster(tokA, 0)).status).toBe(200);
    expect((await bootstrap('pc-new')).status).toBe(201);
    expect((await putRoster(BOOT, 0)).status).toBe(409);
    expect((await getBoxes(BOOT, RECOVERY_RECIPIENT)).status).toBe(200);
  });

  it('入れ直した bootstrap のトークンで通った端末は、また読める', async () => {
    expect((await bootstrap('pc-new')).status).toBe(201);
    expect((await putRoster(BOOT, 0)).status).toBe(200);
    expect((await getBoxes(BOOT, RECOVERY_RECIPIENT)).status).toBe(403);
    // hangar recover が secret を入れ替えて、別のトークンで bootstrap を通った後の状態を作る。
    const tokC = await addPcDevice(cloud.env, 'pc-c');
    await cloud.env.DB.prepare("update meta set value = ? where key = 'bootstrap_used'").bind(await sha256Hex(tokC)).run();
    expect((await getBoxes(tokC, RECOVERY_RECIPIENT)).status).toBe(200);
  });
});
