import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertShared } from '../../db/shared.ts';
import { getRun } from '../../runs/queries.ts';
import { recordInterruption } from '../../runs/interrupted.ts';
import { SESSION_ALPHA } from '../../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 中断の群（ホームの帯の「前回実行中」）と、同じファイルの編集の「このファイルでは表示しない」の経路の試験。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
const post = (p: string, body: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const alphaId = () => (t.db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;

beforeEach(async () => {
  t = await testDeps();
  app = createApp(t.deps);
  upsertShared(t.db, 'runs', { id: 'lost1', session_id: alphaId(), device_id: 'd', kind: 'resume', tmux_name: 'hangar-lost1', pid: null, launch_params: '{}', started_at: 1, ended_at: 20, end_reason: 'lost', heartbeat_at: 1 }, 'd');
});
afterEach(() => { t.dispose(); });

describe('中断の群', () => {
  it('bootstrap は中断の群を載せる。無ければ null', async () => {
    expect((await (await app.request('/api/bootstrap', { headers: H })).json()).interrupted).toBeNull();
    recordInterruption(t.db, [getRun(t.db, 'lost1')!], 'restart', 30);
    const body = await (await app.request('/api/bootstrap', { headers: H })).json();
    expect(body.interrupted).toEqual({ at: 30, cause: 'restart', items: [{ sessionId: alphaId(), runId: 'lost1', lastLive: null, endedAt: 20, account: null }] });
  });

  it('再開しないと決めた行を除いて配り、元に戻せば戻る', async () => {
    recordInterruption(t.db, [getRun(t.db, 'lost1')!], 'restart', 30);
    const r = await post('/api/interrupted/dismiss', { runIds: ['lost1'], dismissed: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ interrupted: null });
    expect(t.events).toContainEqual({ type: 'interrupted.update', interrupted: null });
    const back = await (await post('/api/interrupted/dismiss', { runIds: ['lost1'], dismissed: false })).json();
    expect(back.interrupted.items).toHaveLength(1);
  });

  it('形の違う本文は 400', async () => {
    expect((await post('/api/interrupted/dismiss', { runIds: 'lost1', dismissed: true })).status).toBe(400);
    expect((await post('/api/interrupted/dismiss', { runIds: [1], dismissed: true })).status).toBe(400);
    expect((await post('/api/interrupted/dismiss', { runIds: ['lost1'] })).status).toBe(400);
  });
});

describe('同じファイルの編集', () => {
  it('「このファイルでは表示しない」を組とパスで覚え、見張りに読み直させる', async () => {
    const refresh = vi.fn();
    t.dispose();
    t = await testDeps({ overlapRefresh: refresh });
    app = createApp(t.deps);
    const r = await post(`/api/sessions/${alphaId()}/overlap/dismiss`, { with: 'zzz', paths: ['/w/a.ts', '/w/b.ts'] });
    expect(r.status).toBe(204);
    expect(t.db.prepare('select session_a, session_b, path from overlap_dismissals order by path').all()).toEqual([
      { session_a: alphaId(), session_b: 'zzz', path: '/w/a.ts' },
      { session_a: alphaId(), session_b: 'zzz', path: '/w/b.ts' },
    ]);
    expect(refresh).toHaveBeenCalledOnce();
    expect((await post(`/api/sessions/${alphaId()}/overlap/dismiss`, { with: 'zzz', paths: [] })).status).toBe(400);
    expect((await post(`/api/sessions/${alphaId()}/overlap/dismiss`, { paths: ['/w/a.ts'] })).status).toBe(400);
  });
});
