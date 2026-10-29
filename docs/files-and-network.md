# ファイルと通信

hangar がどのファイルに書き、何を足して claude と tmux を起こし、どこへ通信するかを、ここにまとめます。

## ファイルの扱い

hangar は Claude Code の設定とデータを原則として読むだけで、書き換えません。
`~/.claude/` の中に書く例外は 4 つです。

1. statusline スクリプトへの追記（「[使用量のゲージ](usage.md#使用量のゲージ)」の節、承認を求めてバックアップを取ります。アプリのボタンからは「書き込みの確認」の窓で承認します）。
2. 他端末のセッションを「この PC で再開」したときの本文の写し。
3. Settings で有効にした Claude Code 設定の取り込み（既定は off、取り込む内容を確認してから書きます）。
4. Settings の保持期間の変更。
   `~/.claude/settings.json` の `cleanupPeriodDays` の 1 か所だけを書き換えます（下の説明を読んでください）。

2、3、4 は、上書きの前に必ず `~/.agent-hangar/backups/` へ控えを取り、控えが取れなければ 1 バイトも書きません。
このほかに、`~/.claude/` の外にある `~/.claude.json` の `mcpServers.hangar` を `hangar mcp install` と `uninstall` が書き換え、`~/.zshrc` の 1 行を `hangar shell install` と `uninstall` が書き換えます。
サーバはどのファイルも書きません。書くのは CLI と、承認の窓を経たアプリだけです。
索引は `~/.agent-hangar/hangar.db` に置きます。

保持期間は、Claude Code が古い会話の本文を何日で消すかを決める設定です（Claude Code の既定は 30 日）。
Claude Code は期間を過ぎた本文を、セッションを始めたあとの掃除で黙って消すので、hangar は設定の「一般」の節で、いまの日数と、どこで決まっているかを見せます。
期間を変えるときは、書き換える差分と控えの置き場（`~/.agent-hangar/backups/claude-config/<時刻>/`）を見せてから、確認のうえで書きます。
読むのはユーザー設定と組織の設定だけで、プロジェクトの設定と `--settings` は見ません。
組織の設定（macOS は `/Library/Application Support/ClaudeCode/` など）で日数が決まっているとき、ファイルが UTF-8 として読めないとき、書式を読み取れないときは書きません。

複数のアカウントを足すと、2 つ目以降の置き場（例：`~/.claude-2`）を hangar が作り、その中に `~/.claude` の項目（`CLAUDE.md`、`settings.json`、`skills`、`projects`、`history.jsonl` など）へのリンクを張ります。
リンクを張るのは足したほうの置き場の中だけで、`~/.claude` の中は書き換えません。
認証（Keychain の項目と `.claude.json`）は共有せず、hangar はトークンを読みません。
リンクの場所に実ファイルがあるとき（`claude doctor` などが置き換えたとき）は、中身が `~/.claude` の側と同じならリンクに戻します。
違うときは消さずに知らせ、アカウントの行の「修復…」で、ファイルごとに差分を見て、どちらを使うかを選べます。選ばなかったほうは `<名前>.bak-hangar-<日時>` としてバックアップします。

## hangar が起動する claude に足すもの

hangar は、自分が起動、再開、フォークする `claude` に、次の 3 つを足します。
足すのは起動のときの引数だけで、`~/.claude/` の設定ファイルは書きません。
`claude --bg` で動いている会話へ attach するときと、ターミナルから直接 Claude Code を起動したときは、足しません。
Settings の「連携」の「hangar が起動する Claude Code に足すもの」に、3 つの一覧と、足す指示の全文があります。
MCP の設定と hook は hangar の基本なので切れません。
システムプロンプトの追記のうち、区切りの問いと、ターンの意図と操作の短い説明の 2 つは、そこのスイッチで切れます（次に起動・再開した会話から効きます）。

1. `--mcp-config`。
   hangar の MCP サーバ（`search_sessions`、`get_transcript`、`set_session_summary`、`update_project`、`propose_session_status`、`set_turn_intent` など）を、その会話だけに登録します。
   設定ファイルは `~/.agent-hangar/mcp/<セッション ID>.json`（権限 0600）で、中の Bearer トークンはその会話専用の秘密です。
   本体のトークンは渡しません。
   トークンが `ps` に載らないよう、引数に渡すのはファイルのパスだけです。
   会話が終わると消します。
2. `--settings`。
   hook の設定を `~/.agent-hangar/mcp/<セッション ID>.settings.json` に置いて渡します。
   `AskUserQuestion` の前後（`PreToolUse`、`PostToolUse`、`PostToolUseFailure`）と、許可を求める画面（`PermissionRequest`、全部の道具）で、hangar の台本を裏（`async`）で走らせます。
   入力待ちの問いの文と、許可待ちの道具と命令を、手元の hangar に知らせるためです。
   台本は許可の判断には加わらず、何も出力しません。
3. `--append-system-prompt`。
   短い指示を、Claude Code が自分で組むシステムプロンプトの後ろに足します。
   中身は、プロジェクトの名前と場所、未完の TODO（最大 10 件）、過去のセッションを MCP の `search_sessions` と `get_transcript` で引けること、そして次の依頼です。
   - 依頼を終えたときと、方針が変わったとき、中断するときに、`set_session_summary` で題名、要約、進捗、次のステップを更新する。
   - TODO を片付けたと判断したら、`update_project` で根拠を添えて提案する（完了にするのは利用者です）。
   - 頼まれたことが明確に終わったとき（終わりを告げた、全部済んで次のステップが無い、CI やレビューなど外の出来事を待つ）だけ、ターンの終わりに `AskUserQuestion` で「このセッションをどうしますか」と聞く（Done、Paused、まだ続ける）。
     一手が済んだだけのときや、直しのやりとりの途中では聞かない。
     設定の「区切りで Done／Paused を聞く」で切れます。切っても、状態の提案と自動の Done は続きます。
   - ターンの始めと方針を変えたときに、`set_turn_intent` でそのターンの意図を書く。
   - Bash と Agent の `description` を、短く（20 字程度）書く。
     この 2 つは、設定の「ターンの意図と操作の短い説明を送る」で切れます。切ると、右パネルの現在の札には意図の代わりに依頼の冒頭が出ます。

   全文は `packages/shared/src/i18n/ja/launch.ts` の `launch.injection.body`、`launch.injection.status`、`launch.injection.live` にあり、設定の画面でも読めます（画面を英語にしているときは `en/launch.ts` の同じ鍵の英語版を渡します）。
   プロジェクトのノートは渡しません。
   Claude Code が `CLAUDE.md` と自動メモリを自分で読むためです。

そのほかに、起動した会話には、`--session-id`、`-r`、`--model` などの利用者が選んだ値と、新規セッションの初期プロンプトが付きます。
新しいセッションのモデルの初めの値は、プロジェクトの前回の値、無ければ設定の「既定のモデル」（空なら Claude Code の既定で、`--model` を付けません）です。
会話は tmux の中で、標準エラーと終了コードを `~/.agent-hangar/` のログへ写す小さな包み（`hangar-run.sh`、Windows は `hangar-run.mjs`）を通して起こします。
Claude Code が子に立てる印（`CLAUDECODE`、`CLAUDE_CODE_SESSION_ID` など）と、hangar の受け渡しの変数は、起動する前に環境から外します。

## tmux に足すもの

セッションは、利用者がふだん使う tmux とは別の、hangar 専用の tmux サーバ（`tmux -L hangar`）に置きます。
Windows の psmux も、同じく `-L hangar` の名前空間を使います。

- hangar のセッションは `tmux ls` には出ず、`tmux -L hangar ls`（Windows は `psmux -L hangar ls`）で見えます。
  ターミナルから直につなぐときは `tmux -L hangar attach -t =<名前>` です。
- 利用者の tmux の設定（`~/.tmux.conf`）は、この専用のサーバが起きるときにも読まれます。
- 次のサーバ全体の設定は専用のサーバにだけ入れ、利用者自身の tmux のサーバには入れません。
- 0.6.0 に上げた時点で、前の版が利用者の既定のサーバで動かしていたセッションは、終わるまでそのサーバで扱います。新しく起動するセッションから、専用のサーバに入ります。
- シェル連携（`hangar shell install`）を使っているなら、上げる前から開いていたターミナルは開き直してください。
  古い包みを読み込んだままなので、そこで打った `claude` は起動しても、そのターミナルからはつながりません（セッションは hangar から開けます）。
- 利用者自身の tmux の中で `claude` を打つと、hangar に包まず素の claude を起動します（hangar のシェルタブの中なら、そのまま hangar のセッションへ移ります）。

hangar が入れるものは次のとおりです。

- セッションの名前。
  会話は `hangar-<id>`、会話の中のシェルタブは `hangar-<id>-t<n>` です。
  名前の指定は `=` を付けた完全一致で、自分のセッションを巻き込みません。
- 各セッションの `status off`。
  画面は UI のターミナルに埋めるので、状態の行を出しません。
- `set-clipboard on`（サーバ全体）。
  中のアプリが OSC 52 で写したものを、UI のターミナルへ通します。
  利用者が `on` か `off` を選んでいるときは触りません。
- `focus-events on`（サーバ全体）。
  中の Claude Code に、ターミナルが前に来たか後ろへ回ったかを渡します。
  `off`（既定のまま）のときだけ `on` にします。Windows の psmux には入れません。
- macOS だけ、外のターミナル（iTerm2 など）から attach する人のために、次を足します（Windows の psmux には入れません）。
  - `copy-command`：空か素の `pbcopy` のときだけ、`LC_CTYPE=UTF-8 pbcopy` にします。
    マウスで選んだ範囲を、日本語のままクリップボードへ渡すためです。
  - `extended-keys`：`off` のとき（既定のまま）だけ `on` にします（tmux 3.5 以降は `extended-keys-format` を `csi-u` にします）。
  - `terminal-features`：`xterm*:extkeys` を足します。
  - `S-Enter` のキー割り当て（`bind-key -n`）。
    hangar の会話でだけ Shift+Enter を改行（ESC と Enter）として送り、それ以外のセッションにはそのまま渡します。
    利用者が自分で `S-Enter` に割り当てているときは触りません。

セッションを閉じるときは、名前を指した `kill-session` だけを使い、サーバごと落とす `kill-server` は呼びません。
この設定は、サーバが動いているときに、会話の起動と、UI のターミナルへの attach のたびに確かめます。

## 通信先

hangar が自分で通信するのは、次のところだけです。
手元の hangar サーバへの通信（`127.0.0.1` の 4177）は含みません。

| 通信先 | いつ | 送るもの |
| --- | --- | --- |
| GitHub（このリポジトリの Releases の `latest.json`） | デスクトップアプリが、起動したときと、その後 6 時間ごとに、更新を確かめます。設定の更新の節で「更新を通知する」を切ると、自動の確認は止まります。起動に失敗したときにも 1 度だけ確かめます。 | 更新の目録を取りに行く要求だけです。更新物は署名を確かめてから入れます。 |
| あなたの Cloudflare アカウントの Worker | クラウド同期を設定した PC と、接続したスマホ（Worker が配る画面）だけ。 | 「[クラウド同期](cloud-sync.md#クラウド同期上級者向けのベータ)」の節に書いたもの（本文もメタデータも暗号化。平文は鍵名、時刻、大きさなどだけ）。 |
| Cloudflare の API（`api.cloudflare.com`） | 使用量の API トークンを入れた場合に、Worker が読み取り専用で使用量と費用を問い合わせます。`hangar setup cloud` も、Worker などを作るときに wrangler を通して使い、使用量のトークンの確かめでも呼びます。 | 使用量と費用の問い合わせ。会話の内容は送りません。 |
| 要約の宛先（OpenAI 互換の URL） | 設定の要約エンジンで「OpenAI 互換の URL」を選んだときだけ、事後の要約を作るとき。既定の要約エンジンは「使わない」で、どこへも送りません。 | 会話の本文と、入れていれば API キー。次の 2 項を読んでください。 |
| Claude Code（Anthropic） | 設定の要約エンジンで「Claude」を選んだとき、または「OpenAI 互換の URL」で「接続できないときは Claude を使う」を入れていて繋がらないとき（既定は切）、`claude -p --model <設定のモデル。既定 haiku>` を起こします。 | 会話の本文が、あなたの Claude Code の経路で Anthropic へ渡り、使用枠を消費します。1 時間に 20 件まで（設定で変えられます）で、7 日の使用率が 80% を超えると止めます。 |

要約の宛先は、既定で手元（`127.0.0.1`、`localhost`、`::1`）だけです。
手元の外の URL を使うには、設定の「外部の要約エンジンを許可」を入れます。
入れている間は、会話の本文がその宛先へ送られることを画面に出します。

テレメトリはありません。
hangar は、利用状況やクラッシュを集めて送る仕組みを持たず、広告や解析のサービスにも繋ぎません。
画面の文字の書体も、外のサービスから読みません。
（上の表に無いものは、`claude` や `wrangler`、`git` など、hangar が起こす別のプログラムが自分で行う通信です。
それらの通信は、各プログラムの設定に従います。）
