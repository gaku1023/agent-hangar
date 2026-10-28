# Codex のアカウントと、設定のエージェントごとの節

2026-10-28。Codex に Claude Code と同じ形の複数アカウントを持たせ、設定画面をエージェントごとの節に組み直す。
試作で決めたこと：追加の入口は「節ごとに＋」（案 A）、設定は「エージェントごとの節」（案 C）。

## 実機で確かめた前提（codex 0.165.0）

- 標準のアカウントの切り替えは無い。`CODEX_HOME` を分けるとログインが分かれる。
- app-server に `account/read`（メール、プラン、`workspaceRouting.chatgptAccountId`）、`account/rateLimits/read`、`account/login/start`（`chatgpt` は `authUrl`、`chatgptDeviceCode` は `userCode` と `verificationUrl`）、`account/login/cancel`、`account/logout`、通知 `account/login/completed` がある。
- 2 つ目以降の置き場に `sessions`・`archived_sessions`・`session_index.jsonl` をリンクすると、`~/.codex` の会話を一覧し再開できる。リンクしないと `no rollout found`。`config.toml` もリンクしないと既定のモデルが変わる。
- TUI の `--remote` は、ログインに app-server 側の置き場を使う（TUI 側の置き場は問わない）。
- ブラウザでのログイン（ポート 1455）は同時に 1 つ。2 つ目を始めると 1 つ目は `Login cancelled` で終わる。
- rollout の `session_meta` に `creator_account_id` がある（`chatgptAccountId` と同じ値）。

## 決め事

- D1 いまのアカウントはエージェントごとに 1 つ。Codex のいまのアカウントを変えても Claude には触らない。
- D2 Codex のアカウントの一覧は PC ごと（`<home>/codex-accounts.json`）。同期しない。Claude の `accounts.json` と同じ扱い。
- D3 最初の Codex アカウントは `~/.codex`（`CODEX_HOME` を渡さない）。2 つ目以降は `~/.codex-<名前>`。
- D4 共有（リンク）：`config.toml`、`AGENTS.md`、`skills`、`prompts`、`rules`、`plugins`、`sessions`、`archived_sessions`、`session_index.jsonl`、`history.jsonl`。分ける：`auth.json`、sqlite 類、`logs`、キャッシュ、`tmp`、`installation_id`、`version.json`。
- D5 ログインは app-server 経由。ブラウザで開く方法を既定にし、確認コードを選べる。ログインは hangar 全体で同時に 1 つ。新しいログインを始めたら、前のものは取り消して札にそう出す。
- D6 会話の本文の置き場は `~/.codex` に集まる（リンク）ので、索引と同期は `~/.codex` だけを見たままにする。
- D7 hangar が起こした会話の使用量は、その app-server のアカウントに付ける。外の会話の rollout の `rate_limits` は、`creator_account_id` が一致するアカウントに付け、一致しなければ捨てる。
- D8 ヘッダの面は Codex の札を押せるようにし、節ごとに「＋」を置き、下の段は「アカウントの設定」だけにする。Codex の会話の画面では、顔にその会話の Codex アカウントを出す。そこで別の札を押すと、確認のあと止めて選んだアカウントで再開する（Claude と同じ）。
- D9 新規ダイアログのアカウントの札は、Codex でも 2 件以上のときだけ出す。
- D10 設定は目次に「エージェント」の見出しを置き、Claude Code・Codex・opencode を 1 節ずつにする。アカウント、新しいセッションの既定、渡す設定、会話の保持、連携、パスは、そのエージェントの節へ寄せる。
- D11 文言は全部 Gemini に当ててから入れる。
- D12 スマホは今回は触らない（Codex のアカウントを出さない）。

## インタフェース

### shared
- `AccountsDto` に `codex?: AgentAccountsDto` を足す。`AgentAccountsDto = { currentId: string; accounts: AccountDto[]; sessions: Record<string, string> }`。`codexEnabled` が切なら付けない。
- Codex の `AccountDto.usage` には、そのアカウントの 5 時間・週を入れる（Claude と同じ `UsageDto`）。`auth` の `orgName` は null。
- `AccountDto` に `login?: { method: 'browser' | 'deviceCode'; userCode?: string; verificationUrl?: string; cancelledBy?: string }` を足す（ログイン中だけ）。
- `AccountsDto.agents.codex` は残し、Codex のいまのアカウントの枠を入れる（古い画面のため）。
- `CODEX_ACCOUNT_LINK_GROUPS`（設定と指示、スキルとプロンプト、会話の履歴）。
- `AGENT_UI_CAPS.codex.accounts` を true にする。

### server
- `AccountStore` をエージェントの別で持てるようにする（ファイル名、最初の置き場、候補の接頭辞を渡す）。Claude は今のまま。
- `provider/codex/config/accountLinks.ts`：`ensureCodexAccountLinks`、`inspectCodexAccountLinks`（Claude の版と同じ形）。
- `provider/codex/account.ts`：`readCodexAccount(dir)`（メール、プラン、chatgptAccountId）、`readCodexRateLimits(dir)`、`startCodexLogin(dir, method)`、`cancelCodexLogin`。短命の app-server をその置き場で起こして閉じる。ログインは 1 本の列に並べる。
- 起動：`codexBaseEnv` と TUI の env に、選んだアカウントの `CODEX_HOME` を足す（最初のアカウントは足さない）。`planCodex` の unset から `CODEX_HOME` を外す。
- RunManager：Codex の起動、再開、フォークでアカウントを解く（`RunAccounts` を Codex の store でも持つ）。`launch_params.account` に Codex のアカウントの id を書く。
- 使用量：`AgentUsageTracker` にアカウントの鍵を足す。
- HTTP：`/api/codex/accounts` 系（GET、preview、POST、current、PATCH、DELETE、login、login/cancel、refresh）と `POST /api/sessions/:id/switch-account` の Codex 対応。

### ui
- `AccountSwitcher`：Codex の札を押せる札にし、節の見出しに「＋」を置く。下の段は「アカウントの設定」だけ。Codex の会話では顔に Codex のアカウントを出す。
- `AddAccountDialog`：`agent` を受け、Codex の組を出す。題に「Codex のアカウントを追加」。
- 新規ダイアログ：Codex を選んだら Codex のアカウントの札を出す（2 件以上）。
- 設定：`SETTINGS_SECTIONS` に「エージェント」の群を足し、Claude Code・Codex・opencode の節を作る。`AccountSettings` は `agent` を受けて各節に置く。codex と opencode のパスの欄を足す。

## 受け入れ試験

- A1 Codex の 2 つ目のアカウントを足すと `~/.codex-<名前>` が作られ、D4 の共有の項目がリンクになり、分ける項目は作られない。リンクの場所に実ファイルがあれば触らずに挙げる。
- A2 Codex のアカウントで新しい会話を起こすと、app-server と TUI の環境に `CODEX_HOME=<その置き場>` が入る。最初のアカウントでは入らない。
- A3 Codex の会話を再開すると、最後に動かしたアカウントで起きる。
- A4 Codex の会話を別のアカウントに付け替えると、止めて選んだアカウントで再開し、いまの Codex アカウントも変わる。Claude のいまのアカウントは変わらない。
- A5 ログインを 2 つ続けて始めると、1 つ目の札が「取り消し」になり、2 つ目だけが進む。
- A6 使用量：app-server の `account/rateLimits/updated` はその会話のアカウントに付く。外の rollout は `creator_account_id` で振られ、一致しなければ捨てる。
- A7 ヘッダの面：Codex の札を押すといまの Codex アカウントが変わる。節の「＋」でそのエージェントの追加ダイアログが開く。
- A8 新規ダイアログ：Codex を選び、Codex のアカウントが 2 件以上なら札が出る。未ログインと承認待ちの行は選べない。
- A9 設定：目次に「エージェント」の群と 3 つの節がある。共通の節に Claude 専用の行が残っていない。codex と opencode のパスの欄がある。
- A10 `codexEnabled` が切なら、Codex のアカウントは DTO にも画面にも出ない。
- A11 Windows：リンクが張れないときは理由をアカウントの札に出し、起動を断る（Claude と同じ）。

## タスクの分け方

サーバを先に入れ、画面はそのあと。1 タスク 1 エージェント（sonnet）。同じファイルに触るものは並べない。

1. S1 shared の型と、エージェント別の `AccountStore`、Codex のリンク（A1）
2. S2 `provider/codex/account.ts`（読み取り、使用量、ログインの列）（A5）
3. S3 起動と再開と付け替えにアカウントを通す（A2〜A4）
4. S4 使用量をアカウント別にする（A6）
5. S5 HTTP の口と `buildAccountsDto` の Codex 分（A10）
6. U1 ヘッダの面と追加ダイアログ（A7）
7. U2 新規ダイアログの札（A8）
8. U3 設定のエージェントごとの節（A9）と文言の直し（Gemini に当てる）
9. 最後に `docs/design.md` の該当の節（アカウントの切り替え、Codex、設定）を直し、README の画像が古くなっていないかを見る。

S2 は S1 と並べられる。U1〜U3 は S5 のあと。U3 は U1 と並べられる（触るファイルが違う）。

## 付録：文言（Gemini に当てた結果、2026-10-28）

採る：
- 前のログインの取り消し：「別のアカウントのログインを開始したため、取り消しました」
- Codex の会話の付け替えの確認：題「{name} のアカウントに切り替えますか？」、本文「この会話をいったん止め、{name} のアカウントで再開します。作業中の場合は中断されます。」
- Codex の節のリード：「Codex にだけ効く設定です。アカウントごとにログインを分けます。設定と会話の履歴は ~/.codex を共有します。」
- Claude のアカウントのリード：「ログインだけを切り替えます。設定、スキル、履歴は ~/.claude を共有します。hangar はログイン情報を読み取りません。」
- Codex のアカウントのリード：「ログインだけを切り替えます。設定と会話の履歴は ~/.codex を共有します。hangar はログイン情報を読み取りません。」
- 保持の説明：「Claude Code の cleanupPeriodDays です。Codex と opencode の会話は対象外です。」

そのまま使う：＋の読み上げ名「Claude Code のアカウントを追加」「Codex のアカウントを追加」、「確認コードでログイン」「キャンセル」、「{url} を開き、コード {code} を入力してください」、題「Codex のアカウントを追加」、目次の「エージェント」、各節のリード（Claude Code、opencode）、見出し「Claude Code のアカウント」「Codex のアカウント」「会話を残す期間」「codex のパス」と説明「空欄なら PATH から探します。」、「読み取り元：{dirs}」、「会話したディレクトリから…」、使用量の注記「Claude Code のコストは、ステータスラインから受信した値です。」、要約のリード「終了したセッションの要約を作成します。セッションの中でエージェントが書く要約は、どれを選んでも表示されます。」、MCP の説明「Claude Code の user スコープに hangar を登録します。Codex と opencode には、起動のたびに渡します。」、opencode の有効化「新しいセッションで opencode を選べるようにします。」、共有の組「設定と指示」「スキル、プロンプト、プラグイン」「会話の履歴」、分ける組「ログイン」「内部のデータベース」「キャッシュとログ」。
- クラウド同期のリードは「…Claude Code の設定を同期する…」の「Claude Code の設定」を「エージェントの設定」に替えるだけにする。

退ける：
- 追加ダイアログの注記から「ChatGPT の」を外す案。Codex のログインは ChatGPT のアカウントで行うので、何で承認するかを言うために残す（「次にブラウザが開きます。追加する ChatGPT のアカウントで承認してください。」）。
- 保持の説明を「cleanupPeriodDays に適用されます」にする案。設定そのものが cleanupPeriodDays なので、今の言い方のままにする。
- クラウド同期のリードを「作成してください」にする案。ボタンを押すと hangar が作るので、手順の指示にしない。
