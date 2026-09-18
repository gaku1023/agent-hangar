import crypto from 'node:crypto';
import fs from 'node:fs';
import { newId, shortId, type LaunchParams, type LaunchResultDto, type LiveSessionDto, type RunDto, type RunKind, type TabDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { renderInjection } from '../launch/injection.ts';
import { ensureWrapperScript, runLogPath } from '../launch/wrapper.ts';
import { hasTranscriptFile } from '../provider/claude-code/discover.ts';
import { claudeCodeProvider } from '../provider/claude-code/index.ts';
import type { LaunchInput } from '../provider/types.ts';
import type { Tmux } from '../tmux/tmux.ts';
import { aliveRunForSession, getRun, getTab, listActiveRuns, listAliveRuns, listTabs } from './queries.ts';

/** 生きた run の heartbeat をこの間隔で更新する。 */
const HEARTBEAT_MS = 30_000;
/** 応答に載せる外部コマンドの失敗の長さの上限。 */
const MAX_ERROR_LEN = 200;

/** HTTP の状態コードを持つ失敗。呼び手はそのまま応答に使える。 */
export class RunError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'RunError';
  }
}

export type LaunchResult = LaunchResultDto;
export type RunListener = { runStarted?(r: LaunchResult): void; runUpdated?(run: RunDto): void; runEnded?(run: RunDto): void; tabChanged?(tab: TabDto): void };
export type RunManagerDeps = { db: Db; deviceId: string; home: string; tmux: Tmux | null; claudeBin: string; claudeDir: string; port: number; token: string; shell?: string; isLive?: (providerSessionId: string) => boolean; now?: () => number };

type ProjectInfo = { id: string; name: string; path: string | null; resolved: boolean };
type SessionRow = { id: string; provider_session_id: string; project_id: string | null; name: string | null; cwd: string };

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** run の寿命を管理する。起動、終了検知、heartbeat、停止、レジストリとの結びつけを持つ。 */
export class RunManager {
  private listeners = new Set<RunListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RunManagerDeps) {}

  on(l: RunListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit<K extends keyof RunListener>(k: K, arg: Parameters<NonNullable<RunListener[K]>>[0]): void {
    for (const l of this.listeners) (l[k] as ((a: typeof arg) => void) | undefined)?.(arg);
  }

  /** Settings で tmuxPath が変わったときに差し替える。生きている run はそのまま観測を続ける。 */
  setTmux(tmux: Tmux | null): void {
    this.deps.tmux = tmux;
  }

  /**
   * 外部コマンドの失敗を応答に載せる前に整える。
   * claude の argv には --mcp-config の中にトークンが入るので、混ざり込む余地を消しておく。
   * 併せて 1 行に切り詰める。UI はこれをそのままトーストに出す。
   */
  private safeError(e: unknown): string {
    const line = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim();
    const masked = this.deps.token ? line.replaceAll(this.deps.token, '***') : line;
    return masked.length > MAX_ERROR_LEN ? `${masked.slice(0, MAX_ERROR_LEN)}…` : masked;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get db(): Db {
    return this.deps.db;
  }

  private tmux(): Tmux {
    if (!this.deps.tmux) throw new RunError(400, 'tmux が見つかりません。Settings で tmuxPath を設定してください');
    return this.deps.tmux;
  }

  private project(projectId: string): ProjectInfo {
    const r = this.db
      .prepare('select p.id, p.name, r.path, r.resolved from projects p left join project_roots r on r.project_id = p.id and r.device_id = ? and r.deleted_at is null where p.id = ? and p.deleted_at is null')
      .get(this.deps.deviceId, projectId) as { id: string; name: string; path: string | null; resolved: number | null } | undefined;
    if (!r) throw new RunError(404, 'プロジェクトが見つかりません');
    return { id: r.id, name: r.name, path: r.path, resolved: r.resolved === 1 };
  }

  private mcpUrl(sessionId: string): string {
    return `http://127.0.0.1:${this.deps.port}/mcp/s/${sessionId}`;
  }

  /** 起動できるかを先に確かめる。行を作る前に呼ぶので、失敗しても孤児の行が残らない。 */
  private precheck(cwd: string): Tmux {
    if (!isDirectory(cwd)) throw new RunError(400, `ディレクトリが見つかりません: ${cwd}`);
    return this.tmux();
  }

  /** 注入する指示。プロジェクトが無ければ「未分類」として cwd だけを書く。 */
  private injectionFor(projectId: string | null, cwd: string): string {
    const p = projectId ? this.project(projectId) : null;
    const memo = projectId ? (this.db.prepare('select markdown from project_memos where project_id = ? and deleted_at is null').get(projectId) as { markdown: string } | undefined)?.markdown ?? null : null;
    const todos = projectId ? (this.db.prepare('select text from todos where project_id = ? and done = 0 and deleted_at is null order by position limit 10').all(projectId) as { text: string }[]).map((t) => t.text) : [];
    return renderInjection({ projectName: p?.name ?? '未分類', projectPath: cwd, memo, todos });
  }

  /**
   * --add-dir に渡す値を整える。
   * --add-dir は可変長オプションなので、`-` で始まる値はそのまま claude のフラグとして食われる。
   * `addDirs: ["--dangerously-skip-permissions"]` のような指定を通さない。
   */
  private addDirs(params: LaunchParams): string[] {
    const dirs = (params.addDirs ?? []).map((d) => d.trim()).filter(Boolean);
    for (const d of dirs) if (d.startsWith('-')) throw new RunError(400, `addDirs にフラグのような値は使えません: ${d}`);
    return dirs;
  }

  private baseInput(sessionId: string, projectId: string | null, cwd: string, params: LaunchParams): Omit<LaunchInput, 'mode'> {
    const s = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
    return {
      systemPrompt: this.injectionFor(projectId, cwd),
      mcpUrl: this.mcpUrl(sessionId),
      token: this.deps.token,
      name: s(params.name),
      prompt: s(params.prompt),
      model: s(params.model),
      effort: s(params.effort),
      permissionMode: s(params.permissionMode),
      worktree: s(params.worktree),
      addDirs: this.addDirs(params),
    };
  }

  /**
   * run の行を作り、tmux セッションで claude を起こす。失敗したら run を閉じて 400 を投げる。
   * claude の argv は provider が組み立てたものをそのまま受け取る。
   */
  private launch(o: { sessionId: string; cwd: string; kind: RunKind; command: string[]; params: LaunchParams }): LaunchResult {
    const tmux = this.precheck(o.cwd);
    const runId = newId();
    const tmuxName = `hangar-${shortId(runId)}`;
    const wrapper = ensureWrapperScript(this.deps.home);
    const log = runLogPath(this.deps.home, runId);
    // ラッパーはプロセス置換を使うので、sh ではなく bash で起こす。
    const command = ['env', `HANGAR_RUN_ID=${runId}`, 'bash', wrapper, log, ...o.command];
    const now = this.now();
    upsertShared(this.db, 'runs', { id: runId, session_id: o.sessionId, device_id: this.deps.deviceId, kind: o.kind, tmux_name: tmuxName, pid: null, launch_params: JSON.stringify(o.params), started_at: now, ended_at: null, end_reason: null, heartbeat_at: now }, this.deps.deviceId);
    try {
      tmux.newSession({ name: tmuxName, cwd: o.cwd, command });
      tmux.setOption(tmuxName, 'status', 'off');
    } catch (e) {
      this.end(runId, 'exited');
      throw new RunError(400, `tmux の起動に失敗しました: ${this.safeError(e)}`);
    }
    const result: LaunchResult = { run: getRun(this.db, runId)!, sessionId: o.sessionId, tabs: listTabs(this.db, runId) };
    this.emit('runStarted', result);
    return result;
  }

  /** run を終了として閉じる。すでに閉じていれば何もしない。 */
  private end(runId: string, reason: 'exited' | 'killed' | 'lost'): RunDto | null {
    const row = this.db.prepare('select * from runs where id = ? and deleted_at is null').get(runId) as Record<string, unknown> | undefined;
    if (!row || row.ended_at !== null) return null;
    upsertShared(this.db, 'runs', { ...row, ended_at: this.now(), end_reason: reason }, this.deps.deviceId);
    const run = getRun(this.db, runId)!;
    this.pruneEmptySession(run);
    this.emit('runEnded', run);
    return run;
  }

  /**
   * 起動に失敗した新規セッションの行を消す。
   * claude 自体が起動できないと（フラグ違い、モデル名違い、インストール破損）本文は永久に生まれず、
   * 名前も本文も無いセッションが一覧の先頭に残る。再開もフォークもできず、消す道も無い。
   * 消すのは、この run が新規の start で、本文がどこにも無く、開いたシェルタブも他の run も無いときだけにする。
   */
  private pruneEmptySession(run: RunDto): void {
    if (run.kind !== 'start') return;
    const s = this.db.prepare('select provider_session_id, cwd from sessions where id = ?').get(run.sessionId) as { provider_session_id: string; cwd: string } | undefined;
    if (!s) return;
    // 開いたシェルタブが残っているなら、そのシェルは tmux の上でまだ動いている。
    // セッションを消すと、UI から到達も停止もできないシェルになる。
    const openTab = this.db.prepare('select 1 from run_tabs where run_id = ? and closed_at is null and deleted_at is null limit 1').get(run.id);
    if (openTab) return;
    const indexed = this.db.prepare('select 1 from transcript_files where session_id = ? limit 1').get(run.sessionId);
    // 索引はファイルに遅れて付くので、DB だけでは「本文が無い」と決められない。
    // 書かれた直後に run が終わった本文まで消すと、jsonl が残っていてもこの行は二度と戻らない。
    // claudeDir を読めなかったときも、本文が無いとは言えないので見送る。
    if (indexed || hasTranscriptFile(this.deps.claudeDir, s.provider_session_id, s.cwd) !== false) return;
    const other = this.db.prepare('select 1 from runs where session_id = ? and id <> ? and deleted_at is null limit 1').get(run.sessionId, run.id);
    if (other) return;
    softDeleteShared(this.db, 'sessions', run.sessionId, this.deps.deviceId);
  }

  /** 新しいセッションを起こす。検査をすべて先に済ませてから行を作る。 */
  start(params: LaunchParams): LaunchResult {
    if (params.scratch) throw new RunError(400, 'スクラッチはフェーズ 3 で実装します');
    if (!params.projectId) throw new RunError(400, 'projectId は必須です');
    this.addDirs(params);
    const p = this.project(params.projectId);
    if (!p.path || !p.resolved) throw new RunError(400, 'プロジェクトのディレクトリがこの端末で見つかりません');
    this.precheck(p.path);
    const sessionUuid = crypto.randomUUID();
    const sessionId = ensureSession(this.db, sessionUuid, p.path, this.deps.deviceId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, project_id: p.id, name: params.name?.trim() || null, started_at: now, last_activity_at: now }, this.deps.deviceId);
    const input: LaunchInput = { ...this.baseInput(sessionId, p.id, p.path, params), mode: { kind: 'start', sessionUuid } };
    const command = claudeCodeProvider.launchCommand(this.deps.claudeBin, input);
    return this.launch({ sessionId, cwd: p.path, kind: 'start', command, params });
  }

  private session(sessionId: string): SessionRow {
    const s = this.db.prepare('select * from sessions where id = ? and deleted_at is null').get(sessionId) as SessionRow | undefined;
    if (!s) throw new RunError(404, 'セッションが見つかりません');
    return s;
  }

  /** 再開できる状態かを確かめる。本文の有無、hangar の run、hangar の外で動いている Claude は、どれも別の原因である。 */
  private assertResumable(s: SessionRow): void {
    const hasBody = this.db.prepare('select 1 from transcript_files where session_id = ? and agent_id is null limit 1').get(s.id);
    if (!hasBody) throw new RunError(400, 'このセッションには本文がありません');
    if (aliveRunForSession(this.db, s.id)) throw new RunError(409, 'このセッションは実行中です');
    if (this.deps.isLive?.(s.provider_session_id)) throw new RunError(409, 'このセッションは hangar の外で実行中です');
  }

  /** 同じ cwd で claude -r <uuid> を実行し、同じセッションに kind = 'resume' の run を付ける。 */
  resume(sessionId: string): LaunchResult {
    const s = this.session(sessionId);
    this.assertResumable(s);
    const command = claudeCodeProvider.resumeCommand(this.deps.claudeBin, this.baseInput(s.id, s.project_id, s.cwd, {}), { providerSessionId: s.provider_session_id }, false);
    return this.launch({ sessionId: s.id, cwd: s.cwd, kind: 'resume', command, params: { projectId: s.project_id ?? undefined } });
  }

  /** 新しい sessions 行を作り、claude -r <uuid> --fork-session --session-id <new> で起動する。名前は Claude が本文から引き継ぐので null にする。 */
  fork(sessionId: string): LaunchResult {
    const s = this.session(sessionId);
    this.assertResumable(s);
    // 新しい行を作る前に起動できるかを確かめる。失敗しても本文の無いセッションが残らないようにするため。
    this.precheck(s.cwd);
    const newUuid = crypto.randomUUID();
    const newSessionId = ensureSession(this.db, newUuid, s.cwd, this.deps.deviceId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(newSessionId) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, project_id: s.project_id, name: null, started_at: now, last_activity_at: now }, this.deps.deviceId);
    const command = claudeCodeProvider.resumeCommand(this.deps.claudeBin, this.baseInput(newSessionId, s.project_id, s.cwd, {}), { providerSessionId: s.provider_session_id }, true, newUuid);
    return this.launch({ sessionId: newSessionId, cwd: s.cwd, kind: 'fork', command, params: { projectId: s.project_id ?? undefined } });
  }

  /** tmux の一覧を 1 回読み、消えた run とタブを閉じ、古い heartbeat を更新する。 */
  tick(): { ended: RunDto[]; closedTabs: TabDto[] } {
    // tmux が無いのも、tmux を呼べなかったのも「観測できない」であって「動いていない」ではない。
    // ここで一覧を空と見なすと、設定から tmuxPath を外した瞬間や、
    // tmux のバイナリが一瞬消えた隙に、実際には動いている run が全部 exited になって二度と戻らない。
    const listed = this.deps.tmux?.listSessions() ?? null;
    if (listed === null) return { ended: [], closedTabs: [] };
    const names = new Set(listed);
    const ended: RunDto[] = [];
    const closedTabs: TabDto[] = [];
    const now = this.now();
    // 消えたタブを先に閉じる。run を閉じるときの後始末が、既に死んだシェルタブを
    // 「まだ動いている」と読み違えないようにするため。
    for (const t of this.openShellTabs()) {
      if (!names.has(t.tmuxName)) {
        const c = this.closeTabRow(t.id);
        if (c) closedTabs.push(c);
      }
    }
    for (const run of listAliveRuns(this.db, this.deviceId)) {
      if (!names.has(run.tmuxName)) {
        const e = this.end(run.id, 'exited');
        if (e) ended.push(e);
        continue;
      }
      if (now - run.heartbeatAt >= HEARTBEAT_MS) {
        const row = this.db.prepare('select * from runs where id = ?').get(run.id) as Record<string, unknown>;
        upsertShared(this.db, 'runs', { ...row, heartbeat_at: now }, this.deviceId);
        this.emit('runUpdated', getRun(this.db, run.id)!);
      }
    }
    return { ended, closedTabs };
  }

  /**
   * サーバ起動時に、生きているはずの run のうち tmux セッションが無いものを lost で閉じる。
   * tmux の設定が無いときは、そのセッションにはもう繋げないので閉じてよい。
   * tmux を呼べなかったときは観測できていないので、何も閉じない。
   */
  recoverAtStartup(): RunDto[] {
    const listed = this.deps.tmux ? this.deps.tmux.listSessions() : [];
    if (listed === null) return [];
    const names = new Set(listed);
    const out: RunDto[] = [];
    // tick と同じく、消えたタブを先に閉じる。
    for (const t of this.openShellTabs()) if (!names.has(t.tmuxName)) this.closeTabRow(t.id);
    for (const run of listAliveRuns(this.db, this.deviceId)) {
      if (!names.has(run.tmuxName)) {
        const e = this.end(run.id, 'lost');
        if (e) out.push(e);
      }
    }
    return out;
  }

  private get deviceId(): string {
    return this.deps.deviceId;
  }

  /** レジストリ（~/.claude/sessions）の項目を Claude の UUID で run に結びつけ、pid を書く。 */
  linkRegistry(live: LiveSessionDto[]): void {
    const byUuid = new Map(live.map((l) => [l.sessionId, l]));
    for (const run of listAliveRuns(this.db, this.deviceId)) {
      const s = this.db.prepare('select provider_session_id from sessions where id = ?').get(run.sessionId) as { provider_session_id: string } | undefined;
      const l = s ? byUuid.get(s.provider_session_id) : undefined;
      if (!l || l.pid === run.pid) continue;
      const row = this.db.prepare('select * from runs where id = ?').get(run.id) as Record<string, unknown>;
      upsertShared(this.db, 'runs', { ...row, pid: l.pid }, this.deviceId);
      this.emit('runUpdated', getRun(this.db, run.id)!);
    }
  }

  /** run を止める。タブも閉じ、killed で終わらせる。 */
  kill(runId: string): RunDto {
    const run = getRun(this.db, runId);
    if (!run) throw new RunError(404, 'run が見つかりません');
    if (run.endedAt !== null) throw new RunError(409, 'この run は終了しています');
    for (const t of listTabs(this.db, runId)) if (t.kind === 'shell') this.closeTab(t.id);
    this.deps.tmux?.killSession(run.tmuxName);
    return this.end(runId, 'killed') ?? run;
  }

  /** 終了検知の周期起動。tick の失敗でサーバが落ちないよう、必ず捕まえる。 */
  startPolling(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        console.error('[runs]', e instanceof Error ? e.message : e);
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 開いているシェルタブ。Claude が終了した run のタブも含める。 */
  private openShellTabs(): TabDto[] {
    return listActiveRuns(this.db, this.deviceId)
      .flatMap((r) => listTabs(this.db, r.id))
      .filter((t) => t.kind === 'shell');
  }

  /** run_tabs の行を閉じる。tmux は触らない。 */
  private closeTabRow(tabId: string): TabDto | null {
    const row = this.db.prepare('select * from run_tabs where id = ? and deleted_at is null').get(tabId) as Record<string, unknown> | undefined;
    if (!row || row.closed_at !== null) return null;
    const now = this.now();
    upsertShared(this.db, 'run_tabs', { ...row, closed_at: now }, this.deviceId);
    const run = this.db.prepare('select session_id from runs where id = ?').get(row.run_id) as { session_id: string };
    const tab: TabDto = { id: row.id as string, runId: row.run_id as string, sessionId: run.session_id, kind: 'shell', title: (row.title as string | null) ?? 'シェル', tmuxName: row.tmux_name as string, createdAt: row.created_at as number, closedAt: now };
    this.emit('tabChanged', tab);
    return tab;
  }

  /** 同じ cwd で利用者のログインシェルを起こした独立の tmux セッションをタブとして足す。 */
  openTab(runId: string): TabDto {
    const run = getRun(this.db, runId);
    if (!run) throw new RunError(404, 'run が見つかりません');
    const s = this.session(run.sessionId);
    const tmux = this.precheck(s.cwd);
    // 番号は閉じた行も数えて振る。閉じたタブの番号は再利用しない。
    const n = (this.db.prepare('select count(*) c from run_tabs where run_id = ?').get(runId) as { c: number }).c + 1;
    const tmuxName = `${run.tmuxName}-t${n}`;
    const shell = this.deps.shell ?? process.env.SHELL ?? '/bin/zsh';
    try {
      tmux.newSession({ name: tmuxName, cwd: s.cwd, command: [shell, '-l'] });
      tmux.setOption(tmuxName, 'status', 'off');
    } catch (e) {
      throw new RunError(400, `シェルの起動に失敗しました: ${this.safeError(e)}`);
    }
    const id = newId();
    upsertShared(this.db, 'run_tabs', { id, run_id: runId, tmux_name: tmuxName, title: `シェル ${n}`, created_at: this.now(), closed_at: null }, this.deviceId);
    const tab = getTab(this.db, id)!;
    this.emit('tabChanged', tab);
    return tab;
  }

  /** シェルタブを閉じる。Claude のタブは run の停止でしか閉じられない。 */
  closeTab(tabId: string): TabDto {
    const t = getTab(this.db, tabId);
    if (!t) throw new RunError(404, 'タブが見つかりません');
    if (t.kind === 'agent') throw new RunError(400, 'Claude のタブは閉じられません。停止を使ってください');
    this.deps.tmux?.killSession(t.tmuxName);
    return this.closeTabRow(tabId) ?? t;
  }

  /** 生きた run と、開いたシェルタブが残る run。UI の bootstrap と GET /api/runs が使う。 */
  listAlive(): { runs: RunDto[]; tabs: TabDto[] } {
    const runs = listActiveRuns(this.db, this.deps.deviceId);
    return { runs, tabs: runs.flatMap((r) => listTabs(this.db, r.id)) };
  }

  getRun(id: string): RunDto | null {
    return getRun(this.db, id);
  }

  getTab(id: string): TabDto | null {
    return getTab(this.db, id);
  }

  /**
   * 端末として繋いでよいタブ。繋げないものは null にする。
   * 終了した run の Claude のタブは繋ぎ先の tmux セッションがもう無い。
   * そこへ attach しようとすると tmux の前方一致で同じ run のシェルタブに落ち、
   * 利用者は Claude のペインのつもりで自分のシェルに打鍵してしまう。
   * シェルタブは run が終わった後も残るので、そちらは繋いでよい。
   */
  attachTarget(tabId: string): TabDto | null {
    const t = this.getTab(tabId);
    if (!t) return null;
    if (t.kind === 'agent' && this.getRun(t.runId)?.endedAt != null) return null;
    return t;
  }
}
