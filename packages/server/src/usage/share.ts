import type { RateWindowDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

/** 共有する枠を持つエージェント。Claude は statusline、Codex は app-server と rollout から観測する。 */
export type ShareAgent = 'claude' | 'codex';

/** 共有表の 1 行の中身。observedAt は観測した時刻（ミリ秒）。 */
export type SharedUsage = { fiveHour: RateWindowDto | null; sevenDay: RateWindowDto | null; plan: string | null; observedAt: number };

/** 主キー。アカウントの一覧は PC ごとの設定なので、2 台の間ではアカウントの名前で結ぶ。 */
export const usageShareId = (agent: ShareAgent, name: string): string => `${agent}:${name}`;

const isWindow = (v: unknown): v is RateWindowDto => typeof v === 'object' && v !== null && typeof (v as RateWindowDto).usedPercent === 'number' && Number.isFinite((v as RateWindowDto).usedPercent);

function windowOf(text: unknown): RateWindowDto | null {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (!isWindow(v)) return null;
    const r = (v as { resetsAt?: unknown }).resetsAt;
    return { usedPercent: v.usedPercent, resetsAt: typeof r === 'number' && Number.isFinite(r) ? r : null };
  } catch { return null; }
}

export const sameWindow = (a: RateWindowDto | null, b: RateWindowDto | null): boolean => a?.usedPercent === b?.usedPercent && a?.resetsAt === b?.resetsAt;

/**
 * アカウントの使用率を、アカウントの名前ごとに 1 行で 2 台に共有する（表 account_usage）。
 * 使用率はアカウントに付く値なので、どちらの PC で観測しても同じ値である。読む側は手元の観測と比べて新しい方を出す。
 * 書くのは使用率が変わったときだけにする（呼び手が決める）。statusline は数秒ごとに届くので、毎回書くと同期の書き込みが増える。
 */
export class UsageShare {
  constructor(private readonly db: Db, private readonly deviceId: string) {}

  read(agent: ShareAgent, name: string): SharedUsage | null {
    const r = this.db.prepare('select five_hour, seven_day, plan, observed_at from account_usage where id = ? and deleted_at is null').get(usageShareId(agent, name)) as
      { five_hour: unknown; seven_day: unknown; plan: unknown; observed_at: unknown } | undefined;
    if (!r || typeof r.observed_at !== 'number') return null;
    return { fiveHour: windowOf(r.five_hour), sevenDay: windowOf(r.seven_day), plan: typeof r.plan === 'string' ? r.plan : null, observedAt: r.observed_at };
  }

  /** 表にある観測より新しいときだけ書く。古い観測で、別の PC の新しい値を上書きしない。 */
  publish(agent: ShareAgent, name: string, u: SharedUsage): void {
    const prev = this.read(agent, name);
    if (prev && prev.observedAt >= u.observedAt) return;
    upsertShared(this.db, 'account_usage', {
      id: usageShareId(agent, name), agent, account_name: name,
      five_hour: u.fiveHour ? JSON.stringify(u.fiveHour) : null, seven_day: u.sevenDay ? JSON.stringify(u.sevenDay) : null,
      plan: u.plan, observed_at: u.observedAt, deleted_at: null,
    }, this.deviceId);
  }
}

/** 呼び手（UsageTracker、AgentUsageTracker）に渡す口。nameOf はアカウントの id から名前を引く。引けなければ共有しない。 */
export type UsageShareLink<NameOf> = { usage: UsageShare; nameOf: NameOf };

/** 共有表の値と手元の値が食い違うか。共有表に行が無ければ食い違うとみなす。 */
export function differsFromShared(shared: SharedUsage | null, next: { fiveHour: RateWindowDto | null; sevenDay: RateWindowDto | null; plan?: string | null }): boolean {
  if (!shared) return true;
  return !sameWindow(shared.fiveHour, next.fiveHour) || !sameWindow(shared.sevenDay, next.sevenDay) || (next.plan !== undefined && next.plan !== null && next.plan !== shared.plan);
}
