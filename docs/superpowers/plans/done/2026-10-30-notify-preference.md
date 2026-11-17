# 知らせ方を言葉で決める（notify preference）計画

2026-10-30 に利用者と決めた。PR #521（notify_user と未読）と #522（指示文の案 D）の続き。

## 決まったこと

- 利用者に「どんなときに知らせてほしいか」を言葉で聞き、その答えで動く。オン・オフや表を並べない。
- 聞くのは 2 か所：hangar が起こした会話のエージェント（知らせ方がまだ無いとき、最初のターンの終わりに AskUserQuestion で 1 度だけ）と、セットアップのすゝめ（手引きの md に段を足す）。
- 仕組みは案 S：
  - エージェントは毎ターン notify_user を呼び、場面を `kind`（`done` 済んだ／`ask` 判断が要る／`progress` 途中）で添える。to は渡さない（利用者がその場で出し先を言ったときだけ to）。
  - 保存のとき、エージェントが利用者の言葉を出し先ごとの場面の決まりに直し、新しい道具 `set_notify_preference({ text, unread, os, phone })` で保存する。保存したら返答で読み返す。会話の途中で「スマホには送らないで」なども同じ道具で直す。
  - サーバは kind と決まりで出し先を振り分ける。
- 設定の画面は試作の案 A：一般の節の「通知を有効にする」の下に「知らせ方」。利用者の言葉の引用と、出し先ごとの決まり（未読の数／Mac の通知／スマホ：すべて・済んだと判断・判断だけ・オフ）を読むだけで見せ、右に「エージェントで変える…」（新しいセッションのダイアログを種付きで開く。すぐには起動しない。「エージェントで調査…」と同じ作り）。まだ決めていないときは既定の文を薄く出す。
- 今の 3 つのスイッチ（unreadBadge・unreadOs・unreadPhone）はこの欄に置き換える。古い設定で OFF だった出し先は、決まりの空の配列として読む。
- 「見ている間も Mac に出す」「返答と入力待ちを 1 通にまとめる」は、言葉で言われたら決まりに入れる（既定：見ている間は出さない、まとめる）。

## 比べの根拠（Sonnet low、claude -p、台本は scratchpad/exp）

- 呼ぶかどうかを利用者の文で決めさせる（案 P）と 1/6 に落ちる。to を毎ターン文から選ばせる（案 Q・R）と場面で分ける文が半分ずれる。
- 案 S は 12/12 で呼び、kind も 12/12 正しい（判断を求める頼みは ask）。
- 文から決まりへの直しは 6 文 × 2 回で 12/12 正しい（最初に空の呼び出しをする回があるので、サーバは欠けた入力を断る）。
- 未確認：-p では AskUserQuestion が使えないため、最初に聞いて保存する流れは実物の会話で確かめる。

## インタフェース

- 設定：`notifyPreference: { text: string, unread: Kind[], os: Kind[], phone: Kind[], whileFocused?: boolean, merge?: boolean } | null`（null は既定。既定は unread すべて、os と phone は done・ask）。
- MCP：`notify_user({ session_id?, text, kind?, to? })`。kind が無ければ done とみなす。to があれば to を優先（設定の OFF は勝つ）。
- MCP：`set_notify_preference({ session_id?, text, unread, os, phone, whileFocused?, merge? })` → 保存した決まりを返す。必須の欠けは断る。
- 指示文：notify の段を案 S の文に替え、保存の段（言われたら保存、読み返す、触れていない出し先は今のまま、今の決まりを差し込む）と、未設定のときだけの「最初のターンの終わりに 1 度聞く」段を足す。Codex・opencode の最小限も同じ趣旨。
- 殻：whileFocused のとき未読の通知は窓が前でも出す。merge のとき、同じ会話で notify_user の直後（数秒）の入力待ちの通知を出さない（または逆）。

## 受け入れ

- 試験：kind × 決まりの振り分け、未設定の既定、古いスイッチからの読み替え、set_notify_preference の断り、指示文の全文と段の順、設定の画面（案 A の表示、未設定の薄い既定、ボタンが種付きダイアログを開く）。
- 実物：hangar から会話を起こし、最初のターンの終わりに聞かれる → 答えが保存される → 次の会話で決まりどおりに出る（Mac は窓を裏に回して）。
- 文言は Gemini に当てる（画面の文）。README の場面は --stale を見る。

## タスクの分け方（implementer、Sonnet）

1. 共有の型と設定（notifyPreference、既定、古いスイッチの読み替え、FITS）
2. サーバ：notify_user の kind と振り分け、set_notify_preference、試験
3. 指示文：ja・en、Claude・Codex・opencode、presenters/injection.ts、試験
4. 殻：whileFocused と merge
5. 画面：設定の案 A とボタンの種、3 つのスイッチを外す
6. 手引きの md の段、docs/design.md
