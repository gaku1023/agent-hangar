# セッション画面の動き 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** セッション画面の開閉と更新に動きを足し、左右の欄を畳んだときに空いた幅を本文が使い切り、「いま」と目次の境目を見出し 1 行まで自由に動かせるようにする。

**Architecture:** 動きは素の CSS と Web Animations（`el.animate`）だけで書く。共通の道具を `views/primitives/` に 4 つ足す。

- `motionKit.ts`：キーフレームの関数。
- `layoutMotion.ts`：動いている間は端末の fit を止める印。
- `usePresence.ts`：出る動きが終わるまで描き続けるフック。
- `useMotionList.ts`：リストの出入りと FLIP をまとめるフック。

これらを、右の欄の開閉（`paneMotion.ts`）、目次、「いま」、タブ、案内の帯から使う。長さと曲線は、すべて `styles/tokens.css` のトークンから読む。

**Tech Stack:** React 19、TypeScript、Vite、vitest と jsdom、@testing-library/react、xterm 6、Tauri（WebKit）。

**Spec:** `docs/superpowers/specs/2026-10-02-session-motion-design.md`（試作は `docs/superpowers/specs/2026-10-02-session-motion/motion-proto.html`）。

## Global Constraints

- 長さと曲線は必ずトークン（`--dur-fast` 200ms、`--dur` 420ms、`--dur-exit` 250ms、`--dur-flash`、`--ease-out`、`--ease-in`、`--rise`、`--blur-in`）を通す。CSS にも JS にも ms の数値を直書きしない（`styles/motion.test.ts` が見張る）。
- 入る形：opacity 0、translateY(--rise)、blur(--blur-in) から入り、ぼかしは offset 0.2 で none にする。長さは --dur、曲線は --ease-out。
- 畳んで出る形：長さは --dur-exit と --dur-fast の和、曲線は --ease-in。fill は forwards で、終わったら外す。
- 最初の描画、前の描画が空だった描画、key が全部入れ替わった描画では、出入りを動かさない。
- reduced motion ではトークンが 0 になる。0ms のときは動かさず、出る要素はすぐに外す。
- jsdom（`el.animate` が無い）では何もせず、最後の形にする。既存のテストは、出る動きを待たずに通ること。
- UI は常に明るい色のまま（暗い色の形は作らない）。
- 文言は日本語。読み上げのラベルは今の文言を保つ（「右の欄を開く」「右の欄を閉じる」）。
- テストは `npx vitest run packages/ui`、型は `npm run typecheck -w packages/ui`。どちらもリポジトリの根（worktree の根）で流す。
- コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

- **開閉を素早く 2 回押す**：右の欄を閉じる動きの途中で ⌘J をもう一度押しても、欄が空のまま残らず、端末の fit が止まったままにならない。Task 4 で、前の Animation の cancel と `data-layout-moving` の外し忘れを試す。
- **サブエージェントの transcript に切り替える**：目次の行がすべて別の key に替わる。そのときに、全部の行が出て全部の行が入る大騒ぎにならない。Task 2 の「key が全部替わったら動かさない」を試す。
- **古いターンを読み込む**：先頭に行が足されても、足された行が浮かんで入らず、末尾へ追従もしない。Task 6 で試す。
- **境目を端まで引いて離し、窓を低くする**：比率 1 でも目次の見出しと「最新へ」が残り、比率 0 でもランプの行が残る。Task 5 の `snapSplit` と CSS の min-height で試す。
- **終わった会話を再開する**：目次が作り直されず、スクロールの位置が保たれる。Task 11 で、TurnIndex の要素が同じものであり続けることを試す。

---

## ファイルの地図

新しく作るもの：

- `packages/ui/src/views/primitives/motionKit.ts`：`riseIn`、`fadeIn`、`growIn`、`collapseOut`、`slideFrom`、`popMark`、`markHit`。
- `packages/ui/src/views/primitives/motionKit.test.ts`
- `packages/ui/src/views/primitives/layoutMotion.ts`：`LAYOUT_MOVING_ATTR`、`LAYOUT_SETTLED`、`beginLayoutMotion`、`endLayoutMotion`。
- `packages/ui/src/views/primitives/usePresence.ts`、`usePresence.test.tsx`
- `packages/ui/src/views/primitives/useMotionList.ts`、`useMotionList.test.tsx`
- `packages/ui/src/views/primitives/paneMotion.ts`、`paneMotion.test.ts`
- `packages/ui/src/views/primitives/RollingText.tsx`（`RollingNumber` を文字列にも広げる）
- `packages/ui/src/styles/motion-session.test.ts`：この計画で足す CSS の文字列テスト。

変えるもの（主なもの）：

- `views/primitives/sidebarMotion.ts`、`views/TerminalPane.tsx`、`runtime/terminals.ts`
- `views/SessionScreen.tsx`、`views/TabStrip.tsx`、`views/LivePane.tsx`、`views/TurnIndex.tsx`
- `presenters/live.ts`（手に key）、`presenters/session.ts`（`turnsPending`）
- `mediator/sidebar.ts`（境目の丸め）
- `styles/base.css`、`styles/session.css`、`styles/workbench.css`
- 既存のテスト：`TerminalPane.test.tsx`、`SessionScreen.test.tsx`、`LivePane.test.tsx`、`TurnIndex.test.tsx`、`mediator/transition.test.ts`、`styles/header.test.ts`、`styles/motion.test.ts`、`presenters/live.test.ts`、`Root.test.tsx`、`runtime/runtime.test.ts`、`runtime/terminals.test.ts`

---

### Task 1: 動きの道具と、動いている間の印

**Files:**
- Create: `packages/ui/src/views/primitives/motionKit.ts`
- Create: `packages/ui/src/views/primitives/motionKit.test.ts`
- Create: `packages/ui/src/views/primitives/layoutMotion.ts`
- Modify: `packages/ui/src/views/primitives/sidebarMotion.ts`（`MOVING_ATTR` の付け外しの所、`settle`）
- Modify: `packages/ui/src/views/TerminalPane.tsx:5,40`
- Modify: `packages/ui/src/views/TerminalPane.test.tsx:5,45-48`
- Modify: `packages/ui/src/styles/base.css`（`[data-hit]` の規則を足す）
- Modify: `packages/ui/src/styles/motion.test.ts`（「JS の動き」に motionKit を足す）

**Interfaces:**
- Produces:
  - `riseIn(el: HTMLElement, delay?: number): Animation | null`
  - `fadeIn(el: HTMLElement): Animation | null`
  - `growIn(el: HTMLElement, axis?: 'y' | 'x'): Animation | null`
  - `collapseOut(el: HTMLElement, axis?: 'y' | 'x'): Promise<void>`
  - `slideFrom(el: HTMLElement, before: DOMRect, after: DOMRect): Animation | null`
  - `popMark(el: HTMLElement): Animation | null`
  - `markHit(el: HTMLElement): void`
  - `motionOn(el?: Element): boolean`（--dur が 0 より大きく、`el.animate` があるか）
  - `LAYOUT_MOVING_ATTR = 'data-layout-moving'`、`LAYOUT_SETTLED = 'hangar:layout-settled'`
  - `beginLayoutMotion(el: HTMLElement): void`、`endLayoutMotion(el: HTMLElement): void`

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/primitives/motionKit.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collapseOut, growIn, markHit, motionOn, riseIn, slideFrom } from './motionKit.ts';
import { beginLayoutMotion, endLayoutMotion, LAYOUT_MOVING_ATTR, LAYOUT_SETTLED } from './layoutMotion.ts';

/** トークンを :root に置く。jsdom は tokens.css を読まないので、テストの中で入れる。 */
const tokens = (dur: string) => {
  for (const [k, v] of Object.entries({ '--dur': dur, '--dur-fast': dur, '--dur-exit': dur, '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' })) document.documentElement.style.setProperty(k, v);
};
const fakeAnimate = () => {
  const calls: { frames: Keyframe[]; opts: KeyframeAnimationOptions }[] = [];
  const fn = vi.fn((frames: Keyframe[], opts: KeyframeAnimationOptions) => { calls.push({ frames, opts }); return { finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation; });
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = fn;
  return calls;
};
afterEach(() => { document.documentElement.removeAttribute('style'); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

describe('motionKit', () => {
  it('Web Animations が無い環境と長さ 0 では動かさない', async () => {
    tokens('420ms');
    const el = document.createElement('div');
    expect(motionOn(el)).toBe(false);
    expect(riseIn(el)).toBeNull();
    await expect(collapseOut(el)).resolves.toBeUndefined();
    fakeAnimate();
    tokens('0ms');
    expect(motionOn(el)).toBe(false);
    expect(growIn(el)).toBeNull();
  });
  it('入る形は、ぼかしを 0.2 で晴らし、--rise だけ浮かぶ', () => {
    tokens('420ms');
    const calls = fakeAnimate();
    riseIn(document.createElement('div'));
    expect(calls[0]!.frames[0]).toMatchObject({ opacity: 0, transform: 'translateY(6px)', filter: 'blur(6px)' });
    expect(calls[0]!.frames[1]).toEqual({ offset: 0.2, filter: 'none' });
    expect(calls[0]!.opts).toMatchObject({ duration: 420, easing: 'ease-out' });
  });
  it('畳んで出る形は --dur-exit と --dur-fast の和で、--ease-in で、最後の形を残す', async () => {
    tokens('100ms');
    const calls = fakeAnimate();
    await collapseOut(document.createElement('div'));
    expect(calls[0]!.opts).toMatchObject({ duration: 200, easing: 'ease-in', fill: 'forwards' });
    expect(calls[0]!.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
  });
  it('横に畳むときは幅を 0 にする', async () => {
    tokens('100ms');
    const calls = fakeAnimate();
    await collapseOut(document.createElement('div'), 'x');
    expect(calls[0]!.frames.at(-1)).toMatchObject({ width: '0px' });
  });
  it('並びの滑りは、動いていなければ何もしない', () => {
    tokens('420ms');
    const calls = fakeAnimate();
    const r = new DOMRect(0, 10, 10, 10);
    expect(slideFrom(document.createElement('div'), r, r)).toBeNull();
    slideFrom(document.createElement('div'), new DOMRect(0, 30, 10, 10), r);
    expect(calls[0]!.frames[0]).toEqual({ transform: 'translate(0px, 20px)' });
  });
  it('光らせる印は、地の動きが終わったら外す', () => {
    const el = document.createElement('div');
    markHit(el);
    expect(el).toHaveAttribute('data-hit');
    el.dispatchEvent(new Event('animationend'));
    expect(el).not.toHaveAttribute('data-hit');
  });
});

describe('layoutMotion', () => {
  it('動いている間は印を付け、止まったら外して知らせる', () => {
    const el = document.createElement('div');
    const settled = vi.fn();
    window.addEventListener(LAYOUT_SETTLED, settled);
    beginLayoutMotion(el);
    expect(el).toHaveAttribute(LAYOUT_MOVING_ATTR);
    endLayoutMotion(el);
    expect(el).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(settled).toHaveBeenCalledTimes(1);
    window.removeEventListener(LAYOUT_SETTLED, settled);
  });
});
```

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/motionKit.test.ts`
Expected: FAIL（`Failed to resolve import "./motionKit.ts"`）

- [ ] **Step 3: 実装を書く**

`packages/ui/src/views/primitives/layoutMotion.ts`：

```ts
/**
 * 本文の幅や高さが動いている間の印。
 * 端末（TerminalPane）は、祖先にこの印がある間は寸法を合わせず、LAYOUT_SETTLED で 1 度だけ合わせる。
 * 合わせるたびに寸法をサーバへ送り、tmux が描き直すからである。
 * 左のナビ、右の欄、端末の上の案内の帯が使う。
 */
export const LAYOUT_MOVING_ATTR = 'data-layout-moving';
/** 動きが止まったことを知らせる window の出来事。 */
export const LAYOUT_SETTLED = 'hangar:layout-settled';

export function beginLayoutMotion(el: HTMLElement): void {
  el.setAttribute(LAYOUT_MOVING_ATTR, '');
}

export function endLayoutMotion(el: HTMLElement): void {
  el.removeAttribute(LAYOUT_MOVING_ATTR);
  window.dispatchEvent(new Event(LAYOUT_SETTLED));
}
```

`packages/ui/src/views/primitives/motionKit.ts`：

```ts
import { motionEase, motionMs, motionValue } from './motion.ts';

/**
 * 出入りの形（設計書「共通の約束」）。長さと曲線はトークンから読み、数値を直書きしない。
 * 入る形はぼかしを 0.2 で晴らし切る（base.css の @keyframes enter と同じ理由で、WebKit が細いぼかしを 1px に丸めるため）。
 * jsdom のように Web Animations を持たない環境と、reduced motion（長さ 0）では何もしない。
 */
export function motionOn(el: Element = document.documentElement): boolean {
  return typeof (el as HTMLElement).animate === 'function' && motionMs('--dur', el) > 0;
}

const enterFrames = (el: Element): Keyframe[] => [
  { opacity: 0, transform: `translateY(${motionValue('--rise', el)})`, filter: `blur(${motionValue('--blur-in', el)})` },
  { offset: 0.2, filter: 'none' },
  { opacity: 1, transform: 'none', filter: 'none' },
];

/** 入る形。delay は ms で、トークンから読んだ値を渡す。 */
export function riseIn(el: HTMLElement, delay = 0): Animation | null {
  if (!motionOn(el)) return null;
  return el.animate(enterFrames(el), { duration: motionMs('--dur', el), delay, easing: motionEase('--ease-out', el), fill: 'backwards' });
}

/** 薄れから現すだけ（一覧を一度に入れたとき、端末の最初の描画）。 */
export function fadeIn(el: HTMLElement): Animation | null {
  if (!motionOn(el)) return null;
  return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
}

const sizeOf = (el: HTMLElement, axis: 'y' | 'x') => (axis === 'y' ? el.offsetHeight : el.offsetWidth);
const prop = (axis: 'y' | 'x') => (axis === 'y' ? 'height' : 'width');

/** 伸びて入る形。高さ（横なら幅）を 0 から伸ばし、下（右）の要素を押して滑らせる。伸びる間は中身をはみ出させない。 */
export function growIn(el: HTMLElement, axis: 'y' | 'x' = 'y'): Animation | null {
  if (!motionOn(el)) return null;
  const size = sizeOf(el, axis);
  const p = prop(axis);
  const overflow = el.style.overflow;
  el.style.overflow = 'hidden';
  const a = el.animate([
    { [p]: '0px', opacity: 0, filter: `blur(${motionValue('--blur-in', el)})` },
    { offset: 0.2, filter: 'none' },
    { [p]: `${size}px`, opacity: 1, filter: 'none' },
  ], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
  const restore = () => { el.style.overflow = overflow; };
  a.finished.then(restore, restore);
  return a;
}

/** 畳んで出る形。薄れながら高さ（横なら幅）を 0 にする。終わったら解決する。動かないときはすぐ解決する。 */
export function collapseOut(el: HTMLElement, axis: 'y' | 'x' = 'y'): Promise<void> {
  if (!motionOn(el)) return Promise.resolve();
  const size = sizeOf(el, axis);
  const p = prop(axis);
  const edge = axis === 'y' ? { paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' } : { paddingLeft: '0px', paddingRight: '0px', marginLeft: '0px', marginRight: '0px' };
  el.style.overflow = 'hidden';
  const a = el.animate([
    { [p]: `${size}px`, opacity: 1 },
    { opacity: 0, offset: 0.6 },
    { [p]: '0px', opacity: 0, ...edge },
  ], { duration: motionMs('--dur-exit', el) + motionMs('--dur-fast', el), easing: motionEase('--ease-in', el), fill: 'forwards' });
  return a.finished.then(() => undefined, () => undefined);
}

/** 並びの FLIP。前の位置から今の位置へ滑らせる。 */
export function slideFrom(el: HTMLElement, before: DOMRect, after: DOMRect): Animation | null {
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  if ((dx === 0 && dy === 0) || !motionOn(el)) return null;
  return el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
}

/** 印が替わる瞬間に 1 度だけ膨らむ（StatusDot と同じ形）。 */
export function popMark(el: HTMLElement): Animation | null {
  if (!motionOn(el)) return null;
  return el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
}

/** 地を淡い黄から薄れさせる（base.css の [data-hit]）。長さは CSS のトークンが持つ。 */
export function markHit(el: HTMLElement): void {
  el.setAttribute('data-hit', '');
  el.addEventListener('animationend', () => el.removeAttribute('data-hit'), { once: true });
}
```

`packages/ui/src/views/primitives/sidebarMotion.ts` を改める。`MOVING_ATTR` は、サイドバーだけの CSS（吹き出しを消す、項目名の形）のために残す。そのうえで、端末への知らせは layoutMotion を通す。

```ts
// 先頭の import に足す
import { beginLayoutMotion, endLayoutMotion, LAYOUT_SETTLED } from './layoutMotion.ts';

/** 動いている間 .shell に付ける印。サイドバーの CSS（吹き出しを消すなど）が使う。端末への知らせは data-layout-moving。 */
export const MOVING_ATTR = 'data-sidebar-moving';
/** 動きが止まったことを知らせる window の出来事（layoutMotion と同じもの）。 */
export { LAYOUT_SETTLED };

function settle(shell: HTMLElement): void {
  shell.removeAttribute(MOVING_ATTR);
  endLayoutMotion(shell);
}
```

`playSidebarMotion` の中の `shell.setAttribute(MOVING_ATTR, '');` の次の行に `beginLayoutMotion(shell);` を足す。
`export const LAYOUT_SETTLED = 'hangar:layout-settled';` の行は消す（上の再 export に替える）。

`packages/ui/src/views/TerminalPane.tsx`：

```ts
import { LAYOUT_MOVING_ATTR, LAYOUT_SETTLED } from './primitives/layoutMotion.ts';
// …
    // 左右の欄や案内の帯が動いている間は本文の幅や高さが毎コマ変わる。合わせ直すたびに寸法をサーバへ送るので、止まってから一度だけ合わせる。
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { if (!el.closest(`[${LAYOUT_MOVING_ATTR}]`)) host.fit(props.tabId); });
```

`packages/ui/src/views/TerminalPane.test.tsx` の import を `import { LAYOUT_MOVING_ATTR, LAYOUT_SETTLED } from './primitives/layoutMotion.ts';` にする。45〜48 行の `MOVING_ATTR` を `LAYOUT_MOVING_ATTR` に替える。テストの名前は「左右の欄が動いている間は寸法を合わせず、止まったら一度だけ合わせる」に改める。

`packages/ui/src/styles/base.css` の `@keyframes drop-in` の行の後ろに足す：

```css
/* 新しく入った行の地を、淡い黄から薄れさせる（motionKit の markHit）。検索から跳んだ行の .tr-flash と同じ長さと遅れ。 */
[data-hit] { animation: hit var(--dur-flash) var(--ease-out) var(--dur-exit) both; }
@keyframes hit { from { background-color: var(--hit); } }
@media (prefers-reduced-motion: reduce) { [data-hit] { animation: none; } }
```

`packages/ui/src/styles/motion.test.ts` の `describe('JS の動き')` に足す：

```ts
  it('出入りの形は、長さと曲線をトークンで書く', () => {
    const kit = src('motionKit.ts');
    for (const t of ["motionMs('--dur', el)", "motionMs('--dur-exit', el)", "motionMs('--dur-fast', el)", "motionEase('--ease-out', el)", "motionEase('--ease-in', el)"]) expect(kit).toContain(t);
    expect(kit).not.toMatch(/\d+ms/);
  });
```

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives packages/ui/src/views/TerminalPane.test.tsx packages/ui/src/styles/motion.test.ts`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/views/primitives/motionKit.ts packages/ui/src/views/primitives/motionKit.test.ts packages/ui/src/views/primitives/layoutMotion.ts packages/ui/src/views/primitives/sidebarMotion.ts packages/ui/src/views/TerminalPane.tsx packages/ui/src/views/TerminalPane.test.tsx packages/ui/src/styles/base.css packages/ui/src/styles/motion.test.ts
git commit -m "feat(ui): add motion kit and a shared layout-moving mark" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 出る動きを待つフックと、リストの出入りのフック

**Files:**
- Create: `packages/ui/src/views/primitives/usePresence.ts`
- Create: `packages/ui/src/views/primitives/usePresence.test.tsx`
- Create: `packages/ui/src/views/primitives/useMotionList.ts`
- Create: `packages/ui/src/views/primitives/useMotionList.test.tsx`

**Interfaces:**
- Consumes: Task 1 の `motionOn`、`riseIn`、`growIn`、`collapseOut`、`slideFrom`、`markHit`
- Produces:
  - `usePresence<E extends HTMLElement>(open: boolean, exit: (el: E) => Promise<unknown> | null): { mounted: boolean; leaving: boolean; ref: RefObject<E | null> }`
  - `useMotionList<T>(items: T[], keyOf: (t: T) => string, opts: MotionListOpts): { list: MotionEntry<T>[]; ref: (key: string) => (el: HTMLElement | null) => void }`
  - `type MotionListOpts = { enter: 'rise' | 'grow'; axis?: 'y' | 'x'; hit?: boolean; flip?: boolean; ignorePrepended?: boolean }`
  - `type MotionEntry<T> = { item: T; key: string; leaving: boolean }`

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/primitives/usePresence.test.tsx`：

```tsx
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePresence } from './usePresence.ts';

function Box(props: { open: boolean; exit: (el: HTMLDivElement) => Promise<unknown> | null }) {
  const p = usePresence<HTMLDivElement>(props.open, props.exit);
  return p.mounted ? <div ref={p.ref} data-testid="box" data-leaving={p.leaving ? 'true' : undefined} /> : null;
}

describe('usePresence', () => {
  it('出る動きが無ければ、閉じた描画で外す', () => {
    const { rerender, queryByTestId } = render(<Box open exit={() => null} />);
    expect(queryByTestId('box')).not.toBeNull();
    rerender(<Box open={false} exit={() => null} />);
    expect(queryByTestId('box')).toBeNull();
  });
  it('出る動きの間は leaving で描き続け、終わったら外す', async () => {
    let done!: () => void;
    const exit = () => new Promise<void>((r) => { done = r; });
    const { rerender, queryByTestId } = render(<Box open exit={exit} />);
    rerender(<Box open={false} exit={exit} />);
    expect(queryByTestId('box')).toHaveAttribute('data-leaving', 'true');
    await act(async () => { done(); });
    expect(queryByTestId('box')).toBeNull();
  });
  it('出る途中で開き直したら、外さずに戻す', async () => {
    let done!: () => void;
    const exit = () => new Promise<void>((r) => { done = r; });
    const { rerender, queryByTestId } = render(<Box open exit={exit} />);
    rerender(<Box open={false} exit={exit} />);
    rerender(<Box open exit={exit} />);
    await act(async () => { done(); });
    expect(queryByTestId('box')).not.toBeNull();
    expect(queryByTestId('box')).not.toHaveAttribute('data-leaving');
  });
  it('最初から閉じていれば何も描かない', () => {
    const { queryByTestId } = render(<Box open={false} exit={() => null} />);
    expect(queryByTestId('box')).toBeNull();
  });
});
```

`packages/ui/src/views/primitives/useMotionList.test.tsx`：

```tsx
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMotionList, type MotionListOpts } from './useMotionList.ts';

function List(props: { items: string[]; opts?: Partial<MotionListOpts> }) {
  const { list, ref } = useMotionList(props.items, (s) => s, { enter: 'rise', ...props.opts });
  return <ul>{list.map((e) => <li key={e.key} ref={ref(e.key)} data-leaving={e.leaving ? 'true' : undefined}>{e.item}</li>)}</ul>;
}
const texts = (c: HTMLElement) => [...c.querySelectorAll('li')].map((li) => `${li.textContent}${li.dataset.leaving ? '*' : ''}`);

let animations: { el: Element; frames: Keyframe[] }[] = [];
let finish: (() => void)[] = [];
beforeEach(() => {
  for (const [k, v] of Object.entries({ '--dur': '420ms', '--dur-fast': '200ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' })) document.documentElement.style.setProperty(k, v);
  animations = []; finish = [];
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
    animations.push({ el: this, frames });
    const finished = new Promise<void>((r) => finish.push(r));
    return { finished, cancel: vi.fn() };
  };
});
afterEach(() => { document.documentElement.removeAttribute('style'); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

describe('useMotionList', () => {
  it('最初の描画と、空から埋まった描画では動かさない', () => {
    const { rerender } = render(<List items={[]} />);
    rerender(<List items={['a', 'b']} />);
    expect(animations).toHaveLength(0);
  });
  it('新しい key だけを入れる', () => {
    const { rerender } = render(<List items={['a']} />);
    rerender(<List items={['a', 'b']} />);
    expect(animations.map((a) => a.el.textContent)).toEqual(['b']);
  });
  it('消えた key は、出る動きが終わるまで元の位置に残す', async () => {
    const { container, rerender } = render(<List items={['a', 'b', 'c']} />);
    rerender(<List items={['a', 'c']} />);
    expect(texts(container)).toEqual(['a', 'b*', 'c']);
    await act(async () => { finish.forEach((f) => f()); });
    expect(texts(container)).toEqual(['a', 'c']);
  });
  it('key が全部入れ替わったら、出入りを動かさない（サブエージェントへの切り替えなど）', () => {
    const { container, rerender } = render(<List items={['a', 'b']} />);
    rerender(<List items={['x', 'y']} />);
    expect(texts(container)).toEqual(['x', 'y']);
    expect(animations).toHaveLength(0);
  });
  it('ignorePrepended では、先頭に足された行を動かさない', () => {
    const { rerender } = render(<List items={['b', 'c']} opts={{ ignorePrepended: true }} />);
    rerender(<List items={['a', 'b', 'c', 'd']} opts={{ ignorePrepended: true }} />);
    expect(animations.map((a) => a.el.textContent)).toEqual(['d']);
  });
  it('動きの長さが 0 なら、消えた key をすぐ外す', () => {
    document.documentElement.style.setProperty('--dur', '0ms');
    const { container, rerender } = render(<List items={['a', 'b']} />);
    rerender(<List items={['a']} />);
    expect(texts(container)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/usePresence.test.tsx packages/ui/src/views/primitives/useMotionList.test.tsx`
Expected: FAIL（import が解決できない）

- [ ] **Step 3: 実装を書く**

`packages/ui/src/views/primitives/usePresence.ts`：

```ts
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * 閉じても、出る動きが終わるまで描き続ける。
 * open が偽になった描画では、まだ mounted のまま leaving を真にする。exit(el) が返す Promise が解決したら外す。
 * exit が null を返す（動かない）ときは、その描画のうちに外す（layout effect の中の更新は描く前に反映される）。
 * 出る途中で開き直したら、外さずに戻す。
 */
export function usePresence<E extends HTMLElement>(open: boolean, exit: (el: E) => Promise<unknown> | null): { mounted: boolean; leaving: boolean; ref: RefObject<E | null> } {
  const ref = useRef<E | null>(null);
  const [shown, setShown] = useState(open);
  useLayoutEffect(() => {
    if (open) { setShown(true); return; }
    const el = ref.current;
    const p = el ? exit(el) : null;
    if (!p) { setShown(false); return; }
    let alive = true;
    const done = () => { if (alive) setShown(false); };
    p.then(done, done);
    return () => { alive = false; };
    // exit は描画ごとに作り直される関数なので、依存に入れない。open が替わったときだけ動く。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return { mounted: open || shown, leaving: !open && shown, ref };
}
```

`packages/ui/src/views/primitives/useMotionList.ts`：

```ts
import { useLayoutEffect, useReducer, useRef } from 'react';
import { collapseOut, growIn, markHit, motionOn, riseIn, slideFrom } from './motionKit.ts';

export type MotionListOpts = {
  /** 入る形。rise は浮かぶだけ、grow は高さ（横なら幅）も伸ばして下の行を押す。 */
  enter: 'rise' | 'grow';
  axis?: 'y' | 'x';
  /** 入った行の地を淡い黄から薄れさせる。 */
  hit?: boolean;
  /** 残った行を前の位置から滑らせる。既定は真。 */
  flip?: boolean;
  /** 先頭に足された行（古いものの読み込み）は動かさない。 */
  ignorePrepended?: boolean;
};
export type MotionEntry<T> = { item: T; key: string; leaving: boolean };

type Ghost<T> = { item: T; after: string | null };

/**
 * リストの出入り（設計書「共通の部品」）。
 * 新しい key は入る形で入れ、消えた key は leaving のまま元の位置に残して、畳んで出る形が終わってから落とす。
 * 最初の描画、前の描画が空だった描画、key が全部入れ替わった描画では動かさない（一度に入れ替わったものは、新しい出来事ではない）。
 * 動かない環境（jsdom、reduced motion）では、消えた key をすぐ落とす。
 */
export function useMotionList<T>(items: T[], keyOf: (t: T) => string, opts: MotionListOpts): { list: MotionEntry<T>[]; ref: (key: string) => (el: HTMLElement | null) => void } {
  const nodes = useRef(new Map<string, HTMLElement>());
  const rects = useRef(new Map<string, DOMRect>());
  const ghosts = useRef(new Map<string, Ghost<T>>());
  const leavingStarted = useRef(new Set<string>());
  const prev = useRef<{ item: T; key: string }[]>([]);
  const reset = useRef(false);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const cur = items.map((item) => ({ item, key: keyOf(item) }));
  const curKeys = new Set(cur.map((c) => c.key));
  const prevKeys = new Set(prev.current.map((p) => p.key));
  // key が全部入れ替わったら、前の行は残さず、入る動きも出さない。
  reset.current = prev.current.length > 0 && cur.length > 0 && !cur.some((c) => prevKeys.has(c.key));
  if (reset.current) ghosts.current.clear();
  else if (motionOn()) {
    prev.current.forEach((p, i) => {
      if (!curKeys.has(p.key) && !ghosts.current.has(p.key)) ghosts.current.set(p.key, { item: p.item, after: i > 0 ? prev.current[i - 1]!.key : null });
    });
  }
  for (const k of [...ghosts.current.keys()]) if (curKeys.has(k)) { ghosts.current.delete(k); leavingStarted.current.delete(k); }

  const list: MotionEntry<T>[] = cur.map((c) => ({ ...c, leaving: false }));
  for (const [key, g] of ghosts.current) {
    const at = g.after === null ? 0 : list.findIndex((e) => e.key === g.after) + 1;
    list.splice(at > 0 || g.after === null ? at : list.length, 0, { item: g.item, key, leaving: true });
  }
  const before = prev.current;
  prev.current = cur;

  useLayoutEffect(() => {
    const now = new Map<string, DOMRect>();
    for (const [k, el] of nodes.current) now.set(k, el.getBoundingClientRect());
    const wasEmpty = rects.current.size === 0;
    if (!wasEmpty && !reset.current) {
      const firstOld = before.find((b) => curKeys.has(b.key))?.key;
      const prepended = new Set<string>();
      if (opts.ignorePrepended && firstOld !== undefined) for (const c of cur) { if (c.key === firstOld) break; prepended.add(c.key); }
      for (const [k, el] of nodes.current) {
        if (ghosts.current.has(k)) {
          if (leavingStarted.current.has(k)) continue;
          leavingStarted.current.add(k);
          void collapseOut(el, opts.axis).then(() => { ghosts.current.delete(k); leavingStarted.current.delete(k); tick(); });
          continue;
        }
        const was = rects.current.get(k);
        if (!was) {
          if (prepended.has(k)) continue;
          if (opts.enter === 'grow') growIn(el, opts.axis); else riseIn(el);
          if (opts.hit) markHit(el);
          continue;
        }
        if (opts.flip !== false) slideFrom(el, was, now.get(k)!);
      }
    }
    rects.current = now;
  });

  return { list, ref: (key) => (el) => { if (el) nodes.current.set(key, el); else nodes.current.delete(key); } };
}
```

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/views/primitives/usePresence.ts packages/ui/src/views/primitives/usePresence.test.tsx packages/ui/src/views/primitives/useMotionList.ts packages/ui/src/views/primitives/useMotionList.test.tsx
git commit -m "feat(ui): add presence and motion-list hooks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 左のナビを畳んだら、本文は帯のすぐ右から始める

**Files:**
- Modify: `packages/ui/src/styles/base.css:34-37`（`--gutter-l` と、新しい `--gutter-head`）
- Modify: `packages/ui/src/styles/base.css:81`（`.header-row > .search-pill`）
- Modify: `packages/ui/src/styles/session.css:23-25`（コメント）
- Modify: `packages/ui/src/styles/header.test.ts:90-99`

**Interfaces:**
- Produces: CSS 変数 `--gutter-head`（ヘッダの検索欄の左の余白）。`--gutter-l` は本文の左の余白で、いつも `calc(var(--u) * 4)`。

- [ ] **Step 1: テストを書き換える（失敗させる）**

`packages/ui/src/styles/header.test.ts` の 90〜99 行を、次の 2 つの it に替える：

```ts
  // 本文は、左のナビを畳んでも帯のすぐ右から始める（設計書 2026-10-02-session-motion ①）。
  // ロゴの右端に揃える式は、ヘッダの中でロゴの右に並ぶ検索欄にだけ使う。本文にも使うと、畳んでも本文が広がらない。
  it('本文の左の余白はいつも 16px で、ロゴに揃える式は検索欄の余白（--gutter-head）だけが持つ', () => {
    expect(base).toContain('--gutter-l: calc(var(--u) * 4);');
    expect(base).toContain('--gutter-head: max(calc(var(--u) * 4), calc(var(--head-end) - var(--col1) - var(--box-l)));');
    expect(base).toContain('--box-l: max(0px, calc((100vw - var(--col1) - var(--main-w)) / 2));');
  });
  it('本文は --gutter-l で、探す・移動の錠剤は --gutter-head で始まる', () => {
    expect(rule('.main-inner')).toMatch(/max-width: var\(--main-w\);[^}]*margin: 0 auto;[^}]*var\(--gutter-l\);/);
    expect(rule('.header-row > .search-pill')).toContain('margin-left: max(var(--gutter-head), calc((100cqw - var(--main-w)) / 2 + var(--gutter-head)));');
  });
```

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/styles/header.test.ts`
Expected: FAIL（`--gutter-l: calc(var(--u) * 4);` が無い）

- [ ] **Step 3: CSS を改める**

`base.css` の 34〜37 行のコメントと宣言を次にする：

```css
/* ヘッダの左の列に置くもの（信号の 3 点とロゴ）の右端が --head-end である。畳んだ帯は 60px しかなく、ロゴはその外まで伸びる。
   本文は --main-w を上限に本文の列の中央へ寄り（その左の余りが --box-l）、そこから --gutter-l（16px）空けて始まる。左のナビを畳んでも、帯のすぐ右から始める。
   ヘッダの検索欄は、ロゴの右に並ぶので、ロゴに重ならない間だけ --gutter-head まで右へ寄せる。畳んでいる間は、本文と検索欄の左端は揃わない（設計書 2026-10-02-session-motion ①）。 */
.shell { --head-lead: calc(var(--u) * 4); --head-end: calc(var(--head-lead) + var(--brand-w) + var(--u) * 3); --box-l: max(0px, calc((100vw - var(--col1) - var(--main-w)) / 2)); --gutter-l: calc(var(--u) * 4); --gutter-head: max(calc(var(--u) * 4), calc(var(--head-end) - var(--col1) - var(--box-l))); }
```

81 行：

```css
.header-row > .search-pill { margin-left: max(var(--gutter-head), calc((100cqw - var(--main-w)) / 2 + var(--gutter-head))); }
```

`session.css` の 23〜25 行のコメントの「--box-l と検索の錠剤の式は base.css のままで」を、「--box-l と検索の錠剤の式（--gutter-head）は base.css のままで」に改める。

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui/src/styles`
Expected: PASS（`responsive.test.ts` と `session.test.ts` も通ること）

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/styles/base.css packages/ui/src/styles/session.css packages/ui/src/styles/header.test.ts
git commit -m "feat(ui): start the body right after the folded nav rail" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 右の欄の開閉を滑らせ、閉じたら列ごと消す

**Files:**
- Create: `packages/ui/src/views/primitives/paneMotion.ts`
- Create: `packages/ui/src/views/primitives/paneMotion.test.ts`
- Modify: `packages/ui/src/views/SessionScreen.tsx:84,115-135,160-174`
- Modify: `packages/ui/src/views/TabStrip.tsx`（`trailing` を足す）
- Modify: `packages/ui/src/styles/base.css:456,474-478`
- Modify: `packages/ui/src/styles/session.css:66-73`
- Modify: `packages/ui/src/views/SessionScreen.test.tsx`
- Create: `packages/ui/src/styles/motion-session.test.ts`

**Interfaces:**
- Consumes: Task 1 の `beginLayoutMotion` と `endLayoutMotion`、Task 2 の `usePresence`
- Produces:
  - `playPaneMotion(box: HTMLElement, from: PaneShape, inner: HTMLElement | null, opening: boolean): Promise<void> | null`
  - `type PaneShape = { cols: string; gap: string }`
  - `PANE_SHAPE: { split: { open: PaneShape; closed: PaneShape }; rail: { open: PaneShape; closed: PaneShape } }`
  - `TabStrip` の新しい prop `trailing?: ReactNode`

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/primitives/paneMotion.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_MOVING_ATTR, LAYOUT_SETTLED } from './layoutMotion.ts';
import { PANE_SHAPE, playPaneMotion } from './paneMotion.ts';

afterEach(() => { document.documentElement.removeAttribute('style'); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

describe('playPaneMotion', () => {
  it('動かない環境では null を返し、印を付けない', () => {
    const box = document.createElement('div');
    expect(playPaneMotion(box, PANE_SHAPE.split.open, null, false)).toBeNull();
    expect(box).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
  });
  it('前の形を一瞬当てて測り、インラインの値は元に戻す。動いている間は印を付け、終わったら外して知らせる', async () => {
    for (const [k, v] of Object.entries({ '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--blur-in': '6px' })) document.documentElement.style.setProperty(k, v);
    const frames: Keyframe[][] = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (f: Keyframe[]) { frames.push(f); return { finished: Promise.resolve(), cancel: vi.fn() }; };
    const box = document.createElement('div');
    box.style.gridTemplateColumns = 'minmax(0, 1fr) 0px';
    document.body.appendChild(box);
    const settled = vi.fn();
    window.addEventListener(LAYOUT_SETTLED, settled);
    const p = playPaneMotion(box, PANE_SHAPE.split.open, null, false);
    expect(box).toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(box.style.gridTemplateColumns).toBe('minmax(0, 1fr) 0px');
    await p;
    expect(box).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(frames[0]![0]).toHaveProperty('gridTemplateColumns');
    window.removeEventListener(LAYOUT_SETTLED, settled);
    box.remove();
  });
  it('動きの途中でもう一度呼ぶと、前の動きを捨ててから測る（素早く 2 回押したとき）', () => {
    for (const [k, v] of Object.entries({ '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--blur-in': '6px' })) document.documentElement.style.setProperty(k, v);
    const made: { id?: string; cancel: ReturnType<typeof vi.fn> }[] = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (_f: Keyframe[], o: KeyframeAnimationOptions) { const a = { id: o.id, cancel: vi.fn(), finished: new Promise(() => {}) }; made.push(a); return a; };
    const box = document.createElement('div');
    (box as unknown as { getAnimations: unknown }).getAnimations = () => made;
    document.body.appendChild(box);
    void playPaneMotion(box, PANE_SHAPE.split.open, null, false);
    void playPaneMotion(box, PANE_SHAPE.split.closed, null, true);
    expect(made[0]!.cancel).toHaveBeenCalled();
    // 捨てられた動きの後始末で印が外れても、新しい動きの印は付いたまま。
    expect(box).toHaveAttribute('data-layout-moving');
    box.remove();
  });
});
```

`packages/ui/src/views/SessionScreen.test.tsx` の `describe('SessionScreen（実行中）')` に足す：

```tsx
  it('右の欄を閉じたら、列ごと消し、開くボタンをタブの帯の右端に出す', () => {
    withHost(<SS {...running} transcriptOpen={false} />);
    const split = document.querySelector('.split') as HTMLElement;
    expect(split.style.gridTemplateColumns).toBe('minmax(0, 1fr) 0px');
    const open = screen.getByRole('button', { name: '右の欄を開く' });
    expect(open.closest('.tabs')).not.toBeNull();
    expect(document.querySelector('.tr-pane .tr-toggle')).toBeNull();
  });
  it('開いている間は、開閉のボタンを欄の中に置き、タブの帯には出さない', () => {
    withHost(<SS {...running} />);
    expect(screen.getByRole('button', { name: '右の欄を閉じる' }).closest('.tr-pane')).not.toBeNull();
    expect(document.querySelector('.tabs .tab-pane-open')).toBeNull();
  });
```

`packages/ui/src/styles/motion-session.test.ts`：

```ts
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).flatMap((f) => [...strip(read(f)).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! })));
const body = (selector: string) => { const r = rules.filter((x) => x.selector === selector); expect(r, selector).toHaveLength(1); return r[0]!.body; };

// 設計書 2026-10-02-session-motion の見た目の規則。
describe('右の欄の開閉', () => {
  it('列の幅は CSS の transition では動かさない（minmax と px の間は補間されない。paneMotion が px で動かす）', () => {
    expect(body('.split')).not.toContain('transition');
  });
  it('余白は欄の中身の側が持ち、閉じた列は幅 0 に収まる', () => {
    expect(body('.tr-pane')).not.toMatch(/padding:/);
    expect(body('.tr-pane-inner')).toMatch(/padding:/);
  });
  it('終わった画面の右の欄も、閉じたら 0px の列にして、列の数を変えない', () => {
    expect(body(".session-body[data-rail='closed']")).toMatch(/grid-template-columns: minmax\(0, 1fr\) 0px;/);
  });
});
```

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/paneMotion.test.ts packages/ui/src/views/SessionScreen.test.tsx packages/ui/src/styles/motion-session.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装を書く**

`packages/ui/src/views/primitives/paneMotion.ts`：

```ts
import { beginLayoutMotion, endLayoutMotion } from './layoutMotion.ts';
import { motionEase, motionMs, motionValue } from './motion.ts';

/**
 * 右の欄の開閉の動き（設計書 ②、案 A「下へ潜る」）。
 * 列の幅は minmax と px の間では補間されないので、前の形と今の形の計算値（px の並び）を測り、Web Animations で埋める。
 * 前の形は、インラインの値を一瞬だけ当てて測り、元に戻す。同じ描画の中なので、戻した形は画面に出ない。
 * 欄の中身（inner）は、動きの間だけ開いたときの幅に留め、列が狭まっても折り返さずに列の端に切られる。
 * 動いている間は data-layout-moving を付け、端末は止まってから 1 度だけ寸法を合わせる。
 */
export type PaneShape = { cols: string; gap: string };

export const PANE_SHAPE = {
  /** 実行中（.split）。開いた列は今と同じ minmax(240px, 26%)。 */
  split: { open: { cols: 'minmax(0, 1fr) minmax(240px, 26%)', gap: 'calc(var(--u) * 2)' }, closed: { cols: 'minmax(0, 1fr) 0px', gap: '0px' } },
  /** 終わった画面（.session-body）。 */
  rail: { open: { cols: 'minmax(0, 1fr) 340px', gap: 'calc(var(--u) * 3)' }, closed: { cols: 'minmax(0, 1fr) 0px', gap: '0px' } },
} as const satisfies Record<string, { open: PaneShape; closed: PaneShape }>;

const ID = 'pane-motion';

function measure(box: HTMLElement, inner: HTMLElement | null) {
  const cs = getComputedStyle(box);
  return { cols: cs.gridTemplateColumns, gap: cs.columnGap, innerW: inner?.getBoundingClientRect().width ?? 0 };
}

export function playPaneMotion(box: HTMLElement, from: PaneShape, inner: HTMLElement | null, opening: boolean): Promise<void> | null {
  const dur = motionMs('--dur', box);
  if (!dur || typeof box.animate !== 'function') return null;
  // 開閉し直したら、前の動きを捨ててから測る。残すと、途中の形を前の形として測ってしまう。
  for (const a of box.getAnimations?.({ subtree: true }) ?? []) if (a.id === ID) a.cancel();
  const to = measure(box, inner);
  const saved = { cols: box.style.gridTemplateColumns, gap: box.style.columnGap };
  box.style.gridTemplateColumns = from.cols;
  box.style.columnGap = from.gap;
  const before = measure(box, inner);
  box.style.gridTemplateColumns = saved.cols;
  box.style.columnGap = saved.gap;

  beginLayoutMotion(box);
  // 中身は開いたときの幅に留める。閉じるときは前の形、開くときは今の形がその幅である。
  const width = opening ? to.innerW : before.innerW;
  if (inner && width > 0) { inner.style.width = `${width}px`; inner.style.flex = 'none'; }
  const easing = motionEase('--ease-out', box);
  const cols = box.animate([{ gridTemplateColumns: before.cols, columnGap: before.gap }, { gridTemplateColumns: to.cols, columnGap: to.gap }], { duration: dur, easing, id: ID });
  if (inner) {
    const blur = `blur(${motionValue('--blur-in', box)})`;
    if (opening) inner.animate([{ opacity: 0, filter: blur }, { offset: 0.35, filter: 'none' }, { opacity: 1, filter: 'none' }], { duration: dur, easing, id: ID });
    else inner.animate([{ opacity: 1 }, { opacity: 0, filter: blur }], { duration: motionMs('--dur-exit', box), easing: motionEase('--ease-in', box), fill: 'forwards', id: ID });
  }
  // 後始末は、いちばん新しい動きのものだけが行う。捨てた動きの後始末（非同期に来る）が、新しい動きの印や幅を外さないようにする。
  const gen = (generation.get(box) ?? 0) + 1;
  generation.set(box, gen);
  const done = () => {
    if (generation.get(box) !== gen) return;
    if (inner) { inner.style.width = ''; inner.style.flex = ''; }
    endLayoutMotion(box);
  };
  return cols.finished.then(done, () => undefined);
}

/** 箱ごとの動きの世代。 */
const generation = new WeakMap<HTMLElement, number>();
```

`packages/ui/src/views/TabStrip.tsx`：props に `trailing?: ReactNode` を足す（`import type { ReactNode } from 'react'`）。「横に並べる」のボタンの後ろに次を置く：

```tsx
      {/* 右の欄を閉じている間の、開くボタン（設計書 ②）。帯の右端に寄せる。 */}
      {props.trailing && <span className="tabs-trailing">{props.trailing}</span>}
```

`packages/ui/src/views/SessionScreen.tsx`：

1. import に `useLayoutEffect, useRef` と、`usePresence`、`PANE_SHAPE` と `playPaneMotion` を足す。
2. `paneToggle` の定義の後ろに、閉じている間の開くボタンを足す：

```tsx
  // 閉じている間は、タブの帯の右端に開くボタンを置く（設計書 ②）。開いている間は欄の見出しの行の paneToggle を使う。
  const paneOpen = <button type="button" className="btn btn-sm tab-pane-open" aria-label="右の欄を開く" title="右の欄の開閉（⌘J）" onClick={() => emit({ type: 'transcript.toggle' })}><Icon name="paneOpen" /><span>{props.livePane ? 'いま' : 'ターン'}</span><kbd className="mono">⌘J</kbd></button>;
```

3. `header` の定義の後ろ（return の前、フックは条件分岐より前）に、開閉の動きを置く：

```tsx
  // 右の欄の開閉（設計書 ②）。閉じる動きが終わるまで中身を描き続け、開いたら滑らせて広げる。
  const splitRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const shape = run && props.selectedTab ? PANE_SHAPE.split : PANE_SHAPE.rail;
  const boxRef = run && props.selectedTab ? splitRef : railRef;
  const pane = usePresence<HTMLDivElement>(props.transcriptOpen, (inner) => (boxRef.current ? playPaneMotion(boxRef.current, shape.open, inner, false) : null));
  const paneFirst = useRef(true);
  useLayoutEffect(() => {
    if (paneFirst.current) { paneFirst.current = false; return; }
    if (props.transcriptOpen && boxRef.current) void playPaneMotion(boxRef.current, shape.closed, pane.ref.current, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.transcriptOpen]);
```

   フックは `if (props.gone)` などの早い return より前に置く。今の早い return より前に、フックを呼べる位置があるか確かめる。無ければ、`header` を作った直後に置く。`gone` の分岐は `header` の後ろにある。

4. 実行中の分岐（115〜135 行）を次にする：

```tsx
        <TabStrip sessionId={id} tabs={props.tabs} canAdd={run.alive} canSplit={props.canSplit} split={props.split !== null} trailing={props.transcriptOpen ? null : paneOpen} />
        <div ref={splitRef} className="split" style={{ gridTemplateColumns: props.transcriptOpen ? PANE_SHAPE.split.open.cols : PANE_SHAPE.split.closed.cols, columnGap: props.transcriptOpen ? undefined : PANE_SHAPE.split.closed.gap }}>
          {terminals}
          <aside className="tr-pane" data-collapsed={props.transcriptOpen ? undefined : 'true'} data-leaving={pane.leaving ? 'true' : undefined}>
            {pane.mounted && (
              <div ref={pane.ref} className="tr-pane-inner">
                {(() => {
                  const toc = <TurnIndex sessionId={id} runId={run.alive ? run.id : null} rows={props.turnRows} complete={props.turnsComplete} openItems={props.openTurnItems} turnJump={props.turnJump} hasMore={props.hasMore} loading={props.loading} remaining={Math.max(props.total - props.loaded, 0)} agentId={props.agentId} lead={props.livePane ? undefined : paneToggle} />;
                  return props.livePane ? <LivePane sessionId={id} pane={props.livePane} lead={paneToggle} split={props.livePaneSplit} artifacts={props.artifacts}>{toc}</LivePane> : toc;
                })()}
              </div>
            )}
          </aside>
        </div>
```

   この形は Task 11 で、目次の親が替わらない形に組み直す。

5. 終わった画面（160〜174 行）の右の欄を、切る箱で包む：

```tsx
      <div ref={railRef} className="session-body" data-rail={props.transcriptOpen ? 'open' : 'closed'}>
        <section className="tr-sheet">{toggles}{transcript}</section>
        {pane.mounted && (
          <div className="session-rail-slot">
            <aside ref={pane.ref} className="session-rail" aria-label="このセッションのまとめ">
              <SummaryPanel {...props} />
              <TodoPanel {...props} />
              <FilesPanel {...props} />
            </aside>
          </div>
        )}
      </div>
```

   実行中の形では `div.tr-pane-inner` に、終わった形では `aside.session-rail` に、同じ `pane.ref` を付ける。usePresence の型引数は `HTMLElement` にする（`usePresence<HTMLElement>(…)`）。どちらの要素にも、ref のオブジェクトではなく関数で渡す（`ref={(el) => { pane.ref.current = el; }}`）。`RefObject<HTMLElement>` は `Ref<HTMLDivElement>` に代入できないからである。

`packages/ui/src/styles/base.css`：

- 456 行の `.split` から `transition: grid-template-columns var(--dur) var(--ease-out);` を消す。
- 474〜478 行を次にする：

```css
/* 会話の列は白い読む面にする。余白は中身の側（.tr-pane-inner）に持たせ、閉じた列（0px）に何も残さない。 */
.tr-pane { min-width: 0; border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--surface-shadow); overflow: hidden; display: flex; flex-direction: column; }
.tr-pane-inner { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: calc(var(--u) * 2) calc(var(--u) * 3); }
/* 閉じた列は、閉じる動きが終わったら影も見せない。 */
.tr-pane[data-collapsed='true']:not([data-leaving]) { visibility: hidden; }
.tr-toggle { display: inline-flex; align-items: center; justify-content: center; padding: 0; width: calc(var(--u) * 7); border: 0; background: transparent; cursor: pointer; color: var(--ink-2); height: var(--row-h); align-self: flex-start; }
.tr-pane .turns .tr-toggle { margin-left: calc(var(--u) * -2); }
/* タブの帯の右端の、右の欄を開くボタン。帯の高さ（row-h）の下端に揃え、入る形で現れる。 */
.tabs-trailing { margin-left: auto; align-self: center; }
.tab-pane-open { gap: calc(var(--u) * 1.5); animation: enter var(--dur) var(--ease-out); }
.tab-pane-open kbd { font-size: var(--fs-xs); color: var(--ink-3); }
```

`packages/ui/src/styles/session.css` の 66〜67 行：

```css
.session-body { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: calc(var(--u) * 3); }
/* 閉じた右の欄は 0px の列にし、列の数を変えない（列の数が替わると、開閉の動きが補間されない）。 */
.session-body[data-rail='closed'] { grid-template-columns: minmax(0, 1fr) 0px; column-gap: 0; }
.session-rail-slot { min-width: 0; min-height: 0; overflow: hidden; display: flex; }
.session-rail-slot > .session-rail { flex: 1; }
```

`SessionScreen.test.tsx` の既存のテスト「畳んだ会話の列だけが data-collapsed を持つ」は、そのまま通るはずである。通らなければ、aside が残ることを確かめて直す。

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck -w packages/ui`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/views/primitives/paneMotion.ts packages/ui/src/views/primitives/paneMotion.test.ts packages/ui/src/views/SessionScreen.tsx packages/ui/src/views/TabStrip.tsx packages/ui/src/styles/base.css packages/ui/src/styles/session.css packages/ui/src/views/SessionScreen.test.tsx packages/ui/src/styles/motion-session.test.ts
git commit -m "feat(ui): slide the right pane open and closed and drop the folded column" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 「いま」と目次の境目を見出し 1 行まで動かせるようにする

**Files:**
- Modify: `packages/ui/src/mediator/sidebar.ts:13-21`
- Modify: `packages/ui/src/mediator/types.ts:226`（コメントの 0.2〜0.8）
- Modify: `packages/ui/src/mediator/transition.test.ts:459`
- Modify: `packages/ui/src/views/LivePane.tsx:8,33-49,108-112`
- Modify: `packages/ui/src/views/LivePane.test.tsx`
- Modify: `packages/ui/src/styles/base.css:483-495`（`.live-top` と `.live-toc`）
- Modify: `packages/ui/src/styles/motion-session.test.ts`

**Interfaces:**
- Produces:
  - `clampLivePaneSplit(v: unknown): number`（0〜1 に丸める）
  - `snapSplit(ratio: number, m: { height: number; topMin: number; tocMin: number }, snapPx?: number): number`（`views/LivePane.tsx` から export する）

- [ ] **Step 1: 失敗するテストを書く**

`mediator/transition.test.ts:459` の期待を `0` にし、`ratio: 2` で `1` になる期待を足す：

```ts
    expect(run([intent({ type: 'livePane.split', ratio: -1 })]).state.livePaneSplit).toBe(0);
    expect(run([intent({ type: 'livePane.split', ratio: 2 })]).state.livePaneSplit).toBe(1);
```

`LivePane.test.tsx` の `describe('上下の境目')` に足す：

```tsx
    it('読み上げの範囲は 0〜100%', () => {
      at(0);
      const sep = screen.getByRole('separator');
      expect(sep).toHaveAttribute('aria-valuemin', '0');
      expect(sep).toHaveAttribute('aria-valuemax', '100');
      expect(sep).toHaveAttribute('aria-valuenow', '0');
    });
    it('矢印キーは端で 0 と 1 に止まる', () => {
      const onIntent = at(1);
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' });
      expect(onIntent).toHaveBeenLastCalledWith({ type: 'livePane.split', ratio: 1 });
    });
```

同じファイルの末尾に足す：

```tsx
describe('snapSplit', () => {
  const m = { height: 600, topMin: 36, tocMin: 70 };
  it('上の段が下限まで 24px 以内なら 0 に畳む', () => {
    expect(snapSplit(50 / 600, m)).toBe(0);
    expect(snapSplit(70 / 600, m)).toBeCloseTo(70 / 600);
  });
  it('目次が下限まで 24px 以内なら 1 に畳む', () => {
    expect(snapSplit((600 - 80) / 600, m)).toBe(1);
    expect(snapSplit((600 - 120) / 600, m)).toBeCloseTo(480 / 600);
  });
  it('高さが測れない（0）ときは畳まない', () => {
    expect(snapSplit(0.4, { height: 0, topMin: 0, tocMin: 0 })).toBe(0.4);
  });
});
```

import に `snapSplit` を足す（`import { LivePane, snapSplit } from './LivePane.tsx';`）。

`motion-session.test.ts` に足す：

```ts
describe('「いま」と目次の境目', () => {
  it('境目は上の段の高さそのもの（flex-basis）で、上限（max-height）ではない', () => {
    const top = body('.live-top');
    expect(top).toMatch(/flex: 0 1 calc\(var\(--live-split, 0\.5\) \* 100%\);/);
    expect(top).not.toMatch(/max-height/);
  });
  it('目次の下限は見出しと「最新へ」の 2 行ぶんで、5 行の下限は持たない', () => {
    expect(body('.live-toc')).not.toMatch(/\* 5\)/);
    expect(body('.live-toc')).toMatch(/min-height:/);
  });
  it('離した後と既定へ戻すときは滑らせ、ドラッグの間は追従させる', () => {
    expect(body('.live:not([data-dragging]) > .live-top')).toMatch(/transition: flex-basis var\(--dur\) var\(--ease-out\);/);
  });
});
```

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/mediator/transition.test.ts packages/ui/src/views/LivePane.test.tsx packages/ui/src/styles/motion-session.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装を書く**

`mediator/sidebar.ts`：

```ts
/** 右ペインの上下の比率を残す localStorage の鍵。値は 0〜1 の数そのもの。 */
export const LIVE_PANE_SPLIT_KEY = 'livePane.split';
/** はじめは半分。「いま」は右ペインの高さの半分までにし、残りを目次に渡す。 */
export const LIVE_PANE_SPLIT_DEFAULT = 0.5;

/** 比率を 0〜1 に丸める。どちらの端でも見出しの 1 行は CSS の下限で残る（設計書 ④）。数でなければ既定に戻す。 */
export function clampLivePaneSplit(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : LIVE_PANE_SPLIT_DEFAULT;
}
```

`mediator/types.ts:226` のコメントの「0.2〜0.8」を「0〜1」にする。

`views/LivePane.tsx`：

```ts
/** 離したとき、どちらかの端の下限までこれより近ければ、その端へ畳む（設計書 ④）。 */
const SNAP_PX = 24;

/** 離したときの比率。上の段か目次が下限まで SNAP_PX 以内なら、0 か 1 に畳む。高さが測れなければそのまま。 */
export function snapSplit(ratio: number, m: { height: number; topMin: number; tocMin: number }, snapPx = SNAP_PX): number {
  if (m.height <= 0) return ratio;
  const top = ratio * m.height;
  if (top - m.topMin < snapPx) return 0;
  if (m.height - top - m.tocMin < snapPx) return 1;
  return ratio;
}
```

`onPointerDown` を次にする。比率は、上の段の上端から測る（上の段の高さが、ドラッグした所になる）。

```ts
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const host = liveRef.current;
    const top = topRef.current;
    if (!host || !top) return;
    const rect = host.getBoundingClientRect();
    const topStart = top.getBoundingClientRect().top;
    let last = ratio;
    const move = (ev: globalThis.PointerEvent) => { last = round((ev.clientY - topStart) / rect.height); setDragging(last); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const toc = host.querySelector<HTMLElement>('.live-toc');
      const lamp = host.querySelector<HTMLElement>('.live-lamp');
      const tocMin = toc ? parseFloat(getComputedStyle(toc).minHeight) || 0 : 0;
      setDragging(null);
      emit({ type: 'livePane.split', ratio: snapSplit(last, { height: rect.height, topMin: lamp?.offsetHeight ?? 0, tocMin }) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
```

境目の要素の `aria-valuemin={20} aria-valuemax={80}` を `aria-valuemin={0} aria-valuemax={100}` にする。冒頭のコメント「上の段の高さは、境目の比率（split）を上限にし、…中身が短ければ、残りは目次に回る」を「上の段の高さは境目の比率（split）そのもので、中身が短ければ下に余白が残る。どちらの端へも、見出しの 1 行を残す所まで引ける」に改める。

`styles/base.css` の `.live-top` と `.live-toc` を次にする：

```css
/* 上の段は、境目の比率（--live-split、ペインの高さに対する割合）を高さそのものにする（設計書 ④）。中身が短ければ下に余白が残り、あふれた分はこの中でスクロールする。
   窓が低くて目次の下限を押すときは縮む（flex-shrink）。どちらの端でも、ランプの 1 行は残す。 */
.live-top { display: flex; flex-direction: column; gap: calc(var(--u) * 2); flex: 0 1 calc(var(--live-split, 0.5) * 100%); min-height: calc(var(--row-h) + var(--u) * 3); overflow-y: auto; overscroll-behavior: contain; }
.live-top > * { flex: none; }
/* 離した後と既定へ戻すときは滑らせる。ドラッグの間は指に追従させる。 */
.live:not([data-dragging]) > .live-top { transition: flex-basis var(--dur) var(--ease-out); }
```

```css
/* 目次は、見出しの 1 行と「最新へ」の行より縮めない（上の段を 1 まで引いても、目次が消えない）。 */
.live-toc { display: flex; flex-direction: column; flex: 1 1 0; min-height: calc(var(--row-h) * 2 + var(--u) * 2 + 1px); }
```

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck -w packages/ui`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/mediator/sidebar.ts packages/ui/src/mediator/types.ts packages/ui/src/mediator/transition.test.ts packages/ui/src/views/LivePane.tsx packages/ui/src/views/LivePane.test.tsx packages/ui/src/styles/base.css packages/ui/src/styles/motion-session.test.ts
git commit -m "feat(ui): let the live/toc divider go down to a single header row" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: ターンの目次の新しい行、開閉、数

**Files:**
- Create: `packages/ui/src/views/primitives/RollingText.tsx`
- Modify: `packages/ui/src/views/primitives/RollingNumber.tsx`（RollingText に委ねる）
- Modify: `packages/ui/src/views/TurnIndex.tsx`
- Modify: `packages/ui/src/views/TurnIndex.test.tsx`
- Modify: `packages/ui/src/styles/motion.test.ts`（RollingText の長さ）

**Interfaces:**
- Consumes: Task 2 の `useMotionList`、Task 1 の `growIn`、`collapseOut`、`motionOn`
- Produces: `RollingText(props: { text: string; className?: string }): JSX.Element`

- [ ] **Step 1: 失敗するテストを書く**

`TurnIndex.test.tsx` の `describe('TurnIndex')` に足す（このファイルの既存の描画の手伝い `renderIndex` などがあれば、それを使う。無ければ既存の it と同じ形で `render` する）：

```tsx
  it('見出しのターンの数は、数の回転（.roll）で出す', () => {
    renderIndex({ rows: [row(0), row(1)] });
    expect(document.querySelector('.turns-head .roll')).toHaveTextContent('2');
  });
  it('動かない環境では、新しい行が来たら末尾へすぐ追従する', () => {
    const { rerender } = renderIndex({ rows: [row(0)] });
    const list = document.querySelector('.turns-list') as HTMLElement;
    Object.defineProperty(list, 'scrollHeight', { value: 500, configurable: true });
    rerender(indexUi({ rows: [row(0), row(1)] }));
    expect(list.scrollTop).toBe(500);
  });
```

`row(n)` は `{ seq: n, when: '10:00', text: `t${n}`, head: `t${n}`, tools: 0, open: false, band: [] }` を返す。`renderIndex` と `indexUi` は、無ければこのファイルの先頭に足す：

```tsx
const indexUi = (p: Partial<TurnIndexProps> = {}) => <IntentRoot onIntent={vi.fn()}><TurnIndex sessionId="s1" runId={null} rows={[]} complete openItems={[]} turnJump={null} hasMore={false} loading={false} remaining={0} agentId={null} {...p} /></IntentRoot>;
const renderIndex = (p: Partial<TurnIndexProps> = {}) => render(indexUi(p));
```

`motion.test.ts` の「数字の回転は、長さを --dur から読む」を、RollingText に向ける：

```ts
  it('数字の回転は、長さを --dur から読む', () => {
    expect(src('RollingText.tsx')).toContain("motionMs('--dur')");
    expect(src('RollingText.tsx')).not.toMatch(/setTimeout\([^)]*,\s*\d+\)/);
  });
```

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/TurnIndex.test.tsx packages/ui/src/styles/motion.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装を書く**

`packages/ui/src/views/primitives/RollingText.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { motionMs } from './motion.ts';

/**
 * 値が変わったとき、古い値を上へ、新しい値を下から上へ --dur の長さで動かす（workbench.css の .roll）。
 * 古い値は回している間だけ置く。常に置くと同じ文字が 2 つ並び、読み上げも検索も二重になる。
 */
export function RollingText(props: { text: string; className?: string }) {
  const [prev, setPrev] = useState(props.text);
  const [rolling, setRolling] = useState(false);
  useEffect(() => {
    if (props.text === prev) return;
    const ms = motionMs('--dur');
    if (!ms) { setPrev(props.text); return; }
    setRolling(true);
    const t = setTimeout(() => { setPrev(props.text); setRolling(false); }, ms);
    return () => clearTimeout(t);
  }, [props.text, prev]);
  return (
    <span className={props.className ? `roll ${props.className}` : 'roll'} data-rolling={rolling ? 'true' : undefined}>
      {rolling && <span className="roll-old" aria-hidden="true">{prev}</span>}
      <span className="roll-new">{props.text}</span>
    </span>
  );
}
```

`RollingNumber.tsx` を、RollingText に委ねる形にする：

```tsx
import { RollingText } from './RollingText.tsx';

/** 数を回す。読めない値は「未取得」と書く。 */
export function RollingNumber(props: { value: number | null; suffix?: string }) {
  return <RollingText text={props.value === null ? '未取得' : `${props.value}${props.suffix ?? ''}`} />;
}
```

`TurnIndex.tsx`：

1. import に `useMotionList` と、`growIn`、`collapseOut`、`motionOn`、`RollingText` を足す。
2. 行の出入りを `useMotionList` に通す。古いものの読み込みは動かさない。並びの滑りは使わない（末尾に足すだけなので、残りの行は動かない）：

```tsx
  const { list, ref: rowRef } = useMotionList(props.rows, (r) => String(r.seq), { enter: 'rise', flip: false, ignorePrepended: true });
```

   `props.rows.map((r, i) => …)` を `list.map(({ item: r, key, leaving }) => …)` に替える。`i`（open と onRowKey に渡す位置）は `props.rows.indexOf(r)` で求める。leaving の行は `aria-hidden` にして、ボタンを `tabIndex={-1}` と `disabled` にする。外側の `div.turn` に `ref={(el) => { rowRef(key)(el); if (r.open && !leaving) openRef.current = el; }}` を渡す（`openRef` は `useRef<HTMLDivElement | null>(null)` に改める）。

3. 末尾への追従を滑らかにする（初回と動かない環境ではすぐ）：

```tsx
  const followed = useRef(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || openSeq !== null) return;
    const smooth = followed.current && motionOn(el) && typeof el.scrollTo === 'function';
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    if (props.rows.length > 0) followed.current = true;
  }, [lastSeq, openSeq]);
```

4. ターンの中身の開閉。開いたら伸びて入り、閉じたら畳んで出る。閉じる間は、閉じたターンの中身を控えで描き続ける：

```tsx
  // 閉じたターンの中身の控え。畳んで出る動きの間だけ描く。
  const lastOpen = useRef<{ seq: number; items: TranscriptItem[] } | null>(null);
  const [closing, setClosing] = useState<{ seq: number; items: TranscriptItem[] } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = openSeq === null ? null : { seq: openSeq, items: props.openItems };
    if (was && was.seq !== openSeq && motionOn()) setClosing(was);
    if (openSeq !== null && was?.seq !== openSeq && bodyRef.current) growIn(bodyRef.current);
  }, [openSeq]);
  useLayoutEffect(() => {
    if (!closing || !closingRef.current) return;
    let alive = true;
    void collapseOut(closingRef.current).then(() => { if (alive) setClosing(null); });
    return () => { alive = false; };
  }, [closing]);
```

   描画では、`r.open` の行に今の `.turn-body`（`ref={bodyRef}`）を出す。`closing?.seq === r.seq && !r.open` の行には、`<div ref={closingRef} className="turn-body" aria-hidden="true">` を出し、中身は `closing.items` から今と同じく描く。

5. 見出しの数を回す：

```tsx
        <span className="faint">ターン <RollingText text={`${props.rows.length}${props.hasMore ? '+' : ''}`} /></span>
```

   既存のテストが `ターン 2` の文字列で引いているなら、`.roll-new` の文字で揃う。通らないテストは、文字列の一致を `toHaveTextContent` に改める。

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck -w packages/ui`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/views/primitives/RollingText.tsx packages/ui/src/views/primitives/RollingNumber.tsx packages/ui/src/views/TurnIndex.tsx packages/ui/src/views/TurnIndex.test.tsx packages/ui/src/styles/motion.test.ts
git commit -m "feat(ui): animate new turns, turn bodies and the turn count" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 「いま」の意図、手、レーン、成果物

**Files:**
- Modify: `packages/ui/src/presenters/live.ts:6,70-87`（手に key）
- Modify: `packages/ui/src/presenters/live.test.ts`（手の期待に key を足す）
- Modify: `packages/ui/src/views/LivePane.tsx:55-107`
- Modify: `packages/ui/src/views/LivePane.test.tsx`
- Modify: `packages/ui/src/styles/base.css`（`.live-intent`、`.live-lane`、`.live-lane-line`、`.live-lamp`）

**Interfaces:**
- Consumes: Task 2 の `useMotionList`、Task 1 の `riseIn`、`popMark`、`motionOn`、`motionMs`
- Produces: `StepRowProps` に `key: string`（その行の最初の手の seq を文字列にしたもの）

- [ ] **Step 1: 失敗するテストを書く**

`presenters/live.test.ts` に足す：

```ts
  it('手の行は、その行の最初の手の seq を key に持つ（畳んだ読みの行も最初の手）', () => {
    // このファイルの既存の入力の作り方（LiveInput の手伝い）で、seq 10 と 11 の Read と、seq 12 の Edit を並べる。
    const steps = presentLivePane(inputWith([read(10), read(11), edit(12)])).steps;
    expect(steps.map((s) => s.key)).toEqual(['10', '12']);
  });
```

`inputWith`、`read`、`edit` は、このファイルにある既存の手伝いの名前に合わせる。無ければ、既存の「続けて読んだ手は 1 行に畳む」テストの入力を写して使う。

`LivePane.test.tsx` に足す：

```tsx
  it('意図の箱は 1 つで、古い文の控えは動かない環境では出さない', () => {
    const { rerender } = render(<IntentRoot onIntent={vi.fn()}><LivePane sessionId="s1" pane={pane({ intent: { kind: 'said', text: 'A', meta: 'm', stale: false } })}><div /></LivePane></IntentRoot>);
    rerender(<IntentRoot onIntent={vi.fn()}><LivePane sessionId="s1" pane={pane({ intent: { kind: 'said', text: 'B', meta: 'm', stale: false } })}><div /></LivePane></IntentRoot>);
    expect(document.querySelectorAll('.live-intent')).toHaveLength(1);
    expect(document.querySelector('.live-intent-ghost')).toBeNull();
    expect(document.querySelector('.live-intent')).toHaveTextContent('B');
  });
```

`pane(over)` は、このファイルの既存の `pane()` の手伝いが上書きを受け取らないなら、`(over = {}) => ({ ...今の既定, ...over })` に広げる。

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/presenters/live.test.ts packages/ui/src/views/LivePane.test.tsx`
Expected: FAIL（`key` が undefined）

- [ ] **Step 3: 実装を書く**

`presenters/live.ts`：

```ts
export type StepRowProps = { key: string; text: string; mono: boolean; when: string; mark: 'done' | 'now' | 'fail' };
```

`mainSteps` の `rows.push({ ...line, … })` に `key: String(c.seq)` を足す（畳んだ読みの行は、最初の手の key のまま残る）。

`views/LivePane.tsx`：

1. 意図の箱を、`IntentBox` に出す：

```tsx
/**
 * 意図の箱（設計書 ⑤、案 A「入れ替え」）。
 * 文が替わったら、古い文は箱の中に重ねて上へ抜けながら薄れ、新しい文は --dur-exit の半分だけ遅れて入る。箱の高さは古い高さから滑る。
 * 最初の描画と、動かない環境では何もしない。
 */
function IntentBox({ text, meta, stale }: { text: string; meta: string; stale: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<{ text: string; meta: string; h: number } | null>(null);
  const [ghost, setGhost] = useState<{ text: string; meta: string } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const was = prev.current;
    prev.current = { text, meta, h: el.offsetHeight };
    if (!was || was.text === text || !motionOn(el)) return;
    setGhost({ text: was.text, meta: was.meta });
    el.animate([{ height: `${was.h}px` }, { height: `${el.offsetHeight}px` }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
    for (const c of el.querySelectorAll<HTMLElement>(':scope > .live-intent-now')) riseIn(c, motionMs('--dur-exit', el) / 2);
  }, [text]);
  useLayoutEffect(() => {
    const g = ref.current?.querySelector<HTMLElement>('.live-intent-ghost');
    if (!g || typeof g.animate !== 'function') return;
    const a = g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(calc(${motionValue('--rise', g)} * -1))`, filter: `blur(${motionValue('--blur-in', g)})` }], { duration: motionMs('--dur-exit', g), easing: motionEase('--ease-in', g), fill: 'forwards' });
    let alive = true;
    a.finished.then(() => { if (alive) setGhost(null); }, () => {});
    return () => { alive = false; };
  }, [ghost]);
  return (
    <div ref={ref} className="live-intent" data-stale={stale ? 'true' : undefined}>
      <span className="live-intent-now">「{text}」<span className="live-intent-meta">{meta}</span></span>
      {ghost && <span className="live-intent-ghost" aria-hidden="true">「{ghost.text}」<span className="live-intent-meta">{ghost.meta}</span></span>}
    </div>
  );
}
```

   今の `.live-intent` の行は `<IntentBox text={pane.intent.text} meta={pane.intent.meta} stale={pane.intent.stale} />` に替える。import に `motionEase`、`motionMs`、`motionValue`（`./primitives/motion.ts`）と、`motionOn`、`riseIn`、`popMark`（`./primitives/motionKit.ts`）、`useMotionList` を足す。

2. 手を `useMotionList` に通し、済んだ印を 1 度膨らませる：

```tsx
function StepRow({ s, rowRef, leaving }: { s: StepRowProps; rowRef: (el: HTMLElement | null) => void; leaving: boolean }) {
  const ic = useRef<HTMLSpanElement>(null);
  const prev = useRef(s.mark);
  useLayoutEffect(() => {
    if (prev.current === 'now' && s.mark !== 'now' && ic.current) popMark(ic.current);
    prev.current = s.mark;
  }, [s.mark]);
  return (
    <div ref={rowRef} className="live-step" data-mark={s.mark} aria-hidden={leaving ? 'true' : undefined}>
      <span ref={ic} className="live-step-ic">{s.mark === 'fail' ? '✕' : s.mark === 'now' ? <span className="live-dot" data-tone="busy" /> : '✓'}</span>
      <span className={s.mono ? 'live-step-text mono' : 'live-step-text'}>{s.text}</span>
      <span className="live-step-when mono">{s.when}</span>
    </div>
  );
}
```

   LivePane の本体では次のようにする（フックは条件分岐の外で呼ぶ）：

```tsx
  const steps = useMotionList(pane.steps, (s) => s.key, { enter: 'grow' });
  const lanes = useMotionList(pane.lanes, (l) => l.agentId, { enter: 'grow' });
  const arts = useMotionList(artifacts, (a) => a.id, { enter: 'grow', hit: true });
```

   - 手の節の出し方の条件は `steps.list.length > 0` にし、`steps.list.map(({ item, key, leaving }) => <StepRow key={key} s={item} rowRef={steps.ref(key)} leaving={leaving} />)` で描く。
   - レーンと成果物も同じく `.list` で描く。各要素に `ref={lanes.ref(key)}` を付ける。leaving のときは `aria-hidden` と `disabled`（ボタン）にする。
   - 成果物の行の外側の `div.live-artifact` に ref を付ける。

`styles/base.css`：

```css
/* 意図の箱。文の入れ替えの間は、古い文の控え（.live-intent-ghost）を同じ位置に重ねる。 */
.live-intent { position: relative; overflow: hidden; padding: calc(var(--u) * 1.25) calc(var(--u) * 2.25); border-left: 3px solid var(--cand); border-radius: 0 var(--r) var(--r) 0; background: var(--cand-soft); font-size: var(--fs); transition: opacity var(--dur-fast) var(--ease-out); }
.live-intent-now { display: block; }
.live-intent-ghost { position: absolute; top: calc(var(--u) * 1.25); left: calc(var(--u) * 2.25); right: calc(var(--u) * 2.25); pointer-events: none; }
```

- `.live-intent-meta` は `display: block` のままにする。
- `.live-lane` の規則の末尾に `transition: background var(--dur) var(--ease-out);` を足す。
- `.live-lane-line` の規則の末尾に `transition: color var(--dur) var(--ease-out);` を足す。
- `.live-lamp` の規則の末尾に `transition: background var(--dur) var(--ease-out), color var(--dur) var(--ease-out);` を足す。
- `.live-step` の規則の末尾に `transition: color var(--dur) var(--ease-out);` を足す。

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck -w packages/ui`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/presenters/live.ts packages/ui/src/presenters/live.test.ts packages/ui/src/views/LivePane.tsx packages/ui/src/views/LivePane.test.tsx packages/ui/src/styles/base.css
git commit -m "feat(ui): animate intent swaps, steps, lanes and artifacts in the live pane" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 見出し周りとタブ

**Files:**
- Modify: `packages/ui/src/views/SessionScreen.tsx:71`（要約の一行）、`:182-236`（InfoLine）
- Modify: `packages/ui/src/views/TabStrip.tsx`
- Modify: `packages/ui/src/styles/session.css`（`.session-oneliner` の入る動き）
- Modify: `packages/ui/src/styles/base.css`（`@keyframes enter-x`）
- Modify: `packages/ui/src/styles/motion.test.ts`（現れる動きの一覧）
- Modify: `packages/ui/src/views/SessionScreen.test.tsx`

**Interfaces:**
- Consumes: Task 2 の `useMotionList`、Task 6 の `RollingText`

- [ ] **Step 1: 失敗するテストを書く**

`motion.test.ts` の `it.each` の一覧に足す（keyframes の形は同じく from と 20% を持つ）：

```ts
    ['.session-oneliner', 'enter-x'],
```

`SessionScreen.test.tsx` に足す：

```tsx
  it('情報の行の数（ターン、トークン、コスト）は数の回転で出す', () => {
    withHost(<SS {...running} cost="$1.20" />);
    const info = document.querySelector('.session-info')!;
    expect(info.querySelectorAll('.roll').length).toBeGreaterThanOrEqual(3);
  });
  it('要約の一行は、文が替わると作り直す（入る動きをもう一度出す）', () => {
    const { rerender } = render(<IntentRoot onIntent={vi.fn()}><SS {...base} live={null} /></IntentRoot>);
    const first = document.querySelector('.session-oneliner');
    rerender(<IntentRoot onIntent={vi.fn()}><SS {...base} live={null} summary={{ ...base.summary!, oneLiner: 'TWO' }} /></IntentRoot>);
    expect(document.querySelector('.session-oneliner')).not.toBe(first);
  });
```

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/SessionScreen.test.tsx packages/ui/src/styles/motion.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装を書く**

`SessionScreen.tsx:71` の要約の一行に `key` を付ける：

```tsx
        {props.summary?.oneLiner ? <span key={props.summary.oneLiner} className="session-oneliner" title={props.summary.oneLiner}>{props.summary.oneLiner}</span> : <span className="spacer" />}
```

InfoLine の数を `RollingText` で出す：

```tsx
      {props.cost ? <span className="mono"><RollingText text={props.cost} /></span> : <span className="faint">コスト 未取得</span>}
      {props.filesChanged > 0 && <span>変更 <RollingText text={String(props.filesChanged)} /></span>}
      <span><RollingText text={String(props.turns)} /> ターン · <RollingText text={props.tokens} /> トークン</span>
```

`base.css` の `@keyframes drop-in` の近くに足す：

```css
/* 横から入る形（要約の一行）。左から --rise だけ寄りながら、ぼかしが晴れる。 */
@keyframes enter-x { from { opacity: 0; transform: translateX(calc(var(--rise) * -1)); filter: blur(var(--blur-in)); } 20% { filter: none; } }
```

`session.css` の `.session-oneliner` の規則に `animation: enter-x var(--dur) var(--ease-out);` を足す。規則が無ければ、`.session-oneliner { animation: enter-x var(--dur) var(--ease-out); }` を作る。

`TabStrip.tsx`：

```tsx
  const { list, ref: tabRef } = useMotionList(props.tabs, (t) => t.id, { enter: 'grow', axis: 'x' });
```

`props.tabs.map((t, i) => …)` を `list.map(({ item: t, key, leaving }) => …)` に替える。`i` は `props.tabs.indexOf(t)` で求める。

- leaving のタブは `role="presentation"` にし、`aria-hidden`、tabIndex なし、onClick なし、閉じるボタンなしで描く。
- それ以外は今と同じに描き、外側の div に `ref={tabRef(key)}` を付ける。

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck -w packages/ui`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/views/SessionScreen.tsx packages/ui/src/views/TabStrip.tsx packages/ui/src/styles/session.css packages/ui/src/styles/base.css packages/ui/src/styles/motion.test.ts packages/ui/src/views/SessionScreen.test.tsx
git commit -m "feat(ui): animate the summary line, info numbers and tabs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: ターミナルの上の案内の帯と、最初の描画

**Files:**
- Modify: `packages/ui/src/runtime/terminals.ts:19,62,92,130`（`painted`）
- Modify: `packages/ui/src/runtime/terminals.test.ts`
- Modify: `packages/ui/src/views/TerminalPane.tsx`
- Modify: `packages/ui/src/views/TerminalPane.test.tsx`
- Modify: 偽の TerminalHost を持つテスト（`Root.test.tsx`、`runtime/runtime.test.ts`、`views/SessionScreen.test.tsx`、`views/TerminalPane.test.tsx`）
- Modify: `packages/ui/src/styles/base.css`（`.term-host` の透明）

**Interfaces:**
- Consumes: Task 2 の `usePresence`、Task 1 の `growIn`、`collapseOut`、`fadeIn`、`beginLayoutMotion`、`endLayoutMotion`
- Produces: `TerminalHost.painted(tabId: string): boolean`（そのタブに最初のデータが届いたか。知らないタブは true）

- [ ] **Step 1: 失敗するテストを書く**

`runtime/terminals.test.ts` に足す。このファイルの既存の偽の WebSocket で `onmessage` を呼ぶ手伝いを使う：

```ts
  it('最初のデータが届くまで painted は偽で、届いたら真になって知らせる', () => {
    const { host, sockets } = setup();            // このファイルの既存の作り方に合わせる
    const cb = vi.fn();
    host.subscribe(cb);
    host.connect('t1');
    expect(host.painted('t1')).toBe(false);
    sockets[0]!.onmessage!({ data: JSON.stringify({ t: 'data', d: 'hi' }) } as MessageEvent);
    expect(host.painted('t1')).toBe(true);
    expect(cb).toHaveBeenCalled();
  });
  it('知らないタブは描けている扱いにする', () => {
    const { host } = setup();
    expect(host.painted('nope')).toBe(true);
  });
```

`TerminalPane.test.tsx` に足す：

```tsx
  it('最初のデータが届くまで、端末の面は data-painted="false" で透明にしておく', () => {
    const host = { ...fakeHost(), painted: () => false };
    render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint={null} live={null} /></TerminalHostContext.Provider>);
    expect(document.querySelector('.term-host')).toHaveAttribute('data-painted', 'false');
  });
  it('案内が消えたら、動かない環境ではすぐ外す', () => {
    const host = fakeHost();
    const { rerender } = render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint="待っています" live={null} /></TerminalHostContext.Provider>);
    rerender(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint={null} live={null} /></TerminalHostContext.Provider>);
    expect(screen.queryByRole('status')).toBeNull();
  });
```

`fakeHost()` に `painted: () => true` を足す。ほかのテストの偽の host（`Root.test.tsx`、`runtime/runtime.test.ts`、`SessionScreen.test.tsx` の `host`）にも `painted: () => true` を足す。

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/runtime/terminals.test.ts packages/ui/src/views/TerminalPane.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装を書く**

`runtime/terminals.ts`：

- `TerminalHost` の型に足す：`/** 最初のデータが届いたか。知らないタブは true（隠さない）。 */ painted(tabId: string): boolean;`
- `Entry` に `painted: boolean` を足し、92 行の初期値は `painted: false` にする。
- 130 行を次にする：

```ts
      if (msg.t === 'data' && typeof msg.d === 'string') { e.term.write(msg.d); if (!e.painted) { e.painted = true; notify(); } }
```

- host の実装に足す：`painted(tabId) { return entries.get(tabId)?.painted ?? true; },`

`TerminalPane.tsx`：

1. 案内（hint）と transcript の帯を、出る動きが終わるまで描く。控えは ref に残す：

```tsx
  const paneRef = useRef<HTMLDivElement>(null);
  // 帯の高さが変わる間は端末の寸法を合わせない（設計書 ⑧）。
  const withLayout = (run: () => Promise<void>) => {
    const p = paneRef.current;
    if (!p || !motionOn(p)) return null;
    beginLayoutMotion(p);
    return run().then(() => endLayoutMotion(p));
  };
  const lastHint = useRef(props.hint);
  if (props.hint) lastHint.current = props.hint;
  const hint = usePresence<HTMLDivElement>(props.hint !== null, (el) => withLayout(() => collapseOut(el)));
  const lastBand = useRef(props.transcript ?? null);
  if (props.transcript) lastBand.current = props.transcript;
  const band = usePresence<HTMLDivElement>(!!props.transcript, (el) => withLayout(() => collapseOut(el)));
  // 入るときは伸ばして、下の端末の面を押し下げる。最初の描画では動かさない。
  const shown = useRef({ hint: props.hint !== null, band: !!props.transcript });
  useLayoutEffect(() => {
    const p = paneRef.current;
    const grow = (el: HTMLElement | null) => { if (!el || !p) return; const a = growIn(el); if (a) { beginLayoutMotion(p); a.finished.then(() => endLayoutMotion(p), () => endLayoutMotion(p)); } };
    if (props.hint !== null && !shown.current.hint) grow(hint.ref.current);
    if (props.transcript && !shown.current.band) grow(band.ref.current);
    shown.current = { hint: props.hint !== null, band: !!props.transcript };
  }, [props.hint !== null, !!props.transcript]);
```

   描画は次のとおり：

```tsx
    <div ref={paneRef} className="term-pane" …>
      {band.mounted && lastBand.current && (
        <div ref={band.ref} className="term-band" aria-hidden={band.leaving ? 'true' : undefined}>
          {/* 中身は今と同じ。props.transcript の代わりに lastBand.current を使う。 */}
        </div>
      )}
      {hint.mounted && <div ref={hint.ref} className="term-hint" role={hint.leaving ? undefined : 'status'}>{props.hint ?? lastHint.current}</div>}
```

2. 端末の面に「最初の描画が済んだか」を渡す：

```tsx
      <div key={props.tabId} ref={ref} className="term-host" data-tab={props.tabId} data-painted={host?.painted(props.tabId) === false ? 'false' : undefined} onClick={() => host?.focus(props.tabId)} />
```

`styles/base.css` の `.term-host` を次にする：

```css
/* 初めてつなぐときは、最初のデータが届くまで面を透明にし、届いたら --dur で現す（設計書 ⑨）。一度描いたタブは付け替えても透明にしない。 */
.term-host { flex: 1; min-height: 0; padding: var(--u); transition: opacity var(--dur) var(--ease-out); }
.term-host[data-painted='false'] { opacity: 0; }
```

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck -w packages/ui`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/runtime/terminals.ts packages/ui/src/runtime/terminals.test.ts packages/ui/src/views/TerminalPane.tsx packages/ui/src/views/TerminalPane.test.tsx packages/ui/src/Root.test.tsx packages/ui/src/runtime/runtime.test.ts packages/ui/src/views/SessionScreen.test.tsx packages/ui/src/styles/base.css
git commit -m "feat(ui): animate terminal bands and fade in the first terminal paint" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 目次の仮の行（開いた直後）

**Files:**
- Modify: `packages/ui/src/presenters/session.ts:36,271,344`（`turnsPending`）
- Modify: `packages/ui/src/presenters/session.test.ts`
- Modify: `packages/ui/src/views/TurnIndex.tsx`
- Modify: `packages/ui/src/views/TurnIndex.test.tsx`
- Modify: `packages/ui/src/views/SessionScreen.tsx`（`pending` を渡す）
- Modify: `packages/ui/src/views/SessionScreen.test.tsx:21`（`base` に `turnsPending: false`）
- Modify: `packages/ui/src/styles/base.css`（`.turn-skel`）

**Interfaces:**
- Consumes: Task 1 の `fadeIn`
- Produces: `SessionProps.turnsPending: boolean`、`TurnIndexProps.pending?: boolean`

- [ ] **Step 1: 失敗するテストを書く**

`presenters/session.test.ts` に足す（このファイルの既存の store の作り方に合わせる）：

```ts
  it('本文の窓がまだ無いか、最初の読み込みの途中で 0 件なら、目次は pending', () => {
    expect(presentSession(storeWithSession('s1'), 's1').turnsPending).toBe(true);           // 窓が無い
    expect(presentSession(storeWithSlice('s1', { loading: true, items: [] }), 's1').turnsPending).toBe(true);
    expect(presentSession(storeWithSlice('s1', { loading: false, items: [] }), 's1').turnsPending).toBe(false);
  });
```

`TurnIndex.test.tsx` に足す：

```tsx
  it('届くまでは仮の行を 6 つ出し、「まだ指示がありません」は出さない', () => {
    renderIndex({ rows: [], pending: true });
    expect(document.querySelectorAll('.turn-skel')).toHaveLength(6);
    expect(screen.queryByText('まだ指示がありません')).toBeNull();
  });
```

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/presenters/session.test.ts packages/ui/src/views/TurnIndex.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装を書く**

`presenters/session.ts`：

- `SessionProps` に `turnsPending: boolean` を足す。
- `base`（271 行）に `turnsPending: false` を足す。
- 344 行の近く（`items` などを作る所）に、`turnsPending: !slice || (slice.loading && slice.items.length === 0)` を足す。

`TurnIndex.tsx`：

- props に `/** 最初の events が届く前。仮の行を出す。 */ pending?: boolean;` を足す。
- 一覧の中の、今の「まだ指示がありません」の行を次にする：

```tsx
        {props.rows.length === 0 && props.pending && Array.from({ length: 6 }, (_, i) => <div key={`skel${i}`} className="turn-skel" style={{ width: `${70 + ((i * 37) % 30)}%` }} aria-hidden="true" />)}
        {props.rows.length === 0 && !props.loading && !props.pending && <div className="empty">まだ指示がありません</div>}
```

- 仮の行から本物の行へ替わった描画で、一覧を薄れから現す：

```tsx
  const wasPending = useRef(props.pending && props.rows.length === 0);
  useLayoutEffect(() => {
    if (wasPending.current && props.rows.length > 0 && listRef.current) fadeIn(listRef.current);
    wasPending.current = !!props.pending && props.rows.length === 0;
  }, [props.rows.length, props.pending]);
```

`SessionScreen.tsx` の TurnIndex に `pending={props.turnsPending}` を渡す。`SessionScreen.test.tsx` の `base` に `turnsPending: false` を足す。

`styles/base.css`：

```css
/* 目次の仮の行。最初の events が届くまで、淡い帯をゆっくり流す。reduced motion では流さない。 */
.turn-skel { flex: none; height: 26px; margin: 2px 0; border-radius: var(--r); background: linear-gradient(90deg, var(--surface-2), #fafbfd, var(--surface-2)); background-size: 200% 100%; animation: skel var(--aura-period) linear infinite; }
@keyframes skel { to { background-position: -2000% 0; } }
@media (prefers-reduced-motion: reduce) { .turn-skel { animation: none; } }
```

（周期は既存の `--aura-period`（24s）を使い、`background-position` を 10 周ぶん動かして、1 周を 2.4s にする。新しいトークンは作らない。）

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck -w packages/ui`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/presenters/session.ts packages/ui/src/presenters/session.test.ts packages/ui/src/views/TurnIndex.tsx packages/ui/src/views/TurnIndex.test.tsx packages/ui/src/views/SessionScreen.tsx packages/ui/src/views/SessionScreen.test.tsx packages/ui/src/styles/base.css
git commit -m "feat(ui): show placeholder turn rows until the first events arrive" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 会話が終わったとき・再開したときの「いま」の出入り

**Files:**
- Modify: `packages/ui/src/views/LivePane.tsx`（`pane` を null にでき、`leaving` を受け取る）
- Modify: `packages/ui/src/views/LivePane.test.tsx`
- Modify: `packages/ui/src/views/SessionScreen.tsx`（実行中の右の欄の組み）
- Modify: `packages/ui/src/views/SessionScreen.test.tsx`

**Interfaces:**
- Consumes: Task 2 の `usePresence`、Task 1 の `slideFrom`、`riseIn`、`motionOn`
- Produces: `LivePane` の props を `{ pane: LivePaneProps | null; leaving?: boolean; … }` にする。`pane` が null のときは目次（children）だけを描く。

- [ ] **Step 1: 失敗するテストを書く**

`SessionScreen.test.tsx` の `describe('SessionScreen（実行中）')` に足す：

```tsx
  it('「いま」が消えても目次は作り直さない（スクロールの位置を保つ）', () => {
    const livePane = { lamp: { tone: 'busy' as const, head: '作業中', sub: '' }, intent: { kind: 'none' as const, text: 'x' }, steps: [], lanes: [], doneFolded: 0 };
    const ui = (lp: typeof livePane | null) => <IntentRoot onIntent={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} livePane={lp} /></TerminalHostContext.Provider></IntentRoot>;
    const { rerender } = render(ui(livePane));
    const before = document.querySelector('.turns');
    rerender(ui(null));
    expect(document.querySelector('.live-top')).toBeNull();
    expect(document.querySelector('.turns')).toBe(before);
    rerender(ui(livePane));
    expect(document.querySelector('.live-top')).not.toBeNull();
    expect(document.querySelector('.turns')).toBe(before);
  });
```

`LivePane.test.tsx` に足す：

```tsx
  it('pane が無ければ目次だけを描き、見出しと上の段と境目を出さない', () => {
    render(<IntentRoot onIntent={vi.fn()}><LivePane sessionId="s1" pane={null}><div>目次</div></LivePane></IntentRoot>);
    expect(screen.getByText('目次')).toBeInTheDocument();
    expect(document.querySelector('.live-top')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });
```

- [ ] **Step 2: 流して、失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/SessionScreen.test.tsx packages/ui/src/views/LivePane.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装を書く**

`LivePane.tsx`：

- props の `pane` を `LivePaneProps | null` にし、`leaving?: boolean` を足す。
- フック（useMotionList など）は、pane が null でも呼べるように `pane?.steps ?? []` で呼ぶ。
- 描画は、親の `div.live` と子の `div.live-toc` を常に同じ位置に置く。React が目次を同じ要素として保つように、条件の要素は `{cond && …}` で前に並べる。

```tsx
  return (
    <div ref={liveRef} className="live" data-off={pane ? undefined : 'true'} data-leaving={leaving ? 'true' : undefined} data-dragging={…} style={…}>
      {pane && <div className="live-pane-head">{lead}<span className="faint">いま</span></div>}
      {pane && <div ref={topRef} className="live-top" …>{/* 今の中身 */}</div>}
      {pane && <div className="live-divider" …/>}
      <div ref={tocRef} className="live-toc">{children}</div>
    </div>
  );
```

- 目次の位置が替わったら、前の位置から滑らせる。上の段が戻ったときは、上の段を入る形で入れる：

```tsx
  const tocRef = useRef<HTMLDivElement>(null);
  const tocTop = useRef<DOMRect | null>(null);
  const had = useRef(pane !== null);
  useLayoutEffect(() => {
    const toc = tocRef.current;
    if (!toc) return;
    const now = toc.getBoundingClientRect();
    if (had.current !== (pane !== null) && tocTop.current) {
      slideFrom(toc, tocTop.current, now);
      if (pane && topRef.current) riseIn(topRef.current);
    }
    had.current = pane !== null;
    tocTop.current = now;
  });
```

`SessionScreen.tsx` の実行中の右の欄（Task 4 で書いた形）を、目次の親が替わらない形にする：

```tsx
  // 「いま」の出入り（設計書 ⑩）。消えるときは、ランプの色が替わるのを待ってから、見出し、上の段、境目を薄れさせ、終わったら外す。
  const lastLive = useRef(props.livePane);
  if (props.livePane) lastLive.current = props.livePane;
  const live = usePresence<HTMLDivElement>(props.livePane !== null, (el) => {
    if (!motionOn(el)) return null;
    const parts = el.querySelectorAll<HTMLElement>(':scope > .live-pane-head, :scope > .live-top, :scope > .live-divider');
    const blur = `blur(${motionValue('--blur-in', el)})`;
    const anims = [...parts].map((p) => p.animate([{ opacity: 1 }, { opacity: 0, filter: blur }], { duration: motionMs('--dur-exit', el), delay: motionMs('--dur', el), easing: motionEase('--ease-in', el), fill: 'forwards' }));
    return Promise.all(anims.map((a) => a.finished)).catch(() => undefined);
  });
```

`pane.mounted` の中身を次にする：

```tsx
              <div ref={pane.ref} className="tr-pane-inner">
                <LivePane ref={live.ref} sessionId={id} pane={live.mounted ? (props.livePane ?? lastLive.current) : null} leaving={live.leaving} lead={paneToggle} split={props.livePaneSplit} artifacts={props.artifacts}>
                  <TurnIndex … lead={live.mounted ? undefined : paneToggle} />
                </LivePane>
              </div>
```

LivePane に ref を渡すため、`LivePane` は React 19 の「ref を props で受け取る」形にする。props に `ref?: Ref<HTMLDivElement>` を足し、`liveRef` と合わせて付ける。合わせ方は `ref={(el) => { liveRef.current = el; if (typeof props.ref === 'function') props.ref(el); else if (props.ref) props.ref.current = el; }}` とする。

`import` に `motionOn` と、`motionEase`、`motionMs`、`motionValue` を足す。

既存のテスト「実行中は成果物を右の欄の「いま」に並べ、…」と「実行中の右欄は会話の全文ではなくターンの目次にする」が通ることを確かめる。

- [ ] **Step 4: 流して、通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck -w packages/ui`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/views/LivePane.tsx packages/ui/src/views/LivePane.test.tsx packages/ui/src/views/SessionScreen.tsx packages/ui/src/views/SessionScreen.test.tsx
git commit -m "feat(ui): fold the live section away when a run ends and keep the turn index mounted" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: ビルドして WebKit で目で確かめ、設計書を本体へ移す

**Files:**
- Modify: `docs/design.md`（セッション画面の節）
- Modify: `docs/superpowers/specs/2026-10-02-session-motion-design.md`（実装で変えた所があれば直す）

- [ ] **Step 1: 全部のテストと型を流す**

Run: `npx vitest run && npm run typecheck`
Expected: PASS（UI 以外のパッケージも通ること）

- [ ] **Step 2: UI とデスクトップをビルドする**

`packages/desktop`（または Tauri のある場所）の `package.json` で、bundle-server と tauri build の正しい script 名を確かめる。そのうえで、UI の vite build、bundle-server、tauri build の順に流す。

Run: `npm run build -w packages/ui`、続けてデスクトップの build の script
Expected: ビルドが通り、`.app` の出力先が表示される。

- [ ] **Step 3: WebKit で①〜⑩を目で確かめる**

ビルドの出力先の `.app` を、パスを指定して開く（`open <出力先>/agent-hangar.app`）。/Applications のものと取り違えない。セッション画面で次を等速で確かめ、`screencapture` で撮って残す。

- ① 左のナビを畳むと、本文とターミナルが帯のすぐ右から始まる。
- ② ⌘J で右の欄が滑って畳まれ、28px の列が残らない。タブの帯の右端に「いま ⌘J」が出る。もう一度押すと滑って開く。素早く 2 回押しても欄が空にならない。
- ③ 指示を送ると、目次の行が浮かんで入る。ターンを開閉すると、中身が伸び縮みする。
- ④ 境目を一番下まで引くと目次が見出しだけになり、一番上まで引くとランプだけになる。ダブルクリックで滑って半分に戻る。
- ⑤〜⑥ 意図が替わると、古い文が上へ抜ける。手、レーン、成果物が入り、また出る。
- ⑦ 要約の一行とタブの出入り。
- ⑧ transcript の帯（目次から跳んだとき）が伸びて入り、「最新へ戻る」で畳まれる。
- ⑨ 新しいセッションを開くと、目次に仮の行が出て、端末がふわっと現れる。
- ⑩ Claude を終了すると、「いま」が薄れて目次が上へ伸びる。

macOS の「視差効果を減らす」を入れて、動きが止まることも確かめる。

- [ ] **Step 4: 開閉で tmux の描き直しが 1 回で済むことを確かめる**

サーバのログか、開発者ツールの WebSocket のフレームで、右の欄を 1 回開閉したときの `resize` の送信が開閉ごとに 1 回であることを確かめる。

- [ ] **Step 5: 設計書を本体へ移してコミットする**

`docs/design.md` のセッション画面の節に、設計書の「各箇所の振る舞い」の要点を移す。移した旨を設計書の冒頭に書く。

```bash
git add docs/design.md docs/superpowers/specs/2026-10-02-session-motion-design.md
git commit -m "docs: fold the session motion design into the main design doc" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: 利用者に返す**

main へのマージと /Applications の入れ替えは、権限の判定で止まる（memory: agent-hangar context）。そのため、打つコマンドを利用者に示して頼む。利用者が自分で動かしている `npm run dev`（4177）は、起動ログで自分の PID ではないことを確かめる。そのうえで、落とすかどうかを利用者に尋ねる（memory: Never kill by port）。
