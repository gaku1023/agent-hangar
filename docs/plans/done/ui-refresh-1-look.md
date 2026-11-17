# UI 刷新 1 回目 実装計画（見た目の言語、ロゴ、タイトルバー）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画面全体を Liquid Glass の見た目の言語（光の背景、浮くガラス、不透明な読む面）に着せ替え、端末を掛けたハンガーのロゴを原本からアプリアイコン、favicon、サイドバーまで行き渡らせ、`.app` のタイトルバーをガラスに溶かす。

**Architecture:** 見た目は今の素の CSS の上で作り直す。値は `tokens.css` のトークンに集め、ぼかし（`backdrop-filter`）は浮く部品の規則にだけ書き、それを試験で見張る。ロゴは `packages/ui/src/brand/logo.ts` の純粋な関数が SVG の文字列を作り、スクリプトがそれをファイルに書き出す。試験はファイルと関数の出力が一致することを確かめる。タイトルバーは Tauri の `titleBarStyle: "Overlay"` にし、UI の出どころに窓を動かす権限（ヘッダーのドラッグ）とダブルクリックで拡大する権限（ヘッダーのダブルクリック）の 2 つだけ与え、殻は頁に `data-shell="desktop"` の印を付ける。

**Tech Stack:** React 19、Vite 8、vitest 5（`ui` の `node` と `dom` の子プロジェクト）、@testing-library/react 16、Tauri 2.11（`@tauri-apps/cli` 2.11）、tsx 4、Node 22。

**Spec:** `docs/superpowers/specs/2026-09-29-ui-refresh-design.md`（試作は `docs/superpowers/specs/2026-09-29-ui-refresh/`。値や形で迷ったら試作を開いて見る）

## Global Constraints

- この回で扱うのは、仕様の「届け方」の 1 回目だけである。Home の作り直し、2 段の行（44px）、`live.activity` と `live.question`、端末の縁の灯、フォルダの耳のタブ、動きのトークンと動きの一覧、行が広がる動き、起動画面の動きは 2 回目と 3 回目で扱う。
- 動きのトークン（`--dur-fast: 80ms`、`--dur: 150ms`、`--dur-slow: 250ms`、`--dur-pop: 120ms`、`--ease`）はこの回では値も名前も変えない。
- 行の高さ（`--row-h: 28px`）と一覧の列の組み方は変えない。
- 常にライトで、ダークモードは持たない。`prefers-color-scheme` と `data-theme` を書かない。
- ぼかしは `.sidebar`、`.header`、`.conn-banner`、`.dialog`、`.palette`、`.toast` の規則にだけ書く。書くときは必ず `-webkit-backdrop-filter` を併記する。
- 読む面（一覧、カード、会話、端末）にはぼかしを掛けない。端末の板は不透明な墨色のまま。
- 本文の色は白地とガラスを重ねた色（`#f5f7fa`）の両方で 4.5 : 1 以上。プロジェクトのステータスの色（`--st-*`）と状態の色（`--busy` など）は変えない。
- アイコンは Lucide の 16px、線幅 1.5 のまま。`views/primitives/Icon.tsx` だけを通す。
- `palette.css` の `.field-row {`、`.dialog-promote .btn { white-space: nowrap; }`、`.dialog-promote .dialog-foot { flex-wrap: wrap;` の 3 つの文字列は `overlays.test.tsx` が見ているので、そのまま残す。
- `base.css` の `animation: pop var(--dur-pop) var(--ease)` の文字列は `tokens.test.ts` が見ているので、そのまま残す。
- 表示名は「Hangar」。リポジトリとパッケージの名前は `agent-hangar` のまま。
- UI の出どころは `http://127.0.0.1:4177`。窓を動かす権限（`core:window:allow-start-dragging`）とダブルクリックで拡大する権限（`core:window:allow-internal-toggle-maximize`）は、この出どころにだけ、この 2 つだけ与える。既定の `capabilities/default.json` は変えない。
- サーバの CSP（`packages/server/src/http/app.ts` の `CSP`）はこの計画では変えない。変える必要が出たら止めて利用者に諮る。
- ポート番号でプロセスを止めない。止めてよいのは、ビルドの後に、LISTEN している利用者の dev サーバ 1 つだけ（`lsof -nP -iTCP:4177 -sTCP:LISTEN -t` で PID を採り、`ps -o command= -p <PID>` で tsx のサーバだと確かめてから）。Vite（5173）には触らない。
- 手元での `tauri build` は時間がかかるので、この計画では 2 回まで（Task 1 と Task 8）とする。`cargo check` は回数を制限しない。
- ビルドは `/Applications/Hangar.app` を置き換えない。確かめるときは `apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` を開く。入れ替えは利用者に確かめてから行う。
- テストは実物の `~/.agent-hangar` と `~/.claude` に触れない。
- 日本語の文書とコメントは一文ごとに改行し、地の文でダッシュと中黒を使わない。
- コミットメッセージは英語の Conventional Commits で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。`git add` の後の `git commit` ではなく、`git commit <path>...` のパス指定形で入れる。パッケージ管理は npm。

## Review Focus

- **ヘッダの操作する部品が掴み所になって押せなくなる。** 検索欄、ボタン、パンくずのリンクは今までどおり押せて、文字を選べるべきである。Task 1 の試験で、掴み所の印がヘッダ本体と余白の `.spacer` にだけ付き、`button`、`input`、`a` に付かないことを固定する。
- **切断の帯が出たときに、浮いたヘッダの下に中身の先頭が隠れる。** 帯が出ている間は、帯の分も中身が下がるべきである。Task 3 の試験で `.shell:has(.conn-banner) .main` の規則があることを固定する。
- **ブラウザで開いたときに、サイドバーの上に信号の 3 点のための空白が出る。** 空白は殻の中でだけ取るべきである。Task 3 の試験で、上の余白の規則が `[data-shell='desktop'] .sidebar` にだけあることを固定し、Task 1 の試験で殻がその印を付けることを固定する。
- **reduced motion を有効にしても、背景の光が漂い続ける。** 止まるべきである。Task 3 の試験で、reduced motion の中に `.shell::before { animation: none; }` があることを固定する。
- **ぼかしが端末や一覧に紛れ込み、xterm の描画が重くなる。** ぼかしは浮く部品にだけ掛かるべきである。Task 3 の試験で、`backdrop-filter` を持つ規則の選択子が許した 6 つに限られることを固定する。

---

## 作るファイルと変えるファイル

| ファイル | 役目 | Task |
|---|---|---|
| `apps/desktop/src-tauri/tauri.conf.json` | 窓の題を Hangar に、タイトルバーを Overlay に | 1 |
| `apps/desktop/src-tauri/capabilities/remote-drag.json`（新） | UI の出どころに窓を動かす権限を 1 つ | 1 |
| `apps/desktop/src-tauri/src/lib.rs` | 頁に `data-shell="desktop"` の印を付ける | 1 |
| `packages/ui/src/views/Header.tsx` | ヘッダと余白に掴み所の印 | 1 |
| `apps/desktop/test/config.test.ts` | 窓、権限、印の試験 | 1 |
| `packages/ui/src/views/Shell.test.tsx` | 掴み所の試験 | 1 |
| `packages/ui/src/styles/tokens.css` | 新しい色、ガラス、角、隙間のトークン | 2 |
| `packages/ui/src/styles/tokens.test.ts` | 決まりとコントラストの試験 | 2 |
| `packages/ui/src/runtime/xterm.ts` | 端末の配色の予備の値 | 2 |
| `packages/ui/src/styles/base.css` | 骨格（光の背景、浮くサイドバーとヘッダ、中身がくぐる）と部品 | 3、4 |
| `packages/ui/src/styles/glass.test.ts`（新） | ぼかしの置き場所と骨格の規則の試験 | 3 |
| `packages/ui/src/styles/palette.css`、`workbench.css`、`settings.css`、`split.css` | 部品の見た目 | 4 |
| `packages/ui/src/brand/logo.ts`（新） | ロゴの原図を作る純粋な関数と、書き出すファイルの一覧 | 5、6 |
| `packages/ui/src/brand/logo.test.ts`（新） | ロゴの形と、ファイルの一致の試験 | 5、6 |
| `packages/ui/scripts/write-brand.ts`（新） | ロゴのファイルを書き出す | 5 |
| `packages/ui/src/brand/logo.svg`、`logo-front.svg`（生成） | 原図と、先頭 1 本の図 | 5 |
| `packages/ui/src/views/Sidebar.tsx` | ワードマーク | 5 |
| `packages/ui/index.html` | 題と favicon | 5 |
| `apps/desktop/loading/index.html`、`apps/desktop/loading/logo.svg`（生成） | 読み込み画面の題、色、静止したロゴ | 5 |
| `apps/desktop/src-tauri/icon.svg`（生成）、`apps/desktop/src-tauri/icons/*`（生成） | アプリアイコン | 6 |
| `docs/design.md` | 「骨格」と「見た目と動き」の書き換え | 7 |

---

### Task 1: タイトルバーを溶かす（まず実物で試す）

仕様の「未確かめとリスク」の筆頭である。
窓を掴んで動かす仕組みがリモートの出どころの頁で効くかを、この回の最初に実物で確かめる。
効かなければ Step 9 で止まり、利用者に諮る。

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/capabilities/remote-drag.json`
- Modify: `apps/desktop/src-tauri/src/lib.rs:209-213`（`page_loaded` の末尾）
- Modify: `packages/ui/src/views/Header.tsx:12` と、同じファイルの `<span className="spacer" />`
- Modify: `packages/ui/src/styles/base.css`（`.sidebar` の規則の直後に 1 行）
- Test: `apps/desktop/test/config.test.ts`、`packages/ui/src/views/Shell.test.tsx`

**Interfaces:**
- Produces: `<html data-shell="desktop">`（殻の中でだけ付く）。Task 3 の CSS がこれを使う。
- Produces: ヘッダの `data-tauri-drag-region=""`。Task 3 と Task 4 はヘッダの中身を変えても、この印を `header.header` と `.spacer` に残す。

- [ ] **Step 1: 失敗する試験を書く（殻の側）**

`apps/desktop/test/config.test.ts` の `describe('tauri.conf.json', ...)` の最初の `it` の最後の行を、次の 1 行に置き換える。

```ts
    expect(conf.app.windows[0]).toMatchObject({ label: 'main', title: 'Hangar', width: 1400, height: 900, titleBarStyle: 'Overlay', hiddenTitle: true });
```

同じファイルの末尾に、次の 2 つの `describe` を足す。

```ts
describe('capabilities', () => {
  const dir = path.join(app, 'src-tauri', 'capabilities');
  const cap = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  it('置くのは既定と、窓を動かすための 2 つだけ', () => {
    expect(fs.readdirSync(dir).sort()).toEqual(['default.json', 'remote-drag.json']);
  });
  it('既定の権限は core:default のまま変えない', () => {
    expect(cap('default.json').permissions).toEqual(['core:default']);
    expect(cap('default.json').remote).toBeUndefined();
  });
  // UI はサーバ（127.0.0.1:4177）から読み込む。そこから呼べる殻の機能は、窓を動かす 1 つだけにする。
  it('UI の出どころには、窓を動かす権限を 1 つだけ与える', () => {
    const c = cap('remote-drag.json');
    expect(c.windows).toEqual(['main']);
    expect(c.remote).toEqual({ urls: ['http://127.0.0.1:4177/*'] });
    expect(c.permissions).toEqual(['core:window:allow-start-dragging']);
  });
});

describe('殻の印', () => {
  // 殻が付ける印と、画面がそれを読む規則は別の言語に分かれている。片方だけ直すと、ブラウザか殻のどちらかで余白が崩れる。
  it('殻は頁に data-shell="desktop" を付け、画面はそれでサイドバーの上を空ける', () => {
    expect(read('src-tauri/src/lib.rs')).toContain("document.documentElement.dataset.shell = 'desktop'");
    const base = fs.readFileSync(path.resolve(app, '../../packages/ui/src/styles/base.css'), 'utf8');
    expect(base).toContain("[data-shell='desktop'] .sidebar {");
  });
});
```

- [ ] **Step 2: 失敗する試験を書く（画面の側）**

`packages/ui/src/views/Shell.test.tsx` の `describe('Shell', ...)` の中の最後に、次の `it` を足す。

```tsx
  // .app ではヘッダの空いた所を掴んで窓を動かす。操作する部品に印が付くと、押しても窓が動くだけになる。
  it('ヘッダ本体と余白だけを、窓を掴む場所にする', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const header = container.querySelector('header.header')!;
    expect(header).toHaveAttribute('data-tauri-drag-region');
    expect(header.querySelector('.spacer')).toHaveAttribute('data-tauri-drag-region');
    const controls = header.querySelectorAll('button, input, a');
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) expect(el).not.toHaveAttribute('data-tauri-drag-region');
  });
```

- [ ] **Step 3: 試験が落ちることを確かめる**

Run: `npx vitest run apps/desktop/test/config.test.ts packages/ui/src/views/Shell.test.tsx`
Expected: FAIL。`title: 'Hangar'`、`remote-drag.json` が無い、`dataset.shell`、`data-tauri-drag-region` の各所で落ちる。

- [ ] **Step 4: 窓の設定を変える**

`apps/desktop/src-tauri/tauri.conf.json` の `app.windows[0]` を次に置き換える。

```json
      {
        "label": "main",
        "title": "Hangar",
        "width": 1400,
        "height": 900,
        "minWidth": 900,
        "minHeight": 600,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true,
        "trafficLightPosition": { "x": 22, "y": 26 }
      }
```

`trafficLightPosition` の位置は、サイドバーのガラス（窓の端から 8px、角 16px）の左上の内側に信号の 3 点が収まる値である。
設定の名前が通るかは `apps/desktop/src-tauri/gen/schemas/config.schema.json` の `WindowConfig` で確かめる（`cargo check` が通れば読めている）。

- [ ] **Step 5: 権限のファイルを作る**

`apps/desktop/src-tauri/capabilities/remote-drag.json` を作る。

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "remote-drag",
  "description": "サーバの UI（127.0.0.1:4177）から、ヘッダを掴んで窓を動かすためだけの権限。ほかの殻の機能は与えない。",
  "windows": ["main"],
  "remote": { "urls": ["http://127.0.0.1:4177/*"] },
  "permissions": ["core:window:allow-start-dragging"]
}
```

- [ ] **Step 6: 殻に印を付けさせる**

`apps/desktop/src-tauri/src/lib.rs` の `page_loaded` の末尾の `if` を次に置き換える。

```rust
    // 位相を読めるのはこの殻の中だけである。画面はこの印を見て、時間で当てずっぽうに決めるのをやめる。
    // 殻の中であることの印も同じ時に付ける。画面はこれを見て、信号の 3 点の分だけサイドバーの上を空ける。
    if server_page && cfg!(target_os = "macos") {
        eval_main(app, "window.__hangarPhaseAware = true");
        eval_main(app, "document.documentElement.dataset.shell = 'desktop'");
    }
```

- [ ] **Step 7: ヘッダに掴み所の印を付け、殻の中でだけ上を空ける**

`packages/ui/src/views/Header.tsx` の `<header className="header">` を次にする。

```tsx
    <header className="header" data-tauri-drag-region="">
```

同じファイルの `<span className="spacer" />` を次にする。

```tsx
      <span className="spacer" data-tauri-drag-region="" />
```

`packages/ui/src/styles/base.css` の `.sidebar { ... }` の行の直後に、次の 2 行を足す（Task 3 で `.sidebar` を書き換えても、この規則は残す）。

```css
/* デスクトップの殻の中では、信号の 3 点がサイドバーの左上に乗る。殻が付ける data-shell の印を見て、その分だけ上を空ける。 */
[data-shell='desktop'] .sidebar { padding-top: calc(var(--u) * 10); }
```

- [ ] **Step 8: 試験が通ることを確かめる**

Run: `npx vitest run apps/desktop/test/config.test.ts packages/ui/src/views/Shell.test.tsx && (cd apps/desktop/src-tauri && cargo check)`
Expected: PASS と、`cargo check` が警告なしで終わる。

- [ ] **Step 9: 実物で試す（止まる点）**

ビルドして、できた `.app` を直接開く。

```bash
npm run build --workspace packages/ui
npm run bundle-server --workspace apps/desktop
npm run tauri --workspace apps/desktop -- build
open apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app
```

`.app` を開く前に、利用者の dev サーバが 4177 を使っていないかを `lsof -nP -iTCP:4177 -sTCP:LISTEN -t` で見る。
使っていれば、`ps -o command= -p <PID>` で tsx のサーバだと確かめてから、その 1 つだけを止める（Global Constraints のとおり）。
止めたことは報告に書く。

確かめることは次の 5 つである。

1. 標準の灰色のタイトルバーが無く、信号の 3 点がサイドバーの左上の内側に乗っている。
2. ヘッダの空いた所（パンくずの右の余白）を掴んでドラッグすると、窓が動く。
3. 検索欄を押すと入力でき、新規セッションのボタンを押すとダイアログが開く（窓は動かない）。
4. 読み込み画面（サーバが起きる前の画面）でも、信号の 3 点が文字に重なっていない。
5. ヘッダの空いた所をダブルクリックしたときに窓が拡大するかどうか（どちらでもよいが、結果を記録する）。

2 が効かなければ、ここで止める。
考えられる原因は 2 つある。
1 つは権限の出どころの書き方（`remote.urls`）で、もう 1 つはサーバの CSP の `connect-src` が Tauri の IPC（`ipc://localhost`）を止めていることである。
どちらを疑ったか、何を試したかを書き、仕様の代わりの手（殻が窓の上端に透明のつまみを置く、標準のタイトルバーへ戻す）と一緒に利用者に諮る。
CSP は勝手に変えない。

- [ ] **Step 10: コミット**

```bash
git commit apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/capabilities/remote-drag.json apps/desktop/src-tauri/src/lib.rs apps/desktop/test/config.test.ts packages/ui/src/views/Header.tsx packages/ui/src/views/Shell.test.tsx packages/ui/src/styles/base.css -m "$(cat <<'EOF'
feat(desktop): melt the title bar into the glass and drag the window by the header

Hide the standard title bar, place the traffic lights over the sidebar,
and let the UI origin start a window drag and nothing else. The shell
marks the page so the sidebar leaves room for the lights only there.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 新しいトークンと、その決まりの試験

**Files:**
- Modify: `packages/ui/src/styles/tokens.css`（全体を置き換える）
- Modify: `packages/ui/src/styles/tokens.test.ts:6-20`
- Modify: `packages/ui/src/runtime/xterm.ts:9`

**Interfaces:**
- Produces（Task 3 と Task 4 が使うトークン）：`--aura-1`、`--aura-2`、`--accent-hi`、`--glass-bg`、`--glass-bg-palette`、`--glass-bg-dialog`、`--glass-bg-toast`、`--glass-blur`、`--glass-blur-strong`、`--glass-blur-dialog`、`--glass-blur-toast`、`--glass-edge`、`--glass-drop`、`--glass-drop-lg`、`--surface-shadow`、`--r`（8px）、`--r-lg`（14px）、`--r-xl`（16px）、`--r-pill`（99px）、`--float-gap`（8px）、`--header-h`（40px）、`--aura-period`（24s）。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/styles/tokens.test.ts` の最初の `describe('tokens.css', ...)` 全体を、次に置き換える（`lum`、`contrast`、`token` はファイルの後ろで定義されているが、`it` の中身は読み込みが終わってから走るので、そのまま使える）。

```ts
describe('tokens.css', () => {
  it('必要なトークンをライトで定義する', () => {
    for (const t of ['--bg', '--aura-1', '--aura-2', '--surface', '--line', '--ink', '--ink-2', '--ink-3', '--accent', '--accent-hi', '--busy', '--idle', '--waiting', '--ended', '--font-sans', '--font-mono', '--row-h', '--dur', '--dur-pop', '--ease',
      '--glass-bg', '--glass-blur', '--glass-edge', '--glass-drop', '--r', '--r-lg', '--r-xl', '--r-pill', '--float-gap', '--header-h', '--aura-period']) {
      expect(css, t).toContain(`${t}:`);
    }
  });
  it('ダークモードを持たず、トークンは一度だけ定義する', () => {
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).not.toContain('data-theme');
    expect((css.match(/--accent:/g) ?? []).length).toBe(1);
  });
  // ぼかしは base.css などの、浮く部品の規則にだけ書く（glass.test.ts が見張る）。トークンは値だけを持つ。
  it('禁じた効果を使わない', () => {
    for (const bad of ['text-shadow', '@keyframes pulse', '@keyframes shimmer', '@keyframes skeleton', 'backdrop-filter:']) expect(css).not.toContain(bad);
  });
  // ガラスは白 40% を地（--bg）に重ねた色になる。その上に本文と補足の文が載る。
  it('本文と補足の文は、白地とガラスの上の両方で 4.5:1 以上で読める', () => {
    const glass = over(token('--bg'), 0.4);
    expect(glass).toBe('#f5f7fa');
    for (const t of ['--ink', '--ink-2']) {
      expect(contrast(token(t), token('--surface')), `${t} / surface`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(t), glass), `${t} / glass`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('注記の色は白地で 3:1 以上、主ボタンの白い文字は 4.5:1 以上', () => {
    expect(contrast(token('--ink-3'), token('--surface'))).toBeGreaterThanOrEqual(3);
    expect(contrast(token('--accent-ink'), token('--accent'))).toBeGreaterThanOrEqual(4.5);
  });
});
```

同じファイルの `const token = ...` の行の直後に、次の関数を足す。

```ts
/** 白を割合 a で色 hex に重ねた色。ガラスの見かけの地の色を出すのに使う。 */
const over = (hex: string, a: number) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - a) + 255 * a).toString(16).padStart(2, '0')).join('');
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/styles/tokens.test.ts`
Expected: FAIL。`--aura-1` などのトークンが無い、`#f5f7fa` にならない、で落ちる。

- [ ] **Step 3: トークンを置き換える**

`packages/ui/src/styles/tokens.css` の全体を次に置き換える。

```css
:root {
  /* 光の背景。地の色と、その上をゆっくり漂う 2 つの淡い光。 */
  --bg: #eef1f7;
  --aura-1: #cfe0ff;
  --aura-2: #e5d6ff;
  /* 読む面。一覧、カード、会話は白で不透明にする。 */
  --surface: #ffffff;
  --surface-2: #f3f4f9;
  --line: #eceef5;
  --line-strong: #d9dbe6;
  /* 文字。ガラスに合わせて少し青みに寄せた。白地で 16.9、6.3、3.4 : 1。 */
  --ink: #1c1b2e;
  --ink-2: #5f5e78;
  --ink-3: #8a89a0;
  --accent: #4a63e8;
  --accent-hi: #6b8cff;
  --accent-ink: #ffffff;
  --accent-soft: #eef2ff;
  --busy: #c77a1a;
  --idle: #3a8f5c;
  --waiting: #a2452f;
  --ended: #9a968e;
  --error: #b3261e;
  --st-active: #2a57b8;
  --st-active-soft: #e8eefc;
  --st-paused: #8a5a0b;
  --st-paused-soft: #faefd9;
  --st-done: #2b7048;
  --st-done-soft: #e3f1e8;
  --st-archived: #66625b;
  --st-archived-soft: #edebe6;
  --term-bg: #1c1b2e;
  --term-fg: #e8e6f0;
  /* 浮くガラス。地の透け具合、ぼかし、縁、落ち影の値だけを持つ。
     backdrop-filter の指定そのものは、浮く部品の規則にだけ書く（glass.test.ts が見張る）。 */
  --glass-bg: rgba(255, 255, 255, 0.4);
  --glass-bg-palette: rgba(255, 255, 255, 0.62);
  --glass-bg-dialog: rgba(255, 255, 255, 0.72);
  --glass-bg-toast: rgba(255, 255, 255, 0.82);
  --glass-blur: blur(12px) saturate(1.9);
  --glass-blur-strong: blur(18px) saturate(1.8);
  --glass-blur-dialog: blur(18px) saturate(1.6);
  --glass-blur-toast: blur(14px);
  --glass-edge: inset 0 1px 0 rgba(255, 255, 255, 0.95), inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  --glass-drop: 0 10px 28px -12px rgba(30, 40, 90, 0.3);
  --glass-drop-lg: 0 24px 50px -16px rgba(30, 40, 90, 0.45);
  --surface-shadow: 0 1px 2px rgba(30, 40, 90, 0.06);
  --font-sans: 'Inter Variable', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', sans-serif;
  --font-mono: 'JetBrains Mono Variable', 'SFMono-Regular', Menlo, monospace;
  --fs-xs: 11px;
  --fs-sm: 12px;
  --fs: 13px;
  --fs-md: 15px;
  --fs-lg: 20px;
  --row-h: 28px;
  --u: 4px;
  --r: 8px;
  --r-lg: 14px;
  --r-xl: 16px;
  --r-pill: 99px;
  --float-gap: 8px;
  --main-w: 1200px;
  --sidebar-w: 180px;
  --header-h: 40px;
  --aura-period: 24s;
  --dur-fast: 80ms;
  --dur: 150ms;
  --dur-slow: 250ms;
  --dur-pop: 120ms;
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
}

@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 0ms; --dur: 0ms; --dur-slow: 0ms; --dur-pop: 0ms; }
}
```

- [ ] **Step 4: 端末の配色の予備の値を揃える**

`packages/ui/src/runtime/xterm.ts:9` の `|| '#1c1b19'` を `|| '#1c1b2e'` に、`|| '#e8e6e1'` を `|| '#e8e6f0'` に変える。
予備の値は CSS の変数が読めなかったときだけ使うので、見た目は変数と同じにしておく。

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui/src/styles/tokens.test.ts && npm run typecheck --workspace packages/ui`
Expected: PASS。型検査も 0 件。

- [ ] **Step 6: コミット**

```bash
git commit packages/ui/src/styles/tokens.css packages/ui/src/styles/tokens.test.ts packages/ui/src/runtime/xterm.ts -m "$(cat <<'EOF'
feat(ui): add the glass, aura, and shape tokens and pin their contrast

Shift the ink toward blue to sit on glass, raise the note color to 3.4:1,
and hold body text at 4.5:1 on both white and the glass tint.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 骨格を浮かべる（光の背景、浮くサイドバーとヘッダ、中身がヘッダの下をくぐる）

**Files:**
- Modify: `packages/ui/src/styles/base.css:3-35`（`body` から `.nav-item[aria-current='page']` まで）と `:104-108`（切断の帯）
- Create: `packages/ui/src/styles/glass.test.ts`

**Interfaces:**
- Consumes: Task 2 のトークン。Task 1 の `[data-shell='desktop'] .sidebar` の規則。
- Produces: `.shell::before`（光の背景）、浮く `.sidebar` と `.header`、`grid-row: 1 / -1` で全体を占める `.main`。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/styles/glass.test.ts` を作る。

```ts
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** 入れ子の無い規則を、選択子と中身の組で取り出す。@media の中の規則も、内側の規則として拾える。 */
const rules = (css: string) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
const all = files.flatMap((f) => rules(read(f)).map((r) => ({ ...r, file: f })));
const blurs = all.filter((r) => /(^|[^-])backdrop-filter\s*:/.test(r.body));

// 仕様：ガラスは浮く部品（ヘッダ、サイドバー、⌘K、ダイアログ、通知と切断の帯）にだけ使う。
const GLASS = ['.sidebar', '.header', '.conn-banner', '.dialog', '.palette', '.toast'];

describe('浮くガラス', () => {
  it('backdrop-filter は浮く部品の規則にだけ現れる', () => {
    expect(blurs.length).toBeGreaterThan(0);
    for (const r of blurs) expect(GLASS, `${r.file}: ${r.selector}`).toContain(r.selector);
  });
  it('どのぼかしにも -webkit- の併記がある（macOS 13 と 14 の WKWebView のため）', () => {
    for (const r of blurs) expect(r.body, `${r.file}: ${r.selector}`).toContain('-webkit-backdrop-filter:');
  });
});

describe('骨格', () => {
  const base = read('base.css');
  it('中身はヘッダの下をくぐり、切断の帯が出ている間は帯の分も下がる', () => {
    expect(base).toMatch(/\.main \{[^}]*grid-row: 1 \/ -1;/);
    expect(base).toContain('.shell:has(.conn-banner) .main {');
  });
  it('信号の 3 点のための上の余白は、殻の中でだけ取る', () => {
    const tops = all.filter((r) => r.selector.includes('.sidebar') && r.body.includes('padding-top'));
    expect(tops.map((r) => r.selector)).toEqual(["[data-shell='desktop'] .sidebar"]);
  });
  it('背景の光は漂い、reduced motion では止まる', () => {
    expect(base).toMatch(/\.shell::before \{[^}]*animation: aura-drift var\(--aura-period\)/);
    expect(base).toContain('@media (prefers-reduced-motion: reduce) { .shell::before { animation: none; } }');
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/styles/glass.test.ts`
Expected: FAIL。`blurs.length` が 0、`grid-row: 1 / -1` が無い、などで落ちる。

- [ ] **Step 3: 骨格の規則を書き換える**

`packages/ui/src/styles/base.css` の `body { ... }`（3 から 10 行目）の `background: var(--bg);` はそのまま残す。
20 行目の `/* レイアウト */` から 35 行目の `.nav-item[aria-current='page'] { ... }` までを、次に置き換える（Task 1 で足した `[data-shell='desktop'] .sidebar` の 2 行も、この中に入れ直す）。

```css
/* レイアウト */
/* 奥から「光の背景」「読む面」「浮くガラス」の 3 枚で組む。
   光の背景は .shell::before の 1 枚に描き、ゆっくり漂わせる。
   2 行目は接続が切れているあいだの帯。帯が無いときは auto が 0 に潰れるので、何も描かない。 */
.shell { position: relative; isolation: isolate; display: grid; grid-template-columns: calc(var(--sidebar-w) + var(--float-gap)) minmax(0, 1fr); grid-template-rows: auto auto 1fr; height: 100%; overflow: hidden; }
.shell::before { content: ''; position: absolute; inset: -25%; z-index: -1; pointer-events: none; background: radial-gradient(40% 50% at 25% 15%, var(--aura-1), transparent 70%), radial-gradient(40% 50% at 85% 75%, var(--aura-2), transparent 70%); animation: aura-drift var(--aura-period) ease-in-out infinite alternate; }
@keyframes aura-drift { to { transform: translate(5%, -4%) rotate(8deg) scale(1.05); } }
@media (prefers-reduced-motion: reduce) { .shell::before { animation: none; } }
/* 浮くガラス。ぼかしはこの節と、切断の帯、ダイアログ、パレット、通知の規則にだけ書く（glass.test.ts が見張る）。 */
/* 行が増えても全部を覆うように、端から端まで跨がせる。 */
.sidebar { grid-column: 1; grid-row: 1 / -1; z-index: 2; margin: var(--float-gap) 0 var(--float-gap) var(--float-gap); padding: calc(var(--u) * 2.5) calc(var(--u) * 2); border-radius: var(--r-xl); background: var(--glass-bg); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); box-shadow: var(--glass-edge), var(--glass-drop); overflow: auto; }
/* デスクトップの殻の中では、信号の 3 点がサイドバーの左上に乗る。殻が付ける data-shell の印を見て、その分だけ上を空ける。 */
[data-shell='desktop'] .sidebar { padding-top: calc(var(--u) * 10); }
.header { grid-column: 2; grid-row: 1; z-index: 2; display: flex; align-items: center; gap: calc(var(--u) * 3); height: var(--header-h); margin: var(--float-gap) var(--float-gap) 0 var(--float-gap); padding: 0 calc(var(--u) * 2) 0 calc(var(--u) * 4); border-radius: var(--r-pill); background: var(--glass-bg); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); box-shadow: var(--glass-edge), var(--glass-drop); }
/* 中身はヘッダの下をくぐって流れる。上の余白は、浮いたヘッダの高さと上下の隙間の分である。 */
.main { grid-column: 2; grid-row: 1 / -1; overflow: auto; padding-top: calc(var(--header-h) + var(--float-gap) * 2); }
/* 切断の帯が出ている間は、帯の分も空ける。帯は 1 行（--row-h）に上下の余白が付く。 */
.shell:has(.conn-banner) .main { padding-top: calc(var(--header-h) + var(--float-gap) * 3 + var(--row-h) + var(--u) * 2); }
.main-inner { max-width: var(--main-w); margin: 0 auto; padding: calc(var(--u) * 2) calc(var(--u) * 4) calc(var(--u) * 4); }
.screen { animation: fade var(--dur-fast) var(--ease); }

@keyframes fade { from { opacity: 0; } to { opacity: 1; } }

/* ナビ。選択中の項目は、ガラスの上に錠剤が浮く。 */
.nav-item { display: flex; align-items: center; gap: calc(var(--u) * 2); height: var(--row-h); padding: 0 calc(var(--u) * 2.5); margin-bottom: 1px; color: var(--ink-2); border: 0; border-radius: var(--r-pill); background: none; width: 100%; text-align: left; cursor: pointer; transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
.nav-item:hover { background: rgba(255, 255, 255, 0.5); }
.nav-item[aria-current='page'] { color: var(--ink); font-weight: 560; background: rgba(255, 255, 255, 0.78); box-shadow: inset 0 1px 0 #ffffff, 0 2px 6px rgba(30, 40, 90, 0.1); }
```

同じファイルの切断の帯（`/* 切断の帯。…` から `@keyframes drop-in …` まで、104 から 108 行目）を、次に置き換える。

```css
/* 切断の帯。浮いたヘッダの下に降りてきて、押せる逃げ道をひとつ添える。通知と同じガラスに、赤を少し混ぜる。 */
.conn-banner { grid-column: 2; grid-row: 2; z-index: 2; display: flex; align-items: center; gap: calc(var(--u) * 2); min-height: var(--row-h); margin: calc(var(--float-gap) * 0.75) var(--float-gap) 0; padding: var(--u) calc(var(--u) * 3); border-radius: var(--r-lg); font-size: var(--fs-sm); color: var(--error); background: color-mix(in srgb, var(--error) 10%, var(--glass-bg-toast)); -webkit-backdrop-filter: var(--glass-blur-toast); backdrop-filter: var(--glass-blur-toast); box-shadow: var(--glass-edge), var(--glass-drop); animation: drop-in var(--dur-slow) var(--ease); }
.conn-retry { color: color-mix(in srgb, var(--error) 70%, var(--ink-3)); }
.conn-banner .btn { margin-left: auto; }
@keyframes drop-in { from { transform: translateY(-4px); opacity: 0; } to { transform: none; opacity: 1; } }
```

`packages/ui/src/styles/sync.css` の `.header { min-width: 0; }` は残す（ヘッダが grid の列を押し広げないための規則で、今回も要る）。

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui/src/styles/ packages/ui/src/views/Shell.test.tsx apps/desktop/test/config.test.ts`
Expected: PASS。

- [ ] **Step 5: 目で確かめる**

利用者の Vite が動いているかを `lsof -nP -iTCP:5173 -sTCP:LISTEN` で見る。
動いていれば `http://localhost:5173` を開き（Vite は作業ツリーをそのまま配る）、次を確かめる。
動いていなければ、利用者に `npm run dev` を頼むか、別のポートと一時の `HANGAR_HOME` で立てる。

1. サイドバーとヘッダが、背景の淡い光の上に浮いたガラスに見える。
2. 一覧を下へスクロールすると、中身がヘッダの下をくぐる。
3. ブラウザでは、サイドバーの上に空白が無い。
4. 幅 900px まで窓を狭めても、ヘッダの中身が折り返さない。

- [ ] **Step 6: コミット**

```bash
git commit packages/ui/src/styles/base.css packages/ui/src/styles/glass.test.ts -m "$(cat <<'EOF'
feat(ui): float the sidebar and header as glass over a drifting aura

Let content scroll under the header, lower it while the connection banner
shows, and stop the aura for reduced motion. Pin the blur to the floating
parts so it never lands on the terminal or the lists.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 読む面と部品（一覧、カード、会話、ボタン、入力、ダイアログ、パレット、通知）

見た目だけの変更で、構成と列は変えない。
試験を足すのは検索欄の ⌘K の印だけで、ほかは Task 2 と Task 3 の試験と、既存の画面の試験で守る。
Task 3 の `glass.test.ts` が、`.dialog`、`.palette`、`.toast` のぼかしも見張る。

**Files:**
- Modify: `packages/ui/src/styles/base.css`（下に挙げる規則）
- Modify: `packages/ui/src/styles/palette.css:6-11`
- Modify: `packages/ui/src/styles/workbench.css:6-7`
- Modify: `packages/ui/src/styles/split.css:16-20`（コメントの数値）
- Modify: `packages/ui/src/views/Header.tsx`（検索欄の直後に ⌘K の印）
- Test: `packages/ui/src/views/Shell.test.tsx`

**Interfaces:**
- Consumes: Task 2 のトークン。

- [ ] **Step 1: 検索欄の ⌘K の印の、失敗する試験を書く**

仕様の「骨格」：検索欄には「⌘K」の印を添える。
印は目で見るための飾りで、読み上げは既にある「セッションを検索」の placeholder に任せる。
`packages/ui/src/views/Shell.test.tsx` の `describe('Shell', ...)` の中の最後に、次の `it` を足す。

```tsx
  it('検索欄に ⌘K の印を添え、読み上げからは外す', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const kbd = container.querySelector('header.header kbd.search-kbd')!;
    expect(kbd).toHaveTextContent('⌘K');
    expect(kbd).toHaveAttribute('aria-hidden', 'true');
    expect(kbd.previousElementSibling).toBe(screen.getByRole('searchbox'));
  });
```

Run: `npx vitest run packages/ui/src/views/Shell.test.tsx`
Expected: FAIL（`kbd.search-kbd` が無い）。

- [ ] **Step 2: 印を置く**

`packages/ui/src/views/Header.tsx` の `<input id="global-search" … />` の閉じの直後（`<span className="spacer" … />` の前）に、次の 1 行を足す。

```tsx
      <kbd className="search-kbd" aria-hidden="true">⌘K</kbd>
```

`packages/ui/src/styles/base.css` の `.search-box { … }`（Step 3 で置き換える規則）の直後に、次の 1 行を足す。
印は検索欄の右端の内側に重ね、押しても検索欄に届くようにポインタを通す。

```css
.search-kbd { margin-left: calc(var(--u) * -13); width: calc(var(--u) * 9); flex: none; pointer-events: none; font: var(--fs-xs)/1 var(--font-mono); color: var(--ink-3); }
```

Run: `npx vitest run packages/ui/src/views/Shell.test.tsx`
Expected: PASS（Task 1 の「掴み所」の試験も通る。`kbd` は掴み所にしない）。

- [ ] **Step 3: ボタンと入力を書き換える**

`base.css` の `/* ボタンと入力 */` の節（`.btn { ... }` から `.select { ... }` まで）を、次に置き換える。

```css
/* ボタンと入力。ボタンは錠剤の形で、主ボタンだけ上から下へ淡いグラデーションを持つ。 */
.btn { display: inline-flex; align-items: center; gap: calc(var(--u) * 1.5); height: var(--row-h); padding: 0 calc(var(--u) * 3); border: 0; border-radius: var(--r-pill); font-weight: 560; background: rgba(255, 255, 255, 0.78); box-shadow: inset 0 1px 0 #ffffff, 0 1px 3px rgba(30, 40, 90, 0.14); cursor: pointer; transition: background var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease); }
.btn:hover { background: var(--surface); box-shadow: inset 0 1px 0 #ffffff, 0 3px 10px -2px rgba(30, 40, 90, 0.2); }
.btn:active { transform: scale(0.98); }
.btn-primary { background: linear-gradient(180deg, var(--accent-hi), var(--accent)); color: var(--accent-ink); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55), 0 4px 12px -4px rgba(70, 90, 230, 0.6); }
.btn-primary:hover { background: linear-gradient(180deg, var(--accent-hi), var(--accent)); filter: brightness(1.04); }
.btn:disabled { opacity: 0.5; cursor: default; }
.input { height: var(--row-h); padding: 0 calc(var(--u) * 2.5); border: 1px solid var(--line-strong); border-radius: var(--r); background: var(--surface); transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease); }
.input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); outline: none; }
.select { height: var(--row-h); border: 1px solid var(--line-strong); border-radius: var(--r); background: var(--surface); padding: 0 var(--u); }
```

同じファイルの `/* ヘッダーの要素 */` の節の `.search-box { flex: 1; max-width: 420px; }` を、次に置き換える。

```css
/* 検索欄はヘッダの錠剤の中の、ひと回り小さな錠剤。右の余白は、内側に重ねる ⌘K の印の分。 */
.search-box { flex: 1; max-width: 420px; height: calc(var(--row-h) - 2px); border-color: transparent; border-radius: var(--r-pill); padding: 0 calc(var(--u) * 13) 0 calc(var(--u) * 3); background: rgba(255, 255, 255, 0.5); box-shadow: inset 0 1px 2px rgba(30, 40, 90, 0.12); }
```

- [ ] **Step 4: 一覧、カード、見出しを書き換える**

`base.css` の `.list { ... }`、`.row:hover { ... }`、`.card { ... }`、`.card:hover { ... }`、`.h1 { ... }`、`.h2 { ... }` を、それぞれ次に置き換える。

```css
.list { border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--surface-shadow); overflow: hidden; }
```

```css
.row:hover { background: color-mix(in srgb, var(--accent) 4%, var(--surface)); }
```

```css
.card { border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--surface-shadow); padding: calc(var(--u) * 3); display: flex; flex-direction: column; gap: var(--u); cursor: pointer; transition: box-shadow var(--dur) var(--ease); min-width: 0; }
.card:hover { box-shadow: var(--surface-shadow), 0 8px 20px -12px rgba(30, 40, 90, 0.25); }
```

```css
.h1 { font-size: var(--fs-lg); font-weight: 650; letter-spacing: -0.01em; margin: 0 0 calc(var(--u) * 3); }
.h2 { font-size: var(--fs-md); font-weight: 650; letter-spacing: -0.01em; margin: calc(var(--u) * 5) 0 calc(var(--u) * 2); }
```

`.row` の `border-bottom: 1px solid var(--line);` はそのまま残す（行の区切り）。

- [ ] **Step 5: 会話と端末の板を書き換える**

`base.css` の `.msg { ... }` から `.msg-assistant { ... }` までと、`.tool-body { ... }`、`.term-pane { ... }`、`.tr-pane { ... }` を、それぞれ次に置き換える。

```css
.msg { max-width: 80ch; padding: calc(var(--u) * 2) calc(var(--u) * 3); border-radius: var(--r-lg); white-space: pre-wrap; word-break: break-word; }
.msg-user { background: var(--accent); color: var(--accent-ink); align-self: flex-end; border-bottom-right-radius: 5px; }
.msg-assistant { background: var(--surface-2); align-self: flex-start; border-bottom-left-radius: 5px; }
```

```css
.tool-body { white-space: pre-wrap; word-break: break-word; max-height: 40vh; overflow: auto; background: var(--surface-2); padding: calc(var(--u) * 2); border-radius: var(--r); }
```

```css
/* 端末は墨色の不透明な板。ぼかしは掛けない（xterm の描画を重くしないため）。 */
.term-pane { position: relative; display: flex; flex-direction: column; min-width: 0; background: var(--term-bg); border-radius: var(--r-lg); overflow: hidden; box-shadow: 0 12px 26px -16px rgba(20, 20, 60, 0.55); }
```

```css
/* 会話の列は白い読む面にする。 */
.tr-pane { min-width: 0; padding: calc(var(--u) * 2) calc(var(--u) * 3); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--surface-shadow); overflow: hidden; display: flex; flex-direction: column; }
```

`.msg-user` の文字は白で、`--accent` の地の上で 4.95 : 1 ある（Task 2 の試験が見ている）。

- [ ] **Step 6: ダイアログ、通知、ステータスの札を書き換える**

`base.css` の `.overlay { ... }`、`.dialog { ... }`、`.toast { ... }`、`.toast[data-level='error'] { ... }`、`.status-pill { ... }` を、それぞれ次に置き換える。
`.dialog` の中の `animation: pop var(--dur-pop) var(--ease)` の文字列は変えない（`tokens.test.ts` が見ている）。

```css
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--ink) 18%, transparent); display: grid; place-items: center; z-index: 10; }
.dialog { border-radius: 18px; background: var(--glass-bg-dialog); -webkit-backdrop-filter: var(--glass-blur-dialog); backdrop-filter: var(--glass-blur-dialog); box-shadow: var(--glass-edge), var(--glass-drop-lg); padding: calc(var(--u) * 5); width: 480px; max-width: calc(100vw - 32px); animation: pop var(--dur-pop) var(--ease); display: flex; flex-direction: column; gap: calc(var(--u) * 3); }
```

```css
.toast { background: var(--glass-bg-toast); color: var(--ink); padding: calc(var(--u) * 2.5) calc(var(--u) * 3.5); border-radius: var(--r-lg); -webkit-backdrop-filter: var(--glass-blur-toast); backdrop-filter: var(--glass-blur-toast); box-shadow: var(--glass-edge), var(--glass-drop); animation: slide var(--dur-slow) var(--ease); cursor: pointer; }
.toast[data-level='error'] { background: color-mix(in srgb, var(--error) 10%, var(--glass-bg-toast)); color: var(--error); }
```

```css
.status-pill { position: relative; display: inline-flex; align-items: center; height: var(--row-h); border-radius: var(--r-pill); font-weight: 500; color: var(--st-archived); background: var(--st-archived-soft); transition: background var(--dur) var(--ease), color var(--dur) var(--ease); }
```

`.status-pill` の `:focus-within` と `.status-select:focus-visible` の 2 行は変えない（`tokens.test.ts` が文字列で見ている）。

- [ ] **Step 7: パレットをガラスにする**

`packages/ui/src/styles/palette.css` の 6 から 11 行目（`.palette { ... }` から `.palette-item[data-active='true'] { ... }` まで）を、次に置き換える。
17 行目以降（`.field-row {` と `.dialog-promote ...`）は変えない。

```css
/* パレットは .dialog の器をそのまま使い、ガラスだけを少し濃く、ぼかしを強くする。
   開閉の 98% から 100% のスケールとフェード（--dur-pop）も .dialog の pop を受け継ぐ。
   一覧を縁まで敷き詰めたいので、内側の余白と段の隙間だけを外す。 */
.palette { width: min(640px, 90vw); padding: calc(var(--u) * 2); gap: 0; background: var(--glass-bg-palette); -webkit-backdrop-filter: var(--glass-blur-strong); backdrop-filter: var(--glass-blur-strong); }
.palette-input { width: 100%; height: calc(var(--u) * 10); border: none; border-radius: var(--r); background: rgba(255, 255, 255, 0.85); font-size: var(--fs-md); }
.palette-input:focus { border-color: transparent; box-shadow: none; }
.palette-list { list-style: none; margin: 0; padding: var(--u) 0 0; max-height: 50vh; overflow: auto; }
.palette-item { display: grid; grid-template-columns: calc(var(--u) * 22) 1fr auto; align-items: center; gap: calc(var(--u) * 2); height: var(--row-h); padding: 0 calc(var(--u) * 2.5); border-radius: var(--r); cursor: pointer; }
.palette-item[data-active='true'] { background: color-mix(in srgb, var(--accent) 12%, transparent); }
```

- [ ] **Step 8: ゲージ、設定の囲み、分割の帯のコメントを揃える**

`packages/ui/src/styles/workbench.css` の 6 と 7 行目を、次に置き換える。

```css
.gauge-bar { display: inline-block; width: 48px; height: 6px; border-radius: 3px; background: rgba(30, 40, 90, 0.1); overflow: hidden; }
.gauge-fill { display: block; height: 100%; background: linear-gradient(90deg, var(--accent-hi), var(--accent)); transition: width var(--dur-slow) var(--ease), background var(--dur) var(--ease); }
```

`packages/ui/src/styles/settings.css` の `.snippet` の `border-radius: var(--r);` はそのまま（トークンの値が 8px に変わるだけ）。

`packages/ui/src/styles/split.css` の 19 行目のコメントを、新しい色の数値に直す。

```css
   --accent #4a63e8 と --surface #ffffff の比は 4.95:1、--line #eceef5 からの変化の比は 4.27:1 である。 */
```

- [ ] **Step 9: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck --workspace packages/ui`
Expected: PASS。`overlays.test.tsx` の `palette.css` の文字列の試験も通る。

- [ ] **Step 10: 目で確かめる**

Task 3 の Step 5 と同じ手順で `http://localhost:5173` を開き、次を確かめる。

1. Home、Projects、プロジェクト詳細、セッション画面、Sessions、Settings の 6 画面を順に開き、どの画面にも崩れ（はみ出し、重なり、読めない文字）が無い。
2. ⌘K、新規セッションのダイアログ、通知（何かを保存すると出る）がガラスに見え、文字が読める。
3. 一覧の行、カード、会話の吹き出しは白い面で、背景の光が透けていない。
4. ボタンや入力欄に Tab でフォーカスを当てると、アクセントの輪が見える。

崩れを見つけたら、その規則だけを直してこの Step をやり直す。

- [ ] **Step 11: コミット**

```bash
git commit packages/ui/src/views/Header.tsx packages/ui/src/views/Shell.test.tsx packages/ui/src/styles/base.css packages/ui/src/styles/palette.css packages/ui/src/styles/workbench.css packages/ui/src/styles/split.css -m "$(cat <<'EOF'
feat(ui): restyle surfaces and controls for the glass language

Make lists, cards, and the transcript opaque white surfaces with soft
shadows, turn buttons into pills with a gradient primary, and put the
palette, dialogs, and toasts on glass.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: ロゴの原本と、サイドバー、favicon、読み込み画面、表示名

**Files:**
- Create: `packages/ui/src/brand/logo.ts`
- Create: `packages/ui/src/brand/logo.test.ts`
- Create: `packages/ui/scripts/write-brand.ts`
- Create（生成）: `packages/ui/src/brand/logo.svg`、`packages/ui/src/brand/logo-front.svg`、`apps/desktop/loading/logo.svg`
- Modify: `packages/ui/package.json`（`scripts` に `brand`）
- Modify: `packages/ui/src/views/Sidebar.tsx:15`
- Modify: `packages/ui/src/styles/base.css`（`/* ナビ …` の節の直前に `.brand` の 2 行）
- Modify: `packages/ui/index.html`
- Modify: `apps/desktop/loading/index.html`
- Test: `apps/desktop/test/config.test.ts`（読み込み画面）

**Interfaces:**
- Produces: `logoSvg(opts?: { front?: boolean }): string`、`layout(opts?: { front?: boolean }): { slots: Slot[]; sc: number; tx: number; ty: number }`、`slots(count: number): Slot[]`、`mix(a: string, b: string, t: number): string`、`CURSORS`、`BRAND_FILES: { path: string; make: () => string }[]`（`path` はリポジトリの根からの相対パス）。
- Produces（Task 6 が使う）: 同じファイルの `logoParts(opts)`（`{ defs: string; body: string }`。`body` は 100 × 100 の座標の `<g>`）。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/brand/logo.test.ts` を作る。

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND_FILES, CURSORS, layout, logoSvg, mix, slots } from './logo.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const count = (s: string) => (s.match(/data-hanger="/g) ?? []).length;

describe('ロゴの原図', () => {
  it('色を混ぜる', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#1c1b2e', '#e2e7ff', 0)).toBe('#1c1b2e');
  });
  // 仕様の「原図」の表：4 本、1 本奥へ 0.85 倍、霞は奥の札で 86%。
  it('札は奥へ 0.85 倍ずつ小さくなり、奥ほど霞む', () => {
    const s = slots(4);
    expect(s.map((p) => Number(p.s.toFixed(4)))).toEqual([1, 0.85, 0.7225, 0.6141]);
    expect(s.map((p) => Number(p.t.toFixed(3)))).toEqual([0, 0.287, 0.573, 0.86]);
    expect(s[1]!.x).toBeGreaterThan(s[0]!.x);
    expect(s[1]!.y).toBeLessThan(s[0]!.y);
  });
  it('原図は 4 本、16px 用の図は先頭の 1 本だけ', () => {
    expect(count(logoSvg())).toBe(4);
    expect(count(logoSvg({ front: true }))).toBe(1);
    expect(logoSvg({ front: true })).not.toContain('hangar-rail');
  });
  it('先頭の札のカーソルは杏のまま、奥の札のカーソルには霞がかかる', () => {
    const svg = logoSvg();
    expect(svg).toContain(`fill="${CURSORS[0]}"`);
    expect(svg).not.toContain(`fill="${CURSORS[1]}"`);
  });
  // 仕様：群れ全体を、枠の中央の幅 70%、高さ 66% に収める。
  it('群れはアイコンの中央の枠（幅 70、高さ 66）に収まる', () => {
    const L = layout();
    for (const p of L.slots) {
      const left = L.tx + L.sc * (p.x - 31 * p.s), right = L.tx + L.sc * (p.x + 31 * p.s);
      const top = L.ty + L.sc * (p.y - 3 * p.s), bottom = L.ty + L.sc * (p.y + 69 * p.s);
      expect(left).toBeGreaterThanOrEqual(14.99);
      expect(right).toBeLessThanOrEqual(85.01);
      expect(top).toBeGreaterThanOrEqual(17.99);
      expect(bottom).toBeLessThanOrEqual(84.01);
    }
  });
});

describe('書き出したファイル', () => {
  it.each(BRAND_FILES.map((f) => [f.path, f] as const))('%s は原図の関数の出力と一致する（違えば npm run brand --workspace packages/ui）', (_p, f) => {
    expect(fs.readFileSync(path.join(repo, f.path), 'utf8')).toBe(f.make());
  });
});
```

`apps/desktop/test/config.test.ts` の `describe('読み込み画面', ...)` の `it` の中の最後に、次の 2 行を足す。

```ts
    expect(html).toContain('<title>Hangar</title>');
    expect(html).toContain('src="logo.svg"');
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/brand/logo.test.ts apps/desktop/test/config.test.ts`
Expected: FAIL。`./logo.ts` が無い、読み込み画面の題が違う、で落ちる。

- [ ] **Step 3: 原図の関数を書く**

`packages/ui/src/brand/logo.ts` を作る。

```ts
/**
 * ロゴの原図を SVG の文字列で作る。
 * 端末の窓を掛けたハンガーが、右奥へ向かって 4 本重なり、奥ほど霞む。
 * 値の正本は docs/superpowers/specs/2026-09-29-ui-refresh-design.md の「原図」の表である。
 * ファイルは scripts/write-brand.ts がこの関数から書き出し、logo.test.ts が一致を確かめる。
 */

const INK = '#1c1b2e';
const BLUE = '#4a63e8';
const HAZE = '#e2e7ff';
const CHEVRON = '#e8e6e1';
const LIGHTS = ['#ff6a55', '#ffc34d', '#3fb58a'] as const;
/** 手前の札から順のカーソルの色。杏（作業中）、赤（入力待ち）、灰（休み）、杏。 */
export const CURSORS = ['#ffb86b', '#e5533d', '#b5b2c4', '#ffb86b'] as const;

const COUNT = 4;
const SHRINK = 0.85;
const STEP_X = 0.13;
const STEP_Y = 0.035;
const HAZE_MAX = 0.86;
/** 札 1 本の局所座標での幅と高さ（送りの割合の基準）と、描いた形の外枠。 */
const W = 62;
const H = 72;
const BOX = { x0: -31, y0: -3, x1: 31, y1: 69 };

export type Slot = { x: number; y: number; s: number; t: number };

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** 色 a を色 b へ割合 t だけ寄せる。 */
export const mix = (a: string, b: string, t: number): string => {
  const [x, y] = [rgb(a), rgb(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('');
};
/** 座標の数値を、小数 3 桁までの短い文字にする。出力を毎回同じにするため。 */
const num = (v: number) => String(Number(v.toFixed(3)));

/** 札の並び。0 が手前で、奥へ行くほど右上へずれ、小さくなり、霞む。 */
export function slots(count: number): Slot[] {
  const out: Slot[] = [];
  let x = 0, y = 0, s = 1;
  for (let i = 0; i < count; i++) {
    out.push({ x, y, s, t: count === 1 ? 0 : (i / (count - 1)) * HAZE_MAX });
    x += STEP_X * W * s;
    y -= STEP_Y * H * s;
    s *= SHRINK;
  }
  return out;
}

/** 並んだ札の外枠を、100 × 100 の中の幅 w、高さ h の枠へ、中心 (cx, cy) で収める倍率と位置。 */
function fit(sl: Slot[], w: number, h: number, cx: number, cy: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of sl) {
    x0 = Math.min(x0, p.x + BOX.x0 * p.s);
    y0 = Math.min(y0, p.y + BOX.y0 * p.s);
    x1 = Math.max(x1, p.x + BOX.x1 * p.s);
    y1 = Math.max(y1, p.y + BOX.y1 * p.s);
  }
  const sc = Math.min(w / (x1 - x0), h / (y1 - y0));
  return { sc, tx: cx - (sc * (x0 + x1)) / 2, ty: cy - (sc * (y0 + y1)) / 2 };
}

export type LogoOptions = { front?: boolean };

/** 原図は幅 70、高さ 66 の枠に、先頭 1 本の図（16px 用）は幅と高さ 80 の枠に収める。 */
export function layout(opts: LogoOptions = {}) {
  const sl = slots(opts.front ? 1 : COUNT);
  return { slots: sl, ...(opts.front ? fit(sl, 80, 80, 50, 50) : fit(sl, 70, 66, 50, 51)) };
}

/** 札 1 本。t は霞の割合、cursor はカーソルの色。局所座標でフックの首が (0, 10) に来る。 */
function hanger(t: number, cursor: string): string {
  const c = (color: string, k = 1) => mix(color, HAZE, t * k);
  return [
    `<path d="M0 10v-4a4.2 4.2 0 1 0-4.2-4.2" fill="none" stroke="${c(INK)}" stroke-width="2.8" stroke-linecap="round"/>`,
    `<rect x="-30" y="29" width="60" height="40" rx="5" fill="${c(INK)}"/>`,
    `<path d="M0 10L-31 31H31Z" fill="none" stroke="${c(BLUE)}" stroke-width="4" stroke-linejoin="round"/>`,
    ...LIGHTS.map((l, i) => `<circle cx="${num(-23 + i * 6.5)}" cy="37" r="2" fill="${c(l)}"/>`),
    `<path d="M-23 46l7 5.5-7 5.5" fill="none" stroke="${c(CHEVRON, 0.6)}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<rect x="-12" y="55" width="13" height="4" rx="2" fill="${mix(cursor, HAZE, t * 0.45)}"/>`,
  ].join('');
}

/** 図の中身。defs は竿のグラデーション（先頭 1 本の図には無い）、body は 100 × 100 の座標の <g>。 */
export function logoParts(opts: LogoOptions = {}): { defs: string; body: string } {
  const L = layout(opts);
  const sl = L.slots;
  let defs = '', rail = '';
  if (sl.length > 1) {
    const a = sl[0]!, b = sl[sl.length - 1]!;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, ext = 14;
    const x1 = a.x - ux * ext, y1 = a.y - uy * ext - 1, x2 = b.x + ux * ext, y2 = b.y + uy * ext - 1;
    defs = `<linearGradient id="hangar-rail" gradientUnits="userSpaceOnUse" x1="${num(x1)}" y1="0" x2="${num(x2)}" y2="0"><stop offset="0" stop-color="${INK}"/><stop offset="0.25" stop-color="${INK}"/><stop offset="1" stop-color="${HAZE}"/></linearGradient>`;
    rail = `<path d="M${num(x1)} ${num(y1)}L${num(x2)} ${num(y2)}" stroke="url(#hangar-rail)" stroke-width="2.6" stroke-linecap="round"/>`;
  }
  // 奥の札から描き、手前の札を上に重ねる。
  const hangers = sl
    .map((p, i) => ({ p, i }))
    .reverse()
    .map(({ p, i }) => `<g data-hanger="${i}" transform="translate(${num(p.x)} ${num(p.y)}) scale(${num(p.s)})">${hanger(p.t, CURSORS[i]!)}</g>`)
    .join('');
  return { defs, body: `<g transform="translate(${num(L.tx)} ${num(L.ty)}) scale(${num(L.sc)})">${rail}${hangers}</g>` };
}

/** 100 × 100 の SVG の文字列。 */
export function logoSvg(opts: LogoOptions = {}): string {
  const { defs, body } = logoParts(opts);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>\n`;
}

/** 書き出すファイル。path はリポジトリの根からの相対パス。 */
export const BRAND_FILES: { path: string; make: () => string }[] = [
  { path: 'packages/ui/src/brand/logo.svg', make: () => logoSvg() },
  { path: 'packages/ui/src/brand/logo-front.svg', make: () => logoSvg({ front: true }) },
  { path: 'apps/desktop/loading/logo.svg', make: () => logoSvg() },
];
```

- [ ] **Step 4: 書き出すスクリプトを作り、ファイルを書き出す**

`packages/ui/scripts/write-brand.ts` を作る。

```ts
/** ロゴのファイルを、src/brand/logo.ts の原図の関数から書き出す。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_FILES } from '../src/brand/logo.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
for (const f of BRAND_FILES) {
  fs.writeFileSync(path.join(repo, f.path), f.make());
  console.log(`wrote ${f.path}`);
}
```

`packages/ui/package.json` の `scripts` に次の 1 行を足す。

```json
    "brand": "node --import tsx scripts/write-brand.ts",
```

Run: `npm run brand --workspace packages/ui`
Expected: `wrote packages/ui/src/brand/logo.svg` など 3 行が出る。

出来た `packages/ui/src/brand/logo.svg` を Read で開いて目で見る（試作の `logo-compact.html` の右下と同じ形であること）。

- [ ] **Step 5: サイドバーにワードマークを置く**

`packages/ui/src/views/Sidebar.tsx` の先頭の import の並びに、次の 1 行を足す。

```tsx
import logoUrl from '../brand/logo.svg';
```

同じファイルの `<div style={{ padding: '0 16px 12px', fontWeight: 600 }}>agent-hangar</div>` を、次に置き換える。
ロゴは飾りなので `alt` を空にし、名前は文字で読ませる。
サイドバーのロゴは動かさない（仕様の「寸法ごとの形」）。

```tsx
      <div className="brand"><img className="brand-mark" src={logoUrl} width={22} height={22} alt="" />Hangar</div>
```

`packages/ui/src/styles/base.css` の `/* ナビ。…` のコメントの直前に、次の 2 行を足す。

```css
/* サイドバーのワードマーク。ロゴは淡い角丸の地に載せ、動かさない。 */
.brand { display: flex; align-items: center; gap: calc(var(--u) * 2); padding: calc(var(--u) * 0.5) calc(var(--u) * 2) calc(var(--u) * 3); font-weight: 650; letter-spacing: -0.01em; }
.brand-mark { flex: none; border-radius: 6px; background: linear-gradient(165deg, #f7f9ff, #dfe6ff); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.7); }
```

- [ ] **Step 6: favicon と題を置き換える**

`packages/ui/index.html` の `<title>agent-hangar</title>` と `<link rel="icon" …/>` の 2 行を、次に置き換える。
Vite は `index.html` の `href` の SVG を資産として `assets/` に出すので、サーバの `/assets/*` の配信と CSP の `img-src 'self' data:` のままで届く。

```html
    <title>Hangar</title>
    <link rel="icon" type="image/svg+xml" href="/src/brand/logo-front.svg" />
```

- [ ] **Step 7: 読み込み画面を新しい色と名前にする**

`apps/desktop/loading/index.html` の `<title>agent-hangar</title>` を `<title>Hangar</title>` に変える。
`:root { … }` の行を、次に置き換える。

```css
      :root { --bg: #eef1f7; --ink: #1c1b2e; --ink-2: #5f5e78; --error: #b3261e; }
```

`<h1>agent-hangar</h1>` を、次の 2 行に置き換える。
動く起動画面は 3 回目で作るので、この回は静止したロゴを置くだけにする。

```html
      <img src="logo.svg" width="96" height="96" alt="" />
      <h1>Hangar</h1>
```

- [ ] **Step 8: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui/src/brand/logo.test.ts apps/desktop/test/config.test.ts packages/ui/src/views/ && npm run typecheck --workspace packages/ui && npm run build --workspace packages/ui`
Expected: PASS、型検査 0 件、ビルドが通る。
ビルドの出力に、favicon とロゴの SVG が `assets/` に出ているか、`index.html` に data URI で埋め込まれていることを確かめる（`grep -o 'rel="icon"[^>]*' packages/ui/dist/index.html`）。

- [ ] **Step 9: コミット**

```bash
git commit packages/ui/src/brand packages/ui/scripts/write-brand.ts packages/ui/package.json packages/ui/src/views/Sidebar.tsx packages/ui/src/styles/base.css packages/ui/index.html apps/desktop/loading/index.html apps/desktop/loading/logo.svg apps/desktop/test/config.test.ts -m "$(cat <<'EOF'
feat(ui): draw the hanger logo from one source and show it as Hangar

Generate the logo from a pure function so the sidebar mark, the front-only
favicon, and the loading screen cannot drift from it, and rename the
visible app to Hangar.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: アプリアイコン

**Files:**
- Modify: `packages/ui/src/brand/logo.ts`（`appIconSvg` を足し、`BRAND_FILES` に 1 行）
- Modify: `packages/ui/src/brand/logo.test.ts`
- Create（生成）: `apps/desktop/src-tauri/icon.svg`（今のアーチと扉の図を置き換える）、`apps/desktop/src-tauri/icons/*`

**Interfaces:**
- Consumes: Task 5 の `logoParts()`。
- Produces: `appIconSvg(): string`（1024 × 1024。macOS のアイコンの格子どおり、824 × 824 の角丸の地を 100px 内側に置く）。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/brand/logo.test.ts` の import に `appIconSvg` を足し、`describe('ロゴの原図', ...)` の中の最後に次の `it` を足す。

```ts
  // macOS のアイコンは 1024 の枠の中に、824 の角丸の地を 100px 内側に置く。地の外は透明にする。
  it('アプリアイコンは 1024 の枠に、824 の地と原図の 4 本を置く', () => {
    const svg = appIconSvg();
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"/>');
    expect(count(svg)).toBe(4);
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/brand/logo.test.ts`
Expected: FAIL（`appIconSvg` が無い）。

- [ ] **Step 3: アイコンの関数を足す**

`packages/ui/src/brand/logo.ts` の `logoSvg` の関数の直後に、次を足す。

```ts
/**
 * アプリアイコン（1024 × 1024）。
 * 白から淡い青紫へのグラデーションの角丸の地に、上から淡い光沢を重ね、原図の 4 本を載せる。
 */
export function appIconSvg(): string {
  const { defs, body } = logoParts();
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">',
    '<defs>',
    '<linearGradient id="tile" x1="0.37" y1="0" x2="0.63" y2="1"><stop offset="0" stop-color="#f7f9ff"/><stop offset="0.55" stop-color="#dfe6ff"/><stop offset="1" stop-color="#e9defe"/></linearGradient>',
    '<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.45"/><stop offset="0.42" stop-color="#ffffff" stop-opacity="0"/></linearGradient>',
    defs,
    '</defs>',
    '<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"/>',
    '<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#sheen)"/>',
    '<rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="#ffffff" stroke-opacity="0.6" stroke-width="3"/>',
    `<g transform="translate(100 100) scale(8.24)">${body}</g>`,
    '</svg>',
    '',
  ].join('\n');
}
```

同じファイルの `BRAND_FILES` の配列の最後に、次の 1 行を足す。

```ts
  { path: 'apps/desktop/src-tauri/icon.svg', make: () => appIconSvg() },
```

- [ ] **Step 4: 書き出して、各寸法のアイコンを作る**

```bash
npm run brand --workspace packages/ui
cd apps/desktop && npx tauri icon src-tauri/icon.svg && cd ../..
git status --short apps/desktop/src-tauri
```

`tauri icon` は、今リポジトリに置いていない寸法や他の OS 用のファイル（`Square*.png`、`StoreLogo.png`、`icon.ico`、`android/`、`ios/` など）も作る。
`apps/desktop/src-tauri/icons/` に残すのは、今あるのと同じ 6 つ（`32x32.png`、`64x64.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`、`icon.png`）だけにし、ほかの新しく出来たファイルは消す。
消す前に `git status` の一覧を目で見て、今あるファイルを消していないことを確かめる。

出来た `apps/desktop/src-tauri/icons/128x128@2x.png` を Read で開いて目で見る（淡い角丸の地に、ハンガーが 4 本重なっていること）。

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui/src/brand/logo.test.ts apps/desktop/test/config.test.ts`
Expected: PASS（`icon に並ぶファイルが実在する` も通る）。

- [ ] **Step 6: コミット**

```bash
git commit packages/ui/src/brand/logo.ts packages/ui/src/brand/logo.test.ts apps/desktop/src-tauri/icon.svg apps/desktop/src-tauri/icons -m "$(cat <<'EOF'
feat(desktop): replace the app icon with the hanger logo on the macOS grid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: design.md を書き換える

仕様の「変わる既存の決定」のうち、この回で入った分だけを `docs/design.md` に写す。
動きの一覧、行の高さ、Home は 2 回目と 3 回目で写すので、ここでは触らない。

**Files:**
- Modify: `docs/design.md`（「画面」の「骨格」と、「見た目と動き」の最初の 2 段落）

- [ ] **Step 1: 「骨格」を書き換える**

`docs/design.md` の `### 骨格` の最初の行 `左にナビだけのサイドバー、上にヘッダー、残りがメインである。` を、次の 5 行に置き換える。

```markdown
左にナビだけのサイドバー、上にヘッダー、残りがメインである。
サイドバーとヘッダーは、中身の上に浮くガラスである（「見た目と動き」）。
メインはヘッダーの下をくぐって流れ、ヘッダーの高さと隙間の分だけ上に余白を取ってから始まる。
`.app` では標準のタイトルバーを消し、信号の 3 点をサイドバーの左上に乗せ、ヘッダーの空いた所を掴んで窓を動かし、そこをダブルクリックすると窓が拡大する。
そのために、UI の出どころ（`http://127.0.0.1:4177`）に窓を動かす権限（`core:window:allow-start-dragging`）とダブルクリックで拡大する権限（`core:window:allow-internal-toggle-maximize`）の 2 つだけ与え（`capabilities/remote-drag.json`）、殻は頁に `data-shell="desktop"` の印を付けて、サイドバーはその印があるときだけ信号の 3 点の分の上の余白を取る。
```

- [ ] **Step 2: 「見た目と動き」の最初の段落を書き換える**

`## 見た目と動き` の直後の、`常にライトで、ダークモードは持たない。` から `グラデーション、グロー、ガラス、影の多用はしない。` までの段落を、次に置き換える。
ステータスの部品の説明（`ステータスの部品は、文字、その右の塗りつぶしの丸、矢印の順に自前で描き、…` から `ステータスは常に文字でも示すので、色は補助である。` まで）は、そのまま間に残す。

```markdown
常にライトで、ダークモードは持たない。
例外はターミナルの面だけで、そこは端末エミュレータの慣習に合わせて墨色の不透明な板（`--term-bg`、`--term-fg`）にする。
参照するのは macOS 26 の Liquid Glass である。
画面は奥から「光の背景」「読む面」「浮くガラス」の 3 枚で組む。
光の背景は地の `--bg` に 2 つの淡い光（`--aura-1`、`--aura-2`）を置き、`--aura-period`（24 秒）で漂わせる。reduced motion では止める。
読む面（一覧、カード、会話、設定の中身）は白で不透明にし、ガラスを重ねない。
ガラスはヘッダー、サイドバー、⌘K パレット、ダイアログ、通知、切断の帯にだけ使い、`backdrop-filter` は必ず `-webkit-backdrop-filter` と併記する（`styles/glass.test.ts` が置き場所を見張る）。
色はデザイントークンとして `:root` に定義する。
面は白と淡い青灰、アクセントは 1 色（`--accent`、主ボタンだけ `--accent-hi` からの淡いグラデーション）、状態色（busy、idle、終了、エラー）は控えめな彩度にする。
本文の色は、白地と、ガラスを重ねた色（白 40% を `--bg` に重ねた `#f5f7fa`）の両方で 4.5:1 以上を保つ。
```

同じ節の `グラデーション、グロー、ガラス、影の多用はしない。` の 1 行を、次の 3 行に置き換える。

```markdown
グラデーションは主ボタンと背景の光だけ、影は浮く部品と端末の板だけに許す。
読む面へのガラス、シマー、スケルトン、タイピング風の表示、文字の影、光る文字は使わない。
角は部品が 8px（`--r`）、面が 14px（`--r-lg`）、浮くガラスが 16px（`--r-xl`、ダイアログは 18px）、ボタンと検索欄とヘッダーは錠剤（`--r-pill`）にする。
```

- [ ] **Step 3: 書式を確かめる**

Run: `grep -n "・\|—" docs/design.md | head`
Expected: 書き換えた行に中黒とダッシュが無い（既存の行に出るものは、この Task で足したものでなければ触らない）。

- [ ] **Step 4: コミット**

```bash
git commit docs/design.md -m "$(cat <<'EOF'
docs: describe the floating glass frame and the melted title bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 全体を通して、実物で確かめる

**Files:** なし（確かめるだけ。直すところが見つかったら、その規則を持つ Task のファイルを直し、同じ Task のコミットの作法で入れる）

- [ ] **Step 1: 試験と型検査を全部通す**

Run: `npm test && npm run typecheck`
Expected: 全部の試験が PASS、型検査 0 件。
落ちた試験があれば、試験を緩めずに原因を直す。

- [ ] **Step 2: 3 つのビルドを通す**

```bash
npm run build
npm run bundle-server --workspace apps/desktop
npm run tauri --workspace apps/desktop -- build
```

Expected: 3 つとも成功する。
`tauri build` は時間がかかるので background で回し、終わりを待ってから次へ進む。

- [ ] **Step 3: 利用者の dev サーバを落とす**

```bash
lsof -nP -iTCP:4177 -sTCP:LISTEN -t
ps -o command= -p <上で出た PID>
```

コマンド行が tsx のサーバ（`packages/server`）であることを確かめてから、`kill <PID>` でその 1 つだけを止める。
Vite（5173）には触らない。
`Hangar.app` が走っていれば、`osascript -e 'tell application "Hangar" to quit'` で閉じる。
止めたことと、利用者が `npm run dev` を立て直す必要があることを、報告に 1 行で書く。

- [ ] **Step 4: .app で確かめる**

`open apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` で開き、次を確かめて画面の写しを残す。

1. Dock とアプリの切り替え（⌘Tab）に、新しいアイコンが出る。
2. 読み込み画面に静止したロゴと「Hangar」が出て、信号の 3 点と重ならない。
3. 信号の 3 点がサイドバーのガラスの左上の内側に乗り、サイドバーの中身と重ならない。
4. ヘッダの空いた所を掴むと窓が動き、検索欄とボタンは押せる。
5. Home、Projects、プロジェクト詳細、セッション画面（実行中のもの、端末が出るもの）、Sessions、Settings を開き、崩れが無い。
6. 端末に出力が流れている間にヘッダの下へ一覧をスクロールしても、引っかからない。
7. システム設定の「視差効果を減らす」を入れると、背景の光が止まる。

`/Applications/Hangar.app` を入れ替えるかどうかは、利用者に確かめてから行う。

- [ ] **Step 5: ブラウザで確かめる**

利用者の dev（`http://localhost:5173`）か、ビルドした UI で開き、次を確かめる。

1. ブラウザのタブに、先頭 1 本のハンガーの favicon と「Hangar」の題が出る。
2. サイドバーの上に、信号の 3 点のための空白が無い。
3. Step 4 の 5 と同じ 6 画面に崩れが無い。

- [ ] **Step 6: 利用者に見せる**

Step 4 と Step 5 で残した画面の写しを並べ、この回で変わったこと、変わっていないこと（Home の作りと行の高さ、端末の縁の灯、動きは 2 回目と 3 回目）、止めた dev サーバのことを報告する。
`main` に入れるかどうかは、利用者の確認を待つ。

---

## 自己点検の記録

- 仕様の 1（見た目の言語）：層は Task 3、ガラスは Task 3 と Task 4、端末の板は Task 4（縁の灯は 3 回目）、形と色と文字は Task 2 と Task 4、design.md は Task 7。
- 仕様の 2（ロゴと資産）：原図と寸法ごとの形は Task 5 と Task 6、表示名は Task 1 と Task 5、起動画面の動きは 3 回目（この回は静止したロゴ）。
- 仕様の 3（画面）のうち、骨格と .app のタイトルバーは Task 1 と Task 3。Home、セッション画面、一覧の行は 2 回目と 3 回目。
- 仕様の 5（試験と検証）のうち、この回の分は、`backdrop-filter` の置き場所（Task 3）、コントラスト（Task 2）、権限の試験（Task 1）、実物での確かめ（Task 1 と Task 8）。
- 名前の一致：`logoParts`、`logoSvg`、`appIconSvg`、`layout`、`slots`、`mix`、`CURSORS`、`BRAND_FILES` は Task 5 と Task 6 で同じ名前で使っている。`data-shell` と `data-tauri-drag-region` は Task 1、Task 3、Task 7 で同じ綴り。
