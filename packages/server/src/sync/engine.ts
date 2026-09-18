import { MAX_PUSH_BATCH, PULL_LIMIT, type ChangeIn, type ChangeOp, type ChangeOut, type SharedTable, type SnapshotResponse, type SyncStateKind, type SyncStatusDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { onSharedWrite } from '../db/shared.ts';
import { applyRemoteBatch, type MemoConflict } from './apply.ts';
import { CloudError, goneFloor, type CloudClient } from './client.ts';
import { QuotaCounter, quotaDayKey } from './quota.ts';
import { SyncStateStore } from './state.ts';

/** 時計は必ず注入する。テストは FakeTimers（packages/server/test/fake-timers.ts）を渡す。 */
export type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval };

export type SyncEngineDeps = {
  db: Db; deviceId: string; client: CloudClient | null; url?: string | null;
  now?: () => number; timers?: Timers;
  pushDebounceMs?: number; pushMinGapMs?: number; pullIntervalMs?: number; focusMinGapMs?: number;
  quota?: QuotaCounter;
  /**
   * 他端末の新しいメモで手元のメモを上書きする直前に呼ばれる。
   * 呼び手は負けた本文を memo.conflict-<端末名>-<時刻>.md として隣に残す。
   * 投げるとその行は適用しない（控えの取れないまま利用者の文章を消さない）。
   */
  onMemoConflict?: (o: MemoConflict) => void;
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
const RESYNC_MESSAGE = 'クラウドの変更ログが古くなっていたので、同期を作り直しました';

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
  protected guardQuota(): boolean {
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

  /** 利用者が押した「今すぐ同期」と定期実行の入口。走っている pull があればそれに相乗りする。 */
  pullNow(): Promise<{ applied: number }> {
    if (!this.deps.client || this.paused) return Promise.resolve({ applied: 0 });
    if (this.pulling) return this.pulling;
    this.pulling = this.doPull(this.deps.client).finally(() => { this.pulling = null; this.emitStatus(); });
    this.emitStatus();
    return this.pulling;
  }

  /**
   * クラウドへの 1 要求。無料枠は「届いた要求」だけを数える。
   * そもそも繋がらなかったとき（CloudError の status 0）は Worker を呼んでいないので数えない。
   */
  private async request<T>(call: () => Promise<T>): Promise<T> {
    try {
      const v = await call();
      this.quota.note({ requests: 1 });
      return v;
    } catch (e) {
      if (e instanceof CloudError && e.status !== 0) this.quota.note({ requests: 1 });
      throw e;
    }
  }

  private applyPage(changes: ChangeOut[], skipOwn: boolean): number {
    const applied = applyRemoteBatch(this.deps.db, changes, { ownDeviceId: this.deps.deviceId, skipOwn, onMemoConflict: this.deps.onMemoConflict });
    for (const c of applied) this.emit('applied', c);
    return applied.length;
  }

  /**
   * 写しと差分を 1 巡読む。
   *
   * 写し（GET /rows）は nextAfter が null になるまで読み切ってから lastSeq を進める。
   * 途中のページで止めて lastSeq だけ進めると、読まなかった鍵は差分にも載らないので永久に欠ける。
   * Worker は端末がどこまで読んだかを覚えていないので、やり直せるのはこちら側だけである。
   */
  private async pullPass(client: CloudClient, count: { applied: number }): Promise<void> {
    if (this.state.get('snapshotDone') !== '1') {
      let after: string | null = null;
      /**
       * 差分に戻る位置は、写しの **最初のページ**の seq である。
       * 読み終えるまでの間に他端末が行を更新すると、その変更の連番は最後のページの seq より小さくなりうる。
       * 大きい方を since にすると、もう読み終えた鍵の更新を二度と受け取れない。
       * 取りこぼすより、同じ変更をもう一度受け取る方が安全である（適用は updated_at の比較で冪等である）。
       */
      let seq: number | null = null;
      do {
        const cursor: string | null = after;
        const page: SnapshotResponse = await this.request(() => client.snapshot(cursor, PULL_LIMIT));
        count.applied += this.applyPage(page.changes, false);
        after = page.nextAfter;
        if (seq === null) seq = page.seq;
      } while (after !== null);
      this.state.set('lastSeq', seq ?? 0);
      this.state.set('snapshotDone', true);
    }
    let since = this.state.getNumber('lastSeq', 0);
    for (;;) {
      const at = since;
      const page = await this.request(() => client.pullChanges(at, PULL_LIMIT));
      count.applied += this.applyPage(page.changes, true);
      since = page.nextSeq;
      this.state.set('lastSeq', since);
      if (!page.more) break;
    }
  }

  /**
   * 1 回の pull。
   * GET /changes が 410 と { error: 'gone', floor } を返したら、圧縮でその区間が消えている。
   * 差分では追いつけないので、lastSeq と snapshotDone を捨てて写しから作り直す。
   * これが無いと、しばらく繋がらなかった端末が消えた区間の変更を永久に取りこぼす。
   */
  protected async doPull(client: CloudClient): Promise<{ applied: number }> {
    const count = { applied: 0 };
    try {
      try {
        await this.pullPass(client, count);
      } catch (e) {
        if (goneFloor(e) === null) throw e;
        this.state.set('lastSeq', null);
        this.state.set('snapshotDone', null);
        this.emit('toast', 'info', RESYNC_MESSAGE);
        // 作り直しは写しから始まるので、ここで二度目の 410 は出ない（出たら普通の失敗として扱う）。
        await this.pullPass(client, count);
      }
      this.state.set('lastPullAt', this.now());
      this.clearError();
      this.emit('pulled');
    } catch (e) {
      this.fail(e);
    }
    // 途中で止めると写しが半端なまま snapshotDone が立ちうるので、枠の見張りは 1 巡終えてから当てる。
    this.guardQuota();
    return { applied: count.applied };
  }

  /** 利用者が押した「今すぐ同期」。push してから pull する。最小間隔は見ない。 */
  async syncNow(): Promise<void> {
    await this.pushNow();
    await this.pullNow();
  }

  /** セッション起動の直前に呼ぶ。2 秒で諦めるが pull 自体は続く。 */
  async pullBeforeLaunch(timeoutMs = 2000): Promise<boolean> {
    if (!this.deps.client || this.paused) return false;
    let timer: NodeJS.Timeout | null = null;
    const gaveUp = new Promise<boolean>((r) => { timer = this.timers.setTimeout(() => r(false), timeoutMs); });
    const done = this.pulling ?? this.pullNow();
    const result = await Promise.race([done.then(() => this.lastError === null, () => false), gaveUp]);
    if (timer) this.timers.clearTimeout(timer);
    return result;
  }

  /** ウィンドウの前面化。前回の pull から 5 秒以内なら何もしない。 */
  async onFocus(): Promise<void> {
    const last = this.state.getNumber('lastPullAt', 0);
    if (this.now() - last < (this.deps.focusMinGapMs ?? 5000)) return;
    await this.pullNow();
  }
}
