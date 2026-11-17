# notify_user と未読の数（2026-10-29）

## 目的

試用者の声：「依頼の対応が終わって自分待ちなのか分からない」「Done でも最後に確認したい。確認したかどうかも忘れる」「LINE と同じ感覚で話している。出力が出たら横に未読の数が出ればよい（2 件以上もある。途中経過とサブエージェントの結果）」。

エージェントが MCP の道具 `notify_user` で利用者に知らせ、セッションごとに未読の数がたまり、開くと既読になる。
出し先は利用者が設定で選ぶ。既定は全部 ON。

## 決まったこと

- 未読はエージェントが `notify_user` を呼んだ回数で数える。作業中→アイドルの自動の数えは入れない。
- 開いたら既読（0）。Done・Paused・Archived でも、開くまで残す。
- 出し先は 3 つ、どれも既定 ON：
  - 未読の数（サイドバーの行、ホーム、Dock のバッジ）… `unreadBadge`
  - OS の通知（窓が裏のとき。今の殻の通知の ON/OFF にも従う）… `unreadOs`
  - スマホの通知（つないでいれば）… `unreadPhone`
- 指示文に節を足す（Claude、Codex の minimal、opencode の minimal）。設定 `notifyUser`（既定 ON）で切れる。
- 見た目は試作 3 の「案 0」と「イ」で決まった（2026-10-29、利用者の承認済み）。
  - サイドバーの行：ホームの項目の丸（`.nav-count`、`--waiting` の地に白い太字）の小さい版（16px、10px の字）を名前の右に置き、未読の行の名前を太くする。
  - サイドバーのプロジェクトの見出しの右の数字（動いている会話の数、`.side-live-grp-n`）は消す。
  - ホームの項目の丸（`.nav-count`）は、要対応の数＋未読の合計。
  - ホームの帯：要対応と実行中の間に「未読 N」の札（`count-chip`）。押すと引き出しに未読のセッションを並べる（点・名前・プロジェクト・知らせの 1 行・時刻・数）。
  - 動き：丸は膨らんで出る（growIn 相当）、増えると小さく跳ねる、開くと縮んで消える。引き出しの行は上から入る。motionKit の決まった動きと長さのトークンにそろえる。

## インタフェース

### MCP

- `notify_user({ session_id?: string, text: string, to?: ('unread' | 'os' | 'phone')[] })` → `{ ok: true, session_id, at, unread: number, sent: ('unread' | 'os' | 'phone')[] }`
  - text は trim、空は断る、200 字まで（set_turn_intent と同じ数え方）。
  - `to` を省くと、設定で ON の出し先すべて（unreadBadge→unread、unreadOs→os、unreadPhone→phone）。`to` を付けると、その中で設定が ON のものだけ。設定の OFF がいつも勝つ。
  - `to` が空の配列、知らない値を含むときは断る。重複は 1 つにまとめる。
  - `sent` は実際に出した先。全部 OFF で何も出さなかったときも ok: true で `sent: []`（エージェントが知れるように）。
  - `unread` が `sent` に無いときは、未読の数を増やさない（OS とスマホだけに送る）。
  - 構成の考え方：hangar は道具と出し先のスイッチだけを持つ。いつ呼ぶかは指示文の節（既定 ON、設定で OFF）が提案し、利用者は自分の CLAUDE.md で場面と出し先（例：「テストが落ちたらスマホにだけ」）を決められる。
  - セッションの特定と範囲の断りは set_turn_intent と同じ（`sessionIdOf`、`requireSession`）。
  - 道具の名前に state・status を含めない（sessions.test.ts の決まり）。

### DB（マイグレーション 39、端末ローカル、同期しない）

- `session_unread(session_id text primary key, count integer not null, latest_text text, latest_at integer not null)`
- 削除の片付け（`sessions/trash.ts`）に足す。索引の作り直しで消えない別表。

### サーバ内の知らせ

- `notify_user` は書いたあと `touchRow(db, 'sessions', id)` で `session.upsert` を配り、プロセス内の `onUnread((sessionId, text, count) => …)` の購読者へ知らせる（`noteIntent` と同じ形）。
- OS の通知とスマホは、この購読で動く（タスク 3・4）。

### HTTP

- `POST /api/sessions/:id/seen` → 204。count を 0 にし、`touchRow`。行が無ければ何もしない。

### 共有の型

- `SessionDto.unread: { count: number; latest: string | null; at: number } | null`（count 0 なら null）。
- `SettingsDto` に `notifyUser`、`unreadBadge`、`unreadOs`、`unreadPhone`（boolean、`!== false` で読む）。
- `OsNoticeKind` に `'unread'`。
- `PhoneNotice` に任意の `kind?: 'waiting' | 'unread'` と `body?: string`（古いスマホは無視できる形）。

### UI

- 画面がそのセッションに移ったら（`hash.changed` の session）Effect `api.markSeen` を出す。開いて見ている間（窓が前にある）に未読が増えたら、すぐ既読にする。
- サイドバーの行：未読があれば名前を太く、右に小さい丸の数（上の決まり）。見出しの数字は消す。
- ホーム：項目の丸は要対応＋未読。帯に「未読」の札と引き出し。
- Dock のバッジ：入力待ちの数＋未読の合計。数が変わったときに出す（今の `liveStep` は顔ぶれが同じだと出さないので直す）。
- `unreadBadge` が OFF なら、上の 3 つに未読を出さない。
- 設定：指示文の節に「notify_user で知らせる」のスイッチ、通知の節に 3 つのスイッチ。

### 殻（Rust）

- `Kind::Unread` を足す（`item_of`、`parse`、`prefix`、`ALL`、`Keep`、Windows の `toast_group`）。入力待ちの通知と枠を分ける。
- 題はセッションの名前、本文は text。

## 受け入れテスト

1. `notify_user` を 2 回呼ぶと、`GET /api/sessions` のその行の `unread.count` が 2、`latest` が 2 回目の text。
2. `POST /api/sessions/:id/seen` のあと `unread` が null。Done にしても未読は残る。
3. 別のセッションの id を渡すと断る。空の text と 201 字は断る。
4. `TOOL_NAMES` が 20 個、MCP の tools/list と一致。
5. 指示文：`notifyUser` が ON で節が入り、OFF で入らない（Claude、Codex minimal、opencode minimal）。
6. UI：未読 2 のセッションの行に「2」が出て、開くと `api.markSeen` が出る。`unreadBadge` OFF で出ない。Dock のバッジとホームの項目の丸が、入力待ち 1＋未読 2 で 3。帯の「未読」の札が 2 で、引き出しに知らせの文が出る。見出しの数字が無い。
7. OS：`unreadOs` ON で feed に `kind: 'unread'` が積まれ、OFF で積まれない。殻は `unread` を捨てずに読む。
8. スマホ：未読が増えたら `postNotice` が `kind: 'unread'` で 1 回呼ばれる。`unreadPhone` OFF で呼ばれない。古い形（kind なし）も今までどおり読める。

## タスク

1. **サーバと共有の型の核**：マイグレーション、道具、seen の API、DTO、設定のキー、`onUnread`、指示文の節と設定、削除の片付け、i18n、試験、design.md の該当の節。
2. **UI**：既読の Effect、サイドバー・ホームの数、Dock のバッジ、設定のスイッチ、試験。1 の後。
3. **OS の通知**：`onUnread` の購読で feed に積む、殻の `Kind::Unread`、試験。1 の後（2 と並べてよい）。
4. **スマホの通知**：`PhoneNotice` の種類、publisher の比較、sw.js、試験。1 の後。Worker（スマホの頁）の配備は利用者に聞いてから。
