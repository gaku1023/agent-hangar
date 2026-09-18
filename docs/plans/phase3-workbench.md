# フェーズ 3 実装計画（使用量、アーティファクト、TODO とメモ、スクラッチと昇格、タブと分割、事後要約、パレットとショートカット）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** フェーズ 2 までで起動と観察ができるようになった hangar に、プロジェクトの作業台として要る機能（使用量ゲージ、アーティファクト、TODO とメモ、スクラッチと昇格、タブの分割、事後要約、コマンドパレットとショートカット）を足し、日々の作業を hangar の中で回せる状態にする。

**Architecture:** サーバには、statusline の payload を受ける `UsageTracker`、索引化の途中で Artifact ツールの呼び出しと結果を拾う `artifacts/extract`、TODO とメモの読み書き（メモは SQLite と Markdown ファイルの両方に置き、ファイルの外部編集を監視して取り込む）、スクラッチの擬似プロジェクトと昇格の手順、差し替え可能な `Summarizer` と背景の `SummaryJob` を足す。UI は Mediator に `promote` の領域とタブの分割、パレット、TODO とメモとアーティファクトの効果を足し、Presenter が新しい DTO から props を計算し、View は `TodoList`、`MemoEditor`、`ArtifactCards`、`SplitPane`、`CommandPalette`、`UsageGauge` を Passive View として描く。フェーズ 2 の `RunManager`、`TerminalHost`、`TabStrip` はそのまま使い、必要な箇所だけを広げる。

**Tech Stack:** フェーズ 2 の構成のまま。新しい依存は足さない（LM Studio は `fetch`、`claude -p` は `child_process`、`open` と `git init` は `execFile` で呼ぶ）。

**Spec:** `docs/design.md`

## Global Constraints

- `~/.claude/` 配下のファイルを書き換えない。例外は statusline スクリプトへの追記だけで、`hangar setup` と `hangar statusline install` が利用者の承諾を得てから、追記前にバックアップを取り、目印のコメント行 `# agent-hangar: 使用量をローカルサーバへ渡す。失敗は無視する。` で二重追記を避けて行う。`~/.claude/settings.json` は読むだけで書かない。テストは `HANGAR_CLAUDE_DIR` と `HANGAR_HOME` を一時ディレクトリに向けて行い、実物の `~/.claude` と `~/.agent-hangar` に触れない。
- hangar は利用者のファイルを削除しない。例外はスクラッチを昇格するときの移動だけで、run がすべて終了しているときに限る。
- サーバは `127.0.0.1` のポート `4177` にだけバインドする。データは `~/.agent-hangar/hangar.db`、メモの写しは `~/.agent-hangar/projects/<projectId>/memo.md`、スクラッチは `~/.agent-hangar/scratch/<yyyymmdd-HHmmss>/`。
- 共有テーブル（`todos`、`project_memos`、`artifacts`、`artifact_versions`、`session_summaries`、`projects`、`project_roots`、`sessions`）への書き込みは必ず `upsertShared` と `softDeleteShared` を通し、`changes` に 1 行を追記する。端末ローカルのテーブル（`usage_snapshots`、`session_live_stats`、`artifact_calls`、`usage_daily`）は素の SQL で書く。
- 使用量の供給源は statusline の payload だけである。`POST /api/ingest/statusline` は他の `/api` と同じ Bearer 認証を要求し、payload に `rate_limits` が無ければ直前の値を保つ。
- セッションごとのモデル、effort、コンテキスト使用率、推定コストは statusline の payload を第一の供給源にし、無いときだけ jsonl から得た値を使う。
- 事後要約の既定は LM Studio（`http://127.0.0.1:1234/v1/chat/completions`、`response_format` は `json_schema`、本文が空なら失敗）で、繋がらないときは `claude -p --model haiku --output-format json --json-schema <schema>` に切り替える。Claude への切り替えは 1 時間 20 件までとし、7 日の使用率が 80% 以上なら止める。要約の入力は利用者の発言 1 件 2,000 字、アシスタントの本文 1 件 600 字、ツール呼び出し 1 行で、全体を 12,000 字前後に収め、超えるときは中盤を間引く。
- 事後要約は run の終了時と、セッションを開いたときに、要約が土台のままか最後の更新から 5 ターン以上進んでいるときだけ作る。過去の全件を背景で埋めない。1 セッションにつき同時に走るジョブは 1 つ。
- テストは実物の `claude` も LM Studio も呼ばない。要約器のテストは `fetch` と `spawn` の偽物を注入する。実物の Claude セッションを起動して確かめる作業はこの計画全体で 2 回までとし、cwd は `~/.agent-hangar/scratch/` 配下の使い捨てディレクトリにする。
- UI のコンポーネントは props だけで描く Passive View にし、`fetch` を呼ばず、他の画面の View を import しない。操作は `useEmit()` で得た `emit` に Intent を渡すことでだけ外へ伝える。中間層で処理する Intent は `SplitPane` の幅変更だけにする。
- Mediator と Presenter は DOM に依存しない純関数で、vitest の `node` 環境でテストする。View のテストだけ `jsdom` 環境で行い、`packages/ui/vitest.config.ts` の `domGlobs` は `src/views/**`、`src/intent/**`、`src/Root.test.tsx` のままにする（新しい jsdom テストは `src/views/` に置く）。
- 見た目は常にライトで、ダークモードは持たない（2026-09-17 の決定）。`prefers-color-scheme` にも `data-theme` にも従わず、色は `:root` のトークンだけで決める。動きは 150 から 250 ミリ秒に限り、この計画で足すのは TODO の打消し線、使用量ゲージの充填、使用率の数字の縦回転、ステータス変更でのカードの FLIP 移動、コマンドパレットの開閉（98% から 100% のスケールとフェード、120 ミリ秒、`--dur-pop`）、分割の幅のトランジションだけである。グロー、脈動、タイピング風、シマー、スケルトンは使わない。
- 日本語の文書とコメントは一文ごとに改行し、地の文でダッシュと中黒を使わない。
- コミットメッセージは英語の Conventional Commits 形式で、末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` を付ける。パッケージ管理は npm（pnpm は使わない）。
- フェーズ 3 ではクラウド同期、引き継ぎ、Tauri、新規プロジェクトのダイアログを実装しない。対応する Intent（`sync.now`、`sync.pause`、`session.takeover`、`project.new.open`、`project.new.submit`）は Mediator が受けてトースト「この操作は次のフェーズで実装します」を出す。

## 前提の再確認（実装開始時）

この計画はフェーズ 2 の計画（`docs/plans/phase2-launch.md`）が計画どおりに実装されていることを前提に書いた。
フェーズ 2 の実装がこの計画の作成時点では無いので、依存する名前と形を次に列挙する。
Task 0 で実物のコードと照合し、食い違いがあれば該当タスクを直してから着手する。

| 依存 | 想定の場所と形 | 使うタスク |
| --- | --- | --- |
| `SettingsDto` | `packages/shared/src/api.ts`：`{ workspaceRoot; claudeDir; tmuxPath: string \| null; terminalApp: TerminalApp; codePath: string \| null }` | Task 1、Task 16 |
| `BootstrapDto` | `runs: RunDto[]; tabs: TabDto[]` を含む | Task 1、Task 16、Task 17 |
| `ServerEvent` | `run.started`、`run.upsert`、`run.ended`、`tab.upsert` がある | Task 1、Task 18 |
| `Intent` | `project.openEditor`、`project.openTerminalApp`、`session.openTerminalApp { runId; tabId? }` がある | Task 1、Task 24 |
| `Settings`（server） | `packages/server/src/config/paths.ts`：`SettingsDto` と同じ項目。`loadSettings` は `{ ...defaultSettings(), ...JSON }` で欠けた項目を埋める | Task 15、Task 16 |
| `RunManager` | `packages/server/src/runs/manager.ts`：`start(params: LaunchParams): LaunchResult`、`RunError(status, message)`、`on({ runEnded })`、`private project()`、`private addDirs()`、`private precheck()`、`private launch({ sessionId; cwd; kind; command; params })`、`private baseInput()`、`deps.home`、`deps.now` | Task 11、Task 16 |
| `aliveRunForSession` | `packages/server/src/runs/queries.ts`：`(db, sessionId) => RunDto \| null` | Task 12 |
| `ToolDeps`、`callTool`、`TOOL_NAMES` | `packages/server/src/mcp/tools.ts`：`ToolDeps = { db; deviceId; port; live; runs; hub }`。`updateProjectTool` は `not_yet` を返し、`get_usage` は `{ not_yet }` を返す | Task 10 |
| `buildMcpServer` | `packages/server/src/mcp/app.ts`：`reg(name, description, schema)` の並び。`get_usage` と `update_project` の説明文に「フェーズ 3 で対応する」がある | Task 10 |
| `Exec`、`openInEditor` | `packages/server/src/external/open.ts`：`Exec = (cmd, args, opts?) => Promise<{ code; stdout; stderr }>`、`openInEditor({ codePath, target, exec? })` | Task 7、Task 16 |
| `AppDeps`、`ExternalApi`、`RunsApi`、`toSettingsDto` | `packages/server/src/http/app.ts`：`AppDeps = { db; deviceId; deviceName; token; home; port; version; settings; updateSettings; live; indexer; hub; runs; external; uiDist? }`。`PATCH /api/settings` が項目ごとに検査する | Task 16 |
| `startServer` の結線 | `packages/server/src/server.ts`：`runs.on({ runStarted, runUpdated, runEnded, tabChanged })`、`registry.onChange`、`indexer.on({ sessionChanged })`、`external` の組み立て、`updateSettings` で `saveSettings` | Task 16 |
| `renderInjection`、`injectionFor` | `packages/server/src/launch/injection.ts` と `RunManager.injectionFor` が `project_memos.markdown` と `todos`（未完 10 件）を DB から読む | Task 9（変更なしで実データが乗ることを確かめる） |
| `Store` | `packages/ui/src/store/store.ts`：`runs`、`tabs`、`applyLaunch`、`aliveRunOf`、`currentRunOf`、`tabsOf`、`hasRunOf`、`runningSessionIds`、`pruneRuns`。`applyBootstrap` は `runs` と `tabs` だけ差し替えずに混ぜる | Task 17 |
| `ApiClient` | `packages/ui/src/runtime/api.ts`：`call` が `{ error }` を優先して投げる。`post` の補助がある | Task 17 |
| `RuntimeDeps`、`createRuntime` | `packages/ui/src/runtime/runtime.ts`：`terminals: TerminalHost`、`focus?: (target: FocusTarget) => void`、`resolveTab(sessionId, tabId)`、`launched`（`launch.done` に `runId` も載せる）、`launchFailed`、`fail`、`toast` | Task 19 |
| Mediator の型 | `packages/ui/src/mediator/types.ts`：`FocusTarget = 'search' \| 'newSessionName' \| 'terminal'`、`Overlay` に `newSession { projectId: string \| null }` と `palette` と `notYet { feature }`、`LaunchState`、`SessionViewState = { agentId; showThinking; showRaw; follow; summaryOpen; selectedTab; transcriptOpen }`、`State.launch`、`State.waitingSeen`、`State.indexPhase`、`Effect` の `terminal.connect` と `focus`（`target: FocusTarget`）、`RuntimeEvent.launch.done = { sessionId; runId }` | Task 18 |
| `launchStep`、`sessionViewStep`、`transition` | `packages/ui/src/mediator/launch.ts`（`session.new.open` の `scratch` は NOT_YET トースト）、`sessionView.ts`（`tab.*`、`transcript.toggle`）、`transition.ts` の `NOT_YET_INTENTS` | Task 18 |
| `presentSession`、`SessionProps` | `packages/ui/src/presenters/session.ts`：`run`、`tabs`、`selectedTab`、`transcriptOpen`、`trustHint`、`canResume`、`canFork` | Task 20 |
| `presentNewSession`、`NewSessionProps` | `packages/ui/src/presenters/newSession.ts`：`{ projects: { id; name; path }[]; projectId; submitting; error }`。一覧は `p.resolved && p.status !== 'archived'` で絞り、名前順に並べる | Task 20、Task 23 |
| `presentSettings`、`SettingsProps` | `packages/ui/src/presenters/settings.ts`：`tmuxPath`、`terminalApp`、`codePath`、`mcpInstallCommand` | Task 20、Task 26 |
| `TabStrip`、`TerminalPane`、`TerminalHostContext` | `packages/ui/src/views/TabStrip.tsx`、`TerminalPane.tsx`：`TabStrip({ sessionId, tabs, canAdd })`、`TerminalPane({ tabId, status, hint })` | Task 23 |
| `SessionScreen` | `packages/ui/src/views/SessionScreen.tsx`：`SessionScreen(props: SessionProps & { terminalStatus })`。実行中は `.split` の 2 列 | Task 23 |
| `NewSessionDialog` | `packages/ui/src/views/NewSessionDialog.tsx`：`NewSessionDialog(props: NewSessionProps)`。入力欄はすべて非制御で、`useRef<HTMLFormElement>` と `FormData` から送信時にまとめて読む（`useState` は持たない）。プロジェクトの欄は `<label className="field" htmlFor="new-session-project">プロジェクト` と `<select id="new-session-project" name="projectId">` で、`aria-label` は付けない | Task 23 |
| `SettingsScreen` | `packages/ui/src/views/SettingsScreen.tsx`：「次のフェーズで追加される設定」の節がある | Task 26 |
| `Root`、`main.tsx` | `Root({ runtime, api?, terminals })`。キー処理は `/`、⌘K、⌘N。パレットは仮の `.dialog` | Task 27 |
| `Icon` | `packages/ui/src/views/primitives/Icon.tsx`：`Icon({ name, label? })`。`lucide-react` を直接 import してよいのはこのファイルだけで、名前は `ICONS` の鍵に限る。足りない名前は `ICONS` に追加してから使う | Task 22 から Task 27 |
| `StatusSelect`、`ProjectStatusDot`、`StatusDot` | `packages/ui/src/views/primitives/StatusSelect.tsx`：`StatusSelect({ label, value, onChange })` と `ProjectStatusDot({ status })`。プロジェクトのステータスの `<select>` を View が自前で書かない。`StatusDot.tsx` の `StatusDot({ status, title? })` は run の生死用 | Task 22 |
| `.field`、`.grid2` | `packages/ui/src/styles/base.css` にある | Task 22、Task 23、Task 26 |
| `.split` | `packages/ui/src/styles/base.css`：`SessionScreen` がターミナルとトランスクリプトの 2 列に使う既存の規則。フェーズ 3 の `SplitPane` は別名（`.split-h`）にして上書きしない | Task 23 |
| テスト補助 | `packages/ui/src/test/fakeApi.ts` の `fakeApiExtras()`、`packages/server/test/fixtures.ts` の `copyFixtureClaudeDir`、`SESSION_ALPHA` | Task 17、Task 6 |

### Task 0: フェーズ 2 の実装との照合

**Files:**
- 変更なし（照合の結果をこの文書の該当タスクに反映する）

**Interfaces:**
- Consumes: 上の表のすべて。
- Produces: 食い違いの一覧と、直したタスク。

> **照合済み（2026-09-19、`330f5da` 時点）。** Step 1 から Step 4 の grep をすべて実行し、食い違いを各タスクに反映した。反映の内訳は Step 5 に記す。

- [x] **Step 1: shared の型を照合する**

Run: `grep -n 'tmuxPath\|runs: RunDto\|run.started\|tab.upsert\|project.openEditor\|tabId?' packages/shared/src/api.ts packages/shared/src/events.ts packages/shared/src/intent.ts`
Expected: `SettingsDto` に `tmuxPath`、`terminalApp`、`codePath`、`BootstrapDto` に `runs` と `tabs`、`ServerEvent` に `run.started` と `tab.upsert`、`Intent` に `project.openEditor` と `session.openTerminalApp` の `tabId?` がある。無い名前があれば Task 1 の「置き換え前」の形をその実物に合わせる。

- [x] **Step 2: サーバの結線と RunManager を照合する**

Run: `grep -n 'export class RunManager\|start(params\|private project(\|private launch(\|private baseInput(\|class RunError\|runEnded' packages/server/src/runs/manager.ts && grep -n 'export type AppDeps\|export type ExternalApi\|export function toSettingsDto\|api.patch(./settings\|app.route(./mcp' packages/server/src/http/app.ts && grep -n 'runs.on(\|indexer.on(\|updateSettings:\|const external' packages/server/src/server.ts && grep -n 'export type Exec\|export async function openInEditor\|export function openInEditor' packages/server/src/external/open.ts`
Expected: すべての行が見つかる。`RunManager.start` の先頭が `if (params.scratch) throw new RunError(400, ...)` であることを確かめる（Task 11 がこの行を置き換える）。`AppDeps` の項目名が違えば Task 16 の `AppDeps` をその実物に合わせて広げる。

- [x] **Step 3: MCP のツールを照合する**

Run: `grep -n 'not_yet\|NOT_YET\|get_usage\|export function updateProjectTool\|export function getProjectTool\|export type ToolDeps' packages/server/src/mcp/tools.ts && grep -n "reg('get_usage'\|reg('update_project'\|reg('get_project'" packages/server/src/mcp/app.ts && grep -n 'not_yet' packages/server/src/mcp/tools.test.ts`
Expected: `updateProjectTool` が `not_yet` を返し、`get_usage` が `{ not_yet: NOT_YET }` を返し、テストに `not_yet` の期待がある。Task 10 はこれらを置き換える。

- [x] **Step 4: UI の Mediator、ランタイム、Presenter、View を照合する**

Run: `grep -n 'selectedTab\|transcriptOpen\|waitingSeen\|newSession' packages/ui/src/mediator/types.ts && grep -n 'NOT_YET_INTENTS' packages/ui/src/mediator/transition.ts && grep -n 'i.scratch' packages/ui/src/mediator/launch.ts && grep -n 'resolveTab\|terminals: TerminalHost\|focus?:' packages/ui/src/runtime/runtime.ts && grep -n 'export type SessionProps\|canResume\|trustHint' packages/ui/src/presenters/session.ts && grep -n 'export function TabStrip\|export function TerminalPane\|export const TerminalHostContext' packages/ui/src/views/TabStrip.tsx packages/ui/src/views/TerminalPane.tsx && grep -n 'コマンドパレット\|metaKey' packages/ui/src/Root.tsx && grep -n '\.field\|\.grid2' packages/ui/src/styles/base.css && ls packages/ui/src/test/fakeApi.ts`
Expected: すべて見つかる。`NOT_YET_INTENTS` の中身を書き留め、Task 18 の置き換え後の集合が「フェーズ 3 で実装する Intent を除いたもの」になっているかを確かめる。

照合の結果、`packages/ui/src/mediator/transition.ts` の `NOT_YET_INTENTS` は次の 17 件だった。

```ts
const NOT_YET_INTENTS = new Set(['session.promote.open', 'session.promote.submit', 'session.takeover', 'session.setMemo', 'split.toggle', 'todo.add', 'todo.toggle', 'todo.remove', 'memo.save', 'artifact.open', 'artifact.add', 'summary.regenerate', 'sync.now', 'sync.pause', 'project.new.open', 'project.new.submit', 'palette.run']);
```

このうちフェーズ 3 で実装するのは `session.promote.open`、`session.promote.submit`、`session.setMemo`、`split.toggle`、`todo.add`、`todo.toggle`、`todo.remove`、`memo.save`、`artifact.open`、`artifact.add`、`summary.regenerate`、`palette.run` の 12 件で、残る 5 件（`session.takeover`、`sync.now`、`sync.pause`、`project.new.open`、`project.new.submit`）が Task 18 の置き換え後の集合と一致する。

- [x] **Step 5: 食い違いを記録する**

照合で見つかった食い違いと、この文書に入れた直しは次のとおり。

| タスク | 食い違い | 直し |
| --- | --- | --- |
| 前提の表 | `RuntimeDeps.focus` を `(target: 'search' \| 'newSessionName') => void` と書いていたが、実物は `FocusTarget`（`'terminal'` を含む）を使う | 表を実物に合わせ、Task 18 と Task 19 を `FocusTarget` を広げる形に直した |
| 前提の表 | `Overlay` に `palette` と `notYet` があり、`newSession.projectId` は `string \| null`。`State` に `indexPhase` がある | 表に書き足した |
| 前提の表 | `NewSessionDialog` は非制御フォームで、プロジェクトの `select` に `aria-label` は無い | 表を実物に合わせ、Task 23 の Step 6 を書き直した |
| 前提の表 | フェーズ 2 の後に `Icon`、`StatusSelect`、`ProjectStatusDot` が入った | 表に行を足し、Task 22 から Task 24 の View を使う形に直した |
| Task 10 | `getProjectTool` の `.slice(0, 10)` は実物の定数 `RECENT_SESSIONS` | 定数を使う形に直した |
| Task 11 | `start` の置き換えが `this.addDirs(params)` と `this.precheck(...)` を落とし、`this.launch` に `command` ではなく `input` を渡していた | 実物の呼び出しに合わせた |
| Task 15 | `Settings` の置き換えが `toolsResolved?: boolean` を落としていた | 残した |
| Task 16 | `GET /sessions/:id/events` の置き換えが 404 の文言を実物と違うものにしていた | 実物の文言に戻した |
| Task 16 | `indexer.on({ sessionChanged })` の置き換えが、起動後に現れたセッションを `assignSession` で紐づけて `project.upsert` を配る処理を落としていた | 残した |
| Task 18 | `RuntimeEvent.launch.done` から `runId` が落ちていた（実物の `launched` が渡している） | 残した |
| Task 18 | `Effect` の `focus` を素の合併に展開していた（実物は `FocusTarget`） | `FocusTarget` を広げる形にした |
| Task 18 | `initialState` と `State` から `indexPhase` が落ちていた | 残した |
| Task 18 | `transition.ts` の import の置き換えが `ITERM_HINT` と 2 行の再エクスポートを落としていた | 残した |
| Task 18 | `sessionViewStep` への追加位置の指示が実物の構造と合わなかった | `server` の塊の後、`intent` の塊の前と書き直した |
| Task 19 | `RuntimeDeps.focus` の置き換えが実物の `FocusTarget` を無視していた | `Exclude<FocusTarget, 'terminal'>` にした |
| Task 20 | `NewSessionProps` の置き換えが `path` と `resolved`／`archived` の絞り込みを落としていた | 残した |
| Task 22 | `ProjectScreen` の置き換えが素の `<select>` を書き、ボタンの `Icon` を落としていた | `StatusSelect` と `Icon` を使う形にした |
| Task 22 | `TodoList` と `ArtifactCards` が文字の `x` とアイコン無しのボタンを書いていた | `Icon` の `close`、`add`、`openEditor` を使う形にした |
| Task 23 | `SplitPane` が既存の `.split` と同じ類名を使い、`SessionScreen` の 2 列の規則を上書きしていた | `.split-h` に改めた |
| Task 23 | `TabStrip` の分割ボタンが文字の `◫` を直に書いていた | `Icon` の `split` を足して使う形にした |
| Task 23 | `NewSessionDialog` の置き換えが、実物に無い `useState` と別の骨格を前提にしていた | 実物の非制御フォームに対する最小の差分に書き直した |
| Task 23 | `TabStrip` のテストが `TabItemProps` の項目を `canClose` と書いていた（実物は `closable`） | `closable` に直した |
| Task 23 | `NewSessionDialog` のテストの `projects` に `path` が無かった | 足した |
| Task 23 | セッション画面の「プロジェクトに昇格」ボタンだけアイコンが無かった | `Icon` の `promote` を足して使う形にした |
| Task 24 | メモの鉛筆ボタンが文字の「鉛筆」だった。`VirtualList.render` は既に添字を渡している | `Icon` の `edit` を足して使う形にし、`VirtualList` の但し書きを事実に直した |
| Task 27 | `paletteOpen` は実物の `Root.tsx` に既にある | 二重に宣言しないと書き足した |

```bash
git add docs/plans/phase3-workbench.md
git commit -m "docs: reconcile phase 3 plan with the phase 2 implementation"
```

---

## 前提（この計画で決めたこと）

設計文書が定めていない細部を、この計画で次のように決める。
実装後に `docs/design.md` へ反映する（Task 29）。

- **使用量の保存**：statusline の payload は `usage_snapshots(at, payload)` に生の JSON で積み、直近 500 件だけ残す。5 時間と 7 日の値は `UsageTracker` がメモリに持ち、サーバ起動時に新しい順に走査して両方の窓が埋まるまで読む。payload に `rate_limits` が無いときは直前の値を保ち、`updatedAt` も更新しない（ゲージの「最終更新」は使用率が届いた時刻を指す）。
- **セッションごとの付帯情報**：payload の `model`、`effort`、`context_window`、`cost` は端末ローカルの `session_live_stats` に Claude の UUID（`provider_session_id`）を鍵として置く。`session_stats` は索引から導いた値で、ファイルを作り直すと消えるため、別の表にする。`SessionDto.stats` の `model` と `effort` は `session_live_stats` を優先し、無ければ `session_stats` の値にする。`contextPercent` は `current_usage` の `input_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens` の和を `context_window_size` で割った百分率で、`current_usage` が null の 1 回目は書かない。`costUsd` は `cost.total_cost_usd`。
- **statusline の追記先**：`~/.claude/settings.json` の `statusLine.command` を読み、先頭の `bash `、`sh `、`zsh ` を除いた最初の語を `~` 展開してファイルとして存在すればそれを追記先にする。存在しなければ追記せず、スニペットと手順を印字する。追記位置は 1 行目が `#!` で始まればその直後、そうでなければ先頭で、目印の行があれば何もしない。バックアップは同じディレクトリの `<name>.bak-<yyyymmddHHMMSS>`。追記は `hangar setup` の手順 4 と `hangar statusline install` だけが行い、どちらも `y` の入力（または `--yes`）を要求する。サーバは追記の有無を `GET /api/statusline` で読み取り専用に報告する。
- **jsonl の使用量の集計**：端末ローカルの `usage_daily(session_id, day, input_tokens, output_tokens)` を索引化のときに埋める。`day` はイベントの `timestamp` をローカル時刻で `YYYY-MM-DD` にしたもの。日別はこの表から、プロジェクト別は `session_stats` のトークン数を `sessions.project_id` で束ねる。推定コストは価格表を持たず、statusline の `cost.total_cost_usd` を持つセッションの和だけを出す（無ければ null）。
- **アーティファクトの抽出**：`Artifact` ツールの `tool_call` を見たら `artifact_calls(tool_id, session_id, file_path, description, favicon)` に書き、`tool_result` の本文から `https://claude.ai/code/artifact/<id>` か `https://claude.ai/artifact/<id>` を取り出せたときだけ公開とみなす。呼び出しと結果は別の記録にあり、追記の境目で分かれることがあるため、この表で突き合わせる。`artifacts` は URL で 1 件にまとめ、`first_published_at` は最小、`last_published_at` は最大を保ち、説明と favicon は新しい公開の値で上書きする。`artifact_versions` は（`artifact_id`、`session_id`、`published_at`）が同じ行が既にあれば追加しない（作り直しで二重に増えない）。`artifacts.project_id` は最後に公開したセッションの `project_id` にし、プロジェクト画面の集約は `artifact_versions` から `sessions.project_id` を辿る。
- **アーティファクトの題名**：題名は表示のたびに計算せず、公開を記録するときに決めて `artifacts.title` に書く。元ファイルがあれば先頭 64KB の `<title>` を、無ければ説明文の先頭 60 字を使う。手で追加した URL は題名 null で、UI は URL の末尾を出す。
- **アーティファクトを開く経路**：クリックは `POST /api/artifacts/:id/open` でサーバが `open <url>` を実行する。ブラウザの `window.open` はポップアップ抑止と Tauri の挙動が環境で変わるため使わない。「VS Code で開く」は最新の版の `file_path` が存在するときだけ出し、`POST /api/artifacts/:id/open-editor` がフェーズ 2 の `openInEditor` を呼ぶ。
- **TODO の並び**：`position` は追加のたびにそのプロジェクトの最大値に 1 を足す。並び替えの操作は持たず、完了した項目も同じ並びで打消し線を引いて残す。削除は論理削除。`todos.session_id` は、セッション別 MCP URL の `update_project` から足したときだけ入る。
- **メモの正**：メモは `project_memos.markdown` とファイル `~/.agent-hangar/projects/<projectId>/memo.md` の両方に書く。読むときはファイルの mtime が DB の `updated_at` より新しく中身が違えばファイルを正として DB を直す。`~/.agent-hangar/projects/` を `fs.watch`（再帰）で監視し、300 ミリ秒のデバウンスで取り込んで `memo.update` を配る。UI の編集中に外部の更新が届いたら、下書きを捨てずに「外部で更新されました」と「読み込む」を出す。メモの先頭（`memoHead`）は空行でない最初の行の先頭 80 字。
- **メモの読み込み**：メモの全文は `BootstrapDto` に含めず、プロジェクト画面に入ったときに `GET /api/projects/:id/memo` で読む。`ProjectDto.memoHead` はカードのために常に含める。
- **セッションの 1 行メモ**：`PATCH /api/sessions/:id { memo }` で書き、`session.upsert` を配る。一覧の行では `m` キーか鉛筆ボタンでその場の入力欄に変わり、Enter で保存、Esc で取り消す。
- **スクラッチの擬似プロジェクト**：`is_scratch = 1` の行は端末ごとに 1 つで、名前は「スクラッチ」、この端末の `project_roots.path` は `~/.agent-hangar/scratch`。スクラッチのセッションはすべてこの 1 つに属する（ディレクトリごとにプロジェクトを作らない）。Projects 画面と Home のカードにはこの行を出さず、Sessions 画面の絞り込みには出す。
- **スクラッチのディレクトリ名**：`<yyyymmdd-HHmmss>` がローカル時刻で、同じ秒に 2 つ作るときは `-2`、`-3` を付ける。
- **昇格の手順**：`POST /api/sessions/:id/promote { name, gitInit, moveFiles }`。`name` は `/` を含まない 1 字以上で、`<workspaceRoot>/<name>` が既にあれば 409。手順は設計文書の 1 から 4 をこの順で行い、`moveFiles` が真でも run が生きていれば移動せず `moved: false` と理由を返す。移動はスクラッチのディレクトリの中身を `fs.renameSync` で移し、空になったディレクトリを消す（`~/.agent-hangar` の中の hangar 自身のディレクトリなので「ファイルを消さない」の例外に当たる）。応答は新しいプロジェクトと更新後のセッションで、UI は昇格の完了ダイアログで「この場所で新しいセッションを開始」を提案する。
- **昇格の Intent**：設計文書の `session.promote.submit { id, name, moveFiles }` に `gitInit: boolean` を足す。
- **再開の注意書き**：`SessionDto.fromScratch` を足し、cwd が `~/.agent-hangar/scratch/` 配下で、かつ属するプロジェクトがスクラッチでないときに真にする。セッション画面は真のとき「再開」の隣に「再開すると cwd はスクラッチのままです」を出す。
- **分割表示**：`SessionViewState` に `split: boolean` と `splitTab: string | null` を足す。左は選択中のタブ、右は `splitTab` で、`split.toggle` は開いているタブが 2 つ以上あるときだけ有効にし、右に選択中でない最初のタブを置く。1 つしか無ければトースト「分割にはタブが 2 つ必要です」を出す。分割の幅は `SplitPane` が `IntentBoundary` で `split.resize { ratio }` を横取りして自分の状態に持ち、Root には届かない。幅は保存しない（0.5 に戻る）。分割と `splitTab` は他の一時状態と同じ `sv:<sessionId>` の鍵で localStorage に保存する。
- **タブのショートカット**：⌘1 から ⌘9 と ⌃⌥1 から ⌃⌥9 の両方を常に受け付ける（Tauri かブラウザかの判別を持たない）。⌘W は選択中のタブが閉じられるシェルタブのときだけ `tab.close` を出す。⌘\ は `split.toggle`、⌘J は `transcript.toggle`。ターミナルにフォーカスがあるとき（`keydown` の `target` が `.term-host` の中）は、⌘ を含む組み合わせだけを hangar が処理し、それ以外は `preventDefault` せずに xterm へ渡す。
- **パレットの項目**：コマンドは `cmd:new-session`（新規セッション）、`cmd:new-scratch`（スクラッチで始める）、`cmd:settings`（設定）、`cmd:rebuild-index`（索引を作り直す）の 4 つで、これにプロジェクト（`project:<id>`）とセッション（`session:<id>`、名前と要約の 1 文で照合）を足す。照合は部分列一致（入力の各文字がこの順に現れる）で、一致位置が前で連続しているほど高い点を付け、上位 30 件を出す。入力欄の文字は Root が `useState` で持ち、Presenter に渡す。
- **要約器の設定**：`SettingsDto` に `lmStudioUrl`（既定 `http://127.0.0.1:1234`）、`lmStudioModel`（既定 null で、null なら `/v1/models` の最初のモデル）、`summaryFallback`（既定 true、Claude への切り替えを許すか）、`summaryHourlyCap`（既定 20）を足す。
- **要約の入力**：`readEvents` で主線の全イベントを読み（サブエージェントは含めない）、`user` は 2,000 字、`assistant` は 600 字、`tool_call` は `summary` の 1 行に切り、`thinking`、`tool_result`、`system`、`meta` は捨てる。全体が 12,000 字を超えたら、先頭 30% と末尾 30% の項目を残して中盤を「[... N 件を省略 ...]」に置き換える。
- **要約の状態判定**：プロンプトに「最後の発言がアシスタントの問いかけで終わっていれば `in_progress`」と明示し、レジストリに生きた項目があるセッションも `in_progress` を優先するよう入力の先頭に「このセッションは現在も実行中」の 1 行を付ける。
- **要約ジョブの契機**：`RunManager` の `runEnded` と、`GET /api/sessions/:id/events?fromSeq=0`（セッション画面を開いたときの先頭ページの読み込み）の 2 つで `SummaryJob.enqueue(sessionId)` を呼ぶ。`enqueue` は「土台のまま、または最後の更新から 5 ターン以上進んだ」ときだけ受け付け、レジストリで実行中のセッションは受け付けない（セッション自身の `set_session_summary` に任せる）。`summary.regenerate` は条件を無視して受け付ける（`force`）。ジョブは 1 つずつ直列に走る。
- **要約の失敗**：すべての要約器が失敗したら `summary.failed { sessionId, message }` を配り、UI はヘッダーの要約の横に「要約を作成できませんでした」を 1 度出す。要約の行は変えない。
- **Claude への切り替えの上限**：`ClaudeHeadlessSummarizer` が呼び出しの時刻をメモリに持ち、直近 1 時間の件数が上限に達していれば `available()` を偽にする。7 日の使用率は `UsageTracker` から読み、80 以上なら偽。`claude` が PATH に無ければ偽。サーバを再起動すると件数は 0 に戻る（1 時間の窓に対して十分に小さいずれとみなす）。
- **`claude -p` の呼び方**：`claude -p --model haiku --output-format json --json-schema <schema> --append-system-prompt <prompt> --no-session-persistence --tools ""` に、圧縮した本文を標準入力から渡す。渡す本文が空になることは無いので `< /dev/null` は使わない。結果は標準出力の JSON の `structured_output` から読む。タイムアウトは 120 秒。
- **要約器を試す**：`POST /api/summarizer/test` は決め打ちの短い入力（`CANNED_INPUT`）を現在の設定の要約器に順に投げ、最初に成功した要約器の ID、所要ミリ秒、要約を返す。DB には書かない。
- **使用量の集計の表示**：Settings の「使用量」の節に、直近 30 日の日別（日、入力トークン、出力トークン、セッション数）と、プロジェクト別（名前、トークン、推定コスト、セッション数）の 2 つの小さな表を置く。Home には置かない。
- **Home と Projects のカード**：`memoHead` を 1 行で出し、「ここで新規」ボタンを足して `session.new.open { projectId }` を出す。フェーズ 1 のカードには TODO の数だけがあった。
- **FLIP の対象**：Projects 画面でステータスを変えたときのカードの移動だけに使う。`useFlip` は前回の描画位置を `Map<key, DOMRect>` で持ち、`useLayoutEffect` で差分を `transform` に入れて次のフレームで 0 に戻す。昇格でのカードの移動は、昇格の完了で画面が変わるため FLIP を使わない。
- **数字の縦回転**：`RollingNumber` は値が変わったとき、古い値を上へ、新しい値を下から上へ 150 ミリ秒で動かす。桁ごとには分けない。
- **ゲージ**：ヘッダーの 5 時間と 7 日のゲージは幅 48px、高さ 6px の棒で、80% 以上で `--waiting` の色にする。値が無いときは灰色の空の棒と「未取得」を出す。
- **`GET /api/bootstrap` の追加項目**：`usage`、`todos`（全プロジェクトの未削除の TODO）、`artifacts`（全件）、`summaryPending`（作成中のセッション ID）。メモの全文は含めない。

## ファイル構成

フェーズ 2 までのファイルに次を足す。`Modify` はフェーズ 1 かフェーズ 2 の計画で作られたファイルである。

```
packages/shared/src/
  api.ts                          Modify：UsageDto、TodoDto、MemoDto、ArtifactDto、PromoteResultDto、SummarizerTestDto、StatuslineStatusDto、UsageAggregateDto、SettingsDto と SessionDto と BootstrapDto の拡張
  events.ts                       Modify：usage.update、todos.update、memo.update、artifact.upsert、summary.pending、summary.updated、summary.failed
  intent.ts                       Modify：session.promote.submit の gitInit、split.resize、summarizer.test
packages/server/src/
  db/migrations.ts                Modify：version 3（session_live_stats、artifact_calls、usage_daily、索引）
  db/queries.ts                   Modify：openTodoCount、memoHead、fromScratch、contextPercent、costUsd、is_scratch の除外
  config/paths.ts                 Modify：Settings に lmStudioUrl、lmStudioModel、summaryFallback、summaryHourlyCap
  config/statusline.ts            STATUSLINE_MARKER、statuslineSnippet()、resolveStatuslineScript()、statuslineStatus()、appendStatuslineSnippet()
  usage/statusline.ts             parseStatusline()、UsageTracker
  usage/aggregate.ts              aggregateUsage()
  indexer/indexFile.ts            Modify：usage_daily の集計、Artifact の抽出、artifactIds の返却
  indexer/service.ts              Modify：sessionChanged に artifactIds
  artifacts/extract.ts            parsePublishedUrl()、artifactCallOf()、resolveArtifactTitle()、recordArtifactPublish()
  artifacts/queries.ts            listArtifacts()、getArtifact()、addManualArtifact()
  projects/todos.ts               listTodos()、addTodo()、setTodoDone()、removeTodo()
  projects/memo.ts                MemoStore、memoHead()
  projects/scratch.ts             scratchRoot()、ensureScratchProject()、newScratchDir()、isUnderScratch()
  projects/promote.ts             PromoteError、promoteSession()
  runs/manager.ts                 Modify：start() のスクラッチ分岐
  mcp/tools.ts                    Modify：update_project の TODO とメモ、get_project の artifacts、get_usage
  mcp/app.ts                      Modify：説明文
  summary/types.ts                Summarizer、SummaryInput、SummaryOutput、SummarizerError、SUMMARY_SCHEMA、SUMMARY_SYSTEM_PROMPT、parseSummaryOutput()
  summary/input.ts                compressEvents()、buildSummaryInput()、CANNED_INPUT
  summary/lmstudio.ts             LmStudioSummarizer
  summary/claude.ts               ClaudeHeadlessSummarizer
  summary/job.ts                  isSummaryStale()、SummaryJob
  http/app.ts                     Modify：ingest、usage、statusline、todos、memo、artifacts、promote、summarize、summarizer、sessions PATCH、settings の項目
  server.ts                       Modify：結線
packages/cli/src/
  statusline.ts                   promptYesNo()、runStatuslineInstall()
  setup.ts                        Modify：手順 4 の提案
  index.ts                        Modify：hangar statusline install、setup の --yes
packages/ui/src/
  store/store.ts                  Modify：usage、todos、memos、artifacts、summaryPending、usageAggregate、statusline、summarizerModels、summarizerTest
  runtime/api.ts                  Modify：新しい経路
  runtime/runtime.ts              Modify：新しい効果、promote.done、split の接続
  mediator/types.ts               Modify：Overlay の promote と promoted、newSession の scratch、SessionViewState の split、promote 領域、効果
  mediator/launch.ts              Modify：scratch の起動
  mediator/promote.ts             promoteStep()
  mediator/workbench.ts           workbenchStep()（TODO、メモ、アーティファクト、要約、パレットの実行）
  mediator/sessionView.ts         Modify：split.toggle、tab.select の分割
  mediator/screen.ts              Modify：project と settings 画面の読み込み効果
  mediator/transition.ts          Modify：領域の合成と NOT_YET_INTENTS
  presenters/shell.ts             Modify：usage
  presenters/projects.ts          Modify：is_scratch の除外
  presenters/project.ts           Modify：todos、memo、artifacts、isScratch
  presenters/row.ts               Modify：cost、runId
  presenters/session.ts           Modify：contextPercent、cost、artifacts、summaryPending、fromScratch、canPromote、split
  presenters/newSession.ts        Modify：scratch
  presenters/palette.ts           presentPalette()、fuzzyScore()
  presenters/promote.ts           presentPromote()、presentPromoted()
  presenters/settings.ts          Modify：statusline、summarizer、usageAggregate
  presenters/format.ts            Modify：percentLabel()、costLabel()
  views/primitives/UsageGauge.tsx
  views/primitives/RollingNumber.tsx
  views/primitives/flip.ts        useFlip()
  views/Header.tsx                Modify：ゲージ
  views/ProjectCard.tsx           Modify：memoHead、ここで新規
  views/ProjectsScreen.tsx        Modify：FLIP
  views/TodoList.tsx
  views/MemoEditor.tsx
  views/ArtifactCards.tsx
  views/ProjectScreen.tsx         Modify：右レール
  views/SplitPane.tsx
  views/PromoteDialog.tsx         PromoteDialog、PromotedDialog
  views/NewSessionDialog.tsx      Modify：scratch
  views/SessionScreen.tsx         Modify：分割、コンテキスト、アーティファクト、要約の状態、昇格
  views/SessionRows.tsx           Modify：メモの編集、j k Enter o e m
  views/CommandPalette.tsx
  views/SettingsScreen.tsx        Modify：statusline、要約器、使用量
  styles/base.css                 Modify：ゲージ、TODO、分割、パレット、カード
  Root.tsx、main.tsx              Modify：ショートカット、オーバーレイ、パレットの入力、focus の対象
```

## インターフェース一覧

後のタスクが依存する名前と型を先にまとめる。
各タスクの Interfaces はこの一覧の抜粋である。

```ts
// packages/shared/src/api.ts（追加と変更）
export type RateWindowDto = { usedPercent: number; resetsAt: number | null };
export type UsageDto = { fiveHour: RateWindowDto | null; sevenDay: RateWindowDto | null; updatedAt: number | null };
export type UsageDayDto = { day: string; inputTokens: number; outputTokens: number; sessions: number };
export type UsageProjectDto = { projectId: string | null; name: string; inputTokens: number; outputTokens: number; costUsd: number | null; sessions: number };
export type UsageAggregateDto = { days: UsageDayDto[]; projects: UsageProjectDto[] };
export type StatuslineStatusDto = { command: string | null; scriptPath: string | null; installed: boolean };
export type TodoDto = { id: string; projectId: string; text: string; done: boolean; position: number; sessionId: string | null; updatedAt: number };
export type MemoDto = { projectId: string; markdown: string; updatedAt: number };
export type ArtifactDto = { id: string; projectId: string | null; url: string; title: string | null; description: string | null; favicon: string | null; filePath: string | null; fileExists: boolean; firstPublishedAt: number; lastPublishedAt: number; versionCount: number; sessionIds: string[] };
export type PromoteResultDto = { project: ProjectDto; session: SessionDto; moved: boolean; reason: string | null };
export type SummarizerId = 'lmstudio' | 'claude-headless';
export type SummarizerTestDto = { ok: true; id: SummarizerId; ms: number; summary: Omit<SessionSummaryDto, 'updatedAt'> } | { ok: false; tried: { id: SummarizerId; message: string }[] };
export type SessionStatsDto = { turns: number; model: string | null; effort: string | null; filesChanged: number; prUrl: string | null; inputTokens: number; outputTokens: number; contextPercent: number | null; costUsd: number | null };
export type SessionDto = { ...フェーズ 1...; fromScratch: boolean };
export type SettingsDto = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number };
export type BootstrapDto = { ...フェーズ 2...; usage: UsageDto; todos: TodoDto[]; artifacts: ArtifactDto[]; summaryPending: string[] };

// packages/shared/src/events.ts（追加）
  | { type: 'usage.update'; usage: UsageDto }
  | { type: 'todos.update'; projectId: string; todos: TodoDto[] }
  | { type: 'memo.update'; memo: MemoDto }
  | { type: 'artifact.upsert'; artifact: ArtifactDto }
  | { type: 'summary.pending'; sessionId: string }
  | { type: 'summary.updated'; sessionId: string }
  | { type: 'summary.failed'; sessionId: string; message: string }

// packages/shared/src/intent.ts（変更と追加）
  | { type: 'session.promote.submit'; id: SessionId; name: string; gitInit: boolean; moveFiles: boolean }
  | { type: 'artifact.openEditor'; id: ArtifactId }   // Task 18 で足す。設計文書の一覧に無かった
  | { type: 'split.resize'; ratio: number }          // SplitPane の中で完結する
  | { type: 'summarizer.test' }

// packages/server/src/db/migrations.ts（version 3）
create table session_live_stats (provider_session_id text primary key, model text, effort text, context_used integer, context_size integer, cost_usd real, updated_at integer not null);
create table artifact_calls (tool_id text primary key, session_id text not null, file_path text, description text, favicon text);
create table usage_daily (session_id text not null, day text not null, input_tokens integer not null default 0, output_tokens integer not null default 0, primary key (session_id, day));
create index artifact_versions_session on artifact_versions(session_id);
create index todos_project on todos(project_id, position);

// packages/server/src/config/paths.ts
export type Settings = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number };

// packages/server/src/config/statusline.ts
export const STATUSLINE_MARKER = '# agent-hangar: 使用量をローカルサーバへ渡す。失敗は無視する。';
export function statuslineSnippet(port: number): string;                                  // 目印の行で始まる 7 行
export function resolveStatuslineScript(claudeDir: string, homeDir?: string): { command: string | null; scriptPath: string | null };
export function statuslineStatus(claudeDir: string, homeDir?: string): StatuslineStatusDto;
export function appendStatuslineSnippet(scriptPath: string, port: number, now?: Date): { changed: boolean; backup: string | null };

// packages/server/src/usage/statusline.ts
export type StatuslinePayload = { providerSessionId: string | null; model: string | null; effort: string | null; contextUsed: number | null; contextSize: number | null; costUsd: number | null; rateLimits: { fiveHour: RateWindowDto | null; sevenDay: RateWindowDto | null } | null };
export function parseStatusline(raw: unknown): StatuslinePayload | null;                   // オブジェクトでなければ null
export class UsageTracker {
  constructor(db: Db, opts?: { now?: () => number; keep?: number });                        // keep の既定は 500
  current(): UsageDto;
  ingest(raw: unknown): { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null } | null;
}

// packages/server/src/usage/aggregate.ts
export function aggregateUsage(db: Db, opts: { days: number; now?: number }): UsageAggregateDto;

// packages/server/src/artifacts/extract.ts
export type ArtifactCall = { filePath: string | null; description: string | null; favicon: string | null };
export const ARTIFACT_URL_RE: RegExp;
export function parsePublishedUrl(text: string): string | null;
export function artifactCallOf(input: unknown): ArtifactCall;
export function resolveArtifactTitle(filePath: string | null, description: string | null, readHead?: (p: string) => string | null): string | null;
export function recordArtifactPublish(db: Db, deviceId: string, o: { sessionId: string; projectId: string | null; url: string; publishedAt: number; call: ArtifactCall }): string;   // artifact の id

// packages/server/src/artifacts/queries.ts
export function listArtifacts(db: Db, opts?: { projectId?: string; sessionId?: string; ids?: string[] }): ArtifactDto[];   // last_published_at の降順
export function getArtifact(db: Db, id: string): ArtifactDto | null;
export function addManualArtifact(db: Db, deviceId: string, projectId: string, url: string, now?: number): ArtifactDto;    // URL が claude.ai でなければ Error

// packages/server/src/projects/todos.ts
export function listTodos(db: Db, projectId?: string): TodoDto[];                            // position 昇順
export function addTodo(db: Db, deviceId: string, o: { projectId: string; text: string; sessionId?: string | null }): TodoDto;
export function setTodoDone(db: Db, deviceId: string, id: string, done: boolean): TodoDto | null;
export function removeTodo(db: Db, deviceId: string, id: string): TodoDto | null;

// packages/server/src/projects/memo.ts
export function memoHead(markdown: string | null): string | null;
export class MemoStore {
  constructor(o: { db: Db; deviceId: string; home: string; debounceMs?: number });
  memoPath(projectId: string): string;                                                        // <home>/projects/<projectId>/memo.md
  read(projectId: string): MemoDto | null;                                                    // reconcile してから返す
  write(projectId: string, markdown: string): MemoDto;                                       // DB とファイルの両方
  reconcile(projectId: string): { changed: boolean; memo: MemoDto | null };                  // ファイルが新しければ DB を直す
  reconcileAll(): MemoDto[];                                                                   // 変わったものだけ
  watch(onChange: (memo: MemoDto) => void): () => void;
}

// packages/server/src/projects/scratch.ts
export const SCRATCH_PROJECT_NAME = 'スクラッチ';
export function scratchRoot(home: string): string;                                            // <home>/scratch
export function ensureScratchProject(db: Db, deviceId: string, home: string): string;        // project の id
export function newScratchDir(home: string, now?: Date): string;                              // 作成して絶対パスを返す
export function isUnderScratch(home: string, cwd: string): boolean;

// packages/server/src/projects/promote.ts
export class PromoteError extends Error { readonly status: 400 | 404 | 409 }
export type PromoteDeps = { db: Db; deviceId: string; home: string; workspaceRoot: string; runAlive: (sessionId: string) => boolean; gitInit?: (dir: string) => void };
export function promoteSession(deps: PromoteDeps, o: { sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }): { projectId: string; moved: boolean; reason: string | null };

// packages/server/src/summary/types.ts
export type SummaryInput = { sessionId: string; text: string; turns: number; running: boolean; titleHint: string | null };
export type SummaryOutput = { title: string; oneLiner: string; body: string; state: SummaryState; nextSteps: string[] };
export interface Summarizer { readonly id: SummarizerId; available(): Promise<boolean>; summarize(input: SummaryInput): Promise<SummaryOutput> }
export class SummarizerError extends Error { constructor(readonly id: SummarizerId, message: string) }
export const SUMMARY_SCHEMA: Record<string, unknown>;
export const SUMMARY_SYSTEM_PROMPT: string;
export function parseSummaryOutput(v: unknown): SummaryOutput | null;

// packages/server/src/summary/input.ts
export type CompressOptions = { userMax?: number; assistantMax?: number; totalMax?: number };   // 2000、600、12000
export function compressEvents(events: TranscriptEvent[], opts?: CompressOptions): string;
export function buildSummaryInput(db: Db, sessionId: string, running: boolean): SummaryInput | null;   // 本文が無ければ null
export const CANNED_INPUT: SummaryInput;

// packages/server/src/summary/lmstudio.ts
export class LmStudioSummarizer implements Summarizer {
  constructor(o: { baseUrl: string; model: string | null; fetch?: typeof fetch; timeoutMs?: number });
  listModels(): Promise<string[]>;
}

// packages/server/src/summary/claude.ts
export type SpawnText = (cmd: string, args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
export class ClaudeHeadlessSummarizer implements Summarizer {
  constructor(o: { claudeBin: string | null; hourlyCap: number; usage: () => UsageDto; spawn?: SpawnText; now?: () => number });
  callsInLastHour(): number;
}

// packages/server/src/summary/job.ts
export type SummaryJobDeps = { db: Db; deviceId: string; summarizers: () => Summarizer[]; live: () => LiveSessionDto[]; hub: { broadcast(ev: ServerEvent): void }; now?: () => number };
export function isSummaryStale(db: Db, sessionId: string): boolean;
export class SummaryJob {
  constructor(deps: SummaryJobDeps);
  enqueue(sessionId: string, force?: boolean): boolean;     // 受け付けたら true
  pending(): string[];
  idle(): Promise<void>;                                     // 待ち行列が空になるまで待つ（テスト用）
  test(input?: SummaryInput): Promise<SummarizerTestDto>;
}

// packages/server/src/http/app.ts（AppDeps の追加）
export type SummaryApi = { enqueue(sessionId: string, force?: boolean): boolean; pending(): string[]; test(): Promise<SummarizerTestDto>; listModels(): Promise<string[]> };
export type ExternalApi = { ...フェーズ 2...; openUrl(url: string): Promise<void> };
export type AppDeps = { ...フェーズ 2...; usage: { current(): UsageDto; ingest(raw: unknown): { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null } | null }; memos: MemoStore; summary: SummaryApi; promote: (o: { sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }) => { projectId: string; moved: boolean; reason: string | null } };

// packages/cli/src/statusline.ts
export type Ask = (question: string) => Promise<boolean>;
export function promptYesNo(question: string): Promise<boolean>;
export function runStatuslineInstall(o: { claudeDir: string; port: number; yes: boolean; ask?: Ask; log?: (s: string) => void }): Promise<{ installed: boolean; message: string }>;

// packages/ui/src/store/store.ts（追加）
export type Store = { ...; usage: UsageDto; todos: Record<string, TodoDto>; memos: Record<string, MemoDto>; artifacts: Record<string, ArtifactDto>; summaryPending: Record<string, true>; usageAggregate: UsageAggregateDto | null; statusline: StatuslineStatusDto | null; summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null };
export function todosOf(store: Store, projectId: string): TodoDto[];
export function artifactsOf(store: Store, opts: { projectId?: string; sessionId?: string }): ArtifactDto[];

// packages/ui/src/runtime/api.ts（ApiClient に追加）
usage(): Promise<UsageDto>;                                                  // GET /api/usage
usageAggregate(days: number): Promise<UsageAggregateDto>;                    // GET /api/usage/aggregate?days=
statusline(): Promise<StatuslineStatusDto>;                                  // GET /api/statusline
addTodo(projectId: string, text: string): Promise<TodoDto>;                  // POST /api/projects/:id/todos
setTodoDone(id: string, done: boolean): Promise<TodoDto>;                    // PATCH /api/todos/:id
removeTodo(id: string): Promise<TodoDto>;                                    // DELETE /api/todos/:id
memo(projectId: string): Promise<MemoDto>;                                   // GET /api/projects/:id/memo
saveMemo(projectId: string, markdown: string): Promise<MemoDto>;             // PUT /api/projects/:id/memo
setSessionMemo(sessionId: string, memo: string): Promise<SessionDto>;        // PATCH /api/sessions/:id
addArtifact(projectId: string, url: string): Promise<ArtifactDto>;           // POST /api/projects/:id/artifacts
openArtifact(id: string): Promise<void>;                                     // POST /api/artifacts/:id/open
openArtifactEditor(id: string): Promise<void>;                               // POST /api/artifacts/:id/open-editor
promote(sessionId: string, body: { name: string; gitInit: boolean; moveFiles: boolean }): Promise<PromoteResultDto>;   // POST /api/sessions/:id/promote
regenerateSummary(sessionId: string): Promise<void>;                         // POST /api/sessions/:id/summarize
summarizerModels(): Promise<{ models: string[] }>;                           // GET /api/summarizer/models
testSummarizer(): Promise<SummarizerTestDto>;                                // POST /api/summarizer/test

// packages/ui/src/mediator/types.ts（追加と変更）
export type RuntimeEvent = ... | { type: 'promote.done'; projectId: string; moved: boolean; reason: string | null } | { type: 'promote.failed'; message: string } | { type: 'split.resolved'; sessionId: string; tabId: string | null };
export type Effect = ...
  | { kind: 'api.addTodo'; projectId: string; text: string } | { kind: 'api.toggleTodo'; id: string } | { kind: 'api.removeTodo'; id: string }
  | { kind: 'api.loadMemo'; projectId: string } | { kind: 'api.saveMemo'; projectId: string; markdown: string } | { kind: 'api.setSessionMemo'; sessionId: string; text: string }
  | { kind: 'api.openArtifact'; id: string } | { kind: 'api.openArtifactEditor'; id: string } | { kind: 'api.addArtifact'; projectId: string; url: string }
  | { kind: 'api.promote'; sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }
  | { kind: 'api.regenerateSummary'; sessionId: string }
  | { kind: 'api.loadSettingsExtras' } | { kind: 'api.testSummarizer' }
  | { kind: 'split.resolve'; sessionId: string }      // 右に置くタブをストアから決めて split.resolved を返す
  | { kind: 'focus'; target: FocusTarget };   // FocusTarget = 'search' | 'newSessionName' | 'terminal' | 'palette' | 'promoteName' | 'todoInput'
export type Overlay = ... | { kind: 'newSession'; projectId: string | null; scratch: boolean } | { kind: 'promote'; sessionId: string } | { kind: 'promoted'; projectId: string; moved: boolean; reason: string | null };
export type SessionViewState = { ...; split: boolean; splitTab: string | null };
export type State = { ...; promote: LaunchState; summaryFailed: Record<string, string> };

// packages/ui/src/presenters/shell.ts（追加）
export type UsageProps = { fiveHour: number | null; sevenDay: number | null; updatedLabel: string | null };
export type ShellProps = { ...; usage: UsageProps };

// packages/ui/src/presenters/project.ts（追加）
export type TodoItemProps = { id: string; text: string; done: boolean };
export type ArtifactCardProps = { id: string; title: string; description: string | null; favicon: string; url: string; lastPublished: string; versionCount: number; canOpenEditor: boolean };
export type ProjectProps = { ...; isScratch: boolean; todos: TodoItemProps[]; memo: { markdown: string; updatedAt: number } | null; artifacts: ArtifactCardProps[] };

// packages/ui/src/presenters/session.ts（追加）
export type SessionProps = { ...; contextPercent: number | null; cost: string; artifacts: ArtifactCardProps[]; summaryPending: boolean; summaryError: string | null; fromScratch: boolean; canPromote: boolean; split: { left: string; right: string } | null; canSplit: boolean };

// packages/ui/src/presenters/row.ts（追加）
export type SessionRowProps = { ...; cost: string; runId: string | null };

// packages/ui/src/presenters/format.ts（追加）
export function percentLabel(n: number | null): string;                         // null は「未取得」
export function costLabel(n: number | null): string;                            // null は空文字、それ以外は $0.00 の形

// packages/ui/src/presenters/palette.ts
export type PaletteItem = { id: string; label: string; hint: string; kind: 'command' | 'project' | 'session' };
export type PaletteProps = { query: string; items: PaletteItem[] };
export function fuzzyScore(query: string, text: string): number;                 // 0 は不一致
export function presentPalette(state: State, store: Store, query: string): PaletteProps | null;   // overlay が palette でなければ null

// packages/ui/src/presenters/promote.ts
export type PromoteProps = { sessionId: string; sessionName: string; runAlive: boolean; submitting: boolean; error: string | null };
export type PromotedProps = { projectId: string; projectName: string; moved: boolean; reason: string | null };
export function presentPromote(state: State, store: Store): PromoteProps | null;
export function presentPromoted(state: State, store: Store): PromotedProps | null;

// packages/ui/src/presenters/settings.ts（追加）
export type SettingsProps = { ...; lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number; summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null; statusline: StatuslineStatusDto | null; statuslineCommand: string; usageAggregate: UsageAggregateDto | null };

// packages/ui/src/views
export function UsageGauge(props: { label: string; percent: number | null }): JSX.Element;
export function RollingNumber(props: { value: number | null; suffix?: string }): JSX.Element;
export function useFlip(keys: string[]): (key: string) => (el: HTMLElement | null) => void;
export function TodoList(props: { projectId: string; todos: TodoItemProps[] }): JSX.Element;
export function MemoEditor(props: { projectId: string; markdown: string; updatedAt: number }): JSX.Element;
export function ArtifactCards(props: { projectId: string | null; artifacts: ArtifactCardProps[]; canAdd: boolean }): JSX.Element;
export function SplitPane(props: { left: ReactNode; right: ReactNode }): JSX.Element;
export function PromoteDialog(props: PromoteProps): JSX.Element;
export function PromotedDialog(props: PromotedProps): JSX.Element;
export function CommandPalette(props: PaletteProps & { onQuery: (q: string) => void }): JSX.Element;
```

---

### Task 1: shared の DTO、イベント、Intent の拡張

**Files:**
- Modify: `packages/shared/src/api.ts`、`packages/shared/src/events.ts`、`packages/shared/src/intent.ts`
- Test: `packages/shared/src/api.test.ts`（追加）

**Interfaces:**
- Produces: 「インターフェース一覧」の shared の型すべて。
- `SettingsDto` は `Settings`（`intent.ts` の別名）としても使われるので、`settings.update` の `patch` に `lmStudioUrl` などが乗る。

- [ ] **Step 1: 失敗するテストを書く**

`packages/shared/src/api.test.ts` に次の `describe` を足す。

```ts
import type { ArtifactDto, BootstrapDto, Intent, MemoDto, PromoteResultDto, ServerEvent, SessionDto, SettingsDto, SummarizerTestDto, TodoDto, UsageDto } from './index.ts';

describe('フェーズ 3 の DTO', () => {
  it('UsageDto、TodoDto、MemoDto、ArtifactDto が組み立てられる', () => {
    const usage: UsageDto = { fiveHour: { usedPercent: 47, resetsAt: 1_700_000_000_000 }, sevenDay: null, updatedAt: 1 };
    const todo: TodoDto = { id: 't1', projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1 };
    const memo: MemoDto = { projectId: 'p1', markdown: '# m', updatedAt: 1 };
    const art: ArtifactDto = { id: 'a1', projectId: 'p1', url: 'https://claude.ai/code/artifact/x', title: 't', description: null, favicon: '📊', filePath: null, fileExists: false, firstPublishedAt: 1, lastPublishedAt: 2, versionCount: 2, sessionIds: ['s1'] };
    const evs: ServerEvent[] = [{ type: 'usage.update', usage }, { type: 'todos.update', projectId: 'p1', todos: [todo] }, { type: 'memo.update', memo }, { type: 'artifact.upsert', artifact: art }, { type: 'summary.pending', sessionId: 's1' }, { type: 'summary.updated', sessionId: 's1' }, { type: 'summary.failed', sessionId: 's1', message: 'x' }];
    expect(evs.map((e) => e.type)).toHaveLength(7);
  });
  it('SettingsDto、SessionDto、BootstrapDto に新しい項目がある', () => {
    const s: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20 };
    const ses: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: null, cwd: '/x', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: null, memo: null, hasTranscript: false, live: null, summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null } };
    const b: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: s, projects: [], sessions: [ses], live: [], runs: [], tabs: [], usage: { fiveHour: null, sevenDay: null, updatedAt: null }, todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '0' };
    expect(b.summaryPending).toEqual([]);
    const r: PromoteResultDto = { project: { id: 'p', name: 'n', status: 'active', isScratch: false, path: '/w/n', resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 }, session: ses, moved: true, reason: null };
    expect(r.moved).toBe(true);
    const t: SummarizerTestDto = { ok: false, tried: [{ id: 'lmstudio', message: 'x' }] };
    expect(t.ok).toBe(false);
  });
  it('Intent に gitInit、split.resize、summarizer.test がある', () => {
    const is: Intent[] = [{ type: 'session.promote.submit', id: 's1', name: 'n', gitInit: true, moveFiles: false }, { type: 'split.resize', ratio: 0.4 }, { type: 'summarizer.test' }];
    expect(is).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/shared/src/api && npm run typecheck`
Expected: FAIL（型エラー）

- [ ] **Step 3: 型を足す**

`packages/shared/src/api.ts` の `SessionStatsDto`、`SessionDto`、`SettingsDto`、`BootstrapDto` を置き換え、末尾に追加する。

```ts
export type SessionStatsDto = { turns: number; model: string | null; effort: string | null; filesChanged: number; prUrl: string | null; inputTokens: number; outputTokens: number; contextPercent: number | null; costUsd: number | null };
export type SessionDto = { id: string; provider: 'claude-code'; providerSessionId: string; projectId: string | null; name: string | null; cwd: string; firstPrompt: string | null; aiTitle: string | null; startedAt: number | null; lastActivityAt: number | null; memo: string | null; hasTranscript: boolean; live: LiveStatus | null; summary: SessionSummaryDto | null; stats: SessionStatsDto; fromScratch: boolean };
export type SettingsDto = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number };
export type BootstrapDto = { device: { id: string; name: string }; settings: SettingsDto; projects: ProjectDto[]; sessions: SessionDto[]; live: LiveSessionDto[]; runs: RunDto[]; tabs: TabDto[]; usage: UsageDto; todos: TodoDto[]; artifacts: ArtifactDto[]; summaryPending: string[]; index: IndexProgressDto; version: string };

/** statusline の payload から得た使用率。窓の値が無いときは null で、updatedAt は使用率が届いた時刻。 */
export type RateWindowDto = { usedPercent: number; resetsAt: number | null };
export type UsageDto = { fiveHour: RateWindowDto | null; sevenDay: RateWindowDto | null; updatedAt: number | null };
export type UsageDayDto = { day: string; inputTokens: number; outputTokens: number; sessions: number };
export type UsageProjectDto = { projectId: string | null; name: string; inputTokens: number; outputTokens: number; costUsd: number | null; sessions: number };
export type UsageAggregateDto = { days: UsageDayDto[]; projects: UsageProjectDto[] };
export type StatuslineStatusDto = { command: string | null; scriptPath: string | null; installed: boolean };
export type TodoDto = { id: string; projectId: string; text: string; done: boolean; position: number; sessionId: string | null; updatedAt: number };
export type MemoDto = { projectId: string; markdown: string; updatedAt: number };
export type ArtifactDto = { id: string; projectId: string | null; url: string; title: string | null; description: string | null; favicon: string | null; filePath: string | null; fileExists: boolean; firstPublishedAt: number; lastPublishedAt: number; versionCount: number; sessionIds: string[] };
export type PromoteResultDto = { project: ProjectDto; session: SessionDto; moved: boolean; reason: string | null };
export type SummarizerId = 'lmstudio' | 'claude-headless';
export type SummarizerTestDto = { ok: true; id: SummarizerId; ms: number; summary: Omit<SessionSummaryDto, 'updatedAt'> } | { ok: false; tried: { id: SummarizerId; message: string }[] };
```

`packages/shared/src/events.ts` を次に置き換える。

```ts
import type { ArtifactDto, IndexProgressDto, LiveSessionDto, MemoDto, ProjectDto, RunDto, SessionDto, TabDto, TodoDto, UsageDto } from './api.ts';

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
  | { type: 'usage.update'; usage: UsageDto }
  | { type: 'todos.update'; projectId: string; todos: TodoDto[] }
  | { type: 'memo.update'; memo: MemoDto }
  | { type: 'artifact.upsert'; artifact: ArtifactDto }
  | { type: 'summary.pending'; sessionId: string }
  | { type: 'summary.updated'; sessionId: string }
  | { type: 'summary.failed'; sessionId: string; message: string }
  | { type: 'toast'; level: 'info' | 'error'; message: string };
```

`packages/shared/src/intent.ts` の `session.promote.submit` の行を置き換え、`split.toggle` の行の後に 2 つ足す。

```ts
  | { type: 'session.promote.open'; id: SessionId } | { type: 'session.promote.submit'; id: SessionId; name: string; gitInit: boolean; moveFiles: boolean }
```

```ts
  | { type: 'split.toggle' } | { type: 'split.resize'; ratio: number } | { type: 'transcript.toggle' }
  | { type: 'summarizer.test' }
```

- [ ] **Step 4: フェーズ 2 までのテストを直す**

`SettingsDto` と `BootstrapDto` と `SessionDto` に項目が増えたので、既存のテストで組み立てている箇所を直す。

- `packages/server/src/http/app.test.ts` の `settings` の初期値に `lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20` を足す。
- `packages/ui/src/runtime/runtime.test.ts`、`packages/ui/src/store/store.test.ts`、`packages/ui/src/Root.test.tsx` の `boot` の `settings` に同じ 4 項目を、`boot` 自体に `usage: { fiveHour: null, sevenDay: null, updatedAt: null }, todos: [], artifacts: [], summaryPending: []` を足す。
- `packages/ui/src/presenters/presenters.test.ts` の `session()` 補助の `stats` に `contextPercent: null, costUsd: null` を、返り値に `fromScratch: false` を足す。
- `packages/ui/src/views/SessionRows.test.tsx` などで `SessionDto` を直接組み立てている箇所があれば同じく足す（`grep -rn 'inputTokens:' packages/ui/src --include=*.test.ts*` で探す）。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/shared && npm run typecheck 2>&1 | grep -c 'error TS'`
Expected: shared は PASS。`typecheck` のエラーは server の `queries.ts`（`fromScratch`、`contextPercent`、`costUsd`）と `app.ts`（`bootstrap` の項目、`toSettingsDto`）と ui の `initialStore` の箇所だけに限られる（Task 2、Task 16、Task 17 で埋める）。

- [ ] **Step 6: コミット**

```bash
git add packages/shared packages/server/src/http/app.test.ts packages/ui/src
git commit -m "feat(shared): usage, todo, memo, artifact, promote and summarizer dtos for phase 3"
```

---

### Task 2: マイグレーション 3 と問い合わせの拡張

**Files:**
- Modify: `packages/server/src/db/migrations.ts`、`packages/server/src/db/queries.ts`
- Test: `packages/server/src/db/db.test.ts`（追加）、`packages/server/src/db/queries.test.ts`（追加）

**Interfaces:**
- Produces: version 3 のテーブル、`listProjects` と `getProject` の `openTodoCount` と `memoHead`、`listSessions` と `getSession` の `fromScratch`、`stats.contextPercent`、`stats.costUsd`、`stats.model` と `stats.effort` の優先順位。
- `listProjects` と `getProject` は引数を変えない。`fromScratch` の判定には `scratch` のルート（`is_scratch = 1` のプロジェクトの `project_roots.path`）を使うので、`listSessions` と `getSession` にも引数を足さない。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/db/db.test.ts` に足す。

```ts
  it('version 3 の端末ローカルの表がある', () => {
    const db = openDb(':memory:');
    const names = (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['session_live_stats', 'artifact_calls', 'usage_daily']));
    expect((db.prepare('select max(version) v from schema_migrations').get() as { v: number }).v).toBe(3);
    db.prepare('insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)').run('u1', 'claude-opus-4-1', 'high', 50_000, 200_000, 0.12, 1);
    db.prepare('insert into usage_daily (session_id, day, input_tokens, output_tokens) values (?,?,?,?)').run('s1', '2026-09-01', 10, 2);
    expect(db.prepare('select count(*) c from usage_daily').get()).toEqual({ c: 1 });
  });
```

`packages/server/src/db/queries.test.ts` に足す。

```ts
describe('フェーズ 3 の項目', () => {
  it('openTodoCount と memoHead はプロジェクトに付く', () => {
    upsertShared(db, 'todos', { id: 't1', project_id: 'p1', text: 'a', done: 0, position: 1, session_id: null }, 'd');
    upsertShared(db, 'todos', { id: 't2', project_id: 'p1', text: 'b', done: 1, position: 2, session_id: null }, 'd');
    upsertShared(db, 'todos', { id: 't3', project_id: 'p1', text: 'c', done: 0, position: 3, session_id: null }, 'd');
    db.prepare('update todos set deleted_at = 1 where id = ?').run('t3');
    upsertShared(db, 'project_memos', { project_id: 'p1', markdown: '\n\n# 見出し\n本文' }, 'd', 'project_id');
    const p = getProject(db, 'd', live, 'p1')!;
    expect(p.openTodoCount).toBe(1);
    expect(p.memoHead).toBe('# 見出し');
    expect(listProjects(db, 'd', live)[0]).toMatchObject({ openTodoCount: 1, memoHead: '# 見出し' });
  });
  it('statusline の値が stats に乗り、無ければ索引の値', () => {
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    expect(alpha.stats).toMatchObject({ model: 'claude-fable-5-1', effort: 'high', contextPercent: null, costUsd: null });
    db.prepare('insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)').run(SESSION_ALPHA, 'claude-opus-4-1', 'max', 50_000, 200_000, 0.1234, 1);
    const again = getSession(db, live, alpha.id)!;
    expect(again.stats).toMatchObject({ model: 'claude-opus-4-1', effort: 'max', contextPercent: 25, costUsd: 0.1234 });
  });
  it('fromScratch はスクラッチの下にあって別のプロジェクトに属するときだけ真', () => {
    upsertShared(db, 'projects', { id: 'scratch', name: 'スクラッチ', status: 'active', is_scratch: 1 }, 'd');
    upsertShared(db, 'project_roots', { id: 'rs', project_id: 'scratch', device_id: 'd', path: '/Users/me/.agent-hangar/scratch', resolved: 1 }, 'd');
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    expect(alpha.fromScratch).toBe(false);
    db.prepare('update sessions set cwd = ? where id = ?').run('/Users/me/.agent-hangar/scratch/20260901-100000', alpha.id);
    expect(getSession(db, live, alpha.id)!.fromScratch).toBe(true);
    db.prepare("update sessions set project_id = 'scratch' where id = ?").run(alpha.id);
    expect(getSession(db, live, alpha.id)!.fromScratch).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/db`
Expected: FAIL

- [ ] **Step 3: マイグレーションを足す**

`packages/server/src/db/migrations.ts` の配列の末尾に足す。

```ts
  {
    version: 3,
    sql: `
create table session_live_stats (
  provider_session_id text primary key,
  model text, effort text,
  context_used integer, context_size integer,
  cost_usd real,
  updated_at integer not null
);
create table artifact_calls (
  tool_id text primary key, session_id text not null,
  file_path text, description text, favicon text
);
create table usage_daily (
  session_id text not null, day text not null,
  input_tokens integer not null default 0, output_tokens integer not null default 0,
  primary key (session_id, day)
);
create index artifact_versions_session on artifact_versions(session_id);
create index todos_project on todos(project_id, position);
`,
  },
```

- [ ] **Step 4: 問い合わせを直す**

`packages/server/src/db/queries.ts` の `SessionRow`、`SESSION_SELECT`、`toSessionDto`、`ProjectRow`、`PROJECT_SELECT`、`toProjectDto` を次に置き換える。
`displayName`、`parseNextSteps`、`liveMapOf`、`listSessions`、`getSession`、`listProjects`、`getProject` はそのまま。

```ts
type SessionRow = {
  id: string; provider: 'claude-code'; provider_session_id: string; project_id: string | null; name: string | null; cwd: string;
  first_prompt: string | null; ai_title: string | null; started_at: number | null; last_activity_at: number | null; memo: string | null;
  has_transcript: number; project_is_scratch: number | null; scratch_root: string | null;
  sum_title: string | null; sum_one: string | null; sum_body: string | null; sum_state: SessionSummaryDto['state'] | null; sum_next: string | null; sum_source: SessionSummaryDto['source'] | null; sum_model: string | null; sum_turns: number | null; sum_updated: number | null;
  st_turns: number | null; st_model: string | null; st_effort: string | null; st_files: number | null; st_pr: string | null; st_in: number | null; st_out: number | null;
  ls_model: string | null; ls_effort: string | null; ls_used: number | null; ls_size: number | null; ls_cost: number | null;
};

const SESSION_SELECT = `
select s.*, exists(select 1 from transcript_files t where t.session_id = s.id and t.agent_id is null) has_transcript,
  p.is_scratch project_is_scratch,
  (select r.path from project_roots r join projects sp on sp.id = r.project_id where sp.is_scratch = 1 and sp.deleted_at is null and r.deleted_at is null order by r.updated_at desc limit 1) scratch_root,
  m.title sum_title, m.one_liner sum_one, m.body sum_body, m.state sum_state, m.next_steps sum_next, m.source sum_source, m.source_model sum_model, m.based_on_turns sum_turns, m.updated_at sum_updated,
  st.turns st_turns, st.model st_model, st.effort st_effort, st.files_changed st_files, st.pr_url st_pr, st.input_tokens st_in, st.output_tokens st_out,
  ls.model ls_model, ls.effort ls_effort, ls.context_used ls_used, ls.context_size ls_size, ls.cost_usd ls_cost
from sessions s
left join projects p on p.id = s.project_id
left join session_summaries m on m.session_id = s.id and m.deleted_at is null
left join session_stats st on st.session_id = s.id
left join session_live_stats ls on ls.provider_session_id = s.provider_session_id
where s.deleted_at is null`;

/** コンテキスト使用率。分母が無いか 0 なら null。 */
export function contextPercent(used: number | null, size: number | null): number | null {
  if (used === null || size === null || size <= 0) return null;
  return Math.round((used / size) * 1000) / 10;
}

function toSessionDto(r: SessionRow, liveMap: Map<string, LiveSessionDto>): SessionDto {
  const live = liveMap.get(r.provider_session_id);
  const summary: SessionSummaryDto | null = r.sum_title !== null
    ? { title: r.sum_title, oneLiner: r.sum_one ?? '', body: r.sum_body ?? '', state: r.sum_state ?? 'done', nextSteps: parseNextSteps(r.sum_next), source: r.sum_source ?? 'baseline', sourceModel: r.sum_model, basedOnTurns: r.sum_turns ?? 0, updatedAt: r.sum_updated ?? 0 }
    : null;
  // statusline の値を優先し、無いときだけ索引の値を使う。
  const stats: SessionStatsDto = {
    turns: r.st_turns ?? 0, model: r.ls_model ?? r.st_model, effort: r.ls_effort ?? r.st_effort, filesChanged: r.st_files ?? 0, prUrl: r.st_pr,
    inputTokens: r.st_in ?? 0, outputTokens: r.st_out ?? 0, contextPercent: contextPercent(r.ls_used, r.ls_size), costUsd: r.ls_cost,
  };
  const underScratch = r.scratch_root !== null && (r.cwd === r.scratch_root || r.cwd.startsWith(r.scratch_root + '/'));
  return {
    id: r.id, provider: r.provider, providerSessionId: r.provider_session_id, projectId: r.project_id, name: displayName(r, live), cwd: r.cwd,
    firstPrompt: r.first_prompt, aiTitle: r.ai_title, startedAt: r.started_at, lastActivityAt: r.last_activity_at, memo: r.memo,
    hasTranscript: r.has_transcript === 1, live: live?.status ?? null, summary, stats,
    fromScratch: underScratch && r.project_is_scratch !== 1,
  };
}

type ProjectRow = { id: string; name: string; status: ProjectDto['status']; is_scratch: number; updated_at: number; path: string | null; resolved: number | null; last_activity_at: number | null; open_todos: number; memo_markdown: string | null };

const PROJECT_SELECT = `
select p.id, p.name, p.status, p.is_scratch, p.updated_at, r.path, r.resolved,
  (select max(s.last_activity_at) from sessions s where s.project_id = p.id and s.deleted_at is null) last_activity_at,
  (select count(*) from todos t where t.project_id = p.id and t.done = 0 and t.deleted_at is null) open_todos,
  (select m.markdown from project_memos m where m.project_id = p.id and m.deleted_at is null) memo_markdown
from projects p
left join project_roots r on r.project_id = p.id and r.device_id = ? and r.deleted_at is null
where p.deleted_at is null`;

/** メモの先頭。空行でない最初の行の先頭 80 字。 */
export function memoHead(markdown: string | null): string | null {
  if (!markdown) return null;
  const line = markdown.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line ? [...line].slice(0, 80).join('') : null;
}

function toProjectDto(r: ProjectRow, db: Db, liveIds: Set<string>): ProjectDto {
  const psids = (db.prepare('select provider_session_id p from sessions where project_id = ? and deleted_at is null').all(r.id) as { p: string }[]).map((x) => x.p);
  return {
    id: r.id, name: r.name, status: r.status, isScratch: r.is_scratch === 1, path: r.path, resolved: r.resolved === 1, lastActivityAt: r.last_activity_at,
    runningCount: psids.filter((p) => liveIds.has(p)).length, openTodoCount: r.open_todos, memoHead: memoHead(r.memo_markdown), updatedAt: r.updated_at,
  };
}
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/db && npx tsc -p packages/server --noEmit 2>&1 | grep -v 'app.ts'`
Expected: PASS。`app.ts` の `bootstrap` の型エラーだけが残る。

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/db
git commit -m "feat(server): migration 3 with live stats, artifact calls and daily usage; todo count, memo head and scratch flag in queries"
```

---

### Task 3: statusline の payload の受け口（UsageTracker）

**Files:**
- Create: `packages/server/src/usage/statusline.ts`
- Test: `packages/server/src/usage/statusline.test.ts`

**Interfaces:**
- Consumes: `usage_snapshots`、`session_live_stats`（Task 2）。
- Produces: 「インターフェース一覧」の `StatuslinePayload`、`parseStatusline`、`UsageTracker`。
- payload の形はフェーズ 0 の spike 04 で観察したもの。`rate_limits.five_hour.used_percentage` と `resets_at`（秒の UNIX 時刻。ミリ秒に直す）、`model.id`（無ければ `display_name`）、`effort`、`context_window.current_usage`（トークン数のオブジェクトか null）と `context_window_size`、`cost.total_cost_usd`、`session_id`。
- `ingest` は生の JSON を `usage_snapshots` に積み（`at` は `now()` で、直前と同じミリ秒なら 1 を足す）、直近 `keep` 件だけ残す。`rate_limits` があれば使用率を更新して `updatedAt` を進め、無ければ何も変えない。`session_id` があれば `session_live_stats` を upsert し、null の項目は既存の値を保つ。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/usage/statusline.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { parseStatusline, UsageTracker } from './statusline.ts';

const first = { session_id: 'u1', session_name: 'n', cwd: '/x', transcript_path: '/t.jsonl', model: { id: 'claude-opus-4-1', display_name: 'Opus' }, effort: 'high', cost: { total_cost_usd: 0.05 }, context_window: { context_window_size: 200_000, current_usage: null } };
const second = { ...first, cost: { total_cost_usd: 0.12 }, context_window: { context_window_size: 200_000, current_usage: { input_tokens: 40_000, output_tokens: 1_000, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 5_000 } }, rate_limits: { five_hour: { used_percentage: 47, resets_at: 1_760_000_000 }, seven_day: { used_percentage: 7, resets_at: 1_760_500_000 } } };

describe('parseStatusline', () => {
  it('必要な項目だけを取り出す', () => {
    expect(parseStatusline(second)).toEqual({ providerSessionId: 'u1', model: 'claude-opus-4-1', effort: 'high', contextUsed: 50_000, contextSize: 200_000, costUsd: 0.12, rateLimits: { fiveHour: { usedPercent: 47, resetsAt: 1_760_000_000_000 }, sevenDay: { usedPercent: 7, resetsAt: 1_760_500_000_000 } } });
    expect(parseStatusline(first)).toMatchObject({ contextUsed: null, contextSize: 200_000, rateLimits: null });
    expect(parseStatusline({ model: { display_name: 'Opus' }, context_window: { current_usage: 12_345 } })).toMatchObject({ providerSessionId: null, model: 'Opus', contextUsed: 12_345, contextSize: null });
    expect(parseStatusline('x')).toBeNull();
    expect(parseStatusline(null)).toBeNull();
  });
});

describe('UsageTracker', () => {
  it('1 回目は rate_limits が無く、直前の値を保つ。2 回目で埋まる', () => {
    const db = openDb(':memory:');
    let t = 1_000;
    const tr = new UsageTracker(db, { now: () => t });
    expect(tr.current()).toEqual({ fiveHour: null, sevenDay: null, updatedAt: null });
    const a = tr.ingest(first)!;
    expect(a.usageChanged).toBe(false);
    expect(a.usage.updatedAt).toBeNull();
    t = 2_000;
    const b = tr.ingest(second)!;
    expect(b.usageChanged).toBe(true);
    expect(b.usage).toEqual({ fiveHour: { usedPercent: 47, resetsAt: 1_760_000_000_000 }, sevenDay: { usedPercent: 7, resetsAt: 1_760_500_000_000 }, updatedAt: 2_000 });
    t = 3_000;
    const c = tr.ingest(first)!;
    expect(c.usageChanged).toBe(false);
    expect(c.usage).toEqual(b.usage);
    expect((db.prepare('select count(*) c from usage_snapshots').get() as { c: number }).c).toBe(3);
    const ls = db.prepare('select * from session_live_stats where provider_session_id = ?').get('u1') as Record<string, unknown>;
    // 3 回目の payload は current_usage が null なので、2 回目の値を保つ。cost は 3 回目の値。
    expect(ls).toMatchObject({ model: 'claude-opus-4-1', effort: 'high', context_used: 50_000, context_size: 200_000, cost_usd: 0.05, updated_at: 3_000 });
  });
  it('起動時に直近のスナップショットから復元し、古いものを keep 件に切る', () => {
    const db = openDb(':memory:');
    let t = 10;
    const tr = new UsageTracker(db, { now: () => t, keep: 3 });
    tr.ingest(second);
    for (let i = 0; i < 4; i++) { t += 10; tr.ingest(first); }
    expect((db.prepare('select count(*) c from usage_snapshots').get() as { c: number }).c).toBe(3);
    // keep で second のスナップショットは消えたが、復元は残っている行だけを見る。
    const fresh = new UsageTracker(db, { now: () => t, keep: 3 });
    expect(fresh.current()).toEqual({ fiveHour: null, sevenDay: null, updatedAt: null });
    t += 10;
    tr.ingest(second);
    const again = new UsageTracker(db, { now: () => t, keep: 3 });
    expect(again.current()).toEqual({ fiveHour: { usedPercent: 47, resetsAt: 1_760_000_000_000 }, sevenDay: { usedPercent: 7, resetsAt: 1_760_500_000_000 }, updatedAt: t });
  });
  it('同じミリ秒の 2 件は at をずらして両方残す。壊れた payload は null', () => {
    const db = openDb(':memory:');
    const tr = new UsageTracker(db, { now: () => 5 });
    tr.ingest(first); tr.ingest(first);
    expect((db.prepare('select at from usage_snapshots order by at').all() as { at: number }[]).map((r) => r.at)).toEqual([5, 6]);
    expect(tr.ingest('not json')).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/usage`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/usage/statusline.ts`：

```ts
import type { RateWindowDto, UsageDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

// Claude Code が statusLine コマンドの標準入力に渡す JSON を読む。
// 形はフェーズ 0 の spike 04 で観察したもので、無い項目は null にする。

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export type StatuslinePayload = {
  providerSessionId: string | null; model: string | null; effort: string | null;
  contextUsed: number | null; contextSize: number | null; costUsd: number | null;
  rateLimits: { fiveHour: RateWindowDto | null; sevenDay: RateWindowDto | null } | null;
};

function window_(v: unknown): RateWindowDto | null {
  if (!isRec(v)) return null;
  const used = num(v.used_percentage);
  if (used === null) return null;
  const resets = num(v.resets_at);
  // resets_at は秒の UNIX 時刻。
  return { usedPercent: used, resetsAt: resets === null ? null : resets * 1000 };
}

/** current_usage はトークン数のオブジェクトか、数値か、null。 */
function contextUsed(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (!isRec(v)) return null;
  return (num(v.input_tokens) ?? 0) + (num(v.cache_creation_input_tokens) ?? 0) + (num(v.cache_read_input_tokens) ?? 0);
}

export function parseStatusline(raw: unknown): StatuslinePayload | null {
  if (!isRec(raw)) return null;
  const model = isRec(raw.model) ? str(raw.model.id) ?? str(raw.model.display_name) : str(raw.model);
  const cw = isRec(raw.context_window) ? raw.context_window : null;
  const cost = isRec(raw.cost) ? num(raw.cost.total_cost_usd) : null;
  const rl = isRec(raw.rate_limits) ? raw.rate_limits : null;
  const rateLimits = rl ? { fiveHour: window_(rl.five_hour), sevenDay: window_(rl.seven_day) } : null;
  return {
    providerSessionId: str(raw.session_id), model, effort: str(raw.effort),
    contextUsed: cw ? contextUsed(cw.current_usage) : null, contextSize: cw ? num(cw.context_window_size) : null, costUsd: cost,
    rateLimits: rateLimits && (rateLimits.fiveHour || rateLimits.sevenDay) ? rateLimits : null,
  };
}

const sameWindow = (a: RateWindowDto | null, b: RateWindowDto | null) => a?.usedPercent === b?.usedPercent && a?.resetsAt === b?.resetsAt;

/**
 * 使用率の現在値を持ち、payload を積む。
 * 使用率は Claude のセッションが動いている間だけ届くので、値が無い payload では直前の値を保つ。
 */
export class UsageTracker {
  private state: UsageDto = { fiveHour: null, sevenDay: null, updatedAt: null };
  private lastAt = 0;
  private readonly now: () => number;
  private readonly keep: number;

  constructor(private readonly db: Db, opts: { now?: () => number; keep?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.keep = opts.keep ?? 500;
    this.restore();
  }

  current(): UsageDto { return this.state; }

  /** 新しい順に読み、両方の窓が埋まるか行が尽きるまで辿る。 */
  private restore(): void {
    const rows = this.db.prepare('select at, payload from usage_snapshots order by at desc limit ?').all(this.keep) as { at: number; payload: string }[];
    for (const r of rows) {
      let p: StatuslinePayload | null = null;
      try { p = parseStatusline(JSON.parse(r.payload)); } catch { continue; }
      if (!p?.rateLimits) continue;
      if (this.state.fiveHour === null && p.rateLimits.fiveHour) this.state = { ...this.state, fiveHour: p.rateLimits.fiveHour, updatedAt: this.state.updatedAt ?? r.at };
      if (this.state.sevenDay === null && p.rateLimits.sevenDay) this.state = { ...this.state, sevenDay: p.rateLimits.sevenDay, updatedAt: this.state.updatedAt ?? r.at };
      if (this.state.fiveHour && this.state.sevenDay) break;
    }
  }

  ingest(raw: unknown): { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null } | null {
    const p = parseStatusline(raw);
    if (!p) return null;
    const at = Math.max(this.now(), this.lastAt + 1);
    this.lastAt = at;
    const write = this.db.transaction(() => {
      this.db.prepare('insert into usage_snapshots (at, payload) values (?, ?)').run(at, JSON.stringify(raw));
      this.db.prepare('delete from usage_snapshots where at not in (select at from usage_snapshots order by at desc limit ?)').run(this.keep);
      if (p.providerSessionId) {
        // null の項目は既存の値を保つ（1 回目の payload は current_usage が null）。
        this.db.prepare(`insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)
          on conflict(provider_session_id) do update set
            model = coalesce(excluded.model, session_live_stats.model), effort = coalesce(excluded.effort, session_live_stats.effort),
            context_used = coalesce(excluded.context_used, session_live_stats.context_used), context_size = coalesce(excluded.context_size, session_live_stats.context_size),
            cost_usd = coalesce(excluded.cost_usd, session_live_stats.cost_usd), updated_at = excluded.updated_at`)
          .run(p.providerSessionId, p.model, p.effort, p.contextUsed, p.contextSize, p.costUsd, at);
      }
    });
    write();
    let usageChanged = false;
    if (p.rateLimits) {
      const next: UsageDto = { fiveHour: p.rateLimits.fiveHour ?? this.state.fiveHour, sevenDay: p.rateLimits.sevenDay ?? this.state.sevenDay, updatedAt: at };
      usageChanged = !sameWindow(next.fiveHour, this.state.fiveHour) || !sameWindow(next.sevenDay, this.state.sevenDay) || this.state.updatedAt === null;
      this.state = next;
    }
    return { usage: this.state, usageChanged, providerSessionId: p.providerSessionId };
  }
}
```

`usageChanged` は窓の値が変わったか初回のときだけ真にする。
同じ値でも `updatedAt` は進めるので、UI の「最終更新」は `bootstrap` と次の変化のときに追いつく（毎ターンの配信で UI を揺らさないための妥協で、Task 16 の経路は `usageChanged` のときだけ `usage.update` を配る）。

- [ ] **Step 4: テスト**

Run: `npx vitest run packages/server/src/usage`
Expected: PASS（4 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/usage
git commit -m "feat(server): usage tracker that ingests statusline payloads and keeps per-session live stats"
```

---

### Task 4: jsonl の使用量の集計（日別とプロジェクト別）

**Files:**
- Create: `packages/server/src/usage/aggregate.ts`
- Modify: `packages/server/src/indexer/indexFile.ts`
- Test: `packages/server/src/usage/aggregate.test.ts`、`packages/server/src/indexer/indexFile.test.ts`（追加）

**Interfaces:**
- Consumes: `recordFacts` の `ts` と `usage`（`normalize.ts`）、`usage_daily`、`session_stats`、`session_live_stats`（Task 2）。
- Produces: `aggregateUsage(db, { days, now? }): UsageAggregateDto`。`indexFile` が `usage_daily` を埋める。
- `day` はイベントの `timestamp` をローカル時刻で `YYYY-MM-DD` にしたもの。作り直し（`reset`）のときはそのセッションの行を消してから入れる。サブエージェントのファイルも同じセッションに積む。
- `aggregateUsage` の `days` は今日を含む直近 N 日で、値の無い日は含めない。`projects` は `sessions.project_id` で束ね、null は「未分類」。`costUsd` は `session_live_stats.cost_usd` の和で、1 件も無ければ null。並びはトークンの多い順。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/indexer/indexFile.test.ts` に足す。

```ts
  it('usage_daily に日別のトークンを積み、作り直しで二重にしない', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    const rows = () => db.prepare('select day, input_tokens i, output_tokens o from usage_daily where session_id = ? order by day').all(r.sessionId) as { day: string; i: number; o: number }[];
    // フィクスチャの記録はすべて 2026-09-01 の UTC 10 時台なので、ローカル時刻でも 1 日に収まる。
    const day = localDay(Date.parse('2026-09-01T10:00:05.000Z'));
    expect(rows()).toEqual([{ day, i: 1110, o: 140 }]);
    indexFile(db, alphaSub(), { deviceId: DEV });
    expect(rows()[0]!.i).toBeGreaterThan(1110);
    db.prepare('update transcript_files set indexer_version = 0').run();
    indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaSub(), { deviceId: DEV });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.o).toBe(140 + 3);
  });
```

テストの先頭に `import { localDay } from '../usage/aggregate.ts';` を足す。
`alphaSub` のフィクスチャは assistant 1 件で `usage` が `{ input_tokens: 5, output_tokens: 3 }` である（`packages/server/test/fixtures/claude/projects/-Users-me-workspace-alpha/aaaaaaaa-0000-4000-8000-000000000001/subagents/agent-abc123.jsonl` を `grep output_tokens` で確かめ、違えば期待値を合わせる）。

`packages/server/src/usage/aggregate.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { aggregateUsage, localDay } from './aggregate.ts';

describe('aggregateUsage', () => {
  it('日別とプロジェクト別に束ね、コストは statusline の値だけを足す', () => {
    const db = openDb(':memory:');
    const now = Date.parse('2026-09-17T12:00:00');
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 'u2', cwd: '/y', home_device: 'd', project_id: null }, 'd');
    db.prepare('insert into session_stats (session_id, input_tokens, output_tokens) values (?,?,?)').run('s1', 1000, 100);
    db.prepare('insert into session_stats (session_id, input_tokens, output_tokens) values (?,?,?)').run('s2', 50, 5);
    db.prepare('insert into usage_daily values (?,?,?,?)').run('s1', localDay(now), 600, 60);
    db.prepare('insert into usage_daily values (?,?,?,?)').run('s1', localDay(now - 86_400_000), 400, 40);
    db.prepare('insert into usage_daily values (?,?,?,?)').run('s2', localDay(now), 50, 5);
    db.prepare('insert into usage_daily values (?,?,?,?)').run('s2', localDay(now - 40 * 86_400_000), 9, 9);
    db.prepare('insert into session_live_stats (provider_session_id, cost_usd, updated_at) values (?,?,?)').run('u1', 0.25, 1);
    const r = aggregateUsage(db, { days: 30, now });
    expect(r.days).toEqual([
      { day: localDay(now), inputTokens: 650, outputTokens: 65, sessions: 2 },
      { day: localDay(now - 86_400_000), inputTokens: 400, outputTokens: 40, sessions: 1 },
    ]);
    expect(r.projects).toEqual([
      { projectId: 'p1', name: 'alpha', inputTokens: 1000, outputTokens: 100, costUsd: 0.25, sessions: 1 },
      { projectId: null, name: '未分類', inputTokens: 50, outputTokens: 5, costUsd: null, sessions: 1 },
    ]);
  });
  it('localDay はローカル時刻の日付', () => {
    const d = new Date(2026, 8, 17, 23, 59);
    expect(localDay(d.getTime())).toBe('2026-09-17');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/usage/aggregate packages/server/src/indexer/indexFile`
Expected: FAIL

- [ ] **Step 3: 集計を書く**

`packages/server/src/usage/aggregate.ts`：

```ts
import type { UsageAggregateDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** ミリ秒の時刻をローカル時刻の YYYY-MM-DD にする。 */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** jsonl の usage から導いたトークン数を、日別とプロジェクト別に束ねる。副情報なので推定コストは statusline の値の和だけを出す。 */
export function aggregateUsage(db: Db, opts: { days: number; now?: number }): UsageAggregateDto {
  const now = opts.now ?? Date.now();
  const since = localDay(now - (opts.days - 1) * 86_400_000);
  const days = (db.prepare('select day, sum(input_tokens) i, sum(output_tokens) o, count(distinct session_id) n from usage_daily where day >= ? group by day order by day desc').all(since) as { day: string; i: number; o: number; n: number }[])
    .map((r) => ({ day: r.day, inputTokens: r.i, outputTokens: r.o, sessions: r.n }));
  const projects = (db.prepare(`
    select s.project_id pid, p.name name, sum(st.input_tokens) i, sum(st.output_tokens) o, count(*) n,
      sum(ls.cost_usd) cost, count(ls.cost_usd) cost_n
    from sessions s
    join session_stats st on st.session_id = s.id
    left join projects p on p.id = s.project_id
    left join session_live_stats ls on ls.provider_session_id = s.provider_session_id
    where s.deleted_at is null
    group by s.project_id
    order by i desc`).all() as { pid: string | null; name: string | null; i: number; o: number; n: number; cost: number | null; cost_n: number }[])
    .map((r) => ({ projectId: r.pid, name: r.name ?? '未分類', inputTokens: r.i, outputTokens: r.o, costUsd: r.cost_n > 0 ? r.cost : null, sessions: r.n }));
  return { days, projects };
}
```

- [ ] **Step 4: 索引化で usage_daily を埋める**

`packages/server/src/indexer/indexFile.ts` の `Acc` に `daily: Map<string, { input: number; output: number }>` を足し、`import { localDay } from '../usage/aggregate.ts';` を足す。
`const acc: Acc = { userTurns: 0, input: 0, output: 0 };` を `const acc: Acc = { userTurns: 0, input: 0, output: 0, daily: new Map() };` にする。
`if (f.usage) { acc.input += f.usage.input; acc.output += f.usage.output; }` を次に置き換える。

```ts
      if (f.usage) {
        acc.input += f.usage.input; acc.output += f.usage.output;
        const day = localDay(f.ts ?? Date.now());
        const cur = acc.daily.get(day) ?? { input: 0, output: 0 };
        acc.daily.set(day, { input: cur.input + f.usage.input, output: cur.output + f.usage.output });
      }
```

`run` のトランザクションの中で、`if (reset) { ... }` の直後に足す。

```ts
    // 主線の作り直しでは日別の集計も消す。サブエージェントのぶんは主線の次の走査で積み直される。
    if (reset && file.agentId === null) db.prepare('delete from usage_daily where session_id = ?').run(sessionId);
```

`if (file.agentId === null) applySessionFacts(...)` の直前に足す。

```ts
    const upDaily = db.prepare('insert into usage_daily (session_id, day, input_tokens, output_tokens) values (?,?,?,?) on conflict(session_id, day) do update set input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens');
    for (const [day, v] of acc.daily) upDaily.run(sessionId, day, v.input, v.output);
```

サブエージェントのファイルの作り直しでは、そのファイルの分だけを消す手段が無い（表はセッション単位）。
主線とサブエージェントは同じ `indexer_version` で一緒に作り直されるので、主線の `reset` で表を消し、その走査の中でサブエージェントも積み直される。
テストの「作り直しで二重にしない」はこの順序（主線を先に）で確かめている。

- [ ] **Step 5: テスト**

Run: `npx vitest run packages/server/src/usage packages/server/src/indexer`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/usage packages/server/src/indexer
git commit -m "feat(server): daily token usage from the indexer and per-day, per-project aggregation"
```

---

### Task 5: statusline スクリプトへの追記（`hangar setup` の手順 4 と `hangar statusline install`）

**Files:**
- Create: `packages/server/src/config/statusline.ts`、`packages/cli/src/statusline.ts`
- Modify: `packages/server/src/index.ts`、`packages/cli/src/setup.ts`、`packages/cli/src/index.ts`
- Test: `packages/server/src/config/statusline.test.ts`、`packages/cli/src/statusline.test.ts`、`packages/cli/src/setup.test.ts`（追加）

**Interfaces:**
- Produces: 「インターフェース一覧」の `config/statusline.ts` と `cli/statusline.ts` の関数。`@agent-hangar/server` の `index.ts` から `statuslineStatus`、`resolveStatuslineScript`、`appendStatuslineSnippet`、`statuslineSnippet`、`STATUSLINE_MARKER`、`defaultClaudeDir` を再エクスポートする。
- `runSetup` の `SetupReport` に `statusline: StatuslineStatusDto` を足し、`formatSetupReport` が「statusline: 追記済み」か「statusline: 未追記（hangar statusline install で追記できます）」か「statusline: スクリプトが見つかりません」を出す。追記そのものは `runSetup` では行わず、`hangar setup` のコマンドが報告の後に `runStatuslineInstall` を呼ぶ（`--yes` で問いを省く）。
- スニペットは設計文書の 7 行そのままで、URL のポートだけを引数にする。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/config/statusline.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendStatuslineSnippet, resolveStatuslineScript, STATUSLINE_MARKER, statuslineSnippet, statuslineStatus } from './statusline.ts';

let dir: string;
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-sl-home-')); dir = path.join(home, '.claude'); fs.mkdirSync(dir); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
const settings = (command: unknown) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command } }));

describe('statuslineSnippet', () => {
  it('目印の行で始まり、ポートを埋める', () => {
    const s = statuslineSnippet(4177);
    expect(s.split('\n')[0]).toBe(STATUSLINE_MARKER);
    expect(s).toContain('http://127.0.0.1:4177/api/ingest/statusline');
    expect(s).toContain('exec <<<"$__hangar_input"');
    expect(s.endsWith('\n')).toBe(true);
  });
});

describe('resolveStatuslineScript', () => {
  it('command の先頭の語をファイルとして解決する', () => {
    fs.writeFileSync(path.join(dir, 'statusline-command.sh'), '#!/usr/bin/env bash\necho hi\n');
    settings('~/.claude/statusline-command.sh');
    expect(resolveStatuslineScript(dir, home)).toEqual({ command: '~/.claude/statusline-command.sh', scriptPath: path.join(dir, 'statusline-command.sh') });
    settings(`bash ${dir}/statusline-command.sh --compact`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(path.join(dir, 'statusline-command.sh'));
    settings('npx ccstatusline@latest');
    expect(resolveStatuslineScript(dir, home)).toEqual({ command: 'npx ccstatusline@latest', scriptPath: null });
    settings(undefined);
    expect(resolveStatuslineScript(dir, home)).toEqual({ command: null, scriptPath: null });
    fs.rmSync(path.join(dir, 'settings.json'));
    expect(resolveStatuslineScript(dir, home)).toEqual({ command: null, scriptPath: null });
  });
});

describe('appendStatuslineSnippet', () => {
  it('shebang の直後に入れ、バックアップを取り、二重に入れない', () => {
    const file = path.join(dir, 's.sh');
    fs.writeFileSync(file, '#!/usr/bin/env bash\necho hi\n');
    const r = appendStatuslineSnippet(file, 4177, new Date(2026, 8, 17, 12, 34, 56));
    expect(r.changed).toBe(true);
    expect(r.backup).toBe(path.join(dir, 's.sh.bak-20260917123456'));
    expect(fs.readFileSync(r.backup!, 'utf8')).toBe('#!/usr/bin/env bash\necho hi\n');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env bash');
    expect(lines[1]).toBe(STATUSLINE_MARKER);
    expect(lines.at(-2)).toBe('echo hi');
    expect(appendStatuslineSnippet(file, 4177)).toEqual({ changed: false, backup: null });
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toHaveLength(1);
    settings(file);
    expect(statuslineStatus(dir, home)).toEqual({ command: file, scriptPath: file, installed: true });
  });
  it('shebang が無ければ先頭に入れる', () => {
    const file = path.join(dir, 't.sh');
    fs.writeFileSync(file, 'echo hi\n');
    appendStatuslineSnippet(file, 4199);
    expect(fs.readFileSync(file, 'utf8').startsWith(STATUSLINE_MARKER)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain(':4199/');
  });
});
```

`packages/cli/src/statusline.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATUSLINE_MARKER } from '@agent-hangar/server';
import { runStatuslineInstall } from './statusline.ts';

function claudeDir(command: string | null, script = '#!/bin/bash\necho x\n') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-sl-'));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const file = path.join(dir, 'sl.sh'); fs.writeFileSync(file, script);
  if (command) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: command.replace('<file>', file) } }));
  return { home, dir, file };
}

describe('runStatuslineInstall', () => {
  it('承諾すれば追記し、断れば触らない', async () => {
    const a = claudeDir('<file>');
    const log: string[] = [];
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: false, ask: async () => true, log: (s) => log.push(s) });
    expect(r.installed).toBe(true);
    expect(fs.readFileSync(a.file, 'utf8')).toContain(STATUSLINE_MARKER);
    expect(log.join('\n')).toContain('バックアップ');
    const b = claudeDir('<file>');
    const r2 = await runStatuslineInstall({ claudeDir: b.dir, port: 4177, yes: false, ask: async () => false, log: () => {} });
    expect(r2.installed).toBe(false);
    expect(fs.readFileSync(b.file, 'utf8')).not.toContain(STATUSLINE_MARKER);
    fs.rmSync(a.home, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true });
  });
  it('--yes は問わずに追記し、追記済みなら何もしない', async () => {
    const a = claudeDir('<file>');
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: true, ask: async () => { throw new Error('asked'); }, log: () => {} });
    expect(r.installed).toBe(true);
    const r2 = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: true, log: () => {} });
    expect(r2).toEqual({ installed: true, message: '既に追記されています' });
    fs.rmSync(a.home, { recursive: true, force: true });
  });
  it('スクリプトが見つからなければ手順を印字して終わる', async () => {
    const a = claudeDir('npx something');
    const log: string[] = [];
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: true, log: (s) => log.push(s) });
    expect(r.installed).toBe(false);
    expect(log.join('\n')).toContain(STATUSLINE_MARKER);
    expect(log.join('\n')).toContain('npx something');
    fs.rmSync(a.home, { recursive: true, force: true });
  });
});
```

`packages/cli/src/setup.test.ts` の既存の `it` の末尾（`fs.rmSync` の前）に足す。

```ts
    expect(r.statusline).toEqual({ command: null, scriptPath: null, installed: false });
    expect(text).toContain('statusline: スクリプトが見つかりません');
```

`runSetup` の呼び出しに `claudeDir: path.join(home, 'claude-empty')` を足す（存在しないディレクトリでよい）。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/config/statusline packages/cli`
Expected: FAIL

- [ ] **Step 3: サーバ側の関数を書く**

`packages/server/src/config/statusline.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StatuslineStatusDto } from '@agent-hangar/shared';

// statusline スクリプトへの追記は、hangar が ~/.claude 配下に書く唯一の操作である。
// ここでは読み取りと、承諾を得た後に呼ばれる追記だけを提供し、問いかけは CLI が担う。

export const STATUSLINE_MARKER = '# agent-hangar: 使用量をローカルサーバへ渡す。失敗は無視する。';

/** 設計文書のスニペット。標準入力を読んでサーバへ背景で送り、同じ内容を元のスクリプトの標準入力に戻す。 */
export function statuslineSnippet(port: number): string {
  return [
    STATUSLINE_MARKER,
    '__hangar_input=$(cat)',
    `printf '%s' "$__hangar_input" | curl -s -m 0.3 -X POST \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H "Authorization: Bearer $(cat "$HOME/.agent-hangar/token" 2>/dev/null)" \\`,
    `  --data-binary @- http://127.0.0.1:${port}/api/ingest/statusline >/dev/null 2>&1 &`,
    'exec <<<"$__hangar_input"',
    '',
  ].join('\n');
}

const expandHome = (p: string, homeDir: string) => (p === '~' ? homeDir : p.startsWith('~/') ? path.join(homeDir, p.slice(2)) : p);

/** ~/.claude/settings.json の statusLine.command を読み、先頭の語がファイルならその絶対パスを返す。 */
export function resolveStatuslineScript(claudeDir: string, homeDir: string = os.homedir()): { command: string | null; scriptPath: string | null } {
  const file = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(file)) return { command: null, scriptPath: null };
  let command: string | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { statusLine?: { command?: unknown } };
    command = typeof j.statusLine?.command === 'string' && j.statusLine.command.trim() ? j.statusLine.command.trim() : null;
  } catch { return { command: null, scriptPath: null }; }
  if (!command) return { command: null, scriptPath: null };
  const words = command.split(/\s+/);
  const first = ['bash', 'sh', 'zsh'].includes(words[0] ?? '') ? words[1] : words[0];
  if (!first) return { command, scriptPath: null };
  const candidate = path.resolve(expandHome(first, homeDir));
  const ok = fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  return { command, scriptPath: ok ? candidate : null };
}

export function statuslineStatus(claudeDir: string, homeDir: string = os.homedir()): StatuslineStatusDto {
  const r = resolveStatuslineScript(claudeDir, homeDir);
  const installed = r.scriptPath !== null && fs.readFileSync(r.scriptPath, 'utf8').includes(STATUSLINE_MARKER);
  return { command: r.command, scriptPath: r.scriptPath, installed };
}

const stamp = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

/** バックアップを取ってから、shebang の直後（無ければ先頭）にスニペットを入れる。目印があれば何もしない。 */
export function appendStatuslineSnippet(scriptPath: string, port: number, now: Date = new Date()): { changed: boolean; backup: string | null } {
  const src = fs.readFileSync(scriptPath, 'utf8');
  if (src.includes(STATUSLINE_MARKER)) return { changed: false, backup: null };
  const backup = `${scriptPath}.bak-${stamp(now)}`;
  fs.copyFileSync(scriptPath, backup);
  const nl = src.indexOf('\n');
  const hasShebang = src.startsWith('#!');
  const head = hasShebang ? src.slice(0, nl + 1) : '';
  const rest = hasShebang ? src.slice(nl + 1) : src;
  const mode = fs.statSync(scriptPath).mode;
  fs.writeFileSync(scriptPath, head + statuslineSnippet(port) + rest, { mode });
  return { changed: true, backup };
}
```

`packages/server/src/index.ts` に足す。

```ts
export { STATUSLINE_MARKER, appendStatuslineSnippet, resolveStatuslineScript, statuslineSnippet, statuslineStatus } from './config/statusline.ts';
export { defaultClaudeDir } from './config/paths.ts';
```

- [ ] **Step 4: CLI 側を書く**

`packages/cli/src/statusline.ts`：

```ts
import readline from 'node:readline';
import { appendStatuslineSnippet, resolveStatuslineScript, STATUSLINE_MARKER, statuslineSnippet } from '@agent-hangar/server';
import fs from 'node:fs';

export type Ask = (question: string) => Promise<boolean>;

/** 端末で y か n を聞く。y と yes だけを承諾とみなす。 */
export function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(`${question} [y/N] `, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); }));
}

/**
 * statusline スクリプトへスニペットを追記する。
 * 追記先が見つからなければ手順を印字して終わり、見つかれば承諾を得てからバックアップと追記を行う。
 */
export async function runStatuslineInstall(o: { claudeDir: string; port: number; yes: boolean; ask?: Ask; log?: (s: string) => void }): Promise<{ installed: boolean; message: string }> {
  const log = o.log ?? ((s: string) => console.log(s));
  const ask = o.ask ?? promptYesNo;
  const r = resolveStatuslineScript(o.claudeDir);
  if (!r.scriptPath) {
    log(r.command ? `statusLine.command は「${r.command}」で、ファイルとして見つからないため自動では追記しません。` : 'settings.json に statusLine.command がありません。');
    log('使用量をヘッダーに出すには、statusline スクリプトの先頭（shebang の直後）に次を入れてください。');
    log('');
    log(statuslineSnippet(o.port));
    return { installed: false, message: 'スクリプトが見つかりません' };
  }
  if (fs.readFileSync(r.scriptPath, 'utf8').includes(STATUSLINE_MARKER)) return { installed: true, message: '既に追記されています' };
  log(`追記先: ${r.scriptPath}`);
  log('追記する内容:');
  log(statuslineSnippet(o.port));
  if (!o.yes && !(await ask('この内容を追記しますか？追記前にバックアップを取ります。'))) return { installed: false, message: '追記しませんでした' };
  const done = appendStatuslineSnippet(r.scriptPath, o.port);
  if (done.backup) log(`バックアップ: ${done.backup}`);
  log('追記しました。次に Claude Code を起動すると、使用量がヘッダーに出ます。');
  return { installed: true, message: '追記しました' };
}
```

`packages/cli/src/setup.ts` を次に置き換える。

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StatuslineStatusDto } from '@agent-hangar/shared';
import { defaultClaudeDir, ensureHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings, statuslineStatus } from '@agent-hangar/server';

export type SetupReport = {
  home: string;
  deviceId: string;
  tools: { name: string; found: boolean; path: string | null }[];
  workspaceRoot: string;
  workspaceExists: boolean;
  statusline: StatuslineStatusDto;
};

export function whichCmd(cmd: string): string | null {
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * データディレクトリ、トークン、端末 ID を用意し、ツールとワークスペースと statusline の状態を報告する。
 * 書き込みは home 配下に限る。statusline への追記は runStatuslineInstall が別に行う。
 */
export function runSetup(opts: { home: string; workspaceRoot?: string; claudeDir?: string; which?: (cmd: string) => string | null }): SetupReport {
  const which = opts.which ?? whichCmd;
  ensureHome(opts.home);
  readOrCreateToken(opts.home);
  const device = readOrCreateDevice(opts.home);
  const settings = loadSettings(opts.home);
  if (opts.workspaceRoot) settings.workspaceRoot = path.resolve(opts.workspaceRoot.replace(/^~(?=$|\/)/, os.homedir()));
  saveSettings(opts.home, settings);
  const tools = ['tmux', 'claude', 'code'].map((name) => { const p = which(name); return { name, found: p !== null, path: p }; });
  return {
    home: opts.home, deviceId: device.id, tools, workspaceRoot: settings.workspaceRoot, workspaceExists: fs.existsSync(settings.workspaceRoot),
    statusline: statuslineStatus(opts.claudeDir ?? settings.claudeDir ?? defaultClaudeDir()),
  };
}

export function formatSetupReport(r: SetupReport): string {
  const lines = [`データディレクトリ: ${r.home}`, `端末 ID: ${r.deviceId}`];
  for (const t of r.tools) lines.push(`${t.name}: ${t.found ? t.path : '見つかりません'}`);
  lines.push(`ワークスペース: ${r.workspaceRoot}${r.workspaceExists ? '' : '（存在しません。hangar setup --workspace <dir> で変えられます）'}`);
  lines.push(r.statusline.installed ? 'statusline: 追記済み' : r.statusline.scriptPath ? 'statusline: 未追記（hangar statusline install で追記できます）' : 'statusline: スクリプトが見つかりません');
  lines.push('プロジェクトの自動登録は hangar start の起動時に行います。');
  return lines.join('\n');
}
```

`packages/cli/src/index.ts` の `setup` コマンドを置き換え、`statusline` コマンドを足す。

```ts
import { defaultClaudeDir, hangarHome, loadSettings, startServer } from '@agent-hangar/server';
import { formatSetupReport, runSetup } from './setup.ts';
import { runStatuslineInstall } from './statusline.ts';

program
  .command('setup')
  .description('データディレクトリを用意し、ツールとワークスペースを確認し、statusline への追記を提案する')
  .option('--workspace <dir>', 'ワークスペースのルート')
  .option('--yes', '問いかけをすべて承諾する')
  .option('--skip-statusline', 'statusline への追記を提案しない')
  .action(async (o: { workspace?: string; yes?: boolean; skipStatusline?: boolean }) => {
    const home = hangarHome();
    const r = runSetup({ home, workspaceRoot: o.workspace });
    console.log(formatSetupReport(r));
    if (!o.skipStatusline && !r.statusline.installed) {
      console.log('');
      const claudeDir = loadSettings(home).claudeDir || defaultClaudeDir();
      await runStatuslineInstall({ claudeDir, port: 4177, yes: o.yes ?? false });
    }
    console.log('');
    console.log('MCP の登録は hangar mcp install で行えます。');
  });

const statusline = program.command('statusline').description('statusline スクリプトへの追記');
statusline
  .command('install')
  .description('使用量をサーバへ渡すスニペットを statusline スクリプトに追記する（承諾を求め、バックアップを取る）')
  .option('--port <n>', 'ポート', '4177')
  .option('--yes', '問わずに追記する')
  .action(async (o: { port: string; yes?: boolean }) => {
    const claudeDir = loadSettings(hangarHome()).claudeDir || defaultClaudeDir();
    const r = await runStatuslineInstall({ claudeDir, port: Number(o.port), yes: o.yes ?? false });
    if (!r.installed) process.exitCode = 1;
  });
```

`hangar mcp install` のコマンド（フェーズ 2）はそのまま残す。
`packages/cli/package.json` の `dependencies` に `"@agent-hangar/shared": "*"` を足す（`StatuslineStatusDto` の型を使うため）。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/config packages/cli && npx tsc -p packages/cli --noEmit`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/config packages/server/src/index.ts packages/cli
git commit -m "feat(cli): statusline snippet append with confirmation and backup, setup step 4"
```

---

### Task 6: アーティファクトの抽出（索引化の途中で拾う）

**Files:**
- Create: `packages/server/src/artifacts/extract.ts`
- Modify: `packages/server/src/indexer/indexFile.ts`、`packages/server/src/indexer/service.ts`
- Test: `packages/server/src/artifacts/extract.test.ts`、`packages/server/src/indexer/indexFile.test.ts`（追加）

**Interfaces:**
- Consumes: `normalizeRecord` の `tool_call`（`name`、`input`、`toolId`）と `tool_result`（`toolId`、`text`）、`artifact_calls`、`artifacts`、`artifact_versions`、`upsertShared`、`newId`。
- Produces: 「インターフェース一覧」の `artifacts/extract.ts` の関数。`IndexFileResult` に `artifactIds: string[]`。`IndexerListener.sessionChanged` の引数に `artifactIds: string[]`。
- `indexFile` は各イベントについて、`tool_call` で `name === 'Artifact'` なら `artifact_calls` に書き、`tool_result` で本文から URL が取れて `artifact_calls` に同じ `toolId` があれば `recordArtifactPublish` を呼ぶ。`publishedAt` はイベントの `ts`（無ければ今）。作り直し（`reset`）のときはそのセッションの `artifact_versions` を先に消す（`artifacts` の行は残す）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/artifacts/extract.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { artifactCallOf, parsePublishedUrl, recordArtifactPublish, resolveArtifactTitle } from './extract.ts';

describe('parsePublishedUrl', () => {
  it('新旧の URL を拾い、無ければ null', () => {
    expect(parsePublishedUrl('Published /tmp/a.html at https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001\nWatching: yes')).toBe('https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001');
    expect(parsePublishedUrl('Done. https://claude.ai/artifact/abc123XYZ.')).toBe('https://claude.ai/artifact/abc123XYZ');
    expect(parsePublishedUrl('Read 3 files')).toBeNull();
  });
});

describe('artifactCallOf', () => {
  it('file_path、description、favicon を取り出す', () => {
    expect(artifactCallOf({ file_path: '/tmp/a.html', description: '説明', favicon: '📊' })).toEqual({ filePath: '/tmp/a.html', description: '説明', favicon: '📊' });
    expect(artifactCallOf({ action: 'read', url: 'x' })).toEqual({ filePath: null, description: null, favicon: null });
    expect(artifactCallOf('nope')).toEqual({ filePath: null, description: null, favicon: null });
  });
});

describe('resolveArtifactTitle', () => {
  it('ファイルがあれば title、無ければ説明の先頭 60 字', () => {
    const read = (p: string) => (p === '/tmp/a.html' ? '<!doctype html><html><head><meta charset="utf-8"><title> 週報 &amp; 集計 </title></head>' : null);
    expect(resolveArtifactTitle('/tmp/a.html', '説明', read)).toBe('週報 & 集計');
    expect(resolveArtifactTitle('/tmp/none.html', 'あ'.repeat(70), read)).toBe('あ'.repeat(60));
    expect(resolveArtifactTitle(null, null, read)).toBeNull();
    expect(resolveArtifactTitle('/tmp/a.html', null, () => '<html><body>no title</body></html>')).toBeNull();
  });
});

describe('recordArtifactPublish', () => {
  it('同じ URL は 1 件にまとめ、版を積み、同じ版は二重にしない', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 'u2', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
    const url = 'https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001';
    const call = { filePath: '/tmp/none.html', description: '週報のダッシュボード', favicon: '📊' };
    const a = recordArtifactPublish(db, 'd', { sessionId: 's1', projectId: 'p1', url, publishedAt: 100, call });
    const b = recordArtifactPublish(db, 'd', { sessionId: 's2', projectId: 'p2', url, publishedAt: 200, call: { ...call, description: '更新した説明' } });
    expect(b).toBe(a);
    const row = db.prepare('select * from artifacts where id = ?').get(a) as Record<string, unknown>;
    // 元ファイルが無いので題名は説明の先頭で、新しい公開の説明が勝つ。
    expect(row).toMatchObject({ url, project_id: 'p2', title: '更新した説明', description: '更新した説明', favicon: '📊', first_published_at: 100, last_published_at: 200 });
    expect((db.prepare('select count(*) c from artifact_versions where artifact_id = ?').get(a) as { c: number }).c).toBe(2);
    recordArtifactPublish(db, 'd', { sessionId: 's1', projectId: 'p1', url, publishedAt: 100, call });
    expect((db.prepare('select count(*) c from artifact_versions where artifact_id = ?').get(a) as { c: number }).c).toBe(2);
    // 古い公開が後から索引化されても first は最小、last は最大を保つ。
    recordArtifactPublish(db, 'd', { sessionId: 's1', projectId: 'p1', url, publishedAt: 50, call });
    expect(db.prepare('select first_published_at f, last_published_at l from artifacts where id = ?').get(a)).toEqual({ f: 50, l: 200 });
  });
});
```

`packages/server/src/indexer/indexFile.test.ts` に足す。

```ts
  it('Artifact の呼び出しと結果からアーティファクトを作り、追記で結果だけ届いても結びつける', () => {
    const r0 = indexFile(db, alphaMain(), { deviceId: DEV });
    const url = 'https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001';
    const call = { type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 'toolu_art', name: 'Artifact', input: { file_path: '/tmp/none.html', description: '週報', favicon: '📊' } }], usage: { input_tokens: 0, output_tokens: 1 } }, uuid: 'a9', timestamp: '2026-09-01T12:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA };
    fs.appendFileSync(alphaMain().path, JSON.stringify(call) + '\n');
    const r1 = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r1.artifactIds).toEqual([]);
    expect(db.prepare('select * from artifact_calls where tool_id = ?').get('toolu_art')).toMatchObject({ session_id: r0.sessionId, file_path: '/tmp/none.html', description: '週報', favicon: '📊' });
    const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_art', content: `Published /tmp/none.html at ${url}` }] }, uuid: 'u9', timestamp: '2026-09-01T12:00:03.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA };
    fs.appendFileSync(alphaMain().path, JSON.stringify(result) + '\n');
    const r2 = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r2.artifactIds).toHaveLength(1);
    const art = db.prepare('select * from artifacts where id = ?').get(r2.artifactIds[0]) as Record<string, unknown>;
    expect(art).toMatchObject({ url, title: '週報', favicon: '📊', first_published_at: Date.parse('2026-09-01T12:00:03.000Z') });
    expect((db.prepare('select count(*) c from artifact_versions where session_id = ?').get(r0.sessionId) as { c: number }).c).toBe(1);
    // 作り直しても版は増えない。
    db.prepare('update transcript_files set indexer_version = 0').run();
    const r3 = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r3.artifactIds).toHaveLength(1);
    expect((db.prepare('select count(*) c from artifact_versions where session_id = ?').get(r0.sessionId) as { c: number }).c).toBe(1);
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/artifacts packages/server/src/indexer/indexFile`
Expected: FAIL

- [ ] **Step 3: 抽出を書く**

`packages/server/src/artifacts/extract.ts`：

```ts
import fs from 'node:fs';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

// Artifact ツールの呼び出しには元ファイルのパス、説明、favicon が、結果には公開先の URL が残る。
// 呼び出しと結果は別の記録なので、呼び出しを artifact_calls に控えておき、結果が来たときに突き合わせる。

export type ArtifactCall = { filePath: string | null; description: string | null; favicon: string | null };

/** 新形式 https://claude.ai/code/artifact/<uuid> と旧形式 https://claude.ai/artifact/<id>。 */
export const ARTIFACT_URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

export function parsePublishedUrl(text: string): string | null {
  const m = ARTIFACT_URL_RE.exec(text);
  return m ? m[0] : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export function artifactCallOf(input: unknown): ArtifactCall {
  if (typeof input !== 'object' || input === null) return { filePath: null, description: null, favicon: null };
  const i = input as Record<string, unknown>;
  return { filePath: str(i.file_path), description: str(i.description), favicon: str(i.favicon) };
}

const HEAD_BYTES = 64 * 1024;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, k: string) => ENTITIES[k] ?? _);

function readHeadDefault(p: string): string | null {
  try {
    const fd = fs.openSync(p, 'r');
    try { const buf = Buffer.alloc(HEAD_BYTES); const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0); return buf.toString('utf8', 0, n); }
    finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** 元ファイルがあれば HTML の title、無ければ説明の先頭 60 字。どちらも無ければ null。 */
export function resolveArtifactTitle(filePath: string | null, description: string | null, readHead: (p: string) => string | null = readHeadDefault): string | null {
  const html = filePath ? readHead(filePath) : null;
  if (html !== null) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (m) { const t = decode(m[1]!).replace(/\s+/g, ' ').trim(); if (t) return t; }
    return null;
  }
  return description ? [...description].slice(0, 60).join('') : null;
}

type ArtifactRow = { id: string; project_id: string | null; url: string; title: string | null; description: string | null; favicon: string | null; first_published_at: number; last_published_at: number };

/** 同じ URL は 1 件にまとめ、artifact_versions に「いつ、どのセッションが」を積む。同じ版が既にあれば足さない。 */
export function recordArtifactPublish(db: Db, deviceId: string, o: { sessionId: string; projectId: string | null; url: string; publishedAt: number; call: ArtifactCall }): string {
  const cur = db.prepare('select * from artifacts where url = ?').get(o.url) as ArtifactRow | undefined;
  const title = resolveArtifactTitle(o.call.filePath, o.call.description) ?? cur?.title ?? null;
  const id = cur?.id ?? newId();
  const newest = !cur || o.publishedAt >= cur.last_published_at;
  upsertShared(db, 'artifacts', {
    id, url: o.url,
    project_id: newest ? o.projectId : cur!.project_id,
    title: newest ? title : cur!.title,
    description: newest ? o.call.description ?? cur?.description ?? null : cur!.description,
    favicon: newest ? o.call.favicon ?? cur?.favicon ?? null : cur!.favicon,
    first_published_at: Math.min(cur?.first_published_at ?? o.publishedAt, o.publishedAt),
    last_published_at: Math.max(cur?.last_published_at ?? o.publishedAt, o.publishedAt),
    deleted_at: null,
  }, deviceId);
  const dup = db.prepare('select 1 from artifact_versions where artifact_id = ? and session_id = ? and published_at = ? and deleted_at is null').get(id, o.sessionId, o.publishedAt);
  if (!dup) upsertShared(db, 'artifact_versions', { id: newId(), artifact_id: id, session_id: o.sessionId, file_path: o.call.filePath, published_at: o.publishedAt }, deviceId);
  return id;
}
```

- [ ] **Step 4: 索引化に組み込む**

`packages/server/src/indexer/indexFile.ts` に import を足す。

```ts
import { artifactCallOf, parsePublishedUrl, recordArtifactPublish } from '../artifacts/extract.ts';
```

`IndexFileResult` に `artifactIds: string[]` を足し、`changed: false` の早期 return に `artifactIds: []` を足す。
`run` のトランザクションの中、`if (reset) { ... }` の直後（Task 4 の `usage_daily` の削除の隣）に足す。

```ts
    // 主線の作り直しでは、このセッションの版と呼び出しの控えを消してから積み直す。
    // サブエージェントのファイルだけの作り直しで主線の版を消さないよう、主線に限る。
    if (reset && file.agentId === null) {
      db.prepare('delete from artifact_versions where session_id = ? and deleted_at is null').run(sessionId);
      db.prepare('delete from artifact_calls where session_id = ?').run(sessionId);
    }
    const artifactIds = new Set<string>();
    const insCall = db.prepare('insert into artifact_calls (tool_id, session_id, file_path, description, favicon) values (?,?,?,?,?) on conflict(tool_id) do update set file_path = excluded.file_path, description = excluded.description, favicon = excluded.favicon');
    const getCall = db.prepare('select file_path, description, favicon from artifact_calls where tool_id = ? and session_id = ?');
    const projectOf = () => (db.prepare('select project_id from sessions where id = ?').get(sessionId) as { project_id: string | null }).project_id;
```

`for (const ev of events) { ... insEv.run(...) }` のループの中、`insEv.run` の直後に足す。

```ts
        if (ev.kind === 'tool_call' && ev.name === 'Artifact') {
          const c = artifactCallOf(ev.input);
          insCall.run(ev.toolId, sessionId, c.filePath, c.description, c.favicon);
        } else if (ev.kind === 'tool_result') {
          const url = parsePublishedUrl(ev.text);
          const call = url ? (getCall.get(ev.toolId, sessionId) as { file_path: string | null; description: string | null; favicon: string | null } | undefined) : undefined;
          if (url && call) artifactIds.add(recordArtifactPublish(db, opts.deviceId, { sessionId, projectId: projectOf(), url, publishedAt: ev.ts ?? Date.now(), call: { filePath: call.file_path, description: call.description, favicon: call.favicon } }));
        }
```

`artifact_versions` の作り直しの削除は物理削除にしている。
この表は共有テーブルだが、作り直しは「同じ事実を同じ端末が再び導く」操作で、削除マークを積むと同期で消えたり戻ったりする往復が起きる。
`recordArtifactPublish` の重複判定が同じ版を足さないので、削除せずに残す選択もあるが、ファイルが短くなって公開の記録そのものが消えた場合に版が残り続ける。
そこで物理削除にし、`changes` には積まない（フェーズ 4 で同期を実装するとき、この表は「端末が索引から導ける事実」として再導出する方針を採る）。

`run` の最後の `return` の前で `artifactIds` を関数の外へ出す。
`let sessionId = '';` の隣に `let artifactIdsOut: string[] = [];` を置き、トランザクションの末尾で `artifactIdsOut = [...artifactIds];` とし、`return { sessionId, providerSessionId: file.sessionId, appended, changed: true, badLines, artifactIds: artifactIdsOut };` にする。

`packages/server/src/indexer/service.ts` の `IndexerListener.sessionChanged` の引数に `artifactIds: string[]` を足し、`indexOne` の呼び出しを `l.sessionChanged?.({ sessionId: r.sessionId, providerSessionId: file.sessionId, agentId: file.agentId, appended: r.appended, artifactIds: r.artifactIds })` にする。
`server.ts` の `sessionChanged` はまだ `artifactIds` を使わない（Task 16 で配る）。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/artifacts packages/server/src/indexer && npx tsc -p packages/server --noEmit 2>&1 | grep -v 'app.ts'`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/artifacts packages/server/src/indexer
git commit -m "feat(server): extract published artifacts from Artifact tool calls and results during indexing"
```

---

### Task 7: アーティファクトの問い合わせと手動追加

**Files:**
- Create: `packages/server/src/artifacts/queries.ts`
- Test: `packages/server/src/artifacts/queries.test.ts`

**Interfaces:**
- Consumes: `artifacts`、`artifact_versions`、`sessions`、`recordArtifactPublish`（Task 6）、`ARTIFACT_URL_RE`。
- Produces: 「インターフェース一覧」の `listArtifacts`、`getArtifact`、`addManualArtifact`。
- `filePath` は最新の版の `file_path`、`fileExists` はそのファイルが存在するか。`sessionIds` は版を積んだセッションの重複を除いた列（新しい順）。`projectId` で絞るときは `artifacts.project_id` だけでなく、版のセッションが属するプロジェクトも見る。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/artifacts/queries.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { recordArtifactPublish } from './extract.ts';
import { addManualArtifact, getArtifact, listArtifacts } from './queries.ts';

function seed() {
  const db = openDb(':memory:');
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'projects', { id: 'p2', name: 'beta', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
  upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 'u2', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
  upsertShared(db, 'sessions', { id: 's3', provider: 'claude-code', provider_session_id: 'u3', cwd: '/y', home_device: 'd', project_id: 'p2' }, 'd');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-art-'));
  const file = path.join(tmp, 'a.html'); fs.writeFileSync(file, '<title>実在</title>');
  const a = recordArtifactPublish(db, 'd', { sessionId: 's1', projectId: 'p1', url: 'https://claude.ai/code/artifact/a', publishedAt: 100, call: { filePath: '/tmp/gone.html', description: 'A', favicon: '📊' } });
  recordArtifactPublish(db, 'd', { sessionId: 's2', projectId: 'p1', url: 'https://claude.ai/code/artifact/a', publishedAt: 300, call: { filePath: file, description: 'A2', favicon: '📊' } });
  const b = recordArtifactPublish(db, 'd', { sessionId: 's3', projectId: 'p2', url: 'https://claude.ai/artifact/b', publishedAt: 200, call: { filePath: null, description: 'B', favicon: null } });
  return { db, a, b, file, tmp };
}

describe('artifacts/queries', () => {
  it('一覧は新しい順で、版の数とセッションとファイルの有無を持つ', () => {
    const { db, a, b, file, tmp } = seed();
    const all = listArtifacts(db);
    expect(all.map((x) => x.id)).toEqual([a, b]);
    expect(all[0]).toMatchObject({ url: 'https://claude.ai/code/artifact/a', title: '実在', description: 'A2', favicon: '📊', filePath: file, fileExists: true, firstPublishedAt: 100, lastPublishedAt: 300, versionCount: 2, sessionIds: ['s2', 's1'] });
    expect(all[1]).toMatchObject({ id: b, title: 'B', fileExists: false, filePath: null, versionCount: 1 });
    expect(listArtifacts(db, { projectId: 'p1' }).map((x) => x.id)).toEqual([a]);
    expect(listArtifacts(db, { sessionId: 's3' }).map((x) => x.id)).toEqual([b]);
    expect(listArtifacts(db, { ids: [b] }).map((x) => x.id)).toEqual([b]);
    expect(getArtifact(db, 'nope')).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it('セッションが別のプロジェクトへ移っても版から辿れる', () => {
    const { db, a } = seed();
    db.prepare("update sessions set project_id = 'p2' where id in ('s1', 's2')").run();
    expect(listArtifacts(db, { projectId: 'p2' }).map((x) => x.id).sort()).toEqual(listArtifacts(db).map((x) => x.id).sort());
    expect(listArtifacts(db, { projectId: 'p1' }).map((x) => x.id)).toEqual([a]);   // artifacts.project_id はまだ p1
  });
  it('手で URL を追加する。claude.ai 以外は拒む。同じ URL は既存を返す', () => {
    const { db, a } = seed();
    const m = addManualArtifact(db, 'd', 'p1', 'https://claude.ai/code/artifact/manual-1', 500);
    expect(m).toMatchObject({ projectId: 'p1', title: null, versionCount: 0, sessionIds: [], firstPublishedAt: 500, lastPublishedAt: 500 });
    expect(addManualArtifact(db, 'd', 'p2', 'https://claude.ai/code/artifact/a').id).toBe(a);
    expect(() => addManualArtifact(db, 'd', 'p1', 'https://example.com/x')).toThrow(/claude\.ai/);
    expect(() => addManualArtifact(db, 'd', 'p1', 'not a url')).toThrow();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/artifacts/queries`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/artifacts/queries.ts`：

```ts
import fs from 'node:fs';
import { newId, type ArtifactDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ARTIFACT_URL_RE } from './extract.ts';

type Row = { id: string; project_id: string | null; url: string; title: string | null; description: string | null; favicon: string | null; first_published_at: number; last_published_at: number };
type VersionRow = { session_id: string; file_path: string | null; published_at: number };

function toDto(db: Db, r: Row): ArtifactDto {
  const versions = db.prepare('select session_id, file_path, published_at from artifact_versions where artifact_id = ? and deleted_at is null order by published_at desc').all(r.id) as VersionRow[];
  const latestWithFile = versions.find((v) => v.file_path);
  const filePath = latestWithFile?.file_path ?? null;
  const sessionIds = [...new Set(versions.map((v) => v.session_id))];
  return {
    id: r.id, projectId: r.project_id, url: r.url, title: r.title, description: r.description, favicon: r.favicon,
    filePath, fileExists: filePath !== null && fs.existsSync(filePath),
    firstPublishedAt: r.first_published_at, lastPublishedAt: r.last_published_at, versionCount: versions.length, sessionIds,
  };
}

/** 一覧。projectId は artifacts.project_id と、版を積んだセッションのプロジェクトの両方で当てる。 */
export function listArtifacts(db: Db, opts: { projectId?: string; sessionId?: string; ids?: string[] } = {}): ArtifactDto[] {
  const where: string[] = ['a.deleted_at is null'];
  const args: unknown[] = [];
  if (opts.projectId) {
    where.push('(a.project_id = ? or exists (select 1 from artifact_versions v join sessions s on s.id = v.session_id where v.artifact_id = a.id and v.deleted_at is null and s.project_id = ?))');
    args.push(opts.projectId, opts.projectId);
  }
  if (opts.sessionId) { where.push('exists (select 1 from artifact_versions v where v.artifact_id = a.id and v.deleted_at is null and v.session_id = ?)'); args.push(opts.sessionId); }
  if (opts.ids) { if (opts.ids.length === 0) return []; where.push(`a.id in (${opts.ids.map(() => '?').join(',')})`); args.push(...opts.ids); }
  const rows = db.prepare(`select a.* from artifacts a where ${where.join(' and ')} order by a.last_published_at desc, a.id`).all(...args) as Row[];
  return rows.map((r) => toDto(db, r));
}

export function getArtifact(db: Db, id: string): ArtifactDto | null {
  const r = db.prepare('select * from artifacts where id = ? and deleted_at is null').get(id) as Row | undefined;
  return r ? toDto(db, r) : null;
}

/** 利用者が手で足す URL。版は作らない。同じ URL が既にあればそれを返す。 */
export function addManualArtifact(db: Db, deviceId: string, projectId: string, url: string, now: number = Date.now()): ArtifactDto {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('URL の形式が正しくありません'); }
  if (parsed.hostname !== 'claude.ai' || !ARTIFACT_URL_RE.test(url)) throw new Error('claude.ai のアーティファクトの URL を入れてください');
  const clean = ARTIFACT_URL_RE.exec(url)![0];
  const cur = db.prepare('select * from artifacts where url = ?').get(clean) as Row | undefined;
  if (cur) return toDto(db, cur);
  const id = newId();
  upsertShared(db, 'artifacts', { id, project_id: projectId, url: clean, title: null, description: null, favicon: null, first_published_at: now, last_published_at: now, deleted_at: null }, deviceId);
  return getArtifact(db, id)!;
}
```

- [ ] **Step 4: テスト**

Run: `npx vitest run packages/server/src/artifacts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/artifacts
git commit -m "feat(server): artifact list, detail and manual add queries"
```

---

### Task 8: TODO の読み書き

**Files:**
- Create: `packages/server/src/projects/todos.ts`
- Test: `packages/server/src/projects/todos.test.ts`

**Interfaces:**
- Consumes: `todos`、`upsertShared`、`softDeleteShared`、`newId`。
- Produces: 「インターフェース一覧」の `listTodos`、`addTodo`、`setTodoDone`、`removeTodo`。
- `position` はそのプロジェクトの最大値に 1 を足す（論理削除した行も数に入れ、番号を再利用しない）。`text` は前後の空白を落とし、空なら `Error`。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/projects/todos.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { addTodo, listTodos, removeTodo, setTodoDone } from './todos.ts';

function seed() {
  const db = openDb(':memory:');
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'projects', { id: 'p2', name: 'beta', status: 'active', is_scratch: 0 }, 'd');
  return db;
}

describe('todos', () => {
  it('追加は position を伸ばし、一覧は position 順', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: '  最初 ' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: '次', sessionId: 's1' });
    addTodo(db, 'd', { projectId: 'p2', text: '別' });
    expect(a).toMatchObject({ projectId: 'p1', text: '最初', done: false, position: 1, sessionId: null });
    expect(b).toMatchObject({ position: 2, sessionId: 's1' });
    expect(listTodos(db, 'p1').map((t) => t.text)).toEqual(['最初', '次']);
    expect(listTodos(db).map((t) => t.text)).toEqual(['最初', '次', '別']);
    expect(() => addTodo(db, 'd', { projectId: 'p1', text: '   ' })).toThrow();
  });
  it('完了の切り替えと削除。削除した番号は再利用しない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(setTodoDone(db, 'd', a.id, true)).toMatchObject({ id: a.id, done: true });
    expect(setTodoDone(db, 'd', 'nope', true)).toBeNull();
    expect(removeTodo(db, 'd', a.id)).toMatchObject({ id: a.id });
    expect(listTodos(db, 'p1')).toEqual([]);
    expect(removeTodo(db, 'd', a.id)).toBeNull();
    expect(addTodo(db, 'd', { projectId: 'p1', text: 'b' }).position).toBe(2);
    expect((db.prepare("select count(*) c from changes where table_name = 'todos'").get() as { c: number }).c).toBe(4);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/projects/todos`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/projects/todos.ts`：

```ts
import { newId, type TodoDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';

type Row = { id: string; project_id: string; text: string; done: number; position: number; session_id: string | null; updated_at: number };

const toDto = (r: Row): TodoDto => ({ id: r.id, projectId: r.project_id, text: r.text, done: r.done === 1, position: r.position, sessionId: r.session_id, updatedAt: r.updated_at });

export function listTodos(db: Db, projectId?: string): TodoDto[] {
  const rows = projectId
    ? db.prepare('select * from todos where project_id = ? and deleted_at is null order by position, id').all(projectId)
    : db.prepare('select * from todos where deleted_at is null order by project_id, position, id').all();
  return (rows as Row[]).map(toDto);
}

/** 末尾に足す。position は削除した行も含めた最大値の次で、番号を再利用しない。 */
export function addTodo(db: Db, deviceId: string, o: { projectId: string; text: string; sessionId?: string | null }): TodoDto {
  const text = o.text.trim();
  if (!text) throw new Error('TODO の本文が空です');
  const max = (db.prepare('select max(position) m from todos where project_id = ?').get(o.projectId) as { m: number | null }).m ?? 0;
  const id = newId();
  upsertShared(db, 'todos', { id, project_id: o.projectId, text, done: 0, position: max + 1, session_id: o.sessionId ?? null }, deviceId);
  return toDto(db.prepare('select * from todos where id = ?').get(id) as Row);
}

export function setTodoDone(db: Db, deviceId: string, id: string, done: boolean): TodoDto | null {
  const row = db.prepare('select * from todos where id = ? and deleted_at is null').get(id) as Row | undefined;
  if (!row) return null;
  upsertShared(db, 'todos', { ...row, done: done ? 1 : 0 }, deviceId);
  return toDto(db.prepare('select * from todos where id = ?').get(id) as Row);
}

export function removeTodo(db: Db, deviceId: string, id: string): TodoDto | null {
  const row = db.prepare('select * from todos where id = ? and deleted_at is null').get(id) as Row | undefined;
  if (!row) return null;
  softDeleteShared(db, 'todos', id, deviceId);
  return toDto(row);
}
```

- [ ] **Step 4: テスト**

Run: `npx vitest run packages/server/src/projects/todos`
Expected: PASS（2 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/projects/todos.ts packages/server/src/projects/todos.test.ts
git commit -m "feat(server): todo add, toggle, remove and list over the shared todos table"
```

---

### Task 9: プロジェクトのメモ（DB と Markdown ファイルの両方）

**Files:**
- Create: `packages/server/src/projects/memo.ts`
- Test: `packages/server/src/projects/memo.test.ts`

**Interfaces:**
- Consumes: `project_memos`、`upsertShared`、`memoHead`（`db/queries.ts`）。
- Produces: 「インターフェース一覧」の `MemoStore`。`memoHead` は `db/queries.ts` のものを再エクスポートする。
- `write` は DB を書いてからファイルを書き、ファイルの mtime を DB の `updated_at` に合わせる（`fs.utimesSync`）。`reconcile` はファイルの mtime が DB より新しく中身が違えば DB を直し、ファイルが無くて DB にあればファイルを書き戻す。`watch` は `<home>/projects` を再帰で監視し、変化したファイルの `projectId`（親ディレクトリ名）だけを `debounceMs` 後に `reconcile` して、変わっていれば `onChange` を呼ぶ。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/projects/memo.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { MemoStore } from './memo.ts';

let home: string;
let db: Db;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-memo-')); db = openDb(':memory:'); upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd'); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MemoStore', () => {
  it('write は DB とファイルの両方に書き、read はそれを返す', () => {
    const m = new MemoStore({ db, deviceId: 'd', home });
    expect(m.read('p1')).toBeNull();
    const w = m.write('p1', '# alpha\n\n進め方');
    expect(w).toMatchObject({ projectId: 'p1', markdown: '# alpha\n\n進め方' });
    expect(fs.readFileSync(m.memoPath('p1'), 'utf8')).toBe('# alpha\n\n進め方');
    expect(m.read('p1')).toEqual(w);
    expect(Math.floor(fs.statSync(m.memoPath('p1')).mtimeMs)).toBe(w.updatedAt);
    expect((db.prepare("select count(*) c from changes where table_name = 'project_memos'").get() as { c: number }).c).toBe(1);
  });
  it('ファイルが新しければファイルが勝つ。ファイルが無ければ DB から書き戻す', () => {
    const m = new MemoStore({ db, deviceId: 'd', home });
    const w = m.write('p1', 'v1');
    fs.writeFileSync(m.memoPath('p1'), 'v2 from editor');
    const future = new Date(w.updatedAt + 5000);
    fs.utimesSync(m.memoPath('p1'), future, future);
    const r = m.reconcile('p1');
    expect(r).toEqual({ changed: true, memo: { projectId: 'p1', markdown: 'v2 from editor', updatedAt: w.updatedAt + 5000 } });
    expect(m.reconcile('p1').changed).toBe(false);
    expect(m.read('p1')!.markdown).toBe('v2 from editor');
    fs.rmSync(m.memoPath('p1'));
    expect(m.reconcile('p1')).toMatchObject({ changed: false });
    expect(fs.readFileSync(m.memoPath('p1'), 'utf8')).toBe('v2 from editor');
  });
  it('古いファイルは DB を上書きしない', () => {
    const m = new MemoStore({ db, deviceId: 'd', home });
    const w = m.write('p1', 'db wins');
    fs.writeFileSync(m.memoPath('p1'), 'stale');
    const past = new Date(w.updatedAt - 5000);
    fs.utimesSync(m.memoPath('p1'), past, past);
    expect(m.reconcile('p1').changed).toBe(false);
    expect(m.read('p1')!.markdown).toBe('db wins');
    expect(fs.readFileSync(m.memoPath('p1'), 'utf8')).toBe('db wins');
  });
  it('watch は外部の編集を取り込んで知らせる', async () => {
    const m = new MemoStore({ db, deviceId: 'd', home, debounceMs: 50 });
    m.write('p1', 'v1');
    const seen: string[] = [];
    const stop = m.watch((memo) => seen.push(memo.markdown));
    await wait(50);
    fs.writeFileSync(m.memoPath('p1'), 'edited outside');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(m.memoPath('p1'), future, future);
    await wait(400);
    stop();
    expect(seen).toEqual(['edited outside']);
    expect(m.reconcileAll()).toEqual([]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/projects/memo`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/projects/memo.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { MemoDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

export { memoHead } from '../db/queries.ts';

type Row = { project_id: string; markdown: string; updated_at: number };

/**
 * プロジェクトのメモ。
 * SQLite の project_memos を同期の正とし、~/.agent-hangar/projects/<projectId>/memo.md にも同じ内容を置く。
 * ファイルは他のエディタや Claude 自身が直接書けるので、ファイルの方が新しければファイルを正として DB を直す。
 */
export class MemoStore {
  private readonly db: Db;
  private readonly deviceId: string;
  private readonly home: string;
  private readonly debounceMs: number;

  constructor(o: { db: Db; deviceId: string; home: string; debounceMs?: number }) {
    this.db = o.db; this.deviceId = o.deviceId; this.home = o.home; this.debounceMs = o.debounceMs ?? 300;
  }

  memoPath(projectId: string): string { return path.join(this.home, 'projects', projectId, 'memo.md'); }

  private row(projectId: string): Row | null {
    return (this.db.prepare('select project_id, markdown, updated_at from project_memos where project_id = ? and deleted_at is null').get(projectId) as Row | undefined) ?? null;
  }

  private toDto(r: Row): MemoDto { return { projectId: r.project_id, markdown: r.markdown, updatedAt: r.updated_at }; }

  /** ファイルを書き、mtime を DB の updated_at に合わせる（次の reconcile が「同じ」と判定できるように）。 */
  private writeFile(projectId: string, markdown: string, updatedAt: number): void {
    const file = this.memoPath(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown);
    const t = new Date(updatedAt);
    fs.utimesSync(file, t, t);
  }

  read(projectId: string): MemoDto | null {
    this.reconcile(projectId);
    const r = this.row(projectId);
    return r ? this.toDto(r) : null;
  }

  write(projectId: string, markdown: string): MemoDto {
    upsertShared(this.db, 'project_memos', { project_id: projectId, markdown, deleted_at: null }, this.deviceId, 'project_id');
    const r = this.row(projectId)!;
    this.writeFile(projectId, r.markdown, r.updated_at);
    return this.toDto(r);
  }

  /** ファイルが新しく中身が違えば DB を直す。ファイルが無くて DB にあれば書き戻す。 */
  reconcile(projectId: string): { changed: boolean; memo: MemoDto | null } {
    const file = this.memoPath(projectId);
    const r = this.row(projectId);
    if (!fs.existsSync(file)) {
      if (r) this.writeFile(projectId, r.markdown, r.updated_at);
      return { changed: false, memo: r ? this.toDto(r) : null };
    }
    const mtime = Math.floor(fs.statSync(file).mtimeMs);
    const markdown = fs.readFileSync(file, 'utf8');
    if (r && (mtime <= r.updated_at || markdown === r.markdown)) return { changed: false, memo: this.toDto(r) };
    // upsertShared は updated_at を今にするので、ファイルの mtime で上書きしてファイルと揃える。
    upsertShared(this.db, 'project_memos', { project_id: projectId, markdown, deleted_at: null }, this.deviceId, 'project_id');
    this.db.prepare('update project_memos set updated_at = ? where project_id = ?').run(mtime, projectId);
    this.db.prepare("update changes set updated_at = ? where table_name = 'project_memos' and row_id = ? and seq = (select max(seq) from changes where table_name = 'project_memos' and row_id = ?)").run(mtime, projectId, projectId);
    const next = this.row(projectId)!;
    return { changed: true, memo: this.toDto(next) };
  }

  /** ディレクトリにあるメモをすべて照合し、変わったものを返す。起動時に呼ぶ。 */
  reconcileAll(): MemoDto[] {
    const root = path.join(this.home, 'projects');
    if (!fs.existsSync(root)) return [];
    const out: MemoDto[] = [];
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const r = this.reconcile(d.name);
      if (r.changed && r.memo) out.push(r.memo);
    }
    return out;
  }

  /** <home>/projects を監視し、変化した memo.md を debounce 後に取り込む。 */
  watch(onChange: (memo: MemoDto) => void): () => void {
    const root = path.join(this.home, 'projects');
    fs.mkdirSync(root, { recursive: true });
    const timers = new Map<string, NodeJS.Timeout>();
    const watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const parts = String(name).split(path.sep);
      const projectId = parts[0];
      if (!projectId || parts[parts.length - 1] !== 'memo.md') return;
      const prev = timers.get(projectId);
      if (prev) clearTimeout(prev);
      timers.set(projectId, setTimeout(() => {
        timers.delete(projectId);
        try { const r = this.reconcile(projectId); if (r.changed && r.memo) onChange(r.memo); } catch { /* 読めない瞬間は次の変化で拾う */ }
      }, this.debounceMs));
    });
    watcher.on('error', () => { /* 監視が壊れても読み書きは動く */ });
    return () => { watcher.close(); for (const t of timers.values()) clearTimeout(t); };
  }
}
```

`reconcile` が `changes` の `updated_at` も直すのは、同期の競合解決（`updated_at` の新しい方を採る）でファイルの時刻を使わせるためである。

- [ ] **Step 4: テスト**

Run: `npx vitest run packages/server/src/projects/memo`
Expected: PASS（4 件）。`watch` のテストは macOS の `fs.watch` の再帰監視に依存する。CI（ubuntu、Node 22）でも再帰監視は使えるが、失敗するときは `describe.skipIf(process.platform === 'linux')` で囲む。

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/projects/memo.ts packages/server/src/projects/memo.test.ts
git commit -m "feat(server): project memo store mirrored to markdown files with external edit reconciliation"
```

---

### Task 10: MCP ツールの拡張（update_project、get_project、get_usage）

**Files:**
- Modify: `packages/server/src/mcp/tools.ts`、`packages/server/src/mcp/app.ts`
- Test: `packages/server/src/mcp/tools.test.ts`（変更と追加）

**Interfaces:**
- Consumes: `addTodo`、`setTodoDone`、`listTodos`（Task 8）、`MemoStore`（Task 9）、`listArtifacts`（Task 7）、`UsageDto`。
- Produces: `ToolDeps` に `usage: () => UsageDto` と `memos: MemoStore` を足す。`update_project` は `status`、`add_todos`（文字列の配列）、`toggle_todos`（TODO の ID の配列。完了と未完を反転）、`append_memo`（末尾に空行を挟んで追記）を書き、`todos.update` と `memo.update` を配る。`get_project` の `todos` は `listTodos`、`memo` は `MemoStore.read`、`artifacts` は `listArtifacts({ projectId })` を `{ id, url, title, favicon, last_published_at, version_count }` にしたもの。`get_usage` は `{ five_hour: { used_percentage, resets_at } | null, seven_day: ... | null, updated_at }`。
- セッション別 URL から `add_todos` を呼んだときは `todos.session_id` に `ctx.sessionId` を入れる。

- [ ] **Step 1: テストを直して足す**

`packages/server/src/mcp/tools.test.ts` の `beforeEach` の `deps` に `usage: () => ({ fiveHour: { usedPercent: 47, resetsAt: 1_760_000_000_000 }, sevenDay: null, updatedAt: 5 }), memos: new MemoStore({ db, deviceId: 'd', home })` を足す。
`home` は `fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-'))` で作り、`afterEach` で消す（`import os from 'node:os'; import path from 'node:path'; import { MemoStore } from '../projects/memo.ts';` を足す）。

「update_project は status だけ書き、TODO とメモは not_yet」の `it` を次に置き換える。

```ts
  it('update_project は status、TODO、メモを書き、イベントを配る', () => {
    const r = call('update_project', { project_id: 'p1', status: 'paused', add_todos: ['x', 'y'], append_memo: '## 追記' }, { sessionId: alphaId });
    expect((r.project as { status: string }).status).toBe('paused');
    expect((r.todos as { text: string; done: boolean; session_id: string | null }[]).map((t) => [t.text, t.done, t.session_id])).toEqual([['x', false, alphaId], ['y', false, alphaId]]);
    expect(r.memo).toBe('## 追記');
    expect(sent.map((e) => e.type)).toEqual(['project.upsert', 'todos.update', 'memo.update', 'project.upsert']);
    const ids = (r.todos as { id: string }[]).map((t) => t.id);
    const r2 = call('update_project', { project_id: 'p1', toggle_todos: [ids[0]], append_memo: '続き' });
    expect((r2.todos as { done: boolean }[]).map((t) => t.done)).toEqual([true, false]);
    expect(r2.memo).toBe('## 追記\n\n続き');
    expect((r2.project as { open_todo_count: number }).open_todo_count).toBe(1);
    expect(() => call('update_project', { project_id: 'p1', status: 'bogus' })).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p1', toggle_todos: ['nope'] })).toThrow(/nope/);
  });
```

「list_projects と get_project」の `expect(p).toMatchObject({ id: 'p1', memo: null, todos: [], artifacts: [] });` はそのまま通る。
その `it` の末尾に足す。

```ts
    call('update_project', { project_id: 'p1', add_todos: ['a'], append_memo: 'm' });
    recordArtifactPublish(db, 'd', { sessionId: alphaId, projectId: 'p1', url: 'https://claude.ai/code/artifact/z', publishedAt: 7, call: { filePath: null, description: 'Z', favicon: '🧪' } });
    const p2 = call('get_project', { project_id: 'p1' });
    expect(p2.memo).toBe('m');
    expect((p2.todos as unknown[]).length).toBe(1);
    expect(p2.artifacts).toEqual([{ id: expect.any(String), url: 'https://claude.ai/code/artifact/z', title: 'Z', favicon: '🧪', last_published_at: 7, version_count: 1 }]);
```

`import { recordArtifactPublish } from '../artifacts/extract.ts';` を足す。
「set_session_memo、get_usage、open_in_hangar」の `expect(call('get_usage')).toEqual({ not_yet: 'フェーズ 3 で対応します' });` を次に置き換える。

```ts
    expect(call('get_usage')).toEqual({ five_hour: { used_percentage: 47, resets_at: 1_760_000_000_000 }, seven_day: null, updated_at: 5 });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/mcp/tools`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/mcp/tools.ts` の import と `ToolDeps` を直し、`NOT_YET` の定数を消し、`getProjectTool`、`updateProjectTool`、`callTool` の `get_usage` を置き換える。

```ts
import type { LaunchParams, LiveSessionDto, ProjectStatus, ServerEvent, SessionDto, SummaryState, TranscriptEvent, UsageDto } from '@agent-hangar/shared';
import { listArtifacts } from '../artifacts/queries.ts';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import type { MemoStore } from '../projects/memo.ts';
import { addTodo, listTodos, setTodoDone } from '../projects/todos.ts';
import type { LaunchResult } from '../runs/manager.ts';
import { searchSessions } from '../search/search.ts';
import { readEvents } from '../transcript/read.ts';

export type ToolDeps = { db: Db; deviceId: string; port: number; live: () => LiveSessionDto[]; runs: { start(params: LaunchParams): LaunchResult }; hub: { broadcast(ev: ServerEvent): void }; usage: () => UsageDto; memos: MemoStore };
```

```ts
export function getProjectTool(deps: ToolDeps, args: Record<string, unknown>) {
  const id = str(args.project_id);
  if (!id) throw new ToolError('project_id が必要です');
  const p = getProject(deps.db, deps.deviceId, deps.live(), id);
  if (!p) throw new ToolError(`プロジェクトが見つかりません: ${id}`);
  const memo = deps.memos.read(id)?.markdown ?? null;
  const todos = listTodos(deps.db, id).map((t) => ({ id: t.id, text: t.text, done: t.done, session_id: t.sessionId }));
  const recent = listSessions(deps.db, deps.live(), { projectId: id }).slice(0, RECENT_SESSIONS).map(sessionBrief);
  const artifacts = listArtifacts(deps.db, { projectId: id }).map((a) => ({ id: a.id, url: a.url, title: a.title, favicon: a.favicon, last_published_at: a.lastPublishedAt, version_count: a.versionCount }));
  return { id: p.id, name: p.name, status: p.status, path: p.path, resolved: p.resolved, last_activity_at: p.lastActivityAt, open_todo_count: p.openTodoCount, memo, todos, recent_sessions: recent, artifacts };
}

/** status、add_todos、toggle_todos、append_memo を受け、変えた表ごとにイベントを配る。 */
export function updateProjectTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = str(args.project_id);
  if (!id) throw new ToolError('project_id が必要です');
  const row = deps.db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new ToolError(`プロジェクトが見つかりません: ${id}`);
  const status = str(args.status);
  if (status !== undefined) {
    if (!STATUSES.includes(status as ProjectStatus)) throw new ToolError(`status は ${STATUSES.join(', ')} のいずれかです`);
    upsertShared(deps.db, 'projects', { ...row, status }, deps.deviceId);
    deps.hub.broadcast({ type: 'project.upsert', project: getProject(deps.db, deps.deviceId, deps.live(), id)! });
  }
  const adds = strs(args.add_todos) ?? [];
  const toggles = strs(args.toggle_todos) ?? [];
  if (adds.length || toggles.length) {
    for (const t of adds) addTodo(deps.db, deps.deviceId, { projectId: id, text: t, sessionId: ctx.sessionId });
    for (const tid of toggles) {
      const cur = deps.db.prepare('select done from todos where id = ? and project_id = ? and deleted_at is null').get(tid, id) as { done: number } | undefined;
      if (!cur) throw new ToolError(`TODO が見つかりません: ${tid}`);
      setTodoDone(deps.db, deps.deviceId, tid, cur.done !== 1);
    }
    deps.hub.broadcast({ type: 'todos.update', projectId: id, todos: listTodos(deps.db, id) });
  }
  const append = typeof args.append_memo === 'string' ? args.append_memo : undefined;
  if (append !== undefined && append.trim()) {
    const cur = deps.memos.read(id)?.markdown ?? '';
    const memo = deps.memos.write(id, cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${append}` : append);
    deps.hub.broadcast({ type: 'memo.update', memo });
  }
  // TODO とメモの変更で ProjectDto の openTodoCount と memoHead が変わるので、最後にもう一度配る。
  const p = getProject(deps.db, deps.deviceId, deps.live(), id)!;
  if (adds.length || toggles.length || append) deps.hub.broadcast({ type: 'project.upsert', project: p });
  return { project: { id: p.id, name: p.name, status: p.status, open_todo_count: p.openTodoCount }, todos: listTodos(deps.db, id).map((t) => ({ id: t.id, text: t.text, done: t.done, session_id: t.sessionId })), memo: deps.memos.read(id)?.markdown ?? null };
}

export function getUsageTool(deps: ToolDeps) {
  const u = deps.usage();
  const w = (x: { usedPercent: number; resetsAt: number | null } | null) => (x ? { used_percentage: x.usedPercent, resets_at: x.resetsAt } : null);
  return { five_hour: w(u.fiveHour), seven_day: w(u.sevenDay), updated_at: u.updatedAt };
}
```

`callTool` の分岐を `case 'update_project': return updateProjectTool(deps, ctx, args);` と `case 'get_usage': return getUsageTool(deps);` に直す。

`packages/server/src/mcp/app.ts` の説明文を直す。

```ts
  reg('update_project', D('プロジェクトのステータスを変え、TODO を足すか反転し、メモに追記する。'), { project_id: z.string(), status: STATUS.optional(), add_todos: z.array(z.string()).optional(), toggle_todos: z.array(z.string()).optional(), append_memo: z.string().optional() });
  reg('get_usage', D('Claude の 5 時間と 7 日のレート制限の使用率と最終更新時刻。statusline から届いた最新の値。'), {});
```

`packages/server/src/mcp/app.test.ts` の `createMcpApp` の呼び出しに `usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), memos: new MemoStore({ db, deviceId: 'd', home: fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcpapp-')) })` を足す。

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/mcp && npx tsc -p packages/server --noEmit 2>&1 | grep -v 'app.ts\|server.ts'`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/mcp
git commit -m "feat(server): mcp update_project writes todos and memo, get_project lists artifacts, get_usage returns rate limits"
```

---

### Task 11: スクラッチの擬似プロジェクトと起動

**Files:**
- Create: `packages/server/src/projects/scratch.ts`
- Modify: `packages/server/src/runs/manager.ts`
- Test: `packages/server/src/projects/scratch.test.ts`、`packages/server/src/runs/manager.test.ts`（追加）

**Interfaces:**
- Consumes: `upsertShared`、`newId`、`RunManager.start`、`RunManagerDeps.home`。
- Produces: 「インターフェース一覧」の `scratch.ts` の関数。`RunManager.start({ scratch: true, ... })` が `~/.agent-hangar/scratch/<yyyymmdd-HHmmss>/` を作り、スクラッチのプロジェクトに属するセッションを起動する。`projectId` が同時に来ても `scratch` を優先する。
- `ensureScratchProject` はこの端末の `project_roots.path === scratchRoot` の行があればその `project_id` を、無ければ `is_scratch = 1` のプロジェクトを作って返す。名前は「スクラッチ」。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/projects/scratch.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { ensureScratchProject, isUnderScratch, newScratchDir, SCRATCH_PROJECT_NAME, scratchRoot } from './scratch.ts';

describe('scratch', () => {
  it('擬似プロジェクトは 1 つだけ作られる', () => {
    const db = openDb(':memory:');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-scr-'));
    const id = ensureScratchProject(db, 'd', home);
    expect(ensureScratchProject(db, 'd', home)).toBe(id);
    const p = db.prepare('select name, is_scratch, status from projects where id = ?').get(id);
    expect(p).toEqual({ name: SCRATCH_PROJECT_NAME, is_scratch: 1, status: 'active' });
    expect(db.prepare('select path, resolved from project_roots where project_id = ? and device_id = ?').get(id, 'd')).toEqual({ path: scratchRoot(home), resolved: 1 });
    expect(fs.existsSync(scratchRoot(home))).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('ディレクトリ名は時刻で、同じ秒は -2 を付ける', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-scr-'));
    const t = new Date(2026, 8, 17, 9, 5, 7);
    const a = newScratchDir(home, t);
    expect(a).toBe(path.join(scratchRoot(home), '20260917-090507'));
    expect(fs.statSync(a).isDirectory()).toBe(true);
    expect(newScratchDir(home, t)).toBe(path.join(scratchRoot(home), '20260917-090507-2'));
    expect(newScratchDir(home, t)).toBe(path.join(scratchRoot(home), '20260917-090507-3'));
    expect(isUnderScratch(home, a)).toBe(true);
    expect(isUnderScratch(home, path.join(a, 'sub'))).toBe(true);
    expect(isUnderScratch(home, scratchRoot(home))).toBe(false);
    expect(isUnderScratch(home, '/elsewhere')).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
```

`packages/server/src/runs/manager.test.ts` の「scratch、projectId 無し、無いプロジェクト、未解決のプロジェクトを拒む」から `expect(() => rm.start({ scratch: true })).toThrow(RunError);` の行を消し、`describe.skipIf(!TMUX)('RunManager.start（tmux 上）', ...)` に足す。

```ts
  it('scratch は新しいディレクトリを作り、スクラッチのプロジェクトに属するセッションを起動する', async () => {
    const rm = make();
    const r = rm.start({ scratch: true, projectId: 'p1', name: 'scratchy' });
    const s = db.prepare('select cwd, project_id, name from sessions where id = ?').get(r.sessionId) as { cwd: string; project_id: string; name: string };
    expect(s.cwd.startsWith(path.join(home, 'scratch') + path.sep)).toBe(true);
    expect(fs.statSync(s.cwd).isDirectory()).toBe(true);
    expect(s.name).toBe('scratchy');
    expect(db.prepare('select is_scratch, name from projects where id = ?').get(s.project_id)).toEqual({ is_scratch: 1, name: 'スクラッチ' });
    const args = await readArgs();
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('プロジェクト：スクラッチ（' + s.cwd + '）');
    expect(tmux!.hasSession(r.run.tmuxName)).toBe(true);
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/projects/scratch packages/server/src/runs/manager`
Expected: FAIL

- [ ] **Step 3: scratch.ts を書く**

`packages/server/src/projects/scratch.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

export const SCRATCH_PROJECT_NAME = 'スクラッチ';

export function scratchRoot(home: string): string { return path.join(home, 'scratch'); }

/** この端末のスクラッチの擬似プロジェクト。無ければ作る。ルートは ~/.agent-hangar/scratch そのもの。 */
export function ensureScratchProject(db: Db, deviceId: string, home: string): string {
  const root = scratchRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const cur = db.prepare('select r.project_id id from project_roots r join projects p on p.id = r.project_id where r.device_id = ? and r.path = ? and r.deleted_at is null and p.deleted_at is null and p.is_scratch = 1').get(deviceId, root) as { id: string } | undefined;
  if (cur) return cur.id;
  const id = newId();
  upsertShared(db, 'projects', { id, name: SCRATCH_PROJECT_NAME, status: 'active', is_scratch: 1 }, deviceId);
  upsertShared(db, 'project_roots', { id: newId(), project_id: id, device_id: deviceId, path: root, resolved: 1 }, deviceId);
  return id;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** <root>/<yyyymmdd-HHmmss> を作る。同じ秒に重なれば -2、-3 を付ける。 */
export function newScratchDir(home: string, now: Date = new Date()): string {
  const root = scratchRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let n = 1; ; n++) {
    const dir = path.join(root, n === 1 ? base : `${base}-${n}`);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir);
    return dir;
  }
}

/** cwd がスクラッチのルートの下（ルートそのものは含まない）にあるか。 */
export function isUnderScratch(home: string, cwd: string): boolean {
  return cwd.startsWith(scratchRoot(home) + path.sep);
}
```

- [ ] **Step 4: RunManager.start を直す**

`packages/server/src/runs/manager.ts` に `import { ensureScratchProject, newScratchDir } from '../projects/scratch.ts';` を足し、`start` を次に置き換える。

```ts
  start(params: LaunchParams): LaunchResult {
    // フェーズ 2 と同じく、検査をすべて先に済ませてから行を作る。
    this.addDirs(params);
    // スクラッチは使い捨てのディレクトリを作り、擬似プロジェクトに属させる。projectId が来ていても scratch を優先する。
    const p = params.scratch
      ? this.scratchProject()
      : (() => { if (!params.projectId) throw new RunError(400, 'projectId は必須です'); return this.project(params.projectId); })();
    if (!p.path || !p.resolved) throw new RunError(400, 'プロジェクトのディレクトリがこの端末で見つかりません');
    // スクラッチのディレクトリは precheck より先に作る。precheck は cwd が実在するかを見る。
    const cwd = params.scratch ? newScratchDir(this.deps.home, new Date(this.now())) : p.path;
    this.precheck(cwd);
    const sessionUuid = crypto.randomUUID();
    const sessionId = ensureSession(this.db, sessionUuid, cwd, this.deps.deviceId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, project_id: p.id, name: params.name?.trim() || null, started_at: now, last_activity_at: now }, this.deps.deviceId);
    const input: LaunchInput = { ...this.baseInput(sessionId, p.id, cwd, params), mode: { kind: 'start', sessionUuid } };
    const command = claudeCodeProvider.launchCommand(this.deps.claudeBin, input);
    return this.launch({ sessionId, cwd, kind: 'start', command, params });
  }

  private scratchProject(): ProjectInfo {
    const id = ensureScratchProject(this.db, this.deps.deviceId, this.deps.home);
    return this.project(id);
  }
```

`injectionFor(projectId, cwd)` は `projectPath` に `cwd` を渡しているので、スクラッチではディレクトリの絶対パスが注入に入る。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/projects/scratch packages/server/src/runs && npx tsc -p packages/server --noEmit 2>&1 | grep -v 'app.ts\|server.ts'`
Expected: PASS（tmux があれば scratch の起動テストも走る）

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/projects/scratch.ts packages/server/src/projects/scratch.test.ts packages/server/src/runs
git commit -m "feat(server): scratch pseudo project and scratch launches into timestamped directories"
```

---

### Task 12: 昇格（スクラッチからプロジェクトへ）

**Files:**
- Create: `packages/server/src/projects/promote.ts`
- Test: `packages/server/src/projects/promote.test.ts`

**Interfaces:**
- Consumes: `upsertShared`、`newId`、`isUnderScratch`（Task 11）。
- Produces: 「インターフェース一覧」の `PromoteError`、`PromoteDeps`、`promoteSession`。
- 手順：(1) `<workspaceRoot>/<name>` を作り、`gitInit` なら `deps.gitInit(dir)`（既定は `execFileSync('git', ['init'], { cwd: dir })`）。(2) プロジェクトと `project_roots` を作る。(3) セッションの `project_id` を変える。(4) `moveFiles` で run が生きていなければスクラッチの中身を移し、空になったディレクトリを消す。run が生きていれば `moved: false, reason: 'run が実行中のため移動しませんでした'`。`moveFiles` が偽なら `reason: null`。
- 検査：セッションが無ければ 404、`name` が空か `/` を含めば 400、cwd がスクラッチの下でなければ 400、先が既にあれば 409。ディレクトリを作った後で失敗したら作ったディレクトリを消す（中身は無いので `rmdirSync`）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/projects/promote.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { promoteSession, PromoteError } from './promote.ts';
import { ensureScratchProject, newScratchDir } from './scratch.ts';

let home: string; let ws: string; let db: Db; let scratchId: string; let dir: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pro-home-')); ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pro-ws-'));
  db = openDb(':memory:'); scratchId = ensureScratchProject(db, 'd', home); dir = newScratchDir(home);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A'); fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'B');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: dir, home_device: 'd', project_id: scratchId }, 'd');
  upsertShared(db, 'sessions', { id: 's9', provider: 'claude-code', provider_session_id: 'u9', cwd: '/elsewhere', home_device: 'd', project_id: null }, 'd');
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); });
const deps = (over: Partial<Parameters<typeof promoteSession>[0]> = {}) => ({ db, deviceId: 'd', home, workspaceRoot: ws, runAlive: () => false, gitInit: vi.fn(), ...over });

describe('promoteSession', () => {
  it('ディレクトリとプロジェクトを作り、セッションを移し、ファイルを移動する', () => {
    const d = deps();
    const r = promoteSession(d, { sessionId: 's1', name: 'newproj', gitInit: true, moveFiles: true });
    expect(r.moved).toBe(true);
    expect(r.reason).toBeNull();
    expect(d.gitInit).toHaveBeenCalledWith(path.join(ws, 'newproj'));
    expect(fs.readFileSync(path.join(ws, 'newproj', 'a.txt'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(ws, 'newproj', 'sub', 'b.txt'), 'utf8')).toBe('B');
    expect(fs.existsSync(dir)).toBe(false);
    expect(db.prepare('select name, is_scratch from projects where id = ?').get(r.projectId)).toEqual({ name: 'newproj', is_scratch: 0 });
    expect(db.prepare('select path from project_roots where project_id = ? and device_id = ?').get(r.projectId, 'd')).toEqual({ path: path.join(ws, 'newproj') });
    expect(db.prepare('select project_id, cwd from sessions where id = ?').get('s1')).toEqual({ project_id: r.projectId, cwd: dir });   // cwd は変えない
  });
  it('run が生きていれば移動せず、理由を返す。gitInit が偽なら呼ばない', () => {
    const d = deps({ runAlive: () => true });
    const r = promoteSession(d, { sessionId: 's1', name: 'p2', gitInit: false, moveFiles: true });
    expect(r).toMatchObject({ moved: false, reason: expect.stringContaining('実行中') });
    expect(d.gitInit).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'p2'))).toBe(true);
    expect(promoteSession(deps(), { sessionId: 's1', name: 'p3', gitInit: false, moveFiles: false })).toMatchObject({ moved: false, reason: null });
  });
  it('検査：無いセッション、悪い名前、スクラッチ外、既存のディレクトリ', () => {
    expect(() => promoteSession(deps(), { sessionId: 'nope', name: 'x', gitInit: false, moveFiles: false })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => promoteSession(deps(), { sessionId: 's1', name: '', gitInit: false, moveFiles: false })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => promoteSession(deps(), { sessionId: 's1', name: 'a/b', gitInit: false, moveFiles: false })).toThrow(PromoteError);
    expect(() => promoteSession(deps(), { sessionId: 's9', name: 'x', gitInit: false, moveFiles: false })).toThrow(expect.objectContaining({ status: 400 }));
    fs.mkdirSync(path.join(ws, 'taken'));
    expect(() => promoteSession(deps(), { sessionId: 's1', name: 'taken', gitInit: false, moveFiles: false })).toThrow(expect.objectContaining({ status: 409 }));
    expect(fs.existsSync(path.join(ws, 'taken'))).toBe(true);
  });
  it('git init が失敗したら作ったディレクトリを消して 400', () => {
    const d = deps({ gitInit: () => { throw new Error('git が無い'); } });
    expect(() => promoteSession(d, { sessionId: 's1', name: 'fail', gitInit: true, moveFiles: false })).toThrow(/git が無い/);
    expect(fs.existsSync(path.join(ws, 'fail'))).toBe(false);
    expect(db.prepare("select count(*) c from projects where name = 'fail'").get()).toEqual({ c: 0 });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/projects/promote`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/projects/promote.ts`：

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { isUnderScratch } from './scratch.ts';

export class PromoteError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); this.name = 'PromoteError'; }
}

export type PromoteDeps = { db: Db; deviceId: string; home: string; workspaceRoot: string; runAlive: (sessionId: string) => boolean; gitInit?: (dir: string) => void };

const defaultGitInit = (dir: string) => { execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' }); };

/** スクラッチのディレクトリの中身を移し、空になった元を消す。中身の移動は同じボリュームなので rename で足りる。 */
function moveContents(from: string, to: string): void {
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    try { fs.renameSync(src, dst); }
    catch (e) {
      // 別ボリュームなど rename が使えないときはコピーしてから消す。
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
  }
  fs.rmdirSync(from);
}

/**
 * スクラッチのセッションをプロジェクトに昇格する。
 * 設計文書の手順 1 から 4 をこの順で行い、run が生きていればファイルは移動しない。
 */
export function promoteSession(deps: PromoteDeps, o: { sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }): { projectId: string; moved: boolean; reason: string | null } {
  const s = deps.db.prepare('select id, cwd from sessions where id = ? and deleted_at is null').get(o.sessionId) as { id: string; cwd: string } | undefined;
  if (!s) throw new PromoteError(404, 'セッションが見つかりません');
  const name = o.name.trim();
  if (!name || name.includes('/') || name === '.' || name === '..') throw new PromoteError(400, '名前はディレクトリ名として使える 1 字以上で、/ を含められません');
  if (!isUnderScratch(deps.home, s.cwd)) throw new PromoteError(400, 'このセッションはスクラッチではありません');
  const dir = path.join(deps.workspaceRoot, name);
  if (fs.existsSync(dir)) throw new PromoteError(409, `${dir} は既にあります`);

  // 1. ディレクトリを作り、必要なら git init。失敗したら作ったものを片付けて終える。
  fs.mkdirSync(dir, { recursive: true });
  try { if (o.gitInit) (deps.gitInit ?? defaultGitInit)(dir); }
  catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw new PromoteError(400, `git init に失敗しました: ${e instanceof Error ? e.message : String(e)}`); }

  // 2. プロジェクトとこの端末のルート。3. セッションの紐づけ。
  const projectId = newId();
  const write = deps.db.transaction(() => {
    upsertShared(deps.db, 'projects', { id: projectId, name, status: 'active', is_scratch: 0 }, deps.deviceId);
    upsertShared(deps.db, 'project_roots', { id: newId(), project_id: projectId, device_id: deps.deviceId, path: dir, resolved: 1 }, deps.deviceId);
    const row = deps.db.prepare('select * from sessions where id = ?').get(s.id) as Record<string, unknown>;
    upsertShared(deps.db, 'sessions', { ...row, project_id: projectId }, deps.deviceId);
  });
  write();

  // 4. run がすべて終わっていればファイルを移す。生きていれば移さず、その旨を返す。
  if (!o.moveFiles) return { projectId, moved: false, reason: null };
  if (deps.runAlive(s.id)) return { projectId, moved: false, reason: 'run が実行中のためファイルは移動しませんでした。終了後に手で移してください' };
  moveContents(s.cwd, dir);
  return { projectId, moved: true, reason: null };
}
```

- [ ] **Step 4: テスト**

Run: `npx vitest run packages/server/src/projects/promote`
Expected: PASS（4 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/projects/promote.ts packages/server/src/projects/promote.test.ts
git commit -m "feat(server): promote a scratch session into a workspace project with optional git init and file move"
```

---

### Task 13: 要約器の型、スキーマ、入力の圧縮

**Files:**
- Create: `packages/server/src/summary/types.ts`、`packages/server/src/summary/input.ts`
- Test: `packages/server/src/summary/input.test.ts`

**Interfaces:**
- Consumes: `readEvents`（`transcript/read.ts`）、`TranscriptEvent`、`session_stats`。
- Produces: 「インターフェース一覧」の `summary/types.ts` と `summary/input.ts`。
- `SUMMARY_SCHEMA` はフェーズ 0 の spike 12 と同じ（`title` 40 字、`one_liner` 80 字、`body`、`state` の enum、`next_steps` 5 件まで、`additionalProperties: false`）。`parseSummaryOutput` はスキーマの形を満たす値だけを `SummaryOutput` に直し、`title` か `one_liner` が空なら null。
- `compressEvents` は「前提」の規則で圧縮する。`buildSummaryInput` は主線の全イベントを 2,000 件ずつ読み、`turns` は `session_stats.turns`、`titleHint` は `sessions.ai_title ?? name`。本文（`event_index`）が無ければ null。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/summary/input.test.ts`：

```ts
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { buildSummaryInput, CANNED_INPUT, compressEvents } from './input.ts';
import { parseSummaryOutput, SUMMARY_SCHEMA } from './types.ts';

const ev = (kind: TranscriptEvent['kind'], text: string, seq: number): TranscriptEvent => {
  switch (kind) {
    case 'user': return { kind, seq, text };
    case 'assistant': return { kind, seq, text };
    case 'thinking': return { kind, seq, text };
    case 'system': return { kind, seq, text };
    case 'tool_call': return { kind, seq, toolId: 't' + seq, name: 'Edit', input: {}, summary: text };
    case 'tool_result': return { kind, seq, toolId: 't', text, isError: false };
    default: return { kind: 'meta', seq, name: 'x', value: text };
  }
};

describe('compressEvents', () => {
  it('役割ごとの上限で切り、thinking と tool_result と meta を捨てる', () => {
    const text = compressEvents([ev('user', 'あ'.repeat(2500), 0), ev('thinking', '考え', 1), ev('assistant', 'い'.repeat(700), 2), ev('tool_call', 'Edit src/a.ts', 3), ev('tool_result', 'ok', 4), ev('meta', 'm', 5), ev('system', 's', 6)]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('[user] ' + 'あ'.repeat(2000));
    expect(lines[1]).toBe('[assistant] ' + 'い'.repeat(600));
    expect(lines[2]).toBe('[tool] Edit src/a.ts');
  });
  it('全体が上限を超えたら中盤を間引き、最初と最後を残す', () => {
    const events: TranscriptEvent[] = [];
    for (let i = 0; i < 100; i++) events.push(ev('user', `発言${i} ` + 'x'.repeat(200), i));
    const text = compressEvents(events, { totalMax: 5000 });
    expect(text.length).toBeLessThanOrEqual(5000);
    expect(text).toContain('[user] 発言0 ');
    expect(text).toContain('発言99 ');
    expect(text).toMatch(/\[\.\.\. \d+ 件を省略 \.\.\.\]/);
    expect(text).not.toContain('発言50 ');
  });
});

describe('buildSummaryInput', () => {
  let dir: string; let db: Db;
  beforeEach(async () => { dir = copyFixtureClaudeDir(); db = openDb(':memory:'); await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  it('主線から入力を組み立てる', () => {
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    const input = buildSummaryInput(db, id, true)!;
    expect(input).toMatchObject({ sessionId: id, turns: 2, running: true, titleHint: '動画チャンネルの整理' });
    expect(input.text).toContain('[user] 動画チャンネルの整理をしたい');
    expect(input.text).toContain('[tool] Bash ls channels/');
    expect(input.text).not.toContain('a.md\nb.md');
    expect(buildSummaryInput(db, 'nope', false)).toBeNull();
  });
});

describe('types', () => {
  it('スキーマの形と parseSummaryOutput', () => {
    expect(SUMMARY_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: ['title', 'one_liner', 'body', 'state', 'next_steps'] });
    expect(parseSummaryOutput({ title: 'T', one_liner: 'O', body: 'B', state: 'done', next_steps: ['a', 1] })).toEqual({ title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: ['a'] });
    expect(parseSummaryOutput({ title: '', one_liner: 'O', body: 'B', state: 'done', next_steps: [] })).toBeNull();
    expect(parseSummaryOutput({ title: 'T', one_liner: 'O', body: 'B', state: 'weird', next_steps: [] })).toBeNull();
    expect(parseSummaryOutput('x')).toBeNull();
    expect(CANNED_INPUT.text.length).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/summary`
Expected: FAIL

- [ ] **Step 3: 型を書く**

`packages/server/src/summary/types.ts`：

```ts
import type { SummarizerId, SummaryState } from '@agent-hangar/shared';

export type SummaryInput = { sessionId: string; text: string; turns: number; running: boolean; titleHint: string | null };
export type SummaryOutput = { title: string; oneLiner: string; body: string; state: SummaryState; nextSteps: string[] };

/** 要約器は差し替え可能な部品。available が偽か summarize が失敗したら次の要約器へ回す。 */
export interface Summarizer {
  readonly id: SummarizerId;
  available(): Promise<boolean>;
  summarize(input: SummaryInput): Promise<SummaryOutput>;
}

export class SummarizerError extends Error {
  constructor(readonly id: SummarizerId, message: string) { super(message); this.name = 'SummarizerError'; }
}

/** フェーズ 0 の spike 12 と 13 で安定した JSON スキーマ。 */
export const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 40 },
    one_liner: { type: 'string', maxLength: 80 },
    body: { type: 'string' },
    state: { type: 'string', enum: ['in_progress', 'done', 'blocked', 'abandoned'] },
    next_steps: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: ['title', 'one_liner', 'body', 'state', 'next_steps'],
};

export const SUMMARY_SYSTEM_PROMPT = [
  '以下はコーディングエージェントのセッションログの抜粋です。日本語で、指定の JSON だけを返してください。',
  'title は名詞句（40 字まで）、one_liner は 1 文（80 字まで）、body は 2〜3 文、next_steps は具体的な行動（5 件まで）。',
  'state の判定：最後の発言がアシスタントの問いかけや確認で終わっていれば in_progress。依頼が果たされていれば done。',
  'エラーや権限や情報の不足で進めなくなっていれば blocked。途中で打ち切られていれば abandoned。',
  '先頭に「このセッションは現在も実行中」とあれば、完了と断定せず in_progress を選ぶ。',
].join('\n');

const STATES: SummaryState[] = ['in_progress', 'done', 'blocked', 'abandoned'];

/** スキーマの形を満たす値だけを SummaryOutput に直す。title か one_liner が空なら null。 */
export function parseSummaryOutput(v: unknown): SummaryOutput | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const oneLiner = typeof o.one_liner === 'string' ? o.one_liner.trim() : '';
  const body = typeof o.body === 'string' ? o.body.trim() : '';
  const state = typeof o.state === 'string' && STATES.includes(o.state as SummaryState) ? (o.state as SummaryState) : null;
  if (!title || !oneLiner || !state) return null;
  const nextSteps = Array.isArray(o.next_steps) ? o.next_steps.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  return { title, oneLiner, body, state, nextSteps };
}
```

- [ ] **Step 4: 入力を書く**

`packages/server/src/summary/input.ts`：

```ts
import type { TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { readEvents } from '../transcript/read.ts';
import type { SummaryInput } from './types.ts';

export type CompressOptions = { userMax?: number; assistantMax?: number; totalMax?: number };

const cut = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n).join('') : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * 利用者の発言は 2,000 字、アシスタントの本文は 600 字、ツール呼び出しは要約の 1 行。
 * 全体が上限を超えたら先頭と末尾の 3 割ずつを残し、中盤を省略の 1 行に置き換える。
 */
export function compressEvents(events: TranscriptEvent[], opts: CompressOptions = {}): string {
  const userMax = opts.userMax ?? 2000;
  const assistantMax = opts.assistantMax ?? 600;
  const totalMax = opts.totalMax ?? 12000;
  const items: string[] = [];
  for (const e of events) {
    if (e.kind === 'user' && e.text.trim()) items.push(`[user] ${cut(oneLine(e.text), userMax)}`);
    else if (e.kind === 'assistant' && e.text.trim()) items.push(`[assistant] ${cut(oneLine(e.text), assistantMax)}`);
    else if (e.kind === 'tool_call') items.push(`[tool] ${cut(oneLine(e.summary), 200)}`);
  }
  let text = items.join('\n');
  if (text.length <= totalMax) return text;
  let head = Math.floor(items.length * 0.3);
  let tail = Math.floor(items.length * 0.3);
  // 3 割ずつでも収まらないときは、収まるまで両端を狭める。
  for (;;) {
    const kept = [...items.slice(0, head), `[... ${items.length - head - tail} 件を省略 ...]`, ...items.slice(items.length - tail)];
    text = kept.join('\n');
    if (text.length <= totalMax || (head <= 1 && tail <= 1)) break;
    if (head >= tail) head--; else tail--;
  }
  return text.length <= totalMax ? text : text.slice(0, totalMax);
}

/** 主線の全イベントを読み、圧縮した本文と付帯情報にする。本文が無ければ null。 */
export function buildSummaryInput(db: Db, sessionId: string, running: boolean): SummaryInput | null {
  const s = db.prepare('select ai_title, name from sessions where id = ? and deleted_at is null').get(sessionId) as { ai_title: string | null; name: string | null } | undefined;
  if (!s) return null;
  const total = (db.prepare('select count(*) c from event_index where session_id = ? and parent_agent is null').get(sessionId) as { c: number }).c;
  if (total === 0) return null;
  const events: TranscriptEvent[] = [];
  let from: number | null = 0;
  while (from !== null) {
    const page = readEvents(db, sessionId, { fromSeq: from, limit: 2000, agentId: null });
    events.push(...page.events);
    from = page.nextSeq;
  }
  const turns = (db.prepare('select turns from session_stats where session_id = ?').get(sessionId) as { turns: number } | undefined)?.turns ?? 0;
  const body = compressEvents(events);
  const text = running ? `このセッションは現在も実行中です。\n${body}` : body;
  return { sessionId, text, turns, running, titleHint: s.ai_title ?? s.name };
}

/** 「要約器を試す」に使う決め打ちの入力。DB には書かない。 */
export const CANNED_INPUT: SummaryInput = {
  sessionId: 'canned', turns: 3, running: false, titleHint: null,
  text: [
    '[user] README の導入手順が古いので、Node 22 と npm workspaces 前提に書き直して。',
    '[assistant] 現状の README を読み、setup 節と開発の節を書き直します。',
    '[tool] Read README.md',
    '[tool] Edit README.md',
    '[assistant] 導入手順を Node 22、npm ci、npm run dev の 3 手順にし、pnpm の記述を消しました。CI の節も同じ前提に揃えました。',
    '[user] ありがとう。CONTRIBUTING.md も同じ前提で直しておいて。',
    '[tool] Edit CONTRIBUTING.md',
    '[assistant] CONTRIBUTING.md の開発環境の節を直しました。他に古い記述は見つかりませんでした。',
  ].join('\n'),
};
```

- [ ] **Step 5: テスト**

Run: `npx vitest run packages/server/src/summary`
Expected: PASS（5 件）

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/summary
git commit -m "feat(server): summarizer interface, json schema, prompt and transcript compression"
```

---

### Task 14: LM Studio と Claude の要約器

**Files:**
- Create: `packages/server/src/summary/lmstudio.ts`、`packages/server/src/summary/claude.ts`
- Test: `packages/server/src/summary/lmstudio.test.ts`、`packages/server/src/summary/claude.test.ts`

**Interfaces:**
- Consumes: `Summarizer`、`SummaryInput`、`SUMMARY_SCHEMA`、`SUMMARY_SYSTEM_PROMPT`、`parseSummaryOutput`、`SummarizerError`（Task 13）、`UsageDto`。
- Produces: 「インターフェース一覧」の `LmStudioSummarizer` と `ClaudeHeadlessSummarizer`。
- LM Studio：`available()` は `GET <baseUrl>/v1/models` が 2 秒以内に 200 を返し、`model` が指定されていればその ID が一覧にあるとき真。`summarize()` は `POST <baseUrl>/v1/chat/completions` に `{ model, temperature: 0.2, messages: [system, user], response_format: { type: 'json_schema', json_schema: { name: 'session_summary', strict: true, schema } } }` を送り、`choices[0].message.content` が空なら `SummarizerError('lmstudio', '本文が空')`。`model` が null なら `/v1/models` の先頭を使う。
- Claude：`available()` は `claudeBin` があり、直近 1 時間の呼び出しが `hourlyCap` 未満で、`usage().sevenDay` が null か 80 未満のとき真。`summarize()` は `spawn(claudeBin, [...], input.text, 120_000)` を呼び、標準出力の JSON の `structured_output` を読む。呼び出しの時刻は成功でも失敗でも数える。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/summary/lmstudio.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { CANNED_INPUT } from './input.ts';
import { LmStudioSummarizer } from './lmstudio.ts';
import { SummarizerError } from './types.ts';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const models = { data: [{ id: 'gemma-4-26b' }, { id: 'qwen3-27b' }] };
const completion = (content: string | null) => ({ choices: [{ message: { role: 'assistant', content } }], usage: { completion_tokens: 10 } });
const good = JSON.stringify({ title: 'README の更新', one_liner: 'Node 22 前提に導入手順を直した', body: '本文。', state: 'done', next_steps: ['CONTRIBUTING を見直す'] });

describe('LmStudioSummarizer', () => {
  it('available はモデル一覧で判定し、summarize は json_schema 付きで投げる', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url); calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith('/v1/models')) return ok(models);
      return ok(completion(good));
    }) as unknown as typeof fetch;
    const s = new LmStudioSummarizer({ baseUrl: 'http://127.0.0.1:1234', model: 'gemma-4-26b', fetch: fetchFn });
    expect(s.id).toBe('lmstudio');
    expect(await s.available()).toBe(true);
    expect(await s.listModels()).toEqual(['gemma-4-26b', 'qwen3-27b']);
    const out = await s.summarize(CANNED_INPUT);
    expect(out).toEqual({ title: 'README の更新', oneLiner: 'Node 22 前提に導入手順を直した', body: '本文。', state: 'done', nextSteps: ['CONTRIBUTING を見直す'] });
    const req = calls.at(-1)!;
    expect(req.url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(req.body).toMatchObject({ model: 'gemma-4-26b', temperature: 0.2, response_format: { type: 'json_schema', json_schema: { name: 'session_summary', strict: true } } });
    expect((req.body as { messages: { role: string; content: string }[] }).messages[1]!.content).toBe(CANNED_INPUT.text);
    const none = new LmStudioSummarizer({ baseUrl: 'http://127.0.0.1:1234', model: 'missing', fetch: fetchFn });
    expect(await none.available()).toBe(false);
  });
  it('model が null なら一覧の先頭を使う。本文が空なら失敗。繋がらなければ available は偽', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/models')) return ok(models);
      expect(JSON.parse(String(init!.body)).model).toBe('gemma-4-26b');
      return ok(completion(''));
    }) as unknown as typeof fetch;
    const s = new LmStudioSummarizer({ baseUrl: 'http://127.0.0.1:1234/', model: null, fetch: fetchFn });
    expect(await s.available()).toBe(true);
    await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(SummarizerError);
    await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(/空/);
    const down = new LmStudioSummarizer({ baseUrl: 'http://127.0.0.1:1', model: null, fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    expect(await down.available()).toBe(false);
    expect(await down.listModels()).toEqual([]);
  });
  it('JSON でない本文とスキーマ外の本文は失敗', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => (String(url).endsWith('/v1/models') ? ok(models) : ok(completion('not json')))) as unknown as typeof fetch;
    const s = new LmStudioSummarizer({ baseUrl: 'http://x', model: 'gemma-4-26b', fetch: fetchFn });
    await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(/JSON/);
    const f2 = vi.fn(async () => ok(completion(JSON.stringify({ title: 'x' })))) as unknown as typeof fetch;
    await expect(new LmStudioSummarizer({ baseUrl: 'http://x', model: 'm', fetch: f2 }).summarize(CANNED_INPUT)).rejects.toThrow(/形/);
    const f3 = vi.fn(async () => ok({ error: 'boom' }, 500)) as unknown as typeof fetch;
    await expect(new LmStudioSummarizer({ baseUrl: 'http://x', model: 'm', fetch: f3 }).summarize(CANNED_INPUT)).rejects.toThrow(/500/);
  });
});
```

`packages/server/src/summary/claude.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { UsageDto } from '@agent-hangar/shared';
import { ClaudeHeadlessSummarizer, type SpawnText } from './claude.ts';
import { CANNED_INPUT } from './input.ts';
import { SummarizerError } from './types.ts';

const usage = (sevenDay: number | null): UsageDto => ({ fiveHour: null, sevenDay: sevenDay === null ? null : { usedPercent: sevenDay, resetsAt: null }, updatedAt: 1 });
const good = { type: 'result', structured_output: { title: 'T', one_liner: 'O', body: 'B', state: 'in_progress', next_steps: ['n'] }, result: '{}', total_cost_usd: 0.02 };
const spawnOk: SpawnText = async () => ({ code: 0, stdout: JSON.stringify(good), stderr: 'Enterprise policy warning\n' });

describe('ClaudeHeadlessSummarizer', () => {
  it('claude -p を呼び、structured_output を読む', async () => {
    const spawn = vi.fn(spawnOk);
    const s = new ClaudeHeadlessSummarizer({ claudeBin: '/usr/local/bin/claude', hourlyCap: 20, usage: () => usage(10), spawn });
    expect(s.id).toBe('claude-headless');
    expect(await s.available()).toBe(true);
    const out = await s.summarize(CANNED_INPUT);
    expect(out).toEqual({ title: 'T', oneLiner: 'O', body: 'B', state: 'in_progress', nextSteps: ['n'] });
    const [cmd, args, stdin, timeout] = spawn.mock.calls[0]!;
    expect(cmd).toBe('/usr/local/bin/claude');
    expect(args.slice(0, 6)).toEqual(['-p', '--model', 'haiku', '--output-format', 'json', '--json-schema']);
    expect(JSON.parse(args[6]!)).toMatchObject({ type: 'object', required: expect.arrayContaining(['title']) });
    expect(args).toContain('--no-session-persistence');
    expect(args.slice(-2)).toEqual(['--tools', '']);
    expect(stdin).toBe(CANNED_INPUT.text);
    expect(timeout).toBe(120_000);
    expect(s.callsInLastHour()).toBe(1);
  });
  it('上限、7 日の使用率、claude の不在で available が偽になる', async () => {
    let t = 0;
    const s = new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 2, usage: () => usage(null), spawn: spawnOk, now: () => t });
    await s.summarize(CANNED_INPUT); await s.summarize(CANNED_INPUT);
    expect(await s.available()).toBe(false);
    t = 3_600_001;
    expect(await s.available()).toBe(true);
    expect(await new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(80), spawn: spawnOk }).available()).toBe(false);
    expect(await new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(79.9), spawn: spawnOk }).available()).toBe(true);
    expect(await new ClaudeHeadlessSummarizer({ claudeBin: null, hourlyCap: 20, usage: () => usage(null), spawn: spawnOk }).available()).toBe(false);
  });
  it('終了コードが 0 でない、JSON でない、structured_output が無いときは失敗し、呼び出しは数える', async () => {
    const bad: SpawnText = async () => ({ code: 1, stdout: '', stderr: 'rate limited' });
    const s = new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn: bad });
    await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(/rate limited/);
    expect(s.callsInLastHour()).toBe(1);
    await expect(new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn: async () => ({ code: 0, stdout: 'nope', stderr: '' }) }).summarize(CANNED_INPUT)).rejects.toThrow(SummarizerError);
    await expect(new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn: async () => ({ code: 0, stdout: JSON.stringify({ result: 'x' }), stderr: '' }) }).summarize(CANNED_INPUT)).rejects.toThrow(/structured_output/);
    await expect(new ClaudeHeadlessSummarizer({ claudeBin: null, hourlyCap: 20, usage: () => usage(null), spawn: spawnOk }).summarize(CANNED_INPUT)).rejects.toThrow(/claude/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/summary`
Expected: FAIL

- [ ] **Step 3: LM Studio を書く**

`packages/server/src/summary/lmstudio.ts`：

```ts
import { parseSummaryOutput, SUMMARY_SCHEMA, SUMMARY_SYSTEM_PROMPT, SummarizerError, type Summarizer, type SummaryInput, type SummaryOutput } from './types.ts';

/**
 * LM Studio の OpenAI 互換 API。既定の要約器。
 * 思考モデルは出力上限を思考で使い切って本文が空になることがあるので、空は失敗として扱い、次の要約器へ回す。
 */
export class LmStudioSummarizer implements Summarizer {
  readonly id = 'lmstudio' as const;
  private readonly baseUrl: string;
  private readonly model: string | null;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: { baseUrl: string; model: string | null; fetch?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.model = o.model;
    this.fetchFn = o.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = o.timeoutMs ?? 180_000;
  }

  async listModels(): Promise<string[]> {
    try {
      const r = await this.fetchFn(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return [];
      const j = (await r.json()) as { data?: { id?: unknown }[] };
      return (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    } catch { return []; }
  }

  async available(): Promise<boolean> {
    const models = await this.listModels();
    if (models.length === 0) return false;
    return this.model === null || models.includes(this.model);
  }

  async summarize(input: SummaryInput): Promise<SummaryOutput> {
    const model = this.model ?? (await this.listModels())[0];
    if (!model) throw new SummarizerError(this.id, 'LM Studio にモデルがありません');
    let r: Response;
    try {
      r = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model, temperature: 0.2,
          messages: [{ role: 'system', content: SUMMARY_SYSTEM_PROMPT }, { role: 'user', content: input.text }],
          response_format: { type: 'json_schema', json_schema: { name: 'session_summary', strict: true, schema: SUMMARY_SCHEMA } },
        }),
      });
    } catch (e) { throw new SummarizerError(this.id, `LM Studio に接続できません: ${e instanceof Error ? e.message : String(e)}`); }
    if (!r.ok) throw new SummarizerError(this.id, `LM Studio が ${r.status} を返しました`);
    const j = (await r.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new SummarizerError(this.id, '本文が空でした（思考モデルの可能性があります）');
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new SummarizerError(this.id, '本文が JSON ではありません'); }
    const out = parseSummaryOutput(parsed);
    if (!out) throw new SummarizerError(this.id, '本文がスキーマの形ではありません');
    return out;
  }
}
```

- [ ] **Step 4: Claude を書く**

`packages/server/src/summary/claude.ts`：

```ts
import { spawn } from 'node:child_process';
import type { UsageDto } from '@agent-hangar/shared';
import { parseSummaryOutput, SUMMARY_SCHEMA, SUMMARY_SYSTEM_PROMPT, SummarizerError, type Summarizer, type SummaryInput, type SummaryOutput } from './types.ts';

export type SpawnText = (cmd: string, args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/** 標準入力に本文を流し、標準出力と標準エラーを集めて返す。時間切れは SIGKILL。 */
export const spawnText: SpawnText = (cmd, args, stdin, timeoutMs) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${timeoutMs} ミリ秒で応答がありませんでした`)); }, timeoutMs);
  p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  p.on('error', (e) => { clearTimeout(timer); reject(e); });
  p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  p.stdin.end(stdin);
});

const HOUR_MS = 3_600_000;
const SEVEN_DAY_STOP = 80;

/**
 * claude -p --model haiku のフォールバック。サブスクリプションのレート制限を消費するので、1 時間の件数と 7 日の使用率で止める。
 */
export class ClaudeHeadlessSummarizer implements Summarizer {
  readonly id = 'claude-headless' as const;
  private calls: number[] = [];
  private readonly spawnFn: SpawnText;
  private readonly now: () => number;

  constructor(private readonly o: { claudeBin: string | null; hourlyCap: number; usage: () => UsageDto; spawn?: SpawnText; now?: () => number }) {
    this.spawnFn = o.spawn ?? spawnText;
    this.now = o.now ?? (() => Date.now());
  }

  callsInLastHour(): number {
    const since = this.now() - HOUR_MS;
    this.calls = this.calls.filter((t) => t > since);
    return this.calls.length;
  }

  async available(): Promise<boolean> {
    if (!this.o.claudeBin) return false;
    if (this.callsInLastHour() >= this.o.hourlyCap) return false;
    const seven = this.o.usage().sevenDay;
    return seven === null || seven.usedPercent < SEVEN_DAY_STOP;
  }

  async summarize(input: SummaryInput): Promise<SummaryOutput> {
    if (!this.o.claudeBin) throw new SummarizerError(this.id, 'claude が見つかりません');
    this.calls.push(this.now());
    const args = ['-p', '--model', 'haiku', '--output-format', 'json', '--json-schema', JSON.stringify(SUMMARY_SCHEMA), '--append-system-prompt', SUMMARY_SYSTEM_PROMPT, '--no-session-persistence', '--tools', ''];
    let r: { code: number; stdout: string; stderr: string };
    try { r = await this.spawnFn(this.o.claudeBin, args, input.text, 120_000); }
    catch (e) { throw new SummarizerError(this.id, e instanceof Error ? e.message : String(e)); }
    if (r.code !== 0) throw new SummarizerError(this.id, `claude が ${r.code} で終了しました: ${r.stderr.trim().split('\n').at(-1) ?? ''}`);
    let j: unknown;
    try { j = JSON.parse(r.stdout); } catch { throw new SummarizerError(this.id, '出力が JSON ではありません'); }
    const so = typeof j === 'object' && j !== null ? (j as Record<string, unknown>).structured_output : undefined;
    if (so === undefined) throw new SummarizerError(this.id, '出力に structured_output がありません');
    const out = parseSummaryOutput(so);
    if (!out) throw new SummarizerError(this.id, 'structured_output がスキーマの形ではありません');
    return out;
  }
}
```

- [ ] **Step 5: テスト**

Run: `npx vitest run packages/server/src/summary`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/summary
git commit -m "feat(server): lm studio and claude headless summarizers with empty-body and rate-limit guards"
```

---

### Task 15: 要約ジョブ（契機、直列の待ち行列、保存、配信）

**Files:**
- Create: `packages/server/src/summary/job.ts`
- Test: `packages/server/src/summary/job.test.ts`

**Interfaces:**
- Consumes: `Summarizer`、`buildSummaryInput`、`CANNED_INPUT`、`upsertShared`、`getSession`、`session_summaries`、`session_stats`。
- Produces: 「インターフェース一覧」の `isSummaryStale` と `SummaryJob`。
- `isSummaryStale` は要約が無いか `source = 'baseline'` か `turns - based_on_turns >= 5` のとき真。`enqueue(id, force)` は `force` でなければ `isSummaryStale` とレジストリの不在を確かめ、同じ ID が待ち行列か実行中なら受け付けない。受け付けたら `summary.pending` を配り、順に処理する。処理は `summarizers()` を順に `available()` で選び、`summarize()` が失敗したら次へ。成功したら `session_summaries` に `source = 'post_hoc'`、`source_model = <summarizer.id>`、`based_on_turns = input.turns` で書き、`session.upsert` と `summary.updated` を配る。すべて失敗したら `summary.failed`。
- `test()` は `CANNED_INPUT` を同じ順で試し、DB に書かず結果を返す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/summary/job.test.ts`：

```ts
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { isSummaryStale, SummaryJob } from './job.ts';
import { SummarizerError, type Summarizer, type SummaryInput, type SummaryOutput } from './types.ts';

let dir: string; let db: Db; let alphaId: string;
const sent: ServerEvent[] = [];
const out: SummaryOutput = { title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [] };
function fake(id: Summarizer['id'], o: { available?: boolean; fail?: boolean; delayMs?: number; seen?: SummaryInput[] } = {}): Summarizer {
  return {
    id,
    available: async () => o.available ?? true,
    summarize: async (input) => { o.seen?.push(input); if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs)); if (o.fail) throw new SummarizerError(id, `${id} failed`); return out; },
  };
}
beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:'); sent.length = 0;
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const make = (summarizers: Summarizer[], live: LiveSessionDto[] = []) => new SummaryJob({ db, deviceId: 'd', summarizers: () => summarizers, live: () => live, hub: { broadcast: (e) => sent.push(e) } });

describe('isSummaryStale', () => {
  it('土台のままか 5 ターン以上進んでいれば真', () => {
    expect(isSummaryStale(db, alphaId)).toBe(true);
    upsertShared(db, 'session_summaries', { session_id: alphaId, title: 't', one_liner: 'o', body: 'b', state: 'done', next_steps: '[]', source: 'in_session', source_model: null, based_on_turns: 2 }, 'd', 'session_id');
    expect(isSummaryStale(db, alphaId)).toBe(false);
    db.prepare('update session_stats set turns = 7 where session_id = ?').run(alphaId);
    expect(isSummaryStale(db, alphaId)).toBe(true);
    db.prepare('update session_stats set turns = 6 where session_id = ?').run(alphaId);
    expect(isSummaryStale(db, alphaId)).toBe(false);
    expect(isSummaryStale(db, 'nope')).toBe(false);
  });
});

describe('SummaryJob', () => {
  it('受け付けて pending を配り、要約を post_hoc で書いて配る', async () => {
    const seen: SummaryInput[] = [];
    const job = make([fake('lmstudio', { seen })]);
    expect(job.enqueue(alphaId)).toBe(true);
    expect(job.enqueue(alphaId)).toBe(false);
    expect(job.pending()).toEqual([alphaId]);
    expect(sent[0]).toEqual({ type: 'summary.pending', sessionId: alphaId });
    await job.idle();
    expect(job.pending()).toEqual([]);
    expect(seen[0]).toMatchObject({ sessionId: alphaId, turns: 2, running: false });
    const row = db.prepare('select * from session_summaries where session_id = ?').get(alphaId) as Record<string, unknown>;
    expect(row).toMatchObject({ title: 'T', source: 'post_hoc', source_model: 'lmstudio', based_on_turns: 2 });
    expect(sent.map((e) => e.type)).toEqual(['summary.pending', 'session.upsert', 'summary.updated']);
    expect(job.enqueue(alphaId)).toBe(false);     // もう stale ではない
    expect(job.enqueue(alphaId, true)).toBe(true);
    await job.idle();
  });
  it('使えない要約器を飛ばし、失敗したら次へ。全部だめなら summary.failed', async () => {
    const job = make([fake('lmstudio', { available: false }), fake('claude-headless', { fail: true })]);
    job.enqueue(alphaId);
    await job.idle();
    expect(sent.at(-1)).toEqual({ type: 'summary.failed', sessionId: alphaId, message: 'claude-headless failed' });
    expect((db.prepare('select source from session_summaries where session_id = ?').get(alphaId) as { source: string }).source).toBe('baseline');
    sent.length = 0;
    const job2 = make([fake('lmstudio', { fail: true }), fake('claude-headless')]);
    job2.enqueue(alphaId);
    await job2.idle();
    expect((db.prepare('select source_model from session_summaries where session_id = ?').get(alphaId) as { source_model: string }).source_model).toBe('claude-headless');
  });
  it('実行中のセッションは受け付けず、force なら受け付ける。本文の無いセッションも受け付けない', async () => {
    const live: LiveSessionDto[] = [{ sessionId: SESSION_ALPHA, status: 'busy', name: null, nameSource: null, cwd: '/x', pid: 1 }];
    const job = make([fake('lmstudio')], live);
    expect(job.enqueue(alphaId)).toBe(false);
    expect(job.enqueue(alphaId, true)).toBe(true);
    await job.idle();
    const beta = (db.prepare("select id from sessions where provider_session_id = 'aaaaaaaa-0000-4000-8000-000000000002'").get() as { id: string }).id;
    expect(job.enqueue(beta, true)).toBe(false);
  });
  it('直列に走り、test は DB に書かない', async () => {
    const job = make([fake('lmstudio', { delayMs: 20 })]);
    const beta = (db.prepare("select id from sessions where provider_session_id = 'aaaaaaaa-0000-4000-8000-000000000003'").get() as { id: string }).id;
    job.enqueue(alphaId, true); job.enqueue(beta, true);
    expect(job.pending()).toEqual([alphaId, beta]);
    await job.idle();
    expect(sent.filter((e) => e.type === 'summary.updated').map((e) => (e as { sessionId: string }).sessionId)).toEqual([alphaId, beta]);
    const before = (db.prepare('select count(*) c from changes').get() as { c: number }).c;
    const r = await job.test();
    expect(r).toMatchObject({ ok: true, id: 'lmstudio', summary: { title: 'T', source: 'post_hoc' } });
    expect((db.prepare('select count(*) c from changes').get() as { c: number }).c).toBe(before);
    const bad = await make([fake('lmstudio', { fail: true }), fake('claude-headless', { available: false })]).test();
    expect(bad).toEqual({ ok: false, tried: [{ id: 'lmstudio', message: 'lmstudio failed' }, { id: 'claude-headless', message: '使えません（接続できないか、上限に達しています）' }] });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/summary/job`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/summary/job.ts`：

```ts
import type { LiveSessionDto, ServerEvent, SummarizerTestDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { getSession } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { buildSummaryInput, CANNED_INPUT } from './input.ts';
import type { Summarizer, SummaryInput, SummaryOutput } from './types.ts';

const STALE_TURNS = 5;

/** 要約が土台のままか、最後の更新から 5 ターン以上進んでいれば作り直す。セッションが無ければ偽。 */
export function isSummaryStale(db: Db, sessionId: string): boolean {
  const s = db.prepare('select 1 from sessions where id = ? and deleted_at is null').get(sessionId);
  if (!s) return false;
  const sum = db.prepare('select source, based_on_turns from session_summaries where session_id = ? and deleted_at is null').get(sessionId) as { source: string; based_on_turns: number } | undefined;
  if (!sum || sum.source === 'baseline') return true;
  const turns = (db.prepare('select turns from session_stats where session_id = ?').get(sessionId) as { turns: number } | undefined)?.turns ?? 0;
  return turns - sum.based_on_turns >= STALE_TURNS;
}

export type SummaryJobDeps = { db: Db; deviceId: string; summarizers: () => Summarizer[]; live: () => LiveSessionDto[]; hub: { broadcast(ev: ServerEvent): void }; now?: () => number };

const UNAVAILABLE = '使えません（接続できないか、上限に達しています）';

/**
 * 事後要約の背景ジョブ。1 つずつ直列に走り、UI には「要約を作成中」を出す。
 * 過去の全件を埋めることはせず、契機（run の終了、セッションを開く、手動）で 1 件ずつ受け付ける。
 */
export class SummaryJob {
  private queue: string[] = [];
  private running: string | null = null;
  private waiters: (() => void)[] = [];

  constructor(private readonly deps: SummaryJobDeps) {}

  pending(): string[] { return [...(this.running ? [this.running] : []), ...this.queue]; }

  private isLive(sessionId: string): boolean {
    const s = this.deps.db.prepare('select provider_session_id p from sessions where id = ?').get(sessionId) as { p: string } | undefined;
    return !!s && this.deps.live().some((l) => l.sessionId === s.p);
  }

  /** 受け付けたら true。force でなければ stale とレジストリの不在を確かめる。 */
  enqueue(sessionId: string, force = false): boolean {
    if (this.running === sessionId || this.queue.includes(sessionId)) return false;
    const hasBody = this.deps.db.prepare('select 1 from event_index where session_id = ? and parent_agent is null limit 1').get(sessionId);
    if (!hasBody) return false;
    if (!force && (!isSummaryStale(this.deps.db, sessionId) || this.isLive(sessionId))) return false;
    this.queue.push(sessionId);
    this.deps.hub.broadcast({ type: 'summary.pending', sessionId });
    void this.drain();
    return true;
  }

  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    while (this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.running = id;
      try { await this.summarizeOne(id); }
      catch (e) { this.deps.hub.broadcast({ type: 'summary.failed', sessionId: id, message: e instanceof Error ? e.message : String(e) }); }
      finally { this.running = null; }
    }
    for (const w of this.waiters.splice(0)) w();
  }

  /** 使える要約器を順に試し、最初に成功したものを採る。 */
  private async trySummarizers(input: SummaryInput): Promise<{ id: Summarizer['id']; ms: number; out: SummaryOutput } | { tried: { id: Summarizer['id']; message: string }[] }> {
    const tried: { id: Summarizer['id']; message: string }[] = [];
    for (const s of this.deps.summarizers()) {
      if (!(await s.available())) { tried.push({ id: s.id, message: UNAVAILABLE }); continue; }
      const t = Date.now();
      try { return { id: s.id, ms: Date.now() - t, out: await s.summarize(input) }; }
      catch (e) { tried.push({ id: s.id, message: e instanceof Error ? e.message : String(e) }); }
    }
    return { tried };
  }

  private async summarizeOne(sessionId: string): Promise<void> {
    const input = buildSummaryInput(this.deps.db, sessionId, this.isLive(sessionId));
    if (!input) throw new Error('本文がありません');
    const r = await this.trySummarizers(input);
    if ('tried' in r) throw new Error(r.tried.at(-1)?.message ?? '要約器がありません');
    upsertShared(this.deps.db, 'session_summaries', { session_id: sessionId, title: r.out.title, one_liner: r.out.oneLiner, body: r.out.body, state: r.out.state, next_steps: JSON.stringify(r.out.nextSteps), source: 'post_hoc', source_model: r.id, based_on_turns: input.turns }, this.deps.deviceId, 'session_id');
    const s = getSession(this.deps.db, this.deps.live(), sessionId);
    if (s) this.deps.hub.broadcast({ type: 'session.upsert', session: s });
    this.deps.hub.broadcast({ type: 'summary.updated', sessionId });
  }

  /** Settings の「要約器を試す」。決め打ちの入力を投げ、DB には書かない。 */
  async test(input: SummaryInput = CANNED_INPUT): Promise<SummarizerTestDto> {
    const r = await this.trySummarizers(input);
    if ('tried' in r) return { ok: false, tried: r.tried };
    return { ok: true, id: r.id, ms: r.ms, summary: { title: r.out.title, oneLiner: r.out.oneLiner, body: r.out.body, state: r.out.state, nextSteps: r.out.nextSteps, source: 'post_hoc', sourceModel: r.id, basedOnTurns: input.turns } };
  }
}
```

- [ ] **Step 4: テスト**

Run: `npx vitest run packages/server/src/summary`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/summary
git commit -m "feat(server): background summary job with staleness check, sequential queue and fallback order"
```

---

### Task 16: HTTP の経路の追加、設定の項目、サーバの結線

**Files:**
- Modify: `packages/server/src/config/paths.ts`、`packages/server/src/http/app.ts`、`packages/server/src/server.ts`
- Test: `packages/server/src/http/app.test.ts`（追加）、`packages/server/src/config/paths.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 から Task 15 のすべて。フェーズ 2 の `AppDeps`、`ExternalApi`、`RunsApi`、`toSettingsDto`、`runResult`、`externalResult`、`createMcpApp`、`openInEditor`、`Exec`。
- Produces: 「インターフェース一覧」の `AppDeps` の追加項目、`SummaryApi`、`ExternalApi.openUrl`、`Settings` の 4 項目。
- 追加する経路（すべて `/api` 配下で認証必須）：
  - `POST /api/ingest/statusline`（本文は生の JSON、256KB まで）→ 204。パースできなければ 400。`usageChanged` なら `usage.update` を配り、`providerSessionId` に対応するセッションがあれば `session.upsert` を配る。
  - `GET /api/usage` → `UsageDto`。`GET /api/usage/aggregate?days=30` → `UsageAggregateDto`（`days` は 1 から 365、既定 30）。
  - `GET /api/statusline` → `StatuslineStatusDto`（`settings().claudeDir` を読む）。
  - `GET /api/projects/:id/todos` → `TodoDto[]`。`POST /api/projects/:id/todos { text }` → 201 `TodoDto`。`PATCH /api/todos/:id { done }` → `TodoDto`。`DELETE /api/todos/:id` → `TodoDto`。いずれも `todos.update` と `project.upsert` を配る。
  - `GET /api/projects/:id/memo` → `MemoDto`（無ければ `{ projectId, markdown: '', updatedAt: 0 }`）。`PUT /api/projects/:id/memo { markdown }` → `MemoDto`、`memo.update` と `project.upsert` を配る。
  - `GET /api/artifacts?projectId=&sessionId=` → `ArtifactDto[]`。`POST /api/projects/:id/artifacts { url }` → 201 `ArtifactDto`（不正な URL は 400）、`artifact.upsert` を配る。`POST /api/artifacts/:id/open` → 204（`external.openUrl`）。`POST /api/artifacts/:id/open-editor` → 204（ファイルが無ければ 404）。
  - `PATCH /api/sessions/:id { memo }` → `SessionDto`、`session.upsert` を配る。
  - `POST /api/sessions/:id/promote { name, gitInit, moveFiles }` → 201 `PromoteResultDto`。`PromoteError` は `status` で返す。`project.upsert`（新プロジェクトとスクラッチの両方）と `session.upsert` を配る。
  - `POST /api/sessions/:id/summarize` → 202（受け付けなくても 202。`{ accepted: boolean }` を返す）。
  - `GET /api/summarizer/models` → `{ models: string[] }`。`POST /api/summarizer/test` → `SummarizerTestDto`。
  - `GET /api/sessions/:id/events` は `fromSeq` が 0 か省略で `agentId` が無いとき `summary.enqueue(id)` を呼ぶ（失敗しても応答には影響しない）。
- `GET /api/bootstrap` に `usage`、`todos`、`artifacts`、`summaryPending` を足す。`PATCH /api/settings` は `lmStudioUrl`（`http://` か `https://` で始まる文字列）、`lmStudioModel`（文字列か null）、`summaryFallback`（boolean）、`summaryHourlyCap`（1 以上の整数）を検査する。
- サーバの結線：`UsageTracker`、`MemoStore`（起動時に `reconcileAll` と `watch`）、`ensureScratchProject`、`SummaryJob`（`runs.on({ runEnded })` で `enqueue`）、要約器の列は設定から毎回組み立てる（`summaryFallback` が偽なら LM Studio だけ）、`indexer.on({ sessionChanged })` で `artifactIds` を `artifact.upsert` として配る、`external.openUrl` は `open <url>`。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/config/paths.test.ts` に足す。

```ts
  it('要約器の設定は既定値で埋まる', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-paths-'));
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w' }));
    const s = loadSettings(tmp);
    expect(s).toMatchObject({ workspaceRoot: '/w', lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20 });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
```

`packages/server/src/http/app.test.ts` の `beforeEach` を広げる。`createApp` の呼び出しに次を足す。

```ts
import type { SummarizerTestDto } from '@agent-hangar/shared';
import { MemoStore } from '../projects/memo.ts';
import { PromoteError } from '../projects/promote.ts';
import { UsageTracker } from '../usage/statusline.ts';
import type { SummaryApi } from './app.ts';

let usage: UsageTracker;
let memos: MemoStore;
let summary: SummaryApi & { enqueued: [string, boolean | undefined][] };
const testResult: SummarizerTestDto = { ok: true, id: 'lmstudio', ms: 5, summary: { title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [], source: 'post_hoc', sourceModel: 'lmstudio', basedOnTurns: 3 } };
```

`beforeEach` の中：

```ts
  usage = new UsageTracker(db);
  memos = new MemoStore({ db, deviceId: 'd', home: ws });
  summary = { enqueued: [], enqueue: (id, force) => { summary.enqueued.push([id, force]); return true; }, pending: () => ['pending-1'], test: async () => testResult, listModels: async () => ['gemma'] };
  external = { ...external, openUrl: vi.fn(async () => {}) };
```

`createApp({ ..., usage, memos, summary, promote: (o) => { if (o.name === 'taken') throw new PromoteError(409, 'あります'); return { projectId: list0ProjectId(), moved: o.moveFiles, reason: null }; } })`。
`list0ProjectId` は `beforeEach` で `syncProjectsFromWorkspace` の後に `(db.prepare("select id from projects where name = 'alpha'").get() as { id: string }).id` を取って返す関数にする。
`describe('routes')` に足す。

```ts
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const alphaId = async () => { const { body } = await json(await get('/api/sessions')); return body.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA).id as string; };

  it('statusline の受け口と使用量', async () => {
    const first = { session_id: SESSION_ALPHA, model: { id: 'claude-opus-4-1' }, effort: 'high', context_window: { context_window_size: 200000, current_usage: null } };
    expect((await post('/api/ingest/statusline', first)).status).toBe(204);
    expect(sent.filter((e) => e.type === 'usage.update')).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { providerSessionId: SESSION_ALPHA, stats: { model: 'claude-opus-4-1' } } });
    const second = { ...first, context_window: { context_window_size: 200000, current_usage: { input_tokens: 50000 } }, rate_limits: { five_hour: { used_percentage: 47, resets_at: 1 }, seven_day: { used_percentage: 7, resets_at: 2 } } };
    expect((await post('/api/ingest/statusline', second)).status).toBe(204);
    expect(sent.find((e) => e.type === 'usage.update')).toMatchObject({ usage: { fiveHour: { usedPercent: 47 }, sevenDay: { usedPercent: 7 } } });
    expect((await json(await get('/api/usage'))).body).toMatchObject({ fiveHour: { usedPercent: 47 } });
    expect((await json(await get(`/api/sessions/${await alphaId()}`))).body.stats.contextPercent).toBe(25);
    expect((await app.request('/api/ingest/statusline', { method: 'POST', headers: H, body: 'not json' })).status).toBe(400);
    const agg = await json(await get('/api/usage/aggregate?days=30'));
    expect(agg.status).toBe(200);
    expect(agg.body.projects.length).toBeGreaterThan(0);
    expect((await get('/api/usage/aggregate?days=0')).status).toBe(400);
    expect((await json(await get('/api/statusline'))).body).toEqual({ command: null, scriptPath: null, installed: false });
    expect((await json(await get('/api/bootstrap'))).body).toMatchObject({ usage: { fiveHour: { usedPercent: 47 } }, todos: [], artifacts: [], summaryPending: ['pending-1'] });
  });
  it('TODO とメモ', async () => {
    const pid = list0ProjectId();
    const a = await post(`/api/projects/${pid}/todos`, { text: '最初' });
    expect(a.status).toBe(201);
    const todo = await a.json();
    expect(todo).toMatchObject({ projectId: pid, text: '最初', done: false, position: 1 });
    expect(sent.at(-2)).toMatchObject({ type: 'todos.update', projectId: pid, todos: [{ id: todo.id }] });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: pid, openTodoCount: 1 } });
    expect((await post(`/api/projects/${pid}/todos`, { text: '  ' })).status).toBe(400);
    expect((await post('/api/projects/nope/todos', { text: 'x' })).status).toBe(404);
    expect((await (await post(`/api/todos/${todo.id}`, { done: true }, 'PATCH')).json()).done).toBe(true);
    expect((await post('/api/todos/nope', { done: true }, 'PATCH')).status).toBe(404);
    expect((await json(await get(`/api/projects/${pid}/todos`))).body).toHaveLength(1);
    expect((await app.request(`/api/todos/${todo.id}`, { method: 'DELETE', headers: H })).status).toBe(200);
    expect((await json(await get(`/api/projects/${pid}/todos`))).body).toEqual([]);
    expect((await json(await get(`/api/projects/${pid}/memo`))).body).toEqual({ projectId: pid, markdown: '', updatedAt: 0 });
    const m = await post(`/api/projects/${pid}/memo`, { markdown: '# alpha\n本文' }, 'PUT');
    expect((await m.json()).markdown).toBe('# alpha\n本文');
    expect(sent.at(-2)).toMatchObject({ type: 'memo.update', memo: { projectId: pid } });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { memoHead: '# alpha' } });
    expect(fs.readFileSync(memos.memoPath(pid), 'utf8')).toBe('# alpha\n本文');
    expect((await post(`/api/projects/${pid}/memo`, { markdown: 3 }, 'PUT')).status).toBe(400);
  });
  it('アーティファクト', async () => {
    const pid = list0ProjectId();
    const a = await post(`/api/projects/${pid}/artifacts`, { url: 'https://claude.ai/code/artifact/manual' });
    expect(a.status).toBe(201);
    const art = await a.json();
    expect(sent.at(-1)).toMatchObject({ type: 'artifact.upsert', artifact: { id: art.id } });
    expect((await post(`/api/projects/${pid}/artifacts`, { url: 'https://example.com' })).status).toBe(400);
    expect((await json(await get(`/api/artifacts?projectId=${pid}`))).body).toHaveLength(1);
    expect((await post(`/api/artifacts/${art.id}/open`)).status).toBe(204);
    expect(external.openUrl).toHaveBeenCalledWith('https://claude.ai/code/artifact/manual');
    expect((await post(`/api/artifacts/${art.id}/open-editor`)).status).toBe(404);
    expect((await post('/api/artifacts/nope/open')).status).toBe(404);
  });
  it('セッションのメモ、昇格、要約', async () => {
    const id = await alphaId();
    const r = await post(`/api/sessions/${id}`, { memo: '一行' }, 'PATCH');
    expect((await r.json()).memo).toBe('一行');
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { id, memo: '一行' } });
    expect((await post('/api/sessions/nope', { memo: 'x' }, 'PATCH')).status).toBe(404);
    const p = await post(`/api/sessions/${id}/promote`, { name: 'newp', gitInit: false, moveFiles: true });
    expect(p.status).toBe(201);
    expect(await p.json()).toMatchObject({ moved: true, reason: null, project: { id: list0ProjectId() }, session: { id } });
    expect((await post(`/api/sessions/${id}/promote`, { name: 'taken', gitInit: false, moveFiles: false })).status).toBe(409);
    expect((await post(`/api/sessions/${id}/promote`, { gitInit: false })).status).toBe(400);
    const s = await post(`/api/sessions/${id}/summarize`);
    expect(s.status).toBe(202);
    expect(summary.enqueued).toContainEqual([id, true]);
    await get(`/api/sessions/${id}/events?fromSeq=0`);
    expect(summary.enqueued).toContainEqual([id, undefined]);
    summary.enqueued.length = 0;
    await get(`/api/sessions/${id}/events?fromSeq=5`);
    await get(`/api/sessions/${id}/events?agentId=abc123`);
    expect(summary.enqueued).toEqual([]);
    expect((await json(await get('/api/summarizer/models'))).body).toEqual({ models: ['gemma'] });
    expect((await json(await post('/api/summarizer/test'))).body).toEqual(testResult);
  });
  it('要約器の設定を検査する', async () => {
    const patch = (body: unknown) => post('/api/settings', body, 'PATCH');
    expect(await (await patch({ lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5 })).json()).toMatchObject({ lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5 });
    expect((await patch({ lmStudioUrl: 'ftp://x' })).status).toBe(400);
    expect((await patch({ summaryHourlyCap: 0 })).status).toBe(400);
    expect((await patch({ summaryFallback: 'yes' })).status).toBe(400);
    expect((await (await patch({ lmStudioModel: null })).json()).lmStudioModel).toBeNull();
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/http packages/server/src/config`
Expected: FAIL

- [ ] **Step 3: 設定の項目を足す**

`packages/server/src/config/paths.ts` の `Settings` と `defaultSettings` を置き換える。

```ts
export type Settings = {
  workspaceRoot: string;
  claudeDir: string;
  tmuxPath: string | null;
  terminalApp: TerminalApp;
  codePath: string | null;
  /**
   * ツールのパスを一度探したかどうか。二度目からは、利用者が空にした null をそのまま尊重する。
   * この項目が無い古い settings.json は、まだ探していないものとして扱う。
   */
  toolsResolved?: boolean;
  lmStudioUrl: string;
  lmStudioModel: string | null;
  summaryFallback: boolean;
  summaryHourlyCap: number;
};

function defaultSettings(): Settings {
  return { workspaceRoot: path.join(os.homedir(), 'workspace'), claudeDir: defaultClaudeDir(), tmuxPath: null, terminalApp: 'terminal', codePath: null, toolsResolved: false, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20 };
}
```

- [ ] **Step 4: app.ts に経路を足す**

`packages/server/src/http/app.ts` の import に足す。

```ts
import type { ArtifactDto, MemoDto, PromoteResultDto, SummarizerTestDto, UsageDto } from '@agent-hangar/shared';
import { addManualArtifact, getArtifact, listArtifacts } from '../artifacts/queries.ts';
import { statuslineStatus } from '../config/statusline.ts';
import type { MemoStore } from '../projects/memo.ts';
import { PromoteError } from '../projects/promote.ts';
import { addTodo, listTodos, removeTodo, setTodoDone } from '../projects/todos.ts';
import { aggregateUsage } from '../usage/aggregate.ts';
```

`ExternalApi` に `openUrl(url: string): Promise<void>;` を足し、`AppDeps` に足す。

```ts
export type SummaryApi = { enqueue(sessionId: string, force?: boolean): boolean; pending(): string[]; test(): Promise<SummarizerTestDto>; listModels(): Promise<string[]> };
export type AppDeps = {
  ...フェーズ 2 の項目...;
  usage: { current(): UsageDto; ingest(raw: unknown): { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null } | null };
  memos: MemoStore;
  summary: SummaryApi;
  promote: (o: { sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }) => { projectId: string; moved: boolean; reason: string | null };
};
```

`toSettingsDto` を置き換える。

```ts
export function toSettingsDto(s: Settings): SettingsDto {
  return { workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir, tmuxPath: s.tmuxPath, terminalApp: s.terminalApp, codePath: s.codePath, lmStudioUrl: s.lmStudioUrl, lmStudioModel: s.lmStudioModel, summaryFallback: s.summaryFallback, summaryHourlyCap: s.summaryHourlyCap };
}
```

`createApp` の中に補助を置く。

```ts
  const broadcastProject = (id: string) => { const p = getProject(db, deviceId, deps.live(), id); if (p) deps.hub.broadcast({ type: 'project.upsert', project: p }); };
  const broadcastSession = (id: string) => { const s = getSession(db, deps.live(), id); if (s) deps.hub.broadcast({ type: 'session.upsert', session: s }); };
  const requireProject = (id: string) => getProject(db, deviceId, deps.live(), id);
```

`bootstrap` の本文に `usage: deps.usage.current(), todos: listTodos(db), artifacts: listArtifacts(db), summaryPending: deps.summary.pending()` を足す。

`GET /sessions/:id/events` を次に置き換える。

```ts
  api.get('/sessions/:id/events', (c) => {
    const q = c.req.query();
    const id = c.req.param('id');
    // セッションを開いたとき（先頭ページ、主線）に事後要約の契機を与える。受け付けの可否は応答に影響しない。
    if ((q.fromSeq === undefined || q.fromSeq === '0') && !q.agentId) { try { deps.summary.enqueue(id); } catch { /* 要約の失敗で本文の読み出しを止めない */ } }
    try {
      return c.json(readEvents(db, id, { fromSeq: numberOr(q.fromSeq), limit: numberOr(q.limit), agentId: q.agentId || null }));
    } catch (e) {
      // 索引はあるのに本文ファイルが消えている場合だけ 404 にし、他は 500 に任せる。
      if (isEnoent(e)) return c.json({ error: 'このセッションの本文ファイルが見つかりません。Settings の「索引を作り直す」を試してください' }, 404);
      throw e;
    }
  });
```

`PATCH /settings` の検査に足す（`for (const k of ['tmuxPath', 'codePath'] ...)` の後）。

```ts
    if (patch.lmStudioUrl !== undefined) { if (typeof patch.lmStudioUrl !== 'string' || !/^https?:\/\//.test(patch.lmStudioUrl)) return c.json({ error: 'lmStudioUrl は http か https の URL' }, 400); clean.lmStudioUrl = patch.lmStudioUrl.replace(/\/+$/, ''); }
    if (patch.lmStudioModel !== undefined) { if (patch.lmStudioModel !== null && typeof patch.lmStudioModel !== 'string') return c.json({ error: 'lmStudioModel は文字列か null' }, 400); clean.lmStudioModel = (patch.lmStudioModel as string | null) || null; }
    if (patch.summaryFallback !== undefined) { if (typeof patch.summaryFallback !== 'boolean') return c.json({ error: 'summaryFallback は boolean' }, 400); clean.summaryFallback = patch.summaryFallback; }
    if (patch.summaryHourlyCap !== undefined) { if (typeof patch.summaryHourlyCap !== 'number' || !Number.isInteger(patch.summaryHourlyCap) || patch.summaryHourlyCap < 1) return c.json({ error: 'summaryHourlyCap は 1 以上の整数' }, 400); clean.summaryHourlyCap = patch.summaryHourlyCap; }
```

`app.route('/api', api);` の前に経路を足す。

```ts
  // 使用量。statusline スクリプトが curl で送る。他の /api と同じ Bearer 認証を通す。
  api.post('/ingest/statusline', async (c) => {
    const text = await c.req.text();
    if (text.length > 256 * 1024) return c.json({ error: 'too large' }, 413);
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return c.json({ error: 'JSON ではありません' }, 400); }
    const r = deps.usage.ingest(raw);
    if (!r) return c.json({ error: 'payload の形が違います' }, 400);
    if (r.usageChanged) deps.hub.broadcast({ type: 'usage.update', usage: r.usage });
    if (r.providerSessionId) {
      const s = db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(r.providerSessionId) as { id: string } | undefined;
      if (s) broadcastSession(s.id);
    }
    return c.body(null, 204);
  });
  api.get('/usage', (c) => c.json(deps.usage.current()));
  api.get('/usage/aggregate', (c) => {
    const days = c.req.query('days') === undefined ? 30 : Number(c.req.query('days'));
    if (!Number.isInteger(days) || days < 1 || days > 365) return c.json({ error: 'days は 1 から 365' }, 400);
    return c.json(aggregateUsage(db, { days }));
  });
  api.get('/statusline', (c) => c.json(statuslineStatus(deps.settings().claudeDir)));

  // TODO。変更のたびに一覧とプロジェクト（未完の数）を配る。
  const todosChanged = (projectId: string) => { deps.hub.broadcast({ type: 'todos.update', projectId, todos: listTodos(db, projectId) }); broadcastProject(projectId); };
  api.get('/projects/:id/todos', (c) => (requireProject(c.req.param('id')) ? c.json(listTodos(db, c.req.param('id'))) : c.json({ error: 'not found' }, 404)));
  api.post('/projects/:id/todos', async (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) return c.json({ error: 'text は必須です' }, 400);
    const t = addTodo(db, deviceId, { projectId: id, text: body.text });
    todosChanged(id);
    return c.json(t, 201);
  });
  api.patch('/todos/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { done?: unknown };
    if (typeof body.done !== 'boolean') return c.json({ error: 'done は boolean' }, 400);
    const t = setTodoDone(db, deviceId, c.req.param('id'), body.done);
    if (!t) return c.json({ error: 'not found' }, 404);
    todosChanged(t.projectId);
    return c.json(t);
  });
  api.delete('/todos/:id', (c) => {
    const t = removeTodo(db, deviceId, c.req.param('id'));
    if (!t) return c.json({ error: 'not found' }, 404);
    todosChanged(t.projectId);
    return c.json(t);
  });

  // メモ。DB とファイルの両方に書き、ファイルの外部編集は MemoStore の監視が配る。
  api.get('/projects/:id/memo', (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: 'not found' }, 404);
    const m: MemoDto = deps.memos.read(id) ?? { projectId: id, markdown: '', updatedAt: 0 };
    return c.json(m);
  });
  api.put('/projects/:id/memo', async (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { markdown?: unknown };
    if (typeof body.markdown !== 'string') return c.json({ error: 'markdown は文字列' }, 400);
    const m = deps.memos.write(id, body.markdown);
    deps.hub.broadcast({ type: 'memo.update', memo: m });
    broadcastProject(id);
    return c.json(m);
  });

  // アーティファクト。
  api.get('/artifacts', (c) => c.json(listArtifacts(db, { projectId: c.req.query('projectId') || undefined, sessionId: c.req.query('sessionId') || undefined })));
  api.post('/projects/:id/artifacts', async (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    if (typeof body.url !== 'string') return c.json({ error: 'url は必須です' }, 400);
    let a: ArtifactDto;
    try { a = addManualArtifact(db, deviceId, id, body.url); } catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
    deps.hub.broadcast({ type: 'artifact.upsert', artifact: a });
    return c.json(a, 201);
  });
  api.post('/artifacts/:id/open', (c) => {
    const a = getArtifact(db, c.req.param('id'));
    if (!a) return c.json({ error: 'not found' }, 404);
    return externalResult(c, () => deps.external.openUrl(a.url), true);
  });
  api.post('/artifacts/:id/open-editor', (c) => {
    const a = getArtifact(db, c.req.param('id'));
    if (!a) return c.json({ error: 'not found' }, 404);
    if (!a.filePath || !a.fileExists) return c.json({ error: '元ファイルがありません' }, 404);
    return externalResult(c, () => deps.external.openEditor({ target: a.filePath! }), true);
  });

  // セッションの 1 行メモ、昇格、事後要約。
  api.patch('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const row = db.prepare('select * from sessions where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { memo?: unknown };
    if (typeof body.memo !== 'string') return c.json({ error: 'memo は文字列' }, 400);
    upsertShared(db, 'sessions', { ...row, memo: body.memo.trim() || null }, deviceId);
    const s = getSession(db, deps.live(), id)!;
    deps.hub.broadcast({ type: 'session.upsert', session: s });
    return c.json(s);
  });
  api.post('/sessions/:id/promote', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; gitInit?: unknown; moveFiles?: unknown };
    if (typeof body.name !== 'string') return c.json({ error: 'name は必須です' }, 400);
    const before = getSession(db, deps.live(), id);
    if (!before) return c.json({ error: 'not found' }, 404);
    try {
      const r = deps.promote({ sessionId: id, name: body.name, gitInit: body.gitInit === true, moveFiles: body.moveFiles === true });
      const project = getProject(db, deviceId, deps.live(), r.projectId)!;
      const session = getSession(db, deps.live(), id)!;
      deps.hub.broadcast({ type: 'project.upsert', project });
      if (before.projectId) broadcastProject(before.projectId);
      deps.hub.broadcast({ type: 'session.upsert', session });
      const out: PromoteResultDto = { project, session, moved: r.moved, reason: r.reason };
      return c.json(out, 201);
    } catch (e) {
      if (e instanceof PromoteError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  api.post('/sessions/:id/summarize', (c) => {
    const id = c.req.param('id');
    if (!getSession(db, deps.live(), id)) return c.json({ error: 'not found' }, 404);
    return c.json({ accepted: deps.summary.enqueue(id, true) }, 202);
  });
  api.get('/summarizer/models', async (c) => c.json({ models: await deps.summary.listModels() }));
  api.post('/summarizer/test', async (c) => c.json(await deps.summary.test()));
```

`createMcpApp` の呼び出しに `usage: () => deps.usage.current(), memos: deps.memos` を足す。

- [ ] **Step 5: server.ts を結線する**

`packages/server/src/server.ts` に import を足す。

```ts
import { execFile } from 'node:child_process';
import { listArtifacts } from './artifacts/queries.ts';
import { MemoStore } from './projects/memo.ts';
import { promoteSession } from './projects/promote.ts';
import { ensureScratchProject } from './projects/scratch.ts';
import { aliveRunForSession } from './runs/queries.ts';
import { ClaudeHeadlessSummarizer } from './summary/claude.ts';
import { SummaryJob } from './summary/job.ts';
import { LmStudioSummarizer } from './summary/lmstudio.ts';
import type { Summarizer } from './summary/types.ts';
import { UsageTracker } from './usage/statusline.ts';
import { which } from './config/tools.ts';
```

`const runs = new RunManager(...)` の後に足す。

```ts
  const usage = new UsageTracker(db);
  const memos = new MemoStore({ db, deviceId: device.id, home });
  const claudeBin = process.env.HANGAR_CLAUDE_BIN ?? which('claude');
  // Claude への切り替えの件数はプロセスの寿命で数えるので、要約器はここで 1 度だけ作り、設定の変更は列の組み立てで反映する。
  const claudeSummarizer = () => new ClaudeHeadlessSummarizer({ claudeBin, hourlyCap: settings.summaryHourlyCap, usage: () => usage.current() });
  let claude = claudeSummarizer();
  const summarizers = (): Summarizer[] => {
    const list: Summarizer[] = [new LmStudioSummarizer({ baseUrl: settings.lmStudioUrl, model: settings.lmStudioModel })];
    if (settings.summaryFallback) list.push(claude);
    return list;
  };
  const summary = new SummaryJob({ db, deviceId: device.id, summarizers, live: () => registry.current(), hub });
```

`indexer.on({ sessionChanged })` を次に置き換える。

```ts
    sessionChanged: (e) => {
      // 起動後に現れたセッションは project_id が空のままなので、ここで紐づけてから配る（フェーズ 2 のまま）。
      const row = db.prepare('select project_id from sessions where id = ?').get(e.sessionId) as { project_id: string | null } | undefined;
      const assigned = row && row.project_id === null ? assignSession(db, device.id, e.sessionId) : null;
      const s = getSession(db, registry.current(), e.sessionId);
      if (!s) return;
      hub.broadcast({ type: 'session.upsert', session: s });
      if (assigned) {
        const p = getProject(db, device.id, registry.current(), assigned);
        if (p) hub.broadcast({ type: 'project.upsert', project: p });
      }
      if (e.appended > 0) hub.broadcast({ type: 'transcript.appended', sessionId: e.sessionId, count: e.appended });
      // フェーズ 3 の追加分。索引化が拾ったアーティファクトを配る。
      for (const a of listArtifacts(db, { ids: e.artifactIds })) hub.broadcast({ type: 'artifact.upsert', artifact: a });
    },
```

`runs.on({...})` の `runEnded` を次に置き換える。

```ts
    runEnded: (run) => { hub.broadcast({ type: 'run.ended', run }); summary.enqueue(run.sessionId); },
```

`external` に足す。

```ts
    openUrl: (url) => new Promise<void>((resolve, reject) => execFile('open', [url], (err) => (err ? reject(err) : resolve()))),
```

`createApp` の呼び出しに `usage, memos, summary: { enqueue: (id, force) => summary.enqueue(id, force), pending: () => summary.pending(), test: () => summary.test(), listModels: () => new LmStudioSummarizer({ baseUrl: settings.lmStudioUrl, model: null }).listModels() }, promote: (o) => promoteSession({ db, deviceId: device.id, home, workspaceRoot: settings.workspaceRoot, runAlive: (id) => aliveRunForSession(db, id) !== null || (() => { const s = db.prepare('select provider_session_id p from sessions where id = ?').get(id) as { p: string } | undefined; return !!s && registry.current().some((l) => l.sessionId === s.p); })() }, o)` を足す。
`updateSettings` の中で、`summaryHourlyCap` が変わったときに `claude = claudeSummarizer();` を呼ぶ（`if (patch.summaryHourlyCap !== undefined) claude = claudeSummarizer();`）。

`syncProjectsFromWorkspace(...)` の後に足す。

```ts
  ensureScratchProject(db, device.id, home);
  for (const m of memos.reconcileAll()) hub.broadcast({ type: 'memo.update', memo: m });
  const stopMemoWatch = memos.watch((m) => { hub.broadcast({ type: 'memo.update', memo: m }); const p = listProjects(db, device.id, registry.current()).find((x) => x.id === m.projectId); if (p) hub.broadcast({ type: 'project.upsert', project: p }); });
```

`close` の中で `stopMemoWatch();` を呼ぶ。`VERSION` は `'0.3.0'` にする。

- [ ] **Step 6: テスト、型検査、実物のサーバ起動**

Run: `npx vitest run packages/server && npx tsc -p packages/server --noEmit`
Expected: PASS

Run: `HANGAR_HOME=/tmp/hangar-p3 HANGAR_PORT=4199 npx tsx packages/server/src/main.ts & sleep 8; T=$(cat /tmp/hangar-p3/token); curl -s -H "Authorization: Bearer $T" http://127.0.0.1:4199/api/usage; echo; curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"session_id":"x","rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1}}}' http://127.0.0.1:4199/api/ingest/statusline; curl -s -H "Authorization: Bearer $T" http://127.0.0.1:4199/api/usage; echo; ls /tmp/hangar-p3; kill %1; rm -rf /tmp/hangar-p3`
Expected: 最初の `usage` は `{"fiveHour":null,...}`、`ingest` は `204`、次の `usage` は `fiveHour.usedPercent` が 12。`/tmp/hangar-p3` に `scratch` と `projects` のディレクトリができている。

- [ ] **Step 7: コミット**

```bash
git add packages/server/src
git commit -m "feat(server): statusline ingest, usage, todo, memo, artifact, promote and summarizer routes wired into the server"
```

---

### Task 17: UI のストアと API クライアントの拡張

**Files:**
- Modify: `packages/ui/src/store/store.ts`、`packages/ui/src/runtime/api.ts`
- Test: `packages/ui/src/store/store.test.ts`（追加）、`packages/ui/src/runtime/api.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 の `UsageDto`、`UsageAggregateDto`、`StatuslineStatusDto`、`TodoDto`、`MemoDto`、`ArtifactDto`、`PromoteResultDto`、`SummarizerTestDto`、`BootstrapDto`。フェーズ 2 の `Store`（`runs`、`tabs`、`applyLaunch`、`aliveRunOf`、`currentRunOf`、`tabsOf`）と `ApiClient`。
- Produces:
  ```ts
  // store/store.ts
  export type Store = { ...フェーズ 2...; usage: UsageDto; todos: Record<string, TodoDto>; memos: Record<string, MemoDto>; artifacts: Record<string, ArtifactDto>; summaryPending: Record<string, true>; usageAggregate: UsageAggregateDto | null; statusline: StatuslineStatusDto | null; summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null };
  export function todosOf(store: Store, projectId: string): TodoDto[];                                 // position 昇順
  export function artifactsOf(store: Store, opts: { projectId?: string; sessionId?: string }): ArtifactDto[];   // lastPublishedAt 降順
  // runtime/api.ts（ApiClient に追加）
  usage(): Promise<UsageDto>;
  usageAggregate(days: number): Promise<UsageAggregateDto>;
  statusline(): Promise<StatuslineStatusDto>;
  addTodo(projectId: string, text: string): Promise<TodoDto>;
  setTodoDone(id: string, done: boolean): Promise<TodoDto>;
  removeTodo(id: string): Promise<TodoDto>;
  memo(projectId: string): Promise<MemoDto>;
  saveMemo(projectId: string, markdown: string): Promise<MemoDto>;
  setSessionMemo(sessionId: string, memo: string): Promise<SessionDto>;
  addArtifact(projectId: string, url: string): Promise<ArtifactDto>;
  openArtifact(id: string): Promise<void>;
  openArtifactEditor(id: string): Promise<void>;
  promote(sessionId: string, body: { name: string; gitInit: boolean; moveFiles: boolean }): Promise<PromoteResultDto>;
  regenerateSummary(sessionId: string): Promise<void>;
  summarizerModels(): Promise<{ models: string[] }>;
  testSummarizer(): Promise<SummarizerTestDto>;
  ```
- `applyServerEvent` の追加分：`usage.update` は `usage` を差し替える。`todos.update` はそのプロジェクトの TODO を一覧で置き換える（消えた項目は落ちる）。`memo.update` は `memos[projectId]`。`artifact.upsert` は `artifacts[id]`。`summary.pending` は `summaryPending[sessionId] = true`。`summary.updated` と `summary.failed` はその鍵を落とす（本文の差し替えは `session.upsert` が行う）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/store/store.test.ts` に足す。

```ts
import type { ArtifactDto, MemoDto, TodoDto } from '@agent-hangar/shared';
import { artifactsOf, todosOf } from './store.ts';

const todo = (id: string, projectId: string, position: number, done = false): TodoDto => ({ id, projectId, text: id, done, position, sessionId: null, updatedAt: 1 });
const art = (id: string, projectId: string | null, last: number, sessionIds: string[] = ['s1']): ArtifactDto => ({ id, projectId, url: `https://claude.ai/code/artifact/${id}`, title: id, description: null, favicon: '📊', filePath: null, fileExists: false, firstPublishedAt: 1, lastPublishedAt: last, versionCount: 1, sessionIds });

describe('フェーズ 3 のストア', () => {
  it('bootstrap は使用量と TODO とアーティファクトと要約の待ちを入れる', () => {
    const s = applyBootstrap(initialStore(), { ...boot, usage: { fiveHour: { usedPercent: 47, resetsAt: null }, sevenDay: null, updatedAt: 9 }, todos: [todo('t2', 'p1', 2), todo('t1', 'p1', 1)], artifacts: [art('a1', 'p1', 5)], summaryPending: ['s1'] });
    expect(s.usage.fiveHour?.usedPercent).toBe(47);
    expect(todosOf(s, 'p1').map((t) => t.id)).toEqual(['t1', 't2']);
    expect(artifactsOf(s, { projectId: 'p1' }).map((a) => a.id)).toEqual(['a1']);
    expect(s.summaryPending).toEqual({ s1: true });
  });
  it('todos.update はそのプロジェクトだけを置き換える', () => {
    let s = applyBootstrap(initialStore(), { ...boot, todos: [todo('t1', 'p1', 1), todo('t2', 'p1', 2), todo('t9', 'p2', 1)] });
    s = applyServerEvent(s, { type: 'todos.update', projectId: 'p1', todos: [todo('t2', 'p1', 2, true)] });
    expect(todosOf(s, 'p1').map((t) => [t.id, t.done])).toEqual([['t2', true]]);
    expect(todosOf(s, 'p2').map((t) => t.id)).toEqual(['t9']);
  });
  it('usage、memo、artifact、要約の待ちのイベントを取り込む', () => {
    let s = applyBootstrap(initialStore(), boot);
    s = applyServerEvent(s, { type: 'usage.update', usage: { fiveHour: null, sevenDay: { usedPercent: 7, resetsAt: 2 }, updatedAt: 3 } });
    expect(s.usage.sevenDay?.usedPercent).toBe(7);
    const memo: MemoDto = { projectId: 'p1', markdown: '# m', updatedAt: 4 };
    s = applyServerEvent(s, { type: 'memo.update', memo });
    expect(s.memos.p1).toEqual(memo);
    s = applyServerEvent(s, { type: 'artifact.upsert', artifact: art('a1', 'p1', 5) });
    s = applyServerEvent(s, { type: 'artifact.upsert', artifact: art('a2', 'p1', 9) });
    s = applyServerEvent(s, { type: 'artifact.upsert', artifact: art('a3', 'p2', 7, ['s2']) });
    expect(artifactsOf(s, { projectId: 'p1' }).map((a) => a.id)).toEqual(['a2', 'a1']);
    expect(artifactsOf(s, { sessionId: 's2' }).map((a) => a.id)).toEqual(['a3']);
    expect(artifactsOf(s, {}).map((a) => a.id)).toEqual(['a2', 'a3', 'a1']);
    s = applyServerEvent(s, { type: 'summary.pending', sessionId: 's1' });
    expect(s.summaryPending.s1).toBe(true);
    s = applyServerEvent(s, { type: 'summary.updated', sessionId: 's1' });
    expect(s.summaryPending.s1).toBeUndefined();
    s = applyServerEvent(s, { type: 'summary.pending', sessionId: 's1' });
    s = applyServerEvent(s, { type: 'summary.failed', sessionId: 's1', message: 'x' });
    expect(s.summaryPending.s1).toBeUndefined();
  });
});
```

`packages/ui/src/runtime/api.test.ts` に足す。

```ts
describe('フェーズ 3 の経路', () => {
  it('経路とメソッドと本文が合っている', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const api = createApi(fetchFn);
    await api.usage();
    await api.usageAggregate(30);
    await api.statusline();
    await api.addTodo('p1', '買う');
    await api.setTodoDone('t1', true);
    await api.removeTodo('t1');
    await api.memo('p1');
    await api.saveMemo('p1', '# m');
    await api.setSessionMemo('s1', '一行');
    await api.addArtifact('p1', 'https://claude.ai/code/artifact/x');
    await api.promote('s1', { name: 'n', gitInit: true, moveFiles: false });
    await api.summarizerModels();
    await api.testSummarizer();
    expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /api/usage', 'GET /api/usage/aggregate?days=30', 'GET /api/statusline',
      'POST /api/projects/p1/todos', 'PATCH /api/todos/t1', 'DELETE /api/todos/t1',
      'GET /api/projects/p1/memo', 'PUT /api/projects/p1/memo', 'PATCH /api/sessions/s1',
      'POST /api/projects/p1/artifacts', 'POST /api/sessions/s1/promote',
      'GET /api/summarizer/models', 'POST /api/summarizer/test',
    ]);
    expect(JSON.parse(String(calls[3]!.init!.body))).toEqual({ text: '買う' });
    expect(JSON.parse(String(calls[10]!.init!.body))).toEqual({ name: 'n', gitInit: true, moveFiles: false });
  });
  it('204 を返す経路は undefined を返す', async () => {
    const fetchFn = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const api = createApi(fetchFn);
    await expect(api.openArtifact('a1')).resolves.toBeUndefined();
    await expect(api.openArtifactEditor('a1')).resolves.toBeUndefined();
    await expect(api.regenerateSummary('s1')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/store packages/ui/src/runtime/api`
Expected: FAIL（`todosOf` が無い、`api.usage` が無い）

- [ ] **Step 3: ストアを広げる**

`packages/ui/src/store/store.ts` の import に足す。

```ts
import type { ArtifactDto, MemoDto, StatuslineStatusDto, SummarizerTestDto, TodoDto, UsageAggregateDto, UsageDto } from '@agent-hangar/shared';
```

`Store` と `initialStore` を置き換える（フェーズ 2 までの項目はそのまま残す）。

```ts
export type Store = {
  bootstrapped: boolean; version: string; device: { id: string; name: string } | null; settings: SettingsDto | null;
  projects: Record<string, ProjectDto>; sessions: Record<string, SessionDto>; live: LiveSessionDto[];
  events: Record<string, EventsSlice>; subagents: Record<string, string[]>;
  search: { params: SearchParamsDto | null; result: SearchResultDto | null; loading: boolean };
  index: IndexProgressDto;
  runs: Record<string, RunDto>; tabs: Record<string, TabDto>;
  usage: UsageDto; todos: Record<string, TodoDto>; memos: Record<string, MemoDto>; artifacts: Record<string, ArtifactDto>;
  summaryPending: Record<string, true>;
  // 設定画面に入ったときだけ読む値。未取得は null で、View は「読み込んでいます」を出す。
  usageAggregate: UsageAggregateDto | null; statusline: StatuslineStatusDto | null; summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null;
};

export const emptyUsage = (): UsageDto => ({ fiveHour: null, sevenDay: null, updatedAt: null });

export function initialStore(): Store {
  return {
    bootstrapped: false, version: '', device: null, settings: null, projects: {}, sessions: {}, live: [], events: {}, subagents: {},
    search: { params: null, result: null, loading: false }, index: { phase: 'idle', done: 0, total: 0 }, runs: {}, tabs: {},
    usage: emptyUsage(), todos: {}, memos: {}, artifacts: {}, summaryPending: {},
    usageAggregate: null, statusline: null, summarizerModels: null, summarizerTest: null,
  };
}
```

`applyBootstrap` の返り値に足す。

```ts
    usage: b.usage, todos: byId(b.todos), artifacts: byId(b.artifacts), summaryPending: Object.fromEntries(b.summaryPending.map((id) => [id, true as const])),
```

`applyServerEvent` の `switch` に足す（`default` の直前）。

```ts
    case 'usage.update': return { ...store, usage: ev.usage };
    case 'todos.update': {
      // そのプロジェクトの TODO を一覧で置き換える。消えた項目は落ちる。
      const todos: Record<string, TodoDto> = {};
      for (const [id, t] of Object.entries(store.todos)) if (t.projectId !== ev.projectId) todos[id] = t;
      for (const t of ev.todos) todos[t.id] = t;
      return { ...store, todos };
    }
    case 'memo.update': return { ...store, memos: { ...store.memos, [ev.memo.projectId]: ev.memo } };
    case 'artifact.upsert': return { ...store, artifacts: { ...store.artifacts, [ev.artifact.id]: ev.artifact } };
    case 'summary.pending': return { ...store, summaryPending: { ...store.summaryPending, [ev.sessionId]: true } };
    case 'summary.updated': case 'summary.failed': {
      if (!store.summaryPending[ev.sessionId]) return store;
      const { [ev.sessionId]: _drop, ...rest } = store.summaryPending;
      return { ...store, summaryPending: rest };
    }
```

末尾に選択の補助を足す。

```ts
/** プロジェクトの TODO を position の昇順で返す。完了した項目も同じ並びに残す。 */
export function todosOf(store: Store, projectId: string): TodoDto[] {
  return Object.values(store.todos).filter((t) => t.projectId === projectId).sort((a, b) => a.position - b.position);
}

/** アーティファクトを最終公開の新しい順で返す。projectId と sessionId は与えられたものだけで絞る。 */
export function artifactsOf(store: Store, opts: { projectId?: string; sessionId?: string }): ArtifactDto[] {
  return Object.values(store.artifacts)
    .filter((a) => (opts.projectId === undefined || a.projectId === opts.projectId) && (opts.sessionId === undefined || a.sessionIds.includes(opts.sessionId)))
    .sort((a, b) => b.lastPublishedAt - a.lastPublishedAt);
}
```

- [ ] **Step 4: API クライアントを広げる**

`packages/ui/src/runtime/api.ts` の import と `ApiClient` に足す。

```ts
import type { ArtifactDto, MemoDto, PromoteResultDto, SessionDto, StatuslineStatusDto, SummarizerTestDto, TodoDto, UsageAggregateDto, UsageDto } from '@agent-hangar/shared';
```

```ts
  usage(): Promise<UsageDto>;
  usageAggregate(days: number): Promise<UsageAggregateDto>;
  statusline(): Promise<StatuslineStatusDto>;
  addTodo(projectId: string, text: string): Promise<TodoDto>;
  setTodoDone(id: string, done: boolean): Promise<TodoDto>;
  removeTodo(id: string): Promise<TodoDto>;
  memo(projectId: string): Promise<MemoDto>;
  saveMemo(projectId: string, markdown: string): Promise<MemoDto>;
  setSessionMemo(sessionId: string, memo: string): Promise<SessionDto>;
  addArtifact(projectId: string, url: string): Promise<ArtifactDto>;
  openArtifact(id: string): Promise<void>;
  openArtifactEditor(id: string): Promise<void>;
  promote(sessionId: string, body: { name: string; gitInit: boolean; moveFiles: boolean }): Promise<PromoteResultDto>;
  regenerateSummary(sessionId: string): Promise<void>;
  summarizerModels(): Promise<{ models: string[] }>;
  testSummarizer(): Promise<SummarizerTestDto>;
```

`createApi` の返り値に足す。

```ts
    usage: () => call('/api/usage'),
    usageAggregate: (days) => call(`/api/usage/aggregate${qs({ days })}`),
    statusline: () => call('/api/statusline'),
    addTodo: (projectId, text) => call(`/api/projects/${projectId}/todos`, { method: 'POST', body: JSON.stringify({ text }) }),
    setTodoDone: (id, done) => call(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }),
    removeTodo: (id) => call(`/api/todos/${id}`, { method: 'DELETE' }),
    memo: (projectId) => call(`/api/projects/${projectId}/memo`),
    saveMemo: (projectId, markdown) => call(`/api/projects/${projectId}/memo`, { method: 'PUT', body: JSON.stringify({ markdown }) }),
    setSessionMemo: (sessionId, memo) => call(`/api/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify({ memo }) }),
    addArtifact: (projectId, url) => call(`/api/projects/${projectId}/artifacts`, { method: 'POST', body: JSON.stringify({ url }) }),
    openArtifact: (id) => call(`/api/artifacts/${id}/open`, { method: 'POST' }),
    openArtifactEditor: (id) => call(`/api/artifacts/${id}/open-editor`, { method: 'POST' }),
    promote: (sessionId, body) => call(`/api/sessions/${sessionId}/promote`, { method: 'POST', body: JSON.stringify(body) }),
    regenerateSummary: (sessionId) => call(`/api/sessions/${sessionId}/summarize`, { method: 'POST' }),
    summarizerModels: () => call('/api/summarizer/models'),
    testSummarizer: () => call('/api/summarizer/test', { method: 'POST' }),
```

- [ ] **Step 5: テスト補助を広げる**

`packages/ui/src/test/fakeApi.ts` の `fakeApiExtras()` に、フェーズ 3 の 16 の関数を足す。

```ts
import type { ApiClient } from '../runtime/api.ts';
import { vi } from 'vitest';

/** フェーズ 2 とフェーズ 3 で増えた ApiClient の関数を、何もしない偽物で埋める。 */
export function fakeApiExtras(): Partial<ApiClient> {
  return {
    ...フェーズ 2 の項目...,
    usage: vi.fn(async () => ({ fiveHour: null, sevenDay: null, updatedAt: null })),
    usageAggregate: vi.fn(async () => ({ days: [], projects: [] })),
    statusline: vi.fn(async () => ({ command: null, scriptPath: null, installed: false })),
    addTodo: vi.fn(async (projectId: string, text: string) => ({ id: 't1', projectId, text, done: false, position: 1, sessionId: null, updatedAt: 1 })),
    setTodoDone: vi.fn(async (id: string, done: boolean) => ({ id, projectId: 'p1', text: 'x', done, position: 1, sessionId: null, updatedAt: 1 })),
    removeTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1 })),
    memo: vi.fn(async (projectId: string) => ({ projectId, markdown: '', updatedAt: 0 })),
    saveMemo: vi.fn(async (projectId: string, markdown: string) => ({ projectId, markdown, updatedAt: 2 })),
    setSessionMemo: vi.fn(),
    addArtifact: vi.fn(),
    openArtifact: vi.fn(async () => {}),
    openArtifactEditor: vi.fn(async () => {}),
    promote: vi.fn(),
    regenerateSummary: vi.fn(async () => {}),
    summarizerModels: vi.fn(async () => ({ models: ['gemma'] })),
    testSummarizer: vi.fn(async () => ({ ok: false as const, tried: [] })),
  };
}
```

`packages/ui/src/store/store.test.ts` と `packages/ui/src/runtime/runtime.test.ts` と `packages/ui/src/Root.test.tsx` の `boot` に、Task 1 で足した 4 項目（`usage`、`todos`、`artifacts`、`summaryPending`）が入っていることを確かめる。

- [ ] **Step 6: テストと型検査**

Run: `npx vitest run packages/ui/src/store packages/ui/src/runtime && npx tsc -p packages/ui --noEmit`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add packages/ui/src
git commit -m "feat(ui): store slices and api client methods for usage, todos, memos, artifacts and summaries"
```

---

### Task 18: Mediator（promote 領域、workbench 領域、分割、パレットの実行、NOT_YET の整理）

**Files:**
- Create: `packages/ui/src/mediator/promote.ts`、`packages/ui/src/mediator/workbench.ts`
- Modify: `packages/shared/src/intent.ts`、`packages/ui/src/mediator/types.ts`、`packages/ui/src/mediator/sessionView.ts`、`packages/ui/src/mediator/screen.ts`、`packages/ui/src/mediator/launch.ts`、`packages/ui/src/mediator/transition.ts`
- Test: `packages/ui/src/mediator/transition.test.ts`（追加と 1 箇所の修正）、`packages/shared/src/api.test.ts`（1 行の追加）

Task 1 で足し忘れた Intent を 1 つここで足す。
アーティファクトのカードの「VS Code で開く」に対応する Intent が設計文書の一覧に無く、`api.openArtifactEditor` の効果だけがあるためである。

**Interfaces:**
- Consumes: Task 1 の `Intent`（`session.promote.submit` の `gitInit`、`split.resize`、`summarizer.test`）と `ServerEvent`（`summary.pending`、`summary.updated`、`summary.failed`）。フェーズ 2 の `launchStep`、`liveStep`、`LaunchState`、`SessionViewState`、`Overlay`。
- Produces:
  ```ts
  // mediator/types.ts
  export type RuntimeEvent = ...フェーズ 2... | { type: 'promote.done'; projectId: string; moved: boolean; reason: string | null } | { type: 'promote.failed'; message: string } | { type: 'split.resolved'; sessionId: string; tabId: string | null };
  export type Effect = ...フェーズ 2...
    | { kind: 'api.addTodo'; projectId: string; text: string } | { kind: 'api.toggleTodo'; id: string } | { kind: 'api.removeTodo'; id: string }
    | { kind: 'api.loadMemo'; projectId: string } | { kind: 'api.saveMemo'; projectId: string; markdown: string } | { kind: 'api.setSessionMemo'; sessionId: string; text: string }
    | { kind: 'api.openArtifact'; id: string } | { kind: 'api.openArtifactEditor'; id: string } | { kind: 'api.addArtifact'; projectId: string; url: string }
    | { kind: 'api.promote'; sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }
    | { kind: 'api.regenerateSummary'; sessionId: string }
    | { kind: 'api.loadSettingsExtras' } | { kind: 'api.testSummarizer' }
    | { kind: 'split.resolve'; sessionId: string }
    | { kind: 'focus'; target: FocusTarget };   // FocusTarget = 'search' | 'newSessionName' | 'terminal' | 'palette' | 'promoteName' | 'todoInput'
  export type Overlay = ...フェーズ 2... | { kind: 'newSession'; projectId: string | null; scratch: boolean } | { kind: 'promote'; sessionId: string } | { kind: 'promoted'; projectId: string; moved: boolean; reason: string | null };
  export type SessionViewState = { agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; summaryOpen: boolean; selectedTab: string | null; transcriptOpen: boolean; split: boolean; splitTab: string | null };
  export type State = { ...フェーズ 2...; promote: LaunchState; summaryFailed: Record<string, string> };
  // mediator/promote.ts
  export function promoteStep(state: State, input: Input): Step | null;
  // mediator/workbench.ts
  export function workbenchStep(state: State, input: Input): Step | null;
  ```
- 主要な遷移：

| 現在 | 入力 | 次 | 効果 |
| --- | --- | --- | --- |
| 任意 | `session.promote.open(id)` | `overlay: promote(id)`、`promote: idle` | `focus(promoteName)` |
| `promote: idle` | `session.promote.submit` | `promote: submitting` | `api.promote` |
| `promote: idle` | `session.promote.submit`（名前が空か `/` を含む） | `promote: failed(msg)` | なし |
| `promote: submitting` | `session.promote.submit` | 変化なし | なし（二重送信を防ぐ） |
| `promote: submitting` | `runtime promote.done` | `overlay: promoted`、`promote: idle` | なし |
| `promote: submitting` | `runtime promote.failed(msg)` | `promote: failed(msg)` | `toast(error)` |
| `overlay: promote` または `promoted` | `overlay.close` | `overlay: none`、`promote: idle` | なし |
| 任意 | `todo.add` / `todo.toggle` / `todo.remove` | 変化なし | 対応する `api.*`。`todo.add` は `focus(todoInput)` も出す |
| 任意 | `memo.save` | 変化なし | `api.saveMemo` |
| 任意 | `session.setMemo` | 変化なし | `api.setSessionMemo` |
| 任意 | `artifact.open` / `artifact.openEditor` / `artifact.add` | 変化なし | `api.openArtifact` / `api.openArtifactEditor` / `api.addArtifact` |
| 任意 | `summary.regenerate(id)` | 変化なし | `api.regenerateSummary` |
| 任意 | `summarizer.test` | 変化なし | `api.testSummarizer` |
| 任意 | `split.resize` | 変化なし | なし（`SplitPane` の中で処理済み。ここへ来ても無視する） |
| `overlay: palette` | `palette.run(cmd)` | `overlay: none`（`cmd:new-session` と `cmd:new-scratch` は `newSession`） | 項目ごとの `navigate` か `api.*` |
| `session(id)`、`split: false` | `split.toggle` | 変化なし | `split.resolve(id)` |
| `session(id)`、`split: true` | `split.toggle` | `split: false`、`splitTab: null` | `storage.save` |
| 任意 | `runtime split.resolved(id, tabId)` | `split: true`、`splitTab: tabId` | `storage.save` |
| 任意 | `runtime split.resolved(id, null)` | 変化なし | `toast('分割にはタブが 2 つ必要です')` |
| 任意 | `server summary.pending(id)` / `summary.updated(id)` | `summaryFailed` から `id` を落とす | なし |
| 任意 | `server summary.failed(id, msg)` | `summaryFailed[id] = msg` | なし |
| `hash.changed(project(id))` | | `screen = project(id)` | `api.loadMemo(id)` |
| `hash.changed(settings)` | | `screen = settings` | `api.loadSettingsExtras` |

- `split.toggle` は Intent に `sessionId` を持たないので、`state.screen` が `session` のときだけ効く。
- パレットの選択位置と入力欄の文字は Mediator に置かない。どちらもダイアログの中で閉じた操作で、`presentPalette` が `query` を引数で受け取る設計に合わせる。
- `transition` は純関数のままで、ストアを見ない。分割の右のタブは `split.resolve` の効果を受けたランタイムがストアから決め、`split.resolved` で返す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/mediator/transition.test.ts` の「次のフェーズの操作はトーストで知らせる」を次に置き換える。

```ts
  it('次のフェーズの操作はトーストで知らせる', () => {
    const { state, effects } = run([intent({ type: 'sync.now' }), intent({ type: 'session.takeover', id: 's1', force: false })]);
    expect(effects).toEqual([{ kind: 'toast', level: 'info', message: 'この操作は次のフェーズで実装します' }, { kind: 'toast', level: 'info', message: 'この操作は次のフェーズで実装します' }]);
    expect(state).toEqual(initialState());
  });
```

次の `describe` を足す。

```ts
describe('昇格', () => {
  it('ダイアログを開き、送信して完了ダイアログに移る', () => {
    const a = run([intent({ type: 'session.promote.open', id: 's1' })]);
    expect(a.state.overlay).toEqual({ kind: 'promote', sessionId: 's1' });
    expect(a.effects).toEqual([{ kind: 'focus', target: 'promoteName' }]);
    const b = run([intent({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: true, moveFiles: true })], a.state);
    expect(b.state.promote).toEqual({ kind: 'submitting' });
    expect(b.effects).toEqual([{ kind: 'api.promote', sessionId: 's1', name: 'newp', gitInit: true, moveFiles: true }]);
    const dup = run([intent({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: true, moveFiles: true })], b.state);
    expect(dup.effects).toEqual([]);
    const c = run([runtime({ type: 'promote.done', projectId: 'p9', moved: true, reason: null })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'promoted', projectId: 'p9', moved: true, reason: null });
    expect(c.state.promote).toEqual({ kind: 'idle' });
    const d = run([intent({ type: 'overlay.close' })], c.state);
    expect(d.state.overlay).toEqual({ kind: 'none' });
  });
  it('名前を検査し、失敗はダイアログに残す', () => {
    const open = run([intent({ type: 'session.promote.open', id: 's1' })]).state;
    const bad = run([intent({ type: 'session.promote.submit', id: 's1', name: 'a/b', gitInit: false, moveFiles: false })], open);
    expect(bad.state.promote).toEqual({ kind: 'failed', message: '名前に / は使えません' });
    expect(bad.effects).toEqual([]);
    const empty = run([intent({ type: 'session.promote.submit', id: 's1', name: '  ', gitInit: false, moveFiles: false })], open);
    expect(empty.state.promote).toEqual({ kind: 'failed', message: '名前を入力してください' });
    const sent = run([intent({ type: 'session.promote.submit', id: 's1', name: 'ok', gitInit: false, moveFiles: false })], open);
    const failed = run([runtime({ type: 'promote.failed', message: '同じ名前があります' })], sent.state);
    expect(failed.state.promote).toEqual({ kind: 'failed', message: '同じ名前があります' });
    expect(failed.state.overlay).toEqual({ kind: 'promote', sessionId: 's1' });
    expect(failed.effects).toEqual([{ kind: 'toast', level: 'error', message: '同じ名前があります' }]);
  });
});

describe('作業台の操作', () => {
  it('TODO とメモとアーティファクトと要約は api 効果になる', () => {
    const r = run([
      intent({ type: 'todo.add', projectId: 'p1', text: '買う' }),
      intent({ type: 'todo.toggle', id: 't1' }),
      intent({ type: 'todo.remove', id: 't1' }),
      intent({ type: 'memo.save', projectId: 'p1', markdown: '# m' }),
      intent({ type: 'session.setMemo', id: 's1', text: '一行' }),
      intent({ type: 'artifact.open', id: 'a1' }),
      intent({ type: 'artifact.openEditor', id: 'a1' }),
      intent({ type: 'artifact.add', projectId: 'p1', url: 'https://claude.ai/code/artifact/x' }),
      intent({ type: 'summary.regenerate', sessionId: 's1' }),
      intent({ type: 'summarizer.test' }),
    ]);
    expect(r.effects).toEqual([
      { kind: 'api.addTodo', projectId: 'p1', text: '買う' }, { kind: 'focus', target: 'todoInput' },
      { kind: 'api.toggleTodo', id: 't1' }, { kind: 'api.removeTodo', id: 't1' },
      { kind: 'api.saveMemo', projectId: 'p1', markdown: '# m' },
      { kind: 'api.setSessionMemo', sessionId: 's1', text: '一行' },
      { kind: 'api.openArtifact', id: 'a1' },
      { kind: 'api.openArtifactEditor', id: 'a1' },
      { kind: 'api.addArtifact', projectId: 'p1', url: 'https://claude.ai/code/artifact/x' },
      { kind: 'api.regenerateSummary', sessionId: 's1' },
      { kind: 'api.testSummarizer' },
    ]);
    expect(r.state).toEqual(initialState());
  });
  it('空の TODO と空の URL は何もしない', () => {
    const r = run([intent({ type: 'todo.add', projectId: 'p1', text: '   ' }), intent({ type: 'artifact.add', projectId: 'p1', url: ' ' })]);
    expect(r.effects).toEqual([]);
  });
  it('split.resize は中間層で処理済みなので無視する', () => {
    const r = run([intent({ type: 'split.resize', ratio: 0.3 })]);
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(initialState());
  });
  it('要約の失敗は画面に残し、次の pending で消える', () => {
    const a = run([server({ type: 'summary.failed', sessionId: 's1', message: 'LM Studio に繋がりません' })]);
    expect(a.state.summaryFailed).toEqual({ s1: 'LM Studio に繋がりません' });
    const b = run([server({ type: 'summary.pending', sessionId: 's1' })], a.state);
    expect(b.state.summaryFailed).toEqual({});
    const c = run([server({ type: 'summary.failed', sessionId: 's1', message: 'x' }), server({ type: 'summary.updated', sessionId: 's1' })]);
    expect(c.state.summaryFailed).toEqual({});
  });
});

describe('パレット', () => {
  const opened = () => run([intent({ type: 'palette.open' })]).state;
  it('コマンドを実行して閉じる', () => {
    const a = run([intent({ type: 'palette.run', command: { id: 'cmd:new-scratch', label: 'スクラッチで始める' } })], opened());
    expect(a.state.overlay).toEqual({ kind: 'newSession', projectId: null, scratch: true });
    expect(a.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }]);
    const b = run([intent({ type: 'palette.run', command: { id: 'cmd:settings', label: '設定' } })], opened());
    expect(b.state.overlay).toEqual({ kind: 'none' });
    expect(b.effects).toEqual([{ kind: 'navigate', route: { name: 'settings' } }]);
    const c = run([intent({ type: 'palette.run', command: { id: 'cmd:rebuild-index', label: '索引を作り直す' } })], opened());
    expect(c.effects).toEqual([{ kind: 'api.rebuildIndex' }]);
    const d = run([intent({ type: 'palette.run', command: { id: 'project:p1', label: 'alpha' } })], opened());
    expect(d.effects).toEqual([{ kind: 'navigate', route: { name: 'project', id: 'p1' } }]);
    const e = run([intent({ type: 'palette.run', command: { id: 'session:s1', label: 'x' } })], opened());
    expect(e.effects).toEqual([{ kind: 'navigate', route: { name: 'session', id: 's1' } }]);
    const f = run([intent({ type: 'palette.run', command: { id: 'nope', label: '' } })], opened());
    expect(f.state.overlay).toEqual({ kind: 'none' });
    expect(f.effects).toEqual([]);
  });
});

describe('分割', () => {
  it('開くときはランタイムに右のタブを決めさせ、閉じるときはその場で消す', () => {
    const on = onSession('s1');
    const a = run([intent({ type: 'split.toggle' })], on);
    expect(a.effects).toEqual([{ kind: 'split.resolve', sessionId: 's1' }]);
    expect(a.state.sessionView.s1?.split).toBeFalsy();
    const b = run([runtime({ type: 'split.resolved', sessionId: 's1', tabId: 't2' })], a.state);
    expect(b.state.sessionView.s1).toMatchObject({ split: true, splitTab: 't2' });
    expect(b.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: b.state.sessionView.s1 }]);
    const c = run([intent({ type: 'split.toggle' })], b.state);
    expect(c.state.sessionView.s1).toMatchObject({ split: false, splitTab: null });
    expect(c.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: c.state.sessionView.s1 }]);
  });
  it('タブが 1 つしか無ければトーストを出す', () => {
    const a = run([intent({ type: 'split.toggle' })], onSession('s1'));
    const b = run([runtime({ type: 'split.resolved', sessionId: 's1', tabId: null })], a.state);
    expect(b.state.sessionView.s1?.split).toBeFalsy();
    expect(b.effects).toEqual([{ kind: 'toast', level: 'info', message: '分割にはタブが 2 つ必要です' }]);
  });
  it('分割中に右のタブを選ぶと左右が入れ替わる', () => {
    let s = run([intent({ type: 'tab.select', tabId: 't1' })], onSession('s1')).state;
    s = run([intent({ type: 'split.toggle' })], s).state;
    s = run([runtime({ type: 'split.resolved', sessionId: 's1', tabId: 't2' })], s).state;
    const r = run([intent({ type: 'tab.select', tabId: 't2' })], s);
    expect(r.state.sessionView.s1).toMatchObject({ selectedTab: 't2', splitTab: 't1' });
  });
  it('セッション画面にいないときの split.toggle は何もしない', () => {
    const r = run([intent({ type: 'split.toggle' })]);
    expect(r.effects).toEqual([]);
  });
});

describe('画面に入るときの読み込み', () => {
  it('プロジェクト画面はメモを、設定画面は付属の値を読む', () => {
    const p = run([runtime({ type: 'hash.changed', route: { name: 'project', id: 'p1' } })]);
    expect(p.effects).toEqual([{ kind: 'api.loadMemo', projectId: 'p1' }]);
    const s = run([runtime({ type: 'hash.changed', route: { name: 'settings' } })]);
    expect(s.effects).toEqual([{ kind: 'api.loadSettingsExtras' }]);
  });
});
```

`server` の補助がまだ無ければ、ファイルの先頭の補助に足す。

```ts
const server = (event: ServerEvent): Input => ({ kind: 'server', event });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/mediator`
Expected: FAIL

- [ ] **Step 3: shared に `artifact.openEditor` を足す**

`packages/shared/src/intent.ts` の `artifact.open` の行を置き換える。

```ts
  | { type: 'artifact.open'; id: ArtifactId } | { type: 'artifact.openEditor'; id: ArtifactId } | { type: 'artifact.add'; projectId: ProjectId; url: string }
```

`packages/shared/src/api.test.ts` の「Intent に gitInit、split.resize、summarizer.test がある」の配列に `{ type: 'artifact.openEditor', id: 'a1' }` を足し、期待を `toHaveLength(4)` にする。

- [ ] **Step 4: types.ts を広げる**

`packages/ui/src/mediator/types.ts` の `RuntimeEvent`、`FocusTarget`、`Effect`、`Overlay`、`SessionViewState`、`State` を置き換える。

```ts
export type RuntimeEvent =
  | { type: 'ws.open' } | { type: 'ws.close' } | { type: 'hash.changed'; route: Route }
  | { type: 'api.failed'; message: string } | { type: 'search.done'; params: SearchParamsDto }
  | { type: 'launch.done'; sessionId: string; runId: string } | { type: 'launch.failed'; message: string }
  | { type: 'promote.done'; projectId: string; moved: boolean; reason: string | null }
  | { type: 'promote.failed'; message: string }
  // 分割の右に置くタブはストアを見ないと決まらないので、ランタイムが決めて返す。
  | { type: 'split.resolved'; sessionId: string; tabId: string | null };
```

`FocusTarget` を広げる（`Effect` の `focus` の行は `target: FocusTarget` のままでよい）。

```ts
export type FocusTarget = 'search' | 'newSessionName' | 'terminal' | 'palette' | 'promoteName' | 'todoInput';
```

`Effect` の末尾に足す。

```ts
  | { kind: 'api.addTodo'; projectId: string; text: string }
  | { kind: 'api.toggleTodo'; id: string }
  | { kind: 'api.removeTodo'; id: string }
  | { kind: 'api.loadMemo'; projectId: string }
  | { kind: 'api.saveMemo'; projectId: string; markdown: string }
  | { kind: 'api.setSessionMemo'; sessionId: string; text: string }
  | { kind: 'api.openArtifact'; id: string }
  | { kind: 'api.openArtifactEditor'; id: string }
  | { kind: 'api.addArtifact'; projectId: string; url: string }
  | { kind: 'api.promote'; sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }
  | { kind: 'api.regenerateSummary'; sessionId: string }
  | { kind: 'api.loadSettingsExtras' }
  | { kind: 'api.testSummarizer' }
  | { kind: 'split.resolve'; sessionId: string };
```

```ts
export type Overlay =
  | { kind: 'none' } | { kind: 'resolveProject'; projectId: string } | { kind: 'palette' } | { kind: 'notYet'; feature: string }
  | { kind: 'newSession'; projectId: string | null; scratch: boolean }
  | { kind: 'promote'; sessionId: string }
  | { kind: 'promoted'; projectId: string; moved: boolean; reason: string | null };
export type SessionViewState = { agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; summaryOpen: boolean; selectedTab: string | null; transcriptOpen: boolean; split: boolean; splitTab: string | null };
export type State = {
  screen: Screen; overlay: Overlay; connection: 'connecting' | 'connected' | 'disconnected'; reconnectAttempt: number;
  sessionView: Record<string, SessionViewState>; search: { text: string; filter: SearchFilter };
  toasts: Toast[]; unresolvedQueue: string[]; nextToastId: number;
  launch: LaunchState; waitingSeen: string[];
  promote: LaunchState;
  // 事後要約に失敗したセッション。ヘッダーの要約の横に 1 度だけ出す。
  summaryFailed: Record<string, string>;
  /** 直前に受け取った索引の段階。走査が終わった瞬間を見つけるために持つ（フェーズ 2 のまま）。 */
  indexPhase: IndexProgressDto['phase'];
};
```

- [ ] **Step 5: promote 領域を作る**

`packages/ui/src/mediator/promote.ts`：

```ts
import type { Input, State, Step } from './types.ts';

function nameError(name: string): string | null {
  const t = name.trim();
  if (!t) return '名前を入力してください';
  if (t.includes('/')) return '名前に / は使えません';
  return null;
}

/** promote 領域：スクラッチのセッションをプロジェクトへ昇格するダイアログ。 */
export function promoteStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type === 'promote.done') return { state: { ...state, overlay: { kind: 'promoted', projectId: e.projectId, moved: e.moved, reason: e.reason }, promote: { kind: 'idle' } }, effects: [] };
    if (e.type === 'promote.failed') return { state: { ...state, promote: { kind: 'failed', message: e.message } }, effects: [{ kind: 'toast', level: 'error', message: e.message }] };
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  if (i.type === 'session.promote.open') return { state: { ...state, overlay: { kind: 'promote', sessionId: i.id }, promote: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'promoteName' }] };
  if (i.type === 'session.promote.submit') {
    // 送信中の二重送信は捨てる。
    if (state.promote.kind === 'submitting') return { state, effects: [] };
    const err = nameError(i.name);
    if (err) return { state: { ...state, promote: { kind: 'failed', message: err } }, effects: [] };
    return { state: { ...state, promote: { kind: 'submitting' } }, effects: [{ kind: 'api.promote', sessionId: i.id, name: i.name.trim(), gitInit: i.gitInit, moveFiles: i.moveFiles }] };
  }
  if (i.type === 'overlay.close' && (state.overlay.kind === 'promote' || state.overlay.kind === 'promoted')) {
    return { state: { ...state, overlay: { kind: 'none' }, promote: { kind: 'idle' } }, effects: [] };
  }
  return null;
}
```

- [ ] **Step 6: workbench 領域を作る**

`packages/ui/src/mediator/workbench.ts`：

```ts
import type { PaletteCommand } from '@agent-hangar/shared';
import type { Input, State, Step } from './types.ts';

/** `cmd:new-session` のような項目 ID を種類と残りに割る。 */
function splitId(id: string): [string, string] {
  const at = id.indexOf(':');
  return at < 0 ? [id, ''] : [id.slice(0, at), id.slice(at + 1)];
}

function paletteRun(state: State, command: PaletteCommand): Step {
  const closed: State = { ...state, overlay: { kind: 'none' } };
  const [kind, rest] = splitId(command.id);
  if (kind === 'project') return { state: closed, effects: [{ kind: 'navigate', route: { name: 'project', id: rest } }] };
  if (kind === 'session') return { state: closed, effects: [{ kind: 'navigate', route: { name: 'session', id: rest } }] };
  if (kind === 'cmd') {
    switch (rest) {
      case 'new-session': return { state: { ...closed, overlay: { kind: 'newSession', projectId: null, scratch: false }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
      case 'new-scratch': return { state: { ...closed, overlay: { kind: 'newSession', projectId: null, scratch: true }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
      case 'settings': return { state: closed, effects: [{ kind: 'navigate', route: { name: 'settings' } }] };
      case 'rebuild-index': return { state: closed, effects: [{ kind: 'api.rebuildIndex' }] };
    }
  }
  return { state: closed, effects: [] };
}

/** workbench 領域：TODO、メモ、アーティファクト、事後要約、パレットの実行。状態はほとんど持たない。 */
export function workbenchStep(state: State, input: Input): Step | null {
  if (input.kind === 'server') {
    const e = input.event;
    if (e.type === 'summary.failed') return { state: { ...state, summaryFailed: { ...state.summaryFailed, [e.sessionId]: e.message } }, effects: [] };
    if (e.type === 'summary.pending' || e.type === 'summary.updated') {
      if (!state.summaryFailed[e.sessionId]) return { state, effects: [] };
      const { [e.sessionId]: _drop, ...rest } = state.summaryFailed;
      return { state: { ...state, summaryFailed: rest }, effects: [] };
    }
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    // 追加した後も入力欄に居座らせて、続けて書けるようにする。
    case 'todo.add': return i.text.trim() ? { state, effects: [{ kind: 'api.addTodo', projectId: i.projectId, text: i.text.trim() }, { kind: 'focus', target: 'todoInput' }] } : { state, effects: [] };
    case 'todo.toggle': return { state, effects: [{ kind: 'api.toggleTodo', id: i.id }] };
    case 'todo.remove': return { state, effects: [{ kind: 'api.removeTodo', id: i.id }] };
    case 'memo.save': return { state, effects: [{ kind: 'api.saveMemo', projectId: i.projectId, markdown: i.markdown }] };
    case 'session.setMemo': return { state, effects: [{ kind: 'api.setSessionMemo', sessionId: i.id, text: i.text }] };
    case 'artifact.open': return { state, effects: [{ kind: 'api.openArtifact', id: i.id }] };
    case 'artifact.openEditor': return { state, effects: [{ kind: 'api.openArtifactEditor', id: i.id }] };
    case 'artifact.add': return i.url.trim() ? { state, effects: [{ kind: 'api.addArtifact', projectId: i.projectId, url: i.url.trim() }] } : { state, effects: [] };
    case 'summary.regenerate': return { state, effects: [{ kind: 'api.regenerateSummary', sessionId: i.sessionId }] };
    case 'summarizer.test': return { state, effects: [{ kind: 'api.testSummarizer' }] };
    // 幅の変更は SplitPane の IntentBoundary が処理する。ここへ来るのは境界の外で発行されたときだけで、無視してよい。
    case 'split.resize': return { state, effects: [] };
    case 'palette.run': return paletteRun(state, i.command);
    default: return null;
  }
}
```

- [ ] **Step 7: sessionView と screen と launch を直す**

`packages/ui/src/mediator/sessionView.ts` の `defaultSessionView` を置き換える。

```ts
export function defaultSessionView(): SessionViewState {
  return { agentId: null, showThinking: false, showRaw: false, follow: true, summaryOpen: false, selectedTab: null, transcriptOpen: true, split: false, splitTab: null };
}
```

`sessionViewStep` の `if (input.kind === 'server') { ... }` の塊の後、`if (input.kind !== 'intent') return null;` の前に足す。

```ts
  if (input.kind === 'runtime' && input.event.type === 'split.resolved') {
    const e = input.event;
    // ランタイムが右に置けるタブを見つけられなかったときだけトーストにする。
    if (!e.tabId) return { state, effects: [{ kind: 'toast', level: 'info', message: '分割にはタブが 2 つ必要です' }] };
    return patch(state, e.sessionId, { split: true, splitTab: e.tabId });
  }
```

`switch` に足す。

```ts
    case 'split.toggle': {
      if (state.screen.name !== 'session') return { state, effects: [] };
      const id = state.screen.id;
      const cur = state.sessionView[id] ?? defaultSessionView();
      if (cur.split) return patch(state, id, { split: false, splitTab: null });
      return { state, effects: [{ kind: 'split.resolve', sessionId: id }] };
    }
```

`packages/ui/src/mediator/screen.ts` の `hash.changed` の分岐に足す（`if (route.name === 'session') ...` の後）。

```ts
    if (route.name === 'project') effects.push({ kind: 'api.loadMemo', projectId: route.id });
    if (route.name === 'settings') effects.push({ kind: 'api.loadSettingsExtras' });
```

`packages/ui/src/mediator/launch.ts` の `session.new.open` の分岐を置き換える。

```ts
    case 'session.new.open':
      // スクラッチはプロジェクトを選ばずに開く。ダイアログ側でプロジェクトの選択欄を隠す。
      return { state: { ...state, overlay: { kind: 'newSession', projectId: i.projectId ?? null, scratch: i.scratch === true }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
```

`session.new.submit` の検査を置き換える。

```ts
    case 'session.new.submit': {
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      if (!i.params.projectId && !i.params.scratch) return { state: { ...state, launch: { kind: 'failed', message: 'プロジェクトを選んでください' } }, effects: [] };
      return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.launch', params: i.params }] };
    }
```

`tab.select` の分岐を置き換える。

```ts
    case 'tab.select': {
      if (state.screen.name !== 'session') return { state, effects: [] };
      const id = state.screen.id;
      const cur = state.sessionView[id] ?? defaultSessionView();
      // 分割中に右のタブを選んだら左右を入れ替える。そうでなければ左を差し替える。
      const next: SessionViewState = cur.split && cur.splitTab === i.tabId && cur.selectedTab
        ? { ...cur, selectedTab: i.tabId, splitTab: cur.selectedTab }
        : { ...cur, selectedTab: i.tabId };
      return { state: { ...state, sessionView: { ...state.sessionView, [id]: next } }, effects: [{ kind: 'storage.save', key: `sv:${id}`, value: next }, { kind: 'terminal.connect', sessionId: id, tabId: i.tabId }, { kind: 'focus', target: 'terminal' }] };
    }
```

`launch.ts` の import に `defaultSessionView` と `SessionViewState` を足す。

- [ ] **Step 8: transition を組み直す**

`packages/ui/src/mediator/transition.ts` の import と `initialState` と領域の並びと `NOT_YET_INTENTS` を置き換える。

```ts
import { connectionStep } from './connection.ts';
import { launchStep } from './launch.ts';
import { liveStep } from './live.ts';
import { overlayStep } from './overlay.ts';
import { promoteStep } from './promote.ts';
import { screenStep } from './screen.ts';
import { sessionViewStep } from './sessionView.ts';
import { workbenchStep } from './workbench.ts';
import { ITERM_HINT, NOT_YET, type Effect, type Input, type State, type Step } from './types.ts';

export type { State, Input, Effect, Step } from './types.ts';
export { defaultSessionView } from './sessionView.ts';

export function initialState(): State {
  return {
    screen: { name: 'booting' }, overlay: { kind: 'none' }, connection: 'connecting', reconnectAttempt: 0,
    sessionView: {}, search: { text: '', filter: {} }, toasts: [], unresolvedQueue: [], nextToastId: 1,
    launch: { kind: 'idle' }, waitingSeen: [], promote: { kind: 'idle' }, summaryFailed: {}, indexPhase: 'idle',
  };
}

// フェーズ 4 以降に残る操作だけ。フェーズ 3 で実装した Intent はここから外した。
const NOT_YET_INTENTS = new Set(['session.takeover', 'sync.now', 'sync.pause', 'project.new.open', 'project.new.submit']);

/** 直交する領域の状態機械を順に試し、最初に応答した領域の結果を採る。残りは横断的な入力。 */
export function transition(state: State, input: Input): Step {
  for (const step of [connectionStep, screenStep, launchStep, liveStep, promoteStep, overlayStep, sessionViewStep, workbenchStep]) {
    const r = step(state, input);
    if (r) return r;
  }
  ...以降はフェーズ 2 のまま...
}
```

`promoteStep` は `overlay.close` を横取りするので `overlayStep` より前に置く。
`workbenchStep` は `summary.*` の server イベントを見るので最後に置き、他の領域が先に応答した入力には触れない。

- [ ] **Step 9: テストと型検査**

Run: `npx vitest run packages/shared packages/ui/src/mediator && npx tsc -p packages/ui --noEmit`
Expected: mediator は PASS。`tsc` のエラーは `runtime.ts`（新しい効果の未処理）と Presenter と View の箇所だけに限られる（Task 19 から Task 27 で埋める）。

- [ ] **Step 10: コミット**

```bash
git add packages/shared/src packages/ui/src/mediator
git commit -m "feat(ui): mediator regions for promote, workbench, split and palette commands"
```

---

### Task 19: ランタイム（新しい効果、昇格の結果、分割の解決）

**Files:**
- Modify: `packages/ui/src/runtime/runtime.ts`
- Test: `packages/ui/src/runtime/runtime.test.ts`（追加）

**Interfaces:**
- Consumes: Task 17 の `ApiClient` と `todosOf`、フェーズ 2 の `currentRunOf` と `tabsOf` と `TerminalHost`、Task 18 の `Effect` と `RuntimeEvent`。
- Produces:
  ```ts
  export type RuntimeDeps = { ...フェーズ 2...; focus?: (target: Exclude<FocusTarget, 'terminal'>) => void };
  ```
- 効果の実装：
  - `api.addTodo` / `api.removeTodo`：呼ぶだけ。一覧の更新はサーバの `todos.update` が配る。
  - `api.toggleTodo`：ストアの `todos[id].done` を反転して `setTodoDone` を呼ぶ。ストアに無ければ何もしない。
  - `api.loadMemo`：`memo(projectId)` を読み、`store.memos[projectId]` に入れる。
  - `api.saveMemo`：`saveMemo` の結果を `store.memos` に入れる（サーバの `memo.update` より先に反映する）。
  - `api.setSessionMemo`：`setSessionMemo` の結果を `store.sessions` に入れる。
  - `api.openArtifact` / `api.openArtifactEditor` / `api.addArtifact`：呼ぶだけ。失敗は `api.failed`。
  - `api.promote`：成功で `projects` と `sessions` を差し替えてから `runtime promote.done`、失敗で `runtime promote.failed`。
  - `api.regenerateSummary`：呼ぶだけ。進行はサーバの `summary.pending` が配る。
  - `api.loadSettingsExtras`：`statusline`、`usageAggregate(30)`、`summarizerModels` を並列に読む。モデルの取得の失敗は空配列にする（LM Studio が起動していないのは普通の状態である）。
  - `api.testSummarizer`：先に `summarizerTest` を null に戻し、結果を入れる。
  - `split.resolve`：`currentRunOf` と `tabsOf` で開いているタブを引き、左（選択中、無ければ先頭）と違う最初のタブを右にする。2 つ無ければ null を返す。
  - `focus`：`terminal` はフェーズ 2 のまま `terminals.focus`。それ以外は `deps.focus`。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/runtime/runtime.test.ts` の `harness` の `api` に `...fakeApiExtras(),` を先頭近くに足し（`...overrides` より前）、次の `describe` を足す。

```ts
import { fakeApiExtras } from '../test/fakeApi.ts';
import type { ArtifactDto, MemoDto, ProjectDto, RunDto, SessionDto, TabDto, TodoDto } from '@agent-hangar/shared';

const p3Project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: '/w/' + id, resolved: true, lastActivityAt: 1, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const p3Todo = (id: string, done: boolean): TodoDto => ({ id, projectId: 'p1', text: 'x', done, position: 1, sessionId: null, updatedAt: 1 });
const p3Run = (id: string, sessionId: string): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 });
const p3Tab = (id: string, runId: string, kind: 'agent' | 'shell'): TabDto => ({ id, runId, sessionId: 's1', kind, title: id, tmuxName: `hangar-${runId}-${id}`, createdAt: Number(id.replace(/\D/g, '') || 0), closedAt: null });

describe('フェーズ 3 の効果', () => {
  it('TODO の反転はストアの現在値から done を決める', async () => {
    const setTodoDone = vi.fn(async (id: string, done: boolean) => p3Todo(id, done));
    const { rt, wsHandlers } = harness({ setTodoDone });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    wsHandlers[0]!.onEvent({ type: 'todos.update', projectId: 'p1', todos: [p3Todo('t1', false)] });
    rt.emit({ type: 'todo.toggle', id: 't1' });
    await flush();
    expect(setTodoDone).toHaveBeenCalledWith('t1', true);
    wsHandlers[0]!.onEvent({ type: 'todos.update', projectId: 'p1', todos: [p3Todo('t1', true)] });
    rt.emit({ type: 'todo.toggle', id: 't1' });
    await flush();
    expect(setTodoDone).toHaveBeenLastCalledWith('t1', false);
    setTodoDone.mockClear();
    rt.emit({ type: 'todo.toggle', id: 'nope' });
    await flush();
    expect(setTodoDone).not.toHaveBeenCalled();
  });
  it('メモは読み込みと保存の両方でストアに入る', async () => {
    const memo = vi.fn(async (projectId: string): Promise<MemoDto> => ({ projectId, markdown: '# 読んだ', updatedAt: 5 }));
    const saveMemo = vi.fn(async (projectId: string, markdown: string): Promise<MemoDto> => ({ projectId, markdown, updatedAt: 6 }));
    const { rt, wsHandlers, setHash } = harness({ memo, saveMemo });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/projects/p1');
    await flush();
    expect(memo).toHaveBeenCalledWith('p1');
    expect(rt.getStore().memos.p1?.markdown).toBe('# 読んだ');
    rt.emit({ type: 'memo.save', projectId: 'p1', markdown: '# 書いた' });
    await flush();
    expect(saveMemo).toHaveBeenCalledWith('p1', '# 書いた');
    expect(rt.getStore().memos.p1).toEqual({ projectId: 'p1', markdown: '# 書いた', updatedAt: 6 });
  });
  it('昇格は成功でストアを更新して promote.done、失敗で promote.failed になる', async () => {
    const session: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p9', name: 's1', cwd: '/w/newp', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null, summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null } };
    const promote = vi.fn(async () => ({ project: p3Project('p9'), session, moved: true, reason: null }));
    const { rt, wsHandlers } = harness({ promote });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: false, moveFiles: true });
    await flush();
    expect(promote).toHaveBeenCalledWith('s1', { name: 'newp', gitInit: false, moveFiles: true });
    expect(rt.getStore().projects.p9?.name).toBe('p9');
    expect(rt.getState().overlay).toEqual({ kind: 'promoted', projectId: 'p9', moved: true, reason: null });
    const bad = harness({ promote: vi.fn(async () => { throw new Error('409 /api/sessions/s1/promote'); }) });
    bad.rt.start();
    bad.wsHandlers[0]!.onOpen();
    await flush();
    bad.rt.emit({ type: 'session.promote.submit', id: 's1', name: 'taken', gitInit: false, moveFiles: false });
    await flush();
    expect(bad.rt.getState().promote).toEqual({ kind: 'failed', message: '409 /api/sessions/s1/promote' });
  });
  it('設定画面に入ると statusline と集計とモデル一覧を読む', async () => {
    const statusline = vi.fn(async () => ({ command: 'bash ~/.claude/statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: true }));
    const usageAggregate = vi.fn(async () => ({ days: [{ day: '2026-09-18', inputTokens: 1, outputTokens: 2, sessions: 1 }], projects: [] }));
    const summarizerModels = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const { rt, wsHandlers, setHash } = harness({ statusline, usageAggregate, summarizerModels });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/settings');
    await flush();
    expect(usageAggregate).toHaveBeenCalledWith(30);
    expect(rt.getStore().statusline?.installed).toBe(true);
    expect(rt.getStore().usageAggregate?.days).toHaveLength(1);
    expect(rt.getStore().summarizerModels).toEqual([]);
  });
  it('要約器を試すと結果がストアに入る', async () => {
    const testSummarizer = vi.fn(async () => ({ ok: true as const, id: 'lmstudio' as const, ms: 12, summary: { title: 'T', oneLiner: 'O', body: 'B', state: 'done' as const, nextSteps: [], source: 'post_hoc' as const, sourceModel: 'gemma', basedOnTurns: 3 } }));
    const { rt, wsHandlers } = harness({ testSummarizer });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'summarizer.test' });
    await flush();
    expect(rt.getStore().summarizerTest).toMatchObject({ ok: true, id: 'lmstudio', ms: 12 });
  });
  it('分割は選択中でない最初のタブを右にし、タブが 1 つなら null を返す', async () => {
    const { rt, wsHandlers, setHash } = harness();
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/sessions/s1');
    await flush();
    wsHandlers[0]!.onEvent({ type: 'run.started', run: p3Run('r1', 's1'), tabs: [p3Tab('t1', 'r1', 'agent')] });
    rt.emit({ type: 'split.toggle' });
    await flush();
    expect(rt.getState().sessionView.s1?.split).toBeFalsy();
    expect(rt.getState().toasts.at(-1)?.message).toBe('分割にはタブが 2 つ必要です');
    wsHandlers[0]!.onEvent({ type: 'tab.upsert', tab: p3Tab('t2', 'r1', 'shell') });
    rt.emit({ type: 'tab.select', tabId: 't1' });
    rt.emit({ type: 'split.toggle' });
    await flush();
    expect(rt.getState().sessionView.s1).toMatchObject({ split: true, splitTab: 't2' });
  });
  it('focus の新しい対象は deps.focus に渡る', async () => {
    const { rt, wsHandlers, focus } = harness();
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'session.promote.open', id: 's1' });
    expect(rt.getState().overlay).toEqual({ kind: 'promote', sessionId: 's1' });
    expect(focus).toHaveBeenCalledWith('promoteName');
    rt.emit({ type: 'todo.add', projectId: 'p1', text: '買う' });
    await flush();
    expect(focus).toHaveBeenLastCalledWith('todoInput');
  });
});
```

`harness` の `deps` に `focus: vi.fn()` を足し、返り値にも `focus: deps.focus` を足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/runtime/runtime`
Expected: FAIL

- [ ] **Step 3: RuntimeDeps を広げる**

`packages/ui/src/runtime/runtime.ts` の `RuntimeDeps` の `focus` を置き換える。
`terminal` はランタイムが自分で処理するので、`deps.focus` へは渡らない。

```ts
  focus?: (target: Exclude<FocusTarget, 'terminal'>) => void;
```

`FocusTarget`、`currentRunOf`、`tabsOf`、`defaultSessionView` はフェーズ 2 で既に import してあるので、import の追加は要らない。

- [ ] **Step 4: 効果を実装する**

`runEffect` の `switch` に足す（`case 'storage.save'` の前）。

```ts
      case 'api.addTodo': deps.api.addTodo(e.projectId, e.text).catch(fail); return;
      case 'api.toggleTodo': {
        // 反転の基準はストアの現在値にする。View は done の値を持たない。
        const t = store.todos[e.id];
        if (!t) return;
        deps.api.setTodoDone(e.id, !t.done).catch(fail);
        return;
      }
      case 'api.removeTodo': deps.api.removeTodo(e.id).catch(fail); return;
      case 'api.loadMemo': deps.api.memo(e.projectId).then((m) => setStore({ ...store, memos: { ...store.memos, [m.projectId]: m } })).catch(fail); return;
      case 'api.saveMemo': deps.api.saveMemo(e.projectId, e.markdown).then((m) => setStore({ ...store, memos: { ...store.memos, [m.projectId]: m } })).catch(fail); return;
      case 'api.setSessionMemo': deps.api.setSessionMemo(e.sessionId, e.text).then((s) => setStore({ ...store, sessions: { ...store.sessions, [s.id]: s } })).catch(fail); return;
      case 'api.openArtifact': deps.api.openArtifact(e.id).catch(fail); return;
      case 'api.openArtifactEditor': deps.api.openArtifactEditor(e.id).catch(fail); return;
      case 'api.addArtifact': deps.api.addArtifact(e.projectId, e.url).then((a) => setStore({ ...store, artifacts: { ...store.artifacts, [a.id]: a } })).catch(fail); return;
      case 'api.promote':
        deps.api.promote(e.sessionId, { name: e.name, gitInit: e.gitInit, moveFiles: e.moveFiles })
          .then((r) => {
            setStore({ ...store, projects: { ...store.projects, [r.project.id]: r.project }, sessions: { ...store.sessions, [r.session.id]: r.session } });
            dispatch({ kind: 'runtime', event: { type: 'promote.done', projectId: r.project.id, moved: r.moved, reason: r.reason } });
          })
          .catch((err) => dispatch({ kind: 'runtime', event: { type: 'promote.failed', message: err instanceof Error ? err.message : String(err) } }));
        return;
      case 'api.regenerateSummary': deps.api.regenerateSummary(e.sessionId).catch(fail); return;
      case 'api.loadSettingsExtras':
        deps.api.statusline().then((s) => setStore({ ...store, statusline: s })).catch(fail);
        deps.api.usageAggregate(30).then((a) => setStore({ ...store, usageAggregate: a })).catch(fail);
        // LM Studio が起動していないのは普通の状態なので、失敗は空の一覧にして黙る。
        deps.api.summarizerModels().then((m) => setStore({ ...store, summarizerModels: m.models })).catch(() => setStore({ ...store, summarizerModels: [] }));
        return;
      case 'api.testSummarizer':
        setStore({ ...store, summarizerTest: null });
        deps.api.testSummarizer().then((r) => setStore({ ...store, summarizerTest: r })).catch(fail);
        return;
      case 'split.resolve': {
        const view = state.sessionView[e.sessionId] ?? defaultSessionView();
        const run = currentRunOf(store, e.sessionId);
        const tabs = run ? tabsOf(store, run.id) : [];
        const left = view.selectedTab ?? tabs[0]?.id ?? null;
        const right = tabs.find((t) => t.id !== left) ?? null;
        dispatch({ kind: 'runtime', event: { type: 'split.resolved', sessionId: e.sessionId, tabId: right ? right.id : null } });
        return;
      }
```

`case 'focus'` を置き換える（フェーズ 2 の `terminal` の扱いはそのまま残す）。

```ts
      case 'focus':
        if (e.target === 'terminal') { ...フェーズ 2 の実装のまま... ; return; }
        deps.focus?.(e.target);
        return;
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui/src/runtime && npx tsc -p packages/ui --noEmit`
Expected: runtime は PASS。`tsc` のエラーは Presenter と View の箇所だけに限られる。

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/runtime packages/ui/src/test
git commit -m "feat(ui): runtime effects for todos, memos, artifacts, promote, split resolution and summarizer"
```

---

### Task 20: Presenter（使用量、プロジェクト、セッション、行、設定）

**Files:**
- Modify: `packages/ui/src/presenters/format.ts`、`shell.ts`、`projects.ts`、`home.ts`、`project.ts`、`row.ts`、`session.ts`、`newSession.ts`、`settings.ts`
- Test: `packages/ui/src/presenters/presenters.test.ts`（追加）

`home.ts` は「ファイル構成」に載っていないが、Home のカードからスクラッチを外すために同じ 1 行の絞り込みが要る。

**Interfaces:**
- Consumes: Task 17 の `Store`（`usage`、`todos`、`memos`、`artifacts`、`summaryPending`、`usageAggregate`、`statusline`、`summarizerModels`、`summarizerTest`）と `todosOf`、`artifactsOf`。Task 18 の `State`（`summaryFailed`、`SessionViewState.split`）。フェーズ 2 の `currentRunOf`、`tabsOf`、`aliveRunOf`。
- Produces:
  ```ts
  // presenters/format.ts
  export function percentLabel(n: number | null): string;                         // null は「未取得」
  export function costLabel(n: number | null): string;                            // null は空文字、それ以外は $0.00 の形
  // presenters/shell.ts
  export type UsageProps = { fiveHour: number | null; sevenDay: number | null; updatedLabel: string | null };
  export type ShellProps = { ...フェーズ 1...; usage: UsageProps };
  export function presentShell(state: State, store: Store, now: number): ShellProps;      // now が増える
  // presenters/project.ts
  export type TodoItemProps = { id: string; text: string; done: boolean };
  export type ArtifactCardProps = { id: string; title: string; description: string | null; favicon: string; url: string; lastPublished: string; versionCount: number; canOpenEditor: boolean };
  export type ProjectProps = { ...フェーズ 1...; isScratch: boolean; todos: TodoItemProps[]; memo: { markdown: string; updatedAt: number } | null; artifacts: ArtifactCardProps[] };
  export function presentArtifactCard(a: ArtifactDto, now: number): ArtifactCardProps;
  // presenters/row.ts
  export type SessionRowProps = { ...フェーズ 1...; cost: string; runId: string | null };
  // presenters/session.ts
  export type SessionProps = { ...フェーズ 2...; contextPercent: number | null; cost: string; artifacts: ArtifactCardProps[]; summaryPending: boolean; summaryError: string | null; fromScratch: boolean; canPromote: boolean; split: { left: string; right: string } | null; canSplit: boolean };
  // presenters/newSession.ts
  export type NewSessionProps = { projects: { id: string; name: string; path: string | null }[]; projectId: string | null; submitting: boolean; error: string | null; scratch: boolean };
  // presenters/settings.ts
  export type SettingsProps = { ...フェーズ 2...; lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number; summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null; statusline: StatuslineStatusDto | null; statuslineCommand: string; usageAggregate: UsageAggregateDto | null };
  ```
- `presentProjects` と `presentHome` は `isScratch` のプロジェクトを外す。プロジェクト画面とセッション一覧の絞り込みには残す。
- `canPromote` は、セッションが属するプロジェクトがスクラッチのときに真。`fromScratch` はサーバが計算した値をそのまま渡す。
- `split` は `SessionViewState.split` が真で、開いているタブが 2 つ以上あるときだけ `{ left, right }` を返す。`splitTab` が閉じたタブを指していたら、左と違う最初のタブに落とす。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/presenters/presenters.test.ts` に足す。

```ts
import type { ArtifactDto, TodoDto } from '@agent-hangar/shared';
import { costLabel, percentLabel } from './format.ts';
import { presentArtifactCard } from './project.ts';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const todoDto = (id: string, position: number, done = false): TodoDto => ({ id, projectId: 'p1', text: `やる ${id}`, done, position, sessionId: null, updatedAt: 1 });
const artDto = (id: string, over: Partial<ArtifactDto> = {}): ArtifactDto => ({ id, projectId: 'p1', url: `https://claude.ai/code/artifact/${id}`, title: `題名 ${id}`, description: '説明', favicon: '📊', filePath: null, fileExists: false, firstPublishedAt: NOW - 100_000, lastPublishedAt: NOW - 60_000, versionCount: 2, sessionIds: ['s1'], ...over });

describe('書式', () => {
  it('percentLabel と costLabel', () => {
    expect(percentLabel(null)).toBe('未取得');
    expect(percentLabel(47.4)).toBe('47%');
    expect(percentLabel(0)).toBe('0%');
    expect(costLabel(null)).toBe('');
    expect(costLabel(1.234)).toBe('$1.23');
  });
});

describe('presentShell の使用量', () => {
  it('値が無ければ null、あれば百分率と最終更新', () => {
    const empty = presentShell(initialState(), initialStore(), NOW);
    expect(empty.usage).toEqual({ fiveHour: null, sevenDay: null, updatedLabel: null });
    const store = { ...initialStore(), usage: { fiveHour: { usedPercent: 47, resetsAt: null }, sevenDay: { usedPercent: 7, resetsAt: null }, updatedAt: NOW - 600_000 } };
    expect(presentShell(initialState(), store, NOW).usage).toEqual({ fiveHour: 47, sevenDay: 7, updatedLabel: '10 分前' });
  });
});

describe('presentProject の右レール', () => {
  it('TODO とメモとアーティファクトを並べ、スクラッチは印を付ける', () => {
    const store = {
      ...initialStore(),
      projects: { p1: { id: 'p1', name: 'alpha', status: 'active' as const, isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 1, memoHead: '# alpha', updatedAt: 1 } },
      todos: { t2: todoDto('t2', 2, true), t1: todoDto('t1', 1) },
      memos: { p1: { projectId: 'p1', markdown: '# alpha\n本文', updatedAt: 5 } },
      artifacts: { a1: artDto('a1'), a2: artDto('a2', { projectId: 'p2' }) },
    };
    const p = presentProject(initialState(), store, NOW, 'p1');
    expect(p.todos).toEqual([{ id: 't1', text: 'やる t1', done: false }, { id: 't2', text: 'やる t2', done: true }]);
    expect(p.memo).toEqual({ markdown: '# alpha\n本文', updatedAt: 5 });
    expect(p.artifacts.map((a) => a.id)).toEqual(['a1']);
    expect(p.isScratch).toBe(false);
  });
  it('アーティファクトのカードは題名と最終公開と編集の可否を持つ', () => {
    expect(presentArtifactCard(artDto('a1'), NOW)).toEqual({ id: 'a1', title: '題名 a1', description: '説明', favicon: '📊', url: 'https://claude.ai/code/artifact/a1', lastPublished: '1 分前', versionCount: 2, canOpenEditor: false });
    const manual = presentArtifactCard(artDto('a2', { title: null, favicon: null, description: null, filePath: '/w/alpha/x.html', fileExists: true }), NOW);
    expect(manual).toMatchObject({ title: 'a2', favicon: '📄', canOpenEditor: true });
  });
});

describe('presentProjects と presentHome', () => {
  it('スクラッチのプロジェクトはカードに出さない', () => {
    const store = {
      ...initialStore(),
      projects: {
        p1: { id: 'p1', name: 'alpha', status: 'active' as const, isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 },
        sc: { id: 'sc', name: 'スクラッチ', status: 'active' as const, isScratch: true, path: '/h/.agent-hangar/scratch', resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 },
      },
    };
    expect(presentProjects(initialState(), store, NOW, '', false).sections[0]!.cards.map((c) => c.id)).toEqual(['p1']);
    expect(presentHome(initialState(), store, NOW).activeProjects.map((c) => c.id)).toEqual(['p1']);
  });
});

describe('presentSession のフェーズ 3 の項目', () => {
  it('コンテキストとコストと要約の状態と昇格の可否', () => {
    const base = session('s1', 'u1');
    const store = {
      ...initialStore(),
      projects: { sc: { id: 'sc', name: 'スクラッチ', status: 'active' as const, isScratch: true, path: '/h/.agent-hangar/scratch', resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 } },
      sessions: { s1: { ...base, projectId: 'sc', fromScratch: false, stats: { ...base.stats, contextPercent: 25, costUsd: 0.5 } } },
      artifacts: { a1: artDto('a1') },
      summaryPending: { s1: true as const },
    };
    const state = { ...initialState(), summaryFailed: { s1: 'LM Studio に繋がりません' } };
    const p = presentSession(state, store, NOW, 's1');
    expect(p.contextPercent).toBe(25);
    expect(p.cost).toBe('$0.50');
    expect(p.artifacts.map((a) => a.id)).toEqual(['a1']);
    expect(p.summaryPending).toBe(true);
    expect(p.summaryError).toBe('LM Studio に繋がりません');
    expect(p.canPromote).toBe(true);
    expect(p.fromScratch).toBe(false);
    expect(p.canSplit).toBe(false);
    expect(p.split).toBeNull();
  });
  it('分割はタブが 2 つ以上あるときだけ左右を返す', () => {
    const base = session('s1', 'u1');
    const store = {
      ...initialStore(),
      sessions: { s1: base },
      runs: { r1: { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start' as const, tmuxName: 'hangar-r1', pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 } },
      tabs: {
        t1: { id: 't1', runId: 'r1', sessionId: 's1', kind: 'agent' as const, title: 'Claude', tmuxName: 'x', createdAt: 1, closedAt: null },
        t2: { id: 't2', runId: 'r1', sessionId: 's1', kind: 'shell' as const, title: 'シェル 1', tmuxName: 'y', createdAt: 2, closedAt: null },
      },
    };
    const view = { ...defaultSessionView(), selectedTab: 't1', split: true, splitTab: 't9' };
    const state = { ...initialState(), sessionView: { s1: view } };
    const p = presentSession(state, store, NOW, 's1');
    expect(p.canSplit).toBe(true);
    // splitTab が閉じたタブを指していたら、左と違う最初のタブに落とす。
    expect(p.split).toEqual({ left: 't1', right: 't2' });
  });
});

describe('presentSettings のフェーズ 3 の項目', () => {
  it('要約器と statusline と使用量の集計を渡す', () => {
    const store = {
      ...initialStore(),
      settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5 },
      statusline: { command: 'bash ~/.claude/statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: true },
      summarizerModels: ['gemma', 'qwen'],
      usageAggregate: { days: [{ day: '2026-09-18', inputTokens: 10, outputTokens: 2, sessions: 1 }], projects: [] },
    };
    const p = presentSettings(initialState(), store);
    expect(p).toMatchObject({ lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5, summarizerModels: ['gemma', 'qwen'], statuslineCommand: 'npx hangar statusline install' });
    expect(p.statusline?.installed).toBe(true);
    expect(p.usageAggregate?.days).toHaveLength(1);
    expect(p.summarizerTest).toBeNull();
  });
});
```

`session()` の補助は Task 1 で `fromScratch` と `contextPercent` と `costUsd` を足してある。
`defaultSessionView` と `presentHome` と `presentProjects` の import が無ければ足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/presenters`
Expected: FAIL

- [ ] **Step 3: format.ts に 2 つ足す**

`packages/ui/src/presenters/format.ts` の末尾に足す。

```ts
/** 使用率の表示。値が無いときは「未取得」にする。 */
export function percentLabel(n: number | null): string {
  return n === null ? '未取得' : `${Math.round(n)}%`;
}

/** 推定コスト。値が無いときは空文字にして、行の桁を崩さない。 */
export function costLabel(n: number | null): string {
  return n === null ? '' : `$${n.toFixed(2)}`;
}
```

- [ ] **Step 4: shell.ts に使用量を足す**

`packages/ui/src/presenters/shell.ts` を直す。

```ts
import { relativeTime } from './format.ts';

export type UsageProps = { fiveHour: number | null; sevenDay: number | null; updatedLabel: string | null };
export type ShellProps = { nav: NavItem[]; crumbs: { label: string; route?: Route }[]; searchText: string; connection: State['connection']; index: IndexProgressDto; indexLabel: string | null; usage: UsageProps };
```

`presentShell` の引数に `now: number` を足し、返り値に足す。

```ts
  const u = store.usage;
  // 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。
  const usage: UsageProps = { fiveHour: u.fiveHour?.usedPercent ?? null, sevenDay: u.sevenDay?.usedPercent ?? null, updatedLabel: u.updatedAt === null ? null : relativeTime(u.updatedAt, now) };
  return { nav: ..., crumbs, searchText: state.search.text, connection: state.connection, index: idx, indexLabel, usage };
```

`Root.tsx` の `presentShell(state, store)` は Task 27 で `presentShell(state, store, now)` に直す。

- [ ] **Step 5: projects.ts と home.ts からスクラッチを外す**

`packages/ui/src/presenters/projects.ts` の `presentProjects` の `all` の絞り込みを置き換える。

```ts
  // スクラッチの擬似プロジェクトはカードに出さない。Sessions 画面の絞り込みには残る。
  const all = Object.values(store.projects).filter((p) => !p.isScratch).filter((p) => !needle || p.name.toLowerCase().includes(needle)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
```

`packages/ui/src/presenters/home.ts` の `activeProjects` を置き換える。

```ts
  const activeProjects = Object.values(store.projects).filter((p) => p.status === 'active' && !p.isScratch).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map((p) => presentProjectCard(p, store, now));
```

- [ ] **Step 6: project.ts に右レールを足す**

`packages/ui/src/presenters/project.ts` を置き換える。

```ts
import type { ArtifactDto, ProjectStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { artifactsOf, todosOf, type Store } from '../store/store.ts';
import { relativeTime } from './format.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

export type TodoItemProps = { id: string; text: string; done: boolean };
export type ArtifactCardProps = { id: string; title: string; description: string | null; favicon: string; url: string; lastPublished: string; versionCount: number; canOpenEditor: boolean };
export type ProjectProps = { id: string; name: string; path: string | null; resolved: boolean; status: ProjectStatus; sessions: SessionRowProps[]; notFound: boolean; isScratch: boolean; todos: TodoItemProps[]; memo: { markdown: string; updatedAt: number } | null; artifacts: ArtifactCardProps[] };

/** アーティファクト 1 件分のカード。題名が無い手動追加は URL の末尾を出す。 */
export function presentArtifactCard(a: ArtifactDto, now: number): ArtifactCardProps {
  return {
    id: a.id, title: a.title ?? a.url.split('/').filter(Boolean).at(-1) ?? a.url, description: a.description, favicon: a.favicon ?? '📄',
    url: a.url, lastPublished: relativeTime(a.lastPublishedAt, now), versionCount: a.versionCount, canOpenEditor: a.filePath !== null && a.fileExists,
  };
}

export function presentProject(_state: State, store: Store, now: number, id: string): ProjectProps {
  const p = store.projects[id];
  if (!p) return { id, name: id, path: null, resolved: false, status: 'active', sessions: [], notFound: true, isScratch: false, todos: [], memo: null, artifacts: [] };
  const sessions = sortSessions(Object.values(store.sessions).filter((s) => s.projectId === id)).map((s) => presentSessionRow(s, store, now));
  const memo = store.memos[id];
  return {
    id, name: p.name, path: p.path, resolved: p.resolved, status: p.status, sessions, notFound: false, isScratch: p.isScratch,
    todos: todosOf(store, id).map((t) => ({ id: t.id, text: t.text, done: t.done })),
    memo: memo ? { markdown: memo.markdown, updatedAt: memo.updatedAt } : null,
    artifacts: artifactsOf(store, { projectId: id }).map((a) => presentArtifactCard(a, now)),
  };
}
```

- [ ] **Step 7: row.ts にコストと runId を足す**

`packages/ui/src/presenters/row.ts` の `SessionRowProps` と `presentSessionRow` を直す。

```ts
export type SessionRowProps = { id: string; name: string; oneLiner: string; projectName: string | null; live: LiveStatus | null; stateLabel: string; model: string; effort: string; when: string; whenAbs: string; filesChanged: number; prUrl: string | null; memo: string | null; hasTranscript: boolean; cost: string; runId: string | null; snippets?: { seq: number; text: string }[] };
```

`row` の組み立てに足す（`aliveRunOf` を `../store/store.ts` から import する）。

```ts
    cost: costLabel(s.stats.costUsd), runId: aliveRunOf(store, s.id)?.id ?? null,
```

`costLabel` を `./format.ts` から import する。

- [ ] **Step 8: session.ts を広げる**

`packages/ui/src/presenters/session.ts` の import に足す。

```ts
import { artifactsOf, currentRunOf, eventsKey, tabsOf, type Store } from '../store/store.ts';
import { absoluteTime, costLabel, relativeTime, shortModel, SOURCE_LABEL, STATE_LABEL, tokensLabel } from './format.ts';
import { presentArtifactCard, type ArtifactCardProps } from './project.ts';
```

`SessionProps` に足す。

```ts
  contextPercent: number | null; cost: string; artifacts: ArtifactCardProps[]; summaryPending: boolean; summaryError: string | null; fromScratch: boolean; canPromote: boolean; split: { left: string; right: string } | null; canSplit: boolean;
```

`presentSession` の `base` に足す。

```ts
    contextPercent: null, cost: '', artifacts: [], summaryPending: false, summaryError: null, fromScratch: false, canPromote: false, split: null, canSplit: false,
```

`if (!s) return ...` の後に足し、返り値にも足す。

```ts
  const run = currentRunOf(store, id);
  const tabs = run ? tabsOf(store, run.id) : [];
  const left = view.selectedTab ?? tabs[0]?.id ?? null;
  const canSplit = tabs.length >= 2;
  // splitTab が閉じたタブを指していることがあるので、左と違う最初のタブに落とす。
  const right = view.split && canSplit && left ? tabs.find((t) => t.id === view.splitTab && t.id !== left) ?? tabs.find((t) => t.id !== left) ?? null : null;
```

```ts
    contextPercent: s.stats.contextPercent, cost: costLabel(s.stats.costUsd),
    artifacts: artifactsOf(store, { sessionId: id }).map((a) => presentArtifactCard(a, now)),
    summaryPending: store.summaryPending[id] === true, summaryError: state.summaryFailed[id] ?? null,
    fromScratch: s.fromScratch, canPromote: !!(s.projectId && store.projects[s.projectId]?.isScratch),
    split: right && left ? { left, right: right.id } : null, canSplit,
```

- [ ] **Step 9: newSession.ts と settings.ts を広げる**

`packages/ui/src/presenters/newSession.ts` の `NewSessionProps` に `scratch: boolean` を足し、`presentNewSession` でオーバーレイから読む。

```ts
export type NewSessionProps = { projects: { id: string; name: string; path: string | null }[]; projectId: string | null; submitting: boolean; error: string | null; scratch: boolean };

/** 起動ダイアログ。overlay が newSession のときだけ props を作る。 */
export function presentNewSession(state: State, store: Store): NewSessionProps | null {
  if (state.overlay.kind !== 'newSession') return null;
  // スクラッチの擬似プロジェクトは選ばせない。絞り込みと並びはフェーズ 2 のまま。
  const projects = Object.values(store.projects).filter((p) => !p.isScratch && p.resolved && p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name, path: p.path }));
  return { projects, projectId: state.overlay.projectId, submitting: state.launch.kind === 'submitting', error: state.launch.kind === 'failed' ? state.launch.message : null, scratch: state.overlay.scratch };
}
```

`packages/ui/src/presenters/settings.ts` を置き換える。

```ts
import type { IndexProgressDto, StatuslineStatusDto, SummarizerTestDto, TerminalApp, UsageAggregateDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type SettingsProps = {
  workspaceRoot: string; claudeDir: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; sessionCount: number; projectCount: number;
  tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; mcpInstallCommand: string;
  lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number;
  summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null;
  statusline: StatuslineStatusDto | null; statuslineCommand: string; usageAggregate: UsageAggregateDto | null;
};

export function presentSettings(_state: State, store: Store): SettingsProps {
  const s = store.settings;
  return {
    workspaceRoot: s?.workspaceRoot ?? '', claudeDir: s?.claudeDir ?? '', device: store.device, version: store.version, index: store.index,
    sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length,
    tmuxPath: s?.tmuxPath ?? null, terminalApp: s?.terminalApp ?? 'terminal', codePath: s?.codePath ?? null, mcpInstallCommand: 'npx hangar mcp install',
    lmStudioUrl: s?.lmStudioUrl ?? '', lmStudioModel: s?.lmStudioModel ?? null, summaryFallback: s?.summaryFallback ?? true, summaryHourlyCap: s?.summaryHourlyCap ?? 20,
    summarizerModels: store.summarizerModels, summarizerTest: store.summarizerTest,
    statusline: store.statusline, statuslineCommand: 'npx hangar statusline install', usageAggregate: store.usageAggregate,
  };
}
```

- [ ] **Step 10: テストと型検査**

Run: `npx vitest run packages/ui/src/presenters && npx tsc -p packages/ui --noEmit`
Expected: presenters は PASS。`tsc` のエラーは View と `Root.tsx` の箇所だけに限られる。

- [ ] **Step 11: コミット**

```bash
git add packages/ui/src/presenters
git commit -m "feat(ui): presenters for usage gauges, project rail, session context, cost and settings extras"
```

---

### Task 21: Presenter（コマンドパレットと昇格ダイアログ）

**Files:**
- Create: `packages/ui/src/presenters/palette.ts`、`packages/ui/src/presenters/promote.ts`
- Test: `packages/ui/src/presenters/palette.test.ts`

**Interfaces:**
- Consumes: Task 18 の `State`（`overlay`、`promote`）、Task 17 の `Store`、フェーズ 2 の `aliveRunOf`。
- Produces:
  ```ts
  // presenters/palette.ts
  export type PaletteItem = { id: string; label: string; hint: string; kind: 'command' | 'project' | 'session' };
  export type PaletteProps = { query: string; items: PaletteItem[] };
  export function fuzzyScore(query: string, text: string): number;                 // 0 は不一致
  export function presentPalette(state: State, store: Store, query: string): PaletteProps | null;
  // presenters/promote.ts
  export type PromoteProps = { sessionId: string; sessionName: string; runAlive: boolean; submitting: boolean; error: string | null };
  export type PromotedProps = { projectId: string; projectName: string; moved: boolean; reason: string | null };
  export function presentPromote(state: State, store: Store): PromoteProps | null;
  export function presentPromoted(state: State, store: Store): PromotedProps | null;
  ```
- 照合は部分列一致で、入力の各文字が同じ順に現れれば一致とみなす。
- 点は 1 文字ごとに、基礎点 10、文字列の先頭に近いほど最大 20 の加点、直前の文字と連続していれば 15 の加点を足す。
- 項目はコマンド 4 件、プロジェクト全件（スクラッチを含む。ここが唯一のスクラッチへの入口である）、セッション全件（名前と要約の 1 文を繋いだ文字列で照合）で、点の高い順に 30 件まで出す。
- 入力が空のときはすべてが点 1 で並び、コマンド、プロジェクト、セッションの順になる。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/presenters/palette.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { fuzzyScore, presentPalette } from './palette.ts';
import { presentPromote, presentPromoted } from './promote.ts';

const project = (id: string, name: string, isScratch = false): ProjectDto => ({ id, name, status: 'active', isScratch, path: '/w/' + name, resolved: true, lastActivityAt: 1, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const session = (id: string, name: string, oneLiner: string | null): SessionDto => ({
  id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'p1', name, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null,
  summary: oneLiner ? { title: name, oneLiner, body: '', state: 'done', nextSteps: [], source: 'baseline', sourceModel: null, basedOnTurns: 1, updatedAt: 1 } : null,
  fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null },
});

const withPalette = () => ({ ...initialState(), overlay: { kind: 'palette' as const } });
const store = (): Store => ({ ...initialStore(), projects: { p1: project('p1', 'alpha'), sc: project('sc', 'スクラッチ', true) }, sessions: { s1: session('s1', '動画の変換', '動画を mp4 に変換した'), s2: session('s2', 'ログの整理', null) } });

describe('fuzzyScore', () => {
  it('部分列で一致し、前で連続するほど高い', () => {
    expect(fuzzyScore('abc', 'xyz')).toBe(0);
    expect(fuzzyScore('abc', 'abcdef')).toBeGreaterThan(fuzzyScore('abc', 'a1b2c3'));
    expect(fuzzyScore('abc', 'abcdef')).toBeGreaterThan(fuzzyScore('abc', 'zzzzabcdef'));
    expect(fuzzyScore('ABC', 'abcdef')).toBeGreaterThan(0);
    expect(fuzzyScore('', 'なんでも')).toBe(1);
    expect(fuzzyScore('abcd', 'abc')).toBe(0);
  });
});

describe('presentPalette', () => {
  it('パレットが開いていなければ null', () => {
    expect(presentPalette(initialState(), store(), '')).toBeNull();
  });
  it('空の入力はコマンド、プロジェクト、セッションの順に並べる', () => {
    const p = presentPalette(withPalette(), store(), '')!;
    expect(p.query).toBe('');
    expect(p.items.slice(0, 4).map((i) => i.id)).toEqual(['cmd:new-session', 'cmd:new-scratch', 'cmd:settings', 'cmd:rebuild-index']);
    expect(p.items.map((i) => i.id)).toContain('project:sc');
    expect(p.items.map((i) => i.id)).toContain('session:s1');
  });
  it('入力で絞り、要約の 1 文でも当たる', () => {
    const a = presentPalette(withPalette(), store(), 'alpha')!;
    expect(a.items[0]!.id).toBe('project:p1');
    const b = presentPalette(withPalette(), store(), 'mp4')!;
    expect(b.items.map((i) => i.id)).toEqual(['session:s1']);
    const c = presentPalette(withPalette(), store(), 'zzzz')!;
    expect(c.items).toEqual([]);
  });
  it('30 件までに切る', () => {
    const many: Record<string, SessionDto> = {};
    for (let i = 0; i < 60; i++) many[`x${i}`] = session(`x${i}`, `セッション ${i}`, null);
    const p = presentPalette(withPalette(), { ...store(), sessions: many }, '')!;
    expect(p.items).toHaveLength(30);
  });
});

describe('presentPromote と presentPromoted', () => {
  it('昇格ダイアログはセッション名と run の生死と送信の状態を出す', () => {
    const s = { ...withPalette(), overlay: { kind: 'promote' as const, sessionId: 's1' }, promote: { kind: 'failed' as const, message: '同じ名前があります' } };
    expect(presentPromote(s, store())).toEqual({ sessionId: 's1', sessionName: '動画の変換', runAlive: false, submitting: false, error: '同じ名前があります' });
    expect(presentPromote(initialState(), store())).toBeNull();
    const alive = { ...initialStore(), ...store(), runs: { r1: { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start' as const, tmuxName: 'x', pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 } } };
    expect(presentPromote({ ...s, promote: { kind: 'submitting' as const } }, alive)).toMatchObject({ runAlive: true, submitting: true, error: null });
  });
  it('完了ダイアログは移動の可否と理由を出す', () => {
    const s = { ...initialState(), overlay: { kind: 'promoted' as const, projectId: 'p1', moved: false, reason: 'run が生きています' } };
    expect(presentPromoted(s, store())).toEqual({ projectId: 'p1', projectName: 'alpha', moved: false, reason: 'run が生きています' });
    expect(presentPromoted(initialState(), store())).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/presenters/palette`
Expected: FAIL（ファイルが無い）

- [ ] **Step 3: palette.ts を書く**

`packages/ui/src/presenters/palette.ts`：

```ts
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type PaletteItem = { id: string; label: string; hint: string; kind: 'command' | 'project' | 'session' };
export type PaletteProps = { query: string; items: PaletteItem[] };

const COMMANDS: PaletteItem[] = [
  { id: 'cmd:new-session', label: '新規セッション', hint: '⌘N', kind: 'command' },
  { id: 'cmd:new-scratch', label: 'スクラッチで始める', hint: '⌘⇧N', kind: 'command' },
  { id: 'cmd:settings', label: '設定', hint: '⌘,', kind: 'command' },
  { id: 'cmd:rebuild-index', label: '索引を作り直す', hint: '', kind: 'command' },
];

const KIND_ORDER: Record<PaletteItem['kind'], number> = { command: 0, project: 1, session: 2 };

/**
 * 部分列の一致に点を付ける。
 * 入力の各文字が同じ順に現れれば一致とみなし、前にあるほど、直前の文字と連続しているほど高い点にする。
 * 一致しなければ 0 を返す。
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  let score = 0;
  let at = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return 0;
    score += 10 + Math.max(0, 20 - i) + (i === prev + 1 ? 15 : 0);
    prev = i;
    at = i + 1;
  }
  return score;
}

/** パレットの項目。overlay がパレットでなければ null を返す。入力欄の文字は Root が持ち、引数で渡す。 */
export function presentPalette(state: State, store: Store, query: string): PaletteProps | null {
  if (state.overlay.kind !== 'palette') return null;
  const scored: { item: PaletteItem; score: number }[] = [];
  const push = (item: PaletteItem, text: string) => { const s = fuzzyScore(query, text); if (s > 0) scored.push({ item, score: s }); };
  for (const c of COMMANDS) push(c, c.label);
  // スクラッチの擬似プロジェクトはカードに出さないので、ここがその画面への唯一の入口になる。
  for (const p of Object.values(store.projects)) push({ id: `project:${p.id}`, label: p.name, hint: p.path ?? 'この端末にパスがありません', kind: 'project' }, p.name);
  for (const s of Object.values(store.sessions)) {
    const label = s.name ?? '（名前なし）';
    const hint = s.summary?.oneLiner ?? s.firstPrompt ?? '';
    push({ id: `session:${s.id}`, label, hint, kind: 'session' }, `${label} ${hint}`);
  }
  scored.sort((a, b) => b.score - a.score || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.item.label.localeCompare(b.item.label));
  return { query, items: scored.slice(0, 30).map((s) => s.item) };
}
```

- [ ] **Step 4: promote.ts を書く**

`packages/ui/src/presenters/promote.ts`：

```ts
import type { State } from '../mediator/types.ts';
import { aliveRunOf, type Store } from '../store/store.ts';

export type PromoteProps = { sessionId: string; sessionName: string; runAlive: boolean; submitting: boolean; error: string | null };
export type PromotedProps = { projectId: string; projectName: string; moved: boolean; reason: string | null };

/** 昇格ダイアログ。run が生きているときはファイルを移動できないので、View が注意書きを出せるように渡す。 */
export function presentPromote(state: State, store: Store): PromoteProps | null {
  if (state.overlay.kind !== 'promote') return null;
  const id = state.overlay.sessionId;
  return {
    sessionId: id,
    sessionName: store.sessions[id]?.name ?? id,
    runAlive: aliveRunOf(store, id) !== null,
    submitting: state.promote.kind === 'submitting',
    error: state.promote.kind === 'failed' ? state.promote.message : null,
  };
}

/** 昇格の完了ダイアログ。移動しなかったときはその理由を出す。 */
export function presentPromoted(state: State, store: Store): PromotedProps | null {
  if (state.overlay.kind !== 'promoted') return null;
  const o = state.overlay;
  return { projectId: o.projectId, projectName: store.projects[o.projectId]?.name ?? o.projectId, moved: o.moved, reason: o.reason };
}
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui/src/presenters && npx tsc -p packages/ui --noEmit`
Expected: presenters は PASS。`tsc` のエラーは View と `Root.tsx` の箇所だけに限られる。

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/presenters
git commit -m "feat(ui): command palette fuzzy matching and promote dialog presenters"
```

---

### Task 22: View（ゲージ、数字の回転、FLIP、TODO、メモ、アーティファクト、プロジェクト画面）

**Files:**
- Create: `packages/ui/src/views/primitives/UsageGauge.tsx`、`packages/ui/src/views/primitives/RollingNumber.tsx`、`packages/ui/src/views/primitives/flip.ts`、`packages/ui/src/views/TodoList.tsx`、`packages/ui/src/views/MemoEditor.tsx`、`packages/ui/src/views/ArtifactCards.tsx`
- Modify: `packages/ui/src/views/Header.tsx`、`packages/ui/src/views/ProjectCard.tsx`、`packages/ui/src/views/ProjectsScreen.tsx`、`packages/ui/src/views/ProjectScreen.tsx`、`packages/ui/src/styles/base.css`
- Test: `packages/ui/src/views/workbench.test.tsx`（新規、jsdom）

**Interfaces:**
- Consumes: Task 20 の `UsageProps`、`TodoItemProps`、`ArtifactCardProps`、`ProjectProps`、`ProjectCardProps`、`percentLabel`。
- Produces:
  ```ts
  export function UsageGauge(props: { label: string; percent: number | null }): JSX.Element;
  export function RollingNumber(props: { value: number | null; suffix?: string }): JSX.Element;
  export function useFlip(keys: string[]): (key: string) => (el: HTMLElement | null) => void;
  export function TodoList(props: { projectId: string; todos: TodoItemProps[] }): JSX.Element;
  export function MemoEditor(props: { projectId: string; markdown: string; updatedAt: number }): JSX.Element;
  export function ArtifactCards(props: { projectId: string | null; artifacts: ArtifactCardProps[]; canAdd: boolean }): JSX.Element;
  export function Header(props: { crumbs: ShellProps['crumbs']; searchText: string; connection: ShellProps['connection']; indexLabel: string | null; usage: UsageProps }): JSX.Element;
  ```
- `TodoList` の入力欄の `id` は `todo-input` にする（`focus(todoInput)` の対象である）。
- `MemoEditor` は下書きを持つ唯一の View である。外から新しい本文が届いたとき、下書きが無ければ黙って差し替え、下書きがあれば「外部で更新されました」と「読み込む」を出して下書きを残す。
- `ArtifactCards` の `canAdd` が真のときだけ URL の追加欄を出す。セッション画面では偽にする。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/workbench.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { IntentRoot } from '../intent/chain.tsx';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { Header } from './Header.tsx';
import { MemoEditor } from './MemoEditor.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';
import { TodoList } from './TodoList.tsx';
import { UsageGauge } from './primitives/UsageGauge.tsx';

const art = (id: string, over: Partial<ArtifactCardProps> = {}): ArtifactCardProps => ({ id, title: '題名 ' + id, description: '説明', favicon: '📊', url: 'https://claude.ai/code/artifact/' + id, lastPublished: '1 分前', versionCount: 2, canOpenEditor: false, ...over });
const wrap = (node: ReactNode, onIntent = vi.fn()) => { render(<IntentRoot onIntent={onIntent}>{node}</IntentRoot>); return onIntent; };

describe('UsageGauge', () => {
  it('値があれば百分率、無ければ未取得', () => {
    render(<UsageGauge label="5h" percent={84} />);
    expect(screen.getByLabelText('5h').getAttribute('aria-valuenow')).toBe('84');
    expect(screen.getByText('84%')).toBeTruthy();
    render(<UsageGauge label="7d" percent={null} />);
    expect(screen.getAllByText('未取得').length).toBeGreaterThan(0);
  });
});

describe('Header', () => {
  it('2 つのゲージと最終更新を出す', () => {
    render(<IntentRoot onIntent={() => {}}><Header crumbs={[{ label: 'Home' }]} searchText="" connection="connected" indexLabel={null} usage={{ fiveHour: 47, sevenDay: 7, updatedLabel: '10 分前' }} /></IntentRoot>);
    expect(screen.getByLabelText('5 時間の使用率')).toBeTruthy();
    expect(screen.getByLabelText('7 日の使用率')).toBeTruthy();
    expect(screen.getByText('最終更新 10 分前')).toBeTruthy();
  });
});

describe('TodoList', () => {
  it('追加、反転、削除の Intent を出す', () => {
    const onIntent = wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '買う', done: false }, { id: 't2', text: '済んだ', done: true }]} />);
    const input = screen.getByLabelText('TODO を追加');
    fireEvent.change(input, { target: { value: '書く' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.add', projectId: 'p1', text: '書く' });
    fireEvent.click(screen.getByLabelText('買う'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.toggle', id: 't1' });
    fireEvent.click(screen.getByLabelText('済んだ を削除'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.remove', id: 't2' });
    expect(input.getAttribute('id')).toBe('todo-input');
  });
  it('空の入力では何も出さない', () => {
    const onIntent = wrap(<TodoList projectId="p1" todos={[]} />);
    fireEvent.keyDown(screen.getByLabelText('TODO を追加'), { key: 'Enter' });
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.getByText('TODO はまだありません')).toBeTruthy();
  });
});

describe('MemoEditor', () => {
  it('保存すると memo.save を出す', () => {
    const onIntent = wrap(<MemoEditor projectId="p1" markdown="# a" updatedAt={1} />);
    fireEvent.change(screen.getByLabelText('メモ'), { target: { value: '# b' } });
    fireEvent.click(screen.getByText('保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'memo.save', projectId: 'p1', markdown: '# b' });
  });
  it('下書きが無ければ外部の更新をそのまま取り込む', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# a" updatedAt={1} /></IntentRoot>);
    rerender(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# 外" updatedAt={2} /></IntentRoot>);
    expect((screen.getByLabelText('メモ') as HTMLTextAreaElement).value).toBe('# 外');
    expect(screen.queryByText('外部で更新されました')).toBeNull();
  });
  it('下書きがあれば捨てずに知らせ、読み込むで差し替える', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# a" updatedAt={1} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('メモ'), { target: { value: '# 書きかけ' } });
    rerender(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# 外" updatedAt={2} /></IntentRoot>);
    expect((screen.getByLabelText('メモ') as HTMLTextAreaElement).value).toBe('# 書きかけ');
    expect(screen.getByText('外部で更新されました')).toBeTruthy();
    fireEvent.click(screen.getByText('読み込む'));
    expect((screen.getByLabelText('メモ') as HTMLTextAreaElement).value).toBe('# 外');
  });
});

describe('ArtifactCards', () => {
  it('クリックで開き、編集ボタンは元ファイルがあるときだけ出す', () => {
    const onIntent = wrap(<ArtifactCards projectId="p1" artifacts={[art('a1'), art('a2', { canOpenEditor: true })]} canAdd />);
    fireEvent.click(screen.getByText('題名 a1'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.open', id: 'a1' });
    expect(screen.getAllByText('VS Code で開く')).toHaveLength(1);
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.openEditor', id: 'a2' });
    const url = screen.getByLabelText('アーティファクトの URL');
    fireEvent.change(url, { target: { value: 'https://claude.ai/code/artifact/x' } });
    fireEvent.click(screen.getByText('追加'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.add', projectId: 'p1', url: 'https://claude.ai/code/artifact/x' });
  });
  it('canAdd が偽なら追加欄を出さない', () => {
    wrap(<ArtifactCards projectId={null} artifacts={[]} canAdd={false} />);
    expect(screen.queryByLabelText('アーティファクトの URL')).toBeNull();
    expect(screen.getByText('アーティファクトはまだありません')).toBeTruthy();
  });
});

describe('ProjectScreen の右レール', () => {
  const props = { id: 'p1', name: 'alpha', path: '/w/alpha', resolved: true, status: 'active' as const, sessions: [], notFound: false, isScratch: false, todos: [{ id: 't1', text: '買う', done: false }], memo: { markdown: '# a', updatedAt: 1 }, artifacts: [art('a1')] };
  it('TODO とメモとアーティファクトを並べ、折りたためる', () => {
    wrap(<ProjectScreen {...props} />);
    expect(screen.getByLabelText('TODO を追加')).toBeTruthy();
    expect(screen.getByLabelText('メモ')).toBeTruthy();
    expect(screen.getByText('題名 a1')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('右レールを隠す'));
    expect(screen.queryByLabelText('TODO を追加')).toBeNull();
  });
  it('スクラッチのプロジェクトは操作を絞る', () => {
    wrap(<ProjectScreen {...props} isScratch />);
    expect(screen.getByText('スクラッチで始める')).toBeTruthy();
    expect(screen.queryByText('新規セッション')).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/workbench`
Expected: FAIL（ファイルが無い）

- [ ] **Step 3: primitives を作る**

`packages/ui/src/views/primitives/RollingNumber.tsx`：

```tsx
import { useEffect, useState } from 'react';

/** 値が変わったとき、古い値を上へ、新しい値を下から上へ 150 ミリ秒で動かす。桁ごとには分けない。 */
export function RollingNumber(props: { value: number | null; suffix?: string }) {
  const [prev, setPrev] = useState<number | null>(props.value);
  const [rolling, setRolling] = useState(false);
  useEffect(() => {
    if (props.value === prev) return;
    setRolling(true);
    const t = setTimeout(() => { setPrev(props.value); setRolling(false); }, 150);
    return () => clearTimeout(t);
  }, [props.value, prev]);
  const text = (v: number | null) => (v === null ? '未取得' : `${v}${props.suffix ?? ''}`);
  return (
    <span className="roll" data-rolling={rolling ? 'true' : undefined}>
      <span className="roll-old" aria-hidden="true">{text(prev)}</span>
      <span className="roll-new">{text(props.value)}</span>
    </span>
  );
}
```

`packages/ui/src/views/primitives/UsageGauge.tsx`：

```tsx
import { percentLabel } from '../../presenters/format.ts';
import { RollingNumber } from './RollingNumber.tsx';

/** 5 時間と 7 日の使用率の棒。幅 48px、高さ 6px で、80% 以上は警告色にする。 */
export function UsageGauge(props: { label: string; percent: number | null }) {
  const pct = props.percent === null ? 0 : Math.max(0, Math.min(100, props.percent));
  return (
    <span className="gauge" title={`${props.label} ${percentLabel(props.percent)}`}>
      <span className="gauge-bar" role="meter" aria-label={props.label} aria-valuenow={props.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
        <span className="gauge-fill" data-high={pct >= 80 ? 'true' : undefined} style={{ width: `${pct}%` }} />
      </span>
      <span className="gauge-num mono"><RollingNumber value={props.percent === null ? null : Math.round(props.percent)} suffix="%" /></span>
    </span>
  );
}
```

`packages/ui/src/views/primitives/flip.ts`：

```ts
import { useLayoutEffect, useRef } from 'react';

/**
 * 並びが変わったカードを元の位置から現在位置へ滑らせる（FLIP）。
 * 返した関数を ref に渡すと、その要素の位置を毎回の描画で覚える。
 */
export function useFlip(keys: string[]): (key: string) => (el: HTMLElement | null) => void {
  const nodes = useRef(new Map<string, HTMLElement>());
  const prev = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    // 先に全部の現在位置を測る。測る前に transform を入れると値がずれる。
    const now = new Map<string, DOMRect>();
    for (const [key, el] of nodes.current) now.set(key, el.getBoundingClientRect());
    for (const [key, el] of nodes.current) {
      const before = prev.current.get(key);
      const after = now.get(key);
      if (!before || !after) continue;
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (dx === 0 && dy === 0) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => { el.style.transition = 'transform var(--dur) var(--ease)'; el.style.transform = ''; });
    }
    prev.current = now;
  }, [keys.join('|')]);
  return (key) => (el) => { if (el) nodes.current.set(key, el); else nodes.current.delete(key); };
}
```

- [ ] **Step 4: TodoList、MemoEditor、ArtifactCards を作る**

`packages/ui/src/views/TodoList.tsx`：

```tsx
import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { TodoItemProps } from '../presenters/project.ts';
import { Icon } from './primitives/Icon.tsx';

/** プロジェクトの TODO。並び替えは持たず、完了した項目も同じ並びに打消し線で残す。 */
export function TodoList(props: { projectId: string; todos: TodoItemProps[] }) {
  const emit = useEmit();
  const [text, setText] = useState('');
  const add = () => { if (!text.trim()) return; emit({ type: 'todo.add', projectId: props.projectId, text }); setText(''); };
  return (
    <div className="todos">
      {props.todos.length === 0 && <div className="faint">TODO はまだありません</div>}
      <ul className="todo-list">
        {props.todos.map((t) => (
          <li key={t.id} className="todo" data-done={t.done ? 'true' : undefined}>
            <input type="checkbox" checked={t.done} aria-label={t.text} onChange={() => emit({ type: 'todo.toggle', id: t.id })} />
            <span className="todo-text">{t.text}</span>
            <button className="btn todo-del" aria-label={`${t.text} を削除`} onClick={() => emit({ type: 'todo.remove', id: t.id })}><Icon name="close" /></button>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
        <input id="todo-input" className="input" style={{ flex: 1 }} aria-label="TODO を追加" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="btn" onClick={add}><Icon name="add" />追加</button>
      </div>
    </div>
  );
}
```

`packages/ui/src/views/MemoEditor.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';

/**
 * プロジェクトの Markdown メモ。
 * 下書きを持つ唯一の View である。外部で更新されたときは下書きを捨てず、知らせるだけにする。
 */
export function MemoEditor(props: { projectId: string; markdown: string; updatedAt: number }) {
  const emit = useEmit();
  const [draft, setDraft] = useState(props.markdown);
  const [base, setBase] = useState({ markdown: props.markdown, updatedAt: props.updatedAt });
  const dirty = draft !== base.markdown;
  const external = props.updatedAt > base.updatedAt && dirty;
  useEffect(() => {
    if (props.updatedAt <= base.updatedAt || draft !== base.markdown) return;
    setBase({ markdown: props.markdown, updatedAt: props.updatedAt });
    setDraft(props.markdown);
  }, [props.markdown, props.updatedAt]);   // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => { emit({ type: 'memo.save', projectId: props.projectId, markdown: draft }); setBase({ markdown: draft, updatedAt: props.updatedAt }); };
  const reload = () => { setBase({ markdown: props.markdown, updatedAt: props.updatedAt }); setDraft(props.markdown); };
  return (
    <div className="memo field">
      <textarea className="input mono memo-area" aria-label="メモ" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        {external && <><span className="faint">外部で更新されました</span><button className="btn" onClick={reload}>読み込む</button></>}
        <span className="spacer" />
        <button className="btn btn-primary" disabled={!dirty} onClick={save}>保存</button>
      </div>
    </div>
  );
}
```

`packages/ui/src/views/ArtifactCards.tsx`：

```tsx
import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { Icon } from './primitives/Icon.tsx';

/** アーティファクトのカード。クリックはサーバ側の `open <url>` で既定のブラウザに開く。 */
export function ArtifactCards(props: { projectId: string | null; artifacts: ArtifactCardProps[]; canAdd: boolean }) {
  const emit = useEmit();
  const [url, setUrl] = useState('');
  const add = () => { if (!url.trim() || !props.projectId) return; emit({ type: 'artifact.add', projectId: props.projectId, url }); setUrl(''); };
  return (
    <div className="artifacts">
      {props.artifacts.length === 0 && <div className="faint">アーティファクトはまだありません</div>}
      {props.artifacts.map((a) => (
        <div key={a.id} className="card artifact" role="link" tabIndex={0} onClick={() => emit({ type: 'artifact.open', id: a.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'artifact.open', id: a.id }); }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden="true">{a.favicon}</span>
            <span className="card-title" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</span>
          </div>
          {a.description && <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.description}</div>}
          <div className="faint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{a.lastPublished}</span>
            <span>更新 {a.versionCount} 回</span>
            <span className="spacer" />
            {a.canOpenEditor && <button className="btn" onClick={(e) => { e.stopPropagation(); emit({ type: 'artifact.openEditor', id: a.id }); }}><Icon name="openEditor" />VS Code で開く</button>}
          </div>
        </div>
      ))}
      {props.canAdd && props.projectId && (
        <div style={{ display: 'flex', gap: 4 }}>
          <input className="input mono" style={{ flex: 1 }} aria-label="アーティファクトの URL" placeholder="https://claude.ai/code/artifact/..." value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          <button className="btn" onClick={add}><Icon name="add" />追加</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Header にゲージを足す**

`packages/ui/src/views/Header.tsx` の props に `usage: UsageProps` を足し、`spacer` の後に置く。

```tsx
      <span className="spacer" />
      <span className="gauges">
        <UsageGauge label="5 時間の使用率" percent={props.usage.fiveHour} />
        <UsageGauge label="7 日の使用率" percent={props.usage.sevenDay} />
        {props.usage.updatedLabel && <span className="faint">最終更新 {props.usage.updatedLabel}</span>}
      </span>
      {props.indexLabel && <span className="progress">{props.indexLabel}</span>}
```

import に `UsageGauge` と `UsageProps` を足す。
`Shell.tsx` は `ShellProps` を `Header` に渡しているので、`usage={props.usage}` の受け渡しだけを足す。

- [ ] **Step 6: ProjectCard と ProjectsScreen を直す**

`packages/ui/src/views/ProjectCard.tsx` の最後の `div.faint` の後に足す。

```tsx
      {props.memoHead && <div className="faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.memoHead}</div>}
      <div style={{ display: 'flex' }}>
        <span className="spacer" />
        <button className="btn" onClick={(e) => { e.stopPropagation(); emit({ type: 'session.new.open', projectId: props.id }); }}><Icon name="add" />ここで新規</button>
      </div>
```

`packages/ui/src/views/ProjectsScreen.tsx` のカードの繰り返しに FLIP の ref を足す。

```tsx
import { useFlip } from './primitives/flip.ts';

export function ProjectsScreen(props: ProjectsProps & { filter: string; showArchived: boolean; onFilter: (s: string) => void; onShowArchived: (b: boolean) => void }) {
  // ステータスを変えるとカードが別のセクションへ移るので、その移動だけを FLIP で見せる。
  const flipRef = useFlip(props.sections.flatMap((s) => s.cards.map((c) => `${s.status}:${c.id}`)));
  ...
          {section.cards.map((c) => <div key={c.id} ref={flipRef(`${section.status}:${c.id}`)}><ProjectCard {...c} /></div>)}
  ...
}
```

- [ ] **Step 7: ProjectScreen の右レールを埋める**

`packages/ui/src/views/ProjectScreen.tsx` を置き換える。

```tsx
import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { ProjectProps } from '../presenters/project.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { MemoEditor } from './MemoEditor.tsx';
import { SessionRows } from './SessionRows.tsx';
import { TodoList } from './TodoList.tsx';
import { Icon } from './primitives/Icon.tsx';
import { StatusSelect } from './primitives/StatusSelect.tsx';

/** プロジェクト詳細画面。右レールは TODO とメモとアーティファクトで、折りたためる。 */
export function ProjectScreen(props: ProjectProps) {
  const emit = useEmit();
  const [railOpen, setRailOpen] = useState(true);
  if (props.notFound) return <div className="screen"><div className="empty">プロジェクトが見つかりません</div></div>;
  return (
    <div className="screen" style={{ display: 'grid', gridTemplateColumns: railOpen ? '1fr 280px' : '1fr', gap: 16 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h1 className="h1" style={{ margin: 0 }}>{props.name}</h1>
          {!props.isScratch && <StatusSelect label="ステータス" value={props.status} onChange={(status) => emit({ type: 'project.setStatus', id: props.id, status })} />}
          <span className="spacer" />
          {props.isScratch
            ? <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', scratch: true })}><Icon name="add" />スクラッチで始める</button>
            : <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', projectId: props.id })}><Icon name="add" />新規セッション</button>}
          {!props.isScratch && <button className="btn" onClick={() => emit({ type: 'project.openEditor', id: props.id })}><Icon name="openEditor" />VS Code で開く</button>}
          {!props.isScratch && <button className="btn" onClick={() => emit({ type: 'project.openTerminalApp', id: props.id })}><Icon name="openTerminal" />ターミナルで開く</button>}
          <button className="btn" aria-label={railOpen ? '右レールを隠す' : '右レールを出す'} onClick={() => setRailOpen(!railOpen)}><Icon name={railOpen ? 'paneClose' : 'paneOpen'} /></button>
        </div>
        <div className="mono faint" style={{ marginBottom: 12 }}>{props.path ?? 'この端末にパスがありません'}{!props.resolved && props.path ? '（見つかりません）' : ''}</div>
        <SessionRows rows={props.sessions} height="calc(100vh - 200px)" showProject={false} />
      </div>
      {railOpen && (
        <aside className="rail" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section><h2 className="h2" style={{ marginTop: 0 }}>TODO</h2><TodoList projectId={props.id} todos={props.todos} /></section>
          <section><h2 className="h2">メモ</h2><MemoEditor projectId={props.id} markdown={props.memo?.markdown ?? ''} updatedAt={props.memo?.updatedAt ?? 0} /></section>
          <section><h2 className="h2">アーティファクト</h2><ArtifactCards projectId={props.id} artifacts={props.artifacts} canAdd /></section>
        </aside>
      )}
    </div>
  );
}
```

- [ ] **Step 8: CSS を足す**

`packages/ui/src/styles/base.css` の末尾に足す。

```css
/* 使用量ゲージ。幅 48px、高さ 6px の棒で、80% 以上は警告色にする。 */
.gauges { display: flex; align-items: center; gap: 10px; }
.gauge { display: inline-flex; align-items: center; gap: 4px; }
.gauge-bar { display: inline-block; width: 48px; height: 6px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.gauge-fill { display: block; height: 100%; background: var(--accent); transition: width var(--dur-slow) var(--ease); }
.gauge-fill[data-high='true'] { background: var(--waiting); }
.gauge-num { font-size: var(--fs-xs); color: var(--ink-3); min-width: 32px; }

/* 数字の縦回転。古い値を上へ、新しい値を下から上へ動かす。 */
.roll { position: relative; display: inline-block; overflow: hidden; height: 1.2em; vertical-align: bottom; }
.roll-old { position: absolute; inset: 0; opacity: 0; }
.roll-new { display: block; }
.roll[data-rolling='true'] .roll-old { opacity: 1; animation: roll-up var(--dur) var(--ease) forwards; }
.roll[data-rolling='true'] .roll-new { animation: roll-in var(--dur) var(--ease); }
@keyframes roll-up { to { transform: translateY(-1.2em); opacity: 0; } }
@keyframes roll-in { from { transform: translateY(1.2em); } }

/* TODO。完了は打消し線で同じ並びに残す。 */
.todo-list { list-style: none; margin: 0; padding: 0; }
.todo { display: flex; align-items: center; gap: 6px; height: var(--row-h); }
.todo-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: color var(--dur) var(--ease); }
.todo[data-done='true'] .todo-text { text-decoration: line-through; color: var(--ink-3); }
.todo-del { visibility: hidden; padding: 0 6px; }
.todo:hover .todo-del, .todo:focus-within .todo-del { visibility: visible; }
.memo-area { width: 100%; resize: vertical; }

/* アーティファクトのカード。右レールでは 1 列に積む。 */
.artifacts { display: flex; flex-direction: column; gap: 8px; }
.artifact { cursor: pointer; }
.rail { min-width: 0; }
```

- [ ] **Step 9: テストと型検査**

Run: `npx vitest run packages/ui && npx tsc -p packages/ui --noEmit`
Expected: `workbench.test.tsx` は PASS。`screens.test.tsx` の `ProjectScreen` の期待（「次のフェーズで使えるようになります」）は成り立たなくなるので、その 1 件を消す。`Shell.test.tsx` と `Root.test.tsx` の `Header` の呼び出しに `usage={{ fiveHour: null, sevenDay: null, updatedLabel: null }}` を足す。`tsc` のエラーは `SessionScreen` と `Root.tsx` の箇所だけに限られる。

- [ ] **Step 10: コミット**

```bash
git add packages/ui/src
git commit -m "feat(ui): usage gauges, rolling numbers, flip, todo list, memo editor and artifact cards"
```

---

### Task 23: View（SplitPane、タブの分割、セッション画面、スクラッチの起動ダイアログ）

**Files:**
- Create: `packages/ui/src/views/SplitPane.tsx`
- Modify: `packages/ui/src/views/TabStrip.tsx`、`packages/ui/src/views/SessionScreen.tsx`、`packages/ui/src/views/NewSessionDialog.tsx`、`packages/ui/src/styles/base.css`
- Test: `packages/ui/src/views/SplitPane.test.tsx`（新規、jsdom）、`packages/ui/src/views/SessionScreen.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 20 の `SessionProps`（`contextPercent`、`cost`、`artifacts`、`summaryPending`、`summaryError`、`fromScratch`、`canPromote`、`split`、`canSplit`）と `NewSessionProps.scratch`。フェーズ 2 の `TabStrip`、`TerminalPane`、`TerminalHostContext`。
- Produces:
  ```ts
  export function SplitPane(props: { left: ReactNode; right: ReactNode }): JSX.Element;
  export function TabStrip(props: { sessionId: string; tabs: SessionProps['tabs']; canAdd: boolean; canSplit: boolean; split: boolean }): JSX.Element;
  export function SessionScreen(props: SessionProps & { terminalStatus: TerminalStatus | null }): JSX.Element;
  ```
- `SplitPane` は幅の割合を自分の `useState` に持ち、`IntentBoundary` で `split.resize` を横取りする。割合は 0.2 から 0.8 に丸め、保存しない。
- 仕切りは `role="separator"` で、ドラッグと左右の矢印キーの両方で動く。ドラッグ中の `split.resize` は境界で止まるので Mediator には 1 件も届かない。
- `TabStrip` の分割ボタンは `canSplit` が偽のとき `disabled` にし、押せる状態のときだけ `split.toggle` を出す。
- セッションヘッダーはコンテキスト使用率、推定コスト、要約の状態（作成中と失敗）、スクラッチの注意書き、「プロジェクトに昇格」を出す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/SplitPane.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { SplitPane } from './SplitPane.tsx';

describe('SplitPane', () => {
  it('幅の変更は中で処理し、Root には届かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SplitPane left={<div>左</div>} right={<div>右</div>} /></IntentRoot>);
    const host = screen.getByTestId('split');
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window);
    expect(host.style.gridTemplateColumns.startsWith('0.3fr')).toBe(true);
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('矢印キーでも動き、0.2 から 0.8 に丸める', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SplitPane left={<div>左</div>} right={<div>右</div>} /></IntentRoot>);
    const host = screen.getByTestId('split');
    const sep = screen.getByRole('separator');
    for (let i = 0; i < 20; i++) fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(host.style.gridTemplateColumns.startsWith('0.2fr')).toBe(true);
    for (let i = 0; i < 40; i++) fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(host.style.gridTemplateColumns.startsWith('0.8fr')).toBe(true);
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('境界を通らない Intent はそのまま上へ渡す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SplitPane left={<button onClick={() => {}}>左</button>} right={<div>右</div>} /></IntentRoot>);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Escape' });
    expect(onIntent).not.toHaveBeenCalled();
  });
});
```

`packages/ui/src/views/SessionScreen.test.tsx` に足す。

```tsx
describe('フェーズ 3 のセッション画面', () => {
  const base = { ...sessionProps(), contextPercent: 62, cost: '$1.20', artifacts: [{ id: 'a1', title: '題名', description: null, favicon: '📊', url: 'https://claude.ai/code/artifact/a1', lastPublished: '1 分前', versionCount: 1, canOpenEditor: false }], summaryPending: false, summaryError: null, fromScratch: false, canPromote: false, split: null, canSplit: false };
  it('コンテキストとコストとアーティファクトを出す', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} terminalStatus={null} /></IntentRoot>);
    expect(screen.getByLabelText('コンテキスト使用率').getAttribute('aria-valuenow')).toBe('62');
    expect(screen.getByText('$1.20')).toBeTruthy();
    expect(screen.getByText('題名')).toBeTruthy();
  });
  it('要約の作成中と失敗を出す', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} summaryPending terminalStatus={null} /></IntentRoot>);
    expect(screen.getByText('要約を作成しています')).toBeTruthy();
    rerender(<IntentRoot onIntent={() => {}}><SessionScreen {...base} summaryError="LM Studio に繋がりません" terminalStatus={null} /></IntentRoot>);
    expect(screen.getByText('要約を作成できませんでした')).toBeTruthy();
  });
  it('スクラッチの注意書きと昇格ボタン', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SessionScreen {...base} fromScratch terminalStatus={null} /></IntentRoot>);
    expect(screen.getByText('再開すると cwd はスクラッチのままです')).toBeTruthy();
    rerender(<IntentRoot onIntent={onIntent}><SessionScreen {...base} canPromote terminalStatus={null} /></IntentRoot>);
    fireEvent.click(screen.getByText('プロジェクトに昇格'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.promote.open', id: base.id });
  });
  it('要約を作り直すボタン', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionScreen {...base} terminalStatus={null} /></IntentRoot>);
    fireEvent.click(screen.getByText('要約を作り直す'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'summary.regenerate', sessionId: base.id });
  });
  it('分割の指定があれば 2 つのターミナルを並べる', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} canSplit split={{ left: 't1', right: 't2' }} terminalStatus="connected" /></IntentRoot>);
    expect(screen.getByTestId('split')).toBeTruthy();
    expect(screen.getAllByTestId(/^term-/)).toHaveLength(2);
  });
});

describe('TabStrip の分割ボタン', () => {
  it('タブが 1 つなら押せない', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><TabStrip sessionId="s1" tabs={[{ id: 't1', title: 'Claude', kind: 'agent', selected: true, closable: false }]} canAdd canSplit={false} split={false} /></IntentRoot>);
    const btn = screen.getByLabelText('分割') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    rerender(<IntentRoot onIntent={onIntent}><TabStrip sessionId="s1" tabs={[{ id: 't1', title: 'Claude', kind: 'agent', selected: true, closable: false }, { id: 't2', title: 'シェル 1', kind: 'shell', selected: false, closable: true }]} canAdd canSplit split={false} /></IntentRoot>);
    fireEvent.click(screen.getByLabelText('分割'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'split.toggle' });
  });
});

describe('NewSessionDialog のスクラッチ', () => {
  it('スクラッチではプロジェクトを選ばせず、scratch を付けて送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog projects={[{ id: 'p1', name: 'alpha', path: '/w/alpha' }]} projectId={null} submitting={false} error={null} scratch /></IntentRoot>);
    expect(screen.queryByLabelText('プロジェクト')).toBeNull();
    expect(screen.getByText('スクラッチで始める')).toBeTruthy();
    fireEvent.click(screen.getByText('起動'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.submit', params: expect.objectContaining({ scratch: true }) });
  });
});
```

`sessionProps()` はフェーズ 2 のテストにある補助である。
`TabStrip` と `NewSessionDialog` の import が無ければ足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/SplitPane packages/ui/src/views/SessionScreen`
Expected: FAIL

- [ ] **Step 3: SplitPane を作る**

`packages/ui/src/views/SplitPane.tsx`：

```tsx
import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Intent } from '@agent-hangar/shared';
import { IntentBoundary, useEmit, type Handled } from '../intent/chain.tsx';

const clamp = (r: number) => Math.max(0.2, Math.min(0.8, r));

/** 仕切り。境界の内側なので、ここで出す split.resize は SplitPane が受けて止める。 */
function Divider(props: { hostRef: RefObject<HTMLDivElement | null>; ratio: number }) {
  const emit = useEmit();
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const host = props.hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const move = (ev: PointerEvent) => emit({ type: 'split.resize', ratio: (ev.clientX - rect.left) / rect.width });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    emit({ type: 'split.resize', ratio: props.ratio + (e.key === 'ArrowLeft' ? -0.02 : 0.02) });
  };
  return <div className="split-divider" role="separator" aria-label="分割の幅" aria-orientation="vertical" tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} />;
}

/**
 * 2 つのペーンを横に並べる。
 * 幅の割合は中間層のここだけで持ち、Mediator には渡さない（ドラッグ中に毎フレーム状態機械を回さないため）。
 * 幅は保存せず、開き直すと 0.5 に戻る。
 */
export function SplitPane(props: { left: ReactNode; right: ReactNode }) {
  const [ratio, setRatio] = useState(0.5);
  const hostRef = useRef<HTMLDivElement>(null);
  const handle = useCallback((intent: Intent): Handled => {
    if (intent.type !== 'split.resize') return { handled: false };
    setRatio(clamp(intent.ratio));
    return { handled: true };
  }, []);
  return (
    <IntentBoundary handle={handle}>
      {/* 類名は split-h にする。.split はフェーズ 2 の SessionScreen がターミナルとトランスクリプトの 2 列に使っている。 */}
      <div className="split-h" data-testid="split" ref={hostRef} style={{ gridTemplateColumns: `${ratio}fr 6px ${Number((1 - ratio).toFixed(4))}fr` }}>
        <div className="split-pane">{props.left}</div>
        <Divider hostRef={hostRef} ratio={ratio} />
        <div className="split-pane">{props.right}</div>
      </div>
    </IntentBoundary>
  );
}
```

- [ ] **Step 4: TabStrip に分割ボタンを足す**

`packages/ui/src/views/primitives/Icon.tsx` の `ICONS` に `split: Columns2` を足す（`Columns2` を `lucide-react` の import に加える）。
View は `lucide-react` を直接 import しないので、新しいアイコンは必ずここを通す。

`packages/ui/src/views/TabStrip.tsx` の props に `canSplit: boolean; split: boolean` を足し、シェルタブを追加するボタンの隣に置く。

```tsx
      <button className="btn tab-action" aria-label="分割" aria-pressed={props.split} disabled={!props.canSplit} title={props.canSplit ? '分割（⌘\\）' : 'タブが 2 つ必要です'} onClick={() => emit({ type: 'split.toggle' })}><Icon name="split" /></button>
```

- [ ] **Step 5: SessionScreen を広げる**

`packages/ui/src/views/SessionScreen.tsx` の import に足す。

```tsx
import { ArtifactCards } from './ArtifactCards.tsx';
import { SplitPane } from './SplitPane.tsx';
import { UsageGauge } from './primitives/UsageGauge.tsx';
```

ヘッダーのモデルと effort の行の後に足す。

```tsx
        <span className="gauge-wrap" title="コンテキスト使用率">
          <span className="faint">コンテキスト</span>
          <span className="gauge-bar" role="meter" aria-label="コンテキスト使用率" aria-valuenow={props.contextPercent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            <span className="gauge-fill" data-high={(props.contextPercent ?? 0) >= 80 ? 'true' : undefined} style={{ width: `${Math.max(0, Math.min(100, props.contextPercent ?? 0))}%` }} />
          </span>
        </span>
        {props.cost && <span className="mono muted">{props.cost}</span>}
```

要約の行の横に足す。

```tsx
        {props.summaryPending && <span className="faint">要約を作成しています</span>}
        {props.summaryError && <span className="faint" title={props.summaryError}>要約を作成できませんでした</span>}
        <button className="btn" onClick={() => emit({ type: 'summary.regenerate', sessionId: props.id })}>要約を作り直す</button>
```

操作のボタンの並びに足す。

```tsx
        {props.fromScratch && <span className="faint">再開すると cwd はスクラッチのままです</span>}
        {props.canPromote && <button className="btn" onClick={() => emit({ type: 'session.promote.open', id: props.id })}><Icon name="promote" />プロジェクトに昇格</button>}
```

ヘッダーの操作のボタンはフェーズ 2 からすべて `Icon` を伴うので、`packages/ui/src/views/primitives/Icon.tsx` の `ICONS` に `promote: FolderUp` を足す（`FolderUp` を `lucide-react` の import に加える）。
`Icon` は `SessionScreen.tsx` が既に import している。

ヘッダーの下、本体の前にアーティファクトの帯を足す。

```tsx
      {props.artifacts.length > 0 && <section className="session-artifacts"><ArtifactCards projectId={null} artifacts={props.artifacts} canAdd={false} /></section>}
```

本体のターミナルの置き方を置き換える。
フェーズ 2 は選択中のタブ 1 つを `TerminalPane` で描いていた。
分割の指定があるときは 2 つ並べる。

```tsx
  const pane = (tabId: string) => <TerminalPane tabId={tabId} status={props.terminalStatus} hint={terminalHint} />;
  const terminals = props.split
    ? <SplitPane left={pane(props.split.left)} right={pane(props.split.right)} />
    : (props.selectedTab ? pane(props.selectedTab) : <div className="empty">タブを選んでください</div>);
```

`TabStrip` の呼び出しに `canSplit={props.canSplit} split={props.split !== null}` を足す。
`TerminalPane` のルート要素に `data-testid={`term-${props.tabId}`}` を足す。

- [ ] **Step 6: NewSessionDialog にスクラッチを足す**

`packages/ui/src/views/NewSessionDialog.tsx` を直す。
フェーズ 2 のこの View は非制御フォームで、`useRef<HTMLFormElement>` と `FormData` から送信のときにまとめて読む。
`useState` は持たない。その骨格を保ったまま、次の 3 か所だけを変える。

`submit` の `params` の組み立ての先頭を置き換える。

```tsx
    const params: LaunchParams = {};
    // スクラッチはプロジェクトを持たず、サーバが使い捨てのディレクトリを作る。
    if (props.scratch) params.scratch = true;
    else { const projectId = text('projectId'); if (projectId) params.projectId = projectId; }
```

見出しを置き換える。

```tsx
        <b>{props.scratch ? 'スクラッチで始める' : '新しいセッション'}</b>
```

プロジェクトの `label` を置き換える（スクラッチのときは選択欄を出さず、断りを 1 行出す）。
`label` の文字と `htmlFor`、`option` に出すパスの表示はフェーズ 2 のまま残す。

```tsx
        {props.scratch
          ? <div className="faint">~/.agent-hangar/scratch/ の下に日時のディレクトリを作って起動します。後からプロジェクトに昇格できます。</div>
          : (
            <label className="field" htmlFor="new-session-project">プロジェクト
              <select id="new-session-project" className="select" name="projectId" defaultValue={props.projectId ?? ''}>
                <option value="">選んでください</option>
                {props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.path ? `　${p.path}` : ''}</option>)}
              </select>
            </label>
          )}
```

名前、初期プロンプト、`Fold` の中の詳細（model、effort、permission mode、worktree、追加ディレクトリ）、`dialog-foot` の並びはフェーズ 2 のままにする。

- [ ] **Step 7: CSS を足す**

`packages/ui/src/styles/base.css` の末尾に足す。

```css
/* 分割。幅は grid のトラックで持ち、仕切りは 6px の掴める帯にする。
   既存の .split（SessionScreen のターミナルとトランスクリプトの 2 列）は上書きしない。 */
.split-h { display: grid; height: 100%; min-height: 0; transition: grid-template-columns var(--dur) var(--ease); }
.split-pane { min-width: 0; min-height: 0; overflow: hidden; }
.split-divider { cursor: col-resize; background: var(--line); }
.split-divider:hover, .split-divider:focus-visible { background: var(--line-strong); outline: none; }
.gauge-wrap { display: inline-flex; align-items: center; gap: 4px; }
.session-artifacts { padding: 4px 0; }
.tab-action { padding: 0 6px; }
```

ドラッグ中は `transition` が邪魔になるので、`.split` のトランジションは `grid-template-columns` だけに限り、仕切りを掴んでいる間は `--dur` が 0 になる `prefers-reduced-motion` と同じ見え方でよい。

- [ ] **Step 8: テストと型検査**

Run: `npx vitest run packages/ui && npx tsc -p packages/ui --noEmit`
Expected: `SplitPane.test.tsx` と `SessionScreen.test.tsx` は PASS。`tsc` のエラーは `Root.tsx` の箇所だけに限られる。

- [ ] **Step 9: コミット**

```bash
git add packages/ui/src
git commit -m "feat(ui): resizable split pane, split tab control, session header context and scratch launch dialog"
```

---

### Task 24: View（セッション行の 1 行メモとキー操作）

**Files:**
- Modify: `packages/ui/src/views/SessionRows.tsx`、`packages/ui/src/styles/base.css`
- Test: `packages/ui/src/views/SessionRows.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 20 の `SessionRowProps`（`cost`、`runId`、`memo`）。
- Produces:
  ```ts
  export function SessionRows(props: { rows: SessionRowProps[]; height: number | string; showProject: boolean; showSnippets?: boolean; emptyText?: string }): JSX.Element;
  ```
- 列は左から、状態点、名前、要約、（プロジェクト）、状態、モデル、変更、PR、コスト、メモ、最終活動にする。
- キー操作は一覧そのものにフォーカスがあるときだけ効く。`j` と `k` で上下、`Enter` で開く、`o` でターミナル、`e` で VS Code、`m` でメモの編集に入る。
- 編集中の入力欄では `j` と `k` を横取りしない。`Enter` で `session.setMemo` を出して編集を閉じ、`Esc` で捨てる。
- `o` は `runId` があるときだけ `session.openTerminalApp` を出す。無ければ何もしない。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/SessionRows.test.tsx` に足す。

```tsx
const p3Row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({
  id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, stateLabel: '完了', model: 'opus 4.1', effort: 'high',
  when: '1 時間前', whenAbs: '2026-09-18 11:00', filesChanged: 2, prUrl: null, memo: null, hasTranscript: true, cost: '$0.50', runId: null, ...over,
});

describe('SessionRows のフェーズ 3', () => {
  it('コストとメモの列を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[p3Row('s1', { memo: '覚書' })]} height={400} showProject={false} /></IntentRoot>);
    expect(screen.getByText('$0.50')).toBeTruthy();
    expect(screen.getByText('覚書')).toBeTruthy();
  });
  it('j と k で選び、Enter で開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} showProject={false} /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'k' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
  });
  it('o はターミナル、e は VS Code', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1', { runId: 'r1' }), p3Row('s2')]} height={400} showProject={false} /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'o' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.openTerminalApp', runId: 'r1' });
    fireEvent.keyDown(list, { key: 'e' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.openEditor', sessionId: 's1' });
    onIntent.mockClear();
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'o' });
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('m でメモの入力欄に変わり、Enter で保存、Esc で捨てる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1', { memo: '前' })]} height={400} showProject={false} /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'm' });
    const input = screen.getByLabelText('名前 s1 のメモ') as HTMLInputElement;
    expect(input.value).toBe('前');
    fireEvent.change(input, { target: { value: '後' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: '後' });
    expect(screen.queryByLabelText('名前 s1 のメモ')).toBeNull();
    onIntent.mockClear();
    fireEvent.keyDown(list, { key: 'm' });
    fireEvent.change(screen.getByLabelText('名前 s1 のメモ'), { target: { value: '捨てる' } });
    fireEvent.keyDown(screen.getByLabelText('名前 s1 のメモ'), { key: 'Escape' });
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('名前 s1 のメモ')).toBeNull();
  });
  it('鉛筆ボタンでも編集に入り、行は開かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1')]} height={400} showProject={false} /></IntentRoot>);
    fireEvent.click(screen.getByLabelText('名前 s1 のメモを編集'));
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.getByLabelText('名前 s1 のメモ')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/SessionRows`
Expected: FAIL

- [ ] **Step 3: SessionRows を置き換える**

`packages/ui/src/views/SessionRows.tsx`：

```tsx
import { useRef, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { Icon } from './primitives/Icon.tsx';
import { RelativeTime } from './primitives/RelativeTime.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { VirtualList } from './primitives/VirtualList.tsx';

const cols = (showProject: boolean) => `16px minmax(160px, 1.2fr) minmax(200px, 2fr) ${showProject ? '120px ' : ''}72px 110px 48px 32px 64px minmax(120px, 1fr) 80px`;

/** 行が無いときに出す文言。emptyText で差し替えられる。 */
const DEFAULT_EMPTY_TEXT = 'セッションはまだありません';

export function SessionRows(props: { rows: SessionRowProps[]; height: number | string; showProject: boolean; showSnippets?: boolean; emptyText?: string }) {
  const emit = useEmit();
  // カーソルは一覧の中だけの状態なので Mediator には置かない。-1 は未選択。
  const [cursor, setCursor] = useState(-1);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const hostRef = useRef<HTMLDivElement>(null);

  const startEdit = (r: SessionRowProps) => { setEditing(r.id); setDraft(r.memo ?? ''); };
  const commit = (id: string) => { emit({ type: 'session.setMemo', id, text: draft }); setEditing(null); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 編集中の入力欄のキーは横取りしない。
    if (editing !== null) return;
    const max = props.rows.length - 1;
    const cur = props.rows[cursor];
    switch (e.key) {
      case 'j': setCursor((c) => Math.min(max, c + 1)); break;
      case 'k': setCursor((c) => Math.max(0, c - 1)); break;
      case 'Enter': if (cur) emit({ type: 'session.open', id: cur.id }); break;
      case 'o': if (cur?.runId) emit({ type: 'session.openTerminalApp', runId: cur.runId }); break;
      case 'e': if (cur) emit({ type: 'session.openEditor', sessionId: cur.id }); break;
      case 'm': if (cur) startEdit(cur); break;
      default: return;
    }
    e.preventDefault();
  };

  if (props.rows.length === 0) return <div className="list"><div className="empty">{props.emptyText ?? DEFAULT_EMPTY_TEXT}</div></div>;
  const style = { gridTemplateColumns: cols(props.showProject) };
  const head = (
    <div className="row row-head" style={style} role="row">
      <span /><span>名前</span><span>要約</span>{props.showProject && <span>プロジェクト</span>}<span>状態</span><span>モデル</span><span className="cell-right">変更</span><span>PR</span><span className="cell-right">コスト</span><span>メモ</span><span className="cell-right">最終活動</span>
    </div>
  );
  const rowHeight = (r: SessionRowProps) => 28 + (props.showSnippets ? (r.snippets?.length ?? 0) * 20 : 0);
  return (
    <div className="rows-host" data-testid="session-rows" ref={hostRef} tabIndex={0} onKeyDown={onKeyDown}>
      <VirtualList items={props.rows} rowHeight={(r) => rowHeight(r)} height={props.height} keyOf={(r) => r.id} head={head} render={(r, i) => (
        <div style={{ height: rowHeight(r) }}>
          <div className="row" style={style} role="row" tabIndex={0} data-cursor={i === cursor ? 'true' : undefined}
            onClick={() => emit({ type: 'session.open', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'session.open', id: r.id }); }}>
            <StatusDot status={r.live} />
            <span className="cell">{r.name}</span>
            <span className="cell muted">{r.oneLiner}</span>
            {props.showProject && <span className="cell muted">{r.projectName ?? '未分類'}</span>}
            <span className="cell muted">{r.stateLabel}</span>
            <span className="cell mono">{r.model}{r.effort ? ` · ${r.effort}` : ''}</span>
            <span className="cell mono cell-right">{r.filesChanged || ''}</span>
            <span className="cell">{r.prUrl ? <a href={r.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR</a> : ''}</span>
            <span className="cell mono cell-right">{r.cost}</span>
            <span className="cell memo-cell" onClick={(e) => e.stopPropagation()}>
              {editing === r.id
                ? <input className="input memo-input" autoFocus aria-label={`${r.name} のメモ`} value={draft} onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(r.id); } if (e.key === 'Escape') { e.preventDefault(); setEditing(null); } }}
                    onBlur={() => setEditing(null)} />
                : <><span className="muted">{r.memo ?? ''}</span><button className="btn memo-pencil" aria-label={`${r.name} のメモを編集`} onClick={() => startEdit(r)}><Icon name="edit" /></button></>}
            </span>
            <span className="cell cell-right"><RelativeTime label={r.when} abs={r.whenAbs} /></span>
          </div>
          {props.showSnippets && r.snippets?.map((s) => <div key={s.seq} className="mono faint" style={{ height: 20, padding: '0 12px 0 40px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{s.text}</div>)}
        </div>
      )} />
    </div>
  );
}
```

`packages/ui/src/views/primitives/VirtualList.tsx` の `render` は既に `(item: T, index: number) => ReactNode` なので、そのまま使える。
`packages/ui/src/views/primitives/Icon.tsx` の `ICONS` に `edit: Pencil` を足す（`Pencil` を `lucide-react` の import に加える）。

- [ ] **Step 4: CSS を足す**

`packages/ui/src/styles/base.css` の末尾に足す。

```css
/* 一覧のキー操作。カーソルの行は薄い面で示し、フォーカスの枠とは別にする。 */
.rows-host { outline: none; }
.row[data-cursor='true'] { background: var(--accent-soft); }
.memo-cell { display: flex; align-items: center; gap: 4px; min-width: 0; }
.memo-cell .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.memo-input { height: 22px; padding: 0 4px; width: 100%; }
.memo-pencil { visibility: hidden; padding: 0 4px; font-size: var(--fs-xs); }
.row:hover .memo-pencil, .row:focus-within .memo-pencil { visibility: visible; }
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui && npx tsc -p packages/ui --noEmit`
Expected: `SessionRows.test.tsx` は PASS。フェーズ 1 とフェーズ 2 の `SessionRowProps` を組み立てているテストに `cost: ''` と `runId: null` を足す（`grep -rn 'hasTranscript:' packages/ui/src --include=*.test.tsx` で探す）。

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src
git commit -m "feat(ui): inline session memo editing and j k enter o e m keys in session lists"
```

---

### Task 25: View（コマンドパレットと昇格ダイアログ）

**Files:**
- Create: `packages/ui/src/views/CommandPalette.tsx`、`packages/ui/src/views/PromoteDialog.tsx`
- Modify: `packages/ui/src/styles/base.css`
- Test: `packages/ui/src/views/overlays.test.tsx`（新規、jsdom）

**Interfaces:**
- Consumes: Task 21 の `PaletteProps`、`PaletteItem`、`PromoteProps`、`PromotedProps`。
- Produces:
  ```ts
  export function CommandPalette(props: PaletteProps & { onQuery: (q: string) => void }): JSX.Element;
  export function PromoteDialog(props: PromoteProps): JSX.Element;
  export function PromotedDialog(props: PromotedProps): JSX.Element;
  ```
- パレットの入力欄の `id` は `palette-input`、昇格の名前の入力欄の `id` は `promote-name` にする（`focus` の対象である）。
- 選択位置はパレットの中の `useState` に持つ。入力が変わるたびに 0 に戻す。上下の矢印で動かし、`Enter` で `palette.run`、`Esc` で `palette.close` を出す。
- 昇格ダイアログは `gitInit` を既定で真、`moveFiles` を既定で真にし、`runAlive` が真のときは `moveFiles` を無効にして理由を添える。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/overlays.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { PaletteItem } from '../presenters/palette.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { PromoteDialog, PromotedDialog } from './PromoteDialog.tsx';

const items: PaletteItem[] = [
  { id: 'cmd:new-session', label: '新規セッション', hint: '⌘N', kind: 'command' },
  { id: 'project:p1', label: 'alpha', hint: '/w/alpha', kind: 'project' },
  { id: 'session:s1', label: '動画の変換', hint: '動画を mp4 に変換した', kind: 'session' },
];

describe('CommandPalette', () => {
  it('入力を親へ返し、矢印と Enter で実行する', () => {
    const onIntent = vi.fn();
    const onQuery = vi.fn();
    render(<IntentRoot onIntent={onIntent}><CommandPalette query="" items={items} onQuery={onQuery} /></IntentRoot>);
    const input = screen.getByLabelText('コマンドパレット');
    expect(input.getAttribute('id')).toBe('palette-input');
    fireEvent.change(input, { target: { value: 'al' } });
    expect(onQuery).toHaveBeenCalledWith('al');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'project:p1', label: 'alpha' } });
  });
  it('クリックでも実行し、Esc で閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    fireEvent.click(screen.getByText('動画の変換'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'session:s1', label: '動画の変換' } });
    fireEvent.keyDown(screen.getByLabelText('コマンドパレット'), { key: 'Escape' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.close' });
  });
  it('端で止まり、項目が無ければ何も起きない', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    const input = screen.getByLabelText('コマンドパレット');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'cmd:new-session', label: '新規セッション' } });
    onIntent.mockClear();
    rerender(<IntentRoot onIntent={onIntent}><CommandPalette query="zzz" items={[]} onQuery={() => {}} /></IntentRoot>);
    fireEvent.keyDown(screen.getByLabelText('コマンドパレット'), { key: 'Enter' });
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.getByText('一致する項目がありません')).toBeTruthy();
  });
});

describe('PromoteDialog', () => {
  it('名前と 2 つの選択を送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><PromoteDialog sessionId="s1" sessionName="動画の変換" runAlive={false} submitting={false} error={null} /></IntentRoot>);
    const name = screen.getByLabelText('プロジェクト名');
    expect(name.getAttribute('id')).toBe('promote-name');
    fireEvent.change(name, { target: { value: 'newp' } });
    fireEvent.click(screen.getByLabelText('git init する'));
    fireEvent.click(screen.getByText('昇格'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: false, moveFiles: true });
  });
  it('run が生きているとファイルを移動できない', () => {
    render(<IntentRoot onIntent={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive submitting={false} error={null} /></IntentRoot>);
    expect((screen.getByLabelText('ファイルを移動する') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('実行中のセッションがあるので、ファイルは移動しません')).toBeTruthy();
  });
  it('送信中はボタンを止め、失敗は文言で出す', () => {
    render(<IntentRoot onIntent={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting error="同じ名前があります" /></IntentRoot>);
    expect((screen.getByText('昇格') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('同じ名前があります')).toBeTruthy();
  });
});

describe('PromotedDialog', () => {
  it('移動の可否と次の一手を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><PromotedDialog projectId="p9" projectName="newp" moved reason={null} /></IntentRoot>);
    expect(screen.getByText('ファイルを移しました')).toBeTruthy();
    fireEvent.click(screen.getByText('この場所で新しいセッションを開始'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'p9' });
    fireEvent.click(screen.getByText('プロジェクトを開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.open', id: 'p9' });
  });
  it('移動しなかった理由を出す', () => {
    render(<IntentRoot onIntent={() => {}}><PromotedDialog projectId="p9" projectName="newp" moved={false} reason="実行中の run があります" /></IntentRoot>);
    expect(screen.getByText('実行中の run があります')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/overlays`
Expected: FAIL（ファイルが無い）

- [ ] **Step 3: CommandPalette を作る**

`packages/ui/src/views/CommandPalette.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { PaletteProps } from '../presenters/palette.ts';

const KIND_LABEL = { command: 'コマンド', project: 'プロジェクト', session: 'セッション' } as const;

/**
 * コマンドパレット。
 * 入力の文字は Root が持ち、選択位置だけをここに持つ。どちらもダイアログの外へ出ない一時の値である。
 */
export function CommandPalette(props: PaletteProps & { onQuery: (q: string) => void }) {
  const emit = useEmit();
  const [index, setIndex] = useState(0);
  // 入力が変わると並びが変わるので、選択を先頭に戻す。
  useEffect(() => { setIndex(0); }, [props.query]);
  const run = (i: number) => { const it = props.items[i]; if (it) emit({ type: 'palette.run', command: { id: it.id, label: it.label } }); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(props.items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(index); }
    else if (e.key === 'Escape') { e.preventDefault(); emit({ type: 'palette.close' }); }
  };
  return (
    <div className="overlay" onClick={() => emit({ type: 'palette.close' })}>
      <div className="dialog palette" onClick={(e) => e.stopPropagation()}>
        <input id="palette-input" className="input palette-input" aria-label="コマンドパレット" placeholder="セッション、プロジェクト、コマンド" autoFocus
          value={props.query} onChange={(e) => props.onQuery(e.target.value)} onKeyDown={onKeyDown} />
        {props.items.length === 0 && <div className="empty">一致する項目がありません</div>}
        <ul className="palette-list" role="listbox">
          {props.items.map((it, i) => (
            <li key={it.id} className="palette-item" role="option" aria-selected={i === index} data-active={i === index ? 'true' : undefined}
              onMouseEnter={() => setIndex(i)} onClick={() => run(i)}>
              <span className="palette-kind faint">{KIND_LABEL[it.kind]}</span>
              <span className="palette-label">{it.label}</span>
              <span className="palette-hint faint mono">{it.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: PromoteDialog を作る**

`packages/ui/src/views/PromoteDialog.tsx`：

```tsx
import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { PromoteProps, PromotedProps } from '../presenters/promote.ts';

/** スクラッチのセッションをワークスペースのプロジェクトへ昇格するダイアログ。 */
export function PromoteDialog(props: PromoteProps) {
  const emit = useEmit();
  const [name, setName] = useState('');
  const [gitInit, setGitInit] = useState(true);
  const [moveFiles, setMoveFiles] = useState(true);
  return (
    <div className="overlay" onClick={() => emit({ type: 'overlay.close' })}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <b>プロジェクトに昇格</b>
        <div className="faint">{props.sessionName} の作業をワークスペースの下に移します。</div>
        <label className="field"><span>プロジェクト名</span>
          <input id="promote-name" className="input mono" aria-label="プロジェクト名" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !props.submitting) emit({ type: 'session.promote.submit', id: props.sessionId, name, gitInit, moveFiles: moveFiles && !props.runAlive }); }} />
        </label>
        <label className="field-row"><input type="checkbox" aria-label="git init する" checked={gitInit} onChange={(e) => setGitInit(e.target.checked)} /><span>git init する</span></label>
        <label className="field-row"><input type="checkbox" aria-label="ファイルを移動する" disabled={props.runAlive} checked={moveFiles && !props.runAlive} onChange={(e) => setMoveFiles(e.target.checked)} /><span>ファイルを移動する</span></label>
        {props.runAlive && <div className="faint">実行中のセッションがあるので、ファイルは移動しません</div>}
        {props.error && <div className="faint" style={{ color: 'var(--error)' }}>{props.error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="spacer" />
          <button className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <button className="btn btn-primary" disabled={props.submitting} onClick={() => emit({ type: 'session.promote.submit', id: props.sessionId, name, gitInit, moveFiles: moveFiles && !props.runAlive })}>昇格</button>
        </div>
      </div>
    </div>
  );
}

/** 昇格の完了。次の一手として、その場所での新規セッションを勧める。 */
export function PromotedDialog(props: PromotedProps) {
  const emit = useEmit();
  return (
    <div className="overlay" onClick={() => emit({ type: 'overlay.close' })}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <b>{props.projectName} に昇格しました</b>
        <div className="faint">{props.moved ? 'ファイルを移しました' : (props.reason ?? 'ファイルは移していません')}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="spacer" />
          <button className="btn" onClick={() => emit({ type: 'overlay.close' })}>閉じる</button>
          <button className="btn" onClick={() => emit({ type: 'project.open', id: props.projectId })}>プロジェクトを開く</button>
          <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', projectId: props.projectId })}>この場所で新しいセッションを開始</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: CSS を足す**

`packages/ui/src/styles/base.css` の末尾に足す。

```css
/* コマンドパレット。開閉は 98% から 100% のスケールとフェードで 120 ミリ秒。 */
.palette { width: min(640px, 90vw); padding: 0; animation: pop var(--dur-pop) var(--ease); }
@keyframes pop { from { transform: scale(0.98); opacity: 0; } }
.palette-input { width: 100%; height: 40px; border: none; border-bottom: 1px solid var(--line); border-radius: 0; font-size: var(--fs-md); }
.palette-list { list-style: none; margin: 0; padding: 4px; max-height: 50vh; overflow: auto; }
.palette-item { display: grid; grid-template-columns: 88px 1fr auto; align-items: center; gap: 8px; height: var(--row-h); padding: 0 8px; border-radius: var(--r); cursor: pointer; }
.palette-item[data-active='true'] { background: var(--accent-soft); }
.palette-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; font-size: var(--fs-xs); }
.field-row { display: flex; align-items: center; gap: 6px; }
```

- [ ] **Step 6: テストと型検査**

Run: `npx vitest run packages/ui && npx tsc -p packages/ui --noEmit`
Expected: `overlays.test.tsx` は PASS。`tsc` のエラーは `Root.tsx` の箇所だけに限られる。

- [ ] **Step 7: コミット**

```bash
git add packages/ui/src
git commit -m "feat(ui): command palette and promote dialogs"
```

---

### Task 26: View（Settings の statusline、要約器、使用量）

**Files:**
- Modify: `packages/ui/src/views/SettingsScreen.tsx`、`packages/ui/src/styles/base.css`
- Test: `packages/ui/src/views/misc.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 20 の `SettingsProps`（`statusline`、`statuslineCommand`、`lmStudioUrl`、`lmStudioModel`、`summaryFallback`、`summaryHourlyCap`、`summarizerModels`、`summarizerTest`、`usageAggregate`）。
- Produces: `export function SettingsScreen(props: SettingsProps): JSX.Element;`
- 節は上から、ワークスペース、ターミナルと VS Code（フェーズ 2）、MCP（フェーズ 2）、statusline、要約器、使用量、索引、この端末にする。
- 「次のフェーズで追加される設定」の節はクラウド同期だけを残す。
- statusline の節は読み取り専用で、追記の有無と追記先を出し、追記のコマンドを印字する。UI からは追記しない。
- 要約器の節は LM Studio の URL、モデルの選択、フォールバックの可否と 1 時間の上限、「要約器を試す」とその結果を出す。
- モデルの選択は `summarizerModels` が null なら「読み込んでいます」、空配列なら「LM Studio に繋がりません」を出し、選択肢には「自動（最初のモデル）」を先頭に置く。
- 使用量の節は直近 30 日の日別と、プロジェクト別の 2 つの小さな表を出す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/misc.test.tsx` に足す。

```tsx
const settingsProps = (over: Partial<SettingsProps> = {}): SettingsProps => ({
  workspaceRoot: '/w', claudeDir: '/c', device: { id: 'd', name: 'mac' }, version: '0.3.0', index: { phase: 'idle', done: 0, total: 0 }, sessionCount: 3, projectCount: 2,
  tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal', codePath: null, mcpInstallCommand: 'npx hangar mcp install',
  lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20,
  summarizerModels: ['gemma', 'qwen'], summarizerTest: null,
  statusline: { command: 'bash ~/.claude/statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: false },
  statuslineCommand: 'npx hangar statusline install',
  usageAggregate: { days: [{ day: '2026-09-18', inputTokens: 1200, outputTokens: 340, sessions: 2 }], projects: [{ projectId: 'p1', name: 'alpha', inputTokens: 1200, outputTokens: 340, costUsd: 1.5, sessions: 2 }] },
  ...over,
});

describe('SettingsScreen のフェーズ 3', () => {
  it('statusline の状態と追記のコマンドを出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    expect(screen.getByText('まだ追記されていません')).toBeTruthy();
    expect(screen.getByText('npx hangar statusline install')).toBeTruthy();
    expect(screen.getByText('/h/.claude/statusline.sh')).toBeTruthy();
  });
  it('追記済みならそう出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ statusline: { command: 'bash x', scriptPath: '/h/x', installed: true } })} /></IntentRoot>);
    expect(screen.getByText('追記済みです')).toBeTruthy();
  });
  it('statusline の設定が無いときは案内を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ statusline: { command: null, scriptPath: null, installed: false } })} /></IntentRoot>);
    expect(screen.getByText('statusLine の設定が見つかりません')).toBeTruthy();
  });
  it('要約器の URL とモデルとフォールバックを保存する', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('LM Studio の URL'), { target: { value: 'http://127.0.0.1:2345' } });
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20 } });
    fireEvent.change(screen.getByLabelText('モデル'), { target: { value: 'qwen' } });
    fireEvent.click(screen.getByLabelText('Claude へ切り替える'));
    fireEvent.change(screen.getByLabelText('1 時間の上限'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: 'qwen', summaryFallback: false, summaryHourlyCap: 5 } });
  });
  it('モデルの一覧の状態を出し分ける', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ summarizerModels: null })} /></IntentRoot>);
    expect(screen.getByText('読み込んでいます')).toBeTruthy();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ summarizerModels: [] })} /></IntentRoot>);
    expect(screen.getByText('LM Studio に繋がりません')).toBeTruthy();
  });
  it('要約器を試すと summarizer.test を出し、結果を出す', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.click(screen.getByText('要約器を試す'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'summarizer.test' });
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ summarizerTest: { ok: true, id: 'lmstudio', ms: 820, summary: { title: '題', oneLiner: '1 文', body: '本文', state: 'done', nextSteps: [], source: 'post_hoc', sourceModel: 'gemma', basedOnTurns: 3 } } })} /></IntentRoot>);
    expect(screen.getByText('lmstudio で成功しました（820 ミリ秒）')).toBeTruthy();
    expect(screen.getByText('1 文')).toBeTruthy();
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ summarizerTest: { ok: false, tried: [{ id: 'lmstudio', message: 'ECONNREFUSED' }, { id: 'claude-headless', message: '上限に達しています' }] } })} /></IntentRoot>);
    expect(screen.getByText('lmstudio: ECONNREFUSED')).toBeTruthy();
    expect(screen.getByText('claude-headless: 上限に達しています')).toBeTruthy();
  });
  it('使用量の 2 つの表を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    expect(screen.getByText('2026-09-18')).toBeTruthy();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('$1.50')).toBeTruthy();
  });
  it('集計がまだ無ければ読み込み中を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ usageAggregate: null })} /></IntentRoot>);
    expect(screen.getByText('使用量を読み込んでいます')).toBeTruthy();
  });
});
```

`SettingsProps` の import と、フェーズ 2 で足した `SettingsScreen` のテストの props は `settingsProps()` に寄せる。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/misc`
Expected: FAIL

- [ ] **Step 3: SettingsScreen に 3 つの節を足す**

`packages/ui/src/views/SettingsScreen.tsx` の import と state に足す。

```tsx
import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { costLabel, tokensLabel } from '../presenters/format.ts';
import type { SettingsProps } from '../presenters/settings.ts';
```

```tsx
  const [lmUrl, setLmUrl] = useState(props.lmStudioUrl);
  const [lmModel, setLmModel] = useState(props.lmStudioModel ?? '');
  const [fallback, setFallback] = useState(props.summaryFallback);
  const [cap, setCap] = useState(String(props.summaryHourlyCap));
  const saveSummarizer = () => emit({ type: 'settings.update', patch: { lmStudioUrl: lmUrl, lmStudioModel: lmModel || null, summaryFallback: fallback, summaryHourlyCap: Number(cap) } });
```

「索引」の節の前に 3 つの節を足す。

```tsx
      <section>
        <h2 className="h2">statusline</h2>
        {props.statusline === null && <div className="faint">読み込んでいます</div>}
        {props.statusline && props.statusline.scriptPath === null && (
          <div className="faint">statusLine の設定が見つかりません。Claude Code の `/statusline` でスクリプトを作ってから、下のコマンドを実行してください。</div>
        )}
        {props.statusline?.scriptPath && (
          <>
            <div className="muted">{props.statusline.installed ? '追記済みです' : 'まだ追記されていません'}</div>
            <div className="faint mono">{props.statusline.scriptPath}</div>
          </>
        )}
        <div className="faint" style={{ marginTop: 4 }}>使用量ゲージはこの追記だけが供給源です。追記は端末から行い、UI からは書き換えません。</div>
        <pre className="mono snippet">{props.statuslineCommand}</pre>
      </section>

      <section>
        <h2 className="h2">要約器</h2>
        <div className="grid2">
          <label className="field"><span>LM Studio の URL</span>
            <input className="input mono" aria-label="LM Studio の URL" value={lmUrl} onChange={(e) => setLmUrl(e.target.value)} />
          </label>
          <label className="field"><span>モデル</span>
            <select className="select" aria-label="モデル" value={lmModel} onChange={(e) => setLmModel(e.target.value)}>
              <option value="">自動（最初のモデル）</option>
              {(props.summarizerModels ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        </div>
        {props.summarizerModels === null && <div className="faint">読み込んでいます</div>}
        {props.summarizerModels?.length === 0 && <div className="faint">LM Studio に繋がりません</div>}
        <label className="field-row"><input type="checkbox" aria-label="Claude へ切り替える" checked={fallback} onChange={(e) => setFallback(e.target.checked)} /><span>LM Studio が使えないとき Claude へ切り替える</span></label>
        <label className="field-row"><span>1 時間の上限</span><input className="input mono" style={{ width: 72 }} aria-label="1 時間の上限" value={cap} onChange={(e) => setCap(e.target.value)} /><span className="faint">件。7 日の使用率が 80% を超えたら切り替えません。</span></label>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button className="btn btn-primary" onClick={saveSummarizer}>要約器の設定を保存</button>
          <button className="btn" onClick={() => emit({ type: 'summarizer.test' })}>要約器を試す</button>
        </div>
        {props.summarizerTest?.ok === true && (
          <div style={{ marginTop: 4 }}>
            <div className="muted">{props.summarizerTest.id} で成功しました（{props.summarizerTest.ms} ミリ秒）</div>
            <div className="faint">{props.summarizerTest.summary.oneLiner}</div>
          </div>
        )}
        {props.summarizerTest?.ok === false && (
          <ul className="faint" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {props.summarizerTest.tried.map((t) => <li key={t.id}>{t.id}: {t.message}</li>)}
          </ul>
        )}
      </section>

      <section>
        <h2 className="h2">使用量</h2>
        {props.usageAggregate === null && <div className="faint">使用量を読み込んでいます</div>}
        {props.usageAggregate && (
          <div className="grid2">
            <table className="mini"><caption className="faint">直近 30 日</caption>
              <thead><tr><th>日</th><th className="cell-right">入力</th><th className="cell-right">出力</th><th className="cell-right">件</th></tr></thead>
              <tbody>{props.usageAggregate.days.map((d) => <tr key={d.day}><td className="mono">{d.day}</td><td className="mono cell-right">{tokensLabel(d.inputTokens)}</td><td className="mono cell-right">{tokensLabel(d.outputTokens)}</td><td className="mono cell-right">{d.sessions}</td></tr>)}</tbody>
            </table>
            <table className="mini"><caption className="faint">プロジェクト別</caption>
              <thead><tr><th>名前</th><th className="cell-right">トークン</th><th className="cell-right">コスト</th><th className="cell-right">件</th></tr></thead>
              <tbody>{props.usageAggregate.projects.map((p) => <tr key={p.projectId ?? 'none'}><td>{p.name}</td><td className="mono cell-right">{tokensLabel(p.inputTokens + p.outputTokens)}</td><td className="mono cell-right">{costLabel(p.costUsd)}</td><td className="mono cell-right">{p.sessions}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        <div className="faint" style={{ marginTop: 4 }}>コストは statusline が渡した値の合計です。渡されていないセッションは含みません。</div>
      </section>
```

「次のフェーズで追加される設定」の節の本文を置き換える。

```tsx
        <div className="faint">クラウド同期（状態、参加トークンの発行、一時停止）と他端末セッションの引き継ぎ。</div>
```

- [ ] **Step 4: CSS を足す**

`packages/ui/src/styles/base.css` の末尾に足す。

```css
/* 設定の小さな表。行高は一覧と揃える。 */
.mini { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.mini caption { text-align: left; padding-bottom: 2px; }
.mini th { text-align: left; font-weight: 500; color: var(--ink-3); border-bottom: 1px solid var(--line); }
.mini td, .mini th { height: 22px; padding: 0 4px; }
.mini td.cell-right, .mini th.cell-right { text-align: right; }
.snippet { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r); padding: 6px 8px; overflow-x: auto; font-size: var(--fs-sm); }
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui && npx tsc -p packages/ui --noEmit`
Expected: `misc.test.tsx` は PASS。`tsc` のエラーは `Root.tsx` の箇所だけに限られる。

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src
git commit -m "feat(ui): settings sections for statusline state, summarizer and usage aggregates"
```

---

### Task 27: Root と main の結線、ショートカット

**Files:**
- Modify: `packages/ui/src/Root.tsx`、`packages/ui/src/main.tsx`
- Test: `packages/ui/src/Root.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 20 と Task 21 のすべての Presenter、Task 22 から Task 26 のすべての View、フェーズ 2 の `currentRunOf`、`tabsOf`、`defaultSessionView`。
- Produces: `export function Root(props: { runtime: Runtime; api?: ApiClient; terminals: TerminalHost }): JSX.Element;`
- ショートカットの一覧：

| キー | 動作 | ターミナルにフォーカスがあるとき |
| --- | --- | --- |
| ⌘K（Ctrl+K） | `palette.open` | 受け取る |
| ⌘N（Ctrl+N） | `session.new.open { scratch: false }` | 受け取る |
| ⌘⇧N | `session.new.open { scratch: true }` | 受け取る |
| ⌘,（Ctrl+,） | `nav.go(settings)` | 受け取る |
| `/` | 検索欄にフォーカス | 渡す（xterm へ） |
| ⌘1 から ⌘9 | その位置のタブへ `tab.select` | 受け取る |
| ⌃⌥1 から ⌃⌥9 | 同上（素のブラウザ用） | 渡す |
| ⌘W | 閉じられるタブなら `tab.close` | 受け取る |
| ⌘\ | `split.toggle` | 受け取る |
| ⌘J | `transcript.toggle` | 受け取る |
| Esc | オーバーレイを閉じる | 渡す |

- ターミナルにフォーカスがあるかどうかは、`keydown` の `target` が `.term-host` の中にあるかで決める。
- ⌘ を含まない組み合わせはターミナルの中では `preventDefault` せず、そのまま xterm に渡す。
- 入力欄（`INPUT`、`TEXTAREA`、`SELECT`）では `/` を横取りしない。⌘ の組み合わせは入力欄でも受け取る。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/Root.test.tsx` に足す。

```tsx
describe('フェーズ 3 のショートカットとオーバーレイ', () => {
  const key = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);

  it('グローバルのキーが Intent になる', async () => {
    const { rt } = await mounted();              // フェーズ 2 のテストにある補助
    const emit = vi.spyOn(rt, 'emit');
    key({ key: 'k', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'palette.open' });
    key({ key: 'n', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'session.new.open', scratch: false });
    key({ key: 'N', metaKey: true, shiftKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'session.new.open', scratch: true });
    key({ key: ',', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings' } });
  });

  it('セッション画面でタブと分割とトランスクリプトのキーが効く', async () => {
    const { rt, wsHandlers, setHash } = await mounted();
    setHash('#/sessions/s1');
    await flush();
    wsHandlers[0]!.onEvent({ type: 'run.started', run: rootRun('r1', 's1'), tabs: [rootTab('t1', 'r1', 'agent'), rootTab('t2', 'r1', 'shell')] });
    await flush();
    const emit = vi.spyOn(rt, 'emit');
    key({ key: '2', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'tab.select', tabId: 't2' });
    key({ key: '2', ctrlKey: true, altKey: true });
    expect(emit).toHaveBeenLastCalledWith({ type: 'tab.select', tabId: 't2' });
    key({ key: '\\', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'split.toggle' });
    key({ key: 'j', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'transcript.toggle' });
  });

  it('⌘W は閉じられるタブのときだけ tab.close を出す', async () => {
    const { rt, wsHandlers, setHash } = await mounted();
    setHash('#/sessions/s1');
    await flush();
    wsHandlers[0]!.onEvent({ type: 'run.started', run: rootRun('r1', 's1'), tabs: [rootTab('t1', 'r1', 'agent'), rootTab('t2', 'r1', 'shell')] });
    await flush();
    const emit = vi.spyOn(rt, 'emit');
    key({ key: 'w', metaKey: true });            // 選択中は Claude タブなので閉じない
    expect(emit).not.toHaveBeenCalledWith({ type: 'tab.close', tabId: 't1' });
    rt.emit({ type: 'tab.select', tabId: 't2' });
    await flush();
    key({ key: 'w', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'tab.close', tabId: 't2' });
  });

  it('ターミナルにフォーカスがあるときは ⌘ を含むものだけを受ける', async () => {
    const { rt } = await mounted();
    const host = document.createElement('div');
    host.className = 'term-host';
    const inner = document.createElement('div');
    host.appendChild(inner);
    document.body.appendChild(host);
    const emit = vi.spyOn(rt, 'emit');
    fireEvent.keyDown(inner, { key: '/', bubbles: true });
    expect(emit).not.toHaveBeenCalled();
    fireEvent.keyDown(inner, { key: 'k', metaKey: true, bubbles: true });
    expect(emit).toHaveBeenCalledWith({ type: 'palette.open' });
    host.remove();
  });

  it('パレットの入力は Root が持ち、閉じると空に戻る', async () => {
    const { rt } = await mounted();
    rt.emit({ type: 'palette.open' });
    await flush();
    const input = screen.getByLabelText('コマンドパレット') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alp' } });
    expect((screen.getByLabelText('コマンドパレット') as HTMLInputElement).value).toBe('alp');
    rt.emit({ type: 'palette.close' });
    await flush();
    rt.emit({ type: 'palette.open' });
    await flush();
    expect((screen.getByLabelText('コマンドパレット') as HTMLInputElement).value).toBe('');
  });

  it('昇格のダイアログと完了のダイアログが出る', async () => {
    const { rt } = await mounted();
    rt.emit({ type: 'session.promote.open', id: 's1' });
    await flush();
    expect(screen.getByLabelText('プロジェクト名')).toBeTruthy();
    rt.dispatch({ kind: 'runtime', event: { type: 'promote.done', projectId: 'p1', moved: true, reason: null } });
    await flush();
    expect(screen.getByText('この場所で新しいセッションを開始')).toBeTruthy();
  });
});
```

`rootRun` と `rootTab` はファイルの先頭に足す。

```tsx
const rootRun = (id: string, sessionId: string) => ({ id, sessionId, deviceId: 'd', kind: 'start' as const, tmuxName: `hangar-${id}`, pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 });
const rootTab = (id: string, runId: string, kind: 'agent' | 'shell') => ({ id, runId, sessionId: 's1', kind, title: id, tmuxName: `hangar-${runId}-${id}`, createdAt: Number(id.replace(/\D/g, '')), closedAt: null });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/Root`
Expected: FAIL

- [ ] **Step 3: Root にオーバーレイとパレットの入力を足す**

`packages/ui/src/Root.tsx` の import に足す。

```tsx
import { presentPalette } from './presenters/palette.ts';
import { presentPromote, presentPromoted } from './presenters/promote.ts';
import { currentRunOf, tabsOf } from './store/store.ts';
import { defaultSessionView } from './mediator/sessionView.ts';
import { CommandPalette } from './views/CommandPalette.tsx';
import { PromoteDialog, PromotedDialog } from './views/PromoteDialog.tsx';
```

state を足す。

```tsx
  // パレットの入力の文字は Root が持つ。Mediator には入れない一時の値である。
  const [paletteQuery, setPaletteQuery] = useState('');
  useEffect(() => { if (!paletteOpen) setPaletteQuery(''); }, [paletteOpen]);
```

`paletteOpen` はフェーズ 2 の `Root.tsx` に既にあるので、二重に宣言しない。

`presentShell(state, store)` を `presentShell(state, store, now)` に直す。

`overlays` に足す。

```tsx
      {overlay.kind === 'palette' && <CommandPalette {...presentPalette(state, store, paletteQuery)!} onQuery={setPaletteQuery} />}
      {overlay.kind === 'promote' && <PromoteDialog {...presentPromote(state, store)!} />}
      {overlay.kind === 'promoted' && <PromotedDialog {...presentPromoted(state, store)!} />}
```

フェーズ 2 で置いた仮の `.dialog` のパレットは消す。

- [ ] **Step 4: ショートカットを実装する**

`packages/ui/src/Root.tsx` のキー処理の `useEffect` を置き換える。

```tsx
  // ショートカットの対象になる、いま見ているセッションのタブ。
  const sessionId = state.screen.name === 'session' ? state.screen.id : null;
  const shortcutRun = sessionId ? currentRunOf(store, sessionId) : null;
  const shortcutTabs = shortcutRun ? tabsOf(store, shortcutRun.id) : [];
  const shortcutView = sessionId ? state.sessionView[sessionId] ?? defaultSessionView() : null;
  const selectedTabId = shortcutView?.selectedTab ?? shortcutTabs[0]?.id ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      // ターミナルにフォーカスがあるときは、⌘ を含む組み合わせだけを hangar が処理する。
      // それ以外は preventDefault せずに xterm へ渡す。
      const inTerminal = !!el?.closest?.('.term-host');
      if (inTerminal && !e.metaKey) return;
      const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
      if (digit && (e.metaKey || (e.ctrlKey && e.altKey))) {
        e.preventDefault();
        const t = shortcutTabs[digit - 1];
        if (t) rt.emit({ type: 'tab.select', tabId: t.id });
        return;
      }
      if (e.metaKey && e.key === 'w') {
        e.preventDefault();
        const t = shortcutTabs.find((x) => x.id === selectedTabId);
        if (t && t.kind === 'shell') rt.emit({ type: 'tab.close', tabId: t.id });
        return;
      }
      if (e.metaKey && e.key === '\\') { e.preventDefault(); rt.emit({ type: 'split.toggle' }); return; }
      if (e.metaKey && e.key === 'j') { e.preventDefault(); rt.emit({ type: 'transcript.toggle' }); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); rt.emit({ type: 'palette.open' }); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); rt.emit({ type: 'session.new.open', scratch: e.shiftKey }); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); rt.emit({ type: 'nav.go', to: { name: 'settings' } }); return; }
      if (e.key === 'Escape' && overlay.kind !== 'none') { rt.emit(overlay.kind === 'palette' ? { type: 'palette.close' } : { type: 'overlay.close' }); return; }
      if (e.key === '/' && !typing) { e.preventDefault(); document.getElementById('global-search')?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rt, overlay.kind, shortcutTabs, selectedTabId]);
```

- [ ] **Step 5: main.tsx の focus の対象を広げる**

`packages/ui/src/main.tsx` の `focus` を置き換える。

```tsx
const FOCUS_IDS = { search: 'global-search', newSessionName: 'new-session-name', palette: 'palette-input', promoteName: 'promote-name', todoInput: 'todo-input' } as const;

  // ダイアログが描かれる前に効果が来ることがあるので、次のフレームで探す。
  focus: (t) => { requestAnimationFrame(() => document.getElementById(FOCUS_IDS[t])?.focus()); },
```

- [ ] **Step 6: テスト、型検査、ビルド**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: 全パッケージ PASS。`tsc` のエラーは 0 件。`packages/ui/dist` ができる。

- [ ] **Step 7: コミット**

```bash
git add packages/ui/src
git commit -m "feat(ui): global shortcuts, palette query state and promote overlays wired into root"
```

---

### Task 28: 実物で確かめる（Claude の起動は 2 回まで）

**Files:**
- 変更なし（観察の結果を Task 29 で `docs/design.md` に反映する）

この Task は実物の Claude を起動するので、サブスクリプションのレート制限を使う。
起動は合計 2 回までとし、内訳は statusline の確認で 1 回、事後要約とアーティファクトの確認で 1 回である。
cwd は `~/.agent-hangar/scratch/` の下に hangar 自身が作る使い捨てディレクトリにする。
`~/.claude` に hangar が書くのは Step 2 の statusline スクリプトへの追記だけで、追記は `y` の入力を求め、前にバックアップを取る。
`~/.claude/settings.json` は読むだけである。

- [ ] **Step 1: 準備**

```bash
npm run build
cp -a ~/.claude/settings.json /tmp/settings.json.before 2>/dev/null || true
ls -la ~/.claude | head -5 > /tmp/claude-before.txt
HANGAR_HOME=/tmp/hangar-p3 npx tsx packages/server/src/main.ts &
sleep 8
TOKEN=$(cat /tmp/hangar-p3/token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4177/api/statusline; echo
```

Expected: サーバが立ち、`/api/statusline` が `{"command":...,"scriptPath":...,"installed":false}` を返す。
ポート 4177 を実物の hangar が使っていれば先に止める。
`scriptPath` が null なら、Claude Code の `/statusline` でスクリプトを作ってから Step 2 に進む。作らないときは Step 2 と Step 3 を飛ばし、その旨を Task 29 に記録する。

- [ ] **Step 2: statusline に追記する（承諾を取り、バックアップを取る）**

```bash
HANGAR_HOME=/tmp/hangar-p3 npx hangar statusline install
```

Expected: 追記先のパスとスニペットを印字し、「追記しますか（y/N）」と聞く。`y` と答えると `<name>.bak-<yyyymmddHHMMSS>` ができ、目印の行から始まる 7 行が先頭（`#!` があればその直後）に入る。
2 回目の実行は「すでに追記されています」と出して何も変えない。

```bash
SCRIPT=$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4177/api/statusline | sed -n 's/.*"scriptPath":"\([^"]*\)".*/\1/p')
ls -la "$(dirname "$SCRIPT")"/*.bak-* | tail -2
head -12 "$SCRIPT"
diff /tmp/settings.json.before ~/.claude/settings.json && echo 'settings.json は変わっていない'
```

Expected: バックアップが 1 つ増え、スクリプトの先頭に目印の行がある。`settings.json` に差分が無い。

- [ ] **Step 3: 起動 1 回目（statusline から使用量が届く）**

`playwright` スキルのローカル Chrome で `http://127.0.0.1:4177/` を開く。
⌘⇧N（スクラッチ）で起動し、初期プロンプトに次を入れる。

```
「合言葉は格納庫 42」とだけ答えてください。
```

確認すること（スクリーンショットを撮って `Read` で確かめる）：

1. ヘッダーの 5 時間と 7 日のゲージが、1 回目の応答の後に灰色の「未取得」から数値に変わる（`rate_limits` は起動直後の payload には無く、応答完了の payload で届く）。
2. 数字が縦回転で入れ替わり、80% 以上なら棒が `--waiting` の色になる（下回っていれば色の確認は飛ばす）。
3. ゲージの横に「最終更新 N 分前」が出る。
4. セッション画面のヘッダーにコンテキスト使用率の棒と推定コストが出る。
5. `sqlite3 /tmp/hangar-p3/hangar.db "select count(*) from usage_snapshots"` が 2 以上、`"select model, effort, context_used, cost_usd from session_live_stats"` が値を返す。

セッションを `/exit` で終える。

- [ ] **Step 4: 事後要約を LM Studio で試す**

```bash
curl -s -m 2 http://127.0.0.1:1234/v1/models >/dev/null && echo 'LM Studio あり' || echo 'LM Studio なし'
```

`LM Studio なし` のときは、LM Studio を起動してモデルを 1 つ読み込むか、この Step を飛ばす。
飛ばすときは Settings の「要約器」で「要約器を試す」を押し、`lmstudio: ECONNREFUSED` と出ること、フォールバックが偽なら失敗のまま止まることだけを確かめ、その旨を Task 29 に記録する。

`LM Studio あり` のとき：

1. Settings の「要約器」でモデルの選択肢が埋まる。
2. 「要約器を試す」を押すと数秒で `lmstudio で成功しました（N ミリ秒）` と 1 文が出る。
3. Step 3 のセッションを開き、ヘッダーに「要約を作成しています」が出てから、要約が題名と 1 文に変わる（出所が「事後」になる）。
4. `sqlite3 /tmp/hangar-p3/hangar.db "select source, source_model, based_on_turns from session_summaries order by updated_at desc limit 1"` が `post_hoc | <モデル名> | <ターン数>` を返す。
5. 「要約を作り直す」を押すと再び `summary.pending` が届き、値が更新される。

LM Studio を止めた状態で「要約器を試す」を押し、`summaryFallback` が真なら `claude-headless` に切り替わることを確かめる。
この切り替えは `claude -p` を 1 回呼ぶので、Step 3 と合わせた起動の回数には数えないが、レート制限は少し使う。

- [ ] **Step 5: 起動 2 回目（アーティファクトの抽出）**

⌘⇧N でもう 1 つスクラッチのセッションを起動し、初期プロンプトに次を入れる。

```
小さな HTML を 1 枚作り、Artifact ツールで公開してください。題名は「格納庫の確認」、favicon は 📊 にしてください。
公開できたら、その URL を答えてください。
```

確認すること：

1. 公開の直後（索引の追記が拾った後）に、セッション画面のアーティファクトの帯にカードが出る。favicon と題名と「1 分未満前」と「更新 1 回」がある。
2. 元ファイルが残っているので「VS Code で開く」が出る。押すと VS Code がそのファイルを開く。
3. カードのクリックで既定のブラウザに `https://claude.ai/code/artifact/...` が開く。
4. 同じ内容をもう 1 度公開させると、カードは増えずに「更新 2 回」になる。
5. `sqlite3 /tmp/hangar-p3/hangar.db "select count(*) from artifacts; select count(*) from artifact_versions"` が `1` と `2` を返す。
6. `sqlite3 /tmp/hangar-p3/hangar.db "select title from artifacts"` が HTML の `<title>` から取った題名を返す。

セッションを `/exit` で終える。

- [ ] **Step 6: 昇格を確かめる**

Step 5 のセッションの画面で「プロジェクトに昇格」を押し、名前に `hangar-p3-check`、`git init する` を真、`ファイルを移動する` を真にして「昇格」を押す。

Expected: 完了ダイアログが「ファイルを移しました」と出る。
`ls <workspaceRoot>/hangar-p3-check` に HTML があり、`git -C <workspaceRoot>/hangar-p3-check rev-parse --git-dir` が `.git` を返す。
元のスクラッチのディレクトリが空になって消えている。
セッション画面に戻ると、プロジェクトが `hangar-p3-check` になり、`再開すると cwd はスクラッチのままです` が出る（cwd はスクラッチのままだからである）。
run が生きたまま昇格を試すと、`ファイルを移動する` が押せず、完了ダイアログに理由が出る。

- [ ] **Step 7: UI をひととおり見る**

`playwright` スキルのローカル Chrome で次を確かめ、スクリーンショットを撮って `Read` で見る。
見た目は常にライトで、ダークの切り替えは無い。

1. Home：カードに未完 TODO の数とメモの冒頭と「ここで新規」が出る。スクラッチのカードは出ない。
2. Projects：ステータスを変えるとカードが別のセクションへ FLIP で滑る。
3. プロジェクト詳細：右レールで TODO を足して打消し線を付け、メモを書いて保存する。`~/.agent-hangar/projects/<id>/memo.md` が同じ内容になる。エディタでそのファイルを書き換えると、300 ミリ秒ほどで画面のメモが変わる。編集中に書き換えると「外部で更新されました」と「読み込む」が出て、下書きが消えない。
4. プロジェクト詳細：アーティファクトの URL を手で足すと、題名なしのカードが増える。
5. セッション一覧：`j` と `k` でカーソルが動き、`m` でメモの入力欄に変わり、Enter で保存、Esc で取り消す。`o` と `e` が実行中の行で効く。
6. セッション詳細：シェルタブを 2 つ開き、⌘\ で分割する。仕切りをドラッグして幅が変わる。⌘1 と ⌘2 でタブが切り替わる。⌘W でシェルタブが閉じる。⌘J でトランスクリプトのペーンが閉じる。タブが 1 つのときの ⌘\ はトーストになる。
7. ターミナルにフォーカスを置いて `j` と `/` を打つと、ターミナルに文字が入り、hangar は反応しない。⌘K はパレットが開く。
8. パレット：⌘K で開き、プロジェクト名の一部を打つと上位に出る。`↓` と Enter で移動する。`スクラッチ` と打つとスクラッチのプロジェクトが出る。`さくせい` のような当たらない語では「一致する項目がありません」が出る。
9. Settings：statusline が「追記済みです」になり、使用量の 2 つの表に値が入る。

- [ ] **Step 8: 片付けと `~/.claude` の確認**

```bash
kill %1
ls -la ~/.claude | head -5 > /tmp/claude-after.txt
diff /tmp/claude-before.txt /tmp/claude-after.txt || true
diff /tmp/settings.json.before ~/.claude/settings.json && echo 'settings.json は変わっていない'
rm -rf /tmp/hangar-p3
```

Expected: `~/.claude` の直下で変わるのは、statusline スクリプトと増えたバックアップ、それに Claude 自身が書いた本文だけである。
`settings.json` に差分が無い。
`~/.agent-hangar/scratch/` に残ったディレクトリは、昇格していないものだけである（hangar は消さない）。
実物の `~/.agent-hangar` は使っていない（`HANGAR_HOME` を `/tmp/hangar-p3` に向けた）。

- [ ] **Step 9: 観察を記録する**

Step 3 から Step 7 で計画と違った点を書き出し、Task 29 で `docs/design.md` の「決めた前提と未決事項」に反映する。
特に次の 3 つは、計画では決め打ちなので実物で確かめた結果を残す。

- `rate_limits` が何回目の payload から入るか。
- LM Studio の `json_schema` が指示どおりの形を返すか、返さないときに何が来るか。
- Artifact の `tool_result` の本文の形（`Published <path> at <url>`）が想定と同じか。

---

### Task 29: 文書の更新（design.md と README）

**Files:**
- Modify: `docs/design.md`、`README.md`

- [ ] **Step 1: 設計文書に前提を畳み込む**

`docs/design.md` の「決めた前提と未決事項」の箇条書きに、この計画の「前提（この計画で決めたこと）」の項目を加える。
加えるのは次のとおりである。

- 使用量の保存（`usage_snapshots` に直近 500 件、5 時間と 7 日の窓はメモリ、`rate_limits` が無ければ直前の値を保つ）。
- セッションごとの付帯情報を `session_live_stats` に置き、`session_stats` より優先すること。
- statusline の追記先の決め方（`statusLine.command` の最初の語、`~` 展開、存在しなければ印字だけ）とバックアップの名前。
- jsonl からの日別集計（`usage_daily`）と、推定コストは statusline の値の和だけであること。
- アーティファクトの抽出（`artifact_calls` での突き合わせ、URL で 1 件にまとめる、題名は公開時に決める、開く経路はサーバの `open`）。
- TODO の並び（`position` は最大値に 1 を足す、並び替えは持たない、削除は論理削除）。
- メモの正（DB とファイルの両方、mtime で突き合わせ、`fs.watch` と 300 ミリ秒のデバウンス、`memoHead` は 80 字）。
- スクラッチの擬似プロジェクト（端末ごとに 1 つ、ディレクトリ名は `<yyyymmdd-HHmmss>`）と昇格の手順。
- `SessionDto.fromScratch` と、再開の注意書き。
- 分割の持ち方（`SessionViewState.split` と `splitTab`、幅は `SplitPane` の中、保存しない）。
- パレットの項目と部分列一致の点の付け方。
- 要約器の設定（`lmStudioUrl`、`lmStudioModel`、`summaryFallback`、`summaryHourlyCap`）と入力の圧縮の上限。
- 要約ジョブの契機（run の終了とセッションを開いたとき、土台のままか 5 ターン以上の進み、1 セッション 1 ジョブ、直列）。
- Claude への切り替えの上限（1 時間の件数、7 日の使用率 80%、PATH に無ければ使わない）。
- `GET /api/bootstrap` の追加項目。

「未決事項」から次を消すか書き換える。

- 「OpenCode Provider の詳細設計。フェーズ 3 以降に別文書で書く」は「フェーズ 5 以降」に直す（フェーズ 3 では扱わなかった）。

Task 28 の Step 9 で記録した観察を「決めた前提」に書く。

- [ ] **Step 2: Intent の一覧を直す**

`docs/design.md` の Intent の一覧を次のように直す。

- `session.promote.submit` に `gitInit: boolean` を足す。
- `split.resize { ratio }` を `split.toggle` の隣に足し、「`SplitPane` の中で処理し、Root には届かない」と 1 文で書く。
- `artifact.openEditor { id }` を `artifact.open` の隣に足す。
- `summarizer.test` を `settings.update` の隣に足す。
- `session.openTerminalApp` の `tabId?` はフェーズ 2 で足してあるので、そのままにする。

- [ ] **Step 3: 本文の節を直す**

- 「アーティファクト」の節に、`artifact_calls` で呼び出しと結果を突き合わせること、題名を公開時に決めて保存すること、クリックはサーバ側の `open` で開くことを 3 文で足す。
- 「使用量」の節に、`hangar setup` の手順 4 と `hangar statusline install` の 2 つだけが追記すること、UI は追記の有無を読むだけであることを 2 文で足す。
- 「スクラッチと昇格」の節に、スクラッチは端末ごとに 1 つの擬似プロジェクトであること、`gitInit` を選べること、run が生きているとファイルを移動しないことを 3 文で足す。
- 「セッション要約」の節に、事後要約の契機（run の終了とセッションを開いたとき）と、要約器の順序（LM Studio、それから `claude -p`）と、切り替えの上限を 3 文で足す。
- 「ショートカット」の節に、ターミナルにフォーカスがあるときは ⌘ を含む組み合わせだけを受けること、`⌃⌥1` から `⌃⌥9` も常に受けることを 2 文で足す。
- 「MCP とローカル API」の「ツール」から「フェーズ 3 で対応します」の記述を消し、`update_project` が TODO とメモを書けること、`get_usage` が 5 時間と 7 日の使用率を返すことを 2 文で書く。
- 「フェーズ」の「フェーズ 3」の行末の「（執筆中）」を消す。

- [ ] **Step 4: 計画との差を記録する**

実装で計画から外れた点を「決めた前提と未決事項」に 1 行ずつ書く。
計画の作成時点で分かっている差は次の 1 つである。

- 分割にタブが 2 つ要ることの判定は、Mediator がストアを見ないので、`split.resolve` の効果を受けたランタイムが決めて `split.resolved` で返す。Mediator は返ってきた結果で状態を変えるか、トーストを出すかを選ぶ。

- [ ] **Step 5: README を直す**

`README.md` に「使い方（フェーズ 3）」の節を足す。

````markdown
## 使い方（フェーズ 3）

```sh
npx hangar statusline install   # statusline スクリプトに追記して、使用量ゲージを動かす
```

追記は承諾を求め、前にバックアップを取ります。
`~/.claude/settings.json` は書き換えません。

ヘッダーに 5 時間と 7 日の使用率のゲージが出ます。
値は Claude Code が statusline に渡す JSON が唯一の供給源なので、Claude が動いている間だけ新しくなります。

プロジェクト詳細の右レールで TODO とメモを書けます。
メモは `~/.agent-hangar/projects/<projectId>/memo.md` にも書き出すので、エディタから直接編集できます。

⌘⇧N で始めたスクラッチのセッションは、後から「プロジェクトに昇格」でワークスペースの下に移せます。

要約は LM Studio（`http://127.0.0.1:1234`）が既定で、繋がらないときだけ `claude -p` に切り替えます。
切り替えの上限は Settings で変えられます。

主なショートカットは、⌘K パレット、⌘N 新規、⌘⇧N スクラッチ、⌘, 設定、⌘1 から ⌘9 でタブ、⌘W でタブを閉じる、⌘\ で分割、⌘J でトランスクリプト、一覧では j と k と Enter と o と e と m です。
````

- [ ] **Step 6: コミット**

```bash
git add README.md docs/design.md
git commit -m "docs: readme and design updates for phase 3"
```

---

## 使い方（フェーズ 3）

```sh
npx hangar statusline install   # statusline スクリプトに追記して、使用量ゲージを動かす
npm run dev                     # サーバ（4177）と UI（5173）
```

ヘッダーの 5 時間と 7 日のゲージは statusline の payload だけを供給源にする。
プロジェクト詳細の右レールに TODO、Markdown のメモ、アーティファクトのカードが並ぶ。
⌘⇧N のスクラッチは後から「プロジェクトに昇格」でワークスペースへ移せる。
事後要約は LM Studio が既定で、繋がらないときだけ `claude -p` に切り替える。

## CLI について

フェーズ 3 で CLI に増えるのは Task 5 の 2 つだけである。

- `hangar statusline install`（`--yes` で承諾を省く）。
- `hangar setup` の手順 4（statusline への追記の提案）。

`hangar summarize <sessionId>` のような要約の手動起動は作らない。
要約は UI の「要約を作り直す」と `POST /api/sessions/:id/summarize` で足りるうえ、CLI から呼べると背景ジョブの直列化を壊しやすいからである。
Task 6 から Task 16 のサーバ側の機能も、CLI の新しいサブコマンドを必要としない。

## 実行の順序と並列化

依存の無いタスクは並列に実装できる。
実装者を同時に走らせるときは、次の組を目安にする。

1. Task 0（照合）→ Task 1（shared）→ Task 2（マイグレーションと問い合わせ）。
2. Task 3（UsageTracker）→ Task 4（jsonl の集計）。並列に Task 5（statusline と CLI）と Task 6（アーティファクトの抽出）。
3. Task 6 → Task 7（アーティファクトの問い合わせ）。並列に Task 8（TODO）と Task 9（メモ）。
4. Task 8 と Task 9 → Task 10（MCP）。並列に Task 11（スクラッチ）→ Task 12（昇格）。
5. Task 13（要約器の型）→ Task 14（2 つの要約器）→ Task 15（要約ジョブ）。Task 13 は Task 1 の後ならいつでも始められる。
6. Task 16（HTTP と結線）は Task 2 から Task 15 のすべての後。
7. Task 17（ストアと API）→ Task 18（Mediator）→ Task 19（ランタイム）。Task 20（Presenter）は Task 17 と Task 18 の後、Task 21（パレットと昇格の Presenter）は Task 20 の後。
8. Task 22（右レールとゲージ）、Task 23（分割とセッション画面）、Task 24（セッション行）、Task 25（オーバーレイ）、Task 26（Settings）は Task 21 の後で互いに並列 → Task 27（Root）。
9. Task 28（実物で確かめる）→ Task 29（文書）。

サーバ側（Task 2 から Task 16）と UI 側（Task 17 から Task 27）は、Task 1 の後なら並列に進められる。
ただし Task 28 は両方が終わってからでないと始められない。

## 自己点検（計画の作成時に確認したこと）

- 設計文書のフェーズ 3 の範囲（使用量、アーティファクト、TODO とメモ、スクラッチと昇格、タブと分割、事後要約、パレットとショートカット）に対応するタスクがある。使用量は Task 3 から Task 5 と Task 20 と Task 22 と Task 26、アーティファクトは Task 6 と Task 7 と Task 22、TODO とメモは Task 8 から Task 10 と Task 22、スクラッチと昇格は Task 11 と Task 12 と Task 21 と Task 25、タブと分割は Task 18 と Task 23 と Task 27、事後要約は Task 13 から Task 15 と Task 26、パレットとショートカットは Task 21 と Task 25 と Task 27。
- 設計文書の Intent の一覧に無い `split.resize`、`summarizer.test`、`artifact.openEditor`、`session.promote.submit` の `gitInit` を足した。Task 29 で設計文書に反映する。
- 設計文書の「ショートカット」の各行に対応がある。グローバルの 5 つと、タブとペーンの 4 つと、一覧の 6 つを Task 27 と Task 24 で実装し、ターミナルにフォーカスがあるときの規則を Task 27 の 1 つの条件式にまとめた。
- 型の名前が後のタスクで一致していること：`ArtifactCardProps` は `presenters/project.ts` に置き、`presenters/session.ts` と `views/ArtifactCards.tsx` がそこから import する。`TodoItemProps` も同じ場所にある。`UsageDto` は Task 3 の `UsageTracker.current()`、Task 16 の `GET /api/usage`、Task 17 の `Store.usage`、Task 20 の `UsageProps` がすべて同じ形を使う。`SummarizerTestDto` は Task 15 の `SummaryJob.test()`、Task 16 の `POST /api/summarizer/test`、Task 26 の表示が同じ形を使う。
- 分割の状態は Mediator が持ち、右に置くタブの決定だけをランタイムに委ねた。`transition` はストアを見ず、純関数のままである。`split.resize` は `SplitPane` の `IntentBoundary` で止まり、Mediator には届かない（Task 23 のテストが `onIntent` の呼び出し回数 0 で確かめる）。
- パレットの入力の文字と選択位置は Mediator に入れない。文字は Root の `useState`、選択位置は `CommandPalette` の `useState` で、どちらもダイアログの外へ出ない。
- CLI はフェーズ 3 で Task 5 の 2 つ以外に増えない（「CLI について」の節に理由を書いた）。
- 実物の `~/.claude` に書くのは statusline スクリプトへの追記だけで、Task 5 の `hangar statusline install` と `hangar setup` の手順 4、それに Task 28 の Step 2 に限られる。どれも承諾を求め、前にバックアップを取る。`settings.json` は読むだけである。
- テストは実物の `claude` も LM Studio も呼ばない。Task 14 は `fetch` と `spawn` の偽物を注入し、Task 15 は偽の `Summarizer` を渡す。Task 16 と Task 19 は `SummaryApi` の偽物を渡す。実物を呼ぶのは Task 28 だけで、Claude の起動は 2 回までである。
- フェーズ 1 とフェーズ 2 のテストで書き換えが要るものを各タスクに明記した：`SettingsDto` と `BootstrapDto` と `SessionDto` の拡張（Task 1）、`ProjectDto.isScratch` と `memoHead`（Task 2）、`ApiClient` の偽物と `boot`（Task 17）、`NOT_YET_INTENTS` のテスト（Task 18）、`harness` の `api` と `focus`（Task 19）、`presentShell` の `now`（Task 20 と Task 27）、`Header` の `usage` と `ProjectScreen` の右レール（Task 22）、`SessionProps` の追加項目と `TabStrip` の props（Task 23）、`SessionRowProps` の `cost` と `runId`（Task 24）、`SettingsProps`（Task 26）、`Root` の仮のパレット（Task 27）。
- 見た目は常にライトで、ダークモードの分岐をこの計画のどの CSS にも書かない。`prefers-color-scheme` を使うのは `prefers-reduced-motion` と同じ扱いの動きの抑制だけで、色には使わない。
