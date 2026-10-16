import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newId, runTmuxId, type EndReason, type ResumeStray, type InterruptCause, type InterruptedDto, type Language, type LaunchParams, type LaunchResultDto, type LiveSessionDto, type RunDto, type RunKind, type TabDto, type Translate } from '@agent-hangar/shared';
import type { Account } from '../config/accounts.ts';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { setSessionName } from '../sessions/notes.ts';
import { pinnedProjectOf } from '../sessions/move.ts';
import { setSessionPlacement } from '../sessions/states.ts';
import type { GetLanguage } from '../i18n/language.ts';
import { errorText, msg, translatorOf } from '../i18n/message.ts';
import { ensureSession, findSession } from '../indexer/indexFile.ts';
import { DEFAULT_INJECTION_PARTS, renderInjection, type InjectionParts } from '../launch/injection.ts';
import { writeHookSettings } from '../provider/claude-code/launch/hookSettings.ts';
import { pruneMcpConfigs, removeMcpConfig, writeMcpConfig } from '../provider/claude-code/launch/mcpConfig.ts';
import { runCommand, shellTabCommand } from '../launch/command.ts';
import { RUN_DROPPED_ENV } from '../launch/env.ts';
import { needsShell } from '../platform/exec.ts';
import { toolPathIssue } from '../config/readiness.ts';
import { ensureHookScript } from '../launch/hookScript.ts';
import { ensureWrapperScript, pruneRunLogs, runLogPath } from '../launch/wrapper.ts';
import { promptMentionsDrops } from '../prompt/drops.ts';
import { assignSession, normalizeDir } from '../projects/registry.ts';
import { isUnder } from '../platform/paths.ts';
import { ensureScratchProject, newScratchDir } from '../projects/scratch.ts';
import { hasTranscriptFile } from '../provider/claude-code/transcript/discover.ts';
import { claudeCodeProvider } from '../provider/claude-code/index.ts';
import type { LaunchInput, LiveSession } from '../provider/claude-code/types.ts';
import type { PaneOps } from '../tmux/pane.ts';
import { RunAccounts, switchAccount } from './accounts.ts';
import { RunError } from './errors.ts';
import { aliveRunForSession, getRun, getTab, latestRunForSession, listActiveRuns, listAliveRuns, listTabs } from './queries.ts';
import { parseProcStart, realProcOpsWith, sameStartTime, type ProcOps } from '../provider/claude-code/process/procs.ts';
import { ScreenMissGate, screenDrift, type ScreenMark } from '../provider/claude-code/compat/screen.ts';
import { NO_COMPAT, type CompatSink } from '../provider/claude-code/compat/types.ts';
import { jumpToPrompt, leaveTranscript, type JumpFrom, type JumpResult, type PaneIo } from '../provider/claude-code/screen/promptJump.ts';
import { issueMcpSecret, pruneMcpSecrets, revokeMcpSecret } from './secrets.ts';
import { forgetInterruption, interruptedGroup, noteLastLive, pruneLastLive, recordInterruption } from './interrupted.ts';
import { isAlive } from '../platform/proc.ts';
import { splitTerminalArgs, terminalEnv, type TerminalRequest } from './terminal.ts';
import { handoverFacts, projectDeviceCount, resumeTarget, type ResumeTarget } from './handover.ts';
import { Pacer } from '../platform/pacer.ts';

/** 生きた run の heartbeat をこの間隔で更新する。手元だけの書き込みで、共有の changes には積まない（同期の版 6）。 */
const HEARTBEAT_MS = 30_000;
/**
 * stir（run の出入り、登録の変化、端末の中継の終わり）の後、終了の見張りを短い周期で回す長さ。
 * claude は登録を消してから終わり、tmux の画面はその後に閉じるので、登録の変化の直後の 1 回では消えた画面を拾えないことがある。
 */
export const RUN_STIR_MS = 10_000;
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
export function withUtf8Locale(env: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): Record<string, string> {
  // LC_CTYPE は Unix のロケールの変数で、Windows では意味を持たない。
  if (platform === 'win32' || env.LC_ALL || env.LC_CTYPE) return env;
  return { LC_CTYPE: 'UTF-8', ...env };
}

/** 引き取るときに、止めた claude がレジストリから消えるのを待つ長さ。 */
const GONE_WAIT_MS = 5_000;
/**
 * 生きた run の tmux 名が、続けてこの回数の見回りで一覧に無かったら閉じる。
 * Windows の psmux は、CPU を使い切っているセッションの返事が遅れると、一覧からそのセッションだけが一瞬抜ける（issue #258）。
 */
const MISSES_TO_END = 2;
/**
 * 見回りが run を exited か lost で閉じた後、生きた run が無くなっても一覧を読み続ける長さ。
 * 閉じた run の tmux 名が一覧に戻ってきたら、生き返らせるためである（revive）。
 */
const REVIVE_WATCH_MS = 10 * 60_000;
/**
 * 終わった扱いの run の pid の claude が、その run の claude と同じかを起動時刻で見るときの、run の起動より前の余裕。
 * run の行は tmux を開く前に書くので、claude はふつう run の起動より後に起きる。時計の粒（起動時刻は秒まで）と書く順のずれを見込む。
 */
const STRAY_SLACK_MS = 60_000;

export { RunError };

export type LaunchResult = LaunchResultDto;
/** interrupted は、中断の群を記録し直したとき（起動の見回りと、tmux のサーバが消えたとき）に、新しい群を渡す。 */
export type RunListener = { runStarted?(r: LaunchResult): void; runUpdated?(run: RunDto): void; runEnded?(run: RunDto): void; tabChanged?(tab: TabDto): void; interrupted?(group: InterruptedDto | null): void };
/**
 * live は Claude のレジストリの今の中身である。引き取りと attach が、外で動く claude の pid とバックグラウンドの id を引くのに使う。
 * procs は外のプロセスに触る口で、テストでは差し替える。
 * panes は run とシェルタブの画面に触る口（tmux/pane.ts）。無ければ起動を断り、見張りは何も閉じない。
 * accounts はアカウントの解決（runs/accounts.ts）。渡さなければ、アカウントを使わない構成として動く。
 * language は、Claude に渡す指示とシェルタブの名前の言語。組み立てる側が、設定を読む関数を渡す。
 * injection は、Claude に渡す指示のうち、区切りの問いの段とターンの意図の段を足すか。起動のたびに読むので、設定の変更は次の起動から効く。渡さなければ両方を足す。
 * 失敗（RunError）の文は鍵のまま投げ、経路と MCP の道具が出すときに言語を選ぶので、ここでは決めない。
 */
export type RunManagerDeps = { db: Db; deviceId: string; home: string; panes: PaneOps | null; /** 設定の tmux のパス（Windows は psmux）。起動の前に実物を確かめる。渡さなければ確かめない。 */ muxPath?: () => string | null; claudeBin: string | null; claudeDir: string; port: number; token: string; shell?: string; /** 動いている OS。試験で差し替える。 */ platform?: NodeJS.Platform; isLive?: (providerSessionId: string) => boolean; live?: () => LiveSession[]; procs?: ProcOps; now?: () => number; sleep?: (ms: number) => Promise<void>; accounts?: RunAccounts; /** Claude Code の形式のずれを受け取る口（provider/claude-code/compat/）。 */ compat?: CompatSink; language: GetLanguage; injection?: () => InjectionParts; /** hook の台本を走らせる node。渡さなければサーバ自身の node。 */ nodeBin?: string; /** pid のプロセスが生きているか。試験で差し替える。渡さなければ platform/proc.ts の isAlive。 */ pidAlive?: (pid: number) => boolean; /** claude を起こす直前に、その置き場（CLAUDE_CONFIG_DIR、最初のアカウントは null）の .claude.json へ cwd のフォルダの信頼を書く（projects/folderTrust.ts の trustBeforeLaunch）。渡さなければ書かない。 */ trustFolder?: (configDir: string | null, cwd: string) => void };

type ProjectInfo = { id: string; name: string; path: string | null; resolved: boolean };
type SessionRow = { id: string; provider_session_id: string; project_id: string | null; cwd: string };

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
  private pacer: Pacer | null = null;
  /** 最後に stir した時刻。 */
  private stirredAt = -Infinity;
  /** 引き取りの途中のセッション。二度押しで元のプロセスを止めて移す手順が 2 本走らないようにする。 */
  private adopting = new Set<string>();
  /** 区切りを付けたので落としにいった run。tmux から消えたのを見たときに、終わり方を parked と書くために持つ。 */
  private parking = new Set<string>();
  /**
   * 一覧に無かった生きた run ごとの、続けて抜けた見回りの回数と、最初に抜けたときに tmux のサーバごと消えて見えたか（mux）。
   * 一覧に出たら消す。メモリだけに持ち、サーバを起こし直したら数え直す。
   */
  private misses = new Map<string, { count: number; mux: boolean }>();
  /** この時刻までは、生きた run が無くても一覧を読む（REVIVE_WATCH_MS）。 */
  private reviveWatchUntil = -Infinity;
  /** 本物のプロセスに触る口。procs を渡されなかったときに、compat を結んで 1 度だけ作る。 */
  private realProcs: ProcOps | null = null;
  /** 画面の目印が続けて見つからなかった回数。run をまたいで数える（形式が変われば、どの run でも見つからない）。 */
  private readonly screenMisses = new ScreenMissGate();

  private readonly accounts: RunAccounts;
  /** いまの言語で引く。指示とタブの名前にだけ使う。 */
  private readonly tr: Translate;

  constructor(private readonly deps: RunManagerDeps) {
    this.tr = translatorOf(deps.language);
    this.accounts = deps.accounts ?? new RunAccounts({ db: deps.db, claudeDir: deps.claudeDir, deviceId: deps.deviceId });
  }

  on(l: RunListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit<K extends keyof RunListener>(k: K, arg: Parameters<NonNullable<RunListener[K]>>[0]): void {
    // run とタブの出入りの後は、続けて画面が閉じることが多いので、しばらく短い周期で見る。
    if (k !== 'runUpdated') this.stir();
    for (const l of this.listeners) (l[k] as ((a: typeof arg) => void) | undefined)?.(arg);
  }

  /** Settings で tmuxPath が変わったときに差し替える。生きている run はそのまま観測を続ける。 */
  setPanes(panes: PaneOps | null): void {
    this.deps.panes = panes;
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
    const line = errorText(this.language(), e).split('\n')[0]!.trim();
    const named = this.deps.token ? line.replaceAll(this.deps.token, '***') : line;
    const masked = named.replace(/\b[0-9a-f]{64}\b/g, '***');
    return masked.length > MAX_ERROR_LEN ? `${masked.slice(0, MAX_ERROR_LEN)}…` : masked;
  }

  private language(): Language {
    return this.deps.language();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get db(): Db {
    return this.deps.db;
  }

  private panes(): PaneOps {
    if (!this.deps.panes) throw new RunError(400, msg('run.launch.tmuxMissing', { label: msg('settings.label.tmuxPath') }));
    return this.deps.panes;
  }

  /**
   * 起こすための画面の口。口が無いのに加えて、設定の tmux のパスが指すものが無いか実行できなければ断る。
   * 口はパスが入っていれば作られるので、指したファイルが後から消えても残る。そのまま進むと、ペインを開く段で初めて失敗する。
   * 引き取り（adopt）は外の claude を止めたあとに開くので、それでは元の会話を止めたまま終わる。だから起こす前にここで確かめる。
   * 止める、画面を読むといった既存の run への操作は、この確かめを通さない（panes()）。
   */
  private startPanes(): PaneOps {
    const panes = this.panes();
    const p = this.deps.muxPath?.();
    const issue = p ? toolPathIssue(p) : null;
    if (issue) {
      const label = msg('settings.label.tmuxPath');
      throw new RunError(400, issue.key === 'settings.path.notOnPath' ? msg(issue.key, { label, name: issue.name }) : msg(issue.key, { label, path: issue.path }));
    }
    return panes;
  }

  /**
   * claude の絶対パス。分からなければ起動そのものを断る。
   * tmux のペインは hangar の PATH を継ぐので、.app から起こしたときは裸の `claude` を引けない。
   * 引けない名前をそのまま渡すと、応答は成功のままペインの中で 127 で落ち、
   * 利用者はターミナルを開くまで理由が分からない。だから渡す前にここで止める。
   */
  private claudeBin(): string {
    if (!this.deps.claudeBin) throw new RunError(400, msg('run.launch.claudeMissing', { label: msg('settings.label.claudePath') }));
    // npm で入れた古い Claude Code は Windows で claude.cmd になる。.cmd は cmd.exe 越しにしか起こせず、
    // 注入するシステムプロンプトのような改行や引用符を含む引数を安全に渡せない。
    if (needsShell(this.deps.claudeBin, this.deps.platform)) throw new RunError(400, msg('run.launch.claudeIsCmd', { label: msg('settings.label.claudePath') }));
    return this.deps.claudeBin;
  }

  private project(projectId: string): ProjectInfo {
    const r = this.db
      .prepare('select p.id, p.name, p.is_scratch, r.path, r.resolved from projects p left join project_roots r on r.project_id = p.id and r.device_id = ? and r.deleted_at is null where p.id = ? and p.deleted_at is null')
      .get(this.deps.deviceId, projectId) as { id: string; name: string; is_scratch: number; path: string | null; resolved: number | null } | undefined;
    if (!r) throw new RunError(404, msg('project.error.notFound'));
    // クイックセッションの DB の名前（スクラッチ）は内部のもので、画面と同じ辞書の名前で伝える。
    return { id: r.id, name: r.is_scratch === 1 ? this.tr('project.name.quick') : r.name, path: r.path, resolved: r.resolved === 1 };
  }

  private mcpUrl(sessionId: string): string {
    return `http://127.0.0.1:${this.deps.port}/mcp/s/${sessionId}`;
  }

  /**
   * AskUserQuestion の問いの文を本文より先に受け取る hook の設定を書く（provider/claude-code/launch/hookSettings.ts）。
   * 台本はサーバ自身の node で走らせる。
   * 書けなくても起動は止めない。問いの文は今までどおり本文から取る。
   */
  private hookSettings(sessionId: string, mcpConfigPath: string): string | undefined {
    try {
      return writeHookSettings(this.deps.home, sessionId, { node: this.deps.nodeBin ?? process.execPath, script: ensureHookScript(this.deps.home), mcpConfigPath });
    } catch (e) {
      console.error('[runs] hook の設定を書けませんでした', e instanceof Error ? e.message : e);
      return undefined;
    }
  }

  /**
   * 起動できるかを先に確かめる。行を作る前に呼ぶので、失敗しても孤児の行が残らない。
   * create は、cwd がまだ無く、確かめが通ったら作るとき（ほかの PC のクイックセッション、resumeTarget の createsFolder）。
   * 作るのは claude と tmux の確かめの後である。断ったときに空のフォルダを残さない。
   * mayCreate は、後で作るので無くてもよいが、ここでは作らないとき（アカウントの切り替えの、止める前の確かめ）。
   */
  private precheck(cwd: string, o: { create?: boolean; mayCreate?: boolean } = {}): PaneOps {
    if (!o.create && !o.mayCreate && !isDirectory(cwd)) throw new RunError(400, msg('run.launch.dirMissing', { path: cwd }));
    this.claudeBin();
    const panes = this.startPanes();
    if (o.create) fs.mkdirSync(cwd, { recursive: true });
    return panes;
  }

  /**
   * 注入する指示。プロジェクトが無ければ「未分類」として cwd だけを書く。TODO には、利用者がまだ受け入れていない Claude の提案を入れない。
   * handoverFrom は、引き継ぎを判定する会話（再開ならその会話、フォークなら元の会話）。新しい会話では渡さない。
   * 直前の run がほかの PC なら引き継ぎの段を、プロジェクトを 2 台以上の PC で使っていれば弱い 1 文を足す（runs/handover.ts）。
   */
  private injectionFor(projectId: string | null, cwd: string, handoverFrom?: string): string {
    const p = projectId ? this.project(projectId) : null;
    const todos = projectId ? (this.db.prepare('select id, text from todos where project_id = ? and done = 0 and suggested_at is null and deleted_at is null order by position limit 10').all(projectId) as { id: string; text: string }[]) : [];
    const handover = handoverFrom ? handoverFacts(this.db, { sessionId: handoverFrom, selfDeviceId: this.deps.deviceId, cwd }) : null;
    const deviceCount = projectId ? projectDeviceCount(this.db, projectId) : 0;
    return renderInjection({ projectName: p?.name ?? this.tr('project.name.uncategorized'), projectPath: cwd, todos, handover, deviceCount }, this.language(), this.deps.injection?.() ?? DEFAULT_INJECTION_PARTS);
  }

  /**
   * 再開とフォークの作業ディレクトリ（runs/handover.ts の resumeTarget）。
   * 前の PC のパスは、この PC のプロジェクトの場所に読み替える。共有の行の sessions.cwd は書き換えない。
   * プロジェクトに属する会話で、この PC に場所が無いときは、起こす前に場所が無いと断る。
   * プロジェクトに属さない会話は今までどおり sessions.cwd を使い、無ければ precheck が断る。
   * ここではフォルダを作らない。ほかの PC のクイックセッションの quick-sessions/<元のフォルダ名> は、起動の確かめ（precheck）が通ってから作る。
   */
  private cwdFor(s: SessionRow): ResumeTarget {
    const local = resumeTarget(this.db, this.deps.deviceId, s);
    if (local) return local;
    if (s.project_id) throw new RunError(400, msg('run.launch.projectDirMissing'));
    return { path: s.cwd, createsFolder: false };
  }

  /**
   * 「この PC で再開」が本文を写す前に呼ぶ。この PC で起こせない会話なら、写す前に断る。
   * 無いセッションはここでは断らずに null を返す。写しの側が「トランスクリプトがありません」で断る。
   */
  resumeCwdOf(sessionId: string): string | null {
    const s = this.db.prepare('select * from sessions where id = ? and deleted_at is null').get(sessionId) as SessionRow | undefined;
    // 確かめるだけなので、クイックセッションのフォルダはまだ作らない。写しに失敗したときに空のフォルダを残さないためである。
    return s ? this.cwdFor(s).path : null;
  }

  /**
   * --add-dir に渡す値を整える。
   * --add-dir は可変長オプションなので、`-` で始まる値はそのまま claude のフラグとして食われる。
   * `addDirs: ["--dangerously-skip-permissions"]` のような指定を通さない。
   */
  private addDirs(params: LaunchParams): string[] {
    const dirs = (params.addDirs ?? []).map((d) => d.trim()).filter(Boolean);
    for (const d of dirs) if (d.startsWith('-')) throw new RunError(400, msg('run.launch.addDirDash', { dir: d }));
    return dirs;
  }

  private baseInput(sessionId: string, projectId: string | null, cwd: string, params: LaunchParams, handoverFrom?: string): Omit<LaunchInput, 'mode'> {
    const s = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
    // claude に渡すのは本体のトークンではなく、この run 専用の秘密である。
    // 本体のトークンを渡すと、claude は自分の設定ファイルを読んで共通の /mcp と /api に回れる。
    // 秘密を argv に載せないため、MCP の設定は 0600 のファイルに置き、パスだけを claude に渡す。
    const mcpConfigPath = writeMcpConfig(this.deps.home, sessionId, this.mcpUrl(sessionId), issueMcpSecret(this.db, sessionId, this.now()));
    return {
      systemPrompt: this.injectionFor(projectId, cwd, handoverFrom),
      mcpConfigPath,
      settingsPath: this.hookSettings(sessionId, mcpConfigPath),
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
  private launch(o: { sessionId: string; cwd: string; kind: RunKind; command: string[]; params: LaunchParams; env?: Record<string, string>; account?: Account | null; /** cwd がまだ無く、確かめが通ったら作る（precheck の create）。 */ createFolder?: boolean }): LaunchResult {
    // フォルダを作るのは確かめの後で、信頼を書く（trustFolder）より前である。作ったフォルダに信頼を書く。
    const panes = this.precheck(o.cwd, { create: o.createFolder });
    // 利用者が自分で付けた CLAUDE_CONFIG_DIR（o.env）は、アカウントの置き場で上書きしない。
    // その置き場が登録済みならそのアカウントとして、未登録なら何も記録しない。呼び手が別のアカウントを渡していても、実際に動く置き場に合わせる。
    const own = o.env?.CLAUDE_CONFIG_DIR;
    const account = own ? this.accounts.byDir(own) : o.account ?? null;
    const env = { ...this.accounts.envFor(own ? null : account), ...o.env };
    const params: LaunchParams = account ? { ...o.params, account: account.id } : o.params;
    const runId = newId();
    const tmuxName = `hangar-${runTmuxId(runId)}`;
    const wrapper = ensureWrapperScript(this.deps.home);
    const log = runLogPath(this.deps.home, runId);
    // tmux サーバの全体の環境に残った Claude Code の印と hangar の受け渡しの変数は、どの起動でも外す（launch/env.ts）。
    // 置き場を足さない起動（最初のアカウント）は、tmux サーバが持っている CLAUDE_CONFIG_DIR も外す。
    // tmux サーバを別のアカウントのシェルから起こしていると、足さないだけではその置き場で動いてしまう。
    const unset = env.CLAUDE_CONFIG_DIR ? RUN_DROPPED_ENV : [...RUN_DROPPED_ENV, 'CLAUDE_CONFIG_DIR'];
    const wrapped = runCommand({ runId, wrapper, log, command: o.command, unset });
    // クイックセッションの置き場と、同意を得た作業フォルダでは、信頼の確認を出さずに始められるよう、起こすアカウントの設定に前もって書く。
    // 書けなくても（Claude Code がロックを握っている、設定が壊れているなど）起動は止めない。そのときは claude がいつもどおり確認を出す。
    try {
      this.deps.trustFolder?.(env.CLAUDE_CONFIG_DIR || null, o.cwd);
    } catch (e) {
      console.error('[runs] フォルダの信頼を書けませんでした', e instanceof Error ? e.message : e);
    }
    const now = this.now();
    upsertShared(this.db, 'runs', { id: runId, session_id: o.sessionId, device_id: this.deps.deviceId, kind: o.kind, tmux_name: tmuxName, pid: null, launch_params: JSON.stringify(params), started_at: now, ended_at: null, end_reason: null, heartbeat_at: now }, this.deps.deviceId);
    try {
      panes.open({ name: tmuxName, cwd: o.cwd, command: wrapped.command, env: withUtf8Locale({ ...env, ...wrapped.env }) });
      // ターミナルからこの run につなぐ人のための設定。サーバ全体の設定なので、サーバが起き直した後にも効くよう起動のたびに確かめる。
      panes.prepareForOutsideTerminals();
    } catch (e) {
      this.end(runId, 'exited');
      throw new RunError(400, msg('run.launch.tmuxFailed', { reason: this.safeError(e) }));
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
  private end(runId: string, reason: EndReason): RunDto | null {
    const row = this.db.prepare('select * from runs where id = ? and deleted_at is null').get(runId) as Record<string, unknown> | undefined;
    if (!row || row.ended_at !== null) return null;
    upsertShared(this.db, 'runs', { ...row, ended_at: this.now(), end_reason: reason }, this.deps.deviceId);
    this.parking.delete(runId);
    this.misses.delete(runId);
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
    // 行を作る前に、アカウントとリンクを確かめる。知らないアカウントや壊れたリンクで、本文の無いセッションが残らないようにする。
    const account = this.accounts.resolve(params.account);
    this.accounts.envFor(account);
    // スクラッチは擬似プロジェクトの行と使い捨てのディレクトリを作ってしまうので、
    // 後の precheck を待たずに、ここで tmux と claude の有無だけ先に確かめる。
    // これが無いと、どちらも無い端末で起動を試すたびに空のディレクトリが溜まる。
    if (params.scratch) { this.startPanes(); this.claudeBin(); }
    // スクラッチは使い捨てのディレクトリを作り、擬似プロジェクトに属させる。
    // projectId が一緒に来ていても scratch を優先する。
    const p = params.scratch ? this.scratchProject() : this.namedProject(params.projectId);
    if (!p.path || !p.resolved) throw new RunError(400, msg('run.launch.projectDirMissing'));
    // 作業の場所（cwd）は、プロジェクトの場所の下のフォルダから始めるときに来る。スクラッチでは使わない。
    // 外を許すと、そのプロジェクトのセッションがプロジェクトの外で動き、紐づけ（場所の最長一致）とも食い違うので断る。
    const sub = params.scratch ? null : this.workDir(p.path, params.cwd);
    // スクラッチのディレクトリは precheck より先に作る。precheck は cwd が実在するかを見るためである。
    const cwd = params.scratch ? newScratchDir(this.deps.home, new Date(this.now())) : sub ?? p.path;
    this.precheck(cwd);
    const sessionUuid = crypto.randomUUID();
    const sessionId = ensureSession(this.db, sessionUuid, cwd, this.deps.deviceId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, project_id: p.id, started_at: now, last_activity_at: now }, this.deps.deviceId);
    // 起動のときに付けた名前は session_notes に書く。付けなければ行を作らない。
    setSessionName(this.db, this.deps.deviceId, sessionId, params.name?.trim() || null);
    const base = this.baseInput(sessionId, p.id, cwd, params);
    // 添付つきの初期プロンプトは、置き場（hangar の home の drops）の中のファイルを指す。
    // 置き場は作業ディレクトリの外なので、足さないと claude が読む前に許可を尋ねて止まる。
    // 足すのは claude に渡す引数だけで、run に残す起動の指定（params）は変えない。画面が覚える addDirs に混ざらないためである。
    const dropsDir = path.join(this.deps.home, 'drops');
    const addDirs = promptMentionsDrops(params.prompt, dropsDir) && !base.addDirs?.includes(dropsDir) ? [...(base.addDirs ?? []), dropsDir] : base.addDirs;
    const input: LaunchInput = { ...base, addDirs, mode: { kind: 'start', sessionUuid } };
    const command = claudeCodeProvider.launchCommand(this.claudeBin(), input);
    return this.launch({ sessionId, cwd, kind: 'start', command, params, account });
  }

  /**
   * 起動の指定の作業の場所（cwd）を、プロジェクトの場所の下の正規化したパスにする。渡されなければ null（プロジェクトの場所で起こす）。
   * 相対パスと、プロジェクトの場所の外は 400 で断る。実在は precheck が確かめる。
   */
  private workDir(projectPath: string, raw: string | undefined): string | null {
    if (raw === undefined || raw.trim() === '') return null;
    const dir = path.isAbsolute(raw.trim()) ? normalizeDir(raw.trim()) : null;
    if (dir === null || !isUnder(dir, normalizeDir(projectPath))) throw new RunError(400, msg('run.launch.cwdOutside', { path: raw }));
    return dir;
  }

  /** scratch ではないときの起動先。projectId は必須である。 */
  private namedProject(projectId: string | undefined): ProjectInfo {
    if (!projectId) throw new RunError(400, msg('run.launch.projectRequired'));
    return this.project(projectId);
  }

  /** この端末のスクラッチの擬似プロジェクト。無ければ作る。 */
  private scratchProject(): ProjectInfo {
    return this.project(ensureScratchProject(this.db, this.deps.deviceId, this.deps.home));
  }

  private session(sessionId: string): SessionRow {
    const s = this.db.prepare('select * from sessions where id = ? and deleted_at is null').get(sessionId) as SessionRow | undefined;
    if (!s) throw new RunError(404, msg('session.error.notFound'));
    return s;
  }

  private hasBody(sessionId: string): boolean {
    return !!this.db.prepare('select 1 from transcript_files where session_id = ? and agent_id is null limit 1').get(sessionId);
  }

  /**
   * 再開できる状態かを確かめる。本文の有無、hangar の run、hangar の外で動いている Claude は、どれも別の原因である。
   * strayCheck が真なら、終わった扱いの run の claude が動き続けているか（strayPid）も見て、残っていれば pid を添えて 409 で断る。
   * 見るのは同じ会話を続ける再開だけで、新しい会話になるフォークは見ない。
   */
  private assertResumable(s: SessionRow, stray: 'off' | 'check' | 'ignore' = 'off'): void {
    if (!this.hasBody(s.id)) throw new RunError(400, msg('run.resume.noTranscript'));
    if (aliveRunForSession(this.db, s.id, this.deps.deviceId, this.now())) throw new RunError(409, msg('run.error.sessionRunning'));
    const strayError = (pid: number) => new RunError(409, msg('run.error.strayProcess', { pid }), { code: 'stray_process', pid });
    if (this.deps.isLive?.(s.provider_session_id)) {
      // 登録に載っていても、その pid が終わった扱いの run の claude なら、hangar の外ではなく見失った自分の claude である（issue #258 の場面そのもの）。
      // 止めた後も登録はしばらく残りうるので、ignore（止めた後の再開も含む）はそれで断らない。
      if (stray === 'off' || !this.ownLive(s)) throw new RunError(409, msg('run.error.runningOutside'));
      if (stray === 'ignore') return;
      const pid = this.strayPid(s);
      throw pid === null ? new RunError(409, msg('run.error.runningOutside')) : strayError(pid);
    }
    if (stray !== 'check') return;
    const pid = this.strayPid(s);
    if (pid !== null) throw strayError(pid);
  }

  /** 登録に載っているそのセッションの claude が、この端末の最も新しい終わった扱い（exited か lost）の run の claude（pid が同じ）か。 */
  private ownLive(s: SessionRow): boolean {
    const r = latestRunForSession(this.db, s.id, this.deviceId);
    if (!r || r.endedAt === null || (r.endReason !== 'exited' && r.endReason !== 'lost') || r.pid === null) return false;
    return (this.deps.live?.() ?? []).some((l) => l.sessionId === s.provider_session_id && l.pid === r.pid);
  }

  /**
   * hangar では終わった扱い（exited か lost）なのに、その run の claude がまだ動いているときの pid。無ければ null。
   * 見張りが一覧の読み違いで run を閉じたとき（issue #258）に起きる。このまま再開すると、2 つの claude が同じ会話を進める。
   * 見るのは、この端末のそのセッションの最も新しい run だけである。
   * pid は使い回されるので、そのプロセスの起動時刻が、run の起動の少し前（STRAY_SLACK_MS）から終わりまでの間にあるときだけ、同じ claude と見る。
   * 起動時刻が読めなければ、同じとは言えないので null にする（関係の無いプロセスを止めないため）。
   */
  private strayPid(s: SessionRow): number | null {
    const r = latestRunForSession(this.db, s.id, this.deviceId);
    if (!r || r.endedAt === null || (r.endReason !== 'exited' && r.endReason !== 'lost') || r.pid === null) return null;
    if (!(this.deps.pidAlive ?? isAlive)(r.pid)) return null;
    const raw = this.procs().startTimeOf(r.pid);
    const at = raw === null ? null : parseProcStart(raw);
    if (at === null || at < r.startedAt - STRAY_SLACK_MS || at > r.endedAt) return null;
    return r.pid;
  }

  /**
   * 画面の「再開」。終わった扱いの run の claude が動き続けていたときの選び方（stray）を受ける。
   * 付けなければ、残っていれば 409（run.error.strayProcess）で断り、画面が確認を出す。
   * stop は、その claude を止め、止まったのを確かめてから再開する。止められなければ 409（run.error.strayNotStopped）で断り、再開しない。
   * ignore は、この判定を飛ばして再開する（2 つの claude が同じ会話を進めることを、利用者が承知している）。
   */
  async resumeWith(sessionId: string, o: { stray?: ResumeStray } = {}): Promise<LaunchResult> {
    if (o.stray !== 'stop') return this.resume(sessionId, { stray: o.stray });
    const s = this.session(sessionId);
    this.assertResumable(s, 'ignore');
    const pid = this.strayPid(s);
    if (pid !== null && !(await this.procs().terminate(pid, TERMINATE_MS))) throw new RunError(409, msg('run.error.strayNotStopped', { pid }));
    return this.resume(sessionId, { stray: 'ignore' });
  }

  /**
   * 同じ cwd で claude -r <uuid> を実行し、同じセッションに kind = 'resume' の run を付ける。
   * Claude のバックグラウンドのサービスが持っていたセッション（止まったもの、1 時間つながれずに止まったもの）は、
   * claude -r ではなく `claude attach` で起こす。-r で hangar の tmux に開くと、元のターミナルから attach で戻れなくなる。
   * 終わった扱いの run の claude が動き続けていれば 409 で断る（strayPid）。stray が ignore なら、その判定を飛ばす。
   */
  resume(sessionId: string, extra: { args?: string[]; env?: Record<string, string>; account?: string; stray?: 'ignore' } = {}): LaunchResult {
    const s = this.session(sessionId);
    this.assertResumable(s, extra.stray === 'ignore' ? 'ignore' : 'check');
    // ほかの PC のクイックセッションのフォルダは、アカウント、バックグラウンドの一覧、起動の確かめが通ってから launch が作る。
    const { path: cwd, createsFolder: createFolder } = this.cwdFor(s);
    const account = extra.account !== undefined ? this.accounts.resolve(extra.account) : this.accounts.lastUsed(s.id);
    const bin = this.claudeBin();
    const job = this.procs().listJobs(bin)?.find((j) => j.sessionId === s.provider_session_id) ?? null;
    if (job) return this.launch({ sessionId: s.id, cwd, kind: 'resume', command: [bin, 'attach', job.id], params: { projectId: s.project_id ?? undefined }, env: extra.env, account, createFolder });
    // claude -r <uuid> は、cwd が前と違っても、どのプロジェクトの置き場にある本文でも見つけて、その本文に書き足す（Claude Code 2.1 で確かめた）。
    const command = claudeCodeProvider.resumeCommand(this.claudeBin(), this.baseInput(s.id, s.project_id, cwd, {}, s.id), { providerSessionId: s.provider_session_id }, false);
    return this.launch({ sessionId: s.id, cwd, kind: 'resume', command: [...command, ...(extra.args ?? [])], params: { projectId: s.project_id ?? undefined }, env: extra.env, account, createFolder });
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
    // 空文字は付けていないのと同じに扱う。渡すと、いまのアカウントの置き場を空文字で上書きして既定の置き場で動いてしまう。
    if (env.CLAUDE_CONFIG_DIR === '') delete env.CLAUDE_CONFIG_DIR;
    // 利用者が自分で置き場を付けたら、それを優先する。登録済みの置き場ならそのアカウントとして記録し、未登録なら記録しない。
    const account = env.CLAUDE_CONFIG_DIR ? this.accounts.byDir(env.CLAUDE_CONFIG_DIR) : this.accounts.resolve(undefined);
    if (resume) {
      const id = findSession(this.db, resume);
      if (!id) throw new RunError(404, msg('run.terminal.notInHangar'));
      const alive = aliveRunForSession(this.db, id, this.deps.deviceId, this.now());
      if (alive) return { run: alive, sessionId: id, tabs: listTabs(this.db, alive.id), attached: true };
      // 以前の包み方や `claude --bg` で起こしたものはバックグラウンドで動いている。素の claude -r は写しを作るので、attach でつなぐ。
      const provider = (this.db.prepare('select provider_session_id from sessions where id = ?').get(id) as { provider_session_id: string }).provider_session_id;
      if (this.liveOf(provider)?.background) return { ...this.attach(id), attached: false };
      return { ...this.resume(id, { args: rest, env, account: env.CLAUDE_CONFIG_DIR ? account?.id : undefined }), attached: false };
    }
    this.precheck(req.cwd);
    // リンクの確かめは行を作る前に済ませる。利用者が自分で置き場を付けたときは、アカウントの置き場を使わないので確かめない。
    if (!env.CLAUDE_CONFIG_DIR) this.accounts.envFor(account);
    const sessionUuid = crypto.randomUUID();
    const sessionId = ensureSession(this.db, sessionUuid, req.cwd, this.deps.deviceId);
    const projectId = assignSession(this.db, this.deps.deviceId, sessionId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, started_at: now, last_activity_at: now }, this.deps.deviceId);
    const input: LaunchInput = { ...this.baseInput(sessionId, projectId, req.cwd, {}), mode: { kind: 'start', sessionUuid } };
    const command = [...claudeCodeProvider.launchCommand(this.claudeBin(), input), ...rest];
    return { ...this.launch({ sessionId, cwd: req.cwd, kind: 'start', command, params: { projectId: projectId ?? undefined }, env, account }), attached: false };
  }

  /** 新しい sessions 行を作り、claude -r <uuid> --fork-session --session-id <new> で起動する。名前は Claude が本文から引き継ぐ（索引が sessions.custom_title に拾う）ので、hangar の名前は付けない。 */
  fork(sessionId: string): LaunchResult {
    const s = this.session(sessionId);
    this.assertResumable(s);
    const account = this.accounts.lastUsed(s.id);
    // リンクの確かめも行を作る前に済ませる。壊れていると、本文の無い行が残る。
    this.accounts.envFor(account);
    // 新しい行を作る前に起動できるかを確かめる。失敗しても本文の無いセッションが残らないようにするため。
    // フォークした本文はこの PC の cwd の置き場に生まれるので、新しい行の cwd は読み替えた方にする。
    // ほかの PC のクイックセッションのフォルダは、この確かめが通ってから作る（precheck の create）。
    const { path: cwd, createsFolder } = this.cwdFor(s);
    this.precheck(cwd, { create: createsFolder });
    const newUuid = crypto.randomUUID();
    const newSessionId = ensureSession(this.db, newUuid, cwd, this.deps.deviceId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(newSessionId) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, project_id: s.project_id, started_at: now, last_activity_at: now }, this.deps.deviceId);
    // 利用者が移した会話なら、新しい会話にも移した印を写す（sessions/move.ts）。写さないと、索引の自動の振り分けが cwd から元のプロジェクトへ戻す。
    const pin = pinnedProjectOf(this.db, s.id);
    if (pin !== null) setSessionPlacement(this.db, this.deps.deviceId, newSessionId, pin);
    const command = claudeCodeProvider.resumeCommand(this.claudeBin(), this.baseInput(newSessionId, s.project_id, cwd, {}, s.id), { providerSessionId: s.provider_session_id }, true, newUuid);
    return this.launch({ sessionId: newSessionId, cwd, kind: 'fork', command, params: { projectId: s.project_id ?? undefined }, account });
  }

  /** 開いているセッションを、別のアカウントで再開し直す。手順と断る理由は runs/accounts.ts にある。ここは run の寿命の側の手を渡すだけである。 */
  switchAccount(sessionId: string, accountId: string): Promise<LaunchResult> {
    return switchAccount(this.accounts, {
      session: (id) => this.session(id),
      hasBody: (id) => this.hasBody(id),
      // 共有の行の cwd ではなく、再開に使う cwd（ほかの PC のパスをこの PC へ読み替えた後）で確かめる。
      // ほかの PC のクイックセッションのフォルダがまだ無ければ、ここでは作らず、再開（launch）が確かめの後に作る。
      precheck: (id) => { const t = this.cwdFor(this.session(id)); this.precheck(t.path, { mayCreate: t.createsFolder }); },
      isBackground: (providerSessionId) => !!this.liveOf(providerSessionId)?.background,
      isLive: (providerSessionId) => !!this.deps.isLive?.(providerSessionId),
      aliveRun: (id) => aliveRunForSession(this.db, id, this.deps.deviceId, this.now()),
      kill: (runId) => { this.kill(runId); },
      resume: (id, extra) => this.resume(id, extra),
      sleep: this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    }, sessionId, accountId);
  }

  /** レジストリのうち、Claude の UUID が一致する項目。 */
  private liveOf(providerSessionId: string): LiveSession | null {
    return this.deps.live?.().find((l) => l.sessionId === providerSessionId) ?? null;
  }

  private procs(): ProcOps {
    return this.deps.procs ?? (this.realProcs ??= realProcOpsWith(this.deps.compat ?? NO_COMPAT));
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
    if (aliveRunForSession(this.db, s.id, this.deps.deviceId, this.now())) throw new RunError(409, msg('run.error.sessionRunning'));
    const l = this.liveOf(s.provider_session_id);
    if (!l?.background) throw new RunError(409, msg('run.attach.notBackground'));
    const command = [this.claudeBin(), 'attach', l.background.jobId];
    return this.launch({ sessionId: s.id, cwd: s.cwd, kind: 'resume', command, params: { projectId: s.project_id ?? undefined }, account: this.accounts.lastUsed(s.id) });
  }

  /**
   * hangar の外のターミナル（VS Code など）で動く claude を引き取り、hangar で開く。
   * 外のターミナルの画面は、そのターミナルのアプリしか持っていないので、横からはつなげない。
   * そこで元の claude を SIGTERM で終わらせ、レジストリから消えるのを待ってから、同じ id のまま hangar の tmux の中で再開する（resume と同じ run になる）。
   *
   * 作業中は引き取らない。止めた時点の作業が途中で切れるからである。
   * ターミナルの CLI（entrypoint が cli）の claude だけを引き取る。VS Code の拡張やアプリの中の claude を止めると、その画面の側が壊れる。
   * 止める前に、本文があるか（再開できるか）を確かめる。止めた後で再開できないと、会話はあるのに claude が居ない状態で終わる。
   * 入力待ちで止めると、答えを待っていた問いは「答えなかった」として閉じる。会話は続けられ、文で答え直せばよい。
   * 止める前に、pid の起動時刻がレジストリの記録と合うかを確かめる。pid が使い回されていたら別のプロセスを止めてしまう。
   */
  async adopt(sessionId: string): Promise<LaunchResult> {
    const s = this.session(sessionId);
    if (aliveRunForSession(this.db, s.id, this.deps.deviceId, this.now())) throw new RunError(409, msg('run.error.sessionRunning'));
    const l = this.liveOf(s.provider_session_id);
    if (!l) throw new RunError(409, msg('run.adopt.notRunning'));
    if (l.background) return this.attach(s.id);
    if (l.status === 'busy') throw new RunError(409, msg('run.adopt.busy'));
    if (l.entrypoint !== 'cli') throw new RunError(409, msg('run.adopt.notCli'));
    if (this.adopting.has(s.id)) throw new RunError(409, msg('run.adopt.inProgress'));
    this.precheck(s.cwd);
    // 止めた後で再開できないと、会話はあるのに claude が居ない状態で終わる。本文の有無は止める前に確かめる。
    if (!this.db.prepare('select 1 from transcript_files where session_id = ? and agent_id is null limit 1').get(s.id)) throw new RunError(400, msg('run.adopt.noTranscript'));
    const started = this.procs().startTimeOf(l.pid);
    if (!l.procStart || !started || !sameStartTime(started, l.procStart)) throw new RunError(409, msg('run.adopt.processUnverified'));
    this.adopting.add(s.id);
    try {
      if (!(await this.procs().terminate(l.pid, TERMINATE_MS))) throw new RunError(409, msg('run.adopt.notTerminated'));
      // ここから先で失敗しても、元の claude はもう居ない。会話は残っているので、開き直す手（claude --resume）を文に添える。
      // レジストリから消える前に再開すると、hangar の外で動いていると見て断ってしまう。
      if (!(await this.waitForGone(s.provider_session_id))) throw new RunError(409, msg('run.adopt.recordRemained', { id: s.provider_session_id }));
      try {
        return this.resume(s.id);
      } catch (e) {
        if (e instanceof RunError) throw new RunError(e.status, msg('run.adopt.resumeFailed', { reason: e.text ?? e.message, id: s.provider_session_id }));
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
    // 見張るものが無ければ tmux を呼ばない。一覧の読み取りは子プロセスを 1 つ起こす。
    // 閉じたばかりの run があれば、しばらくは読み続ける。戻ってきたら生き返らせる（revive）。
    const shellTabs = this.openShellTabs();
    const now = this.now();
    if (shellTabs.length === 0 && listAliveRuns(this.db, this.deviceId).length === 0 && now >= this.reviveWatchUntil) return { ended: [], closedTabs: [] };
    const listed = this.deps.panes?.list() ?? null;
    if (listed === null) return { ended: [], closedTabs: [] };
    const names = new Set(listed);
    const ended: RunDto[] = [];
    const closedTabs: TabDto[] = [];
    // 消えたタブを先に閉じる。run を閉じるときの後始末が、既に死んだシェルタブを
    // 「まだ動いている」と読み違えないようにするため。
    for (const t of shellTabs) {
      if (!names.has(t.tmuxName)) {
        const c = this.closeTabRow(t.id);
        if (c) closedTabs.push(c);
      }
    }
    const alive = listAliveRuns(this.db, this.deviceId);
    // 止めにいっていない run は、一覧から 1 回抜けただけでは閉じない（MISSES_TO_END）。
    // psmux は CPU を使い切っているセッションの返事が遅れて、一覧から一瞬抜けることがある（issue #258）。
    // tmux のサーバごと消えた（一覧が空になり、止めにいっていない生きた run が 2 件以上まとめて抜けた）なら、利用者が終わらせたのではなく中断である。
    // この見分けは、run が抜け始めた見回りで行い、閉じるときまで覚えておく。猶予の間に抜けた順がずれても、まとめて消えたものだけを lost にするためである。
    // 1 件だけなら、最後の 1 本が終わって tmux のサーバも終わったのと見分けられないので、これまでどおり exited にする。
    const newlyVanished = alive.filter((r) => !names.has(r.tmuxName) && !this.parking.has(r.id) && !this.misses.has(r.id));
    const muxGone = listed.length === 0 && newlyVanished.length >= 2;
    const lost: RunDto[] = [];
    for (const run of alive) {
      if (!names.has(run.tmuxName)) {
        if (this.parking.has(run.id)) {
          const e = this.end(run.id, 'parked');
          if (e) ended.push(e);
          continue;
        }
        const miss = this.misses.get(run.id) ?? { count: 0, mux: muxGone };
        miss.count++;
        this.misses.set(run.id, miss);
        if (miss.count < MISSES_TO_END || this.stillRunning(run)) continue;
        const e = this.end(run.id, miss.mux ? 'lost' : 'exited');
        if (e) ended.push(e);
        if (e && e.endReason === 'lost') lost.push(e);
        continue;
      }
      this.misses.delete(run.id);
      // 落としにいったのに残っているなら、落とせていない。後で自分で終わったときに parked と書かないよう、印を外す。
      this.parking.delete(run.id);
      // heartbeat は手元だけの書き込みで、共有の changes に積まない（同期の版 6）。
      // 他の PC はこの PC の生存を、Worker が見た最終接続（pull の応答の peers）で見るので、この列を読まない。
      // 版 5 までは 30 秒ごとに共有の行を書き直し、端末が送る変更の 6 割を占めていた。
      // updated_at も変えない。起動、生き返り、終了の共有の書き込みは、そのときの値を行ごと運ぶ。
      // 画面へは配らない。配ると、待機中も 30 秒ごとに run の数だけ画面が描き直される。
      if (now - run.heartbeatAt >= HEARTBEAT_MS) {
        this.db.prepare('update runs set heartbeat_at = ? where id = ?').run(now, run.id);
      }
    }
    if (lost.length) this.interrupted(lost, 'mux', now);
    if (ended.length) pruneLastLive(this.db, listAliveRuns(this.db, this.deviceId).map((r) => r.id));
    if (ended.some((e) => e.endReason === 'exited' || e.endReason === 'lost')) this.reviveWatchUntil = now + REVIVE_WATCH_MS;
    this.revive(names, shellTabs.map((t) => t.tmuxName), now);
    return { ended, closedTabs };
  }

  /**
   * 一覧に無い run の claude が、まだ動いているか。
   * pid が生きていて、Claude の登録にそのセッションがその pid で載っているときだけ真にする。
   * pid だけで見ると、OS が pid を別のプロセスに使い回したとき、永久に閉じなくなる。登録を読む口が無ければ、pid の生存だけで決める。
   */
  private stillRunning(run: RunDto): boolean {
    if (run.pid === null || !(this.deps.pidAlive ?? isAlive)(run.pid)) return false;
    if (!this.deps.live) return true;
    const s = this.db.prepare('select provider_session_id from sessions where id = ?').get(run.sessionId) as { provider_session_id: string } | undefined;
    return !!s && this.deps.live().some((l) => l.sessionId === s.provider_session_id && l.pid === run.pid);
  }

  /**
   * 一覧にある tmux 名のうち、生きた run もシェルタブも持たないものについて、閉じた run を同じ run として開き直す。
   * 選ぶのは、この端末の run で、同じ tmux 名、exited か lost で閉じ、そのセッションに生きた run が他に無い、最も新しい行である。
   * killed と parked は hangar が止めにいったものなので、画面が残っていても生き返らせない。
   * 閉じたときに MCP の設定と秘密は消している。秘密は作り直せないので、生き返った claude からは hangar の MCP を使えない（受け入れる）。
   * 画面には起動と同じ知らせ（runStarted）を出し、ターミナルと入力欄を戻す。
   */
  private revive(names: Set<string>, tabNames: string[], now: number): RunDto[] {
    const taken = new Set([...listAliveRuns(this.db, this.deviceId).map((r) => r.tmuxName), ...tabNames]);
    const candidates = [...names].filter((n) => !taken.has(n));
    if (candidates.length === 0) return [];
    const rows = this.db.prepare(`select r.* from runs r join sessions s on s.id = r.session_id and s.deleted_at is null
      where r.deleted_at is null and r.device_id = ? and r.ended_at is not null and r.end_reason in ('exited', 'lost')
        and r.tmux_name in (${candidates.map(() => '?').join(',')})
      order by r.started_at desc`).all(this.deviceId, ...candidates) as Record<string, unknown>[];
    const seen = new Set<string>();
    const out: RunDto[] = [];
    let forgot = false;
    for (const row of rows) {
      const name = row.tmux_name as string;
      if (seen.has(name)) continue;
      seen.add(name);
      if (aliveRunForSession(this.db, row.session_id as string, this.deps.deviceId, this.now())) continue;
      upsertShared(this.db, 'runs', { ...row, ended_at: null, end_reason: null, heartbeat_at: now }, this.deviceId);
      if (forgetInterruption(this.db, row.id as string)) forgot = true;
      const run = getRun(this.db, row.id as string)!;
      out.push(run);
      this.emit('runStarted', { run, sessionId: run.sessionId, tabs: listTabs(this.db, run.id) });
    }
    if (forgot) this.emit('interrupted', interruptedGroup(this.db));
    if (out.length) console.log(`[runs] tmux セッションが残っていた run を ${out.length} 件生き返らせました`);
    return out;
  }

  /** 中断の束を記録し、新しい群を知らせる。 */
  private interrupted(runs: RunDto[], cause: InterruptCause, at: number): void {
    recordInterruption(this.db, runs, cause, at);
    this.emit('interrupted', interruptedGroup(this.db));
  }

  /**
   * Claude の登録から、生きた run ごとの最後の状態を覚える（中断の群の並びと行の文に使う）。
   * linkRegistry が登録の変化のたびに呼ぶ。最初の読み取りは onChange を通らないので、起動の組み立ても一度呼ぶ。
   */
  noteLastLive(live: LiveSessionDto[]): void {
    const byUuid = new Map(live.map((l) => [l.sessionId, l]));
    const now = this.now();
    for (const run of listAliveRuns(this.db, this.deviceId)) {
      const s = this.db.prepare('select provider_session_id from sessions where id = ?').get(run.sessionId) as { provider_session_id: string } | undefined;
      const l = s ? byUuid.get(s.provider_session_id) : undefined;
      if (l) noteLastLive(this.db, run.id, l.status, now);
    }
  }

  /**
   * サーバ起動時に、生きているはずの run のうち tmux セッションが無いものを lost で閉じる。
   * tmux の設定が無いときは、そのセッションにはもう繋げないので閉じてよい。
   * tmux を呼べなかったときは観測できていないので、何も閉じない。
   */
  recoverAtStartup(): RunDto[] {
    const listed = this.deps.panes ? this.deps.panes.list() : [];
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
    // lost で閉じた run は、ホームの帯の「前回実行中」の群になる。無ければ前の群を残す。
    if (out.length) {
      this.interrupted(out, 'restart', this.now());
      this.reviveWatchUntil = this.now() + REVIVE_WATCH_MS;
    }
    // 前のサーバが閉じたが、tmux の画面は残っている run を生き返らせる（tick の revive と同じ）。
    this.revive(names, this.openShellTabs().map((t) => t.tmuxName), this.now());
    pruneLastLive(this.db, listAliveRuns(this.db, this.deviceId).map((r) => r.id));
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
    // 登録が変わった（claude が終わった、動き出した）。終わった claude の画面が閉じるのを、しばらく短い周期で見る。
    this.stir();
    this.noteLastLive(live);
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
    if (!run) throw new RunError(404, msg('run.error.notFound'));
    if (run.endedAt !== null) throw new RunError(409, msg('run.error.alreadyEnded'));
    for (const t of listTabs(this.db, runId)) if (t.kind === 'shell') this.closeTab(t.id);
    this.stopBackground(run.sessionId);
    this.deps.panes?.close(run.tmuxName);
    return this.end(runId, 'killed') ?? run;
  }

  /**
   * 区切り（Done・Archived）を付けたセッションの Claude を止める。止めるものがあれば true を返す。
   * kill と違い、シェルのタブは残す。利用者がそこで動かしているサーバなどを、印を付けただけで落とさないためである。
   * この端末の生きた run は、tmux から消えたのを確かめてから parked で終わらせる。hangar の run が無いバックグラウンドのセッションは、本体だけを止める。
   * 外のターミナルや VS Code で動く claude には触らない（run もバックグラウンドの id も無いので、ここでは何も起きない）。
   */
  park(sessionId: string): boolean {
    const run = listAliveRuns(this.db, this.deviceId).filter((r) => r.sessionId === sessionId).at(-1) ?? null;
    const background = this.stopBackground(sessionId);
    const panes = this.deps.panes;
    // tmux が無ければ run には触らない。止められていないのに run を閉じると、動いている claude を hangar が見失う。
    if (!run || !panes) return background;
    panes.close(run.tmuxName);
    this.parking.add(run.id);
    // 落とせたことを一覧で確かめてから閉じる。確かめられなければ、次の見回り（tick）に任せる。
    // すぐ閉じるのは、claude が登録から消えてから見回りが来るまでの間、画面に「起動しています」と出さないためである。
    const listed = panes.list();
    if (listed !== null && !listed.includes(run.tmuxName)) this.end(run.id, 'parked');
    return true;
  }

  /**
   * バックグラウンドのサービスが持つセッションなら、その本体も止める。止めにいったら true を返す。
   * attach の run の tmux を落としても画面の口が閉じるだけで、claude は動き続けるからである。
   * 止め終わるのは待たない。失敗しても run は閉じ、ログにだけ残す。
   */
  private stopBackground(sessionId: string): boolean {
    const s = this.db.prepare('select provider_session_id, cwd from sessions where id = ?').get(sessionId) as { provider_session_id: string; cwd: string } | undefined;
    const jobId = s ? this.liveOf(s.provider_session_id)?.background?.jobId : undefined;
    if (!s || !jobId || !this.deps.claudeBin) return false;
    const cwd = isDirectory(s.cwd) ? s.cwd : this.deps.home;
    this.procs().runClaude(this.deps.claudeBin, ['stop', jobId], cwd).catch((e) => console.error('[runs] バックグラウンドのセッションを止められませんでした', this.safeError(e)));
    return true;
  }

  /**
   * 終了検知の周期起動。tick の失敗でサーバが落ちないよう、必ず捕まえる。
   * stir の後 RUN_STIR_MS の間は intervalMs ごとに、それ以外は idleMs ごとに見る（2026-10-14、0.6.1）。
   * tmux の一覧の読み取りは子プロセスを 1 つ起こすので、待機中（何も出入りしない間）は間を空ける。
   * claude が終わると登録が変わり（linkRegistry）、そこで stir するので、claude の終わりは今までどおり数秒で拾う。
   * idleMs が拾うのは、見ていないシェルタブで exit したことと、tmux のサーバごと落ちたことである。
   */
  startPolling(intervalMs = 2000, idleMs = intervalMs): void {
    if (this.pacer) return;
    this.pacer = new Pacer({
      run: () => this.tick(),
      fastMs: intervalMs,
      slowMs: idleMs,
      fast: () => this.now() - this.stirredAt < RUN_STIR_MS,
      onError: (e) => console.error('[runs]', e instanceof Error ? e.message : e),
    });
    this.pacer.start();
  }

  /** 画面が閉じそうなことが起きた（run の出入り、登録の変化、端末の中継の終わり）。しばらく短い周期で見る。 */
  stir(): void {
    this.stirredAt = this.now();
    this.pacer?.kick();
  }

  stop(): void {
    this.pacer?.stop();
    this.pacer = null;
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
    const tab: TabDto = { id: row.id as string, runId: row.run_id as string, sessionId: run.session_id, kind: 'shell', title: (row.title as string | null) ?? this.tr('run.tab.shell'), tmuxName: row.tmux_name as string, createdAt: row.created_at as number, closedAt: now };
    this.emit('tabChanged', tab);
    return tab;
  }

  /**
   * 同じ cwd で利用者のログインシェルを起こした独立の tmux セッションをタブとして足す。
   * opts.then はシェルより先に起こすコマンドで、ターミナルの中で動くエディタ（任意のコマンドの「シェルタブで開く」）に使う。title はそのタブの名前。
   */
  openTab(runId: string, opts: { then?: string[]; title?: string } = {}): TabDto {
    const run = getRun(this.db, runId);
    if (!run) throw new RunError(404, msg('run.error.notFound'));
    const s = this.session(run.sessionId);
    const panes = this.precheck(s.cwd);
    // 番号は閉じた行も数えて振る。閉じたタブの番号は再利用しない。
    const n = (this.db.prepare('select count(*) c from run_tabs where run_id = ?').get(runId) as { c: number }).c + 1;
    const tmuxName = `${run.tmuxName}-t${n}`;
    // タブも tmux サーバの全体の環境を継ぐ。別のセッションの印を持ったシェルで claude を打たせない。
    const command = shellTabCommand({ shell: this.deps.shell, unset: RUN_DROPPED_ENV, then: opts.then });
    try {
      panes.open({ name: tmuxName, cwd: s.cwd, command, env: withUtf8Locale() });
    } catch (e) {
      throw new RunError(400, msg('run.tab.shellFailed', { reason: this.safeError(e) }));
    }
    const id = newId();
    upsertShared(this.db, 'run_tabs', { id, run_id: runId, tmux_name: tmuxName, title: opts.title ?? this.tr('run.tab.shellTitle', { n }), created_at: this.now(), closed_at: null }, this.deviceId);
    const tab = getTab(this.db, id)!;
    this.emit('tabChanged', tab);
    return tab;
  }

  /** シェルタブを閉じる。Claude のタブは run の停止でしか閉じられない。 */
  closeTab(tabId: string): TabDto {
    const t = getTab(this.db, tabId);
    if (!t) throw new RunError(404, msg('run.tab.notFound'));
    if (t.kind === 'agent') throw new RunError(400, msg('run.tab.agentNotClosable'));
    this.deps.panes?.close(t.tmuxName);
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
    if (!run) throw new RunError(404, msg('run.error.notFound'));
    if (run.endedAt !== null) throw new RunError(409, msg('run.error.alreadyEnded'));
    const panes = this.panes();
    return {
      capture: () => panes.capture(run.tmuxName),
      // ctrl+o だけはキーの名前で送り、ほかは 1 文字として送る。{ や q をキーの名前として読ませない。
      send: (key) => (key === 'C-o' ? panes.sendKey(run.tmuxName, 'ctrl+o') : panes.sendText(run.tmuxName, key)),
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
    // 画面の目印が続けて見つからなかったら、Claude Code との互換のずれとして記録する（provider/claude-code/compat/screen.ts）。
    // 1 回の見落としは描き直しの遅れなどでも起きるので、門を通して数える。跳び方そのものは変えない。
    return this.queuePane(runId, async () => {
      const missing: ScreenMark[] = [];
      const result = await jumpToPrompt(io, heads, index, from, (mark) => missing.push(mark));
      for (const mark of this.screenMisses.observe(missing, result)) this.deps.compat?.note(screenDrift(mark));
      return result;
    });
  }

  /** Claude のタブが transcript を開いていれば閉じて、入力欄のある画面へ戻す。 */
  leaveTranscript(runId: string): Promise<{ left: boolean }> {
    const io = this.agentPane(runId);
    return this.queuePane(runId, async () => ({ left: await leaveTranscript(io) }));
  }
}
