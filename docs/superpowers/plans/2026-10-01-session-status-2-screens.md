# セッションの状態 第 2 段「画面」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第 1 段で入ったセッションの状態（Paused・Done・Archived と Claude の提案）を使って、プロジェクト画面を節で読む一覧（P3）に、Sessions 画面を件数つきのタブ・節・検索欄のトークン（★）に、Home に「今日戻る」の札と提案の行（C1）を足す。

**Architecture:** 節分けは純粋な関数 `presenters/sections.ts` の `sectionRows` 1 つにまとめ、プロジェクト画面と Sessions 画面が節の種類だけを変えて使う。並びの元は `presenters/row.ts` の `sortForSections` が決め、Done だけは Done にした時刻の新しい順にする。
`SessionRows` は行と見出しの和（`ListItem`）を受け、カーソルは見出しを飛ばす。プロジェクト画面で広げた節は Mediator の `sectionsOpen` に持つ。
検索欄のトークンの読み書きは `shared/src/searchTokens.ts` の純粋な関数にし、欄を正とする。状態での絞り込みは手元の Presenter とサーバの検索（`session_states` を見る）の両方に足す。

**Tech Stack:** Node 22、TypeScript、Hono、better-sqlite3、React 19、@tanstack/react-virtual、vitest、@testing-library/react。

**Spec:** `docs/superpowers/specs/2026-10-01-session-status-design.md`（とくに「画面」の節）。名前と型は `docs/superpowers/plans/2026-10-01-session-status-contract.md` に従う。試作は `docs/superpowers/specs/2026-10-01-session-status/` の `scenes.html`（P3）、`rest.html`（C1）、`sessions-filter.html`（★）。

## Global Constraints

- 作業はすべて worktree `/Users/satog/workspace/agent-hangar/.claude/worktrees/session-status`（ブランチ `worktree-session-status`）で行う。元の checkout には触らない。
- 第 1 段の計画（`2026-10-01-session-status-1-data.md`）のタスクがすべて済んだ同じブランチで始める。`SessionStateDto`、`SessionDto.state`、`SessionRowProps` の `state`・`returnOn`・`overdueDays`・`candidate`・`setBy`、Intent の `session.state.*`・`session.pause.open`、行の札と「⋯」、Paused の入力（B1）、提案のポップ、`isReturnOn`・`localDate`・`addDays`・`overdueDays`、サーバの `setSessionState`・`proposeSessionState` は、契約の名前のまま既にある前提で使う。
- 契約の名前と型は変えない。この段で契約に足すものは次のとおりで、どれも足すだけ（既存の名前の意味は変えない）。
  - `parseQuery` と `formatQuery` に、省ける第 3 引数 `projects: readonly QueryProject[] = []`（`project:` を名前で引くため）。あわせて `queryTokens`・`badTokens`・`QueryToken`・`QueryKey`・`QueryProject` を `searchTokens.ts` から出す。
  - `StatusFilter = NonNullable<SearchFilter['status']>`（`intent.ts`）。
  - Intent の `search.query` に `filter?: SearchFilter`、Intent に `{ type: 'project.section.toggle'; projectId; section: 'done' | 'archived' }`。spec の「UI の配線」にある `sessions.tab` は作らず、`search.filter` の `{ status }` で兼ねる（欄を正とし、タブはその表示だから）。
  - `SearchParamsDto` に `status?` と `hideArchived?: boolean`。
- 依存を足さない。
- 「今日」は手元の暦の日付（`localDate(now)`）で、`mediator/screen.ts` の `periodStart(1, now)` と同じ 0 時を境にする。
- Done の節で畳まずに見せるのは 3 件（`DONE_HEAD = 3`）。
- 状態の色は既存のトークン（`--st-*`）、提案は `--cand`、戻る日は `--st-paused` を使う。新しい色を作らない。
- UI は常にライト。ダークモードの指定を書かない。
- `transition` と `animation` の長さは `--dur-fast`、`--dur`、`--dur-exit` を通して書き、数値を直書きしない（`motion.test.ts`）。
- View は `lucide-react` を直接 import せず、`views/primitives/Icon.tsx` の名前だけを使う。View は API を呼ばず、Intent だけを出す。
- 文言は日本語の平叙文で、数字の前後に空白を入れる（「3 件」「12 日過ぎ」）。件数の数字そのものは「1,221」のように桁を区切る。
- コードのコメントは日本語で、周りのコードと同じ密度と口調（「〜する」「〜ためである」）にする。
- 行番号は第 1 段の前の版で数えている。第 1 段の変更でずれているので、示した式や関数名で場所を探す。
- テストの実行は worktree の根で `npx vitest run <path>`。型は `npm run typecheck`。
- コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

- **プロジェクトの無いセッション（`projectId` が null、または消えたプロジェクトを指す）**：Sessions の節、Home の今日戻ると確かめるに落ちずに並び、プロジェクト名は「未分類」と出る。`project:` の絞り込みでは当たらない。Task 6 と Task 8 に試験を足す。
- **Paused なのに戻る日が欠けた行、暦に無い日の行（同期や古い端末から届く）**：落ちずに「今日戻る」の先頭に出し、Home の札は「日付なし」と言う。黙って「続き」に紛れると、しおりを見失う。Task 3 と Task 8 に試験を足す。
- **トークンの打ち間違いと当たらない値（`is:pasued`、`since:7`、`since:0d`、`project:存在しない`、`file:`）**：黙って捨てず、語として本文を探し、欄の下に読めなかったことを知らせる。Task 1、Task 6、Task 7 に試験を足す。
- **空白・引用符・濁点（NFD）を含むプロジェクト名やパス（`my app`、`docs/a b.md`、`無検閲モデル`）**：タブや絞り込みで出したトークンを欄で Enter し直しても同じ条件に戻り、NFD の名前も前方一致で当たる。Task 1 に試験を足す。
- **狭い窓（900×600）でのタブの溢れと大きな件数（「Done 1,221」）**：タブは次の行へ折り返し、件数は桁を区切る。`since:14d` のように帯に無い期間では、期間の帯のどれにも印を付けない。Task 6、Task 7 に試験を足し、Task 9 の実物で確かめる。

---

### Task 1: 条件の型と、検索欄のトークンの読み書き（shared）

**Files:**
- Modify: `packages/shared/src/intent.ts:1-3`（import）、`:12-17`（SearchFilter）、`:28`（search の Intent）、`:33`（project の Intent）
- Modify: `packages/shared/src/api.ts:1`（import）、`:49`（SearchParamsDto）
- Create: `packages/shared/src/searchTokens.ts`
- Modify: `packages/shared/src/index.ts:10`
- Test: `packages/shared/src/searchTokens.test.ts`

**Interfaces:**
- Consumes: `SessionStatus`（第 1 段の `packages/shared/src/sessionState.ts`）
- Produces:
  - `SearchFilter` に `status?: SessionStatus | 'none' | 'active' | 'proposed'`、`export type StatusFilter = NonNullable<SearchFilter['status']>`
  - Intent `{ type: 'search.query'; text: string; filter?: SearchFilter }`、`{ type: 'project.section.toggle'; projectId: ProjectId; section: 'done' | 'archived' }`
  - `SearchParamsDto` に `status?: SessionStatus | 'none' | 'active' | 'proposed'; hideArchived?: boolean`
  - `type QueryKey = 'status' | 'live' | 'days' | 'projectId' | 'file'`、`type QueryToken = { key: QueryKey; token: string }`、`type QueryProject = { id: string; name: string }`
  - `parseQuery(text: string, projects?: readonly QueryProject[]): { text: string; filter: Partial<SearchFilter> }`
  - `formatQuery(text: string, filter: Partial<SearchFilter>, projects?: readonly QueryProject[]): string`
  - `queryTokens(filter: Partial<SearchFilter>, projects?: readonly QueryProject[]): QueryToken[]`
  - `badTokens(text: string, projects?: readonly QueryProject[]): string[]`

- [ ] **Step 1: 失敗する試験を書く**

`packages/shared/src/searchTokens.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import type { SearchFilter } from './intent.ts';
import { badTokens, formatQuery, parseQuery, queryTokens } from './searchTokens.ts';

const projects = [
  { id: 'p1', name: 'agent-hangar' }, { id: 'p2', name: 'agent' }, { id: 'p3', name: '金剛山プロジェクト' },
  { id: 'p4', name: 'my app' }, { id: 'p5', name: 'hangar-ui' }, { id: 'p6', name: 'hangar' },
];

describe('parseQuery', () => {
  it('is: since: project: file: を読み、残りを検索語にする', () => {
    expect(parseQuery('is:paused 動画 since:30d project:agent-h file:rows.css', projects)).toEqual({ text: '動画', filter: { status: 'paused', days: 30, projectId: 'p1', file: 'rows.css' } });
  });
  it('is: は状態の 6 つと、動きの running と waiting を受け、大文字小文字を問わない', () => {
    for (const s of ['paused', 'done', 'archived', 'active', 'none', 'proposed'] as const) expect(parseQuery(`is:${s}`).filter).toEqual({ status: s });
    expect(parseQuery('is:running').filter).toEqual({ live: 'running' });
    expect(parseQuery('is:waiting').filter).toEqual({ live: 'waiting' });
    expect(parseQuery('IS:Paused').filter).toEqual({ status: 'paused' });
  });
  it('同じ項目が 2 度あれば後ろが勝つ。状態と動きは別の項目なので両方残る', () => {
    expect(parseQuery('is:paused is:done').filter).toEqual({ status: 'done' });
    expect(parseQuery('is:running is:paused').filter).toEqual({ live: 'running', status: 'paused' });
  });
  it('project: は名前がそのまま同じものを先に、無ければ前方一致のうち短い名前を取る', () => {
    expect(parseQuery('project:agent', projects).filter).toEqual({ projectId: 'p2' });
    expect(parseQuery('project:AGENT-H', projects).filter).toEqual({ projectId: 'p1' });
    expect(parseQuery('project:han', projects).filter).toEqual({ projectId: 'p6' });
  });
  it('project: は NFD と NFC の違いを問わずに当たる', () => {
    expect(parseQuery(`project:${'金剛山プロ'.normalize('NFD')}`, projects).filter).toEqual({ projectId: 'p3' });
    expect(parseQuery('project:無検閲', [{ id: 'q1', name: '無検閲モデル'.normalize('NFD') }]).filter).toEqual({ projectId: 'q1' });
  });
  it('空白を含む値は二重引用符で包んで書ける', () => {
    expect(parseQuery('project:"my app" file:"docs/a b.md" x', projects)).toEqual({ text: 'x', filter: { projectId: 'p4', file: 'docs/a b.md' } });
  });
  it('since: は 1 日から 3650 日まで', () => {
    expect(parseQuery('since:3650d').filter).toEqual({ days: 3650 });
    expect(parseQuery('since:3651d').filter).toEqual({});
  });
  // 黙って捨てると、絞り込みが効いたように見えて実は全件を見ていることになる。
  it('読めないトークンは捨てずに検索語に残し、badTokens が拾う', () => {
    const q = 'is:pasued since:7 since:0d project:nope file: 動画';
    expect(parseQuery(q, projects)).toEqual({ text: 'is:pasued since:7 since:0d project:nope file: 動画', filter: {} });
    expect(badTokens(q, projects)).toEqual(['is:pasued', 'since:7', 'since:0d', 'project:nope', 'file:']);
  });
  it('projects を渡さなければ project: は読めず、語として残る', () => {
    expect(parseQuery('project:agent')).toEqual({ text: 'project:agent', filter: {} });
    expect(badTokens('project:agent')).toEqual(['project:agent']);
  });
  it('知らない鍵のコロンは、ただの語として扱い、知らせない', () => {
    expect(parseQuery('https://x.dev 12:30 foo:bar')).toEqual({ text: 'https://x.dev 12:30 foo:bar', filter: {} });
    expect(badTokens('https://x.dev 12:30 foo:bar')).toEqual([]);
  });
});

describe('formatQuery と queryTokens', () => {
  it('状態、動き、期間、プロジェクト、ファイル、語の順に書き、空白を含む値は引用符で包む', () => {
    expect(formatQuery('動画', { status: 'paused', live: 'waiting', days: 7, projectId: 'p4', file: 'a b.md' }, projects)).toBe('is:paused is:waiting since:7d project:"my app" file:"a b.md" 動画');
    expect(formatQuery('', {})).toBe('');
    expect(formatQuery('動画', {})).toBe('動画');
  });
  it('終了（ended）と until はトークンを持たない', () => {
    expect(queryTokens({ live: 'ended', until: 5 })).toEqual([]);
  });
  it('チップは項目の名前を持つので、× で外す先が分かる', () => {
    expect(queryTokens({ status: 'done', projectId: 'p1' }, projects)).toEqual([{ key: 'status', token: 'is:done' }, { key: 'projectId', token: 'project:agent-hangar' }]);
  });
  it('書いたものを読み直すと同じ条件に戻る', () => {
    const cases: [string, Partial<SearchFilter>][] = [
      ['動画 本文', { status: 'proposed', days: 30 }],
      ['', { live: 'running', projectId: 'p4', file: 'docs/a b.md' }],
      ['x', { projectId: 'p3' }],
      ['', { status: 'none', projectId: 'p6' }],
    ];
    for (const [text, filter] of cases) expect(parseQuery(formatQuery(text, filter, projects), projects)).toEqual({ text, filter });
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/shared/src/searchTokens.test.ts`
Expected: FAIL（`Failed to resolve import "./searchTokens.ts"`）

- [ ] **Step 3: 型を足す**

`packages/shared/src/intent.ts` の import に次を足す（第 1 段が同じ import を足していれば重ねない）。

```ts
import type { SessionStatus } from './sessionState.ts';
```

`SearchFilter` の定義（12〜17 行）を次に置き換える。

```ts
/**
 * 一覧と検索の絞り込み。
 * 期間は相対の日数（今日を含めて何日分か）で持ち、時刻には問い合わせる瞬間に直す。
 * 絶対の時刻で持つと、時間が経つにつれて選んだ帯と中身が食い違う。
 * status はセッションの状態のタブ（★）。none は状態も提案も無いもの、active は動いているもの、proposed は Claude の提案が残っているもの。
 * 無ければ「すべて」で、条件を入れたときだけ Archived を除く（presenters/sessions.ts と、サーバの検索の hideArchived）。
 */
export type SearchFilter = { projectId?: string; days?: number; until?: number; live?: LiveFilter; file?: string; status?: SessionStatus | 'none' | 'active' | 'proposed' };
/** 状態のタブの値（「すべて」以外）。 */
export type StatusFilter = NonNullable<SearchFilter['status']>;
```

28 行の `| { type: 'search.query'; text: string } | { type: 'search.filter'; patch: Partial<SearchFilter> }` を次に置き換える。

```ts
  // filter は Sessions の欄で Enter したときに、欄を読んだ条件をまるごと渡す（欄が正）。無ければ今の絞り込みを保つ（パレットの全文検索）。
  | { type: 'search.query'; text: string; filter?: SearchFilter } | { type: 'search.filter'; patch: Partial<SearchFilter> }
```

33 行（`project.open` と `project.setStatus` の行）の直後に足す。

```ts
  // プロジェクト画面の節を広げる・畳む（P3）。Done の「ほか N 件」と、末尾の Archived の行。
  | { type: 'project.section.toggle'; projectId: ProjectId; section: 'done' | 'archived' }
```

`packages/shared/src/api.ts` の import に `import type { SessionStatus } from './sessionState.ts';` を足し（第 1 段が足していれば重ねない）、49 行の `SearchParamsDto` を次に置き換える。

```ts
/**
 * status はセッションの状態で絞る（session_states を見る）。hideArchived は「すべて」のタブで条件を入れたときに Archived を除く印である。
 * どちらも Sessions 画面だけが送り、MCP の search_sessions は送らない。
 */
export type SearchParamsDto = { q: string; projectId?: string; since?: number; until?: number; live?: LiveFilter; file?: string; limit?: number; offset?: number; status?: SessionStatus | 'none' | 'active' | 'proposed'; hideArchived?: boolean };
```

- [ ] **Step 4: トークンの読み書きを書く**

`packages/shared/src/searchTokens.ts` を作る。

```ts
import type { SearchFilter, StatusFilter } from './intent.ts';

/**
 * Sessions 画面の検索欄のトークン（★）。
 * 欄を正とし、タブと絞り込みはその表示である。読むのは parseQuery、書くのは formatQuery で、どちらも純粋な関数にする。
 * 読めないトークン（打ち間違い、当たらないプロジェクト）は捨てずに語として残し、badTokens が知らせる。
 * 黙って捨てると、利用者には絞り込みが効いたように見えて、実は全件を見ていることになるからである。
 */

/** チップ 1 つが受け持つ絞り込みの項目。 */
export type QueryKey = 'status' | 'live' | 'days' | 'projectId' | 'file';
/** 欄の中のチップ。token は欄に書く綴りそのもの。 */
export type QueryToken = { key: QueryKey; token: string };
/** project: を名前で引くための、プロジェクトの id と名前。 */
export type QueryProject = { id: string; name: string };

const STATUS_WORDS: readonly string[] = ['paused', 'done', 'archived', 'active', 'none', 'proposed'];
const LIVE_WORDS: readonly string[] = ['running', 'waiting'];
/** since: で受ける日数の上限。打ち間違いの桁あふれを通さない。 */
const MAX_DAYS = 3650;
/** key:"空白を含む値"、key:値、ただの語の 3 つ。 */
const PART = /([A-Za-z]+):"([^"]*)"|([A-Za-z]+):(\S+)|(\S+)/g;
/** 読めなければ知らせる鍵。ほかの鍵のコロン（URL や時刻）は、ただの語である。 */
const KNOWN_KEY = /^(is|since|project|file):/i;

/** 名前の比べ方。macOS のフォルダ名は濁点を分けた NFD で来ることがあるので、NFC にそろえてから小文字で比べる。 */
const fold = (s: string) => s.normalize('NFC').toLowerCase();

/**
 * project: の値に当たるプロジェクト。
 * 名前がそのまま同じものを先に取り、無ければ前方一致のうち名前の短いもの（同じ長さなら名前の順）を取る。
 */
function resolveProject(prefix: string, projects: readonly QueryProject[]): string | null {
  const p = fold(prefix);
  if (p === '') return null;
  const exact = projects.find((x) => fold(x.name) === p);
  if (exact) return exact.id;
  const hits = projects.filter((x) => fold(x.name).startsWith(p)).sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return hits[0]?.id ?? null;
}

/** 1 つのトークンを filter に書く。読めたら true。同じ項目は後に書いたものが勝つ。 */
function readToken(key: string, value: string, filter: Partial<SearchFilter>, projects: readonly QueryProject[]): boolean {
  switch (key) {
    case 'is': {
      const v = value.toLowerCase();
      if (STATUS_WORDS.includes(v)) { filter.status = v as StatusFilter; return true; }
      if (LIVE_WORDS.includes(v)) { filter.live = v as 'running' | 'waiting'; return true; }
      return false;
    }
    case 'since': {
      const m = /^(\d{1,4})d$/i.exec(value);
      const n = m ? Number(m[1]) : 0;
      if (n < 1 || n > MAX_DAYS) return false;
      filter.days = n;
      return true;
    }
    case 'project': {
      const id = resolveProject(value, projects);
      if (id === null) return false;
      filter.projectId = id;
      return true;
    }
    case 'file':
      if (value === '') return false;
      filter.file = value;
      return true;
    default:
      return false;
  }
}

function scan(input: string, projects: readonly QueryProject[]): { text: string; filter: Partial<SearchFilter>; bad: string[] } {
  const words: string[] = [];
  const bad: string[] = [];
  const filter: Partial<SearchFilter> = {};
  for (const m of input.matchAll(PART)) {
    const [raw, qKey, qVal, bKey, bVal, plain] = m;
    if (plain !== undefined) {
      // is: のように値の無いものは、ここに落ちる。
      if (KNOWN_KEY.test(plain)) bad.push(plain);
      words.push(plain);
      continue;
    }
    if (readToken((qKey ?? bKey)!.toLowerCase(), (qVal ?? bVal)!, filter, projects)) continue;
    if (KNOWN_KEY.test(raw)) bad.push(raw);
    words.push(raw);
  }
  return { text: words.join(' '), filter, bad };
}

/**
 * 欄の文字列を、検索語と絞り込みに分ける。
 * projects を渡さなければ project: は読めず、語として残る。
 */
export function parseQuery(text: string, projects: readonly QueryProject[] = []): { text: string; filter: Partial<SearchFilter> } {
  const r = scan(text, projects);
  return { text: r.text, filter: r.filter };
}

/** 読めなかったトークン。欄の下で、語として本文を探していることを知らせるのに使う。 */
export function badTokens(text: string, projects: readonly QueryProject[] = []): string[] {
  return scan(text, projects).bad;
}

/** 空白か二重引用符を含む値は引用符で包む。値の中の二重引用符は書けないので落とす。 */
const quote = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

/**
 * 絞り込みをチップの並びにする。並びは状態、動き、期間、プロジェクト、ファイルの順。
 * 動きの終了（ended）と期間の終わり（until）はトークンを持たないので出さない。条件の行と「条件をクリア」で外せる。
 * 見つからないプロジェクトは名前の代わりに id を書く。読み直しても当たらないので、欄の下に知らせが出る。
 */
export function queryTokens(filter: Partial<SearchFilter>, projects: readonly QueryProject[] = []): QueryToken[] {
  const out: QueryToken[] = [];
  if (filter.status) out.push({ key: 'status', token: `is:${filter.status}` });
  if (filter.live === 'running' || filter.live === 'waiting') out.push({ key: 'live', token: `is:${filter.live}` });
  if (filter.days) out.push({ key: 'days', token: `since:${filter.days}d` });
  if (filter.projectId) out.push({ key: 'projectId', token: `project:${quote(projects.find((p) => p.id === filter.projectId)?.name ?? filter.projectId)}` });
  if (filter.file) out.push({ key: 'file', token: `file:${quote(filter.file)}` });
  return out;
}

/** 検索語と絞り込みを、欄に書く 1 本の文字列にする。トークンを先に、語を後ろに置く。 */
export function formatQuery(text: string, filter: Partial<SearchFilter>, projects: readonly QueryProject[] = []): string {
  return [...queryTokens(filter, projects).map((t) => t.token), text].filter((s) => s !== '').join(' ');
}
```

`packages/shared/src/index.ts` の末尾に足す。

```ts
export * from './searchTokens.ts';
```

- [ ] **Step 5: 試験と型が通ることを確かめる**

Run: `npx vitest run packages/shared/src/searchTokens.test.ts && npm run typecheck`
Expected: PASS（`searchTokens.test.ts` の 14 件が通り、型の誤りが無い）

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/intent.ts packages/shared/src/api.ts packages/shared/src/searchTokens.ts packages/shared/src/searchTokens.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): read and write status tokens in the sessions search field

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: サーバの検索をセッションの状態で絞る

**Files:**
- Modify: `packages/server/src/search/search.ts:36-46`（説明）、`:60-75`（where と、キーワードの無い経路）、`:83`（動きの絞り込み）
- Modify: `packages/server/src/http/app.ts:4`（import）、`:410-419`（`/api/search`）
- Test: `packages/server/src/search/search.test.ts`、`packages/server/src/http/app.test.ts`

**Interfaces:**
- Consumes: `SearchParamsDto.status`・`hideArchived`（Task 1）、`setSessionState`・`proposeSessionState`（第 1 段の `packages/server/src/sessions/states.ts`、試験だけで使う）
- Produces: `searchSessions(db, params, liveOf)` が `params.status` と `params.hideArchived` を見る。`GET /api/search?status=<値>&hideArchived=true`。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/search/search.test.ts` の import に足す。

```ts
import { proposeSessionState, setSessionState } from '../sessions/states.ts';
```

ファイルの末尾（`describe('likeSnippet'` の前）に足す。

```ts
describe('searchSessions の状態（session_states）', () => {
  // マイグレーション v13 の一括 Done は空の DB で走るので、索引の後に入ったセッションには行が無く、印なしである。
  it('Paused・Done・Archived は状態の列で、印なしは状態も提案も無いもので絞る', () => {
    const alpha = idOf(SESSION_ALPHA);
    expect(searchSessions(db, { q: 'channels', status: 'none' }).total).toBe(1);
    setSessionState(db, 'd', alpha, { status: 'paused', note: '明日確かめる', returnOn: '2026-10-02', setBy: 'user' });
    expect(searchSessions(db, { q: 'channels', status: 'paused' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', status: 'done' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', status: 'none' }).total).toBe(0);
    // キーワードの無い、触ったファイルだけの経路でも効く。
    expect(searchSessions(db, { q: '', file: 'a.md', status: 'paused' }).total).toBe(1);
    expect(searchSessions(db, { q: '', file: 'a.md', status: 'done' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello', status: 'none' }).hits.map((h) => h.sessionId)).toEqual([idOf(SESSION_OTHER)]);
  });
  it('確かめるは、状態の無い行に残った提案だけを数える', () => {
    const other = idOf(SESSION_OTHER);
    expect(searchSessions(db, { q: 'hello', status: 'proposed' }).total).toBe(0);
    proposeSessionState(db, 'd', other, { status: 'done', note: '直して push した', returnOn: null, source: 'post_hoc' });
    expect(searchSessions(db, { q: 'hello', status: 'proposed' }).total).toBe(1);
    expect(searchSessions(db, { q: 'hello', status: 'none' }).total).toBe(0);
  });
  it('「すべて」で条件を入れたとき（hideArchived）は Archived を除き、Archived のタブなら出す', () => {
    setSessionState(db, 'd', idOf(SESSION_ALPHA), { status: 'archived', setBy: 'user' });
    expect(searchSessions(db, { q: 'channels' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', hideArchived: true }).total).toBe(0);
    expect(searchSessions(db, { q: '', file: 'a.md', hideArchived: true }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', status: 'archived', hideArchived: true }).total).toBe(1);
  });
  it('Active は動いているもの（実行中か入力待ち）で、liveOf で決める', () => {
    const alpha = idOf(SESSION_ALPHA);
    expect(searchSessions(db, { q: 'channels', status: 'active' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', status: 'active' }, (sid) => (sid === alpha ? 'waiting' : 'ended')).total).toBe(1);
    expect(searchSessions(db, { q: '', file: 'a.md', status: 'active' }, (sid) => (sid === alpha ? 'running' : 'ended')).total).toBe(1);
  });
});
```

`packages/server/src/http/app.test.ts` の import に `import { setSessionState } from '../sessions/states.ts';` を足し、`it('検索の状態の絞り込みは、実行中（作業中、休み、起動中）、入力待ち、終了に分ける'` の直後に足す。

```ts
  it('検索はセッションの状態（status）と、Archived を除く印（hideArchived）を受け、知らない値は無視する', async () => {
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    setSessionState(db, 'd', id, { status: 'archived', setBy: 'user' });
    const total = async (qs: string) => (await json(await get(`/api/search?q=channels${qs}`))).body.total;
    expect(await total('')).toBe(1);
    expect(await total('&hideArchived=true')).toBe(0);
    expect(await total('&status=archived&hideArchived=true')).toBe(1);
    expect(await total('&status=done')).toBe(0);
    // 知らない値は絞り込みなしとして扱う。
    expect(await total('&status=bogus')).toBe(1);
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/search/search.test.ts packages/server/src/http/app.test.ts`
Expected: FAIL（`status: 'paused'` で 1 を期待して 2、`hideArchived: true` で 0 を期待して 1 など。状態をまだ見ていないため）

- [ ] **Step 3: 検索に状態の条件を足す**

`packages/server/src/search/search.ts` の説明（43〜44 行）の後ろに 2 行足す。

```ts
 * セッションの状態（Paused・Done・Archived、印なし、提案）は session_states で絞る。行の無いセッションは印なしである。
 * Active（動いているもの）は DB に無いので、動きと同じく liveOf で決める。
```

`if (params.file) { ... }`（65〜68 行）の直後に足す。

```ts
  // 状態と提案を両方持つ行は、状態を正として提案は無いものとする（spec の「失敗の扱い」。画面の読み方と同じ）。
  const stateIs = (cond: string) => `exists (select 1 from session_states st where st.session_id = s.id and st.deleted_at is null and ${cond})`;
  if (params.status === 'paused' || params.status === 'done' || params.status === 'archived') { where.push(stateIs('st.status = ?')); args.push(params.status); }
  if (params.status === 'proposed') where.push(stateIs('st.status is null and st.candidate_at is not null'));
  if (params.status === 'none') where.push(`not ${stateIs('(st.status is not null or st.candidate_at is not null)')}`);
  // 「すべて」のタブで条件を入れたときは、Archived（試し・失敗）を除く。
  if (params.hideArchived && params.status === undefined) where.push(`not ${stateIs("st.status = 'archived'")}`);
  // 動きの絞り込みと Active は、呼ぶ側の liveOf で決める。どちらも無ければ liveOf を呼ばない。
  const keep = (r: { sid: string; psid: string }) => {
    if (params.live === undefined && params.status !== 'active') return true;
    const live = liveOf(r.sid, r.psid);
    return (params.live === undefined || live === params.live) && (params.status !== 'active' || live !== 'ended');
  };
```

73 行と 83 行の `if (params.live !== undefined) rows = rows.filter((r) => liveOf(r.sid, r.psid) === params.live);` を、どちらも次に置き換える。

```ts
    rows = rows.filter(keep);
```

（83 行の側は字下げが 2 つなので `  rows = rows.filter(keep);` にする。）

- [ ] **Step 4: `/api/search` が status と hideArchived を受ける**

`packages/server/src/http/app.ts` の 4 行目の `@agent-hangar/shared` の import に `type SearchParamsDto` を足す。
410〜419 行の `api.get('/search', ...)` を次に置き換える。

```ts
  /** /api/search の status として受ける値。知らない値は絞り込みなしとして扱う。 */
  const STATUS_FILTERS: ReadonlySet<string> = new Set(['paused', 'done', 'archived', 'none', 'active', 'proposed']);
  api.get('/search', (c) => {
    const q = c.req.query();
    const live = q.live === 'running' || q.live === 'waiting' || q.live === 'ended' ? q.live : undefined;
    const status = q.status && STATUS_FILTERS.has(q.status) ? (q.status as NonNullable<SearchParamsDto['status']>) : undefined;
    const hideArchived = q.hideArchived === 'true' || q.hideArchived === '1';
    // 数え方は UI と同じ liveFilterOf に任せる。
    // Claude の一覧に載る前の run も実行中に入れる。
    const liveStatus = new Map(deps.live().map((l) => [l.sessionId, l.status]));
    const alive = new Set(deps.runs.listAlive().runs.filter((r) => r.endedAt === null).map((r) => r.sessionId));
    const liveOf = (sid: string, psid: string) => liveFilterOf(liveStatus.get(psid) ?? null, alive.has(sid));
    return c.json(searchSessions(db, { q: q.q ?? '', projectId: q.projectId || undefined, since: numberOr(q.since), until: numberOr(q.until), live, file: q.file || undefined, limit: numberOr(q.limit), offset: numberOr(q.offset), status, hideArchived }, liveOf));
  });
```

（元の `status` という名の Map は、新しい `status` と名前がぶつかるので `liveStatus` に改めた。）

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `npx vitest run packages/server/src/search/search.test.ts packages/server/src/http/app.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/search/search.ts packages/server/src/search/search.test.ts packages/server/src/http/app.ts packages/server/src/http/app.test.ts
git commit -m "feat(server): filter the session search by status and hide archived on request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 節分けの関数と、節の元の並び

**Files:**
- Modify: `packages/ui/src/presenters/row.ts:42-54`（`sortSessions` の後ろに足す）
- Create: `packages/ui/src/presenters/sections.ts`
- Test: `packages/ui/src/presenters/sections.test.ts`

**Interfaces:**
- Consumes: `SessionRowProps` の `state`・`returnOn`・`candidate`・`live`・`runId`（第 1 段）、`SessionDto.state.setAt`、`isReturnOn`・`localDate`（第 1 段）、`StatusFilter`（Task 1）
- Produces:
  - `sortForSections(list: SessionDto[]): SessionDto[]`（`row.ts`）
  - `type SectionId = 'returning' | 'proposed' | 'live' | 'continue' | 'paused' | 'none' | 'done' | 'archived'`
  - `type ListItem = { kind: 'row'; row: SessionRowProps } | { kind: 'head'; id: SectionId; label: string; count: number; more?: { label: string; target: SectionId } }`
  - `sectionRows(rows: SessionRowProps[], kind: 'project' | 'sessions', o: { now: number; doneHead: number; expanded: Set<string> }): ListItem[]`
  - `DONE_HEAD = 3`、`SECTION_TAB: Partial<Record<SectionId, StatusFilter>>`、`isLive(r): boolean`、`dueOn(returnOn: string | null, today: string): boolean`、`matchesStatus(r: SessionRowProps, f: StatusFilter): boolean`

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/presenters/sections.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import type { SessionDto, SessionStateDto } from '@agent-hangar/shared';
import { periodStart } from '../mediator/screen.ts';
import { sortForSections, type SessionRowProps } from './row.ts';
import { DONE_HEAD, matchesStatus, sectionRows, type ListItem } from './sections.ts';

/** 2026-10-02（金）の朝 9 時。 */
const NOW = new Date(2026, 9, 2, 9, 0).getTime();
const H = 3_600_000;
const DAY = 24 * H;
const IMPORT_AT = new Date(2026, 9, 1, 8, 0).getTime();

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: id, oneLiner: '', projectName: 'agent-hangar', live: null, stateLabel: '', summaryState: null, model: '', effort: '', when: '', whenAbs: '', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, overdueDays: null, candidate: null, setBy: null, ...over });
const paused = (id: string, returnOn: string | null, over: Partial<SessionRowProps> = {}) => row(id, { state: 'paused', returnOn, setBy: 'user', ...over });
const done = (id: string, over: Partial<SessionRowProps> = {}) => row(id, { state: 'done', setBy: 'import', ...over });
const cand = (status: 'paused' | 'done') => ({ status, note: '直した', returnOn: status === 'paused' ? '2026-10-03' : null, source: 'in_session' as const, ago: '1 時間前' });
/** 見出しを「# id 件数 [ボタン→先]」、行を id にして並びを読む。 */
const shape = (items: ListItem[]) => items.map((i) => (i.kind === 'head' ? `# ${i.id} ${i.count}${i.more ? ` [${i.more.label}→${i.more.target}]` : ''}` : i.row.id));
const project = (rows: SessionRowProps[], expanded: string[] = [], now = NOW) => shape(sectionRows(rows, 'project', { now, doneHead: DONE_HEAD, expanded: new Set(expanded) }));
const sessions = (rows: SessionRowProps[], expanded: string[] = [], now = NOW) => shape(sectionRows(rows, 'sessions', { now, doneHead: DONE_HEAD, expanded: new Set(expanded) }));

describe('sectionRows（プロジェクト画面の P3）', () => {
  it('導入の翌日：全部 Done なら Done の節だけで、直近 3 件と「ほか N 件」を出し、広げれば全件', () => {
    const rows = [done('cpu'), done('nfd'), done('resp'), done('ux')];
    expect(project(rows)).toEqual(['# done 4 [ほか 1 件 ▸→done]', 'cpu', 'nfd', 'resp']);
    expect(project(rows, ['done'])).toEqual(['# done 4 [畳む ▴→done]', 'cpu', 'nfd', 'resp', 'ux']);
  });
  it('平日の朝：今日戻る → 続き → Done の順で、中身の無い節（いま動いている）は出さない', () => {
    const rows = [row('backspace'), row('nfd', { candidate: cand('done') }), done('resp'), paused('sync', '2026-10-02'), paused('explainer', '2026-10-09'), row('apple'), paused('retention', '2026-10-06')];
    // 続きは印なし、提案あり、戻る日が先の Paused を、渡された並び（新しい順）のまま並べる。目当ての backspace は j 2 回で届く。
    expect(project(rows)).toEqual(['# returning 1', 'sync', '# continue 5', 'backspace', 'nfd', 'explainer', 'apple', 'retention', '# done 1', 'resp']);
  });
  it('作業中：動いているものは状態に関わらず「いま動いている」に、入力待ち → 実行中の並びのまま置く', () => {
    const rows = [row('newui', { live: 'waiting' }), done('status', { live: 'busy', setBy: 'user' }), row('trial', { state: 'archived', live: 'idle' }), row('boot', { runId: 'r1' }), done('ux', { setBy: 'user' }), row('backspace'), paused('sync', '2026-10-03'), done('resp')];
    expect(project(rows)).toEqual(['# live 4', 'newui', 'status', 'trial', 'boot', '# continue 2', 'backspace', 'sync', '# done 2', 'ux', 'resp']);
  });
  it('2 週間後：期限の過ぎた Paused 4 件は、利用者が決めるまで「今日戻る」に戻る日の古い順で残る', () => {
    const later = new Date(2026, 9, 16, 9, 0).getTime();
    const rows = [row('impl'), paused('newui', '2026-10-03'), paused('sync', '2026-10-04'), paused('explainer', '2026-10-07'), paused('retention', '2026-10-06'), done('nfd')];
    expect(project(rows, [], later)).toEqual(['# returning 4', 'newui', 'sync', 'retention', 'explainer', '# continue 1', 'impl', '# done 1', 'nfd']);
  });
  it('Archived は末尾の 1 行にまとめ、広げると行を出す', () => {
    const rows = [row('a'), row('trash', { state: 'archived' }), row('try', { state: 'archived' })];
    expect(project(rows)).toEqual(['# continue 1', 'a', '# archived 2 [表示 ▸→archived]']);
    expect(project(rows, ['archived'])).toEqual(['# continue 1', 'a', '# archived 2 [隠す ▴→archived]', 'trash', 'try']);
  });
  it('中身がある節だけを出し、何も無ければ空', () => {
    expect(project([])).toEqual([]);
    expect(project([done('x')])).toEqual(['# done 1', 'x']);
  });
  it('「今日」の境は手元の暦の 0 時（periodStart(1, now) と同じ）', () => {
    const midnight = periodStart(1, NOW);
    const rows = [paused('p', '2026-10-02')];
    expect(project(rows, [], midnight)).toEqual(['# returning 1', 'p']);
    expect(project(rows, [], midnight - 1)).toEqual(['# continue 1', 'p']);
  });
  // 同期や古い端末から、戻る日の無い Paused が届くことがある。続きに紛れると、しおりを見失う。
  it('戻る日が欠けた Paused と暦に無い日の Paused は、落とさずに「今日戻る」の先頭に置く', () => {
    const rows = [paused('ok', '2026-10-01'), paused('none', null), paused('broken', '2026-02-30'), paused('later', '2026-10-05')];
    expect(project(rows)).toEqual(['# returning 3', 'none', 'broken', 'ok', '# continue 1', 'later']);
    expect(sessions(rows)).toEqual(['# returning 3', 'none', 'broken', 'ok', '# paused 1 [この節だけ見る ▸→paused]', 'later']);
  });
});

describe('sectionRows（Sessions 画面の ★）', () => {
  it('今日戻る → 確かめる → いま動いている → Paused → 印なし → Done、Archived は末尾の 1 行', () => {
    const rows = [row('newui', { live: 'waiting' }), row('status', { live: 'busy' }), row('nfd', { candidate: cand('done') }), row('video', { candidate: cand('paused') }), row('e2e', { candidate: cand('done') }), row('backspace'), paused('sync', '2026-10-02'), paused('parkour', '2026-10-09'), done('resp'), done('subs'), row('apple', { state: 'archived' })];
    expect(sessions(rows)).toEqual([
      '# returning 1', 'sync',
      '# proposed 3 [この節だけ見る ▸→proposed]', 'nfd', 'video', 'e2e',
      '# live 2 [この節だけ見る ▸→live]', 'newui', 'status',
      '# paused 1 [この節だけ見る ▸→paused]', 'parkour',
      '# none 1 [この節だけ見る ▸→none]', 'backspace',
      '# done 2 [この節だけ見る ▸→done]', 'resp', 'subs',
      '# archived 1 [表示 ▸→archived]',
    ]);
  });
  it('Done は直近 3 件と「ほか N 件」で、広げる代わりにタブへ移るので expanded を使わない', () => {
    const rows = [done('a'), done('b'), done('c'), done('d'), done('e')];
    expect(sessions(rows, ['done'])).toEqual(['# done 5 [ほか 2 件 ▸→done]', 'a', 'b', 'c']);
  });
});

describe('matchesStatus（タブの絞り込み）', () => {
  it('節の振り分けではなく、行の持ち物だけで決める', () => {
    const liveDone = row('l', { live: 'idle', state: 'done' });
    expect(matchesStatus(liveDone, 'active')).toBe(true);
    expect(matchesStatus(liveDone, 'done')).toBe(true);
    expect(matchesStatus(row('b', { runId: 'r1' }), 'active')).toBe(true);
    expect(matchesStatus(row('c', { candidate: cand('done') }), 'proposed')).toBe(true);
    expect(matchesStatus(row('c', { candidate: cand('done') }), 'none')).toBe(false);
    expect(matchesStatus(row('n'), 'none')).toBe(true);
    expect(matchesStatus(row('n'), 'active')).toBe(false);
    expect(matchesStatus(paused('p', '2026-10-09'), 'paused')).toBe(true);
    expect(matchesStatus(row('z', { state: 'archived' }), 'archived')).toBe(true);
  });
});

describe('sortForSections', () => {
  const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null, ...o });
  const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: NOW - H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, state: null, ...over });
  // 確定した行や手で Done にした行は、最後に動いた時刻が古くても Done の節の先頭に来る。畳んだ中に消えないように。
  it('Done の行は Done にした時刻の新しい順、導入時の一括（同じ時刻）の中は最後に動いた時刻の新しい順', () => {
    const list = [
      dto('imp-old', { lastActivityAt: NOW - 3 * DAY, state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }),
      dto('open', { lastActivityAt: NOW - 2 * H }),
      dto('confirmed', { lastActivityAt: NOW - 10 * DAY, state: st({ status: 'done', setBy: 'user', setAt: NOW - 60_000 }) }),
      dto('imp-new', { lastActivityAt: NOW - DAY, state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }),
      dto('live', { live: 'busy', lastActivityAt: NOW - 5 * DAY, state: st({ status: 'done', setBy: 'user', setAt: NOW }) }),
      dto('older', { lastActivityAt: NOW - 4 * DAY }),
    ];
    const ids = sortForSections(list).map((s) => s.id);
    expect(ids[0]).toBe('live');
    expect(ids.filter((id) => ['confirmed', 'imp-new', 'imp-old'].includes(id))).toEqual(['confirmed', 'imp-new', 'imp-old']);
    expect(ids.filter((id) => ['open', 'older'].includes(id))).toEqual(['open', 'older']);
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/sections.test.ts`
Expected: FAIL（`Failed to resolve import "./sections.ts"`）

- [ ] **Step 3: 節の元の並びを書く**

`packages/ui/src/presenters/row.ts` の `sortSessions`（42〜54 行）の後ろに足す。

```ts
/**
 * 節に分ける前の並び（P3 と ★）。
 * 生きているものを先に置くのは sortSessions と同じで、残りは新しい順にする。
 * 止まっている Done の行だけは、Done にした時刻（setAt）の新しい順にする。
 * 提案を確定した行や手で Done にした行が、最後に動いた時刻が古くても Done の節の先頭に来て、畳んだ中に消えないようにするためである。
 * 導入時の一括 Done は同じ時刻を持つので、その中は最後に動いた時刻の新しい順になる。
 */
export function sortForSections(list: SessionDto[]): SessionDto[] {
  const key = (s: SessionDto) => (s.live === null && s.state?.status === 'done' ? s.state.setAt ?? 0 : s.lastActivityAt ?? 0);
  return [...list].sort((a, b) => {
    const la = a.live ? LIVE_ORDER[a.live] ?? 3 : ENDED_ORDER;
    const lb = b.live ? LIVE_ORDER[b.live] ?? 3 : ENDED_ORDER;
    if (la !== lb) return la - lb;
    return key(b) - key(a) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
}
```

- [ ] **Step 4: 節分けの関数を書く**

`packages/ui/src/presenters/sections.ts` を作る。

```ts
import { isReturnOn, localDate, type StatusFilter } from '@agent-hangar/shared';
import type { SessionRowProps } from './row.ts';

/**
 * 一覧の節（P3 と ★）。
 * returning は今日戻る、proposed は確かめる（Claude の提案が残っているもの）、live はいま動いている、
 * continue はプロジェクト画面の続き（印なし、提案あり、戻る日が先の Paused）、paused と none は Sessions の Paused と印なしである。
 */
export type SectionId = 'returning' | 'proposed' | 'live' | 'continue' | 'paused' | 'none' | 'done' | 'archived';
/**
 * 一覧の項目。行と、節の見出しの和にする。
 * 見出しの count はその節の全件の数で、畳んで見せていない行も数える。
 * more は見出しの右端のボタンで、押すと target の節を広げるか（プロジェクト画面）、そのタブへ移る（Sessions）。
 */
export type ListItem = { kind: 'row'; row: SessionRowProps } | { kind: 'head'; id: SectionId; label: string; count: number; more?: { label: string; target: SectionId } };

/** Done の節で畳まずに見せる件数。導入の翌日に一覧が空にならず、確定した行も見失わない数にする（spec の P3）。 */
export const DONE_HEAD = 3;

const LABEL: Record<SectionId, string> = { returning: '今日戻る', proposed: '確かめる', live: 'いま動いている', continue: '続き', paused: 'Paused', none: '印なし', done: 'Done', archived: 'Archived' };
/** 節の並び。Archived はどちらも末尾の 1 行にする。 */
const ORDER: Record<'project' | 'sessions', SectionId[]> = {
  project: ['returning', 'live', 'continue', 'done', 'archived'],
  sessions: ['returning', 'proposed', 'live', 'paused', 'none', 'done', 'archived'],
};
/** Sessions の節とタブの対応。今日戻るにはタブが無い（Paused のタブが今日戻るも含む）。 */
export const SECTION_TAB: Partial<Record<SectionId, StatusFilter>> = { proposed: 'proposed', live: 'active', paused: 'paused', none: 'none', done: 'done', archived: 'archived' };

/** 動いているか（入力待ち、作業中、休み、起動中）。Claude の一覧に載る前でも、hangar の run が生きていれば動いている（shared の liveFilterOf と同じ）。 */
export function isLive(r: SessionRowProps): boolean {
  return r.live !== null || r.runId !== null;
}

/**
 * 戻る日が来ているか。today は手元の暦の今日（localDate）。
 * 戻る日が欠けたり、暦に無い日だったりする Paused（同期や古い端末から届いた行）も、来ているとみなす。
 * 黙って続きに紛れると、しおりとして挟んだものを見失うからである。
 */
export function dueOn(returnOn: string | null, today: string): boolean {
  return returnOn === null || !isReturnOn(returnOn) || returnOn <= today;
}

/** タブの絞り込み。節の振り分けとは違い、行の持ち物だけで決める（動いている Done は Active にも Done にも入る）。 */
export function matchesStatus(r: SessionRowProps, f: StatusFilter): boolean {
  switch (f) {
    case 'active': return isLive(r);
    case 'proposed': return r.candidate !== null;
    case 'none': return r.state === null && r.candidate === null;
    default: return r.state === f;
  }
}

/** 行の節。動いているものは状態に関わらず「いま動いている」に置く。 */
function sectionOf(r: SessionRowProps, kind: 'project' | 'sessions', today: string): SectionId {
  if (isLive(r)) return 'live';
  if (r.state === 'archived') return 'archived';
  if (r.state === 'paused' && dueOn(r.returnOn, today)) return 'returning';
  if (kind === 'project') return r.state === 'done' && r.candidate === null ? 'done' : 'continue';
  if (r.candidate !== null) return 'proposed';
  if (r.state === 'paused') return 'paused';
  return r.state === 'done' ? 'done' : 'none';
}

/** 今日戻るの並びの鍵。欠けた日と壊れた日は空にして先頭へ置く。 */
const returnKey = (r: SessionRowProps) => (r.returnOn !== null && isReturnOn(r.returnOn) ? r.returnOn : '');

/** 見出しの右端のボタン。プロジェクト画面はその場で広げ、Sessions はそのタブへ移る。 */
function moreOf(id: SectionId, kind: 'project' | 'sessions', count: number, open: boolean, doneHead: number): { label: string; target: SectionId } | undefined {
  const rest = count - doneHead;
  if (kind === 'project') {
    if (id === 'done' && rest > 0) return { label: open ? '畳む ▴' : `ほか ${rest} 件 ▸`, target: 'done' };
    if (id === 'archived') return { label: open ? '隠す ▴' : '表示 ▸', target: 'archived' };
    return undefined;
  }
  if (id === 'done' && rest > 0) return { label: `ほか ${rest} 件 ▸`, target: 'done' };
  if (id === 'archived') return { label: '表示 ▸', target: 'archived' };
  return SECTION_TAB[id] ? { label: 'この節だけ見る ▸', target: id } : undefined;
}

/**
 * 行を節に分けて、見出しと行の並びにする。中身がある節だけを出す。
 * rows は sortForSections の並びで渡す。節の中はその並びを保ち、今日戻るだけを戻る日の古い順に並べ直す。
 * Done は doneHead 件まで、Archived は見出しだけを出す。
 * expanded に入った節（'done'、'archived'）は、プロジェクト画面では全件を出す。Sessions では使わない（広げる代わりにタブへ移る）。
 */
export function sectionRows(rows: SessionRowProps[], kind: 'project' | 'sessions', o: { now: number; doneHead: number; expanded: Set<string> }): ListItem[] {
  const today = localDate(o.now);
  const by = new Map<SectionId, SessionRowProps[]>();
  for (const r of rows) {
    const id = sectionOf(r, kind, today);
    const list = by.get(id);
    if (list) list.push(r);
    else by.set(id, [r]);
  }
  // sort は安定なので、同じ戻る日の中は渡された並び（新しい順）のまま残る。
  by.get('returning')?.sort((a, b) => returnKey(a).localeCompare(returnKey(b)));
  const out: ListItem[] = [];
  for (const id of ORDER[kind]) {
    const list = by.get(id);
    if (!list || list.length === 0) continue;
    const open = kind === 'project' && o.expanded.has(id);
    const more = moreOf(id, kind, list.length, open, o.doneHead);
    out.push(more ? { kind: 'head', id, label: LABEL[id], count: list.length, more } : { kind: 'head', id, label: LABEL[id], count: list.length });
    const shown = id === 'done' && !open ? list.slice(0, o.doneHead) : id === 'archived' && !open ? [] : list;
    for (const row of shown) out.push({ kind: 'row', row });
  }
  return out;
}
```

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/sections.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/presenters/row.ts packages/ui/src/presenters/sections.ts packages/ui/src/presenters/sections.test.ts
git commit -m "feat(ui): split session rows into sections for the project and sessions screens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: SessionRows が節の見出しを受け、カーソルは見出しを飛ばす

**Files:**
- Modify: `packages/ui/src/views/SessionRows.tsx:1-7`（import）、`:12-13`（高さ）、`:45-55`（説明と引数）、`:62-63`、`:88`、`:98`、`:109`、`:134-136`、`:149`、`:197-215`（描画）
- Modify: `packages/ui/src/styles/tokens.css:64`
- Modify: `packages/ui/src/styles/rows.css:90`（`.hit` の後ろに足す）
- Test: `packages/ui/src/styles/rows.test.ts:7-30`、`packages/ui/src/views/SessionRows.sections.test.tsx`（新規）

**Interfaces:**
- Consumes: `ListItem`・`SectionId`（Task 3）、`StatusFilter`・`Intent`（Task 1）
- Produces:
  - `SECTION_HEAD_H = 32`（`SessionRows.tsx`）と `--section-head-h: 32px`（`tokens.css`）
  - `SessionRows` の引数は `{ rows: SessionRowProps[] } | { items: ListItem[] }` のどちらかに、今までの引数と次の 2 つを足したもの
    - `moreIntent?: (target: SectionId) => Intent | null`（見出しのボタン。null ならボタンを出さない）
    - `badgeIntent?: (status: StatusFilter) => Intent`（行の状態の札を押したとき。無ければ札は押せない）
  - 行の要素に `data-archived="true"`（Archived の行）

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/styles/rows.test.ts` の import を `import { SECTION_HEAD_H, SESSION_ROW_H } from '../views/SessionRows.tsx';` にし、`describe('2 段の行'` の中の最後（29 行の後ろ）に足す。

```ts
  // 見出しの見積もりと CSS の高さがずれると、節の多い一覧でスクロールの位置が行の途中で止まる。
  it('節の見出しの高さは 32px で、tokens.css と SessionRows の見積もりが揃う', () => {
    expect(SECTION_HEAD_H).toBe(32);
    expect(read('./tokens.css')).toContain(`--section-head-h: ${SECTION_HEAD_H}px;`);
    expect(read('./rows.css')).toMatch(/\.row-head \{[^}]*height: var\(--section-head-h\);/);
  });
  it('Archived の行は名前を注記の色で淡く出す', () => {
    // --ink-3 も白地で 4.5 : 1 を超える（tokens.test.ts）。淡くしても読める。
    expect(read('./rows.css')).toMatch(/\.row\[data-archived='true'\] \.row-name \{[^}]*color: var\(--ink-3\);/);
  });
```

`packages/ui/src/views/SessionRows.sections.test.tsx` を作る。

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import type { ListItem, SectionId } from '../presenters/sections.ts';
import { SessionRows } from './SessionRows.tsx';

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, overdueDays: null, candidate: null, setBy: null, ...over });
const head = (id: SectionId, label: string, count: number, more?: { label: string; target: SectionId }): ListItem => (more ? { kind: 'head', id, label, count, more } : { kind: 'head', id, label, count });
const r = (id: string, over?: Partial<SessionRowProps>): ListItem => ({ kind: 'row', row: row(id, over) });
const ITEMS: ListItem[] = [head('returning', '今日戻る', 1), r('a'), head('continue', '続き', 2), r('b'), r('c'), head('done', 'Done', 1221, { label: 'ほか 1218 件 ▸', target: 'done' }), r('d')];
const toggle = (target: SectionId) => (target === 'done' ? { type: 'project.section.toggle' as const, projectId: 'p1', section: 'done' as const } : null);
const mount = (items: ListItem[] = ITEMS, onIntent = vi.fn()) => ({ ...render(<IntentRoot onIntent={onIntent}><SessionRows items={items} height={400} variant="project" moreIntent={toggle} /></IntentRoot>), onIntent });
const rowsOf = () => [...screen.getByTestId('session-rows').querySelectorAll<HTMLElement>('[role="row"]')];
const list = () => screen.getByTestId('session-rows');

describe('SessionRows の節の見出し（P3 と ★）', () => {
  it('見出しは行ではなく、名前と桁を区切った件数と右端のボタンを出す', () => {
    mount();
    expect(rowsOf()).toHaveLength(4);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['今日戻る1', '続き2', 'Done1,221ほか 1218 件 ▸']);
  });
  it('j と k は見出しを飛ばして行だけを動く', () => {
    const { onIntent } = mount();
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'b' });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'd' });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(list(), { key: 'k' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'a' });
  });
  it('Tab で止まるのは先頭の行で、見出しには止まらない', () => {
    mount();
    expect(rowsOf().map((x) => x.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(screen.getAllByRole('heading', { level: 2 }).every((h) => !h.hasAttribute('tabindex'))).toBe(true);
  });
  it('見出しのボタンは moreIntent の Intent を出し、行は開かない。null ならボタンを出さない', () => {
    const { onIntent } = mount([head('done', 'Done', 5, { label: 'ほか 2 件 ▸', target: 'done' }), r('a'), head('archived', 'Archived', 2, { label: '表示 ▸', target: 'archived' })]);
    fireEvent.click(screen.getByRole('button', { name: 'ほか 2 件 ▸' }));
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.section.toggle', projectId: 'p1', section: 'done' });
    expect(screen.queryByRole('button', { name: '表示 ▸' })).toBeNull();
  });
  it('見出しを押しても何も起きない', () => {
    const { onIntent } = mount();
    fireEvent.click(screen.getByRole('heading', { name: /^今日戻る/ }));
    expect(onIntent).not.toHaveBeenCalled();
  });
  // 選んでいた行が畳んだ Done の中へ移ると、見えない行が Enter で開いてしまう。
  it('選んでいた行が一覧から消えたら、未選択に戻る', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SessionRows items={ITEMS} height={400} variant="project" /></IntentRoot>);
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'j' });
    rerender(<IntentRoot onIntent={onIntent}><SessionRows items={[head('returning', '今日戻る', 1), r('a'), head('continue', '続き', 1), r('c'), head('done', 'Done', 1222), r('d')]} height={400} variant="project" /></IntentRoot>);
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'a' });
  });
  it('行だけの rows も今までどおり受け、見出しを出さない', () => {
    render(<IntentRoot onIntent={vi.fn()}><SessionRows rows={[row('x')]} height={400} variant="recent" /></IntentRoot>);
    expect(rowsOf()).toHaveLength(1);
    expect(screen.queryByRole('heading')).toBeNull();
  });
  it('Archived の行に印を付ける', () => {
    mount([r('z', { state: 'archived' }), r('y')]);
    expect(rowsOf().map((x) => x.getAttribute('data-archived'))).toEqual(['true', null]);
  });
});

describe('SessionRows の状態の札（★ の E）', () => {
  it('badgeIntent があれば、状態の札がそのタブへ移るボタンになり、行は開かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[row('d1', { state: 'done' }), row('a1', { state: 'archived' }), row('p1', { state: 'paused', returnOn: '2026-10-09' })]} height={400} variant="search" badgeIntent={(status) => ({ type: 'search.filter', patch: { status } })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'Done のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: 'Archived のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'archived' } });
    fireEvent.click(screen.getByRole('button', { name: 'Paused のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'paused' } });
    expect(onIntent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
  it('badgeIntent が無ければ札は押せない', () => {
    render(<IntentRoot onIntent={vi.fn()}><SessionRows rows={[row('d1', { state: 'done' })]} height={400} variant="project" /></IntentRoot>);
    expect(screen.queryByRole('button', { name: /のセッションだけを見る$/ })).toBeNull();
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/SessionRows.sections.test.tsx packages/ui/src/styles/rows.test.ts`
Expected: FAIL（`SECTION_HEAD_H` が無い、`items` を受けない、など）

- [ ] **Step 3: 見出しの高さのトークンと CSS を足す**

`packages/ui/src/styles/tokens.css` の `--session-row-h: 56px;`（64 行）の直後に足す。

```css
  --section-head-h: 32px;
```

`packages/ui/src/styles/rows.css` の `.hit { ... }`（90 行）の直後に足す。

```css

/* 節の見出し（P3 と ★）。仮想スクロールの項目として行のあいだに挟む。
   高さは --section-head-h で持ち、SessionRows の SECTION_HEAD_H と揃える（rows.test.ts）。 */
.row-head { display: flex; align-items: flex-end; gap: calc(var(--u) * 1.5); height: var(--section-head-h); padding: 0 calc(var(--u) * 5) calc(var(--u) * 1.5); font-size: var(--fs-sm); font-weight: 600; color: var(--ink-2); }
.row-head-count { font-weight: 500; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.row-head-more { margin-left: auto; padding: 0 var(--u); border: 0; border-radius: 5px; background: none; font: inherit; font-size: var(--fs-xs); font-weight: 560; color: var(--accent); cursor: pointer; }
.row-head-more:hover { text-decoration: underline; }
/* 末尾の Archived の行は、ほかの節より控えめにする。 */
.row-head[data-section='archived'] { font-weight: 500; color: var(--ink-3); }
/* Archived の行は名前を淡くする。注記の色（--ink-3）も白地で 4.5 : 1 を超える。 */
.row[data-archived='true'] .row-name { color: var(--ink-3); font-weight: 400; }
/* 状態の札を押してタブへ移る（★ の E）。札の見た目はそのままにし、押せることは指の形で示す。 */
.badge-link { display: inline-flex; padding: 0; border: 0; border-radius: 5px; background: none; font: inherit; color: inherit; cursor: pointer; }
```

- [ ] **Step 4: SessionRows を ListItem で描く**

`packages/ui/src/views/SessionRows.tsx` を次のとおり直す。

(a) import（1〜7 行）に足す。

```ts
import type { Intent, StatusFilter } from '@agent-hangar/shared';
import type { ListItem, SectionId } from '../presenters/sections.ts';
```

(b) `export const SESSION_ROW_H = 56;`（13 行）の直後に足す。

```ts
/** 節の見出しの高さ。tokens.css の --section-head-h と同じ値にする（styles/rows.test.ts が突き合わせる）。 */
export const SECTION_HEAD_H = 32;

/** 見出しの件数の書き方。「1,221」のように桁を区切る。 */
const countLabel = (n: number) => n.toLocaleString('en-US');

/** 行だけを並べる（Home の最近、検索の結果）か、節の見出しを挟んで並べる（プロジェクト画面と Sessions の節）か。 */
type RowsSource = { rows: SessionRowProps[]; items?: never } | { items: ListItem[]; rows?: never };
```

(c) 一覧の説明（45〜54 行）の閉じの ` */` の前に 3 行足し、引数（55 行）を置き換える。下のコードの ` */` は、元の閉じをそのまま使う。

```ts
 * items を渡すと、行のあいだに節の見出しを挟む（P3 と ★）。見出しは行ではないので、カーソルとフォーカスは見出しを飛ばす。
 * moreIntent は見出しの右端のボタン（「ほか N 件 ▸」「この節だけ見る ▸」）の Intent で、null ならボタンを出さない。
 * badgeIntent を渡すと、行の状態の札がそのタブへ移るボタンになる（Sessions の ★）。
 */
export function SessionRows(props: RowsSource & { /** 一覧の高さ。省くと器（.screen-fill など）から受け取る。 */ height?: number | string; variant: RowVariant; emptyText?: string; autoFocus?: boolean; foot?: ReactNode; id?: string; loadingMore?: boolean; moreIntent?: (target: SectionId) => Intent | null; badgeIntent?: (status: StatusFilter) => Intent }) {
```

(d) 関数の中の `props.rows` を、すべて `rows` に置き換える（62〜63 行の `cursor`、88 行の `hasRows`、98 行の `rowsLen`、109 行の `next`、134〜136 行の `max`・`cur`・`moveTo`）。そのあとで、`const emit = useEmit();` の直後に足す。

```ts
  const items: ListItem[] = props.items ?? (props.rows ?? []).map((row) => ({ kind: 'row' as const, row }));
  // カーソルと打鍵は行だけを渡り歩き、見出しは飛ばす。
  const rows = items.flatMap((it) => (it.kind === 'row' ? [it.row] : []));
```

(e) 空の一覧（149 行）を、見出しも数えるように置き換える。

```ts
  if (items.length === 0) return <div className="list"><div className="empty">{props.emptyText ?? DEFAULT_EMPTY_TEXT}</div></div>;
```

(f) `side` の定義（177〜195 行）の直後に、札の包みと見出しを足す。

```tsx
  // 行の状態の札（Done・Archived の四角の札と、Paused の戻る日の札）。Sessions ではそのタブへ移るボタンにする（★ の E）。
  // 行が開かないよう、クリックは行へ渡さない。Enter はボタンのものなので、行の打鍵（onKeyDown）は横取りしない。
  const badge = (status: StatusFilter, label: string, node: ReactNode) => (props.badgeIntent ? (
    <button type="button" className="badge-link" aria-label={`${label} のセッションだけを見る`} onClick={(e) => { e.stopPropagation(); emit(props.badgeIntent!(status)); }}>{node}</button>
  ) : node);

  // 節の見出し。行ではないので、カーソルもフォーカスも止まらない。
  const head = (h: Extract<ListItem, { kind: 'head' }>) => {
    const intent = h.more && props.moreIntent ? props.moreIntent(h.more.target) : null;
    return (
      <div className="row-head" role="heading" aria-level={2} data-section={h.id}>
        <span>{h.label}</span><span className="row-head-count">{countLabel(h.count)}</span>
        {intent && <button type="button" className="row-head-more" onClick={() => emit(intent)}>{h.more!.label}</button>}
      </div>
    );
  };
```

(g) 第 1 段が足した状態の札（第 1 段の計画の Task 12）を `badge` で包む。要素の class 名と中身は第 1 段のまま変えない。

`side` の中の四角の札の行を、次に置き換える。

```tsx
        {(r.state === 'done' || r.state === 'archived') && badge(r.state, STATUS_LABEL[r.state], <span className="row-sq" data-s={r.state} title={r.setBy === 'conversation' ? CONVERSATION_NOTE : undefined}>{STATUS_LABEL[r.state]}</span>)}
```

`sub` の 2 段目の頭の、戻る日の札の分岐を次に置き換える。

```tsx
        {r.state === 'paused' && r.returnOn
          ? badge('paused', 'Paused', <span className="row-return" data-due={r.overdueDays !== null ? 'true' : undefined} title={r.setBy === 'conversation' ? CONVERSATION_NOTE : undefined}>{returnOnLabel(r.returnOn, r.overdueDays)}</span>)
          : r.summaryState && <span className="row-state" data-tone={r.summaryState.tone ?? undefined}>{r.summaryState.label}</span>}
```

(h) Tab で止まる行（197〜198 行）と描画（201〜215 行）を置き換える。行の JSX の中身（`StatusDot`、`row-main`、`side(r)`、第 1 段の札と「⋯」）はそのまま `rowEl` に移し、`tabIndex`・`data-cursor` の式と `data-archived` だけを変える。

```tsx
  // Tab で止まる行。まだ選んでいなければ先頭の行にする。見出しには止まらない。
  const tabStopId = (cursor >= 0 ? rows[cursor] : rows[0])?.id ?? null;
  const cursorRowId = cursor >= 0 ? rows[cursor]!.id : null;
  const rowEl = (r: SessionRowProps) => (
    <div className="row row-2" role="row" tabIndex={r.id === tabStopId ? 0 : -1} data-cursor={r.id === cursorRowId ? 'true' : undefined} data-archived={r.state === 'archived' ? 'true' : undefined} data-morph-id={r.id}
      onClick={() => emit(openIntent(r))} onFocus={() => setCursorId(r.id)}>
      <StatusDot status={r.live} />
      <span className="row-main">
        <span className="row-name">{r.name}{props.variant !== 'project' && <span className="row-proj">{r.projectName ?? '未分類'}</span>}</span>
        {sub(r)}
      </span>
      {side(r)}
    </div>
  );
  // 器は Tab の順には入れず（tabIndex=-1）、画面に入ったときのフォーカスの受け皿にだけ使う。
  // 行の打鍵はここへ上がってきて、カーソルの行について 1 度だけ処理する。
  return (
    <div className="rows-host" id={props.id} data-testid="session-rows" ref={hostRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <VirtualList items={items} rowHeight={(it) => (it.kind === 'head' ? SECTION_HEAD_H : SESSION_ROW_H)} height={props.height} keyOf={(it) => (it.kind === 'head' ? `head:${it.id}` : it.row.id)} foot={props.foot}
        render={(it) => (it.kind === 'head' ? head(it) : rowEl(it.row))} />
    </div>
  );
```

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui/src/views/SessionRows.sections.test.tsx packages/ui/src/views/SessionRows.test.tsx packages/ui/src/styles/rows.test.ts && npm run typecheck`
Expected: PASS（既存の `SessionRows.test.tsx` も含めて通る）

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/views/SessionRows.tsx packages/ui/src/views/SessionRows.sections.test.tsx packages/ui/src/styles/tokens.css packages/ui/src/styles/rows.css packages/ui/src/styles/rows.test.ts
git commit -m "feat(ui): draw section heads in session lists and skip them with the cursor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: プロジェクト画面を節で読む（P3）

**Files:**
- Modify: `packages/ui/src/mediator/types.ts:214`（State）
- Create: `packages/ui/src/mediator/sections.ts`
- Modify: `packages/ui/src/mediator/transition.ts:12`（import）、`:21`（initialState）、`:37`（領域の並び）
- Modify: `packages/ui/src/presenters/project.ts:1-12`、`:40-51`
- Modify: `packages/ui/src/views/ProjectScreen.tsx:35`
- Modify: `packages/ui/src/presenters/presenters.test.ts:350`、`:1086`、`packages/ui/src/views/screens.test.tsx:268-319`、`packages/ui/src/views/workbench.test.tsx:213`
- Test: `packages/ui/src/mediator/sections.test.ts`（新規）、`packages/ui/src/presenters/sections.test.ts`（足す）、`packages/ui/src/views/ProjectSections.test.tsx`（新規）

**Interfaces:**
- Consumes: `sectionRows`・`DONE_HEAD`・`ListItem`（Task 3）、`sortForSections`（Task 3）、Intent `project.section.toggle`（Task 1）、`SessionRows` の `items`・`moreIntent`（Task 4）
- Produces:
  - `State.sectionsOpen: Record<string, ('done' | 'archived')[]>`（鍵はプロジェクトの id）
  - `sectionsStep(state, input): Step | null`
  - `ProjectProps.items: ListItem[]`（`sessions: SessionRowProps[]` と入れ替える）

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/mediator/sections.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const intent = (i: Extract<Input, { kind: 'intent' }>['intent']): Input => ({ kind: 'intent', intent: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const toggle = (projectId: string, section: 'done' | 'archived') => intent({ type: 'project.section.toggle', projectId, section });

describe('プロジェクト画面の節を広げる（P3）', () => {
  it('はじめは何も広げていない', () => {
    expect(initialState().sectionsOpen).toEqual({});
  });
  it('Done と Archived をプロジェクトごとに広げ、もう一度押すと畳む。効果は出さない', () => {
    const a = run([toggle('p1', 'done')]);
    expect(a.state.sectionsOpen).toEqual({ p1: ['done'] });
    expect(a.effects).toEqual([]);
    const b = run([toggle('p1', 'archived'), toggle('p2', 'done')], a.state);
    expect(b.state.sectionsOpen).toEqual({ p1: ['done', 'archived'], p2: ['done'] });
    const c = run([toggle('p1', 'done'), toggle('p1', 'archived')], b.state);
    expect(c.state.sectionsOpen).toEqual({ p2: ['done'] });
  });
  it('画面を移っても、戻れば広げたまま', () => {
    const a = run([toggle('p1', 'done'), runtime({ type: 'hash.changed', route: { name: 'home' } }), runtime({ type: 'hash.changed', route: { name: 'project', id: 'p1' } })]);
    expect(a.state.sectionsOpen).toEqual({ p1: ['done'] });
  });
});
```

`packages/ui/src/presenters/sections.test.ts` の import に `import { initialStore, type Store } from '../store/store.ts';`、`import { initialState } from '../mediator/transition.ts';`、`import { presentProject } from './project.ts';`、`import type { ProjectDto } from '@agent-hangar/shared';` を足し、ファイルの末尾に足す。

```ts
describe('presentProject の節（P3）', () => {
  const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null, ...o });
  const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: NOW - H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, state: null, ...over });
  const alpha: ProjectDto = { id: 'alpha', name: 'alpha', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 };
  const storeOf = (list: SessionDto[]): Store => { const s = initialStore(); s.bootstrapped = true; s.projects = { alpha }; s.sessions = Object.fromEntries(list.map((x) => [x.id, x])); return s; };
  const imported = (id: string, daysAgo: number) => dto(id, { lastActivityAt: NOW - daysAgo * DAY, state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) });
  const proposedNfd = dto('nfd', { lastActivityAt: NOW - 5 * DAY, state: st({ candidate: { status: 'done', note: '直して push した', returnOn: null, source: 'post_hoc', at: NOW - H } }) });
  const list = [imported('cpu', 1), imported('resp', 2), imported('ux', 3), imported('old', 6), proposedNfd];

  // scenes.html の 5 番目の場面。畳んだ Done の中へ消えないこと。
  it('提案を確定した行は、最後に動いた時刻が古くても Done の節の先頭へ移る', () => {
    expect(shape(presentProject(initialState(), storeOf(list), NOW, 'alpha').items)).toEqual(['# continue 1', 'nfd', '# done 4 [ほか 1 件 ▸→done]', 'cpu', 'resp', 'ux']);
    // 確定の後に session.upsert が届いた形。
    const confirmed = { ...proposedNfd, state: st({ status: 'done', setBy: 'user', setAt: NOW }) };
    expect(shape(presentProject(initialState(), storeOf([...list.slice(0, 4), confirmed]), NOW, 'alpha').items)).toEqual(['# done 5 [ほか 2 件 ▸→done]', 'nfd', 'cpu', 'resp']);
  });
  it('広げた節は State の sectionsOpen をプロジェクトごとに読む', () => {
    const open = { ...initialState(), sectionsOpen: { alpha: ['done' as const] } };
    expect(shape(presentProject(open, storeOf(list), NOW, 'alpha').items)).toEqual(['# continue 1', 'nfd', '# done 4 [畳む ▴→done]', 'cpu', 'resp', 'ux', 'old']);
    const other = { ...initialState(), sectionsOpen: { beta: ['done' as const] } };
    expect(shape(presentProject(other, storeOf(list), NOW, 'alpha').items)).toHaveLength(6);
  });
  it('見つからないプロジェクトは空の一覧', () => {
    expect(presentProject(initialState(), storeOf(list), NOW, 'nope').items).toEqual([]);
  });
});
```

`packages/ui/src/views/ProjectSections.test.tsx` を作る。

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { ProjectProps } from '../presenters/project.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import { ProjectScreen } from './ProjectScreen.tsx';

const row = (id: string): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: 'done', returnOn: null, overdueDays: null, candidate: null, setBy: 'import' });
const props = (items: ProjectProps['items']): ProjectProps => ({ id: 'alpha', name: 'alpha', parent: { label: 'プロジェクト', route: { name: 'projects' } }, path: '/w/alpha', resolved: true, status: 'active', items, notFound: false, isScratch: false, todos: [], memo: null, artifacts: [] });

describe('ProjectScreen の節（P3）', () => {
  it('Done の「ほか N 件」と Archived の「表示」は、そのプロジェクトの節を広げる Intent を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectScreen {...props([
      { kind: 'head', id: 'done', label: 'Done', count: 4, more: { label: 'ほか 1 件 ▸', target: 'done' } }, { kind: 'row', row: row('a') },
      { kind: 'head', id: 'archived', label: 'Archived', count: 2, more: { label: '表示 ▸', target: 'archived' } },
    ])} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'ほか 1 件 ▸' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'project.section.toggle', projectId: 'alpha', section: 'done' });
    fireEvent.click(screen.getByRole('button', { name: '表示 ▸' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'project.section.toggle', projectId: 'alpha', section: 'archived' });
  });
  it('一覧が空なら決まりの文を出す', () => {
    render(<IntentRoot onIntent={vi.fn()}><ProjectScreen {...props([])} /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/mediator/sections.test.ts packages/ui/src/presenters/sections.test.ts packages/ui/src/views/ProjectSections.test.tsx`
Expected: FAIL（`sectionsOpen` が undefined、`items` が undefined）

- [ ] **Step 3: State と Mediator の領域を足す**

`packages/ui/src/mediator/types.ts` の `sidebarCollapsed: boolean;`（214 行）の直後に足す。

```ts
  /**
   * プロジェクト画面で広げた節（Done の「ほか N 件」と、末尾の Archived）。鍵はプロジェクトの id。
   * Presenter が読む（presenters/project.ts）ので View ではなくここに持つ。保存はしない。
   */
  sectionsOpen: Record<string, ('done' | 'archived')[]>;
```

`packages/ui/src/mediator/sections.ts` を作る。

```ts
import type { Input, State, Step } from './types.ts';

/**
 * プロジェクト画面の節を広げる・畳む（P3）。Done の「ほか N 件」と、末尾の Archived の行。
 * プロジェクトごとに覚え、画面を移っても戻れば広げたままにする。
 * 再起動すれば畳んだ形に戻る。Home の確かめるの「ほか N 件」と同じく見え方だけのもので、残す値ではないためである。
 */
export function sectionsStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent' || input.intent.type !== 'project.section.toggle') return null;
  const { projectId, section } = input.intent;
  const open = state.sectionsOpen[projectId] ?? [];
  const next = open.includes(section) ? open.filter((s) => s !== section) : [...open, section];
  const sectionsOpen = { ...state.sectionsOpen };
  if (next.length > 0) sectionsOpen[projectId] = next;
  else delete sectionsOpen[projectId];
  return { state: { ...state, sectionsOpen }, effects: [] };
}
```

`packages/ui/src/mediator/transition.ts` を直す。

- 12 行の後ろに `import { sectionsStep } from './sections.ts';` を足す。
- 21 行の `initialState` の `sidebarCollapsed: false,` の後ろに `sectionsOpen: {},` を足す。
- 37 行の領域の並びの `sidebarStep, ` の後ろに `sectionsStep, ` を足す。

- [ ] **Step 4: Presenter と View を節にする**

`packages/ui/src/presenters/project.ts` を直す。

- 6 行の import を `import { presentSessionRow, sortForSections } from './row.ts';` にし、その下に `import { DONE_HEAD, sectionRows, type ListItem } from './sections.ts';` を足す。
- 12 行の `ProjectProps` の `sessions: SessionRowProps[];` を `items: ListItem[];` に置き換え、型の直前に説明を足す。

```ts
/** items はセッションの一覧で、節の見出しと行の並び（P3）。 */
```

- 40〜51 行の `presentProject` を次に置き換える。

```ts
export function presentProject(state: State, store: Store, now: number, id: string): ProjectProps {
  const p = store.projects[id];
  if (!p) return { id, name: id, parent: PARENT, path: null, resolved: false, status: 'active', items: [], notFound: true, isScratch: false, todos: [], memo: null, artifacts: [] };
  // 節で読む（P3）。広げた節はプロジェクトごとに Mediator が覚えている（mediator/sections.ts）。
  const rows = sortForSections(Object.values(store.sessions).filter((s) => s.projectId === id)).map((s) => presentSessionRow(s, store, now));
  const items = sectionRows(rows, 'project', { now, doneHead: DONE_HEAD, expanded: new Set(state.sectionsOpen[id] ?? []) });
  const memo = store.memos[id];
  return {
    id, name: p.name, parent: PARENT, path: p.path, resolved: p.resolved, status: p.status, items, notFound: false, isScratch: p.isScratch,
    todos: todosOf(store, id).map((t) => ({ id: t.id, text: t.text, done: t.done, candidate: presentTodoCandidate(t, store, now) })),
    memo: memo ? { markdown: memo.markdown, updatedAt: memo.updatedAt } : null,
    artifacts: artifactsOf(store, { projectId: id }).map((a) => presentArtifactCard(a, now)),
  };
}
```

`packages/ui/src/views/ProjectScreen.tsx` の 35 行を置き換える。

```tsx
        {/* 見出しの「ほか N 件」と Archived の「表示」は、このプロジェクトの節をその場で広げる。 */}
        <SessionRows items={props.items} variant="project" moreIntent={(target) => (target === 'done' || target === 'archived' ? { type: 'project.section.toggle', projectId: props.id, section: target } : null)} />
```

- [ ] **Step 5: 既存の試験を新しい形に合わせる**

- `packages/ui/src/presenters/presenters.test.ts` の 350 行を置き換える。

```ts
    expect(p.items.flatMap((i) => (i.kind === 'row' ? [i.row.id] : []))).toEqual(['s1', 's4', 's2']);
```

- 同じファイルの 1086 行を置き換える。

```ts
    expect(presentProject(initialState(), store, NOW, 'alpha').items.find((i) => i.kind === 'row')).toMatchObject({ row: { id: 's1', cost: '$3.00', runId: 'r1' } });
```

- `packages/ui/src/views/screens.test.tsx` の `sessions={[]}`（268、270、272、279、291、307、319 行の 7 か所）を、すべて `items={[]}` に置き換える。
- `packages/ui/src/views/workbench.test.tsx` の 213 行の `sessions: [],` を `items: [],` に置き換える。

置き換えの漏れが無いことを確かめる。

Run: `grep -nE "sessions=\{\[\]\}|sessions: \[\], notFound" packages/ui/src/views/*.test.tsx`
Expected: 何も出ない

- [ ] **Step 6: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/mediator/types.ts packages/ui/src/mediator/sections.ts packages/ui/src/mediator/sections.test.ts packages/ui/src/mediator/transition.ts packages/ui/src/presenters/project.ts packages/ui/src/presenters/sections.test.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/ProjectScreen.tsx packages/ui/src/views/ProjectSections.test.tsx packages/ui/src/views/screens.test.tsx packages/ui/src/views/workbench.test.tsx
git commit -m "feat(ui): read the project screen in sections and remember opened ones per project

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Sessions 画面の Presenter と検索の条件（タブ・節・トークン）

**Files:**
- Modify: `packages/ui/src/mediator/screen.ts:1`（import）、`:6-13`（`hasConditions` を足す）、`:33-42`（`searchParams`）、`:85-89`（`searchQueryStep`）、`:177`
- Modify: `packages/ui/src/presenters/sessions.ts:1-71`（全体）
- Modify: `packages/ui/src/mediator/transition.test.ts:79-129`（`hideArchived` を足す 7 か所）、`packages/ui/src/views/misc.test.tsx:13`、SessionsScreen の 19 か所
- Test: `packages/ui/src/mediator/search.test.ts`（新規）、`packages/ui/src/presenters/sessionsTabs.test.ts`（新規）

**Interfaces:**
- Consumes: `queryTokens`・`badTokens`・`QueryToken`・`StatusFilter`（Task 1）、`sortForSections`・`sectionRows`・`matchesStatus`・`DONE_HEAD`・`ListItem`（Task 3）
- Produces:
  - `hasConditions(search: State['search']): boolean`（`mediator/screen.ts`）
  - `searchParams(state)` が `status` か `hideArchived: true` を載せる
  - `searchQueryStep(state, text, filter?)`。`search.query` の `filter` があれば絞り込みをまるごと入れ替える
  - `type StatusTab = 'all' | StatusFilter`、`type StatusTabProps = { tab: StatusTab; label: string; count: string; hot: boolean }`
  - `SessionsProps` に `tabs: StatusTabProps[]; tab: StatusTab; sections: ListItem[] | null; tokens: QueryToken[]; hints: string[]` を足す（`rows` は条件に合う行の平らな並びのまま残す）

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/mediator/search.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';
import { hasConditions } from './screen.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const intent = (i: Extract<Input, { kind: 'intent' }>['intent']): Input => ({ kind: 'intent', intent: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });

describe('状態のタブと欄の条件（★）', () => {
  it('欄の Enter は、読んだ条件をまるごと渡して今の絞り込みと入れ替える', () => {
    const a = run([intent({ type: 'search.filter', patch: { projectId: 'p1', status: 'paused' } }), intent({ type: 'search.query', text: '動画', filter: { status: 'done', days: 7 } })]);
    expect(a.state.search).toEqual({ text: '動画', filter: { status: 'done', days: 7 } });
  });
  it('filter の無い search.query（パレットの全文検索）は今の絞り込みを保つ', () => {
    const a = run([intent({ type: 'search.filter', patch: { status: 'paused' } }), intent({ type: 'search.query', text: '動画' })]);
    expect(a.state.search).toEqual({ text: '動画', filter: { status: 'paused' } });
  });
  it('サーバへは状態を status で渡し、状態が無いときは Archived を除く印を付ける', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'sessions', q: '動画' } })]);
    expect(a.effects).toEqual([{ kind: 'api.search', params: { q: '動画', hideArchived: true } }]);
    const b = run([intent({ type: 'search.filter', patch: { status: 'archived' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画', status: 'archived' } }]);
  });
  it('状態のタブだけなら手元で絞り、問い合わせない', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'sessions' } }), intent({ type: 'search.filter', patch: { status: 'paused' } })]);
    expect(a.effects).toEqual([]);
  });
  it('条件が 1 つでも効いているかを hasConditions が言う', () => {
    expect(hasConditions({ text: '', filter: {} })).toBe(false);
    expect(hasConditions({ text: '', filter: { status: undefined, projectId: undefined } })).toBe(false);
    expect(hasConditions({ text: '', filter: { status: 'done' } })).toBe(true);
    expect(hasConditions({ text: '', filter: { live: 'waiting' } })).toBe(true);
    expect(hasConditions({ text: 'x', filter: {} })).toBe(true);
  });
});
```

`packages/ui/src/presenters/sessionsTabs.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import type { ProjectDto, SearchFilter, SessionDto, SessionStateDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import type { ListItem } from './sections.ts';
import { presentSessions } from './sessions.ts';

const NOW = new Date(2026, 9, 2, 9, 0).getTime();
const H = 3_600_000;
const IMPORT_AT = new Date(2026, 9, 1, 8, 0).getTime();
const project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null, ...o });
const cand = (status: 'paused' | 'done', at: number) => ({ status, note: '直した', returnOn: status === 'paused' ? '2026-10-03' : null, source: 'in_session' as const, at });
const dto = (id: string, hoursAgo: number, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - (hoursAgo + 1) * H, lastActivityAt: NOW - hoursAgo * H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, state: null, ...over });
function storeOf(list: SessionDto[]): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: project('alpha'), beta: project('beta') };
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  return s;
}
/** sessions-filter.html の ★ と同じ顔ぶれに、プロジェクトの無いセッションを 1 つ足したもの。 */
const scene = () => storeOf([
  dto('newui', 0.05, { live: 'waiting' }),
  dto('status', 0, { live: 'busy' }),
  dto('nfd', 2, { state: st({ candidate: cand('done', NOW - 2 * H) }) }),
  dto('video', 5, { projectId: 'beta', state: st({ candidate: cand('paused', NOW - 5 * H) }) }),
  dto('backspace', 8),
  dto('orphan', 10, { projectId: null }),
  dto('resp', 12, { state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }),
  dto('sync', 24, { state: st({ status: 'paused', note: 'CPU の数字を見る', returnOn: '2026-10-02', setBy: 'user', setAt: NOW - 24 * H }) }),
  dto('trash', 30, { state: st({ status: 'archived', setBy: 'user', setAt: NOW - 30 * H }) }),
  dto('parkour', 48, { projectId: 'beta', state: st({ status: 'paused', returnOn: '2026-10-09', setBy: 'user', setAt: NOW - 48 * H }) }),
  dto('subs', 216, { state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }),
]);
const shape = (items: ListItem[] | null) => items?.map((i) => (i.kind === 'head' ? `# ${i.id} ${i.count}` : i.row.id)) ?? null;
const withSearch = (search: State['search']): State => ({ ...initialState(), screen: { name: 'sessions' }, search });
const ids = (filter: SearchFilter, store = scene()) => presentSessions(withSearch({ text: '', filter }), store, NOW).rows.map((r) => r.id);

describe('presentSessions のタブと節（★）', () => {
  it('条件が無ければ節で読み、プロジェクトの無いセッションも印なしに並ぶ', () => {
    const p = presentSessions(initialState(), scene(), NOW);
    expect(shape(p.sections)).toEqual(['# returning 1', 'sync', '# proposed 2', 'nfd', 'video', '# live 2', 'newui', 'status', '# paused 1', 'parkour', '# none 2', 'backspace', 'orphan', '# done 2', 'resp', 'subs', '# archived 1']);
    expect(p.tab).toBe('all');
    expect(p.rows.find((r) => r.id === 'orphan')!.projectName).toBeNull();
  });
  it('タブの件数は条件に関わらず手元の全件を行の持ち物で数え、確かめるが 1 件以上なら灯す', () => {
    const p = presentSessions(withSearch({ text: '', filter: { projectId: 'beta' } }), scene(), NOW);
    expect(p.tabs.map((t) => [t.tab, t.label, t.count, t.hot])).toEqual([
      ['all', 'すべて', '10', false], ['proposed', '確かめる', '2', true], ['paused', 'Paused', '2', false], ['active', 'Active', '2', false],
      ['none', '印なし', '4', false], ['done', 'Done', '2', false], ['archived', 'Archived', '1', false],
    ]);
    expect(presentSessions(initialState(), storeOf([dto('x', 1)]), NOW).tabs.find((t) => t.tab === 'proposed')!.hot).toBe(false);
  });
  it('タブを選ぶと節を消し、その状態の行だけを平らに並べ、条件の行にタブの名前を出す', () => {
    const p = presentSessions(withSearch({ text: '', filter: { status: 'paused' } }), scene(), NOW);
    expect(p.sections).toBeNull();
    expect(p.tab).toBe('paused');
    expect(p.rows.map((r) => r.id)).toEqual(['sync', 'parkour']);
    expect(p.conditions).toEqual(['Paused']);
    expect(ids({ status: 'active' })).toEqual(['newui', 'status']);
    expect(ids({ status: 'proposed' })).toEqual(['nfd', 'video']);
  });
  it('「すべて」のまま条件を入れたら Archived を除き、Archived のタブなら出す', () => {
    expect(ids({ days: 7 })).not.toContain('trash');
    expect(ids({ days: 7 })).toContain('sync');
    expect(ids({ status: 'archived' })).toEqual(['trash']);
  });
  it('プロジェクトで絞ると、プロジェクトの無いセッションは当たらない', () => {
    expect(ids({ projectId: 'alpha' })).not.toContain('orphan');
    expect(ids({ projectId: 'alpha' })).not.toContain('video');
  });
  it('効いている条件を欄のチップにし、読めなかったトークンを知らせる', () => {
    const store = { ...scene(), search: { params: { q: 'is:pasued' }, result: { hits: [], total: 0 }, loading: false } };
    const p = presentSessions(withSearch({ text: 'is:pasued', filter: { status: 'done', projectId: 'alpha', days: 7 } }), store, NOW);
    expect(p.tokens).toEqual([{ key: 'status', token: 'is:done' }, { key: 'days', token: 'since:7d' }, { key: 'projectId', token: 'project:alpha' }]);
    expect(p.hints).toEqual(['「is:pasued」は条件として読めないので、語として本文を探しています。is: の後は paused・done・archived・active・none・proposed・running・waiting のどれかです。']);
    expect(p.sections).toBeNull();
  });
  it('件数は桁を区切り、Done は直近 3 件だけを節に出す', () => {
    const many = Array.from({ length: 1221 }, (_, i) => dto(`d${i}`, 30 + i, { state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }));
    const p = presentSessions(initialState(), storeOf(many), NOW);
    expect(p.tabs.find((t) => t.tab === 'done')!.count).toBe('1,221');
    expect(shape(p.sections)).toEqual(['# done 1221', 'd0', 'd1', 'd2']);
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/mediator/search.test.ts packages/ui/src/presenters/sessionsTabs.test.ts`
Expected: FAIL（`hasConditions` が無い、`tabs` が undefined など）

- [ ] **Step 3: Mediator の検索の条件を直す**

`packages/ui/src/mediator/screen.ts` を直す。

- 1 行の import を `import { formatRoute, type SearchFilter, type SearchParamsDto } from '@agent-hangar/shared';` にする。
- `usesServerSearch`（11〜13 行）の直後に足す。

```ts
/**
 * 条件が 1 つでも効いているか。キーワード、状態のタブ、プロジェクト、期間、動き、触ったファイルのどれか。
 * 無ければ Sessions は節で読み、あれば平らな結果にする（★）。
 */
export function hasConditions(search: State['search']): boolean {
  return search.text !== '' || Object.values(search.filter).some((v) => v !== undefined);
}
```

- `searchParams`（33〜42 行）の `if (f.file) p.file = f.file;` の後ろに足す。

```ts
  // 状態のタブ。「すべて」のまま条件を入れたときは Archived を除く（presenters/sessions.ts の手元の絞り込みと同じ）。
  // サーバに問い合わせるのはキーワードか触ったファイルがあるとき（usesServerSearch）なので、ここに来るときはいつも条件がある。
  if (f.status) p.status = f.status;
  else p.hideArchived = true;
```

- `searchQueryStep`（85〜89 行）を次に置き換え、説明の末尾に 1 行足す。

```ts
 * filter があれば（Sessions の欄の Enter）、欄を読んだ条件で絞り込みをまるごと入れ替える。欄が正だからである。
 */
export function searchQueryStep(state: State, text: string, filter?: SearchFilter): Step {
  if (!canMoveBehind(state)) return { state, effects: [] };
  const next = { ...state, overlay: closeTransient(state), search: { text, filter: filter ?? state.search.filter } };
  return { state: next, effects: [{ kind: 'navigate', route: text ? { name: 'sessions', q: text } : { name: 'sessions' } }, { kind: 'focus', target: 'results' }] };
}
```

- 177 行を `case 'search.query': return searchQueryStep(state, i.text, i.filter);` にする。

- [ ] **Step 4: Sessions の Presenter を書き直す**

`packages/ui/src/presenters/sessions.ts` の全体を次に置き換える。

```ts
import { badTokens, queryTokens, type LiveFilter, type QueryToken, type SearchFilter, type StatusFilter } from '@agent-hangar/shared';
import { hasConditions, periodStart, usesServerSearch } from '../mediator/screen.ts';
import type { State } from '../mediator/types.ts';
import { liveFilterOfSession, runningSessionIds, type Store } from '../store/store.ts';
import { absoluteTime } from './format.ts';
import { markTerms } from './highlight.ts';
import { presentSessionRow, sortForSections, type SessionRowProps } from './row.ts';
import { DONE_HEAD, matchesStatus, sectionRows, type ListItem } from './sections.ts';

/** 状態のタブ。all は「すべて」。 */
export type StatusTab = 'all' | StatusFilter;
/** 状態のタブ 1 つ。count は桁を区切った件数、hot は数字を候補の色で灯すか（確かめるが 1 件以上のとき）。 */
export type StatusTabProps = { tab: StatusTab; label: string; count: string; hot: boolean };

/**
 * total は条件に合う全件の数、shown はそのうち読み込んだ件数である。
 * サーバは上位の結果だけを返すので、検索では shown が total より小さいことがある。
 * loading は新しい問い合わせの最中、loadingMore は続きを読み足している最中を表す。
 * rows は条件に合う行の平らな並びで、sections は条件が無いときの節の並び（★）。sections が null なら rows を描く。
 * tabs は件数つきの状態のタブ、tab は選んでいるタブ、tokens は欄の中のチップ、hints は読めなかったトークンの知らせである。
 */
export type SessionsProps = { text: string; filter: SearchFilter; projects: { id: string; name: string }[]; rows: SessionRowProps[]; shown: number; total: number; loading: boolean; loadingMore: boolean; mode: 'all' | 'search'; allCount: number; conditions: string[]; tabs: StatusTabProps[]; tab: StatusTab; sections: ListItem[] | null; tokens: QueryToken[]; hints: string[] };

/** 期間の語。絞り込みの帯と同じ語を使う。 */
const PERIOD_LABEL: Record<number, string> = { 1: '今日', 7: '7 日', 30: '30 日' };
/** 動きの語。is:running と is:waiting で届く。 */
const LIVE_LABEL: Record<LiveFilter, string> = { waiting: '入力待ち', running: '実行中', ended: '終了' };
/** タブの並びと名前（★）。語はプロジェクトの状態と同じ英語にし、提案と印なしだけを日本語にする。 */
const TABS: [StatusTab, string][] = [['all', 'すべて'], ['proposed', '確かめる'], ['paused', 'Paused'], ['active', 'Active'], ['none', '印なし'], ['done', 'Done'], ['archived', 'Archived']];
const STATUS_LABEL = Object.fromEntries(TABS) as Record<StatusTab, string>;

/**
 * いま効いている条件を、条件の行に並べる語にする（D1）。
 * 語、状態、プロジェクト、期間、動き、触ったファイルの順で、欄のチップの並びに合わせる。
 */
function conditionsOf(text: string, f: SearchFilter, store: Store): string[] {
  const out: string[] = [];
  if (text) out.push(`『${text}』`);
  if (f.status) out.push(STATUS_LABEL[f.status]);
  if (f.projectId) out.push(store.projects[f.projectId]?.name ?? '見つからないプロジェクト');
  if (f.days) out.push(PERIOD_LABEL[f.days] ?? `${f.days} 日`);
  if (f.until !== undefined) out.push(`${absoluteTime(f.until).slice(0, 10)} より前`);
  if (f.live) out.push(LIVE_LABEL[f.live]);
  if (f.file) out.push(f.file);
  return out;
}

/**
 * 状態のタブ。件数は条件に関わらず手元の全件で、行の持ち物で数える（presenters/sections.ts の matchesStatus）。
 * 節とは数え方が違い、動いている Done は Active にも Done にも入る。
 * 「すべて」は Archived を除いた数で、条件を入れたときに並ぶ行の数え方と同じにする。
 */
function presentTabs(rows: SessionRowProps[]): StatusTabProps[] {
  return TABS.map(([tab, label]) => {
    const n = tab === 'all' ? rows.filter((r) => r.state !== 'archived').length : rows.filter((r) => matchesStatus(r, tab)).length;
    return { tab, label, count: n.toLocaleString('en-US'), hot: tab === 'proposed' && n > 0 };
  });
}

/** 読めなかったトークンの知らせ。何が読めなかったかと、語として本文を探していることと、書き方を言う。 */
function hintOf(token: string): string {
  const key = token.slice(0, token.indexOf(':')).toLowerCase();
  const how = key === 'is' ? 'is: の後は paused・done・archived・active・none・proposed・running・waiting のどれかです'
    : key === 'since' ? 'since: の後は 7d のように日数と d を書きます'
      : key === 'project' ? 'その名前で始まるプロジェクトがありません'
        : 'file: の後にパスがありません';
  return `「${token}」は条件として読めないので、語として本文を探しています。${how}。`;
}

export function presentSessions(state: State, store: Store, now: number): SessionsProps {
  const projects = Object.values(store.projects).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  const f = state.search.filter;
  // 見出しの件数は条件に関わらず全件で、絞った結果の件数は条件の行が言う。
  const allCount = Object.keys(store.sessions).length;
  const conditions = conditionsOf(state.search.text, f, store);
  // 節の元の並び（presenters/row.ts の sortForSections）。タブの件数もこの全件から数える。
  const all = sortForSections(Object.values(store.sessions)).map((s) => ({ s, row: presentSessionRow(s, store, now) }));
  const common: Pick<SessionsProps, 'tabs' | 'tab' | 'tokens' | 'hints'> = { tabs: presentTabs(all.map((x) => x.row)), tab: f.status ?? 'all', tokens: queryTokens(f, projects), hints: badTokens(state.search.text, projects).map(hintOf) };
  if (!usesServerSearch(state.search)) {
    let list = all;
    if (f.projectId) list = list.filter(({ s }) => s.projectId === f.projectId);
    if (f.live !== undefined) { const alive = runningSessionIds(store); list = list.filter(({ s }) => liveFilterOfSession(store, s, alive) === f.live); }
    const { days, until } = f;
    if (days) { const since = periodStart(days, now); list = list.filter(({ s }) => (s.lastActivityAt ?? 0) >= since); }
    if (until !== undefined) list = list.filter(({ s }) => (s.lastActivityAt ?? 0) < until);
    let rows = list.map((x) => x.row);
    const filtered = hasConditions(state.search);
    // タブを選べばその状態だけに、「すべて」のまま条件を入れたら Archived を除く（サーバの hideArchived と同じ）。
    const status = f.status;
    if (status) rows = rows.filter((r) => matchesStatus(r, status));
    else if (filtered) rows = rows.filter((r) => r.state !== 'archived');
    // 条件が無いときは節で読む。条件かタブがあれば平らな結果にする。
    const sections = filtered ? null : sectionRows(rows, 'sessions', { now, doneHead: DONE_HEAD, expanded: new Set() });
    return { text: '', filter: f, projects, rows, shown: rows.length, total: rows.length, loading: false, loadingMore: false, mode: 'all', allCount, conditions, sections, ...common };
  }
  const result = store.search.result;
  const rows: SessionRowProps[] = [];
  // 行は 2 段なので、抜粋は最初の 1 つだけを 2 段目に出す。
  // キーワードが無い（触ったファイルだけで絞った）ときは抜粋が無いので、2 段目は要約の 1 文になる。
  for (const h of result?.hits ?? []) {
    const s = store.sessions[h.sessionId];
    if (!s) continue;
    const first = h.snippets[0];
    const row = presentSessionRow(s, store, now, state.search.text ? (first ? markTerms(first.text, state.search.text) : []) : undefined);
    // 開いたら、抜粋の一致へ跳ぶ（J1）。
    // 跳び先は主線の抜粋だけから取る。seq は主線とサブエージェントで別々に振るので、サブエージェントの seq では主線の違う行に着く。
    // 主線の抜粋が無ければ跳ばずに開く。
    const main = h.snippets.find((x) => x.agentId === null);
    if (state.search.text && main) row.jump = { seq: main.seq, q: state.search.text };
    rows.push(row);
  }
  // 件数は手元に無い行も含めて数える。続きの offset はサーバの並びでの位置だからである。
  const more = (store.search.params?.offset ?? 0) > 0;
  return { text: state.search.text, filter: f, projects, rows, shown: result?.hits.length ?? 0, total: result?.total ?? 0, loading: store.search.loading && !more, loadingMore: store.search.loading && more, mode: 'search', allCount, conditions, sections: null, ...common };
}
```

- [ ] **Step 5: 既存の試験を新しい形に合わせる**

`packages/ui/src/mediator/transition.test.ts` の検索効果の期待に `hideArchived: true` を足す（状態のタブを選んでいないので、サーバには Archived を除く印が付く）。

| 行 | 置き換える前 | 置き換えた後 |
|---|---|---|
| 79 | `params: { q: '動画' } }]` | `params: { q: '動画', hideArchived: true } }]` |
| 82 | `params: { q: '動画', projectId: 'p1' } }]` | `params: { q: '動画', projectId: 'p1', hideArchived: true } }]` |
| 90 | `params: { q: '動画', days: 7 } }]` | `params: { q: '動画', days: 7, hideArchived: true } }]` |
| 103 | `params: { q: '動画', projectId: 'p1', offset: 50 } }]` | `params: { q: '動画', projectId: 'p1', hideArchived: true, offset: 50 } }]` |
| 119 | `params: { q: '動画', live: 'waiting' } })` | `params: { q: '動画', live: 'waiting', hideArchived: true } })` |
| 126 | `params: { q: '', file: 'a.md' } }]` | `params: { q: '', file: 'a.md', hideArchived: true } }]` |
| 129 | `params: { q: '', file: 'a.md' } }]` | `params: { q: '', file: 'a.md', hideArchived: true } }]` |

`packages/ui/src/views/misc.test.tsx` の 13 行（`const row = ...`）の直後に足す。

```ts
// SessionsProps に増えた分。この節が見るのはタブとチップ以外なので、空にして平らな一覧を描かせる。
const extra = { tabs: [], tab: 'all' as const, sections: null, tokens: [], hints: [] };
```

同じファイルの `<SessionsScreen ... conditions={...} />` の 19 か所の末尾に `{...extra}` を足す。

```bash
sed -i '' -E 's#(<SessionsScreen [^>]*conditions=\{[^}]*\}) />#\1 {...extra} />#' packages/ui/src/views/misc.test.tsx
grep -c '{...extra} />' packages/ui/src/views/misc.test.tsx
```

Expected: `19`

- [ ] **Step 6: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/mediator/screen.ts packages/ui/src/mediator/search.test.ts packages/ui/src/mediator/transition.test.ts packages/ui/src/presenters/sessions.ts packages/ui/src/presenters/sessionsTabs.test.ts packages/ui/src/views/misc.test.tsx
git commit -m "feat(ui): present status tabs, sections and query tokens for the sessions screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Sessions 画面の View（タブ・欄のチップ・節）

**Files:**
- Modify: `packages/ui/src/views/SessionsScreen.tsx:1-74`（全体）
- Modify: `packages/ui/src/styles/rows.css:96-104`（欄とタブ）
- Modify: `packages/ui/src/views/misc.test.tsx:16-37`、`packages/ui/src/styles/responsive.test.ts:39-41`
- Test: `packages/ui/src/views/SessionsScreen.test.tsx`（新規）

**Interfaces:**
- Consumes: `SessionsProps`・`StatusTab`・`StatusTabProps`（Task 6）、`parseQuery`（Task 1）、`SECTION_TAB`・`SectionId`（Task 3）、`SessionRows` の `items`・`moreIntent`・`badgeIntent`（Task 4）
- Produces: Sessions 画面が出す Intent
  - タブ：`{ type: 'search.filter', patch: { status } }`（「すべて」は `status: undefined`）
  - 欄の Enter：`{ type: 'search.query', text, filter }`（`filter` は今の絞り込みに読んだトークンを重ねたもの）
  - チップの × と空の欄の Backspace：`{ type: 'search.filter', patch: { [key]: undefined } }`
  - 見出しの「この節だけ見る ▸」「ほか N 件 ▸」「表示 ▸」と行の状態の札：`{ type: 'search.filter', patch: { status } }`

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/views/SessionsScreen.test.tsx` を作る。

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import type { SessionsProps, StatusTab, StatusTabProps } from '../presenters/sessions.ts';
import { SessionsScreen } from './SessionsScreen.tsx';

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, overdueDays: null, candidate: null, setBy: null, ...over });
const TABS: StatusTabProps[] = ([['all', 'すべて', '1,236'], ['proposed', '確かめる', '3'], ['paused', 'Paused', '4'], ['active', 'Active', '2'], ['none', '印なし', '3'], ['done', 'Done', '1,221'], ['archived', 'Archived', '5']] as [StatusTab, string, string][]).map(([tab, label, count]) => ({ tab, label, count, hot: tab === 'proposed' }));
const props = (over: Partial<SessionsProps> = {}): SessionsProps => ({ text: '', filter: {}, projects: [{ id: 'p1', name: 'agent-hangar' }, { id: 'p4', name: 'my app' }], rows: [], shown: 0, total: 0, loading: false, loadingMore: false, mode: 'all', allCount: 1241, conditions: [], tabs: TABS, tab: 'all', sections: null, tokens: [], hints: [], ...over });
const mount = (over: Partial<SessionsProps> = {}, onIntent = vi.fn()) => ({ ...render(<IntentRoot onIntent={onIntent}><SessionsScreen {...props(over)} /></IntentRoot>), onIntent });
const tabs = () => within(screen.getByRole('group', { name: '状態' }));

describe('SessionsScreen の状態のタブ（★）', () => {
  it('件数つきのタブを並べ、確かめるの数字だけを灯し、選んでいるタブに印を付ける', () => {
    mount({ tab: 'paused' });
    expect(tabs().getAllByRole('button').map((b) => b.textContent)).toEqual(['すべて1,236', '確かめる3', 'Paused4', 'Active2', '印なし3', 'Done1,221', 'Archived5']);
    expect(tabs().getByRole('button', { name: /^確かめる/ }).querySelector('[data-hot="true"]')).not.toBeNull();
    expect(tabs().getByRole('button', { name: /^Done/ }).querySelector('[data-hot="true"]')).toBeNull();
    expect(tabs().getByRole('button', { name: /^Paused/ })).toHaveAttribute('aria-pressed', 'true');
  });
  it('タブを押すと状態で絞り、「すべて」は外し、いまのタブは何も出さない', () => {
    const { onIntent } = mount({ tab: 'paused' });
    fireEvent.click(tabs().getByRole('button', { name: /^Done/ }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    fireEvent.click(tabs().getByRole('button', { name: /^すべて/ }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: undefined } });
    onIntent.mockClear();
    fireEvent.click(tabs().getByRole('button', { name: /^Paused/ }));
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('動きの切替（状態の Segmented）は外した', () => {
    mount();
    expect(screen.queryByRole('radiogroup', { name: '状態' })).toBeNull();
  });
});

describe('SessionsScreen の欄（欄が正）', () => {
  it('Enter で欄のトークンを読み、今の条件に重ねて search.query を出し、読めた分は欄から消す', () => {
    const { onIntent } = mount({ filter: { projectId: 'p1' } });
    const kw = screen.getByLabelText('キーワード') as HTMLInputElement;
    fireEvent.change(kw, { target: { value: 'is:paused 動画 project:"my app"' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.query', text: '動画', filter: { projectId: 'p4', status: 'paused' } });
    expect(kw.value).toBe('動画');
  });
  it('効いている条件を欄の中のチップにし、× と、空の欄の Backspace で外す', () => {
    const { onIntent } = mount({ tokens: [{ key: 'status', token: 'is:paused' }, { key: 'days', token: 'since:7d' }] });
    const box = document.querySelector('.sessions-keyword') as HTMLElement;
    expect(within(box).getByText('is:paused')).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('button', { name: 'is:paused を外す' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: undefined } });
    const kw = screen.getByLabelText('キーワード');
    fireEvent.keyDown(kw, { key: 'Backspace' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { days: undefined } });
    onIntent.mockClear();
    fireEvent.change(kw, { target: { value: 'x' } });
    fireEvent.keyDown(kw, { key: 'Backspace' });
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('読めなかったトークンは、欄の下で語として探していることを知らせる', () => {
    mount({ text: 'is:pasued', hints: ['「is:pasued」は条件として読めないので、語として本文を探しています。'] });
    expect(screen.getByRole('note')).toHaveTextContent('「is:pasued」は条件として読めないので、語として本文を探しています。');
  });
  it('帯に無い期間（since:14d）では、期間の帯のどれにも印を付けない', () => {
    mount({ filter: { days: 14 }, tokens: [{ key: 'days', token: 'since:14d' }] });
    expect(within(screen.getByRole('radiogroup', { name: '期間' })).queryAllByRole('radio', { checked: true })).toHaveLength(0);
  });
});

describe('SessionsScreen の節', () => {
  it('条件が無いときは節を描き、見出しのボタンと行の札はそのタブを選ぶ', () => {
    const { onIntent } = mount({ sections: [
      { kind: 'head', id: 'returning', label: '今日戻る', count: 1 }, { kind: 'row', row: row('r') },
      { kind: 'head', id: 'proposed', label: '確かめる', count: 1, more: { label: 'この節だけ見る ▸', target: 'proposed' } }, { kind: 'row', row: row('c') },
      { kind: 'head', id: 'live', label: 'いま動いている', count: 1, more: { label: 'この節だけ見る ▸', target: 'live' } }, { kind: 'row', row: row('l', { live: 'busy' }) },
      { kind: 'head', id: 'done', label: 'Done', count: 1221, more: { label: 'ほか 1218 件 ▸', target: 'done' } }, { kind: 'row', row: row('d', { state: 'done' }) },
    ] });
    const buttons = screen.getAllByRole('button', { name: 'この節だけ見る ▸' });
    fireEvent.click(buttons[0]!);
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'proposed' } });
    fireEvent.click(buttons[1]!);
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'active' } });
    fireEvent.click(screen.getByRole('button', { name: 'ほか 1218 件 ▸' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    expect(onIntent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
  it('平らな結果でも、行の状態の札でタブへ移る', () => {
    const { onIntent } = mount({ rows: [row('a', { state: 'archived' })], shown: 1, total: 1, conditions: ['7 日'] });
    fireEvent.click(screen.getByRole('button', { name: 'Archived のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'archived' } });
  });
});
```

`packages/ui/src/styles/responsive.test.ts` の `it('セッションの絞り込みは、入り切らなければ次の行へ送る'` の中（40 行の後ろ）に足す。

```ts
    // 900px の窓では 7 つのタブ（「Done 1,221」など）が 1 行に収まらない。
    expect(body(read('rows.css'), '.sessions-tabs')).toMatch(/flex-wrap: wrap;/);
```

`packages/ui/src/views/misc.test.tsx` の既存の試験を、動きの切替を外した形に直す（行番号は直す前のもの。上から順に直すと下の行がずれるので、中身で探す）。

- 21〜27 行（`radiogroup` の「状態」を見て、`live` の 3 つを押す 7 行）を、次の 1 行に置き換える。

```ts
    expect(screen.queryByRole('radiogroup', { name: '状態' })).toBeNull();
```

- 31 行の `expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: 'x y' });` を、次に置き換える。

```ts
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: 'x y', filter: {} });
```

- 36 行（`radiogroup` の「状態」で「終了」に印が付くことを見る 1 行）を消す。

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/SessionsScreen.test.tsx packages/ui/src/views/misc.test.tsx packages/ui/src/styles/responsive.test.ts`
Expected: FAIL（タブの group が無い、状態の radiogroup がまだある、など）

- [ ] **Step 3: View を書き直す**

`packages/ui/src/views/SessionsScreen.tsx` の全体を次に置き換える。

```tsx
import { parseQuery, type Intent, type SearchFilter, type StatusFilter } from '@agent-hangar/shared';
import type { KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { SECTION_TAB, type SectionId } from '../presenters/sections.ts';
import type { SessionsProps, StatusTab } from '../presenters/sessions.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { PageHeading } from './PageHeading.tsx';
import { SessionRows } from './SessionRows.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';

/**
 * 期間の選択肢。値は今日を含めた日数で、空は絞り込みなし。
 * 「今日」は暦の今日（0 時から）、「7 日」は今日とその前の 6 日である（mediator/screen.ts の periodStart）。
 */
const PERIODS = [{ value: '', label: '全期間' }, { value: '1', label: '今日' }, { value: '7', label: '7 日' }, { value: '30', label: '30 日' }];
/** サーバが 1 度に返す件数（server/src/search/search.ts の既定）。続きもこの件数ずつ読む。 */
const PAGE = 50;
/** 欄が空のときの案内。トークンの書き方をここで見せる。 */
const PLACEHOLDER = 'キーワード、または is:paused · since:7d · project: · file:';

/** その項目の絞り込みを外す patch。チップの × と、空の欄の Backspace で使う。 */
const unset = (key: keyof SearchFilter) => ({ [key]: undefined }) as Partial<SearchFilter>;

/**
 * セッション横断の一覧と検索（★）。
 * 上から、件数つきの状態のタブ、全文検索の欄、絞り込み、条件の行、一覧の順に置く。
 * 欄を正とする。欄はトークン（is:paused、since:7d、project:、file:）を受け、Enter で読んだ条件を search.query に添えて出す（パレットの「全文検索」の行も search.query へ来る）。
 * タブと絞り込みはその表示で、押すと search.filter を出し、効いている条件は欄の中のチップになる。
 * 条件が無いときは節で読み（sections）、条件かタブがあれば平らな結果（rows）を出す。
 * 条件が 1 つでも効いていれば、欄と絞り込みの下に条件の行を出し、効いている条件、「条件をクリア」、件数を並べる（D1）。
 * 動きの切替は外した。入力待ちと実行中は Home が出し、ここでは is:running と is:waiting で届く。
 */
export function SessionsScreen(props: SessionsProps) {
  const emit = useEmit();
  const period = props.filter.days ? String(props.filter.days) : '';
  // サーバが返したのが上位の一部なら、全件の数と並べて、並ぶ行の数と食い違わないようにする。
  const count = props.loading ? '検索しています' : props.shown < props.total ? `上位 ${props.shown} / ${props.total} 件` : `${props.total} 件`;
  const filtered = props.conditions.length > 0;
  const left = props.total - props.shown;
  const more = props.mode === 'search' && !props.loading && left > 0;
  const foot = more ? (
    <div className="sessions-more">
      <button type="button" className="btn btn-sm" disabled={props.loadingMore} onClick={() => emit({ type: 'search.more', offset: props.shown })}>{props.loadingMore ? '読み込んでいます' : `さらに ${Math.min(PAGE, left)} 件を読み込む`}</button>
      <span className="faint">残り {left} 件</span>
    </div>
  ) : undefined;
  const pickTab = (tab: StatusTab) => { if (tab !== props.tab) emit({ type: 'search.filter', patch: { status: tab === 'all' ? undefined : tab } }); };
  // 見出しの「この節だけ見る」「ほか N 件」「表示」は、その節のタブを選ぶのと同じにする。今日戻るにはタブが無いので出さない。
  const moreIntent = (target: SectionId): Intent | null => {
    const status = SECTION_TAB[target];
    return status ? { type: 'search.filter', patch: { status } } : null;
  };
  // 行の状態の札を押すと、そのタブへ移る（★ の E）。
  const badgeIntent = (status: StatusFilter): Intent => ({ type: 'search.filter', patch: { status } });
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    const input = e.currentTarget;
    if (e.key === 'Enter') {
      // 打ったトークンは今のチップに重ねる。読めた分は欄から消し、残った語だけを欄に残す。
      const { text, filter } = parseQuery(input.value, props.projects);
      input.value = text;
      emit({ type: 'search.query', text, filter: { ...props.filter, ...filter } });
    } else if (e.key === 'Backspace' && input.value === '' && props.tokens.length > 0) {
      // 空の欄で Backspace を押したら、最後のチップを外す。
      emit({ type: 'search.filter', patch: unset(props.tokens[props.tokens.length - 1]!.key) });
    }
  };
  return (
    <div className="screen sessions-screen screen-fill">
      <PageHeading title="セッション"><span className="faint mono sessions-count">{props.allCount} 件</span></PageHeading>
      <div className="sessions-tabs" role="group" aria-label="状態">
        {props.tabs.map((t) => (
          <button key={t.tab} type="button" className="sessions-tab" aria-pressed={t.tab === props.tab} onClick={() => pickTab(t.tab)}>
            {t.label}<span className="sessions-tab-n" data-hot={t.hot ? 'true' : undefined}>{t.count}</span>
          </button>
        ))}
      </div>
      <div className="sessions-keyword">
        <Icon name="fullText" />
        {props.tokens.map((t) => (
          <span key={t.key} className="sessions-token">
            <span className="sessions-token-text">{t.token}</span>
            <button type="button" className="sessions-token-x" aria-label={`${t.token} を外す`} onClick={() => emit({ type: 'search.filter', patch: unset(t.key) })}><Icon name="close" /></button>
          </span>
        ))}
        <input aria-label="キーワード" placeholder={props.tokens.length > 0 ? '' : PLACEHOLDER} defaultValue={props.text} onKeyDown={onKeyDown} />
        {/* 探すのは会話の本文である（server/src/search/search.ts は event_fts の本文だけを引く）。 */}
        <span className="sessions-keyword-tag">本文</span>
        {props.text && <button type="button" className="btn btn-sm sessions-keyword-clear" aria-label="キーワードを消す" onClick={() => emit({ type: 'search.query', text: '' })}><Icon name="close" /></button>}
      </div>
      {props.hints.length > 0 && <div className="sessions-hint" role="note">{props.hints.map((h) => <div key={h}>{h}</div>)}</div>}
      <div className="sessions-filters">
        <Listbox label="プロジェクト" value={props.filter.projectId ?? ''} options={[{ value: '', label: 'すべてのプロジェクト' }, ...props.projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => emit({ type: 'search.filter', patch: { projectId: v || undefined } })} faceClassName="listbox-face listbox-pill" minWidth={280} searchPlaceholder="プロジェクトを探す" />
        {/* 帯に無い期間（since:14d など）では、どの帯にも印を付けない。「全期間」に印が付くと、絞っていないように読める。 */}
        <Segmented label="期間" value={period} options={PERIODS}
          onChange={(v) => emit({ type: 'search.filter', patch: { days: v ? Number(v) : undefined } })} />
        {/* 条件をクリアしたときに欄の文字も消えるよう、値が変わったら作り直す。 */}
        <input key={props.filter.file ?? ''} className="input" aria-label="ファイル" placeholder="触ったファイル" defaultValue={props.filter.file ?? ''} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.filter', patch: { file: (e.target as HTMLInputElement).value || undefined } }); }} />
      </div>
      {filtered && (
        <div className="sessions-cond" role="status" aria-label="絞り込みの条件">
          <Icon name="filter" />
          <span className="sessions-cond-text">{props.conditions.map((c, i) => <span key={i}>{i > 0 && ' · '}<b>{c}</b></span>)} で絞り込み中</span>
          <button type="button" className="btn btn-sm sessions-cond-clear" onClick={() => emit({ type: 'search.clear' })}><Icon name="close" />条件をクリア</button>
          <span className="faint mono sessions-cond-count">{count}</span>
        </div>
      )}
      {props.sections
        ? <SessionRows id="session-results" items={props.sections} variant="search" autoFocus moreIntent={moreIntent} badgeIntent={badgeIntent} />
        : <SessionRows id="session-results" rows={props.rows} variant="search" autoFocus loadingMore={props.loadingMore} emptyText={props.mode === 'search' && !props.loading ? '一致するセッションはありません' : undefined} foot={foot} badgeIntent={badgeIntent} />}
    </div>
  );
}
```

- [ ] **Step 4: タブとチップの CSS を足す**

`packages/ui/src/styles/rows.css` の `.sessions-count { font-weight: 400; }`（95 行）の直後に足す。

```css
/* 状態のタブ（★）。件数つきで、入り切らなければ次の行へ送る（900px の窓では 7 つが 1 行に並ばない）。 */
.sessions-tabs { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 1.5); margin-bottom: calc(var(--u) * 3); }
.sessions-tab { display: inline-flex; align-items: center; gap: calc(var(--u) * 1.5); height: var(--row-h); padding: 0 calc(var(--u) * 3); border: 0; border-radius: var(--r-pill); background: none; font: inherit; font-size: var(--fs-sm); font-weight: 560; color: var(--ink-2); white-space: nowrap; cursor: pointer; transition: background var(--dur-fast) var(--ease-out); }
.sessions-tab:hover { background: var(--surface-2); }
.sessions-tab[aria-pressed='true'] { background: var(--surface); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong); }
.sessions-tab-n { font-size: var(--fs-xs); font-weight: 500; color: var(--ink-3); font-variant-numeric: tabular-nums; }
/* 確かめるが 1 件以上なら、数字を候補の色で灯す。淡い地の上の --cand は 4.5 : 1 を超える（tokens.test.ts）。 */
.sessions-tab-n[data-hot='true'] { padding: 0 6px; border-radius: var(--r-pill); color: var(--cand); background: var(--cand-soft); font-weight: 600; }
```

`.sessions-keyword-clear { color: var(--ink-3); }`（103 行）の直後に足す。

```css
/* 欄の中のチップ。欄の高さ（34px）に収め、長い値は省略する。 */
.sessions-token { flex: 0 1 auto; display: inline-flex; align-items: center; gap: 2px; min-width: 0; max-width: 220px; height: 22px; padding: 0 2px 0 calc(var(--u) * 2); border-radius: 6px; background: var(--accent-soft); color: var(--accent); font-family: var(--font-mono); font-size: var(--fs-xs); }
.sessions-token-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sessions-token-x { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: none; color: inherit; cursor: pointer; }
.sessions-token-x .icon { width: 12px; height: 12px; }
/* 読めなかったトークンの知らせ。欄のすぐ下に、本文の色で出す。 */
.sessions-hint { margin: calc(var(--u) * -2) var(--u) calc(var(--u) * 3); font-size: var(--fs-xs); color: var(--ink-2); }
```

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/views/SessionsScreen.tsx packages/ui/src/views/SessionsScreen.test.tsx packages/ui/src/views/misc.test.tsx packages/ui/src/styles/rows.css packages/ui/src/styles/responsive.test.ts
git commit -m "feat(ui): add status tabs, token chips and sections to the sessions screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Home の「今日戻る」の札と、確かめるに混ぜる提案（C1）

**Files:**
- Modify: `packages/ui/src/presenters/home.ts:1-84`
- Modify: `packages/ui/src/views/HomeScreen.tsx:1-11`（import）、`:48-62`（要対応）、`:122-157`（確かめる）
- Modify: `packages/ui/src/styles/home.css`（末尾に足す）、`packages/ui/src/styles/home.test.ts`、`packages/ui/src/styles/tokens.test.ts`
- Modify: `packages/ui/src/presenters/presenters.test.ts:209-210`、`packages/ui/src/views/screens.test.tsx:17-73`
- Test: `packages/ui/src/presenters/homeReturn.test.ts`（新規）、`packages/ui/src/views/HomeReturn.test.tsx`（新規）

**Interfaces:**
- Consumes: `SessionDto.state`、`isReturnOn`・`localDate`・`overdueDays`（第 1 段）、第 1 段の `presenters/row.ts` の `returnOnLabel(returnOn: string, overdue: number | null): string`（「今日」「N 日過ぎ」「10/2（金）」）と `candidateLabel(c: { status; returnOn }): string`（「Done にする？」「Paused · 10/3（土）？」）、`dueOn`（Task 3）、Intent `session.state.set`・`session.state.confirm`・`session.state.reject`・`session.pause.open`（第 1 段）
- Produces:
  - `type ReturnCard = { id: string; name: string; projectName: string | null; reason: string; returnOn: string | null; overdueDays: number | null }`
  - `type TodoConfirmCard = { kind: 'todo'; id; text; projectId; projectName; sessionName; ago; note }`、`type SessionConfirmCard = { kind: 'session'; id: string; name: string; projectName: string | null; status: 'paused' | 'done'; label: string; note: string; ago: string }`、`type ConfirmCard = TodoConfirmCard | SessionConfirmCard`
  - `HomeProps.returning: ReturnCard[]`

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/presenters/homeReturn.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto, SessionStateDto, TodoDto } from '@agent-hangar/shared';
import { periodStart } from '../mediator/screen.ts';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentHome } from './home.ts';

/** 2026-10-02（金）の朝 9 時。 */
const NOW = new Date(2026, 9, 2, 9, 0).getTime();
const H = 3_600_000;
const project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null, ...o });
const dto = (id: string, hoursAgo: number, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - (hoursAgo + 1) * H, lastActivityAt: NOW - hoursAgo * H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, state: null, ...over });
const paused = (id: string, hoursAgo: number, returnOn: string | null, over: Partial<SessionDto> = {}) => dto(id, hoursAgo, { state: st({ status: 'paused', note: `${id} を確かめる`, returnOn, setBy: 'user', setAt: NOW - hoursAgo * H }), ...over });
const proposed = (id: string, status: 'paused' | 'done', at: number, returnOn: string | null = null, over: Partial<SessionDto> = {}) => dto(id, 3, { state: st({ candidate: { status, note: '直した', returnOn, source: 'in_session', at } }), ...over });
const todo = (id: string, at: number, projectId = 'alpha'): TodoDto => ({ id, projectId, text: `やる ${id}`, done: false, position: 1, sessionId: null, updatedAt: 1, candidate: { sessionId: null, note: '片付いた', at } });
function storeOf(list: SessionDto[], todos: TodoDto[] = []): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: project('alpha') };
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  s.todos = Object.fromEntries(todos.map((t) => [t.id, t]));
  return s;
}

describe('presentHome の今日戻る（C1）', () => {
  it('戻る日が今日か過ぎた Paused を、入力待ちの札とは別に戻る日の古い順で出し、先のものと動いているものは出さない', () => {
    const store = storeOf([dto('w', 0.2, { live: 'waiting' }), paused('sync', 24, '2026-10-02'), paused('e2e', 72, '2026-09-29'), paused('later', 30, '2026-10-05'), paused('busy', 1, '2026-10-01', { live: 'busy' })]);
    const h = presentHome(initialState(), store, NOW);
    expect(h.attention.map((a) => a.id)).toEqual(['w']);
    expect(h.returning).toEqual([
      { id: 'e2e', name: 'e2e', projectName: 'alpha', reason: 'e2e を確かめる', returnOn: '2026-09-29', overdueDays: 3 },
      { id: 'sync', name: 'sync', projectName: 'alpha', reason: 'sync を確かめる', returnOn: '2026-10-02', overdueDays: 0 },
    ]);
  });
  it('札に出したものは最近から外し、今日戻るがあれば idle にしない', () => {
    const h = presentHome(initialState(), storeOf([paused('sync', 24, '2026-10-02'), paused('later', 30, '2026-10-05'), dto('x', 2)]), NOW);
    expect(h.recent.map((r) => r.id)).toEqual(['x', 'later']);
    expect(h.idle).toBe(false);
    expect(presentHome(initialState(), storeOf([paused('later', 30, '2026-10-05')]), NOW).idle).toBe(true);
  });
  it('「今日」の境は手元の暦の 0 時で、期間の「今日」（periodStart(1, now)）と同じ', () => {
    const midnight = periodStart(1, NOW);
    const store = storeOf([paused('p', 24, '2026-10-02')]);
    expect(presentHome(initialState(), store, midnight).returning.map((r) => r.id)).toEqual(['p']);
    expect(presentHome(initialState(), store, midnight - 1).returning).toEqual([]);
  });
  it('戻る日が欠けた Paused と暦に無い日の Paused は、日付なし（null）として先頭に出す', () => {
    const h = presentHome(initialState(), storeOf([paused('ok', 30, '2026-10-01'), paused('none', 40, null), paused('broken', 50, '2026-02-30')]), NOW);
    expect(h.returning.map((r) => [r.id, r.returnOn, r.overdueDays])).toEqual([['none', null, null], ['broken', null, null], ['ok', '2026-10-01', 1]]);
  });
  it('プロジェクトの無いセッションと消えたプロジェクトを指すセッションは、プロジェクト名を null にし、理由が無ければ決まりの文を出す', () => {
    const noNote = dto('n', 7, { projectId: null, state: st({ status: 'paused', returnOn: '2026-10-02', setBy: 'user', setAt: NOW }) });
    const h = presentHome(initialState(), storeOf([noNote, paused('g', 6, '2026-10-02', { projectId: 'gone' })]), NOW);
    expect(h.returning.map((r) => [r.id, r.projectName, r.reason])).toEqual([['g', null, 'g を確かめる'], ['n', null, '理由は書かれていません']]);
  });
});

describe('presentHome の確かめる', () => {
  it('TODO の候補とセッションの提案を、候補になった時刻の古い順に混ぜる', () => {
    const store = storeOf([proposed('nfd', 'done', NOW - 2 * H), proposed('cpu', 'paused', NOW - 0.5 * H, '2026-10-03')], [todo('a', NOW - 60_000), todo('b', NOW - 3 * H)]);
    const h = presentHome(initialState(), store, NOW);
    expect(h.confirm.map((c) => [c.kind, c.id])).toEqual([['todo', 'b'], ['session', 'nfd'], ['session', 'cpu'], ['todo', 'a']]);
    expect(h.confirm[1]).toEqual({ kind: 'session', id: 'nfd', name: 'nfd', projectName: 'alpha', status: 'done', label: 'Done にする？', note: '直した', ago: '2 時間前' });
  });
  // 文言は行の提案の札（第 1 段の candidateLabel）と同じにする。Home と一覧で言い方が食い違わないように。
  it('提案の札は行の提案の札と同じ文言で、Paused は戻る日を言う', () => {
    const label = (returnOn: string | null) => (presentHome(initialState(), storeOf([proposed('p', 'paused', NOW - H, returnOn)]), NOW).confirm[0] as { label: string }).label;
    expect(label('2026-10-03')).toBe('Paused · 10/3（土）？');
    expect(label(null)).toBe('Paused · 日付なし？');
  });
  it('プロジェクトの「確かめる N」は、セッションの提案も数える', () => {
    const store = storeOf([proposed('nfd', 'done', NOW - 2 * H), proposed('orphan', 'done', NOW - H, null, { projectId: null })], [todo('a', NOW - 60_000)]);
    expect(presentHome(initialState(), store, NOW).projects.find((p) => p.id === 'alpha')!.counts).toContain('確かめる 2');
  });
});
```

`packages/ui/src/views/HomeReturn.test.tsx` を作る。

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { ConfirmCard, HomeProps, ReturnCard } from '../presenters/home.ts';
import { HomeScreen } from './HomeScreen.tsx';

const home = (over: Partial<HomeProps> = {}): HomeProps => ({ attention: [], returning: [], confirm: [], running: [], recent: [], projects: [], idle: false, ...over });
const ret = (id: string, overdueDays: number | null, projectName: string | null = 'agent-hangar'): ReturnCard => ({ id, name: `戻る ${id}`, projectName, reason: `${id} の数字を見る`, returnOn: overdueDays === null ? null : '2026-10-02', overdueDays });

describe('HomeScreen の今日戻る（C1）', () => {
  it('要対応の札の並びに、入力待ちの後ろで今日戻るの札を出し、戻る日を言う', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home({ attention: [{ id: 'w1', name: '待ち', projectName: 'a', waited: '1 分', question: 'q', answer: 'terminal' }], returning: [ret('r1', 0), ret('r2', 3), ret('r3', null, null)] })} /></IntentRoot>);
    const section = screen.getByRole('heading', { name: /要対応/ }).closest('section')!;
    expect(within(section).getByRole('heading', { name: /要対応/ })).toHaveTextContent('要対応4');
    const cards = [...section.querySelectorAll('.ask-card')];
    expect(cards.map((c) => c.classList.contains('return-card'))).toEqual([false, true, true, true]);
    expect(cards.slice(1).map((c) => c.querySelector('.return-when')!.textContent)).toEqual(['今日', '3 日過ぎ', '日付なし']);
    expect(cards[1]).toHaveTextContent('r1 の数字を見る');
    expect(cards[3]).toHaveTextContent('未分類');
  });
  it('今日戻るの札から開く、戻る日を変える、Done にする', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ returning: [ret('r1', 0)] })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '開く' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'r1' });
    fireEvent.click(screen.getByRole('button', { name: '戻る r1 の戻る日を変える' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.pause.open', id: 'r1', from: 'menu' });
    fireEvent.click(screen.getByRole('button', { name: '戻る r1 を Done にする' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 'r1', status: 'done' });
  });
  it('今日戻るも入力待ちも無ければ、要対応の区画ごと省く', () => {
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home()} /></IntentRoot>);
    expect(screen.queryByRole('heading', { name: /要対応/ })).toBeNull();
  });
});

describe('HomeScreen の確かめる（セッションの提案）', () => {
  const session = (id: string, status: 'paused' | 'done'): ConfirmCard => ({ kind: 'session', id, name: `会話 ${id}`, projectName: null, status, label: status === 'done' ? 'Done にする？' : 'Paused · 10/3（土）？', note: '直して push した', ago: '2 時間前' });
  const todo: ConfirmCard = { kind: 'todo', id: 't1', text: '窓を掴める', projectId: 'p1', projectName: 'agent-hangar', sessionName: 's', ago: '1 分前', note: 'n' };
  it('提案の札を行の頭に出し、確定・日を変える（Paused のみ）・却下を押せる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ confirm: [session('s1', 'paused'), session('s2', 'done')] })} /></IntentRoot>);
    const section = screen.getByRole('heading', { name: /確かめる/ }).closest('section')!;
    expect([...section.querySelectorAll('.home-cand')].map((x) => x.textContent)).toEqual(['Paused · 10/3（土）？', 'Done にする？']);
    expect(section).toHaveTextContent('未分類');
    fireEvent.click(within(section).getByRole('button', { name: '会話 s1 の提案を確定' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1' });
    fireEvent.click(within(section).getByRole('button', { name: '会話 s1 の戻る日を変える' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.pause.open', id: 's1', from: 'candidate' });
    fireEvent.click(within(section).getByRole('button', { name: '会話 s2 の提案を却下' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.state.reject', id: 's2' });
    expect(within(section).queryByRole('button', { name: '会話 s2 の戻る日を変える' })).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: '会話 s2' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 's2' });
  });
  it('TODO の候補と混ざった並びをそのまま描く', () => {
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home({ confirm: [todo, session('s1', 'done')] })} /></IntentRoot>);
    const section = screen.getByRole('heading', { name: /確かめる/ }).closest('section')!;
    expect(within(section).getByRole('heading', { name: /確かめる/ })).toHaveTextContent('確かめる2');
    const cards = [...section.querySelectorAll('.ask-card')];
    expect(cards[0]!.querySelector('.cand-mark')).not.toBeNull();
    expect(cards[1]!.querySelector('.home-cand')).not.toBeNull();
  });
});
```

`packages/ui/src/styles/home.test.ts` の `describe` の中に足す。

```ts
  it('今日戻るの札は戻る日の黄土で塗り、提案の札は候補の色の枠だけにする（C1 と Q3）', () => {
    expect(css).toMatch(/\.return-when \{[^}]*color: var\(--surface\);[^}]*background: var\(--st-paused\);/);
    expect(css).toMatch(/\.home-cand \{[^}]*color: var\(--cand\);[^}]*box-shadow: inset 0 0 0 1px var\(--cand\);/);
  });
```

`packages/ui/src/styles/tokens.test.ts` の `it('注記の色は白地で 4.5:1 以上、主ボタンの白い文字は 4.5:1 以上'` の中に足す。

```ts
    // 戻る日の塗りの札（Home の今日戻る）は、黄土の地に白の文字を載せる。
    expect(contrast(token('--surface'), token('--st-paused'))).toBeGreaterThanOrEqual(4.5);
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/homeReturn.test.ts packages/ui/src/views/HomeReturn.test.tsx packages/ui/src/styles/home.test.ts packages/ui/src/styles/tokens.test.ts`
Expected: FAIL（`returning` が undefined、`.return-when` が無い）

- [ ] **Step 3: Home の Presenter を直す**

`packages/ui/src/presenters/home.ts` を直す。

- 1 行の import を `import { isReturnOn, localDate, overdueDays, type LiveStatus, type ProjectStatus, type SessionDto } from '@agent-hangar/shared';` に、4 行を `import { durationLabel, percentLabel, relativeTime, shortModel } from './format.ts';` に、7 行を `import { candidateLabel, presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';` にし、その後ろに `import { dueOn } from './sections.ts';` を足す。
- 23〜29 行（`ConfirmCard` と `HomeProps`）を次に置き換える。

```ts
/**
 * 今日戻るの札（C1）。要対応の札の並びに、入力待ちの札の後ろで置く。
 * 戻る日が今日か過ぎた Paused 1 件につき 1 枚。戻る日が欠けたり壊れたりしたものも、利用者が決めるまで出す（returnOn と overdueDays は null）。
 * 動いているセッションは入力待ちか実行中の札に出るので、ここには重ねない。
 */
export type ReturnCard = { id: string; name: string; projectName: string | null; reason: string; returnOn: string | null; overdueDays: number | null };
/** 確かめるの行のうち、TODO の完了の候補。押すとそのプロジェクトへ移る。 */
export type TodoConfirmCard = { kind: 'todo'; id: string; text: string; projectId: string; projectName: string; sessionName: string; ago: string; note: string };
/**
 * 確かめるの行のうち、セッションの状態の提案（Q3）。label は行の頭の札の文言（「Done にする？」「Paused · 10/3（土）？」）。
 * 確定、日を変える（Paused のときだけ）、却下を行から押せる。名前を押すとそのセッションを開く。
 */
export type SessionConfirmCard = { kind: 'session'; id: string; name: string; projectName: string | null; status: 'paused' | 'done'; label: string; note: string; ago: string };
/** 確かめるの行。TODO の候補とセッションの提案を、候補になった時刻の古い順に混ぜる。 */
export type ConfirmCard = TodoConfirmCard | SessionConfirmCard;
/**
 * idle は何も動いていないこと（実行中の札も要対応の札も無い）で、真なら実行中の札の場所に 1 行の文を出す（試作 home-lists の F1）。
 * 入力待ちも生きたセッションなので、入力待ちがあるときは偽にする。今日戻るの札も要対応に並ぶので、あれば偽にする。
 */
export type HomeProps = { attention: AttentionCard[]; returning: ReturnCard[]; confirm: ConfirmCard[]; running: RunningCard[]; recent: SessionRowProps[]; projects: ProjectMini[]; idle: boolean };
```

- 31〜33 行の定数の後ろに足す。

```ts
/** 今日戻るの理由が無いときに出す文。 */
const NO_REASON = '理由は書かれていません';
/** 提案の根拠が無いときに出す文。TODO の候補（presenters/project.ts）と同じ言い方にする。 */
const NO_NOTE = '根拠は書かれていません';
```

- `presentHome`（42〜84 行）を次に置き換える。`running` と `projects` の組み立ては元のままで、`alive` を先頭へ移し、今日戻ると提案を足す。

```ts
export function presentHome(_state: State, store: Store, now: number): HomeProps {
  const sessions = Object.values(store.sessions);
  const projectName = (s: SessionDto) => (s.projectId ? store.projects[s.projectId]?.name ?? null : null);
  const name = (s: SessionDto) => s.name ?? '（名前なし）';
  // Claude のレジストリに載る前の run も実行中に数える。
  // 信頼確認のダイアログ待ちの run が Home のどこにも出ないと、セッション画面への戻り道がなくなる。
  const alive = runningSessionIds(store);

  // 長く待っているものほど先に答えたいので、最後に動いた時刻の古い順に並べる。
  const waiting = sessions.filter((s) => s.live === 'waiting').sort((a, b) => (a.lastActivityAt ?? now) - (b.lastActivityAt ?? now));
  const attention = waiting.map((s) => ({ id: s.id, name: name(s), projectName: projectName(s), waited: durationLabel(now - (s.lastActivityAt ?? now)), question: s.activity?.question ?? NO_QUESTION, answer: aliveRunOf(store, s.id) ? 'terminal' as const : outsideOpenOf(store, s) }));

  // 今日戻る（C1）。戻る日の古い順で、欠けた日と壊れた日を先頭に、同じ日の中は新しい順にする。
  // 「今日」は手元の暦で、期間の「今日」（mediator/screen.ts の periodStart(1, now)）と同じ境にする。
  const today = localDate(now);
  const returnKey = (s: SessionDto) => { const r = s.state?.returnOn ?? null; return r !== null && isReturnOn(r) ? r : ''; };
  const returning = sessions
    .filter((s) => s.state?.status === 'paused' && dueOn(s.state.returnOn, today) && liveFilterOfSession(store, s, alive) === 'ended')
    .sort((a, b) => returnKey(a).localeCompare(returnKey(b)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .map((s): ReturnCard => {
      const r = returnKey(s);
      return { id: s.id, name: name(s), projectName: projectName(s), reason: s.state?.note || NO_REASON, returnOn: r || null, overdueDays: r ? overdueDays(r, now) : null };
    });

  // 確かめる。TODO の完了の候補とセッションの状態の提案を、候補になった時刻の古い順に混ぜる。
  // 放っておくと溜まるので、長く待っているものほど先に出す。
  const candidates = Object.values(store.todos)
    .map((t) => ({ t, c: presentTodoCandidate(t, store, now) }))
    .filter((x): x is { t: typeof x.t; c: NonNullable<typeof x.c> } => x.c !== null);
  const proposed = sessions.filter((s) => !!s.state?.candidate);
  const confirm = [
    ...candidates.map(({ t, c }): { at: number; card: ConfirmCard } => ({ at: t.candidate!.at, card: { kind: 'todo', id: t.id, text: t.text, projectId: t.projectId, projectName: store.projects[t.projectId]?.name ?? '未分類', sessionName: c.sessionName, ago: c.ago, note: c.note } })),
    ...proposed.map((s): { at: number; card: ConfirmCard } => {
      const c = s.state!.candidate!;
      // 札の文言は行の提案の札（第 1 段の candidateLabel）と同じにする。
      return { at: c.at, card: { kind: 'session', id: s.id, name: name(s), projectName: projectName(s), status: c.status, label: candidateLabel(c), note: c.note || NO_NOTE, ago: relativeTime(c.at, now) } };
    }),
  ].sort((a, b) => (a.at - b.at) || a.card.id.localeCompare(b.card.id)).map((x) => x.card);

  const running = sortSessions(sessions.filter((s) => liveFilterOfSession(store, s, alive) === 'running')).map((s): RunningCard => {
    // 対象が取れない呼び出し（答えた後の AskUserQuestion など）は summary にツール名が入る。同じ語を 2 度並べないよう空にする。
    // summary の先頭に「ツール名+半角空白」が付くこともある（サーバの toolSummary が付けた分）。カードはツール名を <i> で先に出すので、その重なりを削る。
    const activity = s.live === 'busy' && s.activity ? { tool: s.activity.tool, summary: stripLeadingTool(s.activity.tool, s.activity.summary) } : null;
    const note = activity ? null : s.live === 'idle' ? `休み。最後の返答から ${durationLabel(now - (s.lastActivityAt ?? now))}` : s.live === 'busy' ? '作業中' : '起動しています';
    const meta = [projectName(s) ?? '未分類', shortModel(s.stats.model), s.stats.effort ?? ''].filter((x) => x !== '').join(' · ');
    return { id: s.id, name: name(s), live: s.live, elapsed: durationLabel(now - (s.startedAt ?? now)), meta, activity, note, contextPercent: s.stats.contextPercent, contextLabel: percentLabel(s.stats.contextPercent) };
  });

  // 札に出したものは最近に重ねない。
  const shown = new Set([...attention.map((c) => c.id), ...returning.map((c) => c.id), ...running.map((c) => c.id)]);
  const recent = sessions.filter((s) => !shown.has(s.id)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, RECENT_LIMIT).map((s) => presentSessionRow(s, store, now));

  const projects = Object.values(store.projects).filter((p) => p.status === 'active' && !p.isScratch).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map((p): ProjectMini => {
    // 実行中と入力待ちは、プロジェクトのカードと同じく手元のセッションから数える。
    // 入力待ちは要対応として別に数える。確かめるは TODO の候補とセッションの提案を合わせて数える。
    const live = liveCountsOf(store, p.id, alive);
    const confirmHere = candidates.filter(({ t }) => t.projectId === p.id).length + proposed.filter((s) => s.projectId === p.id).length;
    const counts: [string, number][] = [['実行中', live.running], ['TODO', p.openTodoCount], ['要対応', live.waiting], ['確かめる', confirmHere]];
    return { id: p.id, name: p.name, status: p.status, counts: counts.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`).join(' · ') };
  });

  return { attention, returning, confirm, running, recent, projects, idle: attention.length === 0 && returning.length === 0 && running.length === 0 };
}
```

- [ ] **Step 4: Home の View と CSS を直す**

`packages/ui/src/views/HomeScreen.tsx` を直す。

- 4 行の import を `import type { AttentionCard, ConfirmCard, HomeProps, ReturnCard, RunningCard } from '../presenters/home.ts';` にし、その後ろに `import { returnOnLabel } from '../presenters/row.ts';` を足す。
- 48〜62 行（要対応の区画）を次に置き換える。

```tsx
      {(props.attention.length > 0 || props.returning.length > 0) && (
        <section>
          <h2 className="home-label">要対応<span className="home-count">{props.attention.length + props.returning.length}</span></h2>
          {props.attention.map((a) => (
            <div key={a.id} className="ask-card">
              <StatusDot status="waiting" />
              <div className="ask-body">
                <div className="ask-title"><b>{a.name}</b> <span className="faint">· {a.projectName ?? '未分類'} · {a.waited}待っている{a.answer === 'terminal' || a.answer === 'attach' ? '' : ' · 外のターミナルで動いています'}</span></div>
                <div className="ask-q">{a.question}</div>
              </div>
              <AnswerButton card={a} />
            </div>
          ))}
          {props.returning.map((r) => <ReturnCardView key={r.id} card={r} />)}
        </section>
      )}
```

- 122〜157 行の `ConfirmSection` の `shown.map((c) => ( ... ))` を、次に置き換える（`ConfirmSection` の残りはそのまま）。

```tsx
      {shown.map((c) => (c.kind === 'todo' ? (
        <div key={`t:${c.id}`} className="ask-card confirm-card">
          <span className="cand-mark" aria-hidden="true" />
          <div className="ask-body">
            <div className="ask-title">
              <button type="button" className="confirm-open" onClick={() => emit({ type: 'project.open', id: c.projectId })}><b>{c.text}</b></button>
              {' '}<span className="faint">· {c.projectName} · {c.sessionName} · {c.ago}</span>
            </div>
            <div className="ask-q">{c.note}</div>
          </div>
          <button type="button" className="btn btn-primary" aria-label={`${c.text}（${c.projectName}）を確定`} onClick={() => emit({ type: 'todo.confirm', id: c.id })}>確定</button>
          <button type="button" className="btn" aria-label={`${c.text}（${c.projectName}）を却下`} onClick={() => emit({ type: 'todo.reject', id: c.id })}>却下</button>
        </div>
      ) : (
        <div key={`s:${c.id}`} className="ask-card confirm-card">
          <span className="home-cand">{c.label}</span>
          <div className="ask-body">
            <div className="ask-title">
              <button type="button" className="confirm-open" onClick={() => emit({ type: 'session.open', id: c.id })}><b>{c.name}</b></button>
              {' '}<span className="faint">· {c.projectName ?? '未分類'} · {c.ago}</span>
            </div>
            <div className="ask-q">{c.note}</div>
          </div>
          <button type="button" className="btn btn-primary" aria-label={`${c.name} の提案を確定`} onClick={() => emit({ type: 'session.state.confirm', id: c.id })}>確定</button>
          {c.status === 'paused' && <button type="button" className="btn" aria-label={`${c.name} の戻る日を変える`} onClick={() => emit({ type: 'session.pause.open', id: c.id, from: 'candidate' })}>日を変える</button>}
          <button type="button" className="btn" aria-label={`${c.name} の提案を却下`} onClick={() => emit({ type: 'session.state.reject', id: c.id })}>却下</button>
        </div>
      )))}
```

- `ConfirmSection` の直後（`LiveCard` の前）に足す。

```tsx
/** 戻る日の札の文言。行の戻る日の札（第 1 段の returnOnLabel）と同じ「今日」「N 日過ぎ」にし、日が読めなければ「日付なし」。 */
function returnWhen(r: ReturnCard): string {
  return r.returnOn === null ? '日付なし' : returnOnLabel(r.returnOn, r.overdueDays);
}

/**
 * 今日戻るの札（C1）。入力待ちの札と同じ形で、縁を戻る日の黄土にする。
 * 当日と過ぎたものしか出ないので、戻る日の札はいつも塗りつぶす。
 * 開くほかに、その場で戻る日を変えるか Done にできる。決めるまで毎朝ここに残るからである。
 */
function ReturnCardView(props: { card: ReturnCard }) {
  const emit = useEmit();
  const r = props.card;
  return (
    <div className="ask-card return-card">
      <span className="return-when">{returnWhen(r)}</span>
      <div className="ask-body">
        <div className="ask-title"><b>{r.name}</b> <span className="faint">· {r.projectName ?? '未分類'} · 今日戻る</span></div>
        <div className="ask-q">{r.reason}</div>
      </div>
      <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.open', id: r.id })}>開く</button>
      <button type="button" className="btn" aria-label={`${r.name} の戻る日を変える`} onClick={() => emit({ type: 'session.pause.open', id: r.id, from: 'menu' })}>日を変える</button>
      <button type="button" className="btn" aria-label={`${r.name} を Done にする`} onClick={() => emit({ type: 'session.state.set', id: r.id, status: 'done' })}>Done</button>
    </div>
  );
}
```

`packages/ui/src/styles/home.css` の 36 行（`.more-chevron[data-open='true']`）の直後に足す。

```css
/* 今日戻るの札（C1）。要対応の札と同じ形で、縁に戻る日の黄土を薄く混ぜる。 */
.return-card { box-shadow: 0 0 0 1px color-mix(in srgb, var(--st-paused) 22%, transparent), 0 6px 16px -10px color-mix(in srgb, var(--st-paused) 40%, transparent); }
/* 戻る日の札。当日と過ぎたものしか出ないので塗りつぶす。白い文字は --st-paused の地で 4.5 : 1 を超える（tokens.test.ts）。 */
.return-when { flex: none; display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; color: var(--surface); background: var(--st-paused); }
/* セッションの提案の札（Q3）。枠だけの丸い札で、候補の色にする。 */
.home-cand { flex: none; display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; color: var(--cand); box-shadow: inset 0 0 0 1px var(--cand); }
```

- [ ] **Step 5: 既存の試験を新しい形に合わせる**

- `packages/ui/src/presenters/presenters.test.ts` の確かめるの期待（209〜210 行）に `kind: 'todo'` を足す。

```bash
sed -i '' -E "s/\{ id: '(a|b)', text: 'やる /{ kind: 'todo', id: '\1', text: 'やる /" packages/ui/src/presenters/presenters.test.ts
grep -c "kind: 'todo', id: '" packages/ui/src/presenters/presenters.test.ts
```

Expected: `2`

- `packages/ui/src/views/screens.test.tsx` を、次の表のとおり置き換える（Edit で、前の文字列を後ろの文字列に）。

| 行 | 置き換える前 | 置き換えた後 |
|---|---|---|
| 17 | `({ attention: [], confirm: [],` | `({ attention: [], returning: [], confirm: [],` |
| 22 | `const c = { id: 't1', text: '窓を掴める',` | `const c = { kind: 'todo' as const, id: 't1', text: '窓を掴める',` |
| 40 | `=> ({ id, text: '窓を掴める',` | `=> ({ kind: 'todo' as const, id, text: '窓を掴める',` |
| 52 | `const c = { id: 't1', text: '窓',` | `const c = { kind: 'todo' as const, id: 't1', text: '窓',` |
| 58 | `(_, i) => ({ id: \`t${i}\`, text: \`候補 ${i}\`` | `(_, i) => ({ kind: 'todo' as const, id: \`t${i}\`, text: \`候補 ${i}\`` |
| 73 | `(_, i) => ({ id: \`t${i}\`, text: \`候補 ${i}\`` | `(_, i) => ({ kind: 'todo' as const, id: \`t${i}\`, text: \`候補 ${i}\`` |

Run: `grep -c "kind: 'todo' as const" packages/ui/src/views/screens.test.tsx`
Expected: `5`

- [ ] **Step 6: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/presenters/home.ts packages/ui/src/presenters/homeReturn.test.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/HomeScreen.tsx packages/ui/src/views/HomeReturn.test.tsx packages/ui/src/views/screens.test.tsx packages/ui/src/styles/home.css packages/ui/src/styles/home.test.ts packages/ui/src/styles/tokens.test.ts
git commit -m "feat(ui): show today's return cards and session proposals on home

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 設計書の書き足しと、全体の確認とビルド

**Files:**
- Modify: `docs/design.md:1188-1224`（Home）、`:1244-1256`（プロジェクト詳細）、`:1433-1447`（Sessions）

**Interfaces:**
- Consumes: Task 1〜8 のすべて
- Produces: なし

- [ ] **Step 1: 設計書を書き足す**

- 「Home」の節の、要対応の札の説明（「札には名前、プロジェクト、…」の行と「「ターミナルで答える」は…」の行）の後ろに、次の 2 文を足す。

  「要対応の札の並びには、入力待ちの札の後ろに「今日戻る」の黄土の札を置く。戻る日が今日か過ぎた Paused 1 件につき 1 枚で、戻る日の古い順に並べ、札から開く・戻る日を変える・Done にできる（札に出したものは最近に重ねない）。」

- 同じ節の、確かめるを説明する行の後ろに、次の 1 文を足す。

  「確かめるには、TODO の完了の候補とセッションの状態の提案（「Done にする？」「Paused · 10/3（土）？」の枠だけの札）を、候補になった時刻の古い順に混ぜて並べる。」

- 「プロジェクト詳細」の節の「メインはセッション一覧で、実行中を先頭に、その後を新しい順に並べる。」を、次の 3 文に置き換える。

  「メインはセッション一覧で、節で読む（P3）。節は 今日戻る → いま動いている → 続き → Done の順で、中身がある節だけを出し、Archived は末尾の 1 行から開く。Done は Done にした時刻の新しい順に 3 件を見せ、残りは「ほか N 件 ▸」で開く（広げた節はプロジェクトごとに Mediator が覚え、保存はしない）。」

- 「Sessions」の節の「上にキーワード欄、その下に絞り込み（プロジェクト、期間、Provider、実行中か終了か、触ったファイル）、残りが結果一覧である。」を、次の 4 文に置き換える。

  「上から、件数つきの状態のタブ（すべて／確かめる／Paused／Active／印なし／Done／Archived）、キーワード欄、絞り込み（プロジェクト、期間、触ったファイル）、結果一覧の順に置く（★）。条件が無いときは節（今日戻る → 確かめる → いま動いている → Paused → 印なし → Done の直近 3 件、Archived は末尾の 1 行）で読み、条件かタブがあれば平らな結果にする。「すべて」で条件を入れたときは Archived を除く。キーワード欄は `is:` `since:<n>d` `project:` `file:` のトークンを受け、欄を正とする（タブと絞り込みはその表示で、効いている条件は欄の中のチップになる。読めないトークンは語として本文を探し、欄の下で知らせる）。」

- spec の冒頭の「実装が済んだら…」の段落は残す（spec は履歴として残す）。

- [ ] **Step 2: 全体の試験と型**

Run: `npm test && npm run typecheck`
Expected: PASS（失敗があれば、その出力をそのまま添えて直す）

- [ ] **Step 3: ビルド**

```bash
npm run build
npm run bundle-server -w apps/desktop
npm run tauri -w apps/desktop -- build
```

Expected: 3 つとも成功する（`npm run build` は packages/ui の vite build を含む。tauri の build は cargo release で数分かかる）。
ビルドはインストールではない。`apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` ができるだけで、`/Applications/Hangar.app` は置き換わらない。

- [ ] **Step 4: 利用者の dev サーバを一度落とす（利用者の承認を取ってから）**

利用者は自分で `npm run dev` を動かしている。ビルドの後は、利用者の dev のサーバ（4177 を LISTEN している tsx）を一度落とさないと、作り直した server-dist などが反映されない。ポートでまとめて止めず、PID を確かめて 1 つだけ止める。

```bash
lsof -nP -iTCP:4177 -sTCP:LISTEN -t
ps -o pid=,command= -p <上で出た PID>
```

- 出た command が `tsx` の server（`packages/server` の `src/main.ts`）であることを目で確かめ、利用者に「dev のサーバ（PID <n>）を落とします」と伝えて承認を得てから `kill <PID>` する。Vite（5173）には触らない。
- `lsof -ti :4177` は接続している側も拾うので使わない。
- 落としたら、報告に 1 行で書く（サーバは戻らないので、利用者が `npm run dev` を立て直すか、こちらで立てるかを添える）。
- `Hangar.app` が走っていれば、それも同じく承認を得てから落とす（`osascript -e 'tell application "Hangar" to quit'`、残れば `pgrep -fl 'Hangar.app/Contents/MacOS'` の PID だけを止める）。

- [ ] **Step 5: 実物で確かめる（WebKit、900×600 と 1440×900）**

利用者のデータと 4177 には触らず、使い捨てのサーバで見る。

```bash
TMP=/private/tmp/claude-501/hangar-status-check
mkdir -p "$TMP/home"
sqlite3 ~/.agent-hangar/hangar.db ".backup '$TMP/home/hangar.db'"
cp ~/.agent-hangar/settings.json ~/.agent-hangar/device.json "$TMP/home/"
# cloud.json は写さない（使い捨てのサーバからクラウドへ同期させない）。
HANGAR_HOME="$TMP/home" HANGAR_PORT=4277 npx tsx packages/server/src/main.ts > "$TMP/server.log" 2>&1 &
echo $! > "$TMP/server.pid"
```

- 写した DB はマイグレーション v13 で全件が Done になる（導入の翌日の場面）。
- `~/workspace/hangar-explainers/audit-responsive.mjs` の `token` の読み先を `"$TMP/home/token"` に、`PORT` を 4277 にして、`node ~/workspace/hangar-explainers/audit-responsive.mjs 900x600,1440x900 home,project,sessions` を走らせ、折り返し・はみ出し・切れた文字・窓の外が出ないことを確かめる（`audit-summary.py` で一覧にする）。
- 同じ 2 つの大きさで、WebKit の画面を目で見て次を確かめる。
  - プロジェクト画面：Done の節が直近 3 件と「ほか N 件 ▸」で出る。押すと全件に広がり、「畳む ▴」で戻る。j と k が見出しを飛ばす。
  - 行の「⋯」で 1 件を Paused（明日）にし、日付を翌日に進めた `now` は作れないので、代わりに Paused（今日の夕方）にして「今日戻る」の節と Home の黄土の札に出ることを見る。
  - Sessions：7 つのタブと件数が出る。900×600 ではタブが 2 行に折り返し、横にはみ出さない。タブを押すと欄にチップが出て、節が消えて平らになる。`is:pasued` で Enter すると欄の下に知らせが出る。行の Done の札を押すと Done のタブへ移る。
  - Home：今日戻るの札が入力待ちの後ろに並び、確かめるにセッションの提案が TODO の候補と混ざって出る。
  - Archived にした行の名前が淡い。
- 終わったら、自分で立てたサーバだけを止める：`kill "$(cat $TMP/server.pid)"`。
- 見た目の最終確認は利用者に頼む。

- [ ] **Step 6: Commit**

```bash
git add docs/design.md
git commit -m "docs: record sectioned lists, status tabs and today's returns in the design

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
