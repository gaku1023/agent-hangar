# フェーズ 4 実装計画（クラウド同期）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **2026-09-19 の設計判断（利用者に確認済み）。**
> このフェーズでは**引き継ぎ（握手による run の受け渡し）を実装しない**。
> 他端末で実行中のセッションは「ロック中」と見せるだけにし、手元で続けたいときは「この PC で再開」で本文を降ろして新しい run を立てる。
> 同期の中でいちばん複雑な部分を、2 台で使う実感が無いまま作らないためである。
> Task 16 は中身を残したまま「このフェーズでは実装しない」として据え置き、Task 17 は「この PC で再開」だけを残す。
> 同期は「自分の端末同士」のための機能であり、他人と 1 つの箱を共有する使い方は想定しない。
> 判断の全文は `.superpowers/sdd/phase4-sync/decisions.md` にある。

**Goal:** 利用者自身の Cloudflare アカウントに置いた Worker と D1 と R2 を介して、hangar のメタデータ、セッションの本文、Claude Code のユーザー設定を自分の端末間で同期し、他端末で実行中のセッションをロックとして見せ、手元に本文を降ろして再開できる状態にする。

**Architecture:** `packages/cloud` の Hono Worker が、参加トークンによる端末登録、サーバ側連番付きの変更ログ（D1）、暗号化済みファイルの置き場（R2 と D1 の索引）を提供する。ローカルサーバの `SyncEngine` は `changes` の未送信分を 1 秒のデバウンスで push し、起動時と前面化と 30 秒ごとに pull して行単位の LWW で適用する。本文は `TranscriptUploader` が gzip と AES-256-GCM で包んで端末別の鍵に上げ、`RemotePuller` が他端末の分を `~/.agent-hangar/remote/<端末 ID>/` に降ろして既存のインデクサで索引化する。他端末に生きた run があるセッションはロックとして見せ、「この PC で再開」は `copyTranscriptForResume` で本文を手元へ写してからフェーズ 2 の `RunManager.resume` を呼ぶ。UI は Mediator に `sync` 領域と `resumeHere` 領域を足し、ヘッダーに同期状態、セッション画面にロック表示と「この PC で再開」を出す。

**Tech Stack:** フェーズ 1 と 2 の構成に加えて、wrangler 4（`^4.133.0`、`packages/cloud` のローカル依存）、@cloudflare/workers-types 4、@cloudflare/vitest-pool-workers（`^0.9.0`）、hono 4（Worker でも同じ版）、Node 22 の `node:crypto`（HKDF、AES-256-GCM）と `node:zlib`（gzip）。

**Spec:** `docs/design.md`（「クラウド同期」「データモデル」「原則」「UI アーキテクチャ」「配布と運用」「決めた前提と未決事項」）

## Global Constraints

- `~/.claude/` 配下への書き込みは、利用者が明示的に押した「この PC で再開」による本文ファイルのコピーと、Settings で明示的に有効化した Claude Code 設定の取り込みだけに限る。それ以外の経路（インデクサ、pull、テスト）は `~/.claude` を読むだけにする。テストは `HANGAR_CLAUDE_DIR` と `HANGAR_HOME` を一時ディレクトリに向けて行い、実物の `~/.claude` と `~/.agent-hangar` と実物の Cloudflare アカウントに触れない。
- サーバは `127.0.0.1` のポート `4177` にだけバインドする。同期の設定は `~/.agent-hangar/cloud.json`（権限 0600）、他端末の本文は `~/.agent-hangar/remote/<端末 ID>/projects/<変換名>/<sessionId>.jsonl`、上書き前のバックアップは `~/.agent-hangar/backups/` に置く。
- 共有テーブルの行は `id`（UUID v7）、`updated_at`（ミリ秒）、`deleted_at`、`origin_device` を持ち、ローカルの書き込みは必ず `upsertShared` と `softDeleteShared` を通して `changes` に 1 行を追記する。pull で受けた行の適用だけは `changes` に追記せず直接書く。競合は行単位で `updated_at` の新しい方を採る。
- メタデータは変更の 1 秒後に未送信分をまとめて push する。pull は起動時、ウィンドウの前面化、30 秒ごと、セッション起動の直前（2 秒で諦める）に行う。本文は変化の 30 秒後に上げ、run の終了で確定する。Claude Code の設定は変化の 5 秒後に push し、起動時と 30 秒ごとに pull する。
- R2 に置くファイルは、参加用の秘密から HKDF（SHA-256）で導出した鍵で AES-256-GCM により 1MB ごとに暗号化する。本文の鍵は `transcripts/<端末 ID>/<sessionId>.jsonl.gz` で端末ごとに分け、上書きは起きない。D1 のメタデータは平文で持つ。
- `~/.claude` へ書き戻すときは、既存のファイルを上書きする前に必ず `~/.agent-hangar/backups/` へ控えを取る。控えを取れなかったファイルは書き戻さない。何を書き換えたかを利用者が後から追えるようにするためである。
- 他端末に生きた run（`ended_at` が null で `heartbeat_at` が 2 分以内）があるセッションはロックされているとみなし、UI では「<端末名> で実行中」と見せて再開とフォークを止める。**このフェーズでは握手による引き継ぎを実装しない。** 手元で続けたいときは「この PC で再開」で本文を降ろし、新しい run を立てる。
- Cloudflare のアカウント ID はコードに埋め込まず `cloud.json` に保存する。wrangler は `packages/cloud` のローカル依存として同梱し、`hangar setup cloud` はデプロイ後に `/health` が通るまで最大 2 分試す。
- 無料枠に収める。D1 は合計 5GB、1 データベース 500MB、書き込み 1 日 10 万行、R2 は 10GB を上限として見積もる。見積もった上限の **80% に達したら同期を自動で一時停止し、トーストで知らせる**。課金される形にはしない。
- push には最小間隔（既定 10 秒）を置く。実行中のセッションは本文が伸びるたびに共有テーブルへ書き込むので、デバウンスだけでは 2 秒ごとに push してしまい、端末 2 台で 1 日の枠を超えうる。
- 単体テストは実物の Cloudflare に接続しない。Worker のテストはローカルの D1 と R2（vitest-pool-workers）で、サーバのテストはメモリ上の偽のクライアントで行う。実物で確かめるのは Task 25 だけで、そこでは `hangar-dev` という試し用の名前で資源を作り、終わったら消す。本番の箱はこのフェーズでは作らない。デプロイの前と片付けの前に利用者の確認を取る。
- UI のコンポーネントは props だけで描く Passive View にし、状態を持たず、`fetch` を呼ばず、他の View を import しない。Mediator と Presenter は DOM に依存しない純関数で、vitest の `node` 環境でテストする。View のテストだけ `jsdom` 環境で行う。
- 日本語の文書とコメントは一文ごとに改行し、地の文でダッシュと中黒を使わない。
- コミットメッセージは英語の Conventional Commits 形式で、末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` を付ける。パッケージ管理は npm（pnpm は使わない）。

## 前提の再確認（実装開始時）

この計画はフェーズ 2 と 3 の実装の上に載る。
次の一覧は 2026-09-19 に `phase3-followups`（`899d9d8`）の実物と照合した結果で、実物の現状をそのまま写している。
実装を始める前に Task 0 でもう一度なぞり、その間に入った変更だけを拾う。

- `packages/shared/src/api.ts`：`RunDto`（`id`、`sessionId`、`deviceId`、`kind`、`tmuxName`、`pid`、`startedAt`、`endedAt`、`endReason`、`heartbeatAt`）、`EndReason = 'exited' | 'killed' | 'lost'`、`LaunchResultDto = { run; sessionId; tabs }`。
- `packages/shared/src/api.ts` の `SettingsDto`：`workspaceRoot`、`claudeDir`、`tmuxPath`、`terminalApp`、`codePath`、`lmStudioUrl`、`lmStudioModel`、`summaryFallback`、`summaryHourlyCap`。
- `packages/shared/src/api.ts` の `BootstrapDto`：`device`、`settings`、`projects`、`sessions`、`live`、`runs`、`tabs`、`usage`、`todos`、`artifacts`、`summaryPending`、`index`、`version`。
- `packages/shared/src/events.ts`：`run.started`、`run.upsert`、`run.ended`、`tab.upsert`。
- `packages/shared/src/intent.ts`：`session.takeover { id; force }`、`sync.now`、`sync.pause { paused }`、`overlay.close` が定義済みである。
- `packages/server/src/runs/queries.ts`：`aliveRunForSession(db, sessionId): RunDto | null`、`listAliveRuns(db, deviceId): RunDto[]`、`getRun(db, id)`。
- `packages/server/src/runs/manager.ts`：`class RunManager` に `start(params)`、`resume(sessionId): LaunchResult`、`fork(sessionId)`、`kill(runId): RunDto`、`on(l: RunListener)`（`runStarted`、`runUpdated`、`runEnded`、`tabChanged`）、`tick()`（`HEARTBEAT_MS = 30_000` ごとの `heartbeat_at` 更新）、`startPolling`、`linkRegistry`、`setTmux`、`recoverAtStartup`、`RunError`（`status: 400 | 404 | 409`）。`kill` の引数は `runId` の 1 つだけで、`this.end(runId, 'killed')` を返す。この計画は Task 16 で `kill(runId, reason: EndReason = 'killed')` に引数を足す。
- `packages/server/src/http/app.ts`：`AppDeps` に `db`、`deviceId`、`deviceName`、`token`、`home`、`port`、`version`、`settings`、`updateSettings`、`live`、`indexer`、`hub`、`runs: RunsApi`、`external: ExternalApi`、`usage`、`memos`、`summary: SummaryApi`、`promote`、`uiDist?`。`POST /api/runs`、`POST /api/sessions/:id/resume`、`POST /api/sessions/:id/fork` の経路。`toSettingsDto(s: Settings): SettingsDto` は 9 項目を写す 1 行の式である。
- `packages/server/src/server.ts`：`RunManager` と `RegistryWatcher` と `IndexerService` の結線。`indexer.on({ progress, sessionChanged, error })` と `registry.onChange(...)` と `runs.on({ runStarted, runUpdated, runEnded, tabChanged })` が hub にイベントを流す。`notifyUnresolved()` という関数は無く、起動の締めは `started = true;` と `console.log(...)` である。
- `packages/server/src/config/paths.ts`：`Settings` は `workspaceRoot`、`claudeDir`、`tmuxPath`、`terminalApp`、`codePath`、`toolsResolved?`、`lmStudioUrl`、`lmStudioModel`、`summaryFallback`、`summaryHourlyCap`。既定値は `defaultSettings()` にあり、`loadSettings` が保存済みの値を重ねる。
- `packages/ui/src/mediator/types.ts`：`Overlay` は `none`、`resolveProject`、`palette`、`notYet`、`newSession`、`promote`、`promoted` の 7 種別である（`newProject` と `confirm` は無い）。`State` は `screen`、`overlay`、`connection`、`reconnectAttempt`、`sessionView`、`search`、`launch`、`waitingSeen`、`promote`、`summaryFailed`、`toasts`、`unresolvedQueue`、`nextToastId`、`resolveDeferred`、`indexPhase`。`Effect` に `api.resume`、`api.fork`、`api.launch`、`api.promote`、`split.resolve` などがある。
- `packages/ui/src/mediator/transition.ts`：`NOT_YET_INTENTS` は `['session.takeover', 'sync.now', 'sync.pause', 'project.new.open', 'project.new.submit']` の 5 件で、この計画は `sync.now` と `sync.pause` の 2 つだけを外す（`session.takeover` は残す）。領域の合成順は `connectionStep`、`screenStep`、`launchStep`、`promoteStep`、`overlayStep`、`sessionViewStep`、`liveStep`、`workbenchStep` の 8 つである。
- `packages/ui/src/presenters/session.ts`：`SessionProps` に `run`、`canResume`、`canFork`、`trustHint`、`split`、`canSplit`、`canPromote`、`artifacts` などがある。`canResume` と `canFork` はどちらも `s.hasTranscript && idle` である。
- `packages/ui/src/presenters/shell.ts`：`ShellProps = { nav; crumbs; searchText; connection; index; indexLabel; usage }` で、`UsageProps = { fiveHour; sevenDay; updatedLabel }`。`presentShell(state, store, now: number)` の `now` は必須引数である。
- `packages/ui/src/presenters/settings.ts`：`presentSettings(_state, store)` は `now` を取らない。`SettingsProps` は `workspaceRoot`、`claudeDir`、`device`、`version`、`index`、`sessionCount`、`projectCount`、`tmuxPath`、`terminalApp`、`codePath`、`mcpInstallCommand`、`lmStudioUrl`、`lmStudioModel`、`summaryFallback`、`summaryHourlyCap`、`summarizerModels`、`summarizerTest`、`statusline`、`statuslineCommand`、`usageAggregate`。
- `packages/ui/src/views/Header.tsx`：`Header({ crumbs, searchText, connection, indexLabel, usage })` で、並びは パンくず、検索欄、`<span className="spacer" />`、`<span className="gauges">`（使用量ゲージ 2 つと最終更新）、新規セッションボタン、索引の進行、接続状態である。同期状態はこの `spacer` の直後、ゲージの手前に置く。
- `packages/ui/src/views/SettingsScreen.tsx`：節の並びは ワークスペース、ツール、MCP、statusline、要約器、使用量、索引、この端末、次のフェーズで追加される設定 である（「Provider」の節は無い）。クラウド同期の節は「要約器」の後、「使用量」の前に置く。
- `packages/ui/src/views/primitives/Icon.tsx`：View は `lucide-react` を直接 import せず、この `Icon` だけを通す。`ICON_NAMES` は `home`、`projects`、`sessions`、`settings`、`add`、`close`、`chevron`、`chevronDown`、`paneClose`、`paneOpen`、`agent`、`shell`、`subagent`、`tool`、`openTerminal`、`openEditor`、`stop`、`resume`、`fork`、`repoint`、`archive`、`unlink`、`warning`、`split`、`edit`、`promote` である。プロジェクトのステータスは `views/primitives/StatusSelect.tsx` を使い、素の `<select>` は書かない。
- `packages/ui/src/styles/`：`tokens.css`、`base.css`、`workbench.css`、`split.css`、`rows.css`、`palette.css`、`settings.css` があり、`main.tsx` がこの順で import する。フェーズ 3 以降は `base.css` を太らせず、View のまとまりごとにファイルを分ける。フェーズ 4 の CSS は `sync.css` を新しく作ってそこに書く。
- `packages/ui/src/Root.tsx`：`Root({ runtime, api?, terminals })` で、`terminals` は必須である。オーバーレイは `ResolveProjectDialog`、`NewSessionDialog`、`CommandPalette`、`PromoteDialog`、`PromotedDialog`、`ToastStack` を並べる。Esc の扱いは入力中と `resolveProject` を除く形で、依存配列は `[rt, overlayKind, shortcutTabs, selectedTabId, canSplit]` である。
- `packages/ui/src/runtime/api.ts`：`ApiClient` は `bootstrap` から `testSummarizer` までの 33 個のメソッドを持つ（`launch`、`resume`、`fork` を含む）。`createApi` の `call` はサーバの `{ error }` を読んで Error のメッセージにし、`post` という補助を持つ。
- `packages/server/src/db/migrations.ts`：マイグレーションは `version: 1` から `version: 5` まである（5 はフェーズ 3 の繰り越しで足した `session_summaries.source_id`）。**この計画のマイグレーションは `version: 6` である。** `sync_state` と `settings_local` と `changes` と `transcript_files` は `version: 1` と `version: 2` で作られている。

## 前提（この計画で決めたこと）

設計文書が定めていない細部を、この計画で次のように決める。
実装後に `docs/design.md` へ反映する（Task 26）。

- **Worker の D1 スキーマ**：共有テーブルをそのまま写さず、`rows`（`table_name:row_id` を鍵にした最新行の写し）と `changes`（サーバ側連番の追記ログ）の 2 表で持つ。Worker は受けた変更を `rows` の `updated_at` と比べて新しいものだけ採り、採ったものだけを `changes` に積む。新しい端末の初回 pull は `GET /rows` で `rows` の写しを受け、以後は `GET /changes?since=` で差分を受ける。`changes` は受信から 14 日を過ぎ、かつ 30 日以内に接続した全端末が読み終えた連番までを、push の 200 回に 1 回削る。
- **スキーマの適用**：Worker は起動後の最初の要求で `create table if not exists` を実行して自分のスキーマを整える（isolate ごとに 1 回）。`hangar setup cloud` は D1 のマイグレーションコマンドを呼ばない。
- **参加用の秘密の登録**：setup が生成した秘密の SHA-256 を `wrangler secret put JOIN_SECRET_HASH` で Worker の secret として渡し、Worker はスキーマを整えるときにその値を `join_secrets` に写す。これで秘密のハッシュは D1 にあり、setup は対話なしで済む。同じ端末で `hangar setup cloud --rotate-secret` を再実行すると新しい秘密に差し替え、古い行は `revoked_at` を立てる。**参加用の秘密は `deriveFileKey` の入力でもあるので、差し替えると R2 の既存ファイルがどの端末でも復号できなくなる。** そのため `--rotate-secret` は確認を必須にし、先に R2 を空にするか、本文を手元へ降ろし終えていることを求める。
- **端末トークン**：`POST /join` は 32 バイトの乱数を base64url にした端末トークンを返し、D1 には SHA-256 だけを置く。同じ端末 ID で再度参加するとトークンを差し替える（前のトークンは無効になる）。
- **Worker の名前と資源名**：既定は Worker `hangar`、D1 `hangar`、R2 `hangar-files`。`--name <n>` を渡すと Worker `<n>`、D1 `<n>`、R2 `<n>-files` にする。実物確認では `hangar-dev` を使う。
- **wrangler の設定ファイル**：リポジトリの `packages/cloud/wrangler.jsonc` はローカル開発とテスト専用で、`database_id` はダミーである。setup は実物の値を入れた設定を `~/.agent-hangar/cloud/wrangler.jsonc` に書き、`main` はリポジトリ内の `packages/cloud/src/index.ts` の絶対パスにする。アカウント ID は wrangler の環境変数 `CLOUDFLARE_ACCOUNT_ID` で渡し、設定ファイルにも書かない。
- **参加トークンの形**：`{ "url": "<Worker の URL>", "secret": "<参加用の秘密>" }` を JSON にして base64url にした文字列。`hangar join <token>` と Settings の「参加トークンの発行」（同じ文字列を再表示）で使う。**渡す相手は自分の別の端末に限る。** 他人と 1 つの箱を共有する使い方は想定せず、別の人は自分の Cloudflare アカウントで `setup cloud` を走らせる。
- **`cloud.json` の内容**：`url`、`joinSecret`、`deviceToken`、`workerName`、`accountId`（参加だけの端末では null）、`dbName`、`bucketName`、`joinedAt`。権限 0600。`hangar join` はサーバが動いている間に実行してもよいが、同期はサーバの再起動後に始まる（CLI がその旨を表示する）。
- **暗号化ファイルの形式**：先頭に `HGR1`（4 バイト）と 8 バイトの乱数の nonce 接頭辞を置き、続けてチャンクごとに `flag`（1 バイト、最終チャンクなら 1）、`len`（4 バイト、big endian）、暗号文、認証タグ（16 バイト）を並べる。nonce は接頭辞と 4 バイトのチャンク番号の連結、AAD はチャンク番号と `flag` である。フェーズ 0 の形式（連番 nonce と `len` 付きチャンク）に接頭辞と `flag` を足したのは、同じ鍵でファイルごとに nonce が重複する状態を避け、末尾の切り詰めを検出するためである。鍵は `hkdfSync('sha256', joinSecret, 'hangar-salt-v1', 'hangar-file-v1', 32)` で、salt は全端末で同じ定数にする（端末ごとに変えると他端末の本文を復号できない）。
- **サブエージェントの本文**：主線と同じく上げる。鍵は `transcripts/<端末 ID>/<sessionId>/subagents/agent-<hex>.jsonl.gz`。
- **`files` 索引の `path`**：本文は `~/.claude` からの相対パス（`projects/<変換名>/<sessionId>.jsonl`）、設定も `~/.claude` からの相対パス（`skills/foo/SKILL.md`）にする。pull 側はこの相対パスをそのまま `remote/<端末 ID>/` の下に写す。
- **本文の索引化の一意性**：同じセッションの主線ファイルが手元と `remote/` の両方にあるときは手元だけを索引化し、手元に無ければ更新時刻が最新の他端末の写しを 1 つだけ索引化する。選ばれなかった写しの `transcript_files` 行と索引は消す。`transcript_files` に `device_id`（null は手元）を足す。
- **他端末のセッションへの書き込み**：`remote/` の本文を索引化するときは `sessions` と `session_summaries` に書かず（本文の持ち主が同期してくる）、端末ローカルの `event_index`、`event_fts`、`session_stats`、`transcript_files` だけを書く。
- **`SessionDto` の追加項目**：`lock`（他端末の生きた run。`deviceId`、`deviceName`、`runId`、`heartbeatAt`、`stale`）と `remoteOnly`（手元に本文ファイルが無く他端末の写しだけがある）。`hasTranscript` は写しがあれば true のままにし、閲覧と検索を許す。
- **「この PC で再開」の Intent**：`session.resumeHere { id; overwrite?: boolean }` を足す。手元に同じ ID の本文が既にあり、そのサイズが他端末の写し以上なら手元をそのまま使って再開する。手元の方が小さければ 409 を返し、UI が確認ダイアログを出し、承諾されたら手元を `~/.agent-hangar/backups/transcripts/` に写してから置き換える。写しが複数の端末にあるときは更新時刻が最新のものを使う。
- **引き継ぎ（このフェーズでは実装しない）**：`EndReason` に `taken_over` を足すこと、`takeover_requests` の握手、`sync_state` の `yielded:<sessionUuid>` による「譲った」記録は、2026-09-19 の判断で後のフェーズに送った。`EndReason` は `'exited' | 'killed' | 'lost'` のままにし、`RunManager.kill` の署名も変えない。`takeover_requests` はフェーズ 1 のマイグレーションで既にある表なので `SHARED_TABLES` には残すが、このフェーズでは誰も書かない。据え置いた設計は Task 16 と Task 17 の後半に残してある。
- **Claude Code の設定の対象**：`CLAUDE.md`、`settings.json`、`settings.json` の `statusLine.command` が指す `~/.claude` 配下のスクリプト、`skills/**`、`memory/**`、`projects/*/memory/**`。`node_modules`、`.git`、`__pycache__`、`.venv`、シンボリックリンク、1MB を超えるファイルは除く。削除は同期しない。実物の `~/.claude` では `memory/` がプロジェクト名ごとのディレクトリを持ち、`projects/<変換名>/memory/` に自動メモリがある。
- **`$HOME` の書き換え**：push では設定ファイル（UTF-8 として読めるもの）の中のホームディレクトリの絶対パスを `__HANGAR_HOME__` に置き換え、pull では各端末のホームに戻す。`$HOME` そのものを目印にすると、設定ファイルに元からある `$HOME` の文字列（hooks のコマンドなど）を絶対パスに変えてしまうため、衝突しない目印を使う。SHA-256 は置き換え後の内容で計算し、端末間で同じ内容なら同じ値になる。
- **Claude Code の設定の同期の有効化**：`Settings.syncClaudeConfig`（既定 false、端末ローカル）を有効にし、かつ Settings の「取り込み内容を確認」で一覧を見て「取り込む」を押すまで、`~/.claude` には何も書かない。push はチェックだけで始まる。
- **設定の書き戻しの控え**：一度「取り込む」を押した後は 30 秒ごとの pull で自動的に書き戻すが、**既存ファイルを上書きする前に必ず `~/.agent-hangar/backups/claude-config/<yyyyMMdd-HHmmss>/<相対パス>` へ控えを取る**。控えの書き込みに失敗したファイルはその回では書き戻さず、`onToast` で知らせて次の pull に回す。控えが取れないまま上書きする経路は作らない。同じ回の書き戻しは 1 つのタイムスタンプのディレクトリにまとめ、利用者が「いつ何を書き換えられたか」を後から追えるようにする。
- **設定の競合**：最後に同期した SHA-256 を `file_sync` に持ち、手元と相手の両方がそこから変わっていたら競合とする。更新時刻の新しい方を本来のパスに置き、古い方を `<name>.conflict-<端末名>-<yyyyMMdd-HHmmss>` として隣に置き、トーストで知らせる。
- **メモの競合**：`project_memos` は共有テーブルなので「新しい方を採る」規則は変えないが、**負けた方の本文を捨てない**。pull で自分の書いた `project_memos` の行が上書きされるとき、上書き前の markdown を `<プロジェクトのメモの隣>/memo.conflict-<端末名>-<yyyyMMdd-HHmmss>.md` として書き出し、トーストで知らせる。メモは利用者が手で書いた文章なので、黙って消えると取り返せない。
- **push の単位**：1 回の `POST /changes` は 40 行まで。Worker は 1 行につき `changes` の挿入と `rows` の更新の 2 文を `batch` で実行するので、1 バッチは 81 文以内になる。
- **push の最小間隔**：連続する push の間を既定 10 秒空ける（`SyncEngine` の `pushMinGapMs`）。デバウンスは「変更が止まってから 1 秒」なので、実行中のセッションのように変更が途切れない相手には効かない。`pushNow` と `syncNow`（利用者が押した「今すぐ同期」）は間隔を無視する。
- **無料枠の見張り**：`sync_state` に日付ごとの `quota:<yyyy-MM-dd>` を持ち、その日に送った `changes` の行数と要求の回数を数える。D1 の書き込み 1 日 10 万行の **80%（8 万行）** か、Worker の要求 1 日 10 万回の 80% に達したら、`SyncEngine` が自分で `setPaused(true)` にして `sync.status` を `paused` にし、トーストで「無料枠の 80% に達したので同期を止めました」と知らせる。日付が変われば数え直し、一時停止は自動では解けない（利用者が Settings かヘッダーで「同期を再開」を押す）。
- **pull の単位**：`GET /changes` と `GET /rows` と `GET /files` は 500 行まで返し、`more` が true なら続けて要求する。
- **圧縮で落ちた変更の検出**：Worker は `changes` を削るときに、削り終えた連番を `meta` の `changes_floor` に残す。`GET /changes?since=` の `since` が `changes_floor` より小さければ、その端末は削られた区間を読み逃しているので、変更を返さずに `410` と `{ error: 'gone', floor }` を返す。受けた端末は `snapshotDone` を落として `GET /rows` からの全件の再同期をやり直す。黙って新しい分だけ返すと、読み逃した行が永遠に届かない。
- **自分の変更の除外**：Worker は認証した端末の変更を `GET /changes` の結果から除く。`GET /rows` は除かない（DB を失った端末の復旧に使う）。ローカルの適用は `changes` 由来なら自端末を飛ばし、`rows` 由来なら飛ばさない。
- **端末行**：サーバ起動時と 10 分ごとに自端末の `devices` 行（`last_seen_at`）を `upsertShared` で書く。Settings の端末一覧はこの表を出す。
- **ローカルの `changes` の掃除**：push 済みで 7 日を過ぎた行は push のたびに消す。
- **片付けの前の取り込み**：`hangar cloud teardown` は、R2 にしか無い本文（手元にも `remote/` にも降りていないもの）があれば、先にそれを降ろすことを必須にする。降ろし終えるか、利用者が「降ろさずに消す」と明示するまで、R2 とバケットを消さない。
- **セッション起動直前の pull の差し込み位置**：`RunManager.start` は同期関数なので触らず、HTTP の `POST /api/runs`、`POST /api/sessions/:id/resume`、`POST /api/sessions/:id/fork` の手前で `SyncEngine.pullBeforeLaunch(2000)` を待つ。
- **前面化の通知**：UI は `window` の `focus` イベントを `RuntimeEvent window.focus` にし、効果 `api.syncFocus` で `POST /api/sync/focus` を叩く。サーバは前回の pull から 5 秒以内なら何もしない。
- **Worker のテスト**：`@cloudflare/vitest-pool-workers` を使う。同じ vitest で workerd 上の D1 と R2 のローカル実装に対して `SELF.fetch` できるため、miniflare を直接組むより設定が少ない。vitest 5 と組み合わせられない場合は、`miniflare` の `new Miniflare({...}).dispatchFetch` に切り替える（テストの中身は同じ）。
- **実装時に docs で確認する Cloudflare の値**：Worker の要求本文の上限（無料枠で 100MB と仮定。本文 1 ファイルはこれ以下なので分割しない）、D1 の 1 文あたりの bind 引数の上限（100 と仮定。`in (...)` の鍵は 40 個以内にする）、D1 の `batch` の文数の上限（明示の上限は無いと仮定し、81 文以内に抑える）、D1 の Time Travel の保持期間（無料枠 7 日）、D1 の無料枠（5GB、500MB/DB、書き込み 10 万行/日）、R2 の無料枠（10GB、Class A 100 万回/月）、`wrangler r2 bucket delete` が空のバケットにしか効かないこと、`wrangler secret put` が標準入力から値を読めること、`wrangler d1 info <name> --json` と `wrangler whoami` の出力形式、`wrangler deploy` の出力に `https://<name>.<subdomain>.workers.dev` が含まれること、vitest-pool-workers の版と vitest 5 の組み合わせ。

## ファイル構成

フェーズ 1 から 3 のファイルに次を足す。`Modify` は既存のファイルである。
引き継ぎのために置く予定だったファイル（`sync/takeover.ts`、`mediator/takeover.ts`、`presenters/takeover.ts`、`views/TakeoverDialog.tsx`）は、このフェーズでは作らない。

```
packages/shared/src/
  cloud.ts                        同期の契約（ChangeIn、ChangeOut、FileEntry、JoinRequest、参加トークン、SHARED_TABLES、TABLE_PK）
  api.ts                          Modify：SessionLockDto、SessionDto.lock と remoteOnly、SyncStatusDto、DeviceDto、ConfigPreviewDto、ResumeHereConflictDto、SettingsDto.syncClaudeConfig、BootstrapDto.sync と devices
  events.ts                       Modify：sync.status、sync.applied、devices.update
  intent.ts                       Modify：session.resumeHere、sync.config.preview、sync.config.apply、sync.joinToken.show
  index.ts                        Modify：cloud.ts の再エクスポート
packages/cloud/
  package.json                    hono、wrangler、workers-types、vitest-pool-workers
  wrangler.jsonc                  ローカル用（ダミーの database_id）
  tsconfig.json、vitest.config.ts
  src/index.ts                    Hono アプリ（/health、/join、/changes、/rows、/files）
  src/schema.ts                   SCHEMA_STATEMENTS、ensureSchema()
  src/util.ts                     sha256Hex()、randomToken()、nowMs()
  src/auth.ts                     authMiddleware()（Bearer の端末トークン）
  src/join.ts                     joinHandler()
  src/changes.ts                  changesApp（POST /、GET /、compaction）、rowsApp（GET /）
  src/files.ts                    filesApp（PUT、GET 一覧、GET 本体、DELETE）
  test/schema.test.ts、test/join.test.ts、test/changes.test.ts、test/files.test.ts
packages/server/src/
  config/cloud.ts                 CloudConfig、cloudConfigPath()、loadCloudConfig()、saveCloudConfig()
  config/paths.ts                 Modify：Settings.syncClaudeConfig
  db/migrations.ts                Modify：version 6（transcript_files.device_id、file_sync）
  db/shared.ts                    Modify：onSharedWrite()
  db/queries.ts                   Modify：lock、remoteOnly、listDevices()
  sync/crypto.ts                  deriveFileKey()、encryptStream()、decryptStream()、sha256Stream()
  sync/client.ts                  CloudClient、HttpCloudClient、CloudError
  sync/state.ts                   SyncStateStore
  sync/apply.ts                   applyRemoteChange()、SHARED_APPLY_ORDER
  sync/engine.ts                  SyncEngine
  sync/uploader.ts                TranscriptUploader、transcriptKey()
  sync/puller.ts                  RemotePuller、remoteTranscriptPath()
  sync/copy.ts                    copyTranscriptForResume()、timestampLabel()
  sync/claudeConfig.ts            listConfigFiles()、normalizeHome()、denormalizeHome()、backupBeforeWrite()、ClaudeConfigSync
  sync/quota.ts                   QuotaCounter（無料枠の 80% で一時停止）
  provider/types.ts               Modify：DiscoveredFile.deviceId
  provider/claude-code/discover.ts  Modify：listRemoteTranscriptFiles()、selectFilesToIndex()
  indexer/indexFile.ts            Modify：remote モード、forgetTranscriptFile()
  indexer/service.ts              Modify：remoteRoot、選別
  http/app.ts                     Modify：/api/sync/*、resume-here、beforeLaunch、bootstrap
  server.ts                       Modify：結線
packages/server/test/
  fake-cloud.ts                   FakeCloudClient
packages/cli/src/
  wrangler.ts                     WranglerRunner、parseAccountId()、parseDatabaseId()、parseWorkerUrl()
  cloud.ts                        runSetupCloud()、runJoin()、cloudStatus()、runTeardown()、waitForHealth()
  index.ts                        Modify：setup cloud、join、cloud status、cloud teardown
packages/ui/src/
  mediator/types.ts               Modify：SyncState、Overlay の confirm と configPreview、効果、RuntimeEvent
  mediator/sync.ts                syncStep()
  mediator/resumeHere.ts          resumeHereStep()
  mediator/transition.ts          Modify：合成、NOT_YET から sync.now と sync.pause を除去
  store/store.ts                  Modify：sync、devices、joinToken、configPreview
  runtime/api.ts                  Modify：syncStatus、syncNow、syncPause、syncFocus、resumeHere、joinToken、configPreview、configPull、devices
  runtime/runtime.ts              Modify：window.focus、新しい効果、409 の扱い
  presenters/shell.ts             Modify：sync
  presenters/session.ts           Modify：lock、remoteOnly、canResume、canResumeHere
  presenters/settings.ts          Modify：cloud
  views/SyncStatus.tsx            ヘッダーの同期状態
  views/Header.tsx                Modify：SyncStatus の配置
  views/SessionScreen.tsx         Modify：ロック表示、この PC で再開
  views/ConfirmDialog.tsx
  views/ConfigPreviewDialog.tsx
  views/SettingsScreen.tsx        Modify：クラウド同期の節
  views/primitives/Icon.tsx       Modify：resumeHere のアイコン名
  styles/sync.css                 同期とロックの CSS（base.css には足さない）
  Root.tsx、main.tsx              Modify：オーバーレイと focus と sync.css の結線
```

## インターフェース一覧

後のタスクが依存する名前と型を先にまとめる。
各タスクの Interfaces はこの一覧の抜粋である。

```ts
// packages/shared/src/cloud.ts
export type SharedTable = 'devices' | 'projects' | 'project_roots' | 'sessions' | 'runs' | 'run_tabs' | 'session_summaries' | 'todos' | 'project_memos' | 'artifacts' | 'artifact_versions' | 'takeover_requests';   // takeover_requests はフェーズ 1 からある表。このフェーズでは誰も書かない
export const SHARED_TABLES: readonly SharedTable[];
export const TABLE_PK: Record<SharedTable, string>;                 // session_summaries と project_memos 以外は 'id'
export type ChangeOp = 'upsert' | 'delete';
export type ChangeIn = { tableName: SharedTable; rowId: string; op: ChangeOp; payload: Record<string, unknown>; updatedAt: number };
export type ChangeOut = ChangeIn & { seq: number; deviceId: string };
export type PushChangesResponse = { seq: number; accepted: number; skipped: number };
export type PullChangesResponse = { changes: ChangeOut[]; nextSeq: number; more: boolean };
export type SnapshotResponse = { changes: ChangeOut[]; nextAfter: string | null; seq: number };
export type FileKind = 'transcript' | 'config';
export type FileMetaIn = { key: string; path: string; kind: FileKind; sha256: string; size: number; mtime: number; encrypted: boolean };
export type FileEntry = FileMetaIn & { seq: number; deviceId: string; uploadedAt: number; storedSize: number };
export type ListFilesResponse = { files: FileEntry[]; nextSeq: number; more: boolean };
export type JoinRequest = { secret: string; device: { id: string; name: string; platform: string } };
export type JoinResponse = { deviceToken: string; deviceId: string };
export type JoinToken = { url: string; secret: string };
export const CLOUD_HEADERS: { readonly path: 'x-hangar-path'; readonly kind: 'x-hangar-kind'; readonly sha256: 'x-hangar-sha256'; readonly size: 'x-hangar-size'; readonly mtime: 'x-hangar-mtime'; readonly encrypted: 'x-hangar-encrypted' };
export const MAX_PUSH_BATCH = 40;
export const PULL_LIMIT = 500;
export function encodeJoinToken(t: JoinToken): string;              // base64url(JSON)
export function decodeJoinToken(s: string): JoinToken;              // 不正なら Error
export function transcriptKey(deviceId: string, sessionUuid: string, agentId: string | null): string;
export function configKey(rel: string): string;                     // 'config/' + rel

// packages/shared/src/api.ts（追加と変更）
export type SessionLockDto = { deviceId: string; deviceName: string; runId: string; heartbeatAt: number; stale: boolean };
export type SessionDto = { ...フェーズ 1 から 3 の項目...; lock: SessionLockDto | null; remoteOnly: boolean };
export type SyncStateKind = 'off' | 'idle' | 'pushing' | 'pulling' | 'paused' | 'error';
export type SyncStatusDto = { state: SyncStateKind; url: string | null; lastPushAt: number | null; lastPullAt: number | null; pending: number; error: string | null; deviceCount: number; claudeConfig: { enabled: boolean; confirmed: boolean } };
export type DeviceDto = { id: string; name: string; platform: string; lastSeenAt: number | null; self: boolean };
export type ConfigPreviewAction = 'create' | 'overwrite' | 'conflict' | 'skip';
export type ConfigPreviewEntryDto = { path: string; action: ConfigPreviewAction; localMtime: number | null; remoteMtime: number; remoteDevice: string; size: number };
export type ConfigPreviewDto = { entries: ConfigPreviewEntryDto[]; confirmed: boolean };
export type ResumeHereConflictDto = { error: 'local_smaller'; localSize: number; remoteSize: number };
export type SettingsDto = { ...; syncClaudeConfig: boolean };
export type BootstrapDto = { ...; sync: SyncStatusDto; devices: DeviceDto[] };

// packages/shared/src/events.ts（追加）
  | { type: 'sync.status'; status: SyncStatusDto }
  | { type: 'sync.applied'; table: SharedTable; rowId: string }
  | { type: 'devices.update'; devices: DeviceDto[] }

// packages/shared/src/intent.ts（追加）
  | { type: 'session.resumeHere'; id: SessionId; overwrite?: boolean }
  | { type: 'sync.config.preview' } | { type: 'sync.config.apply' }
  | { type: 'sync.joinToken.show' }

// packages/server/src/config/cloud.ts
export type CloudConfig = { url: string; joinSecret: string; deviceToken: string; workerName: string | null; accountId: string | null; dbName: string | null; bucketName: string | null; joinedAt: number };
export function cloudConfigPath(home: string): string;              // <home>/cloud.json
export function loadCloudConfig(home: string): CloudConfig | null;
export function saveCloudConfig(home: string, c: CloudConfig): void;   // 0600
export function remoteRoot(home: string): string;                   // <home>/remote
export function backupsRoot(home: string): string;                  // <home>/backups

// packages/server/src/db/shared.ts（追加）
export function onSharedWrite(cb: (table: string, rowId: string, db: Db) => void): () => void;   // upsertShared と softDeleteShared の後に呼ばれる

// packages/server/src/db/queries.ts（変更と追加）
export function listSessions(db: Db, live: LiveSessionDto[], opts?: { projectId?: string; ids?: string[]; deviceId?: string; now?: () => number }): SessionDto[];
export function getSession(db: Db, live: LiveSessionDto[], id: string, opts?: { deviceId?: string; now?: () => number }): SessionDto | null;
export function listDevices(db: Db, selfId: string): DeviceDto[];
export const LOCK_STALE_MS = 120_000;

// packages/server/src/sync/crypto.ts
export const CHUNK_SIZE = 1 << 20;
export function deriveFileKey(joinSecret: string): Buffer;          // 32 バイト
export function encryptStream(key: Buffer, noncePrefix?: Buffer): Transform;
export function decryptStream(key: Buffer): Transform;              // 改竄と切り詰めは 'error' を出す
export function encryptBuffer(key: Buffer, data: Buffer): Promise<Buffer>;
export function decryptBuffer(key: Buffer, data: Buffer): Promise<Buffer>;
export function sha256Stream(input: Readable): Promise<string>;     // hex
export function sha256Hex(data: Buffer | string): string;

// packages/server/src/sync/client.ts
export class CloudError extends Error { constructor(public readonly status: number, message: string); }
export interface CloudClient {
  health(): Promise<{ ok: boolean; version: string }>;
  pushChanges(changes: ChangeIn[]): Promise<PushChangesResponse>;
  pullChanges(since: number, limit: number): Promise<PullChangesResponse>;
  snapshot(after: string | null, limit: number): Promise<SnapshotResponse>;
  putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }>;
  getFile(key: string): Promise<Readable>;
  listFiles(since: number, limit: number): Promise<ListFilesResponse>;
  deleteFile(key: string): Promise<void>;
}
export class HttpCloudClient implements CloudClient { constructor(o: { url: string; token: string; fetch?: typeof fetch }); }

// packages/server/test/fake-cloud.ts
export class FakeCloudClient implements CloudClient {
  offline: boolean;                       // true なら全メソッドが CloudError(0) を投げる
  readonly changes: ChangeOut[]; readonly rows: Map<string, ChangeOut>; readonly files: Map<string, { entry: FileEntry; body: Buffer }>;
  constructor(o?: { deviceId?: string });   // 認証した端末として振る舞う端末 ID（自分の変更の除外に使う）
  asDevice(deviceId: string): FakeCloudClient;   // 同じストアを共有し、別の端末として振る舞うクライアント
  calls: { method: string; args: unknown[] }[];
}

// packages/server/src/sync/state.ts
export type SyncStateKey = 'lastSeq' | 'filesSeq' | 'lastPushAt' | 'lastPullAt' | 'paused' | 'lastError' | 'configPullConfirmed' | 'snapshotDone' | `quota:${string}`;
export class SyncStateStore {
  constructor(db: Db);
  get(key: SyncStateKey): string | null;
  getNumber(key: SyncStateKey, fallback: number): number;
  set(key: SyncStateKey, value: string | number | boolean | null): void;
  isYielded(sessionUuid: string): boolean; setYielded(sessionUuid: string, yielded: boolean): void;
}

// packages/server/src/sync/apply.ts
export const SHARED_APPLY_ORDER: readonly SharedTable[];           // 親から子へ
export function applyRemoteChange(db: Db, c: ChangeOut, o: { ownDeviceId: string; skipOwn: boolean }): 'applied' | 'skipped';
export function applyRemoteBatch(db: Db, changes: ChangeOut[], o: { ownDeviceId: string; skipOwn: boolean }): ChangeOut[];   // 適用した変更を返す

// packages/server/src/sync/engine.ts
export type SyncEngineDeps = { db: Db; deviceId: string; client: CloudClient | null; now?: () => number; timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval }; pushDebounceMs?: number; pushMinGapMs?: number; pullIntervalMs?: number; focusMinGapMs?: number; url?: string | null; quota?: QuotaCounter };
export type SyncListener = { status?(s: SyncStatusDto): void; applied?(c: ChangeOut): void; pulled?(): void; toast?(level: 'info' | 'error', message: string): void };

// packages/server/src/sync/quota.ts
export const QUOTA_LIMITS = { d1Writes: 100_000, requests: 100_000 } as const;
export const QUOTA_STOP_RATIO = 0.8;
export class QuotaCounter {
  constructor(o: { state: SyncStateStore; now?: () => number; limits?: typeof QUOTA_LIMITS; ratio?: number });
  note(o: { rows?: number; requests?: number }): void;   // 日付ごとに足す
  today(): { rows: number; requests: number };
  exceeded(): boolean;                                   // どちらかが 80% に達したら true
}
export class SyncEngine {
  constructor(deps: SyncEngineDeps);
  on(l: SyncListener): () => void;
  status(): SyncStatusDto;
  start(): Promise<void>;                 // 初回 pull（未完なら snapshot）、push、タイマー、onSharedWrite の購読
  stop(): void;
  noteLocalChange(): void;                // 1 秒後に push
  pushNow(): Promise<{ pushed: number }>;
  pullNow(): Promise<{ applied: number }>;
  syncNow(): Promise<void>;               // push → pull
  pullBeforeLaunch(timeoutMs?: number): Promise<boolean>;   // 既定 2000。時間内に終わらなければ false
  onFocus(): Promise<void>;
  setPaused(paused: boolean): void;
  pending(): number;                      // pushed_at が null の changes の件数
  setClaudeConfigStatus(s: { enabled: boolean; confirmed: boolean }): void;
}

// packages/server/src/sync/uploader.ts
export type UploadTarget = { path: string; sessionId: string; agentId: string | null };   // sessionId は Claude の UUID
export type UploaderDeps = { db: Db; deviceId: string; claudeDir: string; client: CloudClient; key: Buffer; state: SyncStateStore; now?: () => number; debounceMs?: number; timers?: SyncEngineDeps['timers']; isPaused: () => boolean; onError?: (path: string, message: string) => void };
export class TranscriptUploader {
  constructor(deps: UploaderDeps);
  noteChanged(f: { path: string; sessionId: string; agentId: string | null }): void;   // 30 秒後に上げる。sessionId は Claude の UUID
  flushSession(sessionUuid: string): Promise<void>;   // run の終了で即時に上げる
  flushAll(): Promise<void>;
  uploadFile(f: { path: string; sessionId: string; agentId: string | null }): Promise<'uploaded' | 'unchanged' | 'skipped'>;
  stop(): void;
}

// packages/server/src/sync/puller.ts
export type PullerDeps = { db: Db; deviceId: string; home: string; client: CloudClient; key: Buffer; state: SyncStateStore; onConfigEntries?: (entries: FileEntry[]) => Promise<void>; onError?: (key: string, message: string) => void };
export function remoteTranscriptPath(home: string, deviceId: string, rel: string): string;   // <home>/remote/<deviceId>/<rel>。rel は projects/ で始まり .. を含まない
export class RemotePuller {
  constructor(deps: PullerDeps);
  pullNow(): Promise<{ downloaded: number; configEntries: number }>;
  latestRemoteMain(sessionUuid: string): { deviceId: string; path: string; size: number; mtime: number } | null;   // 手元に降ろした写しのうち最新
}

// packages/server/src/sync/copy.ts
export function timestampLabel(ts: number): string;                 // yyyyMMdd-HHmmss
export type CopyResult = { kind: 'copied'; target: string; from: string; bytes: number; backedUp: string | null } | { kind: 'kept'; target: string } | { kind: 'ask'; localSize: number; remoteSize: number } | { kind: 'none' };
export function copyTranscriptForResume(o: { db: Db; home: string; claudeDir: string; sessionId: string; overwrite: boolean; now?: () => number }): CopyResult;

// packages/server/src/sync/takeover.ts（このフェーズでは作らない。Task 16 と Task 17 の後半に据え置いた設計）
export type RequesterState = { phase: TakeoverPhase; requestId: string | null; runId: string; sessionId: string; force: boolean; since: number; message: string | null };
export type RequesterInput = { kind: 'start'; now: number } | { kind: 'applied'; state: 'acked' | 'cancelled' | 'forced'; requestId: string } | { kind: 'tick'; now: number } | { kind: 'copied' } | { kind: 'resumed' } | { kind: 'failed'; message: string } | { kind: 'cancel' };
export type RequesterAction = { kind: 'writeRequest'; state: 'requested' | 'forced' | 'cancelled' } | { kind: 'endRemoteRun' } | { kind: 'push' } | { kind: 'pullAndCopy' } | { kind: 'resume' } | { kind: 'notify' };
export function requesterStep(s: RequesterState, input: RequesterInput, timeoutMs?: number): { state: RequesterState; actions: RequesterAction[] };
export type ResponderState = { phase: 'idle' | 'waitingIdle' | 'finalizing' | 'done'; requestId: string; runId: string; sessionUuid: string; since: number };
export type ResponderInput = { kind: 'start'; now: number } | { kind: 'tick'; now: number; busy: boolean } | { kind: 'finalized' } | { kind: 'forced' };
export type ResponderAction = { kind: 'finalize' } | { kind: 'kill'; reason: 'taken_over' } | { kind: 'ack' } | { kind: 'yield' } | { kind: 'push' };
export function responderStep(s: ResponderState, input: ResponderInput, idleTimeoutMs?: number): { state: ResponderState; actions: ResponderAction[] };
export const ACK_TIMEOUT_MS = 90_000;
export const IDLE_TIMEOUT_MS = 60_000;
export function isTakeoverDone(phase: TakeoverPhase): boolean;
export type TakeoverDeps = { db: Db; deviceId: string; engine: { on(l: SyncListener): () => void; pushNow(): Promise<{ pushed: number }>; pullNow(): Promise<{ applied: number }> }; puller: { pullNow(): Promise<{ downloaded: number; configEntries: number }> }; runs: { resume(sessionId: string): LaunchResultDto; kill(runId: string, reason?: EndReason): RunDto }; uploader: { flushSession(sessionUuid: string): Promise<void> }; state: SyncStateStore; home: string; claudeDir: string; isBusy: (sessionUuid: string) => boolean; onUpdate: (u: TakeoverUpdateDto) => void; onToast: (level: 'info' | 'error', message: string) => void; now?: () => number; timers?: SyncEngineDeps['timers']; ackTimeoutMs?: number; idleTimeoutMs?: number };
export class TakeoverCoordinator { constructor(deps: TakeoverDeps); request(sessionId: string, force: boolean): { requestId: string }; cancel(sessionId: string): void; current(sessionId: string): RequesterState | null; stop(): void; }
export class TakeoverResponder { constructor(deps: TakeoverDeps); start(): void; stop(): void; }

// packages/server/src/sync/claudeConfig.ts
export const HOME_MARKER = '__HANGAR_HOME__';
export const CONFIG_MAX_BYTES = 1 << 20;
export type ConfigFile = { rel: string; abs: string; size: number; mtime: number };
export function listConfigFiles(claudeDir: string): ConfigFile[];
export function isConfigPath(rel: string): boolean;                 // 監視の絞り込み
export function statusLineRel(claudeDir: string): string | null;    // statusLine.command が ~/.claude 配下を指すとき
export function normalizeHome(text: string, home: string): string;
export function denormalizeHome(text: string, home: string): string;
export function isTextBuffer(buf: Buffer): boolean;
export type ClaudeConfigDeps = { db: Db; deviceId: string; deviceName: string; claudeDir: string; home: string; client: CloudClient; key: Buffer; state: SyncStateStore; enabled: () => boolean; onToast: (level: 'info' | 'error', message: string) => void; now?: () => number; debounceMs?: number; timers?: SyncEngineDeps['timers']; homeDir?: string };
export function backupBeforeWrite(o: { home: string; claudeDir: string; rel: string; stamp: string }): string | null;   // 控えの置き先。既存ファイルが無ければ null
export class ClaudeConfigSync {
  constructor(deps: ClaudeConfigDeps);
  start(): void; stop(): void;
  pushChanged(): Promise<number>;
  preview(entries?: FileEntry[]): ConfigPreviewDto;   // 省くと最後の pull で見た一覧を使う
  applyPull(entries: FileEntry[]): Promise<{ applied: number; conflicts: number; backedUp: number }>;   // 有効かつ確認済みのときだけ書く。上書きの前に必ず控えを取る
  confirm(): void;
  pendingRemote(): FileEntry[];           // 最後の pull で見た設定ファイルの一覧
}

// packages/server/src/provider/types.ts（変更）
export type DiscoveredFile = { path: string; sessionId: string; agentId: string | null; deviceId: string | null };   // null は手元
// packages/server/src/provider/claude-code/discover.ts（追加）
export function listRemoteTranscriptFiles(remoteRootDir: string): DiscoveredFile[];
export type SelectOptions = { statOf?: (p: string) => { mtimeMs: number } | null; isYielded?: (sessionUuid: string) => boolean };
export function selectFilesToIndex(files: DiscoveredFile[], opts?: SelectOptions): { index: DiscoveredFile[]; drop: DiscoveredFile[] };
// packages/server/src/indexer/indexFile.ts（変更と追加）
export type IndexFileOptions = { deviceId: string; indexerVersion?: number; cwdFallback?: string; remote?: boolean };
export type IndexFileResult = { sessionId: string; providerSessionId: string; appended: number; changed: boolean; badLines: number; skipped: boolean };
export function findSession(db: Db, providerSessionId: string): string | null;
export function forgetTranscriptFile(db: Db, filePath: string): void;
// packages/server/src/indexer/service.ts（変更）
export type IndexerServiceOptions = { db: Db; deviceId: string; claudeDir: string; isRunning: (providerSessionId: string) => boolean; pollMs?: number; debounceMs?: number; remoteRoot?: string; isYielded?: (sessionUuid: string) => boolean };
export type IndexerListener = { progress?: ...; sessionChanged?: (e: { sessionId: string; providerSessionId: string; agentId: string | null; appended: number; deviceId: string | null; path: string }) => void; error?: ... };

// packages/server/src/http/app.ts（AppDeps の追加）
export type SyncApi = Pick<SyncEngine, 'status' | 'syncNow' | 'setPaused' | 'onFocus' | 'pullBeforeLaunch'>;
export type ConfigSyncApi = { preview(): ConfigPreviewDto; pull(): Promise<{ applied: number; conflicts: number }> };
export type AppDeps = { ...; sync: SyncApi; resumeHere: (sessionId: string, overwrite: boolean) => LaunchResultDto | ResumeHereConflictDto; configSync: ConfigSyncApi | null; joinToken: () => string | null; devices: () => DeviceDto[] };

// packages/cli/src/wrangler.ts
export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; input?: string }) => Promise<ExecResult>;
export class WranglerRunner { constructor(o: { cloudDir: string; accountId: string | null; exec?: Exec; log?: (line: string) => void }); run(args: string[], input?: string): Promise<ExecResult>; }
export function parseAccountId(whoami: string): string | null;    // 32 桁の hex
export function parseDatabaseId(text: string): string | null;     // UUID
export function parseWorkerUrl(deployLog: string): string | null;   // https://...workers.dev

// packages/cli/src/cloud.ts
export type SetupCloudOptions = { home: string; name?: string; rotateSecret?: boolean; wrangler?: WranglerRunner; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; device: { id: string; name: string; platform: string }; log?: (line: string) => void; confirm?: (q: string) => Promise<boolean> };
export function runSetupCloud(o: SetupCloudOptions): Promise<{ url: string; joinToken: string }>;
export function waitForHealth(url: string, o: { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number }): Promise<boolean>;
export function runJoin(o: { home: string; token: string; device: SetupCloudOptions['device']; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<CloudConfig>;
export function cloudStatus(o: { home: string; fetch?: typeof fetch; port?: number }): Promise<string>;
export function runTeardown(o: { home: string; wrangler?: WranglerRunner; fetch?: typeof fetch; confirm: (q: string) => Promise<string>; log?: (line: string) => void; cloudDir?: string }): Promise<boolean>;

// packages/ui/src/mediator/types.ts（追加）
export type SyncState = { kind: 'off' } | { kind: 'idle'; lastAt: number | null } | { kind: 'pushing' } | { kind: 'pulling' } | { kind: 'paused' } | { kind: 'error'; message: string };
export type Overlay = ... | { kind: 'confirm'; confirm: { kind: 'overwriteTranscript'; sessionId: string; localSize: number; remoteSize: number } } | { kind: 'configPreview' };
export type RuntimeEvent = ... | { type: 'window.focus' } | { type: 'api.conflict'; kind: 'resumeHere'; sessionId: string; localSize: number; remoteSize: number };
export type Effect = ... | { kind: 'api.syncNow' } | { kind: 'api.syncPause'; paused: boolean } | { kind: 'api.syncFocus' } | { kind: 'api.resumeHere'; sessionId: string; overwrite: boolean } | { kind: 'api.configPreview' } | { kind: 'api.configPull' } | { kind: 'api.joinToken' };
export type ConfirmRequest = { kind: 'overwriteTranscript'; sessionId: string; localSize: number; remoteSize: number };
export type State = { ...; sync: SyncState; pending: number };

// packages/ui/src/mediator/sync.ts と resumeHere.ts
export function toSyncState(s: SyncStatusDto): SyncState;
export function syncStep(state: State, input: Input): Step | null;
export function resumeHereStep(state: State, input: Input): Step | null;

// packages/ui/src/store/store.ts（追加）
export type Store = { ...; sync: SyncStatusDto | null; devices: DeviceDto[]; joinToken: string | null; configPreview: ConfigPreviewDto | null };
export function applyJoinToken(store: Store, token: string | null): Store;
export function applyConfigPreview(store: Store, preview: ConfigPreviewDto | null): Store;

// packages/ui/src/runtime/api.ts（追加）
export class ApiConflictError extends Error { constructor(public readonly body: ResumeHereConflictDto); }
export type ApiClient = { ...; syncStatus(): Promise<SyncStatusDto>; syncNow(): Promise<SyncStatusDto>; syncPause(paused: boolean): Promise<SyncStatusDto>; syncFocus(): Promise<void>; resumeHere(sessionId: string, overwrite: boolean): Promise<LaunchResultDto>; joinToken(): Promise<{ token: string | null }>; configPreview(): Promise<ConfigPreviewDto>; configPull(): Promise<{ applied: number; conflicts: number }>; devices(): Promise<DeviceDto[]> };

// packages/ui/src/runtime/runtime.ts（追加）
export type RuntimeDeps = { ...; onWindowFocus?: (cb: () => void) => () => void };

// packages/ui/src/presenters/shell.ts（追加）
export type SyncProps = { visible: boolean; state: SyncStateKind; label: string; pending: number; paused: boolean };
export type ShellProps = { ...; sync: SyncProps };
export function presentShell(state: State, store: Store, now?: number): ShellProps;   // now の既定は Date.now()

// packages/ui/src/presenters/session.ts（追加）
export type SessionProps = { ...; lock: { deviceName: string; stale: boolean; heartbeat: string } | null; remoteOnly: boolean; canResume: boolean; canResumeHere: boolean };


// packages/ui/src/presenters/settings.ts（追加）
export type CloudSettingsProps = { configured: boolean; url: string | null; state: SyncStateKind; paused: boolean; lastPullAt: string; pending: number; devices: { name: string; platform: string; lastSeen: string; self: boolean }[]; joinToken: string | null; syncClaudeConfig: boolean; configConfirmed: boolean };
export type SettingsProps = { ...; cloud: CloudSettingsProps };
export function presentSettings(state: State, store: Store, now?: number): SettingsProps;   // 既存は 2 引数。now を足し、既定は Date.now()

// packages/ui/src/views（追加）
export function SyncStatus(props: SyncProps): JSX.Element | null;
export function ConfirmDialog(props: { confirm: ConfirmRequest }): JSX.Element;
export function ConfigPreviewDialog(props: { preview: ConfigPreviewDto | null }): JSX.Element;
```

---

### Task 0: フェーズ 2 と 3 の実装との照合

**Files:**
- Read: `packages/shared/src/api.ts`、`packages/shared/src/events.ts`、`packages/shared/src/intent.ts`、`packages/server/src/runs/manager.ts`、`packages/server/src/runs/queries.ts`、`packages/server/src/http/app.ts`、`packages/server/src/server.ts`、`packages/server/src/config/paths.ts`、`packages/server/src/db/migrations.ts`、`packages/ui/src/mediator/types.ts`、`packages/ui/src/mediator/transition.ts`、`packages/ui/src/presenters/session.ts`、`packages/ui/src/presenters/shell.ts`、`packages/ui/src/presenters/settings.ts`、`packages/ui/src/runtime/api.ts`、`packages/ui/src/views/Header.tsx`、`packages/ui/src/views/SettingsScreen.tsx`
- Create: `docs/plans/phase4-mismatches.md`（この再確認で新しい食い違いが出たときだけ）

**Interfaces:**
- Consumes: 「前提の再確認」の一覧。
- Produces: 食い違いの一覧。各タスクの実装者は着手前にこの一覧を読む。

> **2026-09-19 に実施済み。** `phase3-followups`（`899d9d8`）の実物と照合し、見つかった食い違いはこの計画の本文に直接取り込んだ。
> 記録は `.superpowers/sdd/phase4-sync/task-0-report.md` にある。
> このタスクは「その後にコードが動いていないか」を確かめる短い再点検として残す。
> 主な確定事項は次のとおりである。
>
> - マイグレーションの最終番号は `5` なので、この計画のマイグレーションは **`version: 6`** である。
> - `NOT_YET_INTENTS` は 5 件（`session.takeover`、`sync.now`、`sync.pause`、`project.new.open`、`project.new.submit`）である。この計画が外すのは `sync.now` と `sync.pause` の 2 つで、`session.takeover` は残す。
> - `RunManager.kill` の引数は `runId` の 1 つだけである。
> - 領域の合成順は 8 つ（`connectionStep`、`screenStep`、`launchStep`、`promoteStep`、`overlayStep`、`sessionViewStep`、`liveStep`、`workbenchStep`）である。
> - `SettingsScreen` に「Provider」の節は無い。クラウド同期は「要約器」と「使用量」の間に置く。
> - CSS は `base.css` に足さず、`packages/ui/src/styles/sync.css` を新しく作る。

- [ ] **Step 1: フェーズ 2 の名前を grep で確かめる**

```bash
cd /Users/satog/workspace/agent-hangar
grep -n "export type EndReason\|export type RunDto\|export type LaunchResultDto\|export type SettingsDto\|export type BootstrapDto" packages/shared/src/api.ts
grep -n "'run.started'\|'run.upsert'\|'run.ended'\|'tab.upsert'" packages/shared/src/events.ts
grep -n "export function aliveRunForSession\|export function listAliveRuns\|export function getRun" packages/server/src/runs/queries.ts
grep -n "  resume(\|  kill(\|  on(\|  tick(\|class RunError\|HEARTBEAT_MS" packages/server/src/runs/manager.ts
grep -n "export type AppDeps\|export type RunsApi\|export function toSettingsDto\|api.post('/runs'\|/sessions/:id/resume\|/sessions/:id/fork" packages/server/src/http/app.ts
grep -n "runs.on(\|registry.onChange(\|indexer.on(\|new RunManager(" packages/server/src/server.ts
grep -n "export type Settings" packages/server/src/config/paths.ts
grep -n "version: " packages/server/src/db/migrations.ts
```

Expected: すべての名前が見つかる。`kill(runId: string)` の引数が 1 つだけであること、`migrations.ts` の最後の `version` が `5` であることを確かめる（増えていれば、この計画の `version: 6` をその次の番号に読み替える）。

- [ ] **Step 2: UI 側の名前を grep で確かめる**

```bash
grep -n "export type Overlay\|export type Effect\|export type RuntimeEvent\|export type State" packages/ui/src/mediator/types.ts
grep -n "NOT_YET_INTENTS\|for (const step of" packages/ui/src/mediator/transition.ts
grep -n "export type SessionProps\|canResume\|canFork" packages/ui/src/presenters/session.ts
grep -n "export type ShellProps" packages/ui/src/presenters/shell.ts
grep -n "export type SettingsProps" packages/ui/src/presenters/settings.ts
grep -n "resume(\|fork(\|launch(" packages/ui/src/runtime/api.ts
grep -n "新規セッション\|usage\|Gauge" packages/ui/src/views/Header.tsx
grep -n "<h2 className=\"h2\">" packages/ui/src/views/SettingsScreen.tsx
ls packages/ui/src/styles packages/ui/src/views/primitives
```

Expected: 「前提の再確認」の一覧と一致する。`NOT_YET_INTENTS` は 5 件で、合成順は 8 つで、`Overlay` は 7 種別である。

- [ ] **Step 3: 食い違いを記録する**

「前提の再確認」と一致していればこの Step は飛ばす。
2026-09-19 の照合の後にコードが動いていたときだけ、`docs/plans/phase4-mismatches.md` に次の形で書く。

```markdown
# フェーズ 4 の前提との食い違い

| 前提 | 実物 | 影響するタスク | 対応 |
| --- | --- | --- | --- |
| `RunManager.kill(runId)` | `kill(runId, opts)` | Task 16、Task 17 | 第二引数の形を実物に合わせる |
```

`migrations.ts` の最後の `version` が 5 でなければ、Task 8 の `version: 6` をその次の番号に読み替える旨をここに書く。

- [ ] **Step 4: コミット**

食い違いの記録を作ったときだけコミットする。

```bash
git add docs/plans/phase4-mismatches.md
git commit -m "docs: record mismatches between phase 4 plan and phase 2/3 code"
```

---

### Task 1: shared の同期契約、DTO、イベント、Intent

**Files:**
- Create: `packages/shared/src/cloud.ts`
- Modify: `packages/shared/src/api.ts`、`packages/shared/src/events.ts`、`packages/shared/src/intent.ts`、`packages/shared/src/index.ts`
- Test: `packages/shared/src/cloud.test.ts`

**Interfaces:**
- Produces: 「インターフェース一覧」の `packages/shared/src/cloud.ts` の全部と、`api.ts`、`events.ts`、`intent.ts` の追加項目。
- `SessionDto` に `lock` と `remoteOnly` を足すので、フェーズ 1 から 3 のテストで `SessionDto` を丸ごと組み立てている箇所に `lock: null, remoteOnly: false` を足す。2026-09-19 時点の対象は `packages/server/src/db/queries.test.ts`、`packages/shared/src/api.test.ts`、`packages/ui/src/store/store.test.ts`、`packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/presenters/palette.test.ts`、`packages/ui/src/runtime/runtime.test.ts`、`packages/ui/src/Root.test.tsx`、`packages/ui/src/views/misc.test.tsx`、`packages/ui/src/views/SessionScreen.test.tsx`、`packages/ui/src/views/SessionRows.test.tsx` の 10 ファイルである。

- [ ] **Step 1: 失敗するテストを書く**

`packages/shared/src/cloud.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { configKey, decodeJoinToken, encodeJoinToken, SHARED_TABLES, TABLE_PK, transcriptKey } from './cloud.ts';

describe('参加トークン', () => {
  it('URL と秘密を base64url の JSON で往復する', () => {
    const t = { url: 'https://hangar.example.workers.dev', secret: 'abc+/=xyz' };
    const s = encodeJoinToken(t);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeJoinToken(s)).toEqual(t);
  });
  it('壊れた文字列と欠けた項目は Error', () => {
    expect(() => decodeJoinToken('!!!')).toThrow();
    expect(() => decodeJoinToken(encodeJoinToken({ url: 'x', secret: '' } as never))).toThrow('参加トークン');
    expect(() => decodeJoinToken(btoa('{"url":1}'))).toThrow('参加トークン');
  });
});

describe('鍵と表', () => {
  it('本文の鍵は端末 ID とセッション UUID を含み、サブエージェントは下に置く', () => {
    expect(transcriptKey('dev1', 'u1', null)).toBe('transcripts/dev1/u1.jsonl.gz');
    expect(transcriptKey('dev1', 'u1', 'abc')).toBe('transcripts/dev1/u1/subagents/agent-abc.jsonl.gz');
    expect(configKey('skills/x/SKILL.md')).toBe('config/skills/x/SKILL.md');
  });
  it('共有テーブルの主キーは session_summaries と project_memos だけが違う', () => {
    expect(SHARED_TABLES).toHaveLength(12);
    expect(TABLE_PK.session_summaries).toBe('session_id');
    expect(TABLE_PK.project_memos).toBe('project_id');
    expect(TABLE_PK.runs).toBe('id');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/shared`
Expected: FAIL（`./cloud.ts` が無い）

- [ ] **Step 3: cloud.ts を書く**

`packages/shared/src/cloud.ts`：

```ts
/** 端末とクラウド Worker の間の契約。サーバ、CLI、Worker が共有する。 */
export type SharedTable = 'devices' | 'projects' | 'project_roots' | 'sessions' | 'runs' | 'run_tabs' | 'session_summaries' | 'todos' | 'project_memos' | 'artifacts' | 'artifact_versions' | 'takeover_requests';

/** 親から子の順。pull の適用はこの順に並べ替えて外部キーの順序違反を避ける。 */
export const SHARED_TABLES: readonly SharedTable[] = ['devices', 'projects', 'project_roots', 'sessions', 'runs', 'run_tabs', 'session_summaries', 'todos', 'project_memos', 'artifacts', 'artifact_versions', 'takeover_requests'];

export const TABLE_PK: Record<SharedTable, string> = {
  devices: 'id', projects: 'id', project_roots: 'id', sessions: 'id', runs: 'id', run_tabs: 'id',
  session_summaries: 'session_id', todos: 'id', project_memos: 'project_id', artifacts: 'id', artifact_versions: 'id', takeover_requests: 'id',
};

export type ChangeOp = 'upsert' | 'delete';
export type ChangeIn = { tableName: SharedTable; rowId: string; op: ChangeOp; payload: Record<string, unknown>; updatedAt: number };
export type ChangeOut = ChangeIn & { seq: number; deviceId: string };
export type PushChangesResponse = { seq: number; accepted: number; skipped: number };
export type PullChangesResponse = { changes: ChangeOut[]; nextSeq: number; more: boolean };
export type SnapshotResponse = { changes: ChangeOut[]; nextAfter: string | null; seq: number };

export type FileKind = 'transcript' | 'config';
export type FileMetaIn = { key: string; path: string; kind: FileKind; sha256: string; size: number; mtime: number; encrypted: boolean };
export type FileEntry = FileMetaIn & { seq: number; deviceId: string; uploadedAt: number; storedSize: number };
export type ListFilesResponse = { files: FileEntry[]; nextSeq: number; more: boolean };

export type JoinRequest = { secret: string; device: { id: string; name: string; platform: string } };
export type JoinResponse = { deviceToken: string; deviceId: string };
export type JoinToken = { url: string; secret: string };

export const CLOUD_HEADERS = { path: 'x-hangar-path', kind: 'x-hangar-kind', sha256: 'x-hangar-sha256', size: 'x-hangar-size', mtime: 'x-hangar-mtime', encrypted: 'x-hangar-encrypted' } as const;

/** 1 回の POST /changes に載せる上限。Worker は 1 行を 2 文で書くので 81 文以内に収まる。 */
export const MAX_PUSH_BATCH = 40;
/** GET /changes、GET /rows、GET /files が 1 回に返す上限。 */
export const PULL_LIMIT = 500;

const toB64Url = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string): string => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** 参加トークン。Worker の URL と参加用の秘密を JSON にして base64url で包む。 */
export function encodeJoinToken(t: JoinToken): string {
  return toB64Url(JSON.stringify({ url: t.url, secret: t.secret }));
}

export function decodeJoinToken(s: string): JoinToken {
  let v: unknown;
  try { v = JSON.parse(fromB64Url(s.trim())); } catch { throw new Error('参加トークンを読めません'); }
  const o = v as Partial<JoinToken> | null;
  if (!o || typeof o.url !== 'string' || !o.url || typeof o.secret !== 'string' || !o.secret) throw new Error('参加トークンの形式が違います');
  return { url: o.url, secret: o.secret };
}

/** R2 の鍵。端末ごとに分けるので、同じセッション ID の本文が端末間で上書きされない。 */
export function transcriptKey(deviceId: string, sessionUuid: string, agentId: string | null): string {
  return agentId === null ? `transcripts/${deviceId}/${sessionUuid}.jsonl.gz` : `transcripts/${deviceId}/${sessionUuid}/subagents/agent-${agentId}.jsonl.gz`;
}

export function configKey(rel: string): string {
  return `config/${rel}`;
}
```

- [ ] **Step 4: api.ts、events.ts、intent.ts、index.ts を直す**

`packages/shared/src/api.ts` に足す。`EndReason` はフェーズ 2 の定義のまま変えない（引き継ぎを実装しないので `taken_over` は要らない）。

```ts
export type SessionLockDto = { deviceId: string; deviceName: string; runId: string; heartbeatAt: number; stale: boolean };
export type SyncStateKind = 'off' | 'idle' | 'pushing' | 'pulling' | 'paused' | 'error';
export type SyncStatusDto = { state: SyncStateKind; url: string | null; lastPushAt: number | null; lastPullAt: number | null; pending: number; error: string | null; deviceCount: number; claudeConfig: { enabled: boolean; confirmed: boolean } };
export type DeviceDto = { id: string; name: string; platform: string; lastSeenAt: number | null; self: boolean };
export type ConfigPreviewAction = 'create' | 'overwrite' | 'conflict' | 'skip';
export type ConfigPreviewEntryDto = { path: string; action: ConfigPreviewAction; localMtime: number | null; remoteMtime: number; remoteDevice: string; size: number };
export type ConfigPreviewDto = { entries: ConfigPreviewEntryDto[]; confirmed: boolean };
export type ResumeHereConflictDto = { error: 'local_smaller'; localSize: number; remoteSize: number };
```

`SessionDto` の末尾に `lock: SessionLockDto | null; remoteOnly: boolean` を、`SettingsDto` に `syncClaudeConfig: boolean` を、`BootstrapDto` に `sync: SyncStatusDto; devices: DeviceDto[]` を足す。

`packages/shared/src/events.ts` の `ServerEvent` に足す（import に `DeviceDto`、`SyncStatusDto` と `./cloud.ts` の `SharedTable` を加える）。

```ts
  | { type: 'sync.status'; status: SyncStatusDto }
  | { type: 'sync.applied'; table: SharedTable; rowId: string }
  | { type: 'devices.update'; devices: DeviceDto[] }
```

`packages/shared/src/intent.ts` の `Intent` に足す（`session.takeover` の行の直後）。
`session.takeover` そのものはフェーズ 2 からある定義のまま残し、このフェーズでは実装しない（`NOT_YET_INTENTS` に残る）。

```ts
  | { type: 'session.resumeHere'; id: SessionId; overwrite?: boolean }
  | { type: 'sync.config.preview' } | { type: 'sync.config.apply' }
  | { type: 'sync.joinToken.show' }
```

`packages/shared/src/index.ts` に `export * from './cloud.ts';` を足す。

- [ ] **Step 5: 既存テストの期待を直す**

`SessionDto` を丸ごと比べているテストに `lock: null, remoteOnly: false` を足す。
対象は `grep -rln "hasTranscript: true\|hasTranscript: false" packages/*/src --include='*.test.ts' --include='*.test.tsx'` で出るファイルのうち、`toEqual` でオブジェクト全体を比べている箇所である。
`SettingsDto` を丸ごと作っている偽物には `syncClaudeConfig: false` を、`BootstrapDto` を作っている偽物には `sync: { state: 'off', url: null, lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 0, claudeConfig: { enabled: false, confirmed: false } }, devices: []` を足す。
サーバ側の `toSettingsDto` と `SettingsDto` を返す箇所は Task 8 と Task 19 で直すので、ここでは型検査の失敗が残ってよい。

- [ ] **Step 6: テストと型検査**

Run: `npx vitest run packages/shared && npx tsc -p packages/shared`
Expected: PASS。`npm run typecheck` 全体は server と ui の `SessionDto` と `SettingsDto` の箇所で失敗が残る（Task 8、Task 15、Task 19、Task 20 で直す）。

- [ ] **Step 7: コミット**

```bash
git add packages/shared/src
git commit -m "feat(shared): cloud sync contracts, lock and sync DTOs, resume-here intents"
```

---

### Task 2: packages/cloud の骨格とスキーマ

**Files:**
- Create: `packages/cloud/package.json`、`packages/cloud/tsconfig.json`、`packages/cloud/wrangler.jsonc`、`packages/cloud/vitest.config.ts`、`packages/cloud/src/index.ts`、`packages/cloud/src/schema.ts`、`packages/cloud/src/util.ts`、`packages/cloud/src/env.ts`
- Test: `packages/cloud/test/schema.test.ts`
- Modify: `package.json`（ルート。`workspaces` は `packages/*` なので追加は不要。`vitest.config.ts` の `projects` も `packages/*` で拾う）

**Interfaces:**
- Produces:
  ```ts
  // src/env.ts
  export type Env = { DB: D1Database; BUCKET: R2Bucket; JOIN_SECRET_HASH?: string };
  export type Vars = { device: DeviceRow };
  export type DeviceRow = { id: string; name: string; platform: string; token_hash: string; joined_at: number; last_seen_at: number | null; last_pulled_seq: number };
  export type AppType = Hono<{ Bindings: Env; Variables: Vars }>;
  // src/schema.ts
  export const SCHEMA_STATEMENTS: readonly string[];
  export function ensureSchema(env: Env): Promise<void>;   // isolate ごとに 1 回。JOIN_SECRET_HASH を join_secrets に写す
  export function resetSchemaCache(): void;                // テスト用
  // src/util.ts
  export function sha256Hex(s: string): Promise<string>;
  export function randomToken(bytes?: number): string;     // base64url
  export const VERSION = '0.4.0';
  ```
- vitest-pool-workers のテストは `import { env, SELF } from 'cloudflare:test'` で D1 と R2 に触る。`env.DB` はテストごとに新しいので、各テストの冒頭で `ensureSchema(env)` を呼ぶ。

- [ ] **Step 1: パッケージの設定を書く**

`packages/cloud/package.json`：

```json
{
  "name": "@agent-hangar/cloud",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p .",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@agent-hangar/shared": "*",
    "hono": "^4.13.8"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.9.0",
    "@cloudflare/workers-types": "^4.20260901.0",
    "wrangler": "^4.133.0"
  }
}
```

`packages/cloud/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"], "lib": ["ES2022", "WebWorker"] },
  "include": ["src", "test"]
}
```

`packages/cloud/wrangler.jsonc`（ローカル専用。`database_id` はダミー）：

```jsonc
{
  // ローカル開発とテスト専用の設定。実物のデプロイは hangar setup cloud が ~/.agent-hangar/cloud/wrangler.jsonc に別の設定を書く。
  "name": "hangar-local",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [{ "binding": "DB", "database_name": "hangar-local", "database_id": "00000000-0000-0000-0000-000000000000" }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "hangar-local-files" }],
  "vars": {}
}
```

`packages/cloud/vitest.config.ts`：

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    name: 'cloud',
    include: ['test/**/*.test.ts'],
    poolOptions: { workers: { wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { JOIN_SECRET_HASH: '' } } } },
  },
});
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/cloud/test/schema.test.ts`：

```ts
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, resetSchemaCache, SCHEMA_STATEMENTS } from '../src/schema.ts';

beforeEach(() => resetSchemaCache());

describe('schema', () => {
  it('全部の表を作り、2 回呼んでも壊れない', async () => {
    await ensureSchema(env);
    await ensureSchema(env);
    const names = (await env.DB.prepare("select name from sqlite_master where type = 'table' order by name").all<{ name: string }>()).results.map((r) => r.name);
    for (const t of ['changes', 'devices', 'files', 'join_secrets', 'meta', 'rows']) expect(names).toContain(t);
    expect(SCHEMA_STATEMENTS.every((s) => !s.includes('\n'))).toBe(true);
  });
  it('JOIN_SECRET_HASH があれば join_secrets に写し、同じ値は重複しない', async () => {
    const e = { ...env, JOIN_SECRET_HASH: 'a'.repeat(64) };
    await ensureSchema(e);
    resetSchemaCache();
    await ensureSchema(e);
    const rows = (await env.DB.prepare('select secret_hash, revoked_at from join_secrets').all<{ secret_hash: string; revoked_at: number | null }>()).results;
    expect(rows).toEqual([{ secret_hash: 'a'.repeat(64), revoked_at: null }]);
  });
  it('新しい JOIN_SECRET_HASH は古い行を revoke する', async () => {
    await ensureSchema({ ...env, JOIN_SECRET_HASH: 'a'.repeat(64) });
    resetSchemaCache();
    await ensureSchema({ ...env, JOIN_SECRET_HASH: 'b'.repeat(64) });
    const rows = (await env.DB.prepare('select secret_hash, revoked_at from join_secrets order by created_at').all<{ secret_hash: string; revoked_at: number | null }>()).results;
    expect(rows[0]!.revoked_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ secret_hash: 'b'.repeat(64), revoked_at: null });
  });
  it('/health は ok と版を返す', async () => {
    const r = await SELF.fetch('https://x/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: '0.4.0' });
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `cd packages/cloud && npm install && npx vitest run`
Expected: FAIL（`../src/schema.ts` が無い）
`npm install` はルートで `npm install` として実行してもよい（workspaces）。

- [ ] **Step 4: 実装する**

`packages/cloud/src/env.ts`：

```ts
import type { Hono } from 'hono';

export type DeviceRow = { id: string; name: string; platform: string; token_hash: string; joined_at: number; last_seen_at: number | null; last_pulled_seq: number };
export type Env = { DB: D1Database; BUCKET: R2Bucket; JOIN_SECRET_HASH?: string };
export type Vars = { device: DeviceRow };
export type AppType = Hono<{ Bindings: Env; Variables: Vars }>;
```

`packages/cloud/src/util.ts`：

```ts
export const VERSION = '0.4.0';

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 端末トークンなどの乱数。base64url で URL とヘッダに安全。 */
export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
```

`packages/cloud/src/schema.ts`（1 文を 1 行に書く。D1 の `exec` は改行で文を区切るので、複数行の文は使わない）：

```ts
import type { Env } from './env.ts';

export const SCHEMA_STATEMENTS: readonly string[] = [
  'create table if not exists meta (key text primary key, value text not null)',
  'create table if not exists join_secrets (id text primary key, secret_hash text not null unique, created_at integer not null, revoked_at integer)',
  'create table if not exists devices (id text primary key, name text not null, platform text not null, token_hash text not null unique, joined_at integer not null, last_seen_at integer, last_pulled_seq integer not null default 0)',
  'create table if not exists rows (k text primary key, table_name text not null, row_id text not null, op text not null, payload text not null, updated_at integer not null, device_id text not null)',
  'create table if not exists changes (seq integer primary key autoincrement, table_name text not null, row_id text not null, op text not null, payload text not null, updated_at integer not null, device_id text not null, received_at integer not null)',
  'create index if not exists changes_device on changes(device_id, seq)',
  'create table if not exists files (seq integer primary key autoincrement, key text not null unique, path text not null, kind text not null, device_id text not null, sha256 text not null, size integer not null, stored_size integer not null, mtime integer not null, encrypted integer not null, uploaded_at integer not null)',
  'create index if not exists files_kind on files(kind, seq)',
];

let ready: Promise<void> | null = null;

/** isolate ごとに 1 回だけスキーマを整え、Worker の secret にある参加用の秘密のハッシュを D1 に写す。 */
export function ensureSchema(env: Env): Promise<void> {
  if (!ready) ready = doEnsure(env).catch((e) => { ready = null; throw e; });
  return ready;
}

export function resetSchemaCache(): void { ready = null; }

async function doEnsure(env: Env): Promise<void> {
  await env.DB.batch(SCHEMA_STATEMENTS.map((s) => env.DB.prepare(s)));
  const hash = env.JOIN_SECRET_HASH?.trim();
  if (!hash) return;
  const now = Date.now();
  const cur = await env.DB.prepare('select secret_hash from join_secrets where revoked_at is null').all<{ secret_hash: string }>();
  if (cur.results.some((r) => r.secret_hash === hash)) return;
  await env.DB.batch([
    env.DB.prepare('update join_secrets set revoked_at = ? where revoked_at is null').bind(now),
    env.DB.prepare('insert into join_secrets (id, secret_hash, created_at, revoked_at) values (?, ?, ?, null) on conflict(secret_hash) do update set revoked_at = null').bind(crypto.randomUUID(), hash, now),
  ]);
}
```

`packages/cloud/src/index.ts`（この Task では `/health` だけ。`/join`、`/changes`、`/rows`、`/files` は Task 3 から Task 5 で足す）：

```ts
import { Hono } from 'hono';
import type { Env, Vars } from './env.ts';
import { ensureSchema } from './schema.ts';
import { VERSION } from './util.ts';

/** クラウド Worker。端末ごとのトークンで認証し、変更ログとファイルを預かる。中身の暗号化は端末側で行う。 */
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('*', async (c, next) => { await ensureSchema(c.env); await next(); });
app.get('/health', (c) => c.json({ ok: true, version: VERSION }));
app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((e, c) => c.json({ error: e.message }, 500));

export default app;
```

- [ ] **Step 5: テストと型検査**

Run: `cd packages/cloud && npx vitest run && npx tsc -p .`
Expected: PASS（4 件）
vitest-pool-workers が vitest 5 と組み合わせられずに起動しないときは、「前提」に書いた miniflare への切り替えを行う。その場合は `test/harness.ts` に `new Miniflare({ modules: true, scriptPath: 'dist/index.js', d1Databases: ['DB'], r2Buckets: ['BUCKET'] })` を作り、テストの `SELF.fetch` を `mf.dispatchFetch` に、`env.DB` を `await mf.getD1Database('DB')` に置き換える。

- [ ] **Step 6: コミット**

```bash
git add package-lock.json packages/cloud
git commit -m "feat(cloud): worker skeleton with self-applying D1 schema and health route"
```

---

### Task 3: Worker の参加と端末トークン認証

**Files:**
- Create: `packages/cloud/src/join.ts`、`packages/cloud/src/auth.ts`
- Modify: `packages/cloud/src/index.ts`
- Test: `packages/cloud/test/join.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/join.ts
  export function joinHandler(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response>;   // POST /join
  // src/auth.ts
  export function authMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }>;   // Bearer の端末トークンを devices.token_hash で引き、c.set('device', row)
  ```
- `POST /join` の本文は `JoinRequest`。秘密の SHA-256 が `join_secrets` の有効な行に一致しなければ 403。一致すれば `devices` に端末を upsert し（同じ ID なら名前とトークンを差し替える）、`JoinResponse` を 201 で返す。有効な秘密が 1 つも無ければ 503（Worker の secret がまだ入っていない）。
- テスト用に、`/join` の判定は `join_secrets` だけを見る。テストは `ensureSchema({ ...env, JOIN_SECRET_HASH })` で秘密を入れる。

- [ ] **Step 1: 失敗するテストを書く**

`packages/cloud/test/join.test.ts`：

```ts
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';

const SECRET = 'join-secret-1';
const device = { id: 'dev-a', name: 'MacBook', platform: 'darwin' };
const post = (body: unknown) => SELF.fetch('https://x/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => { resetSchemaCache(); await ensureSchema({ ...env, JOIN_SECRET_HASH: await sha256Hex(SECRET) }); });

describe('POST /join', () => {
  it('正しい秘密で端末トークンを発行し、D1 にはハッシュだけを置く', async () => {
    const r = await post({ secret: SECRET, device });
    expect(r.status).toBe(201);
    const body = await r.json<{ deviceToken: string; deviceId: string }>();
    expect(body.deviceId).toBe('dev-a');
    expect(body.deviceToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const row = await env.DB.prepare('select id, name, token_hash from devices where id = ?').bind('dev-a').first<{ id: string; name: string; token_hash: string }>();
    expect(row?.name).toBe('MacBook');
    expect(row?.token_hash).toBe(await sha256Hex(body.deviceToken));
  });
  it('同じ端末 ID で再参加するとトークンが差し替わる', async () => {
    const a = await (await post({ secret: SECRET, device })).json<{ deviceToken: string }>();
    const b = await (await post({ secret: SECRET, device: { ...device, name: 'MacBook 2' } })).json<{ deviceToken: string }>();
    expect(b.deviceToken).not.toBe(a.deviceToken);
    const n = await env.DB.prepare('select count(*) c from devices').first<{ c: number }>();
    expect(n?.c).toBe(1);
    expect((await SELF.fetch('https://x/changes?since=0', { headers: { authorization: `Bearer ${a.deviceToken}` } })).status).toBe(401);
    expect((await SELF.fetch('https://x/changes?since=0', { headers: { authorization: `Bearer ${b.deviceToken}` } })).status).not.toBe(401);
  });
  it('違う秘密と壊れた本文は拒む', async () => {
    expect((await post({ secret: 'nope', device })).status).toBe(403);
    expect((await post({ secret: SECRET })).status).toBe(400);
    expect((await post({ secret: SECRET, device: { id: '', name: 'x', platform: 'y' } })).status).toBe(400);
  });
  it('revoke された秘密は使えない', async () => {
    resetSchemaCache();
    await ensureSchema({ ...env, JOIN_SECRET_HASH: await sha256Hex('join-secret-2') });
    expect((await post({ secret: SECRET, device })).status).toBe(403);
    expect((await post({ secret: 'join-secret-2', device })).status).toBe(201);
  });
  it('秘密が 1 つも無ければ 503', async () => {
    await env.DB.prepare('delete from join_secrets').run();
    expect((await post({ secret: SECRET, device })).status).toBe(503);
  });
});

describe('認証', () => {
  it('トークンが無いか違えば 401、あれば device が入る', async () => {
    expect((await SELF.fetch('https://x/changes?since=0')).status).toBe(401);
    expect((await SELF.fetch('https://x/changes?since=0', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const { deviceToken } = await (await post({ secret: SECRET, device })).json<{ deviceToken: string }>();
    const r = await SELF.fetch('https://x/changes?since=0', { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(r.status).toBe(200);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd packages/cloud && npx vitest run test/join`
Expected: FAIL（`/join` が 404）

- [ ] **Step 3: 実装する**

`packages/cloud/src/join.ts`：

```ts
import type { Context } from 'hono';
import type { JoinRequest, JoinResponse } from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';
import { randomToken, sha256Hex } from './util.ts';

const isDevice = (d: unknown): d is JoinRequest['device'] => {
  const o = d as Partial<JoinRequest['device']> | null;
  return !!o && typeof o.id === 'string' && o.id.length > 0 && o.id.length <= 64 && typeof o.name === 'string' && o.name.length > 0 && o.name.length <= 128 && typeof o.platform === 'string' && o.platform.length <= 32;
};

/** 参加用の秘密を検査し、端末トークンを発行する。秘密もトークンも D1 には SHA-256 だけを置く。 */
export async function joinHandler(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as Partial<JoinRequest> | null;
  if (!body || typeof body.secret !== 'string' || !isDevice(body.device)) return c.json({ error: 'invalid body' }, 400);
  const active = await c.env.DB.prepare('select secret_hash from join_secrets where revoked_at is null').all<{ secret_hash: string }>();
  if (active.results.length === 0) return c.json({ error: 'not initialized' }, 503);
  const hash = await sha256Hex(body.secret);
  if (!active.results.some((r) => r.secret_hash === hash)) return c.json({ error: 'forbidden' }, 403);
  const token = randomToken(32);
  const now = Date.now();
  await c.env.DB.prepare('insert into devices (id, name, platform, token_hash, joined_at, last_seen_at, last_pulled_seq) values (?, ?, ?, ?, ?, ?, 0) on conflict(id) do update set name = excluded.name, platform = excluded.platform, token_hash = excluded.token_hash, last_seen_at = excluded.last_seen_at')
    .bind(body.device.id, body.device.name, body.device.platform, await sha256Hex(token), now, now).run();
  const res: JoinResponse = { deviceToken: token, deviceId: body.device.id };
  return c.json(res, 201);
}
```

`packages/cloud/src/auth.ts`：

```ts
import type { MiddlewareHandler } from 'hono';
import type { DeviceRow, Env, Vars } from './env.ts';
import { sha256Hex } from './util.ts';

/** Bearer の端末トークンを devices.token_hash で引く。見つからなければ 401。 */
export function authMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
    const token = auth.slice('Bearer '.length).trim();
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const row = await c.env.DB.prepare('select * from devices where token_hash = ?').bind(await sha256Hex(token)).first<DeviceRow>();
    if (!row) return c.json({ error: 'unauthorized' }, 401);
    c.set('device', row);
    await next();
  };
}
```

`packages/cloud/src/index.ts` に足す（`/health` の後）。`/changes` は Task 4 で本物にするので、ここでは認証の通過を確かめる仮の経路を置く。

```ts
import { authMiddleware } from './auth.ts';
import { joinHandler } from './join.ts';

app.post('/join', joinHandler);
app.use('/changes', authMiddleware());
app.use('/changes/*', authMiddleware());
app.use('/rows', authMiddleware());
app.use('/files', authMiddleware());
app.use('/files/*', authMiddleware());
app.get('/changes', (c) => c.json({ changes: [], nextSeq: 0, more: false }));   // Task 4 で置き換える
```

- [ ] **Step 4: テストと型検査**

Run: `cd packages/cloud && npx vitest run && npx tsc -p .`
Expected: PASS（10 件）

- [ ] **Step 5: コミット**

```bash
git add packages/cloud
git commit -m "feat(cloud): join with hashed secret and per-device bearer tokens"
```

---

### Task 4: Worker の変更ログ（POST /changes、GET /changes、GET /rows、圧縮）

**Files:**
- Create: `packages/cloud/src/changes.ts`
- Modify: `packages/cloud/src/index.ts`
- Test: `packages/cloud/test/changes.test.ts`

**Interfaces:**
- Consumes: `ChangeIn`、`ChangeOut`、`SHARED_TABLES`、`MAX_PUSH_BATCH`、`PULL_LIMIT`（shared）、`authMiddleware`。
- Produces:
  ```ts
  export const changesApp: AppType;   // POST /（push）、GET /（pull）
  export const rowsApp: AppType;      // GET /（snapshot）
  export const COMPACT_EVERY = 200;
  export const COMPACT_AGE_MS = 14 * 86_400_000;
  export const DEVICE_ACTIVE_MS = 30 * 86_400_000;
  ```
- `POST /changes`：本文 `{ changes: ChangeIn[] }`。40 行を超えるか形が違えば 400。同じ鍵が重複していれば `updatedAt` の大きい方だけを見る。`rows` の `updated_at` 以上のものは `skipped`、それ以外は `changes` に追記して `rows` を更新し `accepted` に数える。`devices.last_seen_at` を更新する。応答は `{ seq: 現在の最大連番, accepted, skipped }`。`seq % 200 === 0` のとき圧縮を走らせる。
- `GET /changes?since=<seq>&limit=<n>`：認証した端末以外の変更を `seq` 昇順で返す。`more` が false のときの `nextSeq` は表全体の最大連番（自端末の末尾の変更を飛ばすため）。`devices.last_pulled_seq` を `nextSeq` に更新する。
- **圧縮で落ちた区間の検出**：圧縮は削り終えた連番を `meta` の `changes_floor` に書く。`GET /changes` は `since < changes_floor` のとき、変更を返さずに `410` と `{ error: 'gone', floor }` を返す。その端末は削られた区間を読み逃しているので、黙って新しい分だけを渡すと欠落が永久に残る。受けた端末は `GET /rows` から全件を取り直す（Task 10）。`since === 0` の端末も `changes_floor > 0` なら 410 になるが、初回は `GET /rows` を先に読むので実際には通らない。
- 圧縮のテストに「削った後に古い `since` で引くと 410 が返り、`floor` が入っている」を 1 件足す。
- `GET /rows?after=<k>&limit=<n>`：`rows` を `k` 昇順で返す。`seq` は現在の最大連番。新しい端末の初回だけが使う。

- [ ] **Step 1: 失敗するテストを書く**

`packages/cloud/test/changes.test.ts`：

```ts
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChangeIn, ChangeOut } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';

const SECRET = 's';
let tokA = '';
let tokB = '';
const join = async (id: string) => (await (await SELF.fetch('https://x/join', { method: 'POST', body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }) })).json<{ deviceToken: string }>()).deviceToken;
const push = (tok: string, changes: unknown) => SELF.fetch('https://x/changes', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });
const pull = async (tok: string, since: number, limit = 500) => (await SELF.fetch(`https://x/changes?since=${since}&limit=${limit}`, { headers: { authorization: `Bearer ${tok}` } })).json<{ changes: ChangeOut[]; nextSeq: number; more: boolean }>();
const ch = (rowId: string, updatedAt: number, name = rowId): ChangeIn => ({ tableName: 'projects', rowId, op: 'upsert', payload: { id: rowId, name, status: 'active', is_scratch: 0, updated_at: updatedAt, deleted_at: null, origin_device: 'x' }, updatedAt });

beforeEach(async () => {
  resetSchemaCache();
  await ensureSchema({ ...env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  tokA = await join('dev-a');
  tokB = await join('dev-b');
});

describe('POST /changes', () => {
  it('新しい行を受け取り連番を付け、古い行は skipped にする', async () => {
    const r1 = await push(tokA, [ch('p1', 100), ch('p2', 100)]);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ seq: 2, accepted: 2, skipped: 0 });
    const r2 = await push(tokB, [ch('p1', 50, 'old'), ch('p2', 200, 'new')]);
    expect(await r2.json()).toEqual({ seq: 3, accepted: 1, skipped: 1 });
    const row = await env.DB.prepare('select payload, device_id from rows where k = ?').bind('projects:p2').first<{ payload: string; device_id: string }>();
    expect(JSON.parse(row!.payload).name).toBe('new');
    expect(row!.device_id).toBe('dev-b');
    expect(JSON.parse((await env.DB.prepare('select payload from rows where k = ?').bind('projects:p1').first<{ payload: string }>())!.payload).name).toBe('p1');
  });
  it('同じ鍵の重複は updatedAt の大きい方だけを採る', async () => {
    const r = await push(tokA, [ch('p1', 100, 'a'), ch('p1', 300, 'c'), ch('p1', 200, 'b')]);
    expect(await r.json()).toEqual({ seq: 1, accepted: 1, skipped: 2 });
    expect(JSON.parse((await env.DB.prepare('select payload from rows where k = ?').bind('projects:p1').first<{ payload: string }>())!.payload).name).toBe('c');
  });
  it('形の違う本文と 40 行超は 400', async () => {
    expect((await push(tokA, 'x')).status).toBe(400);
    expect((await push(tokA, [{ tableName: 'nope', rowId: 'a', op: 'upsert', payload: {}, updatedAt: 1 }])).status).toBe(400);
    expect((await push(tokA, [{ ...ch('a', 1), op: 'drop' }])).status).toBe(400);
    expect((await push(tokA, Array.from({ length: 41 }, (_, i) => ch(`p${i}`, 1)))).status).toBe(400);
    expect((await push(tokA, [])).status).toBe(200);
  });
});

describe('GET /changes と GET /rows', () => {
  it('自端末の変更を除き、nextSeq は表の最大連番まで進む', async () => {
    await push(tokA, [ch('p1', 100)]);
    await push(tokB, [ch('p2', 100)]);
    await push(tokA, [ch('p3', 100)]);
    const a = await pull(tokA, 0);
    expect(a.changes.map((c) => [c.rowId, c.seq, c.deviceId])).toEqual([['p2', 2, 'dev-b']]);
    expect(a.nextSeq).toBe(3);
    expect(a.more).toBe(false);
    const b = await pull(tokB, 0);
    expect(b.changes.map((c) => c.rowId)).toEqual(['p1', 'p3']);
    expect(await pull(tokB, 3)).toEqual({ changes: [], nextSeq: 3, more: false });
    const dev = await env.DB.prepare('select last_pulled_seq from devices where id = ?').bind('dev-b').first<{ last_pulled_seq: number }>();
    expect(dev?.last_pulled_seq).toBe(3);
  });
  it('limit を超えると more が立ち、nextSeq は返した最後の連番', async () => {
    await push(tokA, Array.from({ length: 5 }, (_, i) => ch(`p${i}`, 1)));
    const r = await pull(tokB, 0, 2);
    expect(r.changes.map((c) => c.seq)).toEqual([1, 2]);
    expect(r).toMatchObject({ nextSeq: 2, more: true });
    const r2 = await pull(tokB, r.nextSeq, 2);
    expect(r2.changes.map((c) => c.seq)).toEqual([3, 4]);
    const r3 = await pull(tokB, r2.nextSeq, 2);
    expect(r3).toMatchObject({ more: false, nextSeq: 5 });
  });
  it('GET /rows は自端末の行も含めて k 順に返す', async () => {
    await push(tokA, [ch('p2', 1), ch('p1', 1)]);
    await push(tokB, [ch('p3', 1)]);
    const r = await (await SELF.fetch('https://x/rows?after=&limit=2', { headers: { authorization: `Bearer ${tokA}` } })).json<{ changes: ChangeOut[]; nextAfter: string | null; seq: number }>();
    expect(r.changes.map((c) => c.rowId)).toEqual(['p1', 'p2']);
    expect(r.nextAfter).toBe('projects:p2');
    expect(r.seq).toBe(3);
    const r2 = await (await SELF.fetch(`https://x/rows?after=${encodeURIComponent(r.nextAfter!)}&limit=2`, { headers: { authorization: `Bearer ${tokA}` } })).json<{ changes: ChangeOut[]; nextAfter: string | null }>();
    expect(r2.changes.map((c) => c.rowId)).toEqual(['p3']);
    expect(r2.nextAfter).toBeNull();
  });
});

describe('圧縮', () => {
  it('全端末が読み終えた古い変更を消し、rows は残す', async () => {
    await push(tokA, [ch('p1', 1)]);
    await pull(tokB, 0);
    await pull(tokA, 0);
    await env.DB.prepare('update changes set received_at = 0').run();
    await env.DB.prepare("update sqlite_sequence set seq = 199 where name = 'changes'").run();
    await push(tokB, [ch('p2', 1)]);   // seq 200 で圧縮が走る
    const seqs = (await env.DB.prepare('select seq from changes order by seq').all<{ seq: number }>()).results.map((r) => r.seq);
    expect(seqs).toEqual([200]);
    expect((await env.DB.prepare('select count(*) c from rows').first<{ c: number }>())!.c).toBe(2);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd packages/cloud && npx vitest run test/changes`
Expected: FAIL（`POST /changes` が 404）

- [ ] **Step 3: 実装する**

`packages/cloud/src/changes.ts`：

```ts
import { Hono } from 'hono';
import { MAX_PUSH_BATCH, PULL_LIMIT, SHARED_TABLES, type ChangeIn, type ChangeOut, type PullChangesResponse, type PushChangesResponse, type SnapshotResponse } from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';

export const COMPACT_EVERY = 200;
export const COMPACT_AGE_MS = 14 * 86_400_000;
export const DEVICE_ACTIVE_MS = 30 * 86_400_000;

const TABLES = new Set<string>(SHARED_TABLES);
const keyOf = (c: { tableName: string; rowId: string }) => `${c.tableName}:${c.rowId}`;

function isChange(v: unknown): v is ChangeIn {
  const c = v as Partial<ChangeIn> | null;
  return !!c && typeof c.tableName === 'string' && TABLES.has(c.tableName) && typeof c.rowId === 'string' && c.rowId.length > 0
    && (c.op === 'upsert' || c.op === 'delete') && typeof c.payload === 'object' && c.payload !== null && !Array.isArray(c.payload)
    && typeof c.updatedAt === 'number' && Number.isFinite(c.updatedAt);
}

type ChangeRow = { seq: number; table_name: string; row_id: string; op: 'upsert' | 'delete'; payload: string; updated_at: number; device_id: string };
const toOut = (r: ChangeRow): ChangeOut => ({ seq: r.seq, tableName: r.table_name as ChangeOut['tableName'], rowId: r.row_id, op: r.op, payload: JSON.parse(r.payload) as Record<string, unknown>, updatedAt: r.updated_at, deviceId: r.device_id });

const maxSeq = async (db: D1Database): Promise<number> => (await db.prepare('select ifnull(max(seq), 0) s from changes').first<{ s: number }>())!.s;
const clampLimit = (v: string | undefined) => Math.min(Math.max(Number(v ?? PULL_LIMIT) || PULL_LIMIT, 1), PULL_LIMIT);

/** 受信から 14 日を過ぎ、30 日以内に接続した全端末が読み終えた連番までの changes を消す。rows は残す。 */
async function compact(db: D1Database, now: number): Promise<void> {
  const r = await db.prepare('select min(last_pulled_seq) m from devices where last_seen_at is not null and last_seen_at > ?').bind(now - DEVICE_ACTIVE_MS).first<{ m: number | null }>();
  if (r?.m == null) return;
  await db.prepare('delete from changes where seq <= ? and received_at < ?').bind(r.m, now - COMPACT_AGE_MS).run();
}

export const changesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

changesApp.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { changes?: unknown } | null;
  if (!body || !Array.isArray(body.changes) || body.changes.length > MAX_PUSH_BATCH || !body.changes.every(isChange)) return c.json({ error: 'invalid body' }, 400);
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  // 同じ鍵の重複は updatedAt の大きい方だけを見る。
  const latest = new Map<string, ChangeIn>();
  let skipped = 0;
  for (const ch of body.changes as ChangeIn[]) {
    const k = keyOf(ch);
    const cur = latest.get(k);
    if (!cur) latest.set(k, ch);
    else { skipped++; if (ch.updatedAt > cur.updatedAt) latest.set(k, ch); }
  }
  const keys = [...latest.keys()];
  const current = new Map<string, number>();
  if (keys.length) {
    const rows = await db.prepare(`select k, updated_at from rows where k in (${keys.map(() => '?').join(',')})`).bind(...keys).all<{ k: string; updated_at: number }>();
    for (const r of rows.results) current.set(r.k, r.updated_at);
  }
  const stmts: D1PreparedStatement[] = [];
  let accepted = 0;
  for (const [k, ch] of latest) {
    const prev = current.get(k);
    if (prev !== undefined && prev >= ch.updatedAt) { skipped++; continue; }
    accepted++;
    const payload = JSON.stringify(ch.payload);
    stmts.push(db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id, received_at) values (?, ?, ?, ?, ?, ?, ?)').bind(ch.tableName, ch.rowId, ch.op, payload, ch.updatedAt, device.id, now));
    stmts.push(db.prepare('insert into rows (k, table_name, row_id, op, payload, updated_at, device_id) values (?, ?, ?, ?, ?, ?, ?) on conflict(k) do update set op = excluded.op, payload = excluded.payload, updated_at = excluded.updated_at, device_id = excluded.device_id').bind(k, ch.tableName, ch.rowId, ch.op, payload, ch.updatedAt, device.id));
  }
  stmts.push(db.prepare('update devices set last_seen_at = ? where id = ?').bind(now, device.id));
  await db.batch(stmts);
  const seq = await maxSeq(db);
  if (accepted > 0 && seq % COMPACT_EVERY === 0) await compact(db, now);
  const res: PushChangesResponse = { seq, accepted, skipped };
  return c.json(res);
});

changesApp.get('/', async (c) => {
  const device = c.get('device');
  const db = c.env.DB;
  const since = Math.max(Number(c.req.query('since') ?? 0) || 0, 0);
  const limit = clampLimit(c.req.query('limit'));
  const rows = await db.prepare('select * from changes where seq > ? and device_id != ? order by seq limit ?').bind(since, device.id, limit + 1).all<ChangeRow>();
  const more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const nextSeq = more ? page[page.length - 1]!.seq : Math.max(await maxSeq(db), since);
  await db.prepare('update devices set last_seen_at = ?, last_pulled_seq = max(last_pulled_seq, ?) where id = ?').bind(Date.now(), nextSeq, device.id).run();
  const res: PullChangesResponse = { changes: page.map(toOut), nextSeq, more };
  return c.json(res);
});

export const rowsApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** rows の写しを k 順に返す。新しい端末の初回 pull だけが使う。自端末の行も含める。 */
rowsApp.get('/', async (c) => {
  const db = c.env.DB;
  const after = c.req.query('after') ?? '';
  const limit = clampLimit(c.req.query('limit'));
  const rows = await db.prepare('select 0 seq, table_name, row_id, op, payload, updated_at, device_id, k from rows where k > ? order by k limit ?').bind(after, limit + 1).all<ChangeRow & { k: string }>();
  const more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const res: SnapshotResponse = { changes: page.map(toOut), nextAfter: more ? page[page.length - 1]!.k : null, seq: await maxSeq(db) };
  return c.json(res);
});
```

`packages/cloud/src/index.ts` の Task 3 で置いた仮の `app.get('/changes', ...)` を消し、次を足す。

```ts
import { changesApp, rowsApp } from './changes.ts';

app.route('/changes', changesApp);
app.route('/rows', rowsApp);
```

- [ ] **Step 4: テストと型検査**

Run: `cd packages/cloud && npx vitest run && npx tsc -p .`
Expected: PASS（`changes` 8 件を含む）
`join.test.ts` の「認証」は `GET /changes?since=0` が 200 を返すことを前提にしているので、そのまま通る。

- [ ] **Step 5: コミット**

```bash
git add packages/cloud
git commit -m "feat(cloud): change log with server sequence, LWW mirror, snapshot and compaction"
```

---

### Task 5: Worker のファイル（R2 へのストリーミングと D1 の索引）

**Files:**
- Create: `packages/cloud/src/files.ts`
- Modify: `packages/cloud/src/index.ts`
- Test: `packages/cloud/test/files.test.ts`

**Interfaces:**
- Consumes: `CLOUD_HEADERS`、`FileEntry`、`ListFilesResponse`、`PULL_LIMIT`。
- Produces:
  ```ts
  export const filesApp: AppType;
  export function validKey(key: string, deviceId: string, method: 'PUT' | 'GET' | 'DELETE'): boolean;
  ```
- 経路（すべて認証済み）：
  - `PUT /files/<key>`：ヘッダ `x-hangar-path`、`x-hangar-kind`（`transcript` か `config`）、`x-hangar-sha256`（64 桁 hex）、`x-hangar-size`、`x-hangar-mtime`、`x-hangar-encrypted`（`1` か `0`）。本文はそのまま `BUCKET.put(key, body)` に流す。`files` の同じ鍵の行を消して入れ直し、新しい `seq` を 201 で返す。
  - `GET /files?since=<seq>&limit=<n>`：`seq` 昇順に `FileEntry` を返す。自端末のものも返す（復旧に使う）。
  - `GET /files/<key>`：R2 の本体を `content-length` 付きで返す。無ければ 404。
  - `DELETE /files/<key>`：R2 と `files` から消す。
- 鍵の検査：`transcripts/<端末 ID>/...` は `PUT` と `DELETE` を自端末の分にだけ許す（`GET` は誰でも）。`config/...` はどの端末でも書ける。`..` を含む鍵、`/` で始まる鍵、`transcripts` と `config` 以外の接頭辞は 400。

- [ ] **Step 1: 失敗するテストを書く**

`packages/cloud/test/files.test.ts`：

```ts
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileEntry } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';

let tokA = '';
let tokB = '';
const join = async (id: string) => (await (await SELF.fetch('https://x/join', { method: 'POST', body: JSON.stringify({ secret: 's', device: { id, name: id, platform: 'darwin' } }) })).json<{ deviceToken: string }>()).deviceToken;
const meta = (o: Partial<Record<string, string>> = {}) => ({ 'x-hangar-path': 'projects/-x/u1.jsonl', 'x-hangar-kind': 'transcript', 'x-hangar-sha256': 'a'.repeat(64), 'x-hangar-size': '3', 'x-hangar-mtime': '1700000000000', 'x-hangar-encrypted': '1', ...o });
const put = (tok: string, key: string, body: string, headers = meta()) => SELF.fetch(`https://x/files/${key}`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, ...headers }, body });
const list = async (tok: string, since = 0) => (await SELF.fetch(`https://x/files?since=${since}`, { headers: { authorization: `Bearer ${tok}` } })).json<{ files: FileEntry[]; nextSeq: number; more: boolean }>();

beforeEach(async () => { resetSchemaCache(); await ensureSchema({ ...env, JOIN_SECRET_HASH: await sha256Hex('s') }); tokA = await join('dev-a'); tokB = await join('dev-b'); });

describe('PUT と GET /files/<key>', () => {
  it('R2 に置き、索引に載せ、本体を取り出せる', async () => {
    const r = await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abc');
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ seq: 1 });
    const obj = await env.BUCKET.get('transcripts/dev-a/u1.jsonl.gz');
    expect(await obj?.text()).toBe('abc');
    const l = await list(tokB);
    expect(l.files).toHaveLength(1);
    expect(l.files[0]).toMatchObject({ seq: 1, key: 'transcripts/dev-a/u1.jsonl.gz', path: 'projects/-x/u1.jsonl', kind: 'transcript', deviceId: 'dev-a', sha256: 'a'.repeat(64), size: 3, storedSize: 3, mtime: 1700000000000, encrypted: true });
    expect(l).toMatchObject({ nextSeq: 1, more: false });
    const g = await SELF.fetch('https://x/files/transcripts/dev-a/u1.jsonl.gz', { headers: { authorization: `Bearer ${tokB}` } });
    expect(g.status).toBe(200);
    expect(g.headers.get('content-length')).toBe('3');
    expect(await g.text()).toBe('abc');
  });
  it('同じ鍵を置き直すと新しい seq になり、古い索引は消える', async () => {
    await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abc');
    await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abcd', meta({ 'x-hangar-sha256': 'b'.repeat(64), 'x-hangar-size': '4' }));
    const l = await list(tokB);
    expect(l.files.map((f) => [f.seq, f.sha256[0]])).toEqual([[2, 'b']]);
    expect((await list(tokB, 1)).files.map((f) => f.seq)).toEqual([2]);
  });
  it('他端末の transcripts には書けず、config は書ける', async () => {
    expect((await put(tokB, 'transcripts/dev-a/u1.jsonl.gz', 'x')).status).toBe(403);
    expect((await put(tokB, 'config/skills/a/SKILL.md', 'x', meta({ 'x-hangar-kind': 'config', 'x-hangar-path': 'skills/a/SKILL.md', 'x-hangar-size': '1' }))).status).toBe(201);
    expect((await put(tokA, 'config/skills/a/SKILL.md', 'y', meta({ 'x-hangar-kind': 'config', 'x-hangar-path': 'skills/a/SKILL.md', 'x-hangar-size': '1' }))).status).toBe(201);
  });
  it('不正な鍵とヘッダは 400', async () => {
    expect((await put(tokA, 'transcripts/dev-a/../dev-b/u1.jsonl.gz', 'x')).status).toBe(400);
    expect((await put(tokA, 'other/u1', 'x')).status).toBe(400);
    expect((await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'x', meta({ 'x-hangar-sha256': 'zz' }))).status).toBe(400);
    expect((await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'x', meta({ 'x-hangar-kind': 'video' }))).status).toBe(400);
    expect((await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'x', { ...meta(), 'x-hangar-path': undefined } as never)).status).toBe(400);
  });
  it('無い鍵は 404、DELETE は本体と索引を消す', async () => {
    expect((await SELF.fetch('https://x/files/transcripts/dev-a/nope.gz', { headers: { authorization: `Bearer ${tokA}` } })).status).toBe(404);
    await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abc');
    expect((await SELF.fetch('https://x/files/transcripts/dev-a/u1.jsonl.gz', { method: 'DELETE', headers: { authorization: `Bearer ${tokB}` } })).status).toBe(403);
    expect((await SELF.fetch('https://x/files/transcripts/dev-a/u1.jsonl.gz', { method: 'DELETE', headers: { authorization: `Bearer ${tokA}` } })).status).toBe(204);
    expect(await env.BUCKET.head('transcripts/dev-a/u1.jsonl.gz')).toBeNull();
    expect((await list(tokA)).files).toEqual([]);
  });
  it('一覧は limit と more を持つ', async () => {
    for (let i = 0; i < 3; i++) await put(tokA, `transcripts/dev-a/u${i}.jsonl.gz`, 'x', meta({ 'x-hangar-size': '1' }));
    const r = await (await SELF.fetch('https://x/files?since=0&limit=2', { headers: { authorization: `Bearer ${tokA}` } })).json<{ files: FileEntry[]; nextSeq: number; more: boolean }>();
    expect(r.files.map((f) => f.seq)).toEqual([1, 2]);
    expect(r).toMatchObject({ nextSeq: 2, more: true });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd packages/cloud && npx vitest run test/files`
Expected: FAIL（404）

- [ ] **Step 3: 実装する**

`packages/cloud/src/files.ts`：

```ts
import { Hono } from 'hono';
import { CLOUD_HEADERS, PULL_LIMIT, type FileEntry, type FileKind, type ListFilesResponse } from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';

type FileRow = { seq: number; key: string; path: string; kind: FileKind; device_id: string; sha256: string; size: number; stored_size: number; mtime: number; encrypted: number; uploaded_at: number };
const toEntry = (r: FileRow): FileEntry => ({ seq: r.seq, key: r.key, path: r.path, kind: r.kind, deviceId: r.device_id, sha256: r.sha256, size: r.size, storedSize: r.stored_size, mtime: r.mtime, encrypted: r.encrypted === 1, uploadedAt: r.uploaded_at });

const KEY_RE = /^(transcripts|config)\/[A-Za-z0-9._\-\/]+$/;

/** 鍵の形と権限。transcripts は自端末の分にだけ書ける。config は誰でも書ける。GET は誰でも。 */
export function validKey(key: string, deviceId: string, method: 'PUT' | 'GET' | 'DELETE'): boolean {
  if (!KEY_RE.test(key) || key.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
  if (method === 'GET') return true;
  if (key.startsWith('transcripts/')) return key.startsWith(`transcripts/${deviceId}/`);
  return true;
}

const isSha = (s: string | undefined): s is string => !!s && /^[0-9a-f]{64}$/.test(s);
const toInt = (s: string | undefined): number | null => { const n = Number(s); return s !== undefined && Number.isInteger(n) && n >= 0 ? n : null; };

export const filesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

filesApp.get('/', async (c) => {
  const since = Math.max(Number(c.req.query('since') ?? 0) || 0, 0);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? PULL_LIMIT) || PULL_LIMIT, 1), PULL_LIMIT);
  const rows = await c.env.DB.prepare('select * from files where seq > ? order by seq limit ?').bind(since, limit + 1).all<FileRow>();
  const more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const nextSeq = page.length ? page[page.length - 1]!.seq : since;
  const res: ListFilesResponse = { files: page.map(toEntry), nextSeq, more };
  return c.json(res);
});

filesApp.put('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const device = c.get('device');
  if (!KEY_RE.test(key) || !validKey(key, device.id, 'GET')) return c.json({ error: 'invalid key' }, 400);
  if (!validKey(key, device.id, 'PUT')) return c.json({ error: 'forbidden' }, 403);
  const h = (name: string) => c.req.header(name);
  const path = h(CLOUD_HEADERS.path);
  const kind = h(CLOUD_HEADERS.kind);
  const sha = h(CLOUD_HEADERS.sha256);
  const size = toInt(h(CLOUD_HEADERS.size));
  const mtime = toInt(h(CLOUD_HEADERS.mtime));
  const enc = h(CLOUD_HEADERS.encrypted);
  if (!path || path.includes('..') || path.startsWith('/') || (kind !== 'transcript' && kind !== 'config') || !isSha(sha) || size === null || mtime === null || (enc !== '1' && enc !== '0')) return c.json({ error: 'invalid headers' }, 400);
  if (!c.req.raw.body) return c.json({ error: 'empty body' }, 400);
  const obj = await c.env.BUCKET.put(key, c.req.raw.body, { customMetadata: { path, sha256: sha, device: device.id } });
  const now = Date.now();
  const r = await c.env.DB.batch([
    c.env.DB.prepare('delete from files where key = ?').bind(key),
    c.env.DB.prepare('insert into files (key, path, kind, device_id, sha256, size, stored_size, mtime, encrypted, uploaded_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(key, path, kind, device.id, sha, size, obj?.size ?? 0, mtime, enc === '1' ? 1 : 0, now),
    c.env.DB.prepare('update devices set last_seen_at = ? where id = ?').bind(now, device.id),
  ]);
  const seq = Number(r[1]!.meta.last_row_id);
  return c.json({ seq }, 201);
});

filesApp.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  if (!validKey(key, c.get('device').id, 'GET')) return c.json({ error: 'invalid key' }, 400);
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size), etag: obj.httpEtag } });
});

filesApp.delete('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const device = c.get('device');
  if (!validKey(key, device.id, 'GET')) return c.json({ error: 'invalid key' }, 400);
  if (!validKey(key, device.id, 'DELETE')) return c.json({ error: 'forbidden' }, 403);
  await c.env.BUCKET.delete(key);
  await c.env.DB.prepare('delete from files where key = ?').bind(key).run();
  return c.body(null, 204);
});
```

`packages/cloud/src/index.ts` に足す。

```ts
import { filesApp } from './files.ts';

app.route('/files', filesApp);
```

- [ ] **Step 4: テストと型検査**

Run: `cd packages/cloud && npx vitest run && npx tsc -p .`
Expected: PASS（`files` 6 件を含む）

- [ ] **Step 5: コミット**

```bash
git add packages/cloud
git commit -m "feat(cloud): encrypted file store on R2 with D1 index and per-device write scope"
```

---

### Task 6: 端末間の暗号化（HKDF と AES-256-GCM のチャンクストリーム）

**Files:**
- Create: `packages/server/src/sync/crypto.ts`
- Test: `packages/server/src/sync/crypto.test.ts`

**Interfaces:**
- Produces: 「インターフェース一覧」の `sync/crypto.ts` の全部。
- 形式：先頭 `HGR1`（4 バイト）と nonce 接頭辞（8 バイト）。続けてチャンクごとに `flag`（1 バイト。最終チャンクは 1）、`len`（4 バイト big endian）、暗号文（`len` バイト）、認証タグ（16 バイト）。nonce は接頭辞と 4 バイトのチャンク番号（big endian）の連結。AAD はチャンク番号（4 バイト）と `flag`（1 バイト）。平文は 1MB ごとに区切り、最後の 1 チャンクは flush で出す（0 バイトでも出す）。
- 復号は、magic の不一致、タグの不一致、`flag = 1` のチャンクの後に続くデータ、`flag = 1` が来ないままの終端を `error` にする。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/sync/crypto.test.ts`：

```ts
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, decryptBuffer, decryptStream, deriveFileKey, encryptBuffer, encryptStream, sha256Hex, sha256Stream } from './crypto.ts';

const key = deriveFileKey('join-secret');
const collect = async (s: NodeJS.ReadableStream): Promise<Buffer> => { const out: Buffer[] = []; for await (const c of s) out.push(c as Buffer); return Buffer.concat(out); };

describe('deriveFileKey', () => {
  it('同じ秘密から同じ 32 バイト、違う秘密から違う鍵', () => {
    expect(key).toHaveLength(32);
    expect(deriveFileKey('join-secret').equals(key)).toBe(true);
    expect(deriveFileKey('other').equals(key)).toBe(false);
  });
});

describe('encrypt と decrypt', () => {
  it('空、1 バイト、ちょうど 1 チャンク、2 チャンク半を往復する', async () => {
    for (const n of [0, 1, CHUNK_SIZE, CHUNK_SIZE * 2 + 12345]) {
      const src = randomBytes(n);
      const enc = await encryptBuffer(key, src);
      expect(enc.subarray(0, 4).toString()).toBe('HGR1');
      const dec = await decryptBuffer(key, enc);
      expect(dec.equals(src)).toBe(true);
      const chunks = Math.max(1, Math.ceil(n / CHUNK_SIZE));
      expect(enc.length).toBe(12 + n + chunks * 21);
    }
  });
  it('同じ平文でも nonce 接頭辞が違うので暗号文が違う', async () => {
    const src = Buffer.from('hello');
    const a = await encryptBuffer(key, src);
    const b = await encryptBuffer(key, src);
    expect(a.equals(b)).toBe(false);
    expect((await decryptBuffer(key, a)).equals(await decryptBuffer(key, b))).toBe(true);
  });
  it('ストリームでも同じ結果になり、小さな書き込みの列を受ける', async () => {
    const src = randomBytes(CHUNK_SIZE + 777);
    const pieces: Buffer[] = [];
    for (let i = 0; i < src.length; i += 4096) pieces.push(src.subarray(i, i + 4096));
    const enc = await collect(Readable.from(pieces).pipe(encryptStream(key)));
    const dec = await collect(Readable.from([enc.subarray(0, 100), enc.subarray(100)]).pipe(decryptStream(key)));
    expect(dec.equals(src)).toBe(true);
  });
  it('改竄、鍵違い、切り詰め、末尾の余りは失敗する', async () => {
    const src = randomBytes(CHUNK_SIZE + 10);
    const enc = await encryptBuffer(key, src);
    const flipped = Buffer.from(enc); flipped[20] ^= 1;
    await expect(decryptBuffer(key, flipped)).rejects.toThrow();
    await expect(decryptBuffer(deriveFileKey('other'), enc)).rejects.toThrow();
    await expect(decryptBuffer(key, enc.subarray(0, enc.length - 30))).rejects.toThrow(/切り詰め|truncated/);
    await expect(decryptBuffer(key, Buffer.concat([enc, Buffer.from([0])]))).rejects.toThrow();
    await expect(decryptBuffer(key, Buffer.from('nope'))).rejects.toThrow();
  });
});

describe('sha256', () => {
  it('文字列とストリームで同じ値', async () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Stream(Readable.from([Buffer.from('a'), Buffer.from('bc')]))).toBe(sha256Hex('abc'));
    await pipeline(Readable.from([]), async function* (s) { for await (const c of s) yield c; });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/sync/crypto`
Expected: FAIL（`./crypto.ts` が無い）

- [ ] **Step 3: 実装する**

`packages/server/src/sync/crypto.ts`：

```ts
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

export const CHUNK_SIZE = 1 << 20;
const MAGIC = Buffer.from('HGR1');
const PREFIX_LEN = 8;
const HEADER_LEN = MAGIC.length + PREFIX_LEN;
const TAG_LEN = 16;
const FRAME_HEAD = 5;   // flag(1) + len(4)

/** 参加用の秘密から HKDF（SHA-256）でファイル鍵を導く。salt と info は全端末で同じ定数にする。 */
export function deriveFileKey(joinSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(joinSecret, 'utf8'), 'hangar-salt-v1', 'hangar-file-v1', 32));
}

const nonceOf = (prefix: Buffer, idx: number): Buffer => { const n = Buffer.alloc(12); prefix.copy(n, 0); n.writeUInt32BE(idx, 8); return n; };
const aadOf = (idx: number, flag: number): Buffer => { const a = Buffer.alloc(5); a.writeUInt32BE(idx, 0); a[4] = flag; return a; };

/** 平文を 1MB ごとに AES-256-GCM で包む Transform。最後のチャンクは flag = 1 で出す。 */
export function encryptStream(key: Buffer, noncePrefix: Buffer = randomBytes(PREFIX_LEN)): Transform {
  if (noncePrefix.length !== PREFIX_LEN) throw new Error('nonce 接頭辞は 8 バイト');
  let pending: Buffer[] = [];
  let buffered = 0;
  let idx = 0;
  let headerSent = false;
  const emit = (self: Transform, plain: Buffer, last: boolean) => {
    if (!headerSent) { self.push(Buffer.concat([MAGIC, noncePrefix])); headerSent = true; }
    const flag = last ? 1 : 0;
    const c = createCipheriv('aes-256-gcm', key, nonceOf(noncePrefix, idx));
    c.setAAD(aadOf(idx, flag));
    const body = Buffer.concat([c.update(plain), c.final()]);
    const head = Buffer.alloc(FRAME_HEAD);
    head[0] = flag;
    head.writeUInt32BE(body.length, 1);
    self.push(Buffer.concat([head, body, c.getAuthTag()]));
    idx++;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      pending.push(chunk);
      buffered += chunk.length;
      // 最終チャンクを flush で出すため、ちょうど 1MB 残るまでは出さない。
      while (buffered > CHUNK_SIZE) {
        const all = Buffer.concat(pending);
        emit(this, all.subarray(0, CHUNK_SIZE), false);
        const rest = all.subarray(CHUNK_SIZE);
        pending = rest.length ? [Buffer.from(rest)] : [];
        buffered = rest.length;
      }
      cb();
    },
    flush(cb) {
      emit(this, Buffer.concat(pending), true);
      cb();
    },
  });
}

/** encryptStream の逆。magic、タグ、末尾の切り詰め、最終チャンク後の余りを検査する。 */
export function decryptStream(key: Buffer): Transform {
  let buf = Buffer.alloc(0);
  let prefix: Buffer | null = null;
  let idx = 0;
  let finished = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (!prefix) {
          if (buf.length < HEADER_LEN) return cb();
          if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('暗号化ファイルの形式が違います');
          prefix = Buffer.from(buf.subarray(MAGIC.length, HEADER_LEN));
          buf = buf.subarray(HEADER_LEN);
        }
        while (buf.length >= FRAME_HEAD) {
          if (finished) throw new Error('最終チャンクの後にデータがあります');
          const flag = buf[0]!;
          const len = buf.readUInt32BE(1);
          if (buf.length < FRAME_HEAD + len + TAG_LEN) break;
          const body = buf.subarray(FRAME_HEAD, FRAME_HEAD + len);
          const tag = buf.subarray(FRAME_HEAD + len, FRAME_HEAD + len + TAG_LEN);
          const d = createDecipheriv('aes-256-gcm', key, nonceOf(prefix, idx));
          d.setAAD(aadOf(idx, flag));
          d.setAuthTag(tag);
          this.push(Buffer.concat([d.update(body), d.final()]));
          idx++;
          buf = buf.subarray(FRAME_HEAD + len + TAG_LEN);
          if (flag === 1) finished = true;
        }
        if (finished && buf.length > 0) throw new Error('最終チャンクの後にデータがあります');
        cb();
      } catch (e) { cb(e as Error); }
    },
    flush(cb) {
      if (!finished) return cb(new Error('暗号化ファイルが切り詰められています（truncated）'));
      cb();
    },
  });
}

const collect = async (s: Readable): Promise<Buffer> => { const out: Buffer[] = []; for await (const c of s) out.push(c as Buffer); return Buffer.concat(out); };

export function encryptBuffer(key: Buffer, data: Buffer): Promise<Buffer> {
  return collect(Readable.from([data]).pipe(encryptStream(key)));
}

export function decryptBuffer(key: Buffer, data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const d = decryptStream(key);
    d.on('error', reject);
    collect(d).then(resolve, reject);
    Readable.from([data]).pipe(d);
  });
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256Stream(input: Readable): Promise<string> {
  const h = createHash('sha256');
  for await (const c of input) h.update(c as Buffer);
  return h.digest('hex');
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/sync/crypto && npx tsc -p packages/server`
Expected: PASS（6 件）。`tsc` は Task 1 の `SessionDto` の差分で `queries.ts` に失敗が残る（Task 15 で直す）。

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/sync/crypto.ts packages/server/src/sync/crypto.test.ts
git commit -m "feat(server): HKDF file key and chunked AES-256-GCM streams with truncation detection"
```

---

### Task 7: CloudClient（HTTP の実装とメモリ上の偽物）

**Files:**
- Create: `packages/server/src/sync/client.ts`、`packages/server/test/fake-cloud.ts`
- Test: `packages/server/src/sync/client.test.ts`、`packages/server/test/fake-cloud.test.ts`

**Interfaces:**
- Consumes: shared の契約、`CLOUD_HEADERS`。
- Produces: 「インターフェース一覧」の `CloudClient`、`HttpCloudClient`、`CloudError`、`FakeCloudClient`。
- `HttpCloudClient` は `fetch` を注入でき、テストは偽の `fetch` で要求の形（URL、ヘッダ、本文）を確かめる。`putFile` は Node の `Readable` を `Readable.toWeb` で Web ストリームにし、`duplex: 'half'` で送る。`getFile` は応答の本体を `Readable.fromWeb` で返す。応答が 2xx でなければ `CloudError(status, 本文の先頭 200 字)`。接続できないときは `CloudError(0, message)`。
- `FakeCloudClient` は Worker と同じ規則（LWW、自端末の除外、鍵の権限、seq）をメモリ上で再現する。`asDevice(id)` で同じストアを別の端末として使うクライアントを作れるので、2 端末の同期をテストできる。`offline = true` にすると全メソッドが `CloudError(0)` を投げる。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/sync/client.test.ts`：

```ts
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CloudError, HttpCloudClient } from './client.ts';

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (c: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => { const c = { url: String(input), init: init ?? {} }; calls.push(c); return handler(c); }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

describe('HttpCloudClient', () => {
  it('Bearer を付け、URL の末尾のスラッシュを整える', async () => {
    const { fetch, calls } = fakeFetch(() => json({ ok: true, version: '0.4.0' }));
    const c = new HttpCloudClient({ url: 'https://h.example.workers.dev/', token: 'tok', fetch });
    expect(await c.health()).toEqual({ ok: true, version: '0.4.0' });
    expect(calls[0]!.url).toBe('https://h.example.workers.dev/health');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
  it('pushChanges と pullChanges と snapshot', async () => {
    const { fetch, calls } = fakeFetch((c) => c.url.includes('/rows') ? json({ changes: [], nextAfter: null, seq: 7 }) : c.init.method === 'POST' ? json({ seq: 3, accepted: 1, skipped: 0 }) : json({ changes: [], nextSeq: 3, more: false }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    const ch = { tableName: 'projects' as const, rowId: 'p1', op: 'upsert' as const, payload: { id: 'p1' }, updatedAt: 1 };
    expect(await c.pushChanges([ch])).toEqual({ seq: 3, accepted: 1, skipped: 0 });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ changes: [ch] });
    await c.pullChanges(5, 100);
    expect(calls[1]!.url).toBe('https://h/changes?since=5&limit=100');
    await c.snapshot('projects:p1', 50);
    expect(calls[2]!.url).toBe('https://h/rows?after=projects%3Ap1&limit=50');
    await c.snapshot(null, 50);
    expect(calls[3]!.url).toBe('https://h/rows?after=&limit=50');
  });
  it('putFile はヘッダとストリーム本文を送り、getFile は Readable を返す', async () => {
    const { fetch, calls } = fakeFetch(async (c) => {
      if (c.init.method === 'PUT') { const body = await new Response(c.init.body as ReadableStream).text(); return json({ seq: 9, echoed: body }, 201); }
      return new Response('payload', { status: 200 });
    });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    const r = await c.putFile({ key: 'transcripts/d/u.jsonl.gz', path: 'projects/-x/u.jsonl', kind: 'transcript', sha256: 'a'.repeat(64), size: 3, mtime: 5, encrypted: true }, Readable.from([Buffer.from('ab'), Buffer.from('c')]));
    expect(r).toEqual({ seq: 9 });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe('https://h/files/transcripts/d/u.jsonl.gz');
    expect(h['x-hangar-path']).toBe('projects/-x/u.jsonl');
    expect(h['x-hangar-encrypted']).toBe('1');
    expect((calls[0]!.init as { duplex?: string }).duplex).toBe('half');
    const body = await c.getFile('transcripts/d/u.jsonl.gz');
    let text = ''; for await (const ch of body) text += ch;
    expect(text).toBe('payload');
  });
  it('2xx 以外は CloudError、接続失敗は status 0', async () => {
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch: fakeFetch(() => new Response('unauthorized', { status: 401 })).fetch });
    await expect(c.health()).rejects.toMatchObject({ status: 401, message: expect.stringContaining('unauthorized') });
    const down = new HttpCloudClient({ url: 'https://h', token: 't', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(down.health()).rejects.toBeInstanceOf(CloudError);
    await expect(down.health()).rejects.toMatchObject({ status: 0 });
  });
});
```

`packages/server/test/fake-cloud.test.ts`：

```ts
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FakeCloudClient } from './fake-cloud.ts';

const ch = (rowId: string, updatedAt: number) => ({ tableName: 'projects' as const, rowId, op: 'upsert' as const, payload: { id: rowId, updated_at: updatedAt }, updatedAt });

describe('FakeCloudClient', () => {
  it('Worker と同じ LWW と自端末の除外', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const b = a.asDevice('b');
    expect(await a.pushChanges([ch('p1', 100)])).toEqual({ seq: 1, accepted: 1, skipped: 0 });
    expect(await b.pushChanges([ch('p1', 50)])).toEqual({ seq: 1, accepted: 0, skipped: 1 });
    expect(await b.pushChanges([ch('p1', 200)])).toEqual({ seq: 2, accepted: 1, skipped: 0 });
    const pa = await a.pullChanges(0, 500);
    expect(pa.changes.map((c) => [c.seq, c.deviceId])).toEqual([[2, 'b']]);
    expect(pa.nextSeq).toBe(2);
    expect((await b.pullChanges(0, 500)).changes.map((c) => c.seq)).toEqual([1]);
    expect((await a.snapshot(null, 500)).changes.map((c) => c.rowId)).toEqual(['p1']);
  });
  it('ファイルは本体を集めて持ち、権限を検査する', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const meta = { key: 'transcripts/a/u.jsonl.gz', path: 'projects/-x/u.jsonl', kind: 'transcript' as const, sha256: 'a'.repeat(64), size: 3, mtime: 1, encrypted: true };
    expect(await a.putFile(meta, Readable.from([Buffer.from('abc')]))).toEqual({ seq: 1 });
    await expect(a.asDevice('b').putFile(meta, Readable.from([Buffer.from('x')]))).rejects.toMatchObject({ status: 403 });
    const l = await a.asDevice('b').listFiles(0, 500);
    expect(l.files[0]).toMatchObject({ key: meta.key, deviceId: 'a', seq: 1 });
    let text = ''; for await (const c of await a.asDevice('b').getFile(meta.key)) text += c;
    expect(text).toBe('abc');
    await expect(a.getFile('transcripts/a/nope')).rejects.toMatchObject({ status: 404 });
  });
  it('offline は status 0 の CloudError', async () => {
    const a = new FakeCloudClient();
    a.offline = true;
    await expect(a.health()).rejects.toMatchObject({ status: 0 });
    await expect(a.pushChanges([])).rejects.toMatchObject({ status: 0 });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/sync/client packages/server/test/fake-cloud`
Expected: FAIL

- [ ] **Step 3: HttpCloudClient を書く**

`packages/server/src/sync/client.ts`：

```ts
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { CLOUD_HEADERS, type ChangeIn, type FileMetaIn, type ListFilesResponse, type PullChangesResponse, type PushChangesResponse, type SnapshotResponse } from '@agent-hangar/shared';

export class CloudError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'CloudError'; }
}

/** 端末から見た Worker。HttpCloudClient が本物、FakeCloudClient（test/fake-cloud.ts）がメモリ上の偽物。 */
export interface CloudClient {
  health(): Promise<{ ok: boolean; version: string }>;
  pushChanges(changes: ChangeIn[]): Promise<PushChangesResponse>;
  pullChanges(since: number, limit: number): Promise<PullChangesResponse>;
  snapshot(after: string | null, limit: number): Promise<SnapshotResponse>;
  putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }>;
  getFile(key: string): Promise<Readable>;
  listFiles(since: number, limit: number): Promise<ListFilesResponse>;
  deleteFile(key: string): Promise<void>;
}

export class HttpCloudClient implements CloudClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  constructor(private readonly o: { url: string; token: string; fetch?: typeof fetch }) {
    this.base = o.url.replace(/\/+$/, '');
    this.fetchFn = o.fetch ?? ((...a) => fetch(...a));
  }

  private async raw(path: string, init: RequestInit & { duplex?: 'half' } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, { ...init, headers: { authorization: `Bearer ${this.o.token}`, ...(init.headers as Record<string, string> | undefined ?? {}) } });
    } catch (e) {
      throw new CloudError(0, e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw new CloudError(res.status, (await res.text().catch(() => '')).slice(0, 200) || `HTTP ${res.status}`);
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.raw(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined ?? {}) } });
    return (await res.json()) as T;
  }

  health() { return this.json<{ ok: boolean; version: string }>('/health'); }
  pushChanges(changes: ChangeIn[]) { return this.json<PushChangesResponse>('/changes', { method: 'POST', body: JSON.stringify({ changes }) }); }
  pullChanges(since: number, limit: number) { return this.json<PullChangesResponse>(`/changes?since=${since}&limit=${limit}`); }
  snapshot(after: string | null, limit: number) { return this.json<SnapshotResponse>(`/rows?after=${encodeURIComponent(after ?? '')}&limit=${limit}`); }
  listFiles(since: number, limit: number) { return this.json<ListFilesResponse>(`/files?since=${since}&limit=${limit}`); }

  async putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }> {
    const headers: Record<string, string> = {
      [CLOUD_HEADERS.path]: meta.path, [CLOUD_HEADERS.kind]: meta.kind, [CLOUD_HEADERS.sha256]: meta.sha256,
      [CLOUD_HEADERS.size]: String(meta.size), [CLOUD_HEADERS.mtime]: String(meta.mtime), [CLOUD_HEADERS.encrypted]: meta.encrypted ? '1' : '0',
      'content-type': 'application/octet-stream',
    };
    const res = await this.raw(`/files/${meta.key}`, { method: 'PUT', headers, body: Readable.toWeb(body) as unknown as BodyInit, duplex: 'half' });
    return (await res.json()) as { seq: number };
  }

  async getFile(key: string): Promise<Readable> {
    const res = await this.raw(`/files/${key}`);
    if (!res.body) return Readable.from([]);
    return Readable.fromWeb(res.body as unknown as WebReadableStream);
  }

  async deleteFile(key: string): Promise<void> { await this.raw(`/files/${key}`, { method: 'DELETE' }); }
}
```

- [ ] **Step 4: FakeCloudClient を書く**

`packages/server/test/fake-cloud.ts`：

```ts
import { Readable } from 'node:stream';
import type { ChangeIn, ChangeOut, FileEntry, FileMetaIn, ListFilesResponse, PullChangesResponse, PushChangesResponse, SnapshotResponse } from '@agent-hangar/shared';
import { CloudError, type CloudClient } from '../src/sync/client.ts';

type Store = { changes: ChangeOut[]; rows: Map<string, ChangeOut>; files: Map<string, { entry: FileEntry; body: Buffer }>; seq: number; fileSeq: number; offline: boolean };

/** Worker と同じ規則をメモリ上で再現する偽物。asDevice で同じストアを別端末として使う。 */
export class FakeCloudClient implements CloudClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly store: Store;
  readonly deviceId: string;

  constructor(o: { deviceId?: string; store?: Store } = {}) {
    this.deviceId = o.deviceId ?? 'self';
    this.store = o.store ?? { changes: [], rows: new Map(), files: new Map(), seq: 0, fileSeq: 0, offline: false };
  }

  get offline(): boolean { return this.store.offline; }
  set offline(v: boolean) { this.store.offline = v; }
  get changes(): ChangeOut[] { return this.store.changes; }
  get rows(): Map<string, ChangeOut> { return this.store.rows; }
  get files(): Map<string, { entry: FileEntry; body: Buffer }> { return this.store.files; }

  asDevice(deviceId: string): FakeCloudClient { return new FakeCloudClient({ deviceId, store: this.store }); }

  private guard(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.store.offline) throw new CloudError(0, 'offline');
  }

  async health() { this.guard('health'); return { ok: true, version: 'fake' }; }

  async pushChanges(changes: ChangeIn[]): Promise<PushChangesResponse> {
    this.guard('pushChanges', changes);
    let accepted = 0, skipped = 0;
    const latest = new Map<string, ChangeIn>();
    for (const ch of changes) { const k = `${ch.tableName}:${ch.rowId}`; const cur = latest.get(k); if (!cur) latest.set(k, ch); else { skipped++; if (ch.updatedAt > cur.updatedAt) latest.set(k, ch); } }
    for (const [k, ch] of latest) {
      const prev = this.store.rows.get(k);
      if (prev && prev.updatedAt >= ch.updatedAt) { skipped++; continue; }
      const out: ChangeOut = { ...ch, payload: structuredClone(ch.payload), seq: ++this.store.seq, deviceId: this.deviceId };
      this.store.changes.push(out);
      this.store.rows.set(k, out);
      accepted++;
    }
    return { seq: this.store.seq, accepted, skipped };
  }

  async pullChanges(since: number, limit: number): Promise<PullChangesResponse> {
    this.guard('pullChanges', since, limit);
    const all = this.store.changes.filter((c) => c.seq > since && c.deviceId !== this.deviceId);
    const page = all.slice(0, limit);
    const more = all.length > limit;
    return { changes: page.map((c) => structuredClone(c)), nextSeq: more ? page[page.length - 1]!.seq : Math.max(this.store.seq, since), more };
  }

  async snapshot(after: string | null, limit: number): Promise<SnapshotResponse> {
    this.guard('snapshot', after, limit);
    const keys = [...this.store.rows.keys()].sort().filter((k) => k > (after ?? ''));
    const page = keys.slice(0, limit);
    return { changes: page.map((k) => ({ ...structuredClone(this.store.rows.get(k)!), seq: 0 })), nextAfter: keys.length > limit ? page[page.length - 1]! : null, seq: this.store.seq };
  }

  private checkKey(key: string, write: boolean): void {
    if (!/^(transcripts|config)\/[A-Za-z0-9._\-\/]+$/.test(key) || key.split('/').some((s) => s === '' || s === '..')) throw new CloudError(400, 'invalid key');
    if (write && key.startsWith('transcripts/') && !key.startsWith(`transcripts/${this.deviceId}/`)) throw new CloudError(403, 'forbidden');
  }

  async putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }> {
    this.guard('putFile', meta);
    this.checkKey(meta.key, true);
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    const buf = Buffer.concat(chunks);
    const seq = ++this.store.fileSeq;
    this.store.files.set(meta.key, { entry: { ...meta, seq, deviceId: this.deviceId, uploadedAt: Date.now(), storedSize: buf.length }, body: buf });
    return { seq };
  }

  async getFile(key: string): Promise<Readable> {
    this.guard('getFile', key);
    this.checkKey(key, false);
    const f = this.store.files.get(key);
    if (!f) throw new CloudError(404, 'not found');
    return Readable.from([Buffer.from(f.body)]);
  }

  async listFiles(since: number, limit: number): Promise<ListFilesResponse> {
    this.guard('listFiles', since, limit);
    const all = [...this.store.files.values()].map((f) => f.entry).filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
    const page = all.slice(0, limit);
    return { files: page.map((e) => ({ ...e })), nextSeq: page.length ? page[page.length - 1]!.seq : since, more: all.length > limit };
  }

  async deleteFile(key: string): Promise<void> {
    this.guard('deleteFile', key);
    this.checkKey(key, true);
    this.store.files.delete(key);
  }
}
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/sync/client packages/server/test/fake-cloud`
Expected: PASS（7 件）

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/sync/client.ts packages/server/src/sync/client.test.ts packages/server/test/fake-cloud.ts packages/server/test/fake-cloud.test.ts
git commit -m "feat(server): cloud client over fetch and an in-memory fake with the worker's rules"
```

---

### Task 8: cloud.json、マイグレーション 6、sync_state、書き込みの通知

**Files:**
- Create: `packages/server/src/config/cloud.ts`、`packages/server/src/sync/state.ts`
- Modify: `packages/server/src/config/paths.ts`、`packages/server/src/db/migrations.ts`、`packages/server/src/db/shared.ts`、`packages/server/src/index.ts`
- Test: `packages/server/src/config/cloud.test.ts`、`packages/server/src/sync/state.test.ts`、`packages/server/src/db/db.test.ts`（追加）

**Interfaces:**
- Produces: 「インターフェース一覧」の `config/cloud.ts`、`sync/state.ts`、`onSharedWrite`。
- `Settings` に `syncClaudeConfig: boolean`（既定 false）を足す。`loadSettings` の既定値に含める。
- マイグレーション `version: 6`（実物の最終番号は 5 である。Task 0 でさらに増えていたら、その次の番号に読み替える）：
  ```sql
  alter table transcript_files add column device_id text;
  create index transcript_files_device on transcript_files(session_id, device_id);
  create table file_sync (key text primary key, kind text not null, path text not null, device_id text not null, sha256 text not null, size integer not null, mtime integer not null, remote_seq integer, synced_at integer not null);
  create index file_sync_path on file_sync(kind, path);
  ```
- `onSharedWrite` は `upsertShared` と `softDeleteShared` のトランザクションが終わった後に同期的に呼ばれ、表名と行 ID と書き込んだ `Db` を渡す。登録解除の関数を返す。複数の DB を開くテストでは `Db` で自分の分だけを拾う。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/config/cloud.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupsRoot, cloudConfigPath, loadCloudConfig, remoteRoot, saveCloudConfig } from './cloud.ts';

describe('cloud.json', () => {
  it('無ければ null、保存したら 0600 で読み戻せる', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    expect(loadCloudConfig(home)).toBeNull();
    const c = { url: 'https://h.workers.dev', joinSecret: 's', deviceToken: 't', workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files', joinedAt: 1 };
    saveCloudConfig(home, c);
    expect(loadCloudConfig(home)).toEqual(c);
    expect(fs.statSync(cloudConfigPath(home)).mode & 0o777).toBe(0o600);
    expect(remoteRoot(home)).toBe(path.join(home, 'remote'));
    expect(backupsRoot(home)).toBe(path.join(home, 'backups'));
  });
  it('壊れたファイルは null', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    fs.writeFileSync(cloudConfigPath(home), '{');
    expect(loadCloudConfig(home)).toBeNull();
    fs.writeFileSync(cloudConfigPath(home), JSON.stringify({ url: 'x' }));
    expect(loadCloudConfig(home)).toBeNull();
  });
});
```

`packages/server/src/sync/state.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { SyncStateStore } from './state.ts';

describe('SyncStateStore', () => {
  it('文字列、数値、真偽、null を往復する', () => {
    const s = new SyncStateStore(openDb(':memory:'));
    expect(s.get('lastSeq')).toBeNull();
    expect(s.getNumber('lastSeq', 0)).toBe(0);
    s.set('lastSeq', 42);
    expect(s.getNumber('lastSeq', 0)).toBe(42);
    s.set('paused', true);
    expect(s.get('paused')).toBe('1');
    s.set('paused', false);
    expect(s.get('paused')).toBe('0');
    s.set('lastError', 'x');
    s.set('lastError', null);
    expect(s.get('lastError')).toBeNull();
  });
  it('譲ったセッションの記録', () => {
    const s = new SyncStateStore(openDb(':memory:'));
    expect(s.isYielded('u1')).toBe(false);
    s.setYielded('u1', true);
    expect(s.isYielded('u1')).toBe(true);
    s.setYielded('u1', false);
    expect(s.isYielded('u1')).toBe(false);
  });
});
```

`packages/server/src/db/db.test.ts` に足す。

```ts
import { onSharedWrite, softDeleteShared, upsertShared } from './shared.ts';

describe('マイグレーション 6 と書き込みの通知', () => {
  it('transcript_files.device_id と file_sync がある', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('pragma table_info(transcript_files)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('device_id');
    expect(db.prepare("select name from sqlite_master where name = 'file_sync'").get()).toBeTruthy();
  });
  it('onSharedWrite は upsert と delete の後に呼ばれ、解除できる', () => {
    const db = openDb(':memory:');
    const seen: string[] = [];
    const other = openDb(':memory:');
    const off = onSharedWrite((t, id, d) => { if (d === db) seen.push(`${t}:${id}`); });
    upsertShared(other, 'projects', { id: 'px', name: 'x', status: 'active' }, 'd');
    upsertShared(db, 'projects', { id: 'p1', name: 'a', status: 'active' }, 'd');
    softDeleteShared(db, 'projects', 'p1', 'd');
    off();
    upsertShared(db, 'projects', { id: 'p2', name: 'b', status: 'active' }, 'd');
    expect(seen).toEqual(['projects:p1', 'projects:p1']);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/config/cloud packages/server/src/sync/state packages/server/src/db`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/config/cloud.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';

/** ~/.agent-hangar/cloud.json。参加用の秘密と端末トークンを含むので 0600 で置く。 */
export type CloudConfig = { url: string; joinSecret: string; deviceToken: string; workerName: string | null; accountId: string | null; dbName: string | null; bucketName: string | null; joinedAt: number };

export function cloudConfigPath(home: string): string { return path.join(home, 'cloud.json'); }
export function remoteRoot(home: string): string { return path.join(home, 'remote'); }
export function backupsRoot(home: string): string { return path.join(home, 'backups'); }

export function loadCloudConfig(home: string): CloudConfig | null {
  const file = cloudConfigPath(home);
  if (!fs.existsSync(file)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CloudConfig>;
    if (typeof v.url !== 'string' || typeof v.joinSecret !== 'string' || typeof v.deviceToken !== 'string') return null;
    return { url: v.url, joinSecret: v.joinSecret, deviceToken: v.deviceToken, workerName: v.workerName ?? null, accountId: v.accountId ?? null, dbName: v.dbName ?? null, bucketName: v.bucketName ?? null, joinedAt: typeof v.joinedAt === 'number' ? v.joinedAt : 0 };
  } catch {
    return null;
  }
}

export function saveCloudConfig(home: string, c: CloudConfig): void {
  const file = cloudConfigPath(home);
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
```

`packages/server/src/sync/state.ts`：

```ts
import type { Db } from '../db/open.ts';

export type SyncStateKey = 'lastSeq' | 'filesSeq' | 'lastPushAt' | 'lastPullAt' | 'paused' | 'lastError' | 'configPullConfirmed' | 'snapshotDone';

/** sync_state（端末ローカル）の薄い包み。値は文字列で持ち、真偽は '1' と '0' にする。 */
export class SyncStateStore {
  private readonly getStmt; private readonly setStmt; private readonly delStmt;
  constructor(db: Db) {
    this.getStmt = db.prepare('select value from sync_state where key = ?');
    this.setStmt = db.prepare('insert into sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value');
    this.delStmt = db.prepare('delete from sync_state where key = ?');
  }
  get(key: SyncStateKey | `yielded:${string}`): string | null {
    const r = this.getStmt.get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  getNumber(key: SyncStateKey, fallback: number): number {
    const v = this.get(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  set(key: SyncStateKey | `yielded:${string}`, value: string | number | boolean | null): void {
    if (value === null) { this.delStmt.run(key); return; }
    this.setStmt.run(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  isYielded(sessionUuid: string): boolean { return this.get(`yielded:${sessionUuid}`) === '1'; }
  setYielded(sessionUuid: string, yielded: boolean): void { this.set(`yielded:${sessionUuid}`, yielded ? '1' : null); }
}
```

`packages/server/src/db/migrations.ts` の配列に足す。

```ts
  {
    version: 6,
    sql: `
alter table transcript_files add column device_id text;
create index transcript_files_device on transcript_files(session_id, device_id);
create table file_sync (
  key text primary key, kind text not null, path text not null, device_id text not null,
  sha256 text not null, size integer not null, mtime integer not null,
  remote_seq integer, synced_at integer not null
);
create index file_sync_path on file_sync(kind, path);
`,
  },
```

`packages/server/src/db/shared.ts` に足し、`upsertShared` と `softDeleteShared` の `write();` の直後に `notify(db, table, id)` を呼ぶ（`upsertShared` では `String(full[pk])`）。

```ts
const writeListeners = new Set<(table: string, rowId: string, db: Db) => void>();

/** 共有テーブルへの書き込みの後に呼ばれる。同期エンジンが push のデバウンスに使う。 */
export function onSharedWrite(cb: (table: string, rowId: string, db: Db) => void): () => void {
  writeListeners.add(cb);
  return () => { writeListeners.delete(cb); };
}

function notify(db: Db, table: string, rowId: string): void {
  for (const cb of writeListeners) cb(table, rowId, db);
}
```

`packages/server/src/config/paths.ts` の `Settings` に `syncClaudeConfig: boolean` を足し、`defaultSettings()` に `syncClaudeConfig: false` を足す。
`packages/server/src/index.ts` に `export { loadCloudConfig, saveCloudConfig, cloudConfigPath, type CloudConfig } from './config/cloud.ts';` を足す（CLI が使う）。

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/config packages/server/src/sync/state packages/server/src/db`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/config packages/server/src/sync/state.ts packages/server/src/sync/state.test.ts packages/server/src/db packages/server/src/index.ts
git commit -m "feat(server): cloud config file, sync state store, file_sync table and shared write hook"
```

---

### Task 9: SyncEngine の push（デバウンス、最小間隔、バッチ、無料枠の見張り、オフラインの積み残し）

**Files:**
- Create: `packages/server/src/sync/engine.ts`、`packages/server/src/sync/quota.ts`、`packages/server/test/fake-timers.ts`
- Test: `packages/server/src/sync/engine.test.ts`、`packages/server/src/sync/quota.test.ts`

**Interfaces:**
- Consumes: `onSharedWrite`、`SyncStateStore`、`CloudClient`、`CloudError`、`MAX_PUSH_BATCH`、`FakeCloudClient`。
- Produces: 「インターフェース一覧」の `SyncEngine` のうち `constructor`、`on`、`status`、`start`（push とタイマーの部分）、`stop`、`noteLocalChange`、`pushNow`、`setPaused`、`pending`、`setClaudeConfigStatus`。`pullNow`、`syncNow`、`pullBeforeLaunch`、`onFocus` は Task 10 で足す（この Task では `pullNow` は空実装で `{ applied: 0 }` を返す）。`QuotaCounter` も全部ここで作る。
- **push の最小間隔**：`pushMinGapMs`（既定 10_000）を置く。デバウンスの期限が来ても、前回の push から `pushMinGapMs` 経っていなければ、残り時間だけタイマーを引き直す。デバウンスは「変更が止まってから 1 秒」なので、実行中のセッションのように変更が途切れない相手には効かないためである。利用者が押した `pushNow` と `syncNow` は間隔を無視する。
- **無料枠の見張り**：`QuotaCounter` が `sync_state` の `quota:<yyyy-MM-dd>` に「その日に送った行数」と「その日に出した要求の回数」を JSON で持つ。push のたびに `note({ rows, requests: 1 })` を呼び、`exceeded()`（既定の上限 10 万のどちらかが 80% に達した）になったら `setPaused(true)` にして `toast('info', '無料枠の 80% に達したので同期を止めました。Settings で再開できます')` を出す。日付が変われば数え直す。一時停止は自動では解けず、利用者が「同期を再開」を押すまで止まる。
- テスト用の時計：
  ```ts
  // packages/server/test/fake-timers.ts
  export class FakeTimers {
    now: number;                       // ミリ秒。既定 1_000_000
    setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval;
    advance(ms: number): Promise<void>;   // 期限の来たタイマーを順に発火し、各発火の後にマイクロタスクを流す
    pendingCount(): number;
  }
  ```
- push の規則：`changes` の `pushed_at is null` を `seq` 順に 40 行ずつ（`MAX_PUSH_BATCH`）送る。成功したら `pushed_at` を書き、`lastPushAt` を更新する。失敗したら `lastError` を残して止め、行はそのまま残す（次の push で再送）。push の最後に `pushed_at` が 7 日より古い行を消す。`paused` のときは何もしない。
- `changes` は 1 論理変更に 1 行とは限らない。フェーズ 1 の修正で、未送信の行は `(table_name, row_id)` ごとにまとめられる（インデクサが本文の追記のたびに `sessions` を書くため、まとめないと台帳が膨らむ）。まとめ直しで行の `seq` が動いても、`pushed_at is null` を `seq` 昇順に取り、送れた行にだけ `pushed_at` を書くこの実装は取りこぼさない。1 行に 1 つの最新 payload が載っている前提だけを置く。

- [ ] **Step 1: FakeTimers を書く**

`packages/server/test/fake-timers.ts`：

```ts
type Entry = { id: number; at: number; fn: () => void; interval: number | null };

/** 同期エンジンのデバウンスと定期実行を、実時間を待たずに進める時計。 */
export class FakeTimers {
  now = 1_000_000;
  private entries: Entry[] = [];
  private nextId = 1;

  setTimeout = ((fn: () => void, ms: number) => { const id = this.nextId++; this.entries.push({ id, at: this.now + ms, fn, interval: null }); return this.handle(id); }) as unknown as typeof setTimeout;
  clearTimeout = ((h: unknown) => { this.entries = this.entries.filter((e) => e.id !== this.idOf(h)); }) as typeof clearTimeout;
  setInterval = ((fn: () => void, ms: number) => { const id = this.nextId++; this.entries.push({ id, at: this.now + ms, fn, interval: ms }); return this.handle(id); }) as unknown as typeof setInterval;
  clearInterval = ((h: unknown) => { this.entries = this.entries.filter((e) => e.id !== this.idOf(h)); }) as typeof clearInterval;

  private handle(id: number): NodeJS.Timeout { return { id, unref() { return this; }, ref() { return this; } } as unknown as NodeJS.Timeout; }
  private idOf(h: unknown): number { return (h as { id: number }).id; }

  pendingCount(): number { return this.entries.length; }

  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.entries].filter((e) => e.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      if (due.interval === null) this.entries = this.entries.filter((e) => e !== due);
      else due.at += due.interval;
      due.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

/** 非同期の連鎖を流し切る。setImmediate を数回回す。 */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/server/src/sync/engine.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers, flush } from '../../test/fake-timers.ts';
import { SyncEngine } from './engine.ts';

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
const make = (over: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) => new SyncEngine({ db, deviceId: 'a', client: cloud, now: () => timers.now, timers, url: 'https://h', ...over });
const unpushed = () => (db.prepare('select count(*) c from changes where pushed_at is null').get() as { c: number }).c;
const project = (id: string, name = id) => upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0 }, 'a');

beforeEach(() => { db = openDb(':memory:'); cloud = new FakeCloudClient({ deviceId: 'a' }); timers = new FakeTimers(); });

describe('SyncEngine の push', () => {
  it('書き込みの 1 秒後に未送信分をまとめて送り、pushed_at を書く', async () => {
    const e = make();
    await e.start();
    const statuses: string[] = [];
    e.on({ status: (s) => statuses.push(s.state) });
    project('p1'); project('p2');
    expect(unpushed()).toBe(2);
    expect(e.status().pending).toBe(2);
    await timers.advance(999);
    expect(cloud.changes).toHaveLength(0);
    await timers.advance(1);
    expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1', 'p2']);
    expect(unpushed()).toBe(0);
    expect(e.status()).toMatchObject({ state: 'idle', pending: 0, lastPushAt: timers.now, error: null, url: 'https://h' });
    expect(statuses).toContain('pushing');
    e.stop();
  });
  it('40 行ずつのバッチに分ける', async () => {
    const e = make();
    await e.start();
    for (let i = 0; i < 90; i++) project(`p${i}`);
    await e.pushNow();
    expect(cloud.calls.filter((c) => c.method === 'pushChanges').map((c) => (c.args[0] as unknown[]).length)).toEqual([40, 40, 10]);
    expect(unpushed()).toBe(0);
    e.stop();
  });
  it('オフラインでは積んだまま残し、復帰で順に送る', async () => {
    const e = make();
    await e.start();
    cloud.offline = true;
    project('p1');
    await timers.advance(1000);
    expect(unpushed()).toBe(1);
    expect(e.status()).toMatchObject({ state: 'error', pending: 1 });
    expect(e.status().error).toContain('offline');
    project('p2');
    await timers.advance(1000);
    expect(unpushed()).toBe(2);
    cloud.offline = false;
    await e.pushNow();
    expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1', 'p2']);
    expect(e.status()).toMatchObject({ state: 'idle', error: null, pending: 0 });
    e.stop();
  });
  it('一時停止中は送らず、再開で送る', async () => {
    const e = make();
    await e.start();
    e.setPaused(true);
    expect(e.status().state).toBe('paused');
    project('p1');
    await timers.advance(5000);
    expect(unpushed()).toBe(1);
    e.setPaused(false);
    await timers.advance(1000);
    expect(unpushed()).toBe(0);
    const e2 = make();
    expect(e2.status().state).toBe('idle');   // paused は sync_state に残らない値 '0'
    e.stop();
  });
  it('client が無ければ off で、書き込みは積むだけ', async () => {
    const e = make({ client: null, url: null });
    await e.start();
    project('p1');
    await timers.advance(2000);
    expect(e.status()).toMatchObject({ state: 'off', pending: 1, url: null });
    expect(cloud.calls).toEqual([]);
    e.stop();
  });
  it('push 済みで 7 日を過ぎた行を消す', async () => {
    const e = make();
    await e.start();
    project('p1');
    await e.pushNow();
    timers.now += 8 * 86_400_000;
    project('p2');
    await e.pushNow();
    expect((db.prepare('select row_id from changes order by seq').all() as { row_id: string }[]).map((r) => r.row_id)).toEqual(['p2']);
    e.stop();
  });
  it('stop の後は書き込みに反応しない', async () => {
    const e = make();
    await e.start();
    e.stop();
    project('p1');
    await timers.advance(2000);
    expect(unpushed()).toBe(1);
    expect(timers.pendingCount()).toBe(0);
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run packages/server/src/sync/engine`
Expected: FAIL（`./engine.ts` が無い）

- [ ] **Step 4: 実装する**

`packages/server/src/sync/engine.ts`：

```ts
import { MAX_PUSH_BATCH, type ChangeIn, type ChangeOp, type ChangeOut, type SharedTable, type SyncStateKind, type SyncStatusDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { onSharedWrite } from '../db/shared.ts';
import type { CloudClient } from './client.ts';
import { SyncStateStore } from './state.ts';

export type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval };
export type SyncEngineDeps = {
  db: Db; deviceId: string; client: CloudClient | null; url?: string | null;
  now?: () => number; timers?: Timers;
  pushDebounceMs?: number; pullIntervalMs?: number; focusMinGapMs?: number;
};
export type SyncListener = { status?(s: SyncStatusDto): void; applied?(c: ChangeOut): void; pulled?(): void };

const LOCAL_CHANGES_KEEP_MS = 7 * 86_400_000;
const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };
type ChangeRow = { seq: number; table_name: SharedTable; row_id: string; op: ChangeOp; payload: string; updated_at: number; device_id: string };
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * メタデータの同期。changes の未送信分を 1 秒のデバウンスで push し、pull で受けた変更を LWW で適用する。
 * client が null なら off で、changes は積むだけになる。
 */
export class SyncEngine {
  readonly state: SyncStateStore;
  private readonly listeners = new Set<SyncListener>();
  private readonly timers: Timers;
  private pushTimer: NodeJS.Timeout | null = null;
  private pullTimer: NodeJS.Timeout | null = null;
  private offWrite: (() => void) | null = null;
  private pushing: Promise<{ pushed: number }> | null = null;
  protected pulling: Promise<{ applied: number }> | null = null;
  private lastError: string | null = null;
  private claudeConfig = { enabled: false, confirmed: false };
  private started = false;

  constructor(protected readonly deps: SyncEngineDeps) {
    this.state = new SyncStateStore(deps.db);
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  protected now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  protected get paused(): boolean { return this.state.get('paused') === '1'; }

  on(l: SyncListener): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  protected emit<K extends keyof SyncListener>(k: K, ...args: Parameters<NonNullable<SyncListener[K]>>): void {
    for (const l of this.listeners) (l[k] as ((...a: unknown[]) => void) | undefined)?.(...args);
  }
  protected emitStatus(): void { this.emit('status', this.status()); }
  protected fail(e: unknown): void { this.lastError = errorMessage(e); this.state.set('lastError', this.lastError); }
  protected clearError(): void { this.lastError = null; this.state.set('lastError', null); }

  pending(): number { return (this.deps.db.prepare('select count(*) c from changes where pushed_at is null').get() as { c: number }).c; }

  status(): SyncStatusDto {
    const state: SyncStateKind = !this.deps.client ? 'off' : this.paused ? 'paused' : this.pushing ? 'pushing' : this.pulling ? 'pulling' : this.lastError ? 'error' : 'idle';
    const num = (k: 'lastPushAt' | 'lastPullAt') => { const v = this.state.get(k); return v === null ? null : Number(v); };
    const deviceCount = (this.deps.db.prepare('select count(*) c from devices where deleted_at is null').get() as { c: number }).c;
    return { state, url: this.deps.url ?? null, lastPushAt: num('lastPushAt'), lastPullAt: num('lastPullAt'), pending: this.pending(), error: state === 'error' ? this.lastError : null, deviceCount, claudeConfig: { ...this.claudeConfig } };
  }

  setClaudeConfigStatus(s: { enabled: boolean; confirmed: boolean }): void { this.claudeConfig = { ...s }; this.emitStatus(); }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.offWrite = onSharedWrite((_t, _id, db) => { if (db === this.deps.db) this.noteLocalChange(); });
    if (!this.deps.client) { this.emitStatus(); return; }
    this.pullTimer = this.timers.setInterval(() => { void this.tick(); }, this.deps.pullIntervalMs ?? 30_000);
    (this.pullTimer as { unref?: () => void }).unref?.();
    await this.syncNow();
  }

  stop(): void {
    this.started = false;
    this.offWrite?.(); this.offWrite = null;
    if (this.pushTimer) this.timers.clearTimeout(this.pushTimer);
    if (this.pullTimer) this.timers.clearInterval(this.pullTimer);
    this.pushTimer = this.pullTimer = null;
  }

  /** 定期実行。push してから pull する。 */
  protected async tick(): Promise<void> {
    if (this.paused) return;
    await this.pushNow();
    await this.pullNow();
  }

  /** ローカルの書き込みの 1 秒後に push する。連続する書き込みは 1 回にまとめる。 */
  noteLocalChange(): void {
    if (!this.started || !this.deps.client) return;
    if (this.pushTimer) this.timers.clearTimeout(this.pushTimer);
    this.pushTimer = this.timers.setTimeout(() => { this.pushTimer = null; void this.pushNow(); }, this.deps.pushDebounceMs ?? 1000);
    (this.pushTimer as { unref?: () => void }).unref?.();
  }

  pushNow(): Promise<{ pushed: number }> {
    if (!this.deps.client || this.paused) return Promise.resolve({ pushed: 0 });
    if (this.pushing) return this.pushing;
    this.pushing = this.doPush(this.deps.client).finally(() => { this.pushing = null; this.emitStatus(); });
    this.emitStatus();
    return this.pushing;
  }

  private async doPush(client: CloudClient): Promise<{ pushed: number }> {
    const db = this.deps.db;
    let pushed = 0;
    for (;;) {
      const rows = db.prepare('select * from changes where pushed_at is null order by seq limit ?').all(MAX_PUSH_BATCH) as ChangeRow[];
      if (rows.length === 0) break;
      const batch: ChangeIn[] = rows.map((r) => ({ tableName: r.table_name, rowId: r.row_id, op: r.op, payload: JSON.parse(r.payload) as Record<string, unknown>, updatedAt: r.updated_at }));
      try {
        await client.pushChanges(batch);
      } catch (e) {
        this.fail(e);
        return { pushed };
      }
      const now = this.now();
      db.prepare(`update changes set pushed_at = ? where seq in (${rows.map(() => '?').join(',')})`).run(now, ...rows.map((r) => r.seq));
      this.state.set('lastPushAt', now);
      this.clearError();
      pushed += rows.length;
    }
    db.prepare('delete from changes where pushed_at is not null and pushed_at < ?').run(this.now() - LOCAL_CHANGES_KEEP_MS);
    return { pushed };
  }

  setPaused(paused: boolean): void {
    this.state.set('paused', paused);
    if (!paused && this.started && this.deps.client) { this.noteLocalChange(); void this.pullNow(); }
    this.emitStatus();
  }

  // pull 系は Task 10 で実装する。
  pullNow(): Promise<{ applied: number }> { return Promise.resolve({ applied: 0 }); }
  async syncNow(): Promise<void> { await this.pushNow(); await this.pullNow(); }
}
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/sync`
Expected: PASS（engine 7 件に、最小間隔 1 件と無料枠 2 件を足した数）

足すテストは次の 3 件である。

```ts
  it('前回の push から 10 秒経つまでは、デバウンスの期限が来ても送らない', async () => {
    // noteLocalChange → advance(1000) で 1 回目の push。
    // すぐ次の変更を入れて advance(1000) しても送らず、advance(9000) で送る。
  });
  it('利用者の syncNow は最小間隔を無視する', async () => {
    // 1 回目の push の直後に syncNow() を呼ぶと、待たずに送る。
  });
  it('無料枠の 80% に達したら自分で一時停止してトーストを出す', async () => {
    // QuotaCounter の上限を小さくして、push を繰り返す。
    // status().state が 'paused' になり、listener の toast が 1 度だけ呼ばれる。
    // 日付をまたぐと数えは 0 に戻るが、paused は解けない。
  });
```

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/sync/engine.ts packages/server/src/sync/engine.test.ts packages/server/src/sync/quota.ts packages/server/src/sync/quota.test.ts packages/server/test/fake-timers.ts
git commit -m "feat(server): sync engine push loop with debounce, min gap, free-tier guard and offline queue"
```

---

### Task 10: SyncEngine の pull と LWW の適用

**Files:**
- Create: `packages/server/src/sync/apply.ts`
- Modify: `packages/server/src/sync/engine.ts`
- Test: `packages/server/src/sync/apply.test.ts`、`packages/server/src/sync/engine.test.ts`（追加）

**Interfaces:**
- Produces: 「インターフェース一覧」の `apply.ts` の全部と、`SyncEngine` の `pullNow`、`syncNow`、`pullBeforeLaunch`、`onFocus`。
- **メモの競合**：`project_memos` の行を他端末の変更で上書きするとき、手元の `markdown` が相手と違えば、上書きの前に手元の本文を `<そのプロジェクトのメモの隣>/memo.conflict-<端末名>-<yyyyMMdd-HHmmss>.md` として書き出し、`onToast` で知らせる。行の採り方（`updated_at` の新しい方）は変えない。メモは利用者が手で書いた文章なので、黙って消えると取り返せない。`applyRemoteChange` は DB しか触らないので、書き出しは `applyRemoteBatch` の呼び手（`SyncEngine`）に `onMemoConflict?: (o: { projectId: string; markdown: string; deviceName: string }) => void` を渡して行う。テストでは呼ばれたことだけを確かめる。
- **圧縮で落ちた変更の検出**：`GET /changes?since=` が `410` と `{ error: 'gone', floor }` を返したら、`lastSeq` と `snapshotDone` を消して `GET /rows` からの全件の再同期をやり直す。Worker が古い `changes` を削った後に、その区間を読み逃した端末が「新しい分だけ」を受け取って永久に欠落したままになるのを防ぐ。再同期は 1 回の pull の中で続けて行い、`onToast` で「同期を作り直しました」と知らせる。
- 適用の規則：共有テーブル以外は飛ばす。`skipOwn` なら自端末の変更を飛ばす。ローカル行の `updated_at` が変更の `updatedAt` 以上なら飛ばす。payload はローカルの列だけに絞り、主キーと `updated_at` は変更の値で上書きし、`delete` で `deleted_at` が無ければ `updatedAt` を入れる。真偽値は 0 と 1 に、オブジェクトは JSON 文字列に、undefined は null に変える。`changes` には追記しない。
- `upsert` では `deleted_at` を必ず書く（payload に無ければ null）。`upsertShared` は conflict のときに渡された列しか書かないので、削除済みの行が届いた `upsert` で生き返らない状態が起こりうる。適用の経路ではこれを避ける。
- `project_roots` は `unique (project_id, device_id)` を `deleted_at` で除いていないので、同じ組を別の `id` で持つ行が他端末から届くと挿入が失敗する。適用の前に同じ組の別の行を探し、`updated_at` が新しい方を残して古い行を物理削除する（両端末が同じ規則で解くので結果は揃う）。どちらもフェーズ 1 では起こらないが、他端末の行が届くと起こる。
- `applyRemoteBatch` は 1 トランザクションで、`SHARED_APPLY_ORDER`（親から子）と `seq` で並べ替えて適用する。失敗した行は最後に 1 度だけ再試行し、それでも失敗したら飛ばして `console.error` に出す。
- pull の規則：`snapshotDone` が無ければ `GET /rows` を全部読んで適用し（`skipOwn: false`）、`lastSeq` を応答の `seq` にして `snapshotDone` を立てる。以後は `lastSeq` から `GET /changes` を `more` が false になるまで読み（`skipOwn: true`）、`lastSeq` と `lastPullAt` を更新する。適用した変更ごとに `applied` を、1 回の pull の終わりに `pulled` を通知する。
- `pullBeforeLaunch(2000)` は pull を始めて 2 秒待ち、間に合わなければ false を返す（pull 自体は続く）。`onFocus` は前回の pull から 5 秒以内なら何もしない。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/sync/apply.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ChangeOut } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { applyRemoteBatch, applyRemoteChange } from './apply.ts';

const ch = (over: Partial<ChangeOut> & { rowId: string; updatedAt: number }): ChangeOut => ({ seq: 1, tableName: 'projects', op: 'upsert', deviceId: 'b', payload: { id: over.rowId, name: 'remote', status: 'active', is_scratch: 0, updated_at: over.updatedAt, deleted_at: null, origin_device: 'b' }, ...over });
const o = { ownDeviceId: 'a', skipOwn: true };

describe('applyRemoteChange', () => {
  it('新しい行を書き、changes には追記しない', () => {
    const db = openDb(':memory:');
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 100 }), o)).toBe('applied');
    expect(db.prepare('select name, origin_device, updated_at from projects where id = ?').get('p1')).toEqual({ name: 'remote', origin_device: 'b', updated_at: 100 });
    expect((db.prepare('select count(*) c from changes').get() as { c: number }).c).toBe(0);
  });
  it('updated_at が同じか古い変更は飛ばす（LWW）', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'local', status: 'active' }, 'a');
    const local = (db.prepare('select updated_at from projects where id = ?').get('p1') as { updated_at: number }).updated_at;
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: local - 1 }), o)).toBe('skipped');
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: local }), o)).toBe('skipped');
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: local + 1 }), o)).toBe('applied');
    expect((db.prepare('select name from projects where id = ?').get('p1') as { name: string }).name).toBe('remote');
  });
  it('自端末の変更は skipOwn のときだけ飛ばし、知らない表と列は無視する', () => {
    const db = openDb(':memory:');
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1, deviceId: 'a' }), o)).toBe('skipped');
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1, deviceId: 'a' }), { ...o, skipOwn: false })).toBe('applied');
    expect(applyRemoteChange(db, ch({ rowId: 'x', updatedAt: 1, tableName: 'nope' as never }), o)).toBe('skipped');
    const c = ch({ rowId: 'p2', updatedAt: 1 });
    c.payload = { ...c.payload, future_column: 'x', is_scratch: true, extra: { a: 1 } };
    expect(applyRemoteChange(db, c, o)).toBe('applied');
    expect((db.prepare('select is_scratch from projects where id = ?').get('p2') as { is_scratch: number }).is_scratch).toBe(1);
  });
  it('upsert は deleted_at を明示的に戻すので、削除された行が生き返る', () => {
    const db = openDb(':memory:');
    applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1 }), o);
    const del = ch({ rowId: 'p1', updatedAt: 2, op: 'delete' });
    applyRemoteChange(db, del, o);
    expect((db.prepare('select deleted_at from projects where id = ?').get('p1') as { deleted_at: number }).deleted_at).toBe(2);
    const revive = ch({ rowId: 'p1', updatedAt: 3 });
    revive.payload = { id: 'p1', name: 'back', status: 'active', is_scratch: 0, updated_at: 3, origin_device: 'b' };
    expect(applyRemoteChange(db, revive, o)).toBe('applied');
    expect(db.prepare('select name, deleted_at from projects where id = ?').get('p1')).toEqual({ name: 'back', deleted_at: null });
  });
  it('project_roots の同じ組が別の id で来たら新しい方だけを残す', () => {
    const db = openDb(':memory:');
    applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1 }), o);
    upsertShared(db, 'project_roots', { id: 'pr-local', project_id: 'p1', device_id: 'dev-b', path: '/local', resolved: 1 }, 'a');
    const local = (db.prepare('select updated_at from project_roots where id = ?').get('pr-local') as { updated_at: number }).updated_at;
    const root = (id: string, updatedAt: number): ChangeOut => ({ seq: 3, tableName: 'project_roots', rowId: id, op: 'upsert', deviceId: 'b', updatedAt, payload: { id, project_id: 'p1', device_id: 'dev-b', path: '/remote', resolved: 1, updated_at: updatedAt, deleted_at: null, origin_device: 'b' } });
    expect(applyRemoteChange(db, root('pr-remote', local - 1), o)).toBe('skipped');
    expect(applyRemoteChange(db, root('pr-remote', local + 1), o)).toBe('applied');
    expect(db.prepare('select id, path from project_roots').all()).toEqual([{ id: 'pr-remote', path: '/remote' }]);
  });
  it('delete は deleted_at を埋め、主キーが id 以外の表も書ける', () => {
    const db = openDb(':memory:');
    applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1 }), o);
    const del = ch({ rowId: 'p1', updatedAt: 2, op: 'delete' });
    del.payload = { ...del.payload, deleted_at: null };
    applyRemoteChange(db, del, o);
    expect((db.prepare('select deleted_at from projects where id = ?').get('p1') as { deleted_at: number }).deleted_at).toBe(2);
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'b' }, 'a');
    const sum: ChangeOut = { seq: 2, tableName: 'session_summaries', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt: 5, payload: { session_id: 's1', title: 't', one_liner: 'o', body: 'b', state: 'done', next_steps: '[]', source: 'baseline', source_model: null, based_on_turns: 1, updated_at: 5, deleted_at: null, origin_device: 'b' } };
    expect(applyRemoteChange(db, sum, o)).toBe('applied');
    expect((db.prepare('select title from session_summaries where session_id = ?').get('s1') as { title: string }).title).toBe('t');
  });
});

describe('applyRemoteBatch', () => {
  it('子が先に来ても親から順に適用し、適用した変更を返す', () => {
    const db = openDb(':memory:');
    const run: ChangeOut = { seq: 1, tableName: 'runs', rowId: 'r1', op: 'upsert', deviceId: 'b', updatedAt: 3, payload: { id: 'r1', session_id: 's1', device_id: 'b', kind: 'start', tmux_name: 'hangar-r1', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1, updated_at: 3, deleted_at: null, origin_device: 'b' } };
    const ses: ChangeOut = { seq: 2, tableName: 'sessions', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt: 2, payload: { id: 's1', provider: 'claude-code', provider_session_id: 'u1', project_id: null, name: null, cwd: '/x', first_prompt: null, ai_title: null, started_at: null, last_activity_at: null, home_device: 'b', memo: null, updated_at: 2, deleted_at: null, origin_device: 'b' } };
    const applied = applyRemoteBatch(db, [run, ses, ch({ rowId: 'p1', updatedAt: 1, deviceId: 'a' })], o);
    expect(applied.map((c) => c.tableName)).toEqual(['sessions', 'runs']);
    expect((db.prepare('select count(*) c from runs').get() as { c: number }).c).toBe(1);
  });
});
```

`packages/server/src/sync/engine.test.ts` に足す（`applyRemoteBatch` は import しない。`FakeCloudClient` の `asDevice` で 2 端末を作る）。

```ts
describe('SyncEngine の pull', () => {
  let dbB: Db;
  let cloudB: FakeCloudClient;
  const makeB = (over: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) => new SyncEngine({ db: dbB, deviceId: 'b', client: cloudB, now: () => timers.now, timers, url: 'https://h', ...over });
  beforeEach(() => { dbB = openDb(':memory:'); cloudB = cloud.asDevice('b'); });

  it('初回は rows の写しを受け、以後は差分を受け、changes には積まない', async () => {
    const a = make();
    await a.start();
    project('p1');
    await a.pushNow();
    const b = makeB();
    const applied: string[] = [];
    let pulled = 0;
    b.on({ applied: (c) => applied.push(`${c.tableName}:${c.rowId}`), pulled: () => pulled++ });
    await b.start();
    expect((dbB.prepare('select name from projects where id = ?').get('p1') as { name: string }).name).toBe('p1');
    expect((dbB.prepare('select count(*) c from changes').get() as { c: number }).c).toBe(0);
    expect(applied).toEqual(['projects:p1']);
    expect(pulled).toBe(1);
    expect(b.state.get('snapshotDone')).toBe('1');
    expect(b.state.getNumber('lastSeq', -1)).toBe(1);
    expect(cloudB.calls.filter((c) => c.method === 'snapshot')).toHaveLength(1);
    project('p2');
    await a.pushNow();
    await b.pullNow();
    expect(applied).toEqual(['projects:p1', 'projects:p2']);
    expect(b.state.getNumber('lastSeq', -1)).toBe(2);
    expect(cloudB.calls.filter((c) => c.method === 'pullChanges').at(-1)?.args[0]).toBe(1);
    expect(b.status()).toMatchObject({ state: 'idle', lastPullAt: timers.now });
    a.stop(); b.stop();
  });
  it('30 秒ごとに push と pull を回す', async () => {
    const a = make();
    const b = makeB();
    await a.start(); await b.start();
    project('p1');
    await timers.advance(30_000);
    expect(dbB.prepare('select 1 from projects where id = ?').get('p1')).toBeTruthy();
    a.stop(); b.stop();
  });
  it('両端末が同じ行を変えたら updated_at の新しい方に揃う', async () => {
    const a = make(); const b = makeB();
    await a.start(); await b.start();
    project('p1', 'from-a');
    await a.pushNow(); await b.pullNow();
    timers.now += 10;
    upsertShared(dbB, 'projects', { ...(dbB.prepare('select * from projects where id = ?').get('p1') as Record<string, unknown>), name: 'from-b' }, 'b');
    timers.now += 10;
    upsertShared(db, 'projects', { ...(db.prepare('select * from projects where id = ?').get('p1') as Record<string, unknown>), name: 'from-a-2' }, 'a');
    await b.pushNow(); await a.pushNow();
    await a.pullNow(); await b.pullNow();
    const nameA = (db.prepare('select name from projects where id = ?').get('p1') as { name: string }).name;
    const nameB = (dbB.prepare('select name from projects where id = ?').get('p1') as { name: string }).name;
    expect(nameA).toBe(nameB);
    a.stop(); b.stop();
  });
  it('pullBeforeLaunch は 2 秒で諦め、pull 自体は続く', async () => {
    let release: () => void = () => {};
    const slow = cloud.asDevice('b');
    const orig = slow.pullChanges.bind(slow);
    slow.pullChanges = (since, limit) => new Promise((r) => { release = () => { void orig(since, limit).then(r); }; });
    slow.snapshot = async (after, limit) => ({ changes: [], nextAfter: null, seq: 0 });
    const b = makeB({ client: slow });
    b.state.set('snapshotDone', true);
    const p = b.pullBeforeLaunch(2000);
    await timers.advance(2000);
    expect(await p).toBe(false);
    release();
    await flush();
    expect(b.status().state).toBe('idle');
    const fast = makeB();
    fast.state.set('snapshotDone', true);
    expect(await fast.pullBeforeLaunch(2000)).toBe(true);
    cloudB.offline = true;
    expect(await fast.pullBeforeLaunch(2000)).toBe(false);
  });
  it('onFocus は 5 秒以内の連続では pull しない', async () => {
    const b = makeB();
    await b.start();
    const n = () => cloudB.calls.filter((c) => c.method === 'pullChanges').length;
    const before = n();
    await b.onFocus();
    expect(n()).toBe(before);
    timers.now += 6000;
    await b.onFocus();
    expect(n()).toBe(before + 1);
    b.stop();
  });
  it('pull の失敗は error になり、次の成功で消える', async () => {
    const b = makeB();
    await b.start();
    cloudB.offline = true;
    await b.pullNow();
    expect(b.status()).toMatchObject({ state: 'error' });
    cloudB.offline = false;
    await b.pullNow();
    expect(b.status()).toMatchObject({ state: 'idle', error: null });
    b.stop();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/sync`
Expected: FAIL（`./apply.ts` が無い、pull が空）

- [ ] **Step 3: apply.ts を書く**

`packages/server/src/sync/apply.ts`：

```ts
import { SHARED_TABLES, TABLE_PK, type ChangeOut, type SharedTable } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

/** 親から子の順。pull の適用はこの順に並べ替える。 */
export const SHARED_APPLY_ORDER: readonly SharedTable[] = SHARED_TABLES;
const ORDER = new Map<string, number>(SHARED_APPLY_ORDER.map((t, i) => [t, i]));

const colCache = new WeakMap<Db, Map<string, Set<string>>>();
function tableColumns(db: Db, table: SharedTable): Set<string> {
  let m = colCache.get(db);
  if (!m) { m = new Map(); colCache.set(db, m); }
  let s = m.get(table);
  if (!s) { s = new Set((db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name)); m.set(table, s); }
  return s;
}

/** SQLite に渡せる値に揃える。真偽は 0 と 1、オブジェクトは JSON、undefined は null。 */
const bindable = (v: unknown): unknown => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

/**
 * pull で受けた 1 行を適用する。updated_at の新しい方を採り、changes には追記しない。
 * payload はローカルの列だけに絞るので、相手の版が新しくて列が多くても壊れない。
 */
export function applyRemoteChange(db: Db, c: ChangeOut, o: { ownDeviceId: string; skipOwn: boolean }): 'applied' | 'skipped' {
  if (!ORDER.has(c.tableName)) return 'skipped';
  if (o.skipOwn && c.deviceId === o.ownDeviceId) return 'skipped';
  const pk = TABLE_PK[c.tableName];
  const cols = tableColumns(db, c.tableName);
  const cur = db.prepare(`select updated_at from ${c.tableName} where ${pk} = ?`).get(c.rowId) as { updated_at: number } | undefined;
  if (cur && cur.updated_at >= c.updatedAt) return 'skipped';
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c.payload)) if (cols.has(k)) row[k] = v;
  row[pk] = c.rowId;
  row.updated_at = c.updatedAt;
  // upsertShared は conflict で渡された列しか書かないので、適用の側で deleted_at を必ず書いて生き返らせる。
  if (c.op === 'upsert' && row.deleted_at === undefined) row.deleted_at = null;
  if (c.op === 'delete' && (row.deleted_at === undefined || row.deleted_at === null)) row.deleted_at = c.updatedAt;
  if (typeof row.origin_device !== 'string') row.origin_device = c.deviceId;
  // project_roots は (project_id, device_id) が一意で deleted_at を除いていない。
  // 別の id で同じ組が届いたら、updated_at の新しい方を残して古い行を物理削除する。
  if (c.tableName === 'project_roots' && typeof row.project_id === 'string' && typeof row.device_id === 'string') {
    const dup = db.prepare('select id, updated_at from project_roots where project_id = ? and device_id = ? and id <> ?').get(row.project_id, row.device_id, c.rowId) as { id: string; updated_at: number } | undefined;
    if (dup) {
      if (dup.updated_at >= c.updatedAt) return 'skipped';
      db.prepare('delete from project_roots where id = ?').run(dup.id);
    }
  }
  const keys = Object.keys(row);
  const sets = keys.filter((k) => k !== pk).map((k) => `${k} = excluded.${k}`).join(', ');
  db.prepare(`insert into ${c.tableName} (${keys.join(', ')}) values (${keys.map(() => '?').join(', ')}) on conflict(${pk}) do update set ${sets}`).run(...keys.map((k) => bindable(row[k])));
  return 'applied';
}

/** 1 トランザクションで親から子の順に適用する。失敗した行は最後に 1 度だけ再試行する。 */
export function applyRemoteBatch(db: Db, changes: ChangeOut[], o: { ownDeviceId: string; skipOwn: boolean }): ChangeOut[] {
  const sorted = [...changes].sort((a, b) => (ORDER.get(a.tableName) ?? 99) - (ORDER.get(b.tableName) ?? 99) || a.seq - b.seq);
  const applied: ChangeOut[] = [];
  const run = db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    const failed: ChangeOut[] = [];
    for (const c of sorted) {
      try { if (applyRemoteChange(db, c, o) === 'applied') applied.push(c); } catch { failed.push(c); }
    }
    for (const c of failed) {
      try { if (applyRemoteChange(db, c, o) === 'applied') applied.push(c); } catch (e) { console.error('[sync] apply failed', c.tableName, c.rowId, e instanceof Error ? e.message : e); }
    }
  });
  run();
  return applied;
}
```

- [ ] **Step 4: engine.ts の pull を書く**

`packages/server/src/sync/engine.ts` の Task 9 で置いた `pullNow` と `syncNow` を次に置き換え、`import { PULL_LIMIT } from '@agent-hangar/shared'`（既存の import に足す）と `import { applyRemoteBatch } from './apply.ts';` を足す。

```ts
  pullNow(): Promise<{ applied: number }> {
    if (!this.deps.client || this.paused) return Promise.resolve({ applied: 0 });
    if (this.pulling) return this.pulling;
    this.pulling = this.doPull(this.deps.client).finally(() => { this.pulling = null; this.emitStatus(); });
    this.emitStatus();
    return this.pulling;
  }

  private applyPage(changes: ChangeOut[], skipOwn: boolean): number {
    const applied = applyRemoteBatch(this.deps.db, changes, { ownDeviceId: this.deps.deviceId, skipOwn });
    for (const c of applied) this.emit('applied', c);
    return applied.length;
  }

  private async doPull(client: CloudClient): Promise<{ applied: number }> {
    let applied = 0;
    try {
      if (this.state.get('snapshotDone') !== '1') {
        let after: string | null = null;
        let seq = 0;
        do {
          const page = await client.snapshot(after, PULL_LIMIT);
          applied += this.applyPage(page.changes, false);
          after = page.nextAfter;
          seq = page.seq;
        } while (after !== null);
        this.state.set('lastSeq', Math.max(seq, this.state.getNumber('lastSeq', 0)));
        this.state.set('snapshotDone', true);
      }
      let since = this.state.getNumber('lastSeq', 0);
      for (;;) {
        const page = await client.pullChanges(since, PULL_LIMIT);
        applied += this.applyPage(page.changes, true);
        since = page.nextSeq;
        this.state.set('lastSeq', since);
        if (!page.more) break;
      }
      this.state.set('lastPullAt', this.now());
      this.clearError();
      this.emit('pulled');
    } catch (e) {
      this.fail(e);
    }
    return { applied };
  }

  async syncNow(): Promise<void> {
    await this.pushNow();
    await this.pullNow();
  }

  /** セッション起動の直前に呼ぶ。2 秒で諦めるが pull は続く。 */
  async pullBeforeLaunch(timeoutMs = 2000): Promise<boolean> {
    if (!this.deps.client || this.paused) return false;
    let timer: NodeJS.Timeout | null = null;
    const gaveUp = new Promise<boolean>((r) => { timer = this.timers.setTimeout(() => r(false), timeoutMs); });
    const done = this.pullNow().then(() => this.lastError === null, () => false);
    const result = await Promise.race([done, gaveUp]);
    if (timer) this.timers.clearTimeout(timer);
    return result;
  }

  /** ウィンドウの前面化。前回の pull から 5 秒以内なら何もしない。 */
  async onFocus(): Promise<void> {
    const last = this.state.getNumber('lastPullAt', 0);
    if (this.now() - last < (this.deps.focusMinGapMs ?? 5000)) return;
    await this.pullNow();
  }
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/sync`
Expected: PASS（apply 7 件、engine 13 件を含む）

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/sync
git commit -m "feat(server): pull with snapshot bootstrap, LWW apply without re-logging, pre-launch and focus pulls"
```

---

### Task 11: hangar setup cloud（wrangler で資源を作りデプロイして参加トークンを出す）

**Files:**
- Create: `packages/cli/src/wrangler.ts`、`packages/cli/src/cloud.ts`
- Modify: `packages/cli/src/index.ts`、`packages/cli/package.json`
- Test: `packages/cli/src/wrangler.test.ts`、`packages/cli/src/cloud.test.ts`

**Interfaces:**
- Consumes: `encodeJoinToken`、`decodeJoinToken`（shared）、`loadCloudConfig`、`saveCloudConfig`、`readOrCreateDevice`、`hangarHome`（server）。`sha256Hex` は `node:crypto` で CLI 側に書く（server の `sync/crypto.ts` は `@agent-hangar/server` の公開 API に無い）。
- Produces: 「インターフェース一覧」の `wrangler.ts` と `cloud.ts` の `runSetupCloud`、`waitForHealth`。
- `WranglerRunner` は wrangler の実行ファイルを `createRequire(<cloudDir>/package.json).resolve('wrangler/bin/wrangler.js')` で探し、`process.execPath` で起動する（npm workspaces が root に巻き上げても見つかる）。`CLOUDFLARE_ACCOUNT_ID` を環境変数で渡す。`run` は出力を集めて返し、`runInteractive` は標準入出力をそのまま繋ぐ（`wrangler login` 用）。
- `runSetupCloud` の手順：
  1. `wrangler whoami` でアカウント ID を読む。読めなければ `wrangler login` を対話で実行してもう一度読む。
  2. D1 は `wrangler d1 info <db> --json` が通れば既存として ID を拾い、通らなければ `wrangler d1 create <db>` の出力から UUID を拾う。R2 は `wrangler r2 bucket create <bucket>` を実行し、出力に `already exists` があれば既存として進む。
  3. `~/.agent-hangar/cloud/wrangler.jsonc` を書く（`name`、`main` は `packages/cloud/src/index.ts` の絶対パス、`compatibility_date`、`nodejs_compat`、D1 と R2 の binding、`vars: {}`）。
  4. `wrangler deploy --config <cfg>` の出力から `https://<name>.<subdomain>.workers.dev` を拾う。
  5. 参加用の秘密は `cloud.json` に既にあり `--rotate-secret` でなければそれを使い、無ければ 32 バイトの乱数を base64url にする。SHA-256 を `wrangler secret put JOIN_SECRET_HASH --config <cfg>` の標準入力で渡す。
  6. `/health` を 5 秒おきに最大 120 秒試す。
  7. `POST /join` で自端末を登録する。503 なら 5 秒おきに最大 6 回試す（secret の反映待ち）。
  8. `cloud.json` を書き、参加トークンを表示して返す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/cli/src/wrangler.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseAccountId, parseDatabaseId, parseWorkerUrl } from './wrangler.ts';

describe('wrangler の出力の解釈', () => {
  it('whoami からアカウント ID', () => {
    const out = `Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email x@example.com.\n┌──────────────────┬──────────────────────────────────┐\n│ Account Name     │ Account ID                       │\n├──────────────────┼──────────────────────────────────┤\n│ X's Account      │ 0123456789abcdef0123456789abcdef │\n└──────────────────┴──────────────────────────────────┘`;
    expect(parseAccountId(out)).toBe('0123456789abcdef0123456789abcdef');
    expect(parseAccountId('You are not authenticated')).toBeNull();
  });
  it('d1 create と d1 info からデータベース ID', () => {
    expect(parseDatabaseId('✅ Successfully created DB \'hangar\'\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "hangar"\ndatabase_id = "a1b2c3d4-0000-4000-8000-000000000001"')).toBe('a1b2c3d4-0000-4000-8000-000000000001');
    expect(parseDatabaseId(JSON.stringify({ uuid: 'a1b2c3d4-0000-4000-8000-000000000002', name: 'hangar' }))).toBe('a1b2c3d4-0000-4000-8000-000000000002');
    expect(parseDatabaseId('nothing')).toBeNull();
  });
  it('deploy のログから URL', () => {
    expect(parseWorkerUrl('Uploaded hangar (2.1 sec)\nDeployed hangar triggers (1.0 sec)\n  https://hangar.gaku.workers.dev\nCurrent Version ID: x')).toBe('https://hangar.gaku.workers.dev');
    expect(parseWorkerUrl('no url')).toBeNull();
  });
});
```

`packages/cli/src/cloud.test.ts`：

```ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJoinToken } from '@agent-hangar/shared';
import { loadCloudConfig } from '@agent-hangar/server';
import { runSetupCloud, waitForHealth } from './cloud.ts';
import { WranglerRunner, type Exec, type ExecResult } from './wrangler.ts';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const device = { id: 'dev-a', name: 'mac', platform: 'darwin' };
const DB_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

function fakeWrangler(script: Record<string, (args: string[], input?: string) => ExecResult>) {
  const calls: { args: string[]; input?: string; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (_cmd, args, o) => {
    const w = args.indexOf('wrangler.js');
    const rest = w >= 0 ? args.slice(w + 1) : args;
    calls.push({ args: rest, input: o.input, env: o.env });
    const key = Object.keys(script).find((k) => rest.join(' ').startsWith(k));
    return key ? script[key]!(rest, o.input) : { code: 1, stdout: '', stderr: `unexpected: ${rest.join(' ')}` };
  };
  return { calls, runner: (accountId: string | null, cloudDir: string) => new WranglerRunner({ cloudDir, accountId, exec }) };
}

function fakeFetch(): { fetch: typeof fetch; urls: string[]; healthFails: number } {
  const state = { healthFails: 2, urls: [] as string[] };
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    state.urls.push(url);
    if (url.endsWith('/health')) {
      if (state.healthFails-- > 0) return new Response('error code: 1042', { status: 530 });
      return new Response(JSON.stringify({ ok: true, version: '0.4.0' }), { status: 200 });
    }
    if (url.endsWith('/join')) {
      const body = JSON.parse(init!.body as string) as { secret: string; device: typeof device };
      expect(body.device).toEqual(device);
      return new Response(JSON.stringify({ deviceToken: 'tok-' + body.secret.slice(0, 4), deviceId: body.device.id }), { status: 201 });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetch: f, urls: state.urls, get healthFails() { return state.healthFails; } };
}

describe('runSetupCloud', () => {
  it('資源を作り、設定を書き、デプロイし、health を待ち、参加して cloud.json とトークンを出す', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-setup-'));
    const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-clouddir-'));
    const w = fakeWrangler({
      'whoami': () => ok('│ Acc │ 0123456789abcdef0123456789abcdef │'),
      'd1 info hangar --json': () => ({ code: 1, stdout: '', stderr: 'not found' }),
      'd1 create hangar': () => ok(`database_id = "${DB_ID}"`),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      'deploy': () => ok('Deployed hangar\n  https://hangar.gaku.workers.dev'),
      'secret put JOIN_SECRET_HASH': (_a, input) => { expect(input).toMatch(/^[0-9a-f]{64}\n$/); return ok('Success'); },
    });
    const ff = fakeFetch();
    const slept: number[] = [];
    const r = await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async (ms) => { slept.push(ms); }, cloudDir, log: () => {} });
    expect(r.url).toBe('https://hangar.gaku.workers.dev');
    const tok = decodeJoinToken(r.joinToken);
    expect(tok.url).toBe(r.url);
    expect(tok.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    expect(cfg.name).toBe('hangar');
    expect(cfg.d1_databases[0]).toEqual({ binding: 'DB', database_name: 'hangar', database_id: DB_ID });
    expect(cfg.r2_buckets[0]).toEqual({ binding: 'BUCKET', bucket_name: 'hangar-files' });
    expect(path.isAbsolute(cfg.main)).toBe(true);
    expect(cfg.main.endsWith(path.join('cloud', 'src', 'index.ts'))).toBe(true);
    const saved = loadCloudConfig(home)!;
    expect(saved).toMatchObject({ url: r.url, joinSecret: tok.secret, deviceToken: 'tok-' + tok.secret.slice(0, 4), workerName: 'hangar', accountId: '0123456789abcdef0123456789abcdef', dbName: 'hangar', bucketName: 'hangar-files' });
    expect(fs.statSync(path.join(home, 'cloud.json')).mode & 0o777).toBe(0o600);
    const cmds = w.calls.map((c) => c.args.slice(0, 3).join(' '));
    expect(cmds).toEqual(['whoami', 'd1 info hangar', 'd1 create hangar', 'r2 bucket create', 'deploy --config ' + path.join(home, 'cloud', 'wrangler.jsonc'), 'secret put JOIN_SECRET_HASH']);
    expect(w.calls.slice(1).every((c) => c.env.CLOUDFLARE_ACCOUNT_ID === '0123456789abcdef0123456789abcdef')).toBe(true);
    expect(ff.urls.filter((u) => u.endsWith('/health'))).toHaveLength(3);
    expect(slept.filter((ms) => ms === 5000).length).toBeGreaterThanOrEqual(2);
    const hash = createHash('sha256').update(tok.secret).digest('hex');
    expect(w.calls.at(-1)!.input).toBe(hash + '\n');
  });
  it('既存の資源と秘密を再利用し、--name で名前を変える', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-setup-'));
    const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-clouddir-'));
    fs.writeFileSync(path.join(home, 'cloud.json'), JSON.stringify({ url: 'https://old', joinSecret: 'keep-this-secret-value-000000000000000000', deviceToken: 'old', workerName: 'hangar-dev', accountId: null, dbName: null, bucketName: null, joinedAt: 1 }));
    const w = fakeWrangler({
      'whoami': () => ok('│ Acc │ 0123456789abcdef0123456789abcdef │'),
      'd1 info hangar-dev --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-dev-files': () => ({ code: 1, stdout: '', stderr: 'A bucket with this name already exists' }),
      'deploy': () => ok('https://hangar-dev.gaku.workers.dev'),
      'secret put JOIN_SECRET_HASH': () => ok(),
    });
    const ff = fakeFetch();
    const r = await runSetupCloud({ home, name: 'hangar-dev', device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} });
    expect(decodeJoinToken(r.joinToken).secret).toBe('keep-this-secret-value-000000000000000000');
    expect(w.calls.map((c) => c.args[0])).toEqual(['whoami', 'd1', 'r2', 'deploy', 'secret']);
    expect(loadCloudConfig(home)).toMatchObject({ workerName: 'hangar-dev', dbName: 'hangar-dev', bucketName: 'hangar-dev-files', url: 'https://hangar-dev.gaku.workers.dev' });
  });
  it('health が 2 分通らなければ失敗する', async () => {
    let t = 0;
    const never = (async () => new Response('error code: 1042', { status: 530 })) as typeof fetch;
    const okAfter = await waitForHealth('https://h', { fetch: never, sleep: async (ms) => { t += ms; }, timeoutMs: 120_000, intervalMs: 5000 });
    expect(okAfter).toBe(false);
    expect(t).toBeGreaterThanOrEqual(120_000);
    expect(t).toBeLessThan(130_000);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/cli`
Expected: FAIL（`./wrangler.ts` と `./cloud.ts` が無い）

- [ ] **Step 3: wrangler.ts を書く**

`packages/cli/src/wrangler.ts`：

```ts
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; input?: string }) => Promise<ExecResult>;

/** 出力を集める既定の実行。input があれば標準入力に書いて閉じる。 */
export const defaultExec: Exec = (cmd, args, o) => new Promise((resolve) => {
  const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  p.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr + e.message }));
  p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  if (o.input !== undefined) p.stdin.write(o.input);
  p.stdin.end();
});

/** packages/cloud に同梱した wrangler を、アカウント ID を環境変数で渡して実行する。 */
export class WranglerRunner {
  constructor(private readonly o: { cloudDir: string; accountId: string | null; exec?: Exec; log?: (line: string) => void }) {}

  /** wrangler の実行ファイル。workspaces が root に巻き上げても cloud の package.json から解決できる。 */
  bin(): string {
    try {
      return createRequire(path.join(this.o.cloudDir, 'package.json')).resolve('wrangler/bin/wrangler.js');
    } catch {
      return path.join(this.o.cloudDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    }
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, ...(this.o.accountId ? { CLOUDFLARE_ACCOUNT_ID: this.o.accountId } : {}), WRANGLER_SEND_METRICS: 'false' };
  }

  withAccount(accountId: string): WranglerRunner { return new WranglerRunner({ ...this.o, accountId }); }

  run(args: string[], input?: string): Promise<ExecResult> {
    this.o.log?.(`$ wrangler ${args.join(' ')}`);
    return (this.o.exec ?? defaultExec)(process.execPath, [this.bin(), ...args], { cwd: this.o.cloudDir, env: this.env(), input });
  }

  /** wrangler login のように標準入出力を利用者に渡す実行。 */
  runInteractive(args: string[]): Promise<number> {
    this.o.log?.(`$ wrangler ${args.join(' ')}`);
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [this.bin(), ...args], { cwd: this.o.cloudDir, env: this.env(), stdio: 'inherit' });
      p.on('close', (code) => resolve(code ?? 1));
      p.on('error', () => resolve(127));
    });
  }
}

export function parseAccountId(whoami: string): string | null {
  const m = /\b([0-9a-f]{32})\b/.exec(whoami);
  return m ? m[1]! : null;
}

export function parseDatabaseId(text: string): string | null {
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(text);
  return m ? m[0] : null;
}

export function parseWorkerUrl(deployLog: string): string | null {
  const m = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deployLog);
  return m ? m[0] : null;
}
```

- [ ] **Step 4: cloud.ts の setup を書く**

`packages/cli/src/cloud.ts`：

```ts
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeJoinToken, type JoinResponse } from '@agent-hangar/shared';
import { loadCloudConfig, saveCloudConfig, type CloudConfig } from '@agent-hangar/server';
import { parseAccountId, parseDatabaseId, parseWorkerUrl, WranglerRunner } from './wrangler.ts';

export type DeviceLike = { id: string; name: string; platform: string };
export type SetupCloudOptions = {
  home: string; device: DeviceLike; name?: string; rotateSecret?: boolean;
  wrangler?: WranglerRunner; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; cloudDir?: string; log?: (line: string) => void;
};

const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 5000;
const JOIN_RETRIES = 6;

/** リポジトリ内の packages/cloud。CLI の src からの相対で探す。 */
export function defaultCloudDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cloud');
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const realFetch: typeof fetch = (...a) => fetch(...a);

/** /health が通るまで待つ。デプロイ直後は workers.dev の反映待ちで error code 1042 が返る。 */
export async function waitForHealth(url: string, o: { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number }): Promise<boolean> {
  const timeout = o.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const interval = o.intervalMs ?? HEALTH_INTERVAL_MS;
  for (let waited = 0; ; waited += interval) {
    try {
      const r = await o.fetch(`${url}/health`);
      if (r.ok && ((await r.json()) as { ok?: boolean }).ok === true) return true;
    } catch {
      // 接続できないうちは待つ。
    }
    if (waited + interval > timeout) return false;
    await o.sleep(interval);
  }
}

export async function joinWorker(url: string, secret: string, device: DeviceLike, fetchFn: typeof fetch, sleep: (ms: number) => Promise<void>, retries = JOIN_RETRIES): Promise<JoinResponse> {
  for (let i = 0; ; i++) {
    const r = await fetchFn(`${url}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, device }) });
    if (r.status === 201) return (await r.json()) as JoinResponse;
    if (r.status === 503 && i < retries) { await sleep(HEALTH_INTERVAL_MS); continue; }
    if (r.status === 403) throw new Error('参加用の秘密が違います。参加トークンを確かめてください');
    throw new Error(`参加に失敗しました（HTTP ${r.status}）`);
  }
}

function writeWranglerConfig(home: string, o: { name: string; main: string; dbName: string; dbId: string; bucketName: string }): string {
  const dir = path.join(home, 'cloud');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'wrangler.jsonc');
  const cfg = {
    name: o.name, main: o.main, compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'],
    d1_databases: [{ binding: 'DB', database_name: o.dbName, database_id: o.dbId }],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: o.bucketName }],
    vars: {},
  };
  fs.writeFileSync(file, '// hangar setup cloud が生成した。アカウント ID は環境変数で渡すので、ここには書かない。\n' + JSON.stringify(cfg, null, 2) + '\n');
  return file;
}

/**
 * 利用者の Cloudflare アカウントに Worker と D1 と R2 を作ってデプロイし、自端末を参加させ、参加トークンを返す。
 * 二度目以降は既存の資源と秘密を再利用する。
 */
export async function runSetupCloud(o: SetupCloudOptions): Promise<{ url: string; joinToken: string }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const fetchFn = o.fetch ?? realFetch;
  const sleep = o.sleep ?? realSleep;
  const cloudDir = o.cloudDir ?? defaultCloudDir();
  const name = o.name ?? 'hangar';
  const dbName = name;
  const bucketName = `${name}-files`;
  let wr = o.wrangler ?? new WranglerRunner({ cloudDir, accountId: null, log });

  // 1. アカウント
  let who = await wr.run(['whoami']);
  let accountId = who.code === 0 ? parseAccountId(who.stdout + who.stderr) : null;
  if (!accountId) {
    log('Cloudflare にログインします。ブラウザが開きます。');
    const code = await wr.runInteractive(['login']);
    if (code !== 0) throw new Error('wrangler login に失敗しました');
    who = await wr.run(['whoami']);
    accountId = parseAccountId(who.stdout + who.stderr);
    if (!accountId) throw new Error('アカウント ID を読めませんでした。wrangler whoami の出力を確かめてください');
  }
  wr = wr.withAccount(accountId);

  // 2. D1 と R2
  const info = await wr.run(['d1', 'info', dbName, '--json']);
  let dbId = info.code === 0 ? parseDatabaseId(info.stdout) : null;
  if (!dbId) {
    const created = await wr.run(['d1', 'create', dbName]);
    dbId = parseDatabaseId(created.stdout + created.stderr);
    if (created.code !== 0 || !dbId) throw new Error(`D1 の作成に失敗しました: ${created.stderr || created.stdout}`);
    log(`D1 ${dbName} を作りました`);
  } else log(`D1 ${dbName} は既にあります`);
  const bucket = await wr.run(['r2', 'bucket', 'create', bucketName]);
  if (bucket.code !== 0 && !/already exists/i.test(bucket.stderr + bucket.stdout)) throw new Error(`R2 の作成に失敗しました: ${bucket.stderr || bucket.stdout}`);
  log(bucket.code === 0 ? `R2 ${bucketName} を作りました` : `R2 ${bucketName} は既にあります`);

  // 3. 設定と 4. デプロイ
  const cfg = writeWranglerConfig(o.home, { name, main: path.join(cloudDir, 'src', 'index.ts'), dbName, dbId, bucketName });
  const dep = await wr.run(['deploy', '--config', cfg]);
  const url = parseWorkerUrl(dep.stdout + dep.stderr);
  if (dep.code !== 0 || !url) throw new Error(`デプロイに失敗しました: ${dep.stderr || dep.stdout}`);
  log(`デプロイしました: ${url}`);

  // 5. 参加用の秘密
  const prev = loadCloudConfig(o.home);
  const secret = prev && !o.rotateSecret ? prev.joinSecret : randomBytes(32).toString('base64url');
  const put = await wr.run(['secret', 'put', 'JOIN_SECRET_HASH', '--config', cfg], sha256Hex(secret) + '\n');
  if (put.code !== 0) throw new Error(`secret の登録に失敗しました: ${put.stderr || put.stdout}`);

  // 6. health と 7. 参加
  log('Worker の反映を待っています（最大 2 分）');
  if (!(await waitForHealth(url, { fetch: fetchFn, sleep }))) throw new Error(`${url}/health が 2 分以内に通りませんでした。しばらく待ってから hangar setup cloud をもう一度実行してください`);
  const joined = await joinWorker(url, secret, o.device, fetchFn, sleep);

  // 8. 保存と表示
  const conf: CloudConfig = { url, joinSecret: secret, deviceToken: joined.deviceToken, workerName: name, accountId, dbName, bucketName, joinedAt: Date.now() };
  saveCloudConfig(o.home, conf);
  const joinToken = encodeJoinToken({ url, secret });
  log('');
  log('参加トークン（他の PC で hangar join <token> に渡す。秘密を含むので人に見せない）:');
  log(joinToken);
  log('');
  log('hangar を再起動すると同期が始まります。');
  return { url, joinToken };
}
```

`packages/cli/src/index.ts` に足す（`setup` コマンドの下にサブコマンド `cloud` を置く。commander では `program.command('setup')` に `.command('cloud')` を足すと `setup` 自身の action が動かなくなるため、`setup` を親コマンドにし、既定の動作を `setup` の `.action` に残す形にする）。

```ts
import { readOrCreateDevice } from '@agent-hangar/server';
import { runSetupCloud } from './cloud.ts';

// 既存の setup の option と action は 1 文字も変えない。
// 戻り値を const に受けて、その下に子コマンドをぶら下げるだけにする。
const setup = program
  .command('setup')
  .description('データディレクトリを用意し、ツールとワークスペースを確認し、statusline への追記を提案する')
  .option('--workspace <dir>', 'ワークスペースのルート')
  .option('--yes', '問いかけをすべて承諾する')
  .option('--skip-statusline', 'statusline への追記を提案しない')
  .action(async (o: { workspace?: string; yes?: boolean; skipStatusline?: boolean }) => {
    ...フェーズ 1 と 3 の中身をそのまま...
  });
setup.command('cloud').description('自分の Cloudflare アカウントに同期用の Worker と D1 と R2 を作ってデプロイする')
  .option('--name <name>', 'Worker の名前（D1 は同名、R2 は <name>-files）', 'hangar')
  .option('--rotate-secret', '参加用の秘密を作り直す')
  .action(async (o: { name: string; rotateSecret?: boolean }) => {
    const home = hangarHome();
    const device = readOrCreateDevice(home);
    await runSetupCloud({ home, device, name: o.name, rotateSecret: o.rotateSecret });
  });
```

既存の `program.command('setup')...action(...)` は、戻り値を `const setup` に受ける形に替えるだけで、option と action の中身は変えない。
`packages/cli/package.json` の `dependencies` に `"@agent-hangar/shared": "*"` を足す。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/cli && npx tsc -p packages/cli`
Expected: PASS（wrangler 3 件、cloud 3 件、setup 1 件）

- [ ] **Step 6: コミット**

```bash
git add package-lock.json packages/cli
git commit -m "feat(cli): hangar setup cloud creates D1 and R2, deploys the worker and prints a join token"
```

---

### Task 12: hangar join、hangar cloud status、hangar cloud teardown

**Files:**
- Modify: `packages/cli/src/cloud.ts`、`packages/cli/src/index.ts`
- Test: `packages/cli/src/cloud.test.ts`（追加）

**Interfaces:**
- Produces: `runJoin`、`cloudStatus`、`runTeardown`（「インターフェース一覧」）。
- `hangar join <token>`：トークンを解いて `POST /join` し、`cloud.json` を書く（`workerName`、`accountId`、`dbName`、`bucketName` は null）。既に `cloud.json` があれば上書きの前に「上書きしますか」を聞く（`--force` で省く）。
- `hangar cloud status`：`cloud.json` の有無、Worker の `/health`、ローカルサーバの `GET /api/sync/status`（`<home>/token` を Bearer で付ける。サーバが止まっていれば「サーバは停止中」）を並べて出す。
- `hangar cloud teardown`：`cloud.json` に `workerName` がある端末（setup を走らせた端末）だけが実行できる。確認は 2 段で、Worker 名の入力と `delete` の入力を求める。`GET /files` の全件を `wrangler r2 object delete <bucket>/<key>` で消し、`wrangler r2 bucket delete`、`wrangler delete --name <worker> --config <cfg>`（標準入力に `y`）、`wrangler d1 delete <db> -y` を順に実行し、`cloud.json` と `cloud/wrangler.jsonc` を消す。途中の失敗は表示して続け、最後に残った失敗を一覧で出す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/cli/src/cloud.test.ts` に足す。

```ts
import { encodeJoinToken } from '@agent-hangar/shared';
import { saveCloudConfig } from '@agent-hangar/server';
import { cloudStatus, runJoin, runTeardown } from './cloud.ts';

describe('runJoin', () => {
  it('トークンから参加して cloud.json を書く', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-join-'));
    const token = encodeJoinToken({ url: 'https://h.workers.dev', secret: 'sec' });
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://h.workers.dev/join');
      expect(JSON.parse(init!.body as string)).toEqual({ secret: 'sec', device });
      return new Response(JSON.stringify({ deviceToken: 'dt', deviceId: 'dev-a' }), { status: 201 });
    }) as typeof fetch;
    const c = await runJoin({ home, token, device, fetch: f, sleep: async () => {} });
    expect(c).toMatchObject({ url: 'https://h.workers.dev', joinSecret: 'sec', deviceToken: 'dt', workerName: null, accountId: null });
    expect(loadCloudConfig(home)).toEqual(c);
  });
  it('秘密が違えばわかる文言で失敗する', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-join-'));
    const f = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
    await expect(runJoin({ home, token: encodeJoinToken({ url: 'https://h', secret: 'x' }), device, fetch: f, sleep: async () => {} })).rejects.toThrow('参加用の秘密が違います');
    expect(loadCloudConfig(home)).toBeNull();
  });
});

describe('cloudStatus', () => {
  it('未設定、Worker の応答、サーバの状態を並べる', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-status-'));
    expect(await cloudStatus({ home, fetch: (async () => new Response('', { status: 500 })) as typeof fetch })).toContain('未設定');
    saveCloudConfig(home, { url: 'https://h', joinSecret: 's', deviceToken: 't', workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files', joinedAt: 1 });
    fs.writeFileSync(path.join(home, 'token'), 'local-token');
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u === 'https://h/health') return new Response(JSON.stringify({ ok: true, version: '0.4.0' }), { status: 200 });
      if (u.endsWith('/api/sync/status')) { expect((init!.headers as Record<string, string>).authorization).toBe('Bearer local-token'); return new Response(JSON.stringify({ state: 'idle', pending: 2, lastPullAt: 1, lastPushAt: 1, deviceCount: 2, url: 'https://h', error: null, claudeConfig: { enabled: false, confirmed: false } }), { status: 200 }); }
      throw new Error('down');
    }) as typeof fetch;
    const out = await cloudStatus({ home, fetch: f });
    expect(out).toContain('Worker: https://h（ok, 0.4.0）');
    expect(out).toContain('同期: idle');
    expect(out).toContain('未送信 2 件');
    expect(out).toContain('端末 2 台');
    const down = await cloudStatus({ home, fetch: (async (input: string | URL | Request) => { if (String(input) === 'https://h/health') return new Response('{"ok":true,"version":"x"}', { status: 200 }); throw new TypeError('ECONNREFUSED'); }) as typeof fetch });
    expect(down).toContain('サーバは停止中');
  });
});

describe('runTeardown', () => {
  it('2 段の確認の後に、ファイル、バケット、Worker、D1 を消して設定を消す', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-td-'));
    const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-clouddir-'));
    fs.mkdirSync(path.join(home, 'cloud'));
    fs.writeFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), '{}');
    saveCloudConfig(home, { url: 'https://h', joinSecret: 's', deviceToken: 't', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files', joinedAt: 1 });
    const w = fakeWrangler({ 'r2 object delete': () => ok(), 'r2 bucket delete': () => ok(), 'delete --name': () => ok(), 'd1 delete': () => ok() });
    const f = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.startsWith('https://h/files?since=0')) return new Response(JSON.stringify({ files: [{ key: 'transcripts/d/u.jsonl.gz', seq: 1 }, { key: 'config/CLAUDE.md', seq: 2 }], nextSeq: 2, more: false }), { status: 200 });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const answers = ['hangar-dev', 'delete'];
    const okTd = await runTeardown({ home, wrangler: w.runner('a'.repeat(32), cloudDir), fetch: f, confirm: async () => answers.shift() ?? '', log: () => {} });
    expect(okTd).toBe(true);
    expect(w.calls.map((c) => c.args.join(' '))).toEqual([
      'r2 object delete hangar-dev-files/transcripts/d/u.jsonl.gz',
      'r2 object delete hangar-dev-files/config/CLAUDE.md',
      'r2 bucket delete hangar-dev-files',
      `delete --name hangar-dev --config ${path.join(home, 'cloud', 'wrangler.jsonc')}`,
      'd1 delete hangar-dev -y',
    ]);
    expect(w.calls[3]!.input).toBe('y\n');
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'cloud', 'wrangler.jsonc'))).toBe(false);
  });
  it('確認に失敗したら何もしない', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-td-'));
    const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-clouddir-'));
    saveCloudConfig(home, { url: 'https://h', joinSecret: 's', deviceToken: 't', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files', joinedAt: 1 });
    const w = fakeWrangler({});
    expect(await runTeardown({ home, wrangler: w.runner('a'.repeat(32), cloudDir), fetch: (async () => new Response('{}')) as typeof fetch, confirm: async () => 'wrong', log: () => {} })).toBe(false);
    expect(w.calls).toEqual([]);
    expect(loadCloudConfig(home)).not.toBeNull();
  });
  it('参加だけの端末では実行できない', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-td-'));
    saveCloudConfig(home, { url: 'https://h', joinSecret: 's', deviceToken: 't', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    await expect(runTeardown({ home, fetch: (async () => new Response('{}')) as typeof fetch, confirm: async () => '', log: () => {} })).rejects.toThrow('setup cloud を実行した端末');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/cli/src/cloud`
Expected: FAIL（`runJoin` が無い）

- [ ] **Step 3: 実装する**

`packages/cli/src/cloud.ts` に足す。

```ts
import { decodeJoinToken, type SyncStatusDto } from '@agent-hangar/shared';
import { cloudConfigPath } from '@agent-hangar/server';

export async function runJoin(o: { home: string; token: string; device: DeviceLike; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<CloudConfig> {
  const t = decodeJoinToken(o.token);
  const url = t.url.replace(/\/+$/, '');
  const joined = await joinWorker(url, t.secret, o.device, o.fetch ?? realFetch, o.sleep ?? realSleep);
  const conf: CloudConfig = { url, joinSecret: t.secret, deviceToken: joined.deviceToken, workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: Date.now() };
  saveCloudConfig(o.home, conf);
  return conf;
}

const relative = (ms: number | null): string => {
  if (ms === null) return 'まだ';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分前` : `${Math.round(s / 3600)} 時間前`;
};

export async function cloudStatus(o: { home: string; fetch?: typeof fetch; port?: number }): Promise<string> {
  const fetchFn = o.fetch ?? realFetch;
  const c = loadCloudConfig(o.home);
  if (!c) return 'クラウド同期: 未設定（hangar setup cloud か hangar join <token> を実行してください）';
  const lines = [`Worker: ${c.url}`];
  try {
    const r = await fetchFn(`${c.url}/health`);
    const j = r.ok ? ((await r.json()) as { ok?: boolean; version?: string }) : null;
    lines[0] = `Worker: ${c.url}（${j?.ok ? `ok, ${j.version ?? '?'}` : `HTTP ${r.status}`}）`;
  } catch (e) { lines[0] = `Worker: ${c.url}（接続できません: ${e instanceof Error ? e.message : String(e)}）`; }
  lines.push(`役割: ${c.workerName ? `setup を実行した端末（Worker ${c.workerName}、アカウント ${c.accountId ?? '?'}）` : '参加した端末'}`);
  try {
    const token = fs.readFileSync(path.join(o.home, 'token'), 'utf8').trim();
    const r = await fetchFn(`http://127.0.0.1:${o.port ?? 4177}/api/sync/status`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = (await r.json()) as SyncStatusDto;
    lines.push(`同期: ${s.state}${s.error ? `（${s.error}）` : ''}、未送信 ${s.pending} 件、最終 pull ${relative(s.lastPullAt)}、端末 ${s.deviceCount} 台`);
  } catch {
    lines.push('同期: サーバは停止中（hangar start で起動すると同期が始まります）');
  }
  return lines.join('\n');
}

/**
 * Worker、R2、D1 を消す。setup cloud を実行した端末だけが使え、確認を 2 段で取る。
 * 途中の失敗は表示して先へ進み、最後にまとめて報告する。
 */
export async function runTeardown(o: { home: string; wrangler?: WranglerRunner; fetch?: typeof fetch; confirm: (q: string) => Promise<string>; log?: (line: string) => void; cloudDir?: string }): Promise<boolean> {
  const log = o.log ?? ((l: string) => console.log(l));
  const c = loadCloudConfig(o.home);
  if (!c) throw new Error('クラウド同期は未設定です');
  if (!c.workerName || !c.dbName || !c.bucketName) throw new Error('teardown は setup cloud を実行した端末でだけ使えます');
  log(`Worker ${c.workerName}、D1 ${c.dbName}、R2 ${c.bucketName} を消します。同期したメタデータと本文の写しはすべて失われます。`);
  if ((await o.confirm(`続けるには Worker の名前（${c.workerName}）を入力してください: `)).trim() !== c.workerName) { log('中止しました'); return false; }
  if ((await o.confirm('本当に消すなら delete と入力してください: ')).trim() !== 'delete') { log('中止しました'); return false; }
  const wr = o.wrangler ?? new WranglerRunner({ cloudDir: o.cloudDir ?? defaultCloudDir(), accountId: c.accountId, log });
  const fetchFn = o.fetch ?? realFetch;
  const failures: string[] = [];
  const step = async (label: string, args: string[], input?: string) => {
    const r = await wr.run(args, input);
    if (r.code !== 0) { failures.push(`${label}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`); log(`失敗: ${label}`); } else log(`完了: ${label}`);
  };
  const keys: string[] = [];
  try {
    for (let since = 0; ;) {
      const r = await fetchFn(`${c.url}/files?since=${since}&limit=500`, { headers: { authorization: `Bearer ${c.deviceToken}` } });
      if (!r.ok) break;
      const page = (await r.json()) as { files: { key: string }[]; nextSeq: number; more: boolean };
      keys.push(...page.files.map((f) => f.key));
      if (!page.more) break;
      since = page.nextSeq;
    }
  } catch (e) { failures.push(`ファイル一覧: ${e instanceof Error ? e.message : String(e)}`); }
  for (const k of keys) await step(`R2 object ${k}`, ['r2', 'object', 'delete', `${c.bucketName}/${k}`]);
  await step(`R2 bucket ${c.bucketName}`, ['r2', 'bucket', 'delete', c.bucketName]);
  await step(`Worker ${c.workerName}`, ['delete', '--name', c.workerName, '--config', path.join(o.home, 'cloud', 'wrangler.jsonc')], 'y\n');
  await step(`D1 ${c.dbName}`, ['d1', 'delete', c.dbName, '-y']);
  fs.rmSync(cloudConfigPath(o.home), { force: true });
  fs.rmSync(path.join(o.home, 'cloud', 'wrangler.jsonc'), { force: true });
  if (failures.length) { log('残った失敗:'); for (const f of failures) log(`  ${f}`); }
  log('cloud.json を消しました。他の端末の cloud.json は手で消してください。');
  return true;
}
```

`packages/cli/src/index.ts` に足す。

```ts
import readline from 'node:readline/promises';
import { cloudStatus, runJoin, runTeardown } from './cloud.ts';

const ask = async (q: string): Promise<string> => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } };

program.command('join <token>').description('参加トークンでクラウド同期に参加する')
  .option('--force', '既存の cloud.json を確認なしで上書きする')
  .action(async (token: string, o: { force?: boolean }) => {
    const home = hangarHome();
    if (!o.force && fs.existsSync(cloudConfigPath(home)) && (await ask('cloud.json が既にあります。上書きしますか (y/N): ')).trim().toLowerCase() !== 'y') { console.log('中止しました'); return; }
    const c = await runJoin({ home, token, device: readOrCreateDevice(home) });
    console.log(`参加しました: ${c.url}`);
    console.log('hangar を再起動すると同期が始まります。');
  });

const cloud = program.command('cloud').description('クラウド同期の管理');
cloud.command('status').description('同期の状態を表示する').option('--port <n>', 'ポート', '4177')
  .action(async (o: { port: string }) => { console.log(await cloudStatus({ home: hangarHome(), port: Number(o.port) })); });
cloud.command('teardown').description('Worker と D1 と R2 を消す（取り消せない）')
  .action(async () => { await runTeardown({ home: hangarHome(), confirm: ask }); });
```

`import fs from 'node:fs';` と `import { cloudConfigPath } from '@agent-hangar/server';` を先頭に足す。

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/cli && npx tsc -p packages/cli`
Expected: PASS（cloud 9 件を含む）

- [ ] **Step 5: コミット**

```bash
git add packages/cli
git commit -m "feat(cli): hangar join, cloud status and double-confirmed cloud teardown"
```

---

### Task 13: 本文の上げ手（TranscriptUploader）

**Files:**
- Create: `packages/server/src/sync/uploader.ts`
- Test: `packages/server/src/sync/uploader.test.ts`

**Interfaces:**
- Consumes: `transcriptKey`、`FileMetaIn`（shared）、`CloudClient`（`sync/client.ts`）、`encryptStream`、`sha256Stream`（`sync/crypto.ts`）、`SyncStateStore`（`sync/state.ts`）、`Timers`（`sync/engine.ts`）、`file_sync`（マイグレーション 6）。
- Produces:
  ```ts
  export type UploadTarget = { path: string; sessionId: string; agentId: string | null };   // sessionId は Claude の UUID
  export type UploaderDeps = { db: Db; deviceId: string; claudeDir: string; client: CloudClient; key: Buffer; state: SyncStateStore; now?: () => number; debounceMs?: number; timers?: Timers; isPaused: () => boolean; onError?: (path: string, message: string) => void };
  export class TranscriptUploader {
    constructor(deps: UploaderDeps);
    noteChanged(f: UploadTarget): void;
    flushSession(sessionUuid: string): Promise<void>;
    flushAll(): Promise<void>;
    uploadFile(f: UploadTarget): Promise<'uploaded' | 'unchanged' | 'skipped'>;
    stop(): void;
  }
  ```
- 「ファイル構成」は `uploader.ts` に `transcriptKey()` と書いてあるが、鍵の組み立ては shared の `transcriptKey` をそのまま使い、`uploader.ts` では定義し直さない。
- 上げる規則：`noteChanged` の 1 件目から 30 秒後に、そのとき待ち行列にあるファイルをまとめて上げる（窓はずらさないので、書き込みが続くセッションでも 30 秒ごとに上がる）。`flushSession` は run の終了から呼び、待たずに上げる。
- 1 ファイルの手順は、平文の SHA-256 を取り、`file_sync` の同じ鍵の値と同じなら `unchanged`、違えば gzip して `encryptStream` に通し、`PUT /files/<鍵>` に流し、`file_sync` を書く。
- R2 は部分更新ができないので、変化のたびにファイル全体を上げ直す。設計文書の「差分を上げる」はこの形で実現する（Task 26 で反映する）。
- 一時停止中、`sync_state` の `yielded:<sessionUuid>` が立っているセッション、`claudeDir` の外のパス、消えたファイルは `skipped` にする。
- 送信の失敗は待ち行列に残し、`onError` に渡す。`file_sync` は書かないので、次の機会に送り直す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/sync/uploader.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { decryptBuffer, deriveFileKey, sha256Hex } from './crypto.ts';
import { SyncStateStore } from './state.ts';
import { TranscriptUploader } from './uploader.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
const key = deriveFileKey('join-secret');
const MAIN_KEY = `transcripts/dev-a/${UUID}.jsonl.gz`;

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let claudeDir: string;
let state: SyncStateStore;
let paused = false;
const errors: { path: string; message: string }[] = [];

const projDir = () => path.join(claudeDir, 'projects', '-Users-me-workspace-alpha');
const mainFile = () => path.join(projDir(), `${UUID}.jsonl`);
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const make = () => new TranscriptUploader({ db, deviceId: 'dev-a', claudeDir, client: cloud, key, state, now: () => timers.now, timers, isPaused: () => paused, onError: (p, m) => errors.push({ path: p, message: m }) });
const plain = async (k: string) => gunzipSync(await decryptBuffer(key, cloud.files.get(k)!.body)).toString();
const puts = () => cloud.calls.filter((c) => c.method === 'putFile').length;

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'dev-a' });
  timers = new FakeTimers();
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-'));
  state = new SyncStateStore(db);
  paused = false;
  errors.length = 0;
  write(mainFile(), '{"a":1}\n');
});

describe('TranscriptUploader', () => {
  it('変化の 30 秒後に gzip と暗号化で上げ、file_sync に記録する', async () => {
    const up = make();
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(29_000);
    expect(cloud.files.size).toBe(0);
    await timers.advance(1_000);
    expect([...cloud.files.keys()]).toEqual([MAIN_KEY]);
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n');
    expect(cloud.files.get(MAIN_KEY)!.entry).toMatchObject({
      path: `projects/-Users-me-workspace-alpha/${UUID}.jsonl`, kind: 'transcript', encrypted: true, size: 8, sha256: sha256Hex('{"a":1}\n'),
    });
    expect(db.prepare('select * from file_sync where key = ?').get(MAIN_KEY)).toMatchObject({ kind: 'transcript', device_id: 'dev-a', sha256: sha256Hex('{"a":1}\n'), size: 8, remote_seq: 1 });
    up.stop();
  });
  it('内容が同じなら上げ直さず、増えたら上げ直す', async () => {
    const up = make();
    const f = { path: mainFile(), sessionId: UUID, agentId: null };
    expect(await up.uploadFile(f)).toBe('uploaded');
    expect(await up.uploadFile(f)).toBe('unchanged');
    expect(puts()).toBe(1);
    fs.appendFileSync(mainFile(), '{"a":2}\n');
    expect(await up.uploadFile(f)).toBe('uploaded');
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n{"a":2}\n');
    up.stop();
  });
  it('一時停止、譲ったセッション、無いファイル、claudeDir の外は skipped', async () => {
    const up = make();
    const f = { path: mainFile(), sessionId: UUID, agentId: null };
    paused = true;
    expect(await up.uploadFile(f)).toBe('skipped');
    paused = false;
    state.setYielded(UUID, true);
    expect(await up.uploadFile(f)).toBe('skipped');
    state.setYielded(UUID, false);
    expect(await up.uploadFile({ ...f, path: path.join(claudeDir, 'projects', 'none.jsonl') })).toBe('skipped');
    const outside = path.join(os.tmpdir(), 'hangar-outside.jsonl');
    fs.writeFileSync(outside, 'x');
    expect(await up.uploadFile({ ...f, path: outside })).toBe('skipped');
    expect(puts()).toBe(0);
    up.stop();
  });
  it('flushSession は待たずに上げ、noteChanged が来ていなくても手元の続きを拾う', async () => {
    const up = make();
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await up.flushSession(UUID);
    expect(puts()).toBe(1);
    await timers.advance(60_000);
    expect(puts()).toBe(1);
    fs.appendFileSync(mainFile(), '{"a":2}\n');
    await up.flushSession(UUID);
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n{"a":2}\n');
    up.stop();
  });
  it('サブエージェントは subagents の鍵で上げる', async () => {
    const sub = path.join(projDir(), UUID, 'subagents', 'agent-abc123.jsonl');
    write(sub, '{"s":1}\n');
    const up = make();
    expect(await up.uploadFile({ path: sub, sessionId: UUID, agentId: 'abc123' })).toBe('uploaded');
    expect([...cloud.files.keys()]).toEqual([`transcripts/dev-a/${UUID}/subagents/agent-abc123.jsonl.gz`]);
    up.stop();
  });
  it('失敗は onError に流して待ち行列に残し、復帰で送る', async () => {
    cloud.offline = true;
    const up = make();
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(30_000);
    expect(errors.map((e) => e.message)).toEqual(['offline']);
    expect((db.prepare('select count(*) c from file_sync').get() as { c: number }).c).toBe(0);
    cloud.offline = false;
    await up.flushAll();
    expect(cloud.files.size).toBe(1);
    up.stop();
  });
  it('stop の後は待ち行列に入れない', async () => {
    const up = make();
    up.stop();
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(60_000);
    expect(puts()).toBe(0);
    expect(timers.pendingCount()).toBe(0);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/sync/uploader`
Expected: FAIL（`./uploader.ts` が無い）

- [ ] **Step 3: 実装する**

`packages/server/src/sync/uploader.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { transcriptKey, type FileMetaIn } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import type { CloudClient } from './client.ts';
import { encryptStream, sha256Stream } from './crypto.ts';
import type { Timers } from './engine.ts';
import type { SyncStateStore } from './state.ts';

export type UploadTarget = { path: string; sessionId: string; agentId: string | null };
export type UploaderDeps = {
  db: Db; deviceId: string; claudeDir: string; client: CloudClient; key: Buffer; state: SyncStateStore;
  now?: () => number; debounceMs?: number; timers?: Timers; isPaused: () => boolean;
  onError?: (path: string, message: string) => void;
};

const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };
const toPosix = (p: string): string => p.split(path.sep).join('/');
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const agentIdOfKey = (key: string): string | null => /\/subagents\/agent-([0-9a-zA-Z]+)\.jsonl\.gz$/.exec(key)?.[1] ?? null;

/**
 * 手元の本文を gzip と AES-256-GCM で包んで R2 に上げる。
 * 鍵は端末ごとに分かれているので、他端末の本文を上書きすることはない。
 */
export class TranscriptUploader {
  private readonly pending = new Map<string, UploadTarget>();
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: UploaderDeps) {}

  private get timers(): Timers { return this.deps.timers ?? REAL_TIMERS; }
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /** 索引化が変化を見たファイルを待ち行列に入れる。1 件目から 30 秒後にまとめて上げる。 */
  noteChanged(f: UploadTarget): void {
    if (this.stopped) return;
    this.pending.set(f.path, f);
    if (this.timer) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.flushAll(); }, this.deps.debounceMs ?? 30_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** 上げる仕事は 1 本の鎖に並べ、同じファイルに対する putFile が重ならないようにする。 */
  private enqueue(work: () => Promise<void>): Promise<void> {
    this.chain = this.chain.catch(() => {}).then(work);
    return this.chain;
  }

  flushAll(): Promise<void> {
    return this.enqueue(async () => { for (const f of [...this.pending.values()]) await this.attempt(f); });
  }

  /** run の終了と引き継ぎで呼ぶ。待ち行列と、既に上げたことのある鍵の両方を見る。 */
  flushSession(sessionUuid: string): Promise<void> {
    return this.enqueue(async () => {
      const targets = new Map<string, UploadTarget>();
      for (const f of this.pending.values()) if (f.sessionId === sessionUuid) targets.set(f.path, f);
      for (const f of this.knownTargets(sessionUuid)) if (!targets.has(f.path)) targets.set(f.path, f);
      for (const f of targets.values()) await this.attempt(f);
    });
  }

  /** file_sync に残っている自端末の鍵から、そのセッションの手元のファイルを引き直す。 */
  private knownTargets(sessionUuid: string): UploadTarget[] {
    const head = `transcripts/${this.deps.deviceId}/${sessionUuid}`;
    const rows = this.deps.db
      .prepare("select key, path from file_sync where kind = 'transcript' and device_id = ? and (key = ? or key like ?)")
      .all(this.deps.deviceId, `${head}.jsonl.gz`, `${head}/subagents/%`) as { key: string; path: string }[];
    return rows.map((r) => ({ path: path.join(this.deps.claudeDir, r.path), sessionId: sessionUuid, agentId: agentIdOfKey(r.key) }));
  }

  private async attempt(f: UploadTarget): Promise<void> {
    try {
      await this.upload(f);
      this.pending.delete(f.path);
    } catch (e) {
      this.deps.onError?.(f.path, errorMessage(e));
    }
  }

  async uploadFile(f: UploadTarget): Promise<'uploaded' | 'unchanged' | 'skipped'> {
    try {
      const r = await this.upload(f);
      this.pending.delete(f.path);
      return r;
    } catch (e) {
      this.deps.onError?.(f.path, errorMessage(e));
      return 'skipped';
    }
  }

  private async upload(f: UploadTarget): Promise<'uploaded' | 'unchanged' | 'skipped'> {
    if (this.deps.isPaused()) return 'skipped';
    // 引き継ぎで譲ったセッションは、相手が持ち主なので上げない。
    if (this.deps.state.isYielded(f.sessionId)) return 'skipped';
    let st: fs.Stats;
    try { st = fs.statSync(f.path); } catch { return 'skipped'; }
    const rel = toPosix(path.relative(this.deps.claudeDir, f.path));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'skipped';
    const sha = await sha256Stream(fs.createReadStream(f.path));
    const key = transcriptKey(this.deps.deviceId, f.sessionId, f.agentId);
    const prev = this.deps.db.prepare('select sha256 from file_sync where key = ?').get(key) as { sha256: string } | undefined;
    if (prev?.sha256 === sha) return 'unchanged';
    const meta: FileMetaIn = { key, path: rel, kind: 'transcript', sha256: sha, size: st.size, mtime: Math.floor(st.mtimeMs), encrypted: true };
    // R2 は部分更新ができないので、変化のたびにファイル全体を gzip して上げ直す。
    const body = new PassThrough();
    const pump = pipeline(fs.createReadStream(f.path), createGzip(), encryptStream(this.deps.key), body);
    let seq: number;
    try {
      const [r] = await Promise.all([this.deps.client.putFile(meta, body), pump]);
      seq = r.seq;
    } catch (e) {
      body.destroy();
      throw e;
    }
    this.deps.db.prepare(`insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)
      on conflict(key) do update set path = excluded.path, sha256 = excluded.sha256, size = excluded.size, mtime = excluded.mtime, remote_seq = excluded.remote_seq, synced_at = excluded.synced_at`)
      .run(key, 'transcript', rel, this.deps.deviceId, sha, st.size, meta.mtime, seq, this.now());
    return 'uploaded';
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/sync/uploader && npx tsc -p packages/server`
Expected: PASS（7 件）。`tsc` は `SessionDto` の `lock` と `remoteOnly` の分だけ `queries.ts` に失敗が残る（Task 15 で直す）。

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/sync/uploader.ts packages/server/src/sync/uploader.test.ts
git commit -m "feat(server): transcript uploader with 30s debounce, gzip, encryption and file_sync bookkeeping"
```

---

### Task 14: 他端末の本文の取り込みと索引化

**Files:**
- Create: `packages/server/src/sync/puller.ts`
- Modify: `packages/server/src/provider/types.ts`、`packages/server/src/provider/claude-code/discover.ts`、`packages/server/src/indexer/indexFile.ts`、`packages/server/src/indexer/service.ts`
- Test: `packages/server/src/sync/puller.test.ts`、`packages/server/src/provider/claude-code/discover.test.ts`（追加）、`packages/server/src/indexer/indexFile.test.ts`（追加）、`packages/server/src/indexer/service.test.ts`（追加）

**Interfaces:**
- Consumes: `PULL_LIMIT`、`FileEntry`（shared）、`CloudClient`、`decryptStream`、`sha256Stream`、`SyncStateStore`、`remoteRoot`（`config/cloud.ts`）。
- Produces:
  ```ts
  // provider/types.ts（変更）
  export type DiscoveredFile = { path: string; sessionId: string; agentId: string | null; deviceId: string | null };   // deviceId が null なら手元のファイル
  // provider/claude-code/discover.ts（追加）
  export function listRemoteTranscriptFiles(remoteRootDir: string): DiscoveredFile[];
  export type SelectOptions = { statOf?: (p: string) => { mtimeMs: number } | null; isYielded?: (sessionUuid: string) => boolean };
  export function selectFilesToIndex(files: DiscoveredFile[], opts?: SelectOptions): { index: DiscoveredFile[]; drop: DiscoveredFile[] };
  // indexer/indexFile.ts（追加と変更）
  export type IndexFileOptions = { deviceId: string; indexerVersion?: number; cwdFallback?: string; remote?: boolean };
  export type IndexFileResult = { sessionId: string; providerSessionId: string; appended: number; changed: boolean; badLines: number; skipped: boolean };
  export function findSession(db: Db, providerSessionId: string): string | null;
  export function forgetTranscriptFile(db: Db, filePath: string): void;
  // indexer/service.ts（変更）
  export type IndexerServiceOptions = { db: Db; deviceId: string; claudeDir: string; isRunning: (providerSessionId: string) => boolean; pollMs?: number; debounceMs?: number; remoteRoot?: string; isYielded?: (sessionUuid: string) => boolean };
  // sync/puller.ts
  export type PullerDeps = { db: Db; deviceId: string; home: string; client: CloudClient; key: Buffer; state: SyncStateStore; onConfigEntries?: (entries: FileEntry[]) => Promise<void>; onError?: (key: string, message: string) => void };
  export function remoteTranscriptPath(home: string, deviceId: string, rel: string): string;
  export class RemotePuller {
    constructor(deps: PullerDeps);
    pullNow(): Promise<{ downloaded: number; configEntries: number }>;
    latestRemoteMain(sessionUuid: string): { deviceId: string; path: string; size: number; mtime: number } | null;
  }
  ```
- 降ろす規則：`GET /files` を `filesSeq` から読み、自端末の項目を飛ばし、`kind` が `config` の項目は `onConfigEntries` に渡し、本文は `~/.agent-hangar/remote/<端末 ID>/projects/<変換名>/<sessionId>.jsonl` に復号して展開する。`file_sync` の SHA-256 が同じで手元にファイルがあれば降ろし直さない。降ろした後は相手の `mtime` に合わせる（索引化の選別が更新時刻で決めるため）。
- 失敗した項目があった回は `filesSeq` をその項目の 1 つ手前で止め、次の pull でやり直す。
- 索引化の選別：同じセッションの同じ位置（主線かサブエージェント）のファイルが複数あるとき、手元のファイルを優先し、無ければ更新時刻が最新の写しを 1 つだけ索引化する。引き継ぎで譲ったセッション（`yielded:<uuid>`）は手元を優先せず、更新時刻が最新のものを採る。選ばれなかったファイルは `forgetTranscriptFile` で索引から外す。
- 他端末の写しを索引化するときは `sessions` と `session_summaries` に書かない。`sessions` の行がまだ届いていなければ、そのファイルは飛ばす（`skipped: true`）。`home_device` は本文を持つ端末が作った行の値をそのまま使い、取り込み側では触らない。

- [ ] **Step 1: 探索の失敗するテストを書く**

`packages/server/src/provider/claude-code/discover.test.ts` の `listTranscriptFiles` の期待に `deviceId: null` を足し、次の `describe` を足す。

```ts
import fs from 'node:fs';
import os from 'node:os';
import { listRemoteTranscriptFiles, selectFilesToIndex } from './discover.ts';

const tmpTree = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-remote-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
};

describe('listRemoteTranscriptFiles', () => {
  it('端末ごとのディレクトリを歩き、deviceId を付ける', () => {
    const u = '11111111-1111-4111-8111-111111111111';
    const root = tmpTree({
      [`dev-b/projects/-w-alpha/${u}.jsonl`]: '{}\n',
      [`dev-b/projects/-w-alpha/${u}/subagents/agent-ab12.jsonl`]: '{}\n',
      [`dev-c/projects/-w-alpha/${u}.jsonl`]: '{}\n',
      'dev-b/notes.txt': 'x',
    });
    expect(listRemoteTranscriptFiles(root)).toEqual([
      { path: path.join(root, 'dev-b/projects/-w-alpha', `${u}.jsonl`), sessionId: u, agentId: null, deviceId: 'dev-b' },
      { path: path.join(root, 'dev-b/projects/-w-alpha', u, 'subagents/agent-ab12.jsonl'), sessionId: u, agentId: 'ab12', deviceId: 'dev-b' },
      { path: path.join(root, 'dev-c/projects/-w-alpha', `${u}.jsonl`), sessionId: u, agentId: null, deviceId: 'dev-c' },
    ]);
    expect(listRemoteTranscriptFiles(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('selectFilesToIndex', () => {
  const f = (p: string, deviceId: string | null, agentId: string | null = null) => ({ path: p, sessionId: 'u1', agentId, deviceId });
  const stat = (m: Record<string, number>) => (p: string) => (m[p] === undefined ? null : { mtimeMs: m[p]! });

  it('手元があれば手元を選び、他は落とす', () => {
    const r = selectFilesToIndex([f('/remote/b/u1.jsonl', 'b'), f('/home/u1.jsonl', null), f('/remote/c/u1.jsonl', 'c')], { statOf: stat({ '/remote/b/u1.jsonl': 300, '/home/u1.jsonl': 100, '/remote/c/u1.jsonl': 200 }) });
    expect(r.index.map((x) => x.path)).toEqual(['/home/u1.jsonl']);
    expect(r.drop.map((x) => x.path)).toEqual(['/remote/b/u1.jsonl', '/remote/c/u1.jsonl']);
  });
  it('手元が無ければ更新時刻が最新の写しを 1 つだけ選ぶ', () => {
    const r = selectFilesToIndex([f('/remote/b/u1.jsonl', 'b'), f('/remote/c/u1.jsonl', 'c')], { statOf: stat({ '/remote/b/u1.jsonl': 100, '/remote/c/u1.jsonl': 200 }) });
    expect(r.index.map((x) => x.path)).toEqual(['/remote/c/u1.jsonl']);
    expect(r.drop.map((x) => x.path)).toEqual(['/remote/b/u1.jsonl']);
  });
  it('譲ったセッションは手元を優先しない', () => {
    const files = [f('/home/u1.jsonl', null), f('/remote/b/u1.jsonl', 'b')];
    const statOf = stat({ '/home/u1.jsonl': 100, '/remote/b/u1.jsonl': 300 });
    expect(selectFilesToIndex(files, { statOf }).index.map((x) => x.path)).toEqual(['/home/u1.jsonl']);
    expect(selectFilesToIndex(files, { statOf, isYielded: () => true }).index.map((x) => x.path)).toEqual(['/remote/b/u1.jsonl']);
  });
  it('主線とサブエージェントは別々に選ぶ', () => {
    const r = selectFilesToIndex([f('/home/u1.jsonl', null), f('/remote/b/agent.jsonl', 'b', 'ab12')], { statOf: stat({ '/home/u1.jsonl': 1, '/remote/b/agent.jsonl': 1 }) });
    expect(r.index).toHaveLength(2);
    expect(r.drop).toEqual([]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/discover`
Expected: FAIL（`listRemoteTranscriptFiles` が無い、`deviceId` が付かない）

- [ ] **Step 3: 探索を実装する**

`packages/server/src/provider/types.ts` の `DiscoveredFile` に `deviceId: string | null` を足す。

```ts
export type DiscoveredFile = { path: string; sessionId: string; agentId: string | null; deviceId: string | null };
```

`packages/server/src/provider/claude-code/discover.ts` の `listTranscriptFiles` を次の形に置き換え、後ろに 2 つの関数を足す。

```ts
/** 1 つの projects ディレクトリから本体とサブエージェントの jsonl をパス順に集める。 */
function listUnderProjects(root: string, deviceId: string | null): DiscoveredFile[] {
  if (!fs.existsSync(root)) return [];
  const out: DiscoveredFile[] = [];
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pd = path.join(root, proj.name);
    for (const entry of fs.readdirSync(pd, { withFileTypes: true })) {
      const full = path.join(pd, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const sessionId = entry.name.slice(0, -'.jsonl'.length);
        if (UUID_RE.test(sessionId)) out.push({ path: full, sessionId, agentId: null, deviceId });
      } else if (entry.isDirectory() && UUID_RE.test(entry.name)) {
        const sub = path.join(full, 'subagents');
        if (!fs.existsSync(sub)) continue;
        for (const f of fs.readdirSync(sub)) {
          const m = /^agent-([0-9a-zA-Z]+)\.jsonl$/.exec(f);
          if (m) out.push({ path: path.join(sub, f), sessionId: entry.name, agentId: m[1]!, deviceId });
        }
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** ~/.claude/projects 配下の本体とサブエージェントの jsonl をパス順に列挙する。 */
export function listTranscriptFiles(claudeDir: string): DiscoveredFile[] {
  return listUnderProjects(path.join(claudeDir, 'projects'), null);
}

/** ~/.agent-hangar/remote 配下を端末ごとに歩き、他端末の写しを列挙する。 */
export function listRemoteTranscriptFiles(remoteRootDir: string): DiscoveredFile[] {
  if (!fs.existsSync(remoteRootDir)) return [];
  const out: DiscoveredFile[] = [];
  for (const dev of fs.readdirSync(remoteRootDir, { withFileTypes: true })) {
    if (!dev.isDirectory()) continue;
    out.push(...listUnderProjects(path.join(remoteRootDir, dev.name, 'projects'), dev.name));
  }
  return out;
}

export type SelectOptions = { statOf?: (p: string) => { mtimeMs: number } | null; isYielded?: (sessionUuid: string) => boolean };

const defaultStat = (p: string): { mtimeMs: number } | null => { try { return fs.statSync(p); } catch { return null; } };

/**
 * 同じセッションの同じ位置にあるファイルから、索引化する 1 つを選ぶ。
 * 手元のファイルを優先し、無ければ更新時刻が最新の写しを採る。
 * 引き継ぎで譲ったセッションは持ち主が他端末なので、手元を優先しない。
 */
export function selectFilesToIndex(files: DiscoveredFile[], opts: SelectOptions = {}): { index: DiscoveredFile[]; drop: DiscoveredFile[] } {
  const statOf = opts.statOf ?? defaultStat;
  const groups = new Map<string, DiscoveredFile[]>();
  for (const f of files) {
    const k = `${f.sessionId}:${f.agentId ?? ''}`;
    const g = groups.get(k);
    if (g) g.push(f); else groups.set(k, [f]);
  }
  const index: DiscoveredFile[] = [];
  const drop: DiscoveredFile[] = [];
  for (const g of groups.values()) {
    const yielded = opts.isYielded?.(g[0]!.sessionId) === true;
    const locals = g.filter((f) => f.deviceId === null);
    const pool = !yielded && locals.length > 0 ? locals : g;
    const chosen = pool.reduce((a, b) => ((statOf(b.path)?.mtimeMs ?? 0) > (statOf(a.path)?.mtimeMs ?? 0) ? b : a));
    for (const f of g) (f === chosen ? index : drop).push(f);
  }
  const byPath = (a: DiscoveredFile, b: DiscoveredFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { index: index.sort(byPath), drop: drop.sort(byPath) };
}
```

- [ ] **Step 4: 索引化の失敗するテストを書く**

`packages/server/src/indexer/indexFile.test.ts` に足す。

```ts
import { findSession, forgetTranscriptFile, indexFile } from './indexFile.ts';

describe('他端末の写しの索引化', () => {
  const u = '11111111-1111-4111-8111-111111111111';
  const remoteFile = (dir: string, text: string): string => {
    const p = path.join(dir, 'dev-b', 'projects', '-w-alpha', `${u}.jsonl`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  const line = (role: 'user' | 'assistant', text: string) => JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] }, cwd: '/w/alpha', timestamp: '2026-09-01T00:00:00.000Z' }) + '\n';

  it('sessions の行がまだ無ければ飛ばす', () => {
    const db = openDb(':memory:');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rem-'));
    const p = remoteFile(dir, line('user', 'hello'));
    const r = indexFile(db, { path: p, sessionId: u, agentId: null, deviceId: 'dev-b' }, { deviceId: 'dev-a', remote: true });
    expect(r).toMatchObject({ changed: false, skipped: true });
    expect((db.prepare('select count(*) c from sessions').get() as { c: number }).c).toBe(0);
    expect((db.prepare('select count(*) c from changes').get() as { c: number }).c).toBe(0);
  });
  it('sessions があれば索引と統計だけ書き、共有テーブルには書かない', () => {
    const db = openDb(':memory:');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rem-'));
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: u, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
    const before = db.prepare('select updated_at from sessions where id = ?').get('s1') as { updated_at: number };
    const changesBefore = (db.prepare('select count(*) c from changes').get() as { c: number }).c;
    const p = remoteFile(dir, line('user', 'hello'));
    const r = indexFile(db, { path: p, sessionId: u, agentId: null, deviceId: 'dev-b' }, { deviceId: 'dev-a', remote: true });
    expect(r).toMatchObject({ sessionId: 's1', changed: true, skipped: false });
    expect((db.prepare('select count(*) c from event_index where session_id = ?').get('s1') as { c: number }).c).toBeGreaterThan(0);
    expect(db.prepare('select turns from session_stats where session_id = ?').get('s1')).toEqual({ turns: 1 });
    expect(db.prepare('select device_id from transcript_files where path = ?').get(p)).toEqual({ device_id: 'dev-b' });
    expect(db.prepare('select updated_at from sessions where id = ?').get('s1')).toEqual(before);
    expect((db.prepare('select count(*) c from changes').get() as { c: number }).c).toBe(changesBefore);
    expect(findSession(db, u)).toBe('s1');
    expect(findSession(db, 'nope')).toBeNull();
  });
  it('forgetTranscriptFile は索引と行を消す', () => {
    const db = openDb(':memory:');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rem-'));
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: u, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
    const p = remoteFile(dir, line('user', 'hello'));
    indexFile(db, { path: p, sessionId: u, agentId: null, deviceId: 'dev-b' }, { deviceId: 'dev-a', remote: true });
    forgetTranscriptFile(db, p);
    expect(db.prepare('select 1 from transcript_files where path = ?').get(p)).toBeUndefined();
    expect((db.prepare('select count(*) c from event_index where session_id = ?').get('s1') as { c: number }).c).toBe(0);
    expect((db.prepare("select count(*) c from event_fts where session_id = 's1'").get() as { c: number }).c).toBe(0);
    forgetTranscriptFile(db, '/nope');
  });
});
```

- [ ] **Step 5: 索引化を実装する**

`packages/server/src/indexer/indexFile.ts` を次のように直す。

```ts
export type IndexFileOptions = { deviceId: string; indexerVersion?: number; cwdFallback?: string; remote?: boolean };
export type IndexFileResult = { sessionId: string; providerSessionId: string; appended: number; changed: boolean; badLines: number; skipped: boolean };

/** provider と provider_session_id の組で sessions を引く。無ければ null。 */
export function findSession(db: Db, providerSessionId: string): string | null {
  const row = db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ?").get(providerSessionId) as { id: string } | undefined;
  return row ? row.id : null;
}

/** 索引化をやめたファイルの索引と行を消す。同じ位置のファイルは常に 1 つだけ索引化する前提に立つ。 */
export function forgetTranscriptFile(db: Db, filePath: string): void {
  const row = db.prepare('select session_id, agent_id from transcript_files where path = ?').get(filePath) as { session_id: string; agent_id: string | null } | undefined;
  if (!row) return;
  const agentKey = row.agent_id ?? '';
  const run = db.transaction(() => {
    db.prepare("delete from event_index where session_id = ? and ifnull(parent_agent, '') = ?").run(row.session_id, agentKey);
    db.prepare("delete from event_fts where session_id = ? and ifnull(agent_id, '') = ?").run(row.session_id, agentKey);
    db.prepare('delete from transcript_files where path = ?').run(filePath);
  });
  run();
}
```

`indexFile` の頭に飛ばす判定を足す（`const tf = ...` の直後）。

```ts
  const remote = opts.remote === true;
  // 他端末の写しは sessions を作らない。行がまだ届いていなければ次の走査に回す。
  if (remote && !tf && findSession(db, file.sessionId) === null) {
    return { sessionId: '', providerSessionId: file.sessionId, appended: 0, changed: false, badLines: 0, artifactIds: [], skipped: true };
  }
```

`IndexFileResult` にはフェーズ 3 が足した `artifactIds: string[]` があるので、新しい `skipped: boolean` はその後ろに足す。
早い `return`（`tf` が新しくて読み直さない 1 か所）と最後の `return` に `skipped: false` を足す。
トランザクションの中の `sessionId` を決める 1 文と、`transcript_files` の upsert の 1 文と、末尾の `applySessionFacts` の分岐の 1 文を次に置き換える。
`usage_daily` へ書く 2 文と、その後の `artifactIdsOut = [...artifactIds];` はそのまま残す。

```ts
    sessionId = tf?.session_id ?? (remote ? findSession(db, file.sessionId)! : ensureSession(db, file.sessionId, cwd, opts.deviceId));
```

```ts
    db.prepare(`insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version, last_error) values (?,?,?,?,?,?,?,?,null)
      on conflict(path) do update set session_id = excluded.session_id, agent_id = excluded.agent_id, device_id = excluded.device_id, size = excluded.size, mtime = excluded.mtime, indexed_bytes = excluded.indexed_bytes, indexer_version = excluded.indexer_version, last_error = null`)
      .run(file.path, sessionId, file.agentId, file.deviceId, stat.size, mtime, read.nextByte, version);
    if (file.agentId !== null) refreshFilesChanged(db, sessionId);
    else if (remote) writeSessionStats(db, sessionId, acc, reset);
    else applySessionFacts(db, sessionId, acc, reset, opts.deviceId);
```

`applySessionFacts` の後半（`session_stats` への書き込みと `refreshFilesChanged`）を関数に切り出し、`applySessionFacts` からも呼ぶ。

```ts
/** 主線から得た事実を sessions に重ねる。他端末の写しではこの関数を呼ばない。 */
function applySessionFacts(db: Db, sessionId: string, acc: Acc, reset: boolean, deviceId: string): void {
  const cur = db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...cur };
  if (acc.cwd && !cur.cwd) next.cwd = acc.cwd;
  if (acc.firstPrompt !== undefined && (reset || cur.first_prompt == null)) next.first_prompt = acc.firstPrompt;
  if (acc.aiTitle) next.ai_title = acc.aiTitle;
  const name = acc.customTitle ?? acc.agentName;
  if (name) next.name = name;
  if (acc.firstTs !== undefined) next.started_at = reset || cur.started_at == null ? acc.firstTs : Math.min(cur.started_at as number, acc.firstTs);
  if (acc.lastTs !== undefined) next.last_activity_at = reset || cur.last_activity_at == null ? acc.lastTs : Math.max(cur.last_activity_at as number, acc.lastTs);
  delete next.updated_at; delete next.origin_device;
  if (JSON.stringify(next) !== JSON.stringify(Object.fromEntries(Object.entries(cur).filter(([k]) => k !== 'updated_at' && k !== 'origin_device')))) {
    upsertShared(db, 'sessions', next, deviceId);
  }
  writeSessionStats(db, sessionId, acc, reset);
}

/** 索引から導いた統計。端末ローカルなので、他端末の写しから書いてよい。 */
function writeSessionStats(db: Db, sessionId: string, acc: Acc, reset: boolean): void {
  const st = db.prepare('select * from session_stats where session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  const base = reset || !st ? { turns: 0, input_tokens: 0, output_tokens: 0 } : { turns: st.turns as number, input_tokens: st.input_tokens as number, output_tokens: st.output_tokens as number };
  db.prepare(`insert into session_stats (session_id, turns, model, effort, pr_url, input_tokens, output_tokens, first_ts, last_ts, last_prompt) values (?,?,?,?,?,?,?,?,?,?)
    on conflict(session_id) do update set turns = excluded.turns, model = excluded.model, effort = excluded.effort, pr_url = excluded.pr_url, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, first_ts = excluded.first_ts, last_ts = excluded.last_ts, last_prompt = excluded.last_prompt`)
    .run(sessionId, base.turns + acc.userTurns, acc.model ?? (reset ? null : st?.model ?? null), acc.effort ?? (reset ? null : st?.effort ?? null), acc.prUrl ?? (reset ? null : st?.pr_url ?? null),
      base.input_tokens + acc.input, base.output_tokens + acc.output,
      acc.firstTs ?? (reset ? null : st?.first_ts ?? null), acc.lastTs ?? (reset ? null : st?.last_ts ?? null),
      acc.lastPrompt ?? (reset ? null : st?.last_prompt ?? null));
  refreshFilesChanged(db, sessionId);
}
```

`ensureSession` はそのまま残す（手元のファイルと `syncHistoryOnly` が使う）。

- [ ] **Step 6: インデクサのサービスを直す**

`packages/server/src/indexer/service.ts` を直す。

```ts
import { listRemoteTranscriptFiles, listTranscriptFiles, readHistoryIndex, selectFilesToIndex, type HistoryEntry } from '../provider/claude-code/discover.ts';
import { ensureSession, forgetTranscriptFile, indexFile } from './indexFile.ts';

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
};
```

`indexOne` と、ファイルを列挙する箇所を次に置き換える。

```ts
  /** 索引化するファイルを選び、外れたものを索引から落とす。 */
  private targets(): DiscoveredFile[] {
    const local = listTranscriptFiles(this.opts.claudeDir);
    const remote = this.opts.remoteRoot ? listRemoteTranscriptFiles(this.opts.remoteRoot) : [];
    const { index, drop } = selectFilesToIndex([...local, ...remote], { isYielded: this.opts.isYielded });
    for (const d of drop) {
      try { forgetTranscriptFile(this.opts.db, d.path); } catch (e) { this.emitError(d.path, errorMessage(e)); }
    }
    return index;
  }

  /** 1 ファイルを索引化し、変わっていたら土台の要約を書いて sessionChanged を出す。 */
  private indexOne(file: DiscoveredFile, history: Map<string, HistoryEntry>): boolean {
    try {
      const r = indexFile(this.opts.db, file, { deviceId: this.opts.deviceId, cwdFallback: history.get(file.sessionId)?.cwd, remote: file.deviceId !== null });
      this.reportedErrors.delete(file.path);
      if (!r.changed) return false;
      // 土台の要約は共有テーブルなので、本文を持つ端末だけが書く。
      if (file.deviceId === null && (file.agentId === null || r.appended > 0)) {
        writeBaselineIfNeeded(this.opts.db, r.sessionId, this.opts.deviceId, this.opts.isRunning(file.sessionId));
      }
      for (const l of this.listeners) l.sessionChanged?.({ sessionId: r.sessionId, providerSessionId: file.sessionId, agentId: file.agentId, appended: r.appended, artifactIds: r.artifactIds, deviceId: file.deviceId, path: file.path });
      return true;
    } catch (e) {
      // catch の中はフェーズ 3 のまま変えない（last_error の書き込みと reportedErrors による間引き）。
      ...既存のとおり...
    }
  }
```

`fullScan` の `const files = listTranscriptFiles(this.opts.claudeDir);` を `const files = this.targets();` に、`tick` の `for (const f of listTranscriptFiles(this.opts.claudeDir))` を `for (const f of this.targets())` に替える。
`IndexerListener` の `sessionChanged` に `deviceId: string | null` と `path: string` を足す（本文の上げ手がファイルのパスを要る）。既存の `artifactIds: string[]` は残す。
`start()` で、`remoteRoot` があれば作ってから監視する。

```ts
    if (this.opts.remoteRoot) {
      fs.mkdirSync(this.opts.remoteRoot, { recursive: true });
      try { this.watchers.push(fs.watch(this.opts.remoteRoot, { recursive: true }, schedule)); } catch (e) { this.emitError(this.opts.remoteRoot, `fs.watch failed, polling only: ${errorMessage(e)}`); }
    }
```

`import type { DiscoveredFile } from '../provider/types.ts';` は既にあるので足さない。

- [ ] **Step 7: サービスのテストを足す**

`packages/server/src/indexer/service.test.ts` に足す（`fs`、`os`、`path`、`openDb`、`upsertShared`、`IndexerService` の import が無ければ足す）。

```ts
describe('他端末の本文の索引化', () => {
  const u = '11111111-1111-4111-8111-111111111111';
  const line = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, cwd: '/w/alpha', timestamp: '2026-09-01T00:00:00.000Z' }) + '\n';

  it('remote の写しを索引化し、手元の本文が現れたら写しを落とす', async () => {
    const db = openDb(':memory:');
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cd-'));
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rr-'));
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: u, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
    const rp = path.join(remote, 'dev-b', 'projects', '-w-alpha', `${u}.jsonl`);
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    fs.writeFileSync(rp, line('remote-body'));
    const svc = new IndexerService({ db, deviceId: 'dev-a', claudeDir, remoteRoot: remote, isRunning: () => false });
    await svc.fullScan();
    expect(db.prepare('select device_id from transcript_files where session_id = ?').get('s1')).toEqual({ device_id: 'dev-b' });
    expect((db.prepare('select count(*) c from event_index where session_id = ?').get('s1') as { c: number }).c).toBe(1);

    const lp = path.join(claudeDir, 'projects', '-w-alpha', `${u}.jsonl`);
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, line('local-body') + line('local-body-2'));
    await svc.fullScan();
    expect(db.prepare('select path, device_id from transcript_files where session_id = ?').all('s1')).toEqual([{ path: lp, device_id: null }]);
    expect((db.prepare('select count(*) c from event_index where session_id = ?').get('s1') as { c: number }).c).toBe(2);
    svc.stop();
  });
});
```

- [ ] **Step 8: puller の失敗するテストを書く**

`packages/server/src/sync/puller.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileEntry, FileMetaIn } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { openDb, type Db } from '../db/open.ts';
import { encryptBuffer, deriveFileKey, sha256Hex } from './crypto.ts';
import { RemotePuller, remoteTranscriptPath } from './puller.ts';
import { SyncStateStore } from './state.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
const key = deriveFileKey('join-secret');
let db: Db;
let cloud: FakeCloudClient;
let home: string;
let state: SyncStateStore;
const errors: { key: string; message: string }[] = [];

const putRemote = async (device: string, rel: string, text: string, k = `transcripts/${device}/${UUID}.jsonl.gz`, kind: 'transcript' | 'config' = 'transcript') => {
  const enc = await encryptBuffer(key, gzipSync(Buffer.from(text)));
  const meta: FileMetaIn = { key: k, path: rel, kind, sha256: sha256Hex(text), size: Buffer.byteLength(text), mtime: 1_700_000_000_000, encrypted: true };
  await cloud.asDevice(device).putFile(meta, Readable.from([enc]));
};
const make = (over: Partial<ConstructorParameters<typeof RemotePuller>[0]> = {}) => new RemotePuller({ db, deviceId: 'dev-a', home, client: cloud, key, state, onError: (k, m) => errors.push({ key: k, message: m }), ...over });

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'dev-a' });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  state = new SyncStateStore(db);
  errors.length = 0;
});

describe('remoteTranscriptPath', () => {
  it('remote/<端末>/<相対パス> を組み立て、怪しい相対パスは拒む', () => {
    expect(remoteTranscriptPath('/h', 'dev-b', `projects/-w-alpha/${UUID}.jsonl`)).toBe(path.join('/h', 'remote', 'dev-b', 'projects', '-w-alpha', `${UUID}.jsonl`));
    expect(() => remoteTranscriptPath('/h', 'dev-b', '../../etc/passwd')).toThrow();
    expect(() => remoteTranscriptPath('/h', 'dev-b', 'projects/../../x.jsonl')).toThrow();
    expect(() => remoteTranscriptPath('/h', '../evil', 'projects/x.jsonl')).toThrow();
    expect(() => remoteTranscriptPath('/h', 'dev-b', 'skills/x.md')).toThrow();
  });
});

describe('RemotePuller', () => {
  it('他端末の本文を復号して展開し、file_sync と mtime を揃える', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 1, configEntries: 0 });
    const target = remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}\n');
    expect(Math.floor(fs.statSync(target).mtimeMs)).toBe(1_700_000_000_000);
    expect(db.prepare('select device_id, sha256, size from file_sync where key = ?').get(`transcripts/dev-b/${UUID}.jsonl.gz`)).toEqual({ device_id: 'dev-b', sha256: sha256Hex('{"a":1}\n'), size: 8 });
    expect(state.getNumber('filesSeq', 0)).toBe(1);
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
  });
  it('自端末の分は降ろさず、設定は呼び出し側に渡す', async () => {
    await putRemote('dev-a', `projects/-w-alpha/${UUID}.jsonl`, 'mine\n');
    await putRemote('dev-b', 'CLAUDE.md', '# hi\n', 'config/CLAUDE.md', 'config');
    const seen: FileEntry[][] = [];
    const p = make({ onConfigEntries: async (e) => { seen.push(e); } });
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 1 });
    expect(seen[0]!.map((e) => e.key)).toEqual(['config/CLAUDE.md']);
    expect(fs.existsSync(path.join(home, 'remote', 'dev-a'))).toBe(false);
  });
  it('SHA-256 が合わなければ捨てて、次の pull でやり直す', async () => {
    const enc = await encryptBuffer(key, gzipSync(Buffer.from('body\n')));
    await cloud.asDevice('dev-b').putFile({ key: `transcripts/dev-b/${UUID}.jsonl.gz`, path: `projects/-w-alpha/${UUID}.jsonl`, kind: 'transcript', sha256: 'f'.repeat(64), size: 5, mtime: 1, encrypted: true }, Readable.from([enc]));
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    expect(errors[0]!.message).toContain('SHA-256');
    expect(fs.existsSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`))).toBe(false);
    expect(state.getNumber('filesSeq', -1)).toBe(0);
  });
  it('latestRemoteMain は更新時刻が最新の写しを返す', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'b-body\n');
    await putRemote('dev-c', `projects/-w-alpha/${UUID}.jsonl`, 'c-body-longer\n', `transcripts/dev-c/${UUID}.jsonl.gz`);
    const p = make();
    await p.pullNow();
    db.prepare('update file_sync set mtime = 2000 where device_id = ?').run('dev-c');
    const best = p.latestRemoteMain(UUID)!;
    expect(best.deviceId).toBe('dev-c');
    expect(best.path).toBe(remoteTranscriptPath(home, 'dev-c', `projects/-w-alpha/${UUID}.jsonl`));
    expect(p.latestRemoteMain('22222222-2222-4222-8222-222222222222')).toBeNull();
  });
});
```

- [ ] **Step 9: puller を実装する**

`packages/server/src/sync/puller.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { PULL_LIMIT, type FileEntry } from '@agent-hangar/shared';
import { remoteRoot } from '../config/cloud.ts';
import type { Db } from '../db/open.ts';
import type { CloudClient } from './client.ts';
import { decryptStream, sha256Stream } from './crypto.ts';
import type { SyncStateStore } from './state.ts';

export type PullerDeps = {
  db: Db; deviceId: string; home: string; client: CloudClient; key: Buffer; state: SyncStateStore;
  onConfigEntries?: (entries: FileEntry[]) => Promise<void>;
  onError?: (key: string, message: string) => void;
};

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 他端末の本文の置き場。相対パスは projects/ の下に限り、端末 ID も名前として安全な文字だけを許す。 */
export function remoteTranscriptPath(home: string, deviceId: string, rel: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(deviceId)) throw new Error(`端末 ID が不正です: ${deviceId}`);
  const norm = path.posix.normalize(rel);
  if (!norm.startsWith('projects/') || norm.includes('..') || norm.startsWith('/')) throw new Error(`本文の相対パスが不正です: ${rel}`);
  return path.join(remoteRoot(home), deviceId, ...norm.split('/'));
}

/** 他端末が上げた本文を降ろして手元に展開する。設定ファイルは ClaudeConfigSync に渡す。 */
export class RemotePuller {
  constructor(private readonly deps: PullerDeps) {}

  async pullNow(): Promise<{ downloaded: number; configEntries: number }> {
    let since = this.deps.state.getNumber('filesSeq', 0);
    let advanceTo = since;
    let minFailed: number | null = null;
    let downloaded = 0;
    const configs: FileEntry[] = [];
    for (;;) {
      const page = await this.deps.client.listFiles(since, PULL_LIMIT);
      for (const e of page.files) {
        if (e.deviceId === this.deps.deviceId) continue;
        if (e.kind === 'config') { configs.push(e); continue; }
        try {
          if (await this.download(e)) downloaded++;
        } catch (err) {
          minFailed = minFailed === null ? e.seq : Math.min(minFailed, e.seq);
          this.deps.onError?.(e.key, errorMessage(err));
        }
      }
      since = page.nextSeq;
      advanceTo = page.nextSeq;
      if (!page.more) break;
    }
    // 失敗した項目より手前で止めて、次の pull で取り直す。
    this.deps.state.set('filesSeq', minFailed !== null ? minFailed - 1 : advanceTo);
    if (configs.length > 0 && this.deps.onConfigEntries) await this.deps.onConfigEntries(configs);
    return { downloaded, configEntries: configs.length };
  }

  private async download(e: FileEntry): Promise<boolean> {
    const target = remoteTranscriptPath(this.deps.home, e.deviceId, e.path);
    const prev = this.deps.db.prepare('select sha256 from file_sync where key = ?').get(e.key) as { sha256: string } | undefined;
    if (prev?.sha256 === e.sha256 && fs.existsSync(target)) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.part`;
    const body = await this.deps.client.getFile(e.key);
    if (e.encrypted) await pipeline(body, decryptStream(this.deps.key), createGunzip(), fs.createWriteStream(tmp));
    else await pipeline(body, createGunzip(), fs.createWriteStream(tmp));
    const sha = await sha256Stream(fs.createReadStream(tmp));
    if (sha !== e.sha256) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`本文の SHA-256 が一致しません: ${e.key}`);
    }
    fs.renameSync(tmp, target);
    // 索引化の選別が更新時刻で最新の写しを選ぶので、相手の mtime に合わせる。
    fs.utimesSync(target, new Date(e.mtime), new Date(e.mtime));
    this.deps.db.prepare(`insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)
      on conflict(key) do update set path = excluded.path, device_id = excluded.device_id, sha256 = excluded.sha256, size = excluded.size, mtime = excluded.mtime, remote_seq = excluded.remote_seq, synced_at = excluded.synced_at`)
      .run(e.key, 'transcript', e.path, e.deviceId, e.sha256, e.size, e.mtime, e.seq, Date.now());
    return true;
  }

  /** 手元に降ろした写しのうち、更新時刻が最新のもの。「この PC で再開」と引き継ぎが使う。 */
  latestRemoteMain(sessionUuid: string): { deviceId: string; path: string; size: number; mtime: number } | null {
    const rows = this.deps.db
      .prepare("select path, device_id, size, mtime from file_sync where kind = 'transcript' and device_id <> ? and key like ? order by mtime desc")
      .all(this.deps.deviceId, `transcripts/%/${sessionUuid}.jsonl.gz`) as { path: string; device_id: string; size: number; mtime: number }[];
    for (const r of rows) {
      const p = remoteTranscriptPath(this.deps.home, r.device_id, r.path);
      if (fs.existsSync(p)) return { deviceId: r.device_id, path: p, size: r.size, mtime: r.mtime };
    }
    return null;
  }
}
```

- [ ] **Step 10: テストと型検査**

Run: `npx vitest run packages/server/src/sync/puller packages/server/src/provider packages/server/src/indexer && npx tsc -p packages/server`
Expected: PASS。`tsc` は `SessionDto` の `lock` と `remoteOnly` の分だけ `queries.ts` に失敗が残る（Task 15 で直す）。

- [ ] **Step 11: コミット**

```bash
git add packages/server/src/sync/puller.ts packages/server/src/sync/puller.test.ts packages/server/src/provider packages/server/src/indexer
git commit -m "feat(server): download remote transcripts and index them alongside local ones"
```

---

### Task 15: セッションのロック、remoteOnly、端末一覧

**Files:**
- Modify: `packages/server/src/db/queries.ts`
- Test: `packages/server/src/db/queries.test.ts`（追加）

**Interfaces:**
- Consumes: `SessionLockDto`、`DeviceDto`、`SessionDto`（shared、Task 1）。`transcript_files.device_id`（Task 8 のマイグレーション 6）。
- Produces:
  ```ts
  export const LOCK_STALE_MS = 120_000;
  export type SessionQueryOptions = { projectId?: string; ids?: string[]; deviceId?: string; now?: () => number };
  export function listSessions(db: Db, live: LiveSessionDto[], opts?: SessionQueryOptions): SessionDto[];
  export function getSession(db: Db, live: LiveSessionDto[], id: string, opts?: { deviceId?: string; now?: () => number }): SessionDto | null;
  export function listDevices(db: Db, selfId: string): DeviceDto[];
  ```
- ロックの規則：`opts.deviceId`（自端末）を渡したときだけ計算する。`runs` のうち `ended_at` が null で `deleted_at` が null、`device_id` が自端末以外の行を、セッションごとに `heartbeat_at` が最新の 1 件だけ採る。`stale` は `now - heartbeat_at > 120_000`。`deviceName` は `devices` の名前で、行が無ければ端末 ID をそのまま出す。
- `hasTranscript` は写しがあれば true にして、閲覧と検索を許す。`remoteOnly` は本文があり、そのうち手元（`transcript_files.device_id` が null）の主線が無いときに true にする。
- `listDevices` は `last_seen_at` の降順（null は末尾）、同順位は名前順で返し、自端末に `self: true` を付ける。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/db/queries.test.ts` に足す。

```ts
import { LOCK_STALE_MS, getSession, listDevices, listSessions } from './queries.ts';
import { softDeleteShared, upsertShared } from './shared.ts';   // 既に import していれば足さない

describe('ロックと remoteOnly と端末一覧', () => {
  const NOW = 1_700_000_000_000;
  const setup = (): Db => {
    const db = openDb(':memory:');
    upsertShared(db, 'devices', { id: 'dev-a', name: 'mac', platform: 'darwin', last_seen_at: NOW }, 'dev-a');
    upsertShared(db, 'devices', { id: 'dev-b', name: 'mini', platform: 'darwin', last_seen_at: NOW - 1000 }, 'dev-b');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w/a', home_device: 'dev-b' }, 'dev-b');
    return db;
  };
  const addRun = (db: Db, o: { id: string; device: string; heartbeat: number; ended?: number | null }) =>
    upsertShared(db, 'runs', { id: o.id, session_id: 's1', device_id: o.device, kind: 'start', tmux_name: `hangar-${o.id}`, pid: null, launch_params: '{}', started_at: NOW - 60_000, ended_at: o.ended ?? null, end_reason: o.ended ? 'exited' : null, heartbeat_at: o.heartbeat }, o.device);
  const one = (db: Db) => listSessions(db, [], { deviceId: 'dev-a', now: () => NOW })[0]!;

  it('他端末の生きた run をロックとして出し、自端末と終わった run は出さない', () => {
    const db = setup();
    expect(one(db).lock).toBeNull();
    addRun(db, { id: 'r-old', device: 'dev-b', heartbeat: NOW - 300_000, ended: NOW - 200_000 });
    expect(one(db).lock).toBeNull();
    addRun(db, { id: 'r-self', device: 'dev-a', heartbeat: NOW });
    expect(one(db).lock).toBeNull();
    addRun(db, { id: 'r-b', device: 'dev-b', heartbeat: NOW - 30_000 });
    expect(one(db).lock).toEqual({ deviceId: 'dev-b', deviceName: 'mini', runId: 'r-b', heartbeatAt: NOW - 30_000, stale: false });
    expect(getSession(db, [], 's1', { deviceId: 'dev-a', now: () => NOW })!.lock!.runId).toBe('r-b');
  });
  it('heartbeat が 2 分より古ければ stale', () => {
    const db = setup();
    addRun(db, { id: 'r-b', device: 'dev-b', heartbeat: NOW - LOCK_STALE_MS - 1 });
    expect(one(db).lock).toMatchObject({ stale: true });
  });
  it('deviceId を渡さなければロックを計算しない', () => {
    const db = setup();
    addRun(db, { id: 'r-b', device: 'dev-b', heartbeat: NOW });
    expect(listSessions(db, [])[0]!.lock).toBeNull();
  });
  it('写しだけのセッションは hasTranscript が true で remoteOnly も true', () => {
    const db = setup();
    const ins = db.prepare('insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?,?)');
    expect(one(db)).toMatchObject({ hasTranscript: false, remoteOnly: false });
    ins.run('/h/remote/dev-b/projects/-w-a/u1.jsonl', 's1', null, 'dev-b', 10, 1, 10, 1);
    expect(one(db)).toMatchObject({ hasTranscript: true, remoteOnly: true });
    ins.run('/h/.claude/projects/-w-a/u1.jsonl', 's1', null, null, 10, 1, 10, 1);
    expect(one(db)).toMatchObject({ hasTranscript: true, remoteOnly: false });
  });
  it('端末一覧は最終確認の新しい順で、自端末に印を付ける', () => {
    const db = setup();
    expect(listDevices(db, 'dev-a')).toEqual([
      { id: 'dev-a', name: 'mac', platform: 'darwin', lastSeenAt: NOW, self: true },
      { id: 'dev-b', name: 'mini', platform: 'darwin', lastSeenAt: NOW - 1000, self: false },
    ]);
    softDeleteShared(db, 'devices', 'dev-b', 'dev-a');
    expect(listDevices(db, 'dev-a').map((d) => d.id)).toEqual(['dev-a']);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/db/queries`
Expected: FAIL（`lock` が無い、`listDevices` が無い）

- [ ] **Step 3: 実装する**

`packages/server/src/db/queries.ts` を直す。
`SESSION_SELECT` の `has_transcript` の行を次の 2 行に替える。

```sql
select s.*, exists(select 1 from transcript_files t where t.session_id = s.id and t.agent_id is null) has_transcript,
  exists(select 1 from transcript_files t where t.session_id = s.id and t.agent_id is null and t.device_id is null) has_local,
```

`SessionRow` に `has_local: number;` を足し、次を足す。

```ts
import type { DeviceDto, SessionLockDto } from '@agent-hangar/shared';

/** 他端末の run が生きているとみなす heartbeat の猶予。 */
export const LOCK_STALE_MS = 120_000;

export type SessionQueryOptions = { projectId?: string; ids?: string[]; deviceId?: string; now?: () => number };

type LockRow = { session_id: string; run_id: string; device_id: string; device_name: string | null; heartbeat_at: number };

/**
 * 他端末で生きている run を、セッションごとに 1 つ拾う。
 * 自端末の run は「実行中」として live に出るので、ロックには含めない。
 */
function lockMap(db: Db, selfDeviceId: string | undefined, now: number): Map<string, SessionLockDto> {
  const out = new Map<string, SessionLockDto>();
  if (!selfDeviceId) return out;
  const rows = db.prepare(`
    select r.session_id, r.id run_id, r.device_id, d.name device_name, r.heartbeat_at
    from runs r left join devices d on d.id = r.device_id and d.deleted_at is null
    where r.ended_at is null and r.deleted_at is null and r.device_id <> ?
    order by r.heartbeat_at`).all(selfDeviceId) as LockRow[];
  for (const r of rows) {
    out.set(r.session_id, { deviceId: r.device_id, deviceName: r.device_name ?? r.device_id, runId: r.run_id, heartbeatAt: r.heartbeat_at, stale: now - r.heartbeat_at > LOCK_STALE_MS });
  }
  return out;
}
```

`toSessionDto` の引数に `locks: Map<string, SessionLockDto>` を足し、返り値に次を足す。

```ts
    hasTranscript: r.has_transcript === 1,
    lock: locks.get(r.id) ?? null,
    remoteOnly: r.has_transcript === 1 && r.has_local === 0,
```

`listSessions` と `getSession` を次に替える。

```ts
export function listSessions(db: Db, live: LiveSessionDto[], opts: SessionQueryOptions = {}): SessionDto[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.projectId) {
    where.push('s.project_id = ?');
    args.push(opts.projectId);
  }
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    where.push(`s.id in (${opts.ids.map(() => '?').join(',')})`);
    args.push(...opts.ids);
  }
  const sql = `${SESSION_SELECT}${where.length ? ' and ' + where.join(' and ') : ''} order by s.last_activity_at desc nulls last, s.started_at desc nulls last, s.id`;
  const rows = db.prepare(sql).all(...args) as SessionRow[];
  const lm = liveMapOf(live);
  const locks = lockMap(db, opts.deviceId, opts.now ? opts.now() : Date.now());
  return rows.map((r) => toSessionDto(r, lm, locks));
}

export function getSession(db: Db, live: LiveSessionDto[], id: string, opts: { deviceId?: string; now?: () => number } = {}): SessionDto | null {
  const r = db.prepare(`${SESSION_SELECT} and s.id = ?`).get(id) as SessionRow | undefined;
  return r ? toSessionDto(r, liveMapOf(live), lockMap(db, opts.deviceId, opts.now ? opts.now() : Date.now())) : null;
}

/** Settings の端末一覧。最終確認の新しい順で、自端末に印を付ける。 */
export function listDevices(db: Db, selfId: string): DeviceDto[] {
  const rows = db.prepare('select id, name, platform, last_seen_at from devices where deleted_at is null order by last_seen_at desc nulls last, name').all() as { id: string; name: string; platform: string; last_seen_at: number | null }[];
  return rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform, lastSeenAt: r.last_seen_at, self: r.id === selfId }));
}
```

`getSession` を呼んでいる既存の箇所（`http/app.ts`、`server.ts`）は第 4 引数を渡さないままでも通る。Task 19 で自端末の ID を渡すように直す。

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/db && npx tsc -p packages/server`
Expected: PASS。`tsc` はここで通る（`SessionDto` の新しい項目が埋まる）。

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/db/queries.ts packages/server/src/db/queries.test.ts
git commit -m "feat(server): session lock from remote live runs, remoteOnly flag and device list"
```

---

### Task 16: 引き継ぎの状態機械と終了理由 taken_over（このフェーズでは実装しない）

> **このタスクはフェーズ 4 では実装しない。** 2026-09-19 の判断である。
> 理由は、2 台で使う実感が無いまま、同期の中でいちばん複雑な部分（握手、時間切れ、強制引き継ぎ、譲った記録）を作らないためである。
> 他端末で実行中のセッションは Task 15 の `lock` で「実行中」と見せ、手元で続けたいときは Task 17 の「この PC で再開」で本文を降ろして新しい run を立てる。
> 引き継ぎが無いと、他端末の run はそのまま走り続け、同じセッションの本文が 2 か所で伸びうる。
> その状態は Task 14 の「手元を優先して 1 つだけ索引化する」規則で見た目は壊れないが、本文が枝分かれすることは受け入れる。
> **中身は後のフェーズで拾えるように残してある。** 実装者はこのタスクを飛ばし、Task 17 へ進む。
> 拾うときに要るものは、`EndReason` への `taken_over` の追加、`RunManager.kill(runId, reason)` への引数の追加、`sync_state` の `yielded:<sessionUuid>`、`takeover_requests` への書き込み、UI の `takeover` オーバーレイである。
> どれもこのフェーズの計画からは外してあるので、拾うときはこのタスクの記述を起点に足し直す。

**Files:**
- Create: `packages/server/src/sync/takeover.ts`
- Modify: `packages/server/src/runs/manager.ts`
- Test: `packages/server/src/sync/takeover.test.ts`、`packages/server/src/runs/manager.test.ts`（追加）

**Interfaces:**
- Consumes: `TakeoverPhase`、`EndReason`（shared、Task 1）。
- Produces:
  ```ts
  export const ACK_TIMEOUT_MS = 90_000;
  export const IDLE_TIMEOUT_MS = 60_000;
  export type RequesterState = { phase: TakeoverPhase; requestId: string | null; runId: string; sessionId: string; force: boolean; since: number; message: string | null };
  export type RequesterInput = { kind: 'start'; now: number } | { kind: 'applied'; state: 'acked' | 'cancelled' | 'forced'; requestId: string } | { kind: 'tick'; now: number } | { kind: 'copied' } | { kind: 'resumed' } | { kind: 'failed'; message: string } | { kind: 'cancel' };
  export type RequesterAction = { kind: 'writeRequest'; state: 'requested' | 'forced' | 'cancelled' } | { kind: 'endRemoteRun' } | { kind: 'push' } | { kind: 'pullAndCopy' } | { kind: 'resume' } | { kind: 'notify' };
  export function requesterStep(s: RequesterState, input: RequesterInput, timeoutMs?: number): { state: RequesterState; actions: RequesterAction[] };
  export function isTakeoverDone(phase: TakeoverPhase): boolean;
  export type ResponderState = { phase: 'idle' | 'waitingIdle' | 'finalizing' | 'done'; requestId: string; runId: string; sessionUuid: string; since: number };
  export type ResponderInput = { kind: 'start'; now: number } | { kind: 'tick'; now: number; busy: boolean } | { kind: 'finalized' } | { kind: 'forced' };
  export type ResponderAction = { kind: 'finalize' } | { kind: 'kill'; reason: 'taken_over' } | { kind: 'ack' } | { kind: 'yield' } | { kind: 'push' };
  export function responderStep(s: ResponderState, input: ResponderInput, idleTimeoutMs?: number): { state: ResponderState; actions: ResponderAction[] };
  ```
- `RunManager.kill` の署名を `kill(runId: string, reason: EndReason = 'killed'): RunDto` にする。`RunsApi` は `Pick` なので自動で追う。
- 要求側の筋：`start` で `takeover_requests` に `requested` を書いて push する。1 秒ごとの `tick` で `waiting` に移り、90 秒で `timeout` になる。`acked` か `forced` を受けたら `copying` に移って本文を取りに行き、`copied` で再開し、`resumed` で終わる。強制引き継ぎは `start` の時点で `forced` を書き、相手の `runs` 行を閉じ、待たずに `copying` へ進む。
- 保持側の筋：`start` で `waitingIdle` に入り、`tick` が busy でなくなるか 60 秒が過ぎたら `finalize` を出す。`finalized` で run を閉じ、`acked` を書き、そのセッションを譲ったものとして記録し、push する。`forced` はいつ受けても run を閉じて譲った記録だけを残す（要求側が既に `runs` 行を閉じている）。
- 譲った記録を両方の筋で残すのは、引き継いだ後に本文の持ち主が入れ替わり、手元の古い写しを索引化し続けないためである。手元で再開したときに記録を消す（Task 17 と Task 19）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/sync/takeover.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ACK_TIMEOUT_MS, IDLE_TIMEOUT_MS, requesterStep, responderStep, type RequesterState, type ResponderState } from './takeover.ts';

const req = (over: Partial<RequesterState> = {}): RequesterState => ({ phase: 'requested', requestId: 'q1', runId: 'r1', sessionId: 's1', force: false, since: 1000, message: null, ...over });
const res = (over: Partial<ResponderState> = {}): ResponderState => ({ phase: 'idle', requestId: 'q1', runId: 'r1', sessionUuid: 'u1', since: 1000, ...over });

describe('requesterStep', () => {
  it('要求を書いて push し、tick で待ちに移る', () => {
    const a = requesterStep(req({ phase: 'requested' }), { kind: 'start', now: 1000 });
    expect(a.state).toMatchObject({ phase: 'requested', since: 1000 });
    expect(a.actions).toEqual([{ kind: 'writeRequest', state: 'requested' }, { kind: 'push' }, { kind: 'notify' }]);
    const b = requesterStep(a.state, { kind: 'tick', now: 1500 });
    expect(b.state.phase).toBe('waiting');
    expect(b.actions).toEqual([{ kind: 'notify' }]);
  });
  it('90 秒で時間切れになり、その後の tick では何も起きない', () => {
    const waiting = req({ phase: 'waiting', since: 1000 });
    expect(requesterStep(waiting, { kind: 'tick', now: 1000 + ACK_TIMEOUT_MS - 1 }).state.phase).toBe('waiting');
    const t = requesterStep(waiting, { kind: 'tick', now: 1000 + ACK_TIMEOUT_MS });
    expect(t.state.phase).toBe('timeout');
    expect(t.state.message).toContain('強制引き継ぎ');
    expect(requesterStep(t.state, { kind: 'tick', now: 999_999 }).actions).toEqual([]);
  });
  it('acked で本文を取りに行き、copied で再開し、resumed で終わる', () => {
    const w = req({ phase: 'waiting' });
    const a = requesterStep(w, { kind: 'applied', state: 'acked', requestId: 'q1' });
    expect(a.state.phase).toBe('copying');
    expect(a.actions).toEqual([{ kind: 'notify' }, { kind: 'pullAndCopy' }]);
    expect(requesterStep(a.state, { kind: 'copied' }).actions).toEqual([{ kind: 'resume' }]);
    expect(requesterStep(a.state, { kind: 'resumed' }).state.phase).toBe('resumed');
  });
  it('別の要求 ID と二重の acked は無視する', () => {
    const w = req({ phase: 'waiting' });
    expect(requesterStep(w, { kind: 'applied', state: 'acked', requestId: 'other' }).state.phase).toBe('waiting');
    const c = requesterStep(w, { kind: 'applied', state: 'acked', requestId: 'q1' }).state;
    expect(requesterStep(c, { kind: 'applied', state: 'acked', requestId: 'q1' }).actions).toEqual([]);
  });
  it('相手が断れば cancelled、こちらが取り消せば要求を書き換える', () => {
    const w = req({ phase: 'waiting' });
    expect(requesterStep(w, { kind: 'applied', state: 'cancelled', requestId: 'q1' }).state.phase).toBe('cancelled');
    const c = requesterStep(w, { kind: 'cancel' });
    expect(c.state.phase).toBe('cancelled');
    expect(c.actions).toEqual([{ kind: 'writeRequest', state: 'cancelled' }, { kind: 'push' }, { kind: 'notify' }]);
    expect(requesterStep(c.state, { kind: 'cancel' }).actions).toEqual([]);
  });
  it('強制引き継ぎは相手を待たずに相手の run を閉じて進む', () => {
    const f = requesterStep(req({ force: true }), { kind: 'start', now: 2000 });
    expect(f.state.phase).toBe('copying');
    expect(f.actions).toEqual([{ kind: 'writeRequest', state: 'forced' }, { kind: 'endRemoteRun' }, { kind: 'push' }, { kind: 'notify' }, { kind: 'pullAndCopy' }]);
  });
  it('失敗は failed で止まる', () => {
    const r = requesterStep(req({ phase: 'copying' }), { kind: 'failed', message: '本文が見つかりません' });
    expect(r.state).toMatchObject({ phase: 'failed', message: '本文が見つかりません' });
  });
});

describe('responderStep', () => {
  it('idle になるのを待ってから確定し、閉じて ack する', () => {
    const s = responderStep(res(), { kind: 'start', now: 5000 });
    expect(s.state).toMatchObject({ phase: 'waitingIdle', since: 5000 });
    expect(responderStep(s.state, { kind: 'tick', now: 6000, busy: true }).actions).toEqual([]);
    const f = responderStep(s.state, { kind: 'tick', now: 6000, busy: false });
    expect(f.state.phase).toBe('finalizing');
    expect(f.actions).toEqual([{ kind: 'finalize' }]);
    const d = responderStep(f.state, { kind: 'finalized' });
    expect(d.state.phase).toBe('done');
    expect(d.actions).toEqual([{ kind: 'kill', reason: 'taken_over' }, { kind: 'ack' }, { kind: 'yield' }, { kind: 'push' }]);
  });
  it('busy のままでも 60 秒で確定する', () => {
    const s = responderStep(res(), { kind: 'start', now: 5000 }).state;
    expect(responderStep(s, { kind: 'tick', now: 5000 + IDLE_TIMEOUT_MS - 1, busy: true }).actions).toEqual([]);
    expect(responderStep(s, { kind: 'tick', now: 5000 + IDLE_TIMEOUT_MS, busy: true }).actions).toEqual([{ kind: 'finalize' }]);
  });
  it('forced はいつでも run を閉じて譲った記録を残す', () => {
    const r = responderStep(res(), { kind: 'forced' });
    expect(r.state.phase).toBe('done');
    expect(r.actions).toEqual([{ kind: 'kill', reason: 'taken_over' }, { kind: 'yield' }, { kind: 'push' }]);
    expect(responderStep(r.state, { kind: 'forced' }).actions).toEqual([]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/sync/takeover`
Expected: FAIL（`./takeover.ts` が無い）

- [ ] **Step 3: 状態機械を実装する**

`packages/server/src/sync/takeover.ts`：

```ts
import type { TakeoverPhase } from '@agent-hangar/shared';

/** 要求側が acked を待つ上限。過ぎたら強制引き継ぎを提案する。 */
export const ACK_TIMEOUT_MS = 90_000;
/** 保持側が Claude の idle を待つ上限。過ぎたら busy のまま確定する。 */
export const IDLE_TIMEOUT_MS = 60_000;

export type RequesterState = { phase: TakeoverPhase; requestId: string | null; runId: string; sessionId: string; force: boolean; since: number; message: string | null };
export type RequesterInput =
  | { kind: 'start'; now: number }
  | { kind: 'applied'; state: 'acked' | 'cancelled' | 'forced'; requestId: string }
  | { kind: 'tick'; now: number }
  | { kind: 'copied' } | { kind: 'resumed' } | { kind: 'failed'; message: string } | { kind: 'cancel' };
export type RequesterAction =
  | { kind: 'writeRequest'; state: 'requested' | 'forced' | 'cancelled' }
  | { kind: 'endRemoteRun' } | { kind: 'push' } | { kind: 'pullAndCopy' } | { kind: 'resume' } | { kind: 'notify' };

const DONE_PHASES: readonly TakeoverPhase[] = ['resumed', 'timeout', 'failed', 'cancelled'];

export function isTakeoverDone(phase: TakeoverPhase): boolean { return DONE_PHASES.includes(phase); }

/**
 * 引き継ぎを求める側の状態機械。
 * 副作用は actions に出し、DB と HTTP には触らない。
 */
export function requesterStep(s: RequesterState, input: RequesterInput, timeoutMs = ACK_TIMEOUT_MS): { state: RequesterState; actions: RequesterAction[] } {
  const keep = { state: s, actions: [] as RequesterAction[] };
  switch (input.kind) {
    case 'start':
      if (s.force) {
        return {
          state: { ...s, phase: 'copying', since: input.now, message: '相手の応答を待たずに引き継ぎます' },
          actions: [{ kind: 'writeRequest', state: 'forced' }, { kind: 'endRemoteRun' }, { kind: 'push' }, { kind: 'notify' }, { kind: 'pullAndCopy' }],
        };
      }
      return { state: { ...s, phase: 'requested', since: input.now, message: null }, actions: [{ kind: 'writeRequest', state: 'requested' }, { kind: 'push' }, { kind: 'notify' }] };
    case 'tick':
      if (isTakeoverDone(s.phase)) return keep;
      if (s.phase === 'requested') return { state: { ...s, phase: 'waiting' }, actions: [{ kind: 'notify' }] };
      if (s.phase === 'waiting' && input.now - s.since >= timeoutMs) {
        return { state: { ...s, phase: 'timeout', message: '相手が応答しません。強制引き継ぎができます' }, actions: [{ kind: 'notify' }] };
      }
      return keep;
    case 'applied':
      if (input.requestId !== s.requestId) return keep;
      if (isTakeoverDone(s.phase) || s.phase === 'copying') return keep;
      if (input.state === 'cancelled') return { state: { ...s, phase: 'cancelled', message: '相手が引き継ぎを断りました' }, actions: [{ kind: 'notify' }] };
      return { state: { ...s, phase: 'copying', message: null }, actions: [{ kind: 'notify' }, { kind: 'pullAndCopy' }] };
    case 'copied':
      if (s.phase !== 'copying') return keep;
      return { state: s, actions: [{ kind: 'resume' }] };
    case 'resumed':
      if (isTakeoverDone(s.phase)) return keep;
      return { state: { ...s, phase: 'resumed', message: null }, actions: [{ kind: 'notify' }] };
    case 'failed':
      if (isTakeoverDone(s.phase)) return keep;
      return { state: { ...s, phase: 'failed', message: input.message }, actions: [{ kind: 'notify' }] };
    case 'cancel':
      if (isTakeoverDone(s.phase)) return keep;
      return { state: { ...s, phase: 'cancelled', message: null }, actions: [{ kind: 'writeRequest', state: 'cancelled' }, { kind: 'push' }, { kind: 'notify' }] };
  }
}

export type ResponderState = { phase: 'idle' | 'waitingIdle' | 'finalizing' | 'done'; requestId: string; runId: string; sessionUuid: string; since: number };
export type ResponderInput = { kind: 'start'; now: number } | { kind: 'tick'; now: number; busy: boolean } | { kind: 'finalized' } | { kind: 'forced' };
export type ResponderAction = { kind: 'finalize' } | { kind: 'kill'; reason: 'taken_over' } | { kind: 'ack' } | { kind: 'yield' } | { kind: 'push' };

/** 引き継ぎを求められた側の状態機械。idle を待ってから本文を確定し、run を閉じる。 */
export function responderStep(s: ResponderState, input: ResponderInput, idleTimeoutMs = IDLE_TIMEOUT_MS): { state: ResponderState; actions: ResponderAction[] } {
  const keep = { state: s, actions: [] as ResponderAction[] };
  switch (input.kind) {
    case 'start':
      if (s.phase !== 'idle') return keep;
      return { state: { ...s, phase: 'waitingIdle', since: input.now }, actions: [] };
    case 'tick':
      if (s.phase !== 'waitingIdle') return keep;
      if (input.busy && input.now - s.since < idleTimeoutMs) return keep;
      return { state: { ...s, phase: 'finalizing' }, actions: [{ kind: 'finalize' }] };
    case 'finalized':
      if (s.phase !== 'finalizing') return keep;
      return { state: { ...s, phase: 'done' }, actions: [{ kind: 'kill', reason: 'taken_over' }, { kind: 'ack' }, { kind: 'yield' }, { kind: 'push' }] };
    case 'forced':
      if (s.phase === 'done') return keep;
      return { state: { ...s, phase: 'done' }, actions: [{ kind: 'kill', reason: 'taken_over' }, { kind: 'yield' }, { kind: 'push' }] };
  }
}
```

- [ ] **Step 4: kill に終了理由を足す**

`packages/server/src/runs/manager.ts` の `kill` を次に替える。

```ts
  /** tmux を殺して run を閉じる。引き継ぎでは reason に taken_over を渡す。 */
  kill(runId: string, reason: EndReason = 'killed'): RunDto {
    const run = getRun(this.db, runId);
    if (!run) throw new RunError(404, 'run が見つかりません');
    if (run.endedAt !== null) throw new RunError(409, 'この run は終了しています');
    for (const t of listTabs(this.db, runId)) if (t.kind === 'shell') this.closeTab(t.id);
    this.deps.tmux?.killSession(run.tmuxName);
    return this.end(runId, reason) ?? run;
  }
```

`import type { EndReason } from '@agent-hangar/shared';` を先頭の型 import に足す（既にあれば足さない）。

`packages/server/src/runs/manager.test.ts` に足す（`make` と `cwd` と `db` は既存の describe と同じ補助を使う。名前が違えば Task 0 の記録に従って読み替える）。

```ts
  it('kill は終了理由を選べる', () => {
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd, home_device: 'd' }, 'd');
    upsertShared(db, 'runs', { id: 'r1', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-x', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'd');
    const rm = make({ tmux: null });
    expect(rm.kill('r1', 'taken_over')).toMatchObject({ endReason: 'taken_over', endedAt: expect.any(Number) });
  });
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/sync/takeover packages/server/src/runs && npx tsc -p packages/server`
Expected: PASS（takeover 9 件）

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/sync/takeover.ts packages/server/src/sync/takeover.test.ts packages/server/src/runs
git commit -m "feat(server): takeover handshake state machines and taken_over end reason"
```

---

### Task 17: この PC で再開のコピー

> **このタスクは Step 1 から Step 3 までを実装する。**
> Step 4 以降の「引き継ぎの結線」は、Task 16 と同じ理由でフェーズ 4 では実装しない（2026-09-19 の判断）。
> 後のフェーズで拾えるように記述は残してあるので、実装者は Step 3 の後に Step 7 の `copy` のテストだけを走らせ、Step 8 の `copy.ts` だけをコミットして Task 18 へ進む。

**Files:**
- Create: `packages/server/src/sync/copy.ts`
- Modify: `packages/server/src/sync/takeover.ts`（このフェーズでは触らない）
- Test: `packages/server/src/sync/copy.test.ts`、`packages/server/src/sync/takeover.test.ts`（このフェーズでは触らない）

**Interfaces:**
- Consumes: `RemotePuller`、`remoteTranscriptPath`、`mangleCwd`、`RunError`（`runs/manager.ts`）。Step 4 以降は `requesterStep`、`responderStep`、`isTakeoverDone`（Task 16）、`SyncEngine`、`TranscriptUploader`、`SyncStateStore`、`upsertShared`、`newId` も使うが、このフェーズでは使わない。
- Produces:
  ```ts
  // sync/copy.ts
  export type CopyResult =
    | { kind: 'copied'; target: string; from: string; bytes: number; backedUp: string | null }
    | { kind: 'kept'; target: string } | { kind: 'ask'; localSize: number; remoteSize: number } | { kind: 'none' };
  export function timestampLabel(ts: number): string;                 // yyyyMMdd-HHmmss
  export function copyTranscriptForResume(o: { db: Db; home: string; claudeDir: string; sessionId: string; overwrite: boolean; now?: () => number }): CopyResult;
  // sync/takeover.ts（追加）
  export type TakeoverDeps = {
    db: Db; deviceId: string;
    engine: { on(l: SyncListener): () => void; pushNow(): Promise<{ pushed: number }>; pullNow(): Promise<{ applied: number }> };
    puller: { pullNow(): Promise<{ downloaded: number; configEntries: number }> };
    runs: { resume(sessionId: string): LaunchResultDto; kill(runId: string, reason?: EndReason): RunDto };
    uploader: { flushSession(sessionUuid: string): Promise<void> };
    state: SyncStateStore; home: string; claudeDir: string;
    isBusy: (sessionUuid: string) => boolean;
    onUpdate: (u: TakeoverUpdateDto) => void;
    onToast: (level: 'info' | 'error', message: string) => void;
    now?: () => number; timers?: Timers; ackTimeoutMs?: number; idleTimeoutMs?: number;
  };
  export class TakeoverCoordinator {
    constructor(deps: TakeoverDeps);
    request(sessionId: string, force: boolean): { requestId: string };
    cancel(sessionId: string): void;
    current(sessionId: string): RequesterState | null;
    stop(): void;
  }
  export class TakeoverResponder { constructor(deps: TakeoverDeps); start(): void; stop(): void; }
  ```
- 「インターフェース一覧」の `TakeoverDeps` にあった `runs.listAlive` は使わないので落とし、`engine` と `puller` と `uploader` は必要なメソッドだけの構造型にする（テストが偽物を渡せるようにするため）。
- コピーの規則：手元に本文が無ければ写しをコピーする。手元にあってサイズが写し以上なら手元を使う（`kept`）。手元の方が小さく `overwrite` が false なら `ask` を返し、UI が確認を出す。`overwrite` が true のときは、上書きの前に `~/.agent-hangar/backups/transcripts/<uuid>-<時刻>.jsonl` に写す。コピー先は `~/.claude/projects/<sessions.cwd の変換名>/<uuid>.jsonl` で、`RunManager.resume` が起動する cwd と揃える。
- これは `~/.claude` への 2 つある書き込みのうちの 1 つで、利用者が押した「この PC で再開」と「引き継ぐ」からだけ呼ぶ。
- 強制引き継ぎの規則：`force` は相手の heartbeat が 2 分以上古いか、同じセッションの直前の要求が時間切れになった後にだけ受け付け、それ以外は 409 にする。

- [ ] **Step 1: コピーの失敗するテストを書く**

`packages/server/src/sync/copy.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { copyTranscriptForResume, timestampLabel } from './copy.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_700_000_000_000;
let db: Db;
let home: string;
let claudeDir: string;

const target = () => path.join(claudeDir, 'projects', '-w-alpha', `${UUID}.jsonl`);
const seedRemote = (device: string, text: string, mtime: number): string => {
  const rel = `projects/-w-alpha/${UUID}.jsonl`;
  const p = path.join(home, 'remote', device, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  fs.utimesSync(p, new Date(mtime), new Date(mtime));
  db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`transcripts/${device}/${UUID}.jsonl.gz`, 'transcript', rel, device, 'a'.repeat(64), Buffer.byteLength(text), mtime, 1, NOW);
  return p;
};
const copy = (overwrite = false) => copyTranscriptForResume({ db, home, claudeDir, sessionId: 's1', overwrite, now: () => NOW });

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-'));
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
});

describe('copyTranscriptForResume', () => {
  it('写しが無ければ none', () => {
    expect(copy()).toEqual({ kind: 'none' });
    expect(copyTranscriptForResume({ db, home, claudeDir, sessionId: 'nope', overwrite: false })).toEqual({ kind: 'none' });
  });
  it('手元に無ければ、更新時刻が最新の写しを cwd の変換名の下に置く', () => {
    seedRemote('dev-b', 'older\n', NOW - 10_000);
    const newer = seedRemote('dev-c', 'newer-body\n', NOW);
    const r = copy();
    expect(r).toEqual({ kind: 'copied', target: target(), from: newer, bytes: 11, backedUp: null });
    expect(fs.readFileSync(target(), 'utf8')).toBe('newer-body\n');
  });
  it('手元の方が大きいか同じなら手元を使う', () => {
    seedRemote('dev-b', 'abc\n', NOW);
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.writeFileSync(target(), 'abcdef\n');
    expect(copy()).toEqual({ kind: 'kept', target: target() });
    expect(fs.readFileSync(target(), 'utf8')).toBe('abcdef\n');
  });
  it('手元の方が小さければ ask を返し、overwrite でバックアップしてから置き換える', () => {
    seedRemote('dev-b', 'remote-longer\n', NOW);
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.writeFileSync(target(), 'short\n');
    expect(copy()).toEqual({ kind: 'ask', localSize: 6, remoteSize: 14 });
    const r = copy(true);
    expect(r.kind).toBe('copied');
    const backedUp = (r as { backedUp: string }).backedUp;
    expect(backedUp).toBe(path.join(home, 'backups', 'transcripts', `${UUID}-${timestampLabel(NOW)}.jsonl`));
    expect(fs.readFileSync(backedUp, 'utf8')).toBe('short\n');
    expect(fs.readFileSync(target(), 'utf8')).toBe('remote-longer\n');
  });
  it('timestampLabel は秒までの並べ替えできる文字列', () => {
    expect(timestampLabel(new Date(2026, 8, 18, 9, 5, 7).getTime())).toBe('20260918-090507');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/sync/copy`
Expected: FAIL（`./copy.ts` が無い）

- [ ] **Step 3: copy.ts を実装する**

`packages/server/src/sync/copy.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { backupsRoot } from '../config/cloud.ts';
import type { Db } from '../db/open.ts';
import { mangleCwd } from '../provider/claude-code/discover.ts';
import { remoteTranscriptPath } from './puller.ts';

export type CopyResult =
  | { kind: 'copied'; target: string; from: string; bytes: number; backedUp: string | null }
  | { kind: 'kept'; target: string }
  | { kind: 'ask'; localSize: number; remoteSize: number }
  | { kind: 'none' };

const pad = (n: number): string => String(n).padStart(2, '0');

/** バックアップと競合ファイルの名前に使う時刻。 */
export function timestampLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 手元に降ろした他端末の写しのうち、更新時刻が最新のもの。
 * 自端末の鍵の行は remote の下にファイルが無いので、存在の確認で自然に外れる。
 */
function latestRemoteCopy(db: Db, home: string, sessionUuid: string): { path: string; size: number } | null {
  const rows = db.prepare("select path, device_id from file_sync where kind = 'transcript' and key like ? order by mtime desc")
    .all(`transcripts/%/${sessionUuid}.jsonl.gz`) as { path: string; device_id: string }[];
  for (const r of rows) {
    let p: string;
    try { p = remoteTranscriptPath(home, r.device_id, r.path); } catch { continue; }
    if (!fs.existsSync(p)) continue;
    return { path: p, size: fs.statSync(p).size };
  }
  return null;
}

/**
 * 他端末の本文を ~/.claude にコピーして claude -r で再開できるようにする。
 * ~/.claude への書き込みはここと Claude Code 設定の取り込みだけで、どちらも利用者の明示の操作から呼ぶ。
 */
export function copyTranscriptForResume(o: { db: Db; home: string; claudeDir: string; sessionId: string; overwrite: boolean; now?: () => number }): CopyResult {
  const s = o.db.prepare('select provider_session_id, cwd from sessions where id = ? and deleted_at is null').get(o.sessionId) as { provider_session_id: string; cwd: string } | undefined;
  if (!s) return { kind: 'none' };
  const target = path.join(o.claudeDir, 'projects', mangleCwd(s.cwd), `${s.provider_session_id}.jsonl`);
  const best = latestRemoteCopy(o.db, o.home, s.provider_session_id);
  if (!best) return fs.existsSync(target) ? { kind: 'kept', target } : { kind: 'none' };
  const local = fs.existsSync(target) ? fs.statSync(target) : null;
  if (local && !o.overwrite) {
    if (local.size >= best.size) return { kind: 'kept', target };
    return { kind: 'ask', localSize: local.size, remoteSize: best.size };
  }
  let backedUp: string | null = null;
  if (local) {
    const now = o.now ? o.now() : Date.now();
    backedUp = path.join(backupsRoot(o.home), 'transcripts', `${s.provider_session_id}-${timestampLabel(now)}.jsonl`);
    fs.mkdirSync(path.dirname(backedUp), { recursive: true });
    fs.copyFileSync(target, backedUp);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(best.path, target);
  return { kind: 'copied', target, from: best.path, bytes: best.size, backedUp };
}
```

- [ ] **Step 4: 引き継ぎの結線の失敗するテストを書く（このフェーズでは飛ばす）**

> ここから Step 6 までは Task 16 と対になる引き継ぎの結線である。
> フェーズ 4 では実装しない。記述は後のフェーズのために残す。

`packages/server/src/sync/takeover.test.ts` に足す。

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach } from 'vitest';
import type { LaunchResultDto, RunDto, TakeoverUpdateDto } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers, flush } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { SyncEngine } from './engine.ts';
import { SyncStateStore } from './state.ts';
import { TakeoverCoordinator, TakeoverResponder } from './takeover.ts';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('引き継ぎの結線', () => {
  let timers: FakeTimers;
  let cloudA: FakeCloudClient;
  let dbA: Db; let dbB: Db;
  let engineA: SyncEngine; let engineB: SyncEngine;
  let homeA: string; let claudeA: string;
  let updates: TakeoverUpdateDto[];
  let toastsB: string[];
  let resumed: string[];
  let killed: { runId: string; reason?: string }[];
  let flushed: string[];
  let busy = false;

  const runRow = (o: { heartbeat: number; ended?: number | null }) => ({ id: 'r1', session_id: 's1', device_id: 'dev-b', kind: 'start', tmux_name: 'hangar-r1', pid: null, launch_params: '{}', started_at: 1, ended_at: o.ended ?? null, end_reason: null, heartbeat_at: o.heartbeat });
  const fakeRun: RunDto = { id: 'r1', sessionId: 's1', deviceId: 'dev-b', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: 2, endReason: 'taken_over', heartbeatAt: 1 };
  const launch: LaunchResultDto = { run: { ...fakeRun, deviceId: 'dev-a', endedAt: null, endReason: null }, sessionId: 's1', tabs: [] };

  const depsFor = (db: Db, deviceId: string, engine: SyncEngine, home: string, claudeDir: string) => ({
    db, deviceId, engine,
    puller: { pullNow: async () => ({ downloaded: 0, configEntries: 0 }) },
    runs: {
      resume: (id: string) => { resumed.push(id); return launch; },
      kill: (runId: string, reason?: string) => { killed.push({ runId, reason }); upsertShared(db, 'runs', { ...(db.prepare('select * from runs where id = ?').get(runId) as Record<string, unknown>), ended_at: timers.now, end_reason: 'taken_over' }, deviceId); return fakeRun; },
    },
    uploader: { flushSession: async (u: string) => { flushed.push(u); } },
    state: new SyncStateStore(db), home, claudeDir,
    isBusy: () => busy,
    onUpdate: (u: TakeoverUpdateDto) => updates.push(u),
    onToast: (_l: 'info' | 'error', m: string) => toastsB.push(m),
    now: () => timers.now, timers,
  });

  const seedCopy = (text: string) => {
    const rel = `projects/-w-alpha/${UUID}.jsonl`;
    const p = path.join(homeA, 'remote', 'dev-b', ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    dbA.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
      .run(`transcripts/dev-b/${UUID}.jsonl.gz`, 'transcript', rel, 'dev-b', 'a'.repeat(64), Buffer.byteLength(text), timers.now, 1, timers.now);
  };

  beforeEach(async () => {
    timers = new FakeTimers();
    cloudA = new FakeCloudClient({ deviceId: 'dev-a' });
    dbA = openDb(':memory:'); dbB = openDb(':memory:');
    homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-a-'));
    claudeA = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ca-'));
    updates = []; toastsB = []; resumed = []; killed = []; flushed = []; busy = false;
    engineA = new SyncEngine({ db: dbA, deviceId: 'dev-a', client: cloudA, now: () => timers.now, timers, url: 'https://h' });
    engineB = new SyncEngine({ db: dbB, deviceId: 'dev-b', client: cloudA.asDevice('dev-b'), now: () => timers.now, timers, url: 'https://h' });
    upsertShared(dbB, 'devices', { id: 'dev-b', name: 'mini', platform: 'darwin', last_seen_at: timers.now }, 'dev-b');
    upsertShared(dbB, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
    upsertShared(dbB, 'runs', runRow({ heartbeat: timers.now }), 'dev-b');
    await engineB.start();
    await engineA.start();
  });

  it('要求から acked を経て本文をコピーし、再開まで進む', async () => {
    seedCopy('body\n');
    const co = new TakeoverCoordinator(depsFor(dbA, 'dev-a', engineA, homeA, claudeA));
    const re = new TakeoverResponder(depsFor(dbB, 'dev-b', engineB, '/unused', '/unused'));
    re.start();
    const { requestId } = co.request('s1', false);
    expect(updates.at(-1)).toMatchObject({ sessionId: 's1', requestId, phase: 'requested', force: false });
    await flush();
    await engineB.pullNow();
    await timers.advance(1000);
    expect(flushed).toEqual([UUID]);
    expect(killed).toEqual([{ runId: 'r1', reason: 'taken_over' }]);
    expect(new SyncStateStore(dbB).isYielded(UUID)).toBe(true);
    await flush();
    await engineA.pullNow();
    await flush();
    expect(updates.at(-1)).toMatchObject({ phase: 'resumed' });
    expect(resumed).toEqual(['s1']);
    expect(fs.readFileSync(path.join(claudeA, 'projects', '-w-alpha', `${UUID}.jsonl`), 'utf8')).toBe('body\n');
    expect(new SyncStateStore(dbA).isYielded(UUID)).toBe(false);
    co.stop(); re.stop();
  });
  it('90 秒で時間切れになり、その後の強制引き継ぎが通る', async () => {
    seedCopy('body\n');
    const co = new TakeoverCoordinator(depsFor(dbA, 'dev-a', engineA, homeA, claudeA));
    co.request('s1', false);
    expect(() => co.request('s1', true)).toThrow(/強制引き継ぎ/);
    await timers.advance(91_000);
    expect(co.current('s1')?.phase).toBe('timeout');
    co.request('s1', true);
    await flush();
    expect(co.current('s1')?.phase).toBe('resumed');
    const row = dbA.prepare('select ended_at, end_reason from runs where id = ?').get('r1') as { ended_at: number | null; end_reason: string | null };
    expect(row).toMatchObject({ end_reason: 'taken_over' });
    expect(row.ended_at).not.toBeNull();
    co.stop();
  });
  it('heartbeat が古ければ最初から強制引き継ぎでき、戻ってきた相手は自分の run を閉じて譲る', async () => {
    seedCopy('body\n');
    timers.now += 300_000;
    const co = new TakeoverCoordinator(depsFor(dbA, 'dev-a', engineA, homeA, claudeA));
    co.request('s1', true);
    await flush();
    expect(co.current('s1')?.phase).toBe('resumed');
    const re = new TakeoverResponder(depsFor(dbB, 'dev-b', engineB, '/unused', '/unused'));
    await engineB.pullNow();
    re.start();
    await flush();
    expect(new SyncStateStore(dbB).isYielded(UUID)).toBe(true);
    expect(toastsB.some((t) => t.includes('引き継'))).toBe(true);
    co.stop(); re.stop();
  });
  it('要求の取り消しは相手に伝わり、相手は run を閉じない', async () => {
    const co = new TakeoverCoordinator(depsFor(dbA, 'dev-a', engineA, homeA, claudeA));
    const re = new TakeoverResponder(depsFor(dbB, 'dev-b', engineB, '/unused', '/unused'));
    re.start();
    co.request('s1', false);
    co.cancel('s1');
    await flush();
    await engineB.pullNow();
    await timers.advance(2000);
    expect(killed).toEqual([]);
    expect(co.current('s1')?.phase).toBe('cancelled');
    co.stop(); re.stop();
  });
  it('他端末で実行中でなければ 409', () => {
    const co = new TakeoverCoordinator(depsFor(dbA, 'dev-a', engineA, homeA, claudeA));
    upsertShared(dbA, 'runs', { ...(dbA.prepare('select * from runs where id = ?').get('r1') as Record<string, unknown>), ended_at: timers.now, end_reason: 'exited' }, 'dev-a');
    expect(() => co.request('s1', false)).toThrow(expect.objectContaining({ status: 409 }));
    co.stop();
  });
});
```

- [ ] **Step 5: 失敗を確かめる**

Run: `npx vitest run packages/server/src/sync/takeover`
Expected: FAIL（`TakeoverCoordinator` が無い）

- [ ] **Step 6: 結線を実装する**

`packages/server/src/sync/takeover.ts` に足す。

```ts
import { newId, type ChangeOut, type EndReason, type LaunchResultDto, type RunDto, type TakeoverUpdateDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { LOCK_STALE_MS } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { RunError } from '../runs/manager.ts';
import { copyTranscriptForResume } from './copy.ts';
import type { SyncListener, Timers } from './engine.ts';
import type { SyncStateStore } from './state.ts';

export type TakeoverDeps = {
  db: Db; deviceId: string;
  engine: { on(l: SyncListener): () => void; pushNow(): Promise<{ pushed: number }>; pullNow(): Promise<{ applied: number }> };
  puller: { pullNow(): Promise<{ downloaded: number; configEntries: number }> };
  runs: { resume(sessionId: string): LaunchResultDto; kill(runId: string, reason?: EndReason): RunDto };
  uploader: { flushSession(sessionUuid: string): Promise<void> };
  state: SyncStateStore; home: string; claudeDir: string;
  isBusy: (sessionUuid: string) => boolean;
  onUpdate: (u: TakeoverUpdateDto) => void;
  onToast: (level: 'info' | 'error', message: string) => void;
  now?: () => number; timers?: Timers; ackTimeoutMs?: number; idleTimeoutMs?: number;
};

const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };
const TICK_MS = 1000;
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type AliveRun = { runId: string; deviceId: string; heartbeatAt: number; stale: boolean };

/** そのセッションで他端末が動かしている run。ロックの判定と同じ条件で引く。 */
function remoteAliveRun(db: Db, sessionId: string, selfDeviceId: string, now: number): AliveRun | null {
  const r = db.prepare('select id, device_id, heartbeat_at from runs where session_id = ? and device_id <> ? and ended_at is null and deleted_at is null order by heartbeat_at desc limit 1')
    .get(sessionId, selfDeviceId) as { id: string; device_id: string; heartbeat_at: number } | undefined;
  if (!r) return null;
  return { runId: r.id, deviceId: r.device_id, heartbeatAt: r.heartbeat_at, stale: now - r.heartbeat_at > LOCK_STALE_MS };
}

const providerUuid = (db: Db, sessionId: string): string | null =>
  (db.prepare('select provider_session_id p from sessions where id = ?').get(sessionId) as { p: string } | undefined)?.p ?? null;

/** takeover_requests の 1 行を、状態だけ変えて書き直す。 */
function writeRequestRow(db: Db, deviceId: string, o: { id: string; runId: string; requestedAt: number; state: 'requested' | 'acked' | 'forced' | 'cancelled' }): void {
  const prev = db.prepare('select * from takeover_requests where id = ?').get(o.id) as Record<string, unknown> | undefined;
  upsertShared(db, 'takeover_requests', { ...(prev ?? { run_id: o.runId, from_device: deviceId, requested_at: o.requestedAt }), id: o.id, state: o.state }, deviceId);
}

/** 引き継ぎを求める側。UI の「引き継ぐ」から呼ばれ、握手が終わるまで 1 秒ごとに進める。 */
export class TakeoverCoordinator {
  private readonly states = new Map<string, RequesterState>();
  private timer: NodeJS.Timeout | null = null;
  private readonly offApplied: () => void;

  constructor(private readonly deps: TakeoverDeps) {
    this.offApplied = deps.engine.on({ applied: (c) => this.onApplied(c) });
  }

  private get timers(): Timers { return this.deps.timers ?? REAL_TIMERS; }
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  current(sessionId: string): RequesterState | null { return this.states.get(sessionId) ?? null; }

  request(sessionId: string, force: boolean): { requestId: string } {
    const lock = remoteAliveRun(this.deps.db, sessionId, this.deps.deviceId, this.now());
    if (!lock) throw new RunError(409, 'このセッションは他の端末で実行中ではありません');
    const cur = this.states.get(sessionId);
    if (force && !lock.stale && cur?.phase !== 'timeout') {
      throw new RunError(409, '強制引き継ぎは、相手の heartbeat が 2 分以上古いか、要求が時間切れになった後にだけできます');
    }
    if (!force && cur && !isTakeoverDone(cur.phase)) return { requestId: cur.requestId! };
    const requestId = newId();
    const s0: RequesterState = { phase: 'requested', requestId, runId: lock.runId, sessionId, force, since: this.now(), message: null };
    this.apply(sessionId, s0, { kind: 'start', now: this.now() });
    this.ensureTimer();
    return { requestId };
  }

  cancel(sessionId: string): void { this.step(sessionId, { kind: 'cancel' }); }

  stop(): void {
    this.offApplied();
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.states.clear();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = this.timers.setInterval(() => this.tick(), TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private tick(): void {
    for (const [sessionId, s] of [...this.states]) if (!isTakeoverDone(s.phase)) this.apply(sessionId, s, { kind: 'tick', now: this.now() });
    if ([...this.states.values()].every((s) => isTakeoverDone(s.phase)) && this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private step(sessionId: string, input: RequesterInput): void {
    const s = this.states.get(sessionId);
    if (s) this.apply(sessionId, s, input);
  }

  private apply(sessionId: string, from: RequesterState, input: RequesterInput): void {
    const { state, actions } = requesterStep(from, input, this.deps.ackTimeoutMs);
    this.states.set(sessionId, state);
    for (const a of actions) this.perform(state, a);
  }

  private onApplied(c: ChangeOut): void {
    if (c.tableName !== 'takeover_requests') return;
    const st = (c.payload as { state?: string }).state;
    if (st !== 'acked' && st !== 'cancelled' && st !== 'forced') return;
    for (const [sessionId, s] of this.states) {
      if (s.requestId === c.rowId) { this.apply(sessionId, s, { kind: 'applied', state: st, requestId: c.rowId }); return; }
    }
  }

  private perform(s: RequesterState, a: RequesterAction): void {
    switch (a.kind) {
      case 'writeRequest':
        writeRequestRow(this.deps.db, this.deps.deviceId, { id: s.requestId!, runId: s.runId, requestedAt: s.since, state: a.state });
        return;
      case 'endRemoteRun': {
        // 強制引き継ぎでは相手が止まっているので、こちらから run を閉じて push する。
        const row = this.deps.db.prepare('select * from runs where id = ?').get(s.runId) as Record<string, unknown> | undefined;
        if (row && row.ended_at === null) upsertShared(this.deps.db, 'runs', { ...row, ended_at: this.now(), end_reason: 'taken_over' }, this.deps.deviceId);
        return;
      }
      case 'push': void this.deps.engine.pushNow(); return;
      case 'pullAndCopy': void this.copy(s.sessionId); return;
      case 'resume': this.resume(s.sessionId); return;
      case 'notify': this.deps.onUpdate({ sessionId: s.sessionId, requestId: s.requestId, phase: s.phase, force: s.force, message: s.message, elapsedMs: this.now() - s.since }); return;
    }
  }

  private async copy(sessionId: string): Promise<void> {
    try {
      await this.deps.engine.pullNow();
      await this.deps.puller.pullNow();
      const r = copyTranscriptForResume({ db: this.deps.db, home: this.deps.home, claudeDir: this.deps.claudeDir, sessionId, overwrite: true, now: () => this.now() });
      if (r.kind === 'none') throw new Error('他の端末の本文が見つかりません');
      const uuid = providerUuid(this.deps.db, sessionId);
      // 引き継いだ側が新しい持ち主になるので、譲った記録があれば消す。
      if (uuid) this.deps.state.setYielded(uuid, false);
      this.step(sessionId, { kind: 'copied' });
    } catch (e) {
      this.step(sessionId, { kind: 'failed', message: errorMessage(e) });
    }
  }

  private resume(sessionId: string): void {
    try {
      this.deps.runs.resume(sessionId);
      this.deps.onToast('info', 'このパソコンで再開しました');
      this.step(sessionId, { kind: 'resumed' });
    } catch (e) {
      this.step(sessionId, { kind: 'failed', message: errorMessage(e) });
    }
  }
}

type RequestRow = { id: string; run_id: string; state: string; requested_at: number };

/** 引き継ぎを求められた側。自分の run に対する要求を見つけ、idle を待ってから譲る。 */
export class TakeoverResponder {
  private readonly states = new Map<string, ResponderState>();
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly deps: TakeoverDeps) {}

  private get timers(): Timers { return this.deps.timers ?? REAL_TIMERS; }
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  start(): void {
    if (this.off) return;
    this.off = this.deps.engine.on({ applied: (c) => { if (c.tableName === 'takeover_requests') this.consider(c.rowId); } });
    // 起動時に、寝ている間に届いた要求（forced を含む）を拾う。
    for (const r of this.deps.db.prepare("select id from takeover_requests where deleted_at is null and state in ('requested','forced')").all() as { id: string }[]) this.consider(r.id);
    this.timer = this.timers.setInterval(() => this.tick(), TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.off?.();
    this.off = null;
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.states.clear();
  }

  private consider(requestId: string): void {
    const row = this.deps.db.prepare('select id, run_id, state, requested_at from takeover_requests where id = ? and deleted_at is null').get(requestId) as RequestRow | undefined;
    if (!row) return;
    if (row.state === 'cancelled' || row.state === 'acked') { this.states.delete(requestId); return; }
    const run = this.deps.db.prepare('select r.id, r.device_id, r.ended_at, s.provider_session_id from runs r join sessions s on s.id = r.session_id where r.id = ?')
      .get(row.run_id) as { id: string; device_id: string; ended_at: number | null; provider_session_id: string } | undefined;
    if (!run || run.device_id !== this.deps.deviceId) return;
    const cur = this.states.get(requestId) ?? { phase: 'idle' as const, requestId, runId: run.id, sessionUuid: run.provider_session_id, since: this.now() };
    if (cur.phase === 'done') return;
    if (row.state === 'forced') { this.apply(requestId, cur, { kind: 'forced' }); return; }
    if (run.ended_at !== null) return;
    if (cur.phase !== 'idle') return;
    this.deps.onToast('info', '他の端末から引き継ぎを求められました。区切りがついたらこのセッションを閉じます');
    this.apply(requestId, cur, { kind: 'start', now: this.now() });
  }

  private tick(): void {
    for (const [id, s] of [...this.states]) {
      if (s.phase === 'waitingIdle') this.apply(id, s, { kind: 'tick', now: this.now(), busy: this.deps.isBusy(s.sessionUuid) });
    }
  }

  private apply(requestId: string, from: ResponderState, input: ResponderInput): void {
    const { state, actions } = responderStep(from, input, this.deps.idleTimeoutMs);
    this.states.set(requestId, state);
    for (const a of actions) this.perform(state, a);
  }

  private perform(s: ResponderState, a: ResponderAction): void {
    switch (a.kind) {
      case 'finalize':
        void (async () => {
          try { await this.deps.uploader.flushSession(s.sessionUuid); }
          catch (e) { this.deps.onToast('error', `本文の確定に失敗しました: ${errorMessage(e)}`); }
          this.apply(s.requestId, this.states.get(s.requestId) ?? s, { kind: 'finalized' });
        })();
        return;
      case 'kill':
        try { this.deps.runs.kill(s.runId, a.reason); }
        catch { /* 既に終わっている run は閉じ直さない。 */ }
        return;
      case 'ack': {
        const row = this.deps.db.prepare('select requested_at from takeover_requests where id = ?').get(s.requestId) as { requested_at: number } | undefined;
        writeRequestRow(this.deps.db, this.deps.deviceId, { id: s.requestId, runId: s.runId, requestedAt: row?.requested_at ?? this.now(), state: 'acked' });
        this.deps.onToast('info', 'このセッションを他の端末に引き継ぎました');
        return;
      }
      case 'yield':
        this.deps.state.setYielded(s.sessionUuid, true);
        return;
      case 'push':
        void this.deps.engine.pushNow();
        return;
    }
  }
}
```

- [ ] **Step 7: テストと型検査**

Run: `npx vitest run packages/server/src/sync && npx tsc -p packages/server`
Expected: PASS（copy 5 件。takeover の 14 件はこのフェーズでは書かない）

- [ ] **Step 8: コミット**

```bash
git add packages/server/src/sync/copy.ts packages/server/src/sync/copy.test.ts
git commit -m "feat(server): copy remote transcripts down for resume on this machine"
```

---

### Task 18: Claude Code の設定の同期

**Files:**
- Create: `packages/server/src/sync/claudeConfig.ts`
- Test: `packages/server/src/sync/claudeConfig.test.ts`

**Interfaces:**
- Consumes: `configKey`、`FileEntry`、`FileMetaIn`（shared）、`CloudClient`、`encryptStream`、`decryptStream`、`sha256Hex`、`SyncStateStore`、`backupsRoot`、`timestampLabel`（`sync/copy.ts`）。
- Produces:
  ```ts
  export const HOME_MARKER = '__HANGAR_HOME__';
  export const CONFIG_MAX_BYTES = 1 << 20;
  export type ConfigFile = { rel: string; abs: string; size: number; mtime: number };
  export function listConfigFiles(claudeDir: string): ConfigFile[];
  export function isConfigPath(rel: string): boolean;
  export function normalizeHome(text: string, home: string): string;
  export function denormalizeHome(text: string, home: string): string;
  export function isTextBuffer(buf: Buffer): boolean;
  /** 上書きの前に控えを取る。既存ファイルが無ければ何もせず null を返す。写せなければ throw する。 */
  export function backupBeforeWrite(o: { home: string; claudeDir: string; rel: string; stamp: string }): string | null;
  export type ClaudeConfigDeps = { db: Db; deviceId: string; deviceName: string; claudeDir: string; home: string; client: CloudClient; key: Buffer; state: SyncStateStore; enabled: () => boolean; onToast: (level: 'info' | 'error', message: string) => void; now?: () => number; debounceMs?: number; timers?: Timers; homeDir?: string };
  export class ClaudeConfigSync {
    constructor(deps: ClaudeConfigDeps);
    start(): void; stop(): void;
    pushChanged(): Promise<number>;
    preview(entries?: FileEntry[]): ConfigPreviewDto;
    applyPull(entries: FileEntry[]): Promise<{ applied: number; conflicts: number; backedUp: number }>;
    confirm(): void;
    pendingRemote(): FileEntry[];
  }
  ```
- 対象は `CLAUDE.md`、`settings.json`、`settings.json` の `statusLine.command` が指す `~/.claude` 配下のスクリプト、`skills/**`、`memory/**`、`projects/*/memory/**`。`node_modules`、`.git`、`__pycache__`、`.venv`、シンボリックリンク、1MB を超えるファイルは外す。削除は同期しない。
- push は `Settings.syncClaudeConfig`（`enabled()`）が true のときだけ動き、変化の 5 秒後にまとめて上げる。UTF-8 として読めるファイルはホームの絶対パスを `__HANGAR_HOME__` に置き換えてから上げる。SHA-256 は置き換えた後の内容で取るので、ホームの違う端末でも同じ値になる。
- pull は `enabled()` に加えて `confirm()`（`sync_state` の `configPullConfirmed`）が要る。確認の前でも `applyPull` は受け取った一覧を覚えるので、Settings の「取り込み内容を確認」が乾いた一覧を出せる。
- **控えは必須である。** 既存のファイルを上書きする前に、必ず `~/.agent-hangar/backups/claude-config/<yyyyMMdd-HHmmss>/<相対パス>` へ写す。1 回の `applyPull` は 1 つのタイムスタンプのディレクトリを使い、その回に何を書き換えたかがひとまとまりで残るようにする。
- 控えの書き込みに失敗したファイルは、**その回では書き戻さない**。`onToast('error', ...)` で知らせ、次の pull に回す。控えが取れないまま `~/.claude` を上書きする経路は作らない。
- これは利用者が確認した危険（一度「取り込む」を押すと、以後は 30 秒ごとの pull で無確認に上書きされる）への答えである。無確認の上書きそのものは許すが、**書き換えた内容は必ず復元できる形で残す**。`applyPull` は控えを取った件数を `backedUp` として返し、Settings のトーストに出す。
- 競合（手元も相手も前回の同期から変わっている）は、更新時刻の新しい方を本来のパスに置き、古い方を `<名前>.conflict-<端末名>-<時刻>` として隣に置き、トーストで知らせる。競合でも控えは取る。
- これは `~/.claude` への 2 つある書き込みのうちの 1 つで、利用者が Settings で明示的に有効にして確認したときだけ動く。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/sync/claudeConfig.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileEntry, FileMetaIn } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ClaudeConfigSync, denormalizeHome, HOME_MARKER, isConfigPath, isTextBuffer, listConfigFiles, normalizeHome } from './claudeConfig.ts';
import { timestampLabel } from './copy.ts';
import { encryptBuffer, decryptBuffer, deriveFileKey, sha256Hex } from './crypto.ts';
import { SyncStateStore } from './state.ts';

const key = deriveFileKey('join-secret');
const NOW = 1_700_000_000_000;
const STAMP = timestampLabel(NOW);
let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let claudeDir: string;
let home: string;
let state: SyncStateStore;
let enabled = true;
const toasts: { level: string; message: string }[] = [];

const HOME_DIR = '/Users/me';
const write = (rel: string, text: string, mtime = NOW) => {
  const abs = path.join(claudeDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  fs.utimesSync(abs, new Date(mtime), new Date(mtime));
  return abs;
};
const make = () => new ClaudeConfigSync({ db, deviceId: 'dev-a', deviceName: 'mac', claudeDir, home, client: cloud, key, state, enabled: () => enabled, onToast: (l, m) => toasts.push({ level: l, message: m }), now: () => NOW, timers, homeDir: HOME_DIR });
const remotePut = async (rel: string, text: string, o: { device?: string; mtime?: number } = {}): Promise<FileEntry> => {
  const meta: FileMetaIn = { key: `config/${rel}`, path: rel, kind: 'config', sha256: sha256Hex(text), size: Buffer.byteLength(text), mtime: o.mtime ?? NOW, encrypted: true };
  const enc = await encryptBuffer(key, gzipSync(Buffer.from(text)));
  const dev = o.device ?? 'dev-b';
  await cloud.asDevice(dev).putFile(meta, Readable.from([enc]));
  return { ...meta, seq: cloud.files.get(meta.key)!.entry.seq, deviceId: dev, uploadedAt: NOW, storedSize: enc.length };
};
const plainUploaded = async (k: string) => gunzipSync(await decryptBuffer(key, cloud.files.get(k)!.body)).toString();

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'dev-a' });
  timers = new FakeTimers();
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  state = new SyncStateStore(db);
  enabled = true;
  toasts.length = 0;
  upsertShared(db, 'devices', { id: 'dev-b', name: 'mini', platform: 'darwin', last_seen_at: NOW }, 'dev-b');
});

describe('listConfigFiles', () => {
  it('対象だけを集め、除外するものを外す', () => {
    write('CLAUDE.md', '# hi\n');
    write('settings.json', JSON.stringify({ statusLine: { command: '~/.claude/statusline.sh' } }));
    write('statusline.sh', 'echo hi\n');
    write('skills/foo/SKILL.md', 'skill\n');
    write('skills/foo/node_modules/dep/index.js', 'x\n');
    write('memory/alpha/notes.md', 'memo\n');
    write('projects/-w-alpha/memory/auto.md', 'auto\n');
    write('projects/-w-alpha/1111.jsonl', '{}\n');
    write('history.jsonl', '{}\n');
    write('skills/big.txt', 'x'.repeat(1024 * 1024 + 1));
    fs.symlinkSync(path.join(claudeDir, 'CLAUDE.md'), path.join(claudeDir, 'skills', 'link.md'));
    expect(listConfigFiles(claudeDir).map((f) => f.rel)).toEqual([
      'CLAUDE.md', 'memory/alpha/notes.md', 'projects/-w-alpha/memory/auto.md', 'settings.json', 'skills/foo/SKILL.md', 'statusline.sh',
    ]);
  });
  it('isConfigPath は監視の絞り込みに使える', () => {
    expect(['CLAUDE.md', 'settings.json', 'skills/a/b.md', 'memory/x.md', 'projects/-w-a/memory/x.md'].every(isConfigPath)).toBe(true);
    expect(['projects/-w-a/1111.jsonl', 'history.jsonl', 'todos/x.json'].some(isConfigPath)).toBe(false);
  });
});

describe('ホームの書き換え', () => {
  it('絶対パスだけを目印に置き換え、$HOME の文字列には触らない', () => {
    const text = 'cmd /Users/me/.claude/x.sh\nalt $HOME/.claude/x.sh\n';
    const n = normalizeHome(text, HOME_DIR);
    expect(n).toBe(`cmd ${HOME_MARKER}/.claude/x.sh\nalt $HOME/.claude/x.sh\n`);
    expect(denormalizeHome(n, '/home/you')).toBe('cmd /home/you/.claude/x.sh\nalt $HOME/.claude/x.sh\n');
    expect(denormalizeHome(n, HOME_DIR)).toBe(text);
  });
  it('isTextBuffer は NUL を含むものを弾く', () => {
    expect(isTextBuffer(Buffer.from('こんにちは\n'))).toBe(true);
    expect(isTextBuffer(Buffer.from([0x50, 0x00, 0x51]))).toBe(false);
  });
});

describe('push', () => {
  it('ホームを目印に替えて上げ、変わらなければ上げ直さない', async () => {
    write('CLAUDE.md', `see /Users/me/workspace\n`);
    const c = make();
    expect(await c.pushChanged()).toBe(1);
    expect(await plainUploaded('config/CLAUDE.md')).toBe(`see ${HOME_MARKER}/workspace\n`);
    expect(cloud.files.get('config/CLAUDE.md')!.entry).toMatchObject({ kind: 'config', path: 'CLAUDE.md', sha256: sha256Hex(`see ${HOME_MARKER}/workspace\n`) });
    expect(await c.pushChanged()).toBe(0);
    write('CLAUDE.md', `see /Users/me/workspace/alpha\n`);
    expect(await c.pushChanged()).toBe(1);
    c.stop();
  });
  it('設定が無効なら何もしない', async () => {
    write('CLAUDE.md', 'x\n');
    enabled = false;
    const c = make();
    expect(await c.pushChanged()).toBe(0);
    expect(cloud.files.size).toBe(0);
    c.stop();
  });
});

describe('preview と applyPull', () => {
  it('取り込み内容を作成、上書き、競合、変更なしに分ける', async () => {
    const e1 = await remotePut('CLAUDE.md', '# remote\n');
    const e2 = await remotePut('skills/foo/SKILL.md', 'remote skill\n');
    const e3 = await remotePut('memory/same.md', 'same\n');
    const e4 = await remotePut('memory/synced.md', 'remote new\n');
    write('skills/foo/SKILL.md', 'local edit\n');
    write('memory/same.md', 'same\n');
    write('memory/synced.md', 'old\n');
    db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
      .run('config/memory/synced.md', 'config', 'memory/synced.md', 'dev-b', sha256Hex('old\n'), 4, NOW, 1, NOW);
    const c = make();
    const p = c.preview([e1, e2, e3, e4]);
    expect(p.confirmed).toBe(false);
    expect(p.entries.map((x) => [x.path, x.action])).toEqual([
      ['CLAUDE.md', 'create'], ['memory/same.md', 'skip'], ['memory/synced.md', 'overwrite'], ['skills/foo/SKILL.md', 'conflict'],
    ]);
    expect(p.entries[0]).toMatchObject({ remoteDevice: 'mini', remoteMtime: NOW, localMtime: null });
    c.stop();
  });
  it('確認の前は書かず、確認の後に書いて控えを残す', async () => {
    const e = await remotePut('CLAUDE.md', `# from ${HOME_MARKER}/work\n`);
    write('CLAUDE.md', '# local\n', NOW - 10_000);
    db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
      .run('config/CLAUDE.md', 'config', 'CLAUDE.md', 'dev-b', sha256Hex('# local\n'), 8, NOW - 10_000, 1, NOW);
    const c = make();
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# local\n');
    expect(c.pendingRemote().map((x) => x.key)).toEqual(['config/CLAUDE.md']);
    c.confirm();
    expect(c.preview().confirmed).toBe(true);
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 0, backedUp: 1 });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe(`# from ${HOME_DIR}/work\n`);
    expect(fs.readdirSync(path.join(home, 'backups', 'claude-config'))).toEqual([STAMP]);
    expect(fs.readFileSync(path.join(home, 'backups', 'claude-config', STAMP, 'CLAUDE.md'), 'utf8')).toBe('# local\n');
    c.stop();
  });
  it('両方が変わっていたら新しい方を残し、古い方を conflict として隣に置く', async () => {
    const e = await remotePut('memory/x.md', 'remote\n', { mtime: NOW });
    write('memory/x.md', 'local\n', NOW - 60_000);
    db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
      .run('config/memory/x.md', 'config', 'memory/x.md', 'dev-b', sha256Hex('base\n'), 5, NOW - 120_000, 1, NOW);
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 1, backedUp: 1 });
    expect(fs.readFileSync(path.join(claudeDir, 'memory/x.md'), 'utf8')).toBe('remote\n');
    const conflicts = fs.readdirSync(path.join(claudeDir, 'memory')).filter((f) => f.includes('.conflict-'));
    expect(conflicts).toEqual([`x.md.conflict-mac-${STAMP}`]);
    expect(fs.readFileSync(path.join(claudeDir, 'memory', conflicts[0]!), 'utf8')).toBe('local\n');
    expect(toasts.some((t) => t.message.includes('競合'))).toBe(true);
    c.stop();
  });
  it('手元の方が新しければ相手の分を conflict にする', async () => {
    const e = await remotePut('memory/x.md', 'remote\n', { mtime: NOW - 60_000 });
    write('memory/x.md', 'local\n', NOW);
    db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
      .run('config/memory/x.md', 'config', 'memory/x.md', 'dev-b', sha256Hex('base\n'), 5, NOW - 120_000, 1, NOW);
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 1, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'memory/x.md'), 'utf8')).toBe('local\n');
    expect(fs.readFileSync(path.join(claudeDir, 'memory', `x.md.conflict-mini-${STAMP}`), 'utf8')).toBe('remote\n');
    c.stop();
  });
});
```


- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/sync/claudeConfig`
Expected: FAIL（`./claudeConfig.ts` が無い）

- [ ] **Step 3: 実装する**

`packages/server/src/sync/claudeConfig.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { configKey, type ConfigPreviewAction, type ConfigPreviewDto, type FileEntry, type FileMetaIn } from '@agent-hangar/shared';
import { backupsRoot } from '../config/cloud.ts';
import type { Db } from '../db/open.ts';
import type { CloudClient } from './client.ts';
import { timestampLabel } from './copy.ts';
import { decryptStream, encryptStream, sha256Hex } from './crypto.ts';
import type { Timers } from './engine.ts';
import type { SyncStateStore } from './state.ts';

export const HOME_MARKER = '__HANGAR_HOME__';
export const CONFIG_MAX_BYTES = 1 << 20;

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv']);
const ROOT_FILES = ['CLAUDE.md', 'settings.json'];
const TREES = ['skills', 'memory'];
const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };
const toPosix = (p: string): string => p.split(path.sep).join('/');
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-');

export type ConfigFile = { rel: string; abs: string; size: number; mtime: number };

/** 監視で拾う相対パスかどうか。statusLine のスクリプトだけは別に見る。 */
export function isConfigPath(rel: string): boolean {
  if (ROOT_FILES.includes(rel)) return true;
  if (TREES.some((t) => rel.startsWith(`${t}/`))) return true;
  return /^projects\/[^/]+\/memory\//.test(rel);
}

/** settings.json の statusLine.command が ~/.claude 配下を指していれば、その相対パスを返す。 */
export function statusLineRel(claudeDir: string): string | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')) as { statusLine?: { command?: string } };
    const cmd = s.statusLine?.command;
    if (!cmd) return null;
    const first = cmd.trim().split(/\s+/)[0]!.replace(/^['"]|['"]$/g, '');
    const home = os.homedir();
    const abs = path.resolve(first.startsWith('~') ? path.join(home, first.slice(1)) : first.startsWith('$HOME') ? path.join(home, first.slice('$HOME'.length)) : first);
    const rel = toPosix(path.relative(claudeDir, abs));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
  } catch {
    return null;
  }
}

/** 同期する Claude Code の設定ファイルを相対パス順に集める。 */
export function listConfigFiles(claudeDir: string): ConfigFile[] {
  const found = new Map<string, ConfigFile>();
  const add = (abs: string): void => {
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink() || !st.isFile() || st.size > CONFIG_MAX_BYTES) return;
    const rel = toPosix(path.relative(claudeDir, abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    found.set(rel, { rel, abs, size: st.size, mtime: Math.floor(st.mtimeMs) });
  };
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(abs); }
      else add(abs);
    }
  };
  for (const f of ROOT_FILES) add(path.join(claudeDir, f));
  for (const t of TREES) walk(path.join(claudeDir, t));
  const projects = path.join(claudeDir, 'projects');
  try {
    for (const p of fs.readdirSync(projects, { withFileTypes: true })) if (p.isDirectory()) walk(path.join(projects, p.name, 'memory'));
  } catch { /* projects が無ければ何もしない。 */ }
  const sl = statusLineRel(claudeDir);
  if (sl) add(path.join(claudeDir, ...sl.split('/')));
  return [...found.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** ホームの絶対パスを目印に置き換える。$HOME の文字列はそのまま残す。 */
export function normalizeHome(text: string, home: string): string { return text.split(home).join(HOME_MARKER); }
export function denormalizeHome(text: string, home: string): string { return text.split(HOME_MARKER).join(home); }

/** UTF-8 のテキストとして扱えるか。NUL を含むものと往復できないものは扱わない。 */
export function isTextBuffer(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

export type ClaudeConfigDeps = {
  db: Db; deviceId: string; deviceName: string; claudeDir: string; home: string;
  client: CloudClient; key: Buffer; state: SyncStateStore;
  enabled: () => boolean;
  onToast: (level: 'info' | 'error', message: string) => void;
  now?: () => number; debounceMs?: number; timers?: Timers; homeDir?: string;
};

type SyncRow = { sha256: string };

/**
 * Claude Code のユーザー設定を端末間で合わせる。
 * ~/.claude に書くのは、Settings で有効にして取り込みを確認したときだけである。
 */
export class ClaudeConfigSync {
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastRemote: FileEntry[] = [];

  constructor(private readonly deps: ClaudeConfigDeps) {}

  private get timers(): Timers { return this.deps.timers ?? REAL_TIMERS; }
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private homeDir(): string { return this.deps.homeDir ?? os.homedir(); }
  private confirmed(): boolean { return this.deps.state.get('configPullConfirmed') === '1'; }

  confirm(): void { this.deps.state.set('configPullConfirmed', true); }
  pendingRemote(): FileEntry[] { return this.lastRemote; }

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.deps.claudeDir, { recursive: true }, (_e, name) => {
        if (!name) return;
        const rel = toPosix(String(name));
        if (!isConfigPath(rel) && rel !== statusLineRel(this.deps.claudeDir)) return;
        this.schedule();
      });
      this.watcher.on('error', (e) => this.deps.onToast('error', `設定の監視が止まりました: ${errorMessage(e)}`));
    } catch (e) {
      this.deps.onToast('error', `設定の監視を始められません: ${errorMessage(e)}`);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /** 変化の 5 秒後にまとめて push する。 */
  private schedule(): void {
    if (this.timer) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.pushChanged(); }, this.deps.debounceMs ?? 5000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private normalizedBytes(buf: Buffer): Buffer {
    return isTextBuffer(buf) ? Buffer.from(normalizeHome(buf.toString('utf8'), this.homeDir()), 'utf8') : buf;
  }

  private syncedSha(key: string): string | null {
    return (this.deps.db.prepare('select sha256 from file_sync where key = ?').get(key) as SyncRow | undefined)?.sha256 ?? null;
  }

  private remember(e: { key: string; path: string; size: number; mtime: number; deviceId: string; seq: number }, sha: string): void {
    this.deps.db.prepare(`insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)
      on conflict(key) do update set path = excluded.path, device_id = excluded.device_id, sha256 = excluded.sha256, size = excluded.size, mtime = excluded.mtime, remote_seq = excluded.remote_seq, synced_at = excluded.synced_at`)
      .run(e.key, 'config', e.path, e.deviceId, sha, e.size, e.mtime, e.seq, this.now());
  }

  async pushChanged(): Promise<number> {
    if (!this.deps.enabled()) return 0;
    let n = 0;
    for (const f of listConfigFiles(this.deps.claudeDir)) {
      try {
        const content = this.normalizedBytes(fs.readFileSync(f.abs));
        const sha = sha256Hex(content);
        const key = configKey(f.rel);
        if (this.syncedSha(key) === sha) continue;
        const meta: FileMetaIn = { key, path: f.rel, kind: 'config', sha256: sha, size: content.length, mtime: f.mtime, encrypted: true };
        const body = new PassThrough();
        const pump = pipeline(Readable.from([content]), createGzip(), encryptStream(this.deps.key), body);
        let seq: number;
        try {
          const [r] = await Promise.all([this.deps.client.putFile(meta, body), pump]);
          seq = r.seq;
        } catch (e) {
          body.destroy();
          throw e;
        }
        this.remember({ ...meta, deviceId: this.deps.deviceId, seq }, sha);
        n++;
      } catch (e) {
        this.deps.onToast('error', `${f.rel} の同期に失敗しました: ${errorMessage(e)}`);
      }
    }
    return n;
  }

  private deviceName(id: string): string {
    return (this.deps.db.prepare('select name from devices where id = ?').get(id) as { name: string } | undefined)?.name ?? id;
  }

  /** 相手の 1 件を、手元の状態と前回の同期と突き合わせて分類する。 */
  private decide(e: FileEntry): { action: ConfigPreviewAction; localMtime: number | null; remoteNewer: boolean } {
    const abs = path.join(this.deps.claudeDir, ...e.path.split('/'));
    const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
    const localMtime = st ? Math.floor(st.mtimeMs) : null;
    const remoteNewer = localMtime === null || e.mtime >= localMtime;
    const localSha = st ? sha256Hex(this.normalizedBytes(fs.readFileSync(abs))) : null;
    const synced = this.syncedSha(e.key);
    if (localSha === e.sha256) return { action: 'skip', localMtime, remoteNewer };
    if (localSha === null) return { action: 'create', localMtime, remoteNewer };
    if (synced !== null && localSha === synced) return { action: 'overwrite', localMtime, remoteNewer };
    return { action: 'conflict', localMtime, remoteNewer };
  }

  preview(entries?: FileEntry[]): ConfigPreviewDto {
    const list = (entries ?? this.lastRemote).filter((e) => e.deviceId !== this.deps.deviceId);
    const sorted = [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      confirmed: this.confirmed(),
      entries: sorted.map((e) => {
        const d = this.decide(e);
        return { path: e.path, action: d.action, localMtime: d.localMtime, remoteMtime: e.mtime, remoteDevice: this.deviceName(e.deviceId), size: e.size };
      }),
    };
  }

  private async fetchPlain(key: string): Promise<Buffer> {
    const body = await this.deps.client.getFile(key);
    const chunks: Buffer[] = [];
    await pipeline(body, decryptStream(this.deps.key), createGunzip(), async (source) => { for await (const c of source) chunks.push(c as Buffer); });
    return Buffer.concat(chunks);
  }

  /**
   * 上書きの前に控えを取る。~/.agent-hangar/backups/claude-config/<stamp>/<相対パス>。
   * 1 回の applyPull は同じ stamp を使い、その回に書き換えた分がひとまとまりで残る。
   * 既存ファイルが無ければ控えは要らないので null を返す。
   * 写せなければ throw して、呼び手にそのファイルの書き戻しをやめさせる。
   */
  private backup(abs: string, rel: string, stamp: string): string | null {
    if (!fs.existsSync(abs)) return null;
    const b = path.join(backupsRoot(this.deps.home), 'claude-config', stamp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.copyFileSync(abs, b);
    return b;
  }

  /** 控えを取ってから書く。控えに失敗したら書かない。 */
  private backupAndWrite(abs: string, rel: string, content: Buffer, stamp: string): boolean {
    // ここで throw したら呼び手の catch が拾い、このファイルは次の pull に回る。
    const kept = this.backup(abs, rel, stamp);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return kept !== null;
  }

  async applyPull(entries: FileEntry[]): Promise<{ applied: number; conflicts: number; backedUp: number }> {
    this.lastRemote = entries.filter((e) => e.deviceId !== this.deps.deviceId);
    if (!this.deps.enabled() || !this.confirmed()) return { applied: 0, conflicts: 0, backedUp: 0 };
    let applied = 0;
    let conflicts = 0;
    let backedUp = 0;
    let localWon = false;
    // この回の控えの置き場。1 回の取り込みを 1 つのディレクトリにまとめる。
    const runStamp = timestampLabel(this.now());
    for (const e of this.lastRemote) {
      try {
        const d = this.decide(e);
        if (d.action === 'skip') { this.remember(e, e.sha256); continue; }
        const raw = await this.fetchPlain(e.key);
        if (sha256Hex(raw) !== e.sha256) throw new Error('SHA-256 が一致しません');
        const abs = path.join(this.deps.claudeDir, ...e.path.split('/'));
        const content = isTextBuffer(raw) ? Buffer.from(denormalizeHome(raw.toString('utf8'), this.homeDir()), 'utf8') : raw;
        if (d.action === 'conflict') {
          conflicts++;
          const stamp = timestampLabel(this.now());
          if (d.remoteNewer) {
            const keep = `${abs}.conflict-${safeName(this.deps.deviceName)}-${stamp}`;
            fs.copyFileSync(abs, keep);
            if (this.backupAndWrite(abs, e.path, content, runStamp)) backedUp++;
            this.deps.onToast('info', `${e.path} が競合しました。手元の内容を ${path.basename(keep)} に残しました`);
          } else {
            const other = `${abs}.conflict-${safeName(this.deviceName(e.deviceId))}-${stamp}`;
            fs.writeFileSync(other, content);
            localWon = true;
            this.deps.onToast('info', `${e.path} が競合しました。相手の内容を ${path.basename(other)} に置きました`);
          }
        } else {
          if (this.backupAndWrite(abs, e.path, content, runStamp)) backedUp++;
        }
        this.remember(e, e.sha256);
        applied++;
      } catch (err) {
        // 控えに失敗した分もここに落ちる。そのファイルは書き戻していないので、次の pull でやり直す。
        this.deps.onToast('error', `${e.path} の取り込みに失敗しました: ${errorMessage(err)}`);
      }
    }
    if (backedUp > 0) this.deps.onToast('info', `上書きした ${backedUp} 件の控えを ~/.agent-hangar/backups/claude-config/${runStamp}/ に置きました`);
    // 手元が勝った競合は、相手に追いつかせるためにすぐ push する。
    if (localWon) await this.pushChanged();
    return { applied, conflicts, backedUp };
  }
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/sync/claudeConfig && npx tsc -p packages/server`
Expected: PASS（控えに失敗したファイルを書き戻さない 1 件を足した数）

足すテストは次の 1 件である。

```ts
  it('控えを取れなければそのファイルを書き戻さない', async () => {
    const e = await remotePut('CLAUDE.md', 'remote\n', { mtime: NOW });
    write('CLAUDE.md', '# local\n', NOW - 60_000);
    // backups/claude-config を同名のファイルで塞ぎ、控えのディレクトリを作れなくする。
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(home, 'backups', 'claude-config'), 'x');
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# local\n');
    expect(toasts.some((t) => t.level === 'error')).toBe(true);
    c.stop();
  });
```

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/sync/claudeConfig.ts packages/server/src/sync/claudeConfig.test.ts
git commit -m "feat(server): opt-in Claude config sync with home rewriting, previews and conflict copies"
```

---

### Task 19: 同期の HTTP API とサーバの結線

**Files:**
- Modify: `packages/server/src/http/app.ts`、`packages/server/src/server.ts`
- Test: `packages/server/src/http/app.test.ts`（追加）

**Interfaces:**
- Consumes: `SyncEngine`、`QuotaCounter`、`TranscriptUploader`、`RemotePuller`、`ClaudeConfigSync`、`copyTranscriptForResume`、`listDevices`、`loadCloudConfig`、`deriveFileKey`、`HttpCloudClient`、`encodeJoinToken`。
- Produces:
  ```ts
  // http/app.ts
  export type SyncApi = Pick<SyncEngine, 'status' | 'syncNow' | 'setPaused' | 'onFocus' | 'pullBeforeLaunch'>;
  export type ConfigSyncApi = { preview(): ConfigPreviewDto; pull(): Promise<{ applied: number; conflicts: number }> };
  export type AppDeps = { ...フェーズ 1 から 3 の項目...; sync: SyncApi; resumeHere: (sessionId: string, overwrite: boolean) => LaunchResultDto | ResumeHereConflictDto; configSync: ConfigSyncApi | null; joinToken: () => string | null; devices: () => DeviceDto[] };
  ```
- 経路（すべて `/api` の下で認証必須）：
  - `GET /sync/status` → `SyncStatusDto`。
  - `POST /sync/now` → push と pull を待ってから `SyncStatusDto`。
  - `POST /sync/pause` 本文 `{ paused: boolean }` → `SyncStatusDto`。
  - `POST /sync/focus` → 202。前回の pull から 5 秒以内なら中で何もしない。
  - `GET /devices` → `DeviceDto[]`。
  - `GET /sync/joinToken` → `{ token: string | null }`。setup を走らせていない端末では null。
  - `GET /sync/config/preview` → `ConfigPreviewDto`。同期が未設定なら 404。
  - `POST /sync/config/pull` → `{ applied, conflicts }`。同期が未設定なら 404。
  - `POST /sessions/:id/resume-here` 本文 `{ overwrite?: boolean }` → `LaunchResultDto`、または 409 で `ResumeHereConflictDto`。
- `GET /bootstrap` に `sync` と `devices` を足し、`listSessions` と `getSession` に自端末の ID を渡してロックを出す。`toSettingsDto` に `syncClaudeConfig` を足す。
- `POST /runs`、`POST /sessions/:id/resume`、`POST /sessions/:id/fork` の先頭で `await deps.sync.pullBeforeLaunch(2000)` を待つ。結果は捨ててよい（間に合わなくても起動する）。
- `server.ts` は `cloud.json` があればクラウドの部品を組み立て、無ければ `SyncEngine` を `client: null` で作る（状態は `off`）。組み立ての順は、`SyncStateStore` → `QuotaCounter` → `SyncEngine` → `TranscriptUploader` → `RemotePuller` → `ClaudeConfigSync` である。引き継ぎの部品（`TakeoverCoordinator` と `TakeoverResponder`）はこのフェーズでは作らない。
- `SyncEngine` の `toast` と `RemotePuller` の `onMemoConflict` は `hub.broadcast({ type: 'toast', ... })` に繋ぐ。無料枠の 80% で止まったこと、メモの競合を隣に残したこと、設定の控えを置いたことは、どれもトーストで利用者に届く。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/http/app.test.ts` の `createApp` の呼び出しに次の項目を足す。
フェーズ 2 と 3 が足した `port`、`runs`、`external`、`usage`、`memos`、`summary`、`promote` はそのまま残す（下の抜粋では省いてある）。

```ts
  const syncStatus: SyncStatusDto = { state: 'idle', url: 'https://h', lastPushAt: 100, lastPullAt: 200, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false } };
  const calls: string[] = [];
  const sync = {
    status: () => syncStatus,
    syncNow: async () => { calls.push('syncNow'); },
    setPaused: (p: boolean) => { calls.push(`pause:${p}`); },
    onFocus: async () => { calls.push('focus'); },
    pullBeforeLaunch: async () => { calls.push('beforeLaunch'); return true; },
  };
  let resumeHereResult: LaunchResultDto | ResumeHereConflictDto = { run: { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'resume', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 's1', tabs: [] };
  const configSync = { preview: () => ({ entries: [{ path: 'CLAUDE.md', action: 'create' as const, localMtime: null, remoteMtime: 5, remoteDevice: 'mini', size: 3 }], confirmed: false }), pull: async () => ({ applied: 1, conflicts: 0 }) };
  app = createApp({
    db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, version: '0.0.0-test',
    settings: () => settings, updateSettings: (p) => (settings = { ...settings, ...p }),
    live: () => [], indexer, hub: { broadcast: (e) => sent.push(e) },
    sync, configSync,
    resumeHere: (id, overwrite) => { calls.push(`resumeHere:${id}:${overwrite}`); return resumeHereResult; },
    joinToken: () => 'tok-abc',
    devices: () => [{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: 1, self: true }],
  });
```

既存の `let settings: SettingsDto = { workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20 };` に `syncClaudeConfig: false` を足す。
次の `describe` を足す。

```ts
const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('同期の経路', () => {
  it('bootstrap に sync と devices が乗り、設定に syncClaudeConfig が出る', async () => {
    const { body } = await json(await get('/api/bootstrap'));
    expect(body.sync).toMatchObject({ state: 'idle', pending: 0, deviceCount: 2 });
    expect(body.devices).toEqual([{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: 1, self: true }]);
    expect(body.settings.syncClaudeConfig).toBe(false);
    expect(body.sessions[0].lock).toBeNull();
    expect(body.sessions[0].remoteOnly).toBe(false);
  });
  it('status、now、pause、focus', async () => {
    expect((await json(await get('/api/sync/status'))).body.state).toBe('idle');
    expect((await json(await post('/api/sync/now'))).body.state).toBe('idle');
    expect((await post('/api/sync/pause', { paused: true })).status).toBe(200);
    expect((await post('/api/sync/pause', { paused: 'yes' })).status).toBe(400);
    expect((await post('/api/sync/focus')).status).toBe(202);
    expect(calls).toEqual(['syncNow', 'pause:true', 'focus']);
  });
  it('参加トークンと端末一覧と設定の下見', async () => {
    expect((await json(await get('/api/sync/joinToken'))).body).toEqual({ token: 'tok-abc' });
    expect((await json(await get('/api/devices'))).body).toHaveLength(1);
    const p = await json(await get('/api/sync/config/preview'));
    expect(p.body.entries[0]).toMatchObject({ path: 'CLAUDE.md', action: 'create' });
    expect((await json(await post('/api/sync/config/pull'))).body).toEqual({ applied: 1, conflicts: 0 });
  });
  it('この PC で再開は 409 で写しとの大きさを返す', async () => {
    const id = (await json(await get('/api/sessions'))).body[0].id;
    expect((await json(await post(`/api/sessions/${id}/resume-here`))).body.sessionId).toBe('s1');
    resumeHereResult = { error: 'local_smaller', localSize: 10, remoteSize: 99 };
    const r = await json(await post(`/api/sessions/${id}/resume-here`, { overwrite: false }));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'local_smaller', localSize: 10, remoteSize: 99 });
    expect(calls).toEqual([`resumeHere:${id}:false`, `resumeHere:${id}:false`]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/http/app`
Expected: FAIL（`/api/sync/status` が 404、`AppDeps` に `sync` が無い）

- [ ] **Step 3: HTTP を実装する**

`packages/server/src/http/app.ts` を直す。

```ts
import type { ConfigPreviewDto, DeviceDto, LaunchResultDto, ResumeHereConflictDto, SyncStatusDto } from '@agent-hangar/shared';
import { listDevices } from '../db/queries.ts';
import type { SyncEngine } from '../sync/engine.ts';

export type SyncApi = Pick<SyncEngine, 'status' | 'syncNow' | 'setPaused' | 'onFocus' | 'pullBeforeLaunch'>;
export type ConfigSyncApi = { preview(): ConfigPreviewDto; pull(): Promise<{ applied: number; conflicts: number }> };
```

`AppDeps` に足す。

```ts
  sync: SyncApi;
  resumeHere: (sessionId: string, overwrite: boolean) => LaunchResultDto | ResumeHereConflictDto;
  configSync: ConfigSyncApi | null;
  joinToken: () => string | null;
  devices: () => DeviceDto[];
```

`toSettingsDto` を替える。

```ts
const toSettingsDto = (s: Settings): SettingsDto => ({ workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir, syncClaudeConfig: s.syncClaudeConfig });
```

`bootstrap` の本文に `sync: deps.sync.status(), devices: deps.devices(),` を足し、`listSessions(db, live)` を `listSessions(db, live, { deviceId })` にする。
`GET /sessions`、`GET /sessions/:id`、`POST /projects/:id/resolve` の中の `listSessions` と `getSession` にも `{ deviceId }` を渡す。

`api` に次を足す（`/api/settings` の後ろ）。

```ts
  const runError = (e: unknown): { status: 400 | 404 | 409; message: string } | null => {
    const s = (e as { status?: number } | null)?.status;
    return s === 400 || s === 404 || s === 409 ? { status: s, message: e instanceof Error ? e.message : '失敗しました' } : null;
  };

  api.get('/sync/status', (c) => c.json(deps.sync.status()));
  api.post('/sync/now', async (c) => { await deps.sync.syncNow(); return c.json(deps.sync.status()); });
  api.post('/sync/pause', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { paused?: unknown };
    if (typeof body.paused !== 'boolean') return c.json({ error: 'invalid paused' }, 400);
    deps.sync.setPaused(body.paused);
    return c.json(deps.sync.status());
  });
  // 前面化は待たせない。中で 5 秒の間引きをする。
  api.post('/sync/focus', (c) => { void deps.sync.onFocus(); return c.body(null, 202); });
  api.get('/devices', (c) => c.json(deps.devices()));
  api.get('/sync/joinToken', (c) => c.json({ token: deps.joinToken() }));
  api.get('/sync/config/preview', (c) => (deps.configSync ? c.json(deps.configSync.preview()) : c.json({ error: 'cloud sync is not configured' }, 404)));
  api.post('/sync/config/pull', async (c) => (deps.configSync ? c.json(await deps.configSync.pull()) : c.json({ error: 'cloud sync is not configured' }, 404)));

  api.post('/sessions/:id/resume-here', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { overwrite?: boolean };
    try {
      const r = deps.resumeHere(c.req.param('id'), body.overwrite === true);
      return 'error' in r ? c.json(r, 409) : c.json(r);
    } catch (e) {
      const er = runError(e);
      if (er) return c.json({ error: er.message }, er.status);
      throw e;
    }
  });
```

`POST /runs`、`POST /sessions/:id/resume`、`POST /sessions/:id/fork` のハンドラの先頭に次の 1 行を足す。

```ts
    await deps.sync.pullBeforeLaunch(2000);
```

- [ ] **Step 4: サーバを結線する**

`packages/server/src/server.ts` に足す。まず import と定数。

```ts
import { encodeJoinToken, type LaunchResultDto, type ResumeHereConflictDto } from '@agent-hangar/shared';
import { RunError } from './runs/manager.ts';   // フェーズ 2 で既に import していれば足さない
import { loadCloudConfig, remoteRoot } from './config/cloud.ts';
import { listDevices } from './db/queries.ts';
import { upsertShared } from './db/shared.ts';
import { ClaudeConfigSync } from './sync/claudeConfig.ts';
import { HttpCloudClient } from './sync/client.ts';
import { copyTranscriptForResume } from './sync/copy.ts';
import { deriveFileKey } from './sync/crypto.ts';
import { SyncEngine } from './sync/engine.ts';
import { RemotePuller } from './sync/puller.ts';
import { SyncStateStore } from './sync/state.ts';
import { TranscriptUploader } from './sync/uploader.ts';

const DEVICE_TOUCH_MS = 600_000;
```

`openDb` の後、インデクサを作る前に部品を組み立てる。

```ts
  // クラウド同期。cloud.json が無ければ client は null で、同期の状態は off になる。
  const cloud = loadCloudConfig(home);
  const client = cloud ? new HttpCloudClient({ url: cloud.url, token: cloud.deviceToken }) : null;
  const fileKey = cloud ? deriveFileKey(cloud.joinSecret) : Buffer.alloc(32);
  const syncState = new SyncStateStore(db);
  const engine = new SyncEngine({ db, deviceId: device.id, client, url: cloud?.url ?? null });
  const toast = (level: 'info' | 'error', message: string) => hub.broadcast({ type: 'toast', level, message });
  const uploader = client
    ? new TranscriptUploader({ db, deviceId: device.id, claudeDir, client, key: fileKey, state: syncState, isPaused: () => engine.status().state === 'paused', onError: (p, m) => console.error('[upload]', p, m) })
    : null;
  const configSync = client
    ? new ClaudeConfigSync({ db, deviceId: device.id, deviceName: device.name, claudeDir, home, client, key: fileKey, state: syncState, enabled: () => settings.syncClaudeConfig, onToast: toast })
    : null;
  const puller = client
    ? new RemotePuller({ db, deviceId: device.id, home, client, key: fileKey, state: syncState, onConfigEntries: async (entries) => { await configSync?.applyPull(entries); }, onError: (k, m) => console.error('[pull]', k, m) })
    : null;
```

インデクサに他端末の置き場と譲った記録を渡す。

```ts
  const indexer = new IndexerService({
    db, deviceId: device.id, claudeDir,
    isRunning: (id) => registry.current().some((l) => l.sessionId === id),
    remoteRoot: remoteRoot(home),
    isYielded: (uuid) => syncState.isYielded(uuid),
  });
```

`indexer.on({...})` の `sessionChanged` は、フェーズ 3 の中身（未紐づけの割り当て、`tellUnassigned`、`transcript.appended`、`artifact.upsert` の配布）をそのまま残し、次の 2 点だけを足す。

```ts
    sessionChanged: (e) => {
      // 手元のファイルだけを上げる。他端末の写しは持ち主が上げる。
      if (e.deviceId === null) uploader?.noteChanged({ path: e.path, sessionId: e.providerSessionId, agentId: e.agentId });
      ...フェーズ 3 の中身をそのまま...
      // getSession はロックを出すために自端末の ID を渡す形に替える。
      const s = getSession(db, registry.current(), e.sessionId, { deviceId: device.id });
      ...以降もそのまま...
    },
```

`server.ts` で `getSession(db, registry.current(), ...)` を呼んでいる箇所（`indexer.on` と `registry.onChange` の中）は、どれも第 4 引数に `{ deviceId: device.id }` を渡す形に替える。

同期のイベントを hub に流す。

```ts
  engine.on({
    status: (s) => hub.broadcast({ type: 'sync.status', status: s }),
    applied: (c) => {
      hub.broadcast({ type: 'sync.applied', table: c.tableName, rowId: c.rowId });
      if (c.tableName === 'sessions' || c.tableName === 'runs' || c.tableName === 'session_summaries') {
        const sessionId = c.tableName === 'runs'
          ? (db.prepare('select session_id s from runs where id = ?').get(c.rowId) as { s: string } | undefined)?.s ?? null
          : c.rowId;
        const s = sessionId ? getSession(db, registry.current(), sessionId, { deviceId: device.id }) : null;
        if (s) hub.broadcast({ type: 'session.upsert', session: s });
      }
      if (c.tableName === 'projects' || c.tableName === 'project_roots') {
        for (const p of listProjects(db, device.id, registry.current())) hub.broadcast({ type: 'project.upsert', project: p });
      }
      if (c.tableName === 'devices') hub.broadcast({ type: 'devices.update', devices: listDevices(db, device.id) });
    },
    // メタデータの pull の後に、ファイルの新着を取りに行く。
    pulled: () => { void puller?.pullNow().catch((e: unknown) => console.error('[files]', e)); },
  });
```

「この PC で再開」を組み立てる（`runs` はフェーズ 2 の `RunManager`）。

```ts
  /** 他端末の本文を手元に写してから再開する。~/.claude への書き込みはここだけを通る。 */
  const resumeHere = (sessionId: string, overwrite: boolean): LaunchResultDto | ResumeHereConflictDto => {
    const r = copyTranscriptForResume({ db, home, claudeDir, sessionId, overwrite });
    if (r.kind === 'ask') return { error: 'local_smaller', localSize: r.localSize, remoteSize: r.remoteSize };
    if (r.kind === 'none') throw new RunError(400, 'このセッションの本文がありません');
    return runs.resume(sessionId);
  };

  // RunManager.on は listener を足せるので、フェーズ 2 と 3 の runs.on({...}) はそのまま残し、2 つ目として登録する。
  runs.on({ runEnded: (r) => { const uuid = (db.prepare('select provider_session_id p from sessions where id = ?').get(r.sessionId) as { p: string } | undefined)?.p; if (uuid) void uploader?.flushSession(uuid); } });
```

`createApp` の引数に足す。

```ts
    sync: engine,
    resumeHere,
    configSync: configSync ? { preview: () => configSync.preview(), pull: async () => { const entries = configSync.pendingRemote(); configSync.confirm(); return configSync.applyPull(entries); } } : null,
    joinToken: () => (cloud ? encodeJoinToken({ url: cloud.url, secret: cloud.joinSecret }) : null),
    devices: () => listDevices(db, device.id),
```

`updateSettings` で Claude Code 設定の状態を同期エンジンに伝える。
既存の `runs.setTmux(t)` と `relay.setTmux(t)` は消さず、その後ろに 1 行足す。

```ts
    updateSettings: (patch) => {
      settings = { ...settings, ...patch };
      saveSettings(home, settings);
      ...フェーズ 2 の tmux の差し替えをそのまま...
      engine.setClaudeConfigStatus({ enabled: settings.syncClaudeConfig, confirmed: syncState.get('configPullConfirmed') === '1' });
      return settings;
    },
```

起動の最後（`started = true;` の後、`console.log(...)` の前）に足す。

```ts
  const touchDevice = () => {
    const row = db.prepare('select * from devices where id = ?').get(device.id) as Record<string, unknown> | undefined;
    upsertShared(db, 'devices', { ...(row ?? {}), id: device.id, name: device.name, platform: device.platform, last_seen_at: Date.now(), deleted_at: null }, device.id);
    hub.broadcast({ type: 'devices.update', devices: listDevices(db, device.id) });
  };
  touchDevice();
  const deviceTimer = setInterval(touchDevice, DEVICE_TOUCH_MS);
  deviceTimer.unref();

  engine.setClaudeConfigStatus({ enabled: settings.syncClaudeConfig, confirmed: syncState.get('configPullConfirmed') === '1' });
  await engine.start();
  if (puller) await puller.pullNow().catch((e: unknown) => console.error('[files]', e));
  configSync?.start();
```

`close` の先頭に足す。

```ts
      clearInterval(deviceTimer);
      configSync?.stop();
      uploader?.stop();
      engine.stop();
```

- [ ] **Step 5: サーバのテストを足す**

`packages/server/src/server.test.ts` に足す（`cloud.json` が無い端末でも同期の経路が動き、状態が `off` になることだけを確かめる。実物のクラウドには触らない）。

```ts
  it('cloud.json が無ければ同期は off で、経路は動く', async () => {
    const s = await startServer({ port: 0, home, claudeDir: dir });
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    const r = await fetch(`http://127.0.0.1:${s.port}/api/sync/status`, { headers: { authorization: `Bearer ${token}` } });
    expect(await r.json()).toMatchObject({ state: 'off', url: null, pending: expect.any(Number) });
    const b = await (await fetch(`http://127.0.0.1:${s.port}/api/bootstrap`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(b.devices.some((d: { self: boolean }) => d.self)).toBe(true);
    await s.close();
  });
```

- [ ] **Step 6: テストと型検査**

Run: `npx vitest run packages/server && npx tsc -p packages/server`
Expected: PASS（app の同期 5 件と server の 1 件を含む）

- [ ] **Step 7: コミット**

```bash
git add packages/server/src/http packages/server/src/server.ts packages/server/src/server.test.ts
git commit -m "feat(server): sync and resume-here HTTP routes wired into the server"
```

---

### Task 20: Mediator の同期領域とこの PC で再開の領域、ストア

**Files:**
- Create: `packages/ui/src/mediator/sync.ts`、`packages/ui/src/mediator/resumeHere.ts`
- Modify: `packages/ui/src/mediator/types.ts`、`packages/ui/src/mediator/transition.ts`、`packages/ui/src/store/store.ts`
- Test: `packages/ui/src/mediator/transition.test.ts`（追加）、`packages/ui/src/store/store.test.ts`（追加）

**Interfaces:**
- Consumes: `SyncStatusDto`、`SyncStateKind`、`DeviceDto`、`ConfigPreviewDto`（shared、Task 1）。
- Produces:
  ```ts
  // mediator/types.ts（追加）
  export type SyncState = { kind: 'off' } | { kind: 'idle'; lastAt: number | null } | { kind: 'pushing' } | { kind: 'pulling' } | { kind: 'paused' } | { kind: 'error'; message: string };
  export type Overlay = ...フェーズ 1 から 3 の種別...
    | { kind: 'confirm'; confirm: { kind: 'overwriteTranscript'; sessionId: string; localSize: number; remoteSize: number } }
    | { kind: 'configPreview' };
  export type RuntimeEvent = ... | { type: 'window.focus' } | { type: 'api.conflict'; kind: 'resumeHere'; sessionId: string; localSize: number; remoteSize: number };
  export type Effect = ...
    | { kind: 'api.syncNow' } | { kind: 'api.syncPause'; paused: boolean } | { kind: 'api.syncFocus' }
    | { kind: 'api.resumeHere'; sessionId: string; overwrite: boolean }
    | { kind: 'api.configPreview' } | { kind: 'api.configPull' } | { kind: 'api.joinToken' };
  export type State = { ...; sync: SyncState; pending: number };
  // mediator/sync.ts
  export function syncStep(state: State, input: Input): Step | null;
  export function toSyncState(s: SyncStatusDto): SyncState;
  // mediator/resumeHere.ts
  export function resumeHereStep(state: State, input: Input): Step | null;
  // store/store.ts（追加）
  export type Store = { ...; sync: SyncStatusDto | null; devices: DeviceDto[]; joinToken: string | null; configPreview: ConfigPreviewDto | null };
  export function applyJoinToken(store: Store, token: string | null): Store;
  export function applyConfigPreview(store: Store, preview: ConfigPreviewDto | null): Store;
  ```
- 領域の合成順は実物の 8 つを変えず、`overlayStep` の後ろに `syncStep` と `resumeHereStep` を挟む。`overlayStep` の `overlay.close` が先に来るので、確認と下見のオーバーレイも Esc と外側のクリックで閉じられる。
- `NOT_YET_INTENTS` から `sync.now` と `sync.pause` を外す。**`session.takeover` は残す**（引き継ぎはこのフェーズで実装しないので、押すと「次のフェーズで実装します」と出る）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/mediator/transition.test.ts` に足す。

```ts
import type { SyncStatusDto } from '@agent-hangar/shared';

const status = (over: Partial<SyncStatusDto> = {}): SyncStatusDto => ({ state: 'idle', url: 'https://h', lastPushAt: 100, lastPullAt: 200, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false }, ...over });

describe('同期', () => {
  it('sync.status が領域の状態と未送信件数になる', () => {
    const a = run([server({ type: 'sync.status', status: status() })]);
    expect(a.state.sync).toEqual({ kind: 'idle', lastAt: 200 });
    expect(a.state.pending).toBe(0);
    const b = run([server({ type: 'sync.status', status: status({ state: 'error', error: '切れました', pending: 3 }) })]);
    expect(b.state.sync).toEqual({ kind: 'error', message: '切れました' });
    expect(b.state.pending).toBe(3);
    expect(run([server({ type: 'sync.status', status: status({ state: 'paused' }) })]).state.sync).toEqual({ kind: 'paused' });
    expect(run([server({ type: 'sync.status', status: status({ state: 'off', url: null }) })]).state.sync).toEqual({ kind: 'off' });
  });
  it('今すぐ同期、一時停止、前面化が効果になる', () => {
    const { effects } = run([intent({ type: 'sync.now' }), intent({ type: 'sync.pause', paused: true }), runtime({ type: 'window.focus' })]);
    expect(effects).toEqual([{ kind: 'api.syncNow' }, { kind: 'api.syncPause', paused: true }, { kind: 'api.syncFocus' }]);
  });
  it('参加トークンの再表示と設定の下見と取り込み', () => {
    const a = run([intent({ type: 'sync.joinToken.show' })]);
    expect(a.effects).toEqual([{ kind: 'api.joinToken' }]);
    const b = run([intent({ type: 'sync.config.preview' })]);
    expect(b.state.overlay).toEqual({ kind: 'configPreview' });
    expect(b.effects).toEqual([{ kind: 'api.configPreview' }]);
    const c = run([intent({ type: 'sync.config.apply' })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'none' });
    expect(c.effects).toEqual([{ kind: 'api.configPull' }]);
  });
});

describe('この PC で再開', () => {
  it('この PC で再開の 409 は確認ダイアログになり、承諾で上書きを送る', () => {
    const a = run([intent({ type: 'session.resumeHere', id: 's1' })]);
    expect(a.effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: false }]);
    const b = run([runtime({ type: 'api.conflict', kind: 'resumeHere', sessionId: 's1', localSize: 10, remoteSize: 99 })], a.state);
    expect(b.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'overwriteTranscript', sessionId: 's1', localSize: 10, remoteSize: 99 } });
    const c = run([intent({ type: 'session.resumeHere', id: 's1', overwrite: true })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'none' });
    expect(c.effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: true }]);
  });
  it('同期の操作は未実装の案内を出さないが、引き継ぎは出す', () => {
    expect(run([intent({ type: 'sync.now' })]).effects.some((e) => (e as { kind: string }).kind === 'toast')).toBe(false);
    // 引き継ぎはこのフェーズでは実装しないので、NOT_YET_INTENTS に残っている。
    expect(run([intent({ type: 'session.takeover', id: 's1', force: false })]).effects).toEqual([{ kind: 'toast', level: 'info', message: NOT_YET }]);
  });
});
```

`packages/ui/src/store/store.test.ts` の `boot` に `sync` と `devices` を足し、`settings` に `syncClaudeConfig: false` を足す。
次を足す。

```ts
import { applyConfigPreview, applyJoinToken } from './store.ts';

describe('store の同期', () => {
  it('bootstrap の sync と devices を入れ、イベントで差し替える', () => {
    let s = applyBootstrap(initialStore(), boot);
    expect(s.sync?.state).toBe('off');
    expect(s.devices).toEqual([]);
    s = applyServerEvent(s, { type: 'sync.status', status: { state: 'pushing', url: 'https://h', lastPushAt: 1, lastPullAt: 2, pending: 4, error: null, deviceCount: 2, claudeConfig: { enabled: true, confirmed: true } } });
    expect(s.sync).toMatchObject({ state: 'pushing', pending: 4 });
    s = applyServerEvent(s, { type: 'devices.update', devices: [{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: 1, self: true }] });
    expect(s.devices).toHaveLength(1);
    expect(applyServerEvent(s, { type: 'sync.applied', table: 'projects', rowId: 'p1' })).toBe(s);
  });
  it('参加トークンと設定の下見を持つ', () => {
    let s = initialStore();
    expect(s.joinToken).toBeNull();
    s = applyJoinToken(s, 'tok');
    expect(s.joinToken).toBe('tok');
    s = applyConfigPreview(s, { entries: [], confirmed: true });
    expect(s.configPreview).toEqual({ entries: [], confirmed: true });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/mediator packages/ui/src/store`
Expected: FAIL（`sync` が State に無い、`./sync.ts` が無い）

- [ ] **Step 3: 型と領域を実装する**

`packages/ui/src/mediator/types.ts` に足す（`import type { ConfigPreviewDto, DeviceDto, SyncStatusDto } from '@agent-hangar/shared';` を先頭に足す）。

```ts
export type SyncState = { kind: 'off' } | { kind: 'idle'; lastAt: number | null } | { kind: 'pushing' } | { kind: 'pulling' } | { kind: 'paused' } | { kind: 'error'; message: string };
export type ConfirmRequest = { kind: 'overwriteTranscript'; sessionId: string; localSize: number; remoteSize: number };
```

`Overlay` に `| { kind: 'confirm'; confirm: ConfirmRequest } | { kind: 'configPreview' }` を足す。
`RuntimeEvent` に `| { type: 'window.focus' } | { type: 'api.conflict'; kind: 'resumeHere'; sessionId: string; localSize: number; remoteSize: number }` を足す。
`Effect` に「インターフェース一覧」の 7 つの効果を足す。
`State` に `sync: SyncState; pending: number;` を足す。

`packages/ui/src/mediator/sync.ts`：

```ts
import type { SyncStatusDto } from '@agent-hangar/shared';
import type { Input, Step, State, SyncState } from './types.ts';

/** サーバの同期状態を、UI が描く形に写す。 */
export function toSyncState(s: SyncStatusDto): SyncState {
  switch (s.state) {
    case 'off': return { kind: 'off' };
    case 'pushing': return { kind: 'pushing' };
    case 'pulling': return { kind: 'pulling' };
    case 'paused': return { kind: 'paused' };
    case 'error': return { kind: 'error', message: s.error ?? '同期に失敗しました' };
    case 'idle': return { kind: 'idle', lastAt: s.lastPullAt ?? s.lastPushAt };
  }
}

/** sync 領域：同期の状態表示と、今すぐ同期、一時停止、設定の取り込み。 */
export function syncStep(state: State, input: Input): Step | null {
  if (input.kind === 'server' && input.event.type === 'sync.status') {
    return { state: { ...state, sync: toSyncState(input.event.status), pending: input.event.status.pending }, effects: [] };
  }
  if (input.kind === 'runtime' && input.event.type === 'window.focus') return { state, effects: [{ kind: 'api.syncFocus' }] };
  if (input.kind !== 'intent') return null;
  switch (input.intent.type) {
    case 'sync.now': return { state, effects: [{ kind: 'api.syncNow' }] };
    case 'sync.pause': return { state, effects: [{ kind: 'api.syncPause', paused: input.intent.paused }] };
    case 'sync.joinToken.show': return { state, effects: [{ kind: 'api.joinToken' }] };
    case 'sync.config.preview': return { state: { ...state, overlay: { kind: 'configPreview' } }, effects: [{ kind: 'api.configPreview' }] };
    case 'sync.config.apply': return { state: { ...state, overlay: { kind: 'none' } }, effects: [{ kind: 'api.configPull' }] };
    default: return null;
  }
}
```

`packages/ui/src/mediator/resumeHere.ts`：

```ts
import type { Input, State, Step } from './types.ts';

/**
 * resumeHere 領域：他端末の本文を手元に降ろして再開するときの確認。
 * 引き継ぎ（session.takeover）はこのフェーズでは実装しないので、ここでは扱わない。
 */
export function resumeHereStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime' && input.event.type === 'api.conflict' && input.event.kind === 'resumeHere') {
    const e = input.event;
    return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'overwriteTranscript', sessionId: e.sessionId, localSize: e.localSize, remoteSize: e.remoteSize } } }, effects: [] };
  }
  if (input.kind !== 'intent' || input.intent.type !== 'session.resumeHere') return null;
  const i = input.intent;
  const overwrite = i.overwrite === true;
  // 確認ダイアログから承諾したときだけ閉じる。ボタンから直接呼ばれたときは触らない。
  const overlay = overwrite && state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
  return { state: { ...state, overlay }, effects: [{ kind: 'api.resumeHere', sessionId: i.id, overwrite }] };
}
```

`packages/ui/src/mediator/transition.ts` を直す。

```ts
import { resumeHereStep } from './resumeHere.ts';
import { syncStep } from './sync.ts';

// 既存の initialState() の末尾に 2 項目を足す（他の項目は消さない）。
export function initialState(): State {
  return { screen: { name: 'booting' }, overlay: { kind: 'none' }, connection: 'connecting', reconnectAttempt: 0, sessionView: {}, search: { text: '', filter: {} }, launch: { kind: 'idle' }, waitingSeen: [], promote: { kind: 'idle' }, summaryFailed: {}, toasts: [], unresolvedQueue: [], resolveDeferred: [], nextToastId: 1, indexPhase: 'idle', sync: { kind: 'off' }, pending: 0 };
}

  // 既存の 8 つの順は変えず、overlayStep の後ろに syncStep と resumeHereStep を挟む。
  // resumeHereStep はオーバーレイを開け閉めするが overlay.close を横取りしないので、promoteStep より後で問題ない。
  for (const step of [connectionStep, screenStep, launchStep, promoteStep, overlayStep, syncStep, resumeHereStep, sessionViewStep, liveStep, workbenchStep]) {
```

`NOT_YET_INTENTS` から `'sync.now'` と `'sync.pause'` を消す。**`'session.takeover'` は残す**（引き継ぎはこのフェーズで実装しない）。残るのは `['session.takeover', 'project.new.open', 'project.new.submit']` の 3 件である。

- [ ] **Step 4: ストアを実装する**

`packages/ui/src/store/store.ts` を直す。

```ts
import type { ConfigPreviewDto, DeviceDto, SyncStatusDto } from '@agent-hangar/shared';

export type Store = {
  ...フェーズ 1 から 3 の項目...;
  sync: SyncStatusDto | null; devices: DeviceDto[]; joinToken: string | null; configPreview: ConfigPreviewDto | null;
};
```

`initialStore()` に `sync: null, devices: [], joinToken: null, configPreview: null` を足す。
`applyBootstrap` に `sync: b.sync, devices: b.devices` を足す。
`applyServerEvent` の `switch` に足す。

```ts
    case 'sync.status': return { ...store, sync: ev.status };
    case 'devices.update': return { ...store, devices: ev.devices };
```

末尾に足す。

```ts
export function applyJoinToken(store: Store, token: string | null): Store { return { ...store, joinToken: token }; }
export function applyConfigPreview(store: Store, preview: ConfigPreviewDto | null): Store { return { ...store, configPreview: preview }; }
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui/src/mediator packages/ui/src/store && npx tsc -p packages/ui`
Expected: PASS。`tsc` は Presenter と View がまだ新しい項目を使っていない分だけ通る。

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/mediator packages/ui/src/store
git commit -m "feat(ui): mediator sync and resume-here regions with store slices for devices and previews"
```

---

### Task 21: ランタイムの同期 API と前面化

**Files:**
- Modify: `packages/ui/src/runtime/api.ts`、`packages/ui/src/runtime/runtime.ts`、`packages/ui/src/main.tsx`
- Test: `packages/ui/src/runtime/runtime.test.ts`（追加）

**Interfaces:**
- Consumes: Task 20 の効果と `RuntimeEvent`、`applyJoinToken`、`applyConfigPreview`。
- Produces:
  ```ts
  // runtime/api.ts（追加）
  export class ApiConflictError extends Error { constructor(public readonly body: ResumeHereConflictDto); }
  export type ApiClient = { ...フェーズ 1 から 3 の項目...;
    syncStatus(): Promise<SyncStatusDto>;
    syncNow(): Promise<SyncStatusDto>;
    syncPause(paused: boolean): Promise<SyncStatusDto>;
    syncFocus(): Promise<void>;
    resumeHere(sessionId: string, overwrite: boolean): Promise<LaunchResultDto>;
    joinToken(): Promise<{ token: string | null }>;
    configPreview(): Promise<ConfigPreviewDto>;
    configPull(): Promise<{ applied: number; conflicts: number }>;
    devices(): Promise<DeviceDto[]>;
  };
  // runtime/runtime.ts（追加）
  export type RuntimeDeps = { ...; onWindowFocus?: (cb: () => void) => () => void };
  ```
- `POST /api/sessions/:id/resume-here` の 409 は `ApiConflictError` にし、ランタイムが `RuntimeEvent api.conflict` に変えて Mediator に渡す。他の失敗はこれまでどおり `api.failed` でトーストにする。
- 前面化の失敗はトーストにしない（窓を触るたびに赤い通知が出ると邪魔になるため）。サーバ側は 5 秒の間引きをする。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/runtime/runtime.test.ts` の `harness` の偽 API に足す。

```ts
    syncStatus: vi.fn(async () => syncStatus),
    syncNow: vi.fn(async () => syncStatus),
    syncPause: vi.fn(async () => ({ ...syncStatus, state: 'paused' as const })),
    syncFocus: vi.fn(async () => {}),
    resumeHere: vi.fn(async () => launchResult),
    joinToken: vi.fn(async () => ({ token: 'tok' })),
    configPreview: vi.fn(async () => ({ entries: [], confirmed: false })),
    configPull: vi.fn(async () => ({ applied: 2, conflicts: 1 })),
    devices: vi.fn(async () => []),
```

`boot` に `sync: syncStatus, devices: []` を、`settings` に `syncClaudeConfig: false` を足し、先頭に次を置く。

```ts
import type { LaunchResultDto, SyncStatusDto } from '@agent-hangar/shared';
import { ApiConflictError } from './api.ts';

const syncStatus: SyncStatusDto = { state: 'idle', url: 'https://h', lastPushAt: 1, lastPullAt: 2, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false } };
const launchResult: LaunchResultDto = { run: { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'resume', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 's1', tabs: [] };
```

`harness` の `deps` に `onWindowFocus` を足し、返り値でも呼べるようにする。

```ts
  const focusListeners = new Set<() => void>();
  // deps に足す
    onWindowFocus: (cb) => { focusListeners.add(cb); return () => focusListeners.delete(cb); },
  // 返り値に足す
  return { rt, api, wsHandlers, timers, store, setHash: deps.location.setHash, fireFocus: () => { for (const l of focusListeners) l(); } };
```

次の `describe` を足す。

```ts
describe('同期とこの PC で再開', () => {
  it('今すぐ同期と一時停止はストアの sync を差し替える', async () => {
    const { rt, api } = harness();
    rt.start();
    rt.emit({ type: 'sync.now' });
    await flush();
    expect(api.syncNow).toHaveBeenCalled();
    expect(rt.getStore().sync?.state).toBe('idle');
    rt.emit({ type: 'sync.pause', paused: true });
    await flush();
    expect(api.syncPause).toHaveBeenCalledWith(true);
    expect(rt.getStore().sync?.state).toBe('paused');
  });
  it('窓が前面に来たら syncFocus を呼び、失敗してもトーストを出さない', async () => {
    const { rt, api, fireFocus } = harness({ syncFocus: vi.fn(async () => { throw new Error('500 /api/sync/focus'); }) });
    rt.start();
    fireFocus();
    await flush();
    expect(api.syncFocus).toHaveBeenCalledTimes(1);
    expect(rt.getState().toasts).toEqual([]);
    rt.stop();
    fireFocus();
    await flush();
    expect(api.syncFocus).toHaveBeenCalledTimes(1);
  });
  it('この PC で再開の 409 は確認ダイアログになる', async () => {
    const { rt, api } = harness({ resumeHere: vi.fn(async () => { throw new ApiConflictError({ error: 'local_smaller', localSize: 10, remoteSize: 99 }); }) });
    rt.start();
    rt.emit({ type: 'session.resumeHere', id: 's1' });
    await flush();
    expect(api.resumeHere).toHaveBeenCalledWith('s1', false);
    expect(rt.getState().overlay).toEqual({ kind: 'confirm', confirm: { kind: 'overwriteTranscript', sessionId: 's1', localSize: 10, remoteSize: 99 } });
    expect(rt.getState().toasts).toEqual([]);
  });
  it('参加トークンと設定の下見と取り込み', async () => {
    const { rt, api } = harness();
    rt.start();
    rt.emit({ type: 'sync.joinToken.show' });
    await flush();
    expect(rt.getStore().joinToken).toBe('tok');
    rt.emit({ type: 'sync.config.preview' });
    await flush();
    expect(api.configPreview).toHaveBeenCalled();
    expect(rt.getStore().configPreview).toEqual({ entries: [], confirmed: false });
    rt.emit({ type: 'sync.config.apply' });
    await flush();
    expect(api.configPull).toHaveBeenCalled();
    expect(rt.getState().toasts[0]?.message).toContain('2 件');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/runtime`
Expected: FAIL（`syncNow` が ApiClient に無い）

- [ ] **Step 3: API クライアントを直す**

`packages/ui/src/runtime/api.ts` を直す。

```ts
import type { BootstrapDto, ConfigPreviewDto, DeviceDto, EventsPageDto, LaunchResultDto, ProjectDto, ProjectStatus, ResolveAction, ResumeHereConflictDto, SearchParamsDto, SearchResultDto, SettingsDto, SyncStatusDto } from '@agent-hangar/shared';

/** 「この PC で再開」で手元の本文の方が小さいときの 409。UI は確認ダイアログにする。 */
export class ApiConflictError extends Error {
  constructor(public readonly body: ResumeHereConflictDto) { super('local_smaller'); this.name = 'ApiConflictError'; }
}
```

`ApiClient` に「インターフェース一覧」の 9 個のメソッドを足し、`call` の失敗の扱いを替える。
既存の `call` は本文を 1 度だけ読んで `{ error }` を Error のメッセージにしているので、その読み取りを使い回して 409 だけを分ける。

```ts
    if (!r.ok) {
      // サーバが { error } を返せばその理由を、無ければ状態番号と経路を投げる。
      const body = (await r.json().catch(() => null)) as { error?: string; localSize?: number; remoteSize?: number } | null;
      // 「この PC で再開」の 409 だけは、確認ダイアログを出すために型の付いた失敗にする。
      if (r.status === 409 && body?.error === 'local_smaller') throw new ApiConflictError(body as ResumeHereConflictDto);
      throw new Error(body?.error ?? `${r.status} ${path}`);
    }
```

`createApi` の返り値に足す（`post` は既存の補助である）。

```ts
    syncStatus: () => call('/api/sync/status'),
    syncNow: () => post('/api/sync/now'),
    syncPause: (paused) => post('/api/sync/pause', { paused }),
    syncFocus: () => post('/api/sync/focus'),
    resumeHere: (sessionId, overwrite) => post(`/api/sessions/${sessionId}/resume-here`, { overwrite }),
    joinToken: () => call('/api/sync/joinToken'),
    configPreview: () => call('/api/sync/config/preview'),
    configPull: () => post('/api/sync/config/pull'),
    devices: () => call('/api/devices'),
```

- [ ] **Step 4: ランタイムを直す**

`packages/ui/src/runtime/runtime.ts` を直す。

```ts
import { applyBootstrap, applyConfigPreview, applyEventsPage, applyJoinToken, applySearch, applyServerEvent, eventsKey, initialStore, setEventsLoading, type Store } from '../store/store.ts';
import { ApiConflictError, type ApiClient } from './api.ts';

export type RuntimeDeps = {
  ...フェーズ 1 から 3 の項目...;
  /** 窓が前面に来たことを知らせる。返り値で購読を外す。 */
  onWindowFocus?: (cb: () => void) => () => void;
};
```

`runEffect` の `switch` に足す。

```ts
      case 'api.syncNow': deps.api.syncNow().then((s) => setStore({ ...store, sync: s })).catch(fail); return;
      case 'api.syncPause': deps.api.syncPause(e.paused).then((s) => setStore({ ...store, sync: s })).catch(fail); return;
      // 前面化は静かに失敗させる。窓を触るたびに赤い通知が出ると邪魔になる。
      case 'api.syncFocus': deps.api.syncFocus().catch(() => {}); return;
      case 'api.resumeHere':
        deps.api.resumeHere(e.sessionId, e.overwrite).catch((err: unknown) => {
          if (err instanceof ApiConflictError) dispatch({ kind: 'runtime', event: { type: 'api.conflict', kind: 'resumeHere', sessionId: e.sessionId, localSize: err.body.localSize, remoteSize: err.body.remoteSize } });
          else fail(err);
        });
        return;
      case 'api.configPreview': deps.api.configPreview().then((p) => setStore(applyConfigPreview(store, p))).catch(fail); return;
      case 'api.configPull': deps.api.configPull().then((r) => dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message: `${r.applied} 件を取り込みました（競合 ${r.conflicts} 件）` } })).catch(fail); return;
      case 'api.joinToken': deps.api.joinToken().then((r) => setStore(applyJoinToken(store, r.token))).catch(fail); return;
```

`start()` の末尾に足し、`stop()` で外す。

```ts
      unsubFocus = deps.onWindowFocus?.(() => dispatch({ kind: 'runtime', event: { type: 'window.focus' } })) ?? null;
```

```ts
    stop() { ws?.close(); unsubHash?.(); unsubFocus?.(); unsubFocus = null; },
```

`let unsubFocus: (() => void) | null = null;` を `unsubHash` の隣に足す。

`packages/ui/src/main.tsx` の `createRuntime` の引数に足す。

```ts
  onWindowFocus: (cb) => { window.addEventListener('focus', cb); return () => window.removeEventListener('focus', cb); },
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui/src/runtime && npx tsc -p packages/ui`
Expected: PASS（同期とこの PC で再開の 4 件を含む）

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/runtime packages/ui/src/main.tsx
git commit -m "feat(ui): sync api client methods, window focus pulls and 409 conflicts"
```

---

### Task 22: Presenter の同期とロック

**Files:**
- Modify: `packages/ui/src/presenters/shell.ts`、`packages/ui/src/presenters/session.ts`、`packages/ui/src/presenters/settings.ts`
- Test: `packages/ui/src/presenters/presenters.test.ts`（追加）

**Interfaces:**
- Consumes: `State.sync`、`State.pending`、`Store.sync`、`Store.devices`、`Store.joinToken`（Task 20）、`SessionDto.lock` と `remoteOnly`（Task 1 と Task 15）、`relativeTime`（`presenters/format.ts`）。
- Produces:
  ```ts
  // presenters/shell.ts
  export type SyncProps = { visible: boolean; state: SyncStateKind; label: string; pending: number; paused: boolean };
  export type ShellProps = { ...; sync: SyncProps };
  export function presentShell(state: State, store: Store, now?: number): ShellProps;
  // presenters/session.ts
  export type SessionProps = { ...; lock: { deviceName: string; stale: boolean; heartbeat: string } | null; remoteOnly: boolean; canResume: boolean; canResumeHere: boolean };
  // presenters/settings.ts
  export type CloudSettingsProps = { configured: boolean; url: string | null; state: SyncStateKind; paused: boolean; lastPullAt: string; pending: number; devices: { name: string; platform: string; lastSeen: string; self: boolean }[]; joinToken: string | null; syncClaudeConfig: boolean; configConfirmed: boolean };
  export type SettingsProps = { ...; cloud: CloudSettingsProps };
  export function presentSettings(state: State, store: Store, now?: number): SettingsProps;
  ```
- `presentShell` と `presentSettings` に相対時刻のための `now` を足す（既定は `Date.now()`）。Root は `useNow()` の値を渡す。
- 他端末で実行中のセッションは、再開とフォークを無効にする。手元に本文が無く、誰も動かしていないセッション（`remoteOnly` かつ `lock === null`）は「この PC で再開」を出す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/presenters/presenters.test.ts` に足す（`session()` の作り手には Task 1 で `lock: null, remoteOnly: false` が入っている）。

```ts
import type { SyncStatusDto } from '@agent-hangar/shared';

const NOW = 1_700_000_000_000;
const withSync = (over: Partial<SyncStatusDto> = {}): SyncStatusDto => ({ state: 'idle', url: 'https://h', lastPushAt: NOW - 1000, lastPullAt: NOW - 60_000, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false }, ...over });
const lock = { deviceId: 'dev-b', deviceName: 'mini', runId: 'r1', heartbeatAt: NOW - 30_000, stale: false };

describe('同期の Presenter', () => {
  it('ヘッダーの同期状態は種別ごとに文言が変わる', () => {
    const s = { ...initialState(), sync: { kind: 'idle' as const, lastAt: NOW - 60_000 }, pending: 2 };
    expect(presentShell(s, initialStore(), NOW).sync).toEqual({ visible: true, state: 'idle', label: '同期 1 分前', pending: 2, paused: false });
    expect(presentShell({ ...s, sync: { kind: 'off' } }, initialStore(), NOW).sync).toMatchObject({ visible: false, state: 'off' });
    expect(presentShell({ ...s, sync: { kind: 'pushing' } }, initialStore(), NOW).sync).toMatchObject({ state: 'pushing', label: '送信中' });
    expect(presentShell({ ...s, sync: { kind: 'paused' } }, initialStore(), NOW).sync).toMatchObject({ state: 'paused', label: '一時停止中', paused: true });
    expect(presentShell({ ...s, sync: { kind: 'error', message: '切れました' } }, initialStore(), NOW).sync).toMatchObject({ state: 'error', label: '同期エラー: 切れました' });
  });
  it('Settings のクラウドの節', () => {
    const store = { ...initialStore(), sync: withSync({ pending: 3 }), devices: [{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: NOW - 120_000, self: true }], joinToken: 'tok', settings: { workspaceRoot: '/w', claudeDir: '/c', syncClaudeConfig: true } };
    const p = presentSettings(initialState(), store, NOW).cloud;
    expect(p).toMatchObject({ configured: true, url: 'https://h', state: 'idle', paused: false, pending: 3, lastPullAt: '1 分前', joinToken: 'tok', syncClaudeConfig: true, configConfirmed: false });
    expect(p.devices).toEqual([{ name: 'mac', platform: 'darwin', lastSeen: '2 分前', self: true }]);
    expect(presentSettings(initialState(), initialStore(), NOW).cloud).toMatchObject({ configured: false, url: null, state: 'off', joinToken: null });
  });
});

describe('セッションのロック', () => {
  it('他端末で実行中なら再開もこの PC で再開も止める', () => {
    const store = { ...initialStore(), sessions: { s1: { ...session('s1', 'u1'), lock, remoteOnly: true } } };
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.lock).toEqual({ deviceName: 'mini', stale: false, heartbeat: '1 分前' });
    expect(p.canResume).toBe(false);
    expect(p.canResumeHere).toBe(false);
    expect(p.remoteOnly).toBe(true);
  });
  it('写しだけで誰も動かしていなければ、この PC で再開ができる', () => {
    const store = { ...initialStore(), sessions: { s1: { ...session('s1', 'u1'), lock: null, remoteOnly: true } } };
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.canResumeHere).toBe(true);
    expect(p.canResume).toBe(false);
  });
  it('手元に本文があってロックが無ければ普通に再開できる', () => {
    const store = { ...initialStore(), sessions: { s1: session('s1', 'u1') } };
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p).toMatchObject({ lock: null, remoteOnly: false, canResume: true, canResumeHere: false });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/presenters`
Expected: FAIL（`sync` が ShellProps に無い、`lock` が SessionProps に無い）

- [ ] **Step 3: shell.ts と settings.ts を直す**

`packages/ui/src/presenters/shell.ts`：

```ts
import type { IndexProgressDto, Route, SyncStateKind } from '@agent-hangar/shared';
import { relativeTime } from './format.ts';

export type SyncProps = { visible: boolean; state: SyncStateKind; label: string; pending: number; paused: boolean };
// 既存の ShellProps の末尾に sync を足す。usage はフェーズ 3 の項目なので消さない。
export type ShellProps = { nav: NavItem[]; crumbs: { label: string; route?: Route }[]; searchText: string; connection: State['connection']; index: IndexProgressDto; indexLabel: string | null; usage: UsageProps; sync: SyncProps };

/** ヘッダーに出す同期の一行。off の端末では出さない。 */
function syncProps(state: State, now: number): SyncProps {
  const s = state.sync;
  const label =
    s.kind === 'off' ? ''
    : s.kind === 'pushing' ? '送信中'
    : s.kind === 'pulling' ? '受信中'
    : s.kind === 'paused' ? '一時停止中'
    : s.kind === 'error' ? `同期エラー: ${s.message}`
    : s.lastAt === null ? '同期の準備中' : `同期 ${relativeTime(s.lastAt, now)}`;
  return { visible: s.kind !== 'off', state: s.kind, label, pending: state.pending, paused: s.kind === 'paused' };
}

// 引数はこれまでのまま（now は必須）。返り値に sync を足す。
export function presentShell(state: State, store: Store, now: number): ShellProps {
  ...これまでの組み立て...
  return { nav: ..., crumbs, searchText: state.search.text, connection: state.connection, index: idx, indexLabel, usage, sync: syncProps(state, now) };
}
```

`packages/ui/src/presenters/settings.ts`：

```ts
import type { IndexProgressDto, SyncStateKind } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { relativeTime } from './format.ts';

export type CloudSettingsProps = { configured: boolean; url: string | null; state: SyncStateKind; paused: boolean; lastPullAt: string; pending: number; devices: { name: string; platform: string; lastSeen: string; self: boolean }[]; joinToken: string | null; syncClaudeConfig: boolean; configConfirmed: boolean };
// 既存の SettingsProps の末尾に cloud を足す。
// フェーズ 3 までの項目（tmuxPath、terminalApp、codePath、mcpInstallCommand、lmStudio*、summary*、summarizer*、statusline*、usageAggregate）は消さない。
export type SettingsProps = { workspaceRoot: string; claudeDir: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; sessionCount: number; projectCount: number; ...フェーズ 3 までの項目...; cloud: CloudSettingsProps };

// 第 3 引数 now を新しく足す（既存の呼び出しは 2 引数なので既定値を置く）。
export function presentSettings(_state: State, store: Store, now: number = Date.now()): SettingsProps {
  const sync = store.sync;
  const cloud: CloudSettingsProps = {
    configured: sync !== null && sync.state !== 'off',
    url: sync?.url ?? null,
    state: sync?.state ?? 'off',
    paused: sync?.state === 'paused',
    lastPullAt: relativeTime(sync?.lastPullAt ?? null, now),
    pending: sync?.pending ?? 0,
    devices: store.devices.map((d) => ({ name: d.name, platform: d.platform, lastSeen: relativeTime(d.lastSeenAt, now), self: d.self })),
    joinToken: store.joinToken,
    syncClaudeConfig: store.settings?.syncClaudeConfig ?? false,
    configConfirmed: sync?.claudeConfig.confirmed ?? false,
  };
  return { ...これまでの組み立て..., cloud };
}
```

- [ ] **Step 4: session.ts を直す**

`packages/ui/src/presenters/session.ts` の `SessionProps` に `lock`、`remoteOnly`、`canResumeHere` を足し、`canResume` と `canFork` にロックと写しだけの条件を掛ける。

```ts
export type SessionProps = { ...これまでの項目...; lock: { deviceName: string; stale: boolean; heartbeat: string } | null; remoteOnly: boolean; canResume: boolean; canResumeHere: boolean };
```

`presentSession` の `base` に `lock: null, remoteOnly: false, canResumeHere: false` を足し（`canResume` と `canFork` は `base` に既にある）、`s` がある側の返り値に足す。

```ts
    lock: s.lock ? { deviceName: s.lock.deviceName, stale: s.lock.stale, heartbeat: relativeTime(s.lock.heartbeatAt, now) } : null,
    remoteOnly: s.remoteOnly,
    // 他端末が動かしている間は再開もフォークもさせない。手元で続けたいときは「この PC で再開」に回す。
    // 実物は canResume も canFork も `s.hasTranscript && idle` なので、その式に条件を掛ける。
    canResume: s.hasTranscript && idle && s.lock === null && !s.remoteOnly,
    canFork: s.hasTranscript && idle && s.lock === null && !s.remoteOnly,
    canResumeHere: s.remoteOnly && s.lock === null,
```

`base`（セッションが無いときの返り値）にも `lock: null, remoteOnly: false, canResumeHere: false` を足す。`canResume` と `canFork` は `base` に既にある。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui/src/presenters && npx tsc -p packages/ui`
Expected: PASS（同期 2 件、ロック 3 件を含む）。`tsc` は View がまだ `sync` の props を受けていない分で失敗が残る（Task 23 で直す）。

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/presenters
git commit -m "feat(ui): presenters for sync status, session lock and resume-here"
```

---

### Task 23: ヘッダーの同期状態とセッション画面のロック

**Files:**
- Create: `packages/ui/src/views/SyncStatus.tsx`、`packages/ui/src/styles/sync.css`
- Modify: `packages/ui/src/views/Header.tsx`、`packages/ui/src/views/Shell.tsx`、`packages/ui/src/views/SessionScreen.tsx`、`packages/ui/src/views/primitives/Icon.tsx`、`packages/ui/src/main.tsx`
- Test: `packages/ui/src/views/Shell.test.tsx`（追加）、`packages/ui/src/views/SessionScreen.test.tsx`（追加）

**Interfaces:**
- Consumes: `SyncProps`（`presenters/shell.ts`）、`SessionProps` の `lock`、`remoteOnly`、`canResume`、`canResumeHere`（Task 22）。
- Produces:
  ```ts
  // views/SyncStatus.tsx
  export function SyncStatus(props: SyncProps): JSX.Element | null;
  // views/Header.tsx（usage はフェーズ 3 の既存 props なので残す）
  export function Header(props: { crumbs: ShellProps['crumbs']; searchText: string; connection: ShellProps['connection']; indexLabel: string | null; usage: UsageProps; sync: SyncProps }): JSX.Element;
  ```
- `SyncStatus` は props だけで描き、状態を持たない。`visible` が false なら何も描かない。文言の右に「今すぐ同期」と「一時停止」「再開」を置き、押すと `sync.now` と `sync.pause` の Intent を出す。
- `Shell` は `props.sync` を `Header` に渡す。位置は `<span className="spacer" />` の直後、使用量ゲージの手前にする。
- アイコンは `views/primitives/Icon.tsx` を通してだけ使う。View から `lucide-react` を直接 import しない。新しいボタンのために `ICONS` に 1 つ足す。
- CSS は `base.css` に足さず、新しい `packages/ui/src/styles/sync.css` に書いて `main.tsx` から import する（フェーズ 3 で決めた、View のまとまりごとに分ける方針に従う）。
- セッション画面は、ロックがあれば見出しの下に「<端末名> で実行中」と最終確認の時刻を出し、再開とフォークを無効にする。`stale` なら「応答がありません」を添える。`canResumeHere` なら「この PC で再開」を出す。引き継ぎのボタンはこのフェーズでは出さない。
- 色は既存のトークンを使い、暗い配色は持たない（2026-09-17 の決定）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/Shell.test.tsx` の `props` に `sync: { visible: false, state: 'off' as const, label: '', pending: 0, paused: false }` を足し、次を足す。

```ts
  it('同期の状態と操作を出し、off では出さない', () => {
    const onIntent = vi.fn();
    const sync = { visible: true, state: 'idle' as const, label: '同期 1 分前', pending: 2, paused: false };
    const { rerender } = render(<IntentRoot onIntent={onIntent}><Shell {...props} sync={sync} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.getByText('同期 1 分前')).toBeInTheDocument();
    expect(screen.getByText('未送信 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.now' });
    fireEvent.click(screen.getByRole('button', { name: '一時停止' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.pause', paused: true });
    rerender(<IntentRoot onIntent={onIntent}><Shell {...props} sync={{ ...sync, state: 'paused', label: '一時停止中', paused: true }} overlays={null}><div /></Shell></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '同期を再開' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.pause', paused: false });
    rerender(<IntentRoot onIntent={onIntent}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.queryByRole('button', { name: '今すぐ同期' })).toBeNull();
  });
```

`packages/ui/src/views/SessionScreen.test.tsx` の `base` に `lock: null, remoteOnly: false, canResumeHere: false` を足す（`canResume` と `canFork` は既にあるので、この describe では `true` にしておく）。そのうえで次を足す。

```ts
  it('他端末で実行中なら再開とフォークを止める', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} canResume={false} canFork={false} lock={{ deviceName: 'mini', stale: false, heartbeat: '1 分前' }} /></IntentRoot>);
    expect(screen.getByText('mini で実行中')).toBeInTheDocument();
    expect(screen.getByText('最終確認 1 分前')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再開' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'フォーク' })).toBeDisabled();
  });
  it('応答が無いロックはその旨を添える', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} canResume={false} lock={{ deviceName: 'mini', stale: true, heartbeat: '5 分前' }} /></IntentRoot>);
    expect(screen.getByText('応答がありません')).toBeInTheDocument();
  });
  it('写しだけのセッションはこの PC で再開を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionScreen {...base} canResume={false} remoteOnly canResumeHere /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'この PC で再開' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.resumeHere', id: 's1' });
    expect(screen.getByText('本文は他の端末にあります')).toBeInTheDocument();
  });
  it('ロックが無ければこの PC で再開は出ない', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} /></IntentRoot>);
    expect(screen.queryByRole('button', { name: 'この PC で再開' })).toBeNull();
    expect(screen.getByRole('button', { name: '再開' })).not.toBeDisabled();
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/Shell packages/ui/src/views/SessionScreen`
Expected: FAIL（`SyncStatus` が無い、ロックの表示が無い）

- [ ] **Step 3: SyncStatus と Header を書く**

`packages/ui/src/views/SyncStatus.tsx`：

```ts
import { useEmit } from '../intent/chain.tsx';
import type { SyncProps } from '../presenters/shell.ts';

/** ヘッダーの同期状態。props だけで描き、状態を持たない。 */
export function SyncStatus(props: SyncProps) {
  const emit = useEmit();
  if (!props.visible) return null;
  return (
    <span className="sync" data-state={props.state} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className={props.state === 'error' ? 'mono' : 'mono faint'}>{props.label}</span>
      {props.pending > 0 && <span className="faint">未送信 {props.pending}</span>}
      <button className="btn btn-sm" onClick={() => emit({ type: 'sync.now' })}>今すぐ同期</button>
      <button className="btn btn-sm" onClick={() => emit({ type: 'sync.pause', paused: !props.paused })}>{props.paused ? '同期を再開' : '一時停止'}</button>
    </span>
  );
}
```

`packages/ui/src/views/Header.tsx` の props に `sync: SyncProps` を足し、`<span className="spacer" />` の直後、`<span className="gauges">` の手前に `<SyncStatus {...props.sync} />` を置く。既存の `usage` の props と使用量ゲージはそのまま残す。
`packages/ui/src/views/Shell.tsx` の `Header` の呼び出しに `sync={props.sync}` を足す（既存の `usage={props.usage}` は残す）。

`packages/ui/src/styles/sync.css` を新しく作る。色と大きさは `tokens.css` にある名前だけを使う。

```css
/* 同期の一行と、そこに並べる小さいボタン。 */
.btn-sm { height: calc(var(--row-h) - 6px); padding: 0 calc(var(--u) * 2); font-size: var(--fs-sm); }
```

`packages/ui/src/main.tsx` の `import './styles/settings.css';` の後ろに `import './styles/sync.css';` を足す。

- [ ] **Step 4: セッション画面を直す**

`packages/ui/src/views/SessionScreen.tsx` のボタンの並びを替える。

先に `packages/ui/src/views/primitives/Icon.tsx` の `ICONS` に 1 つ足す（import も同じ行に加える）。

```ts
  resumeHere: Download,
```

そのうえで、既存の「再開」と「フォーク」の行はそのままに、その後ろに 1 つボタンを差し込む。既存の `<Icon name="..." />` は消さない。

```tsx
        <button className="btn" disabled={!props.canResume} onClick={() => emit({ type: 'session.resume', id })}><Icon name="resume" />再開</button>
        <button className="btn" disabled={!props.canFork} onClick={() => emit({ type: 'session.fork', id })}><Icon name="fork" />フォーク</button>
        {props.canResumeHere && <button className="btn" onClick={() => emit({ type: 'session.resumeHere', id })}><Icon name="resumeHere" />この PC で再開</button>}
        <button className="btn" onClick={() => emit({ type: 'session.openEditor', sessionId: id })}><Icon name="openEditor" />VS Code で開く</button>
```

その下の一行（`cwd` などを並べている `div`）の中に足す。

```tsx
        {props.lock && <span className="lock">{props.lock.deviceName} で実行中</span>}
        {props.lock && <span>最終確認 {props.lock.heartbeat}</span>}
        {props.lock?.stale && <span className="warn">応答がありません</span>}
        {props.remoteOnly && <span>本文は他の端末にあります</span>}
```

`!props.hasTranscript && <span>本文がありません</span>` はそのまま残す。
`packages/ui/src/styles/sync.css` に足す（`base.css` には足さない）。色は `tokens.css` にある名前だけを使う。

```css
.lock { color: var(--accent); }
.warn { color: var(--waiting); }
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui/src/views && npx tsc -p packages/ui`
Expected: PASS（Shell 1 件、SessionScreen 4 件を足した数）

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/views packages/ui/src/styles packages/ui/src/main.tsx
git commit -m "feat(ui): header sync status and session lock with resume-here"
```

---

### Task 24: 確認と取り込みのダイアログ、Settings のクラウドの節、Root の結線

**Files:**
- Create: `packages/ui/src/views/ConfirmDialog.tsx`、`packages/ui/src/views/ConfigPreviewDialog.tsx`、`packages/ui/src/views/dialogs.test.tsx`
- Modify: `packages/ui/src/views/SettingsScreen.tsx`、`packages/ui/src/Root.tsx`
- Test: `packages/ui/src/views/dialogs.test.tsx`、`packages/ui/src/views/screens.test.tsx`（追加）、`packages/ui/src/Root.test.tsx`（追加）

**Interfaces:**
- Consumes: `ConfirmRequest`（Task 20）、`ConfigPreviewDto`、`CloudSettingsProps`（Task 22）。
- Produces:
  ```ts
  export function ConfirmDialog(props: { confirm: ConfirmRequest }): JSX.Element;
  export function ConfigPreviewDialog(props: { preview: ConfigPreviewDto | null }): JSX.Element;
  ```
- `ConfirmDialog` は手元と写しの大きさを並べ、「上書きして再開」で `session.resumeHere { overwrite: true }` を出す。
- `ConfigPreviewDialog` は取り込む内容の一覧（作成、上書き、競合、変更なし）を出し、「取り込む」で `sync.config.apply` を出す。まだ一覧が来ていなければ読み込み中と出す。
- Settings の「クラウド同期」の節は「要約器」の後、「使用量」の前に置く（実物に「Provider」の節は無い）。中身は状態（URL、最終 pull、未送信件数、端末の一覧）、「今すぐ同期」「一時停止」、「参加トークンを表示」（押すまで隠し、表示時に注意書きを添える）、Claude Code 設定の同期のチェックと「取り込み内容を確認」である。
- 「次のフェーズで追加される設定」の節は残し、文言を引き継ぎだけに絞る（クラウド同期はこのフェーズで実装するため）。
- Root はオーバーレイに 2 つのダイアログを足し、`presentSettings` に `now` を渡す（`presentShell` には既に渡している）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/dialogs.test.tsx`：

```ts
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { ConfigPreviewDialog } from './ConfigPreviewDialog.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';

describe('ConfirmDialog', () => {
  it('大きさを並べ、上書きして再開を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={{ kind: 'overwriteTranscript', sessionId: 's1', localSize: 1024, remoteSize: 4096 }} /></IntentRoot>);
    expect(screen.getByText('この PC の本文 1.0 KB')).toBeInTheDocument();
    expect(screen.getByText('他の端末の本文 4.0 KB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '上書きして再開' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.resumeHere', id: 's1', overwrite: true });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('ConfigPreviewDialog', () => {
  it('一覧を出し、取り込むが Intent になる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfigPreviewDialog preview={{ confirmed: false, entries: [
      { path: 'CLAUDE.md', action: 'create', localMtime: null, remoteMtime: 2, remoteDevice: 'mini', size: 10 },
      { path: 'skills/foo/SKILL.md', action: 'conflict', localMtime: 1, remoteMtime: 2, remoteDevice: 'mini', size: 20 },
    ] }} /></IntentRoot>);
    expect(screen.getByText('CLAUDE.md')).toBeInTheDocument();
    expect(screen.getByText('新しく作る')).toBeInTheDocument();
    expect(screen.getByText('競合（控えを残します）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取り込む' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.config.apply' });
  });
  it('一覧がまだ来ていなければ読み込み中', () => {
    render(<IntentRoot onIntent={() => {}}><ConfigPreviewDialog preview={null} /></IntentRoot>);
    expect(screen.getByText('取り込む内容を調べています')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取り込む' })).toBeDisabled();
  });
});
```

`packages/ui/src/views/screens.test.tsx` の `SettingsScreen` の props に `cloud` を足し、次を足す。

```ts
  it('Settings のクラウド同期の節', () => {
    const onIntent = vi.fn();
    const cloud = { configured: true, url: 'https://h.workers.dev', state: 'idle' as const, paused: false, lastPullAt: '1 分前', pending: 2, devices: [{ name: 'mac', platform: 'darwin', lastSeen: '今', self: true }, { name: 'mini', platform: 'darwin', lastSeen: '3 分前', self: false }], joinToken: null, syncClaudeConfig: false, configConfirmed: false };
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps} cloud={cloud} /></IntentRoot>);
    expect(screen.getByText('https://h.workers.dev')).toBeInTheDocument();
    expect(screen.getByText('未送信 2 件')).toBeInTheDocument();
    expect(screen.getByText('mini')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '参加トークンを表示' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.joinToken.show' });
    fireEvent.click(screen.getByLabelText('Claude Code の設定を同期する'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { syncClaudeConfig: true } });
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps} cloud={{ ...cloud, joinToken: 'tok-abc', syncClaudeConfig: true }} /></IntentRoot>);
    expect(screen.getByText('tok-abc')).toBeInTheDocument();
    expect(screen.getByText('このトークンを持つ人は、あなたのセッションを読み書きできます。渡す相手に気をつけてください。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取り込み内容を確認' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.config.preview' });
  });
  it('同期が未設定なら参加の案内を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps} cloud={{ configured: false, url: null, state: 'off', paused: false, lastPullAt: '不明', pending: 0, devices: [], joinToken: null, syncClaudeConfig: false, configConfirmed: false }} /></IntentRoot>);
    expect(screen.getByText('hangar setup cloud か hangar join <token> で始められます')).toBeInTheDocument();
  });
```

`packages/ui/src/Root.test.tsx` の `boot` に `sync` と `devices` を足し、偽 API に Task 21 の 9 個のメソッドを足す。
このフェーズで足すオーバーレイは確認と取り込みの下見だけで、どちらも既存のテストが通る形なので、Root には新しいテストを足さない。
既存のテストが `BootstrapDto` と `ApiClient` の新しい項目で落ちないようにするのが、ここでの作業である。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views packages/ui/src/Root`
Expected: FAIL（ダイアログが無い、`cloud` の節が無い）

- [ ] **Step 3: ダイアログを書く**

`packages/ui/src/views/ConfirmDialog.tsx`：

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { ConfirmRequest } from '../mediator/types.ts';

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

/** 取り消せない上書きの確認。今は本文の置き換えだけを扱う。 */
export function ConfirmDialog(props: { confirm: ConfirmRequest }) {
  const emit = useEmit();
  const c = props.confirm;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="上書きの確認">
      <div className="dialog">
        <div>この PC の本文の方が小さいままです。他の端末の本文で置き換えますか。</div>
        <div className="mono faint">この PC の本文 {kb(c.localSize)}</div>
        <div className="mono faint">他の端末の本文 {kb(c.remoteSize)}</div>
        <div className="faint">置き換える前に ~/.agent-hangar/backups/transcripts/ に控えを取ります。</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="spacer" />
          <button className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <button className="btn btn-primary" onClick={() => emit({ type: 'session.resumeHere', id: c.sessionId, overwrite: true })}>上書きして再開</button>
        </div>
      </div>
    </div>
  );
}
```

`packages/ui/src/views/ConfigPreviewDialog.tsx`：

```tsx
import type { ConfigPreviewAction, ConfigPreviewDto } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';

const ACTION_LABEL: Record<ConfigPreviewAction, string> = { create: '新しく作る', overwrite: '上書きする', conflict: '競合（控えを残します）', skip: '変更なし' };

/** Claude Code 設定の取り込みの下見。押すまで ~/.claude には何も書かない。 */
export function ConfigPreviewDialog(props: { preview: ConfigPreviewDto | null }) {
  const emit = useEmit();
  const p = props.preview;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="取り込み内容の確認">
      <div className="dialog" style={{ minWidth: 520 }}>
        <div><b>~/.claude に取り込む内容</b></div>
        {!p && <div className="muted">取り込む内容を調べています</div>}
        {p && p.entries.length === 0 && <div className="muted">取り込むものはありません</div>}
        {p && p.entries.length > 0 && (
          <div className="list" style={{ maxHeight: 320, overflow: 'auto' }}>
            {p.entries.map((e) => (
              <div key={e.path} className="row" style={{ gridTemplateColumns: '1fr auto' }}>
                <span className="mono">{e.path}</span>
                <span className="faint">{ACTION_LABEL[e.action]}（{e.remoteDevice}）</span>
              </div>
            ))}
          </div>
        )}
        <div className="faint">上書きする前に ~/.agent-hangar/backups/claude-config/ に控えを取ります。</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="spacer" />
          <button className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <button className="btn btn-primary" disabled={!p} onClick={() => emit({ type: 'sync.config.apply' })}>取り込む</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Settings の節と Root を直す**

`packages/ui/src/views/SettingsScreen.tsx` に節を足す（フェーズ 3 の「要約器」の後ろ、「使用量」の前）。参加トークンは押すまで出さない。

```tsx
      <section>
        <h2 className="h2">クラウド同期</h2>
        {!props.cloud.configured && <div className="faint">hangar setup cloud か hangar join &lt;token&gt; で始められます</div>}
        {props.cloud.configured && (
          <>
            <div className="mono muted">{props.cloud.url}</div>
            <div className="faint" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
              <span>状態 {props.cloud.state}</span><span>最終 pull {props.cloud.lastPullAt}</span><span>未送信 {props.cloud.pending} 件</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn" onClick={() => emit({ type: 'sync.now' })}>今すぐ同期</button>
              <button className="btn" onClick={() => emit({ type: 'sync.pause', paused: !props.cloud.paused })}>{props.cloud.paused ? '同期を再開' : '一時停止'}</button>
              <button className="btn" onClick={() => emit({ type: 'sync.joinToken.show' })}>参加トークンを表示</button>
            </div>
            {props.cloud.joinToken && (
              <div style={{ marginTop: 8 }}>
                <div className="mono" style={{ wordBreak: 'break-all' }}>{props.cloud.joinToken}</div>
                <div className="faint">このトークンを持つ人は、あなたのセッションを読み書きできます。渡す相手に気をつけてください。</div>
              </div>
            )}
            <div className="list" style={{ marginTop: 8 }}>
              {props.cloud.devices.map((d) => (
                <div key={d.name + d.lastSeen} className="row" style={{ gridTemplateColumns: '1fr auto auto' }}>
                  <span>{d.name}{d.self && <span className="faint"> この端末</span>}</span>
                  <span className="faint">{d.platform}</span>
                  <span className="faint">{d.lastSeen}</span>
                </div>
              ))}
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 12 }}>
              <input type="checkbox" aria-label="Claude Code の設定を同期する" checked={props.cloud.syncClaudeConfig} onChange={(e) => emit({ type: 'settings.update', patch: { syncClaudeConfig: e.target.checked } })} />
              Claude Code の設定を同期する
            </label>
            <div className="faint">CLAUDE.md、settings.json、skills、memory を端末間で合わせます。~/.claude に書き込むので、取り込む前に内容を確認します。</div>
            <button className="btn" style={{ marginTop: 8 }} disabled={!props.cloud.syncClaudeConfig} onClick={() => emit({ type: 'sync.config.preview' })}>取り込み内容を確認</button>
          </>
        )}
      </section>
```

末尾の「次のフェーズで追加される設定」の節は残し、下の 1 行を「他端末セッションの引き継ぎ（他端末で実行中のセッションを、握手して受け取る）。」に替える。クラウド同期はこのフェーズで実装したので文言から外し、引き継ぎだけを残す。

`packages/ui/src/Root.tsx` を直す。

```tsx
import { ConfigPreviewDialog } from './views/ConfigPreviewDialog.tsx';
import { ConfirmDialog } from './views/ConfirmDialog.tsx';

  // presentShell は既に now を受け取っている。presentSettings にだけ now を渡す形に替える。
    case 'settings': body = <SettingsScreen {...presentSettings(state, store, now)} />; break;

  // 既存の overlays の並びは変えず、2 つを足すだけにする。
  const overlays = (
    <>
      {unresolvedId && <ResolveProjectDialog ... />}
      {newSession && <NewSessionDialog ... />}
      {overlay.kind === 'palette' && <CommandPalette ... />}
      {overlay.kind === 'promote' && <PromoteDialog ... />}
      {overlay.kind === 'promoted' && <PromotedDialog ... />}
      {overlay.kind === 'confirm' && <ConfirmDialog confirm={overlay.confirm} />}
      {overlay.kind === 'configPreview' && <ConfigPreviewDialog preview={store.configPreview} />}
      <ToastStack toasts={state.toasts} />
    </>
  );
```

Esc の扱いはフェーズ 3 のまま変えない。
入力中（`typing`）と `resolveProject` を除く条件も、依存配列 `[rt, overlayKind, shortcutTabs, selectedTabId, canSplit]` もそのままにする。
`confirm` と `configPreview` は `overlayKind !== 'none'` に入るので、これだけで Esc が効く。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui && npx tsc -p packages/ui`
Expected: PASS（ダイアログ 3 件、Settings 2 件を足した数）

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/views packages/ui/src/Root.tsx packages/ui/src/Root.test.tsx
git commit -m "feat(ui): overwrite and config preview dialogs with the settings cloud section"
```

---

### Task 25: 実物の Cloudflare で確かめる

**Files:**
- Read: `packages/cloud/src/index.ts`、`packages/cli/src/cloud.ts`
- Create: `docs/plans/phase4-real-run.md`（この確認の記録）

**Interfaces:**
- Consumes: `hangar setup cloud`、`hangar join`、`hangar cloud status`、`hangar cloud teardown`（Task 11 と Task 12）、`hangar start`。
- Produces: 実物で確かめた結果の記録。食い違いがあれば、直すべきタスクと合わせて `docs/plans/phase4-real-run.md` に書く。
- この Task だけが実物の Cloudflare アカウントに触る。使うのは利用者個人のアカウント（wrangler は `<利用者のアカウント>` でログイン済み）で、資源名は捨てる前提の `hangar-dev`（D1 `hangar-dev`、R2 `hangar-dev-files`）にする。
- **費用**：この確認で作る Worker と D1 と R2 は、すべて無料枠の中に収まる。Workers は 1 日 10 万要求まで、D1 は 5GB と 1 日 10 万行の書き込みまで、R2 は 10GB と Class A 100 万回まで無料である。この確認で動かすのは数十要求と数百行と数 MB なので、課金は発生しない。Workers Paid（月 5 ドル）への加入も要らない。片付けまで終えれば残る資源は無い。
- **中断の条件**：`wrangler whoami` が `<利用者のアカウント>` 以外を指していたら止めて利用者に確認する。既に `hangar-dev` という名前の Worker か D1 か R2 があったら止める（他の用途で使っているかもしれないため）。

- [ ] **Step 1: 利用者にデプロイの確認を取る**

次の文面で確認を取り、はっきりした承諾があるまで `wrangler` を実行しない。

```
これから実物の Cloudflare にデプロイします。
  アカウント: <利用者のアカウント>（wrangler whoami の結果を先に見せます）
  作るもの: Worker hangar-dev、D1 hangar-dev、R2 hangar-dev-files
  費用: すべて無料枠の中（Workers 10 万要求/日、D1 5GB と 10 万行/日、R2 10GB）。この確認では数十要求と数 MB しか使わないので課金は発生しません。
  片付け: 確認が終わったら hangar cloud teardown ですべて消します（消す前にもう一度確認します）。
進めてよいですか。
```

Run: `npx wrangler whoami --config packages/cloud/wrangler.jsonc`
Expected: `<利用者のアカウント>` とアカウント ID が出る。違うアカウントなら止める。

Run: `npx wrangler d1 info hangar-dev --config packages/cloud/wrangler.jsonc; npx wrangler r2 bucket list --config packages/cloud/wrangler.jsonc | grep hangar-dev`
Expected: どちらも見つからない。見つかったら止めて利用者に確認する。

- [ ] **Step 2: 端末 A を用意してデプロイする**

```bash
export HANGAR_A="$HOME/.hangar-dev-a"
export HANGAR_B="$HOME/.hangar-dev-b"
export CLAUDE_A="$HOME/.hangar-dev-claude-a"
export CLAUDE_B="$HOME/.hangar-dev-claude-b"
mkdir -p "$CLAUDE_A/projects" "$CLAUDE_B/projects"
HANGAR_HOME="$HANGAR_A" HANGAR_CLAUDE_DIR="$CLAUDE_A" node packages/cli/src/index.ts setup
HANGAR_HOME="$HANGAR_A" HANGAR_CLAUDE_DIR="$CLAUDE_A" node packages/cli/src/index.ts setup cloud --name hangar-dev
```

Expected: D1 と R2 が作られ、`wrangler deploy` が `https://hangar-dev.<subdomain>.workers.dev` を出し、`/health` が通り、最後に参加トークンが表示される。
参加トークンを控える（次の Step で使う）。所要は 1 分から 2 分。

- [ ] **Step 3: 同じ機械の二台目として参加する**

```bash
HANGAR_HOME="$HANGAR_B" HANGAR_CLAUDE_DIR="$CLAUDE_B" node packages/cli/src/index.ts setup
HANGAR_HOME="$HANGAR_B" HANGAR_CLAUDE_DIR="$CLAUDE_B" node packages/cli/src/index.ts join <Step 2 のトークン>
HANGAR_HOME="$HANGAR_B" HANGAR_CLAUDE_DIR="$CLAUDE_B" node packages/cli/src/index.ts cloud status
```

Expected: 「参加しました」と表示され、`cloud status` が Worker の `ok` と「役割: 参加した端末」と「サーバは停止中」を出す。

- [ ] **Step 4: 両方のサーバを上げてメタデータの同期を見る**

端末 A を 4177、端末 B を 4187 で起動する（別々の端末で走らせる）。

```bash
HANGAR_HOME="$HANGAR_A" HANGAR_CLAUDE_DIR="$CLAUDE_A" node packages/cli/src/index.ts start
HANGAR_HOME="$HANGAR_B" HANGAR_CLAUDE_DIR="$CLAUDE_B" node packages/cli/src/index.ts start --port 4187
```

A のブラウザ（`http://127.0.0.1:4177`）で Settings を開き、クラウド同期の節に端末が 2 台出ることを確かめる。
A でプロジェクトの状態を Paused に変え、30 秒以内に B（`http://127.0.0.1:4187`）で同じ状態になることを確かめる。
B のヘッダーで「今すぐ同期」を押すと、待たずに揃うことを確かめる。

Expected: 端末が 2 台出る。状態の変更が両方向に伝わる。`cloud status` の「未送信」が 0 に戻る。

- [ ] **Step 5: 本文の同期を見る**

A のセッションを 1 つ作る。tmux と claude がある環境なら UI の「新規セッション」で作り、無ければ jsonl を手で置く。

```bash
UUID=$(uuidgen | tr 'A-Z' 'a-z')
mkdir -p "$CLAUDE_A/projects/-tmp-hangar-dev"
printf '%s\n' "$(cat <<JSON
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"クラウド同期の実物確認"}]},"cwd":"/tmp/hangar-dev","timestamp":"2026-09-18T00:00:00.000Z"}
JSON
)" > "$CLAUDE_A/projects/-tmp-hangar-dev/$UUID.jsonl"
```

Expected: 30 秒以内に A が本文を上げ、次の pull で B が `$HANGAR_B/remote/<A の端末 ID>/projects/-tmp-hangar-dev/$UUID.jsonl` に降ろす。
B の UI でそのセッションを開くと本文が読め、検索でも当たる。セッションの見出しに「本文は他の端末にあります」が出る。

```bash
ls -l "$HANGAR_B/remote"/*/projects/-tmp-hangar-dev/
HANGAR_HOME="$HANGAR_B" node -e "const D=require('node:path').join(process.env.HANGAR_HOME,'hangar.db');const db=new (require('better-sqlite3'))(D);console.log(db.prepare('select key, device_id, size from file_sync').all());"
```

- [ ] **Step 6: ロックとこの PC で再開を 1 回通す**

A で `claude` のセッションを起動する（UI の「新規セッション」か、A のセッション画面の「再開」）。
B の同じセッションの画面に「<A の端末名> で実行中」が出て、再開とフォークが押せなくなることを確かめる。
次に A のセッションを止め（ロックが消えるのを待ち）、B で「この PC で再開」を押す。

Expected:
- ロックの間、B では再開とフォークが無効で、最終確認の時刻が出る。
- A を止めて 30 秒以内に、B のロックの表示が消える。
- B の「この PC で再開」が本文を `$CLAUDE_B/projects/<変換名>/<uuid>.jsonl` にコピーして `claude -r` を起動する。
- 手元にも同じ ID の本文があり、そちらが小さいときだけ確認ダイアログが出る。「上書きして再開」で `$HANGAR_B/backups/transcripts/` に控えが残る。

引き継ぎ（握手して run を受け取る）はこのフェーズでは実装しないので、確かめない。

tmux か claude が無くて実際の起動ができない環境では、`runs` 行を手で作ってロックの表示だけを確かめる。

```bash
HANGAR_HOME="$HANGAR_A" node -e "
const path=require('node:path');const Database=require('better-sqlite3');
const db=new Database(path.join(process.env.HANGAR_HOME,'hangar.db'));
const s=db.prepare('select id from sessions limit 1').get();
const now=Date.now();
const dev=JSON.parse(require('node:fs').readFileSync(path.join(process.env.HANGAR_HOME,'device.json'),'utf8'));
db.prepare('insert into runs (id, session_id, device_id, kind, tmux_name, pid, launch_params, started_at, ended_at, end_reason, heartbeat_at, updated_at, deleted_at, origin_device) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('run-manual', s.id, dev.id, 'start', 'hangar-manual', null, '{}', now, null, null, now, now, null, dev.id);
db.prepare('insert into changes (table_name,row_id,op,payload,updated_at,device_id) values (?,?,?,?,?,?)')
  .run('runs','run-manual','upsert', JSON.stringify(db.prepare('select * from runs where id = ?').get('run-manual')), now, dev.id);
"
```

この行が B に届いた後、B のセッション画面に「<A の端末名> で実行中」が出て、再開が無効になることを確かめる。

- [ ] **Step 6b: Claude Code の設定の同期と控えを 1 回通す**

B の Settings で「Claude Code の設定を同期する」を入れ、「取り込み内容を確認」から「取り込む」を押す。

Expected:
- A の `$CLAUDE_A/CLAUDE.md` が B の `$CLAUDE_B/CLAUDE.md` に降りる。
- 上書きが起きたファイルの控えが `$HANGAR_B/backups/claude-config/<yyyyMMdd-HHmmss>/` に残る。
- トーストに「上書きした N 件の控えを ... に置きました」が出る。
- 実物の `~/.claude` には何も書かれていない（`HANGAR_CLAUDE_DIR` を向けているため）。

```bash
find "$HANGAR_B/backups/claude-config" -type f | head
```

- [ ] **Step 7: 結果を記録する**

`docs/plans/phase4-real-run.md` に、通った Step、かかった時間、食い違い、直すべきタスクを書く。
`wrangler` の出力の形が Task 11 の想定と違っていたら、その差分をそのまま貼る。

- [ ] **Step 8: 利用者に片付けの確認を取る**

次の文面で確認を取り、承諾があるまで削除を実行しない。

```
実物確認が終わりました。作った資源を消します。
  消すもの: Worker hangar-dev、D1 hangar-dev（同期したメタデータごと）、R2 hangar-dev-files（上げた本文ごと）
  残るもの: 手元の $HOME/.hangar-dev-a と $HOME/.hangar-dev-b（後で手で消せます）
  本番の箱はこのフェーズでは作りません。使い始めるときに改めて setup cloud を走らせます。
  費用: ここまでの利用はすべて無料枠の中で、課金は発生していません。
消してよいですか。
```

- [ ] **Step 9: 片付ける**

```bash
HANGAR_HOME="$HANGAR_A" node packages/cli/src/index.ts cloud teardown
rm -rf "$HANGAR_A" "$HANGAR_B" "$CLAUDE_A" "$CLAUDE_B"
npx wrangler d1 info hangar-dev --config packages/cloud/wrangler.jsonc
npx wrangler r2 bucket list --config packages/cloud/wrangler.jsonc | grep hangar-dev
```

Expected: teardown は先に「R2 にしか無い本文」を手元へ降ろし、それから R2 のオブジェクト、バケット、Worker、D1 を順に消す。最後の 2 つのコマンドが何も見つけない。
残った失敗があれば teardown が一覧で出すので、その分だけ手で消す。

- [ ] **Step 10: コミット**

```bash
git add docs/plans/phase4-real-run.md
git commit -m "docs: record the real cloudflare run for phase 4 sync"
```

---

### Task 26: 設計文書と README の更新

**Files:**
- Modify: `docs/design.md`、`README.md`
- Read: `docs/plans/phase4-sync.md`（この計画の「前提（この計画で決めたこと）」）、`docs/plans/phase4-real-run.md`（あれば）、`docs/plans/phase4-mismatches.md`（あれば）、`.superpowers/sdd/phase4-sync/task-0-report.md`

**Interfaces:**
- Consumes: 実装した全タスクの結果。
- Produces: 設計文書の「クラウド同期」「データモデル」「原則」「決めた前提と未決事項」「フェーズ」の更新と、README のクラウドの手順。
- 設計文書は仕様の正本なので、実装が設計と違う形に落ち着いた箇所は、実装に合わせて書き換える（逸脱を残したまま放置しない）。

- [ ] **Step 1: 設計文書の「クラウド同期」を実装に合わせる**

`docs/design.md` の「クラウド同期」に、この計画で決めた次の点を織り込む。

- 「構成と setup」に、Worker の D1 は共有テーブルをそのまま写さず `rows` と `changes` の 2 表で持つこと、スキーマは Worker が起動後の最初の要求で整えること、参加用の秘密のハッシュは `wrangler secret put JOIN_SECRET_HASH` で渡すこと、端末トークンは 32 バイトの乱数で D1 にはハッシュだけを置くこと、資源名は既定で Worker と D1 が `hangar`、R2 が `hangar-files` で `--name` で変えられること、`~/.agent-hangar/cloud/wrangler.jsonc` に実物の設定を書きアカウント ID は環境変数で渡すことを足す。
- 「同期対象と暗号化」に、暗号化ファイルの形式（`HGR1` と 8 バイトの nonce 接頭辞、チャンクごとの `flag` と `len` と認証タグ、AAD はチャンク番号と `flag`）と、鍵の導出（`hkdfSync('sha256', joinSecret, 'hangar-salt-v1', 'hangar-file-v1', 32)`）を足す。
- 「同期対象と暗号化」の本文の説明を、**差分ではなくファイル全体を gzip して上げ直す**形に直す。R2 は部分更新ができないためである。サブエージェントの本文も `transcripts/<端末 ID>/<sessionId>/subagents/agent-<hex>.jsonl.gz` で上げることを足す。
- 「同期対象と暗号化」の設定の同期に、対象の一覧（`CLAUDE.md`、`settings.json`、statusline スクリプト、`skills/**`、`memory/**`、`projects/*/memory/**`）、除外（`node_modules`、`.git`、`__pycache__`、`.venv`、シンボリックリンク、1MB 超）、削除は同期しないこと、`$HOME` ではなく `__HANGAR_HOME__` を目印に使うこと、Settings での明示の有効化と取り込み前の確認が要ること、**上書きの前に必ず `~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ書き戻さないこと**を足す。
- 「タイミングと競合」に、push は 1 回 40 行まで、pull は 1 回 500 行まで、push には最小間隔 10 秒があること、ローカルの `changes` は push 済みで 7 日を過ぎたら消すこと、Worker の `changes` は 14 日と全端末の読み終わりで削ること、削った区間を読み逃した端末には `410` を返して全件の再同期を求めること、`GET /changes` は自端末の変更を除き `GET /rows` は除かないこと、無料枠の 80% で同期を自動で一時停止することを足す。
- 「タイミングと競合」に、メモの競合では負けた方の本文を `memo.conflict-<端末名>-<時刻>.md` として隣に残すことを足す。
- 「他端末セッションのロックと引き継ぎ」を、**このフェーズではロックと「この PC で再開」までを実装し、握手による引き継ぎは後のフェーズに送った**という形に直す。ロックの判定（他端末の生きた run、heartbeat が 2 分以内）、ロック中は再開とフォークを止めること、「この PC で再開」は手元の本文の方が小さいときだけ確認を出し上書きの前に控えを取ることを書く。引き継ぎの段落は「未実装」と明示して残し、`EndReason` に `taken_over` は足していないことを添える。
- 他端末の本文の索引化について、`sessions` と `session_summaries` には書かず端末ローカルの表だけを書くこと、同じセッションの本文は手元を優先し無ければ最新の写しを 1 つだけ索引化すること（譲ったセッションは手元を優先しない）を足す。

- [ ] **Step 2: データモデルと原則を直す**

- 「端末ローカルのテーブル」の `transcript_files` に `device_id text`（null は手元）を足し、`file_sync` 表を足す。
- 「共有テーブル」の `takeover_requests` の説明に、`state` の遷移（`requested` → `acked` か `forced` か `cancelled`）を 1 行で添え、**フェーズ 4 では誰も書かない表である**ことを添える。
- 「原則」の「読み取り専用」の例外を、実装に合わせて 3 つにする。「この PC で再開」による他端末の本文のコピー、Settings で有効にした Claude Code 設定の取り込み、statusline スクリプトへの追記である。後の 2 つは控えを取ってから書くことも添える。
- 「決めた前提と未決事項」に次を足す。
  - Worker の D1 は `rows` と `changes` の 2 表で持ち、共有テーブルの形をそのまま写さない。
  - 参加トークンは `{url, secret}` の JSON を base64url にした文字列で、Settings からいつでも再表示できる。
  - 端末ローカルの `file_sync` で、上げ下ろしの最後の SHA-256 を持つ。
  - 引き継ぎの握手は `takeover_requests` の同期に乗せる設計だが、フェーズ 4 では実装しない。ロックの表示と「この PC で再開」までに絞った（2026-09-19 の判断）。
  - 同期は自分の端末同士のためのもので、他人と 1 つの箱を共有しない。別の人は自分の Cloudflare アカウントで `setup cloud` を走らせる。
  - 無料枠の 80% で同期を自動で一時停止し、トーストで知らせる。課金される形にはしない。
  - `setup cloud --rotate-secret` は R2 の既存ファイルを復号できなくするので、確認を必須にする。`cloud teardown` は R2 にしか無い本文を先に降ろす。
- 「フェーズ」のフェーズ 4 の行（`docs/design.md` の 997 行目あたり）を、実装済みの表現に直す。

- [ ] **Step 3: 逸脱を記録する**

実装が計画と違った点を、`docs/design.md` の「決めた前提と未決事項」か、当該の節に 1 行ずつ書く。
`docs/plans/phase4-mismatches.md` と `docs/plans/phase4-real-run.md` にある項目のうち、設計に関わるものを拾う。
拾うべき典型は、`wrangler` の出力の形が違って手順を変えた、vitest-pool-workers が使えず miniflare に替えた、Worker の要求本文の上限に当たって本文の分割が要った、の 3 つである。
該当が無ければ「実装は計画どおりで、設計に反映する逸脱は無い」と 1 行書く。

- [ ] **Step 4: README にクラウドの手順を足す**

`README.md` の「現状」を直し、「使い方（フェーズ 1）」の後ろに節を足す。

````markdown
## クラウド同期（フェーズ 4）

自分の Cloudflare アカウントに Worker と D1 と R2 を置き、**自分の端末の間で**セッションを同期します。
無料枠（Workers 10 万要求/日、D1 5GB、R2 10GB）に収まる規模で、枠の 80% に達したら同期を自動で止めます。
他の人と 1 つの箱を共有する使い方は想定していません。
別の人が使うときは、その人の Cloudflare アカウントで `setup cloud` を走らせます。

### 1 台目（同期を始める端末）

```sh
npm run hangar -- setup cloud          # wrangler のログイン、資源の作成、デプロイ、参加トークンの表示
npm run hangar -- cloud status         # Worker とローカルサーバの状態
```

最後に出る **参加トークン** を控えます。
後から見るときは、UI の Settings のクラウド同期の節で「参加トークンを表示」を押します。
このトークンを持つ人はセッションを読み書きできるので、自分の端末以外には渡さないでください。

### 2 台目（自分の別の PC）

```sh
npm run hangar -- setup                # ~/.agent-hangar を作る
npm run hangar -- join <参加トークン>   # 端末を登録し、cloud.json を書く
npm run hangar -- start                # 再起動すると同期が始まる
```

別の人が使いたいときは、`join` ではなくその人の環境で `setup cloud` を走らせます。
デプロイは人ごとに独立し、データは混ざりません。

### 同期するもの

- hangar のメタデータ（プロジェクト、セッション、要約、TODO、メモ）
- セッションの本文（gzip して AES-256-GCM で暗号化。鍵は参加用の秘密から導くので、Cloudflare 側は中身を読めません）
- Claude Code のユーザー設定（既定は off。Settings で有効にし、取り込む内容を確認してから `~/.claude` に書きます。上書きする前に必ず `~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取るので、何を書き換えられたかは後から追えます）

他の端末で実行中のセッションは「<端末名> で実行中」と出て、再開とフォークが押せなくなります。
その端末を止めてから「この PC で再開」を押すと、本文を手元に降ろして続きから始められます。
実行中のまま奪い取る「引き継ぎ」は、まだ作っていません。

### やめるとき

```sh
npm run hangar -- cloud teardown       # Worker と D1 と R2 を消す（2 段の確認あり、取り消せません）
```

`teardown` は、クラウドにしか無い本文を先に手元へ降ろしてから消します。
````

`hangar` は `~/.claude/` を読むだけ、という説明を、次の 2 つが例外であると直す。
他端末の本文を「この PC で再開」でコピーするときと、Settings で有効にした Claude Code 設定の取り込みである。

- [ ] **Step 5: 文書を読み直す**

Run: `npx markdownlint-cli2 docs/design.md README.md 2>/dev/null || true`
Expected: 設定していなければ何も出ない。目視で、一文ごとに改行されていること、地の文にダッシュと中黒が無いこと、コードブロックの言語指定があることを確かめる。

Run: `grep -n "フェーズ 4" docs/design.md README.md`
Expected: 「フェーズ 4 で実装する」と未来形で書いてある箇所（`packages/cloud` の説明など）が残っていない。

- [ ] **Step 6: コミット**

```bash
git add docs/design.md README.md
git commit -m "docs: fold phase 4 sync decisions into the design doc and document cloud setup in the readme"
```

---

## 実行の順序と並列化

依存の無いタスクは並列に実装できる。
実装者を同時に走らせるときは、次の組を目安にする。

1. Task 0（照合）→ Task 1（shared）。ここから先は Task 1 の型に全員が乗る。
2. Task 2 → Task 3 → Task 4、Task 5（Worker。Task 3 の後は 4 と 5 が並列）。並列に Task 6（暗号化）と Task 8（cloud.json とマイグレーション）。
3. Task 7（CloudClient と偽物）← Task 6 と Task 1。Task 7 の後に Task 9 → Task 10（同期エンジン）。
4. Task 11 → Task 12（CLI）。Task 8 の後なら Worker 側の完成を待たずに書ける（`/health` と `/join` の形だけに依存する）。
5. Task 13（上げ手）と Task 14（降ろし手と索引化）は Task 7 と Task 8 の後に並列。Task 15（DTO）も並列。
6. **Task 16 は飛ばす**（引き継ぎはこのフェーズでは実装しない）。Task 17 の Step 1 から Step 3（この PC で再開のコピー）を実装し、その後ろに Task 18（設定の同期。Task 7 と Task 17 の `timestampLabel` に依存するので、Task 17 の Step 3 の後に始める）。
7. Task 19（HTTP とサーバの結線）← Task 13 から Task 18 の全部。
8. Task 20 → Task 21 → Task 22 →（Task 23、Task 24 は Task 22 の後に並列）。UI は Task 1 の型だけに依存するので、サーバ側の Task 13 以降と並列に進めてよい。
9. Task 19 と Task 24 が終わってから Task 25（実物確認）、最後に Task 26（文書）。

実装するタスクは 26 件のうち **25 件**である（Task 16 は据え置き、Task 17 は Step 3 までで止める）。

## 自己点検（計画の作成時に確認したこと）

- 設計文書の「クラウド同期」の全項目に対応するタスクがある。構成と setup は Task 2 から Task 5 と Task 11、参加は Task 3 と Task 12、メタデータは Task 9 と Task 10、本文は Task 13 と Task 14、Claude Code 設定は Task 18、ロックとこの PC で再開は Task 15 と Task 17、UI は Task 20 から Task 24、無料枠と片付けは Task 9 と Task 12 と Task 25。引き継ぎ（Task 16）だけは 2026-09-19 の判断で後のフェーズに送った。
- `~/.claude` への書き込みは 2 か所だけである。`copyTranscriptForResume`（Task 17、「この PC で再開」から呼ぶ）と `ClaudeConfigSync.applyPull`（Task 18、Settings で有効にして取り込みを確認したときだけ書く）である。どちらも上書きの前に `~/.agent-hangar/backups/` へ控えを取り、控えが取れなければ書かない。インデクサと pull と索引化は `~/.claude` を読むだけで、他端末の本文は `~/.agent-hangar/remote/` に置く。設計文書の「原則」の例外が 3 つ（本文のコピー、設定の取り込み、statusline への追記）に増えるので、Task 26 で反映する。
- 実物の Cloudflare に触るのは Task 25 だけである。Worker のテストはローカルの D1 と R2（vitest-pool-workers）で、サーバのテストは `FakeCloudClient` で行う。Task 25 はデプロイの前と片付けの前に利用者の確認を取り、無料枠に収まることを明示する。
- 型の名前が前後のタスクで一致していること。`DiscoveredFile.deviceId` は Task 14 で足し、Task 19 の結線と Task 13 の上げ手が同じ意味（null は手元）で使う。`UploadTarget` は Task 13 で定義し、Task 19 が `sessionChanged` から組み立てる。`timestampLabel` は Task 17 の `copy.ts` で定義し、Task 18 の競合ファイル名と控えのディレクトリ名が使う。`QuotaCounter` は Task 9 で定義し、Task 19 の結線が渡す。
- `changes` の行は 1 論理変更に 1 行とは限らない。未送信の行は `(table_name, row_id)` ごとにまとめられるので、push は `pushed_at is null` を `seq` 昇順に 40 行ずつ取り、送れた行にだけ `pushed_at` を書く形にしてある（Task 9）。
- `project_roots` の `unique (project_id, device_id)` が `deleted_at` を除いていないことと、`upsertShared` が conflict で `deleted_at` を消さないことは、フェーズ 1 では届かないが他端末の行が来ると届く。どちらも適用の経路（Task 10）で明示的に処理し、テストを付けた。
- ロックの判定は他端末の `ended_at` が null で `deleted_at` が null の run で引く。`LOCK_STALE_MS` は `db/queries.ts` に 1 つだけ置く（Task 15）。
- 本文の索引化は、同じセッションの同じ位置につき常に 1 ファイルだけを対象にする。手元を優先し、無ければ更新時刻が最新の写しを採る（Task 14）。`isYielded` は引き継ぎのための逃げ道なので、このフェーズでは常に false を返す。
- 引き継ぎを作らないことで、他端末の run は止まらずに走り続け、同じセッションの本文が 2 か所で伸びうる。手元を優先する索引化の規則で見た目は壊れないが、本文が枝分かれすることは受け入れる。この割り切りは Task 16 の冒頭に書いた。
- UI は props だけで描く Passive View のままである。`SyncStatus`、`ConfirmDialog`、`ConfigPreviewDialog` は状態を持たず、`fetch` を呼ばず、Intent だけを出す。暗い配色は足していない。
- 設計文書に無い Intent（`session.resumeHere`、`sync.config.preview`、`sync.config.apply`、`sync.joinToken.show`）と ServerEvent（`sync.status`、`sync.applied`、`devices.update`）を足した。Task 26 で設計文書に反映する。
- 2026-09-19 の設計判断（引き継ぎを作らない、設定の書き戻しに控えを必須にする、無料枠の 80% で止める、メモの競合を隣に残す、`hangar-dev` で試して消す、箱は共有しない）と、オーケストレータの裁定 4 件（`--rotate-secret` の確認、push の最小間隔、`changes` の圧縮で落ちた区間の検出、`teardown` の前の取り込み）を、この計画に取り込んだ。全文は `.superpowers/sdd/phase4-sync/decisions.md` にある。
- 設計文書が「差分を上げる」と書いている本文の同期は、R2 が部分更新を持たないのでファイル全体の上げ直しにした。Task 13 に理由を書き、Task 26 で設計文書を直す。
- フェーズ 2 と 3 の実装との照合は 2026-09-19 に済ませ、結果をこの計画の本文に取り込んだ（記録は `.superpowers/sdd/phase4-sync/task-0-report.md`）。直した主な箇所は、マイグレーションの版番号（Task 8 は `version: 6`）、`IndexFileResult.artifactIds` と `IndexerListener.artifactIds`（Task 14）、`server.ts` の `sessionChanged` と `updateSettings` の既存の中身（Task 19）、`initialState` と領域の合成順（Task 20）、`call` の `{ error }` の読み取り（Task 21）、`ShellProps.usage` と `SettingsProps` のフェーズ 3 の項目（Task 22）、アイコンの使い方と CSS の置き場（Task 23）、Settings の節の並びと Root の Esc の扱い（Task 24）である。
- CSS は `base.css` を太らせず `packages/ui/src/styles/sync.css` に分ける。アイコンは `views/primitives/Icon.tsx` を通してだけ使い、プロジェクトのステータスは `StatusSelect` を使う。どちらもフェーズ 3 で決めた約束である。
