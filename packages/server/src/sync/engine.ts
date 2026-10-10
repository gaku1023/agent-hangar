import { MAX_PUSH_BATCH, nextUtcMidnight, PULL_LIMIT, type ChangeIn, type ChangeOp, type ChangeOut, type SharedTable, type SnapshotResponse, type SyncStateKind, type SyncStatusDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { noteApplied } from '../db/notify.ts';
import { adoptNoteFromOldSession, applyRemoteBatch, type MemoConflict, type SessionMemoBackup } from './apply.ts';
import { CloudError, CompatError, goneFloor, LimitError, type CloudClient } from './client.ts';
import { SyncStateStore } from './state.ts';

/** 時計は必ず注入する。テストは FakeTimers（packages/server/test/fake-timers.ts）を渡す。 */
export type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval };

export type SyncEngineDeps = {
  db: Db; deviceId: string; client: CloudClient | null; url?: string | null;
  now?: () => number; timers?: Timers;
  /** 持ち越して覚えておく行の上限。既定は MAX_CARRIED_ROWS。試験が下げるために使う。 */
  maxCarriedRows?: number;
  pushDebounceMs?: number; pushMinGapMs?: number; pullIntervalMs?: number; focusMinGapMs?: number;
  /**
   * 他端末の新しいメモで手元のメモを上書きする直前に呼ばれる。
   * 呼び手は負けた本文を memo.conflict-<端末名>-<時刻>.md として隣に残す。
   * 投げるとその行は適用しない（控えの取れないまま利用者の文章を消さない）。
   */
  onMemoConflict?: (o: MemoConflict) => void;
  /**
   * セッションの名前かメモ（session_notes）を他端末の新しい版で上書きしたときに呼ばれる。
   * 控えのファイルはもう書かれている（apply.ts が backups/memos に残す）ので、
   * ここでやることは利用者に置き場を知らせることだけである。投げても適用は止まらない。
   */
  onSessionMemoBackup?: (o: SessionMemoBackup) => void;
  /**
   * 控えの置き場の親（hangar の home）。省くと環境変数から引くので、
   * 一時ディレクトリで起こしたつもりが実物へ書く事故になる。結線側から必ず渡す。
   */
  home?: string;
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
/**
 * UTC の 0 時からこの間に上限で断られたら、その日の枠はもう戻っているとみなして短く退く。
 * Cloudflare の巻き戻しの遅れ、端末の時計のずれ、0 時の直前に出した要求が 0 時をまたいで断られた場合に、24 時間退かないためである。
 */
const LIMIT_GRACE_MS = 10 * 60_000;
/** 猶予の間に断られたときに退く長さ。この短い退きでは知らせない。 */
const LIMIT_RETRY_MS = 5 * 60_000;
/**
 * 上限で退いたときの知らせ。戻る時刻は、tz を省けばこの PC の時刻で書く。
 * tz は試験が時間帯を決めて文そのものを確かめるためにある。
 * 文は試作（docs/superpowers/specs/2026-10-08-stage1-quota-backoff/usage.html）の Q2 で決めた。
 */
export function limitedMessage(until: number, tz?: string): string {
  const at = new Intl.DateTimeFormat('ja-JP', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(until);
  return `Cloudflare の無料枠の上限に達したので、${at} まで同期を止めます。枠が戻ると自動で再開します`;
}
/**
 * 利用者が自分で一時停止している間に頼んだ 1 巡が、上限で断られたときの知らせ。
 * 止めたのは利用者なので、戻る時刻も自動で再開するとも言わない。
 */
export function limitedWhilePausedMessage(): string {
  return 'Cloudflare の無料枠の上限に達したので、同期できませんでした。同期は一時停止のままです';
}
/**
 * 持ち越して覚えておく行の上限。
 * 親が永久に現れない行（クラウドに残った孤児）が溜まり続けないための歯止めである。超えた分は古い方から捨てて記録に出す。
 * 写しの途中で止まったときに 1 頁ぶんより多く持ち越せるよう、頁（500 行）の何倍かにしてある。
 */
export const MAX_CARRIED_ROWS = 5_000;

/**
 * 親が現れない行を覚えておく日数。過ぎたら捨てて記録に出す。
 * 親が消えた行は、いつまで待っても当てられない。寿命が無いと、毎回の pull がその全件を当て直し続ける。
 */
export const ORPHAN_KEEP_DAYS = 30;

const RESYNC_MESSAGE = 'クラウドの変更ログが古くなっていたので、同期を作り直しました';

const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };

type ChangeRow = { seq: number; table_name: SharedTable; row_id: string; op: ChangeOp; payload: string; updated_at: number; device_id: string };

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const unref = (h: NodeJS.Timeout): void => { (h as { unref?: () => void }).unref?.(); };

type OversizeRow = { tableName: string; rowId: string; bytes: number; limit: number };

/**
 * 413 の本文から、Worker が名指しした「大きすぎる行」を読む。
 * 本文は `{ error, limit, count, row: { tableName, rowId, bytes } }` で、200 字に収まるよう 1 件だけが載る。
 * 413 でないもの、読めないもの、名前の無いものはすべて null である（goneFloor と同じ作りである）。
 */
function oversizeRow(e: unknown): OversizeRow | null {
  if (!(e instanceof CloudError) || e.status !== 413) return null;
  try {
    const v = JSON.parse(e.message) as { limit?: unknown; row?: { tableName?: unknown; rowId?: unknown; bytes?: unknown } };
    const r = v?.row;
    if (!r || typeof r.tableName !== 'string' || typeof r.rowId !== 'string' || r.rowId === '') return null;
    const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
    return { tableName: r.tableName, rowId: r.rowId, bytes: num(r.bytes), limit: num(v.limit) };
  } catch {
    return null;
  }
}

/**
 * メタデータの同期。changes の未送信分を 1 秒のデバウンスで push し、pull で受けた変更を LWW で適用する。
 * client が null なら off で、changes は積むだけになる。
 * 時刻とタイマーはすべて deps から取るので、テストは偽の時計で回せる。
 */
export class SyncEngine {
  readonly state: SyncStateStore;
  private readonly listeners = new Set<SyncListener>();
  private readonly timers: Timers;
  private pushTimer: NodeJS.Timeout | null = null;
  private pullTimer: NodeJS.Timeout | null = null;
  private offWrite: (() => void) | null = null;
  private pushing: Promise<{ pushed: number }> | null = null;
  protected pulling: Promise<{ applied: number }> | null = null;
  /**
   * 失敗の理由は push と pull で別に持つ。
   * 1 本にすると、定期実行が push の後に pull を回すたびに、成功した pull が push の失敗を消してしまう。
   * 送れていない行が積み上がっているのに画面が idle になるのは、いちばん見せてはいけない嘘である。
   */
  private pushError: string | null = null;
  private pullError: string | null = null;
  /**
   * 互換の版が合わずに止めた理由（CompatError の文）。null なら止めていない。
   *
   * 一時停止（paused）とは別に持ち、sync_state には残さない。
   * 直す道は、この PC の hangar を入れ替える（立て直しで消える）か、Worker を入れ替えて「今すぐ同期」を押す（syncNow で外す）かである。
   * 残すと、直した後も止まり続ける。
   */
  private compatBlock: string | null = null;
  private started = false;
  /** 413 で諦めた行。同じ行で何度も知らせない。 */
  private readonly oversizeTold = new Set<string>();
  /**
   * タイマーから始めた仕事を並べる 1 本の鎖。
   *
   * `pushNow` と `pullNow` は約束を返すが、タイマーの中から投げっぱなしで始めた回は誰も持たない。
   * 持たないと、終了処理は走っている送信を待てず、テストは「マイクロタスクを何回流したか」でしか待てない。
   * 回数で待つ書き方は、非同期の終わる回が端末ごとに変わるぶん、macOS では通って Linux では落ちる
   * （設定の押し出しが実際にそうなった）。鎖に並べて `idle()` で待ち合わせる。
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(protected readonly deps: SyncEngineDeps) {
    this.state = new SyncStateStore(deps.db);
    this.timers = deps.timers ?? REAL_TIMERS;
    /*
     * 立て直しても、直前まで出ていた失敗の理由を消さない。
     * 送れていない行は `changes` に残っているのに、起こし直した直後だけ idle に見えるのがいちばんの嘘である。
     *
     * push と pull のどちらの失敗だったかは残っていないので、push の側に戻す。
     * 先に見せるのが push の理由であり、次の push が通れば消えるからである（居座らない）。
     */
    this.pushError = this.state.get('lastError');
  }

  protected now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  protected get paused(): boolean { return this.state.get('paused') === '1'; }
  /**
   * 一時停止のまま、利用者が頼んだ 1 巡を通している最中か。
   * 立っている間だけ push と pull の入口が開く。定期実行と起動前の pull は `paused` を見るので、開かない。
   */
  private onePass = false;
  /** push と pull の入口を閉じているか。版で止まっているとき、上限で退いているとき、一時停止していて頼まれた 1 巡の最中でもないとき。 */
  private get halted(): boolean { return this.compatBlock !== null || this.limitedUntil() !== null || (this.paused && !this.onePass); }

  /** 互換の版が合わずに止まっているか。本文と設定の出し入れと使用量も、これを見て止まる（sync/halt.ts の syncHalted）。 */
  compatBlocked(): boolean { return this.compatBlock !== null; }

  /**
   * Cloudflare の上限で退いている間の、戻る時刻。退いていなければ null。
   * 時刻を過ぎていれば印を消して null を返す。日が変われば、次の定期実行（30 秒ごと）から自分で戻る。
   * 印は sync_state に置く。立て直すたびに上限に当たり直して、断られる要求を重ねないためである。
   */
  limitedUntil(): number | null {
    const until = this.state.getNumber('limitedUntil', 0);
    if (until <= 0) return null;
    if (this.now() >= until) { this.state.set('limitedUntil', null); return null; }
    return until;
  }

  /**
   * 上限の失敗（LimitError）を受けたら、次の UTC の 0 時まで退く。上限の失敗なら真を返す。
   * ただし UTC の 0 時から猶予（LIMIT_GRACE_MS）の間に断られたら、LIMIT_RETRY_MS だけ黙って退く。
   * 失敗の理由（error）には残さない。戻る時刻の決まった待ちであって、利用者が直す誤りではないからである。
   * 次の 0 時まで退くときは、新しく退いたときと、違う戻る時刻へ移るときに知らせる（同じ戻る時刻へ退き直すときは重ねない）。
   * 短い印がまだ生きている間に猶予の外で断られたときも、1 日の退きへ移るので知らせる。
   * 利用者が一時停止している間に頼んだ 1 巡で断られたときは、時刻を入れない文で知らせる。
   */
  private noteLimit(e: unknown): boolean {
    if (!(e instanceof LimitError)) return false;
    const was = this.limitedUntil();
    const now = this.now();
    const midnight = nextUtcMidnight(now);
    const sinceMidnight = now - (midnight - 86_400_000);
    if (sinceMidnight < LIMIT_GRACE_MS) {
      this.state.set('limitedUntil', now + LIMIT_RETRY_MS);
      return true;
    }
    const until = midnight;
    this.state.set('limitedUntil', until);
    if (was === null || was !== until) {
      console.warn(`[sync] ${e.message}`);
      this.emit('toast', 'info', this.paused && this.onePass ? limitedWhilePausedMessage() : limitedMessage(until));
    }
    return true;
  }

  on(l: SyncListener): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }

  protected emit<K extends keyof SyncListener>(k: K, ...args: Parameters<NonNullable<SyncListener[K]>>): void {
    for (const l of [...this.listeners]) (l[k] as ((...a: unknown[]) => void) | undefined)?.(...args);
  }

  protected emitStatus(): void { this.emit('status', this.status()); }

  /**
   * いま見せるべき失敗の理由。
   * push の失敗を先に見せる。送れていない行が残る方が、受け取れていないより取り返しがつかない。
   */
  protected get lastError(): string | null { return this.pushError ?? this.pullError; }

  /** 失敗の理由を残す。CloudError の message は応答本文の先頭 200 字なので、Worker は本文に秘密を入れない。 */
  protected failPush(e: unknown): void { if (this.noteLimit(e)) return; this.pushError = errorMessage(e); this.noteCompat(e); this.persistError(); }
  protected failPull(e: unknown): void { if (this.noteLimit(e)) return; this.pullError = errorMessage(e); this.noteCompat(e); this.persistError(); }
  /** 版が合わないと分かったら止める。理由の文は CompatError が持っている（どちらを上げればよいか）。 */
  private noteCompat(e: unknown): void { if (e instanceof CompatError) this.compatBlock = e.message; }
  protected clearPushError(): void { if (this.pushError === null) return; this.pushError = null; this.persistError(); }
  protected clearPullError(): void { if (this.pullError === null) return; this.pullError = null; this.persistError(); }
  private persistError(): void { this.state.set('lastError', this.lastError); }

  pending(): number { return (this.deps.db.prepare('select count(*) c from changes where pushed_at is null').get() as { c: number }).c; }

  /**
   * この箱を分け合っている端末の数。CLI の hangar cloud status が出す。
   * 他端末の行は初回の pull（写し）で必ず入る。
   */
  deviceCount(): number { return (this.deps.db.prepare('select count(*) c from devices where deleted_at is null').get() as { c: number }).c; }

  status(): SyncStatusDto {
    // 上限で退いていることは、利用者が一時停止していないときだけ見せる。一時停止は利用者が選んだ状態なので先に見せる。
    const limitedUntil = this.deps.client && !this.paused ? this.limitedUntil() : null;
    const state: SyncStateKind = !this.deps.client ? 'off'
      // 版で止まっているときは、一時停止より先に見せる。直す道（どちらを上げるか）が error の文にしか無いからである。
      : this.compatBlock !== null ? 'error'
      : this.paused || limitedUntil !== null ? 'paused'
      : this.pushing ? 'pushing'
      : this.pulling ? 'pulling'
      : this.lastError ? 'error'
      : 'idle';
    const num = (k: 'lastPushAt' | 'lastPullAt') => { const v = this.state.get(k); return v === null ? null : Number(v); };
    const shownLimit = state === 'paused' ? limitedUntil : null;
    return {
      state,
      // 版で止まると state は error になり、一時停止していることが state からは読めなくなる。画面の切り替えのために印を別に載せる。
      paused: this.paused,
      url: this.deps.url ?? null,
      lastPushAt: num('lastPushAt'),
      lastPullAt: num('lastPullAt'),
      pending: this.pending(),
      error: state === 'error' ? (this.compatBlock ?? this.lastError) : null,
      deviceCount: this.deviceCount(),
      limitedUntil: shownLimit,
    };
  }


  /** 仕事を鎖の末尾につなぐ。前の仕事が転んでも次は走る。 */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * 止めた後は走らない仕事を鎖の末尾につなぐ。
   *
   * タイマーが並べた時点では、その仕事はまだ走っていない。
   * クラウドが応答しないあいだは鎖が減るより速く伸びるので、
   * 印を見ずに並べると `stop()` の後も要求が出続ける（実測で pull が 24 回、7.3 秒）。
   * 鎖の先頭で `started` を見て、止まっていたら何もせずに譲る。
   */
  private enqueueWhileStarted(work: () => Promise<unknown>): void {
    void this.enqueue(async () => { if (!this.started) return; await work(); }).catch(() => {});
  }

  /**
   * タイマーから始めた仕事と、走っている push と pull が終わるまで待つ。
   * 待っている間に新しく並んだぶんも待つので、戻ったときは何も走っていない。
   */
  async idle(): Promise<void> {
    const settled = (p: Promise<unknown> | null): Promise<void> => (p ? p.then(() => undefined, () => undefined) : Promise.resolve());
    for (;;) {
      const c = this.chain;
      const push = this.pushing;
      const pull = this.pulling;
      await Promise.all([settled(c), settled(push), settled(pull)]);
      if (this.chain === c && this.pushing === push && this.pulling === pull) return;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 行の変化の口の購読者の 1 つである。この端末の書き込み（write）だけを push の契機にする。
    // 同期で降りた行（apply）は changes に積まれないので、拾っても送るものが無い。拾えば、降りるたびに空の push を予約してしまう。
    this.offWrite = onRowChange((c) => { if (c.db === this.deps.db && c.origin === 'write') this.noteLocalChange(); });
    if (!this.deps.client) { this.emitStatus(); return; }
    this.pullTimer = this.timers.setInterval(() => { this.enqueueWhileStarted(() => this.tick()); }, this.deps.pullIntervalMs ?? PULL_INTERVAL_MS);
    unref(this.pullTimer);
    // 起動は利用者の押下ではないので、上限で退いた印を外さない（syncNow は外す）。
    await this.pushNow();
    await this.pullNow();
  }

  /**
   * 止める。
   * `started` を降ろすと、鎖に並んでいる仕事は先頭の検査で譲るので、以後は 1 件も要求を出さない。
   * 既に走り出している push と pull は最後まで走る。呼び手は `idle()` で待ち合わせてから止める。
   */
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
      this.enqueueWhileStarted(() => this.pushNow());
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
    if (!this.deps.client || this.halted) return Promise.resolve({ pushed: 0 });
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
        // 大きすぎる行は何度送っても同じ答えが返る。諦めて先へ進まないと、この塊で push が永久に止まる。
        if (this.dropOversize(e, rows)) continue;
        this.failPush(e);
        return { pushed };
      }
      const now = this.now();
      db.prepare(`update changes set pushed_at = ? where seq in (${rows.map(() => '?').join(',')})`).run(now, ...rows.map((r) => r.seq));
      this.state.set('lastPushAt', now);
      this.clearPushError();
      pushed += rows.length;
    }
    // 未送信が 1 行も残っていないのだから、push は通っている。
    // ここまで来ずに戻った回（失敗と上限）では理由が残るので、状態が嘘にならない。
    this.clearPushError();
    db.prepare('delete from changes where pushed_at is not null and pushed_at < ?').run(this.now() - LOCAL_CHANGES_KEEP_MS);
    return { pushed };
  }

  /**
   * 413 で名指しされた行を諦める。
   *
   * Worker は payload が 128 KiB を超える行を 413 で断り、本文で先頭の 1 件を名指しする。
   * 同じ塊を送り直しても必ず同じ答えが返るので、その行に pushed_at を打って先へ進める。
   * 手元の本文はそのまま残るが、他の端末には届かない。だから 1 度だけ利用者に知らせる。
   *
   * 名指しが読めないときと、名指しされた行がこの塊に無いときは false を返す。
   * 諦める先が分からないまま continue すると、同じ塊を永久に送り直すことになる。
   */
  private dropOversize(e: unknown, rows: ChangeRow[]): boolean {
    const named = oversizeRow(e);
    if (!named) return false;
    const hit = rows.find((r) => r.table_name === named.tableName && r.row_id === named.rowId);
    if (!hit) return false;
    this.deps.db.prepare('update changes set pushed_at = ? where seq = ?').run(this.now(), hit.seq);
    const key = `${named.tableName}:${named.rowId}`;
    if (this.oversizeTold.has(key)) return true;
    this.oversizeTold.add(key);
    const kib = (n: number) => Math.round(n / 1024);
    this.emit('toast', 'error', `${named.tableName} の 1 行（${named.rowId}）が大きすぎるので同期できません（${kib(named.bytes)} KiB、上限 ${kib(named.limit)} KiB）。手元には残りますが、他の PC には届きません`);
    return true;
  }

  /** 利用者が止める、再開する（UI と CLI から）。上限で退いた印には触らない。上限は日が変われば自分で戻る。 */
  setPaused(paused: boolean): void {
    this.state.set('paused', paused);
    if (!paused && this.started && this.deps.client) { this.noteLocalChange(); this.enqueueWhileStarted(() => this.pullNow()); }
    this.emitStatus();
  }

  /** 利用者が押した「今すぐ同期」と定期実行の入口。走っている pull があればそれに相乗りする。 */
  pullNow(): Promise<{ applied: number }> {
    if (!this.deps.client || this.halted) return Promise.resolve({ applied: 0 });
    if (this.pulling) return this.pulling;
    this.pulling = this.doPull(this.deps.client).finally(() => { this.pulling = null; this.emitStatus(); });
    this.emitStatus();
    return this.pulling;
  }

  /**
   * 親の行がまだ無くて当てられなかった行の持ち越し。鍵は「表:行 ID」で、同じ行は新しい方だけを持つ。
   *
   * 最初の写しは鍵の辞書順で頁ごとに降り、`runs:`、`session_notes:`、`session_states:`、`session_summaries:` は親の `sessions:` より前に並ぶ。
   * 差分でも、親を書き直すと親の連番の方が後ろになり、子が前の頁、親が後の頁に分かれることがある。
   * 束の中のやり直し（applyRemoteBatch）は同じ頁の親しか待てないので、落ちた行をここに持ち、1 巡の終わりに当て直す。
   * 表には依らない。外部キーを持つどの表の行も、同じ道を通る。
   * 最後まで当てられなかった行は sync_state の orphans に覚え、次の pull の終わりにもう一度試す。
   * 区切り（lastSeq と snapshotDone）は止めない。止めると、孤児が 1 行あるだけで、毎回の pull が同じ頁か写しの全部を読み直す。
   */
  private carried = new Map<string, ChangeOut>();
  /** 持ち越した行を、最初に持ち越した時刻。寿命（ORPHAN_KEEP_DAYS）を数える。鍵は carried と同じ。 */
  private carriedAt = new Map<string, number>();
  /**
   * この 1 巡で降りてきた、古い形の sessions の行（名前かメモを持つもの）。鍵はセッションの ID。
   * 1 巡を読み切り、持ち越しも当て直した後で、まだ session_notes の行が無いものだけ、その中身で行を作る（apply.ts の adoptNoteFromOldSession）。
   */
  private oldNotes = new Map<string, ChangeOut>();
  private carriedLoaded = false;
  /** 当て直しの最中に、また当てられなかった行の鍵。当て直していないときは null。 */
  private settling: Set<string> | null = null;
  /**
   * 持ち越しが上限を超えたときの、写しのやり直しの段。1 回の起動につき 1 度だけやり直す。
   * none はまだ、pending はやり直しを頼んだ（写しの印を外した）、done はやり直しを読み切った。
   * done の後も超えていたら、写しを読み直してもそろわない行なので、捨てる。やり直しを繰り返す輪にしない。
   */
  private overflowRedo: 'none' | 'pending' | 'done' = 'none';

  private carry(c: ChangeOut): void {
    const key = `${c.tableName}:${c.rowId}`;
    const cur = this.carried.get(key);
    if (!cur || cur.updatedAt <= c.updatedAt) this.carried.set(key, c);
    if (!this.carriedAt.has(key)) this.carriedAt.set(key, this.now());
  }

  private uncarry(key: string): void {
    this.carried.delete(key);
    this.carriedAt.delete(key);
  }

  /** 前の pull と前の起動が覚えた持ち越しを読む。壊れていれば捨てる。 */
  private loadCarried(): void {
    if (this.carriedLoaded) return;
    this.carriedLoaded = true;
    const raw = this.state.get('orphans');
    if (!raw) return;
    try {
      const v: unknown = JSON.parse(raw);
      if (!Array.isArray(v)) return;
      for (const x of v as { c?: ChangeOut; at?: unknown }[]) {
        const c = x?.c;
        if (!c || typeof c.tableName !== 'string' || typeof c.rowId !== 'string' || typeof c.updatedAt !== 'number' || !c.payload || typeof c.payload !== 'object') continue;
        const key = `${c.tableName}:${c.rowId}`;
        this.carried.set(key, c);
        this.carriedAt.set(key, typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : this.now());
      }
    } catch {
      console.error('[sync] 持ち越した行の覚えが読めなかったので捨てました');
    }
  }

  /**
   * 持ち越しを sync_state に覚える。空なら行を消す。
   * 差分では、頁を当てるたびに、区切り（lastSeq）を進める前に呼ぶ。
   * 区切りだけが先に進むと、その間にプロセスが落ちたとき、持ち越していた行は二度と降りてこない。
   *
   * 上限を超えたら、行は捨てずに、最初の写しをやり直す（写しの印を外す）。
   * 写しを読み直せば、親と子が同じ 1 巡にそろう。古い順に捨てると、版 17 の写し（時刻が 1 の名前とメモ）が真っ先に消える。
   * やり直しは 1 回の起動につき 1 度までである。やり直した後も超えていたら、覚えた時刻の古い順に捨てて記録に出す。
   * そのときも session_notes は最後に捨てる。利用者が書いた文章だからである。
   */
  /** 頁ごとの覚え。上限は見ない（見るのは 1 巡の終わりだけ。頁の途中では、親が後の頁に来るだけのことが多い）。 */
  private saveCarriedQuietly(): void {
    const next = this.carried.size === 0 ? null : JSON.stringify([...this.carried.entries()].map(([k, c]) => ({ c, at: this.carriedAt.get(k) ?? this.now() })));
    if (next !== this.state.get('orphans')) this.state.set('orphans', next);
  }

  private saveCarried(): void {
    const max = this.deps.maxCarriedRows ?? MAX_CARRIED_ROWS;
    if (this.carried.size > max) {
      if (this.overflowRedo === 'none') {
        this.overflowRedo = 'pending';
        this.state.set('snapshotDone', null);
        console.error(`[sync] 親の行が無いまま持ち越した行が上限（${max} 件）を超えたので、次の pull で最初の写しを読み直します`);
      } else if (this.overflowRedo === 'done') {
        const order = [...this.carried.keys()].sort((a, b) => {
          const notes = Number(this.carried.get(a)!.tableName === 'session_notes') - Number(this.carried.get(b)!.tableName === 'session_notes');
          return notes || (this.carriedAt.get(a) ?? 0) - (this.carriedAt.get(b) ?? 0) || (a < b ? -1 : 1);
        });
        const drop = order.slice(0, this.carried.size - max);
        for (const k of drop) this.uncarry(k);
        console.error(`[sync] 写しを読み直しても、親の行が無いまま持ち越した行が上限（${max} 件）を超えているので、古い ${drop.length} 件を捨てました`);
      }
    }
    this.saveCarriedQuietly();
  }

  /** 寿命を過ぎた持ち越しを捨てる。捨てたら記録に 1 行出す。 */
  private expireCarried(): void {
    const limit = this.now() - ORPHAN_KEEP_DAYS * 86_400_000;
    const old = [...this.carried.keys()].filter((k) => (this.carriedAt.get(k) ?? 0) < limit);
    if (old.length === 0) return;
    const tables = [...new Set(old.map((k) => this.carried.get(k)!.tableName))].sort().join('、');
    for (const k of old) this.uncarry(k);
    console.error(`[sync] 親の行が ${ORPHAN_KEEP_DAYS} 日たっても現れなかった行を ${old.length} 件捨てました（${tables}）`);
  }

  private applyPage(changes: ChangeOut[], skipOwn: boolean): number {
    const applied = applyRemoteBatch(this.deps.db, changes, { ownDeviceId: this.deps.deviceId, skipOwn, home: this.deps.home, onMemoConflict: this.deps.onMemoConflict, onSessionMemoBackup: this.deps.onSessionMemoBackup, onFailed: (c) => { this.carry(c); this.settling?.add(`${c.tableName}:${c.rowId}`); }, onOldSessionNote: (c) => { this.oldNotes.set(c.rowId, c); } });
    for (const c of applied) {
      // 持ち越していた行より新しい版が当たったら、古い持ち越しは要らない。
      const k = `${c.tableName}:${c.rowId}`;
      const old = this.carried.get(k);
      if (old && old.updatedAt <= c.updatedAt) this.uncarry(k);
      this.emit('applied', c);
    }
    return applied.length;
  }

  /** 古い形の sessions の行が持っていた名前とメモを、本物の行が届かなかったものだけ拾う。 */
  private adoptOldNotes(): void {
    if (this.oldNotes.size === 0) return;
    const rows = [...this.oldNotes.values()];
    this.oldNotes.clear();
    const made: string[] = [];
    this.deps.db.transaction(() => { for (const c of rows) if (adoptNoteFromOldSession(this.deps.db, c)) made.push(c.rowId); })();
    // 作った行は SessionDto に載る。配る層へ、同期で降りた行として知らせる（changes には積まない）。
    for (const id of made) noteApplied(this.deps.db, 'session_notes', id, 'upsert');
  }

  /**
   * 持ち越した行を、まとめて当て直す。写しを読み切った後と、差分を読み切った後に呼ぶ。
   * まだ当てられない行は持ち越したまま残し、数と表を記録に出す。黙って捨てない。
   * 自端末の行かどうかは、最初に落ちる前に見てあるので、ここでは見ない。
   */
  private settleCarried(endOfPass: boolean): number {
    let n = 0;
    if (this.carried.size > 0) {
      // 当て直す間も、持ち越しは消さない。当て直しが投げたら、そのまま残る。
      // 当たった行は applyPage が外す。まだ当てられない行は onFailed でもう一度ここへ来る。
      // どちらでもない行（手元の方が新しくて採らなかった行）は、もう要らないので外す。
      const before = new Map(this.carried);
      const failed = new Set<string>();
      this.settling = failed;
      try {
        n = this.applyPage([...before.values()], false);
      } finally {
        this.settling = null;
      }
      for (const [k, c] of before) if (!failed.has(k) && this.carried.get(k) === c) this.uncarry(k);
    }
    if (endOfPass) {
      // 古い形の行の名前とメモは、写しの後の差分まで読み切ってから拾う。差分で本物の行が届くことがある。
      this.adoptOldNotes();
      this.expireCarried();
    }
    if (this.carried.size > 0) {
      const tables = [...new Set([...this.carried.values()].map((c) => c.tableName))].sort().join('、');
      console.error(`[sync] 親の行が無いので当てられなかった行が ${this.carried.size} 件あります（${tables}）。覚えておき、次の pull でもう一度試します`);
    }
    return n;
  }

  /**
   * 写しと差分を 1 巡読む。
   *
   * 写し（GET /rows）は nextAfter が null になるまで読み切ってから lastSeq を進める。
   * 途中のページで止めて lastSeq だけ進めると、読まなかった鍵は差分にも載らないので永久に欠ける。
   * Worker は端末がどこまで読んだかを覚えていないので、やり直せるのはこちら側だけである。
   */
  private async pullPass(client: CloudClient, count: { applied: number }): Promise<void> {
    this.loadCarried();
    try {
      await this.readPass(client, count);
    } finally {
      // 1 巡の終わり（途中で失敗したときも）に、上限を見てから覚える。頁ごとの覚えは readPass の中にある。
      this.saveCarried();
    }
  }

  private async readPass(client: CloudClient, count: { applied: number }): Promise<void> {
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
        const page: SnapshotResponse = await client.snapshot(cursor, PULL_LIMIT);
        count.applied += this.applyPage(page.changes, false);
        after = page.nextAfter;
        if (seq === null) seq = page.seq;
      } while (after !== null);
      // 写しは鍵の辞書順なので、子の表が親の sessions より前の頁に来る。読み切ってから、落ちた行を当て直す。
      count.applied += this.settleCarried(false);
      // 上限を超えてやり直した写しを、読み切った。これでもそろわない行は、次に超えたときに捨てる。
      if (this.overflowRedo === 'pending') this.overflowRedo = 'done';
      // 持ち越しを先に覚えてから、区切りを進める。
      this.saveCarriedQuietly();
      this.state.set('lastSeq', seq ?? 0);
      this.state.set('snapshotDone', true);
    }
    let since = this.state.getNumber('lastSeq', 0);
    for (;;) {
      const at = since;
      const page = await client.pullChanges(at, PULL_LIMIT);
      count.applied += this.applyPage(page.changes, true);
      since = page.nextSeq;
      // 持ち越しを先に覚えてから、区切りを進める。逆だと、その間に落ちたときに持ち越した行を失う。
      this.saveCarriedQuietly();
      this.state.set('lastSeq', since);
      if (!page.more) break;
    }
    count.applied += this.settleCarried(true);
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
      this.clearPullError();
      this.emit('pulled');
    } catch (e) {
      this.failPull(e);
    }
    return { applied: count.applied };
  }

  /**
   * 利用者が押した「今すぐ同期」。push してから pull する。最小間隔は見ない。
   *
   * evenIfPaused を渡すと、一時停止していてもこの 1 巡だけは通す。
   * 止めた状態には触らないので、終われば元の一時停止に戻っている。
   * 版で止まっていても、上限で退いていても、利用者が押した 1 回は試し直す。
   * Worker を入れ替えた後と、上限が戻ったかを確かめたいときに、戻る道はここだけである。
   * まだ合わなければ、またはまだ上限なら、その 1 回の失敗でまた止まる（上限なら次の 0 時まで退いて知らせる）。
   * 上限の失敗が UTC の 0 時からの猶予の間なら、定期実行と同じく短く黙って退く。
   */
  async syncNow(o: { evenIfPaused?: boolean } = {}): Promise<void> {
    // 一時停止のまま何も送らない回では外さない。外すと、試してもいないのに表示だけが変わる。
    if (!this.paused || o.evenIfPaused || this.onePass) {
      this.compatBlock = null;
      this.state.set('limitedUntil', null);
    }
    if (!o.evenIfPaused || !this.paused || this.onePass) {
      await this.pushNow();
      await this.pullNow();
      return;
    }
    this.onePass = true;
    try {
      await this.pushNow();
      await this.pullNow();
    } finally {
      this.onePass = false;
    }
  }

  /** セッション起動の直前に呼ぶ。2 秒で諦めるが pull 自体は続く。 */
  async pullBeforeLaunch(timeoutMs = 2000): Promise<boolean> {
    if (!this.deps.client || this.paused || this.compatBlock !== null || this.limitedUntil() !== null) return false;
    let timer: NodeJS.Timeout | null = null;
    const gaveUp = new Promise<boolean>((r) => { timer = this.timers.setTimeout(() => r(false), timeoutMs); });
    const done = this.pulling ?? this.pullNow();
    // 見るのは pull の結果だけである。push が落ちていても、起動前に要るのは他端末の変更が届いたことだけである。
    const result = await Promise.race([done.then(() => this.pullError === null, () => false), gaveUp]);
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
