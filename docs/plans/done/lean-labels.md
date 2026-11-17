# 補助ラベルと説明文を削る（強め）

2026-10-24 に利用者と決めた。
原則は "Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining."
説明行は既定で隠し、配置、見出し、札、数値で伝える。

ブランチは `worktree-lean-labels`。
組 1 を先に入れ、組 2〜4 は組 1 のコミットから別の worktree で並行して実装し、このブランチへ取り込む。
`docs/design.md` は最後にまとめて直す（組ごとには触らない）。

## 決まったこと

- 強さは「強め」。説明行は既定で隠す。残す説明も、見出しの言い直しを削り、条件、数値、例外だけにする。
- 隠した説明は、見出しの横の ⓘ を押すと浮かぶ。
- 一覧の行の状態は札だけにする。丸と「実行中」の語は札に畳み、実行中は札の中の丸が脈打つ。要約の頭の「進行中・完了・中断」は消す。
- ホームの実行中の帯は、モデルと effort を出さない。

## 残す（画面に常に出す）

- 取り消せない操作の結果（confirm.*、leave、retentionDialog、row.soon.delete、undoBody、adoptNote）。
- 秘密とコスト（summary.external.*、recovery.*、phone.warn、approval.warn、bypassNote、要約エンジンの使用量と送信先）。
- 許可が要る所（通知が拒否されているとき、iTerm2 の許可、信頼確認、dubious ownership のコマンド）。
- 数値、日時、パス、一覧の欠けの告知（bashNote、truncated、slow、gone、unsafe）。
- エラー。

## 組 1：ⓘ の部品

- `views/primitives/InfoTip.tsx` を作る。
  見出しの横に置く小さな ⓘ ボタンで、押すと説明の札が浮かぶ。
  もう一度押す、外を押す、Esc で閉じる。
  札はボタンに `aria-expanded` と `aria-controls` で結ぶ。
  出るときの動きは `motionKit` の `fadeIn` と同じ長さ（`--dur-fast`）と曲線で、4px 下から持ち上がる。
  既存の `primitives/Popover.tsx` が使えるなら、それに乗せる。
- `SetRow` に `info` を足す。
  `info` は見出しの横の InfoTip に入る。
  `desc` は、常に出す必要がある文（上の「残す」）だけに使う。
  この組では SetRow の呼び手の文言は変えない（組 2 で移す）。
- 試験：開閉、Esc、外の押下、aria の結びつき、`info` が無ければ ⓘ を出さないこと。

## 組 2：設定とダイアログ

辞書は `packages/shared/src/i18n/{ja,en}/` の settings.ts、account.ts、cloudMember.ts、cloudUsage.ts、configSyncUi.ts、newSession.ts、newProject.ts、promote.ts、update.ts、compat.ts、mux.ts、editor.ts。

- 設定の SetRow の説明行を `info` へ移し、文を縮める。
  見出しの言い直しの部分を削り、条件、数値、例外だけ残す。
  例：言語「ステータスは英語のままです」、ターミナル「iTerm2 は初回に macOS の自動化の許可を求めます。失敗したら Terminal.app で開きます」、自動 Done「止まって 1 分、3 ターン以下か要約が『完了』『中止』のもの。再開して発言すると戻ります」。
- 削る：retention.desc の「変更前に差分を確認します」、autoDone.desc の ✦ の文、cloud.off.note、cloud.legacy.status、tools.register.desc、update.notifyOff、compat の okLead と okNote の重複、editor.desc の後半、エディタの未検出の行の「–」。
- 同じ文の重複を 1 か所にする：「クローンして npm install したディレクトリで」、確認コードの文（トーストは削る）、approve 系の操作説明 3 か所、tools.parent.desc と candidates.suggestNote、configSync の opNote（札の title へ）。
- ダイアログ：note.quick、hint.quick（ボタンの kbd で足りる）、gitInitNote、gitInit.description、move.description、promote.dialog.lead、add.conflictNote を削る。
- 残す側の文には触らない。

## 組 3：ホームと一覧

辞書は home.ts、row.ts、list.ts、projects.ts、palette.ts、conn.ts、notices.ts、setupGuide.ts。

- 実行中の帯：見出しの「作業中 n、アイドル n」（runningSummary）を消す。「折りたたむ」の語を消し、記号だけにする（aria-label は残す）。行のモデルと effort を出さない。アイドルの行の「アイドル。最後の返答から…」を消し、右に時刻だけ出す。作業中の行の「作業中 1 分」は「1 分」にする。
- 一覧：見出し「セッション 1,685 件」を消す（タブの件数で足りる）。検索欄の placeholder を「検索」にし、記法（is: since: project: file:）は欄の右の InfoTip へ。
- 行：状態は札だけ。丸と「実行中」の語を札に畳み、実行中は札の中の丸が脈打つ（減らす動きの設定では脈打たない）。要約の頭の「進行中・完了・中断」を消す。
- 削る：home.empty.text（textSetup は残す）、projects.empty.body2、home.band.searchNote、unresolvedSummary と sameFolderSummary、notices.list.lead、list.cond.suffix、todo.noNote（空なら行ごと出さない）、palette.empty.noMatch（noItems に寄せる）、palette.hint.open、conn.hard.restartPrompt（ボタンがあるとき）。
- 短くする：SetupGuideCard の desc（読み取り専用と承諾後に変更だけ）、row.candidate.source の「提案元：」、header.gauge.updated（title だけに）。

## 組 4：セッション画面と右欄

辞書は session.ts、terminal.ts、gitUi.ts、overlap.ts、projectScreen.ts、editor.ts、composer.ts、transcript.ts。

- 「いま」の札：「サブエージェント n 件が実行中」と「メイン会話も作業中／入力可能」を消す（チップで足りる）。git のチップの「変更なし」を消す。
- メニューの副行を消し、title に回す：forkNote、attachNote、openTerminalNote、resumeQuickNote。adoptNote は副作用なので画面に残す。
- 指示とメモリ：行の副行（ローカル指示・個人用 など）と、常設の脚注（/context）を見出しの InfoTip へ。instructions.empty は「指示ファイルはありません」だけ。
- 空の状態：toc.empty、transcript.empty.none、gitUi.files.empty、lead.noSummary、diff.noFile を消す（件数 0 か空で見せる）。
- 状態の言い直し：endedHint を消す。trustHint は「信頼確認が出たらターミナルで回答」だけ。terminal.band.sub は {when} だけ。takenOver.line は「{device} に引き継ぎ（{at}）」。gone.note は理由と期間だけ。terminal.off の failedBody を消す。
- 短くする：gitUi.files.othersNote（1 文、列挙は title）、diff.editsNote（「現在のファイルと異なる場合があります」）、unsafe.note の最後の 1 文を削る、editor.missing.maybeMoved を削る、overlap.worktree.hint と overlap.pop.open を削る、composer.tool.pasteHint は添付ボタンの title へ、session.toc.shortcut の title から ⌘J を外す。

## 確かめ

- `npm run typecheck` と `npm test`。文言を参照している試験は、新しい文言に合わせて直す。
- 画面は 4177 の実データに重ねて WebKit で撮る。
