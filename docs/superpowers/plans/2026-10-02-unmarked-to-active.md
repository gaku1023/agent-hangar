# 印なしを Active に統合する Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** セッションの状態から「印なし」をなくし、`status` が null のものを Active と呼ぶ 4 状態（Active・Paused・Done・Archived）にする。

**Architecture:** データ（`session_states`、DTO、同期）は変えない。UI の節・タブ・メニューが null を Active と読み、検索の `active` を「動いているもの」から「状態が無いもの」に変え、`none` を消す。先に UI が `none` を使うのをやめ、次に shared とサーバから `none` を外すので、どのコミットでも型検査が通る。

**Tech Stack:** TypeScript、React、vitest、better-sqlite3。

**Spec:** `docs/superpowers/specs/2026-10-02-unmarked-to-active-design.md`

## Global Constraints

- DB、マイグレーション、`SessionStateDto`、同期、Worker は変えない。`status` に `'active'` を足さない。
- 画面の語は次のとおりにする：タブと節は `Active`、メニューは `Active に戻す`、押せない理由は `すでに Active です`。
- タブの並びは すべて／確かめる／Active／Paused／Done／Archived。
- Sessions の節の並びは 今日戻る → 確かめる → Active → Paused → Done → Archived。
- プロジェクト画面と Home は変えない。
- 終わったとき、`packages/` の中に「印なし」という語が残らない。
- コメントは日本語で、周りと同じ密度にする。
- コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

- **動いているのに状態が付いている行**：Sessions では自分の状態の節に入る（動いている Archived は畳んだ節に入る）。プロジェクト画面は今のまま「いま動いている」に入る。Task 1 の試験で留める。
- **Active のタブをサーバの検索で見るとき**：そのページに提案のある行があれば状態の列が出る。Task 1 の試験で留める。
- **習慣で `is:none` を打つ**：黙って全件を見せず、読めないトークンとして知らせる。Task 2 の試験で留める。
- **`state` が欠けた古いサーバの行**：Active として節とタブに入る。Task 1 の試験で留める。
- **論理削除された `session_states` の行**：サーバの検索で Active に入る。Task 2 の試験で留める。

---

### Task 1: UI が null を Active と読む

**Files:**
- Modify: `packages/ui/src/presenters/sections.ts`
- Modify: `packages/ui/src/presenters/sessions.ts`
- Modify: `packages/ui/src/views/SessionRows.tsx:28-35`
- Modify: `packages/ui/src/presenters/row.ts`（コメントだけ）
- Modify: `packages/ui/src/runtime/api.ts:62`（コメントだけ）
- Test: `packages/ui/src/presenters/sections.test.ts`
- Test: `packages/ui/src/presenters/sessionsTabs.test.ts`
- Test: `packages/ui/src/presenters/presenters.test.ts:553-558,1579`
- Test: `packages/ui/src/views/SessionRows.test.tsx:491-508`
- Test: `packages/ui/src/views/SessionsScreen.test.tsx:9,17`

**Interfaces:**
- Consumes: `StatusFilter`（shared）。この時点ではまだ `'none'` を含むが、UI は使わない。
- Produces: `SectionId = 'returning' | 'proposed' | 'live' | 'continue' | 'active' | 'paused' | 'done' | 'archived'`、`SECTION_TAB`（`active: 'active'`）、`matchesStatus(r, 'active')` は `r.state === null`。

- [ ] **Step 1: 節の試験を書き直す**

`sections.test.ts` の `describe('sectionRows（Sessions 画面の ★）')` の 1 本目を置き換え、2 本を足す。

```ts
  it('今日戻る → 確かめる → Active → Paused → Done、Archived は末尾の 1 行。動いているものは Active の先頭', () => {
    const rows = [row('newui', { live: 'waiting' }), row('status', { live: 'busy' }), row('nfd', { candidate: cand('done') }), row('video', { candidate: cand('paused') }), row('e2e', { candidate: cand('done') }), row('backspace'), paused('sync', '2026-10-02'), paused('parkour', '2026-10-09'), done('resp'), done('subs'), row('apple', { state: 'archived' })];
    expect(sessions(rows)).toEqual([
      '# returning 1', 'sync',
      '# proposed 3 [この節だけ見る ▸→proposed]', 'nfd', 'video', 'e2e',
      '# active 3 [この節だけ見る ▸→active]', 'newui', 'status', 'backspace',
      '# paused 1 [この節だけ見る ▸→paused]', 'parkour',
      '# done 2 [この節だけ見る ▸→done]', 'resp', 'subs',
      '# archived 1 [表示 ▸→archived]',
    ]);
  });
  // Sessions の節は状態だけで決める。「いま動いている」の節は無い。
  it('動いている Done・Paused・Archived は、それぞれの状態の節に入る', () => {
    const rows = [done('status', { live: 'busy' }), paused('due', '2026-10-02', { live: 'waiting' }), paused('later', '2026-10-09', { live: 'idle' }), row('trial', { state: 'archived', live: 'idle' }), row('boot', { runId: 'r1' })];
    expect(sessions(rows)).toEqual([
      '# returning 1', 'due',
      '# active 1 [この節だけ見る ▸→active]', 'boot',
      '# paused 1 [この節だけ見る ▸→paused]', 'later',
      '# done 1 [この節だけ見る ▸→done]', 'status',
      '# archived 1 [表示 ▸→archived]',
    ]);
    // プロジェクト画面は今のまま、動いているものを先に「いま動いている」へ置く。
    expect(project(rows)).toEqual(['# live 5', 'status', 'due', 'later', 'trial', 'boot']);
  });
```

`describe('matchesStatus（タブの絞り込み）')` の本文を置き換える。

```ts
  it('節の振り分けではなく、行の持ち物だけで決める。Active は状態が無いもので、動きも提案も問わない', () => {
    const liveDone = row('l', { live: 'idle', state: 'done' });
    expect(matchesStatus(liveDone, 'active')).toBe(false);
    expect(matchesStatus(liveDone, 'done')).toBe(true);
    expect(matchesStatus(row('b', { runId: 'r1' }), 'active')).toBe(true);
    expect(matchesStatus(row('n'), 'active')).toBe(true);
    expect(matchesStatus(row('c', { candidate: cand('done') }), 'proposed')).toBe(true);
    expect(matchesStatus(row('c', { candidate: cand('done') }), 'active')).toBe(true);
    expect(matchesStatus(paused('p', '2026-10-09'), 'paused')).toBe(true);
    expect(matchesStatus(paused('p', '2026-10-09'), 'active')).toBe(false);
    expect(matchesStatus(row('z', { state: 'archived' }), 'archived')).toBe(true);
  });
```

同じファイルの 33 行目のコメントの「続きは印なし、」を「続きは止まっている Active、」に直す。

- [ ] **Step 2: タブの試験を書き直す**

`sessionsTabs.test.ts` を次のとおり直す。

```ts
  it('条件が無ければ節で読み、プロジェクトの無いセッションも Active に並ぶ', () => {
    const p = presentSessions(initialState(), scene(), NOW);
    expect(shape(p.sections)).toEqual(['# returning 1', 'sync', '# proposed 2', 'nfd', 'video', '# active 4', 'newui', 'status', 'backspace', 'orphan', '# paused 1', 'parkour', '# done 2', 'resp', 'subs', '# archived 1']);
    expect(p.tab).toBe('all');
    expect(p.rows.find((r) => r.id === 'orphan')!.projectName).toBeNull();
  });
  it('タブはプロジェクトの状態と同じ順で、件数は手元の全件を行の持ち物で数える。4 状態を足すと全件になる', () => {
    const p = presentSessions(withSearch({ text: '', filter: { projectId: 'beta' } }), scene(), NOW);
    expect(p.tabs.map((t) => [t.tab, t.label, t.count, t.hot])).toEqual([
      ['all', 'すべて', '10', false], ['proposed', '確かめる', '2', true], ['active', 'Active', '6', false],
      ['paused', 'Paused', '2', false], ['done', 'Done', '2', false], ['archived', 'Archived', '1', false],
    ]);
    const n = (tab: string) => Number(p.tabs.find((t) => t.tab === tab)!.count);
    expect(n('active') + n('paused') + n('done') + n('archived')).toBe(11);
    expect(presentSessions(initialState(), storeOf([dto('x', 1)]), NOW).tabs.find((t) => t.tab === 'proposed')!.hot).toBe(false);
  });
```

「タブを選ぶと節を消し…」の中の `active` の行を置き換える。

```ts
    expect(ids({ status: 'active' })).toEqual(['newui', 'status', 'nfd', 'video', 'backspace', 'orphan']);
```

案内文の期待を置き換える。

```ts
    expect(p.hints).toEqual(['「is:pasued」は条件として読めないので、語として本文を探しています。is: の後は paused・done・archived・active・proposed・running・waiting のどれかです。']);
```

「消えたプロジェクト…」の `'# none 2'` を `'# active 2'` に直す。

状態の列の試験を足す。

```ts
  it('Active のタブは、並ぶ行に提案があれば状態の列を出し、無ければ畳む', () => {
    const col = (store: Store, filter: SearchFilter) => presentSessions(withSearch({ text: '', filter }), store, NOW).statusColumn;
    expect(col(scene(), { status: 'active' })).toBe(true);
    expect(col(storeOf([dto('a', 1), dto('b', 2, { live: 'busy' })]), { status: 'active' })).toBe(false);
    // 絞った結果に提案が無ければ畳む（beta の Active は提案のある video だけ、alpha で 7 日より前のものは無い）。
    expect(col(scene(), { status: 'active', projectId: 'beta' })).toBe(true);
    expect(col(storeOf([dto('a', 1), dto('c', 2, { projectId: 'beta', state: st({ candidate: cand('done', NOW) }) })]), { status: 'active', projectId: 'alpha' })).toBe(false);
  });
  it('サーバの検索で Active のタブを見るときは、そのページの行に提案があれば状態の列を出す', () => {
    const at = (hit: string) => {
      const store = { ...scene(), search: { params: { q: '動画' }, result: { hits: [{ sessionId: hit, matchCount: 1, snippets: [] }], total: 1 }, loading: false } };
      return presentSessions(withSearch({ text: '動画', filter: { status: 'active' } }), store, NOW).statusColumn;
    };
    expect(at('nfd')).toBe(true);
    expect(at('backspace')).toBe(false);
  });
  it('state が欠けた古いサーバの行は Active の節とタブに入る', () => {
    const old = dto('old', 1);
    delete (old as { state?: unknown }).state;
    const p = presentSessions(initialState(), storeOf([old]), NOW);
    expect(shape(p.sections)).toEqual(['# active 1', 'old']);
    expect(p.tabs.find((t) => t.tab === 'active')!.count).toBe('1');
  });
```

`presenters.test.ts` の 553〜558 行を置き換える。

```ts
  // 状態がどれも同じタブ（Done・Paused・Archived）は、行の状態の列を畳む。見出し（タブ）が言っているから。Active のタブは sessionsTabs.test.ts で見る。
  it('状態がどれも同じタブでは、状態の列を畳む', () => {
    const tab = (status: 'done' | 'paused' | 'archived' | 'proposed' | undefined) => presentSessions({ ...initialState(), search: { text: '', filter: { status }, page: 1 } }, storeWith(), NOW).statusColumn;
    expect([tab('done'), tab('paused'), tab('archived')]).toEqual([false, false, false]);
    expect([tab('proposed'), tab(undefined)]).toEqual([true, true]);
  });
```

同じファイルの 1579 行の題の「印なしとして読む」を「Active として読む」に直す。

- [ ] **Step 3: メニューと画面の試験を書き直す**

`SessionRows.test.tsx` の 494 行と 501 行。

```ts
    expect(labels()).toEqual(['Paused にする…', 'Done にする', 'Archived にする', 'Active に戻す']);
```

```ts
  it('付いている状態は選べず、Active に戻すは選べる。Active の行では「すでに Active です」と添えて押せない', () => {
    const onIntent = mount([sr('a', { state: 'done' }), sr('b')]);
    fireEvent.click(screen.getByRole('button', { name: '名前 a の状態' }));
    const items = screen.getAllByRole('menuitem');
    expect(items[1]).toHaveAttribute('aria-disabled', 'true');
    expect(items[1]).toHaveTextContent('すでに Done です');
    fireEvent.click(items[3]!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.set', id: 'a', status: null });
    fireEvent.click(screen.getByRole('button', { name: '名前 b の状態' }));
    const last = screen.getAllByRole('menuitem')[3]!;
    expect(last).toHaveAttribute('aria-disabled', 'true');
    expect(last).toHaveTextContent('すでに Active です');
  });
```

`SessionsScreen.test.tsx` の 9 行の `TABS` と 17 行の期待を T1 の並びにする（`['none', '印なし', '3']` を消し、`['active', 'Active', '5']` を `proposed` の次へ）。

```ts
    expect(tabs().getAllByRole('button').map((b) => b.textContent)).toEqual(['すべて1,236', '確かめる3', 'Active5', 'Paused4', 'Done1,221', 'Archived5']);
```

- [ ] **Step 4: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/presenters/sections.test.ts packages/ui/src/presenters/sessionsTabs.test.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/SessionRows.test.tsx packages/ui/src/views/SessionsScreen.test.tsx`
Expected: 節・タブ・メニューの新しい期待が FAIL（`# live`、`# none`、`印なしに戻す` が出る）。

- [ ] **Step 5: `sections.ts` を直す**

```ts
/**
 * 一覧の節（P3 と ★）。
 * returning は今日戻る、proposed は確かめる（Claude の提案が残っているもの）である。
 * live と continue はプロジェクト画面のいま動いているものと続き（止まっている Active、提案あり、戻る日が先の Paused）、
 * active と paused は Sessions の Active（状態が無いもの。動いているかは問わない）と Paused である。
 */
export type SectionId = 'returning' | 'proposed' | 'live' | 'continue' | 'active' | 'paused' | 'done' | 'archived';
```

```ts
const LABEL: Record<SectionId, string> = { returning: '今日戻る', proposed: '確かめる', live: 'いま動いている', continue: '続き', active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' };
/** 節の並び。Archived はどちらも末尾の 1 行にする。Sessions は状態の並び（プロジェクトの状態と同じ順）で読む。 */
const ORDER: Record<'project' | 'sessions', SectionId[]> = {
  project: ['returning', 'live', 'continue', 'done', 'archived'],
  sessions: ['returning', 'proposed', 'active', 'paused', 'done', 'archived'],
};
/** Sessions の節とタブの対応。今日戻るにはタブが無い（Paused のタブが今日戻るも含む）。 */
export const SECTION_TAB: Partial<Record<SectionId, StatusFilter>> = { proposed: 'proposed', active: 'active', paused: 'paused', done: 'done', archived: 'archived' };
```

```ts
/** タブの絞り込み。節の振り分けとは違い、行の持ち物だけで決める。Active は状態が無いもので、提案のあるものも含む（確かめると重なる）。 */
export function matchesStatus(r: SessionRowProps, f: StatusFilter): boolean {
  switch (f) {
    case 'active': return r.state === null;
    case 'proposed': return r.candidate !== null;
    default: return r.state === f;
  }
}

/**
 * 行の節。
 * プロジェクト画面は、動いているものを状態に関わらず「いま動いている」に置く。
 * Sessions は状態だけで決める。動いているものは Active の節の先頭に並び（sortForSections）、状態を付けたものは動いていてもその状態の節に入る。
 */
function sectionOf(r: SessionRowProps, kind: 'project' | 'sessions', today: string): SectionId {
  if (kind === 'project' && isLive(r)) return 'live';
  if (r.state === 'archived') return 'archived';
  if (r.state === 'paused' && dueOn(r.returnOn, today)) return 'returning';
  if (kind === 'project') return r.state === 'done' && r.candidate === null ? 'done' : 'continue';
  if (r.candidate !== null) return 'proposed';
  if (r.state === 'paused') return 'paused';
  return r.state === 'done' ? 'done' : 'active';
}
```

- [ ] **Step 6: `sessions.ts` を直す**

```ts
 * statusColumn は行の状態の列を出すか。状態がどれも同じタブ（Done・Paused・Archived）では畳む（F1）。Active のタブは、並ぶ行に提案が無いときに畳む。
```

```ts
/** 状態がどれも同じになるタブ。行の状態の列を畳む。 */
const UNIFORM_TABS: StatusTab[] = ['done', 'paused', 'archived'];
/** 状態の列を出すか。Active の行は札を持たないので、Active のタブでは提案の札があるときだけ出す。 */
const statusColumnOf = (tab: StatusTab, rows: SessionRowProps[]): boolean => (tab === 'active' ? rows.some((r) => r.candidate !== null) : !UNIFORM_TABS.includes(tab));
```

```ts
/** タブの並びと名前（★）。語と並びはプロジェクトの状態と同じにし、提案だけを日本語にする。 */
const TABS: [StatusTab, string][] = [['all', 'すべて'], ['proposed', '確かめる'], ['active', 'Active'], ['paused', 'Paused'], ['done', 'Done'], ['archived', 'Archived']];
```

`presentTabs` の上のコメントの 2 行目を「節とは数え方が違い、提案のある Active は確かめるにも Active にも入る。」に直す。

`hintOf` の `is` の文を直す。

```ts
  const how = key === 'is' ? 'is: の後は paused・done・archived・active・proposed・running・waiting のどれかです'
```

`presentSessions` の `common` から `statusColumn` を外し、2 つの return に足す。

```ts
  const common: Pick<SessionsProps, 'tabs' | 'tab' | 'tokens' | 'hints'> = { tabs: presentTabs(all.map((x) => x.row)), tab, tokens: queryTokens(f, projects), hints: badTokens(state.search.text, projects).map(hintOf) };
```

```ts
    // 状態の列は、ページではなく条件に合う全件で決める。ページを送るたびに列が出入りしないように。
    return { text: '', filter: f, projects, rows: shown, total: rows.length, loading: false, mode: 'all', allCount, conditions, sections, pager, statusColumn: statusColumnOf(tab, rows), ...common };
```

```ts
  return { text: state.search.text, filter: f, projects, rows, total, loading: store.search.loading, mode: 'search', allCount, conditions, sections: null, pager, statusColumn: statusColumnOf(tab, rows), ...common };
```

- [ ] **Step 7: `SessionRows.tsx` のメニューを直す**

```tsx
/** 「⋯」の 4 択（A2）。打鍵の印は試作 rest.html の A2 のとおり。付いている状態と、外すものの無い「Active に戻す」は理由を添えて押せなくする。 */
```

```tsx
    { key: 'active', label: 'Active に戻す', kbd: 'u', disabled: r.state === null && r.candidate === null ? 'すでに Active です' : null, onSelect: set(null) },
```

- [ ] **Step 8: UI のコメントの語を直す**

- `row.ts:17`：`/** セッションの状態。Active は null。 */`
- `row.ts:25`：末尾の「印なしは null。」を「Active は null。」に。
- `row.ts:40`：`// 古いサーバは state を送らない。欠けたものは Active として読む。`
- `runtime/api.ts:62`：「status の null は印なしに戻す。」を「status の null は Active に戻す。」に。

- [ ] **Step 9: 通るのを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck --workspace packages/ui`
Expected: 全部 PASS、型の誤りなし。

- [ ] **Step 10: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): read a session without a status as Active and drop the unmarked tab and section"
```

---

### Task 2: shared とサーバから none を外し、検索の active を状態で絞る

**Files:**
- Modify: `packages/shared/src/intent.ts:20,57`
- Modify: `packages/shared/src/api.ts:23,55`
- Modify: `packages/shared/src/searchTokens.ts:17`
- Modify: `packages/shared/src/sessionState.ts:4`
- Modify: `packages/server/src/search/search.ts:43-44,72-84`
- Modify: `packages/server/src/http/app.ts:115,420,912`
- Modify: `packages/server/src/sessions/states.ts`、`packages/server/src/db/queries.ts:48,205`、`packages/server/src/indexer/indexFile.ts:227`（コメントだけ）
- Test: `packages/shared/src/searchTokens.test.ts`
- Test: `packages/server/src/search/search.test.ts:137-185`
- Test: `packages/server/src/http/app.test.ts:370-380,1268`
- Test: `packages/server/src/sessions/states.test.ts:70`、`packages/server/src/indexer/indexFile.test.ts:471`（題の語だけ）

**Interfaces:**
- Consumes: Task 1 で UI は `'none'` を使わなくなっている。
- Produces: `SearchFilter['status']` と `SearchParamsDto['status']` は `SessionStatus | 'active' | 'proposed'`。`searchSessions` の `status: 'active'` は `liveOf` を引かない。

- [ ] **Step 1: トークンの試験を書き直す**

`searchTokens.test.ts` の 14〜15 行を置き換え、1 本を足す。

```ts
  it('is: は状態の 5 つと、動きの running と waiting を受け、大文字小文字を問わない', () => {
    for (const s of ['paused', 'done', 'archived', 'active', 'proposed'] as const) expect(parseQuery(`is:${s}`).filter).toEqual({ status: s });
```

```ts
  // 印なしをなくしたので、習慣で打った is:none は黙って捨てず、読めないトークンとして知らせる。
  it('is:none は条件として読まず、語に残して badTokens が拾う', () => {
    expect(parseQuery('is:none 動画')).toEqual({ text: 'is:none 動画', filter: {} });
    expect(badTokens('is:none 動画')).toEqual(['is:none']);
  });
```

読み直しの組の `['', { status: 'none', projectId: 'p6' }]` を `['', { status: 'active', projectId: 'p6' }]` に直す。

- [ ] **Step 2: 検索の試験を書き直す**

`search.test.ts` の `describe('searchSessions の状態（session_states）')` の 1〜3 本目と最後の 1 本を置き換える。

```ts
  // マイグレーション v13 の一括 Done は空の DB で走るので、索引の後に入ったセッションには行が無く、Active である。
  it('Paused・Done・Archived は状態の列で、Active は状態が無いもので絞る', () => {
    const alpha = idOf(SESSION_ALPHA);
    expect(searchSessions(db, { q: 'channels', status: 'active' }).total).toBe(1);
    setSessionState(db, 'd', alpha, { status: 'paused', note: '明日確かめる', returnOn: '2026-10-02', setBy: 'user' });
    expect(searchSessions(db, { q: 'channels', status: 'paused' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', status: 'done' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', status: 'active' }).total).toBe(0);
    // キーワードの無い、触ったファイルだけの経路でも効く。
    expect(searchSessions(db, { q: '', file: 'a.md', status: 'paused' }).total).toBe(1);
    expect(searchSessions(db, { q: '', file: 'a.md', status: 'done' }).total).toBe(0);
    expect(searchSessions(db, { q: '', file: 'a.md', status: 'active' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello', status: 'active' }).hits.map((h) => h.sessionId)).toEqual([idOf(SESSION_OTHER)]);
    // 手で Active に戻した行（status が null の行）も Active に入る。
    setSessionState(db, 'd', alpha, { status: null, setBy: 'user' });
    expect(searchSessions(db, { q: 'channels', status: 'active' }).total).toBe(1);
  });
  it('確かめるは、状態の無い行に残った提案だけを数える。提案のある行は Active にも入る', () => {
    const other = idOf(SESSION_OTHER);
    expect(searchSessions(db, { q: 'hello', status: 'proposed' }).total).toBe(0);
    proposeSessionState(db, 'd', other, { status: 'done', note: '直して push した', returnOn: null, source: 'post_hoc' });
    expect(searchSessions(db, { q: 'hello', status: 'proposed' }).total).toBe(1);
    expect(searchSessions(db, { q: 'hello', status: 'active' }).total).toBe(1);
  });
  it('状態があれば提案は無いものとし、論理削除済みの行は無いものとする', () => {
    const other = idOf(SESSION_OTHER);
    setSessionState(db, 'd', other, { status: 'done', setBy: 'user' });
    // 書き込みの経路は状態を書くと提案を消すが、同期で両方が揃った行を想定して直に足す。
    db.prepare("update session_states set candidate_status = 'done', candidate_note = 'x', candidate_source = 'post_hoc', candidate_at = 1 where session_id = ?").run(other);
    expect(searchSessions(db, { q: 'hello', status: 'proposed' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello', status: 'done' }).total).toBe(1);
    expect(searchSessions(db, { q: 'hello', status: 'active' }).total).toBe(0);
    // 行が論理削除されたら、状態も提案も無い Active に戻る。
    db.prepare('update session_states set deleted_at = 1 where session_id = ?').run(other);
    expect(searchSessions(db, { q: 'hello', status: 'done' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello', status: 'proposed' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello', status: 'active' }).total).toBe(1);
  });
```

```ts
  it('Active は動きを見ない。動いていても止まっていても、状態が無ければ入り、状態があれば入らない', () => {
    const alpha = idOf(SESSION_ALPHA);
    const running = (sid: string) => (sid === alpha ? 'running' as const : 'ended' as const);
    expect(searchSessions(db, { q: 'channels', status: 'active' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', status: 'active' }, running).total).toBe(1);
    setSessionState(db, 'd', alpha, { status: 'done', setBy: 'user' });
    expect(searchSessions(db, { q: 'channels', status: 'active' }, running).total).toBe(0);
    // 動きの条件と重ねれば、動いている Active だけに絞れる。
    setSessionState(db, 'd', alpha, { status: null, setBy: 'user' });
    expect(searchSessions(db, { q: 'channels', status: 'active', live: 'running' }, running).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', status: 'active', live: 'running' }).total).toBe(0);
  });
```

`app.test.ts` の 379 行の後に 1 行足す。

```ts
    // なくした none も知らない値で、絞り込みなしになる。
    expect(await total('&status=none')).toBe(1);
```

- [ ] **Step 3: 落ちるのを確かめる**

Run: `npx vitest run packages/shared/src/searchTokens.test.ts packages/server/src/search/search.test.ts`
Expected: `is:none` の試験と、Active の試験（今は動いているものを返す）が FAIL。

- [ ] **Step 4: shared を直す**

`intent.ts:20`

```ts
export type SearchFilter = { projectId?: string; days?: number; until?: number; live?: LiveFilter; file?: string; status?: SessionStatus | 'active' | 'proposed' };
```

`intent.ts:57` のコメントの「status の null は印なしに戻す。」を「status の null は Active に戻す。」に。

`api.ts:55` の `status?: SessionStatus | 'none' | 'active' | 'proposed'` を `status?: SessionStatus | 'active' | 'proposed'` に。
`api.ts:23` のコメントの「欠けたものと null は印なしとして読む。」を「欠けたものと null は Active として読む。」に。

`searchTokens.ts:17`

```ts
const STATUS_WORDS: readonly string[] = ['paused', 'done', 'archived', 'active', 'proposed'];
```

`sessionState.ts:4`

```ts
 * Active（既定）は status の null で表し、値としては持たない。動いているかどうかは状態ではなく動きである。
```

- [ ] **Step 5: `search.ts` を直す**

43〜44 行のコメント。

```ts
 * セッションの状態（Active・Paused・Done・Archived、提案）は session_states で絞る。Active は状態が無いもので、行の無いセッションも Active である。
```

（「Active（動いているもの）は DB に無いので…」の行は消す。）

72〜84 行。

```ts
  if (params.status === 'paused' || params.status === 'done' || params.status === 'archived') { where.push(stateIs('st.status = ?')); args.push(params.status); }
  if (params.status === 'proposed') where.push(stateIs(visibleCandidate));
  if (params.status === 'active') where.push(`not ${stateIs('st.status is not null')}`);
  // 「すべて」のタブで条件を入れたときは、Archived（試し・失敗）を除く。
  if (params.hideArchived && params.status === undefined) where.push(`not ${stateIs("st.status = 'archived'")}`);
  // 動きの絞り込みは、呼ぶ側の liveOf で決める。無ければ liveOf を呼ばない。
  const keep = (r: { sid: string; psid: string }) => params.live === undefined || liveOf(r.sid, r.psid) === params.live;
```

- [ ] **Step 6: `http/app.ts` とコメントを直す**

- `app.ts:420`：`new Set(['paused', 'done', 'archived', 'active', 'proposed'])`
- `app.ts:115`：「印なしは null で表す。」を「Active は null で表す。」に。
- `app.ts:912`：`'状態は paused、done、archived か、Active に戻す null です'`（この文を見ている試験があれば合わせる）。
- `app.test.ts:1268`、`states.test.ts:70`、`indexFile.test.ts:471`：題とコメントの「印なし」を「Active」に。
- `states.ts:33,92,99,100,166`、`queries.ts:48,205`、`indexFile.ts:227`：コメントの「印なし」を「Active」に（例：「行の無いセッションの状態（Active）。」「状態を書く（会話で選ぶ・手で選ぶ・Active に戻す）。」）。

- [ ] **Step 7: 通るのを確かめる**

Run: `npx vitest run packages/shared packages/server && npm run typecheck`
Expected: 全部 PASS、型の誤りなし。

- [ ] **Step 8: 語が残っていないのを確かめる**

Run: `grep -rn "印なし" packages apps --include=*.ts --include=*.tsx --include=*.css --include=*.rs`
Expected: 何も出ない。

- [ ] **Step 9: Commit**

```bash
git add packages
git commit -m "feat(search): make is:active mean sessions without a status and drop is:none"
```

---

### Task 3: 文書を合わせ、全体を確かめる

**Files:**
- Modify: `docs/design.md`（Sessions の節。「印なし」「いま動いている」を含む箇所）
- Modify: `docs/superpowers/specs/2026-10-01-session-status-design.md:37-39`

- [ ] **Step 1: `docs/design.md` を直す**

Run: `grep -n "印なし" docs/design.md`

Sessions の 2 行を置き換える。

```markdown
上から、件数つきの状態のタブ（すべて／確かめる／Active／Paused／Done／Archived）、キーワード欄、絞り込み（プロジェクト、期間、触ったファイル）、結果一覧の順に置く（★）。
条件が無いときは節（今日戻る → 確かめる → Active → Paused → Done の直近 3 件、Archived は末尾の 1 行）で読み、条件かタブがあれば平らな結果にする。
Active は状態が無いもので、動いているものは節の先頭に並ぶ。
```

ほかに「印なし」が出る箇所は、同じ言い方（状態が無いものは Active）に直す。

- [ ] **Step 2: 前の設計書に置き換えの旨を足す**

`2026-10-01-session-status-design.md` の `### 状態` の直後に 1 行足す。

```markdown
> 2026-10-02 に、印なしを Active に統合して 4 状態にした。この節の表と、画面の「印なし」「Active（動いているもの）」の記述は `2026-10-02-unmarked-to-active-design.md` が置き換える。
```

- [ ] **Step 3: 全体を確かめる**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: describe the four session states after folding the unmarked state into Active"
```

- [ ] **Step 5: ビルドして実物で見る**

UI をビルドし、確認用のサーバを本物の DB の写しで立てて、Sessions 画面を撮る。

- タブが すべて／確かめる／Active／Paused／Done／Archived の順に並び、4 状態の件数を足すと全件になる。
- 節が Active → Paused → Done の順に並び、動いているものが Active の先頭にある。
- 「⋯」に「Active に戻す」が出る。
- `is:none` を打つと、欄の下に読めないトークンの知らせが出る。
