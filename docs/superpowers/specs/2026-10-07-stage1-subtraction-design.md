# 段 1 引き算

作り替えの全体計画（`2026-10-07-refactor-roadmap-design.md`）の段 1 である。
全体計画の D4、D6、D7、D10 で消すと決めたものと、使われていない口と、古い版のための分岐を消す。
後の段で動かすものを先に減らすのが目的で、機能は足さない。
足すのは、消したものの代わりに要る 2 つ（互換の版番号と、上限による失敗で退く処理）だけである。

## 消すもの

調査（2026-10-07、main `b408223`）で、消すときに触るファイルと行、壊れる試験、残すべき境界を数えた。
行は各 PR の計画で数え直す。

- **引き継ぎ（takeover）一式**：表を共有テーブルの一覧（`SHARED_TABLES`、`TABLE_PK`）から外し、DTO、ServerEvent、Intent、UI の `NOT_YET_INTENTS` を消す。表そのものは v1 のマイグレーションにあるので、マイグレーションからは消さない。
- **Claude Code の設定の同期（D6）**：`sync/claudeConfig.ts`、puller の config の経路、Worker の `kind: 'config'` の受け入れ、UI の下見のダイアログと Intent、設定の `syncClaudeConfig`、CLI の teardown の `_config` の退避。
- **端末側の無料枠の見張りと Worker の台帳（D4）**：`sync/quota.ts`、`server.ts` の `D1_WRITES_*` と `countingClient`、`d1RowsToday`、台数割り、`pausedReason` と `quotaPausedDay`、Worker の `meter.ts` と `meteredBatch`、`meteredRun`。
- **Provider のインターフェース（D7）**：`provider/types.ts` の `interface Provider` だけを消す。
- **使われていない口**：Intent `summary.toggle`、`Overlay.notYet`、ServerEvent `sync.applied`、UI の `ApiClient.devices` と `syncStatus`、`deleteFile` と Worker の DELETE、MCP `search_sessions` の `provider` 引数、`parseBackgroundedId`、未参照の CSS クラス。どれも、各 PR で `git grep` をもう一度回して未使用を確かめてから消す。
- **古い版のための分岐**：相手が別の機械や別の部品のもの（古い端末、古い Worker、古いサーバ）は、互換の版番号を入れてから消す。手元だけで閉じるもの（DTO の任意項目、kind の無い `POST /api/projects`、`SummaryEnqueueOpts` の真偽値、殻の `_up_/server-dist`）は先に消す。
床の無い `cloud.json` の保険は消さない。古い版のためではなく、DB に床の行が無い端末（DB の写しを置いた別の `HANGAR_HOME` もこれにあたる）すべてのための保険で、消すと本文を全部上げ直すためである。
- **同梱の重複**：cli.mjs がサーバ全体を抱えている（`cli/src/index.ts` がサーバの入口から import している）のをやめる。同梱の `cloud/` は、目印で必ず断るので誰も使っていない。これを Worker を 1 本にビルドしたものに替える。殻がサーバへ渡している `HANGAR_CLOUD_DIR` は、サーバが読んでいないので消す。

## 残す境界

消すものと部品を共有しているので、残すものを先に決める。

- **「1 回だけ同期」（`PausedPass`）は残す。** 利用者が自分で一時停止したときの「今すぐ同期」でも使っている。
- **端末の台数（`deviceCount`）は残す。** CLI の `hangar cloud status` が出している。消すのは、台数で割って見積もる所だけである。
- **使用量の表示（`CloudUsagePoller`、`sync/usage.ts`、Worker の `/usage`、`CLOUD_FREE_LIMITS`）は残す。** 見積もり（`estimate`）が見張りに頼っているので、トークンが無いときの形を「数は不明」に替える。
- **puller と teardown は、`kind` が transcript でない行を読み飛ばす。** 古い端末が上げた設定の行が R2 と同期の記録に残っているので、分岐ごと消すと、本文の取り込みと teardown がその行で止まる。
- **控えの世代数（`BACKUP_GENERATIONS`）と `backups/claude-config/` の置き場は残す。** 本文とメモの控え、保持期間の書き込みも使っている。定数は設定の同期のファイルから移す。
- **パスの検査（`isSafeRelPath`、`MAX_REL_PATH_CHARS`、`encodeHeaderText`）は残す。** 本文の上げ下ろしも使っている。
- **`sessions.provider` の列と一意の制約、`files.kind` の列は残す（D8）。**
- **知らない列を捨てる仕組み（`sync/apply.ts` の `tableColumns`）は残す（D8 の前提）。**
- **同梱の CLI は、better-sqlite3 とネイティブモジュールを持ったままにする。** CLI の一部が DB を開くためである。

## 互換の版番号（D10）

hangar の部品のうち、別々に上がりうるのは、端末どうし（同期で Worker を挟む）、端末と Worker、殻と 4177 で動いている既存のサーバである。
UI とサーバと CLI は同じ束で配るので、版番号は要らない。

- shared に整数の `COMPAT_VERSION`（はじめは 1）を置く。
- サーバが Worker へ送るすべての要求に、見出し `X-Hangar-Compat` で版を載せる。Worker の応答にも同じ見出しで Worker の版を載せる。サーバと Worker の `/health` も版を返す。
- Worker は、端末に求める下限 `MIN_DEVICE_COMPAT` を持つ。見出しの無い要求は版 0 とみなす。下限を 0 から 1 に上げるまでは、見出しの無い要求も通す。下限より古い端末には 426 を返し、応答の本文に下限を載せる。
- サーバは、Worker に求める下限 `MIN_WORKER_COMPAT` を持つ。Worker の版がそれより古いか、Worker から 426 が返ったら、同期を止めて理由を出す（同期の状態の `error` に、どちらを上げればよいかを書く）。
- 殻は、4177 で動いている既存のサーバを採る前に、その `/health` の版を自分が同梱するサーバの版と比べる。違えば採らずに理由を出す（PR 7）。

下限を上げるのは、すべての端末が版番号を持つ版に上がってからである。
いまの同期の参加者は 1 台なので、PR 3 を入れた翌日に下限を上げてよい。

## 上限による失敗で退く（D4）

- Worker は、D1 の失敗のうち、メッセージに `free tier daily row read limit` か `free tier daily row write limit` を含むものを 429 で返す。本文には、上限の種類と、戻る時刻（次の UTC の 0 時）を載せる。いまは D1 の失敗をすべて 500 で返している。
- Workers の 1 日の要求の上限（error 1027）は、Worker を通らずに Cloudflare が返すので、状態コードも本文の形も文書に書かれていない。サーバは、Worker の応答が JSON でなく、本文に `1027` を含むものも、上限として扱う。
- サーバは、上限の失敗を受けたら、次の UTC の 0 時まで同期を止める。止めた理由と戻る時刻を同期の状態に持つ。日が変われば自分で戻る。
- 画面は、いまの「無料枠で停止 · X に戻る」の表示をそのまま使う。上限に当たるのは Free のときだけなので、文言は変えない。
- Paid の月の予算で止める仕組み（D4 の後半）は、クラウドの準備を作り直す段 5 で入れる。

## 後始末

消したものが残したデータを、マイグレーションと Worker の起動時の処理で 1 回だけ消す。

- 端末：`file_sync` の `kind='config'` の行、`sync_state` の `configPullConfirmed`、`configPending`、`quota:*`、`pausedReason`、設定の同期の読み飛ばしの記録。設定ファイルの `syncClaudeConfig` の鍵は、読むときに落とす。
- Worker：`files` の `kind='config'` の行（R2 の `config/` は、掃除の処理が拾って消す）、`meta` の `d1_rows:*`。

端末のマイグレーションは、段 0 で入れる DB の自動控えの後に入れる。

## PR の割り方

各 PR は、それ単独でアプリが動く状態で入れる。

| PR | 中身 | 入れる条件 |
| --- | --- | --- |
| 1 | 手元だけの引き算：使われていない口、Provider のインターフェース、引き継ぎ一式、手元だけで閉じる古い版の分岐 | なし |
| 2 | 同梱：CLI の import を分けてサーバを抱えないようにし、`cloud/` を Worker 1 本のビルドに替え、殻の `HANGAR_CLOUD_DIR` と `_up_/server-dist` を消す | なし |
| 3 | 互換の版番号：shared の版、要求と応答の見出し、`/health` の版、Worker の下限（はじめは 0）、サーバの Worker への下限 | なし |
| 4 | 設定の同期を端末の側から消す。読み飛ばしの分岐と、端末の後始末を入れる | 段 0 の DB の自動控えが入っている。写しの DB で 1 日使ってから入れる |
| 5 | 端末の見張りを消し、上限による失敗で退く処理を入れる。使用量の見積もりを「数は不明」に替える | 段 0 の DB の自動控えが入っている。写しの DB で 1 日使ってから入れる |
| 6 | Worker の側：端末の下限を 1 に上げ、台帳と `meteredBatch` を素の書き込みに戻し、`kind=config` と旧端末のための経路と DELETE を消し、上限の失敗を 429 で返し、Worker の後始末を入れる。端末の側の古い Worker のための分岐（`/usage` の 404）も消す | 同期に参加しているすべての端末が PR 3 以降の版になっている。Worker の配備は、利用者に聞いてから行う |
| 7 | 殻とサーバ：殻が既存のサーバを採る前に版を比べ、古いサーバのための分岐（`ready` の無いサーバ）と、古い殻のための分岐を消す | PR 3 |

PR 1、2、3 は互いに独立しているので、並行して進めてよい。
PR 4 と 5 は同期に触るので、別の `HANGAR_HOME` に DB の写しを置いて 1 日使ってから入れる。

## 範囲外

- Paid の月の予算で止める仕組み（段 5）。
- error 1027 を実際に起こして形を確かめること。
- 永続する識別子の改名（D8）。

## 終わりの条件

- 「消すもの」の項目が消え、`npm run typecheck`、`npm test`、3 つのビルドが通る。
- 互換の版番号の試験で、下限より古い端末が 426 で断られ、サーバが理由を出して同期を止めることを確かめている。
- 上限の失敗（D1 のメッセージ、429、`1027` を含む JSON でない応答）を受けたサーバが、次の UTC の 0 時まで退き、日が変わると戻ることを試験で確かめている。
- 入れ替えたアプリで、同期が 1 日動いている。
