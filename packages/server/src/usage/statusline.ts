import type { RateWindowDto, UsageDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

// Claude Code が statusLine コマンドの標準入力に渡す JSON を読む。
// 形はフェーズ 0 の spike 04 で観察したもので、無い項目は null にする。

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export type StatuslinePayload = {
  providerSessionId: string | null; model: string | null; effort: string | null;
  contextUsed: number | null; contextSize: number | null; costUsd: number | null;
  rateLimits: { fiveHour: RateWindowDto | null; sevenDay: RateWindowDto | null } | null;
};

function window_(v: unknown): RateWindowDto | null {
  if (!isRec(v)) return null;
  const used = num(v.used_percentage);
  if (used === null) return null;
  const resets = num(v.resets_at);
  // resets_at は秒の UNIX 時刻。
  return { usedPercent: used, resetsAt: resets === null ? null : resets * 1000 };
}

/**
 * current_usage はトークン数のオブジェクトか、数値か、null。
 * 入力側のトークンの項目を 1 つも持たないときは 0 ではなく null を返す。
 * 0 を返すと session_live_stats の coalesce が既存の値を 0 で上書きしてしまう。
 */
function contextUsed(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (!isRec(v)) return null;
  const parts = [num(v.input_tokens), num(v.cache_creation_input_tokens), num(v.cache_read_input_tokens)];
  if (parts.every((n) => n === null)) return null;
  return parts.reduce<number>((a, n) => a + (n ?? 0), 0);
}

export function parseStatusline(raw: unknown): StatuslinePayload | null {
  if (!isRec(raw)) return null;
  const model = isRec(raw.model) ? str(raw.model.id) ?? str(raw.model.display_name) : str(raw.model);
  const cw = isRec(raw.context_window) ? raw.context_window : null;
  const cost = isRec(raw.cost) ? num(raw.cost.total_cost_usd) : null;
  const rl = isRec(raw.rate_limits) ? raw.rate_limits : null;
  const rateLimits = rl ? { fiveHour: window_(rl.five_hour), sevenDay: window_(rl.seven_day) } : null;
  return {
    providerSessionId: str(raw.session_id), model, effort: str(raw.effort),
    contextUsed: cw ? contextUsed(cw.current_usage) : null, contextSize: cw ? num(cw.context_window_size) : null, costUsd: cost,
    rateLimits: rateLimits && (rateLimits.fiveHour || rateLimits.sevenDay) ? rateLimits : null,
  };
}

const sameWindow = (a: RateWindowDto | null, b: RateWindowDto | null) => a?.usedPercent === b?.usedPercent && a?.resetsAt === b?.resetsAt;

export type IngestResult = { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null };

/**
 * 使用率の現在値を持ち、payload を積む。
 * 使用率は Claude のセッションが動いている間だけ届くので、値が無い payload では直前の値を保つ。
 */
export class UsageTracker {
  private state: UsageDto = { fiveHour: null, sevenDay: null, updatedAt: null };
  private lastAt = 0;
  private readonly now: () => number;
  private readonly keep: number;

  constructor(private readonly db: Db, opts: { now?: () => number; keep?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.keep = opts.keep ?? 500;
    this.restore();
  }

  current(): UsageDto { return this.state; }

  /** 新しい順に読み、両方の窓が埋まるか行が尽きるまで辿る。 */
  private restore(): void {
    const rows = this.db.prepare('select at, payload from usage_snapshots order by at desc limit ?').all(this.keep) as { at: number; payload: string }[];
    for (const r of rows) {
      let p: StatuslinePayload | null = null;
      try { p = parseStatusline(JSON.parse(r.payload)); } catch { continue; }
      if (!p?.rateLimits) continue;
      if (this.state.fiveHour === null && p.rateLimits.fiveHour) this.state = { ...this.state, fiveHour: p.rateLimits.fiveHour, updatedAt: this.state.updatedAt ?? r.at };
      if (this.state.sevenDay === null && p.rateLimits.sevenDay) this.state = { ...this.state, sevenDay: p.rateLimits.sevenDay, updatedAt: this.state.updatedAt ?? r.at };
      if (this.state.fiveHour && this.state.sevenDay) break;
    }
    this.lastAt = (this.db.prepare('select max(at) at from usage_snapshots').get() as { at: number | null }).at ?? 0;
  }

  ingest(raw: unknown): IngestResult | null {
    const p = parseStatusline(raw);
    if (!p) return null;
    const at = Math.max(this.now(), this.lastAt + 1);
    this.lastAt = at;
    const write = this.db.transaction(() => {
      this.db.prepare('insert into usage_snapshots (at, payload) values (?, ?)').run(at, JSON.stringify(raw));
      this.db.prepare('delete from usage_snapshots where at not in (select at from usage_snapshots order by at desc limit ?)').run(this.keep);
      if (p.providerSessionId) {
        // null の項目は既存の値を保つ（1 回目の payload は current_usage が null）。
        this.db.prepare(`insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)
          on conflict(provider_session_id) do update set
            model = coalesce(excluded.model, session_live_stats.model), effort = coalesce(excluded.effort, session_live_stats.effort),
            context_used = coalesce(excluded.context_used, session_live_stats.context_used), context_size = coalesce(excluded.context_size, session_live_stats.context_size),
            cost_usd = coalesce(excluded.cost_usd, session_live_stats.cost_usd), updated_at = excluded.updated_at`)
          .run(p.providerSessionId, p.model, p.effort, p.contextUsed, p.contextSize, p.costUsd, at);
      }
    });
    write();
    let usageChanged = false;
    if (p.rateLimits) {
      const next: UsageDto = { fiveHour: p.rateLimits.fiveHour ?? this.state.fiveHour, sevenDay: p.rateLimits.sevenDay ?? this.state.sevenDay, updatedAt: at };
      usageChanged = !sameWindow(next.fiveHour, this.state.fiveHour) || !sameWindow(next.sevenDay, this.state.sevenDay) || this.state.updatedAt === null;
      this.state = next;
    }
    return { usage: this.state, usageChanged, providerSessionId: p.providerSessionId };
  }
}
