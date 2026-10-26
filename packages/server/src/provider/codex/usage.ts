import type { RateWindowDto } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { resetsAtMs } from '../claude-code/compat/statusline.ts';
import type { AgentUsageTracker, AgentWindows } from '../../usage/agentUsage.ts';
import type { CodexNotification, CodexRpc } from './appServer.ts';

/**
 * Codex の使用量の面（docs/design.md「Codex の使用量」）。
 *
 * - ChatGPT のプランの枠（5 時間と週）：hangar が起こした会話は app-server の `account/rateLimits/read`（接続したとき 1 回）と
 *   通知 `account/rateLimits/updated`（ターン中に届く疎な更新）から、hangar の外の会話は rollout の `token_count.rate_limits`（B5 の meta rate_limits）から取る。
 * - 会話のコンテキストとトークン：`thread/tokenUsage/updated` から session_live_stats（opencode と同じ欄）へ。
 *
 * 窓は長さで決める（300 分が 5 時間、10080 分が週）。長さが無ければ primary を 5 時間、secondary を週とみなす。
 * resets_at は epoch 秒で、ミリ秒に直して持つ（Claude の枠と同じ）。
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const FIVE_HOUR_MINS = 300;
const WEEK_MINS = 10080;

type Win = { w: RateWindowDto; mins: number | null };
function windowOf(v: unknown, usedKey: string, minsKey: string, resetsKey: string): Win | null {
  if (!isRec(v)) return null;
  const used = num(v[usedKey]);
  if (used === null) return null;
  const resets = num(v[resetsKey]);
  return { w: { usedPercent: used, resetsAt: resets === null ? null : resetsAtMs(resets) }, mins: num(v[minsKey]) };
}

/** primary と secondary を、窓の長さで 5 時間と週に割り振る。 */
function assign(p: Win | null, s: Win | null, plan: string | null): AgentWindows | null {
  let fiveHour: RateWindowDto | null = null;
  let sevenDay: RateWindowDto | null = null;
  const put = (x: Win | null, fallback: 'five' | 'week'): void => {
    if (!x) return;
    const kind = x.mins === null ? fallback : x.mins >= WEEK_MINS ? 'week' : x.mins <= FIVE_HOUR_MINS ? 'five' : fallback;
    if (kind === 'five') fiveHour ??= x.w;
    else sevenDay ??= x.w;
  };
  put(p, 'five');
  put(s, 'week');
  return fiveHour === null && sevenDay === null ? null : { fiveHour, sevenDay, plan };
}

/** app-server の RateLimitSnapshot（`account/rateLimits/read` の rateLimits、通知の rateLimits）を読む。窓が 1 つも読めなければ null。 */
export function codexRateLimitsOf(snapshot: unknown): AgentWindows | null {
  if (!isRec(snapshot)) return null;
  return assign(
    windowOf(snapshot.primary, 'usedPercent', 'windowDurationMins', 'resetsAt'),
    windowOf(snapshot.secondary, 'usedPercent', 'windowDurationMins', 'resetsAt'),
    str(snapshot.planType),
  );
}

/**
 * rollout の meta rate_limits（B5 の `{ rate_limits, model_context_window }`）を読む。
 * at はその行の ts（ISO の文字列か epoch ミリ秒）で、読めなければ null。
 */
export function codexRolloutRateLimitsOf(value: unknown, ts: unknown): (AgentWindows & { at: number | null }) | null {
  const rl = isRec(value) ? value.rate_limits : undefined;
  if (!isRec(rl)) return null;
  const w = assign(
    windowOf(rl.primary, 'used_percent', 'window_minutes', 'resets_at'),
    windowOf(rl.secondary, 'used_percent', 'window_minutes', 'resets_at'),
    str(rl.plan_type),
  );
  if (!w) return null;
  const at = typeof ts === 'number' && Number.isFinite(ts) ? ts : typeof ts === 'string' && Number.isFinite(Date.parse(ts)) ? Date.parse(ts) : null;
  return { ...w, at };
}

/**
 * `thread/tokenUsage/updated` の読み。文脈の量は最後の呼び出しの input（cached を含む量。B5 が rollout から書く値と同じ）、
 * 大きさは modelContextWindow。読めなければ null。
 */
export function codexTokenUsageOf(params: unknown): { threadId: string; contextUsed: number; contextSize: number | null } | null {
  if (!isRec(params) || typeof params.threadId !== 'string') return null;
  const u = isRec(params.tokenUsage) ? params.tokenUsage : null;
  const last = u && isRec(u.last) ? u.last : null;
  const used = last ? num(last.inputTokens) : null;
  if (used === null || used < 0) return null;
  const size = u ? num(u.modelContextWindow) : null;
  return { threadId: params.threadId, contextUsed: used, contextSize: size !== null && size > 0 ? size : null };
}

/** 接続の口。CodexRpc の一部。 */
export type CodexUsageRpc = Pick<CodexRpc, 'request' | 'onAny' | 'onClose' | 'isClosed'>;

export type CodexUsageTarget = {
  providerSessionId: string;
  rpc: CodexUsageRpc;
  /** 会話のモデル（thread/start の応答など、起こした側が知っているもの）。session_live_stats の model に書く。 */
  model?: string | null;
};

export type CodexUsageOptions = {
  db: Db;
  tracker: AgentUsageTracker;
  /** 設定「Codex を有効にする」。切の間は何も読まず、何も書かない。 */
  enabled?: () => boolean;
  /** 会話の値を書いたとき、その会話（provider_session_id）を名指しして画面へ知らせる。 */
  onStats?: (providerSessionId: string) => void;
  now?: () => number;
  log?: (line: string) => void;
};

export type CodexUsage = {
  /** 会話の接続を読み始める。枠は account/rateLimits/read を 1 回読み、通知で重ねる。 */
  track(t: CodexUsageTarget): void;
  untrack(providerSessionId: string): void;
  /** 外の会話の rollout の枠を入れる（B5 の meta rate_limits の value と ts）。 */
  noteRolloutRateLimits(value: unknown, ts: unknown): void;
};

/** 会話の今の値を書く。null の項目は前の値を保つ（Claude の statusline と同じ）。 */
export function writeCodexLiveStats(db: Db, providerSessionId: string, v: { model: string | null; contextUsed: number | null; contextSize: number | null }, now: number): void {
  db.prepare(`insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)
    on conflict(provider_session_id) do update set model = coalesce(excluded.model, session_live_stats.model),
      context_used = coalesce(excluded.context_used, session_live_stats.context_used), context_size = coalesce(excluded.context_size, session_live_stats.context_size),
      updated_at = excluded.updated_at`)
    .run(providerSessionId, v.model, null, v.contextUsed, v.contextSize, null, now);
}

export function createCodexUsage(o: CodexUsageOptions): CodexUsage {
  const now = o.now ?? Date.now;
  const enabled = o.enabled ?? (() => true);
  const offs = new Map<string, (() => void)[]>();

  const putLimits = (snapshot: unknown): void => {
    // 別の枠（limit_id が codex でないもの）は、5 時間と週の枠ではない。
    if (isRec(snapshot) && typeof snapshot.limitId === 'string' && snapshot.limitId !== 'codex') return;
    const w = codexRateLimitsOf(snapshot);
    if (w) o.tracker.set('codex', w, now());
  };

  const release = (id: string): void => {
    for (const off of offs.get(id) ?? []) off();
    offs.delete(id);
  };

  return {
    track(t) {
      if (!enabled() || t.rpc.isClosed) return;
      release(t.providerSessionId);
      const id = t.providerSessionId;
      const on = t.rpc.onAny((n: CodexNotification) => {
        if (!enabled()) return;
        if (n.method === 'account/rateLimits/updated') {
          putLimits(isRec(n.params) ? n.params.rateLimits : undefined);
        } else if (n.method === 'thread/tokenUsage/updated') {
          const u = codexTokenUsageOf(n.params);
          if (!u || u.threadId !== id) return;
          writeCodexLiveStats(o.db, id, { model: t.model ?? null, contextUsed: u.contextUsed, contextSize: u.contextSize }, now());
          o.onStats?.(id);
        }
      });
      offs.set(id, [on]);
      t.rpc.onClose(() => release(id));
      // 起こしたときの 1 回。ターンが無くても読める。読めなくても、通知で埋まる。
      void t.rpc.request<{ rateLimits?: unknown; rateLimitsByLimitId?: unknown }>('account/rateLimits/read', null).then(
        (r) => {
          if (!enabled() || !isRec(r)) return;
          const byId = isRec(r.rateLimitsByLimitId) ? r.rateLimitsByLimitId.codex : undefined;
          putLimits(byId ?? r.rateLimits);
        },
        (e: unknown) => o.log?.(`[codex] account/rateLimits/read failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    },
    untrack: release,
    noteRolloutRateLimits(value, ts) {
      if (!enabled()) return;
      const r = codexRolloutRateLimitsOf(value, ts);
      if (r) o.tracker.set('codex', { fiveHour: r.fiveHour, sevenDay: r.sevenDay, plan: r.plan }, r.at ?? now());
    },
  };
}
