import type { SyncStateKey, SyncStateStore } from './state.ts';

/** Cloudflare の無料枠。Workers の要求と D1 の書き込みが、どちらも 1 日 10 万である。 */
export type QuotaLimits = { d1Writes: number; requests: number };
export const QUOTA_LIMITS: QuotaLimits = { d1Writes: 100_000, requests: 100_000 };

/** この割合に達したら同期を止める。利用者の決定（課金される形にしない）に沿った余白である。 */
export const QUOTA_STOP_RATIO = 0.8;

export type QuotaDay = { rows: number; requests: number };

/**
 * その日の数えを置く sync_state の鍵。
 * 区切りは UTC の 0 時で、Cloudflare の枠が戻る境目と同じにしてある。
 */
export function quotaDayKey(now: number): string {
  return `quota:${new Date(now).toISOString().slice(0, 10)}`;
}

/** 数として読めない値は 0 にする。手で書き換えられた sync_state で同期が壊れないようにする。 */
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * その日に送った行数と出した要求の回数を数える。
 * 無料枠の 80% に達したら exceeded() が true になり、SyncEngine が自分で同期を止める。
 * 数えは sync_state に置くので、サーバを立て直しても続く。
 */
export class QuotaCounter {
  private readonly state: SyncStateStore;
  private readonly nowFn: () => number;
  readonly limits: QuotaLimits;
  readonly ratio: number;
  /** 最後に書いた日の鍵。日付が変わったら、この行を消して sync_state を溜めない。 */
  private lastKey: string | null = null;

  constructor(o: { state: SyncStateStore; now?: () => number; limits?: QuotaLimits; ratio?: number }) {
    this.state = o.state;
    this.nowFn = o.now ?? (() => Date.now());
    this.limits = o.limits ?? QUOTA_LIMITS;
    this.ratio = o.ratio ?? QUOTA_STOP_RATIO;
  }

  /** その日の鍵。`quota:<yyyy-MM-dd>` は SyncStateKey の一覧には無いので、包みに渡すときだけ被せる。 */
  private key(): string { return quotaDayKey(this.nowFn()); }

  private read(key: string): QuotaDay {
    const raw = this.state.get(key as SyncStateKey);
    if (raw === null) return { rows: 0, requests: 0 };
    try {
      const v = JSON.parse(raw) as { rows?: unknown; requests?: unknown };
      return { rows: count(v?.rows), requests: count(v?.requests) };
    } catch {
      return { rows: 0, requests: 0 };
    }
  }

  /** 今日の数え。日付が変わっていれば 0 から始まる。 */
  today(): QuotaDay { return this.read(this.key()); }

  /** push 1 回ぶんを足す。rows は送った changes の行数、requests は出した要求の回数である。 */
  note(o: { rows?: number; requests?: number }): void {
    const key = this.key();
    if (this.lastKey !== null && this.lastKey !== key) this.state.set(this.lastKey as SyncStateKey, null);
    this.lastKey = key;
    const cur = this.read(key);
    const next: QuotaDay = { rows: cur.rows + count(o.rows), requests: cur.requests + count(o.requests) };
    this.state.set(key as SyncStateKey, JSON.stringify(next));
  }

  /** 行数と要求の回数のどちらかが上限の 80% に達したか。 */
  exceeded(): boolean {
    const t = this.today();
    return t.rows >= this.limits.d1Writes * this.ratio || t.requests >= this.limits.requests * this.ratio;
  }
}
