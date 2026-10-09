import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@agent-hangar/shared';
import { UsageTracker } from '../../usage/statusline.ts';
import { SESSION_ALPHA } from '../../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { H, READY, testDeps, type TestWorld } from '../testing.ts';

// 使用量の経路（routes/usage.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let sent: ServerEvent[];
let usage: UsageTracker;
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  t = await testDeps();
  ({ usage } = t);
  sent = t.events;
  app = createApp(t.deps);
});
afterEach(() => { t.dispose(); });

describe('routes', () => {
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const alphaId = async () => { const { body } = await json(await get('/api/sessions')); return body.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA).id as string; };

  it('statusline の受け口と使用量', async () => {
    const first = { session_id: SESSION_ALPHA, model: { id: 'claude-opus-4-1' }, effort: 'high', context_window: { context_window_size: 200000, current_usage: null } };
    expect((await post('/api/ingest/statusline', first)).status).toBe(204);
    expect(sent.filter((e) => e.type === 'accounts.update')).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { providerSessionId: SESSION_ALPHA, stats: { model: 'claude-opus-4-1' } } });
    const second = { ...first, context_window: { context_window_size: 200000, current_usage: { input_tokens: 50000 } }, rate_limits: { five_hour: { used_percentage: 47, resets_at: 4_000_000_000 }, seven_day: { used_percentage: 7, resets_at: 4_000_100_000 } } };
    expect((await post('/api/ingest/statusline', second)).status).toBe(204);
    expect(sent.find((e) => e.type === 'accounts.update')).toMatchObject({ accounts: { accounts: [{ id: 'primary', usage: { fiveHour: { usedPercent: 47 }, sevenDay: { usedPercent: 7 } } }] } });
    expect((await json(await get('/api/usage'))).body).toMatchObject({ fiveHour: { usedPercent: 47 } });
    expect((await json(await get(`/api/sessions/${await alphaId()}`))).body.stats.contextPercent).toBe(25);
    expect((await app.request('/api/ingest/statusline', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: 'not json' })).status).toBe(400);
    // 認証は他の /api と同じ。トークンが無ければ受け付けない。
    expect((await app.request('/api/ingest/statusline', { method: 'POST', body: '{}' })).status).toBe(401);
    // 集計は今日から遡る窓で数えるので、時計を fixture の日付（2026-09-01）の近くに止めて測る。
    // 止めないと、fixture から 30 日を過ぎた日にこの試験だけが落ちる。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T12:00:00'));
    try {
      const agg = await json(await get('/api/usage/aggregate?days=30'));
      expect(agg.status).toBe(200);
      expect(agg.body.projects.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
    expect((await get('/api/usage/aggregate?days=0')).status).toBe(400);
    expect((await json(await get('/api/statusline'))).body).toEqual({ command: null, scriptPath: null, installed: false });
    expect((await json(await get('/api/shell-hook'))).body).toEqual({ state: 'off', zshrc: '/Users/me/.zshrc', line: 'x  # agent-hangar', command: 'hangar shell install' });
    // 準備の確かめは 1 つの読み取りにまとめてある。設定画面と空のホームが同じものを読む。
    expect((await json(await get('/api/readiness'))).body).toEqual(READY);
    expect((await json(await get('/api/bootstrap'))).body).toMatchObject({ accounts: { accounts: [{ id: 'primary', usage: { fiveHour: { usedPercent: 47 } } }] }, todos: [], artifacts: [], summaryPending: ['pending-1'] });
  });
});

// 経路は行を書くだけで、画面へのイベントは配る層（events/publisher.ts）が組む。
// 書いた行のイベントが、1 回だけ、最新の中身で届くことを経路ごとに押さえる。
describe('書いた行のイベントは配る層から届く', () => {
  const send = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  describe('セッション', () => {

    it('statusline を受けると、そのセッションの session.upsert が 1 回だけ届く。知らないセッションでは届かない', async () => {
      const body = { session_id: SESSION_ALPHA, model: { id: 'claude-opus-4-1' }, effort: 'high', context_window: { context_window_size: 200000, current_usage: null } };
      await send('/api/ingest/statusline', body);
      expect(sent).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ providerSessionId: SESSION_ALPHA, stats: expect.objectContaining({ model: 'claude-opus-4-1' }) }) }]);
      sent.length = 0;
      await send('/api/ingest/statusline', { ...body, session_id: 'no-such-session' });
      expect(sent).toEqual([]);
    });
  });
});
