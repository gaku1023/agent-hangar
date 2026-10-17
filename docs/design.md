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

- **読み取り専用**：Claude Code の設定とデータを、hangar は原則として読むだけで書き換えない。`~/.claude` の中へ書く例外は次の 5 つだけである。
  - statusline スクリプトへの追記。承諾を求め、追記の前に同じディレクトリへバックアップを取る。
  - 利用者が明示的に押した「この PC で再開」で、他端末のセッション本文を `~/.claude/projects/` に写すこと。手元の本文を上書きするときは `~/.agent-hangar/backups/transcripts/` へ控えを取り、控えが取れなければ写さない。
  - クラウド同期で、他端末から引いた Claude Code のユーザー設定を書き戻すこと。Settings で明示的に有効にし、取り込む内容を確認したときだけ書く。上書きの前に `~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ 1 バイトも書かない。作り直した実装では、書くのは殻の承諾の窓を経た殻の命令と CLI の `hangar config apply` だけで、サーバは書かない（「設定の同期の作り直し」の節の「適用と世代へ戻す」と、「承諾の窓」の節）。
  - 利用者が確認のダイアログで押した「書き込む」で、`~/.claude/settings.json` の `cleanupPeriodDays` の 1 か所だけを書き換えること。書く前に差分を見せ、`~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ書かない。ほかのキーと書式には触れない（「会話の保持期間」の節）。
  - 利用者がセッションを削除したときに、その本文（`~/.claude/projects/` の下の主線の jsonl と、隣の `<uuid>/` のフォルダ）を OS のゴミ箱へ移すこと。ほかの PC で削除された印を受け取ったときも同じことをする。ゴミ箱へ移せなければ何も変えず、`rm` には倒さない（「セッションの削除」の節）。
- 初期プロンプトの欄の候補のために、`~/.claude` から次を読む。どれも読むだけで、書かない（「初期プロンプトの欄」の節）。
  - `skills/*/SKILL.md` と `commands/**/*.md`。選んだプロジェクトの `.claude/skills` と `.claude/commands` も同じに読む。
  - `plugins/installed_plugins.json` と、`settings.json` の `enabledPlugins`。有効なプラグインのスキルとコマンドを見つけるためである。
  - プラグインのスキルとコマンドは、`installed_plugins.json` に記録された `installPath` から読む。ふつうは `~/.claude/plugins/cache` の下だが、記録された場所がどこでも、そこを読む。読むだけで、書かない。
  - `history.jsonl`。セッションの最初の一言になったコマンドの回数を数える。
- `~/.claude` の外では、`hangar shell install` が `~/.zshrc` の末尾に 1 行を足す。statusline と同じく書くのは CLI だけで、端末では承諾を求め、画面のボタンからは殻の承諾の窓を経る。足す前に同じディレクトリへバックアップを取る。UTF-8 でない `~/.zshrc` は、ステータスラインのスクリプトと同じく書かずに断る。サーバは `GET /api/shell-hook` で有無を読むだけである（「外のターミナルのセッション」の節）。
  - 加えて、`~/.claude/` の外にある `~/.claude.json` の `mcpServers.hangar` を `hangar mcp install` が書き換える。Claude Code の設定である点は同じなので例外に数える。`claude mcp add` に任せないのは、`--header` の値が argv に載り、64 桁のトークンが同じ機械の誰からでも `ps` で読めるためである。解除（`hangar mcp uninstall`）も `claude mcp remove` に任せず、登録と同じ守りで自分で書く。承諾の窓で見せた差分と、書く中身をそろえるためである（0.4.0 から）。
- **書く承諾は殻の窓で取る**：画面から利用者のファイル（`~/.claude.json`、`~/.zshrc`、ステータスラインのスクリプト、`~/.claude`）を書くときは、殻が自分の承諾の窓（サーバを通らない、殻に同梱した頁）で書く先と差分を見せ、承諾されたときだけ CLI が書く。サーバと HTTP の API は書かない。ブラウザで開いた画面からは書かず、コマンドを案内する（「承諾の窓」の節）。
- **ファイルを消さない**：hangar は利用者のファイルを削除しない。プロジェクトの削除は紐づけの解除であり、ディレクトリには触れない。例外はスクラッチを昇格するときの移動と、セッションの削除で本文を OS のゴミ箱へ移すことである。ゴミ箱へ移すのは消すことではなく、利用者がゴミ箱から戻せば hangar にも戻る（「セッションの削除」の節）。hangar が他の PC から降ろした写し（`~/.agent-hangar/remote/`）は hangar の持ち物なので、削除のときに普通に消す。
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
- `packages/cli`：`hangar` コマンド。`setup`、`setup cloud`、`join`、`start`、`status`、`open`、`url`、`mcp install`、`mcp uninstall`、`statusline install`、`statusline uninstall`、`shell install`、`shell uninstall`、`shell status`、`config apply`、`config restore`、`cloud status`、`cloud teardown` を提供する。連携の書き込み（mcp、shell、statusline）と config は `--dry-run --json`（config は `--plan --json` も同じ）で書かずに見立てを返し、`--yes --json --expect <指紋>` で見立てどおりに書く（「承諾の窓」の節）。

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
サーバが起こす外のアプリ（Windows Terminal、既定のターミナル、エディタ、ブラウザ）は、そのまま起こすとジョブに入り、Hangar を閉じると窓ごと止まる。
Node は子に `CREATE_BREAKAWAY_FROM_JOB` を付けられないので、殻の実行ファイルを起こし役にする（`src-tauri/src/breakaway.rs`、`packages/server/src/external/breakaway.ts`）。
殻はサーバに自分の場所を `HANGAR_LAUNCHER` で渡し、サーバは外のアプリを `Hangar.exe --hangar-breakaway <起こすもの> <引数の 1 行>` で起こさせる。
殻はこの印を見たら Tauri を立ち上げず、`CREATE_BREAKAWAY_FROM_JOB` を付けて子を起こし、子の終わりを待ってその終了コードで降りる。標準入出力は受け継ぐので、サーバは直に起こしたときと同じ結果を受け取る。
引数の 1 行はサーバが Windows の規則で引用し終えたもので、殻はそのまま子のコマンド行の後ろに付ける（cmd.exe へ組んだ 1 行を崩さないため）。
外側のジョブが抜けるのを許していなければ、印を付けずに起こし直す（psmux と同じ）。
端末から起こしたサーバ（`npm run dev` など）はジョブに入っていないので、`HANGAR_LAUNCHER` は無く、直に起こす。
Node は PATH に頼らず、Settings の `nodePath` のあと、`node.rs` の `UNIX_NODE_PLACES` の順で探す（macOS）。
`nodePath` は `node` の実行ファイルのフルパスだけを受け、名前や相対のパスは無いものとして扱う（殻の作業ディレクトリや PATH で指す先が変わるため）。
アプリ（殻）は環境変数 `HANGAR_NODE` を見ない。
Finder やスタートメニューから開いたアプリには端末で決めた環境変数が届かないので、見ると、開き方によって使う Node が変わるためである。
環境変数で指せるのは同梱の CLI（`hangar` コマンド）だけで、CLI は `HANGAR_NODE`、`nodePath`、殻と同じ探索先の順に探す。
並びは `/opt/homebrew/bin/node`、`/usr/local/bin/node`、Homebrew の keg（`/opt/homebrew/opt/node@N/bin/node`、`/usr/local/opt/node@N/bin/node`）、nvm（`~/.nvm/versions/node/*/bin/node`）、fnm（`~/Library/Application Support/fnm`、`~/.local/share/fnm`、`~/.fnm` の `node-versions/*/installation/bin/node`）、Volta（`~/.volta/tools/image/node/*/bin/node`）、mise（`~/.local/share/mise/installs/node/*/bin/node`）、asdf（`~/.asdf/installs/nodejs/*/bin/node`）、nodenv（`~/.nodenv/versions/*/bin/node`）である。
版ごとに並ぶ場所は、実在する `node` だけを新しい版から並べ、manifest に合う（Node-API が `nodeApi` 以上で、アーキテクチャが同じ）最初の 1 つを採る。
版と読む名前は `node@<数>` と `v<数>.<数>.<数>`、`<数>.<数>.<数>` だけで、mise の別名（`22`、`lts`）は実体と重なるので見ない。
Homebrew の `node@22` は、前の版の Homebrew では keg-only で `/opt/homebrew/bin` にリンクされず、keg の場所を見ないと `brew install node@22` だけでは見つからなかった。
今の Homebrew（7.0.9 で確かめた）は `/opt/homebrew/bin` にもリンクするので、どちらの場合も拾えるよう `bin/node` と keg の場所の両方を見る。
版の管理ツールは、PATH を切り替える仕掛け（fnm の `fnm_multishells`、nvm の `current` など）ではなく、版ごとの実体の場所を見る。
GUI のアプリの PATH は launchd の最小のものなので、PATH は見ない。
利用者のログインシェルに訊く案（`$SHELL -lic 'command -v node'`）は採らない。
対話のシェルとして起こすと rc の全部が走り、tmux を自動で起こす設定や、端末を前提にした出力や問い合わせを踏みうるうえ、遅い rc では読み込み画面を秒単位で止めるためである。
上の場所に無い入れ方は、`nodePath` で指す。
設定の画面は `nodePath` を保存する前に、殻と同じ条件で確かめる（`config/node.ts`、`PATCH /api/settings`）。
フルパスであること、Node として答えること、Node-API が同梱の `manifest.json` の `nodeApi` 以上でアーキテクチャが同じであること、の 3 つで、合わなければ理由を返して保存しない。
理由は、版が古い（`settings.node.tooOld`。見つけた版と、要る版と、Node-API の版を言う）とアーキテクチャが違う（`settings.node.wrongArch`）を分ける。
フルパスかどうかは、`~` を展開する前の値で見る。殻と CLI（`launch-cli.ts`、`hangar.sh`）は `~` を展開しないので、`~/` で始まる値は、展開すれば実在しても `notAbsolute` にして保存しない（展開を殻と CLI に足すより、層の数が少なく済む）。
新しい版には上限を付けない（Node 24 も保存する）。
準備の確かめ（欄の下の ✓ と ✗）も同じ 3 つを、同じく展開前の値で見て、`settings.json` を直に書き換えた値でも、殻が使わない Node には ✓ を付けない。
要る版は、配布版では `server.mjs` の隣の `manifest.json` から読み、ソースから動かしているときは規則の既定の値（`config/nodeRule.ts` の `NODE_API_MIN` と `NODE_MIN_LABEL`）とサーバを動かしている Node のアーキである。
同梱の CLI（`hangar.sh`）は `HANGAR_NODE` と `nodePath` を先に見て、そのあとは同じ場所を同じ順に探し、並びの一致は `node.rs` の試験が `hangar.sh` の `node-places` の印の間を読んで縛る。
`HANGAR_NODE` と `nodePath` は、殻と同じくフルパスだけを受け、そうでなければ「絶対パスではありません」と挙げて次へ進む。
見つからないときの文（殻の詳細は `node.rs` の `describe_error_for`）は、何が起きたか（見つからない、版が古い、アーキテクチャが違う）、理由の 1 文（「Hangar のデータベースと端末の部品は Node-API 10 を使うため、Node 22.14 以上が要ります。」）、入れ方、指し方、調べた場所とそれぞれが合わなかった理由の順に出す。
入れ方は、合わない Node がすでにあるかで変える。
今ある Node を置き換える入れ方を先に出すと、利用者が使っている Node を壊すおそれがあるためである（Node 24 だけがある Windows で、winget の 22 を案内していた。2026-10-13 の報告）。
Node が何も無いときは一般の入れ方にする。macOS は `brew install node`、Windows は `winget install -e --id OpenJS.NodeJS.LTS`（公式のインストーラで `%ProgramFiles%\nodejs` に入り、殻はそこを先に探す）と nvm-windows、Linux は `nvm install --lts` である。
古い Node があるときは、今の Node を置き換えない入れ方を先に出す。
macOS は Homebrew の `node@22`（版つきの formula は既定の `node` を置き換えない）か nvm、Linux は nvm である。
Windows は公式の zip を別のフォルダ（例 `%LOCALAPPDATA%\Programs\node22`）に展開して指す道を先に、nvm-windows を添え、winget の LTS は今の Node を置き換えると添えて最後に置く。
指し方は、起動の失敗の札の「node を選ぶ…」（Windows は「node.exe を選ぶ…」）か `nodePath` である。
CLI の `launch-cli.ts` の `TEXT` も同じ順にする（nvm-windows の行は殻と同じ文）。
サーバ側でも親プロセスの生存を監視し、親が消えたら自ら終了する。
`hangar start` も、サーバを子プロセスとして立てる。
子を起こす Node は、シェルの探し方を通らず、CLI 自身を動かしている Node（`process.execPath`）である。
配布版は `cli.mjs` の隣の `server.mjs` を、リポジトリでは `packages/server/src/main.ts` を tsx で起こし、`HANGAR_PORT` と `HANGAR_PARENT_PID` を渡す。
サーバは起動の最初に、受け渡しの値（`HANGAR_PORT`、`HANGAR_PARENT_PID`、`HANGAR_UI_DIST`、`HANGAR_STOP_ON_STDIN_END`、`HANGAR_LAUNCHER`）を読んでから、それらと、Claude Code が子に立てる印と、サーバが読まない hangar の変数（`HANGAR_RUN_ID`、`HANGAR_UNSET_ENV`、`HANGAR_CLOUD_DIR`、`HANGAR_LAUNCHED`）を自分の環境から消す（`launch/env.ts`）。
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
  設定（`settings.json`）の読み替え（探した道具のパス、別の OS の外部ターミナル、古い鍵の削除、言語を埋めること）はメモリの上で済ませ、待ち受けが通ってから `persistSettings` で書き戻す。
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

殻は起動の失敗を 9 種類の札のどれかに分け、読み込みの頁が 1 枚の札で出す（試作は `docs/superpowers/specs/2026-10-09-small-screens/options.html` の起動の失敗の B 案）。
殻の側は `src-tauri/src/bootfail.rs`、頁の側は `loading/boot-fail.js`（文の表）と `loading/boot.js`（描画）である。

- 種類は 9 つである。サーバが書く 4 つ（上の `kind`）に、殻が自分で決める 5 つを足す。`compat-mismatch`（互換の版の合わない別のサーバ。ポートと 2 つの版を `params` に持つ）と、合う Node が無いときの 3 つ（`node-missing`、`node-version-mismatch`、`node-arch-mismatch`。下の「Node の札」）と、`other`（殻のそれ以外の失敗：App Translocation、頁を移せない、応答が途切れた、など。理由は `detail` に殻の文で載せる）である。種類の並びは Rust の `KINDS` と頁の `FAIL_KINDS` で同じにし、`config.test.ts` が突き合わせる。
- 殻が `boot-error.json` を読むのは、**自分の子が死んだとき**だけである（`wait_for_server` と `wait_for_ready` の死の枝）。読むときは、子を起こす直前の時刻（`AppState.child_started`）より更新の時刻が古いファイルを捨てる。読めない、古い、無い、のときは `server-exited` にし、詳細に `desktop.log` の終わりの 20 行を載せる（Node のネイティブモジュールが読めない、などは標準エラーにしか出ない）。ファイルが殻の決める 5 つを名乗っても採らず、知らない種類と同じく `server-exited` に落とす。
- 殻は札の文を書かない。頁へは、決まった式 `window.__hangarBootFail(<JSON>)` で `{ kind, params, detail, lang, version, os, home, sep }` だけを渡す。`home` は置き場の名前（利用者のホームを `~` に縮めたもの。`HANGAR_HOME` に従う）で、札の文と命令に入れる。
  `sep` は OS のパスの区切り（Windows は `\`）で、頁は置き場とファイルの名前（`desktop.log`、`hangar.db`、`backups` と `db`）をこれでつなぐ。
  `~` に縮めるときも、ホームの後ろの区切りはそのまま残す（Windows なら `~\.agent-hangar`）。
  区切りを `/` に決め打ちしていたので、Windows では記録の場所が `\.agent-hangar/desktop.log` のように区切りを混ぜて出ていた（2026-10-11、Windows の実機の確かめで見つけた）。
  `sep` が無い（前の版の殻）か `\` でなければ、頁は `/` と読む。`params` の文字と `detail` は長さを切り、`detail` に入場の鍵が混じっていたら伏せてから渡す。
  渡す前に、`detail` と文字の `params` の中で利用者のホームから始まるパスを、すべて `~` に縮める（`bootfail.rs` の `shorten_home`、呼ぶのは `lib.rs` の `for_page`）。
  サーバが書く `params` の `file` と `dir`、Node の「調べた場所」と設定ファイルの場所、例外の文に、ユーザー名を出さないためである。
  サーバはホームを縮めずに書くので、縮めるのは殻の 1 か所に寄せ、macOS と Windows で同じにする。
  ホームの前後がパスの文字なら（`/Users/ab`、`/mnt/Users/a`）縮めない。頁は文字を `textContent` だけで書き、`innerHTML` に入れない。
  Windows の形のホーム（ドライブか `\\` で始まる）は、大文字小文字と区切り（`/` と `\`）の違いを同じとみなして比べる（`home_len_at`）。
  Windows のパスは大文字小文字を区別せず、どちらの区切りでも書けるので、書き方が違うだけの同じホームを縮めずにユーザー名を出していた。
  macOS と Linux のホームは、これまでどおり字のまま比べる。置き場の名前（`tilde`）も同じ比べ方にする。
- 失敗は、殻が状態として持ち、頁が引き取る。
  殻は失敗の材料を `Ui.failure` に置いてから、その場でも評価で渡す。
  起動画面（`loading/boot.js`）は口（`__hangarBootFail` など）を作り終えた時点で、殻の命令 `boot_state` を一度だけ呼び、`{ failure, progress, finishing, lang }` を引き取る。
  失敗があれば札を出し、無くて読み込みが終わった合図（`finishing`）が打たれていれば合図を描き、索引の進み具合（`progress`）は待っている間の文に使う。
  `lang` は待っている間の文（読み込み中、何をしているか、ようこそ）の言語で、札と同じ `page_language` で決める。
  日英の表は `loading/boot-frames.js` の `WAIT` にある。頁は `lang` が届くまで待っている間の文を出さない（英語の OS で日本語を一瞬出さないため）。問い合わせが断られたら日本語にする。
  口が出来た後に起きたことは、その場の評価で届く。殻は状態に置くのを先にするので、どちらかで必ず届く。
  状態は「もう一度試す」（`retry_boot`）で空にし、サーバの頁へ移った後は何も返さない。
  以前は、読み込みが終わる前の失敗を殻が貯め、読み込みの合図（`PageLoadEvent::Finished`）で渡し直していた。
  macOS では合図の時点でまだ `boot.js` が走っておらず（`document.readyState` は `interactive`、口は未定義）、渡し直しも落ちた。
  Node の無い Mac で、起動から 40ms で出た失敗が届かず、読み込み中のまま止まった（2026-10-11）。
  Windows も同じ作りで引き取るので、合図と頁の走る順に頼らない。
- 札に切り替わることは、CI が build した殻で確かめる。
  試験のための書き出しの口があり、試験用の feature（`boot-probe`）を立てた build で、殻が `HANGAR_BOOT_PROBE`（書き出す先のファイル）を持って起きたときだけ働く（`src-tauri/src/bootprobe.rs`）。
  CI の段も配布も release の build（`tauri build`）なので、`debug_assertions` では分けられない。
  そこで CI の段の build だけが `--features boot-probe` を立て（desktop ジョブの `.app` の build と、windows ジョブが composite action に渡す `features`）、`release.yml` は立てない。
  配布の build では、環境変数を渡されても書き出さない。
  そのとき殻は `boot_state` に `probe: true` を添え、起動画面は描いた様子（`data-level`、札が見えているか、種類、言語、見出し、詳細）を DOM から読んで、命令 `boot_probe` で殻に渡す（`loading/boot.js` の `report`）。
  殻はそれを JSON にして、そのファイルへ書く（16 KiB まで、一時のファイルから名前を替える）。
  変数が無いときは、`probe` は偽で、頁は `boot_probe` を呼ばず、呼ばれても殻は何も書かない。
  CI の desktop ジョブ（macOS）は `.app` を build し、`apps/desktop/scripts/ci-boot-probe-macos.sh` で一時の場所へ写して、一時のホーム、無いパスを指す `nodePath`、最小の `PATH` だけを渡して起こす（`env -i`）。
  殻が探す場所のうちホームの外のもの（Homebrew の `bin/node` と `node@N` の入れ先、`node.rs` の `UNIX_NODE_PLACES` の `/` で始まるもの）は一時のホームでは外れないので、その段の間だけ脇へ退ける（ランナーには Homebrew の Node がある）。
  windows ジョブは、作ったインストーラで入れ直し、`apps/desktop/scripts/ci-boot-probe-windows.ps1` で殻に渡す環境だけを差し替えて Node を見えなくする（`ProgramFiles` と `LOCALAPPDATA` を空の場所へ、`NVM_*` を外し、`PATH` から `node.exe` のある項目を外す）。
  Windows は 64 ビットの子を起こすとき `ProgramFiles` を `ProgramW6432` の値で書き直すので、`ProgramW6432` も同じ空の場所へ向ける（向けないと、殻は `C:\Program Files\nodejs` の Node を見つけた）。
  どちらも `apps/desktop/scripts/boot-probe-check.ts` が書き出しを読み、札が見えて種類が `node-missing`、詳細に「Node <版>」が入るまで待つ（上限 60 秒）。
  殻が Node を見つけてサーバを起こしたら（desktop.log の `node … server` の行）、探す場所が増えたとみて落とす。
  撮れた画面と殻の記録は、実行の artifact に 7 日だけ残す。
  殻（Tauri）は実行ファイルのパスにシンボリックリンクが混じるとリソースの場所を決められないので、写す先は実の名前に直してから使う（macOS の `/var` はリンクである）。
- 殻が同梱のサーバを起こして本当の画面へ移る正常な道も、macOS の CI が build した殻で確かめる。
  札の段は Node を隠すので、殻の `server_command`（選んだ Node、`HANGAR_UI_DIST`、`HANGAR_PARENT_PID`、PATH の足し方）を通らない。
  `bundle-server.test.ts` が通す `bin/hangar start` の経路も、殻のこの経路とは別である。
  desktop ジョブは `apps/desktop/scripts/ci-boot-normal-macos.sh` で `.app` を一時の場所へ写し、一時のホームの `settings.json` の `nodePath` で setup-node の Node を指し、`PATH` を Finder から起きたときと同じ最小のものにして起こす（`env -i`）。
  `apps/desktop/scripts/boot-normal-check.ts` が次を順に見る（上限 150 秒）。
  `/health` が `ok` と `ready` を返す。
  `desktop.log` の `node … server …` の行で、殻が `nodePath` の Node と `.app` の中のサーバを選んだ（ランナーには Homebrew の Node もある）。
  サーバが殻の子で、`ps -E` で読んだ環境が `HANGAR_UI_DIST`、`HANGAR_PARENT_PID`、`HANGAR_PORT`、`HANGAR_HOME` と、最小の `PATH` の後ろに `augmented_path` の置き場を足したものである。
  鍵付きの `GET /` が同梱の `ui/index.html` をそのまま返し、そこから読む資産も返る。
  殻が画面を移し（`navigating to the server`）、WebKit の通信のプロセスがサーバへつなぐ（UI は起動の時に WebSocket を張る）。
  起動画面は tauri の中の頁でサーバへはつながないので、このつなぎはサーバの頁のものである。
  起動画面の書き出し（`HANGAR_BOOT_PROBE`）は、失敗の札が出ていれば落とし、読み込みの合図（印が `ready`）を描いていれば記録に書く。
  合図は必須にしない。サーバが起動画面の読み込みより先に用意できると、殻は合図を打たずに画面を移す。
  CI の空のホームでは索引が 0.1 秒で済み、起動画面は何も書かないうちに移った（2026-10-11）。
  殻を止めると、サーバも `HANGAR_PARENT_PID` の見張りで降りる（20 秒まで待つ）。
  release の macos ジョブも、署名した後、dmg を作る前に、署名した `.app` で同じ台本を回す。
  書き出しを必須にしないので、配布の build から書き出しの口を外しても、この段は落ちない。
- 札の中は、見出し、何が起きたか、番号つきの次にすること（順序つきの一覧）、コピーできる命令、詳細（最初から開いた記録。「全文をコピー」つき）、下端のアプリの版と OS、「ログを開く」「もう一度試す」の順に並べる。ロゴは左上に小さく退ける（信号の 3 点の右、UI の `--lights-end` と同じ幅から）。命令と詳細だけを等幅にする。
  命令の欄は切らずに折り返して全文を見せる（以前は 1 行に収めて末尾を … で切っていて、Windows の長い PowerShell の命令が画面で読めなかった。2026-10-11）。
  起動画面は UI の書体（JetBrains Mono）を読み込まないので、等幅は `ui-monospace, 'SF Mono', Menlo, 'Cascadia Mono', Consolas, monospace` の順に OS の書体を使う。日本語の Windows の既定の等幅（MS ゴシックなど）は `\` を `¥` の字形で描くので、パスやコマンドが `¥` に見えないよう、`\` を正しく描く書体を総称の `monospace` より先に置く。
  本文とボタンも、起動画面は Inter を読み込まないので、欧文は日本語の書体で描かれ、Windows では `\` が `¥` に見えていた（2026-10-11、Windows の実機の確かめで見つけた）。
  そこで `'Inter Variable', 'Segoe UI', 'Hiragino Sans', sans-serif` と、Windows の UI の書体を日本語の書体より先に置く。Segoe UI は macOS に無いので macOS の見た目は変わらず、日本語の字は Segoe UI に無いので、これまでどおり後ろの書体で描く。
  詳細が伸びても札が窓（最小 900×600）に収まるよう、詳細の枠だけが縮んで中で流れ、操作は見えたままである。焦点は札が出たとき「もう一度試す」に置く（Enter で押せる）。Tab の順は、命令のコピー、詳細、全文をコピー、更新を確認、ログを開く、もう一度試す。
- 札の中から更新を受け取れる（2026-10-11）。
  起動に失敗する版を入れた人は UI まで届かないので、UI の自動の確認と右下の札では新しいバージョンを受け取れず、手で入れ直すしかなかった（rc.1 の Windows）。
  下端の版と OS の横に「更新を確認」を置き、押すと殻の `update_check` を呼ぶ（その間は押せない「確認中…」）。
  新しいバージョンが無ければ釦を退けて「最新」と添え、あれば札の中に帯（「Hangar X を利用できます」と「ダウンロードしてインストール」）を出す。
  帯の釦を押すと、`update_download` で取得しながら `update_status` で進みを読んで帯に出し、済んだら `update_install` を呼ぶ。インストールが済むと殻が再起動する。
  失敗は殻の分けた 4 つ（network、signature、permission、other）で理由を言い、もう一度押せるようにする。
  帯が主の釦を持つ間は、主の釦を 2 つにしないよう「もう一度試す」を主の見た目から外す。取得とインストールの途中は、頁を読み込み直させないよう「もう一度試す」を押せなくする。
  Node の札では、新しいバージョンを入れても Node は入らないので、帯に「直っていることがあります」と添えない。
  命令は UI と同じ 4 つで、起動画面にも与える（`capabilities/boot-screen.json`）。文は `boot-fail.js` の `updateView` の日英の表が持ち、語は UI の辞書（`update.*`）にそろえる（試験が突き合わせる）。
  殻も、起動に失敗したとき 1 度だけ自分で確かめる（`lib.rs` の `check_update_after_failure`）。
  確かめ始めるのは、起動画面が札を描いた後である。
  頁は札を描いたコマの後（`requestAnimationFrame` の中から次の番）で命令 `boot_card_shown` を 1 度だけ呼び、殻はそれを受けて確かめる（`Ui::card_shown`。やり直して読み込み直した頁が呼んでも重ねない）。
  殻が失敗を知った時点（`fail`）では確かめない。札は確かめの結果を待たずに出し、言語も札が持つ `lang` で決めるので、`boot_state` の `lang` も待たない。
  以前（rc.6）は `fail` の中で確かめ始めていて、目録の取得と証明書の検証が札の最初の描画と重なっていた。
  窓が隠れていてコマが来なければ、見えるまで確かめない。
  見つけた版は `Ui.update` に置いて `boot_state` の `update` で渡し、その場でも `window.__hangarBootUpdate({ version })` で渡すので、押さなくても札に後から帯が足される。
  やり直しても `Ui.update` は消さない。確かめに失敗したときはログに残すだけで、札には出さない。
  札は出したときの高さで窓の縦の真ん中に置き、その上端を留める（`boot.js` の `placeCard`。`margin-top` で持ち、`body[data-fail-pinned]` で上寄せにする）。
  後から帯が足されたり詳細を開いたりして高くなっても、上端は動かさずに下へ伸ばし、窓の下端からはみ出すときだけ、収まる分だけ上げる。
  窓の大きさが変わったときと、札を出し直したときは、そのときの高さで真ん中に置き直す。
  以前は真ん中寄せのままで、殻が札を描いた後に見つけた版の帯が足されると、札が帯の高さの半分（約 37px）だけ上へ跳ねた（0.3.0 の確かめで見つけた）。
  UI の「更新を通知する」のスイッチ（`localStorage`）は殻から読めないが、起動できない版から抜け出す口なので、この 1 度の確認はスイッチに依らず行う。
- Node の札（`node-missing`、`node-version-mismatch`、`node-arch-mismatch`）は、ほかの札と並びを変え、入れ方を主にする（利用者が選んだ形、2026-10-11）。
  以前は種類が `other` で、見出しは「Hangar を起動できませんでした」、本文は「起動の途中で止まりました。理由は下の詳細にあります」の汎用の文で、入れ方は詳細の枠の中にしか無かった。
  種類は `node.rs` の `failure_kind` が決める。
  要る Node-API を持つ別のアーキテクチャの Node があれば `node-arch-mismatch`、Node として答えた候補があれば `node-version-mismatch`、無ければ `node-missing` である。
  要る作りの別のアーキを先に言うのは、入れ直すものがその作りだからである。
  0.6.0 までは 1 つの `node-missing` に理由（`reason`）を添えていたので、ログは版が違うだけのときも `boot failed (node-missing)` で、Node 24 だけがある Windows で「見つかりません」と読まれた（2026-10-13 の報告）。
  殻は `failure_params` で、要るもの（`min`、`napi`、`arch`）と、見つけた Node の版と作り（`found`、`foundArch`）を `params` に入れる。
  見出しは種類に合わせる。
  見つからないときは「Node.js が見つかりません」、版が古いときは「Node.js 20.18.0 は見つかりましたが、Hangar は Node.js 22.14 以上が要ります」、作りが違うときは「x64 用の Node.js は見つかりましたが、Hangar は arm64 用が要ります」である。
  本文は理由の 1 文（Node-API 10 を使うため）で、古い Node があるときは「今の Node.js は置き換えずに、別の場所に入れられます。」を添える。
  次にすることの列の代わりに、前置きの 1 文と入れ方を置く。
  見つからないときのコマンドは、macOS は `brew install node tmux`、Windows は `winget install -e --id OpenJS.NodeJS.LTS`（psmux はホームの帯と始める前の案内が別に出すので Node だけ）、ほかは `nvm install --lts` である。
  古い Node があるときは、今の Node を置き換えない入れ方にする。macOS は `brew install node@22`、ほかは `nvm install 22` のコマンドを出す。
  Windows は winget の Node が `C:\Program Files\nodejs` の今の Node を置き換えるのでコマンドを出さず、公式の zip を取る、別のフォルダに展開する、「node.exe を選ぶ…」で選ぶ、の 3 つの手順（見出しの無い番号つきの列）を出す。
  コマンドの下に主の釦と「node を選ぶ…」（Windows は「node.exe を選ぶ…」）を並べる（`boot.js` が `boot-retry` を `fail-primary` へ移す）。
  主の釦は、コマンドのある札では「入れたのでもう一度試す」（動きは「もう一度試す」と同じ `retry_boot`）、コマンドの無い札（古い Node がある Windows）では「node.exe を選ぶ…」で、そのときは「もう一度試す」を並の釦にして後ろに置く。焦点は主の釦に置く。
  「node を選ぶ…」は殻の命令 `pick_node` を呼ぶ（起動画面だけに与える。`capabilities/boot-screen.json`）。
  殻はファイルの選択を開き（Windows は `node.exe` の絞り込みと `%LOCALAPPDATA%\Programs` から）、選んだ 1 つを、殻が Node を探すときと設定の「Node のパス」と同じ条件で確かめる（`node.rs` の `check_picked`）。
  合えば `<HANGAR_HOME>/settings.json` の `nodePath` に書き（ほかの項目は残し、0600 で、一時のファイルから名前を替える。読めない設定は上書きしない）、頁が起動をやり直す。
  合わなければ、Node として答えない、版が古い、作りが違う、保存できない、を分けた 1 文を釦の下に添え（`boot-fail.js` の `pickText`）、もう一度選べるようにする。取り消したら何もしない。
  頁からパスは受け取らない。`nodePath` は次の起動で殻が起こす実行ファイルなので、利用者がダイアログで選んだものだけを書く。
  詳細の枠（調べた場所と、別の入れ方と `nodePath`）は畳み、「詳細（調べた場所、別の入れ方）」の 1 行で開く。
  詳細の文は `describe_error` のままで、CI の Windows の段が見る winget の命令（`OpenJS.NodeJS.LTS`）も、Node が何も無いときに含む。
  ほかの種類の札は、前置きの文と選ぶ釦を持たず、詳細を開いたまま、主の釦は下端の「もう一度試す」のままである。
- 「全文をコピー」は、版と OS、種類、詳細の順の文をクリップボードへ書く。そのまま報告に貼れる形である。クリップボードの口が無い頁では、選択と `copy` の命令で写す。
- ポートと互換の失敗では、動いているサーバ（利用者が起こしたものかもしれない）を止めないと文で言う。
- 命令は OS で出し分ける（`boot-fail.js` の `POSIX` と `POWERSHELL`）。OS の名前が `Windows` で始まれば PowerShell の形にする。
  ポートを握っているものは、macOS と Linux では `lsof -nP -iTCP:<port> -sTCP:LISTEN`、Windows では `Get-Process -Id (Get-NetTCPConnection -LocalPort <port> -State Listen).OwningProcess` で見る。
  DB の退避は `mv` と `Move-Item -LiteralPath … -Destination …`、控えの置き場は `ls -la` と `Get-ChildItem -Force -LiteralPath …` である。
  PowerShell のパスは、`~` で始まれば `$HOME` に替えて二重引用符で包み、残りの `$` と `` ` `` と `"` を `` ` `` で逃がす。それ以外で安全でない文字を含めば単引用符で包み、中の単引用符を 2 つにする（`psQuote`）。
  以前は Windows で lsof の命令を添えず、`mv` と `ls -la` はそのまま出していた（2026-10-11、Windows の実機の確かめで見つけた）。
- アプリの呼び名も OS で出し分ける。OS の名前が `macOS` で始まれば `Hangar.app`、ほか（Windows と Linux）では `Hangar` と呼ぶ（`boot-fail.js` の `c.app`）。
  互換の別のサーバが新しいときの次にすることは、macOS では「Hangar.app を新しい版に入れ替えます」、ほかでは「Hangar の新しい版をインストールします」にする。
  以前は Windows の札にも「この Hangar.app」と出ていた。殻が書く詳細のうち `.app` と言うのは App Translocation の案内だけで、これは macOS の写しの場所でしか起きない。
- 版は殻（`app.package_info()`）、OS の名前と版は殻が失敗のときに読む（macOS は `sw_vers -productVersion`、Linux は `/etc/os-release`、Windows は登録簿の `CurrentBuildNumber` と `DisplayVersion`）。Windows の製品名は Windows 11 でも「Windows 10」のままなので使わず、ビルド番号 22000 からを Windows 11 と呼ぶ（「Windows 11 24H2 (build 26100)」）。
- 頁の言語は、サーバと UI と同じく `<HANGAR_HOME>/settings.json` の `language` で決める（「言語の決め方」の節。`bootfail::page_language`）。
  設定で決まれば OS には聞かない。初めての起動で殻が先に動けば、起動の頭（`boot` の最初）で殻が OS の表示言語を設定に書く（`bootfail::ensure_language`）。
- 頁の文は UI の辞書を使えないので、日英の表を頁に持つ（`boot-fail.js`）。言語の並びは shared の `LANGUAGES` と同じにし、試験が突き合わせる。
- 殻が自分で書く `detail`（`other` と Node の札の理由と、時間切れの案内）は、頁と同じ言語で書く。
  英語の設定でも「Node 22（x64）が見つかりません」「調べた場所」が日本語のまま出ていた（2026-10-11、Windows の実機の確かめで見つけた）ためである。
  文の日英の表は殻に持つ（`src-tauri/src/bootmsg.rs` の `Msg`、Node が見つからないときは調べた場所を並べるので `node.rs` の `describe_error_in`）。
  言語は札と同じく `page_language` で決める。
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
│  ├─ Header                ロゴ、「移動・操作」の錠剤、使用率のゲージ、同期状態、注意（Bell と NoticeList、中身があるときだけ）、新しいセッションのボタン
│  └─ Main
│     ├─ HomeScreen         HomeBand（錠剤 + 引き出し） / SessionList（タブ、欄、絞り込み、行）
│     ├─ ProjectsScreen     節 × n → ProjectRow（行の表）
│     ├─ ProjectScreen      見出し / SessionList / 右パネル（TodoList、InstructionsPanel、ArtifactCards）
│     ├─ SessionScreen      見出しの段（SessionBadges、(i) の詳細） / TabStrip / TerminalPane または Transcript（ToolGroup＝続けて呼んだツールのまとめ） / 見出しの下の 1 行（EndedFacts） / 右の列（NowCard＝現在の札、SummaryCard＝要約の札、TocPane（TurnIndex））
│     └─ SettingsScreen     目次 / 選んだ節（一般、ツール、連携、要約エンジン、更新、クラウド同期、情報）
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

### 待機中の描き直し

待機中（どのセッションも休みで、画面も触られていない）に、見た目の変わらない描き直しをしない（2026-10-14、0.6.1）。

- 行や状態をまるごと運ぶ知らせ（`session.upsert`、`project.upsert`、`run.upsert`、`live.update`、`git` の読み直しなど）は、中身が今のストアと同じなら同じストアを返す（`store.ts` の `applyServerEvent` と `applyGit`、比べるのは `lib/same.ts` の `sameValue`）。サーバは登録が変わると全プロジェクトを配り直すなど、変化が無くても配ることがある。
- 窓が隠れている間（`visibilityState` が hidden で、前面でもない）の知らせは、ストアに当てて Mediator には渡すが、React へは知らせない。見えたとき（`visibilitychange`）か前面に来たとき（`focus`）に 1 回だけ知らせる（`runtime.ts` の `notifyStore`）。入力待ちの知らせと画面の移り変わりは、隠れていても今までどおり動く。
- 相対時刻の時計（`Root` の 30 秒、切断中と参加トークンの 1 秒）は、隠れている間は止め、見えたときに 1 回だけ進める（`views/primitives/useNow.ts`）。
- ターミナルのカーソルは点滅させない（`xtermSetup.ts` の `cursorBlink: false`）。点滅の間、xterm は窓が前にあるだけで 600 ミリ秒ごとに端末を描き直す。tmux は attach のたびに点滅を切る（`ESC [ ? 12 l`）ので、macOS と Linux の見た目は変わらない。
- 止まらないアニメーションは、意味のある状態の間だけ回す。作業中の丸（`live-dot` の `live-pulse`）と端末の縁（`term-pane` の `rim-breathe`）は作業中だけ、入力待ちの知らせの札の輪（`notice-ping`）は入力待ちの札が出ている間だけである。

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

他端末で動いているセッションに対して View が出すのは、`session.resumeHere`（確認の 1 枚を開く）と、停止を頼んで引き継ぐ `session.takeover.start`（`force` つき）、`session.takeover.extend`、`session.takeover.cancel` である（「他端末セッションのロックと『この PC で再開』」）。

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
メモをファイルでも持ったのは、他のエディタや Claude 自身から直接読み書きできるようにするためだった。
プロジェクトのメモ（画面の語は「ノート」）は 2026-10-11 にやめた（「プロジェクト詳細」の右パネル）。
画面と MCP からは書かず、起動時の指示にも渡さない。
保存の仕組み（`projects/memo.ts` と `GET`、`PUT /api/projects/:id/memo`）と同期の表 `project_memos` は、中身の残る古いノートを読んで削除できるように、いまは残してある。
画面が使うのは、「以前のノート」として読むことと、確かめてから空で保存して消すことだけである。
ノートの欄を持つ古い版の端末は、まだこの表の行を送ってくる。
Worker は知らない表の行を 1 つでも含む送信を丸ごと断るので、表を共有テーブルの一覧から外すと、その端末のほかの表の同期まで止まる。
受け取る側も、降りてきた古いノートを「以前のノート」として見せられるように、表と適用を残す。

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
  updated_at integer not null, deleted_at integer, origin_device text not null,
  git_remote text                                 -- 正規化した git の remote（github.com/owner/repo）。版 24（0.6.1）
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

-- セッションの名前。hangar が付けるもので、索引は書かない（下の「セッションの名前」）。
-- 表の名前の notes は、ノート（memo の列）も持っていた頃の名残である。memo は版 21（0.4.0）で落とした。
create table session_notes (
  session_id text primary key references sessions(id),
  name text,                                      -- hangar で付けた名前（起動のときの名前）
  updated_at integer not null, deleted_at integer, origin_device text not null
);

-- セッションについて利用者が決めること（状態、提案、所属、削除）。索引は書かない。
-- 本文から読み取れる事実（件名、cwd、時刻）は sessions に置き、本文を持つ PC が書き直してよい。
-- 利用者の決めたことはここに置くので、索引の書き直しや sessions の後勝ちで戻らない。
create table session_states (
  session_id text primary key references sessions(id),
  status text check (status in ('paused','done','archived')),  -- null は Active
  note text, return_on text, set_by text check (set_by in ('user','conversation','import')), set_at integer,
  candidate_status text check (candidate_status in ('paused','done')),
  candidate_note text, candidate_return_on text,
  candidate_source text check (candidate_source in ('in_session','exit','post_hoc')), candidate_at integer,
  rejected_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null,
  return_time text, candidate_return_time text,   -- 戻る時刻（版 14）
  project_id text,                                -- 利用者が移した先。null なら cwd からの自動の振り分けに従う（版 25）
  trashed_at integer,                             -- 削除の印。null なら生きている。行の論理削除の deleted_at とは別物（版 25）
  restored_at integer                             -- 明示の復元の時刻。印はこれが印より新しいときだけ外れる（版 27）
);

-- 1 回の起動または再開。tmux 上の寿命と一致する。
create table runs (
  id text primary key, session_id text not null references sessions(id),
  device_id text not null references devices(id),
  kind text not null check (kind in ('start','resume','fork')),
  tmux_name text not null, pid integer,
  launch_params text not null,                    -- JSON
  started_at integer not null, ended_at integer, end_reason text,   -- 'exited' | 'killed' | 'lost' | 'parked' | 'taken_over'
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
  updated_at integer not null, deleted_at integer, origin_device text not null,
  candidate_at integer, candidate_session_id text, candidate_note text,  -- 完了の候補（版 10）
  rejected_sessions text not null default '[]',                           -- 候補を却下したセッション ID の JSON 配列（版 10）
  suggested_at integer, suggested_note text                               -- Claude の提案で、まだ受け入れていない（版 20）
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
-- 2026-10-16 に「停止を頼んで引き継ぐ」を入れたが、この表は使わない。頼みと応答は版 28 の takeovers と takeover_answers で運ぶ（下）。
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

ほかの PC で動いている会話を止めて引き継ぐための 2 つの共有表は、マイグレーション version 28 で足した（2026-10-16）。
どちらも `SHARED_TABLES` の末尾に足してある。
同期する表なので `check` も外部キーも付けない。
後の版が値を足しても古い PC の適用が落ちないようにするためで、頼みは相手の行より先に届きうる一時の行だからでもある。

```sql
-- 引き継ぐ側が書く「止めて」の頼み。書き手は頼む側の PC だけ。
create table takeovers (
  id text primary key, session_id text not null, run_id text not null,   -- run_id は止めてほしい run（頼まれた側の PC の run）
  target_device text not null, from_device text not null, requested_at integer not null,
  mode text not null,                             -- 'ask'（返事を待つ）| 'force'（待たずに引き継ぐと決めた印）
  cancelled_at integer,                           -- 取り下げた時刻。行は残す
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create index takeovers_target on takeovers(target_device, run_id);
-- 頼まれた側が書く応答。主キーは頼みの id なので、頼み 1 件に応答は 1 行。書き手は頼まれた側の PC だけ。
create table takeover_answers (
  ask_id text primary key, run_id text not null,
  result text not null,                           -- 'stopped'（頼まれて止めた）| 'not_running'（届いたときすでに動いていなかった）
  answered_at integer not null,
  transcript_sha256 text, transcript_size integer, -- 止めたあとに上げた最後の本文の版。上げていなければ null
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

#### セッションの名前

セッションの名前は `sessions` の列に置かず、別の表 `session_notes`（主キーはセッションの id）に置く（マイグレーション version 17）。
`sessions` の行は索引だけが書く。
版 17 から 0.3.0 までは、同じ表に人間が書く 1 行のノート（`memo`）も置いていた。
ノートは使われておらず、要約（`set_session_summary`）と Paused の戻る日がその役を担うので、0.4.0 で画面からも MCP からも外し、版 21 で列を落とした（下の「ノートを外したとき」）。
以下の節の「名前とメモ」は、版 17 で移したときの話である。

`sessions` の行は、索引が本文の伸びるたびに全列で書き直し、同期はその行ごとの後勝ちで運ぶ。
名前とメモが同じ行にあると、別の PC で付けた名前やメモを、本文を持つ PC の索引が手元の古い値で上書きする。
セッションの状態（`session_states`）を別の表に分けたのと同じ理由である。
分ける前は、索引の書き直しが、誰も書き換えていないメモまで巻き込んで上書きした。
そのため同期の適用（`sync/apply.ts`）は、`sessions` の行を上書きする前に、メモを `backups/memos/` へ逃がしていた。
分けた今は、その控えを `session_notes` の行の上書きで取る。取られるのは、2 台が本当に別々に書いたときだけである（「クラウド同期」の、メモの控え）。

- **書き手。** `session_notes` に書くのは、起動のときの名前（`runs/manager.ts`）だけで、`sessions/notes.ts` の `setSessionName` を通る。
  書いた結果が今と同じなら書かず、行の無いところへ空を書いて空の行を作ることもしない。
  空の行は新しい時刻を持つので、同期で他の PC の名前に勝ってしまうからである。
- **本文の題名は別の事実。** Claude Code の側で付けた名前（`-n`、`/rename`）は本文に `custom-title`、`agent-name` として残り、索引がそれを `sessions.custom_title` に拾う。
  分ける前は、索引も hangar も同じ `sessions.name` に書き、後から書いた方が残った。
  hangar が名前を書くのは起動のときだけなので、本文に題名が現れれば必ずそれが残った。
  この見え方を変えないよう、表示名は、本文の題名を hangar の名前より先に採る（`db/queries.ts` の `displayName`）。
  順は、実行中の Claude Code が持つ利用者の名前（レジストリの `name`、`nameSource` が `user`）、`sessions.custom_title`、`session_notes.name`、`sessions.ai_title`、最初の発言の先頭 40 字である。
  `custom_title` は列の追加で、改名ではない（D8 に反しない）。
- **DTO は変えない。** `SessionDto` の `name` は、サーバが `sessions`、`session_notes`、`session_states` を合わせて今までと同じ形に組む（D8）。UI は表が分かれたことを知らない。
  `SessionDto` の `memo` は、ノートを外したときに鍵ごと消した。
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
- **ノートを外したとき（版 21、0.4.0）。** `session_notes.memo` を `alter table ... drop column` で落とす。名前と行はそのまま残す。
  読み書きする口（画面、`PATCH /api/sessions/:id`、MCP の `set_session_memo`）を全部外したので、列だけを残すと、後から読んだ人がもう書かれない値を正と取り違える。それで列ごと落とした。
  中身は、当てる前に取る DB の控え（`backups/db`、`packages/server/src/db/backup.ts`）に残る。ほかの表へは写さない。
  名前が空でノートだけがあった行も、名前が null の行として残す。消すと、古い形の `sessions` の payload が降りたときに作り直す（`adoptNoteFromOldSession`）など、名前の同期の決着が変わるからである。
  `changes` には積まない。この PC の表の形を変えるだけで、他の PC の行には触らない。
  古い版の PC と同期で混ざっても壊れない。古い版が送る payload の `memo` は、適用が手元の表に無い列として捨てる。
  この版が送る payload は行の全列で `memo` の項目を持たず、古い版の適用は payload に無い列を上書きしないので、古い版の手元のノートは消えない。
  控え（`backupSessionNote`）、写し同士の決着（`copiesCollide`）、古い形の payload からの作り直し（`adoptNoteFromOldSession`）は、名前だけを見る。
  運ぶ形は変わらない（列が 1 つ減っただけで、どちらの版も知らない列を捨てる）ので、互換の版は上げない。

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
| `sessions`、`session_summaries`、`session_states`、`session_notes` | そのセッションの `session.upsert`。sessions の行が論理削除されていれば `session.removed`（画面は Store から外す） |
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
| run が lost で終わったとき（`runs/announce.ts`） | そのセッション | 中断の印（`SessionDto.interrupted`）は run の終わり方から決まる |
| 同じファイルの編集の見張り（`sessions/overlap.ts`） | 写しが変わったセッション | 重なりは手元だけの表（`session_overlaps`）にある |
| run の起動（`runs/announce.ts`） | そのセッション | run が付いた。`run.started` の後に届く |
| statusline の受け口（`POST /api/ingest/statusline`） | そのセッション | モデルと文脈の量は手元だけの表（`session_live_stats`）にある |
| 設定の同期（`sync/config/service.ts`）。`config_state` の `self` を名指しする | 設定の同期の状態 | 基準（`config_base`）、送らなかった項目（`config_unsent`）、inbox、適用の指示書、スイッチと承諾の仕方は、行のイベントになる共有の表ではない |
| 昇格（`POST /api/sessions/:id/promote`） | 昇格元のプロジェクト | セッションが 1 件減る |

呼び手が `broadcast` で渡す、表の変化に対応しない知らせは次のとおりである。

| 知らせ | 渡す所 |
| --- | --- |
| `toast` | 同期の知らせ（`sync/notices.ts`、`sync/oncePass.ts`）、`POST /api/index/rebuild` の失敗。操作の結果と、メモの競合のように手元で起きたことの知らせだけで、同期の失敗は流さない（「注意と知らせの出し分け」の節） |
| `run.started`、`run.upsert`、`run.ended`、`tab.upsert` | `runs/announce.ts`（RunManager の通知） |
| `index.progress`、`transcript.appended` | `boot/indexing.ts`（索引の進み）、`projects/onSessionChanged.ts`（本文の伸び） |
| `live.update` | `sessions/liveChange.ts`（実行中の一覧） |
| `interrupted.update` | `runs/announce.ts`（中断の束を記録したとき）、`POST /api/interrupted/dismiss`（再開しない、元に戻す） |
| `sync.status`、`sync.usage` | `sync/statusFeed.ts`（同期の状態）、`boot/sync.ts`（使用量の見張りの結び） |
| `accounts.update` | `http/accounts.ts`、statusline の受け口 |
| `retention.changed` | `provider/claude-code/config/retention.ts` |
| `settings.changed` | `http/routes/settings.ts`（`PATCH /api/settings` が保存できたとき。変えた欄の名前 `keys` と保存後の設定を運ぶ） |
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

-- この PC がゴミ箱へ移した本文の元のパス（版 26、「セッションの削除」の節）。同じパスに主線のファイルが戻ってきたら復元する。
create table trashed_transcripts (
  path text primary key,
  session_id text not null,
  kind text not null check (kind in ('file','dir')),  -- 主線の jsonl か、隣の <uuid>/ のフォルダか
  trashed_at integer not null                         -- 削除の印の時刻
);
-- この PC が削除の印を処理し終えたセッション（版 26）。印が付け直されたら時刻が変わるので処理し直す。
create table trash_applied (
  session_id text primary key,
  trashed_at integer not null
);
-- この PC が上げた本文の世代（版 32、「同期対象と暗号化」）。ゴミ箱の掃除が、世代ごとの R2 の鍵名を求め直して消す。
create table blob_uploads (
  ledger_key text not null,                           -- 台帳（file_sync）と同じ形の鍵（transcripts/<端末>/<uuid>.jsonl.gz など）
  epoch integer not null,                             -- 上げたときの世代
  primary key (ledger_key, epoch)
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

-- 使用制限で止まっているセッション（版 23、0.5.0）。主線の本文の合成の行（error が rate_limit）から索引が書き、
-- 次の指示か返答で消す。セッションが実行中から外れたときも消す（「止まっている理由」の節）。
create table session_limits (
  session_id text primary key,
  kind text not null,                              -- five_hour、weekly、other
  resets_at integer not null,                      -- リセットの時刻（ミリ秒）
  auto integer not null default 0,                 -- Claude Code が自動の続きを予約したと書いたか
  hit_at integer not null
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

-- 中断の群（ホームの帯の「前回実行中」）。最後に記録した 1 つの束で、新しい束を記録すると前の行は消す。
-- cause は restart（起動の見回り）か mux（tmux のサーバごと消えた）、last_live は止まる前の最後の状態、dismissed_at は「再開しない」の印。
create table interrupted_runs (
  run_id text primary key, session_id text not null, at integer not null,
  cause text not null check (cause in ('restart','mux')),
  last_live text, dismissed_at integer
);
-- 生きた run ごとの最後の状態（Claude の登録の status）。中断を記録するときに写す。
create table run_last_live (run_id text primary key, status text not null, at integer not null);
-- 同じファイルの編集の写し。payload は SessionOverlapDto の JSON で、セッションの行に左結合して配る。
create table session_overlaps (session_id text primary key, payload text not null, updated_at integer not null);
-- 「このファイルでは表示しない」。2 つのセッションの id は小さい方を session_a に置く。
create table overlap_dismissals (
  session_a text not null, session_b text not null, path text not null, at integer not null,
  primary key (session_a, session_b, path)
);
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
- 2.1.300 からは、API に送った要求の記録（`api-request`、`api-request-blob`、`api-request-shape`）が呼び出しごとに書かれる。1 行が 10〜90KB あり、会話の本文は別の行にあるので、正規化でイベントを作らずに捨てる（`DROPPED_LINE_TYPES`）。この変更より前に索引へ入った行は、読み出すときに正規化し直すので、何も返さない。
- `user` 行の `message.content` は配列ではなく文字列のことがある。抽出は両方を受ける。
- サブエージェントの本文は `<sessionId>/subagents/agent-<hex>.jsonl` にあり、`isSidechain: true` で親に紐づく。件数はセッション本体の 3 倍以上あり、インデクサは両方を読む。
- 実行中の状態は `~/.claude/sessions/<pid>.json` にあり、`sessionId`、`cwd`、`name`、`nameSource`、`status`（busy、idle、waiting、shell）を持つ。ファイルの出現と消失が起動と終了に対応する。
  - `RegistryWatcher` は登録のディレクトリを `fs.watch` で見張り、知らせから 50 ミリ秒待って読み直す（`WATCH_SETTLE_MS`。改名で続けて来る知らせを 1 回にまとめる）。周期の読み直しは、作業中が 1 つでもあるか見張れない間は 500 ミリ秒ごと（裏だけの印が本文の索引で変わるため）、見張れていて作業中が無い間は 2 秒ごとである（`boot/delivery.ts` の `REGISTRY_POLL_MS` と `REGISTRY_IDLE_MS`、2026-10-14、0.6.1）。2 秒の周期が拾うのは、Windows で止められた claude の pid が消えたこと（登録が残る）と、見張りの取りこぼしである。hook から許可の中身が届いたときは、周期を待たずに読み直す（`PermissionAsks` の `onPut` から `RegistryWatcher.kick`）。
  - Claude Code は、一時のファイルからの改名に失敗すると、登録をその場で書き直す（切り詰めてから書く）。Windows では、ほかのプロセスがファイルを開いているだけで改名が失敗しうる。その間に読むと中身が空か途中までになる。`RegistryWatcher` は、読めなかった登録を、前に読めた中身のまま 2 秒まで続ける（`registry.ts` の `RegistryCarry` と `UNREADABLE_CARRY_MS`）。0.6.0 までは読み直しの回数（500 ミリ秒ごとの 4 回）で数えていたが、読み直しの間隔が状態で変わるようになったので時間で数える。読めないまま捨てると、そのセッションが一瞬だけ終わったように見え、待っている問いまで消える（「Home の帯と引き出し」の節）。ファイルが無くなった登録と、はじめから読めない登録は、今までどおり読まない。
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

#### 本文の監視（`indexer/service.ts`）

待機中は何もしないことを優先する。
以前は 2 秒ごとに全件を stat し、ファイルごとに SQL を準備して引き、`history.jsonl` を頭から読み直していた。
数千ファイルの置き場では、何も変わっていなくてもサーバが CPU を使い続け、1 周にファイルの数の 2 倍の prepare とその実行が走っていた（0.6.0 の報告）。

- 起動すると、先に監視を付けてから全走査する。全走査の間に届いた通知は、走査が済んでから索引化する。
- `~/.claude/projects` と他端末の置き場（`~/.agent-hangar/remote`）は `fs.watch` の recursive で、`~/.claude` そのものは recursive なしで見張る。
- 通知の名前は `discover.ts` の `classifyProjectsEntry` と `classifyRemoteEntry` で振り分ける。
  主線とサブエージェントの jsonl はそのファイルだけを索引化の待ちに積む。
  プロジェクトのディレクトリ、セッションのディレクトリ、`subagents`、名前の無い通知、置き場の外の名前は、中身ごと現れたり消えたりしうるので、全件走査を 1 秒後に 1 回予約する。
  メモリや `tool-results` など本文に関わらない名前は見ない。
- 待ちに積んだ名前は、最初の通知から 300 ミリ秒でまとめて索引化する。予約を後ろへずらさないので、通知が続いても索引化が止まらない。
  同じ位置に他の候補（他端末の写し）があるときは、全件走査と同じ規則（`selectFilesToIndex`）で 1 つを選び、外れた方を索引から落とす。
  名指しされたファイルが消えていたら、片付けは全件走査に任せる。
- 取りこぼし対策の全件走査は 5 分に 1 度、20 ファイルごとにイベントループへ譲りながら回す。
  監視を付けられなかった置き場があるあいだは、10 秒ごとにする。付けられなかった監視は全件走査のたびに付け直す。
  全件走査の途中で全走査（起動、作り直し）が始まったら、全件走査は手を引く。
- 全件走査では、索引に記録済みの大きさ、更新時刻、版を 1 回の問い合わせでまとめて引き、stat と比べる。
  同じなら `indexFile` を呼ばない。条件は `indexFile` が何もせずに返す条件（`isUnchanged`）そのものである。
  選ぶときに取った stat は `indexFile` へ渡し、同じファイルを二度 stat しない。
  消えた本文の片付け（`forgetVanished`）は、全件を列挙したときだけ行う。
  片付け（`forgetTranscriptFile`）は索引を位置（セッションと主線かサブエージェントか）ごとに消すので、同じ位置を別のパスで読んでいた行は版を 0 にして先頭から読み直させる。
  EnterWorktree は本文を worktree 用の projects の下へ移すので、移った先を読み終えた後に元のパスを片付ける順がありうる。読み直さないと続きしか積まれず、最初の依頼が目次から抜ける（2026-10-16 に見つけた）。
  前の版でこう壊れたもの（索引はあるのに先頭の行の索引が無いファイル）は、起動の全走査の前に `markTruncatedForReindex` が版を 0 にして読み直させる。
- 索引の文は DB ごとに 1 度だけ準備して使い回す（`indexer/statements.ts`）。
- `history.jsonl` は `HistoryIndexReader` が前に読んだ所から読み足す。大きさも更新時刻も同じなら読まない。
  同じファイルが大きくなっていて、読み終えた位置の直前の 64 バイトが変わっていなければ、増えた分だけ読む。
  切り詰め、差し替え、同じ大きさの書き直しは全部読み直す。
  本文なしのセッションの登録（`syncHistoryOnly`）は、読んだ中身が前に登録したときから変わったときだけ回す。
- 実行中のセッション（Claude の登録にあるもの）の本文だけは、通知に頼らず 2 秒ごとにも stat で見る（`liveSessions`）。
  Windows では、Claude Code が本文を開いたまま書き足すと、監視の通知が遅れうるためである。
  見るのは主線と、その隣の `<セッション>/subagents` にあるサブエージェントの本文だけで、前に見た大きさと更新時刻から変わったものだけを索引化する。
  主線の場所は全件走査で見たものを使い、まだ見ていなければ登録の cwd から組む。
  周期は登録が変わったとき（`registry.onChange` から `noteLiveChanged`）に張り直し、実行中が 0 本のあいだは張らない。
- 同期が他の PC の `sessions` の行を当てたときと、本文の写しを置いたとき（`RemotePuller` の `onDownloaded`）は、全件走査を 1 回予約する（`requestSweep`、予約済みなら重ねない）。
  写しを採るかどうかは sessions の行が届いているか、消されているかで変わり、ファイルの通知だけでは分からないからである。
  組み立ては `boot/sync.ts` の `onRemoteChange` と `boot/indexing.ts` が結ぶ。
- 監視が通知を落とす機械（ネットワークのドライブなど）では、実行中でない本文の反映が全件走査の周期まで遅れうる。

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
| トランスクリプト | 行の `type`、`system.subtype`、本文の塊の種類、メタ行の種類が、知っている集合にあるか。添付は、hangar が読む積んだ指示（`queued_command`）でない種類が文字の `prompt` を持つとき（積んだ指示の改名とみられるとき）だけ見る。使用制限の合成の行（`error` が `rate_limit` で `quotaLimits` を持つもの）は、`quotaLimits.resetsAt` が数か、`quotaLimits.rateLimitType` が知っている枠（`five_hour`、`seven_day`、`seven_day_opus`、`seven_day_sonnet`）か | 知らない行は meta として残し、知らない塊は捨てる。リセットの時刻が読めない使用制限の行は使用制限として扱わず、知らない枠は枠の名前を出さない。記録する |
| レジストリ | `status` が busy、idle、waiting、shell のどれかか。`sessionId` と `pid` があるか。入力待ちの `waitingFor` が知っている値（`permission prompt`、`sandbox request`、`worker request`、`input needed`、`dialog open`、`goal proposal`）か | 知らない `status` は作業中として扱う。誤って止めるより待たせるほうが害が小さい。知らない `waitingFor` は許可待ちでない入力待ちとして扱う。配列や `null` の登録はその 1 件だけ読まない。記録する |
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
レジストリの `status` の欠けは、登録が書かれてから 5 秒を過ぎても欠けているときだけ記録する。
Claude Code は登録を `status` の無い形で書き始め、100 ミリ秒ほど後に足すので、その間に読んだ欠けは形のずれではないためである。
書かれた時刻は、登録の `startedAt` と、hangar が同じ登録（ファイル、`sessionId`、`pid` の組）で初めて欠けを見た時刻の早いほうにする。
読み取りの回数では数えない。見張りが混んで読み取りが詰まると、短い欠けを続けて何度も読むことがあるからである（2 回続けてで記録する作りが、2026-10-10 にこれで誤って記録し、アイドル時の自動停止を止めた）。

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
レジストリは周期で読み直す（作業中は 500 ミリ秒ごと）ので、ずれは登録が変わったときだけ数える。
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
API の要求の記録（`api-request` で始まる種類）は、システムプロンプト、環境、道具の定義がまるごと入るので、種類、会話、版、時刻だけにする。
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

hangar の tmux は、利用者の既定のサーバと分けた専用のサーバ（`tmux -L hangar`）で動かす。Windows の psmux も同じく `-L hangar` の名前空間を使う（2026-10-13 の利用者の決定）。
サーバの名前は `tmux/servers.ts` の `HANGAR_SOCKET` の 1 か所で決め、run とシェルタブの作成、見張り、止める、画面の読み取りと打鍵、UI の端末の attach、外のターミナルの attach、シェル連携の `claude.zsh` が、どれもこの名前を付けて tmux を呼ぶ。
利用者は `tmux -L hangar ls` で hangar のセッションを見られる。利用者の `~/.tmux.conf` は、専用のサーバが起きるときにも読まれる。
分けるのは、hangar がサーバ全体に入れる設定（`set-clipboard`、`copy-command`、`extended-keys`、`focus-events`、`terminal-features`、`S-Enter` の割り当て）を、利用者自身の tmux に及ぼさないためである。
サーバの全体の環境も、利用者が先に起こした既定のサーバのもの（Claude Code のセッションの印など）を継がなくなる。

0.6.0 より前の版は、利用者の既定のサーバに run を作っていた。
更新の時点でそこで動いていた run とシェルタブは、中断にせず、終わるまで既定のサーバで扱う。
どの画面が既定のサーバに居るかは、既定のサーバの一覧のうち hangar の名前（`hangar-<16 進>` と、その `-t<n>`）に当たるものから覚える（`MuxServers`）。
覚えるのはサーバのプロセスの中だけで、DB には列を足さない。`runs` は端末をまたいで同期する表なので、端末の中の事情を載せないためである。
hangar を再起動しても、同じ一覧から同じように覚え直せる。
一覧（生きているかの確かめ、起動の見回り、「前回実行中」の判定）は、専用のサーバのセッションに、既定のサーバに残った hangar の画面を合わせたものにする。利用者自身のセッションは入れない。
既定のサーバを読めなかったときは、古い run の生死が分からないので、一覧ごと「観測できない」として何も閉じない。
閉じる、画面を読む、打鍵を送る、attach は、その画面が居るサーバで行う。新しい run とシェルタブ（古い run に足すシェルタブも）は、必ず専用のサーバに作る。
既定のサーバに hangar の画面が 1 つも無いと分かったら、それからは既定のサーバを読まない。新しい画面は既定のサーバに作らないので、一度居なくなれば戻らない。
サーバ全体の設定は専用のサーバにだけ入れ、既定のサーバの古い画面へ attach するときも入れない（前の版が入れた値は残っている）。

起動コマンドの形は次のとおりである。

```sh
tmux -L hangar new-session -d -s hangar-<runShort> -c <cwd> -- \
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
中身は AskUserQuestion の前（`PreToolUse`）と後（`PostToolUse`、取り消しは `PostToolUseFailure`）の hook と、全部の道具の許可の確認（`PermissionRequest`、matcher は `*`）の hook で、hangar の台本 `~/.agent-hangar/bin/hangar-hook.mjs`（`launch/hookScript.ts`）をサーバ自身の node で起こす。
許可の確認の hook は、許可待ちの札と通知に、何の許可か（道具と命令）を出すために受け取る（「止まっている理由」の節）。裏で走り、何も出力しないので、許可するかどうかには加わらない。
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
起動コマンドの `env` は、Claude Code が子に立てる印（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ID` など。一覧は `provider/claude-code/compat/childEnv.ts`）と、サーバが読み終えた hangar の受け渡しの変数（`HANGAR_PORT`、`HANGAR_PARENT_PID`、`HANGAR_UI_DIST`、`HANGAR_STOP_ON_STDIN_END`、`HANGAR_LAUNCHER`）と `HANGAR_CLOUD_DIR`、`HANGAR_LAUNCHED` を `-u` で外す。
Windows は名前を包みへ `HANGAR_UNSET_ENV` で渡し、包みが消してから claude を起こす。
tmux の新しいセッションは、`PATH` のほかは tmux サーバの全体の環境を継ぐ（`PATH` は下に書くとおり起こした側の値になる）。tmux サーバを Claude Code のセッションの中から起こしていると、全体の環境に別のセッションの印が残る。
印を持って始まった claude は、そのセッションの子として振る舞う（再開の一覧と履歴から外れる、裏のセッションと見なす、別のセッションの名前やソケットを使う）。
2026-10-08 に、利用者の既定の tmux サーバでこの状態を見つけた。
`HANGAR_HOME` は外さない。statusline の台本と `hangar` の CLI が、claude の中で置き場を知るのに読む。
`HANGAR_PORT` は外す。statusline の台本はポートを書き込み時に埋め、MCP の設定はファイルに URL を持ち、CLI は `--port` で決めるので、claude の中で読むものは無く、残すと claude の中で起こした試しのサーバがアプリのポートを使おうとする。
利用者が立てる設定（`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_EFFORT_LEVEL`、`ANTHROPIC_*` など）は外さない。
シェルタブも、同じ名前を `env -u` で外してからログインシェルを起こす。Windows の PowerShell の前には `env` を置けないので、Windows のシェルタブは外さない。
hangar のセッションでは `tmux set-option -t <name> status off` でステータス行を隠す。
まだ信頼していないディレクトリで Claude を起動すると最初に信頼確認ダイアログが出るので、起動直後はターミナルを前面に出し、ダイアログが出ている旨を表示する。
クイックセッションの置き場と、同意を得た作業フォルダでは、hangar が前もって信頼済みにするので出ない（「フォルダの信頼」の節）。
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
最後に、殻が選んだ Node の置き場（`node.rs` の `choose_node` が採った `node` の親）も足す（`server.rs` の `augmented_path`）。
nvm、fnm、Homebrew の keg のように PATH に無い場所で見つけた Node でサーバを起こしても、ペインの claude が使う `node` や、npx で起こす MCP が `command not found` にならないようにするためである。
足すのはどれも後ろで、元の並びは変えない。
Windows で足すのは、この Node の置き場だけである。
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
綴りの違い（末尾の区切り、NFD）で一覧と当たらなかったときも、事前の問い合わせ（下）が登録済みと答えたら、そのプロジェクトを選ぶ。

未登録のフォルダか Finder で選んだフォルダを選んだら、ダイアログはそのフォルダの事前の問い合わせ（`folder.inspect`、`GET /api/workspace/inspect`）を頼む（0.6.1、試作の 6 と 7 の A）。
答えは Store の `folderInspect` に入り、最後に頼んだ 1 件だけを持つ。ダイアログはパスが選んだフォルダと同じ答えだけを使う。
答えを待つ間は起動できない。読めなかったときは、今までどおり登録して始める。

- 登録済みのプロジェクトの下（`enclosing`）：札を包むプロジェクトの名前にして、下のフォルダ（`packages/ui` など）を添え、札を淡い青にする。その場の 1 行で「agent-hangar の中のフォルダなので、agent-hangar のセッションとして packages/ui で始めます。」と言い、「別のプロジェクトにする」を添える。見出しは「新しいセッション」のままである。
  起動は `place` を付けず、`projectId` を包むプロジェクト、`cwd` を選んだフォルダにする（利用者の答え）。セッションは包むプロジェクトに入り、Claude Code はそのフォルダで起きる。札の値の前回値は包むプロジェクトのものを使う。
  「別のプロジェクトにする」を押すと、見出しを「フォルダを登録して始める」に戻し、1 行を「agent-hangar から分けて、別のプロジェクトとして登録します。いまある会話は agent-hangar に残り、これからの会話が分かれます。」と「agent-hangar のセッションにする」（戻す）に替える。起動は `place` に `allowNested: true` を付けて登録してから行う。
- ほかの PC から届いた同じプロジェクト（`link`）：札を結び付く先の名前にして「ほかの PC」の印を添え（場所を持つ PC が分かるときだけ）、札を淡い青にする。その場の 1 行で「work-pc の notes-app と同じリポジトリです。この PC の場所（~/src/notes-app）として結び付けて始めます。」（名前だけの一致は「同じ名前です」）と言い、「新しく作る」を添える。
  起動は `place` に `linkTo` を付けて登録（結び付け）してから行う。「新しく作る」を押すと、1 行を「work-pc の notes-app には結び付けず、新しいプロジェクトとして登録します。」と「notes-app に結び付ける」（戻す）に替え、`linkTo` を付けずに登録する。
  試作は新しいセッションのダイアログでも「別のプロジェクトにする」だったが、まとめて登録の行と同じ「新しく作る」にそろえた（押すと起きることは新しく作ることなので）。
- 切り替えは選んだフォルダごとに持ち、フォルダを選び直したら既定に戻る。包むプロジェクトの答えが結び付く候補より先である。

`cwd` は run の `launch_params` に残るが、画面の前回値（`launchPrefsOf`）には残さない（worktree と同じ）。
登録が 409（入れ子）で断られたとき（問い合わせの答えより先に送った場合）は、runtime が本文の包むプロジェクトを問い合わせの答えの代わりに `folderInspect` へ入れる（`store/folderInspect.ts` の `nestedInspect`）。ダイアログには上の 1 行と「別のプロジェクトにする」が出る。
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
前回値にモデルが無ければ、設定の既定のモデル（`defaultModel`。空は Claude Code の既定）をモデルの札の初期値にする（2026-10-13）。「既定に戻す」もモデルはそこへ戻す。
既定のモデルと同じモデルは前回値に残さない。残すと、既定のモデルを変えてもそのプロジェクトだけ古い既定に留まる。
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

- 欄の先頭か空白（改行を含む）の直後の `/` で、スキルとコマンドの候補を出す。語の途中の `/`（パスや URL）では出さない。自分のもの、選んだプロジェクトのもの、有効なプラグインのもの、組み込みのうち最初の一言になる 6 つ（`init`、`review`、`code-review`、`security-review`、`loop`、`schedule`）である。会話の途中でしか意味がないもの、端末の設定のもの、ダイアログの詳細に欄がある `model` と `effort`、`user-invocable: false` のスキルは出さない。
- 打つ前は、最初の一言になった回数の多い 5 つを「よく使う」として先頭に置き、続けて「このプロジェクト」「自分の」「プラグイン」「組み込み」の群で並べる。打ち始めたら群を解き、名前の頭の一致、途中の一致、説明の一致の順に並べる。
- 文の途中に置いた `/名前` も、先頭と同じ見せ方で入れる（利用者の決定、2026-10-15）。Claude Code が直に展開するのは先頭の `/名前` だけだが、途中のものは本文として渡り、Claude が Skill ツールで呼ぶ。2026-10-15 に実物の `claude -p`（opus-5-5）で、文の途中、改行の直後、文末の 5 通りとも、試験用のスキルが引数つきで起動したことを確かめた。起動は Claude の判断を通るので、先頭より確実さが一段下がる（引数を「使わない」と読める語にすると呼ばれなかった）。
- 日本語入力のまま打った `／` や `・` は拾わない（利用者の決定、2026-10-15）。`・` は箇条書きの頭に使うためである。日本語入力のときは「スキル」ボタンか英数で打つ。
- 道具の段の「スキル」と「ファイル」は、カーソルの位置に `/` か `@` を入れて候補を開く。前が空白でなければ空白を 1 つ挟む。カーソルがすでに同じ記号の語にあれば、文は変えずに候補を開き直す。
- `@` は欄の先頭か空白の直後で、選んだプロジェクトのファイルの候補を出す。打つ前は最近変えたファイル 20 件、打ったら一致するものを 50 件まで。スクラッチとパスの無いプロジェクトでは使えず、ボタンも押せない。
- `/` の候補は、その語に 2 つ目の `/` が入ったら出さない（貼ったパスの下に出しても邪魔なため）。確定はきっかけからカーソルまでを置き換え、カーソルの後ろの文は消さない。空白を含むファイルは `@"パス"` の形で入れる。
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
入力待ちのときに何を待っているか（登録の `waitingFor`）と、使用制限で止まっていることは、「止まっている理由」の節に書く。
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
プロンプト送信から busy まで約 0.5 秒、終了からファイルの消失まで約 0.4 秒で、見張りの知らせと、作業中の 500 ミリ秒間隔の監視で足りる。
`-n` や `/rename` で付けた名前は本文にも記録として残り（`agent-name`、`custom-title`）、再開やフォークの先にも引き継がれる。
hangar は名前を本文の記録から読み（索引が `sessions.custom_title` に拾う）、レジストリの値で上書きする。
tmux セッションが消えたら run を終了とみなし、`end_reason` を記録する。
tmux（Windows は psmux）の一覧は、run とタブの出入り、登録の変化、端末の中継の終わりの後 10 秒（`RUN_STIR_MS`）は 2 秒ごとに、それ以外は 10 秒ごとに読む（`RunManager.startPolling` と `stir`、2026-10-14、0.6.1）。一覧の読み取りは子プロセスを 1 つ起こすので、待機中は間を空ける。claude が終わると登録が変わるので、claude の終わりは今までどおり数秒で拾う。10 秒の周期が拾うのは、見ていないシェルタブの exit と、tmux のサーバごと落ちたことである。生きた run も開いたシェルタブも無ければ、一覧を読まない。ただし見回りが run を `exited` か `lost` で閉じた後の 10 分（`REVIVE_WATCH_MS`）は、下の生き返らせのために読み続ける。
止めにいっていない run は、一覧から 1 回抜けただけでは閉じず、続けて 2 回の見回り（`MISSES_TO_END`）で一覧に無かったときだけ閉じる（`RunManager.tick`、issue #258）。
Windows の psmux はセッションごとにサーバを持ち、一覧のたびに 1 つずつ問い合わせるので、CPU を使い切っているセッションの返事が遅れて、一覧からそれだけが一瞬抜けることがある。
抜けた回数は run ごとにメモリで数え、一覧に出たら 0 に戻す。
さらに、run の `pid` が生きていて（`platform/proc.ts` の `isAlive`）、Claude の登録にそのセッションがその pid で載っている間は、何度抜けても閉じない（`stillRunning`）。
pid だけで見ないのは、OS が pid を別のプロセスに使い回すと、永久に閉じなくなるためである。
登録を読む口が無い構成では、pid の生存だけで決める。
止めにいった run（`parked`）は、今までどおり 1 回抜けたらその場で閉じる。
閉じた run の tmux 名が後で一覧に戻ってきたら、同じ run として開き直す（`revive`）。見回り（`tick`）と起動の見回り（`recoverAtStartup`）の両方で行う。
選ぶのは、この端末の run で、同じ tmux 名、`exited` か `lost` で閉じ、そのセッションに生きた run が他に無く、セッションが消されていない、最も新しい行である。
`ended_at` と `end_reason` を空に戻し、`heartbeat_at` を今にして共有の行として書き直す（同期にも載る）。
起動と終了も共有の行として書く。
見回りの 30 秒ごとの `heartbeat_at` の書き直しだけは手元の `update` で、共有の `changes` に積まず、`updated_at` も変えない（同期の版 6）。
他の PC はこの PC の生存を `heartbeat_at` ではなく、Worker が見た最終接続で見るからである（「他端末セッションのロック」）。
画面には起動と同じ `run.started`（タブの一覧つき）を配り、開いているセッションの画面はターミナルにつなぎ直す。
中断の群に入っていたら、そこから外す（`forgetInterruption`）。
`killed` と `parked` は hangar が止めにいったものなので生き返らせない。
ほかの PC から止めてほしいと頼まれた run（取り下げられていない `takeovers` の `run_id`）と、ほかの PC が後から始めた run があるセッションの古い run も生き返らせない（終わった run も数える）。
引き継がれた会話を手元で開き直すと、二つの PC で同じ会話が動くためである。
閉じたときに MCP の設定と秘密は消しているので、生き返った claude からは hangar の MCP を使えない。秘密は作り直せないので、これは受け入れる。
ふつうは `exited` で、区切り（Done、Archived）を付けて止めたものは `parked`、利用者が止めたものは `killed`、ほかの PC から頼まれて止めたものは `taken_over` である。
自動の停止（`sessions/park.ts` の `ParkWatch`）は、Done か Archived を付けたセッションの休みが 10 秒続いたら Claude を止める。
Paused は止めない（2026-10-13 の決定。それまでは Paused も止めていた）。
戻ってくる会話なので Claude を残し、一覧でも実行中のまま数える（shared の `isParked` が Done と Archived だけを真にする）。
自動の停止は設定の `autoPark`（一般の節の「hangar が自分で行うこと」の「Done と Archived にした会話を停止する」、既定は入り）で切れる。
切っている間は `ParkWatch` が休みの一覧も読まずに何もせず、`SessionDto.parked` も偽にする（`db/queries.ts` の `setParkingSwitch` が DB ごとに設定を読む）。
止めないものを実行中から外すと、残っている Claude のターミナルへ戻れなくなるためである。
入り切りを変えたときは、動いている会話のうち Done か Archived の付いた行を名指しして配り直す（行は変わらないが、実行中に数えるかが変わる）。
hangar が動いている間に tmux のサーバごと消えたとき（一覧が空になり、止めにいっていない生きた run が 2 件以上まとめて消えた）は、利用者が終わらせたのではないので `lost` と書き、中断として拾う（「中断と再開」）。
この見分けは、run が一覧から抜け始めた見回りで行い、猶予を過ぎて閉じるときまで覚えておく。抜け始めた見回りで一覧が空で、同じ見回りで抜け始めた run が 2 件以上あれば `lost` にする。先に 1 件が自分で終わって抜け、その後に一覧が空になっても、まとめて消えたことにはしない。
1 件だけ消えたときは、最後の 1 本が終わって tmux のサーバも終わったのと見分けられないので `exited` のままにする。
一覧が読めないこと（tmux を呼べない、権限が無い）と、サーバが無いことは分ける。
サーバが無いのは、`no server running` と言うときと、つなぎ先のソケットが無いか応えないとき（`error connecting to … (No such file or directory)`、`(Connection refused)`）である。
OS を再起動するとソケットの置き場（`/tmp/tmux-<uid>/`）ごと消えるので、後者になる（2026-10-12 に VM の確かめで見つけた。それまでは観測できないと読み、再起動の後も run が実行中のまま残っていた）。
psmux はサーバが無いときに何も出さず exit 0 で終わるので、空の一覧になる。
hangar は生きた run ごとに、Claude の登録の最後の状態（busy、waiting、idle）を `run_last_live` に覚える。登録が変わるたびと起動のときに書き、run が終われば捨てる。

UI のターミナルは xterm.js で、サーバ側の node-pty が `tmux -L hangar attach -t =<tmux_name>`（前の版が既定のサーバに作ったものは `-L` なし）を実行して入出力を中継する。
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
  この設定はサーバ全体に効くので、hangar の専用のサーバ（`-L hangar`）にだけ入れる。0.6.0 より前は利用者の既定のサーバ全体に入れていた（2026-10-01 の利用者の決定）。
  WKWebView ではクリップボードへの書き込みに利用者の操作から 5 秒の枠があり、その外で届いた写しは捨てられる。
- 写すものが無い ⌘C は黙って捨てる。
  Claude Code（fullscreen）と tmux はドラッグを離した時点で自分で写し、xterm の選択は空のまま残る。
  そこで ⌘C を押すと、WebKit は xterm の隠れた入力欄に対して写す命令を走らせ、写すものが無いので macOS の警告音（NSBeep）を鳴らす。
  xterm の要素で `copy` を受け、xterm が自分の選択を写さなかった（`preventDefault` していない）ものだけ止める。
  Option を押しながら選んだ範囲は、これまでどおり ⌘C で写る。
- macOS の ⌘⌫ は Ctrl+U（行の頭まで消す）を送る。
  xterm は ⌘⌫ を素の Backspace として送り、1 文字しか消えないので、Terminal.app と iTerm2 の動きにそろえる。
- 日本語の変換中の文字は、ターミナルの右端で折り返し、続きを次の行の左端から出す（iTerm と同じ。試作 account-ime の 2A、2026-10-16 の利用者の決定）。
  xterm.js 6 の `.composition-view` は `white-space: nowrap` の 1 行の箱で、確定せずに長く打つと右端を超えて伸び、外の箱が横に送られて表示が崩れていた。
  xterm が置く left と top はそのまま使い、箱の幅をターミナルの幅（`.xterm-screen`）にし、`margin-left` で左端まで戻し、`text-indent` で 1 行目だけカーソルの位置まで字下げする（`runtime/compositionWrap.ts`）。
  箱を塗ると 1 行目のカーソルより左を隠すので、文字を 1 つの span に入れて span だけを塗る。xterm は 1 行分の高さを直に書くので、高さは CSS の `!important` で行の数に任せる。
  入力欄はターミナルの下の方にあるので、折り返した箱の下端がターミナル（`.xterm-screen`）の下端を超えるなら、超えた行の数だけ `margin-top` で箱を上へずらす（iTerm と同じ）。
  1 行目の字下げの位置関係は保ち、1 行目はカーソルの行より上に来てよい。
  xterm が置く top は書き換えないので、xterm が置き直しても、ずらしはその位置から計り直す。
  ターミナルの高さより行が多いときは、箱の下端をターミナルの下端に合わせ、末尾（いま打っている所）を見せる。
  知らせの順に頼らないよう、箱の変化を MutationObserver で見て当て直す。
  変換中にターミナルの幅や高さが変わったとき（窓や分割の変更）は、`.xterm-screen` を ResizeObserver で見て、変換中（`active` の組が付いている間）だけ当て直す。
  アプリはターミナルを捨てずに取っておき、別の画面へ移ると文書から外し、戻ると付け直す（`runtime/terminals.ts`）。
  そのため見張りは文書から外れても止めず、外れている間の ResizeObserver の知らせは何もしないで返す。
  見張りを止めるのはターミナルを捨てるとき（`runtime/xterm.ts` の dispose）だけである。
  以前は外れたときに見張りを外していたので、画面を行き来したあとの変換で幅と字下げが当たらず、変換中の文字が 1 字ずつ縦に並んでいた。
  xterm の内側に頼るのは、公開の CSS にもある 2 つの組の名前と、xterm が left、top、line-height を直に書くことと、変換中に `active` の組を付けることだけである。
  xterm は隠れた入力欄も箱の幅に合わせて伸ばすので、`.term-host` を `overflow: clip` にし、はみ出しで外の箱が横に送られないようにする。
- 端末に出たリンクは、修飾キー付きのクリック（macOS は ⌘、ほかは Ctrl）で既定のブラウザに開く（`runtime/terminalLinks.ts`）。
  素のクリックは今までどおり文字の選択とフォーカスに使う。macOS の Ctrl+クリックは右クリックなので使わない。
  地の文の URL は `@xterm/addon-web-links` で拾い、折り返しをまたぐ長い URL も 1 本として拾う（tmux を通しても、tmux が折り返しの印を付けて描き直すので切れない。2026-10-15 に tmux 3.6a で確かめた）。
  Claude Code が出す OSC 8 のハイパーリンクは xterm の `linkHandler` で受ける。
  開くのは http と https だけで、`file:` などは開かない。頁でも殻でも同じ線を引く。
  開く先は、デスクトップ版では殻の命令 `open_link`（`src-tauri/src/links.rs`。ログを開くのと同じく macOS は `/usr/bin/open`、Windows は `url.dll,FileProtocolHandler`）、ブラウザで開いた UI では新しいタブである。
  下線とポインタは、修飾キーを押している間だけ出す（試作 terminal-links の案 A、2026-10-15 の利用者の決定）。
  xterm は置いただけで下線とポインタを出すので、リンクの提供元を包み、提供するリンクの飾りを押し下げに合わせる。
  OSC 8 の提供元は xterm の組み込みで公開の API では差し替えられないので、xterm の内側の一覧（`_core._linkProviderService.linkProviders`）を包む。
  置き場が変われば包まずに xterm の既定の飾りに戻り、`views/xtermLinkProviders.test.ts` が落ちて知らせる。
  OSC 8 のリンクの文字には、置いていなくても xterm 自身が点線の下線を描く（xterm 6 はセルの属性で下線の種類を点線に固定する）。これは設定で消せないので残している。
  `mouse on` の tmux では、修飾キー付きのクリックも tmux へマウスの列として届く（素のクリックと同じ）。
  ⌘← と ⌘→ は hangar の「戻る」「進む」なので、行の頭と終わりへの移動には割り当てない。
- ⌘+ と ⌘− と ⌘0 はターミナルの文字の大きさを 1px ずつ変える（既定 13、8 から 32）。
  全部のタブに効かせて寸法を合わせ直し、大きさは localStorage に覚える。
  ターミナルが画面に無いときは受けず、ブラウザの拡大に渡す。
  セッション画面でも、終わったセッションの本文だけでターミナルが無ければ同じである。
複数のクライアントが同じ tmux セッションに attach してよい。

### 止まっている理由（許可待ちと使用制限）

0.5.0 で入れた（試作は scratchpad の stop-reason-proto で、利用者が「推す組み合わせ」を 2026-10-12 に了承した）。
並列で回していると、ツールの許可を求めたまま止まった会話と、使用制限で止まった会話を見落とす。
そこで、止まっている理由を状態の語に足し、どの画面でも見分けられるようにする（shared の `stopReason.ts` の `stopReasonOf`）。

| 理由 | 語 | 英語 | 印と色 | 数え方 |
| --- | --- | --- | --- | --- |
| 許可待ち（`permission`） | 許可待ち | Needs permission | 盾、入力待ちと同じ赤 | 要対応（入力待ちに含める） |
| 使用制限（`limit`） | 使用制限 | Usage limit | 砂時計、青みの灰（`--limit`） | 実行中（登録はアイドルなので） |
| リセット済み（`reset`） | リセット済み | Limit reset | 入力待ちの点 | 要対応 |

**許可待ち。**
Claude Code は、許可の画面を出した瞬間に登録へ `status: "waiting"` と `waitingFor: "permission prompt"` を書く（2.1.296 で確かめた）。
`waitingFor` は `permission prompt`、`sandbox request`、`worker request` を許可、`input needed` を問いとして読み、ほか（`dialog open` など）は許可でない入力待ちとする（`waitKindOf`）。
読み替えた値は、入力待ちの間だけ `LiveSessionDto.waitingFor` と `SessionDto.waitingFor` に載る。
Claude Code が AskUserQuestion にどの値を書くかは版で変わりうるので、問いの文が届いている（hook か本文の索引）か、許可の確認の道具が AskUserQuestion なら、問いとして扱う。
何の許可か（道具と命令）は登録に無く、hangar が起こした run の `PermissionRequest` の hook の `tool_name` と `tool_input` にだけある。
hook はサーバの手元に預け（`sessions/permissionAsks.ts`、DB にも同期にも載せない）、登録の読み直しのたびに入力待ちの登録へ `permission`（`{ tool, input, description }`）として足す。
`input` は命令、ファイルのパス、URL などの短い形で、Bash は命令の全文（2000 字まで）、`description` は Claude が書いた説明である。
待ちに入ったのを見た後に待ちを抜けたら忘れる。hook が登録より先に届いたときは、待ちに入るまで 30 秒まで残す。
許可でない待ち（`waitingFor` が `other`）には足さず、許可の待ちを見た後にそこへ移ったら忘れる。
許可した直後に Claude Code が別のダイアログ（既定の許可モードを尋ねるものなど）を出すと、登録は `waiting` のまま `waitingFor` だけが替わるので、待ちを抜けるのを待つと前の命令が残るためである。
問いの待ち（`question`）には AskUserQuestion の確認だけを足す。
現在の札も、許可でない待ちで最後の呼び出しにもう答えが出ていれば、その呼び出し（前の許可の命令）を「Claude の問い」として出さない。
現在の札が今のターンの呼び出しを拾うときは、ターンの頭の seq から後の行のほか、頭より前に並んでいても時刻が頭の時刻より後の行も含める（`presenters/live.ts` の `turnFilter`）。
API がすぐ返すと、Claude Code は呼び出しの行を、時刻の早い初めの発言の行より先に本文へ書くことがあり、seq だけで切ると許可待ちの間の手の行も、許可の後の「答えが出ているか」も見落とすためである（使用制限の行の `foldLimit` と同じ並びの入れ替わり）。
hook を持たない run（外部ターミナル）では中身が届かないので、「許可を待っています（内容はターミナルに表示されています）」と言う。
Notification の hook は約 6 秒遅れて決まった文言しか運ばないので使わない。

**使用制限。**
Claude Code は使用制限に当たると、本文に合成の assistant 行を書く（`error: "rate_limit"`、`quotaLimits.rateLimitType` と `quotaLimits.resetsAt`、時刻は秒）。
索引は主線の追記を畳むときにこの行を読み（`transcript/limit.ts` の `foldLimit`）、端末ローカルの表 `session_limits` に枠とリセットの時刻を書く。
`rateLimitType` は `five_hour` を 5 時間、`seven_day` で始まるものを週と言い、ほかは枠の名前を出さない。
同じ `rate_limit` でも `quotaLimits` を持たないもの（一時の混雑、組織の方針）は、待っても戻らないので使用制限としない。
Claude Code が自動の続きを予約すると、続けて system の informational の行（「Usage limit reached · continuing automatically at …」）を書くので、これを見て `auto` を立てる。
Esc で取り消すと「Automatic continue cancelled · /rate-limit-options to re-arm」（背面へ移したときなどは「Automatic continue cancelled · …」「Automatic continue was turned off · …」）を書くので、これを見て `auto` を下ろす（2.1.296 の実物の文）。
次の指示（自動の続きの指示も含む）、返答、ツールの呼び出しが載ったら行を消す。ターンの終わりや裏のタスクの知らせ（正規化では system）では消さない。
使用制限の行より時刻の前の行では消さない。初めの発言ですぐ 429 が返ると、Claude Code は使用制限の行を先に書き、時刻の早い発言の行を後から書くことがあるためである。
セッションが実行中から外れたときも消す（`sessions/liveChange.ts`）。再開した直後に前の run の使用制限を出さないためである。
`SessionDto.limit`（`{ kind, resetsAt, auto, reset }`）は実行中のときだけ値を持つ。
`reset` は、リセットの時刻から猶予を過ぎても続きが始まっていないことで、読むたびに時刻で決める。
猶予は 90 秒（`LIMIT_RESET_GRACE_MS`）で、自動で続く予約のある（`auto`）ものは 150 秒（`LIMIT_RESET_AUTO_GRACE_MS`）である。
Claude Code の自動の続きはリセットから 70 秒から 90 秒ほど遅れて始まる（2.1.296 の実測）ので、90 秒では自動で続くものにもリセット済みの通知が出て、すぐ外れるためである。
真なら要対応に数える（shared の `liveWithLimit`。休みを入力待ちとして数え、その後に `quietLive` を通す）。
自動で続くはずのものも、150 秒たって続いていなければリセット済みに移す。続かなかった事実の方を信じる。

**自動の停止との関係。**
区切りを付けたセッション（Done、Archived）でも、使用制限でリセットを待っている間（`reset` が偽の間）は止めない（shared の `isParked` の `limited`）。
止めると、Claude Code が予約した自動の続きごと消えるからである。
リセット済みになったら、ふだんどおり止める。

**画面。**
- サイドバー：点を盾（許可待ち）と砂時計（使用制限）に替える。右端は「許可待ち 1 分」、リセットの時刻（今日なら 16:50、ほかの日なら 10/15 09:00）、「リセット済み」。印は点と同じ 8px の箱の中央に描き、行の高さと並びは変えない。
- ホームの帯：許可待ちは要対応に、道具の札と命令（等幅）と説明を出し、ボタンは「ターミナルで許可」。使用制限は実行中の引き出しに砂時計で置き、「使用制限（5 時間）」「16:50 にリセット」「自動で続きます」を 1 行にし、右端にリセットまでの残りを出す。リセット済みは要対応に「使用制限がリセットされました。続きを指示してください」と出し、ボタンは「ターミナルで続ける」。内訳の文に許可待ちとリセット済みと使用制限の数を足す（0 件の理由は言わない）。
- 一覧：右端の語だけを「許可待ち」「使用制限 · 16:50」「リセット済み」に替え、2 段目の要約は変えない。
- 現在の札：状態の行を理由の語にし、問いと同じ場所に理由の欄を出す。許可待ちは「Claude が求めている許可 · Bash」、命令の全文（折り返す）、説明、答え方。使用制限は枠、リセットの時刻と残り、枠の時間のうち過ぎた割合の棒、自動で続くか。札の左の縁は使用制限で灰にする。
- 端末の縁：許可待ちとリセット済みは入力待ちと同じ赤、使用制限は灰の輪を静かに置く。
- 右下の札：許可待ちは見出しを「許可待ち」と盾にし、問いの場所に道具と命令を出す。使用制限は利用者にできることが無いので札にしない。リセット済みは札にする。
- パレット：入力待ちの群を「要対応」に改め、許可待ちとリセット済みも入れる。「次の入力待ちへ」も「次の要対応へ」にする（移る先の決め方は同じで、要対応の数え方に従う）。
- ヘッダー：使用制限で止まっているセッションがある枠のゲージを砂時計の色にし、% の代わりにリセットの時刻を出す。アカウントが 2 つ以上あれば、計器に出しているアカウントのものだけを数える。
  以前は「停止 N」の札を置いていたが、ホームの帯の実行中の行（リセットの時刻つき）と重なるので外した（2026-10-13 の決定、知らせの 9b）。
- 検索：`is:waiting` は今までどおり要対応の入力待ち全部（許可待ちとリセット済みを含む）で、`is:permission`（許可待ち）と `is:limited`（使用制限とリセット済み）を足す。

デスクトップ通知は「入力待ちの知らせ」の節に書く。
許可待ちは問いの文を待たずにすぐ出し、使用制限は当たったときにアカウントごとに 1 通、リセット済みは Active のものだけ 1 通出す。

### セッション内タブ

セッション画面のタブ 0 は Claude が動く tmux セッションである。
「＋」で追加する各タブは、同じ cwd で利用者のログインシェルを起こした独立の tmux セッション（`hangar-<runShort>-t<n>`）である。
tmux の window ではなく別セッションにするのは、同じ tmux セッションに複数のクライアントが attach すると「現在の window」を共有してしまい、ブラウザの 2 つのタブが互いに切り替わってしまうからである。
シェルタブは Claude が終了しても残り、明示的に閉じるか run を片付けるときに閉じる。
「ターミナルで開く」はタブ単位である。
既定は `tmux -L hangar attach` を書いた `.command` ファイルを `open -a Terminal` で開く経路で、AppleEvent を使わないため macOS の自動化許可が要らない。
ディレクトリを開くときは、`cd <dir> && exec "${SHELL:-/bin/zsh}" -l` を書いた `.command` を作り、Terminal.app にも iTerm2 にもその `.command` を実行させる（`open-<パスのハッシュ>.command`）。
iTerm2 を使う設定にしたときは AppleScript で新規ウィンドウを開く。初回に macOS の自動化許可ダイアログが出るので、Settings で有効化したときに一度だけ案内し、Tauri の Info.plist に `NSAppleEventsUsageDescription` を入れる。AppleScript には 10 秒のタイムアウトを付け、失敗したら Terminal.app の経路に落とす。
iTerm2 の `create window with default profile command` は、渡した文字列を語に割って起こすだけで、シェルを通さない。
`cd … && exec …` のような構文を直に渡すと、`cd` が実行ファイルとして起こされて窓ができない。
このとき osascript は終了コード 0 のまま標準出力に `missing value` を返す（成功は `window id N`）ので、これも失敗として Terminal.app に落とす。
Windows では、選べるターミナルが「Windows Terminal」と「既定のターミナル」の 2 つになる（`TerminalApp` の `windowsTerminal` と `windowsDefault`）。
設定画面は、画面を開いている OS の選択肢だけを同じ切り替えの部品に並べ、サーバも動いている OS の値だけを保存する。
別の OS で保存した値（macOS の iTerm2 を Windows で読んだときなど）は、読み込むときにその OS の既定（macOS は Terminal.app、Windows は Windows Terminal）に読み替える。
Windows Terminal は `wt.exe -w 0 new-tab --title <題名> --suppressApplicationTitle -- <psmux> -L hangar attach -t =<名前>` で、直近の窓の新しいタブ（窓が無ければ新しい窓）に開く。
wt は `;` を次のコマンドの区切りに読むので、引数の `;` は `\;` にして渡す。
`wt.exe` を起こせなければ、既定のターミナルに落とし、落ちたことを知らせる。
既定のターミナルは `cmd.exe /d /v:off /s /c "start "<題名>" "<psmux>" "-L" "hangar" attach -t "=<名前>""` で、Windows の設定の「既定のターミナル アプリ」の新しい窓に開く。
この 1 行は Node に引用させずにそのまま渡す（Node の `\"` は cmd.exe に通じない）。
cmd.exe は引用符の中でも `%name%` を置き換えるので、`%` だけは引用の外へ出して `^%` にする。
`"` と改行を含む名前とパスは、どちらの経路でも引用を破るので、開かずに断る。
題名を付けないと、タブも窓も起こした実行ファイル（psmux）のフルパスが題名になる。
題名はセッション名（シェルタブは名前の後ろに `(シェル 1)` のようなタブの題名を添える）で、80 字までに切り、`"` は `'` に、改行と制御文字は空白に潰す（名前は利用者が付けるので、断らない）。名前が無ければ tmux の名前にする。
ディレクトリを開くときは、Windows Terminal は `new-tab --title <題名> --suppressApplicationTitle -d <dir>` で既定のプロファイルを、既定のターミナルは `start "<題名>" /D "<dir>" powershell.exe -NoLogo` で PowerShell を開く（題名はフォルダ名）。
`wt.exe` と `cmd.exe` は、子が終わった時点で返す（`external/open.ts` の `execFile` の `untilExit`）。
`start` が開いた窓の中のもの（psmux の attach、PowerShell）は、子の出力の管を受け継いで握り続ける。
`execFile` は管がどれも閉じるまで返らないので、窓を閉じるか 30 秒のタイムアウトまで HTTP の応答が返らず、落ちた知らせも出なかった（rc.6 の Windows の実機で見つけた）。
殻の起こし役越しでも同じで、起こし役は子の終わりで降りるが、その管も窓に受け継がれるので、`untilExit` は起こし役の呼び出しへ渡す。
Windows でエディタ（`code.cmd` や `Code.exe` など）とブラウザ（`rundll32.exe` の `FileProtocolHandler`）を起こすときも、起こした窓が管を受け継ぎうるので、同じく `untilExit` で子の終わりに返す。
`.app`（Windows の殻）から起こしたサーバでは、ターミナルもエディタもブラウザも殻の起こし役越しに起こし、Hangar を閉じても開いた窓は残る（「Tauri のシェル」の節）。

### 指示の注入

hangar が起動するセッションには、`--append-system-prompt` で短い指示を渡す。
ファイルや設定は書かず、モデルや effort は現在の設定のままである。
指示の内容は次の要素からテンプレートで生成する。
プロジェクトのメモは渡さない。Claude Code は CLAUDE.md と自動メモリを自分で読むので、渡すと同じ役が二重になる（2026-10-11 にやめた）。

指示は 3 つの段に分け、辞書の 3 つの鍵に置く（`launch/injection.ts`、2026-10-13 の決定）。
常に足す段（`launch.injection.body`）、区切りの問いの段（`launch.injection.status`）、ターンの意図と短い手の説明の段（`launch.injection.live`）である。
後の 2 つは設定の `askStatusAtEnd` と `liveHints` で入り切りし、どちらも既定は入りである（鍵の無い古い設定も入りとして読む）。
`askStatusAtEnd` を切ると問いの段を足さず、状態は事後の要約の提案と自動の Done だけで付く。
`liveHints` を切るとターンの意図と手の説明を求めない。
`RunManager` は起動のたびに今の設定を読むので、切り替えは次に起こす claude から効き、動いている会話の指示は変わらない。
2 つのスイッチは、設定の「連携」の小節「hangar が起動する Claude Code に足すもの」に置く（試作 1 節の推す案 B）。
小節は、足すもの 3 つ（MCP の設定、入力待ちと許可を受け取る hook、システムプロンプトの追記）を行にし、前の 2 つは hangar の基本なので「常に」を添えて切れないものとして見せる。
スイッチと「足す指示の全文を見る」の畳みは、システムプロンプトの追記の行の中に字下げして置き、スイッチが追記の一部だけに効くことを形で見せる。
全文は、ここの 3 つの鍵を画面の言語で埋めたもの（`presenters/injection.ts`）で、段落ごとにどのスイッチのものかを添え、切った段落は打ち消し線で残す。
設定の画面はプロジェクトに属さないので、プロジェクト名、パス、TODO の一覧は値の代わりに印で見せる。
小節の最後に、既定のモデル（`defaultModel`）の行を置く（「新しいセッションのダイアログ」の節）。

`liveHints` を切ると、右パネルの現在の札は「まだ意図が届いていません」を出さず、そのターンの利用者の発言の冒頭を、意図と同じ場所に灰色の見出し「依頼 · 時刻」で出す（試作 2 節の推す案 A、`presenters/live.ts` の `stripIntent`）。
発言はターンの頭（`LiveDigestDto.turnStartSeq`）から後の最初の利用者の発言で、3 行で切る。
スラッシュコマンドは「/review 12」の形で、画像だけの発言は「（画像）」で出す。
切る前に起こした run がこのターンの意図を書いていれば、意図を先に出す。

常に足す段：

```
あなたは agent-hangar から起動されたセッションです。
プロジェクト：<name>（<path>）
未完の TODO：<最大 10 件、各行 - [<id>] <本文>。利用者がまだ受け入れていない Claude の提案は入れない>
過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。
依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、
set_session_summary で題名、2〜3 文の要約、進捗、次のステップを更新してください。
TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。
完了にするのは利用者です。確認できていないものは出さないでください。
```

区切りの問いの段（`askStatusAtEnd`）：

```
頼まれたことが明確に終わったときだけ、そのターンの終わりに AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <リマインダーの日付。時刻に意味があれば時刻も>（理由。何を確認しに戻るか）」「まだ続ける」です。
明確に終わったときとは、利用者が終わりを告げたとき（「ありがとう」「ここまで」「マージした」「今日はここまで」など）、頼まれたことが全部済んで次のステップが残っていないとき、利用者が外の出来事（CI、レビュー、明日の確認など）を待つと言ったときです。
一手が済んだだけのとき、質問に答えただけのとき、直しのやりとりの途中、利用者が次の指示を続けているとき、次のステップが残っているときは聞かないでください。迷ったら聞かないでください。
聞かないときは、set_session_summary の進捗を正直に書いてください。待ちが明らかなら、propose_session_status に confirmed なしで提案だけ出してください。
利用者が Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。
Paused のリマインダーの日付は return_on（YYYY-MM-DD）に、確認する時刻が決まっているときは return_time（HH:MM、手元の時刻）にも渡してください。時刻を note の文だけに書かないでください。
```

ターンの意図と短い手の説明の段（`liveHints`）：

```
ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。
Bash と Agent の description は日本語で短く（20 字程度）書いてください。
```

手の説明は、字数の上限（以前は「20 字以内」）ではなく目安で言う（英語は about 40 characters）。
2026-10-13 に緩めた。

#### PC をまたぐ会話の段（0.6.1）

同期を使って別の PC で進めた会話をこの PC で起こすとき、Claude は前の PC のパスとファイルの状態を前提に続けてしまう。
同期されるのはトランスクリプトと hangar の記録だけで、ファイル、git の作業ツリー、未コミットの変更、環境は運ばれない。
そこで、DB の事実だけで判定する 2 つの段を、常に足す段の直後に足す（`launch/injection.ts`、`runs/handover.ts`、2026-10-13 の決定）。
どちらもスイッチを持たず、同期を使わない人には条件が当たらないので出ない。

- 引き継ぎの段（`launch.injection.handover`）：起こす run の直前の run（`runs` を `started_at` の降順で 1 件）がほかの PC のもの、または run が無くて会話を作った PC（`home_device`）がほかの PC のとき。フォークは元の会話で判定する。この PC で 1 度動いた後は、直前の run がこの PC になるので出ない。
- 複数の PC の 1 文（`launch.injection.multiDevice`）：プロジェクトの場所の行（`project_roots`、`deleted_at` が null）が 2 台以上の PC にあるとき。抜けた PC（`devices` の行を消したもの）は数えない。未分類の会話には出さない。

引き継ぎの段に埋める事実は、前の PC の名前と OS、前の cwd（`sessions.cwd`）、この PC の名前と OS と起こす cwd、最後に動いた時刻（`last_activity_at`）、本文の末尾のブランチ（`git/hint.ts`）、その会話が編集したファイルのうちこの PC に無いものである。
無いファイルは、`event_index` の編集系のツールのパスを前の PC のプロジェクトの場所からの相対にし、この PC の場所の下で有無を見る。並べるのは 10 件までで、件数は全部を数える。どの場所の下でもないファイルは件数にだけ入れる。
前の PC の HEAD、未コミットの差分、ssh で届くかは hangar が知らないので、Claude に次の指示の前に 1 度だけ `git status` と `git log -1` と現在のブランチで確かめさせ、合わなければ推し量って作り直さずに AskUserQuestion で聞かせる。

```
この会話は <前の PC>（<OS>）で <最後に動いた時刻> まで進め、作業ディレクトリは <前の cwd> でした。いまは <この PC>（<OS>）の <cwd> で続けています。
同期されたのは会話のトランスクリプトと hangar の記録だけです。ファイル、git の作業ツリー、未コミットの変更、環境（インストール、環境変数、秘密）は同期されていません。
会話の中のパスは前の PC の形です。この PC では <cwd> からの相対パスで読み替え、前の PC の絶対パスをそのまま打たないでください。
会話の終わりのブランチは <ブランチ> でした。この会話で編集したファイル <件数> 件のうち、この PC に無いもの：<N 件と一覧、または（なし）>
次の指示を受けたら、作業に入る前に 1 度だけ、git status と git log -1 と現在のブランチを見て、会話の終わりの状態と合うかを短く報告してください。
無いファイルがある、ブランチやコミットが違う、前の PC に未コミットの変更が残っていたらしい、のどれかなら、推し量って再生成したり続けたりせず、AskUserQuestion で聞いてください。選択肢は「この PC で環境をそろえて続ける（足りないものを一緒に用意する）」「前の PC からファイルを持ってくる（手順を示す。実行するのは利用者）」「前の PC で続ける（この PC では何もしない）」「差を承知でこのまま進める」です。
ssh、scp、rsync は自分で打たないでください。1 度合っていると確認したものは、その後は疑わないでください。
```

```
このプロジェクトは <台数> 台の PC で使っています。過去の会話のパスやファイルの状態は、この PC と違うことがあります。
```

設定の「足す指示の全文を見る」には、この 2 段を基本の段の後に、名前の横の印「同期を使っているときだけ」を添えて並べる（`presenters/injection.ts`）。差し込む値は印で見せる。

MCP の URL はセッション別（`/mcp/s/<sessionId>`）なので、ツールは呼び出し元のセッションをサーバ側で確定できる。
モデルにセッション ID を扱わせる必要はない。

Paused の戻る時点は、日付（`return_on`、YYYY-MM-DD）と、任意の時刻（`return_time`、HH:MM）で持つ。
どちらも手元の暦と時計で読み、時刻が無ければ「その日のうち」として扱う。
日付も任意である（2026-10-13）。日付なしの Paused は、ホームの「今日戻る」とベルには出さず、一覧の Paused で見る。
画面のダイアログ、`PUT /api/sessions/:id/state`、`propose_session_status` のどれも、日付を省けば日付なしとして受ける。
時刻だけでは戻る時点にならないので、日付の無い時刻は断る（`session.status.returnTimeNeedsDate`）。
DB の列には、もともと日付を必須にする制約は無い（検査は `sessions/states.ts` の入口だけだった）。
Paused にするダイアログは、日のある札の頭に枠だけの「日付なし」（打鍵は 0、日のある札は今までどおり 1 から）を置き、選ぶと時刻の欄を押せなくする。
時刻を日付と別の列にしたのは、上げていない PC が同期で受け取ったときに、知らない列として捨てるだけで日付をそのまま読めるようにするためである。
`propose_session_status` は過去の時点を断り、返す状態にオフセット付きの `returnAt`（`2026-10-05T13:30+09:00`）を添えて、どのゾーンで読んだかを残す。
過去を断るのは MCP の入口だけで、画面からの確定と同期では断らない（時刻を過ぎた提案を確定でき、届いた行を弾かないため）。
持つ時点は 1 つだけである。同じ日に 2 回確かめたいときは、戻って resume したときに状態が外れ、区切りの問いで次の時点を入れる。
時刻つきの Paused は、時刻を過ぎてから「今日戻る」に出す（2026-10-13。それまでは朝から出していた）。時刻の前は、一覧の行の時刻の列に塗らない札（「今日 10:00」）が出るだけで、帯の要対応には数えない。日付だけの Paused は、今までどおりその日の朝から出す。同じ日の中は時刻の早い順で、時刻なしはその日の最後に並べる（`presenters/row.ts` の `returnHasCome`）。
Paused は自動で止めない（#206）ので、戻る時点が来たときに Claude Code が休みのまま生きていることがある。そのときは帯の実行中から外し、今日戻るに出す（`presenters/home.ts` の `returnsNow`）。作業中のもの（裏の作業だけが動いているものを含む）は実行中に、入力待ちは要対応の入力待ちに残し、今日戻るには重ねない。
時刻を過ぎたら、通知を受け取る設定で窓が背面なら OS の通知を 1 回出す。この通知は、同じセッションの入力待ちの通知とは別の枠に入れる（「入力待ちの知らせ」の節）。右下の札は出さない。ヘッダーの注意には入れない。今日戻るの行はホームの帯（要対応）にある（「注意と知らせの出し分け」の節）。OS の通知で知らせ終えた時点は localStorage に覚える（画面の時計で見るので、hangar を開いていない間は出ない。開いたときに、その日に過ぎた分を 1 回知らせる）。
日付だけの Paused は知らせない。

状態の問いは、頼まれたことが明確に終わったときだけ AskUserQuestion で聞かせる。利用者が選んだものは `propose_session_status` の `confirmed: true` でそのまま状態になり、答えずに進めたものは候補として残る。
以前は「頼まれたことを終えたと判断したターン」で聞かせていたが、聞く場面を明確に終わったときに絞った（2026-10-13 の決定）。
聞くのは、利用者が終わりを告げたとき、頼まれたことが全部済んで次のステップが残っていないとき、利用者が外の出来事を待つと言ったときの 3 つだけで、迷ったら聞かない。
聞かないときは要約の進捗を正直に書かせ、待ちが明らかなら確定なしの提案だけを出させる。
この指示は hangar が `--append-system-prompt` で起こす会話に渡る。ターミナルで claude.zsh から起動した claude も hangar の run になるので、同じ指示を受け取る。
`claude attach` で開く会話（attach、バックグラウンドのセッションの再開）には渡らないので、そちらは事後の要約で拾う。

止まったのに状態が無いセッションは、次のどれかに当たれば hangar が自動で Done にする（`sessions/autoDone.ts`、2026-10-11 の決定、長く動いていないものは 2026-10-15 に足した）。
Active を「続きがあるもの」に保つためで、誰も片付けないセッション（`claude -p` や試験の使い捨て、要約は完了なのに問いに答えずに閉じた会話）が Active に溜まるのを止める。

- 使い捨て：hangar の run が一度も無く、3 ターン以下。
- 要約が完了：会話の中か事後の要約の進捗が「完了」か「中止」。土台の要約は止まっていれば「完了」と書くので数えない。
- 長く動いていない：最後に動いてから設定の日数（`autoDoneIdleDays`、3・7・14・30 日か 0＝しない、既定 7）たったもの。ターン数や要約、run には関係しない。
  外で起こした長い会話は要約が回らないと上の 2 つに当たらず、hangar を入れる前の履歴も全部 Active のまま残るためである（新しく入れた PC で、過去の会話が Active に何十件も溜まった）。最後に動いた時刻が分からないものは数えない。

対象は、この端末で動いたもの（`home_device`）で、Claude の登録に無く、どの端末の run も生きていないものである。
Paused の提案があるもの、却下したもの、「Active に戻す」の後に動きが無いもの、要約を待っているものは除く。
15 秒ごとに見回り、60 秒続けて対象だったものだけを書く。再起動や「hangar に移動」で一瞬止まって見えるものを拾わないためである。
`set_by` は `import`（利用者が決めたものではない）にする。新しい値を足すと、上げていない PC が同期で受け取った行を CHECK で弾くためである。
画面では、`set_by` が `import` の Done を自動で付いたものとして見分ける（2026-10-13 の利用者の決定、4a）。
一覧の行とセッション画面の冒頭の札で、Done の札の頭に ✦ を置き、枠を点線にする。理由は札のツールチップで言う（`presenters/row.ts` の `statusMark`）。
理由は残していないので、手元の事実から読み直す。提案の理由を持つものは放っておかれた Done の提案を確定したもの、3 ターン以下なら使い捨て、要約が「完了」か「中止」なら要約で決めたもの、付けた時点で最後の動きから 3 日以上たっていれば長く動いていなかったもの（その日数を言う）で、どれでもなければ自動で付いたことだけを言う。
resume した後に発言すれば、手で付けた Done と同じく外れる。

状態の札（Active、Paused、Done、Archived）は日本語版でも英語のままにし、日本語の説明（用語集の「札の説明」）をツールチップで添える。会話で利用者が選んだものは「会話で承認」を足す。
hangar の外で起こした 4 ターン以上のものは、止まったときに事後要約を回す（hangar の run は終わったときに回る）。回すのは、サーバが起きてから止まったものだけで、入れたばかりの利用者の過去の全履歴には回さない。
自動の Done は設定の `autoDone`（一般の節の「hangar が自分で行うこと」の「止まった会話を自動で Done にする」、既定は入り）で切れる。
切っている間は、候補も引かず、Done にせず、そのための事後要約も回さない（使用量を食わないため）。入れ直したら、60 秒の数えを最初からやり直す。
長く動いていないものの日数は、そのすぐ下の「長く動きの無い会話も Done にする」の行で選ぶ（試作の案 A）。上のスイッチを切っている間は選べない。

### 再開とフォーク

過去のセッションは「再開」と「フォーク」を持つ。
再開は同じ cwd で `claude -r <uuid>` を tmux 上で実行し、`kind = 'resume'` の run を作る。
フォークは `claude -r <uuid> --fork-session --session-id <新 uuid>` で、新しいセッション行と `kind = 'fork'` の run を作る。
同じセッションに生きた run があるときは、再開を無効にする。

hangar では終わった扱いなのに、その会話の claude がまだ動いていることがある（見回りの読み違いで閉じたとき、issue #258）。
このまま再開すると、2 つの claude が同じ会話を同時に進め、本文が混ざる。
そこで再開の前に、次をすべて満たすかを見る（`RunManager.strayPid`）。
Claude の登録に載っていれば「hangar の外で実行中」（`run.error.runningOutside`）で断る。ただし、載っている pid がその最も新しい終わった扱いの run の pid と同じなら、外ではなく見失った自分の claude なので、この確認を先に出す（issue #258 の場面そのもの）。止めた後も登録はしばらく残りうるので、「停止せずに再開」と止めた後の再開は、その登録で断らない。

- そのセッションのこの端末の run のうち最も新しいものが、`exited` か `lost` で終わっている。
- その run の `pid` が生きている（`platform/proc.ts` の `isAlive`）。
- そのプロセスの起動時刻（`startTimeOf` と `parseStartTime`）が、run の `started_at` の 60 秒前（`STRAY_SLACK_MS`）から `ended_at` までの間にある。

起動時刻で絞るのは、pid の使い回しで関係の無いプロセスを止めないためである。起動時刻が読めなければ、同じ claude とは言えないので見逃す。
当たったら、`POST /api/sessions/:id/resume` は pid を添えた 409（`{ error, code: 'stray_process', pid }`、文は `run.error.strayProcess`）で断る。
画面はこれを確認のダイアログにする（試作の案 A）。ふだんの見た目は変えず、押したときだけ出す。
選び方は 2 つで、選んだものを要求の本文の `stray` で送り直す（`RunManager.resumeWith`）。

- 「停止して再開」（`stray: 'stop'`、推す方）は、その claude を `terminate` で止め、止まったのを確かめてから再開する。止められなければ `run.error.strayNotStopped` の 409 で断り、再開しない。
- 「停止せずに再開」（`stray: 'ignore'`）は、この判定を飛ばして再開する。

まとめて再開（中断の群）の 1 本で断られたときは、行に理由を残したうえで同じ確認を出し、選んだら選び方を添えて順番待ちに入れ直す。
フォークは新しい会話になるので、この判定をしない。

前の cwd（`sessions.cwd`）がこの PC に無いときは、この PC のプロジェクトの場所に読み替える（`runs/handover.ts` の `resumeCwd`、0.6.1）。
前の PC のプロジェクトの場所（その PC の `project_roots` の行）からの相対パスを、この PC の場所に継ぐ。worktree や下位のフォルダも継ぎ、継いだ先が無ければいちばん近いある親（場所まで）に倒す。
前の cwd がどの PC の場所の下にも無ければ、この PC の場所にする。Windows の形のパスは `/` と `\` のどちらの区切りでも読み、大文字と小文字を区別しない。
共有の行の `sessions.cwd` は書き換えない。フォークは読み替えた cwd で新しい行を作る（フォークの本文はその cwd の置き場に生まれる）。
プロジェクトに属する会話で、この PC に場所が無い（行が無い、見つからない、フォルダが無い）ときは、起こす前に「プロジェクトのディレクトリがこの PC で見つかりません」で断る。プロジェクトに属さない会話は今までどおり `sessions.cwd` で起こし、無ければ断る。
Claude Code 2.1 の `claude -r <uuid>` は、cwd が前と違っても、どのプロジェクトの置き場（`projects/<変換名>/`）にある本文でも見つけ、その本文に書き足す（2026-10-13 に、偽の API と使い捨ての `CLAUDE_CONFIG_DIR` で、`-p` と対話の両方を確かめた。Windows の形の置き場の名前でも見つけた）。フォークの本文は新しい cwd の置き場にできる。そのため、本文の写しの置き場（`sync/copy.ts`）は前の cwd の変換名のままにしてある。

#### 中断と再開

中断は、利用者が止めたのではなく、PC の再起動や tmux のサーバの停止で Claude が終わったことである（`end_reason = 'lost'`）。
起動の見回り（`recoverAtStartup`）で tmux のセッションが無かった run と、hangar が動いている間に tmux のサーバごと消えた run を、1 つの束として端末ローカルの `interrupted_runs` に記録する（`runs/interrupted.ts`）。
止まる前の状態は `run_last_live` から写す。
束が空なら前の群を残し、新しい束は前の群を置き換える（前の群の行は、一覧の「中断」の印としてだけ残る）。
群（`InterruptedDto`）は bootstrap と `interrupted.update` で画面へ渡す。
群から外すのは、「再開しない」と決めた行（`POST /api/interrupted/dismiss`、取り消しも同じ経路）、その後に起こし直したセッション（最後の run がこの run でない）、消したセッションである。
ステータス（Paused、Done、Archived）を付けたものと、いま実行中のものは、画面の側で外す（`session.upsert` で変わるので）。
日数では消さない。朝に開く群にするのは、記録してから 24 時間までである。
`SessionDto.interrupted` は、ステータスの無いセッションで最後の run が lost のときだけ値を持ち（閉じた時刻と、この PC が記録していれば原因）、一覧の行と、終わった画面の見出しの下の 1 行が読む。

まとめて再開は、Mediator の順番待ち（`mediator/interrupted.ts`）で、既存の再開（`POST /api/sessions/:id/resume`）を同時に 2 本まで呼ぶ。
並びは止まる前に作業中だったもの、入力待ち、アイドルの順で、同じなら最後に動いた新しい順である。
画面は移さず、起きたものは帯の「実行中」へ移る。断られたものは理由を行に残し、次へ進む。
1 本ずつの「再開」と「再試行」も同じ順番待ちに入る。「残りをキャンセル」は順番待ちだけを外す（頼みかけたものは止めない）。
再開は会話を開き直すだけで、途中の作業を自動では続けない。
tmux（psmux）が無いと分かっているときは、ほかの起動と同じく案内のダイアログ（`muxGuide`）で止める。
アカウントは、そのセッションを最後に動かしたもので起こす（`accountOfSession`）。未ログインのアカウントの行は押せない形にし、「すべて再開」はその行を飛ばす。使用率が高いアカウントは見出しで言うだけで、止めない。

#### 同じファイルの編集の警告

実行中の 2 本のセッションが同じファイルを編集しているとき、止めずに知らせる（0.5.0、`sessions/overlap.ts`）。
見張り（`OverlapWatch`）は 3 秒ごとに、実行中のセッション（Claude の登録にあるもの）の索引（`event_index`）から、直近 20 分の編集系の呼び出し（Edit、Write、MultiEdit、NotebookEdit。サブエージェントの編集も含む）を読む。
パスは NFC にそろえる。`event_index` のパスは絶対パスなので、worktree を切った 2 本はパスが違い、重ならない。
重なりとみるのは、2 本が間を 10 分以内に空けて同じパスを編集し、そのうえで次のどちらかに当たるときである。
1 つは交互に書いたこと（先の側が、後の側の後にまた書いた）。
もう 1 つは、後の側が書いた時点で先の側がまだターンの途中（作業中か入力待ち）だったこと。
先の側がターンを終えてから後の側が直しただけなら、人が順に頼んだとみて出さない。
ターンの途中だったかは、Claude の登録の状態の移り変わりを見張りが覚えて決める。サーバが起きる前の分は分からないので、途中ではないとみる。
消えるのは、重なりを作った最後の編集から 10 分経ったとき、どちらかが実行中でなくなったとき、「このファイルでは表示しない」にしたとき（`overlap_dismissals`、組の向きによらない）である。
Bash で書き換えた分は索引にパスが無いので拾えず、中身の面の注記でその旨を言う。
写しは `session_overlaps` に書き、変わったセッションを名指しして配る（`SessionDto.overlap`、実行中のときだけ値を持つ）。
画面はホームの実行中の行の札と錠剤の点、現在の札の 1 節、サイドバーの行の印で言い、どれも同じ中身の面（`views/OverlapPopover.tsx`）を開く。
面は相手（押すとそのセッションへ）、ファイルと最後に編集した時刻（交互なら印）、注記、「並べて実行するときは、worktree を使うと互いの変更を上書きしません」と「worktree で新しいセッション」（そのプロジェクトで、worktree の札に新しい名前を入れたダイアログを開く。動いている 2 本には触らない）、「このファイルでは表示しない」「閉じる」である。

### スクラッチと昇格

リポジトリ名を決める前に使い捨てのセッションを回したい、という用途のために **スクラッチ** を用意する。
画面では「クイックセッション」と呼び、コードと DB では scratch と呼ぶ。
「クイックセッションを開始」は `~/.agent-hangar/quick-sessions/<yyyymmdd-HHmmss>/` を作り、そこを cwd にセッションを起動する。
起動ダイアログのプロジェクトの一覧は、先頭の「クイックスタート」の群にクイックセッション（スクラッチ）の行を置く。何も選ばなければ、この行を選んだことになる。
⌘⇧N、パレット、スクラッチのプロジェクト画面は、この行を選んだ状態でダイアログを開く。
スクラッチの詳細の前回値は、どのスクラッチのディレクトリでも共通の 1 枠に持つ。
スクラッチのセッションは `is_scratch = 1` の擬似プロジェクトに属する。
DB の名前（`スクラッチ`）は内部のもので、画面は辞書の名前（`project.name.quick`）で出す（`presenters/projectName.ts`）。起動時に注入する指示のプロジェクト名も辞書の名前にする。

この擬似プロジェクトは、同期するすべての PC で 1 つである（2026-10-16 に、PC ごとに 1 つから改めた）。
各 PC の置き場は、その PC の `project_roots` の行（`~/.agent-hangar/quick-sessions`）である。
`ensureScratchProject`（`projects/scratch.ts`）が起動のたびに次を冪等に行う。
同期でスクラッチのプロジェクトかその場所の行が届いたときも、取り込みの後に 1 回行う（`followRemoteScratch`）。前の版の PC が新しく作ったスクラッチのプロジェクトを、次の起動を待たずにまとめるためである。
ただし前の版の PC は、自分の場所の行が残っていればプロジェクトの行を書かないので、その PC で始めた会話の行（sessions）だけが届いても、ここではまとめ直さない。その会話は新しい版の PC が次に起動したときにまとめ先へ移る。画面はスクラッチのプロジェクトをまたいで会話を集めるので、その間も見え方は変わらない。

- まとめ先は、消していないスクラッチのプロジェクトのうち id の最も小さいものにする。id は uuidv7 なので、作った日時の古いもの（同じなら id の小さいもの）になり、どの PC でも同じ先を選ぶ。
- ほかのスクラッチのプロジェクトの会話、TODO、成果物、メモをまとめ先へ移す（`projects/contents.ts` の `moveProjectContents`、プロジェクトをまとめるときと同じもの）。状態は会話に付くので引き継がれる。
  利用者が移した先（`session_states.project_id`）がまとめる元を指していれば、まとめ先へ付け替える。
- 場所の行は、この PC の行だけを動かす。まとめ先にこの PC の行を置き（無ければ作り、消してあれば戻す）、場所を `quick-sessions` にそろえ、ほかのスクラッチのプロジェクトに残ったこの PC の行は消す。
  ほかの PC の行に触らないのは、同じ PC の行を 2 台が別々に作ると `(project_id, device_id)` の一意の制約が同期でぶつかるからである。
- 中身を移した方は、場所の行が残っていなければ消す。ほかの PC の行が残っていれば、その PC が新しい版で起きて自分の行を外すまで消さずに置く。前の版の PC は自分の行が消えたプロジェクトを見つけられず、新しいスクラッチのプロジェクトを作り直すからである。
- 移すものが無ければ何も書かず、まとめ先の行の変化も知らせない。前の版の PC の行が残る間も、起動や取り込みのたびに同期の変更を出さない。

既存の利用者に齟齬を出さないために、前の置き場 `~/.agent-hangar/scratch` は動かさず、消さない。
その下の会話は cwd もそのままで、いままでどおり再開できる。
クイックセッションの置き場かどうかは、`~/.agent-hangar/quick-sessions` と `~/.agent-hangar/scratch` の 2 つの完全なパスで判定する（`isUnderScratch`）。
場所の行から判定するところ（振り分けの `resolvedRoots`、`SessionDto.fromScratch`）は、場所が `<hangar のホーム>/quick-sessions` なら同じホームの `scratch` も同じ置き場として扱う（`scratchPlacesOf`）。
利用者が自分で作った `scratch` という名前のフォルダ（`~/workspace/scratch` など）は、名前ではなくパスで見るので取り違えない。

ほかの PC のクイックセッションを再開するとき、cwd がこの PC に無ければ、この PC の `quick-sessions/<元のフォルダ名>` を作ってそこで再開する（`runs/handover.ts` の `resumeTarget`）。
クイックセッションとして読み替えるかは、所属ではなく cwd で決める。cwd がどれかの PC の置き場（2 つとも）の下にあるときだけである。ほかのプロジェクトへ移した会話も、クイックセッションへ移した普通の会話もあるからである。
クイックセッションへ移した普通の会話は、普通の読み替え（「セッションを別のプロジェクトへ移す」の、cwd を含むいちばん深いプロジェクトの場所）になる。
元のフォルダ名は、その置き場の直下の段で、/ と \ のどちらの区切りでも取り出す。
Windows で使えない文字（`<>:"/\|?*` と制御文字）と、末尾の点と空白は `_` に置き換える。
置き場の外の cwd と、置き場そのものの cwd（直下の段が無い）と、段が `.`、`..`、ドライブ文字だけ（`C:`）のものは、フォルダを作らずに「場所が無い」で断る。
置き場の外の cwd をプロジェクトの場所に倒すとき、その場所がクイックセッションの置き場そのものなら、同じく断る。
同名のフォルダがあれば、それを使う（A → B → A と戻ったときなど）。
フォルダを作るのは起動の直前で、アカウント、バックグラウンドの一覧、起動の確かめ（claude と tmux、`RunManager.precheck`）が通った後である。どれかで断ったときに空のフォルダを残さない。
作ったフォルダに、起動の前にフォルダの信頼を書く（次の節）。
本文を写す前の確かめ（`resumeCwdOf`）と確認の 1 枚の見積もりでは作らない。
「この PC で再開」の確認は、「この PC」の欄に作って再開するフォルダのパスを出し、その下に「クイックセッションの置き場に同名の空フォルダを作成して再開します」を添える（`ResumeHerePlanDto.to.createsFolder`、試作の 6A）。場所の指定は求めない。

#### フォルダの信頼

Claude Code は、まだ信頼していないフォルダで起動すると「このフォルダを信頼しますか」と尋ねる。
答えは user スコープの設定（`CLAUDE_CONFIG_DIR` があればその下、無ければホームの直下の `.claude.json`）の `projects.<path>.hasTrustDialogAccepted` に残る。
2.1.301 で、一時の `CLAUDE_CONFIG_DIR` と一時のフォルダで実物の claude を起こして、次を確かめた（2026-10-16、配布物の判定のコードとも合う）。

- 作業フォルダから上へ親をたどり、どれかの行が true なら尋ねない。子と孫は親の信頼で通る。子の行に false が書いてあっても、親の true が効く（claude は起動のたびに子の行を false で作るが、それで尋ねるようにはならない）。
- 名前が前方一致するだけの隣のフォルダ（`parent2`）には及ばない。
- git のリポジトリの中では、たどるのはリポジトリの根までである。リポジトリの外の親を信頼しても、リポジトリの根とその下には及ばない。
- 鍵は実体のパス（getcwd の形）で、Windows でも / 区切りで書く。

hangar は、次の置き場で claude を起こす直前に、起こすアカウントの `.claude.json` へ信頼を書いておく（`RunManager.launch` が呼ぶ `trustFolder`、`projects/folderTrust.ts` の `trustBeforeLaunch`）。
書く先は起動の環境で決める。`CLAUDE_CONFIG_DIR` を付けない最初のアカウントはホームの直下、ほかのアカウント（大学の `~/.claude-univ` など）と、ターミナルで利用者が自分で付けた置き場は、その下の `.claude.json` である。

- クイックセッションの置き場（`~/.agent-hangar/quick-sessions` と前の `scratch`）は、いつも信頼済みにする（利用者の決定）。
- 作業フォルダは、利用者が同意したときだけ信頼済みにする（下の `--trust`）。

書くのは置き場そのものと、作業フォルダが置き場の下の git のリポジトリの中なら、いちばん近いリポジトリの根である（`launchTrustDirs`）。
リポジトリが入れ子なら、作業フォルダからいちばん近い根だけを書く。
置き場の下のふつうのフォルダは親の信頼で通るので、1 つずつは書かない。クイックセッションのフォルダも、ほかの PC の再開で作るフォルダも同じである。
作業フォルダと置き場は、リンクを実体まで解いてから比べる。claude は getcwd の実体で信頼を引くので、置き場の下のリンクが置き場の外のリポジトリを指していれば、その実体は置き場の外として書かない。置き場そのものがリンクなら、実体の置き場の下として扱う。
書き方は MCP の登録と同じ守り（ロック、リンクの実体、権限、控え）に従い（`provider/claude-code/config/claudeJson.ts` の `trustFolders`）、同じ行のほかの項目とほかの鍵には触らない。
全部すでに信頼済みなら書かず、控えも取らない（起動のたびに控えが溜まらない）。読み直したら書き足すものが無くなっていたとき（割り込みで Claude Code が書いた）も、書かず、取った控えを消す。
控えは `~/.agent-hangar/backups/claude.json-trust-<時刻>` の名前で取り、新しいものから 5 つだけ残して古いものを消す。MCP の登録の控え（`claude.json-<時刻>`）には触らない。
設定ファイルが無い置き場（まだ一度も claude を起こしていないアカウント）には作らない。登録しただけで置き場のフォルダがまだ無いアカウントも同じく、書かずに「設定ファイルが無い」として返す。Claude Code の初回の流れより先にファイルを置かないためで、そのときは claude がいつもどおり尋ねる。
書けなくても（ロックが取れない、JSON が壊れているなど）起動は止めない。

作業フォルダの信頼は、セットアップのすゝめが利用者の同意を取ってから `hangar workspace set <dir> --trust` で頼む（`POST /api/workspace/trust`）。
サーバは同意を設定（`trustedWorkspaceRoot`）に残し、作業フォルダそのものと直下の git のリポジトリを、登録したアカウントの全部の `.claude.json` に書く（`trustWorkspaceFolders`）。
後から作業フォルダの下に置いたリポジトリ（新しいプロジェクトのダイアログで `git init` したもの、利用者が clone したもの）は、同意が残っているので、hangar から起こすときに上の `trustBeforeLaunch` が信頼済みにする。
同意は、同意した作業フォルダがいまの作業フォルダと同じときだけ効く（`trustedWorkspaceOf`）。作業フォルダを変えるか空にすると、設定の保存が同意を消す。すでに書いた信頼は Claude Code の設定に残る。
本番の頼みはいまの作業フォルダだけを受ける。試し（`dryRun`）は、作業フォルダを保存する前の見せ方にも使うので、まだ作業フォルダにしていない場所も受け、何も書かず同意も残さない。
ホームそのもの、ホームより上、ファイルシステムの根は、試しでも本番でも断る。CLI の `hangar workspace set` と同じ規則（`platform/paths.ts` の `coversHome`）で、ここを信頼するとホームの下が全部信頼済みになるからである。
同意は、書き込みが全部失敗しても残す。以後の起動で、起こすアカウントの設定に書くからである。返事には同意を残したこと（`consentRecorded`）と、そのことを言う 1 文（`note`、「同意は記録しました。次の書き込みは起動のときに行います」の趣旨）を載せ、CLI も同じことを出す。失敗の行と exit 1 だけを見て、同意も取り消されたと読まれないようにするためである。
同意を取り下げるには、`hangar workspace unset` で作業フォルダを空にするか、作業フォルダを別の場所に変える。以後、hangar はその場所に信頼を書かない。すでに `.claude.json` に書いた信頼は残るので、消したいときは利用者が Claude Code の設定から外す。
新しいセッションのダイアログの信頼確認の注意（`newSession.note.trust`）は、クイックセッションでは出さない。

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
- **事後生成**：run 終了時に要約が土台のままか、事後の要約の最後の更新から 5 ターン以上進んでいれば、要約器で作り直す。セッションを開いたときも同じ条件で作る。`source = 'post_hoc'`。
  会話の中で書いた要約（`in_session`）は、何ターン進んでも事後の要約で上書きしない（`isSummaryStale`、2026-10-13 の決定）。
  文脈を持つセッション自身が書いたもののほうが確かだからである。
  手動の作り直し（`force`）だけは、この判定を通らないので上書きできる。

事後生成のスキーマは、要約に加えてセッションの状態の提案（`proposed_status` が done・paused・none、`proposed_note`、`proposed_return_in_days` が paused のとき 1〜14）を返させる。
提案は、要約を書いた直後に、状態も提案も無く、却下もされておらず、セッションが止まっているときだけ `source = 'post_hoc'` の候補として書く。戻る日は書いたときの手元の暦から数える。
読み取りは提案の 3 つを任意として扱い、返さないモデルでも要約は従来どおり書く。

要約には、どの経路で作ったか（`source`）に加えて、どの要約器が書いたか（`source_id`）とそのモデルの名前（`source_model`）を持つ。
土台とセッション自身の要約は要約器を通さないので、どちらも持たない。
`source_id` が無かった頃の行は、種類を推し量らずに「不明」と出す。

過去の全件を背景で埋めることはしない。

事後生成の契機は、run が終わったときと、セッション画面を開いて先頭ページを読んだときの 2 つである。
run の終了からの契機だけは、レジストリの生存判定を飛ばす。
セッションの生存を登録の読み直しの写しで見ているため、止めた直後はまだ「実行中」と判定されてしまうからである。
飛ばすのは生存判定だけで、土台のままか 5 ターン以上進んだかの判定は残る。
どの要約器を使うかは、設定の要約エンジン（`summaryEngine`）の 1 つの選択で決める（2026-10-13 の決定、`summary/summarizers.ts` の `SummarizerSet.list`）。

- 使わない（`off`、既定）：要約器を並べない。`SummaryJob.enqueue` は手動の作り直し（force）も含めて受け付けず、失敗も配らない。会話の中で Claude が書く要約（`set_session_summary`）は今どおり書かれる。
- Claude（`claude`）：`claude -p` だけを使う。利用者の Claude の使用枠を使う。モデルは設定の `summaryClaudeModel`（既定 haiku）で、呼ぶたびに読む。
- OpenAI 互換の URL（`openai`）：LM Studio、Ollama、vLLM などの `/v1/chat/completions` を先に試す。補助のスイッチ（`summaryFallback`、既定は切）が入っているときだけ、使えないときに `claude -p` へ切り替える。

鍵の無い古い設定は「使わない」として読む。0.5.0 までの既定（LM Studio、無ければ Claude）は、LM Studio を使っていない人にも設定の目次に「LM Studio に接続できません」を常に出していたためである。
URL とモデルと切り替えの鍵（`lmStudioUrl`、`lmStudioModel`、`summaryFallback`）は残すので、OpenAI 互換を選び直せば前の宛先で動く。
Claude の呼び出しは 1 時間あたりの件数（既定 20、1 から 200 まで）と週の枠の使用率 80% で止め、`claude` が PATH に無ければ使わない。
モデルの一覧（`GET /api/summarizer/models`）は、OpenAI 互換を選んでいるときだけ宛先へ問い合わせ、ほかは空を返す。

要約器は差し替え可能な部品にする。

```ts
interface Summarizer {
  readonly id: 'lmstudio' | 'claude-headless';
  available(input?: SummaryInput): Promise<boolean>; // input は要約するセッション。Claude はそのアカウントの使用率で見る
  summarize(input: SummaryInput): Promise<SessionSummary>;
}
```

OpenAI 互換の要約器（`summary/lmstudio.ts`。id は LM Studio だけだった頃のまま `lmstudio` で、書いた要約の `source_id` と合わせてある）は、設定の URL（既定 `http://127.0.0.1:1234`）の `/v1/chat/completions` に、JSON スキーマ付き（`response_format` の `json_schema`）で投げる。
API キー（`summaryApiKey`）があれば、モデルの一覧と要約の両方に `Authorization: Bearer` で添える。
キーは settings.json（0600）にだけ置き、画面へは有無（`summaryApiKeySet`）だけを返す。設定の変更は全部の画面へ配るので、秘密を載せない。
`json_schema` を受けない口（Ollama の古い版など。400 か 422 を返すか、指定を無視して JSON でない本文を返す）には、`json_object` で投げ直し、スキーマは指示文の末尾に書く（`summary.prompt.jsonObject`）。
認証の失敗（401）などほかの失敗は投げ直さない。
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

Claude の要約器は `claude -p --model <summaryClaudeModel> --output-format json --json-schema <schema>` を走らせる。
こちらはサブスクリプションのレート制限を消費するので、1 時間 20 件までとし、週の枠の使用率が 80% を超えたら止める。
`claude -p` は、要約するセッションを最後に動かした run のアカウントの置き場（`CLAUDE_CONFIG_DIR`）で走らせ、週の枠の使用率もそのアカウントのもので見る（`boot/summary.ts` の `summaryAccountOf`、2026-10-13）。
サーバの環境のまま走らせると、複数のアカウントを使っているときに、会話のアカウントでなく最初のアカウントの枠を使うためである。
run の記録が無いもの（hangar の外で起こしたもの）と、消したアカウントのものは最初のアカウントで走らせ、run の起動と同じく、サーバが継いだ `CLAUDE_CONFIG_DIR` は外す。
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
| `sessions.ts` | セッションの一覧と 1 件、本文、サブエージェント、変更したファイル、検索、状態、昇格、事後要約 |
| `runs.ts` | run の起動と停止、タブ、指示へ跳ぶ、セッションから run を起こす口（resume、fork、attach、adopt、resume-here） |
| `projects.ts` | プロジェクトの一覧と 1 件、状態、置き場の選び直し、作成と登録 |
| `todos.ts` | TODO |
| `memos.ts` | プロジェクトのメモ（やめたノートを「以前のノート」として読み、空で保存して消すためだけに残す） |
| `artifacts.ts` | アーティファクト |
| `prompt.ts` | 初期プロンプト欄の候補と添付（`/prompt`、`/drops`） |
| `settings.ts` | 設定 |
| `retention.ts` | Claude Code の保持期間 |
| `sync.ts` | 同期の状態と操作、端末の一覧、クラウドの使用量、設定の同期（`/config-sync/*`。旧実装の `/sync/config/*` は段 4 の PR 18 で消した） |
| `usage.ts` | statusline の受け口と使用量 |
| `system.ts` | 索引の作り直し、準備の確かめ、互換、要約器 |
| `setupGuide.ts` | セットアップのすゝめの写しの場所と版（`/setup-guide`）、エディタで開く（`/setup-guide/open`） |

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
`hangar open` は同じ URL でブラウザを開くが、鍵付きの URL は端末に出さない。出すと、画面の表示とシェルの履歴に鍵が残るからである。
開けたときは「ブラウザで開きました（鍵の無い URL）」の 1 行だけを出す。
開く道具（macOS は osascript、macOS の外は `open.html` を開く道具）の終わり方で、開けたかを決める。起こせない、0 以外で終わる、信号で終わるときは開けなかったとする。5 秒たっても終わらない道具は、開けたこととして待たない。
開けなかったときも鍵は出さない。鍵の無い URL を手で開く案内と、鍵が要るなら `hangar url` を使うこと、その URL には鍵が入っているので人に見せないことを出す。終了コードは 0 のままである。
また `hangar open` は、開く前に `/health` を見て、サーバが動いていなければ開かずに終了コード 1 で終わる。
`hangar url` は同じ URL を印字するだけで、ブラウザは開かない。
鍵付きの URL を端末へ出す道は、起動のとき（`hangar start`）と、利用者が自分で打つこのコマンドだけで、401 の案内もこのコマンドを指す。
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
ただし読むだけの `get_transcript` は、ほかの `session_id` も受け付ける（2026-10-15）。セッション画面でコピーした宛先の 1 行（session_id 入り）を渡された別の Claude が、そのセッションの様子を読むためである。
`list_projects` と `list_sessions` も枠の外を返さない。
セッションがプロジェクトに属していないときは、プロジェクトを必要とするツールを断る。
共通の `/mcp` には枠が無く、今までどおりすべてを指せる。

- `list_projects()`：プロジェクトの一覧。ステータス、パス、未完 TODO 数、最終活動。
- `get_project(project_id)`：詳細。TODO、直近のセッション、アーティファクト。
- `update_project(project_id, { status?, add_todos?, toggle_todos?, propose_done? })`。`add_todos` の項目は文字列か `{ text, note? }` である。
  ノートへの追記（`append_memo`）は 2026-10-11 にやめた。古い指示を覚えた Claude が渡したときは、書かずに、やめたことと CLAUDE.md などの指示ファイルに書くよう促す一文を、応答の `notice` で返す（エラーにはしない）。
- `list_sessions({ project_id?, running?, limit? })`。
- `search_sessions({ query, project_id?, since?, until?, file? })`：FTS と絞り込み。結果は題名、要約の 1 文、一致箇所の抜粋、再開コマンド。
- `list_sessions`、`search_sessions`、`get_project` の直近のセッションには、会話を最後に動かした PC を `device: { name, platform, here }` で添える（0.6.1）。最後の run の PC で、run が無ければ作った PC（`home_device`）である。`here` はこの PC か。ほかの PC の会話は、パスやファイルの状態がこの PC と違うことがあるので、Claude が読み分けられるようにする（`runs/handover.ts` の `deviceOfSession`）。
- `get_transcript(session_id, { from_seq?, limit?, include_tools? })`：正規化イベントを返す。
- `create_session({ project_id, name?, prompt?, model?, effort?, permission_mode?, scratch? })`：tmux で起動して run を返す。
- `set_session_summary({ session_id?, title, one_liner, body, state, next_steps })`。
- `set_turn_intent({ session_id?, text })`：このターンで何のために何をするかを 1〜2 文（200 字まで）で書く。端末ローカルの `turn_intents` に積み、同期しない。セッション画面の現在の札に出す。
- `set_session_memo` は 0.4.0 で道具ごと外した（セッションのノートを外したため。要約の `set_session_summary` と Paused の戻る日が役を担う）。
  `append_memo` のように `notice` で答える形にしなかったのは、あちらは同じ呼び出しのほかの項目を書くためにエラーにしなかったのに対し、こちらは道具が 1 つの仕事しか持たないからである。
  外す前の一覧を覚えた Claude が呼んでも、MCP の層が書かずに `isError`（道具が無い）で返す。モデルにこの道具を使うよう指示したことも無い。
- `get_usage()`：5 時間と 7 日の使用率、最終更新時刻。
- `open_in_hangar({ session_id | project_id })`：UI とディープリンクの URL を返す。
- `draft_issue_report({ kind, title, ...節 })` と `submit_issue_report({ draft_id, confirmed })`：作者への問い合わせの下書きと送信。プロジェクトもセッションも指さないので、セッション別 URL の枠に関わりなく使える。詳しくは「作者への問い合わせ」の節。

`update_project` は status の変更、TODO の追加、完了の印、完了の候補の提出を行い（ノートへの追記はしない）、TODO の書き込みは全部成功か全部失敗のどちらかにする（途中で失敗したものが残らない）。
MCP から足した TODO は、すべて Claude の提案になる（データモデルの「TODO の提案」）。確定の TODO を足すのは利用者だけである。
提案は、利用者が受け入れるまで一覧の外に置かれ、未完の数にも、起動時に注入する未完の TODO にも入らない。
`add_todos` の `note` は提案の理由で、`propose_done` の `note` と同じく空白を除いて 200 字までである。空白だけなら理由なし（null）になる。
項目が文字列でも `{ text, note? }` でもないか、`note` が 201 字以上なら、呼び出し全体を断り、status も TODO も書かない。
MCP からは TODO を完了にできない。`propose_done` と未完への `toggle_todos` は完了の候補を出し、結果を `todo_results`（`[{ todo_id, outcome }]`）で返す。
`propose_done` は `[{ todo_id, note }]` で、`note` は根拠の一文（空白を除いて 1 字以上 200 字以下）である。
`toggle_todos` は、未完で候補でない TODO を根拠なしの候補にし、完了の TODO は未完に開き直し、候補の TODO には何もしない。
`outcome` は次の 6 つである。
`proposed` は候補にしたこと、`already_candidate` はすでに候補なので何もせず根拠も上書きしなかったこと、`already_done` はすでに完了なので何もしなかったこと（`propose_done` のみ）を指す。
`rejected_before` はこのセッションの候補は却下済みなので受け付けなかったこと、`reopened` は完了を未完に開き直したこと（`toggle_todos` のみ）を指す。
`not_accepted` は、利用者がまだ受け入れていない提案なので候補にしなかったことを指す。
`note` が空か 201 字以上、または見つからない ID が 1 つでも混ざれば、呼び出し全体を断り、どの TODO も書かない。
`get_project` の TODO には `candidate: { session_id, note } | null` が付き、セッションは自分の候補が残っているかを確かめられる。
`suggestion: { note } | null` も付き、自分の提案が受け入れられたか（null になる）、見送られたか（一覧から消える）が分かる。
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

`hangar mcp uninstall` は `mcpServers.hangar` だけを消す（0.4.0 から）。
`claude mcp remove` に任せず、登録と同じ 4 つの守りで書く。承諾の窓で見せた差分と書く中身をそろえ、書く前のバックアップも同じ置き場に取るためである。
載っていなければ書かず、バックアップも取らない。
最後の 1 つを消しても、`mcpServers` の鍵は空の `{}` のまま残す。
Claude Code の `claude mcp remove -s user` も空の `{}` を残し、空の `mcpServers` を読んでも困らない（2.1.296 で、使い捨ての設定フォルダで確かめた。`claude mcp list` は「登録なし」と言い、続けて `claude mcp add` もできる）。
登録の前に鍵が無かったのか、Claude Code や利用者が空で置いていたのかは見分けられないので、hangar が足した項目だけを消し、鍵には触らない。
そのため、登録の前に鍵が無かったファイルは、解除の後に空の `"mcpServers": {}` の分だけ違う（0.4.0 の VM の確かめで見つけた）。
見立ての差分も、この形のとおりに出す。最後の 1 つを消すときは `"mcpServers": {` と `}` だけが残り、ほかのサーバが残るときは、最後に残るサーバの行の `,` が外れることも差分に出す。
`--dry-run --json` の見立てでは、`~/.claude.json` の全体の差分は出さない。
ファイルは大きく、ほかの MCP サーバの秘密も入っているので、`mcpServers` の中だけを見せ、ほかのサーバは名前だけにして中身を畳む。
hangar のトークンは伏せ字（NUL の 1 字）に替えてから出し、承諾の窓は黒い帯で描く。
書く直前の確かめは、ファイル全体ではなく `mcpServers` の指紋で行う。
Claude Code は `~/.claude.json` のほかの鍵（起動の回数など）を頻繁に書くので、全体で比べると見せた直後でも食い違うからである。
ロックを取って読んだ `mcpServers` を、見立ての値ともう一度比べてから書く。
そのポートで誰も応答しないときだけは、起動前の登録を塞がないために成功のまま起動を促す。
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

## 作者への問い合わせ

利用者が Claude Code の会話から、hangar の不具合の報告や要望を作者へ送る口である（2026-10-15）。
送り先は公開リポジトリ `gaku1023/agent-hangar` の GitHub Issues で、作者は届いた issue を読んで直す。
誰でも送れるように、新しいサーバも秘密も置かない。
作者の側の受け取り（ラベルを付ける、画面に出す）は持たない。題名の頭と本文の末尾の印で探す。

### 2 段の道具

MCP の道具を 2 つ置く（`mcp/tools.ts`、中身は `report/`）。

- `draft_issue_report({ kind, title, ...節 })` は下書きを作るだけで、issue は作らない。
- `submit_issue_report({ draft_id, confirmed })` は下書きをそのまま送る。

外へ出る操作なので、Claude が勝手に送らないよう、利用者の承諾を 2 段にする。
1 段目は会話の中の承諾である。下書きの答えに「伏せた後の題名と本文を全文そのまま利用者に見せ、送ってよいと言われてから submit を呼ぶ」という指示を入れる。
`confirmed` が `true` でなければ submit は断る。
2 段目は Claude Code の許可の確認である。submit は書き込みの道具として許可を求められる。
submit は本文を受け取らず、下書きの ID だけを受け取る。利用者に見せた後で Claude が中身を書き換えて送れないようにするためである。
直したいときは draft を呼び直して、新しい下書きをもう一度見せる。
下書きはサーバのメモリに 30 分だけ置く（`report/drafts.ts`）。サーバが落ちれば消え、消えた ID は「下書きが見つからない」で断る。
送った下書きは消す。同じ下書きで 2 度送らない。

### 報告の形

報告の形は、作者が直しやすい形に道具の引数で寄せる。
自由な本文を 1 つ受ける形にしなかったのは、説明文で頼むだけでは節がそろわないためである。

- 不具合（`kind: 'bug'`）：症状（`symptom`）と再現の手順（`steps`）が必須、原因の見立て（`cause`）、直し方の案（`fix`）、補足（`notes`）が任意。
- 要望（`kind: 'request'`）：困っていること（`problem`）と欲しいもの（`proposal`）が必須、代わりの案（`alternatives`）と補足（`notes`）が任意。

「環境」の節は道具が埋める。中身は hangar の版、Claude Code の版（`claude --version`、取れなければ「不明」）、OS の種類と版、CPU のアーキテクチャである。
これより多くは自動で入れない。設定やログが要るときは、Claude が要る分だけを節に引く。
デスクトップ版か CLI かは入れない。サーバは殻から受けた印を起動のときに環境から外すので、道具からは確かに見分けられない。
題名の頭に `[bug]` か `[request]` を付け、本文の末尾に `<!-- via-hangar report v1 -->` を入れる。
外の人は issue にラベルを付けられないので、ラベルは付けない。
本文の言語は、利用者が会話で使う言語のままにする。節の見出しは hangar の言語の設定で出す。

### 伏せ方

公開リポジトリなので、私的な情報を機械で伏せてから下書きにする（`report/redact.ts`）。
伏せるのは題名と節の全部で、環境の節も通す。

| 対象 | 置き換え |
|---|---|
| 登録済みのプロジェクトのパス | `<project-N>` |
| 登録済みのプロジェクトの名前、フォルダ名 | `<project-N>` |
| ホームのパス | `~` |
| OS のユーザー名 | `<user>` |
| ホスト名 | `<host>` |
| メールアドレス | `<email>` |
| トークンらしい文字列（`ghp_` などの GitHub のトークン、`sk-ant-`、`Bearer` の後ろ、32 字以上の 16 進） | `<token>` |

長いものから順に置き換える。プロジェクトのパスをホームより先に置き換えるのは、ホームを先に `~` にするとプロジェクトのパスが一致しなくなるためである。
名前とユーザー名は語の境目でだけ置き換える。3 字未満の名前は、ふつうの語を壊すので置き換えない。
N はプロジェクトの並びで決め、同じ下書きの中では同じものに同じ番号を振る。
伏せた数を下書きの答えに入れ、利用者が承諾の前に読めるようにする。
機械の伏せ字は漏れうる。会話の中身そのものは引数に渡さないよう道具の説明で頼み、最後の見張りは利用者の目である。

### 重複の確かめ

下書きのとき、伏せた後の題名から語を取り、GitHub の公開の検索 API（`/search/issues`、ログイン不要）で開いている issue を引き、似たものを 5 件まで返す。
Claude は似たものを利用者に見せ、同じ件なら送らずにその issue を案内する。
検索に失敗しても（回数の制限、オフライン）下書きは作り、「確かめられなかった」と返す。
ここで GitHub に届くのは、伏せた後の題名の語だけである。

### 送り方

`gh` が見つかり、`gh auth status` が通れば、`gh issue create --repo gaku1023/agent-hangar --title <題名> --body-file -` で作る。本文は標準入力で渡し、argv に載せない。
答えには作った issue の URL を返す。
`gh` が無い、ログインしていない、作るのに失敗したときは、題名と本文を埋めた `https://github.com/gaku1023/agent-hangar/issues/new?title=…&body=…` を既定のブラウザで開く（`platform/browser.ts`）。最後の送信は利用者がブラウザで押す。
GitHub のアカウントが無い人は、そこでアカウントを作るか、本文を写して別の手段で作者へ渡す。
URL が 8,000 字を越えるときは、本文を後ろから切り詰め、切り詰めたことを本文の末尾と答えに書く。答えには切り詰める前の全文も返し、Claude が利用者に貼り直しを頼めるようにする。
Windows でも同じである。`gh` は `platform/exec.ts` で PATH と既知の場所から探し、`.exe` も当てる。

### 試験

伏せ字、本文の組み立て、URL の切り詰め、下書きの寿命、送り方の選び分けは、外へ出ずに試す。
GitHub の検索、`gh`、ブラウザは差し替えの口から偽物を渡す。本物の issue を立てる確かめは、その都度利用者に聞いてから行う。

## エディタの選択

「<名前> で開く」と、変更したファイルの行から開くときに使うエディタを、利用者が選ぶ（0.5.0。試作は scratchpad の editor-git-proto の推す組み合わせ、利用者が了承）。
選べるのは表のエディタ（VS Code、Cursor、Windsurf、Zed、IntelliJ IDEA、WebStorm）と任意のコマンドである。

### 設定と読み替え

設定は `editor: { id, path, fileCmd, dirCmd, terminal }` で、この PC だけの設定である（クラウドへは同期しない）。
`id` は表のエディタか `custom`、`path` は表のエディタの CLI の場所で、null なら開くたびに表の場所から探す。
`fileCmd` と `dirCmd` は任意のコマンドだけが使い、`terminal` は任意のコマンドがターミナルの中で動くエディタのときの起こし方である。
0.4.0 までの settings.json は `codePath`（VS Code の code の場所）だけを持つので、読むときに `{ id: 'vscode', path: codePath }` へ読み替え、古い鍵は持たない（`config/paths.ts` の `loadSettings`、`shared/editor.ts` の `editorSettingOf`）。
保存（`PATCH /api/settings` の `editor`）は足りない項目を今の値で埋め、表のエディタのパスはほかのパスの欄と同じく保存する前に確かめる（「エディタのパス」の /x には実行権がありません）。
任意のコマンドは `{path}` が要り、無ければ断る（「ファイルを開くコマンド」に {path} を含めてください）。

### 探し方と起こし方

表と探し方は `server/src/external/editors.ts` にある。子プロセスは起こさず、ファイルの有無と PATH だけを見る。
探す順は、設定のパス、PATH と既知の置き場（`which`）、表の既知の CLI の場所（Windsurf の `~/.codeium/windsurf/bin`、JetBrains Toolbox の scripts など）、アプリである。
macOS のアプリは `/Applications` と `~/Applications` の .app を名前で見る（Spotlight を切っている機械があるので mdfind には頼らない）。
Windows は `%LOCALAPPDATA%\Programs` と `%ProgramFiles%` の既知の場所、JetBrains は `Program Files\JetBrains` の版ごとのフォルダ（新しい版から）を見る。
見つかり方は、CLI がある（見つかりました）、アプリだけある（アプリだけ）、どちらも無い（見つかりません）の 3 つである。
「アプリだけ」も開ける。macOS はアプリの中の CLI（`Contents/Resources/app/bin/code`、Zed の `Contents/MacOS/cli`、JetBrains の `Contents/MacOS/idea` など）を先に使い、無ければ行のあるファイルは URL（`vscode://file/<パス>:<行>`）、それ以外は `open -a` で開く。JetBrains は URL を持たないので `open -na <app> --args --line N <パス>` で渡す。
Windows のアプリだけは、アプリの実行ファイルに CLI と同じ引数を渡す。
行の渡し方は、VS Code の仲間（Cursor、Windsurf）が `-g <パス>:<行>`、Zed が `<パス>:<行>`、JetBrains が `--line N <パス>` である。フォルダと行の無いファイルはパスだけを渡す。
Windows の `.cmd` と `.bat` は cmd.exe 越しに、語を `cmdQuote` で包んで渡し、`"` を含む語は開かずに断る。起こしたエディタの窓が出力の管を受け継ぎうるので、子の終わりで返す（`untilExit`）。
設定の候補の一覧（`GET /api/editors`）は、CLI の `--version` を 3 秒で打ち切って版を添える。同じファイルなら覚えた版を返す。JetBrains の起動用のファイルは `--version` でも IDE を起こすことがあるので、版を読まない。

### 任意のコマンド

シェルを通さずに起こす。語は空白で区切り、`"` か `'` で包んだ所は空白を含めて 1 語にする（`splitCommandLine`）。
差し込みは `{path}`（必須）と `{line}`（無ければ 1）で、語の中で置き換えるので、空白を含むパスも 1 語のまま渡る。
フォルダを開くコマンドが空なら、ファイルのコマンドから `{path}:{line}` を `{path}` にし、`{line}` を含む語を外して作る（`dirCommandOf`）。
先頭の語は名前なら PATH から探し、パスならそのファイルがあるかを見る。
ターミナルの中で動くエディタ（vim、nvim、hx など）は、「hangar のシェルタブで開く」ならそのセッションの実行中の run にシェルタブを 1 枚足し、エディタを起こしてからシェルに戻す（`RunManager.openTab` の `then`、`launch/command.ts` の `shellTabCommand`）。実行中の run が無いとき（プロジェクトや終わったセッションから開いたとき）は外部ターミナルで開く。
「外部ターミナルで開く」は設定のターミナルアプリの新しい窓で起こす（`openArgvInTerminalApp`）。

### テスト

設定の「テスト」（`POST /api/editor/test`）は、hangar の置き場に `hangar-editor-test.md` を書いて 3 行目を開く。
答えは 200 で返し、開けなかった理由も答えの中に入れる。画面はトーストにせず、選んだ行（「テスト」のボタン）のすぐ下に行の続きとして出す。
欄の下端に出すと、窓が低いときに右下の知らせの札に隠れるためである。
起こした経路で文を分け、URL と `open -a` は行の指定が効かないことがあると添える。

### 見つからないとき

開く要求（セッション、プロジェクト、アーティファクト、指示とメモリ、変更したファイル）は、押した瞬間にサーバが探し直す。入れ直した直後でも動く。
見つからなければ 409 で `{ code: 'editor_missing', error, editor, name, lastPath, others }` を返す（`others` はほかに見つかっているエディタ）。
画面はトーストにせず、押したボタンの下に面を出す（試作の 1-3 の B、`views/EditorMissing.tsx`）。理由（見つからない、最後に見つけた場所）と次の手（設定でエディタを選ぶ、今回は <名前> で開く（2 つまで）、再確認）を並べる。
「今回は」は同じ操作に `once` を添えて送り直し、設定は変えない。再確認は `once` を外して送り直す。
断りは Store の `editorMissing` に置き、`n` で同じ断りをもう一度受けたことを見分ける。面は閉じた `n` を覚え、新しい断りだけを出す。開けたら Store から消す。
押したボタンの位置は、押し下げを先回りで覚えて使う（WebKit はボタンを押してもフォーカスを移さないので、`document.activeElement` では取れない）。

### 画面の文言

ボタンの文は「<名前> で開く」で、任意のコマンドは「エディタで開く」である（試作の 1-2 の A）。アイコンは今までの汎用のコードの印のまま（商標のアイコンは持たない）。
View が自分で持つボタンの文は、Root が設定から流す名前（`views/primitives/editorName.tsx` の `EditorNameRoot`）から引き、データから作る文（見出しの操作、変更したファイルの行）は Presenter が `presenters/editor.ts` で引く。
始める前の確認にはエディタの任意の行を足した（「Home」の節）。
MCP の `open_in_hangar` は hangar の画面（セッションかプロジェクト）を開く道具で、エディタは起こさないので、選んだエディタの影響を受けない。

実物では未確認：Zed の Windows 版の CLI の場所と引数、Windows で `Code.exe` や `Cursor.exe` に `-g` を直に渡して行まで飛ぶか、JetBrains の Toolbox のスクリプトの場所（版で変わる）。

## git の表示

一覧、ホームの実行中、セッションの現在の札と (i)、プロジェクト画面に、作業ツリーのブランチと未コミットの件数を出し、セッションが変えたファイルの差分を読むだけで見せる（0.5.0。試作は editor-git-proto の推す組み合わせ、利用者が了承）。
hangar は git に書かない。どの呼び出しも `--no-optional-locks` を付け、index.lock を取らない。Claude や利用者の git と取り合わないためである。
値は端末ローカルで、クラウドへは同期しない（`session_activity` と同じ扱い）。

### 数え方

未コミットは作業ツリー（同じフォルダ）ごとの値で、`git status --porcelain=v2 --branch -z` の行の数である。セッションごとには割らない。
割ると、Bash での書き換えが抜けて少なく見え、git の数とも合わなくなるからである。
同じ作業ツリーで実行中のセッションが 2 本以上あれば、行に「共有 N」（N は自分を含めた本数）を添える。衝突の手がかりになる。
一覧の 2 段目が狭いときは、要約が先に縮み、札（ブランチの名前と件数）は要約が縮みきるまで縮めない。
終わったセッションの札は、そのときのブランチ（本文の `gitBranch`）だけを出し、今の作業ツリーの件数は出さない。そのセッションの状態のように読めてしまうためである。件数は (i) の「作業ツリーの未コミット」で読める。
本文に `gitBranch` が無い終わったセッション（git でなかった頃に作業したものなど）には、札を出さない。今のブランチはそのときのブランチではないからである。
このセッションが変えたうちの未コミットは、(i) と差分のダイアログでだけ言う。
1,000 件を超えたら数えるのをやめて「未コミット 1,000+」にする。3 秒で答えなければ「件数なし」にし（理由は title）、その根は 60 秒呼ばず、以後は `--untracked-files=no` で試す。
同じ根への同時の呼び出しは 1 つにまとめ、git は同時に 2 本までにする（`git/service.ts`）。

### ブランチと worktree

出すブランチは、トランスクリプトの最後の `gitBranch` を先に使い、無ければ作業ツリーの今のブランチ、切り離した HEAD ならコミットの短い名前である。
ただし今のブランチで埋めるのは実行中のセッションだけである。サーバは `GitSessionDto.branch` に本文の `gitBranch` だけを入れ（無ければ null）、今のブランチは `GitTreeDto.branch` で別に渡す。
作業ディレクトリは、トランスクリプトの最後の `cwd`（EnterWorktree で入った worktree はここに出る）を先に見て、無ければセッションの cwd を使う。
worktree は `--git-dir` と `--git-common-dir` の違いで見分け、枝の印ではなく分かれ道の印、worktree の名前、小札「worktree」で出す（枝の名前は title と (i)）。
作業していた worktree が消えていれば「<名前> 削除済み」と言う（`worktree-state` の名前か、`.claude/worktrees/<名前>` の形の cwd から）。
git でないフォルダには札を出さない。他の PC で動いているか、この PC に本文が無いセッションは git を読まず、画面の印と本文の `gitBranch` だけを出す。
フォルダの持ち主が今のユーザーと違うと、git は読むのを断る（dubious ownership）。
このときは git でないとはせず `unsafe` とし（`git rev-parse` の stderr から git が名指した場所を読む、`git/status.ts` の `unsafeDirOf`）、札は出さずに (i) で訳と許すコマンド（`git config --global --add safe.directory <場所>`、写せる）を出す。
hangar は git の設定を書かないので、打つのは利用者である。

### 取り方

`POST /api/git/sessions`（ids は 200 件まで）が、セッションごとの手がかり（`GitSessionDto`）と根ごとの状態（`GitTreeDto`）を返す。
View は見えている行のセッションを `git.watch`（場所ごとの鍵つき）で知らせ、Runtime が実行中のセッションを足して 150 ms まとめ、5 秒以内に取ったものは飛ばして呼ぶ（`runtime/gitWatch.ts`）。
窓が前にある間は 30 秒ごとに全部を取り直し、裏にある間は止め、前に戻ったらすぐ取る。30 秒の周期は最初の `git.watch` か、プロジェクト画面の git の読み込み（`project.git.load`）で始める。
サーバは、実行中のセッションの根は 2 秒、終わったものは 60 秒覚える。
実行中のセッションの本文が伸びたら、サーバが 2 秒待ってから作業ツリーを読み直し、件数かブランチが変わったときだけ `git.upsert` を配る（`projects/onSessionChanged.ts` の `onAppended`）。
背景の読み込み（`git.watch`、変更したファイルの一覧、プロジェクトの git）は、View の操作の数に入れない `useBackgroundEmit()` で出し、Root だけが Runtime へつなぐ。

### 差分

差分のダイアログ（試作の 2-5 の A）は、共通のダイアログの殻に載せ、左に変更したファイル、右に統合の差分を出す。
対象は `GET /api/sessions/:id/changes` の、そのセッションが編集系のツール（Edit、Write、MultiEdit、NotebookEdit）で変えたファイルだけで、git の状態（M、A、未追跡、D、R、コミット済み）と行の増減を添える。
既定は作業ツリーとの差（`GET /api/sessions/:id/diff?file=`、`git diff <HEAD> -U3`。未追跡は全部足した形、256 KB で切る、バイナリは本文を出さない）。
切り替えの「このセッションの編集」は、トランスクリプトの Edit と Write の呼び出し（`GET /api/sessions/:id/edits?file=`、50 件まで）を、本文と同じ差分の部品で並べる。今のファイルとは違うことがある。
git でないフォルダは「このセッションの編集」だけを出す。差分と編集は、そのセッションが変えたファイルでなければ 404 で断る（任意のパスを読ませない）。
State に置くのは、セッション、選んだファイル（null は最初の未コミット）、源（null は git、git の外ならこのセッションの編集）だけで、中身は Store に置き、ファイルか源が変わるたびに取り直す。
下端の主ボタン「<名前> で開く」は、最初に足した行（無ければ最初のハンクの新しい側の始まり、無ければ 1）で開く（「エディタの選択」の節）。キーは ↑ と ↓ でファイル、e で開く。
終わったセッションの見出しの下の 1 行は、「変更したファイル N」の札を開いたときの下に「差分を表示」を置き、git の札を読むだけで並べる。

### Bash で書いたファイル

Bash などのコマンドで書き換えたファイルは、トランスクリプトから拾えない（試作の 2-6 の N3）。
作業ツリーのほかの変更を「ほかに作業ツリーで変わったファイル N 件」の畳んだ行にし、開くと「このセッションとは限りません。Bash などのコマンドでの書き換え、ほかのセッション、手での編集は、どれが変えたか見分けられないためです。」と添える。
git の外では、その旨の 1 行だけを出す。

### プロジェクト画面

パスの行にルートのブランチと件数を出し、右パネルに「ブランチと worktree」の節（`git worktree list` の行ごとに、未コミット、ブランチ、そこに乗っているセッションの数と状態）を足す（`GET /api/projects/:id/git`）。
画面を開いたときとプロジェクトを替えたときに読み、開いたままの間も、Runtime が一覧の git と同じ 30 秒の周期と、窓が前に戻ったときに読み直す（`runtime/gitWatch.ts` の `also`、`runtime.ts` の `reloadProjectGit`）。
ブランチを替えたり持ち主を直したりしても、開き直すまで古いまま残らないようにするためである。サーバは根の状態を 60 秒覚えるので、替えてから映るまでは最長で 90 秒ほどかかる。
開いたときの読み込みの失敗は札にするが、周期と窓が前に戻ったときの読み直しは裏の読み直しなので、失敗を札にしない（30 秒ごとに同じ札が積もらないようにする）。
読み直しが 404（プロジェクトが無い）を返したら、画面の外（別の窓、CLI、同期）で一覧から削除されたので、Store からそのプロジェクトとブランチと worktree の写しを外す（`store.ts` の `withoutProject`）。
サーバはプロジェクトの論理削除を画面へ配らない（配る層は行が無いと何も配らない）ので、画面の側で外す。
外すと一覧とサイドバーから消え、開いている画面はその場で「プロジェクトが見つかりません」の面になり、それ以後は読まない。
ホームへは移さない（見ている画面を利用者の操作なしに替えないため。面の文で何が起きたかが分かる）。
この PC にパスの無いプロジェクト（他の PC から同期したもの）は、画面が読みに行かず、節に「この PC にパスが無いので、git を読みません」と出す。
サーバも 404 にせず `blocked: { kind: 'noPath' }` を返す（取得中のまま止めず、エラーの札も出さないため）。
パスのフォルダが無ければ `missing`、持ち主の違いで git が断れば `unsafe`（節に訳と許すコマンド）を返す。
行を押して左の一覧をその作業ツリーで絞る形（試作の 2-4 の B）は、一覧がサーバのページ送りで、検索に cwd の条件が無いので、まだ入れていない。

## アーティファクト

**アーティファクト** は、セッションが claude.ai に公開した Artifact の URL である。
トランスクリプトの Artifact ツール呼び出しと結果から自動で抽出する。
呼び出しには元ファイルのパス、説明文、favicon の絵文字が、結果には `Published <path> at https://claude.ai/code/artifact/<uuid>` が残る。
旧形式の `https://claude.ai/artifact/<id>` も同じ扱いにする。

同じ URL への再公開は 1 件のアーティファクトにまとめ、`artifact_versions` に「いつ、どのセッションが更新したか」を積む。
題名は元ファイルが残っていれば HTML の `<title>` から、無ければ説明文の先頭から取る。
プロジェクト画面には全セッション分を集約し、セッション画面にはそのセッション分を出す。
カードには favicon、題名、説明、最終公開時刻、更新回数を出し、クリックで既定のブラウザに開く。
元ファイルが残っていれば「<名前> で開く」（選んだエディタ）も付ける。
利用者は URL を手で追加できる。
手で足した URL がすでにあるときは、付いているプロジェクトで分ける。
同じプロジェクトなら、既存をそのまま返す。
どのプロジェクトにも付いていない、または外した（論理削除した、行が無い）プロジェクトに付いているなら、いま足したプロジェクトへ付け替える。
今も一覧にある別のプロジェクトに付いているなら（アーカイブ済みを含む）、付け替えずに `409` と「すでにプロジェクト「〇〇」に付いています」を返す。
画面は、この理由を追加欄の下に出し、入れた URL を欄へ戻す（欄を空にしたままにしない）。
1 つの URL を複数のプロジェクトに付けることは、今はしない。`artifacts.url` が一意で `artifacts.project_id` が 1 つなので、付け先は 1 つである。

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
殻の中の画面のボタン（設定の連携の節と、ホームの始める前の確認）は殻に頼むだけで、殻が承諾の窓で見せてから同じ CLI を走らせる（「承諾の窓」の節）。
サーバは追記の有無を `GET /api/statusline` で読むだけで、書き込む経路を持たない。
外すのは `hangar statusline uninstall`（0.4.0 から）で、目印の行から終わりの行までを、バックアップを取ってから消す。範囲を読み取れないときは触らない。

書く先を決めるときは、`statusLine.command` を空白で語に分け、二重引用符と一重引用符の中の空白では区切らない（`powershell -File "C:\Users\a b\x.ps1"`）。逆斜線はパスの区切りとしてそのまま残す。
実行するものは、絶対パスや引用符つきで書かれていても名前で見分ける（`/bin/bash`、`"C:\Program Files\PowerShell\7\pwsh.exe"`）。以前は絶対パスの `bash` を書く先と取り違えた。
スクリプトの語は、`~`、`$HOME`、`${HOME}` を手元のホームに、`%NAME%`、`$NAME`、`${NAME}` を環境変数に展開して読む（Windows では名前の大文字小文字を区別しない）。展開できない変数が 1 つでもあれば、推して別のファイルを指さないよう、読めない扱い（書く先なし）にする。
スクリプトと `~/.zshrc` は UTF-8 で読み書きするので、UTF-8 でないもの（UTF-16 の BOM、NUL の字、UTF-8 として正しくない並び。Windows PowerShell 5.1 の `Out-File` の既定は UTF-16）は、入れるのも外すのも書かずに断る（`config/textEncoding.ts`、見立ての理由の鍵は `not-utf8`）。
見立てで止まるので承諾の窓は開かず、画面は鍵から文を引いて知らせ、CLI は同じ理由を端末に出す。
UTF-8 の BOM 付きは書き換えてよく、BOM を外してから目印と shebang を探し、書く中身の先頭に BOM を戻す（BOM の付いた行では目印が見つからず、入れ直すたびに 2 つ目を足していた）。

Windows でステータスラインのスクリプトが PowerShell（`.ps1`）のときは、同じことをする PowerShell の行を先頭に入れる（0.4.0 から）。
`statusLine.command` が `pwsh` か `powershell` の `-File <パス>`、または `.ps1` を直に指すときに、そのファイルを書く先にする（引用符と環境変数の読み方は上と同じ）。
PowerShell の行は ASCII だけで書き、目印も `# agent-hangar: forward usage to local server; errors ignored.` にする（0.6.1 の次の版から）。
Windows PowerShell 5.1 は BOM の無い `.ps1` を ANSI のコードページ（日本語なら CP932）で読む。
0.6.1 までは目印が日本語だったので、UTF-8 の字が 2 バイトの区切りをずらして改行をまたぎ、次の行の標準入力の読みまで 1 つのコメントになっていた。
読んだ値が空なので送る前に例外になり、`catch {}` が黙らせるので、何も送らずに何も言わなかった。
BOM を足して直す道は取らない。利用者のスクリプトが CP932 で書かれていると、そちらが壊れるためである。
日本語の目印の古い形も「入っている」と認め、入れ直すときは今の形に差し替え、外すときもその範囲を消す。
試験は、行を UTF-8 のバイトにして shift_jis で読み直し、行の区切りが変わらないことを確かめる（Windows の CI は 1 バイトのコードページなので、本物の `powershell.exe` で走らせてもこの不具合は出ない）。
標準入力は `[Console]::OpenStandardInput()` からバイトで読み切り、UTF-8 で解釈する。5.1 の `[Console]::In` はコンソールのコードページで読むので、`session_name` などの日本語が化けて届く。
ヘッダのファイルが読めるときだけ `HttpClient` で送る（0.3 秒で打ち切り、失敗は黙る）。
PowerShell には裏で送る軽い道が無い（`Start-Job` は別のプロセスを起こして 1 秒近くかかる）ので、送るのは待つ。宛先は同じ PC なので短い。
送り終えたら `[Console]::SetIn` で読んだ内容を標準入力に戻し、元のスクリプトが `[Console]::In` で同じ内容を読めるようにする。
トークンはどのプロセスの引数にも載せない。
`param` の塊で始まるスクリプトは、その前に文を置けないので、自動では入れない。
`$input` で標準入力を読むスクリプトも、戻した内容を読めないことがあるので、自動では入れない。
`[Console]::OpenStandardInput()` で読むスクリプトも、hangar の行が先に読み切った後は 0 バイトしか読めないので、自動では入れない（`$input` と同じ理由の鍵 `ps-input`）。
古い形が入っているスクリプトでも、元の行が `OpenStandardInput` で読むなら差し替えない。今の形はバイトで読み切るので、差し替えると元の表示が空になるためである。
どれも理由を返し、`[Console]::In.ReadToEnd()` で読む形にするよう案内する。
ほかに、利用者のコマンドを hangar の包み（`hangar-run.mjs statusline -- <元のコマンド>`）で包む道も比べた。元のスクリプトに触れずに済むが、`settings.json` の `statusLine.command` を書き換えることになり、statusline が走るたびに Node を 1 回起こし、bash の形とも揃わないので取らなかった（2026-10-15）。
改行の形（CRLF）はファイルに合わせる。

準備の確かめは `GET /api/readiness` の 1 つにまとめてある（`packages/server/src/config/readiness.ts`）。
tmux、claude、Node のパスの有無と実行権と版、git（設定の欄は無く、PATH と既知の置き場から探す。`git/find.ts`）の場所と版、選んだエディタで開けるか（`editor`）、ワークスペースの有無と、そこから登録したプロジェクトの数、MCP の登録の有無、statusline の追記の有無、画面に出すコマンドを返す。
git の既知の置き場は、Windows では Git for Windows の `Program Files\Git\cmd` と `%LOCALAPPDATA%\Programs\Git\cmd` である。
macOS の `/usr/bin/git` は入れ物で、コマンドライン・デベロッパツールが無いと起こしただけで入れる窓が出るので、開発ツールの git があるときだけ使う。
エディタの行は版を読まない（ファイルの有無と PATH だけ）。
Claude Code との互換の要約（確かめた版、手元の claude の版、ずれの件数）も `compat` に載せる。
版は `tmux -V` と `--version` を 3 秒の時間切れ付きで起こして読み、同じファイル（パス、更新時刻、大きさ）なら覚えた版を返して起こし直さない。
サーバが Windows のときだけ、tmux の行（psmux）の版が `PSMUX_MIN_VERSION`（3.4.0）より古ければ `outdated: { min }` を添える（issue #245、`packages/shared/src/psmux.ts`）。`ok` は変えない。
psmux は `-V` の 1 行目を `tmux 3.3.8` の形に保つ（libtmux との互換のため）。版は `x.y` か `x.y.z` だけを読み、ほかの形（`3.5a` など）と読めないときは古いとしない（誤って知らせない）。macOS の tmux には当てない。
`hangar setup` も Windows では psmux の版を読み、古ければ報告に注意と上げる 1 行を添える（`packages/cli/src/setup.ts`）。
設定画面の欄の下の検証と、ホームの帯の始める前の確認が、どちらもこれを読む。
UI は起動のたび、設定画面に入ったとき、設定を保存した後、「もう一度確かめる」を押したときに取りに行く。
API やほかの窓から設定が保存されたときは、`settings.changed` が届く。
変えた欄が `claudePath`、`tmuxPath`、`nodePath`、`editor`、`workspaceRoot`、`claudeDir` のどれかなら、UI は準備の確かめを取り直し、ホームの帯と欄の下の検証を新しい答えにする（アプリを開き直さなくてよい）。
サーバは準備の確かめを毎回その時点の設定から作り直し、結果を持ち越さない（覚えるのは版だけである）。

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
論理削除したセッションは数えないが、利用者が削除した（削除の印のある）セッションは数える。実際に使った量だからである（「セッションの削除」の節）。
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
止まっている理由は `is:permission`（許可待ち）と `is:limited`（使用制限とリセット済み）で選ぶ（「止まっている理由」の節）。動きとは別の項目なので、`is:waiting is:permission` のように重ねられる。
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

### セッションを別のプロジェクトへ移す

セッションの所属は、ふつうは cwd からの自動の振り分け（この PC の場所の最長一致）で決まる。
利用者はこれを別のプロジェクトへ移せる（`PUT /api/sessions/:id/project`、UiAction は `session.move`、本体は `sessions/move.ts`）。
動かすのは hangar 上の所属だけで、本文（jsonl）と `sessions.cwd` は元のままにする。

- 移した先は `session_states.project_id` に書き、`sessions.project_id` も同じ値にする。どちらも同期に載る。
- 移した先は利用者が決めたことなので、本文から読み取る事実を置く `sessions` ではなく、利用者の操作でしか書かれない `session_states` を正とする。
  所属の正は `session_states.project_id` である。クラウドや手元の `sessions.project_id` はその写しで、正ではない。
- 索引（`applySessionFacts`）、自動の振り分け（`assignSessions`、`assignSession`）、同期の取り込み（`sync/apply.ts` の `sessions` と `session_states` の upsert）のあとで、`sessions.project_id` を移した先に合わせ直す。
  古い所属を持った `sessions` の upsert が後から届いても、移した先のままになる。
  同期の取り込みでの合わせ直しは手元の表だけを直し、押し返さない。どの PC も移した印を受け取れば自分で合わせ直すからである。
- 移した先が一覧から削除されたプロジェクトなら、移した印は無いものとして読み、cwd からの自動の振り分けに戻る。
  ほかの PC のまとめ（`mergeProjects`）や一覧からの削除（`unlink`）で移した先が消え、印の付け替えがまだ届いていないときも同じである。
  再開の cwd の読み替えでも、そういう会話は移していない会話として読む。
- 版 25 より古い PC が `session_states` の行を書くと、その PC は移した先の列を知らないので、移した印がクラウドの行から落ちる。
  新しい PC が次にその行を書けば、印は上がり直る。両方の PC を版 25 以上に上げる前提とする。
- プロジェクトをまとめる（`mergeProjects`）ときと、スクラッチのプロジェクトを 1 つにまとめる（`ensureScratchProject`）ときは、移した先もまとめ先へ付け替える（どちらも `projects/contents.ts` の `moveProjectContents`）。一覧から削除する（`unlink`）ときは、移した先を null に戻す。
- クイックセッションを新しいプロジェクトへ昇格する（`projects/promote.ts`）ときは、移した印があれば新しいプロジェクトに書き換える。
- 無いセッションと、無いか一覧から削除したプロジェクトへの移動は 404 で断る。
- 再開（resume）の所属は移した先で、注入する指示も移した先のプロジェクトのものを使う。
- 再開の cwd は元のままである。cwd がどれかの PC のクイックセッションの置き場の下にあれば、所属によらずクイックセッションとして読み替える（「クイックセッション」の節）。
  普通のプロジェクトへ移したクイックセッションの会話も、この PC の `quick-sessions/<元のフォルダ名>` で起こす。
  それ以外で cwd がこの PC に無いときの読み替え（`runs/handover.ts` の `resumeTarget`）は、所属より先に、どれかの PC の場所が cwd を含むプロジェクトのうち、この PC に場所があっていちばん深いものの場所で行う。
  移した先が親のワークスペースで、その場所も cwd を含むときでも、より深い本来のプロジェクトで読み替える。
  そういうプロジェクトが無いとき、移していない会話は所属するプロジェクトの場所で読み替える。移した会話は読み替えず、この PC では起こせないものとして扱う。
- 移した会話をフォークすると、新しい会話にも移した印を写す。写さないと、新しい会話の索引で cwd からの自動の振り分けが元のプロジェクトへ戻す。

### セッションの削除

利用者はセッションを消せる（`DELETE /api/sessions/:id`、UiAction は `session.delete`、本体は `sessions/trash.ts`、組み立ては `boot/trash.ts`）。
どちらの PC からでも消せる。
消すと、本文を OS のゴミ箱へ移し、hangar の一覧から外し、同期しているほかの PC からも外す。
利用者がゴミ箱から本文を戻せば、hangar にも戻る。

**置き場。**
削除は利用者が決めることなので、印は `session_states.trashed_at` に置く（版 25）。
`sessions.deleted_at`（行の論理削除）は一覧から外すための写しで、印に合わせる。
印を `sessions` に置かないのは、`sessions` の行は本文を持つ PC の索引が書き直し、同期が行ごとの後勝ちなので、印を受け取る前の持ち主の書き込みで生き返るからである。

**実行中は消せない。**
どこかの PC で動いている（`runs/announce.ts` の `sessionRunsAnywhere`）なら、409 と「実行中のセッションは削除できません。先に停止してください」で断る。

**消した PC。**
1. 自分の手元の本文（主線の jsonl と、隣の `<uuid>/` のサブエージェントの本文）を OS のゴミ箱へ移す。手元の本文は、索引の行（`transcript_files`）と、cwd の置き場（`~/.claude/projects/<cwd を畳んだ名前>/<uuid>.jsonl`）から探す。
2. 主線を先に移す。主線を移せなければ、何も変えずに 500 と「トランスクリプトをゴミ箱へ移動できませんでした（理由）。何も変更していません」を返す。`rm` には倒さない。
   主線を移せた後にフォルダを移せなかったときは、印は書き、残りは次の回でやり直す。
3. hangar が降ろした写し（`~/.agent-hangar/remote/` の下）は hangar の持ち物なので、ゴミ箱を通さずに消す。
4. 本文の元のパスは、ゴミ箱へ移す前に端末ローカルの `trashed_transcripts` に控え、移せなかったら控えを取り消す。
   移した後の DB の書き込み（下の 5）で転んでも、控えが残るので、利用者がゴミ箱から戻せば元に戻る（「戻す。」）。
   移してから控える順では、転んだときに本文はゴミ箱にあるのに印も控えも無くなり、戻しても hangar には戻らない。
5. 印（`trashed_at`）を書き、`sessions` の行を論理削除する。どちらも同期に載る。本文の索引（`transcript_files`、`event_index`、`event_fts`、`session_activity`、`session_limits`）は片付ける。
   日別の使用量（`usage_daily`）は残す。実際に使った量なので、会話を消しても使用量の集計からは消さない（`usage/aggregate.ts` は、削除の印のあるセッションも数える）。
   戻して索引し直すときは、先頭からの作り直しでそのファイル由来のぶんを消してから積むので、二重に数えない。

**印を受け取った PC。**
同期で `session_states` の行が届くと、次の回（`SessionTrash.applyMarks`）を回す。
起動したときと、1 分ごとにも回す。
起きていなかった PC は、起きて印を受け取った後の回で同じことをする。
- その PC に本文があれば（本文の持ち主なら）、その PC のゴミ箱へ移す。その PC で動いていれば、止まるまで待つ（次の回にやり直す）。
- 本文を移したら、`sessions` の論理削除を自分でも書き直して上げる。持ち主が印を受け取る前に上げた upsert がクラウドで勝っていても、それより新しい削除になる。
- hangar が降ろした写しは消す。
- 処理し終えた印は端末ローカルの `trash_applied` に覚え、二度処理しない。移せなかった本文や消せなかった写しがあれば覚えず、次の回でやり直す。
- 写しの降ろし（`sync/puller.ts`）は、印のあるセッションの写しを降ろさない。
- 印は 1 件ごとに処理の鎖へ並び直す。印が多くても、途中で頼まれた削除（`DELETE /api/sessions/:id`）が残りの印の後ろで待たされない。並んでいる間に処理し終えた印や、変わった印は飛ばす。

**同期で届く ID の検査。**
本文のパスは `sessions.provider_session_id` から組む。
この値は同期で届くので、組む前に UUID の形（`/^[0-9a-f-]{36}$/i`）かを見る。
合わなければ、手元の本文も hangar の写しも対象なしにし、何もゴミ箱へ移さない（印と論理削除は書く）。
空や `..` のような値でパスを組むと、本文の置き場のフォルダごとゴミ箱へ移しかねないからである。

**生き返らない。**
- 削除の印は、明示の復元でしか外れない。
  印を受け取る前のほかの PC が同じ `session_states` の行を書く（自動の Done、状態の変更）と、印の無い行が行ごとの後勝ちで届く。
  逆に、戻したことをまだ受け取っていない PC は、戻す前の印を持つ行を新しい時刻で上げることがある（印の上げ直し、状態の変更）。
  同期の取り込み（`sync/apply.ts` の `mergeTrash`）は、届いた `session_states` の行の印を手元の行と次のように合わせ、ほかの列（状態など）は届いた行のものを取り込む。
  1. `restored_at` は、手元と届いた行の大きい方にする。復元の事実を、後から届く古い行で消さない。
  2. 届いた行に印が無ければ、手元の印を保つ。
  3. 印が `restored_at` 以下なら外す。戻した後に古い印が届いても、印は付き直らず、本文をもう一度ゴミ箱へ移さない。クラウドの行も印の無い行が勝つので、30 日後の掃除で写しが消えることもない。
  合わせた印が届いた行の印と違えば（保った、または外した）、その結果の行を、届いた行より新しい時刻で手元から上げ直し（`upsertShared`）、クラウドとほかの PC もそろえる。
  上げ直した行を受け取った PC は、同じ合わせ方で同じ印になるので、そのまま取り込み、上げ返さない。往復はそこで止まる。
- 印を書く時刻と、戻したときの時刻（`setSessionTrashed`）は、行の `updated_at` を、今と、手元の行の `updated_at` より 1 だけ後の、遅い方にする。
  手元の行は時計の進んだほかの PC が書いたことがある。クラウドは行ごとの後勝ち（`packages/cloud/src/changes.ts`）なので、今の時刻で書くと印や復元がその行に負ける。
  印の時刻も、前の `restored_at` より後にする。上の 3 で古い印として外されないためである。
- 版 24 以下の PC は `session_states` の印と移した先の列を知らないので、その PC が行を書くと、クラウドの payload から `project_id`、`trashed_at`、`restored_at` が落ちる。
  印は、その行を受け取った新しい PC が上の 2 で保って上げ直す。移した先は上げ直されず、新しい PC が次にその行を書くまでクラウドの行から落ちたままになる。
  両方の PC を上げる前提とする（「セッションを別のプロジェクトへ移す」の版 25 の注意と同じ）。
- 同期の取り込み（`sync/apply.ts`）は、`sessions` と `session_states` の行を当てたあとで、印のあるセッションの `sessions` を論理削除のまま保つ（`alignSessionTrash`）。upsert が `deleted_at` を null にする所の後で直すので、古い `sessions` の upsert が後から届いても、同じ束で届いても戻らない。手元の表だけを直し、押し返さない。
- 索引（`indexer/indexFile.ts`）は、論理削除したセッションの本文を掘り起こさない。`history.jsonl` にだけ残る会話の登録（`syncHistoryOnly`）も、論理削除した行を書き直さない。
- 自動の振り分け（`assignSessions`）は論理削除した行を読まない。プロジェクトをまとめる（`mergeProjects`）と一覧から削除する（`unlink`）は、行全体を `deleted_at` ごと書き直すので戻らない。

**関係する行。**
| 行 | 扱い |
| --- | --- |
| `sessions` | 論理削除する。印に合わせる |
| `session_states` | 残す。印（`trashed_at`）を持つ行である。状態、提案、移した先もそのまま残し、戻したときに消す前の状態で戻る |
| `usage_daily`（端末ローカル） | 残す。実際に使った量なので、使用量の集計に数え続ける |
| `session_summaries`、`session_notes` | 残す。戻したときに、要約と hangar で付けた名前がそのまま戻る。一覧は `sessions` の論理削除で外れるので見えない |
| `runs`、`run_tabs` | 残す。実行中は消せないので、残るのは終わった run だけである |
| `todos`、`artifacts` | プロジェクトのものなので触らない |
| 本文の索引（端末ローカル） | 片付ける。戻したときに索引し直す |

クラウドの写し（R2 の本文と D1 の索引）は、`trashed_at` から 30 日（`TRASH_KEEP_MS`）たったら、各 PC のゴミ箱の掃除が消す（`packages/server/src/sync/trashSweep.ts` の `sweepTrashBlobs`）。
互換の版 9 で、Worker の掃除（`sweepTrash`）から移した。
印は封じた行の中にあって Worker には読めないからである。
各 PC は、自分の DB で 30 日の判定をし、自分が上げた本文（主線とサブエージェント）の鍵名を上げた世代ごとに求め直して、`DELETE /blobs` に渡す。
印から 30 日たち、その後に復元されていない（`restored_at` が `trashed_at` より新しくない）ものだけを消す。
同じ Claude Code のセッション ID の生きたセッションがあれば消さない。
Worker は、置いてから 1 時間たっていない写しと、他の PC の写しを断り、1 日に 500 件までしか消さない。
断られた分は次の回（6 時間後）に送り直す。
そのため、消えるのは 30 日をちょうど過ぎた時点ではなく、その後の掃除の回である。
掃除の細部は「同期対象と暗号化」にある。
30 日を過ぎてから戻した会話は、クラウドの写しが消えている。
持ち主の PC は戻したときに上げた控えを忘れて上げ直すので（下の「戻す。」）、ほかの PC はその後に降ろせる。

**消したセッションへの操作。**
一覧、1 件の取得、本文、状態の変更、移動、再開、フォーク、MCP の道具（`get_transcript`、`propose_session_status` など）は、どれも生きている `sessions` の行だけを読むので、消したセッションには 404 か「セッションが見つかりません」で断る。
MCP の `list_sessions`、`search_sessions`、`get_project` の直近のセッションも、消したセッションを返さない（`mcp/tools.test.ts` で確かめる）。
配る層は、論理削除された `sessions` の行に `session.removed` を配り、画面は Store から外す。

**戻す。**
ゴミ箱へ移した主線の本文が、元のパスに戻ってきたら復元する（`SessionTrash.checkRestores`）。
戻ったとみなすのは、元のパスにある物が `.jsonl` のファイルで、大きさが 0 でないときだけである。同じ名前の空のファイルやフォルダができただけでは復元しない。
見るのは、周期の回と、索引が論理削除したセッションの手元の本文を見たとき（`IndexerService` の `deletedSeen`）である。
印を外して `restored_at` に今の時刻を書き（印の時刻より前にはしない）、`sessions` の論理削除も外す。
行の `updated_at` は手元の行より必ず新しくする（上の「生き返らない。」）。
どちらも同期に載り、ほかの PC にも届く。
本文の索引は、索引の全件走査で作り直す。
あわせて、この PC が上げた本文（主線とサブエージェント）の控え（`file_sync` の自端末の行）を忘れる（`SessionTrash.forgetUploads`）。
控えが残っていると、上げる側（`sync/uploader.ts`）は中身が同じなので上げ直さず、30 日を過ぎて写しが消えた本文をほかの PC が降ろせない。
忘れた本文は、取り残しの走査が次の巡で上げ直す。
30 日より前に戻したときは、同じ鍵へ同じ中身を上書きするだけである。
降ろした写しの台帳（ほかの端末の行）には触らない。
印が外れた行を受け取った PC は、`sessions` の論理削除を外し（`alignSessionTrash`）、処理済みの印を忘れ、消した写しを降ろし直す（`RemotePuller.refetchSession`）。
降ろし直しは台帳（`file_sync`）に頼らず、写しの一覧を先頭から引き直して、そのセッションの項目の最新を降ろす。
印の後に一覧を見た PC や後から参加した PC は、印のある写しを飛ばしたので台帳に行が無い。行があっても、消えている間に上がった続きの指紋とは食い違うからである。
一覧の区切り（`filesSeq`）は動かさない。

**ゴミ箱へ移す方法（`platform/trash.ts`）。**
- macOS：`osascript -l JavaScript` で `NSFileManager.defaultManager.trashItemAtURLResultingItemURLError` を呼ぶ。Finder を操作しないので、自動操作の許可を求められない。
  移した先と誤りの受け口は null で渡す。JXA の `Ref()` を渡すと osascript ごと落ちる（終了コード 139、2026-10-16 に実測）。
- Windows：PowerShell で `Microsoft.VisualBasic.FileIO.FileSystem` の `DeleteFile`（フォルダは `DeleteDirectory`）に `SendToRecycleBin` を渡す。
- Linux：`gio trash`。
- パスは台本の文字列に埋めず、macOS は引数、Windows は環境変数で渡す。
- 成否は元のパスの有無で決める。コマンドが成功を返しても元のパスが残っていれば、移せなかったとして扱う。コマンドが失敗を返しても、元のパスが無くなっていれば移せたとして扱う。
- 1 回のコマンドには 30 秒の上限を付け、過ぎたら子プロセスを殺す。そのときも、元のパスが残っていれば移せなかったとして扱い、無くなっていれば移せたとして扱う。Windows の `SendToRecycleBin` は誤りのときにダイアログを出して返らないことがあり、サーバや CI がそこで止まったままにならないようにするためである。
- Windows の台本は文を `; ` でつなぐので、`if`、`elseif`、`else` は 1 つの文に書く。区切りの後に `elseif` を置くと、PowerShell は `elseif` をコマンド名と読んで落ちる。
- 試験は、macOS と Windows で本物のゴミ箱へ一時ファイルを移す（Windows は CI の windows のジョブが実機の代わり）。試験のファイルの名前は `hangar-trash-test-` で始め、ゴミ箱に残っても何のものか分かるようにする。

### 同じフォルダのプロジェクトをまとめる

0.6.1 までは PC をまたいで同じものと見なす仕組みが無く、どの PC もフォルダを登録するたびに新しい ID のプロジェクトを作っていた。
そのため、2 台が同じリポジトリを別々に登録すると、同期で同じ名前のプロジェクトが 2 つ並ぶ。
0.6.1 からは、登録のときに、ほかの PC から届いた同じプロジェクトへ結び付ける（下の「フォルダとプロジェクトの結び付き」）。それでも 2 つになったものは、この節のとおりまとめる。
届いた方の「場所を再指定」で、この PC で登録済みのフォルダを選ぶと、同じフォルダを指すプロジェクトが 2 つになる。
そうなると、新しいセッションの入り先が、DB の返す順で決まってしまう（同じ長さの場所の最長一致）。
0.6.1 から、これを 1 つにまとめる（`projects/registry.ts`）。

- 再指定（`POST /api/projects/:id/resolve` の `repoint`）は、選んだフォルダがこの PC で別のプロジェクトの場所かを確かめる（`rootConflict`。綴りの違い、NFC と NFD、Windows の大文字小文字は同じフォルダとして比べる）。
- 当たれば書かずに 409 を返す。本文は `ProjectSameFolderDto` で、まとめる方（`from`）、残す方（`conflict`）、まとめた後の PC ごとの場所と両方のセッションの数（`merged`、`mergePreview`）を持つ。
- 画面は確認を出し、承諾したら `from` のプロジェクトへ同じパスと `merge: true` を送り直す。サーバは `mergeProjects` でまとめ、残す方を返す。
- 相手がスクラッチなら、まとめずに理由だけで断る（`code` の無い 409）。

まとめる向きは、選んだフォルダがまだ選んだ方の場所でなければ、選んだ方を相手へまとめる。
既に両方の場所になっているとき（直す前の版で二重に結び付けたもの）は、セッションの多い方を残し、同じなら先に作った方（uuidv7 の id の小さい方）を残す（`mergeDirection`、`rankToKeep`）。どちらから選んでも同じ向きになる。

`mergeProjects` は 1 つのトランザクションで、次のことをする。表の形は変えず、どれも共有テーブルへのふつうの書き込みなので、同期で他の PC にも同じ結果が届く（Worker の互換に触れない）。

- セッション、TODO、成果物（`artifacts`）の `project_id` を残す方へ移す。TODO は残す方の後ろに、元の順で並べる。
- プロジェクトのメモは、残す方が空なら移し、両方にあれば残す方の後ろへ空行を挟んでつなぐ。まとめる方のメモは論理削除する。
- 場所は PC ごとに 1 つなので、残す方がその PC に場所を持てば残す方のものを保ち、持たなければまとめる方のものを引き継ぐ。行の `project_id` は書き換えず、残す方の行を作る（消した行があれば戻す）。`(project_id, device_id)` が一意で、消した行もそれに数えるからである。まとめる方の場所の行は論理削除する。
- まとめる方のプロジェクトを論理削除する。名前と状態は残す方のものを保つ。

まとめる前の行を持っていた PC の索引が、消えたプロジェクトへの紐づけを後から書き戻すことがある（同期は行ごとの後勝ち）。
`assignSessions` は、論理削除したプロジェクトに紐づいたままのセッションも未分類として拾い、その PC の場所の最長一致で紐づけ直す。

確認のダイアログは試作の B（まとめた後の姿を見せる）である。
見出しを「<名前> と 1 つにまとめますか」という問いにし、まとめた後のプロジェクトが PC ごとの場所を持つことを枠の中に並べる（この PC、名前の分かる PC、名前の分からない PC の順）。
中身は消えずに移るだけなので、危険の赤にはせず、青いボタンにする。既定のフォーカスはキャンセルに置く。
まとめ終えたら、画面はまとめた方を store から外し（サーバは消したプロジェクトを配らない）、残した方を入れ直して知らせる。まとめた方の画面を開いていれば、残した方の画面へ移る。

直す前の版が残した重複は、サーバが `ProjectDto.sameFolder`（残す方の id と名前）をまとめる方に付けて配る（`sameFolderPairs`）。
入口はホームの帯の「同じフォルダのプロジェクト」の群（場所の不明なプロジェクトの次）と、プロジェクトの画面のパスの行の札である。
どちらも同じパスで再指定を送り、サーバの 409 から同じ確認を開く。確認の形を 1 つにしておくためである。

新しいフォルダの作成場所（設定の `workspaceRoot`。2026-10-13 までの「プロジェクトの親フォルダ」）は任意である。
役割は、新しいプロジェクトのフォルダを作る場所と、直下の自動の登録だけである。
新しい利用者は空から始まり（`settings.json` が無いとき）、項目の無い古い `settings.json` は今までどおり `~/workspace` として読む。
`language` のほかに鍵を持たない `settings.json` も新しい利用者として読む（`loadSettings` の `isNewcomerFile`）。
アプリから起動すると、殻がサーバより先にこの形のファイルを書くからである（下の「初めての起動の値」）。
0.6.0-rc.1 はこれを古い設定と読んで `~/workspace` を入れ、初日から直下を自動で登録して「プロジェクト」の行を出さなかった。
殻の書き方を変える（`workspaceRoot` も書く）案もあったが、新しい利用者の決め方をサーバの 1 か所に置き、殻に作成場所の意味を持たせないためにサーバで見分ける。
空のときは、新しいプロジェクト、新しいセッションの新しいフォルダ、クイックセッションの昇格のどれも、作る場所をダイアログで選ばせ（デスクトップは Finder、ブラウザは打つ）、`parent` として送る（`projects/create.ts` の `parentDirOf`）。
空のまま `path.resolve('')` に渡すとサーバの作業ディレクトリを指すので、登録の関数はどれも空を「作成場所なし」として扱う（`registry.ts` の `hasWorkspaceRoot`）。

初日（この PC に場所の分かっているプロジェクトが 1 件も無いとき）は、Claude Code と会話したフォルダの候補から選ばせる（`projects/candidates.ts` の `folderCandidates`、`GET /api/workspace/candidates`）。
候補は、この PC の、まだプロジェクトに入っていない会話の作業フォルダを、git のリポジトリの根でまとめたものである（`git/repoRoot.ts` の `gitRootOf`。指示とメモリの欄の自動メモリの場所と共有する）。worktree は元のリポジトリへまとめ、まとめた worktree の数を添える。
ホームフォルダとその上、作成場所そのものとその上（登録が断るため。2026-10-15）、一時フォルダ、hangar のスクラッチ、隠しの名前を含むもの、無くなったフォルダ、登録済みの場所とその下は除く。リポジトリの根がホームかその上にあるとき（ホームを git で管理しているなど）は、まとめずに作業フォルダのまま見る。
並びは会話の数の多い順で、作成場所が空で過半（2 件以上）が同じ親にあるときだけ、その親を作成場所の候補にする（親がホームのときは出さない）。
選んだものは `POST /api/workspace/register` でまとめて登録し、最後に未分類の会話を紐づけ直す。
作成場所の候補を選んだときは、先に作成場所として保存する（保存のときに直下が登録されるので、ダイアログではその行を外せないチェックにする）。

同じ候補と登録は、端末の CLI からも使える（2026-10-15、セットアップのすゝめの土台）。
導入のときに Claude Code が利用者の環境を診断し、散らばった会話のフォルダをプロジェクトに登録する道具である。
`hangar project candidates`、`hangar project add <パス…>`、`hangar project remove <パス|id>`、`hangar workspace set <dir>`、`hangar workspace unset` の 5 つで、どれも動いているサーバの API を鍵（Bearer）付きで呼ぶ（`packages/cli/src/project.ts`）。
CLI はサーバを起こさない。
止まっていれば終了の符号 2 で、`--json` のときは標準出力に `{"error":"server_down","hint":"hangar start"}` を出す。
一部でも失敗なら 1、全部成功なら 0 である。
登録済みのパスは失敗にせず `already` で返す（冪等）。
Claude は Bash から叩く（TTY が無い）ので、対話の y/n は作らない。
承諾は Claude の会話の中で取り、書く前の見せ方は `--dry-run` だけにする。
問いを飛ばす旗（`--yes`）も、入れ子を分ける旗（`allowNested`）も作らない。
入れ子を分けるかは、利用者がアプリで決める。
`remove` はアプリの「一覧から削除」（resolve の `unlink`）と同じ経路で、会話は未分類に戻るだけで本文もフォルダも消えないことを必ず出す。
`workspace set` の `--trust` は、作成場所を Claude Code の信頼済みにする（「フォルダの信頼」の節）。すゝめが同意を取ってから付ける。信頼を書けなかった書く先があれば、作成場所の保存は済ませたうえで 1 を返す。同意は残るので、そのときも「同意は記録しました」の 1 行を出す（JSON では `consentRecorded`）。
`workspace unset` は作成場所を空にする。
空は設定の既存の意味（「決めていない」）なので足した。
登録済みのプロジェクトは残り、直下の自動の登録が止まる。

候補には、CLI のための項目を足した（初日の画面の項目は変えない）。
`recentTitles`（最近の会話の題、無ければ要約の 1 文、無ければ最初の発言の冒頭を、新しい順に 3 件まで）、`isGit` と `gitRemote`、`enclosedBy`（ほかの候補か登録済みのプロジェクトの下にあるときの、いちばん深いもの）、`cloudSynced`、`notes` である。
`cloudSynced` は、macOS の iCloud（`~/Library/Mobile Documents` の下、実体がそこにあるもの、「デスクトップと書類」を iCloud に入れたときのデスクトップと書類）と、Windows の OneDrive（環境変数 `OneDrive`、`OneDriveConsumer`、`OneDriveCommercial` の下と、ホームの直下の OneDrive の名前のフォルダの下）を見る（`projects/candidateHints.ts` の `cloudSyncedOf`）。
`notes` は機械の符号の配列で、`desktop-direct` と `downloads-direct`（デスクトップとダウンロードそのものか直下。Windows では OneDrive の置き場の下の Desktop と Downloads も見る。既知のフォルダを OneDrive に移すと、デスクトップの実体は `~\OneDrive\Desktop` になるため。2026-10-15）、`not-git`、`stale-30d`（最後の活動が 30 日より前）、`single-session`（会話 1 件）である（`candidateNotes`）。
どちらの判定も、パスの形と差し替えられる問い合わせだけで決める純粋な関数で、Windows のパス（区切り、ドライブ文字、大文字小文字）も試験する。
上の段には、この PC の未分類の会話の総数（`unassignedTotal`）と、いまの作成場所（`workspaceRoot`、空なら null）を添える。

書かない試し（`dryRun`）は、登録と同じ関数を 1 つのトランザクションの中で走らせてから巻き戻す（`db/notify.ts` の `tryWrites`）。
検証も、同じ一括の前の行の影響（同じパスの 2 回目は登録済み、前の行の下は入れ子）も本物と同じになり、紐づく会話の数も本物の紐づけ直しを数える。
行と `changes` は巻き戻るので同期は何も送らない。
中で溜まった行の知らせ（`write` と `touch`）は配る前に捨てるので、画面へ配る層にも届かない（`write` は巻き戻りを見分けて落ちるが、`touch` は見分けられないため）。
前のトランザクションの、まだ配っていない知らせは捨てない。
外側のトランザクションの中からは呼べない（巻き戻しが外側の確定に呑まれるため）。

作成場所を決めていれば、起動時に、その直下で cwd がそのディレクトリ以下の Claude セッションが 1 つ以上あるものを自動でプロジェクトにする。
ただし、ほかの PC から届いた同じプロジェクト（下の節の強い一致と弱い一致）があれば、新しく作らずにそれへ結び付ける（0.6.1）。
セッションのない直下ディレクトリは、新しいセッションのダイアログの検索と、作成のダイアログの未登録の一覧にだけ出す。
起動した後に、直下の新しいディレクトリでセッションが現れたら、起動時と同じ規則でその場でプロジェクトにする。
ルート外の cwd のセッションは「未分類」に入れ、後から手で紐づけられる。
起動した後にワークスペースの外の cwd で未分類のセッションが現れても、知らせは流さない（2026-10-10 に外した。理由は「注意と知らせの出し分け」の節）。
ディレクトリが戻ってルートが解決に戻ったら、その間に溜まった未分類のセッションを紐づけ直し、変わったセッションとプロジェクトを配る。

### フォルダとプロジェクトの結び付き（0.6.1）

フォルダをプロジェクトとして登録する流れを作り直した（2026-10-14 に利用者が決めた）。
この節はサーバの側である。画面のうち、新しいセッションと新しいプロジェクトのダイアログは「始める場所：新しいフォルダと未登録のフォルダ」と「Projects」の節に書いた（`folder.inspect` の事前の問い合わせ）。まとめて登録のダイアログの「フォルダの中から」は下の「まとめて登録の画面」に書いた。
穴は 2 つあった。

- 穴 1：登録済みのプロジェクトの下のフォルダを登録すると、黙って別のプロジェクトに分かれていた。
- 穴 2：ほかの PC で登録したプロジェクトが同期で届いていても、この PC で同じフォルダを登録すると、新しい ID のプロジェクトを作っていた。

フォルダとプロジェクトの関係は 3 つに分ける（`projects/link.ts`）。どれもこの PC の場所の行との比べで、綴りの違い（NFC と NFD、Windows の大文字小文字）は同じフォルダとして比べる。

- 登録済み（`registeredAt`）：フォルダがこの PC のプロジェクトの場所そのもの。
- 別のプロジェクトの中（`enclosingProject`）：フォルダがこの PC のプロジェクトの場所の下にある。いちばん深いものを返す。数えるのは場所の見つかっているもので、スクラッチは数えない（セッションの紐づけの最長一致と同じ行である）。
- 結び付く候補（`linkCandidateFor`）：この PC に場所の無いプロジェクト（場所の行が無いか、見つからないもの。消したもの、スクラッチ、アーカイブは入れない）のうち、git の remote が同じもの（強い一致）と、名前が同じで remote が食い違わないもの（弱い一致）。
  強い一致を先に選び、同じ強さが複数あれば新しく書かれたものを選ぶ。
  名前は NFC にそろえ、大文字小文字を無視して比べる。
  名前だけの一致も既定で結び付ける（利用者の答え）。remote がどちらにもあって違うときは、名前が同じでも候補にしない。
  アーカイブを入れないのは、使わないと決めたものを黙って起こさないためである。

remote は `projects.git_remote`（版 24）に、正規化した形（`github.com/owner/repo`）で持つ（`git/remote.ts` の `normalizeRemote`）。
ssh（`git@host:owner/repo.git`、`ssh://git@host:22/owner/repo`）と https を同じ形に読み、資格情報とトークン、ポート、問いと断片、末尾の `.git` は入れない。ホストは小文字にし、比べるときは大文字小文字を無視する。
手元のパスの remote（`/srv/repo.git`、`file://`）は、ほかの PC と比べる意味が無いので null にする。
読むのはフォルダの直下の `.git` の config だけで、子プロセスは起こさない。origin を先に、無ければ最初の remote を使う。worktree は元のリポジトリの config を読む。
リポジトリの中の下のフォルダには remote を付けない。モノレポの下のフォルダを別のプロジェクトにしたとき、親のリポジトリの remote で強い一致にしないためである。
埋めるのは、場所を持つ PC が、登録（`insertProject`）、結び付け、索引の起動（`fillProjectRemotes`）のときで、空のものだけである。
埋まっている値は書き換えない。PC ごとに remote が違うと（フォークなど）、起動のたびに書き合いになるからである。
同期は行を JSON の payload のまま運ぶので、クラウド（Worker）にマイグレーションは要らず、互換の版も変えない。列を持たない古い PC は、適用のときに自分の表に無い列を捨てる。

結び付けは「場所を再指定」（`resolveProject` の `repoint`）と同じ書き込みで、その下の未分類の会話も紐づける（`registry.ts` の `linkProjectHere`）。プロジェクトの remote が空なら、そのフォルダの remote で埋める。名前は変えない。
消えるものが無いので、確認の 1 枚は挟まない。

`registerProjectDir`（`projects/create.ts`）は、次の順に見る。

1. 同じフォルダが登録済みなら、そのプロジェクトを返す（アーカイブなら Active に戻す）。結び付け先（`linkTo`）を渡していて、それと違うプロジェクトの場所なら 409 で断る（まとめるのは「場所を再指定」の確認から）。
2. 登録済みのプロジェクトの下なら、`allowNested` を明示したときだけ先へ進む。無ければ `ProjectNestedError`（409）で包むプロジェクトを返す。古い画面からの登録で、黙ってプロジェクトが分かれないためである。分けても、いまある会話は包む方に残る（`assignSessions` は未分類しか動かさない）。分かれるのはこれからの会話である。
3. `linkTo` を渡していれば、新しく作らずにそのプロジェクトのこの PC の場所にする。先が無い、消した、スクラッチなら 404、この PC で既に場所が見つかっていれば 409（その場所を黙って動かさない。動かすのは「場所を再指定」から）。
4. どれでもなければ新しく作る。

作成場所の直下の自動登録（`syncProjectsFromWorkspace`、`registerWorkspaceChildOf`）は、結び付く候補（強い一致と弱い一致）があれば、新しく作らずに結び付ける。remote が食い違うときは結び付けず、今までどおり作る。
`syncProjectsFromWorkspace` は、作った id（`created`）と結び付けた id（`linked`）を返す。

画面が使う口は次のとおりである。DTO は `packages/shared/src/api.ts` にある。

- `GET /api/workspace/children?parent=<パス>`：親の直下の隠しでないフォルダを、Finder と同じ並び（数字は数の順、大文字小文字は区別しない）で返す（`projects/folders.ts` の `workspaceChildren`、`WorkspaceChildrenDto`）。
  会話の無いフォルダも並べる。行は名前、パス、git の印（直下に `.git` がある）、worktree の印、remote、この PC の会話の数と最後の活動、登録済み、別のプロジェクトの中、結び付く候補を持つ。
  ほかの PC の会話は数えない（パスがその PC のものだからである）。
  git でなく中に git のフォルダを持つもの（`~/src/clients` など）は、1 段下の子も返す（さらに下は開かない）。
  結び付く候補は、登録済みと worktree の行には付けない。同じプロジェクトに結び付く行が 2 つ以上あれば、名前がプロジェクトと同じ行（無ければ先の行）にだけ付ける。1 つのプロジェクトがこの PC に持てる場所は 1 つだからである。
  親そのものがプロジェクトの場所かその下なら、包むプロジェクトを `enclosing` に入れる（まとめて登録の黄の帯）。
  親は `~` をホームに直す。相対パス、無いフォルダ、ファイルは 400 で断る。読めないフォルダ（macOS の保護されたフォルダなど）は子が無いものとして扱う。
- `GET /api/workspace/inspect?path=<パス>&name=<名前>`：選んだ 1 つのフォルダの事前の問い合わせ（`inspectFolder`、`FolderInspectDto`）。新しいセッションと新しいプロジェクトのダイアログが使う。
  登録済みか、別のプロジェクトの中か（その場所からの相対パスも）、結び付く候補があるかを返す。`name` を渡すと、弱い一致をフォルダの名前ではなくその名前で見る。
- `POST /api/projects` の `{ kind: 'dir' }` は `allowNested` と `linkTo` を受ける。入れ子で `allowNested` が無ければ 409 で、本文は `ProjectNestedDto`（`code: 'project_nested'` と包むプロジェクト）である。
- `POST /api/workspace/register` は、今までの `{ paths }`（どれも新しく作る）のほかに、`{ items: { path, linkTo?, allowNested? }[] }` を受ける。どちらか一方だけで、両方は 400 である。
  結び付けたものの id を `linked` に返す。入れ子で `allowNested` の無い行、結び付けられない行は `failed` に理由を添えて入る。最後に `assignSessions` を呼ぶ。

登録済みのプロジェクトの下のフォルダから始めるときは、セッションは親のプロジェクトに入れ、Claude Code はそのフォルダで起こす（利用者の答え）。
起動の引数 `LaunchParams` に作業の場所 `cwd` を足した。省けばプロジェクトの場所で起こす。
`cwd` はプロジェクトの場所の下（場所そのものを含む）に限り、相対パスと外は行を作る前に 400 で断る（`run.launch.cwdOutside`）。外を許すと、そのプロジェクトのセッションがプロジェクトの外で動き、場所の最長一致の紐づけとも食い違うためである。スクラッチでは使わない。
`cwd` は run の `launch_params` に残る。画面は worktree と同じく、前回値に残さない。

### まとめて登録の画面（0.6.1）

初日の候補のダイアログ（`ProjectCandidatesDialog`）を、まとめて登録のダイアログにした（2026-10-14 に利用者が選んだ試作の推す案）。
新しいダイアログは作らず、頭の切り替えで「Claude Code と会話したフォルダ」と「フォルダの中から」の 2 つの見方を持つ。
選んだものは見方ごとに持ち、送るのは開いている見方のものだけである。
開く場所は 3 つで、ホームの始める前の確認の「プロジェクト」の行（会話したフォルダ）、設定のツールの「プロジェクトの登録」の 2 つのボタン（「Claude Code と会話したフォルダから…」と「フォルダの中から…」）、新しいプロジェクトのダイアログの「既存のフォルダを登録」の下のリンク「フォルダの中からまとめて選ぶ…」である。
最後のものは、利用者がそのダイアログから移ると選んだので、入力のあるダイアログでも入れ替える（`project.candidates.open` の `source: 'folder'`）。

「フォルダの中から」（`views/FolderBrowse.tsx`）は、頭に親フォルダの欄と「選ぶ…」（デスクトップだけ。Finder）を置く。
開いた時点で、作成場所があればそれを、無ければ会話したフォルダの多い親（候補の `suggestedRoot`）を入れ、すぐ直下を読む（`GET /api/workspace/children`）。
どちらも無ければ空の欄で「親フォルダを選んでください」と言う。
親は欄の Enter と、欄を離れたときに読み直す。答えは Store の `workspaceChildren` に入り、後から頼んだ親の答えだけを採る。
親を変えたら、前の一覧の選択と絞り込みは捨てる。

一覧は直下の隠しでないフォルダを名前順に並べ、列はチェック、名前、git の印、会話の数（0 は「—」）、最後の活動である。
名前の下の 1 行で、押すと何が起きるかを言う。

- 登録済み：外せない灰のチェックで、「すでにプロジェクトです（名前）」。送らない。
- worktree：「<元のリポジトリ> の worktree です」。元は同じ remote を持つ兄弟の行から引き、無ければ「git の worktree です」。
- 別のプロジェクトの中：「<名前> の中のフォルダです。登録すると、これからの会話は <名前> から分かれます」。選んだら `allowNested` を付けて送る。
- git でなく中に git のフォルダを持つもの：「git のフォルダ N 件を含みます。開いて選べます」。開くと 1 段下を選べる。親と子は同時には選ばない（親を選べば子を外し、子を選べば親を外す）。
- ほかの PC のプロジェクトと結び付くもの：理由と行き先を言う（「work-pc の infra と同じリポジトリです。この PC の場所として結び付けます」、名前だけの一致は「同じ名前です」、この PC で場所が見つからなくなったものは「この PC で場所が見つからない <名前>」）。既定は結び付けで、行の「新しく作る」で行ごとに切り替え、「結び付ける」で戻す。選んだら `linkTo` を付けて送る。別のプロジェクトの中の行は、入れ子を先に言い、結び付けの候補は出さない。

開いた時点では、何もチェックしない（利用者の答え）。
「すべて選択」は一覧の頭の 3 状態のチェックで、件数（選んだ数 / 選べる数）と「git のフォルダだけ」を添える。
対象は選べる行だけで、登録済み、作成場所の自動の登録に入るもの、worktree、別のプロジェクトの中は入れない。
開いたフォルダは、親ではなく 1 段下の行を対象にする。
「git のフォルダだけ」で隠した行は送らない。
一覧の下に「新しく作る N 件、ほかの PC のプロジェクトに結び付ける M 件」を出す。

親そのものが登録済みのプロジェクトの場所かその下なら（`WorkspaceChildrenDto.enclosing`）、一覧の上に黄の帯で「<名前> の中のフォルダです」と 1 回だけ言い、行ごとには言わない。
この帯のあるときは、中の行も「すべて選択」の対象にする（帯で言ったので）。

作成場所が空で、読めた親がホームフォルダと根でなく、帯も無いときだけ、足元に「<親> を新しいフォルダの作成場所にする」を出す。
仕様の案は既定で入れるだったが、入れると直下の会話のある行が自動の登録でチェックされ、開いた時点で何もチェックしない決まり（利用者の答え）と食い違うので、既定では入れない（試作の推す案の姿とも同じ）。
入れると、直下の会話のある行は外せないチェックにし（保存のときにサーバが自動で登録するため。結び付く候補はサーバが自動の登録で結び付けるので、「新しく作る」は出さない）、そのフォルダの 1 段下は選ばせない（そのフォルダのプロジェクトの中になるため）。
送るときは、先に作成場所を保存してから `POST /api/workspace/register` の `items` で登録する（会話したフォルダの見方も `items` で送る）。
結び付けたものがあれば、知らせに「うち N 件は、ほかの PC のプロジェクトに結び付けました」を添える。

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
| 1 つのプロジェクト | 左にホームと同じ部品のセッションの一覧、右に TODO、指示とメモリ、アーティファクト | 「プロジェクト詳細」 |
| セッション画面 | 実行中はターミナルと、右の列の現在の札と目次。終わった後は見出しの下の 1 行、トランスクリプト、右の列の要約の札と目次 | 「セッション詳細」 |
| 設定 | 左の目次で 6 つ（殻の中は更新を加えた 7 つ）の節を切り替える | 「Settings」 |
| 知らせ（画面の外） | 右下の札は入力待ちだけ。今日のものはホームの帯、画面のどこにも無い事実はヘッダーの注意に入り、トーストは操作の結果だけを言う | 「入力待ちの知らせ」「注意と知らせの出し分け」 |
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
   地の文の語と文体は用語集 17 章に従う（2026-10-16）。寄せ方は VS Code・macOS の日本語版並みで、開発者向けの語（プロンプト、シークレット、インデックス、デフォルト、ユーザー）はカタカナのまま使い、システムを人のように書かず、硬い漢語の受け身にも寄せない。
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
- 問いで待っている最中に Done や Archived にしたセッションは、Claude が止まらず live が `waiting` のまま残る。
  利用者はもう答えないと決めているので、入力待ちには数えず、休み（アイドル）として扱う。
  利用者の注意を求める数や印（件数、要対応、バッジ、「入力待ち」の札や色、待った時間）は、どれも shared の `quietLive` を通した動きから決める。
  通す場所は、UI の `store.ts` の `awaitsAnswer`、`liveFilterOfSession`、`shownLive` と、サーバの検索の `liveOf` である。
  `live === 'waiting'` を直に見て入力待ちと数えない。
  動いている事実は変わらないので、実行中の側（休み）には残り、サイドバーの「動いている」には行も残る。
  行の点は休みと同じ控えめな色で、「入力待ち」の語も「待ち N 分」も付けない。
  Paused は戻ってくるものなので、入力待ちのまま数える。
  セッション画面は本当の動き（`session.live`）を出す。問いは実際に出ているからである。
- メイン会話はアイドルで、サブエージェントやバックグラウンドの作業だけが進んでいるときは、「バックグラウンドで作業中」（Working in background）と書く。公式の「バックグラウンドセッション」とは別の概念なので、この意味に使わない。
- 「状態」は動きにだけ使い、札の意味に使わない。「ステータス」は札にだけ使う。
- セッション画面の言葉：右の列の上の札は「現在」（Now）の札、その下は「目次」（Outline）、見出しの右端の (i) のポップオーバーは「詳細」、終わったセッションの見出しの下の事実の行は「見出しの下の 1 行」、右の列の上の要約は「要約の札」と呼ぶ。「いま」「情報の行」「現在と目次の境目」は使わない。トランスクリプトの先頭に置いていた「冒頭の 1 枚」は 2026-10-16 にやめた。
- トランスクリプトの細かい項目まで出す切り替えの語は「詳細表示」（英語は Raw。利用者の決定、2026-10-10）で、「生の記録」は使わない。

#### 決めた語

利用者が決めた語と、公式の語に寄せた語のうち、旧い言い方と取り違えやすいものを並べる。

| 概念 | 日本語 | 英語 | 使わない語 |
| --- | --- | --- | --- |
| 会話の記録（JSONL） | トランスクリプト | Transcript | 本文、会話の記録、生の記録 |
| サブエージェントを動かす本体の会話 | メイン会話 | Main conversation | 主線、指揮役 |
| 利用者が書く覚え書き | ノート | Note | メモ（公式の memory は「メモリ」）。プロジェクトのノートは 2026-10-11、セッションのノートは 0.4.0 で外したので、いまは画面に出ない |
| 返答を終えて次の指示を待つ状態 | アイドル | Idle | 休み、待機 |
| 権限の扱い方 | 権限モード。値は Manual、Accept edits、Plan、Auto、Bypass permissions、Don't ask | Permission mode | 都度たずねる、編集は任せる、計画だけ、確認なし |
| Claude の利用上限 | 使用制限（5 時間、週）、使用率 | Usage limit、Percent used | 利用上限、枠、セッション制限 |
| ツールの 1 回の呼び出し | ツール呼び出し | Tool call | 手、N 手目 |
| 要約を作る道具 | 要約エンジン | Summary engine | 要約器 |
| 提案が溜まる区画とタブ | 確認待ち（中の 1 件は「提案」） | Pending review（Suggestion） | 確かめる |
| Paused の日と時刻 | リマインダー、リマインダーの日付、リマインダーの時刻、今日のリマインダー | Reminder | 戻る日、戻る時刻、今日戻る、再開予定 |
| 外部ターミナルの Claude を hangar へ移す | hangar に移動 | Move to Hangar | 引き取る |
| 新しいプロジェクトのフォルダを作る場所（任意） | 新しいフォルダの作成場所 | Location for new folders | ワークスペース、プロジェクトルート、プロジェクトの親フォルダ（2026-10-13 まで）、置き場 |
| プロジェクトに属さないセッション | クイックセッション | Quick session | スクラッチ |
| 互換の見張りで変わった点、見張る対象 | 変更点、確認項目 | Change、Check | ずれ、差異、契約、対象 |
| 上書きの前に残す写し | バックアップ | Backup | 控え |
| 届いた設定を書く | 適用 | Apply | 取り込む |
| 上限や枠が戻る | リセットされる | Reset | 戻る（「戻る」は画面を前へ戻す操作だけに使う） |
| hangar が動く計算機 | PC（この PC、他の PC） | Computer | 端末、デバイス |
| 文字を打つ窓 | ターミナル | Terminal | 端末 |
| hangar の外のターミナル | 外部ターミナル | External terminal | 外のターミナル |
| クラウドの金額 | 料金、請求額 | Billing | 費用（Claude の金額は「コスト」） |
| 画面で選んで書き出し、`hangar config apply` が読む適用の項目 | 適用内容 | Changes to apply | 適用の指示書、指示書 |
| クラウドの URL、要約エンジンの URL | 接続先 | Destination | 宛先（「宛先」はセッションの 1 行、SendMessage の名前だけに使う） |
| サーバー | サーバー | Server | サーバ |
| 別の PC | 他の PC | Other computer | ほかの PC |
| 他の PC から受信したスキルなどを書き込む許可 | 承認 | Approve | 承諾 |
| ヘッダーのベルと、その一覧 | 通知 | Notifications | 注意 |
| 右パネルの、ユーザーの発言の冒頭の見出し | プロンプト | Prompt | 依頼 |
| クイックセッションをプロジェクトにする操作 | プロジェクトにする | Promote to project | 昇格 |
| 受信、保持 | 受信する、保存する、削除されません | Receive, Keep | 届く、残る（2026-10-17、用語集 18 章） |

場所はディレクトリ／パスに統一する（2026-10-16、用語集 17 章。それまでのフォルダとディレクトリの使い分けはやめた）。
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
初めての起動では OS の表示言語に合わせ、日本語なら `ja`、それ以外は `en` を書く（下の「言語の決め方」）。
PC ごとの設定なので、クラウドへは同期しない。
読み書きはほかの設定と同じ `GET /api/settings` と `PATCH /api/settings` で行い、辞書に無い言語は 400 で断る。
手で書き換えた `settings.json` の知らない値は、読み込みのときに言語の無い設定と同じ日本語に読み替える（下の「言語の決め方」の 2）。
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

#### 言語の決め方

殻の札と起動画面、サーバ、UI、Windows の CLI の入口（`launch-cli`）は、同じ決め方で同じ値を使う。
読み口は、Node の側が `packages/server/src/i18n/osLanguage.ts` の `decideLanguage` と `osDisplayLanguage`、殻の側が `bootfail.rs` の `decide_language` と `os_language` で、両方の試験が同じ表（`packages/server/src/i18n/language-cases.json`）を読む。

1. `settings.json` に `language`（`ja` か `en`）があれば、それを使う。
2. `settings.json` はオブジェクトとして読めるが `language` が無い（知らない値も含む）なら、日本語にする。
   OS に合わせる前（0.2.0 の前）から使っている人は、項目が無いまま日本語で見ていたので、変えない。
3. `settings.json` が無い（初めての起動）か読めなければ、OS の表示言語にする。日本語なら `ja`、それ以外と読めないときは `en` である。

OS の表示言語は、macOS では `defaults read -g AppleLanguages` の先頭（`.app` は `LANG` を持たない）、Windows では表示言語で読む。
殻は `GetUserPreferredUILanguages` の先頭、Node は PowerShell の `[Globalization.CultureInfo]::CurrentUICulture.Name` を読む。
どちらも地域の書式（`Intl` の既定の locale）は見ない。英語の表示で地域だけ日本の人に、日本語の画面を出さないためである。
ほかの OS は `LC_ALL`、`LC_MESSAGES`、`LANG` の順に見る（`C` と `POSIX` では決めない）。
環境変数 `HANGAR_OS_LANGUAGE`（`ja` か `en`）があれば、OS の代わりにその値を使う。試験と、英語の OS を真似て画面を確かめるときのためで、殻と Node の両方が読む。

初めての起動の値を `settings.json` に書くのは、最初に動いたものである。

- アプリから起動したときは殻が先に動く。殻は起動の頭（サーバを起こす前）で、`settings.json` が無ければ `{"language": …}` だけのファイルを作る（`ensure_language`。`create_new` で作るので、同じ時に作られたファイルは上書きしない）。サーバはこれに既定の値を足して読み（言語だけのファイルなので、作成場所は新しい利用者と同じく空にする）、起動が通ってから自分の形で書き戻す。
- CLI（`hangar start`、開発の `npm run dev`）から起動したときはサーバが先に動く。サーバは設定の読み込み（`loadSettings`）で 2 と 3 を埋め、起動が通ってから `persistSettings` で書く。`hangar setup` も同じ読み込みを通って書く。
- `launch-cli` は読むだけで書かない。Node が見つからないときの文を、同じ決め方の言語で出す。

どれが先に動いても、OS の表示言語が同じなら同じ値になる。
設定がある人のファイルには殻は触らない（2 の日本語は、サーバが起動のあとに書き戻す）。

殻が自分で出す文も、同じ言語で出す。
起動の失敗の札と詳細（上の「起動の失敗の札」）、待っている間の文（`boot_state` の `lang`）、設定の同期と連携の書き込みの結果の文（`configapply.rs` と `approve.rs` の `words`。CLI が返す失敗の文は CLI の日本語のまま）、承諾の窓の頁の文（`loading/approve.js`。辞書の `approve.*` の写し）、入力待ちの通知の題と本文が空のときの代わりの文（`notify::waiting`）である。

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
Claude に渡す指示の段（`launch.injection.body`、`status`、`live`）と、要約器への指示（`summary.prompt.system`）がそうである。
指示の段はどれも行の終わりで切れていて、段ごとにつなぐだけなので、つないでも文の語順は崩れない。
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
| `launch.injection.body` | `projectName`、`projectPath`、`todos` | `--append-system-prompt`（常に足す段） |
| `launch.injection.status` | なし | `--append-system-prompt`（区切りの問いの段、`askStatusAtEnd`） |
| `launch.injection.live` | なし | `--append-system-prompt`（ターンの意図と手の説明の段、`liveHints`） |

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
行は状態の点、名前、入力待ちなら待った時間（「待ち 4 分」）で、いま見ているセッションは白い行にする。
同じファイルを別のセッションと編集している行は、名前の後ろに琥珀の印だけを置き（語は出さない）、乗せると相手の名前を出す。並びは変えない。並べるのは 8 件までで、超えたら「ほか N 件」を出し、押すと Home へ行く。動いているものが無ければ節ごと出さない。
行は掴んで上下に動かせる。キーボードでは、行に焦点があるときに ⌥↑ と ⌥↓ で 1 つずつ動かす。並びは端末ごとに localStorage（`sidebar.order`）に残す。
掴んで動かすのは HTML のドラッグ（`draggable`、`dragover`、`drop`）ではなく、ポインタのイベントで作る。デスクトップのアプリでは、Finder からファイルを落とすために殻が窓のドラッグを受けており（tauri-runtime-wry がドラッグの処理に常に済んだと返す）、窓の中のドラッグでも `dragover` と `drop` が画面へ届かないからである。押して 4px 動くまではクリックとして行を開き、越えたら並べ替えに入って、離したあとの click では行を開かない。途中の Esc で並べ替えをやめる。
Esc は窓で受ける。WebKit（Safari と Tauri の殻）はリンクを押しても焦点を移さず、行が Esc を受け取らないからである。
並べ替えの動きは 5A（2026-10-16 に決めた）で、入る場所の線は出さない。
掴んだ行は白い面（不透明に近い白）と影（`--glass-drop`）と 102% の拡大で浮き、浮くまでは `--dur-fast` である。
浮いた行はポインタに付いて縦だけ動き、両端では行 1 つ分の手前より 8px 先で止まる。
ほかの行は、入る場所に合わせて行の間隔だけ `--dur-fast`、`--ease-out` で滑ってよける。行の間隔は並んだ行の上端の差で測るので、畳んだ帯（26px の行）でも同じに動く。
離すと、浮いた行は空いた場所へ `--dur-fast` で収まりながら影と拡大を消し、収まってから並びを確定する（`sidebar.order`）。確定とずらしの解除は 1 回の描画にまとめ（`flushSync`）、行が入れ替わる前後でちらつかせない。
Esc とポインタの取り消し（`pointercancel`）では、同じ動きで元の席へ戻り、並びは出さない。
並べ替えの途中の Esc は、ほかの Esc の受け手（ダイアログの殻、ポップオーバー、`Root` の `overlay.close`、後から窓に付いた捕捉）へ届かせない（`stopImmediatePropagation`）。届くと、取り消しと同じ打鍵でダイアログを閉じたり画面を戻したりするからである。
並べ替えの途中の形は、席の添字ではなく行の id で持つ。並べ替えの間にも、ほかのセッションが動き始めたり抜けたりして、節の行は増えたり消えたりするからである。
掴んでいる間は、ずらす行と入る席を描くたびにいまの行から引き直し、前の行が増減して掴んだ行の席が動いた分は、浮いた行のずれに足してポインタに付いたままにする。
離したときに、入る先を「指している行の id とその前か後ろか」として決め、収まってからの確定はその id で行う（`moveId`）。
掴んだ行か指した行が途中で一覧から消えたら、並べ替えを捨てて並びは出さない。
並べ替えの間（掴んでいる間と収まる間）は、⌥↑ と ⌥↓、`.`、右クリックを受けない。
動かすのは CSS の `translate` で、`transform` ではない。`scale` と重ねたときに、動いた幅まで 102% にならないためである。滑りの transition は並べ替えの間（`data-sorting`）だけ持たせ、確定の描画で滑らずに置く。
reduced motion では長さが 0 になり、拡大もしない。収まりの待ちも `motionMs('--dur-fast')` で読むので 0 になり、離したその場で確定する。
行を右クリックするか、行に焦点があるときに `.` を押すと、その行のセッションのメニューを出す。中身は一覧の行の「⋯」と同じ 1A のメニューである（「セッションのメニュー」の節）。2026-10-06 に決めた「停止」だけのメニューを、2026-10-16 にこれへ替えた。
メニューを開いている行には印（`data-menu`）を付け、どの行のものかを見せる。面は `views/sessionMenu.tsx` の `SessionMenuPop`（中身は `views/primitives/MenuButton.tsx` の `MenuPop`）で、ボタンを持たずに、押した点か行の矩形に吊るす。「ほか N 件」に隠れた行には届かない。
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
入力待ちを窓の外へ知らせるために、同じ出どころには通知を出す権限（`allow-notify-waiting`）、もう待っていない通知を外す権限（`allow-notify-prune`）、通知の許可を求める権限（`allow-notify-request`）、通知の許可の状態を読む権限（`allow-notify-status`）、Dock のバッジに数を出す権限（`core:window:allow-set-badge-count`）の 5 つだけを別に与える（`capabilities/remote-notify.json`）。
前の 4 つは殻が自分で持つコマンドで、`build.rs` の AppManifest に並べたものだけが権限になる。
殻の命令は 7 つだけ持つ（`src-tauri/build.rs` の一覧と `lib.rs` の `#[tauri::command]`）。
入力待ちの知らせの 5 つ（`notify_waiting`、`notify_prune`、`notify_feed`、`notify_request`、`notify_status`）は上に書いたとおりで、フォルダ選択の `pick_folder` は新しいプロジェクトのために頁へ許し、残りの 3 つは障害のときの操作である。
殻は命令を `invoke_handler` の 1 か所でまとめて登録する。
2 度呼ぶと後のものだけが残り、先に並べた命令が呼べなくなるからである。
UI の出どころには、設定の同期の適用の `apply_config_sync` と世代へ戻す `restore_config_sync` だけを別に与え（`capabilities/remote-config-apply.json`。どちらも殻が承諾の窓で見せてから CLI を走らせる。「設定の同期の作り直し」の節）、連携の書き込みの `setup_integration` だけを別に与え（`capabilities/remote-setup.json`）、フォルダ選択の `pick_folder` だけを別に与え（`allow-pick-folder`、`capabilities/remote-pick-folder.json`）、ログを開く `open_log` とアプリを再起動する `restart_app` だけを与え（`capabilities/remote-shell.json`）、起動画面（殻の中の頁）には、起動の様子を引き取る `boot_state`、札を描いた知らせの `boot_card_shown`（殻はこれを受けてから 1 度だけ更新を確かめる）、試験のための書き出しの `boot_probe`（殻が `HANGAR_BOOT_PROBE` を持って起きたときだけ書く）、起動をやり直す `retry_boot`、`open_log`、札の中の更新の `update_status`、`update_check`、`update_download`、`update_install` だけを与える（`capabilities/boot-screen.json`）。
`open_log` は決まったファイル `~/.agent-hangar/desktop.log`（無ければ空で作る）を `open`（Windows は `rundll32.exe url.dll,FileProtocolHandler`、サーバが URL を開く形と同じ）に渡すだけで、呼び手からパスは受け取らない。
`desktop.log` には殻の行（`<ミリ秒> [desktop] …`）とサーバの標準出力と標準エラーが入る。
サーバは子の起動のときに追記で開いたファイルへ書く。
殻は 1 行を本文と改行の 1 つの塊にして、追記で開いたファイルへ 1 回の write で書き、殻の中の糸どうしは錠でも並べる（`src/logfile.rs` の `append_line`）。
以前は `writeln!` で書式の部品ごとに write が出て、糸が同時に書くと行が別の行の途中に割り込んでいた（2026-10-11、CI の通し稽古で見つけた）。
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
錠剤の左端は、本文の列の左端から 16px の位置に固定し、どの画面へ移っても、どの窓の幅でも動かない。
本文の幅（`--main-w` の 1200px）には揃えない。
セッション画面だけは本文の幅の上限を外す（UX 刷新 2 の案 b、殻の `data-wide` の印でその画面の `--main-w` だけを外す）ので、錠剤を本文に揃えていた間は、窓が広いと画面ごとに錠剤が横へずれた（窓 2560px で 572px）。
そこで 2026-10-12 に、錠剤の左端を `--main-w` に依らない値にした（利用者の決定）。
畳んだ帯ではロゴが列の外まで伸びるので、錠剤はロゴの右から始まる。
この式（`max(16px, ヘッダの右端 − 帯の幅)`）は `--gutter-head` に持ち、使うのはヘッダの錠剤だけである。
本文は、どちらの帯でも左の余白を 16px（`--gutter-l`）にして、帯のすぐ右から始める。
そのため、帯を畳んでいる間は本文の左端と錠剤の左端が揃わない（利用者の決定。`docs/superpowers/specs/2026-10-02-session-motion-design.md`）。
本文の幅の上限（1200px）で中央に寄っている画面は、今までどおり中央のままで、窓が広いと錠剤より右から始まる。
本文の列（`.main`）はスクロールバーの溝を常に取り（`scrollbar-gutter: stable`）、中身が窓に収まるかどうかで本文の左右が動かないようにする。
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

「移動・操作」の錠剤は打つ欄ではなく押すボタンで、虫眼鏡、「移動・操作」の文字、⌘K のキー帽を並べる（案 A1）。
押すか、/ か ⌘K でコマンドパレットを開く。
大きさは、ヘッダの右の列（`.header-row`）の幅で 3 段に変える（2026-10-12、利用者が選んだ案 D 段階的）。
列が 640px 未満は虫眼鏡だけの丸、640〜999px は中身の分の幅の錠剤、1000px 以上は長い欄である。
長い欄は「移動・操作」の代わりに「セッションと操作を検索」の文とキー帽を並べ、幅は `clamp(280px, 50cqw − 240px, 600px)`、背は 34px、字は 14px にする。
幅は列の幅だけで決めるので、同期の文の長さや画面では変わらない。
上限の 600px はパレット（640px）とほぼ同じ幅なので、押したときに錠剤からパレットへ広がる動きが短い。
段はコンテナクエリで広がる向きにだけ書き、右の塊を畳む仕組み（上の測る仕組み）とは分ける。
どの段でも、右の塊が入り切らなければ文字とキー帽をさらに畳み、虫眼鏡だけの丸いボタンにする（上の畳む順の 6 段目）。
読み上げの名前はどの段でも「移動・操作」で、長い欄の文は読み上げから外す。
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

アカウントが 1 件のときも、ヘッダは 2 件以上のときと同じ顔（色の点、名前、計器、▾）にし、押すと同じ一覧が開く（2026-10-16 の利用者の決定、試作 account-ime の 1A）。
計器だけを出していると、戻る時刻はホバーしないと読めず、2 つ目のアカウントを足せることにも気付けないためである。
新規セッションのダイアログに段を足さず、セッション画面に札を出さないのは、今までどおり 2 件以上のときだけである。
アカウントの節は設定にもあり、1 件でも追加の入口として出す。
サーバは最初のアカウントを必ず返すので、一覧が 0 件なのは、まだ届いていない間だけである。
その間だけは、ヘッダに計器（値が無ければ設定への 1 語）だけを出す。

アカウントが 1 件のときも、計器はそのアカウント（最初のアカウント）の値から作る。
使用率は `accounts.update` だけで配り、最初のアカウントの値だけを運ぶ別の知らせは持たない（段 1 で `usage.update` を消した）。

ヘッダの名前を押すと、アカウントごとに 1 枚の札を並べた一覧が開く。
札は名前、プラン、メールアドレス、5 時間と週の使用量、戻る時刻を持つ。
下の段は、左に「＋ アカウントを追加」、右に「アカウントの設定」を置く（1 件でも 2 件以上でも同じ）。
追加は、設定の画面と同じ「アカウントを足す」のダイアログを直接開く（`account.add.open`）。
使用量の行は「ラベル、棒、%、戻る時刻」の 4 列で、2 本の行は同じ列にそろえる。
戻る時刻の文は今日なら時刻だけ、そうでなければ月と日も添えるので長さが変わり、列は文の幅で取って、縮むのは棒だけにする（棒は 48px を下限に持つ）。
文を決め打ちの幅の列に入れると、日付つきの文が札の枠を越える。
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
止める前に、再開できるかを確かめる（`runs/accounts.ts` の `switchAccount`）。確かめる作業フォルダは、共有の行の cwd ではなく、再開に使うもの（ほかの PC のパスをこの PC へ読み替えた後）である。ほかの PC から来た会話を読み替えた場所で動かしているときに、「フォルダが無い」で断らないためである。ほかの PC のクイックセッションのフォルダがまだ無ければ、確かめでは作らず、再開が作る。

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
追加は「アカウントを足す…」で開くダイアログ（`views/AddAccountDialog.tsx`、試作の案 A）で行う。
名前と場所の 2 つの欄、最初の場所と共有するもの（`ACCOUNT_LINK_GROUPS` の 4 つの組：設定と指示、スキルとコマンドとプラグイン、メモリと計画、会話の履歴）と分けるもの（ログイン、組織から配られる設定、キャッシュと常駐の状態）の 2 列を 1 枚に置く。
「ログインだけが分かれ、設定と履歴は同じ」ことを、登録の前に読めるようにするためである。
場所は、利用者が打つか「選ぶ…」（殻の中だけ。Finder はホームから開く）で選ぶまでは、名前から作った候補（`~/.claude-<名前>`。英小文字と数字だけにし、ほかの文字の並びは `-` に寄せる。英数字が残らなければ `~/.claude-2` からの空いている連番。登録済みなら `-2`、`-3` を付ける）で埋める。
打つたびに `GET /api/accounts/preview?name=&dir=` で足す前の確かめを読む。何も作らず書かず、使う場所の絶対パス、既にあるか、リンクを張る名前にある実ファイルや実フォルダ（`inspectAccountLinks`）、その場所を使う登録済みのアカウントを返す。
画面は今の欄と合う答え（問いの写しの `name` と `input` が同じもの）だけを使い、打っている途中の古い答えで場所や知らせを替えない。
実ファイルがあれば名前を挙げて「上書きせず、このまま残します」と言い、登録済みの場所なら理由を出して登録を押せなくする。
`POST /api/accounts` の `dir` は `~/` で始まる形も受ける（`AccountStore.resolveDir`）。断られた理由はダイアログに残す（トーストにしない）。
「登録してログイン」を押すと、場所を作ってリンクを張ったあと、すぐに `claude auth login` を子プロセスで始め、ダイアログを閉じる。
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
錠剤は「セットアップの確認 準備完了 4 / 8」の形で、済んだ割合の細い棒を添える。
帯の右端の文は、始めるのに要る道具（tmux と claude）のうち足りないものだけを名指しする。
足りないのが 1 つなら「始めるには claude が必要です」、2 つなら「始めるには tmux と claude が必要です」で、Windows では tmux を psmux と言う（`muxName`）。
両方が揃っていれば、ほかに直すものが残っていても右端の文は出さない。
残りの件数は言わない（2026-10-11 まで「6 つ中 2 つ」と「設定の残り 4 件」を並べていたが、読み取りにくかった）。
引き出しの見出しにも、残りの件数の要約は添えない。
英語では「Ready 4 / 8」「You need claude to start」「You need tmux and claude to start」である。
分母は任意の行も含めて数える（`compat`、`git`、`editor` の無い古いサーバの答えでは、その行が無く 5 になる）。
行は、tmux、claude、プロジェクト、git、MCP サーバー、ステータスライン、エディタ、Claude Code との互換性の 8 つである（git とエディタは 0.5.0 で足した。利用者の要望「セットアップに git も組み込んでね」）。
プロジェクトの行は、2026-10-13 に「プロジェクトの親フォルダ」の行から変えた。この PC に場所の分かっているプロジェクトが 1 件以上で済み、0 件は注意（!、任意の札は付けない）である。
0 件のときは「Claude Code と会話したフォルダが N 件見つかりました。プロジェクトにするものを選んでください」と主ボタン「選ぶ…」で候補のダイアログを開き、候補が無ければ「新しいプロジェクト…」にする。
件数は準備の確かめの `projects`（`resolved` と `candidates`。候補はプロジェクトが 0 件のときだけ数える）で、`resolved` は画面が持っているプロジェクトの数で置き換える（`liveReadiness`。登録した直後に行を消すため）。
`projects` を返さない古いサーバの答えでは、今までの作成場所の行で見る。
判定は設定画面の欄の下の検証と同じもの（`toolLine`、`workspaceLine`、`compatState`）を使う。
引き出しには、直すものだけを 1 行（36px）ずつ出す。
必須の行を先に、任意の行（git、MCP、ステータスライン、エディタ）を後ろに並べ、任意の行には「任意」の札を付ける。
git とエディタは無くても始められる（git の表示が出ない、「<名前> で開く」が開けないだけ）ので任意にする。エディタは「アプリだけ」でも開けるので、見つからないときだけ直すものにする。
行は、状態の印（✗ と !。読み上げの名前にも状態を入れる）、名前、説明、薄い命令、右端のボタン 1 つである。
ボタンは、tmux が見つからないとき、git が見つからないとき（macOS は `xcode-select --install`、Windows は `winget install --id Git.Git -e`。入れ方の無い Linux は設定のツールの節を開く）、MCP とステータスラインでは「コマンドをコピー」、そのほかでは「設定を開く」である。
殻の中では、MCP とステータスラインの行も設定の連携の節と同じボタン（登録…、設定…）にし、書き込む先を添える（0.4.0。殻が承諾の窓で見せてから書く。「承諾の窓」の節）。ステータスラインのスクリプトが無いときは「設定を開く」にする。
シェル連携は始める前の確認の行に入っていない（無くても始められ、行の数を変えると帯の分母が変わるため）。
「設定を開く」は、設定の頭ではなく、その行を直す欄を指して開く（`#/settings?at=tmux`、`claude`、`workspace`、`compat`、`editor`。行と開く先の対応は `READINESS_AT` の 1 か所で、全部の行が節を持つことを試験が縛る）。
tmux、claude、作成場所はツールの節のパスの欄へ、互換性は連携の節の互換性の節へ、エディタは一般の節のエディタの欄へ開く。
開いたら、頁をスクロールする枠の中でその欄が見える所まで送り（`revealWithin`）、検索から跳んだ行と同じ淡い黄の地を一瞬だけ薄れさせて目立たせる（`markHit`、`prefers-reduced-motion` では動かさない）。
パスの欄には入力欄へフォーカスも置く。互換性の節には入力欄が無いので、送って目立たせるだけにする。
MCP とステータスラインは命令をコピーする行なので、欄は指さず連携の節（`integrations`）が対応先である。
tmux の行は、Windows では psmux の名で出し、入れるコマンドは OS で変える（Windows は `winget install marlocarlo.psmux`、ほかは `brew install tmux`）。
見つからないときの文は「psmux がインストールされていません」で、右端に「再確認」を足して 2 つのボタンにする（段 6 の B1）。
再確認しても無ければ「psmux がまだ見つかりません。インストールしたあと、Hangar の再起動が必要な場合があります」に替え、確かめている間はボタンを「確認中…」にする。
見つかれば行は済んだ側へ移り、必須がそろえば群ごと消える。
psmux が下限（`PSMUX_MIN_VERSION`、3.4.0）より古いとき（準備の確かめの `tools.tmux.outdated`）は、注意の行を出す（issue #245）。
文は「psmux 3.3.8 では、端末をホイールで上へスクロールできません。3.4.0 以上に上げてください（手順は設定にあります）」の 1 つで（行の detail は等幅のコマンド用の欄なので使わない）、ボタンは「設定を開く」だけにする（上げ方の注意は帯に収まらないため）。
始められるので右端の「始めるには」には数えないが、任意の行にはしない。任意にすると、準備を済ませた既存の利用者には帯ごと出ないからである。
上げて再確認すると版を読み直し（覚えた版の鍵に更新時刻が入っている）、行は消える。

psmux（tmux）が無いと分かっているときに、新しいセッションの開始、再開、フォーク、この PC で再開（停止を頼んで引き継ぐ承諾も含む）を押すと、送らずに案内のダイアログで止める（段 6 の B2、`mediator/muxGuide.ts`、`views/MuxGuideDialog.tsx`）。
hangar に移動（adopt）と接続（attach）も止める。
adopt は外の claude を終わらせてから hangar の tmux で起こすので、無いまま進むと元の会話を止めたまま失敗するからである。確認の前でも、確認で承諾した後でも止め、見つかれば止めた操作から続ける（確認の前なら確認を出す）。
attach は Claude のバックグラウンドのサービスにつなぐが、つなぐ口（`claude attach`）は hangar の tmux のペインで起こすので、無ければ断られる。
準備の確かめが届く前は止めない。
ダイアログは、要ることと入れるコマンド（コピー付き）、「キャンセル」と「インストールしたので再確認」を持つ。
新しいセッションのダイアログから来たときは、キャンセルでそのダイアログへ戻る。
再確認で見つかれば「psmux を確認しました」と版を出し、「開始」で止めていた操作をそのまま送る。
幅が 1100px 以下のときは、命令を隠してボタンだけにする。
済んだ行は、引き出しの末尾の 1 行（「tmux、claude、Claude Code との互換性 は準備完了」）に畳み、押すと見つかった場所の行が開く。
その畳んだ行のさらに後ろ、引き出しの最後に「仕上げ：Claude Code に環境を見てもらう」の 1 行を置く（セットアップのすゝめ、試作の案 C）。
淡い本文は「会話のフォルダの登録と連携を、診断から提案します」で、右端の「一言をコピー」は設定の連携の札と同じ一言を写し、写せたら「コピーしました」にする（`BandGroup.tail`、`BandAction.copyFeedback`）。
直すものではないので、錠剤の件数にも「準備完了 N / M」の分母にも数えない。
群が出る・消える規則は変えない。この行のために群を出し続けることはせず、必須が済んで群が消えれば一緒に消える。そのあとの入口は設定の連携の札である。
写しが取れていなければ行を置かない。
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
Claude Code の保持期間がユーザー設定に無い（既定の 30 日）あいだは、消えかけのトランスクリプトがあるときだけ、ヘッダーの注意に保持期間の行を出す（「注意と知らせの出し分け」の節と「会話の保持期間」の節）。日数そのものは設定の「情報」の目次の状態（「保持期間 30 日 · N セッション」）に出す。ヘッダーの下に帯は出さない。
### Home の帯と引き出し

帯は 40px で、要対応、実行中、確認待ちの件数を 3 つの錠剤で並べる（`presentHomeBand`）。
場所の不明なプロジェクトの錠剤は、この PC で場所が消えたものがあるときだけ、確認待ちの後ろに 4 つ目として足す（`presentUnresolved`。`presentHomeBand` の `extra` に群を渡す作りで、群を足すだけで増える）。
件数に入れるのは、この PC で場所が消えたものだけで、他の PC から届いただけのものは数えない（「プロジェクトの同定」の節）。
この群は朝に開く群にしない。引き出しの行は、フォルダの印、名前、セッションの数、前のパス、「場所を再指定」「Archived にする」「一覧から削除」である。
始める前の確認の群があるときは、場所の不明なプロジェクトが先、確認が最後に並ぶ。
中断の群（「前回実行中」、`presenters/interrupted.ts`）があるときは、確認待ちの後ろ、場所の不明なプロジェクトの前に置く。
再起動の直後は要対応も実行中も 0 件なので、記録から 24 時間までは、この群が朝に開く群になる。
引き出しの見出しには原因と時刻（「PC の再起動で中断（03:12）」、tmux のサーバが止まったときは「tmux の停止で中断」）と、「すべて再開」「閉じる」を置く。順番待ちが残る間は「すべて再開」の代わりに「残りをキャンセル」を置く。
行は中断の輪（再開を頼んでいる間は回る）、名前、プロジェクト、止まる前の状態の語（作業中だった、入力待ちだった、アイドルだった）と要約の 1 文、最後に動いた時刻、「再開」と「再開しない」（×）である。
順番待ちの行は「順番待ち」、頼んでいる行は「再開中」、断られた行は「失敗」と理由と「再試行」になる。
アカウントが 2 件以上なら、アカウントごとに小見出し（色、名前、5 時間の使用率）を置く。使用率が高ければ「使用制限に達するかもしれません」、未ログインなら「未ログイン」と「ログイン」を添える。
「再開しない」と「閉じる」は、「元に戻す」の付いたトーストを出す。
実行中の行で、同じファイルを別のセッションと編集しているもの（「同じファイルの編集の警告」）は、右端に琥珀の札（「同じファイル 2」）を置き、押すと中身が開く。帯の「実行中」の錠剤には琥珀の点を足す。件数には入れない。
要対応は、入力待ち（`waiting`）のセッションと、今日戻る Paused の合計である。
入力待ちには許可待ちと、使用制限のリセット済みも入る（「止まっている理由」の節）。使用制限でリセットを待っているものは、登録がアイドルなので実行中に入る。
Done と Archived にしたセッションは、live が `waiting` のままでも要対応に数えない（`store.ts` の `awaitsAnswer`、入力待ちの知らせと同じ数え方）。
実行中の札には、休みとして入る。
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
戻る日が今日か過ぎたものに加え、暦に無い日のものも、利用者が決めるまで出す。日付なし（利用者が選んだもの）は出さない。
時刻つきは時刻を過ぎてから出す（2026-10-13）。
実行中の行は、作業中なら Claude がこのターンに書いた意図を本文に、いまの手（ツール名と対象）を等幅の詳細に出し、休みと起動中は一言の文を本文にする。右端には作業中の経過時間とコンテキスト使用量を出す。
意図とツール呼び出しは、帯の「実行中」を押して引き出しを開くまで見えない（2026-10-09 の利用者の決定。それまでは実行中の札が開いた直後から見せていた）。
墨の 1 行の中の長い絶対パスは、末尾の 2 階層だけにする（`presenters/format.ts` の `shortenPaths`）。頭から出すと、どれも同じ頭で始まり、違いのある末尾が省略で消えるからである。
Windows のパス（`C:\…`、`\\server\…`、`~\…`）も同じに縮め、元の区切りで書く。
意図は、Home を見ている間は動いているセッションの分を取りに行く（1 秒に 1 回まで）。書かれていなければ出さない。
確認待ちの行は、TODO の完了の候補とセッションの提案を、候補になった時刻の古い順に混ぜて並べる。
TODO の行は半分塗りの印、本文、プロジェクト名と経過時間、根拠の一文（無ければ「根拠は書かれていません」）、「確定」「却下」を置き、本文を押すとそのプロジェクトの画面へ移る。
セッションの提案の行は枠だけの札（「Done にする？」など）、名前、出どころの小札（「会話の中で」か「要約から」）、根拠を置き、「確定」「日付を変更」（Paused のときだけ）「却下」を押せる。
Done の提案には、右端に自動で確定するまでの日数（「あと N 日で確定」）を淡く添える。
日数は切り上げで、1 以上 `CANDIDATE_EXPIRE_DAYS` 以下に抑える（`candidateDaysLeft`）。画面の時計（`Root` の `useNow`）は 30 秒ごとにしか進まないので、届いたばかりの提案では提案の時刻より手前のことがあり、抑えないと「あと 8 日」と出る。
群の見出しには、中断の群と同じ並びで「すべて確定」「すべて却下」を置く（確定が先、却下は控えめ）。いまある TODO の候補とセッションの提案を全部渡す（`pending.resolve`）。TODO の取り消し（⌘Z）の積みは作らない。

放っておかれた提案は、サーバが片付ける（2026-10-13 の決定、知らせの 9d、`sessions/states.ts` の `expireCandidates` と `sessions/candidateExpiry.ts`）。
提案から 7 日（`CANDIDATE_EXPIRE_DAYS`）たった Done の提案は、提案の理由のまま Done にし、`set_by` を `import` にする（自動の Done と同じ印）。
同じだけたった Paused の提案は、戻る日の当てが外れているので消し、却下と同じく `rejected_at` を刻む。
対象はこの端末が持つ（`home_device`）セッションだけで、自動の Done と同じ 15 秒の見回りで回す。
この版を入れた直後の 1 回目は、溜まっていた提案がまとめて確定することがあるので、確定した件数をトースト（「7 日たった Done の提案 N 件を、自動で確定しました」）で 1 度だけ知らせる。
トーストは今つながっている画面にしか届かないので、1 回目は画面がつながるまで片付けを待つ。済んだ印は端末だけの表（`settings_local` の `candidateExpiry.announced`）に置く。
2 回目からは、行の「あと N 日で確定」が前もって言っているので、知らせずに片付ける。
ボタンの読み上げの名前は見える語と相手の名前を含む（「確定、窓を掴める（alpha）」）。別のプロジェクトに同じ本文の候補があっても、名前は 1 つに決まる。

帯と引き出しの動きは、2026-10-11 に利用者が試作（要素ごとに今と案を並べて再生で比べる頁）から選んだ（`views/HomeBand.tsx`、`views/HomeScreen.tsx`）。
新しい動きは作らず、「セッション画面の動き」の節の共通の部品とトークンだけを使う。reduced motion ではどれも即座に替わる。
- 引き出しの開閉：開くと高さと余白を 0 から伸ばし（`growIn`）、下の一覧は押されて滑る。閉じると畳んで出る（`collapseOut`、`usePresence`）。閉じる間は前の中身のまま描き、役も焦点も読み上げも持たせない。
- 群の切替：引き出しの高さを前の高さから補間し（`resizeFrom`。前の高さは錠剤を押した時点で測る）、中身を `--dur-fast` で薄れから現す。伸びも畳みもしない。
- 引き出しの行：来た行は伸びて入り、解けた行は畳んで出る（`useMotionList` の grow。群を `scope` にし、群を替えた描画は動かさない）。要対応、今日戻る、実行中、確認待ち、始める前の確認の行に共通である。並びが替わっても滑らせず、上がった行の地だけを淡い黄から薄れさせる（`flip: false` と `hitRisen`。一覧の並び替えと同じ考えで、実行中の並びが数秒おきに替わるため）。
- 件数：錠剤の数（`CountChip` の `rolling`）、状態のタブの数、一覧の見出しの「セッション N 件」の数字は `RollingText` で回す。見出しは数字だけを回し、「件」は動かさない。数字を入れる箱は行の高さを 1.2em にそろえる（数字が下がらないように）。
- 帯と「実行中のセッションはありません」の入れ替え：2 つを外の箱（`.home-top`）に入れ、箱の高さを前の高さから補間し、入る方を `--dur-fast` で薄れから現す。
- 始める前の確認：進みの棒は幅を `--dur` で伸ばし、通った行は引き出しの行として畳んで出る。群が消えたら引き出しが畳んで出る（ほかの群も 0 件なら、帯と 1 行の入れ替えになる）。
- 検索の最中：引き出しは畳んで閉じ、終われば伸びて戻る。帯の右端の注記は `--dur-fast` で薄く出入りする（`fadeIn`、`fadeOut`）。

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
行は 2 段で、1 段目に名前とプロジェクト名（無ければ「未分類」）、2 段目に要約の見立ての札と、要約の 1 文か検索の抜粋（最初の 1 つ。一致した語に淡い印）を出す。2 段目の右端には、PR の番号（`/pull/<番号>` の URL の末尾。取れなければ「PR」とだけ出し、押すと外のブラウザで開く）を置く。ノートの印は 0.4.0 でノートと一緒に外した。
行の頭には状態の札（Active、Paused、Done、Archived。提案があれば枠だけの提案の札）を置き、押すとそのタブへ移る。
右端には、本文の期限が 7 日以内なら琥珀の「まもなく削除」を、保持期間で本文が消えたとみられるなら文字の無い印を、時刻の左に添える。
ステータスの無いセッションで最後の run が中断で終わり、いま終わっているものには、枠の「中断」を添え、乗せると原因と時刻を出す。ステータスを付けた後は出さない（過去の多くの行に散らばらないように）。Paused の行の時刻の列は戻る日である。
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

一覧の動き（2026-10-11 に利用者が試作から選んだ。プロジェクトの画面の一覧も同じ部品である）。
- 並び替えと差し込み：同じタブ、条件、ページのまま並びが替わったら、並びはいきなり替え、上がった行と新しく来た行の地だけを淡い黄から薄れさせる（`VirtualList` の `scope`、`markHit`。上がった行は、前と今の両方にある行の互いの順で前へ出た行で、`motionKit.ts` の `risenKeys` が決める）。行は滑らせない。
  はじめは行を滑らせる案（a）を入れたが、実データでは実行中のセッションの並びが数秒おきに入れ替わり、そのたびに上の数行が動いて目がうるさいので、2026-10-11 に利用者が淡い黄だけの案（c）に替えた。
- タブ、語、条件、ページ、1 ページの件数を替えた描画は、一覧をいきなり替え、印も付けない（`scope` が替わった描画）。最初の描画、空から埋まった描画、行が全部替わった描画も印を付けない。
- 選んだタブとページの塗りは 1 つだけ敷き、選び直すと塗りが前の位置から滑る（`views/primitives/useThumb.ts`。設定の切替の `Segmented` と同じ作りで、タブの帯は折り返すので縦も合わせる）。

### セッションのメニュー

セッションの行の右クリックと「⋯」と `.` で、同じメニューを出す（試作の 1A、2026-10-16 に利用者が選んだ）。
出す場所は、ホームの一覧、プロジェクト画面の一覧（どちらも `views/SessionRows.tsx`）、ホームの帯の行（`views/HomeBand.tsx` の `BandRowView`。開く先がセッションの行だけ）、サイドバーの「実行中」の行（`views/Sidebar.tsx`）の 4 か所である。
項目は `presenters/sessionMenu.ts` の `sessionMenuEntries` が 1 か所で作り、View は押したときに送るだけにする（`views/sessionMenu.tsx`）。
中身（状態、停止、移せるか、消せるか）は `presentSessionMenu` が Store から作り、行の持ち物（`SessionRowProps.menu`、`BandRow.menu`、`SideLiveRow.menu`）にする。

並びは次のとおりである。

- 「この PC で再開」：ほかの PC の会話だけ。押せないときは理由を添える。
- Active、Paused、Done、Archived：いまの状態に ✓ を付け（`menuitemradio` と `aria-checked`）、状態の色の点を添える。打鍵の印は u、p、d、a。Paused はいまと同じ戻る日のダイアログを開く（`session.pause.open`）。いまの状態を選び直したときは、Paused なら日を変えるためにダイアログを開き、ほかは何もしない。
- 区切り
- 「プロジェクトを変更…」：打鍵の印は m。移す先のダイアログを開く（`session.move.open`）。ほかに移せるプロジェクトが無ければ「移動できるプロジェクトがありません」と添えて押せない。
- 区切り
- 「停止」：動いているときだけ。セッション画面の「停止」と同じ `session.kill` を送り、作業中、入力待ち、シェルのタブがあれば確認を挟む。hangar の外で動いているもの（生きた run が無い）は「外部ターミナルで実行中」と添えて押せない。補足の 1 行は出さない。
- 「削除…」：削除の確認を開く（`session.delete.open`）。動いているもの（hangar の run が生きているか、Claude が見えているもの）には出さず、代わりに「停止」を出す。止めると「削除…」に入れ替わる。サーバの 409 と同じ見方である。サイドバーは動いているものだけを並べるので、押せない「削除…」がいつも並ぶのを避けるためである。

危険色は停止と削除だけで、押せないときはほかの押せない項目と同じ淡い字にする。
本文の消えた会話も、移動と削除は押せる。消すのは hangar の行と印だけになる。
区切りは `MenuItem.separatorBefore` で置く。ほかのメニューの「最初の危険な項目の前に区切り 1 本」の振る舞いは変えず、重ねない。

一覧では、行を右クリックすると押した点にメニューを出し、カーソルをその行へ移す。選ぶか Esc で閉じると、フォーカスをその行へ戻す。
ホームの帯では、行の中の部品にフォーカスがあるときの `.` で行に吊るして出し、閉じると開く前の部品へフォーカスを戻す。

**移す先のダイアログ（試作の 2A）。**
見出しは「プロジェクトの変更」、本文は「「{name}」の移動先を選んでください。」である（`views/MoveSessionDialog.tsx`、`presenters/moveSession.ts`、overlay は `moveSession`）。
上の検索の欄（「プロジェクトを検索」）で名前とパスを絞り、一覧は「最近」と「すべて」に分ける。数え方と行の形は新しいセッションのダイアログのプロジェクトの選び方と同じで、行頭に状態の点を置き、クイックセッションは絵で見分ける。
並べるのは、しまっていないプロジェクトと、クイックセッションと、いまの所属である。いまの所属は押せず、「現在のプロジェクト」を添える。
クイックセッションは全 PC で 1 つのプロジェクトにまとめてあるので、その 1 つを並べる。この PC の場所は `quick-sessions` である（`presenters/sessionMenu.ts` の `moveTargetIds`）。
下に「変わるのは hangar での分類だけです。トランスクリプトと、再開するフォルダ（{cwd}）はそのままです。」を置く。
ボタンは「キャンセル」と「{project} へ移動」で、選ぶまで押せない。押したら閉じてから `session.move` を送り、断られた理由はトーストに出す。
開いたときのフォーカスは検索の欄で、↑ ↓ はいまの所属を飛ばして動き、Enter で選ぶ。
選んだ行の上でもう一度 Enter を押すと、移すボタンと同じく移す。行に印が無いときは、選んだ先があれば検索の欄の Enter で移す。押せない行と、何も選んでいないときの Enter では移さない。
選んだ行が絞り込みで一覧から消えたら、選択を外してボタンを押せない形に戻す。見えない先へ移さないためで、検索を戻しても選び直さない。

**削除の確認（試作の 3A）。**
確認のダイアログ（`ConfirmRequest` の `deleteSession`）で、見出しは「「{name}」を削除しますか？」、その下の 1 行は「{project}・{n} ターン」である。
本文は「トランスクリプトをゴミ箱へ移動し、hangar から削除します。同期しているほかの PC からも削除されます。ゴミ箱から戻すと、hangar にも戻ります。」である。
ボタンは「キャンセル」と危険色の「ゴミ箱へ移動」で、初めのフォーカスはキャンセルにする。
確定したら閉じてから `session.delete` を送る。サーバの 409（実行中）と 500（ゴミ箱へ移せない）の文はトーストに出る。
消えたこと（`session.removed`）が届いたら、そのセッションの画面を開いていればホームへ戻り、そのセッションのダイアログ（移す先、削除の確認、Paused の入力）が開いていれば閉じる（`mediator/overlay.ts`）。

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
行を右クリックすると、同じ項目のメニューを押した点に出す（サイドバーの行と同じ作り）。
「⋯」のメニューは portal に描かれ、その上の右クリックも React の木では行へ泡立つので、行の DOM の中で押したものだけを取る。
行に焦点があるときに `.` を押しても、行に吊るして開く（修飾の付いた `.` は取らない）。
開いている行には印（`data-menu`）を付けて、ほかの行と同じ淡い背景にする。
Esc と項目を選んだあとは焦点を名前へ戻し、外を押して閉じたときは押した先に任せる。
ステータスの札は表の中では押せない札で、替えるのはこのメニューか 1 つのプロジェクトの画面である。

「いま」の列には、入力待ち、実行中、確認待ち、提案、TODO、リマインダーの順に、0 でないものだけを語と数で並べる。
入力待ちと実行中の数はサーバの `runningCount` を使わず、Home と同じく手元のセッションから数える。
確認待ちは、完了済みでない TODO の完了の候補と、そのプロジェクトのセッションに付いた状態の提案の数である（Home の確認待ちと同じ数え方）。
提案は、利用者がまだ受け入れていない Claude の TODO の提案（`suggestion` のある行）の数で、プロジェクト画面の「Claude の提案」の節と同じく済みかどうかを見ない。
プロジェクト画面を開かなくても、提案が溜まっていると一覧で気づけるようにする。
札の形は確認待ちと同じにする。
Home の確認待ちには入れない（Home の確認待ちの札は、TODO の提案を受け入れる操作を持たないため）。
TODO の数（`openTodoCount`）には提案を数えない。
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

- **新しいフォルダを作る**：「プロジェクト名」の欄（等幅、「新しく作るディレクトリの名前」）、「~/workspace/<名前> を作ります」、git init のチェック（既定はオン）。作成場所が空のときは「作成場所」の欄（デスクトップは「選ぶ…」で Finder）を足し、選ぶまで送れない。
- **既存のフォルダを登録**：未登録のフォルダの検索付きの一覧（`GET /api/workspace/dirs`）、「ほかの場所を選ぶ…（Finder、殻の中だけ）」のボタン、パスの入力の欄。どれかで選んだフォルダの basename を「プロジェクト名」の欄に入れる（直せる）。

既存のフォルダの登録でも、パスが決まると 300 ミリ秒待ってから事前の問い合わせ（`folder.inspect`）を頼む（0.6.1）。名前を自分で直したときだけ名前を添え、弱い一致をその名前で見る。答えを待つ間は送れない。

- 登録済みのプロジェクトの下：その場の 1 行で「agent-hangar の中のフォルダです。別のプロジェクトにしないときは、agent-hangar を開きます。」と言い、「別のプロジェクトにする」を添える。名前の欄は出さず、下端のボタンは「agent-hangar を開く」と「agent-hangar で開始」になる（`project.new.enclosing`）。開くはダイアログを閉じてそのプロジェクトの画面へ移り、開始はそのフォルダを選んだ新しいセッションのダイアログを開く（`session.new.open` の `dir`、上の新しいセッションのダイアログの規則で包むプロジェクトの `cwd` で起こす）。「別のプロジェクトにする」を押すと、分ける旨の 1 行と「agent-hangar のままにする」に替わり、`allowNested: true` を付けて登録する。登録が 409（入れ子）で断られたときも、失敗の文言の代わりにこの 1 行を出す。
- ほかの PC から届いた同じプロジェクト：その場の 1 行で「work-pc の notes-app と同じリポジトリです。この PC の場所として結び付けます。」（名前だけの一致は「同じ名前です」）と言い、既定で結び付ける。名前の欄は出さず（結び付けた先の名前は変えない）、下端のボタンは「結び付ける」と「結び付けて開始」になり、`linkTo` を付けて送る。「新しく作る」を押すと、結び付けない旨の 1 行と「notes-app に結び付ける」に替わり、名前の欄とふつうのボタンに戻る。

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
左右に割り、左にホームと同じ部品のセッションの一覧、右に右パネル（TODO、指示とメモリ、アーティファクト）を置く。
見出しの行に名前、プロジェクトの状態の切り替え、操作（<名前> で開く、ターミナルで開く）、(i)、右パネルの開閉を置き、線の下にパスを置く。
見出しは左の列に入れず、1 行目で両方の列にかける（`.project-screen > .page-head`）。左の一覧と右パネルは 2 行目に並ぶ。
右パネルの開閉のボタンは見出しの行の右端で、右パネルの右上の角に重なり、閉じて左の一覧が広がっても同じ場所に残る（セッション画面の右の列と同じく、閉じた場所で開き直せる）。
以前は見出しを左の列に入れていたので、閉じると左の列が広がり、開くボタンが見出しの右端（窓の右端）へ移った（0.3.0 の確かめで見つけた）。
この PC にパスが無いプロジェクトでは、外で開く 2 つの操作を押せない形（`aria-disabled`）にし、乗せると「この PC にパスが無いので開けません」と理由を出す。
それでもサーバが断ったとき（プロジェクトが消えたなど）の失敗は、error のトーストのまま 8 秒で消える（`actionTable.ts` の `failHoldMs`、「トースト」の節）。
新しいセッションの主ボタンはヘッダーにあり、この画面ではこのプロジェクトを最初から選ぶので、見出しの行には並べない。
クイックセッションの置き場の「クイックセッションを開始」は別の入口なので残す。
パスがこの PC で見つからないときは、パスの横に押せる札「見つかりません。場所を再指定」を出し、押すと場所の再指定のダイアログを開く。

**左の一覧。** ホームと同じ部品（`views/SessionList.tsx`）を、プロジェクトを固定して使う（`projectFixed`）。
上から、件数つきのステータスのタブ、検索の欄と絞り込みのボタン、平らな行、ページ送りである。
行に「いま動いている」「続き」といった節の見出しは挟まない。
動いているものを先に置き、残りは新しい順に並べるだけである（Done は Done にした時刻の新しい順）。
絞り込みにプロジェクトの選択は出さず、行にもプロジェクト名を出さない（見出しにある）。
行の右端のモデル、変更の数、コスト、メモの本文と鉛筆は、ホームの行と同じく出さない。
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

**窓に収める。** 2026-10-12 に、画面全体を窓の高さに収める作りにした（試作で選んだ C3）。
それまでは、左右の 2 列の行が高い方の列（右パネル）に合わせて伸び、頁が窓より縦に長くなり、左の一覧もその高さまで引き伸ばされていた。
いまは、行の高さを左の列（見出し、パス、タブ、欄、一覧の下限 200px、ページ送り）が決め、一覧が残りの高さを受け取る。
右パネルの列（`.rail-slot`）は高さ 0 から行の高さまで伸ばす（`.project-screen.screen-fill > .rail-slot`）ので、中身がいくら長くても行を押し広げず、パネルの中で 1 本でスクロールする。
窓が左の列の下限より低いときだけ、ほかの一覧の画面と同じく `.main` がスクロールする。
ほかの画面の `.main-inner` と `.screen-fill` には手を入れていない。
節の見出しは sticky で、パネルをスクロールしても、いま見ている節の見出しがパネルの上端に留まる。
節の中ではスクロールさせない（小さなスクロールの箱が入れ子になり、ホイールが内側に捕まるため）。

**右パネル。** TODO、指示とメモリ、アーティファクトを白い面に載せ、パネルごと閉じられる（「右パネルを閉じる」「右パネルを開く」）。
パネルごとの開閉は、セッション画面の右の列と同じ動き（`paneMotion` の `PANE_SHAPE.rail`、`usePresence`）である。
閉じた右の列は幅 0 にして列の数を変えず、列の幅を `--dur` で縮め（広げ）て、左の一覧を滑らかに広げる（戻す）。
動きの間、パネルの中身は開いたときの幅に留めて列の端で切り、閉じるときは薄れてから外し、開くときは薄れから現れる。
はじめの描画では動かさず、reduced motion ではすぐ切り替わる。開閉の形は画面の中だけで持ち、覚えない。
TODO の見出しに未完の件数（提案は入れない）と、完了の候補が付いた未完の TODO の数の札「確認待ち N」を置く。
セッションの状態の提案は数えない。そちらは一覧のタブの「確認待ち」が言う。
節ごとにも折りたためる（試作の A1）。
見出しの行全体が開閉のボタンで、左のシェブロンは TODO の「完了 N」と同じく、開いて下向き、折りたたんで右向きに --dur で回る。
折りたたんだ節は見出しだけの札になり、件数と確認待ちの札は見出しに残る。
折りたたんだ節はプロジェクトごとに覚える（`project.railFold`、`mediator/projectRail.ts`）。
端末の localStorage の `projectRail.folded` に、プロジェクトの id から折りたたんだ節の並びへの表で残し、起動時に読み戻す。全部開いたプロジェクトは表から消す。
初めて開くプロジェクトは 3 つとも開いている。
別のプロジェクトへ移ると右パネルを作り直し、そのプロジェクトで覚えた形で動かさずに出す。パネルのスクロールも先頭から始める。
中身は折りたたみの間も外さず hidden で隠す（TODO の欄の選びや書きかけを残す）。
開閉の動きは試作の D1 である（`views/primitives/FoldBox.tsx`）。開くときは `growIn` で高さを 0 から伸ばし、閉じるときは `collapseOut` で薄れながら畳んでから隠す。下の節は押されて滑る。
畳む途中で開き直したときは、0 へ跳ばずに、そのときの高さと薄さ（`shapeNow`）から伸び直す。
はじめの描画では動かさず、reduced motion では長さが 0 になってすぐ切り替わる。
**アーティファクトの件数**（試作の B）。新しい方から 3 件だけを出し、残りがあれば並びの末尾の行に「すべて表示（N 件）」を置く（N は全部の数）。
広げると「少なく表示」になる。増えた分の箱は、節の開閉と同じ `FoldBox` で伸ばし、畳む。
広げた分は節の中でスクロールさせず、パネル全体のスクロールに任せる。
広げた状態は覚えない。開き直したときと、別のプロジェクトへ移ったときは 3 件に戻る。
戻したとき、パネルが節の上端より下までスクロールしていたら、節の上端が見える所まで戻す（動きのあるときは滑らかに）。
**指示とメモリ。** 2026-10-11 に、手で書くプロジェクトのノートの節をこれに置き換えた（`views/InstructionsPanel.tsx`、案 D）。
ノートはどのプロジェクトでも空のままで、起動時の指示に渡していたノートの行も「（なし）」のままだった。
指示を書く人は効く場所（CLAUDE.md）に書き、学びは Claude が自動メモリに書いていたので、Hangar 独自の欄は育たなかった。
そこで、Claude Code が起動時に読むファイルを見せる窓にした。Hangar では読むだけで、書かず、無いファイルを作りもしない。
並べるのは、プロジェクトのルートの `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md`、`AGENTS.md` と、いま選んでいるアカウントの自動メモリの `MEMORY.md` のうち、あるものだけである（`projects/instructions.ts`、`GET /api/projects/:id/instructions`）。
親フォルダの CLAUDE.md、`~/.claude/CLAUDE.md`、`.claude/rules`、`@import` は再現せず、節の下に「読み込まれるものの全体は、セッションで /context を実行すると確認できます」と添える。
`AGENTS.md` は、作業フォルダかその上に CLAUDE.md の類があると既定では読まれないので、名前に線を引いて「CLAUDE.md があるため読まれない」と出す。利用者の settings.json の Project instructions（`instructionFiles`）があれば、それに従う。
Hangar が `CLAUDE.local.md` を作らないのは、作るだけで `AGENTS.md` が読まれなくなるからでもある。
自動メモリの場所は、`autoMemoryDirectory`（ローカル、プロジェクト、利用者の設定の順）があればそこ、無ければ `<設定フォルダ>/projects/<リポジトリの根の slug>/memory` である。worktree は元のリポジトリの根に寄せる。
行は名前、大きさと更新、種類の説明（プロジェクト指示・チームで共有、ローカル指示・自分だけ、自動メモリ・Claude が書く）で、語は公式の日本語版にそろえた。
名前は切らず、大きさと更新が名前の横に入り切らなければ、そちらを次の行へ送る（`.instr-name` の `flex-wrap`）。右パネルにスクロールバーが出て幅が縮むと、名前が「CLAUDE.…」に切れていたためである。名前だけで行に入り切らないときだけ … で切る。
行を押すと本文を Markdown で描くダイアログを開き、そのときに読み直す（ファイルは外で書き換わる）。本文は 256 KB まで返し、越えたら先頭だけを描いて知らせる。
ダイアログは長い本文を読む面なので、ほかのダイアログのガラスより濃い不透明の白にする。開くときは板の pop に背景のフェードを添え、閉じるときは逆にたどって（`popOut`、`--dur-exit`）から外す。
行の右の印とダイアログの下端の「エディタで開く」は、種類だけを `POST /api/projects/:id/instructions/open` へ送る。決まった種類のほかは断り、無いファイルは 404 にする。
中身の残る古いノートは、節の中に「以前のノート」として読むだけで出し、コピーと、確かめてから空で保存する削除を置く。
この PC にフォルダが無いプロジェクトは「この PC にはフォルダがありません」とだけ出す。
アーティファクトが空のときは、足す欄があれば別の行では断らない。

**TODO の欄**（`views/TodoList.tsx`、2026-10-11 に一般的な TODO アプリに寄せて作り直した）。
- 並び：上から「Claude の提案」の節、未完、「＋ TODO を足す」、畳んだ「完了 N」の順に置く。何も無いときだけ「TODO はまだありません」と書く。
- 未完の行：掴み・丸・本文・右端の 4 列で、本文は全文を折り返す（1 行で切らない）。掴み（⋮⋮）と ×（削除）は、ポインタを載せたときと選んだときだけ出す。
- 選ぶ：行を押すと選び（淡い青の地と左の線）、キーで動かせる。キーはショートカットの一覧の「TODO」の群に載せ（`keys.ts`）、欄の中に案内の行は出さない。キーで選んだ行は、右パネルのスクロールの中で見える位置へ寄せる（`revealWithin`）。
  `↑` `↓` / `j` `k` で選ぶ、`Space` / `x` で完了と未完、`Enter` で直す、`⌫` で消す、`⌥↑` `⌥↓` で動かす（`⌥⌘` で先頭・末尾）、`r` で完了の提案を却下、`a` で足す欄へ、`⌘Z` で直前の操作を戻す。
- 直す：ダブルクリックか `Enter` で、本文がその場の入力欄になる。`Enter` で確定、`Esc` で戻す、外を押しても確定、空にして確定すると消す。変換中の `Enter` では確定しない。
- 足す：末尾の「＋ TODO を足す」を押すか `a` で、その場が入力欄になる。`Enter` で末尾に足して欄に残る（続けて入れられる）。`Esc` で抜け、空のまま外へ出ても抜ける。
- 並べ替え：掴みのドラッグか `⌥↑` `⌥↓`。並べ替えるのは未完だけで、完了と提案は動かさない。送った並びは、サーバの並びが追いつくまで（最大 3 秒）手元で先に見せる。
- 完了：丸を押すと緑に満ちて線が描かれ、本文に左から線が引かれる。行は 1.5 秒もとの場所に済みの形で残り、そのあと畳んで「完了 N」へ移る。残っている間に丸を押し直せば未完に戻る。
- 完了の節：「完了 N」は畳んで始まり、押すと開く。開いた中では丸で未完に戻せ、削除と編集もできる。並びは終えた新しい順で、終えた時刻は持たないので最後に変わった時刻で代える。
- 消す：確認は出さない。行はその場で「「<本文>」を消しました」と「元に戻す」の帯に変わり、6 秒で畳む。帯の「元に戻す」と `⌘Z` で戻せる。
- 完了の提案：丸を半分塗りにし、行末に「完了？」の札を置く。行の高さは変えない。札を押すと、行の下に根拠の一文、出したセッションの名前（押すとそのセッションを開く。見つからなければ「不明なセッション」でリンクにしない）、候補になってからの時間、「確定」「却下」が開く。丸を押したときは、反転ではなく「確定」と同じに扱う。丸の読み上げの名前は「<本文>（<n> 件目、完了の候補）」である。
- Claude の提案：Claude が `add_todos` で足した TODO は、受け入れるまで淡い紫の「Claude の提案 N」の節に置く。行は点線の丸、本文、✓（受け入れ）と ×（見送り）、理由と出したセッションと経過時間の 1 行である。受け入れると一覧の末尾へ入る。2 件以上なら「すべて受け入れ」を出す。ダブルクリックで直してから受け入れられる。`Enter` で受け入れ、`⌫` で見送る。
- 取り消し：完了と未完、直す、消す、並べ替え、提案の受け入れと見送り、完了の候補の確定と却下を、Mediator の `todoUndo`（`mediator/todos.ts`、新しい 30 件）に、操作の前の行の写しで積む。戻すときは、写しをそのまま `POST /api/todos/restore` で書き戻す。逆の操作を組み立てないのは、候補の確定を戻したときに候補まで確かに戻すためである。帯の「元に戻す」は、その TODO を消した操作だけを戻す。
- 動き：並びが変わった行は前の位置から滑り（FLIP）、新しく入った行は他の一覧と同じく、ぼかしが晴れながら上がって来る（`motionKit` の `riseIn` と `slideFrom`）。位置は欄の左上から測るので、外のスクロールでは動かない。完了の行と帯は `collapseOut` で畳んで出る。完了の節と提案の中身は `growIn` で伸びて入る。ドラッグ中は掴んだ行を浮かせて影を落とし、ほかの行が道を空ける。離したときは、見えている位置から滑らせる。

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
実行中と終わった後は同じ形で、上から、見出しの段、そして本体を縦に積む。
タブの列は本体（`.c-body`）の 1 行目に入れ、左の主役はその下から、右の列はタブの列の行から下端までを占める。
本体は窓の残りの高さを全部使い、左に主役、右に 240px の列を置く。
左の主役は、実行中ならターミナル、終わった後ならトランスクリプトである。
右の列は、実行中なら上に現在の札、その下に目次を積む。終わった後は、書かれた要約があれば同じ場所に要約の札、その下に目次を積む。
右の列は札も目次もひとまとめに畳め、畳むと本体が右端まで広がる（目次の節）。
高さは決め打ち（`calc(100vh - …)`）にせず、本文の列から画面までを縦の flex にして残りを渡す。
切断の帯が出ると本文の列の上の余白が増え、本体はその分だけ縮むので、ターミナルの入力の行は窓の外へ落ちない。
窓がとても低いときだけ、本体の 160px を下限にして本文の列ごとスクロールする。
セッション画面だけ本文の幅の上限を外す（骨格の節）。

見出しの行には、状態の点、名前、他の PC の札、要約の 1 文、状態の札、主の操作、「…」のメニュー、(i) を置く（A1）。
状態の札（2026-10-16 の試作の 4A）は、操作の並びの先頭、主の操作の左に置く。
見た目と開いたときの一言（「進行中のもの」「一時的に止めているもの」「完了したもの」「一覧に表示しないもの」）は、プロジェクト画面の見出しの札（`views/primitives/StatusSelect.tsx`）と同じである。
状態の無い会話は Active として出す。
選ぶと既存の `session.state.set` を出し、Active は状態を外す（`status: null`）。
Paused はその場では付けず、一覧の行と同じ戻る日のダイアログ（`session.pause.open`）を開く。
Paused のときに Paused を選び直しても、戻る日を決め直せるように同じダイアログを開く（プロジェクト画面の札は選び直しで何もしない）。
セッション画面の札は、クリックと打鍵の泡立ちを止めない（`isolate={false}`）。止めると、window で受ける全体のショートカット（⌘K、Esc など）が札に焦点があるあいだ効かなくなるからである。
札には行の札と同じ `statusMark` の説明をツールチップで添え、隠し要素で読み上げの説明（`aria-describedby`）にも入れる。
hangar が自動で付けた状態は、札の頭に ✦ を置き、説明はその理由になる。自動でない状態は、その状態のひとことの意味になる。
実行中の画面にも終わった画面にも出し、本文が消えた会話には出さない（presenter の `statusPick` が null）。
終わった画面では、見出しの下の 1 行の状態の札をやめ、設定した日だけを残す（二重に出さないため）。本文が消えた会話は見出しに札が無いので、1 行の側に残す。
主の操作は状態ごとに 1 つだけ強く出す。
実行中（作業中、入力待ち、アイドル、hangar の外で動いているものも）は「<名前> で開く」（選んだエディタの名前。「エディタの選択」の節）、終わったセッションは「再開」、他の PC が握っている（ロックがある、トランスクリプトが他の PC にある）ときは「この PC で再開」である。
残りは「…」のメニューに入れる。
実行中は「ターミナルで開く」「hangar でつなぐ」か「hangar で引き取る」「フォーク」「要約を作り直す」「プロジェクトに昇格」「停止」、終わったセッションは「フォーク」「<名前> で開く」「要約を作り直す」「プロジェクトに昇格」、他の PC のときは「再開」「フォーク」「<名前> で開く」「要約を作り直す」の順にする。
「要約を作り直す」は、設定の要約エンジンが「使わない」なら、どの状態でも出さない（サーバが受け付けない。要約の札の「要約を再生成」と同じ）。0.6.0-rc.1 は実行中の「…」にだけ残っていた。
押せない項目は消さずに残し、下に理由を 1 行添える（「実行中は押せません。止めると押せます」「MacBook で実行中です」「本文が他の PC にあります」「本文がありません」など）。
理由は presenter（`sessionActions`）が再開とフォークを閉じている事実から言う。
押せない主の操作は `disabled` ではなく `aria-disabled` にし、理由を title と読み上げの説明に持たせる。
乗せたときの吹き出しとキーボードで、理由に届くようにするためである。
生きているロックの「この PC で再開」は押せる（2026-10-16）。
押すと、相手の claude に停止を頼んでから引き継ぐ確認の 1 枚が出る。
再開とフォークは閉じたままで、理由を添える。
メニューは menu ボタンの作法に従い、↓ と Enter と Space で最初の項目、↑ で最後の項目を開き、開いている間は ↑ ↓（端で回る）、Home、End で移り、Enter と Space で選び、Esc で閉じてボタンへ戻る（`views/primitives/MenuButton.tsx`）。
名前は見出しにだけ出し、要約の題は出さない（C1）。

実行中は、見出しの下に行を置かない。
終わった後は、見出しの下に事実の小さい 1 行（見出しの下の 1 行）を置く（下の段落）。
今までの行の印は、次の場所へ移った。

- 状態と経過は、実行中なら現在の札の 1 行目。コンテキスト使用量、コスト、ターンとトークンは (i) に出し（2026-10-11 に札から移した）、終わった後は見出しの下の 1 行にも出す。
- 先頭の行は、別の Claude に渡す宛先（「宛先」、動いていなければ「ID」と hangar の session_id）で、行の「コピー」で宛先の 1 行を写す。下の「セッションの宛先」の節を参照。
- モデル、effort レベル、権限モード、開始、作業ディレクトリ、アカウント、起動、ターンとトークン、コンテキスト使用量、コスト、変更したファイルの数、PR、クイックセッションの印は、見出しの右端の (i) のポップオーバー（`presentDetails`、見出しは「詳細」）。値の無い行は出さない。権限モードは起動のときに選んだ値（`RunDto.permissionMode`）で、Claude の中で切り替えた値は分からない。アカウントは 2 件以上あるときだけ、色の点を添える。
- 他の PC で実行中の札（応答が途絶えていれば別の色）と、トランスクリプトが他の PC にあることは、名前の横の札（`views/SessionBadges.tsx`）。操作できない理由なので、ポップオーバーには隠さない。
- セッションのノートは 0.4.0 で外した。見出しの行の「ノート」の札も、終わった画面のノートの欄も無い。
- アーティファクトは、実行中なら現在の札の数の札、終わった後は見出しの下の 1 行の札。
- 区切りを付けたので止めた知らせと、「要約のみ」「トランスクリプトがありません」は、見出しの下の 1 行。
- 要約が無いときは何も言わない（「要約はありません」「要約は設定で有効にできます」は 2026-10-16 にやめた。本文が消えた会話だけは「要約はありません」と言う）。設定の要約エンジンが「使わない」なら「要約を再生成」も出さない（サーバが受け付けない）。
  土台の要約（`source = 'baseline'`）は、索引が最初と最後の依頼から組んだ事実の羅列で、見出しと重なるので出さない。本文が消えた会話だけは、残った手がかりとして出す。
- 中断で終わったセッションは、見出しの下の 1 行の「終了」の代わりに、中断の輪と「PC の再起動で中断 · 時刻」を出す。
- 同じファイルを別のセッションと編集している間は、現在の札の意図とツール呼び出しの下、数の札の上に「同じファイルを編集中」の 1 節を置く（相手の名前と、重なったファイルの名前。相手の名前を押すとそのセッションへ、「詳細」で中身が開く）。状態の行（いちばん上）は止まっている理由の札に譲る。

現在の札（`views/NowCard.tsx`、値は `presenters/live.ts` の `presentNowCard`）は、生きた run があるときだけ、右の列の上（目次の上）に置く。
はじめ（段 4）はターミナルの真上の 2 行の帯にしていたが、2026-10-11 に右の列へ移した。
帯はタブの列の真下にくっついていて、シェルのタブへ替えても付いてくるので、中身（セッションのもの）とタブ（ターミナルのもの）がつながって見えた。
帯の幅に意図が入り切らず、いちばん読みたい「何のために」が途中で切れていた。
試作（中身、言葉、数字、配置、動き、目次を閉じたとき）から、利用者が A2・B2・N2・C1・D3・E1 を選んだ。
- 上から、状態の行（作業中、入力待ち、アイドル、バックグラウンドで作業中と、経過や進み具合）、入力待ちの問い（「Claude の問い」の見出しつき。裏だけ動いているときはその 1 行）、意図、直近 3 つのツール呼び出し、数の札（「ほか N」、サブエージェント、アーティファクト）を積む。
- 作業中の進み具合は「N 手目 · 経過」。N はメイン会話の呼び出しの数（Agent の起こしは数え、hangar 自身の MCP は数えない）、経過は今のターンの頭からの時間で、時刻の付いた行が無ければ「N 手目」だけにする。ターンの番号は目次にあるので出さない。
- 意図は引用符で囲まず、「Claude の意図 · 時刻」の小見出しを添えて全文を折り返して出す。無ければ「まだ意図が届いていません」、前のターンのものしか無ければ「このターンの意図はまだ届いていません」。
  設定の「ターンの意図と操作の短い説明を送る」（`liveHints`）が切なら、どちらの文も出さず、同じ場所にそのターンの利用者の発言の冒頭を灰色の見出し「依頼 · 時刻」で出す（「指示の注入」の節）。
- ツール呼び出しは縦に並べ、説明（ファイル名、検索の語、Bash の description）を先に、道具の名前を後ろに小さく置く。直近より前のものは「ほか N」の札のポップオーバー（直近 30 回まで）。サブエージェント 1 本ずつと、アーティファクトの一覧も、札を押すポップオーバーに入れる。
- 札の全体は読み上げの領域にせず、状態の語だけを `role="status"` にする。
- コンテキスト使用量とコストは (i) の行に置く（札は「いま何が起きているか」だけにする）。
- 札は目次と同じ畳める器（`.toc-slot`）の中、目次の上に入れる。右の列を畳むと札も目次も一緒に消え、本体（ターミナル）が右端まで広がる。開くと両方が戻る。2026-10-11 の #162 は、札を畳まずに目次だけを出し入れする作りにしたため、実行中は右の列を畳めなくなっていた（利用者の報告で 2026-10-12 に戻した）。
- 札の背は中身に合わせ、伸びるのはすぐ、縮むのは節目だけにする（`views/useCardHeight.ts`、2026-10-12 の試作の案 k）。
  札の下に目次を積むので、意図の折り返し、手の数、問いで札の背が替わると、目次の先頭がその分だけ跳ねる（目次のガクガクの直しをやり直すことになる）。
  はじめ（#162）は見た一番高い背を下限にして縮めなかったが、問いや長い意図で一度伸びると、短い中身の下に空白が残り続けた。
  中身の箱（`.nc-body`）を測って札の `style.height` に書き、伸びるときは前の背から `--dur` で動かす（motionKit の `resizeFrom`、reduced motion では動かない）。
  縮むのは節目だけである。節目は、状態の色（作業中、入力待ち、アイドル、バックグラウンドで作業中）が替わったときと、問いやサブエージェントの 1 行が出入りしたときである。節目では中身の背まで動かして縮める。
  新しいターンの始まり（作業中に入って手がまだ無い）は節目にしない。前のターンの背を保ち、手が埋まって中身が伸びるまで目次を動かさない。
  時間では縮めない。節目の間は手の数や意図の折り返しで中身が縮んでも、背を保つ。
  保つ背は右の列の高さの 6 割までにして、小さい窓で目次を押しつぶさない。中身がそれより高ければ中身に合わせる（中身は切らない）。
  幅が変わったとき（窓、サイドバーの開閉）は折り返しが替わるので、保った背を捨てて動かさずに合わせ直す。セッションが替わったときも同じにする。

終わったセッションの画面は、2026-10-16 に作り替えた（試作で利用者が T1・H1・S5 を選んだ）。
それまではトランスクリプトの先頭に「冒頭の 1 枚」を置いていたが、見出しと重なる事実の羅列（土台の要約、作成元、要約の誘い）で埋まり、本文の大半は等幅の道具の行で、目次は 1 ターンだと空いていたので、利用者が「見ようと思わない」と言った。

- 見出しの下の 1 行（H1、`views/EndedFacts.tsx`、値は `presenters/session.ts` の `presentLeadCard`）。見出しの段（`PageHeading` の `below`）に、押せない理由の行の上に置く。ステータスの札（見出しに状態の札がある間は出さない）と設定した日、終了（止めた知らせ、中断）、「要約のみ」などの印、ターン、トークンとコスト、git の札、変更したファイルとアーティファクトの札、PR を小さい字で 1 行に並べる。
  変更したファイルとアーティファクトの札は、押すとこの 1 行の下へ一覧が開く（同時には 1 つ）。変更したファイルの一覧の下に「差分を表示」を置く。
- 要約の札（S5、`views/SummaryCard.tsx`）。土台の要約でない要約（Claude の `set_session_summary` や要約エンジンが書いたもの）があるか、作成中か失敗の知らせがあるときだけ、右の列の目次の上（実行中に現在の札が出るのと同じ場所）に置く。現在の札と同じ形で、左に完了の色の線（`inset 3px`）を引く。中身は「要約」と進捗、知らせ、本文、次のステップ、「要約を再生成」。作成元（要約器とモデルと時刻）は行にせず、進捗の title で読む。本文が長いときは札の中でスクロールし、目次を押しつぶさない（右の列の高さの 6 割まで）。札は目次といっしょに ⌘J で畳まれる。本文の無い会話は右の列を持たないので、本文の欄の上に置く。
- 道具の行のまとめ（T1、`views/ToolGroup.tsx`、並びは `presenters/toolGroups.ts` の `groupRows`）は、下のトランスクリプトの段落。
変更したファイルの並びと件数は `GET /api/sessions/:id/files`（画面を開いたときと、見ているセッションの run が終わったときに取る。失敗は知らせない補助の表示）を正とし、足した行と消した行は読み込んだ窓にあるファイルにだけ付ける。
行を押すと選んだエディタで開く。
`POST /api/sessions/:id/open-editor` に `file` を添えると、サーバはそのセッションが編集系のツールで変えたファイル（`event_index` の綴りそのまま）で、いまもファイルとしてある（ディレクトリに替わっていない）ものだけを開く。
別のセッションが変えたパスと、Read で読んだだけのパスは開かない。
任意のパスを code に渡させないためである。
`file` が無ければ、今までどおり作業ディレクトリを開く。
本文は、動いていても止まっていても（Done、Archived、サブエージェントの窓も）、末尾（いちばん新しい会話）が見える位置から開く。
セッション画面を開くたびに末尾を追う形で始め（`openAtLatestStep`）、前に上へ遡って追うのをやめていたセッションも開き直せば末尾から始まる。
最初のページが届いて行の高さを測り終えるまで、末尾に着け直す。
続けて呼んだツールの呼び出し（間に利用者や Claude の文、思考、知らせが挟まらないもの）は、1 行にまとめる（T1）。
まとめの行は、札（同じツールなら「Bash ×5」、混ざれば「ツール ×5」、1 回だけなら名前だけ）、最後の呼び出しの説明（Bash は description、無ければコマンド。ほかは畳んだ行の要約の文）、時刻を 12.5px の控えめな字で並べ、失敗があれば「失敗 N」を添える。
押すと、左の細い線の下に呼び出しを 1 つずつ小さい等幅の行（`ToolItem` の compact）で開き、各行は押すと今までどおり入出力が開く。1 回だけのまとめは、押すと中身までいっしょに開く。
サブエージェントを起こした呼び出しはまとめずに 1 つで置き、畳んだままでも「サブエージェント X を見る」を押せる。
「詳細表示」の間はまとめず、今までどおり 1 件ずつの行にする。
仮想スクロールの単位はまとめた後の行で、行の鍵は先頭の seq である。本文の中の検索と検索の結果からの跳び先は呼び出しの seq で来るので、それを含む行へ送り、まとめと呼び出しを開いて見せる（開閉の控えは `views/transcriptOpen.tsx`、まとめは先頭の seq の `group`）。畳んだまとめには、中の一致の数を添える。
サブエージェントの窓へ切り替えたときも、その窓の末尾から始める。
例外は検索の結果から開いたときで、跳び先の行を優先して末尾を追わない。
利用者が上へスクロールしたら追うのをやめ、その後に行が届いても送らない。
「古い行を読み込む」は、追っている最中なら追うのをやめ、見ていた行を目印にしてから読み込むので、前に足した行の分だけ位置が動くことはない。
「最新へ移動」で末尾を追う形に戻せる。

ターンの数は、(i) の「ターンとトークン」と同じ出所（セッションの統計の `turns`）を使う（`presentSession` の `turnCount`）。
窓に読み込んだ行の数は使わない（右の目次が「7+ ターン」、当時の上の帯が「104 ターン」と食い違っていたため）。
最初の events が届くまでは数を出さない（仮の「0 ターン」を出さない）。
サブエージェントを見ている間だけは統計が無いので、その窓の行の数を出し、古い行が残っていれば `+` を添える。
閉じたときの札「目次 N」も同じ数で、届くまでは数を添えない。
終わった画面で、要約の札が無く、ターンが 2 つ以下なら、右の列ははじめ畳み、「目次 N」の札にしておく（`presenters/tocFold.ts` の `tocFolds`）。
そのときの開閉は保存する開閉（`transcriptOpen`）を使わず、その画面だけの開閉（`tocPeek`、保存しない）で持つ。札を押すか ⌘J で開き、セッション画面を開き直すと畳んだ形に戻る。
`transcript.toggle` は mediator が同じ判定で行き先を振り分けるので、⌘J が保存する開閉を書き換えることはない。要約の札があるか、ターンが 3 つ以上なら、今までどおり保存する開閉に従う。
古い行が残っていれば、先頭に「古いターンを読み込む」のボタンを置く。
残りの数は添えない（統計の数は中断の知らせも数えるので、窓との差を残りのターンとは言い切れない）。
ボタンは欄の幅と 1 行の高さに固定し、文字が替わっても折り返さない。
行は押すと、そのターンだけを中身つきで開く。
実行中は、左のターミナルも transcript でそのターンへ跳ぶ。
手の種類の色帯を行の下に出す。
右パネルの開閉は ⌘J と、右の列の右上のボタンで行う（`session.toc.*` の辞書の鍵）。
タブの列のある画面では、右の列の上端にタブの列と同じ高さの頭の行（`.toc-slot-head`）を置き、その右端に畳むボタンとキーの表示を置く（2026-10-12、利用者が選んだ試作の A「列の頭の行」）。
ボタンは札にも目次にも属さず、列そのものの頭にある。
頭の行と下の札の隙間は詰めるので、札と目次の縦の幅は減らない。
タブの列の無い画面（トランスクリプトの画面）では、目次の見出しの行の右端に置く。
閉じると列ごと消え（`minmax(0, 1fr) 0px`、列の隙間も 0）、実行中は現在の札も、終わった後は要約の札も一緒に消える。「目次 N」の札がタブの列の右端に出る（終わった後はトランスクリプトの切り替えの行の右端）。
どちらの画面でも、畳むボタンと「目次 N」の札は同じ右上の場所にあり、押した場所をもう一度押せば戻る。
畳んでいる間はタブの列を全幅にかけ（`.c-body[data-folded]`）、閉じる動きの間も札を右端に留める。
現在の札がある間は、「目次 N」の札にその状態の点を添え、札も中に畳まれていることを示す。
以前は畳むボタンを目次の見出しの行の先頭（札の下）に置いていたが、目次のボタンが札まで畳み、開く場所（右上の札）とも離れていたので移した。
窓が 1000px より狭いときは（`useNarrow`）、右の列を持たず、札を押すと現在の札と目次が本体の右に重なって開く。
上乗せは本体の上端から重ね、タブの列のある画面では頭の行が「目次 N」の札の場所を覆う（キーの表示は添えない）。
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
会話の欄と目次を出さず、理由の注記を一行置き、その下に要約の札を 1 列に積む（右の列が無いので本文の場所に出す。土台の要約も残った手がかりとして出し、何も無ければ「要約はありません」）。「要約のみ」の印は見出しの下の 1 行に出す。
実行中のセッションは、ターミナルを主、帯を従に置く。
上部にタブ列があり、タブ 0 が Claude、以降がシェルである。
セッション画面を離れると、そのセッションのターミナル接続は切る。
xterm のインスタンスとスクロールバッファは残すので、戻ればすぐ描かれ、`tmux attach` が現在の画面を描き直す。
接続を持ち続けると、渡り歩いたセッションの数だけ `tmux attach` のプロセスが残るためである。
2 つのタブを横に並べられる（「横に並べる」）。

#### セッションの宛先

別の Claude（hangar の別のセッション）に「このセッションに送って」「このセッションの様子を見て」と頼むために、セッションを指す 1 行をコピーできる（2026-10-15）。
入口は 3 つで、(i) の先頭の行の「コピー」、「…」の「宛先をコピー」、⌘⇧C（ほかの OS は Ctrl+Alt+C）である。どれも `session.copyAddress` を出し、mediator が `sessionAddressLine` で 1 行を組んでクリップボードへ写し、写せたらトーストで知らせる。

- 動いているとき：`hangar のセッション「<名前>」（宛先: <宛先>、session_id: <hangar の id>）`。
- 登録に名前が無いとき：宛先を外す。終わったセッションは、さらに「終了」と添える（宛先はもう届かない）。

`claude -r` に渡すために、Claude Code のセッション ID（`providerSessionId`）だけもコピーできる（2026-10-16、0.7.1）。
1 行の `session_id` は hangar の ID で、`claude -r` では開けないためである。
入口は、「…」の「宛先をコピー」の下の「セッション ID をコピー」、一覧とサイドバーの行のメニュー（右クリックと .）の同じ名前の項目、⌘⌥C（ほかの OS は Ctrl+Alt+Shift+C）である。どれも `session.copyId` を出す。
macOS の ⌥ は文字を変える（⌥C は ç）ので、⌘⌥C は文字でなく物理キー（`code`）で当てる（打鍵の `alt`）。

セッションを指す文字列は 4 つあり、役目が違う（2026-10-15 に 2.1.300 で確かめた）。

| 文字列 | 使い道 | 出どころ |
|---|---|---|
| 宛先の名前 | SendMessage の `to` | 登録（`~/.claude/sessions/<pid>.json`）の `name`。hangar が名前付きで起こすと `-n` の名前（`nameSource: user`）、無ければ `<cwd のフォルダ名>-<16 進 2 桁>`（`derived`）。`/rename` で変わる |
| `[ref]` | 名前が重なるときに `名前 [ref]` で相手を決める | 登録の `messagingSocketPath` から `sha256("session:<パス>")` の先頭 6 桁（`compat/registry.ts` の `registryRef`）。プロセスごとに変わる |
| 会話の UUID | `claude -r`、本文のファイル | SendMessage の宛先にはならない（断られる） |
| hangar の session_id | hangar の MCP（`get_transcript` など） | `sessions.id` |

宛先は `LiveSessionDto.address` で UI へ渡す。`readRegistry` が、名前が 1 つだけならその名前、同じ名前が 2 つ以上あれば `名前 [ref]` を入れる。ソケットのパスが無ければ ref を作れないので、名前だけにする。
名前も ref も、そのプロセスが生きている間だけ使える。

目次（`TurnIndex`）は右の列にあり、実行中も終わった後も同じ場所に同じものを置く（実行中は現在の札の下）。
見出しは「目次」とターンの数、下端に「最新へ移動」である。
「最新へ移動」は、目次が末尾まで見えていて、ターンを開いておらず、左のターミナルも跳ばしていないときは何もしないので出さない。上へスクロールするか、ターンを開くと出る。
末尾にいて何も開いていない間に一覧が低くなっても（上の現在の札が伸びた、窓を縮めた）、末尾に留める（`TurnIndex` の大きさの見張り）。
#### セッション画面 C の部品（段 4 の PR 7 で作り、PR 8 で画面に付けた）

設計は `docs/superpowers/specs/2026-10-09-stage4-screens-design.md` の 2.3、試作は `2026-10-09-session-screen/options.html` の C である。
次の部品と経路は、PR 7 が今の画面を残したまま先に入れ、PR 8 が画面を切り替えて付けた。
試験用の頁（`packages/ui/preview/primitives.html?only=session`、例は `preview/session.tsx`）で試作と並べて撮れる。

- 現在の札（`views/NowCard.tsx`、値は `presenters/live.ts` の `presentNowCard`）。上の段落のとおり。
- ノートの編集の部品（`views/NoteEditor.tsx`、`views/EditableNote.tsx`）は、セッションのノートと一緒に 0.4.0 で消した。
- 冒頭の 1 枚（`views/LeadCard.tsx`）は 2026-10-16 にやめ、見出しの下の 1 行（`views/EndedFacts.tsx`）と要約の札（`views/SummaryCard.tsx`）に分けた。値はどちらも `presenters/session.ts` の `presentLeadCard`。上の段落のとおり。
- 見出しの名前の横の札（`views/SessionBadges.tsx`、`presentSessionBadges`）。
- 目次だけの右パネル（`views/TocPane.tsx`）。240px の細い列で、中身は `TurnIndex`。開閉のボタンは `TocToggle`（既定は ⌘J と同じ `transcript.toggle`。狭い窓では渡された関数を呼ぶ）で、右の列の頭の行か、目次の見出しの行の右端（`TurnIndex` の `trail`）に置く。
- 文は `session.strip.*`、`session.lead.*`、`session.note.*`、`session.lock.*`、`session.details.*`、`session.toc.*` などの辞書の鍵で、日英が同時にそろっている。
  1 ターンは英語で単数形（1 turn）にする（辞書の文の複数形の書き方。`presenters/stats.ts` の `turnsText`）。
- 経路。`GET /api/sessions/:id/files` は、`event_index` の編集系のツール（Edit、Write、MultiEdit、NotebookEdit）の呼び出しをパスでまとめ、`{ files: { path, edits, agentId }[] }` を索引した順に返す。`agentId` はサブエージェントだけが触ったときの id で、メイン会話が触っていれば null である。本文のファイルが無くても返せる。
- `RunDto.permissionMode` は、起動のときに選んだ権限モードを `runs.launch_params` から読んで載せる（列は足さない）。選ばなかった起動と、ターミナルの包み方からの起動は値が無く、鍵ごと送らない。起動のあとに Claude の中で切り替えた値は分からない。

端末は墨の板で、縁がそのセッションの状態で灯る。
作業中は杏の輪と光がゆっくり明暗を往復し、入力待ちは赤の輪と光で動かず、休みと終了は灯さない。
タブは板から生えたフォルダの耳で、選んだタブが板と同じ墨色になってつながる。
要約の札の作成元（進捗の title）は、何がこの要約を書いたのかが作り直すかどうかの判断に要るために持つ。
要約器は「OpenAI 互換 / モデル名」「claude / モデル名」と言う。
source_id の `lmstudio` は LM Studio だけだった頃の名前のまま残したが、中身は OpenAI 互換の要約器なので、画面には LM Studio と出さない（`summarizerLabel`）。
他の PC で実行中なら、見出しの名前の横に「MacBook で実行中」（その PC の最終接続が 3 分より古ければ「MacBook から応答がありません」）の札を出し、最終確認の時刻を title と読み上げに持たせ、再開とフォークは理由を添えて押せなくする。
手元に本文が無いセッションと、他の PC のロックがあるセッションでは「この PC で再開」を押せる（ロックが生きていれば、押すと停止を頼む確認の 1 枚が出る）。
停止を頼んで引き継ぐ操作は、2026-10-16 に入れた（「他端末セッションのロックと『この PC で再開』」）。

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
いちばん新しい返答（手元の最後の `assistant` の行）だけは、はじめから開いて切らない。
本文は末尾が見える位置から開くので、切ると、開いた直後に見えるのが最新の返答の「全文を表示」の行になり、読み終わっていないように見えるからである。
一度開いた返答は、次の返答が届いても畳み直さない。読んでいる途中の返答が縮んで位置が飛ぶからである。
検索の結果から真ん中の頁だけを読んだとき（後ろをまだ読んでいない）は、手元の最後の返答は最新ではないので切る。
終わったセッション（`live` でない本文）では、Claude の返答をどれも切らず、開閉のボタンも置かない。
終わった会話は結論を読みに開くもので、ツールの行を畳んだ分だけ長さは許せるからである（2026-10-16 の利用者の決定）。
切ると高さだけで位置が決まるので、段落や表の途中にボタンが浮いて見えていた。
利用者の長い指示（貼り付け）と思考は、終わった後も切る。

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
現在の札は、描いた後に増えたツール呼び出しだけをフェードで入れ、一度だけ薄い杏色に光らせる（開いた直後とセッションを替えた直後は光らせない）。意図と問いは替わったときにフェードで入れ替える。札の灯は脈を打たせず静止させる（2026-10-11 の試作の D3）。動きを減らす設定では、どれも動かさない。
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
- `motionKit.ts`：入る形（`riseIn`、`fadeIn`。`fadeIn` は長さのトークンを選べる）、薄れて消える形（`fadeOut`）、伸びて入る形（`growIn`。`shapeNow` で読んだ途中の形からも伸ばせる）、畳んで出る形（`collapseOut`。`fade: false` で高さだけを畳む）、高さの補間（`resizeFrom`）、横へ抜ける形（`slideAway`）、上がった行の key（`risenKeys`）、滑り（`slideFrom`）、状態の印の膨らみ（`popMark`）、地の淡い黄の薄れ（`markHit`）。
  伸び縮みの間だけ中身のはみ出しを隠す（overflow: hidden）。元の指定は要素ごとに 1 つ控え、いちばん新しい動きの後始末だけが戻す。畳み終えた箱は隠したまま置き、次に伸ばし終えたら畳む前の指定へ戻す（畳む途中で開き直したとき、遅れて届く取り消しの後始末が伸びる途中の hidden を外さない）。
- `useMotionList.ts`：リストの出入りをまとめるフック。消えた key は `leaving` として畳み終わるまで描き続け、出る途中で戻った key は元へ戻す。FLIP は残った key（前の描画と今の描画の両方にある key）の並びが変わったときだけ走る。足したり消したりしただけの描画では滑らせない。`scope` が替わった描画と、空の一覧からの描画（前が 0 件）は、出る行も入る動きも作らない。先頭への足し（古いものの読み込み）を動かさない `ignorePrepended` も持つ。入りを動かさない `enter: 'none'`、出る形を差し替える `exit`、空になる描画でも出す `exitWhenEmpty` は、右下の知らせが使う。並びが替わった描画で上がった行に `markHit` を付ける `hitRisen` は、ホームの引き出しが使う。
- `usePresence.ts`：単独の部品の出入り。開き直したときは、出る動きを取り消して戻す。取り消すのは Web Animations だけで、CSS の animation と transition（灯の脈など）は止めない。
- `layoutMotion.ts`：動いている箱に `data-layout-moving` を付け、`TerminalPane` はその間 fit を見送る。印は要素ごとに数え、`begin` で増やし `end` で減らし、0 になったときだけ印を外して `hangar:layout-settled` を出す。端末はそこで 1 回だけ fit する。重なった動きの片方が先に終わっても印は残る。
- `paneMotion.ts`：右パネル（セッション画面の目次の列は `PANE_SHAPE.toc`、プロジェクト画面の右パネルは `PANE_SHAPE.rail`）の開閉。列の計算値（px）を前後で測って `gridTemplateColumns` と `columnGap` を滑らせる。動いている間、欄の中身は開いたときの幅に留めて、折り返さずに端で切る（「下へ潜る」）。閉じるときは中身を `--dur-exit`、`--ease-in` で薄れさせてぼかす。開くときはぼかしが 35% で晴れながら現れる。

各箇所の振る舞いは次のとおりである。

- 右の欄の開閉：閉じる動きが終わるまで中身を描き続け、終わったら外す（`usePresence`）。タブの帯の開くボタンは、開き始めにその場で外し、出る動きは付けない。実行中の画面（現在の札と目次）も終わった画面（目次だけ）も、同じ本体（`.c-body`）の列を同じ `paneMotion` で動かす。狭い窓の重なりの目次は、列ではないので動かさない。開閉の間、端末は折り返さない（tmux の描き直しは動きが終わってから 1 回）。開閉はセッションごとに覚えているので、別のセッションへ替えて開閉が替わったときは、動かさずにすぐその形にする。
- ターンの目次：新しい行は入る形で末尾に入り、何も開いていない間は末尾へ滑らかに追従する（reduced motion、最初の描画、セッションやサブエージェントを替えた描画、空や仮の行から埋まった描画は即座）。ターンを開くと中身が伸びて入り、閉じると畳んで出る。開いたターンの寄せ（`revealWithin`）は、伸び切ったあとに一気に行う（滑らかには動かさない）。見出しの数（ターン N）は、届いたときに薄れから現し（`fadeIn`）、以後は `RollingText` で数字だけを回す。セッションやサブエージェントを替えたときは回さない。読み込みの印は、利用者が押した古い側の読み込み（`loadingOlder`）と、追記の読み込みに分け、追記の読み込みでは目次のボタンも数も動かさない（追記のたびに「読み込んでいます」へ替わって揺れていた）。ボタンの文字は、利用者が押したときだけ `--dur-fast`（200ms）で薄く入れ替える。古いターンを先頭へ読み込んだときは動かさず、スクロールの位置も保つ。目次の行の並びは FLIP で滑らせない（新しい指示は末尾に足すだけで、残りは動かない）。
- 見出し周りとタブ：要約の一行は、初めて届いたときと文が変わったときに、左から `--rise` 浮かんで入る。タブは、足されたら幅を伸ばして入り、閉じたら幅を畳んで出る。畳んで出るタブは役もフォーカスも持たない見た目だけの複製にする。
- 案内の帯：信頼の案内、終了の案内、transcript の帯は、伸びて入り、畳んで出る。帯の高さが変わる間は、端末の板に `data-layout-moving` を付ける。
- 開いた直後：最初の events が届くまで、目次に淡い仮の行（6 行、幅を少しずつ変える）を、ゆっくり流れる光（`--skel-period`）で出す。reduced motion では流さない。仮の行は、本文があり、窓がまだ作られていないか読み込み中で 0 件の間だけ出す（`turnsPending` は本文のあるセッションに絞る。本文が無いセッションでは窓が作られず、いつまでも出てしまうため）。届いたら行を一度に入れ、末尾へ即座に寄せ、一覧全体を `--dur` で薄れから現す。届いて 0 件なら「まだ指示がありません」を出す。ターミナルは、初めてつなぐときだけ最初のデータが届くまで面を透明にし、届いたら `--dur` で現す（TerminalHost の「最初の描画が済んだか」の印を読む。一度開いたタブは透明にしない）。

### Settings

左の目次で 6 つの節（殻の中は更新を加えた 7 つ）を切り替え、右は選んだ節だけを出す（S1。試作は `docs/superpowers/specs/2026-10-09-settings-screen/options.html`、決めた構成は `docs/superpowers/specs/2026-10-09-stage4-screens-design.md` の 2.4）。
節は、一般（言語、通知、ターミナルアプリ、エディタ、トランスクリプトの保持、hangar が自分で行うこと）、ツール（新しいフォルダの作成場所と「プロジェクトの登録」の行（0.6.1 で「Claude Code と会話したフォルダから…」と「フォルダの中から…」の 2 つのボタン）と、tmux、claude、Node のパスと、git の読むだけの行）、連携（Claude Code との互換、hangar が起動する Claude Code に足すもの、MCP サーバー、ステータスライン、シェル連携、アカウント）、要約エンジン、クラウド同期、情報（使用量、索引、この PC）の順である（`SETTINGS_SECTIONS`）。
2026-10-13 に、上級者向けのベータのクラウド同期を後ろへ下げ、新しい利用者が先に触る一般とツールを前に出した。
クラウド同期の目次の行には、名前の横に「ベータ」の小札（`.tag-beta`）を添え、状態の段（同期オフ、同期済み）は潰さない。読み上げの名前は「クラウド同期 ベータ、同期オフ」である。
節を開いた頭には、同期していてもいなくても「上級者向けのベータです。始めるには、リポジトリの clone、ターミナルでの CLI、自分の Cloudflare アカウントが要ります。」の 1 文を置く。
一般の末尾の「hangar が自分で行うこと」の 1 枚は、claude への指示ではなく hangar の振る舞いのスイッチ 2 つで、自動の Done（`autoDone`）と、Done と Archived の自動の停止（`autoPark`）である（どちらも既定は入り。「実行中の状態」と「指示の注入」の節）。
「勝手に Done になった」「勝手に止まった」と思った人が、同じ 1 枚で両方を見つけられるようにするためである。
殻の中では、要約エンジンとクラウド同期のあいだに更新（版と最終確認、「更新を確認」、見つけた版の取得と再起動、知らせのスイッチ）が入る（「アプリの自動更新」の節）。
ブラウザの目次には更新を出さない。
一般の節の最初の行は言語（日本語、English）で、押した瞬間に保存する（保存のボタンは無い）。
言語はこの PC の設定で、クラウドへは同期しない。
一般の節のターミナルアプリの下にはエディタの欄を置く（候補の一覧のラジオの行、畳んだ「パスを指定…」、選んだ行の「テスト」、「再確認」。任意のコマンドは 2 つの欄と打つそばから変わる見本。「エディタの選択」の節）。選んだ時点で保存する。
開いている節は URL の `at` が持つ（`#/settings?at=cloud`。値は `general`、`tools`、`integrations`、`summary`、`update`、`cloud`、`info`）ので、戻ると進むで節も戻る。
`at` が無ければ一般を出す。`sync`（ヘッダーの同期の語）はクラウド同期、`accounts`（ヘッダーのアカウントの設定）は連携の別名で、`accounts` は節を開いたあとアカウントの位置まで滑る。
`at` には節の中の欄も指せる。`workspace`、`tmux`、`claude` はツールの節のパスの欄、`compat` は連携の節の互換性の節、`editor` は一般の節のエディタの欄で、開いたら見える所へ移って目立たせる（ホームの準備の帯の「設定を開く」が使う）。
目次の灯りは URL に従うので、節を移った直後に前の節が灯ったまま残ることは無い。
節を切り替えたら、頁をスクロールする枠の先頭へ戻す。
付属の値（準備の確かめ、使用量、保持期間など）は設定の画面に入ったときに 1 回だけ取り、節の切り替えでは取り直さない。
目次の各行は、節の名前と今の状態の 1 行を持つ（`presentSettings` の `toc`）。
一般は通知の状態、クラウド同期は同期の状態と最終受信（同期していなければ「同期オフ」）、連携とツールは直すものの数（「要修正 N」。無ければ「問題なし」「すべて検出」）、要約エンジンは選んだもので言い分け、使わないなら淡い「オフ」、Claude なら「Claude（枠を使う）」、OpenAI 互換ならモデルの一覧が取れたかと接続テストの結果（「OpenAI 互換、接続済み」「OpenAI 互換に接続できません」）、情報はセッションの数である。
繋がらない警告は OpenAI 互換を選んだときだけ出す（試作 3 節の 2b の推す案 A）。
連携とツールは、準備の確かめが届くまで「確認中」と言う。
読み上げの名前は「ツール、すべて検出」の形で、節の名前と状態を含む（クラウド同期はベータの小札も含む）。
目次は上下の矢印、Home、End で行を移り、選ぶのは Enter と Space である。開いている行だけが Tab の道に入る。
幅が 1000px 以下の窓では、目次は頁の上に 3 列 2 段（殻の中の 7 つは 4 列 2 段）で並べる（節を切り替える道は目次だけなので、消さない）。
直すもの（無くても動くものを除く ✗）がある節（連携とツール）には、目次の状態と、右の節の見出しに「要修正 N」を出す。
Claude Code との互換のずれは、利用者が直せるものではないので直すものに数えず、目次の状態も見出しの札も要修正にしない。
「要修正」は、利用者が手を打てるものだけを指す言葉にしておく。
新しいフォルダの作成場所は任意なので、決めた場所がその PC に無くても要修正に数えず、欄の下に注意の色で「この場所が見つかりません」と「空にするか、別の場所を選んでください」を出す（`workspaceLine` の soft）。古い設定のまま上げた利用者で、`~/workspace` がその PC に無いときに起きる。
オンとオフの項目はスイッチにして行の右端に置き、ターミナルアプリはアプリのアイコンを添えた切り替えの帯、要約エンジンのモデルは一覧、1 時間の上限は ± の付いた数値の欄にする。
スイッチと帯は切り替えた時点で保存する。
外部の要約エンジンを許可するスイッチだけは、オンにするとき、保存済みの宛先へトランスクリプトが送られる旨を確かめる帯（「許可」「キャンセル」）を挟み、「許可」を押して初めて保存する。
オフにするときは確かめずにその場で保存する。
ツールの節の先頭には、psmux（Windows）か tmux の状態の行を置く（段 6 の B3、`views/MuxSection.tsx`）。
見出しの札で「インストール済み」か「未インストール」かを出し、済んでいれば版とパスを、無ければ入れるコマンドを添え、「再確認」のボタンを置く。
psmux が 3.4.0 より古いときは、札を「更新が必要」にし、版の行に「（3.4.0 以上が必要です）」を添え、症状、上げる前の注意 2 点（psmux を止めるので動いているセッションは全部止まる、hangar の端末ではなく外の PowerShell で打つ）、上げる 1 行（`PSMUX_UPGRADE_COMMAND`、止める・`winget upgrade`・`tmux -V`）のコピー、「上げたら再確認」を本文に並べる（issue #245）。
アプリから winget を起こす道は採らない。hangar 自身のセッションが psmux を握っているので、置き換えに失敗しやすい。
パスの欄（新しいフォルダの作成場所、tmux、claude、Node。どれもツールの節にある）は、欄を出たとき（または Enter）に、その 1 項目だけを保存する。保存のボタンは持たない。
値は前後の空白を落として見比べ、変わっていなければ送らない。
保存できたら欄の横に「✓ 保存しました」を 2 秒出し、断られたらその理由を欄の下に出して、書いた値は欄に残す（トーストにはしない）。
設定の画面を離れたら、欄の下の理由は消す（戻ると欄は保存済みの値に戻るので、理由だけが残ると、いまの値が断られたように読める）。
サーバは保存の前に、ツールのパスが実行できるファイルであること、作成場所がディレクトリであること（空は「決めていない」として受ける）を確かめ、先頭の `~` はホームに直してから保存する。
理由は欄の見出しで言う（例：「tmux のパス」に /x が見つかりません、「エディタのパス」の /x には実行権がありません）。
ツールの欄は名前だけ（`tmux` など）も受け、起動のときと同じく PATH から探して確かめ、打たれたまま保存する（「tmux のパス」の x が PATH に見つかりません）。
`./x` や `bin/x` のような相対パスは、サーバの作業ディレクトリで読むとどこを指すかが分からないので弾く（「tmux のパス」は / か ~ で始まるパスか、tmux のようなコマンドの名前にしてください）。
欄の下には 1 行の検証を置き、動かせるときは見つかったパスと版（作成場所は直下から登録したプロジェクトの数。空なら行を出さない）、動かせないときは直し方を出す（tmux は `brew install tmux` とコピー）。
git は設定の欄が無く、ツールの節に読むだけの行（見つけた場所と版、無ければ入れるコマンド）で出す。無くても動くので弱い色にする。
エディタの欄は一般の節にある（「エディタの選択」の節）。
Node の欄が空のときは、サーバを動かしている Node を「自動で見つけました」と添えて出す。
要約エンジンの節は、使わない、Claude、OpenAI 互換の URL の 3 つのラジオの行で選ぶ（試作 3 節の推す案 A。エディタの欄と同じ作り）。
各行は名前と 1 行の説明を持ち、Claude は「あなたの Claude の使用枠を使います」、OpenAI 互換は「トランスクリプトをこの宛先へ送ります」と、選ぶ前に違いを言う。
選んだ時点で保存し、選んだ行のすぐ下にその行の欄だけを開く。
Claude の欄は、要約に使う Claude のモデル（一覧から選ぶか、名前を打つ）と、1 時間の上限である。
OpenAI 互換の欄は、URL、モデル、API キー（任意。保存済みなら中身を出さず「キーを消す」を添える）、外部の要約エンジンを許可、接続できないときは Claude を使う（既定は切）で、切り替えを入れているときだけ 1 時間の上限を出す。
選んだ行の欄は、ラジオの選択とスイッチを除いてまとめて「保存」で保存し、そのボタンの横に同じ「✓ 保存しました」を出す。API キーは書いたときだけ送り、送ったら欄を空に戻す。
URL の欄の下と、OpenAI 互換の行の右端には、モデルの一覧が取れたかで「接続済み（モデル N 個）」か「接続できません」を出す。接続テストのボタンは `summarizer.test` を出し、結果をその下に出す。
使わないときは欄も保存も接続テストも出さない。
要約エンジンか宛先を変えて保存したら、モデルの一覧を取り直す。
連携の 3 枚の札（MCP サーバー、ステータスライン、シェル連携）は、殻の中ではボタンで書く（0.4.0、試作の連携 A）。
札の形と説明文はそのままにし、コマンドの欄をボタンに替える。ボタンの横には「書き込む先：<パス>」と「書く前にバックアップを取ります」を常に出す。
入っていなければ入れるボタン（登録…、設定…、インストール…）、入っていれば解除のボタン（登録を解除…、設定を解除…、アンインストール…）である。
ボタンは殻に頼む（`setup.run`）だけで、書く中身は殻の承諾の窓が見せ、承諾されたときだけ CLI が書く（「承諾の窓」の節）。
返事を待つあいだは押した札を「確認中…」にし、ほかの札のボタンも押せなくする。殻は承諾の窓を 1 つしか出さないからである。
ステータスラインのスクリプトが無いときは押せない（/statusline で作ってから）。tmux が無い PC のシェル連携にはボタンを出さない。
コマンドは「ターミナルで行うとき」に畳んで残す。
ブラウザで開いた画面は書き込まない。ボタンを出さず、その旨と、ターミナルで打つコマンドを出す。
ターミナルで打つコマンドは、薄い地のコードの行と右端のコピーで出し、どれも同じ hangar の呼び方にそろえる（`hangar mcp install`、`hangar statusline install`、`hangar shell install`。入っていれば `uninstall`。hangar に PATH が通っていなければ同梱の hangar の絶対パス）。
同梱の hangar は、macOS では `.app` の `Contents/Resources/server/bin/hangar`、Windows では入れた先の `server\bin\hangar.cmd` である（`shellWrap.ts` の `bundledHangarIn`）。
Windows では貼る先を PowerShell とみなし、英数字と `\ : . _ -` 以外の字を含むパスは `& '<パス>'` の形で書く（`shellHook.ts` の `shellInstallCommand`）。二重引用符で包んだだけでは、PowerShell はコマンドとして動かさない。
リポジトリから動かしているサーバの PATH の `node_modules/.bin`（Windows では `node_modules\.bin`）の hangar は、利用者のターミナルからは引けないので、`npm run hangar -- …` の形にする。
コピーのボタンは、ランタイムがクリップボードに写せたと返してから（Mediator の `copied` が進んでから）「コピーしました」を出す。
写せなかったときは「コピーできませんでした。文字を選んで ⌘C で写してください」とだけ知らせ、写そうとした中身はトーストに出さない。
参加トークンのような秘密も同じボタンで写すからである。
MCP サーバー、ステータスライン、シェル連携の見出しの右には、登録済みか未登録か、設定済みか未設定か、この PC はインストール済みか未インストールかの札を置く。
連携の節の最後（アカウントの後ろ）には「Claude Code に環境を見てもらう」の札を置く（試作の案 C、`views/SetupGuideCard.tsx`。仕組みは「セットアップのすゝめ」の節）。
見出しの右に版の札（灰色の `v0.7.0` の形）、本文に「この一言を Claude Code に貼ると、あなたの環境を読むだけで診断し、散らばった会話のフォルダの登録や連携を提案します。書き換えは、あなたが承諾してからです。」を置く。
その下に貼る一言を等幅の枠でそのまま見せ、右に主ボタン「コピー」を置く。写せたら `COPIED_MS`（1.6 秒）のあいだ「コピーしました」にする。
コピーは書き込みではないので、ブラウザで開いた画面でも押せる。
いちばん下に淡い文「フォルダの移動や削除はしません。CLAUDE.md にも触れません。」と「手引きの中身を見る」を置く。
「手引きの中身を見る」は写した md を設定のエディタで開く（`setupGuide.openEditor`）。エディタが見つからないときは、ほかの「<名前> で開く」と同じ面を出す。
写しが取れていない（同梱物が無い）ときは札を出さない。
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
クラウド同期の節は 1 頁に、上から、状態（見出しの右の札と、状態、最終受信、未送信の変更、未送信のトランスクリプト）、操作（今すぐ同期、同期を一時停止、PC を追加）、PC の一覧、Claude Code の設定の同期（常設の行。中身はダイアログで見せる。「設定の同期の作り直し」の節の「画面（PR 17）」）、Cloudflare の使用量と料金、この PC の参加を解除を置く。
PC の一覧は、小見出し「PC」と「スマホ」で 2 つの表に分ける（試作 cloud-e2e の E2、2026-10-17 に利用者が選んだ）。
PC の表の列は名前、OS（macOS、Windows）、参加日、最終同期である。
互換の版 9 で IP と所在地をやめ（保存も表示もしない）、名前と OS は封じた名簿から出す。
名簿に無い端末は ID で出し、OS の列は空ける。
参加日は手元の時刻の日付で出す。`hangar cloud devices` の日付も同じく手元の時刻で数える（UTC の日付で出していたので、画面と 1 日ずれた）。
殻の中では、他の PC の行の右端に「解除…」を置き、押すと確認がその行のすぐ下に開く。
確認は「解除すると、暗号鍵を再生成して残りの PC に配布します。解除した PC は、これ以降の同期データを復号できなくなります。」と言う。
解除の要求が返るまで（暗号鍵の再生成と配布の間）は、行の下に「暗号鍵を再生成し、残りの PC（n 台）に配布しています」の 1 行を出す。
解除した PC の行は `collapseOut` で畳んでから表を抜け、下の「解除した PC」に解除日つきで並ぶ。
スマホの表は、名前、参加日、最終同期と「解除…」を並べ、確認の文はスマホ用である（なくしたら全部の PC に会話を起動されるので、すぐ解除する旨）。
名前の下には、使わずに切れるまでの残りの日数と再接続の日付を出す枠がある。Worker がまだ期限を持たないので、今は出さない（PR 7 で埋める）。
解除したスマホの行も `collapseOut` で畳んで外し、「解除した PC」のようには並べない。0 台のときは「接続しているスマホはありません。」の 1 行を出す。
スマホの解除を 5 秒の「元に戻す」にするのは PR 7 で、今は PC と同じく確認つきである。
ブラウザでは「解除…」を出さず、`hangar cloud revoke <ID>` を案内し、解除すると暗号鍵を再生成する旨を添える。
Worker の一覧が取れないとき（Worker が版 5 より古い、繋がらない、まだ届かない）は、同期の表（共有テーブルの devices）の一覧に戻し、解除を出さずに理由を添える。
この PC がほかの PC から解除されているときは、節の先頭に赤い帯（「この PC は同期から解除されました。」）を出し、「参加コードで再参加」と「この PC の同期の設定を削除」を置く。
「PC を追加」（試作 cloud-e2e の A1）は操作の段に置き、押すと参加コードを発行して、段の下に欄を `growIn` で開く。
欄は、接続先の URL（コピー）、参加コード（`XXXX-XXXX` を大きな等幅で、コピー）、残り時間の棒（5 分）と、参加リクエストを待つ 1 行と「キャンセル」（コードを Worker で閉じる）を出す。
参加リクエストを受信すると（`join.update` の `requested`）、同じ欄の中身が承認の欄（「〈名前〉から参加リクエストを受信しました」、OS、確認コード 6 桁、「承認」「拒否」）に替わり、高さを `resizeFrom`、中身を `fadeIn` で動かす。
承認が完了すると欄を `collapseOut` で閉じて「〈名前〉が参加しました」の帯を出し、新しい PC が Worker の一覧に現れるまで 3 秒ごとに 5 回まで一覧を取り直す。新しい行は表に `growIn` で入る。
期限切れと失敗は欄の中に理由と「参加コードを再発行」を、拒否は「何も送信していません」を出す。承認の通信が途中で失敗したリクエストはやり直せないので、失敗の文は新しい参加コードの発行を案内する。
設定を開いていないときに参加リクエストを受信すると、右下に通知（試作 C1）を出す。名前、OS、確認コードと「確認して承認」を持ち、押すと設定のクラウド同期（`#/settings?at=cloud`）へ移る。承認と拒否は A1 の欄で行い、通知は状態が `requested` でなくなると消える。設定のクラウド同期を開いている間は出さない。
OS の通知を押したときは、殻が頁の `window.__hangarOpenJoin()` を呼び、頁は設定のクラウド同期へ移って承認の状態を取り直す（受け口は `runtime/notifier.ts` の `onOpenJoin`）。
参加コードの平文は、発行した PC の画面にだけ出す。`join.update` と `GET /api/sync/join-codes/current` は、この PC のトークンと localhost か `tauri://localhost` の Origin を持つ相手（`ws/hub.ts`、`auth/request.ts`）にだけ渡る。
「この PC の参加を解除」は節の末尾に、ほかの PC の解除から離した帯で置く（試作の A）。
「参加を解除…」を押すと、削除するもの（cloud.json と、選べばクラウドの一覧のこの PC）、残るもの（クラウドのトランスクリプト、ほかの PC の同期、受信済みのトランスクリプト）、戻すとき（参加トークンでもう一度参加）を並べ、「クラウドでもこの PC を解除する」のチェック（既定でオン）を置く。
この PC がクラウドを作った PC なら、先に、参加を解除すると `hangar cloud teardown` で片付けられなくなる旨を出す。
済んだら 1.5 秒後にアプリを再起動する。
クラウドで解除できなかったときは、理由とほかの PC から解除する道を読めるよう、自動では再起動せず「再起動して同期を停止」を押してもらう。
ブラウザではボタンを出さず、`hangar cloud leave` を案内する。
同期していない人には、1 文の説明と 2 つのボタン（参加コードで参加、クラウドを用意して始める）と、押せないスイッチの 1 行（Claude Code の設定の同期）だけを出す。
殻の中では、「参加コードで参加」を押すと節の中に参加の段が開く（試作 cloud-e2e の B2）。ブラウザでは `hangar cloud join <URL>` を案内する。
段は、接続先の URL と「次へ」で殻の `cloud_join_check` を呼び、ホスト名と参加済みの PC の台数を出して、参加コードの欄を `growIn` で開く。参加済みの PC の名前は封じた名簿にあり、承認の前は復号できないので出さない。
参加コードは共有の `normalizeJoinCode` で半角の 8 字にそろえ、形が違えばその場で「参加コードの形が違います」と出して、殻にも Worker にも送らない。
「参加をリクエスト」で殻の `cloud_join_request` を呼び（別のクラウドに参加済みなら赤い警告と上書き）、承認待ちの段へ `resizeFrom` で移る。待ちの文は「参加コードを発行した PC で承認してください。」で、確認コード 6 桁と残り時間を出す。
承認待ちの間は 2 秒ごとに `cloud_join_poll` を 1 本ずつ呼ぶ。殻の `busy` と一時的な接続の失敗は待ち続け、承認で完了の段を出して 1.5 秒後に再起動する。
拒否、期限切れか使用済みのコード（`code-not-found`）、5 分たっても承認されない（Worker の `expired` と、手元の期限の後の最後の問い合わせ）は、それぞれの文と次の手順（新しい参加コードを発行してもらう）を出し、「参加コードを入力し直す」で参加コードの段へ戻る。
参加コードは画面の欄と Runtime から殻へ渡すだけで、Store には置かない。
宛先の確認は、ホストを大きく、URL を小さく出し、CLI と同じ注意の文を添えて、「自分が hangar setup cloud で作ったクラウドです」のチェックを入れるまで「この宛先に参加」を押せなくする（CLI の y と同じ重さ）。
別のクラウドに参加済みか、同じ宛先で参加用の秘密が違うときは、いまの宛先と新しい宛先を並べた赤い警告を出し、ボタンを「上書きして参加」にする（CLI の overwrite と同じ段）。
失敗は理由と「この PC の設定には何も書いていません」を出し、秘密が違うか読めないときは「貼り直す」、繋がらないときは「もう一度試す」にする。
参加が済んだら「<ホスト> に参加しました」を出し、1.5 秒後にアプリを再起動する（サーバは起動後に現れた cloud.json も見つけて始めるが、アプリはここで再起動して確実に立て直す）。
ブラウザで開いているときは、2 つのボタンは、押すとターミナルで打つコマンドを出すだけで、参加はアプリから行わない。
クラウドの用意はどちらでもアプリから行わない。
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
操作ボタン（今すぐ同期、同期を一時停止、PC を追加）の下に「使用量と費用」の段を置く（試作は `docs/superpowers/specs/2026-10-02-cloud-usage/usage-merged.html`、仕組みは「クラウド同期」の「使用量と費用」の節）。
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
ステータスラインの節は追記の有無と追記先のパスを出す。書き込むのは上のボタン（殻の中）か CLI である。
スクリプトはあるが hangar の行が入っていないときは、「ステータスラインのスクリプトはあります。hangar へ値を渡す数行は、まだ入っていません。」と言う。
以前は「まだ設定されていません」だけで、利用者のステータスラインがあるのに、ステータスライン自体が無いと読めた（0.4.0-rc.1 の Windows の実機。判定は合っていた）。
MCP の登録の有無は `~/.claude.json` の `mcpServers.hangar` を読んで決める。読むだけで書かない。
シェル連携の節は、同期している PC ごとの包み方の状態（インストール済み、未インストール、tmux が無いので使えない）と、この PC で入れるボタン（殻の中）か、入れるために貼るコマンド（ブラウザ）を出す。
トランスクリプトの保持は一般の節の行で、Claude Code の保持期間と本文の使用量を出す。書き換えるのはこの行だけで、期間を押すと差分を見せる確認を開き、「書き込む」を押して初めて書く。
通知は一般の節の行で、「通知を有効にする」のスイッチ 1 つで、入力待ちを窓の外へ知らせるかを決める（「入力待ちの知らせ」の節）。
無くても動くので、直すものの数には入れない。
通知を出せない環境（ブラウザで拒んだ後や、Notification の無いブラウザ）では、スイッチを押せなくして理由を添える。

### 承諾の窓

利用者のファイルを画面から書く操作は、どれも殻の承諾の窓を通す（0.4.0、試作は承諾のダイアログの B）。
対象は、連携の書き込み（`hangar mcp install` と `uninstall`、`hangar shell install` と `uninstall`、`hangar statusline install` と `uninstall`）と、設定の同期の適用と世代へ戻す（`hangar config apply`、`hangar config restore`）である。
書くのは殻の命令と CLI だけで、サーバと HTTP の API は書かない（全体計画の D9）。

流れは次のとおりである。

1. 頁（サーバの UI）が殻の命令を呼ぶ。連携は `setup_integration(target)`、設定の同期は `apply_config_sync` と `restore_config_sync(name)` である。
   頁から受け取るのは、決まった対象の名前（`packages/shared/src/setup.ts` の `SETUP_TARGETS`）と世代の名前だけで、殻が形を確かめる。
2. 殻が CLI に見立てを出させる（連携は `--dry-run --json`、設定の同期は `--plan --json`）。何も書かない。
   見立てが「済んでいる」（`noop`。登録済み、入っていない）か「書けない」（`blocked`。Windows のシェル連携、zsh でない、tmux が無い、スクリプトが無い、壊れた JSON など）なら、窓を開かずに理由の鍵（`code`）つきで返し、画面が知らせる。
3. 殻が自分の窓（ラベル `approve`）を開き、殻に同梱した頁 `loading/approve.html` に見立てを見せる。この頁はサーバを通らない。
4. 利用者がその窓で書き込みのボタンを押したときだけ、殻が CLI の `--yes --json --expect <指紋>`（適用は `--order` も）を走らせる。
   CLI は書く直前に見立てを作り直し、指紋が見せたときと違えば、何も書かずに `changed` で断る。

窓の頁は、題、3 つのタブ（何をどこに、差分、同じコマンド）、補足の表（バックアップ、書いた後、補足）、キャンセルと主のボタンを持つ。
何をどこにはファイルごとに、操作（新規、変更、削除、hangar の置き場）と、何をするかの 1 文を出す。
差分はタブを押して見る。MCP の API トークンは伏せ字にして黒い帯で描き、トークンそのものは見立てにも頁にも載せない。
同じコマンドは、ターミナルで同じことをするコマンドである。
解除とアンインストールの主のボタンは赤にする。
設定の適用で、実行される指示（スキル、コマンド、エージェント）やフックを含むときは、見出しを注意の見た目にし、補足にその件数と名前を書く。
段は確認、書き込み中、完了、失敗の 4 つである。
完了はバックアップの置き場を出し、閉じるだけを置く。
バックアップの名前の末尾の日時は、書き込みを押したときに決まる。
そこで見立ては名前を `claude.json-YYYYMMDDhhmmss` のように日時の形のまま渡し（`setupPlan.ts` の `BACKUP_STAMP`）、確認の段は「（YYYYMMDDhhmmss は書き込んだ日時）」を添え、完了の段は実際の名前を出す。
窓を開いた時刻で名前を決めて見せていたときは、見せた名前と書いた名前が食い違った（0.4.0-rc.1 の Windows の実機）。
失敗は「書き込めませんでした。何も変えていません。」と理由を出し、閉じると再読み込み（見立てを出させ直して確認へ戻る）を置く。
書く先が見せた後に変わっていたとき（`changed`）は、別のプログラムが変更したと言い、再読み込みを促す。

殻への結果は、書けたらすぐ返す（画面の札がすぐ変わる）。
取り消しと失敗は、窓を閉じたときに返す（失敗のあとに再読み込みして書き直せるからである）。
書いている最中に窓を閉じられたら、書き終わったところで結果を返す。
窓は同時に 1 つだけで、出ているあいだの別の頼みは `busy` で返し、出ている窓を前に出す。

命令の権限は次のように分ける。

- 承諾の窓の 2 つの命令（`approve_view`、`approve_answer`）は、`approve` の窓の、殻に同梱した頁にだけ与える（`capabilities/approve.json`。`remote` を持たない）。殻の側でも、呼んだ窓の名前を確かめる。
- サーバの頁（main の窓、`127.0.0.1:4177`）には、頼む命令（`setup_integration`、`apply_config_sync`、`restore_config_sync`）だけを与え、承諾の命令は与えない。
  画面のダイアログから殻の書く命令を直接呼ぶ形にすると、HTTP の API に穴が開いたとき、押されずに書かれうる。承諾を殻の窓に置けば、その窓のボタンを人が押さない限り書かれない。
- 承諾の窓は、殻に同梱した頁から移らない（`on_navigation` で、macOS の `tauri://` と Windows の `http://tauri.localhost` だけを通す）。窓に落とされたファイルも受け取らない。

頁の文は、UI の辞書の `approve.*` を頁の中に写して持つ（頁は辞書を読めない）。写しが辞書とずれていないことは `apps/desktop/test/approve.test.ts` が縛る。言語は殻の頁と同じ決め方である。
CLI の見立ての形は `packages/cli/src/setupPlan.ts`（連携）と `sync/config/apply.ts` の `planApplyFiles`、`planRestoreFiles`（設定の同期）にある。
見立ては、書く処理と同じ「次の中身を決める関数」（`planShellHook`、`planStatuslineSnippet`、`planStatuslineRemoval` など）から作り、見せた差分と書く中身を食い違わせない。

ブラウザで開いた画面は書き込まない。殻が無いので、ボタンの代わりに、その旨とターミナルで打つコマンドを出す。
アプリから起こす CLI には `SHELL` が無いことがあるので、シェル連携のログインシェルは `SHELL` が無ければ利用者の記録（`os.userInfo().shell`）から読む。
Windows では、シェル連携は使えない（W1、2026-10-10 の決定のまま）。MCP の書く先は `%USERPROFILE%\.claude.json` になる。ステータスラインは、スクリプトが `.ps1` のとき PowerShell の行を入れる（「使用量」の節）。

### 入力待ちの知らせ

試作は `docs/superpowers/specs/2026-10-01-ux-refresh/waiting-notify.html`、決めた案は A1、B1、C1、D1、N1 である（`2026-10-01-ux-refresh-2-design.md` の 3 節）。

どのセッションが入力待ちかは、Mediator がストアから読む（`waitingSessionIds`）。
`live.update` は Claude のセッションの id で届くので、hangar のセッションへの引き当てはストアが済ませている。
ランタイムは、ストアが変わるたびに、変わったことだけを Mediator へ知らせる（入力 `{ kind: 'store' }`、中身は運ばない）。
Mediator は前に見た顔ぶれと比べ、入力待ちの顔ぶれが変わったときだけ動く。
数え方は `liveFilterOf` で、Done と Archived にしたセッションは外す（`awaitsAnswer`）。
問いで待っている最中に区切りを付けても、Claude は休みではないので止まらず、一覧の live は `waiting` のまま残る。
そのままではカード、通知センターの知らせ、ホームの要対応が残り続けるので、区切りを付けた時点で顔ぶれから外す。
Paused は戻ってくるものなので外さない。

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
通知の誘いはカードに添えない。始める前の確認の任意の行「通知」になった（下の、許可の尋ね方）。
確認や入力のあるダイアログ（未解決のプロジェクト、確認、新しいセッション、昇格、保持期間、設定の取り込み）が開いている間は、カードも錠剤も押せない。
カードは知らせの層にあってダイアログより前に出るので、押すとダイアログを開いたまま裏の画面だけが移ってしまう（⌘I と同じ考え方）。
カードの「ターミナルで答える」と錠剤は押せなくなり、カードの添え書きは「ダイアログを閉じると開けます」に替わる。
Mediator も、そのあいだの `session.open` では画面を移さない（`mediator/screen.ts` の `canMoveBehind`、中身は `mediator/overlay.ts` の `overlayReplaceable`）。
パレットや読むだけのダイアログ（キーの一覧、昇格の完了）なら、閉じてから移る。

info のトーストは 4 秒で消え、押しても消せる。
読み切るのに時間がかかる info だけは、トーストに `holdMs` を添えて長く出す（`runtime/actionTable.ts` の `LONG_TOAST_MS`、8 秒）。
いまの使い手は、外部ターミナルで開けず別のもので開いたときの知らせだけである。
Windows Terminal が見つからず既定のターミナルで開いたときと、iTerm2 で開けず Terminal.app で開いたときがそれにあたる。ほかの info は 4 秒のまま変えない。
時間はマウスを乗せている間などに止まり、押せば消せる点も同じである。
error のトーストは時間では消えず、閉じる × で消す。
例外は `holdMs` を持つ error で、その長さで消える（乗せている間は止める）。いまは、プロジェクトを外で開けなかった失敗だけで、押した直後に読めば足りるからである（`actionTable.ts` の `failHoldMs`、8 秒）。
error は赤みのガラスに警告のアイコンを添え、幅は 420px まで、本文は 2 行まで見せ、収まらないときだけ「詳しく」で開く。
時間切れはトーストごとに持ち、マウスを乗せている間とフォーカスが中にある間は止める。
読み上げは info が `role="status"`、error が `role="alert"` である。

**きっかけはサーバが決める（0.5.0）。**
デスクトップでは、入力待ち（許可待ちとリセット済みを含む）と使用制限の通知のきっかけを、頁ではなくサーバに置く（`sessions/stopNotices.ts`）。
0.3.0-rc.4 の VM の確かめで、Hangar を別のアプリの裏に置いたまま問いを約 7 秒おきに出すと、4 分のあいだ頁が入力待ちの出入りに反応せず、通知が 3 回出なかった。
前に出すと追いついたので、背面の WebView の JS が止まっていたとみる（`backgroundThrottling` を `throttle` にしても、窓が隠れると WebKit は頁を止めうる）。
サーバは登録が変わったときにその場で入力待ちの出入りを見て、入力待ちになったセッションを 1 回だけ並びに積む（`OsNoticeFeed`）。
周期で見るのは、許可の中身か問いの文を待っている入力待ちがある間だけ 500 ミリ秒ごとで、無い間は 5 秒ごとである（`paceNotices`、2026-10-14、0.6.1。5 秒の周期が拾うのは使用制限の行が届いたこととリセットの時刻を過ぎたことだけ）。
入力待ちになってから並びに積むまでの遅れは、登録の見張りの遅れ（見張りが効いていれば 50 ミリ秒、効いていなければ作業中からの変化で 500 ミリ秒）で決まる。
殻は起動の後にスレッドを 1 本起こし、`GET /api/notify/feed` を長いポーリング（25 秒）で読み、届いたものを預かり（`notify::hold`）に通して OS へ渡す（`notify/feed.rs`）。
鍵は `~/.agent-hangar/token` を Bearer で送る。
並びは番号（`seq`）と、サーバの起動ごとに変わる印（`boot`）を持ち、殻は最後に読んだ番号の続きだけを出す。印が変わったら番号を合わせ直し、前の分は出さない。
サーバも殻のスレッドも背面で止まらないので、頁が止まっていても、入力待ちになったら通知が 1 回だけ出る。
頁は入力待ちの通知を呼ばない（呼ぶと 2 回出る。`runtime/notifier.ts` の `serverFed`）。
利用者が通知を受け取るかは頁の設定（localStorage の `notify.waiting`）にあるので、頁が起動したときと切り替えたときに殻の `notify_feed` で伝える。伝わるまで殻は出さない。
サーバは起動したときの入力待ちと使用制限を、知らせ終えたものとして覚える。頁を開き直しても、サーバを起こし直しても、知らせ直さない。
使用制限とリセット済みは、その出来事が 10 分の内に起きたときだけ知らせる。初めての索引や作り直しでは、昔の行が起動の後に現れるからである。
右下のカード、バッジ、通知センターの片付け（`notify_prune`）は、今までどおり頁が受け持つ。
ブラウザでは今までどおり頁が通知を出す。許可待ちは、何の許可かを本文にして、問いの文を待たずに出す。使用制限の通知はデスクトップだけである。

通知の種類と文は次のとおりである。

- 入力待ち：題はセッションの名前、本文は問いの文（無ければ代わりの文と `bare` の印）。
- 許可待ち：本文は「許可待ち：Bash rm -rf ./build/cache」の形（中身が無ければ「許可待ちです」）。`bare` を付けないので、殻は預けずにすぐ出す。中身（hook）が登録より遅れたときに備え、サーバは許可待ちになってから 800 ミリ秒まで中身を待つ。
- 使用制限：アカウントとリセットの時刻ごとに 1 通。題は「使用制限（5 時間）」、本文は「依存の更新 が止まりました。16:50 にリセットされます」（同じ時に止まったものが 2 件以上なら件数）。種類ごとの枠に入れ（macOS の識別子 `hangar-limit:<id>`、Windows の組 `hangar-limit`）、押すと先に止まったセッションを開く。リセットを待っている間だけ通知センターに残す（`notifyKeep` の `limited`）。
- リセット済み：自動で続かずにリセットから猶予（90 秒、自動で続く予約のあるものは 150 秒）を過ぎた Active のセッションごとに 1 通。本文は「使用制限がリセットされました。続きを指示してください」。区切りを付けたものは、この後に自動の停止が止めるので知らせない。

窓が背面にあるときは、入力待ちになったセッションごとに通知を出す。
題はセッションの名前、本文は問いの文（取れなければ「入力待ちです」、英語では Waiting for input。頁の辞書の `home.card.noQuestion` で、ホームの要対応と同じ文）である。
頁が空の本文を渡したときだけ、殻が代わりの文「入力を待っています」を入れる（`notify::waiting`）。
問いの文は入力待ちより少し遅れて届くことがある（hook の台本や本文の索引が後になる）。
入力待ちの合図は Claude の登録の `waiting`（見張りの知らせで読む）で、問いの文は hook（裏で走る）か本文の索引（書き込みから 300 ミリ秒待つ）から届くので、どちらが先かは決まらない。
hook を持たない run（hook を入れる前の版で起動したもの、外のターミナルで動くもの、hook を切っている利用者のもの）では、ほぼいつも入力待ちが先に届く。
問いの文なしで知らせたセッションに問いの文が届いたら、サーバ（ブラウザでは頁の `waitingBare`）は同じセッションの通知をもう一度渡す。
macOS と Windows は同じ識別子（タグと組）の通知を置き換えるが、置き換えのたびにバナーと音を出し直す（2026-10-12 に macOS の通知の記録で、AskUserQuestion の 1 回にバナーと音が 2 回出ているのを確かめた）。
そこでサーバ（ブラウザでは頁）は、問いの文の無い通知に印（`bare`）を付けて渡し、殻はそれをセッションごとに 2 秒預かる（`notify::hold`）。
預かっている間に同じセッションの問いの文の入った通知が来たら、預かった分を捨てて、問いの文の通知を 1 回だけ出す。
来なければ、預かった分（代わりの文）を出す。
預かりの時間を過ぎてから届いた問いの文は出し直さない（右下の札とホームの要対応には問いの文が出る）。
待つ間に答えた入力待ちは、頁が `notify_prune` で顔ぶれから外すので、殻は預かった分を捨てて何も出さない。
窓が前にあるかは、預かった通知も出す瞬間に見直す。
出した通知は殻のログに 1 行ずつ残す（macOS は `notification handed to macOS`、Windows は `toast handed to Windows`）。出し直さなかった問いの文も 1 行残す。回数を後から数えるためである。
戻る時刻と使用制限の知らせは預からない。
2 秒は、2026-10-12 に問いの文の無い呼び出しから問いの文の入った呼び出しまでの間を測った値から決めた。19 回のうち 18 回は 0.07〜1.2 秒で、1 回だけ 2.5 秒だった。
許可待ちは、サーバが登録の `waitingFor` で見分けて `bare` を付けずに渡すので、預からず遅れない（0.5.0）。ほかの問いの文が来ない入力待ち（ダイアログなど）の通知は、その分だけ遅れる。
ブラウザは同じ tag の通知を黙って置き換える（`renotify` が既定で false）ので、預からない。
ブラウザでは、開き直す前に知らせた入力待ちは、開き直しても知らせ直さない（更新の後も、ふつうに開き直したときも）。デスクトップではサーバが入力待ちになった瞬間だけを知らせるので、この覚えは要らない。
頁は起動のたびに知らせた顔ぶれを空から始めるので、そのままでは起動の直後の一覧にある入力待ちを、どれも新しく入力待ちになったと読む。
そこで、入力待ちの 1 回ごとの鍵（セッションの id と最後の動きの時刻）を頁の localStorage（`waiting.notified`）に残し、起動のときに読み戻す（`mediator/live.ts`）。
この頁で初めて入力待ちと見たセッションの鍵が残してあれば、右下のカードとバッジは出すが、OS の通知は出さない。
閉じている間に答えてまた入力待ちになったものは、トランスクリプトが伸びて時刻が進むので別の鍵になり、知らせる。
ブラウザでは残すのは頁である。
知らせたかどうかは画面ごとの事実で（ブラウザのタブはそれぞれカードと通知を出す）、サーバは誰が何を見たかを知らないためである。
戻る時刻の知らせ（`return.notified`）と同じ置き場である。
問いの文を待つ時計（timer）を頁に置かず殻に置くのは、頁の時計が窓を最小化すると絞られるからである。
デスクトップでは、窓が前にあるかを頁では決めない。サーバから届いた通知も、頁が呼んだ戻る時刻の知らせも、殻が窓の実物の様子（見えている、最小化していない、フォーカスがある）を見て、前にあれば出さない（`notify::window_in_front`）。
フォーカスは、macOS では窓（NSWindow）が key window かで見る。中の WKWebView がフォーカスを持っていても key window のままなので、tao の `is_focused` で足りる。
Windows では、tao の `is_focused` は最上位の窓そのものがフォーカスを持つときだけ真で、ふだんフォーカスを持つ中の WebView2 の子窓（`Chrome_WidgetWin_1`）にあると偽になる。
そこで Windows では、OS の前景の窓（`GetForegroundWindow`）が hangar の窓か、その根（`GetAncestor` の `GA_ROOTOWNER`）が hangar の窓なら、フォーカスがあるとみなす（`notify::window_owns_foreground`）。
`GA_ROOTOWNER` は親と持ち主をたどるので、hangar の窓が持ち主のダイアログが前にあるときも、利用者は hangar を見ているとみなして知らせない。
殻のフォルダの選択のダイアログ（`pick_folder`）も、Windows では hangar の窓を親として渡して開くので、その窓が持ち主になる（macOS はシートに変わって見た目が変わるので渡さない）。
頁の `visibilityState` と `hasFocus()` は、WebView が最小化や背面で絞られている間は当てにならないためである（Windows の実機で、最小化して約 3 分置いた後の入力待ちに、頁が通知を呼ばなかった）。
頁が止まらないよう、macOS は窓の設定 `backgroundThrottling` を `throttle`（止めずに絞る。macOS 14 から効く）にし、Windows は頁が解けない Web Lock を 1 つ握る（`runtime/notifier.ts` の `holdPageAwake`。Chromium は Web Lock を握っている頁を凍らせない。Tauri の `backgroundThrottling` は WebView2 には効かない）。
どちらも時計の絞りは変えないので、電池への響きは小さい。入力待ちは WebSocket で届き、頁の通知の判断と呼び出しは時計を使わない。
ブラウザでは今までどおり、頁が隠れているか窓にフォーカスが無いときを背面とみなす。
通知を押すと窓が前に出て、そのセッションを開いてターミナルにフォーカスする。
確認や入力のあるダイアログが開いていれば、窓が前に出るだけで、画面は移さない（カードと同じ扱い）。
Dock（ブラウザならインストールしたアプリ）のバッジには入力待ちの数を出し、0 で消す。

入力待ちの知らせと戻る時刻の知らせと使用制限の知らせは、種類ごとに別の枠に入れる（macOS は識別子、Windows はタグと組の対、ブラウザは tag）。
同じ枠に入れると、後から来た戻る時刻の知らせが、同じセッションの入力待ちの知らせを置き換えて問いの文を消すからである（Windows の実機で見つけた）。
同じ種類の 2 度目は、今までどおり同じ枠で置き換わる。
頁とサーバの並びは種類（`kind` の `waiting`、`return`、`limit`）を添え、殻は種類の無いもの（前の版の頁）を入力待ちとみなす。

もう待っていない知らせは、通知センターから外す。
通知センターの知らせは、答えた後も、アプリを閉じても消して入れ直しても残るためである（Windows の実機で、前の版の試しのセッションのトーストが残っていた）。
残してよいのは、いま入力待ちのセッションの入力待ちの知らせと、今日の戻る時刻を過ぎてまだ Paused のセッションの戻る時刻の知らせと、使用制限でリセットを待っているセッションの使用制限の知らせだけである（`mediator/notify.ts` の `notifyKeep`）。
頁はこの顔ぶれが変わるたびに、殻の `notify_prune` へ渡す（`runtime.ts` の `syncPrune`）。
答えた、止めた、Archived や Done にしたセッションは入力待ちでなくなり、resume して Paused が外れたものと日が変わったものは戻る時刻の顔ぶれから外れるので、その知らせが外れる。
起動したときは、bootstrap で一覧を読み終えてから 1 回必ず渡す。前の起動の間に出して、もう待っていない知らせはここで外れる。今も待っているものは残し、出し直しはしない。
bootstrap の前は渡さない。セッションが空で何も待っていないように見え、まだ待っている知らせまで外してしまうからである。
通知を受け取らない設定でも渡す（外すだけである）。
殻は、macOS では通知センターに届いている通知の識別子を読み、hangar の識別子で顔ぶれに無いものを外す（`removeDeliveredNotificationsWithIdentifiers`、hangar の識別子でないものには触らない）。
届いている通知の一覧は OS が後から答えるので、その間に出した知らせは、次の顔ぶれが届くまで残すものに足しておく。
Windows では、hangar の AppUserModelID のトーストの履歴（`ToastNotificationHistory` の `GetHistoryWithId`）を読み、顔ぶれに無いタグと組の対を外す（`RemoveGroupedTagWithId`）。
履歴を読むのは別のプロセスへの呼び出しで、頁の命令の糸（WebView2 の知らせを配っている途中）から呼ぶと Windows が断る（0x8001010D、`RPC_E_CANTCALLOUT_ININPUTSYNCCALL`）。
なので、外すのは COM を自分で始めた別の糸（`notify.rs` の `prune_loop`）に任せ、命令は顔ぶれを渡すだけにする。糸は届いた順に扱い、溜まっていれば最新の顔ぶれだけを使う。
顔ぶれを渡した後に出したトーストは、出したものの控え（`TOASTS`）にあるので、残すものに足してから外す（`Keep::extend_shown`）。
失敗のログの文は、コードと、コードから OS が引いた文だけで書く（`toast::hresult_line`）。windows の Error の表示は糸に残った前の失敗の説明を拾い、コードと合わない文や化けた文を出したためである。
履歴は hangar の名前のものだけなので、知らない組のトーストも hangar の古い版が出したものとして外す。
外すものを選ぶのは純関数である（`notify.rs` の `stale_identifiers` と `toast::stale_toasts`）。
ブラウザでは、頁が出した知らせのうち、顔ぶれに無いものを閉じる。

デスクトップの殻では、通知を macOS は UNUserNotificationCenter で、Windows は WinRT のトースト（`Windows.UI.Notifications`）で出す（`src-tauri/src/notify.rs`）。
頁は `notify_waiting` を呼び、殻はサーバの並びを読み、どちらも id と文を確かめてから OS に渡す。
押された通知は識別子からセッションを読み戻し、頁の `__hangarOpenWaiting` で開く。
頁が出来上がる前なら、ディープリンクと同じくハッシュとして貯める。
`tauri-plugin-notification` は、デスクトップでは押された通知を知らせないので使わない（Windows でも、出した後の受け口を捨てる）。
`.app` の外（`tauri dev`）と、Windows で組み上げたままの実行ファイル（`target` の下の `debug` や `release`）では通知を出さない。

Windows のトーストは、題と本文を XML の文字として入れ、launch に macOS の識別子と同じ値（入力待ちは `hangar-waiting:<id>`、戻る時刻は `hangar-return:<id>`）を入れる。
入力待ちの識別子と組は前の版と同じにしてあるので、前の版が出したトーストを押しても同じセッションが開く。
タグはセッションの id、組は種類ごとの名前（`hangar-waiting` か `hangar-return`）で、同じセッションの同じ種類のトーストは新しい方に置き換わる。
アプリの名前（AppUserModelID）は `tauri.conf.json` の identifier で、NSIS のインストーラがスタートメニューの近道に付けるものと同じである。
押されたトーストは 2 つの道で届き、どちらも launch の値からセッションを読み戻して、macOS と同じ受け口へ渡す。
アプリが動いている間は、出したトーストの Activated で届く。
アプリが閉じた後に通知センターで押されたときは、Windows が COM の口でアプリを起こし、`INotificationActivationCallback::Activate` で届く。
そのために殻は起動のたびに、利用者の登録（HKEY_CURRENT_USER）の `Software\Classes\AppUserModelId\<identifier>` へ名前、絵、COM の口の CLSID を書き、`Software\Classes\CLSID\<CLSID>\LocalServer32` へ自分の実行ファイルを書き、COM の口を開く。
1 回の押下が両方の道で届いても、2 秒の間に同じセッションは 1 回だけ開く。
アンインストールでは、NSIS のフック（`src-tauri/windows/hooks.nsh` の `NSIS_HOOK_POSTUNINSTALL`、`tauri.windows.conf.json` の `installerHooks`）が、利用者の領域からは、この 2 つの登録と `~/.agent-hangar/notify-icon.png` だけを消す。
登録を消す前に、通知センターに残った hangar のトーストの履歴も消す。NSIS は WinRT を呼べないので、Windows PowerShell の 1 行で `ToastNotificationManager` の `History.Clear` を名前を指して呼ぶ（失敗しても消すのは止めない）。
`.agent-hangar` の中のほかのもの（DB など）は消さない。
フックの値は notify.rs の定数と同じで、`apps/desktop/test/config.test.ts` が食い違いを見る。
Windows には通知の許可を尋ねるダイアログが無いので、`notify_request` と `notify_status` は通知の設定（`NotificationSetting`）を読むだけで、切られていれば denied になる。
バッジは Tauri の `set_badge_count` で出す。
ブラウザでは Web Notification と `navigator.setAppBadge` を使い、どちらも無ければ何もしない。

通知を受け取るかは PC ごとに localStorage（`notify.waiting`）に残す。
OS で切られているときの案内は、許可する場所の名前を OS で変える（macOS は「システム設定」、Windows は「Windows の設定」）。鍵は `…notify.blocked` と `…notify.blockedWindows` に分け、選ぶのは `notifyBlockedKey(clientPlatform(), …)` である。
選んでいなければ、デスクトップでは受け取り、ブラウザでは受け取らない。
起動しただけでは OS に許可を尋ねない（2026-10-13 の決定、知らせの 9c。それまでは起動したときに一度だけ尋ねていた）。
受け取ると選んでいれば（選んでいなければ環境の既定）、起動したときに殻の `notify_status` で OS の許可の状態だけを読む（macOS は UNUserNotificationCenter、Windows は通知の設定。尋ねはしないのでダイアログは出ない）。
まだ尋ねていなければ（undetermined）、Store の `notify.ask` を立て、始める前の確認に任意の行「通知：背面のとき、入力待ちを OS の通知で知らせます」と主ボタン［許可する］、控えめな［要らない］を出す（`presenters/readiness.ts`、試作の 9c の A）。
［許可する］を押したときだけ OS に尋ねる（`notify.set` の on から `notify.request`）。答えが出れば行は消える。
［要らない］は `notify.set` の off で、受け取らないにして `notify.waiting` に覚え、`ask` を下ろして行を消す。OS には尋ねない。
許可済み、切られている、受け取らないと選んだときは行を出さない。
ほかの任意の行と違い、この行だけは答えるまで確認の群を残す（ほかの必須の行が済んでも群を出す）。放っておくと、スイッチがオンに見えたまま OS に一度も尋ねず、通知が届かないことに気付けないからである。
設定の一般の通知の欄にも、尋ねていない間は「まだ許可していません。」と［許可する］を添え、押せば同じ道で尋ねる。
システム設定で切られていれば（denied）、受け取らないにし、設定の通知の節に「システム設定の「通知」で Hangar を許可してください」と出す。
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
ブラウザの許可も、設定のスイッチか始める前の確認の［許可する］を押したときにだけ求める（押した操作の中でないとダイアログが出ないため）。
許されなかったら受け取らないままにして、「通知が許可されませんでした」と知らせる。

### 注意と知らせの出し分け

段 4 の PR 28 と PR 29 でヘッダーにベルを入れ、2026-10-13 に新しい利用者の目線で 3 つの系統にまとめ直した（利用者の決定、知らせの 9a〜9d）。

- 「いま」：右下の札（入力待ち、他の PC から届いたプロジェクト、アプリの更新）。今のまま。
- 「今日」：ホームの帯（要対応、実行中、確認待ちなど）。今のまま。サイドバーの件数と Dock のバッジは、帯の要対応の写しとして残す。
- 「注意」：もとのベル。画面のほかの場所に出ていない事実だけを入れる。

注意はヘッダーの使用率の右に置き、押すと一覧が開く（`views/Bell.tsx`、`views/NoticeList.tsx`、`views/Header.tsx`）。
印は注意の三角にし、数の札は Paused と同じ黄土にする。ベルの形は「通知が来る所」と読まれ、リマインダーや誘いが入っていた役と結び付いているからである。赤茶は入力待ち（今すぐの用）の色なので、急ぎでない注意には使わない。
中身（行）が 1 つも無ければ、注意を区切りの線ごと描かない。ふだんは無く、出たら直すものだと形で伝える。
開いた面の見出しは「注意」で、「画面のほかの場所には出ていないこと」と添える。
数の札は未読の数で、0 なら出さない。
畳まない（ヘッダーの畳み方の対象にしない）。
一覧の行は、事実から Presenter が毎回組む（`presenters/notices.ts`）。
一覧そのものは保存しない。
事実が無くなれば行も消える。
閉じても残るのは、事実が残る間のことである。
既読は行の鍵（種類、対象、事実の版）の集合で、`localStorage` の `notices.read` に端末ごとに置く。鍵の形は前の版のままである。
同期しない。
事実の版が変われば鍵が変わり、また未読になる。

注意に入るのは次のものだけである。

- 同期の失敗、一時停止、取得できなかったトランスクリプト（設定の同期へ）。
- Claude Code との互換の変更点（設定へ）。
- 保持期間。消えかけのトランスクリプトがあるときだけ（設定へ）。日数そのもの（決まり）は行にせず、設定の「情報」の目次の状態に出す。
- 設定の同期で送らなかった項目（送らなかった項目の行へ）。

次のものは注意から外した。

- 今日のリマインダー。ホームの帯の要対応にある。
- 通知の誘い。始める前の確認の任意の行「通知」になった（「入力待ちの知らせ」の節）。
- 保持期間の決まりの行（「トランスクリプトは 30 日で削除されます」）。

ヘッダーの「停止 N」の錠剤も外した。使用制限で止まっているセッションは、ホームの帯の実行中の行がリセットの時刻と一緒に言っている（2026-10-13 の決定、知らせの 9b）。

知らせの種類ごとの出す場所は次のとおりである。

| 知らせの種類 | ホームの帯と引き出し | 右下の札 | トースト | OS の通知 | 注意 |
| --- | --- | --- | --- | --- | --- |
| 入力待ち | 要対応 | 3 枚まで（4 件目から「ほか N 件をホームで見る」） | | 背面のとき 1 件ずつ | |
| 許可待ち | 要対応（道具と命令） | 入力待ちと同じ札で、命令を出す | | 背面のとき 1 件ずつ、預けずにすぐ | |
| 使用制限 | 実行中（リセットの時刻） | | | 当たったときにアカウントごとに 1 通 | |
| リセット済み | 要対応 | 入力待ちと同じ札 | | 背面のとき Active のものだけ 1 件ずつ | |
| 今日のリマインダー | 要対応 | | | 時刻つきは、時刻を過ぎて背面のとき | |
| Claude からの提案 | 確認待ち（出どころと、Done の提案は自動で確定するまでの日数） | | 放っておかれた Done の提案を、入れた直後にまとめて確定したときだけ 1 度 | | |
| 前回実行中（中断） | 前回実行中 | | 再開しない、閉じたとき（元に戻す） | | |
| 同じファイルの編集 | 実行中の行の札と錠剤の点 | | | | |
| 同期の失敗、一時停止、取得できなかった本文 | | | | | 入る（設定の同期へ） |
| 互換の変更点 | | | | | 入る（設定へ） |
| 保持期間（消えかけがあるときだけ） | | | | | 入る（設定へ） |
| 通知の許可（まだ尋ねていないとき） | 始める前の確認の任意の行（［許可する］［要らない］。答えるまで群を残す） | | | | |
| 他の PC から届いたプロジェクト | | 1 枚にまとめる（「プロジェクトで見る」「あとで決める」。「プロジェクトの同定」の節） | | | |
| アプリの更新 | | 1 枚（新しい版、取得の進み、再起動の確認、失敗を同じ札の中で移す。「アプリの自動更新」の節） | | | |
| 操作の結果 | | | 出す | | |

- 右下に積むのは入力待ちと、他の PC から届いたプロジェクトの札 1 枚と、アプリの更新の札 1 枚だけである。
  戻る時刻を過ぎた札、通知の誘い、ヘッダーの下の保持期間の帯は無くした。
  `shownOnScreen`（ホームと、そのセッション自身の画面では、その件を出さない）は右下の札とホームの帯だけに残す。
  注意は画面に依らず同じ中身である。
- トーストは操作の結果だけである（保存しました、コピーしました、1 回だけ同期しました）。
  中断の群の「再開しない」と「閉じる」のトーストには「元に戻す」を置く（トーストの中のボタンは、これだけである）。
  例外は、放っておかれた Done の提案を、この版を入れた直後にまとめて確定したときの 1 度だけのトーストである（「Home の帯と引き出し」の節）。
- 同じファイルの編集は、止めない警告で、背面で知っても打つ手が無いので、OS の通知も右下の札も注意の行も出さない。ホームの帯、現在の札、サイドバーの印の画面の中だけで言う。
- 同期の失敗の toast は、サーバから 2 本外した。
  本文を降ろせなかったとき（`boot/sync.ts` の puller の `onError`）と、1 回だけの同期がクラウドとの互換の版で断られたとき（`sync/oncePass.ts`）である。
  前者の事実は同期の状態の `skipped`（降ろせずに諦めた項目）に、後者は `error` に残っているので、注意の行をそこから組む。画面の語は「取得できなかったトランスクリプト」である。
  `skipped` に入るのは 3 回続けて失敗した項目で、1 回目の失敗では行は出ない（以前は 1 回目にも toast を流していた）。
  理由は `console.error` と `desktop.log` に残る。
- 互換の変更点は、画面に出す toast が元々無く、注意の行（互換の変更点の件数）だけで知らせる。
- 「どのプロジェクトにも属さないセッションが現れました」の toast は、注意の行にせず、外した。
  理由は 2 つある。
  1 つめは、注意の行は事実から組む決まりで、この知らせは 1 度きりの出来事だからである。
  行にすると「未分類のセッションがある」という消えない事実になり、プロジェクトに属さないクイックセッションを使う人の注意が、常に未読になる。
  2 つめは、未分類のセッションが一覧にそのまま出ていて、見失わないからである。
  ワークスペースの外で claude を使うのは普通の使い方で、毎回知らせる価値が薄い。
- 設定の同期で送らなかった項目は、注意の行にした（`configUnsent`）。
  アプリの更新は、注意の行にせず、右下の札と設定の更新の節で知らせる（2026-10-10 の決定、試作の A2）。

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
  対話で起動した `claude` は、hangar に起動を頼み（`POST /api/runs/terminal`）、返ってきた tmux のセッションにこのターミナルからつなぐ（`tmux -L hangar attach`）。
  頼むときに、作業ディレクトリ、引数、環境変数を渡す。tmux の新しいセッションはシェルの環境変数を継がないので、hangar が `tmux new-session -e` で渡す。
  渡す前に、端末に固有の変数、`HANGAR_` で始まる変数、Claude Code が子に立てる印（run の起こし方と同じ一覧）を落とす。端末が Claude Code のセッションの中から起きていると、そのセッションの印を持っているためである。
  プロジェクトは、作業ディレクトリを含むルートのうち最も深いものにする。無ければ未分類にする。
  `-r <id>` は、その会話の run がもう動いていれば、その tmux につなぐだけにする。動いていなければ hangar に再開を頼む。
  hangar が応答しない、または断ったとき（tmux が無い、hangar が組み立てる引数と重なる引数を付けた、同じ会話が hangar の外で動いている）は、素の claude を起動する。
  すでに tmux の中にいるときは、hangar の専用のサーバ（`$TMUX` のソケットが `${TMUX_TMPDIR:-/tmp}/tmux-$UID/hangar`）なら入れ子にせず `switch-client` で移り、ほかの tmux の中なら素の claude を起動する。
  利用者の既定のサーバ（`…/default`）も「ほかの tmux」である（2026-10-13 の決定）。`switch-client` ではサーバをまたげず、入れ子で attach すると Ctrl+B が二重になるからである。
  前の版の hangar が既定のサーバに作ったシェルタブの中で打った `claude` も、素の claude になる。
  更新の前から開いているターミナルは、古い本体を読み込んだままなので、既定のサーバへ attach しようとして失敗する。run は hangar の一覧に残るので、hangar から開くか、新しいターミナルで `claude -r <id>` を打つ。
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

hangar は、専用の tmux サーバ（`-L hangar`）に端末のための設定を入れる。どれもサーバ全体に効くので、利用者の既定のサーバには入れない。利用者が `~/.tmux.conf` で決めた値は上書きしない。
- `copy-command` を `LC_CTYPE=UTF-8 pbcopy` にする（空か、前の版が入れた素の `pbcopy` のときだけ）。iTerm2 は既定で端末のアプリからのクリップボードへの書き込み（OSC 52）を許さないので、マウスで選んだ範囲を直接クリップボードへ渡す。
  pbcopy はロケールで文字コードを決める。tmux サーバの環境には `LANG` が無いことが多く、素の `pbcopy` では日本語を写すとクリップボードが空になる（2026-10-02 に hangar の画面で起きた）。
- `extended-keys` を `on` にし（`off` のときだけ）、`extended-keys-format` を `csi-u` にし、`terminal-features` に `xterm*:extkeys` を足す。外の端末から Shift+Enter を区別して受けるためである。
- `terminal-features` に `xterm*:hyperlinks` を足す（どこかの項目にもう `hyperlinks` があれば足さない）。無いと tmux は中のプログラムの OSC 8 のハイパーリンクを捨て、hangar の画面でリンクにならない（2026-10-15 に tmux 3.6a で確かめた）。hyperlinks は tmux 3.4 からの項目で、Windows の psmux には入れない。
- `focus-events` を `on` にする（`off` のときだけ）。中の Claude Code に端末の前後の切り替わりを渡す。`off` のままだと、Claude Code は画面の下に「tmux focus-events off」の注意を出す（0.6.0-rc.1 で専用のサーバに移ったあとに見つけた）。既定が `off` なので、`extended-keys` と同じく `off` を利用者の値と見分けられず、`on` にする。Windows の psmux には入れない。
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

- グローバル：⌘K と / でパレット（移動・操作）、⌘N 新しいセッション、⌘⇧N スクラッチ（macOS の外では Ctrl+Alt+N）、⌘I 次の入力待ちへ、⌘R 画面の再読み込み（macOS の外では F5 と Ctrl+Shift+R）、⌘, 設定、⌘[ と ⌘←（⌘] と ⌘→）で戻ると進む、? と ⌘/ でキーの一覧、Esc で開いているものを閉じる（何も開いていなければ入力欄を離れる）。
- タブとペーン：⌘1 から ⌘9 でタブ切替（素のブラウザでは ⌃⌥1 から ⌃⌥9）、⌘W でフォーカスのある枠のシェルタブを閉じる、⌘\ で横に並べる、⌘J で右の欄の開閉、⌘+ と ⌘− と ⌘0 でターミナルの文字の大きさ、⌘F で本文の中を探す（本文が出ているときだけ）、⌘⇧C でセッションの宛先をコピーする（Windows と Linux は Ctrl+Alt+C。Ctrl+Shift+C はターミナルのコピーなので取らない）、⌘⌥C でセッション ID だけをコピーする（Windows と Linux は Ctrl+Alt+Shift+C）。
  タブの列にフォーカスがあるときは ← と →（Home と End）でタブの間を移り、Enter か Space で選ぶ。
  選ぶとフォーカスはターミナルへ移るので、矢印で移るだけでは選ばない（tablist の手動の選択）。
  ターンの目次は j と k（↑ と ↓）で行を移り、Enter で開く。
  タブそのものは Tab で 1 つだけ止まる（roving tabindex）。目次の行も同じである。
  各タブの閉じるボタンは Tab で止めない（⌘W で閉じられる）。
  タブの列の追加と分割のボタンは別の操作なので、それぞれ Tab で止まる。
- 一覧：j と k（↑ と ↓ でも）で上下、Enter で開く、o でターミナル、e で選んだエディタ、`.` でセッションのメニュー。m（ノートの編集）は 0.4.0 でノートと一緒に外した。メニューの中の m は「プロジェクトを変更…」である。

一覧の行のフォーカスとカーソルは 1 つにまとめる（roving tabindex）。
Tab で止まる行はカーソルの行 1 つだけで、打鍵でカーソルを動かすとフォーカスもその行へ移り、クリックや Tab で行にフォーカスが来るとカーソルもそこへ来る。
Enter は一覧の器が 1 度だけ受けて、カーソルの行を開く。
Home に入ったら、行が初めて並んだときに一度だけ一覧にフォーカスする。
一覧そのものには輪郭を描かない。開くたびに、まだ何も選んでいない一覧を枠が囲むことになるからである。どこに居るかは、カーソルの行の地色と、行そのものの輪郭で示す。
ただし入力欄、ターミナル、ダイアログにあるフォーカスは奪わない。

セッション画面に着いたら、開き方を問わず、生きているターミナルへフォーカスする。
サイドバー、ホームとプロジェクト画面の一覧、通知と入力待ちのカード、パレット、戻る・進む、`hangar://` のリンク（MCP の `open_in_hangar`）は、どれもハッシュの変化（`hash.changed`）として着くので、着いたところで `focus` の効果（対象はターミナル）を 1 度出す。
もう開いている画面へのリンク（同じ URL）でも出す。
タブの切り替え（Claude のタブへ戻すときも、シェルのタブを選んだときも）も同じ効果を出す。
`session.open` の `focus: 'terminal'` は、答える先の Claude のタブへ戻すことだけを足す。
確認や入力のあるダイアログが残っている間は出さない。
端末が無い（終わったセッション）ときは、Runtime がつなぐタブを決められず何もしない。
端末の側（`TerminalHost.focus`）も、前に `aria-modal` のダイアログか `role="menu"` のメニューがあれば当てない。
パレットから開いたときのように、閉じたことになっていても DOM からまだ消えていないことがあるので、10 枚の描画のあいだ当て直しを試し、それでも前にあればあきらめる。
画面に着いた後に枠が付く（mount）ときに前にあれば、それは本当に開いているので捨てる。
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
`~` への縮め（`homePath`）は、サーバが返す本当のホーム（bootstrap の `home`、`os.homedir()`）の下だけを、元の区切りのまま `~/…` や `~\…` にする。
`/Users/<名前>` や `C:\Users\<名前>` の形からホームを推測しない。推測すると `/Users/Shared` や `C:\Users\Public` まで `~` に見えるからである（2026-10-11 に推測をやめた）。
ホームを返さない古いサーバでは縮めない。Windows の形のホームは、区切りの違いと大文字小文字を同じとみなして比べる。
サーバへ送るパス（登録するフォルダ、追加のフォルダ）は、受け取った形のまま送る。
`@` の候補はサーバが `/` で区切って返し、問いに打たれた `\` は `/` に読み替えて探す（`prompt/files.ts` の `rankFiles`）。

⌘I（次の入力待ちへ）は、入力待ち（live が waiting）のセッションを Home の帯の要対応と同じ順（長く待っている順）に 1 つずつ開き、ターミナルにフォーカスする。
いまいるセッションが入力待ちなら、その次へ移り、末尾の次は先頭へ戻る。
開く経路は「ターミナルで答える」と同じ `session.open` の `focus: 'terminal'` である。
どのセッションへ移るかは、Mediator がストアの入力待ちの並びを読んで決める（分割の右のタブと同じ形）。
入力待ちが無ければ、「入力待ちのセッションはありません」と短いトーストで知らせる。
パレットにも同じコマンドを置く。
⌘I を選んだのは、macOS の既定、Chrome、Tauri の既定のメニュー、xterm、Claude Code のどれとも重ならず、⌘ 付きなのでターミナルにフォーカスがあっても hangar に届くからである。

⌘R（画面の再読み込み）は、画面全体を読み直す（`location.reload()`）。macOS の外は F5 と Ctrl+Shift+R で、Ctrl+R はターミナルの履歴検索（readline と Claude Code）なので取らない（2026-10-15 の利用者の決定）。
ターミナル、入力欄、ダイアログのどこにフォーカスがあっても受ける。F5 と Ctrl+Shift+R は表の `inTerminal` の打鍵で、xterm には処理させない。macOS の Ctrl+R は入力欄とターミナルへ渡す。
読み直しても、動いている Claude と tmux は止まらない。サーバが閉じるのはターミナルの WebSocket ごとの `tmux attach` だけで（`pty/relay.ts`）、読み直した画面がつなぎ直す。
macOS の殻は、Tauri の既定のメニューの「View」の頭に「Reload」（⌘R）を足す（`apps/desktop/src-tauri/src/lib.rs` の `app_menu`）。既定のメニューが英語なので、項目名も英語にそろえる。
⌘R は先に頁の keydown が受けて既定を止めるので、メニューの項目が同じ打鍵でもう一度読み直すことはない。メニューから選んだときは殻が `location.reload()` を評価する。
Windows と Linux の窓はメニューバーを持たないので、項目は足さない。
殻の中では、右クリックで WebKit が出す既定のメニュー（Back と Reload）を出さない（`packages/ui/src/runtime/nativeMenu.ts`、2026-10-16 の利用者の決定）。
その Reload は鍵のクッキーを送らずに読み直し、「認証できていません」の画面になった。最初の画面は殻の読み込み画面から別のサイトとして移ってきたもので、クッキーは `SameSite=Strict` だからである。Back は殻の読み込み画面へ戻ってしまう。
入力欄、contenteditable、ターミナルの中と、文字を選んでいるときは、貼り付けとコピーに要るので残す。ブラウザで開いたときは止めない。

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
macOS のデスクトップでは、殻（Rust）が NSEvent の位相を読んで「指が触れた」を `window.__hangarSwipeBegin()`、「指が離れた」を `window.__hangarSwipeEnd()` で叩く（`apps/desktop/src-tauri/src/lib.rs` の `watch_swipe_phase`）。
触れたことも送るのは、指を置いたまま止めている間は打鍵が来ないからである。これが無いと、画面の側が「途切れた」と読んで離す前に動く。
WebKit の手勢が使っているのと同じ信号で、打鍵そのものは飲み込まず素通しするので、頁の中の横スクロールはそのまま効く。
位相を読める殻であることは、サーバの頁が出来上がった時点で `window.__hangarPhaseAware` を立てて画面に知らせる。

この手勢はデスクトップの殻の中だけの機能である。
ブラウザには元から戻る進むの手勢があるので、二重に持たず、標準に任せる。
だから `overscroll-behavior-x` でブラウザの手勢を止めることもしない。
手勢の終わりの決め方は `swipe.ts` の `swipeModeOf` が環境から選ぶ。
`window.__hangarPhaseAware` が立っていれば位相（macOS の殻）、立っていなくても Windows の殻の中なら打鍵の途切れ（次の小節）、どちらでもなければホイールを一切見ない（ブラウザ）。
殻の中かどうかは、殻が頁に差し込む `__TAURI_INTERNALS__` から決まる Store の `desktop` で、OS はブラウザの名乗り（`keys.ts` の `clientPlatform`）で見分ける。
macOS の殻で位相の印がまだ立っていない間は、時間では決めずにホイールを見ない。

**位相の届く環境では、時間で画面を動かすことはしない**。
確定は「指が離れた」の合図だけで行う。
時間で打ち切る経路を残すと、合図が遅れた回に、指を置いたまま画面が動く。
引き換えに、macOS では位相を持たない入力（マウスホイールの横倒し）でアプリのスワイプが効かない。そこは ⌘[ と ⌘] を使う。
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

#### Windows の殻

Windows の殻は指の位相を送らない。
WebView2 には、頁へ指の上げ下げを渡す口が無い。
だから Windows の殻の中では、**打鍵が 150ms 途切れたことを「指が離れた」の合図にする**（`swipe.ts` の `SWIPE_RELEASE_GAP_MS`）。
打鍵のたびに時計を張り直し、時計が切れたら macOS の `__hangarSwipeEnd` と同じ処理（身構えていれば動く、いなければ矢印を消す）を行う。
時計が切れた後の最初の打鍵が、次の手勢の始まり（macOS の `__hangarSwipeBegin` と同じ処理）になる。
身構えのしきい値、縦の手勢での取り消し、引き戻しでの取り消し、横へ流せる箱の扱い、矢印の見せ方、ダイアログの裏で受けないことは、macOS と同じ作りをそのまま使う。

150ms の根拠は次のとおり。
指が動いている間の打鍵は 1 コマごと（60Hz で約 17ms）に来るので、負荷でコマが数枚落ちても途切れと読まない幅が要る。
長く取るほど、離してから動くまでが遅れて鈍く感じる（0.2 秒を超えると目立つ）。
引き換えは 2 つある。
1 つは、引き切ったまま指を 150ms 止めると、離していなくても動くこと。位相の無い環境では、止めたのか離したのかを見分けられない。
もう 1 つは、勢いよく離した回は惰性の打鍵が途切れずに続くので、途切れだけでは惰性が尽きてから動くこと（下の 0 の打鍵で縮めた）。
打鍵の細りは、macOS と同じ理由で合図に使わない。

**離した瞬間の 0 の打鍵**。
Windows の Chromium（Edge と WebView2）は、高精度タッチパッドから指を離した瞬間に、deltaX も deltaY も 0 の打鍵を 1 つ送る。
弾いた回は「指の動き（約 100〜160ms）→ 0 の打鍵 1 つ → 細い値 1 つ → 約 2 秒の惰性」の形で届く（2026-10-14 に Windows 11 と Edge 155 で 28 回記録した報告）。
途切れだけで決めると、そのあいだ遷移が待たされる（弾いた 11 回で中央値 2249ms）。
そこで、手勢の最中に 0 の打鍵が来たら、その場で離したとみなす（`swipe.ts` の `createLiftDetector` が `lift` を返す）。
続く惰性は、150ms 途切れるか、逆向きに本気で（`SWIPE_PUSH_DELTA` 以上）引かれるまで丸ごと捨てる。
`createSwipeDetector` の掛け金（`firedDir`）だけに任せると、惰性の頭の細い値で掛け金が外れ、惰性で再び身構えて二度動くからである。
手勢の外の 0 の打鍵（引いて止めた指を、途切れた後に離したとき）は捨てる。
途切れの時計は、0 の打鍵が来ない環境（高精度でないタッチパッドなど）のための保険として残す。
記録をそのまま流す試験（`swipe.test.ts`、入力は `src/test/fixtures/windows-touchpad-wheel.json`）で、身構えてから動くまでが全 19 回で 0.6 秒未満、弾いた 11 回の中央値が 0.2 秒未満になり、惰性で二度動かないことを確かめている。
遷移が 1 回増えるのは、弾いた直後に惰性の途中で逆へ引いた回で、「進む → 戻る」の 2 回になる。
WebView2 の中での実測はまだ無い（記録は Edge で取った）。

Windows の Chromium は Shift+ホイールを横の打鍵（deltaX）にして渡す。
マウスで横へ流す操作なので、Windows の殻では Shift の付いた打鍵を手勢にしない。
マウスのホイールの横倒しは、Shift が付かないので手勢として積む。

WebView2 自身のスワイプの戻る進む（`CoreWebView2Settings.IsSwipeNavigationEnabled`）は効いていない。
wry（0.55）が WebView2 を作るときに、この設定へ `back_forward_navigation_gestures` を入れており、その既定は偽である。
Tauri はこの値を設定にも窓の作り方にも出していないので、殻は何もしなくても切れている。
だから自前の手勢と二重にはならない。

### マウスの戻ると進むのボタン

マウスの戻るボタン（`MouseEvent.button` が 3）と進むボタン（4）は、殻の中で `nav.back` と `nav.forward` を出す（Root の `mouseup` を捕捉の段で受ける）。
macOS と Windows の両方で受ける。
⌘[ と ⌘] と同じく、入力欄やターミナルの中でも効き、確認や入力のあるダイアログの裏では Mediator（`canMoveBehind`）が捨て、最初の頁より前へは runtime の `history.go` が戻さない。
Chromium（WebView2 も）は、このボタンの `mouseup` の既定の動作で履歴を動かす。
既定のままだと最初の頁の手前の起動を待つ頁まで戻って詰むので、`preventDefault` で止めて自前の操作に替える。
xterm などが伝搬を止めても取りこぼさないよう、捕捉の段で受ける。
ブラウザでは受けず、ブラウザの戻る進むに任せる。前の頁が hangar の外にあることもあるからである。

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
`StatusSelect` はプロジェクト画面とセッション画面の見出しで使う。
プロジェクト画面ではカードの中の押しが親へ届かないよう、既定（`isolate`）でクリックと打鍵の泡立ちを止める。
セッション画面は親に受け口が無く、止めると全体のショートカットが効かなくなるので、`isolate={false}` で止めない。
淡い地色の上の文字は 4.5:1 以上のコントラストを保つ。
状態は常に文字でも示すので、色は補助である。
グラデーションは主ボタンと背景の光だけ、影は浮く部品と端末の板だけに許す。
読む面へのガラス、シマー、スケルトン、タイピング風の表示、文字の影、光る文字は使わない（開いた直後の目次の仮の行だけは例外）。
開いて出るもの（パレット、ダイアログ、通知、メニュー）は、白 88% 以上の濃さにする（`--glass-bg-palette`、`--glass-bg-dialog`、`--glass-bg-toast`、`--glass-bg-menu`）。薄いと、裏の一覧の文字や墨の端末が透けて中身が濁る。
角は部品が 8px（`--r`）、面が 14px（`--r-lg`）、浮くガラスが 16px（`--r-xl`、ダイアログは 18px）、ボタンと「探す・移動」の入口とヘッダーは錠剤（`--r-pill`）にする。

読むための小さな面（ポップオーバー）は `views/primitives/Popover.tsx` の `Popover` を通す。
(i) の詳細、数の札から開く一覧が使う（段 4 の部品で、画面へ付けるのは各画面の PR）。
面は `.menu-pop` をそのまま使い（ガラスはそこにだけ書く）、非モーダルの dialog として開く。
開くと面（中に `data-autofocus` があればそこ）へ焦点が入り、Esc は閉じて焦点を開いた元へ戻して外へは伝えない。
外側を押すと閉じ、焦点が行き場を失ったときだけ開いた元へ戻す。Tab で中の端を越えたら閉じ、開いた元から次へ進ませる。
`InfoPopover` は見出しの右端の (i) と、名前と値の行の面で、名前は辞書の「詳細」である。
行の中の操作がダイアログを開くとき（セッションの「このセッションの変更」の「一覧」）は、先に面を閉じてから開く。面は body への portal なので、残すとダイアログの上に重なる。
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
- サイドバーの「実行中」の並べ替えは、掴んだ行が浮き、ほかの行が滑ってよけ、離すと空いた席へ収まる（`--dur-fast`、「骨格」の節）。
- 折りたたみ、分割の幅、数字の回転、新着への追従は、長さと曲線だけをトークンに揃える。
- セッション画面の右の欄、目次、タブ、案内の帯の出入りは、共通の部品（`views/primitives/motionKit.ts` ほか）で動かす（「セッション画面の動き」の節）。
- Home の帯、引き出し、件数、タブとページの塗りも同じ部品で動かす。一覧と引き出しの並び替えは滑らせず、上がった行と新しい行に淡い黄の印を付ける（「Home の帯と引き出し」「Home の一覧」の節）。
- 右下の知らせ（全画面共通）は、右から滑って入る（CSS の slide）。出るときは右へ 28px（ガラスが横から入る距離と同じ）抜けて薄れ、そのあと高さだけを畳んで外す（`ToastStack.tsx`、`slideAway` と `collapseOut` の `fade: false`、`useMotionList` の `exit`）。最後の 1 枚が消えるときも同じに動かす（`exitWhenEmpty`）。ほかの札は押されて詰まる。札の間は gap ではなく札ごとの上の余白で空け、出る札が余白ごと畳まれるので、外れた瞬間に間が跳ばない。出る間の札は前の中身のまま描き、役も焦点も持たない。

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
`hangar setup cloud` が wrangler の対話ログインのあとで作る先のアカウントを決め、`packages/cloud` の Worker と D1 データベースと R2 バケットを作ってデプロイする。
資源の名前は既定で Worker と D1 が `hangar`、R2 が `hangar-files` で、`--name` で変えられる（`--name x` なら Worker と D1 が `x`、R2 が `x-files`）。

作る先のアカウントは、`wrangler whoami --json` で読んだ全アカウントから決める（`--json` を知らない版では whoami の表を全行読む）。
whoami は `CLOUDFLARE_ACCOUNT_ID` が立っていても全アカウントを並べるので、一覧の 1 つ目で決めると、アカウントが複数ある人の作り先が並び順で決まってしまう。
他の人も入っているアカウントに作ると、同期のメタデータ（平文）がその人たちにも読める。
決め方は次の順である（`packages/cli/src/cloud.ts` の `pickAccount`）。
1. `--account-id` か、無ければ環境変数 `CLOUDFLARE_ACCOUNT_ID` があれば、それを使う。ログインの一覧に無いか、ID の形でなければ止める。
2. 指定が無く、`cloud.json` に前回作ったアカウントがあって一覧にあれば、それを使う。
3. 1 つだけなら、それを使う。
4. 複数なら、標準入力が端末のときは名前と ID の一覧を番号で選ばせる（空で中止）。端末でなければ、一覧と `--account-id` の案内を出して止める。

どの道でも、資源を作る前に「作る先の Cloudflare アカウント」として名前と ID を出す。
止まるときは、Cloudflare にまだ何も作っていない。
`cloud.json` の前回と違うアカウントを指定したときは、前のアカウントの資源が teardown で届かなくなることを見せて、名前を変えるときと同じ合言葉（`replace`）で確かめる。

wrangler に渡す環境からは、wrangler がエージェントの判定に使う印を外す（`packages/cli/src/wrangler.ts` の `wranglerEnv`）。
wrangler 4.135 は am-i-vibing の一覧を環境変数だけで見て、Claude Code なら `CLAUDECODE` で判定する。
エージェントと判定すると、`wrangler deploy` は workers.dev のサブドメインが無いアカウントで、問わずに `package.json` の名前（`packages/cloud` なら `@agent-hangar/cloud` から作った名前）で登録しに行く。
サブドメインは Worker の URL に出て、あとで変えると URL と参加トークンが変わるので、利用者がダッシュボードで決める。
外すのは `CLAUDECODE` と `CLAUDE_CODE_` で始まるものと、ほかの道具が専用に立てる印（`AGENT_MARKER_ENV`）である。
`TERM_PROGRAM` や `PAGER` のように他の用途がある変数との組み合わせで見るものは外さない。

setup の wrangler の失敗（D1 の作成、R2 の作成、デプロイ、`secret put`）は、wrangler の出力を `cleanWranglerError` で 12 行まで整え、複数行のまま見せる（`WranglerStepError`）。
wrangler の 1 行目は見出しで、本当の理由（`[code: 10042]` など）は後ろの行にあるからである。
CLI の最上位はふだん 1 行だけを出すが、`DetailedError`（`WranglerStepError` はその一種）だけは全文を出す（`packages/cli/src/probe.ts` の `cliErrorText`）。
R2 が有効でない（`[code: 10042]`）ときと、workers.dev のサブドメインが無い（`register a workers.dev subdomain`）ときは、日本語の一行の案内を添える。
直したあとは、もう一度 `hangar setup cloud` を走らせればよい。
作成済みの D1 は `d1 info` で見つけてそのまま使い、R2 の `already exists` も通す。

`hangar setup cloud` は、アカウントを決めたあと、D1 を作る前に `wrangler r2 bucket list` が通るかを確かめる。
`[code: 10042]`（R2 が有効でない）なら、何も作らずに止め、ダッシュボードの R2 で有効にする（支払い方法の登録が要る）よう案内する。
10042 以外の失敗はここでは決めつけず、あとの手順がそれぞれの理由を出す。
workers.dev のサブドメインは、事前に確かめる安い手が wrangler に無いので、`deploy` の失敗のときに案内する今の形のままにしている。

Worker の源（`packages/cloud`）は配布版に入っていない（同梱するのは束ねた `worker.mjs` だけである）。
配布版の `hangar setup cloud` と `hangar cloud teardown` は、源が無ければ存在しないパスを見せず、clone して `git checkout v<アプリの版>`、`npm ci`、`npm run hangar -- setup cloud` と進む手順を案内して止まる（`cloudDirMissingMessage`）。
アプリの版は `cli.mjs` の隣の `manifest.json` から読み、読めなければ checkout の行を省く。
`HANGAR_CLOUD_DIR` で指した場所に源が無いときだけ、指した場所を挙げて直させる。
設定画面の「クラウドを用意する」の注記と `hangar setup cloud` のヘルプにも、clone した場所で実行することを添える。

使用量のトークン（`--usage-token`）の案内は、ダッシュボードでの作り方（Account API tokens から Create Token）、権限二つ（Account Analytics: Read と Billing: Read）、渡し方（端末なら伏せ字で貼り付ける）を日本語で述べる。
`op read` で流し込む手は、1Password を使っている人向けの例として最後に添える。

サーバは `cloud.json` を起動のときに読み、そこで無かった（または壊れていた）端末では、置き場のディレクトリを `fs.watch` で見張る（`boot/sync.ts`）。
`cloud.json` が現れて読めたら、起動と同じ組み立て（`assemble`）で同期の部品を組み直して始める。開き直しは要らない。
状態は既存の配り（`sync.status`、`config.update`）で画面に届く。
`fs.watch` が使えないとき（作れない、または `error` が出たとき）だけ、30 秒ごとに読み直す。待機中に周期の仕事は足さない。
見張るのは「無い、または壊れている状態から現れる」ときだけである。
起動のときに参加済みだった端末は見張らず、動いている同期の `cloud.json` の書き換え（別のクラウドへの付け替え、`leave` や `teardown` での削除）は拾わないので、今までどおり開き直しで効く。
壊れているあいだは始めない。直った書き込みで始まる。
同期の部品（エンジン、使用量、本文の上げ手、降ろし手、設定の同期、状態の配り）は `Core` にまとめてあり、`SyncParts` はそのときの `Core` を引く。
HTTP と要約の側は、同期の部品を起動のときに掴まず、呼ぶたびに `SyncParts` から引く。

`hangar cloud status` は、`cloud.json` があるのにサーバの同期が `off` なら、アプリを終了して開き直すと同期が始まると添える。
起動より後に参加した端末は、動いているサーバが `cloud.json` を見つけて始めるので、この案内が出るのは見張りが働かなかったときだけである。
実物の設定は `~/.agent-hangar/cloud/wrangler.jsonc`（権限 0600）に書き出し、そこへ D1 の ID と R2 のバケット名を埋める。
アカウント ID はこのファイルにもコードにも書かず、wrangler を呼ぶたびに環境変数で渡す。
デプロイ直後の数秒は `workers.dev` の反映待ちで `error code: 1042` が返るので、setup は `/health` が通るまで最大 2 分試してから先へ進む。
wrangler はプロジェクトのローカル依存として同梱する。
Worker は端末ごとの端末トークン（32 バイトの乱数）で要求を認証し、D1 には端末トークンのハッシュだけを置く。

**setup と参加の CLI（互換の版 9）。**
`hangar setup cloud` は、デプロイの前に最初の端末トークンを作り、その SHA-256 を `wrangler secret put BOOTSTRAP_TOKEN_HASH` の標準入力で渡す。
`/health` が通ったら、この PC の鍵ペアを作り、`POST /bootstrap` にこの PC の ID（`home.device.id`）と最初の端末トークンを送って登録する（反映待ちの 401 と 503 は 5 秒おきに 6 回まで待つ）。
登録できたら、端末トークンを失わないよう、名簿を置く前に `cloud.json`（版 2、0600）を書く。世代 1 の世代鍵もここで作る。
続けてリカバリーキーの鍵ペアを作り、世代鍵の一覧をこの PC 宛てと `recovery` 宛ての keybox に封じて `PUT /keyboxes` で置き、この PC とリカバリーキーの公開鍵を入れた名簿を `PUT /roster`（`ifVersion: 0`）で置く。
最後にリカバリーキー（`hangar リカバリーキー`、作成日、URL、暗号鍵の 4 行）を 1 回だけ表示する。保存したかを末尾 4 文字で確かめる手順は、後の段で必須にする。
同じ名前でもう一度実行したとき（Worker の入れ替え）は、`secret put` も登録もせず、`cloud.json` の暗号鍵と端末トークンをそのまま使う。名簿が無ければ（名簿を置く前に止まった setup）、名簿と keybox とリカバリーキーをここで作る。
古い形式（版 1）の `cloud.json` があれば上書きせず、先に `hangar cloud teardown`（参加しただけの PC では `cloud.json` の削除）を案内して止まる。

新しい PC の参加は、殻（と端末）から CLI を短く呼ぶ 3 つのコマンドで進める。どれも `--json` で最後の 1 行に結果を出し、失敗は `{ ok: false, code, message }` である。

| CLI | 返す JSON |
| --- | --- |
| `hangar cloud join-check <url> --json` | `{ ok, check: { url, host, pcCount, current } }`。`current` は今参加しているクラウドの `{ url }` か null |
| `hangar cloud join-request <url> --json [--overwrite]`（参加コードは標準入力） | `{ ok, request: { sas, expiresAt } }`。`sas` は確認コードの 6 桁 |
| `hangar cloud join-poll --json` | `{ ok, poll: { status } }`。`status` は `waiting`、`approved`、`rejected`、`expired`、`none` |

`join-request` は参加コードを手元で正規化し、形が違えば Worker に送らずに `invalid-code` で止まる。
鍵ペアを作って、送る前に下書き `~/.agent-hangar/cloud-pending.json`（0600。参加コードの平文は置かない）に書き、公開鍵と名前と OS を参加コードで封じて `POST /join/requests` に置く。
`join-poll` は `GET /join/status` を 1 回だけ問い合わせる。承認されたら端末トークンを先に下書きに書き、自分宛ての keybox を開いて世代鍵を読み、名簿の版とスマホ用の鍵を写して `cloud.json`（版 2）を書き、下書きを消す。keybox がまだ無ければ、端末トークンを下書きに持ったまま `waiting` を返し、次の問い合わせで続ける。
`hangar cloud join <url>` は同じ手順を端末で対話して進める（2 秒ごとに問い合わせる）。
旧い `hangar join` は「参加トークンは廃止されました」と案内して 1 で終わる。

**互換の版 9 の Worker（E2E の作り直し）。**
Worker は参加用の秘密を持たず、`JOIN_SECRET_HASH` と `POST /join` を無くした。
最初の PC は、setup が Worker の secret `BOOTSTRAP_TOKEN_HASH` に入れた最初の端末トークンで `POST /bootstrap` を 1 回だけ通り、`devices` に入る。
使ったハッシュは `meta.bootstrap_used` に残し、同じハッシュは 2 度通さない。
`hangar recover` は secret を別のハッシュに入れ替えて、もう 1 度ここを通る。
2 台目からは、参加済みの PC が発行した参加コード（5 分、1 回限り）に新しい PC がリクエストを置き、発行した PC が承認する（下の「Worker の表」）。
CLI の setup と参加は上の「setup と参加の CLI」の形になった。殻の命令は下の表、参加の画面は「設定」の節のクラウド同期の段落にある。

**発行した PC の承認（`sync/joinApprover.ts`）。**
参加コードの発行と承認は、動いているサーバの `JoinApprover` が行う（CLI だけで PC を追加する口は作らない）。
参加コードの平文はこの中のメモリにだけ置き、Worker には SHA-256 だけを送る。
コードが生きている間だけ、3 秒ごとに `GET /join-codes/mine` を問い合わせ、期限を過ぎたら Worker に問い合わせずに `expired` にして止める。
リクエストを見たら参加コードで開き、確認コードを導いて `requested` にし、そのリクエストにつき 1 回だけ、右下の通知（`ServerEvent` の `join.request`）と OS の通知（`OsNoticeDto` の種類 `join`、殻の `notify::Kind::Join`）を出す。
状態が変わるたびに `join.update` を配る。
承認は、名簿に新しい PC を足す（`RosterStore.update`）、世代 1 から n までの一覧を新しい PC の公開鍵に封じた keybox を置く（`PUT /keyboxes`）、`POST /join-codes/:hash/approve` の順に行う。
Worker は、承認の前の新しい PC（devices にまだ無い）を keybox の受け手として通す。通すのは、書き手が発行したコードにリクエストを置いた PC で、リクエストが期限内か、承認の後で端末トークンをまだ渡していない間だけである。
アプリが落ちて `JoinApprover` が作り直されると、平文が消えて承認できなくなり、新しい PC は期限（5 分）で `expired` を受け取る。
口は `POST /api/sync/join-codes`（発行）、`GET /api/sync/join-codes/current`（状態）、`POST /api/sync/join-codes/current/approve`、`/reject`、`DELETE /api/sync/join-codes/current`（取り消し。生きているコードは拒否で閉じる）で、どれも `JoinApproverState` を返し、`no-store` を付ける。
参加トークンの口（`/api/sync/joinToken`）は消した。

解除した PC は、同じ端末 ID のまま参加コードで再参加できる（承認は要る）。
`POST /join/requests` は解除済みの同じ ID を通し、解除されていない同じ ID だけを断る。
承認の後の最初の `GET /join/status` が、解除済みの行を新しい端末トークンの行に 1 つの文で置き換える（`revoked_at` を空にし、`joined_at` を今にする）。

参加し直すと（`hangar setup cloud` のやり直しと、`hangar join` のし直し）、Worker は同じ端末 ID の行の `token_hash` を新しい端末トークンのものに入れ替え、古い端末トークンは 401 の `{ error: 'unauthorized' }` で断られる（解除の `revoked` とは別の本文である）。
新しい端末トークンは `cloud.json` にだけ書かれ、CLI は動いているサーバへ知らせない。
そこでサーバは、解除ではない 401 を受けたら `cloud.json` を読み直し、端末トークンだけが変わっていれば、それに差し替えて同じ要求を 1 度だけ試し直す（`HttpCloudClient` の `reloadCredentials`、組むのは `boot/sync.ts`）。
エンジン、本文の上げ手と降ろし手、使用量、設定の同期、PC の一覧、一時停止中の生存の知らせは同じ client を持つので、差し替えは全部に一度に効く。
同時に断られた要求は、先に差し替えた組で試し直す。
読み直しても同じ端末トークンなら、試し直さずに今までどおりの失敗にする。
宛先か参加用の秘密が変わっていたら差し替えない。
宛先は読み位置（`lastSeq`）と状態の表示に、秘密は本文の鍵に結び付いていて、組み直しの要る変化だからである。
それらは今までどおり、アプリを開き直すと効く。
参加済みの間も `cloud.json` を見張る形にはしなかった。
見張りで組み直すと、走っている push と本文の上げ下ろしを待ってから止める段取り（`drain`）が要るが、端末トークンの差し替えだけなら client の中で済み、断られた要求の試し直しまで 1 か所で閉じるからである。

同期は自分の端末同士のためのもので、他人と 1 つの箱を共有しない。
別の人が使うときは、その人が自分の Cloudflare アカウントで同じ `hangar setup cloud` を走らせる。
デプロイは人ごとに独立し、データは混ざらない。

#### Worker の表

Worker の D1 は、端末側の共有テーブルの形をそのまま写さない（`packages/cloud/src/schema.ts`）。
スキーマは Worker が起動後の最初の要求で整える（`ensureSchema`）。
マイグレーションの手順を別に持たず、cold start のたびに `create table if not exists` を通す形である。
互換の版 9 は作り直しなので、版 8 までの D1 は読まず、列足しも移し替えもしない。
作り替えの後始末（`cleanup.ts`）も無くした。

Worker が平文で持つのは、鍵、連番、時刻、端末の ID、鍵の世代だけである。
行の中身、ファイルのパス、PC の名前は、PC が封じた値の中にあり、Worker は開けない。
封じた値は、口では base64url の文字で受け渡し、D1 にはバイト列の BLOB で置く（文字のまま置くと大きさが約 4/3 倍になる）。

| 表 | 1 行の意味 | 平文の列 | 封じた列 |
| --- | --- | --- | --- |
| `rows` | 共有テーブルの今の行。1 つの鍵に 1 行 | `seq`（autoincrement）、`k`（表名と行 ID の HMAC）、`op`、`updated_at`、`device_id`、`epoch` | `sealed` |
| `files` | R2 の本文の索引 | `key`（`b/<端末 ID>/<HMAC>`）、`kind`、`device_id`、`size`、`stored_size`、`uploaded_at`、`epoch` | `sealed_meta`（パス、ハッシュ、時刻） |
| `devices` | 参加している端末 | `id`、`kind`（`pc` か `mobile`）、`token_hash`、`joined_at`、`last_seen_at`、`revoked_at`、`expires_at` | 無し |
| `roster` | 名簿（1 行だけ） | `version`、`updated_at` | `sealed`（PC の公開鍵、名前、OS、スマホ用の鍵） |
| `keyboxes` | 世代鍵を受け手ごとに封じた箱 | `epoch`、`recipient`（PC の ID か `recovery`）、`created_at` | `sealed` |
| `phone_keyboxes` | スマホ用の鍵を受け手ごとに封じた箱 | `epoch`、`recipient`（スマホの ID）、`created_at` | `sealed` |
| `join_codes` | 参加コード | `code_hash`、`created_by`、`created_at`、`expires_at`、`used_at`、`status`、`device_id` | `request`（新しい PC の公開鍵、名前、OS） |
| `meta` | 表を作ったときの印（`cloud_id`）、回数の窓、bootstrap の印 | `key`、`value` | 無し |

スマホ向けの 3 表（`mobile_feeds`、`launch_requests`、`mobile_pairings`）は「スマホ（試験的）」の節にある。
`devices` は IP と所在地を持たない。
名前と OS は名簿に置く。

口は次のとおりである。

| 経路 | 通せるトークン | 働き |
| --- | --- | --- |
| `POST /bootstrap` | 不要（secret のハッシュで認める） | 最初の PC を 1 回だけ登録する |
| `GET /join/hello`、`POST /join/requests`、`GET /join/status` | 不要 | 接続先の確認、参加リクエストを置く、承認待ちの問い合わせ（承認の後の最初の 1 回で端末トークンを返す） |
| `POST /join-codes`、`GET /join-codes/mine`、`POST /join-codes/:hash/approve`、`POST /join-codes/:hash/reject` | PC | 参加コードの発行、状態の問い合わせ、承認、拒否 |
| `GET /roster`、`PUT /roster` | PC | 名簿を読む、版を条件に書き換える（合わなければ 409） |
| `GET /keyboxes`、`PUT /keyboxes` | PC | 自分宛てのいちばん新しい keybox を読む、keybox を置く |
| `POST /changes`、`GET /changes`、`GET /rows` | PC | 封じた行の push、pull、取り直し |
| `PUT /files/:key`、`GET /files`、`GET /files/:key` | PC | 封じた本文とメタの出し入れ |
| `DELETE /blobs` | PC | 自分の本文を消す（1 回 50 件、1 日 500 件、置いてから 1 時間は消さない） |
| `GET /devices`、`POST /devices/:id/revoke` | PC | 端末の一覧と解除 |

名簿か keybox を書き換えた要求は、同じ batch で `rows` の印の行（`k = '~roster'`、`sealed` は空）を表の末尾の連番で入れ直す。
他の PC は pull でこの 1 行を見たときだけ `GET /roster` と `GET /keyboxes` を読むので、`GET /changes` の読み取りの行数は増えない。
pull と `GET /rows` の 1 頁は、500 行か、`sealed` の合計が 8 MiB を超えたところで切り、続きは `nextSeq` と `nextAfter` から読ませる。
16 KiB を超える行の `sealed` は、頁に入ると決まってから主キーで読み直す（頁の問い合わせが受け取る量を抑えるため）。

PC の側で行を封じて開くのは `SealedCloudClient`（`packages/server/src/sync/sealedClient.ts`）である。
線の上の client（`HttpCloudClient`）を包み、同期のエンジンには開いた行（`ChangeIn` と `ChangeOut`）だけを見せる。
push は各行を今の世代の鍵で封じ、`k` は `/index` の鍵で表名と行 ID から求める。
AAD には `k`、PC の ID、`updated_at`、`op`、世代を入れるので、Worker で行を付け替えると開けなくなる。
pull と写しは、印の行を開かずに名簿と keybox の読み直しへ回し、ほかの行を行が名乗る世代の鍵で開く。
印の行の `epoch` は古い世代の PC が書けば後戻りするので、「名簿が変わったかもしれない」以上の意味には使わない。
開けなかった行（知らない世代、付け替え）は当てずに `unreadable` として返す。
エンジンは、知らない世代があれば 1 巡に 1 度だけ鍵を読み直し、届けば同じ頁を読み直す。
それでも開けない行は飛ばして区切りを進め、飛ばした数を `sync_state` の `lastError` に残す（次に何も飛ばさない 1 巡で消える）。
飛ばした行のいちばん小さい連番は `sync_state` の `rowsSkippedFrom` に控える（前の控えがあれば小さい方）。
新しい世代の鍵が届いたら、エンジンの `rewindSkippedRows` が差分の区切り（`lastSeq`）をその手前まで巻き戻し、次の pull で当て直す。
巻き戻しは走っている pull の終わりを待つので、その pull の終わりの書き込みに上書きされない。
Worker の 413 は封じた行を `k` で名指しするので、`SealedCloudClient` が送った塊から表名と行 ID に戻し、エンジンはその行だけを諦める。

R2 の本文も `SealedCloudClient` が封じて開く。
鍵名は呼び手（uploader と設定の同期）が今の世代の `/index` の鍵で求める。
本文は `b/<自端末>/<HMAC("t:" 元の PC ":" セッションの UUID [":" サブエージェントの ID])>`、設定の束は `b/<自端末>/<HMAC("c:" 元の PC ":" 相対パス)>` で、パスとセッションの UUID は Worker に見えない。
同じ世代のあいだは同じ鍵名なので、上げ直しは同じオブジェクトへの上書き（冪等な `PUT`）になる。
本文は gzip してから、その世代の `/file` の鍵で今までのストリーム暗号（`sync/crypto.ts`）に通す。
パス、平文の SHA-256、mtime、元の PC はメタとして `/row` の鍵で封じ、AAD に鍵名、PC の ID、`kind`、世代を入れて `x-hangar-meta` で送る。
見出しに平文で載るのは `kind`、`size`、`epoch` だけである。
今の世代でない世代を名乗る本文と、中身のパスから求め直した鍵名が名乗る鍵名と合わない本文は、上げずに断る。
`GET /files` の行は名乗る世代の鍵で開き、手元に無い世代があれば 1 度だけ名簿と keybox を読み直す。
鍵があっても開けない行（付け替え、鍵名と中身の食い違い）は捨てる。
読み直しても世代の鍵が届かない行は `unreadable` で返し、puller は区切り（`filesSeq`）を止めずに越えて、いちばん小さい連番を `sync_state` の `filesSkippedFrom` に控える。
後で鍵が届いたら `rewindSkippedFiles`（`sync/puller.ts`）が区切りをその手前まで巻き戻し、次の pull が読み直す。
本文は行の世代の鍵で復号するので、世代 1 と 2 を持つ PC は世代 1 で封じた本文も降ろせる。
設定の束は行に世代を持たないので、受け取る側は手元の世代を新しい順に鍵名を求めて試す。
手元の台帳（`file_sync`）と諦めた控えは、R2 の鍵名ではなく版 8 までと同じ形の台帳の鍵（`sync/ledgerKey.ts`、`transcripts/<端末>/<uuid>.jsonl.gz`）で引く。
R2 の鍵名は世代ごとに変わるが、台帳の鍵は変わらないからである。

名簿と keybox の読み書きは `RosterStore`（`packages/server/src/sync/roster.ts`）である。
名簿は今の世代の `/roster` の鍵で封じ、AAD に書いた後の版を入れる。
`GET /roster` は封じた世代を名乗らないので、開くときは手元の世代を新しい順に試す。
読んだ名簿はメモリに持ち、印の行を見るまで、版が cloud.json の `rosterVersion` と同じ間は読みに行かない。
読み直した版が手元と同じなら開き直さない。
書き換え（`update(fn)`）は版を条件に置き、409 なら読み直して `fn` を当て直す。
3 回とも断られたら投げる。
2 台が同時に書き換えても、後の方が先の変更の上に当て直すので、どちらの変更も残る。
`PUT /roster` の `epoch` は今の世代である。
keybox は自分宛てのいちばん新しい 1 つだけを読み、中身の世代 1 から n までの一覧を `Keyring.addEpochs` で足して cloud.json に書き戻す。
`SealedCloudClient` の `onRoster`（印の行か、知らない世代の行を受けたとき）は、keybox を先に読み（新しい世代で封じた名簿はその世代の鍵が無いと開けない）、次に名簿を読み直す。
新しい世代の鍵が増えたら、エンジンの `rewindSkippedRows` と puller の `rewindSkipped` を待たずに呼ぶ。
名簿がまだ無い（404）こと、自分宛ての keybox がまだ無いこと、開けない名簿と keybox は投げない。
`onRoster` が投げると pull が区切りを進めないので、投げるのは通信と Worker の失敗だけである。

D1 の 1 日の上限（読んだ行、書いた行）に当たった失敗は、500 ではなく 429 で返す（`packages/cloud/src/limits.ts`）。
見分けるのは D1 の文で、`free tier daily row read limit` か `free tier daily row write limit` を含むものである（大文字と小文字は問わず、原因の文も見る）。
本文は共有の `CloudLimitBody`（`{ error: 'limit', limit, resetAt }`）で、`resetAt` は上限が戻る次の UTC の 0 時（epoch のミリ秒）である。
Worker も端末も量を数えないので、上限に当たったことはこの失敗で知る。

手元のサーバ側の入口は、フェーズ 3 で入れた鍵付きの入口と入口の 3 つの検査（Origin、`Sec-Fetch-Site`、`Content-Type`）をそのまま通る。
同期のために足した `/api/sync/*` と `/api/devices` と `/api/sessions/:id/resume-here` も同じ関門の後ろにある。
PC の一覧（`/api/sync/cloud-devices`）は読むだけで、参加とこの PC の参加の解除の口は HTTP に載せない（「PC の一覧と解除」）。
他の PC の解除だけは `POST /api/sync/cloud-devices/:id/revoke` に載せる。暗号鍵の再生成に要る世代鍵と回しの記録が、動いているサーバーにあるからである（「PC の一覧と解除」の「解除と暗号鍵の再生成」）。
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

- **hangar のメタデータ**：共有テーブルの全行。PC が 1 行ずつ封じてから D1 の `rows` に置く。
- **セッションのトランスクリプト**：`~/.claude/projects` の jsonl を gzip し、暗号化して R2 に置く。鍵名は `b/<端末 ID>/<HMAC>` で、HMAC の入力は元の PC、セッションの UUID、サブエージェントの ID である（「Worker の表」）。端末ごとに分ける。UUID は Claude Code が付けた `provider_session_id` である。
- **Claude Code のユーザー設定**：`~/.claude/CLAUDE.md`、`settings.json`、`settings.json` の `statusLine.command` が指すスクリプト、`skills/**`、`memory/**`、`projects/*/memory/**`。本文と同じく暗号化して R2 に置く。鍵名は `b/<端末 ID>/<HMAC("c:" 元の PC ":" 相対パス)>` で、相対パスは Worker に見えない。

hangar 自体の設定（ワークスペースルート、ターミナルアプリ）と UI の一時状態は同期しない。
スマホ向けの 3 表（`mobile_feeds`、`launch_requests`、`mobile_pairings`）は共有テーブルではなく、PC どうしの同期には載らない（「スマホ（試験的）」）。

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

互換の版 9 から、D1 と R2 に置くものはどれも PC どうしの間で暗号化する（E2E）。
Worker と Cloudflare は、表名、行 ID、行の中身、ファイルのパス、PC の名前、セッションの題を読めない。
平文で見えるのは、鍵名、連番、時刻、端末の ID、世代、大きさだけである（「Worker の表」）。

鍵は世代鍵 `K[n]`（32 バイト）から HKDF で用途ごとに導く。
用途は、行の封（`hangar-e2e-v2/row`）、鍵名の HMAC（`/index`）、指紋（`/fp`）、本文の暗号（`/file`）、名簿の封（`/roster`）である。
PC は持っている世代鍵を `~/.agent-hangar/cloud.json`（版 2）の `epochs` に置き、`Keyring`（`packages/server/src/sync/keyring.ts`）が用途の鍵を導いて世代の番号で引けるようにする。
書くときは今の世代（`currentEpoch`）を使い、読むときは行やファイルが名乗る世代を使う。
世代鍵は、受け手の公開鍵で封じた keybox で配る。
keybox の中身は世代 1 から n までの一覧なので、新しい PC も過去の世代で封じた行と本文を開ける。

行は `sealed = 0x02 || iv(12) || AES-256-GCM(/row の鍵, flag || 本文)` で封じる。
本文は `{tableName, rowId, payload}` の JSON で、256 バイト以上なら gzip して `flag` を 1 にする。
`k` は `HMAC(/index, 表名 ":" 行 ID)` で、同じ世代の鍵を持つ PC は同じ `k` を求められるので、LWW の 1 行 1 鍵の形が保たれる。
AAD は `["row", k, PC の ID, updated_at, op, 世代]` の JSON なので、Worker で `k`、`device_id`、`updated_at` を書き換えた行は開けない。
ファイルのメタ（パス、平文の SHA-256、mtime、元の PC）も `/row` の鍵で同じ形に封じ、AAD は `["file", 鍵名, PC の ID, kind, 世代]` である。

名簿（PC の名前、OS、公開鍵、スマホ用の鍵）は `/roster` の鍵で封じて 1 行で置く。
名簿か keybox を書き換えた PC は、`rows` に印の行（`k = "~roster"`、`sealed` は空）を入れ直す。
他の PC は pull でこの行を見たときだけ名簿と keybox を読み直す（`RosterStore`、「Worker の表」）。
知らない世代で封じた行と本文は、当てずに区切りを越え、いちばん小さい連番を `rowsSkippedFrom` と `filesSkippedFrom` に控える。
keybox を読んで新しい世代の鍵が増えたら、控えの手前まで区切りを巻き戻して読み直す。

R2 に置くファイルの本文は、gzip してから、その世代の本文の鍵 `HKDF(K[n], info = "hangar-e2e-v2/file")` でストリーム暗号（`packages/server/src/sync/crypto.ts`）に通す。
受け取る側は、索引の世代の鍵で開けない本文を受け取らない（暗号化していない本文は開けない）。
形式は、先頭に `HGR1` の 4 バイトと 8 バイトの nonce 接頭辞を置き、その後ろに 1MB ごとのチャンクを並べる。
チャンクは `flag`（1 バイト、最後のチャンクだけ 1）と `len`（4 バイト）と本体と 16 バイトの認証タグからなり、nonce は接頭辞にチャンク番号を継いで作る。
AAD にチャンク番号と `flag` を入れるので、並べ替え、複製、欠落、途中での打ち切りは、どれも認証タグで落ちる。
`len` には上限（1MB + 64 バイト）を置く。
他端末が書いた本文は外から来た入力なので、相手の申告する長さをそのまま信じて溜め込まない。
フェーズ 0 の計測では暗号化 2,700MB/s、復号 600MB/s で、同期の律速は gzip とネットワークである。
版 8 までは D1 のメタデータ（題名、要約、TODO、メモ）を平文で持っていたが、版 9 からは行ごと封じる。
Worker 側で中身を使う機能は持たない。

ファイルの一覧は D1 の `files` 表に持ち、端末、サイズ、R2 の鍵名、世代を平文で、パス、SHA-256、更新時刻、元の PC を封じたメタで記録する。
降ろす側は、この指紋と実際に降りた中身の指紋を突き合わせる。
暗号化そのものは「鍵の同じ別のファイルへの差し替え」を見抜けないので、封じたメタの AAD（鍵名）と、鍵名と中身のパスの突き合わせと、指紋の突き合わせがその守りになる。

`PUT` は R2 を先に書き、索引を後に書く。
途中で倒れれば、残るのは索引に無い R2 の本体だけである。
逆の向きで残る「索引にあるのに本体が無い」は、降ろす側が永久に 404 を踏む。
本文と設定を消す経路（`DELETE`）は、段 1 で消した。
互換の版 9 で、PC が自分の本文を消す `DELETE /blobs` を足した（下の掃除の段落）。
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
互換の版 9 の掃除は孤児の 2 つだけで、R2 は本文の置き場（`b/`）の下だけを一覧する。
削除の印から 30 日たったセッションの写しを Worker が消す掃除（`sweepTrash`）は無くした。
印は封じた行の中にあり、Worker には読めないからである。
消すのは PC で、`DELETE /blobs` に自分の本文の鍵を渡す（「Worker の表」）。
1 回 50 件、1 日 500 件（UTC の日付で数える）までで、置いてから 1 時間たっていない本文と、他の PC の本文は断る。
R2 を先に消し、索引の行を後に消す。

PC の側のゴミ箱の掃除は `sweepTrashBlobs`（`packages/server/src/sync/trashSweep.ts`）である。
同期の部品と一緒に組み、起動の 5 分後に 1 回、その後は 6 時間に 1 回走らせる。
一時停止の間と、版、解除、上限で同期が止まっている間は走らせない。
対象は、削除の印（`session_states.trashed_at`）から `TRASH_KEEP_MS`（30 日、shared）を過ぎ、その後に戻されていないセッションである（`trashedLongAgo`、`packages/server/src/sessions/trash.ts`）。
印は同期で受信するので、他の PC で消したセッションも入る。
同じ Claude Code のセッション ID を持つ生きたセッションの行があれば外す。
本文の鍵名はその ID から求めるので、生きている方の本文まで消してしまうからである。
R2 の鍵名は世代の `/index` の鍵の HMAC なので、世代を回した後に上げ直した本文は、世代ごとに別の鍵名で R2 に置かれたままになる。
uploader は PUT が通るたびに、台帳の鍵と世代を端末ローカルの `blob_uploads`（版 32）に控える。
掃除はこの控えから、主線とサブエージェントの本文の、上げた世代ごとの鍵名を求め直す（手元の鍵で当て推量の鍵名を作らない。1 日 500 件の枠を空振りで使わないためである）。
50 件ずつ `DELETE /blobs` に渡し、消えたと返った鍵（索引に無かったものを含む）を控えから外す。
断られた鍵（置いてから 1 時間たっていない、1 日の上限からあふれた）は控えたままにし、次の回で送り直す。
1 日の上限を使い切った 429 は、黙ってその回を終える。
消すものが無い回は Worker に何も送らない。
Worker が消させるのは自分の端末 ID の下だけなので、他の PC が上げた写しはその PC の掃除が消す。
解除した PC が上げた写しは、索引に載ったまま誰も消さない（孤児の掃除は索引に無いものだけを拾う）。

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
PC ごとに 1 つの tar（`manifest.json` と `blobs/<sha256>`。`sync/config/bundle.ts` の自前の ustar）を gzip し、今の世代の本文の鍵で暗号化して、既存の `PUT /files`（`kind: 'config'`、鍵名は相対パスの HMAC。「Worker の表」）で上げる。
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
サーバは `~/.claude` に書かない（全体計画の D9）。指示書を読んで承諾の窓で見せ、控えを取って書き、基準を更新し、指示書を消すのは、殻の命令と `hangar config apply` の役目である。

**適用と世代へ戻す（PR 16）。**
書く処理の本体は `sync/config/apply.ts` にあり、CLI（`packages/cli/src/config.ts`）と殻の命令（`apps/desktop/src-tauri/src/configapply.rs` と `lib.rs`）が同じものを走らせる。
サーバ本体は引かず（`cliEntry.ts` から出す）、読むのは指示書と inbox、書くのは設定の入れ物と `config_base` だけである。

- `hangar config apply`：指示書を読み、件数と種類と実行される内容を見せて承諾を取り、控えを取って書く。
  `--plan` は見立てだけ、`--yes` は聞かずに書く、`--json` は機械向けに 1 行の JSON を返す（`{ ok, plan }`、`{ ok, result }`、失敗は `{ ok: false, code, message }`）。
  `--order <createdAt>` は、確認した指示書にだけ適用する（確認のあとに選び直されていたら `stale` で断る。殻が使う）。
  対話でない端末で `--yes` が無ければ書かない。
- `hangar config restore [世代]`：世代を省くと一覧を出す。
  世代を指すと戻す先と消す先を見せて承諾を取る（`--plan`、`--yes`、`--json` は同じ）。
- 殻の命令 `apply_config_sync`（引数なし）と `restore_config_sync(name)`：CLI に `--plan --json` を走らせ、返った見立てを殻の承諾の窓に見せ、承諾されたときだけ `--yes --json --expect <指紋>`（適用は `--order` 付き）を走らせる（0.4.0 から。それまではネイティブの確認だった。「承諾の窓」の節）。
  `--plan --json` の見立てには、書く先のファイルごとの操作（新規、変更、削除）と、今の中身から書いた後の中身への差分と、書く先の今の中身の指紋（`fingerprint`）が入る（`planApplyFiles`、`planRestoreFiles`）。
  `--expect` を渡すと、CLI は書く直前に書く先の指紋を取り直し、違えば何も書かずに `changed` で断る（指示書は残す）。見せた後に手で `~/.claude` を変えたときに、見せていない中身で上書きしないためである。
  実行される内容（skills、commands、agents、フックとコマンド実行とスクリプトの印）を含むときは、窓の見出しを注意の見た目にし、補足にその件数と項目の名前を書く。
  結果の文は、殻の頁と同じ言語で書く（`configapply::words`。「言語の決め方」の節）。CLI が返した失敗の文は、そのまま出す。
  結果は `{ status, message, generation, code }`（`status` は `applied`、`restored`、`cancelled`、`none`、`failed`、`busy`）で頁へ返す。
  書けなかったときは、承諾の窓が失敗の段で知らせ、窓を閉じたときに `failed` を返す。
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
適用は、サーバに指示書を書かせ（`PUT /api/config-sync/apply-order`）、殻があれば `apply_config_sync` で承諾の窓へ進む（runtime）。
確認の返事が来るまで、ダイアログは閉じられず、押せない。
`applied` と `restored` のときは状態を取り直してダイアログを閉じ、`cancelled`、`none`、`busy`、`failed` のときは書いていないので開いたままにして文を知らせる（`failed` は赤）。
ブラウザでは殻が無いので、指示書を書いたところで閉じ、設定の「適用の待ち」の行が `hangar config apply` を案内する。
指示書は、殻の確認で取り消されたときも残るので、同じ行から「適用…」で確認をやり直すか、「取り消す」（`DELETE`）で消せる。
バックアップの世代は、行を開くと一覧が出て、殻があれば「この世代に戻す…」（`restore_config_sync`）、無ければ `hangar config restore <世代>` を出す。

件数と状態は `ConfigSyncDto`（bootstrap と `config.update`）が正で、項目の一覧は Store の `configDetail`（送る一覧、届いた変更、競合、送らなかった項目、世代）に、設定の画面に入ったときとダイアログを開いたときに取る。
件数が 0 のものは取りに行かない（サーバは項目の走査をするため）。
設定の画面かダイアログを見ているあいだに状態が動いたら、取り直す。
送らなかった項目の通知カードは作らない（注意の行は PR 19）。
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
束の本体は既存の `PUT /files/b/<端末>/<HMAC>`（kind は `config`、HMAC の入力は `c:<端末>:.hangar/config-bundle.hgr`、自端末の鍵だけ書ける）と `GET /files/<鍵>` で運び、束の行は既存の `POST /changes` と `GET /changes`、`GET /rows` で運ぶ。
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
無料枠への影響は、束 1 回の送信につき R2 の PUT が 1 回（class A）、D1 の書き込みが `files` の 2 文（削除、挿入）と `rows` の 2 文（古い行の削除と挿入）に、1 分おきの `devices` の更新で、件数に依らない（同期の版 6 で変更ログをやめた）。束は端末ごとに 1 つなので、旧実装（項目ごとに PUT 1 回と D1 3 文）より、変更の多い日ほど軽い。
送り直すのは束の指紋が変わったときだけである。

旧実装の置き場（R2 の `config/<端末>/<相対パス>` と `files` の kind が `config` の行）の後始末は、`cleanupLegacyConfig`（`packages/cloud/src/cleanup.ts`）であった。PR 15 が実装し、関門 `LEGACY_CONFIG_CLEANUP_ENABLED` は閉じてあった。
互換の版 9 は D1 と R2 を作り直すので旧い置き場は残らず、`cleanup.ts` は消した。以下はそれまでの経緯である。
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
送る変更そのものも、時刻の刻みは間引く（同期の版 6）。
`runs.heartbeat_at` の 30 秒ごとの書き直しは共有の行に書かない（「他端末セッションのロック」）。
`sessions.last_activity_at` は、索引（`indexer/indexFile.ts` の `applySessionFacts`）が、ほかの事実が変わらず進みが 5 分（`ACTIVITY_SHARE_MS`）未満なら書かない。
ターンの終わり（system の `turn_duration`）と、入力待ちの問いが新しく出たときは、5 分未満でも書く。
間引いた進みは手元の `sessions` にも書かず、この PC の画面の時刻と一覧の並びは、手元の統計の `session_stats.last_ts` との新しい方で出す（`db/queries.ts` の `SESSION_SELECT` の `activity_at`）。
検索の期間、プロジェクトの最後の動き、自動の Done などは共有の値を読むので、最大で 5 分遅れる。
版 5 までは、この 2 つの刻みが端末の送る変更の 9 割を占めていた（2026-10-16）。
1 回の push は 40 行まで、1 回の pull は 500 行までである。
pull は起動時、ウィンドウが前面に来たとき、30 秒ごと、セッション起動の直前（2 秒で諦める）に行う。
Worker は受け取った行を `rows`（鍵 `表:行 ID` ごとに今の 1 行）に書き、書いた行に表の末尾の連番を付ける。
pull は連番以降の行を返す。
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

端末ローカルの `changes` は、push 済みで 7 日を過ぎた行を消す。

**Worker の `rows` と連番（同期の版 6）。**
Worker は変更ログを持たない。
`rows` は `files` と同じ作りで、`seq integer primary key autoincrement` と一意の鍵 `k` を持つ。
push の 1 行は 2 文で書く。
`delete from rows where k = ? and updated_at < ?` で届いた版より古い行だけを消し、続けて鍵が空いていれば入れる（`insert … select … where not exists (…) on conflict(k) do nothing`）。
同着（`updated_at` が等しい）は消さないので書き換えず、先に着いた方を残す。端末の取り込みの決着と同じである。
採った数は挿入の文の `meta.changes` で数え、push の前に今の行を読み直さない。
`where not exists` は、入れなかった行にも SQLite が連番を 1 つ使って欠番を作るのを防ぐ（`on conflict` は守りとして残す）。
書き換えた行は、消してから入れ直すので表の末尾の連番を受け取る。
連番は SQLite が書き込みのロックの中で振るので、commit の順と連番の順がそろい、JS で連番を計算しない。
`GET /changes?since=` は `seq > since` で自分の端末以外の行を連番の順に引き、頁を送っている途中に書き換えられた行も後ろの頁で降りてくる。
最後まで返せたときの `nextSeq` は `max(seq)` で、頁と同じ batch（1 つの取引）で読む。
行を消すのは、より大きい連番で入れ直す直前だけなので、`max(seq)` は後戻りしない。
版 5 までの変更ログ（Worker の `changes`）、その圧縮、`410`（`changes_floor`）、`seq_high`、`last_pulled_seq` は無くした。
圧縮は、消すものが無い回も 14 日分の変更ログを主キーの範囲で全部読み、量の 2 乗で増えて、D1 の読み取りの無料枠（1 日 500 万行）を超えた（2026-10-16）。
変更ログが無いので刈り込みも要らず、どれだけ古い `since` でも、残っている行をそのまま返す。
`packages/cloud/test/read-budget.test.ts` が、古い行の多い表で、push、pull、`GET /rows`、`GET /devices` の 1 本が読む行（D1 の `meta.rows_read`）を、返した行数と書いた行数に定数を足した分に縛る。
互換の版 9 では、名簿と keybox を世代の数だけ回した表で、読み終えた端末の pull が版 7 と同じ定数に収まることも縛る。
あわせて、`GET /roster` は 2 行、`GET /keyboxes` は PC の数＋1 行、`GET /join/hello` は PC の数＋1 行、承認待ちの問い合わせ（新しい PC の `GET /join/status`、発行した PC の `GET /join-codes/mine`）は 1 回 2 行、1 回の参加（新しい PC 150 回と発行した PC 100 回）は合わせて 500 行に収める。
頁の大きさの上限は、窓関数で合計を数える形を試し、返した行の約 3 倍を読む数え方になったので採らなかった。

**版 5 までの D1 の移行。**
スキーマの用意（`schema.ts` の `ensureSchema`）が、`rows` に `seq` が無いときだけ、1 つの batch で作り直す（`migrateRowsV6`）。
先頭の文で `meta` に印（`rows_v6`）を `on conflict` 無しで入れる。
2 つの isolate が同時に始めると、後の方はこの一意制約で batch ごと落ちるので、握ってもう一度形を確かめる。
続けて、新しい形の `rows_v6` を作り、旧い高水位 H より上から `updated_at` と鍵の順に連番を振って写し、旧い `rows` を消して `rows_v6` を `rows` へ改名し、`changes` を消す。
H は `meta.seq_high` と `changes` の最大の連番の大きい方である。
端末の `since` はどれも H 以下なので、移行の後に 1 回だけ全部の行を取り直し、取りこぼさない。
`rows` が空でも次の行が H より上を受け取るように、H の番兵の行を入れてから消す。
新しい D1 では、最初から新しい形で作る。

**生存の知らせ（同期の版 6）。**
`GET /changes` の応答は、解除していない PC の `peers: [{ id, lastSeenAt }]` と、Worker の時刻 `now` を添える。
端末は「`now` − `lastSeenAt`」を PC の年齢として、他の PC の生存を見る。
2 つの時刻はどちらも Worker の時計なので、端末の時計のずれが入らない。
Worker は、push、pull、本文の PUT のたびに `devices.last_seen_at` を書いていた（1 日に約 3 万行）。
いまは、認証で読んだ行の `last_seen_at` が 1 分（`TOUCH_EVERY_MS`）以内で、IP も変わっていなければ書かない（`seen.ts` の `touchIfDue`）。
端末がそれをどう覚え、ロックと「ふさがっているか」の判定にどう使うかは「他端末セッションのロックと「この PC で再開」」の節に書く。
端末は版 5 まで、`GET /changes` が `410` を返したら写しから作り直していた（`goneFloor`）。Worker が `410` を返さなくなったので、その経路と知らせの文は消した。

無料枠は数えない（段 1、D4）。
Cloudflare の上限による失敗を受けたら、次の UTC の 0 時まで同期を止めてトーストで知らせ、日が変われば自分で戻る（「使用量と費用」の「上限で退く」）。
Free は上限を超えても課金されず、失敗が返るだけである。
Worker も量を数えない（段 1 の PR 6 で台帳を外した）。

トランスクリプトは、jsonl の変化を検知して 30 秒のデバウンスでファイル全体を上げ直し、run の終了で確定する。

削除したセッションは、行ごとの後勝ちに任せない。
削除の印は `session_states.trashed_at` にあり、同期の取り込みは、印のあるセッションの `sessions` を論理削除のまま保つ。
印を受け取る前の持ち主の upsert がクラウドで勝っても、各 PC の取り込みで論理削除に戻り、持ち主が印を処理したときに書く削除がクラウドでも勝つ。
印のあるセッションの本文の写しは降ろさない。詳しくは「セッションの削除」の節にある。

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

セッションの名前（`session_notes`）も、新しい方を採る規則をそのまま使う。同じ時刻なら手元を残す。
版 17 の写し同士（どちらも写しの定数の時刻）だけは、降りてきた側を採る（「セッションの名前」）。
こちらも負けた方を捨てない。
手元の名前に中身があり、降りてきた行でそれが別の中身になる（または消える）とき、上書きの前に手元の名前を `~/.agent-hangar/backups/memos/session-<セッション ID>-<時刻>.md` に残す。
本文は「名前：<名前>」の 1 行である。入れ物は 0700、控えは 0600 である。
降りてきた行が古い版の PC のもので `memo` を持っていても、見るのは名前だけである。
中身が同じとき、手元が空のとき、手元に行が無いときは、控えを作らない。
控えが書けなかったら、その行を適用しない。
置き場と形は、名前とメモが `sessions` の列だった頃と同じである。
その頃は、索引の書き直しが、誰も書き換えていないメモを巻き込んで上書きするたびに控えが取られた。
別の表に分けた今は、控えが取られるのは、別の PC で名前を実際に書き換えたときだけである（「セッションの名前」）。
ノートは 0.4.0 で外したので、いま控えに入るのは名前の 1 行だけである。
2 台が、同期の収束する前に版 17 へ上がり、写した中身が違っていたときも、ここで負けた側が残る。
控えは、取ったときと起動のときに刈る。新しい方から 200 件（`MEMO_BACKUP_KEEP_COUNT`）は日数に依らず残し、それを超えた分のうち 180 日（`MEMO_BACKUP_KEEP_DAYS`）より古いものだけを消す。
分ける前は新しい方から 20 件を残していたが、それだと 1 回の pull で 21 件以上ぶつかったときに、いま取った控えがその場で消える。
日数だけで刈ることもしない。控えは負けた中身の唯一の置き場なので、しばらく使わなかった PC を起こした時点で消えてはならない。
控えが書けずに行を飛ばしたときは、記録に 1 行を出す。同期は止めない。

オフラインのときは `changes` に積んだままにし、復帰時に順に送る。
同期を有効にしていない端末（`cloud.json` が無く、状態が off）も、共有テーブルへの書き込みは `changes` に積む。
後で同期を有効にしたとき、それまでの変更をこの列から送るためである。
ただし off のあいだは送り先が無いので、未送信の件数には数えない（`SyncEngine.status()` の `pending` は 0）。
数えると、入れたての端末が、初回の起動で書くスクラッチのプロジェクトとその置き場と自分の端末の 3 行を「未送信の変更 3」と出してしまう。
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
別々に上がる部品は、1 つの整数 `COMPAT_VERSION`（`packages/shared/src/compat.ts`、はじめは 1、いまは 9。版 3 は、Worker が設定の束の行を受け取る版。版 4 は、設定の同期の旧実装を消した版で、段 4 の PR 18 が Worker の下限を 4 に上げた。版 5 は、Worker が PC の一覧と解除の口を持ち、殻が参加と解除の命令を持つ版。版 6 は、Worker の変更ログをやめ、生存を Worker の観測で見る版で、両方の下限を同時に 6 に上げた。Worker が引き継ぎの頼みと応答の行を受け取るのも版 6 から。版 7 は、Worker がスマホ向けの口（`/m/`）と専用の 3 表を持つ版で、下限は上げない。版 8 は、Worker が呼び鈴と画像の口を持つ版で、下限は上げない。版 9 は E2E の作り直しで、Worker の下限を 9 に上げた）を名乗り、相手に下限を持つ（殻と既存のサーバだけは、下限ではなく一致で比べる）。
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
いまの下限は 6 で、見出しの無い端末（版 0）も、他の PC の生存を heartbeat の行で見る版 5 までの端末も、426 で断る（版の経緯の表）。
段 1 の PR 6 で、同期に参加する端末がすべて版 1 に上がったのを確かめてから上げた。

**端末の下限。**
サーバは、Worker に求める下限 `MIN_WORKER_COMPAT`（`packages/server/src/sync/client.ts`）を持つ。
いまの下限は 9 で、見出しを返さない Worker（版 0）も、行を平文で持つ版 8 までの Worker も断る。
そのため、`/usage` の無い古い Worker の 404 を「トークンなし」に読み替える分岐は持たない。
Worker から 426 が返るか、応答の見出しの版が下限より古ければ、`HttpCloudClient` は `CompatError` を投げる。
応答の見出しで Worker の版を比べるのは、2xx の応答だけである。
Cloudflare の端は、Worker を通さずに 4xx と 5xx を返すことがある（WAF の 403、本文が大きすぎるときの 413、CPU の超過、1 日の要求の上限など）。
それらは見出しを持たず、Worker の版を語らないので、版の不一致にはせず、普通の失敗として扱う。
2xx は Worker を通らないと返らないので、古い Worker はどの経路でも最初の 2xx で見分けられる。
ただし、それでは古い Worker が最初の書き込みを受け取ってしまう（起動して最初の push の未送信の 1 束や、最初に上げる本文）。
そこで同期の client は、書き込み（push と `putFile`）の前に、Worker の版をまだ知らないか、知っている版が下限に届いていなければ、`GET /health` で版を確かめる（`checkWorkerBeforeWrite`）。
`/health` は D1 を読まず、端末の版を問わずに Worker の版を見出しで返す。
届かなければ `CompatError` を投げ、書き込みは出さない。
確かめが他の理由で転んだときも書き込みは出さない（書き込みも同じ理由で転ぶので、要求を 2 倍にしない）。
版を知って下限に届いた後は確かめ直さず、同時の書き込みは 1 回の確かめを分け合う。
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
| 5 | Worker が PC の一覧（`GET /devices`）と解除（`POST /devices/:id/revoke`）を持ち、解除した PC の端末トークンを 401 の `revoked` で断る。殻は参加と解除の命令（`cloud_join_plan`、`cloud_join`、`cloud_revoke`、`cloud_leave`）を持ち、画面がそれを呼ぶ。端末は、Worker の版が 5（`DEVICE_ADMIN_MIN_WORKER_COMPAT`）に届くまで、一覧と解除を「Worker の更新が要る」と出す | 上げない |
| 6 | Worker の変更ログ（`changes`）と圧縮と `410` をやめ、`rows` の連番で差分を引く。pull の応答に `peers` と `now` を添え、端末は他の PC の生存をそれで見て、`runs.heartbeat_at` を共有の行に書かない。Worker は引き継ぎの頼みと応答の行（共有表 `takeovers` と `takeover_answers`）も受け取る | `MIN_DEVICE_COMPAT` と `MIN_WORKER_COMPAT` を同時に 6 に（例外） |
| 7 | Worker がスマホ向けの口（`/m/`）と専用の 3 表（`mobile_feeds`、`launch_requests`、`mobile_pairings`）を持ち、`devices` に列 `kind` を足す。`GET /changes` に `launches` を添える。共有表（`rows`）には何も足さない。PC は Worker の版が 7（`MOBILE_MIN_WORKER_COMPAT`）に届くまでスマホ向けの書き込みも依頼の処理もしない（「スマホ（試験的）」） | 上げない |
| 8 | Worker が呼び鈴（Durable Object `HangarBell`。`GET /m/bell`、`POST /m/ask`）、画像の口（`PUT` と `GET /m/blobs`）、`DELETE /m/feed` を持つ。PC は Worker の版が 8（`MOBILE_BELL_MIN_WORKER_COMPAT`）以上になるまで呼び鈴を張らない（「スマホ（試験的）」） | 上げない |
| 9 | E2E の作り直し。Worker の表を作り直し、行とファイルのメタを PC が封じた BLOB で持つ。参加用の秘密と `POST /join` をやめ、`POST /bootstrap` と参加コードで参加する。名簿と keybox の口、`DELETE /blobs` を足し、`sweepTrash` と `devices` の IP と所在地を無くした（「Worker の表」）。版 8 の呼び鈴と画像の口はそのまま持つ | `MIN_DEVICE_COMPAT` と `MIN_WORKER_COMPAT` を同時に 9 に（作り直しなので混在させない） |

引き継ぎの 2 表は、同期の版 6 と一緒に 0.7.1 で出すので、別の版を立てずに版 6 に含めた。
端末は Worker の版が `TAKEOVER_MIN_WORKER_COMPAT`（6）に届くまでこの 2 表の行を書かないが、`MIN_WORKER_COMPAT` は 9 なので、話せる Worker ではいつも届いている。
古い PC には頼みが届かず、頼んだ側は 90 秒の打ち切りの経路に落ちる（「他端末セッションのロックと『この PC で再開』」）。
版 5 までの Worker は、2 表の行を含む push を 400 で丸ごと断るので、端末は Worker の版が 6 に届くまで行を書かない。
版 2 で下限を両方とも上げたのは、版 1 と版 2 が混ざると名前とメモが消えるからである。
版 1 の端末は `session_notes` を知らない表として捨て、名前とメモを `sessions` の payload に載せる。版 2 の端末はその 2 つの列を知らない列として捨てる。
版 1 の Worker は、共有テーブルの一覧に `session_notes` を持たず、その行を含む push を丸ごと断る。
Worker の D1 のスキーマは変わらない（表名と行 ID と payload を文字列で預かるだけである）。変わるのは、受け付ける表名の一覧（shared の `SHARED_TABLES` を束ねたもの）と下限の定数だけである。
入れる順は、上の決まりのとおり、Worker を先に配備し、それから端末を入れ替える。
Worker を配備した時点で、まだ上げていない端末（版 1）は 426 で断られ、上げるよう理由が出て同期が止まる。上げれば、止まっていた間の差分から続く。

版 6 は、上の「いつ上げるか」の順（Worker の下限は全端末が上がってから、端末の下限は Worker を先に配備してから）に従わない例外である。
両方の下限を同時に 6 へ上げ、Worker の配備と全端末の入れ替えを一斉に行う。
混在を許さないのは、版 5 の端末が他の PC の生存を `runs.heartbeat_at` で見るからである。
版 6 の端末は heartbeat を共有の行に書かないので、版 5 の端末から見ると 2 分で「応答がありません」になり、ロックが外れて二重に起動しうる。
版 5 の Worker は `peers` を返さず、版 6 の端末は他の PC の生存を読めない。
Worker だけを版 5 へ巻き戻すことはしない。移行で `changes` を消し、`rows` の形も変えるので、直す方向にだけ進める。
切り替えの間に版 5 の端末は 426 で止まり、hangar を更新すれば、移行の後の 1 回の全件の取り直しから続く。

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
lsof の無い Windows では添えない。
殻はポートと 2 つの版の数だけを渡し（`BootFailure::compat_mismatch`）、文は頁の表（`loading/boot-fail.js`）が作る。
殻はそのサーバを止めない。
利用者が自分で起こしたもの（`hangar start` や `npm run dev`）かもしれず、ポートの番号だけを頼りに止めないためである。
hangar でない相手（状態コードが 200 で、`ok` が真で `version` が文字列の応答でないもの）は、版を問わずに「居ない」とし、これまでどおり同梱のサーバを起こしにいく。
殻が採るのは同じ版のサーバだけなので、`/health` の `ready` を持たない古いサーバを済んだものとみなす分岐は持たない。
`ready` が真偽値でない応答は起動の進み具合として読まず、応答の無いサーバとして扱う。

### PC の一覧と解除

0.4.0 で、同期に参加している PC の一覧と、ほかの PC の解除と、この PC の参加の解除と、アプリからの参加を入れた（試作は settings-040-proto の推す組み合わせ、決定は 2026-10-12）。
語は、解除、この PC の参加を解除、解除した PC、宛先、ホスト、PC である（用語集の 5 章）。

**Worker。**
`devices` は `revoked_at` を持つ（互換の版 9 の表は「Worker の表」）。
`GET /devices` は全部の行（解除した PC も）を、ID、種類、参加日、最終同期、解除日、トークンの期限だけで返す。端末トークンのハッシュと読み位置は返さない。
名前と OS は封じた名簿にあり、Worker は返せない。
`POST /devices/:id/revoke` は行を消さずに `revoked_at` を付ける。既に解除した PC はそのまま返し、解除日を動かさない。知らない PC は 404、形の違う ID は 400 である。
どちらも端末トークンが要り、参加している PC ならどれからでも呼べる（自分自身も解除できる）。
`authMiddleware` は、トークンの合った行に `revoked_at` があれば 401 と `{ error: 'revoked' }` を返す。
トークンが合わない相手には今までどおり一律の `unauthorized` を返すので、理由はトークンの持ち主にだけ伝わる。
互換の版 9 には参加し直しの口（`POST /join`）が無く、解除した PC は参加コードで再参加する。端末 ID は同じままで、承認の後に解除済みの行が新しい端末トークンの行に置き換わる（「互換の版 9 の Worker」の段）。
解除した PC は、pull の応答の `peers` に載せない。

**IP と所在地は保存しない。**
版 8 までの Worker は、参加と同期の要求で `CF-Connecting-IP` と `request.cf` の所在地を `devices` の `last_ip`、`last_city`、`last_region`、`last_country` に書いていた。
互換の版 9 は、この 4 列を作らず、保存も表示もしない。
最終同期の時刻だけを、前回から 1 分たったときに書く（`seen.ts` の `touchIfDue`）。

**解除と暗号鍵の再生成（互換の版 9、PR 6）。**
PC の解除は、動いているサーバーが行う（`sync/rotate.ts` の `revokeMember`、経路は `POST /api/sync/cloud-devices/:id/revoke`）。
世代鍵と回しの記録（`sync_state` の `rotation`）がサーバーにあるので、画面からの解除（殻の `cloud_revoke` から CLI）も、`hangar cloud revoke` も、このサーバーの経路を呼ぶ。
サーバーが止まっていれば、CLI はスマホだけを Worker で直に解除し（スマホは端末トークンを無効にするだけである）、PC は `server-down` で断って hangar の起動を促す。
自分自身は `self`（409）、知らない端末は `not-found`（404）、解除済みは `revoked`（409）、Worker に繋がらなければ `unreachable`（502）で返す。
PC の解除は、次の段で進む。
1. `rotation` に `{ id, newEpoch, step }` を書く。
2. `POST /devices/:id/revoke` で、その PC の端末トークンを無効にする。
3. 新しい世代鍵を作り、Keyring と cloud.json に足す。今の世代はまだ進めない。
4. 名簿からその PC を外し、同じ書き換えで新しい世代の番号を確保する（名簿の `epochClaim`）。
5. 残りの PC とリカバリーキーに、世代 1 から n＋1 の全部を封じた keybox を置く（`PUT /keyboxes`）。
6. 以後の書き込みを新しい世代にし、名簿を新しい世代で封じ直す。5 の段の後で名簿に足された PC がいれば、その PC にも keybox を置く。
7. `rotation` を消す。

各段の終わりに `rotation` の段を進める。
解除の要求を受けたとき、別の PC の回しの記録が残っていれば、先にそれを終わらせてから要求の PC に進む（`sync/rotate.ts` の `revokePc`）。
アプリが途中で落ちたら、次の起動で `resumeRotation` が記録の段から続け、失敗したら 5 分後に試し直す。
新しい世代鍵は 3 の段で cloud.json に書いたものを使う（作り直すと、配った鍵と食い違う）。
新しい世代で書くのは 5 の段が済んでからである。配る前に新しい世代で封じた行は、この PC のほかに誰も開けないからである。
記録には今のクラウドの `cloudId` も持たせ、クラウドを作り直した後に残った記録は捨てる。
動いている間の解除が途中で失敗して記録が残ったときも、起動のときと同じく 5 分おきに続きを試す（`rotationRetrier`）。
この PC が解除されていたとき（`RevokedError`）は試し直さない。

世代の番号は、4 の段の名簿の条件付き更新で確保する（`epochClaim` の `{ epoch, by }`）。
2 台が同時に別の PC を解除しても、同じ番号は取れない。
409 で当て直すときに他の PC が自分の番号以上を確保していれば、その次の番号に付け替え、3 の段の鍵をその番号で持ち直す（鍵の中身は番号に依らない）。
付け替えたときは、越えた世代の鍵を自分宛ての keybox で受け取るまで、5 の段に進まずに待つ。
`GET /keyboxes` は受け手ごとにいちばん新しい箱だけを返すので、後の世代の箱に前の世代の鍵が入っていないと、前の世代の行を開けない PC が残るからである。
待っても来なければ、その世代を確保した PC が解除されているか Worker にいないときだけ待つのをやめて配り、ほかは記録を残して失敗にする（続きは 5 分おきの試し直しが拾う）。
確保した PC が解除済みで待つのをやめて配るとき、箱には越えた世代 n の鍵が入らない。
これは、確保した PC が 6 の段（切り替え）の前に倒れているので、n で封じた行は存在しない、という前提で成り立つ。
回しかけの記録を持つ PC から、その世代を確保した PC を解除するときは、相手の端末トークンの無効化を先に済ませてから、記録の続きを再開する。
6 の段では今の世代を戻さない。他の PC のより新しい世代を受け取っていれば、そちらで書き続ける（その箱には、この世代の鍵も入っている）。
確保を入れる前の名簿で回した PC と重なったときの備えとして、5 の段の前に自分宛ての keybox も読み、同じ番号の世代が別の鍵で配られていれば、その鍵を受け入れて次の番号で回し直す。

参加の承認と重なったときに、新しい PC が新しい世代の鍵を受け取れないことがないようにする。
回す側は、5 の段で名簿を Worker から読み直し、6 の段の名簿の書き換えが返す最新の名簿と 5 の段で置いた受け手を見比べ、増えた PC にも同じ世代の箱を置く。
承認する側は、新しい PC に置く箱の中身を今の世代以下に限る（回しの途中の、まだ配っていない鍵を渡さない）。
名簿に足す前と、箱を置く前と、置いた後に自分宛ての keybox を読み直し、置いた後に今の世代が進んでいれば、その世代の箱を置き直す。
名簿にいて Worker の端末にまだいない PC は、承認の途中（端末トークンをまだ受け取っていない）とみなし、keybox を断られても捨てずに 2 秒おきに 5 回（10 秒ほど）試し直す。
それでも置けなければ記録を残して失敗にする。
ただし名簿に入ってから 15 分（参加コードの期限の 3 倍）を過ぎてもいない PC は、承認の途中で止まった名残として飛ばす。
Worker は承認の後も期限から 5 分しか keybox の受け手にしないので、それより古い項目はもう端末にならず、飛ばさないと名残 1 つで回しが 5 の段で止まり続けるからである。

残る危うさがある。
越えた世代を確保した PC が、配る前に壊れて戻らず、解除もされないと、後から回す PC は 5 の段の前で止まり、5 分おきに試し直し続ける。
その PC を解除すれば進む。

画面は、解除の要求が返るまで行の下に「暗号鍵を再生成し、残りの PC に配布しています」を出す。途中で失敗したら、PC の表の下に理由と「もう一度試す」を出し、押すと記録の段から続ける。
この帯は行に結び付けない。端末トークンを無効にした後で失敗し、一覧を取り直すと、行は「解除した PC」へ移るからである。
帯には、暗号鍵の配布が終わっていないことと、この PC が自動で再試行することを添える。
帯の「もう一度試す」を押したときに行がもう「解除した PC」へ移っていれば、配布している旨の 1 行も帯と同じ表の下に出す。

**解除した PC の本文と設定。**
解除した PC が上げた写し（R2 の `b/<解除した PC の端末 ID>/`）、D1 の `files` の索引、その PC が書いた `rows` は消さない（既定は残す）。
その PC のセッションの記録で、残りの PC と新しく参加した PC は過去の世代の鍵で読める。解除した PC は過去の世代の鍵を持つが、端末トークンが無効なので Worker から取れない。
Worker は自分の端末 ID の下しか消させないので、解除した PC の写しは誰も消さず、ゴミ箱の 30 日の掃除もその PC の分には効かない（R2 の保存量として残る）。
R2 の既存のファイルは、世代を回しても上げ直さない（再暗号化しない）。
生きているセッションの古い世代の写しは、書き直されたときだけ消す。新しい世代の鍵名で上げた直後に、その本文の古い世代の鍵名を `DELETE /blobs` で消し、1 時間の猶予で断られたものは 6 時間ごとの掃除（`sweepSupersededBlobs`）で拾う。書き直されない本文は古い鍵名のまま残す。
理由は 3 つある。
ほかの PC はその PC のセッションを一覧と検索で見ており、「この PC で再開」も R2 の本文を降ろすので、消すと履歴が欠ける。
解除は参加し直せば戻る操作なので、取り返しの付かない削除を混ぜない。
R2 の無料枠（10GB）に対して、1 台分の本文は数百 MB で、残しても困らない。
消すなら、解除とは別の操作として、「解除した PC」の行に「トランスクリプトを削除…」を置き、件数と大きさを見せる確認つきにするのがよい（未実装。Worker に PC ごとの削除の口と、消したことを相手へ伝える印が要る）。

**この PC の側。**
サーバの同期の client は、401 の `revoked` を `RevokedError` にする。
`SyncEngine` はそれを受けたら、版で止まったときと同じく同期を止め、状態を `error` にして、`SyncStatusDto` に `revoked: true` を載せる（本文と設定の出し入れと使用量も `syncHalted` の `revoked` で止まる）。
止めた印は `sync_state` に残さず、立て直せば最初の要求でまた断られて立つ。参加し直した後なら立たない。利用者の「今すぐ同期」でも 1 度だけ試し直す。
解除で止まったときは、サーバのログ（殻の desktop.log）に `[sync]` の 1 行を残し、止まっている間は重ねない。参加し直して同期が通ったら、戻った旨を 1 行残す。
どちらも端末 ID は頭の 8 字だけを書き、トークンと秘密は書かない。
参加し直すとアプリが再起動するので、ログに残したことを `sync_state` の `revokedLogged` に覚え、立て直した後の最初の同期でも戻った旨を残せるようにする（止める印ではない）。
設定の節は、Worker の一覧をサーバの `GET /api/sync/cloud-devices`（`sync/devices.ts` の `loadCloudDevices`）から取る。
並びと、参加日、最終同期、解除日、トークンの期限は Worker の `devices` から取り、名前と OS は封じた名簿（`RosterStore.read`）から ID で突き合わせる。
Worker にあって名簿に無い端末は、名前と OS が null の「名前のわからない端末」として出す。
名簿にあって Worker に無い端末は出さない。
名簿が読めないときは、一覧を名前なしで出す。
Worker が名乗った版が 5 に届かないか、経路が 404 なら `outdated`、解除されていれば `revoked`、繋がらなければ `unreachable` を返し、画面は同期の表の一覧に戻す。
`creator` は cloud.json に Worker の名前があるか（この PC がクラウドを作った PC か）である。

**参加と解除の通り道（D9）。**
参加コードは、承認されればこのクラウドに PC を足せる値なので、サーバの HTTP API に載せない。
画面は殻の命令（`apps/desktop/src-tauri/src/cloudmember.rs`、権限は `capabilities/remote-cloud.json`）に渡し、殻は同梱の CLI を `--json` で走らせて、最後の 1 行の JSON を返す。
参加コードは CLI の引数に載せず、標準入力で渡す。殻のログにも失敗の文にも載せない（ログに残すのは命令の頭の 2 語と結果の符号だけ）。
殻は頁から来た値の形を確かめ、命令を重ねて走らせない（走っている間の呼び出しは `busy` で返る）。
接続先の URL は `https://` で始まり、空白と制御文字を含まず 512 字まで。
参加コードは ASCII の英数字と `-` と空白だけで 36 字まで。全角で貼られたコードは、画面が送る前に共有の `normalizeJoinCode` で半角にそろえる。字の並びの検査は CLI が行う。
端末 ID は `isSafeKeyId` と同じ形。
宛先の確認と上書きの承諾は画面の段で済ませるので、殻はネイティブの確認を出さない。
参加の 3 つの命令は、どれも Worker への短い問い合わせで返る。承認を待つ間に `cloud_join_poll` を呼ぶ間隔は画面が決める。
命令は 5 つで、CLI の呼び方は次のとおりである。

| 殻の命令 | CLI | 返す JSON |
| --- | --- | --- |
| `cloud_join_check(url)` | `hangar cloud join-check <url> --json` | `{ ok, check: { url, host, pcCount, current } }` |
| `cloud_join_request(url, code, overwrite?)` | `hangar cloud join-request <url> --json [--overwrite]`（参加コードは標準入力） | `{ ok, request: { sas, expiresAt } }` |
| `cloud_join_poll()` | `hangar cloud join-poll --json` | `{ ok, poll: { status } }` |
| `cloud_revoke(id)` | `hangar cloud revoke <id> --yes --json` | `{ ok, result: <PC の行> }` |
| `cloud_leave(revoke)` | `hangar cloud leave --yes --json [--keep-device]` | `{ ok, result: { revoked, revokeError, creator } }` |

失敗は `{ ok: false, code, message }` で、画面は `code` で言い方を選ぶ（CLI の文は日本語なので、`message` は理由の添え書きにだけ使う）。
殻が自分で返す符号は、形の違う値の `invalid-url`、`invalid-code`、`invalid-id`、重ねた呼び出しの `busy`、CLI を起こせない `cannot-start`、締め切りの `timeout`、読めない返事の `unreadable` である。
`overwrite` は省けば偽で、参加済み（版 2 か版 1 の cloud.json がある）なら CLI が `overwrite-required` で断る。
`hangar cloud revoke` は自分自身を `self` で断り、`hangar cloud leave` へ案内する（cloud.json を残したまま自分の鍵だけを無効にすると、同期が止まったままになる）。
`hangar cloud revoke` は Worker を直に呼ばず、動いているサーバーの経路（`--port`、既定 4177）を呼ぶ（上の「解除と暗号鍵の再生成」）。
`hangar cloud leave` は、選べば先にクラウドでもこの PC を解除し、繋がらなくても cloud.json を消して、解除できなかった理由を返す。壊れた cloud.json は消さない。
消すのは cloud.json だけで、`~/.agent-hangar/remote` の受信済みのトランスクリプトと、クラウドを作った PC の `~/.agent-hangar/cloud/wrangler.jsonc` は残す。
サーバは動いている同期の cloud.json の削除や書き換えを拾わないので、参加とこの PC の参加の解除の後は、画面がアプリの再起動（`restart_app`）を頼む。
殻が採った既存のサーバ（`npm run dev` など）は、殻の再起動では立て直らないので、そのサーバを手で立て直す。
ブラウザには殻が無いので、画面はコマンド（`hangar join`、`hangar cloud revoke <ID>`、`hangar cloud leave`、ID を出す `hangar cloud devices`）を案内する。

### 他端末セッションのロックと「この PC で再開」

他端末のセッションは、閲覧と検索は常にできる。
「この PC で再開」は明示操作で、その端末の最新の本文を `~/.claude/projects/<変換名>/<sessionId>.jsonl` にコピーしてから `claude -r` を実行する。

他端末に生きた run（`ended_at` が null で `deleted_at` が null）があるセッションは、**相手の生死にかかわらず**ロックされているとみなす（`db/queries.ts` の `lockMap`）。
相手の生死は、その run の PC を Worker が最後に見た時刻で決める（同期の版 6）。
pull の応答は、解除していない PC の `peers: [{ id, lastSeenAt }]` と Worker の時刻 `now` を添える（「メタデータの同期」の「生存の知らせ」）。
端末は「`now` − `lastSeenAt`」をその PC の年齢として、受け取った時刻（この PC の時計）から引き、この PC の時計の時刻に置き直して `sync_state` の `peers` に持つ（`sync/peers.ts`）。
共有の `changes` には積まない。
2 つの Worker の時刻の差だけを使うので、PC どうしの時計のずれが入らない。
年齢が 3 分（`PEER_STALE_MS`）を超えた PC、`peers` に居ない PC（解除した PC）、Worker がまだ見ていない PC（`lastSeenAt` が null）は、ロックを解かずに `stale` の印を立てる。
3 分は、Worker が最終確認を 1 分おきにしか書かず、端末が 30 秒ごとに pull するので、生きている PC の年齢が 2 分ほどまで伸びることから取った。
ただし、この PC がまだ一度も `peers` を受け取っていないときと、最後に受け取ってから 90 秒（`PEERS_FRESH_MS`）を過ぎたときは、相手の生死は分からないとして `stale` にしない（ふさいでいる側に倒す）。
起動直後の最初の pull までや、版や上限や回線でこの PC の同期が止まっている間は、手元の覚えが古く、生きている PC の会話を頼まずに引き継げてしまうからである。
90 秒は、pull が 30 秒ごと、一時停止中の生存の知らせが 1 分ごとなので、同期が通っていれば収まる幅として取った。
古いだけでロックを解いてしまうと、相手がまだ走っているのに手元から再開できてしまうからである。
UI は `stale` でないとき「<端末名> で実行中」、`stale` のとき「<端末名> が応答がありません」と表示する。
`SessionLockDto.heartbeatAt` は、版 6 からその PC の最終接続（この PC の時計）で、知らなければ run の行の `heartbeat_at`（起動か生き返った時刻）である。名前は変えていない。
ロックされている間は再開とフォークを止める。
「この PC で再開」は、ロックがあっても押せる。
生きているロックでは、相手の claude に停止を頼み、その最後の本文が降りてから引き継ぐ（後述の「停止を頼んで引き継ぐ」）。
`stale` のときは、頼まずにそのまま引き継げる。
相手が落ちて run の行だけが残った状態を、行き止まりにしないためである。
再開、フォーク、引き取り、`claude attach`、生き返り、端末からの `claude -r`、消す前の確かめが「ふさがっているか」を見る `aliveRunForSession`（`runs/queries.ts`）と `sessionRunsAnywhere`（`runs/announce.ts`）も同じ判定で、`stale` な PC の run ではふさがっているとみなさない。自分の PC の run は今までどおりふさぐ。
`peers` を覚えるたびに、他の PC の生きた run を持つセッションのうち、その PC の生死が変わったものと、最終接続が進んだものを画面へ配り直す（`touchRow`）。
生死が時間だけで変わる（最終接続が進まないまま 3 分を過ぎる）ときも、次の pull（30 秒ごと、一時停止中は 1 分ごと）で拾う。
同期を一時停止していても、1 分に 1 回は Worker へ生存だけを知らせる（`SyncEngine.pingAlive`）。専用の口は持たず、`GET /changes?since=<末尾より先>&limit=1` で済ませ、応答の行は当てず区切りも進めない。
版で止まっているとき、解除されたとき、上限で退いているときは送らない。そのあいだ他の PC からは、この PC の run が 3 分で「応答がありません」になる。
版 5 までは、生きた run の `heartbeat_at` を 30 秒ごとに共有の行へ書き直し、2 分（`LOCK_STALE_MS`）で `stale` にしていた。その書き直しが、端末の送る変更の 6 割を占めていた（2026-10-16）。
見回りの `heartbeat_at` の書き直しは、いまは手元だけで、この PC の画面へも配らない（`run.upsert` を出さない）。
ほかの PC の run が作業中か入力待ちかは、共有の行に載せない。
そのため確認の 1 枚は、作業中かどうかで出し分けず、1 本の帯で「停止すると、作業中のターンは途中で切れます」と伝える。

「この PC で再開」は、本文を写す前に、この PC で起こせるか（再開の cwd の読み替えが決まるか）を確かめる（`RunManager.resumeCwdOf`）。決まらなければ写さずに断る。写してから再開で断ると、`~/.claude` に本文だけが残るためである。
確認の 1 枚に出すもの（前の PC の名前と OS と cwd と最後に使った日時、この PC の名前と OS と読み替えた cwd）は `GET /api/sessions/:id/resume-here`（`ResumeHerePlanDto`）で返す。この PC で場所が決まらなければ、この PC のパスは null である。ほかの PC のクイックセッションで、この PC の置き場にフォルダを作って再開するときは `createsFolder` が真である（「スクラッチと昇格」）。

画面（0.6.1、試作 proto-crossdevice の推す案）：

- 「この PC で再開」を押すと、確認に出すものを取りに行き（`session.resumeHere.open`、`api.resumeHerePlan`）、確認の 1 枚を毎回出す（`ConfirmRequest` の `resumeHere`、`views/ConfirmDialog.tsx`）。前の PC とこの PC の 2 枚のカード（名前、OS、作業フォルダ）を矢印でつなぎ、前の PC には最後に使った日時を添える。ブランチは出さない。下に黄の帯で「プロジェクトのファイル、未コミットの変更、開発環境（道具、環境変数、秘密の値）は同期されません。」「同期されるのは会話のトランスクリプトと hangar の記録だけです。」を出す。ボタンは「この PC で再開」で、承諾で `session.resumeHere` を送る。手元の本文の方が小さいときの上書きの確認は、その後に今までどおり出る。
- この PC にプロジェクトのフォルダが無い（`ProjectDto.unresolved` がある）ほかの PC の会話は、「この PC で再開」を押せなくする（`presenters/resumeHere.ts` の `resumeHereOf`）。
  セッション画面では見出しの下に理由「この PC にこのプロジェクトのフォルダがありません。先に場所を指定してください。」を常に 1 行出し、同じ行に「場所を指定」（`project.resolve.open`）を置く。
  一覧の行の「⋯」（セッションのメニュー）では、ほかの PC の会話にだけ先頭に「この PC で再開」を置き、押せないときは理由を項目の下に出す。
  ほかの PC で実行中（生きたロック）でも、この理由で止めるのは同じである。
  プロジェクトに属さない会話とスクラッチは、場所では止めない。
- この流れの文の「他の PC」は「ほかの PC」にそろえた。OS は `devices.platform` を辞書（`common.os.*`）で macOS、Windows、Linux にする（shared の `osName`）。

「この PC で再開」は、手元に同じセッションの本文があり、それが降ろす本文より**小さいときだけ**確認を出す。
承諾したら、上書きの前に `~/.agent-hangar/backups/transcripts/<sessionId>-<時刻>.jsonl` へ控えを取る。
控えが取れなければ `~/.claude` を触らずに戻る。
手元の方が大きいか同じときは、黙って上書きしない。

**A → B → A と戻ったとき（0.6.1）。**
この PC で始めた会話をほかの PC で進めて戻ると、手元には古い本文が残っている。
素の「再開」はその古い本文で起きるので、次のようにした。

- 最後の run がほかの PC のもので、手元に降ろしたその PC の主線の写しが手元の主線より大きいとき、`SessionDto.newerElsewhere` を真にする（`db/queries.ts`）。大きさだけで決め、本文は読まない。
- 真のときは、手元に本文があっても「この PC で再開」を主にする（見出しと一覧の行の「⋯」、`presenters/resumeHere.ts` と `presenters/session.ts`）。素の再開は「この PC のトランスクリプトのまま再開」と名前を替え、注記を添えて「…」に残す。
- 確認の 1 枚を出すときに、手元と写しの本文を読み比べる（`sync/copy.ts` の `compareForResume`、`ResumeHerePlanDto.replace`）。手元が写しの先頭部分なら `ahead`、そうでなければ `diverged`（この PC でも別の続きを進めた）である。どちらも同じ 1 枚に、控えに残して置き換えることを 1 行で言い、承諾を上書きつきで送る。上書きの確認をもう 1 枚は出さない。
- 前の PC の作業ディレクトリ（確認の 1 枚の前の PC のパスと、引き継ぎの段の `prevPath`）は、会話を作った PC の `sessions.cwd` ではなく、前の PC の最後の run から取る（`runs/handover.ts` の `prevPathOf`）。`runs` は cwd を持たないので、その PC から降ろした写しの末尾の cwd を使い、その PC の `project_roots` の場所の下にあるときだけ採る。採れなければ、前の PC が会話を作った PC なら `sessions.cwd`、そうでなければその PC の `project_roots` の場所にする。
- 再開に使うアカウントは、この PC の run だけから引く（`RunAccounts.accountFor`、`accountOfSession` と `sessionAccounts` の `deviceId`）。アカウントの id と名前は PC ごとの設定なので、ほかの PC の run のアカウントは引かない。この PC に run が無ければ、この PC でいま選んでいるアカウントにする。

**停止を頼んで引き継ぐ（2026-10-16）。**
2026-09-19 の判断では、ロックの表示と「この PC で再開」までに絞り、引き継ぎは作らなかった。
段 1（2026-10-07）で、型、UiAction、ServerEvent を消し、`takeover_requests` を共有テーブルの一覧からも外した（表は v1 のマイグレーションに残り、誰も書かない）。
その形では、他端末の run がこちらの操作では止まらず、同じセッションの本文が 2 か所で伸びた。
そこで、頼まずに奪うのではなく、相手の claude に停止を頼み、その最後の本文が降りてから引き継ぐ形で入れた。
握手は新しい 2 つの共有表（上の `takeovers` と `takeover_answers`、版 28）で運ぶ。
`takeover_requests` は使わない。
`EndReason` には `taken_over` を足した。

- **書き手は 1 台ずつ。**
  `takeovers` は頼む側の PC だけが書き（取り下げと `force` への切り替えも同じ行の書き直し）、`takeover_answers` は頼まれた側の PC だけが書く。
  行が別なので、頼む側の取り下げと相手の応答が行き違っても消し合わない。
  応答の主キーは頼みの id である。
  行は書いた PC が、`updated_at` が 30 日（`TAKEOVER_ROW_TTL_MS`）より古くなったら論理削除する。
  ほかの PC が書いた行は触らない。
  刈るのはサーバの起動のときである（`pruneTakeoverRows`）。
- **頼む側（`sync/takeover.ts` の `TakeoverService`）。**
  待ちの状態は会話ごとにメモリだけに持ち、サーバを立て直せば消える。
  だからサーバの起動のときに、この PC が出したまま答えの無い `ask` の行を取り下げて送る（`cancelOrphanAsks`）。
  残すと、待つ者が居ないのに、相手が後から頼みを見て claude を停止するためである。
  `force` の行は残す（相手の次の起動で止める約束である）。
  段は `TakeoverStage`（`asking`、`waiting`、`receiving`、`ready`、`timeout`、`cancelled`）で、`takeover.update`（`TakeoverDto`：`sessionId`、`deviceName`、`stage`、`startedAt`、`deadline`）として画面へ配る。
  経路は `POST /api/sessions/:id/takeover`（本文の `force`）、`GET` 同、`POST /api/sessions/:id/takeover/extend`、`DELETE /api/sessions/:id/takeover`（取り下げ）である。
  - `POST /api/sessions/:id/takeover` は、この PC でセッションを起こせない（tmux や psmux、claude が無い）とき、頼みを書かずに起動と同じ理由で断る（`RunManager.assertCanStart`、400）。
    頼むと相手の claude は停止するのに、この PC で再開できないためである。
  - 始め方。
    ロックが無ければ行を書かずに `ready`。
    `stale` か `force` なら `force` の頼みを書いて送り、`ready`。
    生きたロックでは `ask` を書いて送り（`asking`）、送り終えたら `waiting` に進む。
  - 頼みを運べるか（`canCarryTakeover`）は、同期が設定済みで、一時停止でも、版、解除、上限で止まってもおらず、Worker の版が 6（`TAKEOVER_MIN_WORKER_COMPAT`）に届いているときである。
    運べないときは行を書かない。
    書くと、版 5 までの Worker は push 全体を 400 で断り、ほかの表の同期まで止まるためである。
  - 運べないとき、生きたロックでは 90 秒を待たずにすぐ `timeout` にする。
    運べないまま `force` で進めた分は行が書けないので、`TakeoverService` が `forcedWithoutRow` のメモリの印（会話と run の組）で `POST /resume-here` を通す。
    サーバの再起動で消え、もう一度押せば立つ。
  - 待つ間は 5 秒ごと（`TAKEOVER_POLL_MS`）に、行と本文の写しを 1 回ずつ取りに行く。
    ふだんの pull の周期（30 秒）は変えない。
    応答や台帳の行が届いたときも確かめ直す。
  - 応答の版と台帳の突き合わせ。
    応答に `transcript_sha256` が無ければ（相手に上げた本文が無い）そのまま `ready`。
    あれば、手元の `file_sync` の台帳（`transcripts/<相手>/<uuid>.jsonl.gz`）の sha256 と大きさが応答と同じになるまで `receiving` のまま待つ。
    応答が届いても本文が降りきる前に再開すると、古い本文のまま起こしてしまうためである。
  - 打ち切りは 90 秒（`TAKEOVER_TIMEOUT_MS`）で、`timeout` にする。
    「もう少し待つ」（`extend`）は、いまから同じ長さを足して待ち直す。
    取り下げ（`cancel`）は頼みに `cancelled_at` を書いて送り、状態を捨てて `cancelled` を 1 度配る。
    取り下げた後に届いた応答は、状態が無いので何も起こさない。
- **頼まれた側（`sync/takeoverResponder.ts` の `TakeoverResponder`）。**
  頼みの行が pull で届くと、この PC あてで、取り下げも応答もされていないものを古い順に扱う（`asksForMe`）。
  重なった呼び出しは 1 本にまとめ、同じ頼みを並行して 2 度扱わない。
  - 頼みの run がこの PC の生きた run なら、止める直前に、その run の端末に接続中の画面があれば 1 行を流し（`sync.takeover.paneNote`、「[hangar] <端末名> に引き継がれたため、この PC の claude を停止しました。」）、`kill(runId, 'taken_over')` で止める。
  - claude は終わる直前まで本文に書き足すので、本文を上げ、5 秒（`FLUSH_AGAIN_MS`）置いてもう 1 度上げる（run が終わったときの上げ方と同じ）。
  - そのあと、手元の本文のファイルの版（平文の sha256 と大きさ、台帳と同じ形）を載せて応答（`stopped`）を書き、すぐ送る。
    台帳ではなくファイルから作るのは、上げ損ねても本文を上げる処理は黙って戻るからである。
    台帳の古い版で答えると、頼んだ側は最後のターンの欠けた本文で再開する。
    ファイルの版なら、頼んだ側は台帳が追いつくまで `receiving` で待ち、追いつかなければ返事がないに落ちて、利用者が選べる。
    手元にファイルが無いときは台帳の版（それも無ければ null）を載せる。
    動いていなかったときは `not_running` で答える。
    止められなかった頼みは答えずに残し、次の走査で、動いていなければ `not_running` になる。
  - サーバの起動のときにも 1 度走査する。
    Hangar が止まっていた間に届いた頼みと、再起動のあとも tmux に残っている奪われた claude を、ここで止める。
- **`POST /api/sessions/:id/resume-here` の見直し。**
  生きたロックのある会話は、頼まずには引き継げない。
  `resumeHereAllowed` が通すのは、ロックが無い、ロックが `stale`、またはこの PC が書いた取り下げていない頼みがロックの run を指し、`force` であるか、応答があって本文の版が台帳に降りきっているとき、である。
  通らず、`forcedWithoutRow` の印も無ければ、409 と `{ error, code: 'locked' }`（`TakeoverLockedDto`、文は `sync.takeover.locked`、「<端末名> で実行中です。先に停止して引き継いでください。」）を返す。
- **引き継がれた側の表示。**
  引き継がれた会話の画面は、見出しの下に灰色の 1 行を出す（D1、`SessionDto.takenOver`、`session.takenOver.line`、「<端末名> に引き継がれました（<日時>）。現在は <端末名> で実行中です。」）。
  この PC の最後の run が `taken_over` で終わっているときだけ値を持ち、この PC で後から run を起こせば消える。
  端末名は、その run を指す頼みの `from_device`、無ければその後に始まったほかの PC の run の PC である。
  知らせの札は出さない（自分で引き継いだ操作の裏側なので）。
  もう 1 つは、止める直前に開いている端末へ流す 1 行（上の `paneNote`）で、端末を開いていないと見えない。
- **古い PC。**
  引き継ぎの 2 表は互換の版 6 に含めたので、2 表を知らない版 5 までの PC は、Worker の下限（6）で断られて同期に加わらない。
  相手の Hangar が止まっているなど、頼みが届かないときは、頼んだ側は 90 秒で打ち切る経路に落ち、返事がないことを伝えるだけである。
- **会話が分かれる場合。**
  返事がないまま「このまま引き継ぐ」を選ぶと、相手の claude がまだ動いていて、そちらで書かれた続きがこの PC の会話に入らないことがある。
  その claude は、次に相手の Hangar が起動したとき、頼みの行を見て停止する。
  この枝分かれは受け入れる。

画面（試作の A1、B1、C2、D1。文言は `confirm.takeover.*` と `session.takenOver.line` から写した）：

- **A1：確認の 1 枚。**
  ロックがあるときの「この PC で再開」の確認は、ロックの状態で変わる（`ResumeHerePlanDto.lock`、`presentResumeHere`）。
  生きていれば、題は「ほかの PC で実行中の会話を、この PC で引き継ぎますか」、ボタンは「停止して引き継ぐ」で、赤みの帯に「<端末名> で実行中です」と「停止すると、作業中のターンは途中で切れます。そのあと、この PC で再開します。」を出す。
  帯は 1 本だけで、相手が作業中か入力待ちかアイドルかで出し分けない。
  同期の版 6 で heartbeat を共有しなくなり、相手の run の状態を運ぶ行が無いためである（はじめは `runs.live_status` で作業中の帯を分けたが、版 6 に合わせて外した）。
  `stale` なら、題は「<端末名> が応答していません。この PC で引き継ぎますか」、前の PC の行に「最後の応答：<相対時刻>」、ボタンは「このまま引き継ぐ」で、頼まずに `force` で送る。
  ロックが無ければ今までどおりの確認である。
- **B1：進み具合。**
  承諾すると、同じ 1 枚が進み具合に変わる（題は「<端末名> から引き継いでいます」）。
  段は「停止を依頼しました」「<端末名> が停止するのを待っています」「最後のトランスクリプトを受け取る」「この PC で再開する」の 4 つで、`asking`、`waiting`、`receiving`、`ready` が順にいまの段になる。
  90 秒の目安の細い線と経過秒を添える。
  線と秒は `startedAt` と `deadline` から View が 1 秒ごとに描き直す（Mediator は時計を持たない）。
  注記に「<端末名> の Hangar がクラウドを見に来るまで、最大 30 秒ほどかかります。」を出し、ボタンは「取り消す」だけである。
  `ready` になれば閉じて、今の再開（`api.resumeHere`）に入る。
- **C2：返事がないとき。**
  `timeout` で同じ 1 枚が警告に変わる（題は「<端末名> から返事がありません」）。
  「<端末名> の Hangar が閉じているか、ネットワークに接続されていない可能性があります。」と「このまま引き継ぐと、会話が分かれることがあります」の帯を出し、選びは「取り消す」「もう少し待つ」「このまま引き継ぐ」の 3 つである。
- **D1：引き継がれた側。** 上の見出しの下の 1 行だけで、札は出さない。
- 閉じられるのは取り消し（`session.takeover.cancel`）だけである。
  Esc と外側のクリックも、`overlay.close` の代わりに取り消しを送る（閉じるとサーバに待ちが残るため）。
  フォーカスが 1 枚の外へ出ていて Esc が `Root` の `overlay.close` として届いたときも、Mediator が取り消しと同じに読む（閉じて `api.takeoverCancel`）。
  段が変わっても「取り消す」を作り直さないよう、ボタンには鍵を付ける（作り直すとフォーカスが外れる）。
- psmux（tmux）が無いと分かっているときは、承諾（`session.takeover.start`）も始める前の案内で止める。
  案内を閉じれば確認の 1 枚へ戻り、見つかったあとの「開始」では確認の 1 枚へ戻してから頼みを送る。
  再開が通ったあとには取り下げを送らない（`cancel` は `force` の頼みも取り下げるため）。
- 一覧の行の「⋯」とセッション画面の「この PC で再開」は、ロックが生きていても押せる。
  再開とフォークは閉じたままで、理由を添える。

他端末の本文を索引化するときは、共有テーブルの `sessions` と `session_summaries` には書かず、端末ローカルの表（`transcript_files`、`event_index`、`event_fts`）だけを書く。
同じセッションの同じ位置につき索引化するファイルは常に 1 つで、手元の本文があればそれを優先し、無ければ更新時刻が最新の写しを 1 つだけ採る。
本文が 2 か所で伸びても、見た目が二重にならないようにするためである。

### スマホ（試験的）

スマホで「いま自分の番の会話」を見て、会話を起こせるようにする。
互換の版 7 で入れた。
0.8.0 の rc.2 で、呼び鈴（Durable Object）、`@` と `/` の問い合わせ、画像の添付、effort の選択を足し、互換の版を 8 に上げた。
スマホの画面は自分の Worker が配る小さな PWA（`packages/mobile`、React と Vite）で、PC の受信箱をスマホ向けに見せる。
会話そのものは扱わない。
会話を開いて続けるのは、Claude の Remote Control（`claude --remote-control`）に任せる。
スマホから会話の状態は変えない（Done や Paused にする操作は無い）。

**範囲。**
見るのは、入力待ち（許可待ちと入力待ち）、実行中の会話、今日のリマインダー（今日戻る会話）、今日終わった会話、PC ごとの生存である。
できるのは、選んだ PC に新しい会話を起こすことだけである。
選べるのは、プロジェクト（ディレクトリなしの「クイックセッション」を含む）、PC、アカウント、権限モード、モデル、effort、初期プロンプトである。
権限モードの値は、PC の新規セッションのダイアログと同じである。
effort の値（デフォルト、low、medium、high、xhigh、max）も、PC の新規セッションのダイアログと同じ表（shared の `EFFORT_VALUES`）を使う。
PC 側で権限モードやモデルや effort に上限は設けず、スマホで選んだ値のまま起こす。
初期プロンプトの欄には、PC の指示欄と同じ `/`（スキルとコマンド）、`@`（ファイル）、画像の添付がある。
`/` と `@` の候補は PC に問い合わせて返してもらい（「呼び鈴と問い合わせ」）、画像は暗号化して R2 に預けて PC に取らせる（「画像」）。

**Worker の表と口。**
スマホ向けの表は、共有テーブル（`rows`、`SHARED_TABLES`）に足さず、専用の 3 表にする。
`rows` に足すと、版 6 までの Worker が知らない表を含む push を 400 で丸ごと断り、版 6 の PC は知らない表を pull するからである。
専用の表なら、古い PC は何も見ない。
`devices` には列 `kind`（`pc` か `mobile`、既定は `pc`）を足した（`DEVICE_ADDED_COLUMNS`）。

| 表 | 1 行の意味 | 主な列 | 索引 |
| --- | --- | --- | --- |
| `mobile_feeds` | 1 台の PC の受信箱の素（暗号化済み） | `device_id`（主キー）、`sealed`、`updated_at` | 主キーのみ |
| `launch_requests` | スマホから PC への起動の依頼 | `id`、`target_device`、`from_device`、`sealed`、`status`（`pending`、`claimed`、`started`、`failed`、`expired`）、`created_at`、`claimed_at`、`answered_at`、`sealed_answer` | `launch_requests_target`（宛先、状態、時刻。pull の引き）、`launch_requests_from`（出したスマホ、時刻。回数の数え）、`launch_requests_at`（時刻。古い行の掃除） |
| `mobile_pairings` | ペアリング券 | `code_hash`（主キー）、`created_by`、`created_at`、`used_at` | `mobile_pairings_by`（取った PC、時刻。回数の数え）、`mobile_pairings_at`（時刻。古い行の掃除） |

Worker が平文で持つのは、PC の ID と更新時刻、依頼の ID と宛先と状態と時刻、スマホの名前と最終確認だけである。
待っている内容、意図の文、題、初期プロンプト、答えの中身は、すべて暗号化して置く。

口は `/m/` に置く（`packages/cloud/src/mobile.ts`）。

| 経路 | 通せるトークン | 働き |
| --- | --- | --- |
| `POST /m/pairings` | PC | ペアリング券を取る |
| `POST /m/join` | 不要（券で認める） | 券をスマホ用のトークンに替える |
| `PUT /m/feed` | PC | 受信箱の素を置く（PC ごとに 1 行を上書き） |
| `GET /m/inbox` | スマホ | 解除していない PC の一覧と、その PC の素を返す |
| `POST /m/launches`、`GET /m/launches/:id` | スマホ | 起動の依頼を出す、状態を読む |
| `POST /m/launches/:id/claim`、`POST /m/launches/:id/answer` | PC | 依頼を受け取る、答える。答えが通ったら、その依頼の画像を R2 から消す |
| `GET /m/bell` | PC | 呼び鈴の WebSocket につなぐ |
| `POST /m/ask` | スマホ | `@` と `/` の問い合わせを、宛先の PC に渡して答えを返す |
| `PUT /m/blobs/<依頼の ID>/<番号>` | スマホ | 封をした画像を R2 に置く |
| `GET /m/blobs/<依頼の ID>/<番号>` | PC | 自分宛ての依頼の画像を読む |
| `DELETE /m/feed` | PC | 自分の受信箱の素の行を消す |

依頼を PC へ届けるために、専用の口は足さない。
`GET /changes` の応答に `launches`（その PC 宛ての未処理の依頼、最大 50 件）を載せる。
索引 `launch_requests_target` で、宛先が自分で、状態が `pending` で、時間内の行だけを引く。
要求の数は増えず、PC の 30 秒ごとの pull がそのまま依頼を運ぶ。
呼び鈴（後述）が張れているときは、依頼を置いた直後に呼び鈴で鳴らし、PC はすぐ pull する。
呼び鈴は依頼を運ばず、pull を早めるだけである。

**トークンの種類。**
端末トークンは 2 種類で、`devices.kind` で分ける。
`kind = 'pc'` のトークンは、今までの口と PC 用の `/m/` の口を通す。
`kind = 'mobile'` のトークンは、スマホ用の `/m/` の口だけを通す。
どちらの口も、違う種類のトークンには 403 を返す（`auth.ts` の `requireKind`）。
経路を足すときは、参加の口のほかは必ず `authMiddleware` と `requireKind` を付ける。
スマホのトークンに有効期限は無い。
外すのは PC の一覧からで、PC と同じ「解除」を使う（解除した端末は 401 の `revoked` で断る）。
解除したスマホは、新しい券を使わなければ参加し直せない。
解除されていないスマホは Worker 全体で 10 台までで、超える券は 409 の `too-many-phones` で断る（券は残る）。

**ペアリング券。**
スマホは参加の秘密を持たない。
スマホに渡すのは、スマホ用の鍵と、使い捨ての券だけである。
参加の秘密を渡さないので、スマホや QR が漏れても PC として参加できず、R2 の本文も読めない。
券は PC が `POST /m/pairings` で取る。
128 bit の乱数で、D1 にはハッシュ（SHA-256）だけを置き、5 分で失効し、1 回で使い切る。
使い切りは「まだ使っておらず、期限内のものだけを使用済みにする」条件つきの 1 文で行い、1 行を変えたときだけ参加させる。
無い券、使った券、期限切れの券は、同じ 401 で断る。
1 台の PC が取れる券は 10 分に 5 枚までで、超えたら 429 である。
数えるのと入れるのを 1 つの文にして、同時の要求でも超えさせない。
スマホの行の ID は Worker が新しく振り、スマホが名乗る ID は使わない（既にある行を指して上書きさせないため）。

QR の中身は `<Worker の URL>/app/#pair=<base64url(JSON)>` で、JSON は `PairingBlob`（`url`、`code`、`key`、`pcName`、`expiresAt`）である。
`key` はスマホ用の鍵の 32 バイトである。
`pcName` と `expiresAt` は秘密ではなく、画面の表示に使う。
`#` 以降はサーバへ送られず、スマホの画面は読んだらすぐ `history.replaceState` で消す。
PC 側の接続の画面は、設定 › クラウド同期 の「スマホ」にある。
QR を出している間だけ、3 秒ごとに PC の一覧を読み直して、スマホの参加を知る。

スマホでは、鍵を取り出せない `CryptoKey`（non-extractable）にして IndexedDB に置き、Worker 用のトークンと宛先は `localStorage` に置く。
画面に XSS があっても、鍵の値は持ち出せない。
ホーム画面に追加したアプリは Safari と保存場所が分かれることがある。
保存が空のときは、「カメラで QR を読む」と「接続コードを貼り付け」（QR と同じ内容）を出す。
Safari で接続してからホーム画面に追加すると、ホーム画面のアプリは未接続で開き、2 回接続することになる。
そこで、iPhone と iPad の Safari で、ホーム画面のアプリでなく、未接続のときは、接続より先に「ホーム画面に追加して、そこから開く」を案内する（`display-mode: standalone` と `navigator.standalone` で見分ける）。
ホーム画面のアプリは、接続の画面でアプリの中のカメラで QR を読む。
QR が有効なのは、PC の画面に出ている残り時間の間である。

**暗号の鍵と AAD。**
受信箱の素、起動の依頼、その答えは、スマホ用の鍵で封じて Worker に預ける（`packages/shared/src/mobileCrypto.ts`）。
鍵は `HKDF-SHA256(参加の秘密, salt = "hangar-salt-v1", info = "hangar-mobile-v1", 32 バイト)` で、暗号は AES-256-GCM、IV は毎回 12 バイトの乱数である。
R2 の本文の鍵（info は `hangar-file-v1`）とは別の用途の鍵で、片方から他方は導けない。
封じた文字列は `base64url(IV || 暗号文 || タグ)` である。
追加認証データ（AAD）で用途と宛先を縛り、別の用途や別の宛先に差し替えた封じは開けない。

| 用途 | AAD |
| --- | --- |
| 受信箱の素 | `feed:<PC の ID>` |
| 起動の依頼 | `launch:<依頼の ID>:<宛先の PC の ID>` |
| 依頼の答え | `answer:<依頼の ID>` |
| `@` と `/` の問い合わせ | `ask:<問い合わせの ID>:<宛先の PC の ID>` |
| 問い合わせの答え | `reply:<問い合わせの ID>` |
| 画像 | `image:<依頼の ID>:<番号>` |

区切りはコロンである（shared の `aadAsk`、`aadReply`、`aadImage`）。
問い合わせと画像の封にも、同じスマホ用の鍵を使う。
問い合わせの AAD に宛先の PC の ID を入れるので、別の PC に渡った問い合わせは開けない。
画像の封は `sealBytes` で、文字列にせず、バイト列のまま `IV || 暗号文 || タグ` を置く（base64url にしない）。

PC は、復号できた依頼だけを起こす。
スマホの Worker 用トークンだけが漏れても、鍵が無いので、有効な依頼は作れない。
鍵は参加の秘密から導くので、`setup cloud --rotate-secret` で秘密を作り直すと、スマホ用の鍵も変わる。
スマホは、開けなくなった受信箱を「接続し直してください」と出し、新しい QR で接続し直す。

**受信箱の素と書き込みの間引き。**
素は PC ごとの 1 つの JSON（`MobileFeed`）で、アカウントと使用量、プロジェクト、動いている会話、戻る会話、今日終わった会話を持つ。
動いている会話には、待っている内容、意図の文、Remote Control の URL が入る。
文は 300 字で切る（`MOBILE_TEXT_MAX`）。
暗号化の前で 48 KiB（`MOBILE_FEED_MAX_BYTES`）までとし、超えたら次の順に、収まったところでやめる（`packages/shared/src/mobile.ts` の `fitFeed`）。

1. 終わった会話、戻る会話、プロジェクトの順に、古いものから落とす。
2. 待っていない動いている会話を、idle、busy の順に、状態の時刻の古いものから落とす。
3. 意図の文を 60 字に詰め、それでも収まらなければ消す。
4. 題、プロジェクト名、待っている内容を 60 字に詰める。
5. 残った待っている会話を、古いものから落とす。

最後の段まであるので、素は必ず 48 KiB に収まる。
封じて base64url にすると約 4/3 倍になり、上限いっぱいで約 65.6 KB になる。
そのため `PUT /m/feed` の本文の上限は 96 KiB にした。
素を作るのは `packages/server/src/mobile/feed.ts`、置くのは同じ場所の `publisher.ts` である。

素を書くのは、外していないスマホ（`devices` の `kind = 'mobile'` で `revoked_at` が空の行）が 1 台以上あるときだけである。
スマホが 1 台も無い PC は、`mobile_feeds` に 1 行も書かない。
スマホの有無は、同期の部品が Worker の一覧（`GET /devices`）を読んだ結果で知る（`boot/mobile.ts`）。
一覧を読むのは、設定の画面を開いたとき（QR を出している間は 3 秒ごと）と、書き手の見回りである。
見回りは、分からないあいだは 60 秒ごと、分かった後は 5 分ごと（`PHONE_RECHECK_MS`）に読み直す。
読めなかったときは前の値のままにし、まだ一度も読めていない（分からない）あいだは書かない。
最初のスマホが現れたら、前に書いた中身を忘れてすぐ書く。
外していた間に同じ中身のままでも、新しくつながったスマホに素を置くためである。
外したことは、次の読み直し（最長 5 分）で知る。
最後のスマホを外したと知ったら、その PC は `DELETE /m/feed` を 1 回呼んで、Worker の自分の素の行を消し、以後は書かない。
消しておくのは、スマホが 1 台も無いのに、古い素が D1 に残り続けないようにするためである。
`cloud.json` を替えてつなぎ先が変わったときは、「スマホが有る」という覚え（5 分）を捨てて、すぐ読み直す。

書き込みは、素の JSON のハッシュが前回と変わったときと、前に書いてから 1 日たったとき（`FEED_REFRESH_MS`）だけ行う。
1 日ごとに書き直すのは、スマホが更新の 7 日より古い素を隠すので、動きの無い PC が消えないようにするためである。
変化を 2 秒待ってまとめ（`FEED_DEBOUNCE_MS`）、同じ PC からの書き込みは前の書き込みから 15 秒あける（`FEED_MIN_GAP_MS`）。
間に来た変化は、間が明けたところで 1 回にまとめる。
取りこぼしを防ぐ安全網として 60 秒ごとにも作り直すが、ハッシュが同じなら書かない。
書き込みに失敗したらハッシュを覚えないので、次のきっかけで同じ中身でも書き直す。

`GET /m/inbox` が読むのは `devices` と `mobile_feeds` だけで、行の数は PC の数程度である。
`rows` と本文の索引（`files`）は読まない。
Worker が最後に見てから 3 分（`PEER_STALE_MS`）を過ぎた PC は、スマホの画面で「不明」にする。
更新が 7 日（`FEED_HIDE_AFTER_MS`）より古い素は、解除せずに去った PC のものとして、スマホは出さない（開けない封でも「開けない」と言わない）。
最後に見たのが 7 日より前の PC も、生存の行に出さない。
「不明」のまま出し続けないためである。
画面は、見えている間だけ 30 秒ごとに読み直し、前面に戻ったときと、下に引いたときにも読む。

**起動の依頼の握手。**

1. スマホが依頼（`MobileLaunchPayload`）を `launch:` の AAD で封じ、`POST /m/launches` で置く。同じ ID の再送は行を増やさない。
2. 宛先の PC が、30 秒ごとの pull で `launches` を受け取る。
   呼び鈴が張れているときは、Worker が依頼を置いた直後に宛先の PC を鳴らし（`{t:'launch'}`）、PC は `pullNow()` で今すぐ pull する。
   鳴らすのに失敗しても依頼は通り、30 秒の pull で拾う。
3. PC が `POST /m/launches/:id/claim` を呼ぶ。条件つきの 1 文で、自分宛てで、まだ誰も受け取っておらず、時間内の行だけを `claimed` にする。1 行を変えたときだけ 200 で、それ以外は 409 である。PC は 200 のときだけ起こす。
4. PC が封を開き、プロジェクトとアカウントを確かめて会話を起こし、答え（会話の ID と題、または断った理由）を `answer:` の AAD で封じる。結果と封じた答えを、手元の表 `mobile_launches` に書く。
5. PC が封じた答えを `POST /m/launches/:id/answer` で返す。
6. スマホが 2 秒ごとに `GET /m/launches/:id` で状態を読み、答えを開いて「受信箱へ」を出す。

依頼は 75 秒（`LAUNCH_TTL_MS`）で切れる。
PC の pull が 30 秒ごとなので、2 周分の余裕を見た値である。
Worker はこれを過ぎた依頼を claim させず、スマホの読みには `expired` と返す。
スマホは 80 秒で諦める。
PC が受け取る前（`pending` のまま）なら「〈PC〉から応答がありません」と表示するので、諦めた後に起動されることはない。
`mobile_launches` に書くのは答えを送るより先で、答えを送れなくても同じ依頼を二度起こさない。
送れなかった答えは、封じたまま `mobile_launches` に控えてあり、PC は 10 秒ごとの見回りで、扱ってから 10 分（`ANSWER_RESEND_WINDOW_MS`）のあいだ同じ封を送り直す。
Worker が受け取るか、409（もう答えた、時間切れ）を返したら、送り直しをやめる。
スマホが `claimed` を一度でも見た後に諦めたときは、「〈PC〉で受信しましたが、結果をまだ受信していません。受信箱で確認してから送り直してください。」と表示する。
会話が始まっているかもしれないので、その場で新しい ID の依頼を送り直す「もう一度」は出さない。
claim が通ったのに応答が失われた場合は、起こされず、スマホは時間切れと言う。
二度起こすより、起こさない側へ倒す設計である。
claim が通信で倒れたときは記録せず、次の pull で試し直す。
断る理由は `project-missing`、`account-missing`、`bad-payload`、`expired`、`launch-failed`、`images-missing` である。
`images-missing` は、依頼に付いた画像を 1 枚でも取れない、または開けないときで、起こさずに返す。
依頼の封の中身には、`effort`（無ければデフォルト）と `images`（番号、MIME、バイト数の並び）を足せる（「effort」「画像」）。
PC が一時停止しているときと、Worker の版が 7 に届かないときは、claim せずに残す。

上限は次のとおりである。

| 項目 | 値 |
| --- | --- |
| 起動の依頼の回数 | 1 台のスマホから 10 分に 10 件まで（超えたら 429） |
| ペアリング券の回数 | 1 台の PC から 10 分に 5 枚まで（超えたら 429） |
| 解除していないスマホ | 10 台まで（超える参加は 409）。数える文と行を足す文が分かれているので、同時の参加では少し越えうる緩い上限で、越える分は券の回数の上限で抑えられる |
| 受信箱の素 | 暗号化の前で 48 KiB まで。`PUT /m/feed` の本文は 96 KiB まで |
| `POST /m/launches` の本文 | 48 KiB まで |
| 答えの本文 | 16 KiB まで |
| 初期プロンプト | 8,000 字まで（`MOBILE_PROMPT_MAX`） |
| 依頼に入るプロジェクトとアカウントの ID | 128 字まで |
| 依頼の行を残す期間 | 7 日（依頼を出すついでに消す） |
| 問い合わせ（`POST /m/ask`） | 本文 4 KiB まで（`MOBILE_ASK_MAX_BYTES`）、答え 64 KiB まで（`MOBILE_REPLY_MAX_BYTES`）、1 台のスマホから 10 秒に 20 回まで（超えたら 429）、PC の答えを待つのは 5 秒（`MOBILE_ASK_TIMEOUT_MS`） |
| 画像 | 1 枚 5 MiB まで（`MOBILE_IMAGE_MAX_BYTES`。封の 28 バイトを足して受ける）、1 件の依頼に 4 枚、1 台のスマホが置いたままにできるのは 40 枚 |
| 画像を残す期間 | PC が答えを返したら消す。残りは 24 時間で消す（孤児の掃除と、スマホが置くときと依頼を出すときの掃除） |
| 手元の `mobile_launches` を残す期間 | 7 日（依頼を受け取るついでに消す） |
| ペアリング券の行を残す期間 | 24 時間（券を取るついでに消す） |

日本語の 8,000 字は UTF-8 で約 24 KB、封じて base64url にすると約 33 KB になる。
そのため、依頼の本文の上限を 48 KiB にした。
回数の上限は、盗まれたトークンで D1 の書き込みの枠を食い潰されないためである。

**呼び鈴と問い合わせ。**
`@` と `/` の候補を 1 秒から 3 秒で返し、起動の依頼もすぐ拾うために、Worker に Durable Object のクラス `HangarBell` を 1 つ足した（`packages/cloud/src/bell.ts`）。
名前の決まった 1 つの実体（`idFromName('bell')`）だけを使い、PC と WebSocket でつなぎっぱなしにする。
SQLite 型で作る（無料プランで使えるのはこれだけ）。
ほかの案は、スマホが居る間だけ PC が速く聞く案と、待たない形に変える案だった。

- **つなぎ方。**
  PC は `GET /m/bell`（`Upgrade: websocket`、`Authorization: Bearer <PC のトークン>`）でつなぐ。
  Worker が `authMiddleware` と `requireKind('pc')` を通してから、端末の ID（`x-hangar-device`）を添えて Durable Object へ渡す。
  Durable Object は外から直に届かないので、この見出しは Worker が認証の後に付けたものだけである。
  トークンが無い、違う、解除した PC は 401、スマホのトークンは 403、WebSocket でない要求は 426、呼び鈴の束縛が無い Worker は 503 である。
  Durable Object は Hibernation API（`acceptWebSocket`、端末の ID は `serializeAttachment`）で受ける。
  同じ PC の 2 本目がつながったら、古いほうを閉じる（符号 4000）。
- **生存の確かめ。**
  PC は 30 秒ごとに文字列の `ping` を送り、Durable Object は `setWebSocketAutoResponse` で `pong` を返す。
  自動応答なので、Durable Object を起こさず、リクエストにも数えない。
  PC は 75 秒のあいだ何も届かなければつなぎ直す。
  つなぎ直しの待ちは 1 秒から倍々で 60 秒までである。
  401 と 403 を返されたときは張り直さず、つなぎ先（`cloud.json`）かトークンが変わるまで止める。
  404、426、503、閉じる符号 4000 のときは、待ちを 60 秒にして叩きすぎない。
- **鳴らす。**
  スマホの起動の依頼（`POST /m/launches`）が行を新しく入れたときだけ、Worker は `waitUntil` で Durable Object に宛先の PC を鳴らさせる（`{"t":"launch"}`。再送では鳴らさない）。
  PC は鳴ったら `engine.pullNow()` を呼び、今の pull の道で依頼を受け取る。
  鳴らすのに失敗しても、呼び鈴が無い Worker でも、依頼は 201 のまま通り、PC は 30 秒の pull で拾う。
- **問い合わせ。**
  スマホは `POST /m/ask`（スマホのトークン、本文は `{ id, targetDevice, sealed }`）を送る。
  Worker は宛先が解除していない PC であることを D1 で 1 行読んで確かめ、Durable Object に渡す。
  Durable Object は宛先の PC の WebSocket に `{"t":"ask","id","sealed"}` を送り、PC の `{"t":"reply","id","sealed"}` を最大 5 秒待って、封じたまま返す。
  PC の `reply` は、待っている問い合わせの宛先と送ってきた WebSocket の端末が一致するものだけを答えにする。
  **D1 には書かない。**
- **返りの符号。**
  200（`{ sealed }`）、400（形が違う）、404（宛先が無い、スマホ、解除した PC）、409（同じ ID の問い合わせが待ち中）、413（本文が 4 KiB 超）、429（10 秒に 20 回超）、502（答えが 64 KiB 超）、503（`pc-offline`。宛先がつないでいない、呼び鈴が無い Worker、待ち中に切れた）、504（`pc-timeout`。5 秒で答えが無い）。
  PC のトークンは 403 である。
  回数は 503 になったものも数える。
  数えるのは Durable Object のメモリで、眠れば消える緩い上限である。
- **封の中身。**
  問い合わせの本文は、スマホが `ask:` の AAD で封じ、Durable Object と Worker は読めない。
  中身は JSON である。
  - `{ kind: 'files', projectId, q }` に、`{ files: [{ path, changed }] }` を返す。
    `q` が空（空白だけも）なら、git の変更ありのファイルと、最近のコミットに入った変更時刻の新しいファイルを合わせて最大 30 件（変更ありを先に）。
    `q` があれば、PC の指示欄と同じ検索（`listProjectFiles`）で最大 50 件。
    パスはプロジェクトの根からの相対で、外に出るものは返さない。
    git でないディレクトリは変更時刻だけで並べる。
  - `{ kind: 'commands', projectId | null, accountId }` に、`{ commands: [{ name, description, kind: 'skill' | 'command' }] }` を返す。
    PC の指示欄と同じ一覧を、そのアカウントの設定ディレクトリで読む。
    使った回数の多い順に最大 200 件で、説明は 120 字で切る。
    `projectId` が null ならプロジェクトのスキルは含めない。
  - 失敗は `{ error: 'project-missing' | 'account-missing' | 'bad-request' }` である。
  - 答えは `reply:` の AAD で封じる。
    PC は、開けない問い合わせには答えない（スマホは 5 秒で時間切れになる）。
- **スマホ側。**
  答えは画面の間だけ覚える（同じ PC、プロジェクト、アカウントの `/` は 1 回、`@` は同じ `q` を 30 秒）。
  打つたびの問い合わせは 250 ms 待ってから出す。
  PC がつないでいない、答えない、呼び鈴が無い Worker のときは、候補の欄にその旨を表示し、プロンプトは手で入力できる。
- **PC 側の張る条件。**
  書き込みの間引きと同じ部品（`packages/server/src/mobile/bell.ts` と `boot/mobile.ts`）が、スマホを運べる PC で、Worker の版が 8（`MOBILE_BELL_MIN_WORKER_COMPAT`）に届き、外していないスマホが 1 台以上あるときだけ張る。
  Worker の版は pull の応答で分かるので、Worker を配備し直した直後は、最大 60 秒ほど張らない。

問い合わせの上限を Worker の側に置くのは、盗まれたスマホのトークンで PC を叩かれすぎないためである。
問い合わせは PC の中身を返すので、答えに入るのは、プロジェクトの根の下のパスと、そのアカウントが持つスキルの名前と説明に限る。

**画像。**
スマホは、選んだ画像を送る前に、長い辺 2048 px の JPEG（品質 0.85）に縮める。
縮めた後で 5 MiB を超えるものと、5 枚目は受け付けない。

1. 画像ごとに `sealBytes`（AAD は `image:<依頼の ID>:<番号>`）で封をし、`PUT /m/blobs/<依頼の ID>/<番号>` で R2 の `mobile/<スマホの ID>/<依頼の ID>/<番号>` に置く。
   番号は 0 から 3 である。
   本文は封をしたバイト列そのままで、`content-length` が要る（無ければ 411）。
   ストリームでなく、Blob か ArrayBuffer で送る。
2. 依頼の封の中身の `images`（`{ n, mime, bytes }` の並び）に、置いた画像を書く。
   依頼は画像を全部置いてから出す。
3. PC は依頼を受け取って claim したら、`GET /m/blobs/<依頼の ID>/<番号>` で画像を取る。
   Worker は、依頼の宛先がその PC で、状態が `claimed` のときだけ読ませる。
   PC は開き、PC の指示欄と同じ `saveDrop` で drops に置き、PC の指示欄と同じ並びで、初期プロンプトの末尾にパスを足して起こす。
   1 枚でも取れない、または開けないときは、起こさずに `images-missing` を返す。
   画像が 4 枚を超える、番号が重なる、MIME が許し（JPEG、PNG、WebP）の外のときは、取りに行かずに `bad-payload` で断る。
4. 画像は答えで消し、残りは 24 時間で消す。
   PC が答えを返したとき（`started` でも断りでも）、Worker がその依頼の画像を消す。
   答えが来ない画像は、そのスマホが次に画像を置くときと依頼を出すときに、Worker が `mobile/<スマホの ID>/` の下で 24 時間を過ぎたものを消す。
   孤児の掃除（`sweep.ts` の `sweepBodies`）も、`mobile/` の下を `files` の索引で判定せず、置いてから 24 時間（`IMAGE_KEEP_MS`）を過ぎたものだけを消す。
   解除したスマホの画像は、置くときの掃除が二度と走らないので、この掃除でしか消えない。
   消すのに失敗しても、答えと依頼は通る。

触れる鍵は絞る。
スマホのトークンは、`mobile/<自分の ID>/` の下に置くことだけができる（読めず、一覧にもできない）。
PC のトークンは、自分宛ての依頼の画像を読むことだけができる。
`files` の口（`validKey`）は変えず、本文の鍵の空間とは混ざらない。
依頼の ID は、64 字までで、英数字で始まり英数字と `._-` だけにする（R2 の鍵に入るので、スラッシュなどは通さない）。
置くときの返りは、201、400（番号が 0 から 3 の整数でない、ID の形が違う、本文が空）、411、413（5 MiB と封の 28 バイトを超える）、429（置いたままが 40 枚）である。
置く前に、そのスマホの下の 24 時間より古いものを消してから数えるので、置きっぱなしで詰まらない。
スマホの画面の CSP の `img-src` には、サムネイルを出すために `blob:` を足した。

**effort。**
`MobileLaunchPayload` に `effort?: string` を足した（`v` は 1 のまま）。
値は `EFFORT_VALUES`（空、low、medium、high、xhigh、max）で、PC の新規セッションのダイアログの選択肢（`LaunchChips.tsx`）、スマホ、PC の受け取りが同じ表を使う。
PC の受け取りは、値表に無いものを `bad-payload` で断り、あれば起動の引数（`LaunchParams.effort`）に写す。
無ければ付けず、claude の既定のままにする。
受信箱の素のスキーマは変えない。

**Remote Control。**
会話をスマホで続けるために、hangar が起こす claude に `--remote-control <名前>` を足す。
設定 › 連携 の「Remote Control を付けて起動する」で切り替え、既定は入りである（`Settings.remoteControl`）。
次のときは足さない。

- 手元の claude の `--help` の Options に `--remote-control` が無いとき、または `--help` をまだ読めていないとき（`compat/localClaude.ts` の `remoteControlSupported`）。古い claude は知らない引数で起動に失敗しうるからである。
- アカウントの認証が claude.ai のログインでないとき（API キーのアカウント）、または認証をまだ読めていないとき。
  認証（`claude auth status --json`）は、サーバを組んだときに全部のアカウントのぶんを裏で 1 回読み、画面がアカウントを読むときにも読む。
  組んだときに読むのは、画面を開かずにスマホから起こした会話でも判定できるようにするためである。
  読めていないまま起こしたときは、次の起動に間に合うよう、そのアカウントの認証を裏で読ませる。
- `ANTHROPIC_BASE_URL` か `ANTHROPIC_API_KEY` が設定されているとき。
- 利用者がターミナルで自分の引数に `--remote-control` か `--rc` を付けているとき、または対話でない起動（`-p`、`--print`）のとき。

API キーの claude は `--remote-control` を黙って無視して普通に起動した。
付けても害は無いが、URL は出ない。
そのため、付けない側へ倒している。
足さないときは、サーバの標準出力に、どの条件で落ちたか（`disabled`、`unsupported`、`auth-unknown`、`logged-out`、`no-email`、`base-url`、`api-key`、`user-args`、`unregistered-config-dir`）を 1 行だけ書く。秘密は書かない。
名前は、会話の名前があればそれ、無ければ初期プロンプトの先頭 40 字、それも無ければプロジェクト名で、どれも無ければ「Hangar」である。
スマホから起こすときは名前の欄が無いので、初期プロンプトから決まる。

Remote Control の URL を取る公式の手段は無い。
起動から 60 秒、2 秒ごとに tmux の画面を折り返しをつなげて（`capture-pane -J`）読み、`https://claude.ai/code/session_…` の形を拾って、手元の表 `run_remote_urls` に残す。
Windows の psmux は `-J` を受けて 0 で終わるが、折り返しをつながない（3.3.8 で、行の末尾の空白を落とすだけ）。
そのため psmux では `-J` を付けずに読み、ペインの幅（`#{pane_width}`）いっぱいまで埋まった行を、URL の続きのときだけ hangar がつなぐ。
会話ごとに最新の 1 つを持つ。
受信箱に載せるのは、今の run の起動より後に拾ったものだけである。
拾えなかったときは、スマホの札は `claude.ai/code` を開く。
`rcUrl` は `https://claude.ai/` で始まるものだけを通す（`isRemoteControlUrl`）。
拾うときと、スマホで開くときの両方で確かめる。
画面の文は会話から来るので、攻撃者が操れるからである。

**端末ローカルの表。**
スマホ向けに、端末ローカルの表を 2 つ足した。
どちらも同期しない。

| 版 | 表 | 中身 |
| --- | --- | --- |
| 29 | `mobile_launches` | この PC が扱い終えた依頼の ID、時刻、結果（`started` か断った理由） |
| 30 | `run_remote_urls` | 会話の ID、拾った Remote Control の URL、拾った時刻 |
| 31 | `mobile_launches` に列を足す | 封じた答え（`sealed_answer`）、その ok（`ok`）、Worker が受け取ったか（`answered`）。版 29 は既に入った端末があるので書き換えず、列を足す版にした |

**画面の守りと配信。**
スマホの画面は、Worker の静的ファイル（wrangler の `assets`）として `/app/` に置き、API は `/m/` に置く。
同じオリジンなので CORS は要らない。
`hangar setup cloud` は、資源を作る前にスマホの画面を build する。
`packages/mobile/dist/app/index.html` が出なければ、Cloudflare に何も作らずに止まる。
配備は、その `dist` を Worker と一緒に上げる。
`wrangler.jsonc` に `assets` が無い古い設定は、`hangar setup cloud` をもう一度実行して書き直す。
`_headers` で、`/app/*` に次の見出しを付ける。
入口の `/app/` だけの段は置かない。
`/app/*` と重なって、見出しが二重に付くからである。

- `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`

外のスクリプトを読まず、外への通信もしない。
`media-src 'self' blob:` は、画面の中で QR を読むカメラのために要る。
`img-src` の `blob:` は、添付する画像のサムネイルを出すために要る。
画面は `dangerouslySetInnerHTML` を使わない（試験で縛る）。
色は PC の hangar と同じ明るい配色だけで、暗い配色を持たない。
動きは PC の画面と同じ決まりで、時間と曲線は PC のトークンの値を `packages/mobile` の CSS へ写して使い、動きを減らす設定を守る。

**互換の版 7。**
Worker の `COMPAT_VERSION` を 7 に上げ、スマホ向けの口と 3 表を持つ版にした。
`MIN_DEVICE_COMPAT` は 6 のままで、版 6 の PC は締め出されない。
PC は、Worker が名乗る版が `MOBILE_MIN_WORKER_COMPAT`（7）に届くまで、スマホ向けの書き込みも依頼の処理もしない。
版 6 の Worker に当たったときは、設定の画面で「Worker を更新すると使えます」と言う。
版 6 の PC は、スマホ向けの経路を使わず、知らない表を pull しないので、版 7 の Worker と混ざっても同期は続く。
そのかわり、版 6 の PC は受信箱に出ず、スマホからその PC へ起こすこともできない。
スマホは、受信箱を置いた PC だけを宛先に出すからである。
shared の `COMPAT_VERSION` は PC と Worker で共通で、殻の `health.rs` の写しも 7 にそろえた。
殻と既存のサーバは一致で比べるので、版 7 の殻は版 6 のサーバを採らない。

**互換の版 8。**
Worker の `COMPAT_VERSION` を 8 に上げ、呼び鈴（`/m/bell`、`/m/ask`）と画像の口（`/m/blobs`）と `DELETE /m/feed` を持つ版にした。
`MIN_DEVICE_COMPAT` は 6 のままで、版 6 と 7 の PC は締め出されない。
PC は、Worker が名乗る版が `MOBILE_BELL_MIN_WORKER_COMPAT`（8）に届くまで、呼び鈴を張らない。
呼び鈴の無い Worker（rc.1 のまま再配備していないもの）と、つながらない PC では、起動は版 7 と同じ 30 秒の pull で動く。
そのとき、スマホの `/` と `@` は「この PC は候補を返せません（hangar を更新してください）」と表示し、プロンプトは手で入力できる。
画像の口（`/m/blobs`）は版 7 の Worker に無いので、画像つきの依頼は版 8 の Worker が要る。
shared の `COMPAT_VERSION` と、殻の `health.rs` の写しを 8 にそろえた。
殻と既存のサーバは一致で比べるので、版 8 の殻は版 7 のサーバを採らない。
Worker を配備し直すときは、Durable Object の `migrations`（`bell-v1`、`new_sqlite_classes: ['HangarBell']`）が要る。
`hangar setup cloud` が書く `wrangler.jsonc` に、`durable_objects.bindings`（`BELL`）と `migrations` が入る。
`migrations` は 1 段だけで、あとから足すときは追記し、過去の段は消さない（消すと、wrangler が全段を当て直す警告を出す）。

**古い組み合わせ。**
rc.2 のスマホは、古い Worker と古い PC に、使えない道具を出さない。

- 古い Worker（版 8 未満）。
  rc.1 の Worker も、知らない口に JSON の 404 を返すので、本文では見分けられない。
  スマホは、どの応答にも載る `x-hangar-compat` の見出しで見分ける。
  `/m/ask` と `PUT /m/blobs` の応答の版が `MOBILE_BELL_MIN_WORKER_COMPAT` 未満なら `unsupported` とする。
  受信箱の応答の版も覚えておき、版 8 未満なら「＋」を出さず、`/` と `@` は問い合わせずに「この PC は候補を返せません（hangar を更新してください）」と表示する。
  見出しの無い応答（Worker の手前の層が返したもの）は、古いとはみなさない。
- 古い PC（rc.1 の hangar）。
  rc.1 の PC は、依頼の `images` と `effort` を黙って捨てて `started` を返す。
  そこで、受信箱の素（`MobileFeed`）に任意の `caps`（`{ asks, images, effort }`）を足し、rc.2 の PC は全部 `true` で載せる（`mobile/feed.ts` の `FEED_CAPS`）。
  `fitFeed` は素を削っても `caps` を落とさない。
  スマホは、選んだ PC の素に `caps` が無ければ rc.1 の PC とみなし、「＋」と effort の欄を出さず、依頼に `effort` を入れない。
  `/` と `@` は問い合わせずに「この PC は候補を返せません（hangar を更新してください）」と表示する。
  PC を選ぶ前は分からないので、どれも出しておく。
  画像を付けた後に rc.1 の PC を選び直したときは、「この PC では画像を添付できません」として始められなくする。

**書き込みと読み取りの見積もり。**
無料枠は、D1 の書き込み 10 万行と読み取り 500 万行である（どちらも 1 日で、UTC の 0 時に戻る）。
下の表は見積もりで、実測はまだ無い。
1 日使った後に、「実測」の欄を埋める。

| 書き込み | 1 回あたり | 1 日の見込み | 1 日の上限 | 枠との比 | 実測 |
| --- | --- | --- | --- | --- | --- |
| 受信箱の素（スマホがつながった 1 台の PC） | 1 行 | 1,000 行前後 | 5,760 行（15 秒の間隔で 1 日中変わり続けたとき） | 見込みで約 1%、上限で約 5.8% | （未実測） |
| 受信箱の素（スマホがつながっていない PC） | なし | 0 行 | 0 行 | 0% | （未実測） |
| 起動の依頼 | 文は 3 つ（置く、受け取る、答える） | 数回なら数十行 | 1 台のスマホで 1,440 件（10 分に 10 件を 1 日続けたとき）。索引の更新も行に数えると 1 件で 10 行前後で、約 14,400 行 | 上限でも約 14% | （未実測） |
| ペアリング | 券と参加で数行 | 数回で数十行 | 1 台の PC で 10 分に 5 枚 | 無視できる | （未実測） |

受信箱の素は、スマホがつながった PC 1 台ごとに足される。
2 台なら、見込みは 2,000 行前後、上限は 11,520 行である。
スマホが 1 台もつながっていなければ、どの PC も書かない。
変化が無ければ書かないので、PC を使っていない間は、1 日 1 回の書き直し（1 行）しか増えない。

| 読み取り | 1 回あたり | 1 日の見込み | 枠との比 | 実測 |
| --- | --- | --- | --- | --- |
| 受信箱を開く（`GET /m/inbox`） | PC の数×2 行程度（`devices` と `mobile_feeds`。PC 2 台で 10 行前後） | 30 秒ごとに 1 日開けっぱなしで 2,880 回、約 3 万行 | 約 0.6% | （未実測） |
| 依頼の引き（pull の `launches`） | 索引で、該当の行の数だけ（ふだんは 0 行） | 依頼の数だけ | 無視できる | （未実測） |
| 依頼の状態の読み | 1 行 | 1 件につき 2 秒ごとに最大 40 回（80 秒で諦める） | 無視できる | （未実測） |
| スマホの有無の読み直し（`GET /devices`） | 端末の数の行 | 1 台の PC で 5 分ごとに 288 回、端末 4 台で約 1,200 行 | 約 0.02% | （未実測） |

Worker の要求数は、無料枠が 1 日 10 万である。
受信箱を 30 秒ごとに読む画面は 1 日 2,880 要求で、1 台の PC の素の書き込みは最大 5,760 要求である。
スマホの有無の読み直しは、1 台の PC で 1 日 288 要求である。
受信箱の取得は 1 回で全 PC の素を返すので、応答は PC ごとに、上限いっぱいで約 65.6 KB になる。
ふだんは数 KB である。

呼び鈴と画像で、Durable Object と R2 の使用が増える。
1 日に、PC 2 台、スマホ 1 台、起動 10 回、`@` と `/` の問い合わせ 200 回、画像 10 枚として見積もる。
Durable Object の無料枠は、リクエスト 1 日 10 万と、時間 1 日 13,000 GB-s である。
R2 の無料枠は、Class A（置く、一覧）が月 100 万、Class B（読む）が月 1,000 万、保存が 10 GB である。

| 物 | 1 日の見込み | 無料枠 | 実測 |
| --- | --- | --- | --- |
| Durable Object のリクエスト | 問い合わせ 200、鳴らす 10、PC のつなぎ直し 数十、WebSocket の受信（20 通で 1 回に数える）20 ほどで、約 300 | 10 万（約 0.3%） | （未実測） |
| Durable Object の時間 | 問い合わせを待つ間だけ（最大 5 秒 × 200 回）。眠っている間と ping の自動応答は数えない | 13,000 GB-s | （未実測） |
| D1 の書き込み | 増えない（問い合わせは D1 に書かない） | 10 万行 | （未実測） |
| D1 の読み取り | 問い合わせのたびに宛先の `devices` を 1 行読む（200 行）。画像の読みで依頼の行を 1 行読む | 500 万行 | （未実測） |
| R2 の Class A | 画像を置く 10、置く前の一覧 10、依頼を出すときの一覧 10、答えのときの一覧 10 で、約 40 | 月 100 万 | （未実測） |
| R2 の Class B | 画像を読む 10 | 月 1,000 万 | （未実測） |
| R2 の保存 | 置いたままは 1 台で最大 40 枚 × 5 MiB で、通常は答えのときに消える | 10 GB | （未実測） |

R2 の一覧は、画像を置くたび（置く前の掃除と数え）、依頼を出すたび（古いものの掃除）、依頼に答えが付いたたび（その依頼の画像を消す前の一覧）に 1 回ずつ呼ぶ。
画像が無い依頼でも、答えのたびに 1 回呼ぶ。
一覧は 1,000 件を超えなければ 1 回で済み、1 台のスマホの置いたままは 40 枚までなので、ふだんは超えない。
消す操作は Class A に数えない。
呼び鈴をつなぎっぱなしにしても、Hibernation API なので、使っていない間は Durable Object が眠り、時間の枠は減らない。
PC のつなぎ直し（Cloudflare 側の切断や配備のたび）は、そのつどリクエストを 1 つ使う。

**割り切り。**
スマホの割り切りは `docs/cloud-sync.md` の「割り切りと限界」に書いた。
参加の秘密を持たないこと、承諾なしで起こせること、配る画面を差し替えられうること、秘密を作り直すと接続し直しになることである。
rc.2 で足した割り切りは次のとおりである。

- 問い合わせの中身（`@` で打った文字、ファイルのパス、`/` の候補）と画像は、スマホ用の鍵で封じて通し、Worker、Durable Object、D1、R2 は平文で持たない。
  ただし、問い合わせの宛先、時刻、回数は Worker が見える。
- 問い合わせの回数の上限（10 秒に 20 回）は、Durable Object のメモリで数える。
  眠れば数えが消える緩い上限で、盗まれたトークンを完全には止めない。
- 呼び鈴は、依頼を運ぶのではなく、pull を早めるだけである。
  つながっていない PC は、今までどおり 30 秒の pull で拾う。
- 呼び鈴は、受信箱の即時の更新には使わない。
  受信箱は 30 秒ごとの読み直しのままである。
- 画像のほかのファイルは添付できない。
- 宛先でない PC には、問い合わせも画像も渡らない。
  問い合わせは AAD に宛先を入れ、Durable Object も宛先の WebSocket にだけ渡す。
  画像の AAD（`image:<依頼の ID>:<番号>`）に宛先は入らない。
  画像を守っているのは、Worker の `GET /m/blobs` が依頼の行の `target_device` と `claimed` を見て、宛先の PC が受け取った依頼の画像だけを読ませることである。

## セットアップのすゝめ

導入した人が Claude Code に読ませ、環境の診断と、会話のフォルダの登録や連携の提案をしてもらうための md である（2026-10-15）。
本編は `docs/setup-guide.md`、習慣は `docs/setup-guide-habits.md`（最初の 1 週間で試すこと）で、どちらもリポジトリが正本である。
CLAUDE.md の個人化は扱わず、フォルダは動かさない。

### 同梱と写し

配布物には `bundle-server` が 2 つの md を `server-dist/docs/` に写して入れる（`.app` の `Contents/Resources/server/docs/`、Windows のインストーラの `server\docs\`）。
サーバは `server.mjs` の隣の `docs/` から読み、無ければ（ソースから動かしている `npm run dev` と試験）リポジトリの `docs/` から読む（`setupGuide/guide.ts` の `bundledGuideDir`）。
サーバは起動のたびに（`boot/home.ts`）、2 つを hangar の置き場（既定は `~/.agent-hangar/setup-guide.md` と `setup-guide-habits.md`）へ写す。
中身が同じなら書かず、違えば上書きする。利用者が書き換えたものも上書きする。正本は同梱物で、一言に入れる版とハッシュを写しと合わせるためである。
写せなくても起動は止めない。`GET /api/setup-guide` と `POST /api/setup-guide/open` も同じ写しを確かめるので、起動の後で消したものは次に札を開いたときに戻る。
写した md の先頭行は `<!-- hangar-setup-guide v<アプリの版> sha256:<8 桁> -->` である。
md の表示には出ない HTML の注釈にしてある。
ハッシュは、版の行を除いた本文、つまり写した md の 2 行目から末尾まで（同梱の md の中身そのもの）の UTF-8 のバイト列の sha256 の先頭 8 桁である。
版の行を含めて計算すると、行がハッシュ自身を含んで決まらないからである。
版はアプリの版（`apps/desktop/package.json`、サーバの `VERSION`）である。

### API と貼る一言

`GET /api/setup-guide` は `{ path, version, sha, prompt }` を返す（`SetupGuideDto`）。
path は本編の写しの場所を表示用に縮めたもので、macOS と Linux はホームを `~`、Windows は `%USERPROFILE%` にする（`displayHomePath`）。
prompt は Claude Code に貼る一言で、日本語は `<path>（v<版> sha256:<8 桁>）を読んで、私の環境を診断して。書き換えは私が承諾してから`、英語も同じ趣旨である（辞書の `setupGuide.prompt.line`、`setupGuidePrompt`）。
サーバは設定の言語で作る。画面は path と版とハッシュから自分の言語で作り直すので、言語を変えても取り直さずに一言が替わる。
同梱の md が見つからないときは 500 と理由を返し、画面は札も行も出さない。
`POST /api/setup-guide/open` は写した本編を設定のエディタで開く（`once` で今回だけのエディタを選べる。エディタが無ければ 409）。
画面は bootstrap のたびに取り（`runtime.ts` の `loadSetupGuide`）、Store の `setupGuide` に入れる。取れなくても知らせない。
入口は設定の連携の札（「Settings」の節）と、ホームの始める前の確認の最後の行（「Home」の節）の 2 つである。

## 配布と運用

リポジトリは public で、MIT ライセンスで公開している（`LICENSE`、著作権者は `gaku1023`）。
GitHub Actions で型検査とテストを回し、タグを打つと macOS 用の `.app` と Windows 用の NSIS のインストーラをビルドして Releases に置く。
`.app` は Developer ID では署名せず、自作の証明書で署名する（署名の台本と手順は `docs/signing.md`）。dmg（主）と zip（予備）に SHA-256 の checksum を添える。
利用者はそれをダウンロードして `/Applications` へ移し、初めて開いて出る警告の後で、システム設定の「プライバシーとセキュリティ」の「このまま開く」で許可してから（管理者のパスワードを求められる）、`hangar setup` を走らせる。
検疫属性を `xattr -rd com.apple.quarantine` で外す道は、最後の手段として残す。
前提として Node 22.14 以上（Node-API 10 以上）と tmux と `claude` が要り、Homebrew なら `brew install node tmux` で足りる。
古い Node を置き換えたくない人は `brew install node@22` で入れる。
`node@22` は Homebrew の版によって `/opt/homebrew/bin` にリンクされる場合とされない場合（keg-only）があるが、アプリも同梱の CLI も両方の場所（`/opt/homebrew/bin/node` と `/opt/homebrew/opt/node@22`）を探すので、`brew link` は要らない。
探す場所に無い入れ方をした人には、README で `nodePath` の指定か `brew link --overwrite --force node@22` を補足として案内する。
移動を先に置くのは、検疫属性が付いたまま開くとアプリの案内より先に Gatekeeper のダイアログが出るからである（2026-09-20 の実測）。
配布物は dmg が主で、zip は従（自動更新と予備）である（段 5 の決定）。
Release の資産は `Hangar-<タグ>-macos-<arch>.dmg` と `.zip`、それぞれの `.sha256` である。
dmg の中身は `.app` と `/Applications` へのリンクの 2 つだけで、`apps/desktop/scripts/make-dmg.sh` が hdiutil で作る。
tauri の dmg ターゲットは使わない。
tauri の dmg は build の途中の `.app` を詰め、`tauri bundle --bundles dmg` も `.app` を作り直してから詰めるので、build の後で署名した `.app` が入らないからである（2026-10-10 に手元で確かめた）。
Finder を AppleScript で動かさないので、窓の並びは決めず、窓の無い CI でも同じに作れる。
利用者の手順（dmg から `/Applications` へドラッグし、初回の警告を「完了」で閉じ、システム設定の「プライバシーとセキュリティ」の「このまま開く」と管理者のパスワードで越える）は README の「入れる（macOS）」にある。
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
- **フェーズ 4**：クラウド同期。
  Worker と D1 と R2 の setup、メタデータと本文と Claude Code 設定の同期、無料枠の見張り（段 1 で消し、上限で退く形に替えた）、他端末のロックと「この PC で再開」まで実装した。
  引き継ぎの握手は、このフェーズでは作らなかった（段 1 で作らないと決め、2026-10-16 に停止を頼んで引き継ぐ形で入れた）。
  計画は `docs/plans/phase4-sync.md`、実物での確認は `docs/plans/phase4-real-run.md`。
- **フェーズ 5**：デスクトップ配布。Tauri v2 のシェル、サーバの同梱と子プロセスとしての起動、Node の探索、`hangar://` のディープリンク、タグから `.app` を作る Releases のワークフローまで実装した。公証は行わず、自作の証明書で署名する（段 5 で加えた。「署名の身元」と「Gatekeeper」の項）。計画は `docs/plans/phase5-desktop.md`。

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
  文は、DB の版と起点の版を言い、DB を別の名前に退避してから起動し直せば索引をトランスクリプトから再構築すること（名前とステータスは引き継げない）を言う。サーバも CLI もそれを出して起動を止める。
  以前は「畳む前の版の Hangar で一度起動して上げてから」と言っていたが、配布版ではその版が手に入らず、起動の失敗の札の手順（退避して作り直す）とも食い違っていた（2026-10-11、Windows の実機の確かめで見つけた）。
  使っているのは利用者 1 人で、その DB はすでに版 16 にあるので、古い版から上げる道は要らないと決めた。
  スキーマを変えるときは、起点を書き換えずに、次の版（17 から）を一覧の末尾に足す。
  版 17 は、セッションの名前とメモを `session_notes` へ移した（「セッションの名前」）。
  版 18 は、設定の同期の作り直し用に `config_snapshots`（共有）、`config_base`、`config_unsent`（端末ローカル）を足した（「設定の同期の作り直し」）。
  版 19 は、旧実装の設定の同期が端末に残した記録（`file_sync` の kind が `config` の行と、`sync_state` の `configPullConfirmed`、`configPending`、`skipped:(config)`）を消した（「設定の同期の作り直し」の「旧実装の削除（PR 18）」）。
  版 20 は、`todos` に Claude の提案の 2 列（`suggested_at`、`suggested_note`）を足した（「TODO の提案」）。
  版 22 は、中断の再開と同じファイルの編集の警告に使う端末ローカルの表（`interrupted_runs`、`run_last_live`、`session_overlaps`、`overlap_dismissals`）を足した（「中断と再開」「同じファイルの編集の警告」、0.5.0）。
  版 23 は、使用制限で止まっているセッションを持つ端末ローカルの表（`session_limits`）を足した（「止まっている理由」、0.5.0）。
  版 25 は、`session_states` に利用者が移した先（`project_id`）と削除の印（`trashed_at`）を足した（「セッションを別のプロジェクトへ移す」）。
  版 27 は、`session_states` に明示の復元の時刻（`restored_at`）を足した（「セッションの削除」の「生き返らない」）。
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
- statusline の追記先：`~/.claude/settings.json` の `statusLine.command` を引用符を考えて語に分け、先頭の `bash`、`sh`、`zsh`（絶対パスでもよい）を除いた最初の語（`pwsh` と `powershell` は `-File` の後ろの語）を、`~` と環境変数を展開して読み、ファイルとして存在すればそこへ追記する。UTF-8 でないファイルには追記しない。存在しなければ追記せず、スニペットと手順を印字する。追記位置は 1 行目が `#!` で始まればその直後、そうでなければ先頭で、目印の行があって中身も今の形と同じなら何もしない。バックアップは同じディレクトリの `<name>.bak-<yyyymmddHHMMSS>`。
- statusline のスニペットは、`${HANGAR_HOME:-$HOME/.agent-hangar}/statusline-header` を `curl -H @<ファイル>` で読む。ファイルには `Authorization: Bearer <トークン>` の 1 行が入り、権限は 0600 である。読めないときは何も送らずに素通しする（`if [ -r ... ]` で包む）。ポートは追記時の値を埋め込む（`hangar statusline install --port <n>`）。`exec <<<` を使うので、追記先のスクリプトは bash か zsh である必要がある。
- ヘッダのファイルを用意する場所：`hangar statusline install` と、サーバの起動時の両方で用意する。起動時はトークンを読むのと同じところで、無ければ作り、トークンと食い違えば書き直し、他人に読める権限なら 0600 へ狭める。中身も権限も揃っているときは触らない（毎回書き直すと mtime だけが動く）。install のときにしか置かないと、`~/.agent-hangar` を消した利用者の使用量が、何のエラーも出ないまま止まる。
- 入っているスニペットの差し替え：目印の行があるだけでは何もしないとせず、目印から `exec <<<"$__hangar_input"` までの範囲を読み取り、今の形と違えばその範囲だけを差し替える。トークンを argv に載せる古い形が残り続けないようにするためである。目印はあるのに終わりの行が見つからないときは、手で書き換えられているとみなして何もしない。
- jsonl の使用量の集計：端末ローカルの `usage_daily(session_id, day, file_path, input_tokens, output_tokens)` を索引化のときに埋める。鍵は（`session_id`、`file_path`、`day`）で、索引の作り直しではそのファイルのぶんだけを消してから積み直す。主線とサブエージェントは別のファイルなので、片方を積み直しても他方の集計は残る。`day` はイベントの `timestamp` をローカル時刻で `YYYY-MM-DD` にしたもの。プロジェクト別は `session_stats` のトークン数を `sessions.project_id` で束ねる。推定コストは価格表を持たず、statusline の `cost.total_cost_usd` を持つセッションの和だけを出す（1 件も無ければ null）。
- アーティファクトの抽出：`Artifact` ツールの呼び出しを `artifact_calls(tool_id, session_id, file_path, description, favicon)` に控え、結果の本文から URL を取り出せたときだけ公開とみなす。記録するのは `action` が無いか `publish` のときだけで、`read` や `list` は公開ではない。`artifacts` は URL で 1 件にまとめ、`first_published_at` は最小、`last_published_at` は最大を保ち、説明と favicon は新しい公開の値で上書きする。
- アーティファクトの版：`artifact_versions` は（`artifact_id`、`session_id`、`published_at`）が同じ行が既にあれば追加しない。索引の作り直しでは版を消さず、同じ行を書き直すだけにする。消すとサブエージェント由来の版が巻き添えになり、`changes` にも削除が残らないためである。版はアーティファクト単位で引くので、`artifact_versions(artifact_id)` に索引を置く。
- アーティファクトの題名：表示のたびに計算せず、公開を記録するときに決めて `artifacts.title` に書く。元ファイルがあれば先頭 64KB の `<title>`、無ければ説明文の先頭 60 字を使う。手で足した URL は題名 null で、UI は URL の末尾を出す。
- TODO の並び：`position` は追加のたびにそのプロジェクトの最大値（削除した行も含む）に 1 を足し、番号を再利用しない。削除は論理削除。`todos.session_id` はセッション別 MCP URL の `update_project` から足したときだけ入る。
- TODO の並べ替え：`POST /api/projects/:id/todos/order { ids }` は、そのプロジェクトの未完（提案を除く）の新しい並びを受け、そのプロジェクトの `TodoDto[]` を返す。番号を新しく作らず、渡された行の今の `position` を昇順に並べたものを、新しい並びに配り直す。番号を再利用しない決まりと、最大値をそのまま保つためである。番号の変わった行だけ書く。プロジェクトの外の ID、消した行、見つからない ID、重複、提案の行が混ざれば、何も書かずに 409 を返す（画面の一覧が古いとき）。
- TODO の文言：`PATCH /api/todos/:id` は `{ done?, text? }` で、どちらか、または両方を受ける。どちらも無ければ 400、`text` が空白だけなら 400（`todo.error.emptyText`）。前後の空白は落とす。提案の行も文言は直せるが、`done` を含む要求は提案の行には 409 で、文言も書かない。
- TODO の取り消し：`POST /api/todos/restore { todos: TodoDto[] }` は、画面の取り消し（⌘Z）のために、渡した中身へ戻して `TodoDto[]` を返す。保存してある行（消した行も含む）を ID で引き、`text`、`done`、`position`、完了の候補の 3 列、提案の 2 列を渡された値に戻し、`deleted_at` を null にする。`rejected_sessions` と `project_id` は変えない。読むのは `id`、`projectId`、`text`、`done`、`position`、`candidate`、`suggestion` だけである。完了かつ候補、完了かつ提案は完了を正とし、提案かつ候補は提案を正とする。見つからない行か、渡された `projectId` が保存してある行と違う行が 1 つでも混ざれば、何も書かずに 409 を返す。中身の型が崩れていれば 400 である。1 つのトランザクションで書く。並べ替えの取り消しは一覧の全部を戻すので、本文の上限は TODO 1 件の上限（4 KB）の 128 件ぶん（512 KB）にしてある。
- TODO の提案：`todos` に `suggested_at`、`suggested_note` の 2 列を足した（マイグレーション version 20）。`suggested_at` が null でなければ、Claude が MCP の `update_project` の `add_todos` で足した提案で、利用者はまだ受け入れていない。`suggested_note` は理由で、無ければ null。MCP から足した TODO はすべて提案で、確定の TODO を足すのは利用者（`POST /api/projects/:id/todos`）だけである。提案は `TodoDto.suggestion`（`{ note, at }`）に載り、未完の数（`open_todos`）と起動時に注入する未完の TODO には入らない。受け入れは `POST /api/todos/:id/accept` で、提案の列を消し、`position` を削除した行も含めた最大値の次にして一覧の末尾へ入れる（提案でなければ 409）。見送りは削除（`DELETE /api/todos/:id`、論理削除）である。提案の行は完了の候補にも完了にもならない。`proposeTodoDone` は書かずに `not_accepted` を返し、`confirmTodo` は `not_accepted`（HTTP では 409）、`setTodoDone` は書かずに今の行を返す。`done = 1` かつ `suggested_at` 非 null の行は完了として読み、提案は無いものとする。提案かつ候補の行は、提案として読み、候補は無いものとする。同期は版 10 と同じく行を JSON の payload のまま運ぶので、クラウドにマイグレーションは要らない。列を持たない古い端末は、適用のときに自分の表に無い列を捨てるので、提案を確定の TODO として見せる。
- TODO の完了の候補：`todos` に `candidate_at`、`candidate_session_id`、`candidate_note`、`rejected_sessions`（却下したセッション ID の JSON 配列、既定は `'[]'`）の 4 列を足した（マイグレーション version 10）。`candidate_at` が null でなければ候補で、候補は必ず未完である。MCP からは完了にできず、完了にするのは `POST /api/todos/:id/confirm` と、利用者のチェック操作である `PATCH /api/todos/:id` の `done` だけである。却下したセッションの ID は `rejected_sessions` に積み、そのセッションからは同じ TODO の候補を出し直せない（別のセッションなら出せる）。セッション別でない URL から出した候補は、却下してもセッション ID が無いので積まれず、出し直せる。`setTodoDone` は完了にも未完にも戻すときにも候補の列を消し、`rejected_sessions` は完了を開き直しても消さない。同期は行を JSON の payload のまま運ぶので D1 にマイグレーションは要らず、列を持たない古い端末は適用のときに自分の表に無い列を捨てる。`done = 1` かつ `candidate_at` 非 null の行が届いたときは、読むときに完了として扱い、候補は無いものとする。
- メモの正：`project_memos.markdown` とファイル `~/.agent-hangar/projects/<projectId>/memo.md` の両方に書く。読むときはファイルの mtime が DB の `updated_at` より新しく中身が違えばファイルを正として DB を直す。`~/.agent-hangar/projects/` を `fs.watch`（再帰）で見て、300 ミリ秒のデバウンスで取り込む。取り込みは `project_memos` の行を書くので、`memo.update` と `project.upsert` は配る層が配る（「行の変化の知らせと配る層」）。`memoHead` は空行でない最初の行の先頭 80 字で、全文は `GET /api/projects/:id/memo` で読む。DB を正として書き戻すときは、ファイルの中身が DB と違うときだけ、消える本文を `memo.md.bak-<yyyymmddHHMMSS>` として同じディレクトリに残してから書き戻す。同じ秒に 2 度来たら連番を足し、既にある控えは上書きしない。控えは古くなっても消さない。控えを残せなかったときは書き戻さず、ファイルの方を残す。
- スクラッチの擬似プロジェクト：端末ごとに 1 つで、DB の名前は「スクラッチ」（同期で端末をまたぐ値なので、これは変えない）、この端末の `project_roots.path` は `~/.agent-hangar/scratch`。ディレクトリ名は `<yyyymmdd-HHmmss>`（ローカル時刻、同じ秒に 2 つ作るときは `-2`、`-3`）。Projects 画面の表と、新しいセッションのダイアログのプロジェクトの選びにはこの行を出さず、ホームの絞り込みのプロジェクトの選びには出す。
- 擬似プロジェクトの表示名：画面に出す名前は DB の名前ではなく辞書の `project.name.quick`（日本語「クイックセッション」、英語「Quick sessions」）で、いまの言語で出す。`projectDisplayName`（`presenters/projectName.ts`）を通し、一覧の行、絞り込みの選択肢と条件、欄の `project:` の語、プロジェクト画面の見出し、セッション画面の親のリンク、ホームの札、パレットの副題、設定の使用量の表がそろって同じ名前になる。
- スクラッチかどうかの判定は、スクラッチのルートの下にあるかで行い、ルート自身は含めない。`scratch_root` は `project_roots` を端末で絞って引く。
- 昇格：`POST /api/sessions/:id/promote { name, gitInit, moveFiles, parent? }`。`name` は `/` を含まない 1 字以上で、`<parent か workspaceRoot>/<name>` が既にあれば 409。作成場所が空で `parent` も無ければ 400。移動は先に全件の衝突を調べてから `fs.renameSync` で行い、途中で失敗したら逆順に戻す。`moveFiles` が真でも run が生きていれば移動せず、`moved: false` と理由を返す。
- プロジェクトの作成：`POST /api/projects` は本文を 2 つの形で受ける。`{ kind: 'newDir', name, gitInit, parent? }` は `<parent か workspaceRoot>/<name>` を作り（作成場所が空で `parent` も無ければ 400）（`git init` は選ばれたときだけ）、プロジェクト行とこの端末の `project_roots` を作って 201 を返す。名前の検証、既にあれば 409、`git init` に失敗したら作ったものを片付けることは、昇格と同じ `createProjectDir` を通る。`{ kind: 'dir', path, name? }` は既存のディレクトリを登録し（`registerProjectDir`）、新しければ 201、登録済みなら 200 で既存を返す。名前を省くと basename になり、アーカイブされたプロジェクトなら Active に戻す。先頭の `~/` はホームに直し、相対パスと、作成場所やその上のフォルダ、ファイルシステムの根、ホームフォルダは 400 で断る（作成場所が空でも根とホームは断る）。ルートを登録すると最も長い一致でワークスペースの下のセッションをすべて取り込み、直下のフォルダの自動の登録も止まるためである（Finder で何も選ばずに「開く」を押すとルートが返る）。`kind` の無い本文は 400 で断る。
  `kind: 'dir'` は `allowNested` と `linkTo` も受ける（0.6.1）。登録済みのプロジェクトの下のフォルダで `allowNested` が無ければ 409（`ProjectNestedDto`）、`linkTo` はほかの PC から届いたプロジェクトへの結び付けである（「フォルダとプロジェクトの結び付き」）。
  `kind: 'dir'` で登録したら、その下で動いた未分類のセッションをその場で紐づける（`assignSessions`、2026-10-13）。
  以前は呼んでおらず、次の起動まで未分類のまま残っていた。
  すでにほかのプロジェクトに入っているセッションは動かさない。
- 会話したフォルダの候補：`GET /api/workspace/candidates` は `{ candidates: { path, sessionCount, lastActivityAt, worktreeCount }[], suggestedRoot }` を返す（初日のプロジェクト。上の「プロジェクトの登録」の規則）。`POST /api/workspace/register { paths }` か `{ items: { path, linkTo?, allowNested? }[] }` は 1 件ずつ `registerProjectDir` で登録し、最後に `assignSessions` で未分類の会話を紐づけ直して `{ projects, failed: { path, error }[], linked }` を返す（登録できないものがあっても断らない。500 件まで）。
  候補の 1 件には `recentTitles`、`isGit`、`gitRemote`、`enclosedBy`、`cloudSynced`、`notes` を、上の段には `unassignedTotal` と `workspaceRoot` を足した（2026-10-15、hangar project candidates が読む。上の「プロジェクトの登録」の規則）。
  登録の応答には、行ごとの結果 `results: FolderRegisterOutcomeDto[]`（本文の並び。`status` は `added`、`already`、`linked`、`nested`、`error` で、名前、その場で紐づいた未分類の会話の数、アーカイブから戻したか、包むプロジェクト、理由を添える）を足した。
  本文に `dryRun: true` を付けると、何も書かずに `{ dryRun: true, results }` だけを返す（`tryWrites`）。
- 一覧から削除の試し：`POST /api/projects/:id/resolve` の `{ kind: 'unlink', dryRun: true }` は、何も書かずに `{ dryRun: true, id, name, path, sessionCount, syncing }` を返す（未分類に戻る会話の数と、同期を使っているか）。
  `dryRun` は `unlink` だけで受け、ほかの `kind` は 400 である。
  本番の `unlink` の応答にも `sessionCount` を足した。
- 作成場所の試し：`PATCH /api/settings` の `{ workspaceRoot, dryRun: true }` は、保存と同じ検証（無いパス、ディレクトリでないパス）を通してから、保存のときに自動で登録される直下のフォルダを `{ dryRun: true, workspaceRoot, previous, unchanged, register }` で返す（`registerMany.ts` の `workspaceSyncOutcomes` を `tryWrites` で包む）。
  `dryRun` は `workspaceRoot` だけの本文で受け、ほかの欄が混ざれば 400 である。
  いまと同じ値なら自動の登録は走らないので `register` は空である。
- フォルダの中から：`GET /api/workspace/children?parent=` は親の直下の一覧（`WorkspaceChildrenDto`）を、`GET /api/workspace/inspect?path=&name=` は 1 つのフォルダの入れ子と結び付く候補（`FolderInspectDto`）を返す（「フォルダとプロジェクトの結び付き」）。
- 未登録のフォルダの一覧：`GET /api/workspace/dirs` は、ワークスペース直下の隠しでなく、この端末で登録済みのルートに当たらないディレクトリを、名前順に `{ name, path }[]` で返す。比較は `normalizeDir`（NFC）でそろえる。一覧から削除したプロジェクトのフォルダは、ルートが論理削除されているので未登録に数える。
- その場の登録：サーバの `sessionChanged` で、未分類のセッションを紐づけられなかったとき、cwd がワークスペース直下のディレクトリ（またはその下）で、実在し、隠しでなく、まだ登録されていなければ、起動時の `syncProjectsFromWorkspace` と同じ規則でプロジェクトにし（`registry.ts` の `registerWorkspaceChildOf`）、紐づけ直して `project.upsert` と `session.upsert` を配る。同じセッションで何度も試さない。起動の途中は行わない（起動時の全走査は `syncProjectsFromWorkspace` が受け持つ）。当たらなかった cwd だけが、これまでどおりトーストで知らされる。
- フォルダ選択の殻の命令：`pick_folder(default_path)` は `blocking_pick_folder` で macOS のフォルダ選択を開き、選んだパスか、取り消しなら null を返す。頁に与える権限は `allow-pick-folder` の 1 つだけで（`capabilities/remote-pick-folder.json`）、プラグインの JS の権限は与えない。UI の `DesktopBridge.pickFolder` は殻の外では口が無く、Finder の操作を出さない。
- `SessionDto.fromScratch`：cwd がスクラッチのルートの下で、属するプロジェクトがスクラッチでないときに真にする。セッション画面は真のとき「再開しても作業ディレクトリはクイックセッションの置き場のままです」を添える。
- 分割の持ち方：`SessionViewState` に `split: boolean` と `splitTab: string | null` を持つ。左は選択中のタブ、右は `splitTab` で、幅は `SplitPane` の中の状態にして保存しない（0.5 に戻る）。分割の右に置いたタブが閉じたら `splitTab` を null にし、`split` も偽に戻す。
- 分割にタブが 2 つ要ることの判定は、Mediator がストアのタブの並びを読んで行う。右に置けるタブがあれば状態を変え、無ければトースト「横に並べるにはタブが 2 つ必要です」を出す。
- パレットの項目の ID：セッション（`session:<id>`）、移動（`go:home`、`go:projects`）、設定の節（`settings:<節>`。節は `general`、`cloud`、`integrations`、`summary`、`tools`、`info`、保持は `retention` で一般の節へ移る）、コマンド（`cmd:next-waiting`、`cmd:sidebar`、`cmd:shortcuts`、`cmd:new-session`、`cmd:new-project`、`cmd:new-scratch`、`cmd:rebuild-index`）、ホームへ渡す行（`search:<語>`）。新しいセッションは、Mediator がストアを見ないので、presenter が最初に選ぶものを ID の後ろに載せる（`cmd:new-session:project:<id>` か `cmd:new-session:scratch`）。照合は部分列一致で、一致位置が前で連続しているほど高い点を付け、群の中は点の高い順（同点は最後の活動の新しい順）に並べる。群の分け方と上限は「骨格」の節に書いた。入力欄の文字は Root の `useState` が持ち、Mediator には入れない。
- hangar が自分で行うことの設定：`SettingsDto` に `autoDone`（止まった会話を自動で Done にする、既定 true）、`autoDoneIdleDays`（長く動いていない会話を Done にする日数、3・7・14・30・0、既定 7。知らない古いサーバは返さないので画面は 7 に寄せる）と `autoPark`（Done と Archived にした会話の Claude を停止する、既定 true）を持つ。
  受け方と読み方は下の `askStatusAtEnd` と同じで、設定の画面では一般の節の「hangar が自分で行うこと」に置く。
- 起動する claude に足す指示の設定：`SettingsDto` に `askStatusAtEnd`（区切りで Done か Paused を聞く段、既定 true）と `liveHints`（ターンの意図と短い手の説明の段、既定 true）を持つ。
- 既定のモデル：`SettingsDto` に `defaultModel`（既定 null で、null は Claude Code の既定）を持つ。新しいセッションのモデルの札の初期値で、プロジェクトの前回値が先である。名前は `isModelName`（先頭のハイフンと空白を断る）で確かめる。
  `PATCH /api/settings` は真偽値だけを受け、ほかは 400 で断る。
  鍵の無い設定ファイルと、手で書いた真偽値でない値は true として読む。
  設定の画面にはまだ出さない（「指示の注入」の節）。
- 要約器の設定：`SettingsDto` に `summaryEngine`（`off`、`claude`、`openai`。既定 `off` で、鍵の無い古い設定も `off`）、`summaryClaudeModel`（既定 haiku）、`lmStudioUrl`（OpenAI 互換の URL。既定 `http://127.0.0.1:1234`）、`lmStudioModel`（既定 null で、null なら `/v1/models` の最初のモデル）、`summaryApiKeySet`（API キーを保存しているか。キーは `PATCH` の `summaryApiKey` で書くだけで、返さない）、`summaryFallback`（既定 false）、`summaryHourlyCap`（既定 20）、`allowExternalSummarizer`（既定 false）を持つ。
- 要約の入力：主線の全イベントを読み（サブエージェントは含めない）、`user` は 2,000 字、`assistant` は 600 字、`tool_call` は 1 行に切り、`thinking`、`tool_result`、`system`、`meta` は捨てる。全体が 12,000 字を超えたら先頭 30% と末尾 30% を残し、中盤を「[... N 件を省略 ...]」に置き換える。
- 要約ジョブの契機：run の終了と、セッション画面を開いたときの先頭ページの読み込みの 2 つで `enqueue` する。受け付けるのは要約が土台のままか最後の更新から 5 ターン以上進んだときだけで、実行中のセッションは受け付けない（セッション自身の `set_session_summary` に任せる）。run の終了からの `enqueue` は `ignoreLive` で生存判定だけを飛ばし、残る 2 つの判定は通す。「要約を作り直す」は条件を無視する。ジョブは 1 セッション 1 件で、直列に走る。
- 要約の配信が失敗しても待ち行列は進める。配信の失敗は 1 行だけ記録し、次のジョブを止めない。
- Claude への切り替えの上限：呼び出しの時刻をメモリに持ち、直近 1 時間の件数が上限に達していれば使わない。週の枠の使用率が 80 以上でも使わず、`claude` が PATH に無ければ使わない。サーバを再起動すると件数は 0 に戻る。
- MCP の `update_project` の TODO の書き込みは、全部成功か全部失敗のどちらかにする。途中で失敗したものが残ったままイベントだけ配られないようにするためである。
- `GET /api/bootstrap` は `accounts`（使用率はアカウントごとにここに載る）、`todos`（全プロジェクトの未削除）、`artifacts`（全件）、`summaryPending`（作成中のセッション ID）も返す。メモの全文は含めない。
- UI の CSS は `base.css` に足さず、View ごとのファイル（`workbench.css`、`split.css`、`rows.css`、`palette.css`、`settings.css`）に分けて `main.tsx` から `base.css` の後に読み込む。
- 要約の出所：`session_summaries.source_id` に書いた要約器の id（`lmstudio` か `claude-headless`）、`source_model` にモデルの名前だけを置く。土台の要約とセッション自身の要約はどちらも null にする。`source_id` が無かった頃の行は null のままにして、UI は要約器を「不明」と出す。モデル名から種類を推し量って焼き付けることはしない。
- サーバの終了：`close()` は HTTP と WebSocket を畳んだ後、走っている要約のジョブが終わるまで最大 5 秒待ってから DB を閉じる。要約は DB に書き込むので、待たずに閉じると閉じた DB に触れることになる。5 秒で終わらなければ 1 行記録して待たずに閉じる。
- 未分類のセッション：起動した後に、どのルートの配下にもない cwd のセッションが現れても、トーストは流さない（2026-10-10 に外した。事実は一覧に出るので、注意の行にもしない。「注意と知らせの出し分け」の節）。ワークスペース直下のディレクトリはその場でプロジェクトにし（2026-10-01 に改めた）、ワークスペースの外では勝手にプロジェクトを作らない。
- ルートの復帰：消えていたディレクトリが戻ってルートが解決に戻ったら、その時点で未分類だったセッションを紐づけ直し、紐づいたセッションの `session.upsert` と、戻ったぶんおよび中身が変わったぶんの `project.upsert` を配る。戻ったルートが 1 つも無いときは何もしない（起動時の 1 回目はたいていこちらを通る）。
- 外部のターミナルで開くときの shell：`cd <dir> && exec "${SHELL:-/bin/zsh}" -l` は `.command` の中にだけ書き、Terminal.app も iTerm2 もその `.command` を実行させる。iTerm2 へ構文を直に渡すと窓ができない（2026-10-11 に実測。パスに空白と `'` があっても、この形ならそのフォルダで開く）。`$SHELL` が無い環境では `/bin/zsh` に落とす。
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
- 引き継ぎの握手は、はじめは作らなかった（2026-09-19 の判断）。
  段 1 で型と共有テーブルの一覧からも外した。
  2026-10-16 に、頼まずに奪うのではなく、相手に停止を頼んで最後の本文が降りてから引き継ぐ形で入れた（`EndReason` に `taken_over`、共有表 `takeovers` と `takeover_answers`、互換の版 6）。
- ロックは他端末の生きた run で引き、相手の生死では解かない。
  その PC の年齢（pull の応答の `peers`）が 3 分を超えたら `stale` を立てる（同期の版 6。版 5 までは `heartbeat_at` で 2 分）。
  `stale` のときは頼まずに引き継げ、生きているときは停止を頼んでから引き継ぐ。
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
- 1 回の push は 40 行まで、1 回の pull は 500 行まで、push の最小間隔は 10 秒。ローカルの `changes` は push 済みで 7 日で刈る。Worker は変更ログを持たず、`rows` の連番で差分を引く（同期の版 6）。
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
  掃除が拾うのは索引に無い本体と、本体の無い索引の行と、削除の印から 30 日たったセッションの写しだけで、ほかに索引に載っている他端末のファイルは消さない。
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
  削除したセッションの写しの掃除も、ローカルの workerd の試験だけで確かめた（2026-10-16）。
  上限で退く処理も、偽のクラウドと手元の Worker の前に置いた中継（段 1 の PR 5 の試し）でだけ確かめた。
  実物の Cloudflare では動かしていない。
- 既知の限界：フェーズ 4 の実物確認は、1 台の Mac の上で `HANGAR_HOME` と `HANGAR_CLAUDE_DIR` を分けて 2 端末を模して行った（2026-09-19 の決定）。実際に別のマシンから参加することは確かめていない。
- 配布版の同梱形態：サーバと CLI を esbuild で単一ファイル（`server.mjs`、`cli.mjs`）にまとめ、UI、ネイティブモジュール、`bin/hangar`、`cloud/`、`manifest.json` とともに `.app` の `Contents/Resources/server/` へ置く。
  `cloud/` には、Worker を 1 本に束ねた `worker.mjs` と、その束縛の定義 `metadata.json`（互換の日付と旗、D1 と R2 の束縛の名前）だけを置き、源は置かない。
  `cloud/` は段 5 で Cloudflare の REST から Worker を上げるための下地で、いまは誰も読まない。
  UI の sourcemap は入れないので、実測で 6.5MB である。
  Node 本体は同梱しない。
- Node の版の規則：同梱のネイティブモジュール（`better-sqlite3` 13、`node-pty` 1.1）は Node-API の prebuild で、Node の ABI（`NODE_MODULE_VERSION`）には縛られない。
  `better-sqlite3` は Node-API 10 の関数を使う（`NAPI_VERSION=10`）ので、要るのは `process.versions.napi` が 10 以上の Node（22.14 以上。23 の系列では 23.6 以上）で、アーキテクチャが同じものである。上限は付けない。
  手元で 0.6.0 の束を読ませて確かめた（2026-10-13）。Node 24.21（modules 137）と 22.14（Node-API 10）では SQLite の読み書きと `node-pty` の spawn が動き、Node 20.18（Node-API 9）は異常終了した。
  0.6.0 までは「Node の ABI に縛られる」とみなして `manifest.json` の `nodeMajor`（22）と同じメジャー版だけを採っていたため、Node 24 だけがある PC で起動できなかった（2026-10-13 の報告）。
  規則の値は `packages/server/src/config/nodeRule.ts` の 1 か所で決める（`NODE_API_MIN` = 10、`NODE_MIN_LABEL` = `22.14`）。
  `bundle-server.ts` はこの値を `manifest.json` の `nodeApi` と `nodeMin` に書き、殻（`node.rs`）と `hangar.sh` は `manifest.json` を読んで同じ規則で比べる。`launch-cli.ts` と設定の確かめ（`config/node.ts`）は `nodeRule.ts` の関数をそのまま使う。
  `nodeMin` は案内に出すだけで、比べるのには使わない（比べるのは Node-API の版）。
  候補に訊く式も 1 つで（`node -p` に `NODE_PROBE_EXPR`、答えは `v<版> <アーキ> <Node-API の版>`）、殻、`hangar.sh`、設定の確かめ、`launch-cli.ts` が同じ式と同じ読み方を使う。
  規則が各所で同じであることは、見本の表（`packages/server/src/config/node-rule-cases.json`）を各所の試験（`node.rs`、`nodeRule.test.ts`、`bundle-server.test.ts` の `hangar.sh` と `chooseNode`）が読んで縛る。
  Node-API が足りず、アーキテクチャも違うときは、版が古いと言う（どこでも同じ順）。
  候補の順と先頭優先は変えないので、今 Node 22 や `nodePath` を使っている人の振る舞いは変わらない。
  起動の失敗の札が殻から値を受け取れなかったときの既定（`boot-fail.js` の `DEFAULT_NODE_MIN` と `DEFAULT_NODE_API`）は、規則の値と同じにする（試験で縛る）。
  束を作る Node は `bundle-server.ts` の `BUNDLE_NODE_MAJOR`（22）に固定し、build している Node のメジャー版が違えば束を作らずに止める。
  ネイティブモジュールは Node-API の prebuild なので作る Node の版に縛られないが、CI と配布の build の道筋を 1 つに固めておくためである。版を上げるときは CI の setup-node と一緒に上げる。
  CI は Node 24 でも確かめる。`node24` ジョブがサーバの試験を Node 24 で回し、desktop ジョブが build した `.app` を `nodePath` で Node 24 を指して起こす（`ci-boot-normal-macos.sh --node`）。
  開発機の Node は、リポジトリの根の `.nvmrc`（22）で合わせる。`bundle-server.ts` の試験は `buildNodeMajor` に `BUNDLE_NODE_MAJOR` を渡し、開発機の既定の Node が 22 でなくても落ちない（違う版で止まる試験だけは違う版を渡す）。
  リポジトリの `engines`（`>=22.14`）は、ソースから動かすときのもので、規則の版にそろえる（`nodeRule.test.ts` が縛る）。
  ソースから動かすときのネイティブモジュールも Node-API 10 を使うためである。
  Node 本体の同梱は見送る（入れ物が 6MB から 40〜50MB に増え、Node の更新の責任も負う。2026-10-13 の決定）。Node を持たない人の報告が続いたら考え直す。
- `nodePath` の重さ：Settings の `nodePath` は、次の起動で `.app` がそのまま起こす実行ファイルの場所なので、設定への書き込みが次回起動時のコード実行になる。
  いま穴が開いているわけではないが、UI か API の側に穴が 1 つできたときの被害の上限がここまで上がることを、前提として書き留めておく。
- 配布ターゲットは Apple silicon の macOS 13 以降と、x64 の Windows 11 である。同梱する prebuild は target（`<platform>-<arch>`）のものだけにする。全アーキを入れると `node-pty` の win32 だけで 58MB になる。Intel の Mac と ARM64 の Windows は作らない。
  束の作り方は `apps/desktop/scripts/bundle-server.ts` の `bundleServer` が target を引数に受け取り（省略すると、この機械の target。配布の対象でなければ止まる）、別の target の束も、どの機械でも作れる。`manifest.json` の `arch` は束の相手のものを書く。
  win32-x64 の束は、macOS の `bin/hangar` の代わりに `bin/hangar.cmd` と、束の根の `launch-cli.mjs` を置き、`node-pty` のデバッグの記号（`.pdb`、22MB）を入れない。
  cmd は JSON を読めないので、`hangar.cmd` は HANGAR_NODE、PATH の各項目の `node.exe`（`where $PATH:node.exe`。作業ディレクトリは見ない）、公式の入れ先の順に Node を 1 つ見つけて `launch-cli.mjs` を動かすだけにして、版とアーキの確認と、合う Node への渡し直しは `launch-cli.mjs` が行う。
  cmd は、無いファイルと、`-p` に Node 16 以上と答えないもの（古い Node、Node でない実行ファイル）を飛ばして次の候補へ進む。
  Git Bash（Claude Code の `!` もこれを使う）は `hangar.cmd` を拡張子なしの `hangar` として探さないので、Windows の束の `bin/` には拡張子の無い sh の起動 `bin/hangar`（源は `apps/desktop/scripts/hangar-gitbash.sh`、LF のまま）も置く。
  これは HANGAR_NODE か PATH の先頭の node が Node 16 以上なら、引数を別のシェルに通さずに `launch-cli.mjs` を直接動かし、そうでなければ `cmd.exe //c hangar.cmd` に渡す。Node を探す規則は `hangar.cmd` と `launch-cli.mjs` の 1 か所に残る。
  `launch-cli.mjs` は Node 16 を target に作る（`bundle-server.ts` の `LAUNCHER_MIN_NODE`。cmd の境目との一致は試験で縛る）ので、PATH の先頭に古い Node があっても、構文の誤りで落ちずに後ろの Node へ届く。
  `launch-cli.mjs` が見る条件は、殻と同じ規則（`nodeRule.ts` の `nodeFit`。Node-API が `nodeApi` 以上で、アーキテクチャが同じ）である。
  利用者の HANGAR_NODE が無いファイルを指していれば、cmd はそれを使わずに次へ進む。値そのものは書き換えないので、`launch-cli.mjs` が調べた場所の 1 つとして「ファイルが無い」と挙げる。
  渡し直しの候補は、HANGAR_NODE、`settings.json` の `nodePath`、公式の入れ先、nvm-windows（新しい版から）、fnm、Volta、scoop（それぞれ新しい版から）、PATH の各項目の `node.exe` の順で、HANGAR_NODE のあとは殻の `windows_node_paths` と同じ並びである。
  フルパスでない候補（名前だけの `nodePath` など）は起こさず「ファイルが無い」とする。起こすと PATH から引かれ、殻が使う Node と食い違う。
  渡し直すときは、子に `HANGAR_LAUNCHED=1` を付けて、子が版の確かめを繰り返さないようにする（輪を避けるためでもある）。
  子は読んだ直後に自分の環境から消すので、`cli.mjs` にも、`hangar start` が起こすサーバ、tmux、ペインにも届かない。
  前の版の入口から起こされたサーバのために、サーバの落とし名簿（`SERVER_DROPPED_ENV`、`RUN_DROPPED_ENV`）と殻の `INHERITED_ENV_DROPPED` にも入れてある。
  残すと、ペインの中で打った `hangar` が版の確かめを飛ばし、PATH の先頭の Node で `cli.mjs` を直に読む。
  PATH は、実在する `node.exe` を PATH の順にすべて候補にする。fnm が古い版を PATH の先頭に置いていても、後ろの winget の Packages や Links、volta などにある合う版に届く（実機の A19）。
  どれも合わなければ、要る版と理由の 1 文、いま動いている Node の版、調べた場所を探した順に番号付きで挙げ、それぞれがファイルが無い、起動できない、時間内に答えない、版が古い、アーキテクチャが違う、のどれだったかを書く（`launch-cli.ts` の `describeNotFound`）。
  この入口は hangar.cmd が見つけた（合わない）Node で動いているので、次の一手は殻の札の古い Node があるときと同じ順にする。
  公式の zip を別のフォルダに展開する道を先に、nvm-windows を添え、HANGAR_NODE か `nodePath` での指し方を続け、今の Node を置き換える winget の LTS は最後に置く。
  文は日本語と英語で、言語は殻の札とサーバと同じ決め方にする（「言語の決め方」の節。`cliLanguage` が `decideLanguage` を呼ぶ）。OS の言語は表示言語で読み、地域の書式（`Intl` の既定の locale）は見ない。
  `hangar.cmd` がどこにも Node を見つけられないときの文（ASCII だけの英語）は、要る版（22.14 以上。cmd は JSON を読めないので文に書き、規則の値との一致は試験で縛る）と、winget の LTS の命令と nvm-windows を案内する。
  `hangar.cmd` は、node を起こす最後の行で `endlocal & goto #_end_of_batch_# 2>nul || ver >nul & "<node>" …` の形を使い、node が動き出す前にバッチを終える（npm の cmd-shim と同じ手、npm/cli#969）。
  cmd は行を丸ごと読んで展開してから動かすので、無い label への goto でバッチが終わっても、行の残りは動く。
  バッチが終わっているので、Ctrl+C で node が止まったあとに cmd が「バッチ ジョブを終了しますか (Y/N)?」と問わず、node の終了コードがそのまま cmd の終了コードになる。
  npm は `||` の後に `title` を置くが、端末のタブの名前を変えてしまうので、何もしない `ver >nul` にした。
  `apps/desktop/test/hangar-cmd.test.ts` が、Windows の CI で、隠したコンソールに Ctrl+C を送って、古い作りでは問いで止まり、いまの作りでは止まらないことを確かめる。
  インストーラは、`server\bin` を利用者単位の PATH（`HKCU\Environment` の `Path`）の末尾に足し、アンインストールでファイルを消したあとに外す（`hooks.nsh` の `NSIS_HOOK_POSTINSTALL` と `NSIS_HOOK_POSTUNINSTALL`）。
  Tauri の雛形では、消す前のフック（`NSIS_HOOK_PREUNINSTALL`）は、動いている殻を止めるかの確認（`CheckIfAppIsRunning`）より前に走る。そこで外していたときは、Hangar を開いたまま消そうとして確認で取り消すと、入ったままの版の `hangar` が PATH から消えたまま残った。外すのは取り消せる確認の後にし、消す前のフックでは何も書き換えない。
  書き換えは PowerShell が値の種類（`REG_EXPAND_SZ`）と展開前の項目をそのまま保って行い、NSIS の文字列（1024 字で切れる）を通さない。もう入っていれば足さず（更新でも増えない）、外すときは書き方の違う重複もまとめて外す。
  そのあと `WM_SETTINGCHANGE` を流すので、新しく開いたターミナルから `hangar` で呼べる。開いていたターミナルには届かない。
  流すのは System プラグインから呼ぶ `SendMessageTimeout` で、`SMTO_ABORTIFHUNG` を付けて固まった窓を待たない。NSIS の `SendMessage /TIMEOUT` は応答しない窓 1 つごとに上限まで待つので、実機（0.2.0-rc.4）では応答しない窓 10 個で、入れるのも消すのも約 50 秒止まっていた。
  同梱サーバ（UI の assets を含む）の置き場 `$INSTDIR\server` は、入れるとき（更新を含む）に一度空にしてから入れ、アンインストールでは丸ごと消す（`hooks.nsh` の `NSIS_HOOK_PREINSTALL` と `NSIS_HOOK_POSTUNINSTALL`）。
  Tauri の NSIS は今の版のファイルを上書きするだけで、前の版にしか無いファイル（名前に指紋の付いた UI の `index-*.js` と `index-*.css`）を消さず、アンインストーラも今の版のファイルだけを 1 つずつ消すので、更新を重ねると古い assets と `$INSTDIR` が残っていた（実機の rc.2 から rc.4）。
  消すのは、`$INSTDIR` に `uninstall.exe` があり、`server` に `server.mjs` と `cli.mjs` があって、Hangar の置き場だと確かめられたときだけである。アンインストールでは、ファイルを消す前（`NSIS_HOOK_PREUNINSTALL`）に確かめておき、消したあとで `server` を消して、空になった `$INSTDIR` を消す。利用者のデータ（`~\.agent-hangar`）には触れない。
  入れるときのフックは、Tauri が動いている殻を止める確認（`CheckIfAppIsRunning`）より前に動く。殻が動いていれば空にせず（そのあと確認で取りやめられると、入っていた版が壊れるので）、更新（`/UPDATE`）のときだけ、殻が抜けるのを 0.5 秒おきに 10 秒まで待つ。
  殻（`node.rs`）の Node の探索は Windows で、設定の `nodePath`、公式の入れ先（`%ProgramFiles%\nodejs`、`%LOCALAPPDATA%\Programs\nodejs`）、nvm-windows、fnm、Volta、scoop、PATH の順に探す。Node 本体は Windows でも同梱しない。
  fnm、Volta、scoop は、PATH を切り替える仕掛け（fnm の multishells、Volta と scoop の shim）ではなく、版ごとの実体の場所を新しい版から見る。
  fnm は `%FNM_DIR%`（無ければ `%APPDATA%\fnm`）の `node-versions\<版>\installation\node.exe`、Volta は `%VOLTA_HOME%`（無ければ `%LOCALAPPDATA%\Volta`）の `tools\image\node\<版>\node.exe`、scoop は `%SCOOP%`（無ければ `%USERPROFILE%\scoop`）の `apps\<nodejs、nodejs-lts、nodejs22 など>\<版>\node.exe` である。
  版と読む名前は `v<数>.<数>.<数>` と `<数>.<数>.<数>` だけで、scoop の `current` のような別名は実体と重なるので見ない。
- Windows（x64）の配布物は NSIS のインストーラ 1 本で、管理者権限を要らないユーザー単位のインストール（`%LOCALAPPDATA%\Hangar`）にする。`tauri.windows.conf.json` が Windows のビルドのときだけ `tauri.conf.json` に重なる（重ねるのは配布物と窓の装飾だけ）。署名はしない（2026-10-10 の決定）。作る手順は composite action（`.github/actions/windows-installer`）の 1 か所にあり、`tauri build --bundles nsis --target x86_64-pc-windows-msvc` を回し、静かに入れて同梱の `hangar.cmd` を動かし、入れた殻を起こして同梱のサーバが `127.0.0.1:4177` の `/health` に応えるまで待ってから止め、前の版の残りに見立てた古い名前の偽のファイル（`server\ui\assets\index-*.js` など）を置いて入れ直すとそれが消えていることを見て、もう一度置いてから静かに消し、`$INSTDIR` に何も残らない（`_?=` で動かした `uninstall.exe` 自身のほかは）ところまでを行う。殻が resource_dir から作ったパスで Node を起こす経路は、`hangar.cmd` では通らないので、殻そのものを起こして確かめる。殻は Node を公式の入れ先から PATH より先に探すので、このときは一時のホーム（`HANGAR_HOME`）の `settings.json` の `nodePath` で setup-node の Node を指し、殻が使った Node の版を desktop.log から読んで 22.20 以上であることを確かめる（22.20 から verbatim の主スクリプトで落ちるので、それより古い Node では回帰を捕まえられない）。
  CI の windows ジョブはこれを呼んで、インストーラを実行の artifact に 7 日だけ残す。
  入れたあと PATH に `server\bin` があり、静かに消したあと外れていることも、この段で見る。
  CI では続けて、本当の更新の経路を 1 回通す（`apps/desktop/scripts/ci-update-windows.ps1`、macOS は desktop ジョブの `ci-update-macos.sh`）。CI の中で `tauri signer generate` で使い捨ての鍵を作り、ローカルの目録（127.0.0.1 の `latest.json`）と一緒に `apps/desktop/scripts/update-rehearsal.ts` の作る設定を重ねて、版 A（今の版）と版 B（`set-version` で patch を 1 つ上げた版、build の後で戻す）を build する。本物の secret と GitHub の Release は使わない。http の目録を許す `dangerousInsecureTransportProtocol` はこの稽古の build にだけ重ね、ふだんの設定には書かない。
  入れた版 A の UI に、確認、取得、インストールを頁と同じ口で殻の命令（`update_check`、`update_download`、`update_install`）に頼む台本を差し込んで殻を起こし（配る版には入らない）、Windows は殻がインストーラを `/P /UPDATE /R /ARGS` で起こすこと、その直前（`on_before_exit`）にサーバを止めること、入れるときのフックが置き場を空にすること、macOS は `.app.tar.gz` で `.app` が入れ替わることを確かめ、起き直した殻のサーバが `/health` で版 B を名乗るまでを見る。
  Windows では、版 B が開いている間にアンインストーラを起こして動いている殻の問いで取り消し、PATH と入れた先が残ることも見る。
  タグの `release.yml` では、windows ジョブが同じ手順で作って `Hangar-<タグ>-windows-x64-setup.exe` と `.sha256` を artifact に置き、`windows-upload` ジョブが macos ジョブの後でそれを macos ジョブの作った下書きの Release に `gh release upload` で添える。Release を作るのは macos ジョブだけである。
  署名鍵があれば、build の後でインストーラに `tauri signer sign` で署名（`.sig`）を付け、`publish` ジョブが更新の目録に載せる（次の「アプリの自動更新」）。鍵は build に渡さない。
- アプリの自動更新（段 5-4、2026-10-10 の決定）：更新は「知らせて、押して入れる」で、勝手には入れない。Tauri 2 の updater（`tauri-plugin-updater`）を macOS と Windows（NSIS）の両方で使う。
  目録は GitHub の Release の最新の `latest.json`（`tauri.conf.json` の `plugins.updater.endpoints`）で、更新物は同じ所の minisign の公開鍵（`plugins.updater.pubkey`）で確かめる。
  試しの版（rc）の build だけは、`tauri.prerelease.conf.json` を重ねて、目録を固定のタグ `updater-prerelease` の Release（prerelease）の `latest.json` から引く（次の「版と試しの版」）。macOS の更新物は `Hangar-<タグ>-macos-arm64.app.tar.gz`、Windows の更新物はインストーラそのもの（`Hangar-<タグ>-windows-x64-setup.exe`、`installMode` は passive）である。
  頁は殻の 4 つの命令だけを呼ぶ（`capabilities/remote-update.json`。起動画面の札にも同じ 4 つを与える。「起動の失敗の札」の節）。`update_status` は動いている版と取得の進み、`update_check` は目録を引いて新しい版を返し、見つけた版を殻に持つ。`update_download` はそれを取得して署名を確かめて殻に持ち、`update_install` は入れて再起動する。プラグインの JS の権限は与えないので、頁から目録の URL や公開鍵は変えられない。
  殻は見つけた版から入れ終えるまでを 1 つの段（`src/updater.rs` の `Flow`。待ち、取得中、取得済み、インストール中）で持つ。
  確認は待ちのときだけ見つけた版を差し替え、取得中、取得済み、インストール中は目録を引かずに途中の版を答える。
  目録を引いている間に取得が始まっていたら、引いた答えを捨てて途中の版を答える。
  確認は UI（起動時と 6 時間おきと設定の「更新を確認」）、起動画面の札の「更新を確認」、殻自身（起動に失敗した後の 1 度）から呼ばれ、頁どうしは互いの途中を知らないからである。
  以前は取得済みの中身しか見ておらず、取得の最中の確認が見つけた版を別の Update に差し替えていた（2026-10-11、CI の通し稽古で見つけた）。
  断らずに途中の版を答えるのは、どの呼び手もその答えで困らないからである。
  起動画面は取得中なら札を崩さず、UI は新しい版ありの札を出し、押せばその版を取得する。
  取得した中身は取得済みの段に版と一緒に持ち、取得を始めた版と同じ版のときだけ受け取るので、入れる中身と版は食い違わない。
  取得済みで `update_download` が呼ばれたら取りに行かずに済んだと答え、取得の最中のもう 1 本は断る（other）。
  取得かインストールに失敗したら、見つけた版の待ちに戻る（インストールの失敗は中身を渡した後なので、取り直してから入れる）。
  失敗は殻が network、signature、permission、other の 4 つに分けて返し（`src/updater.rs` の `failure_kind`）、英語の 1 行は `desktop.log` に残す。
  再起動しても、tmux（Windows は psmux）の中のセッションは止まらない。macOS は `.app` を入れ替えてから終了の手続きを通って起き直し（子のサーバも止まる）、Windows は updater がインストーラを起こしてそのまま抜けるので、その直前（`on_before_exit`）に子のサーバを止める。
  Windows の updater は、取得したインストーラを `%TEMP%\<アプリ名>-<版>-updater-<英数字 6 字>` に置いたまま抜けるので、置き場が更新のたびに 1 つずつ残る。殻は起動のたびに別の糸で、名前の形が完全に合い、版が今の版より新しくなく、中身がふつうのファイルだけの置き場を消す（`src/tempclean.rs`）。今の版の置き場は、今の版を入れたインストーラのものである。まだ動いていて消せなければ、次の起動に任せる。
  頁の側は、状態の移り方が `store/update.ts` の `reduceUpdate`（まだ確認していない、確認中、最新、新しい版あり、取得中、準備完了、インストール中、失敗）で、Runtime が `runtime/updater.ts` で殻を呼んで Store の `update` に置く。
  確かめるのは起動したときに 1 度と、その後 6 時間おき（`UPDATE_CHECK_INTERVAL_MS`）である。取得からインストールまでの途中は確かめない。
  右下の札（`presenters/update.ts` の `presentUpdateCard`、試作は案 A2）は、新しい版あり（「ダウンロードしてインストール」「あとで」）、取得中（進みの棒）、準備完了（「実行中のセッション N 件は止まりません。再起動のあと、続きから表示します。」に「再起動して更新」「あとで」）、失敗（いまの版は変わらないことと理由に「もう一度試す」「閉じる」）を同じ 1 枚の中で移す。
  札を閉じた版は `localStorage` の `update.dismissed` に覚え、同じ版の札は 2 度出さない。次の版が出たら出す。閉じた版を設定から取得し直したら、その版の札をまた出す。確認の失敗は札にせず、設定の節にだけ出す。
  設定の更新の節（試作の「共通」）は、版と最終確認の時刻と「更新を確認」、見つけた版の行（閉じた版も出す）、「更新を通知する」のスイッチ（`localStorage` の `update.notify`、既定は入）を置き、見出しに最新、確認中、通知オフ、新しいバージョンあり、ダウンロード中、再起動待ち、失敗の札を出す。スイッチを切ると自動の確認も止まり、新しい版の札は手動で確認したときだけ出す。
  リリースノート（2026-10-17 の決定、試作の A1・B1・C1）：`docs/release-notes/<版>.md` を、Release の本文のほかにアプリの中の 3 か所に出す。GitHub Pages や Worker には置かない（GitHub の Release と同じ中身を 2 か所で配ることになり、読み手は Release を読みに行かないため）。
  md はビルドのときに `import.meta.glob` で同梱し（`lib/releaseNotesBundle.ts`）、`lib/releaseNotes.ts` が版ごとに注意（`## 更新の前に` の節の最初の段落）と要点（小見出しか、箇条書きの各項目の最初の 1 文）に読む。書き方は `docs/release.md` の「正式な版を出す」。
  設定の更新の節には、いまの版までのノートを新しい順に版ごとの 1 行で並べ、押すと本文を開く。はじめに開くのはいまの版で、注意のある版には「更新の前に」の札を付ける。見出しの右端の文字のボタンは、開いている版があれば「すべて閉じる」、全部畳んでいれば「すべて開く」になる（2026-10-17、試作の D1）。開いた版は注意と要点の箇条だけを出して行に要点の数を添え、本文は「全文を読む」で出す（要点を拾えない版は、はじめから本文）。開いている版の行は、本文を読み進めるあいだ一覧の上に貼り付く（2026-10-17、試作の L1・V1。本文を全部出すと 0.6.1 は 210 行あり、読んでいる版が分からなくなったため）。開き閉じはアプリの決まった動きで、開くと本文が伸びて入り、閉じると薄れながら畳んでから外れ、要点と全文の切り替えは高さを補間する（`growIn`、`collapseOut`、`resizeFrom`。はじめから開いている版は動かさない）。
  更新したあと初めて開いたら、右下に「更新しました」の札を一度だけ出す（`presentWhatsNew`）。前に札を閉じた版（`localStorage` の `update.seenNotes`）より新しく、いまの版までの要点を 3 つと注意を載せ、版を飛ばしたなら含む版を言う。前に閉じた版が無ければ（この仕組みが入って初めて開いた）、いまの版の分だけにする。「閉じる」か「すべて読む」でいまの版を見たことにし、「すべて読む」は札で見せた版を開いた設定の更新の節へ移る。
  上げる前のノートはアプリにまだ無いので、`publish` ジョブが正式な版の md を目録の `notes` に入れ（試しの版は空）、殻の `update_check` が版と一緒に返す（取得の途中で途中の版だけを答えるときは返さず、頁は同じ版の前のノートを残す）。「更新あり」の札は注意を黄色い地で先頭に、要点を 3 つまで載せて「ノートを読む」を置き、設定の節は見つけた版を「新しい版」の札で先頭に開いて並べる。目録が持つのは最新の版のノートだけなので、版を飛ばして上げるときの間の版の注意は、上げる前には出ない（上げた後の札には出る）。
  署名鍵（minisign）の秘密鍵は GitHub の secret の `TAURI_SIGNING_PRIVATE_KEY` と `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（Tauri が読む環境変数と同じ名前）にだけ置き、保守者のパスワード管理に控えてある。リポジトリには公開鍵だけを置く。
  更新物づくり（`createUpdaterArtifacts`）は、配る build には入れない。build は npm の script（`beforeBuildCommand`）や依存のコードを走らせるので、本物の鍵を build に渡さないためである（2026-10-11）。
  CI の更新の通し稽古（`apps/desktop/scripts/update-rehearsal.ts`）だけが、CI の中で作る使い捨ての鍵で、稽古の build に入れる。
  更新物と署名は build の後で作る。macOS は署名済みの .app を `repack-updater-macos.sh pack` が tar.gz に詰めて `tauri signer sign` で `.sig` を付け、Windows は composite action の署名の段がインストーラに `tauri signer sign` で `.sig` を付ける。鍵を受け取るのはこの 2 つの段だけである。
  `release.yml` は、Release を下書きで作り、最新にしない。macos ジョブが `.app.tar.gz` と `.sig` を、windows ジョブがインストーラの `.sig` を artifact に置き、`publish` ジョブが `windows-upload` の後で目録を作って（`apps/desktop/scripts/updater-manifest.ts`）、更新物と署名と目録を下書きの Release に添える。目録は更新物の後に添える（先に添えると、更新物がまだ無い版をアプリが知ってしまう）。
  `publish` ジョブは最後の段で、資産がそろったこと（`release-plan.ts` の `expectedAssets`）を確かめてから Release を公開し、正式な版なら最新にする。途中のジョブが落ちれば下書きのまま残るので、最新が目録の無い Release になることはない。
  本家（`release-plan.ts` の `UPSTREAM_REPO`）では、証明書の secret か更新の署名鍵が無ければ、正式な版でも試しの版でも `plan` ジョブで止める。試しの版は正式な版の通し稽古で、試す人の許可も同じ証明書で保たれなければならないからである。fork では、無いものを飛ばして警告で続ける。
- 版と試しの版（2026-10-10）：版はリポジトリのファイルで上げてからタグを打ち、タグから版を決めて build に渡すことはしない。手順は `docs/release.md` にある。
  版の在りかは 5 つ（`tauri.conf.json`、`apps/desktop/package.json`、`Cargo.toml`、`Cargo.lock`、`package-lock.json`）で、`apps/desktop/scripts/release-plan.ts` の `VERSION_FILES` が正である。`npm run set-version -w apps/desktop -- <版>` がまとめて書き換え、試験が 5 つのそろいを見る。
  サーバ（`/health`、WebSocket の `ready`、MCP）が名乗る版は、6 つ目の在りかを作らず、`apps/desktop/package.json` の版を読む（`packages/server/src/boot/options.ts`）。配布物では esbuild が束ねるときに取り込むので、build のときの版が入る。set-version で上げればサーバの版も上がり、`plan` の照合もサーバの版を見たことになる。以前はサーバが `0.3.0` を決め打ちしていて、アプリの `0.2.0-rc.1` と食い違っていた（2026-10-11）。
  `release.yml` の最初の `plan` ジョブがタグと 5 つを照らし、1 つでも違えば何も作らずに止まる。食い違ったまま配ると、目録の版とアプリの名乗る版と更新物の署名に入る版がずれるからである。
  `plan` は、タグのコミットが `origin/main` の祖先であることと、そのコミットへの main の push で走った `ci.yml` のいちばん新しい run が成功していることも確かめ、違えば止める（`release-plan.ts` の `checkCommitGate`）。release の windows ジョブは npm test を回さず、ci の windows-test ジョブが同じコミットで回したことに頼るからである。タグにビルドメタデータ（`+`）は付けない（semver の比べ方が `+` を見ず、更新として見つからない）。
  `ci.yml` の concurrency は ref ごとの group（`ci-<ref>`）で、PR は走っている run も打ち切り、main への push は走っている run を残す（`cancel-in-progress` は `false`）。GitHub は `cancel-in-progress` が `false` でも、同じ group で待っている run を新しい run が来たときに取り消すので、続けて入れた main のコミットのうち途中のものの ci は `cancelled` になり、そのコミットにタグを打つと関門が止まる。2026-10-11 からはコミットごとの group（`ci-push-<sha>`）で全部を走らせていたが、並列でマージすると main の run が 6 本重なって PR とランナーを取り合ったので、2026-10-15 に ref ごとへ戻した。タグは ci が緑になったコミットに打つ。関門が `cancelled` や `failure` で止まったら、その ci の run を Re-run して緑にしてから、release の失敗したジョブを Re-run する（`docs/release.md`）。
  `ci.yml` の Windows は、試験の `windows-test` と、Rust・インストーラ・更新の経路の `windows` の 2 つのジョブに分けて並列に回す。`windows-test` が回すのは OS で結果が割れうる project（server、desktop、cli、shared）だけで、cloud と ui と typecheck は Linux の `check` だけで回す。CI の release の build（.app、インストーラ、更新の経路の版 A と版 B）は、段の env の `CARGO_PROFILE_RELEASE_LTO=false` と `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16` で LTO を切り、`release.yml` の配布の build は `Cargo.toml` のまま（`lto = true`、`codegen-units = 1`）にする。rust-cache の保存は main だけにする（PR は main のキャッシュを読む）。2026-10-16 の実測で、CI 全体はキャッシュに当たって 23 分から 8.5 分になった。
  正式な版の Release の本文は `docs/release-notes/<版>.md` で、`plan` が場所を決め（`release-plan.ts` の `releaseNotesFile`）、macos ジョブが下書きの Release を作るときにそのまま本文にする。ファイルが無いか空なら `plan` で止める。自動生成に落とすと、PR の一覧が最新の Release の本文として利用者に見えるからである。試しの版の本文は GitHub の自動生成にする。
  タグに `-` が入っていれば試しの版で、Release を prerelease にして Release の最新にしない。安定版の利用者が引く Release の最新の `latest.json` に、試しの版を入れないためである。
  試しの版の目録の取り先は、固定のタグ `updater-prerelease` の Release（prerelease）に 1 つだけ置く `latest.json` にした。`channel` ジョブが、Release の公開の後で、試しの版でも正式な版でも、その版が今の目録より新しいか同じときだけ置き換える。試しの版の利用者は次の rc も正式な版も受け取り、古い版の再実行で巻き戻らない。
  置き換えは読んで比べて書くので、`channel` ジョブは concurrency で、どのタグの run からでも 1 本ずつ走る。今の目録が無いとみなすのは、その Release の資産に `latest.json` が無いときだけで、一覧や取得の失敗は止める（失敗を「無い」と取り違えると、古い版で置き換えてしまう）。
  取り先を版ごとの Release にせず固定のタグに置くのは、rc.1 に焼き込んだ取り先から rc.2 を見つけるためである。安定版の道（Release の最新）を固定のタグに移さないのは、すでに配った版の取り先を変えないためである。
  プレリリースの付いた版は Tauri と NSIS がそのまま受ける。NSIS の `VIProductVersion` は数字の 4 つ組なのでプレリリースの部分が落ちて `0.2.0.0` になるが、入れ替えの比べ方（`nsis_tauri_utils::SemverCompare`）と updater の比べ方は semver のままである。macOS の `Info.plist` の版は `0.2.0-rc.1` のまま入る（2026-10-10 に手元の build で確かめた）。
- Windows（x64）は、サーバと UI をソースから動かせる（`docs/superpowers/specs/2026-10-05-windows-port-m1-design.md`）。tmux の役は psmux が担う。通知は WinRT のトーストで出す（「通知」の節）。ターミナルで打った `claude` の包み（`hangar shell install`）は Windows では作らず、セッションは Hangar の画面から始める（利用者の決定）。
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
  証明書は 10 年以上の自己署名で、`make-signing-cert.sh` で利用者が一度だけ作る。秘密鍵は保守者のパスワード管理と CI の secret の 2 か所だけに置き、リポジトリには公開の証明書と指紋（`apps/desktop/signing/certificate-sha1.txt`）だけを置く。
  本番の証明書は作って CI の secret に入れてあり、指紋と公開の証明書は `apps/desktop/signing/` に置いてある。
  手元で署名する開発者は、既存の p12 を `import-signing-cert.sh` で専用のキーチェーンへ取り込む。指紋がリポジトリの値と違えば取り込まない。`make-signing-cert.sh` で作り直すと別の証明書になり、DR が変わって全員の許可が外れるためである。
  CI の署名（段 5 の 5-2）：`release.yml` の macOS のジョブが、tauri build のあとに `apps/desktop/scripts/ci-sign-macos.sh` で署名する。
  台本は secret（`HANGAR_SIGN_P12_BASE64` と `HANGAR_SIGN_P12_PASSWORD`）の p12 を使い捨てのキーチェーンに入れ、`sign-macos.ts` で署名し、終わりにキーチェーンを消す。
  p12 の証明書と、署名に入った証明書の指紋を、署名の前と後で `certificate-sha1.txt` と比べ、違えば止まる。
  secret が 2 つとも無いとき（fork や、まだ入れていないとき）は、警告を出して未署名のまま続ける。
  macOS 26 のランナーでは自作の証明書が信頼されていないと codesign が身元を見つけないので、使い捨てのランナーの中でだけ `prepare-signing-keychain.sh` で信頼と検索リストを整え、終わりに外す。
  この台本の回帰は、ci の desktop ジョブの試験（`apps/desktop/test/ci-sign-macos.test.ts`）が、その場で作った試しの証明書で拾う。
  自動更新の更新物（`Hangar.app.tar.gz` と `.sig`）は tauri build の中で署名の前の .app から詰められるので、署名の段の後で `repack-updater-macos.sh` が署名済みの .app から詰め直して `.sig` も付け直し、展開した .app の識別子と DR が保たれていることを確かめる。dmg と zip も署名済みの .app から作る。
- Gatekeeper：公証はせず、dmg（主）と zip（予備）に SHA-256 の checksum を添えて配る（2026-09-20 の決定、dmg は段 5 の決定）。自作の証明書は Gatekeeper の信頼の鎖に入らないので、署名があっても初回の警告は出る。以下の初回の警告の記述は、自作の証明書で署名した `v0.2.0-rc.4` と `v0.2.0-rc.5` の dmg を実機で見たものである。
  初回の警告は、2026-10-11 に、もう 1 台の Mac へ `v0.2.0-rc.4` の dmg をブラウザで落として入れた実機で見た。
  「"Hangar" は開いていません」と出て、ボタンは「ゴミ箱に入れる」と「完了」だけである。
  Finder の右クリックの「開く」でも同じ画面で、開く道は出なかった（macOS の版は控えていない。版によって違う可能性があるので、主の手順からは外し、効かなかったことだけを README に書いた）。
  システム設定の「プライバシーとセキュリティ」に出る「このまま開く」を押すと、管理者の名前とパスワードを求められ、入れると開けた。
  README はこの順で書いてある。
  2026-10-11 に、macOS 27.0（Gatekeeper の設定は「App Store と既知のデベロッパ」）の仮想マシンで `v0.2.0-rc.5` の dmg を撮り直した。
  警告の題、本文、ボタンと、右クリックの「開く」が効かないことは上のとおりだった。
  システム設定の「セキュリティ」の欄（見出しは「アプリケーションの実行許可」）の行は「お使いのMacを保護するために"Hangar"がブロックされました。」で、右に「このまま開く」があった。
  行の文言は macOS の版で違いうるので、README は「…がブロックされました」の行、と探しやすい書き方にした。
  署名しない Tauri の build（開発者の手元や、署名の secret の無い fork の build）は、バイナリを ad-hoc（linker-signed）にするところまでで、バンドルの封はしないので、`.app` に `_CodeSignature` は無く、`spctl -a -vv` は `code has no resources but signature indicates they must be present` で弾く。
  署名した配布版は、`sign-macos.ts` が封まで行うので、この状態にはならない。
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
