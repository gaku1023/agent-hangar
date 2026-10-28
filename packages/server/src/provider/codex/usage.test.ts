import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../db/open.ts';
import { AgentUsageTracker } from '../../usage/agentUsage.ts';
import type { CodexRpc, CodexNotification } from './appServer.ts';
import { codexRateLimitsOf, codexRolloutRateLimitsOf, codexTokenUsageOf, createCodexUsage } from './usage.ts';

// 本物の app-server（0.164.0、ChatGPT Plus）の account/rateLimits/read の応答の形を、値を合成して写した。
const REAL_READ = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex', limitName: null, normalModelSlug: null,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793040104 },
    secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1793626904 },
    credits: { hasCredits: false, unlimited: false, balance: '0E-10' },
    individualLimit: null, spendControlReached: false, planType: 'plus', rateLimitReachedType: null,
  },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793040104 }, secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1793626904 }, planType: 'plus' } },
  rateLimitResetCredits: { availableCount: 2, credits: [] },
};

describe('app-server の枠の読み', () => {
  it('primary は 300 分で 5 時間、secondary は 10080 分で週。resetsAt の秒はミリ秒にする', () => {
    expect(codexRateLimitsOf(REAL_READ.rateLimits)).toEqual({
      fiveHour: { usedPercent: 12, resetsAt: 1793040104000 }, sevenDay: { usedPercent: 34, resetsAt: 1793626904000 }, plan: 'plus',
    });
  });
  it('窓の長さで決める。長さが逆の並びでも取り違えない', () => {
    const r = codexRateLimitsOf({ primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 5 }, secondary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 6 } });
    expect(r).toMatchObject({ fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } });
  });
  it('長さが無ければ primary を 5 時間、secondary を週とみなす。resetsAt が無ければ null', () => {
    expect(codexRateLimitsOf({ primary: { usedPercent: 3 }, secondary: { usedPercent: 4, resetsAt: null } })).toEqual({
      fiveHour: { usedPercent: 3, resetsAt: null }, sevenDay: { usedPercent: 4, resetsAt: null }, plan: null,
    });
  });
  it('窓が 1 つも読めなければ null', () => {
    expect(codexRateLimitsOf({ primary: null, secondary: null })).toBeNull();
    expect(codexRateLimitsOf(undefined)).toBeNull();
    expect(codexRateLimitsOf({ primary: { usedPercent: 'x' } })).toBeNull();
  });
});

describe('rollout の枠の読み（B5 の meta rate_limits）', () => {
  const rl = { limit_id: 'codex', primary: { used_percent: 7.5, window_minutes: 300, resets_at: 1793040104 }, secondary: { used_percent: 2, window_minutes: 10080, resets_at: 1793626904 }, credits: {}, plan_type: 'plus' };
  it('meta の値から窓と plan を読み、観測の時刻は行の ts にする', () => {
    expect(codexRolloutRateLimitsOf({ rate_limits: rl, model_context_window: 258400 }, '2026-10-27T01:00:00.000Z')).toEqual({
      fiveHour: { usedPercent: 7.5, resetsAt: 1793040104000 }, sevenDay: { usedPercent: 2, resetsAt: 1793626904000 }, plan: 'plus', at: Date.parse('2026-10-27T01:00:00.000Z'),
    });
  });
  it('ts が読めなければ at は null', () => {
    expect(codexRolloutRateLimitsOf({ rate_limits: rl }, 'bad')?.at).toBeNull();
    expect(codexRolloutRateLimitsOf({}, 1)).toBeNull();
  });
});

describe('thread/tokenUsage/updated の読み', () => {
  const p = { threadId: 't1', turnId: 'u1', tokenUsage: { total: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 50, reasoningOutputTokens: 10, totalTokens: 950 }, last: { inputTokens: 300, cachedInputTokens: 200, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 320 }, modelContextWindow: 258400 } };
  it('文脈の量は最後の呼び出しの input（cached を含む。B5 の rollout と同じ）、大きさは modelContextWindow', () => {
    expect(codexTokenUsageOf(p)).toEqual({ threadId: 't1', contextUsed: 300, contextSize: 258400 });
  });
  it('last が無い、数でないときは null', () => {
    expect(codexTokenUsageOf({ threadId: 't', tokenUsage: {} })).toBeNull();
    expect(codexTokenUsageOf({ tokenUsage: p.tokenUsage })).toBeNull();
  });
  it('modelContextWindow が null なら大きさは null', () => {
    expect(codexTokenUsageOf({ ...p, tokenUsage: { ...p.tokenUsage, modelContextWindow: null } })?.contextSize).toBeNull();
  });
});

/** 接続のふり。request の答えと通知を手で流す。 */
class Stub {
  isClosed = false;
  requests: string[] = [];
  answer: () => unknown = () => REAL_READ;
  private any = new Set<(n: CodexNotification) => void>();
  private closers = new Set<() => void>();
  async request<T>(method: string): Promise<T> { this.requests.push(method); return this.answer() as T; }
  onAny(h: (n: CodexNotification) => void): () => void { this.any.add(h); return () => this.any.delete(h); }
  onClose(h?: () => void): void { if (h) this.closers.add(h); }
  emit(method: string, params: unknown): void { for (const h of [...this.any]) h({ method, params }); }
  close(): void { this.isClosed = true; for (const h of [...this.closers]) h(); }
}
const asRpc = (s: Stub): Pick<CodexRpc, 'request' | 'onAny' | 'onClose' | 'isClosed'> => s as never;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('CodexUsage（接続の通知から枠と会話の値を取る）', () => {
  const setup = (enabled = true) => {
    const db = openDb(':memory:');
    const tracker = new AgentUsageTracker({ now: () => 1793000000000, enabled: () => enabled });
    const touched: string[] = [];
    const usage = createCodexUsage({ db, tracker, enabled: () => enabled, now: () => 1793000000000, onStats: (id) => touched.push(id) });
    return { db, tracker, usage, touched };
  };
  const stats = (db: ReturnType<typeof openDb>, id: string) => db.prepare('select model, effort, context_used, context_size, cost_usd from session_live_stats where provider_session_id = ?').get(id);

  it('track で account/rateLimits/read を 1 回読み、枠を入れる', async () => {
    const { tracker, usage } = setup();
    const rpc = new Stub();
    usage.track({ providerSessionId: 't1', rpc: asRpc(rpc), model: 'gpt-5.6-luna' });
    await tick();
    expect(rpc.requests).toEqual(['account/rateLimits/read']);
    expect(tracker.of('codex')).toMatchObject({ fiveHour: { usedPercent: 12 }, sevenDay: { usedPercent: 34 }, plan: 'plus' });
  });
  it('account/rateLimits/updated の疎な通知を、前の値に重ねる', async () => {
    const { tracker, usage } = setup();
    const rpc = new Stub();
    usage.track({ providerSessionId: 't1', rpc: asRpc(rpc) });
    await tick();
    rpc.emit('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1793050000 }, secondary: null, planType: null } });
    expect(tracker.of('codex')).toMatchObject({ fiveHour: { usedPercent: 40, resetsAt: 1793050000000 }, sevenDay: { usedPercent: 34 }, plan: 'plus' });
  });
  it('codex 以外の limit_id の通知（別枠）は取らない', async () => {
    const { tracker, usage } = setup();
    const rpc = new Stub();
    usage.track({ providerSessionId: 't1', rpc: asRpc(rpc) });
    await tick();
    rpc.emit('account/rateLimits/updated', { rateLimits: { limitId: 'codex_other', primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1 } } });
    expect(tracker.of('codex')?.fiveHour?.usedPercent).toBe(12);
  });
  it('thread/tokenUsage/updated を session_live_stats に書き、会話を名指しして知らせる', async () => {
    const { db, usage, touched } = setup();
    const rpc = new Stub();
    usage.track({ providerSessionId: 't1', rpc: asRpc(rpc), model: 'gpt-5.6-luna' });
    await tick();
    rpc.emit('thread/tokenUsage/updated', { threadId: 't1', turnId: 'u', tokenUsage: { last: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 301 }, total: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 301 }, modelContextWindow: 258400 } });
    expect(stats(db, 't1')).toEqual({ model: 'gpt-5.6-luna', effort: null, context_used: 300, context_size: 258400, cost_usd: null });
    expect(touched).toEqual(['t1']);
  });
  it('別の thread の通知は、この会話に書かない', async () => {
    const { db, usage } = setup();
    const rpc = new Stub();
    usage.track({ providerSessionId: 't1', rpc: asRpc(rpc) });
    await tick();
    rpc.emit('thread/tokenUsage/updated', { threadId: 'other', turnId: 'u', tokenUsage: { last: { inputTokens: 5 }, total: {}, modelContextWindow: 10 } });
    expect(stats(db, 'other')).toBeUndefined();
  });
  it('1 回目の値が null の項目は、前の値を保つ（大きさが無い通知）', async () => {
    const { db, usage } = setup();
    const rpc = new Stub();
    usage.track({ providerSessionId: 't1', rpc: asRpc(rpc), model: 'm' });
    await tick();
    const u = (input: number, w: number | null) => ({ threadId: 't1', turnId: 'u', tokenUsage: { last: { inputTokens: input, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: input }, total: {}, modelContextWindow: w } });
    rpc.emit('thread/tokenUsage/updated', u(100, 1000));
    rpc.emit('thread/tokenUsage/updated', u(200, null));
    expect(stats(db, 't1')).toMatchObject({ context_used: 200, context_size: 1000 });
  });
  it('切のときは、何も読まず、何も書かない', async () => {
    const { db, tracker, usage } = setup(false);
    const rpc = new Stub();
    usage.track({ providerSessionId: 't1', rpc: asRpc(rpc) });
    await tick();
    expect(rpc.requests).toEqual([]);
    rpc.emit('thread/tokenUsage/updated', { threadId: 't1', turnId: 'u', tokenUsage: { last: { inputTokens: 5 }, total: {}, modelContextWindow: 10 } });
    expect(stats(db, 't1')).toBeUndefined();
    expect(tracker.all()).toBeUndefined();
  });
  it('読めなくても落ちない。untrack と接続の閉じで読みを外す', async () => {
    const { db, usage } = setup();
    const rpc = new Stub();
    rpc.answer = () => { throw new Error('boom'); };
    const log = vi.fn();
    const u2 = createCodexUsage({ db, tracker: new AgentUsageTracker(), log });
    u2.track({ providerSessionId: 't1', rpc: asRpc(rpc) });
    await tick();
    expect(log).toHaveBeenCalled();
    const r2 = new Stub();
    usage.track({ providerSessionId: 't2', rpc: asRpc(r2) });
    await tick();
    usage.untrack('t2');
    r2.emit('thread/tokenUsage/updated', { threadId: 't2', turnId: 'u', tokenUsage: { last: { inputTokens: 5 }, total: {}, modelContextWindow: 10 } });
    expect(stats(db, 't2')).toBeUndefined();
  });
  it('外の会話の rollout の枠を入れる（B5 の口）。いちばん新しいものが残る', () => {
    const { tracker, usage } = setup();
    const rl = (u: number) => ({ rate_limits: { primary: { used_percent: u, window_minutes: 300, resets_at: 1793040104 }, secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1793626904 }, plan_type: 'plus' } });
    usage.noteRolloutRateLimits(rl(50), '2026-10-27T02:00:00.000Z');
    usage.noteRolloutRateLimits(rl(10), '2026-10-27T01:00:00.000Z');
    expect(tracker.of('codex')?.fiveHour?.usedPercent).toBe(50);
  });
  it('hangar が起こした会話の枠は、その会話のアカウントに付く（渡されなければ primary）', async () => {
    const { tracker, usage } = setup();
    const r = new Stub();
    usage.track({ providerSessionId: 'tA', rpc: asRpc(r), accountId: 'work' });
    await tick();
    r.emit('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 1793040104 } } });
    expect(tracker.of('codex', 'work')?.fiveHour?.usedPercent).toBe(33);
    expect(tracker.of('codex')).toBeNull();
  });
  it('外の rollout は creator_account_id で振り、表にあって引けなければ捨てる', () => {
    const tracker = new AgentUsageTracker({ now: () => 1793000000000 });
    const table = new Map([['cg-1', 'primary'], ['cg-2', 'work']]);
    const usage = createCodexUsage({ db: openDb(':memory:'), tracker, now: () => 1793000000000, accountOfChatgptId: (c) => table.get(c) ?? null });
    const rl = (u: number) => ({ rate_limits: { primary: { used_percent: u, window_minutes: 300, resets_at: 1793040104 } } });
    usage.noteRolloutRateLimits(rl(20), '2026-10-27T02:00:00.000Z', 'cg-2');
    usage.noteRolloutRateLimits(rl(90), '2026-10-27T02:00:00.000Z', 'cg-x');
    usage.noteRolloutRateLimits(rl(91), '2026-10-27T02:00:00.000Z', null);
    expect(tracker.of('codex', 'work')?.fiveHour?.usedPercent).toBe(20);
    expect(tracker.of('codex')).toBeNull();
  });
});
