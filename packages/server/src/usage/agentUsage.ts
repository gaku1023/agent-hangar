import { usageAt, type AgentUsageDto, type AgentUsagesDto, type RateWindowDto } from '@agent-hangar/shared';

/** Claude 以外のエージェントで枠を持てるもの。 */
export type UsageAgent = keyof AgentUsagesDto;

/** 入れる値。窓が null の項目と plan が null の項目は、前の値を保つ（疎な更新）。 */
/** アカウントの id を渡さない呼び方が指す、最初のアカウント。 */
export const PRIMARY_ACCOUNT_ID = 'primary';

export type AgentWindows = { fiveHour: RateWindowDto | null; sevenDay: RateWindowDto | null; plan: string | null };

export type AgentUsageOptions = {
  now?: () => number;
  /** 設定でそのエージェントを有効にしているか。切の間は受けず、返さない。 */
  enabled?: () => boolean;
};

const keyOf = (agent: UsageAgent, accountId: string): string => `${agent}\u0000${accountId}`;

const same = (a: RateWindowDto | null, b: RateWindowDto | null) => a?.usedPercent === b?.usedPercent && a?.resetsAt === b?.resetsAt;

/**
 * Claude 以外のエージェント（いまは Codex）の枠の現在値。Claude の枠（UsageTracker）とは別に持ち、メモリだけに置く。
 * 値は app-server の account/rateLimits（hangar が起こした会話）と、rollout の rate_limits（hangar の外の会話）から届く。
 * 届いた観測の時刻（at）がいちばん新しいものを使う。古い観測は新しい値を上書きしない。
 * 戻る時刻を過ぎた窓は、Claude と同じく 0% として返す（usageAt）。
 */
export class AgentUsageTracker {
  /** 鍵は エージェント + アカウントの id。アカウントごとに枠を持つ。 */
  private readonly state = new Map<string, AgentUsageDto>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly enabled: () => boolean;

  constructor(o: AgentUsageOptions = {}) {
    this.now = o.now ?? (() => Date.now());
    this.enabled = o.enabled ?? (() => true);
  }

  /** 窓を重ねる。受けたら真。切のときと、より新しい観測がすでにあるときは偽。 */
  set(agent: UsageAgent, w: AgentWindows, at: number, accountId: string = PRIMARY_ACCOUNT_ID): boolean {
    if (!this.enabled()) return false;
    const key = keyOf(agent, accountId);
    const prev = this.state.get(key);
    if (prev && prev.updatedAt !== null && at < prev.updatedAt) return false;
    const next: AgentUsageDto = {
      fiveHour: w.fiveHour ?? prev?.fiveHour ?? null, sevenDay: w.sevenDay ?? prev?.sevenDay ?? null,
      plan: w.plan ?? prev?.plan ?? null, updatedAt: at,
    };
    this.state.set(key, next);
    if (!prev || !same(prev.fiveHour, next.fiveHour) || !same(prev.sevenDay, next.sevenDay) || prev.plan !== next.plan) for (const cb of [...this.listeners]) cb();
    return true;
  }

  /**
   * 設定の入り切りが変わったとき。切なら持っていた値を捨て（入れ直したときに古い値を出さない）、どちらでも配り直しを頼む（切になった瞬間にヘッダの元から外す）。
   */
  refresh(): void {
    if (!this.enabled()) this.state.clear();
    for (const cb of [...this.listeners]) cb();
  }

  of(agent: UsageAgent, accountId: string = PRIMARY_ACCOUNT_ID): AgentUsageDto | null {
    if (!this.enabled()) return null;
    const s = this.state.get(keyOf(agent, accountId));
    if (!s) return null;
    const u = usageAt(s, this.now());
    return u === s ? s : { ...u, plan: s.plan };
  }

  /** 配る形。codexAccountId は、いまの Codex アカウント（渡さなければ最初のアカウント）。何も無ければ undefined（AccountsDto に項目ごと付けない）。 */
  all(codexAccountId: string = PRIMARY_ACCOUNT_ID): AgentUsagesDto | undefined {
    const codex = this.of('codex', codexAccountId);
    return codex ? { codex } : undefined;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
}
