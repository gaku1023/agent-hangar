import path from 'node:path';
import { decodePairing, type JoinApproverState } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudError, RevokedError } from '../../sync/client.ts';
import { JoinStateError } from '../../sync/joinApprover.ts';
import { RecoveryDraftError } from '../../sync/recoveryReissue.ts';
import { RevokeNotFoundError, RevokeSelfError } from '../../sync/rotate.ts';
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
    // 鍵の無い要求と別サイトからの要求は入口で断る。
    for (const p of ['/api/sync/status', '/api/sync/join-codes/current', '/api/devices', '/api/sync/cloud-devices']) {
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

  it('端末一覧', async () => {
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

  it('参加トークンの口（/api/sync/joinToken）は無い', async () => {
    expect((await get('/api/sync/joinToken')).status).toBe(404);
  });
});

describe('参加コードの発行と承認（/api/sync/join-codes）', () => {
  const send = (method: string, p: string) => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' } });

  /** JoinApprover の偽物。呼ばれた順を calls に積み、状態を手で動かす。 */
  function fakeApprover() {
    const log: string[] = [];
    let st: JoinApproverState = { kind: 'idle' };
    const a = {
      log,
      set: (s: JoinApproverState) => { st = s; },
      issueError: null as unknown,
      approveError: null as unknown,
      rejectError: null as unknown,
      state: () => st,
      issue: async () => {
        log.push('issue');
        if (a.issueError) throw a.issueError;
        st = { kind: 'open', code: 'K7QM-2XFD', expiresAt: 5 };
        return { code: 'K7QM-2XFD', expiresAt: 5 };
      },
      approve: async () => {
        log.push('approve');
        if (a.approveError) throw a.approveError;
        st = { kind: 'done', name: 'pc-b' };
      },
      reject: async () => {
        log.push('reject');
        if (a.rejectError) throw a.rejectError;
        st = { kind: 'idle' };
      },
      cancel: () => { log.push('cancel'); st = { kind: 'idle' }; },
    };
    return a;
  }

  it('どれも認証の下にある', async () => {
    for (const [m, p] of [['POST', '/api/sync/join-codes'], ['GET', '/api/sync/join-codes/current'], ['POST', '/api/sync/join-codes/current/approve'], ['POST', '/api/sync/join-codes/current/reject'], ['DELETE', '/api/sync/join-codes/current']] as const) {
      expect((await app.request(p, { method: m })).status).toBe(401);
    }
  });

  it('同期を設定していなければ 404', async () => {
    app = createApp({ ...deps, joinApprover: () => null });
    for (const [m, p] of [['POST', '/api/sync/join-codes'], ['GET', '/api/sync/join-codes/current'], ['POST', '/api/sync/join-codes/current/approve'], ['POST', '/api/sync/join-codes/current/reject'], ['DELETE', '/api/sync/join-codes/current']] as const) {
      const r = await send(m, p);
      expect(r.status).toBe(404);
      expect((await r.json()).error).toBe('クラウド同期が設定されていません');
    }
  });

  it('発行、状態、承認、拒否、取り消しを JoinApprover へ渡し、状態を返す（キャッシュさせない）', async () => {
    const a = fakeApprover();
    app = createApp({ ...deps, joinApprover: () => a });
    const issued = await send('POST', '/api/sync/join-codes');
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    expect(await issued.json()).toEqual({ kind: 'open', code: 'K7QM-2XFD', expiresAt: 5 });
    const cur = await send('GET', '/api/sync/join-codes/current');
    expect(cur.headers.get('cache-control')).toBe('no-store');
    expect(await cur.json()).toEqual({ kind: 'open', code: 'K7QM-2XFD', expiresAt: 5 });
    a.set({ kind: 'requested', code: 'K7QM-2XFD', expiresAt: 5, request: { name: 'pc-b', os: 'linux', sas: '123456' } });
    expect((await json(await send('GET', '/api/sync/join-codes/current'))).body.request).toEqual({ name: 'pc-b', os: 'linux', sas: '123456' });
    expect(await json(await send('POST', '/api/sync/join-codes/current/approve'))).toEqual({ status: 200, body: { kind: 'done', name: 'pc-b' } });
    expect(await json(await send('POST', '/api/sync/join-codes/current/reject'))).toEqual({ status: 200, body: { kind: 'idle' } });
    expect(await json(await send('DELETE', '/api/sync/join-codes/current'))).toEqual({ status: 200, body: { kind: 'idle' } });
    expect(a.log).toEqual(['issue', 'approve', 'reject', 'cancel']);
  });

  it('発行の上限は 429、ほかの Worker の失敗は 502 で、文にして返す', async () => {
    const a = fakeApprover();
    app = createApp({ ...deps, joinApprover: () => a });
    a.issueError = new CloudError(429, '{"error":"rate limited"}');
    const r = await json(await send('POST', '/api/sync/join-codes'));
    expect(r).toEqual({ status: 429, body: { error: '参加コードの発行が多すぎます。10 分ほど待ってから、もう一度発行してください' } });
    a.issueError = new CloudError(500, '{"error":"boom"}');
    expect((await send('POST', '/api/sync/join-codes')).status).toBe(502);
  });

  it('リクエストが無いときの承認と、コードが無いときの拒否は 409', async () => {
    const a = fakeApprover();
    app = createApp({ ...deps, joinApprover: () => a });
    a.approveError = new JoinStateError('sync.join.noRequest');
    a.rejectError = new JoinStateError('sync.join.noCode');
    expect(await json(await send('POST', '/api/sync/join-codes/current/approve'))).toEqual({ status: 409, body: { error: '承認できる参加リクエストがありません' } });
    expect(await json(await send('POST', '/api/sync/join-codes/current/reject'))).toEqual({ status: 409, body: { error: '発行中の参加コードがありません' } });
    a.rejectError = new CloudError(500, 'x');
    expect((await send('POST', '/api/sync/join-codes/current/reject')).status).toBe(502);
  });
});

describe('リカバリーキーの再発行（/api/sync/recovery-key）', () => {
  const send = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  function fakeReissuer() {
    const a = {
      log: [] as string[],
      confirmError: null as unknown,
      reissue: async () => {
        a.log.push('reissue');
        return { text: 'hangar リカバリーキー\n作成日: 2026-10-17\nURL: https://h\n暗号鍵: AAAA', draftId: 'd1' };
      },
      confirm: async (draftId: string, tail: string) => {
        a.log.push(`confirm ${draftId} ${tail}`);
        if (a.confirmError) throw a.confirmError;
      },
    };
    return a;
  }

  it('どれも認証の下にある', async () => {
    for (const p of ['/api/sync/recovery-key/reissue', '/api/sync/recovery-key/confirm']) {
      expect((await app.request(p, { method: 'POST' })).status).toBe(401);
    }
  });

  it('同期を設定していなければ 404', async () => {
    app = createApp({ ...deps, recoveryKey: () => null });
    for (const p of ['/api/sync/recovery-key/reissue', '/api/sync/recovery-key/confirm']) {
      const r = await send(p, { draftId: 'd1', tail: 'AAAA' });
      expect(r.status).toBe(404);
      expect((await r.json()).error).toBe('クラウド同期が設定されていません');
    }
  });

  it('再発行は 4 行の文と下書きの ID を返し、キャッシュさせない', async () => {
    const a = fakeReissuer();
    app = createApp({ ...deps, recoveryKey: () => a });
    const r = await send('/api/sync/recovery-key/reissue');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ text: 'hangar リカバリーキー\n作成日: 2026-10-17\nURL: https://h\n暗号鍵: AAAA', draftId: 'd1' });
  });

  it('確認は下書きの ID と末尾 4 文字を渡す。形の違う本文は 400', async () => {
    const a = fakeReissuer();
    app = createApp({ ...deps, recoveryKey: () => a });
    expect(await json(await send('/api/sync/recovery-key/confirm', { draftId: 'd1', tail: 'aaaa' }))).toEqual({ status: 200, body: { ok: true } });
    expect(a.log).toEqual(['confirm d1 aaaa']);
    expect((await send('/api/sync/recovery-key/confirm', { draftId: 'd1' })).status).toBe(400);
    expect((await send('/api/sync/recovery-key/confirm', { draftId: 1, tail: 'aaaa' })).status).toBe(400);
    expect(a.log).toHaveLength(1);
  });

  it('末尾 4 文字が違えば 400、下書きが無ければ 409、Worker の失敗は 502', async () => {
    const a = fakeReissuer();
    app = createApp({ ...deps, recoveryKey: () => a });
    a.confirmError = new RecoveryDraftError('tail-mismatch');
    expect(await json(await send('/api/sync/recovery-key/confirm', { draftId: 'd1', tail: 'ZZZZ' }))).toEqual({ status: 400, body: { error: '暗号鍵の末尾 4 文字が一致しません' } });
    a.confirmError = new RecoveryDraftError('no-draft');
    expect((await send('/api/sync/recovery-key/confirm', { draftId: 'd1', tail: 'ZZZZ' })).status).toBe(409);
    a.confirmError = new CloudError(500, 'x');
    expect((await send('/api/sync/recovery-key/confirm', { draftId: 'd1', tail: 'ZZZZ' })).status).toBe(502);
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
  const URL_ = 'https://w.example';
  const pair = (a: ReturnType<typeof createApp>) => a.request('/api/sync/mobile-pairing', { method: 'POST', headers: { ...H, 'content-type': 'application/json' } });
  type FakeClient = { createPairing?: () => Promise<{ code: string; expiresAt: number }>; lastWorkerCompat: () => number | null; health: () => Promise<{ ok: boolean; version: string }> };
  let watched: { code: string; expiresAt: number }[] = [];
  const withLink = (client: FakeClient) => {
    watched = [];
    return createApp({ ...deps, mobileLink: () => ({ client: client as never, url: URL_, phoneKeys: { current: async () => null, at: async () => null }, pairer: { watch: async (t) => { watched.push(t); } } }) });
  };
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

  it('ready の pairText を decodePairing すると url と券と PC の名前と期限だけが入り、鍵は入らない。券は pairer に渡す', async () => {
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
    expect(blob).toEqual({ url: URL_, code: 'c0de-ticket', pcName: 'mac', expiresAt: 1_700_000_300_000 });
    const inner = JSON.parse(Buffer.from(body.pairText, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(inner).sort()).toEqual(['code', 'expiresAt', 'pcName', 'url']);
    expect(watched).toEqual([{ code: 'c0de-ticket', expiresAt: 1_700_000_300_000 }]);
    // 押すたびに新しい券を取る。
    await pair(a);
    expect(createPairing).toHaveBeenCalledTimes(2);
    expect(watched).toHaveLength(2);
  });
});

describe('端末の解除（POST /api/sync/cloud-devices/:id/revoke）', () => {
  const revoke = (id: string, headers: Record<string, string> = H) => app.request(`/api/sync/cloud-devices/${id}/revoke`, { method: 'POST', headers });
  const row = { id: 'pc-b', kind: 'pc' as const, joinedAt: 1, lastSeenAt: 2, revokedAt: 3, expiresAt: null };

  it('認証の下にあり、同期を設定していなければ 404', async () => {
    expect((await revoke('pc-b', {})).status).toBe(401);
    app = createApp({ ...deps, cloudRevoke: () => null });
    expect((await revoke('pc-b')).status).toBe(404);
  });

  it('解除の道（revokeMember）へ渡し、解除した端末の行を返す', async () => {
    const seen: string[] = [];
    app = createApp({ ...deps, cloudRevoke: () => async (id) => { seen.push(id); return row; } });
    const r = await revoke('pc-b');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await json(r)).toEqual({ status: 200, body: { device: row } });
    expect(seen).toEqual(['pc-b']);
  });

  it('自分自身は 409 の self、一覧に無い端末は 404 の not-found、この PC が解除されていれば 409 の revoked、ほかは 502 で返す', async () => {
    let err: unknown = new RevokeSelfError();
    app = createApp({ ...deps, cloudRevoke: () => async () => { throw err; } });
    expect(await json(await revoke('pc-a'))).toEqual({ status: 409, body: { error: 'この PC 自身はここでは解除できません。「この PC の参加を解除」を使ってください', code: 'self' } });
    err = new RevokeNotFoundError();
    expect(await json(await revoke('pc-z'))).toMatchObject({ status: 404, body: { code: 'not-found' } });
    err = new RevokedError();
    expect(await json(await revoke('pc-b'))).toMatchObject({ status: 409, body: { code: 'revoked' } });
    err = new CloudError(500, '{"error":"boom"}');
    expect(await json(await revoke('pc-b'))).toMatchObject({ status: 502, body: { code: 'unreachable' } });
  });
});
