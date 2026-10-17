import path from 'node:path';
import { aadFeed, decodePairing, deriveMobileKey, importMobileKey, open, seal } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudError } from '../../sync/client.ts';
import { createApp, type AppDeps } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 同期の経路（routes/sync.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let deps: AppDeps;
/** 偽物の口が呼ばれた順。testDeps の calls と同じ配列である。 */
let calls: string[];
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  t = await testDeps();
  ({ deps, calls } = t);
  app = createApp(deps);
});
afterEach(() => { t.dispose(); });

describe('同期の経路', () => {
  const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('同期の経路も認証の下にある', async () => {
    // 参加トークンは全セッションの読み書き権を持つ。鍵の無い要求と別サイトからの要求は入口で断る。
    for (const p of ['/api/sync/status', '/api/sync/joinToken', '/api/devices', '/api/sync/cloud-devices']) {
      expect((await get(p, {})).status).toBe(401);
      expect((await get(p, { ...H, origin: 'https://evil.example' })).status).toBe(403);
    }
    const noAuth = await app.request('/api/sync/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }) });
    expect(noAuth.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('bootstrap に sync と devices が乗り、設定に旧い設定の同期のスイッチは出ない', async () => {
    const { body } = await json(await get('/api/bootstrap'));
    expect(body.sync).toMatchObject({ state: 'idle', pending: 0, deviceCount: 2 });
    expect(body.devices).toEqual([{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: 1, self: true, shell: null }]);
    expect(body.settings).not.toHaveProperty('syncClaudeConfig');
    expect(body.sync).not.toHaveProperty('claudeConfig');
    expect(body.sessions[0].lock).toBeNull();
    expect(body.sessions[0].remoteOnly).toBe(false);
  });

  it('status、now、pause、focus', async () => {
    expect((await json(await get('/api/sync/status'))).body.state).toBe('idle');
    expect((await json(await post('/api/sync/now'))).body.state).toBe('idle');
    expect((await post('/api/sync/pause', { paused: true })).status).toBe(200);
    expect((await post('/api/sync/pause', { paused: 'yes' })).status).toBe(400);
    expect((await post('/api/sync/focus')).status).toBe(202);
    expect(calls).toEqual(['syncNow', 'pause:true', 'focus']);
  });

  it('降ろすのを諦めた項目が同期の状態に乗る', async () => {
    // onError は 1 度しか鳴らないので、鳴った後に画面を開いた利用者はここでしか気付けない。
    t.sync.skipped = [{ key: 'transcripts/mini/u1.jsonl.gz', attempts: 3, message: '復号できません' }];
    expect((await json(await get('/api/sync/status'))).body.skipped).toEqual(t.sync.skipped);
    expect((await json(await get('/api/bootstrap'))).body.sync.skipped).toEqual(t.sync.skipped);
  });

  it('取り残しの残り件数が同期の状態に乗る', async () => {
    // 数えられないときは null で、0 件（追いついた）と区別できる。
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBeNull();
    t.sync.sweepPending = 1500;
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBe(1500);
    expect((await json(await get('/api/bootstrap'))).body.sync.sweepPending).toBe(1500);
    // 今すぐ同期と一時停止の応答も同じ形で返す。画面はこの 3 つから付録を受け取る。
    expect((await json(await post('/api/sync/now'))).body.sweepPending).toBe(1500);
    expect((await json(await post('/api/sync/pause', { paused: true }))).body.sweepPending).toBe(1500);
    t.sync.sweepPending = 0;
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBe(0);
  });

  it('掃除の口を渡さない端末では取り残しは null のまま', async () => {
    app = createApp({ ...deps, syncSweep: () => null });
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBeNull();
  });

  it('参加トークンと端末一覧', async () => {
    expect((await json(await get('/api/sync/joinToken'))).body).toEqual({ token: 'tok-abc' });
    expect((await json(await get('/api/devices'))).body).toHaveLength(1);
  });

  it('旧い設定の同期の経路（/api/sync/config/*）は無い', async () => {
    // 段 4 の PR 18 で旧実装ごと消した。作り直した実装は /api/config-sync/* だけである。
    expect((await get('/api/sync/config/preview')).status).toBe(404);
    expect((await post('/api/sync/config/pull')).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('GET /api/sync/usage は今の値を、refresh=1 は取り直した値を返す', async () => {
    const dto = { source: 'unknown', fetchedAt: null, stale: false, notice: null, limits: { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 }, today: { d1RowsWritten: null, workersRequests: null, resetAt: 3 }, plan: null, month: null };
    const refreshed = { ...dto, today: { ...dto.today, d1RowsWritten: 9 } };
    app = createApp({ ...deps, cloudUsage: { current: () => dto as never, refresh: async () => refreshed as never } });
    expect((await json(await get('/api/sync/usage'))).body).toEqual(dto);
    expect((await json(await get('/api/sync/usage?refresh=1'))).body).toEqual(refreshed);
    expect((await json(await get('/api/bootstrap'))).body.cloudUsage).toEqual(dto);
  });

  it('使用量がまだ無ければ /api/sync/usage と bootstrap の cloudUsage は null', async () => {
    expect((await json(await get('/api/sync/usage'))).body).toBeNull();
    expect((await json(await get('/api/bootstrap'))).body.cloudUsage).toBeNull();
  });

  it('同期が未設定なら参加トークンは null', async () => {
    app = createApp({ ...deps, joinToken: () => null });
    expect((await json(await get('/api/sync/joinToken'))).body).toEqual({ token: null });
  });
});

describe('PC の一覧（Worker の devices）', () => {
  it('GET /api/sync/cloud-devices は依存の答えをそのまま返す', async () => {
    const dto = { state: 'ok' as const, devices: [{ id: 'd', kind: 'pc' as const, name: 'mac', platform: 'darwin', joinedAt: 1, lastSeenAt: 2, revokedAt: null, expiresAt: null, self: true }], creator: true, message: null };
    app = createApp({ ...deps, cloudDevices: async () => dto });
    expect(await json(await get('/api/sync/cloud-devices'))).toEqual({ status: 200, body: dto });
  });

  it('解除と参加と参加の解除の口は HTTP に無い（殻の命令と CLI だけが行う）', async () => {
    for (const p of ['/api/sync/devices/d/revoke', '/api/sync/join', '/api/sync/leave', '/api/devices/d/revoke']) {
      const r = await app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
      expect([p, r.status]).toEqual([p, 404]);
    }
  });
});

describe('スマホの接続の QR（POST /api/sync/mobile-pairing）', () => {
  const SECRET = 'join-secret-for-test-0123456789';
  const URL_ = 'https://w.example';
  const pair = (a: ReturnType<typeof createApp>) => a.request('/api/sync/mobile-pairing', { method: 'POST', headers: { ...H, 'content-type': 'application/json' } });
  type FakeClient = { createPairing?: () => Promise<{ code: string; expiresAt: number }>; lastWorkerCompat: () => number | null; health: () => Promise<{ ok: boolean; version: string }> };
  const withLink = (client: FakeClient) => createApp({ ...deps, mobileLink: () => ({ client: client as never, joinSecret: SECRET, url: URL_ }) });
  const ok = async () => ({ ok: true, version: 'x' });

  it('認証の下にあり、GET では取れない', async () => {
    expect((await app.request('/api/sync/mobile-pairing', { method: 'POST' })).status).toBe(401);
    expect((await get('/api/sync/mobile-pairing')).status).toBe(404);
  });

  it('参加していなければ not-joined', async () => {
    expect(await json(await pair(app))).toEqual({ status: 200, body: { state: 'not-joined' } });
  });

  it('Worker の版が 6 なら worker-too-old で、券を取りに行かない', async () => {
    const createPairing = vi.fn(async () => ({ code: 'c', expiresAt: 1 }));
    const a = withLink({ createPairing, lastWorkerCompat: () => 6, health: ok });
    expect((await json(await pair(a))).body).toEqual({ state: 'worker-too-old', compat: 6 });
    expect(createPairing).not.toHaveBeenCalled();
  });

  it('まだ版を知らなければ /health で確かめてから決める', async () => {
    let compat: number | null = null;
    const health = vi.fn(async () => { compat = 6; return { ok: true, version: 'x' }; });
    const a = withLink({ createPairing: async () => ({ code: 'c', expiresAt: 1 }), lastWorkerCompat: () => compat, health });
    expect((await json(await pair(a))).body).toEqual({ state: 'worker-too-old', compat: 6 });
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('Worker が /m/pairings を知らない（404）ときも worker-too-old', async () => {
    const a = withLink({ createPairing: async () => { throw new CloudError(404, 'not found'); }, lastWorkerCompat: () => 7, health: ok });
    expect((await json(await pair(a))).body).toEqual({ state: 'worker-too-old', compat: 7 });
  });

  it('券の取りすぎ（429）は rate-limited', async () => {
    const a = withLink({ createPairing: async () => { throw new CloudError(429, '{"error":"rate limited"}'); }, lastWorkerCompat: () => 7, health: ok });
    expect((await json(await pair(a))).body).toEqual({ state: 'rate-limited' });
  });

  it('ready の pairText を decodePairing すると url と券と鍵が入り、参加の秘密の文字列はどこにも含まれない', async () => {
    const createPairing = vi.fn(async () => ({ code: 'c0de-ticket', expiresAt: 1_700_000_300_000 }));
    const a = withLink({ createPairing, lastWorkerCompat: () => 7, health: ok });
    const r = await pair(a);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const { status, body } = await json(r);
    expect(status).toBe(200);
    expect(body.state).toBe('ready');
    expect(body.expiresAt).toBe(1_700_000_300_000);
    expect(body.pairUrl).toBe(`${URL_}/app/#pair=${body.pairText}`);
    const blob = decodePairing(body.pairText);
    expect(blob).toMatchObject({ url: URL_, code: 'c0de-ticket', pcName: 'mac', expiresAt: 1_700_000_300_000 });
    expect(Buffer.from(blob.key, 'base64url')).toHaveLength(32);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(blob)).not.toContain(SECRET);
    // 押すたびに新しい券を取る。
    await pair(a);
    expect(createPairing).toHaveBeenCalledTimes(2);
  });

  it('鍵で封じたものを deriveMobileKey(joinSecret) で開ける', async () => {
    const a = withLink({ createPairing: async () => ({ code: 'c', expiresAt: 1 }), lastWorkerCompat: () => 7, health: ok });
    const blob = decodePairing((await json(await pair(a))).body.pairText);
    const phoneKey = await importMobileKey(new Uint8Array(Buffer.from(blob.key, 'base64url')));
    const sealed = await seal(phoneKey, aadFeed('d'), { hello: 'phone' });
    expect(await open(await deriveMobileKey(SECRET), aadFeed('d'), sealed)).toEqual({ hello: 'phone' });
  });
});
