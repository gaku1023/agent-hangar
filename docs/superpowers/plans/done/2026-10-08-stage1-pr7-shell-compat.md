# 段 1 PR 7 殻とサーバの互換の版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hangar.app の殻が、4177 で動いている既存のサーバを採る前に `/health` の互換の版を自分の版と比べ、違えば採らずに読み込み画面で理由を出す。あわせて、古いサーバのための分岐（`ready` の無いサーバを済んだものとみなす所）と、古い殻のための言い分けを消す。

**Architecture:** 殻（`apps/desktop/src-tauri`）は、同梱するサーバと同じ互換の版を `health.rs` の定数で名乗る。
定数が shared の正本（`packages/shared/src/compat.ts` の `COMPAT_VERSION`）とずれていないことは、TS の試験が Rust の原本を読んで縛る（いまの `PORT` や `BOOT_FINISH_MS` と同じ形）。
`health.rs` に、`/health` の応答から「採る、採らない、居ない」を決める純な関数を置き、`lib.rs` の `start_server` がそれを 1 回呼ぶ。
採らなかったときは、いまの起動の失敗と同じ道（`fail`）で読み込み画面に文を出し、「もう一度試す」と「ログを開く」を出す。
文は試作で利用者に選んでもらう。

**Tech Stack:** Rust（Tauri v2、serde_json）、cargo test、clippy、rustfmt、TypeScript、vitest。

**Spec:** `docs/superpowers/specs/2026-10-07-stage1-subtraction-design.md`（「互換の版番号（D10）」の殻の行、「古い版のための分岐」、「PR の割り方」の PR 7 の行）。
段をまたぐ決定は `docs/superpowers/specs/2026-10-07-refactor-roadmap-design.md` の D10。
いまの作りは `docs/design.md` の「プロセスと通信」、「互換の版番号」、「決めた前提と未決事項」の「二重起動」。
書き方の手本は `docs/superpowers/plans/2026-10-07-stage1-pr3-compat-version.md` と `docs/superpowers/plans/2026-10-07-stage1-pr2-bundle.md`。

## 入れる条件と、ほかの PR との関係

spec の入れる条件は PR 3 だけで、PR 3 は main に入っている（サーバの `/health` は `compat` を返す）。
PR 4、5、6 とは触るファイルがほとんど重ならない。
重なるのは `docs/design.md` の「互換の版番号」の節だけなので、後から入る方が先に入った方の文に合わせて直す。

## 決めたこと

spec が決めていない所を、次のように決めた。

1. **殻の版は、同梱の束から読まずに、殻の定数で持つ。**
   spec は「自分が同梱するサーバの版と比べる」と書く。
   同梱の `manifest.json` に版を書いて殻が読む案もあるが、その場合は既存のサーバを探る前に、リソースの場所と `manifest.json` を読めなければならない。
   いまは同梱のサーバが見つからなくても既存のサーバを採れる（開発で `tauri dev` から `npm run dev` のサーバを使う形）ので、それが崩れる。
   殻とその同梱のサーバは同じコミットから同じ束で作るので、殻の定数を shared の正本と試験で縛れば、同梱のサーバの版と同じになる。
   全体計画の D10 も「サーバ、Worker、殻は互換の版番号を 1 つ持ち」と書いている。
2. **比べ方は「等しいか」である。**
   spec の「違えば採らずに理由を出す」に合わせ、下限ではなく一致で比べる。
   `compat` が無い応答（PR 3 より前のサーバ）と、0 以上の整数として読めない値は、版 0 として読む（shared の `parseCompat` と同じ）。
3. **hangar でない相手は、版を問う前に「居ない」として扱う。**
   いまと同じく、`ok` が真で `version` が文字列の応答だけを hangar とみなす（`is_healthy`）。
   hangar でなければ、同梱のサーバを起こしにいき、待ち受けの取り合いで子が終われば、いまと同じ「起動直後に終了しました」の文になる。
4. **採らなかったサーバは止めない。**
   利用者が自分で起こしたもの（`hangar start` や `npm run dev`）かもしれず、ポートの番号だけを頼りに止めない。
   止めてから「もう一度試す」を押すと、殻は起動をやり直して同梱のサーバを起こす（いまの `retry_boot` の道）。
5. **`ready` を持たない応答は、起動の進み具合として読まない。**
   殻が採るのは同じ版のサーバだけで、それは必ず `ready` を持つ。
   `boot_state` は `ready` が真偽値でなければ None を返し、待ちの輪は「応答が途切れた」として扱う（10 秒で諦める）。
   CLI の `probeReady` も同じく、`ready` が真のときだけ済んだとみなす（`hangar start` が待つのは自分で起こした同じ束のサーバである）。
6. **古い殻のための言い分けは、文から消して、分岐は残す。**
   UI の通知（`notifier.ts`）は、殻の命令 `notify_status` が失敗したら「まだ決まっていない」として扱う。
   いまの説明は「古い殻（命令が無い）」のためだと書いているが、同じ枝は、権限で断られたときや殻が答えないときにも要る。
   古い殻という理由だけを消し、IPC の失敗の受けとして残す。
   殻が版の合うサーバだけを採るので、UI と殻の版が食い違う筋は、殻の命令を変えるときに互換の版を上げる約束で塞ぐ（設計書の「いつ上げるか」に足す）。
7. **採らなかったときの画面は、いまの起動の失敗の画面を使う。**
   赤い等幅の文と「もう一度試す」「ログを開く」のボタンである。
   変わるのは文だけなので、試作では文の案を並べる（Task 1）。

## Global Constraints

- 殻の互換の版は `apps/desktop/src-tauri/src/health.rs` の `pub const COMPAT_VERSION: u64 = 1;`。正本は `packages/shared/src/compat.ts` の `COMPAT_VERSION`（いまは 1）。
- 既存のサーバを採るのは、`is_healthy` が真で、かつ `compat`（無ければ 0）が殻の版と等しいときだけ。
- 採らなかったときの文は、動いているサーバの版、殻の版、`4177`、「もう一度試す」を含む（Task 1 で選んだ案の文）。
- 殻はポートの番号を頼りにプロセスを止めない。
- Rust の試験と検査は、`~/.cargo/bin` の古い rustup の代理を拾わないよう、Homebrew の道具を直接呼ぶ。
  - `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo-fmt fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo-clippy clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
- tauri build は `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" npm run tauri -w apps/desktop -- build`。
- TS の試験は vitest で、リポジトリの根で `npx vitest run <ファイルかディレクトリ>`。型は `npm run typecheck`。
- 作業の前に、worktree の根で `npm ci` を打つ。
- 各タスクは「試験を書く、落ちるのを見る、実装する、通るのを見る」の順に進める。
- 4177 で動いているサーバと `/Applications` のアプリには、Task 7 で利用者に聞くまで触らない。
- 実物のクラウドには触らない（この PR はクラウドに関わらない）。
- 公開リポジトリである。実在の人名、メール、手元のパス、使用量の実数を、コード、試験、コメント、コミット、文書に書かない。
- コードのコメントは日本語で、周りと同じ密度にする。
- 文書（design.md）は日本語で一文一行にし、中黒（U+30FB）と em ダッシュ（U+2014）を使わない。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。
- git のコマンドはほかのコマンドと 1 行に混ぜず、1 本ずつ打つ。
- 行番号は main `33ca14e` を読んだ値である。編集の前に、書かれた文字列で場所を確かめる。

## Review Focus

- **4177 に `compat` を載せない古い hangar のサーバ（PR 3 より前の `hangar start`）**：採らずに、動いているサーバを版 0 と言って理由を出す（Task 3 の試験で留める）。
- **4177 に hangar でない別のプログラム**：版を問わずに「居ない」とし、いまどおり同梱のサーバを起こしにいく（Task 3 の試験で留める）。
- **`compat` が文字列、小数、負の数の壊れた応答**：版 0 として読み、採らない（Task 3 の試験で留める）。
- **版の合うサーバ（同じ版の `npm run dev` や `hangar start`）**：いまどおり採って、子を起こさない（Task 3 の試験で留める）。
- **採ったサーバの `/health` に `ready` が無い**：済んだものとみなして移らず、応答の無いサーバとして扱う（Task 3 の試験で留める）。

---

### Task 1: 試作（殻が既存のサーバを採らなかったときの文）

画面の文が変わるので、実装（Task 4）の前に試作を作って利用者に選んでもらう。
選ぶのを待つ間に Task 2 と Task 3 を進めてよい（画面の文に触らない）。

**選ばれた案（2026-10-09）。**
試作は docs の PR #35 で出した（`docs/superpowers/specs/2026-10-08-shell-compat-refusal/options.html`）。
Gemini 3.6 Flash と見直したうえで、利用者は B と C を合わせた案を選んだ。
文はどちらが古いかで言い分け（案 B の文）、その下に、そのポートで待ち受けているプロセスを調べる命令 `lsof -nP -iTCP:<ポート> -sTCP:LISTEN` を添える（案 C）。
ポートは 4177 に決め打ちせず、殻が探った番号を使う。
lsof の無い Windows では命令を添えない（Windows の .app はまだ作っておらず、そこで確かめられる命令が無い）。
殻はそのサーバを止めない。
ポートを引数で渡すことと、Windows で命令を添えないことは、利用者の選択ではなく実装のまとめ役が決めたことである（利用者が試作で見たのは、lsof の行を常に添える案 C である）。
文は Task 4 の `refusal_message` に置く。
Task 4 と Task 6 の文と試験は、この案に合わせて書き直した。

**Files:**
- Create: `docs/superpowers/specs/2026-10-08-shell-compat-refusal/options.html`

**Interfaces:**
- Consumes: なし。
- Produces: 利用者が選んだ案の記号（`A`、`B`、`C` のどれか）。Task 4 がこれで文を選ぶ。

- [ ] **Step 1: 試作を書く**

`docs/superpowers/specs/2026-10-08-shell-compat-refusal/options.html` を作る。
読み込み画面（`apps/desktop/loading/index.html`）の失敗の姿（ロゴ、名前、赤い等幅の文、「もう一度試す」と「ログを開く」）を、文の案ごとに並べる。
場面は「4177 で、互換の版の違う hangar のサーバが動いている」で、動いているサーバが古いとき（版 0）と新しいとき（版 2）の 2 つを、この Hangar.app の版 1 と組む。

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>殻が既存のサーバを採らなかったとき</title>
<style>
:root { --bg: #eef1f7; --ink: #1c1b2e; --ink-2: #5f5e78; --error: #b3261e; --accent: #4a63e8; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink-2); font: 13px/1.5 'Inter Variable', 'Hiragino Sans', sans-serif; }
.wrap { max-width: 1280px; margin: 0 auto; }
h1 { font-size: 20px; color: var(--ink); margin: 0 0 4px; }
.lead { margin: 0 0 20px; line-height: 1.6; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(600px, 1fr)); gap: 16px; }
.opt { border-radius: 18px; padding: 12px; background: rgba(255,255,255,0.45); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.8); }
.opt-h { display: flex; align-items: baseline; gap: 8px; margin: 2px 4px 10px; color: var(--ink); }
.letter { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--ink); color: #fff; font-size: 12px; font-weight: 700; }
.d { color: var(--ink-2); font-size: 12px; }
.cap { font-size: 11px; margin: 8px 4px 4px; }
/* 読み込み画面の失敗の姿の写し（apps/desktop/loading/index.html）。 */
.screen { display: grid; place-items: center; min-height: 380px; border-radius: 14px; background: var(--bg); box-shadow: inset 0 0 0 1px rgba(30,40,90,0.08); padding: 16px; }
.screen main { display: grid; justify-items: center; max-width: 560px; text-align: center; }
.screen h2 { font-size: 15px; font-weight: 600; color: var(--ink); margin: 6px 0 0; }
.status { margin: 12px 0 0; white-space: pre-wrap; color: var(--error); text-align: left; font-family: 'JetBrains Mono Variable', Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.actions { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
.btn { display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border: 0; border-radius: 999px; font: 560 13px 'Inter Variable', 'Hiragino Sans', sans-serif; color: var(--ink); background: rgba(255,255,255,0.78); box-shadow: inset 0 1px 0 #fff, 0 1px 3px rgba(30,40,90,0.14); }
.btn-primary { color: #fff; background: linear-gradient(180deg, #6b8cff, #4a63e8); }
</style>
</head>
<body>
<div class="wrap">
<h1>殻が既存のサーバを採らなかったとき</h1>
<p class="lead">Hangar.app を開いたとき、4177 で互換の版の違う hangar のサーバ（hangar start や npm run dev で起こしたもの）が動いていた場面です。<br>殻はそのサーバを止めずに、読み込み画面に理由を出します。ボタンはいまの起動の失敗と同じです。</p>
<div class="grid">

<div class="opt">
  <div class="opt-h"><span class="letter">A</span><b>短く、止め方を言う（推す）</b><span class="d">向きは言わず、どちらの向きでも同じ文</span></div>
  <div class="cap">動いているサーバが版 0、この Hangar.app が版 1</div>
  <div class="screen"><main><img src="../../../../apps/desktop/loading/logo.svg" width="96" height="96" alt=""><h2>Hangar</h2><p class="status">4177 で、この Hangar.app と互換の版が違う hangar のサーバが動いています（動いているサーバは版 0、この Hangar.app は版 1）。
そのサーバ（hangar start や npm run dev で起こしたもの）を止めてから「もう一度試す」を押してください。</p><div class="actions"><button class="btn btn-primary">もう一度試す</button><button class="btn">ログを開く</button></div></main></div>
</div>

<div class="opt">
  <div class="opt-h"><span class="letter">B</span><b>どちらが古いかで言い分ける</b><span class="d">アプリが古いときは、入れ替えも案内する</span></div>
  <div class="cap">動いているサーバが版 0、この Hangar.app が版 1</div>
  <div class="screen"><main><img src="../../../../apps/desktop/loading/logo.svg" width="96" height="96" alt=""><h2>Hangar</h2><p class="status">4177 で動いている hangar のサーバが、この Hangar.app より古い版です（動いているサーバは版 0、この Hangar.app は版 1）。
そのサーバ（hangar start や npm run dev で起こしたもの）を止めてから「もう一度試す」を押してください。止めると、この Hangar.app が同梱のサーバを起こします。</p><div class="actions"><button class="btn btn-primary">もう一度試す</button><button class="btn">ログを開く</button></div></main></div>
  <div class="cap">動いているサーバが版 2、この Hangar.app が版 1</div>
  <div class="screen"><main><img src="../../../../apps/desktop/loading/logo.svg" width="96" height="96" alt=""><h2>Hangar</h2><p class="status">この Hangar.app が、4177 で動いている hangar のサーバより古い版です（動いているサーバは版 2、この Hangar.app は版 1）。
Hangar.app を新しい版に入れ替えるか、そのサーバを止めてから「もう一度試す」を押してください。</p><div class="actions"><button class="btn btn-primary">もう一度試す</button><button class="btn">ログを開く</button></div></main></div>
</div>

<div class="opt">
  <div class="opt-h"><span class="letter">C</span><b>A に、相手を調べる命令を添える</b><span class="d">どのプロセスが 4177 を持っているかを、自分で調べられる</span></div>
  <div class="cap">動いているサーバが版 0、この Hangar.app が版 1</div>
  <div class="screen"><main><img src="../../../../apps/desktop/loading/logo.svg" width="96" height="96" alt=""><h2>Hangar</h2><p class="status">4177 で、この Hangar.app と互換の版が違う hangar のサーバが動いています（動いているサーバは版 0、この Hangar.app は版 1）。
そのサーバ（hangar start や npm run dev で起こしたもの）を止めてから「もう一度試す」を押してください。
動いているサーバは次で調べられます。
lsof -nP -iTCP:4177 -sTCP:LISTEN</p><div class="actions"><button class="btn btn-primary">もう一度試す</button><button class="btn">ログを開く</button></div></main></div>
</div>

</div>
</div>
</body>
</html>
```

- [ ] **Step 2: ブラウザで開いて自分で見る**

WebKit で開いて撮り、ロゴが出て、文が枠の中で折り返し、ボタンが文の下に並んでいることを見る（画面の確認は利用者に返さない）。

- [ ] **Step 3: 利用者に選んでもらう**

ファイルの場所を添えて、AskUserQuestion で 1 問だけ聞く。
推す案を先頭に置く。

- 問い：「Hangar.app が 4177 の版の違うサーバを採らなかったとき、読み込み画面にどの文を出しますか（試作 docs/superpowers/specs/2026-10-08-shell-compat-refusal/options.html）」
- 選択肢：「A：短く、止め方を言う（推す）」「B：どちらが古いかで言い分ける」「C：A に、相手を調べる命令を添える」

選んだ記号を控え、Task 4 で使う。
利用者が選ぶまで Task 4 には入らない。

- [ ] **Step 4: コミットする**

```bash
git add docs/superpowers/specs/2026-10-08-shell-compat-refusal/options.html
```

```bash
git commit -m "docs: prototype the loading screen text when the shell refuses an existing server" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 殻が互換の版を名乗る

**Files:**
- Modify: `apps/desktop/src-tauri/src/health.rs`（定数を 1 つ足す）
- Modify: `apps/desktop/test/config.test.ts`（import と、describe を 1 つ）

**Interfaces:**
- Consumes: `packages/shared/src/compat.ts` の `COMPAT_VERSION`。
- Produces: `health::COMPAT_VERSION: u64`（`1`）。Task 3 と Task 4 が使う。

- [ ] **Step 1: 試験を書く**

`apps/desktop/test/config.test.ts` の import の最後に足す。

```ts
import { COMPAT_VERSION } from '../../../packages/shared/src/compat.ts';
```

ファイルの末尾に足す。

```ts
describe('互換の版', () => {
  // 殻は 4177 の既存のサーバを、自分が名乗る版と同じ版のときだけ採る（health.rs の judge_existing）。
  // 殻の版は同梱するサーバの版と同じでなければならないので、shared の正本と突き合わせる。
  // 片方だけ変えると、殻は自分と同じ束のサーバまで採らなくなるか、版の違うサーバを採る。
  it('殻が名乗る互換の版（health.rs の COMPAT_VERSION）は shared の正本と同じ', () => {
    const rust = read('src-tauri/src/health.rs').match(/pub const COMPAT_VERSION: u64 = (\d+);/)?.[1];
    expect(rust).toBeDefined();
    expect(Number(rust)).toBe(COMPAT_VERSION);
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run apps/desktop/test/config.test.ts`
Expected: FAIL（`health.rs` に定数が無く、`rust` が undefined）。

- [ ] **Step 3: 実装する**

`apps/desktop/src-tauri/src/health.rs` の `const MAX_TRIES: u32 = 10_000;` の定義の次に足す。

```rust
/// 殻が名乗る互換の版。同梱するサーバと同じ版である。
/// 正本は `packages/shared/src/compat.ts` の `COMPAT_VERSION` で、ここはその写しである。
/// 片方だけ変えると `apps/desktop/test/config.test.ts` の「殻が名乗る互換の版は shared の正本と同じ」が落ちる。
/// 殻は 4177 で動いている既存のサーバを、この版と同じ版を名乗るときだけ採る（`judge_existing`）。
pub const COMPAT_VERSION: u64 = 1;
```

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run apps/desktop/test/config.test.ts`
Expected: PASS。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo-clippy clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: 警告なし（まだ誰も使わない `pub const` は、`pub` なので使われていない警告にならない）。

- [ ] **Step 5: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 6: コミットする**

```bash
git add apps/desktop/src-tauri/src/health.rs apps/desktop/test/config.test.ts
```

```bash
git commit -m "feat(desktop): give the shell the compat version of its bundled server" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 既存のサーバを採るかを決め、`ready` の無い応答を読まない

**Files:**
- Modify: `apps/desktop/src-tauri/src/health.rs`（`Existing`、`judge_existing`、`probe_existing` を足し、`boot_state` を直し、試験を足して直す）

**Interfaces:**
- Consumes: Task 2 の `COMPAT_VERSION`、いまの `is_healthy` と `http_get`。
- Produces:
  - `pub enum Existing { Absent, Adopt, Mismatch { theirs: u64 } }`（`Debug, Clone, Copy, PartialEq, Eq`）
  - `pub fn judge_existing(status: u16, body: &str, ours: u64) -> Existing`
  - `pub fn probe_existing(addr: SocketAddr, ours: u64) -> Existing`
  - `boot_state` は `ready` が真偽値でない応答に None を返す。

- [ ] **Step 1: 試験を書く**

`apps/desktop/src-tauri/src/health.rs` の `mod tests` の `serve_with` の次に、道具を 1 つ足す。

```rust
    /// 1 接続だけ受けて、渡した JSON を 200 で返す。長さは本文から数える。
    fn serve_json(body: &str) -> SocketAddr {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        serve_with(move |mut s| {
            read_request(&mut s);
            let _ = s.write_all(response.as_bytes());
        })
    }
```

`fn boot_state_treats_an_older_server_as_ready()` とその説明のコメントを、次に置き換える。

```rust
    /// `ready` を真偽値で持たない応答（進み具合を載せる前の古いサーバなど）は読まない。
    /// 殻は互換の版の合うサーバだけを採り、それは必ず `ready` を持つ。
    #[test]
    fn boot_state_does_not_read_a_response_without_ready() {
        assert_eq!(boot_state(200, r#"{"ok":true,"version":"0.2.0"}"#), None);
        assert_eq!(
            boot_state(200, r#"{"ok":true,"version":"0.2.0","ready":"no"}"#),
            None
        );
        assert_eq!(
            boot_state(200, r#"{"ok":true,"version":"0.2.0","ready":null}"#),
            None
        );
    }
```

`fn boot_state_does_not_trust_the_numbers_or_the_phase()` の中の `odd` とその `assert_eq!` を、次に置き換える（`ready` は真偽値にし、数と段階だけを壊す）。

```rust
        let odd = r#"{"ok":true,"version":"v","ready":false,"index":{"phase":"<script>","done":-3,"total":2.5}}"#;
        assert_eq!(
            boot_state(200, odd),
            Some(Boot {
                ready: false,
                phase: Phase::Idle,
                done: 0,
                total: 0
            })
        );
```

`mod tests` の最後（`http_get_works_with_a_server_that_reads_once_and_closes` の次）に足す。

```rust
    /// 版の合うサーバだけを採る。合わなければ、相手の版を添えて採らない。
    #[test]
    fn judge_existing_adopts_only_a_server_of_the_same_compat() {
        let body = |c: &str| format!(r#"{{"ok":true,"version":"0.4.0","compat":{c},"ready":true}}"#);
        assert_eq!(judge_existing(200, &body("1"), 1), Existing::Adopt);
        assert_eq!(
            judge_existing(200, &body("2"), 1),
            Existing::Mismatch { theirs: 2 }
        );
        assert_eq!(
            judge_existing(200, &body("1"), 2),
            Existing::Mismatch { theirs: 1 }
        );
    }

    /// `compat` を載せない古いサーバと、0 以上の整数として読めない値は、版 0 として読む。
    /// 端末の `parseCompat`（packages/shared/src/compat.ts）と同じ読み方である。
    #[test]
    fn judge_existing_reads_a_missing_or_broken_compat_as_zero() {
        assert_eq!(
            judge_existing(200, r#"{"ok":true,"version":"0.3.0","ready":true}"#, 1),
            Existing::Mismatch { theirs: 0 }
        );
        for c in ["-1", "1.5", "\"1\"", "null", "1e3", "{}"] {
            let b = format!(r#"{{"ok":true,"version":"v","compat":{c}}}"#);
            assert_eq!(
                judge_existing(200, &b, 1),
                Existing::Mismatch { theirs: 0 },
                "{c}"
            );
        }
    }

    /// hangar でない相手は、版を問う前に「居ない」とする。殻は採らずに、同梱のサーバを起こしにいく。
    #[test]
    fn judge_existing_treats_another_program_as_absent() {
        assert_eq!(judge_existing(200, r#"{"status":"ok"}"#, 1), Existing::Absent);
        assert_eq!(judge_existing(200, r#"{"ok":true,"compat":1}"#, 1), Existing::Absent);
        assert_eq!(
            judge_existing(500, r#"{"ok":true,"version":"v","compat":1}"#, 1),
            Existing::Absent
        );
        assert_eq!(judge_existing(200, "<html>", 1), Existing::Absent);
    }

    /// ソケット越しにも同じに決める。誰も待ち受けていなければ「居ない」。
    #[test]
    fn probe_existing_decides_over_a_socket() {
        let same = serve_json(r#"{"ok":true,"version":"0.4.0","compat":1,"ready":true}"#);
        assert_eq!(probe_existing(same, 1), Existing::Adopt);
        let older = serve_json(r#"{"ok":true,"version":"0.3.0"}"#);
        assert_eq!(probe_existing(older, 1), Existing::Mismatch { theirs: 0 });
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let nobody = l.local_addr().unwrap();
        drop(l);
        assert_eq!(probe_existing(nobody, 1), Existing::Absent);
    }
```

- [ ] **Step 2: 落ちるのを見る**

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml health::`
Expected: FAIL（`Existing`、`judge_existing`、`probe_existing` が無いのでビルドが通らない）。

- [ ] **Step 3: 実装する**

`apps/desktop/src-tauri/src/health.rs` の `probe_health` の次に足す。

```rust
/// 4177 で応えた相手をどう扱うか。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Existing {
    /// hangar のサーバは居ない。誰も応えないか、hangar の応答ではない。
    Absent,
    /// 互換の版の合う hangar のサーバが居る。子を起こさずに採る。
    Adopt,
    /// 互換の版の合わない hangar のサーバが居る。採らない。
    /// `theirs` はその版で、`compat` を載せない古いサーバは 0 である。
    Mismatch { theirs: u64 },
}

/// `/health` の応答から、既存のサーバを採るかを決める。
/// hangar の応答（`is_healthy`）でなければ、版を問わずに「居ない」とする。
/// `compat` が無いか、0 以上の整数として読めない応答は、版 0 として読む（`packages/shared/src/compat.ts` の `parseCompat` と同じ）。
/// 比べ方は一致である。版の違うサーバの UI を出すと、殻とサーバの合図（起動の進み具合、殻の命令）が食い違っても気付けない。
pub fn judge_existing(status: u16, body: &str, ours: u64) -> Existing {
    if !is_healthy(status, body) {
        return Existing::Absent;
    }
    let theirs = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("compat").and_then(|x| x.as_u64()))
        .unwrap_or(0);
    if theirs == ours {
        Existing::Adopt
    } else {
        Existing::Mismatch { theirs }
    }
}

/// 宛先を 1 回だけ叩いて、既存のサーバを採るかを決める。応えなければ「居ない」。
pub fn probe_existing(addr: SocketAddr, ours: u64) -> Existing {
    http_get(addr, "/health", PROBE_TIMEOUT)
        .map(|(s, b)| judge_existing(s, &b, ours))
        .unwrap_or(Existing::Absent)
}
```

`boot_state` の説明の「`ready` を持たない（進み具合を載せる前の）サーバは、済んだものとして扱う。」を、次に置き換える。

```rust
/// `ready` を真偽値で持たない応答も None にする。殻が採るのは互換の版の合うサーバだけで、それは必ず `ready` を持つ。
```

`boot_state` の中の `let ready = v.get("ready").and_then(|x| x.as_bool()).unwrap_or(true);` を、次に置き換える。

```rust
    let ready = v.get("ready").and_then(|x| x.as_bool())?;
```

- [ ] **Step 4: 通るのを見る**

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml health::`
Expected: PASS。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS（`lib.rs` の待ちの輪の試験は `Boot` を直に作るので、`boot_state` の変更で崩れない）。

- [ ] **Step 5: 書式と lint を見る**

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo-fmt fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 差分なし。
差分が出たら `--check` を外して打ち、整えた形で進む。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo-clippy clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: 警告なし。

- [ ] **Step 6: コミットする**

```bash
git add apps/desktop/src-tauri/src/health.rs
```

```bash
git commit -m "feat(desktop): decide whether to adopt an existing server by its compat version" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 版の合わないサーバを採らず、読み込み画面に理由を出す

Task 1 で利用者が選ぶまで、このタスクに入らない。

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`refusal_message` を足し、`start_server` の頭を替え、`wait_for_ready` の説明を直し、試験を足す）

**Interfaces:**
- Consumes: Task 3 の `health::probe_existing`、`health::Existing`、Task 2 の `health::COMPAT_VERSION`、`server::PORT`、いまの `fail`（`boot` が `start_server` の `Err` を読み込み画面へ出す）。
- Produces: `fn refusal_message(port: u16, theirs: u64, ours: u64) -> String`（Task 1 で選んだ案の文）。`start_server` は、版の合わないサーバに対して子を起こさずに `Err(refusal_message(addr.port(), theirs, health::COMPAT_VERSION))` を返す。

- [ ] **Step 1: 試験を書く**

`apps/desktop/src-tauri/src/lib.rs` の `mod tests` の最後に足す。

```rust
    // 採らなかった理由の文は、どちらの向きでも、相手と自分の版、ポート、次の一手を言う。
    // 読み込み画面は「もう一度試す」と「ログを開く」を出すので、文はそのボタンへつなぐ。
    #[test]
    fn the_refusal_names_both_versions_the_port_and_the_next_step() {
        for (theirs, ours) in [(0, 1), (2, 1)] {
            let m = refusal_message(server::PORT, theirs, ours);
            assert!(m.contains(&format!("版 {theirs}")), "{m}");
            assert!(m.contains(&format!("版 {ours}")), "{m}");
            assert!(m.contains(&server::PORT.to_string()), "{m}");
            assert!(m.contains("もう一度試す"), "{m}");
        }
    }

    // 利用者が選んだ文（2026-10-09、案 B と C を合わせたもの）をそのまま留める。
    // どちらが古いかで言い分け、アプリが古いときだけ入れ替えを案内し、文の下に相手を調べる命令を添える。
    #[test]
    #[cfg(not(windows))]
    fn the_refusal_reads_as_chosen() {
        assert_eq!(
            refusal_message(4177, 0, 1),
            "4177 で動いている hangar のサーバが、この Hangar.app より古い版です（動いているサーバは版 0、この Hangar.app は版 1）。\n\
             そのサーバ（hangar start や npm run dev で起こしたもの）を止めてから「もう一度試す」を押してください。止めると、この Hangar.app が同梱のサーバを起こします。\n\
             動いているサーバは次で調べられます。\n\
             lsof -nP -iTCP:4177 -sTCP:LISTEN"
        );
        assert_eq!(
            refusal_message(4177, 2, 1),
            "この Hangar.app が、4177 で動いている hangar のサーバより古い版です（動いているサーバは版 2、この Hangar.app は版 1）。\n\
             Hangar.app を新しい版に入れ替えるか、そのサーバを止めてから「もう一度試す」を押してください。\n\
             動いているサーバは次で調べられます。\n\
             lsof -nP -iTCP:4177 -sTCP:LISTEN"
        );
    }

    // 相手を調べる命令は、渡されたポートで書く（4177 に決め打ちしない）。
    // lsof の無い Windows では命令を添えない。
    #[test]
    fn the_refusal_shows_how_to_find_the_server_on_the_given_port() {
        for (theirs, ours) in [(0, 1), (2, 1)] {
            let m = refusal_message(4390, theirs, ours);
            assert!(m.contains("4390 で動いている hangar のサーバ"), "{m}");
            assert!(!m.contains("4177"), "{m}");
            if cfg!(windows) {
                assert!(!m.contains("lsof"), "{m}");
            } else {
                assert!(
                    m.ends_with("\n動いているサーバは次で調べられます。\nlsof -nP -iTCP:4390 -sTCP:LISTEN"),
                    "{m}"
                );
            }
        }
    }
```

- [ ] **Step 2: 落ちるのを見る**

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml the_refusal`
Expected: FAIL（`refusal_message` が無いのでビルドが通らない）。

- [ ] **Step 3: 文を書く（選んだ案：B と C を合わせたもの）**

`apps/desktop/src-tauri/src/lib.rs` の `start_server` の直前に足す。

```rust
/// 4177 で動いている既存のサーバを、互換の版が違うので採らなかったときの文（2026-10-09 に利用者が選んだ、案 B と C を合わせたもの）。
/// どちらが古いかで言い分け、文の下に、そのポートで待ち受けているプロセスを調べる命令を添える。
/// 殻はそのサーバを止めない。利用者が自分で起こしたもの（hangar start や npm run dev）かもしれないからである。
/// 止めてから「もう一度試す」を押せば、起動をやり直して同梱のサーバを起こす（`retry_boot`）。
fn refusal_message(port: u16, theirs: u64, ours: u64) -> String {
    let head = if theirs < ours {
        format!(
            "{port} で動いている hangar のサーバが、この Hangar.app より古い版です（動いているサーバは版 {theirs}、この Hangar.app は版 {ours}）。\n\
             そのサーバ（hangar start や npm run dev で起こしたもの）を止めてから「もう一度試す」を押してください。止めると、この Hangar.app が同梱のサーバを起こします。"
        )
    } else {
        format!(
            "この Hangar.app が、{port} で動いている hangar のサーバより古い版です（動いているサーバは版 {theirs}、この Hangar.app は版 {ours}）。\n\
             Hangar.app を新しい版に入れ替えるか、そのサーバを止めてから「もう一度試す」を押してください。"
        )
    };
    // lsof は macOS と Linux にしか無い。Windows の .app はまだ作っておらず確かめられる命令が無いので、そこでは添えない。
    if cfg!(windows) {
        head
    } else {
        format!("{head}\n動いているサーバは次で調べられます。\nlsof -nP -iTCP:{port} -sTCP:LISTEN")
    }
}
```

- [ ] **Step 4: 採るかを決めてから子を起こす**

`start_server` の説明と頭の `if health::probe_health(addr) { … }` を、次に置き換える。

```rust
/// 同梱サーバを起こす。成功したら `Ok(())`。
/// 既に 4177 で互換の版の合う hangar が動いていれば、子は起こさずそれを使う。
/// 版の合わない hangar が動いていれば、採らずに理由を返す（そのサーバは止めない）。
fn start_server(
    app: &AppHandle,
    hangar_home: &std::path::Path,
    addr: SocketAddr,
) -> Result<(), String> {
    match health::probe_existing(addr, health::COMPAT_VERSION) {
        health::Existing::Adopt => {
            // hangar start などで既にサーバがいる。子は起こさず、そのサーバを使う。
            log("adopting the server already listening on 4177");
            return Ok(());
        }
        health::Existing::Mismatch { theirs } => {
            log(&format!(
                "refusing the server on 4177 (compat {theirs}, ours {})",
                health::COMPAT_VERSION
            ));
            return Err(refusal_message(addr.port(), theirs, health::COMPAT_VERSION));
        }
        health::Existing::Absent => {}
    }
```

（その後ろの「読み取り専用の写しから走っていないか先に見る。」からは、いまのまま残す。）

`wait_for_ready` の説明の「進み具合を載せない古いサーバは、済んだものとして扱う（`health::boot_state`）。」の 1 行を消す。

- [ ] **Step 5: 通るのを見る**

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS。

- [ ] **Step 6: 書式と lint を見る**

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo-fmt fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 差分なし（出たら `--check` を外して整える）。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo-clippy clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: 警告なし。
`health::probe_health` は `wait_for_server`（自分で起こした子を待つ）がまだ使うので、使われていない警告は出ない。

- [ ] **Step 7: コミットする**

```bash
git add apps/desktop/src-tauri/src/lib.rs
```

```bash
git commit -m "feat(desktop): refuse an existing server of another compat version and say why" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 古いサーバと古い殻のための言い分けを片付ける

**Files:**
- Modify: `packages/cli/src/probe.ts`（`probeReady`）
- Modify: `packages/cli/src/probe.test.ts`（`describe('probeReady', …)`）
- Modify: `packages/ui/src/runtime/notifier.ts`（`createDesktopNotifier` の説明）
- Modify: `packages/ui/src/runtime/notifier.test.ts`（「許可の状態は殻が OS から読んで返す…」の試験）
- Modify: `packages/server/src/http/app.ts`（`/health` のコメント）
- Modify: `packages/server/src/http/app.test.ts`（`/health` の試験の前のコメント）

**Interfaces:**
- Consumes: Task 3 の `boot_state` の読み方（`ready` が真偽値でなければ読まない）。
- Produces: `probeReady(port, timeoutMs?)` は `/health` が 200 で `ok === true` かつ `ready === true` のときだけ真。ほかの振る舞いは変えない。

- [ ] **Step 1: 試験を書く**

`packages/cli/src/probe.test.ts` の `describe('probeReady', …)` の試験を、次に置き換える。

```ts
  it('ok と ready がともに真のときだけ真。ready が無い、偽、ok が無い、200 でない、JSON でない、誰も居ないときは偽', async () => {
    const cases: [body: string, status: number, want: boolean][] = [
      ['{"ok":true,"ready":true}', 200, true],
      // ready を持たない応答は、済んだものとみなさない。hangar start が待つのは自分で起こした同じ束のサーバで、ready は必ずある。
      ['{"ok":true}', 200, false],
      ['{"ok":true,"ready":"yes"}', 200, false],
      ['{"ok":true,"ready":false}', 200, false],
      ['{"ready":true}', 200, false],
      ['{"ok":true,"ready":true}', 500, false],
      ['not json', 200, false],
    ];
    for (const [body, status, want] of cases) {
      const { port } = await listen(() => ({ status, body }));
      expect(await probeReady(port), `${status} ${body}`).toBe(want);
    }
    expect(await probeReady(await deadPort(), 500)).toBe(false);
  });
```

`packages/ui/src/runtime/notifier.test.ts` の「許可の状態は殻が OS から読んで返す。読めなければまだ決まっていないとみなす」の試験の、「古い殻（命令が無い）や、知らない答えのときは…」のコメントと次の 2 行を、次に置き換える（振る舞いは変えず、理由の言い方だけを替える）。

```ts
    // 殻の命令が失敗したとき（権限で断られた、殻が答えない）や、知らない答えのときは、これまでどおり出せるとみなす。
    const failing = createDesktopNotifier({ __TAURI_INTERNALS__: { invoke: vi.fn(async () => { throw new Error('not allowed'); }) }, document: doc(true, true) });
    await expect(failing.status()).resolves.toBe('undetermined');
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/cli/src/probe.test.ts`
Expected: FAIL（`{"ok":true}` と `{"ok":true,"ready":"yes"}` で真が返る）。

- [ ] **Step 3: 実装する**

`packages/cli/src/probe.ts` の `probeReady` の説明の「`ready` を持たない応答は、済んだものとみなす（.app の health.rs の boot_state と同じ扱い）。」を、次に置き換える。

```ts
 * `ready` が真のときだけ済んだとみなす。`hangar start` が待つのは自分で起こした同じ束のサーバで、`ready` は必ずある（.app の health.rs の boot_state も、`ready` の無い応答を読まない）。
```

本体の `return body.ok === true && body.ready !== false;` を `return body.ok === true && body.ready === true;` にする。

`packages/ui/src/runtime/notifier.ts` の `createDesktopNotifier` の説明の「古い殻（命令が無い）や知らない答えのときは、まだ決まっていないとみなし、これまでどおり出せるものとして扱う。」を、次に置き換える。

```ts
 * 殻の命令が失敗したとき（権限で断られた、殻が答えない）と知らない答えのときは、まだ決まっていないとみなし、これまでどおり出せるものとして扱う。
```

`packages/server/src/http/app.ts` の `/health` の上のコメントの「compat は互換の版番号で、殻が 4177 の既存のサーバを採る前に照合する（照合は段 1 の PR 7 で入れる）。」を、次に置き換える。

```ts
  // compat は互換の版番号で、殻は 4177 の既存のサーバを、自分と同じ版のときだけ採る（apps/desktop/src-tauri/src/health.rs の judge_existing）。
```

`packages/server/src/http/app.test.ts` の `/health` の試験の前のコメントの「compat は互換の版番号で、殻が既存のサーバを採る前に自分の同梱するサーバの版と比べる（段 1 の PR 7）。」を、次の 2 行に置き換える。

```ts
  // compat は互換の版番号で、殻は既存のサーバを、自分と同じ版のときだけ採る（health.rs の judge_existing）。外すと版 0 と読まれ、.app はそのサーバを採らない。
  // ready を外すと、.app はそのサーバを応答の無いものとして扱い、起動画面で待ったまま諦める（health.rs の boot_state）。
```

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/cli/src/probe.test.ts packages/cli/src/start.test.ts packages/ui/src/runtime/notifier.test.ts packages/server/src/http/app.test.ts`
Expected: PASS（`start.test.ts` の偽のサーバは `{"ok":true,"ready":true}` を返すので、`hangar start` の試験は崩れない）。

- [ ] **Step 5: 古い版のための言い分けが残っていないかを見る**

Run: `git grep -n "古い殻\|ready を持たない古い\|進み具合を載せない\|済んだものとして扱う\|済んだものとみなす" -- apps packages docs/design.md`
Expected: `packages/server/src/http/app.ts` の `AppDeps` の `ready` の説明（「渡さなければ済んだものとして扱う」）だけが出る。
これは試験がサーバを組むときの道具の既定で、古い版のための分岐ではないので残す。
`docs/design.md` の通知の節の「古い殻」は Task 6 で直すので、この時点では出てよい。

Run: `git grep -n "古いサーバは送らない"`
Expected: `packages/shared/src/api.ts` の `pausedReason` の注記と、過去の計画（`docs/superpowers/plans/2026-10-02-cloud-usage.md`）だけが出る。
`pausedReason` は端末の見張りの止めた理由で、段 1 の PR 5（または PR 6 の Task 10）の範囲なので、この PR では触らない。

- [ ] **Step 6: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 7: コミットする**

```bash
git add packages/cli/src/probe.ts packages/cli/src/probe.test.ts packages/ui/src/runtime/notifier.ts packages/ui/src/runtime/notifier.test.ts packages/server/src/http/app.ts packages/server/src/http/app.test.ts
```

```bash
git commit -m "refactor: stop treating ready-less servers as ready and drop the old-shell wording" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 設計書を直し、全体を確かめ、3 つのビルドを通す

**Files:**
- Modify: `docs/design.md`（「プロセスと通信」、「通知」の 1 行、「互換の版番号」、「決めた前提と未決事項」の「二重起動」）

**Interfaces:**
- Consumes: Task 2 から Task 5 で入れた名前と振る舞い。
- Produces: なし（文書と確かめだけ）。

- [ ] **Step 1: 設計書を直す**

`docs/design.md` を次のとおり直す。

「### プロセスと通信」の「起動時に 4177 で既にサーバが応答していれば、そのサーバを採用して子プロセスを起こさない。」を、次に置き換える。

```markdown
起動時に 4177 で既にサーバが応答していれば、互換の版が殻と同じときだけ、そのサーバを採用して子プロセスを起こさない。
版が違えば採らず、そのサーバも止めずに、読み込み画面に理由を出す（「互換の版番号」）。
```

通知の節の「古い殻（`notify_status` が無い）や `.app` の外では、まだ決まっていないとみなし、これまでどおり受け取るのままにする。」を、次に置き換える。

```markdown
`notify_status` が失敗したとき（権限で断られた、殻が答えない）や `.app` の外では、まだ決まっていないとみなし、これまでどおり受け取るのままにする。
```

「### 互換の版番号」の最後の段落「殻が 4177 の既存のサーバを採る前に、その `/health` の版を自分が同梱するサーバの版と比べる照合は、まだ入れていない（段 1 の PR 7）。」を、次に置き換える。

```markdown
**殻と既存のサーバ。**
殻は、同梱するサーバと同じ版を `apps/desktop/src-tauri/src/health.rs` の `COMPAT_VERSION` で名乗る。
正本は shared の `COMPAT_VERSION` で、`apps/desktop/test/config.test.ts` が Rust の原本を読んで突き合わせる。
同梱の `manifest.json` から読まないのは、既存のサーバを探る前に同梱のサーバの置き場を読めなければならなくなるからである。
殻とその同梱のサーバは同じコミットから同じ束で作るので、写しを試験で縛れば足りる。
殻は 4177 の既存のサーバを採る前に `/health` を 1 回読み、`compat`（無ければ版 0）が自分の版と等しいときだけ採る（`judge_existing`）。
比べ方は下限ではなく一致である。
版の違うサーバの UI を出すと、殻とサーバの合図（起動の進み具合、殻の命令）が食い違っても気付けない。
版が違えば採らず、読み込み画面に、どちらが古いかと、動いているサーバの版と殻の版を出す。
サーバが古いときは、そのサーバを止めてから「もう一度試す」を押すことを言う（止めれば、殻が同梱のサーバを起こす）。
殻が古いときは、Hangar.app を入れ替えるか、そのサーバを止めてから「もう一度試す」を押すことを言う。
文の下に、そのポートで待ち受けているプロセスを調べる命令（`lsof -nP -iTCP:4177 -sTCP:LISTEN`）を添える。
lsof の無い Windows では添えない（Windows の .app はまだ無い）。
文は殻の `refusal_message` が作る。
殻はそのサーバを止めない。
利用者が自分で起こしたもの（`hangar start` や `npm run dev`）かもしれず、ポートの番号だけを頼りに止めないためである。
hangar でない相手（`ok` が真で `version` が文字列の応答でないもの）は、版を問わずに「居ない」とし、これまでどおり同梱のサーバを起こしにいく。
殻が採るのは同じ版のサーバだけなので、`/health` の `ready` を持たない古いサーバを済んだものとみなす分岐は持たない。
`ready` が真偽値でない応答は起動の進み具合として読まず、応答の無いサーバとして扱う。
```

同じ節の「**いつ上げるか。**」の箇条書きの「殻とサーバの合図（`/health` の形、起動と停止のやりとり）。」を、次に置き換える。

```markdown
- 殻とサーバの合図（`/health` の形、起動と停止のやりとり、UI が呼ぶ殻の命令とその答えの形）。
```

「## 決めた前提と未決事項」の「二重起動：single-instance のプラグインを入れない。起動時に 4177 が既に応答していれば、そのサーバを採用して子プロセスを起こさない。ブラウザや `hangar start` で先に起きているサーバと食い合わないためである。」の「起動時に 4177 が既に応答していれば、そのサーバを採用して子プロセスを起こさない。」を、「起動時に 4177 で互換の版の同じ hangar が既に応答していれば、そのサーバを採用して子プロセスを起こさない。」にする。

- [ ] **Step 2: 設計書の書き方を確かめる**

Run: `git diff -U0 docs/design.md | perl -CSD -ne 'BEGIN { $a = chr(0x30FB); $b = chr(0x2014) } $n++ if /^\+/ && /$a|$b/; END { print $n + 0, "\n" }'`
Expected: `0`。

- [ ] **Step 3: Rust の試験と検査を通す**

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo-fmt fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 差分なし。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo-clippy clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: 警告なし。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" /opt/homebrew/bin/cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS。

- [ ] **Step 4: 型と試験を全部通す**

Run: `npm run typecheck`
Expected: エラーなし。

Run: `npm test`
Expected: すべて PASS。

- [ ] **Step 5: 読み込み画面の文を撮る**

選んだ案の文が読み込み画面で崩れないことを、自分の目で見る（4177 にも `/Applications` のアプリにも触らない）。
読み込み画面の置き場を手元の静的サーバで配り、WebKit で開いて、失敗の文を流し込んで撮る。

Run（裏で動かす）: `python3 -m http.server 4391 --bind 127.0.0.1 --directory apps/desktop/loading`

playwright の WebKit で `http://127.0.0.1:4391/index.html` を 1400×900 で開き、次を評価してから撮る（`<文>` は `refusal_message(4177, 0, 1)` と `refusal_message(4177, 2, 1)` の出力で、両方を撮る。文字列は Task 4 の `the_refusal_reads_as_chosen` に書いたものそのままである）。

```js
const s = document.getElementById('status');
s.textContent = `<文>`;
s.dataset.level = 'error';
```

文が枠の中で折り返し、ロゴと文がまとめて真ん中に寄り、「もう一度試す」と「ログを開く」が文の下に出ていることを見る。
撮り終えたら、裏で動かした静的サーバを自分の PID で止める（ポートの番号で止めない）。

- [ ] **Step 6: UI とパッケージをビルドする**

Run: `npm run build`
Expected: 成功する。

- [ ] **Step 7: 同梱のサーバを束ねる**

Run: `npm run bundle-server -w apps/desktop`
Expected: 成功する。

- [ ] **Step 8: デスクトップのアプリをビルドする**

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" npm run tauri -w apps/desktop -- build`
Expected: 成功し、.app ができる。

- [ ] **Step 9: コミットする**

```bash
git add docs/design.md
```

```bash
git commit -m "docs(design): describe how the shell checks the compat version before adopting a server" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: PR を出し、CI を待ってマージし、アプリを入れ替える**

開発の流れ（CLAUDE.local.md）の 5 と 6 のとおりに進める。
入れ替えた後、4177 を持っているプロセスのパスが `/Applications/Hangar.app/...` であることを確かめる（同じ版のサーバを殻が自分で起こしたことになる）。

---

### Task 7: 実物の .app で、版の合わないサーバを採らない画面を見る（利用者に聞いてから）

このタスクは、利用者が使っている Hangar.app を一度閉じ、4177 に立て替えのサーバを置くので、利用者に聞いてから行う。
許されなければ、報告に「実物の .app での不一致の画面は未確認（試験と読み込み画面の撮影で代えた）」と書く。

**Files:** なし。

**Interfaces:**
- Consumes: Task 6 で入れ替えた `/Applications/Hangar.app`。
- Produces: なし（確かめだけ）。

- [ ] **Step 1: 利用者に聞く**

AskUserQuestion で 1 問だけ聞く。
推す案を先頭に置く。

- 問い：「実物の Hangar.app で、版の違うサーバを採らない画面を確かめますか。Hangar.app を 1 分ほど閉じ、4177 に版 0 を名乗る立て替えのサーバを置きます（tmux のセッションは止まりません）」
- 選択肢：「見送る（試験と読み込み画面の撮影で足りる）（推す）」「確かめる」

- [ ] **Step 2: 確かめる（許されたら）**

1. `osascript -e 'tell application "Hangar" to quit'` で閉じ、`pgrep -fl 'Hangar.app/Contents/MacOS'` で残っていないことを見る。
2. 4177 に、版 0 の古いサーバの真似を置く（裏で動かし、PID を控える）。

   Run（裏で動かす）: `node -e "require('node:http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ ok: true, version: '0.0.0-stand-in' })); }).listen(4177, '127.0.0.1')"`

3. `open /Applications/Hangar.app` で開き、読み込み画面に選んだ案の文と「もう一度試す」が出ることを、画面を撮って見る。
4. 控えた PID で立て替えのサーバを止め、読み込み画面の「もう一度試す」は押さずに、`osascript -e 'tell application "Hangar" to quit'` で閉じてから `open /Applications/Hangar.app` で開き直す。
5. 4177 を持っているプロセスのパスが `/Applications/Hangar.app/...` に戻ったことを確かめる。

報告には、入れたもの、確かめたこと（cargo の試験と検査、型、試験、読み込み画面の撮影、3 つのビルド）、確かめていないもの（実物の .app での不一致の画面を見送ったなら、そのこと）を分けて書く。
