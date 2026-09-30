# TODO の完了候補 設計

## この文書の位置づけ

セッション（Claude）が「片付いた」と判断した TODO を、完了にせず **完了の候補** として出し、利用者が確かめてから完了にする機能の設計である。
見た目の試作は `2026-09-30-todo-candidates/placement.html` にある。
実装が済んだら、本体の設計書 `docs/design.md` の該当箇所（MCP のツール、指示の注入、Home、プロジェクト詳細、決めた前提）へ内容を移す。

## 目的

TODO はプロジェクトの右レールに住み、今は利用者が手で閉じるか、MCP の `update_project` の `toggle_todos` でセッションが直接閉じる。
直接閉じる道は、Claude が楽観的に「済んだ」と言ったものがそのまま完了になる。
一方で、指示の注入は TODO の本文しか渡しておらず、閉じるよう求めてもいないので、実際にはほとんど閉じられない。

この機能は次の二つを同時に満たす。

- セッションが片付けた TODO を取りこぼさない（セッションに ID を渡し、候補を出すよう求める）。
- 完了にするのは必ず利用者である（MCP からは完了にできない）。

うまくいった状態とは、セッションが終わったあと Home と右レールに候補が並び、根拠を読んで 1 回押せば確定か却下ができ、Claude が勝手に完了にした TODO が 1 件も無いことである。

## 利用者の決定（2026-09-30）

- MCP から TODO を完了にしようとする操作は、すべて完了の候補になる。完了を開き直す操作と追加はそのまま残す。
- 却下した候補は未完に戻す。却下したセッションからは、同じ TODO の候補を受け付けない。別のセッションなら出せる。
- 候補は、プロジェクトの右レールの TODO の中（A1）と、Home の「確かめる」区画（A2）に出す。
- 右レールの候補の行は、根拠の一文と出したセッションと「確定」「却下」を常に見せる（B1）。
- 候補の印は半分塗りのチェック欄（C1）にする。

## 範囲の外

- hangar の外で起動したセッション（注入が入らない）が片付けた TODO を事後に拾うこと。laya などの判断モデルで拾う案は、この機能を使ってみて取りこぼしを数えてから決める。
- 候補を出したセッションの画面に出すこと（A3）と、候補が出た瞬間のトースト（A4）。
- 却下の理由を書いてセッションに返すこと。

## データ

### 列

共有テーブル `todos` に 4 列を足す（マイグレーション version 10）。

```sql
alter table todos add column candidate_at integer;
alter table todos add column candidate_session_id text;
alter table todos add column candidate_note text;
alter table todos add column rejected_sessions text not null default '[]';
```

- `candidate_at` が null でなければ候補である。候補は必ず `done = 0` である。
- `candidate_session_id` は候補を出したセッションである。セッション別でない MCP の URL から出したときは null になる。
- `candidate_note` は根拠の一文（200 字まで）である。`toggle_todos` から来た候補は根拠を持たないので null になる。
- `rejected_sessions` は、この TODO の候補を却下されたセッション ID の JSON 配列である。null のセッションは積まない（したがってセッション別でない URL からの候補は、却下しても出し直せる）。

状態の移り方は次の四つだけである。

| 操作 | 前 | 後 |
|---|---|---|
| 候補を出す（MCP） | 未完・候補でない | 未完・候補（`candidate_*` を埋める） |
| 確定（UI） | 未完・候補 | 完了・候補でない（`candidate_*` を null に） |
| 却下（UI） | 未完・候補 | 未完・候補でない（`candidate_*` を null に、セッションを `rejected_sessions` に積む） |
| 利用者がチェックを付け外し | どれでも | 完了または未完・候補でない（`candidate_*` を null に） |

完了を未完に開き直したとき、`rejected_sessions` は消さない。

### DTO

`TodoDto` に `candidate: { sessionId: string | null; note: string | null; at: number } | null` を足す。
`rejected_sessions` は DTO に載せない。判定はサーバの中だけで行う。

### 同期

同期は行を JSON の payload のまま運ぶので、D1 にマイグレーションは要らない（`session_summaries.source_id` を足したときと同じ）。
列を持たない古い端末は、適用のときに自分の表に無い列を捨てる（`sync/apply.ts` の `tableColumns`）。
競合は今までどおり行ごとに `updated_at` の新しい方が勝つ。
ある端末で確定した直後に、別の端末で同じ TODO の候補が出た、という競り合いは、行ごとの後勝ちに任せる。

## MCP

### `update_project` の引数

`propose_done: [{ todo_id: string; note: string }]` を足す。`note` は必須で、空白を除いて 1 字以上 200 字以下とする。
`toggle_todos` の意味を次のように変える。

- 未完で候補でない TODO は、根拠なしの候補にする。
- 完了の TODO は、今までどおり未完に開き直す。
- 候補の TODO は何もしない。

TODO ごとの結果を `todo_results: [{ todo_id, outcome }]` で返す。`outcome` は次のどれかである。

| outcome | 意味 |
|---|---|
| `proposed` | 候補にした |
| `already_candidate` | すでに候補なので何もしなかった（根拠も上書きしない） |
| `already_done` | すでに完了なので何もしなかった（`propose_done` のみ） |
| `rejected_before` | このセッションの候補は却下済みなので受け付けなかった |
| `reopened` | 完了を未完に開き直した（`toggle_todos` のみ） |

`already_candidate` で根拠を上書きしないのは、先に出た候補を利用者が読んでいる最中に中身が差し替わらないようにするためである。
見つからない ID は今までどおり `ToolError` にし、TODO の書き込みは全部成功か全部失敗のどちらかにする。
`rejected_before` と `already_*` は失敗ではないので、ほかの項目の書き込みを止めない。

ツールの説明文は「プロジェクトのステータスを変え、TODO を足し、片付いた TODO を完了の候補として出し、メモに追記する。完了にするのは利用者である。」に変える。

### `get_project` と `update_project` の TODO の綴り

`todoBriefs` に `candidate: { session_id, note } | null` を足す。
セッションは、自分が出した候補が残っているかどうかをここで確かめられる。

## 指示の注入

`InjectionInput.todos` を `{ id, text }[]` に変え、各行を `- [<id>] <text>` で渡す。
指示に次の 2 行を足す。

```
TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。
完了にするのは利用者です。確かめられていないものは出さないでください。
```

件数の上限（10 件）と、メモの冒頭 500 字の扱いは変えない。

## HTTP

- `POST /api/todos/:id/confirm`：候補を確定する。すでに完了なら何もせず 200 を返す。候補でない未完なら 409 を返す。
- `POST /api/todos/:id/reject`：候補を却下する。候補でなければ 409 を返す。
- 既存の `PATCH /api/todos/:id`（`done`）は、候補の列も必ず null にする。

どれも変更のあとに `todos.update` とプロジェクトを配る（`todosChanged`）。
409 の本文は、画面のトーストにそのまま出せる日本語の一文にする。

## 画面

### 右レールの TODO（A1、B1、C1）

候補の行は、背景を淡い紫にし、チェック欄を半分塗りにする。
行の下に根拠の一文、出したセッションの名前（押すとそのセッションを開く）、候補になってからの時間、「確定」「却下」を置く。
根拠が無ければ「根拠は書かれていません」と出す。
出したセッションが見つからなければ（null、削除済み、まだ同期されていない）、名前の代わりに「不明なセッション」と出してリンクにしない。
候補の行のチェック欄を直接押したときは「確定」と同じに扱う。
読み上げの名前は「<本文>（<n> 件目、完了の候補）」とし、2 つのボタンにも本文と件目を含める。

### Home の「確かめる」区画（A2）

要対応の下、実行中の上に置く。0 件なら区画ごと省く。
全プロジェクトの候補を、候補になった時刻の古い順に 1 件 1 行で並べる。
行には半分塗りの印、TODO の本文、プロジェクト名、出したセッションの名前、経過時間、根拠の一文、「確定」「却下」を置く。
行の本文を押すと、そのプロジェクトの画面へ移る。
プロジェクトの小さな一覧の件数に「確かめる」を足す（0 でなければ出す、ほかの件数と同じ規則）。

### 色

候補の色は新しいトークン `--cand`（`#6a4fd0`）と `--cand-soft`（`#f1edff`）にする。
淡い地の上の文字は `--cand` で、`--cand-soft` の地に対して 4.5 : 1 を超えることを試験で確かめる（計算では約 5.0 : 1）。

## UI の配線

- Intent に `todo.confirm` と `todo.reject`（どちらも `{ id }`）を足す。
- 作用に `api.confirmTodo` と `api.rejectTodo` を足し、`deps.api` に `confirmTodo(id)` と `rejectTodo(id)` を足す。
- `todo.toggle` は、ストアの行が候補なら `api.confirmTodo` に回す。
- Presenter：`TodoItemProps` に `candidate: { note, sessionId, sessionName, ago } | null` を足す。`HomeProps` に `confirm: ConfirmCard[]` を足す。
- 失敗は既存の `fail` のトーストに流す。409 のときは本文の一文を出す。どちらの場合も、画面の正は後から来る `todos.update` である。

## 失敗の扱い

- MCP の `propose_done` で `note` が空か 200 字を超えたら、その呼び出し全体を `ToolError` にする（どの TODO も書かない）。
- 古いサーバ（列を持たない）から来た `bootstrap` や `todos.update` は `candidate` を欠くので、UI は欠けたものを null として扱う。
- 同期で届いた行が `done = 1` かつ `candidate_at` 非 null という矛盾を持っていたら、読むときに完了として扱い、候補は無いものとする（書き直しはしない）。

## 試験

- `projects/todos.ts`：四つの移り方、却下で積むセッションの重複なし、null のセッションを積まないこと、チェックの付け外しで候補が消えること。
- マイグレーション：version 10 で列が足され、既存の行の `rejected_sessions` が `'[]'` になること。
- MCP：`outcome` の各値、却下済みセッションの `rejected_before`、見つからない ID で何も書かれないこと、`note` の検査、`toggle_todos` が未完を完了にしないこと。
- 注入：ID つきの行と、足した 2 行。
- HTTP：confirm と reject の 200 と 409 と 404、PATCH が候補を消すこと。
- 同期：候補の列が往復すること。列を持たない表へ適用したとき、捨てられて他の列は入ること。
- UI：Presenter（候補の行、Home の並び順、件数）、View（B1 の行、区画の省略、読み上げの名前）、Mediator（候補のトグルが confirm に回ること）。
- 実物：hangar から起動したセッションに候補を出させ、`.app` で右レールと Home に出ること、確定と却下が効くこと、却下のあと同じセッションが `rejected_before` を受けることを確かめる。見た目の最終確認は利用者に頼む。

## 作業の場所

同じ作業ツリーでは別のセッションが `ui-refresh-3-motion` の未コミットの変更を持っている。
この機能は `ui-refresh-3-motion` の先端から切った worktree のブランチで作り、`ui-refresh-3-motion` が main に入った後に続けて入れる。
