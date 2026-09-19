# agent-hangar

Claude Code のセッションをプロジェクト単位で束ね、起動、観察、検索、記録を一箇所で行う個人用のローカルアプリです。
設計は `docs/design.md`、実装計画は `docs/plans/` にあります。

## 現状

フェーズ 5（デスクトップ配布）まで実装済みです。
macOS の `.app` を入れると、サーバの起動をアプリに任せて使えます（配布の状況は次の節にあります）。
フェーズ 4 のクラウド同期では、自分の Cloudflare アカウントに Worker と D1 と R2 を置き、自分の端末の間でセッションのメタデータと本文と Claude Code の設定を同期できます。
フェーズ 3 までで入った、使用量、アーティファクト、TODO とメモ、スクラッチと昇格、タブの分割、事後要約、コマンドパレットと、フェーズ 2 までで入った tmux でのセッション起動、ブラウザに埋め込んだターミナル、セッション内のシェルタブ、MCP、外部アプリとの連携もそのまま使えます。
実行中のセッションを他端末から奪う「引き継ぎ」は後のフェーズで、計画は `docs/plans/` にあります。

## インストール（配布版）

対象は macOS 13 以降の Apple silicon です。
`.app` は GitHub Releases で配る予定で、最初のタグ（`v0.1.0`）はまだ打っていません。
それまでは、このリポジトリを clone して「開発」の手順でビルドしてください。
Developer ID での署名も公証もしないので、初回だけ Gatekeeper の解除が要ります。

セッションを起こすのは Claude Code 本体なので、`claude` と tmux が先に要ります（tmux は `brew install tmux`）。
どちらが入っているかは、5 段目の `hangar setup` が報告します。

1. Releases から `Hangar-vX.Y.Z-macos-arm64.zip` を落として展開します。
   checksum を確かめるには、同じ場所の `.sha256` も落として `shasum -a 256 -c Hangar-vX.Y.Z-macos-arm64.zip.sha256` を実行します。

2. 展開した `Hangar.app` を `/Applications` へ移します。

   Finder でドラッグするのが確実です。
   端末からなら `mv ~/Downloads/Hangar.app /Applications/` でも移せます。
   ただし `mv` では検疫属性が残ったままなので、次の段を必ず実行してください。

   移す前にダブルクリックしないでください。
   署名していない `.app` を検疫属性が付いたまま開くと、最初に出るのは macOS の拒否のダイアログです。
   実測では、macOS が同時に `.app` を読み取り専用の場所へ写して起動し（App Translocation）、プロセスはその写しから立ち上がりました。
   ただしウィンドウは出ず、`~/.agent-hangar/desktop.log` にも 1 行も残りませんでした。
   アプリは自分が写しの中にいると気付いたら移動を案内する画面を出しますが、その画面より先に macOS の拒否が出ます。
   写しの中ではアプリが自分の同梱物に書き込めないので、後述の検疫属性の解除も効きません。
   だからこの手順では、開く前に `/Applications` へ移します。

3. 検疫属性を外します。

   ```sh
   xattr -rd com.apple.quarantine /Applications/Hangar.app
   ```

   ターミナルを使わない道もあります。
   `/Applications/Hangar.app` を一度開き、出たダイアログを閉じてから、システム設定の「プライバシーとセキュリティ」で「このまま開く」を押します。
   macOS 14 以前では、`Hangar.app` を右クリックして「開く」を選ぶ方法も使えます。

   アプリ自身も、同梱サーバを子プロセスとして起こす前に検疫属性を外します。
   4177 で既に動いているサーバを見つけた回は、サーバを起こさないのでこの処理も走りません。
   どちらにしても、これが効くのは `/Applications` へ移した後だけです。

4. Node 22 を入れます（`nvm install 22` が簡単です）。

   アプリは Settings で指定したパス、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、nvm の入れた Node（新しい版から）の順に探し、同梱サーバと同じメジャー版で同じアーキテクチャのものだけを使います。
   Homebrew の `node` がメジャー版 22 ならそれも使われますが、`node@22` は `/opt/homebrew/bin` にリンクされません。
   その場合は、Settings 画面の「Node のパス」か `~/.agent-hangar/settings.json` の `nodePath` で場所を指定します。

5. `hangar` コマンドを使えるようにして、初期設定を走らせます。

   ```sh
   sudo ln -sf /Applications/Hangar.app/Contents/Resources/server/bin/hangar /usr/local/bin/hangar
   hangar setup
   ```

   `bin/hangar` はリンク越しに呼ばれても自分の実体を辿るので、同梱物と Node を見失いません。
   `hangar setup` は `~/.agent-hangar` を用意し、tmux と claude と code の有無を報告します。

6. `Hangar.app` を開きます。

   同じ画面はブラウザからも使えますが、入口は鍵付きの URL だけです。
   `hangar url` を実行し、印字された `http://127.0.0.1:4177/?t=<トークン>` を開いてください。
   鍵の無い `http://127.0.0.1:4177/` は 401 になり、`hangar url` を案内する画面を返します。
   実物の `.app` で、鍵付きの URL が 200 で UI を返し、鍵の無い `/` が 401 になることを確かめてあります。
   `/usr/local/bin/hangar` のリンク越しに `hangar url` を叩いても、正しい鍵付きの URL が出ます。
   4177 は同じ機械で動くどのプログラムからも叩けるので、鍵が無ければセッションの本文を誰からでも読み出されてしまうためです。
   開いた後の鍵の扱いは「UI の開き方」に書いてあります。

   `open hangar://session/<id>` のようなリンクでアプリの画面を直接開けます。
   受け付ける形は `hangar://session/<id>`、`hangar://project/<id>`、`hangar://search?q=<検索語>` の三つです。

起動の記録は `~/.agent-hangar/desktop.log` に残ります。
うまく起動しないときは、まずこのファイルの末尾を見てください。

クラウド同期の設定（`hangar setup cloud`）は、同梱の `hangar` からは通りません。
wrangler が 205MB あるので同梱していないためです。
クラウド同期を使うときは、このリポジトリを clone して `npm install` した場所から `npm run hangar -- setup cloud` を実行してください。
同梱の `hangar` は、wrangler が見つからないことを告げて止まります。

配布の版とサーバの版は別々に進みます。
`.app` は `0.1.0`、サーバは `0.3.0` です（サーバの版は `/health` が返します）。

### 実物の `.app` で確かめた範囲（2026-09-20）

ここに書いた手順は、検疫属性を付けた `.app` を `/Applications` へ移して `xattr -rd com.apple.quarantine` を実行する形で、通しで踏んで確かめました。
あわせて次を確かめています。

- Node の探索（`/opt/homebrew/bin/node` が不在の機械で `/usr/local/bin/node` の v22 arm64 が採られる）。
- ディープリンクの三つの形。`hangar://search?q=<日本語>` も符号化が往復します。
- ウィンドウを閉じたときと、アプリを強制終了したときの、同梱サーバの停止。
- 先に `hangar start` で立てておいたサーバの採用（`.app` はそのサーバを使い、終了しても止めません）。
- 4177 を別のプログラムが使っているとき、Node が見つからないときの、読み込み画面の文言。
- ブラウザからの入り口（鍵付きの URL が 200、鍵の無い `/` が 401）。
- `~/.agent-hangar/desktop.log` に鍵が出ないこと。

次の二つは確かめていません。

- App Translocation の案内の画面そのもの。
  macOS の拒否のダイアログを人が承認しないと先へ進まないので、通しでは見ていません。
- システム設定の外観をダークにしたときの見え方。
  配信される UI に `prefers-color-scheme` の規則が 1 件も無いことの確認で代えました。

ここから先の「使い方」と「使い方（フェーズ 3）」は、このリポジトリを clone した形で書いてあります。
配布版だけを入れた人は、`npm run hangar --` を `hangar` に読み替えてください（`hangar mcp install`、`hangar statusline install` のように）。
`npm install` と `npm run dev` は開発用なので要りません。

## 使い方

```sh
npm install
npm run hangar -- setup     # ~/.agent-hangar を作り、tmux と claude と code の有無を報告する
npm run dev                 # サーバ（4177）と UI の開発サーバ（5173）を起動する
```

セッションを起動するには tmux が要ります（`brew install tmux`）。
Claude Code から hangar のツールを使うには、一度だけ次を実行します。

```sh
npm run hangar -- mcp install     # user スコープに hangar を登録する
npm run hangar -- mcp uninstall   # 取り消す
```

登録は hangar が `~/.claude.json` の `mcpServers.hangar` を直接書きます。
`claude mcp add` に任せないのは、`--header` の値がコマンドの引数に載り、トークンが `ps` で同じ機械の誰からでも読めてしまうためです。
ほかの項目とほかの MCP サーバには触れません。
取り消しは今までどおり `claude mcp remove` に任せます。

### UI の開き方

`npm run hangar -- start` は、起動のたびに次のような鍵付きの URL を印字し、既定のブラウザで開きます。

```
この URL から開いてください: http://127.0.0.1:4177/?t=<トークン>
```

開いた時点で鍵はクッキーに変わり、アドレス欄からは消えます。
以後はブックマークから `http://127.0.0.1:4177/` を鍵無しで開けます。
自分で開きたいときは `--no-open` を渡してください。
`npm run hangar -- open` も同じ鍵付きの URL を印字してから開きます。
ただし開く前にサーバの生死を確かめ、動いていなければ開かずに起動を促します。
鍵付きの URL を出すだけでよいときは `npm run hangar -- url` を使ってください。

```sh
npm run hangar -- url     # 鍵付きの URL を印字する（ブラウザは開かない）
```

起動の後に鍵付きの URL を見直す道はこのコマンドだけです。
別のブラウザで開きたいときや、`open` の効かない環境で貼りたいときにも使えます。
サーバが止まっていても印字します。

鍵の無い `http://127.0.0.1:4177/` は 401 になり、トークンを配りません。
`curl` 1 本で誰でもトークンを取れてしまうのを防ぐためです。
401 の画面にも `hangar url` を案内します。
ブラウザでクッキーを消したときは、`npm run hangar -- open` でもう一度開き直してください。

開発時の手順は変わりません。
`npm run dev` を使い、ブラウザで `http://127.0.0.1:5173/` を開きます（`packages/server` の dev スクリプトが `HANGAR_DEV=1` を立てます）。
サーバを直に立てて 5173 から使うときは、自分で `HANGAR_DEV=1` を付けてください。
この印が無いと 5173 からの書き込みは 403 になります。
本番ビルドは `npm run build` の後に `npm run hangar -- start` で、4177 から UI を配信します。
npm には無関係の `hangar` という別のパッケージがあるので、`npx hangar` は使いません。

API を `curl` から叩くときは、本文を送る要求に `-H 'Content-Type: application/json'` が要ります。
付いていない要求は 415 で断ります。

### ファイルの扱い

hangar は Claude Code の設定とデータを原則として読むだけで、書き換えません。
`~/.claude/` の中に書く例外は 3 つです。

1. statusline スクリプトへの追記（次の節、承諾を求めてバックアップを取ります）。
2. 他端末のセッションを「この PC で再開」したときの本文の写し。
3. Settings で有効にした Claude Code 設定の取り込み（既定は off、取り込む内容を確認してから書きます）。

2 と 3 は、上書きの前に必ず `~/.agent-hangar/backups/` へ控えを取り、控えが取れなければ 1 バイトも書きません。
このほかに、`~/.claude/` の外にある `~/.claude.json` の `mcpServers.hangar` を `hangar mcp install` が書き換えます。
`~/.claude/settings.json` は、設定の同期を入れていない限り書き換えません。
索引は `~/.agent-hangar/hangar.db` に置きます。

## 使い方（フェーズ 3）

```sh
npm run hangar -- statusline install   # statusline スクリプトに追記して、使用量ゲージを動かす
```

追記先は `~/.claude/settings.json` の `statusLine.command` が指すスクリプトです。
承諾（`y` の入力、または `--yes`）を求め、追記の前に同じディレクトリにバックアップを取ります。
statusline を設定していない場合は追記せず、貼り付ける内容と手順を印字します。
サーバを 4177 以外で動かしているときは `--port <番号>` を渡します。

ヘッダーに 5 時間と 7 日の使用率のゲージが出ます。
値は Claude Code が statusline に渡す JSON が唯一の供給源なので、Claude が動いている間だけ新しくなります。
スニペットはトークンをコマンドの引数に載せません。
`~/.agent-hangar/statusline-header`（権限 0600）に置いた `Authorization: Bearer <トークン>` の 1 行を、`curl -H @<ファイル>` で読みます。
curl 7.55 以降が要ります。
このファイルはサーバの起動のたびに用意するので、`~/.agent-hangar` ごと消しても次の起動で戻ります。
ファイルが読めないときスニペットは何も送らず、statusline の表示だけをそのまま通します。
古い形のスニペットが入っているときは、`statusline install` が承諾を求めたうえで差し替えます。

Settings の使用量の表は、日別とプロジェクト別で同じ期間を見るので、トークン数の合計は一致します。
推定コストだけは、そのセッションの走り全体の累計です。
供給源が statusline の渡す累計の値で、日ごとの内訳を持たないためです。

初回の起動でマイグレーションの版 6 が走り、日別の使用量を積み直します。
すべてのトランスクリプトを索引にかけ直すので、実物の DB で約 35 秒かかり、その間だけ日別の表が欠けます。

プロジェクト詳細の右レールで TODO と Markdown のメモを書けます。
メモは `~/.agent-hangar/projects/<projectId>/memo.md` にも書き出すので、エディタから直接編集できます。
ファイルの方が新しければファイルの内容を採ります。
DB の内容で上書きするときは、消える本文を同じディレクトリに `memo.md.bak-<日時>` として残します。
同じレールに、セッションが claude.ai に公開したアーティファクトのカードが並びます。

⌘⇧N で始めたスクラッチのセッションは、後から「プロジェクトに昇格」でワークスペースの下に移せます。
セッション画面では ⌘\ で 2 つのタブを横に並べられます。

セッションのトランスクリプトは最新の側から開き、「古い行を読み込む」で過去へ遡ります。
実行中のセッションで追うのをやめている間に届いた分は「新着 N 件」の帯で知らせます。
N は実際に追記された行の数で、遡って読み込んだ古い行は数えません。

要約は LM Studio（`http://127.0.0.1:1234`）が既定で、繋がらないときだけ `claude -p` に切り替えます。
切り替えの上限は Settings で変えられます。
要約器には会話の本文が送られるので、宛先は既定で手元（`127.0.0.1`、`localhost`、`::1`）だけです。
手元の外にある要約器を使うときは、Settings の「手元の外にある要約器を許す」を入れてください。
入れている間は、会話の本文がその宛先へ送られることを画面に出します。

主なショートカットは、⌘K パレット、⌘N 新規、⌘⇧N スクラッチ、⌘, 設定、⌘1 から ⌘9 でタブ、⌘W でタブを閉じる、⌘\ で分割、⌘J でトランスクリプト、一覧では j と k と Enter と o と e と m です。

## クラウド同期（フェーズ 4）

自分の Cloudflare アカウントに Worker と D1 と R2 を置き、**自分の端末の間で**セッションを同期します。
無料枠（Workers 10 万要求/日、D1 の書き込み 10 万行/日、D1 5GB、R2 10GB）に収まる規模で、枠の 80% に達したら同期を自動で止めます。
他の人と 1 つの箱を共有する使い方は想定していません。
別の人が使うときは、その人の Cloudflare アカウントで `setup cloud` を走らせます。

### 1 台目（同期を始める端末）

```sh
npm run hangar -- setup cloud          # wrangler のログイン、資源の作成、デプロイ、参加トークンの表示
npm run hangar -- cloud status         # Worker とローカルサーバの状態
```

資源の名前は既定で Worker と D1 が `hangar`、R2 が `hangar-files` です。
`--name <名前>` で変えられます。
実測では `setup cloud` は 16 秒で終わりました。
同期を入れた後も `hangar start` は 1.0 秒から 1.1 秒で、起動が遅くなることはありません（APAC のリージョンで測りました）。

最後に出る **参加トークン** を控えます。
後から見るときは、UI の Settings のクラウド同期の節で「参加トークンを表示」を押します。

### 2 台目（自分の別の PC）

```sh
npm run hangar -- setup                # ~/.agent-hangar を作る
npm run hangar -- join                 # 参加トークンを貼り付けて端末を登録し、cloud.json を書く
npm run hangar -- start                # 再起動すると同期が始まる
```

`join` はトークンを引数ではなく標準入力から受け取ります。
引数に書くと `ps` とシェルの履歴に残るからです。
1Password の項目からそのまま貼れます。
途中で折り返されていても読めます。

### 同期するもの

- hangar のメタデータ（プロジェクト、セッション、要約、TODO、メモ）
- セッションの本文（gzip して AES-256-GCM で暗号化。鍵は参加用の秘密から導くので、Cloudflare 側は中身を読めません）
- Claude Code のユーザー設定（既定は off。Settings で有効にし、取り込む内容を確認してから `~/.claude` に書きます。上書きする前に必ず `~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取るので、何を書き換えられたかは後から追えます）

対象は `CLAUDE.md`、`settings.json`、`statusLine.command` が指すスクリプト、`skills/**`、`memory/**`、`projects/*/memory/**` です。
実測では、片方の書き換えが相手に降りるまで 10 秒から 30 秒でした。

他の端末で実行中のセッションは「<端末名> で実行中」と出て、再開とフォークが押せなくなります。
その端末を止めてから「この PC で再開」を押すと、本文を手元に降ろして続きから始められます。
実行中のまま奪い取る「引き継ぎ」は、まだ作っていません。

### やめるとき

```sh
npm run hangar -- cloud teardown       # Worker と D1 と R2 を消す（2 段の確認あり、取り消せません）
```

`teardown` は、クラウドにしか無い本文を先に手元へ降ろしてから消します。
1 件でも降ろせなければ、確認を聞く前に中止します。
実測では 14 秒から 18 秒で終わりました。

### 割り切りと限界

どれも実際に確かめたか、意図して残したものです。

1. **参加トークンは全セッションの読み書き権を持つ秘密です。** 1Password 経由で自分の 2 台目へ渡す前提で作ってあります。標準出力に出す以上、端末のスクロールバックとシェルの記録には残ります。自分の端末以外には渡さないでください。
2. **無料枠の 80% に達すると同期が一時停止します。** 数えに入れていないものが 3 つあります。`changes` の圧縮で走る D1 の書き込み（同期を 14 日以上続けると効き始め、実際の書き込みが数えの最大 1.5 倍になりえます）、`join` のときの `devices` の upsert、Worker の cold start ごとの `ensureSchema` です。無料プランは上限を超えても課金されず、要求が断られるだけです。なお R2 自身の枠は月ごとの別勘定で、この使い方（1 セッションを 1 日走らせて上げ下ろしが 2,880 回ほど）では月の上限に対して桁が 2 つ小さく、先に当たるのは必ず D1 の書き込みの側です。
3. **他端末の run は止まりません。** ロックは見せるだけです。「この PC で再開」は本文を降ろして手元で新しい run を立てるので、同じセッションの本文が 2 か所で伸びること（枝分かれ）があります。索引は 1 つのファイルだけを採るので画面は二重になりませんが、本文そのものは分かれます。
4. **`~/.agent-hangar/backups/` は伸び続けます。** 控えを取るのは、設定の取り込み（`claude-config/`）、「この PC で再開」での本文の上書き（`transcripts/`）、セッションのメモの競合（`memos/`）の 3 つです。このうち古いものを消すのは設定の取り込みだけ（20 世代）で、残り 2 つは消しません。
5. **R2 と索引の孤児を掃除する者がいません。** 本文の PUT は R2、D1 の順なので、間で倒れると索引に無い本体が R2 に残ります。端末を使わなくなったときに `transcripts/<端末 ID>/` を畳む道もありません。
6. **`CLAUDE_CONFIG_DIR` と `HANGAR_CLAUDE_DIR` は別物です。** 前者は起こされた `claude` が見る設定の置き場、後者は hangar が読む置き場です。普段はどちらも `~/.claude` ですが、試しの環境を分けるときは両方を向けてください（実物確認で見つかりました）。
7. **取り込んだ設定ファイルの更新時刻は、相手の端末で編集した時刻になります。** 手元で書いた時刻ではありません。どちらが新しいかの判定をホームをまたいで揃えるためです。
8. **確認は 1 台の Mac で 2 端末を模して行いました。** `HANGAR_HOME` と `HANGAR_CLAUDE_DIR` を分け、2 つのポートで起こしています。実際に別のマシンから接続することは、まだ確かめていません。
9. **降ろすのを諦めた本文の件数が、画面から確かめられません。** 諦めたことはトーストで 1 度だけ知らせます。30 分ごとと、サーバを起こし直したときに自動で試し直すので、放っておけば回復します。
10. **`hangar cloud teardown` に合言葉を一度に流し込むと、2 つ目が読めません。** 安全側に倒れて中止します。手で打つか、1 つずつ送ってください。
11. **マイグレーションの版 8 が走ります。** `transcript_files` に `device_id` の列が増え、R2 との同期の台帳である `file_sync` が出来ます。索引の作り直しは起きません。

## 開発

```sh
npm run typecheck
npm test
```

デスクトップ版のビルドには Xcode Command Line Tools と Rust が要ります。

```sh
npm install                           # 先に済ませる。tauri build が better-sqlite3 と node-pty の実体を写すため
npm run build                         # UI を作る
cd apps/desktop && npx tauri build    # server-dist を作り、.app を src-tauri/target/release/bundle/macos に出す
```

`.app` に入るのは、esbuild でまとめた `server.mjs` と `cli.mjs`、UI、`better-sqlite3` と `node-pty` の darwin-arm64 の prebuild、`bin/hangar`、Worker のソース、`manifest.json` です。
UI の sourcemap は入れません。
UI の写しの 68 パーセント（実測 2.19MB）が `.map` で、利用者の役に立たないためです。
実測で 7.7MB でした。

配布は、`apps/desktop/package.json`、`apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/tauri.conf.json` の版を揃えてから `git tag vX.Y.Z && git push origin vX.Y.Z` で行います。
GitHub Actions が型検査とテストを回し、`.app` を zip と checksum 付きで Releases に置きます。
タグと `tauri.conf.json` の版が食い違うと、ビルドの前に止まります。
