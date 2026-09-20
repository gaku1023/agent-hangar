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

- **読み取り専用**：Claude Code の設定とデータを、hangar は原則として読むだけで書き換えない。`~/.claude` の中へ書く例外は次の 3 つだけである。
  - statusline スクリプトへの追記。承諾を求め、追記の前に同じディレクトリへバックアップを取る。
  - 利用者が明示的に押した「この PC で再開」で、他端末のセッション本文を `~/.claude/projects/` に写すこと。手元の本文を上書きするときは `~/.agent-hangar/backups/transcripts/` へ控えを取り、控えが取れなければ写さない。
  - クラウド同期で、他端末から引いた Claude Code のユーザー設定を書き戻すこと。Settings で明示的に有効にし、取り込む内容を確認したときだけ書く。上書きの前に `~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ 1 バイトも書かない。
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
- `packages/cli`：`hangar` コマンド。`setup`、`setup cloud`、`join`、`start`、`status`、`open`、`url`、`mcp install`、`statusline install`、`cloud status`、`cloud teardown` を提供する。

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
│  ├─ Header                パンくず、検索ボックス、使用量ゲージ、同期状態、新規ボタン
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
  | { type: 'project.open'; id: ProjectId } | { type: 'project.setStatus'; id: ProjectId; status: ProjectStatus }
  | { type: 'project.new.open' } | { type: 'project.new.submit'; name: string; gitInit: boolean; startSession: boolean }
  | { type: 'project.resolve.open'; id: ProjectId }
  | { type: 'project.resolve'; id: ProjectId; action: { kind: 'repoint'; path: string } | { kind: 'archive' } | { kind: 'unlink' } }
  | { type: 'project.openEditor'; id: ProjectId } | { type: 'project.openTerminalApp'; id: ProjectId }
  | { type: 'todo.add'; projectId: ProjectId; text: string } | { type: 'todo.toggle'; id: TodoId } | { type: 'todo.remove'; id: TodoId }
  | { type: 'memo.save'; projectId: ProjectId; markdown: string }
  | { type: 'artifact.open'; id: ArtifactId } | { type: 'artifact.openEditor'; id: ArtifactId }
  | { type: 'artifact.add'; projectId: ProjectId; url: string }
  | { type: 'session.open'; id: SessionId } | { type: 'session.setMemo'; id: SessionId; text: string }
  | { type: 'session.new.open'; projectId?: ProjectId; scratch?: boolean } | { type: 'session.new.submit'; params: LaunchParams }
  | { type: 'session.resume'; id: SessionId } | { type: 'session.fork'; id: SessionId } | { type: 'session.kill'; runId: RunId }
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
- `sessionView(id)`：開いているタブの列、選択タブ、分割の有無、トランスクリプトペーンの開閉、要約パネルの開閉。
- `launch`：`idle | submitting | failed(message)`。
- `connection`：`connecting | connected | disconnected`。
- `sync`：`off | idle(lastAt) | pushing | pulling | paused | error(message)`。

主要な遷移を表にする。

| 現在 | 入力 | 次 | 効果 |
| --- | --- | --- | --- |
| `booting` | `ServerEvent.ready` | `home` | 初期データ購読 |
| 任意 | `nav.go(to)` | `to` | URL 更新 |
| `overlay: none` | `session.new.open` | `overlay: newSession` | フォーカスを名前欄へ |
| `launch: idle` | `session.new.submit` | `launch: submitting` | `POST /api/runs` |
| `launch: submitting` | `POST /api/runs` の応答 | `launch: idle`, `screen: session(id)` | ターミナル接続 |
| `launch: submitting` | `POST /api/runs` の失敗 | `launch: failed` | ダイアログ内に理由 |
| `session(id)` | `tab.open(shell)` | タブ追加 | `POST /api/runs/:id/tabs` |
| `launch: idle` | `session.resumeHere` | `launch: submitting` | `POST /api/sessions/:id/resume-here` |
| `launch: submitting` | 409（手元の本文の方が小さい） | `overlay: confirm('overwriteTranscript')`, `launch: idle` | なし |
| 任意 | `ServerEvent.projectUnresolved(id)` | `overlay: resolveProject(id)` | なし |
| `connection: connected` | WebSocket 切断 | `disconnected` | 再接続タイマー |

状態機械の実装は `packages/ui/src/mediator/` に置き、領域ごとにファイルを分ける。
テストは「入力の列を与えて最終状態と効果の列を検証する」形で書く。

### 画面ごとの構成

各画面の Presenter が計算する値は、次の節の「画面」で画面ごとに述べる。
ここでは共通の約束だけを書く。

- 一覧は仮想スクロールで描く。1 行 28px の高密度で、100 件を超えても遅くしない。
- 時刻は相対表示（「3 分前」）を基本にし、ホバーで絶対時刻を出す。
- 識別子、パス、時刻、数値は等幅フォントで描く。
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
  claude \
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
起動ダイアログの必須項目はプロジェクトだけで、名前と初期プロンプトは任意である。
model、effort、permission mode、worktree、追加ディレクトリは折りたたみに置き、既定値は利用者の Claude Code 設定に従う。

### 実行中の状態

サーバは `~/.claude/sessions/` を監視し、run と結びつける。
結びつけの鍵はセッション UUID である。
`status` は busy、idle、waiting の 3 値で、waiting は AskUserQuestion などで利用者の入力を待っている状態である。
UI の状態点はこの 3 値をそのまま使い、waiting は通知トーストの対象にする。
プロンプト送信から busy まで約 0.5 秒、終了からファイルの消失まで約 0.4 秒で、500 ミリ秒間隔の監視で足りる。
`-n` や `/rename` で付けた名前は本文にも記録として残り（`agent-name`、`custom-title`）、再開やフォークの先にも引き継がれる。
hangar は名前を本文の記録から読み、レジストリの値で上書きする。
tmux セッションが消えたら run を終了とみなし、`end_reason` を記録する。

UI のターミナルは xterm.js で、サーバ側の node-pty が `tmux attach -t <tmux_name>` を実行して入出力を中継する。
リサイズは xterm.js の寸法を PTY に伝える。
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
未完の TODO：<最大 10 件>
過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。
依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、
set_session_summary で題名、2〜3 文の要約、状態、次の一手を更新してください。
```

MCP の URL はセッション別（`/mcp/s/<sessionId>`）なので、ツールは呼び出し元のセッションをサーバ側で確定できる。
モデルにセッション ID を扱わせる必要はない。

### 再開とフォーク

過去のセッションは「再開」と「フォーク」を持つ。
再開は同じ cwd で `claude -r <uuid>` を tmux 上で実行し、`kind = 'resume'` の run を作る。
フォークは `claude -r <uuid> --fork-session --session-id <新 uuid>` で、新しいセッション行と `kind = 'fork'` の run を作る。
同じセッションに生きた run があるときは、再開を無効にする。

### スクラッチと昇格

リポジトリ名を決める前に使い捨てのセッションを回したい、という用途のために **スクラッチ** を用意する。
「スクラッチで始める」は `~/.agent-hangar/scratch/<yyyymmdd-HHmmss>/` を作り、そこを cwd にセッションを起動する。
スクラッチのセッションは `is_scratch = 1` の擬似プロジェクトに属する。
この擬似プロジェクトは端末ごとに 1 つで、どのスクラッチのディレクトリで起動したセッションもすべてここに属する。

セッション画面の「プロジェクトに昇格」は、名前とチェックボックス 2 つ（`git init` するか、ファイルを移すか）を受け取って次を行う。

1. `<workspaceRoot>/<name>` を作り、チェックが入っていれば `git init` する。
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
要約は題名、1 文、2〜3 文の本文、状態（進行中、完了、詰まっている、中断）、次の一手から成る。
閉じているときは題名と 1 文だけを出し、ヘッダーのパネルを開くと全部を出す。

要約は三つの経路で作る。

- **土台**：インデクサが `ai-title`、最初と最後のプロンプト、触ったファイル、ターン数、期間から機械的に作る。全セッションに即時にあり、`source = 'baseline'` で保存する。
- **セッション自身**：hangar が起動したセッションは、注入した指示に従って節目に `set_session_summary` を呼ぶ。文脈を持っているので最も正確で、追加コストがない。`source = 'in_session'`。
- **事後生成**：run 終了時に要約が土台のままか、最後の更新から 5 ターン以上進んでいれば、要約器で作り直す。セッションを開いたときも同じ条件で作る。`source = 'post_hoc'`。

要約には、どの経路で作ったか（`source`）に加えて、どの要約器が書いたか（`source_id`）とそのモデルの名前（`source_model`）を持つ。
土台とセッション自身の要約は要約器を通さないので、どちらも持たない。
`source_id` が無かった頃の行は、種類を推し量らずに「不明」と出す。

過去の全件を背景で埋めることはしない。

事後生成の契機は、run が終わったときと、セッション画面を開いて先頭ページを読んだときの 2 つである。
run の終了からの契機だけは、レジストリの生存判定を飛ばす。
セッションの生存を 500 ミリ秒周期のキャッシュで見ているため、止めた直後はまだ「実行中」と判定されてしまうからである。
飛ばすのは生存判定だけで、土台のままか 5 ターン以上進んだかの判定は残る。
要約器は LM Studio を先に試し、使えないときだけ `claude -p` に切り替える。
切り替えは 1 時間あたりの件数（既定 20）と 7 日の使用率 80% で止め、`claude` が PATH に無ければ使わない。

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
状態の判定基準（最後のターンが利用者への問いなら進行中）はプロンプトに明示する。

要約器には会話の本文（利用者の発言とアシスタントの応答）がそのまま送られる。
そこで宛先は既定でループバックだけに閉じ、`127.0.0.1`、`localhost`、`::1` 以外のホストは 400 で断る。
Settings の「手元の外にある要約器を許す」を入れたときだけ、外の宛先を受け付ける。
許しと宛先は同じ要求の中で突き合わせるので、片方ずつ変えて素通りさせることはできない。
この印を入れている間は、Settings に「会話の本文がこの宛先へ送られます」という警告を出し、宛先の URL を添える。
設定ファイルを手で書き換えて外の宛先を入れても、読み込みのときに既定へ戻す。

要約器への問い合わせはリダイレクトを追わない（`redirect: 'manual'`）。
追うと、ループバックだと思って許した宛先が 302 を返すだけで、会話の本文が外のホストへ送られてしまう。
宛先の検査は最初の URL にしか効かないので、追わないことでしか塞げない。
3xx が返ったときは失敗として扱い、次の要約器へ回す。
モデル一覧の問い合わせも同じで、リダイレクトが返れば一覧は空として扱う。

LM Studio に繋がらないときは `claude -p --model haiku --output-format json --json-schema <schema>` に切り替える。
こちらはサブスクリプションのレート制限を消費するので、1 時間 20 件までとし、7 日の使用率が 80% を超えたら止める。
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
font と img は `@fontsource` の woff と favicon の SVG のために `data:` を許す。
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
- `update_project(project_id, { status?, add_todos?, toggle_todos?, append_memo? })`。
- `list_sessions({ project_id?, running?, limit? })`。
- `search_sessions({ query, project_id?, since?, until?, provider?, file? })`：FTS と絞り込み。結果は題名、要約の 1 文、一致箇所の抜粋、再開コマンド。
- `get_transcript(session_id, { from_seq?, limit?, include_tools? })`：正規化イベントを返す。
- `create_session({ project_id, name?, prompt?, model?, effort?, permission_mode?, scratch? })`：tmux で起動して run を返す。
- `set_session_summary({ session_id?, title, one_liner, body, state, next_steps })`。
- `set_session_memo({ session_id?, text })`：人間向けの 1 行メモ。モデルには指示しない。
- `get_usage()`：5 時間と 7 日の使用率、最終更新時刻。
- `open_in_hangar({ session_id | project_id })`：UI とディープリンクの URL を返す。

`update_project` は TODO の追加と完了の切り替え、メモの追記を行い、TODO の書き込みは全部成功か全部失敗のどちらかにする（途中で失敗したものが残らない）。
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
出ないときは棒を描かず、ヘッダーの使用量ゲージと同じ言葉で「未取得」と書く。
0% の棒は「まだ使っていない」と読めてしまうためである。
両方とも未取得のときだけ、Settings へ導く 1 行を添える。
更新は定期ではなく、起動直後と応答完了のたびに 1 回である。起動直後の 1 回目は `rate_limits` が無いので、欠けた項目は直前の値を保つ。
使用率は Claude のセッションが動いている間だけ更新されるので、ヘッダーのゲージには「最終更新 N 分前」を添える。
追記は目印のコメント行で二重追記を避け、追記前にバックアップを取る。
既に入っているスニペットが今の形と違うときは、目印の行から `exec <<<` の行までを差し替える。
目印だけを見て何もしないと、トークンを argv に載せる古い形が入ったまま残るためである。
追記を行うのは `hangar setup` の手順 4 と `hangar statusline install` の 2 つだけで、どちらも利用者の承諾を求める。
UI とサーバは追記の有無を `GET /api/statusline` で読むだけで、書き込む経路もボタンも持たない。
副情報として、jsonl の `usage` からトークン数を日別とプロジェクト別に集計する。
日別とプロジェクト別は同じ窓（直近 30 日）と同じ供給源（`usage_daily`）で束ねるので、2 つの表のトークン数の合計は一致する。
ただし推定コストだけは、そのセッションの走り全体の累計である。
唯一の供給源が statusline の渡してくる `cost` で、日ごとの内訳を持たないためである。
プロジェクト別の推定コストは、窓に入ったセッションについて 1 件につき一度だけ足す。

## 検索

Sessions 画面は検索画面を兼ねる。
キーワードが空なら全件を新しい順に出す。
検索対象は利用者の発言、アシスタントの本文、ツール呼び出しのファイルパスとコマンドである。
絞り込みはプロジェクト、期間、Provider、実行中か終了か、触ったファイルである。
結果には題名、要約の 1 文、一致箇所の抜粋、日時、プロジェクトを出す。
同じ検索を MCP の `search_sessions` で外部の AI にも提供する。
FTS5 に渡す検索語はトークンごとに二重引用符で包む。ハイフンを含む語を素のまま渡すと列指定と解釈されてエラーになる。
trigram は 3 文字未満の語に一致できないので、3 文字未満の語は部分一致で補う。
意味検索は初版では持たない。

## プロジェクトの同定

プロジェクトは安定した ID と、端末ごとのパスを持つ。
パスが見つからないとき（ディレクトリの改名、移動、削除、別 PC での不在）は、`project_roots.resolved = 0` にして警告ダイアログを出す。
ダイアログは「ディレクトリを再指定」「アーカイブにする」「紐づけを削除」を選ばせる。
自動推定やマーカーファイルは持たない。
再指定のダイアログには、ワークスペースルート直下で名前が近いディレクトリを候補として並べる。

初回起動時は、ワークスペースルート（既定は `~/workspace`）直下で、cwd がそのディレクトリ以下の Claude セッションが 1 つ以上あるものを自動でプロジェクトにする。
セッションのない直下ディレクトリは「新規プロジェクト」で既存ディレクトリを選ぶときの候補にだけ出す。
ルート外の cwd のセッションは「未分類」に入れ、後から手で紐づけられる。
起動した後に未分類のセッションが現れたときは、黙って置かずに 1 度だけトーストで知らせる。
起動時の初回の全走査では知らせない。
ディレクトリが戻ってルートが解決に戻ったら、その間に溜まった未分類のセッションを紐づけ直し、変わったセッションとプロジェクトを配る。

## 画面

### 骨格

左にナビだけのサイドバー、上にヘッダー、残りがメインである。
サイドバーの項目は Home、Projects、Sessions、Settings の 4 つで、プロジェクトの一覧は置かない。
ヘッダーには左から、現在位置のパンくず、検索ボックス、5 時間と 7 日の小さなゲージ、同期状態、新規セッションボタンを置く。
検索ボックスに入力すると Sessions 画面に移る。
⌘K でコマンドパレットを開き、セッションとプロジェクトへのジャンプと、主要な操作を実行できる。

### Home

上から順に、実行中セッションの帯、active なプロジェクトのカード、最近のセッションの横断リストを置く。
実行中の帯は、名前、プロジェクト、busy か idle、経過時間を 1 行に出し、クリックでセッション画面のターミナルへ移る。
実行中が無いときは帯を省く。
プロジェクトのカードは、最後のセッションの要約の 1 文、未完 TODO の数、メモの冒頭、「ここで新規」ボタンを持つ。

### Projects

active、paused、done のセクションに分けてカードを並べ、archived はトグルで出す。
カードには名前、パス、最終活動日、実行中の数、未完 TODO の数、メモの冒頭を出す。
並びは最終活動順で、名前の部分一致で絞れる。
カードは 1 行 4 列の高密度で置く。

### プロジェクト詳細

ヘッダーに名前、パス、ステータスの切り替え、操作（新規セッション、VS Code で開く、ターミナルで開く）を置く。
メインはセッション一覧で、実行中を先頭に、その後を新しい順に並べる。
各行には要約の題名と 1 文、状態、モデルと effort、日時、変更ファイル数と行数、PR リンク、推定コストを出し、1 行メモをその場で編集できる。
右レールには TODO のチェックリスト、Markdown のメモ、アーティファクトのカードを置く。
右レールは折りたためる。

### セッション詳細

実行中のセッションは、ターミナルを主、ライブトランスクリプトを従に置く。
上部にタブ列があり、タブ 0 が Claude、以降がシェルである。
セッション画面を離れると、そのセッションのターミナル接続は切る。
xterm のインスタンスとスクロールバッファは残すので、戻ればすぐ描かれ、`tmux attach` が現在の画面を描き直す。
接続を持ち続けると、渡り歩いたセッションの数だけ `tmux attach` のプロセスが残るためである。
2 つのタブを横に並べる分割表示ができる。
トランスクリプトペーンは横に折りたためる。

過去のセッションはトランスクリプトだけを出し、「再開」「フォーク」「VS Code で開く」を操作に持つ。
ヘッダーには名前、状態、要約（題名と 1 文、パネルで全部）、1 行メモ、モデルと effort、コンテキスト使用率を出す。
要約のパネルを開くと、本文と次の一手に加えて、出所、要約器の種類とモデル名、何ターン時点か、生成の時刻を出す。
何がこの要約を書いたのかは、作り直すかどうかの判断に要るためである。
他端末で実行中なら「MacBook で実行中」（heartbeat が 2 分より古ければ「MacBook が応答がありません」）の表示を出し、再開とフォークは無効にする。
手元に本文が無いセッションと、ロックが `stale` になったセッションには「この PC で再開」を出す。
「引き継ぐ」は作らなかった。

トランスクリプトはチャット形式で描く。
利用者の発言とアシスタントの本文を吹き出しにし、ツール呼び出しは 1 行に折りたたんでクリックで展開する。
思考は既定で非表示にし、切り替えで出す。
サブエージェントは親のツール呼び出しの下にネストする。
生の JSON を見るトグルを持つ。
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
上にキーワード欄、その下に絞り込み（プロジェクト、期間、Provider、実行中か終了か、触ったファイル）、残りが結果一覧である。
結果の行は、プロジェクト詳細のセッション一覧と同じ列を持ち、加えて一致箇所の抜粋を出す。

### Settings

ワークスペースルート、ターミナルアプリ、VS Code のパス、MCP 登録、statusline への追記、tmux の有無、要約器（LM Studio の URL とモデル、フォールバックの上限、手元の外にある要約器を許す印）、クラウド同期、Provider の一覧を置く。
クラウド同期の節には、同期の状態と今すぐ同期と一時停止、参加している端末の一覧、参加トークンの再表示、Claude Code の設定を同期する印と取り込む内容の下見を置く。
参加トークンは押したときだけ出し、120 秒で自動的に消して表示のボタンに戻る。
statusline の節は追記の有無と追記先のパスを出すだけで、書き込むボタンは持たない（追記は CLI から行う）。
使用量の節には、直近 30 日の日別（日、入力トークン、出力トークン、セッション数）と、プロジェクト別（名前、トークン、推定コスト、セッション数）の 2 つの小さな表を置く。
推定コストの列には、そのセッションの走り全体の累計であることを添える。
診断として、サーバのログの末尾と索引の進行を出す。

### ショートカット

- グローバル：⌘K パレット、⌘N 新規セッション、⌘⇧N スクラッチ、⌘, 設定、/ で検索欄にフォーカス。
- タブとペーン：⌘1 から ⌘9 でタブ切替（素のブラウザでは ⌃⌥1 から ⌃⌥9）、⌘W でタブを閉じる、⌘\ で分割、⌘J でトランスクリプトペーンの開閉。
- 一覧：j と k で上下、Enter で開く、o でターミナル、e で VS Code、m でメモ編集。

ターミナルにフォーカスがあるとき、⌘ を含む組み合わせだけを hangar が受け取り、それ以外はすべてターミナルへ渡す。
判定は `keydown` の `target` が `.term-host` の中にあるかで行い、渡すものは `preventDefault` せずに xterm へ落とす。
タブ切替は ⌘1 から ⌘9 と ⌃⌥1 から ⌃⌥9 の両方を常に受け付ける（Tauri かブラウザかの判別は持たない）。
ただし ⌃⌥ の側は ⌘ を含まないので、ターミナルにフォーカスがある間はターミナルへ渡る。

## 見た目と動き

常にライトで、ダークモードは持たない。
例外はターミナルの面だけで、そこは端末エミュレータの慣習に合わせて暗い配色（`--term-bg`、`--term-fg`）にする。
参照するのは Linear である。
色はデザイントークンとして `:root` に定義する。
面は白と淡いグレー、アクセントは 1 色、状態色（busy、idle、終了、エラー）は控えめな彩度にする。
プロジェクトのステータス（active、paused、done、archived）は、アイコンではなく色で示す。
ステータスごとに文字色と淡い地色のトークン（`--st-<status>`、`--st-<status>-soft`）を持ち、ステータスの部品と見出しの点が `data-status` からそれを引く。
ステータスの部品は、文字、その右の塗りつぶしの丸、矢印の順に自前で描き、透明にした本物の `select` をその上に重ねる。
素の `select` の中には要素を置けないためで、選択肢の一覧、キーボード操作、読み上げは `select` がそのまま受け持つ。
この部品は `views/primitives/StatusSelect.tsx` の `StatusSelect`（選べる場所）と `ProjectStatusDot`（読むだけの場所）だけを通して使い、View が `<select>` を自分で書くことはしない。
淡い地色の上の文字は 4.5:1 以上のコントラストを保つ。
ステータスは常に文字でも示すので、色は補助である。
グラデーション、グロー、ガラス、影の多用はしない。

アイコンは Lucide（`lucide-react`）を使い、大きさ 16px、線幅 1.5 に固定する。
16px に縮むと実際の線幅は 1px になり、13px の本文の太さと釣り合う。
View は `lucide-react` を直接 import せず、hangar の言葉（`fork`、`resume`、`shell` など）から引く `views/primitives/Icon.tsx` だけを通す。
文字の無いアイコンだけのボタンには必ず `aria-label` を付け、文字に添えるアイコンは飾りとして読み上げから外す。
商標のアイコンは持たない（VS Code は汎用のコードのアイコンに文字を添える）。

書体は Inter 系のサンセリフに日本語は Hiragino Sans を重ね、識別子、パス、時刻、数値には JetBrains Mono 系の等幅を使う。
ターミナルとコードブロックも同じ等幅である。
密度は高く、一覧の行高は 28px、カードは 4 列、メインの最大幅は 1200px 前後で中央に寄せる。

動きは 150 から 250 ミリ秒の短いイージングに限り、次の 11 種だけを使う。

- 一覧への差し込みと削除のフェードとわずかな縦移動。
- 折りたたみと展開の高さのトランジションと矢印の回転。
- 状態点の色の遷移、使用量ゲージの充填、TODO の打消し線。
- タブ切替の下線のスライドと、分割やトランスクリプトペーンの幅のトランジション。
- コマンドパレットの開閉（98% から 100% のスケールとフェード、120 ミリ秒）。
- 画面遷移のメイン領域だけのクロスフェード（120 ミリ秒）。
- ホバーの背景（80 ミリ秒）と押下時の 98% への縮小。
- 通知トーストの右下からのスライドイン。
- ステータス変更や昇格でのカードの FLIP 移動。
- 使用率やコンテキスト使用率の数字の縦回転。
- ライブトランスクリプトの新着へのスムーズスクロールと、左の細線の 1 秒の復水。上へスクロール中は追従を止め「新着 N 件」を出す。

グロー、脈動、タイピング風の表示、シマー、スケルトンは使わない。
初回索引の進行は静的な文字で示す。

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
- メモの正：`project_memos.markdown` とファイル `~/.agent-hangar/projects/<projectId>/memo.md` の両方に書く。読むときはファイルの mtime が DB の `updated_at` より新しく中身が違えばファイルを正として DB を直す。`~/.agent-hangar/projects/` を `fs.watch`（再帰）で見て、300 ミリ秒のデバウンスで取り込んで `memo.update` を配る。`memoHead` は空行でない最初の行の先頭 80 字で、全文は `GET /api/projects/:id/memo` で読む。DB を正として書き戻すときは、ファイルの中身が DB と違うときだけ、消える本文を `memo.md.bak-<yyyymmddHHMMSS>` として同じディレクトリに残してから書き戻す。同じ秒に 2 度来たら連番を足し、既にある控えは上書きしない。控えは古くなっても消さない。控えを残せなかったときは書き戻さず、ファイルの方を残す。
- スクラッチの擬似プロジェクト：端末ごとに 1 つで、名前は「スクラッチ」、この端末の `project_roots.path` は `~/.agent-hangar/scratch`。ディレクトリ名は `<yyyymmdd-HHmmss>`（ローカル時刻、同じ秒に 2 つ作るときは `-2`、`-3`）。Projects 画面と Home のカードにはこの行を出さず、Sessions 画面の絞り込みには出す。
- スクラッチかどうかの判定は、スクラッチのルートの下にあるかで行い、ルート自身は含めない。`scratch_root` は `project_roots` を端末で絞って引く。
- 昇格：`POST /api/sessions/:id/promote { name, gitInit, moveFiles }`。`name` は `/` を含まない 1 字以上で、`<workspaceRoot>/<name>` が既にあれば 409。移動は先に全件の衝突を調べてから `fs.renameSync` で行い、途中で失敗したら逆順に戻す。`moveFiles` が真でも run が生きていれば移動せず、`moved: false` と理由を返す。
- `SessionDto.fromScratch`：cwd がスクラッチのルートの下で、属するプロジェクトがスクラッチでないときに真にする。セッション画面は真のとき「再開すると cwd はスクラッチのままです」を添える。
- 分割の持ち方：`SessionViewState` に `split: boolean` と `splitTab: string | null` を持つ。左は選択中のタブ、右は `splitTab` で、幅は `SplitPane` の中の状態にして保存しない（0.5 に戻る）。分割の右に置いたタブが閉じたら `splitTab` を null にし、`split` も偽に戻す。
- 分割にタブが 2 つ要ることの判定は、Mediator がストアを見ないので、`split.resolve` の効果を受けたランタイムが決めて `split.resolved` で返す。Mediator は返ってきた結果で状態を変えるか、トースト「分割にはタブが 2 つ必要です」を出すかを選ぶ。
- パレットの項目：コマンドは新規セッション、スクラッチで始める、設定、索引を作り直すの 4 つで、これにプロジェクト（`project:<id>`）とセッション（`session:<id>`、名前と要約の 1 文で照合）を足す。照合は部分列一致で、一致位置が前で連続しているほど高い点を付け、同点は積んだ順にして上位 30 件を出す。入力欄の文字は Root の `useState` が持ち、Mediator には入れない。
- 要約器の設定：`SettingsDto` に `lmStudioUrl`（既定 `http://127.0.0.1:1234`）、`lmStudioModel`（既定 null で、null なら `/v1/models` の最初のモデル）、`summaryFallback`（既定 true）、`summaryHourlyCap`（既定 20）、`allowExternalSummarizer`（既定 false）を持つ。
- 要約の入力：主線の全イベントを読み（サブエージェントは含めない）、`user` は 2,000 字、`assistant` は 600 字、`tool_call` は 1 行に切り、`thinking`、`tool_result`、`system`、`meta` は捨てる。全体が 12,000 字を超えたら先頭 30% と末尾 30% を残し、中盤を「[... N 件を省略 ...]」に置き換える。
- 要約ジョブの契機：run の終了と、セッション画面を開いたときの先頭ページの読み込みの 2 つで `enqueue` する。受け付けるのは要約が土台のままか最後の更新から 5 ターン以上進んだときだけで、実行中のセッションは受け付けない（セッション自身の `set_session_summary` に任せる）。run の終了からの `enqueue` は `ignoreLive` で生存判定だけを飛ばし、残る 2 つの判定は通す。「要約を作り直す」は条件を無視する。ジョブは 1 セッション 1 件で、直列に走る。
- 要約の配信が失敗しても待ち行列は進める。配信の失敗は 1 行だけ記録し、次のジョブを止めない。
- Claude への切り替えの上限：呼び出しの時刻をメモリに持ち、直近 1 時間の件数が上限に達していれば使わない。7 日の使用率が 80 以上でも使わず、`claude` が PATH に無ければ使わない。サーバを再起動すると件数は 0 に戻る。
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
- `palette.run` が閉じるのはパレット自身だけにする。別のダイアログが開いている間に走っても、そのダイアログは閉じない。
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
- 行数は Worker が数え、push の応答（`d1RowsToday`）で返す。
  端末が自分の push から見積もっていた頃は、`changes` の圧縮、`join` の `devices` の upsert、cold start ごとの `ensureSchema` が数え落ちていた。
  どれも端末を通らない書き込みだからである。
- 台帳（`meta` の `d1_rows:<yyyy-MM-dd>`）への書き込みも数に入れる。
  書き込みのあった要求の中で、その batch の末尾に 1 文だけ混ぜて書き出す（その日の最初だけ 2 行）。
  溜めてから書く形にすると、isolate が入れ替わったときに溜めた分がまるごと落ち、報告が実態より小さくなる。
  報告が小さいと端末が止まらないので、要求ごとに書き出す方を採る。
  実費は 1 要求 1 行で、30 秒ごとに引く端末 1 台なら 1 日 2,880 行（枠の 2.9%）である。台数に比例して増える。
  古い日の台帳は、孤児の掃除のついでに 7 日で刈る。
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

未決事項は次のとおりである。

- 権限確認ダイアログの待ちがレジストリで `waiting` になるか `busy` のままかは、auto モード以外で確かめる。
- OpenCode Provider の詳細設計。フェーズ 5 以降に別文書で書く（フェーズ 3 では扱わなかった）。
- 引き継ぎの握手。`takeover_requests` を使う設計はこの文書に残したまま、実装は後のフェーズへ送った。2 台で使い続けて、本文の枝分かれが実際に困るかどうかを見てから決める。
- 使わなくなった端末の始末。`transcripts/<端末 ID>/` と `config/<端末 ID>/` と `devices` の行を畳む操作が無い。
- `findSession` と `ensureSession` が `deleted_at` を見ていないこと。削除の見え方そのものを変える話なので、手元と写しで規則がずれないように一度にまとめて直す。
