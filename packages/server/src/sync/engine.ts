import { MAX_PUSH_BATCH, type ChangeIn, type ChangeOp, type ChangeOut, type SharedTable, type SyncStateKind, type SyncStatusDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { onSharedWrite } from '../db/shared.ts';
import { CloudError, type CloudClient } from './client.ts';
import { QuotaCounter, quotaDayKey } from './quota.ts';
import { SyncStateStore } from './state.ts';

/** 時計は必ず注入する。テストは FakeTimers（packages/server/test/fake-timers.ts）を渡す。 */
export type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval };

export type SyncEngineDeps = {
  db: Db; deviceId: string; client: CloudClient | null; url?: string | null;
  now?: () => number; timers?: Timers;
  pushDebounceMs?: number; pushMinGapMs?: number; pullIntervalMs?: number; focusMinGapMs?: number;
  quota?: QuotaCounter;
};

export type SyncListener = {
  status?(s: SyncStatusDto): void;
  applied?(c: ChangeOut): void;
  pulled?(): void;
  toast?(level: 'info' | 'error', message: string): void;
};

/** 送り終えた changes をどれだけ残すか。再送はしないが、何を送ったかを少しだけ追えるようにする。 */
const LOCAL_CHANGES_KEEP_MS = 7 * 86_400_000;
/** 変更が止まってから push するまで。 */
const PUSH_DEBOUNCE_MS = 1_000;
/**
 * 連続する push の最小の間隔。
 * デバウンスは「止まってから 1 秒」なので、実行中のセッションのように変更が途切れない相手には効かない。
 * 索引器は本文が伸びるたびに sessions を書くので、これが無いと 2 秒ごとに push が出て無料枠を使い切る。
 */
const PUSH_MIN_GAP_MS = 10_000;
const PULL_INTERVAL_MS = 30_000;
const QUOTA_PAUSED_MESSAGE = '無料枠の 80% に達したので同期を止めました。Settings で再開できます';

const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };

type ChangeRow = { seq: number; table_name: SharedTable; row_id: string; op: ChangeOp; payload: string; updated_at: number; device_id: string };

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const unref = (h: NodeJS.Timeout): void => { (h as { unref?: () => void }).unref?.(); };

/**
 * メタデータの同期。changes の未送信分を 1 秒のデバウンスで push し、pull で受けた変更を LWW で適用する。
 * client が null なら off で、changes は積むだけになる。
 * 時刻とタイマーはすべて deps から取るので、テストは偽の時計で回せる。
 */
export class SyncEngine {
  readonly state: SyncStateStore;
  readonly quota: QuotaCounter;
  private readonly listeners = new Set<SyncListener>();
  private readonly timers: Timers;
  private pushTimer: NodeJS.Timeout | null = null;
  private pullTimer: NodeJS.Timeout | null = null;
  private offWrite: (() => void) | null = null;
  private pushing: Promise<{ pushed: number }> | null = null;
  protected pulling: Promise<{ applied: number }> | null = null;
  private lastError: string | null = null;
  private claudeConfig = { enabled: false, confirmed: false };
  private started = false;
  /** 無料枠で止めた日。同じ日に二度は止めない（利用者が再開を押した後に押し返さない）。 */
  private quotaPausedDay: string | null = null;

  constructor(protected readonly deps: SyncEngineDeps) {
    this.state = new SyncStateStore(deps.db);
    this.timers = deps.timers ?? REAL_TIMERS;
    this.quota = deps.quota ?? new QuotaCounter({ state: this.state, now: () => this.now() });
  }

  protected now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  protected get paused(): boolean { return this.state.get('paused') === '1'; }

  on(l: SyncListener): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }

  protected emit<K extends keyof SyncListener>(k: K, ...args: Parameters<NonNullable<SyncListener[K]>>): void {
    for (const l of [...this.listeners]) (l[k] as ((...a: unknown[]) => void) | undefined)?.(...args);
  }

  protected emitStatus(): void { this.emit('status', this.status()); }

  /** 失敗の理由を残す。CloudError の message は応答本文の先頭 200 字なので、Worker は本文に秘密を入れない。 */
  protected fail(e: unknown): void { this.lastError = errorMessage(e); this.state.set('lastError', this.lastError); }
  protected clearError(): void { this.lastError = null; this.state.set('lastError', null); }

  pending(): number { return (this.deps.db.prepare('select count(*) c from changes where pushed_at is null').get() as { c: number }).c; }

  status(): SyncStatusDto {
    const state: SyncStateKind = !this.deps.client ? 'off'
      : this.paused ? 'paused'
      : this.pushing ? 'pushing'
      : this.pulling ? 'pulling'
      : this.lastError ? 'error'
      : 'idle';
    const num = (k: 'lastPushAt' | 'lastPullAt') => { const v = this.state.get(k); return v === null ? null : Number(v); };
    const deviceCount = (this.deps.db.prepare('select count(*) c from devices where deleted_at is null').get() as { c: number }).c;
    return {
      state,
      url: this.deps.url ?? null,
      lastPushAt: num('lastPushAt'),
      lastPullAt: num('lastPullAt'),
      pending: this.pending(),
      error: state === 'error' ? this.lastError : null,
      deviceCount,
      claudeConfig: { ...this.claudeConfig },
    };
  }

  setClaudeConfigStatus(s: { enabled: boolean; confirmed: boolean }): void { this.claudeConfig = { ...s }; this.emitStatus(); }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.offWrite = onSharedWrite((_t, _id, db) => { if (db === this.deps.db) this.noteLocalChange(); });
    if (!this.deps.client) { this.emitStatus(); return; }
    this.pullTimer = this.timers.setInterval(() => { void this.tick(); }, this.deps.pullIntervalMs ?? PULL_INTERVAL_MS);
    unref(this.pullTimer);
    await this.syncNow();
  }

  stop(): void {
    this.started = false;
    this.offWrite?.(); this.offWrite = null;
    if (this.pushTimer) this.timers.clearTimeout(this.pushTimer);
    if (this.pullTimer) this.timers.clearInterval(this.pullTimer);
    this.pushTimer = this.pullTimer = null;
  }

  /** 定期実行。push してから pull する。 */
  protected async tick(): Promise<void> {
    if (this.paused) return;
    await this.pushNow();
    await this.pullNow();
  }

  /** ローカルの書き込みの 1 秒後に push する。連続する書き込みは 1 回にまとめる。 */
  noteLocalChange(): void {
    if (!this.started || !this.deps.client) return;
    this.schedulePush(this.deps.pushDebounceMs ?? PUSH_DEBOUNCE_MS);
  }

  /**
   * delayMs 後の push を予約し直す。
   * 期限が来ても前回の push から最小間隔が空いていなければ、残りの時間だけ引き直す。
   */
  private schedulePush(delayMs: number): void {
    if (this.pushTimer) this.timers.clearTimeout(this.pushTimer);
    this.pushTimer = this.timers.setTimeout(() => {
      this.pushTimer = null;
      const wait = this.pushGapRemaining();
      if (wait > 0) { this.schedulePush(wait); return; }
      void this.pushNow();
    }, delayMs);
    unref(this.pushTimer);
  }

  /** 前回 push を終えてから最小間隔が空くまでの残り。空いていれば 0。 */
  private pushGapRemaining(): number {
    const gap = this.deps.pushMinGapMs ?? PUSH_MIN_GAP_MS;
    const v = this.state.get('lastPushAt');
    const last = v === null ? NaN : Number(v);
    if (!Number.isFinite(last)) return 0;
    return Math.max(0, Math.min(gap, last + gap - this.now()));
  }

  /** 利用者が押した「今すぐ同期」と定期実行の入口。最小間隔は見ない。 */
  pushNow(): Promise<{ pushed: number }> {
    if (!this.deps.client || this.paused) return Promise.resolve({ pushed: 0 });
    if (this.pushing) return this.pushing;
    this.pushing = this.doPush(this.deps.client).finally(() => { this.pushing = null; this.emitStatus(); });
    this.emitStatus();
    return this.pushing;
  }

  private async doPush(client: CloudClient): Promise<{ pushed: number }> {
    const db = this.deps.db;
    let pushed = 0;
    for (;;) {
      const rows = db.prepare('select * from changes where pushed_at is null order by seq limit ?').all(MAX_PUSH_BATCH) as ChangeRow[];
      if (rows.length === 0) break;
      const batch: ChangeIn[] = rows.map((r) => ({
        tableName: r.table_name, rowId: r.row_id, op: r.op,
        payload: JSON.parse(r.payload) as Record<string, unknown>, updatedAt: r.updated_at,
      }));
      try {
        await client.pushChanges(batch);
      } catch (e) {
        // status 0 は届いていないので要求に数えない。届いた失敗は枠を使っている。
        if (e instanceof CloudError && e.status !== 0) this.quota.note({ requests: 1 });
        this.fail(e);
        this.guardQuota();
        return { pushed };
      }
      const now = this.now();
      db.prepare(`update changes set pushed_at = ? where seq in (${rows.map(() => '?').join(',')})`).run(now, ...rows.map((r) => r.seq));
      this.state.set('lastPushAt', now);
      this.clearError();
      this.quota.note({ rows: rows.length, requests: 1 });
      pushed += rows.length;
      // 止めたら残りは送らない。送れていない行は pushed_at が null のまま残るので、再開で続きから出る。
      if (this.guardQuota()) return { pushed };
    }
    db.prepare('delete from changes where pushed_at is not null and pushed_at < ?').run(this.now() - LOCAL_CHANGES_KEEP_MS);
    return { pushed };
  }

  /**
   * 無料枠の 80% に達していたら自分で一時停止し、トーストで知らせる。
   * 止めるのは 1 日に 1 度だけで、利用者が再開を押した後はその日は押し返さない。
   * 一時停止そのものは日付が変わっても自動では解けない。
   */
  private guardQuota(): boolean {
    const day = quotaDayKey(this.now());
    if (this.quotaPausedDay === day || this.paused) return false;
    if (!this.quota.exceeded()) return false;
    this.quotaPausedDay = day;
    this.setPaused(true);
    this.emit('toast', 'info', QUOTA_PAUSED_MESSAGE);
    return true;
  }

  setPaused(paused: boolean): void {
    this.state.set('paused', paused);
    if (!paused && this.started && this.deps.client) { this.noteLocalChange(); void this.pullNow(); }
    this.emitStatus();
  }

  // pull 系は Task 10 で実装する。
  pullNow(): Promise<{ applied: number }> { return Promise.resolve({ applied: 0 }); }
  async syncNow(): Promise<void> { await this.pushNow(); await this.pullNow(); }
}
