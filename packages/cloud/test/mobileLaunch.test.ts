import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aadLaunch, importMobileKey, LAUNCH_TTL_MS, MOBILE_PROMPT_MAX, seal, type MobileJoinResponse, type MobileLaunchIn, type MobileLaunchStatus, type MobilePairingResponse, type SealedPullChangesResponse, readCloudLimit } from '@agent-hangar/shared';
import { LAUNCH_KEEP_MS, LAUNCH_RATE, MAX_ANSWER_BODY_BYTES, MAX_LAUNCH_BODY_BYTES } from '../src/mobile.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { addPcDevice, joinPhoneDevice, startCloud, type CloudHarness } from './harness.ts';

/** 試験のスマホ用の鍵 M（作り物の 32 バイト）。Worker は封じた中身を読まない。 */
const PHONE_KEY = new Uint8Array(32).fill(5);

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (token: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  send(path, { method: 'POST', headers: auth(token, { 'content-type': 'application/json', ...extra }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** PC の行を D1 へ直に置く（互換の版 9 で POST /join を消した）。 */
const joinPc = (id: string): Promise<string> => addPcDevice(cloud.env, id);

/** スマホを参加させる。名前は封じた参加リクエストの中にあり、ここでは区別に使わない。 */
const joinPhone = (pcToken: string, _name = 'iPhone'): Promise<MobileJoinResponse> => joinPhoneDevice(cloud, pcToken);

/** 起動の依頼を出す。世代を省けば、スマホ用の鍵の世代 1 で封じた依頼として出す。 */
const launch = (phone: string, body: Omit<MobileLaunchIn, 'epoch'> & { epoch?: number }) => post(phone, '/m/launches', { epoch: 1, ...body });
const status = (phone: string, id: string) => send(`/m/launches/${encodeURIComponent(id)}`, { headers: auth(phone) });
const claim = (pc: string, id: string) => post(pc, `/m/launches/${encodeURIComponent(id)}/claim`);
const answer = (pc: string, id: string, body: unknown) => post(pc, `/m/launches/${encodeURIComponent(id)}/answer`, body);
const pull = async (pc: string, extra: Record<string, string> = {}): Promise<SealedPullChangesResponse> => {
  const r = await send('/changes?since=0', { headers: auth(pc, extra) });
  expect(r.status).toBe(200);
  return (await r.json()) as SealedPullChangesResponse;
};
const ageAll = (ms: number) => cloud.env.DB.prepare('update launch_requests set created_at = created_at - ?').bind(ms).run();
const countRows = async () => (await cloud.env.DB.prepare('select count(*) n from launch_requests').first<{ n: number }>())?.n;

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
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
    expect(await r.json()).toEqual({ id: 'l-1', status: 'pending', sealedAnswer: null, epoch: 1 } satisfies MobileLaunchStatus);
    const a = await pull(pcA);
    // from は送り手のスマホの ID（Worker が端末トークンで知るもの）。PC はこれで名簿のスマホの名前を引く。
    expect(a.launches).toEqual([{ id: 'l-1', createdAt: expect.any(Number), sealed: 'sealed-req', epoch: 1, from: phone.deviceId }]);
    expect(a.launches![0]!.createdAt).toBeGreaterThanOrEqual(before);
    expect((await pull(pcB)).launches).toEqual([]);
    // 平文で置くのは宛先と送り手と時刻と状態だけ。中身は封をしたまま。
    const row = await cloud.env.DB.prepare('select target_device, from_device, sealed, status from launch_requests where id = ?').bind('l-1').first();
    expect(row).toEqual({ target_device: 'pc-a', from_device: phone.deviceId, sealed: 'sealed-req', status: 'pending' });
  });

  it('依頼を封じたスマホ用の鍵の世代（epoch）を置き、PC の pull とスマホの GET に返す', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const r = await launch(phone.token, { id: 'l-3', targetDevice: 'pc-a', sealed: 'sealed-req', epoch: 3 });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ id: 'l-3', status: 'pending', sealedAnswer: null, epoch: 3 });
    expect((await pull(pc)).launches).toEqual([{ id: 'l-3', createdAt: expect.any(Number), sealed: 'sealed-req', epoch: 3, from: phone.deviceId }]);
    expect((await cloud.env.DB.prepare('select epoch from launch_requests where id = ?').bind('l-3').first<{ epoch: number }>())?.epoch).toBe(3);
    // 答えは依頼と同じ世代で封じる（Worker は答えの世代を別に持たない）。
    expect((await claim(pc, 'l-3')).status).toBe(200);
    expect((await answer(pc, 'l-3', { ok: true, sealedAnswer: 'ans-3' })).status).toBe(200);
    expect(await (await status(phone.token, 'l-3')).json()).toEqual({ id: 'l-3', status: 'started', sealedAnswer: 'ans-3', epoch: 3 });
  });

  it('同じ id の依頼を 2 回出しても行は 1 つ', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect((await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's-1' })).status).toBe(201);
    expect((await claim(pc, 'l-1')).status).toBe(200);
    const again = await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's-2' });
    expect(again.status).toBe(201);
    // 再送は既存の行の状態を返し、中身を書き換えない。
    expect(await again.json()).toEqual({ id: 'l-1', status: 'claimed', sealedAnswer: null, epoch: 1 });
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

  it('形の違う本文は 400、48 KiB を超える本文は 413', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect(MAX_LAUNCH_BODY_BYTES).toBe(48 * 1024);
    for (const bad of [
      {},
      { id: '', targetDevice: 'pc-a', sealed: 's', epoch: 1 },
      { id: 'x', targetDevice: 'pc-a', sealed: '', epoch: 1 },
      { id: 'x', targetDevice: 1, sealed: 's', epoch: 1 },
      { id: 'x'.repeat(65), targetDevice: 'pc-a', sealed: 's', epoch: 1 },
      // 世代の無い依頼（0.8.0 の形）と、形の違う世代。
      { id: 'x', targetDevice: 'pc-a', sealed: 's' },
      { id: 'x', targetDevice: 'pc-a', sealed: 's', epoch: 0 },
      { id: 'x', targetDevice: 'pc-a', sealed: 's', epoch: '1' },
    ]) {
      expect((await post(phone.token, '/m/launches', bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect((await send('/m/launches', { method: 'POST', headers: auth(phone.token, { 'content-type': 'application/json' }), body: 'not json' })).status).toBe(400);
    expect((await launch(phone.token, { id: 'big', targetDevice: 'pc-a', sealed: 'x'.repeat(48 * 1024) })).status).toBe(413);
    expect((await launch(phone.token, { id: 'ok', targetDevice: 'pc-a', sealed: 'x'.repeat(47 * 1024) })).status).toBe(201);
    expect(await countRows()).toBe(1);
  });

  it('3 バイトの字で上限いっぱい（MOBILE_PROMPT_MAX 字）の最初の指示を封じた依頼も受け取る', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const key = await importMobileKey(PHONE_KEY);
    const payload = { v: 1, createdAt: Date.now(), projectId: 'p'.repeat(128), scratch: false, accountId: 'a'.repeat(128), permissionMode: 'bypassPermissions', model: 'claude-sonnet-4-5', prompt: 'あ'.repeat(MOBILE_PROMPT_MAX) };
    const body = { id: '00000000-0000-4000-8000-000000000000', targetDevice: 'pc-a', sealed: await seal(key, aadLaunch('00000000-0000-4000-8000-000000000000', 'pc-a'), payload) };
    // 16 KiB には収まらない大きさである（前の上限で断られていた）。
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeGreaterThan(16 * 1024);
    expect((await launch(phone.token, body)).status).toBe(201);
  });

  it('応答の本文の上限は 16 KiB のまま', async () => {
    expect(MAX_ANSWER_BODY_BYTES).toBe(16 * 1024);
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect((await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's' })).status).toBe(201);
    expect((await claim(pc, 'l-1')).status).toBe(200);
    expect((await answer(pc, 'l-1', { ok: true, sealedAnswer: 'x'.repeat(16 * 1024) })).status).toBe(413);
    expect((await answer(pc, 'l-1', { ok: true, sealedAnswer: 'x'.repeat(15 * 1024) })).status).toBe(200);
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

  it('pull の応答は封じた行の欄に launches を添えた形である', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await launch(phone.token, { id: 'l-1', targetDevice: 'pc-a', sealed: 's' });
    const body = await pull(pc);
    expect(Array.isArray(body.changes)).toBe(true);
    expect(typeof body.nextSeq).toBe('number');
    expect(typeof body.more).toBe('boolean');
    expect(body.peers.map((p) => p.id)).toEqual(['pc-a']);
    expect(typeof body.now).toBe('number');
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
    expect(await (await status(phone.token, 'l-1')).json()).toEqual({ id: 'l-1', status: 'claimed', sealedAnswer: null, epoch: 1 });
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
    expect(await r.json()).toEqual({ id: 'l-1', status: 'expired', sealedAnswer: null, epoch: 1 });
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
    expect(await (await status(phone.token, 'l-1')).json()).toEqual({ id: 'l-1', status: 'started', sealedAnswer: 'ans-1', epoch: 1 });
    expect(await (await status(phone.token, 'l-2')).json()).toEqual({ id: 'l-2', status: 'failed', sealedAnswer: 'ans-2', epoch: 1 });
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
