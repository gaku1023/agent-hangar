# フェーズ 5 実装計画（Tauri のシェル、ディープリンク、Releases）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** フェーズ 1 から 4 で作ったサーバと UI を macOS の `.app` に包み、ダブルクリックで起動し、`hangar://` のリンクで画面を開け、タグを打つと GitHub Releases に配布物が並ぶ状態にする。

**Architecture:** `apps/desktop` に Tauri v2 のシェルを置く。Rust 側は起動時に Node を候補パスから探し、同梱したサーバの単一ファイルバンドルを子プロセスとして立て、`/health` が通ったらウィンドウを `http://127.0.0.1:4177/` へ移す。UI はサーバが配信するものをそのまま使い、シェル固有のコードを UI に足さない。ディープリンクは Rust が `#/...` のハッシュに変換して webview に流し、UI の runtime が `hash.changed` として Mediator に届ける。配布は GitHub Actions がタグごとに `.app` を zip と checksum 付きで Releases に置く。

**Tech Stack:** Tauri 2（`tauri` 2.11、`tauri-plugin-deep-link` 2.4、`tauri-build` 2）、Rust 1.94（`url` 2、`serde_json` 1、`libc` 0.2、開発時 `tempfile` 3）、`@tauri-apps/cli` 2.11、esbuild 0.25、Node 22、vitest 5、GitHub Actions（`actions/checkout@v4`、`actions/setup-node@v4`、`dtolnay/rust-toolchain@stable`、`Swatinem/rust-cache@v2`、`softprops/action-gh-release@v2`）。

**Spec:** `docs/design.md`

## Global Constraints

- サーバは `127.0.0.1` のポート `4177` にだけバインドする。データは `~/.agent-hangar/`。`~/.claude/` 配下は読むだけで、書き換えない。
- Node は PATH に頼らず、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、`~/.nvm/versions/node/*/bin/node`（新しい版を優先）の順で探し、Settings で明示もできる。
- Tauri のシェルは起動時にサーバの子プロセスを立て、終了時に止める。サーバ側でも `HANGAR_PARENT_PID` で親の生存を監視し、親が消えたら自ら終了する（フェーズ 1 の `main.ts` に実装済み）。
- ディープリンクは `hangar://session/<id>`、`hangar://project/<id>`、`hangar://search?q=<text>` の三形で、ブラウザでは `http://127.0.0.1:4177/#/session/<id>` が同じ画面を開く。
- ブラウザでも Tauri でも同じ UI が動く。UI はサーバが配信する `packages/ui/dist` で、Tauri のためのコードを UI に足さない。
- API の `Origin` 制限（`ALLOWED_ORIGINS`）は変えない。
- 見た目はライト主体で OS の設定に従ってダークも持つ。Tauri 固有の見た目を足さない。
- リポジトリは public で MIT。GitHub Actions で型検査とテストを回し、タグを打つと macOS 用の `.app` を Releases に置く。家族はそれを落として `hangar setup` を走らせる。
- Tauri の Info.plist に `NSAppleEventsUsageDescription` を入れる（iTerm2 の AppleScript 用）。
- 手元でのフルビルド（`tauri build`）は 73 秒かかるので 3 回までとする。`cargo check` と `cargo test` は回数を制限しない。Xcode CLT と Rust は導入済み。
- テストは `HANGAR_HOME` と `HANGAR_CLAUDE_DIR` を一時ディレクトリに向け、実物の `~/.agent-hangar` と `~/.claude` に触れない。`~/.claude` 配下には何も書かない。
- 日本語の文書とコメントは一文ごとに改行し、地の文でダッシュと中黒を使わない。
- コミットメッセージは英語の Conventional Commits 形式で、末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` を付ける。パッケージ管理は npm（pnpm は使わない）。

---

## 前提（この計画で決めたこと）

設計文書が定めていない細部を、この計画で次のように決める。
実装後に `docs/design.md` へ反映する（Task 10）。

- **サーバの同梱形態**：`packages/server/src/main.ts` を esbuild で単一ファイル `server.mjs` にまとめ、`.app` の `Contents/Resources/server/` に置く。UI は同じ場所の `ui/`、ネイティブモジュール（`better-sqlite3`、その依存の `bindings` と `file-uri-to-path`、フェーズ 2 以降の `node-pty`）は `node_modules/` として隣に置く。`packages/server` と `node_modules` 全体を tsx ごと同梱する案は退けた。同梱物が数十 MB になり、起動のたびに tsx の変換が走り、どの依存が本当に要るかが不明瞭になるからである。
- **Node の版の一致**：ネイティブモジュールは Node の ABI とアーキテクチャに縛られる。バンドル時の Node のメジャー版とアーキテクチャを `manifest.json` に記録し、探索では各候補を `node -e` で起動して版を調べ、メジャー版とアーキテクチャが一致する最初の候補だけを採る。一致する Node が無いときは、調べた場所と版を読み込み画面に出し、`nvm install 22` か Settings の `nodePath` を案内する。
- **配布ターゲット**：Apple silicon（`aarch64-apple-darwin`）だけを作る。ユニバーサルにしないのは、`.node` がアーキテクチャ別で lipo の手間が要り、家庭内の Mac が Apple silicon だからである。Intel 版は行列に 1 行足せば作れるが、ランナーのラベルは未確認なので入れない。
- **Gatekeeper**：コード署名と公証はしない。README に「検疫属性を外す（`xattr -rd com.apple.quarantine`）」を主手順として書き、GUI で開く手順（初回のダイアログのあと、システム設定のプライバシーとセキュリティで「このまま開く」、macOS 14 以前は右クリックの「開く」）も添える。加えてアプリ自身が起動時に同梱サーバのディレクトリの検疫属性を外す。未署名の `.node` に検疫属性が残っていると、GUI の手順でアプリ本体を許可しても Node がそれを読み込む時点で止められるからである。Apple Developer の署名と公証は、後で任意に足す。
- **二重起動**：single-instance プラグインは入れない。macOS の Launch Services が通常の起動を 1 プロセスに保つので、残る問題は「4177 に既にサーバがいる」場合だけである。起動時に `/health` が `{"ok":true}` を返せば、そのサーバを採用して子プロセスを起こさない。`hangar start` で立てたサーバと共存し、アプリを閉じてもそのサーバは止めない。
- **ディープリンクの受け渡し**：Rust が `hangar://` をハッシュ（`#/session/<id>`、`#/project/<id>`、`#/sessions?q=<text>`）に変換し、webview で `location.hash = ...` を評価する。イベントを emit して UI が購読する案は退けた。UI に Tauri の API と capability を足すことになり、「同じ UI が動く」原則に反するからである。サーバの準備が終わる前に届いたリンクは保持し、最初のナビゲーションの URL の末尾に付ける。
- **起動画面**：`frontendDist` は `apps/desktop/loading/` の静的な読み込み画面で、ビルド工程を持たない。`/health` が通ったら `WebviewWindow::navigate` でサーバの URL へ移る。Node が無い、サーバが 20 秒以内に応答しない、などの失敗は同じ画面に文字で出す。
- **`HANGAR_UI_DIST`**：`startServer` が UI の場所を `opts.uiDist ?? process.env.HANGAR_UI_DIST ?? 既定` で決める。同梱の `cli.mjs` から `hangar start` を呼ぶ場合にも同じ環境変数が効く。
- **`nodePath`**：`SettingsDto` に `nodePath?: string | null` を足し、Settings 画面に入力欄を置く。値は `~/.agent-hangar/settings.json` に保存され、Rust とラッパスクリプトが同じ鍵を読む。
- **CLI の同梱**：`packages/cli/src/index.ts` も `cli.mjs` にまとめ、`bin/hangar` のシェルスクリプトから起動できるようにする。家族は `.app` を落とすだけで `hangar setup` を実行できる。README は `/usr/local/bin/hangar` へのシンボリックリンクを案内する。
- **ログ**：`~/.agent-hangar/desktop.log` に、Rust 側の記録とサーバの標準出力と標準エラーを追記する。Settings の診断（フェーズ 3）がこのファイルの末尾を出す。
- **終了**：`RunEvent::Exit` で子プロセスに SIGTERM を送り、2 秒待ってから SIGKILL する。サーバは SIGTERM で DB を閉じてから終わる。ウィンドウを閉じるとアプリが終了し、サーバも止まる（Tauri の既定）。
- **アイコン**：仮のアイコンを SVG で置き、`tauri icon` で各サイズを生成して commit する。
- **`tauri://localhost` の Origin**：ウィンドウは `http://127.0.0.1:4177` を読み込むので、この Origin は使わない。`ALLOWED_ORIGINS` はそのまま残す。
- **範囲外**：`hangar open` にディープリンク相当の引数を足すことは設計文書が求めていないので行わない。webview 内で外部の URL（アーティファクトなど）を既定のブラウザへ回す扱いは、アーティファクトのカードを作るフェーズ 3 に委ねる。

## ファイル構成

```
package.json                              workspaces に apps/* を足す
vitest.config.ts                          projects に apps/* を足す
.gitignore                                server-dist、target、gen/schemas
.github/workflows/ci.yml                  desktop ジョブ（cargo fmt、cargo test）を足す
.github/workflows/release.yml             タグ v* で .app を zip と checksum 付きで Releases へ
README.md                                 「インストール（配布版）」
packages/server/src/server.ts             uiDist に HANGAR_UI_DIST を使う
packages/server/src/config/paths.ts       Settings に nodePath
packages/server/src/http/app.ts           /api/settings と bootstrap に nodePath
packages/shared/src/api.ts                SettingsDto に nodePath
packages/ui/src/presenters/settings.ts    SettingsProps に nodePath
packages/ui/src/views/SettingsScreen.tsx  Node のパスの欄
apps/desktop/
  package.json                            bundle-server、tauri スクリプト
  tsconfig.json、vitest.config.ts
  loading/index.html                      読み込み画面（frontendDist）
  scripts/bundle-server.ts                esbuild で server.mjs と cli.mjs、ui、node_modules、manifest.json、bin/hangar を server-dist/ に出す
  scripts/hangar.sh                       同梱 CLI のラッパ（bin/hangar として配置）
  test/config.test.ts                     tauri.conf.json と Info.plist と読み込み画面の不変条件
  test/bundle-server.test.ts              バンドルの生成と、tsx 無しでの起動
  server-dist/                            生成物（gitignore）
  src-tauri/
    Cargo.toml、build.rs、tauri.conf.json、Info.plist、icon.svg、icons/、capabilities/default.json
    src/main.rs                           hangar_desktop_lib::run()
    src/lib.rs                            Builder、setup、boot、deep link、Exit
    src/paths.rs                          user_home()、hangar_home()
    src/node.rs                           Manifest、候補の列挙、版の照合、エラー文言
    src/deeplink.rs                       deep_link_to_hash()、hash_to_js()
    src/health.rs                         http_get()、is_healthy()、wait_until()、wait_for_health()
    src/server.rs                         server_dir()、spawn_server()、ServerProcess::stop()、strip_quarantine()
```

## インターフェース一覧

後のタスクが依存する名前と型を先にまとめる。
各タスクの Interfaces はこの一覧の抜粋である。

```rust
// src/paths.rs
pub fn user_home() -> PathBuf;                       // $HOME
pub fn hangar_home() -> PathBuf;                     // $HANGAR_HOME か ~/.agent-hangar

// src/node.rs
pub struct Manifest { pub version: String, pub node_major: u32, pub arch: String }   // server-dist/manifest.json
pub struct NodeProbe { pub major: u32, pub arch: String }
pub struct Tried { pub path: PathBuf, pub probe: Option<NodeProbe> }
pub enum NodeError { NotFound { manifest: Manifest, tried: Vec<Tried> } }
pub fn read_manifest(server_dir: &Path) -> Result<Manifest, String>;
pub fn settings_node_path(hangar_home: &Path) -> Option<PathBuf>;        // settings.json の nodePath
pub fn nvm_node_paths(user_home: &Path) -> Vec<PathBuf>;                 // 新しい版が先
pub fn candidate_paths(user_home: &Path, hangar_home: &Path) -> Vec<PathBuf>;   // settings、homebrew、/usr/local、nvm
pub fn parse_probe(output: &str) -> Option<NodeProbe>;                   // "v22.14.0 arm64"
pub fn probe_node(path: &Path) -> Option<NodeProbe>;                     // node -e を実行
pub fn choose_node(candidates: &[PathBuf], manifest: &Manifest, probe: impl Fn(&Path) -> Option<NodeProbe>) -> Result<PathBuf, NodeError>;
pub fn describe_error(e: &NodeError) -> String;                          // 読み込み画面に出す文言

// src/deeplink.rs
pub fn deep_link_to_hash(raw: &str) -> Option<String>;   // hangar://session/x → "#/session/x"
pub fn hash_to_js(hash: &str) -> String;                 // "location.hash = \"#/session/x\";"

// src/health.rs
pub fn decode_chunked(body: &[u8]) -> Vec<u8>;
pub fn http_get(addr: SocketAddr, path: &str, timeout: Duration) -> Option<(u16, String)>;
pub fn is_healthy(status: u16, body: &str) -> bool;      // 200 かつ {"ok":true}
pub fn probe_health(addr: SocketAddr) -> bool;
pub fn wait_until(deadline: Duration, interval: Duration, probe: impl FnMut() -> bool, sleep: impl FnMut(Duration), elapsed: impl FnMut() -> Duration) -> bool;
pub fn wait_for_health(addr: SocketAddr, deadline: Duration) -> bool;    // 250 ミリ秒間隔

// src/server.rs
pub const PORT: u16 = 4177;
pub fn server_dir(resource_dir: &Path) -> Option<PathBuf>;   // HANGAR_SERVER_DIR、server/、_up_/server-dist/
pub struct ServerProcess;
pub fn spawn_server(node: &Path, dir: &Path, hangar_home: &Path, log: &Path) -> std::io::Result<ServerProcess>;
impl ServerProcess { pub fn pid(&self) -> u32; pub fn is_running(&mut self) -> bool; pub fn stop(&mut self); }
pub fn strip_quarantine(dir: &Path);
```

```ts
// apps/desktop/scripts/bundle-server.ts
export type BundleOptions = { repoRoot: string; outDir: string; uiDist: string };
export const NATIVE_MODULES: string[];
export function bundleServer(opts: BundleOptions): Promise<{ files: string[] }>;
// server-dist/manifest.json の形
type Manifest = { version: string; nodeMajor: number; arch: string; builtAt: string };

// packages/shared/src/api.ts（変更）
export type SettingsDto = { workspaceRoot: string; claudeDir: string; nodePath?: string | null };
```

子プロセスに渡す環境変数は `HANGAR_PARENT_PID`（アプリの pid）、`HANGAR_PORT`（4177）、`HANGAR_UI_DIST`（`<server dir>/ui`）、`HANGAR_HOME`（`~/.agent-hangar`）の四つである。

---

### Task 1: apps/desktop の土台（Tauri プロジェクト、設定、読み込み画面、アイコン）

**Files:**
- Modify: `package.json`（workspaces）、`vitest.config.ts`（projects）、`.gitignore`
- Create: `apps/desktop/package.json`、`apps/desktop/tsconfig.json`、`apps/desktop/vitest.config.ts`、`apps/desktop/loading/index.html`、`apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/build.rs`、`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/Info.plist`、`apps/desktop/src-tauri/capabilities/default.json`、`apps/desktop/src-tauri/icon.svg`、`apps/desktop/src-tauri/icons/`（生成）、`apps/desktop/src-tauri/src/main.rs`、`apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/desktop/test/config.test.ts`

**Interfaces:**
- Produces: `tauri.conf.json` の不変条件。`identifier` は `dev.agent-hangar.hangar`、スキームは `hangar`、`bundle.resources` は `{ "../server-dist/**/*": "server/" }`、`frontendDist` は `../loading`、`bundle.targets` は `["app"]`。読み込み画面は `id="status"` の要素を持ち、Rust はその `textContent` と `dataset.level` を書き換える。
- 後のタスクは `src/lib.rs` の先頭に `pub mod <名前>;` を足してモジュールを増やす。Task 6 が `lib.rs` を丸ごと置き換える。

- [ ] **Step 1: 失敗するテストを書く**

`apps/desktop/test/config.test.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(app, p), 'utf8');

describe('tauri.conf.json', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  it('hangar スキームを登録し、同梱サーバを server/ に置き、読み込み画面から始める', () => {
    expect(conf.plugins['deep-link'].desktop.schemes).toEqual(['hangar']);
    expect(conf.bundle.resources).toEqual({ '../server-dist/**/*': 'server/' });
    expect(conf.bundle.targets).toEqual(['app']);
    expect(conf.identifier).toBe('dev.agent-hangar.hangar');
    expect(conf.build.frontendDist).toBe('../loading');
    expect(fs.existsSync(path.join(app, 'src-tauri', conf.build.frontendDist, 'index.html'))).toBe(true);
    expect(conf.app.windows[0]).toMatchObject({ label: 'main', title: 'agent-hangar', width: 1400, height: 900 });
  });
  it('版は package.json と Cargo.toml と一致する', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(conf.version).toBe(pkg.version);
    expect(read('src-tauri/Cargo.toml')).toContain(`version = "${pkg.version}"`);
  });
});

describe('Info.plist', () => {
  it('iTerm2 の AppleScript 用の説明文を持つ', () => {
    expect(read('src-tauri/Info.plist')).toContain('NSAppleEventsUsageDescription');
  });
});

describe('読み込み画面', () => {
  it('status 要素とダーク対応を持つ', () => {
    const html = read('loading/index.html');
    expect(html).toContain('id="status"');
    expect(html).toContain('prefers-color-scheme: dark');
  });
});
```

- [ ] **Step 2: ワークスペースと設定を書く**

`package.json` の `workspaces` を次に変える（他の行はそのまま）。

```json
  "workspaces": ["packages/*", "apps/*"],
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: ['packages/*', 'apps/*'] } });
```

`.gitignore` に次を足す。

```
apps/desktop/server-dist/
apps/desktop/src-tauri/target/
apps/desktop/src-tauri/gen/schemas/
```

`apps/desktop/package.json`：

```json
{
  "name": "@agent-hangar/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p .",
    "bundle-server": "node --import tsx scripts/bundle-server.ts",
    "tauri": "tauri"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.11.0",
    "esbuild": "^0.25.0",
    "tsx": "^4.23.13"
  }
}
```

`apps/desktop/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["scripts", "test"]
}
```

`apps/desktop/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'desktop', environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 60_000 } });
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npm install && npx vitest run apps/desktop`
Expected: FAIL（`tauri.conf.json` が無い）

- [ ] **Step 4: 読み込み画面を書く**

`apps/desktop/loading/index.html`：

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <title>agent-hangar</title>
    <style>
      :root { --bg: #fbfbfa; --ink: #1c1b19; --ink-2: #5f5c55; --error: #b3261e; }
      @media (prefers-color-scheme: dark) { :root { --bg: #17171a; --ink: #e8e6e1; --ink-2: #9a978f; --error: #ef7a72; } }
      html, body { height: 100%; margin: 0; }
      body { display: grid; place-items: center; background: var(--bg); color: var(--ink-2); font: 13px/1.5 'Inter Variable', 'Hiragino Sans', sans-serif; -webkit-font-smoothing: antialiased; }
      main { max-width: 560px; padding: 16px; text-align: center; white-space: pre-wrap; }
      h1 { font-size: 15px; font-weight: 600; color: var(--ink); margin: 0 0 8px; }
      #status[data-level='error'] { color: var(--error); text-align: left; font-family: 'JetBrains Mono Variable', Menlo, monospace; font-size: 12px; }
    </style>
  </head>
  <body>
    <main>
      <h1>agent-hangar</h1>
      <p id="status">サーバを起動しています</p>
    </main>
  </body>
</html>
```

- [ ] **Step 5: Tauri プロジェクトを書く**

`apps/desktop/src-tauri/Cargo.toml`：

```toml
[package]
name = "hangar-desktop"
version = "0.1.0"
description = "agent-hangar desktop shell"
edition = "2021"
rust-version = "1.80"

[lib]
name = "hangar_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-deep-link = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
url = "2"
libc = "0.2"

[dev-dependencies]
tempfile = "3"

# サイズ最適化。spike 08 と同じ設定で 4MB の .app になった。
[profile.release]
codegen-units = 1
lto = true
opt-level = 3
panic = "abort"
strip = true
```

`apps/desktop/src-tauri/build.rs`：

```rust
fn main() {
    tauri_build::build()
}
```

`apps/desktop/src-tauri/tauri.conf.json`：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Hangar",
  "version": "0.1.0",
  "identifier": "dev.agent-hangar.hangar",
  "build": {
    "frontendDist": "../loading",
    "beforeBuildCommand": "npm run bundle-server"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "agent-hangar",
        "width": 1400,
        "height": 900,
        "minWidth": 900,
        "minHeight": 600
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["app"],
    "category": "DeveloperTool",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns"
    ],
    "resources": {
      "../server-dist/**/*": "server/"
    },
    "macOS": {
      "minimumSystemVersion": "13.0"
    }
  },
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["hangar"]
      }
    }
  }
}
```

`apps/desktop/src-tauri/Info.plist`（Tauri が生成する Info.plist に併合される）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSAppleEventsUsageDescription</key>
  <string>iTerm2 でセッションのターミナルを開くために、iTerm2 を AppleScript で制御します。</string>
</dict>
</plist>
```

`apps/desktop/src-tauri/capabilities/default.json`：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "メインウィンドウの権限。UI はサーバの URL から読み込むので、Tauri の JS API は使わない。",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

`apps/desktop/src-tauri/icon.svg`（仮のアイコン。格納庫のアーチと機体）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect width="1024" height="1024" rx="224" fill="#1c1b19"/>
  <path d="M192 768 V520 a320 320 0 0 1 640 0 V768 Z" fill="none" stroke="#fbfbfa" stroke-width="56" stroke-linejoin="round"/>
  <rect x="432" y="560" width="160" height="208" rx="16" fill="#2f5fd0"/>
</svg>
```

`apps/desktop/src-tauri/src/main.rs`：

```rust
// リリースビルドで Windows のコンソールを出さないための属性。macOS では無害。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hangar_desktop_lib::run()
}
```

`apps/desktop/src-tauri/src/lib.rs`（骨格。Task 6 で置き換える）：

```rust
//! agent-hangar のデスクトップシェル。
//! サーバを子プロセスとして起動し、ウィンドウに UI を表示する。
//! 各モジュールは後のタスクで足し、この骨格は Task 6 で置き換える。

use tauri_plugin_deep_link::DeepLinkExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            app.deep_link().on_open_url(|event| {
                eprintln!("deep link: {:?}", event.urls());
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 6: アイコンを生成する**

Run: `cd apps/desktop && npx tauri icon src-tauri/icon.svg`
Expected: `apps/desktop/src-tauri/icons/` に `icon.icns`、`32x32.png`、`128x128.png`、`128x128@2x.png` を含むファイル群ができる

- [ ] **Step 7: テストと cargo check**

Run: `npx vitest run apps/desktop && npm run typecheck && cd apps/desktop/src-tauri && cargo check`
Expected: vitest は PASS（4 件）。`cargo check` は初回の依存の取得を含めて数分で終わり、エラーが無い

- [ ] **Step 8: コミット**

```bash
git add package.json package-lock.json vitest.config.ts .gitignore apps/desktop
git commit -m "feat(desktop): tauri scaffold with loading page, deep-link scheme and placeholder icon"
```

---

### Task 2: サーバと CLI の単一ファイルバンドル

**Files:**
- Create: `apps/desktop/scripts/bundle-server.ts`、`apps/desktop/scripts/hangar.sh`
- Modify: `packages/server/src/server.ts`（`uiDist` の 1 行）
- Test: `apps/desktop/test/bundle-server.test.ts`

**Interfaces:**
- Produces: `bundleServer(opts: BundleOptions): Promise<{ files: string[] }>`。`server-dist/` の中身は `server.mjs`、`cli.mjs`、`ui/`、`node_modules/<ネイティブモジュール>`、`bin/hangar`、`manifest.json`。
- `manifest.json` は `{ version, nodeMajor, arch, builtAt }`。`nodeMajor` と `arch` はバンドルを作った Node の値で、Task 3 の `Manifest` がこれを読む。
- `startServer` が `process.env.HANGAR_UI_DIST` を見る。Task 6 の `spawn_server` がこの環境変数に `<server dir>/ui` を渡す。
- 前提：`packages/ui/dist` が先にできていること（`npm run build`）。

- [ ] **Step 1: 失敗するテストを書く**

`apps/desktop/test/bundle-server.test.ts`：

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleServer } from '../scripts/bundle-server.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function waitHealth(url: string, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok && (await r.json()).ok === true) return true; } catch { /* まだ起きていない */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe('bundleServer', () => {
  it('server.mjs、cli.mjs、ui、ネイティブモジュール、manifest、bin/hangar を出し、tsx 無しで起動する', async () => {
    const out = tmp('hangar-dist-'); const ui = tmp('hangar-ui-'); const home = tmp('hangar-home-'); const claude = tmp('hangar-claude-'); const ws = tmp('hangar-ws-');
    dirs.push(out, ui, home, claude, ws);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    fs.mkdirSync(path.join(claude, 'projects')); fs.mkdirSync(path.join(claude, 'sessions'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir: claude }));

    const r = await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    expect(r.files.sort()).toEqual(['bin', 'cli.mjs', 'manifest.json', 'node_modules', 'server.mjs', 'ui']);
    for (const f of ['ui/index.html', 'node_modules/better-sqlite3/package.json', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'node_modules/bindings/bindings.js', 'node_modules/file-uri-to-path/index.js']) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }
    expect(fs.existsSync(path.join(out, 'node_modules/better-sqlite3/deps'))).toBe(false);
    expect(fs.statSync(path.join(out, 'bin/hangar')).mode & 0o111).not.toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ version: '0.1.0', nodeMajor: Number(process.versions.node.split('.')[0]), arch: process.arch });
    expect(fs.readFileSync(path.join(out, 'server.mjs'), 'utf8')).not.toContain('from "tsx"');

    const child = spawn(process.execPath, [path.join(out, 'server.mjs')], {
      env: { ...process.env, HANGAR_HOME: home, HANGAR_CLAUDE_DIR: claude, HANGAR_PORT: '4199', HANGAR_UI_DIST: path.join(out, 'ui') },
      stdio: 'ignore',
    });
    try {
      expect(await waitHealth('http://127.0.0.1:4199/health', 20_000)).toBe(true);
      const html = await (await fetch('http://127.0.0.1:4199/')).text();
      expect(html).toContain('bundled-ui');
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run apps/desktop/test/bundle-server`
Expected: FAIL（`bundle-server.ts` が無い）

- [ ] **Step 3: サーバが `HANGAR_UI_DIST` を見るようにする**

`packages/server/src/server.ts` の `uiDist` を決める行を次に変える。

```ts
  // 配布版（Tauri のバンドル）では UI の置き場所を環境変数で受ける。無ければ packages/ui/dist を使う。
  const uiDist = opts.uiDist ?? process.env.HANGAR_UI_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
```

- [ ] **Step 4: バンドルの生成を書く**

`apps/desktop/scripts/hangar.sh`（`server-dist/bin/hangar` として配置する）：

```sh
#!/bin/sh
# agent-hangar の CLI を、配布版の .app に同梱したバンドルから起動する。
# Node は PATH に頼らず、アプリ本体と同じ順（settings.json の nodePath、Homebrew、/usr/local、nvm）で探し、
# manifest.json と同じメジャー版だけを使う。
set -e
here="$(cd "$(dirname "$0")" && pwd)"
dist="$here/.."
want="$(sed -n 's/.*"nodeMajor": *\([0-9]*\).*/\1/p' "$dist/manifest.json")"
home="${HANGAR_HOME:-$HOME/.agent-hangar}"
custom=""
[ -f "$home/settings.json" ] && custom="$(sed -n 's/.*"nodePath": *"\([^"]*\)".*/\1/p' "$home/settings.json")"
candidates="$custom /opt/homebrew/bin/node /usr/local/bin/node"
for d in $(ls -d "$HOME"/.nvm/versions/node/*/ 2>/dev/null | sort -r); do candidates="$candidates ${d}bin/node"; done
for n in $candidates; do
  [ -x "$n" ] || continue
  major="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  if [ "$major" = "$want" ]; then
    export HANGAR_UI_DIST="$dist/ui"
    exec "$n" "$dist/cli.mjs" "$@"
  fi
done
echo "Node $want が見つかりません。nvm install $want を実行するか、$home/settings.json の nodePath で場所を指定してください。" >&2
exit 1
```

`apps/desktop/scripts/bundle-server.ts`：

```ts
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BundleOptions = { repoRoot: string; outDir: string; uiDist: string };

/** バンドルに入れず、隣の node_modules から読ませるモジュール。node-pty はフェーズ 2 以降に現れる。 */
export const NATIVE_MODULES = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'node-pty'];
/** ws が任意依存として require する二つは、無くても動くので外部にしておく。 */
const EXTERNALS = [...NATIVE_MODULES, 'bufferutil', 'utf-8-validate'];
/** ネイティブモジュールのうち、実行に要らない大きなディレクトリ。 */
const SKIP_IN_NATIVE = /\/(deps|src|test|build\/Release\/obj(\.target)?)(\/|$)/;

const BANNER = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

export async function bundleServer(opts: BundleOptions): Promise<{ files: string[] }> {
  if (!fs.existsSync(path.join(opts.uiDist, 'index.html'))) {
    throw new Error(`UI のビルドがありません: ${opts.uiDist}（先に npm run build を実行してください）`);
  }
  fs.rmSync(opts.outDir, { recursive: true, force: true });
  fs.mkdirSync(opts.outDir, { recursive: true });

  const entries = [['packages/server/src/main.ts', 'server.mjs'], ['packages/cli/src/index.ts', 'cli.mjs']] as const;
  for (const [entry, out] of entries) {
    await build({
      entryPoints: [path.join(opts.repoRoot, entry)],
      bundle: true, platform: 'node', format: 'esm', target: 'node22',
      outfile: path.join(opts.outDir, out),
      external: EXTERNALS,
      banner: { js: BANNER },
      logLevel: 'silent',
    });
  }

  fs.cpSync(opts.uiDist, path.join(opts.outDir, 'ui'), { recursive: true });

  for (const m of NATIVE_MODULES) {
    const src = path.join(opts.repoRoot, 'node_modules', m);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(opts.outDir, 'node_modules', m), { recursive: true, dereference: true, filter: (p) => !SKIP_IN_NATIVE.test(p) });
  }

  fs.mkdirSync(path.join(opts.outDir, 'bin'));
  fs.copyFileSync(fileURLToPath(new URL('./hangar.sh', import.meta.url)), path.join(opts.outDir, 'bin', 'hangar'));
  fs.chmodSync(path.join(opts.outDir, 'bin', 'hangar'), 0o755);

  const pkg = JSON.parse(fs.readFileSync(path.join(opts.repoRoot, 'apps/desktop/package.json'), 'utf8')) as { version: string };
  const manifest = { version: pkg.version, nodeMajor: Number(process.versions.node.split('.')[0]), arch: process.arch, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(opts.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  return { files: fs.readdirSync(opts.outDir) };
}

// `node --import tsx scripts/bundle-server.ts` として直接呼ばれたときだけ実行する。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../../..');
  bundleServer({ repoRoot, outDir: path.resolve(here, '../server-dist'), uiDist: path.join(repoRoot, 'packages/ui/dist') })
    .then((r) => console.log(`server-dist: ${r.files.join(', ')}`))
    .catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run apps/desktop && npm run typecheck && npx vitest run packages/server`
Expected: PASS。バンドルしたサーバが tsx 無しで `/health` に応え、`HANGAR_UI_DIST` の `index.html` を配信する

- [ ] **Step 6: 実物のバンドルを作って大きさを見る**

Run: `npm run build && npm run bundle-server -w apps/desktop && du -sh apps/desktop/server-dist apps/desktop/server-dist/*`
Expected: `server-dist` ができ、`server.mjs` は数 MB、`node_modules` は `better-sqlite3` の `.node` を含めて 15MB 未満

- [ ] **Step 7: コミット**

```bash
git add apps/desktop/scripts apps/desktop/test/bundle-server.test.ts packages/server/src/server.ts
git commit -m "feat(desktop): esbuild bundle of server and cli with native modules and manifest"
```

---

### Task 3: Node の探索と版の照合、CI の desktop ジョブ

**Files:**
- Create: `apps/desktop/src-tauri/src/paths.rs`、`apps/desktop/src-tauri/src/node.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（先頭に `pub mod node;` と `pub mod paths;`）、`.github/workflows/ci.yml`
- Test: 各ファイルの `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: 「インターフェース一覧」の `paths.rs` と `node.rs` の全項目。
- `choose_node` は純関数で、`probe` を差し替えてテストする。実物の `probe_node` は `node -e "console.log(process.version, process.arch)"` を起動する。
- `describe_error` の文言は「Node 22（arm64）が見つかりません。」で始まり、調べた場所を 1 行ずつ並べる。Task 6 がこれを読み込み画面に出す。

- [ ] **Step 1: 失敗するテストを書く**

`apps/desktop/src-tauri/src/paths.rs`（テストだけ先に書く。本体は Step 3）：

```rust
//! ホームディレクトリとデータディレクトリ。
use std::path::PathBuf;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hangar_home_defaults_under_user_home() {
        std::env::remove_var("HANGAR_HOME");
        assert_eq!(hangar_home(), user_home().join(".agent-hangar"));
        std::env::set_var("HANGAR_HOME", "/tmp/h");
        assert_eq!(hangar_home(), PathBuf::from("/tmp/h"));
        std::env::remove_var("HANGAR_HOME");
    }
}
```

`apps/desktop/src-tauri/src/node.rs`（テストだけ先に書く。本体は Step 3）：

```rust
//! Node の探索。PATH に頼らず、決まった候補を順に調べ、同梱したネイティブモジュールと ABI が合う版だけを採る。
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn manifest() -> Manifest {
        Manifest { version: "0.1.0".into(), node_major: 22, arch: "arm64".into() }
    }

    #[test]
    fn nvm_versions_are_sorted_newest_first() {
        let home = tempfile::tempdir().unwrap();
        for v in ["v20.1.0", "v22.14.0", "v22.9.0", "junk"] {
            std::fs::create_dir_all(home.path().join(".nvm/versions/node").join(v).join("bin")).unwrap();
        }
        let base = home.path().join(".nvm/versions/node");
        assert_eq!(
            nvm_node_paths(home.path()),
            vec![base.join("v22.14.0/bin/node"), base.join("v22.9.0/bin/node"), base.join("v20.1.0/bin/node")]
        );
        assert!(nvm_node_paths(Path::new("/nonexistent")).is_empty());
    }

    #[test]
    fn candidates_put_settings_first_then_fixed_then_nvm() {
        let user = tempfile::tempdir().unwrap();
        let hangar = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(user.path().join(".nvm/versions/node/v22.14.0/bin")).unwrap();
        std::fs::write(hangar.path().join("settings.json"), r#"{ "workspaceRoot": "/w", "nodePath": "/custom/node" }"#).unwrap();
        let got = candidate_paths(user.path(), hangar.path());
        assert_eq!(
            got,
            vec![
                PathBuf::from("/custom/node"),
                PathBuf::from("/opt/homebrew/bin/node"),
                PathBuf::from("/usr/local/bin/node"),
                user.path().join(".nvm/versions/node/v22.14.0/bin/node"),
            ]
        );
    }

    #[test]
    fn settings_node_path_ignores_missing_empty_and_null() {
        let hangar = tempfile::tempdir().unwrap();
        let file = hangar.path().join("settings.json");
        assert_eq!(settings_node_path(hangar.path()), None);
        std::fs::write(&file, r#"{ "nodePath": "" }"#).unwrap();
        assert_eq!(settings_node_path(hangar.path()), None);
        std::fs::write(&file, r#"{ "nodePath": null }"#).unwrap();
        assert_eq!(settings_node_path(hangar.path()), None);
        std::fs::write(&file, r#"{ "nodePath": " /x/node " }"#).unwrap();
        assert_eq!(settings_node_path(hangar.path()), Some(PathBuf::from("/x/node")));
    }

    #[test]
    fn parse_probe_reads_version_and_arch() {
        assert_eq!(parse_probe("v22.14.0 arm64\n"), Some(NodeProbe { major: 22, arch: "arm64".into() }));
        assert_eq!(parse_probe("garbage"), None);
        assert_eq!(parse_probe(""), None);
    }

    #[test]
    fn choose_node_takes_first_compatible_and_reports_tried() {
        let probes: HashMap<PathBuf, NodeProbe> = HashMap::from([
            (PathBuf::from("/a/node"), NodeProbe { major: 24, arch: "arm64".into() }),
            (PathBuf::from("/c/node"), NodeProbe { major: 22, arch: "arm64".into() }),
            (PathBuf::from("/d/node"), NodeProbe { major: 22, arch: "arm64".into() }),
        ]);
        let probe = |p: &Path| probes.get(p).cloned();
        let cands = ["/a/node", "/b/node", "/c/node", "/d/node"].map(PathBuf::from);
        assert_eq!(choose_node(&cands, &manifest(), probe), Ok(PathBuf::from("/c/node")));

        let x64 = Manifest { arch: "x64".into(), ..manifest() };
        let err = choose_node(&cands, &x64, probe).unwrap_err();
        let NodeError::NotFound { tried, .. } = &err;
        assert_eq!(tried.len(), 4);
        assert_eq!(tried[1], Tried { path: PathBuf::from("/b/node"), probe: None });
        let text = describe_error(&err);
        assert!(text.starts_with("Node 22（x64）が見つかりません。"), "{text}");
        assert!(text.contains("/a/node: v24 arm64"), "{text}");
        assert!(text.contains("/b/node: 無し"), "{text}");
        assert!(text.contains("nvm install 22"), "{text}");
    }

    #[test]
    fn read_manifest_parses_and_reports_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_manifest(dir.path()).unwrap_err().contains("読めません"));
        std::fs::write(dir.path().join("manifest.json"), r#"{ "version": "0.1.0", "nodeMajor": 22, "arch": "arm64", "builtAt": "x" }"#).unwrap();
        assert_eq!(read_manifest(dir.path()).unwrap(), manifest());
        std::fs::write(dir.path().join("manifest.json"), "{").unwrap();
        assert!(read_manifest(dir.path()).unwrap_err().contains("壊れています"));
    }

    #[test]
    fn probe_node_is_none_for_missing_binary() {
        assert_eq!(probe_node(Path::new("/nonexistent/node")), None);
    }
}
```

`apps/desktop/src-tauri/src/lib.rs` の先頭（`use` の前）に足す。

```rust
pub mod node;
pub mod paths;
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: コンパイルエラー（`hangar_home`、`Manifest` などが未定義）

- [ ] **Step 3: 実装する**

`apps/desktop/src-tauri/src/paths.rs` の `use` とテストの間に足す。

```rust
/// 利用者のホーム。`HOME` が無ければ `/`。
pub fn user_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// hangar のデータディレクトリ。サーバと同じく `HANGAR_HOME` を優先する。
pub fn hangar_home() -> PathBuf {
    std::env::var_os("HANGAR_HOME").map(PathBuf::from).unwrap_or_else(|| user_home().join(".agent-hangar"))
}
```

`apps/desktop/src-tauri/src/node.rs` の `use` とテストの間に足す。

```rust
/// 同梱サーバのビルド条件。`server-dist/manifest.json` の内容。
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(rename = "nodeMajor")]
    pub node_major: u32,
    pub arch: String,
}

/// 候補の Node を起動して得た版とアーキテクチャ。
#[derive(Debug, Clone, PartialEq)]
pub struct NodeProbe {
    pub major: u32,
    pub arch: String,
}

/// 調べた候補と結果。`None` は起動できなかった（無い、実行不可）ことを表す。
#[derive(Debug, Clone, PartialEq)]
pub struct Tried {
    pub path: PathBuf,
    pub probe: Option<NodeProbe>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NodeError {
    NotFound { manifest: Manifest, tried: Vec<Tried> },
}

pub fn read_manifest(server_dir: &Path) -> Result<Manifest, String> {
    let file = server_dir.join("manifest.json");
    let text = std::fs::read_to_string(&file).map_err(|e| format!("{} を読めません: {e}", file.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} が壊れています: {e}", file.display()))
}

/// `settings.json` の `nodePath`。空文字と null は無しとみなす。
pub fn settings_node_path(hangar_home: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(hangar_home.join("settings.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let s = v.get("nodePath")?.as_str()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn parse_version(name: &str) -> Option<(u32, u32, u32)> {
    let mut it = name.strip_prefix('v')?.split('.').map(|s| s.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

/// nvm が入れた Node を新しい版から順に並べる。
pub fn nvm_node_paths(user_home: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(user_home.join(".nvm/versions/node")) else {
        return Vec::new();
    };
    let mut found: Vec<((u32, u32, u32), PathBuf)> = rd
        .flatten()
        .filter_map(|e| parse_version(&e.file_name().to_string_lossy()).map(|v| (v, e.path().join("bin/node"))))
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// 探索の順序。Settings の明示、Homebrew、/usr/local、nvm（新しい版が先）。
pub fn candidate_paths(user_home: &Path, hangar_home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = settings_node_path(hangar_home) {
        out.push(p);
    }
    out.push(PathBuf::from("/opt/homebrew/bin/node"));
    out.push(PathBuf::from("/usr/local/bin/node"));
    out.extend(nvm_node_paths(user_home));
    out
}

/// `node -e "console.log(process.version, process.arch)"` の出力（例 `v22.14.0 arm64`）を読む。
pub fn parse_probe(output: &str) -> Option<NodeProbe> {
    let mut it = output.split_whitespace();
    let version = it.next()?;
    let arch = it.next()?;
    let (major, _, _) = parse_version(version)?;
    Some(NodeProbe { major, arch: arch.to_string() })
}

pub fn probe_node(path: &Path) -> Option<NodeProbe> {
    if !path.is_file() {
        return None;
    }
    let out = Command::new(path).args(["-e", "console.log(process.version, process.arch)"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

/// 候補を順に調べ、manifest と同じメジャー版かつ同じアーキテクチャの最初の Node を返す。
pub fn choose_node(
    candidates: &[PathBuf],
    manifest: &Manifest,
    probe: impl Fn(&Path) -> Option<NodeProbe>,
) -> Result<PathBuf, NodeError> {
    let mut tried = Vec::new();
    for c in candidates {
        let p = probe(c);
        if let Some(pr) = &p {
            if pr.major == manifest.node_major && pr.arch == manifest.arch {
                return Ok(c.clone());
            }
        }
        tried.push(Tried { path: c.clone(), probe: p });
    }
    Err(NodeError::NotFound { manifest: manifest.clone(), tried })
}

/// 利用者に見せる文言。読み込み画面にそのまま出す。
pub fn describe_error(e: &NodeError) -> String {
    let NodeError::NotFound { manifest, tried } = e;
    let mut lines = vec![
        format!("Node {}（{}）が見つかりません。", manifest.node_major, manifest.arch),
        format!(
            "nvm install {} を実行するか、~/.agent-hangar/settings.json の nodePath で場所を指定してください。",
            manifest.node_major
        ),
        "調べた場所:".to_string(),
    ];
    for t in tried {
        let what = match &t.probe {
            Some(p) => format!("v{} {}", p.major, p.arch),
            None => "無し".to_string(),
        };
        lines.push(format!("  {}: {}", t.path.display(), what));
    }
    lines.join("\n")
}
```

- [ ] **Step 4: テストを通す**

Run: `cd apps/desktop/src-tauri && cargo fmt && cargo test`
Expected: PASS（8 件）

- [ ] **Step 5: CI に desktop ジョブを足す**

`.github/workflows/ci.yml` の `jobs:` に次のジョブを足す（`check` ジョブはそのまま）。
public リポジトリでは macOS ランナーも無料枠に入るので、Rust のテストは macOS で回す。
`bundle.resources` は glob なので、`server-dist` が無くても `tauri-build` は失敗しない。

```yaml
  desktop:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: apps/desktop/src-tauri
      - run: cargo fmt --check
        working-directory: apps/desktop/src-tauri
      - run: cargo test
        working-directory: apps/desktop/src-tauri
```

Run: `ruby -ryaml -e 'puts YAML.load_file(".github/workflows/ci.yml")["jobs"].keys.join(",")'`
Expected: `check,desktop`

- [ ] **Step 6: コミット**

```bash
git add apps/desktop/src-tauri/src .github/workflows/ci.yml
git commit -m "feat(desktop): node lookup with settings override and abi check, desktop ci job"
```

---

### Task 4: ディープリンクの変換

**Files:**
- Create: `apps/desktop/src-tauri/src/deeplink.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`pub mod deeplink;`）
- Test: `deeplink.rs` の `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `deep_link_to_hash(raw: &str) -> Option<String>`、`hash_to_js(hash: &str) -> String`。
- 変換先は `packages/shared/src/route.ts` の `formatRoute` と同じ形で、`parseRoute` がそのまま読める。`search` の `q` は `form_urlencoded` で符号化するので空白は `+` になるが、UI 側の `URLSearchParams` は `+` を空白に戻す。
- 三形以外（`hangar://settings` など）と `hangar` 以外のスキームは `None` で、Task 6 はログに残して無視する。

- [ ] **Step 1: 失敗するテストを書く**

`apps/desktop/src-tauri/src/deeplink.rs`：

```rust
//! `hangar://` の URL を UI のハッシュ経路に変換する。
//! 変換先は shared の `formatRoute` と同じ形（`#/session/<id>`、`#/project/<id>`、`#/sessions?q=<text>`）。
use url::Url;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_and_project_map_to_hash_routes() {
        assert_eq!(deep_link_to_hash("hangar://session/0192abc"), Some("#/session/0192abc".into()));
        assert_eq!(deep_link_to_hash("hangar://session/0192abc/"), Some("#/session/0192abc".into()));
        assert_eq!(deep_link_to_hash("hangar://project/p1"), Some("#/project/p1".into()));
    }

    #[test]
    fn search_maps_to_sessions_with_encoded_query() {
        assert_eq!(deep_link_to_hash("hangar://search?q=%E5%8B%95%E7%94%BB"), Some("#/sessions?q=%E5%8B%95%E7%94%BB".into()));
        assert_eq!(deep_link_to_hash("hangar://search?q=a%20b"), Some("#/sessions?q=a+b".into()));
        assert_eq!(deep_link_to_hash("hangar://search"), Some("#/sessions".into()));
        assert_eq!(deep_link_to_hash("hangar://search?q="), Some("#/sessions".into()));
    }

    #[test]
    fn unknown_shapes_are_rejected() {
        assert_eq!(deep_link_to_hash("hangar://session"), None);
        assert_eq!(deep_link_to_hash("hangar://session/a/b"), None);
        assert_eq!(deep_link_to_hash("hangar://settings"), None);
        assert_eq!(deep_link_to_hash("https://session/abc"), None);
        assert_eq!(deep_link_to_hash("not a url"), None);
    }

    #[test]
    fn hash_to_js_quotes_as_json() {
        assert_eq!(hash_to_js("#/session/a\"b"), "location.hash = \"#/session/a\\\"b\";");
    }
}
```

`lib.rs` の先頭に `pub mod deeplink;` を足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `cd apps/desktop/src-tauri && cargo test deeplink`
Expected: コンパイルエラー（`deep_link_to_hash` が未定義）

- [ ] **Step 3: 実装する**

`deeplink.rs` の `use` とテストの間に足す。

```rust
pub fn deep_link_to_hash(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "hangar" {
        return None;
    }
    let kind = url.host_str()?;
    let id = url.path().trim_matches('/');
    match kind {
        "session" | "project" => {
            if id.is_empty() || id.contains('/') {
                return None;
            }
            Some(format!("#/{kind}/{id}"))
        }
        "search" => {
            let q = url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
            if q.trim().is_empty() {
                return Some("#/sessions".to_string());
            }
            let encoded: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
            Some(format!("#/sessions?q={encoded}"))
        }
        _ => None,
    }
}

/// webview で評価する JS。ハッシュが変わると UI の runtime が `hash.changed` を Mediator に流す。
pub fn hash_to_js(hash: &str) -> String {
    format!("location.hash = {};", serde_json::to_string(hash).unwrap_or_else(|_| "\"#/\"".to_string()))
}
```

- [ ] **Step 4: テストを通す**

Run: `cd apps/desktop/src-tauri && cargo fmt && cargo test deeplink`
Expected: PASS（4 件）

- [ ] **Step 5: コミット**

```bash
git add apps/desktop/src-tauri/src/deeplink.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): translate hangar:// deep links to ui hash routes"
```

---

### Task 5: `/health` の待機

**Files:**
- Create: `apps/desktop/src-tauri/src/health.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`pub mod health;`）
- Test: `health.rs` の `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: 「インターフェース一覧」の `health.rs` の全項目。
- HTTP クライアントの crate を足さず、`TcpStream` に生の `GET` を書く。`Connection: close` を送るので `read_to_end` で応答全体を読める。`Transfer-Encoding: chunked` にも対応する。
- `is_healthy` は `{"ok":true,...}` を要求し、4177 に別のプログラムがいる場合を弾く。
- `wait_until` は時計と待ちを差し替えられる純関数で、`wait_for_health` はそれを 250 ミリ秒間隔と実時計で包む。

- [ ] **Step 1: 失敗するテストを書く**

`apps/desktop/src-tauri/src/health.rs`：

```rust
//! サーバの `/health` を待つ。依存を増やさず、生の HTTP を TcpStream で書く。
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::net::TcpListener;

    /// 1 接続だけ受けて固定の応答を返す。
    fn serve_once(response: &'static str) -> SocketAddr {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            s.write_all(response.as_bytes()).unwrap();
        });
        addr
    }

    #[test]
    fn http_get_reads_status_and_body() {
        let addr = serve_once("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 29\r\nConnection: close\r\n\r\n{\"ok\":true,\"version\":\"0.1.0\"}");
        let (status, body) = http_get(addr, "/health", Duration::from_secs(2)).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, "{\"ok\":true,\"version\":\"0.1.0\"}");
    }

    #[test]
    fn http_get_decodes_chunked_bodies() {
        let addr = serve_once("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nb\r\n{\"ok\":true}\r\n0\r\n\r\n");
        let (_, body) = http_get(addr, "/health", Duration::from_secs(2)).unwrap();
        assert_eq!(body, "{\"ok\":true}");
    }

    #[test]
    fn http_get_returns_none_when_nothing_listens() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        assert_eq!(http_get(addr, "/health", Duration::from_millis(500)), None);
    }

    #[test]
    fn is_healthy_requires_200_and_ok_true() {
        assert!(is_healthy(200, "{\"ok\":true,\"version\":\"0.1.0\"}"));
        assert!(!is_healthy(200, "{\"ok\":false}"));
        assert!(!is_healthy(200, "<html>"));
        assert!(!is_healthy(500, "{\"ok\":true}"));
    }

    #[test]
    fn wait_until_retries_then_succeeds_or_gives_up() {
        let calls = Cell::new(0);
        let clock = Cell::new(Duration::ZERO);
        let ok = wait_until(
            Duration::from_secs(20),
            Duration::from_millis(250),
            || { calls.set(calls.get() + 1); calls.get() == 3 },
            |d| clock.set(clock.get() + d),
            || clock.get(),
        );
        assert!(ok);
        assert_eq!(calls.get(), 3);
        assert_eq!(clock.get(), Duration::from_millis(500));

        let tries = Cell::new(0);
        let clock = Cell::new(Duration::ZERO);
        let ok = wait_until(
            Duration::from_secs(1),
            Duration::from_millis(250),
            || { tries.set(tries.get() + 1); false },
            |d| clock.set(clock.get() + d),
            || clock.get(),
        );
        assert!(!ok);
        assert_eq!(tries.get(), 5);
    }

    #[test]
    fn decode_chunked_joins_pieces() {
        assert_eq!(decode_chunked(b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"), b"abcde");
        assert_eq!(decode_chunked(b"garbage"), b"");
    }
}
```

`lib.rs` の先頭に `pub mod health;` を足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `cd apps/desktop/src-tauri && cargo test health`
Expected: コンパイルエラー（`http_get` などが未定義）

- [ ] **Step 3: 実装する**

`health.rs` の `use` とテストの間に足す。

```rust
/// chunked 転送のボディを連結する。境界はバイト単位で扱う。
pub fn decode_chunked(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let Some(nl) = rest.windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_text = String::from_utf8_lossy(&rest[..nl]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        let start = nl + 2;
        if rest.len() < start + size {
            break;
        }
        out.extend_from_slice(&rest[start..start + size]);
        rest = &rest[start + size..];
        if rest.starts_with(b"\r\n") {
            rest = &rest[2..];
        }
    }
    out
}

/// 1 回の GET。状態コードとボディを返す。接続できない、期限切れ、形が壊れていれば None。
pub fn http_get(addr: SocketAddr, path: &str, timeout: Duration) -> Option<(u16, String)> {
    let mut s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    let sep = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..sep]).to_string();
    let status: u16 = head.lines().next()?.split_whitespace().nth(1)?.parse().ok()?;
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let body = &buf[sep + 4..];
    let body = if chunked { decode_chunked(body) } else { body.to_vec() };
    Some((status, String::from_utf8_lossy(&body).to_string()))
}

/// hangar の `/health` の応答か。`{"ok":true,...}` を要求し、他のプログラムが 4177 にいる場合を弾く。
pub fn is_healthy(status: u16, body: &str) -> bool {
    status == 200
        && serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("ok")?.as_bool())
            .unwrap_or(false)
}

pub fn probe_health(addr: SocketAddr) -> bool {
    http_get(addr, "/health", Duration::from_secs(1)).map(|(s, b)| is_healthy(s, &b)).unwrap_or(false)
}

/// `probe` が真を返すまで `interval` ごとに試す。`deadline` を過ぎたら偽。時計と待ちは差し替えられる。
pub fn wait_until(
    deadline: Duration,
    interval: Duration,
    mut probe: impl FnMut() -> bool,
    mut sleep: impl FnMut(Duration),
    mut elapsed: impl FnMut() -> Duration,
) -> bool {
    loop {
        if probe() {
            return true;
        }
        if elapsed() >= deadline {
            return false;
        }
        sleep(interval);
    }
}

pub fn wait_for_health(addr: SocketAddr, deadline: Duration) -> bool {
    let t0 = Instant::now();
    wait_until(deadline, Duration::from_millis(250), || probe_health(addr), std::thread::sleep, || t0.elapsed())
}
```

- [ ] **Step 4: テストを通す**

Run: `cd apps/desktop/src-tauri && cargo fmt && cargo test health`
Expected: PASS（6 件）

- [ ] **Step 5: コミット**

```bash
git add apps/desktop/src-tauri/src/health.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): raw http health probe with bounded retry"
```

---

### Task 6: シェルの結線（起動、採用、終了、ディープリンク、検疫属性）と初回ビルド

**Files:**
- Create: `apps/desktop/src-tauri/src/server.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（全文を置き換える）
- Test: `server.rs` の `#[cfg(test)] mod tests`。`lib.rs` は Tauri のランタイムに依存するので、Task 7 の手動確認で検証する

**Interfaces:**
- Consumes: Task 3 の `node::*` と `paths::*`、Task 4 の `deeplink::*`、Task 5 の `health::*`。
- Produces: 「インターフェース一覧」の `server.rs` の全項目。
- 起動の流れ：`/health` が既に通れば採用。通らなければ同梱サーバの場所を探し、検疫属性を外し、`manifest.json` を読み、Node を選び、子を起こし、20 秒まで `/health` を待つ。成功したら `http://127.0.0.1:4177/<保持していたハッシュ>` へ `navigate` する。失敗は読み込み画面に文字で出す。
- ディープリンク：`ready` が真なら `location.hash = ...` を評価してウィンドウを前面に出す。偽なら `pending_hash` に保持する。
- 終了：`RunEvent::Exit` で `ServerProcess::stop()`。採用したサーバは止めない（`server` が `None`）。

- [ ] **Step 1: 失敗するテストを書く**

`apps/desktop/src-tauri/src/server.rs`：

```rust
//! サーバ子プロセスの起動と停止、同梱サーバの置き場所。
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_dir_finds_bundled_layouts() {
        let res = tempfile::tempdir().unwrap();
        assert_eq!(server_dir(res.path()), None);
        std::fs::create_dir_all(res.path().join("_up_/server-dist")).unwrap();
        std::fs::write(res.path().join("_up_/server-dist/server.mjs"), "").unwrap();
        assert_eq!(server_dir(res.path()), Some(res.path().join("_up_/server-dist")));
        std::fs::create_dir_all(res.path().join("server")).unwrap();
        std::fs::write(res.path().join("server/server.mjs"), "").unwrap();
        assert_eq!(server_dir(res.path()), Some(res.path().join("server")));
    }

    #[test]
    fn spawn_passes_env_and_stop_terminates() {
        // Node の代わりに /bin/sh を使い、server.mjs をシェルスクリプトにして環境変数と停止を確かめる。
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("server.mjs"),
            "echo \"pid=$HANGAR_PARENT_PID ui=$HANGAR_UI_DIST port=$HANGAR_PORT home=$HANGAR_HOME\"\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n",
        )
        .unwrap();
        let log = home.path().join("desktop.log");
        let mut p = spawn_server(Path::new("/bin/sh"), dir.path(), home.path(), &log).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(text.contains(&format!("pid={}", std::process::id())), "{text}");
        assert!(text.contains(&format!("ui={}", dir.path().join("ui").display())), "{text}");
        assert!(text.contains("port=4177"), "{text}");
        assert!(text.contains(&format!("home={}", home.path().display())), "{text}");
        assert!(p.is_running());
        let t0 = Instant::now();
        p.stop();
        assert!(!p.is_running());
        assert!(t0.elapsed() < Duration::from_secs(2));
    }
}
```

`lib.rs` の先頭に `pub mod server;` を足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `cd apps/desktop/src-tauri && cargo test server`
Expected: コンパイルエラー（`server_dir` などが未定義）

- [ ] **Step 3: server.rs を実装する**

`server.rs` の `use` とテストの間に足す。

```rust
pub const PORT: u16 = 4177;

/// 同梱サーバのディレクトリ。開発時は `HANGAR_SERVER_DIR` で差し替える。
/// バンドラの都合で置き場所が `server/` か `_up_/server-dist/` のどちらかになるので両方を見る。
pub fn server_dir(resource_dir: &Path) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HANGAR_SERVER_DIR") {
        let p = PathBuf::from(p);
        return if p.join("server.mjs").is_file() { Some(p) } else { None };
    }
    ["server", "_up_/server-dist"]
        .iter()
        .map(|rel| resource_dir.join(rel))
        .find(|p| p.join("server.mjs").is_file())
}

pub struct ServerProcess {
    child: Child,
}

/// `node server.mjs` を起動する。標準出力と標準エラーはログファイルに追記する。
pub fn spawn_server(node: &Path, dir: &Path, hangar_home: &Path, log: &Path) -> std::io::Result<ServerProcess> {
    let out = OpenOptions::new().create(true).append(true).open(log)?;
    let err = out.try_clone()?;
    let child = Command::new(node)
        .arg(dir.join("server.mjs"))
        .env("HANGAR_PARENT_PID", std::process::id().to_string())
        .env("HANGAR_PORT", PORT.to_string())
        .env("HANGAR_UI_DIST", dir.join("ui"))
        .env("HANGAR_HOME", hangar_home)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()?;
    Ok(ServerProcess { child })
}

impl ServerProcess {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// 生きているか。終了していれば false。
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// SIGTERM を送って 2 秒待ち、まだ生きていれば SIGKILL。サーバは SIGTERM で DB を閉じてから終わる。
    pub fn stop(&mut self) {
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
        }
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(2) {
            if !self.is_running() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// ダウンロードした zip から展開したファイルに付く検疫属性を外す。
/// 未署名の `.node` を Node が読み込むとき、属性が残っていると Gatekeeper に止められる。
pub fn strip_quarantine(dir: &Path) {
    let _ = Command::new("/usr/bin/xattr")
        .args(["-rd", "com.apple.quarantine"])
        .arg(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}
```

Run: `cd apps/desktop/src-tauri && cargo fmt && cargo test server`
Expected: PASS（2 件）

- [ ] **Step 4: lib.rs を書き換える**

`apps/desktop/src-tauri/src/lib.rs` の全文：

```rust
//! agent-hangar のデスクトップシェル。
//! 起動時に同梱サーバを子プロセスとして立て、`/health` が通ったらウィンドウをサーバの URL へ移す。
//! `hangar://` のディープリンクは UI のハッシュ経路に変換して webview に流す。

pub mod deeplink;
pub mod health;
pub mod node;
pub mod paths;
pub mod server;

use std::io::Write;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// アプリ全体で共有する状態。
struct AppState {
    server: Mutex<Option<server::ServerProcess>>,
    /// ウィンドウがサーバの URL を表示しているか。偽の間に届いたディープリンクは pending に貯める。
    ready: Mutex<bool>,
    pending_hash: Mutex<Option<String>>,
}

/// `~/.agent-hangar/desktop.log` に 1 行追記する。サーバの標準出力も同じファイルに流れる。
fn log(line: &str) {
    let home = paths::hangar_home();
    let _ = std::fs::create_dir_all(&home);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(home.join("desktop.log")) {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "{ms} [desktop] {line}");
    }
}

/// 読み込み画面の文言を差し替える。サーバへ移る前だけ意味を持つ。
fn set_status(app: &AppHandle, text: &str, error: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!(
            "(function(){{var s=document.getElementById('status');if(!s)return;s.textContent={};s.dataset.level={};}})();",
            serde_json::to_string(text).unwrap_or_default(),
            if error { "'error'" } else { "''" }
        );
        let _ = w.eval(&js);
    }
}

fn fail(app: &AppHandle, msg: &str) {
    log(msg);
    set_status(app, msg, true);
}

/// ディープリンクをハッシュとして適用する。準備前なら保持して、最初のナビゲーションに乗せる。
fn apply_hash(app: &AppHandle, hash: String) {
    let state = app.state::<AppState>();
    let ready = state.ready.lock().unwrap();
    if *ready {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval(&deeplink::hash_to_js(&hash));
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    } else {
        *state.pending_hash.lock().unwrap() = Some(hash);
    }
}

/// 起動の本体。別スレッドで走り、ウィンドウはその間読み込み画面を出している。
fn boot(app: AppHandle) {
    let hangar_home = paths::hangar_home();
    let _ = std::fs::create_dir_all(&hangar_home);
    let addr: SocketAddr = ([127, 0, 0, 1], server::PORT).into();
    let state = app.state::<AppState>();

    if health::probe_health(addr) {
        // hangar start などで既にサーバがいる。子は起こさず、そのサーバを使う。
        log("adopting the server already listening on 4177");
    } else {
        let resource_dir = match app.path().resource_dir() {
            Ok(d) => d,
            Err(e) => return fail(&app, &format!("リソースの場所が分かりません: {e}")),
        };
        let Some(dir) = server::server_dir(&resource_dir) else {
            return fail(&app, &format!("同梱のサーバが見つかりません: {}", resource_dir.display()));
        };
        server::strip_quarantine(&dir);
        let manifest = match node::read_manifest(&dir) {
            Ok(m) => m,
            Err(e) => return fail(&app, &e),
        };
        let candidates = node::candidate_paths(&paths::user_home(), &hangar_home);
        let node_path = match node::choose_node(&candidates, &manifest, node::probe_node) {
            Ok(p) => p,
            Err(e) => return fail(&app, &node::describe_error(&e)),
        };
        log(&format!("node {} server {}", node_path.display(), dir.display()));
        match server::spawn_server(&node_path, &dir, &hangar_home, &hangar_home.join("desktop.log")) {
            Ok(p) => {
                log(&format!("server pid {}", p.pid()));
                *state.server.lock().unwrap() = Some(p);
            }
            Err(e) => return fail(&app, &format!("サーバを起動できません: {e}")),
        }
        if !health::wait_for_health(addr, Duration::from_secs(20)) {
            return fail(&app, "サーバが 20 秒以内に応答しませんでした。~/.agent-hangar/desktop.log を確認してください。");
        }
    }

    // ready の切り替えと pending の取り出しは同じロックの下で行い、その隙に届いたリンクを落とさない。
    let url = {
        let mut ready = state.ready.lock().unwrap();
        let hash = state.pending_hash.lock().unwrap().take().unwrap_or_default();
        *ready = true;
        format!("http://127.0.0.1:{}/{}", server::PORT, hash)
    };
    log(&format!("navigating to {url}"));
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(u) = tauri::Url::parse(&url) {
            let _ = w.navigate(u);
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState { server: Mutex::new(None), ready: Mutex::new(false), pending_hash: Mutex::new(None) })
        .setup(|app| {
            log("setup");
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    log(&format!("deep link {url}"));
                    match deeplink::deep_link_to_hash(url.as_str()) {
                        Some(hash) => apply_hash(&handle, hash),
                        None => log("deep link ignored"),
                    }
                }
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || boot(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut p) = app.state::<AppState>().server.lock().unwrap().take() {
                    p.stop();
                    log("server stopped");
                }
            }
        });
}
```

- [ ] **Step 5: 全テストと cargo check**

Run: `cd apps/desktop/src-tauri && cargo fmt && cargo test && cargo check`
Expected: PASS（20 件）。警告が無い

- [ ] **Step 6: 初回のフルビルド（1 回目）**

Run: `npm run build && cd apps/desktop && npx tauri build`
Expected: 約 2 分で `apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` ができる。`beforeBuildCommand` が `server-dist` を作り直す

Run: `cd apps/desktop/src-tauri/target/release/bundle/macos && ls Hangar.app/Contents/Resources/server && plutil -p Hangar.app/Contents/Info.plist | grep -E 'CFBundleURLSchemes|hangar|NSAppleEventsUsageDescription' && du -sh Hangar.app`
Expected: `server` に `server.mjs`、`cli.mjs`、`ui`、`node_modules`、`bin`、`manifest.json` がある。Info.plist に `hangar` のスキームと `NSAppleEventsUsageDescription` がある。`.app` は 30MB 未満。もし `server` が無く `_up_/server-dist` にあれば、`server_dir` はそれも見るので動作は変わらない

- [ ] **Step 7: 起動の一巡を見る**

Run: `lsof -i :4177 -sTCP:LISTEN` で 4177 が空いていることを確かめてから、`open apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app`。3 秒待って `pgrep -fl server.mjs` と `tail -5 ~/.agent-hangar/desktop.log`
Expected: ウィンドウに Home 画面が出る。`pgrep` に `node .../server.mjs` が 1 つある。ログに `node ...`、`server pid ...`、`navigating to http://127.0.0.1:4177/` が並ぶ

Run: `osascript -e 'quit app "Hangar"'; sleep 3; pgrep -fl server.mjs; tail -1 ~/.agent-hangar/desktop.log`
Expected: `pgrep` は何も出さない。ログの最後は `server stopped`

- [ ] **Step 8: コミット**

```bash
git add apps/desktop/src-tauri/src apps/desktop/src-tauri/Cargo.lock
git commit -m "feat(desktop): spawn bundled server, wait for health, route deep links and stop on exit"
```

---

### Task 7: 手動確認（ディープリンク、終了、既存サーバの採用、Node 不在、検疫属性、ダーク）

**Files:**
- 変更なし。問題が見つかれば該当タスクのファイルを直し、2 回目のフルビルドで再確認する

**Interfaces:**
- Consumes: Task 6 の `Hangar.app`。`open` コマンドと `pgrep -f server.mjs` で観察する。
- 前提：`lsof -i :4177 -sTCP:LISTEN` が空であること（`hangar start` や `npm run dev` のサーバを止めておく）。

- [ ] **Step 1: ディープリンクの三形**

アプリを起動したままで次を順に実行する。

Run: `TOKEN=$(cat ~/.agent-hangar/token); SID=$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4177/api/sessions | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))'); PID=$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4177/api/projects | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))'); echo $SID $PID`
Expected: セッション ID とプロジェクト ID が出る

Run: `open "hangar://session/$SID"`
Expected: ウィンドウが前面に来て、そのセッションのトランスクリプトが出る。ログに `deep link hangar://session/...` が残る

Run: `open "hangar://project/$PID"`
Expected: プロジェクト詳細に移る

Run: `open 'hangar://search?q=動画'`
Expected: Sessions 画面にキーワード「動画」の結果が出る

Run: `open 'hangar://settings'`
Expected: 画面は変わらず、ログに `deep link ignored`

- [ ] **Step 2: ブラウザとの同等性**

Run: `open "http://127.0.0.1:4177/#/session/$SID"`
Expected: 既定のブラウザで同じセッション画面が出る。アプリのウィンドウは変わらない

- [ ] **Step 3: 終了でサーバが止まる**

Run: ⌘Q でアプリを終了し、`sleep 3; pgrep -fl server.mjs`
Expected: 何も出ない

Run: `open apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app; sleep 3; APP=$(pgrep -f 'Hangar.app/Contents/MacOS'); kill -9 $APP; sleep 7; pgrep -fl server.mjs`
Expected: アプリを SIGKILL で落としても、7 秒以内にサーバが `HANGAR_PARENT_PID` の監視で自ら終了し、何も出ない

- [ ] **Step 4: 起動前に届いたディープリンク**

Run: アプリが止まっている状態で `open "hangar://session/$SID"`
Expected: アプリが起動し、読み込み画面のあと直接そのセッション画面が出る（保持したハッシュが最初の URL に付く）。ログの `navigating to` に `#/session/` が含まれる

- [ ] **Step 5: 既存サーバの採用**

Run: ⌘Q でアプリを終了してから、別のターミナルで `npx hangar start` を実行して CLI のサーバを立て、3 秒待って `open apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app; sleep 3; pgrep -fl server.mjs; tail -3 ~/.agent-hangar/desktop.log`
Expected: UI が出る。`pgrep` は何も出さない（子を起こしていない。CLI のサーバのコマンド行は `cli/src/index.ts` で、`server.mjs` を含まない）。ログに `adopting the server already listening on 4177`

Run: ⌘Q でアプリを終了し、`curl -s http://127.0.0.1:4177/health; kill $(pgrep -f 'cli/src/index.ts start')`
Expected: CLI のサーバはアプリの終了後も `{"ok":true,...}` を返す。その後 `kill` で止める

- [ ] **Step 6: Node が無いときの表示**

Run: `M=apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app/Contents/Resources/server/manifest.json; cp $M /tmp/manifest.bak; sed -i '' 's/"nodeMajor": [0-9]*/"nodeMajor": 99/' $M; open apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app`
Expected: 読み込み画面に赤い文字で「Node 99（arm64）が見つかりません。」と調べた場所の一覧が出る

Run: ⌘Q で終了し、`cp /tmp/manifest.bak $M`
Expected: 元に戻る

- [ ] **Step 7: 検疫属性の解除**

Run: `N=apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app/Contents/Resources/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node; xattr -w com.apple.quarantine "0083;00000000;Safari;" "$N"; xattr -l "$N"; open apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app; sleep 4; xattr -l "$N"`
Expected: 起動前は `com.apple.quarantine` が付いており、起動後は消えている。アプリは通常どおり UI を出す

- [ ] **Step 8: ダークモードと `~/.claude`**

Run: システム設定の「外観」をダークに切り替える
Expected: アプリのウィンドウが再起動なしでダークの配色に変わる。読み込み画面も同様（Step 6 のように失敗表示を出した状態で切り替えると確認できる）

Run: `ls -la ~/.claude | head -5`
Expected: hangar が書いたファイルは無い（サーバは読むだけ）

- [ ] **Step 9: 見つかった問題の修正**

問題があれば該当タスクのファイルを直し、`cargo test` を通してから 2 回目のフルビルド（`npm run build && cd apps/desktop && npx tauri build`）で Step 1 から 8 を再確認する。
3 回目のビルドは予備として残す。

- [ ] **Step 10: コミット**

修正があった場合だけ行う。

```bash
git add apps/desktop
git commit -m "fix(desktop): adjustments found during manual verification"
```

---

### Task 8: Settings の `nodePath`（shared、server、ui）

**Files:**
- Modify: `packages/shared/src/api.ts`（`SettingsDto`）、`packages/server/src/config/paths.ts`（`Settings`）、`packages/server/src/http/app.ts`（`/api/settings` と `bootstrap`）、`packages/ui/src/presenters/settings.ts`、`packages/ui/src/views/SettingsScreen.tsx`
- Test: `packages/server/src/http/app.test.ts`、`packages/ui/src/views/misc.test.tsx`、`packages/ui/src/presenters/presenters.test.ts`

**Interfaces:**
- Produces: `SettingsDto = { workspaceRoot: string; claudeDir: string; nodePath?: string | null }`。`SettingsProps` に `nodePath: string`（無ければ空文字）。
- `PATCH /api/settings` は `nodePath` を trim し、空なら `null` で保存する。Task 3 の `settings_node_path` と Task 2 の `hangar.sh` は `null` と空文字を「無し」と読む。
- フェーズ 2 から 4 でこれらのファイルに行が増えていても、足すのは下記の断片だけである。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/http/app.test.ts` の `describe('routes', ...)` に足す。

```ts
  it('nodePath は保存でき、空なら null に戻る', async () => {
    const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ nodePath: ' /opt/node22/bin/node ' }) });
    expect((await r.json()).nodePath).toBe('/opt/node22/bin/node');
    expect((await json(await get('/api/settings'))).body.nodePath).toBe('/opt/node22/bin/node');
    expect((await json(await get('/api/bootstrap'))).body.settings.nodePath).toBe('/opt/node22/bin/node');
    const r2 = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ nodePath: '' }) });
    expect((await r2.json()).nodePath).toBeNull();
  });
```

`packages/ui/src/presenters/presenters.test.ts` に足す（`initialStore`、`initialState`、`presentSettings` が未 import なら先頭に足す）。

```ts
import { initialState } from '../mediator/transition.ts';
import { initialStore } from '../store/store.ts';
import { presentSettings } from './settings.ts';

describe('presentSettings の nodePath', () => {
  it('無ければ空文字、あればそのまま', () => {
    const base = initialStore();
    expect(presentSettings(initialState(), base).nodePath).toBe('');
    const withNode = { ...base, settings: { workspaceRoot: '/w', claudeDir: '/c', nodePath: '/x/node' } };
    expect(presentSettings(initialState(), withNode).nodePath).toBe('/x/node');
  });
});
```

`packages/ui/src/views/misc.test.tsx` の `describe('SettingsScreen', ...)` に足し、既存の `render` 呼び出しの props に `nodePath=""` を加える。

```tsx
  it('Node のパスを保存でき、空なら null を送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen workspaceRoot="/w" claudeDir="/c" nodePath="" device={null} version="0.1.0" index={{ phase: 'idle', done: 0, total: 0 }} sessionCount={0} projectCount={0} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('Node のパス'), { target: { value: '/opt/node22/bin/node' } });
    fireEvent.click(screen.getByText('Node のパスを保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { nodePath: '/opt/node22/bin/node' } });
    fireEvent.change(screen.getByLabelText('Node のパス'), { target: { value: '  ' } });
    fireEvent.click(screen.getByText('Node のパスを保存'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { nodePath: null } });
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/http packages/ui/src/views/misc packages/ui/src/presenters`
Expected: FAIL（`nodePath` が返らない、`Node のパス` の欄が無い）。`npm run typecheck` も `nodePath` が `SettingsProps` に無いので失敗する

- [ ] **Step 3: 型を足す**

`packages/shared/src/api.ts`：

```ts
export type SettingsDto = { workspaceRoot: string; claudeDir: string; nodePath?: string | null };
```

`packages/server/src/config/paths.ts`：

```ts
export type Settings = { workspaceRoot: string; claudeDir: string; nodePath?: string | null };
```

`loadSettings` は JSON を展開して返すので `nodePath` はそのまま通り、`saveSettings` は全体を書くので保持される。

- [ ] **Step 4: サーバの経路を直す**

`packages/server/src/http/app.ts` に DTO への変換を 1 つ置き、`bootstrap`、`GET /settings`、`PATCH /settings` の三箇所で使う。

```ts
const settingsDto = (s: Settings): SettingsDto => ({ workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir, nodePath: s.nodePath ?? null });
```

`bootstrap` の `settings:` を `settingsDto(s)` に、`GET /settings` を `c.json(settingsDto(deps.settings()))` に変える。
`PATCH /settings` は次にする。

```ts
  api.patch('/settings', async (c) => {
    const patch = (await c.req.json().catch(() => ({}))) as Partial<SettingsDto>;
    // Node のパスは前後の空白を落とし、空なら null にして「未指定」に戻す。
    if ('nodePath' in patch) patch.nodePath = typeof patch.nodePath === 'string' && patch.nodePath.trim() ? patch.nodePath.trim() : null;
    const s = deps.updateSettings(patch);
    deps.hub.broadcast({ type: 'toast', level: 'info', message: '設定を保存しました' });
    return c.json(settingsDto(s));
  });
```

- [ ] **Step 5: UI を直す**

`packages/ui/src/presenters/settings.ts`：`SettingsProps` に `nodePath: string` を足し、`presentSettings` の返り値に `nodePath: store.settings?.nodePath ?? ''` を足す。

`packages/ui/src/views/SettingsScreen.tsx`：`useState` に `const [nodePath, setNodePath] = useState(props.nodePath);` を足し、「この端末」の節の直後に次の節を置く。

```tsx
      <section>
        <h2 className="h2">デスクトップアプリ</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input mono" style={{ flex: 1 }} aria-label="Node のパス" placeholder="/opt/homebrew/bin/node" value={nodePath} onChange={(e) => setNodePath(e.target.value)} />
          <button className="btn" onClick={() => emit({ type: 'settings.update', patch: { nodePath: nodePath.trim() || null } })}>Node のパスを保存</button>
        </div>
        <div className="faint" style={{ marginTop: 4 }}>空なら /opt/homebrew/bin/node、/usr/local/bin/node、nvm の順に探します。同梱サーバと同じメジャー版の Node が必要です。</div>
      </section>
```

- [ ] **Step 6: テストと型検査**

Run: `npx vitest run && npm run typecheck`
Expected: PASS（全パッケージ）

- [ ] **Step 7: 実物で確かめる**

Run: `npm run build && cd apps/desktop && npm run bundle-server && HANGAR_SERVER_DIR=$PWD/server-dist npx tauri dev`
Expected: 開発ビルドのウィンドウが `server-dist` のサーバで起動する（このコマンドはフルビルドに数えない。`tauri dev` はデバッグビルドで、ディープリンクのスキーム登録は行われない）。Settings 画面の「Node のパス」に `/opt/homebrew/bin/node` を入れて保存すると `~/.agent-hangar/settings.json` に `"nodePath": "/opt/homebrew/bin/node"` が書かれる。空にして保存すると `null` になる。終了後、`settings.json` の `nodePath` を消しておく

- [ ] **Step 8: コミット**

```bash
git add packages/shared/src/api.ts packages/server/src/config/paths.ts packages/server/src/http packages/ui/src/presenters packages/ui/src/views
git commit -m "feat(settings): node path override for the desktop shell"
```

---

### Task 9: release.yml（タグから `.app` を zip と checksum 付きで Releases へ）

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Produces: タグ `v<版>` の push で、`Hangar-v<版>-macos-arm64.zip` と `Hangar-v<版>-macos-arm64.zip.sha256` が GitHub Release に付く。
- 版の一致：タグが `tauri.conf.json` の `version` と一致しなければ最初のステップで失敗する。`package.json` と `Cargo.toml` の一致は Task 1 のテストが担う。
- 署名しない。zip は `ditto` で作り、Finder の展開で `.app` の属性が保たれる。

- [ ] **Step 1: ワークフローを書く**

`.github/workflows/release.yml`：

```yaml
name: release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  macos:
    runs-on: macos-latest
    strategy:
      matrix:
        include:
          # Apple silicon のみ。Intel を足すときは runs-on が x86_64 のランナーである行を加える。
          - target: aarch64-apple-darwin
            arch: arm64
    steps:
      - uses: actions/checkout@v4
      - name: タグと tauri.conf.json の版が一致することを確かめる
        run: |
          v="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
          if [ "v$v" != "$GITHUB_REF_NAME" ]; then
            echo "tag $GITHUB_REF_NAME does not match tauri.conf.json version $v" >&2
            exit 1
          fi
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: apps/desktop/src-tauri
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - name: .app をビルドする（beforeBuildCommand が server-dist を作る）
        run: npx tauri build --target ${{ matrix.target }}
        working-directory: apps/desktop
      - name: zip と checksum
        run: |
          cd apps/desktop/src-tauri/target/${{ matrix.target }}/release/bundle/macos
          name="Hangar-${GITHUB_REF_NAME}-macos-${{ matrix.arch }}"
          ditto -c -k --sequesterRsrc --keepParent Hangar.app "$name.zip"
          shasum -a 256 "$name.zip" > "$name.zip.sha256"
          cat "$name.zip.sha256"
          echo "ASSET_DIR=$PWD" >> "$GITHUB_ENV"
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            ${{ env.ASSET_DIR }}/*.zip
            ${{ env.ASSET_DIR }}/*.zip.sha256
          generate_release_notes: true
```

- [ ] **Step 2: 構文と、zip の手順を手元で確かめる**

Run: `ruby -ryaml -e 'y = YAML.load_file(".github/workflows/release.yml"); puts y["jobs"]["macos"]["steps"].size'`
Expected: `12`

Run: `cd apps/desktop/src-tauri/target/release/bundle/macos && ditto -c -k --sequesterRsrc --keepParent Hangar.app /tmp/Hangar-test.zip && shasum -a 256 /tmp/Hangar-test.zip > /tmp/Hangar-test.zip.sha256 && cd /tmp && shasum -a 256 -c Hangar-test.zip.sha256 && rm -rf /tmp/Hangar-unzip && ditto -x -k Hangar-test.zip /tmp/Hangar-unzip && ls /tmp/Hangar-unzip/Hangar.app/Contents/Resources/server/manifest.json && rm -rf /tmp/Hangar-test.zip /tmp/Hangar-test.zip.sha256 /tmp/Hangar-unzip`
Expected: `Hangar-test.zip: OK` が出て、展開した `.app` の中に `manifest.json` がある（Task 6 のビルドを使うので、新しいビルドは要らない）

- [ ] **Step 3: コミット**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build unsigned macos app on tags and attach zip with checksum to releases"
```

---

### Task 10: README と設計文書の更新

**Files:**
- Modify: `README.md`、`docs/design.md`（「プロセスと通信」「配布と運用」「フェーズ」「決めた前提と未決事項」）

- [ ] **Step 1: README に「インストール（配布版）」を足す**

`README.md` の「使い方（フェーズ 1）」の前に次の節を置く。

````markdown
## インストール（配布版）

macOS（Apple silicon）向けの `.app` を GitHub Releases に置いています。
署名していないので、初回だけ Gatekeeper の解除が要ります。

1. Releases から `Hangar-vX.Y.Z-macos-arm64.zip` を落とし、展開した `Hangar.app` を `/Applications` に移します。
   checksum を確かめるには、同じ場所の `.sha256` を落として `shasum -a 256 -c Hangar-vX.Y.Z-macos-arm64.zip.sha256` を実行します。
2. 検疫属性を外します。

   ```sh
   xattr -rd com.apple.quarantine /Applications/Hangar.app
   ```

   ターミナルを使わない場合は、`Hangar.app` を一度開いてダイアログを「完了」で閉じ、システム設定の「プライバシーとセキュリティ」で「このまま開く」を押します。
   macOS 14 以前では、`Hangar.app` を右クリックして「開く」を選ぶ方法も使えます。
   どの手順でも、アプリは起動時に同梱したサーバの検疫属性を自分で外します。
3. Node 22 を入れます（`nvm install 22` が簡単です）。
   アプリは `/opt/homebrew/bin/node`、`/usr/local/bin/node`、nvm の順に探し、同梱サーバと同じメジャー版だけを使います。
   Homebrew の `node` がメジャー版 22 ならそれも使われますが、`node@22` は `/opt/homebrew/bin` にリンクされないので、その場合は次の方法でパスを指定します。
   別の場所にある場合は、Settings 画面の「Node のパス」か `~/.agent-hangar/settings.json` の `nodePath` で指定します。
4. `hangar` コマンドを使えるようにして、初期設定を走らせます。

   ```sh
   sudo ln -sf /Applications/Hangar.app/Contents/Resources/server/bin/hangar /usr/local/bin/hangar
   hangar setup
   ```

5. `Hangar.app` を開きます。
   ブラウザで `http://127.0.0.1:4177/` を開いても同じ画面が出ます。
   `open hangar://session/<id>` のようなリンクでアプリの画面を直接開けます。

起動の記録は `~/.agent-hangar/desktop.log` に残ります。
うまく起動しないときは、まずこのファイルの末尾を見てください。
````

- [ ] **Step 2: 開発者向けの節を足す**

「開発」の節の末尾に次を足す。

````markdown
デスクトップ版のビルドは次のとおりです（Xcode Command Line Tools と Rust が要ります）。

```sh
npm run build                         # UI を作る
cd apps/desktop && npx tauri build    # server-dist を作り、.app を src-tauri/target/release/bundle/macos に出す
```

配布は、`apps/desktop/package.json`、`apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/tauri.conf.json` の版を揃えてから `git tag vX.Y.Z && git push origin vX.Y.Z` で行います。
GitHub Actions が `.app` を zip と checksum 付きで Releases に置きます。
````

- [ ] **Step 3: 設計文書を更新する**

`docs/design.md` を次のとおり直す。

- 「プロセスと通信」の末尾に 3 文を足す。「Tauri のシェルは、サーバを esbuild の単一ファイル `server.mjs` にまとめ、ネイティブモジュールと UI とともに `.app` に同梱する。ネイティブモジュールは Node の ABI に縛られるため、同梱時の Node のメジャー版とアーキテクチャを `manifest.json` に記録し、探索ではそれと一致する Node だけを採る。起動時に 4177 で既にサーバが応答していれば、そのサーバを採用して子プロセスを起こさない。」
- 「配布と運用」の「タグを打つと macOS 用の `.app` をビルドして Releases に置く。」の直後に 2 文を足す。「`.app` は署名せず、zip と SHA-256 の checksum を添える。利用者は検疫属性を `xattr -rd com.apple.quarantine` で外すか、システム設定の「このまま開く」で許可する。」
- 「フェーズ」の「フェーズ 5」の行末に「（計画は `docs/plans/phase5-desktop.md`）」を足す。
- 「決めた前提と未決事項」の前提の箇条書きに、この計画の「前提」節から次の 5 項目を足す。サーバの同梱形態、Node の版の一致、配布ターゲットが Apple silicon のみ、Gatekeeper（署名せず、検疫属性の解除を手順にし、アプリ自身も同梱サーバの属性を外す）、二重起動（single-instance を入れず、既存サーバを採用する）。
- 未決事項から「未署名の `.app` を配布したときの Gatekeeper の扱い」の行を消す。

- [ ] **Step 4: LICENSE を置く**

リポジトリの直下に `LICENSE` が無ければ、MIT の本文で作る（設計文書は public と MIT を定めているが、フェーズ 1 の時点ではファイルが無い）。

```
MIT License

Copyright (c) 2026 gaku1023

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 5: 文章の点検**

Run: `grep -n '[—―]' README.md docs/design.md; grep -n '・' README.md docs/design.md`
Expected: 一致が無いか、あっても固有名詞の内部だけである

- [ ] **Step 6: コミット**

```bash
git add README.md docs/design.md LICENSE
git commit -m "docs: distribution install steps, phase 5 decisions and mit license"
```

---

## 実行の順序と並列化

依存の無いタスクは並列に実装できる。
実装者を同時に走らせるときは、次の組を目安にする。

1. Task 1（土台）。他のすべてがこれに依存する。
2. Task 2（バンドル）、Task 3（Node）、Task 4（ディープリンク）、Task 5（health）は互いに独立で、並列にできる。Rust の三つは `lib.rs` に `pub mod` を 1 行ずつ足すだけなので、コミットが前後しても衝突は 1 行で解ける。
3. Task 6（結線と初回ビルド）は Task 2 から 5 のすべてに依存する。
4. Task 7（手動確認）は Task 6 の直後に行う。
5. Task 8（Settings の nodePath）は TypeScript だけで、Task 1 の後ならいつでもよい。Task 3 は `settings.json` の鍵を読むだけなので、Task 8 の前後を問わない。
6. Task 9（release.yml）は Task 6 のビルド成果物で zip の手順を確かめるので、Task 6 の後に行う。
7. Task 10（文書）は最後に行う。

フルビルドは Task 6 で 1 回、Task 7 で問題があれば 1 回、予備が 1 回である。
Task 8 の `tauri dev` と Task 9 の zip の確認はフルビルドに数えない。

## 自己点検（計画の作成時に確認したこと）

- 設計文書の「プロセスと通信」の各文に対応するタスクがある。子プロセスの起動と終了は Task 6、Node の探索順と Settings の明示は Task 3 と Task 8、親 pid の監視はフェーズ 1 の `main.ts` に既にあり Task 6 が `HANGAR_PARENT_PID` を渡す（Task 7 Step 3 で SIGKILL でも止まることを見る）、ディープリンクは Task 4 と Task 6、ブラウザとの同等性は Task 7 Step 2。
- 「ディープリンク」の三形（`session`、`project`、`search?q=`）は Task 4 のテストにあり、変換先は `packages/shared/src/route.ts` の `formatRoute` と一致する。`search` の空白は `+` になるが `parseRoute` の `URLSearchParams` が空白に戻す。
- 「配布と運用」の public、MIT、型検査とテスト、タグから `.app`、家族の `hangar setup` は Task 9 と Task 10 が担う。リポジトリに `LICENSE` が無いので Task 10 で置く。
- 「セッション内タブ」の `NSAppleEventsUsageDescription` は Task 1 の Info.plist にあり、Task 6 Step 6 で併合を確かめる。
- 「見た目と動き」の OS に従うダークは、UI が `prefers-color-scheme` で持つものをそのまま使い、読み込み画面も同じメディアクエリを持つ（Task 1、Task 7 Step 8）。
- 未決事項の Gatekeeper は「前提」で決め、Task 10 で設計文書に反映する。
- 型と名前の一致：`Manifest` の JSON 鍵 `nodeMajor` と `arch` は Task 2 の `manifest.json` と Task 3 の `serde(rename)` で同じ。`HANGAR_UI_DIST` は Task 2 の `server.ts` と `hangar.sh`、Task 6 の `spawn_server` で同じ。`nodePath` は Task 3 の `settings_node_path`、Task 2 の `hangar.sh`、Task 8 の `SettingsDto` で同じ鍵。`server_dir` が見る `server/` は Task 1 の `bundle.resources` の対象と同じで、`_up_/server-dist/` は保険。
- Rust のテストは Tauri のランタイムに触れない純関数と、`/bin/sh` を使った実プロセスの試験だけで、`cargo test` が macOS の CI で回る（Task 3 の desktop ジョブ）。
- 実物の `~/.claude` に書き込むタスクは無い。Rust とシェルスクリプトが書くのは `~/.agent-hangar/desktop.log` と、Task 8 の Settings 保存による `settings.json` だけである。
- プレースホルダの走査：「TBD」「TODO」「後で」「Task N と同様」の類は無い。各コードブロックは完成形である。
