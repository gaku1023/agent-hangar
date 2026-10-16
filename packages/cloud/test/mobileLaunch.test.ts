import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, LAUNCH_TTL_MS, type MobileJoinResponse, type MobileLaunchIn, type MobileLaunchStatus, type MobilePairingResponse, type PullChangesResponse, readCloudLimit } from '@agent-hangar/shared';
import { LAUNCH_KEEP_MS, LAUNCH_RATE, MAX_LAUNCH_BODY_BYTES } from '../src/mobile.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-launch';

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (token: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  send(path, { method: 'POST', headers: auth(token, { 'content-type': 'application/json', ...extra }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const joinPc = async (id: string): Promise<string> => {
  const r = await send('/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }) });
  expect(r.status).toBe(201);
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

const joinPhone = async (pcToken: string, name = 'iPhone'): Promise<MobileJoinResponse> => {
  const p = await post(pcToken, '/m/pairings');
  expect(p.status).toBe(201);
  const { code } = (await p.json()) as MobilePairingResponse;
  const r = await send('/m/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, device: { id: 'phone', name } }) });
  expect(r.status).toBe(201);
  return (await r.json()) as MobileJoinResponse;
};

const launch = (phone: string, body: MobileLaunchIn) => post(phone, '/m/launches', body);
const status = (phone: string, id: string) => send(`/m/launches/${encodeURIComponent(id)}`, { headers: auth(phone) });
const claim = (pc: string, id: string) => post(pc, `/m/launches/${encodeURIComponent(id)}/claim`);
const answer = (pc: string, id: string, body: unknown) => post(pc, `/m/launches/${encodeURIComponent(id)}/answer`, body);
const pull = async (pc: string, extra: Record<string, string> = {}): Promise<PullChangesResponse> => {
  const r = await send('/changes?since=0', { headers: auth(pc, extra) });
  expect(r.status).toBe(200);
  return (await r.json()) as PullChangesResponse;
};
const ageAll = (ms: number) => cloud.env.DB.prepare('update launch_requests set created_at = created_at - ?').bind(ms).run();
const countRows = async () => (await cloud.env.DB.prepare('select count(*) n from launch_requests').first<{ n: number }>())?.n;

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
});

afterEach(async () => {
  await cloud.dispose();
});

describe('起動の依頼（POST /m/launches と GET /changes の launches）', () => {
  it('スマホの依頼が宛先の PC の pull の launches に出て、ほかの PC には出ない', async () => {
    const pcA = await joinPc('pc-a');
    const pcB = await joinPc('pc-b');
    const phone = await joinPhone(pcA);
    const before = Date.now();
    const r = await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 'sealed-req' });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ id: 'l-1', status: 'pending', sealedAnswer: null } satisfies MobileLaunchStatus);
    const a = await pull(pcA);
    expect(a.launches).toEqual([{ id: 'l-1', createdAt: expect.any(Number), sealed: 'sealed-req' }]);
    expect(a.launches![0]!.createdAt).toBeGreaterThanOrEqual(before);
    expect((await pull(pcB)).launches).toEqual([]);
    // 平文で置くのは宛先と送り手と時刻と状態だけ。中身は封をしたまま。
    const row = await cloud.env.DB.prepare('select target_device, from_device, sealed, status from launch_requests where id = ?').bind('l-1').first();
    expect(row).toEqual({ target_device: 'pc-a', from_device: phone.deviceId, sealed: 'sealed-req', status: 'pending' });
  });

  it('同じ id の依頼を 2 回出しても行は 1 つ', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect((await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's-1' })).status).toBe(201);
    expect((await claim(pc, 'l-1')).status).toBe(200);
    const again = await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's-2' });
    expect(again.status).toBe(201);
    // 再送は既存の行の状態を返し、中身を書き換えない。
    expect(await again.json()).toEqual({ id: 'l-1', status: 'claimed', sealedAnswer: null });
    expect(await countRows()).toBe(1);
    expect((await cloud.env.DB.prepare('select sealed from launch_requests').first<{ sealed: string }>())?.sealed).toBe('s-1');
  });

  it('ほかのスマホが同じ id で出しても、元の依頼は変わらず中身も見えない', async () => {
    const pc = await joinPc('pc-a');
    const p1 = await joinPhone(pc, 'iPhone');
    const p2 = await joinPhone(pc, 'Android');
    expect((await launch(p1.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's-1' })).status).toBe(201);
    const r = await launch(p2.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's-2' });
    expect(r.status).toBe(409);
    expect(await countRows()).toBe(1);
    expect((await cloud.env.DB.prepare('select from_device, sealed from launch_requests').first())).toEqual({ from_device: p1.deviceId, sealed: 's-1' });
  });

  it('解除された PC 宛ての依頼は 404、スマホ宛てや無い宛先も 404', async () => {
    const pcA = await joinPc('pc-a');
    await joinPc('pc-b');
    const phone = await joinPhone(pcA);
    const other = await joinPhone(pcA, 'Android');
    expect((await send('/devices/pc-b/revoke', { method: 'POST', headers: auth(pcA) })).status).toBe(200);
    for (const target of ['pc-b', other.deviceId, 'no-such-pc']) {
      const r = await launch(phone.token, { id: `l-${target}`, targetDevice: target, sealed: 's' });
      expect(r.status, target).toBe(404);
    }
    expect(await countRows()).toBe(0);
  });

  it('形の違う本文は 400、16 KiB を超える本文は 413', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect(MAX_LAUNCH_BODY_BYTES).toBe(16 * 1024);
    for (const bad of [{}, { id: '', targetDevice: 'pc-a', sealed: 's' }, { id: 'x', targetDevice: 'pc-a', sealed: '' }, { id: 'x', targetDevice: 1, sealed: 's' }, { id: 'x'.repeat(65), targetDevice: 'pc-a', sealed: 's' }]) {
      expect((await post(phone.token, '/m/launches', bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect((await send('/m/launches', { method: 'POST', headers: auth(phone.token, { 'content-type': 'application/json' }), body: 'not json' })).status).toBe(400);
    expect((await launch(phone.token, { id: 'big', targetDevice: 'pc-a', sealed: 'x'.repeat(16 * 1024) })).status).toBe(413);
    expect((await launch(phone.token, { id: 'ok', targetDevice: 'pc-a', sealed: 'x'.repeat(15 * 1024) })).status).toBe(201);
    expect(await countRows()).toBe(1);
  });

  it('同じスマホの 11 件目（10 分以内）は 429、同じ id の再送は数えない', async () => {
    expect(LAUNCH_RATE).toEqual({ max: 10, windowMs: 10 * 60_000 });
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const other = await joinPhone(pc, 'Android');
    for (let i = 0; i < LAUNCH_RATE.max; i++) expect((await launch(phone.token, { id: `l-${i}`, targetDevice: 'pc-a', sealed: 's' })).status).toBe(201);
    // 再送は数えず、既存の状態を返す。
    expect((await launch(phone.token, { id: 'l-0', targetDevice: 'pc-a', sealed: 's' })).status).toBe(201);
    const r = await launch(phone.token, { id: 'l-10', targetDevice: 'pc-a', sealed: 's' });
    expect(r.status).toBe(429);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: 'rate limited' });
    // PC が D1 の 1 日の上限と読み違えない。
    expect(readCloudLimit(429, text)).toBeNull();
    expect(await countRows()).toBe(LAUNCH_RATE.max);
    // ほかのスマホは出せる。
    expect((await launch(other.token, { id: 'o-1', targetDevice: 'pc-a', sealed: 's' })).status).toBe(201);
    // 窓を過ぎれば、また出せる。
    await cloud.env.DB.prepare('update launch_requests set created_at = created_at - ? where from_device = ?').bind(LAUNCH_RATE.windowMs, phone.deviceId).run();
    expect((await launch(phone.token, { id: 'l-11', targetDevice: 'pc-a', sealed: 's' })).status).toBe(201);
  });

  it('依頼を出すついでに、7 日より古い行を消す', async () => {
    expect(LAUNCH_KEEP_MS).toBe(7 * 24 * 60 * 60_000);
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await launch(phone.token, { id: 'old', targetDevice: 'pc-a', sealed: 's' });
    await ageAll(LAUNCH_KEEP_MS + 1);
    await launch(phone.token, { id: 'new', targetDevice: 'pc-a', sealed: 's' });
    expect((await cloud.env.DB.prepare('select id from launch_requests').all<{ id: string }>()).results.map((x) => x.id)).toEqual(['new']);
  });

  it('消す文、数える文、pull の文は索引で引き、表を走査しない', async () => {
    const plan = async (sql: string, ...args: unknown[]) =>
      (await cloud.env.DB.prepare(`explain query plan ${sql}`).bind(...args).all<{ detail: string }>()).results.map((x) => x.detail).join(' ');
    expect(await plan('delete from launch_requests where created_at < ?', 1)).toContain('launch_requests_at');
    expect(await plan('select count(*) from launch_requests where from_device = ? and created_at > ?', 'p', 1)).toContain('launch_requests_from');
    expect(await plan("select id, created_at, sealed from launch_requests where target_device = ? and status = 'pending' and created_at > ? order by created_at limit ?", 'p', 1, 50)).toContain('launch_requests_target');
  });

  it('版 6 の PC の pull でも応答の形は壊れない', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's' });
    const body = await pull(pc, { [COMPAT_HEADER]: '6' });
    expect(Array.isArray(body.changes)).toBe(true);
    expect(typeof body.nextSeq).toBe('number');
    expect(typeof body.more).toBe('boolean');
    expect(body.peers.map((p) => p.id)).toEqual(['pc-a']);
    expect(typeof body.now).toBe('number');
    // launches は版 6 の PC にとって余分な欄で、ほかの欄の形は変えない。
    expect(Object.keys(body).sort()).toEqual(['changes', 'launches', 'more', 'nextSeq', 'now', 'peers']);
  });

  it('スマホのトークンで claim と answer は 403、PC のトークンで依頼と GET は 403', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect((await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's' })).status).toBe(201);
    expect((await claim(phone.token, 'l-1')).status).toBe(403);
    expect((await answer(phone.token, 'l-1', { ok: true, sealedAnswer: 'a' })).status).toBe(403);
    expect((await launch(pc, { id: 'l-2', targetDevice: 'pc-a', sealed: 's' })).status).toBe(403);
    expect((await status(pc, 'l-1')).status).toBe(403);
    expect((await send('/m/launches', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await send('/m/launches/l-1')).status).toBe(401);
  });
});

describe('受け取りと応答（claim と answer と GET /m/launches/:id）', () => {
  it('claim は 1 回目だけ 200、2 回目は 409', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's' });
    const first = await claim(pc, 'l-1');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect((await claim(pc, 'l-1')).status).toBe(409);
    // 受け取った依頼は pull に出ない。
    expect((await pull(pc)).launches).toEqual([]);
    expect(await (await status(phone.token, 'l-1')).json()).toEqual({ id: 'l-1', status: 'claimed', sealedAnswer: null });
  });

  it('宛先でない PC の claim は 409', async () => {
    const pcA = await joinPc('pc-a');
    const pcB = await joinPc('pc-b');
    const phone = await joinPhone(pcA);
    await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's' });
    expect((await claim(pcB, 'l-1')).status).toBe(409);
    expect((await claim(pcB, 'no-such')).status).toBe(409);
    expect((await claim(pcA, 'l-1')).status).toBe(200);
  });

  it('TTL を過ぎた依頼は pull に出ず、claim は 409、スマホの GET は expired', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's' });
    await ageAll(LAUNCH_TTL_MS + 1);
    expect((await pull(pc)).launches).toEqual([]);
    expect((await claim(pc, 'l-1')).status).toBe(409);
    // pull と claim は行を書き換えない。書き換えるのはスマホの GET だけ。
    expect((await cloud.env.DB.prepare('select status from launch_requests').first<{ status: string }>())?.status).toBe('pending');
    const r = await status(phone.token, 'l-1');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 'l-1', status: 'expired', sealedAnswer: null });
    expect((await cloud.env.DB.prepare('select status from launch_requests').first<{ status: string }>())?.status).toBe('expired');
  });

  it('answer の後、スマホの GET が started と sealedAnswer を返す。失敗は failed', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's' });
    await launch(phone.token, { id: 'l-2', targetDevice: 'pc-a', sealed: 's' });
    // claim の前の answer は 409。
    expect((await answer(pc, 'l-1', { ok: true, sealedAnswer: 'ans-1' })).status).toBe(409);
    expect((await claim(pc, 'l-1')).status).toBe(200);
    expect((await claim(pc, 'l-2')).status).toBe(200);
    const a = await answer(pc, 'l-1', { ok: true, sealedAnswer: 'ans-1' });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    expect((await answer(pc, 'l-2', { ok: false, sealedAnswer: 'ans-2' })).status).toBe(200);
    expect(await (await status(phone.token, 'l-1')).json()).toEqual({ id: 'l-1', status: 'started', sealedAnswer: 'ans-1' });
    expect(await (await status(phone.token, 'l-2')).json()).toEqual({ id: 'l-2', status: 'failed', sealedAnswer: 'ans-2' });
    // 答えた後の 2 回目は 409。
    expect((await answer(pc, 'l-1', { ok: false, sealedAnswer: 'x' })).status).toBe(409);
    // TTL を過ぎても、答えた依頼は expired にしない。
    await ageAll(LAUNCH_TTL_MS + 1);
    expect(((await (await status(phone.token, 'l-1')).json()) as MobileLaunchStatus).status).toBe('started');
  });

  it('宛先でない PC の answer は 409、形の違う本文は 400', async () => {
    const pcA = await joinPc('pc-a');
    const pcB = await joinPc('pc-b');
    const phone = await joinPhone(pcA);
    await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's' });
    expect((await claim(pcA, 'l-1')).status).toBe(200);
    expect((await answer(pcB, 'l-1', { ok: true, sealedAnswer: 'a' })).status).toBe(409);
    expect((await answer(pcA, 'l-1', { ok: 'yes', sealedAnswer: 'a' })).status).toBe(400);
    expect((await answer(pcA, 'l-1', { ok: true, sealedAnswer: '' })).status).toBe(400);
    expect((await answer(pcA, 'l-1', { ok: true, sealedAnswer: 'x'.repeat(16 * 1024) })).status).toBe(413);
    expect((await answer(pcA, 'l-1', { ok: true, sealedAnswer: 'a' })).status).toBe(200);
  });

  it('ほかのスマホの依頼の GET は 404、無い依頼も 404', async () => {
    const pc = await joinPc('pc-a');
    const p1 = await joinPhone(pc, 'iPhone');
    const p2 = await joinPhone(pc, 'Android');
    await launch(p1.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's' });
    expect((await claim(pc, 'l-1')).status).toBe(200);
    expect((await answer(pc, 'l-1', { ok: true, sealedAnswer: 'secret-answer' })).status).toBe(200);
    const r = await status(p2.token, 'l-1');
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('secret-answer');
    expect((await status(p1.token, 'no-such')).status).toBe(404);
    expect((await status(p1.token, 'l-1')).status).toBe(200);
  });
});
