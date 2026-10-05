# Windows への移植：最初の区切り（サーバと画面）

2026-10-05。
`docs/design.md` の「配布ターゲットは Apple silicon の macOS 13 以降だけ。Intel と Windows は作らない」を、Windows（x64）についてはこの文書から順に置き換えていく。

## 利用者の要望

- hangar を Windows に完全に移植したい。WSL に載せる形や、閲覧だけの形は採らない。
- 進め方は、Tauri の殻を後回しにして、まずサーバと画面を Windows で動かす。

## 調べたこと

利用者の Windows PC（Windows 11 Home build 26200、x64）に SSH でつなぎ、2026-10-05 に確かめた。

### Claude Code

- `claude.exe` 2.1.288 が `%USERPROFILE%\.local\bin` にある。Git for Windows も入っている。
- `~/.claude/projects` のフォルダ名は、`D:\workspace\uma-uma-py` が `D--workspace-uma-uma-py` になる。
  `provider/claude-code/discover.ts` の `mangleCwd`（英数字以外を `-` にする）と一致する。
- `~/.claude/sessions/<pid>.json` の `procStart` は、1601 年からの 100 ナノ秒単位の整数（例 `134354040350009738`）である。
  プロセスの生成時刻と下の桁まで一致した。macOS の `ps` の lstart の書式ではない。
- `claude agents --json --all` は JSON を返した。

### tmux の代わり

psmux 3.3.8（Rust、ConPTY、MIT）を winget で入れて試した。

- hangar が使う命令は通った。
  `-L`、`new-session -d -s -c -x -y -e --`、`has-session -t =名前`、`list-sessions -F`、`set-option`、`show-options -s -v`、`send-keys`（キー名と `-l`）、`capture-pane -p`、`kill-session`。
- 誰もつないでいない状態で `claude.exe` を起こしても固まらなかった。
  信頼の問いに答え、日本語の指示を送って返事を受け、Ctrl+O で transcript の表示に入って戻れた。
- SSH を切ってもセッションと claude は残った。
- 利用者が Windows Terminal からつないで手で触り、動いていることを確かめた。
- psmux は `tmux` という名前でも PATH に入る。

まだ確かめていないのは、node-pty 越しの `attach`、複数の口からの同時の `attach`、fullscreen の表示での目次の跳びである。
この区切りの実装の中で確かめる。

### いまのコードの試験

main の `9c1b90f` を Windows で走らせた。依存は `npm ci --ignore-scripts` で入れた。

| 場所 | 通過 | 失敗 | 主な理由 |
|---|---|---|---|
| `packages/ui` | 1,869 | 5 | ロゴの SVG の比較 |
| `packages/server` | 1,087 | 96 | モードの検査、パスの区切り、`ps`、道具の探し方 |
| `packages/cli` | 111 | 11 | モードの検査、`ps`、zsh 前提 |
| `packages/shared` | 96 | 0 | |
| `apps/desktop` | 60 | 14 | 同梱スクリプトの prebuild の絞り込み |
| `packages/cloud` | 22 | 94 | 試験のビルド設定が `D:` のパスを解決できない（原因は 1 つ） |

- 全体では 3,540 件のうち通過 3,245、失敗 220、スキップ 75 だった。
- 素の `npm ci` は、`better-sqlite3` が node-gyp でのビルドを始めて失敗する。Python も Visual Studio のビルド道具も無いためである。
  同梱の prebuild（`win32-x64`）を使えば `better-sqlite3` も `node-pty` も動く。
- `node-pty` は起動、出力、終了の通知まで動いた。ただし端末が終わったあとも Node のプロセスが残った。
  SSH 越しの 1 回の観測で、原因は切り分けていない。

## 決定

### ねらいと範囲

Windows でサーバを起こし、ブラウザで UI を開いて、セッションを起動して端末で claude を操作できるようにする。
macOS の動きは変えない。

サーバは端末から `npm run dev` か `hangar` で起こす。止めるのは Ctrl+C である。

### OS の違いを 1 か所に集める

`packages/server/src/platform/` を作り、OS で変わる判断をここに置く。
呼ぶ側は `process.platform` を見ない。cli は server に依存しているので、同じ層を使う。

| ファイル | 役目 | いま散っている所 |
|---|---|---|
| `paths.ts` | 配下かどうかの判定、同じパスかどうかの比較 | `projects/registry.ts` の `isUnder`、`db/queries.ts`、`config/readiness.ts` の `isCommandName` |
| `exec.ts` | PATH の分け方、実行できるファイルの探し方、既知の置き場 | `config/tools.ts`、`config/readiness.ts` |
| `secure.ts` | 本人だけが読めるファイルとディレクトリの作り方、緩んでいるかの検査 | `config/paths.ts`、`config/statusline.ts`、`config/claudeJson.ts`、`launch/wrapper.ts` ほか |
| `proc.ts` | プロセスの起動時刻の取得と比較、止め方 | `runs/procs.ts` |

それぞれの決まりは次のとおり。

- **パス**
  - 区切りは `path.sep` を使う。
  - Windows では大文字と小文字を区別せずに比べる。ドライブ文字の大小もここで吸う。
  - NFC への正規化はいまのまま残す。
  - UI に出す表示用の切り出し（`split('/')`）は、この区切りでは触らない。
- **道具の探し方**
  - PATH は `path.delimiter` で分ける。
  - Windows では `PATHEXT` の拡張子を補って探す。
  - 既知の置き場は、macOS がいまの 4 つ、Windows が `%USERPROFILE%\.local\bin` と `%LOCALAPPDATA%\Microsoft\WinGet\Links` である。
  - `.cmd` は `execFile` で直に起こせないので、探した結果が `.cmd` のときの起こし方もここに持つ。
- **秘密のファイル**
  - macOS はいまのとおり、0600 と 0700 で作り、緩んでいれば直す。
  - Windows ではモードを比べない。Node は Windows でモードを 0666 か 0444 としか返さないので、比べると常に「緩い」になる。
  - Windows の置き場は `%USERPROFILE%\.agent-hangar` で、ユーザーのプロファイルの権限を受け継ぐ。この区切りでは ACL を自分で書き換えない。
- **プロセス**
  - 起動時刻は、macOS がいまの `ps` の lstart、Windows が 1601 年からの 100 ナノ秒単位の整数である。
  - Windows での取得は PowerShell を呼ぶ。1 回に数百ミリ秒かかる見込みなので、呼ぶ回数が多ければ実装の中でまとめ方を決める。
  - 比較は、どちらの書式でも文字列の一致で足りる形にそろえる。
  - 止め方は、Windows には SIGTERM が無いので、`taskkill` でプロセスの木ごと止める。

### psmux を `Tmux` クラスで使う

- `Tmux` クラス、DB の列名（`tmux_name`）、API の型、設定の項目名（`tmuxPath`）は変えない。
- 道具の探し方は、Windows では `psmux` を先に、無ければ `tmux` を探す。
- `ensureTerminalOptions` のうち、`pbcopy` はいまも macOS に限っている。
  extended-keys と Shift+Enter の割り当ては、psmux でどう働くかを実装の中で確かめ、要らなければ Windows では入れない。
- UI の文言の「tmux」と、入れ方の案内（`brew install tmux`）は、この区切りでは Windows 向けの案内（`winget install marlocarlo.psmux`）を足すだけにする。

### claude を包むスクリプト

- macOS は `hangar-run.sh` をそのまま使う。
- Windows では同じ役目を Node のスクリプト（`hangar-run.mjs`）で作る。
  役目は、標準エラーをログに複写する、開始と終了コードをログに書く、異常終了のときは Enter を待ってから閉じる、の 3 つである。
- 起こすのは、サーバを動かしている Node（`process.execPath`）である。ペインの中の PATH に頼らない。
- `HANGAR_RUN_ID` は、macOS では `env` コマンドで渡している。Windows では `new-session` の `-e` で渡す。
- シェルのタブは、Windows では PowerShell を起こす。

### 試験と CI

- 実際の不具合はコードを直す。
- Unix にしか意味のない検査（モードの値、zsh の包み、`.command` ファイル）は、Windows でスキップにする。スキップには理由を書く。
- `packages/cloud` の 94 件は、試験のビルド設定のパスの渡し方を直す。
- `packages/ui` のロゴの 5 件と `apps/desktop` の 14 件は、原因を確かめてから直す。改行コードとパスの区切りが疑わしい。
- 素の `npm ci` が Windows で通るようにする。直し方は実装の中で原因を確かめてから決める。
- `.github/workflows/ci.yml` に `windows-latest` のジョブを足し、型の検査と試験を走らせる。
  psmux を入れない CI では、tmux を使う試験はいまと同じくスキップになる。
- 開発用の npm スクリプト（`&` と `wait`、`HANGAR_DEV=1` の前置き）は、Windows でも動く形に直す。

## この区切りに入れないもの

次の区切り以降で、それぞれ設計する。

- Tauri の殻（Rust のコンパイル、Node の同梱、サーバの止め方、単一インスタンスとディープリンク）
- 通知
- インストーラ、release のワークフロー、署名
- `claude.zsh` に当たる包み（PowerShell か小さな実行ファイル）
- 外のターミナル（Windows Terminal）への受け渡し
- statusline の差し込み（いまは bash の断片）
- macOS と Windows の間の同期（ホームのパスの置き換え、別の OS の cwd、Windows で使えないファイル名）
- UI のショートカット（端末にフォーカスがあると `metaKey` しか拾わない）、フォント、macOS 向けの文言
- arm64

## できあがりの確かめ方

- macOS と Windows の両方で `npm run typecheck` と `npm test` が通る。
- Windows の CI のジョブが通る。
- Windows でサーバを起こし、ブラウザから次ができる。
  - ワークスペースの下のフォルダがプロジェクトとして並ぶ。
  - プロジェクトを選んでセッションを起動し、端末で日本語を打って claude から返事が返る。
  - 同じセッションを 2 つのタブで開いて、どちらにも画面が出る。
  - シェルのタブを足せる。
  - サーバを止めて起こし直しても、動いていたセッションにつなぎ直せる。
  - セッションを止めると、claude のプロセスが残らない。
- macOS で、いまの `/Applications` の版と同じ操作が同じように動く。

## 分かっている危うさ

- psmux は保守している人が 1 人しか確認できていない。行き詰まったときの控えは、ConPTY を持つ常駐プロセスを自前で作る案である。
  `Tmux` クラスを境目に保っておけば、差し替えはこのクラスの中で済む。
- `node-pty` で端末が終わったあとに Node のプロセスが残る件は、サーバが長く動く中で `conhost.exe` が溜まる形で出るかもしれない。実装の中で再現と原因を確かめる。
- Claude Code の日本語入力には、Windows で未解決の報告が複数ある。hangar の側では直せない。
