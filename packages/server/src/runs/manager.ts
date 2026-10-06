import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newId, shortId, type LaunchParams, type LaunchResultDto, type LiveSessionDto, type RunDto, type RunKind, type TabDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { ensureSession, findSession } from '../indexer/indexFile.ts';
import { renderInjection } from '../launch/injection.ts';
import { pruneMcpConfigs, removeMcpConfig, writeMcpConfig } from '../launch/mcpConfig.ts';
import { ensureWrapperScript, pruneRunLogs, runLogPath } from '../launch/wrapper.ts';
import { promptMentionsDrops } from '../prompt/drops.ts';
import { assignSession } from '../projects/registry.ts';
import { ensureScratchProject, newScratchDir } from '../projects/scratch.ts';
import { hasTranscriptFile } from '../provider/claude-code/discover.ts';
import { claudeCodeProvider } from '../provider/claude-code/index.ts';
import type { LaunchInput, LiveSession } from '../provider/types.ts';
import type { Tmux } from '../tmux/tmux.ts';
import { RunError } from './errors.ts';
import { aliveRunForSession, getRun, getTab, listActiveRuns, listAliveRuns, listTabs } from './queries.ts';
import { realProcOps, sameStartTime, type ProcOps } from './procs.ts';
import { jumpToPrompt, leaveTranscript, type JumpFrom, type JumpResult, type PaneIo } from './promptJump.ts';
import { issueMcpSecret, pruneMcpSecrets, revokeMcpSecret } from './secrets.ts';
import { splitTerminalArgs, terminalEnv, type TerminalRequest } from './terminal.ts';

/** 生きた run の heartbeat をこの間隔で更新する。 */
const HEARTBEAT_MS = 30_000;
/** 応答に載せる外部コマンドの失敗の長さの上限。 */
const MAX_ERROR_LEN = 200;
/** 引き取るときに、元の claude が SIGTERM で終わるのを待つ長さ。 */
const TERMINATE_MS = 10_000;
/**
 * tmux のセッションに渡す環境に、UTF-8 の文字のロケールを足す。
 * tmux の新しいセッションはサーバの環境を継ぎ、.app から起こした hangar が立てたサーバには LANG が無い。
 * ロケールが無いと、claude が選んだ範囲を写すときの pbcopy が日本語を読めず、クリップボードを空にする。
 * 呼び手（ターミナルのシェル）が LC_ALL か LC_CTYPE を決めていれば、そちらを使う。
 */
export function withUtf8Locale(env: Record<string, string> = {}): Record<string, string> {
  if (env.LC_ALL || env.LC_CTYPE) return env;
  return { LC_CTYPE: 'UTF-8', ...env };
}

/** 引き取るときに、止めた claude がレジストリから消えるのを待つ長さ。 */
const GONE_WAIT_MS = 5_000;

export { RunError };

export type LaunchResult = LaunchResultDto;
export type RunListener = { runStarted?(r: LaunchResult): void; runUpdated?(run: RunDto): void; runEnded?(run: RunDto): void; tabChanged?(tab: TabDto): void };
/**
 * live は Claude のレジストリの今の中身である。引き取りと attach が、外で動く claude の pid とバックグラウンドの id を引くのに使う。
 * procs は外のプロセスに触る口で、テストでは差し替える。
 */
export type RunManagerDeps = { db: Db; deviceId: string; home: string; tmux: Tmux | null; claudeBin: string | null; claudeDir: string; port: number; token: string; shell?: string; isLive?: (providerSessionId: string) => boolean; live?: () => LiveSession[]; procs?: ProcOps; now?: () => number; sleep?: (ms: number) => Promise<void> };

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
  /** 引き取りの途中のセッション。二度押しで元のプロセスを止めて移す手順が 2 本走らないようにする。 */
  private adopting = new Set<string>();

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

  /** Settings で claudePath が変わったときに差し替える。これから起こす run が新しい場所を使う。 */
  setClaudeBin(claudeBin: string | null): void {
    this.deps.claudeBin = claudeBin;
  }

  /**
   * 外部コマンドの失敗を応答に載せる前に整える。
   * claude の起動の周りにはトークンとセッション別の秘密が居るので、混ざり込む余地を消しておく。
   * どちらも 64 桁の 16 進なので、名指しの置換に加えてその形をまとめて覆う。
   * セッション uuid は 36 桁で、git の SHA は 40 桁なので、この形に当たるのは鍵だけである。
   * 併せて 1 行に切り詰める。UI はこれをそのままトーストに出す。
   */
  private safeError(e: unknown): string {
    const line = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim();
    const named = this.deps.token ? line.replaceAll(this.deps.token, '***') : line;
    const masked = named.replace(/\b[0-9a-f]{64}\b/g, '***');
    return masked.length > MAX_ERROR_LEN ? `${masked.slice(0, MAX_ERROR_LEN)}…` : masked;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get db(): Db {
    return this.deps.db;
  }

  private tmux(): Tmux {
    if (!this.deps.tmux) throw new RunError(400, 'tmux が見つかりません。設定の「tmux のパス」を入れてください');
    return this.deps.tmux;
  }

  /**
   * claude の絶対パス。分からなければ起動そのものを断る。
   * tmux のペインは hangar の PATH を継ぐので、.app から起こしたときは裸の `claude` を引けない。
   * 引けない名前をそのまま渡すと、応答は成功のままペインの中で 127 で落ち、
   * 利用者はターミナルを開くまで理由が分からない。だから渡す前にここで止める。
   */
  private claudeBin(): string {
    if (!this.deps.claudeBin) throw new RunError(400, 'claude が見つかりません。設定の「claude のパス」を入れてください');
    return this.deps.claudeBin;
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
    this.claudeBin();
    return this.tmux();
  }

  /** 注入する指示。プロジェクトが無ければ「未分類」として cwd だけを書く。 */
  private injectionFor(projectId: string | null, cwd: string): string {
    const p = projectId ? this.project(projectId) : null;
    const memo = projectId ? (this.db.prepare('select markdown from project_memos where project_id = ? and deleted_at is null').get(projectId) as { markdown: string } | undefined)?.markdown ?? null : null;
    const todos = projectId ? (this.db.prepare('select id, text from todos where project_id = ? and done = 0 and deleted_at is null order by position limit 10').all(projectId) as { id: string; text: string }[]) : [];
    return renderInjection({ projectName: p?.name ?? '未分類', projectPath: cwd, memo, todos });
  }

  /**
   * --add-dir に渡す値を整える。
   * --add-dir は可変長オプションなので、`-` で始まる値はそのまま claude のフラグとして食われる。
   * `addDirs: ["--dangerously-skip-permissions"]` のような指定を通さない。
   */
  private addDirs(params: LaunchParams): string[] {
    const dirs = (params.addDirs ?? []).map((d) => d.trim()).filter(Boolean);
    for (const d of dirs) if (d.startsWith('-')) throw new RunError(400, `追加ディレクトリに - で始まる値は使えません: ${d}`);
    return dirs;
  }

  private baseInput(sessionId: string, projectId: string | null, cwd: string, params: LaunchParams): Omit<LaunchInput, 'mode'> {
    const s = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
    return {
      systemPrompt: this.injectionFor(projectId, cwd),
      // claude に渡すのは本体のトークンではなく、この run 専用の秘密である。
      // 本体のトークンを渡すと、claude は自分の設定ファイルを読んで共通の /mcp と /api に回れる。
      // 秘密を argv に載せないため、MCP の設定は 0600 のファイルに置き、パスだけを claude に渡す。
      mcpConfigPath: writeMcpConfig(this.deps.home, sessionId, this.mcpUrl(sessionId), issueMcpSecret(this.db, sessionId, this.now())),
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
  private launch(o: { sessionId: string; cwd: string; kind: RunKind; command: string[]; params: LaunchParams; env?: Record<string, string> }): LaunchResult {
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
      tmux.newSession({ name: tmuxName, cwd: o.cwd, command, env: withUtf8Locale(o.env) });
      tmux.setOption(tmuxName, 'status', 'off');
      // ターミナルからこの run につなぐ人のための設定。サーバ全体の設定なので、サーバが起き直した後にも効くよう起動のたびに確かめる。
      tmux.ensureTerminalOptions();
    } catch (e) {
      this.end(runId, 'exited');
      throw new RunError(400, `tmux の起動に失敗しました: ${this.safeError(e)}`);
    }
    // ログは run ごとに増えるので、起動のついでに古いものを落とす。
    // 動いている run のログは残す。書いている途中のログを消すと、その run の記録が切れる。
    const alive = listAliveRuns(this.db, this.deps.deviceId);
    try {
      pruneRunLogs(this.deps.home, alive.map((r) => r.id));
    } catch (e) {
      console.error('[runs] ログの掃除に失敗しました', e instanceof Error ? e.message : e);
    }
    // 異常終了などで消し損ねた MCP の設定と秘密を、ここで拾う。中に鍵が入っているので残さない。
    this.pruneMcpConfigs(alive.map((r) => r.sessionId));
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
    // claude はもう居ない。秘密の入った設定ファイルを残さず、秘密そのものも無効にする。
    removeMcpConfig(this.deps.home, run.sessionId);
    revokeMcpSecret(this.db, run.sessionId);
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
    this.addDirs(params);
    // スクラッチは擬似プロジェクトの行と使い捨てのディレクトリを作ってしまうので、
    // 後の precheck を待たずに、ここで tmux と claude の有無だけ先に確かめる。
    // これが無いと、どちらも無い端末で起動を試すたびに空のディレクトリが溜まる。
    if (params.scratch) { this.tmux(); this.claudeBin(); }
    // スクラッチは使い捨てのディレクトリを作り、擬似プロジェクトに属させる。
    // projectId が一緒に来ていても scratch を優先する。
    const p = params.scratch ? this.scratchProject() : this.namedProject(params.projectId);
    if (!p.path || !p.resolved) throw new RunError(400, 'プロジェクトのディレクトリがこの PC で見つかりません');
    // スクラッチのディレクトリは precheck より先に作る。precheck は cwd が実在するかを見るためである。
    const cwd = params.scratch ? newScratchDir(this.deps.home, new Date(this.now())) : p.path;
    this.precheck(cwd);
    const sessionUuid = crypto.randomUUID();
    const sessionId = ensureSession(this.db, sessionUuid, cwd, this.deps.deviceId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, project_id: p.id, name: params.name?.trim() || null, started_at: now, last_activity_at: now }, this.deps.deviceId);
    const base = this.baseInput(sessionId, p.id, cwd, params);
    // 添付つきの初期プロンプトは、置き場（hangar の home の drops）の中のファイルを指す。
    // 置き場は作業ディレクトリの外なので、足さないと claude が読む前に許可を尋ねて止まる。
    // 足すのは claude に渡す引数だけで、run に残す起動の指定（params）は変えない。画面が覚える addDirs に混ざらないためである。
    const dropsDir = path.join(this.deps.home, 'drops');
    const addDirs = promptMentionsDrops(params.prompt, dropsDir) && !base.addDirs?.includes(dropsDir) ? [...(base.addDirs ?? []), dropsDir] : base.addDirs;
    const input: LaunchInput = { ...base, addDirs, mode: { kind: 'start', sessionUuid } };
    const command = claudeCodeProvider.launchCommand(this.claudeBin(), input);
    return this.launch({ sessionId, cwd, kind: 'start', command, params });
  }

  /** scratch ではないときの起動先。projectId は必須である。 */
  private namedProject(projectId: string | undefined): ProjectInfo {
    if (!projectId) throw new RunError(400, 'プロジェクトを選んでください');
    return this.project(projectId);
  }

  /** この端末のスクラッチの擬似プロジェクト。無ければ作る。 */
  private scratchProject(): ProjectInfo {
    return this.project(ensureScratchProject(this.db, this.deps.deviceId, this.deps.home));
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

  /**
   * 同じ cwd で claude -r <uuid> を実行し、同じセッションに kind = 'resume' の run を付ける。
   * Claude のバックグラウンドのサービスが持っていたセッション（止まったもの、1 時間つながれずに止まったもの）は、
   * claude -r ではなく `claude attach` で起こす。-r で hangar の tmux に開くと、元のターミナルから attach で戻れなくなる。
   */
  resume(sessionId: string, extra: { args?: string[]; env?: Record<string, string> } = {}): LaunchResult {
    const s = this.session(sessionId);
    this.assertResumable(s);
    const bin = this.claudeBin();
    const job = this.procs().listJobs(bin)?.find((j) => j.sessionId === s.provider_session_id) ?? null;
    if (job) return this.launch({ sessionId: s.id, cwd: s.cwd, kind: 'resume', command: [bin, 'attach', job.id], params: { projectId: s.project_id ?? undefined }, env: extra.env });
    const command = claudeCodeProvider.resumeCommand(this.claudeBin(), this.baseInput(s.id, s.project_id, s.cwd, {}), { providerSessionId: s.provider_session_id }, false);
    return this.launch({ sessionId: s.id, cwd: s.cwd, kind: 'resume', command: [...command, ...(extra.args ?? [])], params: { projectId: s.project_id ?? undefined }, env: extra.env });
  }

  /**
   * ターミナルの包み方からの起動。ターミナルで打った claude を、バックグラウンドではなく hangar の tmux の中で動かす。
   * Claude Code は、バックグラウンドのセッションには利用上限の後に自動で続ける予約を入れないからである。
   * 作業ディレクトリを含むルートのうち最も深いプロジェクトに紐づけ、無ければ未分類にする。
   * 利用者の引数は hangar が組み立てる引数の後ろに足す。環境変数は端末に固有のものを落として tmux に渡す。
   * `-r <id>` の会話の run が動いていれば、新しく起こさずにその run を返す（attached が真）。包み方はその tmux につなぐだけにする。
   * 断ったとき（RunError）は、包み方が素の claude を起動する。
   */
  startFromTerminal(req: TerminalRequest): LaunchResult & { attached: boolean } {
    const { resume, rest } = splitTerminalArgs(req.args);
    const env = terminalEnv(req.env);
    if (resume) {
      const id = findSession(this.db, resume);
      if (!id) throw new RunError(404, 'この会話は hangar に載っていません');
      const alive = aliveRunForSession(this.db, id);
      if (alive) return { run: alive, sessionId: id, tabs: listTabs(this.db, alive.id), attached: true };
      // 以前の包み方や `claude --bg` で起こしたものはバックグラウンドで動いている。素の claude -r は写しを作るので、attach でつなぐ。
      const provider = (this.db.prepare('select provider_session_id from sessions where id = ?').get(id) as { provider_session_id: string }).provider_session_id;
      if (this.liveOf(provider)?.background) return { ...this.attach(id), attached: false };
      return { ...this.resume(id, { args: rest, env }), attached: false };
    }
    this.precheck(req.cwd);
    const sessionUuid = crypto.randomUUID();
    const sessionId = ensureSession(this.db, sessionUuid, req.cwd, this.deps.deviceId);
    const projectId = assignSession(this.db, this.deps.deviceId, sessionId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, started_at: now, last_activity_at: now }, this.deps.deviceId);
    const input: LaunchInput = { ...this.baseInput(sessionId, projectId, req.cwd, {}), mode: { kind: 'start', sessionUuid } };
    const command = [...claudeCodeProvider.launchCommand(this.claudeBin(), input), ...rest];
    return { ...this.launch({ sessionId, cwd: req.cwd, kind: 'start', command, params: { projectId: projectId ?? undefined }, env }), attached: false };
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
    const command = claudeCodeProvider.resumeCommand(this.claudeBin(), this.baseInput(newSessionId, s.project_id, s.cwd, {}), { providerSessionId: s.provider_session_id }, true, newUuid);
    return this.launch({ sessionId: newSessionId, cwd: s.cwd, kind: 'fork', command, params: { projectId: s.project_id ?? undefined } });
  }

  /** レジストリのうち、Claude の UUID が一致する項目。 */
  private liveOf(providerSessionId: string): LiveSession | null {
    return this.deps.live?.().find((l) => l.sessionId === providerSessionId) ?? null;
  }

  private procs(): ProcOps {
    return this.deps.procs ?? realProcOps;
  }

  /**
   * Claude のバックグラウンドのサービスが持つセッションを、hangar の tmux の中の `claude attach` で開く。
   * claude の本体はバックグラウンドのサービスの側で動き続け、この run が持つのは画面をつなぐ口だけである。
   * 同じセッションに他のターミナルが同時につないでいてもよい。
   * run の種類は resume にする。種類を増やすと、同期で行を受け取る古い版の端末が DB の制約で取り込めなくなる。
   * 注入する指示と MCP の設定は付けない。`claude attach` はそれを受け取らないからである。
   */
  attach(sessionId: string): LaunchResult {
    const s = this.session(sessionId);
    if (aliveRunForSession(this.db, s.id)) throw new RunError(409, 'このセッションは実行中です');
    const l = this.liveOf(s.provider_session_id);
    if (!l?.background) throw new RunError(409, 'このセッションはバックグラウンドで動いていません');
    const command = [this.claudeBin(), 'attach', l.background.jobId];
    return this.launch({ sessionId: s.id, cwd: s.cwd, kind: 'resume', command, params: { projectId: s.project_id ?? undefined } });
  }

  /**
   * hangar の外のターミナル（VS Code など）で動く claude を引き取り、hangar で開く。
   * 外のターミナルの画面は、そのターミナルのアプリしか持っていないので、横からはつなげない。
   * そこで元の claude を SIGTERM で終わらせ、同じ id のまま `claude --bg --resume` でバックグラウンドのサービスに移し、attach でつなぐ。
   * 元のターミナルからも `claude attach <id>` で同じ画面に戻れる。
   *
   * 作業中は引き取らない。止めた時点の作業が途中で切れるからである。
   * ターミナルの CLI（entrypoint が cli）の claude だけを引き取る。VS Code の拡張やアプリの中の claude を止めると、その画面の側が壊れる。
   * 止める前に、この PC の Claude Code がバックグラウンドを使えるかを確かめる。古い版と、管理設定で切られた PC では、止めた後で移せずに終わる。
   * 入力待ちで止めると、答えを待っていた問いは「答えなかった」として閉じる。会話は続けられ、文で答え直せばよい。
   * 止める前に、pid の起動時刻がレジストリの記録と合うかを確かめる。pid が使い回されていたら別のプロセスを止めてしまう。
   */
  async adopt(sessionId: string): Promise<LaunchResult> {
    const s = this.session(sessionId);
    if (aliveRunForSession(this.db, s.id)) throw new RunError(409, 'このセッションは実行中です');
    const l = this.liveOf(s.provider_session_id);
    if (!l) throw new RunError(409, 'このセッションは動いていません');
    if (l.background) return this.attach(s.id);
    if (l.status === 'busy') throw new RunError(409, '作業中のセッションは引き取れません。入力待ちか休みになってから引き取ってください');
    if (l.entrypoint !== 'cli') throw new RunError(409, 'このセッションはターミナルではなく、VS Code の拡張やアプリの中で動いているので引き取れません');
    if (this.adopting.has(s.id)) throw new RunError(409, 'このセッションは引き取りの途中です');
    this.precheck(s.cwd);
    // 止めた後で再開できないと、会話はあるのに claude が居ない状態で終わる。本文の有無は止める前に確かめる。
    if (!this.db.prepare('select 1 from transcript_files where session_id = ? and agent_id is null limit 1').get(s.id)) throw new RunError(400, 'このセッションには本文がまだ無いので引き取れません');
    const started = this.procs().startTimeOf(l.pid);
    if (!l.procStart || !started || !sameStartTime(started, l.procStart)) throw new RunError(409, 'このセッションのプロセスを確かめられませんでした');
    this.adopting.add(s.id);
    try {
      if (!(await this.procs().terminate(l.pid, TERMINATE_MS))) throw new RunError(409, '元の claude が終わりませんでした。元のターミナルで終わらせてから、もう一度引き取ってください');
      // ここから先で失敗しても、元の claude はもう居ない。会話は残っているので、開き直す手を添える。
      const reopen = `claude --resume ${s.provider_session_id} で開き直せます`;
      // レジストリから消える前に再開すると、hangar の外で動いていると見て断ってしまう。
      if (!(await this.waitForGone(s.provider_session_id))) throw new RunError(409, `元の claude の記録が消えませんでした。${reopen}`);
      try {
        return this.resume(s.id);
      } catch (e) {
        if (e instanceof RunError) throw new RunError(e.status, `${e.message}。${reopen}`);
        throw e;
      }
    } finally {
      this.adopting.delete(s.id);
    }
  }

  /** その会話がレジストリから消えるのを待つ。消えたら true を返す。 */
  private async waitForGone(providerSessionId: string): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = this.now() + GONE_WAIT_MS;
    for (;;) {
      if (!(this.deps.live?.() ?? []).some((l) => l.sessionId === providerSessionId)) return true;
      if (this.now() >= until) return false;
      await sleep(100);
    }
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
    // 前回サーバが落ちた拍子に残った設定と秘密も、ここで落とす。
    // tmux の上で生き残った run の分は残る。その claude は再起動後も同じ秘密で繋ぎに来る。
    this.pruneMcpConfigs(listAliveRuns(this.db, this.deviceId).map((r) => r.sessionId));
    return out;
  }

  /** 生きている run のもの以外の MCP 設定と秘密を落とす。掃除の失敗で起動を止めない。 */
  private pruneMcpConfigs(aliveSessionIds: string[]): void {
    try {
      pruneMcpConfigs(this.deps.home, aliveSessionIds);
    } catch (e) {
      console.error('[runs] MCP 設定の掃除に失敗しました', e instanceof Error ? e.message : e);
    }
    try {
      pruneMcpSecrets(this.db, aliveSessionIds);
    } catch (e) {
      console.error('[runs] MCP の秘密の掃除に失敗しました', e instanceof Error ? e.message : e);
    }
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
    if (!run) throw new RunError(404, '起動した Claude が見つかりません');
    if (run.endedAt !== null) throw new RunError(409, 'この Claude はもう終了しています');
    for (const t of listTabs(this.db, runId)) if (t.kind === 'shell') this.closeTab(t.id);
    this.stopBackground(run.sessionId);
    this.deps.tmux?.killSession(run.tmuxName);
    return this.end(runId, 'killed') ?? run;
  }

  /**
   * バックグラウンドのサービスが持つセッションなら、その本体も止める。
   * attach の run の tmux を落としても画面の口が閉じるだけで、claude は動き続けるからである。
   * 止め終わるのは待たない。失敗しても run は閉じ、ログにだけ残す。
   */
  private stopBackground(sessionId: string): void {
    const s = this.db.prepare('select provider_session_id, cwd from sessions where id = ?').get(sessionId) as { provider_session_id: string; cwd: string } | undefined;
    const jobId = s ? this.liveOf(s.provider_session_id)?.background?.jobId : undefined;
    if (!s || !jobId || !this.deps.claudeBin) return;
    const cwd = isDirectory(s.cwd) ? s.cwd : this.deps.home;
    this.procs().runClaude(this.deps.claudeBin, ['stop', jobId], cwd).catch((e) => console.error('[runs] バックグラウンドのセッションを止められませんでした', this.safeError(e)));
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
    if (!run) throw new RunError(404, '起動した Claude が見つかりません');
    const s = this.session(run.sessionId);
    const tmux = this.precheck(s.cwd);
    // 番号は閉じた行も数えて振る。閉じたタブの番号は再利用しない。
    const n = (this.db.prepare('select count(*) c from run_tabs where run_id = ?').get(runId) as { c: number }).c + 1;
    const tmuxName = `${run.tmuxName}-t${n}`;
    const shell = this.deps.shell ?? process.env.SHELL ?? '/bin/zsh';
    try {
      tmux.newSession({ name: tmuxName, cwd: s.cwd, command: [shell, '-l'], env: withUtf8Locale() });
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

  /** run ごとの跳ぶ操作の列。続けて押されても、前の操作のキーと混ざらないように 1 つずつ流す。 */
  private paneOps = new Map<string, Promise<unknown>>();

  private agentPane(runId: string): PaneIo {
    const run = this.getRun(runId);
    if (!run) throw new RunError(404, '起動した Claude が見つかりません');
    if (run.endedAt !== null) throw new RunError(409, 'この Claude はもう終了しています');
    const tmux = this.tmux();
    return {
      capture: () => tmux.capturePane(run.tmuxName),
      // ctrl+o だけはキーの名前で送り、ほかは -l で 1 文字として送る。{ や q を tmux のキー名として読ませない。
      send: (key) => (key === 'C-o' ? tmux.sendKeys(run.tmuxName, 'C-o') : tmux.sendKeys(run.tmuxName, '-l', key)),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
  }

  private queuePane<T>(runId: string, op: () => Promise<T>): Promise<T> {
    const next = (this.paneOps.get(runId) ?? Promise.resolve()).catch(() => {}).then(op);
    this.paneOps.set(runId, next);
    void next.finally(() => { if (this.paneOps.get(runId) === next) this.paneOps.delete(runId); }).catch(() => {});
    return next;
  }

  /** Claude のタブを transcript の中の指示へ跳ばす。手順と送るキーの制限は promptJump.ts にある。 */
  jumpToPrompt(runId: string, heads: string[], index: number, from: JumpFrom): Promise<JumpResult> {
    const io = this.agentPane(runId);
    return this.queuePane(runId, () => jumpToPrompt(io, heads, index, from));
  }

  /** Claude のタブが transcript を開いていれば閉じて、入力欄のある画面へ戻す。 */
  leaveTranscript(runId: string): Promise<{ left: boolean }> {
    const io = this.agentPane(runId);
    return this.queuePane(runId, async () => ({ left: await leaveTranscript(io) }));
  }
}
