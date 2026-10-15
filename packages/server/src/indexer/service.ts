import fs from 'node:fs';
import path from 'node:path';
import type { IndexProgressDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { upsertShared } from '../db/shared.ts';
import {
  AGENT_FILE_RE, classifyProjectsEntry, classifyRemoteEntry, HistoryIndexReader, listRemoteTranscriptFiles, listTranscriptFiles, mangleCwd, selectFilesToIndex,
  type HistoryEntry, type HistoryRead, type WatchedEntry,
} from '../provider/claude-code/transcript/discover.ts';
import type { TranscriptCompat } from '../provider/claude-code/compat/transcript.ts';
import type { DiscoveredFile } from '../provider/claude-code/types.ts';
import type { Timers } from '../sync/engine.ts';
import { writeBaselineIfNeeded } from './baseline.ts';
import { ensureSession, forgetTranscriptFile, indexFile, isUnchanged, markTruncatedForReindex, type FileStat, type ProcessStartOf } from './indexFile.ts';
import { stmt } from './statements.ts';

export type IndexerListener = {
  progress?: (p: IndexProgressDto) => void;
  sessionChanged?: (e: { sessionId: string; providerSessionId: string; agentId: string | null; appended: number; artifactIds: string[]; deviceId: string | null; path: string }) => void;
  error?: (e: { path: string; message: string }) => void;
  /** 手元の本文ファイルが消え、そのセッションの索引を片付けた。hasTranscript が変わるので配り直す。 */
  transcriptGone?: (e: { sessionId: string }) => void;
  /**
   * 論理削除したセッションの、手元の主線の本文が見えた（索引は掘り起こさずに見送った）。
   * ゴミ箱から戻した本文かもしれないので、削除の受け持ち（sessions/trash.ts）が復元を確かめる。
   */
  deletedSeen?: (e: { sessionId: string; path: string }) => void;
};

/** fs.watch の形。試験が通知を自分で起こすために差し替える。 */
export type WatchFn = (
  dir: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => { close(): void; on(event: 'error', listener: (e: Error) => void): unknown };

export type IndexerServiceOptions = {
  db: Db;
  deviceId: string;
  claudeDir: string;
  isRunning: (providerSessionId: string) => boolean;
  /** 取りこぼし対策の全件走査の周期。既定は 5 分。 */
  sweepMs?: number;
  /** fs.watch が使えないときの全件走査の周期。既定は 10 秒。 */
  pollFallbackMs?: number;
  /** 変わった本文の名前を集めてから索引化するまでの間。既定は 300 ミリ秒。 */
  debounceMs?: number;
  /** 名前の分からない通知から全件走査までの間。既定は 1 秒。 */
  rescanDelayMs?: number;
  /** 他端末の本文の置き場（~/.agent-hangar/remote）。渡さなければ手元だけを索引化する。 */
  remoteRoot?: string;
  isYielded?: (sessionUuid: string) => boolean;
  /** 打った発言を出したプロセスの起動時刻を引く口。渡さなければ、発言で状態を外さない（提案は外す）。 */
  processStartOf?: ProcessStartOf;
  /** 手元の本文の行を Claude Code との互換の契約で見張る口。渡さなければ見張らない。 */
  compat?: TranscriptCompat;
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
  /** 試験が fs.watch を差し替える口。 */
  watch?: WatchFn;
};

/** 進行中の走査に付ける段階。rebuild のときだけ rebuilding になる。 */
type ScanPhase = 'indexing' | 'rebuilding';
/** 索引に記録済みの、ファイルごとの大きさと更新時刻と版。 */
type KnownRow = { size: number; mtime: number; indexer_version: number };
type WatchKey = 'projects' | 'claude' | 'remote';

const YIELD_EVERY = 20;
const HISTORY_DEBOUNCE_MS = 1000;
const SWEEP_MS = 5 * 60_000;
const POLL_FALLBACK_MS = 10_000;
const DEBOUNCE_MS = 300;
const RESCAN_DELAY_MS = 1000;
const LIVE_MS = 2000;
const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };
const realWatch: WatchFn = (dir, options, listener) => fs.watch(dir, options, listener);

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const groupKey = (f: DiscoveredFile): string => `${f.sessionId}:${f.agentId ?? ''}`;
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
 * ~/.claude 配下は fs.watch と読み取りだけで触り、書き込みは一切しない。
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
  private watchers = new Map<WatchKey, { close(): void }>();
  /** 監視を付けられなかったと知らせた置き場。同じ失敗を走査のたびにくり返さない。 */
  private watchFailReported = new Set<WatchKey>();
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
  /** 最後の全件走査で見た、同じ位置（主線かサブエージェント）ごとの候補。名指しされたファイルを全件走査と同じ規則で選ぶのに使う。 */
  private groups = new Map<string, DiscoveredFile[]>();
  private history: HistoryIndexReader;
  /** 本文なしのセッションの登録を最後に回したときの history の版。 */
  private syncedHistory = -1;
  private inflight = new Set<Promise<unknown>>();
  /** 失敗を知らせたファイルと、そのときの大きさと更新時刻。同じ失敗を毎周期くり返さないために持つ。 */
  private reportedErrors = new Map<string, string>();

  constructor(private readonly opts: IndexerServiceOptions) {
    this.history = new HistoryIndexReader(opts.claudeDir);
  }

  private get timers(): Timers { return this.opts.timers ?? REAL_TIMERS; }
  private get projectsDir(): string { return path.join(this.opts.claudeDir, 'projects'); }

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
  private targets(): { files: DiscoveredFile[]; stats: Map<string, fs.Stats | null> } {
    const local = listTranscriptFiles(this.opts.claudeDir);
    const remote = this.opts.remoteRoot ? listRemoteTranscriptFiles(this.opts.remoteRoot) : [];
    const all = [...local, ...remote];
    const stats = new Map<string, fs.Stats | null>();
    const statOf = (p: string): fs.Stats | null => {
      if (!stats.has(p)) stats.set(p, statOrNull(p));
      return stats.get(p) ?? null;
    };
    const { index, drop } = selectFilesToIndex(all, { statOf, isYielded: this.opts.isYielded });
    this.forgetDropped(drop);
    this.forgetVanished(new Set(all.map((f) => f.path)));
    const groups = new Map<string, DiscoveredFile[]>();
    for (const f of all) {
      const g = groups.get(groupKey(f));
      if (g) g.push(f);
      else groups.set(groupKey(f), [f]);
    }
    this.groups = groups;
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
   * projects そのものが見えないとき（置き場が外れたなど）は、全部を消してしまわないよう何もしない。
   * 他の PC の写し（device_id あり）は持ち主の同期が扱うので、ここでは見ない。
   * 全件を列挙したときだけ呼ぶ。
   */
  private forgetVanished(seen: Set<string>): void {
    if (!fs.existsSync(this.projectsDir)) return;
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
  private indexOne(file: DiscoveredFile, history: Map<string, HistoryEntry>, stat?: fs.Stats | null, known?: Map<string, KnownRow>): boolean {
    const st = stat === undefined ? statOrNull(file.path) : stat;
    const row = known?.get(file.path);
    if (st && row && isUnchanged(row, st)) {
      this.reportedErrors.delete(file.path);
      return false;
    }
    try {
      const r = indexFile(this.opts.db, file, { deviceId: this.opts.deviceId, cwdFallback: history.get(file.sessionId)?.cwd, remote: file.deviceId !== null, processStartOf: this.opts.processStartOf, compat: this.opts.compat, stat: st ?? undefined });
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
      const history = this.history.read();
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
    const history = this.history.read();
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
      this.ensureWatchers();
      const steps = this.sweepSteps();
      for (let r = steps.next(); !r.done; r = steps.next()) {
        await yieldToLoop();
        if (!this.running || this.scanEpoch !== epoch) {
          steps.return(0);
          break;
        }
      }
    } catch (e) {
      this.emitError(this.projectsDir, errorMessage(e));
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
  syncHistoryOnly(history: Map<string, HistoryEntry> = this.history.read().index): number {
    const db = this.opts.db;
    const hasMain = stmt(db, 'select 1 from transcript_files where session_id = ? and agent_id is null limit 1');
    const hasSummary = stmt(db, 'select 1 from session_summaries where session_id = ? limit 1');
    const getSession = stmt(db, 'select * from sessions where id = ?');
    const upsertStats = stmt(db, 'insert into session_stats (session_id, turns, last_prompt) values (?, ?, ?) on conflict(session_id) do update set turns = excluded.turns');
    let n = 0;
    for (const [providerSessionId, h] of history) {
      const sessionId = ensureSession(db, providerSessionId, h.cwd, this.opts.deviceId);
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
  private syncHistoryIfChanged(history: HistoryRead = this.history.read()): void {
    if (history.version === this.syncedHistory) return;
    try {
      this.syncHistoryOnly(history.index);
      this.syncedHistory = history.version;
    } catch (e) {
      this.emitError(path.join(this.opts.claudeDir, 'history.jsonl'), errorMessage(e));
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
      const history = this.history.read().index;
      for (let i = 0; i < batch.length; i++) {
        this.indexNamed(batch[i]!, history);
        if (i % YIELD_EVERY === YIELD_EVERY - 1) {
          await yieldToLoop();
          if (!this.running) return;
        }
      }
    } catch (e) {
      this.emitError(this.projectsDir, errorMessage(e));
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
    const key = groupKey(file);
    const others = (this.groups.get(key) ?? []).filter((g) => g.path !== file.path);
    if (others.length === 0) {
      this.groups.set(key, [file]);
      this.indexOne(file, history, st);
      return;
    }
    const stats = new Map<string, fs.Stats>([[file.path, st]]);
    const alive = [file];
    for (const g of others) {
      const s = statOrNull(g.path);
      if (s) {
        stats.set(g.path, s);
        alive.push(g);
      } else {
        this.requestSweep();
      }
    }
    this.groups.set(key, alive);
    const { index, drop } = selectFilesToIndex(alive, { statOf: (p) => stats.get(p) ?? null, isYielded: this.opts.isYielded });
    this.forgetDropped(drop);
    for (const f of index) this.indexOne(f, history, stats.get(f.path));
  }

  /** 監視の通知を受ける。名指しされた本文は集めて、最初の通知から debounce の後にまとめて索引化する。 */
  private onWatched(entry: WatchedEntry | null): void {
    if (!this.running) return;
    if (entry === null || entry.kind === 'rescan') {
      this.requestSweep();
      return;
    }
    if (entry.kind === 'ignore') return;
    this.pending.set(entry.file.path, entry.file);
    this.scheduleFlush();
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
    const ms = this.watchesHealthy() ? (this.opts.sweepMs ?? SWEEP_MS) : (this.opts.pollFallbackMs ?? POLL_FALLBACK_MS);
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
        this.emitError(this.projectsDir, errorMessage(e));
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
      for (const f of this.liveFilesOf(s.sessionId, s.cwd)) {
        const st = statOrNull(f.path);
        if (!st) continue;
        seen.add(f.path);
        const stamp = `${st.size}:${st.mtimeMs}`;
        if (this.liveStamps.get(f.path) === stamp) continue;
        this.liveStamps.set(f.path, stamp);
        history ??= this.history.read().index;
        this.indexNamed(f, history);
      }
    }
    for (const p of this.liveStamps.keys()) if (!seen.has(p)) this.liveStamps.delete(p);
  }

  /**
   * 実行中のセッションの手元の本文。主線は全件走査で見た場所を使い、まだ見ていなければ cwd から組む。
   * サブエージェントは、主線の隣の <セッション>/subagents を読んで、途中で増えたものも拾う。
   */
  private liveFilesOf(sessionId: string, cwd: string): DiscoveredFile[] {
    const known = (this.groups.get(`${sessionId}:`) ?? []).find((f) => f.deviceId === null);
    const main: DiscoveredFile = known ?? { path: path.join(this.projectsDir, mangleCwd(cwd), `${sessionId}.jsonl`), sessionId, agentId: null, deviceId: null };
    const out = [main];
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(path.dirname(main.path), sessionId, 'subagents'));
    } catch {
      // サブエージェントがまだ無い。
    }
    for (const n of names) {
      const m = AGENT_FILE_RE.exec(n);
      if (m) out.push({ path: path.join(path.dirname(main.path), sessionId, 'subagents', n), sessionId, agentId: m[1]!, deviceId: null });
    }
    return out;
  }

  /** 走り出した索引化と全件走査が済むまで待つ。試験が時計を進めた後に使う。 */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** 見張るべき置き場に、どれも監視が付いているか。欠けていれば全件走査を短めの周期で回す。 */
  private watchesHealthy(): boolean {
    return this.watchers.has('claude') && this.watchers.has('projects') && (!this.opts.remoteRoot || this.watchers.has('remote'));
  }

  /** 付いていない監視を付ける。置き場がまだ無いものは、現れてから付ける。 */
  private ensureWatchers(): void {
    this.attach('claude', this.opts.claudeDir, false, (name) => this.onClaudeDirName(name));
    if (fs.existsSync(this.projectsDir)) {
      this.attach('projects', this.projectsDir, true, (name) => this.onWatched(name === null ? null : classifyProjectsEntry(this.projectsDir, name, null)));
    }
    const remoteRoot = this.opts.remoteRoot;
    if (remoteRoot) {
      this.attach('remote', remoteRoot, true, (name) => this.onWatched(name === null ? null : classifyRemoteEntry(remoteRoot, name)));
    }
  }

  private attach(key: WatchKey, dir: string, recursive: boolean, onName: (name: string | null) => void): void {
    if (this.watchers.has(key)) return;
    const watchFn = this.opts.watch ?? realWatch;
    try {
      const w = watchFn(dir, { recursive }, (_event, name) => onName(name === null || name === undefined ? null : String(name)));
      w.on('error', (e) => {
        this.emitError(dir, `fs.watch error: ${errorMessage(e)}`);
        // 監視が壊れた。外して短めの周期の全件走査に切り替え、次の走査で付け直す。
        if (this.watchers.get(key) === w) {
          this.watchers.delete(key);
          try { w.close(); } catch { /* もう閉じている */ }
        }
        this.requestSweep();
      });
      this.watchers.set(key, w);
      this.watchFailReported.delete(key);
    } catch (e) {
      if (!this.watchFailReported.has(key)) {
        this.watchFailReported.add(key);
        this.emitError(dir, `fs.watch failed, polling only: ${errorMessage(e)}`);
      }
    }
  }

  /** ~/.claude そのものの通知。history.jsonl の追記と、projects が現れたことだけを見る。 */
  private onClaudeDirName(name: string | null): void {
    if (!this.running) return;
    if (name === null || name === 'history.jsonl') {
      if (this.historyTimer) this.timers.clearTimeout(this.historyTimer);
      this.historyTimer = this.timers.setTimeout(() => {
        this.historyTimer = null;
        this.syncHistoryIfChanged();
      }, HISTORY_DEBOUNCE_MS);
    }
    if (name === 'projects' && !this.watchers.has('projects')) {
      this.ensureWatchers();
      this.requestSweep();
    }
  }

  /**
   * 監視を付けてから全走査し、以後は通知が名指しした本文だけを索引化する。
   * 全走査より先に監視を付けるのは、走査の間に伸びた本文の通知を取りこぼさないためである（走査が済んでから索引化する）。
   * fs.watch が使えなければ、全件走査を短めの周期で回して追従する。
   */
  async start(): Promise<void> {
    this.running = true;
    // 他端末の会話の本文なので、本人だけが読める権限で作る（puller 側も同じ 0700 で作る）。
    if (this.opts.remoteRoot) fs.mkdirSync(this.opts.remoteRoot, { recursive: true, mode: 0o700 });
    this.ensureWatchers();
    // 前の版が先頭からの索引を消してしまったファイルは、この全走査で先頭から読み直す。
    markTruncatedForReindex(this.opts.db);
    await this.fullScan();
    this.armSweep();
    this.noteLiveChanged();
  }

  stop(): void {
    this.running = false;
    for (const w of this.watchers.values()) {
      try { w.close(); } catch { /* もう閉じている */ }
    }
    this.watchers.clear();
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
