import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertShared } from '../../db/shared.ts';
import { addUnread } from '../../live/unread.ts';
import { SESSION_ALPHA } from '../../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// サイドバーの右クリックの 3 つ（未読に戻す、ピン留め、複製）がサーバで使う口の試験。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
const alphaId = () => (t.db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
const post = (path: string, body: unknown = {}) => app.request(path, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const dto = async (id: string) => (await app.request(`/api/sessions/${id}`, { headers: H })).json();

beforeEach(async () => { t = await testDeps(); app = createApp(t.deps); });
afterEach(() => { t.dispose(); });

describe('POST /api/sessions/:id/unread', () => {
  it('未読が無ければ 1 にする。本文は持たない', async () => {
    expect((await post(`/api/sessions/${alphaId()}/unread`)).status).toBe(204);
    expect((await dto(alphaId())).unread).toMatchObject({ count: 1, latest: null });
  });
  it('すでに未読があれば、数も本文も変えない', async () => {
    addUnread(t.db, alphaId(), '通った', 20);
    expect((await post(`/api/sessions/${alphaId()}/unread`)).status).toBe(204);
    expect((await dto(alphaId())).unread).toEqual({ count: 1, latest: '通った', at: 20 });
  });
  it('知らない id は 404', async () => {
    expect((await post('/api/sessions/nope/unread')).status).toBe(404);
  });
});

describe('POST /api/sessions/:id/pin', () => {
  it('留めると pinnedAt が付き、外すと null に戻る', async () => {
    expect((await dto(alphaId())).pinnedAt ?? null).toBeNull();
    expect((await post(`/api/sessions/${alphaId()}/pin`, { pinned: true })).status).toBe(204);
    expect(typeof (await dto(alphaId())).pinnedAt).toBe('number');
    expect((await post(`/api/sessions/${alphaId()}/pin`, { pinned: false })).status).toBe(204);
    expect((await dto(alphaId())).pinnedAt).toBeNull();
  });
  it('真偽でない本文は 400、知らない id は 404', async () => {
    expect((await post(`/api/sessions/${alphaId()}/pin`, { pinned: 'yes' })).status).toBe(400);
    expect((await post('/api/sessions/nope/pin', { pinned: true })).status).toBe(404);
  });
});

describe('GET /api/sessions/:id/launch-settings', () => {
  const run = (id: string, at: number, params: unknown, device = t.deps.deviceId) => upsertShared(t.db, 'runs', { id, session_id: alphaId(), device_id: device, kind: 'start', tmux_name: id, pid: null, launch_params: JSON.stringify(params), started_at: at, ended_at: at + 1, end_reason: null, heartbeat_at: at }, device);
  const get = async () => (await app.request(`/api/sessions/${alphaId()}/launch-settings`, { headers: H })).json();
  it('run が無ければ、エージェントだけを返す', async () => {
    expect(await get()).toEqual({ agent: 'claude-code', model: null, effort: null, permissionMode: null, mode: null, addDirs: [], account: null });
  });
  it('指定のない再開の run を飛ばし、最後に指定した起動の値を返す', async () => {
    run('r1', 100, { model: 'opus', effort: 'high', permissionMode: 'plan', addDirs: ['/x'], prompt: '消す', worktree: 'w' });
    run('r2', 200, { prompt: 'つづき' });
    expect(await get()).toEqual({ agent: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'plan', mode: null, addDirs: ['/x'], account: null });
  });
  it('アカウントはこの PC の run からだけ読む', async () => {
    run('r1', 100, { model: 'opus', account: 'here' });
    run('r2', 200, { model: 'sonnet', account: 'other' }, 'other-pc');
    expect(await get()).toMatchObject({ model: 'sonnet', account: 'here' });
  });
  it('壊れた JSON の run は無いものとして読む', async () => {
    t.db.prepare("insert into runs (id, session_id, device_id, kind, tmux_name, launch_params, started_at, heartbeat_at, updated_at, origin_device) values ('r9', ?, 'd', 'start', 'r9', '{', 900, 900, 900, 'd')").run(alphaId());
    expect(await get()).toMatchObject({ model: null });
  });
  it('知らない id は 404', async () => {
    expect((await app.request('/api/sessions/nope/launch-settings', { headers: H })).status).toBe(404);
  });
});
