# agent-hangar 設計文書

## この文書の位置づけ

この文書は、2026-09-17 の設計インタビューで確定した内容を、実装の基準として書き直したものである。
インタビューで決めたことは「決定」、決めずに筆者が埋めたことは「前提」として末尾にまとめる。
実装中に決定を変えるときは、この文書を先に直す。

## 目的と範囲

**agent-hangar** は、個人用のローカルなエージェントセッション管理アプリである。
Claude Code のセッションをプロジェクト単位で束ね、起動、観察、検索、記録を一箇所で行う。
対応するエージェントは Claude Code だけである。
2 つ目のエージェントを足すときに、そのときの実際の必要から共通の形を引き出す。

このアプリが解決するのは次の不便である。

- セッションがどのプロジェクトの何の作業だったか、後から辿れない。
- 実行中のセッションがどこで何をしているか、一覧できない。
- 過去のセッションを条件付きで探す手段が、手元のスクリプトしかない。
- プロジェクトの進捗、TODO、メモ、生成物が、セッションと別の場所に散る。
- 別の PC に移ると、同じ作業を続けられない。

範囲外とするものも明記する。
Claude Code そのものの代替や、チャット UI の再実装はしない。
セッションの本文は Claude Code が書く jsonl を正とし、hangar はそれを読むだけである。
チームでの共有は範囲外で、利用者は本人と、同じ手順で自分の環境を作る家族に限る。

## 原則

設計を貫く原則を先に置く。

- **読み取り専用**：Claude Code の設定とデータを、hangar は原則として読むだけで書き換えない。`~/.claude` の中へ書く例外は次の 4 つだけである。
  - statusline スクリプトへの追記。承諾を求め、追記の前に同じディレクトリへバックアップを取る。
  - 利用者が明示的に押した「この PC で再開」で、他端末のセッション本文を `~/.claude/projects/` に写すこと。手元の本文を上書きするときは `~/.agent-hangar/backups/transcripts/` へ控えを取り、控えが取れなければ写さない。
  - クラウド同期で、他端末から引いた Claude Code のユーザー設定を書き戻すこと。Settings で明示的に有効にし、取り込む内容を確認したときだけ書く。上書きの前に `~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ 1 バイトも書かない。作り直した実装では、書くのは殻のネイティブの確認を経た殻の命令と CLI の `hangar config apply` だけで、サーバは書かない（「設定の同期の作り直し」の節の「適用と世代へ戻す」）。
  - 利用者が確認のダイアログで押した「書き込む」で、`~/.claude/settings.json` の `cleanupPeriodDays` の 1 か所だけを書き換えること。書く前に差分を見せ、`~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ書かない。ほかのキーと書式には触れない（「会話の保持期間」の節）。
- 初期プロンプトの欄の候補のために、`~/.claude` から次を読む。どれも読むだけで、書かない（「初期プロンプトの欄」の節）。
  - `skills/*/SKILL.md` と `commands/**/*.md`。選んだプロジェクトの `.claude/skills` と `.claude/commands` も同じに読む。
  - `plugins/installed_plugins.json` と、`settings.json` の `enabledPlugins`。有効なプラグインのスキルとコマンドを見つけるためである。
  - プラグインのスキルとコマンドは、`installed_plugins.json` に記録された `installPath` から読む。ふつうは `~/.claude/plugins/cache` の下だが、記録された場所がどこでも、そこを読む。読むだけで、書かない。
  - `history.jsonl`。セッションの最初の一言になったコマンドの回数を数える。
- `~/.claude` の外では、`hangar shell install` が `~/.zshrc` の末尾に 1 行を足す。statusline と同じく CLI だけが承諾を求めて行い、足す前に同じディレクトリへ控えを取る。UI とサーバは `GET /api/shell-hook` で有無を読むだけである（「外のターミナルのセッション」の節）。
  - 加えて、`~/.claude/` の外にある `~/.claude.json` の `mcpServers.hangar` を `hangar mcp install` が書き換える。Claude Code の設定である点は同じなので例外に数える。`claude mcp add` に任せないのは、`--header` の値が argv に載り、64 桁のトークンが同じ機械の誰からでも `ps` で読めるためである。削除は今までどおり `claude mcp remove` に任せる（こちらはトークンを渡さない）。
- **ファイルを消さない**：hangar は利用者のファイルを削除しない。プロジェクトの削除は紐づけの解除であり、ディレクトリには触れない。例外はスクラッチを昇格するときの移動だけである。
- **サーバが正**：状態はローカルサーバが持ち、UI は描画に必要な値だけを受け取る。ブラウザでも Tauri でも同じ UI が動く。
- **正規化した形式で描く**：トランスクリプトは正規化した共通形式に変換して描く。表示コードは Claude Code の jsonl 形式を知らない。
- **同期前提のスキーマ**：データはすべて端末間で同期できる形で持つ。フェーズ 1 から 3 では同期せずにこの形だけを保ち、フェーズ 4 で実際に同期した。
- **軽い索引**：巨大な jsonl を DB に丸ごと写さない。索引と検索用テキストだけを持ち、本文はファイルから読む。

## 全体構成

### パッケージ

TypeScript で統一し、Node 22 と npm workspaces のモノレポにする。
pnpm は手元で壊れているため使わない。

- `packages/shared`：正規化トランスクリプトの型、API と MCP の契約、UiAction の型、要約の型。サーバ、UI、Worker のすべてが依存する。
- `packages/server`：ローカルサーバ。Hono による HTTP と WebSocket、MCP サーバ、SQLite（better-sqlite3）、インデクサ、tmux 制御、node-pty、要約器、同期エンジン。
- `packages/ui`：React と Vite による UI。Root から始まる階層、Passive View、UiAction チェーン、Mediator。
- `packages/cloud`：Cloudflare Worker。Hono でサーバとコードを共有し、D1 と R2 を扱う。フェーズ 4 で実装した。
- `apps/desktop`：Tauri v2 のシェル。サーバを子プロセスとして起動し、ウィンドウに UI を表示する。フェーズ 5 で実装した。
- `packages/cli`：`hangar` コマンド。`setup`、`setup cloud`、`join`、`start`、`status`、`open`、`url`、`mcp install`、`statusline install`、`shell install`、`shell uninstall`、`shell status`、`cloud status`、`cloud teardown` を提供する。

### プロセスと通信

サーバは 127.0.0.1 の固定ポート 4177 で待つ。
UI は同じサーバから配信され、HTTP で読み書きし、WebSocket でイベントを受ける。
ターミナルは WebSocket 上の別チャネルで、node-pty の入出力をそのまま流す。
MCP は Streamable HTTP で、共通の `/mcp` とセッション別の `/mcp/s/<sessionId>` を持つ。
Tauri のシェルは、起動時にサーバの子プロセスを立て、終了時に止める。
止め方は OS で分ける（`src-tauri/src/server.rs` の `stop_within`）。
macOS は SIGTERM を送り、猶予（`STOP_GRACE`、10 秒）を過ぎても残ればサーバに SIGKILL を送る。
Windows には SIGTERM が無いので、殻はサーバの標準入力を管でつなぎ、`HANGAR_STOP_ON_STDIN_END=1` を渡しておき、止めるときに管を閉じる。
サーバはその読み口の終わりを SIGTERM と同じ合図として受け取り、DB を閉じてから降りる（`entry.ts` の `runMain`）。
Windows のサーバはジョブオブジェクトに入れる（`src-tauri/src/winjob.rs`）。
猶予を過ぎても残っていればジョブごと止め、猶予のうちに降りた後も、ジョブに残った孫（node-pty の端末など）をそこで止める。
ジョブは閉じたら中身を止める（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）ので、殻が落ちたときもサーバと孫は残らない。
その代わり、殻が落ちたときのサーバは後始末をせずに止まる（macOS は親の見張りで 5 秒後に自分で降りる）。
ジョブは自分から抜けることを許す（`JOB_OBJECT_LIMIT_BREAKAWAY_OK`）。
psmux はサーバを `CREATE_BREAKAWAY_FROM_JOB` で起こしてジョブの外へ出るので、psmux のサーバとその中の claude は Hangar を閉じても残る（macOS の tmux と同じ）。
hangar が起こす psmux には `PSMUX_NO_WARM=1` を渡す（`packages/server/src/tmux/tmux.ts` の `PSMUX_ENV`、Windows だけ）。
psmux は既定で、セッションのサーバを起こすと次の new-session のための控えのサーバ（`__warm__`）と予備の PowerShell を、そのセッションの cwd のまま起こす。
控えは最後のセッションを止めた後も残ってそのフォルダを掴み、フォルダを消せなくする（2026-10-11、Windows の実機の確かめで見つけた）。
hangar の new-session は `-c`、`-x`、`-y`、`-e` とコマンドを渡すので、psmux が控えを引き取る条件（どれも渡さないこと）に当たらず、控えは一度も使われない。予備のシェルも、コマンドを渡す窓には使われない。
だから止めても hangar のセッションの起動は遅くならない。遅くなるのは、利用者が hangar のセッションの中で新しい窓や分割を自分で作るときに PowerShell を一から起こす分だけである。
控えの cwd だけをホームにする道は採らない。psmux はセッションのサーバの cwd を `-c` の場所に替えてから控えを起こすので、hangar からは控えの cwd を選べないからである。
macOS と Linux の tmux には何も足さない。
黙って抜けるのを許す `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` は付けない。付けると孫がみなジョブの外に出て、ジョブで止められるのがサーバ 1 つだけになる。
殻が Windows で起こす子（サーバ、Node の候補、設定の同期の CLI）には `CREATE_NO_WINDOW` を付け、黒いコンソールの窓を開かない。
殻が子へ渡すパス（Node の主スクリプトの `server.mjs` と `cli.mjs`、`HANGAR_UI_DIST`、`HANGAR_HOME`、`HANGAR_LAUNCHER`）と、トーストの登録に書く殻の場所は、Windows の verbatim の接頭辞（`\\?\`）を外してから渡す（`src-tauri/src/paths.rs` の `plain`）。
Tauri の `resource_dir()` は Windows で `\\?\C:\…` の形を返し、Node 22.20 以降はその形の主スクリプトを読めずに `lstat 'C:'` の EISDIR で落ちるためである（0.2.0-rc.1 はこれで起動しなかった）。
`\\?\C:\…` は `C:\…` に、`\\?\UNC\server\share\…` は `\\server\share\…` に直す。
外すと別のものを指すもの（全体が 260 字を超える、予約名、末尾の点や空白、`.` や `..` の段）は外さない（規則は dunce の `simplified` と同じで、UNC の形を足してある）。
Node の候補もジョブに入れ、打ち切ったときに孫ごと止める（unix の `setsid` と `killpg` に当たる）。
サーバが起こす外のアプリ（Windows Terminal、既定のターミナル、VS Code、ブラウザ）は、そのまま起こすとジョブに入り、Hangar を閉じると窓ごと止まる。
Node は子に `CREATE_BREAKAWAY_FROM_JOB` を付けられないので、殻の実行ファイルを起こし役にする（`src-tauri/src/breakaway.rs`、`packages/server/src/external/breakaway.ts`）。
殻はサーバに自分の場所を `HANGAR_LAUNCHER` で渡し、サーバは外のアプリを `Hangar.exe --hangar-breakaway <起こすもの> <引数の 1 行>` で起こさせる。
殻はこの印を見たら Tauri を立ち上げず、`CREATE_BREAKAWAY_FROM_JOB` を付けて子を起こし、子の終わりを待ってその終了コードで降りる。標準入出力は受け継ぐので、サーバは直に起こしたときと同じ結果を受け取る。
引数の 1 行はサーバが Windows の規則で引用し終えたもので、殻はそのまま子のコマンド行の後ろに付ける（cmd.exe へ組んだ 1 行を崩さないため）。
外側のジョブが抜けるのを許していなければ、印を付けずに起こし直す（psmux と同じ）。
端末から起こしたサーバ（`npm run dev` など）はジョブに入っていないので、`HANGAR_LAUNCHER` は無く、直に起こす。
Node は PATH に頼らず、Settings の `nodePath`、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、`~/.nvm/versions/node/*/bin/node`（新しい版を優先）の順で探す。
サーバ側でも親プロセスの生存を監視し、親が消えたら自ら終了する。
`hangar start` も、サーバを子プロセスとして立てる。
子を起こす Node は、シェルの探し方を通らず、CLI 自身を動かしている Node（`process.execPath`）である。
配布版は `cli.mjs` の隣の `server.mjs` を、リポジトリでは `packages/server/src/main.ts` を tsx で起こし、`HANGAR_PORT` と `HANGAR_PARENT_PID` を渡す。
サーバは起動の最初に、受け渡しの値（`HANGAR_PORT`、`HANGAR_PARENT_PID`、`HANGAR_UI_DIST`、`HANGAR_STOP_ON_STDIN_END`、`HANGAR_LAUNCHER`）を読んでから、それらと、Claude Code が子に立てる印と、サーバが読まない hangar の変数（`HANGAR_RUN_ID`、`HANGAR_UNSET_ENV`、`HANGAR_CLOUD_DIR`）を自分の環境から消す（`launch/env.ts`）。
殻も、サーバを起こすときに同じ名前を外してから自分の値を入れる（`server.rs` の `INHERITED_ENV_DROPPED`。サーバの正本との一致は試験で縛る）。
アプリを Claude Code のセッションの Bash から `open` で起こすと、呼び手の環境がそのまま殻とサーバに入り、サーバが起こす tmux サーバの全体の環境と、サーバが直に起こす claude（`--help`、`agents --json`、要約の `-p`、`auth status`）にまで届くためである。
`/health` の `ready` が真になってから、鍵付きの URL を印字する。
`hangar://` のディープリンクは deep-link プラグインで受ける。
ブラウザからも同じ UI が動くが、入口は鍵付きの URL に限る。
鍵の無い要求には 401 で `hangar url` を案内する画面を返す。
配布する `.app` には、esbuild で単一ファイルにまとめたサーバ（`server.mjs`）を、ネイティブモジュールと UI とともに同梱する。
CLI（`cli.mjs`）は、サーバの入口 `index.ts` ではなく、サーバ本体をたどらない `packages/server/src/cliEntry.ts` から名前を取る。
入口から取ると、esbuild がサーバ全体を `cli.mjs` にも束ね、同梱物にサーバが二重に入るためである。
ネイティブモジュールは Node の ABI に縛られるため、同梱時の Node のメジャー版とアーキテクチャを `manifest.json` に記録し、探索ではそれと一致する Node だけを採る。
起動時に 4177 で既にサーバが応答していれば、互換の版が殻と同じときだけ、そのサーバを採用して子プロセスを起こさない。
版が違えば採らず、そのサーバも止めずに、読み込み画面に失敗の札で理由を出す（「互換の版番号」、「起動の失敗の札」）。

### 起動の組み立て

サーバの起動（`packages/server/src/server.ts` の `startServer`）は、`boot/` の組み立て関数を順に呼ぶだけである。
各関数は、前の関数が作った部品を引数で受け取り、自分が作った部品と、動かし始める口と、止める口を返す。
業務の処理は `boot/` に置かない。
それぞれの持ち場（`projects/`、`sessions/`、`runs/`、`sync/`、`config/` など）に、依存を引数で受ける関数として置き、`boot/` はそれを部品に結ぶだけにする。

| 関数（ファイル） | 作る部品 |
| --- | --- |
| `bootHome`（`boot/home.ts`） | 置き場、DB、トークン、statusline のヘッダ、端末の ID、設定、起動の包み。DB を開くときに、マイグレーションの前の控えを取る。設定はメモリの上で読み替えるだけで、書き戻さない |
| `bootDelivery`（`boot/delivery.ts`） | WebSocket の束、配る層（`events/publisher.ts`）、Claude Code との互換のずれの記録、実行中の一覧 |
| `bootSync`（`boot/sync.ts`） | 同期のエンジン、使用量、本文の上げ手、設定の同期、保持期間、本文の降ろし手、頼まれた 1 巡、同期の状態の配り |
| `bootIndexing`（`boot/indexing.ts`） | 索引、プロジェクトのメモ。現れたセッションのプロジェクトへの紐づけを結ぶ |
| `bootListen`（`boot/http.ts`） | 待ち受け。アプリを差し込むまでは 503 を返す |
| `bootRuns`（`boot/runs.ts`） | tmux の口、手元の claude の読み取り、包みの本体、アカウント、RunManager、休みの見張り、使用量、外のターミナルとエディタ |
| `bootSummary`（`boot/summary.ts`） | 要約器の列、要約の job。run の出来事の受け手を結ぶ |
| `bootHttp`（`boot/http.ts`） | 端末の中継、HTTP と MCP のアプリ。WebSocket の経路を結び、未知の経路を切る番人を置く |

呼ぶ順は、上の表の順である。
順には理由がある。

- 配る層は、索引、同期、run より先に組む。これらは行を書くだけで、配るのは配る層だからである。
- 待ち受けは、run と包みと MCP より先に始める。ポートに 0 を渡したとき、実際の番号は listen するまで決まらず、これらがその番号を使うからである。待ち受けの後に組むのは `bootRuns` から先である。
- `/health` は待ち受けた時点から返るが、`ready` は起動の手続きが済むまで偽である。
- 起動を断る確かめは、利用者のファイルを書き換えるより先に済ませる。
  DB を置き場の物より先に開くので、起点より古い DB（`DbTooOldError`）と控えの取れない DB（`DbBackupError`）は、トークン、statusline のヘッダ、端末の ID、起動の包みを 1 つも書かずに断る（置き場を作ることと、緩い権限を締めることだけは先に行う）。
  設定（`settings.json`）の読み替え（探した道具のパス、別の OS の外部ターミナル、古い鍵の削除、知らない言語の削除）はメモリの上で済ませ、待ち受けが通ってから `persistSettings` で書き戻す。
  前の版のアプリへ戻す利用者が、読み替え済みの設定を掴まされないためである（2026-10-11、Windows の実機の確かめで見つけた）。
  ただし、未適用のマイグレーションは待ち受けより前に当てる。ポートが塞がっていて断る回でも DB は上がる（控えは取ってある）。

組み立てが済んだら、起動の手続きを次の順で動かす。

1. 実行中の一覧を読み始める。最初の読み取りは変化として届かないので、受け手（`sessions/liveChange.ts`）に覚えさせる。
2. 索引とプロジェクト。全走査、ワークスペースからのプロジェクトの登録、紐づけ、スクラッチの用意、メモの突き合わせと監視、ルートの確かめ。
3. run。前回の終了時に生きていた run の回復、run の終了の見張り、休みの見張り。
4. ここで準備完了の印（`ready`）を立てる。以後に現れた未分類のセッションだけを知らせる。
5. 自端末の生存を `devices` に刻む。
6. 同期。最初の同期は待たない。使用量、ファイルの取り込み、設定の監視、保持期間、定期の押し出しと走査、控えの刈り込み。

止める順は、起動の逆をなぞるだけではない。
外と話している仕事を待ち、書き手を止めてから、配る層と DB を畳む。

1. 周期の仕事を止める（ルートの確かめ、休みの見張り、生存の刻み、同期の定期の仕事）。
2. 走っている通信を待ってから止める。頼まれた 1 巡、設定の押し出し、本文の上げ、メタデータの同期、本文の降ろしの順である。待ちの上限は 1 本の締め切り（`boot/budget.ts` の `CLOSE_DEADLINE_MS`）で持つ。
3. 見張りと書き手を止める（メモの監視、RunManager、索引、実行中の一覧、端末の中継）。
4. 配る層は、溜まっている知らせを出し切ってから止める。続けて WebSocket を畳み、残った keep-alive の接続を切ってから listen を閉じる。
5. 走っている要約を待つ。要約は DB に書くので、DB を閉じる前に待つ。
6. 互換のずれの記録を書き出し、最後に DB を閉じる。

信号の受け口（`installShutdown`）は `server.ts` に残してある。
`startServer` の解決を待たずに立てる必要があり、入口（`main.ts`）が直に呼ぶからである。

#### 起動の失敗を殻へ渡す（`boot-error.json`）

サーバは、起動が転んだとき、`<HANGAR_HOME>/boot-error.json` に `{ kind, params, detail }` を書いてから終了コード 1 で終わる（`boot/bootError.ts`、呼ぶのは入口の `runMain`）。
失敗したサーバは立ち上がっていないので、HTTP ではなくファイルで渡す。
殻はこれを読んで失敗の札の種類を決める（殻の側は「起動の失敗の札」の節）。

- `kind` は 4 種類である。`server-exited`（下の 3 つに当たらない、起動の途中での失敗）、`port-in-use`（listen の `EADDRINUSE`）、`db-too-old`（`DbTooOldError`）、`db-backup-failed`（`DbBackupError`）。互換の版の合わない別のサーバが 4177 で動いている失敗は、サーバが起きる前に殻が決めるので、ここには入れない。
- `params` は文字列か数だけを持つ。`port-in-use` は `port` と `host`（読めた分だけ）、`db-too-old` は `file`、`found`、`baseline`、`db-backup-failed` は `file`（取ろうとした控え）と `dir`（控えの置き場）、`server-exited` は空である。
- `detail` は例外の文そのものである。見出しや次にすることの文は書かない。その文は殻の読み込みの頁の日英の表が、`kind` と `params` から出す（文は辞書から出す、という D5 の決め）。
- 書き込みは一時のファイルへ書いてから改名する。殻が書きかけを読まないためである。置き場がまだ無いうちの失敗でも書けるよう、置き場は作る。書けなくても、元の失敗の報告（`console.error`）と終了コード 1 は変えない。書き込みの失敗が、起動の失敗を隠してはならないからである。
- 古いファイルは、**サーバを起こす前に消す**（`runMain` の先頭）。起動が成功したときに消す形にはしない。成功を待つと、前の失敗のファイルが残ったまま次の起動が理由を書けずに死んだとき（Node が見つからない、置き場に書けない、が書く前の失敗になる）、殻が古い理由を今回のものと取り違えるからである。起こす前に消せば、ファイルがあるなら今回の失敗か、サーバが起きる前に死んだ回の古い失敗のどちらかになり、後者は殻が自分の子の起動より古い更新時刻のファイルを捨てて見分ける（「起動の失敗の札」の節）。消せないときも起動は止めない。
- 殻が読むのは、自分の子が死んだときだけにする。動いているサーバがあるあいだに別のサーバ（`hangar start` など）がポートの失敗を書いても、動いているサーバの起動を失敗にしないためである。

#### 起動の失敗の札

殻は起動の失敗を 6 種類の札のどれかに分け、読み込みの頁が 1 枚の札で出す（試作は `docs/superpowers/specs/2026-10-09-small-screens/options.html` の起動の失敗の B 案）。
殻の側は `src-tauri/src/bootfail.rs`、頁の側は `loading/boot-fail.js`（文の表）と `loading/boot.js`（描画）である。

- 種類は 6 つである。サーバが書く 4 つ（上の `kind`）に、殻が自分で決める 2 つを足す。`compat-mismatch`（互換の版の合わない別のサーバ。ポートと 2 つの版を `params` に持つ）と、`other`（殻のそれ以外の失敗：App Translocation、Node が見つからない、頁を移せない、応答が途切れた、など。理由は `detail` に殻の文で載せる）である。種類の並びは Rust の `KINDS` と頁の `FAIL_KINDS` で同じにし、`config.test.ts` が突き合わせる。
- 殻が `boot-error.json` を読むのは、**自分の子が死んだとき**だけである（`wait_for_server` と `wait_for_ready` の死の枝）。読むときは、子を起こす直前の時刻（`AppState.child_started`）より更新の時刻が古いファイルを捨てる。読めない、古い、無い、のときは `server-exited` にし、詳細に `desktop.log` の終わりの 20 行を載せる（Node のネイティブモジュールが読めない、などは標準エラーにしか出ない）。ファイルが `compat-mismatch` や `other` を名乗っても採らず、知らない種類と同じく `server-exited` に落とす。
- 殻は札の文を書かない。頁へは、決まった式 `window.__hangarBootFail(<JSON>)` で `{ kind, params, detail, lang, version, os, home, sep }` だけを渡す。`home` は置き場の名前（利用者のホームを `~` に縮めたもの。`HANGAR_HOME` に従う）で、札の文と命令に入れる。
  `sep` は OS のパスの区切り（Windows は `\`）で、頁は置き場とファイルの名前（`desktop.log`、`hangar.db`、`backups` と `db`）をこれでつなぐ。
  `~` に縮めるときも、ホームの後ろの区切りはそのまま残す（Windows なら `~\.agent-hangar`）。
  区切りを `/` に決め打ちしていたので、Windows では記録の場所が `\.agent-hangar/desktop.log` のように区切りを混ぜて出ていた（2026-10-11、Windows の実機の確かめで見つけた）。
  `sep` が無い（前の版の殻）か `\` でなければ、頁は `/` と読む。`params` の文字と `detail` は長さを切り、`detail` に入場の鍵が混じっていたら伏せてから渡す。
  渡す前に、`detail` と文字の `params` の中で利用者のホームから始まるパスを、すべて `~` に縮める（`bootfail.rs` の `shorten_home`、呼ぶのは `lib.rs` の `for_page`）。
  サーバが書く `params` の `file` と `dir`、Node の「調べた場所」と設定ファイルの場所、例外の文に、ユーザー名を出さないためである。
  サーバはホームを縮めずに書くので、縮めるのは殻の 1 か所に寄せ、macOS と Windows で同じにする。
  ホームの前後がパスの文字なら（`/Users/ab`、`/mnt/Users/a`）縮めない。頁は文字を `textContent` だけで書き、`innerHTML` に入れない。読み込みが終わる前に出た失敗は殻が貯め、読み込みの合図で渡す（以前の文言と同じ扱い）。
- 札の中は、見出し、何が起きたか、番号つきの次にすること（順序つきの一覧）、コピーできる命令、詳細（最初から開いた記録。「全文をコピー」つき）、下端のアプリの版と OS、「ログを開く」「もう一度試す」の順に並べる。ロゴは左上に小さく退ける（信号の 3 点の右、UI の `--lights-end` と同じ幅から）。命令と詳細だけを等幅にする。詳細が伸びても札が窓（最小 900×600）に収まるよう、詳細の枠だけが縮んで中で流れ、操作は見えたままである。焦点は札が出たとき「もう一度試す」に置く（Enter で押せる）。Tab の順は、命令のコピー、詳細、全文をコピー、ログを開く、もう一度試す。
- 「全文をコピー」は、版と OS、種類、詳細の順の文をクリップボードへ書く。そのまま報告に貼れる形である。クリップボードの口が無い頁では、選択と `copy` の命令で写す。
- ポートと互換の失敗では、動いているサーバ（利用者が起こしたものかもしれない）を止めないと文で言う。
- 命令は OS で出し分ける（`boot-fail.js` の `POSIX` と `POWERSHELL`）。OS の名前が `Windows` で始まれば PowerShell の形にする。
  ポートを握っているものは、macOS と Linux では `lsof -nP -iTCP:<port> -sTCP:LISTEN`、Windows では `Get-Process -Id (Get-NetTCPConnection -LocalPort <port> -State Listen).OwningProcess` で見る。
  DB の退避は `mv` と `Move-Item -LiteralPath … -Destination …`、控えの置き場は `ls -la` と `Get-ChildItem -Force -LiteralPath …` である。
  PowerShell のパスは、`~` で始まれば `$HOME` に替えて二重引用符で包み、残りの `$` と `` ` `` と `"` を `` ` `` で逃がす。それ以外で安全でない文字を含めば単引用符で包み、中の単引用符を 2 つにする（`psQuote`）。
  以前は Windows で lsof の命令を添えず、`mv` と `ls -la` はそのまま出していた（2026-10-11、Windows の実機の確かめで見つけた）。
- 版は殻（`app.package_info()`）、OS の名前と版は殻が失敗のときに読む（macOS は `sw_vers -productVersion`、Linux は `/etc/os-release`、Windows は登録簿の `CurrentBuildNumber` と `DisplayVersion`）。Windows の製品名は Windows 11 でも「Windows 10」のままなので使わず、ビルド番号 22000 からを Windows 11 と呼ぶ（「Windows 11 24H2 (build 26100)」）。
- 頁の言語は、`<HANGAR_HOME>/settings.json` の `language`（`ja` か `en`）を**殻が読めればそれ**、読めなければ OS の言語で決める（設計書 10 章の未決の点を、こう決めた）。OS の言語は、macOS では `defaults read -g AppleLanguages` の先頭（`.app` は `LANG` を持たない）、Windows では表示言語の並び（`GetUserPreferredUILanguages`）の先頭、ほかは `LC_ALL`、`LC_MESSAGES`、`LANG` で、日本語なら ja、それ以外は en にする。どちらも決まらなければ日本語（UI の既定）にする。設定ファイルがあっても `language` が無い（利用者がまだ選んでいない）ときも OS の言語に従う。UI は同じ場合に日本語の既定で出るので、英語の OS ではこの頁だけ先に英語になる。設定ファイルが読めれば OS には聞かない（失敗の最中に外のコマンドを呼ばないため）。
- 頁の文は UI の辞書を使えないので、日英の表を頁に持つ（`boot-fail.js`）。言語の並びは shared の `LANGUAGES` と同じにし、試験が突き合わせる。
- 殻が自分で書く `detail`（`other` の理由と、時間切れの案内）は、頁と同じ言語で書く。
  英語の設定でも「Node 22（x64）が見つかりません」「調べた場所」が日本語のまま出ていた（2026-10-11、Windows の実機の確かめで見つけた）ためである。
  文の日英の表は殻に持つ（`src-tauri/src/bootmsg.rs` の `Msg`、Node が見つからないときは調べた場所を並べるので `node.rs` の `describe_error_in`）。
  言語は札と同じく `page_language` で決め、決めるのは失敗したときだけにする（成功の道で OS に聞かない）。
  文の中の記録の場所は、置き場の名前と同じく `~` に縮め、OS の区切りで書く。
  文に埋める例外の文、OS や Node が返した文、サーバの例外の文（サーバが書く `detail`）は記録なので、言語を替えない（サーバの文の英語化は段 3 の PR 7 の範囲である）。

試験は 3 層に分ける。

- 業務の関数は、持ち場ごとの単体の試験で押さえる。偽の依存を渡し、サーバは起こさない。
- 組み立て関数は、`boot/*.test.ts` が 1 つずつ起こして押さえる。同期の組み立ては、待ち受けも索引の見張りも起こさずに、手元の立て替えの Worker に向けて動かす。
- 全体を起動する端到端の試験（`server.test.ts`）は、全体を起動しないと確かめられない振る舞いに絞る。起動して止まる、認証と WebSocket の経路、同期が 1 巡する、実行中の登録の出入り、起こし直しで続きから動く、の 5 つである。全体の起動は重いので、同じ起動で確かめられるものは 1 度の起動を分け合う。

## UI アーキテクチャ

### コンポーネント階層

すべてのコンポーネントは `Root` を頂点とする一つの木に属する。
木の形は画面構成と一致させ、親子関係がそのまま UiAction の伝播経路になる。

```
Root
├─ Shell
│  ├─ Sidebar               ナビ項目（Home / Projects）、「実行中」の節、下端の Settings
│  ├─ Header                ロゴ、「移動・操作」の錠剤、使用率のゲージ、同期状態、ベル（NoticeList）、新しいセッションのボタン
│  └─ Main
│     ├─ HomeScreen         HomeBand（錠剤 + 引き出し） / SessionList（タブ、欄、絞り込み、行）
│     ├─ ProjectsScreen     節 × n → ProjectRow（行の表）
│     ├─ ProjectScreen      見出し / SessionList / 右パネル（TodoList、EditableNote、ArtifactCards）
│     ├─ SessionScreen      見出しの段（SessionBadges、(i) の詳細） / TabStrip / NowStrip（現在の帯）または LeadCard（冒頭の 1 枚） / TerminalPane または Transcript / TocPane（TurnIndex）
│     └─ SettingsScreen     目次 / 選んだ節（一般、クラウド同期、連携、要約エンジン、ツール、更新、情報）
└─ Overlays
   ├─ CommandPalette
   ├─ NewSessionDialog / NewProjectDialog / PromoteDialog / ResolveProjectDialog / ConfigSyncDialog
   └─ ToastStack
```

### Passive View と Presenter

各コンポーネントは **Passive View** であり、描画に関わる値だけを props で受け取る。
View は状態を持たず、API を呼ばず、他の View を知らない。
利用者の操作は、View が **UiAction** を発行することでのみ外に伝わる。

View に値を渡すのは **Presenter** である。
Presenter はコンポーネントごとの純関数（または薄いフック）で、Mediator の状態とデータキャッシュから、その View の props を計算する。
Presenter は DOM に依存しないので、Mediator と合わせて単体テストできる。

データキャッシュは、サーバから WebSocket で届くイベントで更新される正規化ストアである。
Presenter はストアを読むだけで、書き込みはすべて Mediator の効果として行う。

### UiAction とチェーン

UiAction は `{ type, payload }` の判別可能な共用体で、`packages/shared` に定義する。
以前は Intent と呼んでいたが、ターンの「意図」（`set_turn_intent`）と紛れるので UiAction に改めた。ターンの意図の名前（`set_turn_intent`、`turn_intents`、`TurnIntent`）は変えていない。
View は近い祖先から受け取った `emit` で UiAction を発行する。
UiAction は木を上へ伝播し、各層は「処理して止める」か「上へ渡す」かを選ぶ。
これが **Chain of Responsibility** であり、DOM のイベントではなく明示的な関数の合成で実装する。

React では次の形にする。

```ts
// packages/ui/src/action/chain.ts
type Handled = { handled: true } | { handled: false };
type ActionHandler = (action: UiAction) => Handled;

const ActionContext = createContext<(action: UiAction) => void>(() => {});

export function useEmit() {
  return useContext(ActionContext);
}

// 中間層が一部の UiAction を横取りしたいときに使う。処理しなければ親へ渡す。
export function ActionBoundary(props: { handle: ActionHandler; children: ReactNode }) {
  const parent = useContext(ActionContext);
  const dispatch = useCallback((action: UiAction) => {
    if (!props.handle(action).handled) parent(action);
  }, [parent, props.handle]);
  return <ActionContext.Provider value={dispatch}>{props.children}</ActionContext.Provider>;
}
```

中間層で処理する UiAction は、その層だけで完結する見た目の操作に限る。
たとえば `SplitPane` はペーンの幅変更を処理し、`TabStrip` はタブのドラッグ並び替えを処理する。
それ以外はすべて `Root` に届く。
API を 1 回呼ぶだけのものは Runtime が表で引いて実行し（後述）、残りは Mediator が裁定する。

UiAction の一覧は型が正である。
`packages/shared/src/action.ts` の `UiAction` を見る。
名前は `対象.動詞` で揃える。

他端末で動いているセッションに対して View が出すのは `session.resumeHere` だけで、引き継ぎの握手の UiAction は持たない（後述）。

`transcript.follow` の `follow: false` は、利用者が自分でスクロールを上げたときだけ発行する。
末尾へ送るスムーズスクロールの途中では発行しない。

`follow` は `localStorage` に残さない。
`SessionViewState` の他の項目は残すが、`follow` だけは保存の形から落とし、読み戻すときにも落として既定の真に戻す。
遡るために一度上へスクロールすると `follow: false` が焼き付き、次からそのセッションが最古の側で開いてしまうためである。
古い保存に残っている `follow` も、読み戻しのときに捨てる。

`split.resize` は `SplitPane` の `ActionBoundary` が処理して止めるので、Root にも Mediator にも届かない。

### Mediator の状態機械

`Root` が保持する **Mediator** は、自作の型付き状態機械である。
`transition(state, store, input) => { state, effects }` の純関数と、効果を実行する小さなランナーから成る。
`store` は Store で、Mediator は読むだけで変えない。
入力は UiAction と、サーバから届くイベント（`ServerEvent`）の二種類である。
効果は API 呼び出し、ナビゲーション、ターミナル接続の開閉、フォーカス移動、トースト表示に限る。

状態は直交する領域に分けて持つ。
領域ごとに小さな状態機械を書き、`transition` はそれらを合成する。

各領域の取りうる値は型が正である。
`packages/ui/src/mediator/types.ts` の `State` と、領域ごとのファイルを見る。
遷移の表は持たない。
`packages/ui/src/mediator/transition.ts` とその試験が正である。
型から読み取れない決まりだけを、次に書く。

- 新しいセッションのダイアログの書きかけ（`newSessionDraft`）は 1 つだけ持ち、ダイアログから起動し終えたら消す。
  名前も初期プロンプトも空白だけで、添付も無ければ、書きかけは消す。
  ダイアログを閉じた後に送り終えた添付は、いまの書きかけへ足す。
  名前と本文は残し、同じパスは足さない。
  書きかけが無ければ、名前と本文が空のものを作る。
- 起動の詳細の前回値（`launchPrefs`）の鍵はプロジェクトの id で、スクラッチは `:scratch` の 1 枠である。
  送った詳細をそのプロジェクトの前回値にする。
  書きかけも前回値も、端末ごとに localStorage（`newSession.draft`、`newSession.prefs`）に残し、起動時に読み戻す。形の違う値は捨てる。
- 他端末の本文で手元を上書きしてよいかは、確認（`confirm`）を挟んで聞く。

同じ事実を State と Store の両方には持たない。
State に置くのは、操作の途中の状態（どのダイアログが開いているか、送信中か、利用者が並べた順）だけである。
外から届いた事実は Store だけに置き、Mediator も Presenter も Store から読む。
サーバのイベント、API の応答、殻（Finder）の答え、通知の許可のように Runtime しか知らない事実が、これに当たる。
写しを State に持つと、片方だけが新しくなる経路ができ、2 つをそろえるために応答をサーバのイベントに見せかけて流すことになるからである。
だから Runtime は、応答と bootstrap を Store に直に当て、サーバのイベントに作り直して `transition` へ流さない。
bootstrap で消えた run とタブをイベントにして流すのは別の話で、届いていれば起きたこと（接続を切る）を同じ道で起こすためである。
未解決のプロジェクトは、bootstrap からイベントに作り直さない。起動時に問いを出さないからである（2.11.5）。

Store に置いた事実のうち、型から読み取れない決まりを次に書く。

- 同期の状態と未送信の数は `sync` だけにある。ヘッダーの一行は、Presenter がこれを写して作る。まだ届いていない間（null）は何も出さない。届いた `off` は「同期オフ」と言う。
- 索引の段階は `index` だけにある。
  走査中に開いた UI の bootstrap にはプロジェクトも紐づけも載っていないので、走査が終わった瞬間に bootstrap を取り直す。
  終わった瞬間は、`index.progress` を当てる前の Store でしか分からないので、当てる側の Runtime が見る（`store.ts` の `indexFinishedBy`）。
  bootstrap が運んだ段階も数えるので、走査中に開いて最初に届いた知らせが idle でも取り直す。
- 事後要約の待ち（`summaryPending`）と失敗の理由（`summaryFailed`）は並べて持つ。失敗は、次に作り始めるか作れたら消える。bootstrap は失敗を運ばないので、取り直しても残す。
- `workspaceDirs` は、2 つのダイアログを開いたときに読む。まだ読んでいなければ null である。
- `pickedFolder` の `n` は、同じパスをもう一度選んでも気付くための回数である。
  開いているダイアログは、マウントしたときより新しい選択かを調べるのに使う。
- 通知を出せるか、受け取るか（`notify`）は Runtime が入れる。Mediator は切り替えを効果にするだけである（受け取るは `notify.request`、受け取らないは `notify.off`）。

状態機械の実装は `packages/ui/src/mediator/` に置き、領域ごとにファイルを分ける。
テストは「入力の列を与えて最終状態と効果の列を検証する」形で書く。

### API を 1 回呼ぶだけの UiAction の表

状態を変えず、API を 1 回呼ぶだけの UiAction は、Mediator も Effect も通さない。
Runtime が UiAction を受けたとき、`packages/ui/src/runtime/actionTable.ts` の表（UiAction の kind から API の呼び出しへ）を引き、あればそれを実行する。
無ければ、今までどおり `transition` へ渡す。
UiAction と Effect の 2 つの定義を持つと、画面を作り替えるたびに 2 か所を触ることになるからである。

今すぐ同期と一時停止もここにある。応答の状態は Store に当てるだけで、Mediator へは戻さない。

表の 1 行は、UiAction の中身と Store（読むだけ）から呼び出しを組む小さな関数である。
応答の扱いは共通の形にまとめてある。
呼ぶ前に Store に当てるもの、応答を Store に当てるもの、応答から出す知らせの 3 つで、行は要るものだけを書く。
失敗は、どの行もトーストにする。
行が null を返せば、何も呼ばない（空の URL、Store に無い TODO など）。

表に載せるのは、次をすべて満たすものだけである。
State を読まない。
State を変えない。
応答を Mediator へ戻さない。
API を呼ぶのが 1 回である。
1 つでも外れるものは Mediator に残す。
同じ Effect をほかの遷移も出すもの（索引の作り直しはパレットからも出る）も、Effect が残るので移さない。

表の鍵は UiAction の kind の部分集合で、型が止める。
Mediator の入力の型（`MediatedAction`）は表の kind を除いてあるので、表にある kind を領域の `switch` に書くと型が合わなくなる。
どの UiAction が表にあるかは、表が正である。

### 画面ごとの構成

各画面の Presenter が計算する値は、次の節の「画面」で画面ごとに述べる。
ここでは共通の約束だけを書く。

- 一覧は仮想スクロールで描く。1 行 44px の 2 段の行（1 段目に名前、2 段目に要約の 1 文）で、100 件を超えても遅くしない。
- 時刻は相対表示（「3 分前」）を基本にし、ホバーで絶対時刻を出す。
- 識別子、パス、時刻（04:28）、数だけの表示は等幅フォントで描く。数と仮名が混じる短い語（「12 分前」「1,222 件」「変更 5」）は本文の書体のまま、数字の幅だけをそろえる（`.num`）。
- UI の一時状態（開いているタブ、分割、折りたたみ）は端末の localStorage に保存し、同期しない。

## データモデル

### 方針

hangar 固有のデータは `~/.agent-hangar/hangar.db`（SQLite）に置く。
プロジェクトのメモだけは Markdown ファイルとして `~/.agent-hangar/projects/<projectId>/memo.md` にも置き、DB には更新時刻と内容の写しを持つ。
メモをファイルで持つのは、他のエディタや Claude 自身から直接読み書きできるようにするためである。

テーブルは **共有** と **端末ローカル** に分ける。
共有テーブルは端末間で同期し、ローカルテーブルは端末の中だけで使う。
共有テーブルの行はすべて次の列を持つ。

- `id`：UUID v7。端末をまたいで衝突しない。
- `updated_at`：ミリ秒の UNIX 時刻。競合の解決に使う。
- `deleted_at`：削除時刻。物理削除はせず、削除マークで表す。
- `origin_device`：行を最後に更新した端末の ID。

### 共有テーブル

```sql
create table devices (
  id text primary key, name text not null, platform text not null,
  last_seen_at integer, updated_at integer not null, deleted_at integer, origin_device text not null
);

create table projects (
  id text primary key, name text not null,
  status text not null check (status in ('active','paused','done','archived')),
  is_scratch integer not null default 0,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

-- 端末ごとのパス。同じプロジェクトが端末ごとに別のパスにあってよい。
create table project_roots (
  id text primary key, project_id text not null references projects(id),
  device_id text not null references devices(id), path text not null,
  resolved integer not null default 1,           -- 0 なら見つからず、解決ダイアログの対象
  updated_at integer not null, deleted_at integer, origin_device text not null,
  unique (project_id, device_id)
);

create table sessions (
  id text primary key,
  provider text not null,                         -- いまは 'claude-code' だけ。列と一意の制約は残す（D8）
  provider_session_id text not null,              -- Claude Code では UUID
  project_id text references projects(id),        -- null は未分類
  cwd text not null,
  first_prompt text, ai_title text,
  started_at integer, last_activity_at integer,
  home_device text not null,                      -- 本文を最初に持った端末
  updated_at integer not null, deleted_at integer, origin_device text not null,
  custom_title text,                              -- 索引が本文から拾った題名（custom-title、agent-name）
  unique (provider, provider_session_id)
);

-- セッションの名前とメモ。利用者と Claude が付けるもので、索引は書かない（下の「セッションの名前とメモ」）。
create table session_notes (
  session_id text primary key references sessions(id),
  name text,                                      -- hangar で付けた名前（起動のときの名前）
  memo text,                                      -- 人間が書く 1 行メモ
  updated_at integer not null, deleted_at integer, origin_device text not null
);

-- 1 回の起動または再開。tmux 上の寿命と一致する。
create table runs (
  id text primary key, session_id text not null references sessions(id),
  device_id text not null references devices(id),
  kind text not null check (kind in ('start','resume','fork')),
  tmux_name text not null, pid integer,
  launch_params text not null,                    -- JSON
  started_at integer not null, ended_at integer, end_reason text,
  heartbeat_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

-- 追加のシェルタブ。run に属し、独立した tmux セッションを持つ。
create table run_tabs (
  id text primary key, run_id text not null references runs(id),
  tmux_name text not null, title text, created_at integer not null, closed_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

create table session_summaries (
  session_id text primary key references sessions(id),
  title text not null, one_liner text not null, body text not null,
  state text not null check (state in ('in_progress','done','blocked','abandoned')),
  next_steps text not null,                       -- JSON 配列
  source text not null check (source in ('baseline','in_session','post_hoc')),
  source_id text,                                 -- 書いた要約器の id。要約器を通さない要約と古い行は null
  source_model text, based_on_turns integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

create table todos (
  id text primary key, project_id text not null references projects(id),
  text text not null, done integer not null default 0, position integer not null,
  session_id text references sessions(id),
  updated_at integer not null, deleted_at integer, origin_device text not null
);

create table project_memos (
  project_id text primary key references projects(id),
  markdown text not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

create table artifacts (
  id text primary key, project_id text references projects(id),
  url text not null unique, title text, description text, favicon text,
  first_published_at integer not null, last_published_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

create table artifact_versions (
  id text primary key, artifact_id text not null references artifacts(id),
  session_id text not null references sessions(id), file_path text, published_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);

-- 引き継ぎの握手のために v1 で作った表。握手は作らないと決め、共有テーブルの一覧（SHARED_TABLES）からも外した。
-- 表はマイグレーションに残るが、誰も書かず、同期でも運ばない。
create table takeover_requests (
  id text primary key, run_id text not null references runs(id),
  from_device text not null, requested_at integer not null,
  state text not null check (state in ('requested','acked','forced','cancelled')),
  updated_at integer not null, deleted_at integer, origin_device text not null
);
```

Claude Code の設定の同期（作り直した実装。「クラウド同期」の「設定の同期の作り直し」）の束は、`config_snapshots` に PC ごとに 1 行を持つ（マイグレーション version 18）。
主キーは `id` ではなく端末の ID である。外部キーは持たない。
同期の一覧（`SHARED_TABLES`）の末尾に足してあるので、行は他の表と同じく `changes` に積まれ、クラウドを通って他の端末へ降りる。

```sql
create table config_snapshots (
  device_id text primary key,                     -- 束を上げた端末
  bundle_sha256 text not null,                    -- 束（tar）の指紋。受け手が取りに行く理由になる
  bundle_size integer not null,
  item_count integer not null,
  manifest text,                                  -- 目録 [[項目の id, 指紋, 大きさ], …] の JSON。96 KiB を超えるときは null（束の中に同じ目録がある）
  updated_at integer not null, deleted_at integer, origin_device text not null
);
```

### 変更ログ

共有テーブルへの書き込みは、すべて `changes` に 1 行を追記する。
同期エンジンはこの表の未送信分を送る。
受け取った変更はこの表に積まず、行へ直接適用する。
適用した行は、行の変化の口へ `apply` として知らせる（「行の変化の知らせと配る層」）。
この表に載るのは自分の端末が起こした変更だけなので、未送信の行は同じ `(table_name, row_id)` ごとに 1 行へまとめてよい。
この表はフェーズ 1 から作ってあり、フェーズ 4 の同期エンジンが初めて読み手になった。

```sql
create table changes (
  seq integer primary key autoincrement,
  table_name text not null, row_id text not null,
  op text not null check (op in ('upsert','delete')),
  payload text not null,                          -- 行全体の JSON
  updated_at integer not null, device_id text not null,
  pushed_at integer                               -- null は未送信
);
```

#### セッションの名前とメモ

セッションの名前とメモは `sessions` の列に置かず、別の表 `session_notes`（主キーはセッションの id）に置く（マイグレーション version 17）。
`sessions` の行は索引だけが書く。

`sessions` の行は、索引が本文の伸びるたびに全列で書き直し、同期はその行ごとの後勝ちで運ぶ。
名前とメモが同じ行にあると、別の PC で付けた名前やメモを、本文を持つ PC の索引が手元の古い値で上書きする。
セッションの状態（`session_states`）を別の表に分けたのと同じ理由である。
分ける前は、索引の書き直しが、誰も書き換えていないメモまで巻き込んで上書きした。
そのため同期の適用（`sync/apply.ts`）は、`sessions` の行を上書きする前に、メモを `backups/memos/` へ逃がしていた。
分けた今は、その控えを `session_notes` の行の上書きで取る。取られるのは、2 台が本当に別々に書いたときだけである（「クラウド同期」の、メモの控え）。

- **書き手。** `session_notes` に書くのは、起動のときの名前（`runs/manager.ts`）、画面のメモ（`PATCH /api/sessions/:id`）、MCP の `set_session_memo` で、どれも `sessions/notes.ts` を通る。
  書いた結果が今と同じなら書かず、行の無いところへ空を書いて空の行を作ることもしない。
  空の行は新しい時刻を持つので、同期で他の PC の名前やメモに勝ってしまうからである。
- **本文の題名は別の事実。** Claude Code の側で付けた名前（`-n`、`/rename`）は本文に `custom-title`、`agent-name` として残り、索引がそれを `sessions.custom_title` に拾う。
  分ける前は、索引も hangar も同じ `sessions.name` に書き、後から書いた方が残った。
  hangar が名前を書くのは起動のときだけなので、本文に題名が現れれば必ずそれが残った。
  この見え方を変えないよう、表示名は、本文の題名を hangar の名前より先に採る（`db/queries.ts` の `displayName`）。
  順は、実行中の Claude Code が持つ利用者の名前（レジストリの `name`、`nameSource` が `user`）、`sessions.custom_title`、`session_notes.name`、`sessions.ai_title`、最初の発言の先頭 40 字である。
  `custom_title` は列の追加で、改名ではない（D8 に反しない）。
- **DTO は変えない。** `SessionDto` の `name` と `memo` は、サーバが `sessions`、`session_notes`、`session_states` を合わせて今までと同じ形に組む（D8）。UI は表が分かれたことを知らない。
- **移すとき。** 版 17 は、名前かメモに中身のある行だけを `session_notes` へ写し、`sessions.name` と `sessions.memo` を落とす。
  過去の `sessions.name` は、起動のときに hangar が書いたものと、索引が本文から拾ったものが同じ列に混ざっていて、どちらの由来かを見分けられない。
  `custom_title` へ写すと、利用者が hangar で付けた名前を索引の事実として扱うことになり、索引の作り直しで消えうる。
  そこで全部を `session_notes` へ写し、`custom_title` は空から始める。写した名前は同期で守られ、表示の順でも今までと同じ所に出る。
  本文に題名が新しく現れるか、索引を作り直せば、`custom_title` が埋まってそちらが先に出る。分ける前に索引が上書きしたのと同じ結果である。
  写した行の `updated_at` は、どの PC でも同じ固定の小さな定数（`db/migrations.ts` の `MIGRATED_NOTE_AT`、値は 1）にする。`origin_device` は元の `sessions` の行のものである。
  当てた時刻にすると、後から上がった PC の写し（古い中身）が、先に上がった PC で上げた後に付けた名前やメモに勝ってしまう。
  元の `sessions` の行の時刻でも同じことが起きる。まだ上げていない PC では、索引がその時刻を進め続けるからである。
  定数は本物の書き込みの時刻より必ず古いので、上げた後の書き込みは、どの PC がいつ上がっても、その写しに必ず勝つ。
- **写し同士がぶつかったとき。** 2 台の写しは必ず同じ時刻になる。中身が同じなら何も起きない。
  中身が違うとき、同期の共通の決まり（同じ時刻なら手元を残す）のままだと、2 台が別々の中身を持ったまま食い違う。
  そこで `session_notes` の、手元も降りてきた行も写しの定数の時刻である場合に限り、降りてきた側を採る（`sync/apply.ts` の `copiesCollide`）。
  Worker は同じ時刻の行を先に着いた方で残すので、クラウドにあるのは先に上がった PC の写し 1 つである。
  後から上がったどの PC もそれを受けて自分の写しを置き換え、先に上がった PC にはほかの写しが降りてこない。どの PC も、先に上がった PC の中身に収束する。
  `origin_device` の辞書順のように手元で比べる決め方にしなかったのは、手元が勝った PC の写しを Worker が採らず、相手に届かないからである。
  負けた側の中身は、その PC の控えに残る。ほかの表と、本物の書き込み同士では、共通の決まりのままである。
  写した行は、まだ送っていない差分として `changes` にも積む。積まないと、クラウドには名前もメモも上がらない。
- **クラウドに残る古い形の行。** 版 16 までの端末が上げた `sessions` の payload は `name` と `memo` を含む。
  適用の側は payload を手元の列だけに絞るので、列としては捨てる。手元に `session_notes` の行があれば、それには触らない。
  手元にそのセッションの `session_notes` の行が無く、payload の名前かメモに中身があるときは、その中身で行を作る（`adoptNoteFromOldSession`）。
  書いた PC がまだ上がっていないと、その名前とメモはクラウドのどこにも `session_notes` の行として無く、新しく参加した PC から見えないからである。
  作る行の時刻は写しの定数、`origin_device` は payload の書き手にする。
  作るのは pull の 1 巡を読み切った後である。同じ 1 巡で本物の行が届くなら、それを採り、古い中身は拾わない。
  こうして作った行は、こちらからは上げ直さない（`changes` に積まない）。
  上げると、書いた PC より先にクラウドへ着き、写し同士の決着（先に上がった側）で、書いた PC の写しに勝ってしまう。
  書いた PC は、まだ上げていなかった新しい名前やメモを持っていることがある。書いた PC が上がれば、その写しが届いて、ここで作った行を置き換える。
- **混ぜない。** 運ぶ形が変わるので、互換の版を 2 に上げた（「互換の版番号」）。

### 行の変化の知らせと配る層

DB に書いた後で画面へ配るのは、書いた側ではなく、配る層（`packages/server/src/events/publisher.ts`）の役目である。
書いた側は、行の変化の口（`db/notify.ts`）へ「どの表のどの行（主キー）が変わったか、消えたか」を知らせるだけで、DTO を組まず、hub にも触れない。
以前は、書いた後に読み直して `hub.broadcast` を呼ぶ処理を呼び手ごとに手で書いていて、ロックの判定に要る端末の ID を渡し忘れると、ロックの無い行が画面に配られた。

知らせの出どころは 3 つある。

| 出どころ | 誰が知らせるか | 同期の push |
| --- | --- | --- |
| `write` | `upsertShared` と `softDeleteShared`（この端末が共有テーブルに書いた） | 契機にする |
| `apply` | `sync/apply.ts` の `applyRemoteBatch`（同期で降りた行を当てた） | 契機にしない |
| `touch` | `touchRow`（行は書いていないが、その行の DTO の中身が変わった） | 契機にしない |

`touch` は、行は変わらないが、その行から組む DTO の中身が変わったときに使う（使う所は、この節の下の表にある）。
外側のトランザクションの中の知らせは、最外が確定するまで遅れる。
巻き戻った `write` は知らせない（`changes` の行が残っているかで見分ける）。
購読が投げても、他の購読にも書いた側にも波及しない。

購読者は 2 つである。
同期エンジンは `write` だけを拾い、push のデバウンスに使う。
降りた行（`apply`）は `changes` に積まれないので、拾わない。
配る層は、表名から配る先を決め、行を読み直して DTO を組み、hub へ渡す。

| 表 | 配るイベント |
| --- | --- |
| `sessions`、`session_summaries`、`session_states`、`session_notes` | そのセッションの `session.upsert` |
| `runs` | 持ち主のセッションの `session.upsert`。同期で降りたときだけ配る（他端末のロックが変わるため）。この端末の run は `run.started`、`run.upsert`、`run.ended` が運ぶ |
| `projects` | そのプロジェクトの `project.upsert` |
| `project_roots` | そのプロジェクトの `project.upsert`。この端末のルートが未解決になった書き込みも配る。ホームの帯の件数と、プロジェクトの一覧の札が、再読み込みを待たずに変わるためである |
| `devices` | 一覧ごとの `devices.update` |
| `project_memos` | `memo.update` と、メモの頭を載せるプロジェクトの `project.upsert`。この端末の変化だけを配る |
| `artifacts` | `artifact.upsert`。この端末の変化だけを配る |
| `todos` | そのプロジェクトの一覧ごとの `todos.update` と、未完の数を載せるプロジェクトの `project.upsert`。この端末の変化だけを配る |
| `config_snapshots`、`config_state`（表ではなく、状態を動かした名指しの名前） | 設定の同期（作り直した実装）の状態 `config.update`。束の行が降りたときも、この端末が書いたときも配る。同期を組んでいない端末では何も配らない |

対応は `publisher.ts` の 1 つの表（`TABLES`）にあり、画面へ配る表を足すときは、そこへ 1 行を足す。
表に無いもの（`run_tabs`、`artifact_versions`、手元だけの表）の知らせは、何も配らない。
同期で降りたメモ、アーティファクト、TODO を配らないのは、この層を入れる前の振る舞いを変えないためである。

配る層の決まりは次のとおりである。

- 同じ tick の中で同じ行が何度変わっても、配るのは 1 回である。組むのは tick の終わり（マイクロタスク）なので、中身はその時点の最後の状態になる。並びは、最後に知らされた位置である。
- ロックの判定に要る端末の ID は、この層が 1 回だけ渡す。
- 読み直して行が無い（消えた）ときは、何も配らない。
- WebSocket の受け手がいないあいだは、行を読み直さない。起動時の全走査で、誰も受けない DTO を組まないためである。
- 表の変化に対応しない知らせは、呼び手が `broadcast` で渡す。それらも同じ列に並べて tick の終わりに渡すので、行のイベントとの前後は呼んだ順のまま保たれる。
- 行のイベント（`session.upsert`、`project.upsert`、`devices.update`、`memo.update`、`artifact.upsert`、`todos.update`、`config.update`）は、この層だけが組む。`broadcast` は型（`NoticeEvent`）でこれらを受けない。呼び手が手で組んで渡す道は無いので、同じ行が二重に届くことも、端末の ID を渡し忘れた行が届くことも無い。
- 行は書いていないが中身が変わったときは、呼び手は `touchRow` でその行を名指しする。同じ tick の書き込みと重なっても、配るのは 1 回である。

サーバの業務の関数（`projects/`、`sessions/`、`runs/`、`sync/` にある受け手）も、HTTP の経路（`http/routes/*.ts`）も、MCP の道具（`mcp/tools.ts`）も、事後要約のジョブ（`summary/job.ts`）も、行を書く（か名指しする）だけで、配るのはこの層である。
MCP の道具は hub を持たない。
事後要約のジョブは、以前は端末の ID を渡さずにセッションを組んで配っていて、他端末のロックの無い行が届いていた。いまは要約の進みだけを渡す。

名指し（`touchRow`）を使うのは、次の所である。

| 名指しする所 | 行 | 中身が変わる理由 |
| --- | --- | --- |
| 索引（`indexer/service.ts`、`projects/onSessionChanged.ts`） | セッション、プロジェクト、アーティファクト | 手元だけの表（本文の索引、集計）を書き直した。セッションが紐づいた |
| 未分類のセッションの紐づけ（`assignSessions`） | 入った先のプロジェクト | 最終の活動と実行中の数が変わる |
| クイックセッション用のプロジェクトの置き場の選び直し（`resolveProject`） | この端末のセッションのうち、作業の場所が前の置き場か新しい置き場の下にあるもの | `fromScratch` は、その置き場（`project_roots`）から決まる |
| 実行中の一覧が動いたとき（`sessions/liveChange.ts`） | 出入りしたセッション、動きが変わった印付きのセッション、すべてのプロジェクト | 実行中かどうかと実行中の数は、行に無い |
| run の起動（`runs/announce.ts`） | そのセッション | run が付いた。`run.started` の後に届く |
| statusline の受け口（`POST /api/ingest/statusline`） | そのセッション | モデルと文脈の量は手元だけの表（`session_live_stats`）にある |
| 設定の同期（`sync/config/service.ts`）。`config_state` の `self` を名指しする | 設定の同期の状態 | 基準（`config_base`）、送らなかった項目（`config_unsent`）、inbox、適用の指示書、スイッチと承諾の仕方は、行のイベントになる共有の表ではない |
| 昇格（`POST /api/sessions/:id/promote`） | 昇格元のプロジェクト | セッションが 1 件減る |

呼び手が `broadcast` で渡す、表の変化に対応しない知らせは次のとおりである。

| 知らせ | 渡す所 |
| --- | --- |
| `toast` | 同期の知らせ（`sync/notices.ts`、`sync/oncePass.ts`）、`POST /api/index/rebuild` の失敗。操作の結果と、メモの競合のように手元で起きたことの知らせだけで、同期の失敗は流さない（「ベルと知らせの出し分け」の節） |
| `run.started`、`run.upsert`、`run.ended`、`tab.upsert` | `runs/announce.ts`（RunManager の通知） |
| `index.progress`、`transcript.appended` | `boot/indexing.ts`（索引の進み）、`projects/onSessionChanged.ts`（本文の伸び） |
| `live.update` | `sessions/liveChange.ts`（実行中の一覧） |
| `sync.status`、`sync.usage` | `sync/statusFeed.ts`（同期の状態）、`boot/sync.ts`（使用量の見張りの結び） |
| `accounts.update` | `http/accounts.ts`、statusline の受け口 |
| `retention.changed` | `provider/claude-code/config/retention.ts` |
| `summary.pending`、`summary.updated`、`summary.failed` | `summary/job.ts` |
| `project.unresolved` | ルートの確かめ（`projects/rootCheck.ts`）。解決済みから未解決への遷移の知らせである。画面はこれでダイアログを開かない（使う側は無い。型は段 4 の中では消さない） |

経路が手で配っていた頃と比べて、届くイベントの数が変わった所がある。中身は変わらない。

- 置き場の選び直し（`POST /api/projects/:id/resolve`）は、全セッションを流していた。いまは紐づけが変わったセッションだけが届く。
- ワークスペースの変更（`PATCH /api/settings`）は、全プロジェクトを流していた。いまは新しく登録したプロジェクトと、セッションが入ったプロジェクトだけが届く。
- 登録済みのフォルダの登録し直し（`POST /api/projects`）と、登録済みの URL の足し直し（`POST /api/projects/:id/artifacts`）は、行が変わらなければ何も届かない。アーカイブから戻したときと、消した URL を足し直したときは届く。
- MCP の `update_project` は、status と TODO やメモを一緒に変えると `project.upsert` を 2 回配っていた。いまは最後の中身で 1 回である。

### 端末ローカルのテーブル

```sql
-- 設定の同期（作り直した実装）の基準。項目ごとに、最後に両方の PC で同じだった中身の指紋。3 方向の判定の共通の祖先である。
create table config_base (
  item_id text primary key,
  sha256 text not null,
  synced_at integer not null
);

-- 設定の同期が送らなかった項目。絶対パスの権限の規則（label は規則の文字列）と、秘密らしい文字列のある項目（label は項目の名前。見つけた文字列は持たない）。
-- allowed は「それでも送る」を押した印で、content_sha256 が変わると効かなくなる。
create table config_unsent (
  id text primary key,
  kind text not null check (kind in ('permission-rule','secret')),
  item_id text not null,
  label text not null,
  reason text not null,                            -- absolute-path か secret:<見つけた形の名前>
  content_sha256 text not null,
  allowed integer not null default 0,
  found_at integer not null
);

create table transcript_files (
  path text primary key, session_id text not null, agent_id text,
  size integer not null, mtime integer not null, indexed_bytes integer not null,
  indexer_version integer not null, last_error text,
  device_id text                                   -- その本文がどの端末のものか。null は手元
);

-- 1 イベント 1 行。本文は持たず、ファイル内の位置だけを持つ。
create table event_index (
  id integer primary key,
  session_id text not null, seq integer not null,
  kind text not null,                              -- 正規化イベントの種別
  ts integer, byte_offset integer not null, byte_length integer not null,
  file_path_ref text not null,                     -- 位置が指すファイル
  parent_agent text,                               -- サブエージェントの ID。null は主線
  tool_name text, file_path text                   -- tool_call のときだけ
);
-- 主線とサブエージェントで seq の空間を分ける。
create unique index event_index_pos on event_index(session_id, ifnull(parent_agent, ''), seq);

create virtual table event_fts using fts5 (
  session_id unindexed, agent_id unindexed, seq unindexed, role, text,
  tokenize = 'trigram'
);

-- 索引から導出した統計。共有しない。
create table session_stats (
  session_id text primary key,
  turns integer not null default 0,
  model text, effort text,
  files_changed integer not null default 0,
  pr_url text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  first_ts integer, last_ts integer,
  last_prompt text
);

create table usage_snapshots (
  at integer primary key, payload text not null    -- statusline から受けた JSON
);

-- statusline の payload から取る、セッションごとの付帯情報。
create table session_live_stats (
  provider_session_id text primary key,
  model text, effort text,
  context_used integer, context_size integer,
  cost_usd real,
  updated_at integer not null
);

-- Artifact ツールの呼び出しの控え。結果と突き合わせるために持つ。
create table artifact_calls (
  tool_id text primary key, session_id text not null,
  file_path text, description text, favicon text
);

-- jsonl の usage から導いた、セッションとファイルと日ごとのトークン数。
create table usage_daily (
  session_id text not null, day text not null, file_path text not null,
  input_tokens integer not null default 0, output_tokens integer not null default 0,
  primary key (session_id, file_path, day)
);

-- R2 との同期の台帳。同じ中身を二度上げず、降ろしたものが本物かを確かめるために持つ。
-- sha256 は上げる側も降ろす側も、圧縮と暗号化の前の平文の指紋である。
create table file_sync (
  key text primary key,                            -- R2 の鍵
  kind text not null,                              -- 'transcript' | 'config'
  path text not null, device_id text not null,
  sha256 text not null, size integer not null, mtime integer not null,
  remote_seq integer, synced_at integer not null
);

create table sync_state (key text primary key, value text not null);
create table settings_local (key text primary key, value text not null);
```

検索用テキストとして FTS に入れるのは、利用者の発言、アシスタントの本文、ツール呼び出しのファイルパスとコマンド文字列である。
ツールの結果本文は入れない。
トークナイザは trigram で、日本語の部分一致を助ける。

### 正規化トランスクリプト

`packages/shared` に、jsonl の形式に依らないイベント型を定義する。
UI はこの型だけを描く。

```ts
type TranscriptEvent =
  | { kind: 'user'; seq: number; ts?: number; text: string; attachments?: Attachment[] }
  | { kind: 'assistant'; seq: number; ts?: number; text: string; model?: string }
  | { kind: 'thinking'; seq: number; ts?: number; text: string }
  | { kind: 'tool_call'; seq: number; ts?: number; toolId: string; name: string; input: unknown; summary: string; filePath?: string }
  | { kind: 'tool_result'; seq: number; ts?: number; toolId: string; text: string; isError: boolean }
  | { kind: 'subagent'; seq: number; ts?: number; agentId: string; label: string }
  | { kind: 'system'; seq: number; ts?: number; text: string }
  | { kind: 'meta'; seq: number; ts?: number; name: string; value: unknown };   // ai-title, pr-link など
```

`summary` はツール呼び出しを 1 行で表す文字列で、折りたたみ表示に使う（例：`Edit src/app.ts`）。
`meta` は表示しないが、索引の抽出元になる。

## Claude Code に固有の部分

hangar が対応するのは Claude Code だけである（2026-10-07 の決定 D7）。
Claude Code の形式や振る舞いを直接知っている部分は、`packages/server/src/provider/claude-code/` に集めてある（段 2 の PR 12）。
以前は Provider のインターフェースを置いていたが、実装していたのは起動の 2 項目だけで、索引はインターフェースを通らずに jsonl を読んでいたので、段 1 で消した。
`sessions.provider` の列と `(provider, provider_session_id)` の一意の制約は、永続する識別子なので残す（D8）。

`provider/claude-code/` の中は、役目ごとに分けてある。

| 置き場 | 中身 |
| --- | --- |
| `transcript/` | jsonl の走査（`discover.ts`）、追記分の読み（`lines.ts`）、正規化（`normalize.ts`）、最後の動きの畳み込み（`activity.ts`） |
| `hooks/` | hook の入力から AskUserQuestion の出入りを読む（`question.ts`） |
| `registry.ts` | 実行中のセッションの登録（`~/.claude/sessions/<pid>.json`）の読み |
| `launch/` | 起動の引数（`args.ts`）、`--mcp-config` に渡すファイル（`mcpConfig.ts`）、`--settings` に渡す hook の設定（`hookSettings.ts`） |
| `config/` | `~/.claude.json`（`claudeJson.ts`）、設定ファイルの書き方（`claudeFileWrite.ts`）、保持期間（`retention.ts`）、statusline の台本（`statusline.ts`）、アカウントの認証（`accountAuth.ts`）と共有のリンク（`accountLinks.ts`） |
| `prompt/` | `/` の候補（`commands.ts`、`frontmatter.ts`）、入力の履歴（`history.ts`） |
| `process/` | `claude agents --json` と `claude stop`、プロセスの起動時刻（`procs.ts`） |
| `screen/` | fullscreen の画面を操作して指示へ跳ぶ（`promptJump.ts`） |
| `summary/` | `claude -p` での要約（`claude.ts`） |
| `compat/` | 互換の見張り（次の節） |
| `types.ts`、`index.ts` | 起動の入力と走査の型、起動コマンドの組み立て |

この置き場の中から読んでよいのは、下の層（`platform/`、`i18n/`、`config/`、`sync/` や `summary/` の型と小さな関数）だけで、HTTP、`boot/`、`events/` は読まない。
外からは、入口のファイルを通さずに、使うモジュールを直に import する。
入口 1 つにまとめると、CLI の束（`cliEntry.ts`）がサーバの大半を抱えることになるためである。

Claude Code の事情と hangar 自身の物（DB、tmux、同期）が 1 つのファイルに混ざっているものは、まだ外に残してある。
索引（`indexer/`）、本文の読み出し（`transcript/read.ts`）、statusline の payload の読みと使用率の保存（`usage/statusline.ts`）、設定の同期（`sync/config/`）、包みと環境変数（`launch/wrapper.ts`、`launch/command.ts`、`launch/env.ts`）、シェルの包み（`config/shellHook.ts`）、run の寿命（`runs/manager.ts`）などである。
これらを割るのは振る舞いに触るので、別の変更で行う。

### 保存先と読み方

Claude Code の保存先と、その読み方を定める。

- 本文は `~/.claude/projects/<変換名>/<sessionId>.jsonl` にある。変換名は cwd の英数字以外を `-` に置き換えたもので、日本語を含むパスは不可逆になる。cwd は行内の `cwd` か `~/.claude/history.jsonl` の `project` から読む。
- `~/.claude/history.jsonl` は利用者の発言だけの軽い索引で、初回列挙に使う。
- ファイルの末尾には `last-prompt`、`mode`、`permission-mode`、`ai-title`、`pr-link` などのメタ行が混ざる。ほかにも `bridge-session`、`isolation-latch`、`agent-name`、`custom-title`、`file-history-snapshot`、`file-history-delta`、`frame-link`、`cost-state`、`relocated`、`worktree-state`、`queue-operation`、`attachment` などがある。行の `type` で振り分け、知らない種別は `meta` として保持する。
- `user` 行の `message.content` は配列ではなく文字列のことがある。抽出は両方を受ける。
- サブエージェントの本文は `<sessionId>/subagents/agent-<hex>.jsonl` にあり、`isSidechain: true` で親に紐づく。件数はセッション本体の 3 倍以上あり、インデクサは両方を読む。
- 実行中の状態は `~/.claude/sessions/<pid>.json` にあり、`sessionId`、`cwd`、`name`、`nameSource`、`status`（busy、idle、waiting、shell）を持つ。ファイルの出現と消失が起動と終了に対応する。
  - Claude Code は、一時のファイルからの改名に失敗すると、登録をその場で書き直す（切り詰めてから書く）。Windows では、ほかのプロセスがファイルを開いているだけで改名が失敗しうる。その間に読むと中身が空か途中までになる。`RegistryWatcher` は、読めなかった登録を、前に読めた中身のまま 4 回（500 ミリ秒ごとの読み直しで 2 秒）まで続ける（`registry.ts` の `RegistryCarry`）。読めないまま捨てると、そのセッションが一瞬だけ終わったように見え、待っている問いまで消える（「Home の帯と引き出し」の節）。ファイルが無くなった登録と、はじめから読めない登録は、今までどおり読まない。
- 起動フラグは `--session-id`、`-n`、`--append-system-prompt`、`--mcp-config`、`--settings`、`--model`、`--effort`、`--permission-mode`、`-w`、`--add-dir`、`-r`、`--fork-session` を使う。
- Windows の実機（2.1.296）で、AskUserQuestion だけを呼んだ回に、入力待ちの間は本文から問いの文が取れなかった。macOS の 2.1.296 で 2 回試した回は、答える前に本文に書かれて取れた。本文に頼り切らないよう、問いの文は hook からも受け取る（「Home の帯と引き出し」の節）。

サブエージェントの本文は主線と別のファイルで独立に伸びるので、`event_index` の一意制約は `(session_id, ifnull(parent_agent, ''), seq)` とし、主線とサブエージェントで `seq` の空間を分ける。
主線を絞る問い合わせは、この索引の式に合わせて `ifnull(parent_agent, '') = ''` と書く。
`parent_agent is null` と書くと索引に乗らず、長いセッションでは 1 回でそのセッションの全行を表まで見に行く。
本文を読むとき（`transcript/read.ts`）は、索引のバイト位置からファイルを読み、正規化し直す。
1 つの記録から出た行は `seq` が続いているので、ページの中の 2 つ目からの記録は、ページに入った最初の行が記録の先頭である。
記録の途中から始まりうるのはページの最初の記録だけで、その先頭は索引を 1 行ずつ遡って確かめる。
`byte_offset` は索引に無いので、記録ごとにバイト位置で先頭を引くと、読む件数とセッションの長さの積で重くなる。
セッション詳細でサブエージェントを選ぶと UI は `transcript.selectAgent` を発行し、表示する本文をそのサブエージェントのファイルに切り替える。

インデクサは各ファイルのバイト位置を `transcript_files` に持ち、追記分だけを読む。
1 セッションのファイルは主線の `<sessionId>.jsonl` を先に、`subagents/` 配下を後に読む。
途中で切れた最終行は次回に回す。
ファイルの変化は監視し、追記から数百ミリ秒で索引に反映する。
`indexer_version` を上げたときは、背景で全件を作り直し、進行を「N / 総数 件」の静的な文字で示す。
フェーズ 0 の計測では、733 ファイル 1.34GB の全件索引化が 7 秒、DB は 183MB だった。
フェーズ 1 の実装では、791 ファイル、40 プロジェクト、1,127 セッションの全件索引化に約 15 秒かかった。

### Claude Code との互換

hangar は、Claude Code が公開を約束していない形式に頼っている。
利用者ごとに claude の版が違うので、形式が変わったときに気づけるよう、頼っている形式を 6 つの契約に分けて見張る（`packages/server/src/provider/claude-code/compat/`）。
対応する版の範囲は決めない。
Claude Code はほぼ毎日新しい版が出るので、範囲はすぐ古くなり、範囲の中で形式が変わっても捕まえられないためである。

| 契約 | 見張るもの | ずれたときの振る舞い |
| --- | --- | --- |
| トランスクリプト | 行の `type`、`system.subtype`、本文の塊の種類、メタ行の種類が、知っている集合にあるか。添付は、hangar が読む積んだ指示（`queued_command`）でない種類が文字の `prompt` を持つとき（積んだ指示の改名とみられるとき）だけ見る | 知らない行は meta として残し、知らない塊は捨てる。記録する |
| レジストリ | `status` が busy、idle、waiting、shell のどれかか。`sessionId` と `pid` があるか | 知らない `status` は作業中として扱う。誤って止めるより待たせるほうが害が小さい。配列や `null` の登録はその 1 件だけ読まない。記録する |
| statusline | `session_id`、`model`、`context_window.context_window_size`、`cost.total_cost_usd`、`rate_limits` の各窓の `used_percentage` と `resets_at` があるか。`resets_at` の単位 | `resets_at` が 10^11 より大きければミリ秒と見て、そのまま使う。欠けた項目は直前の値を保つ。記録する |
| `~/.claude` の項目 | 2 つ目以降のアカウントの置き場の直下に、共有のリンクでも、アカウントごとに持つと知っている項目でもないものがあるか | アカウントごとのままにする。記録する |
| CLI | `claude --help` のサブコマンド、`auth status --json`、`agents --json`、`-p --output-format json` の形 | サブコマンドは包みの一覧を作り直す。ほかは形が違えば読まずに既定へ落とす。記録する |
| 画面の文字 | ターンへ跳ぶときに読む、transcript 表示の最下行の文言と、指示の行の頭の記号 | 見つからなければ跳ぶのをやめる。記録する |

トランスクリプトは、手元の claude の版（読めるまでは確かめた版）より古い版の行を見ない。
長い履歴を初めて索引にするときに、昔の形の行でずれが溢れないようにするためである。
版の無い行（メタ行の多く）は、同じファイルを同じ回に読んだ中の直前の行の版を使う。
追記の頭などで版の分からない行は見ない。
他端末から降ろした写しは見ない。

`~/.claude` の項目は、最初の置き場（`~/.claude`）を見ない。
利用者が自分で置いたファイル（dotfiles の git など）と、Claude Code が足した項目を見分けられないためである。
2 つ目以降の置き場は hangar と Claude Code しか書かないので、リンクでない知らない項目は Claude Code が足したものと読める。
アカウントが 1 つなら、共有されない項目は生まれないので、見張らない。

画面の文字は、ターンへ跳ぶ操作で続けて 3 回見つからなかったときに初めて記録し、間に 1 回でも見えたら数え直す。
描き直しの遅れ、ダイアログ、狭いペインといった一時の事情でも 1 回は見つからないことがあり、形式が変わったときは毎回見つからないためである。
レジストリの `status` の欠けも、同じ登録（ファイル、`sessionId`、`pid` の組）で続けて 2 回の読み取りで欠けていたときだけ記録する。
Claude Code は登録を `status` の無い形で書き始め、すぐ後に足すので、その間に 1 度読んだだけの欠けは形のずれではないためである。

利用者の発言でない行を見分ける目印（本文の頭のタグなど）は自由な文字列で、知っている集合で見張れない。
これは見本の試験で確かめる。

Claude Code が子（Bash、hook、裏のセッション）に立てる印の名前も、公開を約束していない形なので、ここに一覧で置く（`compat/childEnv.ts`）。
hangar が起こすものへ持ち込まないために使う（「tmux による起動」）。見張りはせず、2.1.295 で確かめた名前を持つ。
利用者が立てる設定として公開の文書に載っている名前と、ほかの道具と共有する名前（`GIT_EDITOR`、`TRACEPARENT` など）は入れない。

claude の長くなりうる出力（`--help`、`agents --json`、`-p --output-format json`）は、標準出力を一時ファイルへ書かせて読む（`packages/server/src/platform/capture.ts`）。
claude は標準出力がパイプだと非同期に書き、書き切る前に終わることがあり、Node の子プロセスのパイプで読むと 2.1.293 の `--help`（22KB）が 8KB か 16KB で切れて、Commands の節が無いと読んでいたためである。
短いと決まっている出力（`--version`、`auth status --json`）はパイプのまま読む。

#### ずれの記録

ずれは、契約、値（たとえば `system.subtype=foo`）、claude の版、回数、最初と最後に見た時刻を持つ。
版は、その値を読んだ元（レジストリ、トランスクリプトの行、statusline の JSON）に載っている `version` を使い、無ければ手元の `claude --version` を使う。
記録は `~/.agent-hangar/compat.json` に置く。
端末ごとのもので、同期しない。
DB のマイグレーションを要らない形にするためにファイルにした。
同じ契約と値の組は 1 件にまとめて回数を数え、100 件を超えたら最後に見た時刻の古いものから落とす。
書き出しは 5 秒ごとと、サーバを閉じるときである。
レジストリは 500 ミリ秒ごとに読み直すので、ずれは登録が変わったときだけ数える。
`~/.claude` の項目は、同じ名前をサーバの寿命で 1 度だけ数える。
記録は、そのときの手元の claude の版も持つ。
手元の版が変わったら、記録を空にして数え直す。
前の版で出たずれが、新しい版でも出るとは限らないためである。
版が読めないときと、前の版が分からないとき（版を持たない古い記録）は消さない。
空にしたときは、上の 1 度しか数えない元（`~/.claude` の項目、最後に読んだ `claude --help` のサブコマンド、いまの登録）を、その場か次の読み直しで数え直す。
ほかの元（トランスクリプトの行、statusline、画面の文字、CLI の残り）は数えるたびに記録するので、次にその形を読んだときに数え直される。
記録を読み込むときと、一覧と件数を返すときには、今の hangar が知っている集合ではずれでない値（前の hangar が記録した後に集合へ足した値）を落とし、落としたら書き戻す（`compat/current.ts`）。
契約と値だけで決められる、トランスクリプトの種類、レジストリの `status`、`~/.claude` の項目、CLI のサブコマンドの増減と `agents --json` の行の種類に当て、欠けの記録と statusline と画面の文字は残す。

読む口は `GET /api/compat` で、確かめた版、手元の版、ずれの一覧を返す。
`GET /api/readiness` の応答の `compat` にも、確かめた版、手元の版、ずれの件数を載せる。
手元の版は、どちらも起動に使う claude（`HANGAR_CLAUDE_BIN`、Settings の `claudePath`、`which('claude')` の順）から読む。
始める前の確認の claude の行は Settings の `claudePath` だけを見るので、そこが空でも互換の要約には版が載る。
画面に出すのは、設定の「連携」の群の節と、ホームの帯の始める前の確認の互換の行（ずれのときだけ直すものに入る）だけで、ヘッダー、知らせの札、設定の目次の状態には出さない（「Settings」と「Home」の節）。
ずれの中身（`GET /api/compat`）は、準備の確かめでずれが 1 件以上あるときに、画面が続けて取る。
止めた機能の一覧を、開くのを待たずに出すためである。

#### 確かめた版と見本

確かめた版は、見本のうち最も新しい版である（`VERIFIED_CLAUDE_VERSION`、README にも書く）。
手元の claude がそれより新しいときは「未確認の版」として知らせるが、止めはしない。

見本は `packages/server/test/fixtures/claude/<版>/` にあり、`npm run capture-claude-fixtures` で採る（`packages/server/test/capture/`）。
採る道具は、一時ディレクトリで本物の claude を haiku、effort low で動かし、決めた筋書き（タスクの道具を使う、ファイルを書く、Bash を動かす、作業中に次の指示を積む、サブエージェントを使う、終える）を流す。
権限の確認で止まらないよう、`--permission-mode dontAsk` と `--allowedTools` で、筋書きで使う道具だけを許す。
利用者の設定、MCP、スキルは読ませない（`--setting-sources project`、`--strict-mcp-config`、`--disable-slash-commands`）。
フォルダの信頼の画面は、画面を読んで「Yes, I trust this folder」を選ぶ。
終えるときは、休みの入力の欄へ Ctrl+C を間を置いて 2 回送る（`/exit` は指示として渡り、余計なターンになる）。
statusline の JSON は、`--settings` で差し込んだスクリプトで写す。
tmux は専用のソケットを `-S` で名指しし、止めるのはそのソケットのそのセッションだけで、`kill-server` は呼ばない。
終えたら、一時ディレクトリとホームと設定の置き場のパス、Claude Code が uid ごとに使う一時の置き場（`/tmp/claude-<uid>`）、ホスト名、どのメールアドレスも、組織名、組織の識別子、使用率、戻る時刻、費用と時間の累計（statusline と `cost-state` の行）を決まった値に伏せる。
system-reminder の塊と考えの塊は中身を伏せ、添付は積んだ指示のほかは種類だけにする。
伏せ残し（手元の CLAUDE.md の行を含む）があれば、ファイルと行の場所だけを値を出さずに示し、書き出さない。
伏せた後に筋書きの 2 つの指示が残っているかも確かめる。
最後に `claude purge <作業ディレクトリ> -y` で、その会話の記録を設定の置き場から消す。
Claude の使用量を使うので CI では動かさず、動かす前に利用者に聞く。
採っているあいだ、動いている hangar はこの会話を一覧に出し、後始末の後は消えた会話として扱う。

見本の試験（`packages/server/test/claudeFixtures.test.ts`）は、すべての版の見本について、ずれが 0 件であることと、主な読み取り（ターンの数、積んだ指示、道具、サブエージェント、題名、使用量、ターンの終わり）が筋書きどおりに取れることを確かめる。
`--help` から作ったサブコマンドの一覧が組み込みの一覧と同じであることは、最も新しい見本でだけ確かめる。
組み込みの一覧は最も新しい版に合わせるので、古い見本とは違ってよい。
見本に手元のパスや一時の置き場やメールアドレスが残っていないことと、費用、累計の時間、使用率、アカウントの欄が決まった値に伏せてあることも、この試験が確かめる。
手書きの見本（同じ置き場の直下）は、見本に現れない端のケースのために残す。

#### 週に 1 度の照合

GitHub Actions の `claude-compat`（`.github/workflows/claude-compat.yml`）が、週に 1 度と手動で、最新の claude を npm（`@anthropic-ai/claude-code`）から入れ、`claude --help` のサブコマンドと引数を最も新しい見本と突き合わせる（`packages/server/test/claudeLive.test.ts`）。
違っていればジョブを落とし、見本を採り直す合図にする。
版が新しいだけでは落とさない。
見本がまだ無いときは、「見本がありません」と書いて落ちる。
認証は要らない。

## セッションの起動と観察

### tmux による起動

hangar が起動するセッションは、すべて tmux セッションの中で動く。
tmux を使うのは、hangar を再起動してもセッションが生き続け、ブラウザとターミナルアプリから同時に同じ画面を見られるからである。
Claude Code の `--tmux` フラグは使わず、hangar が自分で tmux セッションを組む。
iTerm2 のネイティブペインに変わるのを避けるためである。

起動コマンドの形は次のとおりである。

```sh
tmux new-session -d -s hangar-<runShort> -c <cwd> -- \
  env [-u <外す名前>]... HANGAR_RUN_ID=<runId> \
  bash ~/.agent-hangar/bin/hangar-run.sh ~/.agent-hangar/logs/run-<runId>.log \
  <claude の絶対パス> \
    --mcp-config ~/.agent-hangar/mcp/<sessionId>.json \
    --settings ~/.agent-hangar/mcp/<sessionId>.settings.json \
    [--add-dir <dir>]... \
    --session-id <sessionUuid> -n "<name>" \
    --append-system-prompt "<生成した指示>" \
    [--model <m>] [--effort <e>] [--permission-mode <p>] [-w <name>] \
    ["<初期プロンプト>"]
```

`--session-id` を hangar が生成して渡すので、本文ファイルのパスは起動前に確定する。
`--mcp-config` には JSON の文字列ではなく、権限 0600 のファイルのパスを渡す。
JSON には Bearer トークンが入るので、文字列で渡すと claude の argv に載り、同じ利用者の権限で動く任意のプロセスが `ps` から 64 桁を読めてしまう。
ファイルは `~/.agent-hangar/mcp/<sessionId>.json` に置き、run が終わったときに消す。
消し損ねたものは、次の起動と起動時の回復のときに、生きている run のぶんを残して落とす。
`--settings` には hook の設定（`provider/claude-code/launch/hookSettings.ts`）を書いた 0600 のファイルを渡し、`--mcp-config` の直後に置く。
中身は AskUserQuestion の前（`PreToolUse`）と後（`PostToolUse`、取り消しは `PostToolUseFailure`）の hook で、hangar の台本 `~/.agent-hangar/bin/hangar-hook.mjs`（`launch/hookScript.ts`）をサーバ自身の node で起こす。
shell を通さない exec の形（`command` に node、`args` に台本と MCP の設定ファイル）にして、Windows の PowerShell と Git Bash の引用の違いに左右されないようにする。
裏で走らせ（`async`）、問いの表示を待たせない。台本は失敗しても何も書かずに 0 で抜けるので、hangar が止まっている間も claude の画面に失敗が出ない（http の hook は失敗を画面に出すので使わない）。
鍵は設定に書かない。台本は MCP の設定ファイルから宛先と鍵を読み、標準入力をそのまま `/mcp/s/<sessionId>/hook` へ送る。
ファイルは MCP の設定と同じ後始末で消す（run の終わりと、起動のときの掃除）。書けなかったときは `--settings` を省いて起こす。
利用者の設定の `disableAllHooks` などで hook が走らないときは、問いの文は今までどおり本文から取る。
`--mcp-config` と `--add-dir` は可変長オプションで、直後の位置引数を飲み込む。
起動コマンドの組み立てでは、可変長オプションを他のオプションの前に置き、初期プロンプトは必ず末尾に置く（フェーズ 0 の検証で、逆順にすると初期プロンプトが設定ファイル名として解釈されて即時終了した）。
tmux で `claude` を直接起動すると異常終了時の出力が失われるので、薄いラッパースクリプトを介して起動し、終了コードと標準エラーをログに残してから tmux セッションを閉じる。
標準エラーを写す `tee` はプロセス置換の中で動き、ペインの先頭の bash が抜けるとカーネルから SIGHUP を受ける。
込んだ機械で `tee` が後回しになると、書きかけのまま落ちて終わり際の標準エラーが消えていたので、`tee` は SIGHUP を無視する形で起こし、bash は `tee` が書き終えるのを 2 秒まで待ってから `exit=` を書く。
2 秒で見切るのは、claude の残した子が標準エラーを握り続けても、ペインを閉じるためである。
包みの中身が変わったときはサーバの起動時に書き直すが、走っている run の bash は台本を読みながら進むので、その場で書き換えずに別のファイルから rename で入れ替える。
起動コマンドの `env` は、Claude Code が子に立てる印（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ID` など。一覧は `provider/claude-code/compat/childEnv.ts`）と、サーバが読み終えた hangar の受け渡しの変数（`HANGAR_PORT`、`HANGAR_PARENT_PID`、`HANGAR_UI_DIST`、`HANGAR_STOP_ON_STDIN_END`、`HANGAR_LAUNCHER`）と `HANGAR_CLOUD_DIR` を `-u` で外す。
Windows は名前を包みへ `HANGAR_UNSET_ENV` で渡し、包みが消してから claude を起こす。
tmux の新しいセッションは、`PATH` のほかは tmux サーバの全体の環境を継ぐ（`PATH` は下に書くとおり起こした側の値になる）。tmux サーバを Claude Code のセッションの中から起こしていると、全体の環境に別のセッションの印が残る。
印を持って始まった claude は、そのセッションの子として振る舞う（再開の一覧と履歴から外れる、裏のセッションと見なす、別のセッションの名前やソケットを使う）。
2026-10-08 に、利用者の既定の tmux サーバでこの状態を見つけた。
`HANGAR_HOME` は外さない。statusline の台本と `hangar` の CLI が、claude の中で置き場を知るのに読む。
`HANGAR_PORT` は外す。statusline の台本はポートを書き込み時に埋め、MCP の設定はファイルに URL を持ち、CLI は `--port` で決めるので、claude の中で読むものは無く、残すと claude の中で起こした試しのサーバがアプリのポートを使おうとする。
利用者が立てる設定（`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_EFFORT_LEVEL`、`ANTHROPIC_*` など）は外さない。
シェルタブも、同じ名前を `env -u` で外してからログインシェルを起こす。Windows の PowerShell の前には `env` を置けないので、Windows のシェルタブは外さない。
hangar のセッションでは `tmux set-option -t <name> status off` でステータス行を隠す。
新しいディレクトリで Claude を起動すると最初に信頼確認ダイアログが出るので、起動直後はターミナルを前面に出し、ダイアログが出ている旨を表示する。
node-pty の prebuild は補助バイナリ `spawn-helper` に実行権限が無い状態で展開されることがあるため、サーバの起動時に権限を確認して直し、spawn の失敗は捕まえて接続だけを閉じる。
tmux は `which tmux` で得た絶対パスを設定に保存して spawn する。
claude も同じく絶対パスで渡す。
`tmux new-session` に渡したコマンドは、tmux サーバのグローバル環境ではなく **tmux を spawn した側（hangar）の環境** を継ぐ。
`.app` を Finder から起こすと hangar の `PATH` は `/usr/bin:/bin:/usr/sbin:/sbin` だけになり、
`~/.local/bin` に入るネイティブ版の claude は裸の名前では引けない。
渡してしまうと応答は成功のまま、ペインの中で `command not found` の 127 で落ちるだけなので、
利用者はターミナルを開くまで理由が分からない（実際に 5 件の run がこれで落ちた）。
場所は `HANGAR_CLAUDE_BIN`、Settings の `claudePath`、`which('claude')` の順に決め、
どれでも決まらないときは tmux を起こす前に 400 で断る。
`which` は GUI 起動の貧弱な `PATH` を補うため、Homebrew に加えて `~/.local/bin` と `~/.claude/local` も見る。
`claudePath` は後から足した項目なので、`toolsResolved` では止めず、項目が無いうち（undefined）だけ埋める。
既に使っている `settings.json` には `toolsResolved: true` が入っており、一括で止めると永久に埋まらないからである。
デスクトップアプリ側も、サーバを起こすときの `PATH` に手元のツールの置き場所を足す。
これは念のための備えで、場所を決める正本はサーバ側にある。
新しいセッションのダイアログ（N2、`NewSessionDialog`）の主役は、開いた直後に焦点が入る大きな初期プロンプトの欄（150px から）である。
欄の下の 1 行に設定の札を並べる（`LaunchChips`）。
札はプロジェクト、アカウント（2 件以上あるときだけ）、モデル、effort レベル、権限モード、worktree の順で、最後に名前と追加ディレクトリを足す「＋」を置く。
どの札も値を常に見せ、押すと小さい一覧か入力欄が開く（`Popover`）。既定のままの札は薄い。
必須の選択は無い。プロジェクトを選ばなければ札は「クイックセッション」と言い、何も選ばずに ⌘↵ で始められる（起動は `scratch`）。
既定値は、空欄のまま起動の引数に含めず、利用者の Claude Code 設定に従う。
プロジェクトの札は検索欄つきの一覧（`Listbox`）を開く。先頭の「クイックスタート」の群にクイックセッションの行、続けて「最近」の 5 件と「すべて」の群を置き、行に状態の色の点と最後に使った時期を添える。下端は新しいフォルダと Finder の操作である。
モデルの一覧は、一覧に無い名前を打てる欄を添え、打つたびに値へ入れる（Enter を押さずに閉じても残る）。
アカウントの札は色の点と名前を見せ、一覧の行に色の点を添える。未ログインと初めてのログインの途中の行は選べず、理由を行に書く。
権限モードは縦の一覧にする。既定、Plan、Manual、Accept edits、Auto、Don't ask の順に並べ、線の下に Bypass permissions を赤い字と警告の印で置く。名前は日本語でも英語のまま出し、説明は添えない。前回の値の行には「前回」を添える。
Bypass permissions を選ぶと、札が赤い縁と警告の印になり、起動のボタンが赤い「Bypass permissions で起動」になる。確認のダイアログと注意の文は足さない。
名前と追加ディレクトリは「＋」から足す。足すと札が増えて入力欄が開き、一度出した札は値を消しても残す。値が入っているとき（下書き、前回の値）は、はじめから札を出す。

#### 始める場所：新しいフォルダと未登録のフォルダ

始める場所は、登録済みのプロジェクトとスクラッチのほかに、新しく作るフォルダと、まだプロジェクトでないフォルダも選べる。
選んだ場所は、起動と同時にプロジェクトになる。
作成と起動を 1 つのボタン（起動）にまとめるのは、このダイアログに来た利用者の目的がセッションを始めることで、プロジェクトを作るのは手段だからである。

未登録のフォルダ（`GET /api/workspace/dirs`）は、検索欄に語があるときだけ一覧に混ぜる。
何も打っていない一覧には出さない。
行はフォルダのアイコン、名前、パス、「未登録」の札である。
語はフォルダの名前にだけ当て、パスには当てない。
パスはどれもワークスペースのルートで始まるので、パスに当てると「work」のような語で全部が並ぶためである。
一覧の下端には、スクロールしても動かない操作の段を置く。
1 行目は、語が無ければ「新しいフォルダを作る…」である。
語があり、それと同じ名前のプロジェクトも未登録のフォルダも無ければ「『<語>』を新しいフォルダとして作る」にし、右に `~/workspace/<語>` を添える。
同じ名前があるときは「新しいフォルダを作る…」のままにする。
同じ名前には、アーカイブを含むプロジェクトのフォルダ名も数え、大文字と小文字の違いは無視する。
どちらもそのまま作ると 409 になるためである（APFS は大文字と小文字を区別しない）。
2 行目は「ほかの場所を選ぶ…（Finder）」で、殻の中だけに出す。
下端の操作は `role="listbox"` の要素の中の選択肢で、矢印キーで一覧の行の続きとして辿れ、Enter で選べる。
語が一致する行が無いときは、最初の操作に印を置き、そのまま Enter で選べるようにする。
下端の操作を持つ一覧は、プロジェクトが 8 件に満たなくても検索欄を常に出す。
語を打って新しいフォルダの名前にできるようにするためである。

選んだ場所によって、見出しと、札の列の下の 1 行が変わる。
ボタンはどれも「起動」のままで、見出しで何が起きるかを言う。クイックセッションは見出しを変えず、札の名前と下の説明で言う。

| 選んだもの | 見出し | 一覧の直下 |
|---|---|---|
| プロジェクト | 新しいセッション | なし |
| クイックセッション | 新しいセッション | 「プロジェクトを選ばないと、クイックセッション（日時の名前のディレクトリ）で始まります。あとでプロジェクトに昇格できます。」 |
| 新しいフォルダ | 新しいフォルダで始める | 「フォルダの名前」の欄（打った語を入れる）、「~/workspace/<名前> を作り、プロジェクトに登録して起動します」、git init のチェック（既定はオン） |
| 未登録のフォルダ | フォルダを登録して始める | 「~/workspace/<名前> はまだプロジェクトではありません。起動すると登録します」 |
| Finder で選んだフォルダ（ワークスペースの直下） | フォルダを登録して始める | 未登録のフォルダと同じ |
| Finder で選んだフォルダ（ワークスペースの外か深い階層） | フォルダを登録して始める | 「ワークスペースの外のフォルダです。この PC でのパスだけを覚えます。ほかの PC では、開いたときに場所を聞きます」 |

Finder で選んだパスが登録済みのプロジェクトのルートなら、そのプロジェクトを選んだ状態にする（見出しも「新しいセッション」）。
Finder を取り消したら、選択を変えない。
新しいフォルダと未登録のフォルダでは、札の値（モデルなど）の初期値は前回値が無いので既定である。

Finder のパスは、Store に入れる所（`store.ts` の `applyPickedFolder`）で NFC にそろえ、末尾の `/` を除く。
結果は Store の `pickedFolder { path, n }` に入れ、各ダイアログはマウントしたときより `n` が新しい選択だけを受け取る。
ダイアログを開く前の選択を拾い直さないためである。
2 つのダイアログのどちらを開いても、Mediator は未登録のフォルダの一覧を読ませる（`api.workspaceDirs`、`transition.ts` の 1 か所）。届いた一覧は Store の `workspaceDirs` に入る。

場所を指定した送信（`session.new.submit` の `place`）は、runtime が次の順に行う（`api.createProjectThenLaunch`）。

1. `POST /api/projects` で作るか登録する。失敗したら `launch.failed` を返して終える。プロジェクトはできていない。
2. できたプロジェクトを store に入れ、`project.created { projectId }` を Mediator へ送る。Mediator は送信中の状態に `createdProjectId` を持たせ、送った詳細をそのプロジェクトの前回値にする。
3. `projectId` を入れた params で、通常の起動と同じ起動をする。

2 の後に起動が失敗したら、プロジェクトは残し、失敗の状態も `createdProjectId` を持つ。
ダイアログはそれが変わったら選択をそのプロジェクトに合わせ、失敗の文言を出す。
押し直したときは、`place` を付けずに `projectId` で送るので、もう一度作ることはない。
`overlay.projectId` は書き換えない。
Root はダイアログを `overlay.projectId` を key にして描くので、書き換えるとダイアログが作り直され、名前と初期プロンプトの書きかけが消えるためである。

⌘Enter（Ctrl+Enter でも）は、ダイアログのどこからでも起動する。
初期プロンプトの欄では素の Enter が改行なので、欄の中から起動する手がこれになる。
起動ボタンの中に ⌘↵ のキー帽を置き、押す場所とキーが一緒に目に入るようにする（読み上げの名前は「起動」のままで、`aria-keyshortcuts` を添える）。

名前、初期プロンプト、添付の書きかけは、どの経路で閉じても（キャンセル、×、Esc）下書きとして残す。
ダイアログは閉じるときに書きかけを `session.new.draft` で送り、打鍵のたびには送らない（送るたびに画面全体を描き直すことになるため）。
下書きはプロジェクトごとではなく 1 つだけ持つ。
添付の配列が無い保存（添付を足す前の形）は、形が違うものとして読み戻さない。
次に開くと、名前、初期プロンプト、添付に戻し、見出しの右に「下書き」の札と「破棄」を出す。名前が入っていれば、名前の札をはじめから出す。
「破棄」は欄を空にし、下書きも消して、初期プロンプトの欄へ焦点を戻す。
ダイアログから起動し終えたら、下書きは役目を終えたので Mediator が消す。
送った後に Esc などでダイアログを閉じても起動は続くので、送った印（`newSessionSent`）を持ち、閉じた後に起動し終えても消す。
起動に失敗したら下書きは残し、印だけ外す。

モデル、effort レベル、権限モード、追加ディレクトリは、選んだプロジェクトで前回起動したときの値を札の初期値にする。何も選ばないクイックセッションも、その前回値を使う。
worktree は残さない。同じ名前が毎回初期値に入ると、前の worktree の中で起動してしまうからである。
前回値は送った時点で残す（起動に失敗しても、選んだ詳細は利用者の意図なので残す）。
既定のまま起動したら、そのプロジェクトの前回値を消す。
前回値のままなら（既定だけの前回値には出さない）、札の列の下に「前回と同じ」の札と「<場所の名前> で最後に起動したときの設定です」を出し、右端に「既定に戻す」を置く。
「既定に戻す」は札の値を全部既定に戻し、この行を外す。
値を 1 つでも替えると、この行を外す。
札に触れる前にプロジェクトを選び直したら、そのプロジェクトの前回値に入れ替える。
触れた後は、自分で選んだ値を残す。
権限モードの一覧では、前回の値の行に「前回」を添える。

添付があるとき、添付の置き場を claude に渡す `--add-dir` はサーバが足す（上の初期プロンプトの欄の節）。ダイアログは起動の `addDirs` に置き場を混ぜず、利用者が「追加ディレクトリ」の札に書いたものだけを渡す。
起動の params（アカウント、権限モード、モデル、effort、worktree、名前、追加ディレクトリ、添付を足した初期プロンプト）は、札の列に替えても同じものを載せる。
Mediator の `focus` の対象 `newSessionName` は、いまは初期プロンプトの欄（id `new-session-prompt`）を指す。

プロジェクトを選ばずに起動を押したときの「プロジェクトを選んでください」は、プロジェクトを選び直したら消す。
送り直して同じ失敗が返れば、また出す。

#### 初期プロンプトの欄

初期プロンプトの欄（`PromptComposer`）は、Claude Code の入力欄でできる主なことを受ける。
起動引数の末尾に置く初期プロンプトは、`/スキル`、`@ファイル`、画像のパスをそのまま解釈する（実物で確かめた）。
欄はそれを書きやすくするだけで、起動の API（`POST /api/runs`）と MCP の `create_session` は変えない。

- 先頭の `/` で、スキルとコマンドの候補を出す。自分のもの、選んだプロジェクトのもの、有効なプラグインのもの、組み込みのうち最初の一言になる 6 つ（`init`、`review`、`code-review`、`security-review`、`loop`、`schedule`）である。会話の途中でしか意味がないもの、端末の設定のもの、ダイアログの詳細に欄がある `model` と `effort`、`user-invocable: false` のスキルは出さない。
- 打つ前は、最初の一言になった回数の多い 5 つを「よく使う」として先頭に置き、続けて「このプロジェクト」「自分の」「プラグイン」「組み込み」の群で並べる。打ち始めたら群を解き、名前の頭の一致、途中の一致、説明の一致の順に並べる。
- `@` は欄の先頭か空白の直後で、選んだプロジェクトのファイルの候補を出す。打つ前は最近変えたファイル 20 件、打ったら一致するものを 50 件まで。スクラッチとパスの無いプロジェクトでは使えず、ボタンも押せない。
- 候補は、先頭の語に 2 つ目の `/` が入ったら出さない（貼ったパスの下に出しても邪魔なため）。確定はきっかけからカーソルまでを置き換え、カーソルの後ろの文は消さない。空白を含むファイルは `@"パス"` の形で入れる。
- 候補が開いている間、↑↓ で選び、Enter か Tab で確定し、Esc は候補だけを閉じる。変換中（IME）の Enter と Esc はダイアログに届かせない。候補が閉じている間の Enter は改行、⌘Enter は起動のままである。
- 画像とファイルは、貼り付け、欄へのドロップ、添付ボタンで付け、欄の下に札で並べる。`~/.agent-hangar/drops/`（端末へのドロップと同じ置き場）に置き、1 件 20 MB まで、7 日で消える。
- 起動のとき、本文の後に空行を置き、添付のパスを 1 行ずつ足した 1 つの文にして渡す。本文が空で添付だけでも起動できる。
- 初期プロンプトに添付のパスの行があるときは、サーバが置き場を `--add-dir` で claude に渡す。MCP の `create_session` で起動したセッションも、同じ起動の処理を通るので、同じに渡す。置き場はプロジェクトの作業ディレクトリの外にあり、渡さないと Claude Code は読む前に許可を尋ねて止まるためである。そのセッションは、置き場の全体（7 日分の添付。ほかのプロジェクトのために置いたものも含む）を、尋ねられずに読み書きできる。判定は「置き場の直下のファイルのパスだけの行」があるかで、文の途中に書かれたパスでは足さない。Windows の置き場（`\` を含むもの）では、`\` と `/` のどちらも区切りとして読む。起動の API は変えず、画面が覚える起動の設定にも、足した置き場は混ざらない。
- 貼り付けたものにファイルと文字が一緒にあるとき（表計算や文書ソフトからのコピーは、セルの絵と文字を同時に置く）は、ファイルを添付にし、文字も欄に貼る。文字がファイル名だけの行（Finder でファイルをコピーしたとき）なら、文字は貼らない。ファイルだけなら添付にして、文字だけなら欄に任せる。
- 添付を送っている間は、「送っています」の札を出し、起動ボタンを押せなくして（⌘Enter も起動しない）添付が抜けたまま起動しないようにする。送信は 60 秒で打ち切り、失敗として知らせる。
- ダイアログを閉じた後に送り終えたものは、起動を送っていなければ、着いた添付だけを `session.new.draft.attach` でいまの下書きへ足す。閉じるときの名前と本文で下書きを置き換えると、開き直したダイアログの書きかけを上書きしたり、起動して消えた下書きを蘇らせたりするためである。
- `@` の候補が、いまの問いの返事をまだ受けていない間（前の問いの一覧を薄く残している間、または最初の読み込み中）は、Enter と Tab は何も入れず、改行にもならない。ここで通すと Enter が改行になり、`@` の語がそこで終わるためである。矢印と ⌘Enter は通す。
- ブラウザでは、欄を少し外してファイルを落としてもページがそのファイルへ移らないよう、部品がある間は窓全体でファイルのドラッグと落とす動きの既定の動きだけを止める（欄の外では何も添付しない）。
- 下書きの添付は、開いたときに置き場から消えたものを外す。
- Hangar.app では、Web 側にドラッグのイベントが届かないので、殻が `hangar:drag` で位置を送り、欄が上にあれば色を変える。落とした位置が欄なら添付に、端末なら今までどおりパスの貼り付けにする。ブラウザでは Web のドラッグのイベントを使う。
- 端末へ貼り付けるパスと、初期プロンプトに足す添付のパスは、同じ規則で引用符に包む（`runtime/fileDrop.ts` の `quotePath`）。
  macOS と Linux のパスは、POSIX のシェルの単引用符で包む。
  Windows のパスは、psmux のペインで動く claude と PowerShell（シェルタブは `powershell.exe`、psmux の既定のシェルも PowerShell）に向けて、二重引用符で包む。
  Windows の名前に `"` は使えないので、中を逃がさずに済み、cmd でも同じに読める。
  ただし PowerShell は二重引用符の中の `$` と `` ` `` を展開するので、それを含むパスだけは単引用符で包み、中の単引用符を 2 つにする。
  サーバの添付の判定（`promptMentionsDrops`）は、単引用符と二重引用符のどちらで包んだ行も読む。

欄の部品は View なので API を呼ばない。
候補と添付の読み書きは、`ResolveProjectDialog` の候補と同じく、Root が api を呼び、`PromptAssistContext` で配る。
UiAction で運ぶのは下書き（`session.new.draft` と、遅れて着いた添付を足す `session.new.draft.attach`）だけである。
サーバの口は「初期プロンプトの欄の口」の節に置く。

### 実行中の状態

サーバは `~/.claude/sessions/` を監視し、run と結びつける。
結びつけの鍵はセッション UUID である。
`status` は busy、idle、waiting の 3 値で、waiting は AskUserQuestion などで利用者の入力を待っている状態である。
UI の状態点はこの 3 値をそのまま使い、waiting は入力待ちの知らせ（「入力待ちの知らせ」の節）の対象にする。
Claude はもう 1 つ `shell` を書く。本体は休みで、裏の Bash（`run_in_background`）だけが動いている状態である。
hangar はこれを busy のまま読み、裏だけ動いている印（`aside: { shell: true, agents: 0 }`）を付ける。
busy のままにするのは、Claude 自身も裏でサブエージェントが動く間は本体が空いていても busy と書くからで、自動の停止（休みだけを止める）、外のセッションの引き取りの断り、停止の確認がそのまま働く。
印が変えるのは見せ方だけである。
状態点は薄いオレンジ（`--aside`）で静かに置く。サイドバーの行には語を添えない。
端末の縁は呼吸をやめて薄いオレンジの輪にし、ホームの引き出しの行は「バックグラウンドでシェル。指揮役は入力を受け付けている」と言う。
見出しの語は「バックグラウンドで作業中」（Claude Code の background に合わせる）で、長さは休みと同じく最後の動きから数える。
停止の確認は「バックグラウンドの作業も終わる」と言う。
裏でサブエージェントだけが動いている場合は、登録が busy としか書かないので、サーバが本文から推す（`live/aside.ts`）。
登録の読み直しのたびに、busy のもののうち次のすべてを満たすものへ `aside: { shell: false, agents }` を付ける。
主線の最後のターンが終わっている（`turn_duration` の後に、指示、バックグラウンドのタスクの知らせ、返答、手が無い）。
その終わりが、登録の `statusUpdatedAt`（動きが最後に変わった時刻）より後である。新しい指示を送った直後は、指示がまだ索引に載っていないことがあるので、これで見分ける。
終わってから 2 秒経っている。裏の無いターンでも、終わりが書かれてから登録が休みへ移るまで少しかかるので、その間に灯らないようにする。
`agents` は、ライブの要約（digest）で running のサブエージェントの数で、「バックグラウンドで N 本」と出す。
数えられないとき（workflow など）は 0 で、「バックグラウンドで作業中」と言う。
プロンプト送信から busy まで約 0.5 秒、終了からファイルの消失まで約 0.4 秒で、500 ミリ秒間隔の監視で足りる。
`-n` や `/rename` で付けた名前は本文にも記録として残り（`agent-name`、`custom-title`）、再開やフォークの先にも引き継がれる。
hangar は名前を本文の記録から読み（索引が `sessions.custom_title` に拾う）、レジストリの値で上書きする。
tmux セッションが消えたら run を終了とみなし、`end_reason` を記録する。

UI のターミナルは xterm.js で、サーバ側の node-pty が `tmux attach -t <tmux_name>` を実行して入出力を中継する。
リサイズは xterm.js の寸法を PTY に伝える。
Windows で pty を閉じるとき、node-pty は子のコンソールの一覧を取る補助のプロセスを起こしてから pseudoconsole を閉じるので、補助が「AttachConsole failed」を標準エラー（サーバのログ）へ出すことがある。
そこで Windows では pty の kill を直には呼ばず、子の `tmux attach` のプロセスだけを終わらせて、node-pty が終了を見て後始末をするのを待つ（`pty/close.ts`）。
5 秒待っても終わらなければ、元の kill に落とす（node-pty は子が終わってから終了を伝えるまでに 1 秒以上かかることがある）。終わっている pty は閉じ直さない。

ターミナルの打鍵と写しは次のようにする。

- Shift+Enter は ESC CR（`\x1b\r`）を送り、Claude Code では送信ではなく改行になる。
  Claude Code の /terminal-setup が VS Code の Shift+Enter に書き込む列と同じで、tmux の extended-keys の設定によらず中のアプリへ届く。
  zsh の emacs キーマップでも実行されずに改行が入る。
  日本語の変換中は横取りしない。
- Option を押しながらドラッグすると、tmux や Claude Code がマウスを取っていても文字を選べる（`macOptionClickForcesSelection`）。
  Option を押した短いクリックでカーソルを動かす機能（`altClickMovesCursor`）は切る。
  Claude Code の入力欄では矢印の列が履歴の呼び出しになり、書きかけの指示が入れ替わるからである。
  `macOptionIsMeta` は偽のままにして、Option で打つ記号（JIS 配列の Option+¥ など）を残す。
- 端末の中のアプリが OSC 52 で写したものは、`@xterm/addon-clipboard` で受けてクリップボードへ書く。
  読み出しの要求には空で答える（端末の中のどのプログラムでもクリップボードを読めてしまうため）。
  tmux が OSC 52 を外へ通すように、サーバは attach の前に `set-clipboard` が on でも off でもなければ `set-option -s set-clipboard on` にする。
  この設定は利用者の既定の tmux サーバ全体に効くが、利用者の決定（2026-10-01）でそのままにした。
  WKWebView ではクリップボードへの書き込みに利用者の操作から 5 秒の枠があり、その外で届いた写しは捨てられる。
- ⌘+ と ⌘− と ⌘0 はターミナルの文字の大きさを 1px ずつ変える（既定 13、8 から 32）。
  全部のタブに効かせて寸法を合わせ直し、大きさは localStorage に覚える。
  ターミナルが画面に無いときは受けず、ブラウザの拡大に渡す。
  セッション画面でも、終わったセッションの本文だけでターミナルが無ければ同じである。
複数のクライアントが同じ tmux セッションに attach してよい。

### セッション内タブ

セッション画面のタブ 0 は Claude が動く tmux セッションである。
「＋」で追加する各タブは、同じ cwd で利用者のログインシェルを起こした独立の tmux セッション（`hangar-<runShort>-t<n>`）である。
tmux の window ではなく別セッションにするのは、同じ tmux セッションに複数のクライアントが attach すると「現在の window」を共有してしまい、ブラウザの 2 つのタブが互いに切り替わってしまうからである。
シェルタブは Claude が終了しても残り、明示的に閉じるか run を片付けるときに閉じる。
「ターミナルで開く」はタブ単位である。
既定は `tmux attach` を書いた `.command` ファイルを `open -a Terminal` で開く経路で、AppleEvent を使わないため macOS の自動化許可が要らない。
ディレクトリを開くときの既定の shell の決め方（`${SHELL:-/bin/zsh}` を `-l` で起こす）は、`.command` の経路と iTerm2 の経路で同じにする。
iTerm2 を使う設定にしたときは AppleScript で新規ウィンドウを開く。初回に macOS の自動化許可ダイアログが出るので、Settings で有効化したときに一度だけ案内し、Tauri の Info.plist に `NSAppleEventsUsageDescription` を入れる。AppleScript には 10 秒のタイムアウトを付け、失敗したら Terminal.app の経路に落とす。
Windows では、選べるターミナルが「Windows Terminal」と「既定のターミナル」の 2 つになる（`TerminalApp` の `windowsTerminal` と `windowsDefault`）。
設定画面は、画面を開いている OS の選択肢だけを同じ切り替えの部品に並べ、サーバも動いている OS の値だけを保存する。
別の OS で保存した値（macOS の iTerm2 を Windows で読んだときなど）は、読み込むときにその OS の既定（macOS は Terminal.app、Windows は Windows Terminal）に読み替える。
Windows Terminal は `wt.exe -w 0 new-tab --title <題名> --suppressApplicationTitle -- <psmux> attach -t =<名前>` で、直近の窓の新しいタブ（窓が無ければ新しい窓）に開く。
wt は `;` を次のコマンドの区切りに読むので、引数の `;` は `\;` にして渡す。
`wt.exe` を起こせなければ、既定のターミナルに落とし、落ちたことを知らせる。
既定のターミナルは `cmd.exe /d /v:off /s /c "start "<題名>" "<psmux>" attach -t "=<名前>""` で、Windows の設定の「既定のターミナル アプリ」の新しい窓に開く。
この 1 行は Node に引用させずにそのまま渡す（Node の `\"` は cmd.exe に通じない）。
cmd.exe は引用符の中でも `%name%` を置き換えるので、`%` だけは引用の外へ出して `^%` にする。
`"` と改行を含む名前とパスは、どちらの経路でも引用を破るので、開かずに断る。
題名を付けないと、タブも窓も起こした実行ファイル（psmux）のフルパスが題名になる。
題名はセッション名（シェルタブは名前の後ろに `(シェル 1)` のようなタブの題名を添える）で、80 字までに切り、`"` は `'` に、改行と制御文字は空白に潰す（名前は利用者が付けるので、断らない）。名前が無ければ tmux の名前にする。
ディレクトリを開くときは、Windows Terminal は `new-tab --title <題名> --suppressApplicationTitle -d <dir>` で既定のプロファイルを、既定のターミナルは `start "<題名>" /D "<dir>" powershell.exe -NoLogo` で PowerShell を開く（題名はフォルダ名）。
`.app`（Windows の殻）から起こしたサーバでは、ターミナルもエディタもブラウザも殻の起こし役越しに起こし、Hangar を閉じても開いた窓は残る（「Tauri のシェル」の節）。

### 指示の注入

hangar が起動するセッションには、`--append-system-prompt` で短い指示を渡す。
ファイルや設定は書かず、モデルや effort は現在の設定のままである。
指示の内容は次の要素からテンプレートで生成する。

```
あなたは agent-hangar から起動されたセッションです。
プロジェクト：<name>（<path>）
プロジェクトのメモの要約：<memo の先頭 500 字>
未完の TODO：<最大 10 件、各行 - [<id>] <本文>>
過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。
依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、
set_session_summary で題名、2〜3 文の要約、状態、次の一手を更新してください。
TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。
完了にするのは利用者です。確かめられていないものは出さないでください。
頼まれたことを終えたと判断したターンの終わりに、AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <戻る日。時刻に意味があれば時刻も>（何を確かめに戻るか）」「まだ続ける」です。
利用者が Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。
Paused の戻る日は return_on（YYYY-MM-DD）に、確かめる時刻が決まっているときは return_time（HH:MM、手元の時刻）にも渡してください。時刻を note の文だけに書かないでください。
途中のターンでは聞かないでください。
ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。
Bash と Agent の description は日本語で 20 字以内にしてください。
```

MCP の URL はセッション別（`/mcp/s/<sessionId>`）なので、ツールは呼び出し元のセッションをサーバ側で確定できる。
モデルにセッション ID を扱わせる必要はない。

Paused の戻る時点は、日付（`return_on`、YYYY-MM-DD）と、任意の時刻（`return_time`、HH:MM）で持つ。
どちらも手元の暦と時計で読み、時刻が無ければ「その日のうち」として扱う。
時刻を日付と別の列にしたのは、上げていない PC が同期で受け取ったときに、知らない列として捨てるだけで日付をそのまま読めるようにするためである。
`propose_session_status` は過去の時点を断り、返す状態にオフセット付きの `returnAt`（`2026-10-05T13:30+09:00`）を添えて、どのゾーンで読んだかを残す。
過去を断るのは MCP の入口だけで、画面からの確定と同期では断らない（時刻を過ぎた提案を確定でき、届いた行を弾かないため）。
持つ時点は 1 つだけである。同じ日に 2 回確かめたいときは、戻って resume したときに状態が外れ、区切りの問いで次の時点を入れる。
時刻つきの Paused は、当日は朝から「今日戻る」に出し、時刻を過ぎてから札を塗る。同じ日の中は時刻の早い順で、時刻なしはその日の最後に並べる。
時刻を過ぎたら、通知を受け取る設定で窓が背面なら OS の通知を 1 回出す。右下の札は出さない。ベルの一覧には、今日戻るの行が朝から事実として出る（「ベルと知らせの出し分け」の節）。OS の通知で知らせ終えた時点は localStorage に覚える（画面の時計で見るので、hangar を開いていない間は出ない。開いたときに、その日に過ぎた分を 1 回知らせる）。
日付だけの Paused は知らせない。

状態の問いは、依頼を終えた区切りでだけ AskUserQuestion で聞かせる。利用者が選んだものは `propose_session_status` の `confirmed: true` でそのまま状態になり、答えずに進めたものは候補として残る。
この指示は hangar が `--append-system-prompt` で起こす会話に渡る。ターミナルで claude.zsh から起動した claude も hangar の run になるので、同じ指示を受け取る。
`claude attach` で開く会話（attach、バックグラウンドのセッションの再開）には渡らないので、そちらは事後の要約で拾う。

### 再開とフォーク

過去のセッションは「再開」と「フォーク」を持つ。
再開は同じ cwd で `claude -r <uuid>` を tmux 上で実行し、`kind = 'resume'` の run を作る。
フォークは `claude -r <uuid> --fork-session --session-id <新 uuid>` で、新しいセッション行と `kind = 'fork'` の run を作る。
同じセッションに生きた run があるときは、再開を無効にする。

### スクラッチと昇格

リポジトリ名を決める前に使い捨てのセッションを回したい、という用途のために **スクラッチ** を用意する。
「クイックセッションを開始」は `~/.agent-hangar/scratch/<yyyymmdd-HHmmss>/` を作り、そこを cwd にセッションを起動する。
起動ダイアログのプロジェクトの一覧は、先頭の「クイックスタート」の群にクイックセッション（スクラッチ）の行を置く。何も選ばなければ、この行を選んだことになる。
⌘⇧N、パレット、スクラッチのプロジェクト画面は、この行を選んだ状態でダイアログを開く。
スクラッチの詳細の前回値は、どのスクラッチのディレクトリでも共通の 1 枠に持つ。
スクラッチのセッションは `is_scratch = 1` の擬似プロジェクトに属する。
この擬似プロジェクトは端末ごとに 1 つで、どのスクラッチのディレクトリで起動したセッションもすべてここに属する。

セッション画面の「プロジェクトに昇格」は、名前と、何が起きるかを添えた 2 つの選択（`git init` するか、ファイルを移すか）を受け取って次を行う。

1. `<workspaceRoot>/<name>` を作り、`git init` が選ばれていれば実行する。
2. 新しいプロジェクト行と、この端末の `project_roots` を作る。
3. セッションの `project_id` を新プロジェクトに変える。
4. セッションの run がすべて終了していれば、スクラッチ内のファイルを新ディレクトリへ移動する。run が生きていれば移動はせず、その旨を表示する。
5. 「この場所で新しいセッションを開始」を提案する。

run が生きている間はファイルを移さず、`moved: false` と理由を返す。
移動の途中で失敗したら、そこまでに移したものを逆順に戻してから理由を返す。
cwd の実体がスクラッチの外を指すシンボリックリンクのときも移さない。

本文ファイルの cwd は変わらないので、昇格後にこのセッションを再開すると cwd はスクラッチのままである。
再開ボタンにはその注意を添える。

## セッション要約

一覧とヘッダーに「このセッションは何をしていたか」を出すために、**セッション要約** を持つ。
要約は題名、1 文、2〜3 文の本文、見立て（`in_progress`、`done`、`blocked`、`abandoned`）、次の一手から成る。
見立ては、Claude が要約を書いた時点でその仕事がどこまで進んだかを表し、画面では「やりかけ」「済んだ」「詰まっている」「やめた」と出す。
セッションのプロセスが生きているか（実行中、終了）とは別物なので、それと重ならない語にしている。
閉じているときは題名と 1 文だけを出し、ヘッダーのパネルを開くと全部を出す。

要約は三つの経路で作る。

- **土台**：インデクサが `ai-title`、最初と最後のプロンプト、触ったファイル、ターン数、期間から機械的に作る。全セッションに即時にあり、`source = 'baseline'` で保存する。
- **セッション自身**：hangar が起動したセッションは、注入した指示に従って節目に `set_session_summary` を呼ぶ。文脈を持っているので最も正確で、追加コストがない。`source = 'in_session'`。
- **事後生成**：run 終了時に要約が土台のままか、最後の更新から 5 ターン以上進んでいれば、要約器で作り直す。セッションを開いたときも同じ条件で作る。`source = 'post_hoc'`。

事後生成のスキーマは、要約に加えてセッションの状態の提案（`proposed_status` が done・paused・none、`proposed_note`、`proposed_return_in_days` が paused のとき 1〜14）を返させる。
提案は、要約を書いた直後に、状態も提案も無く、却下もされておらず、セッションが止まっているときだけ `source = 'post_hoc'` の候補として書く。戻る日は書いたときの手元の暦から数える。
読み取りは提案の 3 つを任意として扱い、返さないモデルでも要約は従来どおり書く。

要約には、どの経路で作ったか（`source`）に加えて、どの要約器が書いたか（`source_id`）とそのモデルの名前（`source_model`）を持つ。
土台とセッション自身の要約は要約器を通さないので、どちらも持たない。
`source_id` が無かった頃の行は、種類を推し量らずに「不明」と出す。

過去の全件を背景で埋めることはしない。

事後生成の契機は、run が終わったときと、セッション画面を開いて先頭ページを読んだときの 2 つである。
run の終了からの契機だけは、レジストリの生存判定を飛ばす。
セッションの生存を 500 ミリ秒周期のキャッシュで見ているため、止めた直後はまだ「実行中」と判定されてしまうからである。
飛ばすのは生存判定だけで、土台のままか 5 ターン以上進んだかの判定は残る。
要約器は LM Studio を先に試し、使えないときだけ `claude -p` に切り替える。
切り替えは 1 時間あたりの件数（既定 20、1 から 200 まで）と週の枠の使用率 80% で止め、`claude` が PATH に無ければ使わない。

要約器は差し替え可能な部品にする。

```ts
interface Summarizer {
  readonly id: 'lmstudio' | 'claude-headless';
  available(): Promise<boolean>;
  summarize(input: SummaryInput): Promise<SessionSummary>;
}
```

既定は LM Studio である。
OpenAI 互換の `http://127.0.0.1:1234/v1/chat/completions` に、JSON スキーマ付きで投げる。
モデル名は Settings で選ぶ。
既定のモデルは思考を行わない指示追従モデル（フェーズ 0 では gemma 26B が 1 件 6〜7 秒で安定した）にする。
思考モデルは既定の出力上限を思考で使い切って本文が空になることがあるので、本文が空なら失敗として扱い、フォールバックへ回す。
初回のモデル読み込みに 1 分近くかかるため、Settings に「要約器を試す」を置いて事前に温められるようにする。
見立ての判定基準（最後のターンが利用者への問いなら `in_progress`）はプロンプトに明示する。

要約器には会話の本文（利用者の発言とアシスタントの応答）がそのまま送られる。
そこで宛先は既定でループバックだけに閉じ、`127.0.0.1`、`localhost`、`::1` 以外のホストは 400 で断る。
設定の「外部の要約器を許す」を入れたときだけ、外の宛先を受け付ける。
スイッチの下には「127.0.0.1 と localhost 以外の宛先へ本文を送れるようにします。」と淡い 1 行で添える。
許しと宛先は同じ要求の中で突き合わせるので、片方ずつ変えて素通りさせることはできない。
この印を入れている間は、Settings に「会話の本文がこの宛先へ送られます」という警告を出し、宛先の URL を添える。
設定ファイルを手で書き換えて外の宛先を入れても、読み込みのときに既定へ戻す。

要約器への問い合わせはリダイレクトを追わない（`redirect: 'manual'`）。
追うと、ループバックだと思って許した宛先が 302 を返すだけで、会話の本文が外のホストへ送られてしまう。
宛先の検査は最初の URL にしか効かないので、追わないことでしか塞げない。
3xx が返ったときは失敗として扱い、次の要約器へ回す。
モデル一覧の問い合わせも同じで、リダイレクトが返れば一覧は空として扱う。

LM Studio に繋がらないときは `claude -p --model haiku --output-format json --json-schema <schema>` に切り替える。
こちらはサブスクリプションのレート制限を消費するので、1 時間 20 件までとし、週の枠の使用率が 80% を超えたら止める。
結果は出力 JSON の `structured_output` から読む。入力はパイプで渡し、渡すものが無いときは `< /dev/null` を付けて標準入力の待ちを避ける。
Haiku でも思考が走り 20〜40 秒かかるため、事後生成は背景ジョブにして UI には「要約を作成中」を出す。

入力は、利用者の発言を全文（1 件 2,000 字まで）、アシスタントの本文を各 600 字まで、ツール呼び出しを 1 行ずつにして、全体をおよそ 8,000 トークン相当（日本語で 12,000 字前後）に収める。
超えるときは中盤を間引き、最初と最後を残す。

## MCP とローカル API

### HTTP の経路の置き方

HTTP の層は `packages/server/src/http/` にある。

- `app.ts`：組み立て。`createApp` は `/health` を置き、`/api` の下に認証（`auth.ts`）を当て、経路のファイルを登録し、`/mcp` と UI の配りを載せる。経路の中身は持たない。
- `deps.ts`：HTTP の層が外から受け取る依存の一覧（`AppDeps`）と、その口の型（`RunsApi`、`SyncApi` など）。
- `routes/*.ts`：経路。1 ファイルに 1 つの資源を置く。
- `routes/common.ts`：経路が共通で使う補助。本文の読み方と大きさの上限、失敗の包み方（`runResult`、`externalResult`）、依存から組む小さな読み手である。
- `accounts.ts`：アカウントの経路。サーバの起動後の読み直しも同じ依存を使うので、`routes/` の外に置いてある。
- `testing.ts`：試験の組み立て。`testDeps()` が `AppDeps` を試験用の既定で全部組む。

経路のファイルと、持っている資源は次のとおりである。

| ファイル | 資源 |
| --- | --- |
| `bootstrap.ts` | 起動時の取得（`/bootstrap`） |
| `sessions.ts` | セッションの一覧と 1 件、本文、サブエージェント、変更したファイル、検索、1 行メモ、状態、昇格、事後要約 |
| `runs.ts` | run の起動と停止、タブ、指示へ跳ぶ、セッションから run を起こす口（resume、fork、attach、adopt、resume-here） |
| `projects.ts` | プロジェクトの一覧と 1 件、状態、置き場の選び直し、作成と登録 |
| `todos.ts` | TODO |
| `memos.ts` | プロジェクトのメモ |
| `artifacts.ts` | アーティファクト |
| `prompt.ts` | 初期プロンプト欄の候補と添付（`/prompt`、`/drops`） |
| `settings.ts` | 設定 |
| `retention.ts` | Claude Code の保持期間 |
| `sync.ts` | 同期の状態と操作、端末の一覧、クラウドの使用量、設定の同期（`/config-sync/*`。旧実装の `/sync/config/*` は段 4 の PR 18 で消した） |
| `usage.ts` | statusline の受け口と使用量 |
| `system.ts` | 索引の作り直し、準備の確かめ、互換、要約器 |

依存の渡し方は次のとおりである。

- 各ファイルは `xxxRoutes(api, deps)` の形の関数を 1 つ出し、渡された `/api` の Hono に経路を足す。
- `deps` の型は、`AppDeps` から自分が使う項目だけを `Pick` した狭い型である（例：`RetentionRouteDeps` は `retention` の 1 項目）。そのファイルが何に触れるかが、型で読める。
- `createApp` は `AppDeps` をそのまま各関数へ渡す。狭い型への絞り込みは型の上だけで、束を組み替えない。
- 依存を足すときは、`deps.ts` の `AppDeps` に 1 項目を足し、使うファイルの `Pick` に名前を足す。

同じメソッドで同じパスに当たる経路の組は作らない。
そのため、経路の当たり方は登録の順に依らない。
順が効くのは、`/api` の先頭に置く認証と、`/api` と `/mcp` の後に置く UI の配り（`/` と `/assets/*`）だけである。

試験は経路のファイルの隣（`routes/*.test.ts`）に置き、`testDeps()` で依存を組んで `createApp` を通して叩く。
`app.test.ts` には、組み立て全体を見る試験（認証、本文の検査、MCP と UI の配り、アカウントの取り付け）だけを残す。

### 認証

サーバは 127.0.0.1 にだけバインドする。
API と MCP は、`~/.agent-hangar/token`（権限 0600）に置いたローカルトークンを Bearer で要求する。

#### 鍵付きの入口

UI を初めて開くときは、鍵を載せた入口の URL を使う。
`hangar start` は起動のたびに `http://127.0.0.1:4177/?t=<トークン>` を印字し、`--no-open` を渡していなければ既定のブラウザでそれを開く。
`hangar open` も同じ URL を印字してから開く。
ただし `hangar open` は、開く前に `/health` を見て、サーバが動いていなければ開かずに終了コード 1 で終わる。
`hangar url` は同じ URL を印字するだけで、ブラウザは開かない。
起動の後に鍵付きの URL を見直す道はこれだけで、401 の案内もこのコマンドを指す。
鍵を端末にだけ印字するのは、サーバのログに載せないためである。
`hangar start` が待ち受けに失敗したときは、生のスタックではなく日本語の 1 行を出して終了コード 1 で終わる。
使用中のポート、権限の無いポート、そのほかの失敗を、それぞれ次の一手の分かる文にする。
サーバは子プロセスなので、`hangar start` は子を起こす前にそのポートを自分で一度開いて確かめ、失敗をこの 1 行にする。
`--port` は 1 から 65535 の整数に限り、0 は断る。
0 を渡すと子は空いているポートを自分で選ぶが、CLI はその番号を知る手が無いためである。
設定の破損やデータベースの失敗など、そのほかの起動の失敗では、子が自分のログを出し、続けて CLI が 1 行を出し、`hangar start` は URL を印字せずに子の終了コードで終わる。
起動の途中で利用者が止めたとき（Ctrl-C や kill）は、この 1 行も URL も出さない。

`GET /` は、クエリの `t` か、既に持っているクッキーのどちらかが合うときだけ UI の HTML を配る。
合わないときは案内だけを書いた HTML を 401 で返し、トークンは配らない。
鍵の無い `GET /` にクッキーを配ると、`curl` 1 本で誰でもトークンを取れてしまうためである。
配るときに同じトークンを `HttpOnly`、`SameSite=Strict`、`Path=/`、有効期間 1 年のクッキーとして発行する。
UI は `history.replaceState` で URL から `?t=` を消すので、鍵はアドレス欄に残らない。
以後はブックマークから鍵無しで開ける。

`GET /` の応答には、鍵の有無に関わらず `X-Frame-Options: DENY` と CSP を付ける。
`SameSite=Strict` の「サイト」はポートを数えないので、手元の別のポートに置かれたページに枠で嵌められると、クッキーの載った UI を被せて押させる手が成り立つ。
枠を止めるために `frame-ancestors 'none'` と `X-Frame-Options` の両方を返す。
CSP の残りは配っている `dist` の作りに合わせて絞る。
インライン script は無いので `script-src 'self'` だけでよく、style は React の style 属性と xterm が実行時に書くので `'unsafe-inline'` が要る。
font は `@fontsource` の woff のために `data:` を許す。
img もサイドバーのロゴのために `data:` を許す。
ロゴの原図（`packages/ui/src/brand/logo.svg`）は Vite がインライン化する上限より小さいので、ビルドで data URI として JS に埋め込まれるからである。
favicon は `/assets/` に別のファイルとして出るので、`data:` を使わない。
img の `data:` を外すと、サイドバーのロゴが描かれなくなる。
`connect-src` は同じ元と、ターミナルの WebSocket のためのループバックだけにする。
`object-src 'none'`、`base-uri 'none'`、`form-action 'self'` も付ける。

#### 入口の 3 つの検査

`/api` 配下は、トークンの照合に加えて次の 3 つを見る。

- **Origin**：待ち受けているポートから組み立てた `http://127.0.0.1:<port>` と `http://localhost:<port>`、それに `tauri://localhost` を許す。開発用の Vite の 5173 は `HANGAR_DEV=1` のときだけ足す。`Origin` の無い要求は `curl` や MCP クライアントなので通す。
- **`Sec-Fetch-Site`**：状態を変える動詞では `same-origin` と `none` だけを通す。`HANGAR_DEV=1` のときは `same-site` も通す。ブラウザはこの見出しを必ず送るので、別のページからの書き込みはここで落ちる。`curl` と MCP クライアントは送らないので、今までどおり通る。
- **`Content-Type`**：本文を持つ要求は `application/json` だけを通し、ほかは 415 で断る。`text/plain` は前検査（preflight）の要らない「単純な要求」で送れてしまうためである。本文を持たない `curl -X POST` はどちらの見出しも付けないので、今までどおり通る。`curl` で本文を送るときは `-H 'Content-Type: application/json'` が要る。例外は 1 つだけで、`POST /api/drops`（初期プロンプトの欄の添付）は、ファイルのバイト列をそのまま送るので `application/octet-stream` を通す。この型は「単純な要求」で使える型ではないので、別のサイトのページから送ると前検査が起き、CORS の許可を返さないここでは届かない。前検査を必ず挟ませるという JSON だけにする理由はこの型でも保たれ、トークン、Origin、`Sec-Fetch-Site` の検査もそのまま効く。例外は動詞と経路と型がそろったものだけで、「単純でない型なら通す」には広げない。

`SameSite` の「サイト」はスキームと登録可能ドメインで決まり、ポートを数えない。
つまり `http://127.0.0.1:5173` と `http://127.0.0.1:4177` は同一サイトであり、`SameSite=Strict` のクッキーは前者から後者への要求にも載る。
5173 を常時許さないことと `Sec-Fetch-Site` を見ることは、どちらもこの経路を塞ぐためにある。

Origin と `Sec-Fetch-Site` で断るときは、どちらで断ったかを区別できない同じ応答を返す。
攻撃者に手掛かりを与えないためである。

`/ws` と `/ws/pty` は、`Authorization` ヘッダとクッキーからだけトークンを読む。
クエリ文字列のトークンは受け付けない。
URL に載せると、鍵がブラウザの履歴と中間のログに残るためである。

MCP は Origin の一覧を共有せず、`http://localhost:4177`、`http://127.0.0.1:4177`、`tauri://localhost` の 3 つに限る。
MCP クライアントは `Origin` を送らないので、ヘッダが無い要求は通す。
MCP クライアントには、`hangar mcp install` と `--mcp-config` がヘッダ付きの設定を書くので、利用者がトークンを扱う場面はない。

#### トークンを引数に載せない

トークンは、どの経路でもプロセスの引数には載せない。
引数は `ps -ww -o command=` で同じ機械の誰にでも読めるためである。
run を起こすときの `--mcp-config` には、JSON の文字列ではなく `~/.agent-hangar/mcp/<sessionId>.json`（権限 0600）のパスを渡し、run の終了でそのファイルを消す。
消し損ねた分は、次の起動と起動時の回復で、生きている run のもの以外をまとめて消す。
statusline のスニペットは、`~/.agent-hangar/statusline-header`（権限 0600）に置いた `Authorization: Bearer <トークン>` の 1 行を `curl -H @<ファイル>` で読む。
`-H @<ファイル>` は中身をヘッダの行として読むので、curl の argv にはファイルの名前しか出ない。
この書き方は curl 7.55 以降にある。
鍵付きの URL をブラウザで開くときも、`open <URL>` ではなく `osascript -` に標準入力で AppleScript を流し込む。
`open <URL>` だと鍵の載った URL が argv に出て、同じ利用者のどのプロセスからも `ps` で読めるためである。

#### run ごとの MCP の秘密

hangar が起こす `claude` には、本体のトークンを渡さない。
run を起こすたびに 32 バイトの秘密を作り、`--mcp-config` のファイルにはその秘密を書く。
本体のトークンを渡すと、その `claude` は自分の `--mcp-config`（0600 だが、読めるのは他ならぬ自分である）から鍵を取り出し、共通の `/mcp` と `/api` に回れてしまう。
閉じ込めは URL ではなく鍵で行う必要がある。

秘密が開けるのは、その run のセッションの `/mcp/s/<sessionId>` だけである。
共通の `/mcp` と `/api` 配下はどちらも通らない。
本体のトークンは今までどおり両方を開けるので、`hangar mcp install` が登録する共通の URL は変わらない。
照合は長さを見てから定数時間の比較を行う。

置き場は端末ローカルの `mcp_secrets`（マイグレーション 7、`session_id` を主鍵にして `secret` と `created_at` を持つ）である。
共有テーブルの列を持たないので、`upsertShared` を通さず、同期の `changes` にも載らない。
サーバのメモリに持たないのは、tmux の上で生きている run がサーバの再起動をまたいで残るためである。
その `claude` は再起動の後も同じ秘密で繋ぎに来る。

秘密は run の終了で消す。
消し損ねたものは、次の起動と起動時の回復のときに、生きている run のもの以外をまとめて落とす。
`--mcp-config` のファイルの後始末と同じ扱いである。

### ツール

MCP は Streamable HTTP で提供する。
共通の `/mcp` と、セッション別の `/mcp/s/<sessionId>` がある。
状態を持たない作りで、要求ごとにサーバとトランスポートを作り、答えは JSON で返す。
GET の SSE（サーバから送るための開いたままの流れ）は開かず、鍵の検査の後に 405 を返す（`Allow: POST, DELETE`）。
要求ごとに作ったトランスポートの流れには送るものが無いうえ、開いておくと hangar が止まったときに流れが切れ、Claude Code はサーバが落ちたと見て、繋ぎ直しを 5 回（1、2、4、8 秒おき）試したあとに諦める。
諦めた claude は、hangar を起こし直しても、利用者が `/mcp` で繋ぎ直すまで ECONNREFUSED のままになる（2.1.296 で、止めて 60 秒後に起こし直して確かめた。macOS でも Windows でも同じ）。
GET を開かなければ、止まっている間に呼ばなかった claude は切れたことに気付かず、起こし直した後の次の呼び出しがそのまま通る（同じ版で、止めて 72 秒後に起こし直して確かめた）。
止まっている間に呼んだ失敗は 1 回ごとに数えられ、続けて 3 回で同じく諦める。1 回の失敗の後に起こし直せば、次の呼び出しで数え直しになる。
セッション別 URL では、`session_id` を省いたツール呼び出しがそのセッションを指す。
さらにこの URL は、そのセッションとそのプロジェクトに閉じる。
ほかの `session_id` や `project_id` を渡されたら、黙って読み替えず、断りの文を返す。
`list_projects` と `list_sessions` も枠の外を返さない。
セッションがプロジェクトに属していないときは、プロジェクトを必要とするツールを断る。
共通の `/mcp` には枠が無く、今までどおりすべてを指せる。

- `list_projects()`：プロジェクトの一覧。ステータス、パス、未完 TODO 数、最終活動。
- `get_project(project_id)`：詳細。TODO、メモ、直近のセッション、アーティファクト。
- `update_project(project_id, { status?, add_todos?, toggle_todos?, propose_done?, append_memo? })`。
- `list_sessions({ project_id?, running?, limit? })`。
- `search_sessions({ query, project_id?, since?, until?, file? })`：FTS と絞り込み。結果は題名、要約の 1 文、一致箇所の抜粋、再開コマンド。
- `get_transcript(session_id, { from_seq?, limit?, include_tools? })`：正規化イベントを返す。
- `create_session({ project_id, name?, prompt?, model?, effort?, permission_mode?, scratch? })`：tmux で起動して run を返す。
- `set_session_summary({ session_id?, title, one_liner, body, state, next_steps })`。
- `set_turn_intent({ session_id?, text })`：このターンで何のために何をするかを 1〜2 文（200 字まで）で書く。端末ローカルの `turn_intents` に積み、同期しない。セッション画面の現在の帯に出す。
- `set_session_memo({ session_id?, text })`：人間向けの 1 行メモ。モデルには指示しない。
- `get_usage()`：5 時間と 7 日の使用率、最終更新時刻。
- `open_in_hangar({ session_id | project_id })`：UI とディープリンクの URL を返す。

`update_project` は TODO の追加と完了の候補の提出、メモの追記を行い、TODO の書き込みは全部成功か全部失敗のどちらかにする（途中で失敗したものが残らない）。
MCP からは TODO を完了にできない。`propose_done` と未完への `toggle_todos` は完了の候補を出し、結果を `todo_results`（`[{ todo_id, outcome }]`）で返す。
`propose_done` は `[{ todo_id, note }]` で、`note` は根拠の一文（空白を除いて 1 字以上 200 字以下）である。
`toggle_todos` は、未完で候補でない TODO を根拠なしの候補にし、完了の TODO は未完に開き直し、候補の TODO には何もしない。
`outcome` は次の 5 つである。
`proposed` は候補にしたこと、`already_candidate` はすでに候補なので何もせず根拠も上書きしなかったこと、`already_done` はすでに完了なので何もしなかったこと（`propose_done` のみ）を指す。
`rejected_before` はこのセッションの候補は却下済みなので受け付けなかったこと、`reopened` は完了を未完に開き直したこと（`toggle_todos` のみ）を指す。
`note` が空か 201 字以上、または見つからない ID が 1 つでも混ざれば、呼び出し全体を断り、どの TODO も書かない。
`get_project` の TODO には `candidate: { session_id, note } | null` が付き、セッションは自分の候補が残っているかを確かめられる。
`get_usage` は 5 時間と 7 日の使用率と最終更新時刻を返し、statusline が一度も届いていなければ値は null になる。

`hangar mcp install` は、Claude Code の user スコープに `hangar` サーバを登録する。
登録は利用者が明示的に実行し、`~/.claude.json` の `mcpServers.hangar` だけを hangar が書き換える。
`claude mcp add` を呼ばないのは、`--header` の値が argv に載り、トークンが `ps` から読めるためである。
`claude mcp add` にはヘッダの値をファイルや標準入力から受ける口が無く、`${HANGAR_TOKEN}` と書いても展開されずにそのまま保存されることを実物で確かめた。
書き換えは同じディレクトリに書いてから `rename` する形で、他の項目と他の MCP サーバには触れない。
ファイルが JSON として壊れているときは、上書きせずに失敗として返す。

ここは hangar が利用者の設定を書き換える数少ない場所なので、次の 4 つを守る。

- **ロックを取ってから書く。** 実体の隣に `<実体>.hangar-lock` を `O_EXCL` で作り、取れるまで 2 秒だけ待つ。取れなければ何も書かずに「Claude Code が設定を書いている最中のようです」と返す。落ちたプロセスが残したロックで永久に失敗しないよう、更新から 10 秒より古いものだけは残骸とみなして消し、取り直す。ロックを取った後も、読んでから書くまでの間に Claude Code が書いたかもしれないので、書く直前にもう一度読んでから併合する。
- **シンボリックリンクはリンクのまま残す。** 途中のディレクトリも含めてリンクを解き、実体の隣に一時ファイルを書いて `rename` する。dotfiles のリポジトリへ `~/.claude.json` をリンクしている人の設定を、実ファイルで置き換えないためである。リンク先がまだ無いときは、その場所に作る。
- **権限は新規 0600、既存は保つ。** 既にあるファイルは利用者が決めた権限をそのまま使う。ただしここにはトークンを書くので、group や other に 1 つでも立っていれば 0600 へ狭め、狭めたことを端末に知らせる。
- **書く前に控えを取る。** もとのファイルを `~/.agent-hangar/backups/claude.json-<yyyymmddHHMMSS>`（権限 0600）へ写してから書く。同じ秒に 2 度来たら連番を足し、既にある控えは上書きしない。控えが取れなければ書かない。控えの置き場を `~/.agent-hangar` の下にするのは、`~/.claude` の中に hangar のファイルを増やさないためである。

`claude` が PATH に無いときは登録もしない。
書いた後は、書いたトークンそのもので `GET /api/usage` を 1 回叩いて確かめる。
`/health` は認証を通さないので、通っても「そのポートで何かが応答する」ことしか分からず、`HANGAR_HOME` がサーバとずれていれば別のトークンを書いたまま成功と言ってしまう。
認証が通らなかったときは失敗として返し、書いたトークンの置き場と `HANGAR_HOME` の食い違いを印字する（トークンそのものは印字しない）。
そのポートで誰も応答しないときだけは、起動前の登録を塞がないために成功のまま起動を促す。
削除は `claude mcp remove` に任せる。こちらはトークンを渡さないので、argv の問題が無い。
Claude Code は MCP のツール定義を遅延して読むため、ツールの説明文に「agent-hangar」を含めて検索で当たるようにする。

### 初期プロンプトの欄の口

新しいセッションのダイアログの初期プロンプトの欄が使う口が 5 つある。
どれも `/api` 配下で、トークンと入口の 3 つの検査を通す。

- `GET /api/prompt/commands?projectId=`：`/` の候補。`projectId` が無ければ（スクラッチ）、プロジェクトのスキルは読まない。
- `GET /api/prompt/files?projectId=&q=`：`@` の候補。プロジェクトの根からの相対パスを返す。パスの無いプロジェクトでは空を返す。
- `POST /api/drops?name=`：添付 1 件を `~/.agent-hangar/drops/` に置き、`{ path, name, size }` を返す。1 件 20 MB まで、置くたびに 7 日を過ぎたものを消す。
- `POST /api/drops/existing`：本文は `{ paths }` で、いまも存在するものだけを返す。下書きから戻した添付の確かめに使う。
- `GET /api/drops/:name`：置き場のファイル。札の絵に使う。画像だけを画像として返し、置き場の中のシンボリックリンクは返さない。

ファイルの候補は、git の呼び出しを非同期で行い（5 秒で打ち切る）、同じプロジェクトへ同時に来た呼び出しは 1 つにまとめて、10 秒覚える。
git でないフォルダの歩きと、その最近変えたファイルの `stat` は同期である。ただし上限があり、深さ 6、5,000 件、訪ねるフォルダ 2,000 までで、`stat` も歩いた 5,000 件までに限る。
作業ツリーかどうかは `git rev-parse` で尋ね（リポジトリの下のフォルダでも `.gitignore` が効く）、作業ツリーなら `git ls-files` を使う。
作業ツリーでないとき、または git が失敗した直後の 60 秒は、深さ 6、5,000 件、訪ねるフォルダ 2,000 までの歩きで探す。
最近変えたファイルは、git のプロジェクトでは作業ツリーの変更、続けて最近 30 件のコミットで触れたものの順にする。
置き場の名前は、端末へのドロップと同じ規則（`filedrop.rs` の `sanitize`）で直す。
詳しくは `docs/superpowers/specs/2026-10-06-prompt-composer-design.md` にある。

### ディープリンク

Tauri のシェルは `hangar://` スキームを登録する。
`hangar://session/<id>`、`hangar://project/<id>`、`hangar://search?q=<text>` を受け、対応する画面を開く。
ブラウザで使うときは同じ経路を `http://127.0.0.1:4177/#/session/<id>` で表す。

## アーティファクト

**アーティファクト** は、セッションが claude.ai に公開した Artifact の URL である。
トランスクリプトの Artifact ツール呼び出しと結果から自動で抽出する。
呼び出しには元ファイルのパス、説明文、favicon の絵文字が、結果には `Published <path> at https://claude.ai/code/artifact/<uuid>` が残る。
旧形式の `https://claude.ai/artifact/<id>` も同じ扱いにする。

同じ URL への再公開は 1 件のアーティファクトにまとめ、`artifact_versions` に「いつ、どのセッションが更新したか」を積む。
題名は元ファイルが残っていれば HTML の `<title>` から、無ければ説明文の先頭から取る。
プロジェクト画面には全セッション分を集約し、セッション画面にはそのセッション分を出す。
カードには favicon、題名、説明、最終公開時刻、更新回数を出し、クリックで既定のブラウザに開く。
元ファイルが残っていれば「VS Code で開く」も付ける。
利用者は URL を手で追加できる。

呼び出しと結果は別の記録にあり、追記の境目で分かれることがあるので、端末ローカルの `artifact_calls` に呼び出しを控えて結果と突き合わせる。
題名は表示のたびに計算せず、公開を記録するときに決めて `artifacts.title` に書く。
カードのクリックは `POST /api/artifacts/:id/open` でサーバが `open` を実行する（ブラウザの `window.open` は使わない）。

## 使用量

5 時間と 7 日のレート制限の使用率は、ディスクには保存されていない。
唯一の供給源は、Claude Code が statusLine コマンドに標準入力で渡す JSON である。
`hangar setup` は、利用者の既存の statusline スクリプトの先頭に次の数行を追記する。

```sh
# agent-hangar: 使用量をローカルサーバへ渡す。失敗は無視する。
__hangar_input=$(cat)
__hangar_home="${HANGAR_HOME:-$HOME/.agent-hangar}"
__hangar_header="$__hangar_home/statusline-header"
if [ -r "$__hangar_header" ]; then
  printf '%s' "$__hangar_input" | curl -s -m 0.3 -X POST \
    -H 'Content-Type: application/json' \
    -H @"$__hangar_header" \
    --data-binary @- http://127.0.0.1:4177/api/ingest/statusline >/dev/null 2>&1 &
fi
exec <<<"$__hangar_input"
```

トークンはファイルから curl に渡す。
`-H "Authorization: Bearer $(cat ...)"` と書くとシェルが先に展開するので、64 桁が curl の argv に載り、statusline が走るたびに `ps` から読める。
`-H @<ファイル>` はファイルの中身をヘッダの行として読むので、argv にはファイルの名前しか出ない。
この書き方は curl 7.55 以降にある（手元の 8.7.1 で実測した）。
`--variable` と `--expand-header` でも隠せるが、そちらは curl 8.3 以降にしか無く、古い curl では要求を出す前に終わる。
しかもその失敗は `>/dev/null 2>&1` に消えるので、利用者には何も見えないまま使用量だけが止まる。

読ませるファイルは `~/.agent-hangar/statusline-header`（権限 0600）で、中身は `Authorization: Bearer <トークン>` の 1 行である。
64 桁だけが入った `token` は、そのままではヘッダの行にならないので、token を唯一の出どころにしてここへ書き写す。
このファイルはサーバの起動のたびに用意する。
`hangar statusline install` のときにしか置かないと、`~/.agent-hangar` を消した利用者はこのファイルを持たないまま statusline だけが残る。
スニペットは読めなければ何も送らずに素通しするので、使用量が何も言わずに止まってしまう。
中身と権限がトークンと揃っているときは触らず、トークンが作り直されていれば書き直す。

`settings.json` は書き換えない。
payload には `rate_limits` のほかに `session_id`、`session_name`、`cwd`、`transcript_path`、`model`、`effort`、`cost`、`context_window` が入る。
セッションごとのモデルと effort は、この payload を第一の供給源にし、無ければトランスクリプトの解析から得た値を使う。
コンテキスト使用率と推定コストは、この payload だけが供給源である。
窓の大きさ（`context_window_size`）は payload にしか無く、推定コストは価格表を持たない方針なので、どちらも jsonl からは導けないためである。
したがって statusline の追記を入れていない間は、この 2 つはどのセッションでも出ない。
出ないときは棒を描かず、ヘッダーの使用率のゲージと同じ言葉で「未取得」と書く。
0% の棒は「まだ使っていない」と読めてしまうためである。
両方とも未取得のときは「コンテキスト、コスト 未取得」の 1 つにまとめ、押すと Settings へ行く（理由は title に持つ）。
終わったセッションは、この先も値が届かないので何も出さない。
Home の帯の実行中の行は、使用率が届いていない間は使用率を出さない。
更新は定期ではなく、起動直後と応答完了のたびに 1 回である。起動直後の 1 回目は `rate_limits` が無いので、欠けた項目は直前の値を保つ。
`resets_at` は秒の UNIX 時刻として読む。
10^11 より大きい値はミリ秒と見てそのまま使い、Claude Code との互換のずれとして記録する。
使用率は Claude のセッションが動いている間だけ更新されるので、ヘッダーのゲージには「最終更新 N 分前」を添える。
追記は目印のコメント行で二重追記を避け、追記前にバックアップを取る。
既に入っているスニペットが今の形と違うときは、目印の行から `exec <<<` の行までを差し替える。
目印だけを見て何もしないと、トークンを argv に載せる古い形が入ったまま残るためである。
追記を行うのは `hangar setup` の手順 4 と `hangar statusline install` の 2 つだけで、どちらも利用者の承諾を求める。
UI とサーバは追記の有無を `GET /api/statusline` で読むだけで、書き込む経路もボタンも持たない。

準備の確かめは `GET /api/readiness` の 1 つにまとめてある（`packages/server/src/config/readiness.ts`）。
tmux、claude、code、Node のパスの有無と実行権と版、ワークスペースの有無と、そこから登録したプロジェクトの数、MCP の登録の有無、statusline の追記の有無、画面に出すコマンドを返す。
Claude Code との互換の要約（確かめた版、手元の claude の版、ずれの件数）も `compat` に載せる。
版は `tmux -V` と `--version` を 3 秒の時間切れ付きで起こして読み、同じファイル（パス、更新時刻、大きさ）なら覚えた版を返して起こし直さない。
設定画面の欄の下の検証と、ホームの帯の始める前の確認が、どちらもこれを読む。
UI は起動のたび、設定画面に入ったとき、設定を保存した後、「もう一度確かめる」を押したときに取りに行く。

tmux の役の道具（Windows は psmux、ほかは tmux）は、設定の `tmuxPath` を最初の起動で一度だけ埋める（`resolveToolPaths`）。
あとから psmux や tmux を入れた人のために、「再確認」の経路 `POST /api/readiness/mux` を置く（段 6）。
設定が空か、設定したファイルが無くなっているときだけ、PATH と既知の置き場（Windows は winget の `Links`）から探し直す（`recheckMuxPath` と `whichMux`）。
見つかれば設定の保存と同じ口（`updateSettings`）で `tmuxPath` を埋め、取り直した準備の確かめと書いた後の設定を返す（`MuxRecheckDto`）。
動いている設定と、利用者が指したが実行できないファイルは変えない。
画面では、ホームの帯の tmux の行、始める前の案内のダイアログ、設定のツールの行の 3 か所が、同じ操作 `mux.recheck` でこれを呼ぶ。
サーバも、起こす前に設定の tmux のパスの実物を確かめる（`RunManager` の `startPanes`）。
画面の口はパスが入っていれば作られるので、指したファイルが後から消えても残り、そのまま進むとペインを開く段で初めて失敗する。
引き取り（adopt）は外の claude を止めたあとに開くので、それでは元の会話を止めたまま終わる。
そこで新しいセッション、再開、フォーク、接続、引き取りの前に、無い、ファイルでない、実行できない、PATH に無いのどれかなら断る。
判定は設定の保存と同じもの（`toolPathIssue`）で、文も同じ（「tmux のパス」に /x が見つかりません、など）。
止める、画面を読むといった既存の run への操作は、この確かめを通さない。
副情報として、jsonl の `usage` からトークン数を日別とプロジェクト別に集計する。
日別とプロジェクト別は同じ窓（直近 30 日）と同じ供給源（`usage_daily`）で束ねるので、2 つの表のトークン数の合計は一致する。
ただし推定コストだけは、そのセッションの走り全体の累計である。
唯一の供給源が statusline の渡してくる `cost` で、日ごとの内訳を持たないためである。
プロジェクト別の推定コストは、窓に入ったセッションについて 1 件につき一度だけ足す。

## 検索

ホームの一覧は検索画面を兼ねる（セッションの一覧の画面は無くなった）。
キーワードが空なら全件を新しい順に出す。
検索対象は利用者の発言、アシスタントの本文、ツール呼び出しのファイルパスとコマンドである。
絞り込みはプロジェクト、期間、状態（入力待ち、実行中、終了）、触ったファイルである。
キーワードが空でも、触ったファイルで絞るときはサーバの検索を使い、そのファイルを触ったセッションを新しい順に出す。
触ったファイルは手元のセッションの情報に無いからである。
プロジェクトは検索欄つきの一覧で、先頭に「すべてのプロジェクト」を置く。
期間（全期間、今日、7 日、30 日）は切り替えの帯で選び、状態は状態のタブ（すべて、確認待ち、Active、Paused、Done、Archived）で選ぶ。動き（入力待ち、実行中、終了）は欄のトークン（`is:waiting` など）で選ぶ。
状態の数え方は「画面の用語」の節の定義に従い、手元の一覧と `/api/search` の `live`（`running`、`waiting`、`ended`）で同じ関数（shared の `liveFilterOf`）を使う。
期間は相対の日数で持ち、問い合わせるときに時刻へ直す。
「今日」は暦の今日の 0 時から、「7 日」と「30 日」は今日を含めたその日数分の最初の日の 0 時からである。
結果には題名、要約の 1 文、一致箇所の抜粋、日時、プロジェクトを出す。
全文検索の欄はホームの一覧の上の 1 本だけで、これが全文検索の本体である（設計は `docs/superpowers/specs/2026-10-01-ux-refresh-2-design.md` の 4、案 D1）。
欄は名前、要約、トランスクリプトを引く。サーバの `searchSessions` が、名前（一覧に出す表示名の 1 つ）と要約（題、1 文、本文）を `like` で、トランスクリプトを全文索引（と `like`）で探し、重なりを 1 行に数える（`SearchHitDto.matched` に当たった場所を載せる）。
欄には探す絵と「名前」「要約」「トランスクリプト」の 3 つの札を添え、語を打っているあいだは 3 つとも青にする。打った語は × で消せる。
結果は、当たった場所の見出しで分けて並べる。
名前か要約に当たった行は「名前に一致」の下に、トランスクリプトだけに当たった行は「トランスクリプトに一致」の下に置く（サーバが前者を先に並べる）。
名前に当たった行は、名前の中の一致する語に黄色の印を付ける。要約に当たった行には、2 段目の末に「要約に一致」の札を付ける。
見出しの件数は全件の数から数え、読んだ行だけでは決まらないとき（読んだ行がどれも名前の組で、続きに名前の組が来うるとき）は書かない。
見出しは、サーバが当たった場所を送ってきたときの語の検索にだけ付ける。古いサーバの結果と、触ったファイルだけの検索は、見出しなしの平らな一覧のまま。
ヘッダーには打つ欄を置かず、パレットの最後の行（「ホームで『語』をトランスクリプトから検索」）がホームへ来る（同じ `search.query` の経路。移る先は `#/?q=<語>`）。
絞り込み（プロジェクト、期間、操作したファイル）は、欄の横の「絞り込み」のボタンから開く。
一覧の見出しの件数は条件に関わらず手元のセッションの全件（Archived を除く）である。
条件（語、プロジェクト、期間、状態、触ったファイル）が 1 つでも効いていれば、絞り込みの段の下に条件の行を出し、効いている条件を並べ、「条件をクリア」と件数を置く。
ただし状態のタブだけで絞っているときは、条件の行を出さない。選んだタブと欄の札が、同じ条件と件数を既に言っているからである。
0 件のタブは淡くする。
ページ送りの帯は、番号の列と跳び先の欄を中ほどに並べ、いまのページは塗りつぶさず淡い地と色の文字で示す（塗りつぶすとヘッダーの主ボタンと競る）。
「条件をクリア」は `search.clear` で、語と絞り込みをまとめて外し、語の無い一覧の URL へ移る。
サーバは 1 回に 50 件ずつ返し（最初の 1 回も同じ）、続きは一覧の末尾の「さらに 50 件を読み込む」で読み足し、残りの件数を添える（`search.more`、残りが 50 件に満たなければその数を言う）。
読み足した行は、持っている結果の後ろに足す（置き換えない）。ページ送りは語も触ったファイルも無い手元の一覧のものである。
同じ検索を MCP の `search_sessions` で外部の AI にも提供する。
FTS5 に渡す検索語はトークンごとに二重引用符で包む。ハイフンを含む語を素のまま渡すと列指定と解釈されてエラーになる。
trigram は 3 文字未満の語に一致できないので、3 文字未満の語は部分一致で補う。
意味検索は初版では持たない。

### 名前と要約の照合

サーバの `searchSessions` は、トランスクリプトに加えて、セッションの名前と要約も引く（設計は `docs/superpowers/specs/2026-10-09-stage4-screens-design.md` の 2.11.1 と 4.2 の 3）。
画面はホームの欄が使う（この節の上の、欄の説明）。
語があるときだけ引き、語が無く触ったファイルだけで絞る検索は、これまでどおり名前を見ない。

- 名前は、一覧に出す表示名と同じ優先順の 1 つだけを引く。本文から拾った題名（`sessions.custom_title`）、hangar で付けた名前（`session_notes.name`）、`ai_title`、`first_prompt` の先頭 40 字の順で、空の文字列は飛ばす（`displayName` と同じ）。
  隠れた列だけに当たった行は、見える名前に語が無いのに「名前に一致」へ混ざってしまうので、名前では当たらない（要約かトランスクリプトに当たっていれば、そちらで出る）。
  実行中の Claude Code が持つ利用者の名前は DB に無いので、引かない。論理削除された `session_notes` の行は無いものとする。
- 要約の列は、`session_summaries` の `title`、`one_liner`、`body` である。論理削除された行は無いものとする。
- 語は 3 文字以上も未満も、`like` の部分一致で引く（大文字小文字は ASCII だけ区別しない。トランスクリプトの短い語と同じ）。索引は足さない。
- 語が複数のときは、名前の組の中、要約の組の中のそれぞれで、全部の語を満たす行を当たりとする。名前に 1 語、要約に別の 1 語のように、組をまたいで満たす行は当たりにしない。
  トランスクリプトも同じで、全部の語が 1 つの行に要る。3 つの組をまたいで AND にしないのは、どこに当たったかを `matched` で一意に言えなくなるからである。
- 絞り込み（プロジェクト、期間、状態、動き、触ったファイル、削除済み）は、トランスクリプトの当たりと同じ条件を名前と要約の当たりにもかける。
- 返す行は `SearchHitDto.matched`（`name`、`summary`、`transcript` の順）で、どこに当たったかを持つ。名前と要約だけで当たった行は `matchCount` 0、`snippets` 空である。重なった行は 1 件に数え、`matchCount` と抜粋も残す。
- 並びは、名前か要約に当たった行（トランスクリプトにも当たった行を含む）が先で、トランスクリプトだけの行が続く。
  先の組の中は、名前に当たった行を先に、要約だけの行を後にし、それぞれ新しい順である。後の組は、これまでどおり件数の多い順、同じなら新しい順である。
  どちらも最後は id の順で決める。同じ時刻と同じ件数の行があっても、`offset` をまたいで並びが入れ替わらないようにするためである。
  重なった行を先の組に入れるのは、画面が「名前に一致」の見出しの下に、名前か要約で当たった行を続けて並べられるようにするためである。
- `total` は重なりを除いた件数で、`offset` と `limit` はこの 1 本の並びに対して効く。動きの絞り込みで落ちた行は数えない。
- 名前だけの行は抜粋を取らないので、トランスクリプトの当たりの行より軽い。名前と要約の走査そのものは、実データ規模（セッション 1,000 件台）でも、抜粋の取得に比べて無視できる長さだった（PR 26 で実測した）。
  検索 1 回の時間を決めているのは、当たった行ごとに抜粋を取る処理（`event_fts` の全走査が行ごとに 1 回）である。
- MCP の `search_sessions` も同じ関数を使うので、名前と要約だけで当たった行も返す。

## プロジェクトの同定

プロジェクトは安定した ID と、端末ごとのパスを持つ。
パスが見つからないとき（ディレクトリの改名、移動、削除）は、この PC の `project_roots.resolved = 0` にする。
ダイアログは自動では出さない。起動時にも、同期の直後にも、作業中にも出さない（設計書 2.11.5）。
入口は次の 3 つで、押したときだけ開く。

- ホームの帯の 4 つ目の錠剤「場所の不明なプロジェクト N」と、その引き出し。引き出しは 1 件 1 行で、名前、セッションの数、前のパス、「場所を再指定」「Archived にする」「一覧から削除」を置く。
- プロジェクトの一覧の「この PC にパスがありません」の札。
- 同期で他の PC のプロジェクトが降りた直後の、右下の札 1 枚（「他の PC のプロジェクト N 件が届きました」。「プロジェクトで見る」「あとで決める」）。ダイアログは開かず、プロジェクトの一覧へ案内するだけである。

帯の件数に入れるのは、この PC で場所が消えたもの（`ProjectDto.unresolved.kind = 'missing'`、この PC の `project_roots` の行が未解決）だけである。
他の PC から届いただけで、この PC に場所を持ったことが無いもの（`'elsewhere'`、この PC の行が無い）は数えない。数えると、2 台で使う人の帯が消えなくなるからである。
届いただけのものはプロジェクトの一覧の札から扱う。決めないまま残せば、帯と札に残り続ける。
Archived にしたものとスクラッチは、どちらにも数えない。
`unresolved` は列を足さず、サーバが `project_roots`（PC ごとの行）と `devices` の今の行から組む（`db/queries.ts`）。`elsewhere` の前のパスと PC の名前は、他の PC の行のうちいちばん新しく書かれたものから取る。
他の PC から降りたことは `project.upsert` で分かる。Runtime が、起動の読み込みが済んだあとに、初めて見る id で `elsewhere` のものを `projects.arrived` として Mediator へ届ける（`runtime/runtime.ts`）。
Mediator は降りた id を `arrivedProjects` に覚え、札は 1 枚にまとめる（`mediator/arrived.ts`）。起動の読み込みで入るものは知らせない。

ダイアログは「場所を再指定」を押したときだけ開き、「ディレクトリを再指定」「Archived にする」「一覧から削除」「あとで」を選ばせる。
「一覧から削除」（`unlink`）は、そのプロジェクトのセッションをすべて未分類に戻し、プロジェクトを論理削除する。
同期で他の PC からも消えるので、ボタンを危険色にし、押したら確認を挟む。帯の行から直に押したときも、同じ確認を出す。
確認には「プロジェクト <名前> を一覧から削除し、N 件のセッションを未分類に戻します。同期している他の PC からも消えます。」と書く。
N は UI の store に届いているセッションで数える。
確認は取り消せない操作の形（見出しの前の赤い丸のアイコンと、赤く塗った押し切るボタン）にし、既定のフォーカスは「やめる」に置く。
ダイアログから来た確認は、やめたらそのダイアログへ戻る（確認の `fromDialog`）。
押して開くダイアログなので、閉じる手（Esc、背景、見出しの × 、「あとで」）を持つ。閉じても、帯の錠剤と一覧の札が残るので、いつでも開き直せる。
開いたら新しいパスの欄にフォーカスを入れる。
自動推定やマーカーファイルは持たない。
再指定のダイアログには、ワークスペースルート直下で名前が近いディレクトリを候補として並べる。

初回起動時は、ワークスペースルート（既定は `~/workspace`）直下で、cwd がそのディレクトリ以下の Claude セッションが 1 つ以上あるものを自動でプロジェクトにする。
セッションのない直下ディレクトリは、新しいセッションのダイアログの検索と、作成のダイアログの未登録の一覧にだけ出す。
起動した後に、直下の新しいディレクトリでセッションが現れたら、起動時と同じ規則でその場でプロジェクトにする。
ルート外の cwd のセッションは「未分類」に入れ、後から手で紐づけられる。
起動した後にワークスペースの外の cwd で未分類のセッションが現れても、知らせは流さない（2026-10-10 に外した。理由は「ベルと知らせの出し分け」の節）。
ディレクトリが戻ってルートが解決に戻ったら、その間に溜まった未分類のセッションを紐づけ直し、変わったセッションとプロジェクトを配る。

## 画面

### 画面の構成

段 4 で、画面を次の構成に作り替えた（決めた経緯は `docs/superpowers/specs/2026-10-09-stage4-screens-design.md`）。
窓は、左のサイドバー、上のヘッダー、残りの本文でできている（「骨格」の節）。
サイドバーの項目は、ホームとプロジェクトの 2 つと、下端の設定である。
本文に出る画面は次の 5 つで、画面の外に出るものが 3 つある。

| 画面 | 中身 | 書いてある節 |
| --- | --- | --- |
| ホーム | 一覧が主役で、要対応、実行中、確認待ちは上の帯に畳む。場所の不明なプロジェクトと始める前の確認も、帯の群として出る | 「Home」「Home の帯と引き出し」「Home の一覧」 |
| プロジェクト | 1 行 1 プロジェクトの表 | 「Projects」 |
| 1 つのプロジェクト | 左にホームと同じ部品のセッションの一覧、右に TODO、ノート、アーティファクト | 「プロジェクト詳細」 |
| セッション画面 | 実行中は現在の帯とターミナル、終わった後は冒頭の 1 枚つきのトランスクリプト。右は目次だけ | 「セッション詳細」 |
| 設定 | 左の目次で 6 つ（殻の中は更新を加えた 7 つ）の節を切り替える | 「Settings」 |
| 知らせ（画面の外） | 右下の札は入力待ちだけ。ほかはヘッダーのベルの一覧に入り、トーストは操作の結果だけを言う | 「入力待ちの知らせ」「ベルと知らせの出し分け」 |
| 起動の失敗（画面の外） | サーバが起きないときは、殻の読み込みの頁が 1 枚の札で理由と次の手を言う | 「起動の失敗の札」 |
| 始める前の確認（画面の外） | tmux、claude などがそろっていなければ、ホームの帯の最後の群として出る。そろえば消える | 「Home」 |

画面に出る文は、日本語と英語の辞書から引く。
言語は設定の「一般」の節の最初の行で切り替える（「文言の辞書」の節）。
画面は常に明るい配色で、暗い配色は持たない。

### 画面の用語

画面に出る語の正本は、用語集 `docs/superpowers/specs/2026-10-09-glossary.md` である。
用語集は、概念ごとの日本語と英語の対応表、使わない語の一覧、決めた理由を持つ。
この節には、用語集の決定のうち、画面とコードを書くときに守る決まりと、取り違えやすい語だけを移す。
語を足すときと変えるときは、用語集の表と、この節の該当の行を同じ PR で直す。

#### 決まり

1. Claude Code の公式ドキュメントの日本語版に語がある概念は、公式の語に寄せる。英語は公式の英語の語をそのまま使う（例：トランスクリプト、メイン会話、権限モード、ステータスライン）。
2. アプリ独自の概念の日本語は、ふつうのソフトの語にする（確認する、完了、編集、削除、表示、検索、接続）。やわらかい和語（確かめる、休み、終えた、引き取る、止めている）は使わない。
3. セッションとプロジェクトのステータスの札は、日本語でも英語のまま出す（Active、Paused、Done、Archived）。
4. DB の列名、API の鍵、内部の値、検索の `is:` の語は変えない。変えるのは画面の語だけである。英語の内部値（`busy`、`waiting`、`scanning`、`tmuxPath` など）を画面に出さない。
5. 日本語と英語は 1 対 1 に対応させる。1 つの概念に 1 つの語を当て、同じ語を別の概念に使わない。
6. 英語のボタンとラベルは Sentence case にする。公式の語と状態の札は、そのままの表記にする。
7. 読み上げの名前（`aria-label`）は、見えている文字をそのまま含める。見える文と読み上げの名前を別の言い方にしない。

文の中の「hangar」は小文字、ワードマークと英語の文の中は「Hangar」、コマンドとプロセスは小文字の `claude`、相手としては Claude と書く。
動詞は、確認する（Check）、検索する（Search）、接続する、再接続する（Connect、Reconnect）、再構築する（Rebuild）、再生成する（Regenerate）、再読み込みする（Reload）、削除する（Delete）、解除する（Remove）、停止する（Claude を止める、Stop）、無効にする（機能を止める、Disable）、キャンセル（Cancel）にそろえる。

#### 軸の名前

似た語を別の軸に使わない。

| 軸 | 日本語 | 英語 | 値 |
| --- | --- | --- | --- |
| Claude のプロセスの動き | 状態 | State | 作業中（Working）、入力待ち（Needs input）、アイドル（Idle）、起動中（Starting）、終了（Ended） |
| 利用者が付ける札 | ステータス | Status | Active、Paused、Done、Archived（日本語でも英語のまま） |
| 要約が見立てた仕事の進み | 進捗 | Progress | 進行中、完了、ブロック中、中止（In progress、Completed、Blocked、Abandoned） |

- 実行中（Running）は、作業中とアイドルと起動中のまとめを指し、入力待ちは含めない。入力待ちはどの画面でも別に数え、まとめて見せるときの区画の名前は「要対応」（Needs attention）である。数え方は shared の `liveFilterOf` 1 つにまとめる。
- メイン会話はアイドルで、サブエージェントやバックグラウンドの作業だけが進んでいるときは、「バックグラウンドで作業中」（Working in background）と書く。公式の「バックグラウンドセッション」とは別の概念なので、この意味に使わない。
- 「状態」は動きにだけ使い、札の意味に使わない。「ステータス」は札にだけ使う。
- セッション画面の言葉：ターミナルの上の 2 行は「現在」（Now）の帯、右のパネルは「目次」（Outline）だけの右パネル、見出しの右端の (i) のポップオーバーは「詳細」、終わったセッションの先頭の 1 枚は「冒頭の 1 枚」と呼ぶ。「いま」「情報の行」「現在と目次の境目」は使わない。
- トランスクリプトの細かい項目まで出す切り替えの語は「詳細表示」（英語は Raw。利用者の決定、2026-10-10）で、「生の記録」は使わない。

#### 決めた語

利用者が決めた語と、公式の語に寄せた語のうち、旧い言い方と取り違えやすいものを並べる。

| 概念 | 日本語 | 英語 | 使わない語 |
| --- | --- | --- | --- |
| 会話の記録（JSONL） | トランスクリプト | Transcript | 本文、会話の記録、生の記録 |
| サブエージェントを動かす本体の会話 | メイン会話 | Main conversation | 主線、指揮役 |
| 利用者が書く覚え書き | ノート | Note | メモ（公式の memory は「メモリ」） |
| 返答を終えて次の指示を待つ状態 | アイドル | Idle | 休み、待機 |
| 権限の扱い方 | 権限モード。値は Manual、Accept edits、Plan、Auto、Bypass permissions、Don't ask | Permission mode | 都度たずねる、編集は任せる、計画だけ、確認なし |
| Claude の利用上限 | 使用制限（5 時間、週）、使用率 | Usage limit、Percent used | 利用上限、枠、セッション制限 |
| ツールの 1 回の呼び出し | ツール呼び出し | Tool call | 手、N 手目 |
| 要約を作る道具 | 要約エンジン | Summary engine | 要約器 |
| 提案が溜まる区画とタブ | 確認待ち（中の 1 件は「提案」） | Pending review（Suggestion） | 確かめる |
| Paused の日と時刻 | リマインダー、リマインダーの日付、リマインダーの時刻、今日のリマインダー | Reminder | 戻る日、戻る時刻、今日戻る、再開予定 |
| 外部ターミナルの Claude を hangar へ移す | hangar に移動 | Move to Hangar | 引き取る |
| プロジェクトを置く親のフォルダ | プロジェクトの親フォルダ | Projects folder | ワークスペース、プロジェクトルート |
| プロジェクトに属さないセッション | クイックセッション | Quick session | スクラッチ |
| 互換の見張りで変わった点、見張る対象 | 変更点、確認項目 | Change、Check | ずれ、差異、契約、対象 |
| 上書きの前に残す写し | バックアップ | Backup | 控え |
| 届いた設定を書く | 適用 | Apply | 取り込む |
| 上限や枠が戻る | リセットされる | Reset | 戻る（「戻る」は画面を前へ戻す操作だけに使う） |
| hangar が動く計算機 | PC（この PC、他の PC） | Computer | 端末、デバイス |
| 文字を打つ窓 | ターミナル | Terminal | 端末 |
| hangar の外のターミナル | 外部ターミナル | External terminal | 外のターミナル |
| クラウドの金額 | 料金、請求額 | Billing | 費用（Claude の金額は「コスト」） |

フォルダとディレクトリは使い分ける。
Claude が動く場所は、公式に合わせて「ディレクトリ」（作業ディレクトリ、追加ディレクトリ）と書き、利用者が選んで登録するものは「フォルダ」と書く。
サーバのエラー文が設定の項目を指すときは、画面名を「設定」とし、項目は画面の欄の見出しをかぎ括弧で書く（例：設定の「tmux のパス」）。

#### 語の直し方

用語集の語と今の画面の語が違うものは、その画面の文を辞書へ移す PR で、語も同じ PR で変える。
語だけを先に替える PR は作らない。
段 4 で選んだ画面の構成と合わない用語集の語（ホームの区画、設定の群の名前、プロジェクト画面の節の名前、右パネルの段、新しいセッションの畳んだ欄）は、その画面の PR で用語集の側を直す。
直す語と PR の一覧は、段 4 の設計書（`docs/superpowers/specs/2026-10-09-stage4-screens-design.md`）の 2.10 にある。
画面の文の語は、これから順に辞書へ移る（次の「文言の辞書」）。
このため、いまの画面には、用語集より前の語が残っているものがある。

### 文言の辞書

画面とサーバの文は、shared の辞書から鍵で引く。
サーバが出す文（HTTP のエラー、起動の失敗、MCP の道具の説明と結果、Claude に渡す指示、要約器への指示）は辞書に入っている。
画面の文（View が持つ決まった文と、Presenter がデータから作る文）も、段 4 の PR 25 で全部辞書へ移した。
`packages/ui/src` の表示に出る文字列には、日本語の直書きを置かない（試験 `packages/ui/src/hardcoded.test.ts`）。

置き場は `packages/shared/src/i18n/` である。

- `keys.ts`：鍵の一覧（`MESSAGES`）。鍵ごとに、その文が受け取る引数の名前を並べる。
- `ja.ts` と `en.ts`：日本語と英語の辞書。どちらも `Record<MessageKey, string>` である。
- `keys/<領域>.ts`、`ja/<領域>.ts`、`en/<領域>.ts`：上の 3 つの中身。領域（鍵の最初の語）ごとのファイルに割ってあり、`keys.ts`、`ja.ts`、`en.ts` は、それらを束ねるだけで文を直に持たない。
- `messageSpec.ts`：領域のファイルが使う型（`MessageSpec`、`AreaDictionary`）。
- `language.ts`：言語の型（`'ja' | 'en'`）と、知らない値を既定へ寄せる `languageOf`。
- `t.ts`：辞書を引く `t(language, key, params)` と、言語を束ねた `translator(language)`。

鍵は `領域.部品.意味` の形にする。
画面の文は、領域を画面の名前にする（例：`session.kill.confirm`）。
サーバの文は、領域を資源か層の名前にする（下の「サーバでの引き方」）。
領域をまたぐものは、領域のところを `common` にする。
鍵を足すときは、その領域の `keys/<領域>.ts`、`ja/<領域>.ts`、`en/<領域>.ts` に同時に足す。
領域を足すときは、3 つのディレクトリに同じ名前のファイルを足し、束ね役の 3 つに 1 行ずつ足す。
辞書に鍵が足りないときも余っているときも、型検査で止まる。

辞書を領域ごとに割るのは、画面ごとの PR が並行して文を足しても、同じ行でぶつからないようにするためである。
ファイルの名前は領域の名前と同じにし、ファイルは自分の領域の鍵だけを持つ。
3 つのディレクトリが同じ領域のファイルを持つことと、束ねた表がファイルの鍵を過不足なく含むことは、試験（`layout.test.ts`）で見る。

文の中の `{名前}` は、`t()` に渡した値で置き換わる（`t('en', 'sessions.list.count', { n: 3 })`）。
引数の要る鍵に渡し忘れたとき、名前が違うとき、引数の無い鍵に渡したときは、型検査で止まる。
辞書の文の `{名前}` が `keys.ts` の名前とそろっていることは、試験（`t.test.ts`）で見る。
型をすり抜けて届いたものは落とさない。
辞書に無い鍵は鍵のまま返し、渡されなかった引数は `{名前}` のまま残す。

英語の複数形は、文の中に `{n|単数|複数}` と書く（`{n} {n|turn|turns}`）。
値が 1 のときだけ単数の形に、ほかは複数の形になる。
数そのものは `{n}` で別に書く。
日本語の文は複数形を持たないので使わない。
`{n|単数|複数}` の `n` も引数の名前として数えるので、鍵の一覧の引数と食い違えば試験（`t.test.ts`）で止まる。

言語の設定は、この PC の設定（`~/.agent-hangar/settings.json` の `language`、API では `SettingsDto.language`）に置く。
既定は日本語（`ja`）で、項目が無いうちは日本語として読む。
PC ごとの設定なので、クラウドへは同期しない。
読み書きはほかの設定と同じ `GET /api/settings` と `PATCH /api/settings` で行い、辞書に無い言語は 400 で断る。
手で書き換えた `settings.json` の知らない値は、読み込みのときに落とす。
切り替えの部品は、設定の「一般」の節の最初の行にある（日本語、English の 2 択。`views/SettingsScreen.tsx`）。
選んだ時点で保存し、UI はすぐその言語になる（読み直しは要らない）。
ステータスの札（Active、Paused、Done、Archived）は、どちらの言語でも英語のままである。

UI は、いまの言語を store の設定の 1 か所から受け取る。

- Presenter は `translatorOf(store)`（`presenters/i18n.ts`）で引く。
  Presenter は `(state, store, now)` の純関数のままで、言語を引数に足さない。
- View が自分で持つ決まった文は `useT()`（`views/primitives/language.tsx`）で引く。
  Root が `LanguageRoot` で言語を流し、頂点の無いところでは日本語になる。
  だから、View だけを描く試験は日本語の文のまま走る。

UI の日本語の直書きは、試験（`packages/ui/src/hardcoded.test.ts`）が止める。
`packages/ui/src` の試験でないソースを走査し、文字列、テンプレート、JSX の文のうち、かなか漢字を含むものが始まる行を、ファイルごとに数える。
数は許可の一覧（理由つき）と同じでなければ落ちる。サーバ側の `packages/server/src/i18n/hardcoded.test.ts` と同じ形である。
文を足すときは、辞書に鍵を足して引く。表示に出ない日本語（開発者向けのログなど）だけを、理由を添えて許可の一覧に足す。

#### サーバでの引き方

サーバが言語の設定を読むのは、`languageReader(settings)`（`packages/server/src/i18n/language.ts`）の 1 か所である。
これは「いまの言語を返す関数」を作る。
起動の組み立て（`boot/home.ts`）がこの関数を 1 つだけ作り、`HomeParts.language` として持つ。
`boot/` の各関数が、同じものを依存として配る。
受け取るのは、HTTP の経路と MCP の道具（`AppDeps.language`）、`RunManager`（Claude に渡す指示、シェルタブの名前）、`SummaryJob`（要約器への指示、要約の失敗の文）、`RetentionService`（保持期間を書けない理由）、画面の隅の知らせを作る所（メモの競合、1 回だけの同期、未分類のセッション）である。
どれも必須の依存で、渡し忘れは型検査で止まる。
関数は文を出すたびに呼ぶので、設定を変えれば、次の文から言語が変わる。
要約は、設定の言語で書かせる。

文を出す場所は 2 通りある。

- 境目（HTTP の経路、MCP の道具）は、`translatorOf(language)`（`i18n/message.ts`）で作った `tr()` で、その場で文にする。
  例：`c.json({ error: tr('project.error.notFound') }, 404)`。
- 境目より下の層（保存、検査、起動）は言語を知らない。
  失敗は、鍵と引数のまま投げる。
  例：`throw new RunError(400, msg('run.launch.dirMissing', { path: cwd }))`。
  `RunError`、`AccountError`、`ProjectCreateError`、`StateInputError`、`ToolError`、`SummarizerError` などは `MessageError` を継ぐ。
  境目は `errorText(language(), e)` で、そのときの言語の文にして応答に載せる。
  `message` は日本語の文のままなので、ログと、日本語の文を直に見ている試験は変わらない。

引数には、文字列と数のほかに、別の文と並びを入れられる。

- 別の文：`msg('run.launch.tmuxMissing', { label: msg('settings.label.tmuxPath') })`。
  設定の欄の名前も、外側の文と同じ言語で出る。
  別の失敗を理由として入れるときは `causeOf(e)` を渡す。
- 並び：`msg('mcp.args.oneOf', { field: 'status', values: STATUSES })`。
  その言語の区切り（`common.list.separator`）でつなぐ。

文をつなげて作らない。
前半と後半を別々に引いてつなぐと、言語で語順を変えられない。
場合が分かれるときは、場合ごとに 1 つの鍵にする（例：`project.promote.failedNothingMoved`、`project.promote.failedRolledBack`、`project.promote.failedLeftBoth`）。
何行かにわたる指示も 1 つの鍵にする。
Claude に渡す指示（`launch.injection.body`）と、要約器への指示（`summary.prompt.system`）がそうである。
英語の指示は、日本語の指示の意味（何をいつ呼ぶか、条件、してはいけないこと）を落とさずに訳し、行の数をそろえる。
行の数は試験（`t.test.ts`）で見る。

鍵の付け方の例は次のとおりである。

| 鍵 | 引数 | 使う場所 |
| --- | --- | --- |
| `project.error.notFound` | なし | プロジェクトを引く経路と、起動 |
| `run.launch.tmuxMissing` | `label` | 起動の前の検査 |
| `run.adopt.busy` | なし | 外部ターミナルの Claude を移すとき |
| `settings.path.notOnPath` | `label`、`name` | 設定の保存の検査 |
| `common.field.required` | `field` | 本文の項目の検査（経路をまたぐ） |
| `mcp.sessionStatus.pastReturnAt` | `returnOn`、`returnTime`、`now` | MCP の `propose_session_status` |
| `mcp.tool.setTurnIntent` | なし | MCP の道具の説明 |
| `launch.injection.body` | `projectName`、`projectPath`、`memo`、`todos` | `--append-system-prompt` |

英語の文は、用語集の英語の語と、Claude Code の公式の語（transcript、session、resume、permission mode、usage limit など）を使う。
日本語の文は、移す前の文のままである。
日本語の語の見直しは、画面の文を移すときに、用語集に合わせて行う。

辞書に入れていない文もある。

- ログにだけ出る文（`console.error` など）。
- 同期の層（`sync/`）のうち、画面に出ない文。
  同期の状態の失敗の理由、知らせの札、降ろせなかった本文の理由、DB の起動の失敗（古すぎる DB、控えが取れない）は、辞書に入れた（領域は `sync` と `db`）。
  辞書の文を持つ失敗は `MessageError` で、出す側（同期の状態、諦めた項目の記録、起動の失敗の札）がそのときの言語の文にする。
  出した時点の言語のまま残り、言語を変えても書き直さない。
  「この PC で再開」の写しの失敗（`sync/copy.ts`）も辞書に入れた。`RunError` で投げるので、経路がそのときの言語の文を JSON で返す（400 か 409）。
  残るのは、ログにだけ出る文、メモの控えのファイルの中身、Worker の日本語の前置きと照合する印である。
- 生成して置くスクリプトの中の文（シェル連携、起動の包み、ステータスライン）。
- 保存して同期する名前と要約（最初のアカウントの名前、スクラッチのプロジェクトの名前、機械的に作る要約）。
  言語は PC ごとの設定なので、書くときの言語で作ると、言語の違う PC が同じ行を互いに書き直し続ける。
  読むときに文にする作りへ変えるまで、日本語のままにする。

これらの残りは、`i18n/hardcoded.test.ts` が、ファイルごとの行数と残す理由の一覧で数えている。
一覧に無い日本語の直書きを足すと、この試験が落ちる。
「要約器を試す」の決め打ちの入力は、辞書の鍵（`summary.canned.text`）から、設定の言語の文を出す。

### 骨格

左にナビだけのサイドバー、上にヘッダー、残りがメインである。
ヘッダーは、中身の上に浮くガラスである（「見た目と動き」）。
サイドバーはガラスの板を持たず、項目だけを背景の上に並べる。裏に透かす中身が無い場所では、ガラスは白い板と同じになるからである。
2 つの項目（ホーム、プロジェクト）の下に「実行中」の節を置き、設定は下端に置く。節には、動いているセッション（入力待ち、作業中、休み、起動中）を 1 行ずつ並べる（`views/Sidebar.tsx` の `LiveSection`、並びは `presenters/shell.ts` の `sideLive` と `mediator/sidebar.ts`）。
セッション画面にいる間、ほかのセッションのどれが待っているかを横目で見て、1 押しで移るための場所である。入力待ちの札を当のセッション画面では出さないと決めたので、その置き場所でもある。
行は状態の点、名前、入力待ちなら待った時間（「待ち 4 分」）で、いま見ているセッションは白い行にする。並べるのは 8 件までで、超えたら「ほか N 件」を出し、押すと Home へ行く。動いているものが無ければ節ごと出さない。
行は掴んで上下に動かせ、入る場所に線を出す。キーボードでは、行に焦点があるときに ⌥↑ と ⌥↓ で 1 つずつ動かす。並びは端末ごとに localStorage（`sidebar.order`）に残す。
行を右クリックするか、行に焦点があるときに `.` を押すと、その行のメニューを出す。項目は「停止」の 1 つだけで、画面を移らずに Claude を終わらせるためのものである（2026-10-06 の決定）。言葉と色と確認はセッション画面の「停止」と同じで（`session.kill`）、作業中・入力待ち・シェルのタブがあるときは確認を挟み、休んでいるだけなら即座に止める。項目には「Claude を終わらせます。会話の記録は残るので、あとで再開できます」と添える。止めると行は消えるが席は残るので、知らせは出さない。hangar の外で動いているもの（生きた run が無い）は止められないので、押せない形で出して「hangar の外で動いています」と理由を言う。状態（Paused・Done）は載せない。会話の終わりと一覧の「⋯」で付けるもので、ここに置くと、付けたのに行が残って見えるからである。メニューを開いている行には印（`data-menu`）を付け、どの行のものかを見せる。面は `views/primitives/MenuButton.tsx` の `MenuPop` で、ボタンを持たずに、押した点か行の矩形に吊るす。「ほか N 件」に隠れた行には届かない。
並びは固定で、変えるのは利用者の手だけである。入力待ちになっても、出力が進んでも、行は動かさない。更新のたびに行が入れ替わると、置いた場所を目で覚えていられないからで、待ちは色と太字と待った時間で知らせる。動いているセッションが初めて現れたとき、Mediator がストアの顔ぶれ（`liveSessionIds`）を読んで、その id を並びの末尾に書き足す。ランタイムが知らせるのはストアが変わったことだけである。同時に現れたものは始めた時刻の古い順にする。Claude を抜けて行が消えても席は覚えておき、resume したら前後の行の間へ戻す。並べ替えは動いている行の席だけを入れ替え、抜けているセッションの席は動かさない。覚える id は 200 件までで、超えたら動いていないものを先頭の側から落とす。新しい行は末尾に入るので、9 本以上動いているときは「ほか N 件」に数えられる。
Home でも同じ行を同じ並びで出す。帯の「要対応」「実行中」の引き出しと同じ件が 2 か所に出るが、画面を移るたびに行が消えると、置いた場所で覚えていられないからである（2026-10-06 の決定。それまでは見出しと件数だけにしていた）。畳んだ帯では点だけを縦に並べ、名前は title に持つ。
「今日戻る」とプロジェクトの節は置かない。Paused の戻りは Home の帯と通知で、プロジェクトはサイドバーの「プロジェクト」と ⌘K と ⌘N で足りる（2026-10-05 の検討。Home のプロジェクトの 1 行は 2026-10-09 に無くなった）。
メインはヘッダーの下をくぐって流れ、ヘッダーの高さと隙間の分だけ上に余白を取ってから始まる。
`.app` では標準のタイトルバーを消し、信号の 3 点をヘッダーの左端に乗せ、ヘッダーの空いた所を掴んで窓を動かし、そこをダブルクリックすると窓が拡大する。
そのために、UI の出どころ（`http://127.0.0.1:4177`）に窓を動かす権限（`core:window:allow-start-dragging`）とダブルクリックで拡大する権限（`core:window:allow-internal-toggle-maximize`）の 2 つだけ与え（`capabilities/remote-drag.json`）、殻は頁に `data-shell="desktop"` の印を付けて、ヘッダーのロゴはその印があるときだけ信号の 3 点の右から始まる。
印は読み込み画面にも付け、失敗の札のロゴも同じく信号の 3 点の右から始める。
Windows の窓は標準の枠（タイトルバーと最小化、最大化、閉じるのボタン）にする。
`titleBarStyle`、`hiddenTitle`、`trafficLightPosition` は macOS の装飾なので、`tauri.windows.conf.json` が窓の定義を、それらを外して `decorations: true` にしたもので置き換える（配列は丸ごと置き換わるので、窓の名前と大きさは `tauri.conf.json` の写しで、一致は試験で縛る）。
殻は Windows では `data-shell` の印を付けないので、ヘッダーのロゴと失敗の札のロゴは既定の余白（16px）から始まる。
入力待ちを窓の外へ知らせるために、同じ出どころには通知を出す権限（`allow-notify-waiting`）、通知の許可を求める権限（`allow-notify-request`）、通知の許可の状態を読む権限（`allow-notify-status`）、Dock のバッジに数を出す権限（`core:window:allow-set-badge-count`）の 4 つだけを別に与える（`capabilities/remote-notify.json`）。
前の 3 つは殻が自分で持つコマンドで、`build.rs` の AppManifest に並べたものだけが権限になる。
殻の命令は 7 つだけ持つ（`src-tauri/build.rs` の一覧と `lib.rs` の `#[tauri::command]`）。
入力待ちの知らせの 3 つ（`notify_waiting`、`notify_request`、`notify_status`）は上に書いたとおりで、フォルダ選択の `pick_folder` は新しいプロジェクトのために頁へ許し、残りの 3 つは障害のときの操作である。
殻は命令を `invoke_handler` の 1 か所でまとめて登録する。
2 度呼ぶと後のものだけが残り、先に並べた命令が呼べなくなるからである。
UI の出どころには、設定の同期の適用の `apply_config_sync` と世代へ戻す `restore_config_sync` だけを別に与え（`capabilities/remote-config-apply.json`。どちらも殻がネイティブの確認を出してから CLI を走らせる。「設定の同期の作り直し」の節）、フォルダ選択の `pick_folder` だけを別に与え（`allow-pick-folder`、`capabilities/remote-pick-folder.json`）、ログを開く `open_log` とアプリを再起動する `restart_app` だけを与え（`capabilities/remote-shell.json`）、起動画面（殻の中の頁）には、起動をやり直す `retry_boot` と `open_log` だけを与える（`capabilities/boot-screen.json`）。
`open_log` は決まったファイル `~/.agent-hangar/desktop.log`（無ければ空で作る）を `open`（Windows は `rundll32.exe url.dll,FileProtocolHandler`、サーバが URL を開く形と同じ）に渡すだけで、呼び手からパスは受け取らない。
UI は殻が差し込む `__TAURI_INTERNALS__` の有無で殻の中かを決め（`runtime/desktop.ts`）、殻の外（ブラウザ）ではこれらのボタンを出さない。
接続が切れると、ヘッダーの下に切断の帯を出し、止まった時刻と次に再接続する秒数を言う。
再接続が 3 回続けて失敗したら、同じ帯のまま濃い赤にして「サーバに戻れません」「アプリを再起動してください」と言い、殻の中では「ログを開く」「再起動」を、ブラウザではログの場所（`~/.agent-hangar/desktop.log`）の文とコピーのボタンを置く。
サイドバーの項目は Home と Projects の 2 つで、設定は「実行中」の節の下、帯の下端に置く。セッションの一覧の項目は無い。プロジェクトの一覧は置かない。
Home の項目には、入力待ちがあるあいだその数を添える（開いた帯では項目の右端の赤い錠剤、畳んだ帯ではアイコンの右上の小さな丸）。
数え方は shared の `liveFilterOf` に従い、読み上げでは「ホーム、入力待ち 2」と何の数かを言う。
開閉のボタンは、開いた帯では Home の行の右端に、畳んだ帯では帯の一番上に置く。
ヘッダーは殻の 2 列（サイドバーの列と本文の列）をそのまま使う（subgrid）。
左の列にロゴ（図と Hangar_）を置き、サイドバーを開いても畳んでも同じ形、同じ場所に置く。開閉のたびに図のハンガーが振り子で揺れる。
右の列には、「移動・操作」の錠剤、同期の状態、Claude の利用上限の 2 つの枠の使用率のゲージ、新しいセッションのボタンを置く。
同期の一行は状態を示すだけで、ボタンは持たない（`views/SyncStatus.tsx`）。
状態の点、語、件数を並べ、語（リンク）を押すと設定のクラウド同期の節へ移る（`#/settings?at=sync`）。
今すぐ同期、一時停止、参加トークンは、設定のクラウド同期の節にあり、ヘッダーからは操作しない。
状態は 4 つで、同期済み（「同期 3 分前」、緑の点）、一時停止（「同期を一時停止中」、灰の点）、エラー（「同期エラー: 理由」、赤い点）、同期オフ（「同期オフ」、塗らない輪の点）である。
上限で退いている間は「無料枠で停止 · 9:00 にリセット」と赤い点で言い、利用者が止めたのと見分ける。
件数は、未送信の変更、未送信のトランスクリプト、送信に失敗したトランスクリプトを、0 件のときは出さずに並べる。
語は `header.sync.*` の鍵から、設定の言語で引く（Presenter の `presenters/syncLabel.ts` が、設定の「状態」と同じ表を共有する）。
まだ同期の状態が届いていない間は、「同期オフ」と言い間違えないよう、一行ごと出さない。
ゲージは棒の前に見出し「5 時間」「週」を常に出し、読み上げの名前は「5 時間枠の使用率」「週の枠の使用率」にする。
ホバーの title には、statusline の `resets_at` から枠が戻る時刻を「5 時間枠の使用率 28%、18:00 に戻ります」の形で添える（今日でなければ月と日も添える）。
最終更新があれば、それも title に添える。
2 つの枠のどちらも一度も届いていない間は、空の棒を並べず「使用率 未取得」の 1 語にまとめ、押すと Settings へ行く。
窓が狭いときは、右の列の部品を優先度の低いものから順に畳む。
決め打ちの幅では畳まない。
同期の文と件数は長さが変わるので、決め打ちの幅ではそれに追いつかず、同期の一行がゲージに重なって描かれたからである。
代わりに、段ごとに右の列で要る幅を描画の直後（塗る前）に測り、収まる最初の段を選ぶ（`views/headerFold.ts` の純関数と `views/useHeaderFold.ts`）。
測り直すのは、行の幅が変わったとき（窓とサイドバーの開閉）、描き直したとき、字形を読み込んだときである。
戻すのは、戻した段が 24px のゆとりを持って収まるときだけにし、ちょうどの幅で段が行き来してぴくぴくするのを防ぐ。
畳む順は、最終更新、アカウントの名前、索引の進み、同期の件数（未送信の変更、未送信のトランスクリプト）、ゲージの棒、錠剤の文字とキー帽、同期の状態の文、新しいセッションの文字、ゲージ（見出しと数字ごと）である。
状態の点はリンクの中にあるので、文を畳んでも点を押せば設定のクラウド同期の節へ行ける。
送信に失敗したトランスクリプトの件数は誤りなので畳まない。
ゲージの見出しは、ゲージを出している間は隠さない。見出しの無い数字は何の割合か読めないので、畳むときはゲージの組ごと畳む。
畳んだ部品は見えなくするが読み上げには残し、件数と最終更新はリンクとゲージの title からも読める。
測る仕組みが追いつかない一瞬や、測れない環境でも重ならないよう、右の列の部品はどれも 0 まで縮み、はみ出しは省略記号か切り詰めにする。
錠剤の左端は本文（各画面の見出し）の左端にそろえ、どの画面へ移っても動かない。
ただしセッション画面だけは本文の幅の上限（`--main-w` の 1200px）を外すので、窓が広いと本文と錠剤がほかの画面より左へ寄る（UX 刷新 2 の案 b、利用者が受け入れた）。
錠剤の位置の式は変えず、殻の `data-wide` の印でその画面の `--main-w` だけを外す。
畳んだ帯ではロゴが列の外まで伸びるので、窓が狭い間は錠剤がロゴの右から始まる。
本文は、どちらの帯でも左の余白を 16px（`--gutter-l`）にして、帯のすぐ右から始める。
ロゴを避ける式（`max(16px, ヘッダの右端 − 帯の幅 − 箱の左)`）は `--gutter-head` に移し、使うのはヘッダの検索欄だけにする。
そのため、帯を畳んでいる間は本文の左端と錠剤の左端が揃わない（利用者の決定。`docs/superpowers/specs/2026-10-02-session-motion-design.md`）。
本文の幅の上限（1200px）で中央に寄っている画面は、今までどおり中央のままである。
今いる場所はヘッダーでは示さず、各画面の一番上の見出しで示す（設計は `docs/superpowers/specs/2026-10-01-page-heading-design.md`）。
見出しは 18px の太字で、下に 1px の線を引いて本文と分け、上に親へのリンクの行（セッションなら属するプロジェクト、プロジェクト詳細なら一覧）を置く。
親の行は親の無い画面でも同じ高さを取り、どの画面でも見出しと線の高さがそろう。
窓の大きさは、最小の 900×600 から広い画面まで崩さない。
高さの決まったボタンの文字は折り返さず、長い名前（サブエージェントの ID など）は省略記号で切る。
見出しの行に操作のボタンが入り切らないときは、ボタンの名前を隠して印だけの丸いボタンにし、名前は title と読み上げに残す（`PageHeading` の `fitRow` が行の幅を測って `data-compact` を付ける）。
ボタンが自分の title（セッション画面の主の操作の押せない理由など）を持つときは、縮めても消さず、名前の後ろに添える（「再開（本文がありません）」）。
並ぶボタンは画面の状態で増減し、字の大きさでも幅が変わるので、決まった幅で切り替えず、実際にはみ出すかで決める。
Home とプロジェクト詳細では、一覧が窓の下端までの残りの高さを受け取る（`.screen-fill`）。
セッション画面でも本体（左の主役と右の目次、`.c-body`）が残りの高さを受け取るが、組み方はセッション詳細の節に書く（`.session-screen`）。
上の帯の高さは折り返しで変わるので、`100vh` から決め打ちで引かない。
板には下限を持たせ、それより低い窓では本文の列がスクロールする。
プロジェクトの表は幅が狭いと列を落とし、Home の絞り込みは入り切らなければ次の行へ送る。
崩れは WebKit で窓の大きさを変えながら機械的に拾って確かめる（折り返したボタン、箱からのはみ出し、途中で切れた文字、窓の外の要素）。

「移動・操作」の錠剤は打つ欄ではなく押すボタンで、虫眼鏡、「移動・操作」の文字、⌘K のキー帽を並べ、幅は中身の分だけにする（案 A1）。
押すか、/ か ⌘K でコマンドパレットを開く。
狭い幅では文字とキー帽を畳み、虫眼鏡だけの丸いボタンにする（上の畳む順の 6 段目）。
パレットは、動いているセッションへの移動、主要な操作、設定の節への移動に絞る（探すのはホームの欄で、名前、要約、トランスクリプトを引く。段 4 の 2.11.1、案 B）。
ヘッダーの錠剤の語は「移動・操作」で、パレットの入力欄の案内は「セッションへ移動、または操作を実行」である。

パレットは、何も打っていないときは群の見出しを付けた 1 列に並べる。
群は上から入力待ち、最近（終わったセッションの新しい順、上位 3 だけを添え、全件の数は書かない）、操作、設定の 4 群で、空の群は出さない。
入力待ちが 4 本の朝でも、4 群で 16 行に収まり、1 画面に入る。
作業中とアイドルの名前は、サイドバーの「実行中」にあるので出さない。プロジェクトの群も出さない。
入力待ちの見出しには群の全件の数を添える。
動いていないセッションの点は描かず、場所だけを残す（一覧の行も同じ）。終わった行がどれも同じ灰色の点になると、作業中と入力待ちの色を拾いにくくなるからである。
セッションの行は状態の点、名前、プロジェクト名を並べ、右端に待った長さ（「4 分待っている」）、終わったものは最後の活動の時期を添える。
操作は新しいセッション、クイックセッションを開始、次の入力待ちへ（移る先の名前を添える）、新しいプロジェクト、キーの一覧で、打鍵のあるものはキー帽を添える。
新しいセッションは ⌘N と同じく、いまの画面のプロジェクトを最初から選ぶ。
設定は一般、クラウド同期、連携、トランスクリプトの保持の 4 行で、行には「設定」と添える。押すとその節へ移る（保持は一般の節の中にあるので、一般へ移る）。
打ち始めたら、入力待ちと実行中（作業中とアイドル）の名前、終わったセッションのうち新しいほうの 20 件の名前、操作、設定の節に当て、群は分けたまま、群ごとに 8 件で切る。
操作には、何も打っていないときは出さない行（ホームへ、プロジェクトへ、サイドバーの開閉、索引を作り直す）が加わり、設定には要約エンジン、ツール、情報の節が加わる。設定の節は添え書きの「設定」でも当たるので、「設定」と打つと節がそろって出る。
終わった古いセッションの名前、要約、プロジェクトの名前は、パレットでは引かず、ホームの欄で引く。
群の並びは、いちばんよく当たった行の点の高い順にし、同点なら何も打っていないときの順にする。
決まった順のままだと、名前に散らばって当たったセッションが、名前の頭から当たる操作や設定の節より上に来るからである。
最後の行はいつも「ホームで『語』をトランスクリプトから検索」で、選ぶか ⌘↵ でホームへ移り、欄に語を渡す。
行の右に、同じ語をホームの欄に打ったときに並ぶ行の数（名前、要約、トランスクリプトの重なりを除いた全件、Archived を除く）を「12 件」と添える。
件数は、打ち終えて 250 ミリ秒待ってから `GET /api/search`（`limit` 1、`hideArchived`）で 1 回だけ引き、引けるまでと、引けなかったときは添えない。画面の Store にも Mediator にも入れず、Root の中だけで持つ。
名前にも操作にも 1 つも当たらなければ「名前にも操作にも一致しません。」と言い、ホームへ渡す行だけを出す。
下の縁には打鍵の案内（↑↓ 選ぶ、↵ 開く、esc 閉じる）を置き、右端に「トランスクリプトはホームの欄で」と添える。
一覧の高さは、窓の高さに合わせて縮む（最大 640px）。

### アカウントの切り替え

Claude Code のアカウントを複数持ち、切り替えて使えるようにする（設計は `docs/superpowers/specs/2026-10-06-account-switch-design.md`）。
アカウントごとに変わるのは認証だけで、設定、スキル、履歴は `~/.claude` を共有する。
hangar はトークンを読まず、渡すのは `CLAUDE_CONFIG_DIR` だけである。

「いまのアカウント」を hangar 全体で 1 つ持つ。
プロジェクトごとに前回のアカウントを覚える形にしないのは、持つ値を 1 つに保ち、新しいセッションの既定をいつも同じ理由で説明できるようにするためである。

ヘッダは、いま見ているものに効いているアカウントを出す。
ホームや一覧ではいまのアカウント、セッション画面ではそのセッションを最後に動かしたアカウントである。
色の点と名前を、使用量の計器の前に置く。
計器の値も、そのアカウントの値に替える。
セッション画面でホームと同じ名前を出すと、いまのアカウントとこのセッションのアカウントが食い違うときに、計器がどちらの値か分からなくなるためである。
窓が狭いときは、ほかの表示と同じ順で畳み、名前を隠して色の点だけを残す。

アカウントが 1 件のときは、画面は今までと何も変わらない。
ヘッダに点も名前も出さず、新規セッションのダイアログに段を足さず、セッション画面に札を出さない。
アカウントの節があるのは設定だけで、1 件でも追加の入口として出す。
複数のアカウントを使わない人の画面に、使わない部品を置かないためである。

アカウントが 1 件のときも、計器はそのアカウント（最初のアカウント）の値から作る。
使用率は `accounts.update` だけで配り、最初のアカウントの値だけを運ぶ別の知らせは持たない（段 1 で `usage.update` を消した）。

ヘッダの名前を押すと、アカウントごとに 1 枚の札を並べた一覧が開く。
札は名前、プラン、メールアドレス、5 時間と週の使用量、戻る時刻を持ち、下に「アカウントの設定」を置く。
未ログインの札と、初めてのログインの途中の札は選べない。
切り替えても動かないアカウントを選ばせないためで、右上の「切り替える」を空にし、理由は札の中身が言う。
ログイン済みのアカウントをログインし直している途中は、いまのログインがまだ生きているので選べ、メールアドレスを出したまま承認を促す一言を添える。
未読の札（認証の状態をまだ読んでいないもの）は選べる。
開くたびに一覧を取り直し、認証の状態はこのときにまだ読んでいないものだけを読む。
サーバの起動時には読まない。

ホームや一覧で選んだときは、いまのアカウントが変わるだけで、動いているセッションには触らない。
セッション画面で選んだときは、確認を挟み、そのセッションを選んだアカウントで再開し直して、いまのアカウントも変える。
Claude をいったん止めて再開するので、確認は止める旨を言い、作業中なら「途中の作業が中断されます」と添える。
止めて再開するだけなので、確認は危険の赤にはせず、外のターミナルの引き取りの確認と同じ強さにする。

新規セッションのダイアログは、札の列のプロジェクトの次に「アカウント」の札を置く（2 件以上あるときだけ）。
札は色の点と名前を見せ、押すと開く一覧に、色の点つきでアカウントを並べる。
選んでいる札の初期値はいまのアカウントで、そのセッションだけ別のアカウントにでき、ダイアログで選んでも、いまのアカウントは変えない。
ダイアログは選んだアカウントを必ず起動の params に載せる。
いまのアカウントが変わったあとに、ダイアログが別のアカウントで起こしてしまうことを避けるためである。
未ログインと初めてのログインの途中の行は選べず、理由（「未ログイン」「ブラウザで承認してください…」）を行に書く（ログインし直しの途中は選べる）。選んでいた札が選べなくなったときは、初めの選び方（いまのアカウント、選べなければ最初の選べる札）へ戻す。
使用量の計器と注記は、ヘッダの一覧とアカウントの設定に任せ、この札には出さない。

セッションの一覧（ホームとプロジェクト詳細の行）には、アカウントの印を出さない。
絞り込みの `account:名前` も持たない。
アカウントはセッション画面の (i) のポップオーバーに、色の点と名前で出す。

上限に当たったときに、自動でほかのアカウントへ切り替えることはしない。
切り替えを勧めて選択を動かすこともしない。
注記は出すが、選ぶのは利用者である。
どのアカウントに会話の本文が送られるかは、利用者が決めることだからである。

アカウントの追加、名前と色の変更、ログイン、外すことは、設定の連携の節にある「アカウント」の項で行う。
追加は名前を入れて「追加してログイン」を押すだけで、置き場を作ったあと、すぐに `claude auth login` を子プロセスで始める。
ブラウザは claude が開くので、利用者が承認する。
終わると、読んだメールアドレスとプランが行に出るので、どのアカウントを承認したかをそこで確かめる。
ログインを始められなかったとき（claude が見つからない、すでに走っている）は理由をトーストで言い、ログインの途中の行には「やめる」を置く。
最初のアカウントは外せない。
外す前に確認を挟み、置き場は消さずに登録だけを外すと言う。

### Home

上から順に、40px の帯、一覧の見出し、状態のタブ、検索の欄と絞り込みのボタン、平らな一覧を 1 列に置く（試作は `docs/superpowers/specs/2026-10-09-home/options.html` の B）。
一覧が主役で、入力待ちや実行中などの札は帯に畳む。
セッションの一覧の画面は 2026-10-09 に無くなり、その中身はこの下半分へ移った（`views/HomeScreen.tsx`、`views/HomeBand.tsx`、`views/SessionList.tsx`、`presenters/home.ts`、`presenters/sessions.ts`）。
`#/sessions` と `#/sessions?q=` は、殻のディープリンクと利用者の履歴に残っているので、ホームを開く別名として読み続ける（`parseRoute` は `{ name: 'home', q }` を返し、`formatRoute` は `#/` と `#/?q=` を書く）。
始める前の確認は、直すものがある間、帯の最後の群（錠剤と引き出し）になる（`presentReadiness`、試作は `docs/superpowers/specs/2026-10-09-small-screens/options.html` の始める前の確認の B）。
初めての人だけでなく、直すものがある間は誰にでも出す。
UI は起動のたびに `GET /api/readiness` を取る。
tmux、claude、node の版は子プロセスで読むが、同じファイルなら覚えた版を返すので、起こすのは起動後の最初の 1 回だけである。
手元の実測では、その最初の 1 回が 20 ms 以下、2 回目からは 1 ms 未満だった。
画面は取れるのを待たずに描き、取れたら帯に群を足す。
錠剤は「セットアップの確認 6 つ中 3 つ」の形で、済んだ割合の細い棒を添え、帯の右端に「もう始められます。設定の残りは 3 件です」を出す（tmux か claude が欠けているときは「始めるには tmux と claude が必要です。設定の残りは 3 件です」。Windows では tmux を psmux と言う）。
錠剤の要約は「設定の残り 3 件」である。
英語では「You can start now. 3 items left to set up」「You need tmux and claude to start. 3 items left to set up」「3 items left to set up」で、1 件のときは「1 item」と単数にする。
分母は任意の行も含めて数える（`compat` の無い古いサーバの答えでは互換の行が無く 5 になる）。
行は、tmux、claude、プロジェクトの親フォルダ、MCP サーバー、ステータスライン、Claude Code との互換性の 6 つである。
判定は設定画面の欄の下の検証と同じもの（`toolLine`、`workspaceLine`、`compatState`）を使う。
引き出しには、直すものだけを 1 行（36px）ずつ出す。
必須の行を先に、任意の行（MCP、ステータスライン）を後ろに並べ、任意の行には「任意」の札を付ける。
行は、状態の印（✗ と !。読み上げの名前にも状態を入れる）、名前、説明、薄い命令、右端のボタン 1 つである。
ボタンは、tmux が見つからないときと MCP とステータスラインでは「コマンドをコピー」、そのほかでは「設定を開く」である。
tmux の行は、Windows では psmux の名で出し、入れるコマンドは OS で変える（Windows は `winget install marlocarlo.psmux`、ほかは `brew install tmux`）。
見つからないときの文は「psmux がインストールされていません」で、右端に「再確認」を足して 2 つのボタンにする（段 6 の B1）。
再確認しても無ければ「psmux がまだ見つかりません。インストールしたあと、Hangar の再起動が必要な場合があります」に替え、確かめている間はボタンを「確認中…」にする。
見つかれば行は済んだ側へ移り、必須がそろえば群ごと消える。

psmux（tmux）が無いと分かっているときに、新しいセッションの開始、再開、フォーク、この PC で再開を押すと、送らずに案内のダイアログで止める（段 6 の B2、`mediator/muxGuide.ts`、`views/MuxGuideDialog.tsx`）。
hangar に移動（adopt）と接続（attach）も止める。
adopt は外の claude を終わらせてから hangar の tmux で起こすので、無いまま進むと元の会話を止めたまま失敗するからである。確認の前でも、確認で承諾した後でも止め、見つかれば止めた操作から続ける（確認の前なら確認を出す）。
attach は Claude のバックグラウンドのサービスにつなぐが、つなぐ口（`claude attach`）は hangar の tmux のペインで起こすので、無ければ断られる。
準備の確かめが届く前は止めない。
ダイアログは、要ることと入れるコマンド（コピー付き）、「キャンセル」と「インストールしたので再確認」を持つ。
新しいセッションのダイアログから来たときは、キャンセルでそのダイアログへ戻る。
再確認で見つかれば「psmux を確認しました」と版を出し、「開始」で止めていた操作をそのまま送る。
幅が 1100px 以下のときは、命令を隠してボタンだけにする。
済んだ行は、引き出しの末尾の 1 行（「tmux、claude、Claude Code との互換性は準備完了」）に畳み、押すと見つかった場所の行が開く。
互換は、未確認の版を済んだものに数え、ずれのときだけ直すものに入れて、設定を開くボタンを置く。
止めた機能の一覧とずれの表は、設定の「連携」の群の節にある。
必須の行がすべて済んで任意の行だけが残ったとき、または全部そろったときは、群ごと消える。
直す行があった後で消えたときだけ、トーストを 1 回出す（`runtime.ts` の `loadReadiness`）。
全部そろったなら「セットアップは完了しています。設定の「情報」でいつでも確認できます」、任意の行が残るなら「必要な準備は完了しました。MCP とステータスラインは設定の「連携」で設定できます」である。
起動して最初に取った結果がはじめから問題の無いものなら、出さない。
要対応、実行中、確認待ちがどれも 0 件のときは、その薄い 3 つの錠剤を出さず、確認の群だけを開いた形で置く。
このとき、帯の代わりの「実行中のセッションはありません」の 1 行は出さない。
セッションが 1 つも無い人には、一覧の空の札に「クイックセッションを開始」と「新しいセッション」を残す。
空の札を出している間は、1 行のほうも出さない。
Claude Code の保持期間がユーザー設定に無い（既定の 30 日）あいだは、ヘッダーのベルの一覧に保持期間の行を出す（「ベルと知らせの出し分け」の節と「会話の保持期間」の節）。ヘッダーの下に帯は出さない。
### Home の帯と引き出し

帯は 40px で、要対応、実行中、確認待ちの件数を 3 つの錠剤で並べる（`presentHomeBand`）。
場所の不明なプロジェクトの錠剤は、この PC で場所が消えたものがあるときだけ、確認待ちの後ろに 4 つ目として足す（`presentUnresolved`。`presentHomeBand` の `extra` に群を渡す作りで、群を足すだけで増える）。
件数に入れるのは、この PC で場所が消えたものだけで、他の PC から届いただけのものは数えない（「プロジェクトの同定」の節）。
この群は朝に開く群にしない。引き出しの行は、フォルダの印、名前、セッションの数、前のパス、「場所を再指定」「Archived にする」「一覧から削除」である。
始める前の確認の群があるときは、場所の不明なプロジェクトが先、確認が最後に並ぶ。
要対応は、入力待ち（`waiting`）のセッションと、今日戻る Paused の合計である。
実行中は作業中、休み、起動中（hangar の run は生きているが Claude の一覧にまだ載っていない）と、裏だけ動いているものを数え、入力待ちは含めない。
確認待ちは、TODO の完了の候補と、セッションの状態の提案（「Done にする？」「Paused に 10/3（土）？」）の合計である。
0 件の群は薄い札にして押せない。
錠剤は Enter と Space で開閉できる本物のボタンで、読み上げの名前は「要対応 3」の形で件数を含み、開いているかを `aria-expanded` に出す。
押した群だけが帯の下に引き出しで開き、1 件を 1 行（40px）で読む。引き出しは 1 つずつしか開かない。
朝に開いたときは要対応が開いている。要対応が無ければ実行中、それも無ければ確認待ちを開く（`morningGroup`）。
どの引き出しが開いているかは View の中に持ち、Presenter と Mediator は朝に開く群だけを決める。
検索の最中（語か触ったファイルで探しているとき。`usesServerSearch` と同じ）は引き出しを閉じ、錠剤を件数だけの札にして、帯の右に「検索中は引き出しを閉じています」と添える。
検索が終われば元の開き方へ戻る。タブ、期間、プロジェクトだけの絞り込みは検索ではないので、引き出しは開いたままである。
要対応と実行中と確認待ちがどれも 0 件のときは、帯の代わりに高さ 44px の 1 行を置き、「実行中のセッションはありません」と「新しいセッション」「クイックセッションを開始」を出す。
ただし、場所の不明なプロジェクトか始める前の確認の群があるときは、静かな日として扱わず、1 行は出さない。薄い 3 つの錠剤も出さず、足す群だけを帯に置く（`presentHomeScreen` の `quiet`）。
引き出しの行は、行頭の印（状態の点、戻る日や提案の札、TODO の印）、名前、プロジェクト名の添え、本文、右端の文字とボタンを並べる。
要対応の行は問いの文と待った時間を出し、ボタンは「ターミナルで回答」（hangar の端末か、Claude のバックグラウンドのサービスにつなぐとき）か「hangar に移動」（別のターミナルで動くものを引き取るとき）で、押せる手が無いときは「開く」だけにする。
ボタンの手は、その場では答えさせず、端末を開いてフォーカスするだけである。端末の TUI を外から操ることになって壊れやすいからである。
引き取りは外のターミナルの claude を終わらせるので、押すと確認に回る（`session.adopt`）。
今日戻る Paused は、戻る日の札、名前、プロジェクト、理由を並べ、「開く」「日付を変更」「Done」を置く。
戻る日が今日か過ぎたものに加え、日付が欠けたり壊れたりしたものも、利用者が決めるまで出す。
時刻つきは時刻の前から出し、塗るのは戻る時刻を過ぎてからにする。
実行中の行は、作業中なら Claude がこのターンに書いた意図を本文に、いまの手（ツール名と対象）を等幅の詳細に出し、休みと起動中は一言の文を本文にする。右端には作業中の経過時間とコンテキスト使用量を出す。
意図とツール呼び出しは、帯の「実行中」を押して引き出しを開くまで見えない（2026-10-09 の利用者の決定。それまでは実行中の札が開いた直後から見せていた）。
墨の 1 行の中の長い絶対パスは、末尾の 2 階層だけにする（`presenters/format.ts` の `shortenPaths`）。頭から出すと、どれも同じ頭で始まり、違いのある末尾が省略で消えるからである。
Windows のパス（`C:\…`、`\\server\…`、`~\…`）も同じに縮め、元の区切りで書く。
意図は、Home を見ている間は動いているセッションの分を取りに行く（1 秒に 1 回まで）。書かれていなければ出さない。
確認待ちの行は、TODO の完了の候補とセッションの提案を、候補になった時刻の古い順に混ぜて並べる。
TODO の行は半分塗りの印、本文、プロジェクト名と経過時間、根拠の一文（無ければ「根拠は書かれていません」）、「確定」「却下」を置き、本文を押すとそのプロジェクトの画面へ移る。
セッションの提案の行は枠だけの札（「Done にする？」など）、名前、根拠を置き、「確定」「日付を変更」（Paused のときだけ）「却下」を押せる。
ボタンの読み上げの名前は見える語と相手の名前を含む（「確定、窓を掴める（alpha）」）。別のプロジェクトに同じ本文の候補があっても、名前は 1 つに決まる。

引き出しの行の「いま何をしているか」と「待っている問い」は、サーバが索引の追記を読む経路（`indexFile`）で主線の出来事を畳んで取り出す。
最後の `tool_call` の名前と要約を残し、それが AskUserQuestion なら入力の最初の問いの文も残す。
その呼び出しへの `tool_result` が来たら、答えが済んだとして問いを消す。
hangar が起こした run では、問いの文を hook からも受け取る（「起動」の節の `--settings`）。
受け口は `/mcp/s/<sessionId>/hook` で、run の MCP の秘密で開く。hook の会話（`session_id`）が URL のセッションのものでなければ書かない。
`PreToolUse` で同じ表へ問いを書き（`sessions/questionHook.ts`）、`PostToolUse` と `PostToolUseFailure` でその呼び出しの問いを消す。
索引はこの行を前の値として本文を畳むので、同じ呼び出しが本文に載っても問いは残り、その答えが載れば消える。
本文が答えの時まで呼び出しを書かなくても、入力待ちの間に問いの文が出る。
値は端末ローカルの表 `session_activity`（マイグレーション version 9）に置き、共有テーブルにも同期の changes にも入れない。
`SessionDto.activity`（`{ tool, summary, question }`）は実行中のセッションにだけ値を持ち、実行中でないときと、呼び出しがまだ無いときは `null` になる。
Home を開いたときにトランスクリプトを読み直すことはしない。
主線のトランスクリプトを忘れさせたとき（`forgetTranscriptFile`）は、そのセッションの `session_activity` の行も一緒に消す。
実行中の登録（`~/.claude/sessions/<pid>.json`）から消えたセッションは、問いだけを消す（`sessions/liveChange.ts`）。終わった会話の問いにはもう答えられず、再開した直後の要対応の行に前の run の問いを出さないためである。
消えたかどうかを書きかけの登録で誤らないよう、読めなかった登録は前に読めた中身のまま少しの間続ける（「保存先と読み方」の節の `RegistryCarry`）。

### Home の一覧

帯の下に、一覧の見出し「セッション N 件」（N は手元の全件で、Archived を除く）、状態のタブ、検索の欄と絞り込みのボタン、条件の行、行を置く。
一覧はいつも平らで、節（今日戻る、確認待ち、Active、Paused、Done）には分けない。状態のタブで絞る。
並びは、生きているものを先に（入力待ち、作業中、休みの順）、残りを新しい順にする。止まっている Done だけは、Done にした時刻の新しい順にする。
帯に出したセッションも一覧に並ぶ。
状態のタブ（すべて、確認待ち、Active、Paused、Done、Archived）は件数つきで、いつも出す。件数は条件に関わらず手元の全件を行の持ち物で数える。
確認待ちの数字は、1 件以上あれば候補の色で灯す。0 件のタブは淡くする。「すべて」は Archived を除いた数で、条件を入れたときに並ぶ行の数え方と同じである。
セッションの状態は Active、Paused、Done、Archived の 4 つで、状態が無いものを Active と呼ぶ。動いているかどうかは状態ではなく、行の丸い点で見せる。
「すべて」で条件を入れたときは Archived を除く。
検索の欄は `is:` `since:<n>d` `project:` `file:` のトークンを受け、欄を正とする。タブと絞り込みはその表示で、効いている条件は欄の中のチップになる。読めないトークンは語として本文を探し、欄の下で知らせる。
欄は名前、要約、トランスクリプトを引き、欄の札 3 つ（名前、要約、トランスクリプト）でその旨を言う。
語で探しているときは、結果を「名前に一致」「トランスクリプトに一致」の見出しで分け、要約に当たった行には「要約に一致」の札を付ける（サーバの `SearchHitDto.matched` から作る。「検索」の節）。
欄の横の「絞り込み」のボタンを押すと、欄の下に絞り込み（プロジェクト、期間、操作したファイル）が開く。ボタンには、その中で効いている条件の数を印で出す。語、状態、動きは欄とタブが言うので数えない。
絞り込みが開いているかは View の中に持つ。
条件（語、プロジェクト、期間、状態、操作したファイル）が 1 つでも効いていれば、条件の行を出し、効いている条件を並べ、「条件をクリア」と件数を置く。ただし状態のタブだけで絞っているときは出さない。選んだタブと欄の札が、同じ条件と件数を既に言っているからである。
「条件をクリア」は `search.clear` で、語と絞り込みをまとめて外し、語の無い一覧の URL へ移る。
行は 2 段で、1 段目に名前とプロジェクト名（無ければ「未分類」）、2 段目に要約の見立ての札と、要約の 1 文か検索の抜粋（最初の 1 つ。一致した語に淡い印）を出す。2 段目の右端には、PR の番号（`/pull/<番号>` の URL の末尾。取れなければ「PR」とだけ出し、押すと外のブラウザで開く）とノートの印を置く。
行の頭には状態の札（Active、Paused、Done、Archived。提案があれば枠だけの提案の札）を置き、押すとそのタブへ移る。
右端には、本文の期限が 7 日以内なら琥珀の「まもなく削除」を、保持期間で本文が消えたとみられるなら文字の無い印を、時刻の左に添える。Paused の行の時刻の列は戻る日である。
2 段目の頭には要約の見立ての札を置く。
色を付けるのは「詰まっている」（入力待ちの色）と「やめた」（Paused の色）の 2 つだけで、「やりかけ」「済んだ」は注記の色の語だけにする。
色の札が 2 種しかないので、一覧を流し見ると色の行だけが目に止まる。
土台の要約の見立ては、プロセスが生きているかどうかの写しなので札にしない。
続きの読み方は 2 つある。
検索の結果（サーバに問い合わせる一覧）は、1 回に 50 件ずつ返り、末尾に「さらに 50 件を読み込む」と残りの件数を置く（`search.more`）。押すと、いま持っている行の数を `offset` にして同じ条件で読み、届いた行を持っている結果の後ろに足す（Store の `appendSearchResult`）。残りが 50 件に満たなければその数を言い、読んでいる間は押せない。
条件の無い一覧と、タブや期間やプロジェクトだけで絞った一覧は、手元の全件から組むので、ページ送り（25、50、100、200 件。1 ページの件数は端末が覚える）に分ける。
一覧は窓の下端までの残りの高さを受け取り（`.screen-fill`）、下限（200px）より低い窓ではページがスクロールする。
引き出しが開いている間は一覧に使える高さが減る。1 行は 56px なので、窓の高さ 800 で要対応の引き出しを 3 行開いたとき、一覧は 4 行ほど見える。要対応が 2 件のふつうの朝は 6 行ほど見える（撮って確かめた）。
行を押すか Enter でセッション画面を開く。行と実行中の行は、開くときに行がセッション画面の上段へ広がる動きの出発点になる（`data-morph-id`）。

### Projects

1 行 1 プロジェクトの表で、列はステータスの札、名前と場所、いま、セッションの数、最後の活動、「…」の順である（`views/ProjectsScreen.tsx`、`presenters/projects.ts`）。
列の幅は `rows.css` の `--pcols` に 1 つだけ持ち、列の見出しと行が同じ値を引く。
表の幅が 780px を下回ったら、コンテナクエリで「セッションの数」の列を落とし、「いま」の列を細くする。
節は Active、Paused、Done の順で、行の無い節は見出しごと出さない。
節の見出しは Active、Paused、Done と頭を大文字にした英語で出し、件数を添える。
Archived は末尾の 1 行で、見出しと件数と「Archived を表示」だけを置く。
押すとその行の下に Archived のプロジェクトが開き、同じ行の語が「Archived を非表示」に替わる。
開閉は `aria-expanded` で読み上げる。
Archived が 1 つも無ければ、この行を出さない。
節の中は最後の活動の新しい順で、名前の部分一致で絞れる（絞り込みの外の Archived は数えない）。
スクラッチの擬似プロジェクトは、出さず、見出しの横の件数にも入れない。

名前は本物のリンクで、押すと `project.open` を送る。
行のほかの所を押しても開き、ステータスの札の列と「…」と赤い札は行を開かない。
読み上げの名前は、名前、ステータス、「いま」の数を含む（「alpha、Active、入力待ち 1、実行中 2」）。
名前の上で ↓ ↑ Home End を押すと、前後の行の名前へ焦点が移る。
「…」のメニューには、新しいセッション、（パスが見つからないときだけ）場所を再指定、いまのもの以外のステータスに替える項目を置く。
ステータスの札は表の中では押せない札で、替えるのはこのメニューか 1 つのプロジェクトの画面である。

「いま」の列には、入力待ち、実行中、確認待ち、TODO、リマインダーの順に、0 でないものだけを語と数で並べる。
入力待ちと実行中の数はサーバの `runningCount` を使わず、Home と同じく手元のセッションから数える。
確認待ちは、完了済みでない TODO の完了の候補と、そのプロジェクトのセッションに付いた状態の提案の数である（Home の確認待ちと同じ数え方）。
リマインダーは、そのプロジェクトのセッションに付いたリマインダーのうち、いちばん近いものの日付である。
見るのは Paused で日付のあるセッションだけで、日付の早いものを選ぶ（同じ日は時刻の早いもの、時刻なしは時刻つきの後）。
過ぎたものも数え、見落としたものが先の予定より前に出る。
プロジェクト自身はリマインダーを持たず、DB にも足さない。
列に入り切らない項目は、途中で切らず、丸ごと落として最後に「ほか N」を置く。
落とす数は描いた後の幅で決める（`views/nowFit.ts` の `fitCount`）。
項目と「ほか N」を見えない写しに並べて幅を測り、列の幅と見比べ、列の幅が変わったら測り直す。
全文は列の title に持つ。

場所は、プロジェクトの親フォルダの外にあるときだけ名前の横にパスで出し、長ければ頭を省略して末尾を残す（`placeOutside`）。
親フォルダの下にあるものは、直下でも深くても出さない。
この PC でパスが見つからないときは赤い札「この PC にパスがありません」を出し、押すと場所の再指定のダイアログを開く。
プロジェクトのカードにあった抜粋とメモの冒頭は、この表には置かない。

プロジェクトがひとつも無い人には、表と名前の欄の代わりに空の状態の 1 枚を出す。
できるようになることの 2 文と、「新しいプロジェクト」を置き、クイックセッションがあれば「クイックセッションをプロジェクトに昇格」も置く。
昇格の相手は、最後に動いたクイックセッションである。
絞り込みで 0 件になったときは、表の代わりに「あてはまるプロジェクトはありません」だけを出し、名前の欄は残す。
文は辞書の鍵（`projects.*`）から出し、ステータスの札は英語のまま、両方の言語で同じ表記にする。

見出しの行の右端（名前の欄の右）に、主のボタン「＋ 新しいプロジェクト」を置く。
押すと `project.new.open` を送って作成のダイアログを開く。
パレットのコマンドにも「新しいプロジェクト」を置く（`cmd:new-project`）。

作成のダイアログは、本文の頭の切り替えで 2 つのモードを持つ。
昇格のダイアログの見た目にそろえた、器と欄を使う。

- **新しいフォルダを作る**：「プロジェクト名」の欄（等幅、「ワークスペースに作るディレクトリの名前」）、「~/workspace/<名前> を作ります」、git init のチェック（既定はオン）。
- **既存のフォルダを登録**：未登録のフォルダの検索付きの一覧（`GET /api/workspace/dirs`）、「ほかの場所を選ぶ…（Finder、殻の中だけ）」のボタン、パスの入力の欄。どれかで選んだフォルダの basename を「プロジェクト名」の欄に入れる（直せる）。

下端は「やめる」「作成」「作成して始める」（主）である。
「作成」は、作ったらダイアログを閉じ、そのプロジェクトの画面へ移る。
「作成して始める」は、作ったら、新しいセッションのダイアログを、そのプロジェクトを選んだ状態で開く。
送信中は 2 つのボタンを押せなくし、失敗の文言はダイアログの中に出して入力を残す。
背景を押しても閉じない（書きかけを失わないため）。
未登録のフォルダの一覧は、キーボードで操作できる。
検索欄は combobox で、↑ と ↓ で行を辿り、Enter はその行を選ぶだけで送信しない。
名前とパスの欄の Enter は送信（「作成して始める」）である。
名前の検証（空、`.`、`..`、`/` や `\` を含む）はサーバの 1 か所に置き、UI は送る前に止めない。

### プロジェクト詳細

組み方は段 4 の設計（`docs/superpowers/specs/2026-10-09-stage4-screens-design.md` の 2.6、試作は `2026-10-09-projects-new-session/options.html` の Q3）で決めた。
左右に割り、左にホームと同じ部品のセッションの一覧、右に右パネル（TODO、ノート、アーティファクト）を置く。
見出しの行に名前、プロジェクトの状態の切り替え、操作（VS Code で開く、ターミナルで開く）、(i)、右パネルの開閉を置き、線の下にパスを置く。
新しいセッションの主ボタンはヘッダーにあり、この画面ではこのプロジェクトを最初から選ぶので、見出しの行には並べない。
クイックセッションの置き場の「クイックセッションを開始」は別の入口なので残す。
パスがこの PC で見つからないときは、パスの横に押せる札「見つかりません。場所を再指定」を出し、押すと場所の再指定のダイアログを開く。

**左の一覧。** ホームと同じ部品（`views/SessionList.tsx`）を、プロジェクトを固定して使う（`projectFixed`）。
上から、件数つきのステータスのタブ、検索の欄と絞り込みのボタン、平らな行、ページ送りである。
行に「いま動いている」「続き」といった節の見出しは挟まない。
動いているものを先に置き、残りは新しい順に並べるだけである（Done は Done にした時刻の新しい順）。
絞り込みにプロジェクトの選択は出さず、行にもプロジェクト名を出さない（見出しにある）。
行の右端のモデル、変更の数、コスト、メモの本文と鉛筆は、ホームの行と同じく出さない。
ノートは 2 段目の右端の印だけである。
ノートを編集する場所は、実行中ならセッション画面の帯の「ノート」の札、終わった後は冒頭の 1 枚である。
検索の語、絞り込み、ページは、ホームと同じ `State.search` を使う。
プロジェクトは画面が決めるので、絞り込みには入れず、問い合わせるときに画面のプロジェクトで絞る（`mediator/screen.ts` の `listProjectId` と `searchParams`）。
ほかの画面から入ると、ホームの語や別のプロジェクトの絞り込みを持ち込まず、空から始める。
ホームへ戻るときも、プロジェクトで掛けた絞り込みを持ち込まない。
欄の Enter と「条件をクリア」は画面を移さずその場で絞り、パレットの全文検索（絞り込みを添えない）だけは、これまでどおりホームの検索へ移る。
Done は畳まずに全件を出し、行が多ければページ送り（ホームと同じ件数の記憶）に分ける。
導入時に過去のセッションをまとめて Done にしたので、畳むと一覧が「Done の 3 行と大きな空白」になった。
そこで 2026-10-06 に、全部出してページ送りにした。
この決定は、節を無くした今も変わらない。
セッションが 1 つも無いプロジェクトは、「このプロジェクトのセッションはまだありません」を出す。

**右パネル。** TODO、ノート、アーティファクトを白い面に載せ、折りたためる（「右パネルを閉じる」「右パネルを開く」）。
TODO の見出しに件数と、完了の候補が付いた未完の TODO の数の札「確認待ち N」を置く。
セッションの状態の提案は数えない。そちらは一覧のタブの「確認待ち」が言う。
ノートは読む表示で出し、見出しの右の「ノートを編集」（空なら「ノートを書く」）を押したときだけ入力欄にする。
欄の中の操作はセッション画面の冒頭の 1 枚と同じ部品（`views/EditableNote.tsx`）で、⌘Enter（Ctrl+Enter）かボタンで保存して読む表示に戻り、Esc は保存せずに戻って書きかけを捨てる。
TODO とアーティファクトが空のときは、足す欄があれば別の行では断らない（TODO は欄の薄い字が言う）。
TODO の完了の候補の行は、背景を淡い紫（`--cand-soft`）にしてチェック欄を半分塗りにし、行の下に根拠の一文、出したセッションの名前（押すとそのセッションを開く。見つからなければ「不明なセッション」でリンクにしない）、候補になってからの時間、「確定」「却下」を常に見せる。
候補の行のチェック欄を押したときは、反転ではなく「確定」と同じに扱う。
読み上げの名前は「<本文>（<n> 件目、完了の候補）」である。

**(i) の詳細。** 見出しの (i) を押すと、場所、セッションの数、最後の活動の 3 行と、操作が開く（`views/ProjectInfo.tsx`、面は `Popover`）。
セッションの数は、Archived も含めた全部である。
操作は、場所を再指定（ダイアログを開く）、パスをコピー（押すと「コピーしました」）、名前を変更、一覧から削除（先に確認が出る。フォルダとトランスクリプトは消えない）である。
名前を変更は、面の中で入力欄に替わり、Enter か保存で `project.rename` を送る（`PATCH /api/projects/:id` の `name`。前後の空白を除き、空は 400）。
変換中の Enter では送らない。
試作にあった「作成」の行は置かない。
プロジェクトは作成日を持たず、DB に足すと同期で運ぶ形が変わるからである。
クイックセッションの置き場（スクラッチ）は、名前も場所も直せず、一覧からも消せないので、3 行とパスのコピーだけを出す。

文は辞書の鍵（`projectScreen.*`）から出す。
ステータスの札（Active、Paused、Done、Archived）は英語のままである。

### セッション詳細

組み方は段 4 の設計（`docs/superpowers/specs/2026-10-09-stage4-screens-design.md` の 2.3、試作は `2026-10-09-session-screen/options.html` の C）で決めた。
実行中と終わった後は同じ形で、上から、見出しの段、実行中ならタブの列、そして本体を縦に積む。
本体は窓の残りの高さを全部使い、左に主役、右に目次だけの 240px を置く。
左の主役は、実行中なら現在の帯とターミナル、終わった後なら冒頭の 1 枚つきのトランスクリプトである。
高さは決め打ち（`calc(100vh - …)`）にせず、本文の列から画面までを縦の flex にして残りを渡す。
切断の帯が出ると本文の列の上の余白が増え、本体はその分だけ縮むので、ターミナルの入力の行は窓の外へ落ちない。
窓がとても低いときだけ、本体の 160px を下限にして本文の列ごとスクロールする。
セッション画面だけ本文の幅の上限を外す（骨格の節）。

見出しの行には、状態の点、名前、他の PC の札、要約の 1 文、主の操作、「…」のメニュー、(i) を置く（A1）。
主の操作は状態ごとに 1 つだけ強く出す。
実行中（作業中、入力待ち、アイドル、hangar の外で動いているものも）は「VS Code で開く」、終わったセッションは「再開」、他の PC が握っている（ロックがある、トランスクリプトが他の PC にある）ときは「この PC で再開」である。
残りは「…」のメニューに入れる。
実行中は「ターミナルで開く」「hangar でつなぐ」か「hangar で引き取る」「フォーク」「要約を作り直す」「プロジェクトに昇格」「停止」、終わったセッションは「フォーク」「VS Code で開く」「要約を作り直す」「プロジェクトに昇格」、他の PC のときは「再開」「フォーク」「VS Code で開く」「要約を作り直す」の順にする。
押せない項目は消さずに残し、下に理由を 1 行添える（「実行中は押せません。止めると押せます」「MacBook で実行中です」「本文が他の PC にあります」「本文がありません」など）。
理由は presenter（`sessionActions`）が再開とフォークを閉じている事実から言う。
押せない主の操作は `disabled` ではなく `aria-disabled` にし、理由を title と読み上げの説明に持たせる。
乗せたときの吹き出しとキーボードで、理由に届くようにするためである。
生きているロックの「この PC で再開」は、Ruling 14 のとおり閉じたままにする（試作は押せる形で描いていたが、ロックの規則を優先した）。
メニューは menu ボタンの作法に従い、↓ と Enter と Space で最初の項目、↑ で最後の項目を開き、開いている間は ↑ ↓（端で回る）、Home、End で移り、Enter と Space で選び、Esc で閉じてボタンへ戻る（`views/primitives/MenuButton.tsx`）。
名前は見出しにだけ出し、要約の題は出さない（C1）。

見出しの下に情報の行は置かない。
今までの行の印は、次の場所へ移った。

- 状態と経過、コンテキスト使用量、コスト、ターンとトークンは、実行中なら現在の帯の 1 行目。ターンとトークンは (i) にも、終わった後は冒頭の 1 枚の 1 行目にも出す。
- モデル、effort レベル、権限モード、開始、作業ディレクトリ、アカウント、起動、ターンとトークン、変更したファイルの数、PR、クイックセッションの印は、見出しの右端の (i) のポップオーバー（`presentDetails`、見出しは「詳細」）。値の無い行は出さない。権限モードは起動のときに選んだ値（`RunDto.permissionMode`）で、Claude の中で切り替えた値は分からない。アカウントは 2 件以上あるときだけ、色の点を添える。
- 他の PC で実行中の札（応答が途絶えていれば別の色）と、トランスクリプトが他の PC にあることは、名前の横の札（`views/SessionBadges.tsx`）。操作できない理由なので、ポップオーバーには隠さない。
- ノートは、実行中なら帯の右端の「ノート」の札のポップオーバー（中身があれば札に印）、終わった後は冒頭の 1 枚の中で読み書きする。
- アーティファクトは、実行中なら帯の数の札、終わった後は冒頭の 1 枚の札。
- 区切りを付けたので止めた知らせと、「要約のみ」「トランスクリプトがありません」は、冒頭の 1 枚の 1 行目。

現在の帯（`views/NowStrip.tsx`、値は `presenters/live.ts` の `presentNowStrip`）は、生きた run があるときだけ、ターミナルの真上に置く 2 行である。
1 行目は状態の語（作業中、入力待ち、アイドル、バックグラウンドで作業中）と問い、右端にいまの値（コンテキスト使用量のゲージ、コスト、ターンとトークン）と「ノート」の札。
2 行目は意図、直近のツール呼び出し、サブエージェントとアーティファクトの数の札である。
帯の全体は読み上げの領域にせず、状態の語だけを `role="status"` にする。
ツール呼び出しの札は、入り切らないものを途中で切らず、古い側から丸ごと落とし、左に「ほか N」の札を置く（`views/nowFit.ts` の `fitCountWithMore`。見えない写しで幅を測り、帯の幅が変わったときに測り直す）。
最後の呼び出しは「いま」や入力待ちの印を持つので、落とすのは古い側からにする。
「ほか N」と、サブエージェント 1 本ずつと、アーティファクトの一覧は、札を押すポップオーバーに入れる。
帯の幅が 720px 未満になると（container query）、いまの値が 3 行目に下がり、意図が 1 行を使い切る。
コンテキスト使用量かコストが届いていなければ「未取得」と言い、両方なら 1 つにまとめる。
耳（タブ）の直下は帯なので、帯の左上の角は丸めず、ターミナルの板は全部の角を丸める（耳の下の板だけを角張らせる規則は、帯が無いときのターミナルと、分割したときの左の板に掛かる）。

終わったセッションは、トランスクリプトの冒頭の 1 枚（`views/LeadCard.tsx`、値は `presenters/session.ts` の `presentLeadCard`）を、スクロールの箱の先頭（古い行を読み込むボタンの上）に置く。
1 行目にステータスの札と設定した日、終了、ターンとトークンとコスト、要約の進捗と「要約を再生成」。
続けて要約、次のステップ、作成元の行、変更したファイルとアーティファクトと PR の札、ノートである。
変更したファイルとアーティファクトの札は、押すとこの 1 枚の中へ一覧が開く（同時には 1 つ）。
変更したファイルの並びと件数は `GET /api/sessions/:id/files`（画面を開いたときと、見ているセッションの run が終わったときに取る。失敗は知らせない補助の表示）を正とし、足した行と消した行は読み込んだ窓にあるファイルにだけ付ける。
行を押すと VS Code で開く。
`POST /api/sessions/:id/open-editor` に `file` を添えると、サーバはそのセッションが編集系のツールで変えたファイル（`event_index` の綴りそのまま）で、いまもファイルとしてある（ディレクトリに替わっていない）ものだけを開く。
別のセッションが変えたパスと、Read で読んだだけのパスは開かない。
任意のパスを code に渡させないためである。
`file` が無ければ、今までどおり作業ディレクトリを開く。
動いていないセッション（`live` が無く、生きた run も無いもの）は、末尾を追わず先頭から開く（`openAtLeadStep`）ので、開いた直後に冒頭の 1 枚が見える。
「最新へ移動」で末尾を追う形に戻せる。

右パネルは目次だけの 240px で、実行中も終わった後も同じ場所に同じもの（`TurnIndex`）を置く。
見出しは「目次」とターンの数（古いターンが残っていれば `+` を添える）、下端に「最新へ移動」である。
行は押すと、そのターンだけを中身つきで開く。
実行中は、左のターミナルも transcript でそのターンへ跳ぶ。
手の種類の色帯を行の下に出す。
右パネルの開閉は ⌘J と、目次の見出しの行の先頭のボタンで行う（`session.toc.*` の辞書の鍵）。
閉じると列ごと消え（`minmax(0, 1fr) 0px`、列の隙間も 0）、「目次 N」の札がタブの列の右端に出る（終わった後はトランスクリプトの切り替えの行の右端）。
窓が 1000px より狭いときは（`useNarrow`）、目次の列を持たず、札を押すと目次が本体の右に重なって開く。
このとき ⌘J も重なりの開閉になり、保存する開閉（`transcriptOpen`）の意味は広い窓のものとして保つ。
目次の行の `TurnIndex` は、実行中は生きた run の id を持ち、終わった後は持たない（跳ばす相手が無い）。
意図とサブエージェントのレーンは、サーバの `GET /api/sessions/:id/live`（今のターンの頭から読んだライブの要約）で作る。
サーバは要約を覚えておき、そのセッションの本文のファイルの行（`transcript_files`）と意図が変わるまで作り直さない。
裏の印（`live/aside.ts`）も 500 ミリ秒ごとに同じ要約を引くので、サーバは 1 つの覚えを両方に渡す。
帯の状態の語は、UI が読み込んだ主線のイベントも使う（ツール呼び出しの回数と未返答の呼び出し）。
窓が最新の一部だけのときは、ターンの頭を `/live` の値から、ターンの番号を統計から取る。
詳細は `docs/superpowers/specs/2026-10-01-live-explainer-design.md`。

トランスクリプトの切り替えの行には、「思考」「詳細表示」（英語では Raw）、サブエージェントの選び（メイン会話と各サブエージェント）、読み込んだ数を置く。
「詳細表示」は、生の入力の JSON など、トランスクリプトの細かい項目まで出す切り替えで、語は利用者の決定（2026-10-10）である。
読み上げの名前は「詳細を表示」（英語では Show raw entries）で、鍵は `session.transcript.rawToggle` と `session.transcript.rawToggleLabel` である。

本文が無く、最後に動いてから 30 日を過ぎたセッションは、保持期間で本文が消えたとみなす。
会話の欄と目次を出さず、理由の注記を一行置き、その下に冒頭の 1 枚（要約のみの印つき）を 1 列に積む。
実行中のセッションは、ターミナルを主、帯を従に置く。
上部にタブ列があり、タブ 0 が Claude、以降がシェルである。
セッション画面を離れると、そのセッションのターミナル接続は切る。
xterm のインスタンスとスクロールバッファは残すので、戻ればすぐ描かれ、`tmux attach` が現在の画面を描き直す。
接続を持ち続けると、渡り歩いたセッションの数だけ `tmux attach` のプロセスが残るためである。
2 つのタブを横に並べられる（「横に並べる」）。

#### セッション画面 C の部品（段 4 の PR 7 で作り、PR 8 で画面に付けた）

設計は `docs/superpowers/specs/2026-10-09-stage4-screens-design.md` の 2.3、試作は `2026-10-09-session-screen/options.html` の C である。
次の部品と経路は、PR 7 が今の画面を残したまま先に入れ、PR 8 が画面を切り替えて付けた。
試験用の頁（`packages/ui/preview/primitives.html?only=session`、例は `preview/session.tsx`）で試作と並べて撮れる。

- 現在の帯（`views/NowStrip.tsx`、値は `presenters/live.ts` の `presentNowStrip`）。上の段落のとおり。
- ノートの編集（`views/NoteEditor.tsx`）。帯の「ノート」の札のポップオーバーと、冒頭の 1 枚の中で同じ欄を使う。
  保存は `session.setMemo`（⌘Enter でもよい）。外で書き換えられたときは、書きかけの下書きを捨てずに知らせる。
  下書きの扱いは `useNoteDraft` にあり、保存しても下書きは消さない。保存が通らず本文が変わらなかったときは、開き直すと書いたものが残っていて、そのまま保存し直せる。失敗はトーストが知らせる。
- 読む表示と編集の欄を切り替えるノート（`views/EditableNote.tsx`）。冒頭の 1 枚とプロジェクトの画面の右パネルが使う。
  見出しの行は呼び手が組み、その右にボタンを置く。Esc で編集をやめ、書きかけを捨てる。保存すると読む表示に戻る。
- 冒頭の 1 枚（`views/LeadCard.tsx`、値は `presenters/session.ts` の `presentLeadCard`）。上の段落のとおり。
- 見出しの名前の横の札（`views/SessionBadges.tsx`、`presentSessionBadges`）。
- 目次だけの右パネル（`views/TocPane.tsx`）。240px の細い列で、中身は `TurnIndex`。開閉のボタンは `TocToggle`（既定は ⌘J と同じ `transcript.toggle`。狭い窓では渡された関数を呼ぶ）。
- 文は `session.strip.*`、`session.lead.*`、`session.note.*`、`session.lock.*`、`session.details.*`、`session.toc.*` などの辞書の鍵で、日英が同時にそろっている。
  1 ターンは英語で単数形（1 turn）にする（辞書の文の複数形の書き方。`presenters/stats.ts` の `turnsText`）。
- 経路。`GET /api/sessions/:id/files` は、`event_index` の編集系のツール（Edit、Write、MultiEdit、NotebookEdit）の呼び出しをパスでまとめ、`{ files: { path, edits, agentId }[] }` を索引した順に返す。`agentId` はサブエージェントだけが触ったときの id で、メイン会話が触っていれば null である。本文のファイルが無くても返せる。
- `RunDto.permissionMode` は、起動のときに選んだ権限モードを `runs.launch_params` から読んで載せる（列は足さない）。選ばなかった起動と、ターミナルの包み方からの起動は値が無く、鍵ごと送らない。起動のあとに Claude の中で切り替えた値は分からない。

端末は墨の板で、縁がそのセッションの状態で灯る。
作業中は杏の輪と光がゆっくり明暗を往復し、入力待ちは赤の輪と光で動かず、休みと終了は灯さない。
タブは板から生えたフォルダの耳で、選んだタブが板と同じ墨色になってつながる。
冒頭の 1 枚の作成元の行は、何がこの要約を書いたのかが作り直すかどうかの判断に要るために出す。
他の PC で実行中なら、見出しの名前の横に「MacBook で実行中」（heartbeat が 2 分より古ければ「MacBook から応答がありません」）の札を出し、最終確認の時刻を title と読み上げに持たせ、再開とフォークは理由を添えて押せなくする。
手元に本文が無いセッションと、ロックが `stale` になったセッションでは「この PC で再開」を押せる。
「引き継ぐ」は作らなかった。

ターミナルの接続はタブごとに持ち、思いがけず切れたら、そのタブだけを 1 秒、2 秒、4 秒と間を延ばし、30 秒を上限にしてつなぎ直す（`runtime/terminals.ts`）。
本体の WebSocket の再接続を待たない。
つなぎ直す前に、そのタブがストアの上でまだ生きているか（Claude のタブは run が終わっていないか、シェルのタブは閉じていないか）を確かめ、生きていなければつなぎ直さない。
続けて 5 回つながらなければ自動ではやめ、カードは「つなげませんでした。」と言って「再接続」に任せる。
upgrade を HTTP で断られた（404 や 401）タブは、ブラウザでは 1006 で閉じるだけで、待ってもつながらないからである。
やめた後も、画面に戻ったときの接続（bootstrap の後の `terminal.connect` など）は 1 回だけ試す。
サーバの再起動中に Claude が終わると `run.ended` が届かないので、取り直した bootstrap から消えた run は終わったもの（`lost`）、消えたシェルのタブは閉じたものとして、届いたときと同じ道で接続を切る。
画面を離れた、run が終わった、タブを閉じたなど、自分で切ったときと、サーバが断ったとき（エラーの知らせ）と、中の端末が終わって閉じたとき（サーバが 1000 と `exited` で閉じる）は、自動ではつなぎ直さない。
xterm の中で tmux から抜けた（C-b d）ときも、サーバは 1000 と `exited` で閉じる。
そこで `exited` で閉じても run とタブがストアの上で生きていれば、カードに「ターミナルから切り離されました」と「つなぎ直す」を出し、押されるまでつながない。
本当に終わったときは、続いて届く `run.ended` か、閉じたタブの `tab.upsert` が接続を切ってカードを消す。
切れている間は、その枠の板を暗く沈めて縁の灯を消し、中央に白いカード（「ターミナルとの接続が切れました」、Claude かシェルが動き続けていること、次に試すまでの秒数、「再接続」）を置く（F1）。
サーバが断ったときは「ターミナルに接続できませんでした」と言う。
「再接続」は待たずに今つなぎ、間を最初に戻す。
分割して 2 つ並べたときは、枠ごとに Host から様子を読み、切れた枠にだけカードを出す。
目次から跳ばした Claude が transcript を見せている間は、Claude の枠の上端に杏の地の全幅の帯を差し込み、「transcript を表示中」、跳ばしたターンの時刻、Claude が裏で動き続けていること、「最新へ戻る」を置く。
「最新へ戻る」は、目次の「最新へ」と同じ道（`turn.latest` と `leaveTranscript`）で抜ける。
帯が出ていても、枠の中の Esc は横取りせずに Claude へ渡す。
Esc は Claude の中断に要り、利用者が xterm で自分で transcript を抜けた（`q` や ctrl+o）ことを hangar は知らないからである。
横取りすると、抜けた後の中断の Esc が「最新へ」に化けて失われる。
帯は、跳ばした run が今の生きた run で、サーバが transcript に入れたと答えた（`found` か `notFound`）ときだけ出す。
答えを待つ間と、入れなかった（`mode`）ときと、API が失敗した（`failed`）ときは出さず、失敗は目次の開いたターンの中で言う。
跳び先の状態は跳ばした run を覚え、開いたターンを閉じたときと、跳ぶには遠すぎるターンを開いたときと、画面を離れたときにも、その run を transcript から抜けさせる。
戻ってきたときに Claude が古いターンを見せたまま止まって見えないようにするためである。
跳ばした run が終わるか、再開で run が替わったら、跳び先の状態を忘れる。
`leaveTranscript` は今も生きている run にだけ送り、送った後に run が終わって断られても（409）知らせない。

実行中のセッションの「停止」は、取り消せない操作なので「…」のメニューの最後に、区切りの後ろの危険色（`--error`）で置く。
サーバの停止は、そのランのシェルタブを全部閉じてから tmux を落とす。
そこで、作業中（`busy` か `waiting`）のときと、シェルタブが 1 枚でもあるときだけ、先に確認を出す。
確認には「作業中です」とシェルタブの枚数を書き、既定のフォーカスは「やめる」に置く。
確認は取り消せない操作の形（見出しの前の赤い丸の停止のアイコンと、赤く塗った「停止する」）にする。
休みでシェルタブが無ければ、押したらすぐ止める。
作業中かとシェルタブの数は View が `session.kill` に添え、確認を出すかは Mediator が決める。

トランスクリプトの見せ方は UX 刷新 2 で決めた（`docs/superpowers/specs/2026-10-01-ux-refresh-2-design.md` の「2 本文の表示」、試作は `2026-10-01-ux-refresh/transcript-render.html`）。
利用者の指示は打ったとおりに右寄せの青い吹き出しで見せる。
Claude の返答は吹き出しをやめ、白い面に地の文の Markdown として描く（幅は 76 字まで）。
Markdown は段落、見出し、箇条書きと番号付き（入れ子を含む）、表、引用、横線、囲みのコード（言語名とコピーのボタン）、太字、斜体、打ち消し、インラインのコード、リンクを読む。
読み方は `presenters/markdown.ts` に自前で持ち、ライブラリは使わない。
HTML は解釈しない。
文字はどれも React の子として渡すので、タグは文字のまま出る。
リンクにするのは http と https の宛先だけで、PR のリンクと同じく `target="_blank"` で外に開く。
ほかの宛先（`javascript:` や相対のパス）は名前だけの文字にする。

ツール呼び出しは 28px の 1 行に、ツール名の札、要約、結果の印、時刻を並べ、押すと下に中身を開く。
札の色は手の種類（`packages/shared` の `steps.ts`、live-explainer と共有）で決め、読む＝灰、書く＝藍、走らせる＝杏、コミット＝緑、失敗＝赤、その他＝薄い灰にする。
試作の K1 は読む＝青、書く＝緑、web＝紫だったが、アプリの中で同じ種類が同じ色になることを優先して、live-explainer の色帯に合わせた。
WebFetch と WebSearch は手の種類では「読む」なので、札も灰にする。
中身は種類ごとに描き分ける（`presenters/tools.ts`）。
Edit と MultiEdit は統合表示の差分にし、変わらない行は変わった所の前後 2 行だけを残して間を畳む。
行番号は Edit の結果に付く `cat -n` の抜粋から読み、読めなければ番号を付けない。
MultiEdit は 1 か所ずつに「N か所目」の見出しを付ける。
Write はパスと言語と行数の付いたコード、Bash はコマンドと出力と終了コード（結果の頭の `Exit code N` を読む）、Read はパスと行の範囲、WebFetch は URL と聞いたことと答え、WebSearch は検索語と結果のリンクの一覧にする。
Grep、Glob、Task（Agent）、TodoWrite とその他のツールは、引数を 1 つずつ並べ、結果の文を下に出す。
生の入力の JSON は「詳細表示」の切り替えを入れたときだけ、中身の下に出す。
ツールの見せ方は差分を取るので、呼び出しの物を鍵に控えて、描くたびには作り直さない。

入れ子のスクロールは作らない。
返答と指示は 320px、出力とコードと結果の文は 12 行、差分は 24 行を超えたら切って下端をぼかし、「全文を表示（残り N 行）」を置く。
開くと面そのものが伸び、下に「畳む」を置く。
返答の残りの行数は、76 字で折り返したとみなした見積もりである。
隠れるのが 3 行以下なら切らない。
開いたツールと開いた長い本文は `Transcript` が seq ごとに覚え、仮想スクロールで行が窓の外へ出て戻っても開いたままにする。

思考は既定で非表示にし、切り替えで出す。
サブエージェントは親のツール呼び出しの下にネストする。

本文の中は ⌘F で探せる。
欄は本文の面の右上に浮くガラスで、件数（「3 / 12」）、前へ（⇧⏎）、次へ（⏎）、大文字と小文字の区別、閉じる（Esc）を並べ、スクロールバーの脇に一致のある行の印を置く。
仮想スクロールなので、DOM ではなくデータで探す（`presenters/find.ts`）。
数える単位は、描くときに印の部品（`Hl`）へ渡す文字の葉で、Markdown とツールの描き方は同じ順に同じ文字を渡す。
今の一致が畳んだツールや切った本文の中にあれば開いて見せ、行まで送り、その行の何番目の印かで濃い印を付ける。
畳んだツールの行には「一致 N」を出す。
数え始めは、語を打ったときに見ていた行より後ろの最初の一致である。
⌘F を受けるのは、本文が画面に出ているとき（ターミナルが出ていないとき）だけで、ターミナルが出ているときはターミナルとブラウザに渡す。
欄の状態は Mediator の State に持たず、View の側の置き場（`views/findStore.tsx`、Root が 1 つ作る）にセッションごとに持つ。
Mediator のほかの領域が使わないその場の操作なので、UiAction も Effect も通さず、一致は本文の部品が描く行から数える。
本文の部品は画面を離れると外れるので部品の中には置かず、戻ってきたときに同じ欄と語を出す。
保存はしない。

セッションの一覧の検索の結果から開くときは、`session.open` に抜粋の seq と検索語を添える。
seq は主線とサブエージェントで別々に振るので、抜粋はどの線の行かを `agentId` で持つ（主線は null）。
サーバは抜粋を主線を先に、seq の順に返し、跳び先は主線の抜粋だけから取る。
主線の抜粋が無ければ（サブエージェントの中だけで当たったときは）、跳ばずに最新の側から開く。
着いた画面は最新の側ではなく、その seq の 100 手前から前向きに 1 頁を読み、一致した行へ跳んで、その行の地を淡い黄から 1.8 秒で薄れさせ、行の中の検索語の印を残す。
抜粋の seq が描く行に無ければ（ツールの結果の行など）、その後ろの最初の行へ跳ぶ。
後ろ（新しい側）は一覧の下の「新しい行を読み込む」で読み足し、まだ読んでいない後ろがある間は、末尾に着いても追うのに戻さない。
過去へ遡って空の頁が返ったら、「古い行を読み込む」を出さない。
ターミナルが出るセッションでは右の欄が最新の側を使うので、跳び先があっても最新の側から読む。
跳び先はその画面にいる間だけのもので、画面を離れたら忘れる。
トランスクリプトは最新の側から開く。
開いた時点で末尾のページを読み、過去へは「古い行を読み込む」で 1 ページずつ遡る。
長いセッションでも、先頭から全部を読み込んでから末尾へ飛ぶ必要がない。
実行中のセッションで追うのをやめている間に届いた分は、「新着 N 件」の帯で知らせる。
N は実際に追記された行の数であり、遡って読み込んだ古い行は数えない。
件数の増分で数えると、遡った分まで新着に混ざるためである。
長いセッションは仮想スクロールで描く。
一覧の `VirtualList` とは別に、トランスクリプト専用の窓を `Transcript.tsx` に持つ。
行の高さが中身によって大きく変わるので、描いた行の高さを `seq` ごとに覚え、まだ描いていない行は見積もりで置く。
DOM に載る行の数は件数によらず一定で、「追う」と「もっと読む」は今までどおり効く。

#### セッション画面の動き

設計は `docs/superpowers/specs/2026-10-02-session-motion-design.md`（試作は `2026-10-02-session-motion/motion-proto.html`）で決め、内容はここへ移した。
動かすのは、右の欄の開閉、ターンの目次、見出し周りとタブ、ターミナルの上の案内の帯、開いた直後である。
現在の帯（意図、ツール呼び出し、サブエージェントとアーティファクトの数の札）は、出入りの動きを持たせない（値が毎秒変わるので、静止させて読みやすさを優先した）。
動かさないのは、ターミナルの中身と、毎秒変わる経過時間である。

共通の約束は次のとおりである。
- 長さと曲線はすべて動きのトークンを通し、数値を直書きしない。
- 入る形は、opacity 0、`--rise` の下、`--blur-in` のぼかしから、ぼかしを 20% で晴らし切りながら `--dur`、`--ease-out` で入る。
- 伸びて入る形は、入る形に高さ（タブは幅）を 0 から伸ばす動きを重ねる。リストの途中に入るものはこちらを使う。
- 畳んで出る形は、薄れながら高さ（タブは幅）を 0 へ畳み、終わったら外す。長さは `--dur-exit` と `--dur-fast` の和、曲線は `--ease-in` である。
- 並びが変わった要素は、前の位置から滑らせる（FLIP）。
- 最初の描画、前の描画が空だった描画、key が全部入れ替わった描画では、出入りを動かさない。
- セッションやサブエージェントを替えた描画も動かさない。リストは `scope` に `sessionId`（目次は `sessionId:agentId`）を渡し、単独の部品は `sessionId` で key して、別のものへの切り替えを入れ替えや出入りに見せない。
- reduced motion ではトークンが 0 になり、すべて即座になる。`el.animate` の無い環境（jsdom）では何もせず最後の形にする。

部品は `views/primitives/` に置く。
- `motionKit.ts`：入る形（`riseIn`、`fadeIn`）、伸びて入る形（`growIn`）、畳んで出る形（`collapseOut`）、滑り（`slideFrom`）、状態の印の膨らみ（`popMark`）、地の淡い黄の薄れ（`markHit`）。
- `useMotionList.ts`：リストの出入りをまとめるフック。消えた key は `leaving` として畳み終わるまで描き続け、出る途中で戻った key は元へ戻す。FLIP は残った key（前の描画と今の描画の両方にある key）の並びが変わったときだけ走る。足したり消したりしただけの描画では滑らせない。`scope` が替わった描画と、空の一覧からの描画（前が 0 件）は、出る行も入る動きも作らない。先頭への足し（古いものの読み込み）を動かさない `ignorePrepended` も持つ。
- `usePresence.ts`：単独の部品の出入り。開き直したときは、出る動きを取り消して戻す。取り消すのは Web Animations だけで、CSS の animation と transition（灯の脈など）は止めない。
- `layoutMotion.ts`：動いている箱に `data-layout-moving` を付け、`TerminalPane` はその間 fit を見送る。印は要素ごとに数え、`begin` で増やし `end` で減らし、0 になったときだけ印を外して `hangar:layout-settled` を出す。端末はそこで 1 回だけ fit する。重なった動きの片方が先に終わっても印は残る。
- `paneMotion.ts`：右パネル（目次）の開閉（`PANE_SHAPE.toc`）。列の計算値（px）を前後で測って `gridTemplateColumns` と `columnGap` を滑らせる。動いている間、欄の中身は開いたときの幅に留めて、折り返さずに端で切る（「下へ潜る」）。閉じるときは中身を `--dur-exit`、`--ease-in` で薄れさせてぼかす。開くときはぼかしが 35% で晴れながら現れる。

各箇所の振る舞いは次のとおりである。

- 右の欄の開閉：閉じる動きが終わるまで中身を描き続け、終わったら外す（`usePresence`）。タブの帯の開くボタンは、開き始めにその場で外し、出る動きは付けない。実行中の画面も終わった画面も、同じ本体（`.c-body`）の列を同じ `paneMotion` で動かす。狭い窓の重なりの目次は、列ではないので動かさない。開閉の間、端末は折り返さない（tmux の描き直しは動きが終わってから 1 回）。開閉はセッションごとに覚えているので、別のセッションへ替えて開閉が替わったときは、動かさずにすぐその形にする。
- ターンの目次：新しい行は入る形で末尾に入り、何も開いていない間は末尾へ滑らかに追従する（reduced motion、最初の描画、セッションやサブエージェントを替えた描画、空や仮の行から埋まった描画は即座）。ターンを開くと中身が伸びて入り、閉じると畳んで出る。開いたターンの寄せ（`revealWithin`）は、伸び切ったあとに一気に行う（滑らかには動かさない）。見出しの数（ターン N）は `RollingText` で回し、セッションやサブエージェントを替えたときは回さない。古いターンを先頭へ読み込んだときは動かさず、スクロールの位置も保つ。目次の行の並びは FLIP で滑らせない（新しい指示は末尾に足すだけで、残りは動かない）。
- 見出し周りとタブ：要約の一行は、初めて届いたときと文が変わったときに、左から `--rise` 浮かんで入る。タブは、足されたら幅を伸ばして入り、閉じたら幅を畳んで出る。畳んで出るタブは役もフォーカスも持たない見た目だけの複製にする。
- 案内の帯：信頼の案内、終了の案内、transcript の帯は、伸びて入り、畳んで出る。帯の高さが変わる間は、端末の板に `data-layout-moving` を付ける。
- 開いた直後：最初の events が届くまで、目次に淡い仮の行（6 行、幅を少しずつ変える）を、ゆっくり流れる光（`--skel-period`）で出す。reduced motion では流さない。仮の行は、本文があり、窓がまだ作られていないか読み込み中で 0 件の間だけ出す（`turnsPending` は本文のあるセッションに絞る。本文が無いセッションでは窓が作られず、いつまでも出てしまうため）。届いたら行を一度に入れ、末尾へ即座に寄せ、一覧全体を `--dur` で薄れから現す。届いて 0 件なら「まだ指示がありません」を出す。ターミナルは、初めてつなぐときだけ最初のデータが届くまで面を透明にし、届いたら `--dur` で現す（TerminalHost の「最初の描画が済んだか」の印を読む。一度開いたタブは透明にしない）。

### Settings

左の目次で 6 つの節（殻の中は更新を加えた 7 つ）を切り替え、右は選んだ節だけを出す（S1。試作は `docs/superpowers/specs/2026-10-09-settings-screen/options.html`、決めた構成は `docs/superpowers/specs/2026-10-09-stage4-screens-design.md` の 2.4）。
節は、一般（言語、通知、ターミナルアプリ、トランスクリプトの保持）、クラウド同期、連携（Claude Code との互換、MCP サーバー、ステータスライン、シェル連携、アカウント）、要約エンジン、ツール（プロジェクトの親フォルダと、tmux、claude、code、Node のパス）、情報（使用量、索引、この PC）である。
殻の中では、ツールと情報のあいだに更新（版と最終確認、「更新を確認」、見つけた版の取得と再起動、知らせのスイッチ）が入る（「アプリの自動更新」の節）。
ブラウザの目次には更新を出さない。
一般の節の最初の行は言語（日本語、English）で、押した瞬間に保存する（保存のボタンは無い）。
言語はこの PC の設定で、クラウドへは同期しない。
開いている節は URL の `at` が持つ（`#/settings?at=cloud`。値は `general`、`cloud`、`integrations`、`summary`、`tools`、`update`、`info`）ので、戻ると進むで節も戻る。
`at` が無ければ一般を出す。`sync`（ヘッダーの同期の語）はクラウド同期、`accounts`（ヘッダーのアカウントの設定）は連携の別名で、`accounts` は節を開いたあとアカウントの位置まで滑る。
目次の灯りは URL に従うので、節を移った直後に前の節が灯ったまま残ることは無い。
節を切り替えたら、頁をスクロールする枠の先頭へ戻す。
付属の値（準備の確かめ、使用量、保持期間など）は設定の画面に入ったときに 1 回だけ取り、節の切り替えでは取り直さない。
目次の各行は、節の名前と今の状態の 1 行を持つ（`presentSettings` の `toc`）。
一般は通知の状態、クラウド同期は同期の状態と最終受信（同期していなければ「同期オフ」）、連携とツールは直すものの数（「要修正 N」。無ければ「問題なし」「すべて検出」）、要約エンジンはモデルの一覧が取れたかと接続テストの結果、情報はセッションの数である。
連携とツールは、準備の確かめが届くまで「確認中」と言う。
読み上げの名前は「クラウド同期、同期オフ」の形で、節の名前と状態を含む。
目次は上下の矢印、Home、End で行を移り、選ぶのは Enter と Space である。開いている行だけが Tab の道に入る。
幅が 1000px 以下の窓では、目次は頁の上に 3 列 2 段（殻の中の 7 つは 4 列 2 段）で並べる（節を切り替える道は目次だけなので、消さない）。
直すもの（無くても動くものを除く ✗）がある節（連携とツール）には、目次の状態と、右の節の見出しに「要修正 N」を出す。
Claude Code との互換のずれは、利用者が直せるものではないので直すものに数えず、目次の状態も見出しの札も要修正にしない。
「要修正」は、利用者が手を打てるものだけを指す言葉にしておく。
オンとオフの項目はスイッチにして行の右端に置き、ターミナルアプリはアプリのアイコンを添えた切り替えの帯、要約エンジンのモデルは一覧、1 時間の上限は ± の付いた数値の欄にする。
スイッチと帯は切り替えた時点で保存する。
外部の要約エンジンを許可するスイッチだけは、オンにするとき、保存済みの宛先へトランスクリプトが送られる旨を確かめる帯（「許可」「キャンセル」）を挟み、「許可」を押して初めて保存する。
オフにするときは確かめずにその場で保存する。
ツールの節の先頭には、psmux（Windows）か tmux の状態の行を置く（段 6 の B3、`views/MuxSection.tsx`）。
見出しの札で「インストール済み」か「未インストール」かを出し、済んでいれば版とパスを、無ければ入れるコマンドを添え、「再確認」のボタンを置く。
パスの欄（プロジェクトの親フォルダ、tmux、claude、code、Node。どれもツールの節にある）は、欄を出たとき（または Enter）に、その 1 項目だけを保存する。保存のボタンは持たない。
値は前後の空白を落として見比べ、変わっていなければ送らない。
保存できたら欄の横に「✓ 保存しました」を 2 秒出し、断られたらその理由を欄の下に出して、書いた値は欄に残す（トーストにはしない）。
設定の画面を離れたら、欄の下の理由は消す（戻ると欄は保存済みの値に戻るので、理由だけが残ると、いまの値が断られたように読める）。
サーバは保存の前に、ツールのパスが実行できるファイルであること、プロジェクトの親フォルダがディレクトリであることを確かめ、先頭の `~` はホームに直してから保存する。
理由は欄の見出しで言う（例：「tmux のパス」に /x が見つかりません、「code のパス」の /x には実行権がありません）。
ツールの欄は名前だけ（`tmux` など）も受け、起動のときと同じく PATH から探して確かめ、打たれたまま保存する（「tmux のパス」の x が PATH に見つかりません）。
`./x` や `bin/x` のような相対パスは、サーバの作業ディレクトリで読むとどこを指すかが分からないので弾く（「tmux のパス」は / か ~ で始まるパスか、tmux のようなコマンドの名前にしてください）。
欄の下には 1 行の検証を置き、動かせるときは見つかったパスと版（プロジェクトの親フォルダは登録したプロジェクトの数）、動かせないときは直し方を出す（tmux は `brew install tmux` とコピー）。
code は無くても動くので弱い色にする。
Node の欄が空のときは、サーバを動かしている Node を「自動で見つけました」と添えて出す。
LM Studio の URL、モデル、Claude での要約の 1 時間あたりの上限は 3 項目をまとめて「保存」で保存し、そのボタンの横に同じ「✓ 保存しました」を出す。
URL の欄の下には、モデルの一覧が取れたかで「接続済み（モデル N 個）」か「LM Studio に接続できません」を出す。接続テストのボタンは `summarizer.test` を出し、結果をその下に出す。
ターミナルで打つコマンドは、薄い地のコードの行と右端のコピーで出し、どれも同じ hangar の呼び方にそろえる（`hangar mcp install`、`hangar statusline install`、`hangar shell install`。hangar に PATH が通っていなければ同梱の hangar の絶対パス）。
同梱の hangar は、macOS では `.app` の `Contents/Resources/server/bin/hangar`、Windows では入れた先の `server\bin\hangar.cmd` である（`shellWrap.ts` の `bundledHangarIn`）。
Windows では貼る先を PowerShell とみなし、英数字と `\ : . _ -` 以外の字を含むパスは `& '<パス>'` の形で書く（`shellHook.ts` の `shellInstallCommand`）。二重引用符で包んだだけでは、PowerShell はコマンドとして動かさない。
リポジトリから動かしているサーバの PATH の `node_modules/.bin`（Windows では `node_modules\.bin`）の hangar は、利用者のターミナルからは引けないので、`npm run hangar -- …` の形にする。
コピーのボタンは、ランタイムがクリップボードに写せたと返してから（Mediator の `copied` が進んでから）「コピーしました」を出す。
写せなかったときは「コピーできませんでした。文字を選んで ⌘C で写してください」とだけ知らせ、写そうとした中身はトーストに出さない。
参加トークンのような秘密も同じボタンで写すからである。
MCP サーバー、ステータスライン、シェル連携の見出しの右には、登録済みか未登録か、設定済みか未設定か、この PC はインストール済みか未インストールかの札を置く。
連携の節の先頭には「Claude Code との互換」の節を置く（試作は `docs/superpowers/specs/2026-10-07-stage0-claude-compat/checks.html` の A4、B1、C2）。
見出しの右の札で状態を言い、本文に hangar が読む Claude Code の形と、手元の版と確かめた版を出す。
問題なしは緑の「✓ 問題なし」、未確認の版は印の無い灰色の「未確認の版」で、版の並びに「まだ確かめていない版です。動きは止めていません」を添える。
ずれは注意の色の「! ずれ N 件」で、止めた機能を「〜を止めています」「〜を控えています」の一覧で常に出し、契約、値、版、最初に見た時刻、止めた機能の表を「ずれ N 件の中身」で畳む。
表の下に記録の置き場（`~/.agent-hangar/compat.json`）と「報告用に写す」を置く。
写すのはずれの一覧の Markdown の表で、画面の表に無い回数と最後に見た時刻も載せる。
止めた機能の言い方は DTO に持たせず、画面が契約と値の頭から引く（`packages/ui/src/presenters/compat.ts`）。
契約だけでは、CLI の 4 つの出力、statusline の自動で直す単位、レジストリの項目ごとに、止めるものが 1 つに決まらないからである。
判定はホームの帯の始める前の確認の互換の行と同じもの（`compatState` と `presentCompat`）を使う。
準備の確かめが届く前と、`compat` の無い古いサーバの答えでは、節の本文の下に「確かめています」と出す。
クラウド同期の節は 1 頁に、上から、状態（見出しの右の札と、状態、最終受信、未送信の変更、未送信のトランスクリプト）、操作（今すぐ同期、同期を一時停止、参加トークンを表示）、PC の一覧、Claude Code の設定の同期（常設の行。中身はダイアログで見せる。「設定の同期の作り直し」の節の「画面（PR 17）」）、Cloudflare の使用量と料金を置く。
同期していない人には、1 文の説明と 2 つのボタン（クラウドを用意して始める、参加トークンで参加）と、押せないスイッチの 1 行（Claude Code の設定の同期）だけを出す。
2 つのボタンは、押すとターミナルで打つコマンドを出すだけで、クラウドの用意と参加はアプリから行わない。
参加（`hangar join <token>`）は同梱の hangar でもできるので、ほかのコマンドと同じ hangar の呼び方（準備の確かめの `commands.join`）で出す。
クラウドの用意は wrangler で Worker を上げるので、入れた版の hangar では止まる（`requireCloudDir`）。だから `npm run hangar -- setup cloud` と出し、「リポジトリを clone して npm install した場所で」と添える。
Worker の入れ替えを促す文（`sync.compat.worker`、`configSyncUi.worker.body`）も、同じ呼び方と添え書きにそろえる。
月の予算の行は置かない（Cloudflare の月の予算で止める仕組みは段 5 で作る）。
Claude Code の設定の同期は、常設の行で、スイッチと、届いている変更、競合、送らなかった項目、バックアップを出す。中身はダイアログで見せる（「設定の同期の作り直し」の節）。
ヘッダーの同期の語を押すと、設定がこの節で開く（`#/settings?at=sync`。`sync` は `cloud` の別名）。
ヘッダーの同期の一行は状態を示すだけなので、同期の操作はこの節が唯一の置き場である。
参加トークンは押したときだけ出し、コピーのボタン、減っていく細い棒、「あと N 秒で消えます」を添え、120 秒で自動的に消して表示のボタンに戻る。
同期の状態の語（同期済み、送信中、受信中、同期を一時停止中、無料枠で停止 · 9:00 にリセット、同期エラー、同期オフ）はヘッダーの同期の一行と同じ表（`presenters/syncLabel.ts`）から引き、索引の進み（索引を準備中、索引 10 / 200 件、索引の作り直し 10 / 200 件）もヘッダーと同じ関数で作る。
何度も失敗して 30 分おきの再試行に回したトランスクリプトは「送信に失敗したトランスクリプト」と呼ぶ（用語集のとおり）。まだ送っていないものは「未送信のトランスクリプト」、最後に受け取った時刻は「最終受信」と言う。
操作ボタン（今すぐ同期、同期を一時停止、参加トークンを表示）の下に「使用量と費用」の段を置く（試作は `docs/superpowers/specs/2026-10-02-cloud-usage/usage-merged.html`、仕組みは「クラウド同期」の「使用量と費用」の節）。
上に札を 3 枚並べる。「今月の請求」は `$0.00` と「9/30 分まで」、「D1 の書き込み（今日）」は割合と行数、「プラン」は「Workers 無料」と「R2 従量」である。
その下に棒の一覧を置く。
今日の枠（D1 の書き込み、Workers の要求）、区切り、今月の枠（R2 の各項目）の順で並べる。
添え書きは「今日の枠は 9:00 に戻る」と、出どころ（「Cloudflare の数 · 2 分前」か「数は不明（hangar は数えません）」）である。
9:00 は枠が戻る時刻（次の 00:00 UTC）を端末の時刻で書いたもので、決め打ちしない。
状態ごとの姿を持つ。
D1 が上限の 80% 以上なら、札と棒を注意の色にして、凡例に「あと N 行で無料枠の上限です · 9:00 に戻る」と出す。
Cloudflare の上限で退いている間は、札と棒を止まった色にして、枠が戻る時刻と、戻れば自動で再開することを帯で言う。
トークンを入れていない端末では、hangar は数えないので、札を 3 枚とも値の無い印と「トークンが要ります」にし、今日の棒は描かず、案内の帯と `npm run hangar -- setup cloud --usage-token` を出す。
このコマンドも wrangler で Worker の秘密を入れるので、前に「リポジトリを clone して npm install した場所で、次を実行してください。」を添える（`cloudUsage.command.where`）。CLI の案内（`offerUsageToken`、`USAGE_TOKEN_HELP`）も同じことを言う。
一時停止と上限の間は Cloudflare に問い合わせないので、そのときは「トークンが要ります」の代わりに「同期の停止中」と言う。
取れなかったときは最後の値を出し、出どころの文を「Cloudflare の数 · 14:02 · 取得に失敗」にする。
Workers Paid のときは今日の枠の棒と D1 の札を出さず、札は請求とプランだけ、棒は今月の項目だけにする。
ヘッダーの同期の一行は、Cloudflare の上限で退いている間「無料枠で停止 · 9:00 にリセット」（赤い点）と言う。
設定のクラウド同期の節も同じで、見出しの右の札は止まった色で「無料枠で停止」と言い、「状態」はヘッダーと同じ語（戻る時刻つき）で言い、ボタンは「今すぐ同期」だけを出して、一時停止の切り替えは出さない（利用者は止めていないため）。
手で止めたときは、「同期を一時停止中」と言う。
ステータスラインの節は追記の有無と追記先のパスを出すだけで、書き込むボタンは持たない（追記は CLI から行う）。
MCP の登録の有無は `~/.claude.json` の `mcpServers.hangar` を読んで決める。読むだけで書かない。
シェル連携の節は、同期している PC ごとの包み方の状態（インストール済み、未インストール、tmux が無いので使えない）と、入れるために貼るコマンドを出す。書き込むボタンは持たない（`hangar shell install` から行う）。
トランスクリプトの保持は一般の節の行で、Claude Code の保持期間と本文の使用量を出す。書き換えるのはこの行だけで、期間を押すと差分を見せる確認を開き、「書き込む」を押して初めて書く。
通知は一般の節の行で、「通知を有効にする」のスイッチ 1 つで、入力待ちを窓の外へ知らせるかを決める（「入力待ちの知らせ」の節）。
無くても動くので、直すものの数には入れない。
通知を出せない環境（ブラウザで拒んだ後や、Notification の無いブラウザ）では、スイッチを押せなくして理由を添える。

### 入力待ちの知らせ

試作は `docs/superpowers/specs/2026-10-01-ux-refresh/waiting-notify.html`、決めた案は A1、B1、C1、D1、N1 である（`2026-10-01-ux-refresh-2-design.md` の 3 節）。

どのセッションが入力待ちかは、Mediator がストアから読む（`waitingSessionIds`）。
`live.update` は Claude のセッションの id で届くので、hangar のセッションへの引き当てはストアが済ませている。
ランタイムは、ストアが変わるたびに、変わったことだけを Mediator へ知らせる（入力 `{ kind: 'store' }`、中身は運ばない）。
Mediator は前に見た顔ぶれと比べ、入力待ちの顔ぶれが変わったときだけ動く。
数え方は `liveFilterOf` である。

新たに入力待ちになったセッションは、右下に 1 件 1 枚のカードとして積む。
カードには赤い縦の帯、名前、待っている時間、プロジェクト、問い（2 行まで、取れなければ「入力を待っています」）、「ターミナルで答える」を置く。
どこを押しても、そのセッションを開いてターミナルにフォーカスする（`session.open` の `focus: 'terminal'`）。
カードは入力待ちが解けるまで残し、時間では消さず、閉じるボタンも持たない。
解けたら下げる。
そのセッションを開いたときも下げ、離れた後もその入力待ちでは積み直さない。
いま開いているセッションが入力待ちになったときは、見えているので積まない。
カードは 3 件まで並べ、新しいものほど下（窓の角の側）に置く。
Home を見ている間と、そのセッション自身の画面を見ている間は、その件のカードを出さない。Home は「要対応」の札が、セッション画面は端末の縁の灯と端末そのものが言っているからである。ほかの画面では出す。サイドバーの件数、macOS の通知、Dock のバッジは変えない。
4 件目からは「ほか N 件をホームで見る」の小さな錠剤にまとめ、押すとホームの要対応へ移る。
通知の誘いはカードに添えない。ベルの一覧の行になった（「ベルと知らせの出し分け」の節）。
確認や入力のあるダイアログ（未解決のプロジェクト、確認、新しいセッション、昇格、保持期間、設定の取り込み）が開いている間は、カードも錠剤も押せない。
カードは知らせの層にあってダイアログより前に出るので、押すとダイアログを開いたまま裏の画面だけが移ってしまう（⌘I と同じ考え方）。
カードの「ターミナルで答える」と錠剤は押せなくなり、カードの添え書きは「ダイアログを閉じると開けます」に替わる。
Mediator も、そのあいだの `session.open` では画面を移さない（`mediator/screen.ts` の `canMoveBehind`、中身は `mediator/overlay.ts` の `overlayReplaceable`）。
パレットや読むだけのダイアログ（キーの一覧、昇格の完了）なら、閉じてから移る。

info のトーストは 4 秒で消え、押しても消せる。
error のトーストは時間では消えず、閉じる × で消す。
error は赤みのガラスに警告のアイコンを添え、幅は 420px まで、本文は 2 行まで見せ、収まらないときだけ「詳しく」で開く。
時間切れはトーストごとに持ち、マウスを乗せている間とフォーカスが中にある間は止める。
読み上げは info が `role="status"`、error が `role="alert"` である。

窓が背面にあるときは、入力待ちになったセッションごとに通知を出す。
題はセッションの名前、本文は問いの文（取れなければ「入力を待っています」）である。
問いの文は入力待ちより少し遅れて届くことがある（hook の台本や本文の索引が後になる）。
問いの文なしで知らせたセッション（`waitingBare`）に問いの文が届いたら、同じセッションの通知をもう一度出す。
OS は同じ識別子（macOS）と同じタグ（Windows、ブラウザ）の通知を書き換えるので、2 枚にはならない。
問いの文を待ってから出す形にしないのは、待つ時計（timer）が頁に要るからで、頁の時計は窓を最小化すると絞られる。
デスクトップでは、窓が前にあるかを頁では決めない。頁はいつも `notify_waiting` を呼び、殻が窓の実物の様子（見えている、最小化していない、フォーカスがある）を見て、前にあれば出さない（`notify::window_in_front`）。
頁の `visibilityState` と `hasFocus()` は、WebView が最小化や背面で絞られている間は当てにならないためである（Windows の実機で、最小化して約 3 分置いた後の入力待ちに、頁が通知を呼ばなかった）。
頁が止まらないよう、macOS は窓の設定 `backgroundThrottling` を `throttle`（止めずに絞る。macOS 14 から効く）にし、Windows は頁が解けない Web Lock を 1 つ握る（`runtime/notifier.ts` の `holdPageAwake`。Chromium は Web Lock を握っている頁を凍らせない。Tauri の `backgroundThrottling` は WebView2 には効かない）。
どちらも時計の絞りは変えないので、電池への響きは小さい。入力待ちは WebSocket で届き、頁の通知の判断と呼び出しは時計を使わない。
ブラウザでは今までどおり、頁が隠れているか窓にフォーカスが無いときを背面とみなす。
通知を押すと窓が前に出て、そのセッションを開いてターミナルにフォーカスする。
確認や入力のあるダイアログが開いていれば、窓が前に出るだけで、画面は移さない（カードと同じ扱い）。
Dock（ブラウザならインストールしたアプリ）のバッジには入力待ちの数を出し、0 で消す。

デスクトップの殻では、通知を macOS は UNUserNotificationCenter で、Windows は WinRT のトースト（`Windows.UI.Notifications`）で出す（`src-tauri/src/notify.rs`）。
頁は `notify_waiting` を呼び、殻は id と文を確かめてから OS に渡す。
押された通知は識別子からセッションを読み戻し、頁の `__hangarOpenWaiting` で開く。
頁が出来上がる前なら、ディープリンクと同じくハッシュとして貯める。
`tauri-plugin-notification` は、デスクトップでは押された通知を知らせないので使わない（Windows でも、出した後の受け口を捨てる）。
`.app` の外（`tauri dev`）と、Windows で組み上げたままの実行ファイル（`target` の下の `debug` や `release`）では通知を出さない。

Windows のトーストは、題と本文を XML の文字として入れ、launch に macOS の識別子と同じ値（`hangar-waiting:<id>`）を入れる。
タグはセッションの id で、同じセッションのトーストは新しい方に置き換わる。
アプリの名前（AppUserModelID）は `tauri.conf.json` の identifier で、NSIS のインストーラがスタートメニューの近道に付けるものと同じである。
押されたトーストは 2 つの道で届き、どちらも launch の値からセッションを読み戻して、macOS と同じ受け口へ渡す。
アプリが動いている間は、出したトーストの Activated で届く。
アプリが閉じた後に通知センターで押されたときは、Windows が COM の口でアプリを起こし、`INotificationActivationCallback::Activate` で届く。
そのために殻は起動のたびに、利用者の登録（HKEY_CURRENT_USER）の `Software\Classes\AppUserModelId\<identifier>` へ名前、絵、COM の口の CLSID を書き、`Software\Classes\CLSID\<CLSID>\LocalServer32` へ自分の実行ファイルを書き、COM の口を開く。
1 回の押下が両方の道で届いても、2 秒の間に同じセッションは 1 回だけ開く。
アンインストールでは、NSIS のフック（`src-tauri/windows/hooks.nsh` の `NSIS_HOOK_POSTUNINSTALL`、`tauri.windows.conf.json` の `installerHooks`）が、この 2 つの登録と `~/.agent-hangar/notify-icon.png` だけを消す。
`.agent-hangar` の中のほかのもの（DB など）は消さない。
フックの値は notify.rs の定数と同じで、`apps/desktop/test/config.test.ts` が食い違いを見る。
Windows には通知の許可を尋ねるダイアログが無いので、`notify_request` と `notify_status` は通知の設定（`NotificationSetting`）を読むだけで、切られていれば denied になる。
バッジは Tauri の `set_badge_count` で出す。
ブラウザでは Web Notification と `navigator.setAppBadge` を使い、どちらも無ければ何もしない。

通知を受け取るかは PC ごとに localStorage（`notify.waiting`）に残す。
OS で切られているときの案内は、許可する場所の名前を OS で変える（macOS は「システム設定」、Windows は「Windows の設定」）。鍵は `…notify.blocked` と `…notify.blockedWindows` に分け、選ぶのは `notifyBlockedKey(clientPlatform(), …)` である。
選んでいなければ、デスクトップでは受け取り、ブラウザでは受け取らない。
デスクトップで受け取るときは、起動したときに OS の許可を一度だけ尋ねておく（決まった後は OS が黙って答える）。
尋ね終えたら、殻の `notify_status` で OS の許可の状態を読む（macOS は UNUserNotificationCenter、Windows は通知の設定。尋ねはしないのでダイアログは出ない）。
システム設定で切られていれば（denied）、受け取らないにし、設定の通知の節に「システム設定の「通知」で Hangar を許可してください」と出す。
このときベルの一覧の「通知を受け取る」の行は出さない。
利用者の選んだ値（`notify.waiting`）は書き換えない。
スイッチを入れて断られたときも許可の状態を読み、切られていれば同じ直し方をトーストで知らせる。

許可は hangar の外（システム設定、ブラウザの設定）で変わるので、窓が前面に戻ったとき（window の focus と、document の visibilitychange で visible）にも読み直す（`runtime/runtime.ts` の `recheckNotify`）。
デスクトップでは `notify_status`、ブラウザでは `Notification.permission` を読む。
利用者が受け取ると選んでいれば（選んでいなければ環境の既定）、許されたら受け取るに戻し、切られたら受け取らないにする。
だから OS で許可し直して hangar に戻れば、スイッチを触らなくても受け取るに戻る。
受け取っていたのに切られたときは、設定の通知の節の案内に加えて、同じ直し方をトーストで知らせる。
受け取らないと選んでいれば、許されても受け取るにはしない。
設定の案内は「許可して Hangar に戻ると、受け取るに戻ります。戻らないときは、このスイッチを入れ直してください。」で結ぶ。
受け取らないと選んだまま、スイッチを入れて断られた後に OS で許可したときは、選んだ値が受け取らないのままなので戻らないからである。
窓に戻ると focus と visibilitychange が続けて来るので、最後に読んでから 2 秒の間は読み直さない（`NOTIFY_RECHECK_MS`）。
`notify_status` が失敗したとき（権限で断られた、殻が答えない）や `.app` の外では、まだ決まっていないとみなし、これまでどおり受け取るのままにする。
ブラウザの許可は、設定のスイッチかベルの一覧の「通知を受け取る」を押したときにだけ求める（押した操作の中でないとダイアログが出ないため）。
許されなかったら受け取らないままにして、「通知が許可されませんでした」と知らせる。

### ベルと知らせの出し分け

段 4 の PR 28 と PR 29 で入れた（設計は `docs/superpowers/specs/2026-10-09-stage4-screens-design.md` の 2.11.2、試作は `2026-10-09-small-screens/options.html` の知らせの B）。
ヘッダーの使用率の右にベルを置き、押すと知らせの一覧が開く（`views/Bell.tsx`、`views/NoticeList.tsx`、`views/Header.tsx`）。
数の札は未読の数で、0 なら出さない。
畳まない（ヘッダーの畳み方の対象にしない）。
一覧の行は、事実から Presenter が毎回組む（`presenters/notices.ts`）。
一覧そのものは保存しない。
事実が無くなれば行も消える。
閉じても残るのは、事実が残る間のことである。
既読は行の鍵（種類、対象、事実の版）の集合で、`localStorage` の `notices.read` に端末ごとに置く。
同期しない。
事実の版が変われば鍵が変わり、また未読になる。

知らせの種類ごとの出す場所は次のとおりである。

| 知らせの種類 | ホームの帯と引き出し | 右下の札 | トースト | OS の通知 | ベルの一覧 |
| --- | --- | --- | --- | --- | --- |
| 入力待ち | 要対応 | 3 枚まで（4 件目から「ほか N 件をホームで見る」） | | 背面のとき 1 件ずつ | |
| 今日のリマインダー | 要対応 | | | 時刻つきは、時刻を過ぎて背面のとき | 入る |
| Claude からの提案 | 確認待ち | | | | |
| 同期の失敗、一時停止、降ろせなかった本文 | | | | | 入る（設定の同期へ） |
| 互換の変更点 | | | | | 入る（設定へ） |
| 保持期間 | | | | | 入る（設定へ） |
| 通知の誘い | | | | | 入る（「通知を受け取る」で受け取りを入れる） |
| 他の PC から届いたプロジェクト | | 1 枚にまとめる（「プロジェクトで見る」「あとで決める」。「プロジェクトの同定」の節） | | | |
| アプリの更新 | | 1 枚（新しい版、取得の進み、再起動の確認、失敗を同じ札の中で移す。「アプリの自動更新」の節） | | | |
| 操作の結果 | | | 出す | | |

- 右下に積むのは入力待ちと、他の PC から届いたプロジェクトの札 1 枚と、アプリの更新の札 1 枚だけである。
  戻る時刻を過ぎた札、通知の誘い、ヘッダーの下の保持期間の帯は無くした。
  `shownOnScreen`（ホームと、そのセッション自身の画面では、その件を出さない）は右下の札とホームの帯だけに残す。
  ベルの一覧は画面に依らず同じ中身である。
- トーストは操作の結果だけである（保存しました、コピーしました、1 回だけ同期しました）。
- 同期の失敗の toast は、サーバから 2 本外した。
  本文を降ろせなかったとき（`boot/sync.ts` の puller の `onError`）と、1 回だけの同期がクラウドとの互換の版で断られたとき（`sync/oncePass.ts`）である。
  前者の事実は同期の状態の `skipped`（降ろせずに諦めた項目）に、後者は `error` に残っているので、ベルの行をそこから組む。
  `skipped` に入るのは 3 回続けて失敗した項目で、1 回目の失敗では行は出ない（以前は 1 回目にも toast を流していた）。
  理由は `console.error` と `desktop.log` に残る。
- 通知の誘いは、通知を出せる環境で受け取りが切れていて、OS に切られていないときだけ行にする。
  受け取りを入れると事実が無くなり、行も消える。
- 互換の変更点は、画面に出す toast が元々無く、ベルの行（互換の変更点の件数）だけで知らせる。
- 「どのプロジェクトにも属さないセッションが現れました」の toast は、ベルの行にせず、外した。
  理由は 2 つある。
  1 つめは、ベルの行は事実から組む決まりで、この知らせは 1 度きりの出来事だからである。
  行にすると「未分類のセッションがある」という消えない事実になり、プロジェクトに属さないクイックセッションを使う人のベルが、常に未読になる。
  2 つめは、未分類のセッションが一覧にそのまま出ていて、見失わないからである。
  ワークスペースの外で claude を使うのは普通の使い方で、毎回知らせる価値が薄い。
- 設定の同期で送らなかった項目は、ベルの行にした（`configUnsent`）。
  アプリの更新は、ベルの行にせず、右下の札と設定の更新の節で知らせる（2026-10-10 の決定、試作の A2）。

### 外のターミナルのセッション

VS Code や iTerm のターミナルで起動した claude は、画面（PTY の親側）をそのアプリが持つので、hangar は横からつなげない。
hangar が読めるのはレジストリ（`~/.claude/sessions/<pid>.json`）と本文だけである。
そこで、ターミナルで打った claude を、はじめから hangar の tmux の中で動かす。
hangar の画面から起動した run と同じものになるので、hangar の画面からも同じ tmux につなげる。

Claude のバックグラウンドのサービス（`claude --bg`）には移さない。
Claude Code は、利用上限に当たったセッションを上限が戻ったときに自動で続けるが、この予約は対話で、バックグラウンドでなく、リモートでもないセッションにしか入らない。
2026-10-01 の夜、以前の包み方でバックグラウンドになった 3 本が上限で朝まで止まり、素の claude だった 1 本だけが自動で続いた。
hangar の tmux の中の claude は、上限を模した中継で、予約が入り、戻った後に自分で続くことを確かめた。

- **包み方（`hangar shell install`）**：`~/.zshrc` から `~/.agent-hangar/shell/claude.zsh` を読む。
  対話で起動した `claude` は、hangar に起動を頼み（`POST /api/runs/terminal`）、返ってきた tmux のセッションにこのターミナルからつなぐ（`tmux attach`）。
  頼むときに、作業ディレクトリ、引数、環境変数を渡す。tmux の新しいセッションはシェルの環境変数を継がないので、hangar が `tmux new-session -e` で渡す。
  渡す前に、端末に固有の変数、`HANGAR_` で始まる変数、Claude Code が子に立てる印（run の起こし方と同じ一覧）を落とす。端末が Claude Code のセッションの中から起きていると、そのセッションの印を持っているためである。
  プロジェクトは、作業ディレクトリを含むルートのうち最も深いものにする。無ければ未分類にする。
  `-r <id>` は、その会話の run がもう動いていれば、その tmux につなぐだけにする。動いていなければ hangar に再開を頼む。
  hangar が応答しない、または断ったとき（tmux が無い、hangar が組み立てる引数と重なる引数を付けた、同じ会話が hangar の外で動いている）は、素の claude を起動する。
  すでに tmux の中にいるときは、hangar の tmux サーバなら入れ子にせず `switch-client` で移り、ほかの tmux の中なら素の claude を起動する。
  サブコマンド、`-p`、`-c`、`--bg`、id の無い `-r` などは包まない。
  サブコマンドの一覧は、サーバが起動のたびと claude のパスを変えたときに `claude --help` の Commands の節から作り直し、本体に書き込む。
  出力が無い（claude が無い、時間切れ、0 以外で終わった）ときは組み込みの一覧（2.1.295 の Commands）を使い、ずれは記録しない。
  出力に Commands の節が無いときは組み込みの一覧を使い、ずれを 1 件記録する。
  読めたときは読めた一覧を使い、組み込みとの差を 1 つずつ Claude Code との互換のずれとして記録する。
  `hangar shell install` は組み込みの一覧で書き、動いているサーバが次の起動で書き直す。
  抜けるときは、claude を終えるか、tmux から切り離す（`Ctrl+B` の後に `D`）。切り離した run は hangar の一覧に残り、hangar から止められる。
  本体は hangar が起動のたびに書き直すので、包み方を直しても各 PC で入れ直す必要はない。
- **引き取り（`POST /api/sessions/:id/adopt`）**：外のターミナルで動く、入力待ちか休みの CLI の claude を止め、同じ id のまま hangar の tmux の中で `claude -r` で再開する。普段の再開と同じ run になる。
  止める前に、レジストリの `entrypoint` が `cli` であること（VS Code の拡張の中の claude は止めない）と、pid の起動時刻がレジストリの `procStart` と合うこと（pid の使い回しで別のプロセスを止めない）を確かめる。
  起動時刻は macOS と Linux では `ps`、Windows では PowerShell で読む（`platform/proc.ts`）。どちらも 10 秒の締め切りで止め、締め切りで止められたときだけ同じ問いをもう 1 度だけ聞く。
  CI の Windows で、PowerShell の 1 回が 10 秒を越えて止められ、生きているプロセスを居ないと読んだことがある（2026-10-07、08）。居ない（終了コード 1）という答えは聞き直さない。
  読めなかったときと聞き直したときは、各回の終了コード、締め切りで止められたか、出力、かかった時間を `[proc]` の警告に残す。
  読み取りは spawnSync なので、その間サーバは止まる。聞き直すと最悪 20 秒になるが、呼ぶのは引き取りの確かめの 1 回だけである。
  止めた後は、レジストリからその会話が消えるのを待ってから再開する。消える前に再開すると、hangar の外で動いていると見て断ってしまう。
  入力待ちで止めると、待っていた問いは「答えなかった」として閉じる。元のターミナルからは、包み方を通した `claude -r <id>` で同じ run に戻れる。
- **バックグラウンドのセッション**：利用者が自分で `claude --bg` で起こしたものや、以前の包み方で起こしたものには、今までどおり hangar の tmux の中の `claude attach` でつなぐ（`POST /api/sessions/:id/attach`）。
  attach の run の種類は resume のままにする。種類を増やすと、同期で行を受け取る古い版の端末が DB の制約で取り込めなくなる。
  attach の run の停止は、tmux を落とすのに加えて `claude stop <id>` でバックグラウンドの本体も止める。
  止まったバックグラウンドのセッション（1 時間つながれずに止まったものを含む）の再開は、`claude -r` ではなく `claude attach` で起こす。`claude agents --json --all` に載っていれば、そちらを使う。

hangar は、run とシェルタブの tmux のセッションに `LC_CTYPE=UTF-8` を渡す（呼び手が `LC_ALL` か `LC_CTYPE` を決めていればそちら）。
tmux の新しいセッションはサーバの環境を継ぎ、.app から起こした hangar が立てたサーバには `LANG` が無い。ロケールが無いと、claude が選んだ範囲を写すときに日本語を読めず、Mac のクリップボードを空にする。
hangar の画面は OSC 52 を受けて書き直すが、アプリの WebKit では書けないことがあるので、claude 自身の書き込みが正しくなければならない（2026-10-02 に確かめた）。

hangar は、tmux サーバに端末のための設定を入れる。どれもサーバ全体に効くので、利用者の値を上書きしない形で入れる。
- `copy-command` を `LC_CTYPE=UTF-8 pbcopy` にする（空か、前の版が入れた素の `pbcopy` のときだけ）。iTerm2 は既定で端末のアプリからのクリップボードへの書き込み（OSC 52）を許さないので、マウスで選んだ範囲を直接クリップボードへ渡す。
  pbcopy はロケールで文字コードを決める。tmux サーバの環境には `LANG` が無いことが多く、素の `pbcopy` では日本語を写すとクリップボードが空になる（2026-10-02 に hangar の画面で起きた）。
- `extended-keys` を `on` にし（`off` のときだけ）、`extended-keys-format` を `csi-u` にし、`terminal-features` に `xterm*:extkeys` を足す。外の端末から Shift+Enter を区別して受けるためである。
- `S-Enter` を、hangar の run のセッション（`hangar-<id>`）でだけ ESC CR に変える。tmux は CSI u の Shift+Enter を素の CR に潰すので、Claude Code が改行と読む ESC CR を送る。シェルタブとほかのセッションには Shift+Enter のまま送る。
2026-10-01 に、この設定の tmux へ iTerm2 からつなぎ、Shift+Enter の改行、スクロール、ドラッグでのコピーが動くことを確かめた。通知は確かめていない。

各 PC の包み方の状態は `devices.shell_hook` に書いて同期する。使えない（`unsupported`）は、zsh でないか tmux が見つからないことを指す。
Windows では包みを作らない（2026-10-10 の決定）。包みは zsh のもので、PowerShell の同じ形は壊れやすいからである。
Windows のサーバは本体（`claude.zsh`）を置かず、`GET /api/shell-hook` は `unsupported` と `osSupported: false` を返し、設定画面はシェル連携の節ごと出さない。
`hangar shell install` も Windows では何も書かずに断る。ほかの PC の一覧では、Windows の端末を「Windows では使えません」と書く。
Windows で外のターミナルの claude を hangar で開くのは、引き取り（「hangar に移動」）だけである。
同じ tmux に 2 つのターミナルがつないでいるとき、画面の大きさは最後につないだか大きさを変えた側に合う（tmux の `window-size latest`）。
使用量の節には、直近 30 日の日別（日、入力トークン、出力トークン、セッション数）と、プロジェクト別（名前、トークン、推定コスト、セッション数）の 2 つの小さな表を置く。
推定コストの列には、そのセッションの走り全体の累計であることを添える。
診断として、サーバのログの末尾と索引の進行を出す。

### ショートカット

- グローバル：⌘K と / でパレット（移動・操作）、⌘N 新しいセッション、⌘⇧N スクラッチ（macOS の外では Ctrl+Alt+N）、⌘I 次の入力待ちへ、⌘, 設定、⌘[ と ⌘←（⌘] と ⌘→）で戻ると進む、? と ⌘/ でキーの一覧、Esc で開いているものを閉じる（何も開いていなければ入力欄を離れる）。
- タブとペーン：⌘1 から ⌘9 でタブ切替（素のブラウザでは ⌃⌥1 から ⌃⌥9）、⌘W でフォーカスのある枠のシェルタブを閉じる、⌘\ で横に並べる、⌘J で右の欄の開閉、⌘+ と ⌘− と ⌘0 でターミナルの文字の大きさ、⌘F で本文の中を探す（本文が出ているときだけ）。
  タブの列にフォーカスがあるときは ← と →（Home と End）でタブの間を移り、Enter か Space で選ぶ。
  選ぶとフォーカスはターミナルへ移るので、矢印で移るだけでは選ばない（tablist の手動の選択）。
  ターンの目次は j と k（↑ と ↓）で行を移り、Enter で開く。
  タブそのものは Tab で 1 つだけ止まる（roving tabindex）。目次の行も同じである。
  各タブの閉じるボタンは Tab で止めない（⌘W で閉じられる）。
  タブの列の追加と分割のボタンは別の操作なので、それぞれ Tab で止まる。
- 一覧：j と k（↑ と ↓ でも）で上下、Enter で開く、o でターミナル、e で VS Code、m でメモ編集。

一覧の行のフォーカスとカーソルは 1 つにまとめる（roving tabindex）。
Tab で止まる行はカーソルの行 1 つだけで、打鍵でカーソルを動かすとフォーカスもその行へ移り、クリックや Tab で行にフォーカスが来るとカーソルもそこへ来る。
Enter は一覧の器が 1 度だけ受けて、カーソルの行を開く。
Home に入ったら、行が初めて並んだときに一度だけ一覧にフォーカスする。
一覧そのものには輪郭を描かない。開くたびに、まだ何も選んでいない一覧を枠が囲むことになるからである。どこに居るかは、カーソルの行の地色と、行そのものの輪郭で示す。
ただし入力欄、ターミナル、ダイアログにあるフォーカスは奪わない。
パレットの全文検索の行と Home の欄の Enter は、検索を出した後にフォーカスを結果の一覧へ移す。
同じ語で検索し直して画面が作り直されないときも移るように、`search.query` は毎回 `focus` の効果（対象は結果の一覧）を出す。

打鍵と操作の対応は `packages/ui/src/keys.ts` の 1 つの表が持ち、照合も ? の一覧もそこから引く。
一覧の中の j や k のように画面の部品が自分で処理するものは、打鍵を持たない行として同じ表に並べる。
⌘ の付いた割り当ては Ctrl でも受ける。

画面を開いている PC の OS は、ブラウザの名乗り（`navigator.userAgent`）で決める（`keys.ts` の `clientPlatform`）。Windows があれば win32、Macintosh か Mac OS X があるか名乗りが無ければ darwin、ほかは linux とする。打鍵と表示（`isMacClient`）、tmux の入れ方、通知の案内は、どれもこの 1 つの判定から決める。
表と辞書の打鍵は macOS の記号（⌘、⇧、⌥、⌃、↵）で書き、Windows と Linux では見せるときに `keyLabel` が Ctrl+、Shift+、Alt+、Enter に読み替える（⌘⇧N の記号は Ctrl+Shift+N と読む。割り当てが OS で違う行は、表の `keysOther` を見せる）。
辞書の文に打鍵を書くときは `{keys}` の引数にし、呼び手が `keyLabel` を通した値を渡す。起動ボタンの `aria-keyshortcuts` も Windows では `Control+Enter` にする。
入力欄（input、textarea、select、contenteditable）の ⌘← と ⌘→（macOS の行頭と行末）と Ctrl+← と Ctrl+→（ほかの単語の移動）は欄の打鍵なので、戻ると進むに使わない（⌘[ と ⌘] は使う）。
macOS の入力欄の Ctrl の打鍵（Ctrl+K で行末まで消す、Ctrl+B で 1 字戻る、Ctrl+N、Ctrl+F）は文字の編集なので、hangar は ⌘ の付いたものだけを受ける。
macOS の外の入力欄の Ctrl+K や Ctrl+B には編集の役が無いので、hangar が受ける（Ctrl+K はパレットを開く）。

macOS の外のターミナルの中は、Windows Terminal と同じ流儀で、Ctrl+Shift+<キー> が hangar に届く（2026-10-10 の利用者の決定）。Ctrl だけの打鍵はターミナルへ渡す。
Ctrl+Shift の層は、表に `terminal` を書いた行の Ctrl（⌘）の打鍵だけで、⇧ で変わる前の文字は `code`（物理のキー）から読む（Ctrl+Shift+/ は ? と届くため）。ターミナルの外でも同じ操作になる。
hangar に回すのは K（パレット）、N（新しいセッション）、I（次の入力待ち）、カンマ（設定）、[ と ]（戻ると進む）、B（サイドバー）、/（キーの一覧）、1 から 9（タブ）、W（シェルタブを閉じる）、\（横に並べる）、J（右パネル）である。
ターミナルへ渡すのは、C と V（コピーと貼り付け）、← と →（単語の選択）、-（Ctrl+Shift+- は Claude Code の取り消しの Ctrl+_）、= と 0（文字の大きさはターミナルの外で）、F（本文の検索はターミナルが出ていないときだけ）と、ほかのすべての文字である。
⌘⇧N（クイックセッション）は Ctrl+Shift+N（新しいセッション）と重なるので、macOS の外では Ctrl+Alt+N にする。Ctrl+Alt+N は xterm が ESC と ^N を送るだけで使い道が無いので、ターミナルの中でも受ける。
xterm には、hangar に回す打鍵を処理させない（`runtime/xtermSetup.ts` が attachCustomKeyEventHandler で false を返す）。処理させると ^K などを中へ送ってしまう。
キーの一覧は、macOS の外では「キー」「ターミナルの中」「操作」の 3 列にする。title は「Ctrl+J、ターミナルの中では Ctrl+Shift+J」と両方を書き、ボタンの aria-keyshortcuts は macOS が Meta、ほかは Control と Control+Shift の両方を並べる。
試験は `src/test/setup.ts` が名乗りを macOS にそろえ、Windows の振る舞いは試験の中で名乗りを替えて確かめる。

画面に出すパスの分け方とつなぎ方は、`packages/ui/src/lib/paths.ts` の 1 か所に置く（`baseName`、`dirName`、`splitLast`、`joinPath`、`relPath`、`isUnder`、`homePath`、`withTrailingSep`）。
パスはサーバの OS の形で届くので、OS の判定より先にパスの形で見分ける。
ドライブ（`C:`）、UNC（`\\server`）、`~\`、`\` を含む相対パスは Windows の形とし、`\` と `/` のどちらも区切りとして読む。
macOS と Linux の形では `\` は名前に使える字なので、区切りにしない。
つなぐときは親のパスの区切りに合わせ、区切りの無い親（`~` だけ）のときだけ `clientPlatform` の OS の区切りにする。
Windows の形で下にあるかを比べるときは、区切りの違いと大文字小文字を同じとみなす。
`~` への縮めは、`C:\Users\<名前>\` の下も元の区切りのまま `~\…` にする。
サーバへ送るパス（登録するフォルダ、追加のフォルダ）は、受け取った形のまま送る。
`@` の候補はサーバが `/` で区切って返し、問いに打たれた `\` は `/` に読み替えて探す（`prompt/files.ts` の `rankFiles`）。

⌘I（次の入力待ちへ）は、入力待ち（live が waiting）のセッションを Home の帯の要対応と同じ順（長く待っている順）に 1 つずつ開き、ターミナルにフォーカスする。
いまいるセッションが入力待ちなら、その次へ移り、末尾の次は先頭へ戻る。
開く経路は「ターミナルで答える」と同じ `session.open` の `focus: 'terminal'` である。
どのセッションへ移るかは、Mediator がストアの入力待ちの並びを読んで決める（分割の右のタブと同じ形）。
入力待ちが無ければ、「入力待ちのセッションはありません」と短いトーストで知らせる。
パレットにも同じコマンドを置く。
⌘I を選んだのは、macOS の既定、Chrome、Tauri の既定のメニュー、xterm、Claude Code のどれとも重ならず、⌘ 付きなのでターミナルにフォーカスがあっても hangar に届くからである。

入力欄の Esc は、何も開いていなければその欄を離れる（blur）。
ダイアログの中の Esc は、ダイアログの殻（`views/primitives/Dialog.tsx`）が受けて閉じ、既定を止める。
`Root` の Esc は既定を止められた打鍵には重ねない。
重ねると、確認から戻った先の未解決のダイアログまで閉じてしまう。
`Root` が受けるのは、フォーカスが器の外（body など）にあるときの Esc だけである。
パレットは自分の入力欄で Esc を受けて閉じる。

パレット、キーの一覧、新しいセッションを開く操作は、確認や入力のあるダイアログを差し替えない。
受けるのは、何も開いていないとき、パレットのとき、読むだけのダイアログ（キーの一覧、昇格の完了）のときだけである。
確認の最初のフォーカスは「やめる」なので、修飾の無い / や ? も `Root` に届く。
差し替えると、確認は消え、やめたときに戻る先の未解決のダイアログも出せない。
キーの経路だけでなくボタンやパレットの行からも来るので、`Root` ではなく Mediator（`mediator/overlay.ts` の `overlayReplaceable`）が止める。

画面を移す操作も、同じ規則で確認や入力のあるダイアログの裏では何もしない（`mediator/screen.ts` の `canMoveBehind`）。
対象は、⌘, の設定（`nav.go`）、⌘[ ⌘] とスワイプの戻る進む（`nav.back` と `nav.forward`）、`project.open`、`session.open`、全文検索（`search.query` と `search.clear`）、パレットの画面を移す行である。
ダイアログを開いたまま裏の画面だけが移ると、何に答えているのかが分からなくなるからである。
ブラウザの戻る・進む（マウスの戻るボタンなど）は UiAction を通らず URL の変化として届くので、ランタイムが履歴の段の印から何段動いたかを添え（アプリが自分で書いた URL には添えない）、ダイアログが開いていれば画面を移さずに同じ段だけ履歴を戻して URL を合わせる。戻し終えて今の画面と同じ URL に着いた変化は読み込み直さない。
パレットと読むだけのダイアログなら、閉じてから移る。
ダイアログの中から意図して移るもの（保持期間の「ほかの期間…」の `retention.settings`、昇格の完了の「プロジェクトを開く」、起動や引き取りの完了の `launch.done`）は止めない。
前の 2 つは差し替えてよいダイアログか別の UiAction から来て、起動や引き取りの完了は runtime の入力なので、この規則を通らない。
ブラウザの戻るボタンと URL の書き換えは `hashchange` で後から届くので止められない。
そのときはダイアログを残したまま画面が移る。

新しいセッションのダイアログの ⌘Enter は起動である（キーの表には載せず、起動ボタンのキー帽で示す）。
ターミナルの Esc は Claude Code の操作に要るので横取りせず、日本語の変換中の Esc も変換の取り消しなので欄に残す。

受け取らなかった打鍵は `preventDefault` しない。
ただしセッション画面の ⌘W は、閉じるものが無くても常に受け取り、ブラウザと OS へ渡さない。
渡すと、ブラウザではタブが、デスクトップでは窓が閉じる。
窓を閉じるとアプリが終わり、同梱サーバも止まる（tmux のセッションは残る）ので、押し違いでそこまで落とさないためである。
セッション画面の外の ⌘W と、タブの無い画面の ⌘1 から ⌘9 は、そのままブラウザへ渡る。

⌘W が閉じるのは、フォーカスのある枠のタブがシェルのときだけである。
Claude のタブでは何もしない（止めるのは「停止」の役目である）。
ダイアログやパレットを開いている間も何も閉じない（⌘I と同じく、開いているものの裏を動かさない）。
このときも窓へは渡さない。
フォーカスのある枠は、ターミナルの枠に `focusin` が入ったときと枠を押したときに、その枠のタブとして `Root` が覚える。
分割中は右の枠にもフォーカスが来るので、選択中のタブ（左）では足りないからである。
枠の外（ヘッダーのボタンなど）へフォーカスが移っても、最後の枠を覚えたままにする。
覚えた枠がもう画面に無ければ、選択中のタブを対象にする。
フォーカスは DOM の事実で描き方を変えないので、Mediator の状態には入れない。

ターミナルにフォーカスがあるとき、macOS は ⌘ を含む組み合わせだけを hangar が受け取り、それ以外はすべてターミナルへ渡す（macOS の外は上の Ctrl+Shift の層）。
判定は `keydown` の `target` が `.term-host` の中にあるかで行い、渡すものは `preventDefault` せずに xterm へ落とす。
Ctrl の側をここで奪わないのは、Ctrl+K や Ctrl+W が readline の打鍵だからである。
タブ切替は ⌘1 から ⌘9 と ⌃⌥1 から ⌃⌥9 の両方を常に受け付ける（Tauri かブラウザかの判別は持たない）。
ただし ⌃⌥ の側は ⌘ を含まないので、ターミナルにフォーカスがある間はターミナルへ渡る。

### 戻ると進む

画面の遷移は URL のハッシュで行うので、ブラウザの履歴がそのまま画面の履歴になる。
⌘[ と ⌘] は `history.go` を呼ぶだけで、行き先は `hashchange` から入ってくる。
トラックパッドの 2 本指の横スワイプも同じ履歴を辿る。
スワイプは `packages/ui/src/swipe.ts` が横方向のホイールを積んで決める。
作法はブラウザと同じで、**引いて、離したときに動く**。
しきい値（120）まで引くと身構え、そこで指が離れたら 1 度だけ `nav.back` か `nav.forward` を出す。
引き切る前に引き戻せば取り消しになる。

ホイールの打鍵には指の上げ下げが乗らない。
デスクトップでは、殻（Rust）が NSEvent の位相を読んで「指が触れた」を `window.__hangarSwipeBegin()`、「指が離れた」を `window.__hangarSwipeEnd()` で叩く（`apps/desktop/src-tauri/src/lib.rs` の `watch_swipe_phase`）。
触れたことも送るのは、指を置いたまま止めている間は打鍵が来ないからである。これが無いと、画面の側が「途切れた」と読んで離す前に動く。
WebKit の手勢が使っているのと同じ信号で、打鍵そのものは飲み込まず素通しするので、頁の中の横スクロールはそのまま効く。
位相を読める殻であることは、サーバの頁が出来上がった時点で `window.__hangarPhaseAware` を立てて画面に知らせる。

この手勢はデスクトップの殻の中だけの機能である。
ブラウザには元から戻る進むの手勢があるので、二重に持たず、標準に任せる（`window.__hangarPhaseAware` が立っていない環境では、ホイールを一切見ない）。
だから `overscroll-behavior-x` でブラウザの手勢を止めることもしない。

**時間で画面を動かすことはしない**。
確定は「指が離れた」の合図だけで行う。
時間で打ち切る経路を残すと、合図が遅れた回に、指を置いたまま画面が動く。
引き換えに、位相を持たない入力（マウスホイールの横倒し）ではアプリのスワイプが効かない。そこは ⌘[ と ⌘] を使う。
身構えないまま宙に浮いた手勢の矢印だけは、2 秒で消す保険を置く。消すだけなので、誤って動く経路にはならない。

指が離れた後も惰性の打鍵は流れ続ける。
これは終わった手勢の残りなので、次の手勢（`__hangarSwipeBegin`）が始まるまで捨てる。
捨てないと、離した直後に矢印が描き直されて居残る。

手勢の仕切りは `begin()` が受け持つので、打鍵の途切れで積みを捨てる保険は 1 秒に緩めてある。
ゆっくり動かすと打鍵の間隔は開くので、短く取ると引いている最中に積みが消える。

⌘[ と ⌘] は入口を問わず効く。ブラウザでも、アプリの最初の頁より前へは戻らない。
ただし確認や入力のあるダイアログが開いている間は、⌘[ ⌘] もスワイプも効かない（キーの節の `canMoveBehind`）。
スワイプはそのあいだ矢印も出さない。
Mediator が捨てるだけだと、矢印が出て動いたように見えるからである。

中身の無い打鍵（deltaX も deltaY も 0）は位相の切り替わりに付いてくるので、手勢の状態に触らない。
これを「縦に流している」と読んで積みを捨てていたため、引いて止めた手勢が離す前に消えていた。

積みは符号のまま足していく。
逆向きの打鍵が 1 つ来ただけでは捨てない。実機の打鍵は一方向に揃わず、細かな揺れが必ず混じるので、
捨てていると（実際そうなっていた）いつまでも身構えない。
取り消しは「引いた分が半分まで戻ったとき」で見る。

打鍵の細りは合図に使わない。
指を付けたまま引く速さは途中で普通に落ちるので、細りで動かすと「離していないのに戻る」ことになる（実際にそうなった）。

WKWebView 自身の手勢（`allowsBackForwardNavigationGestures`）は使わない。
公開 API はこの真偽値ひとつで、実体は `WKSwipeTransitionController` と `ViewGestureController` が前の画面の写しを滑らせる遷移まで含む。
演出だけを切る API は、公開・私用のどちらにも無い（dyld 共有キャッシュの記号まで当たって確認した）。
だから信号だけを同じ場所から取り、演出は持たない。

縦に流しているかどうかは、1 打鍵ごとの縦横の比べ合いではなく、**積んだ量**で見る。
指を置いている間もトラックパッドは微動を拾い、縦の方が大きい打鍵がいくらでも混じるので、
1 発で捨てていると、引き切って身構えた 0.1 秒後に手勢が消える（実際にそうなった）。
縦に 40 以上積み、しかも横より多いときだけ、縦の手勢とみなして捨てる。
横へ引き切った後は軸が横に固まり、縦に動いても取り消さない（ブラウザと同じ）。
惰性の名残だけで身構えないよう、8px 以上の打鍵が 1 つも無い手勢では身構えない。
動かした後は掛け金を掛け、同じ向きの惰性が細り切るか、逆へ引かれるか、打鍵が途切れる（200ms）まで次を受けない。
これが無いと、一振りで 2 画面戻る。

横へ流せる箱の中では、その向きにまだ余地がある限り箱が手勢を取る（`packages/ui/src/views/swipeTarget.ts`）。
`overflow: auto` の器はどの画面にもあり、組版の綾で数 px はみ出すので、8px を超えるはみ出しだけを本物とみなす。

持ち主は**手勢ごとに一度だけ**、最初の打鍵で決める。
打鍵ごとに決め直すと、箱が引かれて `scrollLeft` が変わるたびに持ち主が裏返り、
そのたびに積みが捨てられて矢印が荒ぶる（実際にそうなった）。
箱が取った手勢は、端に着いた後もその手勢のあいだは箱のもの。端で一度止まり、引き直して初めて画面が動く。
逆に、端から始めた手勢は画面のもの。途中で箱に余地ができても持ち主は移らない。

戻る先はアプリの中だけにする。
履歴の段に「アプリの中で何段目か」を押し（`packages/ui/src/runtime/hashLocation.ts`）、0 段目では戻らない。
デスクトップでは 0 段目の手前がサーバの起動を待つ頁で、そこへ移ると二度と遷移せず操作できなくなる。

引いている間は画面端に丸い矢印を出す（`packages/ui/src/views/SwipeHint.tsx`）。
引いた量（0 から 1）に応じて端から出てきて、引き切ると色が変わって「離せば動く」ことを見せ、動いた時点で消える。
戻る先が無いときは出さない。
矢印は Root が DOM を直に触って動かす。毎打鍵で React を回すと画面ごと描き直すことになるからである。

ネイティブの手勢は使わない。
WKWebView の `allowsBackForwardNavigationGestures` も、ブラウザの手勢も、前の画面のスナップショットを指に追従させる演出まで一式で引き受け、演出だけを切る手段が無いからである。
ブラウザの側は `overscroll-behavior-x: none` で止める。

## 見た目と動き

常にライトで、ダークモードは持たない。
例外はターミナルの面だけで、そこは端末エミュレータの慣習に合わせて墨色の不透明な板（`--term-bg`、`--term-fg`）にする。
参照するのは macOS 26 の Liquid Glass である。
画面は奥から「光の背景」「読む面」「浮くガラス」の 3 枚で組む。
光の背景は地の `--bg` の左上に 1 つの淡い光（`--aura-1`）を置く。光は動かさない。
以前は青と藤色の 2 つを 24 秒で漂わせていたが、読む面が白なので光の仕事は溝を染めることだけで、常に動かす値打ちが無かった（2026-10-05 の決定）。
読む面（一覧、カード、会話、設定の中身、プロジェクトの右の欄）は白で不透明にし、ガラスを重ねない。
ガラスはヘッダー、⌘K パレット、ダイアログ、通知、切断の帯にだけ使い、`backdrop-filter` は必ず `-webkit-backdrop-filter` と併記する（`styles/glass.test.ts` が置き場所を見張る）。
色はデザイントークンとして `:root` に定義する。
面は白と淡い青灰、アクセントは 1 色（`--accent`、主ボタンだけ `--accent-hi` からの淡いグラデーション）、状態色（busy、idle、終了、エラー）は控えめな彩度にする。
状態の点は、作業中が杏（`--busy`）、入力待ちが赤茶（`--waiting`）、休みが灰（`--ink-3`）である。緑（`--idle`）は「済んだ」の色で、終わったサブエージェントやコミットの札に使い、休みには使わない。
本文の色は、白地と、ガラスを重ねた色（白 40% を `--bg` に重ねた `#f5f7fa`）の両方で 4.5:1 以上を保つ。
プロジェクトの状態（`active`、`paused`、`done`、`archived`。画面では Active、Paused、Done、Archived）は、アイコンではなく色で示す。
状態ごとに文字色と淡い地色のトークン（`--st-<status>`、`--st-<status>-soft`）を持ち、状態の部品と見出しの点が `data-status` からそれを引く。
状態の部品は、文字、その右の塗りつぶしの丸、矢印の順に描いた札を、ガラスの一覧（`views/primitives/Listbox.tsx`）の顔にする。
開くと 4 つの状態を、色の点とひとことの意味（いま進めている、いったん止めている、やり終えた、一覧の奥へしまう）つきで並べる。
この部品は `views/primitives/StatusSelect.tsx` の `StatusSelect`（選べる場所）と `ProjectStatusDot`（読むだけの場所）だけを通して使い、View が一覧を自分で組むことはしない。
淡い地色の上の文字は 4.5:1 以上のコントラストを保つ。
状態は常に文字でも示すので、色は補助である。
グラデーションは主ボタンと背景の光だけ、影は浮く部品と端末の板だけに許す。
読む面へのガラス、シマー、スケルトン、タイピング風の表示、文字の影、光る文字は使わない（開いた直後の目次の仮の行だけは例外）。
開いて出るもの（パレット、ダイアログ、通知、メニュー）は、白 88% 以上の濃さにする（`--glass-bg-palette`、`--glass-bg-dialog`、`--glass-bg-toast`、`--glass-bg-menu`）。薄いと、裏の一覧の文字や墨の端末が透けて中身が濁る。
角は部品が 8px（`--r`）、面が 14px（`--r-lg`）、浮くガラスが 16px（`--r-xl`、ダイアログは 18px）、ボタンと「探す・移動」の入口とヘッダーは錠剤（`--r-pill`）にする。

読むための小さな面（ポップオーバー）は `views/primitives/Popover.tsx` の `Popover` を通す。
(i) の詳細、ノートの札、数の札から開く一覧が使う（段 4 の部品で、画面へ付けるのは各画面の PR）。
面は `.menu-pop` をそのまま使い（ガラスはそこにだけ書く）、非モーダルの dialog として開く。
開くと面（中に `data-autofocus` があればそこ）へ焦点が入り、Esc は閉じて焦点を開いた元へ戻して外へは伝えない。
外側を押すと閉じ、焦点が行き場を失ったときだけ開いた元へ戻す。Tab で中の端を越えたら閉じ、開いた元から次へ進ませる。
`InfoPopover` は見出しの右端の (i) と、名前と値の行の面で、名前は辞書の「詳細」である。
数の札（`CountChip`、`views/primitives/Chip.tsx`）は、名前と件数を 1 枚に畳む。押せない札は読むだけの `span`、押せる札はボタンで、`expanded` を渡すと `aria-expanded` と矢印を出す。
設定の札（`SettingChip`）は、値を見せ、押すと小さい一覧が開く顔で、読み上げの名前は「名前、値」である。開いた先は呼んだ側が決める（`Popover` か `Listbox`）。
どちらの札も、ボタンの属性と ref をそのまま受けるので、`Popover` の開く元になれる。
部品だけを撮る頁は `packages/ui/preview/primitives.html` で、vite の dev サーバから開く。本番の bundle には入らない。

ダイアログはどれも共通の殻（`views/primitives/Dialog.tsx`）に載せる。
殻は見出し、中身、下端のボタンの 3 段で、器の高さは窓から上下 32px ずつを引いた分までにする。
溢れた中身だけがスクロールし、見出しと下端のボタンはいつも見える。
中身が見出しの下をくぐり始めたら見出しの下に、続きがあれば下端の上に薄い影を出す。
器（覆いではなくパネル）が `role="dialog"` と `aria-modal` を持ち、`aria-labelledby` で見える見出しを名前にする。
開いたら最初の安全な操作へフォーカスを当てる。
印（`data-autofocus`）があればそこ、入力のあるダイアログは最初の欄、欄が無ければ下端の最初のボタンのうち主ボタンでも危険なボタンでもないもの（やめる、閉じる）、どれも無ければ器そのものである。
Tab は器の中で回り、閉じたら開いた元へフォーカスを返す（閉じる前にフォーカスが器の外へ移っていたら奪わない）。
閉じる手のあるダイアログは Esc と背景で閉じ、見出しの右に × を置く（取り消せない操作の確認と、下端に「閉じる」があるものには置かない）。
入力のあるダイアログ（新しいセッション、昇格）は、書きかけを押し違いで失わないよう背景では閉じない。
背景を押してもフォーカスは器の外へ落とさない。
取り消せない操作の確認（停止、一覧から削除）は、見出しの前に赤い丸のアイコンを置き、説明を見出しの下に添え、押し切るボタンを赤で塗る（`.btn-danger-fill`）。
ボタンは右に寄せ、「やめる」を赤いボタンの左に置く。
コマンドパレットは形が違う（検索欄の錠剤から広がり、一覧を縁まで敷き詰める）ので殻に載せず、器の見た目（`.dialog`）だけを共有する。

アイコンは Lucide（`lucide-react`）を使い、大きさ 16px、線幅 1.5 に固定する。
16px に縮むと実際の線幅は 1px になり、13px の本文の太さと釣り合う。
View は `lucide-react` を直接 import せず、hangar の言葉（`fork`、`resume`、`shell` など）から引く `views/primitives/Icon.tsx` だけを通す。
文字の無いアイコンだけのボタンには必ず `aria-label` を付け、文字に添えるアイコンは飾りとして読み上げから外す。
商標のアイコンは持たない（VS Code は汎用のコードのアイコンに文字を添える）。

書体は Inter 系のサンセリフに日本語は Hiragino Sans を重ね、識別子、パス、時刻、数だけの表示には JetBrains Mono 系の等幅を使う。
数と仮名が混じる短い語（「12 分前」「1,222 件」）は等幅にしない。等幅の書体には仮名が無く、数字だけが別の書体になって間が跳ぶからである。本文の書体のまま `font-variant-numeric: tabular-nums` で幅をそろえる（`.num`）。
太さは 400、500、600、700 だけを使う。Hiragino Sans は 520 や 560 を 600 に、650 や 680 を 700 に丸めて描くので、中間の値を書くと欧文だけが細くなり、和欧で太さが割れる。
ターミナルとコードブロックも同じ等幅である。
一覧の行は 2 段で 44px（`--session-row-h`）、ボタンや入力欄のような 1 段の部品は 28px（`--row-h`）、カードは 4 列、メインの最大幅は 1200px 前後で中央に寄せる。

動きの性格は「なめらか」で、すっと出て長く静かに止まる。
長さと曲線は `styles/tokens.css` のトークン（`--dur-fast` 200ms、`--dur` 420ms、`--dur-exit` 250ms、`--ease-out`、`--ease-in`、`--rise` 6px、`--blur-in` 6px、`--breathe-period` 3.2 秒）だけを通して書き、CSS にも JS にも数値を直書きしない（`styles/tokens.test.ts` が見張る）。
JS からは `views/primitives/motion.ts` で読む。
reduced motion では長さと移動とぼかしのトークンが 0 になり、端末の縁の往復が止まり、View Transitions も使わない。
使う動きは次のとおりである。

- 画面遷移。入る画面は、`--rise` だけ上がりながら、ぼかしが晴れて入る。View Transitions がある環境では、出る画面と入る画面を同じ長さと曲線で重ねて替える。長さを揃えるのは、変わらないヘッダとサイドバーが途中で明滅しないためである。
- 行を開いてセッション画面へ（決めの動き）。一覧の行を押すか Enter で開くと、その行がセッション画面の上段へ広がり、戻ると上段が縮んで元の行へ帰る。`runtime/present.ts` が画面の替わり目を View Transitions で包み、React の描画を `flushSync` で同期させる。パレットやキーボードの近道から開いたときは広げない。
- 一覧への差し込み。Projects のカードは、新しいカードがぼかしから現れ、ほかのカードは FLIP で滑って場所を空ける。
- ⌘K パレットは、ヘッダーの「探す・移動」の錠剤からガラスが広がって開き、閉じると錠剤へ戻る。開く動きは描画を遅らせない Web Animations で作り、入力欄はその描画でフォーカスを持つ。
- ダイアログは 96% から、ぼかしが晴れながら開く。通知は右下から、切断の帯は上から、ぼかしが晴れながら現れる。
- 状態点、ゲージ、TODO の線は `--dur` で色と長さを移す。状態点は変わる瞬間に 1 度だけ小さく膨らむ。
- 端末の縁は、作業中だけ `--breathe-period` で明暗を往復し、状態が変わると色が `--dur` で移る。
- ボタンはホバーで 1px 浮き、押すと 97% に縮む（`--dur-fast`）。
- 折りたたみ、分割の幅、数字の回転、新着への追従は、長さと曲線だけをトークンに揃える。
- セッション画面の右の欄、目次、タブ、案内の帯の出入りは、共通の部品（`views/primitives/motionKit.ts` ほか）で動かす（「セッション画面の動き」の節）。

シマー、スケルトン、タイピング風の表示は使わない。
例外は、セッションを開いた直後の目次の仮の行だけである（「セッション画面の動き」の節）。
脈動は端末の縁の作業中だけに許す。
`.app` の起動画面（`apps/desktop/loading/`）は、ロゴのハンガーが竿の上を流れ続ける動きで起動を待つ。
起動に失敗したら、読み込みの絵を退けて、失敗の札を 1 枚出す（次の節）。
札の「もう一度試す」と「ログを開く」が殻の命令を呼ぶ。
「もう一度試す」は殻の `retry_boot` を呼び、殻は残っている子のサーバを止め、起動画面を読み込み直してから起動をやり直す（押したボタンは押せなくする）。
動きの計算は `loading/boot-frames.js`、描画は `loading/boot.js` が持ち、起動が 3 秒を超えたら「まだ起動しています（N 秒）」と出す。
殻はサーバの `/health` が通ったら、起動画面の周の境目（1 周期 1.6 秒）まで待ってから画面を移す。
reduced motion では静止した原図を出す。
画面の中の初回索引の進行は、静的な文字で示す。

## クラウド同期

フェーズ 4 で実装した。
実物の Cloudflare で通した記録は `docs/plans/phase4-real-run.md` にある。
ただし、孤児の掃除はその後に入れたもので、偽のクラウドとローカルの workerd での試験しか通していない。

### 構成と setup

同期の基盤は利用者自身の Cloudflare アカウントに置く。
`hangar setup cloud` が wrangler の対話ログインでアカウントを選び、`packages/cloud` の Worker と D1 データベースと R2 バケットを作ってデプロイする。
資源の名前は既定で Worker と D1 が `hangar`、R2 が `hangar-files` で、`--name` で変えられる（`--name x` なら Worker と D1 が `x`、R2 が `x-files`）。
実物の設定は `~/.agent-hangar/cloud/wrangler.jsonc`（権限 0600）に書き出し、そこへ D1 の ID と R2 のバケット名を埋める。
アカウント ID はこのファイルにもコードにも書かず、wrangler を呼ぶたびに環境変数で渡す。
デプロイ直後の数秒は `workers.dev` の反映待ちで `error code: 1042` が返るので、setup は `/health` が通るまで最大 2 分試してから先へ進む。
wrangler はプロジェクトのローカル依存として同梱する。
setup の最後に **参加トークン** を表示する。
参加トークンは Worker の URL と参加用の秘密を `{url, secret}` の JSON にして base64url で包んだ文字列で、他の PC では `hangar join` でこれを渡す。
Worker は参加の要求を受けて端末ごとの端末トークン（32 バイトの乱数）を発行し、以後の要求はその端末トークンで認証する。
参加用の秘密も端末トークンも、D1 にはハッシュだけを置く。
参加用の秘密のハッシュは `wrangler secret put JOIN_SECRET_HASH` で Worker に渡し、設定ファイルには書かない。

同期は自分の端末同士のためのもので、他人と 1 つの箱を共有しない。
別の人が使うときは、その人が自分の Cloudflare アカウントで同じ `hangar setup cloud` を走らせる。
デプロイは人ごとに独立し、データは混ざらない。

Worker の D1 は、端末側の共有テーブルの形をそのまま写さない。
`changes`（変更の列）と `rows`（行の鏡）の 2 表だけを持ち、表の名前と行 ID と payload を文字列として預かる。
共有テーブルに列が増えても Worker を直さずに済むからである。
スキーマは Worker が起動後の最初の要求で整える（`ensureSchema`）。
マイグレーションの手順を別に持たず、cold start のたびに `create table if not exists` を通す形である。

Workers には配備の後に 1 度だけ走る処理が無いので、作り替えで消したものが D1 に残した行も、この最初の要求で片付ける（`packages/cloud/src/cleanup.ts`）。
段 1 では、Worker が D1 への書き込みを数えていた台帳（`meta` の鍵が `d1_rows:` で始まる行）を消した。
Claude Code の設定の同期の索引（`files` の `kind` が `config` の行）と R2 の `config/` の本体は、設定の同期を残すので消さない。
済んだら `meta` に `stage1_cleanup` の印を置き、2 度目からは印を読むだけで帰る。
消す文と印は 1 つの batch に入れるので、途中で倒れても半端に残らない。
後始末が落ちても要求は落とさず、次の cold start でまた試す。

D1 の 1 日の上限（読んだ行、書いた行）に当たった失敗は、500 ではなく 429 で返す（`packages/cloud/src/limits.ts`）。
見分けるのは D1 の文で、`free tier daily row read limit` か `free tier daily row write limit` を含むものである（大文字と小文字は問わず、原因の文も見る）。
本文は共有の `CloudLimitBody`（`{ error: 'limit', limit, resetAt }`）で、`resetAt` は上限が戻る次の UTC の 0 時（epoch のミリ秒）である。
Worker も端末も量を数えないので、上限に当たったことはこの失敗で知る。

手元のサーバ側の入口は、フェーズ 3 で入れた鍵付きの入口と入口の 3 つの検査（Origin、`Sec-Fetch-Site`、`Content-Type`）をそのまま通る。
同期のために足した `/api/sync/*` と `/api/devices` と `/api/sessions/:id/resume-here` も同じ関門の後ろにある。
Worker の側はブラウザから触らないので、端末トークンの照合だけを行う。

無料枠で収める。
D1 の無料枠は合計 5GB、1 データベース 500MB、書き込み 1 日 10 万行で、hangar のメタデータには十分である。
R2 の無料枠は 10GB で、gzip したトランスクリプト全体でも 750MB 前後に収まる（フェーズ 0 の実測で 1.4GB が 754MB になった）。
上限に当たったときは Workers Paid（月 5 ドル）に上げる。

実物で測った所要は次のとおりである。
`hangar setup cloud` は 16 秒で終わる（D1 の作成、R2 の作成、`wrangler deploy`、`secret put`、`/health` の待ち、`/join` まで）。
`hangar start` は同期を入れた後も 1.0 秒から 1.1 秒で、起動の最後の 1 往復で待たされない（APAC のリージョンで 1 往復が数十ミリ秒）。
`hangar cloud teardown` は 14 秒から 18 秒である（wrangler の呼び出しが 15 回で、1 回あたり 1 秒ほどである）。

### 同期対象と暗号化

同期するものは三つである。

- **hangar のメタデータ**：共有テーブルの全行。D1 に置く。
- **セッションのトランスクリプト**：`~/.claude/projects` の jsonl を gzip して R2 に置く。鍵は主線が `transcripts/<端末 ID>/<セッションの UUID>.jsonl.gz`、サブエージェントが `transcripts/<端末 ID>/<セッションの UUID>/subagents/agent-<hex>.jsonl.gz` で、端末ごとに分ける。UUID は Claude Code が付けた `provider_session_id` である。
- **Claude Code のユーザー設定**：`~/.claude/CLAUDE.md`、`settings.json`、`settings.json` の `statusLine.command` が指すスクリプト、`skills/**`、`memory/**`、`projects/*/memory/**`。R2 に置く。鍵は `config/<端末 ID>/<相対パス>` で、本文と同じく端末ごとに分ける。

hangar 自体の設定（ワークスペースルート、ターミナルアプリ）と UI の一時状態は同期しない。

本文は差分ではなく、**変わるたびにファイル全体を gzip して上げ直す**。
R2 は部分更新を持たないので、末尾だけを足す道が無いためである。
同じ中身を二度上げないために、端末ローカルの `file_sync` に前回の指紋（平文の SHA-256）と大きさと更新時刻を残す。

設定の同期で上げないものは、`node_modules` と `.git` と `__pycache__` と `.venv` の各段、シンボリックリンク、1MB を超えるファイル、`.DS_Store`、そして同期自身が作る `*.conflict-*` などの写しである。
写しを対象に戻すと、競合のファイルが端末間で無限に増える。
**削除は同期しない。**
片方で消したファイルが、もう片方から消えることはない。
ホームの絶対パスは `$HOME` ではなく `__HANGAR_HOME__` という目印に置き換えて上げ、降ろすときに各端末のホームへ戻す。
`$HOME` をそのまま使うと、ホームの綴りが違う端末で指紋が揃わない。
設定の同期は Settings で明示的に有効にしたときだけ動き、初めて取り込むときは下見の一覧を見せて確認を取る。
`~/.claude` を上書きする前には必ず `~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ 1 バイトも書かない。
控えは 20 世代を残し、古いものから消す。

R2 に置くファイルは端末間で暗号化する。
鍵は参加用の秘密から `hkdfSync('sha256', joinSecret, 'hangar-salt-v1', 'hangar-file-v1', 32)` で導き、AES-256-GCM で暗号化してから上げる。
Cloudflare 側は中身を読めない。
Worker も、`kind` が `transcript` で暗号化の申告が `1` でない `PUT` を、R2 に触る前に 400 で断る。
降ろす側だけが約束を守っていると、置く側は約束の外に出られる。
形式は、先頭に `HGR1` の 4 バイトと 8 バイトの nonce 接頭辞を置き、その後ろに 1MB ごとのチャンクを並べる。
チャンクは `flag`（1 バイト、最後のチャンクだけ 1）と `len`（4 バイト）と本体と 16 バイトの認証タグからなり、nonce は接頭辞にチャンク番号を継いで作る。
AAD にチャンク番号と `flag` を入れるので、並べ替え、複製、欠落、途中での打ち切りは、どれも認証タグで落ちる。
`len` には上限（1MB + 64 バイト）を置く。
他端末が書いた本文は外から来た入力なので、相手の申告する長さをそのまま信じて溜め込まない。
フェーズ 0 の計測では暗号化 2,700MB/s、復号 600MB/s で、同期の律速は gzip とネットワークである。
D1 のメタデータ（題名、要約、TODO、メモ）は平文で持ち、将来 Worker 側の機能に使えるようにする。

ファイルの一覧は D1 の `files` 表に持ち、パス、端末、SHA-256、サイズ、更新時刻、R2 の鍵を記録する。
降ろす側は、この指紋と実際に降りた中身の指紋を突き合わせる。
暗号化そのものは「鍵の同じ別のファイルへの差し替え」を見抜けないので、鍵と指紋の突き合わせがその守りになる。

`PUT` は R2 を先に書き、索引を後に書く。
途中で倒れれば、残るのは索引に無い R2 の本体だけである。
逆の向きで残る「索引にあるのに本体が無い」は、降ろす側が永久に 404 を踏む。
本文と設定を消す経路（`DELETE`）は持たない。
使われていなかったので段 1 で消した。
索引の行を消すだけの経路では、一覧を `seq` で差分に読む相手の端末が、消えたことに気付けない。
設定の同期を作り直すとき（全体計画の段 4）に、消したことを相手へ伝える印が要れば、`seq` を進める形でそこで決める。
`PUT` は `content-length` のある本文だけを受け、無ければ 411 で断る。
長さが分かれば、Worker は本文を JS で読まずにそのまま R2 へ渡せるので、CPU の時間が本文の大きさに比例しない。
長さを名乗らずに本文を流していたのは互換の版 1 より前の端末で、それは版の下限で断られる。
食い違いを拾うのは `GET /files` を契機に走る掃除である。
6 時間に 1 回だけ、R2 を 50 件と索引を 50 行まで見て、索引に無い本体と、本体の無い索引の行を消し、続きの位置を `meta` に控える。
置いてから 1 時間たっていないものには触らない。
書いている最中の 1 本を消さないためである。
当番は `meta.last_sweep_at` を条件付きで書き換える 1 文で 1 本だけ取るので、同時に来た要求どうしでも走るのは 1 本である。
誰も一覧を引かない日は走らないが、孤児が増えるのも上げ下ろしをした日だけなので、取りこぼしにはならない。
掃除自身が D1 に書くのは、孤児が数件のときのローカルの workerd での実測で 1 回 7 行、1 日 4 回で 28 行である（1 日 10 万行の 0.03%）。
消す索引の行が増えれば、その分だけ増える。

### 設定の同期の作り直し

段 4 の PR 14 で、サーバの側を作り直した（設計は `docs/superpowers/specs/2026-10-09-config-sync-rebuild-design.md`）。
`~/.claude` へ書く殻の命令と CLI は PR 16 で入れた（「適用と世代へ戻す」）。
Worker の側は PR 15 で入った（下の「互換の版」）。画面は PR 17 で入った（下の「画面（PR 17）」）。
旧実装（`sync/claudeConfig.ts`、`file_sync` の設定の行、`/sync/config/*`、`SettingsDto.syncClaudeConfig`）は、PR 18 で消した（下の「旧実装の削除（PR 18）」）。
実装は `sync/config/` にあり、既定は切である。

**旧実装の削除（PR 18）。**
消したもの：`sync/claudeConfig.ts`（と試験）、設定の取り込みの HTTP（`GET /api/sync/config/preview`、`POST /api/sync/config/pull`）、`sync/configSyncApi.ts`、画面の `ConfigPreviewDialog` と、その UiAction（`sync.config.preview`、`sync.config.apply`）と効果と Store の値、`SettingsDto.syncClaudeConfig` と `SyncStatusDto.claudeConfig`、降ろし手 `RemotePuller` の `onConfigEntries`、一時停止の 1 巡の旧実装の設定の段（新しい束の段に置き換えた）、辞書の旧い行。
一時停止のままの「今すぐ同期」の 1 巡は、本文の降ろしのあとに設定の同期の `tick`（受信、送信）を回す。スイッチが切のとき、Worker の版が足りないときは、`tick` が何もしない。
`RemotePuller` は設定（kind が `config`）の索引を降ろさず、`filesSeq` だけ通り過ぎる。束の本体は設定の同期が、束の行を見て自分で取りに行く。
`settings.json` に旧スイッチ（`syncClaudeConfig`）が残っていても、読み込みのときに未知の鍵として捨てる（`config/paths.ts` の `loadSettings`）。保存し直すと消える。
旧スイッチを入れていた人の設定は、そのまま起動でき、旧い同期は動かない。新しい実装は、設定の画面で入れ直したときだけ動く。
`PATCH /api/settings` が旧スイッチだけを送られたときは、ほかの未知の鍵と同じに 400（更新できる設定が無い）である。
スキーマの版 19 が、端末に残った旧実装の記録を 1 回だけ消す。`file_sync` の kind が `config` の行、`sync_state` の `configPullConfirmed`、`configPending`、`skipped:(config)` である。
最後の鍵は、残すと取り直しが設定の索引を本文として降ろそうとするので消す。設定の同期の新しい表（`config_*`）と、本文の記録には触らない。
控えの置き場 `backups/claude-config/` は、旧実装の世代（記録なし）と新しい世代が同じ場所に並ぶ。

**運ぶもの。**
単位は項目で、`file:<相対パス>`（`CLAUDE.md`、`keybindings.json`、`skills/**`、`commands/**`、`agents/**`、`memory/**`）、`settings:<鍵>`（`settings.json` の鍵 1 つ）、`memory:<プロジェクトの id>/<相対パス>`（プロジェクトのメモリ）の 3 種類の id を持つ。
プロジェクトのメモリは、Claude Code が `projects/<パスの slug>/memory/` に置く（slug は英数字以外を `-` にしたパス）。
slug は PC ごとに違うので、hangar のプロジェクトの id で運び、受け手が自分の `project_roots` のパスから slug を作る。
受け手にそのプロジェクトが無いときは保留にし、適用の指示書には入れられない。
`settings.json` の鍵は `sync/config/settingsSort.ts` が仕分ける。
好みの鍵（`model`、`effortLevel`、`language`、`outputStyle`、`theme`、`editorMode`、`cleanupPeriodDays`、`attribution`、`autoCompact*`、`autoMemoryEnabled`）は運ぶ。
実行（`env`、`apiKeyHelper`、`hooks`、`statusLine`、`fileSuggestion`）、認証（`aws*`、`forceLogin*`）、パス（`autoMemoryDirectory`、`plansDirectory`、`permissions.additionalDirectories`）、機械の事情（`sandbox`、`enabledPlugins`、`extraKnownMarketplaces`、`*McpjsonServers`）は運ばず、理由を付けて一覧に出す。
知らない鍵も運ばない。
権限（`permissions.allow`、`ask`、`deny`、`defaultMode`）は運ぶが、括弧の中が `//` かドライブ文字か UNC で始まる絶対パスの規則だけ落とす。
全部が絶対パスの鍵は、空の配列で相手の規則を消さないよう運ばない。
受け手が権限の鍵を適用するときは、手元の絶対パスの規則を残す（`hangar config apply` が守る。「適用と世代へ戻す」）。
シンボリックリンクは辿らず、1 MiB を超えるファイルと、`node_modules`、`.git`、`__pycache__`、`.venv`、`.DS_Store`、同期自身の写し（`*.conflict-*`、`*.hangar-tmp-*`、`*.part`）は拾わない。
ホームのパスの置き換え（`__HANGAR_HOME__`）は、新しい実装では行わない。

**秘密。**
送る前に本文を走査し、`sk-ant-`、`ghp_`、`github_pat_`、`AKIA`、`-----BEGIN`、`xox` の形（接頭辞に本物らしい長さの文字が続くもの。形だけを説明した文章は通す）があれば、その項目を送らず `config_unsent` に記録する。
見つけた文字列は記録にも応答にも載せず、形の名前だけを理由にする。
バイナリは走査しない。
`POST /api/config-sync/unsent/:id/send` が「それでも送る」で、項目に印を付けて束を上げ直す。
印は中身の指紋に結ぶので、中身が変わればまた止まる。
落とした絶対パスの規則も同じ表に入り、同じ口で送れる。

**束。**
PC ごとに 1 つの tar（`manifest.json` と `blobs/<sha256>`。`sync/config/bundle.ts` の自前の ustar）を gzip し、参加用の秘密から導いた鍵で暗号化して、既存の `PUT /files`（`kind: 'config'`）で上げる。
束を先に上げ、行（`config_snapshots`）を後に書くので、行が降りた先で束が見つからない並びにはならない。
中身（項目の id と指紋の並び）が前回と同じなら上げない。
何も運ぶものが無く、前に上げてもいない PC は、空の束を上げない。
受け手は、行の指紋が前に取りに行ったものと違う PC の束だけを取りに行き、開くときに、tar の検査和、名前（`manifest.json` と `blobs/<64 桁の 16 進>` だけ）、中身の指紋、目録の形、id の形（`parseItemId`）、束の中の端末 ID と行の端末の一致を全部検査する。
知らない id の項目と、id と種類が食い違う項目は飛ばし、それ以外の食い違いは束ごと断る。
開いた束は `~/.agent-hangar/claude-config/inbox/<端末 ID>/` に置く（一時のディレクトリに作ってから置き換える）。
`~/.claude` には触れない。
送受信は 1 本の鎖に並べ、60 秒ごとに受けてから送る。スイッチが切のあいだと、同期が止まっているあいだは何もしない。

**3 方向の判定。**
項目ごとに、手元、相手の束、前回の共通（`config_base`）の指紋を比べる（`sync/config/threeWay.ts`。表は冒頭の注記にある）。
手元と相手が同じ項目は基準に書き、どこにも無くなった項目は基準から消す。
相手が複数いるときは、項目ごとに、その項目を持つ束のうちいちばん新しいものだけを見る（束ごとに判定すると、2 台が違う版を持つときに手元がその間を行き来する）。
項目が消えたと見なすのは、どの相手の束にもその項目が無いときだけである。
3 台以上のうち 1 台だけが消したときは、その消去は他の PC に伝わらない（安全な側に倒した割り切りである）。
共通の記録が無いまま中身が違えば競合にする。
自分が送った版を相手が適用して続けて書き換え、その途中の束を受け取る前に次の束が届く、という並びでは、共通の記録が無いために競合に見えることがある。
黙って上書きするよりは安全なので、そのままにしてある（差分を見て、どちらかを採れる）。

**承諾と適用の指示書。**
skills、commands、agents は実行される指示なので、他の PC から届いたときは、新規にも上書きにも項目ごとの承諾が要る（`SettingsDto.configApproval`、既定は `'each'`）。
`'auto'` にすると要らなくなる（切り替えるときの注意は画面で出す）。
`CLAUDE.md`、`settings.json` の鍵、`keybindings.json`、メモリは、承諾の仕方に依らず `needsApproval` が偽である。
承諾した項目は、`PUT /api/config-sync/apply-order`（`{ items: [{ id, take? }] }`）で「適用の指示書」として hangar の置き場（`~/.agent-hangar/claude-config/apply-order.json`、0600）に書く。
競合は `take` で、相手を採る（`remote`）か、手元を採る（`mine`。手元は書き換えず、基準だけを進める）かを選べる。
前の指示書は置き換える。`DELETE` で取り消せる。
サーバは `~/.claude` に書かない（全体計画の D9）。指示書を読んでネイティブの確認を出し、控えを取って書き、基準を更新し、指示書を消すのは、殻の命令と `hangar config apply` の役目である。

**適用と世代へ戻す（PR 16）。**
書く処理の本体は `sync/config/apply.ts` にあり、CLI（`packages/cli/src/config.ts`）と殻の命令（`apps/desktop/src-tauri/src/configapply.rs` と `lib.rs`）が同じものを走らせる。
サーバ本体は引かず（`cliEntry.ts` から出す）、読むのは指示書と inbox、書くのは設定の入れ物と `config_base` だけである。

- `hangar config apply`：指示書を読み、件数と種類と実行される内容を見せて承諾を取り、控えを取って書く。
  `--plan` は見立てだけ、`--yes` は聞かずに書く、`--json` は機械向けに 1 行の JSON を返す（`{ ok, plan }`、`{ ok, result }`、失敗は `{ ok: false, code, message }`）。
  `--order <createdAt>` は、確認した指示書にだけ適用する（確認のあとに選び直されていたら `stale` で断る。殻が使う）。
  対話でない端末で `--yes` が無ければ書かない。
- `hangar config restore [世代]`：世代を省くと一覧を出す。
  世代を指すと戻す先と消す先を見せて承諾を取る（`--plan`、`--yes`、`--json` は同じ）。
- 殻の命令 `apply_config_sync`（引数なし）と `restore_config_sync(name)`：CLI に `--plan --json` を走らせ、返った件数と種類をネイティブの確認（`tauri-plugin-dialog` のメッセージ）に出し、承諾されたときだけ `--yes --json`（適用は `--order` 付き）を走らせる。
  実行される内容（skills、commands、agents、フックとコマンド実行とスクリプトの印）を含むときは警告の見た目で出し、その件数と項目の名前（5 件まで）を書く。
  結果は `{ status, message, generation }`（`status` は `applied`、`restored`、`cancelled`、`none`、`failed`、`busy`）で頁へ返す。
  失敗は確認と同じネイティブの窓でも知らせる。
  頁から渡せるのは世代の名前だけで、`yyyyMMdd-HHmmss` の形を殻が確かめる。
  権限は `capabilities/remote-config-apply.json` の 2 つだけである。頁の側の呼び出しは PR 17 で足した（`runtime/desktop.ts` の `applyConfigSync()`、`restoreConfigSync(name)`。結果は上の `{ status, message, generation }` で、形の違う返事は失敗として扱う）。
- 適用の順序は、(1) 指示書を読み、inbox と突き合わせて全項目が書けるかを先に確かめる、(2) 書く先の元の中身を世代に控える、(3) 一時ファイルに書いて rename する、(4) `config_base` を 1 つの transaction で更新する、(5) 指示書を消して、世代を新しい 20 個に保つ、である。
  (1) で 1 つでも合わなければ何も書かずに断る。
  束が更新されて指紋が合わない（`stale`）、書き込み先が id から決まる場所と違う、途中がシンボリックリンクか通常でない（`unsafe`）、届いた値が鍵の型に合わない、`settings.json` が JSON のオブジェクトでない、のどれかである。
  指示書は残す。
  (3)、(4) の途中で失敗したら、世代から元へ戻し（作ったファイルとディレクトリも消す）、世代を消し、指示書は残す。
  戻す途中でも失敗したときは世代を残し、`hangar config restore <世代>` で戻す手順を文に入れる。
- 控えの世代 `backups/claude-config/<yyyyMMdd-HHmmss>/` には、書く先の元のファイルを設定の入れ物からの相対パスで置き、直下の `.hangar-apply.json`（世代の数には入れない）に、その時点で無かった先と無かったディレクトリ、`config_base` の前の値を残す。
  旧実装の世代（記録なし）も、ファイルを書き戻すだけで戻せる。
  同じ秒にもう一度取るときは、前の世代を潰さずに次の秒の名前にする。
- 世代へ戻すときは、戻す前の状態を新しい世代として控える（戻しを取り消せる）。
  無かった先は消し、`config_base` も適用の前の値へ戻す（DB が開けないときはファイルだけ戻す）。
  そのため、戻したあとは、その項目がもう一度届いた変更として一覧に出る。
- 項目ごとの書き方：ファイルとメモリは中身をそのまま書く（権限は手元のものを保ち、新しいファイルは 0644。skills のスクリプトにも実行の許可は付けない。他の PC からの実行経路にしないため）。
  競合で手元を採る項目は書かず、基準を相手の指紋に合わせる（次の同期で手元が送られる）。
  相手が消した項目の競合で手元を採るときは、基準の行を消す。
  消す項目は、元の中身が世代に残る。
  `settings.json` は、鍵ごとの項目を 1 回の読み書きでまとめて当てる。
  ほかの鍵、並び、字下げ、末尾の改行は保つ。
  無ければ作る（0600）。
  権限の `allow`、`ask`、`deny` は、届いた規則を入れ、手元の絶対パスの規則は残す（相手が鍵を消したときも、絶対パスの規則だけ残る）。
- サーバの側の追加：適用と戻しはサーバの外で起きるので、60 秒ごとの送受信の回で指示書の有無と世代の数を見て、変わっていたら `config.update` を配り直す。
  `ConfigBase` は `sync/config/base.ts` に分けた（適用する側がサーバ全体を引かないため）。

**画面（PR 17）。**
設計は段 4 の設計書の 2.5（a1、b1、c2、d1、e2）である。
設定の「クラウド同期」の節の「Claude Code の設定を同期」に常設の行を並べ、中身はダイアログで見せる。
スイッチは `SettingsDto.configBundleSync`（`PATCH /api/settings`）で動かす。
入れるときは送る一覧（a1）を見せて承諾を取り、承諾すると `{ configBundleSync: true }` を送る。
切るのは確認なしにその場で保存する。
入れた直後は、サーバが次の周期を待たずに送受信を 1 回回す（`boot/sync.ts` の `publishConfigSync`）。
`ConfigSyncDto.workerPending` が真のあいだは、行の下に「Worker の更新待ち」の帯を出し、`hangar setup cloud` をもう一度実行して Worker を入れ替えるよう案内する。
行は、適用の待ち（指示書があるとき）、届いている変更、承諾待ち（承諾の仕方が毎回で、承諾の要る項目があるとき）、承諾の仕方、競合、送らなかった項目（0 件でも残す）、バックアップの順である。
承諾の仕方を自動に切り替えるときは、その場に注意の文と、キャンセル、自動にする、を出し、押すまで保存しない。

ダイアログは 1 つの overlay（`configSync`）で、`part` が 4 つの顔を決める。

- `send`（a1）：種類ごとの折りたたみ。見出しに件数。`settings.json` は鍵と値。項目が 12 を超えるとき、スキル、コマンド、エージェント、メモリは最初から畳み、見出しに先頭 3 つの名前を添える。送らないもの（落とす鍵と理由）を最後の群に置く。
- `review`（b1）：操作ごとの折りたたみで、競合、削除、上書き、新規、保留の順。群ごとに何が起きるかの 1 文。「適用…」は、競合でも保留でも承諾の要るものでもない項目だけを指示書にする。承諾の要るものと競合は、このダイアログから開く入口を出す。
- `approve`（c2）：承諾の要る項目の表にチェック。印（フック、コマンド実行、スクリプト）の無い行だけを「印の無いものを選択」でまとめて選べ、「すべて選択」は置かない。印のある行は、「内容」で中身の先頭（サーバが 400 文字まで返す）を開くまでチェックできず、印の付く行を強調する。競合は含めない。
- `conflicts`（d1）：1 件を 1 枚の札にし、差分（手元から相手へ。赤は手元、緑は相手）を最初から出す。「相手を採用」「自分を採用」を押して選び（もう一度押すと外れる）、選んだ分を `take: 'remote' | 'mine'` つきで適用する。

選んだ項目（チェック、採る側）は View だけが持ち、`configSync.apply { entries }` で 1 度に渡す。
適用は、サーバに指示書を書かせ（`PUT /api/config-sync/apply-order`）、殻があれば `apply_config_sync` でネイティブの確認へ進む（runtime）。
確認の返事が来るまで、ダイアログは閉じられず、押せない。
`applied` と `restored` のときは状態を取り直してダイアログを閉じ、`cancelled`、`none`、`busy`、`failed` のときは書いていないので開いたままにして文を知らせる（`failed` は赤）。
ブラウザでは殻が無いので、指示書を書いたところで閉じ、設定の「適用の待ち」の行が `hangar config apply` を案内する。
指示書は、殻の確認で取り消されたときも残るので、同じ行から「適用…」で確認をやり直すか、「取り消す」（`DELETE`）で消せる。
バックアップの世代は、行を開くと一覧が出て、殻があれば「この世代に戻す…」（`restore_config_sync`）、無ければ `hangar config restore <世代>` を出す。

件数と状態は `ConfigSyncDto`（bootstrap と `config.update`）が正で、項目の一覧は Store の `configDetail`（送る一覧、届いた変更、競合、送らなかった項目、世代）に、設定の画面に入ったときとダイアログを開いたときに取る。
件数が 0 のものは取りに行かない（サーバは項目の走査をするため）。
設定の画面かダイアログを見ているあいだに状態が動いたら、取り直す。
送らなかった項目の通知カードは作らない（ベルの一覧の行は PR 19）。
送る一覧（a1）は、スイッチが切のあいだに読むので、秘密らしい文字列で止まる項目と、落とした絶対パスの規則（`config_unsent`）は、入れたあとに「送らなかった項目」の行へ出る。

**経路（`http/routes/sync.ts`）。**
すべて `/api` の認証の下にあり、同期を設定していない端末では 404 を返す。

| 経路 | 中身 |
| --- | --- |
| `GET /api/config-sync` | `ConfigSyncDto`（スイッチ、承諾の仕方、届いた数、競合、保留、送らなかった数、控えの世代の数、指示書、最後に送った時刻）。`GET /api/bootstrap` の `configSync` と、`config.update` イベントも同じ形 |
| `GET /api/config-sync/outgoing` | 送る一覧。種類ごとの項目、`settings` の鍵の値、運ばない鍵と理由。スイッチが切でも読める |
| `GET /api/config-sync/inbox` | 届いた変更。項目ごとに種類、操作（`create`、`overwrite`、`delete`、`conflict`）、送り主、大きさ、実行の印、中身の先頭、保留、承諾が要るか |
| `GET /api/config-sync/conflicts` | 競合。両側の PC と時刻と大きさ、差分の行（`RetentionPreviewLine` と同じ形） |
| `GET /api/config-sync/unsent`、`POST /api/config-sync/unsent/:id/send` | 送らなかった項目と、「それでも送る」 |
| `GET /api/config-sync/backups` | 控えの世代（`backups/claude-config/` の `yyyyMMdd-HHmmss`）。戻す操作は殻の命令 `restore_config_sync` と `hangar config restore` |
| `GET`、`PUT`、`DELETE /api/config-sync/apply-order` | 適用の指示書 |

**互換の版。**
`config_snapshots` は共有テーブルの一覧に足したので、配備済みの Worker は、この表の行を含む push を 400 で丸ごと断る。
そのまま行を書くと、他の表の同期まで止まる。
そこで端末は、Worker が名乗る互換の版が `CONFIG_BUNDLE_MIN_WORKER_COMPAT`（`packages/shared/src/compat.ts`。いまは 3）に届くまで、スイッチが入っていても束も行も送らない。
Worker の版は、同期の 2xx の応答の見出しから `CloudClient.lastWorkerCompat()` が返す。まだ Worker と話していないあいだは null で、送らないが、更新待ちとは言わない。
版が届いていないとき、`ConfigSyncDto.workerPending` が真になる（スイッチが入っているときだけ）。画面は「Worker の更新待ち」を出す。この状態が変わったときは `config.update` を配り直す。
受け取る側は止めない。行が無ければ取りに行くものも無いからである。
PR 15 が、Worker の名乗る版（shared の `COMPAT_VERSION`）をこの値の 3 に上げた。
`MIN_WORKER_COMPAT` と `MIN_DEVICE_COMPAT` は上げない。上げると、配備前の Worker を使う端末が全部止まる。

**Worker の側（PR 15）。**
Worker に足した経路も、D1 の表も、移行も無い。
束の本体は既存の `PUT /files/config/<端末>/.hangar/config-bundle.hgr`（kind は `config`、自端末の鍵だけ書ける）と `GET /files/<鍵>` で運び、束の行は既存の `POST /changes` と `GET /changes`、`GET /rows` で運ぶ。
`changes` と `rows` は表名と行 ID と payload を文字列で預かるだけなので、`config_snapshots` の行のための D1 の表は要らない。
Worker が表名を断るのは `packages/cloud/src/changes.ts` の `SHARED_TABLES`（shared の一覧）で、PR 14 がこの一覧に表を足したので、この版の Worker は行を受ける。
Worker の変更は、名乗る版を 3 に上げることだけである（`COMPAT_VERSION` は殻の `health.rs` の写しと同じ定数なので、殻の写しも 3 に上げた）。
`packages/cloud/test/config-bundle.test.ts` が、行の受け取りと別の端末への配り（`GET /changes` と `GET /rows`）、取り下げの行、目録の上限（payload 128 KiB）、版 2 の端末の push、束の置き直しと他端末の上書きの拒否を縛る。

配備の手順は次のとおりである。
実物への配備は利用者が打つ（`hangar setup cloud` をもう一度実行して Worker を入れ替える）。D1 の移行は無い。
1. Worker を先に配備する。配備した時点で、Worker は版 3 を名乗る。版 2 の端末は、下限（2）以上なので断られず、今までどおり同期できる。
2. 端末を入れ替える。新しい端末（PR 14 以降）は、Worker の応答の見出しで版 3 を見るまで、スイッチが入っていても束も行も送らない（`workerPending`）。見たあとで送り始める。
3. 端末を先に入れ替えて Worker が版 2 のままのときは、端末は黙って待つ。Worker が版 2 のままで束の行を送ると、他の表の同期まで止まるので、送らない。
4. 版 2 の端末と版 3 の端末が混ざっても、束の行を送るのは版 3 の端末だけで、版 2 の端末は `config_snapshots` の行を `rows` から受け取っても、知らない表として捨てる。旧実装の設定の同期は、この間も旧い索引（`config/<端末>/<相対パス>`）を使った（PR 18 が消した。版 4 の下限は、その端末を断る）。
5. 殻と 4177 のサーバは一致で比べるので、入れ替えた殻は、入れ替える前のサーバ（版 2。利用者の `npm run dev` など）を採らない。
無料枠への影響は、束 1 回の送信につき R2 の PUT が 1 回（class A）、D1 の書き込みが `files` の 3 文（削除、挿入、`devices` の更新）と `changes` の 3 文（変更ログと `rows` の鏡と `devices` の更新）で、件数に依らない。束は端末ごとに 1 つなので、旧実装（項目ごとに PUT 1 回と D1 3 文）より、変更の多い日ほど軽い。
送り直すのは束の指紋が変わったときだけである。

旧実装の置き場（R2 の `config/<端末>/<相対パス>` と `files` の kind が `config` の行）の後始末は、`cleanupLegacyConfig`（`packages/cloud/src/cleanup.ts`）である。PR 15 が実装し、関門 `LEGACY_CONFIG_CLEANUP_ENABLED` は閉じてあった。
旧実装を積んだ端末は、この索引と本体を読んで取り込み、置き直しもするので、旧実装が端末から消える前に消せない。
PR 18 が関門を開け、同時に Worker の `MIN_DEVICE_COMPAT` を 4 へ上げた（`COMPAT_VERSION` も 4。旧実装を持たない最初の版）。
関門を開ける条件は「この Worker が配備されたとき、版 3 までの端末は 426 で断られ、旧い置き場に触れない」ことである。この 2 つは同じコミットに入れてあり、片方だけを配備する道は無い。
版 3 の端末は PR 15 から PR 17 までの版で、旧実装の設定の同期を積んでいる。版の下限を 4 にしなければ、掃除のあとも旧い端末が旧い置き場を作り直す。
関門を開けた Worker は、cold start のたびに 100 件ずつ（最大 5 回）、束の本体と索引（相対パスが `.hangar/config-bundle.hgr`）を除く設定の索引と本体を消し、取り切ったら `meta` に印を置いて以後は読むだけで帰る。
D1 の書き込みは消した行の数で、旧実装の項目の総数が 1 度かかるだけである。R2 の削除は無料である。
束の本体は孤児の掃除（`sweep.ts`）の対象に今までもならない（索引があるため）。

**配備の順（PR 18）。**
この版の Worker は、版 4 未満の端末をすべて断る。同期に参加している端末を先にすべてこの版へ入れ替えてから、`hangar setup cloud` をもう一度実行して Worker を配備する（「互換の版番号」の「いつ上げるか」と同じ決まりである）。
先に Worker を配備すると、入れ替えていない端末は 426 で止まり、画面に「この PC の hangar を更新する」と出る。入れ替えれば止まっていた間の差分から続く。
配備した Worker は、最初の cold start で旧い置き場の掃除を走らせる。1 度だけで、無料枠への影響は上の見積もりのとおりである。実物のクラウドへの配備と掃除は、利用者がやる前に確かめる。

**手元にあるが運ばないもの。**
リンク、1 MiB を超えるファイル、読めないファイル、件数の上限（5000）を超えたファイル、リンクのディレクトリの下、読めない `settings.json`（リンク、大きすぎる、JSON でない、オブジェクトでない）、リンクのメモリの置き場は、項目として集めない。
ただし「手元にある」ことは記録する（`collect.ts` の `Blocked`）。
記録が無いと、相手から同名の項目が届いたときに「手元に無い」と見て `create` と判定し、適用で手元を上書きしてしまう。
記録に当たる項目は、届いた変更の一覧に `held: 'local-blocked'` で出し、届いた数にも競合にも数えず、適用の指示書にも入れられない。
塞ぎが解ければ、次の判定から通常に戻る。

### 使用量と費用

設定の「クラウド同期」に、D1 の書き込み、Workers の要求、R2 の今月の量、今月の費用、プランを出す（見た目は「設定」の節）。
Cloudflare の数と費用は、読み取り専用の API トークンを Worker の secret に置き、Worker 経由で全部の端末に配る。
トークンが無くてもアプリも同期もいままでどおり動く。

**Worker の `GET /usage`。**
端末トークンの検査（`authMiddleware`）の後ろに置く。
D1 にも R2 にも 1 行も書かない。
secret は `USAGE_API_TOKEN`（Account Analytics: Read と Billing: Read だけを持つ API トークン）と `CF_ACCOUNT_ID` で、どちらかが無ければ `{ configured: false }` を 200 で返し、Cloudflare へは問い合わせない。
あれば三つに問い合わせて一つにまとめる。
今日の D1 の書き込みと Workers の要求は GraphQL（`d1AnalyticsAdaptiveGroups` と `workersInvocationsAdaptive`、日は UTC）、プランは `GET /accounts/{id}/subscriptions`、今月の費用と量は `GET /accounts/{id}/billable-usage` である。
三つは独立に取り、一つが落ちても残りは返す。
落ちた部分は `null` にして `errors` に 1 行の理由を載せ、API の生の応答やトークンは載せない。
トークンが失効したとき（401、403）は三つとも `null` にして入れ直しを案内する。
写しは isolate のメモリに持つ（今日は 5 分、プランと今月は 6 時間）。
Cloudflare の文書は workers.dev での Cache API について記載がない（2026-10-02 に確かめた）ので、メモリの写しで足りるとして使わない。

**端末のサーバ。**
`CloudUsagePoller`（`packages/server/src/sync/usage.ts`）が、同期を設定している端末で 5 分ごとと設定画面を開いたときに `GET /usage` を取りに行く。
一時停止の間は取りに行かない。
一時停止は「外と話すのをやめる」ことで、Cloudflare の上限で退いている間も同じだからである。
止まっている間は最後に取れた値を出す。
例外は、一時停止の間に利用者が押した「今すぐ同期」の 1 巡で、その終わりに 1 度だけ取り直す。
ただし上限で退いた 1 巡では取り直さない。
`configured: false` は「トークンなし」として扱い、形は「数は不明」（`source` が `unknown`、今日の数は null）にする。
hangar は量を数えない（段 1、D4）。
取れなかったとき（通信の失敗、5xx）は、最後の値を残して `stale` を立てる。
同期を止めず、トーストも出さない。
配る形は `CloudUsageDto` で、HTTP は `GET /api/sync/usage`（`?refresh=1` で取り直す）、websocket は `sync.usage`、bootstrap は `cloudUsage` である。
上限は共有の定数 `CLOUD_FREE_LIMITS`（`packages/shared`）に置く。

**上限で退く。**
段 1（D4）で、端末が数えて 80% で止める見張り（`QuotaCounter`、`pausedReason`、`quotaPausedDay`）を消した。
代わりに、Cloudflare の上限による失敗を受けたら、次の UTC の 0 時まで同期を止める。
見分けるのは同期の client（`sync/client.ts` の `LimitError`、判定は共有の `cloudLimit.ts` の `readCloudLimit`）である。
見分ける対象は次の 3 つである。
1. 「Worker の 429 と上限の本文」
2. 「本文に D1 の上限のメッセージを含むもの」
3. 「JSON でなく `1027` を含むもの」（Workers の 1 日の要求の上限）

上限の検査は版の検査より先に行う。
端が返す `1027` の頁は版の見出しを持たないからである。
`SyncEngine` は戻る時刻を `sync_state` の `limitedUntil` に置き、push と pull の入口を閉じる。
立て直しても、戻る時刻までは外へ出ない。
時刻を過ぎた最初の定期実行（30 秒ごと）で自分で戻り、まだ断られればまた次の 0 時まで退く。
新しく退いたときと、違う戻る時刻へ移るときにトーストで知らせ、同期の状態の `error` には残さない。
UTC の 0 時から 10 分の間に断られたときは、その日の枠はもう戻っているとみなし、5 分だけ黙って退く（トーストも出さない）。
Cloudflare の巻き戻しの遅れ、端末の時計のずれ、0 時の直前に出した要求が 0 時をまたいで断られた場合に、24 時間退かないためである。
猶予の外で断られたら、次の 0 時まで退いて知らせる。
利用者の「今すぐ同期」は 1 回だけ試し直す。
まだ断られれば、また次の UTC の 0 時まで退いて、トーストで知らせる。
短い印がまだ生きている間に猶予の外で断られて 1 日の退きへ移るときも、トーストで知らせる。
同じ戻る時刻へ退き直すときは重ねて知らせない。
利用者が自分で一時停止している間に頼んだ 1 巡が上限で断られたときのトーストは「Cloudflare の無料枠の上限に達したので、同期できませんでした。同期は一時停止のままです」とし、戻る時刻は入れない。
止めたのは利用者なので、自動で再開するとも言わない。
利用者の「今すぐ同期」で試し直すときは、使用量も 1 度取り直す。
同期の状態には `limitedUntil` を載せ、退いている間の `state` は `paused` である。
利用者が一時停止しているときは、一時停止を先に見せる。
本文の上げ下ろしは、上限の失敗を諦めに数えない。
Worker は D1 の上限の失敗を 429 で返す（「構成と setup」）。

**トークンを入れる。**
`npm run hangar -- setup cloud --usage-token` が `installUsageToken`（`packages/cli/src/cloud.ts`）を走らせる。
トークンは標準入力から読み（端末なら伏せ字、パイプなら 1 行）、argv には載せない。
入れる前に `tokens/verify` と subscriptions と GraphQL を 1 回ずつ叩いて有効さと二つの権限を確かめ、足りなければ足りない権限の名前を出して止める。
確かめたら `wrangler secret put` で `USAGE_API_TOKEN` と `CF_ACCOUNT_ID` を入れる。
普段の `setup cloud` の最後にも、標準入力が端末のときだけ「使用量のトークンを入れますか（後からでも可）」と尋ねる。
入れられるのは setup を実行した端末（`cloud.json` に `accountId` と `workerName` がある）だけで、参加しただけの端末では setup した端末で入れるよう案内して止める。
外すときは `wrangler secret delete USAGE_API_TOKEN` を手で打つ。

### タイミングと競合

メタデータは、ローカルで変更した 1 秒後に `changes` の未送信分をまとめて push する。
ただし push には最小間隔 10 秒があり、実行中のセッション 1 本で 2 秒ごとに送り続けることはしない。
1 回の push は 40 行まで、1 回の pull は 500 行までである。
pull は起動時、ウィンドウが前面に来たとき、30 秒ごと、セッション起動の直前（2 秒で諦める）に行う。
Worker は受け取った変更を `changes` に積み、`rows` の鏡を更新して、サーバ側の連番を付ける。
pull は連番以降の変更を返す。
競合は行単位で `updated_at` の新しい方を採用する。

`GET /changes` は自分の端末が起こした変更を除いて返す。
自分で送った行をそのまま受け取っても、適用しても何も変わらないうえ、読む量だけが倍になるからである。
一方 `GET /rows`（全件の取り直し）は除かない。
これは参加した直後や取りこぼした後に、現在の全行を手に入れるための道なので、自端末の行も要る。

**親より先に降りた行の持ち越し。**
適用は外部キーを即時に検査し、1 頁の中では親の表から順に当てる。
しかし `GET /rows` は鍵（`表:行 ID`）の辞書順で 500 行ずつ降りるので、`runs:`、`session_notes:`、`session_states:`、`session_summaries:` は、親の `sessions:` より前の頁に来る。
差分でも、親を書き直すと親の連番の方が後ろになり、子が前の頁、親が後の頁に分かれることがある。
そこで同期エンジンは、当てられなかった行を頁をまたいで持ち越し、写しを読み切った後と、差分を読み切った後に、まとめて当て直す（`sync/engine.ts` の `carried`）。
表には依らない。外部キーを持つどの表の行も、同じ道を通る。
最後まで親が現れなかった行は、黙って捨てない。数と表を記録に出し、`sync_state` の `orphans` に覚えて、次の pull の終わりにもう一度試す（再起動をまたぐ）。
区切り（`lastSeq` と `snapshotDone`）は止めない。止めると、クラウドに孤児が 1 行あるだけで、毎回の pull が同じ頁か写しの全部を読み直し、無料枠を食う。

- **覚える時機。** 差分では、頁を当てるたびに、`lastSeq` を進める前に `orphans` を書く。写しでも、読み切って印を付ける前に書く。
  区切りだけが先に進むと、その間にプロセスが落ちたとき、持ち越していた行は二度と降りてこない。
  当て直すあいだも持ち越しは消さず、当たった行だけを外す。当て直しが失敗しても、持ち越しは残る。
  持ち越した行より新しい版が先に当たっていれば、当て直しはその行を採らずに外す（古い版には戻らない）。
- **寿命。** 覚えた時刻を行ごとに持ち、30 日（`ORPHAN_KEEP_DAYS`）たっても親が現れなければ、捨てて記録に 1 行出す。
  親が消えた行はいつまで待っても当てられず、寿命が無いと毎回の pull がその全件を当て直し続ける。
- **上限。** 覚える行は 5,000 件（`MAX_CARRIED_ROWS`）までである。超えたら、行は捨てずに、最初の写しをやり直す（`snapshotDone` を外す）。
  写しを読み直せば、親と子が同じ 1 巡にそろう。
  古い順に捨てると、版 17 の写し（時刻が 1 の名前とメモ）が真っ先に消え、区切りは進んでいるので二度と降りてこない。
  やり直しは 1 回の起動につき 1 度までである。やり直しても超えていたら、写しを読み直してもそろわない行なので、覚えた時刻の古い順に捨てて記録に出す。
  そのときも `session_notes` は最後に捨てる。やり直しを繰り返す輪にはしない。

積みっぱなしにしないための刈り込みが 2 つある。
端末ローカルの `changes` は、push 済みで 7 日を過ぎた行を消す。
Worker の `changes` は、受信から 14 日を過ぎ、かつ接続した全端末が読み終えた連番までを消す。
消した区間の上端は `meta.changes_floor` に残し、`GET /changes?since=` がそれより前を求めてきたら `410` と `{ error: 'gone', floor }` を返して、全件の取り直しを求める。
これが無いと、長く止めていた端末が変更を黙って取りこぼす。

無料枠は数えない（段 1、D4）。
Cloudflare の上限による失敗を受けたら、次の UTC の 0 時まで同期を止めてトーストで知らせ、日が変われば自分で戻る（「使用量と費用」の「上限で退く」）。
Free は上限を超えても課金されず、失敗が返るだけである。
Worker も量を数えない（段 1 の PR 6 で台帳を外した）。

トランスクリプトは、jsonl の変化を検知して 30 秒のデバウンスでファイル全体を上げ直し、run の終了で確定する。

上げるのは、クラウドを使い始めた後に動いた本文だけである。
参加より前に索引が済んで止まっている本文は上げない。
利用者は先に hangar を使い、後からクラウドを足すので、参加の時点で手元に何百件もの本文が溜まっている。
実測では 1,060 件で生の合計 1.6GB あり、これを全部押し込む意味は薄いと判断した。
メタデータ（セッションの一覧、要約、プロジェクト、TODO、メモ）はこの区切りを見ない。
そちらは今までどおり全部同期するので、他端末からも一覧と検索の結果は揃う。

区切りの時刻は `sync_state` の `transcriptsFrom` に置く。
刻むのは `hangar setup cloud` と `hangar join` で、`cloud.json` を書くのと同じ時点である。
両者は処理の先頭で `sync/transcriptsFrom.ts` の `openTranscriptsFloor` を開いておき（DB の控えが取れなければ、外に何も作らずにそこで止まる）、`cloud.json` を書いた後にその `stamp` で刻む。
「使い始めた時刻」の出どころは、クラウドの設定を作った時点そのものだからである。
サーバの起動まで待つと、区切りを刻まない古いサーバが先に走る隙ができる。
実物でそれが起きた。
配布版の `.app` が区切りの入る前のサーバを同梱していて、そちらが先に起動して `lastSeq` と `filesSeq` を書いた。
後から起動した新しいサーバは、その進み具合を見て「既に同期していた端末だ」と読み違え、区切りを 0 にした。
上げないと決めた過去の本文が 105 件、148 MB 上がった。
そのため、同期の進み具合から参加の有無を推し量る判定はやめた。
古いサーバが先に走ったという理由で区切りが消えてはいけない。

サーバ側の刻みは保険として残す。
効くのは、`cloud.json` はあるのに DB に区切りの行が無い端末である。
CLI が刻むようになる前に参加した端末のほか、DB を作り直した端末や、`cloud.json` だけを写した試しの `HANGAR_HOME` も当たる。
段 1 で、これは古い版のための分岐ではないと判断して残した。
消すと、区切りの行が無い端末は 0（区切りなし）と読み、手元の本文を全部上げる。
使う値は `cloud.json` の `joinedAt` で、それを読めない古い設定のときだけ今の時刻にする。
`joinedAt` は参加し直しと秘密の作り直しで今の時刻へ書き換わるが、読むのは区切りが 1 つも無いときだけなので、書き換わった値が入るのは、区切りの行が無い端末に限られる。
その端末では、参加し直した時点が新しい区切りになる。
区切りは一度刻んだら動かさないので、それ以降は後ろへ動かない。
行が無いときも 0 として読むので、刻む前の端末の振る舞いは変わらない。

いまの区切りは `hangar cloud status` が 1 行で見せる。
区切りが 0 のときは「手元の本文を全部上げます」と出す。
利用者が区切りの正しさを確かめられないと、上がらない理由も上がりすぎた理由も追えない。

取り残しの走査と、画面に出す「未送信の本文」の件数は、どちらもこの区切りを条件に持つ。
数の側に入れないと、上げる予定の無い本文が何百件も画面に並び続ける。
参加より前の本文を上げたくなったら、そのセッションを再開すればよい。
ファイルが伸びるので索引が変化を見て、いつもの経路で上がる。
まとめて上げ直すときは `hangar cloud backfill` で区切りを 0 に落とす。
走査は区切りを 1 回ごとに読み直すので、サーバを立て直さなくても次の走査から効く。

他端末の新着は pull で全部取り込み、`~/.agent-hangar/remote/<端末 ID>/`（0700、ファイルは 0600）に置いて手元で索引化する。
これで検索は全端末で揃う。
降ろせないファイルが 1 つあっても後ろが止まらないように、同じ項目で 3 回続けて失敗したら飛ばして先へ進む。
飛ばした項目は `sync_state` に残し、中身が入れ替わったとき、サーバを起こし直したとき、30 分ごとの 3 つの機会で試し直す。
飛ばした件数と、まだ上げていない本文の件数はヘッダーに出し、鍵と理由と試した回数は Settings のクラウド同期の節に並べる。

Claude Code の設定は、変化を検知して 5 秒のデバウンスで push し、加えて 60 秒ごとに変わったものを送る。
`fs.watch` の recursive は macOS と Windows にしか無いので、定期の走査を併せ持つ。
起動のたびに 1 度、全体を走査してから上げる（指紋が同じものは上がらない）。
これが無いと、同期を入れて起こし直しても `~/.claude` に触るまで 1 件も上がらない。
両端末で同じファイルを変えていたら新しい方を採用し、古い方を `<name>.conflict-<端末名>-<時刻>` として隣に残して通知する。
実物では、片方の書き換えが相手に降りるまで 10 秒から 30 秒だった。

プロジェクトのメモ（`project_memos`）は、行の競合では新しい方を採る規則をそのまま使う。
ただし負けた方の本文を捨てない。
`memo.conflict-<端末名>-<時刻>.md` として隣に残し、控えが書けなかったらその行を適用しない。
上書きを進めると、利用者が手で書いた文章が黙って消えるからである。

セッションの名前とメモ（`session_notes`）も、新しい方を採る規則をそのまま使う。同じ時刻なら手元を残す。
版 17 の写し同士（どちらも写しの定数の時刻）だけは、降りてきた側を採る（「セッションの名前とメモ」）。
こちらも負けた方を捨てない。
手元の名前かメモに中身があり、降りてきた行でそれが別の中身になる（または消える）とき、上書きの前に手元の中身を `~/.agent-hangar/backups/memos/session-<セッション ID>-<時刻>.md` に残す。
本文は負けたメモで、名前も負けたときは先頭に「名前：<名前>」の 1 行を足す。入れ物は 0700、控えは 0600 である。
中身が同じとき、手元が空のとき、手元に行が無いときは、控えを作らない。
控えが書けなかったら、その行を適用しない。
置き場と形は、名前とメモが `sessions` の列だった頃と同じである。
その頃は、索引の書き直しが、誰も書き換えていないメモを巻き込んで上書きするたびに控えが取られた。
別の表に分けた今は、控えが取られるのは、別の PC で名前かメモを実際に書き換えたときだけである（「セッションの名前とメモ」）。
2 台が、同期の収束する前に版 17 へ上がり、写した中身が違っていたときも、ここで負けた側が残る。
控えは、取ったときと起動のときに刈る。新しい方から 200 件（`MEMO_BACKUP_KEEP_COUNT`）は日数に依らず残し、それを超えた分のうち 180 日（`MEMO_BACKUP_KEEP_DAYS`）より古いものだけを消す。
分ける前は新しい方から 20 件を残していたが、それだと 1 回の pull で 21 件以上ぶつかったときに、いま取った控えがその場で消える。
日数だけで刈ることもしない。控えは負けた中身の唯一の置き場なので、しばらく使わなかった PC を起こした時点で消えてはならない。
控えが書けずに行を飛ばしたときは、記録に 1 行を出す。同期は止めない。

オフラインのときは `changes` に積んだままにし、復帰時に順に送る。
ヘッダーの同期の一行には最終同期時刻、未送信件数、エラーを出す。
操作は持たず、語を押すと設定のクラウド同期の節へ行く。「今すぐ同期」と「一時停止」はそこにある。
Cloudflare の上限で退いている間は、「無料枠で停止 · 9:00 にリセット」と言い、設定では「今すぐ同期」だけを置く（「クラウド同期」の「使用量と費用」の「上限で退く」と、設定の節を参照）。
一時停止の間に「今すぐ同期」を押すと、その 1 回だけ全部を巡って、元の一時停止に戻る（`packages/server/src/sync/pausedPass.ts`）。
巡るのは、メタデータの送受信、他端末の本文と設定の受け取り、設定の押し出し、取り残した本文の全部（走査の 1 回 20 件の上限を外す）、使用量の取り直しである。
止めた状態は書き換えない。
上限で退いた印は、利用者が押した 1 回として外して試し直す。
終わりはトーストで知らせ、送れずに残った件数があればそこに添える。
巡っている間も状態は「一時停止中」のままなので、進みは付録の `oncePass` で画面へ伝える。
サーバは押した直後と、その後 1 秒ごとに状態を配り、ヘッダーと設定は「1 回だけ同期中…」と書いて点を作業中の色にし、設定は「今すぐ同期」を押せない「同期中…」に替える。
未送信の件数は配るたびに数え直すので、減っていくのが見える。
D1 の Time Travel（無料枠で 7 日）で巻き戻せる。

### 互換の版番号

hangar の部品のうち、別々に上がりうるのは、端末どうし（同期で Worker を挟む）、端末と Worker、殻と 4177 で動いている既存のサーバである。
UI とサーバと CLI は同じ束で配るので、版番号を持たない。
別々に上がる部品は、1 つの整数 `COMPAT_VERSION`（`packages/shared/src/compat.ts`、はじめは 1、いまは 4。版 3 は、Worker が設定の束の行を受け取る版。版 4 は、設定の同期の旧実装を消した版で、段 4 の PR 18 が Worker の下限を 4 に上げた）を名乗り、相手に下限を持つ（殻と既存のサーバだけは、下限ではなく一致で比べる）。
古い版のための分岐を部品ごとに抱える代わりに、下限より古い相手とは話さずに、理由を出して止まる。

**見出し。**
サーバと CLI は、Worker へ出すすべての要求に、見出し `X-Hangar-Compat` で自分の版を載せる。
Worker は、断ったものも含めたすべての応答に、同じ見出しで自分の版を載せる。
見出しの無い相手は、版番号を入れる前の古い版とみなし、版 0 として読む。
整数として読めない値も版 0 として読む。
Worker の `/health` は `{ ok, version, compat }` を返し、サーバの `/health` も `compat` を返す。

**Worker の下限。**
Worker は、端末に求める下限 `MIN_DEVICE_COMPAT`（`packages/cloud/src/compat.ts`）を持つ。
下限より古い端末の要求には、スキーマの用意にも認証にも進まずに、426 と `{ error: 'upgrade required', minCompat, compat }` を返す。
`/health` だけは版を問わずに通す。
版を確かめに来る口だからである。
いまの下限は 4 で、見出しの無い端末（版 0）も、旧実装の設定の同期を持つ版 3 までの端末も、426 で断る（版の経緯の表）。
段 1 の PR 6 で、同期に参加する端末がすべて版 1 に上がったのを確かめてから上げた。

**端末の下限。**
サーバは、Worker に求める下限 `MIN_WORKER_COMPAT`（`packages/server/src/sync/client.ts`）を持つ。
いまの下限は 1 で、見出しを返さない Worker（版 0）は断る。
そのため、`/usage` の無い古い Worker の 404 を「トークンなし」に読み替える分岐は持たない。
Worker から 426 が返るか、応答の見出しの版が下限より古ければ、`HttpCloudClient` は `CompatError` を投げる。
応答の見出しで Worker の版を比べるのは、2xx の応答だけである。
Cloudflare の端は、Worker を通さずに 4xx と 5xx を返すことがある（WAF の 403、本文が大きすぎるときの 413、CPU の超過、1 日の要求の上限など）。
それらは見出しを持たず、Worker の版を語らないので、版の不一致にはせず、普通の失敗として扱う。
2xx は Worker を通らないと返らないので、古い Worker はどの経路でも最初の 2xx で見分けられる。
`SyncEngine` は `CompatError` を受けたら同期を止め、状態を `error` にして、どちらを上げればよいかを `error` の文に書く。
426 なら「この PC の hangar を更新する」、Worker が古ければ「setup した PC で `hangar setup cloud` をもう一度実行して Worker を入れ替え、今すぐ同期を押す」である。
止めている間は、メタデータの送受信も、本文と設定の出し入れも、使用量の取りに行きも外へ出ない（`sync/halt.ts` の `syncHalted`）。
一時停止していても、版で止まったことを先に見せる。
そのとき状態は `error` になるので、一時停止していることは `SyncStatusDto` の `paused` の印で画面へ伝える。
画面は文と「状態」の語の頭に「同期を一時停止中 · 」を添え、設定は一時停止の切り替えを隠す。
再開しても、この PC の hangar を更新するまで同期できないからである。
直す道が `error` の文にしか無いからである。
一時停止のまま「今すぐ同期」を押した 1 巡（`PausedPass`）でも、メタデータの送受信が版で断られたら、その 1 巡の本文の取り込みは外へ出ない（`isPaused` を通す）。
その 1 巡の終わりの知らせは、「1 回だけ同期しました」ではなく、版の文を error として出す。
止めた印は `sync_state` に残さない。
この PC の hangar を入れ替えれば立て直しで消え、Worker を入れ替えたなら、利用者が押した「今すぐ同期」が 1 回だけ試し直して戻る。
本文の上げ下ろしは、426 を直りようのない失敗として諦めない。
どちらかを上げれば通るからである。
`hangar join` と `hangar setup cloud` の参加も版を載せ、426 なら hangar を上げるよう伝えて止める。
426 を受けたときの本文の読みにも、参加の 1 回ごとの締め切りを掛け、本文を流さない相手で止まらないようにする。
`hangar cloud status` は、この PC と Worker の版を 1 行で出す。

**いつ上げるか。**
`COMPAT_VERSION` を上げるのは、次のどれかを、古い相手と話せない形で変えるときだけである。

- 同期の形（共有テーブルの行の運び方、変更ログ、ファイルの鍵と暗号の形式）。
- Worker の API（経路、要求と応答の形、見出し）。
- 殻とサーバの合図（`/health` の形、起動と停止のやりとり、UI が呼ぶ殻の命令とその答えの形）。

項目を足すだけで古い相手も読める変更では上げない。
版を上げても、下限を上げなければ、相手は断られない。
ただし殻と既存のサーバは一致で比べるので、版を上げると、上げた殻は上げる前のサーバを採らず、上げる前の殻は上げた後のサーバを採らない（「殻と既存のサーバ」）。
下限を上げるのは、相手がすべて版番号を持つ版に上がってからである。
Worker の `MIN_DEVICE_COMPAT` は、同期に参加しているすべての端末が上がってから上げ、Worker を配備し直す。
端末の `MIN_WORKER_COMPAT` を上げる版は、Worker を先に配備してから端末へ入れる。
逆の順にすると、入れ替えた端末は古い Worker を断って、配備するまで同期が止まる。

**版の経緯。**

| 版 | 変えたもの | 下限 |
| --- | --- | --- |
| 1 | 版番号そのもの。見出しを持たない相手を版 0 として断る | `MIN_DEVICE_COMPAT` と `MIN_WORKER_COMPAT` を 1 に |
| 2 | セッションの名前とメモを、`sessions` の payload ではなく `session_notes` の行で運ぶ | どちらも 2 に |
| 3 | Worker が設定の束の行（共有表 `config_snapshots`）を受け取る。端末は Worker の版が 3 に届くまで束の行を送らない | 上げない |
| 4 | 設定の同期の旧実装を消す（項目ごとに R2 の `config/<端末>/<相対パス>` へ置く方式）。Worker は旧い置き場を掃除する | `MIN_DEVICE_COMPAT` を 4 に（`MIN_WORKER_COMPAT` は 1 のまま） |

版 2 で下限を両方とも上げたのは、版 1 と版 2 が混ざると名前とメモが消えるからである。
版 1 の端末は `session_notes` を知らない表として捨て、名前とメモを `sessions` の payload に載せる。版 2 の端末はその 2 つの列を知らない列として捨てる。
版 1 の Worker は、共有テーブルの一覧に `session_notes` を持たず、その行を含む push を丸ごと断る。
Worker の D1 のスキーマは変わらない（表名と行 ID と payload を文字列で預かるだけである）。変わるのは、受け付ける表名の一覧（shared の `SHARED_TABLES` を束ねたもの）と下限の定数だけである。
入れる順は、上の決まりのとおり、Worker を先に配備し、それから端末を入れ替える。
Worker を配備した時点で、まだ上げていない端末（版 1）は 426 で断られ、上げるよう理由が出て同期が止まる。上げれば、止まっていた間の差分から続く。

**殻と既存のサーバ。**
殻は、同梱するサーバと同じ版を `apps/desktop/src-tauri/src/health.rs` の `COMPAT_VERSION` で名乗る。
正本は shared の `COMPAT_VERSION` で、`apps/desktop/test/config.test.ts` が Rust の原本を読んで突き合わせる。
同梱の `manifest.json` から読まないのは、既存のサーバを探る前に同梱のサーバの置き場を読めなければならなくなるからである。
殻とその同梱のサーバは同じコミットから同じ束で作るので、写しを試験で縛れば足りる。
殻は 4177 の既存のサーバを採る前に `/health` を 1 回読み、`compat`（無ければ版 0）が自分の版と等しいときだけ採る（`judge_existing`）。
比べ方は下限ではなく一致である。
版の違うサーバの UI を出すと、殻とサーバの合図（起動の進み具合、殻の命令）が食い違っても気付けない。
版が違えば採らず、失敗の札（種類 `compat-mismatch`）に、どちらが古いかと、動いているサーバの版と殻の版を出す。
サーバが古いときは、そのサーバを止めてから「もう一度試す」を押すことを言う（止めれば、殻が同梱のサーバを起こす）。
殻が古いときは、Hangar.app を入れ替えるか、そのサーバを止めてから「もう一度試す」を押すことを言う。
札に、そのポートで待ち受けているプロセスを調べる命令（`lsof -nP -iTCP:4177 -sTCP:LISTEN`）を添える。
lsof の無い Windows では添えない（Windows のデスクトップのアプリはまだ無い）。
殻はポートと 2 つの版の数だけを渡し（`BootFailure::compat_mismatch`）、文は頁の表（`loading/boot-fail.js`）が作る。
殻はそのサーバを止めない。
利用者が自分で起こしたもの（`hangar start` や `npm run dev`）かもしれず、ポートの番号だけを頼りに止めないためである。
hangar でない相手（状態コードが 200 で、`ok` が真で `version` が文字列の応答でないもの）は、版を問わずに「居ない」とし、これまでどおり同梱のサーバを起こしにいく。
殻が採るのは同じ版のサーバだけなので、`/health` の `ready` を持たない古いサーバを済んだものとみなす分岐は持たない。
`ready` が真偽値でない応答は起動の進み具合として読まず、応答の無いサーバとして扱う。

### 他端末セッションのロックと「この PC で再開」

他端末のセッションは、閲覧と検索は常にできる。
「この PC で再開」は明示操作で、その端末の最新の本文を `~/.claude/projects/<変換名>/<sessionId>.jsonl` にコピーしてから `claude -r` を実行する。

他端末に生きた run（`ended_at` が null で `deleted_at` が null）があるセッションは、**heartbeat の新旧にかかわらず**ロックされているとみなす。
heartbeat が 2 分（`LOCK_STALE_MS`）より古いときは、ロックを解かずに `stale` の印を立てる。
古い heartbeat でロックを解いてしまうと、相手がまだ走っているのに手元から再開できてしまうからである。
UI は `stale` でないとき「<端末名> で実行中」、`stale` のとき「<端末名> が応答がありません」と表示する。
ロックされている間は再開とフォークを止める。
`stale` のときだけは「この PC で再開」を押せるようにする。
相手が落ちて heartbeat だけが残った状態を、行き止まりにしないためである。
heartbeat は 30 秒ごとの push で更新する。

「この PC で再開」は、手元に同じセッションの本文があり、それが降ろす本文より**小さいときだけ**確認を出す。
承諾したら、上書きの前に `~/.agent-hangar/backups/transcripts/<sessionId>-<時刻>.jsonl` へ控えを取る。
控えが取れなければ `~/.claude` を触らずに戻る。
手元の方が大きいか同じときは、黙って上書きしない。

**引き継ぎは作らない。**
2026-09-19 の判断で、ロックの表示と「この PC で再開」までに絞った。
段 1（2026-10-07）で、型、UiAction、ServerEvent を消し、`takeover_requests` を共有テーブルの一覧からも外した。
表は v1 のマイグレーションに残るが、誰も書かず、同期でも運ばない。
`EndReason` に `taken_over` は足していない。
引き継ぎが無いので、他端末の run はこちらの操作では止まらない。
「この PC で再開」は本文を降ろして手元で新しい run を立てるだけなので、同じセッションの本文が 2 か所で伸びうる。
この枝分かれは受け入れる。

他端末の本文を索引化するときは、共有テーブルの `sessions` と `session_summaries` には書かず、端末ローカルの表（`transcript_files`、`event_index`、`event_fts`）だけを書く。
同じセッションの同じ位置につき索引化するファイルは常に 1 つで、手元の本文があればそれを優先し、無ければ更新時刻が最新の写しを 1 つだけ採る。
本文が 2 か所で伸びても、見た目が二重にならないようにするためである。

## 配布と運用

リポジトリは public で、MIT ライセンスで公開している（`LICENSE`、著作権者は `gaku1023`）。
GitHub Actions で型検査とテストを回し、タグを打つと macOS 用の `.app` と Windows 用の NSIS のインストーラをビルドして Releases に置く。
`.app` は Developer ID では署名せず、自作の証明書で署名する（署名の台本と手順は `docs/signing.md`）。dmg（主）と zip（予備）に SHA-256 の checksum を添える。
利用者はそれをダウンロードして `/Applications` へ移し、初めて開いて出る警告の後で、システム設定の「プライバシーとセキュリティ」の「このまま開く」で許可してから（管理者のパスワードを求められる）、`hangar setup` を走らせる。
検疫属性を `xattr -rd com.apple.quarantine` で外す道は、最後の手段として残す。
前提として Node 22 と tmux と `claude` が要り、Homebrew なら `brew install node@22 tmux` で入る。`node@22` は keg-only なので、アプリに見つけさせるには `brew link --overwrite --force node@22` か `nodePath` の指定が要る（アプリも同梱の CLI も PATH を見ずに探すため、PATH を通すだけでは効かない）。
移動を先に置くのは、検疫属性が付いたまま開くとアプリの案内より先に Gatekeeper のダイアログが出るからである（2026-09-20 の実測）。
配布物は dmg が主で、zip は従（自動更新と予備）である（段 5 の決定）。
Release の資産は `Hangar-<タグ>-macos-<arch>.dmg` と `.zip`、それぞれの `.sha256` である。
dmg の中身は `.app` と `/Applications` へのリンクの 2 つだけで、`apps/desktop/scripts/make-dmg.sh` が hdiutil で作る。
tauri の dmg ターゲットは使わない。
tauri の dmg は build の途中の `.app` を詰め、`tauri bundle --bundles dmg` も `.app` を作り直してから詰めるので、build の後で署名した `.app` が入らないからである（2026-10-10 に手元で確かめた）。
Finder を AppleScript で動かさないので、窓の並びは決めず、窓の無い CI でも同じに作れる。
利用者の手順（dmg から `/Applications` へドラッグし、初回の警告を「完了」で閉じ、システム設定の「プライバシーとセキュリティ」の「このまま開く」と管理者のパスワードで越える）は README の「インストール（配布版）」にある。
クラウド同期の設定は `.app` の同梱 CLI からは行えない。
wrangler を同梱していないので、リポジトリを clone した場所から `setup cloud` を走らせる。

`hangar setup` は次を行う。

1. `~/.agent-hangar/` を作り、端末 ID とローカルトークンを生成する。
2. tmux、claude、code、iTerm2 の有無を確認して報告する。
3. ワークスペースルートを確認し、初回のプロジェクト自動登録を行う。
4. statusline スクリプトへの追記を提案し、承諾されたら追記する。
5. `hangar mcp install` を提案する。

## フェーズ

- **フェーズ 0**：危ない前提を捨てられる小さなスクリプトで検証する。計画は `docs/plans/phase0-spikes.md`。
- **フェーズ 1**：サーバ、インデクサ、読み取り専用の UI。Projects、セッション一覧、トランスクリプト、Sessions（検索）、土台の要約。計画は `docs/plans/phase1-readonly.md`。
- **フェーズ 2**：tmux での起動、ターミナルの埋め込み、セッション内タブ、MCP、指示の注入、iTerm2 と VS Code の連携、セッション自身による要約。計画は `docs/plans/phase2-launch.md`。
- **フェーズ 3**：使用量、アーティファクト、TODO とメモ、スクラッチと昇格、タブと分割、事後要約、パレットとショートカット。併せて、鍵付きの入口と入口の 3 つの検査（Origin、`Sec-Fetch-Site`、`Content-Type`）を入れた。計画は `docs/plans/phase3-workbench.md`。
- **フェーズ 4**：クラウド同期。Worker と D1 と R2 の setup、メタデータと本文と Claude Code 設定の同期、無料枠の見張り（段 1 で消し、上限で退く形に替えた）、他端末のロックと「この PC で再開」まで実装した。引き継ぎの握手は作らなかった（段 1 で作らないと決めた）。計画は `docs/plans/phase4-sync.md`、実物での確認は `docs/plans/phase4-real-run.md`。
- **フェーズ 5**：デスクトップ配布。Tauri v2 のシェル、サーバの同梱と子プロセスとしての起動、Node の探索、`hangar://` のディープリンク、タグから `.app` を作る Releases のワークフローまで実装した。署名と公証は行わない。計画は `docs/plans/phase5-desktop.md`。

## 会話の保持期間

Claude Code は、保持期間（`cleanupPeriodDays`、既定は 30 日）を過ぎた本文を、セッションを始めたあとの掃除で通知なしに消す。消えた本文は hangar でも読めなくなる。
設計は `docs/superpowers/specs/2026-10-01-retention-notice-design.md` にある。要点は次のとおりである。

- サーバは組織の設定（macOS は `/Library/Application Support/ClaudeCode/`、Linux は `/etc/claude-code/`、Windows は `C:\Program Files\ClaudeCode\`）とユーザー設定を読み、効いている日数と、それがどこで決まったかを配る。プロジェクトの設定と `--settings` は読まない。
- 本文の使用量（`~/.claude/projects` の合計と、直近 30 日の増え方）は起動の 30 秒後と 1 時間ごとに測る。見込みは増え方を日数で掛けた概算である。
- 書き込みは下見の指紋を添えた `PUT /api/retention` だけが行う。文字列の上で 1 か所だけを書き換え、読み直して他のキーが変わっていないことを確かめる。組織の設定があるとき、UTF-8 として読めないとき、書式を読み取れないときは書かない。
- 設定の同期の取り込みは、降ろした後に手元の状態を判断し直す。通信の最中に書かれた保持期間を巻き戻さない。
- 索引器は、手元の本文ファイルが消えた行を片付ける（DB の行だけで、ファイルには触れない）。`projects` そのものが見えないときは片付けない。

## 決めた前提と未決事項

インタビューで問わず、筆者が埋めた前提を列挙する。
異論があれば、この文書を直してから実装を変える。

- ポートは 4177 固定。データディレクトリは `~/.agent-hangar/`。
- ID は UUID v7。マイグレーションは番号付き SQL をアプリ起動時に適用する。
  一覧（`packages/server/src/db/migrations.ts` の `MIGRATIONS`）の先頭は起点で、版は 16 である（`BASELINE_VERSION`）。
  起点は、版 1 から版 16 までを順に当てた DB と同じスキーマを作る 1 本の SQL で、行は入れない（2026-10-09 に畳んだ）。
  新しい DB は、起点を当てると版 16 になる。
  版 1 から上がってきた版 16 の DB は、起点を当て直さずにそのまま開く（`schema_migrations` に版 16 の行があるため）。
  起点より古い版の DB は、上げる道を持たないので、開かずに断る（`db/open.ts` の `DbTooOldError`）。
  版は、書き込み用に開く前に、読み取り専用の接続で読む。
  断る DB の中身（本体と `-wal` の頁）は 1 バイトも変えず、控えも取らない。
  書き込み用の接続で読むと、WAL の DB では、閉じるときに `-wal` が本体へ書き戻されて `-wal` と `-shm` が消える（実測）。
  読み取り専用でも変わるものが 2 つ残る。WAL の DB では SQLite が `-shm`（`-wal` の索引で、DB の内容は持たない）を作るか書き直し、`-wal` が無ければ空の `-wal` を作る（実測）。
  排他のロックは I/O の失敗になり、better-sqlite3 の SQLite は URI の名前を受けないので immutable も使えず、これは避けられなかった。
  なので断る文は「何も書かない」ではなく「DB の中身は変えない」と言う。
  文は、DB の版、起点の版、畳む前の版の Hangar で一度起動して上げてから起動し直すことを言い、サーバも CLI もそれを出して起動を止める。
  使っているのは利用者 1 人で、その DB はすでに版 16 にあるので、古い版から上げる道は要らないと決めた。
  スキーマを変えるときは、起点を書き換えずに、次の版（17 から）を一覧の末尾に足す。
  版 17 は、セッションの名前とメモを `session_notes` へ移した（「セッションの名前とメモ」）。
  版 18 は、設定の同期の作り直し用に `config_snapshots`（共有）、`config_base`、`config_unsent`（端末ローカル）を足した（「設定の同期の作り直し」）。
  版 19 は、旧実装の設定の同期が端末に残した記録（`file_sync` の kind が `config` の行と、`sync_state` の `configPullConfirmed`、`configPending`、`skipped:(config)`）を消した（「設定の同期の作り直し」の「旧実装の削除（PR 18）」）。
  足した版は今までと同じに扱う。既存の DB には控えを取ってからその版だけを当て、新しい DB には起点から順に当てる。
  畳む前のマイグレーションは、試験の側（`packages/server/test/legacyMigrations.ts`）に残してある。
  `db/baseline.test.ts` が、起点だけを当てた DB と版 1 から順に当てた DB で、`sqlite_master` の全行（表、索引、FTS の仮想表とその影の表）、表ごとの列（順、型、not null、既定値、主キー）、外部キー、索引の列、表の中身が一致することを突き合わせる。
  空白と引用符の違いだけを均して比べる。
  起点の注記を create 文の外に書くのは、文の中に書くと `sqlite_master` が持つ SQL に注記まで残り、この突き合わせで落ちるためである。
  古い版の DB を作る試験の補助（`packages/server/test/oldDb.ts` の `seedDbAt`）は、起点までは畳む前のマイグレーションを、その先は一覧の続きを当てる。
  以下は、畳む前の版の経緯である（4 で `usage_daily` の鍵に `file_path` を足して `artifact_versions(artifact_id)` の索引を置き、5 で `session_summaries` に `source_id` を足し、6 で `usage_daily` を空にして `transcript_files.indexer_version` を 0 に戻し、7 で `mcp_secrets` を作り、8 で `transcript_files` に `device_id` と索引を足して `file_sync` を作り、9 で `session_activity` を作り、10 で `todos` に完了の候補の 4 列を足し、11 で `devices.shell_hook` を足し、12 で `turn_intents` を作り、13 で `session_states` を作って生きているセッションをまとめて Done にし、14 で `session_states` に戻る時刻の 2 列を足し、15 で `usage_snapshots.account` と 2 つの索引を足し、16 で無料枠の見張りの名残（`sync_state` の `quota:*` と `pausedReason`）を消し、見張りが止めた一時停止を解いた）。版 6 は、`file_path` を持たない古い行をどちらに寄せても作り直しの消し方が正しくならないための積み直しである。全ファイルが索引の作り直しに回るので、実物の DB では約 35 秒かかり、その間だけ日別の使用量が欠ける。版 8 の `device_id` は既存の行では null のままにする。端末の ID は DB ではなく `device.json` にあり、マイグレーションからは読めないためである。
- FTS5 のトークナイザは trigram。
- R2 の鍵は端末 ID を含み、同じセッション ID の本文が端末ごとに分岐しても上書きしない。
- Claude 側で利用者が付けた名前（`nameSource` が `user`）は、hangar が保持する名前より優先する。
- `history.jsonl` にあって本文ファイルが見つからないセッションは、一覧に「本文なし」として出す。
- 初回索引は背景で走らせ、UI は「N / 総数 件」の静的な文字で進行を示す。
- 意味検索は持たないが、LM Studio に埋め込みモデルがあるので、将来ローカルで追加できる。
- `event_index` の一意制約は `(session_id, ifnull(parent_agent, ''), seq)`。サブエージェントの本文は別ファイルで独立に伸びるので、主線と `seq` の空間を分ける。
- 端末ローカルのテーブル `session_stats` を持つ。ターン数、モデル、effort、変更ファイル数、PR の URL、トークン数、最後の発言を索引から導出して置き、共有しない。
- 土台の要約の `state` は、レジストリに生きた項目があれば `in_progress`、無ければ `done`。UI は `source = 'baseline'` の状態を控えめに描く。
- サブエージェントは、そのファイルの先頭の記録から `subagent` イベントを作り、親の時系列でその直前にある `Agent` か `Task` のツール呼び出しの下にネストする。該当が無ければ独立した項目として出す。
- セッションの表示名は、レジストリの `name`（`nameSource` が `user`）、本文の `custom-title`、`agent-name`（索引が `sessions.custom_title` に拾う）、hangar で付けた名前（`session_notes.name`）、`ai-title`、最初の発言の先頭 40 字の順で決める。
- 開発時は Vite（ポート 5173）が `/api` と `/ws` をサーバへプロキシし、プロキシがトークンを `Authorization` ヘッダに付ける。この経路は `HANGAR_DEV=1` のときだけ通る。本番はサーバが `packages/ui/dist` を配信し、鍵付きの入口で開かれたときだけ `index.html` の応答で `hangar_token` クッキー（HttpOnly、SameSite=Strict）を渡す。
- 一覧の初期データは `GET /api/bootstrap` で全セッションの軽い行をまとめて返す。手元の規模（数百セッション）では 1MB 未満で、ページングは持たない。
- UI のテストのうち `src/views/**`、`src/action/**`、`src/Root.test.tsx` は jsdom で走らせる。Vitest の入れ子プロジェクトで環境ごとに分ける。
- ダークモードは持たない（2026-09-17 の決定）。OS のダーク設定にも従わない。ターミナルの面だけが例外である。
- タブ 0（Claude）の ID は run の ID そのもので、`run_tabs` に行は作らない。シェルタブの ID は `run_tabs.id` である。
- tmux のセッション名は run が `hangar-<shortId(runId)>`、シェルタブが `hangar-<runShort>-t<n>` で、`<n>` は閉じたものを含むタブ数に 1 を足す。閉じた番号は再利用しない。
- tmux の target は必ず `=<name>` の完全一致で指定する。素の名前は前方一致に落ちるので、`hangar-X` が消えているとそのシェルタブ `hangar-X-t1` に当たる。
- `tmux` の呼び出しに失敗したときは「セッションが無い」ではなく「観測できなかった」として扱い、生きた run を閉じない。`tmux` が一瞬入れ替わるだけで、動いている run が全部終了扱いになるためである。
- `claude` の起動に失敗し、本文ファイルも索引の行も無く、他に run も無いセッションの行は消す。残すと再開もフォークもできない空の行が一覧の先頭に溜まる。
- 対話セッションで user スコープの `hangar` と `--mcp-config` の `hangar` が同時に読まれても、Claude Code は名前で併合するので `/mcp` には 1 つだけ出る（2026-09-18 に実機で確認）。
- PTY の中継は `/ws/pty?tab=<tabId>` で、`/ws` と同じ認証を通す。WebSocket が閉じたら `tmux attach` のクライアントだけを殺し、tmux セッションは残す。
- 起動ダイアログの model、effort、permission mode、worktree、追加ディレクトリは空欄を既定にし、空欄の項目は起動引数に含めない。

以下はフェーズ 3 の実装で決めた前提である。

- 使用量の保存：statusline の payload は `usage_snapshots(at, payload)` に生の JSON で積み、直近 500 件だけ残す。5 時間と 7 日の値は `UsageTracker` がメモリに持ち、サーバ起動時に新しい順へ走査して両方の窓が埋まるまで読む。`rate_limits` の無い payload では直前の値を保ち、`updatedAt` も更新しない（ゲージの「最終更新」は使用率が届いた時刻を指す）。
- セッションごとの付帯情報：payload の `model`、`effort`、`context_window`、`cost` は端末ローカルの `session_live_stats` に Claude の UUID（`provider_session_id`）を鍵として置く。`SessionDto.stats` の `model` と `effort` はこの表を `session_stats` より優先し、この表に無ければ索引から導いた `session_stats` の値を使う。`contextPercent` と `costUsd` は `session_live_stats` にしか供給源が無く、statusline の追記を入れていないセッションでは常に null になる（UI は「未取得」と出す）。`contextPercent` は `current_usage` の入力とキャッシュのトークンの和を `context_window_size` で割った百分率で、`current_usage` が無い 1 回目は書かない。`costUsd` は `cost.total_cost_usd`。
- statusline の追記先：`~/.claude/settings.json` の `statusLine.command` から先頭の `bash `、`sh `、`zsh ` を除いた最初の語を `~` 展開し、ファイルとして存在すればそこへ追記する。存在しなければ追記せず、スニペットと手順を印字する。追記位置は 1 行目が `#!` で始まればその直後、そうでなければ先頭で、目印の行があって中身も今の形と同じなら何もしない。バックアップは同じディレクトリの `<name>.bak-<yyyymmddHHMMSS>`。
- statusline のスニペットは、`${HANGAR_HOME:-$HOME/.agent-hangar}/statusline-header` を `curl -H @<ファイル>` で読む。ファイルには `Authorization: Bearer <トークン>` の 1 行が入り、権限は 0600 である。読めないときは何も送らずに素通しする（`if [ -r ... ]` で包む）。ポートは追記時の値を埋め込む（`hangar statusline install --port <n>`）。`exec <<<` を使うので、追記先のスクリプトは bash か zsh である必要がある。
- ヘッダのファイルを用意する場所：`hangar statusline install` と、サーバの起動時の両方で用意する。起動時はトークンを読むのと同じところで、無ければ作り、トークンと食い違えば書き直し、他人に読める権限なら 0600 へ狭める。中身も権限も揃っているときは触らない（毎回書き直すと mtime だけが動く）。install のときにしか置かないと、`~/.agent-hangar` を消した利用者の使用量が、何のエラーも出ないまま止まる。
- 入っているスニペットの差し替え：目印の行があるだけでは何もしないとせず、目印から `exec <<<"$__hangar_input"` までの範囲を読み取り、今の形と違えばその範囲だけを差し替える。トークンを argv に載せる古い形が残り続けないようにするためである。目印はあるのに終わりの行が見つからないときは、手で書き換えられているとみなして何もしない。
- jsonl の使用量の集計：端末ローカルの `usage_daily(session_id, day, file_path, input_tokens, output_tokens)` を索引化のときに埋める。鍵は（`session_id`、`file_path`、`day`）で、索引の作り直しではそのファイルのぶんだけを消してから積み直す。主線とサブエージェントは別のファイルなので、片方を積み直しても他方の集計は残る。`day` はイベントの `timestamp` をローカル時刻で `YYYY-MM-DD` にしたもの。プロジェクト別は `session_stats` のトークン数を `sessions.project_id` で束ねる。推定コストは価格表を持たず、statusline の `cost.total_cost_usd` を持つセッションの和だけを出す（1 件も無ければ null）。
- アーティファクトの抽出：`Artifact` ツールの呼び出しを `artifact_calls(tool_id, session_id, file_path, description, favicon)` に控え、結果の本文から URL を取り出せたときだけ公開とみなす。記録するのは `action` が無いか `publish` のときだけで、`read` や `list` は公開ではない。`artifacts` は URL で 1 件にまとめ、`first_published_at` は最小、`last_published_at` は最大を保ち、説明と favicon は新しい公開の値で上書きする。
- アーティファクトの版：`artifact_versions` は（`artifact_id`、`session_id`、`published_at`）が同じ行が既にあれば追加しない。索引の作り直しでは版を消さず、同じ行を書き直すだけにする。消すとサブエージェント由来の版が巻き添えになり、`changes` にも削除が残らないためである。版はアーティファクト単位で引くので、`artifact_versions(artifact_id)` に索引を置く。
- アーティファクトの題名：表示のたびに計算せず、公開を記録するときに決めて `artifacts.title` に書く。元ファイルがあれば先頭 64KB の `<title>`、無ければ説明文の先頭 60 字を使う。手で足した URL は題名 null で、UI は URL の末尾を出す。
- TODO の並び：`position` は追加のたびにそのプロジェクトの最大値に 1 を足す。並び替えの操作は持たず、完了した項目も同じ並びに打消し線を引いて残す。削除は論理削除。`todos.session_id` はセッション別 MCP URL の `update_project` から足したときだけ入る。
- TODO の完了の候補：`todos` に `candidate_at`、`candidate_session_id`、`candidate_note`、`rejected_sessions`（却下したセッション ID の JSON 配列、既定は `'[]'`）の 4 列を足した（マイグレーション version 10）。`candidate_at` が null でなければ候補で、候補は必ず未完である。MCP からは完了にできず、完了にするのは `POST /api/todos/:id/confirm` と、利用者のチェック操作である `PATCH /api/todos/:id` の `done` だけである。却下したセッションの ID は `rejected_sessions` に積み、そのセッションからは同じ TODO の候補を出し直せない（別のセッションなら出せる）。セッション別でない URL から出した候補は、却下してもセッション ID が無いので積まれず、出し直せる。`setTodoDone` は完了にも未完にも戻すときにも候補の列を消し、`rejected_sessions` は完了を開き直しても消さない。同期は行を JSON の payload のまま運ぶので D1 にマイグレーションは要らず、列を持たない古い端末は適用のときに自分の表に無い列を捨てる。`done = 1` かつ `candidate_at` 非 null の行が届いたときは、読むときに完了として扱い、候補は無いものとする。
- メモの正：`project_memos.markdown` とファイル `~/.agent-hangar/projects/<projectId>/memo.md` の両方に書く。読むときはファイルの mtime が DB の `updated_at` より新しく中身が違えばファイルを正として DB を直す。`~/.agent-hangar/projects/` を `fs.watch`（再帰）で見て、300 ミリ秒のデバウンスで取り込む。取り込みは `project_memos` の行を書くので、`memo.update` と `project.upsert` は配る層が配る（「行の変化の知らせと配る層」）。`memoHead` は空行でない最初の行の先頭 80 字で、全文は `GET /api/projects/:id/memo` で読む。DB を正として書き戻すときは、ファイルの中身が DB と違うときだけ、消える本文を `memo.md.bak-<yyyymmddHHMMSS>` として同じディレクトリに残してから書き戻す。同じ秒に 2 度来たら連番を足し、既にある控えは上書きしない。控えは古くなっても消さない。控えを残せなかったときは書き戻さず、ファイルの方を残す。
- スクラッチの擬似プロジェクト：端末ごとに 1 つで、DB の名前は「スクラッチ」（同期で端末をまたぐ値なので、これは変えない）、この端末の `project_roots.path` は `~/.agent-hangar/scratch`。ディレクトリ名は `<yyyymmdd-HHmmss>`（ローカル時刻、同じ秒に 2 つ作るときは `-2`、`-3`）。Projects 画面の表と、新しいセッションのダイアログのプロジェクトの選びにはこの行を出さず、ホームの絞り込みのプロジェクトの選びには出す。
- 擬似プロジェクトの表示名：画面に出す名前は DB の名前ではなく辞書の `project.name.quick`（日本語「クイックセッション」、英語「Quick sessions」）で、いまの言語で出す。`projectDisplayName`（`presenters/projectName.ts`）を通し、一覧の行、絞り込みの選択肢と条件、欄の `project:` の語、プロジェクト画面の見出し、セッション画面の親のリンク、ホームの札、パレットの副題、設定の使用量の表がそろって同じ名前になる。
- スクラッチかどうかの判定は、スクラッチのルートの下にあるかで行い、ルート自身は含めない。`scratch_root` は `project_roots` を端末で絞って引く。
- 昇格：`POST /api/sessions/:id/promote { name, gitInit, moveFiles }`。`name` は `/` を含まない 1 字以上で、`<workspaceRoot>/<name>` が既にあれば 409。移動は先に全件の衝突を調べてから `fs.renameSync` で行い、途中で失敗したら逆順に戻す。`moveFiles` が真でも run が生きていれば移動せず、`moved: false` と理由を返す。
- プロジェクトの作成：`POST /api/projects` は本文を 2 つの形で受ける。`{ kind: 'newDir', name, gitInit }` は `<workspaceRoot>/<name>` を作り（`git init` は選ばれたときだけ）、プロジェクト行とこの端末の `project_roots` を作って 201 を返す。名前の検証、既にあれば 409、`git init` に失敗したら作ったものを片付けることは、昇格と同じ `createProjectDir` を通る。`{ kind: 'dir', path, name? }` は既存のディレクトリを登録し（`registerProjectDir`）、新しければ 201、登録済みなら 200 で既存を返す。名前を省くと basename になり、アーカイブされたプロジェクトなら Active に戻す。先頭の `~/` はホームに直し、相対パスと、ワークスペースのルートやその上のフォルダ（`/` を含む）は 400 で断る。ルートを登録すると最も長い一致でワークスペースの下のセッションをすべて取り込み、直下のフォルダの自動の登録も止まるためである（Finder で何も選ばずに「開く」を押すとルートが返る）。`kind` の無い本文は 400 で断る。
- 未登録のフォルダの一覧：`GET /api/workspace/dirs` は、ワークスペース直下の隠しでなく、この端末で登録済みのルートに当たらないディレクトリを、名前順に `{ name, path }[]` で返す。比較は `normalizeDir`（NFC）でそろえる。一覧から削除したプロジェクトのフォルダは、ルートが論理削除されているので未登録に数える。
- その場の登録：サーバの `sessionChanged` で、未分類のセッションを紐づけられなかったとき、cwd がワークスペース直下のディレクトリ（またはその下）で、実在し、隠しでなく、まだ登録されていなければ、起動時の `syncProjectsFromWorkspace` と同じ規則でプロジェクトにし（`registry.ts` の `registerWorkspaceChildOf`）、紐づけ直して `project.upsert` と `session.upsert` を配る。同じセッションで何度も試さない。起動の途中は行わない（起動時の全走査は `syncProjectsFromWorkspace` が受け持つ）。当たらなかった cwd だけが、これまでどおりトーストで知らされる。
- フォルダ選択の殻の命令：`pick_folder(default_path)` は `blocking_pick_folder` で macOS のフォルダ選択を開き、選んだパスか、取り消しなら null を返す。頁に与える権限は `allow-pick-folder` の 1 つだけで（`capabilities/remote-pick-folder.json`）、プラグインの JS の権限は与えない。UI の `DesktopBridge.pickFolder` は殻の外では口が無く、Finder の操作を出さない。
- `SessionDto.fromScratch`：cwd がスクラッチのルートの下で、属するプロジェクトがスクラッチでないときに真にする。セッション画面は真のとき「再開しても作業ディレクトリはクイックセッションの置き場のままです」を添える。
- 分割の持ち方：`SessionViewState` に `split: boolean` と `splitTab: string | null` を持つ。左は選択中のタブ、右は `splitTab` で、幅は `SplitPane` の中の状態にして保存しない（0.5 に戻る）。分割の右に置いたタブが閉じたら `splitTab` を null にし、`split` も偽に戻す。
- 分割にタブが 2 つ要ることの判定は、Mediator がストアのタブの並びを読んで行う。右に置けるタブがあれば状態を変え、無ければトースト「横に並べるにはタブが 2 つ必要です」を出す。
- パレットの項目の ID：セッション（`session:<id>`）、移動（`go:home`、`go:projects`）、設定の節（`settings:<節>`。節は `general`、`cloud`、`integrations`、`summary`、`tools`、`info`、保持は `retention` で一般の節へ移る）、コマンド（`cmd:next-waiting`、`cmd:sidebar`、`cmd:shortcuts`、`cmd:new-session`、`cmd:new-project`、`cmd:new-scratch`、`cmd:rebuild-index`）、ホームへ渡す行（`search:<語>`）。新しいセッションは、Mediator がストアを見ないので、presenter が最初に選ぶものを ID の後ろに載せる（`cmd:new-session:project:<id>` か `cmd:new-session:scratch`）。照合は部分列一致で、一致位置が前で連続しているほど高い点を付け、群の中は点の高い順（同点は最後の活動の新しい順）に並べる。群の分け方と上限は「骨格」の節に書いた。入力欄の文字は Root の `useState` が持ち、Mediator には入れない。
- 要約器の設定：`SettingsDto` に `lmStudioUrl`（既定 `http://127.0.0.1:1234`）、`lmStudioModel`（既定 null で、null なら `/v1/models` の最初のモデル）、`summaryFallback`（既定 true）、`summaryHourlyCap`（既定 20）、`allowExternalSummarizer`（既定 false）を持つ。
- 要約の入力：主線の全イベントを読み（サブエージェントは含めない）、`user` は 2,000 字、`assistant` は 600 字、`tool_call` は 1 行に切り、`thinking`、`tool_result`、`system`、`meta` は捨てる。全体が 12,000 字を超えたら先頭 30% と末尾 30% を残し、中盤を「[... N 件を省略 ...]」に置き換える。
- 要約ジョブの契機：run の終了と、セッション画面を開いたときの先頭ページの読み込みの 2 つで `enqueue` する。受け付けるのは要約が土台のままか最後の更新から 5 ターン以上進んだときだけで、実行中のセッションは受け付けない（セッション自身の `set_session_summary` に任せる）。run の終了からの `enqueue` は `ignoreLive` で生存判定だけを飛ばし、残る 2 つの判定は通す。「要約を作り直す」は条件を無視する。ジョブは 1 セッション 1 件で、直列に走る。
- 要約の配信が失敗しても待ち行列は進める。配信の失敗は 1 行だけ記録し、次のジョブを止めない。
- Claude への切り替えの上限：呼び出しの時刻をメモリに持ち、直近 1 時間の件数が上限に達していれば使わない。週の枠の使用率が 80 以上でも使わず、`claude` が PATH に無ければ使わない。サーバを再起動すると件数は 0 に戻る。
- MCP の `update_project` の TODO の書き込みは、全部成功か全部失敗のどちらかにする。途中で失敗したものが残ったままイベントだけ配られないようにするためである。
- `GET /api/bootstrap` は `accounts`（使用率はアカウントごとにここに載る）、`todos`（全プロジェクトの未削除）、`artifacts`（全件）、`summaryPending`（作成中のセッション ID）も返す。メモの全文は含めない。
- UI の CSS は `base.css` に足さず、View ごとのファイル（`workbench.css`、`split.css`、`rows.css`、`palette.css`、`settings.css`）に分けて `main.tsx` から `base.css` の後に読み込む。
- 要約の出所：`session_summaries.source_id` に書いた要約器の id（`lmstudio` か `claude-headless`）、`source_model` にモデルの名前だけを置く。土台の要約とセッション自身の要約はどちらも null にする。`source_id` が無かった頃の行は null のままにして、UI は要約器を「不明」と出す。モデル名から種類を推し量って焼き付けることはしない。
- サーバの終了：`close()` は HTTP と WebSocket を畳んだ後、走っている要約のジョブが終わるまで最大 5 秒待ってから DB を閉じる。要約は DB に書き込むので、待たずに閉じると閉じた DB に触れることになる。5 秒で終わらなければ 1 行記録して待たずに閉じる。
- 未分類のセッション：起動した後に、どのルートの配下にもない cwd のセッションが現れても、トーストは流さない（2026-10-10 に外した。事実は一覧に出るので、ベルの行にもしない。「ベルと知らせの出し分け」の節）。ワークスペース直下のディレクトリはその場でプロジェクトにし（2026-10-01 に改めた）、ワークスペースの外では勝手にプロジェクトを作らない。
- ルートの復帰：消えていたディレクトリが戻ってルートが解決に戻ったら、その時点で未分類だったセッションを紐づけ直し、紐づいたセッションの `session.upsert` と、戻ったぶんおよび中身が変わったぶんの `project.upsert` を配る。戻ったルートが 1 つも無いときは何もしない（起動時の 1 回目はたいていこちらを通る）。
- 外部のターミナルで開くときの shell：`.command` の経路と iTerm2 の経路で同じ 1 行（`cd <dir> && exec "${SHELL:-/bin/zsh}" -l`）を使う。別々に書くと、同じ操作なのに経路で違う shell が立つ。`$SHELL` が無い環境では `/bin/zsh` に落とす。
- トランスクリプトの仮想スクロール：一覧の `VirtualList` は広げず、`Transcript.tsx` に専用の窓を持つ。行の高さは描いた後の `offsetHeight` を `seq` ごとに覚え、まだ描いていない行は文字数からの見積もりで置く。窓の上下には 600px を余分に描く。「追う」の間は、窓をスクロール位置ではなく末尾に留める。DOM に載る行の数は件数によらない（jsdom で高さ 600px の器に入れると、500 行でも 5,000 行でも末尾で 22 行、途中で 33 行）。
- 遡ったときの位置合わせ：「追う」をやめている間は、器の上端に掛かっている行の `seq` と、その行の上端からのずれを目印として持つ。見積もりで置いた行の高さを測り直したときと、「古い行を読み込む」で前に行が入ったときは、目印の行の上端を今分かっている高さで出し直し、ずれを足した位置へ器を戻す。目印を持たずに `scrollTop` だけで合わせると、前に入った行のぶんだけ見ていた場所が飛ぶ。`scrollTop` を書き換えても `scroll` は同じ間に届かないので、動かしたときはその場で窓を測り直す。
- `follow` は永続化しない：`SessionViewState` の保存の形から `follow` を落とし、読み戻すときにも落として既定の真に戻す。上へ一度スクロールしただけで `follow: false` が焼き付き、次からそのセッションが最古の側で開くのを避ける。
- 要約の帯の「詳細」：本文と次の一手に加えて、出所（土台、セッション内、事後）、要約器の種類とモデル名、何ターン時点か、生成の時刻を出す。要約器を通していない要約は種類とモデル名の札を出さない。
- `store.events`：開いていないセッションのトランスクリプトを落とす。古いページを削るのではないので、「もっと読む」で遡ったぶんは、そのセッションを開いている限り残る。落としたぶんは、セッション画面に入るたび先頭から読み直すので取り直される。
- `palette.run` が閉じるのはパレット自身だけにする。別のダイアログが開いている間に走っても、そのダイアログは閉じない。ダイアログを開く行（新しいセッション、スクラッチ、キーの一覧）も、そのダイアログを差し替えない。画面を移す行（プロジェクト、セッション、移動、全文検索、設定）も、その裏では移さない。
- `promote.done` と `promote.failed` は、昇格の最中（`promote` が `submitting`）でなければ何もしない。遅れて届いた結果で状態を書き換えないためである。
- 未解決のプロジェクトのダイアログは、自動で出さないので、「あとで」を選んだ覚え（`unresolvedQueue`、`resolveDeferred`）を持たない。押すたびに開き、閉じれば何も残らない。
- 既知の限界：プロジェクトのメモは、ファイルの mtime が DB の `updated_at` より古いと DB の内容がファイルに書き戻される。外部のエディタで書いた直後にファイルの時刻が巻き戻る状況では、その編集は画面から消える。消える本文は同じディレクトリに `memo.md.bak-<yyyymmddHHMMSS>` として残るので、手で拾い直せる。

以下はフェーズ 4 の実装で決めた前提である。
2026-09-19 に利用者と決めたものと、実装と実物確認で分かって計画から変えたものが混ざっている。

- Worker の D1 は `rows` と `changes` の 2 表で持ち、共有テーブルの形をそのまま写さない。表の名前と行 ID と payload を文字列として預かるので、共有テーブルに列が増えても Worker を直さずに済む。
- 参加トークンは `{url, secret}` の JSON を base64url にした文字列で、Settings からいつでも再表示できる。表示した後 120 秒で自動的に消し、`localStorage` にも残さない。
- 貼るときに折り返しが入っていてもよい。1Password の項目から貼る前提なので、空白と改行を落としてから読む。
- 参加トークンの URL は入口の検査を通す。素の `https:` の origin と、`127.0.0.1` と `localhost` の `http:` だけを許し、ユーザ情報つきとパスつきは拒む。敵対的なトークンを貼られると、その端末の本文と要約とメモが相手のサーバへ上がるためである。
- 端末ローカルの `file_sync` で、上げ下ろしの最後の SHA-256 を持つ。指紋は上げる側も降ろす側も、圧縮と暗号化の前の平文のものである。
- 本文は差分ではなくファイル全体を上げ直す。R2 が部分更新を持たないためである。
- 設定の R2 の鍵にも端末 ID を入れて `config/<端末 ID>/<相対パス>` にする。入れずに実物で 2 台を動かすと、同じ鍵を奪い合って、負けた端末が「SHA-256 が一致しません」で永久に取り込めなくなった（2026-09-19 の実物確認で判明）。
- 引き継ぎの握手は作らない。ロックの表示と「この PC で再開」までに絞った（2026-09-19 の判断）。段 1 で型と共有テーブルの一覧からも外した。`EndReason` に `taken_over` は足さない。
- ロックは他端末の生きた run で引き、heartbeat の新旧では解かない。2 分を超えたら `stale` を立て、そのときだけ「この PC で再開」を押せるようにする。
- 同期は自分の端末同士のためのもので、他人と 1 つの箱を共有しない。別の人は自分の Cloudflare アカウントで `setup cloud` を走らせる。
- 段 1（D4）で、端末の無料枠の見張りを消した。
  端末側の見積もりと、端末の数で割る仕組みは、もう無い。
  端末は数えず、Cloudflare の上限による失敗を受けたら次の UTC の 0 時まで退く。
- Worker は量を数えない（段 1 の PR 6 で台帳を外した）。
  数えるために D1 へ書けば、その書き込みも枠を使い、Worker は自分のプランも知らないからである（全体計画の D4）。
  上限に当たったことは、D1 の失敗を 429 で返して端末へ伝える。
  台帳の行は、配備の後の最初の要求で後始末が消す。
- `setup cloud --rotate-secret` は R2 の既存ファイルを復号できなくするので、確認を必須にする。確認は `y/N` ではなく合言葉を打たせる形にする。秘密がまだ無いときだけ確認を省く。
- `cloud teardown` は、R2 にしか無い本文を先に手元へ降ろす。1 件でも降ろせなければ、確認を聞く前に中止して wrangler を 1 度も呼ばない。wrangler の呼び出しが 1 つでも失敗したら、手元の `cloud.json` を消さずに 0 以外で終わる。
- Worker のテストは `@cloudflare/vitest-pool-workers` を使わず、miniflare 4 の使い捨てハーネスで行う。pool の最新版が peer に vitest 4 を要求し、vitest 5 を許す版が 1 つも無いためである。実物の Cloudflare に触らない要件は、ローカルの workerd で満たしている。
- R2 の覚え書き（`customMetadata`）の上限（2048 バイト）を超えたら、断らずに `path` を落として通す。正本は D1 の `files` なので、冗長な写しのために深い日本語の道にある本文を永久に同期できなくする方が筋が悪い。
- ファイルのパスは見出し（`x-hangar-path`）に符号化して載せる。URL に載せると、利用者のホームの構造が Cloudflare の要求ログに残る。素のまま見出しに載せる道は、非 ASCII のときに Node の fetch が送る前に落ちるので使えない。
- 1 回の push は 40 行まで、1 回の pull は 500 行まで、push の最小間隔は 10 秒。ローカルの `changes` は push 済みで 7 日、Worker の `changes` は 14 日と全端末の読み終わりで刈る。
- 降ろせない本文が 1 件あっても後ろを止めない。3 回続けて失敗したら飛ばし、中身が入れ替わったとき、起こし直したとき、30 分ごとに試し直す。
- 諦めた本文とまだ上げていない本文の件数は `SyncDetailDto` に載せ、HTTP の応答と websocket の `sync.status` の両方で配る。
  どちらの値も `SyncEngine` は持っていない（諦めた本文を覚えているのは `RemotePuller`、取り残しを数えられるのは `TranscriptUploader` である）ので、配るところで添える。
  受け取った側は届いた値をそのまま出す。直前の値を覚えて残すと、減ったはずの件数が画面に貼り付く。
- `~/.agent-hangar/remote` は 0700、降ろしたファイルは 0600 にする。中身は他端末の会話の本文である。
- 設定の同期の対象は削除を運ばない。片方で消したファイルは、もう片方からは消えない。
- 設定の取り込みは、途中のディレクトリがシンボリックリンクでも辿らない。段ごとに `lstat` して、リンクに当たったらその項目を諦める。realpath で後から判定する形にすると、`~/.claude` の外の既存ファイルを上書きする筋が残る。
- 取り込んだ設定ファイルの更新時刻は、相手の端末で編集した時刻に合わせる。`utimes` がナノ秒の端を落とすので往復のたびに 1 ミリ秒未満のずれが出るが、判定はミリ秒で行うので影響しない。
- UiAction に `session.resumeHere`、`sync.config.preview`、`sync.config.apply`、`sync.joinToken.show` を、`ServerEvent` に `sync.status`、`sync.applied`、`devices.update` を足した。
- 孤児の掃除は `GET /files` を契機にして、cron を持たない。
  端末が pull のたびに叩く経路なので、6 時間の間隔を当てにできる相手がここしかない。
  当番を取りにいくのも 6 時間に 1 回でよいので、isolate は自分が最後に取りにいった時刻を覚え、その間は D1 に触らずに帰る。
- 既知の限界：使わなくなった端末の `transcripts/<端末 ID>/` と `config/<端末 ID>/` を畳む口が無い。
  掃除が拾うのは索引に無い本体と、本体の無い索引の行だけで、索引に載っている他端末のファイルは消さない。
- `~/.agent-hangar/backups/` のうち 20 世代で刈るのは 3 種類（`claude-config/`、`transcripts/`、`memos/`）で、どれも新しい方から 20 世代を残す。
  `claude-config/` は取り込みのたび（作り直した実装では、`hangar config apply` と `hangar config restore` が世代を足したとき）に、`transcripts/` と `memos/` は控えを取った後とサーバを起こしたときに刈る。
  いま取った控えが最も新しいので、「控えを取れなければ書かない」という決まりには触らない。
  この置き場の外に残る控え（プロジェクトのメモの隣の `memo.md.bak-<日時>` と、設定の同期の `*.conflict-*`）は消さない。
- `~/.agent-hangar/backups/db/` は DB の控えで、新しい方から 5 世代を残す。
  DB を開く側（サーバと、DB を開く CLI）は、すでに 1 本以上のマイグレーションを当てた DB に当てていないものがあるとき、当てる前に `VACUUM INTO` で `hangar-v<当てた最後の版>-<UTC の時刻>.db` を作る（`packages/server/src/db/backup.ts`）。
  新しい DB と `:memory:` では作らない。
  起点より古い版の DB は、当てるものが無く断るだけなので、控えも作らない。
  写しは控えの形でない一時の名前に書き、`fsync` してから改名する。
  失敗や中断で、控えに見える壊れたファイルが残らない。
  `backups/db` がシンボリックリンクなら、ほかの控えの置き場と同じく取らずに止める。
  控えが取れなければマイグレーションを当てず、理由を出して起動を止める。
  「控えが取れなければ書かない」の原則に合わせた。
  刈るのは控えの形の名前のものだけで、置き場に利用者が置いたファイルには触れない。
  `hangar setup cloud` と `hangar join` は、Cloudflare に資源を作る前と参加の要求を出す前に DB を開き、床を刻むまで閉じない（`openTranscriptsFloor`）。
  控えが取れなければ、外に何も作らず、`cloud.json` も書かずに止まる。
- 既知の限界：孤児の掃除は、偽のクラウドとローカルの workerd（miniflare）の試験だけで確かめた（2026-09-20）。
  上限で退く処理も、偽のクラウドと手元の Worker の前に置いた中継（段 1 の PR 5 の試し）でだけ確かめた。
  実物の Cloudflare では動かしていない。
- 既知の限界：フェーズ 4 の実物確認は、1 台の Mac の上で `HANGAR_HOME` と `HANGAR_CLAUDE_DIR` を分けて 2 端末を模して行った（2026-09-19 の決定）。実際に別のマシンから参加することは確かめていない。
- 配布版の同梱形態：サーバと CLI を esbuild で単一ファイル（`server.mjs`、`cli.mjs`）にまとめ、UI、ネイティブモジュール、`bin/hangar`、`cloud/`、`manifest.json` とともに `.app` の `Contents/Resources/server/` へ置く。
  `cloud/` には、Worker を 1 本に束ねた `worker.mjs` と、その束縛の定義 `metadata.json`（互換の日付と旗、D1 と R2 の束縛の名前）だけを置き、源は置かない。
  `cloud/` は段 5 で Cloudflare の REST から Worker を上げるための下地で、いまは誰も読まない。
  UI の sourcemap は入れないので、実測で 6.5MB である。
  Node 本体は同梱しない。
- Node の版の一致：ネイティブモジュール（`better-sqlite3`、`node-pty`）は Node の ABI に縛られるので、同梱時の Node のメジャー版とアーキテクチャを `manifest.json` に記録し、候補を順に起動して一致する版だけを採る。一致する Node が無ければ、探した場所を挙げて起動を諦める。
- `nodePath` の重さ：Settings の `nodePath` は、次の起動で `.app` がそのまま起こす実行ファイルの場所なので、設定への書き込みが次回起動時のコード実行になる。
  いま穴が開いているわけではないが、UI か API の側に穴が 1 つできたときの被害の上限がここまで上がることを、前提として書き留めておく。
- 配布ターゲットは Apple silicon の macOS 13 以降と、x64 の Windows 11 である。同梱する prebuild は target（`<platform>-<arch>`）のものだけにする。全アーキを入れると `node-pty` の win32 だけで 58MB になる。Intel の Mac と ARM64 の Windows は作らない。
  束の作り方は `apps/desktop/scripts/bundle-server.ts` の `bundleServer` が target を引数に受け取り（省略すると、この機械の target。配布の対象でなければ止まる）、別の target の束も、どの機械でも作れる。`manifest.json` の `arch` は束の相手のものを書く。
  win32-x64 の束は、`bin/hangar` の代わりに `bin/hangar.cmd` と、束の根の `launch-cli.mjs` を置き、`node-pty` のデバッグの記号（`.pdb`、22MB）を入れない。
  cmd は JSON を読めないので、`hangar.cmd` は HANGAR_NODE、PATH、公式の入れ先の順に Node を 1 つ見つけて `launch-cli.mjs` を動かすだけにして、版とアーキの確認と、合う Node への渡し直しは `launch-cli.mjs` が行う。
  渡し直しの候補は、HANGAR_NODE、`settings.json` の `nodePath`、公式の入れ先、nvm-windows（新しい版から）、PATH の各項目の `node.exe` の順で、HANGAR_NODE のあとは殻の `windows_node_paths` と同じ並びである。
  PATH は、実在する `node.exe` を PATH の順にすべて候補にする。fnm が別の版を PATH の先頭に置いていても、後ろの winget の Packages や Links、volta などにある合う版に届く（実機の A19）。
  どれも合わなければ、いま動いている Node の版と、調べた場所を探した順に番号付きで挙げ、それぞれがファイルが無い、起動できない、時間内に答えない、版が違う、アーキテクチャが違う、のどれだったかを書く（`launch-cli.ts` の `describeNotFound`）。
  `hangar.cmd` は、node を起こす最後の行で `endlocal & goto #_end_of_batch_# 2>nul || ver >nul & "<node>" …` の形を使い、node が動き出す前にバッチを終える（npm の cmd-shim と同じ手、npm/cli#969）。
  cmd は行を丸ごと読んで展開してから動かすので、無い label への goto でバッチが終わっても、行の残りは動く。
  バッチが終わっているので、Ctrl+C で node が止まったあとに cmd が「バッチ ジョブを終了しますか (Y/N)?」と問わず、node の終了コードがそのまま cmd の終了コードになる。
  npm は `||` の後に `title` を置くが、端末のタブの名前を変えてしまうので、何もしない `ver >nul` にした。
  `apps/desktop/test/hangar-cmd.test.ts` が、Windows の CI で、隠したコンソールに Ctrl+C を送って、古い作りでは問いで止まり、いまの作りでは止まらないことを確かめる。
  インストーラは、`server\bin` を利用者単位の PATH（`HKCU\Environment` の `Path`）の末尾に足し、アンインストールの前に外す（`hooks.nsh` の `NSIS_HOOK_POSTINSTALL` と `NSIS_HOOK_PREUNINSTALL`）。
  書き換えは PowerShell が値の種類（`REG_EXPAND_SZ`）と展開前の項目をそのまま保って行い、NSIS の文字列（1024 字で切れる）を通さない。もう入っていれば足さず（更新でも増えない）、外すときは書き方の違う重複もまとめて外す。
  そのあと `WM_SETTINGCHANGE` を流すので、新しく開いたターミナルから `hangar` で呼べる。開いていたターミナルには届かない。
  殻（`node.rs`）の Node の探索は Windows で、設定の `nodePath`、公式の入れ先（`%ProgramFiles%\nodejs`、`%LOCALAPPDATA%\Programs\nodejs`）、nvm-windows、PATH の順に探す。Node 本体は Windows でも同梱しない。
- Windows（x64）の配布物は NSIS のインストーラ 1 本で、管理者権限を要らないユーザー単位のインストール（`%LOCALAPPDATA%\Hangar`）にする。`tauri.windows.conf.json` が Windows のビルドのときだけ `tauri.conf.json` に重なる（重ねるのは配布物と窓の装飾だけ）。署名はしない（2026-10-10 の決定）。作る手順は composite action（`.github/actions/windows-installer`）の 1 か所にあり、`tauri build --bundles nsis --target x86_64-pc-windows-msvc` を回し、静かに入れて同梱の `hangar.cmd` を動かし、入れた殻を起こして同梱のサーバが `127.0.0.1:4177` の `/health` に応えるまで待ってから止め、静かに消すところまでを行う。殻が resource_dir から作ったパスで Node を起こす経路は、`hangar.cmd` では通らないので、殻そのものを起こして確かめる。殻は Node を公式の入れ先から PATH より先に探すので、このときは一時のホーム（`HANGAR_HOME`）の `settings.json` の `nodePath` で setup-node の Node を指し、殻が使った Node の版を desktop.log から読んで 22.20 以上であることを確かめる（22.20 から verbatim の主スクリプトで落ちるので、それより古い Node では回帰を捕まえられない）。
  CI の windows ジョブはこれを呼んで、インストーラを実行の artifact に 7 日だけ残す。
  タグの `release.yml` では、windows ジョブが同じ手順で作って `Hangar-<タグ>-windows-x64-setup.exe` と `.sha256` を artifact に置き、`windows-upload` ジョブが macos ジョブの後でそれを macos ジョブの作った Release に `gh release upload` で添える。Release を作るのは macos ジョブだけで、書き込みの権限もこの 2 つのジョブだけが持つ。
  署名鍵があれば、インストーラの署名（`.sig`）も作り、`updater-manifest` ジョブが更新の目録に載せる（次の「アプリの自動更新」）。
- アプリの自動更新（段 5-4、2026-10-10 の決定）：更新は「知らせて、押して入れる」で、勝手には入れない。Tauri 2 の updater（`tauri-plugin-updater`）を macOS と Windows（NSIS）の両方で使う。
  目録は GitHub の Release の最新の `latest.json`（`tauri.conf.json` の `plugins.updater.endpoints`）で、更新物は同じ所の minisign の公開鍵（`plugins.updater.pubkey`）で確かめる。
  試しの版（rc）の build だけは、`tauri.prerelease.conf.json` を重ねて、目録を固定のタグ `updater-prerelease` の Release（prerelease）の `latest.json` から引く（次の「版と試しの版」）。macOS の更新物は `Hangar-<タグ>-macos-arm64.app.tar.gz`、Windows の更新物はインストーラそのもの（`Hangar-<タグ>-windows-x64-setup.exe`、`installMode` は passive）である。
  頁は殻の 4 つの命令だけを呼ぶ（`capabilities/remote-update.json`）。`update_status` は動いている版と取得の進み、`update_check` は目録を引いて新しい版を返し、見つけた版を殻に持つ。`update_download` はそれを取得して署名を確かめて殻に持ち、`update_install` は入れて再起動する。プラグインの JS の権限は与えないので、頁から目録の URL や公開鍵は変えられない。
  失敗は殻が network、signature、permission、other の 4 つに分けて返し（`src/updater.rs` の `failure_kind`）、英語の 1 行は `desktop.log` に残す。
  再起動しても、tmux（Windows は psmux）の中のセッションは止まらない。macOS は `.app` を入れ替えてから終了の手続きを通って起き直し（子のサーバも止まる）、Windows は updater がインストーラを起こしてそのまま抜けるので、その直前（`on_before_exit`）に子のサーバを止める。
  頁の側は、状態の移り方が `store/update.ts` の `reduceUpdate`（まだ確認していない、確認中、最新、新しい版あり、取得中、準備完了、インストール中、失敗）で、Runtime が `runtime/updater.ts` で殻を呼んで Store の `update` に置く。
  確かめるのは起動したときに 1 度と、その後 6 時間おき（`UPDATE_CHECK_INTERVAL_MS`）である。取得からインストールまでの途中は確かめない。
  右下の札（`presenters/update.ts` の `presentUpdateCard`、試作は案 A2）は、新しい版あり（「ダウンロードしてインストール」「あとで」）、取得中（進みの棒）、準備完了（「実行中のセッション N 件は止まりません。再起動のあと、続きから表示します。」に「再起動して更新」「あとで」）、失敗（いまの版は変わらないことと理由に「もう一度試す」「閉じる」）を同じ 1 枚の中で移す。
  札を閉じた版は `localStorage` の `update.dismissed` に覚え、同じ版の札は 2 度出さない。次の版が出たら出す。閉じた版を設定から取得し直したら、その版の札をまた出す。確認の失敗は札にせず、設定の節にだけ出す。
  設定の更新の節（試作の「共通」）は、版と最終確認の時刻と「更新を確認」、見つけた版の行（閉じた版も出す）、「更新を通知する」のスイッチ（`localStorage` の `update.notify`、既定は入）を置き、見出しに最新、確認中、通知オフ、新しいバージョンあり、ダウンロード中、再起動待ち、失敗の札を出す。スイッチを切ると自動の確認も止まり、新しい版の札は手動で確認したときだけ出す。
  署名鍵（minisign）の秘密鍵は GitHub の secret の `TAURI_SIGNING_PRIVATE_KEY` と `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（Tauri が読む環境変数と同じ名前）にだけ置き、1Password の「Hangar updater signing key (minisign)」に控えてある。リポジトリには公開鍵だけを置く。
  更新物づくり（`createUpdaterArtifacts`）は `tauri.conf.json` に書かず、`release.yml` が鍵のあるときだけ `--config src-tauri/tauri.updater.conf.json` を重ねて入れる。手元と ci の build は鍵を持たないので、更新物を作らずに通る。
  `release.yml` は、macos ジョブが `.app.tar.gz` と `.sig` を、windows ジョブがインストーラの `.sig` を artifact に置き、`updater-manifest` ジョブが `windows-upload` の後で目録を作って（`apps/desktop/scripts/updater-manifest.ts`）、更新物と署名と目録を Release に添える。目録は最後に添える（先に添えると、更新物がまだ無い版をアプリが知ってしまう）。secret が無ければ、更新物と目録だけを飛ばし、失敗にしない。
- 版と試しの版（2026-10-10）：版はリポジトリのファイルで上げてからタグを打ち、タグから版を決めて build に渡すことはしない。手順は `docs/release.md` にある。
  版の在りかは 5 つ（`tauri.conf.json`、`apps/desktop/package.json`、`Cargo.toml`、`Cargo.lock`、`package-lock.json`）で、`apps/desktop/scripts/release-plan.ts` の `VERSION_FILES` が正である。`npm run set-version -w apps/desktop -- <版>` がまとめて書き換え、試験が 5 つのそろいを見る。
  サーバ（`/health`、WebSocket の `ready`、MCP）が名乗る版は、6 つ目の在りかを作らず、`apps/desktop/package.json` の版を読む（`packages/server/src/boot/options.ts`）。配布物では esbuild が束ねるときに取り込むので、build のときの版が入る。set-version で上げればサーバの版も上がり、`plan` の照合もサーバの版を見たことになる。以前はサーバが `0.3.0` を決め打ちしていて、アプリの `0.2.0-rc.1` と食い違っていた（2026-10-11）。
  `release.yml` の最初の `plan` ジョブがタグと 5 つを照らし、1 つでも違えば何も作らずに止まる。食い違ったまま配ると、目録の版とアプリの名乗る版と更新物の署名に入る版がずれるからである。タグにビルドメタデータ（`+`）は付けない（semver の比べ方が `+` を見ず、更新として見つからない）。
  タグに `-` が入っていれば試しの版で、Release を prerelease にして Release の最新にしない。安定版の利用者が引く Release の最新の `latest.json` に、試しの版を入れないためである。
  試しの版の目録の取り先は、固定のタグ `updater-prerelease` の Release（prerelease）に 1 つだけ置く `latest.json` にした。`updater-manifest` ジョブが、試しの版でも正式な版でも、その版が今の目録より新しいか同じときだけ置き換える。試しの版の利用者は次の rc も正式な版も受け取り、古い版の再実行で巻き戻らない。
  取り先を版ごとの Release にせず固定のタグに置くのは、rc.1 に焼き込んだ取り先から rc.2 を見つけるためである。安定版の道（Release の最新）を固定のタグに移さないのは、すでに配った版の取り先を変えないためである。
  プレリリースの付いた版は Tauri と NSIS がそのまま受ける。NSIS の `VIProductVersion` は数字の 4 つ組なのでプレリリースの部分が落ちて `0.2.0.0` になるが、入れ替えの比べ方（`nsis_tauri_utils::SemverCompare`）と updater の比べ方は semver のままである。macOS の `Info.plist` の版は `0.2.0-rc.1` のまま入る（2026-10-10 に手元の build で確かめた）。
- Windows（x64）は、サーバと UI をソースから動かせる（`docs/superpowers/specs/2026-10-05-windows-port-m1-design.md`）。tmux の役は psmux が担う。通知はまだ無い。ターミナルで打った `claude` の包み（`hangar shell install`）は Windows では作らず、セッションは Hangar の画面から始める（利用者の決定）。
- macOS にしか無いコマンドは、OS で分けて呼ぶ。URL とファイルを既定のアプリで開くのは `platform/browser.ts`（macOS は `open`、Windows はシェルを通さない `rundll32.exe url.dll,FileProtocolHandler`、Linux は `xdg-open`）。
  CLI の `hangar open` は、macOS の外では鍵付きの URL へ移るページ（`<HANGAR_HOME>/open.html`、0600）を書き、そのファイルを開かせる。既定のブラウザは開く対象を自分の argv で受け取るので、URL を直に渡すと鍵が argv に載るからである。
  CLI の道具の探索は `which` を起こさず、サーバと同じ `platform/exec.ts` で PATH と既知の置き場を見る（Windows では PATHEXT を補い、tmux の役は psmux を先に見る）。
  `hangar start` は Windows では Ctrl+C と窓の閉じを子のサーバへ渡さない。同じコンソールの子にも直に届き、Windows の `child.kill` は後始末を待たずに終わらせるからである。
  Claude Code の組織の設定は、Windows では `C:\Program Files\ClaudeCode` から読む。
- 署名の身元（段 5 の 5-1、2026-10-10 の実測と決定）：macOS のローカルネットワークの許可は署名の識別子で引かれる（DR は空でよい）。
  署名しない Tauri の build は識別子が `hangar_desktop-<ハッシュ>` で build ごとに変わり、入れ替えるたびに許可が外れていた。
  署名で識別子を `tauri.conf.json` の identifier（`dev.agent-hangar.hangar`）に固定すると保たれる。
  ファイルなどほかの許可は DR で引かれるので、DR は葉の証明書の指紋（`certificate leaf = H"<SHA-1>"`）で固定する。
  `apps/desktop/scripts/sign-macos.ts` が、内側の Mach-O から外側へ署名し（ハードンドランタイムなし、`--deep` に頼らない）、識別子、DR、`codesign --verify --deep --strict` を確かめて、違えば落とす。
  証明書が無い開発者の手元では `--adhoc` で識別子だけ固定できる（DR は build ごとに変わるので、ローカルネットワーク以外の許可は保たれない見込み）。
  証明書は 10 年以上の自己署名で、`make-signing-cert.sh` で利用者が一度だけ作る。秘密鍵は 1Password と CI の secret の 2 か所だけに置き、リポジトリには公開の証明書と指紋（`apps/desktop/signing/certificate-sha1.txt`）だけを置く。
  本番の証明書は作って CI の secret に入れてあり、指紋と公開の証明書は `apps/desktop/signing/` に置いてある。
  CI の署名（段 5 の 5-2）：`release.yml` の macOS のジョブが、tauri build のあとに `apps/desktop/scripts/ci-sign-macos.sh` で署名する。
  台本は secret（`HANGAR_SIGN_P12_BASE64` と `HANGAR_SIGN_P12_PASSWORD`）の p12 を使い捨てのキーチェーンに入れ、`sign-macos.ts` で署名し、終わりにキーチェーンを消す。
  p12 の証明書と、署名に入った証明書の指紋を、署名の前と後で `certificate-sha1.txt` と比べ、違えば止まる。
  secret が 2 つとも無いとき（fork や、まだ入れていないとき）は、警告を出して未署名のまま続ける。
  macOS 26 のランナーでは自作の証明書が信頼されていないと codesign が身元を見つけないので、使い捨てのランナーの中でだけ `prepare-signing-keychain.sh` で信頼と検索リストを整え、終わりに外す。
  この台本の回帰は、ci の desktop ジョブの試験（`apps/desktop/test/ci-sign-macos.test.ts`）が、その場で作った試しの証明書で拾う。
  自動更新の更新物（`Hangar.app.tar.gz` と `.sig`）は tauri build の中で署名の前の .app から詰められるので、署名の段の後で `repack-updater-macos.sh` が署名済みの .app から詰め直して `.sig` も付け直し、展開した .app の識別子と DR が保たれていることを確かめる。dmg と zip も署名済みの .app から作る。
- Gatekeeper：公証はせず、dmg（主）と zip（予備）に SHA-256 の checksum を添えて配る（2026-09-20 の決定、dmg は段 5 の決定）。自作の証明書は Gatekeeper の信頼の鎖に入らないので、署名があっても初回の警告は出る。以下は署名しない build の記述で、署名した build でも警告の出方は変わらない前提で読む。
  初回の警告は、2026-10-11 に、もう 1 台の Mac へ `v0.2.0-rc.4` の dmg をブラウザで落として入れた実機で見た。
  「"Hangar" は開いていません」と出て、ボタンは「ゴミ箱に入れる」と「完了」だけである。
  Finder の右クリックの「開く」でも同じ画面で、開く道は出なかった（macOS の版は控えていない。版によって違う可能性があるので、主の手順からは外し、効かなかったことだけを README に書いた）。
  システム設定の「プライバシーとセキュリティ」に出る「このまま開く」を押すと、管理者の名前とパスワードを求められ、入れると開けた。
  README はこの順で書いてある。
  Tauri が行うのはバイナリを ad-hoc（linker-signed）にするところまでで、バンドルの封はしないので、`.app` に `_CodeSignature` は無く、`spctl -a -vv` は `code has no resources but signature indicates they must be present` で弾く。
  署名しないという決めのもとでは、これが既定の姿である。
  利用者の手順は、`.app` を `/Applications` へ移してから、初回の警告を越えることである（越え方は上の実機の流れ。`xattr` で検疫属性を外す道は最後の手段）。
  移動を先に置くのは順序の実測による。
  検疫属性が付いたまま開くと、App Translocation の案内より先に Gatekeeper のダイアログが出る。
  翻訳された場所からプロセスは起動するが、ウィンドウは出ずログにも 1 行も書かれないので、利用者が最初に見るのはアプリの案内ではなく macOS の拒否である。
  アプリ自身も同梱サーバを起こす前に検疫属性を外すが、読み取り専用の写しでは書き込めないので効かない。
- 二重起動：殻とサーバを分けて扱う。
  殻は、Windows と Linux でだけ single-instance のプラグイン（`tauri-plugin-single-instance`、deep-link の機能つき）を入れる。
  動いている最中にスタートメニューからもう一度起こすと、2 つ目の殻が 4177 のサーバを採って窓が 2 つになったためである（2026-10-11、Windows の実機の確かめで見つけた）。
  2 つ目の殻は窓を作る前に降り、渡された引数を最初の殻へ渡す。
  `hangar://` は deep-link のプラグインが最初の殻の `on_open_url` へ回し、最初の殻は窓を前に出して、渡された引数の数と種類をログに 1 行残す（`src-tauri/src/instance.rs`、URL の中身は書かない）。
  トーストの印（`-ToastActivated`）は中身を持たず、押されたセッションは COM の口が最初の殻へ直に届ける。
  macOS には入れない。OS が `.app` を 1 つにまとめ、ディープリンクも動いている側へ届くので、今の振る舞いを変えないためである。
  サーバは、起動時に 4177 で互換の版の同じ hangar が既に応答していれば、そのサーバを採用して子プロセスを起こさない。ブラウザや `hangar start` で先に起きているサーバと食い合わないためである。
- 最初の窓の置き場所：Windows と Linux では、起動の最初に、窓の外形をいるモニタの作業域（タスクバーを除いた範囲）に収める（`src-tauri/src/placement.rs` の `fit`）。
  1920×1080 の Windows で、外形 1416×939 の窓が y=141 に出て、下の端と右下の知らせの札がタスクバーに隠れたためである（2026-10-11、Windows の実機の確かめで見つけた）。
  収まっていれば動かさない。
  長すぎる辺は作業域の長さまで縮め、はみ出す軸だけを作業域の中ほどへ寄せる。
  窓の位置を覚えて戻す仕組みは無いので、毎回の起動でこの規則だけが効く。
  macOS では呼ばず、窓の位置は OS に任せたままにする。
- wrangler は同梱しない。
  205MB あり、`.app` の大きさが 20 倍近くになる。
  配布版の `hangar setup cloud` は、Worker の源が無いことを告げ、clone した場所から実行するよう案内して止まる。
  クラウド同期を使う端末は、リポジトリを clone して設定する。
- 既知の限界：フェーズ 5 の実物確認（2026-09-20）で見ていないものが二つある。
  App Translocation の案内の画面そのものは、Gatekeeper のダイアログを人が承認しないと先へ進まないので、通しでは見ていない（案内の枝は単体試験で押さえてある）。
  システム設定の外観をダークにしたときの見え方は、利用者の環境を変えるので確かめず、配信される UI に `prefers-color-scheme` の規則が 1 件も無いことの確認で代えた。
- 覚え書き：`HANGAR_CLAUDE_DIR` は hangar が読む設定の置き場で、起こされた `claude` が見るのは `CLAUDE_CONFIG_DIR` である。普段はどちらも `~/.claude` なので食い違わないが、試しの環境を分けるときは両方を向ける。
- 右欄のライブの第 1 回で決めた前提：意図は端末ローカルに置いて同期しない。
  赤は結果が `isError` のものだけで、本文の中身で決まる結末は赤にしない。
  Bash の description を日本語で書かせるのは、指示の注入で頼む。

未決事項は次のとおりである。

- 権限確認ダイアログの待ちがレジストリで `waiting` になるか `busy` のままかは、auto モード以外で確かめる。
- 使わなくなった端末の始末。`transcripts/<端末 ID>/` と `config/<端末 ID>/` と `devices` の行を畳む操作が無い。
- `findSession` と `ensureSession` が `deleted_at` を見ていないこと。削除の見え方そのものを変える話なので、手元と写しで規則がずれないように一度にまとめて直す。
