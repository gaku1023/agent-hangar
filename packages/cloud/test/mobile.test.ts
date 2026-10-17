import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aadFeed,
  deriveMobileKey,
  MOBILE_FEED_MAX_BYTES,
  PHONE_IDLE_MS,
  PHONE_MAX_AGE_MS,
  readCloudLimit,
  seal,
  type DevicesOut,
  type KeyboxOut,
  type MobileInboxResponse,
  type MobileJoinResponse,
  type MobilePairingResponse,
  type MobilePairingsMine,
  type SealedPullChangesResponse,
} from '@agent-hangar/shared';
import { MAX_ACTIVE_PHONES, MAX_FEED_BODY_BYTES, PAIRING_RATE, PAIRING_TTL_MS } from '../src/mobile.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { blobToSealed, sha256Hex } from '../src/util.ts';
import { addPcDevice, joinPhoneDevice, PHONE_REQUEST_SEALED, startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-mobile';
const DAY = 86_400_000;

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const putJson = (token: string, path: string, body: unknown) => send(path, { method: 'PUT', headers: auth(token, { 'content-type': 'application/json' }), body: JSON.stringify(body) });
const b64 = (s: string) => Buffer.from(s).toString('base64url');

/** PC の行を D1 へ直に置く（互換の版 9 で POST /join を消した）。 */
const joinPc = (id: string): Promise<string> => addPcDevice(cloud.env, id);

const takePairing = (token: string) => send('/m/pairings', { method: 'POST', headers: auth(token) });

const pairCode = async (token: string): Promise<string> => {
  const r = await takePairing(token);
  expect(r.status).toBe(201);
  return ((await r.json()) as MobilePairingResponse).code;
};

let seq = 0;
/** スマホの参加の本文（互換の版 9）。ID はスマホが名乗り、名前と公開鍵は封じた sealed の中にある。 */
const phoneJoin = (code: unknown, o: { deviceId?: unknown; sealed?: unknown } = {}) => send('/m/join', json({ code, deviceId: o.deviceId ?? `phone-${++seq}`, sealed: o.sealed ?? PHONE_REQUEST_SEALED }));

const joinPhone = (pcToken: string, o: { deviceId?: string; sealed?: string } = {}): Promise<MobileJoinResponse> => joinPhoneDevice(cloud, pcToken, o);

const putFeed = (token: string, sealed: string, epoch: unknown = 1) =>
  send('/m/feed', { method: 'PUT', headers: auth(token, { 'content-type': 'application/json' }), body: JSON.stringify({ sealed, epoch }) });

const putPhoneBoxes = (token: string, boxes: unknown[]) => putJson(token, '/phone-keyboxes', { boxes });
const getPhoneBox = (token: string) => send('/m/keybox', { headers: auth(token) });
const pairingsMine = (token: string) => send('/m/pairings/mine', { headers: auth(token) });

const inbox = (token: string) => send('/m/inbox', { headers: auth(token) });

const revoke = (token: string, id: string) => send(`/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: auth(token) });

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
});

afterEach(async () => {
  await cloud.dispose();
});

describe('スマホの参加（POST /m/pairings と POST /m/join）', () => {
  it('PC が取った券でスマホが参加でき、kind=mobile のトークンを受け取る', async () => {
    const pc = await joinPc('pc-a');
    const before = Date.now();
    const r = await takePairing(pc);
    expect(r.status).toBe(201);
    const pairing = (await r.json()) as MobilePairingResponse;
    expect(pairing.code).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(pairing.expiresAt).toBeGreaterThanOrEqual(before + PAIRING_TTL_MS);
    expect(pairing.expiresAt).toBeLessThanOrEqual(Date.now() + PAIRING_TTL_MS);
    // D1 には券のハッシュだけを置く。
    const stored = await cloud.env.DB.prepare('select code_hash, created_by, used_at from mobile_pairings').all<{ code_hash: string; created_by: string; used_at: number | null }>();
    expect(stored.results).toEqual([{ code_hash: await sha256Hex(pairing.code), created_by: 'pc-a', used_at: null }]);

    const j = await phoneJoin(pairing.code, { deviceId: 'phone-x', sealed: PHONE_REQUEST_SEALED });
    expect(j.status).toBe(201);
    const body = (await j.json()) as MobileJoinResponse;
    expect(Object.keys(body).sort()).toEqual(['deviceId', 'token']);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // スマホが名乗った ID で入る（互換の版 9）。PC は名乗った ID 宛てに keybox を封じる。
    expect(body.deviceId).toBe('phone-x');
    const row = await cloud.env.DB.prepare('select kind, token_hash, revoked_at, joined_at, last_seen_at, expires_at from devices where id = ?').bind(body.deviceId).first<{
      kind: string;
      token_hash: string;
      revoked_at: number | null;
      joined_at: number;
      last_seen_at: number;
      expires_at: number;
    }>();
    expect(row).toMatchObject({ kind: 'mobile', token_hash: await sha256Hex(body.token), revoked_at: null });
    // 接続から 90 日で再接続が要る。期限は Worker の時計で決める。
    expect(row!.joined_at).toBeGreaterThanOrEqual(before);
    expect(row!.last_seen_at).toBe(row!.joined_at);
    expect(row!.expires_at).toBe(row!.joined_at + PHONE_MAX_AGE_MS);
    // 封じた参加リクエスト（公開鍵と名前）は券の行に BLOB で残し、Worker は開けない。名前は devices に置かない。
    const pairRow = await cloud.env.DB.prepare('select used_at, device_id, request, typeof(request) t from mobile_pairings').first<{ used_at: number; device_id: string; request: unknown; t: string }>();
    expect(pairRow).toMatchObject({ device_id: 'phone-x', t: 'blob' });
    expect(pairRow!.used_at).not.toBeNull();
    expect(blobToSealed(pairRow!.request)).toBe(PHONE_REQUEST_SEALED);
    const pcRow = await cloud.env.DB.prepare('select kind from devices where id = ?').bind('pc-a').first<{ kind: string }>();
    expect(pcRow?.kind).toBe('pc');
    // スマホのトークンで受信箱を読める。
    expect((await inbox(body.token)).status).toBe(200);
  });

  it('名乗った ID の行が既にあれば 409 で断り、既存の行は変えず、券も使わずに残す', async () => {
    const pc = await joinPc('pc-a');
    const old = await joinPhone(pc, { deviceId: 'phone-old' });
    expect((await send(`/devices/${old.deviceId}/revoke`, { method: 'POST', headers: auth(pc) })).status).toBe(200);
    const code = await pairCode(pc);
    for (const deviceId of ['pc-a', 'phone-old']) {
      const r = await phoneJoin(code, { deviceId });
      expect(r.status, deviceId).toBe(409);
      expect(await r.json()).toEqual({ error: 'device-exists' });
    }
    expect((await cloud.env.DB.prepare('select kind, token_hash from devices where id = ?').bind('pc-a').first())).toEqual({ kind: 'pc', token_hash: await sha256Hex(pc) });
    // 解除した行は解除のまま。PC のトークンも生きている。
    expect((await cloud.env.DB.prepare('select revoked_at from devices where id = ?').bind('phone-old').first<{ revoked_at: number | null }>())?.revoked_at).not.toBeNull();
    expect((await send('/devices', { headers: auth(pc) })).status).toBe(200);
    expect((await cloud.env.DB.prepare('select used_at from mobile_pairings where code_hash = ?').bind(await sha256Hex(code)).first<{ used_at: number | null }>())?.used_at).toBeNull();
    expect((await phoneJoin(code, { deviceId: 'phone-new' })).status).toBe(201);
  });

  it('同じ券の 2 回目は 401', async () => {
    const pc = await joinPc('pc-a');
    const code = await pairCode(pc);
    expect((await phoneJoin(code)).status).toBe(201);
    const again = await phoneJoin(code);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'unauthorized' });
    expect((await cloud.env.DB.prepare("select count(*) n from devices where kind = 'mobile'").first<{ n: number }>())?.n).toBe(1);
  });

  it('5 分を過ぎた券は 401', async () => {
    const pc = await joinPc('pc-a');
    const code = await pairCode(pc);
    await cloud.env.DB.prepare('update mobile_pairings set created_at = created_at - ?').bind(PAIRING_TTL_MS + 1).run();
    expect((await phoneJoin(code)).status).toBe(401);
    expect((await cloud.env.DB.prepare("select count(*) n from devices where kind = 'mobile'").first<{ n: number }>())?.n).toBe(0);
  });

  it('存在しない券は 401、形の違う本文は 400', async () => {
    await joinPc('pc-a');
    expect((await phoneJoin('A'.repeat(22))).status).toBe(401);
    expect((await phoneJoin(42)).status).toBe(400);
    expect((await send('/m/join', json({ code: 'abc' }))).status).toBe(400);
    // 0.8.0 の形（名前を平文で送る）は受けない。
    expect((await send('/m/join', json({ code: 'abc', device: { id: 'p', name: 'iPhone' } }))).status).toBe(400);
    for (const deviceId of ['', 'a/b', 'x'.repeat(65), 'recovery', 7]) expect((await phoneJoin('abc', { deviceId })).status, String(deviceId)).toBe(400);
    for (const sealed of ['', 'not base64!', 'abcde', 'x'.repeat(4097), 1]) expect((await phoneJoin('abc', { sealed })).status, String(sealed).slice(0, 10)).toBe(400);
  });

  it('参加の秘密を /m/join に渡しても参加できない', async () => {
    await joinPc('pc-a');
    expect((await phoneJoin(SECRET)).status).toBe(401);
    expect((await send('/m/join', json({ secret: SECRET, deviceId: 'phone-1', sealed: PHONE_REQUEST_SEALED }))).status).toBe(400);
    expect((await send('/m/join', json({ secret: SECRET, code: SECRET, deviceId: 'phone-1', sealed: PHONE_REQUEST_SEALED }))).status).toBe(401);
    expect((await cloud.env.DB.prepare("select count(*) n from devices where kind = 'mobile'").first<{ n: number }>())?.n).toBe(0);
  });

  it('解除したスマホは、前に使った券でも、新しい券なしでも戻れない（新しい券なら新しい行として参加できる）', async () => {
    const pc = await joinPc('pc-a');
    const code = await pairCode(pc);
    const first = (await (await phoneJoin(code)).json()) as MobileJoinResponse;
    expect((await revoke(pc, first.deviceId)).status).toBe(200);
    // 解除したスマホのトークンは 401。
    expect((await inbox(first.token)).status).toBe(401);
    // 前に使った券では戻れない。
    expect((await phoneJoin(code)).status).toBe(401);
    // 券なしで、最初の PC の口から同じ ID を名乗っても戻れない。
    expect((await send('/bootstrap', json({ deviceId: first.deviceId, token: 'x'.repeat(32) }))).status).toBe(401);
    const revokedRow = await cloud.env.DB.prepare('select revoked_at from devices where id = ?').bind(first.deviceId).first<{ revoked_at: number | null }>();
    expect(revokedRow?.revoked_at).not.toBeNull();
    // 新しい券なら、新しい行として参加できる。解除した行はそのまま残る。
    const second = await joinPhone(pc);
    expect(second.deviceId).not.toBe(first.deviceId);
    expect((await inbox(second.token)).status).toBe(200);
    expect((await inbox(first.token)).status).toBe(401);
  });

  it('スマホのトークンで POST /m/pairings は 403', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const r = await takePairing(phone.token);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'forbidden' });
  });

  it('同じ PC が 10 分に 6 枚目を取ると 429、ほかの PC は取れる', async () => {
    expect(PAIRING_RATE).toEqual({ max: 5, windowMs: 10 * 60_000 });
    const pc = await joinPc('pc-a');
    const other = await joinPc('pc-b');
    for (let i = 0; i < PAIRING_RATE.max; i++) expect((await takePairing(pc)).status).toBe(201);
    const limited = await takePairing(pc);
    expect(limited.status).toBe(429);
    const text = await limited.text();
    expect(JSON.parse(text)).toEqual({ error: 'rate limited' });
    // PC の読み手（readCloudLimit）が D1 の 1 日の上限と読み違えない。
    expect(readCloudLimit(429, text)).toBeNull();
    expect((await takePairing(other)).status).toBe(201);
    // 窓を過ぎれば、また取れる。
    await cloud.env.DB.prepare('update mobile_pairings set created_at = created_at - ? where created_by = ?').bind(PAIRING_RATE.windowMs, 'pc-a').run();
    expect((await takePairing(pc)).status).toBe(201);
  });

  it('解除されていないスマホが 10 台あると 409 で断り、券は使わずに残す', async () => {
    expect(MAX_ACTIVE_PHONES).toBe(10);
    const pc = await joinPc('pc-a');
    const tokens: MobileJoinResponse[] = [];
    for (let i = 0; i < MAX_ACTIVE_PHONES; i++) {
      // 券は 10 分に 5 枚までなので、取った券の時刻を戻して窓を空ける。
      await cloud.env.DB.prepare('update mobile_pairings set created_at = created_at - ?').bind(PAIRING_RATE.windowMs).run();
      tokens.push(await joinPhone(pc));
    }
    await cloud.env.DB.prepare('update mobile_pairings set created_at = created_at - ?').bind(PAIRING_RATE.windowMs).run();
    const code = await pairCode(pc);
    const r = await phoneJoin(code);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'too-many-phones' });
    expect((await cloud.env.DB.prepare("select count(*) n from devices where kind = 'mobile'").first<{ n: number }>())?.n).toBe(MAX_ACTIVE_PHONES);
    // 券は使われていない。1 台外せば、同じ券で参加できる。
    expect((await cloud.env.DB.prepare('select used_at from mobile_pairings where code_hash = ?').bind(await sha256Hex(code)).first<{ used_at: number | null }>())?.used_at).toBeNull();
    expect((await revoke(pc, tokens[0]!.deviceId)).status).toBe(200);
    expect((await phoneJoin(code)).status).toBe(201);
  });

  it('上限に達していても、無い券は 401（券の照合が先）', async () => {
    const pc = await joinPc('pc-a');
    await cloud.env.DB.prepare(
      "insert into devices (id, token_hash, joined_at, last_seen_at, last_pulled_seq, revoked_at, kind) with recursive n(i) as (select 1 union all select i + 1 from n where i < 10) select 'm' || i, 'h' || i, 1, 1, 0, null, 'mobile' from n",
    ).run();
    expect((await phoneJoin('A'.repeat(22))).status).toBe(401);
    expect((await phoneJoin(await pairCode(pc))).status).toBe(409);
  });

  it('古い券を消す文のために mobile_pairings(created_at) の索引がある', async () => {
    const idx = await cloud.env.DB.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'mobile_pairings'").all<{ name: string }>();
    expect(idx.results.map((x) => x.name)).toContain('mobile_pairings_at');
    const plan = await cloud.env.DB.prepare('explain query plan delete from mobile_pairings where created_at < ?').bind(1).all<{ detail: string }>();
    expect(plan.results.map((x) => x.detail).join(' ')).toContain('mobile_pairings_at');
  });

  it('券を取るついでに、1 日より古い券の行を消す', async () => {
    const pc = await joinPc('pc-a');
    await pairCode(pc);
    await cloud.env.DB.prepare('update mobile_pairings set created_at = created_at - ?').bind(24 * 60 * 60_000 + 1).run();
    await pairCode(pc);
    expect((await cloud.env.DB.prepare('select count(*) n from mobile_pairings').first<{ n: number }>())?.n).toBe(1);
  });
});

describe('スマホのトークンの範囲', () => {
  it('スマホのトークンで GET /changes、POST /changes、GET /rows、GET /files、GET /devices は 403', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const cases: [string, string, RequestInit?][] = [
      ['GET', '/changes?since=0'],
      ['POST', '/changes', { body: JSON.stringify({ changes: [] }) }],
      ['GET', '/rows?after=&limit=10'],
      ['GET', '/files?since=0'],
      ['GET', '/devices'],
      ['POST', `/devices/pc-a/revoke`],
      ['GET', '/usage'],
      // スマホ用の鍵を置く口と、券のリクエストを読む口は PC だけである（互換の版 9）。
      ['PUT', '/phone-keyboxes', { body: JSON.stringify({ boxes: [{ epoch: 1, recipient: phone.deviceId, sealed: b64('box') }] }) }],
      ['GET', '/m/pairings/mine'],
      ['GET', '/roster'],
      ['GET', '/keyboxes'],
    ];
    for (const [method, path, extra] of cases) {
      const r = await send(path, { method, headers: auth(phone.token, { 'content-type': 'application/json' }), ...extra });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(await r.json(), `${method} ${path}`).toEqual({ error: 'forbidden' });
    }
    // スマホは PC を外せない。
    const row = await cloud.env.DB.prepare('select revoked_at from devices where id = ?').bind('pc-a').first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toBeNull();
  });

  it('PC のトークンで GET /m/inbox は 403、スマホのトークンで PUT /m/feed は 403', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const a = await inbox(pc);
    expect(a.status).toBe(403);
    expect(await a.json()).toEqual({ error: 'forbidden' });
    expect((await putFeed(phone.token, 'sealed-x')).status).toBe(403);
    expect((await cloud.env.DB.prepare('select count(*) n from mobile_feeds').first<{ n: number }>())?.n).toBe(0);
    const k = await getPhoneBox(pc);
    expect(k.status).toBe(403);
    expect(await k.json()).toEqual({ error: 'forbidden' });
  });

  it('トークンなしの /m/pairings、/m/feed、/m/inbox は 401', async () => {
    expect((await send('/m/pairings', { method: 'POST' })).status).toBe(401);
    expect((await send('/m/feed', { method: 'PUT', body: '{}' })).status).toBe(401);
    expect((await send('/m/inbox')).status).toBe(401);
    expect((await send('/m/keybox')).status).toBe(401);
    expect((await send('/m/pairings/mine')).status).toBe(401);
    expect((await send('/phone-keyboxes', { method: 'PUT', body: '{}' })).status).toBe(401);
  });
});

describe('受信箱（PUT /m/feed と GET /m/inbox）', () => {
  it('PC が PUT /m/feed した行を、スマホの GET /m/inbox が返す。同じ PC の 2 回目は上書きで行は 1 つ', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const w1 = await putFeed(pc, 'sealed-1');
    expect(w1.status).toBe(200);
    // スマホ用の鍵を次の世代にした後の素である。世代は素と一緒に置き、スマホはそれを見て keybox を読み直す。
    const w2 = await putFeed(pc, 'sealed-2', 2);
    expect(w2.status).toBe(200);
    expect((await cloud.env.DB.prepare('select count(*) n from mobile_feeds').first<{ n: number }>())?.n).toBe(1);
    const r = await inbox(phone.token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as MobileInboxResponse;
    expect(typeof body.now).toBe('number');
    expect(body.feeds).toEqual([{ deviceId: 'pc-a', updatedAt: expect.any(Number), sealed: 'sealed-2', epoch: 2 }]);
    // devices は PC だけで、スマホ自身は出さない。
    // 名前と OS は devices に無い（互換の版 9）。封じた名簿から読むまでは ID と空の OS を返す。
    expect(body.devices).toEqual([{ id: 'pc-a', name: 'pc-a', platform: '', lastSeenAt: expect.any(Number) }]);
  });

  it('PUT /m/feed は 96 KiB を超えたら 413、上限いっぱい（48 KiB）の素を封をした本文は通る、形の違う本文は 400', async () => {
    expect(MAX_FEED_BODY_BYTES).toBe(96 * 1024);
    const pc = await joinPc('pc-a');
    // 暗号化の前で MOBILE_FEED_MAX_BYTES ちょうどの素を、PC と同じ seal で封をする。
    const key = await deriveMobileKey('join-secret-feed');
    const plain = 'x'.repeat(MOBILE_FEED_MAX_BYTES - 2);
    expect(new TextEncoder().encode(JSON.stringify(plain)).byteLength).toBe(MOBILE_FEED_MAX_BYTES);
    const sealed = await seal(key, aadFeed('pc-a'), plain);
    expect(JSON.stringify({ sealed }).length).toBeGreaterThan(64 * 1024);
    expect((await putFeed(pc, sealed)).status).toBe(200);
    expect((await putFeed(pc, 'x'.repeat(96 * 1024))).status).toBe(413);
    // JSON の枠（{"sealed":"","epoch":1}）の 23 バイトを引くと、ちょうど上限になる。
    expect((await putFeed(pc, 'x'.repeat(96 * 1024 - 23))).status).toBe(200);
    expect((await putFeed(pc, 'x'.repeat(96 * 1024 - 22))).status).toBe(413);
    expect((await send('/m/feed', { method: 'PUT', headers: auth(pc, { 'content-type': 'application/json' }), body: JSON.stringify({ sealed: 1 }) })).status).toBe(400);
    expect((await send('/m/feed', { method: 'PUT', headers: auth(pc, { 'content-type': 'application/json' }), body: JSON.stringify({ sealed: '' }) })).status).toBe(400);
    expect((await send('/m/feed', { method: 'PUT', headers: auth(pc, { 'content-type': 'application/json' }), body: 'not json' })).status).toBe(400);
    // 世代の無い素（0.8.0 の形）と、形の違う世代は 400。
    expect((await send('/m/feed', { method: 'PUT', headers: auth(pc, { 'content-type': 'application/json' }), body: JSON.stringify({ sealed: 'sealed-x' }) })).status).toBe(400);
    for (const epoch of [null, 0, -1, 1.5, '1']) expect((await putFeed(pc, 'sealed-x', epoch)).status, String(epoch)).toBe(400);
    expect((await putFeed(pc, 'x'.repeat(60 * 1024))).status).toBe(200);
  });

  it('PUT /m/feed は最終確認を書く（間引きつき）', async () => {
    const pc = await joinPc('pc-a');
    await cloud.env.DB.prepare('update devices set last_seen_at = 1 where id = ?').bind('pc-a').run();
    expect((await putFeed(pc, 'sealed-1')).status).toBe(200);
    const row = await cloud.env.DB.prepare('select last_seen_at from devices where id = ?').bind('pc-a').first<{ last_seen_at: number }>();
    expect(row!.last_seen_at).toBeGreaterThan(1);
  });

  it('解除した PC の受信箱の素は GET /m/inbox に出ない', async () => {
    const pcA = await joinPc('pc-a');
    const pcB = await joinPc('pc-b');
    const phone = await joinPhone(pcA);
    await putFeed(pcA, 'sealed-a');
    await putFeed(pcB, 'sealed-b');
    expect((await revoke(pcA, 'pc-b')).status).toBe(200);
    const body = (await (await inbox(phone.token)).json()) as MobileInboxResponse;
    expect(body.feeds.map((f) => f.deviceId)).toEqual(['pc-a']);
    expect(body.devices.map((d) => d.id)).toEqual(['pc-a']);
  });

  it('GET /m/inbox はスマホの最終確認を書く（間引きつき）', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    // 30 日より前にすると期限切れになるので、2 分前にする。
    const old = Date.now() - 2 * 60_000;
    await cloud.env.DB.prepare('update devices set last_seen_at = ? where id = ?').bind(old, phone.deviceId).run();
    expect((await inbox(phone.token)).status).toBe(200);
    const row = await cloud.env.DB.prepare('select last_seen_at from devices where id = ?').bind(phone.deviceId).first<{ last_seen_at: number }>();
    expect(row!.last_seen_at).toBeGreaterThan(old);
  });

  it('解除したスマホは 401', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect((await revoke(pc, phone.deviceId)).status).toBe(200);
    const r = await inbox(phone.token);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'revoked' });
  });

  it('GET /m/inbox が読む D1 の行は PC の数に比例し、rows の行数に依らない（rows を消しても 200）', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await putFeed(pc, 'sealed-a');
    await cloud.env.DB.prepare(
      "insert into rows (k, op, updated_at, device_id, epoch, sealed) with recursive n(i) as (select 1 union all select i + 1 from n where i < 2000) select 'k' || i, 'upsert', i, 'pc-a', 1, 'c2VhbGVk' from n",
    ).run();
    expect((await cloud.env.DB.prepare('select count(*) n from rows').first<{ n: number }>())?.n).toBe(2000);
    await cloud.env.DB.prepare('drop table rows').run();
    const r = await inbox(phone.token);
    expect(r.status).toBe(200);
    expect(((await r.json()) as MobileInboxResponse).feeds).toHaveLength(1);
  });
});

describe('PC の一覧と生存', () => {
  it('peers にスマホが出ない', async () => {
    const pcA = await joinPc('pc-a');
    await joinPc('pc-b');
    const phone = await joinPhone(pcA);
    const r = await send('/changes?since=0', { headers: auth(pcA) });
    expect(r.status).toBe(200);
    const peers = ((await r.json()) as SealedPullChangesResponse).peers.map((p) => p.id);
    expect(peers).toEqual(['pc-a', 'pc-b']);
    expect(peers).not.toContain(phone.deviceId);
  });

  it('GET /devices は kind を返し、スマホも同じ表に並ぶ', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const list = ((await (await send('/devices', { headers: auth(pc) })).json()) as DevicesOut).devices;
    const byId = new Map(list.map((d) => [d.id, d.kind]));
    expect(byId.size).toBe(2);
    expect(byId.get('pc-a')).toBe('pc');
    expect(byId.get(phone.deviceId)).toBe('mobile');
  });

  it('GET /devices はスマホの再接続の日付（expiresAt）と最後に使った時刻（lastSeenAt）を返す', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const list = ((await (await send('/devices', { headers: auth(pc) })).json()) as DevicesOut).devices;
    const p = list.find((d) => d.id === phone.deviceId)!;
    expect(p.expiresAt).toBe(p.joinedAt + PHONE_MAX_AGE_MS);
    expect(p.lastSeenAt).toBe(p.joinedAt);
    // PC のトークンには期限が無い。
    expect(list.find((d) => d.id === 'pc-a')!.expiresAt).toBeNull();
  });
});

describe('スマホ用の鍵（PUT /phone-keyboxes、GET /m/keybox、GET /m/pairings/mine）', () => {
  it('公開鍵つきで接続でき、keybox が置かれるまで GET /m/keybox は 404、置けばいちばん新しい世代だけを返す', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const none = await getPhoneBox(phone.token);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: 'not found' });
    const w = await putPhoneBoxes(pc, [{ epoch: 1, recipient: phone.deviceId, sealed: b64('box-1') }]);
    expect(w.status).toBe(200);
    expect(await w.json()).toEqual({ written: 1 });
    expect(await (await getPhoneBox(phone.token)).json()).toEqual({ epoch: 1, sealed: b64('box-1') } satisfies KeyboxOut);
    // スマホを解除した PC が次の世代を置く（Task 24）。古い世代の箱は返さない。
    expect((await putPhoneBoxes(pc, [{ epoch: 2, recipient: phone.deviceId, sealed: b64('box-2') }])).status).toBe(200);
    expect(await (await getPhoneBox(phone.token)).json()).toEqual({ epoch: 2, sealed: b64('box-2') });
    // 同じ世代と受け手は上書きする。
    expect((await putPhoneBoxes(pc, [{ epoch: 2, recipient: phone.deviceId, sealed: b64('box-2b') }])).status).toBe(200);
    expect(await (await getPhoneBox(phone.token)).json()).toEqual({ epoch: 2, sealed: b64('box-2b') });
    // D1 には封じたバイト列の BLOB で置く。
    const rows = await cloud.env.DB.prepare('select epoch, recipient, typeof(sealed) t from phone_keyboxes order by epoch').all();
    expect(rows.results).toEqual([
      { epoch: 1, recipient: phone.deviceId, t: 'blob' },
      { epoch: 2, recipient: phone.deviceId, t: 'blob' },
    ]);
  });

  it('ほかのスマホ宛ての keybox は読めない', async () => {
    const pc = await joinPc('pc-a');
    const a = await joinPhone(pc);
    const b = await joinPhone(pc);
    expect((await putPhoneBoxes(pc, [{ epoch: 1, recipient: a.deviceId, sealed: b64('box-a') }])).status).toBe(200);
    expect((await getPhoneBox(b.token)).status).toBe(404);
    expect(await (await getPhoneBox(a.token)).json()).toEqual({ epoch: 1, sealed: b64('box-a') });
  });

  it('PUT /phone-keyboxes の受け手は解除されていないスマホだけで、ほかが 1 つでも混ざれば何も書かずに 400', async () => {
    const pc = await joinPc('pc-a');
    const ok = await joinPhone(pc);
    const gone = await joinPhone(pc);
    expect((await send(`/devices/${gone.deviceId}/revoke`, { method: 'POST', headers: auth(pc) })).status).toBe(200);
    const good = { epoch: 1, recipient: ok.deviceId, sealed: b64('box') };
    for (const recipient of ['pc-a', gone.deviceId, 'nobody', 'recovery']) {
      const r = await putPhoneBoxes(pc, [good, { ...good, recipient }]);
      expect(r.status, recipient).toBe(400);
      expect(await r.json()).toEqual({ error: 'unknown recipient' });
    }
    const bad: unknown[][] = [[], Array.from({ length: 21 }, () => good), [{ ...good, epoch: 0 }], [{ ...good, epoch: 1.5 }], [{ ...good, sealed: '' }], [{ ...good, sealed: 'a!b' }], [{ ...good, recipient: 'a/b' }], [{ ...good, sealed: 'x'.repeat(16_385) }]];
    for (const boxes of bad) expect((await putPhoneBoxes(pc, boxes)).status, JSON.stringify(boxes).slice(0, 60)).toBe(400);
    expect((await send('/phone-keyboxes', { method: 'PUT', headers: auth(pc, { 'content-type': 'application/json' }), body: 'not json' })).status).toBe(400);
    expect((await cloud.env.DB.prepare('select count(*) n from phone_keyboxes').first<{ n: number }>())?.n).toBe(0);
  });

  it('スマホの keybox を置いても名簿の印の行は進めない（PC は名簿を読み直さない）', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const before = await cloud.env.DB.prepare('select max(seq) s from rows').first<{ s: number | null }>();
    expect((await putPhoneBoxes(pc, [{ epoch: 1, recipient: phone.deviceId, sealed: b64('box') }])).status).toBe(200);
    expect(await cloud.env.DB.prepare('select max(seq) s from rows').first<{ s: number | null }>()).toEqual(before);
  });

  it('GET /m/keybox と GET /m/pairings/mine の文は索引で引き、表を走査しない', async () => {
    const plan = async (sql: string, ...args: unknown[]) =>
      (await cloud.env.DB.prepare(`explain query plan ${sql}`).bind(...args).all<{ detail: string }>()).results.map((x) => x.detail).join(' ');
    expect(await plan('select epoch, sealed from phone_keyboxes where recipient = ? order by epoch desc limit 1', 'p')).toContain('phone_keyboxes_recipient');
    expect(await plan('select code_hash, device_id, request, used_at from mobile_pairings where created_by = ? and request is not null order by created_at', 'p')).toContain('mobile_pairings_pending');
  });

  it('GET /m/pairings/mine は自分の券に置かれた参加リクエストだけを返し、keybox を置くと消える', async () => {
    const pcA = await joinPc('pc-a');
    const pcB = await joinPc('pc-b');
    const code = await pairCode(pcA);
    await pairCode(pcB);
    // 券を出しただけで、まだ誰も接続していない。
    expect(await (await pairingsMine(pcA)).json()).toEqual({ pairings: [] } satisfies MobilePairingsMine);
    const sealed = b64('sealed-request-from-phone');
    const j = await phoneJoin(code, { deviceId: 'phone-q', sealed });
    expect(j.status).toBe(201);
    const mine = (await (await pairingsMine(pcA)).json()) as MobilePairingsMine;
    expect(mine).toEqual({ pairings: [{ codeHash: await sha256Hex(code), deviceId: 'phone-q', sealed, joinedAt: expect.any(Number) }] });
    // ほかの PC の券のリクエストは見えない。
    expect(await (await pairingsMine(pcB)).json()).toEqual({ pairings: [] });
    // keybox を置いた後は返さない。封じたリクエストも D1 から消える。
    expect((await putPhoneBoxes(pcA, [{ epoch: 1, recipient: 'phone-q', sealed: b64('box') }])).status).toBe(200);
    expect(await (await pairingsMine(pcA)).json()).toEqual({ pairings: [] });
    expect((await cloud.env.DB.prepare('select request from mobile_pairings where device_id = ?').bind('phone-q').first<{ request: unknown }>())?.request).toBeNull();
  });
});

describe('スマホのトークンの期限（30 日使わないと失効、接続から 90 日で再接続）', () => {
  it('期限の値', () => {
    expect(PHONE_IDLE_MS).toBe(30 * DAY);
    expect(PHONE_MAX_AGE_MS).toBe(90 * DAY);
  });

  it('30 日使わないと 401 expired で、どの口も通らず、最終確認も書かない', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const stale = Date.now() - PHONE_IDLE_MS - 1000;
    await cloud.env.DB.prepare('update devices set last_seen_at = ? where id = ?').bind(stale, phone.deviceId).run();
    for (const path of ['/m/inbox', '/m/keybox', '/m/launches/x']) {
      const r = await send(path, { headers: auth(phone.token) });
      expect(r.status, path).toBe(401);
      expect(await r.json(), path).toEqual({ error: 'expired' });
    }
    expect((await cloud.env.DB.prepare('select last_seen_at from devices where id = ?').bind(phone.deviceId).first<{ last_seen_at: number }>())?.last_seen_at).toBe(stale);
  });

  it('一度も使っていないスマホは接続した時刻から 30 日で失効する', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await cloud.env.DB.prepare('update devices set last_seen_at = null, joined_at = ? where id = ?').bind(Date.now() - PHONE_IDLE_MS - 1000, phone.deviceId).run();
    const r = await getPhoneBox(phone.token);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'expired' });
  });

  it('使えば延長される（受信箱でない口でも最終確認を進める）', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    // 29 日と 23 時間 59 分の間、使っていない。
    await cloud.env.DB.prepare('update devices set last_seen_at = ? where id = ?').bind(Date.now() - PHONE_IDLE_MS + 60_000, phone.deviceId).run();
    const before = Date.now();
    expect((await getPhoneBox(phone.token)).status).toBe(404);
    const seen = (await cloud.env.DB.prepare('select last_seen_at from devices where id = ?').bind(phone.deviceId).first<{ last_seen_at: number }>())!.last_seen_at;
    expect(seen).toBeGreaterThanOrEqual(before);
    // 延びた分だけ、まだ使える。
    expect((await inbox(phone.token)).status).toBe(200);
  });

  it('使い続けていても、接続から 90 日で 401 expired', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await cloud.env.DB.prepare('update devices set joined_at = ?, expires_at = ?, last_seen_at = ? where id = ?').bind(Date.now() - PHONE_MAX_AGE_MS - 1000, Date.now() - 1000, Date.now(), phone.deviceId).run();
    const r = await inbox(phone.token);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'expired' });
  });

  it('PC の端末トークンは 30 日使わなくても失効しない', async () => {
    const pc = await joinPc('pc-a');
    await cloud.env.DB.prepare('update devices set last_seen_at = ? where id = ?').bind(Date.now() - 100 * DAY, 'pc-a').run();
    expect((await send('/devices', { headers: auth(pc) })).status).toBe(200);
  });
});
