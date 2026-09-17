import fs from 'node:fs';
import path from 'node:path';
import type { IndexProgressDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { listTranscriptFiles, readHistoryIndex, type HistoryEntry } from '../provider/claude-code/discover.ts';
import type { DiscoveredFile } from '../provider/types.ts';
import { writeBaselineIfNeeded } from './baseline.ts';
import { ensureSession, indexFile } from './indexFile.ts';

export type IndexerListener = {
  progress?: (p: IndexProgressDto) => void;
  sessionChanged?: (e: { sessionId: string; providerSessionId: string; agentId: string | null; appended: number }) => void;
  error?: (e: { path: string; message: string }) => void;
};

export type IndexerServiceOptions = {
  db: Db;
  deviceId: string;
  claudeDir: string;
  isRunning: (providerSessionId: string) => boolean;
  pollMs?: number;
  debounceMs?: number;
};

/** 進行中の走査に付ける段階。rebuild のときだけ rebuilding になる。 */
type ScanPhase = 'indexing' | 'rebuilding';

const YIELD_EVERY = 20;
const HISTORY_DEBOUNCE_MS = 1000;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

  /** 1 ファイルを索引化し、変わっていたら土台の要約を書いて sessionChanged を出す。 */
  private indexOne(file: DiscoveredFile, history: Map<string, HistoryEntry>): boolean {
    try {
      const r = indexFile(this.opts.db, file, { deviceId: this.opts.deviceId, cwdFallback: history.get(file.sessionId)?.cwd });
      if (!r.changed) return false;
      if (file.agentId === null || r.appended > 0) {
        writeBaselineIfNeeded(this.opts.db, r.sessionId, this.opts.deviceId, this.opts.isRunning(file.sessionId));
      }
      for (const l of this.listeners) l.sessionChanged?.({ sessionId: r.sessionId, providerSessionId: file.sessionId, agentId: file.agentId, appended: r.appended });
      return true;
    } catch (e) {
      const message = errorMessage(e);
      try {
        this.opts.db.prepare('update transcript_files set last_error = ? where path = ?').run(message, file.path);
      } catch {
        // まだ行が無いか DB 側の失敗なので、通知だけに留める。
      }
      this.emitError(file.path, message);
      return false;
    }
  }

  /** 全ファイルを列挙して索引化する。20 ファイルごとにイベントループへ譲る。 */
  async fullScan(phase: ScanPhase = 'indexing'): Promise<{ files: number; changed: number }> {
    if (this.scanning) return { files: 0, changed: 0 };
    this.scanning = true;
    try {
      this.setProgress({ phase: 'scanning', done: 0, total: 0 });
      const files = listTranscriptFiles(this.opts.claudeDir);
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
    for (const f of listTranscriptFiles(this.opts.claudeDir)) if (this.indexOne(f, history)) changed++;
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
