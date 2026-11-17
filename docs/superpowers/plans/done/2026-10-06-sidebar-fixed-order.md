# サイドバーの「動いている」の並びを固定する Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** サイドバーの「動いている」の行が更新で入れ替わらないようにし、並びを変えるのは利用者のドラッグと ⌥↑↓ だけにする。

**Architecture:** いまは、手で置いていない行を描くたびに「入力待ち → 作業中 → 休み、同じ中は新しい順」で並べ直している（`presenters/shell.ts` の `sideLive`）。これをやめ、動いているセッションが初めて現れたときに、ランタイムが Mediator へ知らせて（`live.changed`）、覚えた並び（`sidebar.order`）の末尾へ id を書き足す。presenter は覚えた並びだけで描く。並べ替えは、覚えた並びのうち動いている行の席だけを入れ替え、抜けているセッションの席を残す。

**Tech Stack:** TypeScript、React、vitest。

**Spec:** 仕様書は無い（既存の並べ方の直しなので、会話の中で設計を承認した）。決まった要件は次の「Global Constraints」に全部書いた。

## Global Constraints

- 並びは、入力待ち・作業中・休みの切り替わりや、最後の活動の時刻では変えない。変えるのはドラッグと ⌥↑↓ だけ。
- 新しく動き始めたセッションは、いちばん下に入る。
- 同時に複数が初めて現れたときは、始めた時刻（`startedAt`）の古い順に末尾へ足す。時刻の無いものは後ろ、同じ時刻は id の順。
- Claude を抜けて一覧から消えたセッションは、resume したら元の場所（前後の行との順番）に戻る。
- 覚える id は 200 件まで。超えたら、動いていないものを並びの先頭の側から落とす。動いているものは落とさない。
- 変えないもの：上限 8 行と「ほか N 件」、入力待ちの色と待ち時間、Home では見出しと件数だけ、並びは端末ごとに localStorage（`sidebar.order`）、`sidebar.order` の intent の形（`{ type: 'sidebar.order'; ids: SessionId[] }`）、`views/Sidebar.tsx`。
- コメントは日本語で、周りと同じ密度にする。
- コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。
- 試験は `npx vitest run <ファイル>`、型は `npm run typecheck`、どちらもリポジトリの根で打つ。

## Review Focus

- **一度も並べ替えていない端末（保存が空）で、何本も同時に現れる**：始めた順で 1 回だけ確定し、以後は動かない。Task 1 と Task 2 の試験で留める。
- **抜けている間に、ほかの行を並べ替える**：抜けたセッションの席が消えず、resume で前後の行の間へ戻る。Task 2 の試験で留める。
- **再接続などで、動いているセッションが一瞬ゼロになる**：覚えた並びを空で上書きしない。Task 2 と Task 3 の試験で留める。
- **9 本以上動いているときに新しく始める**：新しい行は「ほか N 件」に数えられ、見えている 8 行は動かない。Task 1 の試験で留める。
- **覚えた id が 200 件を超える**：動いている行は 1 つも落とさず、並びの順も保つ。Task 2 の試験で留める。

---

### Task 1: 覚えた並びだけで描く（presenter とストア）

**Files:**
- Modify: `packages/ui/src/store/store.ts`（`waitingSessionIds` の直前に関数を 1 つ足す）
- Modify: `packages/ui/src/presenters/shell.ts:3-5`、`:131-147`
- Test: `packages/ui/src/views/sidebarLive.test.tsx:20-41`

**Interfaces:**
- Produces: `liveSessionIds(store: Store): string[]`（`store/store.ts`）。動いているセッション（実行中と入力待ち）の id を、始めた時刻の古い順で返す。Task 3 のランタイムが同じ関数を使う。
- Produces: `SideLiveProps` の形は変えない。`ids` は「覚えた並びにある動いている id」の後ろに「覚えた並びに無い動いている id」を足したもの。

- [ ] **Step 1: 試験を書き換える**

`packages/ui/src/views/sidebarLive.test.tsx` の先頭の import に `liveSessionIds` を足す。

```ts
import { initialStore, liveSessionIds, type Store } from '../store/store.ts';
```

`describe('サイドバーの「動いている」の並び（presentShell）', …)` の中の、はじめの 4 つの `it`（「動いているセッションだけを、入力待ち、作業中、休みの順に並べる…」から「覚えた並びに、もう動いていないセッションが残っていても無視する」まで）を、次の 7 つに置き換える。`const store = …` の行と、5 つめ以降の `it`（「いま見ているセッションに印を付ける」など）は残す。

```ts
  it('動いているセッションだけを並べる。入力待ちを上へ寄せない。終わったものは入れない', () => {
    const live = liveOf(store, at('projects'));
    expect(live.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(live.count).toBe(3);
    expect(live.rows[2]).toMatchObject({ live: 'waiting', waited: '待ち 4 分', current: false });
    expect(live.rows[1]).toMatchObject({ live: 'busy', waited: null });
  });
  it('置いていないセッションは、始めた時刻の古い順に並べる。時刻の無いものは後ろ、同じ時刻は id の順', () => {
    const s = storeWith([session('n', { startedAt: null }), session('y', { startedAt: NOW - 100 }), session('x', { startedAt: NOW - 100 }), session('o', { startedAt: NOW - 900 })]);
    expect(liveSessionIds(s)).toEqual(['o', 'x', 'y', 'n']);
    expect(liveOf(s, at('projects')).ids).toEqual(['o', 'x', 'y', 'n']);
  });
  it('状態や最後の活動が変わっても、並びは変わらない', () => {
    const before = liveOf(store, at('projects')).ids;
    const after = storeWith([session('a', { live: 'waiting', lastActivityAt: NOW }), session('b', { live: 'idle', lastActivityAt: NOW - 1 }), session('c', { live: 'busy', lastActivityAt: NOW - 999_000 }), session('z', { live: null })]);
    expect(liveOf(after, at('projects')).ids).toEqual(before);
  });
  it('利用者が置いた順を保ち、入力待ちになっても行を動かさない', () => {
    const live = liveOf(store, { ...at('projects'), sidebarOrder: ['c', 'a', 'b'] });
    expect(live.rows.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(live.ids).toEqual(['c', 'a', 'b']);
  });
  it('置いていないセッション（新しく動き始めたもの）は、置いた行の下に入る', () => {
    const live = liveOf(store, { ...at('projects'), sidebarOrder: ['b'] });
    expect(live.rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
  it('覚えた並びに、いま動いていないセッションが残っていても出さない', () => {
    expect(liveOf(store, { ...at('projects'), sidebarOrder: ['gone', 'b', 'z'] }).rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
  it('上限を超えて動いているときに新しく始めたものは「ほか N 件」に入り、見えている行は動かない', () => {
    const ids = Array.from({ length: SIDE_LIVE_MAX }, (_, i) => `s${i}`);
    const full = storeWith(ids.map((id) => session(id)));
    const more = storeWith([...ids.map((id) => session(id)), session('new', { live: 'waiting', startedAt: NOW })]);
    const st = { ...at('projects'), sidebarOrder: ids };
    expect(liveOf(more, st).rows.map((r) => r.id)).toEqual(liveOf(full, st).rows.map((r) => r.id));
    expect(liveOf(more, st).more).toBe(1);
    expect(liveOf(more, st).ids.at(-1)).toBe('new');
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/views/sidebarLive.test.tsx`
Expected: FAIL。`liveSessionIds` が無い（`liveSessionIds is not a function`）ことと、並びが `['c', 'b', 'a']` で返ることで落ちる。

- [ ] **Step 3: ストアに `liveSessionIds` を足す**

`packages/ui/src/store/store.ts` の `waitingSessionIds` の doc コメントの直前に入れる。

```ts
/**
 * サイドバーの「動いている」に載るセッションの id（実行中と入力待ち）。
 * 始めた時刻の古い順に並べ、時刻の無いものは後ろ、同じ時刻は id の順にする。
 * 状態や最後の活動では並べない。更新のたびに並びが揺れないようにするためである。
 */
export function liveSessionIds(store: Store): string[] {
  const alive = runningSessionIds(store);
  const at = (s: SessionDto) => s.startedAt ?? Number.POSITIVE_INFINITY;
  return Object.values(store.sessions).filter((s) => liveFilterOfSession(store, s, alive) !== 'ended')
    .sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1) || a.id.localeCompare(b.id))
    .map((s) => s.id);
}
```

- [ ] **Step 4: presenter を覚えた並びだけで描くようにする**

`packages/ui/src/presenters/shell.ts` の 3 行目と 5 行目の import を直す。`liveFilterOfSession`、`runningSessionIds`、`sortSessions` はこのファイルでは `sideLive` しか使っていないので外す。

```ts
import { liveSessionIds, waitingSessionIds, type Store } from '../store/store.ts';
```

5 行目の `import { sortSessions } from './row.ts';` は行ごと消す。

`sideLive` を doc コメントごと次に置き換える（`SIDE_LIVE_MAX` の定義は残す）。

```ts
/**
 * サイドバーの「動いている」。
 * セッション画面にいる間、ほかのセッションのどれが待っているかを横目で見て、1 押しで移るための場所である。
 * 並びは覚えた順（state.sidebarOrder）だけで決め、状態や最後の活動では並べ直さない。動かすのは利用者の手だけである。
 * 覚えた並びにまだ無いもの（いま動き始めたもの）は、始めた順で末尾に置く。Mediator が同じ順で並びに書き足すので（sidebar.ts の sidebarLiveStep）、書き足す前と後で行は動かない。
 * 入力待ちになっても行は動かさない。待ちは色と太字と待った時間で知らせる。
 * ホームでは、本文の「要対応」「実行中」と同じ件を出すだけになるので、見出しと件数だけにする（folded）。
 */
function sideLive(state: State, store: Store, now: number): SideLiveProps {
  const live = liveSessionIds(store);
  const on = new Set(live);
  const known = new Set(state.sidebarOrder);
  const ids = [...state.sidebarOrder.filter((id) => on.has(id)), ...live.filter((id) => !known.has(id))];
  const current = state.screen.name === 'session' ? state.screen.id : null;
  const rows = ids.slice(0, SIDE_LIVE_MAX).map((id): SideLiveRow => {
    const s = store.sessions[id]!;
    return { id, name: s.name ?? '（名前なし）', live: s.live, waited: s.live === 'waiting' ? `待ち ${durationLabel(now - (s.lastActivityAt ?? now))}` : null, current: id === current };
  });
  return { count: ids.length, ids, rows, more: ids.length - rows.length, folded: state.screen.name === 'home' || state.screen.name === 'booting' };
}
```

- [ ] **Step 5: 通るのを確かめる**

Run: `npx vitest run packages/ui/src/views/sidebarLive.test.tsx && npm run typecheck`
Expected: 試験は全部 PASS、型検査はエラーなし。

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/store/store.ts packages/ui/src/presenters/shell.ts packages/ui/src/views/sidebarLive.test.tsx
git commit -m "$(cat <<'EOF'
fix(ui): stop re-sorting the sidebar's running sessions by status

Rows the user had not placed were sorted by status and last activity on
every render, so they swapped places whenever a session started waiting
or wrote output. The sidebar now draws only from the remembered order and
puts unplaced sessions at the bottom in the order they started.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 現れたら末尾へ書き足し、並べ替えで席を残す（Mediator）

**Files:**
- Modify: `packages/ui/src/mediator/types.ts:20-23`（`RuntimeEvent` に 1 つ足す）
- Modify: `packages/ui/src/mediator/sidebar.ts:13-27`
- Modify: `packages/ui/src/mediator/transition.ts:15`、`:40`
- Test: `packages/ui/src/views/sidebarLive.test.tsx`（`describe('並びを覚える（sidebar.order）', …)`）

**Interfaces:**
- Consumes: なし（Task 1 とは独立に試験できる）。
- Produces: ランタイムのイベント `{ type: 'live.changed'; ids: string[] }`。`ids` は動いているセッションの id で、末尾へ足したい順に並べたもの。Task 3 のランタイムがこれを送る。
- Produces: `sidebarLiveStep(state: State, input: Input): Step | null`、`mergeSidebarOrder(order: string[], moved: string[]): string[]`、`trimSidebarOrder(order: string[], live: string[]): string[]`、`SIDEBAR_ORDER_MAX = 200`（どれも `mediator/sidebar.ts`）。

- [ ] **Step 1: 試験を足す**

`packages/ui/src/views/sidebarLive.test.tsx` の import を直す。

```ts
import { cleanSidebarOrder, mergeSidebarOrder, SIDEBAR_ORDER_KEY, SIDEBAR_ORDER_MAX, trimSidebarOrder } from '../mediator/sidebar.ts';
```

`describe('並びを覚える（sidebar.order）', …)` の中の、既存の 2 つの `it` の後ろに次を足す。

```ts
  const appeared = (order: string[], ids: string[]) => transition({ ...initialState(), sidebarOrder: order }, { kind: 'runtime', event: { type: 'live.changed', ids } });
  it('初めて現れたセッションを、届いた順で並びの末尾に書き足し、保存する', () => {
    const r = appeared(['a'], ['c', 'a', 'b']);
    expect(r.state.sidebarOrder).toEqual(['a', 'c', 'b']);
    expect(r.effects).toContainEqual({ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: ['a', 'c', 'b'] });
  });
  it('保存が空の端末でも、現れた順で 1 回だけ確定する', () => {
    const first = appeared([], ['a', 'b', 'c']);
    expect(first.state.sidebarOrder).toEqual(['a', 'b', 'c']);
    const again = transition(first.state, { kind: 'runtime', event: { type: 'live.changed', ids: ['c', 'b', 'a'] } });
    expect(again.state.sidebarOrder).toEqual(['a', 'b', 'c']);
    expect(again.effects).toEqual([]);
  });
  it('動いているものが減っても、ゼロになっても、覚えた並びは変えず、保存もしない', () => {
    for (const ids of [['a'], []]) {
      const r = appeared(['a', 'b', 'c'], ids);
      expect(r.state.sidebarOrder).toEqual(['a', 'b', 'c']);
      expect(r.effects).toEqual([]);
    }
  });
  it('抜けていたセッションがまた現れても、覚えた席のまま動かさない', () => {
    const r = appeared(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(r.state.sidebarOrder).toEqual(['a', 'b', 'c']);
    expect(r.effects).toEqual([]);
  });
  it('並べ替えは動いている行の席だけを入れ替え、抜けているセッションの席を残す', () => {
    expect(mergeSidebarOrder(['a', 'x', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'x', 'a', 'b']);
    const r = transition({ ...initialState(), sidebarOrder: ['a', 'x', 'b', 'c'] }, { kind: 'intent', intent: { type: 'sidebar.order', ids: ['a', 'c', 'b'] } });
    expect(r.state.sidebarOrder).toEqual(['a', 'x', 'c', 'b']);
    expect(r.effects).toContainEqual({ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: ['a', 'x', 'c', 'b'] });
  });
  it('並べ替えに、まだ覚えていない id が混じっていたら末尾に足す', () => {
    expect(mergeSidebarOrder(['a', 'b'], ['n', 'b', 'a'])).toEqual(['b', 'a', 'n']);
    expect(mergeSidebarOrder([], ['b', 'a'])).toEqual(['b', 'a']);
  });
  it('覚える id は上限までにし、動いていないものを先頭の側から落とす。動いているものは落とさない', () => {
    const old = Array.from({ length: SIDEBAR_ORDER_MAX }, (_, i) => `o${i}`);
    expect(trimSidebarOrder(old, [])).toBe(old);
    const trimmed = trimSidebarOrder(['live1', ...old, 'live2'], ['live1', 'live2']);
    expect(trimmed).toHaveLength(SIDEBAR_ORDER_MAX);
    expect(trimmed).toEqual(['live1', ...old.slice(2), 'live2']);
    const allLive = Array.from({ length: SIDEBAR_ORDER_MAX + 5 }, (_, i) => `l${i}`);
    expect(trimSidebarOrder(allLive, allLive)).toEqual(allLive);
    const r = appeared(old, ['o0', 'new']);
    expect(r.state.sidebarOrder).toEqual(['o0', ...old.slice(2), 'new']);
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/views/sidebarLive.test.tsx`
Expected: FAIL。`mergeSidebarOrder` と `trimSidebarOrder` が無いことで落ちる。

- [ ] **Step 3: イベントの型を足す**

`packages/ui/src/mediator/types.ts` の `RuntimeEvent` の、`| { type: 'waiting.changed'; ids: string[] }` の行の直後に入れる。

```ts
  // サイドバーの「動いている」に載るセッションの一覧（hangar のセッションの id、始めた順）。
  // 顔ぶれが変わったときだけランタイムが届ける。
  | { type: 'live.changed'; ids: string[] }
```

- [ ] **Step 4: Mediator を書く**

`packages/ui/src/mediator/sidebar.ts` の `sidebarOrderStep`（doc コメントごと）を、次に置き換える。`SIDEBAR_ORDER_KEY` と `cleanSidebarOrder` は残す。

```ts
/** 覚える id の上限。抜けたセッションの席も覚えておくので、決めておかないと増え続ける。 */
export const SIDEBAR_ORDER_MAX = 200;

/**
 * 並べ替えた結果（いま動いている行の並び）を、覚えた並びに織り込む。
 * 動いている行が座っていた席だけを新しい順で埋め直し、抜けているセッションの席は動かさない。resume したときに元の場所へ戻すためである。
 * まだ覚えていない id が混じっていたら末尾に足す。
 */
export function mergeSidebarOrder(order: string[], moved: string[]): string[] {
  const known = new Set(order);
  const seats = moved.filter((id) => known.has(id));
  const taken = new Set(seats);
  let i = 0;
  return [...order.map((id) => (taken.has(id) ? seats[i++]! : id)), ...moved.filter((id) => !known.has(id))];
}

/** 上限を超えた分を、動いていないものの先頭の側から落とす。動いているものは落とさない。超えていなければ元のまま返す。 */
export function trimSidebarOrder(order: string[], live: string[]): string[] {
  let over = order.length - SIDEBAR_ORDER_MAX;
  if (over <= 0) return order;
  const on = new Set(live);
  return order.filter((id) => on.has(id) || over-- <= 0);
}

/** 「動いている」の行を並べ替えたとき。並びを覚え、保存する。ドラッグの途中は部品の中だけで動かし、ここへは離したときだけ来る。 */
export function sidebarOrderStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent' || input.intent.type !== 'sidebar.order') return null;
  const order = mergeSidebarOrder(state.sidebarOrder, cleanSidebarOrder(input.intent.ids));
  return { state: { ...state, sidebarOrder: order }, effects: [{ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: order }] };
}

/**
 * 動いているセッションの顔ぶれが変わったとき。
 * 初めて現れたものを、届いた順（始めた順）で並びの末尾に書き足す。場所はここで決まり、以後は利用者が動かすまで変わらない。
 * 減ったときは何もしない。抜けたセッションの席を残しておき、戻ってきたら同じ場所に出す。
 */
export function sidebarLiveStep(state: State, input: Input): Step | null {
  if (input.kind !== 'runtime' || input.event.type !== 'live.changed') return null;
  const known = new Set(state.sidebarOrder);
  const fresh = input.event.ids.filter((id) => !known.has(id));
  if (fresh.length === 0) return { state, effects: [] };
  const order = trimSidebarOrder([...state.sidebarOrder, ...fresh], input.event.ids);
  return { state: { ...state, sidebarOrder: order }, effects: [{ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: order }] };
}
```

- [ ] **Step 5: 遷移につなぐ**

`packages/ui/src/mediator/transition.ts` の 15 行目の import に `sidebarLiveStep` を足す。

```ts
import { LIVE_PANE_SPLIT_DEFAULT, livePaneSplitStep, sidebarLiveStep, sidebarOrderStep, sidebarStep } from './sidebar.ts';
```

40 行目の `for (const step of [...])` の並びで、`sidebarOrderStep` の直後に `sidebarLiveStep` を入れる（ほかの並びは変えない）。

```ts
  for (const step of [connectionStep, screenStep, launchStep, promoteStep, retentionStep, overlayStep, syncStep, resumeHereStep, settingsStep, sessionViewStep, sidebarStep, sidebarOrderStep, sidebarLiveStep, sectionsStep, livePaneSplitStep, liveStep, returnStep, notifyStep, workbenchStep]) {
```

- [ ] **Step 6: 通るのを確かめる**

Run: `npx vitest run packages/ui/src/views/sidebarLive.test.tsx packages/ui/src/mediator && npm run typecheck`
Expected: 試験は全部 PASS、型検査はエラーなし。

- [ ] **Step 7: コミット**

```bash
git add packages/ui/src/mediator/types.ts packages/ui/src/mediator/sidebar.ts packages/ui/src/mediator/transition.ts packages/ui/src/views/sidebarLive.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): give each running session a fixed seat in the sidebar order

A session is appended to the remembered order the first time it appears
and stays there until the user moves it. Reordering now swaps only the
seats of the running rows, so a session that has exited keeps its seat
and returns to it when resumed. The order is capped at 200 ids, dropping
stopped ones first.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: ランタイムが顔ぶれの変化を届ける、設計書を直す、全体を確かめる

**Files:**
- Modify: `packages/ui/src/runtime/runtime.ts:16`、`:95-108`
- Modify: `docs/design.md:1140-1144`
- Test: `packages/ui/src/runtime/runtime.test.ts`（末尾に `describe` を 1 つ足す）

**Interfaces:**
- Consumes: `liveSessionIds(store: Store): string[]`（Task 1、`store/store.ts`）。
- Consumes: ランタイムのイベント `{ type: 'live.changed'; ids: string[] }` と `SIDEBAR_ORDER_KEY`（Task 2、`mediator/types.ts`、`mediator/sidebar.ts`）。

- [ ] **Step 1: 試験を足す**

`packages/ui/src/runtime/runtime.test.ts` の末尾に足す。`harness`、`boot`、`flush`、`p3Session` はこのファイルの先頭の側にすでにある。

```ts
describe('サイドバーの「動いている」の並び（ランタイム）', () => {
  const running = (id: string, startedAt: number, live: SessionDto['live'] = 'busy'): SessionDto => ({ ...p3Session, id, providerSessionId: 'u-' + id, projectId: null, live, startedAt });
  const liveRow = (sessionId: string, status: 'busy' | 'waiting') => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 1 });
  async function started(sessions: SessionDto[], stored?: unknown) {
    const h = harness({ bootstrap: vi.fn(async () => ({ ...boot, sessions })) });
    if (stored !== undefined) h.store.set('sidebar.order', stored);
    h.rt.start();
    h.wsHandlers[0]!.onOpen();
    await flush();
    return h;
  }

  it('保存が空なら、動いているセッションを始めた順で並びに書き足して保存する', async () => {
    const h = await started([running('s2', 20, 'waiting'), running('s1', 10), { ...running('s3', 5), live: null }]);
    expect(h.rt.getState().sidebarOrder).toEqual(['s1', 's2']);
    expect(h.store.get('sidebar.order')).toEqual(['s1', 's2']);
  });
  it('覚えた並びは保ち、初めて現れたものだけを末尾に足す', async () => {
    const h = await started([running('s1', 10), running('s2', 20), running('s3', 30)], ['s3', 'gone', 's1']);
    expect(h.rt.getState().sidebarOrder).toEqual(['s3', 'gone', 's1', 's2']);
  });
  it('入力待ちに変わっても、動いているものが一瞬消えても、並びは変わらない', async () => {
    const h = await started([running('s1', 10), running('s2', 20)]);
    h.wsHandlers[0]!.onEvent({ type: 'live.update', live: [liveRow('u-s2', 'waiting'), liveRow('u-s1', 'busy')] });
    expect(h.rt.getState().sidebarOrder).toEqual(['s1', 's2']);
    h.wsHandlers[0]!.onEvent({ type: 'live.update', live: [] });
    expect(h.rt.getState().sidebarOrder).toEqual(['s1', 's2']);
    h.wsHandlers[0]!.onEvent({ type: 'live.update', live: [liveRow('u-s2', 'busy'), liveRow('u-s1', 'busy')] });
    expect(h.rt.getState().sidebarOrder).toEqual(['s1', 's2']);
    expect(h.store.get('sidebar.order')).toEqual(['s1', 's2']);
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/runtime/runtime.test.ts -t 'サイドバーの「動いている」の並び'`
Expected: FAIL。1 つめと 3 つめは `sidebarOrder` が `[]` のまま、2 つめは `['s3', 'gone', 's1']` のままで落ちる。

- [ ] **Step 3: ランタイムから届ける**

`packages/ui/src/runtime/runtime.ts` の 16 行目の `../store/store.ts` からの import に `liveSessionIds` を足す（`initialStore` の後ろ、ほかの名前はそのまま）。

95 行目の `setStore` を、`syncLive()` を呼ぶように直す。

```ts
  const setStore = (next: Store) => { if (next !== store) { store = next; notify(); syncWaiting(); syncLive(); syncReturns(); } };
```

`syncWaiting` の関数の閉じ括弧の直後に入れる。

```ts
  /**
   * 動いているセッションの顔ぶれが変わったら Mediator へ届ける。サイドバーの「動いている」の並びに、初めて現れたものを書き足すためである（mediator/sidebar.ts の sidebarLiveStep）。
   * 並びの順ではなく顔ぶれで比べる。ストアは本文が伸びるたびに変わるので、そのたびには送らない。
   */
  let liveKey = '';
  function syncLive(): void {
    const ids = liveSessionIds(store);
    const key = [...ids].sort().join('\n');
    if (key === liveKey) return;
    liveKey = key;
    dispatch({ kind: 'runtime', event: { type: 'live.changed', ids } });
  }
```

- [ ] **Step 4: 通るのを確かめる**

Run: `npx vitest run packages/ui/src/runtime/runtime.test.ts`
Expected: 全部 PASS（足した 3 つと、もとからある試験）。

- [ ] **Step 5: 設計書を直す**

`docs/design.md` の 1140 行目の末尾の `並びは `presenters/shell.ts` の `sideLive`）` を、`並びは `presenters/shell.ts` の `sideLive` と `mediator/sidebar.ts`）` に直す。

1144 行目の段落（「並びは利用者が置いた順を保つ。置いていないもの…待った時間で知らせる。」）を、次の 1 段落に置き換える。

```markdown
並びは固定で、変えるのは利用者の手だけである。入力待ちになっても、出力が進んでも、行は動かさない。更新のたびに行が入れ替わると、置いた場所を目で覚えていられないからで、待ちは色と太字と待った時間で知らせる。動いているセッションが初めて現れたとき、ランタイムが顔ぶれの変化を届け（`live.changed`）、Mediator がその id を並びの末尾に書き足す。同時に現れたものは始めた時刻の古い順にする。Claude を抜けて行が消えても席は覚えておき、resume したら前後の行の間へ戻す。並べ替えは動いている行の席だけを入れ替え、抜けているセッションの席は動かさない。覚える id は 200 件までで、超えたら動いていないものを先頭の側から落とす。新しい行は末尾に入るので、9 本以上動いているときは「ほか N 件」に数えられる。
```

- [ ] **Step 6: 全体を確かめる**

Run: `npm run typecheck && npm test && npm run build`
Expected: 型検査はエラーなし、試験は全部 PASS、ビルドは成功。

`packages/` の中に、古い並べ方の説明が残っていないことも確かめる。

Run: `grep -rn "置いた行の上" packages docs/design.md`
Expected: 何も出ない。

- [ ] **Step 7: コミット**

```bash
git add packages/ui/src/runtime/runtime.ts packages/ui/src/runtime/runtime.test.ts docs/design.md
git commit -m "$(cat <<'EOF'
feat(ui): seat running sessions in the sidebar as they appear

The runtime tells the mediator when the set of running sessions changes,
so a new session is written to the end of the remembered order once and
never reshuffled by status. The design notes describe the fixed order.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## 実装のあと（プランの外）

- 実物で確かめる：3 本以上動かし、1 本を入力待ちにしても行が動かないこと、新しく始めた 1 本が末尾に入ること、1 本を `/exit` で抜けて resume すると同じ場所へ戻ること、ドラッグと ⌥↑↓ が効くこと。
- デスクトップのビルド（bundle-server と tauri build）と /Applications の入れ替え、main へのマージと push は、いつもの手順で利用者と進める。
