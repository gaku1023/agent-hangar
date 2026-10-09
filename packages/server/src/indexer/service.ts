import fs from 'node:fs';
import path from 'node:path';
import type { IndexProgressDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { upsertShared } from '../db/shared.ts';
import { listRemoteTranscriptFiles, listTranscriptFiles, readHistoryIndex, selectFilesToIndex, type HistoryEntry } from '../provider/claude-code/transcript/discover.ts';
import type { TranscriptCompat } from '../provider/claude-code/compat/transcript.ts';
import type { DiscoveredFile } from '../provider/claude-code/types.ts';
import { writeBaselineIfNeeded } from './baseline.ts';
import { ensureSession, forgetTranscriptFile, indexFile, type ProcessStartOf } from './indexFile.ts';

export type IndexerListener = {
  progress?: (p: IndexProgressDto) => void;
  sessionChanged?: (e: { sessionId: string; providerSessionId: string; agentId: string | null; appended: number; artifactIds: string[]; deviceId: string | null; path: string }) => void;
  error?: (e: { path: string; message: string }) => void;
  /** 手元の本文ファイルが消え、そのセッションの索引を片付けた。hasTranscript が変わるので配り直す。 */
  transcriptGone?: (e: { sessionId: string }) => void;
};

export type IndexerServiceOptions = {
  db: Db;
  deviceId: string;
  claudeDir: string;
  isRunning: (providerSessionId: string) => boolean;
  pollMs?: number;
  debounceMs?: number;
  /** 他端末の本文の置き場（~/.agent-hangar/remote）。渡さなければ手元だけを索引化する。 */
  remoteRoot?: string;
  isYielded?: (sessionUuid: string) => boolean;
  /** 打った発言を出したプロセスの起動時刻を引く口。渡さなければ、発言で状態を外さない（提案は外す）。 */
  processStartOf?: ProcessStartOf;
  /** 手元の本文の行を Claude Code との互換の契約で見張る口。渡さなければ見張らない。 */
  compat?: TranscriptCompat;
};

/** 進行中の走査に付ける段階。rebuild のときだけ rebuilding になる。 */
type ScanPhase = 'indexing' | 'rebuilding';

const YIELD_EVERY = 20;
const HISTORY_DEBOUNCE_MS = 1000;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** ファイルの大きさと更新時刻。読めなければ固定の印を返す。 */
function fileStamp(filePath: string): string {
  try {
    const st = fs.statSync(filePath);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return 'unknown';
  }
}

/**
 * transcript の全走査と監視を受け持つ。
 * ~/.claude 配下は fs.watch と読み取りだけで触り、書き込みは一切しない。
 * 1 ファイルの失敗は error に流して他のファイルの索引化を止めない。
 */
export class IndexerService {
  private listeners = new Set<IndexerListener>();
  private state: IndexProgressDto = { phase: 'idle', done: 0, total: 0 };
  private watchers: fs.FSWatcher[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private historyTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  /** 失敗を知らせたファイルと、そのときの大きさと更新時刻。同じ失敗を毎周期くり返さないために持つ。 */
  private reportedErrors = new Map<string, string>();

  constructor(private readonly opts: IndexerServiceOptions) {}

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

  /** 索引化するファイルを選び、外れたものを索引から落とす。 */
  private targets(): DiscoveredFile[] {
    const local = listTranscriptFiles(this.opts.claudeDir);
    const remote = this.opts.remoteRoot ? listRemoteTranscriptFiles(this.opts.remoteRoot) : [];
    const { index, drop } = selectFilesToIndex([...local, ...remote], { isYielded: this.opts.isYielded });
    for (const d of drop) {
      try { forgetTranscriptFile(this.opts.db, d.path); } catch (e) { this.emitError(d.path, errorMessage(e)); }
    }
    this.forgetVanished(new Set([...local, ...remote].map((f) => f.path)));
    return index;
  }

  /**
   * 索引にはあるのに、手元のファイルがもう無い行を片付ける。
   * Claude Code は保持期間を過ぎた本文を黙って消すので、放っておくと「本文あり」のまま開けない会話が残る。
   * 消すのは DB の行だけで、利用者のファイルには触れない。
   * projects そのものが見えないとき（置き場が外れたなど）は、全部を消してしまわないよう何もしない。
   * 他の PC の写し（device_id あり）は持ち主の同期が扱うので、ここでは見ない。
   */
  private forgetVanished(seen: Set<string>): void {
    if (!fs.existsSync(path.join(this.opts.claudeDir, 'projects'))) return;
    const rows = this.opts.db.prepare('select path, session_id from transcript_files where device_id is null').all() as { path: string; session_id: string }[];
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

  /** 1 ファイルを索引化し、変わっていたら土台の要約を書いて sessionChanged を出す。 */
  private indexOne(file: DiscoveredFile, history: Map<string, HistoryEntry>): boolean {
    try {
      const r = indexFile(this.opts.db, file, { deviceId: this.opts.deviceId, cwdFallback: history.get(file.sessionId)?.cwd, remote: file.deviceId !== null, processStartOf: this.opts.processStartOf, compat: this.opts.compat });
      this.reportedErrors.delete(file.path);
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
        this.opts.db.prepare('update transcript_files set last_error = ? where path = ?').run(message, file.path);
      } catch {
        // まだ行が無いか DB 側の失敗なので、通知だけに留める。
      }
      // 読めないファイルは 2 秒ごとに同じ失敗を出し続けるので、大きさか更新時刻が変わるまで黙る。
      const stamp = fileStamp(file.path);
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
    try {
      this.setProgress({ phase: 'scanning', done: 0, total: 0 });
      const files = this.targets();
      const history = readHistoryIndex(this.opts.claudeDir);
      let changed = 0;
      this.setProgress({ phase, done: 0, total: files.length });
      for (let i = 0; i < files.length; i++) {
        if (this.indexOne(files[i]!, history)) changed++;
        if (i % YIELD_EVERY === YIELD_EVERY - 1) {
          this.setProgress({ phase, done: i + 1, total: files.length });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      this.syncHistoryOnly(history);
      this.setProgress({ phase: 'idle', done: files.length, total: files.length });
      return { files: files.length, changed };
    } finally {
      this.scanning = false;
    }
  }

  /** 全ファイルを stat で見比べ、変わったものだけ索引化する。 */
  tick(): { changed: number } {
    const history = readHistoryIndex(this.opts.claudeDir);
    let changed = 0;
    for (const f of this.targets()) if (this.indexOne(f, history)) changed++;
    return { changed };
  }

  /**
   * history.jsonl にあって本文ファイルの無いセッションを「本文なし」として登録する。
   * 既に本文があるセッションは触らない。
   * 土台の要約は、行を書き換えたときと要約がまだ無いときだけ書き、走査のたびに changes を増やさない。
   */
  syncHistoryOnly(history: Map<string, HistoryEntry> = readHistoryIndex(this.opts.claudeDir)): number {
    const db = this.opts.db;
    const hasMain = db.prepare('select 1 from transcript_files where session_id = ? and agent_id is null limit 1');
    const hasSummary = db.prepare('select 1 from session_summaries where session_id = ? limit 1');
    const getSession = db.prepare('select * from sessions where id = ?');
    const upsertStats = db.prepare('insert into session_stats (session_id, turns, last_prompt) values (?, ?, ?) on conflict(session_id) do update set turns = excluded.turns');
    let n = 0;
    for (const [providerSessionId, h] of history) {
      const sessionId = ensureSession(db, providerSessionId, h.cwd, this.opts.deviceId);
      if (hasMain.get(sessionId)) continue;
      const cur = getSession.get(sessionId) as Record<string, unknown>;
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

  /** 例外を error に流しながら tick を回す。監視と定期実行から呼ぶ。 */
  private safeTick(): void {
    if (this.scanning) return;
    try {
      this.tick();
    } catch (e) {
      this.emitError(path.join(this.opts.claudeDir, 'projects'), errorMessage(e));
    }
  }

  private safeSyncHistoryOnly(): void {
    try {
      this.syncHistoryOnly();
    } catch (e) {
      this.emitError(path.join(this.opts.claudeDir, 'history.jsonl'), errorMessage(e));
    }
  }

  /** 全走査してから fs.watch と定期 tick で追従する。fs.watch が使えなければ定期 tick だけで動く。 */
  async start(): Promise<void> {
    await this.fullScan();
    const projects = path.join(this.opts.claudeDir, 'projects');
    const schedule = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => { this.debounceTimer = null; this.safeTick(); }, this.opts.debounceMs ?? 300);
    };
    try {
      if (fs.existsSync(projects)) this.watchers.push(fs.watch(projects, { recursive: true }, schedule));
      this.watchers.push(fs.watch(this.opts.claudeDir, (_event, name) => {
        if (name !== 'history.jsonl') return;
        if (this.historyTimer) clearTimeout(this.historyTimer);
        this.historyTimer = setTimeout(() => { this.historyTimer = null; this.safeSyncHistoryOnly(); }, HISTORY_DEBOUNCE_MS);
      }));
      for (const w of this.watchers) w.on('error', (e) => this.emitError(projects, `fs.watch error: ${errorMessage(e)}`));
    } catch (e) {
      this.emitError(projects, `fs.watch failed, polling only: ${errorMessage(e)}`);
    }
    // 他端末の本文は puller が書き足すので、置き場も同じように見張る。
    if (this.opts.remoteRoot) {
      // 他端末の会話の本文なので、本人だけが読める権限で作る（puller 側も同じ 0700 で作る）。
      fs.mkdirSync(this.opts.remoteRoot, { recursive: true, mode: 0o700 });
      try {
        const w = fs.watch(this.opts.remoteRoot, { recursive: true }, schedule);
        w.on('error', (e) => this.emitError(this.opts.remoteRoot!, `fs.watch error: ${errorMessage(e)}`));
        this.watchers.push(w);
      } catch (e) {
        this.emitError(this.opts.remoteRoot, `fs.watch failed, polling only: ${errorMessage(e)}`);
      }
    }
    this.pollTimer = setInterval(() => this.safeTick(), this.opts.pollMs ?? 2000);
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.pollTimer = this.debounceTimer = this.historyTimer = null;
  }

  /** 索引の版を 0 に戻して全件を作り直す。indexFile 側が古い版の行を消してから入れ直す。 */
  async rebuild(): Promise<void> {
    this.opts.db.prepare('update transcript_files set indexer_version = 0').run();
    await this.fullScan('rebuilding');
  }
}
