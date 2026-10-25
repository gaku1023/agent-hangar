import fs from 'node:fs';
import type { IndexProgressDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { upsertShared } from '../db/shared.ts';
import type { FileTranscriptSource, IndexBatch, PromptHistory, PromptHistoryEntry, TranscriptFile, TranscriptSink, TranscriptSource } from '../agent/types.ts';
import type { Timers } from '../sync/engine.ts';
import { writeBaselineIfNeeded } from './baseline.ts';
import { forgetTranscriptFile, indexFile, isUnchanged, markTruncatedForReindex, type FileStat } from './indexFile.ts';
import { ensureSession, writeBatch, type ProcessStartOf } from './write.ts';
import { stmt } from './statements.ts';

export type IndexerListener = {
  progress?: (p: IndexProgressDto) => void;
  /**
   * セッションの索引が変わった。path は本文のファイルで、本文を DB に持つエージェント（opencode）の束では null である（上げ手へは渡さない）。
   * deviceId は他端末から降ろした写しならその端末の id で、手元の本文（opencode の束も）では null である。
   */
  sessionChanged?: (e: { sessionId: string; providerSessionId: string; agentId: string | null; appended: number; artifactIds: string[]; deviceId: string | null; path: string | null }) => void;
  error?: (e: { path: string; message: string }) => void;
  /** 手元の本文ファイルが消え、そのセッションの索引を片付けた。hasTranscript が変わるので配り直す。 */
  transcriptGone?: (e: { sessionId: string }) => void;
  /**
   * 論理削除したセッションの、手元の主線の本文が見えた（索引は掘り起こさずに見送った）。
   * ゴミ箱から戻した本文かもしれないので、削除の受け持ち（sessions/trash.ts）が復元を確かめる。
   */
  deletedSeen?: (e: { sessionId: string; path: string }) => void;
};

export type IndexerServiceOptions = {
  db: Db;
  deviceId: string;
  /**
   * エージェントのトランスクリプトの面（いまは Claude の provider/claude-code/transcript/source.ts）。
   * どのファイルが本文か、どれを索引化するか、どこを見張るか、本文をどう読んで束にするかはここが決め、ここの索引はいつ見比べていつ索引化するかを決める。
   * 束を DB に書くのは indexer/write.ts である。
   */
  transcript: FileTranscriptSource;
  /**
   * 本文を DB に持つエージェントのトランスクリプトの面（opencode の provider/opencode/transcript/source.ts）。
   * 束を作って batch で押し込むだけなので、索引は start と stop を呼び、届いた束を書く。全件の見比べと見張りの周期には入らない。
   */
  stored?: readonly TranscriptSource[];
  isRunning: (providerSessionId: string) => boolean;
  /** 取りこぼし対策の全件走査の周期。既定は 5 分。 */
  sweepMs?: number;
  /** fs.watch が使えないときの全件走査の周期。既定は 10 秒。 */
  pollFallbackMs?: number;
  /** 変わった本文の名前を集めてから索引化するまでの間。既定は 300 ミリ秒。 */
  debounceMs?: number;
  /** 名前の分からない通知から全件走査までの間。既定は 1 秒。 */
  rescanDelayMs?: number;
  isYielded?: (sessionUuid: string) => boolean;
  /** 打った発言を出したプロセスの起動時刻を引く口。渡さなければ、発言で状態を外さない（提案は外す）。 */
  processStartOf?: ProcessStartOf;
  /** 押し込まれた束（opencode）のモデルのコンテキストの長さを引く口（write.ts の WriteOptions.contextSizeOf）。渡さなければ context_size を書かない。 */
  contextSizeOf?: (model: string) => number | null;
  /**
   * いま実行中のセッション（Claude Code のセッション ID と cwd）。
   * 渡すと、その主線とサブエージェントの本文だけは、通知に頼らず liveMs ごとに stat で見る。
   * Windows では、Claude Code が本文を開いたまま書き足すと、監視の通知が遅れうるためである。
   */
  liveSessions?: () => { sessionId: string; cwd: string }[];
  /** 実行中のセッションの本文を見る周期。既定は 2 秒。 */
  liveMs?: number;
  /** 試験が時計を差し替える口。 */
  timers?: Timers;
};

/** 進行中の走査に付ける段階。rebuild のときだけ rebuilding になる。 */
type ScanPhase = 'indexing' | 'rebuilding';
/** 索引に記録済みの、ファイルごとの大きさと更新時刻と版。 */
type KnownRow = { size: number; mtime: number; indexer_version: number };
type DiscoveredFile = TranscriptFile;
type HistoryEntry = PromptHistoryEntry;

const YIELD_EVERY = 20;
const HISTORY_DEBOUNCE_MS = 1000;
const SWEEP_MS = 5 * 60_000;
const POLL_FALLBACK_MS = 10_000;
const DEBOUNCE_MS = 300;
const RESCAN_DELAY_MS = 1000;
const LIVE_MS = 2000;
const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const yieldToLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** ファイルの大きさと更新時刻。読めなければ null。 */
function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * transcript の全走査と監視を受け持つ。
 * どのファイルが本文か、どこを見張るかはエージェントのトランスクリプトの面（opts.transcript）が決め、ここはいつ見比べていつ索引化するかを決める。
 * 1 ファイルの失敗は error に流して他のファイルの索引化を止めない。
 *
 * 待機中に何もしないことを優先する。
 * 監視の通知が名指ししたファイルだけを索引化し、全件の見比べは取りこぼし対策として 5 分に 1 度だけ小分けに回す。
 * 以前は 2 秒ごとに全件を stat し、ファイルごとに SQL を準備して引き、history.jsonl を頭から読んでいたので、
 * 数千ファイルの置き場では何も変わっていなくても CPU を使い続けた。
 */
export class IndexerService {
  private listeners = new Set<IndexerListener>();
  private state: IndexProgressDto = { phase: 'idle', done: 0, total: 0 };
  private flushTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private historyTimer: NodeJS.Timeout | null = null;
  private liveTimer: NodeJS.Timeout | null = null;
  /** 実行中のセッションの本文ごとの、前に見た大きさと更新時刻。 */
  private liveStamps = new Map<string, string>();
  /** sweepTimer が早めの全件走査（名前の分からない通知から）を待っているか。 */
  private sweepSoon = false;
  /** 全件走査の最中に、もう一度の全件走査を頼まれた。 */
  private sweepAgain = false;
  private scanning = false;
  private sweeping = false;
  private flushing = false;
  /** fullScan を始めるたびに増える。小分けの走査は、途中で fullScan が割り込んだら手を引く。 */
  private scanEpoch = 0;
  private running = false;
  /** 監視が名指しした、まだ索引化していない本文。 */
  private pending = new Map<string, DiscoveredFile>();
  /** 本文なしのセッションの登録を最後に回したときの history の版。 */
  private syncedHistory = -1;
  private inflight = new Set<Promise<unknown>>();
  /** 失敗を知らせたファイルと、そのときの大きさと更新時刻。同じ失敗を毎周期くり返さないために持つ。 */
  private reportedErrors = new Map<string, string>();

  /** トランスクリプトの面の見張りの知らせを受ける口。 */
  private readonly sink: TranscriptSink = {
    batch: (b) => this.onBatch(b),
    named: (file) => this.onNamed(file),
    rescan: () => this.requestSweep(),
    historyChanged: () => this.onHistoryChanged(),
    error: (where, message) => this.emitError(where, message),
  };

  constructor(private readonly opts: IndexerServiceOptions) {}

  private get timers(): Timers { return this.opts.timers ?? REAL_TIMERS; }
  private get transcript(): FileTranscriptSource { return this.opts.transcript; }

  on(listener: IndexerListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  progress(): IndexProgressDto { return this.state; }

  private setProgress(p: IndexProgressDto): void {
    this.state = p;
    for (const l of this.listeners) l.progress?.(p);
  }

  private emitError(filePath: string, message: string): void {
    for (const l of this.listeners) l.error?.({ path: filePath, message });
  }

  /**
   * 索引化するファイルを選び、外れたものと消えたものを索引から落とす。
   * 選ぶときに取った stat を返し、呼び手はそれを索引化に回して同じファイルを二度 stat しない。
   */
  private targets(): { files: DiscoveredFile[]; stats: Map<string, FileStat | null> } {
    const { index, drop, stats, seen } = this.transcript.scan({ isYielded: this.opts.isYielded });
    this.forgetDropped(drop);
    if (seen) this.forgetVanished(seen);
    return { files: index, stats };
  }

  private forgetDropped(drop: DiscoveredFile[]): void {
    for (const d of drop) {
      try { forgetTranscriptFile(this.opts.db, d.path); } catch (e) { this.emitError(d.path, errorMessage(e)); }
    }
  }

  /** 索引に記録済みの全ファイルの大きさと更新時刻と版を、1 回の問い合わせでまとめて引く。 */
  private knownFiles(): Map<string, KnownRow> {
    const rows = stmt(this.opts.db, 'select path, size, mtime, indexer_version from transcript_files').all() as (KnownRow & { path: string })[];
    return new Map(rows.map((r) => [r.path, r]));
  }

  /**
   * 索引にはあるのに、手元のファイルがもう無い行を片付ける。
   * Claude Code は保持期間を過ぎた本文を黙って消すので、放っておくと「本文あり」のまま開けない会話が残る。
   * 消すのは DB の行だけで、利用者のファイルには触れない。
   * 置き場そのものが見えないとき（外れたなど）は、トランスクリプトの面が seen を渡さないので呼ばない。全部を消してしまわないためである。
   * 他の PC の写し（device_id あり）は持ち主の同期が扱うので、ここでは見ない。
   * 全件を列挙したときだけ呼ぶ。
   */
  private forgetVanished(seen: Set<string>): void {
    const rows = stmt(this.opts.db, 'select path, session_id from transcript_files where device_id is null').all() as { path: string; session_id: string }[];
    const gone = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.path)) continue;
      try {
        fs.lstatSync(r.path);
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
      try {
        forgetTranscriptFile(this.opts.db, r.path);
        gone.add(r.session_id);
      } catch (e) {
        this.emitError(r.path, errorMessage(e));
      }
    }
    for (const sessionId of gone) {
      // 本文の索引（手元だけの表）が消えて、SessionDto の hasTranscript が変わった。行は書いていないので、配り直しを名指しで頼む。
      touchRow(this.opts.db, 'sessions', sessionId);
      for (const l of this.listeners) l.transcriptGone?.({ sessionId });
    }
  }

  /**
   * 1 ファイルを索引化し、変わっていたら土台の要約を書いて sessionChanged を出す。
   * stat は呼び手が取った大きさと更新時刻で、known は索引に記録済みの値をまとめて引いたものである。
   * 両方あって変わっていなければ、indexFile を呼ばずに返す（indexFile が何もせずに返す条件と同じ）。
   */
  private indexOne(file: DiscoveredFile, history: Map<string, HistoryEntry>, stat?: FileStat | null, known?: Map<string, KnownRow>): boolean {
    const st = stat === undefined ? statOrNull(file.path) : stat;
    const row = known?.get(file.path);
    if (st && row && isUnchanged(row, st)) {
      this.reportedErrors.delete(file.path);
      return false;
    }
    try {
      const r = indexFile(this.opts.db, file, { deviceId: this.opts.deviceId, reader: this.transcript, cwdFallback: history.get(file.sessionId)?.cwd, remote: file.deviceId !== null, processStartOf: this.opts.processStartOf, stat: st ?? undefined });
      this.reportedErrors.delete(file.path);
      if (r.skipped && r.sessionId !== '' && file.deviceId === null && file.agentId === null) {
        for (const l of this.listeners) l.deletedSeen?.({ sessionId: r.sessionId, path: file.path });
      }
      if (!r.changed) return false;
      // 土台の要約は共有テーブルなので、本文を持つ端末だけが書く。
      if (file.deviceId === null && (file.agentId === null || r.appended > 0)) {
        writeBaselineIfNeeded(this.opts.db, r.sessionId, this.opts.deviceId, this.opts.isRunning(file.sessionId));
      }
      // 索引は手元だけの表（本文の索引と集計）も書く。共有の行が動かなくても SessionDto は変わるので、配り直しを名指しで頼む。
      // 画面へ配るのは events/publisher.ts で、ここでは DTO を組まない。
      touchRow(this.opts.db, 'sessions', r.sessionId);
      for (const l of this.listeners) l.sessionChanged?.({ sessionId: r.sessionId, providerSessionId: file.sessionId, agentId: file.agentId, appended: r.appended, artifactIds: r.artifactIds, deviceId: file.deviceId, path: file.path });
      return true;
    } catch (e) {
      const message = errorMessage(e);
      try {
        stmt(this.opts.db, 'update transcript_files set last_error = ? where path = ?').run(message, file.path);
      } catch {
        // まだ行が無いか DB 側の失敗なので、通知だけに留める。
      }
      // 読めないファイルは走査のたびに同じ失敗を出し続けるので、大きさか更新時刻が変わるまで黙る。
      const now = statOrNull(file.path);
      const stamp = now ? `${now.size}:${Math.floor(now.mtimeMs)}` : 'unknown';
      if (this.reportedErrors.get(file.path) !== stamp) {
        this.reportedErrors.set(file.path, stamp);
        this.emitError(file.path, message);
      }
      return false;
    }
  }

  /** 全ファイルを列挙して索引化する。20 ファイルごとにイベントループへ譲る。 */
  async fullScan(phase: ScanPhase = 'indexing'): Promise<{ files: number; changed: number }> {
    if (this.scanning) return { files: 0, changed: 0 };
    this.scanning = true;
    this.scanEpoch++;
    try {
      this.setProgress({ phase: 'scanning', done: 0, total: 0 });
      const { files, stats } = this.targets();
      const history = this.transcript.history();
      const known = this.knownFiles();
      let changed = 0;
      this.setProgress({ phase, done: 0, total: files.length });
      for (let i = 0; i < files.length; i++) {
        if (this.indexOne(files[i]!, history.index, stats.get(files[i]!.path), known)) changed++;
        if (i % YIELD_EVERY === YIELD_EVERY - 1) {
          this.setProgress({ phase, done: i + 1, total: files.length });
          await yieldToLoop();
        }
      }
      this.syncHistoryOnly(history.index);
      this.syncedHistory = history.version;
      this.setProgress({ phase: 'idle', done: files.length, total: files.length });
      return { files: files.length, changed };
    } finally {
      this.scanning = false;
      // 走査の間に名指しされた本文は、走査が済んでから索引化する。
      if (this.running && this.pending.size > 0) this.scheduleFlush();
    }
  }

  /**
   * 全件を見比べる 1 周。20 ファイルごとに区切りを yield し、呼び手が同期で回すか、イベントループへ譲りながら回すかを決める。
   * 変わっていないファイルは、まとめて引いた索引の記録と stat を比べるだけで飛ばす。
   * history.jsonl が変わっていたときだけ、本文なしのセッションの登録を回す。
   */
  private *sweepSteps(): Generator<void, number> {
    const { files, stats } = this.targets();
    const history = this.transcript.history();
    const known = this.knownFiles();
    let changed = 0;
    for (let i = 0; i < files.length; i++) {
      if (this.indexOne(files[i]!, history.index, stats.get(files[i]!.path), known)) changed++;
      if (i % YIELD_EVERY === YIELD_EVERY - 1) yield;
    }
    this.syncHistoryIfChanged(history);
    return changed;
  }

  /** 全ファイルを stat で見比べ、変わったものだけ索引化する。イベントループへ譲らずに 1 度で回す。 */
  tick(): { changed: number } {
    const steps = this.sweepSteps();
    for (;;) {
      const r = steps.next();
      if (r.done) return { changed: r.value };
    }
  }

  /** tick と同じ見比べを、イベントループへ譲りながら回す。途中で fullScan が始まったら手を引く。 */
  private async sweep(): Promise<void> {
    if (this.scanning || this.sweeping) {
      this.sweepAgain = true;
      return;
    }
    this.sweeping = true;
    const epoch = this.scanEpoch;
    try {
      this.transcript.rewatch();
      const steps = this.sweepSteps();
      for (let r = steps.next(); !r.done; r = steps.next()) {
        await yieldToLoop();
        if (!this.running || this.scanEpoch !== epoch) {
          steps.return(0);
          break;
        }
      }
    } catch (e) {
      this.emitError(this.transcript.where.scan, errorMessage(e));
    } finally {
      this.sweeping = false;
      if (this.running) {
        if (this.sweepAgain) {
          this.sweepAgain = false;
          this.requestSweep();
        } else {
          this.armSweep();
        }
      }
    }
  }

  /**
   * history.jsonl にあって本文ファイルの無いセッションを「本文なし」として登録する。
   * 既に本文があるセッションは触らない。
   * 土台の要約は、行を書き換えたときと要約がまだ無いときだけ書き、走査のたびに changes を増やさない。
   */
  syncHistoryOnly(history: Map<string, HistoryEntry> = this.transcript.history().index): number {
    const db = this.opts.db;
    const hasMain = stmt(db, 'select 1 from transcript_files where session_id = ? and agent_id is null limit 1');
    const hasSummary = stmt(db, 'select 1 from session_summaries where session_id = ? limit 1');
    const getSession = stmt(db, 'select * from sessions where id = ?');
    const upsertStats = stmt(db, 'insert into session_stats (session_id, turns, last_prompt) values (?, ?, ?) on conflict(session_id) do update set turns = excluded.turns');
    let n = 0;
    for (const [providerSessionId, h] of history) {
      const sessionId = ensureSession(db, providerSessionId, h.cwd, this.opts.deviceId, this.transcript.agent);
      if (hasMain.get(sessionId)) continue;
      const cur = getSession.get(sessionId) as Record<string, unknown>;
      // 論理削除したセッション（削除したもの、本文の無いまま片付けたもの）は書き直さない。history.jsonl には消した後も残っている。
      if (cur.deleted_at != null) continue;
      const next = { ...cur, first_prompt: cur.first_prompt ?? h.firstDisplay, started_at: cur.started_at ?? h.firstTs, last_activity_at: h.lastTs };
      let touched = false;
      if (JSON.stringify(next) !== JSON.stringify(cur)) {
        upsertShared(db, 'sessions', next, this.opts.deviceId);
        touched = true;
        n++;
      }
      upsertStats.run(sessionId, h.count, h.firstDisplay);
      if (touched || !hasSummary.get(sessionId)) {
        writeBaselineIfNeeded(db, sessionId, this.opts.deviceId, this.opts.isRunning(providerSessionId));
      }
    }
    return n;
  }

  /** history.jsonl が前に登録を回したときから変わっていれば、本文なしのセッションの登録を回す。 */
  private syncHistoryIfChanged(history: PromptHistory = this.transcript.history()): void {
    if (history.version === this.syncedHistory) return;
    try {
      this.syncHistoryOnly(history.index);
      this.syncedHistory = history.version;
    } catch (e) {
      this.emitError(this.transcript.where.history, errorMessage(e));
    }
  }

  /** 名指しされた本文をまとめて索引化する。数が多ければ 20 ファイルごとにイベントループへ譲る。 */
  private async flush(): Promise<void> {
    if (!this.running) return;
    // 全走査の最中は、走査が済んでから回す（fullScan の終わりで予約し直す）。
    if (this.scanning || this.flushing) return;
    this.flushing = true;
    try {
      const batch = [...this.pending.values()];
      this.pending.clear();
      const history = this.transcript.history().index;
      for (let i = 0; i < batch.length; i++) {
        this.indexNamed(batch[i]!, history);
        if (i % YIELD_EVERY === YIELD_EVERY - 1) {
          await yieldToLoop();
          if (!this.running) return;
        }
      }
    } catch (e) {
      this.emitError(this.transcript.where.scan, errorMessage(e));
    } finally {
      this.flushing = false;
      if (this.running && this.pending.size > 0) this.scheduleFlush();
    }
  }

  /**
   * 監視が名指しした 1 ファイルを索引化する。
   * 同じ位置に他の候補（他端末の写しなど）があれば、全件走査と同じ規則で 1 つを選び、外れたものを索引から落とす。
   * ファイルが消えていたら、片付けは全件走査に任せる。
   */
  private indexNamed(file: DiscoveredFile, history: Map<string, HistoryEntry>): void {
    const st = statOrNull(file.path);
    if (!st) {
      this.requestSweep();
      return;
    }
    const { index, drop, stats, lost } = this.transcript.pick(file, st, { isYielded: this.opts.isYielded });
    if (lost) this.requestSweep();
    this.forgetDropped(drop);
    for (const f of index) this.indexOne(f, history, stats.get(f.path));
  }

  /**
   * 本文を DB に持つエージェントが押し込んだ束を書く。手元の本文なので、土台の要約も書く。
   * 書いたら、ファイルの本文と同じく sessionChanged を出す（プロジェクトへの紐づけ、伸びの知らせ、git の読み直し）。
   * 本文のファイルは無いので path は null で、同期の上げ手へは渡らない（opencode の本文は export を上げる。段 E）。
   */
  private onBatch(b: IndexBatch): void {
    if (!this.running) return;
    try {
      const r = writeBatch(this.opts.db, b, { deviceId: this.opts.deviceId, processStartOf: this.opts.processStartOf, contextSizeOf: this.opts.contextSizeOf });
      if (r.skipped) return;
      if (b.agentId === null || r.appended > 0) writeBaselineIfNeeded(this.opts.db, r.sessionId, this.opts.deviceId, this.opts.isRunning(b.providerSessionId));
      touchRow(this.opts.db, 'sessions', r.sessionId);
      for (const l of this.listeners) l.sessionChanged?.({ sessionId: r.sessionId, providerSessionId: b.providerSessionId, agentId: b.agentId, appended: r.appended, artifactIds: r.artifactIds, deviceId: null, path: null });
    } catch (e) {
      this.emitError(`${b.agent}:${b.providerSessionId}`, errorMessage(e));
    }
  }

  /** 監視が名指しした本文を集めて、最初の通知から debounce の後にまとめて索引化する。 */
  private onNamed(file: DiscoveredFile): void {
    if (!this.running) return;
    this.pending.set(file.path, file);
    this.scheduleFlush();
  }

  /** 本文の無い会話の覚えが変わったかもしれない。続けて変わる間は待ち、落ち着いてから登録を回す。 */
  private onHistoryChanged(): void {
    if (!this.running) return;
    if (this.historyTimer) this.timers.clearTimeout(this.historyTimer);
    this.historyTimer = this.timers.setTimeout(() => {
      this.historyTimer = null;
      this.syncHistoryIfChanged();
    }, HISTORY_DEBOUNCE_MS);
  }

  /**
   * 集めた名前の索引化を予約する。予約済みなら後ろへずらさない。
   * ずらすと、通知が debounce より短い間隔で続く間（サブエージェントが並んで書く間など）いつまでも索引化されない。
   */
  private scheduleFlush(): void {
    if (this.flushTimer || !this.running) return;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = null;
      this.track(this.flush());
    }, this.opts.debounceMs ?? DEBOUNCE_MS);
  }

  /**
   * 全件走査を早めに 1 回予約する。走査中なら、済んでからもう 1 回回す。予約済みなら重ねない。
   * 同期が他の PC の行や本文の写しを置いたときにも呼ばれる（boot/indexing.ts）。
   */
  requestSweep(): void {
    if (!this.running) return;
    if (this.sweeping || this.scanning) {
      this.sweepAgain = true;
      return;
    }
    if (this.sweepSoon) return;
    this.clearSweepTimer();
    this.sweepSoon = true;
    this.sweepTimer = this.timers.setTimeout(() => this.fireSweep(), this.opts.rescanDelayMs ?? RESCAN_DELAY_MS);
  }

  /** 次の定期の全件走査を予約する。監視が欠けていれば短めの周期にする。 */
  private armSweep(): void {
    if (!this.running) return;
    this.clearSweepTimer();
    const ms = this.transcript.healthy() ? (this.opts.sweepMs ?? SWEEP_MS) : (this.opts.pollFallbackMs ?? POLL_FALLBACK_MS);
    this.sweepTimer = this.timers.setTimeout(() => this.fireSweep(), ms);
  }

  private fireSweep(): void {
    this.sweepTimer = null;
    this.sweepSoon = false;
    this.track(this.sweep());
  }

  private clearSweepTimer(): void {
    if (this.sweepTimer) this.timers.clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
    this.sweepSoon = false;
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.then(() => this.inflight.delete(p), () => this.inflight.delete(p));
  }

  /**
   * 実行中のセッションの数が変わったかもしれない。実行中が 1 本でもあれば見張りの周期を張り、0 本なら外す。
   * 登録の変化（boot/indexing.ts の registry.onChange）から呼ぶ。
   */
  noteLiveChanged(): void {
    if (!this.running || !this.opts.liveSessions) return;
    if (this.opts.liveSessions().length === 0) {
      if (this.liveTimer) this.timers.clearTimeout(this.liveTimer);
      this.liveTimer = null;
      this.liveStamps.clear();
      return;
    }
    if (this.liveTimer) return;
    this.liveTimer = this.timers.setTimeout(() => {
      this.liveTimer = null;
      try {
        this.checkLive();
      } catch (e) {
        this.emitError(this.transcript.where.scan, errorMessage(e));
      }
      this.noteLiveChanged();
    }, this.opts.liveMs ?? LIVE_MS);
  }

  /** 実行中のセッションの本文を stat し、前に見たときから変わったものだけを索引化する。 */
  private checkLive(): void {
    const live = this.opts.liveSessions?.() ?? [];
    if (this.scanning) return;
    const seen = new Set<string>();
    let history: Map<string, HistoryEntry> | null = null;
    for (const s of live) {
      for (const f of this.transcript.liveFiles(s.sessionId, s.cwd)) {
        const st = statOrNull(f.path);
        if (!st) continue;
        seen.add(f.path);
        const stamp = `${st.size}:${st.mtimeMs}`;
        if (this.liveStamps.get(f.path) === stamp) continue;
        this.liveStamps.set(f.path, stamp);
        history ??= this.transcript.history().index;
        this.indexNamed(f, history);
      }
    }
    for (const p of this.liveStamps.keys()) if (!seen.has(p)) this.liveStamps.delete(p);
  }

  /** 走り出した索引化と全件走査が済むまで待つ。試験が時計を進めた後に使う。 */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /**
   * 監視を付けてから全走査し、以後は通知が名指しした本文だけを索引化する。
   * 全走査より先に監視を付けるのは、走査の間に伸びた本文の通知を取りこぼさないためである（走査が済んでから索引化する）。
   * fs.watch が使えなければ、全件走査を短めの周期で回して追従する。
   */
  async start(): Promise<void> {
    this.running = true;
    this.transcript.start(this.sink);
    for (const t of this.opts.stored ?? []) t.start(this.sink);
    // 前の版が先頭からの索引を消してしまったファイルは、この全走査で先頭から読み直す。
    markTruncatedForReindex(this.opts.db);
    await this.fullScan();
    this.armSweep();
    this.noteLiveChanged();
  }

  stop(): void {
    this.running = false;
    this.transcript.stop();
    for (const t of this.opts.stored ?? []) t.stop();
    if (this.flushTimer) this.timers.clearTimeout(this.flushTimer);
    if (this.historyTimer) this.timers.clearTimeout(this.historyTimer);
    if (this.liveTimer) this.timers.clearTimeout(this.liveTimer);
    this.flushTimer = this.historyTimer = this.liveTimer = null;
    this.liveStamps.clear();
    this.clearSweepTimer();
    this.pending.clear();
  }

  /** 索引の版を 0 に戻して全件を作り直す。indexFile 側が古い版の行を消してから入れ直す。 */
  async rebuild(): Promise<void> {
    stmt(this.opts.db, 'update transcript_files set indexer_version = 0').run();
    await this.fullScan('rebuilding');
  }
}
