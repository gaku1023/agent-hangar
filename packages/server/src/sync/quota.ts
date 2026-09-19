import type { SyncStateKey, SyncStateStore } from './state.ts';

/** Cloudflare の無料枠。Workers の要求と D1 の書き込みが、どちらも 1 日 10 万である。 */
export type QuotaLimits = { d1Writes: number; requests: number };
export const QUOTA_LIMITS: QuotaLimits = { d1Writes: 100_000, requests: 100_000 };

/** この割合に達したら同期を止める。利用者の決定（課金される形にしない）に沿った余白である。 */
export const QUOTA_STOP_RATIO = 0.8;

export type QuotaDay = { rows: number; requests: number };

/**
 * Worker が push の 1 行につき D1 へ書く行数である。
 *
 * `packages/cloud/src/changes.ts` は、採った 1 行ごとに `changes` への insert と鏡（`rows`）の upsert を
 * 必ず 2 文積む（240 行から 243 行）。
 * 数えるのが「端末が送った論理行数」だと、実際の書き込みの半分しか見えない。
 */
export const D1_WRITES_PER_CHANGE = 2;

/**
 * 1 要求につき `devices` を 1 行更新する経路ぶんである。
 *
 * `POST /changes` は末尾で `last_seen_at` を書き（245 行）、
 * `GET /changes` も `last_seen_at` と `last_pulled_seq` を書く（270 行）。
 * `GET /rows` は読むだけなので 0 である。
 */
export const D1_WRITES_PER_DEVICE_TOUCH = 1;

/**
 * push 1 回で D1 に書かれる行数。
 *
 * 数えるのは Worker が採った行（`accepted`）だけである。
 * 同着で弾かれた行（`skipped`）は 1 行も書かれないので、送った行数で数えると多く見積もる。
 * `accepted` が読めない応答のときだけ、送った行数で代用する。
 */
export function pushD1Writes(accepted: unknown, sent: number): number {
  const a = typeof accepted === 'number' && Number.isFinite(accepted) && accepted >= 0 ? Math.floor(accepted) : sent;
  return a * D1_WRITES_PER_CHANGE + D1_WRITES_PER_DEVICE_TOUCH;
}

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
 * その日に Worker が書いた D1 の行数と、出した要求の回数を数える。
 * 無料枠の 80% に達したら exceeded() が true になり、SyncEngine が自分で同期を止める。
 * 数えは sync_state に置くので、サーバを立て直しても続く。
 *
 * **`rows` は「端末が送った論理行数」ではなく「Worker が D1 へ書いた行数」である。**
 * 比べる相手（`QUOTA_LIMITS.d1Writes`）が D1 の「1 日に書ける行数」なので、単位を揃えないと見張りが効かない。
 * 呼び手は pushD1Writes と D1_WRITES_PER_DEVICE_TOUCH を使って、実際の書き込みに換算してから渡すこと。
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
