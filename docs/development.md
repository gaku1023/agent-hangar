# 開発の手順

README と、[install.md](install.md)、[usage.md](usage.md) は、入れて使う人のための手引きです。
ここには、このリポジトリを clone して動かす人と、配布物を作る人のための手順を置きます。
配布版の `hangar` は、clone した場所では `npm run hangar --` と打ちます。
署名とリリースの手順は [signing.md](signing.md) と [release.md](release.md) にあります。

## clone して動かす

Node 22.14 以上が要ります（`package.json` の `engines`）。
同梱のネイティブモジュール（better-sqlite3、node-pty）が Node-API 10 を使うためで、Node 24 など新しい版でも動きます。

```sh
npm install
npm run hangar -- setup     # ~/.agent-hangar を作り、tmux と claude と git の有無を報告する
npm run dev                 # サーバ（4177）と UI の開発サーバ（5173）を起動する
```

[usage.md](usage.md) の「使い方」の例は配布版の `hangar` の形で書いてあります。
clone した場所では、`hangar` を `npm run hangar --` に読み替えてください（`npm run hangar -- mcp install`、`npm run hangar -- statusline install` のように）。
`npm install` と `npm run dev` は開発用で、配布版だけを入れた人には要りません。

### UI の開き方（開発時）

開発時は `npm run dev` を使い、ブラウザで `http://127.0.0.1:5173/` を開きます（`packages/server` の dev スクリプトが `HANGAR_DEV=1` を立てます）。
サーバを直に立てて 5173 から使うときは、自分で `HANGAR_DEV=1` を付けてください。
この印が無いと 5173 からの書き込みは 403 になります。
本番ビルドは `npm run build` の後に `npm run hangar -- start` で、4177 から UI を配信します。
npm には無関係の `hangar` という別のパッケージがあるので、`npx hangar` は使いません。

### API を叩く

API を `curl` から叩くときは、本文を送る要求に `-H 'Content-Type: application/json'` が要ります。
付いていない要求は 415 で断ります。

### 初回のマイグレーション

初回の起動でマイグレーションの版 6 が走り、日別の使用量を積み直します。
すべてのトランスクリプトを索引にかけ直すので、実物の DB で約 35 秒かかり、その間だけ日別の表が欠けます。

## Windows でソースから動かす

1. Node 22.14 以上、Git for Windows、Claude Code を入れます。
2. psmux を入れます（[install.md](install.md) の「[psmux を入れる](install.md#psmux-を入れる)」）。
3. `npm ci --ignore-scripts` のあと `npm run dev` で起こし、ブラウザで `http://127.0.0.1:5173/` を開きます。
   `--ignore-scripts` を付けないと、`better-sqlite3` が C++ のビルドを始めて、ビルドの道具が無い PC では失敗します。ネイティブモジュールは同梱の prebuild で動きます。

止めるときは Ctrl+C です。

## Windows のインストーラを作る

Rust と Node 22（22.14 以上）が要ります。
配布物を作る Node は 22 の系列に限ります（下の「開発」）。

```powershell
npm ci --ignore-scripts
npm run build
npm run tauri -w apps/desktop -- build --bundles nsis
```

`apps/desktop/src-tauri/target/release/bundle/nsis/` に `Hangar_<版>_x64-setup.exe` ができます。
管理者権限は要らず、`%LOCALAPPDATA%\Hangar` に入ります。
`server\bin\hangar.cmd` が同梱の `hangar` コマンドです。
インストーラがこの置き場を利用者の PATH に足すので、入れたあとに新しく開いたターミナルで `hangar start` のように打てます（アンインストールで外します）。
入れる前から開いていたターミナルでは、開き直すか、`%LOCALAPPDATA%\Hangar\server\bin\hangar.cmd` をフルパスで打ちます。

Node の探し方は、[install.md](install.md) の「[Node の探し方](install.md#node-の探し方)」にあります。

## 開発

```sh
npm run typecheck
npm test
```

試験と `npm run dev` は Node 22.14 以上ならどの版でも動きます。
配布物は Node 22（22.14 以上）で build します（`bundle-server` と `tauri build` は、22 の系列でなければ止まります）。
リポジトリの根の `.nvmrc` が 22 なので、`nvm use` で切り替えられます。

デスクトップ版のビルドには Xcode Command Line Tools と Rust が要ります。

```sh
npm install                           # 先に済ませる。tauri build が better-sqlite3 と node-pty の実体を写すため
npm run build                         # UI を作る
cd apps/desktop && npx tauri build    # server-dist を作り、.app を src-tauri/target/release/bundle/macos に出す
```

`.app` に入るのは、esbuild でまとめた `server.mjs` と `cli.mjs`、UI、`better-sqlite3` と `node-pty` の darwin-arm64 の prebuild（Windows の束は win32-x64 の prebuild で、`.pdb` は入れません）、`bin/hangar`、Worker を 1 本に束ねた `cloud/worker.mjs` とその束縛の定義 `cloud/metadata.json`、`manifest.json` です。
`cloud/` は、後の版でアプリから Cloudflare へ Worker を上げるための下地で、いまはどこからも読んでいません。
UI の sourcemap は入れません。
UI の写しの 68 パーセント（実測 2.19MB）が `.map` で、利用者の役に立たないためです。
実測で 6.5MB でした。

配布は、版を上げる PR を入れてから `git tag vX.Y.Z && git push origin vX.Y.Z` で行います。
版の在りかは 5 つ（`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/package.json`、`apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/Cargo.lock` の `hangar-desktop` の項、`package-lock.json` の `apps/desktop` の項）で、`npm run set-version -w apps/desktop -- <版>` がまとめて書き換えます。
詳しい手順は [release.md](release.md) にあります。
GitHub Actions が型検査とテストを回し、`.app` から作った dmg と zip を、それぞれ checksum 付きで Releases に置きます。
dmg は `apps/desktop/scripts/make-dmg.sh` が、出来上がった `.app` と `/Applications` へのリンクを詰めて作ります。
手元でも `bash apps/desktop/scripts/make-dmg.sh <Hangar.app> <出力の .dmg>` で作れます。
`tauri.conf.json` の bundle の targets に dmg を入れないのは、tauri の dmg が build の途中の `.app` を詰めるので、build の後で署名した `.app` が入らないためです。
タグと 5 つの版のどれかが食い違うと、何も作らずに止まります。
