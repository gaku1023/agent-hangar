# セッションの状態 設計

## この文書の位置づけ

セッションに、利用者の扱いを表す状態（Paused・Done・Archived）を持たせる機能の設計である。
状態は Claude が提案し、利用者が承認する。
プロジェクト画面と Sessions 画面は、この状態で節に分けて見せる。
見た目の試作は `2026-10-01-session-status/` にある。

- `model-v3.html`：一覧の 6 案、提案の見せ方の 3 案、会話での聞き方
- `scenes.html`：P0 と P3 を場面で比べたもの
- `rest.html`：変え方、日の選び方、Home、絞り込み
- `sessions-filter.html`：Sessions 画面の 9 案

実装が済んだら、本体の設計書 `docs/design.md` の該当箇所へ内容を移す。

## 目的

プロジェクトには数十から数百のセッションがたまる。
いまの一覧には、終わったものと続きのあるものを見分ける手がかりがない。
利用者の困りごとは次の 3 つで、どれも当てはまる。

- 終わったものに埋もれる。
- 続きの有無が見分けにくい。
- 試しや失敗のセッションを目の前から消したい。

うまくいった状態とは、次の 3 つがそろうことである。

- 朝にプロジェクトを開くと、前の日に「明日確かめる」と挟んだセッションが一番上にある。
- 作業中は、さっきのセッションへ 1〜3 打鍵で戻れる。
- 済んだものと要らないものが、利用者の手間ほぼなしで続きの邪魔をしなくなる。

## 利用者の決定（2026-10-01）

協議の経緯は「検討して捨てた案」の節に残す。

### 状態

- 状態は次の 5 つである。

  | 状態 | 付け方 | 意味 |
  |---|---|---|
  | 印なし | — | 既定。新しく始めたもの |
  | Active | 自動 | 動いているもの（入力待ち・実行中）。持たずに毎回出す |
  | Paused | Claude が提案して利用者が承認、または利用者が直接 | 「明日の朝確かめる」のような、あとで戻るしおり。理由と戻る日を持つ |
  | Done | Claude が提案して利用者が承認、または利用者が直接 | 済んだもの |
  | Archived | 利用者が直接 | 試し・失敗・ゴミ。既定で隠す |

- 語はプロジェクトの状態と同じ英語にする。
- 削除は作らない。hangar は利用者のファイルを消さない。
- 古いものを自動で Archived にする規則は作らない。
- 推定で状態を付けることはしない。
- resume して利用者が新しく発言したら、状態と提案を外して印なしに戻す。
- 導入のときに、既存のセッションをまとめて Done にする。

### 提案と承認

- 提案の入口は 3 つある。
  - 依頼を終えた区切りで、Claude が会話の中で聞く。
  - 事後の要約のときに作る。
- 承認する場所は、会話の中と hangar の画面の両方である。
- 会話の中で利用者が選んだものは、そのまま状態になる。
- 会話では、Claude が AskUserQuestion の選択肢で聞く。選択肢は「Done にする」「Paused · <日>」「まだ続ける」の 3 つである（試作 C1）。
- 答えずに進めた提案は、画面に候補として残る。
- 却下した提案は、そのセッションに新しい発言があるまで同じセッションから出し直させない。

### 見せ方

- 語と形で描き分ける。
  - 動き：日本語と丸い点（入力待ち・実行中・止まっている）
  - 状態：英語と四角の札
  - 提案：紫の、枠だけの丸い札
  - 戻る日：黄土の丸い札。当日と過ぎたものは塗りつぶす
- プロジェクト画面の一覧は P3 にする。
  - 節は 今日戻る → いま動いている → 続き → Done の順。
  - 中身がある節だけ出す。
  - Done の節は直近 3 件を見せ、残りを畳む。
  - 戻る日を過ぎた Paused は、利用者が決めるまで「今日戻る」に残す。
- 提案の札は Q3 の見た目（枠だけ）にし、押すと Q1 のポップが開く。ポップには根拠と「確定」「日を変える」「却下」がある。
- 手で状態を変える入口は A2 にする。行の右端の「⋯」から 4 択を出す。
  - Paused にする…
  - Done にする
  - Archived にする
  - 印なしに戻す
- Paused の入れ方は B1 にする。
  - 戻る日は札から選ぶ：今日の夕方・明日・月曜・来週・日付を選ぶ…
  - 理由は 1 行の欄に書く。
- Home の「今日戻る」は C1 にする。要対応の札の隣に黄土の札を並べる。
- Sessions 画面は ★ にする。
  - 条件がないときは節で読む。
  - 件数つきの状態のタブを置き、押すとその節を全件に広げる。
  - 検索欄でトークン（`is:paused` など）を受ける。
  - 動きの切替は外し、行の丸い点だけにする。
  - 行の札を押すと、そのタブへ移る。

## 範囲の外

- 一括の操作（複数を選んでまとめて Done にするなど）。導入時の一括 Done だけは行う。
- Claude Code の `claude -r` の一覧に状態を反映すること。hangar の状態は Claude Code の側に何も書かない。
- 戻る日の時刻。戻る日は日付だけで持つ。「今日の夕方」と「明日の朝」は、それぞれ今日と明日として扱う。
- 戻る日の通知（macOS の通知や Discord）。
- 動きの絞り込みを Sessions 画面に戻すこと。`is:running` と `is:waiting` の打鍵で届くようにしておき、使ってみて要るかを見る。

## データ

### 表

共有テーブル `session_states` を新しく作る（マイグレーション version 13）。

```sql
create table session_states (
  session_id text primary key references sessions(id),
  status text check (status in ('paused','done','archived')),
  note text,
  return_on text,
  set_by text check (set_by in ('user','conversation','import')),
  set_at integer,
  candidate_status text check (candidate_status in ('paused','done')),
  candidate_note text,
  candidate_return_on text,
  candidate_source text check (candidate_source in ('in_session','exit','post_hoc')),
  candidate_at integer,
  rejected_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
```

列の意味は次のとおりである。

- `status`：null は印なしである。
- `note`：Paused の理由（200 字まで）。Done では任意。
- `return_on`：戻る日。`YYYY-MM-DD` の形の手元の暦の日付。Paused のときだけ持つ。
- `set_by`：誰が付けたか。
  - `user`：hangar の画面で利用者が選んだ。
  - `conversation`：会話の中で利用者が選び、Claude が書いた。
  - `import`：導入時の一括。
- `candidate_*`：提案である。`candidate_at` が null でなければ提案がある。
- `rejected_at`：最後に提案を却下した時刻。新しい発言で null に戻す。

`sessions` 表に列を足さないのには理由がある。
`sessions` の行は索引のたびに全列を読んで書き直され（`indexer/indexFile.ts` の `applySessionFacts`）、同期は行ごとの後勝ちである（`sync/apply.ts`）。
状態を同じ行に置くと、別の PC で付けた Paused が、本文を持つ PC の索引で上書きされる。
索引は `session_states` を書かない。

### 状態の移り方

| 操作 | 書き手 | 前 | 後 |
|---|---|---|---|
| 提案する | MCP（`confirmed` なし）・事後の要約 | 提案なし、`rejected_at` が null | `candidate_*` を埋める |
| 会話で選ぶ | MCP（`confirmed: true`） | どれでも | `status` を書き、`set_by='conversation'`、`candidate_*` を null に |
| 確定 | 画面 | 提案あり | 提案の中身を `status` に写し、`set_by='user'`、`candidate_*` を null に |
| 却下 | 画面 | 提案あり | `candidate_*` を null に、`rejected_at` に今の時刻 |
| 手で選ぶ | 画面 | どれでも | `status` を書き、`set_by='user'`、`candidate_*` を null に |
| 印なしに戻す | 画面 | どれでも | `status`・`note`・`return_on`・`candidate_*` を null に |
| 新しい発言 | 索引 | 発言の時刻が `set_at`・`candidate_at`・`rejected_at` のどれより後 | 全部を null に（印なし） |

- 確定のときに日を変えたら、変えた日を `return_on` に書く。
- 提案があるところへ新しい提案が来たら、上書きする。前の提案は、新しい発言の時点で消えているはずである。それが残っているのは、同じターンの中で出し直した場合だけである。
- 提案が `rejected_at` で断られたときは、MCP の結果で `rejected_before` を返す。

「新しい発言」は、利用者が打った発言（`event_index` の `kind='user'`。ツールの結果は `tool_result` で別の種類）に限る。実装の最初に、`kind='user'` に打った発言しか入っていないことを確かめる。
AskUserQuestion への答えはツールの結果なので、状態を外さない。
これを数え違えると、会話で選んだ直後に状態が外れてしまう。

### 導入時の一括 Done

マイグレーション version 13 の中で、`deleted_at` が null のすべてのセッションについて、`status='done'`、`set_by='import'`、`set_at=<今>` の行を作る。
この行は変更ログ（`changes`）に積まない。
理由は、各 PC が自分のマイグレーションで同じ行を作るので、送る必要がないからである。
加えて、1,221 行を D1 へ送ると無料枠の書き込みを無駄に使う。
後から別の PC の同期で届いたセッションには行がなく、印なしになる。それで差し支えない。

### DTO

`SessionDto` に `state` を足す。

```ts
state?: {
  status: 'paused' | 'done' | 'archived' | null;
  note: string | null;
  returnOn: string | null;
  setBy: 'user' | 'conversation' | 'import' | null;
  candidate: { status: 'paused' | 'done'; note: string | null; returnOn: string | null; source: 'in_session' | 'exit' | 'post_hoc'; at: number } | null;
} | null
```

- 古いサーバからは欠けるので任意項目にし、欠けたら印なしとして扱う。
- `rejected_at` は DTO に載せない。判定はサーバの中だけで行う。
- 状態が変わったら `session.upsert` で配る。

### 同期

- `session_states` を共有テーブルの一覧（`shared/src/cloud.ts`）に足す。
- D1 は行を JSON のまま持つので、クラウドのマイグレーションは要らない。
- 競合は行ごとの `updated_at` の後勝ちに任せる。
- 状態を変えるのは利用者と Claude だけで、索引が書くのは「新しい発言」で外すときだけである。だから競り合いはほとんど起きない。
- 古い端末は、知らない表の変更を捨てる。捨て方は `sync/apply.ts` の既存の扱いに従う。

## MCP

### `propose_session_status`

新しいツールを足す。

```
propose_session_status({
  session_id?: string,
  status: 'done' | 'paused',
  note: string,          // 根拠の一文。1〜200 字
  return_on?: string,    // YYYY-MM-DD。paused では必須
  confirmed?: boolean    // 利用者が会話の中で選んだときだけ true
})
```

- セッション別の URL（`/mcp/s/:id`）では `session_id` を省ける。共通の URL では必須にする（`sessionIdOf` と同じ）。
- `confirmed` がないか false なら、提案として書く。true なら状態を書く。
- 結果の `outcome` は次のどれかである。

  | outcome | 意味 |
  |---|---|
  | `proposed` | 提案にした |
  | `set` | 状態にした（`confirmed: true`） |
  | `rejected_before` | このセッションの提案は却下済みなので受け付けなかった |
  | `already_set` | 同じ状態がすでに付いているので何もしなかった |

- `note` が空・200 字超え、`return_on` の形が違う、paused に `return_on` がない、のどれかなら `ToolError` にして何も書かない。
- ツールの説明文：「このセッションの状態（Done か Paused）を提案する。利用者が会話の中で選んだときだけ confirmed を true にする。利用者に聞かずに true にしてはいけない。」

hangar は `confirmed` の申告を確かめられない。
利用者の決定（2026-10-01）として、その余地は受け入れる。
代わりに `set_by='conversation'` を残し、行のポップに「会話で承認」と出して、後から分かるようにする。

`set_session_summary` の `state`（in_progress / done / blocked / abandoned）は要約の見立てで、この状態とは別物である。今は変えない。

## 指示の注入

`renderInjection` の TODO の 2 行の後に、次の 3 行を足す。

```
頼まれたことを終えたと判断したターンの終わりに、AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <戻る日>（何を確かめに戻るか）」「まだ続ける」です。
利用者が Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。
途中のターンでは聞かないでください。
```

`injection.test.ts` の期待文も直す。

## HTTP

- `PUT /api/sessions/:id/state`：手で状態を変える。
  - 本文は `{ status: 'paused' | 'done' | 'archived' | null, note?, returnOn? }`。
  - `null` は印なしに戻す。paused で `returnOn` がなければ 400 を返す。
- `POST /api/sessions/:id/state/confirm`：提案を確定する。
  - 本文は `{ returnOn? }` で、日を変えたときだけ渡す。
  - 提案がなければ 409 を返す。
- `POST /api/sessions/:id/state/reject`：提案を却下する。提案がなければ 409 を返す。

どれも MCP からは呼べない（TODO の confirm と同じ）。
変更のあとに `session.upsert` を配る。
409 と 400 の本文は、トーストにそのまま出せる日本語の一文にする。

## claude.zsh で抜けるとき（やめた）

当初は、claude.zsh で会話を抜けるときに「Done / 明日の Paused / そのまま」を聞く予定だった。
2026-10-02 に、main の claude.zsh が作り直された（ターミナルで起動した claude を、hangar の tmux の中で hangar の run として起こす）。
これでターミナルの会話にも起動時の指示と MCP が渡るので、依頼を終えた区切りで Claude が会話の中で聞く。
抜けるときの問いはそれと重なるので、利用者の決定（2026-10-02）でやめた。
答えずに抜けた会話は、事後の要約で提案を作る。

## 事後の要約

- `summary/types.ts` の `SUMMARY_SCHEMA` に `proposed_status: 'done' | 'paused' | 'none'`、`proposed_note`、`proposed_return_in_days`（paused のとき 1〜14）を足す。
- `SUMMARY_SYSTEM_PROMPT` に判定の仕方を書く。
  - 頼まれたことが終わり、確かめることも残っていなければ done にする。
  - 終わったが確かめることが残っていれば paused にする。
  - まだ途中なら none にする。
- 書くのは `summarizeOne` の要約の upsert の直後で、次の 2 つがそろうときだけ提案を作る。
  - 状態も提案もなく、`rejected_at` も null である。
  - セッションが止まっている。
- 追加の呼び出しはしない。LM Studio 側の出力の検査（`parseSummaryOutput`）にも、新しい項目を任意として足す。

## 画面

### 行（SessionRows）

- 右端の時刻の左に、次の順で札を並べる。
  1. 動きの語（入力待ち・実行中）
  2. 提案の札（あれば）
  3. 状態の札（Done・Archived。Paused は 2 段目の頭に戻る日の札で出す）
  4. 「⋯」
- 2 段目の頭は、Paused なら戻る日の札、それ以外は今の要約の札（`row-state`）にする。
- 「⋯」は `MenuButton` を使う。
  - 押しても行が開かないように、包む要素でクリックを止める。portal の中の項目のクリックも止める。
  - 打鍵は行にカーソルがあるとき `.`（ピリオド）でも開く。
- 提案の札を押すとポップが開く。
  - 根拠の一文と、出どころ（会話・要約）と時刻を出す。
  - ボタンは「確定」「日を変える」（Paused のみ）「却下」。
- `set_by='conversation'` の状態は、札にポインタを乗せると「会話で承認」と出す。
- Archived の行は、出すときに名前を淡くする。

### Paused の入力（B1）

- 開く入口は 2 つ。「⋯」の「Paused にする…」と、提案のポップの「日を変える」である。
- 戻る日の札は 5 つ。
  - 今日の夕方：今日
  - 明日：明日
  - 月曜：次の月曜。今日が月曜なら 7 日後
  - 来週：7 日後
  - 日付を選ぶ…：暦が開く
- 打鍵 1〜5 で札を選べる。
- 理由の欄は 1 行で 200 字まで。提案から開いたときは根拠が下書きとして入る。
- 「Paused にする」で確定し、Esc でやめる。

### プロジェクト画面（P3）

節は上から次の順で、中身がある節だけ出す。

1. **今日戻る**：Paused のうち、戻る日が今日か過ぎたもの。戻る日の古い順。過ぎたものは札を「N 日過ぎ」にする。
2. **いま動いている**：入力待ち → 実行中 の順（今の `LIVE_ORDER`）。状態が付いていても、動いている間はここに出す。
3. **続き**：印なし、提案あり、戻る日が先の Paused。新しい順。
4. **Done**：新しい順に 3 件、その下に「ほか N 件 ▸」の行。押すと、この節に全件を出す。

- Archived は末尾の「Archived N 件 · 表示」から開く。
- 節の見出しは `VirtualList` の高さの違う項目として通す（`rowHeight` を関数にする）。
  - 一覧の項目の型を、行と見出しの和にする。
  - カーソル（j/k、Tab、クリック、消えたときに未選択へ戻すこと）は見出しを飛ばす。
- 提案を確定した行は、Done の節の先頭へ移る。直近 3 件の中に入るので見失わない。

### Home（C1）

- 要対応の札の並びに「今日戻る」の札を足す。
  - 黄土の札で、名前・プロジェクト・理由・戻る日を出す。
  - 型は `ReturnCard = { id, name, projectName, reason, returnOn, overdueDays }` とし、`HomeProps` に `returning` を足す。
  - 並びは、入力待ちの札の後に戻る日の古い順。
  - 札に出したものは「最近」から外す。
- セッションの提案は「確かめる」の区画に、TODO の候補と並べて出す。
  - 行の頭は提案の札（「Done にする？」「Paused · 明日？」）。
  - 並びは、候補になった時刻の古い順で TODO の候補と混ぜる。
- 「今日」の境は `periodStart(1, now)` と同じ手元の暦にする。

### Sessions 画面（★）

- 検索欄の上に、件数つきの状態のタブを置く。
  - すべて／確かめる／Paused／Active／印なし／Done／Archived
  - 確かめるの件数は、1 件以上なら紫で灯す。
- 条件がない（キーワード・プロジェクト・期間・ファイル・タブがすべて既定）ときは、節で読む。
  - 節：今日戻る → 確かめる → いま動いている → Paused → 印なし → Done（直近 3 件）
  - Archived は末尾の 1 行から開く。
  - 節の見出しの「この節だけ見る ▸」は、そのタブを選ぶのと同じである。
- 条件があるか、「すべて」以外のタブを選んだときは、節を消して平らな結果にする。
  - 「すべて」のタブで条件を入れたときは、Archived を除く。
- 「状態」の Segmented（動き）は外す。
- 検索欄は次のトークンを受ける。
  - `is:paused` `is:done` `is:archived` `is:active` `is:none` `is:proposed`：タブと同じ
  - `is:running` `is:waiting`：動きで絞る
  - `since:<n>d`：期間
  - `project:<名前の前方一致>`
  - `file:<パス>`
- トークンは欄の中でチップになる。
- タブや絞り込みを押すと、欄にもトークンが出る。欄を正とし、タブと絞り込みはその表示である。
- 行の状態の札を押すと、そのタブへ移る。
- 状態での絞り込みは、手元の絞り込み（`presenters/sessions.ts`）とサーバの検索（`search/search.ts`、`/api/search` の query に `status` を足す）の両方に足す。

### 色

- 状態の色は既存のトークン（`--st-*`）を使う。
- 提案は `--cand` を使う。
- 戻る日の札は `--st-paused` を使う。塗りの札は地が `--st-paused`、文字が白である。この組み合わせが 4.5 : 1 を超えることを試験で確かめる。

## UI の配線

- Intent に次を足す。
  - `session.state.set`（`{ id, status, note?, returnOn? }`）
  - `session.state.confirm`（`{ id, returnOn? }`）
  - `session.state.reject`（`{ id }`）
  - `session.state.pauseDialog`（`{ id, from: 'menu' | 'candidate' }`）
  - `sessions.tab`（`{ tab }`）
- 作用に `api.setSessionState`・`api.confirmSessionState`・`api.rejectSessionState` を足す。
- Presenter は次のように変える。
  - `SessionRowProps` に `state`・`candidate`・`returnOn` を足す。
  - プロジェクト画面と Sessions 画面の一覧を「節と行の並び」にする。
  - 節分けは純粋な関数 1 つにまとめる。両画面で同じ関数を使い、節の種類だけを引数で変える。
- `SearchFilter` に `status` と `proposed` を足し、トークンの読み書きは `shared` の純粋な関数にする（読む：文字列から条件へ、書く：条件から文字列へ）。
- 失敗は既存の `fail` のトーストに流す。画面の正は、後から来る `session.upsert` である。

## 失敗の扱い

- MCP の検査に落ちたら、何も書かない。
- 古いサーバから来た `SessionDto` は `state` を欠くので、印なしとして扱う。
- 同期で届いた行が `status` と `candidate_*` を両方持っていたら、読むときは状態を正とし、提案はないものとする（書き直しはしない）。

## 試験

- **状態の移り方**（`sessions/states.ts` など新しい単位）
  - 表の 7 つの操作
  - `rejected_before`
  - 新しい発言で外れること、AskUserQuestion の答えでは外れないこと
  - 発言の時刻が `set_at` より前なら外さないこと
- **マイグレーション**
  - version 13 で表ができること
  - 既存のセッションが全部 Done になること
  - `changes` に積まれないこと
  - 削除済みのセッションには行を作らないこと
- **MCP**
  - `outcome` の 4 つ
  - 検査（`note` の長さ、`return_on` の形、paused に日がないとき）
  - 共通の URL で `session_id` がないとき
- **注入**：足した 3 行
- **HTTP**：3 つの入口の 200・400・404・409。MCP から呼べないこと
- **要約**
  - スキーマの新しい項目
  - 提案を作る条件（状態あり・提案あり・却下済み・動いている、ではいずれも作らない）
- **同期**
  - `session_states` の往復
  - 古い端末が知らない表を捨てること
  - 別の PC の索引が状態を上書きしないこと
- **UI**
  - 節分けの関数：各場面（導入の翌日、平日の朝、作業中、2 週間後）で節と順番を確かめる
  - トークンの読み書きの往復
  - Home の並び
  - View の見出しを飛ばすカーソル
  - 「⋯」を押しても行が開かないこと
  - 色の比
- **実物**
  - hangar から起動したセッションに区切りで聞かせ、会話で Done を選んで状態になること
  - 答えずに進めて候補が残ること
  - ターミナルで起動した claude（hangar の run になる）でも、区切りで聞かれること
  - `.app` で節・札・ポップ・Home・Sessions のタブとトークンを確かめる。窓は 900×600 と 1440×900 で見る
  - 見た目の最終確認は利用者に頼む

## 計画の分け方

計画は次の 3 段に分け、段ごとに main へ入れられるようにする。

1. **データと入口**
   - 表とマイグレーション、状態の移り方、MCP、HTTP、同期、DTO
   - 画面は行の札と「⋯」だけ
2. **画面**
   - 節分けの関数、プロジェクト画面、Sessions 画面（タブ・節・トークン）、Home、Paused の入力、提案のポップ
3. **提案の入口**
   - 指示の注入、事後の要約

## 検討して捨てた案

- **推定で状態を付ける**：実行中・3 日以内なら Active、札なしで 30 日以内なら Paused、それ以前は Archived。
  - この PC の hangar.db（1,221 件、Claude が札を書いたのは 39 件）に当てた結果、2 方向に崩れた。
    - よく触るプロジェクトは Active がふくらむ（agent-hangar で 57 件中 40 件）。
    - しばらく触っていないプロジェクトは、開くと空になる（金剛山プロジェクトで 167 件中 167 件が Archived）。
  - 加えて、「付けた覚えのない Paused」が、しおりとしての Paused を薄める。
- **留める・しまうの 2 つの印だけ**（Fable の最初の推奨）：利用者が、プロジェクトと同じ 4 状態を選んだ。
- **節なしの 1 本の流れ（P0）**（Fable の推奨）：利用者は P3 を選んだ。
  - 実測では、30 分以上あけた再開 86 回のうち、新しい順で 1 番目が 69%、3 番目までが 89% だった。
  - Done を全部畳む P3 の弱点（導入の翌日に空になる、確定した行が消える）は、直近 3 件を見せることで手当てした。
- **Sessions 画面の動きと状態の 2 本の切替（D1）**：同じ形の部品が 2 本並ぶと混ざる。
