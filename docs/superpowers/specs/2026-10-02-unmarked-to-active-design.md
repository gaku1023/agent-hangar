# 印なしを Active に統合する

2026-10-02。試作は `2026-10-02-unmarked-to-active/model.html`。
`2026-10-01-session-status-design.md` の「状態は 5 つ」と「Active は動いているもの」を、この文書で置き換える。

## 利用者の要望

- 「印なし」を廃止したい。

## 調べたこと

この PC の hangar.db を 2026-10-02 20:16 に数えた。

- 論理削除を除く 1,232 件のうち、Done が 1,225、Paused が 3、印なしが 4 だった。
- 印なしの 4 件は、実行中が 1、止まっているものが 3 である。
- 止まっている 3 件は、作業の途中で run が切れたもの、状態の問いに答える前に run が切れたもの、試験で手で「印なしに戻す」を押したものだった。
  どれも続きがあり、「新しく始めたもの」という元の定義に当たるものは無かった。
- 導入後に始めて止まった 10 本のうち、7 本に状態が付き、3 本が印なしのままだった。
- Sessions のタブでは、実行中のものが Active と印なしの両方に数えられていた。
  タブの件数を足すと 1,233 になり、「すべて」の 1,232 と合わない。

印なしが生まれる道は、新規（行が無い）、問いに答えないまま止まる、resume 後の発言、「印なしに戻す」、提案の却下、同期で届いた行なしのセッションである。

## 決定

### 状態は 4 つ

| 状態 | 持ち方 | 意味 |
|---|---|---|
| Active | `status` が null | 区切りを付けていないもの。既定 |
| Paused | `paused` | あとで戻るしおり。理由と戻る日を持つ |
| Done | `done` | 済んだもの |
| Archived | `archived` | 試し・失敗。既定で隠す |

- 語と並びはプロジェクトの状態と同じにする。
- 動いているかどうかは状態ではなく動きで、丸い点と語（実行中・入力待ち）で見せる。
- どのセッションも 4 つのどれか 1 つに入る。タブの件数は Active ＋ Paused ＋ Done ＋ Archived ＝ 全件になる。
- 「印なし」という語は、画面・コメント・文書から無くす。

### データは変えない

- `session_states` の表、DTO（`SessionStateDto.status` の null）、同期、Worker は変えない。マイグレーションも切らない。
- `status` に `'active'` は足さない。null を Active と読む。
- 古い版の hangar が動く別の PC では、同じ null が「印なし」と出る。データは同じなので食い違わない。

### Sessions のタブ（T1）

- 並びは すべて／確かめる／Active／Paused／Done／Archived にする。
- Active は `status` が null のもの全部である。動いているか、提案があるかは問わない。
- 確かめるは今までどおり、提案が残っているものである。Active と重なる。
- 「すべて」は今までどおり Archived を除く。

### Sessions の節（S2）

- 並びは 今日戻る → 確かめる → Active → Paused → Done（直近 3 件）→ Archived（末尾の 1 行）にする。
- 「いま動いている」と「印なし」の節はなくす。
- 節は状態だけで決める。
  - Archived は Archived。
  - Paused で戻る日が来ていれば今日戻る、先なら Paused。
  - Done は Done。
  - `status` が null で提案があれば確かめる、無ければ Active。
- 動いているものは、節の中で先頭に並ぶ（`sortForSections` の今の並び。入力待ち → 実行中 → 休み → 止まっているものの新しい順）。
- 動いている Done・Paused・Archived は、それぞれの状態の節に入る。
  - park-on-status が入れば、状態を付けたものは休み 10 秒で止まるので、ここに当たるのは作業中のものだけになる。
  - 動いている Archived は末尾の畳んだ節に隠れる。ヘッダーの実行中の数と Home の実行中の札には出る。
- Active の節の「この節だけ見る ▸」は Active のタブへ移る。

### 行の札（M1）

- Active の行には札を付けない。札は区切りを付けたもの（Paused・Done・Archived）と提案だけに付く。
- Active のタブでは、並ぶ行に提案が 1 つも無ければ状態の列を畳み、あれば出す。
  - 手元で絞るときは条件に合う全件で、サーバの検索のときはそのページの行で決める。
- Done・Paused・Archived のタブで列を畳むのは今のまま。

### 「⋯」のメニュー（N1）

- 「印なしに戻す」を「Active に戻す」にする。打鍵は u のまま。
- 状態も提案も無い行では「すでに Active です」と添えて押せなくする。
- 押したときの動きは今のまま（`status` を null にし、提案を消す）。

### 検索のトークン

- `is:active` は `status` が null のものを指す。意味が変わる。
- `is:none` はなくす。打つと、読めないトークンとして欄の下で知らせ、語として本文を探す（今の仕組みのまま）。
- `is:running` と `is:waiting` は今のまま。

### 変えないもの

- プロジェクト画面の節（今日戻る → いま動いている → 続き → Done）。
  「続き」は止まっている Active、提案あり、戻る日が先の Paused である。
- Home（要対応、今日戻る、確かめる、実行中、最近）。
- 提案と承認の流れ、MCP の `propose_session_status`、指示の注入、事後の要約。
- resume 後の発言で状態が外れる決まり。外れた先を Active と呼ぶだけである。

## 実装

### shared

- `intent.ts` の `SearchFilter['status']` と `api.ts` の `SearchParamsDto['status']` から `'none'` を外す。
- `searchTokens.ts` の `STATUS_WORDS` から `none` を外す。
- `sessionState.ts` のコメントを「Active は status の null で表す」に直す。

### サーバ

- `search/search.ts`
  - `status: 'active'` は、`session_states` に `status` が null でない生きた行が無いこと、で絞る。
  - `'none'` の枝を消す。
  - `liveOf` を引くのは `live` の条件があるときだけにする。
- `http/app.ts` の `STATUS_FILTERS` から `none` を外す。知らない値を絞り込みなしとして扱うのは今のまま。
- `sessions/states.ts` と `db/queries.ts` は、コメントの語だけを直す。

### UI

- `presenters/sections.ts`
  - `SectionId` から `'none'` を外し、`'active'` を足す。`'live'` と `'continue'` はプロジェクト画面が使うので残す。
  - Sessions の並びを `returning`・`proposed`・`active`・`paused`・`done`・`archived` にする。
  - `sectionOf` は、Sessions では動きを見ずに状態で決める。プロジェクト画面は今のまま動きを先に見る。
  - `matchesStatus` の `active` は `r.state === null` にし、`none` の枝を消す。
  - `SECTION_TAB` は `active: 'active'` にし、`live` と `none` を外す。
- `presenters/sessions.ts`
  - `TABS` を T1 の並びにし、「印なし」を外す。
  - 状態の列は、Done・Paused・Archived のタブで畳み、Active のタブでは並ぶ行に提案が無いときに畳む。
  - 読めないトークンの案内から `none` を外す。
- `views/SessionRows.tsx` の「⋯」の語と、押せない理由を直す。
- `presenters/row.ts` と `presenters/project.ts` は、コメントの語だけを直す。

### 文書

- `docs/design.md` の Sessions の節（タブと節の並び）と、状態の説明を直す。
- `2026-10-01-session-status-design.md` の「状態」の頭に、この文書で置き換えた旨を 1 行足す。

## 試験

- shared：`is:active` が読め、`is:none` が読めないトークンになる。
- サーバの検索
  - `active` は行の無いもの、`status` が null の行、提案だけの行を返し、Paused・Done・Archived を返さない。
  - `active` は動きを見ない（`liveOf` を渡さなくても同じ結果になる）。
  - `/api/search?status=none` は絞り込みなしと同じ結果になる。
- UI の節
  - Sessions では、動いている Active と止まっている Active が 1 つの節に入り、動いているものが先に来る。
  - 動いている Done は Done の節に、動いている Paused は今日戻るか Paused の節に入る。
  - プロジェクト画面の節は変わらない。
- UI のタブ
  - 並びが T1 になり、Active ＋ Paused ＋ Done ＋ Archived が全件と一致する。
  - Active のタブは、提案のある行があれば状態の列を出し、無ければ畳む。
- UI の行：「Active に戻す」が出て、状態も提案も無い行では押せない。
- 全体：`npm test` と型検査が通る。ビルドして、実物の Sessions 画面で今日の 4 件が Active に並ぶのを見る。

## 取り込みの順

- この枝は main（`bd0b0c3`）から切った。
- 未マージの park-on-status が `presenters/sections.ts` のコメントと `presenters/row.ts` に触っている。
  どちらを先に main へ入れても、後から入れる側がコメントの数行を合わせれば済む。

## 検討して捨てた案

- **B：止まったら必ず「確かめる」へ**。確かめるが溜まり、却下したものの行き場が要る。
- **C：止まったら自動で Done**。「推定で状態を付けない」の決定に反する。今日の 3 件はどれも続きがあり、誤って Done になる。
- **D：語だけ「続き」に変える**。5 つ目の状態が残る。
- **S1：「いま動いている」を残し、止まっているものを「続き」の節にする**。「続き」の中身がプロジェクト画面と食い違い、節とタブが 1 対 1 にならない。
- **T2：タブに動いている数を添える**。ヘッダーの実行中の数と重なる。
- **T3：タブを今の順のままにする**。プロジェクトの状態と並びが違うまま残る。
- **M2・M3：Active の行に札を付ける**。動いている行は点と札で二重になり、プロジェクト一覧で指摘された「Active の札だらけ」と同じになる。
- **N2「状態を外す」・N3「続きに戻す」**。「状態が無い」という考え方か、状態と別の語が残る。
- **Active のタブから提案ありを除く**。タブは重ならなくなるが、4 状態で全件が分かれるという決まりが崩れる。

## 残り

- Active に溜まる量は、導入後の実績で止まった 10 本中 3 本である。使ってみて多ければ、事後の要約の提案（止まった Active に Done か Paused を勧める）を見直す。
- 状態の列が空になる行（Active）は残る。デザイン調査の指摘 F（点の列と状態の列を 1 つにする）で別に扱う。
