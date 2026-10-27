# agent-hangar の入れ方

## 入れる（macOS）

対象は macOS 13 以降の Apple silicon と、Windows 11（x64）です。
配布物は GitHub Releases に置いています（最初の版は `v0.1.0` で、macOS だけでした。Windows のインストーラは `v0.2.0-rc.1` から添えています）。
v0.1.0 から入れ替える人は、先に「[v0.1.0 からの移行](#v010-からの移行)」を読んでください。
ふだんは Latest の印の付いた版を使ってください。
Pre-release の印の付いた版（`v0.2.0-rc.1` など）は試しの版で、確かめが済むまでの間だけ置きます。
試しの版を入れると、自動更新は次の試しの版と、その後の正式な版を知らせます（手順は [docs/release.md](release.md)）。

この節の残りは macOS の手順です。
Windows では「[入れる（Windows）](#入れるwindows)」の節へ進んでください。

macOS の配布物は dmg が主で、zip は予備です。
Apple の Developer ID では署名せず、公証もしません。
代わりに自作の証明書で署名します（仕組みは [docs/signing.md](signing.md) にあります）。
自作の証明書は macOS に信頼されていないので、初めて開くときに「"Hangar" は開いていません」という警告が出ます。
その越え方は、手順の 3 段目に書きました。

### 前提

Hangar を動かすには、次の 3 つが先に要ります。

- Node 22.14 以上。
  Hangar のデータベースと端末の部品は Node-API 10 を使うため、それを持つ版が要ります（23 の系列では 23.6 以上）。
  Node 24 など新しい版でも動きます。
  アプリは Node を同梱していません。
- tmux。セッションは tmux の中で起こします。
- `claude`（Claude Code 本体）。セッションを起こすのは Claude Code です。

Homebrew なら、Node と tmux はまとめて入ります。

```sh
brew install node tmux
```

これだけで足ります。
アプリと `hangar` コマンドは PATH を見ずに、決まった場所から Node を探し、Node-API 10 以上で同じアーキテクチャのものを使います。

すでに 22.14 より古い Node を使っていて、それを置き換えたくないときは、`brew install node@22` で入れます。
`node@22` は既定の `node` を置き換えません。
探す場所には Homebrew の `node@` の入れ先（`/opt/homebrew/opt/node@22`）が入っているので、`brew link` は要りません。

nvm、fnm、Volta、mise、asdf、nodenv で入れた Node も、そのまま見つけます。
探す順は、Settings で指定したパス、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、Homebrew の `node@` の入れ先、nvm、fnm、Volta、mise、asdf、nodenv（それぞれ新しい版から）です。

これら以外の場所に入れたときは、Settings 画面の「Node のパス」か `~/.agent-hangar/settings.json` の `nodePath` に、その `node` の実行ファイルのフルパスを指定します。
読み込み画面が合う Node を見つけられないと告げたときは、その画面の「node を選ぶ…」で選んでも指定できます。
`node` のような名前だけや相対のパス、`~` で始まるパスは使えません（`~` は展開しないので、`/Users/名前/...` のように書きます）。
Settings 画面と「node を選ぶ…」は、保存する前にその Node が Node-API 10 以上で同じアーキテクチャかを確かめ、合わなければ理由を出して保存しません。
`hangar` コマンドは、環境変数 `HANGAR_NODE` に `node` のフルパスを入れておけば、それを先に使います。
アプリは `HANGAR_NODE` を見ません。Finder から開いたアプリには端末の環境変数が届かないので、アプリに指すときは `nodePath` を使います。
`/opt/homebrew/bin/node` へリンクして見つけさせる手もあります（`brew link --overwrite --force node@22`。別の `node` を入れていれば置き換わります）。

Homebrew の版によっては `node@22` が keg-only（Homebrew が既定の場所へリンクしない入れ方）になり、端末で `node` が見つかりません。
そのときは PATH に通します（zsh の例です）。
アプリの探索には関わりません。

```sh
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
```

`claude` の入れ方は Claude Code の案内に従ってください。
どれが入っているかは、手順の 4 段目の `hangar setup` が報告します。

次の 2 つは無くても動きます。

- git。一覧と (i) のブランチと未コミットの件数、変更したファイルの差分に使います。macOS はコマンドライン・デベロッパツール（`xcode-select --install`）、Windows は Git for Windows（`winget install --id Git.Git -e`）で入ります。
- エディタ。「<名前> で開く」で使います。VS Code、Cursor、Windsurf、Zed、IntelliJ IDEA、WebStorm を自動で見つけ、Settings の「一般」の「エディタ」で選べます。ほかのエディタは「任意のコマンド」に `subl {path}:{line}` のように書きます。

どちらも、ホームの「セットアップの確認」に任意の行として出ます。

### 手順

1. Releases から `Hangar-vX.Y.Z-macos-arm64.dmg` を落とします。
   checksum を確かめるには、同じ場所の `.sha256` も落として `shasum -a 256 -c Hangar-vX.Y.Z-macos-arm64.dmg.sha256` を実行します。

2. dmg を開き、中の `Hangar.app` を隣の `Applications` へドラッグします。
   入れ終わったら、Finder のサイドバーで dmg を取り出してかまいません。

   dmg の中の `Hangar.app` を、そのままダブルクリックして使わないでください。
   読み取り専用の場所から開くと、macOS が `.app` を別の読み取り専用の場所へ写して起動することがあります（App Translocation）。
   写しの中ではアプリが自分の同梱物の検疫属性を外せないので、同梱サーバを起こせません。
   アプリは自分が写しの中にいると気付くと `/Applications` へ移すよう案内しますが、その前に macOS の警告が出ることがあります。

3. `/Applications/Hangar.app` を初めて開きます。

   初めて開くと、次の警告が出ます。

   > "Hangar" は開いていません
   > Apple は、"Hangar" に Mac に損害を与えたり、プライバシーを侵害する可能性のあるマルウェアが含まれていないことを検証できませんでした。

   ボタンは「ゴミ箱に入れる」と「完了」だけです。
   Hangar に問題が見つかったという意味ではなく、Apple の公証を受けていないアプリに出る警告です。
   次の順で開きます。

   1. 「完了」を押して、警告を閉じます（「ゴミ箱に入れる」は押しません）。
   2. システム設定を開き、「プライバシーとセキュリティ」を選びます。
   3. 画面を下へ送り、「セキュリティ」の欄（見出しが「アプリケーションの実行許可」と出る版もあります）にある、「…"Hangar"がブロックされました。」という行を探して、右の「このまま開く」を押します。
      行の文言は macOS の版によって違うので、「Hangar」と「ブロック」の語を手がかりに探してください。
   4. 「Mac に損害を与えたり、プライバシーを侵害する可能性のあるアプリを開こうとしています」と出て、「プライバシーとセキュリティで続けるには、管理者の名前とパスワードを入力してください。」と求められます。管理者のパスワードを入れると、Hangar が開きます。

   この行は、警告を一度出した後にだけ現れます。
   警告を出す前に、システム設定を開いても見つかりません。

   Finder での右クリックの「開く」は、実機で試した版の macOS では効きませんでした（同じ警告の画面になり、開く道は出ませんでした）。
   そのため、主の手順には入れていません。
   macOS の版によっては効くことがあります。

   上の手順でも開けないときの最後の手段として、端末から検疫属性を外す道もあります。

   ```sh
   xattr -rd com.apple.quarantine /Applications/Hangar.app
   ```

   開いたアプリは、同梱サーバを子プロセスとして起こす前に、同梱物の検疫属性を自分で外します。
   この処理は Node を探すより前に走るので、前提の Node がまだでも効きます。
   ただし 4177 で既に動いているサーバを見つけた回は、サーバを起こさないのでこの処理も走りません。
   どちらにしても、これが効くのは `/Applications` へ移した後だけです。

   合う Node（22.14 以上）がまだ無ければ、読み込み画面がそう告げます。
   その場合は「[前提](#前提)」の手順で入れてから開き直すか、画面の「node を選ぶ…」で入れた Node を選んでください。

4. `hangar` コマンドを使えるようにして、初期設定を走らせます。

   ```sh
   sudo mkdir -p /usr/local/bin
   sudo ln -sf /Applications/Hangar.app/Contents/Resources/server/bin/hangar /usr/local/bin/hangar
   hangar setup
   ```

   まっさらな Mac（特に Apple silicon）には `/usr/local/bin` がまだありません。
   1 行目の `mkdir -p` はそのためで、すでにあれば何も起こりません。
   これを省くと、`ln` が「No such file or directory」で止まります。
   `/usr/local/bin` は macOS の初めからの `PATH` に入っているので、作れば `hangar` はそのまま呼べます。
   `sudo` を使いたくないときは、Homebrew の `/opt/homebrew/bin` に同じリンクを張っても構いません（そこが `PATH` にあることが前提です）。

   `bin/hangar` はリンク越しに呼ばれても自分の実体を辿るので、同梱物と Node を見失いません。
   `hangar setup` は `~/.agent-hangar` を用意し、tmux と claude と git の有無を報告します。

5. `Hangar.app` を開きます。

   同じ画面はブラウザからも使えますが、入口は鍵付きの URL だけです。
   `hangar url` を実行し、印字された `http://127.0.0.1:4177/?t=<トークン>` を開いてください。
   鍵の無い `http://127.0.0.1:4177/` は 401 になり、`hangar url` を案内する画面を返します。
   `/usr/local/bin/hangar` のリンク越しに `hangar url` を叩いても、正しい鍵付きの URL が出ます。
   4177 は同じ機械で動くどのプログラムからも叩けるので、鍵が無ければセッションの本文を誰からでも読み出されてしまうためです。
   開いた後の鍵の扱いは「[画面を開く](usage.md#画面を開く)」に書いてあります。

   `open hangar://session/<id>` のようなリンクでアプリの画面を直接開けます。
   受け付ける形は `hangar://session/<id>`、`hangar://project/<id>`、`hangar://search?q=<検索語>` の三つです。

起動の記録は `~/.agent-hangar/desktop.log` に残ります。
うまく起動しないときは、「[困ったとき](troubleshooting.md#困ったとき)」を見てください。

`.app` の版はタグと同じで、設定の更新の節に出ます。
同梱のサーバも同じ版を名乗ります（サーバの版は `/health` が返します）。

### v0.1.0 からの移行

v0.1.0 には自動更新が無いので、v0.1.0 のアプリは新しい版を知らせません。
v0.2.0 以降の dmg を、上の手順の 1 から 3 のとおり手で入れ直してください。
Hangar が動いていたら、先に終了してから `/Applications` の `Hangar.app` を置き換えます。
`~/.agent-hangar` の中身（設定、索引、メモ、クラウド同期の設定）は、そのまま引き継がれます。
データベースの版が上がるときは、上げる前の控えを同じ置き場に取ります。

署名が変わるので、入れ直しの初回だけ、次の 2 つが起きます。
v0.1.0 は署名なしの build で、v0.2.0 からは自作の証明書で署名します。
macOS は署名の違うアプリを別のアプリとして扱います。

- 手順の 3 段目の初回の警告がもう一度出ます。同じ手順で越えます。
- ローカルネットワークや、ファイルとフォルダなどの許可を、一度だけ取り直します。
  アプリが尋ねてくるので、許可してください。

v0.2.0 からは、更新でも同じ証明書で署名します。
更新のたびに警告や許可が出直すことはありません。
v0.2.0 の入れ直しのあとは、設定の更新の節が新しい版を知らせるので、手で入れ直す必要はありません。

### zip から入れる（予備）

dmg を使えないときは、同じ場所の `Hangar-vX.Y.Z-macos-arm64.zip` を使います。
checksum は `shasum -a 256 -c Hangar-vX.Y.Z-macos-arm64.zip.sha256` で確かめます。
Finder でダブルクリックして展開し、展開した `Hangar.app` を `/Applications` へ移してから、上の手順の 3 段目から続けます。

展開の仕方で、検疫属性が `.app` に伝わるかどうかが変わります。
Finder でダブルクリックして展開すると伝わり、端末から `unzip` や `tar` で展開すると伝わりません。
伝わらなかった場合は、手順の 3 段目の警告が出ないまま開けるはずです。
展開した場所でダブルクリックせず、先に `/Applications` へ移してください（理由は手順の 2 段目と同じです）。

## 入れる（Windows）

対象は Windows 11（x64）だけです。
タグを打つと、macOS の dmg や zip と同じ Release に Windows のインストーラも添えます。
インストーラを使わずに、ソースから動かして使うこともできます（手順は [docs/development.md](development.md) にあります）。

### Windows の前提

Hangar を動かすには、次の 3 つが先に要ります。

- Node 22.14 以上。
  Hangar のデータベースと端末の部品は Node-API 10 を使うため、それを持つ版が要ります。
  Node 24 など新しい版でも動きます。
  アプリは Node を同梱していません。
  Node がまだ無ければ、PowerShell で `winget install -e --id OpenJS.NodeJS.LTS` を打つのがいちばん手早い入れ方です（公式のインストーラが入ります）。
  すでに 22.14 より古い Node を使っていて、それを置き換えたくないときは、winget は使いません（公式のインストーラは `C:\Program Files\nodejs` の Node を置き換えます）。
  代わりに nodejs.org から Node 22 の Windows 用 zip を取り、別のフォルダ（例 `%LOCALAPPDATA%\Programs\node22`）に展開して、読み込み画面の「node.exe を選ぶ…」か Settings 画面の「Node のパス」でその `node.exe` を指します。
  nvm-windows の `nvm install 22` で入れた版も、fnm、Volta、scoop で入れた Node も見つけます。
- psmux。セッションは tmux の代わりに psmux の中で起こします。入れ方は下の「[psmux を入れる](#psmux-を入れる)」にあります。
- `claude`（Claude Code 本体）。入れ方は Claude Code の案内に従ってください。

git とエディタは、macOS と同じく無くても動きます（使いみちは、macOS の「[前提](#前提)」の節にあります）。
git は Git for Windows（`winget install --id Git.Git -e`）で入ります。

winget で入れたものは、入れたあとに新しく開いた PowerShell から PATH に載ります。

### Node の探し方

Node は同梱していないので、Node-API が同梱の `manifest.json` の `nodeApi`（10）以上で、アーキテクチャが同じ Node を探します。
アプリは、`~\.agent-hangar\settings.json` の `nodePath`、公式のインストーラの入れ先、nvm-windows、fnm、Volta、scoop、PATH にあるすべての `node.exe` の順に探します。
`hangar` コマンドは、その前に環境変数 `HANGAR_NODE` を見ます（アプリは `HANGAR_NODE` を見ません）。
`nodePath` と `HANGAR_NODE` は `node.exe` のフルパスで指します。
fnm などが古い版を PATH の先頭に置いていても、PATH の後ろや版の管理ツールの置き場に合う Node があればそれを使います。
見つからないときは、調べた場所と、それぞれが合わなかった理由を順に出します。

### インストーラで入れる

1. 「[Windows の前提](#windows-の前提)」の 3 つを入れます。
2. Releases から `Hangar-vX.Y.Z-windows-x64-setup.exe` を落とします。
   checksum を確かめるには、同じ場所の `.sha256` も落とし、PowerShell の `Get-FileHash Hangar-vX.Y.Z-windows-x64-setup.exe` が出す値と比べます（大文字と小文字の違いは無視します）。
3. インストーラを開きます。
   署名していないので、SmartScreen が「Windows によって PC が保護されました」と出します。
   そのときは「詳細情報」を押して「実行」を選びます。
   管理者権限は要らず、`%LOCALAPPDATA%\Hangar` に入ります。
4. スタートメニューの Hangar から開きます。
   合う Node が見つからないときは、起動の画面がそう告げます。入れてから「もう一度試す」を押すか、「node.exe を選ぶ…」で入れた Node を選んでください。
   psmux や `claude` が欠けているときは、ホームの「セットアップの確認」に出ます。入れたあとに「再確認」を押すと、開き直さずに見つけます。

インストーラは同梱の `hangar` コマンドの置き場を利用者の PATH に足すので、入れたあとに新しく開いたターミナルで `hangar url` のように打てます。

入れたあとは、新しい版が出ると設定の更新の節と札が知らせます。
「ダウンロードしてインストール」のあと「再起動して更新」を押すと入れ替わります。
動いているセッションは止まらず、開き直したアプリからつなぎ直せます。

### psmux を入れる

hangar は tmux の代わりに [psmux](https://github.com/psmux/psmux) を使います。
先に入れておく必要があります。

```powershell
winget install -e --id marlocarlo.psmux
```

入れたら、新しい PowerShell を開き直して確かめます（winget が張るリンクは、開き直した端末から PATH に載ります）。

```powershell
psmux -V
```

`psmux`、`pmux`、`tmux` の 3 つの名前で入ります。hangar は `psmux` を先に探します。
hangar のセッションは psmux の専用の名前空間で動くので、`psmux -L hangar ls` で見えます。

psmux は 3.4.0 以上を使ってください。
3.4.0 より前（3.3.5〜3.3.8）は、Claude Code が動いているペインでホイールを回すと、`↑` キーに変えてアプリへ送ります（[psmux#548](https://github.com/psmux/psmux/issues/548)）。
端末を上へスクロールできず、Claude Code のプロンプトの履歴が呼ばれます。
古い版のときは、ホームの「セットアップの確認」、設定のツールの節、`hangar setup` の出力が知らせます。

#### psmux を上げる

psmux が 1 つでも動いていると、winget は `psmux.exe` を置き換えられずに失敗します（`remove: Access is denied`、0x8a150003）。
失敗すると、別名の `pmux.exe` だけが消えた状態で止まります。
そのため、先に psmux を止めてから上げます。

1. hangar のセッションを全部閉じます。psmux を止めると、その中で動いているセッションは全部止まります（hangar を再起動しても psmux の中のセッションは止まらないので、ここで止まります）。
2. hangar の端末ではなく、外の PowerShell で次の 1 行を打ちます。hangar のセッションを開き直すと psmux がまた起動するので、止めることと上げることを続けて打ちます。

   ```powershell
   Get-Process psmux -ErrorAction SilentlyContinue | Stop-Process -Force; winget upgrade marlocarlo.psmux; tmux -V
   ```

3. 最後に `tmux 3.4.0` 以上が出れば上がっています。hangar の設定のツールの節で「再確認」を押すと、知らせが消えます。

winget の id は `marlocarlo.psmux` です。
リポジトリは `psmux/psmux` に移りましたが、winget の id は移っていません（2026-10-10 に winget-pkgs の `manifests/m/marlocarlo/psmux` で 3.3.8 を確かめました。`psmux/psmux` という id はありません）。
手元で確かめるときは `winget search psmux` を使います。
id が変わっていたら、そこに出る id を `winget install -e --id <id>` に渡してください。
winget を使えない PC では、[リリースのページ](https://github.com/psmux/psmux/releases)の `psmux-v<版>-windows-x64.zip` を展開し、中の `psmux.exe` の置き場所を PATH に加えます。

### Windows の制限

Windows では、ターミナルで打った `claude` を hangar に載せる包み（macOS の `hangar shell install`）を作りません。
セッションは Hangar の画面から始めます。
通知（WinRT のトースト）、外のターミナルへの受け渡し（Windows Terminal）、`hangar open`（鍵付きの URL を既定のブラウザで開きます。鍵は端末には出しません）は Windows でも使えます。
statusline への追記は Windows の実機で確かめていないので、使えるものとして書きません。
