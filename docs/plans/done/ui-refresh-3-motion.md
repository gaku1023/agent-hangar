# UI 刷新 3 回目 実装計画（セッション画面、動き、起動画面）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 動きを「なめらか」の性格のトークンに揃え、セッション画面の上段とチップ、端末の縁の灯、フォルダの耳のタブを入れ、一覧の行がセッション画面の上段へ広がる決めの動きと、ハンガーが流れ続ける起動画面を作る。

**Architecture:** 長さと曲線は `styles/tokens.css` のトークンだけに置き、JS からは `views/primitives/motion.ts` で読む。画面の移り変わりは、Runtime に「状態を画面へ出す受け口」（`present`）を足し、`runtime/present.ts` が画面の替わり目とパレットの閉じ目だけを View Transitions で包んで、React の描画を `flushSync` で同期させる。起動画面は依存を持たない 1 枚の HTML のまま、動きの計算を `loading/boot-frames.js` に、描画を `loading/boot.js` に置き、殻（`lib.rs`）は周の境目まで待ってから画面を移す。

**Tech Stack:** React 19、Vite 8、vitest 5（`ui` の `node` と `dom` の子プロジェクト、`desktop`）、@testing-library/react 16、TypeScript 6、Tauri 2.11（Rust）、Node 22。

**Spec:** `docs/superpowers/specs/2026-09-29-ui-refresh-design.md`（「端末の板と縁の灯」、「起動画面」、「セッション画面」、「4 動き」。試作は `docs/superpowers/specs/2026-09-29-ui-refresh/2-5-assets-screens-motion-tests.html` の 3-b と 4、`boot-animation.html` の `ENTRY.pendulum` と `frameOf`）

## Global Constraints

- この回で扱うのは、仕様の「届け方」の 3 回目（端末の縁の灯、フォルダの耳のタブ、動きのトークンと動きの一覧、行が広がる動き、起動画面）と、決めの動きの着地点になるセッション画面の上段とチップの列だけである。
- 仕様の「過去のセッションは、端末の板の場所に会話を広げ、右に要約、TODO、変更を置く」は、この回では扱わない。セッション単位の TODO と変更の一覧のデータが無いためで、Task 8 で仕様の範囲外へ移す。
- 動きのトークンは仕様の値そのものにする。`--dur-fast: 200ms`、`--dur: 420ms`、`--dur-exit: 250ms`、`--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`、`--ease-in: cubic-bezier(0.4, 0, 1, 1)`、`--rise: 6px`、`--blur-in: 6px`、端末の縁の往復は `--breathe-period: 3.2s`。`--dur-slow`、`--dur-pop`、`--ease` は消す。
- 長さは必ずトークンを通して書き、CSS にも JS にも数値を直書きしない。JS は `views/primitives/motion.ts` の `motionMs`、`motionValue`、`motionEase` で読む。
- reduced motion では、長さと移動とぼかしのトークンが 0 になり、背景の光と端末の縁の往復が止まり、View Transitions を使わず、起動画面は静止した原図にする。
- 常にライトで、ダークモードは持たない。`prefers-color-scheme` と `data-theme` を書かない。
- ぼかし（`backdrop-filter`）は `.sidebar`、`.header`、`.conn-banner`、`.dialog`、`.palette`、`.toast` の規則にだけ書く（`styles/glass.test.ts` が見張る）。現れる動きのぼかしは `filter: blur(var(--blur-in))` で書き、`backdrop-filter` は足さない。
- 脈動は端末の縁の作業中だけに許す。`@keyframes pulse`、`shimmer`、`skeleton` と `text-shadow` は書かない（`styles/tokens.test.ts` が見張る）。
- 本文の色は白地で 4.5 : 1 以上、注記の色（`--ink-3`）は 3 : 1 以上。状態の色（`--busy`、`--idle`、`--waiting`、`--ended`）とプロジェクトのステータスの色（`--st-*`）は変えない。
- アイコンは Lucide の 16px、線幅 1.5 のまま。`views/primitives/Icon.tsx` だけを通す。
- キー操作（`j`、`k`、`Enter`、`o`、`e`、`m`、⌘1 から ⌘9、⌘W、⌘\、⌘J、⌘K、⌘[、⌘]）は変えない。
- `palette.css` の `.field-row {`、`.dialog-promote .btn { white-space: nowrap; }`、`.dialog-promote .dialog-foot { flex-wrap: wrap;` の文字列は試験が見ているので、そのまま残す。
- サーバ（`packages/server`）、共有の型（`packages/shared`）、サーバの CSP、`apps/desktop/src-tauri/capabilities/*.json` はこの計画では変えない。
- ポート番号でプロセスを止めない。止めてよいのは、ビルドの後に、`apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` から起きたプロセス（パスを `ps -o command= -p <PID>` で確かめたもの）と、LISTEN している利用者の dev サーバ 1 つだけ（`lsof -nP -iTCP:4177 -sTCP:LISTEN -t` で PID を採り、`ps -o command= -p <PID>` で `packages/server` の tsx のサーバだと確かめてから）。`osascript` やアプリ名での終了は使わない。`/Applications` の下には触らない。Vite（5173）には触らない。
- 手元での `tauri build` は、この計画では Task 9 の 1 回だけとする。`cargo check` と `cargo test` は回数を制限しない。
- ビルドは `/Applications/Hangar.app` を置き換えない。入れ替えは利用者に確かめてから行う。
- テストは実物の `~/.agent-hangar` と `~/.claude` に触れない。実物の外部サービス（Cloudflare、本番の Worker と D1 と R2、GitHub）に触れない。`git push` をしない。
- 日本語の文書は一文ごとに改行し、地の文でダッシュと中黒を使わない。コードのコメントは周りの書き方に合わせる。
- コミットメッセージは英語の Conventional Commits で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` をそのまま付ける（どのモデルが書いても同じ文字列）。`git add` の後の素の `git commit` ではなく、`git commit <path>...` のパス指定形で入れる（新しいファイルだけは直前に `git add <そのパス>`）。`--amend` と rebase は使わない。パッケージ管理は npm。

## Review Focus

- **⌘K を押してすぐ打った文字が落ちる。** パレットの入力欄は開いたその描画でフォーカスを持ち、動きの最中でも打った文字が入るべきである。パレットは View Transitions を使わずに Web Animations で開くので、描画は遅れない。Task 3 の試験で、動きを流しても入力欄にフォーカスがあることを固定する。
- **Sessions の検索欄で 1 文字打つたびに画面の移り変わりが走り、打鍵が引っかかる。** 検索語はハッシュの `q` に載るが、画面は替わっていないので包むべきではない。Task 6 の試験で、`sessions` の `q` だけが変わるときは包まないことを固定する。
- **同じセッションが実行中の札と最近の行の両方にあると、同じ名前が 2 つ付いて遷移ごと捨てられる。** 名前は押した 1 つにだけ付けるべきである。Task 6 の試験で固定する。
- **素早く続けて移る（Enter で開いた直後に ⌘[ で戻る）と、古い画面で止まるか、名前が残る。** 描き替えは最後の状態に追いつき、名前は必ず外れ、割り込まれた遷移の拒否は外へ漏れないべきである。Task 6 の Runtime と present の試験で固定する。
- **サーバがすぐ応える（前の起動のサーバが生きている）とき、または読み込み画面の load より先に health が通るときに、起動が詰まるか長く待つ。** 待つのは周の境目までで、1 周期より長くは待たず、load の合図が無ければ待たないべきである。Task 7 の Rust の試験で固定する。

---

## 作るファイルと変えるファイル

| ファイル | 役目 | Task |
|---|---|---|
| `packages/ui/src/styles/tokens.css` | 動きのトークンの置き換え、`--term-lift` | 1、5 |
| `packages/ui/src/styles/base.css`、`workbench.css`、`split.css`、`rows.css`、`home.css`、`palette.css` | 古いトークンの置き換えと、直書きの長さの除去 | 1 |
| `packages/ui/src/views/primitives/motion.ts`（新）と `motion.test.ts`（新） | JS から動きのトークンを読む | 1 |
| `packages/ui/src/test/motion.ts`（新） | 試験で動きのトークンの値を差し込む | 1 |
| `packages/ui/src/views/primitives/flip.ts`、`RollingNumber.tsx` | 直書きの長さをトークンへ | 1 |
| `packages/ui/src/styles/motion.test.ts`（新）、`tokens.test.ts` | 動きのトークンの決まり | 1 |
| `packages/ui/src/styles/base.css` | 画面、ダイアログ、通知、切断の帯の現れ方 | 2 |
| `packages/ui/src/views/primitives/StatusDot.tsx` と `StatusDot.test.tsx`（新） | 状態が変わる瞬間に 1 度だけ膨らむ | 2 |
| `packages/ui/src/views/primitives/flip.ts` と `flip.test.tsx`（新） | 新しいカードがぼかしから現れる | 2 |
| `packages/ui/src/views/CommandPalette.tsx`、`styles/palette.css`、`views/overlays.test.tsx` | パレットが検索欄の錠剤から開く | 3 |
| `packages/ui/src/presenters/session.ts`、`presenters/presenters.test.ts` | 状態と経過の札、変更数 | 4 |
| `packages/ui/src/views/SessionScreen.tsx`、`styles/session.css`（新）、`main.tsx`、`views/SessionScreen.test.tsx` | セッション画面の上段とチップの列 | 4 |
| `packages/ui/src/views/TerminalPane.tsx`、`views/TerminalPane.test.tsx`、`views/SessionScreen.tsx` | 端末の縁の灯の印 | 5 |
| `packages/ui/src/styles/base.css`、`split.css`、`styles/terminal.test.ts`（新） | 縁の灯とフォルダの耳 | 5 |
| `packages/ui/src/runtime/present.ts`（新）と `present.test.ts`（新） | 画面の移り変わりと、行が広がる動き | 6 |
| `packages/ui/src/runtime/focusSoon.ts`（新）と `focusSoon.test.ts`（新） | 描き替えが遅れてもフォーカスを落とさない | 6 |
| `packages/ui/src/runtime/runtime.ts`、`runtime/runtime.test.ts` | `present` の受け口 | 6 |
| `packages/ui/src/main.tsx` | `present` と `focusSoon` をつなぐ | 6 |
| `packages/ui/src/views/SessionRows.tsx`、`HomeScreen.tsx`、`SessionRows.test.tsx`、`screens.test.tsx` | 広がる元の印（`data-morph-id`） | 6 |
| `packages/ui/src/styles/base.css`、`styles/motion.test.ts` | View Transitions の長さと曲線 | 6 |
| `apps/desktop/loading/boot-frames.js`（新）、`boot.js`（新）、`index.html` | 起動画面の動き | 7 |
| `apps/desktop/test/boot.test.ts`（新）、`test/config.test.ts` | その試験 | 7 |
| `apps/desktop/src-tauri/src/lib.rs` | 周の境目まで待ってから画面を移す | 7 |
| `docs/design.md`、`docs/superpowers/specs/2026-09-29-ui-refresh-design.md` | セッション詳細、見た目と動きの書き換え | 8 |

---

### Task 1: 動きのトークン

**Files:**
- Modify: `packages/ui/src/styles/tokens.css`（末尾の動きのトークンと reduced motion の節）
- Modify: `packages/ui/src/styles/base.css`、`workbench.css`、`split.css`、`rows.css`、`home.css`、`palette.css`
- Modify: `packages/ui/src/views/primitives/flip.ts`、`packages/ui/src/views/primitives/RollingNumber.tsx`
- Create: `packages/ui/src/views/primitives/motion.ts`、`packages/ui/src/views/primitives/motion.test.ts`、`packages/ui/src/test/motion.ts`、`packages/ui/src/styles/motion.test.ts`
- Modify: `packages/ui/src/styles/tokens.test.ts`

**Interfaces:**
- Produces: `type DurationToken = '--dur-fast' | '--dur' | '--dur-exit'`、`type MotionToken = DurationToken | '--ease-out' | '--ease-in' | '--rise' | '--blur-in'`、`motionValue(token: MotionToken, el?: Element): string`、`parseDuration(v: string): number`、`motionMs(token: DurationToken, el?: Element): number`、`motionEase(token: '--ease-out' | '--ease-in', el?: Element): string`（`views/primitives/motion.ts`）。Task 2、3 が使う。
- Produces: 試験用の `fakeMotionTokens(values?: Record<string, string>): () => void`（`src/test/motion.ts`）。`document.documentElement` の計算済みの値だけを差し替え、返した関数で元に戻す。Task 2、3 の試験が使う。
- Produces: CSS のトークン `--dur-fast`、`--dur`、`--dur-exit`、`--ease-out`、`--ease-in`、`--rise`、`--blur-in`、`--breathe-period`。

- [ ] **Step 1: 動きのトークンの決まりの、失敗する試験を書く**

`packages/ui/src/styles/motion.test.ts` を作る。

```ts
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const sheets = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
const tokens = read('tokens.css');
/** 宣言を（名前、値）の組で取り出す。 */
const decls = (css: string) => [...strip(css).matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)].map((m) => ({ prop: m[1]!, value: m[2]!.trim() }));
/** :root に書いたトークンの値。reduced motion の節より前にある最初の定義を読む。 */
const value = (t: string) => tokens.match(new RegExp(`${t}:\\s*([^;]+);`))?.[1]?.trim();

describe('動きのトークン', () => {
  // 性格は「なめらか」。すっと出て、長く静かに止まる（仕様の「4 動き」）。
  it('仕様の値を持つ', () => {
    expect(value('--dur-fast')).toBe('200ms');
    expect(value('--dur')).toBe('420ms');
    expect(value('--dur-exit')).toBe('250ms');
    expect(value('--ease-out')).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(value('--ease-in')).toBe('cubic-bezier(0.4, 0, 1, 1)');
    expect(value('--rise')).toBe('6px');
    expect(value('--blur-in')).toBe('6px');
    expect(value('--breathe-period')).toBe('3.2s');
  });
  it('reduced motion では、長さと移動とぼかしが 0 になる', () => {
    const block = strip(tokens).match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/)?.[1] ?? '';
    for (const t of ['--dur-fast', '--dur', '--dur-exit']) expect(block, t).toMatch(new RegExp(`${t}: 0ms;`));
    for (const t of ['--rise', '--blur-in']) expect(block, t).toMatch(new RegExp(`${t}: 0px;`));
  });
  it('古いトークンの名前は、定義にも参照にも残さない', () => {
    for (const f of sheets) {
      const css = strip(read(f));
      for (const old of ['--dur-slow', '--dur-pop', 'var(--ease)', '--ease:']) expect(css, `${f}: ${old}`).not.toContain(old);
    }
  });
  it('transition と animation の長さは、トークンを通して書く', () => {
    for (const f of sheets.filter((f) => f !== 'tokens.css')) {
      for (const d of decls(read(f)).filter((d) => /^(transition|animation)(-duration|-delay)?$/.test(d.prop))) {
        expect(d.value, `${f}: ${d.prop}: ${d.value}`).not.toMatch(/(^|[\s,(])\d+(\.\d+)?m?s\b/);
      }
    }
  });
});

describe('JS の動き', () => {
  const src = (p: string) => fs.readFileSync(new URL(`../views/primitives/${p}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  it('FLIP の滑りは、長さと曲線をトークンで書く', () => {
    expect(src('flip.ts')).toContain("'transform var(--dur) var(--ease-out)'");
    expect(src('flip.ts')).not.toMatch(/\d+ms/);
  });
  it('数字の回転は、長さを --dur から読む', () => {
    expect(src('RollingNumber.tsx')).toContain("motionMs('--dur')");
    expect(src('RollingNumber.tsx')).not.toMatch(/setTimeout\([^)]*,\s*\d+\)/);
  });
});
```

`packages/ui/src/views/primitives/motion.test.ts` を作る。

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { fakeMotionTokens } from '../../test/motion.ts';
import { motionEase, motionMs, motionValue, parseDuration } from './motion.ts';

describe('parseDuration', () => {
  it('ミリ秒と秒の書き方を、ミリ秒の数にする', () => {
    expect(parseDuration('420ms')).toBe(420);
    expect(parseDuration(' 0.25s ')).toBe(250);
    expect(parseDuration('3.2s')).toBe(3200);
    expect(parseDuration('0ms')).toBe(0);
  });
  it('読めない値は 0 にして、動かさない側へ倒す', () => {
    for (const bad of ['', 'var(--dur)', '420', 'fast', '-1ms']) expect(parseDuration(bad), bad).toBe(0);
  });
});

describe('motion のトークン', () => {
  let restore = () => {};
  afterEach(() => restore());
  it('ルートの計算済みの値を読む', () => {
    restore = fakeMotionTokens({ '--dur': '420ms', '--ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)', '--rise': '6px' });
    expect(motionMs('--dur')).toBe(420);
    expect(motionValue('--rise')).toBe('6px');
    expect(motionEase('--ease-out')).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
  });
  // Web Animations は空の曲線を渡すと例外を投げる。トークンが読めない環境でも落とさない。
  it('トークンが読めなければ、長さは 0、曲線は linear', () => {
    restore = fakeMotionTokens({});
    expect(motionMs('--dur-exit')).toBe(0);
    expect(motionEase('--ease-in')).toBe('linear');
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/styles/motion.test.ts packages/ui/src/views/primitives/motion.test.ts`
Expected: FAIL。`motion.ts` と `test/motion.ts` が無いことと、トークンの値が違うこと（`--dur` が `150ms`）で落ちる。

- [ ] **Step 3: トークンを置き換える**

`packages/ui/src/styles/tokens.css` の末尾の、`--aura-period: 24s;` から最後までを次に置き換える。

```css
  --aura-period: 24s;
  /* 動きのトークン。性格は「なめらか」で、すっと出て長く静かに止まる。
     長さは必ずこれを通して書き、CSS にも JS にも数値を直書きしない（styles/motion.test.ts が見張る）。
     JS からは views/primitives/motion.ts で読む。 */
  --dur-fast: 200ms;
  --dur: 420ms;
  --dur-exit: 250ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  /* 現れるときの縦の移動と、晴れていくぼかし。 */
  --rise: 6px;
  --blur-in: 6px;
  /* 端末の縁が、作業中にゆっくり明暗を往復する周期。 */
  --breathe-period: 3.2s;
}

@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 0ms; --dur: 0ms; --dur-exit: 0ms; --rise: 0px; --blur-in: 0px; }
}
```

`packages/ui/src/styles/tokens.test.ts` の「必要なトークンをライトで定義する」の配列にある `'--dur', '--dur-pop', '--ease',` を、次に置き換える。

```ts
'--dur-fast', '--dur', '--dur-exit', '--ease-out', '--ease-in', '--rise', '--blur-in', '--breathe-period',
```

同じファイルの `describe('base.css', ...)` の中身を、次に置き換える。

```ts
describe('base.css', () => {
  it('ダイアログは --dur の長さと --ease-out の曲線で開く', () => {
    expect(base).toMatch(/\.dialog \{[^}]*animation: pop var\(--dur\) var\(--ease-out\)/);
  });
});
```

- [ ] **Step 4: CSS の参照を置き換える**

曲線はまとめて置き換える。

```bash
cd packages/ui/src/styles
sed -i '' 's/var(--ease)/var(--ease-out)/g' base.css workbench.css split.css home.css
```

長さは、1 つずつ次のとおりに直す（どれも `var(--ease-out)` に直した後の文字列）。

| ファイル | 今 | 直した後 |
|---|---|---|
| `base.css` の `.screen` | `animation: fade var(--dur-fast) var(--ease-out);` | `animation: fade var(--dur) var(--ease-out);` |
| `base.css` の `.conn-banner` | `animation: drop-in var(--dur-slow) var(--ease-out);` | `animation: drop-in var(--dur) var(--ease-out);` |
| `base.css` の `.dialog` | `animation: pop var(--dur-pop) var(--ease-out);` | `animation: pop var(--dur) var(--ease-out);` |
| `base.css` の `.toast` | `animation: slide var(--dur-slow) var(--ease-out);` | `animation: slide var(--dur) var(--ease-out);` |
| `base.css` の `.split` | `transition: grid-template-columns var(--dur-slow) var(--ease-out);` | `transition: grid-template-columns var(--dur) var(--ease-out);` |
| `base.css` の `.swipe-hint[data-done='true']` | `transition: opacity var(--dur-slow) var(--ease-out);` | `transition: opacity var(--dur-exit) var(--ease-in);` |
| `workbench.css` の `.gauge-fill` | `transition: width var(--dur-slow) var(--ease-out), background var(--dur) var(--ease-out);` | `transition: width var(--dur) var(--ease-out), background var(--dur) var(--ease-out);` |
| `rows.css` の `.memo-pencil` | `transition: opacity 180ms ease;` | `transition: opacity var(--dur-fast) var(--ease-out);` |

`palette.css` の先頭のコメントの `（--dur-pop）` を `（--dur）` に直す。

ホバーと押下を仕様に揃える。
`base.css` の `.btn:active { transform: scale(0.98); }` の 1 行を、次の 2 行に置き換える。

```css
.btn:hover:not(:disabled) { transform: translateY(-1px); }
.btn:active:not(:disabled) { transform: scale(0.97); }
```

- [ ] **Step 5: JS から読む口を作り、直書きを消す**

`packages/ui/src/views/primitives/motion.ts` を作る。

```ts
/**
 * 動きのトークン（styles/tokens.css）を JS から読む。
 * 長さと曲線は CSS と同じ値を使い、JS に数値を直書きしない。
 * reduced motion では tokens.css が長さを 0 にするので、ここも 0 を返す。
 */
export type DurationToken = '--dur-fast' | '--dur' | '--dur-exit';
export type MotionToken = DurationToken | '--ease-out' | '--ease-in' | '--rise' | '--blur-in';

/** トークンの計算済みの値。読めなければ空文字。 */
export function motionValue(token: MotionToken, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(token).trim();
}

/** 「420ms」「0.25s」をミリ秒の数にする。読めない値は 0 にし、動かさない側へ倒す。 */
export function parseDuration(v: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(v.trim());
  if (!m) return 0;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

export function motionMs(token: DurationToken, el?: Element): number {
  return parseDuration(motionValue(token, el));
}

/** 曲線。Web Animations は空の曲線で例外を投げるので、読めなければ linear にする。 */
export function motionEase(token: '--ease-out' | '--ease-in', el?: Element): string {
  return motionValue(token, el) || 'linear';
}
```

`packages/ui/src/test/motion.ts` を作る。

```ts
import { vi } from 'vitest';

/**
 * 試験の中で、ルート（document.documentElement）の動きのトークンの値を差し込む。
 * jsdom は tokens.css を読まないので、計算済みの値を直に返す。
 * ほかの要素の getComputedStyle は本物のままにする（testing-library が見え方の判断に使う）。
 * 返した関数で元に戻す。
 */
export function fakeMotionTokens(values: Record<string, string> = { '--dur-fast': '200ms', '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)', '--ease-in': 'cubic-bezier(0.4, 0, 1, 1)', '--rise': '6px', '--blur-in': '6px' }): () => void {
  const real = window.getComputedStyle.bind(window);
  const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => (el === document.documentElement ? ({ getPropertyValue: (n: string) => values[n] ?? '' } as CSSStyleDeclaration) : real(el, pseudo)));
  return () => spy.mockRestore();
}
```

`packages/ui/src/views/primitives/flip.ts` の `el.style.transition = 'transform var(--dur) var(--ease)';` を `el.style.transition = 'transform var(--dur) var(--ease-out)';` に直す。

`packages/ui/src/views/primitives/RollingNumber.tsx` を次のように直す。
先頭に `import { motionMs } from './motion.ts';` を足す。
コメントの `新しい値を下から上へ 150 ミリ秒で動かす。` を `新しい値を下から上へ --dur の長さで動かす。` に直す。
`const t = setTimeout(() => { setPrev(props.value); setRolling(false); }, 150);` を次に直す。

```ts
    const t = setTimeout(() => { setPrev(props.value); setRolling(false); }, motionMs('--dur'));
```

- [ ] **Step 6: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui`
Expected: PASS。
`motion.test.ts` の `motion のトークン` は `views/primitives` の下なので dom の子プロジェクトで走る。
ほかの試験が `150` ミリ秒を前提に落ちたら、その試験の待ち時間を `fakeMotionTokens` で `--dur` を差し込む形に直す（数を緩めて通さない）。

- [ ] **Step 7: 型検査**

Run: `npm run typecheck --workspace packages/ui`
Expected: 0 件。

- [ ] **Step 8: コミット**

```bash
git add packages/ui/src/views/primitives/motion.ts packages/ui/src/views/primitives/motion.test.ts packages/ui/src/test/motion.ts packages/ui/src/styles/motion.test.ts
git commit packages/ui/src/styles packages/ui/src/views/primitives packages/ui/src/test/motion.ts -m "feat(ui): move every motion onto the smooth-character tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 現れる動き（画面、ダイアログ、通知、切断の帯、状態点、新しいカード）

**Files:**
- Modify: `packages/ui/src/styles/base.css`（`.screen`、`@keyframes fade`、`drop-in`、`pop`、`slide`）
- Modify: `packages/ui/src/views/primitives/StatusDot.tsx`
- Create: `packages/ui/src/views/primitives/StatusDot.test.tsx`
- Modify: `packages/ui/src/views/primitives/flip.ts`
- Create: `packages/ui/src/views/primitives/flip.test.tsx`
- Modify: `packages/ui/src/styles/motion.test.ts`（現れ方の試験を足す）

**Interfaces:**
- Consumes: `motionMs`、`motionValue`、`motionEase`（Task 1）、`fakeMotionTokens`（Task 1）。
- Produces: CSS の `@keyframes enter`（`.screen` が使う）。Task 6 の View Transitions は、入る画面の動きをこれに任せる。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/styles/motion.test.ts` の末尾に足す。

```ts
describe('現れる動き', () => {
  const base = strip(read('base.css'));
  const keyframes = (name: string) => base.match(new RegExp(`@keyframes ${name} \\{ from \\{([^}]*)\\} \\}`))?.[1] ?? '';
  // 現れるものは、ぼかしが晴れながら来る。
  it.each([
    ['.screen', 'enter'],
    ['.dialog', 'pop'],
    ['.toast', 'slide'],
    ['.conn-banner', 'drop-in'],
  ])('%s は %s で、--dur と --ease-out で、ぼかしが晴れながら現れる', (selector, name) => {
    expect(base).toMatch(new RegExp(`${selector.replace('.', '\\.')} \\{[^}]*animation: ${name} var\\(--dur\\) var\\(--ease-out\\);`));
    expect(keyframes(name)).toContain('opacity: 0;');
    expect(keyframes(name)).toContain('filter: blur(var(--blur-in));');
  });
  it('画面は --rise だけ上がって入り、ダイアログは 96% から開く', () => {
    expect(keyframes('enter')).toContain('transform: translateY(var(--rise));');
    expect(keyframes('pop')).toContain('transform: scale(0.96);');
  });
});
```

`packages/ui/src/views/primitives/StatusDot.test.tsx` を作る。

```tsx
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMotionTokens } from '../../test/motion.ts';
import { StatusDot } from './StatusDot.tsx';

describe('StatusDot', () => {
  let restore = () => {};
  const animate = vi.fn();
  beforeEach(() => { restore = fakeMotionTokens(); (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate; });
  afterEach(() => { restore(); animate.mockReset(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

  it('状態が変わる瞬間に 1 度だけ膨らむ。最初の描画と、同じ状態の描き直しでは膨らまない', () => {
    const { rerender, container } = render(<StatusDot status="busy" />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<StatusDot status="busy" />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<StatusDot status="waiting" />);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(container.querySelector('.dot'));
    expect(animate.mock.calls[0]![1]).toEqual({ duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    rerender(<StatusDot status={null} />);
    expect(animate).toHaveBeenCalledTimes(2);
  });
});
```

`packages/ui/src/views/primitives/flip.test.tsx` を作る。

```tsx
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMotionTokens } from '../../test/motion.ts';
import { useFlip } from './flip.ts';

function Cards(props: { keys: string[] }) {
  const ref = useFlip(props.keys);
  return <div>{props.keys.map((k) => <div key={k} data-k={k} ref={ref(k)} />)}</div>;
}

describe('useFlip', () => {
  let restore = () => {};
  const animate = vi.fn();
  beforeEach(() => { restore = fakeMotionTokens(); (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate; });
  afterEach(() => { restore(); animate.mockReset(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

  it('新しく入った札だけが、ぼかしから現れる。最初の描画では動かさない', () => {
    const { rerender, container } = render(<Cards keys={['a', 'b']} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<Cards keys={['a', 'b', 'c']} />);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(container.querySelector('[data-k="c"]'));
    const [frames, opts] = animate.mock.calls[0]!;
    expect(frames[0]).toEqual({ opacity: 0, transform: 'translateY(6px)', filter: 'blur(6px)' });
    expect(opts).toEqual({ duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/styles/motion.test.ts packages/ui/src/views/primitives`
Expected: FAIL。`enter` の keyframes が無いこと、`animate` が呼ばれないことで落ちる。

- [ ] **Step 3: CSS の現れ方を書く**

`packages/ui/src/styles/base.css` の次の 2 行を、

```css
.screen { animation: fade var(--dur) var(--ease-out); }

@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
```

次に置き換える。

```css
/* 現れるものは、ぼかしが晴れながら --rise だけ上がって来る。
   View Transitions がある環境では、出る画面との重ね合わせは runtime/present.ts が受け持ち、入る画面の動きはここが受け持つ。 */
.screen { animation: enter var(--dur) var(--ease-out); }

@keyframes enter { from { opacity: 0; transform: translateY(var(--rise)); filter: blur(var(--blur-in)); } }
```

同じファイルの keyframes を 3 つ置き換える。

```css
@keyframes drop-in { from { opacity: 0; transform: translateY(calc(var(--rise) * -1)); filter: blur(var(--blur-in)); } }
```

```css
@keyframes pop { from { opacity: 0; transform: scale(0.96); filter: blur(var(--blur-in)); } }
```

```css
@keyframes slide { from { opacity: 0; transform: translateX(16px); filter: blur(var(--blur-in)); } }
```

- [ ] **Step 4: 状態点が膨らむようにする**

`packages/ui/src/views/primitives/StatusDot.tsx` を次に置き換える。

```tsx
import { useEffect, useRef } from 'react';
import type { LiveStatus } from '@agent-hangar/shared';
import { motionEase, motionMs } from './motion.ts';

const LABEL: Record<LiveStatus, string> = { busy: '作業中', idle: '待機', waiting: '入力待ち' };

/** 状態の点。状態が変わる瞬間に 1 度だけ小さく膨らむ。最初の描画では膨らまない。 */
export function StatusDot(props: { status: LiveStatus | null; title?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(props.status);
  useEffect(() => {
    if (prev.current === props.status) return;
    prev.current = props.status;
    const el = ref.current;
    // jsdom のように Web Animations を持たない環境では、色の遷移だけにする。
    if (el && typeof el.animate === 'function') el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: motionMs('--dur'), easing: motionEase('--ease-out') });
  }, [props.status]);
  return <span ref={ref} className="dot" data-status={props.status ?? 'ended'} title={props.title ?? (props.status ? LABEL[props.status] : '終了')} aria-label={props.status ? LABEL[props.status] : '終了'} />;
}
```

- [ ] **Step 5: 新しいカードがぼかしから現れるようにする**

`packages/ui/src/views/primitives/flip.ts` を次に置き換える。

```ts
import { useLayoutEffect, useRef } from 'react';
import { motionEase, motionMs, motionValue } from './motion.ts';

/**
 * 並びが変わったカードを元の位置から現在位置へ滑らせる（FLIP）。
 * 新しく入ったカードは、ぼかしが晴れながら現れる。
 * 最初の描画では全部が新しいので、画面の入る動き（.screen の enter）に任せて動かさない。
 * 返した関数を ref に渡すと、その要素の位置を毎回の描画で覚える。
 */
export function useFlip(keys: string[]): (key: string) => (el: HTMLElement | null) => void {
  const nodes = useRef(new Map<string, HTMLElement>());
  const prev = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    // 先に全部の現在位置を測る。測る前に transform を入れると値がずれる。
    const now = new Map<string, DOMRect>();
    for (const [key, el] of nodes.current) now.set(key, el.getBoundingClientRect());
    for (const [key, el] of nodes.current) {
      const before = prev.current.get(key);
      const after = now.get(key);
      if (!after) continue;
      if (!before) {
        if (prev.current.size > 0 && typeof el.animate === 'function') {
          el.animate([{ opacity: 0, transform: `translateY(${motionValue('--rise')})`, filter: `blur(${motionValue('--blur-in')})` }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: motionMs('--dur'), easing: motionEase('--ease-out') });
        }
        continue;
      }
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (dx === 0 && dy === 0) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => { el.style.transition = 'transform var(--dur) var(--ease-out)'; el.style.transform = ''; });
    }
    prev.current = now;
  }, [keys.join('|')]);
  return (key) => (el) => { if (el) nodes.current.set(key, el); else nodes.current.delete(key); };
}
```

- [ ] **Step 6: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui`
Expected: PASS。

- [ ] **Step 7: 型検査とコミット**

Run: `npm run typecheck --workspace packages/ui`
Expected: 0 件。

```bash
git add packages/ui/src/views/primitives/StatusDot.test.tsx packages/ui/src/views/primitives/flip.test.tsx
git commit packages/ui/src/styles/base.css packages/ui/src/styles/motion.test.ts packages/ui/src/views/primitives -m "feat(ui): let screens, dialogs and toasts arrive out of a clearing blur

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: パレットが検索欄の錠剤から開く

**Files:**
- Modify: `packages/ui/src/views/CommandPalette.tsx`
- Modify: `packages/ui/src/styles/palette.css`（`.palette` と先頭のコメント）
- Modify: `packages/ui/src/views/overlays.test.tsx`（`describe('CommandPalette')` に足す）

**Interfaces:**
- Consumes: `motionMs`、`motionEase`（Task 1）、`fakeMotionTokens`（Task 1）。ヘッダの検索欄の `id="global-search"`（`views/Header.tsx`、変えない）。
- Produces: パレットの器の `.palette` クラス（変えない）。Task 6 は閉じるときにこの器と `#global-search` を組にする。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/views/overlays.test.tsx` の先頭の import に `afterEach` がなければ足し、`import { fakeMotionTokens } from '../test/motion.ts';` を足す。
`describe('CommandPalette', ...)` の中に足す。

```tsx
  describe('開く動き', () => {
    let restore = () => {};
    const animate = vi.fn();
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    beforeEach(() => {
      restore = fakeMotionTokens();
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        if (this.id === 'global-search') return rect(100, 10, 200, 30);
        if (this.classList.contains('palette')) return rect(200, 60, 400, 120);
        return rect(0, 0, 0, 0);
      });
    });
    afterEach(() => { restore(); animate.mockReset(); vi.restoreAllMocks(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; document.getElementById('global-search')?.remove(); });

    it('ヘッダの検索欄の錠剤から広がって開き、入力欄はその描画でフォーカスを持つ', () => {
      const pill = document.createElement('input');
      pill.id = 'global-search';
      document.body.append(pill);
      render(<IntentRoot onIntent={() => {}}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animate.mock.contexts[0]).toBe(document.querySelector('.palette'));
      const [frames, opts] = animate.mock.calls[0]!;
      expect(frames).toEqual([{ transform: 'translate(-100px, -50px) scale(0.5, 0.25)', opacity: 0.4 }, { transform: 'none', opacity: 1 }]);
      expect(opts).toEqual({ duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
      expect(document.activeElement).toBe(screen.getByLabelText('コマンドを検索'));
    });
    it('検索欄が無ければ、その場でふわりと現れる', () => {
      render(<IntentRoot onIntent={() => {}}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
      expect(animate.mock.calls[0]![0]).toEqual([{ transform: 'scale(0.96)', opacity: 0.4 }, { transform: 'none', opacity: 1 }]);
    });
  });
```

`beforeEach` が import に無ければ足す。

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/overlays.test.tsx`
Expected: FAIL。`animate` が呼ばれない。

- [ ] **Step 3: 開く動きを書く**

`packages/ui/src/views/CommandPalette.tsx` を直す。
import を `import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';` にし、`import { motionEase, motionMs } from './primitives/motion.ts';` を足す。
`const input = useRef<HTMLInputElement>(null);` の次に足す。

```tsx
  const box = useRef<HTMLDivElement>(null);
  // 開くときは、ヘッダの検索欄の錠剤からガラスが広がる。
  // 閉じて錠剤へ戻る動きは、器が消えた後なので runtime/present.ts が View Transitions で受け持つ。
  // 描画を遅らせない Web Animations で開くので、入力欄はこの描画でフォーカスを持ち、打った文字を落とさない。
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof el.animate !== 'function') return;
    const a = el.getBoundingClientRect();
    const pill = document.getElementById('global-search')?.getBoundingClientRect();
    const from = pill && a.width > 0 && a.height > 0
      ? `translate(${pill.left - a.left}px, ${pill.top - a.top}px) scale(${pill.width / a.width}, ${pill.height / a.height})`
      : 'scale(0.96)';
    el.animate([{ transform: from, opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: motionMs('--dur'), easing: motionEase('--ease-out') });
  }, []);
```

器の `<div className="dialog palette" ...>` に `ref={box}` を足す。

- [ ] **Step 4: CSS を直す**

`packages/ui/src/styles/palette.css` の先頭のコメント 3 行を、次に置き換える。

```css
/* パレットは .dialog の器をそのまま使い、ガラスだけを少し濃く、ぼかしを強くする。
   開く動きは CommandPalette.tsx が、ヘッダの検索欄の錠剤から広げる。.dialog の pop は使わない。
   広げる計算は左上を原点にするので、transform-origin を 0 0 にする。
   一覧を縁まで敷き詰めたいので、内側の余白と段の隙間だけを外す。 */
```

`.palette` の規則の末尾（`backdrop-filter: var(--glass-blur-strong);` の後）に `transform-origin: 0 0; animation: none;` を足す。

- [ ] **Step 5: 試験と型検査**

Run: `npx vitest run packages/ui && npm run typecheck --workspace packages/ui`
Expected: PASS、0 件。

- [ ] **Step 6: コミット**

```bash
git commit packages/ui/src/views/CommandPalette.tsx packages/ui/src/styles/palette.css packages/ui/src/views/overlays.test.tsx -m "feat(ui): open the command palette out of the header's search pill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: セッション画面の上段とチップの列

**Files:**
- Modify: `packages/ui/src/presenters/session.ts`（`SessionProps`、`presentSession`）
- Modify: `packages/ui/src/presenters/presenters.test.ts`
- Modify: `packages/ui/src/views/SessionScreen.tsx`（`header` と `summary`）
- Create: `packages/ui/src/styles/session.css`
- Modify: `packages/ui/src/main.tsx`（CSS の import）
- Modify: `packages/ui/src/views/SessionScreen.test.tsx`

**Interfaces:**
- Produces: `SessionProps.liveLabel: string | null`（実行中なら「作業中 12 分」のような状態と経過、そうでなければ `null`）と `SessionProps.filesChanged: number`。
- Produces: セッション画面の上段の要素 `<div className="session-hero" data-morph-hero={id}>`。Task 6 がこの印を行の広がる先にする。

- [ ] **Step 1: Presenter の、失敗する試験を書く**

`packages/ui/src/presenters/presenters.test.ts` の `presentSession` の試験の並び（`describe` の中、`遡って足したページも` の前）に足す。

```ts
  it('実行中なら状態と経過の札を作り、変更数を渡す', () => {
    const store = storeWith();
    expect(presentSession(initialState(), store, NOW, 's1')).toMatchObject({ liveLabel: '作業中 2 時間', filesChanged: 1 });
    expect(presentSession(initialState(), store, NOW, 's2').liveLabel).toBeNull();
    store.sessions.s1 = { ...store.sessions.s1!, live: 'waiting' };
    expect(presentSession(initialState(), store, NOW, 's1').liveLabel).toBe('入力待ち 2 時間');
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/presenters.test.ts`
Expected: FAIL。`liveLabel` が無い。

- [ ] **Step 3: Presenter を直す**

`packages/ui/src/presenters/session.ts` を直す。
format の import に `durationLabel` を足す。
`SessionProps` の型の末尾（`canResumeHere: boolean` の後）に `; liveLabel: string | null; filesChanged: number` を足す。
`SUBAGENT_TOOLS` の定義の前に足す。

```ts
/** チップの状態の言い方。Home の札（休み、入力待ち）と揃える。 */
const LIVE_WORD: Record<LiveStatus, string> = { busy: '作業中', idle: '休み', waiting: '入力待ち' };
```

`presentSession` の `base` の末尾（`canResumeHere: false` の後）に `, liveLabel: null, filesChanged: 0` を足す。
return の中の `contextPercent: s.stats.contextPercent, cost: costLabel(s.stats.costUsd),` の行を、次に置き換える。

```ts
    contextPercent: s.stats.contextPercent, cost: costLabel(s.stats.costUsd), filesChanged: s.stats.filesChanged,
    liveLabel: s.live ? `${LIVE_WORD[s.live]} ${durationLabel(now - (s.startedAt ?? now))}` : null,
```

`packages/ui/src/views/SessionScreen.test.tsx` の `base` の末尾（`canResumeHere: false` の後）に `, liveLabel: '作業中 12 分', filesChanged: 3` を足す。

- [ ] **Step 4: 画面の、失敗する試験を書く**

`packages/ui/src/views/SessionScreen.test.tsx` の `describe('SessionScreen', ...)` に足す。

```tsx
  it('上段に状態の点、名前、要約の 1 文、操作を置き、その下にチップを並べる', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} memo="スワイプは実機で" cost="$1.82" terminalStatus={null} /></IntentRoot>);
    const hero = container.querySelector('.session-hero')!;
    expect(hero.getAttribute('data-morph-hero')).toBe('s1');
    expect(hero.querySelector('.dot')).not.toBeNull();
    expect(hero.querySelector('h1.session-name')).toHaveTextContent('name');
    expect(hero.querySelector('.session-oneliner')).toHaveTextContent('ONE');
    expect(hero.querySelector('button')).not.toBeNull();
    const chips = [...container.querySelectorAll('.chips > .chip')].map((c) => c.textContent);
    expect(chips).toEqual(['作業中 12 分', 'alpha', 'fable 5.1 · high', 'コンテキスト 未取得', '$1.82', '変更 3', 'メモ：スワイプは実機で']);
    // 要約の 1 文は上段にだけ出し、下の要約の帯には重ねない。
    expect(screen.getAllByText('ONE')).toHaveLength(1);
  });
  it('細かな事実はチップの下に注記で並べる', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} terminalStatus={null} /></IntentRoot>);
    const facts = container.querySelector('.session-facts')!;
    expect(facts).toHaveTextContent('/w/alpha');
    expect(facts).toHaveTextContent('2 ターン');
    expect(facts).toHaveTextContent('1.2M tokens');
    expect(facts).toHaveTextContent('開始 2 時間前');
  });
```

- [ ] **Step 5: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/SessionScreen.test.tsx`
Expected: FAIL。`.session-hero` が無い。

- [ ] **Step 6: 上段とチップを書く**

`packages/ui/src/views/SessionScreen.tsx` の `const header = (` から、その閉じの `);` までを次に置き換える。

```tsx
  const header = (
    <>
      {/* 上段。一覧の行や Home の札から開くと、その行がここへ広がる（runtime/present.ts が data-morph-hero を探す）。 */}
      <div className="session-hero" data-morph-hero={id}>
        <StatusDot status={props.live} />
        <h1 className="session-name">{props.name}</h1>
        {props.summary?.oneLiner ? <span className="session-oneliner">{props.summary.oneLiner}</span> : <span className="spacer" />}
        {props.fromScratch && <span className="faint">再開すると cwd はスクラッチのままです</span>}
        {props.canPromote && <button className="btn" onClick={() => emit({ type: 'session.promote.open', id })}><Icon name="promote" />プロジェクトに昇格</button>}
        {run?.alive && <button className="btn" onClick={() => emit({ type: 'session.openTerminalApp', runId: run.id, tabId: props.selectedTab ?? undefined })}><Icon name="openTerminal" />ターミナルで開く</button>}
        {run?.alive && <button className="btn" onClick={() => emit({ type: 'session.kill', runId: run.id })}><Icon name="stop" />停止</button>}
        <button className="btn" disabled={!props.canResume} onClick={() => emit({ type: 'session.resume', id })}><Icon name="resume" />再開</button>
        <button className="btn" disabled={!props.canFork} onClick={() => emit({ type: 'session.fork', id })}><Icon name="fork" />フォーク</button>
        {/* 本文が他端末にあるときと、相手の heartbeat が途絶えたとき（Ruling 14）の逃げ道。
            出す条件は canResumeHere 単独にする。lock の有無で枝分かれさせると、途絶えた側が行き止まりになる。 */}
        {props.canResumeHere && <button className="btn" onClick={() => emit({ type: 'session.resumeHere', id })}><Icon name="resumeHere" />この PC で再開</button>}
        <button className="btn" onClick={() => emit({ type: 'session.openEditor', sessionId: id })}><Icon name="openEditor" />VS Code で開く</button>
      </div>
      {/* チップの列。状態と経過、プロジェクト、モデルと effort、コンテキスト使用率、推定コスト、変更数、1 行メモ、PR、ロック。 */}
      <div className="chips">
        {props.liveLabel && <span className="chip">{props.liveLabel}</span>}
        {props.projectName && <a className="chip" href="#" onClick={(e) => { e.preventDefault(); if (props.projectId) emit({ type: 'project.open', id: props.projectId }); }}>{props.projectName}</a>}
        {props.model && <span className="chip mono">{props.model}{props.effort ? ` · ${props.effort}` : ''}</span>}
        {/* コンテキストの使用率と推定コストは statusline の追記からしか届かない。
            追記を入れていなければずっと null なので、空の棒ではなく「未取得」と書く。
            0% と見分けが付かない見せ方にしない。ヘッダーの使用量ゲージと言い方を揃える。 */}
        {props.contextPercent === null
          ? <span className="chip faint">コンテキスト 未取得</span>
          : (
            <span className="chip gauge-wrap" title="コンテキスト使用率">
              <span className="faint">コンテキスト</span>
              <span className="gauge-bar" role="meter" aria-label="コンテキスト使用率" aria-valuenow={props.contextPercent} aria-valuemin={0} aria-valuemax={100}>
                <span className="gauge-fill" data-high={props.contextPercent >= 80 ? 'true' : undefined} style={{ width: `${Math.max(0, Math.min(100, props.contextPercent))}%` }} />
              </span>
            </span>
          )}
        {props.cost ? <span className="chip mono">{props.cost}</span> : <span className="chip faint">コスト 未取得</span>}
        {props.contextPercent === null && !props.cost && <a className="hint-link" href={formatRoute({ name: 'settings' })} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: { name: 'settings' } }); }}>statusline を入れると出ます</a>}
        {props.filesChanged > 0 && <span className="chip">変更 {props.filesChanged}</span>}
        {props.memo && <span className="chip chip-memo">メモ：{props.memo}</span>}
        {props.prUrl && <a className="chip" href={props.prUrl} target="_blank" rel="noreferrer">PR</a>}
        {/* ロックの文言は presenter が lock.label に組み立てている（「<端末名> で実行中」「<端末名> が応答がありません」）。
            View は色だけを変え、最終確認の時刻を下の注記に添えてどれだけ途絶えているかを見せる。 */}
        {props.lock && <span className={`chip ${props.lock.stale ? 'warn' : 'lock'}`}>{props.lock.label}</span>}
      </div>
      {/* 細かな事実。判断の手がかりだが、チップほど目立たせない。 */}
      <div className="session-facts mono faint">
        <span>{props.cwd}</span><span>{props.turns} ターン</span><span>{props.tokens} tokens</span>
        <span>開始 {props.started}</span><span>最終 {props.lastActivity}</span>
        {run && <span>run {run.kind} {run.started}</span>}
        {props.lock && <span>最終確認 {props.lock.heartbeat}</span>}
        {props.remoteOnly && <span>本文は他の端末にあります</span>}
        {!props.hasTranscript && <span>本文がありません</span>}
      </div>
    </>
  );
```

同じファイルの `summary` の中の、`<><b>{props.summary.title}</b><span className="muted">{props.summary.oneLiner}</span><span className="faint">{props.summary.stateLabel}</span></>` を、`<><b>{props.summary.title}</b><span className="faint">{props.summary.stateLabel}</span></>` に直す（1 文は上段に移した）。

`packages/ui/src/styles/session.css` を作る。

```css
/* セッション画面の上段とチップの列（UI 刷新 3 回目）。 */

/* 上段。状態の点、名前、要約の 1 文、操作を 1 行に置く。
   窓が狭いときは要約の 1 文から縮め、名前と操作のボタンは縮めない。 */
.session-hero { display: flex; align-items: center; gap: calc(var(--u) * 2.5); min-width: 0; }
.session-hero .btn { flex: none; }
.session-name { flex: none; max-width: 40%; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-md); font-weight: 650; letter-spacing: -0.01em; }
.session-oneliner { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }

/* チップの列。小さな錠剤で並べ、入り切らなければ次の行へ送る。 */
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--u) * 1.5); margin: calc(var(--u) * 2) 0 var(--u); }
.chip { display: inline-flex; align-items: center; gap: var(--u); height: calc(var(--u) * 5); padding: 0 calc(var(--u) * 2); border-radius: var(--r-pill); font-size: var(--fs-xs); color: var(--ink-2); background: rgba(255, 255, 255, 0.75); box-shadow: inset 0 0 0 1px rgba(30, 40, 90, 0.06); white-space: nowrap; }
a.chip { color: var(--accent); text-decoration: none; }
.chip-memo { max-width: 40ch; overflow: hidden; text-overflow: ellipsis; }

/* 細かな事実（cwd、ターン、トークン、時刻、run）は、チップの下に注記の文字で並べる。 */
.session-facts { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 4); margin-bottom: calc(var(--u) * 2); font-size: var(--fs-xs); }
```

`packages/ui/src/main.tsx` の `import './styles/home.css';` の次に `import './styles/session.css';` を足す。

- [ ] **Step 7: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui`
Expected: PASS。
上段の作り替えで、ほかの試験（`SessionScreen.test.tsx` の「ヘッダー」や、`workbench.test.tsx`）が前の DOM の形（`h1.h1`、`.mono.faint` の行）を見ていて落ちたら、見ている中身（名前、ボタン、文言）が同じように出ていることを確かめる形に直す。
中身が消えていて落ちたのなら、試験ではなく画面を直す。

- [ ] **Step 8: 型検査とコミット**

Run: `npm run typecheck --workspace packages/ui`
Expected: 0 件。

```bash
git add packages/ui/src/styles/session.css
git commit packages/ui/src/presenters/session.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/SessionScreen.tsx packages/ui/src/views/SessionScreen.test.tsx packages/ui/src/styles/session.css packages/ui/src/main.tsx -m "feat(ui): give the session screen a top row and a strip of chips

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 端末の縁の灯と、フォルダの耳のタブ

**Files:**
- Modify: `packages/ui/src/views/TerminalPane.tsx`、`packages/ui/src/views/TerminalPane.test.tsx`
- Modify: `packages/ui/src/views/SessionScreen.tsx`（`pane` の中）
- Modify: `packages/ui/src/styles/tokens.css`（`--term-lift`）
- Modify: `packages/ui/src/styles/base.css`（`.tabs`、`.tab`、`.tab-selected`、`.term-pane`）
- Modify: `packages/ui/src/styles/split.css`（`.split-pane`）
- Create: `packages/ui/src/styles/terminal.test.ts`

**Interfaces:**
- Consumes: `--breathe-period`、`--dur`、`--dur-fast`、`--ease-out`（Task 1）。
- Produces: `TerminalPane` の必須の prop `live: LiveStatus | null`。`.term-pane` に `data-live="busy" | "idle" | "waiting" | "ended"` を付ける。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/styles/terminal.test.ts` を作る。

```ts
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** 入れ子の無い規則を、選択子と中身の組で取り出す。最初に見つかったもの（@media の外）を返す。 */
const body = (css: string, selector: string) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1]!.trim() === selector)?.[2] ?? '';
const base = read('base.css');

describe('端末の縁の灯', () => {
  it('作業中は杏の輪と光で、--breathe-period でゆっくり明暗を往復する', () => {
    const b = body(base, ".term-pane[data-live='busy']");
    expect(b).toContain('var(--busy)');
    expect(b).toMatch(/animation: rim-breathe var\(--breathe-period\) ease-in-out infinite;/);
  });
  it('入力待ちは赤の輪と光で、動かない', () => {
    const b = body(base, ".term-pane[data-live='waiting']");
    expect(b).toContain('var(--waiting)');
    expect(b).not.toContain('animation');
  });
  it('休みと終了は灯さず、板を持ち上げる影だけにする', () => {
    expect(body(base, ".term-pane[data-live='idle']")).toBe('');
    expect(body(base, ".term-pane[data-live='ended']")).toBe('');
    expect(body(base, '.term-pane')).toMatch(/box-shadow: var\(--term-lift\);/);
  });
  it('状態が変わると、縁の色が --dur で移る', () => {
    expect(body(base, '.term-pane')).toMatch(/transition: box-shadow var\(--dur\) var\(--ease-out\);/);
  });
  it('reduced motion では往復を止め、静止した輪だけを残す', () => {
    expect(strip(base)).toContain("@media (prefers-reduced-motion: reduce) { .term-pane[data-live='busy'] { animation: none; } }");
  });
  // 分割の枠が外側の光を切ると、左右の板の縁だけ光が欠ける。はみ出す中身は板（.term-pane）が自分で切っている。
  it('分割しても、板の外側の光を切らない', () => {
    expect(body(read('split.css'), '.split-pane')).toMatch(/overflow: visible;/);
  });
});

describe('フォルダの耳のタブ', () => {
  it('タブは上の角だけを丸めた耳で、帯と板の間に線も隙間も置かない', () => {
    expect(body(base, '.tab')).toMatch(/border-radius: var\(--r\) var\(--r\) 0 0;/);
    expect(body(base, '.tabs')).not.toMatch(/border-bottom|margin-bottom/);
  });
  it('選んだタブは板と同じ墨色になる', () => {
    const b = body(base, '.tab-selected, .tab-selected:hover');
    expect(b).toContain('background: var(--term-bg);');
    expect(b).toContain('color: var(--term-fg);');
  });
  it('耳の下の板は、左上だけを角張らせて耳とつなぐ。分割しているときは左の板をつなぐ', () => {
    expect(body(base, '.tabs + .split > .term-pane, .tabs + .split > .split-h > .split-pane:first-child > .term-pane')).toMatch(/border-top-left-radius: 0;/);
  });
});
```

`packages/ui/src/views/TerminalPane.test.tsx` の `describe('TerminalPane', ...)` に足す。

```tsx
  it('セッションの状態を縁の印にする。状態が無ければ終了として灯さない', () => {
    const host = fakeHost();
    const pane = (live: 'busy' | 'waiting' | 'idle' | null) => <TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" status="connected" hint={null} live={live} /></TerminalHostContext.Provider>;
    const { rerender, container } = render(pane('busy'));
    const mark = () => container.querySelector('.term-pane')!.getAttribute('data-live');
    expect(mark()).toBe('busy');
    rerender(pane('waiting'));
    expect(mark()).toBe('waiting');
    rerender(pane('idle'));
    expect(mark()).toBe('idle');
    rerender(pane(null));
    expect(mark()).toBe('ended');
  });
```

同じファイルのほかの `<TerminalPane ... />` にも `live={null}` を足す（必須の prop にするため）。

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/styles/terminal.test.ts packages/ui/src/views/TerminalPane.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 縁の印を付ける**

`packages/ui/src/views/TerminalPane.tsx` を直す。
先頭に `import type { LiveStatus } from '@agent-hangar/shared';` を足す。
props の型を `{ tabId: string; status: TerminalStatus | null; hint: string | null; live: LiveStatus | null }` にする。
`return (` の前の行に次のコメントを足し、

```tsx
  // 縁はそのセッションの状態で灯る（base.css の .term-pane[data-live]）。終わったセッションは灯さない。
```

`<div className="term-pane" data-testid={`term-${props.tabId}`}>` を次に直す。

```tsx
    <div className="term-pane" data-testid={`term-${props.tabId}`} data-live={props.live ?? 'ended'}>
```

`packages/ui/src/views/SessionScreen.tsx` の `pane` の中の `<TerminalPane key={tabId} tabId={tabId} status={props.terminalStatus} hint={hint} />` を `<TerminalPane key={tabId} tabId={tabId} status={props.terminalStatus} hint={hint} live={props.live} />` に直す。

- [ ] **Step 4: CSS を書く**

`packages/ui/src/styles/tokens.css` の `--surface-shadow: ...;` の次に足す。

```css
  /* 端末の板を持ち上げる影。縁の灯は、この上に輪と光を重ねる。 */
  --term-lift: 0 12px 26px -16px rgba(20, 20, 60, 0.55);
```

`packages/ui/src/styles/base.css` の `/* タブの帯とターミナルの器 */` の下の `.tabs`、`.tab`、`.tab:hover`、`.tab-selected` の 4 行を、次に置き換える（`.tab-close, .tab-add` の 2 行はそのまま残す）。

```css
/* タブは端末の板から生えたフォルダの耳。選んだタブは板と同じ墨色になり、板とつながる。
   帯と板の間には線も隙間も置かない。 */
.tabs { display: flex; align-items: flex-end; gap: 3px; height: var(--row-h); }
.tab { display: flex; align-items: center; gap: calc(var(--u) * 1.5); padding: 0 calc(var(--u) * 3); height: var(--row-h); border-radius: var(--r) var(--r) 0 0; background: rgba(255, 255, 255, 0.55); cursor: pointer; color: var(--ink-2); transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out); }
.tab:hover { background: rgba(255, 255, 255, 0.85); }
.tab-selected, .tab-selected:hover { color: var(--term-fg); background: var(--term-bg); }
```

`.tab-close, .tab-add` の 2 行の次に足す。

```css
.tab-selected .tab-close { color: var(--term-fg); }
.tab-selected .tab-close:hover { color: var(--term-fg); background: rgba(255, 255, 255, 0.12); }
```

`.term-pane` の規則を、次に置き換える（前のコメント 3 行は残す）。

```css
.term-pane { position: relative; isolation: isolate; display: flex; flex-direction: column; min-width: 0; background: var(--term-bg); border-radius: var(--r-lg); overflow: hidden; box-shadow: var(--term-lift); transition: box-shadow var(--dur) var(--ease-out); }
/* 縁の灯。そのセッションの状態で 1.5px の輪と、外側の淡い光を灯す。
   作業中だけ --breathe-period でゆっくり明暗を往復し、入力待ちは動かさない。休みと終了は灯さず、板を持ち上げる影だけにする。 */
.term-pane[data-live='busy'] { box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--busy) 90%, transparent), 0 0 22px -2px color-mix(in srgb, var(--busy) 45%, transparent), var(--term-lift); animation: rim-breathe var(--breathe-period) ease-in-out infinite; }
.term-pane[data-live='waiting'] { box-shadow: 0 0 0 1.5px var(--waiting), 0 0 22px -2px color-mix(in srgb, var(--waiting) 45%, transparent), var(--term-lift); }
@keyframes rim-breathe { 50% { box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--busy) 55%, transparent), 0 0 12px -4px color-mix(in srgb, var(--busy) 25%, transparent), var(--term-lift); } }
@media (prefers-reduced-motion: reduce) { .term-pane[data-live='busy'] { animation: none; } }
/* 耳の下の板は、左上だけを角張らせて耳とつなぐ。分割しているときは左の板をつなぐ。 */
.tabs + .split > .term-pane, .tabs + .split > .split-h > .split-pane:first-child > .term-pane { border-top-left-radius: 0; }
```

`packages/ui/src/styles/split.css` の `.split-pane { min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }` を、次に置き換える。

```css
/* 枠は外側の光（端末の縁の灯）を切らないように overflow を見せたままにする。はみ出す中身は、中の .term-pane が自分で切る。 */
.split-pane { min-width: 0; min-height: 0; overflow: visible; display: flex; flex-direction: column; }
```

- [ ] **Step 5: 試験と型検査**

Run: `npx vitest run packages/ui && npm run typecheck --workspace packages/ui`
Expected: PASS、0 件。
`glass.test.ts` の「`.term-pane` は重なりの文脈を作る」も通ることを確かめる（`.term-pane` の規則は 1 つのまま）。

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/styles/terminal.test.ts
git commit packages/ui/src/views/TerminalPane.tsx packages/ui/src/views/TerminalPane.test.tsx packages/ui/src/views/SessionScreen.tsx packages/ui/src/styles -m "feat(ui): light the terminal's rim by session state and grow tabs as folder ears

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 画面の移り変わりと、行がセッション画面へ広がる動き

**Files:**
- Create: `packages/ui/src/runtime/present.ts`、`packages/ui/src/runtime/present.test.ts`
- Create: `packages/ui/src/runtime/focusSoon.ts`、`packages/ui/src/runtime/focusSoon.test.ts`
- Modify: `packages/ui/src/runtime/runtime.ts`（`RuntimeDeps`、`dispatch`、`getState`、`start`）
- Modify: `packages/ui/src/runtime/runtime.test.ts`（`harness` に 2 つ目の引数と、試験 2 つ）
- Modify: `packages/ui/src/main.tsx`
- Modify: `packages/ui/src/views/SessionRows.tsx`、`packages/ui/src/views/HomeScreen.tsx`
- Modify: `packages/ui/src/views/SessionRows.test.tsx`、`packages/ui/src/views/screens.test.tsx`
- Modify: `packages/ui/src/styles/base.css`、`packages/ui/src/styles/motion.test.ts`

**Interfaces:**
- Consumes: `data-morph-hero`（Task 4 の上段）、`.palette`（Task 3）、`#global-search`（`Header.tsx`）、`State`、`Screen`（`mediator/types.ts`）。
- Produces: `RuntimeDeps.present?: (commit: () => void, prev: State, next: State) => void`。Runtime は状態を先に進め、`commit` が呼ばれるまで `getState()` は前に描いた状態を返す。
- Produces: `createPresent(env: PresentEnv): (commit: () => void, prev: State, next: State) => void`、`type PresentEnv`、`SESSION_MORPH = 'session-morph'`、`PALETTE_MORPH = 'palette-morph'`（`runtime/present.ts`）。
- Produces: `focusSoon(find: () => HTMLElement | null, nextFrame: (cb: () => void) => void, tries?: number): void`、`FOCUS_TRIES = 10`（`runtime/focusSoon.ts`）。
- Produces: 広がる元の印 `data-morph-id={セッションの id}`（`SessionRows` の行と、Home の実行中の札）。

- [ ] **Step 1: Runtime の、失敗する試験を書く**

`packages/ui/src/runtime/runtime.test.ts` の `harness` の引数を `function harness(overrides: Partial<ApiClient> = {}, extra: Partial<RuntimeDeps> = {})` にし、`const deps: RuntimeDeps = { ... };` の中身の末尾（`onWindowFocus: ...,` の後）に `...extra,` を足す。
import に `import type { State } from '../mediator/types.ts';` を足す。
`describe('createRuntime', ...)` に足す。

```ts
  it('present があれば、commit を呼ぶまで getState は前に描いた状態を返す', async () => {
    const calls: { commit: () => void; prev: State; next: State }[] = [];
    const { rt, wsHandlers, setHash } = harness({}, { present: (commit, prev, next) => { calls.push({ commit, prev, next }); } });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    // 起動からここまでの変化も present を通る。先に出しておく。
    for (const c of calls.splice(0)) c.commit();
    expect(rt.getState().screen).toEqual({ name: 'home' });
    setHash('#/projects');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prev.screen).toEqual({ name: 'home' });
    expect(calls[0]!.next.screen).toEqual({ name: 'projects' });
    expect(rt.getState().screen).toEqual({ name: 'home' });
    const seen = vi.fn();
    rt.subscribe(seen);
    calls[0]!.commit();
    expect(rt.getState().screen).toEqual({ name: 'projects' });
    expect(seen).toHaveBeenCalledTimes(1);
    // 同じ変化を 2 度出しても、描き直しは増えない。
    calls[0]!.commit();
    expect(seen).toHaveBeenCalledTimes(1);
  });
  it('commit の前に次の変化が来ても、commit で最後の状態に追いつく', async () => {
    const commits: (() => void)[] = [];
    const { rt, wsHandlers, setHash } = harness({}, { present: (commit) => { commits.push(commit); } });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/projects');
    setHash('#/settings');
    commits[0]!();
    expect(rt.getState().screen).toEqual({ name: 'settings' });
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/runtime/runtime.test.ts`
Expected: FAIL。`present` が呼ばれない。

- [ ] **Step 3: Runtime に受け口を足す**

`packages/ui/src/runtime/runtime.ts` を直す。
`RuntimeDeps` の末尾（`onWindowFocus?: ...;` の後）に足す。

```ts
  /**
   * 状態の変化を画面へ出す。
   * commit を呼ぶまで、getState は前に描いた状態を返し、React はそれを描き続ける。
   * 画面の移り変わりを View Transitions で包むための口である（runtime/present.ts）。無ければその場で出す。
   */
  present?: (commit: () => void, prev: State, next: State) => void;
```

`let state = initialState();` の次に足す。

```ts
  // React が読む状態。present が commit を呼ぶまで、前に描いた state のままでいる。
  // 遷移の計算は常に最新の state で行い、描く側だけを遅らせる。
  let shown = state;
```

`const notify = ...` の次に足す。

```ts
  const commit = () => { if (shown !== state) { shown = state; notify(); } };
  const present = deps.present ?? ((c: () => void) => c());
```

`dispatch` の中の `if (r.state !== state) { state = r.state; notify(); }` を、次に置き換える。

```ts
    if (r.state !== state) { const prev = shown; state = r.state; present(commit, prev, state); }
```

返す object の `getState: () => state,` を `getState: () => shown,` に直す。
`start()` の中の `state = { ...state, sessionView: sv };` の次に `shown = state;` を足す。

Run: `npx vitest run packages/ui/src/runtime/runtime.test.ts`
Expected: PASS。

- [ ] **Step 4: present と focusSoon の、失敗する試験を書く**

`packages/ui/src/runtime/present.test.ts` を作る。
runtime の下の試験は node の子プロジェクトで走るので、先頭の 1 行で jsdom を選ぶ。

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { createPresent, PALETTE_MORPH, SESSION_MORPH, type PresentEnv } from './present.ts';

const at = (screen: State['screen'], overlay: State['overlay'] = { kind: 'none' }): State => ({ ...initialState(), screen, overlay });
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
// jsdom は view-transition-name を知らないので、付けていない要素では undefined が返る。空文字にそろえて読む。
const name = (sel: string) => $(sel).style.viewTransitionName || '';
const flush = () => new Promise((r) => setTimeout(r, 0));

/** View Transitions の偽物。本物は写しを取ってから非同期に update を呼ぶので、呼ぶ時を試験が決める。 */
function fake(over: Partial<PresentEnv> = {}) {
  const updates: (() => void)[] = [];
  let settle: { ok: () => void; ng: (e: unknown) => void } | null = null;
  const start = vi.fn((update: () => void) => {
    updates.push(update);
    const finished = new Promise<void>((ok, ng) => { settle = { ok: () => ok(), ng }; });
    return { ready: finished, finished };
  });
  const env: PresentEnv = { startViewTransition: start, reducedMotion: () => false, flushSync: (fn) => fn(), root: document, pressed: () => null, focused: () => null, ...over };
  return { env, start, run: () => updates.shift()!(), finish: () => settle!.ok(), skip: () => settle!.ng(new DOMException('skipped', 'AbortError')) };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('createPresent', () => {
  it('画面が替わらず、パレットも閉じないなら、包まずにその場で描く', () => {
    const f = fake();
    const commit = vi.fn();
    createPresent(f.env)(commit, at({ name: 'home' }), { ...at({ name: 'home' }), connection: 'connected' });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('Sessions の検索語が変わるだけなら包まない。打つたびに画面の移り変わりを走らせない', () => {
    const f = fake();
    const commit = vi.fn();
    createPresent(f.env)(commit, at({ name: 'sessions', q: 'a' }), at({ name: 'sessions', q: 'ab' }));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('起動中からの最初の描画は包まない', () => {
    const f = fake();
    const commit = vi.fn();
    createPresent(f.env)(commit, at({ name: 'booting' }), at({ name: 'home' }));
    expect(f.start).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['View Transitions が無い環境', { startViewTransition: undefined }],
    ['reduced motion', { reducedMotion: () => true }],
  ])('%s では、包まずにその場で描く', (_label, over) => {
    const f = fake(over);
    const commit = vi.fn();
    createPresent(f.env)(commit, at({ name: 'home' }), at({ name: 'projects' }));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('押した行から上段へ広げる。同じセッションのほかの札には名前を付けない', async () => {
    document.body.innerHTML = '<div id="card" data-morph-id="s1"></div><div id="row" data-morph-id="s1"><span id="in"></span></div>';
    const f = fake({ pressed: () => $('#in') });
    const commit = vi.fn(() => { document.body.innerHTML = '<div id="hero" data-morph-hero="s1"></div>'; });
    createPresent(f.env)(commit, at({ name: 'home' }), at({ name: 'session', id: 's1' }));
    expect(commit).not.toHaveBeenCalled();
    expect(name('#row')).toBe(SESSION_MORPH);
    expect(name('#card')).toBe('');
    f.run();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(name('#hero')).toBe(SESSION_MORPH);
    f.finish();
    await flush();
    expect(name('#hero')).toBe('');
  });
  it('一覧のカーソルの行を Enter で開いたときは、その行から広げる', () => {
    document.body.innerHTML = '<div class="rows-host" id="host"><div id="a" data-morph-id="s1"></div><div id="b" data-morph-id="s1" data-cursor="true"></div></div>';
    const f = fake({ focused: () => $('#host') });
    createPresent(f.env)(() => {}, at({ name: 'project', id: 'p1' }), at({ name: 'session', id: 's1' }));
    expect(name('#b')).toBe(SESSION_MORPH);
    expect(name('#a')).toBe('');
  });
  it('パレットから開いたときは行を広げず、ふつうの画面遷移にする', () => {
    document.body.innerHTML = '<div id="row" data-morph-id="s1"></div><div class="dialog palette"><input id="palette-input"></div><input id="global-search">';
    const f = fake({ focused: () => $('#palette-input') });
    const commit = vi.fn(() => { document.body.innerHTML = '<div id="hero" data-morph-hero="s1"></div><input id="global-search">'; });
    createPresent(f.env)(commit, at({ name: 'home' }, { kind: 'palette' }), at({ name: 'session', id: 's1' }));
    expect(name('#row')).toBe('');
    expect(name('.palette')).toBe(PALETTE_MORPH);
    f.run();
    expect(name('#hero')).toBe('');
    expect(name('#global-search')).toBe(PALETTE_MORPH);
  });
  it('セッション画面から戻ると、上段が元の行へ縮んで帰る', () => {
    document.body.innerHTML = '<div id="hero" data-morph-hero="s1"></div>';
    const f = fake();
    createPresent(f.env)(() => { document.body.innerHTML = '<div id="row" data-morph-id="s1"></div>'; }, at({ name: 'session', id: 's1' }), at({ name: 'home' }));
    expect(name('#hero')).toBe(SESSION_MORPH);
    f.run();
    expect(name('#row')).toBe(SESSION_MORPH);
  });
  it('広がる元が無ければ、行き先にも名前を付けない', () => {
    const f = fake();
    createPresent(f.env)(() => { document.body.innerHTML = '<div id="hero" data-morph-hero="s1"></div>'; }, at({ name: 'home' }), at({ name: 'session', id: 's1' }));
    f.run();
    expect(name('#hero')).toBe('');
  });
  it('パレットが閉じると、パレットから検索欄の錠剤へ戻る', () => {
    document.body.innerHTML = '<div class="dialog palette"></div><input id="global-search">';
    const f = fake();
    createPresent(f.env)(() => { $('.palette').remove(); }, at({ name: 'home' }, { kind: 'palette' }), at({ name: 'home' }));
    expect(name('.palette')).toBe(PALETTE_MORPH);
    expect(name('#global-search')).toBe('');
    f.run();
    expect(name('#global-search')).toBe(PALETTE_MORPH);
  });
  it('次の遷移に割り込まれても、名前を外し、拒否を外へ漏らさない', async () => {
    document.body.innerHTML = '<div class="dialog palette"></div><input id="global-search">';
    const f = fake();
    createPresent(f.env)(() => { $('.palette').remove(); }, at({ name: 'home' }, { kind: 'palette' }), at({ name: 'home' }));
    f.run();
    f.skip();
    await flush();
    expect(name('#global-search')).toBe('');
  });
  it('包んだ中で、描画を flushSync で同期させる', () => {
    const order: string[] = [];
    const f = fake({ flushSync: (fn) => { order.push('flush'); fn(); order.push('flushed'); } });
    createPresent(f.env)(() => order.push('commit'), at({ name: 'home' }), at({ name: 'projects' }));
    f.run();
    expect(order).toEqual(['flush', 'commit', 'flushed']);
  });
});
```

`packages/ui/src/runtime/focusSoon.test.ts` を作る。

```ts
import { describe, expect, it, vi } from 'vitest';
import { FOCUS_TRIES, focusSoon } from './focusSoon.ts';

describe('focusSoon', () => {
  const frames = () => {
    const q: (() => void)[] = [];
    return { nextFrame: (cb: () => void) => { q.push(cb); }, tick: () => q.shift()?.(), pending: () => q.length };
  };
  it('要素が現れた描画でフォーカスを当てる', () => {
    const f = frames();
    const el = { focus: vi.fn() } as unknown as HTMLElement;
    let ready = false;
    focusSoon(() => (ready ? el : null), f.nextFrame);
    f.tick();
    f.tick();
    expect(el.focus).not.toHaveBeenCalled();
    ready = true;
    f.tick();
    expect(el.focus).toHaveBeenCalledTimes(1);
    expect(f.pending()).toBe(0);
  });
  it('決まった枚数だけ探して、現れなければやめる', () => {
    const f = frames();
    const find = vi.fn(() => null);
    focusSoon(find, f.nextFrame);
    for (let i = 0; i < FOCUS_TRIES + 5; i++) f.tick();
    expect(find).toHaveBeenCalledTimes(FOCUS_TRIES);
    expect(f.pending()).toBe(0);
  });
});
```

- [ ] **Step 5: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/runtime/present.test.ts packages/ui/src/runtime/focusSoon.test.ts`
Expected: FAIL。`present.ts` と `focusSoon.ts` が無い。

- [ ] **Step 6: present と focusSoon を書く**

`packages/ui/src/runtime/present.ts` を作る。

```ts
import type { Screen, State } from '../mediator/types.ts';

/**
 * 状態の変化を画面へ出す（RuntimeDeps.present）。
 * 画面が替わるときと、⌘K パレットが閉じるときだけ、View Transitions で包んで描き替える。
 * 一覧の行か Home の実行中の札からセッションを開くと、その行がセッション画面の上段へ広がる（決めの動き）。
 * 戻ると、上段が元の行へ縮んで帰る。
 * 出る画面と入る画面の重ね合わせは base.css の ::view-transition の規則が、入る画面の動きは .screen の enter が受け持つ。
 * View Transitions が無い環境（macOS 13 と 14 の WKWebView）と reduced motion では、包まずにその場で描く。
 */

/** 見た目の移り変わりに要る、ブラウザの受け口。試験が差し替える。 */
export type PresentEnv = {
  /** document.startViewTransition。無い環境では undefined。 */
  startViewTransition?: (update: () => void) => { ready: Promise<unknown>; finished: Promise<unknown> };
  reducedMotion(): boolean;
  /** react-dom の flushSync。包んだ中で React の描画を同期させ、入る画面の写しに間に合わせる。 */
  flushSync(fn: () => void): void;
  root: ParentNode;
  /** 直前に押された要素と、いまフォーカスのある要素。どの行から広げるかを決めるのに使う。 */
  pressed(): Element | null;
  focused(): Element | null;
};

/** 行とセッション画面の上段に、遷移の間だけ付ける名前。 */
export const SESSION_MORPH = 'session-morph';
/** パレットと検索欄の錠剤に、閉じる遷移の間だけ付ける名前。 */
export const PALETTE_MORPH = 'palette-morph';

type Pair = { name: string; from: () => HTMLElement | null; to: () => HTMLElement | null };

// 画面の同一性は名前と id で見る。Sessions の検索語（q）はハッシュに載るが、画面は替わっていない。
const screenKey = (s: Screen) => ('id' in s ? `${s.name}:${s.id}` : s.name);
const rowOf = (id: string) => `[data-morph-id="${id.replace(/["\\]/g, '\\$&')}"]`;

export function createPresent(env: PresentEnv): (commit: () => void, prev: State, next: State) => void {
  const q = (sel: string) => env.root.querySelector<HTMLElement>(sel);
  // 開いた行。押した要素、フォーカスのある札、フォーカスのある一覧のカーソルの行の順に探す。
  // どれでもなければ（パレットやキーボードの近道から開いたとき）広げず、ふつうの画面遷移にする。
  // 同じセッションが実行中の札と最近の行の両方にあっても、名前は 1 つにしか付けない。2 つあると遷移ごと捨てられる。
  const opened = (id: string): HTMLElement | null => {
    const sel = rowOf(id);
    const hit = env.pressed()?.closest<HTMLElement>(sel) ?? env.focused()?.closest<HTMLElement>(sel);
    if (hit) return hit;
    return env.focused()?.closest('.rows-host')?.querySelector<HTMLElement>(`${sel}[data-cursor="true"]`) ?? null;
  };
  return (commit, prev, next) => {
    const screenChanged = prev.screen.name !== 'booting' && screenKey(prev.screen) !== screenKey(next.screen);
    const paletteClosed = prev.overlay.kind === 'palette' && next.overlay.kind !== 'palette';
    const start = env.startViewTransition;
    if ((!screenChanged && !paletteClosed) || !start || env.reducedMotion()) { commit(); return; }
    const pairs: Pair[] = [];
    const to = next.screen;
    const from = prev.screen;
    if (screenChanged && to.name === 'session' && from.name !== 'session') pairs.push({ name: SESSION_MORPH, from: () => opened(to.id), to: () => q('[data-morph-hero]') });
    if (screenChanged && from.name === 'session' && to.name !== 'session') pairs.push({ name: SESSION_MORPH, from: () => q('[data-morph-hero]'), to: () => q(rowOf(from.id)) });
    if (paletteClosed) pairs.push({ name: PALETTE_MORPH, from: () => q('.palette'), to: () => q('#global-search') });
    // 出る側に名前を付けてから写しを取らせる。
    const froms = pairs.map((p) => p.from());
    froms.forEach((el, i) => { if (el) el.style.viewTransitionName = pairs[i]!.name; });
    const named: HTMLElement[] = [];
    const t = start(() => {
      // 同じ名前が 2 つあると遷移ごと捨てられるので、入る側に付ける前に出る側から外す。
      for (const el of froms) if (el) el.style.viewTransitionName = '';
      env.flushSync(commit);
      // 出る側が無かった組は、入る側にも付けない。片方だけの組は、その場で唐突に現れて見えるからである。
      pairs.forEach((p, i) => {
        if (!froms[i]) return;
        const el = p.to();
        if (el) { el.style.viewTransitionName = p.name; named.push(el); }
      });
    });
    // 次の遷移に割り込まれると ready と finished は拒否される。描き替えは済んでいるので、拒否は捨てて名前だけ外す。
    t.ready.catch(() => {});
    t.finished.catch(() => {}).then(() => { for (const el of named) el.style.viewTransitionName = ''; });
  };
}
```

`packages/ui/src/runtime/focusSoon.ts` を作る。

```ts
/**
 * 何枚目の描画まで探すか。
 * 画面の移り変わりを View Transitions で包むと、描き替えが 1 から 2 枚遅れる。それでも間に合う数にしてある。
 */
export const FOCUS_TRIES = 10;

/** 要素が現れるまで、次の描画ごとに探してフォーカスを当てる。現れなければ FOCUS_TRIES 枚でやめる。 */
export function focusSoon(find: () => HTMLElement | null, nextFrame: (cb: () => void) => void, tries = FOCUS_TRIES): void {
  nextFrame(() => {
    const el = find();
    if (el) el.focus();
    else if (tries > 1) focusSoon(find, nextFrame, tries - 1);
  });
}
```

Run: `npx vitest run packages/ui/src/runtime`
Expected: PASS。

- [ ] **Step 7: 広がる元の印を付ける**

`packages/ui/src/views/SessionRows.test.tsx` の、最初の `describe`（`行のクリックと Enter で session.open` のある組）に足す。
同じファイルの `row(id)` で行の props を作る。

```tsx
  it('行はセッションの id を、広がる元の印に持つ', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><SessionRows rows={[row('a'), row('b')]} height={400} variant="recent" /></IntentRoot>);
    expect([...container.querySelectorAll('.row-2')].map((r) => r.getAttribute('data-morph-id'))).toEqual(['a', 'b']);
  });
```

`packages/ui/src/views/screens.test.tsx` の Home の `describe` の中（`runningCard` を定義している組）に足す。

```tsx
  it('実行中の札はセッションの id を、広がる元の印に持つ', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ running: [runningCard()] })} /></IntentRoot>);
    expect(container.querySelector('.live-card')!.getAttribute('data-morph-id')).toBe('s1');
  });
```

`packages/ui/src/views/SessionRows.tsx` の行の `<div className="row row-2" role="row" tabIndex={0} data-cursor={...}` に `data-morph-id={r.id}` を足す。
`packages/ui/src/views/HomeScreen.tsx` の `LiveCard` の `<div className="live-card" role="button" tabIndex={0} ...>` に `data-morph-id={c.id}` を足す。

- [ ] **Step 8: View Transitions の長さと曲線を書く**

`packages/ui/src/styles/motion.test.ts` の末尾に足す。

```ts
describe('画面の移り変わり', () => {
  // 出る画面と入る画面を同じ長さと曲線で重ねる。揃えないと、変わらないヘッダとサイドバーが途中で明滅する。
  it('View Transitions の組は、どれも --dur と --ease-out で動く', () => {
    expect(strip(read('base.css'))).toContain('::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: var(--dur); animation-timing-function: var(--ease-out); }');
  });
});
```

`packages/ui/src/styles/base.css` の `@keyframes enter ...` の行の次に足す。

```css
/* 画面の移り変わり（View Transitions、runtime/present.ts）。
   root は出る画面と入る画面を重ねて替える。old と new の長さと曲線を揃えるのは、変わらないヘッダとサイドバーが途中で明滅しないためである。
   行が上段へ広がる組と、パレットが錠剤へ戻る組は、位置と大きさを同じ長さで移す。 */
::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: var(--dur); animation-timing-function: var(--ease-out); }
```

- [ ] **Step 9: main.tsx でつなぐ**

`packages/ui/src/main.tsx` を直す。
import に次を足す。

```ts
import { flushSync } from 'react-dom';
import { focusSoon } from './runtime/focusSoon.ts';
import { createPresent } from './runtime/present.ts';
```

`const terminals = createTerminalHost(...)` の次に足す。

```ts
// 直前に押した要素。行を開いたときに、どの行から広げるかを決めるのに使う。
// 前の押下で広げないように、押してから短い間だけ有効にする。
const PRESS_FRESH_MS = 1000;
let pressed: { el: Element; at: number } | null = null;
window.addEventListener('pointerdown', (e) => { if (e.target instanceof Element) pressed = { el: e.target, at: performance.now() }; }, true);
const present = createPresent({
  startViewTransition: typeof document.startViewTransition === 'function' ? (update) => document.startViewTransition(update) : undefined,
  reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  flushSync,
  root: document,
  pressed: () => (pressed && performance.now() - pressed.at < PRESS_FRESH_MS ? pressed.el : null),
  focused: () => document.activeElement,
});
```

`createRuntime({ ... })` に `present,` を足す。
`focus: (t) => { requestAnimationFrame(() => document.getElementById(FOCUS_IDS[t])?.focus()); },` と、その上のコメント 1 行を、次に置き換える。

```ts
  // ダイアログは状態が変わった次の描画で現れる。画面の移り変わりで包むと描き替えがさらに遅れるので、現れるまで次の描画ごとに探す。
  focus: (t) => focusSoon(() => document.getElementById(FOCUS_IDS[t]), (cb) => { requestAnimationFrame(cb); }),
```

- [ ] **Step 10: 試験と型検査**

Run: `npx vitest run packages/ui && npm run typecheck --workspace packages/ui`
Expected: PASS、0 件。
`document.startViewTransition` の型が無いと言われたら、TypeScript の `lib.dom` の版を確かめる（TypeScript 6 は持っている）。
型が合わない（`ViewTransition` を返す）と言われたら、`PresentEnv.startViewTransition` の戻りの型はそのままにして、main.tsx の側で `(update) => document.startViewTransition(update)` がそれを満たすことを確かめる。

- [ ] **Step 11: コミット**

```bash
git add packages/ui/src/runtime/present.ts packages/ui/src/runtime/present.test.ts packages/ui/src/runtime/focusSoon.ts packages/ui/src/runtime/focusSoon.test.ts
git commit packages/ui/src/runtime packages/ui/src/main.tsx packages/ui/src/views/SessionRows.tsx packages/ui/src/views/HomeScreen.tsx packages/ui/src/views/SessionRows.test.tsx packages/ui/src/views/screens.test.tsx packages/ui/src/styles/base.css packages/ui/src/styles/motion.test.ts -m "feat(ui): let a row grow into the session screen through a view transition

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 起動画面（ハンガーが流れ続ける）

**Files:**
- Create: `apps/desktop/loading/boot-frames.js`
- Create: `apps/desktop/loading/boot.js`
- Modify: `apps/desktop/loading/index.html`
- Create: `apps/desktop/test/boot.test.ts`
- Modify: `apps/desktop/test/config.test.ts`（`describe('読み込み画面')`）
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`Ui`、`page_loaded`、`boot`、`BOOT_CYCLE_MS`、`settle_delay`、試験）

**Interfaces:**
- Produces: `boot-frames.js` の `CYCLE_MS = 1600`、`geo(u)`、`frameOf(T): { u, id, ang, dy, op }[]`、`frameSvg(T): string`、`SLOW_AFTER_MS = 3000`、`stillBootingText(ms): string | null`。
- Produces: `lib.rs` の `const BOOT_CYCLE_MS: u64 = 1600;` と `fn settle_delay(since_load: Duration) -> Duration`、`Ui.loading_since: Option<Instant>`。

- [ ] **Step 1: 失敗する試験を書く**

`apps/desktop/test/boot.test.ts` を作る。

```ts
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type Card = { u: number; id: number; ang: number; dy: number; op: number };
type BootFrames = { CYCLE_MS: number; SLOW_AFTER_MS: number; frameOf(T: number): Card[]; frameSvg(T: number): string; stillBootingText(ms: number): string | null };
// 読み込み画面は依存を持たない素の JS なので、型は試験の側で書く。
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'loading', 'boot-frames.js');
const m = (await import(pathToFileURL(file).href)) as BootFrames;
const byId = (T: number) => new Map(m.frameOf(T).map((c) => [c.id, c]));

describe('起動画面のハンガー', () => {
  // 仕様：角度と位置は、掛かる前後、送りの前後、周期の境目のどこでも途切れない。
  // 1ms ごとに見て、どの札もその間に動ける量より大きく跳ばないことを確かめる。
  it('どの札の位置、傾き、縦のずれ、不透明度も途切れない', () => {
    const limit = { u: 0.01, ang: 0.2, dy: 0.5, op: 0.02 };
    let prev = byId(2 * m.CYCLE_MS / 1000);
    for (let ms = 2 * m.CYCLE_MS + 1; ms <= 6 * m.CYCLE_MS; ms++) {
      const cur = byId(ms / 1000);
      for (const [id, c] of cur) {
        const p = prev.get(id);
        if (!p) continue;
        for (const k of ['u', 'ang', 'dy', 'op'] as const) expect(Math.abs(c[k] - p[k]), `${ms}ms の札 ${id} の ${k}`).toBeLessThan(limit[k]);
      }
      prev = cur;
    }
  });
  it('新しい札は透明から現れ、奥の札は霞に溶けてから消える', () => {
    for (let ms = 2 * m.CYCLE_MS; ms <= 6 * m.CYCLE_MS; ms++) {
      const T = ms / 1000;
      const before = byId(T - 0.001);
      for (const [id, c] of byId(T)) if (!before.has(id)) expect(c.op, `${ms}ms に現れた札 ${id}`).toBeLessThan(0.02);
      for (const [id, c] of before) if (!byId(T).has(id)) expect(c.op, `${ms}ms に消えた札 ${id}`).toBeLessThan(0.02);
    }
  });
  it('周期の境目では、札が静止した原図と同じ 1 本ずつの位置に並ぶ', () => {
    const us = m.frameOf(3 * m.CYCLE_MS / 1000).filter((c) => c.op > 0.5).map((c) => c.u).sort();
    expect(us).toEqual([1, 2, 3]);
  });
  it('描く SVG は竿のグラデーションと札を持つ', () => {
    const svg = m.frameSvg(1.2);
    expect(svg).toContain('<linearGradient id="RG"');
    expect((svg.match(/<rect x="-30"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('起動が長いときの文', () => {
  it('3 秒を超えたら「まだ起動しています（N 秒）」にする', () => {
    expect(m.stillBootingText(2999)).toBeNull();
    expect(m.stillBootingText(3000)).toBe('まだ起動しています（3 秒）');
    expect(m.stillBootingText(12_500)).toBe('まだ起動しています（12 秒）');
  });
});
```

`apps/desktop/test/config.test.ts` の `describe('読み込み画面', ...)` の中の試験の末尾に 2 行足し、試験を 1 つ足す。

```ts
    expect(html).toContain('<img id="logo" src="logo.svg"');
    expect(html).toContain('<script type="module" src="boot.js"></script>');
  });
  // 殻は起動画面の周の境目まで待ってから画面を移す。周期が食い違うと、送りの途中で画面が替わる。
  it('殻の周期（lib.rs の BOOT_CYCLE_MS）は、起動画面の周期（boot-frames.js の CYCLE_MS）と同じ', () => {
    const rust = read('src-tauri/src/lib.rs').match(/const BOOT_CYCLE_MS: u64 = (\d+);/)?.[1];
    const js = read('loading/boot-frames.js').match(/export const CYCLE_MS = (\d+);/)?.[1];
    expect(rust).toBeDefined();
    expect(rust).toBe(js);
  });
```

（先頭の 2 行は、既存の `expect(html).toContain('src="logo.svg"');` の次に置き、既存の `});` の前に入れる。）

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run apps/desktop/test`
Expected: FAIL。`boot-frames.js` が無い。

- [ ] **Step 3: 動きの計算を移す**

`apps/desktop/loading/boot-frames.js` を作る。
値と式は `docs/superpowers/specs/2026-09-29-ui-refresh/boot-animation.html` の `ENTRY.pendulum` と `frameOf` をそのまま移したもので、変えてはいけない。

```js
// 起動画面のハンガーの動き。
// 値と式は docs/superpowers/specs/2026-09-29-ui-refresh/boot-animation.html の ENTRY.pendulum と frameOf が正本で、それをそのまま移した。
// 画面に依らない計算だけを置き、描くのは boot.js が受け持つ（試験は apps/desktop/test/boot.test.ts）。

const INK = '#1c1b2e';
const BLUE = '#4a63e8';
const HAZE = '#e2e7ff';
const CHEV = '#e8e6e1';
/** 札ごとのカーソルの色。杏、赤、灰、杏、杏、灰の順に巡る。 */
const CURSORS = ['#ffb86b', '#e5533d', '#b5b2c4', '#ffb86b', '#ffb86b', '#b5b2c4'];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
const clamp = (t) => Math.max(0, Math.min(1, t));
const eOut = (t) => 1 - Math.pow(1 - t, 3);

// 並べ方。1 本奥へ行くごとに 0.85 倍、横へ札の幅 62 の 13%、上へ札の高さ 72 の 3.5%（静止した原図と同じ）。
const R = 0.85;
const K = 0.13 * 62;
const UP = 0.035 * 72;
/** 奥への位置 u（0 が手前、小数も取る）の札の置き場所と倍率。 */
export const geo = (u) => { const g = (1 - Math.pow(R, u)) / (1 - R); return { x: K * g, y: -UP * g, s: Math.pow(R, u) }; };

// 振り子の角速度（約 1 往復／秒）と減衰。
const W = 6.3;
const Z = 2.4;
/** 1 周期の長さ。lib.rs の BOOT_CYCLE_MS と揃える（config.test.ts が突き合わせる）。 */
export const CYCLE_MS = 1600;
const PER = CYCLE_MS / 1000;
// 周期のうち、新しい札が掛かる部分（H）、全体が奥へ送られる部分（SL）、札ごとの送りの遅れ（WV）の割合。
const H = 0.34;
const SL = 0.34;
const WV = 0.07;

/** 降りながら少しずつ傾き、掛かった角度のまま振り子として揺れ始める。d は掛かるまでの進み、tau は掛かってからの秒数。 */
const pendulum = (d, tau, landed) => {
  const A = 5;
  if (!landed) return { dy: -34 * (1 - eOut(d)), ang: A * eOut(d), op: eOut(d) };
  return { dy: 0, ang: A * Math.exp(-Z * tau) * Math.cos(W * tau), op: 1 };
};

/**
 * 時刻 T 秒の札の並び。奥の札から順に返す。
 * u は奥への位置、id は札の通し番号、ang は傾き（度）、dy は縦のずれ、op は不透明度。
 */
export function frameOf(T) {
  const n = Math.floor(T / PER);
  const f = (T / PER) % 1;
  const tSec = f * PER;
  const out = [];
  const landT = H * 0.92 * PER;
  for (let k = 0; k <= 4; k++) {
    const id = n - k;
    const local = clamp((f - H - k * WV) / SL);
    let u = k + eOut(local);
    let dy = 0;
    let op = 1;
    let ang = 0;
    const damp = 1 - Math.min(u, 3) / 5;
    const B = 3.2 * damp;
    const endT = (H + k * WV + SL) * PER;
    // 送り：動く間は後ろへ遅れ、止まったら振り子として前へ振れて戻る（角度と向きが途切れない）。
    if (local > 0 && local < 1) ang = -B * Math.sin(local * Math.PI);
    else if (local >= 1) { const tau = tSec - endT; ang = B * 0.7 * Math.exp(-Z * tau) * Math.sin(W * tau); }
    else if (k > 0) { const tau = tSec + PER - (endT - WV * PER); ang = B * 0.7 * Math.exp(-Z * tau) * Math.sin(W * tau); } // 前の周期の送りの揺れの続き
    // 先頭の札は、周期の頭で掛かる。その揺れが送りの前まで続く。
    if (k === 0) {
      const landed = tSec >= landT;
      const d = clamp(tSec / landT);
      const tau = Math.max(0, tSec - landT);
      const e = pendulum(d, tau, landed);
      if (f < H) { dy = e.dy; op = e.op; ang = e.ang; }
      else { ang += pendulum(1, tau, true).ang * (local < 1 ? 1 : Math.exp(-3 * (tSec - endT))); }
    }
    if (u > 3) op *= clamp(1 - (u - 3) / 0.8);
    if (op <= 0) continue;
    out.push({ u, id, ang, dy, op });
  }
  return out.sort((p, q) => q.u - p.u);
}

// 竿と外枠は、静止した原図（packages/ui/src/brand/logo.ts の layout）と同じ置き方にする。
const P = [0, 1, 2, 3].map(geo);
let box = [Infinity, Infinity, -Infinity, -Infinity];
for (const p of P) box = [Math.min(box[0], p.x - 31 * p.s), Math.min(box[1], p.y - 3 * p.s), Math.max(box[2], p.x + 31 * p.s), Math.max(box[3], p.y + 69 * p.s)];
const SC = Math.min(70 / (box[2] - box[0]), 66 / (box[3] - box[1]));
const TX = 50 - (SC * (box[0] + box[2])) / 2;
const TY = 51 - (SC * (box[1] + box[3])) / 2;
const R0 = geo(-1.1);
const R1 = geo(3.6);
const DEFS = `<defs><linearGradient id="RG" gradientUnits="userSpaceOnUse" x1="${R0.x}" y1="0" x2="${R1.x}" y2="0"><stop offset="0" stop-color="${INK}" stop-opacity="0"/><stop offset=".2" stop-color="${INK}"/><stop offset=".4" stop-color="${INK}"/><stop offset="1" stop-color="${HAZE}"/></linearGradient></defs>`;
const RAIL = `<path d="M${R0.x} ${R0.y - 1}L${R1.x} ${R1.y - 1}" stroke="url(#RG)" stroke-width="2.6" stroke-linecap="round"/>`;

const colors = (t, cur) => ({ ink: mix(INK, HAZE, t), blue: mix(BLUE, HAZE, t), chev: mix(CHEV, HAZE, t * 0.6), cur: mix(cur, HAZE, t * 0.45), r: mix('#ff6a55', HAZE, t), y: mix('#ffc34d', HAZE, t), g: mix('#3fb58a', HAZE, t) });
const item = (c) => `<path d="M0 10v-4a4.2 4.2 0 1 0-4.2-4.2" fill="none" stroke="${c.ink}" stroke-width="2.8" stroke-linecap="round"/><rect x="-30" y="29" width="60" height="40" rx="5" fill="${c.ink}"/>`
  + `<path d="M0 10L-31 31H31Z" fill="none" stroke="${c.blue}" stroke-width="4" stroke-linejoin="round"/>`
  + `<circle cx="-23" cy="37" r="2" fill="${c.r}"/><circle cx="-16.5" cy="37" r="2" fill="${c.y}"/><circle cx="-10" cy="37" r="2" fill="${c.g}"/>`
  + `<path d="M-23 46l7 5.5-7 5.5" fill="none" stroke="${c.chev}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="-12" y="55" width="13" height="4" rx="2" fill="${c.cur}"/>`;
const draw = (c) => {
  const p = geo(c.u);
  const t = clamp(c.u / 3) * 0.86 + Math.max(0, c.u - 3) * 0.1;
  return `<g transform="translate(${p.x.toFixed(2)} ${(p.y + c.dy).toFixed(2)}) scale(${p.s.toFixed(4)})" opacity="${c.op.toFixed(3)}"><g transform="rotate(${c.ang.toFixed(2)})">${item(colors(Math.min(t, 0.95), CURSORS[((c.id % 6) + 6) % 6]))}</g></g>`;
};

/** 時刻 T 秒の絵。viewBox 0 0 100 100 の svg の中身にする。 */
export const frameSvg = (T) => `${DEFS}<g transform="translate(${TX} ${TY}) scale(${SC})">${RAIL}${frameOf(T).map(draw).join('')}</g>`;

/** 起動を待ち始めてから、状態の文を替えるまでの長さ。 */
export const SLOW_AFTER_MS = 3000;
/** 待ちが長いときの文。SLOW_AFTER_MS より前は null で、今の文をそのまま残す。 */
export const stillBootingText = (ms) => (ms < SLOW_AFTER_MS ? null : `まだ起動しています（${Math.floor(ms / 1000)} 秒）`);
```

Run: `npx vitest run apps/desktop/test/boot.test.ts`
Expected: PASS。
「途切れない」が落ちたら、正本の試作から写し間違えていないかを 1 行ずつ突き合わせる（閾値を緩めない）。

- [ ] **Step 4: 描画と頁を書く**

`apps/desktop/loading/boot.js` を作る。

```js
import { frameSvg, stillBootingText } from './boot-frames.js';

// 起動画面の描画。
// 動きの時計は頁の load から数える。殻（lib.rs の settle_delay）も同じ合図から周期を数え、周の境目まで待ってから画面を移す。
// reduced motion では、静止した原図（logo.svg）と文字だけを出す。
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const status = document.getElementById('status');
let t0 = null;
const begin = () => { t0 = performance.now(); };
if (document.readyState === 'complete') begin();
else addEventListener('load', begin, { once: true });

if (!still) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', '96');
  svg.setAttribute('height', '96');
  svg.setAttribute('aria-hidden', 'true');
  // 揺れる札は枠から少しはみ出すので、切らない。
  svg.style.overflow = 'visible';
  document.getElementById('logo').replaceWith(svg);
  const frame = (now) => {
    svg.innerHTML = frameSvg(t0 === null ? 0 : (now - t0) / 1000);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// 起動が長いときは文を替える。失敗の文（data-level="error"、殻が書く）が出たら、もう触らない。
const tick = setInterval(() => {
  if (status.dataset.level === 'error') { clearInterval(tick); return; }
  if (t0 === null) return;
  const text = stillBootingText(performance.now() - t0);
  if (text) status.textContent = text;
}, 1000);
```

`apps/desktop/loading/index.html` の `<img src="logo.svg" width="96" height="96" alt="" />` を `<img id="logo" src="logo.svg" width="96" height="96" alt="" />` に直す。
`</main>` の次の行に `<script type="module" src="boot.js"></script>` を足す。

Run: `npx vitest run apps/desktop/test`
Expected: 周期の突き合わせ（`BOOT_CYCLE_MS`）のほかは PASS。

- [ ] **Step 5: 殻が周の境目まで待つ**

`apps/desktop/src-tauri/src/lib.rs` を直す。
`struct Ui` の中の `pending_status: Option<(String, bool)>,` の次に足す。

```rust
    /// 読み込み画面の load の合図が届いた時刻。起動画面の動きの時計も同じ合図から数える。
    loading_since: Option<Instant>,
```

`Instant` が use されていなければ、`use std::time::{Duration, Instant};` に足す（今の use の形に合わせる）。
`/// 文言に入場の鍵が混じっていたら伏せる。` の前に足す。

```rust
/// 起動画面の 1 周期（ミリ秒）。loading/boot-frames.js の CYCLE_MS と揃える（config.test.ts が突き合わせる）。
const BOOT_CYCLE_MS: u64 = 1600;

/// 起動画面の周の境目までの長さ。
/// 送りの途中で画面を移すと札が宙で消えるので、今の周を回し終えてから移る。
/// 起動画面は頁の load から時計を数えるので、`since_load` もその合図からの経過にする。
/// どこから数えても、1 周期より長くは待たない。
fn settle_delay(since_load: Duration) -> Duration {
    let cycle = u128::from(BOOT_CYCLE_MS);
    let into = since_load.as_millis() % cycle;
    if into == 0 {
        Duration::ZERO
    } else {
        Duration::from_millis((cycle - into) as u64)
    }
}
```

外側の `fn page_loaded(app: &AppHandle, server_page: bool)` の中の、ロックを取る塊を次に置き換える。

```rust
    let (status, hash) = {
        let state = app.state::<AppState>();
        let mut ui = state.ui.lock().unwrap();
        // 読み込み画面の最初の load だけを時計の起点にする。
        if !server_page && ui.loading_since.is_none() {
            ui.loading_since = Some(Instant::now());
        }
        ui.page_loaded(server_page)
    };
```

`fn boot(app: AppHandle)` の中の、`// 段の切り替えと pending の取り出しは同じロックの下で行い、` のコメントの前に足す。

```rust
    // 起動画面の周の境目まで待ってから移る。load の合図がまだ来ていなければ、描いている札も無いので待たない。
    let since = app.state::<AppState>().ui.lock().unwrap().loading_since;
    if let Some(t) = since {
        std::thread::sleep(settle_delay(t.elapsed()));
    }
```

`mod tests` の末尾に足す。

```rust
    // 起動画面の送りの途中で画面を移さない。周の境目までだけ待ち、1 周期より長くは待たない。
    #[test]
    fn the_boot_screen_finishes_its_cycle_before_moving_on() {
        assert_eq!(settle_delay(Duration::ZERO), Duration::ZERO);
        assert_eq!(settle_delay(Duration::from_millis(400)), Duration::from_millis(1200));
        assert_eq!(settle_delay(Duration::from_millis(1600)), Duration::ZERO);
        assert_eq!(settle_delay(Duration::from_millis(3300)), Duration::from_millis(1500));
        for ms in (0..5000).step_by(37) {
            assert!(settle_delay(Duration::from_millis(ms)) < Duration::from_millis(BOOT_CYCLE_MS));
        }
    }

    // load の合図が来る前は、時計の起点を持たない。
    #[test]
    fn the_boot_clock_starts_with_no_origin() {
        assert_eq!(Ui::default().loading_since, None);
    }
```

- [ ] **Step 6: 試験を通す**

Run: `npx vitest run apps/desktop/test && (cd apps/desktop/src-tauri && cargo test --lib && cargo check)`
Expected: PASS、`cargo test` が通り、`cargo check` が警告なしで終わる。

- [ ] **Step 7: コミット**

```bash
git add apps/desktop/loading/boot-frames.js apps/desktop/loading/boot.js apps/desktop/test/boot.test.ts
git commit apps/desktop/loading apps/desktop/test apps/desktop/src-tauri/src/lib.rs -m "feat(desktop): keep hangers flowing on the boot screen and leave it at a cycle's end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: design.md と仕様を書き換える

**Files:**
- Modify: `docs/design.md`（「セッション詳細」、「見た目と動き」）
- Modify: `docs/superpowers/specs/2026-09-29-ui-refresh-design.md`（「届け方」、「範囲外」）

- [ ] **Step 1: design.md のセッション詳細を直す**

`docs/design.md` の「### セッション詳細」の、`ヘッダーには名前、状態、要約（題名と 1 文、パネルで全部）、1 行メモ、モデルと effort、コンテキスト使用率を出す。` の 1 行を、次に置き換える。

```markdown
上段に状態の点、名前、要約の 1 文、操作を置く。
その下に、状態と経過、プロジェクト、モデルと effort、コンテキスト使用率、推定コスト、変更数、1 行メモ、PR、ロックをチップで並べる。
cwd、ターン、トークン、開始と最終の時刻、run は、チップの下に注記の文字で並べる。
要約の帯には題名と状態を出し、パネルで全部を出す。
端末は墨の板で、縁がそのセッションの状態で灯る。
作業中は杏の輪と光がゆっくり明暗を往復し、入力待ちは赤の輪と光で動かず、休みと終了は灯さない。
タブは板から生えたフォルダの耳で、選んだタブが板と同じ墨色になってつながる。
```

- [ ] **Step 2: design.md の動きを直す**

「## 見た目と動き」の、`動きは 150 から 250 ミリ秒の短いイージングに限り、次の 11 種だけを使う。` から、`初回索引の進行は静的な文字で示す。` までを、次に置き換える。

```markdown
動きの性格は「なめらか」で、すっと出て長く静かに止まる。
長さと曲線は `styles/tokens.css` のトークン（`--dur-fast` 200ms、`--dur` 420ms、`--dur-exit` 250ms、`--ease-out`、`--ease-in`、`--rise` 6px、`--blur-in` 6px、`--breathe-period` 3.2 秒）だけを通して書き、CSS にも JS にも数値を直書きしない（`styles/motion.test.ts` が見張る）。
JS からは `views/primitives/motion.ts` で読む。
reduced motion では長さと移動とぼかしのトークンが 0 になり、背景の光と端末の縁の往復が止まり、View Transitions も使わない。
使う動きは次のとおりである。

- 画面遷移。入る画面は、`--rise` だけ上がりながら、ぼかしが晴れて入る。View Transitions がある環境では、出る画面と入る画面を同じ長さと曲線で重ねて替える。長さを揃えるのは、変わらないヘッダとサイドバーが途中で明滅しないためである。
- 行を開いてセッション画面へ（決めの動き）。一覧の行か Home の実行中の札を押すか Enter で開くと、その行がセッション画面の上段へ広がり、戻ると上段が縮んで元の行へ帰る。`runtime/present.ts` が画面の替わり目を View Transitions で包み、React の描画を `flushSync` で同期させる。パレットやキーボードの近道から開いたときは広げない。
- 一覧への差し込み。Projects のカードは、新しいカードがぼかしから現れ、ほかのカードは FLIP で滑って場所を空ける。
- ⌘K パレットは、ヘッダの検索欄の錠剤からガラスが広がって開き、閉じると錠剤へ戻る。開く動きは描画を遅らせない Web Animations で作り、入力欄はその描画でフォーカスを持つ。
- ダイアログは 96% から、ぼかしが晴れながら開く。通知は右下から、切断の帯は上から、ぼかしが晴れながら現れる。
- 状態点、ゲージ、TODO の線は `--dur` で色と長さを移す。状態点は変わる瞬間に 1 度だけ小さく膨らむ。
- 端末の縁は、作業中だけ `--breathe-period` で明暗を往復し、状態が変わると色が `--dur` で移る。
- 背景の光は `--aura-period` で漂う。
- ボタンはホバーで 1px 浮き、押すと 97% に縮む（`--dur-fast`）。
- 折りたたみ、分割の幅、数字の回転、新着への追従は、長さと曲線だけをトークンに揃える。

シマー、スケルトン、タイピング風の表示は使わない。
脈動は端末の縁の作業中だけに許す。
`.app` の起動画面（`apps/desktop/loading/`）は、ロゴのハンガーが竿の上を流れ続ける動きで起動を待つ。
動きの計算は `loading/boot-frames.js`、描画は `loading/boot.js` が持ち、起動が 3 秒を超えたら「まだ起動しています（N 秒）」と出す。
殻はサーバの `/health` が通ったら、起動画面の周の境目（1 周期 1.6 秒）まで待ってから画面を移す。
reduced motion では静止した原図を出す。
画面の中の初回索引の進行は、静的な文字で示す。
```

- [ ] **Step 3: 仕様に 3 回目の決めごとを残す**

`docs/superpowers/specs/2026-09-29-ui-refresh-design.md` の「## 届け方」の節の末尾（`要対応の札は、端末を開いてフォーカスするだけにする。` の次）に足す。

```markdown

3 回目の実装（`docs/plans/ui-refresh-3-motion.md`）で、次のように決めた。

- 画面遷移の「出る画面は `--dur-exit` で消える」は、View Transitions の root を出る画面と入る画面で同じ長さと曲線にして重ねる形にした。長さを変えると、変わらないヘッダとサイドバーが途中で明滅するためである。
- ⌘K パレットは、開く動きを Web Animations で、閉じる動きを View Transitions で作った。開く側を View Transitions にすると描き替えが遅れ、打った文字を落とすためである。
- 行が広がる動きは、押した行か、フォーカスのある札か、一覧のカーソルの行からだけ始める。パレットやキーボードの近道から開いたときは、ふつうの画面遷移にする。
- セッション画面のチップの列の後ろに、cwd、ターン、トークン、時刻、run を注記の文字で残した。
```

「## 範囲外（後で検討する）」の箇条の末尾に足す。

```markdown
- 過去のセッションで、端末の板の場所に会話を広げ、右に要約、TODO、変更を置くこと。セッション単位の TODO と変更の一覧のデータが無い。
- 要対応の札から、決めの動きでセッション画面へ移ること。
```

- [ ] **Step 4: 文書の書き方を確かめる**

Run: `grep -nE '——|—|・' docs/design.md docs/superpowers/specs/2026-09-29-ui-refresh-design.md | head`
Expected: この Task で足した行に、ダッシュと中黒が無い（既にある行は触らない）。

- [ ] **Step 5: コミット**

```bash
git commit docs/design.md docs/superpowers/specs/2026-09-29-ui-refresh-design.md -m "docs: describe the session screen and the smooth motion of the third round

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 全体を通して、実物で確かめる

**Files:** なし（確かめるだけ。直すところが見つかったら、その規則を持つ Task のファイルを直し、同じ作法でコミットする）

- [ ] **Step 1: 試験と型検査を全部通す**

Run: `npm test && npm run typecheck && (cd apps/desktop/src-tauri && cargo test --lib)`
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

- [ ] **Step 3: 古い .app と利用者の dev サーバを止める**

`pgrep -fl "target/release/bundle/macos/Hangar.app"` で、ビルドした `.app` から起きたプロセスを探す。
あれば、`ps -o command= -p <PID>` でパスが `/Users/me/workspace/agent-hangar/apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` の下だと確かめてから、その PID だけを止める。
次に `lsof -nP -iTCP:4177 -sTCP:LISTEN -t` で PID を採り、`ps -o command= -p <PID>` で `packages/server` の tsx のサーバだと確かめたときだけ止める。
ほかのもの（`/Applications/Hangar.app` のサーバなど）が 4177 にいれば、止めずに報告する。
止めたものと、利用者が `npm run dev` を立て直す必要があるかを、報告に 1 行で書く。

- [ ] **Step 4: 実物の .app で見て確かめる**

ビルドした `.app`（`apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app`）を `open` で開く。
起動画面は、開いた直後に画面の写しを撮る代わりに、利用者の確認に回す（撮る窓に別の窓が写り込むため）。
サーバが起きたら、`/playwright` の手元の Chrome で、スクリプトの中で `~/.agent-hangar/token` を読んで `http://127.0.0.1:4177/?t=...` を開く（鍵を引数やログに出さない）。
頁だけの写し（`page.screenshot`）と DOM の測りで、次を確かめる。

1. セッション画面の上段（`.session-hero`）に、状態の点、名前、要約の 1 文、操作が 1 行に並び、その下にチップの列がある。
2. 実行中のセッションの端末の板（`.term-pane[data-live="busy"]`）の縁に杏の輪と光があり、入力待ちなら赤になる。
3. タブが耳の形で、選んだタブが板と同じ墨色になり、板の左上が角張ってつながっている。分割しても左右の板の光が欠けない。
4. Home の行を押すと、行がセッション画面の上段へ広がる。戻ると縮む。パレットを閉じると検索欄へ戻る。ヘッダとサイドバーが明滅しない。
5. `page.emulateMedia({ reducedMotion: 'reduce' })` で、縁の往復と背景の光が止まり、画面遷移が包まれない。

- [ ] **Step 5: 利用者に確かめてもらう**

画面を目で見る確認のうち、窓の動きと起動画面は、利用者にお願いする。
次の一覧を報告に載せる。

1. `.app` を開くと、起動画面でハンガーが竿の上を流れ続け、画面へ移るときに札が宙で消えない（周の境目で移る）。
2. 起動に 3 秒以上かかると、文が「まだ起動しています（N 秒）」に替わる。
3. Home の実行中の札か最近の行を押すと、その行がセッション画面の上段へ広がる。⌘[ で戻ると縮んで帰る。
4. ⌘K のパレットが検索欄の錠剤から広がって開き、Esc で錠剤へ戻る。開いてすぐ打った文字が入る。
5. 作業中のセッションの端末の縁がゆっくり明暗を往復し、入力待ちになると赤に移る。
6. ボタンにポインタを載せると少し浮き、押すと縮む。画面を移ると、ぼかしが晴れながら入る。
7. Sessions の検索欄で打っても、打鍵が引っかからない。
8. システム設定の「視差効果を減らす」を入れると、動きと光が止まる。

`/Applications/Hangar.app` を入れ替えるかどうかは、利用者に確かめてから行う。
`main` に入れるかどうかも、利用者の確認を待つ。

---

## 自己点検の記録

- 仕様の「端末の板と縁の灯」（busy の輪と光と 3.2 秒の往復、waiting の静止した輪、idle と終了は灯さない、状態の色の 420ms の遷移、reduced motion で往復を止める）は Task 5。
- 仕様のセッション画面（上段、チップの列、フォルダの耳、左上だけ角張る板）は Task 4 と Task 5。過去のセッションの右の要約、TODO、変更はデータが無いので Global Constraints で外し、Task 8 で範囲外に移す。
- 仕様の動きのトークン（値、置き換え、直書きの排除、reduced motion）は Task 1。動きの一覧のうち、画面遷移、ダイアログ、通知、状態点、差し込みは Task 2、パレットは Task 3 と Task 6、行が広がる動きは Task 6、ホバーと押下は Task 1、端末の縁は Task 5、背景の光は 1 回目で入っている。
- 仕様の起動画面（1.6 秒の周期、波の送り、振り子、途切れない角度と位置、3 秒で文を替える、周の境目で止めて移る、reduced motion で静止）は Task 7。
- 仕様の「足す試験」のうち、この回の分は、端末の縁（Task 5）、行が広がる動きの落とし方と reduced motion（Task 6）。
- 名前の一致：`motionMs`、`motionValue`、`motionEase`、`parseDuration`、`fakeMotionTokens`、`DurationToken`、`MotionToken`、`liveLabel`、`filesChanged`、`data-morph-hero`、`data-morph-id`、`data-live`、`--term-lift`、`--breathe-period`、`rim-breathe`、`createPresent`、`PresentEnv`、`SESSION_MORPH`、`PALETTE_MORPH`、`present`、`focusSoon`、`FOCUS_TRIES`、`CYCLE_MS`、`BOOT_CYCLE_MS`、`settle_delay`、`loading_since`、`frameOf`、`frameSvg`、`stillBootingText`、`SLOW_AFTER_MS` は、定義した Task と使う Task で同じ綴り。
- Task 6 は Task 3（`.palette` の器）と Task 4（`data-morph-hero`）の後に置いた。
