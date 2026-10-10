# 段 2 サーバの骨格

作り替えの全体計画（`2026-10-07-refactor-roadmap-design.md`）の段 2 である。
機能を足すときに触る場所を「表、DTO、経路 1 本」まで減らし、段 3（UI の骨格）と段 6（Windows）の土台を作る。
画面に見える振る舞いは変えない。

調査（2026-10-09、main `3f1ad7e`）で、いまの骨格の問題を次のように数えた。行と箇所の数は各 PR の計画で数え直す。

- DB に書いたあと、読み直して画面へ配る処理を、呼び手が手で書いている。`hub.broadcast` は `server.ts` に 33 か所、`http/app.ts` に 17 か所、`mcp/tools.ts` に 8 か所ある。同期で降りた行も、`server.ts` の閉包が表名で分岐して配り直している。
- `http/app.ts` に経路が 81 本あり、依存の束 `AppDeps` は 28 項目（うち任意 7）である。その試験は 1 ファイル 1,640 行で、偽の部品を手で組んで `createApp` を 15 回呼んでいる。
- `startServer` は約 770 行で、30 余りの部品の組み立てと、閉包 25 本の業務が混ざっている。`server.test.ts` はこれを 41 回起動する。
- RunManager が、run の寿命に加えて、アカウントの解決と tmux の操作 9 種を直に持っている。段 6 で tmux を替えるときの差し替えの口が無い。

## 骨格の方針（案 B、2026-10-09 に利用者が選んだ）

変化の流れを軸に骨格を組む。
退けた案は 2 つある。ファイルを割るだけの案（A）は、配りの手書きと差し替えの口の問題を残す。全部の機能を同じ形のモジュールにそろえる案（C）は、段 4 で画面に合わせてサーバの形をもう一度触るので、いまそろえるには早い。

### 書き込みの通知と配る層

`db/shared.ts` にはすでに書き込みの購読（`onSharedWrite`）があり、同期の push のデバウンスだけが使っている。
これを一般化して `db/notify.ts` に置き、共有の表の書き手、手元だけの表の書き手、同期の apply（`sync/apply.ts`）のすべてが同じ口で「どの表のどの行が変わったか」を知らせる。

`events/publisher.ts` は、その知らせを受けて表名から DTO を組み、`hub.broadcast` で配る。
同じ tick の中で同じ行が何度変わっても、配るのは 1 回にする。
ロックの判定に要る `deviceId` は、この層で 1 回だけ渡す。
呼び手が渡し忘れるとロックが消える罠は、渡す場所が 1 つになることで無くなる。

同期で降りた行も同じ道を通す（2026-10-09 の決定）。
他の PC の変更と手元の変更で、画面が更新される経路は 1 本になり、`server.ts` の表名の分岐は消える。

表の変化に対応しない知らせ（トースト、run の起動と終了などの明示のイベント）は、いまのまま呼び手が送る。

### 経路の分割

`http/app.ts` の経路を、資源ごとのファイル（`http/routes/*.ts`）に分ける。
各ファイルは、自分が使う依存だけを並べた狭い型を受け取り、`createApp` は登録だけを行う。
試験は `http/testing.ts` の `testDeps()` で依存を組み、経路のファイルと一緒に `routes/*.test.ts` へ移す。
`AppDeps` の任意 7 項目は、`testDeps()` を先に作ってから必須にする。

MCP の道具（`mcp/tools.ts`）からも手書きの配りを消し、依存から `hub` を外す。

### RunManager から外すもの

アカウントの解決（`accountFor`、`ensureAccountLinks`、`switchAccount`）を `runs/accounts.ts` へ移す。
tmux の操作（newSession、sendKeys、capturePane、setOption、killSession など）は、口 `PaneOps` を `tmux/pane.ts` に定めて、その裏に移す。
段 6 では、この口の実装を psmux か自前の常駐ホストに替える。
run の寿命（起動、見張り、終了、復帰、停止）は割らない。

### 起動の組み立て

`server.ts` を、`boot/{home,sync,runs,summary,http}.ts` の組み立て関数の列にする。
`startServer` は、それらを順に呼んで部品を渡すだけにする。
`server.test.ts` の 41 本は、全体を起動する端到端の 5 本前後と、各 boot 関数の単体の試験に分ける。

### shared と依存の向き

shared を契約（DTO、API、イベント）だけにする。
サーバが使わない `steps`、`route`、`searchTokens` と、UI だけが使う `intent` は UI へ移す。
あわせて、`db/queries.ts` から `runs/procs.ts` への依存と、`pty/relay.ts` と `mcp/app.ts` から `http/auth.ts` への依存を、下の層から上の層を呼ばない向きに直す。

### マイグレーションを畳む

マイグレーションを、畳む時点の最新の版と同じスキーマを作る 1 本の起点にする。
段 1 の PR 5 で v16 が入るので、畳む対象は v1 から v16 になる見込みである。
新しく作った DB と、v1 から順に当てた DB の `sqlite_master` を、試験で突き合わせる（段 1 の PR 4 の `oldDb` 補助を使う）。
起点より古い版の DB は、開かずに断る。
使っているのは利用者 1 人で、その DB はすでに最新の版にあるので、古い版から上げる道は要らない。

### セッションの名前とメモの置き場（2026-10-09 の決定）

名前とメモを `sessions` から外し、別の表 `session_notes`（主キーはセッションの id）へ移す。
`sessions` の行は、索引だけが書く。

いまの形では、索引が本文の伸びるたびに `sessions` の行全体を書き直し、同期がその行全体を運ぶ。
このため、他の PC で付けた名前やメモを手元の古い行が上書きしうる。
`sync/apply.ts` は、上書きの前にメモを `backups/memos/` へ逃がす回避策でこれを防いでいる。
状態はすでに同じ理由で別の表（`session_states`）に分けてあり、残っていたのが名前とメモである。

- マイグレーションで、いまの名前とメモを `session_notes` へ写し、`sessions` の列を落とす。
- `session_notes` を同期の共有の表に加え、`sessions` の payload から名前とメモを外す。
- DTO と API の鍵は変えない。サーバが 2 つの表を合わせて今と同じ形の DTO を組むので、UI は変わらない。
- `sync/apply.ts` のメモの退避の回避策を消す。
- 同期で運ぶ形が変わるので、互換の版（`COMPAT_VERSION`）を 2 に上げる。Worker の求める端末の版も 2 に上げ、Worker を配備してからアプリを入れ替える。

### Claude Code に固有の物の置き場

Claude Code に固有の物は、いま `provider/`、`launch/`、`config/` の一部（claudeJson、accountAuth、retention、statusline）、`usage/`、`transcript/`、`summary/` の 7 つの dir に散っている。
段 2 の最後に、これを `provider/claude-code/` の下へ移すだけの PR を 1 本入れる（2026-10-09 の決定）。
振る舞いは変えない。
段 5（配布）と段 6 で、Node の探索や sh の包みを消すときの境目をはっきりさせるためである。

## PR の割り方

各 PR は単独で動き、main に入れたあとアプリを入れ替えられる。

| # | 中身 | 前提 |
| --- | --- | --- |
| 1 | `db/notify.ts` と `events/publisher.ts`。`server.ts` の手書きの配り（索引、同期の apply、メモの突き合わせ、ルートの確認）を外す | なし |
| 2 | `http/app.ts` と `mcp/tools.ts` から手書きの配りを消し、MCP の依存から `hub` を外す | 1 |
| 3 | `http/testing.ts` の `testDeps()`。`AppDeps` の任意の項目を必須にする | なし |
| 4 | 経路の分割（sessions、runs） | 2、3 |
| 5 | 経路の分割（projects、todos、memo、artifacts） | 2、3 |
| 6 | 経路の分割（sync、settings、prompt、system） | 2、3 |
| 7 | `runs/accounts.ts` と `tmux/pane.ts`（`PaneOps`） | なし |
| 8 | `server.ts` を `boot/` の関数へ。`server.test.ts` を端到端と単体に分ける | 4〜6 |
| 9 | shared を契約だけにし、依存の向きを直す | なし |
| 10 | マイグレーションを 1 本の起点に畳む | 段 1 の PR 4、PR 5 |
| 11 | 名前とメモを `session_notes` へ。互換の版を 2 に上げる | 1、段 1 の PR 5、PR 6 |
| 12 | Claude Code に固有の物を `provider/claude-code/` へ移す | 8 |

1、3、7、9、10 は互いに独立で、並行して進められる。
11 は同期で運ぶ形を変えるので、実物のクラウドでの確かめと Worker の配備を、やる前に利用者に聞く。
手元の DB の写しで 1 日動かしてから入れる。

## 範囲外

- 画面の構成と言葉（段 4）。
- UI の Mediator と Store の作り直し（段 3）。段 2 は、UI が受けるイベントを表の変化と一対一にするところまでで止める。
- 機能ごとのモジュールの形（案 C）。
- Claude Code の設定の同期の作り直し（段 4）。

## 終わりの条件

- 表の変化を画面へ配る処理が `events/publisher.ts` だけにある。
- `server.ts` と `http/app.ts` が、部品の組み立てと経路の登録だけになっている。
- tmux の操作が `PaneOps` の裏にだけある。
- 名前とメモが `session_notes` にあり、`sync/apply.ts` にメモの退避が無い。
