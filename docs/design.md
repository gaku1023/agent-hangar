# agent-hangar 設計文書

## この文書の位置づけ

この文書は、2026-09-17 の設計インタビューで確定した内容を、実装の基準として書き直したものである。
インタビューで決めたことは「決定」、決めずに筆者が埋めたことは「前提」として末尾にまとめる。
実装中に決定を変えるときは、この文書を先に直す。

## 目的と範囲

**agent-hangar** は、個人用のローカルなエージェントセッション管理アプリである。
Claude Code のセッションをプロジェクト単位で束ね、起動、観察、検索、記録を一箇所で行う。
Codex や OpenCode などの他のコーディングエージェントは、後から **Provider** として追加する。
初版で扱う Provider は Claude Code だけである。

このアプリが解決するのは次の不便である。

- セッションがどのプロジェクトの何の作業だったか、後から辿れない。
- 実行中のセッションがどこで何をしているか、一覧できない。
- 過去のセッションを条件付きで探す手段が、手元のスクリプトしかない。
- プロジェクトの進捗、TODO、メモ、生成物が、セッションと別の場所に散る。
- 別の PC に移ると、同じ作業を続けられない。

範囲外とするものも明記する。
Claude Code そのものの代替や、チャット UI の再実装はしない。
セッションの本文は Claude Code が書く jsonl を正とし、hangar はそれを読むだけである。
チームでの共有は範囲外で、利用者は本人と、同じ手順で自分の環境を作る家族に限る。

## 原則

設計を貫く原則を先に置く。

- **読み取り専用**：Claude Code の設定とデータを、hangar は原則として読むだけで書き換えない。`~/.claude` の中へ書く例外は次の 4 つだけである。
  - statusline スクリプトへの追記。承諾を求め、追記の前に同じディレクトリへバックアップを取る。
  - 利用者が明示的に押した「この PC で再開」で、他端末のセッション本文を `~/.claude/projects/` に写すこと。手元の本文を上書きするときは `~/.agent-hangar/backups/transcripts/` へ控えを取り、控えが取れなければ写さない。
  - クラウド同期で、他端末から引いた Claude Code のユーザー設定を書き戻すこと。Settings で明示的に有効にし、取り込む内容を確認したときだけ書く。上書きの前に `~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ 1 バイトも書かない。
  - 利用者が確認のダイアログで押した「書き込む」で、`~/.claude/settings.json` の `cleanupPeriodDays` の 1 か所だけを書き換えること。書く前に差分を見せ、`~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ書かない。ほかのキーと書式には触れない（「会話の保持期間」の節）。
- `~/.claude` の外では、`hangar shell install` が `~/.zshrc` の末尾に 1 行を足す。statusline と同じく CLI だけが承諾を求めて行い、足す前に同じディレクトリへ控えを取る。UI とサーバは `GET /api/shell-hook` で有無を読むだけである（「外のターミナルのセッション」の節）。
  - 加えて、`~/.claude/` の外にある `~/.claude.json` の `mcpServers.hangar` を `hangar mcp install` が書き換える。Claude Code の設定である点は同じなので例外に数える。`claude mcp add` に任せないのは、`--header` の値が argv に載り、64 桁のトークンが同じ機械の誰からでも `ps` で読めるためである。削除は今までどおり `claude mcp remove` に任せる（こちらはトークンを渡さない）。
- **ファイルを消さない**：hangar は利用者のファイルを削除しない。プロジェクトの削除は紐づけの解除であり、ディレクトリには触れない。例外はスクラッチを昇格するときの移動だけである。
- **サーバが正**：状態はローカルサーバが持ち、UI は描画に必要な値だけを受け取る。ブラウザでも Tauri でも同じ UI が動く。
- **Provider 非依存の表示**：トランスクリプトは正規化した共通形式に変換して描く。表示コードは Claude Code の jsonl 形式を知らない。
- **同期前提のスキーマ**：データはすべて端末間で同期できる形で持つ。フェーズ 1 から 3 では同期せずにこの形だけを保ち、フェーズ 4 で実際に同期した。
- **軽い索引**：巨大な jsonl を DB に丸ごと写さない。索引と検索用テキストだけを持ち、本文はファイルから読む。

## 全体構成

### パッケージ

TypeScript で統一し、Node 22 と npm workspaces のモノレポにする。
pnpm は手元で壊れているため使わない。

- `packages/shared`：正規化トランスクリプトの型、API と MCP の契約、Intent の型、要約の型。サーバ、UI、Worker のすべてが依存する。
- `packages/server`：ローカルサーバ。Hono による HTTP と WebSocket、MCP サーバ、SQLite（better-sqlite3）、インデクサ、tmux 制御、node-pty、要約器、同期エンジン。
- `packages/ui`：React と Vite による UI。Root から始まる階層、Passive View、Intent チェーン、Mediator。
- `packages/cloud`：Cloudflare Worker。Hono でサーバとコードを共有し、D1 と R2 を扱う。フェーズ 4 で実装した。
- `apps/desktop`：Tauri v2 のシェル。サーバを子プロセスとして起動し、ウィンドウに UI を表示する。フェーズ 5 で実装した。
- `packages/cli`：`hangar` コマンド。`setup`、`setup cloud`、`join`、`start`、`status`、`open`、`url`、`mcp install`、`statusline install`、`shell install`、`shell uninstall`、`shell status`、`cloud status`、`cloud teardown` を提供する。

### プロセスと通信

サーバは 127.0.0.1 の固定ポート 4177 で待つ。
UI は同じサーバから配信され、HTTP で読み書きし、WebSocket でイベントを受ける。
ターミナルは WebSocket 上の別チャネルで、node-pty の入出力をそのまま流す。
MCP は Streamable HTTP で、共通の `/mcp` とセッション別の `/mcp/s/<sessionId>` を持つ。
Tauri のシェルは、起動時にサーバの子プロセスを立て、終了時に止める。
Node は PATH に頼らず、Settings の `nodePath`、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、`~/.nvm/versions/node/*/bin/node`（新しい版を優先）の順で探す。
サーバ側でも親プロセスの生存を監視し、親が消えたら自ら終了する。
`hangar://` のディープリンクは deep-link プラグインで受ける。
ブラウザからも同じ UI が動くが、入口は鍵付きの URL に限る。
鍵の無い要求には 401 で `hangar url` を案内する画面を返す。
配布する `.app` には、esbuild で単一ファイルにまとめたサーバ（`server.mjs`）を、ネイティブモジュールと UI とともに同梱する。
ネイティブモジュールは Node の ABI に縛られるため、同梱時の Node のメジャー版とアーキテクチャを `manifest.json` に記録し、探索ではそれと一致する Node だけを採る。
起動時に 4177 で既にサーバが応答していれば、そのサーバを採用して子プロセスを起こさない。

## UI アーキテクチャ

### コンポーネント階層

すべてのコンポーネントは `Root` を頂点とする一つの木に属する。
木の形は画面構成と一致させ、親子関係がそのまま Intent の伝播経路になる。

```
Root
├─ Shell
│  ├─ Sidebar               ナビ項目（Home / Projects / Sessions / Settings）
│  ├─ Header                ロゴ、「探す・移動」の錠剤、使用率のゲージ、同期状態、新しいセッションのボタン
│  └─ Main
│     ├─ HomeScreen         RunningStrip / ActiveProjectCards / RecentSessions
│     ├─ ProjectsScreen     StatusSection × n → ProjectCard
│     ├─ ProjectScreen      ProjectHeader / SessionList / RightRail(TodoList, MemoEditor, ArtifactCards)
│     ├─ SessionScreen      SessionHeader(SummaryPanel) / TabStrip / SplitPane → TerminalPane | TranscriptPane
│     ├─ SessionsScreen     SearchBar / FilterBar / ResultList
│     └─ SettingsScreen     各設定セクション
└─ Overlays
   ├─ CommandPalette
   ├─ NewSessionDialog / NewProjectDialog / PromoteDialog / ResolveProjectDialog / TakeoverDialog
   └─ ToastStack
```

### Passive View と Presenter

各コンポーネントは **Passive View** であり、描画に関わる値だけを props で受け取る。
View は状態を持たず、API を呼ばず、他の View を知らない。
利用者の操作は、View が **Intent** を発行することでのみ外に伝わる。

View に値を渡すのは **Presenter** である。
Presenter はコンポーネントごとの純関数（または薄いフック）で、Mediator の状態とデータキャッシュから、その View の props を計算する。
Presenter は DOM に依存しないので、Mediator と合わせて単体テストできる。

データキャッシュは、サーバから WebSocket で届くイベントで更新される正規化ストアである。
Presenter はストアを読むだけで、書き込みはすべて Mediator の効果として行う。

### Intent とチェーン

Intent は `{ type, payload }` の判別可能な共用体で、`packages/shared` に定義する。
View は近い祖先から受け取った `emit` で Intent を発行する。
Intent は木を上へ伝播し、各層は「処理して止める」か「上へ渡す」かを選ぶ。
これが **Chain of Responsibility** であり、DOM のイベントではなく明示的な関数の合成で実装する。

React では次の形にする。

```ts
// packages/ui/src/intent/chain.ts
type Handled = { handled: true } | { handled: false };
type IntentHandler = (intent: Intent) => Handled;

const IntentContext = createContext<(intent: Intent) => void>(() => {});

export function useEmit() {
  return useContext(IntentContext);
}

// 中間層が一部の Intent を横取りしたいときに使う。処理しなければ親へ渡す。
export function IntentBoundary(props: { handle: IntentHandler; children: ReactNode }) {
  const parent = useContext(IntentContext);
  const dispatch = useCallback((intent: Intent) => {
    if (!props.handle(intent).handled) parent(intent);
  }, [parent, props.handle]);
  return <IntentContext.Provider value={dispatch}>{props.children}</IntentContext.Provider>;
}
```

中間層で処理する Intent は、その層だけで完結する見た目の操作に限る。
たとえば `SplitPane` はペーンの幅変更を処理し、`TabStrip` はタブのドラッグ並び替えを処理する。
それ以外はすべて `Root` に届き、Mediator が裁定する。

Intent の一覧は次のとおりである。
名前は `対象.動詞` で揃える。

```ts
type Intent =
  | { type: 'nav.go'; to: Route }
  | { type: 'palette.open' } | { type: 'palette.close' } | { type: 'palette.run'; command: PaletteCommand }
  | { type: 'search.query'; text: string } | { type: 'search.filter'; patch: Partial<SearchFilter> }
  | { type: 'search.more'; offset: number } | { type: 'search.clear' }
  | { type: 'project.open'; id: ProjectId } | { type: 'project.setStatus'; id: ProjectId; status: ProjectStatus }
  | { type: 'project.new.open' } | { type: 'project.new.submit'; name: string; gitInit: boolean; startSession: boolean }
  | { type: 'project.resolve.open'; id: ProjectId }
  | { type: 'project.resolve'; id: ProjectId; action: { kind: 'repoint'; path: string } | { kind: 'archive' } | { kind: 'unlink' }; confirmed?: boolean }
  | { type: 'project.openEditor'; id: ProjectId } | { type: 'project.openTerminalApp'; id: ProjectId }
  | { type: 'todo.add'; projectId: ProjectId; text: string } | { type: 'todo.toggle'; id: TodoId } | { type: 'todo.remove'; id: TodoId }
  | { type: 'memo.save'; projectId: ProjectId; markdown: string }
  | { type: 'artifact.open'; id: ArtifactId } | { type: 'artifact.openEditor'; id: ArtifactId }
  | { type: 'artifact.add'; projectId: ProjectId; url: string }
  | { type: 'session.open'; id: SessionId } | { type: 'session.setMemo'; id: SessionId; text: string }
  | { type: 'session.nextWaiting' }
  | { type: 'session.new.open'; projectId?: ProjectId; scratch?: boolean } | { type: 'session.new.submit'; params: LaunchParams }
  | { type: 'session.resume'; id: SessionId } | { type: 'session.fork'; id: SessionId }
  | { type: 'session.kill'; runId: RunId; working: boolean; shellTabs: number; confirmed?: boolean }
  | { type: 'session.openTerminalApp'; runId: RunId; tabId?: TabId } | { type: 'session.openEditor'; sessionId: SessionId }
  | { type: 'session.promote.open'; id: SessionId }
  | { type: 'session.promote.submit'; id: SessionId; name: string; gitInit: boolean; moveFiles: boolean }
  | { type: 'session.takeover'; id: SessionId; force: boolean }
  | { type: 'session.takeover.cancel'; id: SessionId }
  | { type: 'session.resumeHere'; id: SessionId; overwrite?: boolean }
  | { type: 'sync.config.preview' } | { type: 'sync.config.apply' }
  | { type: 'sync.joinToken.show' }
  | { type: 'summary.toggle'; sessionId: SessionId } | { type: 'summary.regenerate'; sessionId: SessionId }
  | { type: 'tab.open'; sessionId: SessionId; kind: 'agent' | 'shell' } | { type: 'tab.close'; tabId: TabId } | { type: 'tab.select'; tabId: TabId }
  | { type: 'split.toggle' } | { type: 'split.resize'; ratio: number } | { type: 'transcript.toggle' }
  | { type: 'transcript.showThinking'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.showRaw'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.follow'; sessionId: SessionId; follow: boolean }
  | { type: 'transcript.loadMore'; sessionId: SessionId }
  | { type: 'transcript.selectAgent'; sessionId: SessionId; agentId: string | null }
  | { type: 'index.rebuild' }
  | { type: 'overlay.close' }
  | { type: 'toast.dismiss'; id: string }
  | { type: 'sync.now' } | { type: 'sync.pause'; paused: boolean }
  | { type: 'settings.update'; patch: Partial<Settings> } | { type: 'summarizer.test' };
```

`session.takeover` と `session.takeover.cancel` は型にあるだけで、これを出すボタンはどの View にも無い。
引き継ぎをフェーズ 4 で作らなかったためである（後述）。
押しても何も起きない口を生やさないために、View からは `session.resumeHere` だけを出す。

`transcript.follow` の `follow: false` は、利用者が自分でスクロールを上げたときだけ発行する。
末尾へ送るスムーズスクロールの途中では発行しない。

`follow` は `localStorage` に残さない。
`SessionViewState` の他の項目は残すが、`follow` だけは保存の形から落とし、読み戻すときにも落として既定の真に戻す。
遡るために一度上へスクロールすると `follow: false` が焼き付き、次からそのセッションが最古の側で開いてしまうためである。
古い保存に残っている `follow` も、読み戻しのときに捨てる。

`split.resize` は `SplitPane` の `IntentBoundary` が処理して止めるので、Root にも Mediator にも届かない。

### Mediator の状態機械

`Root` が保持する **Mediator** は、自作の型付き状態機械である。
`transition(state, input) => { state, effects }` の純関数と、効果を実行する小さなランナーから成る。
入力は Intent と、サーバから届くイベント（`ServerEvent`）の二種類である。
効果は API 呼び出し、ナビゲーション、ターミナル接続の開閉、フォーカス移動、トースト表示に限る。

状態は直交する領域に分けて持つ。
領域ごとに小さな状態機械を書き、`transition` はそれらを合成する。

- `screen`：`booting | home | projects | project(id) | session(id) | sessions(query) | settings`。
- `overlay`：`none | palette | newSession | newProject | promote(sessionId) | resolveProject(projectId) | confirm(kind)`。引き継ぎのダイアログは作らなかったので `takeover(sessionId)` は無い。他端末の本文で手元を上書きしてよいかを聞く確認は `confirm('overwriteTranscript')` である。
外のターミナルの claude を引き取る確認は `confirm('adoptSession')`、ランを止める確認は `confirm('killRun')`、見つからないプロジェクトを一覧から削除する確認は `confirm('unlinkProject')` である。
- `sessionView(id)`：開いているタブの列、選択タブ、分割の有無、トランスクリプトペーンの開閉、要約パネルの開閉。
- `launch`：`idle | submitting | failed(message)`。
- `newSessionDraft`：新しいセッションのダイアログの書きかけ（名前と初期プロンプト）。1 つだけ持ち、ダイアログから起動し終えたら消す。
- `launchPrefs`：新しいセッションの詳細の、プロジェクトごとの前回値。鍵はプロジェクトの id で、スクラッチは `:scratch` の 1 枠である。
  どちらも端末ごとに localStorage（`newSession.draft`、`newSession.prefs`）に残し、起動時に読み戻す。形の違う値は捨てる。
- `connection`：`connecting | connected | disconnected`。
- `sync`：`off | idle(lastAt) | pushing | pulling | paused | error(message)`。

主要な遷移を表にする。

| 現在 | 入力 | 次 | 効果 |
| --- | --- | --- | --- |
| `booting` | `ServerEvent.ready` | `home` | 初期データ購読 |
| 任意 | `nav.go(to)` | `to` | URL 更新 |
| `overlay: none` | `session.new.open` | `overlay: newSession` | フォーカスを名前欄へ |
| `launch: idle` | `session.new.submit` | `launch: submitting`、送った詳細をそのプロジェクトの前回値に | `POST /api/runs`、前回値が変われば保存 |
| 任意 | `session.new.draft` | 書きかけを下書きに（名前も初期プロンプトも空白だけなら消す） | 変われば保存 |
| `launch: submitting` | `POST /api/runs` の応答 | `launch: idle`, `screen: session(id)` | ターミナル接続 |
| `launch: submitting` | `POST /api/runs` の失敗 | `launch: failed` | ダイアログ内に理由 |
| `session(id)` | `tab.open(shell)` | タブ追加 | `POST /api/runs/:id/tabs` |
| `launch: idle` | `session.resumeHere` | `launch: submitting` | `POST /api/sessions/:id/resume-here` |
| `launch: submitting` | 409（手元の本文の方が小さい） | `overlay: confirm('overwriteTranscript')`, `launch: idle` | なし |
| 任意 | `ServerEvent.projectUnresolved(id)` | `overlay: resolveProject(id)` | なし |
| `connection: connected` | WebSocket 切断 | `disconnected` | 再接続タイマー |
| 任意 | `settings.update`（欄の名前つき） | `settingsSave[欄]` を空に | `PATCH /api/settings`、済めば `settings.saved` か `settings.failed`、続けて `GET /api/readiness` |
| 任意 | `readiness.check` | なし | `GET /api/readiness` |
| 任意 | `shell.openLog`、`shell.restart` | なし | 殻の命令 `open_log`、`restart_app`（殻の中でだけ） |

状態機械の実装は `packages/ui/src/mediator/` に置き、領域ごとにファイルを分ける。
テストは「入力の列を与えて最終状態と効果の列を検証する」形で書く。

### 画面ごとの構成

各画面の Presenter が計算する値は、次の節の「画面」で画面ごとに述べる。
ここでは共通の約束だけを書く。

- 一覧は仮想スクロールで描く。1 行 44px の 2 段の行（1 段目に名前、2 段目に要約の 1 文）で、100 件を超えても遅くしない。
- 時刻は相対表示（「3 分前」）を基本にし、ホバーで絶対時刻を出す。
- 識別子、パス、時刻（04:28）、数だけの表示は等幅フォントで描く。数と仮名が混じる短い語（「12 分前」「1,222 件」「変更 5」）は本文の書体のまま、数字の幅だけをそろえる（`.num`）。
- UI の一時状態（開いているタブ、分割、折りたたみ、要約パネルの開閉）は端末の localStorage に保存し、同期しない。

## データモデル

### 方針

hangar 固有のデータは `~/.agent-hangar/hangar.db`（SQLite）に置く。
プロジェクトのメモだけは Markdown ファイルとして `~/.agent-hangar/projects/<projectId>/memo.md` にも置き、DB には更新時刻と内容の写しを持つ。
メモをファイルで持つのは、他のエディタや Claude 自身から直接読み書きできるようにするためである。

テーブルは **共有** と **端末ローカル** に分ける。
共有テーブルは端末間で同期し、ローカルテーブルは端末の中だけで使う。
共有テーブルの行はすべて次の列を持つ。

- `id`：UUID v7。端末をまたいで衝突しない。
- `updated_at`：ミリ秒の UNIX 時刻。競合の解決に使う。
- `deleted_at`：削除時刻。物理削除はせず、削除マークで表す。
- `origin_device`：行を最後に更新した端末の ID。

### 共有テーブル

```sql
create table devices (
  id text primary key, name text not null, platform text not null,
  last_seen_at integer, updated_at integer not null, deleted_at integer, origin_device text not null
);

create table projects (
  id text primary key, name text not null,
  status text not null check (status in ('active','paused','done','archived')),
  is_scratch integer not null default 0,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

-- 端末ごとのパス。同じプロジェクトが端末ごとに別のパスにあってよい。
create table project_roots (
  id text primary key, project_id text not null references projects(id),
  device_id text not null references devices(id), path text not null,
  resolved integer not null default 1,           -- 0 なら見つからず、解決ダイアログの対象
  updated_at integer not null, deleted_at integer, origin_device text not null,
  unique (project_id, device_id)
);

create table sessions (
  id text primary key,
  provider text not null,                         -- 'claude-code' | 'opencode' | ...
  provider_session_id text not null,              -- Claude Code では UUID
  project_id text references projects(id),        -- null は未分類
  name text,                                      -- hangar が保持する表示名
  cwd text not null,
  first_prompt text, ai_title text,
  started_at integer, last_activity_at integer,
  home_device text not null,                      -- 本文を最初に持った端末
  memo text,                                      -- 人間が書く 1 行メモ
  updated_at integer not null, deleted_at integer, origin_device text not null,
  unique (provider, provider_session_id)
);

-- 1 回の起動または再開。tmux 上の寿命と一致する。
create table runs (
  id text primary key, session_id text not null references sessions(id),
  device_id text not null references devices(id),
  kind text not null check (kind in ('start','resume','fork')),
  tmux_name text not null, pid integer,
  launch_params text not null,                    -- JSON
  started_at integer not null, ended_at integer, end_reason text,
  heartbeat_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

-- 追加のシェルタブ。run に属し、独立した tmux セッションを持つ。
create table run_tabs (
  id text primary key, run_id text not null references runs(id),
  tmux_name text not null, title text, created_at integer not null, closed_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

create table session_summaries (
  session_id text primary key references sessions(id),
  title text not null, one_liner text not null, body text not null,
  state text not null check (state in ('in_progress','done','blocked','abandoned')),
  next_steps text not null,                       -- JSON 配列
  source text not null check (source in ('baseline','in_session','post_hoc')),
  source_id text,                                 -- 書いた要約器の id。要約器を通さない要約と古い行は null
  source_model text, based_on_turns integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

create table todos (
  id text primary key, project_id text not null references projects(id),
  text text not null, done integer not null default 0, position integer not null,
  session_id text references sessions(id),
  updated_at integer not null, deleted_at integer, origin_device text not null
);

create table project_memos (
  project_id text primary key references projects(id),
  markdown text not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

create table artifacts (
  id text primary key, project_id text references projects(id),
  url text not null unique, title text, description text, favicon text,
  first_published_at integer not null, last_published_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

create table artifact_versions (
  id text primary key, artifact_id text not null references artifacts(id),
  session_id text not null references sessions(id), file_path text, published_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

-- 引き継ぎの握手の台帳。state は requested から acked か forced か cancelled へ一方向に進む。
-- フェーズ 4 では誰もこの表に書かない。引き継ぎを作らなかったためである（後述）。
create table takeover_requests (
  id text primary key, run_id text not null references runs(id),
  from_device text not null, requested_at integer not null,
  state text not null check (state in ('requested','acked','forced','cancelled')),
  updated_at integer not null, deleted_at integer, origin_device text not null
);
```

### 変更ログ

共有テーブルへの書き込みは、すべて `changes` に 1 行を追記する。
同期エンジンはこの表の未送信分を送る。
受け取った変更はこの表に積まず、行へ直接適用する。
この表に載るのは自分の端末が起こした変更だけなので、未送信の行は同じ `(table_name, row_id)` ごとに 1 行へまとめてよい。
この表はフェーズ 1 から作ってあり、フェーズ 4 の同期エンジンが初めて読み手になった。

```sql
create table changes (
  seq integer primary key autoincrement,
  table_name text not null, row_id text not null,
  op text not null check (op in ('upsert','delete')),
  payload text not null,                          -- 行全体の JSON
  updated_at integer not null, device_id text not null,
  pushed_at integer                               -- null は未送信
);
```

### 端末ローカルのテーブル

```sql
create table transcript_files (
  path text primary key, session_id text not null, agent_id text,
  size integer not null, mtime integer not null, indexed_bytes integer not null,
  indexer_version integer not null, last_error text,
  device_id text                                   -- その本文がどの端末のものか。null は手元
);

-- 1 イベント 1 行。本文は持たず、ファイル内の位置だけを持つ。
create table event_index (
  id integer primary key,
  session_id text not null, seq integer not null,
  kind text not null,                              -- 正規化イベントの種別
  ts integer, byte_offset integer not null, byte_length integer not null,
  file_path_ref text not null,                     -- 位置が指すファイル
  parent_agent text,                               -- サブエージェントの ID。null は主線
  tool_name text, file_path text                   -- tool_call のときだけ
);
-- 主線とサブエージェントで seq の空間を分ける。
create unique index event_index_pos on event_index(session_id, ifnull(parent_agent, ''), seq);

create virtual table event_fts using fts5 (
  session_id unindexed, agent_id unindexed, seq unindexed, role, text,
  tokenize = 'trigram'
);

-- 索引から導出した統計。共有しない。
create table session_stats (
  session_id text primary key,
  turns integer not null default 0,
  model text, effort text,
  files_changed integer not null default 0,
  pr_url text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  first_ts integer, last_ts integer,
  last_prompt text
);

create table usage_snapshots (
  at integer primary key, payload text not null    -- statusline から受けた JSON
);

-- statusline の payload から取る、セッションごとの付帯情報。
create table session_live_stats (
  provider_session_id text primary key,
  model text, effort text,
  context_used integer, context_size integer,
  cost_usd real,
  updated_at integer not null
);

-- Artifact ツールの呼び出しの控え。結果と突き合わせるために持つ。
create table artifact_calls (
  tool_id text primary key, session_id text not null,
  file_path text, description text, favicon text
);

-- jsonl の usage から導いた、セッションとファイルと日ごとのトークン数。
create table usage_daily (
  session_id text not null, day text not null, file_path text not null,
  input_tokens integer not null default 0, output_tokens integer not null default 0,
  primary key (session_id, file_path, day)
);

-- R2 との同期の台帳。同じ中身を二度上げず、降ろしたものが本物かを確かめるために持つ。
-- sha256 は上げる側も降ろす側も、圧縮と暗号化の前の平文の指紋である。
create table file_sync (
  key text primary key,                            -- R2 の鍵
  kind text not null,                              -- 'transcript' | 'config'
  path text not null, device_id text not null,
  sha256 text not null, size integer not null, mtime integer not null,
  remote_seq integer, synced_at integer not null
);

create table sync_state (key text primary key, value text not null);
create table settings_local (key text primary key, value text not null);
```

検索用テキストとして FTS に入れるのは、利用者の発言、アシスタントの本文、ツール呼び出しのファイルパスとコマンド文字列である。
ツールの結果本文は入れない。
トークナイザは trigram で、日本語の部分一致を助ける。

### 正規化トランスクリプト

`packages/shared` に、Provider 非依存のイベント型を定義する。
UI はこの型だけを描く。

```ts
type TranscriptEvent =
  | { kind: 'user'; seq: number; ts?: number; text: string; attachments?: Attachment[] }
  | { kind: 'assistant'; seq: number; ts?: number; text: string; model?: string }
  | { kind: 'thinking'; seq: number; ts?: number; text: string }
  | { kind: 'tool_call'; seq: number; ts?: number; toolId: string; name: string; input: unknown; summary: string; filePath?: string }
  | { kind: 'tool_result'; seq: number; ts?: number; toolId: string; text: string; isError: boolean }
  | { kind: 'subagent'; seq: number; ts?: number; agentId: string; label: string }
  | { kind: 'system'; seq: number; ts?: number; text: string }
  | { kind: 'meta'; seq: number; ts?: number; name: string; value: unknown };   // ai-title, pr-link など
```

`summary` はツール呼び出しを 1 行で表す文字列で、折りたたみ表示に使う（例：`Edit src/app.ts`）。
`meta` は表示しないが、索引の抽出元になる。

## Provider 抽象

### インターフェース

Provider は、あるコーディングエージェントの「保存形式」と「起動方法」を hangar に翻訳する層である。
UI とサーバの他の部分は、このインターフェースだけを見る。

```ts
interface Provider {
  readonly id: 'claude-code' | 'opencode';
  discover(): AsyncIterable<DiscoveredSession>;              // 既存セッションの列挙
  watch(onChange: (path: string) => void): () => void;       // 保存先の変化を通知
  readEvents(file: string, fromByte: number): AsyncIterable<{ event: TranscriptEvent; offset: number; length: number }>;
  liveStatus(): Promise<LiveSession[]>;                       // 実行中セッションの busy / idle
  launchCommand(params: LaunchParams): string[];              // 新規起動のコマンド列
  resumeCommand(session: Session, fork: boolean): string[];
  usage?(): Promise<UsageSnapshot | null>;
}
```

### Claude Code Provider

Claude Code の保存先と、その読み方を定める。

- 本文は `~/.claude/projects/<変換名>/<sessionId>.jsonl` にある。変換名は cwd の英数字以外を `-` に置き換えたもので、日本語を含むパスは不可逆になる。cwd は行内の `cwd` か `~/.claude/history.jsonl` の `project` から読む。
- `~/.claude/history.jsonl` は利用者の発言だけの軽い索引で、初回列挙に使う。
- ファイルの末尾には `last-prompt`、`mode`、`permission-mode`、`ai-title`、`pr-link` などのメタ行が混ざる。ほかにも `bridge-session`、`agent-name`、`custom-title`、`file-history-snapshot`、`file-history-delta`、`frame-link`、`cost-state`、`relocated`、`worktree-state`、`queue-operation`、`attachment` などがある。行の `type` で振り分け、知らない種別は `meta` として保持する。
- `user` 行の `message.content` は配列ではなく文字列のことがある。抽出は両方を受ける。
- サブエージェントの本文は `<sessionId>/subagents/agent-<hex>.jsonl` にあり、`isSidechain: true` で親に紐づく。件数はセッション本体の 3 倍以上あり、インデクサは両方を読む。
- 実行中の状態は `~/.claude/sessions/<pid>.json` にあり、`sessionId`、`cwd`、`name`、`nameSource`、`status`（busy か idle）を持つ。ファイルの出現と消失が起動と終了に対応する。
- 起動フラグは `--session-id`、`-n`、`--append-system-prompt`、`--mcp-config`、`--model`、`--effort`、`--permission-mode`、`-w`、`--add-dir`、`-r`、`--fork-session` を使う。

サブエージェントの本文は主線と別のファイルで独立に伸びるので、`event_index` の一意制約は `(session_id, ifnull(parent_agent, ''), seq)` とし、主線とサブエージェントで `seq` の空間を分ける。
セッション詳細でサブエージェントを選ぶと UI は `transcript.selectAgent` を発行し、表示する本文をそのサブエージェントのファイルに切り替える。

インデクサは各ファイルのバイト位置を `transcript_files` に持ち、追記分だけを読む。
1 セッションのファイルは主線の `<sessionId>.jsonl` を先に、`subagents/` 配下を後に読む。
途中で切れた最終行は次回に回す。
ファイルの変化は監視し、追記から数百ミリ秒で索引に反映する。
`indexer_version` を上げたときは、背景で全件を作り直し、進行を「N / 総数 件」の静的な文字で示す。
フェーズ 0 の計測では、733 ファイル 1.34GB の全件索引化が 7 秒、DB は 183MB だった。
フェーズ 1 の実装では、791 ファイル、40 プロジェクト、1,127 セッションの全件索引化に約 15 秒かかった。

## セッションの起動と観察

### tmux による起動

hangar が起動するセッションは、すべて tmux セッションの中で動く。
tmux を使うのは、hangar を再起動してもセッションが生き続け、ブラウザとターミナルアプリから同時に同じ画面を見られるからである。
Claude Code の `--tmux` フラグは使わず、hangar が自分で tmux セッションを組む。
iTerm2 のネイティブペインに変わるのを避けるためである。

起動コマンドの形は次のとおりである。

```sh
tmux new-session -d -s hangar-<runShort> -c <cwd> -- \
  env HANGAR_RUN_ID=<runId> \
  bash ~/.agent-hangar/bin/hangar-run.sh ~/.agent-hangar/logs/run-<runId>.log \
  <claude の絶対パス> \
    --mcp-config ~/.agent-hangar/mcp/<sessionId>.json \
    [--add-dir <dir>]... \
    --session-id <sessionUuid> -n "<name>" \
    --append-system-prompt "<生成した指示>" \
    [--model <m>] [--effort <e>] [--permission-mode <p>] [-w <name>] \
    ["<初期プロンプト>"]
```

`--session-id` を hangar が生成して渡すので、本文ファイルのパスは起動前に確定する。
`--mcp-config` には JSON の文字列ではなく、権限 0600 のファイルのパスを渡す。
JSON には Bearer トークンが入るので、文字列で渡すと claude の argv に載り、同じ利用者の権限で動く任意のプロセスが `ps` から 64 桁を読めてしまう。
ファイルは `~/.agent-hangar/mcp/<sessionId>.json` に置き、run が終わったときに消す。
消し損ねたものは、次の起動と起動時の回復のときに、生きている run のぶんを残して落とす。
`--mcp-config` と `--add-dir` は可変長オプションで、直後の位置引数を飲み込む。
起動コマンドの組み立てでは、可変長オプションを他のオプションの前に置き、初期プロンプトは必ず末尾に置く（フェーズ 0 の検証で、逆順にすると初期プロンプトが設定ファイル名として解釈されて即時終了した）。
tmux で `claude` を直接起動すると異常終了時の出力が失われるので、薄いラッパースクリプトを介して起動し、終了コードと標準エラーをログに残してから tmux セッションを閉じる。
hangar のセッションでは `tmux set-option -t <name> status off` でステータス行を隠す。
新しいディレクトリで Claude を起動すると最初に信頼確認ダイアログが出るので、起動直後はターミナルを前面に出し、ダイアログが出ている旨を表示する。
node-pty の prebuild は補助バイナリ `spawn-helper` に実行権限が無い状態で展開されることがあるため、サーバの起動時に権限を確認して直し、spawn の失敗は捕まえて接続だけを閉じる。
tmux は `which tmux` で得た絶対パスを設定に保存して spawn する。
claude も同じく絶対パスで渡す。
`tmux new-session` に渡したコマンドは、tmux サーバのグローバル環境ではなく **tmux を spawn した側（hangar）の環境** を継ぐ。
`.app` を Finder から起こすと hangar の `PATH` は `/usr/bin:/bin:/usr/sbin:/sbin` だけになり、
`~/.local/bin` に入るネイティブ版の claude は裸の名前では引けない。
渡してしまうと応答は成功のまま、ペインの中で `command not found` の 127 で落ちるだけなので、
利用者はターミナルを開くまで理由が分からない（実際に 5 件の run がこれで落ちた）。
場所は `HANGAR_CLAUDE_BIN`、Settings の `claudePath`、`which('claude')` の順に決め、
どれでも決まらないときは tmux を起こす前に 400 で断る。
`which` は GUI 起動の貧弱な `PATH` を補うため、Homebrew に加えて `~/.local/bin` と `~/.claude/local` も見る。
`claudePath` は後から足した項目なので、`toolsResolved` では止めず、項目が無いうち（undefined）だけ埋める。
既に使っている `settings.json` には `toolsResolved: true` が入っており、一括で止めると永久に埋まらないからである。
デスクトップアプリ側も、サーバを起こすときの `PATH` に手元のツールの置き場所を足す。
これは念のための備えで、場所を決める正本はサーバ側にある。
起動ダイアログの必須項目はプロジェクトだけで、名前と初期プロンプトは任意である。
model、effort、permission mode、worktree、追加ディレクトリは折りたたみに置き、既定値は利用者の Claude Code 設定に従う。
プロジェクトは検索欄つきの一覧から選び、「最近」の 5 件と「すべて」の 2 群に分け、行に状態の色の点と最後に使った時期を添える。
model は択一のチップで「ほか」を選ぶと入力欄に変わり、effort は切り替えの帯で、permission mode は意味を添えたカードで選ぶ。
折りたたみの見出しには、既定以外を選んだ値を並べる。
「確認なし」を選ぶと、カードを赤で縁取り、確認せずに実行する旨の警告を出す。

⌘Enter（Ctrl+Enter でも）は、ダイアログのどこからでも起動する。
初期プロンプトの欄では素の Enter が改行なので、欄の中から起動する手がこれになる。
起動ボタンの中に ⌘↵ のキー帽を置き、押す場所とキーが一緒に目に入るようにする（読み上げの名前は「起動」のままで、`aria-keyshortcuts` を添える）。

名前と初期プロンプトの書きかけは、どの経路で閉じても（やめる、×、Esc）下書きとして残す。
ダイアログは閉じるときに書きかけを `session.new.draft` で送り、打鍵のたびには送らない（送るたびに画面全体を描き直すことになるため）。
下書きはプロジェクトごとではなく 1 つだけ持つ。
次に開くと、名前と初期プロンプトに戻し、見出しの右に「下書き」の札と「消す」を出す。
「消す」は欄を空にし、下書きも消す。
ダイアログから起動し終えたら、下書きは役目を終えたので Mediator が消す。
送った後に Esc などでダイアログを閉じても起動は続くので、送った印（`newSessionSent`）を持ち、閉じた後に起動し終えても消す。
起動に失敗したら下書きは残し、印だけ外す。

model、effort、permission mode、追加ディレクトリは、選んだプロジェクトで前回起動したときの値を初期値にする。
worktree は残さない。同じ名前が毎回初期値に入ると、前の worktree の中で起動してしまうからである。
前回値は送った時点で残す（起動に失敗しても、選んだ詳細は利用者の意図なので残す）。
既定のまま起動したら、そのプロジェクトの前回値を消す。
前回値のままなら、詳細の見出しに「前回と同じ」の札と中身（例：opus、high、編集は任せる）を出し、右端に「既定に戻す」を置く。
既定に戻すは見出しの中にあるが、押しても詳細を開閉しない。
値を 1 つでも替えると、札を外していつもの「詳細（…）」に戻る。
詳細に触れる前にプロジェクトを選び直したら、そのプロジェクトの前回値に入れ替える。
触れた後は、自分で選んだ値を残す。

プロジェクトを選ばずに起動を押したときの「プロジェクトを選んでください」は、プロジェクトを選び直したら消す。
送り直して同じ失敗が返れば、また出す。

### 実行中の状態

サーバは `~/.claude/sessions/` を監視し、run と結びつける。
結びつけの鍵はセッション UUID である。
`status` は busy、idle、waiting の 3 値で、waiting は AskUserQuestion などで利用者の入力を待っている状態である。
UI の状態点はこの 3 値をそのまま使い、waiting は入力待ちの知らせ（「入力待ちの知らせ」の節）の対象にする。
プロンプト送信から busy まで約 0.5 秒、終了からファイルの消失まで約 0.4 秒で、500 ミリ秒間隔の監視で足りる。
`-n` や `/rename` で付けた名前は本文にも記録として残り（`agent-name`、`custom-title`）、再開やフォークの先にも引き継がれる。
hangar は名前を本文の記録から読み、レジストリの値で上書きする。
tmux セッションが消えたら run を終了とみなし、`end_reason` を記録する。

UI のターミナルは xterm.js で、サーバ側の node-pty が `tmux attach -t <tmux_name>` を実行して入出力を中継する。
リサイズは xterm.js の寸法を PTY に伝える。

ターミナルの打鍵と写しは次のようにする。

- Shift+Enter は ESC CR（`\x1b\r`）を送り、Claude Code では送信ではなく改行になる。
  Claude Code の /terminal-setup が VS Code の Shift+Enter に書き込む列と同じで、tmux の extended-keys の設定によらず中のアプリへ届く。
  zsh の emacs キーマップでも実行されずに改行が入る。
  日本語の変換中は横取りしない。
- Option を押しながらドラッグすると、tmux や Claude Code がマウスを取っていても文字を選べる（`macOptionClickForcesSelection`）。
  Option を押した短いクリックでカーソルを動かす機能（`altClickMovesCursor`）は切る。
  Claude Code の入力欄では矢印の列が履歴の呼び出しになり、書きかけの指示が入れ替わるからである。
  `macOptionIsMeta` は偽のままにして、Option で打つ記号（JIS 配列の Option+¥ など）を残す。
- 端末の中のアプリが OSC 52 で写したものは、`@xterm/addon-clipboard` で受けてクリップボードへ書く。
  読み出しの要求には空で答える（端末の中のどのプログラムでもクリップボードを読めてしまうため）。
  tmux が OSC 52 を外へ通すように、サーバは attach の前に `set-clipboard` が on でも off でもなければ `set-option -s set-clipboard on` にする。
  この設定は利用者の既定の tmux サーバ全体に効くが、利用者の決定（2026-10-01）でそのままにした。
  WKWebView ではクリップボードへの書き込みに利用者の操作から 5 秒の枠があり、その外で届いた写しは捨てられる。
- ⌘+ と ⌘− と ⌘0 はターミナルの文字の大きさを 1px ずつ変える（既定 13、8 から 32）。
  全部のタブに効かせて寸法を合わせ直し、大きさは localStorage に覚える。
  ターミナルが画面に無いときは受けず、ブラウザの拡大に渡す。
  セッション画面でも、終わったセッションの本文だけでターミナルが無ければ同じである。
複数のクライアントが同じ tmux セッションに attach してよい。

### セッション内タブ

セッション画面のタブ 0 は Claude が動く tmux セッションである。
「＋」で追加する各タブは、同じ cwd で利用者のログインシェルを起こした独立の tmux セッション（`hangar-<runShort>-t<n>`）である。
tmux の window ではなく別セッションにするのは、同じ tmux セッションに複数のクライアントが attach すると「現在の window」を共有してしまい、ブラウザの 2 つのタブが互いに切り替わってしまうからである。
シェルタブは Claude が終了しても残り、明示的に閉じるか run を片付けるときに閉じる。
「ターミナルで開く」はタブ単位である。
既定は `tmux attach` を書いた `.command` ファイルを `open -a Terminal` で開く経路で、AppleEvent を使わないため macOS の自動化許可が要らない。
ディレクトリを開くときの既定の shell の決め方（`${SHELL:-/bin/zsh}` を `-l` で起こす）は、`.command` の経路と iTerm2 の経路で同じにする。
iTerm2 を使う設定にしたときは AppleScript で新規ウィンドウを開く。初回に macOS の自動化許可ダイアログが出るので、Settings で有効化したときに一度だけ案内し、Tauri の Info.plist に `NSAppleEventsUsageDescription` を入れる。AppleScript には 10 秒のタイムアウトを付け、失敗したら Terminal.app の経路に落とす。

### 指示の注入

hangar が起動するセッションには、`--append-system-prompt` で短い指示を渡す。
ファイルや設定は書かず、モデルや effort は現在の設定のままである。
指示の内容は次の要素からテンプレートで生成する。

```
あなたは agent-hangar から起動されたセッションです。
プロジェクト：<name>（<path>）
プロジェクトのメモの要約：<memo の先頭 500 字>
未完の TODO：<最大 10 件、各行 - [<id>] <本文>>
過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。
依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、
set_session_summary で題名、2〜3 文の要約、状態、次の一手を更新してください。
TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。
完了にするのは利用者です。確かめられていないものは出さないでください。
頼まれたことを終えたと判断したターンの終わりに、AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <戻る日。時刻に意味があれば時刻も>（何を確かめに戻るか）」「まだ続ける」です。
利用者が Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。
Paused の戻る日は return_on（YYYY-MM-DD）に、確かめる時刻が決まっているときは return_time（HH:MM、手元の時刻）にも渡してください。時刻を note の文だけに書かないでください。
途中のターンでは聞かないでください。
ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。
Bash と Agent の description は日本語で 20 字以内にしてください。
```

MCP の URL はセッション別（`/mcp/s/<sessionId>`）なので、ツールは呼び出し元のセッションをサーバ側で確定できる。
モデルにセッション ID を扱わせる必要はない。

Paused の戻る時点は、日付（`return_on`、YYYY-MM-DD）と、任意の時刻（`return_time`、HH:MM）で持つ。
どちらも手元の暦と時計で読み、時刻が無ければ「その日のうち」として扱う。
時刻を日付と別の列にしたのは、上げていない PC が同期で受け取ったときに、知らない列として捨てるだけで日付をそのまま読めるようにするためである。
`propose_session_status` は過去の時点を断り、返す状態にオフセット付きの `returnAt`（`2026-10-05T13:30+09:00`）を添えて、どのゾーンで読んだかを残す。
過去を断るのは MCP の入口だけで、画面からの確定と同期では断らない（時刻を過ぎた提案を確定でき、届いた行を弾かないため）。
持つ時点は 1 つだけである。同じ日に 2 回確かめたいときは、戻って resume したときに状態が外れ、区切りの問いで次の時点を入れる。
時刻つきの Paused は、当日は朝から「今日戻る」に出し、時刻を過ぎてから札を塗る。同じ日の中は時刻の早い順で、時刻なしはその日の最後に並べる。
時刻を過ぎたら、右下に札を 1 回出し、通知を受け取る設定で窓が背面なら OS の通知も出す（知らせ終えた時点は localStorage に覚える。画面の時計で見るので、hangar を開いていない間は出ない。開いたときに、その日に過ぎた分を 1 回知らせる）。
日付だけの Paused は知らせない。

状態の問いは、依頼を終えた区切りでだけ AskUserQuestion で聞かせる。利用者が選んだものは `propose_session_status` の `confirmed: true` でそのまま状態になり、答えずに進めたものは候補として残る。
この指示は hangar が `--append-system-prompt` で起こす会話に渡る。ターミナルで claude.zsh から起動した claude も hangar の run になるので、同じ指示を受け取る。
`claude attach` で開く会話（attach、バックグラウンドのセッションの再開）には渡らないので、そちらは事後の要約で拾う。

### 再開とフォーク

過去のセッションは「再開」と「フォーク」を持つ。
再開は同じ cwd で `claude -r <uuid>` を tmux 上で実行し、`kind = 'resume'` の run を作る。
フォークは `claude -r <uuid> --fork-session --session-id <新 uuid>` で、新しいセッション行と `kind = 'fork'` の run を作る。
同じセッションに生きた run があるときは、再開を無効にする。

### スクラッチと昇格

リポジトリ名を決める前に使い捨てのセッションを回したい、という用途のために **スクラッチ** を用意する。
「スクラッチで始める」は `~/.agent-hangar/scratch/<yyyymmdd-HHmmss>/` を作り、そこを cwd にセッションを起動する。
起動ダイアログのプロジェクトの一覧は、先頭の「すぐ始める」の群にスクラッチの行を置き、選ぶと見出しを「スクラッチで始める」に変える。
⌘⇧N、パレット、スクラッチのプロジェクト画面は、この行を選んだ状態でダイアログを開く。
スクラッチの詳細の前回値は、どのスクラッチのディレクトリでも共通の 1 枠に持つ。
スクラッチのセッションは `is_scratch = 1` の擬似プロジェクトに属する。
この擬似プロジェクトは端末ごとに 1 つで、どのスクラッチのディレクトリで起動したセッションもすべてここに属する。

セッション画面の「プロジェクトに昇格」は、名前と、何が起きるかを添えた 2 つの選択（`git init` するか、ファイルを移すか）を受け取って次を行う。

1. `<workspaceRoot>/<name>` を作り、`git init` が選ばれていれば実行する。
2. 新しいプロジェクト行と、この端末の `project_roots` を作る。
3. セッションの `project_id` を新プロジェクトに変える。
4. セッションの run がすべて終了していれば、スクラッチ内のファイルを新ディレクトリへ移動する。run が生きていれば移動はせず、その旨を表示する。
5. 「この場所で新しいセッションを開始」を提案する。

run が生きている間はファイルを移さず、`moved: false` と理由を返す。
移動の途中で失敗したら、そこまでに移したものを逆順に戻してから理由を返す。
cwd の実体がスクラッチの外を指すシンボリックリンクのときも移さない。

本文ファイルの cwd は変わらないので、昇格後にこのセッションを再開すると cwd はスクラッチのままである。
再開ボタンにはその注意を添える。

## セッション要約

一覧とヘッダーに「このセッションは何をしていたか」を出すために、**セッション要約** を持つ。
要約は題名、1 文、2〜3 文の本文、見立て（`in_progress`、`done`、`blocked`、`abandoned`）、次の一手から成る。
見立ては、Claude が要約を書いた時点でその仕事がどこまで進んだかを表し、画面では「やりかけ」「済んだ」「詰まっている」「やめた」と出す。
セッションのプロセスが生きているか（実行中、終了）とは別物なので、それと重ならない語にしている。
閉じているときは題名と 1 文だけを出し、ヘッダーのパネルを開くと全部を出す。

要約は三つの経路で作る。

- **土台**：インデクサが `ai-title`、最初と最後のプロンプト、触ったファイル、ターン数、期間から機械的に作る。全セッションに即時にあり、`source = 'baseline'` で保存する。
- **セッション自身**：hangar が起動したセッションは、注入した指示に従って節目に `set_session_summary` を呼ぶ。文脈を持っているので最も正確で、追加コストがない。`source = 'in_session'`。
- **事後生成**：run 終了時に要約が土台のままか、最後の更新から 5 ターン以上進んでいれば、要約器で作り直す。セッションを開いたときも同じ条件で作る。`source = 'post_hoc'`。

事後生成のスキーマは、要約に加えてセッションの状態の提案（`proposed_status` が done・paused・none、`proposed_note`、`proposed_return_in_days` が paused のとき 1〜14）を返させる。
提案は、要約を書いた直後に、状態も提案も無く、却下もされておらず、セッションが止まっているときだけ `source = 'post_hoc'` の候補として書く。戻る日は書いたときの手元の暦から数える。
読み取りは提案の 3 つを任意として扱い、返さないモデルでも要約は従来どおり書く。

要約には、どの経路で作ったか（`source`）に加えて、どの要約器が書いたか（`source_id`）とそのモデルの名前（`source_model`）を持つ。
土台とセッション自身の要約は要約器を通さないので、どちらも持たない。
`source_id` が無かった頃の行は、種類を推し量らずに「不明」と出す。

過去の全件を背景で埋めることはしない。

事後生成の契機は、run が終わったときと、セッション画面を開いて先頭ページを読んだときの 2 つである。
run の終了からの契機だけは、レジストリの生存判定を飛ばす。
セッションの生存を 500 ミリ秒周期のキャッシュで見ているため、止めた直後はまだ「実行中」と判定されてしまうからである。
飛ばすのは生存判定だけで、土台のままか 5 ターン以上進んだかの判定は残る。
要約器は LM Studio を先に試し、使えないときだけ `claude -p` に切り替える。
切り替えは 1 時間あたりの件数（既定 20、1 から 200 まで）と週の枠の使用率 80% で止め、`claude` が PATH に無ければ使わない。

要約器は差し替え可能な部品にする。

```ts
interface Summarizer {
  readonly id: 'lmstudio' | 'claude-headless';
  available(): Promise<boolean>;
  summarize(input: SummaryInput): Promise<SessionSummary>;
}
```

既定は LM Studio である。
OpenAI 互換の `http://127.0.0.1:1234/v1/chat/completions` に、JSON スキーマ付きで投げる。
モデル名は Settings で選ぶ。
既定のモデルは思考を行わない指示追従モデル（フェーズ 0 では gemma 26B が 1 件 6〜7 秒で安定した）にする。
思考モデルは既定の出力上限を思考で使い切って本文が空になることがあるので、本文が空なら失敗として扱い、フォールバックへ回す。
初回のモデル読み込みに 1 分近くかかるため、Settings に「要約器を試す」を置いて事前に温められるようにする。
見立ての判定基準（最後のターンが利用者への問いなら `in_progress`）はプロンプトに明示する。

要約器には会話の本文（利用者の発言とアシスタントの応答）がそのまま送られる。
そこで宛先は既定でループバックだけに閉じ、`127.0.0.1`、`localhost`、`::1` 以外のホストは 400 で断る。
設定の「外部の要約器を許す」を入れたときだけ、外の宛先を受け付ける。
スイッチの下には「127.0.0.1 と localhost 以外の宛先へ本文を送れるようにします。」と淡い 1 行で添える。
許しと宛先は同じ要求の中で突き合わせるので、片方ずつ変えて素通りさせることはできない。
この印を入れている間は、Settings に「会話の本文がこの宛先へ送られます」という警告を出し、宛先の URL を添える。
設定ファイルを手で書き換えて外の宛先を入れても、読み込みのときに既定へ戻す。

要約器への問い合わせはリダイレクトを追わない（`redirect: 'manual'`）。
追うと、ループバックだと思って許した宛先が 302 を返すだけで、会話の本文が外のホストへ送られてしまう。
宛先の検査は最初の URL にしか効かないので、追わないことでしか塞げない。
3xx が返ったときは失敗として扱い、次の要約器へ回す。
モデル一覧の問い合わせも同じで、リダイレクトが返れば一覧は空として扱う。

LM Studio に繋がらないときは `claude -p --model haiku --output-format json --json-schema <schema>` に切り替える。
こちらはサブスクリプションのレート制限を消費するので、1 時間 20 件までとし、週の枠の使用率が 80% を超えたら止める。
結果は出力 JSON の `structured_output` から読む。入力はパイプで渡し、渡すものが無いときは `< /dev/null` を付けて標準入力の待ちを避ける。
Haiku でも思考が走り 20〜40 秒かかるため、事後生成は背景ジョブにして UI には「要約を作成中」を出す。

入力は、利用者の発言を全文（1 件 2,000 字まで）、アシスタントの本文を各 600 字まで、ツール呼び出しを 1 行ずつにして、全体をおよそ 8,000 トークン相当（日本語で 12,000 字前後）に収める。
超えるときは中盤を間引き、最初と最後を残す。

## MCP とローカル API

### 認証

サーバは 127.0.0.1 にだけバインドする。
API と MCP は、`~/.agent-hangar/token`（権限 0600）に置いたローカルトークンを Bearer で要求する。

#### 鍵付きの入口

UI を初めて開くときは、鍵を載せた入口の URL を使う。
`hangar start` は起動のたびに `http://127.0.0.1:4177/?t=<トークン>` を印字し、`--no-open` を渡していなければ既定のブラウザでそれを開く。
`hangar open` も同じ URL を印字してから開く。
ただし `hangar open` は、開く前に `/health` を見て、サーバが動いていなければ開かずに終了コード 1 で終わる。
`hangar url` は同じ URL を印字するだけで、ブラウザは開かない。
起動の後に鍵付きの URL を見直す道はこれだけで、401 の案内もこのコマンドを指す。
鍵を端末にだけ印字するのは、サーバのログに載せないためである。
`hangar start` が待ち受けに失敗したときは、生のスタックではなく日本語の 1 行を出して終了コード 1 で終わる。
使用中のポート、権限の無いポート、そのほかの失敗を、それぞれ次の一手の分かる文にする。

`GET /` は、クエリの `t` か、既に持っているクッキーのどちらかが合うときだけ UI の HTML を配る。
合わないときは案内だけを書いた HTML を 401 で返し、トークンは配らない。
鍵の無い `GET /` にクッキーを配ると、`curl` 1 本で誰でもトークンを取れてしまうためである。
配るときに同じトークンを `HttpOnly`、`SameSite=Strict`、`Path=/`、有効期間 1 年のクッキーとして発行する。
UI は `history.replaceState` で URL から `?t=` を消すので、鍵はアドレス欄に残らない。
以後はブックマークから鍵無しで開ける。

`GET /` の応答には、鍵の有無に関わらず `X-Frame-Options: DENY` と CSP を付ける。
`SameSite=Strict` の「サイト」はポートを数えないので、手元の別のポートに置かれたページに枠で嵌められると、クッキーの載った UI を被せて押させる手が成り立つ。
枠を止めるために `frame-ancestors 'none'` と `X-Frame-Options` の両方を返す。
CSP の残りは配っている `dist` の作りに合わせて絞る。
インライン script は無いので `script-src 'self'` だけでよく、style は React の style 属性と xterm が実行時に書くので `'unsafe-inline'` が要る。
font は `@fontsource` の woff のために `data:` を許す。
img もサイドバーのロゴのために `data:` を許す。
ロゴの原図（`packages/ui/src/brand/logo.svg`）は Vite がインライン化する上限より小さいので、ビルドで data URI として JS に埋め込まれるからである。
favicon は `/assets/` に別のファイルとして出るので、`data:` を使わない。
img の `data:` を外すと、サイドバーのロゴが描かれなくなる。
`connect-src` は同じ元と、ターミナルの WebSocket のためのループバックだけにする。
`object-src 'none'`、`base-uri 'none'`、`form-action 'self'` も付ける。

#### 入口の 3 つの検査

`/api` 配下は、トークンの照合に加えて次の 3 つを見る。

- **Origin**：待ち受けているポートから組み立てた `http://127.0.0.1:<port>` と `http://localhost:<port>`、それに `tauri://localhost` を許す。開発用の Vite の 5173 は `HANGAR_DEV=1` のときだけ足す。`Origin` の無い要求は `curl` や MCP クライアントなので通す。
- **`Sec-Fetch-Site`**：状態を変える動詞では `same-origin` と `none` だけを通す。`HANGAR_DEV=1` のときは `same-site` も通す。ブラウザはこの見出しを必ず送るので、別のページからの書き込みはここで落ちる。`curl` と MCP クライアントは送らないので、今までどおり通る。
- **`Content-Type`**：本文を持つ要求は `application/json` だけを通し、ほかは 415 で断る。`text/plain` は前検査（preflight）の要らない「単純な要求」で送れてしまうためである。本文を持たない `curl -X POST` はどちらの見出しも付けないので、今までどおり通る。`curl` で本文を送るときは `-H 'Content-Type: application/json'` が要る。

`SameSite` の「サイト」はスキームと登録可能ドメインで決まり、ポートを数えない。
つまり `http://127.0.0.1:5173` と `http://127.0.0.1:4177` は同一サイトであり、`SameSite=Strict` のクッキーは前者から後者への要求にも載る。
5173 を常時許さないことと `Sec-Fetch-Site` を見ることは、どちらもこの経路を塞ぐためにある。

Origin と `Sec-Fetch-Site` で断るときは、どちらで断ったかを区別できない同じ応答を返す。
攻撃者に手掛かりを与えないためである。

`/ws` と `/ws/pty` は、`Authorization` ヘッダとクッキーからだけトークンを読む。
クエリ文字列のトークンは受け付けない。
URL に載せると、鍵がブラウザの履歴と中間のログに残るためである。

MCP は Origin の一覧を共有せず、`http://localhost:4177`、`http://127.0.0.1:4177`、`tauri://localhost` の 3 つに限る。
MCP クライアントは `Origin` を送らないので、ヘッダが無い要求は通す。
MCP クライアントには、`hangar mcp install` と `--mcp-config` がヘッダ付きの設定を書くので、利用者がトークンを扱う場面はない。

#### トークンを引数に載せない

トークンは、どの経路でもプロセスの引数には載せない。
引数は `ps -ww -o command=` で同じ機械の誰にでも読めるためである。
run を起こすときの `--mcp-config` には、JSON の文字列ではなく `~/.agent-hangar/mcp/<sessionId>.json`（権限 0600）のパスを渡し、run の終了でそのファイルを消す。
消し損ねた分は、次の起動と起動時の回復で、生きている run のもの以外をまとめて消す。
statusline のスニペットは、`~/.agent-hangar/statusline-header`（権限 0600）に置いた `Authorization: Bearer <トークン>` の 1 行を `curl -H @<ファイル>` で読む。
`-H @<ファイル>` は中身をヘッダの行として読むので、curl の argv にはファイルの名前しか出ない。
この書き方は curl 7.55 以降にある。
鍵付きの URL をブラウザで開くときも、`open <URL>` ではなく `osascript -` に標準入力で AppleScript を流し込む。
`open <URL>` だと鍵の載った URL が argv に出て、同じ利用者のどのプロセスからも `ps` で読めるためである。

#### run ごとの MCP の秘密

hangar が起こす `claude` には、本体のトークンを渡さない。
run を起こすたびに 32 バイトの秘密を作り、`--mcp-config` のファイルにはその秘密を書く。
本体のトークンを渡すと、その `claude` は自分の `--mcp-config`（0600 だが、読めるのは他ならぬ自分である）から鍵を取り出し、共通の `/mcp` と `/api` に回れてしまう。
閉じ込めは URL ではなく鍵で行う必要がある。

秘密が開けるのは、その run のセッションの `/mcp/s/<sessionId>` だけである。
共通の `/mcp` と `/api` 配下はどちらも通らない。
本体のトークンは今までどおり両方を開けるので、`hangar mcp install` が登録する共通の URL は変わらない。
照合は長さを見てから定数時間の比較を行う。

置き場は端末ローカルの `mcp_secrets`（マイグレーション 7、`session_id` を主鍵にして `secret` と `created_at` を持つ）である。
共有テーブルの列を持たないので、`upsertShared` を通さず、同期の `changes` にも載らない。
サーバのメモリに持たないのは、tmux の上で生きている run がサーバの再起動をまたいで残るためである。
その `claude` は再起動の後も同じ秘密で繋ぎに来る。

秘密は run の終了で消す。
消し損ねたものは、次の起動と起動時の回復のときに、生きている run のもの以外をまとめて落とす。
`--mcp-config` のファイルの後始末と同じ扱いである。

### ツール

MCP は Streamable HTTP で提供する。
共通の `/mcp` と、セッション別の `/mcp/s/<sessionId>` がある。
セッション別 URL では、`session_id` を省いたツール呼び出しがそのセッションを指す。
さらにこの URL は、そのセッションとそのプロジェクトに閉じる。
ほかの `session_id` や `project_id` を渡されたら、黙って読み替えず、断りの文を返す。
`list_projects` と `list_sessions` も枠の外を返さない。
セッションがプロジェクトに属していないときは、プロジェクトを必要とするツールを断る。
共通の `/mcp` には枠が無く、今までどおりすべてを指せる。

- `list_projects()`：プロジェクトの一覧。ステータス、パス、未完 TODO 数、最終活動。
- `get_project(project_id)`：詳細。TODO、メモ、直近のセッション、アーティファクト。
- `update_project(project_id, { status?, add_todos?, toggle_todos?, propose_done?, append_memo? })`。
- `list_sessions({ project_id?, running?, limit? })`。
- `search_sessions({ query, project_id?, since?, until?, provider?, file? })`：FTS と絞り込み。結果は題名、要約の 1 文、一致箇所の抜粋、再開コマンド。
- `get_transcript(session_id, { from_seq?, limit?, include_tools? })`：正規化イベントを返す。
- `create_session({ project_id, name?, prompt?, model?, effort?, permission_mode?, scratch? })`：tmux で起動して run を返す。
- `set_session_summary({ session_id?, title, one_liner, body, state, next_steps })`。
- `set_turn_intent({ session_id?, text })`：このターンで何のために何をするかを 1〜2 文（200 字まで）で書く。端末ローカルの `turn_intents` に積み、同期しない。右ペインの意図の段に出す。
- `set_session_memo({ session_id?, text })`：人間向けの 1 行メモ。モデルには指示しない。
- `get_usage()`：5 時間と 7 日の使用率、最終更新時刻。
- `open_in_hangar({ session_id | project_id })`：UI とディープリンクの URL を返す。

`update_project` は TODO の追加と完了の候補の提出、メモの追記を行い、TODO の書き込みは全部成功か全部失敗のどちらかにする（途中で失敗したものが残らない）。
MCP からは TODO を完了にできない。`propose_done` と未完への `toggle_todos` は完了の候補を出し、結果を `todo_results`（`[{ todo_id, outcome }]`）で返す。
`propose_done` は `[{ todo_id, note }]` で、`note` は根拠の一文（空白を除いて 1 字以上 200 字以下）である。
`toggle_todos` は、未完で候補でない TODO を根拠なしの候補にし、完了の TODO は未完に開き直し、候補の TODO には何もしない。
`outcome` は次の 5 つである。
`proposed` は候補にしたこと、`already_candidate` はすでに候補なので何もせず根拠も上書きしなかったこと、`already_done` はすでに完了なので何もしなかったこと（`propose_done` のみ）を指す。
`rejected_before` はこのセッションの候補は却下済みなので受け付けなかったこと、`reopened` は完了を未完に開き直したこと（`toggle_todos` のみ）を指す。
`note` が空か 201 字以上、または見つからない ID が 1 つでも混ざれば、呼び出し全体を断り、どの TODO も書かない。
`get_project` の TODO には `candidate: { session_id, note } | null` が付き、セッションは自分の候補が残っているかを確かめられる。
`get_usage` は 5 時間と 7 日の使用率と最終更新時刻を返し、statusline が一度も届いていなければ値は null になる。

`hangar mcp install` は、Claude Code の user スコープに `hangar` サーバを登録する。
登録は利用者が明示的に実行し、`~/.claude.json` の `mcpServers.hangar` だけを hangar が書き換える。
`claude mcp add` を呼ばないのは、`--header` の値が argv に載り、トークンが `ps` から読めるためである。
`claude mcp add` にはヘッダの値をファイルや標準入力から受ける口が無く、`${HANGAR_TOKEN}` と書いても展開されずにそのまま保存されることを実物で確かめた。
書き換えは同じディレクトリに書いてから `rename` する形で、他の項目と他の MCP サーバには触れない。
ファイルが JSON として壊れているときは、上書きせずに失敗として返す。

ここは hangar が利用者の設定を書き換える数少ない場所なので、次の 4 つを守る。

- **ロックを取ってから書く。** 実体の隣に `<実体>.hangar-lock` を `O_EXCL` で作り、取れるまで 2 秒だけ待つ。取れなければ何も書かずに「Claude Code が設定を書いている最中のようです」と返す。落ちたプロセスが残したロックで永久に失敗しないよう、更新から 10 秒より古いものだけは残骸とみなして消し、取り直す。ロックを取った後も、読んでから書くまでの間に Claude Code が書いたかもしれないので、書く直前にもう一度読んでから併合する。
- **シンボリックリンクはリンクのまま残す。** 途中のディレクトリも含めてリンクを解き、実体の隣に一時ファイルを書いて `rename` する。dotfiles のリポジトリへ `~/.claude.json` をリンクしている人の設定を、実ファイルで置き換えないためである。リンク先がまだ無いときは、その場所に作る。
- **権限は新規 0600、既存は保つ。** 既にあるファイルは利用者が決めた権限をそのまま使う。ただしここにはトークンを書くので、group や other に 1 つでも立っていれば 0600 へ狭め、狭めたことを端末に知らせる。
- **書く前に控えを取る。** もとのファイルを `~/.agent-hangar/backups/claude.json-<yyyymmddHHMMSS>`（権限 0600）へ写してから書く。同じ秒に 2 度来たら連番を足し、既にある控えは上書きしない。控えが取れなければ書かない。控えの置き場を `~/.agent-hangar` の下にするのは、`~/.claude` の中に hangar のファイルを増やさないためである。

`claude` が PATH に無いときは登録もしない。
書いた後は、書いたトークンそのもので `GET /api/usage` を 1 回叩いて確かめる。
`/health` は認証を通さないので、通っても「そのポートで何かが応答する」ことしか分からず、`HANGAR_HOME` がサーバとずれていれば別のトークンを書いたまま成功と言ってしまう。
認証が通らなかったときは失敗として返し、書いたトークンの置き場と `HANGAR_HOME` の食い違いを印字する（トークンそのものは印字しない）。
そのポートで誰も応答しないときだけは、起動前の登録を塞がないために成功のまま起動を促す。
削除は `claude mcp remove` に任せる。こちらはトークンを渡さないので、argv の問題が無い。
Claude Code は MCP のツール定義を遅延して読むため、ツールの説明文に「agent-hangar」を含めて検索で当たるようにする。

### ディープリンク

Tauri のシェルは `hangar://` スキームを登録する。
`hangar://session/<id>`、`hangar://project/<id>`、`hangar://search?q=<text>` を受け、対応する画面を開く。
ブラウザで使うときは同じ経路を `http://127.0.0.1:4177/#/session/<id>` で表す。

## アーティファクト

**アーティファクト** は、セッションが claude.ai に公開した Artifact の URL である。
トランスクリプトの Artifact ツール呼び出しと結果から自動で抽出する。
呼び出しには元ファイルのパス、説明文、favicon の絵文字が、結果には `Published <path> at https://claude.ai/code/artifact/<uuid>` が残る。
旧形式の `https://claude.ai/artifact/<id>` も同じ扱いにする。

同じ URL への再公開は 1 件のアーティファクトにまとめ、`artifact_versions` に「いつ、どのセッションが更新したか」を積む。
題名は元ファイルが残っていれば HTML の `<title>` から、無ければ説明文の先頭から取る。
プロジェクト画面には全セッション分を集約し、セッション画面にはそのセッション分を出す。
カードには favicon、題名、説明、最終公開時刻、更新回数を出し、クリックで既定のブラウザに開く。
元ファイルが残っていれば「VS Code で開く」も付ける。
利用者は URL を手で追加できる。

呼び出しと結果は別の記録にあり、追記の境目で分かれることがあるので、端末ローカルの `artifact_calls` に呼び出しを控えて結果と突き合わせる。
題名は表示のたびに計算せず、公開を記録するときに決めて `artifacts.title` に書く。
カードのクリックは `POST /api/artifacts/:id/open` でサーバが `open` を実行する（ブラウザの `window.open` は使わない）。

## 使用量

5 時間と 7 日のレート制限の使用率は、ディスクには保存されていない。
唯一の供給源は、Claude Code が statusLine コマンドに標準入力で渡す JSON である。
`hangar setup` は、利用者の既存の statusline スクリプトの先頭に次の数行を追記する。

```sh
# agent-hangar: 使用量をローカルサーバへ渡す。失敗は無視する。
__hangar_input=$(cat)
__hangar_home="${HANGAR_HOME:-$HOME/.agent-hangar}"
__hangar_header="$__hangar_home/statusline-header"
if [ -r "$__hangar_header" ]; then
  printf '%s' "$__hangar_input" | curl -s -m 0.3 -X POST \
    -H 'Content-Type: application/json' \
    -H @"$__hangar_header" \
    --data-binary @- http://127.0.0.1:4177/api/ingest/statusline >/dev/null 2>&1 &
fi
exec <<<"$__hangar_input"
```

トークンはファイルから curl に渡す。
`-H "Authorization: Bearer $(cat ...)"` と書くとシェルが先に展開するので、64 桁が curl の argv に載り、statusline が走るたびに `ps` から読める。
`-H @<ファイル>` はファイルの中身をヘッダの行として読むので、argv にはファイルの名前しか出ない。
この書き方は curl 7.55 以降にある（手元の 8.7.1 で実測した）。
`--variable` と `--expand-header` でも隠せるが、そちらは curl 8.3 以降にしか無く、古い curl では要求を出す前に終わる。
しかもその失敗は `>/dev/null 2>&1` に消えるので、利用者には何も見えないまま使用量だけが止まる。

読ませるファイルは `~/.agent-hangar/statusline-header`（権限 0600）で、中身は `Authorization: Bearer <トークン>` の 1 行である。
64 桁だけが入った `token` は、そのままではヘッダの行にならないので、token を唯一の出どころにしてここへ書き写す。
このファイルはサーバの起動のたびに用意する。
`hangar statusline install` のときにしか置かないと、`~/.agent-hangar` を消した利用者はこのファイルを持たないまま statusline だけが残る。
スニペットは読めなければ何も送らずに素通しするので、使用量が何も言わずに止まってしまう。
中身と権限がトークンと揃っているときは触らず、トークンが作り直されていれば書き直す。

`settings.json` は書き換えない。
payload には `rate_limits` のほかに `session_id`、`session_name`、`cwd`、`transcript_path`、`model`、`effort`、`cost`、`context_window` が入る。
セッションごとのモデルと effort は、この payload を第一の供給源にし、無ければトランスクリプトの解析から得た値を使う。
コンテキスト使用率と推定コストは、この payload だけが供給源である。
窓の大きさ（`context_window_size`）は payload にしか無く、推定コストは価格表を持たない方針なので、どちらも jsonl からは導けないためである。
したがって statusline の追記を入れていない間は、この 2 つはどのセッションでも出ない。
出ないときは棒を描かず、ヘッダーの使用率のゲージと同じ言葉で「未取得」と書く。
0% の棒は「まだ使っていない」と読めてしまうためである。
両方とも未取得のときは「コンテキスト、コスト 未取得」の 1 つにまとめ、押すと Settings へ行く（理由は title に持つ）。
終わったセッションは、この先も値が届かないので何も出さない。
Home の実行中の札は、使用率が届いていない間はゲージの行ごと出さない。
更新は定期ではなく、起動直後と応答完了のたびに 1 回である。起動直後の 1 回目は `rate_limits` が無いので、欠けた項目は直前の値を保つ。
使用率は Claude のセッションが動いている間だけ更新されるので、ヘッダーのゲージには「最終更新 N 分前」を添える。
追記は目印のコメント行で二重追記を避け、追記前にバックアップを取る。
既に入っているスニペットが今の形と違うときは、目印の行から `exec <<<` の行までを差し替える。
目印だけを見て何もしないと、トークンを argv に載せる古い形が入ったまま残るためである。
追記を行うのは `hangar setup` の手順 4 と `hangar statusline install` の 2 つだけで、どちらも利用者の承諾を求める。
UI とサーバは追記の有無を `GET /api/statusline` で読むだけで、書き込む経路もボタンも持たない。

準備の確かめは `GET /api/readiness` の 1 つにまとめてある（`packages/server/src/config/readiness.ts`）。
tmux、claude、code、Node のパスの有無と実行権と版、ワークスペースの有無と、そこから登録したプロジェクトの数、MCP の登録の有無、statusline の追記の有無、画面に出すコマンドを返す。
版は `tmux -V` と `--version` を 3 秒の時間切れ付きで起こして読み、同じファイル（パス、更新時刻、大きさ）なら覚えた版を返して起こし直さない。
設定画面の欄の下の検証と、空のホームの確認リストが、どちらもこれを読む。
UI は設定画面に入ったとき、設定を保存した後、セッションが 1 つも無い起動のとき、「もう一度確かめる」を押したときに取りに行く。
副情報として、jsonl の `usage` からトークン数を日別とプロジェクト別に集計する。
日別とプロジェクト別は同じ窓（直近 30 日）と同じ供給源（`usage_daily`）で束ねるので、2 つの表のトークン数の合計は一致する。
ただし推定コストだけは、そのセッションの走り全体の累計である。
唯一の供給源が statusline の渡してくる `cost` で、日ごとの内訳を持たないためである。
プロジェクト別の推定コストは、窓に入ったセッションについて 1 件につき一度だけ足す。

## 検索

Sessions 画面は検索画面を兼ねる。
キーワードが空なら全件を新しい順に出す。
検索対象は利用者の発言、アシスタントの本文、ツール呼び出しのファイルパスとコマンドである。
絞り込みはプロジェクト、期間、Provider、状態（入力待ち、実行中、終了）、触ったファイルである。
キーワードが空でも、触ったファイルで絞るときはサーバの検索を使い、そのファイルを触ったセッションを新しい順に出す。
触ったファイルは手元のセッションの情報に無いからである。
プロジェクトは検索欄つきの一覧で、先頭に「すべてのプロジェクト」を置く。
期間（全期間、今日、7 日、30 日）と状態（すべて、入力待ち、実行中、終了）は切り替えの帯で選ぶ。
状態の数え方は「画面の用語」の節の定義に従い、手元の一覧と `/api/search` の `live`（`running`、`waiting`、`ended`）で同じ関数（shared の `liveFilterOf`）を使う。
期間は相対の日数で持ち、問い合わせるときに時刻へ直す。
「今日」は暦の今日の 0 時から、「7 日」と「30 日」は今日を含めたその日数分の最初の日の 0 時からである。
結果には題名、要約の 1 文、一致箇所の抜粋、日時、プロジェクトを出す。
全文検索の欄は Sessions 画面の上の 1 本だけで、これが全文検索の本体である（設計は `docs/superpowers/specs/2026-10-01-ux-refresh-2-design.md` の 4、案 D1）。
欄には本文を探す絵と「本文」の札を添え、打った語は × で消せる。
ヘッダーには打つ欄を置かず、パレットの「全文検索」の行がこの画面へ来る（同じ `search.query` の経路）。
見出しの横の件数は条件に関わらずセッションの全件である。
条件（語、プロジェクト、期間、状態、触ったファイル）が 1 つでも効いていれば、絞り込みの段の下に条件の行を出し、効いている条件を並べ、「条件をクリア」と件数を置く。
ただし状態のタブだけで絞っているときは、条件の行を出さない。選んだタブと欄の札が、同じ条件と件数を既に言っているからである。
0 件のタブは淡くする。
ページ送りの帯は、番号の列と跳び先の欄を中ほどに並べ、いまのページは塗りつぶさず淡い地と色の文字で示す（塗りつぶすとヘッダーの主ボタンと競る）。
件数はサーバが上位の一部だけを返したときに「上位 50 / 132 件」と書き、並ぶ行の数と食い違わないようにする。
「条件をクリア」は `search.clear` で、語と絞り込みをまとめて外し、語の無い一覧の URL へ移る。
続きは一覧の末尾の「さらに 50 件を読み込む」で読み足し、残りの件数を添える（`search.more`、残りが 50 件に満たなければその数を言う）。
同じ検索を MCP の `search_sessions` で外部の AI にも提供する。
FTS5 に渡す検索語はトークンごとに二重引用符で包む。ハイフンを含む語を素のまま渡すと列指定と解釈されてエラーになる。
trigram は 3 文字未満の語に一致できないので、3 文字未満の語は部分一致で補う。
意味検索は初版では持たない。

## プロジェクトの同定

プロジェクトは安定した ID と、端末ごとのパスを持つ。
パスが見つからないとき（ディレクトリの改名、移動、削除、別 PC での不在）は、`project_roots.resolved = 0` にして警告ダイアログを出す。
ダイアログは「ディレクトリを再指定」「アーカイブにする」「一覧から削除」を選ばせる。
「一覧から削除」（`unlink`）は、そのプロジェクトのセッションをすべて未分類に戻し、プロジェクトを論理削除する。
同期で他の PC からも消えるので、ボタンを危険色にし、押したら確認を挟む。
確認には「プロジェクト <名前> を一覧から削除し、N 件のセッションを未分類に戻します。同期している他の PC からも消えます。」と書く。
N は UI の store に届いているセッションで数える。
確認は取り消せない操作の形（見出しの前の赤い丸のアイコンと、赤く塗った押し切るボタン）にし、既定のフォーカスは「やめる」に置く。
やめたら未解決のダイアログへ戻る。
未解決のダイアログは決めてもらうまで閉じないので、Esc でも背景でも閉じず、見出しの × も置かない。閉じるのは「あとで」だけである。
開いたら新しいパスの欄にフォーカスを入れる。
自動推定やマーカーファイルは持たない。
再指定のダイアログには、ワークスペースルート直下で名前が近いディレクトリを候補として並べる。

初回起動時は、ワークスペースルート（既定は `~/workspace`）直下で、cwd がそのディレクトリ以下の Claude セッションが 1 つ以上あるものを自動でプロジェクトにする。
セッションのない直下ディレクトリは「新規プロジェクト」で既存ディレクトリを選ぶときの候補にだけ出す。
ルート外の cwd のセッションは「未分類」に入れ、後から手で紐づけられる。
起動した後に未分類のセッションが現れたときは、黙って置かずに 1 度だけトーストで知らせる。
起動時の初回の全走査では知らせない。
ディレクトリが戻ってルートが解決に戻ったら、その間に溜まった未分類のセッションを紐づけ直し、変わったセッションとプロジェクトを配る。

## 画面

### 画面の用語

画面の言い方は `docs/superpowers/specs/2026-10-01-ux-refresh/terminology.md` の表と、その末尾の利用者の決定（2026-10-01）に従う。
1 つの概念には 1 つの語を当て、英語の内部値（`active`、`idle`、`scanning`、`tmuxPath` など）を画面に出さない。
ただし Claude Code の固有の名前（statusline、MCP、model、effort、permission mode、worktree）はそのまま使う。
aria-label は見えている文字をそのまま含め、見える文と読み上げの名前を別の言い方にしない。

- セッションの状態は、作業中（`busy`）、入力待ち（`waiting`）、休み（`idle`）、起動中（hangar の run は生きているが Claude の一覧にまだ載っていない）、終了である。
- 実行中は作業中と休みと起動中を指し、入力待ちは含めない。
  入力待ちはどの画面でも別に数え、プロジェクトの数では「要対応 N」と書く。
  数え方は shared の `liveFilterOf` 1 つにまとめ、Home、プロジェクトのカード、セッションの絞り込み、`/api/search` が同じ関数を使う。
- 要約の見立ては、やりかけ、済んだ、詰まっている、やめたである。
- プロジェクトの状態は、英語のまま頭を大文字にして Active、Paused、Done、Archived と書き、欄の名前は「状態」にする。
- hangar が動く計算機は PC（この PC、他の PC）と呼び、文字を打つ窓はターミナルと呼ぶ。
  「端末」は画面では使わない。
- サーバのエラー文が設定の項目を指すときは、画面名を「設定」とし、項目は画面の欄の見出しをかぎ括弧で書く（例：設定の「tmux のパス」）。

### 骨格

左にナビだけのサイドバー、上にヘッダー、残りがメインである。
ヘッダーは、中身の上に浮くガラスである（「見た目と動き」）。
サイドバーはガラスの板を持たず、項目だけを背景の上に並べる。裏に透かす中身が無い場所では、ガラスは白い板と同じになるからである。
4 つの項目の下に「動いている」の節を置き、動いているセッション（入力待ち、作業中、休み、起動中）を 1 行ずつ並べる（`views/Sidebar.tsx` の `LiveSection`、並びは `presenters/shell.ts` の `sideLive` と `mediator/sidebar.ts`）。
セッション画面にいる間、ほかのセッションのどれが待っているかを横目で見て、1 押しで移るための場所である。入力待ちの札を当のセッション画面では出さないと決めたので、その置き場所でもある。
行は状態の点、名前、入力待ちなら待った時間（「待ち 4 分」）で、いま見ているセッションは白い行にする。並べるのは 8 件までで、超えたら「ほか N 件」を出し、押すと Home へ行く。動いているものが無ければ節ごと出さない。
行は掴んで上下に動かせ、入る場所に線を出す。キーボードでは、行に焦点があるときに ⌥↑ と ⌥↓ で 1 つずつ動かす。並びは端末ごとに localStorage（`sidebar.order`）に残す。
並びは固定で、変えるのは利用者の手だけである。入力待ちになっても、出力が進んでも、行は動かさない。更新のたびに行が入れ替わると、置いた場所を目で覚えていられないからで、待ちは色と太字と待った時間で知らせる。動いているセッションが初めて現れたとき、ランタイムが顔ぶれの変化を届け（`live.changed`）、Mediator がその id を並びの末尾に書き足す。同時に現れたものは始めた時刻の古い順にする。Claude を抜けて行が消えても席は覚えておき、resume したら前後の行の間へ戻す。並べ替えは動いている行の席だけを入れ替え、抜けているセッションの席は動かさない。覚える id は 200 件までで、超えたら動いていないものを先頭の側から落とす。新しい行は末尾に入るので、9 本以上動いているときは「ほか N 件」に数えられる。
Home では、本文の「要対応」「実行中」と同じ件を出すだけになるので、見出しと件数だけにする。畳んだ帯では点だけを縦に並べ、名前は title に持つ。
「今日戻る」とプロジェクトの節は置かない。Paused の戻りは Home の札と通知で、プロジェクトは Home の欄と ⌘K と ⌘N で足りる（2026-10-05 の検討）。
メインはヘッダーの下をくぐって流れ、ヘッダーの高さと隙間の分だけ上に余白を取ってから始まる。
`.app` では標準のタイトルバーを消し、信号の 3 点をヘッダーの左端に乗せ、ヘッダーの空いた所を掴んで窓を動かし、そこをダブルクリックすると窓が拡大する。
そのために、UI の出どころ（`http://127.0.0.1:4177`）に窓を動かす権限（`core:window:allow-start-dragging`）とダブルクリックで拡大する権限（`core:window:allow-internal-toggle-maximize`）の 2 つだけ与え（`capabilities/remote-drag.json`）、殻は頁に `data-shell="desktop"` の印を付けて、ヘッダーのロゴはその印があるときだけ信号の 3 点の右から始まる。
入力待ちを窓の外へ知らせるために、同じ出どころには通知を出す権限（`allow-notify-waiting`）、通知の許可を求める権限（`allow-notify-request`）、通知の許可の状態を読む権限（`allow-notify-status`）、Dock のバッジに数を出す権限（`core:window:allow-set-badge-count`）の 4 つだけを別に与える（`capabilities/remote-notify.json`）。
前の 3 つは殻が自分で持つコマンドで、`build.rs` の AppManifest に並べたものだけが権限になる。
殻の命令は 6 つだけ持つ（`src-tauri/build.rs` の一覧と `lib.rs` の `#[tauri::command]`）。
入力待ちの知らせの 3 つ（`notify_waiting`、`notify_request`、`notify_status`）は上に書いたとおりで、残りの 3 つは障害のときの操作である。
殻は命令を `invoke_handler` の 1 か所でまとめて登録する。
2 度呼ぶと後のものだけが残り、先に並べた命令が呼べなくなるからである。
UI の出どころには、ログを開く `open_log` とアプリを再起動する `restart_app` だけを与え（`capabilities/remote-shell.json`）、起動画面（殻の中の頁）には、起動をやり直す `retry_boot` と `open_log` だけを与える（`capabilities/boot-screen.json`）。
`open_log` は決まったファイル `~/.agent-hangar/desktop.log`（無ければ空で作る）を `open` に渡すだけで、呼び手からパスは受け取らない。
UI は殻が差し込む `__TAURI_INTERNALS__` の有無で殻の中かを決め（`runtime/desktop.ts`）、殻の外（ブラウザ）ではこれらのボタンを出さない。
接続が切れると、ヘッダーの下に切断の帯を出し、止まった時刻と次に再接続する秒数を言う。
再接続が 3 回続けて失敗したら、同じ帯のまま濃い赤にして「サーバに戻れません」「アプリを再起動してください」と言い、殻の中では「ログを開く」「再起動」を、ブラウザではログの場所（`~/.agent-hangar/desktop.log`）の文とコピーのボタンを置く。
サイドバーの項目は Home、Projects、Sessions、Settings の 4 つで、プロジェクトの一覧は置かない。
Home の項目には、入力待ちがあるあいだその数を添える（開いた帯では項目の右端の赤い錠剤、畳んだ帯ではアイコンの右上の小さな丸）。
数え方は shared の `liveFilterOf` に従い、読み上げでは「ホーム、入力待ち 2」と何の数かを言う。
開閉のボタンは、開いた帯では Home の行の右端に、畳んだ帯では帯の一番上に置く。
ヘッダーは殻の 2 列（サイドバーの列と本文の列）をそのまま使う（subgrid）。
左の列にロゴ（図と Hangar_）を置き、サイドバーを開いても畳んでも同じ形、同じ場所に置く。開閉のたびに図のハンガーが振り子で揺れる。
右の列には、「探す・移動」の錠剤、同期状態、Claude の利用上限の 2 つの枠の使用率のゲージ、新しいセッションのボタンを置く。
ゲージは棒の前に見出し「5 時間」「週」を常に出し、読み上げの名前は「5 時間枠の使用率」「週の枠の使用率」にする。
ホバーの title には、statusline の `resets_at` から枠が戻る時刻を「5 時間枠の使用率 28%、18:00 に戻ります」の形で添える（今日でなければ月と日も添える）。
最終更新があれば、それも title に添える。
2 つの枠のどちらも一度も届いていない間は、空の棒を並べず「使用率 未取得」の 1 語にまとめ、押すと Settings へ行く。
窓が狭いときは、右の列の部品を優先度の低いものから順に畳む。
決め打ちの幅では畳まない。
同期の文と件数は長さが変わるので、決め打ちの幅ではそれに追いつかず、同期の一行がゲージに重なって描かれたからである。
代わりに、段ごとに右の列で要る幅を描画の直後（塗る前）に測り、収まる最初の段を選ぶ（`views/headerFold.ts` の純関数と `views/useHeaderFold.ts`）。
測り直すのは、行の幅が変わったとき（窓とサイドバーの開閉）、描き直したとき、字形を読み込んだときである。
戻すのは、戻した段が 24px のゆとりを持って収まるときだけにし、ちょうどの幅で段が行き来してぴくぴくするのを防ぐ。
畳む順は、最終更新、索引の進み、同期の操作（今すぐ同期、一時停止）、同期の件数（未送信、未送信の本文）、ゲージの棒、錠剤の文字とキー帽、同期の状態の文、新しいセッションの文字、ゲージ（見出しと数字ごと）である。
同期の操作は、同期の文のリンクから設定へ行けば押せる。
状態の点はリンクの中にあるので、文を畳んでも点を押せば設定へ行ける。
送れなかった本文の件数は誤りなので畳まない。
ゲージの見出しは、ゲージを出している間は隠さない。見出しの無い数字は何の割合か読めないので、畳むときはゲージの組ごと畳む。
畳んだ部品は見えなくするが読み上げには残し（同期の操作だけはフォーカスが止まらないよう外す）、件数と最終更新はリンクとゲージの title からも読める。
測る仕組みが追いつかない一瞬や、測れない環境でも重ならないよう、右の列の部品はどれも 0 まで縮み、はみ出しは省略記号か切り詰めにする。
錠剤の左端は本文（各画面の見出し）の左端にそろえ、どの画面へ移っても動かない。
ただしセッション画面だけは本文の幅の上限（`--main-w` の 1200px）を外すので、窓が広いと本文と錠剤がほかの画面より左へ寄る（UX 刷新 2 の案 b、利用者が受け入れた）。
錠剤の位置の式は変えず、殻の `data-wide` の印でその画面の `--main-w` だけを外す。
畳んだ帯ではロゴが列の外まで伸びるので、窓が狭い間は本文と錠剤がロゴの右から始まる。
今いる場所はヘッダーでは示さず、各画面の一番上の見出しで示す（設計は `docs/superpowers/specs/2026-10-01-page-heading-design.md`）。
見出しは 18px の太字で、下に 1px の線を引いて本文と分け、上に親へのリンクの行（セッションなら属するプロジェクト、プロジェクト詳細なら一覧）を置く。
親の行は親の無い画面でも同じ高さを取り、どの画面でも見出しと線の高さがそろう。
窓の大きさは、最小の 900×600 から広い画面まで崩さない。
高さの決まったボタンの文字は折り返さず、長い名前（サブエージェントの ID など）は省略記号で切る。
見出しの行に操作のボタンが入り切らないときは、ボタンの名前を隠して印だけの丸いボタンにし、名前は title と読み上げに残す（`PageHeading` の `fitRow` が行の幅を測って `data-compact` を付ける）。
ボタンが自分の title（セッション画面の主の操作の押せない理由など）を持つときは、縮めても消さず、名前の後ろに添える（「再開（本文がありません）」）。
並ぶボタンは画面の状態で増減し、字の大きさでも幅が変わるので、決まった幅で切り替えず、実際にはみ出すかで決める。
セッション一覧とプロジェクト詳細では、一覧が窓の下端までの残りの高さを受け取る（`.screen-fill`）。
セッション画面でも本体（ターミナルと右の欄、本文と右欄）が残りの高さを受け取るが、組み方はセッション詳細の節に書く（`.session-screen`）。
上の帯の高さは折り返しで変わるので、`100vh` から決め打ちで引かない。
板には下限を持たせ、それより低い窓では本文の列がスクロールする。
プロジェクトのカードは幅に合わせて列の数を変え、セッション一覧の絞り込みは入り切らなければ次の行へ送る。
右の欄の「いま」の上段は、境目の比率を高さの上限にして中でスクロールし、下の目次を押し出さない。
崩れは WebKit で窓の大きさを変えながら機械的に拾って確かめる（折り返したボタン、箱からのはみ出し、途中で切れた文字、窓の外の要素）。

「探す・移動」の錠剤は打つ欄ではなく押すボタンで、虫眼鏡、「探す・移動」の文字、⌘K のキー帽を並べ、幅は中身の分だけにする（案 A1）。
押すか、/ か ⌘K でコマンドパレットを開く。
狭い幅では文字とキー帽を畳み、虫眼鏡だけの丸いボタンにする（上の畳む順の 6 段目）。
パレットはセッションとプロジェクトへのジャンプ、画面の移動、主要な操作、全文検索への入口を 1 つにまとめる。

パレットは、何も打っていないときは群の見出しを付けた 1 列に並べる（案 B1）。
群は上から入力待ち、実行中、最近（それ以外のセッションの新しい順、上位 5）、プロジェクト（最後の活動の新しい順、上位 4）、移動、コマンドで、空の群は出さない。
見出しには群の全件の数を添え、上限で切ったときだけ「上位 N」と書く。
動いていないセッションの点は描かず、場所だけを残す（一覧の行も同じ）。終わった行がどれも同じ灰色の点になると、作業中と入力待ちの色を拾いにくくなるからである。
セッションの行は状態の点、名前、プロジェクト名を並べ、右端に待った長さ（「4 分待っている」）、動き始めてからの長さ（「作業中 7 分」）、休んでからの長さ（「休み 12 分」）、終わったものは最後の活動の時期を添える。
プロジェクトの行は状態の色の点とパスを添える。
移動はホームへ、プロジェクトへ、セッション一覧へ、設定、次の入力待ちへ（移る先の名前を添える）、サイドバーの開閉、キーの一覧で、打鍵のあるものはキー帽を添える。
コマンドは新しいセッション、スクラッチで始める、索引を作り直すで、新しいセッションは ⌘N と同じく、いまの画面のプロジェクトを最初から選ぶ。
打ち始めたら名前（セッションは名前と要約の 1 文）で絞り、群は分けたまま、群ごとに 8 件で切る（案 C1）。
群の並びは、いちばんよく当たった行の点の高い順にし、同点なら何も打っていないときの順にする。
決まった順のままだと、要約の中で散らばって当たったセッションが、名前の頭から当たったコマンドより上に来るからである。
最後の行はいつも「『語』を全文検索」で、選ぶか ⌘↵ で Sessions 画面へ移って本文を探す。
名前に 1 つも当たらなければ「名前には一致しません。」と言い、全文検索の行だけを出す。
下の縁には打鍵の案内（↑↓ 選ぶ、↵ 開く、⌘↵ 全文検索、esc 閉じる）を置く。

### Home

上から順に、要対応、実行中の札、確かめる、最近とプロジェクトを置く（管制盤）。
セッションもプロジェクト（スクラッチを除く）も 1 つも無いあいだは、区画の代わりに真ん中に 1 枚の札を置く（初回の確認リスト）。
札は「始める前の確認」で、tmux、claude、ワークスペース、MCP、statusline の 5 つに ✓ か ✗ と直し方（設定へ、またはターミナルで打つコマンドとコピー）を並べ、揃った数を「5 つ中 N つ」と出す。
MCP と statusline は無くても始められるので弱い印にし、下に「tmux と claude があれば、残りが ✗ でも始められます」と「もう一度確かめる」を置く。
札の下に「スクラッチで始める」「新しいセッション」「設定を開く」の 3 つのボタンを置く。
判定は設定画面の欄の下の検証と同じもの（`GET /api/readiness` と `presenters/readiness.ts`）を使う。
Claude Code の保持期間がユーザー設定に無い（既定の 30 日）あいだは、切断の帯と同じ場所に保持期間の帯を出す（「会話の保持期間」の節）。
要対応は入力待ち（`waiting`）のセッションを、長く待っている順に 1 件 1 枚の横長の札で出す。
札には名前、プロジェクト、待っている時間、待っている問いの文（取れなければ「入力を待っています」）、「ターミナルで答える」を置く。
「ターミナルで答える」はそのセッションの画面を開いてターミナルにフォーカスするだけで、その場では答えさせない（端末の TUI を外から操ることになって壊れやすいため）。
要対応の札の並びには、入力待ちの札の後ろに「今日戻る」の黄土の札を置く。
戻る日が今日か過ぎた Paused 1 件につき 1 枚で、戻る日の古い順に並べ、札から開く・戻る日を変える・Done にできる（札に出したものは最近に重ねない）。
実行中は、作業中と休みのセッションと、Claude のレジストリに載る前の run を 3 列の札で出す。
札には名前、経過時間、プロジェクトとモデルと effort、いま何をしているか（最後のツール呼び出しの 1 行を墨の地に）、コンテキストの使用率のゲージを置き、押すとセッション画面へ移る。
墨の 1 行の中の長い絶対パスは、末尾の 2 階層だけにする（`presenters/format.ts` の `shortenPaths`）。頭から出すと、どの札も同じ頭で始まり、違いのある末尾が省略で消えるからである。
呼び出しがまだ無いときは「作業中」、休みは「休み。最後の返答から N 分」、レジストリに載る前は「起動しています」と出す。
作業中の札は、縁に 1px の杏の輪を灯し（入力待ちなら赤茶）、Claude がこのターンに書いた意図を白地の 1 行で、その下にいまの手を墨の帯の 1 行で出す。輪はセッション画面の端末の縁の灯と同じ言葉で、ここでは呼吸させない。
意図は右の欄の「いま」と同じもので、Home を見ている間は動いているセッションの分を取りに行く（1 秒に 1 回まで）。書かれていなければ意図の行は出さない。
休みと起動中は端末が何も出していないので、墨の帯を使わず白地の文で言い、輪も灯さない。墨の帯は端末の出力だけに使う。
確かめるは、セッションが出した TODO の完了の候補を、全プロジェクトぶん、候補になった時刻の古い順に 1 件 1 行で出す。
確かめるには、TODO の完了の候補とセッションの状態の提案（「Done にする？」「Paused · 10/3（土）？」の枠だけの札）を、候補になった時刻の古い順に混ぜて並べる。
行には半分塗りの印、TODO の本文、プロジェクト名、出したセッションの名前（見つからなければ「不明なセッション」）、経過時間、根拠の一文（無ければ「根拠は書かれていません」）、「確定」「却下」を置き、本文を押すとそのプロジェクトの画面へ移る。
見出しの件数は全件の数で、行は最初の 3 件だけを出す。
4 件目からは「ほか N 件を表示」の 1 行にまとめ、押すとその場で全件を開く（もう一度押すと「ほか N 件を隠す」で 3 件に戻る）。
開いているかどうかは画面の中だけの見え方なので、Mediator には置かない。
要対応、確かめる、実行中は、該当が無ければ区画ごと省く。
実行中の札も要対応の札も無いとき（何も動いていないとき）は、実行中の札の場所に高さ 44px の 1 行を置き、「いま動いているセッションはありません」と「新しいセッション」「スクラッチで始める」を出す。
入力待ちも生きたセッションなので、入力待ちがあるときはこの 1 行を出さない。
その下に、最近（幅 1.6）とプロジェクト（幅 1）を横に並べる。
2 つの見出しの行の右端には「すべて見る →」を置き、Sessions と Projects の画面へ移る。
リンクは見出しの外に置き、読み上げの名前は「すべてのセッションを見る」「すべてのプロジェクトを見る」とする。
最近は札に出したものを除いた 2 段の行で、1 段目の名前の右にプロジェクト名（無ければ「未分類」）を小さく添え、右端は時刻だけにする。
プロジェクトは Active なプロジェクトの小さな一覧（状態の色の点、名前、実行中と TODO と要対応と確かめるの数のうち 0 でないもの）で、プロジェクトのカードは Projects 画面だけに置く。

札の「いま何をしているか」と「待っている問い」は、サーバが索引の追記を読む経路（`indexFile`）で主線の出来事を畳んで取り出す。
最後の `tool_call` の名前と要約を残し、それが AskUserQuestion なら入力の最初の問いの文も残す。
その呼び出しへの `tool_result` が来たら、答えが済んだとして問いを消す。
値は端末ローカルの表 `session_activity`（マイグレーション version 9）に置き、共有テーブルにも同期の changes にも入れない。
`SessionDto.activity`（`{ tool, summary, question }`）は実行中のセッションにだけ載り、呼び出しがまだ無ければ `null` になる。
Home を開いたときにトランスクリプトを読み直すことはしない。
主線のトランスクリプトを忘れさせたとき（`forgetTranscriptFile`）は、そのセッションの `session_activity` の行も一緒に消す。

### Projects

active、paused、done のセクションに分けてカードを並べ、archived はトグルで出す。
セクションの見出しは Active、Paused、Done、Archived と頭を大文字にした英語で出す。
カードには名前、状態、パス、2 行の抜粋、メモの冒頭、最終活動日、実行中の数、要対応（入力待ち）の数、未完 TODO の数を出す。
状態の札は、Active のあいだはカードに乗せたときとカードの中にフォーカスがあるときだけ見せ、名前の右端に重ねる。節の見出しが Active と言っているので、全部のカードに同じ札を並べない。Paused、Done、Archived の札は常に出す。
パスは、ワークスペース直下でフォルダ名がプロジェクト名と同じなら出さない。ワークスペースの下で名前と違うときは相対で、外にあるときはそのまま出し、長ければ頭を省略して末尾を残す（`presenters/projects.ts` の `cardPathLabel`）。見つからないプロジェクトは、直す入口のために必ず出す。
最終活動と数は、語の途中で折らない。
抜粋は、プロジェクトのセッションを最後に動いた順に新しいものから見て、最初に取れたものを使う。
1 件の中では要約の 1 文を先に使い、無ければ最初の発言を使う。
土台の要約（`source` が `baseline`）の 1 文は最初の発言の写しなので、要約とはみなさない。
発言から取ったときは、抜粋の title に「最初の発言から」と持つ。ほとんどのカードが発言から取るので、行にはしない。
抜粋からは雑音を除く（`presenters/excerpt.ts`）。
除くのは、HTML の断片かコードの囲みで始まる発言、`[Pasted text #1 +5 lines]` や `[Image #1]` の置き換え表記（除いた残りがあれば残りを使う）、`/init` のようなスラッシュコマンド（引数があっても）、URL だけの発言、`exit` や `q` のような英字 1 語だけの打鍵である。
どれも取れなければ「まだ要約がありません」、セッションが 1 件も無ければ「セッションはまだありません」と書く。
「ここで始める」は最終活動と数の行の右端に置き、カードに乗せたときとカードの中にフォーカスがあるときだけ見せる。
Tab で届くよう、隠すときも透明にするだけにする。
実行中と要対応の数はサーバの `runningCount` を使わず、Home と同じく手元のセッションから数える。
パスがこの PC に無ければ「この PC にパスがありません」と書き、カードから始めるボタンは「ここで始める」とする。
並びは最終活動順で、名前の部分一致で絞れる。
カードは 1 行 4 列の高密度で置く。

### プロジェクト詳細

見出しの行に名前、状態の切り替え、操作（VS Code で開く、ターミナルで開く）を置き、線の下にパスを置く。
新しいセッションの主ボタンはヘッダーにあり、この画面ではこのプロジェクトを最初から選ぶので、見出しの行には並べない（スクラッチの「スクラッチで始める」は別の入口なので残す）。
右の欄の空のメモは「メモを書く」の 1 行に畳み、押すと欄が開く。TODO とアーティファクトが空のときは、足す欄があれば別の行では断らない（TODO は欄の薄い字が言う）。
メインはセッション一覧で、節で読む（P3）。
節は 今日戻る → いま動いている → 続き → Done の順で、中身がある節だけを出し、Archived は末尾の 1 行から開く。
Done は Done にした時刻の新しい順に 3 件を見せ、残りは「ほか N 件 ▸」で開く（広げた節はプロジェクトごとに Mediator が覚え、保存はしない）。
各行は 2 段で、1 段目に名前、2 段目に要約の見立ての札と要約の 1 文と、あれば 1 行メモ（✎）を出す。
右端にはモデルと effort、変更ファイル数、PR リンク、推定コストを小さな 1 行にまとめ、その下に日時を置く。
1 行メモは `m` か鉛筆のボタンで、その場で編集できる。
右の欄には TODO のチェックリスト、Markdown のメモ、アーティファクトのカードを置く。
TODO の完了の候補の行は、背景を淡い紫（`--cand-soft`）にしてチェック欄を半分塗りにし、行の下に根拠の一文、出したセッションの名前（押すとそのセッションを開く。見つからなければ「不明なセッション」でリンクにしない）、候補になってからの時間、「確定」「却下」を常に見せる。
候補の行のチェック欄を押したときは、反転ではなく「確定」と同じに扱う。
読み上げの名前は「<本文>（<n> 件目、完了の候補）」である。
右の欄は折りたためる（「右の欄を閉じる」「右の欄を開く」）。

### セッション詳細

組み方は UX 刷新 2 の「1 セッション画面の組み直し」で決めた（`docs/superpowers/specs/2026-10-01-ux-refresh-2-design.md`、試作は `2026-10-01-ux-refresh/session-layout-v2.html`）。
上から、見出しの段、線の下の 1 行、本体の 3 つを縦に積む。
本体（ターミナルの段か、本文と右欄の段）は窓の残りの高さを全部使う。
高さは決め打ち（`calc(100vh - …)`）にせず、本文の列から画面までを縦の flex にして残りを渡す。
切断の帯や保持期間の帯が出ると本文の列の上の余白が増え、本体はその分だけ縮むので、ターミナルの入力の行は窓の外へ落ちない。
窓がとても低いときだけ、本体の 160px を下限にして本文の列ごとスクロールする。
セッション画面だけ本文の幅の上限を外す（骨格の節）。

見出しの行には、状態の点、名前、要約の 1 文、主の操作、「…」のメニューを置く（A1）。
主の操作は状態ごとに 1 つだけ強く出す。
実行中（作業中、休み、入力待ち、hangar の外で動いているものも）は「VS Code で開く」、終わったセッションは「再開」、他の PC が握っている（ロックがある、本文が他の PC にある）ときは「この PC で再開」である。
残りは「…」のメニューに入れる。
実行中は「ターミナルで開く」「hangar でつなぐ」か「hangar で引き取る」「フォーク」「要約を作り直す」「プロジェクトに昇格」「停止」、終わったセッションは「フォーク」「VS Code で開く」「要約を作り直す」「プロジェクトに昇格」、他の PC のときは「再開」「フォーク」「VS Code で開く」「要約を作り直す」の順にする。
押せない項目は消さずに残し、下に理由を 1 行添える（「実行中は押せません。止めると押せます」「MacBook で実行中です」「本文が他の PC にあります」「本文がありません」など）。
理由は presenter（`sessionActions`）が再開とフォークを閉じている事実から言う。
押せない主の操作は `disabled` ではなく `aria-disabled` にし、理由を title と読み上げの説明に持たせる。
乗せたときの吹き出しとキーボードで、理由に届くようにするためである。
生きているロックの「この PC で再開」は、Ruling 14 のとおり閉じたままにする（試作は押せる形で描いていたが、ロックの規則を優先した）。
メニューは menu ボタンの作法に従い、↓ と Enter と Space で最初の項目、↑ で最後の項目を開き、開いている間は ↑ ↓（端で回る）、Home、End で移り、Enter と Space で選び、Esc で閉じてボタンへ戻る（`views/primitives/MenuButton.tsx`）。
名前は見出しにだけ出し、要約の題は出さない（C1）。

見出しの線の下には 24px の 1 行を置き、状態と経過、モデルと effort、コンテキストの使用率、推定コスト、変更数、ターンとトークン、開始、PR、1 行メモ、アーティファクトの数、作業ディレクトリを区切りで並べる（B1）。
折り返さず、狭いときは最後の作業ディレクトリから縮める。
状態は、実行中なら「作業中 3 分」、他の PC が握っていればロックの文と最終確認の時刻、本文だけが他の PC にあれば「本文は他の PC にあります」、終わっていれば「終了 · 12 分前」で、起こし方（起動、再開、フォーク）は title に持つ。
コンテキストとコストが届いていなければ「未取得」と書き、設定へ導く（両方とも無ければ 1 つにまとめ、終わったセッションでは出さない）。
右の欄の「変更したファイル」は、長いときはフォルダの側を省略し、ファイル名は必ず残す。
アーティファクトの数は押すと一覧のメニューが開き、選ぶとそのアーティファクトを開く。
スクラッチのセッションには「スクラッチ」を添え、title に「再開しても作業ディレクトリはスクラッチのままです」を持つ。

本文が無く、最後に動いてから 30 日を過ぎたセッションは、保持期間で本文が消えたとみなす。
会話の欄とターンの目次を出さず、理由の注記を一行置き、その下に要約と TODO を 1 列に積む。
実行中のセッションは、ターミナルを主、ライブトランスクリプトを従に置く。
上部にタブ列があり、タブ 0 が Claude、以降がシェルである。
セッション画面を離れると、そのセッションのターミナル接続は切る。
xterm のインスタンスとスクロールバッファは残すので、戻ればすぐ描かれ、`tmux attach` が現在の画面を描き直す。
接続を持ち続けると、渡り歩いたセッションの数だけ `tmux attach` のプロセスが残るためである。
2 つのタブを横に並べられる（「横に並べる」）。
右の欄は横に折りたためる（「右の欄を閉じる」「右の欄を開く」、⌘J）。
実行中の右欄は、上から状態の灯、意図、指揮役の手、サブエージェント、成果物、目次を並べる。
見出し（「いま」と右欄を畳むボタン）はいつも見えるところに置き、その下の「いま」の段と目次の間に境目を置く。
「いま」の段は右欄の高さに対する割合（はじめは半分）を上限にし、あふれた分は段の中でスクロールする。中身が短ければ、残りは目次に回る。
境目はドラッグか上下の矢印で 20〜80% の間を動かせ、ダブルクリックで半分に戻る。比率は端末ごとに localStorage に残し（`livePane.split`）、割合で持つので窓の高さが変わっても同じ配分になる。
段が上限で切れて下に続きがあるときだけ、下の端をぼかす。
成果物は、実行中はこの段に題名だけの 1 行ずつ置く（押すと開く、VS Code で開けるものは右端に印のボタン）。端末の上に並べると、その分だけ端末が縮むからである。情報の行の「アーティファクト n」のメニューは、右欄を畳んでいる間と「いま」の無いとき（終わったセッションなど）にだけ出し、二重には出さない。
目次の行の下には手の種類の色帯を出す。
意図とサブエージェントのレーンは、サーバの `GET /api/sessions/:id/live`（今のターンの頭から読んだライブの要約）で作る。
灯は、UI が読み込んだ主線のイベントも使う（手の数と未返答の手）。
窓が最新の一部だけのときは、ターンの頭を `/live` の値から、ターンの番号を統計から取る。
詳細は `docs/superpowers/specs/2026-10-01-live-explainer-design.md`。

ターミナルが出ない（終わった）セッションは、本文の面の右に 340px の右欄を置き、要約、TODO、変更したファイルを上から積む（E1）。
右欄は実行中の画面には出さない。
実行中の右は live-explainer の欄だからである。
右欄の開閉は ⌘J と、本文の面の右上のボタンで行い、閉じると本文が全幅になる。
要約の欄は、見立てと何ターン時点か、作り直すボタン、本文、次にやること、出所（出所、要約器の種類とモデル名、生成の時刻）を出す。
作成中と、作れなかったことも欄の上に一行で言う。
TODO の欄は、そのセッションのプロジェクトの TODO をプロジェクト画面と同じ並びで出し、完了の候補は確定と却下を添える。
足す欄はプロジェクト画面に任せる。
変更したファイルの欄は、読み込んだ主線の本文の編集系のツール（Edit、Write、MultiEdit、NotebookEdit）を、最初に触った順にパスで束ね、足した行と消した行の数と、新しいファイルの印を添える。
数は本文の欄の差分と同じ物から数え、Write は中身の行を足した数にする。
行に出ていないファイルの数（統計の変更数との差）は、見出しの数に足し、その訳を一行で言う。
統計の変更数はサブエージェントの編集も数えるので、主線を全部読み込んでいれば「ほか N 件はサブエージェントの変更です」、まだなら「ほか N 件は、古い本文を読み込むと出ます」と言う。
サブエージェントを見ていて主線をまだ読んでいない間は、訳が分からないので数だけ出す。
行を押すと VS Code で開く。
`POST /api/sessions/:id/open-editor` に `file` を添えると、サーバはそのセッションが編集系のツールで変えたファイル（`event_index` の綴りそのまま）で、いまもファイルとしてある（ディレクトリに替わっていない）ものだけを開く。
別のセッションが変えたパスと、Read で読んだだけのパスは開かない。
任意のパスを code に渡させないためである。
`file` が無ければ、今までどおり作業ディレクトリを開く。
端末は墨の板で、縁がそのセッションの状態で灯る。
作業中は杏の輪と光がゆっくり明暗を往復し、入力待ちは赤の輪と光で動かず、休みと終了は灯さない。
タブは板から生えたフォルダの耳で、選んだタブが板と同じ墨色になってつながる。
要約の欄の出所は、何がこの要約を書いたのかが作り直すかどうかの判断に要るために出す。
他の PC で実行中なら、線の下の 1 行に「MacBook で実行中」（heartbeat が 2 分より古ければ「MacBook から応答がありません」）と最終確認の時刻を出し、再開とフォークは理由を添えて押せなくする。
手元に本文が無いセッションと、ロックが `stale` になったセッションでは「この PC で再開」を押せる。
「引き継ぐ」は作らなかった。

ターミナルの接続はタブごとに持ち、思いがけず切れたら、そのタブだけを 1 秒、2 秒、4 秒と間を延ばし、30 秒を上限にしてつなぎ直す（`runtime/terminals.ts`）。
本体の WebSocket の再接続を待たない。
つなぎ直す前に、そのタブがストアの上でまだ生きているか（Claude のタブは run が終わっていないか、シェルのタブは閉じていないか）を確かめ、生きていなければつなぎ直さない。
続けて 5 回つながらなければ自動ではやめ、カードは「つなげませんでした。」と言って「再接続」に任せる。
upgrade を HTTP で断られた（404 や 401）タブは、ブラウザでは 1006 で閉じるだけで、待ってもつながらないからである。
やめた後も、画面に戻ったときの接続（bootstrap の後の `terminal.connect` など）は 1 回だけ試す。
サーバの再起動中に Claude が終わると `run.ended` が届かないので、取り直した bootstrap から消えた run は終わったもの（`lost`）、消えたシェルのタブは閉じたものとして、届いたときと同じ道で接続を切る。
画面を離れた、run が終わった、タブを閉じたなど、自分で切ったときと、サーバが断ったとき（エラーの知らせ）と、中の端末が終わって閉じたとき（サーバが 1000 と `exited` で閉じる）は、自動ではつなぎ直さない。
xterm の中で tmux から抜けた（C-b d）ときも、サーバは 1000 と `exited` で閉じる。
そこで `exited` で閉じても run とタブがストアの上で生きていれば、カードに「ターミナルから切り離されました」と「つなぎ直す」を出し、押されるまでつながない。
本当に終わったときは、続いて届く `run.ended` か、閉じたタブの `tab.upsert` が接続を切ってカードを消す。
切れている間は、その枠の板を暗く沈めて縁の灯を消し、中央に白いカード（「ターミナルとの接続が切れました」、Claude かシェルが動き続けていること、次に試すまでの秒数、「再接続」）を置く（F1）。
サーバが断ったときは「ターミナルに接続できませんでした」と言う。
「再接続」は待たずに今つなぎ、間を最初に戻す。
分割して 2 つ並べたときは、枠ごとに Host から様子を読み、切れた枠にだけカードを出す。
目次から跳ばした Claude が transcript を見せている間は、Claude の枠の上端に杏の地の全幅の帯を差し込み、「transcript を表示中」、跳ばしたターンの時刻、Claude が裏で動き続けていること、「最新へ戻る」を置く。
「最新へ戻る」は、目次の「最新へ」と同じ道（`turn.latest` と `leaveTranscript`）で抜ける。
帯が出ていても、枠の中の Esc は横取りせずに Claude へ渡す。
Esc は Claude の中断に要り、利用者が xterm で自分で transcript を抜けた（`q` や ctrl+o）ことを hangar は知らないからである。
横取りすると、抜けた後の中断の Esc が「最新へ」に化けて失われる。
帯は、跳ばした run が今の生きた run で、サーバが transcript に入れたと答えた（`found` か `notFound`）ときだけ出す。
答えを待つ間と、入れなかった（`mode`）ときと、API が失敗した（`failed`）ときは出さず、失敗は目次の開いたターンの中で言う。
跳び先の状態は跳ばした run を覚え、開いたターンを閉じたときと、跳ぶには遠すぎるターンを開いたときと、画面を離れたときにも、その run を transcript から抜けさせる。
戻ってきたときに Claude が古いターンを見せたまま止まって見えないようにするためである。
跳ばした run が終わるか、再開で run が替わったら、跳び先の状態を忘れる。
`leaveTranscript` は今も生きている run にだけ送り、送った後に run が終わって断られても（409）知らせない。

実行中のセッションの「停止」は、取り消せない操作なので「…」のメニューの最後に、区切りの後ろの危険色（`--error`）で置く。
サーバの停止は、そのランのシェルタブを全部閉じてから tmux を落とす。
そこで、作業中（`busy` か `waiting`）のときと、シェルタブが 1 枚でもあるときだけ、先に確認を出す。
確認には「作業中です」とシェルタブの枚数を書き、既定のフォーカスは「やめる」に置く。
確認は取り消せない操作の形（見出しの前の赤い丸の停止のアイコンと、赤く塗った「停止する」）にする。
休みでシェルタブが無ければ、押したらすぐ止める。
作業中かとシェルタブの数は View が `session.kill` に添え、確認を出すかは Mediator が決める。

トランスクリプトの見せ方は UX 刷新 2 で決めた（`docs/superpowers/specs/2026-10-01-ux-refresh-2-design.md` の「2 本文の表示」、試作は `2026-10-01-ux-refresh/transcript-render.html`）。
利用者の指示は打ったとおりに右寄せの青い吹き出しで見せる。
Claude の返答は吹き出しをやめ、白い面に地の文の Markdown として描く（幅は 76 字まで）。
Markdown は段落、見出し、箇条書きと番号付き（入れ子を含む）、表、引用、横線、囲みのコード（言語名とコピーのボタン）、太字、斜体、打ち消し、インラインのコード、リンクを読む。
読み方は `presenters/markdown.ts` に自前で持ち、ライブラリは使わない。
HTML は解釈しない。
文字はどれも React の子として渡すので、タグは文字のまま出る。
リンクにするのは http と https の宛先だけで、PR のリンクと同じく `target="_blank"` で外に開く。
ほかの宛先（`javascript:` や相対のパス）は名前だけの文字にする。

ツール呼び出しは 28px の 1 行に、ツール名の札、要約、結果の印、時刻を並べ、押すと下に中身を開く。
札の色は手の種類（`packages/shared` の `steps.ts`、live-explainer と共有）で決め、読む＝灰、書く＝藍、走らせる＝杏、コミット＝緑、失敗＝赤、その他＝薄い灰にする。
試作の K1 は読む＝青、書く＝緑、web＝紫だったが、アプリの中で同じ種類が同じ色になることを優先して、live-explainer の色帯に合わせた。
WebFetch と WebSearch は手の種類では「読む」なので、札も灰にする。
中身は種類ごとに描き分ける（`presenters/tools.ts`）。
Edit と MultiEdit は統合表示の差分にし、変わらない行は変わった所の前後 2 行だけを残して間を畳む。
行番号は Edit の結果に付く `cat -n` の抜粋から読み、読めなければ番号を付けない。
MultiEdit は 1 か所ずつに「N か所目」の見出しを付ける。
Write はパスと言語と行数の付いたコード、Bash はコマンドと出力と終了コード（結果の頭の `Exit code N` を読む）、Read はパスと行の範囲、WebFetch は URL と聞いたことと答え、WebSearch は検索語と結果のリンクの一覧にする。
Grep、Glob、Task（Agent）、TodoWrite とその他のツールは、引数を 1 つずつ並べ、結果の文を下に出す。
生の入力の JSON は「生の記録」のトグルを入れたときだけ、中身の下に出す。
ツールの見せ方は差分を取るので、呼び出しの物を鍵に控えて、描くたびには作り直さない。

入れ子のスクロールは作らない。
返答と指示は 320px、出力とコードと結果の文は 12 行、差分は 24 行を超えたら切って下端をぼかし、「全文を表示（残り N 行）」を置く。
開くと面そのものが伸び、下に「畳む」を置く。
返答の残りの行数は、76 字で折り返したとみなした見積もりである。
隠れるのが 3 行以下なら切らない。
開いたツールと開いた長い本文は `Transcript` が seq ごとに覚え、仮想スクロールで行が窓の外へ出て戻っても開いたままにする。

思考は既定で非表示にし、切り替えで出す。
サブエージェントは親のツール呼び出しの下にネストする。

本文の中は ⌘F で探せる。
欄は本文の面の右上に浮くガラスで、件数（「3 / 12」）、前へ（⇧⏎）、次へ（⏎）、大文字と小文字の区別、閉じる（Esc）を並べ、スクロールバーの脇に一致のある行の印を置く。
仮想スクロールなので、DOM ではなくデータで探す（`presenters/find.ts`）。
数える単位は、描くときに印の部品（`Hl`）へ渡す文字の葉で、Markdown とツールの描き方は同じ順に同じ文字を渡す。
今の一致が畳んだツールや切った本文の中にあれば開いて見せ、行まで送り、その行の何番目の印かで濃い印を付ける。
畳んだツールの行には「一致 N」を出す。
数え始めは、語を打ったときに見ていた行より後ろの最初の一致である。
⌘F を受けるのは、本文が画面に出ているとき（ターミナルが出ていないとき）だけで、ターミナルが出ているときはターミナルとブラウザに渡す。
欄の状態は `sessionView` に持つが、その場の操作なので保存しない。

セッションの一覧の検索の結果から開くときは、`session.open` に抜粋の seq と検索語を添える。
seq は主線とサブエージェントで別々に振るので、抜粋はどの線の行かを `agentId` で持つ（主線は null）。
サーバは抜粋を主線を先に、seq の順に返し、跳び先は主線の抜粋だけから取る。
主線の抜粋が無ければ（サブエージェントの中だけで当たったときは）、跳ばずに最新の側から開く。
着いた画面は最新の側ではなく、その seq の 100 手前から前向きに 1 頁を読み、一致した行へ跳んで、その行の地を淡い黄から 1.8 秒で薄れさせ、行の中の検索語の印を残す。
抜粋の seq が描く行に無ければ（ツールの結果の行など）、その後ろの最初の行へ跳ぶ。
後ろ（新しい側）は一覧の下の「新しい行を読み込む」で読み足し、まだ読んでいない後ろがある間は、末尾に着いても追うのに戻さない。
過去へ遡って空の頁が返ったら、「古い行を読み込む」を出さない。
ターミナルが出るセッションでは右の欄が最新の側を使うので、跳び先があっても最新の側から読む。
跳び先はその画面にいる間だけのもので、画面を離れたら忘れる。
トランスクリプトは最新の側から開く。
開いた時点で末尾のページを読み、過去へは「古い行を読み込む」で 1 ページずつ遡る。
長いセッションでも、先頭から全部を読み込んでから末尾へ飛ぶ必要がない。
実行中のセッションで追うのをやめている間に届いた分は、「新着 N 件」の帯で知らせる。
N は実際に追記された行の数であり、遡って読み込んだ古い行は数えない。
件数の増分で数えると、遡った分まで新着に混ざるためである。
長いセッションは仮想スクロールで描く。
一覧の `VirtualList` とは別に、トランスクリプト専用の窓を `Transcript.tsx` に持つ。
行の高さが中身によって大きく変わるので、描いた行の高さを `seq` ごとに覚え、まだ描いていない行は見積もりで置く。
DOM に載る行の数は件数によらず一定で、「追う」と「もっと読む」は今までどおり効く。

### Sessions

検索画面である。
上から、件数つきの状態のタブ（すべて／確かめる／Active／Paused／Done／Archived）、キーワード欄、絞り込み（プロジェクト、期間、触ったファイル）、結果一覧の順に置く（★）。
セッションの状態は Active・Paused・Done・Archived の 4 つで、状態が無いものを Active と呼ぶ。動いているかどうかは状態ではなく、行の丸い点で見せる。
条件が無いときは節（今日戻る → 確かめる → Active → Paused → Done の直近 3 件、Archived は末尾の 1 行）で読み、条件かタブがあれば平らな結果にする。
節は状態だけで決め、動いているものは Active の節の先頭に並ぶ。
「すべて」で条件を入れたときは Archived を除く。
キーワード欄は `is:` `since:<n>d` `project:` `file:` のトークンを受け、欄を正とする（タブと絞り込みはその表示で、効いている条件は欄の中のチップになる。読めないトークンは語として本文を探し、欄の下で知らせる）。
結果の行は 2 段で、1 段目に名前とプロジェクト名、2 段目に一致箇所の抜粋（最初の 1 つ。一致した語に淡い印）、右端に日時を出す。
検索語が無いときの全件の一覧も同じ形で、2 段目は要約の 1 文になる。
どの一覧の行も、2 段目の頭に要約の見立ての札を置く（Home の最近とプロジェクト詳細も同じ）。
色を付けるのは「詰まっている」（入力待ちの色）と「やめた」（Paused の色）の 2 つだけで、「やりかけ」「済んだ」は注記の色の語だけにする。
色の札が 2 種しかないので、一覧を流し見ると色の行だけが目に止まる。
土台の要約の見立ては、プロセスが生きているかどうかの写しなので札にしない。
検索の結果はサーバが上位 50 件ずつ返す。
切れているときは見出しの件数を「上位 50 / 132 件」の形にし、一覧の末尾に「さらに読み込む」を置いて続きを offset で読み足す。
行の右端には、本文の期限が 7 日以内なら琥珀の「まもなく削除」を、保持期間で本文が消えたとみられるなら文字の無い印を、時刻の左に添える（ホームとプロジェクト詳細の一覧も同じ）。
本文の無い行の印はこの 1 つだけで、枠だけの小さな札の形にする。

### Settings

1 枚の長い頁のまま、節を 5 つの群にまとめ、左に固定の目次を置く（試作は `docs/superpowers/specs/2026-10-01-ux-refresh/settings-layout.html`）。
群は、必須（ワークスペース、ツール、Node）、連携（MCP、statusline、外のターミナル、通知）、要約器、同期（クラウド同期）、情報（使用量、索引、この PC、会話の保持）である。
目次は群の名前と中の節の名前を並べ、スクロールに合わせて今の群を灯し、押すとその群へ滑る。
直すもの（無くても動くものを除く ✗）がある群には、目次と群の見出しに印を付ける。
オンとオフの項目はスイッチにして行の右端に置き、ターミナルアプリはアプリのアイコンを添えた切り替えの帯、要約器のモデルは一覧、1 時間の上限は ± の付いた数値の欄にする。
スイッチと帯は切り替えた時点で保存する。
外部の要約器を許すスイッチだけは、オンにするとき、保存済みの宛先へ会話の本文が送られる旨を確かめる帯（「許す」「やめる」）を挟み、「許す」を押して初めて保存する。
オフにするときは確かめずにその場で保存する。
パスの欄（ワークスペースのルート、tmux、claude、code、Node）は、欄を出たとき（または Enter）に、その 1 項目だけを保存する。保存のボタンは持たない。
値は前後の空白を落として見比べ、変わっていなければ送らない。
保存できたら欄の横に「✓ 保存しました」を 2 秒出し、断られたらその理由を欄の下に出して、書いた値は欄に残す（トーストにはしない）。
設定の画面を離れたら、欄の下の理由は消す（戻ると欄は保存済みの値に戻るので、理由だけが残ると、いまの値が断られたように読める）。
サーバは保存の前に、ツールのパスが実行できるファイルであること、ワークスペースがディレクトリであることを確かめ、先頭の `~` はホームに直してから保存する。
理由は欄の見出しで言う（例：「tmux のパス」に /x が見つかりません、「code のパス」の /x には実行権がありません）。
ツールの欄は名前だけ（`tmux` など）も受け、起動のときと同じく PATH から探して確かめ、打たれたまま保存する（「tmux のパス」の x が PATH に見つかりません）。
`./x` や `bin/x` のような相対パスは、サーバの作業ディレクトリで読むとどこを指すかが分からないので弾く（「tmux のパス」は / か ~ で始まるパスか、tmux のようなコマンドの名前にしてください）。
欄の下には 1 行の検証を置き、動かせるときは見つかったパスと版（ワークスペースは登録したプロジェクトの数）、動かせないときは直し方を出す（tmux は `brew install tmux` とコピー）。
code は無くても動くので弱い色にする。
Node の欄が空のときは、サーバを動かしている Node を「自動で見つけました」と添えて出す。
LM Studio の URL、モデル、1 時間の上限は 3 項目をまとめて「要約器の設定を保存」で保存し、そのボタンの横に同じ「✓ 保存しました」を出す。
URL の欄の下には、モデルの一覧が取れたかで「つながりました（モデル N 個）」か「LM Studio に繋がりません」を出す。
ターミナルで打つコマンドは、薄い地のコードの行と右端のコピーで出し、どれも同じ hangar の呼び方にそろえる（`hangar mcp install`、`hangar statusline install`、`hangar shell install`。hangar に PATH が通っていなければ同梱の hangar の絶対パス）。
コピーのボタンは、ランタイムがクリップボードに写せたと返してから（Mediator の `copied` が進んでから）「コピーしました」を出す。
写せなかったときは「コピーできませんでした。文字を選んで ⌘C で写してください」とだけ知らせ、写そうとした中身はトーストに出さない。
参加トークンのような秘密も同じボタンで写すからである。
MCP、statusline、外のターミナルの見出しの右には、登録済み、追記済み、この PC は導入済みかどうかの札を置く。
クラウド同期の節には、同期の状態と最後の受信、今すぐ同期と同期を一時停止、参加している PC の一覧、参加トークンの再表示、Claude Code の設定を同期する印と取り込む内容の下見を置く。
参加トークンは押したときだけ出し、コピーのボタン、減っていく細い棒、「あと N 秒で消えます」を添え、120 秒で自動的に消して表示のボタンに戻る。
同期の状態の語（同期済み、送信中、受信中、一時停止中、同期エラー）はヘッダーの同期の一行と同じ表から引き、索引の進み（索引を準備中、索引 10 / 200 件、索引の作り直し 10 / 200 件）もヘッダーと同じ関数で作る。
何度も失敗して 30 分おきの再試行に回した本文は「送れなかった本文」と呼ぶ。
操作ボタン（今すぐ同期、同期を一時停止、参加トークンを表示）の下に「使用量と費用」の段を置く（試作は `docs/superpowers/specs/2026-10-02-cloud-usage/usage-merged.html`、仕組みは「クラウド同期」の「使用量と費用」の節）。
上に札を 3 枚並べる。「今月の請求」は `$0.00` と「9/30 分まで」、「D1 の書き込み（今日）」は割合と行数、「プラン」は「Workers 無料」と「R2 従量」である。
その下に棒の一覧を置く。今日の枠（D1 の書き込み、Workers の要求）、区切り、今月の枠（R2 の各項目）の順で、今日の枠の棒には止める線（上限の 80%）に目盛りを打つ。
添え書きは「今日の枠は 9:00 に戻る · 目盛りの 80% で同期を止める」と、出どころ（「Cloudflare の数 · 2 分前」か「hangar の見積もり」）である。
9:00 は枠が戻る時刻（次の 00:00 UTC）を端末の時刻で書いたもので、決め打ちしない。
状態ごとの姿を持つ。
D1 が止める線の 75% 以上なら、札と棒を注意の色にして「あと N 行で同期を止めます」と出す。
無料枠で止まっている間は、札と棒を止まった色にして、枠が戻る時刻と「同期を再開」で戻れることを帯で言う。
見張りは hangar の見積もりで止めるので、Cloudflare の数が 80% より小さいことがあり、そのときは帯に「（Cloudflare の数では 59%）」と添えて食い違いを隠さない。
トークンを入れていない端末では、請求とプランの札を「—」と「トークンが要ります」にし、D1 の札と棒を「約」付きの見積もりにして、案内の帯と `npm run hangar -- setup cloud --usage-token` を出す。
取れなかったときは最後の値を出し、出どころの文を「Cloudflare の数 · 14:02 · 取得に失敗」にする。
Workers Paid のときは今日の枠の棒と D1 の札を出さず、札は請求とプランだけ、棒は今月の項目だけにする。
ヘッダーの同期の一行は、無料枠で止まったとき「無料枠で停止 · 9:00 に戻る」（赤い点）と言い、枠が戻った後は「無料枠で停止 · 枠は戻りました」と言う。
手で止めたときは、いままでどおり「一時停止中」である。
statusline の節は追記の有無と追記先のパスを出すだけで、書き込むボタンは持たない（追記は CLI から行う）。
MCP の登録の有無は `~/.claude.json` の `mcpServers.hangar` を読んで決める。読むだけで書かない。
外のターミナルの節は、同期している PC ごとの包み方の状態（入っている、まだ、この PC では使えない）と、入れるために貼るコマンドを出す。書き込むボタンは持たない（`hangar shell install` から行う）。
会話の保持の節は、Claude Code の保持期間と本文の使用量を出す。書き換えるのはこの節だけで、期間を押すと差分を見せる確認を開き、「書き込む」を押して初めて書く。
通知の節は連携の群の最後に置き、「通知を受け取る」のスイッチ 1 つで、入力待ちを窓の外へ知らせるかを決める（「入力待ちの知らせ」の節）。
無くても動くので、直すものの数には入れない。
通知を出せない環境（ブラウザで拒んだ後や、Notification の無いブラウザ）では、スイッチを押せなくして理由を添える。

### 入力待ちの知らせ

試作は `docs/superpowers/specs/2026-10-01-ux-refresh/waiting-notify.html`、決めた案は A1、B1、C1、D1、N1 である（`2026-10-01-ux-refresh-2-design.md` の 3 節）。

どのセッションが入力待ちかは、ランタイムがストアから決める。
`live.update` は Claude のセッションの id で届くので、hangar のセッションに引き当ててから、入力待ちの一覧が変わったときだけ Mediator へ `waiting.changed` を届ける。
数え方は `liveFilterOf` である。

新たに入力待ちになったセッションは、右下に 1 件 1 枚のカードとして積む。
カードには赤い縦の帯、名前、待っている時間、プロジェクト、問い（2 行まで、取れなければ「入力を待っています」）、「ターミナルで答える」を置く。
どこを押しても、そのセッションを開いてターミナルにフォーカスする（`session.open` の `focus: 'terminal'`）。
カードは入力待ちが解けるまで残し、時間では消さず、閉じるボタンも持たない。
解けたら下げる。
そのセッションを開いたときも下げ、離れた後もその入力待ちでは積み直さない。
いま開いているセッションが入力待ちになったときは、見えているので積まない。
カードは 3 件まで並べ、新しいものほど下（窓の角の側）に置く。
Home を見ている間と、そのセッション自身の画面を見ている間は、その件のカードを出さない。Home は「要対応」の札が、セッション画面は端末の縁の灯と端末そのものが言っているからである。ほかの画面では出す。サイドバーの件数、macOS の通知、Dock のバッジは変えない。
4 件目からは「ほか N 件をホームで見る」の小さな錠剤にまとめ、押すとホームの要対応へ移る。
通知を受け取っていないときは、カードに小さな「通知を受け取る」を添える。
確認や入力のあるダイアログ（未解決のプロジェクト、確認、新しいセッション、昇格、保持期間、設定の取り込み）が開いている間は、カードも錠剤も押せない。
カードは知らせの層にあってダイアログより前に出るので、押すとダイアログを開いたまま裏の画面だけが移ってしまう（⌘I と同じ考え方）。
カードの「ターミナルで答える」と錠剤は押せなくなり、カードの添え書きは「ダイアログを閉じると開けます」に替わる。
Mediator も、そのあいだの `session.open` では画面を移さない（`mediator/screen.ts` の `canMoveBehind`、中身は `mediator/overlay.ts` の `overlayReplaceable`）。
パレットや読むだけのダイアログ（キーの一覧、昇格の完了）なら、閉じてから移る。

info のトーストは 4 秒で消え、押しても消せる。
error のトーストは時間では消えず、閉じる × で消す。
error は赤みのガラスに警告のアイコンを添え、幅は 420px まで、本文は 2 行まで見せ、収まらないときだけ「詳しく」で開く。
時間切れはトーストごとに持ち、マウスを乗せている間とフォーカスが中にある間は止める。
読み上げは info が `role="status"`、error が `role="alert"` である。

窓が背面にあるとき（頁が隠れているか、窓にフォーカスが無いとき）は、入力待ちになったセッションごとに通知を出す。
題はセッションの名前、本文は問いの文（取れなければ「入力を待っています」）である。
通知を押すと窓が前に出て、そのセッションを開いてターミナルにフォーカスする。
確認や入力のあるダイアログが開いていれば、窓が前に出るだけで、画面は移さない（カードと同じ扱い）。
Dock（ブラウザならインストールしたアプリ）のバッジには入力待ちの数を出し、0 で消す。

デスクトップの殻では、通知を UNUserNotificationCenter で出す（`src-tauri/src/notify.rs`）。
頁は `notify_waiting` を呼び、殻は id と文を確かめてから OS に渡す。
押された通知は識別子からセッションを読み戻し、頁の `__hangarOpenWaiting` で開く。
頁が出来上がる前なら、ディープリンクと同じくハッシュとして貯める。
`tauri-plugin-notification` は、デスクトップでは押された通知を知らせないので使わない。
`.app` の外（`tauri dev`）では通知を出さない。
バッジは Tauri の `set_badge_count` で出す。
ブラウザでは Web Notification と `navigator.setAppBadge` を使い、どちらも無ければ何もしない。

通知を受け取るかは PC ごとに localStorage（`notify.waiting`）に残す。
選んでいなければ、デスクトップでは受け取り、ブラウザでは受け取らない。
デスクトップで受け取るときは、起動したときに OS の許可を一度だけ尋ねておく（決まった後は OS が黙って答える）。
尋ね終えたら、殻の `notify_status` で UNUserNotificationCenter の許可の状態を読む（尋ねはしないのでダイアログは出ない）。
システム設定で切られていれば（denied）、受け取らないにし、設定の通知の節に「システム設定の「通知」で Hangar を許可してください」と出す。
このときカードの「通知を受け取る」は添えない。
利用者の選んだ値（`notify.waiting`）は書き換えない。
スイッチを入れて断られたときも許可の状態を読み、切られていれば同じ直し方をトーストで知らせる。

許可は hangar の外（システム設定、ブラウザの設定）で変わるので、窓が前面に戻ったとき（window の focus と、document の visibilitychange で visible）にも読み直す（`runtime/runtime.ts` の `recheckNotify`）。
デスクトップでは `notify_status`、ブラウザでは `Notification.permission` を読む。
利用者が受け取ると選んでいれば（選んでいなければ環境の既定）、許されたら受け取るに戻し、切られたら受け取らないにする。
だから OS で許可し直して hangar に戻れば、スイッチを触らなくても受け取るに戻る。
受け取っていたのに切られたときは、設定の通知の節の案内に加えて、同じ直し方をトーストで知らせる。
受け取らないと選んでいれば、許されても受け取るにはしない。
設定の案内は「許可して Hangar に戻ると、受け取るに戻ります。戻らないときは、このスイッチを入れ直してください。」で結ぶ。
受け取らないと選んだまま、スイッチを入れて断られた後に OS で許可したときは、選んだ値が受け取らないのままなので戻らないからである。
窓に戻ると focus と visibilitychange が続けて来るので、最後に読んでから 2 秒の間は読み直さない（`NOTIFY_RECHECK_MS`）。
古い殻（`notify_status` が無い）や `.app` の外では、まだ決まっていないとみなし、これまでどおり受け取るのままにする。
ブラウザの許可は、設定のスイッチかカードの「通知を受け取る」を押したときにだけ求める（押した操作の中でないとダイアログが出ないため）。
許されなかったら受け取らないままにして、「通知が許可されませんでした」と知らせる。

### 外のターミナルのセッション

VS Code や iTerm のターミナルで起動した claude は、画面（PTY の親側）をそのアプリが持つので、hangar は横からつなげない。
hangar が読めるのはレジストリ（`~/.claude/sessions/<pid>.json`）と本文だけである。
そこで、ターミナルで打った claude を、はじめから hangar の tmux の中で動かす。
hangar の画面から起動した run と同じものになるので、hangar の画面からも同じ tmux につなげる。

Claude のバックグラウンドのサービス（`claude --bg`）には移さない。
Claude Code は、利用上限に当たったセッションを上限が戻ったときに自動で続けるが、この予約は対話で、バックグラウンドでなく、リモートでもないセッションにしか入らない。
2026-10-01 の夜、以前の包み方でバックグラウンドになった 3 本が上限で朝まで止まり、素の claude だった 1 本だけが自動で続いた。
hangar の tmux の中の claude は、上限を模した中継で、予約が入り、戻った後に自分で続くことを確かめた。

- **包み方（`hangar shell install`）**：`~/.zshrc` から `~/.agent-hangar/shell/claude.zsh` を読む。
  対話で起動した `claude` は、hangar に起動を頼み（`POST /api/runs/terminal`）、返ってきた tmux のセッションにこのターミナルからつなぐ（`tmux attach`）。
  頼むときに、作業ディレクトリ、引数、環境変数を渡す。tmux の新しいセッションはシェルの環境変数を継がないので、hangar が `tmux new-session -e` で渡す。
  プロジェクトは、作業ディレクトリを含むルートのうち最も深いものにする。無ければ未分類にする。
  `-r <id>` は、その会話の run がもう動いていれば、その tmux につなぐだけにする。動いていなければ hangar に再開を頼む。
  hangar が応答しない、または断ったとき（tmux が無い、hangar が組み立てる引数と重なる引数を付けた、同じ会話が hangar の外で動いている）は、素の claude を起動する。
  すでに tmux の中にいるときは、hangar の tmux サーバなら入れ子にせず `switch-client` で移り、ほかの tmux の中なら素の claude を起動する。
  サブコマンド、`-p`、`-c`、`--bg`、id の無い `-r` などは包まない。
  抜けるときは、claude を終えるか、tmux から切り離す（`Ctrl+B` の後に `D`）。切り離した run は hangar の一覧に残り、hangar から止められる。
  本体は hangar が起動のたびに書き直すので、包み方を直しても各 PC で入れ直す必要はない。
- **引き取り（`POST /api/sessions/:id/adopt`）**：外のターミナルで動く、入力待ちか休みの CLI の claude を止め、同じ id のまま hangar の tmux の中で `claude -r` で再開する。普段の再開と同じ run になる。
  止める前に、レジストリの `entrypoint` が `cli` であること（VS Code の拡張の中の claude は止めない）と、pid の起動時刻がレジストリの `procStart` と合うこと（pid の使い回しで別のプロセスを止めない）を確かめる。
  止めた後は、レジストリからその会話が消えるのを待ってから再開する。消える前に再開すると、hangar の外で動いていると見て断ってしまう。
  入力待ちで止めると、待っていた問いは「答えなかった」として閉じる。元のターミナルからは、包み方を通した `claude -r <id>` で同じ run に戻れる。
- **バックグラウンドのセッション**：利用者が自分で `claude --bg` で起こしたものや、以前の包み方で起こしたものには、今までどおり hangar の tmux の中の `claude attach` でつなぐ（`POST /api/sessions/:id/attach`）。
  attach の run の種類は resume のままにする。種類を増やすと、同期で行を受け取る古い版の端末が DB の制約で取り込めなくなる。
  attach の run の停止は、tmux を落とすのに加えて `claude stop <id>` でバックグラウンドの本体も止める。
  止まったバックグラウンドのセッション（1 時間つながれずに止まったものを含む）の再開は、`claude -r` ではなく `claude attach` で起こす。`claude agents --json --all` に載っていれば、そちらを使う。

hangar は、run とシェルタブの tmux のセッションに `LC_CTYPE=UTF-8` を渡す（呼び手が `LC_ALL` か `LC_CTYPE` を決めていればそちら）。
tmux の新しいセッションはサーバの環境を継ぎ、.app から起こした hangar が立てたサーバには `LANG` が無い。ロケールが無いと、claude が選んだ範囲を写すときに日本語を読めず、Mac のクリップボードを空にする。
hangar の画面は OSC 52 を受けて書き直すが、アプリの WebKit では書けないことがあるので、claude 自身の書き込みが正しくなければならない（2026-10-02 に確かめた）。

hangar は、tmux サーバに端末のための設定を入れる。どれもサーバ全体に効くので、利用者の値を上書きしない形で入れる。
- `copy-command` を `LC_CTYPE=UTF-8 pbcopy` にする（空か、前の版が入れた素の `pbcopy` のときだけ）。iTerm2 は既定で端末のアプリからのクリップボードへの書き込み（OSC 52）を許さないので、マウスで選んだ範囲を直接クリップボードへ渡す。
  pbcopy はロケールで文字コードを決める。tmux サーバの環境には `LANG` が無いことが多く、素の `pbcopy` では日本語を写すとクリップボードが空になる（2026-10-02 に hangar の画面で起きた）。
- `extended-keys` を `on` にし（`off` のときだけ）、`extended-keys-format` を `csi-u` にし、`terminal-features` に `xterm*:extkeys` を足す。外の端末から Shift+Enter を区別して受けるためである。
- `S-Enter` を、hangar の run のセッション（`hangar-<id>`）でだけ ESC CR に変える。tmux は CSI u の Shift+Enter を素の CR に潰すので、Claude Code が改行と読む ESC CR を送る。シェルタブとほかのセッションには Shift+Enter のまま送る。
2026-10-01 に、この設定の tmux へ iTerm2 からつなぎ、Shift+Enter の改行、スクロール、ドラッグでのコピーが動くことを確かめた。通知は確かめていない。

各 PC の包み方の状態は `devices.shell_hook` に書いて同期する。使えない（`unsupported`）は、zsh でないか tmux が見つからないことを指す。
同じ tmux に 2 つのターミナルがつないでいるとき、画面の大きさは最後につないだか大きさを変えた側に合う（tmux の `window-size latest`）。
使用量の節には、直近 30 日の日別（日、入力トークン、出力トークン、セッション数）と、プロジェクト別（名前、トークン、推定コスト、セッション数）の 2 つの小さな表を置く。
推定コストの列には、そのセッションの走り全体の累計であることを添える。
診断として、サーバのログの末尾と索引の進行を出す。

### ショートカット

- グローバル：⌘K と / でパレット（探す・移動）、⌘N 新しいセッション、⌘⇧N スクラッチ、⌘I 次の入力待ちへ、⌘, 設定、⌘[ と ⌘←（⌘] と ⌘→）で戻ると進む、? と ⌘/ でキーの一覧、Esc で開いているものを閉じる（何も開いていなければ入力欄を離れる）。
- タブとペーン：⌘1 から ⌘9 でタブ切替（素のブラウザでは ⌃⌥1 から ⌃⌥9）、⌘W でフォーカスのある枠のシェルタブを閉じる、⌘\ で横に並べる、⌘J で右の欄の開閉、⌘+ と ⌘− と ⌘0 でターミナルの文字の大きさ、⌘F で本文の中を探す（本文が出ているときだけ）。
  タブの列にフォーカスがあるときは ← と →（Home と End）でタブの間を移り、Enter か Space で選ぶ。
  選ぶとフォーカスはターミナルへ移るので、矢印で移るだけでは選ばない（tablist の手動の選択）。
  ターンの目次は j と k（↑ と ↓）で行を移り、Enter で開く。
  タブそのものは Tab で 1 つだけ止まる（roving tabindex）。目次の行も同じである。
  各タブの閉じるボタンは Tab で止めない（⌘W で閉じられる）。
  タブの列の追加と分割のボタンは別の操作なので、それぞれ Tab で止まる。
- 一覧：j と k（↑ と ↓ でも）で上下、Enter で開く、o でターミナル、e で VS Code、m でメモ編集。

一覧の行のフォーカスとカーソルは 1 つにまとめる（roving tabindex）。
Tab で止まる行はカーソルの行 1 つだけで、打鍵でカーソルを動かすとフォーカスもその行へ移り、クリックや Tab で行にフォーカスが来るとカーソルもそこへ来る。
Enter は一覧の器が 1 度だけ受けて、カーソルの行を開く。
Home とセッションの一覧の画面に入ったら、行が初めて並んだときに一度だけ一覧にフォーカスする。
一覧そのものには輪郭を描かない。開くたびに、まだ何も選んでいない一覧を枠が囲むことになるからである。どこに居るかは、カーソルの行の地色と、行そのものの輪郭で示す。
ただし入力欄、ターミナル、ダイアログにあるフォーカスは奪わない。
パレットの全文検索の行と Sessions 画面の欄の Enter は、検索を出した後にフォーカスを結果の一覧へ移す。
同じ語で検索し直して画面が作り直されないときも移るように、`search.query` は毎回 `focus` の効果（対象は結果の一覧）を出す。

打鍵と操作の対応は `packages/ui/src/keys.ts` の 1 つの表が持ち、照合も ? の一覧もそこから引く。
一覧の中の j や k のように画面の部品が自分で処理するものは、打鍵を持たない行として同じ表に並べる。
⌘ の付いた割り当ては Ctrl でも受ける。

⌘I（次の入力待ちへ）は、入力待ち（live が waiting）のセッションを Home の要対応の札と同じ順（長く待っている順）に 1 つずつ開き、ターミナルにフォーカスする。
いまいるセッションが入力待ちなら、その次へ移り、末尾の次は先頭へ戻る。
開く経路は「ターミナルで答える」と同じ `session.open` の `focus: 'terminal'` である。
どのセッションへ移るかはストアを見ないと決まらないので、Mediator は `waiting.next` の効果を出し、ランタイムが決めて `waiting.resolved` で返す（分割の右のタブと同じ形）。
入力待ちが無ければ、「入力待ちのセッションはありません」と短いトーストで知らせる。
パレットにも同じコマンドを置く。
⌘I を選んだのは、macOS の既定、Chrome、Tauri の既定のメニュー、xterm、Claude Code のどれとも重ならず、⌘ 付きなのでターミナルにフォーカスがあっても hangar に届くからである。

入力欄の Esc は、何も開いていなければその欄を離れる（blur）。
ダイアログの中の Esc は、ダイアログの殻（`views/primitives/Dialog.tsx`）が受けて閉じ、既定を止める。
`Root` の Esc は既定を止められた打鍵には重ねない。
重ねると、確認の後ろに控えた未解決のダイアログまで「あとで」で閉じてしまう。
`Root` が受けるのは、フォーカスが器の外（body など）にあるときの Esc だけである。
パレットは自分の入力欄で Esc を受けて閉じる。

パレット、キーの一覧、新しいセッションを開く操作は、確認や入力のあるダイアログを差し替えない。
受けるのは、何も開いていないとき、パレットのとき、読むだけのダイアログ（キーの一覧、昇格の完了）のときだけである。
確認の最初のフォーカスは「やめる」なので、修飾の無い / や ? も `Root` に届く。
差し替えると、確認は消え、後ろに控えた未解決のダイアログもキューに戻らない。
キーの経路だけでなくボタンやパレットの行からも来るので、`Root` ではなく Mediator（`mediator/overlay.ts` の `overlayReplaceable`）が止める。

画面を移す操作も、同じ規則で確認や入力のあるダイアログの裏では何もしない（`mediator/screen.ts` の `canMoveBehind`）。
対象は、⌘, の設定（`nav.go`）、⌘[ ⌘] とスワイプの戻る進む（`nav.back` と `nav.forward`）、`project.open`、`session.open`、全文検索（`search.query` と `search.clear`）、パレットの画面を移す行である。
ダイアログを開いたまま裏の画面だけが移ると、何に答えているのかが分からなくなるからである。
ブラウザの戻る・進む（マウスの戻るボタンなど）は Intent を通らず URL の変化として届くので、ランタイムが履歴の段の印から何段動いたかを添え（アプリが自分で書いた URL には添えない）、ダイアログが開いていれば画面を移さずに同じ段だけ履歴を戻して URL を合わせる。戻し終えて今の画面と同じ URL に着いた変化は読み込み直さない。
パレットと読むだけのダイアログなら、閉じてから移る。
ダイアログの中から意図して移るもの（保持期間の「ほかの期間…」の `retention.settings`、昇格の完了の「プロジェクトを開く」、起動や引き取りの完了の `launch.done`）は止めない。
前の 2 つは差し替えてよいダイアログか別の Intent から来て、起動や引き取りの完了は runtime の入力なので、この規則を通らない。
ブラウザの戻るボタンと URL の書き換えは `hashchange` で後から届くので止められない。
そのときはダイアログを残したまま画面が移る。

新しいセッションのダイアログの ⌘Enter は起動である（キーの表には載せず、起動ボタンのキー帽で示す）。
ターミナルの Esc は Claude Code の操作に要るので横取りせず、日本語の変換中の Esc も変換の取り消しなので欄に残す。

受け取らなかった打鍵は `preventDefault` しない。
ただしセッション画面の ⌘W は、閉じるものが無くても常に受け取り、ブラウザと OS へ渡さない。
渡すと、ブラウザではタブが、デスクトップでは窓が閉じる。
窓を閉じるとアプリが終わり、同梱サーバも止まる（tmux のセッションは残る）ので、押し違いでそこまで落とさないためである。
セッション画面の外の ⌘W と、タブの無い画面の ⌘1 から ⌘9 は、そのままブラウザへ渡る。

⌘W が閉じるのは、フォーカスのある枠のタブがシェルのときだけである。
Claude のタブでは何もしない（止めるのは「停止」の役目である）。
ダイアログやパレットを開いている間も何も閉じない（⌘I と同じく、開いているものの裏を動かさない）。
このときも窓へは渡さない。
フォーカスのある枠は、ターミナルの枠に `focusin` が入ったときと枠を押したときに、その枠のタブとして `Root` が覚える。
分割中は右の枠にもフォーカスが来るので、選択中のタブ（左）では足りないからである。
枠の外（ヘッダーのボタンなど）へフォーカスが移っても、最後の枠を覚えたままにする。
覚えた枠がもう画面に無ければ、選択中のタブを対象にする。
フォーカスは DOM の事実で描き方を変えないので、Mediator の状態には入れない。

ターミナルにフォーカスがあるとき、⌘ を含む組み合わせだけを hangar が受け取り、それ以外はすべてターミナルへ渡す。
判定は `keydown` の `target` が `.term-host` の中にあるかで行い、渡すものは `preventDefault` せずに xterm へ落とす。
Ctrl の側をここで奪わないのは、Ctrl+K や Ctrl+W が readline の打鍵だからである。
タブ切替は ⌘1 から ⌘9 と ⌃⌥1 から ⌃⌥9 の両方を常に受け付ける（Tauri かブラウザかの判別は持たない）。
ただし ⌃⌥ の側は ⌘ を含まないので、ターミナルにフォーカスがある間はターミナルへ渡る。

### 戻ると進む

画面の遷移は URL のハッシュで行うので、ブラウザの履歴がそのまま画面の履歴になる。
⌘[ と ⌘] は `history.go` を呼ぶだけで、行き先は `hashchange` から入ってくる。
トラックパッドの 2 本指の横スワイプも同じ履歴を辿る。
スワイプは `packages/ui/src/swipe.ts` が横方向のホイールを積んで決める。
作法はブラウザと同じで、**引いて、離したときに動く**。
しきい値（120）まで引くと身構え、そこで指が離れたら 1 度だけ `nav.back` か `nav.forward` を出す。
引き切る前に引き戻せば取り消しになる。

ホイールの打鍵には指の上げ下げが乗らない。
デスクトップでは、殻（Rust）が NSEvent の位相を読んで「指が触れた」を `window.__hangarSwipeBegin()`、「指が離れた」を `window.__hangarSwipeEnd()` で叩く（`apps/desktop/src-tauri/src/lib.rs` の `watch_swipe_phase`）。
触れたことも送るのは、指を置いたまま止めている間は打鍵が来ないからである。これが無いと、画面の側が「途切れた」と読んで離す前に動く。
WebKit の手勢が使っているのと同じ信号で、打鍵そのものは飲み込まず素通しするので、頁の中の横スクロールはそのまま効く。
位相を読める殻であることは、サーバの頁が出来上がった時点で `window.__hangarPhaseAware` を立てて画面に知らせる。

この手勢はデスクトップの殻の中だけの機能である。
ブラウザには元から戻る進むの手勢があるので、二重に持たず、標準に任せる（`window.__hangarPhaseAware` が立っていない環境では、ホイールを一切見ない）。
だから `overscroll-behavior-x` でブラウザの手勢を止めることもしない。

**時間で画面を動かすことはしない**。
確定は「指が離れた」の合図だけで行う。
時間で打ち切る経路を残すと、合図が遅れた回に、指を置いたまま画面が動く。
引き換えに、位相を持たない入力（マウスホイールの横倒し）ではアプリのスワイプが効かない。そこは ⌘[ と ⌘] を使う。
身構えないまま宙に浮いた手勢の矢印だけは、2 秒で消す保険を置く。消すだけなので、誤って動く経路にはならない。

指が離れた後も惰性の打鍵は流れ続ける。
これは終わった手勢の残りなので、次の手勢（`__hangarSwipeBegin`）が始まるまで捨てる。
捨てないと、離した直後に矢印が描き直されて居残る。

手勢の仕切りは `begin()` が受け持つので、打鍵の途切れで積みを捨てる保険は 1 秒に緩めてある。
ゆっくり動かすと打鍵の間隔は開くので、短く取ると引いている最中に積みが消える。

⌘[ と ⌘] は入口を問わず効く。ブラウザでも、アプリの最初の頁より前へは戻らない。
ただし確認や入力のあるダイアログが開いている間は、⌘[ ⌘] もスワイプも効かない（キーの節の `canMoveBehind`）。
スワイプはそのあいだ矢印も出さない。
Mediator が捨てるだけだと、矢印が出て動いたように見えるからである。

中身の無い打鍵（deltaX も deltaY も 0）は位相の切り替わりに付いてくるので、手勢の状態に触らない。
これを「縦に流している」と読んで積みを捨てていたため、引いて止めた手勢が離す前に消えていた。

積みは符号のまま足していく。
逆向きの打鍵が 1 つ来ただけでは捨てない。実機の打鍵は一方向に揃わず、細かな揺れが必ず混じるので、
捨てていると（実際そうなっていた）いつまでも身構えない。
取り消しは「引いた分が半分まで戻ったとき」で見る。

打鍵の細りは合図に使わない。
指を付けたまま引く速さは途中で普通に落ちるので、細りで動かすと「離していないのに戻る」ことになる（実際にそうなった）。

WKWebView 自身の手勢（`allowsBackForwardNavigationGestures`）は使わない。
公開 API はこの真偽値ひとつで、実体は `WKSwipeTransitionController` と `ViewGestureController` が前の画面の写しを滑らせる遷移まで含む。
演出だけを切る API は、公開・私用のどちらにも無い（dyld 共有キャッシュの記号まで当たって確認した）。
だから信号だけを同じ場所から取り、演出は持たない。

縦に流しているかどうかは、1 打鍵ごとの縦横の比べ合いではなく、**積んだ量**で見る。
指を置いている間もトラックパッドは微動を拾い、縦の方が大きい打鍵がいくらでも混じるので、
1 発で捨てていると、引き切って身構えた 0.1 秒後に手勢が消える（実際にそうなった）。
縦に 40 以上積み、しかも横より多いときだけ、縦の手勢とみなして捨てる。
横へ引き切った後は軸が横に固まり、縦に動いても取り消さない（ブラウザと同じ）。
惰性の名残だけで身構えないよう、8px 以上の打鍵が 1 つも無い手勢では身構えない。
動かした後は掛け金を掛け、同じ向きの惰性が細り切るか、逆へ引かれるか、打鍵が途切れる（200ms）まで次を受けない。
これが無いと、一振りで 2 画面戻る。

横へ流せる箱の中では、その向きにまだ余地がある限り箱が手勢を取る（`packages/ui/src/views/swipeTarget.ts`）。
`overflow: auto` の器はどの画面にもあり、組版の綾で数 px はみ出すので、8px を超えるはみ出しだけを本物とみなす。

持ち主は**手勢ごとに一度だけ**、最初の打鍵で決める。
打鍵ごとに決め直すと、箱が引かれて `scrollLeft` が変わるたびに持ち主が裏返り、
そのたびに積みが捨てられて矢印が荒ぶる（実際にそうなった）。
箱が取った手勢は、端に着いた後もその手勢のあいだは箱のもの。端で一度止まり、引き直して初めて画面が動く。
逆に、端から始めた手勢は画面のもの。途中で箱に余地ができても持ち主は移らない。

戻る先はアプリの中だけにする。
履歴の段に「アプリの中で何段目か」を押し（`packages/ui/src/runtime/hashLocation.ts`）、0 段目では戻らない。
デスクトップでは 0 段目の手前がサーバの起動を待つ頁で、そこへ移ると二度と遷移せず操作できなくなる。

引いている間は画面端に丸い矢印を出す（`packages/ui/src/views/SwipeHint.tsx`）。
引いた量（0 から 1）に応じて端から出てきて、引き切ると色が変わって「離せば動く」ことを見せ、動いた時点で消える。
戻る先が無いときは出さない。
矢印は Root が DOM を直に触って動かす。毎打鍵で React を回すと画面ごと描き直すことになるからである。

ネイティブの手勢は使わない。
WKWebView の `allowsBackForwardNavigationGestures` も、ブラウザの手勢も、前の画面のスナップショットを指に追従させる演出まで一式で引き受け、演出だけを切る手段が無いからである。
ブラウザの側は `overscroll-behavior-x: none` で止める。

## 見た目と動き

常にライトで、ダークモードは持たない。
例外はターミナルの面だけで、そこは端末エミュレータの慣習に合わせて墨色の不透明な板（`--term-bg`、`--term-fg`）にする。
参照するのは macOS 26 の Liquid Glass である。
画面は奥から「光の背景」「読む面」「浮くガラス」の 3 枚で組む。
光の背景は地の `--bg` の左上に 1 つの淡い光（`--aura-1`）を置く。光は動かさない。
以前は青と藤色の 2 つを 24 秒で漂わせていたが、読む面が白なので光の仕事は溝を染めることだけで、常に動かす値打ちが無かった（2026-10-05 の決定）。
読む面（一覧、カード、会話、設定の中身、プロジェクトの右の欄）は白で不透明にし、ガラスを重ねない。
ガラスはヘッダー、⌘K パレット、ダイアログ、通知、切断の帯、保持期間の帯にだけ使い、`backdrop-filter` は必ず `-webkit-backdrop-filter` と併記する（`styles/glass.test.ts` が置き場所を見張る）。
色はデザイントークンとして `:root` に定義する。
面は白と淡い青灰、アクセントは 1 色（`--accent`、主ボタンだけ `--accent-hi` からの淡いグラデーション）、状態色（busy、idle、終了、エラー）は控えめな彩度にする。
状態の点は、作業中が杏（`--busy`）、入力待ちが赤茶（`--waiting`）、休みが灰（`--ink-3`）である。緑（`--idle`）は「済んだ」の色で、終わったサブエージェントやコミットの札に使い、休みには使わない。
本文の色は、白地と、ガラスを重ねた色（白 40% を `--bg` に重ねた `#f5f7fa`）の両方で 4.5:1 以上を保つ。
プロジェクトの状態（`active`、`paused`、`done`、`archived`。画面では Active、Paused、Done、Archived）は、アイコンではなく色で示す。
状態ごとに文字色と淡い地色のトークン（`--st-<status>`、`--st-<status>-soft`）を持ち、状態の部品と見出しの点が `data-status` からそれを引く。
状態の部品は、文字、その右の塗りつぶしの丸、矢印の順に描いた札を、ガラスの一覧（`views/primitives/Listbox.tsx`）の顔にする。
開くと 4 つの状態を、色の点とひとことの意味（いま進めている、いったん止めている、やり終えた、一覧の奥へしまう）つきで並べる。
この部品は `views/primitives/StatusSelect.tsx` の `StatusSelect`（選べる場所）と `ProjectStatusDot`（読むだけの場所）だけを通して使い、View が一覧を自分で組むことはしない。
淡い地色の上の文字は 4.5:1 以上のコントラストを保つ。
状態は常に文字でも示すので、色は補助である。
グラデーションは主ボタンと背景の光だけ、影は浮く部品と端末の板だけに許す。
読む面へのガラス、シマー、スケルトン、タイピング風の表示、文字の影、光る文字は使わない。
開いて出るもの（パレット、ダイアログ、通知、メニュー）は、白 88% 以上の濃さにする（`--glass-bg-palette`、`--glass-bg-dialog`、`--glass-bg-toast`、`--glass-bg-menu`）。薄いと、裏の一覧の文字や墨の端末が透けて中身が濁る。
角は部品が 8px（`--r`）、面が 14px（`--r-lg`）、浮くガラスが 16px（`--r-xl`、ダイアログは 18px）、ボタンと「探す・移動」の入口とヘッダーは錠剤（`--r-pill`）にする。

ダイアログはどれも共通の殻（`views/primitives/Dialog.tsx`）に載せる。
殻は見出し、中身、下端のボタンの 3 段で、器の高さは窓から上下 32px ずつを引いた分までにする。
溢れた中身だけがスクロールし、見出しと下端のボタンはいつも見える。
中身が見出しの下をくぐり始めたら見出しの下に、続きがあれば下端の上に薄い影を出す。
器（覆いではなくパネル）が `role="dialog"` と `aria-modal` を持ち、`aria-labelledby` で見える見出しを名前にする。
開いたら最初の安全な操作へフォーカスを当てる。
印（`data-autofocus`）があればそこ、入力のあるダイアログは最初の欄、欄が無ければ下端の最初のボタンのうち主ボタンでも危険なボタンでもないもの（やめる、閉じる）、どれも無ければ器そのものである。
Tab は器の中で回り、閉じたら開いた元へフォーカスを返す（閉じる前にフォーカスが器の外へ移っていたら奪わない）。
閉じる手のあるダイアログは Esc と背景で閉じ、見出しの右に × を置く（取り消せない操作の確認と、下端に「閉じる」があるものには置かない）。
入力のあるダイアログ（新しいセッション、昇格）は、書きかけを押し違いで失わないよう背景では閉じない。
背景を押してもフォーカスは器の外へ落とさない。
取り消せない操作の確認（停止、一覧から削除）は、見出しの前に赤い丸のアイコンを置き、説明を見出しの下に添え、押し切るボタンを赤で塗る（`.btn-danger-fill`）。
ボタンは右に寄せ、「やめる」を赤いボタンの左に置く。
コマンドパレットは形が違う（検索欄の錠剤から広がり、一覧を縁まで敷き詰める）ので殻に載せず、器の見た目（`.dialog`）だけを共有する。

アイコンは Lucide（`lucide-react`）を使い、大きさ 16px、線幅 1.5 に固定する。
16px に縮むと実際の線幅は 1px になり、13px の本文の太さと釣り合う。
View は `lucide-react` を直接 import せず、hangar の言葉（`fork`、`resume`、`shell` など）から引く `views/primitives/Icon.tsx` だけを通す。
文字の無いアイコンだけのボタンには必ず `aria-label` を付け、文字に添えるアイコンは飾りとして読み上げから外す。
商標のアイコンは持たない（VS Code は汎用のコードのアイコンに文字を添える）。

書体は Inter 系のサンセリフに日本語は Hiragino Sans を重ね、識別子、パス、時刻、数だけの表示には JetBrains Mono 系の等幅を使う。
数と仮名が混じる短い語（「12 分前」「1,222 件」）は等幅にしない。等幅の書体には仮名が無く、数字だけが別の書体になって間が跳ぶからである。本文の書体のまま `font-variant-numeric: tabular-nums` で幅をそろえる（`.num`）。
太さは 400、500、600、700 だけを使う。Hiragino Sans は 520 や 560 を 600 に、650 や 680 を 700 に丸めて描くので、中間の値を書くと欧文だけが細くなり、和欧で太さが割れる。
ターミナルとコードブロックも同じ等幅である。
一覧の行は 2 段で 44px（`--session-row-h`）、ボタンや入力欄のような 1 段の部品は 28px（`--row-h`）、カードは 4 列、メインの最大幅は 1200px 前後で中央に寄せる。

動きの性格は「なめらか」で、すっと出て長く静かに止まる。
長さと曲線は `styles/tokens.css` のトークン（`--dur-fast` 200ms、`--dur` 420ms、`--dur-exit` 250ms、`--ease-out`、`--ease-in`、`--rise` 6px、`--blur-in` 6px、`--breathe-period` 3.2 秒）だけを通して書き、CSS にも JS にも数値を直書きしない（`styles/motion.test.ts` が見張る）。
JS からは `views/primitives/motion.ts` で読む。
reduced motion では長さと移動とぼかしのトークンが 0 になり、端末の縁の往復が止まり、View Transitions も使わない。
使う動きは次のとおりである。

- 画面遷移。入る画面は、`--rise` だけ上がりながら、ぼかしが晴れて入る。View Transitions がある環境では、出る画面と入る画面を同じ長さと曲線で重ねて替える。長さを揃えるのは、変わらないヘッダとサイドバーが途中で明滅しないためである。
- 行を開いてセッション画面へ（決めの動き）。一覧の行か Home の実行中の札を押すか Enter で開くと、その行がセッション画面の上段へ広がり、戻ると上段が縮んで元の行へ帰る。`runtime/present.ts` が画面の替わり目を View Transitions で包み、React の描画を `flushSync` で同期させる。パレットやキーボードの近道から開いたときは広げない。
- 一覧への差し込み。Projects のカードは、新しいカードがぼかしから現れ、ほかのカードは FLIP で滑って場所を空ける。
- ⌘K パレットは、ヘッダーの「探す・移動」の錠剤からガラスが広がって開き、閉じると錠剤へ戻る。開く動きは描画を遅らせない Web Animations で作り、入力欄はその描画でフォーカスを持つ。
- ダイアログは 96% から、ぼかしが晴れながら開く。通知は右下から、切断の帯は上から、ぼかしが晴れながら現れる。
- 状態点、ゲージ、TODO の線は `--dur` で色と長さを移す。状態点は変わる瞬間に 1 度だけ小さく膨らむ。
- 端末の縁は、作業中だけ `--breathe-period` で明暗を往復し、状態が変わると色が `--dur` で移る。
- ボタンはホバーで 1px 浮き、押すと 97% に縮む（`--dur-fast`）。
- 折りたたみ、分割の幅、数字の回転、新着への追従は、長さと曲線だけをトークンに揃える。

シマー、スケルトン、タイピング風の表示は使わない。
脈動は端末の縁の作業中だけに許す。
`.app` の起動画面（`apps/desktop/loading/`）は、ロゴのハンガーが竿の上を流れ続ける動きで起動を待つ。
起動に失敗したら、失敗の文の下に「もう一度試す」と「ログを開く」を出す。
「もう一度試す」は殻の `retry_boot` を呼び、殻は残っている子のサーバを止め、起動画面を読み込み直してから起動をやり直す（押したボタンは押せなくする）。
動きの計算は `loading/boot-frames.js`、描画は `loading/boot.js` が持ち、起動が 3 秒を超えたら「まだ起動しています（N 秒）」と出す。
殻はサーバの `/health` が通ったら、起動画面の周の境目（1 周期 1.6 秒）まで待ってから画面を移す。
reduced motion では静止した原図を出す。
画面の中の初回索引の進行は、静的な文字で示す。

## クラウド同期

フェーズ 4 で実装した。
実物の Cloudflare で通した記録は `docs/plans/phase4-real-run.md` にある。
ただし、無料枠の数え直し（Worker が数えて push の応答で返す形）と孤児の掃除はその後に入れたもので、偽のクラウドとローカルの workerd での試験しか通していない。

### 構成と setup

同期の基盤は利用者自身の Cloudflare アカウントに置く。
`hangar setup cloud` が wrangler の対話ログインでアカウントを選び、`packages/cloud` の Worker と D1 データベースと R2 バケットを作ってデプロイする。
資源の名前は既定で Worker と D1 が `hangar`、R2 が `hangar-files` で、`--name` で変えられる（`--name x` なら Worker と D1 が `x`、R2 が `x-files`）。
実物の設定は `~/.agent-hangar/cloud/wrangler.jsonc`（権限 0600）に書き出し、そこへ D1 の ID と R2 のバケット名を埋める。
アカウント ID はこのファイルにもコードにも書かず、wrangler を呼ぶたびに環境変数で渡す。
デプロイ直後の数秒は `workers.dev` の反映待ちで `error code: 1042` が返るので、setup は `/health` が通るまで最大 2 分試してから先へ進む。
wrangler はプロジェクトのローカル依存として同梱する。
setup の最後に **参加トークン** を表示する。
参加トークンは Worker の URL と参加用の秘密を `{url, secret}` の JSON にして base64url で包んだ文字列で、他の PC では `hangar join` でこれを渡す。
Worker は参加の要求を受けて端末ごとの端末トークン（32 バイトの乱数）を発行し、以後の要求はその端末トークンで認証する。
参加用の秘密も端末トークンも、D1 にはハッシュだけを置く。
参加用の秘密のハッシュは `wrangler secret put JOIN_SECRET_HASH` で Worker に渡し、設定ファイルには書かない。

同期は自分の端末同士のためのもので、他人と 1 つの箱を共有しない。
別の人が使うときは、その人が自分の Cloudflare アカウントで同じ `hangar setup cloud` を走らせる。
デプロイは人ごとに独立し、データは混ざらない。

Worker の D1 は、端末側の共有テーブルの形をそのまま写さない。
`changes`（変更の列）と `rows`（行の鏡）の 2 表だけを持ち、表の名前と行 ID と payload を文字列として預かる。
共有テーブルに列が増えても Worker を直さずに済むからである。
スキーマは Worker が起動後の最初の要求で整える（`ensureSchema`）。
マイグレーションの手順を別に持たず、cold start のたびに `create table if not exists` を通す形である。

手元のサーバ側の入口は、フェーズ 3 で入れた鍵付きの入口と入口の 3 つの検査（Origin、`Sec-Fetch-Site`、`Content-Type`）をそのまま通る。
同期のために足した `/api/sync/*` と `/api/devices` と `/api/sessions/:id/resume-here` も同じ関門の後ろにある。
Worker の側はブラウザから触らないので、端末トークンの照合だけを行う。

無料枠で収める。
D1 の無料枠は合計 5GB、1 データベース 500MB、書き込み 1 日 10 万行で、hangar のメタデータには十分である。
R2 の無料枠は 10GB で、gzip したトランスクリプト全体でも 750MB 前後に収まる（フェーズ 0 の実測で 1.4GB が 754MB になった）。
上限に当たったときは Workers Paid（月 5 ドル）に上げる。

実物で測った所要は次のとおりである。
`hangar setup cloud` は 16 秒で終わる（D1 の作成、R2 の作成、`wrangler deploy`、`secret put`、`/health` の待ち、`/join` まで）。
`hangar start` は同期を入れた後も 1.0 秒から 1.1 秒で、起動の最後の 1 往復で待たされない（APAC のリージョンで 1 往復が数十ミリ秒）。
`hangar cloud teardown` は 14 秒から 18 秒である（wrangler の呼び出しが 15 回で、1 回あたり 1 秒ほどである）。

### 同期対象と暗号化

同期するものは三つである。

- **hangar のメタデータ**：共有テーブルの全行。D1 に置く。
- **セッションのトランスクリプト**：`~/.claude/projects` の jsonl を gzip して R2 に置く。鍵は主線が `transcripts/<端末 ID>/<セッションの UUID>.jsonl.gz`、サブエージェントが `transcripts/<端末 ID>/<セッションの UUID>/subagents/agent-<hex>.jsonl.gz` で、端末ごとに分ける。UUID は Claude Code が付けた `provider_session_id` である。
- **Claude Code のユーザー設定**：`~/.claude/CLAUDE.md`、`settings.json`、`settings.json` の `statusLine.command` が指すスクリプト、`skills/**`、`memory/**`、`projects/*/memory/**`。R2 に置く。鍵は `config/<端末 ID>/<相対パス>` で、本文と同じく端末ごとに分ける。

hangar 自体の設定（ワークスペースルート、ターミナルアプリ）と UI の一時状態は同期しない。

本文は差分ではなく、**変わるたびにファイル全体を gzip して上げ直す**。
R2 は部分更新を持たないので、末尾だけを足す道が無いためである。
同じ中身を二度上げないために、端末ローカルの `file_sync` に前回の指紋（平文の SHA-256）と大きさと更新時刻を残す。

設定の同期で上げないものは、`node_modules` と `.git` と `__pycache__` と `.venv` の各段、シンボリックリンク、1MB を超えるファイル、`.DS_Store`、そして同期自身が作る `*.conflict-*` などの写しである。
写しを対象に戻すと、競合のファイルが端末間で無限に増える。
**削除は同期しない。**
片方で消したファイルが、もう片方から消えることはない。
ホームの絶対パスは `$HOME` ではなく `__HANGAR_HOME__` という目印に置き換えて上げ、降ろすときに各端末のホームへ戻す。
`$HOME` をそのまま使うと、ホームの綴りが違う端末で指紋が揃わない。
設定の同期は Settings で明示的に有効にしたときだけ動き、初めて取り込むときは下見の一覧を見せて確認を取る。
`~/.claude` を上書きする前には必ず `~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ 1 バイトも書かない。
控えは 20 世代を残し、古いものから消す。

R2 に置くファイルは端末間で暗号化する。
鍵は参加用の秘密から `hkdfSync('sha256', joinSecret, 'hangar-salt-v1', 'hangar-file-v1', 32)` で導き、AES-256-GCM で暗号化してから上げる。
Cloudflare 側は中身を読めない。
Worker も、`kind` が `transcript` で暗号化の申告が `1` でない `PUT` を、R2 に触る前に 400 で断る。
降ろす側だけが約束を守っていると、置く側は約束の外に出られる。
形式は、先頭に `HGR1` の 4 バイトと 8 バイトの nonce 接頭辞を置き、その後ろに 1MB ごとのチャンクを並べる。
チャンクは `flag`（1 バイト、最後のチャンクだけ 1）と `len`（4 バイト）と本体と 16 バイトの認証タグからなり、nonce は接頭辞にチャンク番号を継いで作る。
AAD にチャンク番号と `flag` を入れるので、並べ替え、複製、欠落、途中での打ち切りは、どれも認証タグで落ちる。
`len` には上限（1MB + 64 バイト）を置く。
他端末が書いた本文は外から来た入力なので、相手の申告する長さをそのまま信じて溜め込まない。
フェーズ 0 の計測では暗号化 2,700MB/s、復号 600MB/s で、同期の律速は gzip とネットワークである。
D1 のメタデータ（題名、要約、TODO、メモ）は平文で持ち、将来 Worker 側の機能に使えるようにする。

ファイルの一覧は D1 の `files` 表に持ち、パス、端末、SHA-256、サイズ、更新時刻、R2 の鍵を記録する。
降ろす側は、この指紋と実際に降りた中身の指紋を突き合わせる。
暗号化そのものは「鍵の同じ別のファイルへの差し替え」を見抜けないので、鍵と指紋の突き合わせがその守りになる。

`PUT` は R2 を先に書き、`DELETE` は索引を先に消す。
どちらも途中で倒れれば食い違いが残るが、この向きに揃えておけば残るのは索引に無い R2 の本体だけである。
逆の向きで残る「索引にあるのに本体が無い」は、降ろす側が永久に 404 を踏む。
食い違いを拾うのは `GET /files` を契機に走る掃除である。
6 時間に 1 回だけ、R2 を 50 件と索引を 50 行まで見て、索引に無い本体と、本体の無い索引の行を消し、続きの位置を `meta` に控える。
置いてから 1 時間たっていないものには触らない。
書いている最中の 1 本を消さないためである。
当番は `meta.last_sweep_at` を条件付きで書き換える 1 文で 1 本だけ取るので、同時に来た要求どうしでも走るのは 1 本である。
誰も一覧を引かない日は走らないが、孤児が増えるのも上げ下ろしをした日だけなので、取りこぼしにはならない。
掃除自身が D1 に書くのは、孤児が数件のときのローカルの workerd での実測で 1 回 7 行、1 日 4 回で 28 行である（1 日 10 万行の 0.03%）。
消す索引の行が増えれば、その分だけ増える。

### 使用量と費用

設定の「クラウド同期」に、D1 の書き込み、Workers の要求、R2 の今月の量、今月の費用、プランを出す（見た目は「設定」の節）。
Cloudflare の数と費用は、読み取り専用の API トークンを Worker の secret に置き、Worker 経由で全部の端末に配る。
トークンが無くてもアプリも同期もいままでどおり動く。

**Worker の `GET /usage`。**
端末トークンの検査（`authMiddleware`）の後ろに置く。
D1 にも R2 にも 1 行も書かない（書けば、数えている書き込みそのものが増える）。
secret は `USAGE_API_TOKEN`（Account Analytics: Read と Billing: Read だけを持つ API トークン）と `CF_ACCOUNT_ID` で、どちらかが無ければ `{ configured: false }` を 200 で返し、Cloudflare へは問い合わせない。
あれば三つに問い合わせて一つにまとめる。
今日の D1 の書き込みと Workers の要求は GraphQL（`d1AnalyticsAdaptiveGroups` と `workersInvocationsAdaptive`、日は UTC）、プランは `GET /accounts/{id}/subscriptions`、今月の費用と量は `GET /accounts/{id}/billable-usage` である。
三つは独立に取り、一つが落ちても残りは返す。
落ちた部分は `null` にして `errors` に 1 行の理由を載せ、API の生の応答やトークンは載せない。
トークンが失効したとき（401、403）は三つとも `null` にして入れ直しを案内する。
写しは isolate のメモリに持つ（今日は 5 分、プランと今月は 6 時間）。
Cloudflare の文書は workers.dev での Cache API について記載がない（2026-10-02 に確かめた）ので、メモリの写しで足りるとして使わない。

**端末のサーバ。**
`CloudUsagePoller`（`packages/server/src/sync/usage.ts`）が、同期を設定している端末で 5 分ごとと設定画面を開いたときに `GET /usage` を取りに行く。
一時停止の間は取りに行かない。
一時停止は「外と話すのをやめる」ことで、無料枠で止まったときも同じだからである。
止まっている間は最後に取れた値を出す。
要求は `countingClient` を通し、`QuotaCounter` に要求 1 回、行 0 として数える（1 台あたり 1 日 288 回で、Workers の枠の 0.3%）。
古い Worker（404）と `configured: false` は「トークンなし」として扱い、数は hangar の見積もり（`QuotaCounter`）に切り替える。
取れなかったとき（通信の失敗、5xx）は、最後の値を残して `stale` を立てる。
同期を止めず、トーストも出さない。
配る形は `CloudUsageDto` で、HTTP は `GET /api/sync/usage`（`?refresh=1` で取り直す）、websocket は `sync.usage`、bootstrap は `cloudUsage` である。
上限は共有の定数 `CLOUD_FREE_LIMITS`（`packages/shared`）に置き、D1 と Workers の日の枠は `QUOTA_LIMITS` と同じ値を指す。

**止めた理由。**
`SyncStatusDto` に `pausedReason`（`quota`、`user`、`null`）と `quotaPausedDay`（`QuotaCounter` が止めた UTC の日）を足した。
`guardQuota` が止めるときは `quota`、UI と CLI から止めるときは `user` を書き、再開で消す。
古いサーバの状態（`paused` だけがある）は `user` として読む。
ヘッダーはこれで、無料枠で止まったことと、枠が戻った後であることを言い分ける。
見張り（80% で止める判断）は、いまも hangar の見積もりで動く。
Cloudflare の数への切り替えは、表示で差を確かめてから別に決める。

**トークンを入れる。**
`npm run hangar -- setup cloud --usage-token` が `installUsageToken`（`packages/cli/src/cloud.ts`）を走らせる。
トークンは標準入力から読み（端末なら伏せ字、パイプなら 1 行）、argv には載せない。
入れる前に `tokens/verify` と subscriptions と GraphQL を 1 回ずつ叩いて有効さと二つの権限を確かめ、足りなければ足りない権限の名前を出して止める。
確かめたら `wrangler secret put` で `USAGE_API_TOKEN` と `CF_ACCOUNT_ID` を入れる。
普段の `setup cloud` の最後にも、標準入力が端末のときだけ「使用量のトークンを入れますか（後からでも可）」と尋ねる。
入れられるのは setup を実行した端末（`cloud.json` に `accountId` と `workerName` がある）だけで、参加しただけの端末では setup した端末で入れるよう案内して止める。
外すときは `wrangler secret delete USAGE_API_TOKEN` を手で打つ。

### タイミングと競合

メタデータは、ローカルで変更した 1 秒後に `changes` の未送信分をまとめて push する。
ただし push には最小間隔 10 秒があり、実行中のセッション 1 本で 2 秒ごとに送り続けることはしない。
1 回の push は 40 行まで、1 回の pull は 500 行までである。
pull は起動時、ウィンドウが前面に来たとき、30 秒ごと、セッション起動の直前（2 秒で諦める）に行う。
Worker は受け取った変更を `changes` に積み、`rows` の鏡を更新して、サーバ側の連番を付ける。
pull は連番以降の変更を返す。
競合は行単位で `updated_at` の新しい方を採用する。

`GET /changes` は自分の端末が起こした変更を除いて返す。
自分で送った行をそのまま受け取っても、適用しても何も変わらないうえ、読む量だけが倍になるからである。
一方 `GET /rows`（全件の取り直し）は除かない。
これは参加した直後や取りこぼした後に、現在の全行を手に入れるための道なので、自端末の行も要る。

積みっぱなしにしないための刈り込みが 2 つある。
端末ローカルの `changes` は、push 済みで 7 日を過ぎた行を消す。
Worker の `changes` は、受信から 14 日を過ぎ、かつ接続した全端末が読み終えた連番までを消す。
消した区間の上端は `meta.changes_floor` に残し、`GET /changes?since=` がそれより前を求めてきたら `410` と `{ error: 'gone', floor }` を返して、全件の取り直しを求める。
これが無いと、長く止めていた端末が変更を黙って取りこぼす。

無料枠の 80% に達したら、同期を自動で一時停止してトーストで知らせる。
課金される形にはしない。
数えるのは Worker が D1 へ書いた行数（索引への書き込みを含む）と、こちらが出した要求の回数で、どちらも 1 日 10 万が枠である。
行数を数えるのは Worker の側である。
書き込みのある経路をすべて 1 つの関数に通し、D1 が返す `rows_written` を `meta` の `d1_rows:<yyyy-MM-dd>`（UTC で区切る）に積んで、`POST /changes` の応答に `d1RowsToday` として返す。
端末はこの値を正として使い、アカウント全体の数なので端末の数では割らない。
報告を受け取った後に自分で書いた分（ファイルの出し入れと pull）は、次の報告が来るまで端末側の見積もりで足す。
報告を返さない古い Worker が相手のときだけ、見積もりを端末の数で割った水準で見る。
要求の回数は Worker が数えないので、こちらは端末の数で割ったままである。
止めるのは 1 日に 1 度だけにする。
毎回止めると、利用者が「再開」を押した直後にまた止まり、その日いっぱい押せないボタンになる。

トランスクリプトは、jsonl の変化を検知して 30 秒のデバウンスでファイル全体を上げ直し、run の終了で確定する。

上げるのは、クラウドを使い始めた後に動いた本文だけである。
参加より前に索引が済んで止まっている本文は上げない。
利用者は先に hangar を使い、後からクラウドを足すので、参加の時点で手元に何百件もの本文が溜まっている。
実測では 1,060 件で生の合計 1.6GB あり、これを全部押し込む意味は薄いと判断した。
メタデータ（セッションの一覧、要約、プロジェクト、TODO、メモ）はこの区切りを見ない。
そちらは今までどおり全部同期するので、他端末からも一覧と検索の結果は揃う。

区切りの時刻は `sync_state` の `transcriptsFrom` に置く。
刻むのは `hangar setup cloud` と `hangar join` で、`cloud.json` を書くのと同じ時点である（`sync/transcriptsFrom.ts` の `stampTranscriptsFrom`）。
「使い始めた時刻」の出どころは、クラウドの設定を作った時点そのものだからである。
サーバの起動まで待つと、区切りを刻まない古いサーバが先に走る隙ができる。
実物でそれが起きた。
配布版の `.app` が区切りの入る前のサーバを同梱していて、そちらが先に起動して `lastSeq` と `filesSeq` を書いた。
後から起動した新しいサーバは、その進み具合を見て「既に同期していた端末だ」と読み違え、区切りを 0 にした。
上げないと決めた過去の本文が 105 件、148 MB 上がった。
そのため、同期の進み具合から参加の有無を推し量る判定はやめた。
古いサーバが先に走ったという理由で区切りが消えてはいけない。

サーバ側の刻みは保険として残す。
効くのは、区切りの無い `cloud.json` を持つ端末（CLI が刻むようになる前に参加した端末）だけである。
使う値は `cloud.json` の `joinedAt` で、それを読めない古い設定のときだけ今の時刻にする。
`joinedAt` は参加し直しと秘密の作り直しで今の時刻へ書き換わるが、読むのは区切りが 1 つも無いときだけなので、書き換わった値が入るのは「CLI が刻むようになる前の設定で参加し直した端末」に限られる。
その端末では、参加し直した時点が新しい区切りになる。
区切りは一度刻んだら動かさないので、それ以降は後ろへ動かない。
行が無いときも 0 として読むので、刻む前の端末の振る舞いは変わらない。

いまの区切りは `hangar cloud status` が 1 行で見せる。
区切りが 0 のときは「手元の本文を全部上げます」と出す。
利用者が区切りの正しさを確かめられないと、上がらない理由も上がりすぎた理由も追えない。

取り残しの走査と、画面に出す「未送信の本文」の件数は、どちらもこの区切りを条件に持つ。
数の側に入れないと、上げる予定の無い本文が何百件も画面に並び続ける。
参加より前の本文を上げたくなったら、そのセッションを再開すればよい。
ファイルが伸びるので索引が変化を見て、いつもの経路で上がる。
まとめて上げ直すときは `hangar cloud backfill` で区切りを 0 に落とす。
走査は区切りを 1 回ごとに読み直すので、サーバを立て直さなくても次の走査から効く。

他端末の新着は pull で全部取り込み、`~/.agent-hangar/remote/<端末 ID>/`（0700、ファイルは 0600）に置いて手元で索引化する。
これで検索は全端末で揃う。
降ろせないファイルが 1 つあっても後ろが止まらないように、同じ項目で 3 回続けて失敗したら飛ばして先へ進む。
飛ばした項目は `sync_state` に残し、中身が入れ替わったとき、サーバを起こし直したとき、30 分ごとの 3 つの機会で試し直す。
飛ばした件数と、まだ上げていない本文の件数はヘッダーに出し、鍵と理由と試した回数は Settings のクラウド同期の節に並べる。

Claude Code の設定は、変化を検知して 5 秒のデバウンスで push し、加えて 60 秒ごとに変わったものを送る。
`fs.watch` の recursive は macOS と Windows にしか無いので、定期の走査を併せ持つ。
起動のたびに 1 度、全体を走査してから上げる（指紋が同じものは上がらない）。
これが無いと、同期を入れて起こし直しても `~/.claude` に触るまで 1 件も上がらない。
両端末で同じファイルを変えていたら新しい方を採用し、古い方を `<name>.conflict-<端末名>-<時刻>` として隣に残して通知する。
実物では、片方の書き換えが相手に降りるまで 10 秒から 30 秒だった。

プロジェクトのメモ（`project_memos`）とセッションのメモ（`sessions.memo`）は、行の競合では新しい方を採る規則をそのまま使う。
ただし負けた方の本文を捨てない。
プロジェクトのメモは `memo.conflict-<端末名>-<時刻>.md` として隣に残し、セッションのメモは `~/.agent-hangar/backups/memos/session-<セッション ID>-<時刻>.md` に残す。
どちらも、控えが書けなかったらその行を適用しない。
上書きを進めると、利用者が手で書いた文章が黙って消えるからである。

オフラインのときは `changes` に積んだままにし、復帰時に順に送る。
ヘッダーの同期状態には最終同期時刻、未送信件数、エラーを出し、「今すぐ同期」と「一時停止」を置く。
D1 の Time Travel（無料枠で 7 日）で巻き戻せる。

### 他端末セッションのロックと「この PC で再開」

他端末のセッションは、閲覧と検索は常にできる。
「この PC で再開」は明示操作で、その端末の最新の本文を `~/.claude/projects/<変換名>/<sessionId>.jsonl` にコピーしてから `claude -r` を実行する。

他端末に生きた run（`ended_at` が null で `deleted_at` が null）があるセッションは、**heartbeat の新旧にかかわらず**ロックされているとみなす。
heartbeat が 2 分（`LOCK_STALE_MS`）より古いときは、ロックを解かずに `stale` の印を立てる。
古い heartbeat でロックを解いてしまうと、相手がまだ走っているのに手元から再開できてしまうからである。
UI は `stale` でないとき「<端末名> で実行中」、`stale` のとき「<端末名> が応答がありません」と表示する。
ロックされている間は再開とフォークを止める。
`stale` のときだけは「この PC で再開」を押せるようにする。
相手が落ちて heartbeat だけが残った状態を、行き止まりにしないためである。
heartbeat は 30 秒ごとの push で更新する。

「この PC で再開」は、手元に同じセッションの本文があり、それが降ろす本文より**小さいときだけ**確認を出す。
承諾したら、上書きの前に `~/.agent-hangar/backups/transcripts/<sessionId>-<時刻>.jsonl` へ控えを取る。
控えが取れなければ `~/.claude` を触らずに戻る。
手元の方が大きいか同じときは、黙って上書きしない。

**引き継ぎは実装していない。**
2026-09-19 の判断で、ロックの表示と「この PC で再開」までに絞り、`takeover_requests` を使った握手は後のフェーズへ送った。
2 台で使う実感が無いまま、同期の中でいちばん複雑な部分を作らないためである。
`takeover_requests` の表と `Intent` の `session.takeover` は残っているが、誰も書かず誰も出さない。
`EndReason` に `taken_over` は足していない。
引き継ぎが無いので、他端末の run はこちらの操作では止まらない。
「この PC で再開」は本文を降ろして手元で新しい run を立てるだけなので、同じセッションの本文が 2 か所で伸びうる。
この枝分かれは受け入れる。

他端末の本文を索引化するときは、共有テーブルの `sessions` と `session_summaries` には書かず、端末ローカルの表（`transcript_files`、`event_index`、`event_fts`）だけを書く。
同じセッションの同じ位置につき索引化するファイルは常に 1 つで、手元の本文があればそれを優先し、無ければ更新時刻が最新の写しを 1 つだけ採る。
本文が 2 か所で伸びても、見た目が二重にならないようにするためである。

## 配布と運用

リポジトリは public で、MIT ライセンスで公開している（`LICENSE`、著作権者は `gaku1023`）。
GitHub Actions で型検査とテストを回し、タグを打つと macOS 用の `.app` をビルドして Releases に置く。
`.app` は署名せず、zip と SHA-256 の checksum を添える。
利用者はそれをダウンロードして `/Applications` へ移し、検疫属性を `xattr -rd com.apple.quarantine` で外すか、システム設定の「このまま開く」で許可してから、`hangar setup` を走らせる。
移動を先に置くのは、検疫属性が付いたまま開くとアプリの案内より先に Gatekeeper のダイアログが出るからである（2026-09-20 の実測）。
クラウド同期の設定は `.app` の同梱 CLI からは行えない。
wrangler を同梱していないので、リポジトリを clone した場所から `setup cloud` を走らせる。

`hangar setup` は次を行う。

1. `~/.agent-hangar/` を作り、端末 ID とローカルトークンを生成する。
2. tmux、claude、code、iTerm2 の有無を確認して報告する。
3. ワークスペースルートを確認し、初回のプロジェクト自動登録を行う。
4. statusline スクリプトへの追記を提案し、承諾されたら追記する。
5. `hangar mcp install` を提案する。

## フェーズ

- **フェーズ 0**：危ない前提を捨てられる小さなスクリプトで検証する。計画は `docs/plans/phase0-spikes.md`。
- **フェーズ 1**：サーバ、インデクサ、読み取り専用の UI。Projects、セッション一覧、トランスクリプト、Sessions（検索）、土台の要約。計画は `docs/plans/phase1-readonly.md`。
- **フェーズ 2**：tmux での起動、ターミナルの埋め込み、セッション内タブ、MCP、指示の注入、iTerm2 と VS Code の連携、セッション自身による要約。計画は `docs/plans/phase2-launch.md`。
- **フェーズ 3**：使用量、アーティファクト、TODO とメモ、スクラッチと昇格、タブと分割、事後要約、パレットとショートカット。併せて、鍵付きの入口と入口の 3 つの検査（Origin、`Sec-Fetch-Site`、`Content-Type`）を入れた。計画は `docs/plans/phase3-workbench.md`。
- **フェーズ 4**：クラウド同期。Worker と D1 と R2 の setup、メタデータと本文と Claude Code 設定の同期、無料枠の見張り、他端末のロックと「この PC で再開」まで実装した。引き継ぎの握手は作らず、後のフェーズへ送った。計画は `docs/plans/phase4-sync.md`、実物での確認は `docs/plans/phase4-real-run.md`。
- **フェーズ 5**：デスクトップ配布。Tauri v2 のシェル、サーバの同梱と子プロセスとしての起動、Node の探索、`hangar://` のディープリンク、タグから `.app` を作る Releases のワークフローまで実装した。署名と公証は行わない。計画は `docs/plans/phase5-desktop.md`。

## 会話の保持期間

Claude Code は、保持期間（`cleanupPeriodDays`、既定は 30 日）を過ぎた本文を、セッションを始めたあとの掃除で通知なしに消す。消えた本文は hangar でも読めなくなる。
設計は `docs/superpowers/specs/2026-10-01-retention-notice-design.md` にある。要点は次のとおりである。

- サーバは組織の設定（macOS は `/Library/Application Support/ClaudeCode/`）とユーザー設定を読み、効いている日数と、それがどこで決まったかを配る。プロジェクトの設定と `--settings` は読まない。
- 本文の使用量（`~/.claude/projects` の合計と、直近 30 日の増え方）は起動の 30 秒後と 1 時間ごとに測る。見込みは増え方を日数で掛けた概算である。
- 書き込みは下見の指紋を添えた `PUT /api/retention` だけが行う。文字列の上で 1 か所だけを書き換え、読み直して他のキーが変わっていないことを確かめる。組織の設定があるとき、UTF-8 として読めないとき、書式を読み取れないときは書かない。
- 設定の同期の取り込みは、降ろした後に手元の状態を判断し直す。通信の最中に書かれた保持期間を巻き戻さない。
- 索引器は、手元の本文ファイルが消えた行を片付ける（DB の行だけで、ファイルには触れない）。`projects` そのものが見えないときは片付けない。

## 決めた前提と未決事項

インタビューで問わず、筆者が埋めた前提を列挙する。
異論があれば、この文書を直してから実装を変える。

- ポートは 4177 固定。データディレクトリは `~/.agent-hangar/`。
- ID は UUID v7。マイグレーションは番号付き SQL をアプリ起動時に適用する。版は 8 まで進んでいる（4 で `usage_daily` の鍵に `file_path` を足して `artifact_versions(artifact_id)` の索引を置き、5 で `session_summaries` に `source_id` を足し、6 で `usage_daily` を空にして `transcript_files.indexer_version` を 0 に戻し、7 で `mcp_secrets` を作り、8 で `transcript_files` に `device_id` と索引を足して `file_sync` を作った）。版 6 は、`file_path` を持たない古い行をどちらに寄せても作り直しの消し方が正しくならないための積み直しである。全ファイルが索引の作り直しに回るので、実物の DB では約 35 秒かかり、その間だけ日別の使用量が欠ける。版 8 の `device_id` は既存の行では null のままにする。端末の ID は DB ではなく `device.json` にあり、マイグレーションからは読めないためである。
- FTS5 のトークナイザは trigram。
- R2 の鍵は端末 ID を含み、同じセッション ID の本文が端末ごとに分岐しても上書きしない。
- Claude 側で利用者が付けた名前（`nameSource` が `user`）は、hangar が保持する名前より優先する。
- `history.jsonl` にあって本文ファイルが見つからないセッションは、一覧に「本文なし」として出す。
- 初回索引は背景で走らせ、UI は「N / 総数 件」の静的な文字で進行を示す。
- Provider の第二弾は OpenCode で、`~/.local/share/opencode/opencode.db` を読む。Codex は CLI が無いため対象にしない。
- 意味検索は持たないが、LM Studio に埋め込みモデルがあるので、将来ローカルで追加できる。
- `event_index` の一意制約は `(session_id, ifnull(parent_agent, ''), seq)`。サブエージェントの本文は別ファイルで独立に伸びるので、主線と `seq` の空間を分ける。
- 端末ローカルのテーブル `session_stats` を持つ。ターン数、モデル、effort、変更ファイル数、PR の URL、トークン数、最後の発言を索引から導出して置き、共有しない。
- 土台の要約の `state` は、レジストリに生きた項目があれば `in_progress`、無ければ `done`。UI は `source = 'baseline'` の状態を控えめに描く。
- サブエージェントは、そのファイルの先頭の記録から `subagent` イベントを作り、親の時系列でその直前にある `Agent` か `Task` のツール呼び出しの下にネストする。該当が無ければ独立した項目として出す。
- セッションの表示名は、レジストリの `name`（`nameSource` が `user`）、本文の `custom-title`、`agent-name`、`ai-title`、最初の発言の先頭 40 字の順で決める。
- 開発時は Vite（ポート 5173）が `/api` と `/ws` をサーバへプロキシし、プロキシがトークンを `Authorization` ヘッダに付ける。この経路は `HANGAR_DEV=1` のときだけ通る。本番はサーバが `packages/ui/dist` を配信し、鍵付きの入口で開かれたときだけ `index.html` の応答で `hangar_token` クッキー（HttpOnly、SameSite=Strict）を渡す。
- 一覧の初期データは `GET /api/bootstrap` で全セッションの軽い行をまとめて返す。手元の規模（数百セッション）では 1MB 未満で、ページングは持たない。
- UI のテストのうち `src/views/**`、`src/intent/**`、`src/Root.test.tsx` は jsdom で走らせる。Vitest の入れ子プロジェクトで環境ごとに分ける。
- ダークモードは持たない（2026-09-17 の決定）。OS のダーク設定にも従わない。ターミナルの面だけが例外である。
- タブ 0（Claude）の ID は run の ID そのもので、`run_tabs` に行は作らない。シェルタブの ID は `run_tabs.id` である。
- tmux のセッション名は run が `hangar-<shortId(runId)>`、シェルタブが `hangar-<runShort>-t<n>` で、`<n>` は閉じたものを含むタブ数に 1 を足す。閉じた番号は再利用しない。
- tmux の target は必ず `=<name>` の完全一致で指定する。素の名前は前方一致に落ちるので、`hangar-X` が消えているとそのシェルタブ `hangar-X-t1` に当たる。
- `tmux` の呼び出しに失敗したときは「セッションが無い」ではなく「観測できなかった」として扱い、生きた run を閉じない。`tmux` が一瞬入れ替わるだけで、動いている run が全部終了扱いになるためである。
- `claude` の起動に失敗し、本文ファイルも索引の行も無く、他に run も無いセッションの行は消す。残すと再開もフォークもできない空の行が一覧の先頭に溜まる。
- 対話セッションで user スコープの `hangar` と `--mcp-config` の `hangar` が同時に読まれても、Claude Code は名前で併合するので `/mcp` には 1 つだけ出る（2026-09-18 に実機で確認）。
- PTY の中継は `/ws/pty?tab=<tabId>` で、`/ws` と同じ認証を通す。WebSocket が閉じたら `tmux attach` のクライアントだけを殺し、tmux セッションは残す。
- 起動ダイアログの model、effort、permission mode、worktree、追加ディレクトリは空欄を既定にし、空欄の項目は起動引数に含めない。

以下はフェーズ 3 の実装で決めた前提である。

- 使用量の保存：statusline の payload は `usage_snapshots(at, payload)` に生の JSON で積み、直近 500 件だけ残す。5 時間と 7 日の値は `UsageTracker` がメモリに持ち、サーバ起動時に新しい順へ走査して両方の窓が埋まるまで読む。`rate_limits` の無い payload では直前の値を保ち、`updatedAt` も更新しない（ゲージの「最終更新」は使用率が届いた時刻を指す）。
- セッションごとの付帯情報：payload の `model`、`effort`、`context_window`、`cost` は端末ローカルの `session_live_stats` に Claude の UUID（`provider_session_id`）を鍵として置く。`SessionDto.stats` の `model` と `effort` はこの表を `session_stats` より優先し、この表に無ければ索引から導いた `session_stats` の値を使う。`contextPercent` と `costUsd` は `session_live_stats` にしか供給源が無く、statusline の追記を入れていないセッションでは常に null になる（UI は「未取得」と出す）。`contextPercent` は `current_usage` の入力とキャッシュのトークンの和を `context_window_size` で割った百分率で、`current_usage` が無い 1 回目は書かない。`costUsd` は `cost.total_cost_usd`。
- statusline の追記先：`~/.claude/settings.json` の `statusLine.command` から先頭の `bash `、`sh `、`zsh ` を除いた最初の語を `~` 展開し、ファイルとして存在すればそこへ追記する。存在しなければ追記せず、スニペットと手順を印字する。追記位置は 1 行目が `#!` で始まればその直後、そうでなければ先頭で、目印の行があって中身も今の形と同じなら何もしない。バックアップは同じディレクトリの `<name>.bak-<yyyymmddHHMMSS>`。
- statusline のスニペットは、`${HANGAR_HOME:-$HOME/.agent-hangar}/statusline-header` を `curl -H @<ファイル>` で読む。ファイルには `Authorization: Bearer <トークン>` の 1 行が入り、権限は 0600 である。読めないときは何も送らずに素通しする（`if [ -r ... ]` で包む）。ポートは追記時の値を埋め込む（`hangar statusline install --port <n>`）。`exec <<<` を使うので、追記先のスクリプトは bash か zsh である必要がある。
- ヘッダのファイルを用意する場所：`hangar statusline install` と、サーバの起動時の両方で用意する。起動時はトークンを読むのと同じところで、無ければ作り、トークンと食い違えば書き直し、他人に読める権限なら 0600 へ狭める。中身も権限も揃っているときは触らない（毎回書き直すと mtime だけが動く）。install のときにしか置かないと、`~/.agent-hangar` を消した利用者の使用量が、何のエラーも出ないまま止まる。
- 入っているスニペットの差し替え：目印の行があるだけでは何もしないとせず、目印から `exec <<<"$__hangar_input"` までの範囲を読み取り、今の形と違えばその範囲だけを差し替える。トークンを argv に載せる古い形が残り続けないようにするためである。目印はあるのに終わりの行が見つからないときは、手で書き換えられているとみなして何もしない。
- jsonl の使用量の集計：端末ローカルの `usage_daily(session_id, day, file_path, input_tokens, output_tokens)` を索引化のときに埋める。鍵は（`session_id`、`file_path`、`day`）で、索引の作り直しではそのファイルのぶんだけを消してから積み直す。主線とサブエージェントは別のファイルなので、片方を積み直しても他方の集計は残る。`day` はイベントの `timestamp` をローカル時刻で `YYYY-MM-DD` にしたもの。プロジェクト別は `session_stats` のトークン数を `sessions.project_id` で束ねる。推定コストは価格表を持たず、statusline の `cost.total_cost_usd` を持つセッションの和だけを出す（1 件も無ければ null）。
- アーティファクトの抽出：`Artifact` ツールの呼び出しを `artifact_calls(tool_id, session_id, file_path, description, favicon)` に控え、結果の本文から URL を取り出せたときだけ公開とみなす。記録するのは `action` が無いか `publish` のときだけで、`read` や `list` は公開ではない。`artifacts` は URL で 1 件にまとめ、`first_published_at` は最小、`last_published_at` は最大を保ち、説明と favicon は新しい公開の値で上書きする。
- アーティファクトの版：`artifact_versions` は（`artifact_id`、`session_id`、`published_at`）が同じ行が既にあれば追加しない。索引の作り直しでは版を消さず、同じ行を書き直すだけにする。消すとサブエージェント由来の版が巻き添えになり、`changes` にも削除が残らないためである。版はアーティファクト単位で引くので、`artifact_versions(artifact_id)` に索引を置く。
- アーティファクトの題名：表示のたびに計算せず、公開を記録するときに決めて `artifacts.title` に書く。元ファイルがあれば先頭 64KB の `<title>`、無ければ説明文の先頭 60 字を使う。手で足した URL は題名 null で、UI は URL の末尾を出す。
- TODO の並び：`position` は追加のたびにそのプロジェクトの最大値に 1 を足す。並び替えの操作は持たず、完了した項目も同じ並びに打消し線を引いて残す。削除は論理削除。`todos.session_id` はセッション別 MCP URL の `update_project` から足したときだけ入る。
- TODO の完了の候補：`todos` に `candidate_at`、`candidate_session_id`、`candidate_note`、`rejected_sessions`（却下したセッション ID の JSON 配列、既定は `'[]'`）の 4 列を足した（マイグレーション version 10）。`candidate_at` が null でなければ候補で、候補は必ず未完である。MCP からは完了にできず、完了にするのは `POST /api/todos/:id/confirm` と、利用者のチェック操作である `PATCH /api/todos/:id` の `done` だけである。却下したセッションの ID は `rejected_sessions` に積み、そのセッションからは同じ TODO の候補を出し直せない（別のセッションなら出せる）。セッション別でない URL から出した候補は、却下してもセッション ID が無いので積まれず、出し直せる。`setTodoDone` は完了にも未完にも戻すときにも候補の列を消し、`rejected_sessions` は完了を開き直しても消さない。同期は行を JSON の payload のまま運ぶので D1 にマイグレーションは要らず、列を持たない古い端末は適用のときに自分の表に無い列を捨てる。`done = 1` かつ `candidate_at` 非 null の行が届いたときは、読むときに完了として扱い、候補は無いものとする。
- メモの正：`project_memos.markdown` とファイル `~/.agent-hangar/projects/<projectId>/memo.md` の両方に書く。読むときはファイルの mtime が DB の `updated_at` より新しく中身が違えばファイルを正として DB を直す。`~/.agent-hangar/projects/` を `fs.watch`（再帰）で見て、300 ミリ秒のデバウンスで取り込んで `memo.update` を配る。`memoHead` は空行でない最初の行の先頭 80 字で、全文は `GET /api/projects/:id/memo` で読む。DB を正として書き戻すときは、ファイルの中身が DB と違うときだけ、消える本文を `memo.md.bak-<yyyymmddHHMMSS>` として同じディレクトリに残してから書き戻す。同じ秒に 2 度来たら連番を足し、既にある控えは上書きしない。控えは古くなっても消さない。控えを残せなかったときは書き戻さず、ファイルの方を残す。
- スクラッチの擬似プロジェクト：端末ごとに 1 つで、名前は「スクラッチ」、この端末の `project_roots.path` は `~/.agent-hangar/scratch`。ディレクトリ名は `<yyyymmdd-HHmmss>`（ローカル時刻、同じ秒に 2 つ作るときは `-2`、`-3`）。Projects 画面と Home のカードにはこの行を出さず、Sessions 画面の絞り込みには出す。
- スクラッチかどうかの判定は、スクラッチのルートの下にあるかで行い、ルート自身は含めない。`scratch_root` は `project_roots` を端末で絞って引く。
- 昇格：`POST /api/sessions/:id/promote { name, gitInit, moveFiles }`。`name` は `/` を含まない 1 字以上で、`<workspaceRoot>/<name>` が既にあれば 409。移動は先に全件の衝突を調べてから `fs.renameSync` で行い、途中で失敗したら逆順に戻す。`moveFiles` が真でも run が生きていれば移動せず、`moved: false` と理由を返す。
- `SessionDto.fromScratch`：cwd がスクラッチのルートの下で、属するプロジェクトがスクラッチでないときに真にする。セッション画面は真のとき「再開すると cwd はスクラッチのままです」を添える。
- 分割の持ち方：`SessionViewState` に `split: boolean` と `splitTab: string | null` を持つ。左は選択中のタブ、右は `splitTab` で、幅は `SplitPane` の中の状態にして保存しない（0.5 に戻る）。分割の右に置いたタブが閉じたら `splitTab` を null にし、`split` も偽に戻す。
- 分割にタブが 2 つ要ることの判定は、Mediator がストアを見ないので、`split.resolve` の効果を受けたランタイムが決めて `split.resolved` で返す。Mediator は返ってきた結果で状態を変えるか、トースト「分割にはタブが 2 つ必要です」を出すかを選ぶ。
- パレットの項目の ID：セッション（`session:<id>`）、プロジェクト（`project:<id>`）、移動（`go:home`、`go:projects`、`go:sessions`）、コマンド（`cmd:settings`、`cmd:next-waiting`、`cmd:sidebar`、`cmd:shortcuts`、`cmd:new-session`、`cmd:new-scratch`、`cmd:rebuild-index`）、全文検索（`search:<語>`）。新しいセッションは、Mediator がストアを見ないので、presenter が最初に選ぶものを ID の後ろに載せる（`cmd:new-session:project:<id>` か `cmd:new-session:scratch`）。照合は部分列一致で、一致位置が前で連続しているほど高い点を付け、群の中は点の高い順（同点は最後の活動の新しい順）に並べる。群の分け方と上限は「骨格」の節に書いた。入力欄の文字は Root の `useState` が持ち、Mediator には入れない。
- 要約器の設定：`SettingsDto` に `lmStudioUrl`（既定 `http://127.0.0.1:1234`）、`lmStudioModel`（既定 null で、null なら `/v1/models` の最初のモデル）、`summaryFallback`（既定 true）、`summaryHourlyCap`（既定 20）、`allowExternalSummarizer`（既定 false）を持つ。
- 要約の入力：主線の全イベントを読み（サブエージェントは含めない）、`user` は 2,000 字、`assistant` は 600 字、`tool_call` は 1 行に切り、`thinking`、`tool_result`、`system`、`meta` は捨てる。全体が 12,000 字を超えたら先頭 30% と末尾 30% を残し、中盤を「[... N 件を省略 ...]」に置き換える。
- 要約ジョブの契機：run の終了と、セッション画面を開いたときの先頭ページの読み込みの 2 つで `enqueue` する。受け付けるのは要約が土台のままか最後の更新から 5 ターン以上進んだときだけで、実行中のセッションは受け付けない（セッション自身の `set_session_summary` に任せる）。run の終了からの `enqueue` は `ignoreLive` で生存判定だけを飛ばし、残る 2 つの判定は通す。「要約を作り直す」は条件を無視する。ジョブは 1 セッション 1 件で、直列に走る。
- 要約の配信が失敗しても待ち行列は進める。配信の失敗は 1 行だけ記録し、次のジョブを止めない。
- Claude への切り替えの上限：呼び出しの時刻をメモリに持ち、直近 1 時間の件数が上限に達していれば使わない。週の枠の使用率が 80 以上でも使わず、`claude` が PATH に無ければ使わない。サーバを再起動すると件数は 0 に戻る。
- MCP の `update_project` の TODO の書き込みは、全部成功か全部失敗のどちらかにする。途中で失敗したものが残ったままイベントだけ配られないようにするためである。
- `GET /api/bootstrap` は `usage`、`todos`（全プロジェクトの未削除）、`artifacts`（全件）、`summaryPending`（作成中のセッション ID）も返す。メモの全文は含めない。
- UI の CSS は `base.css` に足さず、View ごとのファイル（`workbench.css`、`split.css`、`rows.css`、`palette.css`、`settings.css`）に分けて `main.tsx` から `base.css` の後に読み込む。
- 要約の出所：`session_summaries.source_id` に書いた要約器の id（`lmstudio` か `claude-headless`）、`source_model` にモデルの名前だけを置く。土台の要約とセッション自身の要約はどちらも null にする。`source_id` が無かった頃の行は null のままにして、UI は要約器を「不明」と出す。モデル名から種類を推し量って焼き付けることはしない。
- サーバの終了：`close()` は HTTP と WebSocket を畳んだ後、走っている要約のジョブが終わるまで最大 5 秒待ってから DB を閉じる。要約は DB に書き込むので、待たずに閉じると閉じた DB に触れることになる。5 秒で終わらなければ 1 行記録して待たずに閉じる。
- 未分類のセッション：起動した後に、どのルートの配下にもない cwd のセッションが現れたら、そのセッションにつき 1 度だけトーストで知らせる。本文が伸びるたびに同じ知らせは出さない。起動時の初回の全走査では知らせない（既存の紐づけがまだ済んでおらず、数も多いため）。ここで勝手にプロジェクトを作ることはしない。
- ルートの復帰：消えていたディレクトリが戻ってルートが解決に戻ったら、その時点で未分類だったセッションを紐づけ直し、紐づいたセッションの `session.upsert` と、戻ったぶんおよび中身が変わったぶんの `project.upsert` を配る。戻ったルートが 1 つも無いときは何もしない（起動時の 1 回目はたいていこちらを通る）。
- 外部のターミナルで開くときの shell：`.command` の経路と iTerm2 の経路で同じ 1 行（`cd <dir> && exec "${SHELL:-/bin/zsh}" -l`）を使う。別々に書くと、同じ操作なのに経路で違う shell が立つ。`$SHELL` が無い環境では `/bin/zsh` に落とす。
- トランスクリプトの仮想スクロール：一覧の `VirtualList` は広げず、`Transcript.tsx` に専用の窓を持つ。行の高さは描いた後の `offsetHeight` を `seq` ごとに覚え、まだ描いていない行は文字数からの見積もりで置く。窓の上下には 600px を余分に描く。「追う」の間は、窓をスクロール位置ではなく末尾に留める。DOM に載る行の数は件数によらない（jsdom で高さ 600px の器に入れると、500 行でも 5,000 行でも末尾で 22 行、途中で 33 行）。
- 遡ったときの位置合わせ：「追う」をやめている間は、器の上端に掛かっている行の `seq` と、その行の上端からのずれを目印として持つ。見積もりで置いた行の高さを測り直したときと、「古い行を読み込む」で前に行が入ったときは、目印の行の上端を今分かっている高さで出し直し、ずれを足した位置へ器を戻す。目印を持たずに `scrollTop` だけで合わせると、前に入った行のぶんだけ見ていた場所が飛ぶ。`scrollTop` を書き換えても `scroll` は同じ間に届かないので、動かしたときはその場で窓を測り直す。
- `follow` は永続化しない：`SessionViewState` の保存の形から `follow` を落とし、読み戻すときにも落として既定の真に戻す。上へ一度スクロールしただけで `follow: false` が焼き付き、次からそのセッションが最古の側で開くのを避ける。
- 要約の帯の「詳細」：本文と次の一手に加えて、出所（土台、セッション内、事後）、要約器の種類とモデル名、何ターン時点か、生成の時刻を出す。要約器を通していない要約は種類とモデル名の札を出さない。
- `store.events`：開いていないセッションのトランスクリプトを落とす。古いページを削るのではないので、「もっと読む」で遡ったぶんは、そのセッションを開いている限り残る。落としたぶんは、セッション画面に入るたび先頭から読み直すので取り直される。
- 古いサーバの `bootstrap`：フェーズ 3 で増えた項目（`usage`、`todos`、`artifacts`、`summaryPending`）が欠けていても画面は立つ。欠けた項目は空として埋め、版が古いことは画面に出さない。
- `palette.run` が閉じるのはパレット自身だけにする。別のダイアログが開いている間に走っても、そのダイアログは閉じない。ダイアログを開く行（新しいセッション、スクラッチ、キーの一覧）も、そのダイアログを差し替えない。画面を移す行（プロジェクト、セッション、移動、全文検索、設定）も、その裏では移さない。
- `promote.done` と `promote.failed` は、昇格の最中（`promote` が `submitting`）でなければ何もしない。遅れて届いた結果で状態を書き換えないためである。
- 未解決のプロジェクトで「あとで」を選んだら、同じ起動の間はもう聞かない。覚えるのは Mediator の状態だけで永続化しないので、立て直せばまた聞く。利用者が自分で開きにきたときは覚えを忘れて出す。
- 既知の限界：プロジェクトのメモは、ファイルの mtime が DB の `updated_at` より古いと DB の内容がファイルに書き戻される。外部のエディタで書いた直後にファイルの時刻が巻き戻る状況では、その編集は画面から消える。消える本文は同じディレクトリに `memo.md.bak-<yyyymmddHHMMSS>` として残るので、手で拾い直せる。

以下はフェーズ 4 の実装で決めた前提である。
2026-09-19 に利用者と決めたものと、実装と実物確認で分かって計画から変えたものが混ざっている。

- Worker の D1 は `rows` と `changes` の 2 表で持ち、共有テーブルの形をそのまま写さない。表の名前と行 ID と payload を文字列として預かるので、共有テーブルに列が増えても Worker を直さずに済む。
- 参加トークンは `{url, secret}` の JSON を base64url にした文字列で、Settings からいつでも再表示できる。表示した後 120 秒で自動的に消し、`localStorage` にも残さない。
- 貼るときに折り返しが入っていてもよい。1Password の項目から貼る前提なので、空白と改行を落としてから読む。
- 参加トークンの URL は入口の検査を通す。素の `https:` の origin と、`127.0.0.1` と `localhost` の `http:` だけを許し、ユーザ情報つきとパスつきは拒む。敵対的なトークンを貼られると、その端末の本文と要約とメモが相手のサーバへ上がるためである。
- 端末ローカルの `file_sync` で、上げ下ろしの最後の SHA-256 を持つ。指紋は上げる側も降ろす側も、圧縮と暗号化の前の平文のものである。
- 本文は差分ではなくファイル全体を上げ直す。R2 が部分更新を持たないためである。
- 設定の R2 の鍵にも端末 ID を入れて `config/<端末 ID>/<相対パス>` にする。入れずに実物で 2 台を動かすと、同じ鍵を奪い合って、負けた端末が「SHA-256 が一致しません」で永久に取り込めなくなった（2026-09-19 の実物確認で判明）。
- 引き継ぎの握手は `takeover_requests` の同期に乗せる設計だが、フェーズ 4 では実装しなかった。ロックの表示と「この PC で再開」までに絞った（2026-09-19 の判断）。`EndReason` に `taken_over` は足さない。
- ロックは他端末の生きた run で引き、heartbeat の新旧では解かない。2 分を超えたら `stale` を立て、そのときだけ「この PC で再開」を押せるようにする。
- 同期は自分の端末同士のためのもので、他人と 1 つの箱を共有しない。別の人は自分の Cloudflare アカウントで `setup cloud` を走らせる。
- 無料枠の 80% で同期を自動で一時停止し、トーストで知らせる。課金される形にはしない。止めるのは 1 日に 1 度だけにする。
- 無料枠の数えは「Worker が D1 へ書いた行数」で行う。比べる相手が D1 の 1 日 10 万行なので、文の数で数えると単位が合わず、見張りが効かない。索引への書き込みも数に入れる。
  `autoincrement` の表（`changes` と `files`）は、insert のたびに SQLite の内部表 `sqlite_sequence` の 1 行も動かすので、それも数に入れる。
  `changes` への insert 1 行は、本体と `changes_device` の索引と `sqlite_sequence` で 3 行である。
  鏡（`rows`）の upsert と合わせて、採られた 1 行につき 5 行になる。
- 行数は Worker が数え、push の応答（`d1RowsToday`）で返す。
  端末が自分の push から見積もっていた頃は、`changes` の圧縮、`join` の `devices` の upsert、cold start ごとの `ensureSchema` が数え落ちていた。
  どれも端末を通らない書き込みだからである。
- 台帳（`meta` の `d1_rows:<yyyy-MM-dd>`）への書き込みも数に入れる。
  書き込みのあった要求の中で、その batch の末尾に 1 文だけ混ぜて書き出す（その日の最初だけ 2 行）。
  溜めてから書く形にすると、isolate が入れ替わったときに溜めた分がまるごと落ち、報告が実態より小さくなる。
  報告が小さいと端末が止まらないので、要求ごとに書き出す方を採る。
  実費は 1 要求 1 行で、30 秒ごとに引く端末 1 台なら 1 日 2,880 行（枠の 2.9%）である。台数に比例して増える。
  古い日の台帳は、孤児の掃除のついでに 7 日で刈る。
  端末側の見積もりにも、書き込みのある要求 1 回につきこの 1 文（多い方の 2 行）を足す。
- 台帳の答え合わせに `wrangler d1 insights` を使わない。
  読んでいるのが `d1QueriesAdaptiveGroups` で、名前の `Adaptive` が示すとおり標本から引き伸ばした推定だからである。
  2026-09-20 の突き合わせでは 2,031 行ずれ、同じ batch で必ず同時に走る文の回数が 20 倍まで食い違った。
  突き合わせるなら表の行数を数える。`changes` と `files` は `autoincrement` なので `max(seq)` が insert の回数そのものになる。
- Worker の報告はアカウント全体の数なので、端末の数では割らない。
  割ると、動いているのが 1 台の日に、使えるはずの枠の半分で止まる。
  要求の回数と、報告を返さない古い Worker のときの見積もりは、今までどおり端末の数で割る。
- `setup cloud --rotate-secret` は R2 の既存ファイルを復号できなくするので、確認を必須にする。確認は `y/N` ではなく合言葉を打たせる形にする。秘密がまだ無いときだけ確認を省く。
- `cloud teardown` は、R2 にしか無い本文を先に手元へ降ろす。1 件でも降ろせなければ、確認を聞く前に中止して wrangler を 1 度も呼ばない。wrangler の呼び出しが 1 つでも失敗したら、手元の `cloud.json` を消さずに 0 以外で終わる。
- Worker のテストは `@cloudflare/vitest-pool-workers` を使わず、miniflare 4 の使い捨てハーネスで行う。pool の最新版が peer に vitest 4 を要求し、vitest 5 を許す版が 1 つも無いためである。実物の Cloudflare に触らない要件は、ローカルの workerd で満たしている。
- R2 の覚え書き（`customMetadata`）の上限（2048 バイト）を超えたら、断らずに `path` を落として通す。正本は D1 の `files` なので、冗長な写しのために深い日本語の道にある本文を永久に同期できなくする方が筋が悪い。
- ファイルのパスは見出し（`x-hangar-path`）に符号化して載せる。URL に載せると、利用者のホームの構造が Cloudflare の要求ログに残る。素のまま見出しに載せる道は、非 ASCII のときに Node の fetch が送る前に落ちるので使えない。
- 1 回の push は 40 行まで、1 回の pull は 500 行まで、push の最小間隔は 10 秒。ローカルの `changes` は push 済みで 7 日、Worker の `changes` は 14 日と全端末の読み終わりで刈る。
- 降ろせない本文が 1 件あっても後ろを止めない。3 回続けて失敗したら飛ばし、中身が入れ替わったとき、起こし直したとき、30 分ごとに試し直す。
- 諦めた本文とまだ上げていない本文の件数は `SyncDetailDto` に載せ、HTTP の応答と websocket の `sync.status` の両方で配る。
  どちらの値も `SyncEngine` は持っていない（諦めた本文を覚えているのは `RemotePuller`、取り残しを数えられるのは `TranscriptUploader` である）ので、配るところで添える。
  受け取った側は届いた値をそのまま出す。直前の値を覚えて残すと、減ったはずの件数が画面に貼り付く。
- `~/.agent-hangar/remote` は 0700、降ろしたファイルは 0600 にする。中身は他端末の会話の本文である。
- 設定の同期の対象は削除を運ばない。片方で消したファイルは、もう片方からは消えない。
- 設定の取り込みは、途中のディレクトリがシンボリックリンクでも辿らない。段ごとに `lstat` して、リンクに当たったらその項目を諦める。realpath で後から判定する形にすると、`~/.claude` の外の既存ファイルを上書きする筋が残る。
- 取り込んだ設定ファイルの更新時刻は、相手の端末で編集した時刻に合わせる。`utimes` がナノ秒の端を落とすので往復のたびに 1 ミリ秒未満のずれが出るが、判定はミリ秒で行うので影響しない。
- Intent に `session.resumeHere`、`sync.config.preview`、`sync.config.apply`、`sync.joinToken.show` を、`ServerEvent` に `sync.status`、`sync.applied`、`devices.update` を足した。
- 孤児の掃除は `GET /files` を契機にして、cron を持たない。
  端末が pull のたびに叩く経路なので、6 時間の間隔を当てにできる相手がここしかない。
  当番を取りにいくのも 6 時間に 1 回でよいので、isolate は自分が最後に取りにいった時刻を覚え、その間は D1 に触らずに帰る。
- 既知の限界：使わなくなった端末の `transcripts/<端末 ID>/` と `config/<端末 ID>/` を畳む口が無い。
  掃除が拾うのは索引に無い本体と、本体の無い索引の行だけで、索引に載っている他端末のファイルは消さない。
- `~/.agent-hangar/backups/` の 3 種類（`claude-config/`、`transcripts/`、`memos/`）は、どれも新しい方から 20 世代を残して刈る。
  `claude-config/` は取り込みのたびに、`transcripts/` と `memos/` は控えを取った後とサーバを起こしたときに刈る。
  いま取った控えが最も新しいので、「控えを取れなければ書かない」という決まりには触らない。
  この置き場の外に残る控え（プロジェクトのメモの隣の `memo.md.bak-<日時>` と、設定の同期の `*.conflict-*`）は消さない。
- 既知の限界：無料枠の数え直しと孤児の掃除は、偽のクラウドとローカルの workerd（miniflare）の試験だけで確かめた（2026-09-20）。
  実物の Cloudflare では動かしていない。
- 既知の限界：フェーズ 4 の実物確認は、1 台の Mac の上で `HANGAR_HOME` と `HANGAR_CLAUDE_DIR` を分けて 2 端末を模して行った（2026-09-19 の決定）。実際に別のマシンから参加することは確かめていない。
- 配布版の同梱形態：サーバと CLI を esbuild で単一ファイル（`server.mjs`、`cli.mjs`）にまとめ、UI、ネイティブモジュール、`bin/hangar`、Worker のソース、`manifest.json` とともに `.app` の `Contents/Resources/server/` へ置く。UI の sourcemap は入れないので、実測で 7.7MB である。Node 本体は同梱しない。
- Node の版の一致：ネイティブモジュール（`better-sqlite3`、`node-pty`）は Node の ABI に縛られるので、同梱時の Node のメジャー版とアーキテクチャを `manifest.json` に記録し、候補を順に起動して一致する版だけを採る。一致する Node が無ければ、探した場所を挙げて起動を諦める。
- `nodePath` の重さ：Settings の `nodePath` は、次の起動で `.app` がそのまま起こす実行ファイルの場所なので、設定への書き込みが次回起動時のコード実行になる。
  いま穴が開いているわけではないが、UI か API の側に穴が 1 つできたときの被害の上限がここまで上がることを、前提として書き留めておく。
- 配布ターゲットは Apple silicon の macOS 13 以降だけ。prebuild も `darwin-arm64` しか入れない。全アーキを入れると `node-pty` の win32 だけで 58MB になる。Intel と Windows は作らない。
- Gatekeeper：Developer ID での署名も公証もせず、zip と SHA-256 の checksum を添えて配る（2026-09-20 の決定）。
  Tauri が行うのはバイナリを ad-hoc（linker-signed）にするところまでで、バンドルの封はしないので、`.app` に `_CodeSignature` は無く、`spctl -a -vv` は `code has no resources but signature indicates they must be present` で弾く。
  署名しないという決めのもとでは、これが既定の姿である。
  利用者の手順は、`.app` を `/Applications` へ移してから検疫属性を外すことである。
  移動を先に置くのは順序の実測による。
  検疫属性が付いたまま開くと、App Translocation の案内より先に Gatekeeper のダイアログが出る。
  翻訳された場所からプロセスは起動するが、ウィンドウは出ずログにも 1 行も書かれないので、利用者が最初に見るのはアプリの案内ではなく macOS の拒否である。
  アプリ自身も同梱サーバを起こす前に検疫属性を外すが、読み取り専用の写しでは書き込めないので効かない。
- 二重起動：single-instance のプラグインを入れない。起動時に 4177 が既に応答していれば、そのサーバを採用して子プロセスを起こさない。ブラウザや `hangar start` で先に起きているサーバと食い合わないためである。
- wrangler は同梱しない。205MB あり、`.app` の大きさが 20 倍近くになる。配布版の `hangar setup cloud` は、wrangler が見つからないことを告げて止まる。クラウド同期を使う端末は、リポジトリを clone して設定する。
- 既知の限界：フェーズ 5 の実物確認（2026-09-20）で見ていないものが二つある。
  App Translocation の案内の画面そのものは、Gatekeeper のダイアログを人が承認しないと先へ進まないので、通しでは見ていない（案内の枝は単体試験で押さえてある）。
  システム設定の外観をダークにしたときの見え方は、利用者の環境を変えるので確かめず、配信される UI に `prefers-color-scheme` の規則が 1 件も無いことの確認で代えた。
- 覚え書き：`HANGAR_CLAUDE_DIR` は hangar が読む設定の置き場で、起こされた `claude` が見るのは `CLAUDE_CONFIG_DIR` である。普段はどちらも `~/.claude` なので食い違わないが、試しの環境を分けるときは両方を向ける。
- 右欄のライブの第 1 回で決めた前提：意図は端末ローカルに置いて同期しない。
  赤は結果が `isError` のものだけで、本文の中身で決まる結末は赤にしない。
  Bash の description を日本語で書かせるのは、指示の注入で頼む。

未決事項は次のとおりである。

- 権限確認ダイアログの待ちがレジストリで `waiting` になるか `busy` のままかは、auto モード以外で確かめる。
- OpenCode Provider の詳細設計。フェーズ 5 以降に別文書で書く（フェーズ 3 では扱わなかった）。
- 引き継ぎの握手。`takeover_requests` を使う設計はこの文書に残したまま、実装は後のフェーズへ送った。2 台で使い続けて、本文の枝分かれが実際に困るかどうかを見てから決める。
- 使わなくなった端末の始末。`transcripts/<端末 ID>/` と `config/<端末 ID>/` と `devices` の行を畳む操作が無い。
- `findSession` と `ensureSession` が `deleted_at` を見ていないこと。削除の見え方そのものを変える話なので、手元と写しで規則がずれないように一度にまとめて直す。
