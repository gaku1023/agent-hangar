# フェーズ 2 実装計画（tmux での起動、ターミナルの埋め込み、MCP、外部連携）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hangar から Claude Code のセッションを tmux 上で起動し、ブラウザに埋め込んだターミナルで操作し、セッション内のシェルタブ、MCP による自己要約、再開とフォーク、Terminal.app と iTerm2 と VS Code への受け渡しができる状態にする。

**Architecture:** フェーズ 1 のサーバに、tmux を包む薄い層、起動引数の組み立て、run の寿命を管理する `RunManager`、node-pty で `tmux attach` を中継する WebSocket、Streamable HTTP の MCP サーバ、外部アプリの起動を足す。UI は Mediator に `launch` 領域とタブと接続の遷移を足し、ターミナルの接続は React の外にある `TerminalHost` が持ち、View は `TerminalPane` にマウント先を渡すだけにする。実物の `claude` はテストで呼ばず、差し替え可能なコマンドで tmux 上の起動を確かめる。

**Tech Stack:** フェーズ 1 の構成に加えて node-pty 1（`^1.1.0`）、@xterm/xterm 6（`^6.0.0`）、@xterm/addon-fit（`^0.11.0`）、@modelcontextprotocol/sdk（`^1.30.0`）、zod 4（`^4.6.5`）。

**Spec:** `docs/design.md`

## Global Constraints

- `~/.claude/` 配下のファイルを書き換えない。フェーズ 2 で `~/.claude.json` を変えるのは `hangar mcp install` が `claude mcp add` を呼ぶときだけで、hangar 自身はファイルを書かない。テストは `HANGAR_CLAUDE_DIR` と `HANGAR_HOME` を一時ディレクトリに向けて行い、実物の `~/.claude` と `~/.agent-hangar` に触れない。
- サーバは `127.0.0.1` のポート `4177` にだけバインドする。データは `~/.agent-hangar/hangar.db`。ラッパースクリプトは `~/.agent-hangar/bin/`、run のログは `~/.agent-hangar/logs/`、`.command` ファイルは `~/.agent-hangar/cmd/` に置く。
- 共有テーブルの行は `id`（UUID v7）、`updated_at`（ミリ秒）、`deleted_at`、`origin_device` を持ち、書き込みは必ず `upsertShared` と `softDeleteShared` を通して `changes` に 1 行を追記する。
- 起動コマンドは `tmux new-session -d -s hangar-<runShort> -c <cwd> -- env HANGAR_RUN_ID=<runId> bash <wrapper> <log> claude ...` の形で、`--mcp-config` と `--add-dir` の可変長オプションを他のオプションの前に置き、初期プロンプトは必ず末尾に置く。
- hangar のセッションでは `tmux set-option -t <name> status off` でステータス行を隠す。tmux は `which tmux` で得た絶対パスを設定 `tmuxPath` に保存して spawn する。
- node-pty の `spawn-helper` の実行権限はサーバ起動時に確認して直し、spawn の失敗は捕まえて接続だけを閉じる。
- 実行中のセッションの `status` は `busy`、`idle`、`waiting` の 3 値で、`waiting` は通知トーストの対象にする。
- MCP は Streamable HTTP で、共通の `/mcp` とセッション別の `/mcp/s/<sessionId>` を持つ。`Origin` は `http://localhost:4177`、`http://127.0.0.1:4177`、`tauri://localhost` に限り、Bearer のローカルトークンを要求する。ツールの説明文に「agent-hangar」を含める。
- `hangar mcp install` は `~/.claude.json` を直接書かず `claude mcp add` を呼び、名前と URL の位置引数を先に、`--header` を最後に置く。
- 「ターミナルで開く」の既定は `.command` ファイルを `open -g -a Terminal` で開く経路で、iTerm2 は AppleScript に 10 秒のタイムアウトを付けて失敗したら Terminal.app に落とす。VS Code は `code <cwd>`。
- 再開は `claude -r <uuid>`、フォークは `claude -r <uuid> --fork-session --session-id <新 uuid>`。同じセッションに生きた run があるときは再開を無効にする。
- テストは実物の `claude` を呼ばない。起動を確かめるテストは `claudeBin` に差し替えたスクリプトを渡す。tmux に依存するテストは `describe.skipIf(!TMUX)` で、tmux が無い環境（CI の ubuntu）では飛ばす。tmux を使うテストは `-L hangar-test-<pid>` の専用ソケットで動かし、利用者の tmux サーバに触れない。
- 実物の Claude セッションを起動して確かめる作業は、サブスクリプションのレート制限を消費するため、この計画全体で 3 回までとし、cwd は `~/.agent-hangar/scratch/` 配下の使い捨てディレクトリにする。
- UI のコンポーネントは props だけで描く Passive View にし、状態を持たず、`fetch` を呼ばず、他の View を import しない。ターミナルの WebSocket と xterm.js のインスタンスは View ではなく `TerminalHost` が持つ。
- Mediator と Presenter は DOM に依存しない純関数で、vitest の `node` 環境でテストする。View のテストだけ `jsdom` 環境で行い、xterm.js は `TerminalHost` の偽物で置き換える。
- 見た目は常にライトで、ダークモードは持たない。色は `:root` のトークンで定義する。動きは 150 から 250 ミリ秒に限り、グロー、脈動、タイピング風、シマー、スケルトンは使わない。
- 日本語の文書とコメントは一文ごとに改行し、地の文でダッシュと中黒を使わない。
- コミットメッセージは英語の Conventional Commits 形式で、末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` を付ける。パッケージ管理は npm（pnpm は使わない）。
- フェーズ 2 ではスクラッチと昇格、TODO とメモ、アーティファクト、使用量、事後要約、分割表示、パレット、同期を実装しない。対応する Intent は Mediator が受けてトースト「この操作は次のフェーズで実装します」を出す。MCP の `get_usage` と `update_project` の TODO とメモの部分は「フェーズ 3 で対応」を返す。

## 前提（この計画で決めたこと）

設計文書が定めていない細部と、設計文書が「フェーズ 2 で決める」とした事項を、この計画で次のように決める。
実装後に `docs/design.md` へ反映する（Task 23）。

- **同名ツールの重複**：セッション別 URL の MCP サーバは `--mcp-config` で名前 `hangar` として渡し、`hangar mcp install` が user スコープに登録する名前も `hangar` にする。Claude Code は MCP サーバの設定を名前で引く連想配列として併合し、`--mcp-config` の設定を user スコープより優先するので、同じ名前なら対話セッションに見えるサーバは 1 つになる。この振る舞いはフェーズ 0 で確かめていないため、Task 23 の実物確認で `/mcp` の一覧に `hangar` が 1 つだけ出ることを確かめる。2 つ出た場合の代替は、セッション別のサーバ名を `hangar-session` にし、hangar が起動するセッションでは共通 URL 側のツール一覧を空にする（サーバ側で `Authorization` の後ろに付けた `X-Hangar-Run` ヘッダで判別する）ことで、その場合は設計文書を直してから実装を変える。
- **セッション別 URL の識別子**：`/mcp/s/<sessionId>` の `<sessionId>` は hangar の `sessions.id`（UUID v7）である。起動前に `ensureSession` で行を作るので URL は起動前に確定し、ツールの `session_id` 引数もすべて hangar の ID で受ける。`search_sessions` が返す再開コマンドだけは Claude の UUID（`claude -r <providerSessionId>`）を使う。
- **タブの ID**：タブ 0（Claude）の ID は run の ID そのもので、`run_tabs` の行は作らない。シェルタブの ID は `run_tabs.id`（UUID v7）である。`TabDto` はサーバがこの 2 種類を同じ形に揃えて返す。
- **tmux セッション名**：`hangar-<runShort>` の `<runShort>` は `shortId(runId)`（ハイフンを除いた先頭 8 文字）である。シェルタブは `hangar-<runShort>-t<n>` で、`<n>` はその run の `run_tabs` の行数（閉じたものを含む）に 1 を足した値にする。閉じたタブの番号は再利用しない。
- **PTY の WebSocket**：経路は `/ws/pty?tab=<tabId>` で、`/ws` と同じ認証（Bearer、クッキー、`?token=`）を通す。メッセージはフェーズ 0 と同じ JSON 1 行で、サーバからは `{"t":"data","d":"..."}` と `{"t":"error","message":"..."}`、クライアントからは `{"t":"data","d":"..."}` と `{"t":"resize","cols":N,"rows":N}` である。
- **run の終了理由**：`end_reason` は `exited`（tmux セッションが消えた）、`killed`（UI か API で停止した）、`lost`（サーバ起動時に tmux セッションが無かった）の 3 値にする。
- **heartbeat**：生きた run の `heartbeat_at` は 30 秒ごとに更新する。終了検知は 2 秒間隔で `tmux list-sessions` を 1 回読み、生きた run とタブの名前を突き合わせる。
- **ラッパースクリプト**：`~/.agent-hangar/bin/hangar-run.sh` をサーバ起動時に書く（内容が同じなら書かない）。引数はログファイルとコマンドで、標準エラーをログにも複写し、終了コードを記録し、異常終了のときだけ Enter を待ってから閉じる。正常終了では即座に閉じ、tmux セッションの消失が run の終了になる。
- **再開とフォークでの注入**：再開とフォークの run にも `--append-system-prompt` と `--mcp-config` を渡す。指示の中身は新規起動と同じで、`set_session_summary` の呼び出しを続けさせるためである。`-n` は渡さない（本文に残った名前を Claude が引き継ぐ）。
- **フォークの新しいセッション行**：フォーク先は新しい `sessions` 行を作り、`project_id` と `cwd` を元から写す。`name` は null にし、Claude が本文の記録から引き継ぐ名前に任せる。
- **プロジェクトの作成 API**：`POST /api/projects`（`{ name, path }`）を足す。フェーズ 3 の「新規プロジェクト」ダイアログはこの API を使い、フェーズ 2 では実物確認で使い捨てのディレクトリを登録するために使う。`git init` は行わない。
- **プロジェクト画面の「VS Code で開く」と「ターミナルで開く」**：Intent に `project.openEditor` と `project.openTerminalApp` を足し、プロジェクトのパスを対象にする。フェーズ 1 の `ProjectScreen` が空の `sessionId` と `runId` で出していた仮の Intent を置き換える。
- **`session.openTerminalApp` のタブ指定**：Intent に任意の `tabId` を足す。省略時は run のタブ 0 を開く。
- **`waiting` トーストの重複抑止**：Mediator は `waiting` になっている Claude のセッション ID の集合を `state.waitingSeen` に持ち、`live.update` で新たに `waiting` に入ったものだけをトーストにする。`waiting` でなくなれば集合から外す。開いている画面が当のセッションでもトーストは出す（画面の見分けに Claude の UUID と hangar の ID の対応が要り、Mediator は持たないため）。
- **信頼確認ダイアログの案内**：生きた run があるのにレジストリにそのセッションが無い（Claude がまだ起動を終えていない）間、ターミナルの上に「Claude の起動を待っています。信頼確認のダイアログが出ていればターミナルで答えてください」を出す。レジストリに現れた時点で消す。
- **ターミナル接続の持ち方**：`TerminalHost` が `tabId` ごとに xterm.js のインスタンスと WebSocket を持ち、Mediator の効果 `terminal.connect` と `terminal.disconnect` で開閉する。画面を離れても接続とスクロール位置は保ち、run の終了とタブを閉じたときだけ切る。`TerminalPane` はマウント先の要素を `TerminalHost` に渡すだけで、xterm.js を直接 import しない。
- **起動ダイアログの既定値**：model、effort、permission mode、worktree、追加ディレクトリは空欄を既定にし、空欄の項目は起動引数に含めない（利用者の Claude Code 設定に従う）。スクラッチはフェーズ 3 なので、ダイアログに項目を置かず、`scratch: true` の要求はサーバが 400 を返す。
- **tmux が無いとき**：`tmuxPath` が null なら起動と再開とタブの API は 400「tmux が見つかりません」を返し、UI はトーストで知らせる。索引と閲覧は動く。
- **`.command` ファイル**：`~/.agent-hangar/cmd/attach-<tmuxName>.command` に `<tmuxPath> attach -t <name>` と `exit` を書き、`open -g -a Terminal` で開く。プロジェクトのディレクトリを開くときは `cd <path>` と `exec $SHELL -l` を書いた `open-<projectShort>.command` にする。
- **iTerm2 の許可案内**：Settings で `terminalApp` を `iterm` に変えたとき、UI は「初回に macOS の自動化の許可ダイアログが出ます」を 1 度だけトーストで出す。Tauri の Info.plist はフェーズ 5 で扱う。

## ファイル構成

フェーズ 1 のファイルに次を足す。`Modify` はフェーズ 1 の計画で作られたファイルである。

```
packages/shared/src/
  api.ts                          Modify：RunDto、TabDto、LaunchResultDto、SettingsDto と BootstrapDto の拡張
  events.ts                       Modify：run.started、run.upsert、run.ended、tab.upsert
  intent.ts                       Modify：project.openEditor、project.openTerminalApp、session.openTerminalApp の tabId
packages/server/src/
  config/paths.ts                 Modify：Settings に tmuxPath、terminalApp、codePath
  config/tools.ts                 which()、resolveToolPaths()
  tmux/tmux.ts                    Tmux（new-session、has-session、list-sessions、kill-session、set-option、attach 引数）
  provider/types.ts               Modify：LaunchInput、launchCommand と resumeCommand の型
  provider/claude-code/index.ts   Modify：launchCommand と resumeCommand の実装
  launch/args.ts                  buildClaudeArgs()、mcpConfigJson()
  launch/injection.ts             renderInjection()
  launch/wrapper.ts               ensureWrapperScript()、runLogPath()
  runs/queries.ts                 toRunDto()、getRun()、listAliveRuns()、aliveRunForSession()、listTabs()、getTab()
  runs/manager.ts                 RunManager、RunError
  pty/helper.ts                   fixSpawnHelpers()、ensureSpawnHelper()
  pty/relay.ts                    PtyRelay
  mcp/tools.ts                    ツール関数群と ToolDeps
  mcp/app.ts                      buildMcpServer()、createMcpApp()
  external/open.ts                writeAttachCommand()、writeCdCommand()、openInTerminalApp()、openDirInTerminalApp()、openInEditor()
  http/app.ts                     Modify：runs と外部連携と MCP の経路
  server.ts                       Modify：結線
packages/server/test/
  tmux.ts                         tmuxAvailable()、testSocketName()
  fake-claude.ts                  writeFakeClaude()
packages/cli/src/
  mcp.ts                          mcpAddArgs()、mcpRemoveArgs()、runMcpInstall()、runMcpUninstall()
  index.ts                        Modify：hangar mcp install | uninstall
packages/ui/src/
  mediator/types.ts               Modify：launch、waitingSeen、selectedTab、transcriptOpen、効果
  mediator/launch.ts              launchStep()
  mediator/live.ts                liveStep()
  mediator/screen.ts              Modify：session 画面で terminal.connect
  mediator/sessionView.ts         Modify：tab.*、transcript.toggle、run と tab のイベント
  mediator/transition.ts          Modify：領域の合成
  store/store.ts                  Modify：runs、tabs、applyLaunch()、aliveRunOf()、tabsOf()
  runtime/api.ts                  Modify：launch、resume、fork、killRun、openTab、closeTab、openTerminalApp、openEditor、createProject
  runtime/terminals.ts            createTerminalHost()
  runtime/xterm.ts                createXterm()（本物の xterm.js）
  runtime/runtime.ts              Modify：新しい効果と launch.done
  presenters/session.ts           Modify：run、tabs、trustHint、canResume
  presenters/newSession.ts        presentNewSession()
  presenters/settings.ts          Modify：tmuxPath、terminalApp、codePath
  views/NewSessionDialog.tsx
  views/TabStrip.tsx
  views/TerminalPane.tsx          TerminalHostContext
  views/SessionScreen.tsx         Modify：実行中の配置
  views/SettingsScreen.tsx        Modify：ツールのパスとターミナルアプリ
  views/ProjectScreen.tsx         Modify：project.openEditor と project.openTerminalApp
  views/Header.tsx                Modify：新規セッションボタン
  Root.tsx、main.tsx              Modify：TerminalHost の供給、newSession オーバーレイ、⌘N
```

## インターフェース一覧

後のタスクが依存する名前と型を先にまとめる。
各タスクの Interfaces はこの一覧の抜粋である。

```ts
// packages/shared/src/api.ts（追加）
export type RunKind = 'start' | 'resume' | 'fork';
export type EndReason = 'exited' | 'killed' | 'lost';
export type TerminalApp = 'terminal' | 'iterm';
export type RunDto = { id: string; sessionId: string; deviceId: string; kind: RunKind; tmuxName: string; pid: number | null; startedAt: number; endedAt: number | null; endReason: EndReason | null; heartbeatAt: number };
export type TabDto = { id: string; runId: string; sessionId: string; kind: 'agent' | 'shell'; title: string; tmuxName: string; createdAt: number; closedAt: number | null };
export type LaunchResultDto = { run: RunDto; sessionId: string; tabs: TabDto[] };
export type SettingsDto = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null };
export type BootstrapDto = { device: { id: string; name: string }; settings: SettingsDto; projects: ProjectDto[]; sessions: SessionDto[]; live: LiveSessionDto[]; runs: RunDto[]; tabs: TabDto[]; index: IndexProgressDto; version: string };

// packages/shared/src/events.ts（追加）
  | { type: 'run.started'; run: RunDto; tabs: TabDto[] }
  | { type: 'run.upsert'; run: RunDto }
  | { type: 'run.ended'; run: RunDto }
  | { type: 'tab.upsert'; tab: TabDto }

// packages/shared/src/intent.ts（変更と追加）
  | { type: 'session.openTerminalApp'; runId: RunId; tabId?: TabId }
  | { type: 'project.openEditor'; id: ProjectId } | { type: 'project.openTerminalApp'; id: ProjectId }

// packages/server/src/config/paths.ts
export type Settings = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null };

// packages/server/src/config/tools.ts
export function which(cmd: string, env?: NodeJS.ProcessEnv): string | null;
export function resolveToolPaths(s: Settings, whichFn?: (cmd: string) => string | null): Settings;

// packages/server/src/tmux/tmux.ts
export class Tmux {
  constructor(opts: { tmuxPath: string; socketName?: string });
  readonly tmuxPath: string;
  args(...a: string[]): string[];
  run(...a: string[]): { code: number; stdout: string; stderr: string };
  newSession(opts: { name: string; cwd: string; command: string[]; width?: number; height?: number }): void;
  hasSession(name: string): boolean;
  listSessions(): string[];
  killSession(name: string): void;
  setOption(name: string, key: string, value: string): void;
  sendKeys(name: string, ...keys: string[]): void;
  attachArgs(name: string): string[];
  killServer(): void;
}

// packages/server/src/provider/types.ts
export type LaunchMode = { kind: 'start'; sessionUuid: string } | { kind: 'resume'; sessionUuid: string } | { kind: 'fork'; sessionUuid: string; newSessionUuid: string };
export type LaunchInput = { mode: LaunchMode; name?: string; prompt?: string; systemPrompt: string; mcpUrl: string; token: string; model?: string; effort?: string; permissionMode?: string; worktree?: string; addDirs?: string[] };
export interface Provider { ...; launchCommand(input: LaunchInput): string[]; resumeCommand(input: Omit<LaunchInput, 'mode'>, session: { providerSessionId: string }, fork: boolean, newSessionUuid?: string): string[]; }

// packages/server/src/launch/args.ts
export function mcpConfigJson(url: string, token: string): string;
export function buildClaudeArgs(input: LaunchInput): string[];   // 'claude' を含まない引数列

// packages/server/src/launch/injection.ts
export type InjectionInput = { projectName: string; projectPath: string; memo: string | null; todos: string[] };
export function renderInjection(i: InjectionInput): string;

// packages/server/src/launch/wrapper.ts
export function wrapperScript(): string;
export function ensureWrapperScript(home: string): string;   // <home>/bin/hangar-run.sh のパス
export function runLogPath(home: string, runId: string): string;

// packages/server/src/runs/queries.ts
export function toRunDto(r: RunRow): RunDto;
export function getRun(db: Db, id: string): RunDto | null;
export function listAliveRuns(db: Db, deviceId: string): RunDto[];
export function listActiveRuns(db: Db, deviceId: string): RunDto[];   // 生きた run と、終了したが開いたシェルタブが残る run
export function aliveRunForSession(db: Db, sessionId: string): RunDto | null;
export function listTabs(db: Db, runId: string): TabDto[];        // 先頭が agent タブ（id = runId）
export function getTab(db: Db, tabId: string): TabDto | null;     // 閉じたタブは null

// packages/server/src/runs/manager.ts
export class RunError extends Error { constructor(public status: 400 | 404 | 409, message: string); }
export type LaunchResult = LaunchResultDto;
export type RunListener = { runStarted?(r: LaunchResult): void; runUpdated?(run: RunDto): void; runEnded?(run: RunDto): void; tabChanged?(tab: TabDto): void };
export type RunManagerDeps = { db: Db; deviceId: string; home: string; tmux: Tmux | null; claudeBin: string; port: number; token: string; shell?: string; isLive?: (providerSessionId: string) => boolean; now?: () => number };
export class RunManager {
  constructor(deps: RunManagerDeps);
  on(l: RunListener): () => void;
  start(params: LaunchParams): LaunchResult;
  resume(sessionId: string): LaunchResult;
  fork(sessionId: string): LaunchResult;
  kill(runId: string): RunDto;
  openTab(runId: string): TabDto;
  closeTab(tabId: string): TabDto;
  tick(): { ended: RunDto[]; closedTabs: TabDto[] };
  recoverAtStartup(): RunDto[];
  linkRegistry(live: LiveSessionDto[]): void;
  listAlive(): { runs: RunDto[]; tabs: TabDto[] };
  getRun(id: string): RunDto | null;
  getTab(id: string): TabDto | null;
  startPolling(intervalMs?: number): void;
  stop(): void;
}

// packages/server/src/pty/relay.ts
export type PtySpawn = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyProcess;
export type PtyProcess = { pid: number; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void; write(d: string): void; resize(cols: number, rows: number): void; kill(): void };
export class PtyRelay {
  constructor(deps: { token: string; tmux: Tmux | null; resolveTab: (tabId: string) => string | null; spawn: PtySpawn });
  attach(server: http.Server, path: string): void;
  clientCount(): number;
  close(): void;
}

// packages/server/src/mcp/tools.ts
export type ToolDeps = { db: Db; deviceId: string; port: number; live: () => LiveSessionDto[]; runs: { start(params: LaunchParams): LaunchResult }; hub: { broadcast(ev: ServerEvent): void } };
export type ToolContext = { sessionId: string | null };
export const TOOL_NAMES: readonly string[];
export function callTool(deps: ToolDeps, ctx: ToolContext, name: string, args: Record<string, unknown>): unknown;

// packages/server/src/mcp/app.ts
export function buildMcpServer(deps: ToolDeps, ctx: ToolContext): McpServer;
export function createMcpApp(deps: ToolDeps & { token: string }): Hono;    // '/' と '/s/:sessionId'

// packages/server/src/external/open.ts
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
export function writeAttachCommand(home: string, tmuxPath: string, tmuxName: string): string;
export function writeCdCommand(home: string, dir: string): string;
export function openInTerminalApp(o: { home: string; tmuxPath: string; tmuxName: string; app: TerminalApp; exec?: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }>;
export function openDirInTerminalApp(o: { home: string; dir: string; app: TerminalApp; exec?: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }>;
export function openInEditor(o: { codePath: string | null; target: string; exec?: Exec }): Promise<void>;

// packages/server/src/http/app.ts（AppDeps の追加）
export type RunsApi = Pick<RunManager, 'start' | 'resume' | 'fork' | 'kill' | 'openTab' | 'closeTab' | 'listAlive' | 'getRun' | 'getTab'>;
export type ExternalApi = { openTerminal(o: { tmuxName: string }): Promise<{ app: TerminalApp; fellBack: boolean }>; openDirTerminal(o: { dir: string }): Promise<{ app: TerminalApp; fellBack: boolean }>; openEditor(o: { target: string }): Promise<void> };
export type AppDeps = { ...フェーズ 1 の項目...; runs: RunsApi; external: ExternalApi };

// packages/cli/src/mcp.ts
export function mcpAddArgs(o: { port: number; token: string }): string[];
export function mcpRemoveArgs(): string[];
export function runMcpInstall(o: { home: string; port: number; exec?: CliExec }): { ok: boolean; message: string };
export function runMcpUninstall(o: { exec?: CliExec }): { ok: boolean; message: string };

// packages/ui/src/mediator/types.ts（追加）
export type RuntimeEvent = ... | { type: 'launch.done'; sessionId: string; runId: string } | { type: 'launch.failed'; message: string };
export type Effect = ...
  | { kind: 'api.launch'; params: LaunchParams } | { kind: 'api.resume'; sessionId: string } | { kind: 'api.fork'; sessionId: string }
  | { kind: 'api.killRun'; runId: string } | { kind: 'api.openTab'; sessionId: string } | { kind: 'api.closeTab'; tabId: string }
  | { kind: 'api.openTerminalApp'; runId: string; tabId: string | null } | { kind: 'api.openEditor'; sessionId: string }
  | { kind: 'api.projectOpenEditor'; projectId: string } | { kind: 'api.projectOpenTerminal'; projectId: string }
  | { kind: 'terminal.connect'; sessionId: string; tabId: string | null } | { kind: 'terminal.disconnect'; tabId: string }
  | { kind: 'focus'; target: 'search' | 'newSessionName' | 'terminal' };
export type Overlay = ... | { kind: 'newSession'; projectId: string | null };
export type LaunchState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'failed'; message: string };
export type SessionViewState = { agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; summaryOpen: boolean; selectedTab: string | null; transcriptOpen: boolean };
export type State = { ...; launch: LaunchState; waitingSeen: string[] };

// packages/ui/src/store/store.ts（追加）
export type Store = { ...; runs: Record<string, RunDto>; tabs: Record<string, TabDto> };
export function applyLaunch(store: Store, r: LaunchResultDto): Store;
export function aliveRunOf(store: Store, sessionId: string): RunDto | null;
export function currentRunOf(store: Store, sessionId: string): RunDto | null;   // 生きた run、無ければ開いたシェルタブが残る最新の run
export function tabsOf(store: Store, runId: string): TabDto[];    // agent タブを先頭に、開いているものだけ

// packages/ui/src/runtime/terminals.ts
export type TerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';
export type TerminalLike = { cols: number; rows: number; element: HTMLElement | null; open(el: HTMLElement): void; write(d: string): void; onData(cb: (d: string) => void): { dispose(): void }; onResize(cb: (s: { cols: number; rows: number }) => void): { dispose(): void }; fit(): void; focus(): void; dispose(): void };
export type TerminalHost = { connect(tabId: string): void; disconnect(tabId: string): void; mount(tabId: string, el: HTMLElement): void; status(tabId: string): TerminalStatus | null; fit(tabId: string): void; focus(tabId: string): void; subscribe(cb: () => void): () => void; dispose(): void };
export function createTerminalHost(deps: { wsUrl: (tabId: string) => string; createTerminal: () => TerminalLike; wsFactory?: (url: string) => WebSocket }): TerminalHost;

// packages/ui/src/runtime/runtime.ts（RuntimeDeps の追加）
export type RuntimeDeps = { ...; terminals: TerminalHost };

// packages/ui/src/presenters/session.ts（追加）
export type TabItemProps = { id: string; title: string; kind: 'agent' | 'shell'; selected: boolean; closable: boolean };
export type SessionProps = { ...; run: { id: string; kind: RunKind; alive: boolean; started: string } | null; tabs: TabItemProps[]; selectedTab: string | null; transcriptOpen: boolean; trustHint: boolean; canResume: boolean; canFork: boolean };

// packages/ui/src/presenters/newSession.ts
export type NewSessionProps = { projects: { id: string; name: string; path: string | null }[]; projectId: string | null; submitting: boolean; error: string | null };
export function presentNewSession(state: State, store: Store): NewSessionProps | null;   // overlay が newSession でなければ null
```

---

### Task 1: shared の DTO、イベント、Intent の拡張

**Files:**
- Modify: `packages/shared/src/api.ts`、`packages/shared/src/events.ts`、`packages/shared/src/intent.ts`
- Test: `packages/shared/src/api.test.ts`

**Interfaces:**
- Produces: 「インターフェース一覧」の `RunKind`、`EndReason`、`TerminalApp`、`RunDto`、`TabDto`、`LaunchResultDto`、拡張した `SettingsDto` と `BootstrapDto`、`ServerEvent` の 4 種、`Intent` の 3 箇所。
- `SettingsDto` は `Settings`（`intent.ts` の別名）としても使われるので、`settings.update` の `patch` に `tmuxPath` などが自然に乗る。

- [ ] **Step 1: 失敗するテストを書く**

型だけの変更なので、テストは「型が期待の形で使えること」を `satisfies` で確かめる。

`packages/shared/src/api.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { BootstrapDto, LaunchResultDto, RunDto, ServerEvent, SettingsDto, TabDto } from './index.ts';

describe('フェーズ 2 の DTO', () => {
  it('RunDto と TabDto と LaunchResultDto が組み立てられる', () => {
    const run: RunDto = { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 };
    const tab: TabDto = { id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null };
    const r: LaunchResultDto = { run, sessionId: 's1', tabs: [tab] };
    expect(r.tabs[0]!.kind).toBe('agent');
    const ev: ServerEvent = { type: 'run.started', run, tabs: [tab] };
    expect(ev.type).toBe('run.started');
    const ended: ServerEvent = { type: 'run.ended', run: { ...run, endedAt: 2, endReason: 'exited' } };
    expect(ended.type).toBe('run.ended');
  });
  it('SettingsDto と BootstrapDto に新しい項目がある', () => {
    const s: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal', codePath: null };
    const b: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: s, projects: [], sessions: [], live: [], runs: [], tabs: [], index: { phase: 'idle', done: 0, total: 0 }, version: '0' };
    expect(b.runs).toEqual([]);
    expect(b.settings.terminalApp).toBe('terminal');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/shared/src/api && npm run typecheck`
Expected: FAIL（型エラー。`runs` と `tmuxPath` が無い）

- [ ] **Step 3: 型を足す**

`packages/shared/src/api.ts` の `SettingsDto` と `BootstrapDto` を置き換え、末尾に追加する。

```ts
export type RunKind = 'start' | 'resume' | 'fork';
export type EndReason = 'exited' | 'killed' | 'lost';
export type TerminalApp = 'terminal' | 'iterm';
/** 1 回の起動または再開。tmux 上の寿命と一致する。 */
export type RunDto = { id: string; sessionId: string; deviceId: string; kind: RunKind; tmuxName: string; pid: number | null; startedAt: number; endedAt: number | null; endReason: EndReason | null; heartbeatAt: number };
/** セッション画面のタブ。agent タブの id は run の id と同じ。 */
export type TabDto = { id: string; runId: string; sessionId: string; kind: 'agent' | 'shell'; title: string; tmuxName: string; createdAt: number; closedAt: number | null };
export type LaunchResultDto = { run: RunDto; sessionId: string; tabs: TabDto[] };
export type SettingsDto = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null };
export type BootstrapDto = { device: { id: string; name: string }; settings: SettingsDto; projects: ProjectDto[]; sessions: SessionDto[]; live: LiveSessionDto[]; runs: RunDto[]; tabs: TabDto[]; index: IndexProgressDto; version: string };
```

`packages/shared/src/events.ts` の `ServerEvent` に 4 種を足す。

```ts
import type { IndexProgressDto, LiveSessionDto, ProjectDto, RunDto, SessionDto, TabDto } from './api.ts';

export type ServerEvent =
  | { type: 'ready'; version: string }
  | { type: 'project.upsert'; project: ProjectDto }
  | { type: 'project.unresolved'; projectId: string }
  | { type: 'session.upsert'; session: SessionDto }
  | { type: 'live.update'; live: LiveSessionDto[] }
  | { type: 'transcript.appended'; sessionId: string; count: number }
  | { type: 'index.progress'; progress: IndexProgressDto }
  | { type: 'run.started'; run: RunDto; tabs: TabDto[] }
  | { type: 'run.upsert'; run: RunDto }
  | { type: 'run.ended'; run: RunDto }
  | { type: 'tab.upsert'; tab: TabDto }
  | { type: 'toast'; level: 'info' | 'error'; message: string };
```

`packages/shared/src/intent.ts` の 2 行を置き換え、1 行を足す。

```ts
  | { type: 'session.openTerminalApp'; runId: RunId; tabId?: TabId } | { type: 'session.openEditor'; sessionId: SessionId }
  | { type: 'project.openEditor'; id: ProjectId } | { type: 'project.openTerminalApp'; id: ProjectId }
```

`project.openEditor` と `project.openTerminalApp` は `project.resolve` の行の直後に置く。

- [ ] **Step 4: フェーズ 1 のテストを直す**

`SettingsDto` に項目が増えたので、フェーズ 1 のテストで `settings` を組み立てている箇所を直す。
対象は `packages/server/src/http/app.test.ts`（`let settings = { workspaceRoot: ws, claudeDir: dir }`）、`packages/ui/src/runtime/runtime.test.ts` と `packages/ui/src/store/store.test.ts` と `packages/ui/src/Root.test.tsx`（`boot` の `settings`）で、いずれも次の値に置き換える。

```ts
{ workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null }
```

`app.test.ts` では `{ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal' as const, codePath: null }` にする。
`BootstrapDto` に `runs` と `tabs` が増えたので、同じ `boot` に `runs: [], tabs: []` を足す。
`packages/ui/src/presenters/presenters.test.ts` の `storeWith()` はストアの初期値を使うので変更しない。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/shared && npm run typecheck`
Expected: shared は PASS。`typecheck` は server と ui で `runs` と `tabs` が `BootstrapDto` に無いという型エラーが残る（Task 14 と Task 16 で埋める）。この時点では server と ui の `typecheck` の失敗が `bootstrap` の組み立て箇所だけであることを確認する。

- [ ] **Step 6: コミット**

```bash
git add packages/shared packages/server/src/http/app.test.ts packages/ui/src/runtime/runtime.test.ts packages/ui/src/store/store.test.ts packages/ui/src/Root.test.tsx
git commit -m "feat(shared): run and tab dtos, run events, settings fields for phase 2"
```

---

### Task 2: 設定の拡張とツールのパス解決

**Files:**
- Modify: `packages/server/src/config/paths.ts`
- Create: `packages/server/src/config/tools.ts`
- Test: `packages/server/src/config/paths.test.ts`（追加）、`packages/server/src/config/tools.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Settings = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null };
  export function which(cmd: string, env?: NodeJS.ProcessEnv): string | null;        // PATH と既知の場所を順に探す
  export function resolveToolPaths(s: Settings, whichFn?: (cmd: string) => string | null): Settings;   // null の tmuxPath と codePath だけ埋める
  ```
- `which` は子プロセスを起こさず、`PATH` の各ディレクトリと `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin` の順に `fs.accessSync(p, X_OK)` で探す。GUI から起動されたときの貧弱な `PATH` でも Homebrew の tmux を見つけるためである。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/config/paths.test.ts` の `describe('paths')` に 1 件足す。

```ts
  it('古い settings.json に無い項目は既定値で埋める', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c' }));
    const s = loadSettings(tmp);
    expect(s).toEqual({ workspaceRoot: '/old', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null });
  });
```

`packages/server/src/config/tools.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveToolPaths, which } from './tools.ts';

describe('which', () => {
  it('PATH の順に探し、実行できるものを返す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-which-'));
    fs.writeFileSync(path.join(dir, 'mytool'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'noexec'), '', { mode: 0o644 });
    expect(which('mytool', { PATH: dir })).toBe(path.join(dir, 'mytool'));
    expect(which('noexec', { PATH: dir })).toBeNull();
    expect(which('definitely-not-a-command-xyz', { PATH: dir })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('PATH に無くても既知の場所を見る', () => {
    expect(['/bin/sh', '/usr/bin/sh']).toContain(which('sh', { PATH: '' }));   // macOS は /bin/sh、Ubuntu は /usr/bin/sh
  });
});

describe('resolveToolPaths', () => {
  it('null の項目だけを埋める', () => {
    const s = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, codePath: '/keep/code' };
    const r = resolveToolPaths(s, (c) => (c === 'tmux' ? '/opt/homebrew/bin/tmux' : '/found/' + c));
    expect(r.tmuxPath).toBe('/opt/homebrew/bin/tmux');
    expect(r.codePath).toBe('/keep/code');
  });
  it('見つからなければ null のまま', () => {
    const s = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, codePath: null };
    expect(resolveToolPaths(s, () => null)).toEqual(s);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/config`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/config/paths.ts` の `Settings` と `defaultSettings` を置き換える。

```ts
import type { TerminalApp } from '@agent-hangar/shared';

export type Settings = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null };

function defaultSettings(): Settings {
  return { workspaceRoot: path.join(os.homedir(), 'workspace'), claudeDir: defaultClaudeDir(), tmuxPath: null, terminalApp: 'terminal', codePath: null };
}
```

`loadSettings` は既に `{ ...defaultSettings(), ...JSON }` なので、古いファイルの欠けた項目は既定値で埋まる。

`packages/server/src/config/tools.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from './paths.ts';

const KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

/** 子プロセスを起こさずにコマンドの絶対パスを探す。GUI 起動の貧弱な PATH でも Homebrew を見る。 */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = [...(env.PATH ?? '').split(':').filter(Boolean), ...KNOWN_DIRS];
  for (const d of dirs) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* 次へ */ }
  }
  return null;
}

/** 設定に無いツールのパスを探して埋める。既に入っている値は変えない。 */
export function resolveToolPaths(s: Settings, whichFn: (cmd: string) => string | null = which): Settings {
  return { ...s, tmuxPath: s.tmuxPath ?? whichFn('tmux'), codePath: s.codePath ?? whichFn('code') };
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/config && npx tsc -p packages/server --noEmit 2>&1 | grep -v bootstrap`
Expected: PASS（`paths` 5 件、`tools` 4 件）。型エラーは `app.ts` の `bootstrap` と `settings` の経路だけが残る（Task 14 で直す）。

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/config
git commit -m "feat(server): tmux, terminal app and code path settings with tool resolution"
```

---

### Task 3: tmux の薄い層とテスト用の補助

**Files:**
- Create: `packages/server/src/tmux/tmux.ts`、`packages/server/test/tmux.ts`、`packages/server/test/fake-claude.ts`
- Test: `packages/server/src/tmux/tmux.test.ts`

**Interfaces:**
- Consumes: `which`（Task 2）。
- Produces:
  ```ts
  // src/tmux/tmux.ts
  export class Tmux {
    constructor(opts: { tmuxPath: string; socketName?: string });
    readonly tmuxPath: string;
    args(...a: string[]): string[];                    // socketName があれば ['-L', socketName, ...a]
    run(...a: string[]): { code: number; stdout: string; stderr: string };   // 同期。失敗しても投げない
    newSession(opts: { name: string; cwd: string; command: string[]; width?: number; height?: number }): void;   // 失敗は Error
    hasSession(name: string): boolean;
    listSessions(): string[];
    killSession(name: string): void;                   // 無くても投げない
    setOption(name: string, key: string, value: string): void;
    sendKeys(name: string, ...keys: string[]): void;
    attachArgs(name: string): string[];                // node-pty に渡す引数
    killServer(): void;
  }
  // test/tmux.ts
  export const TMUX: string | null;                    // which('tmux')。テストの skipIf に使う
  export function testSocketName(): string;            // 'hangar-test-<pid>'
  export function waitFor(cond: () => boolean, timeoutMs?: number, stepMs?: number): Promise<void>;   // 条件が真になるまで待つ。超えたら Error
  // test/fake-claude.ts
  export function writeFakeClaude(dir: string, opts?: { exitCode?: number; sleepSec?: number }): { bin: string; argsFile: string };
  ```
- `writeFakeClaude` は、受け取った引数を 1 行 1 つで `argsFile` に書き、環境変数 `HANGAR_RUN_ID` を最終行に書き、`sleepSec` 秒（既定 30）待って `exitCode`（既定 0）で終わるシェルスクリプトを作る。テストは実物の `claude` の代わりにこれを `claudeBin` に渡す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/tmux/tmux.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TMUX, testSocketName, waitFor } from '../../test/tmux.ts';
import { Tmux } from './tmux.ts';

const tmux = TMUX ? new Tmux({ tmuxPath: TMUX, socketName: testSocketName() }) : null;
afterAll(() => tmux?.killServer());

describe('Tmux.args', () => {
  it('ソケット名を先頭に付ける', () => {
    expect(new Tmux({ tmuxPath: '/x/tmux', socketName: 's' }).args('ls')).toEqual(['-L', 's', 'ls']);
    expect(new Tmux({ tmuxPath: '/x/tmux' }).args('ls')).toEqual(['ls']);
    expect(new Tmux({ tmuxPath: '/x/tmux', socketName: 's' }).attachArgs('n')).toEqual(['-L', 's', 'attach', '-t', 'n']);
  });
});

describe.skipIf(!TMUX)('Tmux（実物）', () => {
  it('セッションを作り、見つけ、オプションを変え、消す', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    const name = 'hangar-test-a';
    tmux!.newSession({ name, cwd, command: ['sh', '-c', 'sleep 30'] });
    expect(tmux!.hasSession(name)).toBe(true);
    expect(tmux!.listSessions()).toContain(name);
    tmux!.setOption(name, 'status', 'off');
    expect(tmux!.run('show-options', '-t', name, 'status').stdout.trim()).toBe('status off');
    tmux!.killSession(name);
    await waitFor(() => !tmux!.hasSession(name));
    expect(tmux!.listSessions()).not.toContain(name);
    tmux!.killSession(name);   // 無くても投げない
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  it('存在しない cwd では失敗を投げる', () => {
    expect(() => tmux!.newSession({ name: 'hangar-test-b', cwd: '/nonexistent/dir', command: ['sh'] })).toThrow();
  });
  it('send-keys で入力を送れる', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    const out = path.join(cwd, 'out.txt');
    tmux!.newSession({ name: 'hangar-test-c', cwd, command: ['sh', '-c', `read -r line; echo "$line" > ${out}`] });
    tmux!.sendKeys('hangar-test-c', 'hello', 'Enter');
    await waitFor(() => fs.existsSync(out));
    expect(fs.readFileSync(out, 'utf8').trim()).toBe('hello');
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/tmux`
Expected: FAIL（`tmux.ts` と `test/tmux.ts` が無い）

- [ ] **Step 3: 実装する**

`packages/server/test/tmux.ts`：

```ts
import { which } from '../src/config/tools.ts';

/** tmux の絶対パス。無ければ null で、tmux に依存するテストは describe.skipIf(!TMUX) で飛ばす。 */
export const TMUX: string | null = which('tmux');

/** 利用者の tmux サーバに触れないための専用ソケット名。 */
export function testSocketName(): string {
  return `hangar-test-${process.pid}`;
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
```

`packages/server/test/fake-claude.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';

/** 実物の claude の代わり。受け取った引数と HANGAR_RUN_ID を記録して、待ってから終わる。 */
export function writeFakeClaude(dir: string, opts: { exitCode?: number; sleepSec?: number } = {}): { bin: string; argsFile: string } {
  const argsFile = path.join(dir, 'args.txt');
  const bin = path.join(dir, 'fake-claude');
  const script = [
    '#!/bin/sh',
    `: > "${argsFile}"`,
    `for a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done`,
    `printf 'HANGAR_RUN_ID=%s\\n' "$HANGAR_RUN_ID" >> "${argsFile}"`,
    `sleep ${opts.sleepSec ?? 30}`,
    `exit ${opts.exitCode ?? 0}`,
    '',
  ].join('\n');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, argsFile };
}
```

`packages/server/src/tmux/tmux.ts`：

```ts
import { spawnSync } from 'node:child_process';

export type TmuxResult = { code: number; stdout: string; stderr: string };

/** tmux を絶対パスで呼ぶ薄い層。socketName を付けるとテスト専用のサーバで動く。 */
export class Tmux {
  readonly tmuxPath: string;
  private readonly socketName: string | undefined;

  constructor(opts: { tmuxPath: string; socketName?: string }) {
    this.tmuxPath = opts.tmuxPath;
    this.socketName = opts.socketName;
  }

  args(...a: string[]): string[] {
    return this.socketName ? ['-L', this.socketName, ...a] : a;
  }

  run(...a: string[]): TmuxResult {
    const r = spawnSync(this.tmuxPath, this.args(...a), { encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  /** 切り離した状態でセッションを作る。command は `--` の後ろにそのまま並べる。 */
  newSession(opts: { name: string; cwd: string; command: string[]; width?: number; height?: number }): void {
    const r = this.run('new-session', '-d', '-s', opts.name, '-c', opts.cwd, '-x', String(opts.width ?? 120), '-y', String(opts.height ?? 40), '--', ...opts.command);
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  }

  hasSession(name: string): boolean {
    return this.run('has-session', '-t', `=${name}`).code === 0;
  }

  listSessions(): string[] {
    const r = this.run('list-sessions', '-F', '#{session_name}');
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  }

  killSession(name: string): void {
    this.run('kill-session', '-t', `=${name}`);
  }

  setOption(name: string, key: string, value: string): void {
    this.run('set-option', '-t', `=${name}`, key, value);
  }

  sendKeys(name: string, ...keys: string[]): void {
    this.run('send-keys', '-t', `=${name}`, ...keys);
  }

  attachArgs(name: string): string[] {
    return this.args('attach', '-t', name);
  }

  killServer(): void {
    this.run('kill-server');
  }
}
```

`-t =name` の `=` は前方一致ではなく完全一致でセッションを指す指定で、`hangar-abc` と `hangar-abc-t1` を取り違えないために付ける。

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/tmux`
Expected: PASS（tmux があれば 4 件、無ければ 1 件と skip 3 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/tmux packages/server/test/tmux.ts packages/server/test/fake-claude.ts
git commit -m "feat(server): tmux wrapper with isolated test socket and fake claude helper"
```

---

### Task 4: 起動引数の組み立て、指示の注入、Provider の起動コマンド

**Files:**
- Create: `packages/server/src/launch/args.ts`、`packages/server/src/launch/injection.ts`
- Modify: `packages/server/src/provider/types.ts`、`packages/server/src/provider/claude-code/index.ts`
- Test: `packages/server/src/launch/args.test.ts`、`packages/server/src/launch/injection.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // provider/types.ts
  export type LaunchMode = { kind: 'start'; sessionUuid: string } | { kind: 'resume'; sessionUuid: string } | { kind: 'fork'; sessionUuid: string; newSessionUuid: string };
  export type LaunchInput = { mode: LaunchMode; name?: string; prompt?: string; systemPrompt: string; mcpUrl: string; token: string; model?: string; effort?: string; permissionMode?: string; worktree?: string; addDirs?: string[] };
  // launch/args.ts
  export function mcpConfigJson(url: string, token: string): string;   // {"mcpServers":{"hangar":{"type":"http","url":...,"headers":{"Authorization":"Bearer ..."}}}}
  export function buildClaudeArgs(input: LaunchInput): string[];
  // launch/injection.ts
  export type InjectionInput = { projectName: string; projectPath: string; memo: string | null; todos: string[] };
  export function renderInjection(i: InjectionInput): string;
  // provider/claude-code/index.ts
  claudeCodeProvider.launchCommand(input: LaunchInput): string[];        // ['claude', ...buildClaudeArgs(input)]
  claudeCodeProvider.resumeCommand(input, session, fork, newSessionUuid): string[];
  ```
- 引数の順序：`--mcp-config <json>`、`--add-dir <dir>`（各 1 組）、次に `--session-id <uuid>` か `-r <uuid>`（フォークは `-r <uuid> --fork-session --session-id <new>`）、`-n <name>`、`--append-system-prompt <text>`、`--model`、`--effort`、`--permission-mode`、`-w`、最後に初期プロンプト。空の項目は含めない。可変長オプションの直後には必ず `--session-id` か `-r` が来るので、位置引数を飲み込まない。
- 注入の本文は設計文書のテンプレートどおりで、メモは先頭 500 字、TODO は 10 件まで、無いときは「（なし）」。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/launch/args.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, mcpConfigJson } from './args.ts';

const base = { systemPrompt: 'SYS', mcpUrl: 'http://127.0.0.1:4177/mcp/s/s1', token: 'tok' };

describe('mcpConfigJson', () => {
  it('hangar という名前の http サーバを Bearer 付きで書く', () => {
    expect(JSON.parse(mcpConfigJson('http://x/mcp/s/s1', 'tok'))).toEqual({ mcpServers: { hangar: { type: 'http', url: 'http://x/mcp/s/s1', headers: { Authorization: 'Bearer tok' } } } });
  });
});

describe('buildClaudeArgs', () => {
  it('可変長オプションを先頭に、プロンプトを末尾に置く', () => {
    const a = buildClaudeArgs({ ...base, mode: { kind: 'start', sessionUuid: 'u1' }, name: 'n', prompt: 'やって', model: 'opus', effort: 'high', permissionMode: 'default', worktree: 'wt', addDirs: ['/a', '/b'] });
    expect(a[0]).toBe('--mcp-config');
    expect(JSON.parse(a[1]!).mcpServers.hangar.url).toBe(base.mcpUrl);
    expect(a.slice(2, 6)).toEqual(['--add-dir', '/a', '--add-dir', '/b']);
    expect(a.slice(6)).toEqual(['--session-id', 'u1', '-n', 'n', '--append-system-prompt', 'SYS', '--model', 'opus', '--effort', 'high', '--permission-mode', 'default', '-w', 'wt', 'やって']);
  });
  it('空の項目は含めない', () => {
    const a = buildClaudeArgs({ ...base, mode: { kind: 'start', sessionUuid: 'u1' }, name: '', prompt: '', addDirs: [] });
    expect(a).toEqual(['--mcp-config', mcpConfigJson(base.mcpUrl, 'tok'), '--session-id', 'u1', '--append-system-prompt', 'SYS']);
  });
  it('再開とフォーク', () => {
    expect(buildClaudeArgs({ ...base, mode: { kind: 'resume', sessionUuid: 'u1' } }).slice(2)).toEqual(['-r', 'u1', '--append-system-prompt', 'SYS']);
    expect(buildClaudeArgs({ ...base, mode: { kind: 'fork', sessionUuid: 'u1', newSessionUuid: 'u2' } }).slice(2)).toEqual(['-r', 'u1', '--fork-session', '--session-id', 'u2', '--append-system-prompt', 'SYS']);
  });
});
```

`packages/server/src/launch/injection.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { renderInjection } from './injection.ts';

describe('renderInjection', () => {
  it('テンプレートの各要素を埋める', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', memo: 'メモ本文', todos: ['a', 'b'] });
    expect(t).toContain('あなたは agent-hangar から起動されたセッションです。');
    expect(t).toContain('プロジェクト：alpha（/w/alpha）');
    expect(t).toContain('プロジェクトのメモの要約：メモ本文');
    expect(t).toContain('未完の TODO：\n- a\n- b');
    expect(t).toContain('search_sessions と get_transcript');
    expect(t).toContain('set_session_summary');
  });
  it('メモは 500 字、TODO は 10 件に切り、無ければ（なし）', () => {
    const t = renderInjection({ projectName: 'p', projectPath: '/p', memo: 'あ'.repeat(600), todos: Array.from({ length: 12 }, (_, i) => `t${i}`) });
    expect(t).toContain('あ'.repeat(500) + '\n');
    expect(t).not.toContain('あ'.repeat(501));
    expect(t).toContain('- t9\n');
    expect(t).not.toContain('- t10');
    const e = renderInjection({ projectName: 'p', projectPath: '/p', memo: null, todos: [] });
    expect(e).toContain('プロジェクトのメモの要約：（なし）');
    expect(e).toContain('未完の TODO：（なし）');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/launch`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/provider/types.ts` の `Provider` を置き換える（`DiscoveredFile` と `LiveSession` はそのまま）。

```ts
export type LaunchMode = { kind: 'start'; sessionUuid: string } | { kind: 'resume'; sessionUuid: string } | { kind: 'fork'; sessionUuid: string; newSessionUuid: string };
export type LaunchInput = { mode: LaunchMode; name?: string; prompt?: string; systemPrompt: string; mcpUrl: string; token: string; model?: string; effort?: string; permissionMode?: string; worktree?: string; addDirs?: string[] };

export interface Provider {
  readonly id: 'claude-code' | 'opencode';
  discover(): DiscoveredFile[];
  watch(onChange: (path: string) => void): () => void;
  readEvents(file: string, fromByte: number): { events: TranscriptEvent[]; offset: number; length: number }[];
  liveStatus(): LiveSession[];
  launchCommand(input: LaunchInput): string[];
  resumeCommand(input: Omit<LaunchInput, 'mode'>, session: { providerSessionId: string }, fork: boolean, newSessionUuid?: string): string[];
}
```

`packages/server/src/launch/args.ts`：

```ts
import type { LaunchInput } from '../provider/types.ts';

export function mcpConfigJson(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { hangar: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
}

/**
 * claude の引数列を組み立てる。
 * --mcp-config と --add-dir は可変長オプションで直後の位置引数を飲み込むので先頭に置き、
 * 初期プロンプトは必ず末尾に置く（フェーズ 0 で逆順にすると即時終了した）。
 */
export function buildClaudeArgs(input: LaunchInput): string[] {
  const a: string[] = ['--mcp-config', mcpConfigJson(input.mcpUrl, input.token)];
  for (const d of input.addDirs ?? []) if (d) a.push('--add-dir', d);
  const m = input.mode;
  if (m.kind === 'start') a.push('--session-id', m.sessionUuid);
  else if (m.kind === 'resume') a.push('-r', m.sessionUuid);
  else a.push('-r', m.sessionUuid, '--fork-session', '--session-id', m.newSessionUuid);
  if (input.name) a.push('-n', input.name);
  a.push('--append-system-prompt', input.systemPrompt);
  if (input.model) a.push('--model', input.model);
  if (input.effort) a.push('--effort', input.effort);
  if (input.permissionMode) a.push('--permission-mode', input.permissionMode);
  if (input.worktree) a.push('-w', input.worktree);
  if (input.prompt) a.push(input.prompt);
  return a;
}
```

`packages/server/src/launch/injection.ts`：

```ts
export type InjectionInput = { projectName: string; projectPath: string; memo: string | null; todos: string[] };

const NONE = '（なし）';

/** --append-system-prompt で渡す短い指示。ファイルや設定は書かず、要約の更新だけを求める。 */
export function renderInjection(i: InjectionInput): string {
  const memo = i.memo?.trim() ? [...i.memo.trim()].slice(0, 500).join('') : NONE;
  const todos = i.todos.slice(0, 10);
  const todoText = todos.length ? '\n' + todos.map((t) => `- ${t}`).join('\n') : NONE;
  return [
    'あなたは agent-hangar から起動されたセッションです。',
    `プロジェクト：${i.projectName}（${i.projectPath}）`,
    `プロジェクトのメモの要約：${memo}`,
    `未完の TODO：${todoText}`,
    '過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。',
    '依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、',
    'set_session_summary で題名、2〜3 文の要約、状態、次の一手を更新してください。',
    '',
  ].join('\n');
}
```

`packages/server/src/provider/claude-code/index.ts` の `launchCommand` と `resumeCommand` を置き換える。

```ts
import { buildClaudeArgs } from '../../launch/args.ts';
import type { LaunchInput } from '../types.ts';

  launchCommand(input: LaunchInput): string[] {
    return ['claude', ...buildClaudeArgs(input)];
  },
  resumeCommand(input: Omit<LaunchInput, 'mode'>, session: { providerSessionId: string }, fork: boolean, newSessionUuid?: string): string[] {
    const mode = fork
      ? { kind: 'fork' as const, sessionUuid: session.providerSessionId, newSessionUuid: newSessionUuid ?? '' }
      : { kind: 'resume' as const, sessionUuid: session.providerSessionId };
    return ['claude', ...buildClaudeArgs({ ...input, mode })];
  },
```

フェーズ 1 の `claudeCodeProvider` が `launchCommand` と `resumeCommand` で `not implemented` を投げていたテストがあれば、`buildClaudeArgs` の結果と一致することを確かめる形に書き換える。

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/launch packages/server/src/provider`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/launch packages/server/src/provider
git commit -m "feat(server): claude launch args with variadic options first and system prompt injection"
```

---

### Task 5: ラッパースクリプトと run のログ

**Files:**
- Create: `packages/server/src/launch/wrapper.ts`
- Test: `packages/server/src/launch/wrapper.test.ts`

**Interfaces:**
- Consumes: `Tmux`、`TMUX`、`testSocketName`、`waitFor`、`writeFakeClaude`（Task 3）。
- Produces:
  ```ts
  export function wrapperScript(): string;                    // スクリプトの中身
  export function ensureWrapperScript(home: string): string;  // <home>/bin/hangar-run.sh を 0o755 で書く。同じ内容なら書かない。パスを返す
  export function runLogPath(home: string, runId: string): string;   // <home>/logs/run-<runId>.log
  ```
- ラッパーは `bash <wrapper> <log> <command> [args...]` で呼ぶ。標準エラーを `<log>` に複写し、開始と終了コードを記録し、終了コードが 0 でなければ Enter を待ってから閉じる。正常終了では即座に閉じる。tmux はプロセスが終わるとセッションを閉じるので、hangar は「セッションが消えた」ことを run の終了として検知する。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/launch/wrapper.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakeClaude } from '../../test/fake-claude.ts';
import { TMUX, testSocketName, waitFor } from '../../test/tmux.ts';
import { Tmux } from '../tmux/tmux.ts';
import { ensureWrapperScript, runLogPath, wrapperScript } from './wrapper.ts';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-wrap-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('ensureWrapperScript', () => {
  it('bin/hangar-run.sh を実行可能で書き、同じ内容なら書き直さない', () => {
    const p = ensureWrapperScript(home);
    expect(p).toBe(path.join(home, 'bin', 'hangar-run.sh'));
    expect(fs.statSync(p).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(p, 'utf8')).toBe(wrapperScript());
    const before = fs.statSync(p).mtimeMs;
    ensureWrapperScript(home);
    expect(fs.statSync(p).mtimeMs).toBe(before);
    expect(runLogPath(home, 'r1')).toBe(path.join(home, 'logs', 'run-r1.log'));
  });
});

describe.skipIf(!TMUX)('ラッパー（tmux 上）', () => {
  const tmux = new Tmux({ tmuxPath: TMUX ?? 'tmux', socketName: testSocketName() });
  afterAll(() => tmux.killServer());

  it('正常終了ではすぐ閉じ、ログに exit=0 と引数が残る', async () => {
    const wrapper = ensureWrapperScript(home);
    const fake = writeFakeClaude(home, { sleepSec: 0, exitCode: 0 });
    const log = runLogPath(home, 'ok');
    tmux.newSession({ name: 'hangar-wrap-ok', cwd: home, command: ['env', 'HANGAR_RUN_ID=ok', 'bash', wrapper, log, fake.bin, '--session-id', 'u1', 'prompt'] });
    await waitFor(() => !tmux.hasSession('hangar-wrap-ok'));
    expect(fs.readFileSync(log, 'utf8')).toMatch(/exit=0/);
    expect(fs.readFileSync(fake.argsFile, 'utf8')).toBe('--session-id\nu1\nprompt\nHANGAR_RUN_ID=ok\n');
  });
  it('異常終了では Enter を待ってから閉じる', async () => {
    const wrapper = ensureWrapperScript(home);
    const fake = writeFakeClaude(home, { sleepSec: 0, exitCode: 3 });
    const log = runLogPath(home, 'bad');
    tmux.newSession({ name: 'hangar-wrap-bad', cwd: home, command: ['bash', wrapper, log, fake.bin] });
    await waitFor(() => fs.existsSync(log) && /exit=3/.test(fs.readFileSync(log, 'utf8')));
    expect(tmux.hasSession('hangar-wrap-bad')).toBe(true);
    tmux.sendKeys('hangar-wrap-bad', 'Enter');
    await waitFor(() => !tmux.hasSession('hangar-wrap-bad'));
  });
  it('標準エラーをログに複写する', async () => {
    const wrapper = ensureWrapperScript(home);
    const log = runLogPath(home, 'err');
    tmux.newSession({ name: 'hangar-wrap-err', cwd: home, command: ['bash', wrapper, log, 'sh', '-c', 'echo oops >&2; exit 0'] });
    await waitFor(() => !tmux.hasSession('hangar-wrap-err'));
    await waitFor(() => /oops/.test(fs.readFileSync(log, 'utf8')));
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/launch/wrapper`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/launch/wrapper.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';

export const WRAPPER_NAME = 'hangar-run.sh';

/**
 * tmux 内で claude を包むスクリプト。
 * tmux で claude を直接起動すると異常終了時の出力が失われるので、
 * 標準エラーをログに複写し、終了コードを記録し、異常終了のときは Enter を待ってから閉じる。
 */
export function wrapperScript(): string {
  return [
    '#!/usr/bin/env bash',
    '# agent-hangar: claude をラップして終了コードと標準エラーをログに残す。',
    '# 使い方: hangar-run.sh <logfile> <command> [args...]',
    'LOG="$1"; shift',
    'mkdir -p "$(dirname "$LOG")"',
    'stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }',
    'printf \'%s start pid=%s cmd=%s\\n\' "$(stamp)" "$$" "$1" >> "$LOG"',
    '"$@" 2> >(tee -a "$LOG" >&2)',
    'code=$?',
    'printf \'%s exit=%s\\n\' "$(stamp)" "$code" >> "$LOG"',
    'if [ "$code" -ne 0 ]; then',
    '  printf \'\\n[agent-hangar] 終了コード %s で終了しました。ログ: %s\\nEnter でこの画面を閉じます。\' "$code" "$LOG"',
    '  read -r _',
    'fi',
    'exit "$code"',
    '',
  ].join('\n');
}

export function ensureWrapperScript(home: string): string {
  const dir = path.join(home, 'bin');
  const file = path.join(dir, WRAPPER_NAME);
  const body = wrapperScript();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body, { mode: 0o755 });
  if ((fs.statSync(file).mode & 0o777) !== 0o755) fs.chmodSync(file, 0o755);
  return file;
}

export function runLogPath(home: string, runId: string): string {
  return path.join(home, 'logs', `run-${runId}.log`);
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/launch`
Expected: PASS（tmux があれば wrapper 4 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/launch/wrapper.ts packages/server/src/launch/wrapper.test.ts
git commit -m "feat(server): wrapper script that logs exit code and keeps the pane on failure"
```

---

### Task 6: run とタブの問い合わせ、RunManager の起動

**Files:**
- Create: `packages/server/src/runs/queries.ts`、`packages/server/src/runs/manager.ts`
- Test: `packages/server/src/runs/queries.test.ts`、`packages/server/src/runs/manager.test.ts`

**Interfaces:**
- Consumes: `upsertShared`、`ensureSession`（`indexer/indexFile.ts`）、`buildClaudeArgs`、`renderInjection`、`ensureWrapperScript`、`runLogPath`、`Tmux`、`newId`、`shortId`。
- Produces:
  ```ts
  // runs/queries.ts
  export type RunRow = { id: string; session_id: string; device_id: string; kind: RunKind; tmux_name: string; pid: number | null; launch_params: string; started_at: number; ended_at: number | null; end_reason: EndReason | null; heartbeat_at: number };
  export function toRunDto(r: RunRow): RunDto;
  export function getRun(db: Db, id: string): RunDto | null;
  export function listAliveRuns(db: Db, deviceId: string): RunDto[];        // ended_at が null、started_at 昇順
  export function listActiveRuns(db: Db, deviceId: string): RunDto[];       // 生きた run と、終了したが開いたシェルタブが残る run。UI のタブ列はこれを使う
  export function aliveRunForSession(db: Db, sessionId: string): RunDto | null;
  export function listTabs(db: Db, runId: string): TabDto[];                // agent タブ（id = runId）を先頭に、閉じていない run_tabs を created_at 順
  export function getTab(db: Db, tabId: string): TabDto | null;             // run の id なら agent タブ。閉じたタブは null
  // runs/manager.ts
  export class RunError extends Error { readonly status: 400 | 404 | 409; }
  export type LaunchResult = LaunchResultDto;
  export type RunListener = { runStarted?(r: LaunchResult): void; runUpdated?(run: RunDto): void; runEnded?(run: RunDto): void; tabChanged?(tab: TabDto): void };
  export type RunManagerDeps = { db: Db; deviceId: string; home: string; tmux: Tmux | null; claudeBin: string; port: number; token: string; shell?: string; isLive?: (providerSessionId: string) => boolean; now?: () => number };
  export class RunManager {
    constructor(deps: RunManagerDeps);
    on(l: RunListener): () => void;
    start(params: LaunchParams): LaunchResult;
    listAlive(): { runs: RunDto[]; tabs: TabDto[] };
    getRun(id: string): RunDto | null;
    getTab(id: string): TabDto | null;
  }
  ```
- `start` の流れ：`scratch` は 400。`projectId` が無ければ 400、プロジェクトが無ければ 404、この端末のパスが無いか未解決なら 400。Claude の UUID を `crypto.randomUUID()` で作り、`ensureSession` で `sessions` 行を作って `project_id`、`name`、`started_at`、`last_activity_at` を書く。run の行を先に書き、`tmux new-session` と `status off` を実行し、失敗したら run を `exited` で閉じて 400 を投げる。成功したら `runStarted` を通知する。
- 起動コマンドは `['env', 'HANGAR_RUN_ID=<runId>', 'bash', <wrapper>, <log>, <claudeBin>, ...buildClaudeArgs(input)]`。
- 注入の材料は、`projects.name`、パス、`project_memos.markdown`（無ければ null）、`todos` の未完 10 件（フェーズ 2 では常に空）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/runs/queries.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { aliveRunForSession, getRun, getTab, listActiveRuns, listAliveRuns, listTabs } from './queries.ts';

function seed() {
  const db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'd' }, 'd');
  upsertShared(db, 'runs', { id: 'r1', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-r1', pid: null, launch_params: '{}', started_at: 100, ended_at: null, end_reason: null, heartbeat_at: 100 }, 'd');
  upsertShared(db, 'runs', { id: 'r0', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-r0', pid: 5, launch_params: '{}', started_at: 50, ended_at: 60, end_reason: 'exited', heartbeat_at: 55 }, 'd');
  upsertShared(db, 'run_tabs', { id: 't1', run_id: 'r1', tmux_name: 'hangar-r1-t1', title: 'シェル 1', created_at: 101, closed_at: null }, 'd');
  upsertShared(db, 'run_tabs', { id: 't2', run_id: 'r1', tmux_name: 'hangar-r1-t2', title: 'シェル 2', created_at: 102, closed_at: 103 }, 'd');
  upsertShared(db, 'runs', { id: 'r2', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-r2', pid: null, launch_params: '{}', started_at: 70, ended_at: 80, end_reason: 'exited', heartbeat_at: 75 }, 'd');
  upsertShared(db, 'run_tabs', { id: 't3', run_id: 'r2', tmux_name: 'hangar-r2-t1', title: 'シェル 1', created_at: 71, closed_at: null }, 'd');
  return db;
}

describe('runs/queries', () => {
  it('getRun と listAliveRuns と aliveRunForSession', () => {
    const db = seed();
    expect(getRun(db, 'r1')).toEqual({ id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 100, endedAt: null, endReason: null, heartbeatAt: 100 });
    expect(getRun(db, 'nope')).toBeNull();
    expect(listAliveRuns(db, 'd').map((r) => r.id)).toEqual(['r1']);
    expect(listAliveRuns(db, 'other')).toEqual([]);
    expect(listActiveRuns(db, 'd').map((r) => r.id)).toEqual(['r2', 'r1']);   // r0 は終了してタブも無いので出ない
    expect(aliveRunForSession(db, 's1')?.id).toBe('r1');
    expect(aliveRunForSession(db, 's9')).toBeNull();
  });
  it('listTabs は agent タブを先頭に、閉じていないタブだけを返す', () => {
    const db = seed();
    expect(listTabs(db, 'r1')).toEqual([
      { id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 100, closedAt: null },
      { id: 't1', runId: 'r1', sessionId: 's1', kind: 'shell', title: 'シェル 1', tmuxName: 'hangar-r1-t1', createdAt: 101, closedAt: null },
    ]);
    expect(listTabs(db, 'nope')).toEqual([]);
  });
  it('getTab は run の id と run_tabs の id の両方を引き、閉じたタブは null', () => {
    const db = seed();
    expect(getTab(db, 'r1')?.kind).toBe('agent');
    expect(getTab(db, 't1')?.tmuxName).toBe('hangar-r1-t1');
    expect(getTab(db, 't2')).toBeNull();
    expect(getTab(db, 'nope')).toBeNull();
  });
});
```

`packages/server/src/runs/manager.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shortId } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { writeFakeClaude } from '../../test/fake-claude.ts';
import { TMUX, testSocketName, waitFor } from '../../test/tmux.ts';
import { Tmux } from '../tmux/tmux.ts';
import { RunError, RunManager } from './manager.ts';

let db: Db;
let home: string;
let cwd: string;
let fake: { bin: string; argsFile: string };
let tmux: Tmux | null;

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-cwd-'));
  fake = writeFakeClaude(home);
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'pr1', project_id: 'p1', device_id: 'd', path: cwd, resolved: 1 }, 'd');
  upsertShared(db, 'projects', { id: 'p2', name: 'lost', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'pr2', project_id: 'p2', device_id: 'd', path: '/nonexistent', resolved: 0 }, 'd');
  tmux = TMUX ? new Tmux({ tmuxPath: TMUX, socketName: testSocketName() }) : null;
});
afterEach(() => {
  tmux?.killServer();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const make = (over: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) => new RunManager({ db, deviceId: 'd', home, tmux, claudeBin: fake.bin, port: 4177, token: 'tok', shell: 'sh', ...over });
const readArgs = async () => { await waitFor(() => fs.existsSync(fake.argsFile) && fs.readFileSync(fake.argsFile, 'utf8').includes('HANGAR_RUN_ID=')); return fs.readFileSync(fake.argsFile, 'utf8').trim().split('\n'); };

describe('RunManager.start の入力検査（tmux 不要）', () => {
  it('scratch、projectId 無し、無いプロジェクト、未解決のプロジェクトを拒む', () => {
    const rm = make({ tmux: null });
    expect(() => rm.start({ scratch: true })).toThrow(RunError);
    expect(() => rm.start({})).toThrow(/projectId/);
    expect(() => rm.start({ projectId: 'nope' })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => rm.start({ projectId: 'p2' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => rm.start({ projectId: 'p1' })).toThrow(/tmux/);
  });
});

describe.skipIf(!TMUX)('RunManager.start（tmux 上）', () => {
  it('sessions 行と runs 行を作り、ラッパー経由で起動し、status off にする', async () => {
    const rm = make();
    const started: unknown[] = [];
    rm.on({ runStarted: (r) => started.push(r) });
    const r = rm.start({ projectId: 'p1', name: 'first', prompt: 'やって', model: 'opus' });
    expect(r.run).toMatchObject({ kind: 'start', sessionId: r.sessionId, deviceId: 'd', endedAt: null, endReason: null, pid: null });
    expect(r.run.tmuxName).toBe(`hangar-${shortId(r.run.id)}`);
    expect(r.tabs).toEqual([{ id: r.run.id, runId: r.run.id, sessionId: r.sessionId, kind: 'agent', title: 'Claude', tmuxName: r.run.tmuxName, createdAt: r.run.startedAt, closedAt: null }]);
    expect(started).toHaveLength(1);
    expect(tmux!.hasSession(r.run.tmuxName)).toBe(true);
    expect(tmux!.run('show-options', '-t', `=${r.run.tmuxName}`, 'status').stdout.trim()).toBe('status off');
    const args = await readArgs();
    expect(args[0]).toBe('--mcp-config');
    expect(JSON.parse(args[1]!).mcpServers.hangar.url).toBe(`http://127.0.0.1:4177/mcp/s/${r.sessionId}`);
    expect(args.at(-2)).toBe('やって');
    expect(args.at(-1)).toBe(`HANGAR_RUN_ID=${r.run.id}`);
    expect(args).toContain('--model');
    const uuid = args[args.indexOf('--session-id') + 1]!;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    const s = db.prepare('select * from sessions where id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(s).toMatchObject({ provider_session_id: uuid, project_id: 'p1', name: 'first', cwd });
    expect(typeof s.started_at).toBe('number');
    const sys = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(sys).toContain('プロジェクト：alpha（' + cwd + '）');
    expect(fs.existsSync(path.join(home, 'bin', 'hangar-run.sh'))).toBe(true);
    expect(rm.listAlive().runs.map((x) => x.id)).toEqual([r.run.id]);
    expect(rm.getTab(r.run.id)?.kind).toBe('agent');
  });
  it('ディレクトリが無ければ 400 で、run の行は残らない', () => {
    fs.rmSync(cwd, { recursive: true, force: true });
    const rm = make();
    expect(() => rm.start({ projectId: 'p1' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(rm.listAlive().runs).toEqual([]);
    fs.mkdirSync(cwd);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/runs`
Expected: FAIL

- [ ] **Step 3: 問い合わせを書く**

`packages/server/src/runs/queries.ts`：

```ts
import type { EndReason, RunDto, RunKind, TabDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

export type RunRow = { id: string; session_id: string; device_id: string; kind: RunKind; tmux_name: string; pid: number | null; launch_params: string; started_at: number; ended_at: number | null; end_reason: EndReason | null; heartbeat_at: number };
type TabRow = { id: string; run_id: string; tmux_name: string; title: string | null; created_at: number; closed_at: number | null };

export function toRunDto(r: RunRow): RunDto {
  return { id: r.id, sessionId: r.session_id, deviceId: r.device_id, kind: r.kind, tmuxName: r.tmux_name, pid: r.pid, startedAt: r.started_at, endedAt: r.ended_at, endReason: r.end_reason, heartbeatAt: r.heartbeat_at };
}

const RUN_SELECT = 'select * from runs where deleted_at is null';

export function getRun(db: Db, id: string): RunDto | null {
  const r = db.prepare(`${RUN_SELECT} and id = ?`).get(id) as RunRow | undefined;
  return r ? toRunDto(r) : null;
}

export function listAliveRuns(db: Db, deviceId: string): RunDto[] {
  return (db.prepare(`${RUN_SELECT} and ended_at is null and device_id = ? order by started_at`).all(deviceId) as RunRow[]).map(toRunDto);
}

export function aliveRunForSession(db: Db, sessionId: string): RunDto | null {
  const r = db.prepare(`${RUN_SELECT} and ended_at is null and session_id = ? order by started_at desc limit 1`).get(sessionId) as RunRow | undefined;
  return r ? toRunDto(r) : null;
}

/** 生きた run と、終了したが開いたシェルタブが残る run。シェルタブは Claude が終了しても残るので、UI のタブ列はこれを使う。 */
export function listActiveRuns(db: Db, deviceId: string): RunDto[] {
  const sql = `${RUN_SELECT} and device_id = ? and (ended_at is null or exists (select 1 from run_tabs t where t.run_id = runs.id and t.closed_at is null and t.deleted_at is null)) order by started_at`;
  return (db.prepare(sql).all(deviceId) as RunRow[]).map(toRunDto);
}

/** タブ 0 は Claude の tmux セッションそのもので、run_tabs に行を持たない。 */
function agentTab(r: RunRow): TabDto {
  return { id: r.id, runId: r.id, sessionId: r.session_id, kind: 'agent', title: 'Claude', tmuxName: r.tmux_name, createdAt: r.started_at, closedAt: null };
}

function shellTab(t: TabRow, r: RunRow): TabDto {
  return { id: t.id, runId: t.run_id, sessionId: r.session_id, kind: 'shell', title: t.title ?? 'シェル', tmuxName: t.tmux_name, createdAt: t.created_at, closedAt: t.closed_at };
}

export function listTabs(db: Db, runId: string): TabDto[] {
  const r = db.prepare(`${RUN_SELECT} and id = ?`).get(runId) as RunRow | undefined;
  if (!r) return [];
  const rows = db.prepare('select * from run_tabs where run_id = ? and closed_at is null and deleted_at is null order by created_at').all(runId) as TabRow[];
  return [agentTab(r), ...rows.map((t) => shellTab(t, r))];
}

export function getTab(db: Db, tabId: string): TabDto | null {
  const r = db.prepare(`${RUN_SELECT} and id = ?`).get(tabId) as RunRow | undefined;
  if (r) return agentTab(r);
  const t = db.prepare('select * from run_tabs where id = ? and closed_at is null and deleted_at is null').get(tabId) as TabRow | undefined;
  if (!t) return null;
  const run = db.prepare(`${RUN_SELECT} and id = ?`).get(t.run_id) as RunRow | undefined;
  return run ? shellTab(t, run) : null;
}
```

- [ ] **Step 4: RunManager を書く**

`packages/server/src/runs/manager.ts`：

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import { newId, shortId, type LaunchParams, type LaunchResultDto, type LiveSessionDto, type RunDto, type RunKind, type TabDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { buildClaudeArgs } from '../launch/args.ts';
import { renderInjection } from '../launch/injection.ts';
import { ensureWrapperScript, runLogPath } from '../launch/wrapper.ts';
import type { LaunchInput } from '../provider/types.ts';
import type { Tmux } from '../tmux/tmux.ts';
import { aliveRunForSession, getRun, getTab, listActiveRuns, listAliveRuns, listTabs } from './queries.ts';

export class RunError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); this.name = 'RunError'; }
}

export type LaunchResult = LaunchResultDto;
export type RunListener = { runStarted?(r: LaunchResult): void; runUpdated?(run: RunDto): void; runEnded?(run: RunDto): void; tabChanged?(tab: TabDto): void };
export type RunManagerDeps = { db: Db; deviceId: string; home: string; tmux: Tmux | null; claudeBin: string; port: number; token: string; shell?: string; isLive?: (providerSessionId: string) => boolean; now?: () => number };

type ProjectInfo = { id: string; name: string; path: string | null; resolved: boolean };
type SessionRow = { id: string; provider_session_id: string; project_id: string | null; cwd: string; name: string | null };

const HEARTBEAT_MS = 30_000;

/** run の寿命を管理する。起動、終了検知、heartbeat、レジストリとの結びつけ、シェルタブ。 */
export class RunManager {
  private listeners = new Set<RunListener>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RunManagerDeps) {}

  on(l: RunListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit<K extends keyof RunListener>(k: K, arg: Parameters<NonNullable<RunListener[K]>>[0]): void {
    for (const l of this.listeners) (l[k] as ((a: typeof arg) => void) | undefined)?.(arg);
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private get db(): Db { return this.deps.db; }

  private tmux(): Tmux {
    if (!this.deps.tmux) throw new RunError(400, 'tmux が見つかりません。Settings で tmuxPath を設定してください');
    return this.deps.tmux;
  }

  private project(projectId: string): ProjectInfo {
    const r = this.db.prepare('select p.id, p.name, r.path, r.resolved from projects p left join project_roots r on r.project_id = p.id and r.device_id = ? and r.deleted_at is null where p.id = ? and p.deleted_at is null').get(this.deps.deviceId, projectId) as { id: string; name: string; path: string | null; resolved: number | null } | undefined;
    if (!r) throw new RunError(404, 'プロジェクトが見つかりません');
    return { id: r.id, name: r.name, path: r.path, resolved: r.resolved === 1 };
  }

  private session(sessionId: string): SessionRow {
    const r = this.db.prepare('select id, provider_session_id, project_id, cwd, name from sessions where id = ? and deleted_at is null').get(sessionId) as SessionRow | undefined;
    if (!r) throw new RunError(404, 'セッションが見つかりません');
    return r;
  }

  private mcpUrl(sessionId: string): string { return `http://127.0.0.1:${this.deps.port}/mcp/s/${sessionId}`; }

  /** 注入する指示。プロジェクトが無ければ「未分類」として cwd だけを書く。 */
  private injectionFor(projectId: string | null, cwd: string): string {
    const p = projectId ? this.project(projectId) : null;
    const memo = projectId ? ((this.db.prepare('select markdown from project_memos where project_id = ? and deleted_at is null').get(projectId) as { markdown: string } | undefined)?.markdown ?? null) : null;
    const todos = projectId ? (this.db.prepare('select text from todos where project_id = ? and done = 0 and deleted_at is null order by position limit 10').all(projectId) as { text: string }[]).map((t) => t.text) : [];
    return renderInjection({ projectName: p?.name ?? '未分類', projectPath: cwd, memo, todos });
  }

  private baseInput(sessionId: string, projectId: string | null, cwd: string, params: LaunchParams): Omit<LaunchInput, 'mode'> {
    const s = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
    return { systemPrompt: this.injectionFor(projectId, cwd), mcpUrl: this.mcpUrl(sessionId), token: this.deps.token, name: s(params.name), prompt: s(params.prompt), model: s(params.model), effort: s(params.effort), permissionMode: s(params.permissionMode), worktree: s(params.worktree), addDirs: (params.addDirs ?? []).map((d) => d.trim()).filter(Boolean) };
  }

  private launch(o: { sessionId: string; cwd: string; kind: RunKind; input: LaunchInput; params: LaunchParams }): LaunchResult {
    const tmux = this.tmux();
    if (!fs.existsSync(o.cwd)) throw new RunError(400, `ディレクトリが見つかりません: ${o.cwd}`);
    const runId = newId();
    const tmuxName = `hangar-${shortId(runId)}`;
    const wrapper = ensureWrapperScript(this.deps.home);
    const log = runLogPath(this.deps.home, runId);
    const command = ['env', `HANGAR_RUN_ID=${runId}`, 'bash', wrapper, log, this.deps.claudeBin, ...buildClaudeArgs(o.input)];
    const now = this.now();
    upsertShared(this.db, 'runs', { id: runId, session_id: o.sessionId, device_id: this.deps.deviceId, kind: o.kind, tmux_name: tmuxName, pid: null, launch_params: JSON.stringify(o.params), started_at: now, ended_at: null, end_reason: null, heartbeat_at: now }, this.deps.deviceId);
    try {
      tmux.newSession({ name: tmuxName, cwd: o.cwd, command });
      tmux.setOption(tmuxName, 'status', 'off');
    } catch (e) {
      this.end(runId, 'exited');
      throw new RunError(400, `tmux の起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    const result: LaunchResult = { run: getRun(this.db, runId)!, sessionId: o.sessionId, tabs: listTabs(this.db, runId) };
    this.emit('runStarted', result);
    return result;
  }

  private end(runId: string, reason: 'exited' | 'killed' | 'lost'): RunDto | null {
    const row = this.db.prepare('select * from runs where id = ? and deleted_at is null').get(runId) as Record<string, unknown> | undefined;
    if (!row || row.ended_at !== null) return null;
    upsertShared(this.db, 'runs', { ...row, ended_at: this.now(), end_reason: reason }, this.deps.deviceId);
    const run = getRun(this.db, runId)!;
    this.emit('runEnded', run);
    return run;
  }

  start(params: LaunchParams): LaunchResult {
    if (params.scratch) throw new RunError(400, 'スクラッチはフェーズ 3 で実装します');
    if (!params.projectId) throw new RunError(400, 'projectId は必須です');
    const p = this.project(params.projectId);
    if (!p.path || !p.resolved) throw new RunError(400, 'プロジェクトのディレクトリがこの端末で見つかりません');
    const sessionUuid = crypto.randomUUID();
    const sessionId = ensureSession(this.db, sessionUuid, p.path, this.deps.deviceId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, project_id: p.id, name: params.name?.trim() || null, started_at: now, last_activity_at: now }, this.deps.deviceId);
    const input: LaunchInput = { ...this.baseInput(sessionId, p.id, p.path, params), mode: { kind: 'start', sessionUuid } };
    return this.launch({ sessionId, cwd: p.path, kind: 'start', input, params });
  }

  /** 生きた run と、開いたシェルタブが残る run。UI の bootstrap と GET /api/runs が使う。 */
  listAlive(): { runs: RunDto[]; tabs: TabDto[] } {
    const runs = listActiveRuns(this.db, this.deps.deviceId);
    return { runs, tabs: runs.flatMap((r) => listTabs(this.db, r.id)) };
  }
  getRun(id: string): RunDto | null { return getRun(this.db, id); }
  getTab(id: string): TabDto | null { return getTab(this.db, id); }
}
```

`resume`、`fork`、`kill`、`openTab`、`closeTab`、`tick`、`recoverAtStartup`、`linkRegistry`、`startPolling`、`stop` は Task 7 から Task 9 で足す。
`session()` と `aliveRunForSession` と `LiveSessionDto` はそこで使うので、この時点では未使用の import があってもよい（`tsc` は未使用 import を誤りにしない設定）。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/runs`
Expected: PASS（tmux があれば queries 3 件と manager 3 件）

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/runs
git commit -m "feat(server): run and tab queries, run manager that launches claude in tmux"
```

---

### Task 7: run の寿命（終了検知、heartbeat、停止、レジストリの結びつけ、起動時の回復）

**Files:**
- Modify: `packages/server/src/runs/manager.ts`
- Test: `packages/server/src/runs/manager.test.ts`（追加）

**Interfaces:**
- Produces（`RunManager` に追加）：
  ```ts
  tick(): { ended: RunDto[]; closedTabs: TabDto[] };   // tmux list-sessions を 1 回読み、消えた run を exited で閉じ、30 秒以上前の heartbeat を更新する
  kill(runId: string): RunDto;                         // tmux を殺して killed で閉じる。タブも閉じる（Task 9）。無ければ 404、閉じていれば 409
  recoverAtStartup(): RunDto[];                        // 生きているはずの run で tmux セッションが無いものを lost で閉じる
  linkRegistry(live: LiveSessionDto[]): void;          // Claude の UUID で run を引き、pid を書く
  startPolling(intervalMs?: number): void;             // 既定 2000
  stop(): void;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/runs/manager.test.ts` に次の `describe` を 2 つ足す。

```ts
describe('RunManager の回復と結びつけ（tmux 不要）', () => {
  it('recoverAtStartup は tmux の無い run を lost で閉じる', () => {
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd, home_device: 'd' }, 'd');
    upsertShared(db, 'runs', { id: 'r1', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-nope', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'd');
    const rm = make({ tmux: null });
    const ended: string[] = [];
    rm.on({ runEnded: (r) => ended.push(r.endReason ?? '') });
    expect(rm.recoverAtStartup().map((r) => r.id)).toEqual(['r1']);
    expect(ended).toEqual(['lost']);
    expect(rm.getRun('r1')).toMatchObject({ endReason: 'lost' });
    expect(rm.recoverAtStartup()).toEqual([]);
  });
  it('linkRegistry は Claude の UUID で run を引いて pid を書く', () => {
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd, home_device: 'd' }, 'd');
    upsertShared(db, 'runs', { id: 'r1', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-x', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'd');
    const rm = make({ tmux: null });
    const updated: number[] = [];
    rm.on({ runUpdated: (r) => updated.push(r.pid ?? -1) });
    const live = (pid: number) => [{ sessionId: 'u1', status: 'busy' as const, name: null, nameSource: null, cwd, pid }];
    rm.linkRegistry(live(4242));
    expect(rm.getRun('r1')?.pid).toBe(4242);
    rm.linkRegistry(live(4242));
    expect(updated).toEqual([4242]);
    rm.linkRegistry([]);
    expect(rm.getRun('r1')?.pid).toBe(4242);
  });
  it('kill は無い run に 404、閉じた run に 409', () => {
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd, home_device: 'd' }, 'd');
    upsertShared(db, 'runs', { id: 'r0', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-x', pid: null, launch_params: '{}', started_at: 1, ended_at: 2, end_reason: 'exited', heartbeat_at: 1 }, 'd');
    const rm = make({ tmux: null });
    expect(() => rm.kill('nope')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => rm.kill('r0')).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe.skipIf(!TMUX)('RunManager の寿命（tmux 上）', () => {
  it('tick は tmux セッションが消えた run を exited で閉じる', async () => {
    fake = writeFakeClaude(home, { sleepSec: 0 });
    const rm = make();
    const ended: string[] = [];
    rm.on({ runEnded: (r) => ended.push(r.id) });
    const r = rm.start({ projectId: 'p1' });
    await waitFor(() => !tmux!.hasSession(r.run.tmuxName));
    expect(rm.tick().ended.map((x) => x.id)).toEqual([r.run.id]);
    expect(ended).toEqual([r.run.id]);
    expect(rm.getRun(r.run.id)).toMatchObject({ endReason: 'exited' });
    expect(rm.tick().ended).toEqual([]);
  });
  it('tick は 30 秒ごとに heartbeat を更新する', () => {
    let t = 1_000_000;
    const rm = make({ now: () => t });
    const r = rm.start({ projectId: 'p1' });
    t += 10_000;
    expect(rm.tick().ended).toEqual([]);
    expect(rm.getRun(r.run.id)?.heartbeatAt).toBe(1_000_000);
    t += 21_000;
    rm.tick();
    expect(rm.getRun(r.run.id)?.heartbeatAt).toBe(1_031_000);
  });
  it('kill は tmux を殺して killed で閉じる', async () => {
    const rm = make();
    const r = rm.start({ projectId: 'p1' });
    const k = rm.kill(r.run.id);
    expect(k).toMatchObject({ id: r.run.id, endReason: 'killed' });
    await waitFor(() => !tmux!.hasSession(r.run.tmuxName));
    expect(rm.listAlive().runs).toEqual([]);
  });
  it('recoverAtStartup は tmux が生きている run を残す', () => {
    const rm = make();
    const r = rm.start({ projectId: 'p1' });
    const rm2 = make();
    expect(rm2.recoverAtStartup()).toEqual([]);
    expect(rm2.getRun(r.run.id)?.endedAt).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/runs/manager`
Expected: FAIL（`tick` などが無い）

- [ ] **Step 3: 実装する**

`packages/server/src/runs/manager.ts` の `RunManager` に次のメソッドを足す（`listAlive` の前に置く）。

```ts
  /** tmux の一覧を 1 回読み、消えた run とタブを閉じ、古い heartbeat を更新する。 */
  tick(): { ended: RunDto[]; closedTabs: TabDto[] } {
    const names = new Set(this.deps.tmux ? this.deps.tmux.listSessions() : []);
    const ended: RunDto[] = [];
    const closedTabs: TabDto[] = [];
    const now = this.now();
    for (const run of listAliveRuns(this.db, this.deps.deviceId)) {
      if (!names.has(run.tmuxName)) { const e = this.end(run.id, 'exited'); if (e) ended.push(e); continue; }
      if (now - run.heartbeatAt >= HEARTBEAT_MS) {
        const row = this.db.prepare('select * from runs where id = ?').get(run.id) as Record<string, unknown>;
        upsertShared(this.db, 'runs', { ...row, heartbeat_at: now }, this.deps.deviceId);
        this.emit('runUpdated', getRun(this.db, run.id)!);
      }
    }
    for (const t of this.openShellTabs()) {
      if (!names.has(t.tmuxName)) { const c = this.closeTabRow(t.id); if (c) closedTabs.push(c); }
    }
    return { ended, closedTabs };
  }

  /** サーバ起動時に、生きているはずの run のうち tmux セッションが無いものを lost で閉じる。 */
  recoverAtStartup(): RunDto[] {
    const names = new Set(this.deps.tmux ? this.deps.tmux.listSessions() : []);
    const out: RunDto[] = [];
    for (const run of listAliveRuns(this.db, this.deviceId)) {
      if (!names.has(run.tmuxName)) { const e = this.end(run.id, 'lost'); if (e) out.push(e); }
    }
    for (const t of this.openShellTabs()) if (!names.has(t.tmuxName)) this.closeTabRow(t.id);
    return out;
  }

  private get deviceId(): string { return this.deps.deviceId; }

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

  kill(runId: string): RunDto {
    const run = getRun(this.db, runId);
    if (!run) throw new RunError(404, 'run が見つかりません');
    if (run.endedAt !== null) throw new RunError(409, 'この run は終了しています');
    for (const t of listTabs(this.db, runId)) if (t.kind === 'shell') this.closeTab(t.id);
    this.deps.tmux?.killSession(run.tmuxName);
    return this.end(runId, 'killed') ?? run;
  }

  startPolling(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.error('[runs]', e instanceof Error ? e.message : e); } }, intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** 開いているシェルタブ。Claude が終了した run のタブも含める。 */
  private openShellTabs(): TabDto[] {
    return listActiveRuns(this.db, this.deviceId).flatMap((r) => listTabs(this.db, r.id)).filter((t) => t.kind === 'shell');
  }

  /** run_tabs の行を閉じる。tmux は触らない。 */
  private closeTabRow(tabId: string): TabDto | null {
    const row = this.db.prepare('select * from run_tabs where id = ? and deleted_at is null').get(tabId) as Record<string, unknown> | undefined;
    if (!row || row.closed_at !== null) return null;
    upsertShared(this.db, 'run_tabs', { ...row, closed_at: this.now() }, this.deviceId);
    const run = this.db.prepare('select session_id from runs where id = ?').get(row.run_id) as { session_id: string };
    const tab: TabDto = { id: row.id as string, runId: row.run_id as string, sessionId: run.session_id, kind: 'shell', title: (row.title as string | null) ?? 'シェル', tmuxName: row.tmux_name as string, createdAt: row.created_at as number, closedAt: this.now() };
    this.emit('tabChanged', tab);
    return tab;
  }

  closeTab(tabId: string): TabDto {
    const t = getTab(this.db, tabId);
    if (!t) throw new RunError(404, 'タブが見つかりません');
    if (t.kind === 'agent') throw new RunError(400, 'Claude のタブは閉じられません。停止を使ってください');
    this.deps.tmux?.killSession(t.tmuxName);
    return this.closeTabRow(tabId) ?? t;
  }
```

`openTab` は Task 9 で足す。`kill` が `closeTab` を呼ぶので、`closeTab` はここで書く。

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/runs && npx tsc -p packages/server --noEmit 2>&1 | grep -v 'bootstrap\|app.ts'`
Expected: PASS（tmux があれば manager 10 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/runs
git commit -m "feat(server): run lifecycle with tmux presence poll, heartbeat, kill and registry linking"
```

---

### Task 8: 再開とフォーク

**Files:**
- Modify: `packages/server/src/runs/manager.ts`
- Test: `packages/server/src/runs/manager.test.ts`（追加）

**Interfaces:**
- Produces（`RunManager` に追加）：
  ```ts
  resume(sessionId: string): LaunchResult;   // claude -r <uuid>。生きた run かレジストリの実行中があれば 409、本文が無ければ 400、cwd が無ければ 400
  fork(sessionId: string): LaunchResult;     // claude -r <uuid> --fork-session --session-id <new>。新しい sessions 行を作り、その行に kind = 'fork' の run を付ける
  ```
- 両方とも `--append-system-prompt` と `--mcp-config` を渡す。`-n` と初期プロンプトは渡さない。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/runs/manager.test.ts` に次を足す。

```ts
function seedOldSession(withTranscript = true): string {
  const id = ensureSession(db, 'u-old', cwd, 'd');
  const cur = db.prepare('select * from sessions where id = ?').get(id) as Record<string, unknown>;
  upsertShared(db, 'sessions', { ...cur, project_id: 'p1', name: 'old' }, 'd');
  if (withTranscript) db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?)').run('/x/u-old.jsonl', id, null, 10, 1, 10, 1);
  return id;
}

describe('resume と fork の入力検査（tmux 不要）', () => {
  it('無いセッション、本文なし、実行中は拒む', () => {
    const rm = make({ tmux: null, isLive: (u) => u === 'u-old' });
    expect(() => rm.resume('nope')).toThrow(expect.objectContaining({ status: 404 }));
    const noBody = seedOldSession(false);
    expect(() => rm.resume(noBody)).toThrow(expect.objectContaining({ status: 400 }));
    db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?)').run('/x/u-old.jsonl', noBody, null, 10, 1, 10, 1);
    expect(() => rm.resume(noBody)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => rm.fork(noBody)).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe.skipIf(!TMUX)('resume と fork（tmux 上）', () => {
  it('resume は同じセッションに kind = resume の run を作り、-r で起動する', async () => {
    const id = seedOldSession();
    const rm = make();
    const r = rm.resume(id);
    expect(r.sessionId).toBe(id);
    expect(r.run.kind).toBe('resume');
    const args = await readArgs();
    expect(args.slice(0, 1)).toEqual(['--mcp-config']);
    expect(args.indexOf('-r')).toBe(2);
    expect(args[3]).toBe('u-old');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('-n');
    expect(args.at(-2)).toBe(args[args.indexOf('--append-system-prompt') + 1]);
    expect(() => rm.resume(id)).toThrow(expect.objectContaining({ status: 409 }));
  });
  it('fork は新しいセッション行と kind = fork の run を作る', async () => {
    const id = seedOldSession();
    const rm = make();
    const f = rm.fork(id);
    expect(f.sessionId).not.toBe(id);
    expect(f.run).toMatchObject({ kind: 'fork', sessionId: f.sessionId });
    const args = await readArgs();
    const i = args.indexOf('--fork-session');
    expect(args.slice(i - 2, i + 3)).toEqual(['-r', 'u-old', '--fork-session', '--session-id', args[i + 2]]);
    const s = db.prepare('select * from sessions where id = ?').get(f.sessionId) as Record<string, unknown>;
    expect(s).toMatchObject({ provider_session_id: args[i + 2], project_id: 'p1', cwd, name: null });
    expect(JSON.parse(args[1]!).mcpServers.hangar.url).toBe(`http://127.0.0.1:4177/mcp/s/${f.sessionId}`);
  });
  it('cwd が無ければ 400', () => {
    const id = seedOldSession();
    db.prepare('update sessions set cwd = ? where id = ?').run('/nonexistent/cwd', id);
    expect(() => make().resume(id)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
```

テストの先頭の import に `import { ensureSession } from '../indexer/indexFile.ts';` を足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/runs/manager`
Expected: FAIL（`resume` が無い）

- [ ] **Step 3: 実装する**

`packages/server/src/runs/manager.ts` の `RunManager` に足す（`start` の直後）。

```ts
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
    const input: LaunchInput = { ...this.baseInput(s.id, s.project_id, s.cwd, {}), mode: { kind: 'resume', sessionUuid: s.provider_session_id } };
    return this.launch({ sessionId: s.id, cwd: s.cwd, kind: 'resume', input, params: { projectId: s.project_id ?? undefined } });
  }

  /** 新しい sessions 行を作り、claude -r <uuid> --fork-session --session-id <new> で起動する。 */
  fork(sessionId: string): LaunchResult {
    const s = this.session(sessionId);
    this.assertResumable(s);
    const newUuid = crypto.randomUUID();
    const newId_ = ensureSession(this.db, newUuid, s.cwd, this.deviceId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(newId_) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, project_id: s.project_id, name: null, started_at: now, last_activity_at: now }, this.deviceId);
    const input: LaunchInput = { ...this.baseInput(newId_, s.project_id, s.cwd, {}), mode: { kind: 'fork', sessionUuid: s.provider_session_id, newSessionUuid: newUuid } };
    return this.launch({ sessionId: newId_, cwd: s.cwd, kind: 'fork', input, params: { projectId: s.project_id ?? undefined } });
  }
```

`assertResumable` の三つの検査は、本文の有無、hangar の run、hangar の外で動いている Claude の順で、どれも別の原因である。

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/runs`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/runs
git commit -m "feat(server): resume and fork runs on top of claude -r"
```

---

### Task 9: シェルタブ

**Files:**
- Modify: `packages/server/src/runs/manager.ts`
- Test: `packages/server/src/runs/manager.test.ts`（追加）

**Interfaces:**
- Produces（`RunManager` に追加）：
  ```ts
  openTab(runId: string): TabDto;   // hangar-<runShort>-t<n> で利用者のログインシェルを同じ cwd に起こす。run が無ければ 404
  ```
- `<n>` は `run_tabs` のその run の行数（閉じたものを含む）に 1 を足した値。シェルは `deps.shell ?? process.env.SHELL ?? '/bin/zsh'` を `-l` 付きで起動し、`status off` にする。`closeTab` と `kill` は Task 7 で書いた。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/runs/manager.test.ts` に足す。

```ts
describe.skipIf(!TMUX)('シェルタブ（tmux 上）', () => {
  it('openTab は連番の tmux セッションを作り、closeTab は閉じ、番号は再利用しない', async () => {
    const rm = make();
    const tabs: TabDto[] = [];
    rm.on({ tabChanged: (t) => tabs.push(t) });
    const r = rm.start({ projectId: 'p1' });
    const t1 = rm.openTab(r.run.id);
    expect(t1).toMatchObject({ runId: r.run.id, sessionId: r.sessionId, kind: 'shell', title: 'シェル 1', tmuxName: `${r.run.tmuxName}-t1`, closedAt: null });
    expect(tmux!.hasSession(t1.tmuxName)).toBe(true);
    expect(tmux!.run('show-options', '-t', `=${t1.tmuxName}`, 'status').stdout.trim()).toBe('status off');
    const t2 = rm.openTab(r.run.id);
    expect(t2.tmuxName).toBe(`${r.run.tmuxName}-t2`);
    expect(rm.listAlive().tabs.map((t) => t.id)).toEqual([r.run.id, t1.id, t2.id]);
    const closed = rm.closeTab(t1.id);
    expect(closed.closedAt).not.toBeNull();
    await waitFor(() => !tmux!.hasSession(t1.tmuxName));
    expect(rm.getTab(t1.id)).toBeNull();
    expect(rm.openTab(r.run.id).tmuxName).toBe(`${r.run.tmuxName}-t3`);
    expect(tabs.map((t) => [t.title, t.closedAt === null])).toEqual([['シェル 1', true], ['シェル 2', true], ['シェル 1', false], ['シェル 3', true]]);
  });
  it('tick は利用者が exit したタブを閉じ、kill はタブごと片付ける', async () => {
    const rm = make();
    const r = rm.start({ projectId: 'p1' });
    const t1 = rm.openTab(r.run.id);
    tmux!.killSession(t1.tmuxName);
    await waitFor(() => !tmux!.hasSession(t1.tmuxName));
    expect(rm.tick().closedTabs.map((t) => t.id)).toEqual([t1.id]);
    const t2 = rm.openTab(r.run.id);
    rm.kill(r.run.id);
    await waitFor(() => !tmux!.hasSession(t2.tmuxName) && !tmux!.hasSession(r.run.tmuxName));
    expect(rm.getTab(t2.id)).toBeNull();
    expect(rm.listAlive()).toEqual({ runs: [], tabs: [] });
  });
  it('無い run には 404、Claude のタブは閉じられない', () => {
    const rm = make();
    expect(() => rm.openTab('nope')).toThrow(expect.objectContaining({ status: 404 }));
    const r = rm.start({ projectId: 'p1' });
    expect(() => rm.closeTab(r.run.id)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
```

テストの先頭の import に `import type { TabDto } from '@agent-hangar/shared';` を足す（`shortId` と同じ行にまとめてよい）。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/runs/manager`
Expected: FAIL（`openTab` が無い）

- [ ] **Step 3: 実装する**

`packages/server/src/runs/manager.ts` の `RunManager` に足す（`closeTab` の前）。

```ts
  /** 同じ cwd で利用者のログインシェルを起こした独立の tmux セッションをタブとして足す。 */
  openTab(runId: string): TabDto {
    const run = getRun(this.db, runId);
    if (!run) throw new RunError(404, 'run が見つかりません');
    const tmux = this.tmux();
    const s = this.session(run.sessionId);
    if (!fs.existsSync(s.cwd)) throw new RunError(400, `ディレクトリが見つかりません: ${s.cwd}`);
    const n = (this.db.prepare('select count(*) c from run_tabs where run_id = ?').get(runId) as { c: number }).c + 1;
    const tmuxName = `${run.tmuxName}-t${n}`;
    const shell = this.deps.shell ?? process.env.SHELL ?? '/bin/zsh';
    try {
      tmux.newSession({ name: tmuxName, cwd: s.cwd, command: [shell, '-l'] });
      tmux.setOption(tmuxName, 'status', 'off');
    } catch (e) {
      throw new RunError(400, `シェルの起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    const id = newId();
    upsertShared(this.db, 'run_tabs', { id, run_id: runId, tmux_name: tmuxName, title: `シェル ${n}`, created_at: this.now(), closed_at: null }, this.deviceId);
    const tab = getTab(this.db, id)!;
    this.emit('tabChanged', tab);
    return tab;
  }
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/runs`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/runs
git commit -m "feat(server): shell tabs as separate tmux sessions in the run's cwd"
```

---

### Task 10: node-pty による tmux attach の中継

**Files:**
- Create: `packages/server/src/pty/helper.ts`、`packages/server/src/pty/nodePty.ts`、`packages/server/src/pty/relay.ts`
- Modify: `packages/server/package.json`（`node-pty` を足す）
- Test: `packages/server/src/pty/helper.test.ts`、`packages/server/src/pty/relay.test.ts`

**Interfaces:**
- Consumes: `originAllowed`、`tokenFromRequest`（`http/auth.ts`）、`Tmux`。
- Produces:
  ```ts
  // pty/helper.ts
  export function fixSpawnHelpers(packageDir: string): string[];   // prebuilds/*/spawn-helper と build/Release/spawn-helper に実行権限を付け、直したパスを返す
  export function ensureSpawnHelper(): string[];                  // node-pty のパッケージディレクトリを解決して fixSpawnHelpers
  // pty/nodePty.ts
  export const nodePtySpawn: PtySpawn;                            // 本物の node-pty
  // pty/relay.ts
  export type PtyProcess = { pid: number; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void; write(d: string): void; resize(cols: number, rows: number): void; kill(): void };
  export type PtySpawn = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyProcess;
  export class PtyRelay {
    constructor(deps: { token: string; tmux: Tmux | null; resolveTab: (tabId: string) => string | null; spawn: PtySpawn });
    attach(server: http.Server, path: string): void;   // '/ws/pty'
    clientCount(): number;
    close(): void;
  }
  ```
- プロトコル：サーバから `{"t":"data","d":"..."}` と `{"t":"error","message":"..."}`、クライアントから `{"t":"data","d":"..."}` と `{"t":"resize","cols":N,"rows":N}`。
- 認証は `/ws` と同じ。`tab` が引けなければ 404 で切る。spawn の失敗は捕まえて `error` を送り、コード 1011 で閉じ、サーバは落とさない。WebSocket が閉じたら `tmux attach` のクライアントだけを殺し、tmux セッションは残す。

- [ ] **Step 1: 依存を足す**

`packages/server/package.json` の `dependencies` に `"node-pty": "^1.1.0"` を足し、`npm install` を実行する。

- [ ] **Step 2: 失敗するテストを書く**

`packages/server/src/pty/helper.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixSpawnHelpers } from './helper.ts';

describe('fixSpawnHelpers', () => {
  it('実行権限の無い spawn-helper を 755 にし、直したものだけ返す', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pty-'));
    const a = path.join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    const b = path.join(root, 'prebuilds', 'darwin-x64', 'spawn-helper');
    fs.mkdirSync(path.dirname(a), { recursive: true }); fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(a, '', { mode: 0o644 });
    fs.writeFileSync(b, '', { mode: 0o755 });
    expect(fixSpawnHelpers(root)).toEqual([a]);
    expect(fs.statSync(a).mode & 0o777).toBe(0o755);
    expect(fixSpawnHelpers(root)).toEqual([]);
    expect(fixSpawnHelpers('/nonexistent')).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

`packages/server/src/pty/relay.test.ts`：

```ts
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TMUX, testSocketName, waitFor } from '../../test/tmux.ts';
import { Tmux } from '../tmux/tmux.ts';
import { PtyRelay, type PtyProcess, type PtySpawn } from './relay.ts';

type Msg = { t: string; d?: string; message?: string };
type FakeProc = PtyProcess & { written: string[]; sizes: number[][]; killed: boolean; emitData: (d: string) => void; emitExit: () => void };
let server: http.Server;
let port: number;
let relay: PtyRelay;
const TOKEN = 'tok';

function fakeSpawn(): { spawn: PtySpawn; procs: FakeProc[] } {
  const procs: FakeProc[] = [];
  const spawn: PtySpawn = () => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const p = { pid: 1, written: [] as string[], sizes: [] as number[][], killed: false,
      onData: (cb: (d: string) => void) => { onData = cb; }, onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb; },
      write: (d: string) => { p.written.push(d); onData('echo:' + d); }, resize: (c: number, r: number) => { p.sizes.push([c, r]); }, kill: () => { p.killed = true; },
      emitData: (d: string) => onData(d), emitExit: () => onExit({ exitCode: 0 }) };
    procs.push(p);
    return p;
  };
  return { spawn, procs };
}

async function listen(r: PtyRelay): Promise<void> {
  server = http.createServer((_q, res) => { res.statusCode = 404; res.end(); });
  r.attach(server, '/ws/pty');
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  port = (server.address() as { port: number }).port;
}
function connect(q: string): Promise<{ ws: WebSocket; msgs: Msg[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?${q}`);
    const msgs: Msg[] = [];
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString()) as Msg));
    ws.on('open', () => resolve({ ws, msgs, closed }));
    ws.on('error', reject);
  });
}
afterEach(async () => { relay?.close(); await new Promise<void>((r) => server?.close(() => r())); });

describe('PtyRelay（偽の spawn）', () => {
  const tmux = new Tmux({ tmuxPath: '/x/tmux', socketName: 'fake' });
  beforeEach(async () => { relay = new PtyRelay({ token: TOKEN, tmux, resolveTab: (t) => (t === 't1' ? 'hangar-a' : null), spawn: fakeSpawn().spawn }); await listen(relay); });

  it('トークンが無ければ 401、知らないタブは 404', async () => {
    await expect(connect('tab=t1')).rejects.toThrow(/401/);
    await expect(connect(`tab=nope&token=${TOKEN}`)).rejects.toThrow(/404/);
  });
  it('入出力とリサイズを中継し、切断で attach を殺す', async () => {
    const f = fakeSpawn();
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    relay = new PtyRelay({ token: TOKEN, tmux, resolveTab: () => 'hangar-a', spawn: vi.fn(f.spawn) });
    await listen(relay);
    const { ws, msgs, closed } = await connect(`tab=t1&token=${TOKEN}`);
    await waitFor(() => f.procs.length === 1);
    ws.send(JSON.stringify({ t: 'resize', cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ t: 'data', d: 'ls\r' }));
    ws.send('not json');
    await waitFor(() => msgs.length === 1);
    expect(msgs[0]).toEqual({ t: 'data', d: 'echo:ls\r' });
    expect(f.procs[0]!.sizes).toEqual([[100, 30]]);
    expect(relay.clientCount()).toBe(1);
    ws.close();
    await closed;
    await waitFor(() => f.procs[0]!.killed);
    expect(relay.clientCount()).toBe(0);
  });
  it('spawn の失敗は error を送って 1011 で閉じ、サーバは生きている', async () => {
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    relay = new PtyRelay({ token: TOKEN, tmux, resolveTab: () => 'hangar-a', spawn: () => { throw new Error('posix_spawnp failed'); } });
    await listen(relay);
    const { msgs, closed } = await connect(`tab=t1&token=${TOKEN}`);
    expect(await closed).toBe(1011);
    expect(msgs[0]).toMatchObject({ t: 'error', message: expect.stringContaining('posix_spawnp') });
    const again = await connect(`tab=t1&token=${TOKEN}`);
    expect(await again.closed).toBe(1011);
  });
  it('プロセスの終了で接続を閉じる', async () => {
    const f = fakeSpawn();
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    relay = new PtyRelay({ token: TOKEN, tmux, resolveTab: () => 'hangar-a', spawn: f.spawn });
    await listen(relay);
    const { closed } = await connect(`tab=t1&token=${TOKEN}`);
    await waitFor(() => f.procs.length === 1);
    f.procs[0]!.emitExit();
    expect(await closed).toBe(1000);
  });
});

describe.skipIf(!TMUX)('PtyRelay（実物の tmux と node-pty）', () => {
  const tmux = new Tmux({ tmuxPath: TMUX ?? 'tmux', socketName: testSocketName() });
  afterAll(() => tmux.killServer());
  it('tmux セッションに attach して入出力が通る', async () => {
    const { nodePtySpawn } = await import('./nodePty.ts');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pty-real-'));
    tmux.newSession({ name: 'hangar-pty-real', cwd, command: ['sh'] });
    relay = new PtyRelay({ token: TOKEN, tmux, resolveTab: () => 'hangar-pty-real', spawn: nodePtySpawn });
    await listen(relay);
    const { ws, msgs } = await connect(`tab=x&token=${TOKEN}`);
    ws.send(JSON.stringify({ t: 'resize', cols: 80, rows: 24 }));
    ws.send(JSON.stringify({ t: 'data', d: 'echo hangar-pty-ok\r' }));
    await waitFor(() => msgs.some((m) => m.t === 'data' && (m.d ?? '').includes('hangar-pty-ok')), 8000);
    ws.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run packages/server/src/pty`
Expected: FAIL

- [ ] **Step 4: 実装する**

`packages/server/src/pty/helper.ts`：

```ts
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * node-pty の prebuild は spawn-helper に実行権限が無い状態で展開されることがある（フェーズ 0 で確認）。
 * そのままでは posix_spawnp failed で落ちるので、起動時に権限を確認して直す。
 */
export function fixSpawnHelpers(packageDir: string): string[] {
  const candidates: string[] = [];
  const prebuilds = path.join(packageDir, 'prebuilds');
  if (fs.existsSync(prebuilds)) for (const d of fs.readdirSync(prebuilds)) candidates.push(path.join(prebuilds, d, 'spawn-helper'));
  candidates.push(path.join(packageDir, 'build', 'Release', 'spawn-helper'));
  const fixed: string[] = [];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const mode = fs.statSync(f).mode & 0o777;
    if ((mode & 0o111) !== 0o111) { fs.chmodSync(f, 0o755); fixed.push(f); }
  }
  return fixed;
}

export function ensureSpawnHelper(): string[] {
  try {
    const pkg = createRequire(import.meta.url).resolve('node-pty/package.json');
    return fixSpawnHelpers(path.dirname(pkg));
  } catch { return []; }
}
```

`packages/server/src/pty/nodePty.ts`：

```ts
import * as pty from 'node-pty';
import type { PtySpawn } from './relay.ts';

/** 本物の node-pty。テストでは偽の spawn を渡すので、このファイルはサーバ起動時にだけ読まれる。 */
export const nodePtySpawn: PtySpawn = (file, args, opts) => {
  const p = pty.spawn(file, args, { name: opts.name, cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env as Record<string, string> });
  return {
    pid: p.pid,
    onData: (cb) => { p.onData(cb); },
    onExit: (cb) => { p.onExit((e) => cb({ exitCode: e.exitCode })); },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
  };
};
```

`packages/server/src/pty/relay.ts`：

```ts
import type http from 'node:http';
import os from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { originAllowed, tokenFromRequest } from '../http/auth.ts';
import type { Tmux } from '../tmux/tmux.ts';

export type PtyProcess = { pid: number; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void; write(d: string): void; resize(cols: number, rows: number): void; kill(): void };
export type PtySpawn = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyProcess;
type Deps = { token: string; tmux: Tmux | null; resolveTab: (tabId: string) => string | null; spawn: PtySpawn };

/** /ws/pty?tab=<tabId> で node-pty の `tmux attach` を中継する。複数のクライアントが同じ tmux セッションに attach してよい。 */
export class PtyRelay {
  private wss = new WebSocketServer({ noServer: true });
  private clients = new Set<WebSocket>();
  constructor(private readonly deps: Deps) {}

  attach(server: http.Server, path: string): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== path) return;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const token = tokenFromRequest(headers, req.headers.cookie) ?? url.searchParams.get('token');
      if (!originAllowed(req.headers.origin) || token !== this.deps.token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      const name = this.deps.resolveTab(url.searchParams.get('tab') ?? '');
      if (!name || !this.deps.tmux) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.serve(ws, name));
    });
  }

  private serve(ws: WebSocket, tmuxName: string): void {
    const tmux = this.deps.tmux!;
    let p: PtyProcess;
    try {
      p = this.deps.spawn(tmux.tmuxPath, tmux.attachArgs(tmuxName), { name: 'xterm-256color', cols: 120, rows: 40, cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG ?? 'ja_JP.UTF-8' } });
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', message: `pty spawn failed: ${e instanceof Error ? e.message : String(e)}` }));
      ws.close(1011, 'spawn failed');
      return;
    }
    this.clients.add(ws);
    p.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'data', d })); });
    p.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(1000, 'exited'); });
    ws.on('message', (raw) => {
      let m: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
      try { m = JSON.parse(raw.toString()) as typeof m; } catch { return; }
      if (m.t === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows) && (m.cols as number) > 0 && (m.rows as number) > 0) p.resize(m.cols as number, m.rows as number);
      else if (m.t === 'data' && typeof m.d === 'string') p.write(m.d);
    });
    ws.on('close', () => { this.clients.delete(ws); try { p.kill(); } catch { /* 既に終わっている */ } });
  }

  clientCount(): number { return this.clients.size; }
  close(): void { for (const c of this.clients) c.close(); this.clients.clear(); this.wss.close(); }
}
```

`EventHub` も同じ `upgrade` イベントに載っているが、`pathname` が違えば何もしないので、二つの WebSocket サーバは共存する。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/pty`
Expected: PASS（helper 1 件、relay は偽の spawn で 4 件、tmux があれば実物 1 件）

- [ ] **Step 6: コミット**

```bash
git add package-lock.json packages/server/package.json packages/server/src/pty
git commit -m "feat(server): websocket relay of tmux attach over node-pty with spawn-helper fix"
```

---

### Task 11: MCP のツール関数

**Files:**
- Create: `packages/server/src/mcp/tools.ts`
- Test: `packages/server/src/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `listProjects`、`getProject`、`listSessions`、`getSession`（`db/queries.ts`）、`searchSessions`、`readEvents`、`upsertShared`、`RunManager.start` の型（`LaunchResult`）。
- Produces:
  ```ts
  export type ToolDeps = { db: Db; deviceId: string; port: number; live: () => LiveSessionDto[]; runs: { start(params: LaunchParams): LaunchResult }; hub: { broadcast(ev: ServerEvent): void } };
  export type ToolContext = { sessionId: string | null };       // セッション別 URL なら固定
  export class ToolError extends Error {}
  export const TOOL_NAMES: readonly ['list_projects', 'get_project', 'update_project', 'list_sessions', 'search_sessions', 'get_transcript', 'create_session', 'set_session_summary', 'set_session_memo', 'get_usage', 'open_in_hangar'];
  export function callTool(deps: ToolDeps, ctx: ToolContext, name: string, args: Record<string, unknown>): unknown;
  ```
- 返り値はそのまま JSON にできる素のオブジェクトで、MCP の層（Task 12）が `content` に包む。`session_id` を省いた呼び出しは `ctx.sessionId` を指し、どちらも無ければ `ToolError`。
- `get_usage` と `update_project` の `add_todos`、`toggle_todos`、`append_memo` は「フェーズ 3 で対応します」を返す。`update_project` の `status` だけは書く。
- `get_transcript` は `include_tools` が偽なら `tool_call` と `tool_result` を落とし、`thinking` と `meta` は常に落とす。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/mcp/tools.test.ts`：

```ts
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions } from '../projects/registry.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { callTool, ToolError, TOOL_NAMES, type ToolDeps } from './tools.ts';

let dir: string;
let db: Db;
let alphaId: string;
const sent: ServerEvent[] = [];
const live: LiveSessionDto[] = [{ sessionId: SESSION_ALPHA, status: 'busy', name: null, nameSource: null, cwd: '/Users/me/workspace/alpha', pid: 1 }];
const started: unknown[] = [];
let deps: ToolDeps;

beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:'); sent.length = 0; started.length = 0;
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  deps = { db, deviceId: 'd', port: 4177, live: () => live, hub: { broadcast: (e) => sent.push(e) },
    runs: { start: (p) => { started.push(p); return { run: { id: 'r1', sessionId: 'sNew', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 'sNew', tabs: [] }; } } };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const call = (name: string, args: Record<string, unknown> = {}, ctx = { sessionId: null as string | null }) => callTool(deps, ctx, name, args) as Record<string, unknown>;

describe('MCP tools', () => {
  it('list_projects と get_project', () => {
    const list = call('list_projects') as unknown as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'p1', name: 'alpha', status: 'active', path: '/Users/me/workspace/alpha', open_todo_count: 0 });
    const p = call('get_project', { project_id: 'p1' });
    expect(p).toMatchObject({ id: 'p1', memo: null, todos: [], artifacts: [] });
    expect((p.recent_sessions as { id: string }[]).map((s) => s.id)).toEqual([alphaId]);
    expect(() => call('get_project', { project_id: 'nope' })).toThrow(ToolError);
  });
  it('update_project は status だけ書き、TODO とメモは not_yet', () => {
    const r = call('update_project', { project_id: 'p1', status: 'paused', add_todos: ['x'] });
    expect((r.project as { status: string }).status).toBe('paused');
    expect(r.not_yet).toEqual({ fields: ['add_todos'], message: 'フェーズ 3 で対応します' });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: 'p1', status: 'paused' } });
    expect(() => call('update_project', { project_id: 'p1', status: 'bogus' })).toThrow(ToolError);
  });
  it('list_sessions は running と limit で絞る', () => {
    expect((call('list_sessions') as unknown as unknown[]).length).toBe(3);
    const running = call('list_sessions', { running: true }) as unknown as { id: string; live: string }[];
    expect(running).toEqual([expect.objectContaining({ id: alphaId, live: 'busy' })]);
    expect((call('list_sessions', { running: false, limit: 1 }) as unknown as unknown[]).length).toBe(1);
    expect((call('list_sessions', { project_id: 'p1' }) as unknown as unknown[]).length).toBe(1);
  });
  it('search_sessions は抜粋と再開コマンドを返す', () => {
    const r = call('search_sessions', { query: 'チャンネル' });
    expect(r.total).toBe(1);
    const hit = (r.hits as Record<string, unknown>[])[0]!;
    expect(hit).toMatchObject({ session_id: alphaId, title: '動画チャンネルの整理', resume_command: `claude -r ${SESSION_ALPHA}` });
    expect((hit.snippets as unknown[]).length).toBeGreaterThan(0);
  });
  it('get_transcript はセッション別 URL では session_id を省け、既定でツールを落とす', () => {
    const plain = call('get_transcript', {}, { sessionId: alphaId });
    const kinds = (plain.events as { kind: string }[]).map((e) => e.kind);
    expect(kinds).not.toContain('tool_call');
    expect(kinds).not.toContain('thinking');
    expect(kinds).toContain('user');
    const withTools = call('get_transcript', { session_id: alphaId, include_tools: true, limit: 3 });
    expect((withTools.events as unknown[]).length).toBe(3);
    expect(withTools.next_seq).toBe(3);
    expect(() => call('get_transcript')).toThrow(/session_id/);
  });
  it('create_session は runs.start を呼び、URL を返す', () => {
    const r = call('create_session', { project_id: 'p1', name: 'n', prompt: 'p', permission_mode: 'default' });
    expect(started[0]).toEqual({ projectId: 'p1', name: 'n', prompt: 'p', model: undefined, effort: undefined, permissionMode: 'default', scratch: undefined });
    expect(r).toEqual({ run_id: 'r1', session_id: 'sNew', tmux_name: 'hangar-r1', url: 'http://127.0.0.1:4177/#/session/sNew' });
  });
  it('set_session_summary は in_session で保存して配信する', () => {
    const r = call('set_session_summary', { title: 'T', one_liner: 'O', body: 'B', state: 'blocked', next_steps: ['n1'] }, { sessionId: alphaId });
    expect(r).toEqual({ ok: true, session_id: alphaId });
    const row = db.prepare('select * from session_summaries where session_id = ?').get(alphaId) as Record<string, unknown>;
    expect(row).toMatchObject({ title: 'T', one_liner: 'O', state: 'blocked', source: 'in_session', based_on_turns: 2 });
    expect(JSON.parse(row.next_steps as string)).toEqual(['n1']);
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { id: alphaId, summary: { title: 'T', source: 'in_session' } } });
    expect(() => call('set_session_summary', { title: 'T', one_liner: 'O', body: 'B', state: 'weird', next_steps: [] }, { sessionId: alphaId })).toThrow(ToolError);
  });
  it('set_session_memo、get_usage、open_in_hangar', () => {
    expect(call('set_session_memo', { session_id: alphaId, text: 'メモ' })).toEqual({ ok: true, session_id: alphaId });
    expect((db.prepare('select memo from sessions where id = ?').get(alphaId) as { memo: string }).memo).toBe('メモ');
    expect(call('get_usage')).toEqual({ not_yet: 'フェーズ 3 で対応します' });
    expect(call('open_in_hangar', { session_id: alphaId })).toEqual({ url: `http://127.0.0.1:4177/#/session/${alphaId}`, deep_link: `hangar://session/${alphaId}` });
    expect(call('open_in_hangar', { project_id: 'p1' })).toEqual({ url: 'http://127.0.0.1:4177/#/project/p1', deep_link: 'hangar://project/p1' });
    expect(call('open_in_hangar', {}, { sessionId: alphaId }).url).toContain(alphaId);
    expect(() => call('nope')).toThrow(ToolError);
    expect(TOOL_NAMES).toHaveLength(11);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/mcp`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/mcp/tools.ts`：

```ts
import type { LaunchParams, LiveSessionDto, ProjectStatus, ServerEvent, SessionDto, SummaryState, TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import type { LaunchResult } from '../runs/manager.ts';
import { searchSessions } from '../search/search.ts';
import { readEvents } from '../transcript/read.ts';

export type ToolDeps = { db: Db; deviceId: string; port: number; live: () => LiveSessionDto[]; runs: { start(params: LaunchParams): LaunchResult }; hub: { broadcast(ev: ServerEvent): void } };
export type ToolContext = { sessionId: string | null };
export class ToolError extends Error { constructor(message: string) { super(message); this.name = 'ToolError'; } }

export const TOOL_NAMES = ['list_projects', 'get_project', 'update_project', 'list_sessions', 'search_sessions', 'get_transcript', 'create_session', 'set_session_summary', 'set_session_memo', 'get_usage', 'open_in_hangar'] as const;
const NOT_YET = 'フェーズ 3 で対応します';
const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];
const STATES: SummaryState[] = ['in_progress', 'done', 'blocked', 'abandoned'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

function sessionIdOf(ctx: ToolContext, args: Record<string, unknown>): string {
  const id = str(args.session_id) ?? ctx.sessionId;
  if (!id) throw new ToolError('session_id が必要です（セッション別 URL では省略できます）');
  return id;
}

function sessionBrief(s: SessionDto) {
  return { id: s.id, name: s.name, project_id: s.projectId, cwd: s.cwd, live: s.live, started_at: s.startedAt, last_activity_at: s.lastActivityAt, memo: s.memo, summary: s.summary ? { title: s.summary.title, one_liner: s.summary.oneLiner, state: s.summary.state, source: s.summary.source } : null, resume_command: `claude -r ${s.providerSessionId}` };
}

function requireSession(deps: ToolDeps, id: string): SessionDto {
  const s = getSession(deps.db, deps.live(), id);
  if (!s) throw new ToolError(`セッションが見つかりません: ${id}`);
  return s;
}

const url = (deps: ToolDeps, route: string) => `http://127.0.0.1:${deps.port}/#/${route}`;

export function listProjectsTool(deps: ToolDeps) {
  return listProjects(deps.db, deps.deviceId, deps.live()).map((p) => ({ id: p.id, name: p.name, status: p.status, path: p.path, resolved: p.resolved, open_todo_count: p.openTodoCount, running_count: p.runningCount, last_activity_at: p.lastActivityAt }));
}

export function getProjectTool(deps: ToolDeps, args: Record<string, unknown>) {
  const id = str(args.project_id);
  if (!id) throw new ToolError('project_id が必要です');
  const p = getProject(deps.db, deps.deviceId, deps.live(), id);
  if (!p) throw new ToolError(`プロジェクトが見つかりません: ${id}`);
  const memo = (deps.db.prepare('select markdown from project_memos where project_id = ? and deleted_at is null').get(id) as { markdown: string } | undefined)?.markdown ?? null;
  const todos = (deps.db.prepare('select id, text, done from todos where project_id = ? and deleted_at is null order by position').all(id) as { id: string; text: string; done: number }[]).map((t) => ({ id: t.id, text: t.text, done: t.done === 1 }));
  const recent = listSessions(deps.db, deps.live(), { projectId: id }).slice(0, 10).map(sessionBrief);
  return { id: p.id, name: p.name, status: p.status, path: p.path, resolved: p.resolved, last_activity_at: p.lastActivityAt, memo, todos, recent_sessions: recent, artifacts: [] };
}

export function updateProjectTool(deps: ToolDeps, args: Record<string, unknown>) {
  const id = str(args.project_id);
  if (!id) throw new ToolError('project_id が必要です');
  const row = deps.db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new ToolError(`プロジェクトが見つかりません: ${id}`);
  const status = str(args.status);
  if (status !== undefined) {
    if (!STATUSES.includes(status as ProjectStatus)) throw new ToolError(`status は ${STATUSES.join(', ')} のいずれかです`);
    upsertShared(deps.db, 'projects', { ...row, status }, deps.deviceId);
    const p = getProject(deps.db, deps.deviceId, deps.live(), id)!;
    deps.hub.broadcast({ type: 'project.upsert', project: p });
  }
  const ignored = ['add_todos', 'toggle_todos', 'append_memo'].filter((k) => args[k] !== undefined);
  const p = getProject(deps.db, deps.deviceId, deps.live(), id)!;
  return { project: { id: p.id, name: p.name, status: p.status }, not_yet: ignored.length ? { fields: ignored, message: NOT_YET } : null };
}

export function listSessionsTool(deps: ToolDeps, args: Record<string, unknown>) {
  let list = listSessions(deps.db, deps.live(), { projectId: str(args.project_id) });
  const running = bool(args.running);
  if (running !== undefined) list = list.filter((s) => (s.live !== null) === running);
  return list.slice(0, num(args.limit) ?? 50).map(sessionBrief);
}

export function searchSessionsTool(deps: ToolDeps, args: Record<string, unknown>) {
  const q = str(args.query) ?? '';
  const runningIds = new Set(deps.live().map((l) => l.sessionId));
  const r = searchSessions(deps.db, { q, projectId: str(args.project_id), since: num(args.since), until: num(args.until), file: str(args.file), limit: num(args.limit) }, runningIds);
  const hits = r.hits.map((h) => {
    const s = getSession(deps.db, deps.live(), h.sessionId);
    return { session_id: h.sessionId, title: s?.summary?.title ?? s?.name ?? null, one_liner: s?.summary?.oneLiner ?? null, project_id: s?.projectId ?? null, last_activity_at: s?.lastActivityAt ?? null, match_count: h.matchCount, snippets: h.snippets, resume_command: s ? `claude -r ${s.providerSessionId}` : null };
  });
  return { total: r.total, hits };
}

export function getTranscriptTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const includeTools = bool(args.include_tools) ?? false;
  const page = readEvents(deps.db, id, { fromSeq: num(args.from_seq), limit: num(args.limit) });
  const keep = (e: TranscriptEvent) => e.kind === 'user' || e.kind === 'assistant' || e.kind === 'system' || e.kind === 'subagent' || (includeTools && (e.kind === 'tool_call' || e.kind === 'tool_result'));
  return { session_id: id, events: page.events.filter(keep), total: page.total, next_seq: page.nextSeq };
}

export function createSessionTool(deps: ToolDeps, args: Record<string, unknown>) {
  const projectId = str(args.project_id);
  if (!projectId) throw new ToolError('project_id が必要です');
  const r = deps.runs.start({ projectId, name: str(args.name), prompt: str(args.prompt), model: str(args.model), effort: str(args.effort), permissionMode: str(args.permission_mode), scratch: bool(args.scratch) });
  return { run_id: r.run.id, session_id: r.sessionId, tmux_name: r.run.tmuxName, url: url(deps, `session/${r.sessionId}`) };
}

export function setSessionSummaryTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const title = str(args.title); const oneLiner = str(args.one_liner); const body = str(args.body); const state = str(args.state);
  if (!title || !oneLiner || !body || !state) throw new ToolError('title、one_liner、body、state が必要です');
  if (!STATES.includes(state as SummaryState)) throw new ToolError(`state は ${STATES.join(', ')} のいずれかです`);
  const turns = (deps.db.prepare('select turns from session_stats where session_id = ?').get(id) as { turns: number } | undefined)?.turns ?? 0;
  upsertShared(deps.db, 'session_summaries', { session_id: id, title, one_liner: oneLiner, body, state, next_steps: JSON.stringify(strs(args.next_steps) ?? []), source: 'in_session', source_model: null, based_on_turns: turns }, deps.deviceId, 'session_id');
  deps.hub.broadcast({ type: 'session.upsert', session: getSession(deps.db, deps.live(), id)! });
  return { ok: true, session_id: id };
}

export function setSessionMemoTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const row = deps.db.prepare('select * from sessions where id = ?').get(id) as Record<string, unknown>;
  upsertShared(deps.db, 'sessions', { ...row, memo: typeof args.text === 'string' ? args.text : '' }, deps.deviceId);
  deps.hub.broadcast({ type: 'session.upsert', session: getSession(deps.db, deps.live(), id)! });
  return { ok: true, session_id: id };
}

export function openInHangarTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const projectId = str(args.project_id);
  if (projectId) return { url: url(deps, `project/${projectId}`), deep_link: `hangar://project/${projectId}` };
  const id = sessionIdOf(ctx, args);
  return { url: url(deps, `session/${id}`), deep_link: `hangar://session/${id}` };
}

/** 名前で振り分ける。MCP の層はこれを content に包むだけにする。 */
export function callTool(deps: ToolDeps, ctx: ToolContext, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'list_projects': return listProjectsTool(deps);
    case 'get_project': return getProjectTool(deps, args);
    case 'update_project': return updateProjectTool(deps, args);
    case 'list_sessions': return listSessionsTool(deps, args);
    case 'search_sessions': return searchSessionsTool(deps, args);
    case 'get_transcript': return getTranscriptTool(deps, ctx, args);
    case 'create_session': return createSessionTool(deps, args);
    case 'set_session_summary': return setSessionSummaryTool(deps, ctx, args);
    case 'set_session_memo': return setSessionMemoTool(deps, ctx, args);
    case 'get_usage': return { not_yet: NOT_YET };
    case 'open_in_hangar': return openInHangarTool(deps, ctx, args);
    default: throw new ToolError(`知らないツールです: ${name}`);
  }
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/mcp`
Expected: PASS（8 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/mcp
git commit -m "feat(server): mcp tool functions over projects, sessions, search, transcript and summary"
```

---

### Task 12: MCP サーバ（Streamable HTTP、共通 URL とセッション別 URL）

**Files:**
- Create: `packages/server/src/mcp/app.ts`
- Modify: `packages/server/package.json`（`@modelcontextprotocol/sdk` と `zod` を足す）
- Test: `packages/server/src/mcp/app.test.ts`

**Interfaces:**
- Consumes: `callTool`、`TOOL_NAMES`、`ToolError`、`authMiddleware`。
- Produces:
  ```ts
  export function buildMcpServer(deps: ToolDeps, ctx: ToolContext): McpServer;
  export function createMcpApp(deps: ToolDeps & { token: string }): Hono;   // '/' が共通、'/s/:sessionId' がセッション別。http/app.ts が '/mcp' に mount する
  ```
- 要求ごとに `WebStandardStreamableHTTPServerTransport`（`sessionIdGenerator: undefined`、`enableJsonResponse: true`）と `McpServer` を新しく作る。フェーズ 0 の spike と同じ形で、状態を持たない。
- セッション別 URL の `sessionId` が `sessions` に無ければ 404。ツールの説明はすべて `agent-hangar:` で始める。

- [ ] **Step 1: 依存を足す**

`packages/server/package.json` の `dependencies` に `"@modelcontextprotocol/sdk": "^1.30.0"` と `"zod": "^4.6.5"` を足し、`npm install` を実行する。

- [ ] **Step 2: 失敗するテストを書く**

`packages/server/src/mcp/app.test.ts`：

```ts
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions } from '../projects/registry.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { createMcpApp } from './app.ts';
import { TOOL_NAMES } from './tools.ts';

let dir: string;
let db: Db;
let alphaId: string;
let app: ReturnType<typeof createMcpApp>;
const TOKEN = 'tok';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  app = createMcpApp({ db, deviceId: 'd', port: 4177, token: TOKEN, live: () => [], hub: { broadcast: () => {} }, runs: { start: () => { throw new Error('not in this test'); } } });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** JSON でも SSE でも 1 件目の JSON-RPC 応答を取り出す。 */
async function rpc(path: string, method: string, params: unknown, id = 1, headers: Record<string, string> = H): Promise<{ status: number; body: { result?: Record<string, unknown>; error?: { message: string } } }> {
  const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: {} };
  const ct = res.headers.get('content-type') ?? '';
  const json = ct.includes('text/event-stream') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())[0]! : text;
  return { status: res.status, body: JSON.parse(json) };
}
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } };

describe('createMcpApp', () => {
  it('認証：トークン無しは 401、Origin 違いは 403', async () => {
    expect((await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await app.request('/', { method: 'POST', headers: { ...H, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
  });
  it('initialize と tools/list', async () => {
    const init = await rpc('/', 'initialize', INIT);
    expect(init.status).toBe(200);
    expect((init.body.result!.serverInfo as { name: string }).name).toBe('agent-hangar');
    const list = await rpc('/', 'tools/list', {}, 2);
    const tools = list.body.result!.tools as { name: string; description: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) expect(t.description, t.name).toContain('agent-hangar');
  });
  it('tools/call は結果を text に包む', async () => {
    const r = await rpc('/', 'tools/call', { name: 'list_projects', arguments: {} }, 3);
    const content = r.body.result!.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)[0].name).toBe('alpha');
    const bad = await rpc('/', 'tools/call', { name: 'get_project', arguments: { project_id: 'nope' } }, 4);
    expect(bad.body.result!.isError).toBe(true);
  });
  it('セッション別 URL では session_id を省ける。無いセッションは 404', async () => {
    const r = await rpc(`/s/${alphaId}`, 'tools/call', { name: 'set_session_memo', arguments: { text: 'from mcp' } }, 5);
    expect(JSON.parse((r.body.result!.content as { text: string }[])[0]!.text)).toEqual({ ok: true, session_id: alphaId });
    expect((db.prepare('select memo from sessions where id = ?').get(alphaId) as { memo: string }).memo).toBe('from mcp');
    expect((await app.request('/s/nope', { method: 'POST', headers: H, body: '{}' })).status).toBe(404);
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run packages/server/src/mcp/app`
Expected: FAIL

- [ ] **Step 4: 実装する**

`packages/server/src/mcp/app.ts`：

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../http/auth.ts';
import { callTool, type ToolContext, type ToolDeps } from './tools.ts';

export const MCP_VERSION = '0.2.0';

/** 説明文に「agent-hangar」を含める。Claude Code はツール定義を遅延して読むので、検索で当たる語が要る。 */
const D = (s: string) => `agent-hangar: ${s}`;
const STATUS = z.enum(['active', 'paused', 'done', 'archived']);
const STATE = z.enum(['in_progress', 'done', 'blocked', 'abandoned']);

export function buildMcpServer(deps: ToolDeps, ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'agent-hangar', version: MCP_VERSION });
  const reg = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>) => {
    server.registerTool(name, { description, inputSchema }, async (args: Record<string, unknown>) => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(callTool(deps, ctx, name, args), null, 2) }] }; }
      catch (e) { return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true }; }
    });
  };
  reg('list_projects', D('プロジェクトの一覧。ステータス、パス、未完 TODO 数、最終活動を返す。'), {});
  reg('get_project', D('プロジェクトの詳細。TODO、メモ、直近のセッション、アーティファクト。'), { project_id: z.string() });
  reg('update_project', D('プロジェクトのステータスを変える。TODO とメモの更新はフェーズ 3 で対応する。'), { project_id: z.string(), status: STATUS.optional(), add_todos: z.array(z.string()).optional(), toggle_todos: z.array(z.string()).optional(), append_memo: z.string().optional() });
  reg('list_sessions', D('セッションの一覧。project_id、running、limit で絞る。'), { project_id: z.string().optional(), running: z.boolean().optional(), limit: z.number().int().positive().optional() });
  reg('search_sessions', D('過去のセッションを全文検索する。題名、要約の 1 文、一致箇所の抜粋、再開コマンドを返す。'), { query: z.string(), project_id: z.string().optional(), since: z.number().optional(), until: z.number().optional(), provider: z.string().optional(), file: z.string().optional(), limit: z.number().int().positive().optional() });
  reg('get_transcript', D('セッションの本文を正規化イベントで返す。セッション別 URL では session_id を省ける。'), { session_id: z.string().optional(), from_seq: z.number().int().optional(), limit: z.number().int().positive().optional(), include_tools: z.boolean().optional() });
  reg('create_session', D('プロジェクトで新しい Claude Code セッションを tmux 上に起動する。'), { project_id: z.string(), name: z.string().optional(), prompt: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), permission_mode: z.string().optional(), scratch: z.boolean().optional() });
  reg('set_session_summary', D('このセッションの要約を更新する。依頼の完了、方針の変更、中断のときに呼ぶ。'), { session_id: z.string().optional(), title: z.string(), one_liner: z.string(), body: z.string(), state: STATE, next_steps: z.array(z.string()) });
  reg('set_session_memo', D('セッションの人間向け 1 行メモを書く。'), { session_id: z.string().optional(), text: z.string() });
  reg('get_usage', D('5 時間と 7 日の使用率。フェーズ 3 で対応する。'), {});
  reg('open_in_hangar', D('セッションかプロジェクトを hangar の UI で開く URL とディープリンクを返す。'), { session_id: z.string().optional(), project_id: z.string().optional() });
  return server;
}

/** 状態を持たない Streamable HTTP。要求ごとにサーバとトランスポートを作る。 */
export function createMcpApp(deps: ToolDeps & { token: string }): Hono {
  const app = new Hono();
  app.use('*', authMiddleware(deps.token));
  const handle = async (c: Context, sessionId: string | null) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await buildMcpServer(deps, { sessionId }).connect(transport);
    return transport.handleRequest(c.req.raw);
  };
  app.all('/', (c) => handle(c, null));
  app.all('/s/:sessionId', (c) => {
    const id = c.req.param('sessionId');
    if (!deps.db.prepare('select 1 from sessions where id = ? and deleted_at is null').get(id)) return c.json({ error: 'session not found' }, 404);
    return handle(c, id);
  });
  return app;
}
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/mcp && npx tsc -p packages/server --noEmit 2>&1 | grep -v 'bootstrap\|app.ts\|server.ts'`
Expected: PASS（app 4 件）

- [ ] **Step 6: コミット**

```bash
git add package-lock.json packages/server/package.json packages/server/src/mcp
git commit -m "feat(server): streamable http mcp server with shared and per-session urls"
```

---

### Task 13: 外部連携（Terminal.app、iTerm2、VS Code）

**Files:**
- Create: `packages/server/src/external/open.ts`
- Test: `packages/server/src/external/open.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  export const execFile: Exec;                                          // child_process.execFile の Promise 版。失敗でも投げず code を返す
  export function writeAttachCommand(home: string, tmuxPath: string, tmuxName: string): string;   // <home>/cmd/attach-<name>.command
  export function writeCdCommand(home: string, dir: string): string;                             // <home>/cmd/open-<hash>.command
  export function openInTerminalApp(o: { home: string; tmuxPath: string; tmuxName: string; app: TerminalApp; exec?: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  export function openDirInTerminalApp(o: { home: string; dir: string; app: TerminalApp; exec?: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  export function openInEditor(o: { codePath: string | null; target: string; exec?: Exec }): Promise<void>;   // codePath が無ければ Error
  ```
- Terminal.app の経路は `.command` ファイルを `open -g -a Terminal <file>` で開く。iTerm2 は `osascript -e` に `with timeout of 10 seconds` を付けた AppleScript で新規ウィンドウを開き、失敗（非 0 か 12 秒超過）なら Terminal.app の経路に落として `fellBack: true` を返す。
- `.command` の中身は `#!/usr/bin/env bash`、コマンド、`exit` の 3 行で、detach 後に「[Process completed]」で残らないようにする。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/external/open.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDirInTerminalApp, openInEditor, openInTerminalApp, writeAttachCommand, writeCdCommand, type Exec } from './open.ts';

let home: string;
let calls: { cmd: string; args: string[] }[];
const exec = (results: Record<string, number> = {}): Exec => async (cmd, args) => { calls.push({ cmd, args }); return { code: results[cmd] ?? 0, stdout: '', stderr: '' }; };
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ext-')); calls = []; });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('.command ファイル', () => {
  it('attach 用と cd 用を実行可能で書く', () => {
    const a = writeAttachCommand(home, '/opt/homebrew/bin/tmux', 'hangar-ab12cd34');
    expect(a).toBe(path.join(home, 'cmd', 'attach-hangar-ab12cd34.command'));
    expect(fs.statSync(a).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(a, 'utf8')).toBe("#!/usr/bin/env bash\n'/opt/homebrew/bin/tmux' attach -t 'hangar-ab12cd34'\nexit\n");
    const c = writeCdCommand(home, "/Users/me/work space/it's");
    expect(fs.readFileSync(c, 'utf8')).toBe('#!/usr/bin/env bash\ncd \'/Users/me/work space/it\'\\\'\'s\' && exec "${SHELL:-/bin/zsh}" -l\nexit\n');
  });
});

describe('openInTerminalApp', () => {
  it('terminal は open -g -a Terminal で .command を開く', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: '/t/tmux', tmuxName: 'hangar-x', app: 'terminal', exec: exec() });
    expect(r).toEqual({ app: 'terminal', fellBack: false });
    expect(calls).toEqual([{ cmd: 'open', args: ['-g', '-a', 'Terminal', path.join(home, 'cmd', 'attach-hangar-x.command')] }]);
  });
  it('iterm は osascript を 10 秒のタイムアウト付きで呼ぶ', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: '/t/tmux', tmuxName: 'hangar-x', app: 'iterm', exec: exec() });
    expect(r).toEqual({ app: 'iterm', fellBack: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('osascript');
    const script = calls[0]!.args[1]!;
    expect(script).toContain('with timeout of 10 seconds');
    expect(script).toContain('tell application "iTerm"');
    expect(script).toContain('create window with default profile command "/t/tmux attach -t hangar-x"');
  });
  it('iterm が失敗したら Terminal.app に落とす', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: '/t/tmux', tmuxName: 'hangar-x', app: 'iterm', exec: exec({ osascript: 1 }) });
    expect(r).toEqual({ app: 'terminal', fellBack: true });
    expect(calls.map((c) => c.cmd)).toEqual(['osascript', 'open']);
  });
  it('open が失敗したら投げる', async () => {
    await expect(openInTerminalApp({ home, tmuxPath: '/t/tmux', tmuxName: 'hangar-x', app: 'terminal', exec: exec({ open: 1 }) })).rejects.toThrow(/Terminal/);
  });
  it('ディレクトリを開く経路も同じ', async () => {
    const r = await openDirInTerminalApp({ home, dir: '/w/alpha', app: 'terminal', exec: exec() });
    expect(r.app).toBe('terminal');
    expect(fs.readFileSync(calls[0]!.args[3]!, 'utf8')).toContain("cd '/w/alpha'");
  });
});

describe('openInEditor', () => {
  it('code <target> を呼ぶ。codePath が無ければ投げる', async () => {
    await openInEditor({ codePath: '/usr/local/bin/code', target: '/w/alpha', exec: exec() });
    expect(calls).toEqual([{ cmd: '/usr/local/bin/code', args: ['/w/alpha'] }]);
    await expect(openInEditor({ codePath: null, target: '/w', exec: exec() })).rejects.toThrow(/codePath/);
    await expect(openInEditor({ codePath: '/x/code', target: '/w', exec: exec({ '/x/code': 2 }) })).rejects.toThrow(/VS Code/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/external`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/external/open.ts`：

```ts
import { execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TerminalApp } from '@agent-hangar/shared';

export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const execFile: Exec = (cmd, args, opts) => new Promise((resolve) => {
  execFileCb(cmd, args, { timeout: opts?.timeoutMs ?? 30_000, encoding: 'utf8' }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

/** シェルの単一引用符で包む。 */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function cmdDir(home: string): string {
  const d = path.join(home, 'cmd');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeCommand(file: string, line: string): string {
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${line}\nexit\n`, { mode: 0o755 });
  return file;
}

/** tmux attach を書いた .command。AppleEvent を使わないので macOS の自動化の許可が要らない。 */
export function writeAttachCommand(home: string, tmuxPath: string, tmuxName: string): string {
  return writeCommand(path.join(cmdDir(home), `attach-${tmuxName}.command`), `${sq(tmuxPath)} attach -t ${sq(tmuxName)}`);
}

export function writeCdCommand(home: string, dir: string): string {
  const hash = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 8);
  return writeCommand(path.join(cmdDir(home), `open-${hash}.command`), `cd ${sq(dir)} && exec "\${SHELL:-/bin/zsh}" -l`);
}

async function openWithTerminalApp(file: string, exec: Exec): Promise<void> {
  const r = await exec('open', ['-g', '-a', 'Terminal', file]);
  if (r.code !== 0) throw new Error(`Terminal.app で開けませんでした: ${r.stderr.trim() || `exit ${r.code}`}`);
}

/** iTerm2 は AppleScript でしか新規ウィンドウを開けない。初回は macOS の自動化の許可ダイアログが出る。 */
async function openWithIterm(command: string, exec: Exec): Promise<boolean> {
  const script = ['with timeout of 10 seconds', '  tell application "iTerm"', '    activate', `    create window with default profile command ${JSON.stringify(command)}`, '  end tell', 'end timeout'].join('\n');
  const r = await exec('osascript', ['-e', script], { timeoutMs: 12_000 });
  return r.code === 0;
}

async function openCommand(o: { app: TerminalApp; command: string; file: () => string; exec: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }> {
  if (o.app === 'iterm' && (await openWithIterm(o.command, o.exec))) return { app: 'iterm', fellBack: false };
  await openWithTerminalApp(o.file(), o.exec);
  return { app: 'terminal', fellBack: o.app === 'iterm' };
}

export function openInTerminalApp(o: { home: string; tmuxPath: string; tmuxName: string; app: TerminalApp; exec?: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }> {
  return openCommand({ app: o.app, command: `${o.tmuxPath} attach -t ${o.tmuxName}`, file: () => writeAttachCommand(o.home, o.tmuxPath, o.tmuxName), exec: o.exec ?? execFile });
}

export function openDirInTerminalApp(o: { home: string; dir: string; app: TerminalApp; exec?: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }> {
  return openCommand({ app: o.app, command: `cd ${sq(o.dir)} && exec $SHELL -l`, file: () => writeCdCommand(o.home, o.dir), exec: o.exec ?? execFile });
}

export async function openInEditor(o: { codePath: string | null; target: string; exec?: Exec }): Promise<void> {
  if (!o.codePath) throw new Error('VS Code の code コマンドが見つかりません。Settings の codePath を設定してください');
  const r = await (o.exec ?? execFile)(o.codePath, [o.target]);
  if (r.code !== 0) throw new Error(`VS Code を起動できませんでした: ${r.stderr.trim() || `exit ${r.code}`}`);
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/external`
Expected: PASS（7 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/external
git commit -m "feat(server): open tmux sessions in terminal.app or iterm2 and directories in vs code"
```

---

### Task 14: HTTP の経路の追加とサーバの結線

**Files:**
- Modify: `packages/server/src/http/app.ts`、`packages/server/src/server.ts`、`packages/server/src/runs/manager.ts`（`setTmux`）、`packages/server/src/pty/relay.ts`（`setTmux`）
- Test: `packages/server/src/http/app.test.ts`（追加）

**Interfaces:**
- Consumes: `RunManager`、`RunError`、`PtyRelay`、`nodePtySpawn`、`ensureSpawnHelper`、`ensureWrapperScript`、`createMcpApp`、`openInTerminalApp`、`openDirInTerminalApp`、`openInEditor`、`resolveToolPaths`、`Tmux`、`newId`。
- Produces:
  ```ts
  // http/app.ts
  export type RunsApi = Pick<RunManager, 'start' | 'resume' | 'fork' | 'kill' | 'openTab' | 'closeTab' | 'listAlive' | 'getRun' | 'getTab'>;
  export type ExternalApi = { openTerminal(o: { tmuxName: string }): Promise<{ app: TerminalApp; fellBack: boolean }>; openDirTerminal(o: { dir: string }): Promise<{ app: TerminalApp; fellBack: boolean }>; openEditor(o: { target: string }): Promise<void> };
  export type AppDeps = { db: Db; deviceId: string; deviceName: string; token: string; home: string; port: number; version: string; settings: () => Settings; updateSettings: (patch: Partial<SettingsDto>) => Settings; live: () => LiveSessionDto[]; indexer: { progress(): IndexProgressDto; rebuild(): Promise<void> }; hub: { broadcast(ev: ServerEvent): void }; runs: RunsApi; external: ExternalApi; uiDist?: string };
  export function toSettingsDto(s: Settings): SettingsDto;
  // runs/manager.ts と pty/relay.ts
  setTmux(tmux: Tmux | null): void;     // Settings で tmuxPath を変えたときに差し替える
  ```
- 追加する経路（すべて `/api` 配下で認証必須）：
  - `GET /api/runs` → `{ runs: RunDto[]; tabs: TabDto[] }`
  - `POST /api/runs`（`LaunchParams`）→ 201 `LaunchResultDto`。`RunError` は `status` の番号で返す
  - `DELETE /api/runs/:id` → `RunDto`
  - `POST /api/runs/:id/tabs` → 201 `TabDto`
  - `DELETE /api/runs/:id/tabs/:tabId` → `TabDto`
  - `POST /api/runs/:id/open-terminal`（`{ tabId?: string }`）→ `{ app, fellBack }`。run が無ければ 404、tabId がその run のものでなければ 404
  - `POST /api/sessions/:id/resume` → 201 `LaunchResultDto`
  - `POST /api/sessions/:id/fork` → 201 `LaunchResultDto`
  - `POST /api/sessions/:id/open-editor` → 204
  - `POST /api/projects`（`{ name: string; path: string }`）→ 201 `ProjectDto`。`path` は存在するディレクトリ
  - `POST /api/projects/:id/open-editor` → 204、`POST /api/projects/:id/open-terminal` → `{ app, fellBack }`
  - `/mcp` に `createMcpApp` を mount する（`/api` の外）
- `GET /api/bootstrap` は `runs` と `tabs` を含め、`settings` は `toSettingsDto`。`PATCH /api/settings` は `tmuxPath`（string か null）、`terminalApp`（`terminal` か `iterm`）、`codePath` を受け、不正な値は 400。
- 外部連携の失敗は 500 で `{ error }` を返す。UI はトーストにする。
- サーバの結線（`server.ts`）：`resolveToolPaths` で `tmuxPath` と `codePath` を埋めて保存、`ensureWrapperScript`、`ensureSpawnHelper`、`RunManager`、`PtyRelay`（`/ws/pty`）、run のイベントを `hub` へ、レジストリの変化で `linkRegistry`、起動時に `recoverAtStartup`、2 秒間隔の `startPolling`。`claude` の実行ファイルは `HANGAR_CLAUDE_BIN` 環境変数で差し替えられる（既定 `claude`）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/http/app.test.ts` を次のように直す。
`beforeEach` の `createApp` の呼び出しに `port: 4177`、`runs: fakeRuns()`、`external` を足し、`settings` の初期値に新しい項目を入れる。

```ts
import { vi } from 'vitest';
import type { LaunchResultDto, RunDto, TabDto } from '@agent-hangar/shared';
import { RunError } from '../runs/manager.ts';
import type { ExternalApi, RunsApi } from './app.ts';

const run: RunDto = { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 };
const agentTab: TabDto = { id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null };
const shellTab: TabDto = { id: 't1', runId: 'r1', sessionId: 's1', kind: 'shell', title: 'シェル 1', tmuxName: 'hangar-r1-t1', createdAt: 2, closedAt: null };
const launched: LaunchResultDto = { run, sessionId: 's1', tabs: [agentTab] };
let runs: RunsApi;
let external: ExternalApi;
function fakeRuns(): RunsApi {
  return {
    start: vi.fn((p) => { if (!p.projectId) throw new RunError(400, 'projectId は必須です'); return launched; }),
    resume: vi.fn((id) => { if (id === 'busy') throw new RunError(409, '実行中です'); return { ...launched, run: { ...run, kind: 'resume' } }; }),
    fork: vi.fn(() => ({ ...launched, sessionId: 's2', run: { ...run, kind: 'fork', sessionId: 's2' } })),
    kill: vi.fn((id) => { if (id !== 'r1') throw new RunError(404, 'run が見つかりません'); return { ...run, endedAt: 2, endReason: 'killed' }; }),
    openTab: vi.fn(() => shellTab),
    closeTab: vi.fn(() => ({ ...shellTab, closedAt: 3 })),
    listAlive: vi.fn(() => ({ runs: [run], tabs: [agentTab, shellTab] })),
    getRun: vi.fn((id) => (id === 'r1' ? run : null)),
    getTab: vi.fn((id) => (id === 't1' ? shellTab : id === 'r1' ? agentTab : null)),
  };
}
```

`beforeEach` の中で `runs = fakeRuns(); external = { openTerminal: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })), openDirTerminal: vi.fn(async () => ({ app: 'iterm' as const, fellBack: true })), openEditor: vi.fn(async () => {}) };` を作り、`createApp({ ..., port: 4177, runs, external })` に渡す。
`describe('routes')` に次を足す。

```ts
  it('bootstrap は runs と tabs と新しい settings を含む', async () => {
    const { body } = await json(await get('/api/bootstrap'));
    expect(body.runs).toEqual([run]);
    expect(body.tabs).toHaveLength(2);
    expect(body.settings).toEqual({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null });
  });
  it('起動、再開、フォーク、停止', async () => {
    const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const r = await post('/api/runs', { projectId: 'p1', name: 'n' });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual(launched);
    expect(runs.start).toHaveBeenCalledWith({ projectId: 'p1', name: 'n' });
    expect((await post('/api/runs', {})).status).toBe(400);
    expect((await post('/api/runs')).status).toBe(400);
    expect((await post('/api/sessions/s1/resume')).status).toBe(201);
    expect((await post('/api/sessions/busy/resume')).status).toBe(409);
    const f = await post('/api/sessions/s1/fork');
    expect((await f.json()).sessionId).toBe('s2');
    const k = await app.request('/api/runs/r1', { method: 'DELETE', headers: H });
    expect((await k.json()).endReason).toBe('killed');
    expect((await app.request('/api/runs/nope', { method: 'DELETE', headers: H })).status).toBe(404);
    expect((await json(await get('/api/runs'))).body.tabs).toHaveLength(2);
  });
  it('タブの追加と削除', async () => {
    const r = await app.request('/api/runs/r1/tabs', { method: 'POST', headers: H });
    expect(r.status).toBe(201);
    expect((await r.json()).tmuxName).toBe('hangar-r1-t1');
    const d = await app.request('/api/runs/r1/tabs/t1', { method: 'DELETE', headers: H });
    expect((await d.json()).closedAt).toBe(3);
    expect(runs.closeTab).toHaveBeenCalledWith('t1');
  });
  it('ターミナルで開く、VS Code で開く', async () => {
    const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(await (await post('/api/runs/r1/open-terminal', { tabId: 't1' })).json()).toEqual({ app: 'terminal', fellBack: false });
    expect(external.openTerminal).toHaveBeenCalledWith({ tmuxName: 'hangar-r1-t1' });
    await post('/api/runs/r1/open-terminal', {});
    expect(external.openTerminal).toHaveBeenLastCalledWith({ tmuxName: 'hangar-r1' });
    expect((await post('/api/runs/r1/open-terminal', { tabId: 'nope' })).status).toBe(404);
    expect((await post('/api/runs/nope/open-terminal', {})).status).toBe(404);
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`)).status).toBe(204);
    expect(external.openEditor).toHaveBeenCalledWith({ target: `${ws}/alpha` });
    expect((await post('/api/sessions/nope/open-editor')).status).toBe(404);
    const { body: list } = await json(await get('/api/projects'));
    expect((await post(`/api/projects/${list[0].id}/open-editor`)).status).toBe(204);
    expect(await (await post(`/api/projects/${list[0].id}/open-terminal`)).json()).toEqual({ app: 'iterm', fellBack: true });
    (external.openEditor as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('code が無い'));
    const bad = await post(`/api/sessions/${alpha.id}/open-editor`);
    expect(bad.status).toBe(500);
    expect((await bad.json()).error).toBe('code が無い');
  });
  it('プロジェクトの作成', async () => {
    fs.mkdirSync(`${ws}/beta`);
    const r = await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'beta', path: `${ws}/beta` }) });
    expect(r.status).toBe(201);
    const p = await r.json();
    expect(p).toMatchObject({ name: 'beta', path: `${ws}/beta`, resolved: true, status: 'active' });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: p.id } });
    expect((await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', path: '/nonexistent' }) })).status).toBe(400);
    expect((await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: '', path: ws }) })).status).toBe(400);
  });
  it('設定の新しい項目を検査する', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await (await patch({ terminalApp: 'iterm', tmuxPath: '/opt/homebrew/bin/tmux' })).json())).toMatchObject({ terminalApp: 'iterm', tmuxPath: '/opt/homebrew/bin/tmux' });
    expect((await patch({ terminalApp: 'kitty' })).status).toBe(400);
    expect((await patch({ tmuxPath: 3 })).status).toBe(400);
    expect((await (await patch({ codePath: null })).json()).codePath).toBeNull();
  });
  it('MCP の経路が mount されている', async () => {
    const r = await app.request('/mcp', { method: 'POST', headers: { ...H, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
    expect(r.status).toBe(200);
    expect((await app.request('/mcp', { method: 'POST', body: '{}' })).status).toBe(401);
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/http`
Expected: FAIL

- [ ] **Step 3: setTmux を足す**

`packages/server/src/runs/manager.ts` の `RunManager` に足す。

```ts
  setTmux(tmux: Tmux | null): void { (this.deps as { tmux: Tmux | null }).tmux = tmux; }
```

`packages/server/src/pty/relay.ts` の `PtyRelay` に足す。

```ts
  setTmux(tmux: Tmux | null): void { (this.deps as { tmux: Tmux | null }).tmux = tmux; }
```

- [ ] **Step 4: app.ts を直す**

`packages/server/src/http/app.ts` の import と `AppDeps` を次に置き換え、経路を足す。

```ts
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { newId, type BootstrapDto, type IndexProgressDto, type LaunchParams, type LiveSessionDto, type ResolveAction, type ServerEvent, type SettingsDto, type TerminalApp } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { createMcpApp } from '../mcp/app.ts';
import { candidateDirs, resolveProject } from '../projects/registry.ts';
import { RunError, type RunManager } from '../runs/manager.ts';
import { searchSessions } from '../search/search.ts';
import { readEvents, subagentIds } from '../transcript/read.ts';
import { authMiddleware } from './auth.ts';

export type RunsApi = Pick<RunManager, 'start' | 'resume' | 'fork' | 'kill' | 'openTab' | 'closeTab' | 'listAlive' | 'getRun' | 'getTab'>;
export type ExternalApi = {
  openTerminal(o: { tmuxName: string }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openDirTerminal(o: { dir: string }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openEditor(o: { target: string }): Promise<void>;
};
export type AppDeps = {
  db: Db; deviceId: string; deviceName: string; token: string; home: string; port: number; version: string;
  settings: () => Settings; updateSettings: (patch: Partial<SettingsDto>) => Settings;
  live: () => LiveSessionDto[];
  indexer: { progress(): IndexProgressDto; rebuild(): Promise<void> };
  hub: { broadcast(ev: ServerEvent): void };
  runs: RunsApi;
  external: ExternalApi;
  uiDist?: string;
};

export function toSettingsDto(s: Settings): SettingsDto {
  return { workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir, tmuxPath: s.tmuxPath, terminalApp: s.terminalApp, codePath: s.codePath };
}

const TERMINAL_APPS = new Set<string>(['terminal', 'iterm']);

/** RunError は status 付きで返し、それ以外は投げ直す。 */
function runResult<T>(c: Context, fn: () => T, status: 200 | 201 = 200) {
  try { return c.json(fn() as object, status); }
  catch (e) { if (e instanceof RunError) return c.json({ error: e.message }, e.status); throw e; }
}
async function externalResult(c: Context, fn: () => Promise<unknown>, empty = false) {
  try { const r = await fn(); return empty ? c.body(null, 204) : c.json(r as object); }
  catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 500); }
}
```

`createApp` の `bootstrap`、`settings` の 2 経路を次に置き換える。

```ts
  api.get('/bootstrap', (c) => {
    const live = deps.live();
    const alive = deps.runs.listAlive();
    const body: BootstrapDto = { device: { id: deviceId, name: deps.deviceName }, settings: toSettingsDto(deps.settings()), projects: listProjects(db, deviceId, live), sessions: listSessions(db, live), live, runs: alive.runs, tabs: alive.tabs, index: deps.indexer.progress(), version: deps.version };
    return c.json(body);
  });

  api.get('/settings', (c) => c.json(toSettingsDto(deps.settings())));
  api.patch('/settings', async (c) => {
    const patch = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const clean: Partial<SettingsDto> = {};
    if (patch.workspaceRoot !== undefined) { if (typeof patch.workspaceRoot !== 'string') return c.json({ error: 'workspaceRoot' }, 400); clean.workspaceRoot = patch.workspaceRoot; }
    if (patch.claudeDir !== undefined) { if (typeof patch.claudeDir !== 'string') return c.json({ error: 'claudeDir' }, 400); clean.claudeDir = patch.claudeDir; }
    if (patch.terminalApp !== undefined) { if (typeof patch.terminalApp !== 'string' || !TERMINAL_APPS.has(patch.terminalApp)) return c.json({ error: 'terminalApp は terminal か iterm' }, 400); clean.terminalApp = patch.terminalApp as TerminalApp; }
    for (const k of ['tmuxPath', 'codePath'] as const) {
      if (patch[k] === undefined) continue;
      if (patch[k] !== null && typeof patch[k] !== 'string') return c.json({ error: `${k} は文字列か null` }, 400);
      clean[k] = (patch[k] as string | null) || null;
    }
    const s = deps.updateSettings(clean);
    deps.hub.broadcast({ type: 'toast', level: 'info', message: '設定を保存しました' });
    return c.json(toSettingsDto(s));
  });
```

`api.post('/index/rebuild', ...)` の後に足す。

```ts
  api.get('/runs', (c) => c.json(deps.runs.listAlive()));
  api.post('/runs', async (c) => {
    const params = (await c.req.json().catch(() => null)) as LaunchParams | null;
    if (!params || typeof params !== 'object') return c.json({ error: '本文が JSON ではありません' }, 400);
    return runResult(c, () => deps.runs.start(params), 201);
  });
  api.delete('/runs/:id', (c) => runResult(c, () => deps.runs.kill(c.req.param('id'))));
  api.post('/runs/:id/tabs', (c) => runResult(c, () => deps.runs.openTab(c.req.param('id')), 201));
  api.delete('/runs/:id/tabs/:tabId', (c) => runResult(c, () => deps.runs.closeTab(c.req.param('tabId'))));
  api.post('/runs/:id/open-terminal', async (c) => {
    const run = deps.runs.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'run が見つかりません' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { tabId?: string };
    let tmuxName = run.tmuxName;
    if (body.tabId) { const t = deps.runs.getTab(body.tabId); if (!t || t.runId !== run.id) return c.json({ error: 'タブが見つかりません' }, 404); tmuxName = t.tmuxName; }
    return externalResult(c, () => deps.external.openTerminal({ tmuxName }));
  });
  api.post('/sessions/:id/resume', (c) => runResult(c, () => deps.runs.resume(c.req.param('id')), 201));
  api.post('/sessions/:id/fork', (c) => runResult(c, () => deps.runs.fork(c.req.param('id')), 201));
  api.post('/sessions/:id/open-editor', (c) => {
    const s = getSession(db, deps.live(), c.req.param('id'));
    if (!s) return c.json({ error: 'not found' }, 404);
    return externalResult(c, () => deps.external.openEditor({ target: s.cwd }), true);
  });
  api.post('/projects', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; path?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const dir = typeof body.path === 'string' ? body.path : '';
    if (!name) return c.json({ error: 'name は必須です' }, 400);
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return c.json({ error: 'path が存在するディレクトリではありません' }, 400);
    const id = newId();
    upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0 }, deviceId);
    upsertShared(db, 'project_roots', { id: newId(), project_id: id, device_id: deviceId, path: dir, resolved: 1 }, deviceId);
    const p = getProject(db, deviceId, deps.live(), id)!;
    deps.hub.broadcast({ type: 'project.upsert', project: p });
    return c.json(p, 201);
  });
  api.post('/projects/:id/open-editor', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    if (!p || !p.path) return c.json({ error: 'not found' }, 404);
    return externalResult(c, () => deps.external.openEditor({ target: p.path! }), true);
  });
  api.post('/projects/:id/open-terminal', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    if (!p || !p.path) return c.json({ error: 'not found' }, 404);
    return externalResult(c, () => deps.external.openDirTerminal({ dir: p.path! }));
  });

  app.route('/api', api);
  app.route('/mcp', createMcpApp({ db, deviceId, port: deps.port, token: deps.token, live: deps.live, runs: deps.runs, hub: deps.hub }));
```

既存の `app.route('/api', api);` はこの位置に移す（二重に書かない）。

- [ ] **Step 5: server.ts を直す**

`packages/server/src/server.ts` を次に置き換える。

```ts
import { serve } from '@hono/node-server';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultClaudeDir, dbPath, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings, type Settings } from './config/paths.ts';
import { resolveToolPaths } from './config/tools.ts';
import { openDb } from './db/open.ts';
import { getSession, listProjects } from './db/queries.ts';
import { openDirInTerminalApp, openInEditor, openInTerminalApp } from './external/open.ts';
import { createApp, type ExternalApi } from './http/app.ts';
import { IndexerService } from './indexer/service.ts';
import { ensureWrapperScript } from './launch/wrapper.ts';
import { assignSessions, checkProjectRoots, syncProjectsFromWorkspace } from './projects/registry.ts';
import { RegistryWatcher } from './provider/claude-code/registry.ts';
import { ensureSpawnHelper } from './pty/helper.ts';
import { nodePtySpawn } from './pty/nodePty.ts';
import { PtyRelay } from './pty/relay.ts';
import { RunManager } from './runs/manager.ts';
import { Tmux } from './tmux/tmux.ts';
import { EventHub } from './ws/hub.ts';

export const VERSION = '0.2.0';

export async function startServer(opts: { port?: number; host?: string; home?: string; uiDist?: string } = {}): Promise<{ close(): Promise<void>; port: number }> {
  const home = opts.home ?? hangarHome();
  ensureHome(home);
  const token = readOrCreateToken(home);
  const device = readOrCreateDevice(home);
  let settings: Settings = resolveToolPaths(loadSettings(home));
  saveSettings(home, settings);
  ensureWrapperScript(home);
  const fixed = ensureSpawnHelper();
  if (fixed.length) console.log('[pty] spawn-helper に実行権限を付けました:', fixed.join(', '));
  const port = opts.port ?? 4177;
  const host = opts.host ?? '127.0.0.1';

  const db = openDb(dbPath(home));
  const hub = new EventHub(VERSION);
  const registry = new RegistryWatcher(settings.claudeDir || defaultClaudeDir());
  const indexer = new IndexerService({ db, deviceId: device.id, claudeDir: settings.claudeDir, isRunning: (id) => registry.current().some((l) => l.sessionId === id) });
  const tmuxOf = (s: Settings) => (s.tmuxPath ? new Tmux({ tmuxPath: s.tmuxPath }) : null);
  const runs = new RunManager({ db, deviceId: device.id, home, tmux: tmuxOf(settings), claudeBin: process.env.HANGAR_CLAUDE_BIN ?? 'claude', port, token, isLive: (u) => registry.current().some((l) => l.sessionId === u) });
  const relay = new PtyRelay({ token, tmux: tmuxOf(settings), resolveTab: (id) => runs.getTab(id)?.tmuxName ?? null, spawn: nodePtySpawn });

  indexer.on({
    progress: (p) => hub.broadcast({ type: 'index.progress', progress: p }),
    sessionChanged: (e) => { const s = getSession(db, registry.current(), e.sessionId); if (s) { hub.broadcast({ type: 'session.upsert', session: s }); if (e.appended > 0) hub.broadcast({ type: 'transcript.appended', sessionId: e.sessionId, count: e.appended }); } },
    error: (e) => console.error('[indexer]', e.path, e.message),
  });
  registry.onChange((live) => {
    hub.broadcast({ type: 'live.update', live });
    for (const p of listProjects(db, device.id, live)) hub.broadcast({ type: 'project.upsert', project: p });
    runs.linkRegistry(live);
  });
  runs.on({
    runStarted: (r) => { hub.broadcast({ type: 'run.started', run: r.run, tabs: r.tabs }); const s = getSession(db, registry.current(), r.sessionId); if (s) hub.broadcast({ type: 'session.upsert', session: s }); },
    runUpdated: (run) => hub.broadcast({ type: 'run.upsert', run }),
    runEnded: (run) => hub.broadcast({ type: 'run.ended', run }),
    tabChanged: (tab) => hub.broadcast({ type: 'tab.upsert', tab }),
  });

  const external: ExternalApi = {
    openTerminal: async ({ tmuxName }) => { if (!settings.tmuxPath) throw new Error('tmux が見つかりません'); return openInTerminalApp({ home, tmuxPath: settings.tmuxPath, tmuxName, app: settings.terminalApp }); },
    openDirTerminal: ({ dir }) => openDirInTerminalApp({ home, dir, app: settings.terminalApp }),
    openEditor: ({ target }) => openInEditor({ codePath: settings.codePath, target }),
  };

  const uiDist = opts.uiDist ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
  const app = createApp({
    db, deviceId: device.id, deviceName: device.name, token, home, port, version: VERSION,
    settings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch };
      saveSettings(home, settings);
      const t = tmuxOf(settings);
      runs.setTmux(t); relay.setTmux(t);
      return settings;
    },
    live: () => registry.current(), indexer, hub, runs, external, uiDist,
  });

  const server = await new Promise<http.Server>((resolve) => { const s = serve({ fetch: app.fetch, port, hostname: host }, () => resolve(s as http.Server)); });
  hub.attach(server, { path: '/ws', token });
  relay.attach(server, '/ws/pty');

  registry.start();
  await indexer.start();
  syncProjectsFromWorkspace(db, device.id, settings.workspaceRoot);
  assignSessions(db, device.id);
  const roots = checkProjectRoots(db, device.id);
  for (const id of roots.unresolved) hub.broadcast({ type: 'project.unresolved', projectId: id });
  setInterval(() => { for (const id of checkProjectRoots(db, device.id).unresolved) hub.broadcast({ type: 'project.unresolved', projectId: id }); }, 30_000).unref();
  const lost = runs.recoverAtStartup();
  if (lost.length) console.log(`[runs] tmux セッションの無い run を ${lost.length} 件 lost で閉じました`);
  runs.startPolling(2000);

  console.log(`agent-hangar listening on http://${host}:${port}${settings.tmuxPath ? '' : '（tmux が見つからないため起動は使えません）'}`);
  return {
    port,
    close: async () => { runs.stop(); relay.close(); indexer.stop(); registry.stop(); hub.close(); await new Promise<void>((r) => server.close(() => r())); db.close(); },
  };
}
```

- [ ] **Step 6: テストと型検査**

Run: `npx vitest run packages/server && npm run typecheck`
Expected: server は PASS。`typecheck` は ui の `BootstrapDto`（`runs`、`tabs`）の箇所だけ残る（Task 16 で直す）。

- [ ] **Step 7: 実物でサーバを起動する（Claude は起動しない）**

Run: `HANGAR_HOME=/tmp/hangar-smoke HANGAR_PORT=4199 npx tsx packages/server/src/main.ts & sleep 8; curl -s -H "Authorization: Bearer $(cat /tmp/hangar-smoke/token)" http://127.0.0.1:4199/api/runs; echo; cat /tmp/hangar-smoke/settings.json; ls -la /tmp/hangar-smoke/bin; kill %1; rm -rf /tmp/hangar-smoke`
Expected: `{"runs":[],"tabs":[]}` が返り、`settings.json` に `tmuxPath` が `/opt/homebrew/bin/tmux` のような絶対パスで入り、`bin/hangar-run.sh` が `-rwxr-xr-x` で出来ている。ログに spawn-helper を直した旨が出ることがある。

- [ ] **Step 8: コミット**

```bash
git add packages/server/src
git commit -m "feat(server): run, tab, resume, fork, external open and mcp routes wired into the server"
```

---

### Task 15: CLI の hangar mcp install

**Files:**
- Create: `packages/cli/src/mcp.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/src/mcp.test.ts`

**Interfaces:**
- Consumes: `ensureHome`、`readOrCreateToken`（`@agent-hangar/server`）。
- Produces:
  ```ts
  export type CliExec = (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string };
  export function mcpAddArgs(o: { port: number; token: string }): string[];   // ['mcp','add','--scope','user','--transport','http','hangar','http://127.0.0.1:<port>/mcp','--header','Authorization: Bearer <token>']
  export function mcpRemoveArgs(): string[];                                 // ['mcp','remove','--scope','user','hangar']
  export function runMcpInstall(o: { home: string; port: number; exec?: CliExec }): { ok: boolean; message: string };
  export function runMcpUninstall(o: { exec?: CliExec }): { ok: boolean; message: string };
  ```
- `--header` は可変長オプションで後ろの位置引数を飲み込むので、名前と URL を先に、`--header` を最後に置く。メッセージにトークンを含めない。

- [ ] **Step 1: 失敗するテストを書く**

`packages/cli/src/mcp.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mcpAddArgs, mcpRemoveArgs, runMcpInstall, runMcpUninstall } from './mcp.ts';

describe('mcpAddArgs', () => {
  it('名前と URL を先に、--header を最後に置く', () => {
    const a = mcpAddArgs({ port: 4177, token: 'tok' });
    expect(a).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'hangar', 'http://127.0.0.1:4177/mcp', '--header', 'Authorization: Bearer tok']);
    expect(a.indexOf('--header')).toBe(a.length - 2);
    expect(mcpRemoveArgs()).toEqual(['mcp', 'remove', '--scope', 'user', 'hangar']);
  });
});

describe('runMcpInstall', () => {
  it('claude mcp add を呼び、成功と失敗を報告する。メッセージにトークンを出さない', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-'));
    const calls: string[][] = [];
    const ok = runMcpInstall({ home, port: 4177, exec: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: 'Added', stderr: '' }; } });
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    expect(calls[0]![0]).toBe('claude');
    expect(calls[0]!.at(-1)).toBe(`Authorization: Bearer ${token}`);
    expect(ok.ok).toBe(true);
    expect(ok.message).not.toContain(token);
    const ng = runMcpInstall({ home, port: 4177, exec: () => ({ status: 1, stdout: '', stderr: 'claude: command not found' }) });
    expect(ng).toEqual({ ok: false, message: 'claude mcp add に失敗しました: claude: command not found' });
    expect(runMcpUninstall({ exec: () => ({ status: 0, stdout: '', stderr: '' }) }).ok).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/cli`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/cli/src/mcp.ts`：

```ts
import { spawnSync } from 'node:child_process';
import { ensureHome, readOrCreateToken } from '@agent-hangar/server';

export type CliExec = (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string };

const defaultExec: CliExec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
};

/** `--header` は可変長オプションなので、名前と URL の位置引数を先に置く（フェーズ 0 で確認）。 */
export function mcpAddArgs(o: { port: number; token: string }): string[] {
  return ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'hangar', `http://127.0.0.1:${o.port}/mcp`, '--header', `Authorization: Bearer ${o.token}`];
}

export function mcpRemoveArgs(): string[] {
  return ['mcp', 'remove', '--scope', 'user', 'hangar'];
}

/** ~/.claude.json は hangar が直接書かず、claude mcp add に任せる。 */
export function runMcpInstall(o: { home: string; port: number; exec?: CliExec }): { ok: boolean; message: string } {
  ensureHome(o.home);
  const token = readOrCreateToken(o.home);
  const r = (o.exec ?? defaultExec)('claude', mcpAddArgs({ port: o.port, token }));
  if (r.status === 0) return { ok: true, message: 'user スコープに MCP サーバ hangar を登録しました。claude mcp list で Connected を確認できます。' };
  return { ok: false, message: `claude mcp add に失敗しました: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`}` };
}

export function runMcpUninstall(o: { exec?: CliExec } = {}): { ok: boolean; message: string } {
  const r = (o.exec ?? defaultExec)('claude', mcpRemoveArgs());
  if (r.status === 0) return { ok: true, message: 'user スコープの MCP サーバ hangar を削除しました。' };
  return { ok: false, message: `claude mcp remove に失敗しました: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`}` };
}
```

`packages/cli/src/index.ts` に `mcp` コマンドを足す（`program.parseAsync` の前）。

```ts
import { runMcpInstall, runMcpUninstall } from './mcp.ts';

const mcp = program.command('mcp').description('Claude Code への MCP 登録');
mcp.command('install').option('--port <n>', 'ポート', '4177').description('user スコープに hangar を登録する').action((o: { port: string }) => {
  const r = runMcpInstall({ home: hangarHome(), port: Number(o.port) });
  console.log(r.message);
  if (!r.ok) process.exitCode = 1;
});
mcp.command('uninstall').description('user スコープの hangar を削除する').action(() => {
  const r = runMcpUninstall();
  console.log(r.message);
  if (!r.ok) process.exitCode = 1;
});
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/cli && npx tsc -p packages/cli`
Expected: PASS（2 件）

- [ ] **Step 5: コミット**

```bash
git add packages/cli
git commit -m "feat(cli): hangar mcp install and uninstall via claude mcp add"
```

---

### Task 16: UI のストアと API クライアントの拡張

**Files:**
- Modify: `packages/ui/src/store/store.ts`、`packages/ui/src/runtime/api.ts`
- Test: `packages/ui/src/store/store.test.ts`（追加）、`packages/ui/src/runtime/api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // store/store.ts
  export type Store = { ...フェーズ 1...; runs: Record<string, RunDto>; tabs: Record<string, TabDto> };
  export function applyLaunch(store: Store, r: LaunchResultDto): Store;          // run.started と同じ
  export function aliveRunOf(store: Store, sessionId: string): RunDto | null;     // endedAt が null の最新
  export function currentRunOf(store: Store, sessionId: string): RunDto | null;   // 生きた run。無ければ開いたシェルタブが残る最新の run
  export function tabsOf(store: Store, runId: string): TabDto[];                   // 閉じていないもの。agent を先頭に createdAt 順
  // runtime/api.ts（ApiClient に追加）
  launch(params: LaunchParams): Promise<LaunchResultDto>;              // POST /api/runs
  resume(sessionId: string): Promise<LaunchResultDto>;                 // POST /api/sessions/:id/resume
  fork(sessionId: string): Promise<LaunchResultDto>;                   // POST /api/sessions/:id/fork
  killRun(runId: string): Promise<RunDto>;                             // DELETE /api/runs/:id
  openTab(runId: string): Promise<TabDto>;                             // POST /api/runs/:id/tabs
  closeTab(runId: string, tabId: string): Promise<TabDto>;             // DELETE /api/runs/:id/tabs/:tabId
  openTerminalApp(runId: string, tabId: string | null): Promise<{ app: TerminalApp; fellBack: boolean }>;   // POST /api/runs/:id/open-terminal
  openEditor(sessionId: string): Promise<void>;                        // POST /api/sessions/:id/open-editor
  projectOpenEditor(projectId: string): Promise<void>;                 // POST /api/projects/:id/open-editor
  projectOpenTerminal(projectId: string): Promise<{ app: TerminalApp; fellBack: boolean }>;   // POST /api/projects/:id/open-terminal
  createProject(name: string, path: string): Promise<ProjectDto>;      // POST /api/projects
  ```
- `applyServerEvent` は `run.started`（run と tabs を入れる）、`run.upsert` と `run.ended`（run を差し替える）、`tab.upsert`（tab を差し替える）を扱う。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/store/store.test.ts` に足す。

```ts
import type { RunDto, TabDto } from '@agent-hangar/shared';
import { aliveRunOf, applyLaunch, currentRunOf, tabsOf } from './store.ts';

const run = (id: string, sessionId: string, endedAt: number | null = null): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: null, startedAt: Number(id.slice(1)), endedAt, endReason: endedAt ? 'exited' : null, heartbeatAt: 1 });
const tab = (id: string, runId: string, kind: 'agent' | 'shell', closedAt: number | null = null): TabDto => ({ id, runId, sessionId: 's1', kind, title: kind === 'agent' ? 'Claude' : id, tmuxName: `hangar-${runId}-${id}`, createdAt: Number(id.replace(/\D/g, '') || 0), closedAt });

describe('runs と tabs', () => {
  it('run.started は run と tabs を入れ、tab.upsert と run.ended は差し替える', () => {
    let s = initialStore();
    s = applyServerEvent(s, { type: 'run.started', run: run('r1', 's1'), tabs: [tab('r1', 'r1', 'agent')] });
    expect(aliveRunOf(s, 's1')?.id).toBe('r1');
    s = applyServerEvent(s, { type: 'tab.upsert', tab: tab('t2', 'r1', 'shell') });
    s = applyServerEvent(s, { type: 'tab.upsert', tab: tab('t1', 'r1', 'shell') });
    expect(tabsOf(s, 'r1').map((t) => t.id)).toEqual(['r1', 't1', 't2']);
    s = applyServerEvent(s, { type: 'tab.upsert', tab: tab('t1', 'r1', 'shell', 5) });
    expect(tabsOf(s, 'r1').map((t) => t.id)).toEqual(['r1', 't2']);
    s = applyServerEvent(s, { type: 'run.ended', run: run('r1', 's1', 9) });
    expect(aliveRunOf(s, 's1')).toBeNull();
    expect(currentRunOf(s, 's1')?.id).toBe('r1');   // シェルタブが残っている
    s = applyServerEvent(s, { type: 'tab.upsert', tab: tab('t2', 'r1', 'shell', 6) });
    expect(currentRunOf(s, 's1')).toBeNull();
  });
  it('applyLaunch と最新の run', () => {
    let s = applyLaunch(initialStore(), { run: run('r1', 's1', 3), sessionId: 's1', tabs: [] });
    s = applyLaunch(s, { run: run('r2', 's1'), sessionId: 's1', tabs: [tab('r2', 'r2', 'agent')] });
    expect(aliveRunOf(s, 's1')?.id).toBe('r2');
    expect(applyServerEvent(s, { type: 'run.upsert', run: { ...run('r2', 's1'), pid: 7 } }).runs.r2?.pid).toBe(7);
  });
});
```

`packages/ui/src/runtime/api.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createApi } from './api.ts';

function harness(status = 200, body: unknown = { ok: true }) {
  const calls: { url: string; method: string; body: string | undefined }[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { api: createApi(fetchFn), calls };
}

describe('createApi（フェーズ 2）', () => {
  it('経路とメソッドと本文', async () => {
    const { api, calls } = harness();
    await api.launch({ projectId: 'p1', name: 'n' });
    await api.resume('s1'); await api.fork('s1'); await api.killRun('r1'); await api.openTab('r1'); await api.closeTab('r1', 't1');
    await api.openTerminalApp('r1', 't1'); await api.openTerminalApp('r1', null);
    await api.projectOpenTerminal('p1'); await api.createProject('beta', '/w/beta');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/runs', 'POST /api/sessions/s1/resume', 'POST /api/sessions/s1/fork', 'DELETE /api/runs/r1', 'POST /api/runs/r1/tabs', 'DELETE /api/runs/r1/tabs/t1',
      'POST /api/runs/r1/open-terminal', 'POST /api/runs/r1/open-terminal', 'POST /api/projects/p1/open-terminal', 'POST /api/projects',
    ]);
    expect(calls[0]!.body).toBe('{"projectId":"p1","name":"n"}');
    expect(calls[6]!.body).toBe('{"tabId":"t1"}');
    expect(calls[7]!.body).toBe('{}');
    expect(calls[9]!.body).toBe('{"name":"beta","path":"/w/beta"}');
  });
  it('204 は undefined、失敗は status と経路のエラー', async () => {
    const ok = harness(204);
    expect(await ok.api.openEditor('s1')).toBeUndefined();
    expect(await ok.api.projectOpenEditor('p1')).toBeUndefined();
    const ng = harness(409, { error: '実行中です' });
    await expect(ng.api.resume('s1')).rejects.toThrow('実行中です');
  });
});
```

フェーズ 1 の `call` は失敗時に `${status} ${path}` を投げていた。
フェーズ 2 からはサーバの `{ error }` を優先して投げ、無ければ従来の形にする（UI のトーストに「実行中です」のような理由が出るようにするため）。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/store packages/ui/src/runtime/api`
Expected: FAIL

- [ ] **Step 3: ストアを直す**

`packages/ui/src/store/store.ts` の `Store`、`initialStore`、`applyBootstrap`、`applyServerEvent` を次に置き換え、末尾に 4 関数を足す。

```ts
import type { BootstrapDto, EventsPageDto, IndexProgressDto, LaunchResultDto, LiveSessionDto, ProjectDto, RunDto, SearchParamsDto, SearchResultDto, ServerEvent, SessionDto, SettingsDto, TabDto, TranscriptEvent } from '@agent-hangar/shared';

export type Store = {
  bootstrapped: boolean; version: string; device: { id: string; name: string } | null; settings: SettingsDto | null;
  projects: Record<string, ProjectDto>; sessions: Record<string, SessionDto>; live: LiveSessionDto[];
  runs: Record<string, RunDto>; tabs: Record<string, TabDto>;
  events: Record<string, EventsSlice>; subagents: Record<string, string[]>;
  search: { params: SearchParamsDto | null; result: SearchResultDto | null; loading: boolean };
  index: IndexProgressDto;
};

export function initialStore(): Store {
  return { bootstrapped: false, version: '', device: null, settings: null, projects: {}, sessions: {}, live: [], runs: {}, tabs: {}, events: {}, subagents: {}, search: { params: null, result: null, loading: false }, index: { phase: 'idle', done: 0, total: 0 } };
}

export function applyBootstrap(store: Store, b: BootstrapDto): Store {
  return { ...store, bootstrapped: true, version: b.version, device: b.device, settings: b.settings, projects: byId(b.projects), sessions: byId(b.sessions), live: b.live, runs: byId(b.runs), tabs: byId(b.tabs), index: b.index };
}

export function applyServerEvent(store: Store, ev: ServerEvent): Store {
  switch (ev.type) {
    case 'ready': return { ...store, version: ev.version };
    case 'project.upsert': return { ...store, projects: { ...store.projects, [ev.project.id]: ev.project } };
    case 'session.upsert': return { ...store, sessions: { ...store.sessions, [ev.session.id]: ev.session } };
    case 'live.update': return { ...store, live: ev.live, sessions: relive(store.sessions, ev.live) };
    case 'index.progress': return { ...store, index: ev.progress };
    case 'run.started': return applyLaunch(store, { run: ev.run, sessionId: ev.run.sessionId, tabs: ev.tabs });
    case 'run.upsert': case 'run.ended': return { ...store, runs: { ...store.runs, [ev.run.id]: ev.run } };
    case 'tab.upsert': return { ...store, tabs: { ...store.tabs, [ev.tab.id]: ev.tab } };
    case 'transcript.appended': {
      const out = { ...store.events };
      let touched = false;
      for (const [k, v] of Object.entries(store.events)) if (k.startsWith(ev.sessionId + ':')) { out[k] = { ...v, total: v.total + ev.count }; touched = true; }
      return touched ? { ...store, events: out } : store;
    }
    default: return store;
  }
}

export function applyLaunch(store: Store, r: LaunchResultDto): Store {
  return { ...store, runs: { ...store.runs, [r.run.id]: r.run }, tabs: { ...store.tabs, ...byId(r.tabs) } };
}

const newest = (runs: RunDto[]): RunDto | null => runs.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

export function aliveRunOf(store: Store, sessionId: string): RunDto | null {
  return newest(Object.values(store.runs).filter((r) => r.sessionId === sessionId && r.endedAt === null));
}

/** 生きた run があればそれ。無ければ、開いたシェルタブが残っている最新の run。 */
export function currentRunOf(store: Store, sessionId: string): RunDto | null {
  const alive = aliveRunOf(store, sessionId);
  if (alive) return alive;
  const withTabs = Object.values(store.runs).filter((r) => r.sessionId === sessionId && tabsOf(store, r.id).some((t) => t.kind === 'shell'));
  return newest(withTabs);
}

export function tabsOf(store: Store, runId: string): TabDto[] {
  return Object.values(store.tabs).filter((t) => t.runId === runId && t.closedAt === null).sort((a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === 'agent' ? -1 : 1));
}
```

- [ ] **Step 4: API クライアントを直す**

`packages/ui/src/runtime/api.ts` を次に置き換える。

```ts
import type { BootstrapDto, EventsPageDto, LaunchParams, LaunchResultDto, ProjectDto, ProjectStatus, ResolveAction, RunDto, SearchParamsDto, SearchResultDto, SettingsDto, TabDto, TerminalApp } from '@agent-hangar/shared';

export type ApiClient = {
  bootstrap(): Promise<BootstrapDto>;
  events(sessionId: string, fromSeq: number, agentId: string | null): Promise<EventsPageDto>;
  subagents(sessionId: string): Promise<string[]>;
  search(params: SearchParamsDto): Promise<SearchResultDto>;
  setProjectStatus(id: string, status: ProjectStatus): Promise<ProjectDto>;
  resolveProject(id: string, action: ResolveAction): Promise<unknown>;
  candidates(id: string, name: string): Promise<string[]>;
  updateSettings(patch: Partial<SettingsDto>): Promise<SettingsDto>;
  rebuildIndex(): Promise<void>;
  launch(params: LaunchParams): Promise<LaunchResultDto>;
  resume(sessionId: string): Promise<LaunchResultDto>;
  fork(sessionId: string): Promise<LaunchResultDto>;
  killRun(runId: string): Promise<RunDto>;
  openTab(runId: string): Promise<TabDto>;
  closeTab(runId: string, tabId: string): Promise<TabDto>;
  openTerminalApp(runId: string, tabId: string | null): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openEditor(sessionId: string): Promise<void>;
  projectOpenEditor(projectId: string): Promise<void>;
  projectOpenTerminal(projectId: string): Promise<{ app: TerminalApp; fellBack: boolean }>;
  createProject(name: string, path: string): Promise<ProjectDto>;
};

export function createApi(fetchFn: typeof fetch = (...a) => fetch(...a)): ApiClient {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetchFn(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    if (!r.ok) {
      // サーバが { error } を返せばその理由を、無ければ状態番号と経路を投げる。
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `${r.status} ${path}`);
    }
    if (r.status === 202 || r.status === 204) return undefined as T;
    return (await r.json()) as T;
  }
  const qs = (o: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
  const post = <T>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    bootstrap: () => call('/api/bootstrap'),
    events: (sessionId, fromSeq, agentId) => call(`/api/sessions/${sessionId}/events${qs({ fromSeq, agentId })}`),
    subagents: (sessionId) => call(`/api/sessions/${sessionId}/subagents`),
    search: (params) => call(`/api/search${qs(params)}`),
    setProjectStatus: (id, status) => call(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    resolveProject: (id, action) => post(`/api/projects/${id}/resolve`, action),
    candidates: (id, name) => call(`/api/projects/${id}/candidates${qs({ name })}`),
    updateSettings: (patch) => call('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    rebuildIndex: () => post('/api/index/rebuild'),
    launch: (params) => post('/api/runs', params),
    resume: (sessionId) => post(`/api/sessions/${sessionId}/resume`),
    fork: (sessionId) => post(`/api/sessions/${sessionId}/fork`),
    killRun: (runId) => call(`/api/runs/${runId}`, { method: 'DELETE' }),
    openTab: (runId) => post(`/api/runs/${runId}/tabs`),
    closeTab: (runId, tabId) => call(`/api/runs/${runId}/tabs/${tabId}`, { method: 'DELETE' }),
    openTerminalApp: (runId, tabId) => post(`/api/runs/${runId}/open-terminal`, tabId ? { tabId } : {}),
    openEditor: (sessionId) => post(`/api/sessions/${sessionId}/open-editor`),
    projectOpenEditor: (projectId) => post(`/api/projects/${projectId}/open-editor`),
    projectOpenTerminal: (projectId) => post(`/api/projects/${projectId}/open-terminal`),
    createProject: (name, path) => post('/api/projects', { name, path }),
  };
}
```

フェーズ 1 の `runtime.test.ts` と `Root.test.tsx` が組み立てている `ApiClient` の偽物に、新しいメソッドを足す。
`vi.fn(async () => { throw new Error('not used'); })` を 11 個並べるのではなく、次の補助を `packages/ui/src/test/fakeApi.ts` に置いて両方から使う。

```ts
import { vi } from 'vitest';
import type { ApiClient } from '../runtime/api.ts';

/** フェーズ 2 の API の偽物。必要なものだけ上書きする。 */
export function fakeApiExtras(): Pick<ApiClient, 'launch' | 'resume' | 'fork' | 'killRun' | 'openTab' | 'closeTab' | 'openTerminalApp' | 'openEditor' | 'projectOpenEditor' | 'projectOpenTerminal' | 'createProject'> {
  const unused = () => { throw new Error('not used in this test'); };
  return { launch: vi.fn(async () => unused()), resume: vi.fn(async () => unused()), fork: vi.fn(async () => unused()), killRun: vi.fn(async () => unused()), openTab: vi.fn(async () => unused()), closeTab: vi.fn(async () => unused()), openTerminalApp: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })), openEditor: vi.fn(async () => {}), projectOpenEditor: vi.fn(async () => {}), projectOpenTerminal: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })), createProject: vi.fn(async () => unused()) };
}
```

`runtime.test.ts` の `harness` と `Root.test.tsx` の `make` で、`api` の組み立てに `...fakeApiExtras()` を展開する（`...overrides` より前）。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui/src/store packages/ui/src/runtime/api && npx tsc -p packages/ui --noEmit 2>&1 | grep -v 'terminals\|Root\|runtime.ts'`
Expected: PASS。`RuntimeDeps` に `terminals` が無い型エラーは Task 18 で埋める。

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/store packages/ui/src/runtime/api.ts packages/ui/src/runtime/api.test.ts packages/ui/src/test/fakeApi.ts packages/ui/src/runtime/runtime.test.ts packages/ui/src/Root.test.tsx
git commit -m "feat(ui): runs and tabs in the store, api client for launch, tabs and external open"
```

---

### Task 17: Mediator（launch 領域、タブと接続、waiting トースト）

**Files:**
- Create: `packages/ui/src/mediator/launch.ts`、`packages/ui/src/mediator/live.ts`
- Modify: `packages/ui/src/mediator/types.ts`、`packages/ui/src/mediator/screen.ts`、`packages/ui/src/mediator/sessionView.ts`、`packages/ui/src/mediator/transition.ts`
- Test: `packages/ui/src/mediator/transition.test.ts`（追加と 2 箇所の修正）

**Interfaces:**
- Produces: 「インターフェース一覧」の `RuntimeEvent`、`Effect`、`Overlay`、`LaunchState`、`SessionViewState`、`State` の拡張と、`launchStep`、`liveStep`。
- 主要な遷移：

| 現在 | 入力 | 次 | 効果 |
| --- | --- | --- | --- |
| `overlay: none` | `session.new.open(projectId)` | `overlay: newSession(projectId)`、`launch: idle` | `focus(newSessionName)` |
| 任意 | `session.new.open(scratch)` | 変化なし | `toast(NOT_YET)` |
| `launch: idle` | `session.new.submit(params)` | `launch: submitting` | `api.launch(params)`。`projectId` が無ければ `failed('プロジェクトを選んでください')` |
| `launch: submitting` | `session.new.submit` | 変化なし | なし（二重送信を防ぐ） |
| `launch: submitting` | `runtime launch.done(sessionId)` | `launch: idle`、`overlay: none` | `navigate(session(id))` |
| `launch: submitting` | `runtime launch.failed(msg)` | `launch: failed(msg)` | `toast(error)` |
| `overlay: newSession` | `overlay.close` | `overlay: none`、`launch: idle` | なし |
| 任意 | `session.resume(id)` / `session.fork(id)` | `launch: submitting` | `api.resume` / `api.fork` |
| 任意 | `session.kill(runId)` | 変化なし | `api.killRun` |
| 任意 | `session.openTerminalApp(runId, tabId?)` | 変化なし | `api.openTerminalApp(runId, tabId ?? null)` |
| 任意 | `session.openEditor` / `project.openEditor` / `project.openTerminalApp` | 変化なし | 対応する `api.*` |
| 任意 | `runtime hash.changed(session(id))` | `screen = session(id)` | `api.loadEvents(id, 0)`、`terminal.connect(id, null)` |
| `session(id)` | `tab.open(id, shell)` | 変化なし | `api.openTab(id)` |
| `session(id)` | `tab.select(tabId)` | `sessionView[id].selectedTab = tabId` | `storage.save`、`terminal.connect(id, tabId)`、`focus(terminal)` |
| `session(id)` | `tab.close(tabId)` | 選択中なら `selectedTab = null` | `api.closeTab(tabId)` |
| `session(id)` | `transcript.toggle` | `transcriptOpen` 反転 | `storage.save` |
| `session(id)` | `server run.started(run)`（同じセッション） | `selectedTab = null` | `terminal.connect(id, run.id)` |
| 任意 | `server run.ended(run)` | 変化なし | `terminal.disconnect(run.id)` |
| `session(id)` | `server tab.upsert(tab)`（開いたシェル） | `selectedTab = tab.id` | `terminal.connect(id, tab.id)`、`focus(terminal)` |
| 任意 | `server tab.upsert(tab)`（閉じた） | 選択中なら `selectedTab = null` | `terminal.disconnect(tab.id)`、選択中だったら `terminal.connect(id, null)` |
| 任意 | `server live.update(live)` | `waitingSeen` を waiting の ID 列に | 新たに waiting になったものごとに `toast` |
| 任意 | `settings.update({ terminalApp: 'iterm' })` | 変化なし | `api.updateSettings`、`toast('初回に macOS の自動化の許可ダイアログが出ます')` |

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/mediator/transition.test.ts` の 2 箇所を直す。
「session 画面に入ると本文の先頭ページを読む」の期待を `[{ kind: 'api.loadEvents', sessionId: 's1', fromSeq: 0 }, { kind: 'terminal.connect', sessionId: 's1', tabId: null }]` にする。
「次のフェーズの操作はトーストで知らせる」の Intent を `session.promote.open` と `split.toggle` に変える。

```ts
  it('次のフェーズの操作はトーストで知らせる', () => {
    const { state, effects } = run([intent({ type: 'session.promote.open', id: 's1' }), intent({ type: 'split.toggle' })]);
    expect(effects).toEqual([{ kind: 'toast', level: 'info', message: 'この操作は次のフェーズで実装します' }, { kind: 'toast', level: 'info', message: 'この操作は次のフェーズで実装します' }]);
    expect(state).toEqual(initialState());
  });
```

次の `describe` を足す。

```ts
const runDto = (id: string, sessionId: string, endedAt: number | null = null) => ({ id, sessionId, deviceId: 'd', kind: 'start' as const, tmuxName: `hangar-${id}`, pid: null, startedAt: 1, endedAt, endReason: null, heartbeatAt: 1 });
const tabDto = (id: string, runId: string, closedAt: number | null = null) => ({ id, runId, sessionId: 's1', kind: 'shell' as const, title: 'シェル 1', tmuxName: `hangar-${runId}-t1`, createdAt: 2, closedAt });
const onSession = (id = 's1') => run([runtime({ type: 'hash.changed', route: { name: 'session', id } })]).state;

describe('起動', () => {
  it('ダイアログを開き、送信で submitting になり、done で画面へ移る', () => {
    const a = run([intent({ type: 'session.new.open', projectId: 'p1' })]);
    expect(a.state.overlay).toEqual({ kind: 'newSession', projectId: 'p1' });
    expect(a.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }]);
    const b = run([intent({ type: 'session.new.submit', params: { projectId: 'p1', name: 'n' } })], a.state);
    expect(b.state.launch).toEqual({ kind: 'submitting' });
    expect(b.effects).toEqual([{ kind: 'api.launch', params: { projectId: 'p1', name: 'n' } }]);
    const dup = run([intent({ type: 'session.new.submit', params: { projectId: 'p1' } })], b.state);
    expect(dup.effects).toEqual([]);
    const c = run([runtime({ type: 'launch.done', sessionId: 's9', runId: 'r9' })], b.state);
    expect(c.state.launch).toEqual({ kind: 'idle' });
    expect(c.state.overlay).toEqual({ kind: 'none' });
    expect(c.effects).toEqual([{ kind: 'navigate', route: { name: 'session', id: 's9' } }]);
  });
  it('失敗はダイアログを開いたまま failed になり、閉じると idle に戻る', () => {
    const a = run([intent({ type: 'session.new.open' }), intent({ type: 'session.new.submit', params: { projectId: 'p1' } }), runtime({ type: 'launch.failed', message: 'tmux が見つかりません' })]);
    expect(a.state.launch).toEqual({ kind: 'failed', message: 'tmux が見つかりません' });
    expect(a.state.overlay).toEqual({ kind: 'newSession', projectId: null });
    expect(a.effects.at(-1)).toEqual({ kind: 'toast', level: 'error', message: 'tmux が見つかりません' });
    const b = run([intent({ type: 'overlay.close' })], a.state);
    expect(b.state).toMatchObject({ overlay: { kind: 'none' }, launch: { kind: 'idle' } });
  });
  it('プロジェクト無しの送信は failed、スクラッチは次のフェーズ', () => {
    expect(run([intent({ type: 'session.new.submit', params: {} })]).state.launch).toEqual({ kind: 'failed', message: 'プロジェクトを選んでください' });
    expect(run([intent({ type: 'session.new.open', scratch: true })]).effects).toEqual([{ kind: 'toast', level: 'info', message: 'この操作は次のフェーズで実装します' }]);
  });
  it('再開、フォーク、停止、外部で開くは API 効果', () => {
    const { state, effects } = run([intent({ type: 'session.resume', id: 's1' }), intent({ type: 'session.fork', id: 's1' }), intent({ type: 'session.kill', runId: 'r1' }), intent({ type: 'session.openTerminalApp', runId: 'r1', tabId: 't1' }), intent({ type: 'session.openTerminalApp', runId: 'r1' }), intent({ type: 'session.openEditor', sessionId: 's1' }), intent({ type: 'project.openEditor', id: 'p1' }), intent({ type: 'project.openTerminalApp', id: 'p1' })]);
    expect(effects).toEqual([
      { kind: 'api.resume', sessionId: 's1' }, { kind: 'api.fork', sessionId: 's1' }, { kind: 'api.killRun', runId: 'r1' },
      { kind: 'api.openTerminalApp', runId: 'r1', tabId: 't1' }, { kind: 'api.openTerminalApp', runId: 'r1', tabId: null },
      { kind: 'api.openEditor', sessionId: 's1' }, { kind: 'api.projectOpenEditor', projectId: 'p1' }, { kind: 'api.projectOpenTerminal', projectId: 'p1' },
    ]);
    expect(state.launch).toEqual({ kind: 'submitting' });
  });
});

describe('タブと接続', () => {
  it('タブの選択と追加と閉じる', () => {
    const s = onSession();
    const a = run([intent({ type: 'tab.select', tabId: 't1' })], s);
    expect(a.state.sessionView.s1?.selectedTab).toBe('t1');
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: a.state.sessionView.s1 }, { kind: 'terminal.connect', sessionId: 's1', tabId: 't1' }, { kind: 'focus', target: 'terminal' }]);
    expect(run([intent({ type: 'tab.open', sessionId: 's1', kind: 'shell' })], s).effects).toEqual([{ kind: 'api.openTab', sessionId: 's1' }]);
    const b = run([intent({ type: 'tab.close', tabId: 't1' })], a.state);
    expect(b.state.sessionView.s1?.selectedTab).toBeNull();
    expect(b.effects.at(-1)).toEqual({ kind: 'api.closeTab', tabId: 't1' });
    expect(run([intent({ type: 'tab.select', tabId: 't1' })]).effects).toEqual([]);   // セッション画面の外では無視
  });
  it('run の開始と終了、タブの出現と消失', () => {
    const s = onSession();
    const a = run([server({ type: 'run.started', run: runDto('r1', 's1'), tabs: [] })], s);
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: a.state.sessionView.s1 }, { kind: 'terminal.connect', sessionId: 's1', tabId: 'r1' }]);
    expect(run([server({ type: 'run.started', run: runDto('r2', 's2'), tabs: [] })], s).effects).toEqual([]);
    const b = run([server({ type: 'tab.upsert', tab: tabDto('t1', 'r1') })], a.state);
    expect(b.state.sessionView.s1?.selectedTab).toBe('t1');
    expect(b.effects.slice(1)).toEqual([{ kind: 'terminal.connect', sessionId: 's1', tabId: 't1' }, { kind: 'focus', target: 'terminal' }]);
    const c = run([server({ type: 'tab.upsert', tab: tabDto('t1', 'r1', 5) })], b.state);
    expect(c.state.sessionView.s1?.selectedTab).toBeNull();
    expect(c.effects.slice(1)).toEqual([{ kind: 'terminal.disconnect', tabId: 't1' }, { kind: 'terminal.connect', sessionId: 's1', tabId: null }]);
    expect(run([server({ type: 'run.ended', run: runDto('r1', 's1', 9) })], c.state).effects).toEqual([{ kind: 'terminal.disconnect', tabId: 'r1' }]);
  });
  it('トランスクリプトの折りたたみ', () => {
    const a = run([intent({ type: 'transcript.toggle' })], onSession());
    expect(a.state.sessionView.s1?.transcriptOpen).toBe(false);
    expect(run([intent({ type: 'transcript.toggle' })], a.state).state.sessionView.s1?.transcriptOpen).toBe(true);
  });
});

describe('waiting のトースト', () => {
  const live = (id: string, status: 'busy' | 'waiting', name: string | null = null) => ({ sessionId: id, status, name, nameSource: null, cwd: '/x', pid: 1 });
  it('新たに waiting になったものだけ知らせ、戻れば忘れる', () => {
    const a = run([server({ type: 'live.update', live: [live('u1', 'waiting', 'alpha'), live('u2', 'busy')] })]);
    expect(a.effects).toEqual([{ kind: 'toast', level: 'info', message: '「alpha」があなたの入力を待っています' }]);
    expect(a.state.waitingSeen).toEqual(['u1']);
    const b = run([server({ type: 'live.update', live: [live('u1', 'waiting', 'alpha'), live('u2', 'waiting')] })], a.state);
    expect(b.effects).toEqual([{ kind: 'toast', level: 'info', message: '「u2」があなたの入力を待っています' }]);
    const c = run([server({ type: 'live.update', live: [live('u1', 'busy')] })], b.state);
    expect(c.effects).toEqual([]);
    expect(c.state.waitingSeen).toEqual([]);
    expect(run([server({ type: 'live.update', live: [live('u1', 'waiting', 'alpha')] })], c.state).effects).toHaveLength(1);
  });
});

describe('設定', () => {
  it('iTerm2 を選ぶと許可ダイアログの案内を出す', () => {
    const { effects } = run([intent({ type: 'settings.update', patch: { terminalApp: 'iterm' } })]);
    expect(effects).toEqual([{ kind: 'api.updateSettings', patch: { terminalApp: 'iterm' } }, { kind: 'toast', level: 'info', message: 'iTerm2 で開くとき、初回に macOS の自動化の許可ダイアログが出ます' }]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/mediator`
Expected: FAIL

- [ ] **Step 3: 型を直す**

`packages/ui/src/mediator/types.ts` を次に置き換える。

```ts
import type { Intent, LaunchParams, ProjectStatus, ResolveAction, Route, SearchFilter, SearchParamsDto, ServerEvent, SettingsDto } from '@agent-hangar/shared';

export type RuntimeEvent =
  | { type: 'ws.open' } | { type: 'ws.close' } | { type: 'hash.changed'; route: Route }
  | { type: 'api.failed'; message: string } | { type: 'search.done'; params: SearchParamsDto }
  | { type: 'launch.done'; sessionId: string; runId: string } | { type: 'launch.failed'; message: string };

export type Input =
  | { kind: 'intent'; intent: Intent }
  | { kind: 'server'; event: ServerEvent }
  | { kind: 'runtime'; event: RuntimeEvent };

export type Effect =
  | { kind: 'navigate'; route: Route }
  | { kind: 'api.bootstrap' }
  | { kind: 'api.loadEvents'; sessionId: string; fromSeq: number }
  | { kind: 'api.search'; params: SearchParamsDto }
  | { kind: 'api.setProjectStatus'; projectId: string; status: ProjectStatus }
  | { kind: 'api.resolveProject'; projectId: string; action: ResolveAction }
  | { kind: 'api.updateSettings'; patch: Partial<SettingsDto> }
  | { kind: 'api.rebuildIndex' }
  | { kind: 'api.launch'; params: LaunchParams } | { kind: 'api.resume'; sessionId: string } | { kind: 'api.fork'; sessionId: string }
  | { kind: 'api.killRun'; runId: string } | { kind: 'api.openTab'; sessionId: string } | { kind: 'api.closeTab'; tabId: string }
  | { kind: 'api.openTerminalApp'; runId: string; tabId: string | null } | { kind: 'api.openEditor'; sessionId: string }
  | { kind: 'api.projectOpenEditor'; projectId: string } | { kind: 'api.projectOpenTerminal'; projectId: string }
  | { kind: 'terminal.connect'; sessionId: string; tabId: string | null } | { kind: 'terminal.disconnect'; tabId: string }
  | { kind: 'ws.connect' } | { kind: 'ws.reconnectAfter'; ms: number }
  | { kind: 'focus'; target: 'search' | 'newSessionName' | 'terminal' }
  | { kind: 'toast'; level: 'info' | 'error'; message: string }
  | { kind: 'storage.save'; key: string; value: unknown };

export type Screen = { name: 'booting' } | Route;
export type Overlay = { kind: 'none' } | { kind: 'resolveProject'; projectId: string } | { kind: 'palette' } | { kind: 'newSession'; projectId: string | null } | { kind: 'notYet'; feature: string };
export type LaunchState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'failed'; message: string };
export type SessionViewState = { agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; summaryOpen: boolean; selectedTab: string | null; transcriptOpen: boolean };
export type Toast = { id: string; level: 'info' | 'error'; message: string };
export type State = {
  screen: Screen; overlay: Overlay; connection: 'connecting' | 'connected' | 'disconnected'; reconnectAttempt: number;
  sessionView: Record<string, SessionViewState>; search: { text: string; filter: SearchFilter };
  launch: LaunchState; waitingSeen: string[];
  toasts: Toast[]; unresolvedQueue: string[]; nextToastId: number;
};
export type Step = { state: State; effects: Effect[] };
export const NOT_YET = 'この操作は次のフェーズで実装します';
export const ITERM_HINT = 'iTerm2 で開くとき、初回に macOS の自動化の許可ダイアログが出ます';
```

- [ ] **Step 4: 領域を書く**

`packages/ui/src/mediator/screen.ts` の `hash.changed` の分岐で、`route.name === 'session'` の行を次に置き換える。

```ts
    if (route.name === 'session') effects.push({ kind: 'api.loadEvents', sessionId: route.id, fromSeq: 0 }, { kind: 'terminal.connect', sessionId: route.id, tabId: null });
```

`packages/ui/src/mediator/launch.ts`：

```ts
import { NOT_YET, type Input, type State, type Step } from './types.ts';

/** launch 領域：起動ダイアログ、送信中、失敗。再開とフォークも同じ送信中の状態を使う。 */
export function launchStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const ev = input.event;
    if (ev.type === 'launch.done') {
      const overlay = state.overlay.kind === 'newSession' ? { kind: 'none' as const } : state.overlay;
      return { state: { ...state, launch: { kind: 'idle' }, overlay }, effects: [{ kind: 'navigate', route: { name: 'session', id: ev.sessionId } }] };
    }
    if (ev.type === 'launch.failed') return { state: { ...state, launch: { kind: 'failed', message: ev.message } }, effects: [{ kind: 'toast', level: 'error', message: ev.message }] };
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'session.new.open':
      if (i.scratch) return { state, effects: [{ kind: 'toast', level: 'info', message: NOT_YET }] };
      return { state: { ...state, overlay: { kind: 'newSession', projectId: i.projectId ?? null }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
    case 'session.new.submit':
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      if (!i.params.projectId) return { state: { ...state, launch: { kind: 'failed', message: 'プロジェクトを選んでください' } }, effects: [] };
      return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.launch', params: i.params }] };
    case 'overlay.close':
      if (state.overlay.kind !== 'newSession') return null;
      return { state: { ...state, overlay: { kind: 'none' }, launch: { kind: 'idle' } }, effects: [] };
    case 'session.resume': return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.resume', sessionId: i.id }] };
    case 'session.fork': return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.fork', sessionId: i.id }] };
    case 'session.kill': return { state, effects: [{ kind: 'api.killRun', runId: i.runId }] };
    case 'session.openTerminalApp': return { state, effects: [{ kind: 'api.openTerminalApp', runId: i.runId, tabId: i.tabId ?? null }] };
    case 'session.openEditor': return { state, effects: [{ kind: 'api.openEditor', sessionId: i.sessionId }] };
    case 'project.openEditor': return { state, effects: [{ kind: 'api.projectOpenEditor', projectId: i.id }] };
    case 'project.openTerminalApp': return { state, effects: [{ kind: 'api.projectOpenTerminal', projectId: i.id }] };
    default: return null;
  }
}
```

`packages/ui/src/mediator/live.ts`：

```ts
import type { Effect, Input, State, Step } from './types.ts';

/** live 領域：waiting になった Claude のセッションを一度だけトーストにする。 */
export function liveStep(state: State, input: Input): Step | null {
  if (input.kind !== 'server' || input.event.type !== 'live.update') return null;
  const waiting = input.event.live.filter((l) => l.status === 'waiting');
  const seen = new Set(state.waitingSeen);
  const effects: Effect[] = waiting.filter((l) => !seen.has(l.sessionId)).map((l) => ({ kind: 'toast', level: 'info', message: `「${l.name ?? l.sessionId.slice(0, 8)}」があなたの入力を待っています` }));
  const next = waiting.map((l) => l.sessionId);
  const same = next.length === state.waitingSeen.length && next.every((id, i) => id === state.waitingSeen[i]);
  return { state: same ? state : { ...state, waitingSeen: next }, effects };
}
```

`packages/ui/src/mediator/sessionView.ts` を次に置き換える。

```ts
import type { Effect, Input, SessionViewState, State, Step } from './types.ts';

export function defaultSessionView(): SessionViewState {
  return { agentId: null, showThinking: false, showRaw: false, follow: true, summaryOpen: false, selectedTab: null, transcriptOpen: true };
}

function patch(state: State, id: string, p: Partial<SessionViewState>): Step {
  const cur = state.sessionView[id] ?? defaultSessionView();
  const next = { ...cur, ...p };
  const effects: Effect[] = [{ kind: 'storage.save', key: `sv:${id}`, value: next }];
  return { state: { ...state, sessionView: { ...state.sessionView, [id]: next } }, effects };
}

const currentSession = (state: State): string | null => (state.screen.name === 'session' ? state.screen.id : null);
const viewOf = (state: State, id: string) => state.sessionView[id] ?? defaultSessionView();

/** sessionView 領域：セッション画面の一時状態とターミナル接続の開閉。localStorage に保存し、同期しない。 */
export function sessionViewStep(state: State, input: Input): Step | null {
  if (input.kind === 'server') {
    const ev = input.event;
    switch (ev.type) {
      case 'transcript.appended': {
        const open = currentSession(state) === ev.sessionId;
        return { state, effects: open ? [{ kind: 'api.loadEvents', sessionId: ev.sessionId, fromSeq: -1 }] : [] };
      }
      case 'run.started': {
        if (currentSession(state) !== ev.run.sessionId) return { state, effects: [] };
        const r = patch(state, ev.run.sessionId, { selectedTab: null });
        return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: ev.run.sessionId, tabId: ev.run.id }] };
      }
      case 'run.ended': return { state, effects: [{ kind: 'terminal.disconnect', tabId: ev.run.id }] };
      case 'tab.upsert': {
        const t = ev.tab;
        if (t.closedAt !== null) {
          if (viewOf(state, t.sessionId).selectedTab !== t.id) return { state, effects: [{ kind: 'terminal.disconnect', tabId: t.id }] };
          const r = patch(state, t.sessionId, { selectedTab: null });
          return { state: r.state, effects: [...r.effects, { kind: 'terminal.disconnect', tabId: t.id }, { kind: 'terminal.connect', sessionId: t.sessionId, tabId: null }] };
        }
        if (currentSession(state) !== t.sessionId || t.kind !== 'shell') return { state, effects: [] };
        const r = patch(state, t.sessionId, { selectedTab: t.id });
        return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: t.sessionId, tabId: t.id }, { kind: 'focus', target: 'terminal' }] };
      }
      default: return null;
    }
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'transcript.showThinking': return patch(state, i.sessionId, { showThinking: i.show });
    case 'transcript.showRaw': return patch(state, i.sessionId, { showRaw: i.show });
    case 'transcript.follow': return patch(state, i.sessionId, { follow: i.follow });
    case 'summary.toggle': return patch(state, i.sessionId, { summaryOpen: !viewOf(state, i.sessionId).summaryOpen });
    case 'transcript.loadMore': return { state, effects: [{ kind: 'api.loadEvents', sessionId: i.sessionId, fromSeq: -1 }] };
    case 'transcript.selectAgent': {
      const r = patch(state, i.sessionId, { agentId: i.agentId });
      return { state: r.state, effects: [...r.effects, { kind: 'api.loadEvents', sessionId: i.sessionId, fromSeq: 0 }] };
    }
    case 'transcript.toggle': {
      const sid = currentSession(state);
      return sid ? patch(state, sid, { transcriptOpen: !viewOf(state, sid).transcriptOpen }) : { state, effects: [] };
    }
    case 'tab.open': {
      if (i.kind === 'shell') return { state, effects: [{ kind: 'api.openTab', sessionId: i.sessionId }] };
      const r = patch(state, i.sessionId, { selectedTab: null });
      return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: i.sessionId, tabId: null }] };
    }
    case 'tab.select': {
      const sid = currentSession(state);
      if (!sid) return { state, effects: [] };
      const r = patch(state, sid, { selectedTab: i.tabId });
      return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: sid, tabId: i.tabId }, { kind: 'focus', target: 'terminal' }] };
    }
    case 'tab.close': {
      const sid = currentSession(state);
      const close: Effect = { kind: 'api.closeTab', tabId: i.tabId };
      if (sid && viewOf(state, sid).selectedTab === i.tabId) { const r = patch(state, sid, { selectedTab: null }); return { state: r.state, effects: [...r.effects, close] }; }
      return { state, effects: [close] };
    }
    default: return null;
  }
}
```

`packages/ui/src/mediator/transition.ts` を次に置き換える。

```ts
import { connectionStep } from './connection.ts';
import { launchStep } from './launch.ts';
import { liveStep } from './live.ts';
import { overlayStep } from './overlay.ts';
import { screenStep } from './screen.ts';
import { sessionViewStep } from './sessionView.ts';
import { ITERM_HINT, NOT_YET, type Effect, type Input, type State, type Step } from './types.ts';

export type { State, Input, Effect, Step } from './types.ts';
export { defaultSessionView } from './sessionView.ts';

export function initialState(): State {
  return { screen: { name: 'booting' }, overlay: { kind: 'none' }, connection: 'connecting', reconnectAttempt: 0, sessionView: {}, search: { text: '', filter: {} }, launch: { kind: 'idle' }, waitingSeen: [], toasts: [], unresolvedQueue: [], nextToastId: 1 };
}

function pushToast(state: State, level: 'info' | 'error', message: string): State {
  return { ...state, toasts: [...state.toasts, { id: String(state.nextToastId), level, message }], nextToastId: state.nextToastId + 1 };
}

/** フェーズ 3 以降の操作。Mediator はトーストだけを出す。 */
const NOT_YET_INTENTS = new Set(['session.promote.open', 'session.promote.submit', 'session.takeover', 'session.setMemo', 'split.toggle', 'todo.add', 'todo.toggle', 'todo.remove', 'memo.save', 'artifact.open', 'artifact.add', 'summary.regenerate', 'sync.now', 'sync.pause', 'project.new.open', 'project.new.submit', 'palette.run']);

/** 直交する領域の状態機械を順に試し、最初に応答した領域の結果を採る。残りは横断的な入力。 */
export function transition(state: State, input: Input): Step {
  for (const step of [connectionStep, screenStep, launchStep, overlayStep, sessionViewStep, liveStep]) {
    const r = step(state, input);
    if (r) return r;
  }
  if (input.kind === 'server') {
    if (input.event.type === 'toast') return { state: pushToast(state, input.event.level, input.event.message), effects: [] };
    return { state, effects: [] };
  }
  if (input.kind === 'runtime') {
    if (input.event.type === 'api.failed') return { state: pushToast(state, 'error', input.event.message), effects: [] };
    return { state, effects: [] };
  }
  const i = input.intent;
  switch (i.type) {
    case 'project.setStatus': return { state, effects: [{ kind: 'api.setProjectStatus', projectId: i.id, status: i.status }] };
    case 'settings.update': {
      const effects: Effect[] = [{ kind: 'api.updateSettings', patch: i.patch }];
      if (i.patch.terminalApp === 'iterm') effects.push({ kind: 'toast', level: 'info', message: ITERM_HINT });
      return { state, effects };
    }
    case 'index.rebuild': return { state, effects: [{ kind: 'api.rebuildIndex' }] };
    case 'toast.dismiss': return { state: { ...state, toasts: state.toasts.filter((t) => t.id !== i.id) }, effects: [] };
    default:
      if (NOT_YET_INTENTS.has(i.type)) return { state, effects: [{ kind: 'toast', level: 'info', message: NOT_YET }] };
      return { state, effects: [] };
  }
}
```

`launchStep` を `overlayStep` より前に置くのは、`overlay.close` を `newSession` のときだけ横取りするためである。
`overlayStep` の `overlay.close` は `popQueue` で `none` にするだけなので、`launch` を `idle` に戻せない。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui/src/mediator && npx tsc -p packages/ui --noEmit 2>&1 | grep -v 'runtime\|Root\|presenters\|views'`
Expected: PASS（フェーズ 1 の 15 件と新しい 10 件）

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/mediator
git commit -m "feat(ui): mediator launch region, tab and terminal transitions, waiting toasts"
```

---

### Task 18: ランタイム（TerminalHost と新しい効果）

**Files:**
- Create: `packages/ui/src/runtime/terminals.ts`、`packages/ui/src/runtime/xterm.ts`
- Modify: `packages/ui/src/runtime/runtime.ts`、`packages/ui/package.json`（`@xterm/xterm` と `@xterm/addon-fit`）
- Test: `packages/ui/src/runtime/terminals.test.ts`、`packages/ui/src/runtime/runtime.test.ts`（追加）

**Interfaces:**
- Produces:
  ```ts
  // runtime/terminals.ts
  export type TerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';
  export type TerminalLike = { cols: number; rows: number; element: HTMLElement | null; open(el: HTMLElement): void; write(d: string): void; onData(cb: (d: string) => void): { dispose(): void }; onResize(cb: (s: { cols: number; rows: number }) => void): { dispose(): void }; fit(): void; focus(): void; dispose(): void };
  export type TerminalHost = { connect(tabId: string): void; disconnect(tabId: string): void; mount(tabId: string, el: HTMLElement): void; status(tabId: string): TerminalStatus | null; fit(tabId: string): void; focus(tabId: string): void; subscribe(cb: () => void): () => void; dispose(): void };
  export function createTerminalHost(deps: { wsUrl: (tabId: string) => string; createTerminal: () => TerminalLike; wsFactory?: (url: string) => WebSocket }): TerminalHost;
  // runtime/xterm.ts
  export function createXterm(): TerminalLike;     // 本物の xterm.js と fit addon。main.tsx だけが import する
  // runtime/runtime.ts
  export type RuntimeDeps = { ...フェーズ 1...; terminals: TerminalHost; focus?: (target: 'search' | 'newSessionName') => void };
  ```
- `TerminalHost` は `tabId` ごとに xterm のインスタンスと WebSocket を持つ。`connect` は開いていれば何もしない。開いたら `resize` を送る。`disconnect` は WebSocket を閉じ、xterm は残す（終了した画面を読めるようにする）。`mount` は初回は `open(el)`、2 回目以降は既存の要素を新しい親へ移す（スクロール位置とバッファを保つ）。`subscribe` は状態の変化を React に伝える。
- ランタイムの効果：
  - `api.launch` / `api.resume` / `api.fork`：成功で `applyLaunch` と `runtime launch.done`、失敗で `runtime launch.failed`。
  - `api.openTab(sessionId)`：ストアの `aliveRunOf` で run を引き `api.openTab(run.id)`。無ければ `api.failed`。
  - `api.closeTab(tabId)`：ストアの `tabs[tabId]` から `runId` を引く。
  - `api.openTerminalApp`：`fellBack` ならトースト「iTerm2 で開けなかったので Terminal.app で開きました」。
  - `terminal.connect(sessionId, tabId)`：`tabId` が null なら選択中のタブ、無ければ `currentRunOf` の Claude タブ。終了した run の Claude タブには繋がない。
  - `terminal.disconnect(tabId)` → `terminals.disconnect`。
  - `focus(terminal)`：現在のセッションの選択中のタブに `terminals.focus`。他の `focus` は `deps.focus`。

- [ ] **Step 1: 依存を足す**

`packages/ui/package.json` の `dependencies` に `"@xterm/xterm": "^6.0.0"` と `"@xterm/addon-fit": "^0.11.0"` を足し、`npm install` を実行する。

- [ ] **Step 2: 失敗するテストを書く**

`packages/ui/src/runtime/terminals.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { createTerminalHost, type TerminalLike } from './terminals.ts';

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0; sent: string[] = [];
  onopen: (() => void) | null = null; onmessage: ((m: { data: string }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
type FakeTerm = TerminalLike & { written: string[]; opened: HTMLElement | null; fitted: number; focused: number; disposed: boolean; type(d: string): void; resizeTo(c: number, r: number): void };
function fakeTerm(): FakeTerm {
  const data: ((d: string) => void)[] = []; const resize: ((s: { cols: number; rows: number }) => void)[] = [];
  const t: FakeTerm = {
    cols: 80, rows: 24, element: null, written: [], opened: null, fitted: 0, focused: 0, disposed: false,
    open(el) { t.opened = el; t.element = { parentElement: el } as unknown as HTMLElement; },
    write(d) { t.written.push(d); },
    onData(cb) { data.push(cb); return { dispose() {} }; },
    onResize(cb) { resize.push(cb); return { dispose() {} }; },
    fit() { t.fitted++; }, focus() { t.focused++; }, dispose() { t.disposed = true; },
    type(d) { for (const cb of data) cb(d); }, resizeTo(c, r) { for (const cb of resize) cb({ cols: c, rows: r }); },
  };
  return t;
}
function make() {
  FakeWs.all = [];
  const terms: FakeTerm[] = [];
  const host = createTerminalHost({ wsUrl: (id) => `ws://x/ws/pty?tab=${id}`, createTerminal: () => { const t = fakeTerm(); terms.push(t); return t; }, wsFactory: (u) => new FakeWs(u) as unknown as WebSocket });
  return { host, terms };
}

describe('createTerminalHost', () => {
  it('接続すると resize を送り、入出力を中継する', () => {
    const { host, terms } = make();
    const changes = vi.fn();
    host.subscribe(changes);
    host.connect('t1');
    expect(FakeWs.all[0]!.url).toBe('ws://x/ws/pty?tab=t1');
    expect(host.status('t1')).toBe('connecting');
    FakeWs.all[0]!.open();
    expect(host.status('t1')).toBe('connected');
    expect(JSON.parse(FakeWs.all[0]!.sent[0]!)).toEqual({ t: 'resize', cols: 80, rows: 24 });
    FakeWs.all[0]!.receive({ t: 'data', d: 'hello' });
    expect(terms[0]!.written).toEqual(['hello']);
    terms[0]!.type('ls\r');
    terms[0]!.resizeTo(100, 30);
    expect(FakeWs.all[0]!.sent.slice(1).map((s) => JSON.parse(s))).toEqual([{ t: 'data', d: 'ls\r' }, { t: 'resize', cols: 100, rows: 30 }]);
    host.connect('t1');
    expect(FakeWs.all).toHaveLength(1);
    expect(changes).toHaveBeenCalled();
  });
  it('切断は WebSocket だけ閉じ、xterm は残す。エラーは本文に書く', () => {
    const { host, terms } = make();
    host.connect('t1');
    FakeWs.all[0]!.open();
    host.disconnect('t1');
    expect(FakeWs.all[0]!.readyState).toBe(3);
    expect(host.status('t1')).toBe('closed');
    expect(terms[0]!.disposed).toBe(false);
    host.connect('t1');
    expect(FakeWs.all).toHaveLength(2);
    expect(terms).toHaveLength(1);
    FakeWs.all[1]!.receive({ t: 'error', message: 'pty spawn failed' });
    expect(terms[0]!.written.at(-1)).toContain('pty spawn failed');
    expect(host.status('t1')).toBe('error');
    expect(host.status('nope')).toBeNull();
  });
  it('mount は初回に open し、2 回目は要素を移す', () => {
    const { host, terms } = make();
    const a = { appendChild: vi.fn() } as unknown as HTMLElement;
    const b = { appendChild: vi.fn() } as unknown as HTMLElement;
    host.mount('t1', a);
    expect(terms[0]!.opened).toBe(a);
    expect(terms[0]!.fitted).toBe(1);
    host.mount('t1', b);
    expect((b as unknown as { appendChild: ReturnType<typeof vi.fn> }).appendChild).toHaveBeenCalledWith(terms[0]!.element);
    host.focus('t1');
    expect(terms[0]!.focused).toBe(1);
    host.dispose();
    expect(terms[0]!.disposed).toBe(true);
  });
});
```

`packages/ui/src/runtime/runtime.test.ts` の `harness` に `terminals` の偽物を足し、次の `describe` を足す。

```ts
import type { TerminalHost } from './terminals.ts';
import type { LaunchResultDto } from '@agent-hangar/shared';

function fakeTerminals(): TerminalHost & { connected: string[]; disconnected: string[] } {
  const h = { connected: [] as string[], disconnected: [] as string[], connect: (id: string) => { h.connected.push(id); }, disconnect: (id: string) => { h.disconnected.push(id); }, mount: () => {}, status: () => null, fit: () => {}, focus: vi.fn(), subscribe: () => () => {}, dispose: () => {} };
  return h;
}
```

`harness` の `deps` に `terminals: fakeTerminals()` を足し、戻り値に `terminals: deps.terminals as ReturnType<typeof fakeTerminals>` を足す。

```ts
const launched: LaunchResultDto = { run: { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 's1', tabs: [{ id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null }] };

describe('起動とターミナル', () => {
  it('起動に成功するとストアに run が入り、セッション画面へ移ってターミナルに繋ぐ', async () => {
    const { rt, api, terminals, setHash } = harness({ launch: vi.fn(async () => launched) });
    rt.start();
    setHash('#/');
    rt.emit({ type: 'session.new.open', projectId: 'p1' });
    rt.emit({ type: 'session.new.submit', params: { projectId: 'p1' } });
    await flush();
    expect(api.launch).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(rt.getStore().runs.r1).toBeDefined();
    expect(rt.getState()).toMatchObject({ launch: { kind: 'idle' }, overlay: { kind: 'none' }, screen: { name: 'session', id: 's1' } });
    expect(terminals.connected).toEqual(['r1']);
  });
  it('起動の失敗はトーストと failed', async () => {
    const { rt } = harness({ launch: vi.fn(async () => { throw new Error('tmux が見つかりません'); }) });
    rt.start();
    rt.emit({ type: 'session.new.submit', params: { projectId: 'p1' } });
    await flush();
    expect(rt.getState().launch).toEqual({ kind: 'failed', message: 'tmux が見つかりません' });
    expect(rt.getState().toasts[0]).toMatchObject({ level: 'error', message: 'tmux が見つかりません' });
  });
  it('セッション画面に入ると生きた run の Claude タブに繋ぎ、終了した run には繋がない', async () => {
    const { rt, terminals, setHash } = harness();
    rt.start();
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: launched.run, tabs: launched.tabs } });
    setHash('#/session/s1');
    expect(terminals.connected).toEqual(['r1']);
    rt.dispatch({ kind: 'server', event: { type: 'run.ended', run: { ...launched.run, endedAt: 2, endReason: 'exited' } } });
    expect(terminals.disconnected).toEqual(['r1']);
    setHash('#/session/s1');
    expect(terminals.connected).toEqual(['r1']);
  });
  it('tab.open は run を引いて API を呼び、届いたタブに繋ぐ', async () => {
    const tab = { id: 't1', runId: 'r1', sessionId: 's1', kind: 'shell' as const, title: 'シェル 1', tmuxName: 'hangar-r1-t1', createdAt: 2, closedAt: null };
    const { rt, api, terminals, setHash } = harness({ openTab: vi.fn(async () => tab) });
    rt.start();
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: launched.run, tabs: launched.tabs } });
    setHash('#/session/s1');
    rt.emit({ type: 'tab.open', sessionId: 's1', kind: 'shell' });
    await flush();
    expect(api.openTab).toHaveBeenCalledWith('r1');
    rt.dispatch({ kind: 'server', event: { type: 'tab.upsert', tab } });
    expect(terminals.connected).toEqual(['r1', 't1']);
    expect(terminals.focus).toHaveBeenCalledWith('t1');
    rt.emit({ type: 'tab.close', tabId: 't1' });
    await flush();
    expect(api.closeTab).toHaveBeenCalledWith('r1', 't1');
  });
  it('iTerm2 から Terminal.app に落ちたらトーストで知らせる', async () => {
    const { rt } = harness({ openTerminalApp: vi.fn(async () => ({ app: 'terminal' as const, fellBack: true })) });
    rt.start();
    rt.emit({ type: 'session.openTerminalApp', runId: 'r1' });
    await flush();
    expect(rt.getState().toasts[0]?.message).toContain('Terminal.app');
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/runtime`
Expected: FAIL

- [ ] **Step 4: TerminalHost を書く**

`packages/ui/src/runtime/terminals.ts`：

```ts
export type TerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';
export type TerminalLike = { cols: number; rows: number; element: HTMLElement | null; open(el: HTMLElement): void; write(d: string): void; onData(cb: (d: string) => void): { dispose(): void }; onResize(cb: (s: { cols: number; rows: number }) => void): { dispose(): void }; fit(): void; focus(): void; dispose(): void };
export type TerminalHost = { connect(tabId: string): void; disconnect(tabId: string): void; mount(tabId: string, el: HTMLElement): void; status(tabId: string): TerminalStatus | null; fit(tabId: string): void; focus(tabId: string): void; subscribe(cb: () => void): () => void; dispose(): void };

type Entry = { term: TerminalLike; ws: WebSocket | null; status: TerminalStatus; opened: boolean; subs: { dispose(): void }[] };

/**
 * タブごとの xterm と WebSocket を React の外で持つ。
 * 画面を離れても接続とバッファとスクロール位置を保ち、run の終了とタブを閉じたときだけ切る。
 */
export function createTerminalHost(deps: { wsUrl: (tabId: string) => string; createTerminal: () => TerminalLike; wsFactory?: (url: string) => WebSocket }): TerminalHost {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of listeners) l(); };
  const setStatus = (e: Entry, s: TerminalStatus) => { if (e.status !== s) { e.status = s; notify(); } };
  const ensure = (tabId: string): Entry => {
    let e = entries.get(tabId);
    if (!e) { e = { term: deps.createTerminal(), ws: null, status: 'closed', opened: false, subs: [] }; entries.set(tabId, e); }
    return e;
  };
  const send = (e: Entry, m: unknown) => { if (e.ws && e.ws.readyState === 1) e.ws.send(JSON.stringify(m)); };

  return {
    connect(tabId) {
      const e = ensure(tabId);
      if (e.ws && (e.ws.readyState === 0 || e.ws.readyState === 1)) return;
      const ws = (deps.wsFactory ?? ((u) => new WebSocket(u)))(deps.wsUrl(tabId));
      e.ws = ws;
      setStatus(e, 'connecting');
      ws.onopen = () => { setStatus(e, 'connected'); send(e, { t: 'resize', cols: e.term.cols, rows: e.term.rows }); };
      ws.onmessage = (m) => {
        let msg: { t?: string; d?: unknown; message?: unknown };
        try { msg = JSON.parse(String(m.data)) as typeof msg; } catch { return; }
        if (msg.t === 'data' && typeof msg.d === 'string') e.term.write(msg.d);
        else if (msg.t === 'error') { e.term.write(`\r\n[agent-hangar] ${String(msg.message)}\r\n`); setStatus(e, 'error'); }
      };
      ws.onclose = () => { if (e.ws === ws) { e.ws = null; if (e.status !== 'error') setStatus(e, 'closed'); } };
      ws.onerror = () => { /* onclose が続く */ };
      if (e.subs.length === 0) {
        e.subs.push(e.term.onData((d) => send(e, { t: 'data', d })));
        e.subs.push(e.term.onResize((s) => send(e, { t: 'resize', cols: s.cols, rows: s.rows })));
      }
    },
    disconnect(tabId) {
      const e = entries.get(tabId);
      if (!e) return;
      const ws = e.ws; e.ws = null;
      ws?.close();
      setStatus(e, 'closed');
    },
    mount(tabId, el) {
      const e = ensure(tabId);
      if (!e.opened) { e.term.open(el); e.opened = true; }
      else if (e.term.element && e.term.element.parentElement !== el) el.appendChild(e.term.element);
      e.term.fit();
    },
    status: (tabId) => entries.get(tabId)?.status ?? null,
    fit: (tabId) => entries.get(tabId)?.term.fit(),
    focus: (tabId) => entries.get(tabId)?.term.focus(),
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    dispose() { for (const e of entries.values()) { e.ws?.close(); for (const s of e.subs) s.dispose(); e.term.dispose(); } entries.clear(); },
  };
}
```

`packages/ui/src/runtime/xterm.ts`：

```tsx
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalLike } from './terminals.ts';

/** 本物の xterm.js。テストでは TerminalLike の偽物を使うので、このファイルは main.tsx だけが読む。 */
export function createXterm(): TerminalLike {
  const css = getComputedStyle(document.documentElement);
  const term = new Terminal({ fontFamily: "'JetBrains Mono Variable', Menlo, monospace", fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: { background: css.getPropertyValue('--term-bg').trim() || '#1c1b19', foreground: css.getPropertyValue('--term-fg').trim() || '#e8e6e1' } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    get element() { return term.element ?? null; },
    open: (el) => term.open(el),
    write: (d) => term.write(d),
    onData: (cb) => term.onData(cb),
    onResize: (cb) => term.onResize(cb),
    fit: () => { try { fit.fit(); } catch { /* 非表示のときは寸法が取れない */ } },
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  };
}
```

- [ ] **Step 5: ランタイムを直す**

`packages/ui/src/runtime/runtime.ts` を次に置き換える。

```ts
import { formatRoute, parseRoute, type Intent, type LaunchResultDto, type ServerEvent } from '@agent-hangar/shared';
import { initialState, transition, type Effect, type Input, type State } from '../mediator/transition.ts';
import { defaultSessionView } from '../mediator/sessionView.ts';
import type { SessionViewState } from '../mediator/types.ts';
import { aliveRunOf, applyBootstrap, applyEventsPage, applyLaunch, applySearch, applyServerEvent, currentRunOf, eventsKey, initialStore, setEventsLoading, tabsOf, type Store } from '../store/store.ts';
import type { ApiClient } from './api.ts';
import type { TerminalHost } from './terminals.ts';
import type { WsClient } from './ws.ts';

export type RuntimeDeps = {
  api: ApiClient;
  ws: (handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }) => WsClient;
  location: { getHash(): string; setHash(h: string): void; onHashChange(cb: () => void): () => void };
  storage: { get(key: string): unknown; set(key: string, value: unknown): void; keys(): string[] };
  setTimeout: (fn: () => void, ms: number) => unknown;
  terminals: TerminalHost;
  focus?: (target: 'search' | 'newSessionName') => void;
};

export type Runtime = {
  dispatch(input: Input): void; emit(intent: Intent): void;
  getState(): State; getStore(): Store;
  subscribe(cb: () => void): () => void;
  start(): void; stop(): void;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Mediator の効果を実行し、サーバとブラウザの出来事を入力に変える。 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  let state = initialState();
  let store = initialStore();
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of listeners) l(); };
  const setStore = (next: Store) => { if (next !== store) { store = next; notify(); } };
  let ws: WsClient | null = null;
  let searchSeq = 0;
  let unsubHash: (() => void) | null = null;

  const fail = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'api.failed', message: errMsg(e) } });
  const toast = (message: string) => dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message } });
  const launched = (r: LaunchResultDto) => { setStore(applyLaunch(store, r)); dispatch({ kind: 'runtime', event: { type: 'launch.done', sessionId: r.sessionId, runId: r.run.id } }); };
  const launchFailed = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'launch.failed', message: errMsg(e) } });

  /** 繋ぐタブを決める。指定が無ければ選択中のタブ、無ければ現在の run の Claude タブ。終了した run の Claude タブには繋がない。 */
  function resolveTab(sessionId: string, tabId: string | null): string | null {
    const run = currentRunOf(store, sessionId);
    if (!run) return null;
    const open = tabsOf(store, run.id);
    const pick = tabId ?? state.sessionView[sessionId]?.selectedTab ?? run.id;
    const tab = open.find((t) => t.id === pick) ?? open[0];
    if (!tab || (tab.kind === 'agent' && run.endedAt !== null)) return null;
    return tab.id;
  }

  function runEffect(e: Effect): void {
    switch (e.kind) {
      case 'navigate': {
        const h = formatRoute(e.route);
        if (deps.location.getHash() === h) dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: e.route } });
        else deps.location.setHash(h);
        return;
      }
      case 'api.bootstrap':
        deps.api.bootstrap().then((b) => { setStore(applyBootstrap(store, b)); dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(deps.location.getHash()) } }); }).catch(fail);
        return;
      case 'api.loadEvents': {
        const view = state.sessionView[e.sessionId] ?? defaultSessionView();
        const key = eventsKey(e.sessionId, view.agentId);
        const cur = store.events[key];
        if (cur?.loading) return;
        let from = e.fromSeq;
        let append = true;
        if (from === 0) append = false;
        else if (from === -1) { from = cur?.nextSeq ?? (cur && cur.total > cur.items.length ? cur.items.length : -1); if (from < 0) return; }
        setStore(setEventsLoading(store, key, true));
        deps.api.events(e.sessionId, from, view.agentId).then((p) => setStore(applyEventsPage(store, key, p, append))).catch((err) => { setStore(setEventsLoading(store, key, false)); fail(err); });
        return;
      }
      case 'api.search': {
        const seq = ++searchSeq;
        setStore(applySearch(store, e.params, store.search.result, true));
        deps.api.search(e.params).then((r) => { if (seq === searchSeq) setStore(applySearch(store, e.params, r, false)); }).catch(fail);
        return;
      }
      case 'api.setProjectStatus': deps.api.setProjectStatus(e.projectId, e.status).catch(fail); return;
      case 'api.resolveProject': deps.api.resolveProject(e.projectId, e.action).catch(fail); return;
      case 'api.updateSettings': deps.api.updateSettings(e.patch).then((s) => setStore({ ...store, settings: s })).catch(fail); return;
      case 'api.rebuildIndex': deps.api.rebuildIndex().catch(fail); return;
      case 'api.launch': deps.api.launch(e.params).then(launched).catch(launchFailed); return;
      case 'api.resume': deps.api.resume(e.sessionId).then(launched).catch(launchFailed); return;
      case 'api.fork': deps.api.fork(e.sessionId).then(launched).catch(launchFailed); return;
      case 'api.killRun': deps.api.killRun(e.runId).then((run) => setStore(applyServerEvent(store, { type: 'run.ended', run }))).catch(fail); return;
      case 'api.openTab': {
        const run = aliveRunOf(store, e.sessionId);
        if (!run) { fail(new Error('実行中の run がありません')); return; }
        deps.api.openTab(run.id).then((tab) => setStore(applyServerEvent(store, { type: 'tab.upsert', tab }))).catch(fail);
        return;
      }
      case 'api.closeTab': {
        const tab = store.tabs[e.tabId];
        if (!tab) return;
        deps.api.closeTab(tab.runId, tab.id).then((t) => setStore(applyServerEvent(store, { type: 'tab.upsert', tab: t }))).catch(fail);
        return;
      }
      case 'api.openTerminalApp': deps.api.openTerminalApp(e.runId, e.tabId).then((r) => { if (r.fellBack) toast('iTerm2 で開けなかったので Terminal.app で開きました'); }).catch(fail); return;
      case 'api.openEditor': deps.api.openEditor(e.sessionId).catch(fail); return;
      case 'api.projectOpenEditor': deps.api.projectOpenEditor(e.projectId).catch(fail); return;
      case 'api.projectOpenTerminal': deps.api.projectOpenTerminal(e.projectId).then((r) => { if (r.fellBack) toast('iTerm2 で開けなかったので Terminal.app で開きました'); }).catch(fail); return;
      case 'terminal.connect': { const id = resolveTab(e.sessionId, e.tabId); if (id) deps.terminals.connect(id); return; }
      case 'terminal.disconnect': deps.terminals.disconnect(e.tabId); return;
      case 'ws.connect': ws?.connect(); return;
      case 'ws.reconnectAfter': deps.setTimeout(() => ws?.connect(), e.ms); return;
      case 'focus':
        if (e.target === 'terminal') { if (state.screen.name === 'session') { const id = resolveTab(state.screen.id, null); if (id) deps.terminals.focus(id); } }
        else deps.focus?.(e.target);
        return;
      case 'toast': dispatch({ kind: 'server', event: { type: 'toast', level: e.level, message: e.message } }); return;
      case 'storage.save': deps.storage.set(e.key, e.value); return;
    }
  }

  function dispatch(input: Input): void {
    if (input.kind === 'server') setStore(applyServerEvent(store, input.event));
    const r = transition(state, input);
    if (r.state !== state) { state = r.state; notify(); }
    for (const eff of r.effects) runEffect(eff);
  }

  return {
    dispatch,
    emit: (intent) => dispatch({ kind: 'intent', intent }),
    getState: () => state,
    getStore: () => store,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    start() {
      const sv: Record<string, SessionViewState> = {};
      for (const k of deps.storage.keys()) if (k.startsWith('sv:')) { const v = deps.storage.get(k); if (v && typeof v === 'object') sv[k.slice(3)] = { ...defaultSessionView(), ...(v as Partial<SessionViewState>) }; }
      state = { ...state, sessionView: sv };
      ws = deps.ws({
        onOpen: () => dispatch({ kind: 'runtime', event: { type: 'ws.open' } }),
        onClose: () => dispatch({ kind: 'runtime', event: { type: 'ws.close' } }),
        onEvent: (ev) => dispatch({ kind: 'server', event: ev }),
      });
      unsubHash = deps.location.onHashChange(() => dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(deps.location.getHash()) } }));
      ws.connect();
    },
    stop() { ws?.close(); unsubHash?.(); deps.terminals.dispose(); },
  };
}
```

- [ ] **Step 6: テストと型検査**

Run: `npx vitest run packages/ui/src/runtime && npx tsc -p packages/ui --noEmit 2>&1 | grep -v 'Root\|presenters\|views'`
Expected: PASS（terminals 3 件、runtime はフェーズ 1 の 6 件と新しい 5 件）

- [ ] **Step 7: コミット**

```bash
git add package-lock.json packages/ui/package.json packages/ui/src/runtime
git commit -m "feat(ui): terminal host that owns xterm and pty websockets, runtime effects for launch and tabs"
```

---

### Task 19: Presenter（実行中のセッション、起動ダイアログ、設定）

**Files:**
- Create: `packages/ui/src/presenters/newSession.ts`
- Modify: `packages/ui/src/presenters/session.ts`、`packages/ui/src/presenters/settings.ts`
- Test: `packages/ui/src/presenters/presenters.test.ts`（追加）

**Interfaces:**
- Produces:
  ```ts
  // presenters/session.ts（追加）
  export type TabItemProps = { id: string; title: string; kind: 'agent' | 'shell'; selected: boolean; closable: boolean };
  export type SessionProps = { ...フェーズ 1...; run: { id: string; kind: RunKind; alive: boolean; started: string } | null; tabs: TabItemProps[]; selectedTab: string | null; transcriptOpen: boolean; trustHint: boolean; canResume: boolean; canFork: boolean };
  // presenters/newSession.ts
  export type NewSessionProps = { projects: { id: string; name: string; path: string | null }[]; projectId: string | null; submitting: boolean; error: string | null };
  export function presentNewSession(state: State, store: Store): NewSessionProps | null;
  // presenters/settings.ts（追加）
  export type SettingsProps = { ...フェーズ 1...; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; mcpInstallCommand: string };
  ```
- `run` は `currentRunOf`（生きた run、無ければシェルタブが残る最新の run）。`tabs` は `tabsOf(run.id)`。`selectedTab` は `sessionView.selectedTab` が開いたタブの中にあればそれ、無ければ Claude タブ（`run.id`）。`trustHint` は生きた run があるのに `live` が null のとき。`canResume` と `canFork` は本文があり、生きた run が無く、`live` が null で、`launch` が `submitting` でないとき。
- `presentNewSession` の `projects` は `resolved` かつ `archived` でないものを名前順に。`error` は `launch.failed` のメッセージ。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/presenters/presenters.test.ts` に足す。

```ts
import type { RunDto, TabDto } from '@agent-hangar/shared';
import { presentNewSession } from './newSession.ts';
import { presentSettings } from './settings.ts';

const runDto = (id: string, sessionId: string, endedAt: number | null = null): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: null, startedAt: NOW - 60_000, endedAt, endReason: endedAt ? 'exited' : null, heartbeatAt: 1 });
const tabDto = (id: string, runId: string, kind: 'agent' | 'shell', closedAt: number | null = null): TabDto => ({ id, runId, sessionId: 's1', kind, title: kind === 'agent' ? 'Claude' : `シェル ${id}`, tmuxName: `hangar-${runId}-${id}`, createdAt: 2, closedAt });

describe('presentSession（実行中）', () => {
  it('run とタブと選択、信頼ダイアログの案内、再開の可否', () => {
    const store = storeWith();
    store.runs = { r1: runDto('r1', 's1') };
    store.tabs = { r1: tabDto('r1', 'r1', 'agent'), t1: tabDto('t1', 'r1', 'shell'), t0: tabDto('t0', 'r1', 'shell', 9) };
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.run).toEqual({ id: 'r1', kind: 'start', alive: true, started: '1 分前' });
    expect(p.tabs).toEqual([{ id: 'r1', title: 'Claude', kind: 'agent', selected: true, closable: false }, { id: 't1', title: 'シェル t1', kind: 'shell', selected: false, closable: true }]);
    expect(p.selectedTab).toBe('r1');
    expect(p).toMatchObject({ trustHint: false, canResume: false, canFork: false, transcriptOpen: true });
    const state = { ...initialState(), sessionView: { s1: { agentId: null, showThinking: false, showRaw: false, follow: true, summaryOpen: false, selectedTab: 't1', transcriptOpen: false } } };
    const q = presentSession(state, store, NOW, 's1');
    expect(q.selectedTab).toBe('t1');
    expect(q.tabs[1]!.selected).toBe(true);
    expect(q.transcriptOpen).toBe(false);
    store.sessions.s1 = { ...store.sessions.s1!, live: null };
    expect(presentSession(initialState(), store, NOW, 's1').trustHint).toBe(true);
  });
  it('run が無ければ再開できる。送信中は不可', () => {
    const store = storeWith();
    store.sessions.s2 = { ...store.sessions.s2!, live: null };
    expect(presentSession(initialState(), store, NOW, 's2')).toMatchObject({ run: null, tabs: [], selectedTab: null, canResume: true, canFork: true, trustHint: false });
    expect(presentSession({ ...initialState(), launch: { kind: 'submitting' } }, store, NOW, 's2').canResume).toBe(false);
    store.sessions.s2 = { ...store.sessions.s2!, hasTranscript: false };
    expect(presentSession(initialState(), store, NOW, 's2').canResume).toBe(false);
  });
  it('終了した run でもシェルタブが残っていれば run を出し、Claude タブは alive でない', () => {
    const store = storeWith();
    store.sessions.s2 = { ...store.sessions.s2!, live: null };
    store.runs = { r1: runDto('r1', 's2', NOW) };
    store.tabs = { r1: { ...tabDto('r1', 'r1', 'agent'), sessionId: 's2' }, t1: { ...tabDto('t1', 'r1', 'shell'), sessionId: 's2' } };
    const p = presentSession(initialState(), store, NOW, 's2');
    expect(p.run).toMatchObject({ id: 'r1', alive: false });
    expect(p.canResume).toBe(true);
    expect(p.tabs.map((t) => t.id)).toEqual(['r1', 't1']);
  });
});

describe('presentNewSession', () => {
  it('オーバーレイが newSession のときだけ、解決済みでアーカイブでないプロジェクトを出す', () => {
    const store = storeWith();
    store.projects.gone = { ...project('gone'), resolved: false };
    expect(presentNewSession(initialState(), store)).toBeNull();
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: 'beta' }, launch: { kind: 'failed' as const, message: 'x' } };
    const p = presentNewSession(state, store)!;
    expect(p.projects.map((x) => x.id)).toEqual(['alpha', 'beta']);
    expect(p).toMatchObject({ projectId: 'beta', submitting: false, error: 'x' });
    expect(presentNewSession({ ...state, launch: { kind: 'submitting' } }, store)!.submitting).toBe(true);
  });
});

describe('presentSettings（フェーズ 2）', () => {
  it('ツールのパスと MCP のコマンド', () => {
    const store = storeWith();
    store.settings = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'iterm', codePath: null };
    expect(presentSettings(initialState(), store)).toMatchObject({ tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'iterm', codePath: null, mcpInstallCommand: 'npx hangar mcp install' });
    store.settings = null;
    expect(presentSettings(initialState(), store)).toMatchObject({ tmuxPath: null, terminalApp: 'terminal', codePath: null });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/presenters`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/presenters/session.ts` の型と `presentSession` を次に置き換える（`buildItems` と `TranscriptItem` はそのまま）。

```ts
import type { LiveStatus, RunKind, SessionSummaryDto, TranscriptEvent } from '@agent-hangar/shared';
import { defaultSessionView } from '../mediator/sessionView.ts';
import type { State } from '../mediator/types.ts';
import { aliveRunOf, currentRunOf, eventsKey, tabsOf, type Store } from '../store/store.ts';
import { absoluteTime, relativeTime, shortModel, SOURCE_LABEL, STATE_LABEL, tokensLabel } from './format.ts';

export type TabItemProps = { id: string; title: string; kind: 'agent' | 'shell'; selected: boolean; closable: boolean };
export type SessionProps = {
  id: string; name: string; live: LiveStatus | null; cwd: string; projectName: string | null; projectId: string | null;
  summary: (SessionSummaryDto & { sourceLabel: string; stateLabel: string }) | null; summaryOpen: boolean;
  model: string; effort: string; turns: number; tokens: string; prUrl: string | null; memo: string | null; started: string; lastActivity: string; hasTranscript: boolean;
  items: TranscriptItem[]; total: number; loaded: number; loading: boolean; hasMore: boolean; showThinking: boolean; showRaw: boolean; follow: boolean; agentId: string | null; subagents: string[]; notFound: boolean;
  run: { id: string; kind: RunKind; alive: boolean; started: string } | null; tabs: TabItemProps[]; selectedTab: string | null; transcriptOpen: boolean; trustHint: boolean; canResume: boolean; canFork: boolean;
};

export function presentSession(state: State, store: Store, now: number, id: string): SessionProps {
  const s = store.sessions[id];
  const view = state.sessionView[id] ?? defaultSessionView();
  const base = { id, live: null, cwd: '', projectName: null, projectId: null, summary: null, summaryOpen: view.summaryOpen, model: '', effort: '', turns: 0, tokens: '0', prUrl: null, memo: null, started: '', lastActivity: '', hasTranscript: false, items: [], total: 0, loaded: 0, loading: false, hasMore: false, showThinking: view.showThinking, showRaw: view.showRaw, follow: view.follow, agentId: view.agentId, subagents: store.subagents[id] ?? [], run: null, tabs: [], selectedTab: null, transcriptOpen: view.transcriptOpen, trustHint: false, canResume: false, canFork: false };
  if (!s) return { ...base, name: id, notFound: true };
  const slice = store.events[eventsKey(id, view.agentId)];
  const items = buildItems(slice?.items ?? [], { showThinking: view.showThinking, showRaw: view.showRaw, subagents: store.subagents[id] ?? [] });
  const run = currentRunOf(store, id);
  const alive = aliveRunOf(store, id) !== null;
  const open = run ? tabsOf(store, run.id) : [];
  const selectedTab = run ? (view.selectedTab && open.some((t) => t.id === view.selectedTab) ? view.selectedTab : run.id) : null;
  const tabs: TabItemProps[] = open.map((t) => ({ id: t.id, title: t.title, kind: t.kind, selected: t.id === selectedTab, closable: t.kind === 'shell' }));
  const idle = !alive && s.live === null && state.launch.kind !== 'submitting';
  return {
    ...base, name: s.name ?? '（名前なし）', live: s.live, cwd: s.cwd, projectName: s.projectId ? store.projects[s.projectId]?.name ?? null : null, projectId: s.projectId,
    summary: s.summary ? { ...s.summary, sourceLabel: SOURCE_LABEL[s.summary.source], stateLabel: STATE_LABEL[s.summary.state] } : null,
    model: shortModel(s.stats.model), effort: s.stats.effort ?? '', turns: s.stats.turns, tokens: tokensLabel(s.stats.inputTokens + s.stats.outputTokens), prUrl: s.stats.prUrl, memo: s.memo,
    started: relativeTime(s.startedAt, now), lastActivity: relativeTime(s.lastActivityAt, now), hasTranscript: s.hasTranscript,
    items, total: slice?.total ?? 0, loaded: slice?.items.length ?? 0, loading: slice?.loading ?? false, hasMore: slice ? slice.nextSeq !== null || slice.total > slice.items.length : false, notFound: false,
    run: run ? { id: run.id, kind: run.kind, alive: run.endedAt === null, started: relativeTime(run.startedAt, now) } : null,
    tabs, selectedTab, trustHint: alive && s.live === null, canResume: s.hasTranscript && idle, canFork: s.hasTranscript && idle,
  };
}
```

`packages/ui/src/presenters/newSession.ts`：

```ts
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type NewSessionProps = { projects: { id: string; name: string; path: string | null }[]; projectId: string | null; submitting: boolean; error: string | null };

export function presentNewSession(state: State, store: Store): NewSessionProps | null {
  if (state.overlay.kind !== 'newSession') return null;
  const projects = Object.values(store.projects).filter((p) => p.resolved && p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name, path: p.path }));
  return { projects, projectId: state.overlay.projectId, submitting: state.launch.kind === 'submitting', error: state.launch.kind === 'failed' ? state.launch.message : null };
}
```

`packages/ui/src/presenters/settings.ts` を次に置き換える。

```ts
import type { IndexProgressDto, TerminalApp } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type SettingsProps = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; mcpInstallCommand: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; sessionCount: number; projectCount: number };

export function presentSettings(_state: State, store: Store): SettingsProps {
  const s = store.settings;
  return { workspaceRoot: s?.workspaceRoot ?? '', claudeDir: s?.claudeDir ?? '', tmuxPath: s?.tmuxPath ?? null, terminalApp: s?.terminalApp ?? 'terminal', codePath: s?.codePath ?? null, mcpInstallCommand: 'npx hangar mcp install', device: store.device, version: store.version, index: store.index, sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length };
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/ui/src/presenters && npx tsc -p packages/ui --noEmit 2>&1 | grep -v 'Root\|views'`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/presenters
git commit -m "feat(ui): presenters for running sessions, tabs, new session dialog and tool settings"
```

---

### Task 20: NewSessionDialog とヘッダーの新規ボタン

**Files:**
- Create: `packages/ui/src/views/NewSessionDialog.tsx`
- Modify: `packages/ui/src/views/Header.tsx`、`packages/ui/src/styles/base.css`
- Test: `packages/ui/src/views/NewSessionDialog.test.tsx`、`packages/ui/src/views/Shell.test.tsx`（追加）

**Interfaces:**
- Consumes: `NewSessionProps`（Task 19）、`Fold`、`useEmit`。
- Produces:
  ```tsx
  export function NewSessionDialog(props: NewSessionProps): JSX.Element;   // 起動で session.new.submit、やめると Esc で overlay.close
  ```
- 必須はプロジェクトだけで、名前と初期プロンプトは任意。model、effort、permission mode、worktree、追加ディレクトリは `Fold` の中に置き、空欄は `params` に含めない。送信中はボタンを無効にして「起動しています」を出す。`error` は `role="alert"` で出す。名前欄の `id` は `new-session-name`（`focus(newSessionName)` の対象）。
- ヘッダーの右端に「新規セッション」ボタンを置き、`session.new.open` を出す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/NewSessionDialog.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';

const projects = [{ id: 'p1', name: 'alpha', path: '/w/alpha' }, { id: 'p2', name: 'beta', path: '/w/beta' }];

describe('NewSessionDialog', () => {
  it('プロジェクトを選ぶまで起動できず、選んで起動すると params を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog projects={projects} projectId={null} submitting={false} error={null} /></IntentRoot>);
    const start = screen.getByRole('button', { name: '起動' });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText('プロジェクト'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('初期プロンプト'), { target: { value: 'やって' } });
    fireEvent.change(screen.getByLabelText('model'), { target: { value: 'opus' } });
    fireEvent.change(screen.getByLabelText('追加ディレクトリ'), { target: { value: '/a\n\n/b\n' } });
    fireEvent.click(start);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.submit', params: { projectId: 'p1', name: 'n', prompt: 'やって', model: 'opus', addDirs: ['/a', '/b'] } });
  });
  it('初期プロジェクトが選ばれ、Esc とやめるで閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog projects={projects} projectId="p2" submitting={false} error={null} /></IntentRoot>);
    expect((screen.getByLabelText('プロジェクト') as HTMLSelectElement).value).toBe('p2');
    expect(screen.getByRole('button', { name: '起動' })).toBeEnabled();
    fireEvent.click(screen.getByText('やめる'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onIntent).toHaveBeenCalledTimes(2);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('送信中と失敗の表示', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog projects={projects} projectId="p1" submitting error="tmux が見つかりません" /></IntentRoot>);
    expect(screen.getByRole('button', { name: '起動しています' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が見つかりません');
    expect(screen.getByText(/信頼確認/)).toBeInTheDocument();
  });
});
```

`packages/ui/src/views/Shell.test.tsx` の最初の `it` の末尾に足す。

```tsx
    fireEvent.click(screen.getByRole('button', { name: '新規セッション' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open' });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/NewSessionDialog packages/ui/src/views/Shell`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/views/NewSessionDialog.tsx`：

```tsx
import { useState } from 'react';
import type { LaunchParams } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { Fold } from './primitives/Fold.tsx';

const or = (v: string): string | undefined => (v.trim() ? v.trim() : undefined);

/** 起動ダイアログ。必須はプロジェクトだけで、空欄は params に含めない（Claude Code の設定に従う）。 */
export function NewSessionDialog(props: NewSessionProps) {
  const emit = useEmit();
  const [projectId, setProjectId] = useState(props.projectId ?? '');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [worktree, setWorktree] = useState('');
  const [addDirs, setAddDirs] = useState('');
  const submit = () => {
    const dirs = addDirs.split('\n').map((d) => d.trim()).filter(Boolean);
    const params: LaunchParams = { projectId: projectId || undefined, name: or(name), prompt: or(prompt), model: or(model), effort: or(effort), permissionMode: or(permissionMode), worktree: or(worktree), addDirs: dirs.length ? dirs : undefined };
    emit({ type: 'session.new.submit', params });
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="新しいセッション" onKeyDown={(e) => { if (e.key === 'Escape') emit({ type: 'overlay.close' }); }}>
      <div className="dialog" style={{ width: 560 }}>
        <b>新しいセッション</b>
        <label className="field">プロジェクト
          <select className="select" aria-label="プロジェクト" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">選んでください</option>
            {props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.path ? `　${p.path}` : ''}</option>)}
          </select>
        </label>
        <label className="field">名前（任意）<input id="new-session-name" className="input" aria-label="名前" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude の -n に渡す表示名" /></label>
        <label className="field">初期プロンプト（任意）<textarea className="input" aria-label="初期プロンプト" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        <Fold summary="詳細（model、effort、permission mode、worktree、追加ディレクトリ）">
          <div className="grid2">
            <label className="field">model<input className="input mono" aria-label="model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="空なら Claude Code の設定" /></label>
            <label className="field">effort<input className="input mono" aria-label="effort" value={effort} onChange={(e) => setEffort(e.target.value)} /></label>
            <label className="field">permission mode<input className="input mono" aria-label="permission mode" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)} /></label>
            <label className="field">worktree<input className="input mono" aria-label="worktree" value={worktree} onChange={(e) => setWorktree(e.target.value)} /></label>
          </div>
          <label className="field">追加ディレクトリ（1 行 1 つ）<textarea className="input mono" aria-label="追加ディレクトリ" rows={2} value={addDirs} onChange={(e) => setAddDirs(e.target.value)} /></label>
        </Fold>
        <div className="faint">新しいディレクトリでは Claude が信頼確認のダイアログを出します。起動後にターミナルで答えてください。</div>
        {props.error && <div className="error" role="alert">{props.error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <span className="spacer" />
          <button className="btn btn-primary" disabled={!projectId || props.submitting} onClick={submit}>{props.submitting ? '起動しています' : '起動'}</button>
        </div>
      </div>
    </div>
  );
}
```

`packages/ui/src/views/Header.tsx` の `<span className="spacer" />` の直後に足す。

```tsx
      <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open' })}>新規セッション</button>
```

`packages/ui/src/styles/base.css` の末尾に足す。

```css
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-2); }
.field .input, .field .select { color: var(--ink); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.error { color: var(--error); font-size: 12px; }
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/ui/src/views && npx tsc -p packages/ui --noEmit 2>&1 | grep -v 'Root\|SessionScreen'`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/views packages/ui/src/styles
git commit -m "feat(ui): new session dialog with folded advanced options and header launch button"
```

---

### Task 21: TabStrip、TerminalPane、実行中の SessionScreen

**Files:**
- Create: `packages/ui/src/views/TabStrip.tsx`、`packages/ui/src/views/TerminalPane.tsx`
- Modify: `packages/ui/src/views/SessionScreen.tsx`、`packages/ui/src/styles/tokens.css`、`packages/ui/src/styles/base.css`
- Test: `packages/ui/src/views/TerminalPane.test.tsx`、`packages/ui/src/views/SessionScreen.test.tsx`（追加と修正）

**Interfaces:**
- Consumes: `SessionProps`、`TabItemProps`（Task 19）、`TerminalHost`、`TerminalStatus`（Task 18）、`Transcript`、`StatusDot`、`Fold`。
- Produces:
  ```tsx
  export const TerminalHostContext: React.Context<TerminalHost | null>;
  export function TabStrip(props: { sessionId: string; tabs: TabItemProps[]; canAdd: boolean }): JSX.Element;   // クリックで tab.select、× で tab.close、＋ で tab.open(shell)
  export function TerminalPane(props: { tabId: string; status: TerminalStatus | null; hint: string | null }): JSX.Element;   // Host に要素を渡す。ResizeObserver で fit
  export function SessionScreen(props: SessionProps & { terminalStatus: TerminalStatus | null }): JSX.Element;
  ```
- 実行中（`run` があり `selectedTab` がある）の配置：ヘッダー、要約、`TabStrip`、`split`（左にターミナル、右にトランスクリプト）。トランスクリプトのペーンは `transcript.toggle` で 28px に折りたたむ。ヘッダーの操作は「ターミナルで開く」（`session.openTerminalApp` に `runId` と選択中の `tabId`）と「停止」（`session.kill`）で、run が生きているときだけ出す。「再開」と「フォーク」は `canResume` と `canFork` で無効にする。
- ヒント：Claude タブを選んでいて `trustHint` なら「Claude の起動を待っています。信頼確認のダイアログが出ていればターミナルで答えてください。」、run が終了していれば「Claude は終了しました。シェルタブは残っています。」。
- xterm.js は import しない。テストは `TerminalHostContext` に偽の Host を入れる。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/TerminalPane.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalHost } from '../runtime/terminals.ts';
import { TerminalHostContext, TerminalPane } from './TerminalPane.tsx';

function fakeHost(): TerminalHost & { mount: ReturnType<typeof vi.fn> } {
  return { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), subscribe: () => () => {}, dispose: vi.fn() };
}

describe('TerminalPane', () => {
  it('マウント先の要素を Host に渡し、案内と状態を出す', () => {
    const host = fakeHost();
    const { rerender } = render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" status="connected" hint="待っています" /></TerminalHostContext.Provider>);
    expect(host.mount).toHaveBeenCalledTimes(1);
    expect(host.mount.mock.calls[0]![0]).toBe('t1');
    expect((host.mount.mock.calls[0]![1] as HTMLElement).dataset.tab).toBe('t1');
    expect(screen.getByRole('status')).toHaveTextContent('待っています');
    rerender(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t2" status="closed" hint={null} /></TerminalHostContext.Provider>);
    expect(host.mount).toHaveBeenCalledTimes(2);
    expect(screen.getByText('接続していません')).toBeInTheDocument();
  });
  it('Host が無ければ描くだけで落ちない', () => {
    render(<TerminalPane tabId="t1" status={null} hint={null} />);
    expect(document.querySelector('.term-host')).not.toBeNull();
  });
});
```

`packages/ui/src/views/SessionScreen.test.tsx` を直す。
`base` に `run: null, tabs: [], selectedTab: null, transcriptOpen: true, trustHint: false, canResume: true, canFork: true` を足し、`render` の `<SessionScreen {...base} />` はすべて `<SessionScreen {...base} terminalStatus={null} />` にする。
「本文が無いセッションは再開を無効にする」では `hasTranscript={false}` に加えて `canResume={false} canFork={false}` を渡す。
次の `describe` を足す。

```tsx
import type { TerminalHost } from '../runtime/terminals.ts';
import { TerminalHostContext } from './TerminalPane.tsx';

const host: TerminalHost = { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => 'connected', fit: vi.fn(), focus: vi.fn(), subscribe: () => () => {}, dispose: vi.fn() };
const running: SessionProps = { ...base, live: 'busy', run: { id: 'r1', kind: 'start', alive: true, started: '1 分前' }, selectedTab: 'r1', canResume: false, canFork: false,
  tabs: [{ id: 'r1', title: 'Claude', kind: 'agent', selected: true, closable: false }, { id: 't1', title: 'シェル 1', kind: 'shell', selected: false, closable: true }] };
const withHost = (ui: React.ReactElement, onIntent = vi.fn()) => { render(<IntentRoot onIntent={onIntent}><TerminalHostContext.Provider value={host}>{ui}</TerminalHostContext.Provider></IntentRoot>); return onIntent; };

describe('SessionScreen（実行中）', () => {
  it('タブ列、ターミナル、トランスクリプトの折りたたみ、停止とターミナルで開く', () => {
    const onIntent = withHost(<SessionScreen {...running} terminalStatus="connected" />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(host.mount).toHaveBeenCalledWith('r1', expect.anything());
    fireEvent.click(screen.getByRole('tab', { name: /シェル 1/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'tab.select', tabId: 't1' });
    fireEvent.click(screen.getByLabelText('シェル 1 を閉じる'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'tab.close', tabId: 't1' });
    fireEvent.click(screen.getByLabelText('シェルタブを追加'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'tab.open', sessionId: 's1', kind: 'shell' });
    fireEvent.click(screen.getByText('停止'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.kill', runId: 'r1' });
    fireEvent.click(screen.getByText('ターミナルで開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.openTerminalApp', runId: 'r1', tabId: 'r1' });
    fireEvent.click(screen.getByLabelText('トランスクリプトを閉じる'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.toggle' });
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('再開')).toBeDisabled();
  });
  it('折りたたむとトランスクリプトを描かない', () => {
    withHost(<SessionScreen {...running} transcriptOpen={false} terminalStatus="connected" />);
    expect(screen.queryByText('hi')).toBeNull();
    expect(screen.getByLabelText('トランスクリプトを開く')).toBeInTheDocument();
  });
  it('信頼ダイアログの案内と終了の表示', () => {
    withHost(<SessionScreen {...running} live={null} trustHint terminalStatus="connected" />);
    expect(screen.getByRole('status')).toHaveTextContent('信頼確認');
    cleanup();
    withHost(<SessionScreen {...running} live={null} run={{ ...running.run!, alive: false }} canResume terminalStatus="closed" />);
    expect(screen.getByRole('status')).toHaveTextContent('Claude は終了しました');
    expect(screen.queryByText('停止')).toBeNull();
    expect(screen.getByText('再開')).toBeEnabled();
  });
});
```

`import { cleanup, fireEvent, render, screen } from '@testing-library/react';` に `cleanup` を足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/TerminalPane packages/ui/src/views/SessionScreen`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/views/TabStrip.tsx`：

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { TabItemProps } from '../presenters/session.ts';

/** タブ 0 が Claude、以降がシェル。並び替えは持たない。 */
export function TabStrip(props: { sessionId: string; tabs: TabItemProps[]; canAdd: boolean }) {
  const emit = useEmit();
  return (
    <div className="tabs" role="tablist">
      {props.tabs.map((t) => (
        <div key={t.id} className={`tab${t.selected ? ' tab-selected' : ''}`} role="tab" aria-selected={t.selected} tabIndex={0}
          onClick={() => emit({ type: 'tab.select', tabId: t.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'tab.select', tabId: t.id }); }}>
          <span>{t.title}</span>
          {t.closable && <button className="tab-close" aria-label={`${t.title} を閉じる`} onClick={(e) => { e.stopPropagation(); emit({ type: 'tab.close', tabId: t.id }); }}>×</button>}
        </div>
      ))}
      {props.canAdd && <button className="tab-add" aria-label="シェルタブを追加" onClick={() => emit({ type: 'tab.open', sessionId: props.sessionId, kind: 'shell' })}>＋</button>}
    </div>
  );
}
```

`packages/ui/src/views/TerminalPane.tsx`：

```tsx
import { createContext, useContext, useEffect, useRef } from 'react';
import type { TerminalHost, TerminalStatus } from '../runtime/terminals.ts';

export const TerminalHostContext = createContext<TerminalHost | null>(null);

/** xterm を直接は持たない。マウント先の要素を TerminalHost に渡すだけで、接続と描画は Host が行う。 */
export function TerminalPane(props: { tabId: string; status: TerminalStatus | null; hint: string | null }) {
  const host = useContext(TerminalHostContext);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!host || !el) return;
    host.mount(props.tabId, el);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => host.fit(props.tabId));
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [host, props.tabId]);
  return (
    <div className="term-pane">
      {props.hint && <div className="term-hint" role="status">{props.hint}</div>}
      <div ref={ref} className="term-host" data-tab={props.tabId} onClick={() => host?.focus(props.tabId)} />
      {props.status === 'closed' && <div className="term-status">接続していません</div>}
      {props.status === 'connecting' && <div className="term-status">接続しています</div>}
      {props.status === 'error' && <div className="term-status term-status-error">ターミナルに接続できませんでした</div>}
    </div>
  );
}
```

`packages/ui/src/views/SessionScreen.tsx` を次に置き換える。

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { SessionProps } from '../presenters/session.ts';
import type { TerminalStatus } from '../runtime/terminals.ts';
import { StatusDot } from './primitives/StatusDot.tsx';
import { TabStrip } from './TabStrip.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { Transcript } from './Transcript.tsx';

const TRUST_HINT = 'Claude の起動を待っています。信頼確認のダイアログが出ていればターミナルで答えてください。';
const ENDED_HINT = 'Claude は終了しました。シェルタブは残っています。';

export function SessionScreen(props: SessionProps & { terminalStatus: TerminalStatus | null }) {
  const emit = useEmit();
  if (props.notFound) return <div className="screen"><div className="empty">セッションが見つかりません</div></div>;
  const id = props.id;
  const run = props.run;

  const header = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <StatusDot status={props.live} />
        <h1 className="h1" style={{ margin: 0 }}>{props.name}</h1>
        {props.projectName && <a href="#" onClick={(e) => { e.preventDefault(); if (props.projectId) emit({ type: 'project.open', id: props.projectId }); }}>{props.projectName}</a>}
        <span className="spacer" />
        {run?.alive && <button className="btn" onClick={() => emit({ type: 'session.openTerminalApp', runId: run.id, tabId: props.selectedTab ?? undefined })}>ターミナルで開く</button>}
        {run?.alive && <button className="btn" onClick={() => emit({ type: 'session.kill', runId: run.id })}>停止</button>}
        <button className="btn" disabled={!props.canResume} onClick={() => emit({ type: 'session.resume', id })}>再開</button>
        <button className="btn" disabled={!props.canFork} onClick={() => emit({ type: 'session.fork', id })}>フォーク</button>
        <button className="btn" onClick={() => emit({ type: 'session.openEditor', sessionId: id })}>VS Code で開く</button>
      </div>
      <div className="mono faint" style={{ display: 'flex', gap: 16, margin: '4px 0 8px', flexWrap: 'wrap' }}>
        <span>{props.cwd}</span><span>{props.model}{props.effort ? ` · ${props.effort}` : ''}</span><span>{props.turns} ターン</span><span>{props.tokens} tokens</span>
        {props.prUrl && <a href={props.prUrl} target="_blank" rel="noreferrer">PR</a>}
        <span>開始 {props.started}</span><span>最終 {props.lastActivity}</span>
        {run && <span>run {run.kind} {run.started}</span>}
        {!props.hasTranscript && <span>本文がありません</span>}
      </div>
    </>
  );

  const summary = props.summary && (
    <div className="list" style={{ padding: '8px 12px', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        <b>{props.summary.title}</b><span className="muted">{props.summary.oneLiner}</span><span className="faint">{props.summary.stateLabel}</span>
        <span className="spacer" /><button className="btn" onClick={() => emit({ type: 'summary.toggle', sessionId: id })}>{props.summaryOpen ? '閉じる' : '詳細'}</button>
      </div>
      {props.summaryOpen && (
        <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
          <div>{props.summary.body}</div>
          {props.summary.nextSteps.length > 0 && <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>{props.summary.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <div className="faint" style={{ marginTop: 8 }}>出所 <span>{props.summary.sourceLabel}</span>、{props.summary.basedOnTurns} ターン時点</div>
        </div>
      )}
    </div>
  );

  const toggles = (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 4 }}>
      <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" aria-label="思考を表示" checked={props.showThinking} onChange={(e) => emit({ type: 'transcript.showThinking', sessionId: id, show: e.target.checked })} />思考を表示</label>
      <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" aria-label="生の記録を表示" checked={props.showRaw} onChange={(e) => emit({ type: 'transcript.showRaw', sessionId: id, show: e.target.checked })} />生の記録</label>
      {props.subagents.length > 0 && (
        <select className="select" aria-label="サブエージェント" value={props.agentId ?? ''} onChange={(e) => emit({ type: 'transcript.selectAgent', sessionId: id, agentId: e.target.value || null })}>
          <option value="">主線</option>{props.subagents.map((a) => <option key={a} value={a}>サブエージェント {a}</option>)}
        </select>
      )}
      <span className="spacer" /><span className="faint mono">{props.loaded} / {props.total}</span>
    </div>
  );

  const transcript = <Transcript sessionId={id} items={props.items} hasMore={props.hasMore} loading={props.loading} follow={props.follow} live={props.live !== null} remaining={Math.max(props.total - props.loaded, 0)} />;

  if (run && props.selectedTab) {
    const agentSelected = props.selectedTab === run.id;
    const hint = agentSelected && props.trustHint ? TRUST_HINT : agentSelected && !run.alive ? ENDED_HINT : null;
    return (
      <div className="screen">
        {header}{summary}
        <TabStrip sessionId={id} tabs={props.tabs} canAdd />
        <div className="split" style={{ gridTemplateColumns: props.transcriptOpen ? 'minmax(0, 1fr) minmax(320px, 38%)' : 'minmax(0, 1fr) 28px' }}>
          <TerminalPane tabId={props.selectedTab} status={props.terminalStatus} hint={hint} />
          <aside className="tr-pane">
            <button className="tr-toggle" aria-label={props.transcriptOpen ? 'トランスクリプトを閉じる' : 'トランスクリプトを開く'} onClick={() => emit({ type: 'transcript.toggle' })}>{props.transcriptOpen ? '⟩' : '⟨'}</button>
            {props.transcriptOpen && <>{toggles}{transcript}</>}
          </aside>
        </div>
      </div>
    );
  }
  return <div className="screen">{header}{summary}{toggles}{transcript}</div>;
}
```

`packages/ui/src/styles/tokens.css` の `:root` に `--term-bg: #1c1b19; --term-fg: #e8e6e1;` を足す（UI はライトだが、ターミナルは暗い面にする）。

`packages/ui/src/styles/base.css` の末尾に足す。

```css
.tabs { display: flex; align-items: flex-end; gap: 2px; border-bottom: 1px solid var(--line); height: var(--row-h); margin-bottom: 8px; }
.tab { display: flex; align-items: center; gap: 6px; padding: 0 12px; height: var(--row-h); border-bottom: 2px solid transparent; cursor: pointer; color: var(--ink-2); transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur-fast) var(--ease); }
.tab:hover { background: var(--surface-2); }
.tab-selected { color: var(--ink); border-bottom-color: var(--accent); }
.tab-close, .tab-add { border: 0; background: transparent; color: var(--ink-2); cursor: pointer; height: 20px; width: 20px; border-radius: var(--r); }
.tab-close:hover, .tab-add:hover { background: var(--surface-2); color: var(--ink); }
.split { display: grid; gap: 8px; height: calc(100vh - 240px); transition: grid-template-columns var(--dur-slow) var(--ease); }
.term-pane { position: relative; display: flex; flex-direction: column; min-width: 0; background: var(--term-bg); border-radius: var(--r-lg); overflow: hidden; }
.term-host { flex: 1; min-height: 0; padding: 4px; }
.term-hint { padding: 4px 12px; background: var(--waiting); color: #fff; font-size: 12px; }
.term-status { position: absolute; right: 8px; bottom: 8px; font-size: 11px; color: var(--term-fg); opacity: 0.7; }
.term-status-error { color: var(--error); opacity: 1; }
.tr-pane { min-width: 0; border-left: 1px solid var(--line); padding-left: 8px; overflow: hidden; display: flex; flex-direction: column; }
.tr-pane .tr { height: auto; flex: 1; }
.tr-toggle { border: 0; background: transparent; cursor: pointer; color: var(--ink-2); height: var(--row-h); align-self: flex-start; }
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/ui/src/views && npx tsc -p packages/ui --noEmit 2>&1 | grep -v 'Root'`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/views packages/ui/src/styles
git commit -m "feat(ui): tab strip, terminal pane over the terminal host and running session layout"
```

---

### Task 22: Settings、プロジェクト画面の操作、Root と main の結線

**Files:**
- Modify: `packages/ui/src/views/SettingsScreen.tsx`、`packages/ui/src/views/ProjectScreen.tsx`、`packages/ui/src/Root.tsx`、`packages/ui/src/main.tsx`
- Test: `packages/ui/src/views/misc.test.tsx`（追加）、`packages/ui/src/views/HomeScreen.test.tsx`（ProjectScreen の期待の修正）、`packages/ui/src/Root.test.tsx`（追加）

**Interfaces:**
- Consumes: `SettingsProps`（Task 19）、`NewSessionDialog`、`presentNewSession`、`TerminalHostContext`、`TerminalHost`。
- Produces:
  ```tsx
  export function Root(props: { runtime: Runtime; api?: ApiClient; terminals: TerminalHost }): JSX.Element;
  ```
- Settings に「ツール」の節（tmux のパス、ターミナルアプリ、code のパス、保存で `settings.update`）と「MCP」の節（`npx hangar mcp install` の案内）を足す。
- ProjectScreen の「VS Code で開く」と「ターミナルで開く」は `project.openEditor` と `project.openTerminalApp` を出す。
- Root は `TerminalHostContext` を供給し、`overlay.newSession` で `NewSessionDialog` を描き、`terminals.subscribe` で再描画して `terminalStatus` を `SessionScreen` に渡し、⌘N で `session.new.open` を出す。`/` と ⌘K のキー処理はフェーズ 1 のままで、xterm の入力欄は `TEXTAREA` なので `/` は横取りしない。
- `main.tsx` は `createTerminalHost({ wsUrl, createTerminal: createXterm })` を作り、ランタイムと Root に渡す。`focus` は次のフレームで `#global-search` か `#new-session-name` に当てる。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/misc.test.tsx` の `SettingsScreen` の `describe` に足す。`render` の props に `tmuxPath="/opt/homebrew/bin/tmux" terminalApp="terminal" codePath={null} mcpInstallCommand="npx hangar mcp install"` を足す。

```tsx
  it('ツールのパスとターミナルアプリを保存する', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen workspaceRoot="/w" claudeDir="/c" tmuxPath="/opt/homebrew/bin/tmux" terminalApp="terminal" codePath={null} mcpInstallCommand="npx hangar mcp install" device={{ id: 'd', name: 'mac' }} version="0.2.0" index={{ phase: 'idle', done: 3, total: 3 }} sessionCount={3} projectCount={1} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('ターミナルアプリ'), { target: { value: 'iterm' } });
    fireEvent.change(screen.getByLabelText('code のパス'), { target: { value: '/usr/local/bin/code' } });
    fireEvent.click(screen.getByText('ツールの設定を保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'iterm', codePath: '/usr/local/bin/code' } });
    expect(screen.getByText('npx hangar mcp install')).toBeInTheDocument();
  });
```

フェーズ 1 の計画の Task 23 で作った `packages/ui/src/views/HomeScreen.test.tsx` で `ProjectScreen` の「VS Code で開く」と「ターミナルで開く」を押している箇所があれば、期待を `{ type: 'project.openEditor', id: 'alpha' }` と `{ type: 'project.openTerminalApp', id: 'alpha' }` に直す。無ければ次を足す。

```tsx
  it('プロジェクトの操作は project.* の Intent', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" sessions={[]} notFound={false} /></IntentRoot>);
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openEditor', id: 'alpha' });
    fireEvent.click(screen.getByText('ターミナルで開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openTerminalApp', id: 'alpha' });
  });
```

`packages/ui/src/Root.test.tsx` の `make()` に `terminals` を足し、`render(<Root runtime={rt} api={deps.api} terminals={terminals} />)` に変える。

```tsx
import type { TerminalHost } from './runtime/terminals.ts';
const terminals: TerminalHost = { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), subscribe: () => () => {}, dispose: vi.fn() };
```

`deps` に `terminals` を足し、次の `it` を足す。

```tsx
  it('⌘N と新規ボタンで起動ダイアログが開き、閉じられる', async () => {
    const { rt, deps, handlers } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    act(() => handlers[0]!.onOpen());
    await flush();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true })); });
    expect(screen.getByRole('dialog', { name: '新しいセッション' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /alpha/ })).toBeInTheDocument();
    fireEvent.click(screen.getByText('やめる'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
```

`import { act, fireEvent, render, screen } from '@testing-library/react';` に `fireEvent` を足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/misc packages/ui/src/views/HomeScreen packages/ui/src/Root`
Expected: FAIL

- [ ] **Step 3: SettingsScreen と ProjectScreen を直す**

`packages/ui/src/views/SettingsScreen.tsx` を次に置き換える。

```tsx
import { useState } from 'react';
import type { TerminalApp } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { SettingsProps } from '../presenters/settings.ts';

export function SettingsScreen(props: SettingsProps) {
  const emit = useEmit();
  const [ws, setWs] = useState(props.workspaceRoot);
  const [tmuxPath, setTmuxPath] = useState(props.tmuxPath ?? '');
  const [terminalApp, setTerminalApp] = useState<TerminalApp>(props.terminalApp);
  const [codePath, setCodePath] = useState(props.codePath ?? '');
  return (
    <div className="screen" style={{ maxWidth: 720 }}>
      <h1 className="h1">Settings</h1>
      <section>
        <h2 className="h2">ワークスペース</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input mono" style={{ flex: 1 }} aria-label="ワークスペースのルート" value={ws} onChange={(e) => setWs(e.target.value)} />
          <button className="btn btn-primary" onClick={() => emit({ type: 'settings.update', patch: { workspaceRoot: ws } })}>保存</button>
        </div>
        <div className="faint" style={{ marginTop: 4 }}>直下のディレクトリのうち、Claude のセッションがあるものをプロジェクトとして登録します。</div>
      </section>
      <section>
        <h2 className="h2">ツール</h2>
        <div className="grid2">
          <label className="field">tmux のパス<input className="input mono" aria-label="tmux のパス" value={tmuxPath} onChange={(e) => setTmuxPath(e.target.value)} placeholder="見つかりません。brew install tmux の後にパスを入れてください" /></label>
          <label className="field">ターミナルアプリ
            <select className="select" aria-label="ターミナルアプリ" value={terminalApp} onChange={(e) => setTerminalApp(e.target.value as TerminalApp)}>
              <option value="terminal">Terminal.app</option><option value="iterm">iTerm2</option>
            </select>
          </label>
          <label className="field">code のパス<input className="input mono" aria-label="code のパス" value={codePath} onChange={(e) => setCodePath(e.target.value)} placeholder="VS Code の code コマンド" /></label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" onClick={() => emit({ type: 'settings.update', patch: { tmuxPath: tmuxPath.trim() || null, terminalApp, codePath: codePath.trim() || null } })}>ツールの設定を保存</button>
        </div>
        <div className="faint" style={{ marginTop: 4 }}>iTerm2 は AppleScript で開くため、初回に macOS の自動化の許可ダイアログが出ます。失敗したときは Terminal.app で開きます。</div>
      </section>
      <section>
        <h2 className="h2">MCP</h2>
        <div className="muted">Claude Code の user スコープに hangar の MCP サーバを登録すると、どのセッションからも検索と要約が使えます。ターミナルで次を実行してください。</div>
        <pre className="mono" style={{ margin: '8px 0 0' }}>{props.mcpInstallCommand}</pre>
      </section>
      <section>
        <h2 className="h2">索引</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="mono muted">{props.index.phase === 'idle' ? `${props.sessionCount} セッション、${props.projectCount} プロジェクト` : `${props.index.phase} ${props.index.done} / ${props.index.total}`}</span>
          <button className="btn" onClick={() => emit({ type: 'index.rebuild' })}>索引を作り直す</button>
        </div>
        <div className="faint mono" style={{ marginTop: 4 }}>読み取り元 {props.claudeDir}</div>
      </section>
      <section>
        <h2 className="h2">この端末</h2>
        <div className="mono muted">{props.device?.name}<span className="faint"> {props.device?.id}</span></div>
        <div className="faint mono">agent-hangar {props.version}</div>
      </section>
      <section>
        <h2 className="h2">次のフェーズで追加される設定</h2>
        <div className="faint">statusline への追記、要約器、クラウド同期。</div>
      </section>
    </div>
  );
}
```

`packages/ui/src/views/ProjectScreen.tsx` の 2 つのボタンを置き換える。

```tsx
          <button className="btn" onClick={() => emit({ type: 'project.openEditor', id: props.id })}>VS Code で開く</button>
          <button className="btn" onClick={() => emit({ type: 'project.openTerminalApp', id: props.id })}>ターミナルで開く</button>
```

- [ ] **Step 4: Root と main を直す**

`packages/ui/src/Root.tsx` を次に置き換える。

```tsx
import { useEffect, useReducer, useState } from 'react';
import { useRuntime } from './hooks/useRuntime.ts';
import { IntentRoot } from './intent/chain.tsx';
import { presentHome } from './presenters/home.ts';
import { presentNewSession } from './presenters/newSession.ts';
import { presentProject } from './presenters/project.ts';
import { presentProjects } from './presenters/projects.ts';
import { presentSession } from './presenters/session.ts';
import { presentSessions } from './presenters/sessions.ts';
import { presentSettings } from './presenters/settings.ts';
import { presentShell } from './presenters/shell.ts';
import { createApi, type ApiClient } from './runtime/api.ts';
import type { Runtime } from './runtime/runtime.ts';
import type { TerminalHost } from './runtime/terminals.ts';
import { HomeScreen } from './views/HomeScreen.tsx';
import { NewSessionDialog } from './views/NewSessionDialog.tsx';
import { ProjectScreen } from './views/ProjectScreen.tsx';
import { ProjectsScreen } from './views/ProjectsScreen.tsx';
import { ResolveProjectDialog } from './views/ResolveProjectDialog.tsx';
import { SessionScreen } from './views/SessionScreen.tsx';
import { SessionsScreen } from './views/SessionsScreen.tsx';
import { SettingsScreen } from './views/SettingsScreen.tsx';
import { Shell } from './views/Shell.tsx';
import { TerminalHostContext } from './views/TerminalPane.tsx';
import { ToastStack } from './views/ToastStack.tsx';

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

/** TerminalHost の状態が変わるたびに再描画する。 */
function useTerminalHost(host: TerminalHost): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => host.subscribe(force), [host]);
}

export function Root(props: { runtime: Runtime; api?: ApiClient; terminals: TerminalHost }) {
  const rt = props.runtime;
  const { state, store } = useRuntime(rt);
  const now = useNow();
  useTerminalHost(props.terminals);
  const [projectFilter, setProjectFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);

  // トーストは 5 秒で消す。
  useEffect(() => {
    if (state.toasts.length === 0) return;
    const t = setTimeout(() => rt.emit({ type: 'toast.dismiss', id: state.toasts[0]!.id }), 5000);
    return () => clearTimeout(t);
  }, [state.toasts, rt]);

  // 未解決ダイアログの候補は Root が API を直接引く（ダイアログの中だけで使う一時データ）。
  const overlay = state.overlay;
  const unresolvedId = overlay.kind === 'resolveProject' ? overlay.projectId : null;
  const queryCandidates = (name: string) => { if (unresolvedId) (props.api ?? apiFromRuntime(rt)).candidates(unresolvedId, name).then(setCandidates).catch(() => setCandidates([])); };
  useEffect(() => { if (unresolvedId) queryCandidates(store.projects[unresolvedId]?.name ?? ''); else setCandidates([]); }, [unresolvedId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // キーボード：/ で検索、⌘K でパレット、⌘N で新規セッション。xterm の入力欄は TEXTAREA なので / は横取りしない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === '/' && !typing) { e.preventDefault(); document.getElementById('global-search')?.focus(); }
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); rt.emit({ type: 'palette.open' }); }
      if (e.key === 'n' && (e.metaKey || e.ctrlKey) && !e.shiftKey) { e.preventDefault(); rt.emit({ type: 'session.new.open' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rt]);

  const shell = presentShell(state, store);
  let body: React.ReactNode;
  if (!store.bootstrapped || state.screen.name === 'booting') body = <div className="empty">読み込んでいます</div>;
  else switch (state.screen.name) {
    case 'home': body = <HomeScreen {...presentHome(state, store, now)} />; break;
    case 'projects': body = <ProjectsScreen {...presentProjects(state, store, now, projectFilter, showArchived)} filter={projectFilter} showArchived={showArchived} onFilter={setProjectFilter} onShowArchived={setShowArchived} />; break;
    case 'project': body = <ProjectScreen {...presentProject(state, store, now, state.screen.id)} />; break;
    case 'session': {
      const p = presentSession(state, store, now, state.screen.id);
      body = <SessionScreen {...p} terminalStatus={p.selectedTab ? props.terminals.status(p.selectedTab) : null} />;
      break;
    }
    case 'sessions': body = <SessionsScreen {...presentSessions(state, store, now)} />; break;
    case 'settings': body = <SettingsScreen {...presentSettings(state, store)} />; break;
  }

  const newSession = presentNewSession(state, store);
  const overlays = (
    <>
      {unresolvedId && <ResolveProjectDialog projectId={unresolvedId} name={store.projects[unresolvedId]?.name ?? unresolvedId} path={store.projects[unresolvedId]?.path ?? null} candidates={candidates} onQueryCandidates={queryCandidates} />}
      {newSession && <NewSessionDialog key={newSession.projectId ?? ''} {...newSession} />}
      {overlay.kind === 'palette' && <div className="overlay" onClick={() => rt.emit({ type: 'palette.close' })}><div className="dialog" onClick={(e) => e.stopPropagation()}><b>コマンドパレット</b><div className="faint">次のフェーズで使えるようになります。Esc か外側のクリックで閉じます。</div></div></div>}
      <ToastStack toasts={state.toasts} />
    </>
  );

  return (
    <IntentRoot onIntent={rt.emit}>
      <TerminalHostContext.Provider value={props.terminals}>
        <Shell {...shell} overlays={overlays}>{body}</Shell>
      </TerminalHostContext.Provider>
    </IntentRoot>
  );
}

const apiCache = new WeakMap<Runtime, ApiClient>();
function apiFromRuntime(rt: Runtime): ApiClient {
  let a = apiCache.get(rt);
  if (!a) { a = createApi(); apiCache.set(rt, a); }
  return a;
}
```

`packages/ui/src/main.tsx` を次に置き換える。

```tsx
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import { Root } from './Root.tsx';
import { createApi } from './runtime/api.ts';
import { createRuntime } from './runtime/runtime.ts';
import { createTerminalHost } from './runtime/terminals.ts';
import { createWs } from './runtime/ws.ts';
import { createXterm } from './runtime/xterm.ts';

const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const api = createApi();
const terminals = createTerminalHost({ wsUrl: (tab) => `${wsProto}://${location.host}/ws/pty?tab=${encodeURIComponent(tab)}`, createTerminal: createXterm });
const runtime = createRuntime({
  api,
  ws: (h) => createWs({ url: `${wsProto}://${location.host}/ws`, ...h }),
  location: { getHash: () => location.hash, setHash: (h) => { location.hash = h; }, onHashChange: (cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); } },
  storage: {
    get: (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量超過などは無視 */ } },
    keys: () => { try { return Object.keys(localStorage); } catch { return []; } },
  },
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  terminals,
  // ダイアログは状態が変わった次の描画で現れるので、フォーカスは次のフレームで当てる。
  focus: (t) => requestAnimationFrame(() => document.getElementById(t === 'search' ? 'global-search' : 'new-session-name')?.focus()),
});
runtime.start();
createRoot(document.getElementById('root')!).render(<Root runtime={runtime} api={api} terminals={terminals} />);
```

開発時の Vite のプロキシはフェーズ 1 の `'/ws'` の設定が前方一致で `/ws/pty` にも効くので、`vite.config.ts` は変えない。

- [ ] **Step 5: テスト、型検査、ビルド**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: 全パッケージ PASS、`packages/ui/dist` ができる（xterm の CSS が含まれる）

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src
git commit -m "feat(ui): tool settings, project open actions, root wiring for terminals and new session dialog"
```

---

### Task 23: 実物で確かめる（起動は 3 回まで）と文書の更新

**Files:**
- Modify: `README.md`、`docs/design.md`（「決めた前提と未決事項」「フェーズ」「MCP とローカル API」「セッションの起動と観察」）

この Task は実物の Claude を起動するので、サブスクリプションのレート制限を使う。
起動は合計 3 回（新規、再開、フォーク）までとし、cwd は `~/.agent-hangar/scratch/phase2-check/` の使い捨てディレクトリにする。
`~/.claude` には Claude 自身が本文を書くだけで、hangar は書かない。

- [ ] **Step 1: 準備**

```bash
mkdir -p ~/.agent-hangar/scratch/phase2-check
npm run build
HANGAR_HOME=/tmp/hangar-p2 npx tsx packages/server/src/main.ts &
sleep 8
TOKEN=$(cat /tmp/hangar-p2/token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"name\":\"phase2-check\",\"path\":\"$HOME/.agent-hangar/scratch/phase2-check\"}" http://127.0.0.1:4177/api/projects
HANGAR_HOME=/tmp/hangar-p2 npx hangar mcp install
claude mcp list
```

Expected: `POST /api/projects` が `id` 付きのプロジェクトを返す。`claude mcp list` に `hangar: http://127.0.0.1:4177/mcp (HTTP) - ✓ Connected` が出る。
ポート 4177 を実物の hangar が使っていれば先に止める。

- [ ] **Step 2: 起動 1 回目（新規）**

`playwright` スキルのローカル Chrome で `http://127.0.0.1:4177/` を開き、ヘッダーの「新規セッション」を押す。
プロジェクトに `phase2-check`、名前に `phase2-check`、初期プロンプトに次を入れて「起動」を押す。

```
まず /mcp の一覧を見て、hangar という MCP サーバがいくつ見えるか答えてください。
次に set_session_summary を呼び、題名「フェーズ 2 の確認」、1 文「hangar からの起動と MCP の確認」、状態 in_progress、次の一手「再開とフォークを確かめる」で要約を保存してください。
最後に「合言葉は格納庫 42」と答えてください。
```

確認すること（スクリーンショットを撮って `Read` で確かめる）：

1. セッション画面に移り、ターミナルの上に「Claude の起動を待っています」の帯が出る。ターミナルに信頼確認のダイアログが出ていれば埋め込みターミナルで「Yes」を選ぶ。
2. 帯が消え、状態点が busy になる（レジストリが run に結びついた）。tmux のステータス行（緑の帯）が出ていない。
3. Claude の応答で `hangar` の MCP サーバが **1 つ** と答える。2 つなら「前提」の代替案に切り替える（設計文書を直してから、セッション別の名前を `hangar-session` にする）。この観察を Step 6 で設計文書に書く。
4. 数秒後、ヘッダーの要約が「フェーズ 2 の確認」に変わり、出所が「セッション」になる（`set_session_summary` が `in_session` で保存された）。
5. 「＋」でシェルタブを開き、`pwd` が `~/.agent-hangar/scratch/phase2-check` を返す。タブを切り替えても Claude のタブの表示が保たれる。
6. 「ターミナルで開く」で Terminal.app が開き、同じ画面が見える（`tmux list-clients` でクライアントが増える）。Settings で iTerm2 に切り替えて再度押し、初回の許可ダイアログを承認して iTerm2 で開くことを確かめる。
7. トランスクリプトのペーンにライブの本文が流れ、⟩ で折りたためる。
8. Claude のタブで `/exit` を入力し、2 秒以内に状態点が終了になり、Claude タブに「Claude は終了しました」の帯が出る。シェルタブは残る。
9. `sqlite3 /tmp/hangar-p2/hangar.db "select kind, end_reason, pid from runs"` で `start | exited | <pid>` が出る。

- [ ] **Step 3: 起動 2 回目（再開）**

同じセッション画面で「再開」を押す。
Expected: `kind = resume` の run ができ、同じセッションのターミナルに Claude が戻る。「合言葉は」と聞くと「格納庫 42」と答える（文脈が続いている）。`/exit` で終える。

- [ ] **Step 4: 起動 3 回目（フォーク）**

「フォーク」を押す。
Expected: 新しいセッション画面に移り、`kind = fork` の run ができる。Sessions 画面には元と新しい 2 つのセッションが並ぶ。合言葉を聞いて文脈の引き継ぎを確かめ、`/exit` で終える。
`sqlite3 /tmp/hangar-p2/hangar.db "select count(*) from sessions where project_id = (select id from projects where name = 'phase2-check')"` が 2 を返す。

- [ ] **Step 5: 片付け**

```bash
kill %1
HANGAR_HOME=/tmp/hangar-p2 npx hangar mcp uninstall
claude mcp list
rm -rf /tmp/hangar-p2
ls -la ~/.claude | head -3
```

Expected: `claude mcp list` から `hangar` が消える。`~/.claude` の直下のファイルは Claude 自身の本文の追加以外に変化が無い。`~/.agent-hangar/scratch/phase2-check` は残してよい（スクラッチの片付けはフェーズ 3 の範囲）。
`hangar mcp install` は実物の運用で使うので、確認後に改めて `npx hangar mcp install` を実行してもよい。

- [ ] **Step 6: 文書を更新する**

`README.md` の「使い方（フェーズ 1）」の後に次の節を足す。

````markdown
## 使い方（フェーズ 2）

```sh
npx hangar mcp install      # Claude Code の user スコープに hangar の MCP サーバを登録する
```

ヘッダーの「新規セッション」でプロジェクトを選ぶと、tmux 上で Claude Code が起動し、ブラウザのターミナルに埋め込まれます。
セッション画面の「＋」で同じディレクトリのシェルタブを開けます。
「ターミナルで開く」は Terminal.app（既定）か iTerm2 で同じ tmux セッションを開きます。
tmux が無いときは起動できません（`brew install tmux`）。
````

`docs/design.md` を次のように直す。

- 「決めた前提と未決事項」の箇条書きに、この計画の「前提」節の項目を加える（同名ツールの重複の解決、セッション別 URL の識別子、タブの ID、tmux セッション名、PTY の WebSocket、終了理由、heartbeat、ラッパースクリプト、再開とフォークでの注入、フォークの新しいセッション行、プロジェクトの作成 API、プロジェクト画面の Intent、`session.openTerminalApp` の `tabId`、waiting トーストの重複抑止、信頼確認の案内、ターミナル接続の持ち方、起動ダイアログの既定値、tmux が無いとき、`.command` ファイル、iTerm2 の許可案内）。
- 未決事項から「同名のツールが 2 つ見える」を消し、Step 2 の観察結果を「決めた前提」に書く。「権限確認ダイアログの待ちが waiting になるか」は、Step 2 で default モードの権限確認が出たときの状態点の色を観察して結果を書く。出なかったときは未決のまま残す。
- 「フェーズ」の「フェーズ 2」の行末に「（計画は `docs/plans/phase2-launch.md`）」を足す。
- 「MCP とローカル API」の「ツール」に、`get_usage` と `update_project` の TODO とメモがフェーズ 3 まで「フェーズ 3 で対応します」を返すことを 1 文で足す。
- 「セッションの起動と観察」の Intent 一覧に `project.openEditor`、`project.openTerminalApp` を足し、`session.openTerminalApp` に `tabId?` を足す。

- [ ] **Step 7: コミット**

```bash
git add README.md docs/design.md
git commit -m "docs: readme and design updates for phase 2"
```

---

## 実行の順序と並列化

依存の無いタスクは並列に実装できる。
実装者を同時に走らせるときは、次の組を目安にする。

1. Task 1（shared）→ Task 2（設定）。
2. Task 3（tmux とテスト補助）→ Task 4（起動引数、注入）と Task 5（ラッパー）は並列。
3. Task 6（RunManager の起動）→ Task 7（寿命）→ Task 8（再開とフォーク）と Task 9（シェルタブ）は並列。
4. Task 10（PTY）、Task 11（MCP ツール）→ Task 12（MCP アプリ）、Task 13（外部連携）は、Task 6 の後で互いに並列。
5. Task 14（HTTP と結線）は Task 7 から Task 13 のすべての後。Task 15（CLI）は Task 1 の後ならいつでも。
6. Task 16（ストアと API）→ Task 17（Mediator）→ Task 18（ランタイム）。Task 19（Presenter）は Task 16 と Task 17 の後。
7. Task 20（NewSessionDialog）と Task 21（TabStrip、TerminalPane、SessionScreen）は Task 19 の後で並列 → Task 22（Root）→ Task 23（実物確認と文書）。

サーバ側（Task 2 から Task 15）と UI 側（Task 16 から Task 22）は、Task 1 の後なら並列に進められる。

## 自己点検（計画の作成時に確認したこと）

- 設計文書のフェーズ 2 の範囲（tmux での起動、ターミナルの埋め込み、セッション内タブ、MCP、指示の注入、iTerm2 と VS Code の連携、セッション自身による要約）に対応するタスクがある。起動は Task 4 から Task 6、ターミナルは Task 10 と Task 18 と Task 21、タブは Task 9 と Task 21、MCP は Task 11 と Task 12 と Task 15、注入は Task 4、外部連携は Task 13 と Task 14、自己要約は Task 11 の `set_session_summary`。
- 設計文書の「セッションの起動と観察」の各文に対応がある。可変長オプションの順序は Task 4、ラッパースクリプトは Task 5、`status off` は Task 6、信頼確認の案内は Task 19 と Task 21、spawn-helper は Task 10、tmux の絶対パスは Task 2、レジストリとの結びつけは Task 7、run の終了検知は Task 7、xterm.js と node-pty の中継は Task 10 と Task 18、別セッションのシェルタブは Task 9、注入テンプレートは Task 4、再開とフォークは Task 8。
- 設計文書の Intent 一覧に無い `project.openEditor`、`project.openTerminalApp`、`session.openTerminalApp` の `tabId` を足した。Task 23 で設計文書に反映する。
- 型の名前が後のタスクで一致していること：`LaunchResult` は `LaunchResultDto` の別名で、Task 6 の `RunManager`、Task 11 の `ToolDeps.runs`、Task 14 の `RunsApi`、Task 16 の `applyLaunch`、Task 18 の `launched` がすべて `{ run, sessionId, tabs }` を使う。`TabDto.sessionId` は Task 6 の `listTabs` が埋め、Task 17 の `tab.upsert` の遷移が読む。`TerminalHost` の形は Task 18 で定義し、Task 21 の `TerminalHostContext` と Task 22 の `Root` が同じ型を使う。
- テストが実物の `claude` を呼ばないこと：`RunManager` は `claudeBin` を受け、テストは `writeFakeClaude` のスクリプトを渡す。tmux に依存するテストは `describe.skipIf(!TMUX)` で、`-L hangar-test-<pid>` の専用ソケットを使い、`afterEach` か `afterAll` で `killServer` する。
- 実物の Claude を起動するのは Task 23 の 3 回だけで、cwd は `~/.agent-hangar/scratch/phase2-check/`。`~/.claude` に hangar が書くタスクは無く、`~/.claude.json` は `claude mcp add` と `claude mcp remove` だけが触る。
- フェーズ 1 のテストで書き換えが要るものを各タスクに明記した：`SettingsDto` と `BootstrapDto` の拡張（Task 1）、`ApiClient` の偽物（Task 16）、`hash.changed` の効果と NOT_YET の Intent（Task 17）、`RuntimeDeps.terminals`（Task 18）、`SessionProps` の追加項目と `terminalStatus`（Task 21）、`Root` の `terminals`（Task 22）、`ProjectScreen` の Intent（Task 22）。
