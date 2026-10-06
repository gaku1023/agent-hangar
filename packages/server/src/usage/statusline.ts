import { PRIMARY_ACCOUNT_ID, type RateWindowDto, type UsageDto } from '@agent-hangar/shared';
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

export type IngestResult = { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null; accountId: string };

const EMPTY: UsageDto = { fiveHour: null, sevenDay: null, updatedAt: null };

/**
 * 使用率の現在値をアカウントごとに持ち、payload を積む。
 * 使用率は Claude のセッションが動いている間だけ届くので、値が無い payload では直前の値を保つ。
 * 本文の置き場はアカウントの間で共有なので、どのアカウントの値かは payload からは分からない。
 * 呼び手が渡す accountOf が、セッションの id から run を引いて決める。
 */
export class UsageTracker {
  private readonly state = new Map<string, UsageDto>();
  private lastAt = 0;
  private readonly now: () => number;
  private readonly keep: number;
  private readonly accountOf: (providerSessionId: string | null) => string;

  constructor(private readonly db: Db, opts: { now?: () => number; keep?: number; accountOf?: (providerSessionId: string | null) => string } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.keep = opts.keep ?? 500;
    this.accountOf = opts.accountOf ?? (() => PRIMARY_ACCOUNT_ID);
    this.restore();
  }

  /** 最初のアカウントの値。事後の要約の止める判定と、古い呼び手が使う。 */
  current(): UsageDto { return this.of(PRIMARY_ACCOUNT_ID); }
  of(accountId: string): UsageDto { return this.state.get(accountId) ?? EMPTY; }

  /** アカウントごとに新しい順に読み、両方の窓が埋まるか行が尽きるまで辿る。 */
  private restore(): void {
    const accounts = (this.db.prepare('select distinct coalesce(account, ?) a from usage_snapshots').all(PRIMARY_ACCOUNT_ID) as { a: string }[]).map((r) => r.a);
    for (const a of accounts) {
      const rows = this.db.prepare('select at, payload from usage_snapshots where coalesce(account, ?) = ? order by at desc limit ?').all(PRIMARY_ACCOUNT_ID, a, this.keep) as { at: number; payload: string }[];
      let s: UsageDto = EMPTY;
      for (const r of rows) {
        let p: StatuslinePayload | null = null;
        try { p = parseStatusline(JSON.parse(r.payload)); } catch { continue; }
        if (!p?.rateLimits) continue;
        if (s.fiveHour === null && p.rateLimits.fiveHour) s = { ...s, fiveHour: p.rateLimits.fiveHour, updatedAt: s.updatedAt ?? r.at };
        if (s.sevenDay === null && p.rateLimits.sevenDay) s = { ...s, sevenDay: p.rateLimits.sevenDay, updatedAt: s.updatedAt ?? r.at };
        if (s.fiveHour && s.sevenDay) break;
      }
      if (s !== EMPTY) this.state.set(a, s);
    }
    this.lastAt = (this.db.prepare('select max(at) at from usage_snapshots').get() as { at: number | null }).at ?? 0;
  }

  ingest(raw: unknown): IngestResult | null {
    const p = parseStatusline(raw);
    if (!p) return null;
    const accountId = this.accountOf(p.providerSessionId);
    const at = Math.max(this.now(), this.lastAt + 1);
    this.lastAt = at;
    const write = this.db.transaction(() => {
      this.db.prepare('insert into usage_snapshots (at, payload, account) values (?, ?, ?)').run(at, JSON.stringify(raw), accountId);
      this.db.prepare('delete from usage_snapshots where coalesce(account, ?) = ? and at not in (select at from usage_snapshots where coalesce(account, ?) = ? order by at desc limit ?)').run(PRIMARY_ACCOUNT_ID, accountId, PRIMARY_ACCOUNT_ID, accountId, this.keep);
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
    const before = this.of(accountId);
    let usageChanged = false;
    if (p.rateLimits) {
      const next: UsageDto = { fiveHour: p.rateLimits.fiveHour ?? before.fiveHour, sevenDay: p.rateLimits.sevenDay ?? before.sevenDay, updatedAt: at };
      usageChanged = !sameWindow(next.fiveHour, before.fiveHour) || !sameWindow(next.sevenDay, before.sevenDay) || before.updatedAt === null;
      this.state.set(accountId, next);
    }
    return { usage: this.of(accountId), usageChanged, providerSessionId: p.providerSessionId, accountId };
  }
}
