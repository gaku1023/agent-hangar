# 用語表の案（2026-10-01）

画面の言い方をそろえるための案です。
実装はまだしません。
利用者に決めてもらう点を 3 章にまとめ、決まったら 4 章の表をそのまま実装に使います。

範囲は、UI の画面の文字、aria-label と title、トースト、サーバが返して画面のトーストに出るエラー文です。
CLI（`hangar` コマンド）の出力は範囲の外にし、6 章に気付いた点だけを書きます。
行番号は `worktree-ux-fixes-1` の `0ddcc96` の時点のものです。

## 0. そろえ方の決まり

1. 1 つの概念には 1 つの語を当てる。
   同じ語を別の概念に使わない。
2. 英語の内部値（`active`、`idle`、`scanning`、`tmuxPath` など）を画面に出さない。
   ただし Claude Code の固有の名前（statusline、MCP、model、effort、permission mode、worktree）はそのまま使う。
3. 画面の名前は「ホーム」「プロジェクト」「セッション」「設定」にする。
   サーバの文も「Settings」ではなく「設定」と書く。
4. サーバのエラー文が設定の項目を指すときは、内部名ではなく画面の欄の見出しをかぎ括弧で書く。
   例：設定の「tmux のパス」。
5. aria-label は見えている文字をそのまま含める（WCAG 2.5.3）。
   見える文と読み上げの名前を別の言い方にしない。
6. 語調は、です、ます調で、やわらかい和語寄り（「休み」「確かめる」「引き取る」）に合わせる。

## 1. 用語表（推奨案を当てた形）

3 章の推奨をすべて採った場合の表です。
推奨と違う案を選んだ行は、3 章の番号（D1 など）を見て差し替えます。

### 1.1 セッションの生き死に

| 内部の値 | 画面の語 | 定義 |
|---|---|---|
| `live = 'busy'` | 作業中 | Claude が手を動かしている |
| `live = 'waiting'` | 入力待ち | Claude が利用者の答えを待っている。ホームでは「要対応」の区画に出る |
| `live = 'idle'` | 休み | 返答を終え、次の指示を待っている |
| `live = null` かつ hangar の run が生きている | 起動中（文は「起動しています」） | hangar が起こしたが、Claude の一覧にまだ載っていない |
| `live = null` かつ生きた run が無い | 終了 | Claude のプロセスが無い |
| 作業中＋休み＋起動中 | 実行中（D1） | 入力待ちは含めない。入力待ちは常に別に数える |
| 入力待ちの区画 | 要対応 | ホームの区画の名前だけに使う。件数や状態の札には「入力待ち」を使う |

### 1.2 プロジェクトの状態（D3）

| 内部の値 | 画面の語 | 一覧を開いたときの説明 |
|---|---|---|
| `active` | 進めている | いま手を動かしている |
| `paused` | 止めている | しばらく手を止めている |
| `done` | 終えた | やることが済んだ |
| `archived` | アーカイブ | 一覧の奥へしまう |

欄の名前は「ステータス」ではなく「状態」にします。
セッションの一覧の絞り込みがすでに「状態」なので、そちらに寄せます。

### 1.3 要約の見立て（D4）

要約の `state` は、Claude が要約を書いた時点で「その仕事がどこまで進んだか」の見立てです。
セッションのプロセスが生きているかどうかとは別物なので、プロセスの語（実行中、終了）と重ならない語にします。

| 内部の値 | 画面の語 |
|---|---|
| `in_progress` | やりかけ |
| `done` | 済んだ |
| `blocked` | 詰まっている |
| `abandoned` | やめた |

### 1.4 場所と道具

| 概念 | 画面の語 | 使わない語 |
|---|---|---|
| hangar が動いている 1 台の計算機 | PC（この PC、他の PC）（D2） | 端末、デバイス |
| 文字を打つ窓 | ターミナル | 端末 |
| hangar の外のターミナル（VS Code など） | 外のターミナル | 別のターミナル |
| Claude の run の起こし方 `start` `resume` `fork` | 起動、再開、フォーク | run |
| 右欄のターンの一覧 | 目次 | トランスクリプト、transcript |
| 会話の記録そのもの | 本文 | トランスクリプト |
| 作業ディレクトリ | 作業ディレクトリ | cwd |
| トークン数 | トークン | tokens |

### 1.5 同期

| 内部の値 | ヘッダーの一行 | 設定の「状態」 |
|---|---|---|
| `idle` | 同期 3 分前（まだ往復していなければ「同期の準備中」） | 同期済み |
| `pushing` | 送信中 | 送信中 |
| `pulling` | 受信中 | 受信中 |
| `paused` | 一時停止中 | 一時停止中 |
| `error` | 同期エラー: 理由 | 同期エラー |

| 概念 | 画面の語 |
|---|---|
| 未送信のメタデータ | 未送信 |
| まだ上げていない本文 | 未送信の本文 |
| 何度も失敗して 30 分おきの再試行に回した本文 | 送れなかった本文（D6） |
| 最後に受け取った時刻 | 最後の受信 |
| すぐに同期する操作 | 今すぐ同期（D9） |
| 同期を止める、戻す操作 | 同期を一時停止、同期を再開 |

### 1.6 索引

| 内部の値 | 画面の語 |
|---|---|
| `scanning` | 索引を準備中 |
| `indexing` | 索引 10 / 200 件 |
| `rebuilding` | 索引の作り直し 10 / 200 件 |
| 操作 | 索引を作り直す |

### 1.7 使用率と使用量

| 概念 | 画面の語 |
|---|---|
| Claude の利用上限の 5 時間の枠で使った割合（statusline の `rate_limits.five_hour`） | 5 時間（見出し）、5 時間枠の使用率（読み上げ）（D7） |
| 同じく 7 日の枠（`rate_limits.seven_day`） | 週（見出し）、週の枠の使用率（読み上げ）（D7） |
| 1 セッションの文脈の窓の使用率 | コンテキスト（D8） |
| 設定の日別とプロジェクト別のトークンとコスト | 使用量 |

### 1.8 操作の名前

| 概念 | 画面の語 |
|---|---|
| セッションを始めるダイアログとボタン | 新しいセッション（D5） |
| プロジェクトのカードから始める | ここで始める |
| タブを 2 つ左右に並べる | 横に並べる（D10） |
| キーの表のダイアログ | キーの一覧 |
| プロジェクト画面の右の欄の開閉 | 右の欄を開く、右の欄を閉じる |
| 外部の要約器を使えるようにするスイッチ | 外部の要約器を許す（D11） |

## 2. 現状の揺れの一覧

| 概念 | 現状の言い方（出現箇所） | 提案 | 理由 |
|---|---|---|---|
| プロジェクトの状態 | `Active` `Paused` `Done` `Archived`（packages/ui/src/presenters/format.ts:50、プロジェクト一覧の見出し）、`active` `paused` `done` `archived`（views/primitives/StatusSelect.tsx:7-10 と :23 の札）、「active なプロジェクトはありません」（views/HomeScreen.tsx:86）、「アーカイブを表示」（views/ProjectsScreen.tsx:16）、「アーカイブにする」（views/ResolveProjectDialog.tsx:26） | 進めている、止めている、終えた、アーカイブ（D3） | 同じ値が大文字、小文字、カタカナの 3 通りで出ている。英語の内部値がそのまま札に出ている |
| 状態の欄の名前 | 「ステータス」（views/ProjectScreen.tsx:25、views/ProjectCard.tsx:13）、「状態」（views/SessionsScreen.tsx:31） | 状態 | セッション側と合わせる。和語寄り |
| idle | 「待機」（views/primitives/StatusDot.tsx:5、状態の点の title と読み上げ）、「休み」（presenters/session.ts:48、presenters/home.ts:60、views/SettingsScreen.tsx:174、server/src/runs/manager.ts:374） | 休み | 同じ行の点が「待機」、チップが「休み」と読み上げられる。休みの方が多い |
| 実行中の数え方 | ホームの「実行中」の区画とプロジェクトの小さな一覧は入力待ちを除く（presenters/home.ts:56、:73）。プロジェクトのカードの「実行中 N」はサーバの `runningCount` で入力待ちを含む（views/ProjectCard.tsx:24、server/src/db/queries.ts:269）。セッションの絞り込みの「実行中」も入力待ちを含み、起動中は含まない（presenters/sessions.ts:15、server/src/search/search.ts:70） | 実行中は入力待ちを除き、起動中を含む。入力待ちは別に数える（D1） | 同じプロジェクトがホームで「実行中 1、要対応 2」、プロジェクト一覧で「実行中 3」と出る |
| 入力待ちの件数 | 「要対応 N」（presenters/home.ts:73、ホームのプロジェクトの行） | 入力待ち N | 要対応はホームの区画の名前。件数は状態の語で数える |
| 要約の見立て | 「進行中」「完了」「詰まっている」「中断」（presenters/format.ts:46）。終わったセッションの要約の横にも「進行中」と出る（views/SessionScreen.tsx:93） | やりかけ、済んだ、詰まっている、やめた（D4） | 要約の state はセッションの生き死にと別物。「進行中」は動いているように読める |
| 同期の状態 | 設定は「状態 idle」「状態 pushing」など内部値（views/SettingsScreen.tsx:232）、ヘッダーは日本語（presenters/shell.ts:43-50） | 1.5 の表 | 英語の内部値が出ている。ヘッダーと設定で言い方が違う |
| 最後の受信 | 「最終 pull」（views/SettingsScreen.tsx:233） | 最後の受信 | 英語の内部の語。ヘッダーは「受信中」 |
| 索引の進み | 設定は「scanning 10 / 200」など内部値（views/SettingsScreen.tsx:304）、ヘッダーは「索引を準備中」「再構築 10 / 200 件」（presenters/shell.ts:71） | 1.6 の表 | 英語の内部値が出ている。「再構築」と「作り直す」（palette.ts:25、SettingsScreen.tsx:305）が揺れている |
| 計算機の呼び名 | 「この PC」（views/ConfirmDialog.tsx:37,39、views/SessionScreen.tsx:43、views/SettingsScreen.tsx:168,173）、「この端末」「他の端末」（views/ConfirmDialog.tsx:37,40、views/SettingsScreen.tsx:158,264,273,311、views/SessionScreen.tsx:82、views/ProjectCard.tsx:16、views/ProjectScreen.tsx:34、presenters/palette.ts:66） | PC（D2） | 同じダイアログの中で「この PC の本文」と「他の端末の本文」が並ぶ。「端末」はターミナルの意味でも使われている（次の行） |
| ターミナル | 「端末」がターミナルの意味で出る（views/SettingsScreen.tsx:145「追記は端末から行い」、server/src/http/app.ts:146「端末で hangar url を実行」） | ターミナル | 「端末」が PC とターミナルの両方を指している |
| 外のターミナル | 「外のターミナル」（views/SettingsScreen.tsx:152,174）、「別のターミナル」（views/ConfirmDialog.tsx:21、views/HomeScreen.tsx:42） | 外のターミナル | 設定の見出しに合わせる。サーバも「hangar の外で」と書いている |
| 新しいセッション | 「新規セッション」（views/Header.tsx:33、keys.ts:31、presenters/palette.ts:21、views/ProjectScreen.tsx:29）、「新しいセッション」（views/NewSessionDialog.tsx:96,98、views/PromoteDialog.tsx:69）、「ここで新規」（views/ProjectCard.tsx:30） | 新しいセッション（D5） | ボタンとダイアログの題が違う |
| 今すぐ | 「いますぐ再接続」（views/ConnectionBanner.tsx:20）、「今すぐ同期」（views/SyncStatus.tsx:28、views/SettingsScreen.tsx:248） | 今すぐ（D9） | 表記の揺れ |
| 目次の開閉 | キーの一覧は「トランスクリプトの開閉」（keys.ts:43）、画面は「目次を開く」「目次を閉じる」（views/SessionScreen.tsx:133） | 目次の開閉 | ⌘J が動かすのは目次の欄だけ（transcriptOpen は run があるときの右欄にしか効かない） |
| Claude Code の表示の切り替え | 「ターミナルを transcript に切り替えられませんでした」（views/TurnIndex.tsx:27） | ターミナルの表示を切り替えられませんでした | 英語の語が混ざる。利用者に要るのは失敗したことだけ |
| 送れなかった本文 | 「諦めた本文」（views/SyncStatus.tsx:27、views/SettingsScreen.tsx:241） | 送れなかった本文（D6） | 利用者が諦めたように読める。実際は hangar が 30 分おきの再試行に回した本文 |
| 外部の要約器 | 見える文「手元の外にある要約器を許す」（views/SettingsScreen.tsx:188）、読み上げ「外部の要約器を許す」（:189）、確かめの帯の読み上げ「外部の要約器を許すかの確かめ」（:192）、サーバ「外部の要約器は Settings で明示的に許してから」（server/src/http/app.ts:450） | 外部の要約器を許す（D11） | 見える文と読み上げが違う。サーバは英語の画面名 |
| 要約の切り替え | 見える文「LM Studio が使えないとき Claude へ切り替える」、読み上げ「Claude へ切り替える」（views/SettingsScreen.tsx:201-202） | 読み上げも見える文と同じにする | 決まり 5 |
| 設定の項目を指すサーバの文 | 「Settings で tmuxPath を設定してください」（server/src/runs/manager.ts:107、server/src/server.ts:698）、「Settings で claudePath を」（manager.ts:118）、「Settings の codePath を」（server/src/external/open.ts:111）、「`${key}` は空にできません」（server/src/http/app.ts:389）、「lmStudioUrl は」（:410）、「summaryHourlyCap は」（:428）、「Settings の「索引を作り直す」」（:366）、「Settings で再開できます」（server/src/sync/engine.ts:56）、「lmStudioUrl の宛先を確かめて」（server/src/summary/lmstudio.ts:67） | 設定の「欄の見出し」 | 英語の画面名と内部のキー名が出ている |
| run | 「run start 3 分前」（views/SessionScreen.tsx:80）、「run が見つかりません」「この run は終了しています」（server/src/runs/manager.ts:520-521,581,643-644）、「実行中の run がありません」（runtime/runtime.ts:181） | 起動、再開、フォーク。エラー文は Claude を主語にする | 内部の語 |
| 使用率のゲージ | ヘッダーの 2 本は、広い幅では棒と「28%」だけで見出しが無い（views/Header.tsx:28-29、styles/base.css:259）。「5h」「7d」は幅 880px 以下でだけ出る（base.css:264）。名前は title と読み上げの「5 時間の使用率」「7 日の使用率」だけ | 見出し「5 時間」「週」を常に出す（D7） | 何の割合か画面から読めない。値は statusline の `rate_limits.five_hour` と `rate_limits.seven_day`（server/src/usage/statusline.ts:43-46）で、Claude の利用上限の枠の使用率。戻る時刻 `resetsAt` も届いている（statusline.ts:18-24、shared/src/api.ts:39）が出していない |
| コンテキスト | 「コンテキスト」「コンテキスト使用率」（views/SessionScreen.tsx:58-62）、「文脈」「文脈の使用率」（views/HomeScreen.tsx:111-112） | コンテキスト、コンテキストの使用率（D8） | 同じ値が画面で違う名前 |
| 使用率と使用量 | 設定「使用量ゲージはこの追記だけが供給源です」（views/SettingsScreen.tsx:145）、ヘッダーのゲージは「使用率」 | ゲージは使用率、設定の集計は使用量 | 割合と量を分ける |
| 分割 | 「分割」「分割（⌘\）」（views/TabStrip.tsx:19）、「分割にはタブが 2 つ必要です」（mediator/sessionView.ts:97）、キーの一覧は「タブを横に並べる」（keys.ts:42） | 横に並べる（D10） | 同じ操作に 2 つの名前 |
| キーの表 | ダイアログの題「キーボード」（views/ShortcutsDialog.tsx:14-15）、パレットとキーの表は「キーの一覧」（presenters/palette.ts:24、keys.ts:38） | キーの一覧 | 開く操作の名前と題を合わせる |
| 右の欄 | 「右レールを隠す」「右レールを出す」（views/ProjectScreen.tsx:32） | 右の欄を閉じる、右の欄を開く | 「レール」は内部の語。サイドバーと目次は「開く」「閉じる」 |
| トークン | 「tokens」（views/SessionScreen.tsx:78）、「トークン」（views/SettingsScreen.tsx:291） | トークン | 英語が混ざる |
| 作業ディレクトリ | 「cwd」（views/SessionScreen.tsx:35） | 作業ディレクトリ | 内部の語。新しいセッションの欄は「通常の作業ディレクトリ」 |
| 要約器の名前 | 「lmstudio」（presenters/format.ts:49、要約の出所） | LM Studio | 設定では「LM Studio」 |
| ロックの文 | 「<PC 名> が応答がありません」（presenters/session.ts:44） | <PC 名> から応答がありません | 「が」が 2 つ続く |
| statusline の表記 | 「statusline」（views/SettingsScreen.tsx:131）、「statusLine の設定」（:135） | statusline | 見出しに合わせる |
| permission mode | 見える文「permission」、読み上げ「permission mode」（views/NewSessionDialog.tsx:116,118）、畳んだ見出しは「permission mode」（:93） | permission mode | 決まり 5。英語の名前を使うこと自体は D12 |

## 3. 決めてほしい点

推奨には ★ を付けています。

### D1 「実行中」の定義と数え方

- ★案 B：実行中は、作業中と休みと起動中。
  入力待ちは含めず、どの画面でも「入力待ち N」として別に数える。
  ホームはすでにこの数え方なので変わらない。
  プロジェクトのカードは「実行中 1、入力待ち 2」のように 2 つ出す。
  セッションの絞り込みは「すべて、実行中、入力待ち、終了」の 4 つにする。
  利点は、どの画面でも足し算が合い、答えが要るものが常に別に見えること。
  手間は、カードの数え方と絞り込み（UI とサーバの `/search` の `running`）を変えること。
- 案 A：実行中は、生きているもの全部（作業中、入力待ち、休み、起動中）。
  ホームの区画の見出しを「作業中と休み」に改め、ホームのプロジェクトの行は「実行中 3（うち入力待ち 2）」とする。
  利点はサーバと絞り込みを変えずに済むこと。
  欠点は、ホームの見出しが長くなり、数が重なって読みにくいこと。

どちらでも、起動中（hangar の run はあるが Claude の一覧にまだ無い）は実行中に数えます。
いまのセッションの絞り込みは起動中を「終了」側に入れているので、そこは直します。
組 A の計画（docs/plans/ux-fixes-1.md の A1）は「作業中（busy か waiting）」と書いていますが、この表では「作業中か入力待ち」です。

### D2 計算機の呼び名

- ★案 A：PC（この PC、他の PC）。
  「この PC で再開」のボタンと、外のターミナルの節、サーバの文がすでに PC。
  利用者の普段の言い方も PC。
- 案 B：Mac。
  いまの対象は macOS だけなので正確だが、同期の相手に Linux が来たときに合わなくなる。
- 案 C：端末。
  CLI の出力に多い。
  ただし画面ではターミナルの意味でも使われていて、取り違えやすい。

### D3 プロジェクトの状態の語

- ★案 A：進めている、止めている、終えた、アーカイブ。
  ホームの区画「確かめる」と同じ動詞の形で、語調に合う。
  要約の見立てやセッションの語（進行中、実行中、完了）と重ならない。
- 案 B：進行中、保留、完了、アーカイブ。
  札が短い。
  ただし「進行中」がセッションの「実行中」と紛れやすく、D4 で要約の語を変えないと「完了」「進行中」が要約と重なる。
- 案 C：英語のまま、表記だけ Active、Paused、Done、Archived にそろえる。
  手間は最小だが、決まり 2 に反する。

### D4 要約の見立ての語

- ★案 A：やりかけ、済んだ、詰まっている、やめた。
  仕事の進み具合の語なので、終わったセッションに「やりかけ」と出ても生き死にと取り違えない。
- 案 B：語は「進行中」などのまま、前に「要約の見立て」と添える。
  例：「要約の見立て 進行中」。
  手間は小さいが、札が長くなり、「進行中」の読み違いは残る。
- 案 C：生き死にと組み合わせて出し分ける。
  終わったセッションで `in_progress` なら「途中で止まった」と出す。
  正確だが、同じ値に 2 通りの語が付く。

### D5 新しいセッション

- ★案 A：新しいセッション。
  ダイアログの題と、昇格の後のボタンがすでにこれ。
  カードのボタン「ここで新規」は「ここで始める」にする。
- 案 B：新規セッション。
  ヘッダーのボタン、キーの一覧、パレット、プロジェクト画面がこれで、数は多い。
  ダイアログの題を「新規セッション」に変える。

### D6 「諦めた本文」の言い換え

- ★案 A：送れなかった本文。
  起きたことをそのまま言う。
  設定の帯は「送れなかった本文 3 件。30 分ごとに送り直します。」にする。
- 案 B：止まっている本文。
- 案 C：あとで送る本文。
  落ち着いて読めるが、エラーの色で出すのと合わない。

### D7 ヘッダーの使用率のゲージの見出し

コードで確かめた中身は、statusline から届く Claude の利用上限の 2 つの枠（5 時間と 7 日）の使用率です。

- ★案 A：棒の前に「5 時間」「週」を常に出す。
  title と読み上げは「5 時間枠の使用率 28%、18:00 に戻ります」のように、戻る時刻を添える。
  設定の文（SettingsScreen.tsx:206）も「週の使用率」に合わせる。
- 案 B：いまの短い名前「5h」「7d」を常に出す。
  幅は取らないが、何の略かは title を見ないと分からない。
- 案 C：見出しは出さず、title と読み上げに戻る時刻だけを足す。

### D8 コンテキストと文脈

- ★案 A：コンテキスト。
  セッション画面、statusline の案内、Claude Code の `/context` と同じ。
- 案 B：文脈。
  短く和語寄りだが、Claude Code の画面と語が違う。

### D9 今すぐ

- ★案 A：今すぐ（今すぐ同期、今すぐ再接続）。
  いま 3 か所が漢字。
- 案 B：いますぐ。

### D10 タブを並べる操作

- ★案 A：横に並べる。
  キーの一覧の語に合わせる。
- 案 B：分割。
  短いが、何が分かれるのかが読めない。

### D11 外部の要約器のスイッチ

- ★案 A：見える文も読み上げも「外部の要約器を許す」。
  下に淡い 1 行「127.0.0.1 と localhost 以外の宛先へ本文を送れるようにします。」を足す。
- 案 B：見える文も読み上げも「手元の外にある要約器を許す」。
  和語寄りだが長く、サーバの文とも合わない。

### D12 新しいセッションの詳細の項目名

- ★案 A：model、effort、permission mode、worktree のまま。
  `claude --help` の名前と同じで、選択肢の方はすでに日本語の説明が付いている（2026-09-30 の choice-controls の決定）。
  見える文「permission」だけ「permission mode」にそろえる。
- 案 B：モデル、考える深さ、許可の方針、worktree と日本語にする。

## 4. 置き換えの対象

推奨案を当てた形です。
D の番号がある行は、その決定しだいで変わります。
パスは `packages/` からの相対です。

### 4.1 UI の文字

| 場所 | 今 | 新 | 決定 |
|---|---|---|---|
| ui/src/presenters/format.ts:46 | `{ in_progress: '進行中', done: '完了', blocked: '詰まっている', abandoned: '中断' }` | `{ in_progress: 'やりかけ', done: '済んだ', blocked: '詰まっている', abandoned: 'やめた' }` | D4 |
| ui/src/presenters/format.ts:49 | `lmstudio: 'lmstudio'` | `lmstudio: 'LM Studio'` | |
| ui/src/presenters/format.ts:50 | `{ active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' }` | `{ active: '進めている', paused: '止めている', done: '終えた', archived: 'アーカイブ' }` | D3 |
| ui/src/views/primitives/StatusSelect.tsx:7 | `label: 'active', sub: 'いま進めている'` | `label: '進めている', sub: 'いま手を動かしている'` | D3 |
| ui/src/views/primitives/StatusSelect.tsx:8 | `label: 'paused', sub: 'いったん止めている'` | `label: '止めている', sub: 'しばらく手を止めている'` | D3 |
| ui/src/views/primitives/StatusSelect.tsx:9 | `label: 'done', sub: 'やり終えた'` | `label: '終えた', sub: 'やることが済んだ'` | D3 |
| ui/src/views/primitives/StatusSelect.tsx:10 | `label: 'archived', sub: '一覧の奥へしまう'` | `label: 'アーカイブ', sub: '一覧の奥へしまう'` | D3 |
| ui/src/views/primitives/StatusSelect.tsx:23 | `{props.value}` | `{STATUS_LABEL[props.value]}`（format.ts から引く） | D3 |
| ui/src/views/ProjectScreen.tsx:25 | `label="ステータス"` | `label="状態"` | |
| ui/src/views/ProjectCard.tsx:13 | `` `${props.name} のステータス` `` | `` `${props.name} の状態` `` | |
| ui/src/views/HomeScreen.tsx:86 | `active なプロジェクトはありません。` | `進めているプロジェクトはありません。` | D3 |
| ui/src/views/primitives/StatusDot.tsx:5 | `idle: '待機'` | `idle: '休み'` | |
| ui/src/presenters/home.ts:73 | `['要対応', waitingHere]` | `['入力待ち', waitingHere]` | |
| ui/src/views/ProjectCard.tsx:24 | `実行中 {props.runningCount}` | `実行中 {props.runningCount}` と `入力待ち {props.waitingCount}` の 2 つ（4.3 の数え方の直し） | D1 |
| ui/src/views/SessionsScreen.tsx:14 | `すべて` `実行中` `終了` の 3 つ | `すべて` `実行中` `入力待ち` `終了` の 4 つ | D1 |
| ui/src/views/SettingsScreen.tsx:232 | `状態 {props.cloud.state}` | `状態 {props.cloud.stateLabel}`（1.5 の設定の列） | |
| ui/src/views/SettingsScreen.tsx:233 | `最終 pull {props.cloud.lastPullAt}` | `最後の受信 {props.cloud.lastPullAt}` | |
| ui/src/views/SettingsScreen.tsx:304 | `` `${props.index.phase} ${props.index.done} / ${props.index.total}` `` | ヘッダーと同じ索引の文（4.3） | |
| ui/src/presenters/shell.ts:71 | `'再構築'` | `'索引の作り直し'`（「索引の作り直し 10 / 200 件」になる） | |
| ui/src/views/SyncStatus.tsx:27 | `諦めた本文 {props.skipped}` | `送れなかった本文 {props.skipped}` | D6 |
| ui/src/views/SyncStatus.tsx:29 | `'一時停止'` | `'同期を一時停止'` | |
| ui/src/views/SettingsScreen.tsx:241 | `諦めた本文 {n} 件。30 分ごとに試し直します。` | `送れなかった本文 {n} 件。30 分ごとに送り直します。` | D6 |
| ui/src/views/SettingsScreen.tsx:249 | `'一時停止'` | `'同期を一時停止'` | |
| ui/src/views/ConnectionBanner.tsx:20 | `いますぐ再接続` | `今すぐ再接続` | D9 |
| ui/src/views/Header.tsx:33 | `aria-label="新規セッション"` と `新規セッション` | `aria-label="新しいセッション"` と `新しいセッション` | D5 |
| ui/src/keys.ts:31 | `label: '新規セッション'` | `label: '新しいセッション'` | D5 |
| ui/src/presenters/palette.ts:21 | `label: '新規セッション'` | `label: '新しいセッション'` | D5 |
| ui/src/views/ProjectScreen.tsx:29 | `新規セッション` | `新しいセッション` | D5 |
| ui/src/views/ProjectCard.tsx:30 | `ここで新規` | `ここで始める` | D5 |
| ui/src/views/PromoteDialog.tsx:69 | `この場所で新しいセッションを開始` | `ここで新しいセッションを始める` | D5 |
| ui/src/keys.ts:43 | `label: 'トランスクリプトの開閉'` | `label: '目次の開閉'` | |
| ui/src/views/TurnIndex.tsx:27 | `'ターミナルを transcript に切り替えられませんでした'` | `'ターミナルの表示を切り替えられませんでした'` | |
| ui/src/views/ConfirmDialog.tsx:21 | `別のターミナル（VS Code など）で動いている claude を` | `外のターミナル（VS Code など）で動いている claude を` | |
| ui/src/views/HomeScreen.tsx:42 | `' · 別のターミナルで動いています'` | `' · 外のターミナルで動いています'` | |
| ui/src/views/ConfirmDialog.tsx:37 | `他の端末の本文で置き換えますか。` | `他の PC の本文で置き換えますか。` | D2 |
| ui/src/views/ConfirmDialog.tsx:40 | `他の端末の本文` | `他の PC の本文` | D2 |
| ui/src/views/SessionScreen.tsx:82 | `本文は他の端末にあります` | `本文は他の PC にあります` | D2 |
| ui/src/views/ProjectCard.tsx:16 | `'この端末にパスがありません'` | `'この PC にパスがありません'` | D2 |
| ui/src/views/ProjectScreen.tsx:34 | `'この端末にパスがありません'` | `'この PC にパスがありません'` | D2 |
| ui/src/presenters/palette.ts:66 | `'この端末にパスがありません'` | `'この PC にパスがありません'` | D2 |
| ui/src/views/SettingsScreen.tsx:158 | `' この端末'` | `' この PC'` | D2 |
| ui/src/views/SettingsScreen.tsx:264 | `' この端末'` | `' この PC'` | D2 |
| ui/src/views/SettingsScreen.tsx:273 | `端末間で合わせます。` | `PC の間で合わせます。` | D2 |
| ui/src/views/SettingsScreen.tsx:311 | 見出し `この端末` | 見出し `この PC` | D2 |
| ui/src/views/SettingsScreen.tsx:145 | `使用量ゲージはこの追記だけが供給源です。追記は端末から行い、UI からは書き換えません。` | `ヘッダーの使用率のゲージは、この追記からだけ届きます。追記はターミナルで行い、この画面からは書き換えません。` | |
| ui/src/views/SettingsScreen.tsx:135 | `statusLine の設定が見つかりません` | `statusline の設定が見つかりません` | |
| ui/src/views/SettingsScreen.tsx:188 | `手元の外にある要約器を許す` | `外部の要約器を許す`（下に淡い 1 行「127.0.0.1 と localhost 以外の宛先へ本文を送れるようにします。」） | D11 |
| ui/src/views/SettingsScreen.tsx:202 | `label="Claude へ切り替える"` | `label="LM Studio が使えないとき Claude へ切り替える"` | |
| ui/src/views/SettingsScreen.tsx:206 | `7 日の使用率が 80% を超えたら切り替えません。` | `週の使用率が 80% を超えたら切り替えません。` | D7 |
| ui/src/views/Header.tsx:28 | `label="5 時間の使用率" short="5h"` | `label="5 時間枠の使用率" short="5 時間"` | D7 |
| ui/src/views/Header.tsx:29 | `label="7 日の使用率" short="7d"` | `label="週の枠の使用率" short="週"` | D7 |
| ui/src/styles/base.css:259 | `.header .gauge-key { display: none; ... }` | `display: inline`（常に見出しを出す）。:264 の狭い幅の規則は棒を畳むだけにする | D7 |
| ui/src/views/primitives/UsageGauge.tsx:9 | `` title={`${props.label} ${percentLabel(props.percent)}`} `` | 戻る時刻を添える。例「5 時間枠の使用率 28%、18:00 に戻ります」（4.3） | D7 |
| ui/src/views/HomeScreen.tsx:111 | `文脈` | `コンテキスト` | D8 |
| ui/src/views/HomeScreen.tsx:112 | `aria-label="文脈の使用率"` | `aria-label="コンテキストの使用率"` | D8 |
| ui/src/views/SessionScreen.tsx:60 | `title="コンテキスト使用率"` | `title="コンテキストの使用率"` | |
| ui/src/views/SessionScreen.tsx:62 | `aria-label="コンテキスト使用率"` | `aria-label="コンテキストの使用率"` | |
| ui/src/views/SessionScreen.tsx:35 | `再開すると cwd はスクラッチのままです` | `再開しても作業ディレクトリはスクラッチのままです` | |
| ui/src/views/SessionScreen.tsx:78 | `{props.tokens} tokens` | `{props.tokens} トークン` | |
| ui/src/views/SessionScreen.tsx:80 | `run {run.kind} {run.started}` | `{RUN_KIND_LABEL[run.kind]} {run.started}`（`{ start: '起動', resume: '再開', fork: 'フォーク' }`、例「再開 3 分前」） | |
| ui/src/runtime/runtime.ts:181 | `'実行中の run がありません'` | `'Claude が動いていないので、シェルタブを開けません'` | |
| ui/src/views/TabStrip.tsx:19 | `aria-label="分割"`、`title` の `'分割（⌘\\）'` | `aria-label="横に並べる"`、`'横に並べる（⌘\\）'` | D10 |
| ui/src/mediator/sessionView.ts:97 | `'分割にはタブが 2 つ必要です'` | `'横に並べるにはタブが 2 つ必要です'` | D10 |
| ui/src/views/ShortcutsDialog.tsx:14 | `aria-label="キーボード"` | `aria-label="キーの一覧"` | |
| ui/src/views/ShortcutsDialog.tsx:15 | `キーボード` | `キーの一覧` | |
| ui/src/views/ProjectScreen.tsx:32 | `'右レールを隠す'`、`'右レールを出す'` | `'右の欄を閉じる'`、`'右の欄を開く'` | |
| ui/src/presenters/session.ts:44 | `'が応答がありません'` | `'から応答がありません'` | |
| ui/src/views/NewSessionDialog.tsx:116 | `permission` | `permission mode` | D12 |

### 4.2 サーバの文（画面のトーストに出るもの）

| 場所 | 今 | 新 |
|---|---|---|
| server/src/runs/manager.ts:107 | `tmux が見つかりません。Settings で tmuxPath を設定してください` | `tmux が見つかりません。設定の「tmux のパス」を入れてください` |
| server/src/server.ts:698 | 同上 | 同上 |
| server/src/runs/manager.ts:118 | `claude が見つかりません。Settings で claudePath を設定してください` | `claude が見つかりません。設定の「claude のパス」を入れてください` |
| server/src/external/open.ts:111 | `VS Code の code コマンドが見つかりません。Settings の codePath を設定してください` | `VS Code の code コマンドが見つかりません。設定の「code のパス」を入れてください` |
| server/src/http/app.ts:366 | `…Settings の「索引を作り直す」を試してください` | `…設定の「索引を作り直す」を試してください` |
| server/src/http/app.ts:389 | `` `${key} は空にできません` `` | `` `「${SETTING_LABEL[key]}」は空にできません` ``（4.3 の見出しの表） |
| server/src/http/app.ts:395 | `` `${key} は文字列か null です` `` | `` `「${SETTING_LABEL[key]}」の値の形が違います` `` |
| server/src/http/app.ts:402 | `terminalApp は terminal か iterm です` | `「ターミナルアプリ」は Terminal.app か iTerm2 から選んでください` |
| server/src/http/app.ts:410 | `lmStudioUrl は http か https の URL です` | `「LM Studio の URL」は http か https で始まる URL にしてください` |
| server/src/http/app.ts:416 | `lmStudioModel は文字列か null です` | `「モデル」の値の形が違います` |
| server/src/http/app.ts:423 | `summaryFallback は true か false です` | `「LM Studio が使えないとき Claude へ切り替える」の値の形が違います` |
| server/src/http/app.ts:428 | `summaryHourlyCap は 1 以上の整数です` | `「1 時間の上限」は 1 から 200 までの整数にしてください` |
| server/src/http/app.ts:433 | `allowExternalSummarizer は true か false です` | `「外部の要約器を許す」の値の形が違います` |
| server/src/http/app.ts:440 | `syncClaudeConfig は true か false です` | `「Claude Code の設定を同期する」の値の形が違います` |
| server/src/http/app.ts:450 | `…外部の要約器は Settings で明示的に許してから指定してください` | `…ほかの宛先は、設定の「外部の要約器を許す」を入れてから指定してください` |
| server/src/http/app.ts:146 | `端末で <code>hangar url</code> を実行すれば` | `ターミナルで <code>hangar url</code> を実行すれば` |
| server/src/sync/engine.ts:56 | `無料枠の 80% に達したので同期を止めました。Settings で再開できます` | `無料枠の 80% に達したので同期を止めました。設定の「同期を再開」で再開できます` |
| server/src/sync/engine.ts:357 | `…他の端末には届きません` | `…他の PC には届きません`（D2） |
| server/src/summary/lmstudio.ts:67 | `…lmStudioUrl の宛先を確かめてください` | `…設定の「LM Studio の URL」を確かめてください` |
| server/src/runs/manager.ts:156 | `` `addDirs にフラグのような値は使えません: ${d}` `` | `` `追加ディレクトリに - で始まる値は使えません: ${d}` `` |
| server/src/runs/manager.ts:262 | `プロジェクトのディレクトリがこの端末で見つかりません` | `プロジェクトのディレクトリがこの PC で見つかりません`（D2） |
| server/src/runs/manager.ts:278 | `projectId は必須です` | `プロジェクトを選んでください`（mediator/launch.ts:28 と同じ文） |
| server/src/runs/manager.ts:520、:581、:643 | `run が見つかりません` | `起動した Claude が見つかりません` |
| server/src/runs/manager.ts:521、:644 | `この run は終了しています` | `この Claude はもう終了しています` |

### 4.3 文字のほかに要る直し

- D1（案 B）の数え方。
  `ProjectCardProps` に `waitingCount` を足し、`runningCount` から入力待ちを引く（presenters/projects.ts:11、home.ts:70-73 と同じ引き方）。
  サーバの `runningCount` が起動中を数えていない点もそろえる（server/src/db/queries.ts:269 は Claude の一覧に載ったものだけ）。
  セッションの絞り込みは、UI の手元の絞り込み（presenters/sessions.ts:15）とサーバの `/search`（server/src/http/app.ts:372-376、server/src/search/search.ts:70）の `running` を、実行中、入力待ち、終了の 3 値にする。
- 同期の状態の語を 1 か所で作る。
  ヘッダーの `syncProps`（presenters/shell.ts:43-50）の表を切り出し、設定の presenter（presenters/settings.ts:48）に `stateLabel` を足して同じ表から引く。
- 索引の文を 1 か所で作る。
  shell.ts:71 の式を関数にし、設定画面（SettingsScreen.tsx:304）もそれを使う。
  `idle` のときの設定の文「N セッション、M プロジェクト」はそのまま残す。
- 使用率の戻る時刻。
  `UsageProps`（presenters/shell.ts:7、:74）に `fiveHourResets` と `sevenDayResets` を足し、`resetsAt` を時刻の文にして title に入れる。
- サーバの設定の見出しの表。
  server/src/http/app.ts に `SETTING_LABEL` を置く。
  `workspaceRoot` は「ワークスペースのルート」、`claudeDir` は「読み取り元」、`tmuxPath` は「tmux のパス」、`codePath` は「code のパス」、`nodePath` は「Node のパス」、`claudePath` は「claude のパス」。
- 「1 時間の上限」の上限のずれ。
  画面は 1 から 200 まで（SettingsScreen.tsx:50）だが、サーバは 1 以上しか見ていない（server/src/http/app.ts:428）。
  文を「1 から 200 まで」にするなら、サーバにも 200 の上限を足す。
- 使っていない値。
  `SessionRowProps.stateLabel`（presenters/row.ts:6、:12）はどの View も描いていない。
  D4 で語を変えるついでに消すか、行に出すかを決める。

### 4.4 試験の直し

次の試験が、置き換える文字列で照合しています。
実装のときに合わせて直します。

- ui：views/screens.test.tsx（Active、Paused、Done、active なプロジェクト、ステータス、文脈、右レール、キーボード、新規セッション）、views/workbench.test.tsx（5 時間の使用率、7 日の使用率、5h、ここで新規、右レール、新規セッション）、views/Shell.test.tsx（5 時間の使用率、いますぐ再接続、今すぐ同期、新規セッション、諦めた本文）、views/misc.test.tsx（外部の要約器、諦めた本文、Settings の）、views/SessionScreen.test.tsx（進行中、tokens、トランスクリプトの開閉、他の端末、分割）、views/overlays.test.tsx（実行中の run、新規セッション）、views/primitives/StatusSelect.test.tsx（ステータス）、views/dialogs.test.tsx（他の端末）、views/NewSessionDialog.test.tsx、presenters/presenters.test.ts（諦めた本文、右レール、分割、Settings の）、presenters/palette.test.ts、mediator/transition.test.ts（いますぐ再接続、分割）、runtime/runtime.test.ts、runtime/api.test.ts、Root.test.tsx（キーボード、他の端末、分割）。
- server：runs/manager.test.ts（Settings で）、config/tools.test.ts（Settings で、tmuxPath を）、http/app.test.ts（Settings の、run が見つかりません、外部の要約器）、sync/engine.test.ts、db/queries.test.ts（この端末）。

## 5. 変えないもの

- ホームの区画の名前「要対応」「確かめる」「実行中」「最近」「プロジェクト」。
- 「引き取る」「hangar でつなぐ」「ターミナルで答える」「この PC で再開」「上書きして再開」「停止」「再開」「フォーク」「昇格」「スクラッチ」。
- サイドバーのワードマーク「Hangar」。
  文の中の「hangar」は小文字のまま（コマンドの名前と同じ）。
- 「claude」と「Claude」の使い分け。
  コマンドとプロセスは小文字の claude、相手としての Claude は大文字。
  いまの画面はおおむねこの通りです。
- 要約の出所の語「自動」「セッション」「事後」（presenters/format.ts:47）。

## 6. 範囲の外で気付いたこと

- CLI（packages/cli/src/cloud.ts、setup.ts、index.ts）は「端末」を PC の意味で多く使い、「最終 pull」「最終 push」「同期: idle」のように内部値も出している。
  D2 が決まったら、別の組で CLI もそろえるかを決めてほしい。
- server/src/tmux/tmux.ts:45、:60 は英語の文（`tmux new-session failed: …`）で、manager.ts:197 の「tmux の起動に失敗しました: 」の後ろにそのまま付いて画面に出る。
- server/src/sync/engine.ts:357 は内部の表の名前（`${named.tableName}`）を文に入れている。
- 設定の「1 時間の上限」は、実際には「Claude に切り替えて要約する回数の 1 時間の上限」（server/src/summary/claude.ts:50）。
  見出しだけでは何の上限か読めないので、設定画面の組み直しのときに見直したい。

## 利用者の決定（2026-10-01）

- D1 「実行中」は作業中、休み、起動中を指し、入力待ちは含めない。
  入力待ちはどの画面でも別に数える（プロジェクトのカードに「要対応 N」）。
  セッションの絞り込みは「すべて、入力待ち、実行中、終了」の 4 つにする。
- D2 計算機は「PC」と呼ぶ（この PC、他の PC）。
  「端末」は使わず、ターミナルは「ターミナル」と呼ぶ。
- D3 プロジェクトの状態は英語のまま、表記だけ揃える（Active、Paused、Done、Archived。頭を大文字にする）。
  推奨案の和語ではなく、利用者がこちらを選んだ。
- D4 要約の見立ては「やりかけ、済んだ、詰まっている、やめた」にする。
- D5 「新しいセッション」に揃える。カードの「ここで新規」は「ここで始める」にする。
- D6 「諦めた本文」は「送れなかった本文」にする。
- D7 ゲージの見出しは「5 時間」「週」を常に出し、ホバーで戻る時刻を出す。
- D8 「コンテキスト」に揃える。
- D9 「今すぐ」に揃える。
- D10 「横に並べる」に揃える。
- ⌘J は「右の欄の開閉」と呼ぶ（live-explainer で右の欄が目次だけではなくなるため。2026-10-01 に利用者が決めた）。
- D11 見える文も読み上げも「外部の要約器を許す」にし、下に淡い 1 行で説明を添える。
- D12 新しいセッションの詳細（model、effort、permission mode、worktree）は claude のオプション名どおり英語のままにする。
- 保持期間の帯とダイアログでは、会話の記録を「会話」と呼ぶ（「N 件の会話が、まもなく削除されます」）。消えるものを利用者の言葉で言う方が伝わるため、ここだけの例外とする（2026-10-01 に利用者が決めた）。ほかの所は「本文」のまま。
