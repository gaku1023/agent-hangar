import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aadFeed, deriveMobileKey, MOBILE_FEED_MAX_BYTES, readCloudLimit, seal, type CloudDevicesResponse, type MobileInboxResponse, type MobileJoinResponse, type MobilePairingResponse, type PullChangesResponse } from '@agent-hangar/shared';
import { MAX_ACTIVE_PHONES, MAX_FEED_BODY_BYTES, PAIRING_RATE, PAIRING_TTL_MS } from '../src/mobile.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-mobile';

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const joinPc = async (id: string): Promise<string> => {
  const r = await send('/join', json({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }));
  expect(r.status).toBe(201);
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

const takePairing = (token: string) => send('/m/pairings', { method: 'POST', headers: auth(token) });

const pairCode = async (token: string): Promise<string> => {
  const r = await takePairing(token);
  expect(r.status).toBe(201);
  return ((await r.json()) as MobilePairingResponse).code;
};

const phoneJoin = (code: unknown, name = 'iPhone') => send('/m/join', json({ code, device: { id: 'phone-1', name } }));

const joinPhone = async (pcToken: string, name = 'iPhone'): Promise<MobileJoinResponse> => {
  const r = await phoneJoin(await pairCode(pcToken), name);
  expect(r.status).toBe(201);
  return (await r.json()) as MobileJoinResponse;
};

const putFeed = (token: string, sealed: string) =>
  send('/m/feed', { method: 'PUT', headers: auth(token, { 'content-type': 'application/json' }), body: JSON.stringify({ sealed }) });

const inbox = (token: string) => send('/m/inbox', { headers: auth(token) });

const revoke = (token: string, id: string) => send(`/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: auth(token) });

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
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

    const j = await phoneJoin(pairing.code);
    expect(j.status).toBe(201);
    const body = (await j.json()) as MobileJoinResponse;
    expect(Object.keys(body).sort()).toEqual(['deviceId', 'token']);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // 新しい ID を Worker が振る。スマホが名乗る ID で既存の行を指させない。
    expect(body.deviceId).not.toBe('pc-a');
    expect(body.deviceId).not.toBe('phone-1');
    const row = await cloud.env.DB.prepare('select kind, platform, name, token_hash, revoked_at from devices where id = ?').bind(body.deviceId).first<{ kind: string; platform: string; name: string; token_hash: string; revoked_at: number | null }>();
    expect(row).toEqual({ kind: 'mobile', platform: 'mobile', name: 'iPhone', token_hash: await sha256Hex(body.token), revoked_at: null });
    const pcRow = await cloud.env.DB.prepare('select kind from devices where id = ?').bind('pc-a').first<{ kind: string }>();
    expect(pcRow?.kind).toBe('pc');
    // スマホのトークンで受信箱を読める。
    expect((await inbox(body.token)).status).toBe(200);
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
    expect((await send('/m/join', json({ code: 'abc', device: { id: 'p', name: 'a/b' } }))).status).toBe(400);
  });

  it('参加の秘密を /m/join に渡しても参加できない', async () => {
    await joinPc('pc-a');
    expect((await phoneJoin(SECRET)).status).toBe(401);
    expect((await send('/m/join', json({ secret: SECRET, device: { id: 'phone-1', name: 'iPhone' } }))).status).toBe(400);
    expect((await send('/m/join', json({ secret: SECRET, code: SECRET, device: { id: 'phone-1', name: 'iPhone' } }))).status).toBe(401);
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
    // 券なしで、PC の参加の口から同じ ID を名乗っても戻れない。
    expect((await send('/join', json({ secret: 'wrong', device: { id: first.deviceId, name: 'iPhone', platform: 'mobile' } }))).status).toBe(403);
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
      tokens.push(await joinPhone(pc, `phone ${i}`));
    }
    await cloud.env.DB.prepare('update mobile_pairings set created_at = created_at - ?').bind(PAIRING_RATE.windowMs).run();
    const code = await pairCode(pc);
    const r = await phoneJoin(code, 'phone 11');
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'too-many-phones' });
    expect((await cloud.env.DB.prepare("select count(*) n from devices where kind = 'mobile'").first<{ n: number }>())?.n).toBe(MAX_ACTIVE_PHONES);
    // 券は使われていない。1 台外せば、同じ券で参加できる。
    expect((await cloud.env.DB.prepare('select used_at from mobile_pairings where code_hash = ?').bind(await sha256Hex(code)).first<{ used_at: number | null }>())?.used_at).toBeNull();
    expect((await revoke(pc, tokens[0]!.deviceId)).status).toBe(200);
    expect((await phoneJoin(code, 'phone 11')).status).toBe(201);
  });

  it('上限に達していても、無い券は 401（券の照合が先）', async () => {
    const pc = await joinPc('pc-a');
    await cloud.env.DB.prepare(
      "insert into devices (id, name, platform, token_hash, joined_at, last_seen_at, last_pulled_seq, revoked_at, kind) with recursive n(i) as (select 1 union all select i + 1 from n where i < 10) select 'm' || i, 'm' || i, 'mobile', 'h' || i, 1, 1, 0, null, 'mobile' from n",
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

  it('スマホの行の ID で POST /join すると 409 で、スマホの行は変わらない', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const r = await send('/join', json({ secret: SECRET, device: { id: phone.deviceId, name: 'evil', platform: 'darwin' } }));
    expect(r.status).toBe(409);
    const row = await cloud.env.DB.prepare('select kind, name, token_hash from devices where id = ?').bind(phone.deviceId).first<{ kind: string; name: string; token_hash: string }>();
    expect(row).toEqual({ kind: 'mobile', name: 'iPhone', token_hash: await sha256Hex(phone.token) });
    // PC の参加し直しは今までどおり通る。
    expect((await send('/join', json({ secret: SECRET, device: { id: 'pc-a', name: 'pc-a', platform: 'darwin' } }))).status).toBe(201);
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
  });

  it('トークンなしの /m/pairings、/m/feed、/m/inbox は 401', async () => {
    expect((await send('/m/pairings', { method: 'POST' })).status).toBe(401);
    expect((await send('/m/feed', { method: 'PUT', body: '{}' })).status).toBe(401);
    expect((await send('/m/inbox')).status).toBe(401);
  });
});

describe('受信箱（PUT /m/feed と GET /m/inbox）', () => {
  it('PC が PUT /m/feed した行を、スマホの GET /m/inbox が返す。同じ PC の 2 回目は上書きで行は 1 つ', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const w1 = await putFeed(pc, 'sealed-1');
    expect(w1.status).toBe(200);
    const w2 = await putFeed(pc, 'sealed-2');
    expect(w2.status).toBe(200);
    expect((await cloud.env.DB.prepare('select count(*) n from mobile_feeds').first<{ n: number }>())?.n).toBe(1);
    const r = await inbox(phone.token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as MobileInboxResponse;
    expect(typeof body.now).toBe('number');
    expect(body.feeds).toEqual([{ deviceId: 'pc-a', updatedAt: expect.any(Number), sealed: 'sealed-2' }]);
    // devices は PC だけで、スマホ自身は出さない。
    expect(body.devices).toEqual([{ id: 'pc-a', name: 'pc-a', platform: 'darwin', lastSeenAt: expect.any(Number) }]);
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
    expect((await putFeed(pc, 'x'.repeat(96 * 1024 - 20))).status).toBe(200);
    expect((await send('/m/feed', { method: 'PUT', headers: auth(pc, { 'content-type': 'application/json' }), body: JSON.stringify({ sealed: 1 }) })).status).toBe(400);
    expect((await send('/m/feed', { method: 'PUT', headers: auth(pc, { 'content-type': 'application/json' }), body: JSON.stringify({ sealed: '' }) })).status).toBe(400);
    expect((await send('/m/feed', { method: 'PUT', headers: auth(pc, { 'content-type': 'application/json' }), body: 'not json' })).status).toBe(400);
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
    await cloud.env.DB.prepare('update devices set last_seen_at = 1 where id = ?').bind(phone.deviceId).run();
    expect((await inbox(phone.token)).status).toBe(200);
    const row = await cloud.env.DB.prepare('select last_seen_at from devices where id = ?').bind(phone.deviceId).first<{ last_seen_at: number }>();
    expect(row!.last_seen_at).toBeGreaterThan(1);
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
      "insert into rows (k, table_name, row_id, op, payload, updated_at, device_id) with recursive n(i) as (select 1 union all select i + 1 from n where i < 2000) select 'projects:p' || i, 'projects', 'p' || i, 'upsert', '{}', i, 'pc-a' from n",
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
    const peers = ((await r.json()) as PullChangesResponse).peers.map((p) => p.id);
    expect(peers).toEqual(['pc-a', 'pc-b']);
    expect(peers).not.toContain(phone.deviceId);
  });

  it('GET /devices は kind を返し、スマホも同じ表に並ぶ', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const list = ((await (await send('/devices', { headers: auth(pc) })).json()) as CloudDevicesResponse).devices;
    const byId = new Map(list.map((d) => [d.id, [d.kind, d.platform]]));
    expect(byId.size).toBe(2);
    expect(byId.get('pc-a')).toEqual(['pc', 'darwin']);
    expect(byId.get(phone.deviceId)).toEqual(['mobile', 'mobile']);
  });
});
