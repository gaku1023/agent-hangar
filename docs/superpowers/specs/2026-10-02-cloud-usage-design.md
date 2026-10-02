# クラウドの使用量と費用の表示 設計

## この文書の位置づけ

設定画面の「クラウド同期」の節に、Cloudflare の使用量（D1 の書き込み、Workers の要求、R2）と今月の費用とプランを出す。
無料枠で同期が止まったときは、ヘッダーの一行でも止まった理由が分かるようにする。
見た目の試作は `2026-10-02-cloud-usage/` にある。`d1-meter.html`（棒の形の 8 案）、`usage-layout.html`（並べ方の 6 案）、`usage-merged.html`（決めた組み合わせと状態ごとの姿、ヘッダーの案）。
実装が済んだら、本体の設計書 `docs/design.md` の Settings とクラウド同期の節へ内容を移す。

## 目的

同期は D1 の書き込みが無料枠（1 日 10 万行）の 80% に届くと自分で止まる。2026-09-01 からは、無料プランで枠を超えると D1 のクエリそのものが失敗する。
それなのに、今日どれだけ書いたか、あとどれだけ書けるかが画面のどこにも出ていない。止まったときも、ヘッダーは手で止めたときと同じ「一時停止中」で、無料枠のせいだと分からない。

うまくいった状態とは、次の四つが揃うことである。

- 設定を開けば、今日の D1 の書き込みと上限、今月の費用、プランが一度に読める。
- 数の出どころ（Cloudflare の正確な数か、hangar の見積もりか）が分かる。
- 無料枠で止まったら、ヘッダーで「無料枠で停止」と分かり、枠が戻った後はそれも分かる。
- トークンを入れていない端末でも、アプリも同期もいままでどおり動く。

## 利用者の決定（2026-10-02）

- 置き場所は設定の「クラウド同期」の節にする。ほかの画面には常設しない。無料枠で止まったときだけヘッダーの文を変える。
- Cloudflare の数と費用は、読み取り専用の API トークンを Worker の secret に置き、Worker 経由で全部の端末に配る（案 2）。
- トークンが無くてもアプリは使える。トークンは setup で入れる。
- 見た目は「札 3 枚（今月の請求・今日の D1・プラン）＋その下に全部の枠の棒」（並べ方の案 3 と案 1 の合わせ）。棒にも D1 を入れる。
- ヘッダーは H1。止まっている間は「無料枠で停止 · 9:00 に戻る」（赤い点）、枠が戻った後は「無料枠で停止 · 枠は戻りました」。
- 見張り（80% で止める判断）を Cloudflare の数に切り替えるのは、この変更に入れない。表示を入れて差を画面で確かめてから、別に決める。

## 範囲の外

- 見張りの数え方の変更（上の決定のとおり）。
- Workers Paid の月の込み量（D1 の月 5,000 万行など）の棒。Paid のときは費用とプランだけを出す（後述）。
- 費用の上限や予算の通知。Cloudflare の Notifications は使わない。
- ほかの画面（Home、セッション画面）への常設の表示。
- トークンを Worker から外す CLI。外すときは `wrangler secret delete USAGE_API_TOKEN` を手で打つ（文書に書く）。

## Cloudflare の API について分かっていること

2026-10-02 に、文書を読み、作ったトークンで実物を叩いて確かめた。

| 知りたいこと | 口 | 実物で返ったもの |
|---|---|---|
| 今日の D1 の書き込み | GraphQL `d1AnalyticsAdaptiveGroups` の `sum.rowsWritten`（日ごと、UTC） | 9/30 は 58,590 行。`avg.sampleInterval` は 1 で、標本抽出なしの正確な数 |
| 今日の Workers の要求 | GraphQL `workersInvocationsAdaptive` の `sum.requests` | 9/30 は 10,596 回。`sampleInterval` は約 1.02 で、ほぼ正確 |
| プラン | `GET /accounts/{id}/subscriptions` | `rate_plan.id` が `r2_paid` の 1 件だけ（月額 0、従量）。`workers_paid` が無いので Workers は無料 |
| 今月の費用と量 | `GET /accounts/{id}/billable-usage`（引数なしで今の請求期間） | 55 行。R2 の 3 項目（保存、Class A、Class B）だけで、請求額はどれも 0。最新の `ChargePeriodEnd` は 10/01 00:00 UTC（= 9/30 分まで） |
| 上限 | `GET /accounts/{id}/entitlements` | 17 件返ったが、Pages やルールの上限だけで、D1・Workers・R2 の無料枠は入っていない |

ほかに分かっていること。

- 要る権限は Account Analytics: Read（GraphQL）と Billing: Read（subscriptions、billable-usage）の二つ。wrangler の OAuth のログインには Billing が無い。
- billable-usage は「期間に請求の基準日が入っていないとデータを返さない」。引数なしなら今の期間が返る。更新は 1 日 1 回。
- `billable/usage`（v2）はこのトークンでは権限不足だった。使わない。
- 上限の正本は文書（D1 と Workers と R2 の料金の頁）。無料プランは D1 の書き込み 10 万行／日、Workers の要求 10 万回／日。R2 は月に保存 10 GB-月、Class A 100 万回、Class B 1,000 万回が込み。日の枠は 00:00 UTC に戻る。
- GraphQL の今日の数は数分遅れで追いつく。

### hangar の数との差

同じ日の D1 の書き込み行数を並べた。

| 日（UTC） | Cloudflare（GraphQL） | Worker の台帳（`meta` の `d1_rows:`） | 端末の見積もり（`QuotaCounter`） |
|---|---|---|---|
| 9/29 | 15,577 | 18,267 | 21,463 |
| 9/30 | 58,590 | 66,486 | 80,009（ここで止めた） |
| 10/1 | 51,249 | 58,322 | 67,913 |

台帳は 1〜2 割、端末の見積もりは 3〜4 割多い。9/30 は Cloudflare の数で 59% のときに止まっている。
台帳との差（9/30 で 7,896 行、10/1 で 7,073 行）は、書き込みのあった要求の数に近い。台帳が自分の 1 文を 2 行で数えている（既にある鍵なら実際は 1 行）ことが原因の筋だが、確かめていない。直すのは見張りの件と一緒に別に扱う。

## 作るもの

### 1. Worker：`GET /usage`

`packages/cloud/src/usage.ts` に置き、`index.ts` で端末トークンの検査（`authMiddleware`）の後ろに足す。認証の検査は読むだけなので、この口は D1 に 1 行も書かない。

束縛を二つ足す（`env.ts` の `Env`）。

- `USAGE_API_TOKEN`（secret）… 読み取り専用の API トークン。
- `CF_ACCOUNT_ID`（secret）… アカウント ID。setup が書く wrangler の設定には、いままでどおりアカウント ID を書かない（設定の頭の注記のとおり）。

どちらかが無ければ `{ configured: false }` を 200 で返す。Cloudflare へは問い合わせない。

あれば、Cloudflare に三つ問い合わせて一つにまとめる。

```ts
type CloudUsageBody =
  | { configured: false }
  | {
      configured: true;
      fetchedAt: number;              // Worker が Cloudflare から取った時刻（写しを返したときはその時刻）
      today: { day: string; d1RowsWritten: number; workersRequests: number } | null;   // GraphQL。day は UTC の yyyy-MM-dd
      plan: { workersPaid: boolean; items: { id: string; name: string; priceUsd: number; frequency: string | null }[]; periodStart: string | null; periodEnd: string | null } | null;
      month: { periodStart: string; throughDay: string | null; billedUsd: number; currency: string; services: { family: string; name: string; consumed: number; unit: string; billedUsd: number }[] } | null;
      errors: { part: 'today' | 'plan' | 'month'; message: string }[];
    };
```

- `today` は GraphQL を 1 回投げて、`d1AnalyticsAdaptiveGroups` と `workersInvocationsAdaptive` の今日の行を取る。行が無ければ 0。
- `plan` は subscriptions から作る。`workersPaid` は `rate_plan.id === 'workers_paid'` の有無。
- `month` は billable-usage の行を `ServiceName` ごとに足す。単位は `PricingUnit`（実物では `ConsumedUnit` が空文字だった）。`billedUsd` は `BilledCost` の和、`throughDay` は最新の `ChargePeriodEnd` の前日（UTC）。
- 三つは独立に取り、一つが落ちても残りは返す。落ちた部分は `null` にして `errors` に 1 行の理由を載せる。理由に API の生の応答やトークンを載せない。
- 写しは isolate のメモリに持つ。`today` は 5 分、`plan` と `month` は 6 時間。D1 にも R2 にも置かない（書けば、数えている書き込みそのものが増える）。
  Cloudflare の文書は workers.dev での Cache API について記載がない（2026-10-02 に確かめた。packages/cloud/src/usage.ts の頭の注記）。isolate のメモリの写しで足りるので使わない。
- 無料プランの CPU は 1 要求 10ms。55 行ほどの JSON を足すだけで、本文を読み回す処理は無い。サブリクエストは最大 3 本。

### 2. 端末のサーバ

`packages/server/src/sync/usage.ts` に、使用量を取って配る役（`CloudUsagePoller`）を置く。

- 同期を設定している端末だけで動く。5 分ごとと、設定画面を開いたとき（UI からの要求）に `GET /usage` を取りに行く。
- 一時停止の間は取りに行かない。一時停止は「外と話すのをやめる」ことで、無料枠で止まったときも同じである（決定 4）。止まっている間は最後に取れた値を出す。
- 要求は `countingClient` を通し、`QuotaCounter` に要求 1 回・行 0 として数える。1 台あたり 1 日 288 回で、Workers の枠の 0.3% にあたる。
- 古い Worker（404）と `configured: false` は「トークンなし」として扱う。
- 取れなかったとき（通信の失敗、5xx）は、最後に取れた値を残し、その時刻と失敗を添えて配る。
- 配る形は `CloudUsageDto`（`packages/shared/src/api.ts`）。HTTP は `GET /api/sync/usage`（`?refresh=1` で取り直す）、websocket は `sync.usage`、bootstrap にも `cloudUsage` として載せる（`usage` は Claude の使用率で使われている）。

```ts
type CloudUsageDto = {
  source: 'cloudflare' | 'estimate';
  fetchedAt: number | null;
  stale: boolean;                       // 最後の取得が失敗している
  limits: { d1RowsPerDay: number; workersRequestsPerDay: number; stopRatio: number };
  today: { d1RowsWritten: number; workersRequests: number | null; resetAt: number };   // resetAt は次の 00:00 UTC
  plan: { label: string; workersPaid: boolean } | null;
  month: { periodStart: string; periodEnd: string | null; throughDay: string | null; billedUsd: number; rows: { label: string; consumed: number; unit: string; included: number | null }[] } | null;
};
```

- `source: 'estimate'` のときは、`today.d1RowsWritten` に `QuotaCounter.d1().rows` を、`workersRequests` にこの端末の要求回数を入れ、`plan` と `month` は `null` にする。
- 上限は共有の定数 `CLOUD_FREE_LIMITS`（`packages/shared`）に置く。D1 と Workers の日の枠は `QUOTA_LIMITS` と同じ値を指す（二重に書かない）。R2 の込み量は `ServiceName` の頭で引く（`R2 Data Storage` → 10 GB-月、`R2 Storage Class A Operations` → 100 万、`R2 Storage Class B Operations` → 1,000 万）。引けない項目は `included: null` で、棒を描かず数だけ出す。

### 3. 止めた理由

`SyncStateKey` に `pausedReason` を足す（`'quota' | 'user'`）。

- `guardQuota` が止めるときは `quota` を書く。UI と CLI から止めるときは `user` を書く。再開で消す。
- `SyncStatusDto` に `pausedReason: 'quota' | 'user' | null` と `quotaPausedDay: string | null`（`QuotaCounter.pausedDay()`、UTC の日）を足す。
- 古いサーバの状態（`paused` だけがある）は `user` として読む。

### 4. 画面

設定の「クラウド同期」の節の、操作ボタン（今すぐ同期、同期を一時停止、参加トークンを表示）の下に「使用量と費用」の段を置く。試作 `usage-merged.html` の左上が正本である。

- 札 3 枚
  - 「今月の請求」… `$0.00` と「9/30 分まで」（`throughDay`）。
  - 「D1 の書き込み（今日）」… 割合と行数。
  - 「プラン」… 「Workers 無料」と「R2 従量」。`plan.items` から組む。
- 棒の一覧
  - 今日の枠（D1 の書き込み、Workers の要求）、区切り、今月の枠（R2 の各項目）の順。
  - 今日の枠の棒には、止める線（上限 × `stopRatio`）に目盛りを打つ。
- 添え書き … 「今日の枠は 9:00 に戻る · 目盛りの 80% で同期を止める」「今月は 9/5〜10/5」と出どころ（「Cloudflare の数 · 2 分前」か「hangar の見積もり」）。
  9:00 は `resetAt` を端末の時刻で書いたもので、決め打ちしない。
- 状態ごとの姿
  - 止まりそう … D1 が止める線の 75% 以上（6 万行）で、札と棒を注意の色（`--busy` と `--st-paused-soft`）にし、「あと N 行で同期を止めます」と出す。
  - 無料枠で停止中 … `pausedReason === 'quota'` のとき、札と棒を止まった色（`--error`）にし、帯「無料枠の 80% に届いたので同期を止めました。9:00 に枠が戻ります。戻ったあと『同期を再開』で再開できます」を出す。
    見張りは hangar の見積もりで止めるので、Cloudflare の数が 80% より小さいことがある。そのときは帯に「（Cloudflare の数では 59%）」と添えて、食い違いを隠さない。
  - トークンなし … 「今月の請求」と「プラン」の札は「—」と「トークンが要ります」にし、D1 の札と棒は「約」を付けた見積もりにする。案内の帯と `npm run hangar -- setup cloud --usage-token` を出す。
  - 取れなかった（`stale`）… 最後の値を出し、出どころの文を「Cloudflare の数 · 14:02 · 取得に失敗」にする。
  - Workers Paid … 今日の枠の棒と D1 の札を出さず、札は「今月の請求」と「プラン」だけにし、棒は今月の項目だけにする。
- ヘッダーの同期の一行（`SyncStatus.tsx` と presenter）
  - `pausedReason === 'quota'` で、今日の UTC の日が `quotaPausedDay` と同じなら「無料枠で停止 · 9:00 に戻る」、点は `--error`。
  - 日が変わっていたら「無料枠で停止 · 枠は戻りました」。
  - 手で止めたときは、いまの「一時停止中」のまま。

### 5. setup

`packages/cli/src/cloud.ts` に、トークンを Worker へ入れる手順（`installUsageToken`）を足す。

- `npm run hangar -- setup cloud --usage-token` … トークンを標準入力から読む。端末なら伏せ字で尋ね、パイプなら 1 行を読む（`op read "op://…" | npm run hangar -- setup cloud --usage-token` で流し込める）。argv には載せない。
- 入れる前に `GET /accounts/{id}/tokens/verify` で有効かを確かめ、続けて subscriptions と GraphQL を 1 回ずつ叩いて、二つの権限があるかを確かめる。足りなければ、足りない権限の名前を出して止める。
- 確かめたら `wrangler secret put USAGE_API_TOKEN` と `wrangler secret put CF_ACCOUNT_ID` に標準入力で渡す。
- 普段の `setup cloud` の最後に「使用量のトークンを入れますか（後からでも可） [y/N]」と尋ねる。標準入力が端末でないときは尋ねずに飛ばす（`setup cloud` に `--yes` は無い）。
- 入れられるのは setup を実行した端末（`cloud.json` に `accountId` と `workerName` がある端末）だけ。参加しただけの端末で `--usage-token` を打ったら、setup した端末で入れるよう案内して止める。
- 作るトークンの中身は案内に出す。アカウントの API トークンで、権限は Account Analytics: Read と Billing: Read の二つだけ。

## 誤りの扱い

- Worker は Cloudflare の API の失敗を部分ごとに `errors` へ畳む。200 で返し、端末を止めない。
- トークンが失効した（401、403）ときは、三つとも `null` にして `errors` に「トークンが無効です。setup cloud --usage-token で入れ直してください」を載せる。端末はトークンなしと同じ姿に、この文を添える。
- 端末のサーバは `/usage` の失敗で同期を止めない。トーストも出さない（設定画面の出どころの文だけで知らせる）。

## 試験

- **偽物は実物の原本から作る。** 2026-10-02 に実物が返した subscriptions、billable-usage、entitlements、GraphQL の応答を、アカウント ID と名前を伏せて `packages/cloud/test/fixtures/` に置き、Worker の試験の偽の fetch はそれを返す。
- Worker：トークンなし、三つとも取れる、一つだけ落ちる、401、写しの期限、D1 に書かないこと（`meta` と `devices` の行数が変わらない）。
- サーバ：古い Worker（404）、`configured: false`、取れたあとの失敗（`stale`）、見積もりへの切り替え、一時停止の間に取りに行かないこと、`pausedReason` の読み書きと古い状態の読み替え。
- 画面：presenter の単体試験で状態ごとの文と色（ふだん、止まりそう、停止中と日の変わり目、トークンなし、取れなかった、Paid）。`SyncStatus` のヘッダーの文。
- CLI：標準入力から読むこと、argv に出ないこと、verify の失敗、権限の不足、参加だけの端末での案内、端末でないときに尋ねないこと。
- 実物での確認：配備した Worker に作ったトークンを入れ、設定画面の数が GraphQL を手で叩いた数と合うことを確かめる。

## 配備

- Worker の変更は、main へ入れた後に `npm run hangar -- setup cloud` で配る（wrangler の設定の `main` がメインの checkout を指すため）。
- 古い端末は `/usage` を叩かないので、Worker を先に入れても端末を先に入れても通じる。
- トークンは 1Password の Employee「agent-hangar Cloudflare usage token」にある（2026-10-02 に作った「agent-hangar usage (read)」、期限なし）。
