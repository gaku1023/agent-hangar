# クラウドの使用量と費用の表示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 設定の「クラウド同期」の節に、Cloudflare の今日の使用量・今月の費用・プランを出し、無料枠で止まったときはヘッダーでも分かるようにする。

**Architecture:** Worker に `GET /usage` を足し、secret の読み取り専用トークンで Cloudflare の GraphQL・subscriptions・billable-usage を叩いてまとめる（D1 には書かない、isolate のメモリに写しを持つ）。端末のサーバは `CloudUsagePoller` が 5 分ごとに取りに行き、`CloudUsageDto` にして HTTP・websocket・bootstrap で画面へ配る。トークンが無いときは今の見積もり（`QuotaCounter`）で同じ形を作る。

**Tech Stack:** TypeScript、Hono（Worker と端末の HTTP）、miniflare（Worker の試験）、better-sqlite3、React、vitest 5、commander（CLI）。

**Spec:** `docs/superpowers/specs/2026-10-02-cloud-usage-design.md`（試作は同じ階層の `2026-10-02-cloud-usage/`、試験の原本は `2026-10-02-cloud-usage/fixtures/`）

## Global Constraints

- 文言は日本語。画面の語は試作 `usage-merged.html` の左上（ふだん）と各状態の姿どおり。
- Worker の `/usage` は D1 にも R2 にも 1 行も書かない。
- secret の名前は `USAGE_API_TOKEN` と `CF_ACCOUNT_ID`。setup が書く wrangler の設定にアカウント ID を書かない。
- トークンを argv、ログ、応答、試験の差分、エラー文に出さない。
- 一時停止の間は `/usage` を取りに行かない（決定 4）。
- 取りに行く間隔は 5 分（`USAGE_POLL_MS = 300_000`）。Worker の写しは今日の数が 5 分、プランと請求が 6 時間。
- 注意の色は D1 が止める線（上限 × 0.8）の 75% 以上。
- 試験は実物の `~/.claude`、`~/.agent-hangar`、実物の Cloudflare に触らない。偽物は `docs/superpowers/specs/2026-10-02-cloud-usage/fixtures/` の原本から作る。
- コミットは `git commit <path>...` のパス指定形で行い、`--amend` と rebase は使わない。末尾は `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 実装者は sonnet 以上で動かす。

## Review Focus

1. **Cloudflare が 200 で `success: false` や GraphQL の `errors` を返す** → その部分だけ `null` と `errors` に畳み、ほかの部分は返す。Task 2 で試験を足す。
2. **トークンの失効（401・403）** → 三つとも `null`、errors に「トークンが無効です…」、端末はトークンなしの姿にその文を添える。Task 2 と Task 7 で試験を足す。
3. **古い Worker（`/usage` が 404）と、新しい Worker でトークンなし（`configured: false`）** → どちらも見積もりの姿。同期は止めない。Task 4 と Task 6 で試験を足す。
4. **一時停止の間に設定を開く** → 取りに行かず、最後の値と時刻を出す。Task 6 で試験を足す。
5. **日付の境目（UTC 0 時）を跨いだ停止** → ヘッダーが「9:00 に戻る」から「枠は戻りました」に変わる。端末の時差に依らない。Task 9 で試験を足す。

---

### Task 0: 作業場所を作り、仕様をコミットする

**Files:**
- Commit: `docs/superpowers/specs/2026-10-02-cloud-usage-design.md`、`docs/superpowers/specs/2026-10-02-cloud-usage/`、`docs/superpowers/plans/2026-10-02-cloud-usage.md`

- [ ] **Step 1: worktree を作る**

利用者が npm run dev で使っているメインの checkout は動かさない。superpowers:using-git-worktrees に従い、`main` から `cloud-usage` ブランチの worktree を作る。メインの checkout にある未追跡の仕様・試作・計画を worktree へ写す。

```bash
git -C /Users/me/workspace/agent-hangar worktree add /Users/me/workspace/agent-hangar-cloud-usage -b cloud-usage main
cp -R /Users/me/workspace/agent-hangar/docs/superpowers/specs/2026-10-02-cloud-usage* /Users/me/workspace/agent-hangar-cloud-usage/docs/superpowers/specs/
cp /Users/me/workspace/agent-hangar/docs/superpowers/plans/2026-10-02-cloud-usage.md /Users/me/workspace/agent-hangar-cloud-usage/docs/superpowers/plans/
cd /Users/me/workspace/agent-hangar-cloud-usage && npm ci
```

- [ ] **Step 2: 土台の試験が緑であることを確かめる**

Run: `npx vitest run packages/cloud packages/server packages/shared 2>&1 | tail -5`
Expected: すべて PASS（statusline の日付依存の 1 件が落ちるなら、既存の不具合として記録して進む）。

- [ ] **Step 3: コミット**

```bash
git commit docs/superpowers/specs/2026-10-02-cloud-usage-design.md docs/superpowers/specs/2026-10-02-cloud-usage docs/superpowers/plans/2026-10-02-cloud-usage.md -m "docs: design and plan for cloud usage and cost in settings"
```
（未追跡のファイルなので、先に `git add` でその 3 つのパスだけを足す。）

---

### Task 1: 共有の型と上限の定数

**Files:**
- Modify: `packages/shared/src/cloud.ts`（末尾に足す）
- Modify: `packages/shared/src/api.ts:117`（`SyncStatusDto`）、`:40`（`BootstrapDto`）、末尾に `CloudUsageDto`
- Modify: `packages/shared/src/events.ts`（`sync.usage`）
- Modify: `packages/server/src/sync/quota.ts:4-5`（`QUOTA_LIMITS` を共有の定数から作る）
- Test: `packages/shared/src/cloud.test.ts`

**Interfaces:**
- Produces:
  - `CLOUD_FREE_LIMITS: { d1RowsPerDay: 100_000; workersRequestsPerDay: 100_000 }`
  - `r2Included(serviceName: string): number | null`
  - `type CloudUsagePart = 'today' | 'plan' | 'month'`
  - `type CloudUsageBody`（下のコード）
  - `type CloudUsageDto`（下のコード）
  - `SyncStatusDto` に `pausedReason?: 'quota' | 'user' | null; quotaPausedDay?: string | null`
  - `BootstrapDto` に `cloudUsage?: CloudUsageDto | null`
  - `ServerEvent` に `{ type: 'sync.usage'; usage: CloudUsageDto }`

- [ ] **Step 1: 失敗する試験を書く**

`packages/shared/src/cloud.test.ts` の末尾に足す。

```ts
import { CLOUD_FREE_LIMITS, r2Included } from './cloud.ts';

describe('無料枠の定数', () => {
  it('D1 と Workers の日の枠は 10 万', () => {
    expect(CLOUD_FREE_LIMITS).toEqual({ d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 });
  });
  it('R2 の込み量は billable-usage の ServiceName の頭で引く', () => {
    expect(r2Included('R2 Data Storage (First 10GB-Month included)')).toBe(10);
    expect(r2Included('R2 Storage Class A Operations (First 1M included)')).toBe(1_000_000);
    expect(r2Included('R2 Storage Class B Operations (First 10M included)')).toBe(10_000_000);
  });
  it('知らない項目は null（棒を描かず数だけ出す）', () => {
    expect(r2Included('R2 Infrequent Access Data Retrieval')).toBeNull();
    expect(r2Included('Workers Standard Requests')).toBeNull();
  });
});
```
（既存の import 行に `CLOUD_FREE_LIMITS, r2Included` を足す形でもよい。）

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/shared/src/cloud.test.ts`
Expected: FAIL（`CLOUD_FREE_LIMITS` が無い）

- [ ] **Step 3: 実装する**

`packages/shared/src/cloud.ts` の末尾に足す。

```ts
/**
 * Cloudflare の無料プランの日の枠。正本は料金の頁（D1 と Workers）で、API からは取れない
 * （entitlements に入っていないことを 2026-10-02 に実物で確かめた）。
 * 端末の見張り（packages/server/src/sync/quota.ts の QUOTA_LIMITS）もこの値を指す。
 */
export const CLOUD_FREE_LIMITS = { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 } as const;

/** R2 の月の込み量。billable-usage の ServiceName の頭で引く。単位は ServiceName ごとの PricingUnit（GB-months か Count）。 */
const R2_INCLUDED: [prefix: string, included: number][] = [
  ['R2 Data Storage', 10],
  ['R2 Storage Class A Operations', 1_000_000],
  ['R2 Storage Class B Operations', 10_000_000],
];

export function r2Included(serviceName: string): number | null {
  const hit = R2_INCLUDED.find(([p]) => serviceName.startsWith(p));
  return hit ? hit[1] : null;
}

export type CloudUsagePart = 'today' | 'plan' | 'month';

/** Worker の `GET /usage` の応答。トークンが無い Worker は configured: false だけを返す。 */
export type CloudUsageBody =
  | { configured: false }
  | {
      configured: true;
      fetchedAt: number;
      today: { day: string; d1RowsWritten: number; workersRequests: number } | null;
      plan: { workersPaid: boolean; items: { id: string; name: string; priceUsd: number; frequency: string | null }[]; periodStart: string | null; periodEnd: string | null } | null;
      month: { periodStart: string; throughDay: string | null; billedUsd: number; currency: string; services: { family: string; name: string; consumed: number; unit: string; billedUsd: number }[] } | null;
      errors: { part: CloudUsagePart; message: string }[];
    };
```

`packages/shared/src/api.ts` の `SyncStatusDto`（117 行）を次に置き換える。

```ts
/**
 * pausedReason は止めた理由。quota は無料枠の見張りが止めた、user は利用者が止めた。古いサーバは送らない（undefined）。
 * quotaPausedDay は見張りが止めた UTC の日（yyyy-MM-dd）。
 */
export type SyncStatusDto = { state: SyncStateKind; url: string | null; lastPushAt: number | null; lastPullAt: number | null; pending: number; error: string | null; deviceCount: number; claudeConfig: { enabled: boolean; confirmed: boolean }; pausedReason?: 'quota' | 'user' | null; quotaPausedDay?: string | null };
```

`BootstrapDto`（40 行）の末尾の `retention: RetentionDto | null` の後ろに `; cloudUsage?: CloudUsageDto | null` を足す。ファイルの末尾に足す。

```ts
/**
 * 設定の「使用量と費用」に出す形。端末のサーバが Worker の /usage か見積もりから作る。
 * source が estimate のときは plan と month が null で、today は hangar の見積もりである。
 * stale は最後の取得が失敗していること（値は最後に取れたもの）。notice はトークンの失効など、画面に添える 1 行。
 */
export type CloudUsageDto = {
  source: 'cloudflare' | 'estimate';
  fetchedAt: number | null;
  stale: boolean;
  notice: string | null;
  limits: { d1RowsPerDay: number; workersRequestsPerDay: number; stopRatio: number };
  today: { d1RowsWritten: number; workersRequests: number | null; resetAt: number };
  plan: { label: string; workersPaid: boolean } | null;
  month: { periodStart: string; periodEnd: string | null; throughDay: string | null; billedUsd: number; rows: { label: string; consumed: number; unit: string; included: number | null }[] } | null;
};
```

`packages/shared/src/events.ts` の import に `CloudUsageDto` を足し、`sync.status` の行の後ろに足す。

```ts
  /** 設定の「使用量と費用」。端末のサーバが 5 分ごとに取り直して配る。 */
  | { type: 'sync.usage'; usage: CloudUsageDto }
```

`packages/server/src/sync/quota.ts` の 4〜5 行を置き換える。

```ts
import { CLOUD_FREE_LIMITS } from '@agent-hangar/shared';
import type { SyncStateKey, SyncStateStore } from './state.ts';

/** Cloudflare の無料枠。Workers の要求と D1 の書き込みが、どちらも 1 日 10 万である。値の正本は共有の CLOUD_FREE_LIMITS。 */
export type QuotaLimits = { d1Writes: number; requests: number };
export const QUOTA_LIMITS: QuotaLimits = { d1Writes: CLOUD_FREE_LIMITS.d1RowsPerDay, requests: CLOUD_FREE_LIMITS.workersRequestsPerDay };
```
（元の 1 行目の `import type { SyncStateKey, SyncStateStore } from './state.ts';` は上の形に含めたので重ねない。）

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/shared/src/cloud.test.ts && npx vitest run packages/server/src/sync/quota.test.ts && npm run typecheck --workspaces --if-present 2>&1 | tail -5`
Expected: PASS、型検査 0 件

- [ ] **Step 5: コミット**

```bash
git commit packages/shared/src/cloud.ts packages/shared/src/cloud.test.ts packages/shared/src/api.ts packages/shared/src/events.ts packages/server/src/sync/quota.ts -m "feat(shared): cloud usage types and free-tier limits"
```

---

### Task 2: Worker が Cloudflare の三つの口をまとめる（collectUsage）

**Files:**
- Create: `packages/cloud/src/usage.ts`
- Create: `packages/cloud/test/fixtures/billable-usage.json`、`graphql-today.json`、`subscriptions.json`（`docs/superpowers/specs/2026-10-02-cloud-usage/fixtures/` から写す）
- Test: `packages/cloud/test/usage.test.ts`

**Interfaces:**
- Consumes: `CloudUsageBody`、`CloudUsagePart`（Task 1）
- Produces:
  - `collectUsage(d: { token: string; accountId: string; fetch: typeof fetch; now: number }): Promise<Extract<CloudUsageBody, { configured: true }>>`
  - `resetUsageMemo(): void`（試験用）
  - `TODAY_TTL_MS = 300_000`、`BILLING_TTL_MS = 21_600_000`
  - `INVALID_TOKEN_MESSAGE = 'トークンが無効です。setup cloud --usage-token で入れ直してください'`

- [ ] **Step 1: 原本を写す**

```bash
mkdir -p packages/cloud/test/fixtures
cp docs/superpowers/specs/2026-10-02-cloud-usage/fixtures/{billable-usage,graphql-today,subscriptions}.json packages/cloud/test/fixtures/
```

- [ ] **Step 2: 失敗する試験を書く**

`packages/cloud/test/usage.test.ts`:

```ts
import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { BILLING_TTL_MS, collectUsage, INVALID_TOKEN_MESSAGE, resetUsageMemo, TODAY_TTL_MS } from '../src/usage.ts';

const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const TOKEN = 'tok-secret-value';
const ACC = '0123456789abcdef0123456789abcdef';
// 原本の GraphQL は 2026-09-28〜10-02 の行を持つ。10-01 を「今日」にすると 51,249 行と 11,245 回になる。
const NOW = Date.parse('2026-10-01T06:00:00Z');

type Call = { url: string; init: RequestInit };
function cf(over: Partial<Record<'graphql' | 'subscriptions' | 'billable', () => Response>> = {}) {
  const calls: Call[] = [];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith('/graphql')) return over.graphql?.() ?? json(fixture('graphql-today'));
    if (url.endsWith('/subscriptions')) return over.subscriptions?.() ?? json(fixture('subscriptions'));
    if (url.endsWith('/billable-usage')) return over.billable?.() ?? json(fixture('billable-usage'));
    return json({ success: false, errors: [{ message: 'no route' }] }, 404);
  }) as typeof fetch;
  return { fetch: f, calls };
}

beforeEach(() => resetUsageMemo());

describe('collectUsage', () => {
  it('実物の原本から、今日の数とプランと今月をまとめる', async () => {
    const { fetch } = cf();
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    expect(u.configured).toBe(true);
    expect(u.today).toEqual({ day: '2026-10-01', d1RowsWritten: 51249, workersRequests: 11245 });
    expect(u.plan).toEqual({ workersPaid: false, items: [{ id: 'r2_paid', name: 'R2 Paid', priceUsd: 0, frequency: 'monthly' }], periodStart: '2026-09-05T00:50:22Z', periodEnd: '2026-10-05T00:00:00Z' });
    expect(u.month?.billedUsd).toBe(0);
    expect(u.month?.currency).toBe('USD');
    expect(u.month?.periodStart).toBe('2026-09-05T00:00:00Z');
    // 最新の ChargePeriodEnd は 10-01 00:00 UTC なので、反映済みは 9/30 分まで。
    expect(u.month?.throughDay).toBe('2026-09-30');
    expect(u.month?.services.map((s) => s.name).sort()).toEqual([
      'R2 Data Storage (First 10GB-Month included)',
      'R2 Storage Class A Operations (First 1M included)',
      'R2 Storage Class B Operations (First 10M included)',
    ]);
    const classA = u.month!.services.find((s) => s.name.startsWith('R2 Storage Class A'))!;
    expect(classA).toEqual({ family: 'R2', name: 'R2 Storage Class A Operations (First 1M included)', consumed: 6470, unit: 'Count', billedUsd: 0 });
    expect(u.errors).toEqual([]);
  });

  it('トークンは Authorization にだけ載せ、URL に出さない', async () => {
    const { fetch, calls } = cf();
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN);
      expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('一つが落ちても、残りは返す（200 で success: false）', async () => {
    const { fetch } = cf({ billable: () => new Response(JSON.stringify({ success: false, errors: [{ message: 'boom' }] }), { status: 200 }) });
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    expect(u.month).toBeNull();
    expect(u.today).not.toBeNull();
    expect(u.plan).not.toBeNull();
    expect(u.errors).toEqual([{ part: 'month', message: 'Cloudflare が誤りを返しました' }]);
  });

  it('GraphQL が 200 で errors を返したら today だけ null', async () => {
    const { fetch } = cf({ graphql: () => new Response(JSON.stringify({ data: null, errors: [{ message: 'x' }] }), { status: 200 }) });
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    expect(u.today).toBeNull();
    expect(u.errors).toEqual([{ part: 'today', message: 'Cloudflare が誤りを返しました' }]);
  });

  it('今日の行が無ければ 0', async () => {
    const { fetch } = cf();
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: Date.parse('2026-10-10T00:00:00Z') });
    expect(u.today).toEqual({ day: '2026-10-10', d1RowsWritten: 0, workersRequests: 0 });
  });

  it('401 と 403 は三つとも null にし、入れ直しを促す。応答の生の文は載せない', async () => {
    const deny = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
    const { fetch } = cf({ graphql: deny, subscriptions: deny, billable: deny });
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    expect([u.today, u.plan, u.month]).toEqual([null, null, null]);
    expect(u.errors.map((e) => e.message)).toEqual([INVALID_TOKEN_MESSAGE, INVALID_TOKEN_MESSAGE, INVALID_TOKEN_MESSAGE]);
    expect(JSON.stringify(u)).not.toContain('Authentication error');
  });

  it('届かなかったときも部分ごとに畳む', async () => {
    const f = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch: f, now: NOW });
    expect(u.errors.map((e) => e.message)).toEqual(['Cloudflare に届きませんでした', 'Cloudflare に届きませんでした', 'Cloudflare に届きませんでした']);
  });

  it('写しは今日の数が 5 分、プランと請求が 6 時間', async () => {
    const { fetch, calls } = cf();
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW + TODAY_TTL_MS - 1 });
    expect(calls).toHaveLength(3);
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW + TODAY_TTL_MS });
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['graphql', 'subscriptions', 'billable-usage', 'graphql']);
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW + BILLING_TTL_MS });
    expect(calls).toHaveLength(7);
  });

  it('失敗は写さない（次の要求で取り直す）', async () => {
    let fail = true;
    const { fetch, calls } = cf({ billable: () => (fail ? new Response('{}', { status: 500 }) : new Response(fs.readFileSync(new URL('./fixtures/billable-usage.json', import.meta.url), 'utf8'))) });
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    fail = false;
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW + 1000 });
    expect(u.month).not.toBeNull();
    expect(calls.filter((c) => c.url.endsWith('/billable-usage'))).toHaveLength(2);
  });

  it('fetchedAt は写しを取った時刻', async () => {
    const { fetch } = cf();
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW + 60_000 });
    expect(u.fetchedAt).toBe(NOW);
  });
});
```

- [ ] **Step 3: 落ちることを確かめる**

Run: `npx vitest run packages/cloud/test/usage.test.ts`
Expected: FAIL（`../src/usage.ts` が無い）

- [ ] **Step 4: 実装する**

`packages/cloud/src/usage.ts`:

```ts
import type { CloudUsageBody, CloudUsagePart } from '@agent-hangar/shared';

/**
 * Cloudflare の使用量と費用を、読み取り専用のトークンで取ってまとめる。
 * 設計は docs/superpowers/specs/2026-10-02-cloud-usage-design.md の「1. Worker」。
 *
 * D1 にも R2 にも書かない（書けば、数えている書き込みそのものが増える）。
 * 写しは isolate のメモリに置く。isolate が替われば取り直すだけで、正しさには響かない。
 */
type Configured = Extract<CloudUsageBody, { configured: true }>;
type Today = NonNullable<Configured['today']>;
type Plan = NonNullable<Configured['plan']>;
type Month = NonNullable<Configured['month']>;

export const TODAY_TTL_MS = 5 * 60_000;
export const BILLING_TTL_MS = 6 * 3_600_000;
export const INVALID_TOKEN_MESSAGE = 'トークンが無効です。setup cloud --usage-token で入れ直してください';
const API = 'https://api.cloudflare.com/client/v4';

/** 外へ出す理由は一般化した 1 文だけにする。Cloudflare の生の応答には内側の様子が出る。 */
class PartError extends Error {}
const failed = (status: number): PartError => new PartError(status === 401 || status === 403 ? INVALID_TOKEN_MESSAGE : 'Cloudflare が誤りを返しました');

type Memo<T> = { at: number; value: T };
const memo: { today?: Memo<Today> & { day: string }; plan?: Memo<Plan>; month?: Memo<Month> } = {};
export function resetUsageMemo(): void { delete memo.today; delete memo.plan; delete memo.month; }

type Deps = { token: string; accountId: string; fetch: typeof fetch; now: number };

async function call(d: Deps, path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await d.fetch(`${API}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${d.token}` } });
  } catch {
    throw new PartError('Cloudflare に届きませんでした');
  }
  if (!res.ok) throw failed(res.status);
  let body: { success?: unknown; errors?: unknown[]; data?: unknown };
  try { body = (await res.json()) as typeof body; } catch { throw failed(500); }
  if (body.success === false || (Array.isArray(body.errors) && body.errors.length > 0 && body.data == null)) throw failed(200);
  return body;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

async function fetchToday(d: Deps): Promise<Today> {
  const day = dayOf(d.now);
  // 日の次元を付けて引き、その日の行だけを足す。範囲で引くと、応答に他の日の行が混ざりうる（原本は 5 日分を持つ）。
  const query = `query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:10,filter:{date_geq:$d,date_leq:$d}){sum{rowsWritten} dimensions{date}} workersInvocationsAdaptive(limit:10,filter:{date_geq:$d,date_leq:$d}){sum{requests} dimensions{date}}}}}`;
  type Row<K extends string> = { sum?: Partial<Record<K, number>>; dimensions?: { date?: string } };
  const body = (await call(d, '/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { a: d.accountId, d: day } }) })) as {
    data?: { viewer?: { accounts?: { d1AnalyticsAdaptiveGroups?: Row<'rowsWritten'>[]; workersInvocationsAdaptive?: Row<'requests'>[] }[] } };
  };
  const acc = body.data?.viewer?.accounts?.[0];
  if (!acc) throw failed(200);
  const sum = <K extends string>(rows: Row<K>[] | undefined, key: K): number => (rows ?? []).filter((r) => r.dimensions?.date === day).reduce((n, r) => n + (Number(r.sum?.[key]) || 0), 0);
  return { day, d1RowsWritten: sum(acc.d1AnalyticsAdaptiveGroups, 'rowsWritten'), workersRequests: sum(acc.workersInvocationsAdaptive, 'requests') };
}

async function fetchPlan(d: Deps): Promise<Plan> {
  const body = (await call(d, `/accounts/${d.accountId}/subscriptions`)) as {
    result?: { rate_plan?: { id?: string; public_name?: string }; price?: number; frequency?: string | null; current_period_start?: string; current_period_end?: string }[];
  };
  const subs = body.result ?? [];
  return {
    workersPaid: subs.some((s) => s.rate_plan?.id === 'workers_paid'),
    items: subs.map((s) => ({ id: s.rate_plan?.id ?? '', name: s.rate_plan?.public_name ?? s.rate_plan?.id ?? '', priceUsd: Number(s.price) || 0, frequency: s.frequency ?? null })),
    periodStart: subs[0]?.current_period_start ?? null,
    periodEnd: subs[0]?.current_period_end ?? null,
  };
}

async function fetchMonth(d: Deps): Promise<Month> {
  const body = (await call(d, `/accounts/${d.accountId}/billable-usage`)) as {
    result?: { ServiceName: string; ServiceFamilyName: string; ConsumedQuantity: number; PricingUnit?: string; ConsumedUnit?: string; BilledCost: number; BillingCurrency: string; BillingPeriodStart: string; ChargePeriodEnd: string }[];
  };
  const rows = body.result ?? [];
  const by = new Map<string, Month['services'][number]>();
  for (const r of rows) {
    const s = by.get(r.ServiceName) ?? { family: r.ServiceFamilyName, name: r.ServiceName, consumed: 0, unit: r.PricingUnit || r.ConsumedUnit || '', billedUsd: 0 };
    s.consumed += Number(r.ConsumedQuantity) || 0;
    s.billedUsd += Number(r.BilledCost) || 0;
    by.set(r.ServiceName, s);
  }
  const lastEnd = rows.reduce<string | null>((m, r) => (m === null || r.ChargePeriodEnd > m ? r.ChargePeriodEnd : m), null);
  // ChargePeriodEnd は区間の終わり（含まない）なので、反映済みはその前日である。
  const throughDay = lastEnd ? dayOf(Date.parse(lastEnd) - 1) : null;
  return {
    periodStart: rows[0]?.BillingPeriodStart ?? '',
    throughDay,
    billedUsd: [...by.values()].reduce((n, s) => n + s.billedUsd, 0),
    currency: rows[0]?.BillingCurrency ?? 'USD',
    services: [...by.values()],
  };
}

/** 写しが生きていればそれを、無ければ取り直す。失敗は写さない。 */
async function part<T>(name: CloudUsagePart, slot: Memo<T> | undefined, fresh: boolean, load: () => Promise<T>, save: (m: Memo<T>) => void, now: number, errors: Configured['errors']): Promise<{ value: T | null; at: number | null }> {
  if (slot && fresh) return { value: slot.value, at: slot.at };
  try {
    const value = await load();
    save({ at: now, value });
    return { value, at: now };
  } catch (e) {
    errors.push({ part: name, message: e instanceof PartError ? e.message : 'Cloudflare が誤りを返しました' });
    return { value: null, at: null };
  }
}

export async function collectUsage(d: Deps): Promise<Configured> {
  const errors: Configured['errors'] = [];
  const day = dayOf(d.now);
  const [today, plan, month] = await Promise.all([
    part('today', memo.today, !!memo.today && memo.today.day === day && d.now - memo.today.at < TODAY_TTL_MS, () => fetchToday(d), (m) => { memo.today = { ...m, day }; }, d.now, errors),
    part('plan', memo.plan, !!memo.plan && d.now - memo.plan.at < BILLING_TTL_MS, () => fetchPlan(d), (m) => { memo.plan = m; }, d.now, errors),
    part('month', memo.month, !!memo.month && d.now - memo.month.at < BILLING_TTL_MS, () => fetchMonth(d), (m) => { memo.month = m; }, d.now, errors),
  ]);
  // 部分ごとの順に並べる（Promise.all の中で push される順は決まらない）。
  const order: CloudUsagePart[] = ['today', 'plan', 'month'];
  errors.sort((a, b) => order.indexOf(a.part) - order.indexOf(b.part));
  const ats = [today.at, plan.at, month.at].filter((v): v is number => v !== null);
  return { configured: true, fetchedAt: ats.length ? Math.min(...ats) : d.now, today: today.value, plan: plan.value, month: month.value, errors };
}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run packages/cloud/test/usage.test.ts`
Expected: PASS（10 件）

- [ ] **Step 6: コミット**

```bash
git add packages/cloud/test/fixtures
git commit packages/cloud/src/usage.ts packages/cloud/test/usage.test.ts packages/cloud/test/fixtures -m "feat(cloud): collect usage, plan and billing from the Cloudflare API"
```

---

### Task 3: Worker の口 `GET /usage`

**Files:**
- Modify: `packages/cloud/src/env.ts:15`
- Modify: `packages/cloud/src/index.ts`（経路と認証の一覧）
- Modify: `packages/cloud/test/harness.ts`（束縛と外向きの fetch を差し替えられるようにする）
- Test: `packages/cloud/test/usage-route.test.ts`

**Interfaces:**
- Consumes: `collectUsage`（Task 2）
- Produces: `GET /usage`（端末トークンが要る）→ `CloudUsageBody`。`Env` に `USAGE_API_TOKEN?: string; CF_ACCOUNT_ID?: string`。`startCloud({ bindings?, outbound? })`

- [ ] **Step 1: harness を広げる**

`packages/cloud/test/harness.ts` の `startCloud` を次の形に変える（既存の呼び出し `startCloud()` と `startCloud({ JOIN_SECRET_HASH })` はそのまま通る）。

```ts
export async function startCloud(options: { JOIN_SECRET_HASH?: string; bindings?: Record<string, string>; outbound?: (req: Request) => Response | Promise<Response> } = {}): Promise<CloudHarness> {
  const script = await workerScript();
  const joinSecretHash = options.JOIN_SECRET_HASH ?? '';
  const mf = new Miniflare({
    modules: true,
    script,
    scriptPath: BUNDLE_PATH,
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    r2Buckets: ['BUCKET'],
    bindings: { JOIN_SECRET_HASH: joinSecretHash, ...options.bindings },
    // Worker から外への fetch を受ける。渡さなければ外へは出ない（試験は実物の Cloudflare に触らない）。
    outboundService: options.outbound ?? (() => new Response('outbound fetch is not allowed in tests', { status: 599 })),
  });
```
（`env` と戻り値はそのまま。）

- [ ] **Step 2: 失敗する試験を書く**

`packages/cloud/test/usage-route.test.ts`:

```ts
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const fixture = (n: string) => fs.readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8');
const SECRET = 'join-secret-1';
let cloud: CloudHarness;
afterEach(async () => { await cloud.dispose(); });

async function joined(o: Parameters<typeof startCloud>[0] = {}): Promise<string> {
  resetSchemaCache();
  cloud = await startCloud(o);
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  const r = await cloud.SELF.fetch('https://x/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET, device: { id: 'dev-a', name: 'Mac', platform: 'darwin' } }) });
  return ((await r.json()) as { deviceToken: string }).deviceToken;
}

const outbound = (req: Request): Response => {
  const p = new URL(req.url).pathname;
  const body = p.endsWith('/graphql') ? fixture('graphql-today') : p.endsWith('/subscriptions') ? fixture('subscriptions') : p.endsWith('/billable-usage') ? fixture('billable-usage') : '{}';
  return new Response(body, { headers: { 'content-type': 'application/json' } });
};

describe('GET /usage', () => {
  it('端末トークンが無ければ 401', async () => {
    await joined();
    expect((await cloud.SELF.fetch('https://x/usage')).status).toBe(401);
  });

  it('トークンの secret が無ければ configured: false で、外へは出ない', async () => {
    let out = 0;
    const token = await joined({ outbound: () => { out++; return new Response('{}'); } });
    const r = await cloud.SELF.fetch('https://x/usage', { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ configured: false });
    expect(out).toBe(0);
  });

  it('secret があれば三つをまとめて返し、D1 には 1 行も書かない', async () => {
    const token = await joined({ bindings: { USAGE_API_TOKEN: 'tok', CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' }, outbound });
    const count = async () => {
      const t = await cloud.env.DB.prepare("select (select count(*) from meta) m, (select coalesce(sum(last_seen_at), 0) from devices) d").first<{ m: number; d: number }>();
      return t;
    };
    const before = await count();
    const r = await cloud.SELF.fetch('https://x/usage', { headers: { authorization: `Bearer ${token}` } });
    const body = (await r.json()) as { configured: boolean; plan: { items: { id: string }[] }; month: { services: unknown[] } };
    expect(body.configured).toBe(true);
    expect(body.plan.items[0]!.id).toBe('r2_paid');
    expect(body.month.services).toHaveLength(3);
    expect(await count()).toEqual(before);
  });

  it('応答に API トークンを載せない', async () => {
    const token = await joined({ bindings: { USAGE_API_TOKEN: 'tok-should-not-leak', CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' }, outbound });
    const text = await (await cloud.SELF.fetch('https://x/usage', { headers: { authorization: `Bearer ${token}` } })).text();
    expect(text).not.toContain('tok-should-not-leak');
  });
});
```

- [ ] **Step 3: 落ちることを確かめる**

Run: `npx vitest run packages/cloud/test/usage-route.test.ts`
Expected: FAIL（`/usage` が 404）

- [ ] **Step 4: 実装する**

`packages/cloud/src/env.ts` の `Env` を置き換える。

```ts
/**
 * Worker の束縛である。`JOIN_SECRET_HASH`、`USAGE_API_TOKEN`、`CF_ACCOUNT_ID` は wrangler の secret で入れる。
 * USAGE_API_TOKEN は読み取り専用（Billing Read、Account Analytics Read）の API トークンで、無ければ /usage は configured: false を返す。
 */
export type Env = { DB: D1Database; BUCKET: R2Bucket; JOIN_SECRET_HASH?: string; USAGE_API_TOKEN?: string; CF_ACCOUNT_ID?: string };
```

`packages/cloud/src/index.ts`：import に `import { collectUsage } from './usage.ts';` を足し、認証の一覧と経路に足す。

```ts
app.use('/usage', authMiddleware());
```
（`/files/*` の行の後ろ。）

```ts
// 使用量と費用。トークンの secret が無ければ外へ出ずに configured: false を返す。D1 には書かない。
app.get('/usage', async (c) => {
  const token = c.env.USAGE_API_TOKEN?.trim();
  const accountId = c.env.CF_ACCOUNT_ID?.trim();
  if (!token || !accountId) return c.json({ configured: false });
  return c.json(await collectUsage({ token, accountId, fetch: (input, init) => fetch(input, init), now: Date.now() }));
});
```
（`app.route('/files', filesApp);` の後ろ。）

- [ ] **Step 5: workers.dev で Cache API が効くかの確認を記録する**

仕様は「workers.dev では Cache API が効かない」と理解して isolate のメモリを使う。Cloudflare の文書（Workers の Cache API の頁）で確かめ、結果を `packages/cloud/src/usage.ts` の頭の注記に 1 行で足す（効かないなら「workers.dev では Cache API が効かない（文書の URL）」、効くなら「効くが、isolate のメモリで足りるので使わない」）。

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run packages/cloud`
Expected: PASS（既存の試験も含めて全部）

- [ ] **Step 7: コミット**

```bash
git commit packages/cloud/src/env.ts packages/cloud/src/index.ts packages/cloud/src/usage.ts packages/cloud/test/harness.ts packages/cloud/test/usage-route.test.ts -m "feat(cloud): GET /usage behind device auth"
```

---

### Task 4: 端末の client に `usage()` を足す

**Files:**
- Modify: `packages/server/src/sync/client.ts:123-132`（interface）、`HttpCloudClient`（218 行あたり）
- Modify: `packages/server/src/server.ts:125-139`（`countingClient`）
- Modify: `packages/server/test/fake-cloud.ts`（`FakeCloudClient`）
- Modify: `packages/server/src/sync/puller.test.ts`、`packages/server/src/sync/claudeConfig.test.ts`（`CloudClient` を手で組んでいる箇所に `usage` を足す）
- Test: `packages/server/src/sync/client.test.ts`

**Interfaces:**
- Consumes: `CloudUsageBody`（Task 1）
- Produces: `CloudClient.usage(): Promise<CloudUsageBody>`。404 は `{ configured: false }` として返す（古い Worker）。`FakeCloudClient.usageBody: CloudUsageBody`（既定 `{ configured: false }`）

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/sync/client.test.ts` の末尾に足す（ファイル冒頭の `fakeFetch` と `json` を使う）。

```ts
describe('usage', () => {
  it('GET /usage を Bearer 付きで叩いて返す', async () => {
    const { fetch, calls } = fakeFetch(() => json({ configured: false }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'dev-token', fetch });
    expect(await c.usage()).toEqual({ configured: false });
    expect(calls[0]!.url).toBe('https://w.example/usage');
    expect(bearerIs(calls[0]!, 'dev-token')).toBe(true);
  });
  it('古い Worker の 404 は configured: false として扱う', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'not found' }, 404));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 't', fetch });
    expect(await c.usage()).toEqual({ configured: false });
  });
  it('それ以外の失敗は CloudError のまま投げる', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'internal error' }, 500));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 't', fetch });
    await expect(c.usage()).rejects.toMatchObject({ name: 'CloudError', status: 500 });
  });
});
```

`packages/server/src/server.test.ts` か、`countingClient` の試験があるファイル（`grep -rn countingClient packages/server/src --include=*.test.ts` で探す）に足す。

```ts
it('usage は要求 1 回、行 0 として数える', async () => {
  const fake = new FakeCloudClient();
  const quota = new QuotaCounter({ state: new SyncStateStore(openTestDb()) });
  await countingClient(fake, quota).usage();
  expect(quota.today()).toEqual({ rows: 0, requests: 1 });
});
```
（`openTestDb` はそのファイルが使っている DB の作り方に合わせる。）

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/sync/client.test.ts`
Expected: FAIL（`usage` が無い）

- [ ] **Step 3: 実装する**

`client.ts` の import に `type CloudUsageBody` を足し、interface に足す。

```ts
  /** 使用量と費用。古い Worker（404）は configured: false として返す。 */
  usage(): Promise<CloudUsageBody>;
```

`HttpCloudClient` の `listFiles` の行の後ろに足す。

```ts
  async usage(): Promise<CloudUsageBody> {
    try {
      return await this.json<CloudUsageBody>('/usage');
    } catch (e) {
      if (e instanceof CloudError && e.status === 404) return { configured: false };
      throw e;
    }
  }
```

`server.ts` の `countingClient` の戻り値に足す。

```ts
    // 使用量は読むだけで、D1 には 1 行も書かない（Worker の /usage は認証の検査で読むだけ）。
    usage: () => note(0, inner.usage()),
```

`fake-cloud.ts` の `FakeCloudClient` に足す。

```ts
  /** GET /usage の応答。試験が差し替える。既定はトークンの無い Worker と同じ。 */
  usageBody: CloudUsageBody = { configured: false };

  async usage(): Promise<CloudUsageBody> {
    this.guard('usage');
    return structuredClone(this.usageBody);
  }
```

`puller.test.ts` と `claudeConfig.test.ts` で `CloudClient` を手で組んでいる箇所には `usage: async () => ({ configured: false })` を足す（型検査が場所を教える）。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/sync && npm run typecheck -w @agent-hangar/server`
Expected: PASS、型検査 0 件

- [ ] **Step 5: コミット**

```bash
git commit packages/server/src/sync/client.ts packages/server/src/sync/client.test.ts packages/server/src/server.ts packages/server/test/fake-cloud.ts packages/server/src/sync/puller.test.ts packages/server/src/sync/claudeConfig.test.ts -m "feat(server): cloud client usage()"
```
（countingClient の試験を足したファイルもパスに加える。）

---

### Task 5: 止めた理由を覚える

**Files:**
- Modify: `packages/server/src/sync/state.ts:9-20`（`SyncStateKey`）
- Modify: `packages/server/src/sync/engine.ts:169-188`（`status()`）、`:366-381`（`guardQuota`、`setPaused`）
- Modify: `packages/server/src/http/app.ts:589-596`（UI からの一時停止は `user`）
- Test: `packages/server/src/sync/engine.test.ts`

**Interfaces:**
- Produces: `SyncEngine.setPaused(paused: boolean, reason?: 'quota' | 'user'): void`（既定 `user`）。`status()` が `pausedReason` と `quotaPausedDay` を返す。

- [ ] **Step 1: 失敗する試験を書く**

`engine.test.ts` の、枠の 80% で止まる既存の試験の近くに足す（そのファイルの engine の作り方と、枠を縮める `quotaLimits` を使う）。

```ts
describe('止めた理由', () => {
  it('利用者が止めたら user、再開で消える', () => {
    const { engine } = makeEngine();
    engine.setPaused(true);
    expect(engine.status()).toMatchObject({ state: 'paused', pausedReason: 'user' });
    engine.setPaused(false);
    expect(engine.status().pausedReason).toBeNull();
  });
  it('無料枠の見張りが止めたら quota と、止めた UTC の日', async () => {
    const { engine, client } = makeEngine({ quotaLimits: { d1Writes: 10, requests: 1_000 }, now: () => Date.parse('2026-10-02T03:00:00Z') });
    await pushEnoughToExceed(engine, client);
    expect(engine.status()).toMatchObject({ state: 'paused', pausedReason: 'quota', quotaPausedDay: '2026-10-02' });
  });
  it('古い状態（paused だけ）は user として読む', () => {
    const { engine, state } = makeEngine();
    state.set('paused', true);
    expect(engine.status().pausedReason).toBe('user');
  });
});
```
（`makeEngine` と `pushEnoughToExceed` は、このファイルの既存の「80% で止まる」試験が使っている組み立てを関数に括り出して使う。括り出しはこの Step に含める。）

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/sync/engine.test.ts -t 止めた理由`
Expected: FAIL（`pausedReason` が undefined）

- [ ] **Step 3: 実装する**

`state.ts` の `SyncStateKey` に `| 'pausedReason'` を足す。

`engine.ts` の `setPaused` を置き換える。

```ts
  /** reason は止めた理由。UI と CLI からは user、無料枠の見張りからは quota。再開すると消す。 */
  setPaused(paused: boolean, reason: 'quota' | 'user' = 'user'): void {
    this.state.set('paused', paused);
    this.state.set('pausedReason', paused ? reason : null);
    if (!paused && this.started && this.deps.client) { this.noteLocalChange(); this.enqueueWhileStarted(() => this.pullNow()); }
    this.emitStatus();
  }
```

`guardQuota` の `this.setPaused(true);` を `this.setPaused(true, 'quota');` にする。

`status()` の戻り値に足す。

```ts
      // 古いサーバが止めた状態は理由を持たない。利用者が止めたのと同じに読む。
      pausedReason: state === 'paused' ? ((this.state.get('pausedReason') as 'quota' | 'user' | null) ?? 'user') : null,
      quotaPausedDay: this.quota.pausedDay()?.replace(/^quota:/, '') ?? null,
```
（`pausedDay()` は `quota:2026-10-02` の形で持っているので、頭を落として日だけにする。）

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/sync packages/server/src/http`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git commit packages/server/src/sync/state.ts packages/server/src/sync/engine.ts packages/server/src/sync/engine.test.ts -m "feat(server): remember why sync was paused"
```

---

### Task 6: 使用量を取って配る（CloudUsagePoller）

**Files:**
- Create: `packages/server/src/sync/usage.ts`
- Modify: `packages/server/src/server.ts`（作って配線する。`engine.on` の近く）
- Modify: `packages/server/src/http/app.ts`（`AppDeps` に `cloudUsage`、`GET /api/sync/usage`、bootstrap）
- Test: `packages/server/src/sync/usage.test.ts`、`packages/server/src/http/app.test.ts`

**Interfaces:**
- Consumes: `CloudClient.usage()`（Task 4）、`QuotaCounter`（`d1()`、`today()`、`ratio`）、`SyncEngine.status()`（Task 5）、`CloudUsageDto`、`CLOUD_FREE_LIMITS`、`r2Included`（Task 1）
- Produces:
  - `USAGE_POLL_MS = 300_000`
  - `toUsageDto(body: CloudUsageBody | null, o: { quota: QuotaCounter; now: number; stale: boolean; lastGood: CloudUsageDto | null }): CloudUsageDto`
  - `class CloudUsagePoller { constructor(o: { client: CloudClient | null; quota: QuotaCounter; isPaused: () => boolean; broadcast: (u: CloudUsageDto) => void; now?: () => number; timers?: Timers }); start(): void; stop(): void; current(): CloudUsageDto | null; refresh(): Promise<CloudUsageDto | null> }`
  - `AppDeps.cloudUsage?: { current(): CloudUsageDto | null; refresh(): Promise<CloudUsageDto | null> }`
  - `GET /api/sync/usage[?refresh=1]` → `CloudUsageDto | null`

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/sync/usage.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { CloudUsageBody, CloudUsageDto } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { openDb } from '../db/open.ts';
import { QuotaCounter } from './quota.ts';
import { SyncStateStore } from './state.ts';
import { CloudUsagePoller, toUsageDto, USAGE_POLL_MS } from './usage.ts';

const NOW = Date.parse('2026-10-02T06:48:00Z');
const quota = () => new QuotaCounter({ state: new SyncStateStore(openDb(':memory:')), now: () => NOW });
const BODY: CloudUsageBody = {
  configured: true, fetchedAt: NOW - 120_000, errors: [],
  today: { day: '2026-10-02', d1RowsWritten: 23480, workersRequests: 4120 },
  plan: { workersPaid: false, items: [{ id: 'r2_paid', name: 'R2 Paid', priceUsd: 0, frequency: 'monthly' }], periodStart: '2026-09-05T00:50:22Z', periodEnd: '2026-10-05T00:00:00Z' },
  month: { periodStart: '2026-09-05T00:00:00Z', throughDay: '2026-09-30', billedUsd: 0, currency: 'USD', services: [
    { family: 'R2', name: 'R2 Data Storage (First 10GB-Month included)', consumed: 0.165, unit: 'GB-months', billedUsd: 0 },
    { family: 'R2', name: 'R2 Storage Class A Operations (First 1M included)', consumed: 6470, unit: 'Count', billedUsd: 0 },
    { family: 'R2', name: 'R2 Infrequent Access Data Retrieval', consumed: 3, unit: 'GB', billedUsd: 0 },
  ] },
};

describe('toUsageDto', () => {
  it('Cloudflare の数を、上限と込み量を添えて写す', () => {
    const d = toUsageDto(BODY, { quota: quota(), now: NOW, stale: false, lastGood: null });
    expect(d).toMatchObject({ source: 'cloudflare', fetchedAt: NOW - 120_000, stale: false, notice: null });
    expect(d.limits).toEqual({ d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000, stopRatio: 0.8 });
    expect(d.today).toEqual({ d1RowsWritten: 23480, workersRequests: 4120, resetAt: Date.parse('2026-10-03T00:00:00Z') });
    expect(d.plan).toEqual({ label: 'Workers 無料 · R2 従量', workersPaid: false });
    expect(d.month?.rows).toEqual([
      { label: 'R2 の保存', consumed: 0.165, unit: 'GB-月', included: 10 },
      { label: 'R2 の書く操作', consumed: 6470, unit: '回', included: 1_000_000 },
      { label: 'R2 Infrequent Access Data Retrieval', consumed: 3, unit: 'GB', included: null },
    ]);
    expect(d.month).toMatchObject({ periodStart: '2026-09-05T00:00:00Z', periodEnd: '2026-10-05T00:00:00Z', throughDay: '2026-09-30', billedUsd: 0 });
  });
  it('configured: false と null は見積もり', () => {
    const q = quota();
    q.note({ rows: 26700, requests: 3640 });
    for (const body of [{ configured: false } as const, null]) {
      const d = toUsageDto(body, { quota: q, now: NOW, stale: false, lastGood: null });
      expect(d).toMatchObject({ source: 'estimate', plan: null, month: null, today: { d1RowsWritten: 26700, workersRequests: 3640 } });
    }
  });
  it('トークンの失効は見積もりに落とし、文を添える', () => {
    const msg = 'トークンが無効です。setup cloud --usage-token で入れ直してください';
    const d = toUsageDto({ ...BODY, today: null, plan: null, month: null, errors: ['today', 'plan', 'month'].map((part) => ({ part: part as 'today', message: msg })) }, { quota: quota(), now: NOW, stale: false, lastGood: null });
    expect(d).toMatchObject({ source: 'estimate', notice: msg });
  });
  it('Workers Paid はプランの語を変える', () => {
    const d = toUsageDto({ ...BODY, plan: { ...BODY.plan!, workersPaid: true, items: [{ id: 'workers_paid', name: 'Workers Paid', priceUsd: 5, frequency: 'monthly' }] } }, { quota: quota(), now: NOW, stale: false, lastGood: null });
    expect(d.plan).toEqual({ label: 'Workers Paid', workersPaid: true });
  });
});

describe('CloudUsagePoller', () => {
  const setup = (o: { paused?: boolean } = {}) => {
    const client = new FakeCloudClient();
    client.usageBody = BODY;
    const sent: CloudUsageDto[] = [];
    let paused = o.paused ?? false;
    const p = new CloudUsagePoller({ client, quota: quota(), isPaused: () => paused, broadcast: (u) => sent.push(u), now: () => NOW });
    return { client, sent, p, setPaused: (v: boolean) => { paused = v; } };
  };
  it('refresh で取りに行き、配る', async () => {
    const { p, sent } = setup();
    const d = await p.refresh();
    expect(d?.source).toBe('cloudflare');
    expect(sent).toHaveLength(1);
    expect(p.current()).toEqual(d);
  });
  it('一時停止の間は取りに行かず、最後の値を返す', async () => {
    const { p, client, setPaused } = setup();
    await p.refresh();
    setPaused(true);
    const before = client.calls.length;
    const d = await p.refresh();
    expect(client.calls.length).toBe(before);
    expect(d?.source).toBe('cloudflare');
  });
  it('取れたあとの失敗は、最後の値に stale を付ける', async () => {
    const { p, client } = setup();
    await p.refresh();
    client.offline = true;
    const d = await p.refresh();
    expect(d).toMatchObject({ source: 'cloudflare', stale: true, today: { d1RowsWritten: 23480 } });
  });
  it('一度も取れないまま失敗したら見積もりで、stale', async () => {
    const { p, client } = setup();
    client.offline = true;
    expect(await p.refresh()).toMatchObject({ source: 'estimate', stale: true });
  });
  it('同期を設定していない端末は null', async () => {
    const p = new CloudUsagePoller({ client: null, quota: quota(), isPaused: () => false, broadcast: () => {}, now: () => NOW });
    expect(await p.refresh()).toBeNull();
  });
  it('start は 5 分ごとに取りに行き、stop で止まる', async () => {
    vi.useFakeTimers();
    try {
      const { p, client } = setup();
      p.start();
      await vi.advanceTimersByTimeAsync(0);
      const first = client.calls.filter((c) => c.method === 'usage').length;
      await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
      expect(client.calls.filter((c) => c.method === 'usage').length).toBe(first + 1);
      p.stop();
      await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3);
      expect(client.calls.filter((c) => c.method === 'usage').length).toBe(first + 1);
    } finally { vi.useRealTimers(); }
  });
});
```
（`openDb` の import 先は、`quota.test.ts` が DB を作っている方法に合わせて直す。）

`packages/server/src/http/app.test.ts` の sync の describe に足す（`baseDeps` に `cloudUsage` を足せる形にする）。

```ts
it('GET /api/sync/usage は今の値を、refresh=1 は取り直した値を返す', async () => {
  const dto = { source: 'estimate', fetchedAt: null, stale: false, notice: null, limits: { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000, stopRatio: 0.8 }, today: { d1RowsWritten: 1, workersRequests: 2, resetAt: 3 }, plan: null, month: null };
  const refreshed = { ...dto, today: { ...dto.today, d1RowsWritten: 9 } };
  const app = createApp({ ...baseDeps(), cloudUsage: { current: () => dto as never, refresh: async () => refreshed as never } });
  expect(await (await app.request('/api/sync/usage', auth())).json()).toEqual(dto);
  expect(await (await app.request('/api/sync/usage?refresh=1', auth())).json()).toEqual(refreshed);
});
it('cloudUsage が無いサーバの /api/sync/usage は null', async () => {
  const app = createApp(baseDeps());
  expect(await (await app.request('/api/sync/usage', auth())).json()).toBeNull();
});
```
（`baseDeps`、`auth` はこのファイルの既存の組み立てと鍵の付け方に合わせて名前を直す。）

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/sync/usage.test.ts packages/server/src/http/app.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/sync/usage.ts`:

```ts
import { CLOUD_FREE_LIMITS, r2Included, type CloudUsageBody, type CloudUsageDto } from '@agent-hangar/shared';
import type { CloudClient } from './client.ts';
import type { Timers } from './engine.ts';
import type { QuotaCounter } from './quota.ts';

/** 使用量を取りに行く間隔。1 台あたり 1 日 288 回で、Workers の枠の 0.3% にあたる。 */
export const USAGE_POLL_MS = 5 * 60_000;

const INVALID = 'トークンが無効です';
const nextUtcMidnight = (now: number): number => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
const UNIT: Record<string, string> = { 'GB-months': 'GB-月', Count: '回' };
const ROW_LABEL: [prefix: string, label: string][] = [
  ['R2 Data Storage', 'R2 の保存'],
  ['R2 Storage Class A Operations', 'R2 の書く操作'],
  ['R2 Storage Class B Operations', 'R2 の読む操作'],
];
const rowLabel = (name: string): string => ROW_LABEL.find(([p]) => name.startsWith(p))?.[1] ?? name;

function planLabel(p: NonNullable<Extract<CloudUsageBody, { configured: true }>['plan']>): string {
  if (p.workersPaid) return 'Workers Paid';
  const r2 = p.items.some((i) => i.id === 'r2_paid') ? ' · R2 従量' : '';
  return `Workers 無料${r2}`;
}

/** 見積もりの形。トークンが無い端末、古い Worker、一度も取れないまま失敗したときに使う。 */
function estimate(o: { quota: QuotaCounter; now: number; stale: boolean; notice: string | null }): CloudUsageDto {
  return {
    source: 'estimate', fetchedAt: null, stale: o.stale, notice: o.notice,
    limits: { d1RowsPerDay: CLOUD_FREE_LIMITS.d1RowsPerDay, workersRequestsPerDay: CLOUD_FREE_LIMITS.workersRequestsPerDay, stopRatio: o.quota.ratio },
    today: { d1RowsWritten: o.quota.d1().rows, workersRequests: o.quota.today().requests, resetAt: nextUtcMidnight(o.now) },
    plan: null, month: null,
  };
}

export function toUsageDto(body: CloudUsageBody | null, o: { quota: QuotaCounter; now: number; stale: boolean; lastGood: CloudUsageDto | null }): CloudUsageDto {
  if (body === null || !body.configured) return o.stale && o.lastGood ? { ...o.lastGood, stale: true } : estimate({ ...o, notice: null });
  const invalid = body.errors.find((e) => e.message.startsWith(INVALID));
  if (invalid && !body.today && !body.plan && !body.month) return estimate({ ...o, notice: invalid.message });
  const base = estimate({ ...o, notice: null });
  return {
    ...base,
    source: 'cloudflare',
    fetchedAt: body.fetchedAt,
    today: body.today ? { d1RowsWritten: body.today.d1RowsWritten, workersRequests: body.today.workersRequests, resetAt: base.today.resetAt } : (o.lastGood?.today ?? base.today),
    plan: body.plan ? { label: planLabel(body.plan), workersPaid: body.plan.workersPaid } : (o.lastGood?.plan ?? null),
    month: body.month
      ? {
          periodStart: body.month.periodStart, periodEnd: body.plan?.periodEnd ?? o.lastGood?.month?.periodEnd ?? null, throughDay: body.month.throughDay, billedUsd: body.month.billedUsd,
          rows: body.month.services.map((s) => ({ label: rowLabel(s.name), consumed: s.consumed, unit: UNIT[s.unit] ?? s.unit, included: r2Included(s.name) })),
        }
      : (o.lastGood?.month ?? null),
    stale: o.stale || body.errors.length > 0,
  };
}

// 呼ぶたびに大域の setInterval を引く。読み込み時に取り込むと、試験の偽の時計が効かない。
const REAL_TIMERS: Pick<Timers, 'setInterval' | 'clearInterval'> = {
  setInterval: ((fn: () => void, ms: number) => setInterval(fn, ms)) as typeof setInterval,
  clearInterval: ((t: ReturnType<typeof setInterval>) => clearInterval(t)) as typeof clearInterval,
};

/**
 * 使用量を取りに行き、画面へ配る。設計は仕様の「2. 端末のサーバ」。
 * 一時停止の間は外と話さない（決定 4）ので、最後の値を返すだけにする。
 */
export class CloudUsagePoller {
  private last: CloudUsageDto | null = null;
  private lastGood: CloudUsageDto | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<CloudUsageDto | null> | null = null;
  private readonly now: () => number;
  private readonly timers: Pick<Timers, 'setInterval' | 'clearInterval'>;

  constructor(private readonly o: { client: CloudClient | null; quota: QuotaCounter; isPaused: () => boolean; broadcast: (u: CloudUsageDto) => void; now?: () => number; timers?: Pick<Timers, 'setInterval' | 'clearInterval'> }) {
    this.now = o.now ?? (() => Date.now());
    this.timers = o.timers ?? REAL_TIMERS;
  }

  current(): CloudUsageDto | null { return this.last; }

  start(): void {
    if (!this.o.client || this.timer) return;
    void this.refresh();
    this.timer = this.timers.setInterval(() => { void this.refresh(); }, USAGE_POLL_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void { if (this.timer) { this.timers.clearInterval(this.timer); this.timer = null; } }

  refresh(): Promise<CloudUsageDto | null> {
    if (!this.o.client) return Promise.resolve(null);
    if (this.o.isPaused()) return Promise.resolve(this.last ?? this.publish(toUsageDto(null, { quota: this.o.quota, now: this.now(), stale: false, lastGood: null })));
    this.inflight ??= this.load().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(): Promise<CloudUsageDto> {
    const now = this.now();
    try {
      const body = await this.o.client!.usage();
      const dto = toUsageDto(body, { quota: this.o.quota, now, stale: false, lastGood: this.lastGood });
      if (dto.source === 'cloudflare' && !dto.stale) this.lastGood = dto;
      return this.publish(dto);
    } catch {
      // 同期は止めない。トーストも出さない。設定画面の出どころの文だけで知らせる。
      return this.publish(toUsageDto(null, { quota: this.o.quota, now, stale: true, lastGood: this.lastGood }));
    }
  }

  private publish(dto: CloudUsageDto): CloudUsageDto {
    this.last = dto;
    this.o.broadcast(dto);
    return dto;
  }
}
```

`packages/server/src/http/app.ts`：`AppDeps` に足す。

```ts
  /** 設定の「使用量と費用」。同期を設定していない端末と古い組み立てでは無い。 */
  cloudUsage?: { current(): CloudUsageDto | null; refresh(): Promise<CloudUsageDto | null> };
```

`/sync/focus` の行の後ろに足す。

```ts
  // 設定を開いたときは refresh=1 で取り直す。一時停止の間は取りに行かず、最後の値を返す（CloudUsagePoller が守る）。
  api.get('/sync/usage', async (c) => {
    if (!deps.cloudUsage) return c.json(null);
    return c.json(c.req.query('refresh') === '1' ? await deps.cloudUsage.refresh() : deps.cloudUsage.current());
  });
```

bootstrap の `body` に `cloudUsage: deps.cloudUsage?.current() ?? null,` を足す。import に `CloudUsageDto` を足す。

`packages/server/src/server.ts`：`const client = rawClient ? countingClient(...)` の後ろに作る。

```ts
  // 設定の「使用量と費用」。数える client を通すので、要求は無料枠の勘定に入る。
  const cloudUsage = new CloudUsagePoller({ client, quota: engine.quota, isPaused, broadcast: (usage) => hub.broadcast({ type: 'sync.usage', usage }) });
```

`createApp({...})` に `cloudUsage,` を足す。`void engine.start()...` の行（846 行あたり）の後ろに `cloudUsage.start();` を足す。

```ts
  // 一時停止が解けたら取り直す。止まっている間は取りに行かないので、画面の値が古いままになる。
  let wasPaused = isPaused();
```
（`engine.on({` の直前に置く。）`engine.on` の `status` を次に置き換える。

```ts
    status: (s) => {
      hub.broadcast({ type: 'sync.status', status: { ...s, skipped: syncSkipped(), sweepPending: syncSweep() } });
      const pausedNow = s.state === 'paused';
      if (wasPaused && !pausedNow) void cloudUsage.refresh();
      wasPaused = pausedNow;
    },
```
サーバの停止の処理（`retention.stop();` と `runs.stop();` が並んでいる所）に `cloudUsage.stop();` を足す。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run && npm run typecheck -w @agent-hangar/server`
Expected: PASS、型検査 0 件

- [ ] **Step 5: コミット**

```bash
git commit packages/server/src/sync/usage.ts packages/server/src/sync/usage.test.ts packages/server/src/server.ts packages/server/src/http/app.ts packages/server/src/http/app.test.ts -m "feat(server): poll cloud usage and serve it to the UI"
```

---

### Task 7: 画面へ届ける（API、store、presenter）

**Files:**
- Modify: `packages/ui/src/runtime/api.ts`（`syncUsage`）、`packages/ui/src/test/fakeApi.ts`
- Modify: `packages/ui/src/store/store.ts`（`cloudUsage`、`sync.usage`、bootstrap）
- Modify: `packages/ui/src/runtime/runtime.ts:414-422`（`api.loadSettingsExtras` で取り直す）
- Create: `packages/ui/src/presenters/cloudUsage.ts`
- Modify: `packages/ui/src/presenters/settings.ts`（`CloudSettingsProps.usage`）
- Test: `packages/ui/src/presenters/cloudUsage.test.ts`、`packages/ui/src/runtime/runtime.test.ts`

**Interfaces:**
- Consumes: `CloudUsageDto`、`SyncStatusBody.pausedReason`（Task 1、5）
- Produces:
  - `Api.syncUsage(refresh: boolean): Promise<CloudUsageDto | null>`
  - `Store.cloudUsage: CloudUsageDto | null`
  - `type CloudUsageTone = 'ok' | 'warn' | 'stop'`
  - `type CloudUsageProps`（下のコード）
  - `presentCloudUsage(u: CloudUsageDto | null, sync: SyncStatusBody | null, now: number, tz?: string): CloudUsageProps | null`
  - `CloudSettingsProps.usage: CloudUsageProps | null`

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/presenters/cloudUsage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CloudUsageDto, SyncStatusBody } from '@agent-hangar/shared';
import { presentCloudUsage } from './cloudUsage.ts';

const NOW = Date.parse('2026-10-02T06:48:00Z'); // 日本時間 15:48
const TZ = 'Asia/Tokyo';
const base: CloudUsageDto = {
  source: 'cloudflare', fetchedAt: NOW - 120_000, stale: false, notice: null,
  limits: { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000, stopRatio: 0.8 },
  today: { d1RowsWritten: 23480, workersRequests: 4120, resetAt: Date.parse('2026-10-03T00:00:00Z') },
  plan: { label: 'Workers 無料 · R2 従量', workersPaid: false },
  month: { periodStart: '2026-09-05T00:00:00Z', periodEnd: '2026-10-05T00:00:00Z', throughDay: '2026-09-30', billedUsd: 0, rows: [
    { label: 'R2 の保存', consumed: 0.165, unit: 'GB-月', included: 10 },
    { label: 'R2 の書く操作', consumed: 6470, unit: '回', included: 1_000_000 },
    { label: 'R2 Infrequent Access Data Retrieval', consumed: 3, unit: 'GB', included: null },
  ] },
};
const sync = (o: Partial<SyncStatusBody> = {}): SyncStatusBody => ({ state: 'idle', url: 'https://w', lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 1, claudeConfig: { enabled: false, confirmed: false }, skipped: [], sweepPending: 0, ...o });

describe('presentCloudUsage', () => {
  it('ふだん：札 3 枚と棒（今日 2、区切り、今月）', () => {
    const p = presentCloudUsage(base, sync(), NOW, TZ)!;
    expect(p.tiles).toEqual([
      { key: 'bill', label: '今月の請求', value: '$0.00', sub: '9/30 分まで', tone: 'ok' },
      { key: 'd1', label: 'D1 の書き込み（今日）', value: '23%', sub: '23,480 行', tone: 'ok' },
      { key: 'plan', label: 'プラン', value: 'Workers 無料', sub: 'R2 従量', tone: 'ok' },
    ]);
    expect(p.bars.map((b) => [b.label, b.when, b.pct, b.tickPct, b.value, b.tone])).toEqual([
      ['D1 の書き込み', '今日', 23.48, 80, '23,480 / 100,000 行', 'ok'],
      ['Workers の要求', '今日', 4.12, 80, '4,120 / 100,000 回', 'ok'],
      ['R2 の保存', '今月', 1.65, null, '0.17 / 10 GB-月', 'ok'],
      ['R2 の書く操作', '今月', 0.65, null, '6,470 / 100 万回', 'ok'],
      ['R2 Infrequent Access Data Retrieval', '今月', null, null, '3 GB', 'ok'],
    ]);
    expect(p.splitAfter).toBe(2);
    expect(p.legend).toEqual(['今日の枠は 9:00 に戻る · 目盛りの 80% で同期を止める', '今月は 9/5〜10/5']);
    expect(p.source).toBe('Cloudflare の数 · 2 分前');
    expect(p.strip).toBeNull();
    expect(p.command).toBeNull();
  });
  it('止まりそう：止める線の 75%（6 万行）以上で注意の色と残りの行数', () => {
    const p = presentCloudUsage({ ...base, today: { ...base.today, d1RowsWritten: 68120 } }, sync(), NOW, TZ)!;
    expect(p.tiles[1]).toMatchObject({ value: '68%', tone: 'warn' });
    expect(p.bars[0]!.tone).toBe('warn');
    expect(p.legend[0]).toBe('あと 11,880 行で同期を止めます · 9:00 に戻る');
  });
  it('無料枠で停止中：止まった色と再開の帯。Cloudflare の数が 80% 未満なら食い違いを添える', () => {
    const p = presentCloudUsage({ ...base, today: { ...base.today, d1RowsWritten: 58590 } }, sync({ state: 'paused', pausedReason: 'quota', quotaPausedDay: '2026-10-02' }), NOW, TZ)!;
    expect(p.tiles[1]!.tone).toBe('stop');
    expect(p.bars[0]!.tone).toBe('stop');
    expect(p.strip).toEqual({ tone: 'stop', text: '無料枠の 80% に届いたので同期を止めました（Cloudflare の数では 59%）。9:00 に枠が戻ります。戻ったあと「同期を再開」で再開できます。' });
  });
  it('停止中で枠が戻った後は、戻ったと言う', () => {
    const p = presentCloudUsage(base, sync({ state: 'paused', pausedReason: 'quota', quotaPausedDay: '2026-10-01' }), NOW, TZ)!;
    expect(p.strip?.text).toBe('無料枠の 80% に届いたので同期を止めました。枠は戻っています。「同期を再開」で再開できます。');
  });
  it('手で止めたときは帯を出さない', () => {
    expect(presentCloudUsage(base, sync({ state: 'paused', pausedReason: 'user' }), NOW, TZ)!.strip).toBeNull();
  });
  it('トークンなし：見積もりの札と棒、案内とコマンド', () => {
    const p = presentCloudUsage({ ...base, source: 'estimate', fetchedAt: null, plan: null, month: null, today: { ...base.today, d1RowsWritten: 26700, workersRequests: 3640 } }, sync(), NOW, TZ)!;
    expect(p.tiles).toEqual([
      { key: 'bill', label: '今月の請求', value: '—', sub: 'トークンが要ります', tone: 'muted' },
      { key: 'd1', label: 'D1 の書き込み（今日）', value: '約 27%', sub: '見積もり', tone: 'ok' },
      { key: 'plan', label: 'プラン', value: '—', sub: 'トークンが要ります', tone: 'muted' },
    ]);
    expect(p.bars.map((b) => b.value)).toEqual(['約 26,700 / 100,000 行', 'この PC 3,640 回']);
    expect(p.source).toBe('hangar の見積もり（実際より 1〜4 割多め）');
    expect(p.strip).toEqual({ tone: 'info', text: 'Cloudflare の正確な数、R2、今月の費用は、読み取り専用のトークンを入れると出ます。' });
    expect(p.command).toBe('npm run hangar -- setup cloud --usage-token');
  });
  it('トークンの失効は案内の帯をその文に替える', () => {
    const msg = 'トークンが無効です。setup cloud --usage-token で入れ直してください';
    const p = presentCloudUsage({ ...base, source: 'estimate', fetchedAt: null, plan: null, month: null, notice: msg }, sync(), NOW, TZ)!;
    expect(p.strip).toEqual({ tone: 'info', text: msg });
  });
  it('取れなかった：最後の値と時刻と失敗', () => {
    const p = presentCloudUsage({ ...base, stale: true, fetchedAt: Date.parse('2026-10-02T05:02:00Z') }, sync(), NOW, TZ)!;
    expect(p.source).toBe('Cloudflare の数 · 14:02 · 取得に失敗');
  });
  it('Workers Paid：今日の札と棒を出さない', () => {
    const p = presentCloudUsage({ ...base, plan: { label: 'Workers Paid', workersPaid: true } }, sync(), NOW, TZ)!;
    expect(p.tiles.map((t) => t.key)).toEqual(['bill', 'plan']);
    expect(p.bars.every((b) => b.when === '今月')).toBe(true);
    expect(p.splitAfter).toBe(0);
  });
  it('使用量がまだ届いていなければ null', () => {
    expect(presentCloudUsage(null, sync(), NOW, TZ)).toBeNull();
  });
});
```

`runtime.test.ts` の設定を開いたときの試験（`api.loadSettingsExtras` を見ている箇所）に足す。

```ts
it('設定を開くと使用量を取り直す', async () => {
  // このファイルの組み立てで、loadSettingsExtras の効果を流す
  // fakeApi.syncUsage が refresh=true で呼ばれ、store.cloudUsage に入ることを確かめる
});
```
（このファイルの既存の `loadSettingsExtras` の試験と同じ書き方で、`expect(api.calls).toContainEqual(['syncUsage', true])` と `expect(store.cloudUsage).toEqual(DTO)` を確かめる形にする。）

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/cloudUsage.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/presenters/cloudUsage.ts`:

```ts
import type { CloudUsageDto, SyncStatusBody } from '@agent-hangar/shared';
import { relativeTime } from './format.ts';

export type CloudUsageTone = 'ok' | 'warn' | 'stop';
export type CloudUsageTile = { key: 'bill' | 'd1' | 'plan'; label: string; value: string; sub: string; tone: CloudUsageTone | 'muted' };
export type CloudUsageBar = { label: string; when: '今日' | '今月'; pct: number | null; tickPct: number | null; value: string; tone: CloudUsageTone };
/** 設定の「使用量と費用」。試作 usage-merged.html の左上が正本。 */
export type CloudUsageProps = { tiles: CloudUsageTile[]; bars: CloudUsageBar[]; splitAfter: number; legend: string[]; source: string; strip: { tone: 'stop' | 'info'; text: string } | null; command: string | null };

/** 止める線の何割で注意の色にするか（仕様の決めずに置いた値）。 */
const WARN_OF_STOP = 0.75;
const TOKEN_COMMAND = 'npm run hangar -- setup cloud --usage-token';

const n = (v: number): string => v.toLocaleString('en-US');
const pct = (used: number, limit: number): number => Math.round((used / limit) * 10_000) / 100;
const hm = (ms: number, tz?: string): string => new Intl.DateTimeFormat('ja-JP', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(ms);
const md = (iso: string, tz?: string): string => new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', timeZone: tz }).format(Date.parse(iso)).replace(/月/, '/').replace(/日/, '');
const dayMd = (day: string): string => { const [, m, d] = day.split('-'); return `${Number(m)}/${Number(d)}`; };
const compact = (v: number): string => (v >= 10_000 ? `${n(v / 10_000)} 万` : n(v));
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function amount(consumed: number, unit: string, included: number | null): string {
  const c = unit === 'GB-月' ? (Math.round(consumed * 100) / 100).toString() : n(consumed);
  if (included === null) return `${c} ${unit}`;
  return unit === '回' ? `${c} / ${compact(included)}回` : `${c} / ${n(included)} ${unit}`;
}

export function presentCloudUsage(u: CloudUsageDto | null, sync: SyncStatusBody | null, now: number, tz?: string): CloudUsageProps | null {
  if (!u) return null;
  const est = u.source === 'estimate';
  const stopLine = u.limits.d1RowsPerDay * u.limits.stopRatio;
  const d1 = u.today.d1RowsWritten;
  const quotaPaused = sync?.state === 'paused' && sync.pausedReason === 'quota';
  const tone: CloudUsageTone = quotaPaused ? 'stop' : d1 >= stopLine * WARN_OF_STOP ? 'warn' : 'ok';
  const reset = hm(u.today.resetAt, tz);
  const d1Pct = pct(d1, u.limits.d1RowsPerDay);
  const approx = est ? '約 ' : '';
  const paid = u.plan?.workersPaid ?? false;

  const tiles: CloudUsageTile[] = [
    u.month ? { key: 'bill', label: '今月の請求', value: `$${u.month.billedUsd.toFixed(2)}`, sub: u.month.throughDay ? `${dayMd(u.month.throughDay)} 分まで` : '', tone: 'ok' } : { key: 'bill', label: '今月の請求', value: '—', sub: 'トークンが要ります', tone: 'muted' },
    { key: 'd1', label: 'D1 の書き込み（今日）', value: `${approx}${Math.round(d1Pct)}%`, sub: est ? '見積もり' : `${n(d1)} 行`, tone },
    u.plan ? { key: 'plan', label: 'プラン', value: u.plan.label.split(' · ')[0]!, sub: u.plan.label.split(' · ')[1] ?? '', tone: 'ok' } : { key: 'plan', label: 'プラン', value: '—', sub: 'トークンが要ります', tone: 'muted' },
  ];
  const today: CloudUsageBar[] = paid ? [] : [
    { label: 'D1 の書き込み', when: '今日', pct: d1Pct, tickPct: u.limits.stopRatio * 100, value: `${approx}${n(d1)} / ${n(u.limits.d1RowsPerDay)} 行`, tone },
    {
      label: 'Workers の要求', when: '今日', pct: u.today.workersRequests === null ? null : pct(u.today.workersRequests, u.limits.workersRequestsPerDay), tickPct: u.limits.stopRatio * 100,
      value: u.today.workersRequests === null ? '—' : est ? `この PC ${n(u.today.workersRequests)} 回` : `${n(u.today.workersRequests)} / ${n(u.limits.workersRequestsPerDay)} 回`, tone: 'ok',
    },
  ];
  const month: CloudUsageBar[] = (u.month?.rows ?? []).map((r) => ({ label: r.label, when: '今月', pct: r.included === null ? null : pct(r.consumed, r.included), tickPct: null, value: amount(r.consumed, r.unit, r.included), tone: 'ok' }));

  const legend: string[] = [];
  if (!paid) legend.push(tone === 'warn' ? `あと ${n(Math.ceil(stopLine - d1))} 行で同期を止めます · ${reset} に戻る` : `今日の枠は ${reset} に戻る · 目盛りの ${Math.round(u.limits.stopRatio * 100)}% で同期を止める`);
  if (u.month) legend.push(`今月は ${md(u.month.periodStart, tz)}〜${u.month.periodEnd ? md(u.month.periodEnd, tz) : ''}`);

  const source = est ? 'hangar の見積もり（実際より 1〜4 割多め）'
    : u.stale ? `Cloudflare の数 · ${u.fetchedAt ? hm(u.fetchedAt, tz) : ''} · 取得に失敗`
    : `Cloudflare の数 · ${relativeTime(u.fetchedAt, now)}`;

  let strip: CloudUsageProps['strip'] = null;
  if (quotaPaused) {
    const back = sync?.quotaPausedDay && sync.quotaPausedDay < utcDay(now);
    const gap = !est && d1 < stopLine ? `（Cloudflare の数では ${Math.round(d1Pct)}%）` : '';
    strip = back
      ? { tone: 'stop', text: '無料枠の 80% に届いたので同期を止めました。枠は戻っています。「同期を再開」で再開できます。' }
      : { tone: 'stop', text: `無料枠の 80% に届いたので同期を止めました${gap}。${reset} に枠が戻ります。戻ったあと「同期を再開」で再開できます。` };
  } else if (est) {
    strip = { tone: 'info', text: u.notice ?? 'Cloudflare の正確な数、R2、今月の費用は、読み取り専用のトークンを入れると出ます。' };
  }

  return { tiles: paid ? tiles.filter((t) => t.key !== 'd1') : tiles, bars: [...today, ...month], splitAfter: today.length, legend, source, strip, command: est ? TOKEN_COMMAND : null };
}
```

（試験の期待値と食い違う語や丸めがあれば、試作 `usage-merged.html` の語を正として presenter と試験の両方をそろえる。`relativeTime` の「2 分前」の書き方は `format.ts` の既存の関数に従う。）

`settings.ts`：import に `presentCloudUsage, type CloudUsageProps` を足し、`CloudSettingsProps` の末尾に `usage: CloudUsageProps | null` を足し、`cloud` の組み立てに `usage: presentCloudUsage(store.cloudUsage, sync, now),` を足す。

`store.ts`：`Store` に `cloudUsage: CloudUsageDto | null;`、`initialStore()` に `cloudUsage: null`、bootstrap の写しに `cloudUsage: b.cloudUsage ?? null`、イベントに `case 'sync.usage': return { ...store, cloudUsage: ev.usage };` を足す。

`api.ts`：`Api` に `syncUsage(refresh: boolean): Promise<CloudUsageDto | null>;`、実装に `syncUsage: (refresh) => call(refresh ? '/api/sync/usage?refresh=1' : '/api/sync/usage'),` を足す。`test/fakeApi.ts` にも同じ名前で足す（呼び出しを記録し、既定は `null` を返す）。

`runtime.ts` の `api.loadSettingsExtras` に足す。

```ts
        // 一時停止の間はサーバが取りに行かず最後の値を返すので、ここでは状態を見ずに頼んでよい。
        deps.api.syncUsage(true).then((u) => setStore({ ...store, cloudUsage: u })).catch(fail);
```

`views/misc.test.tsx` など、`CloudSettingsProps` を手で組んでいる試験には `usage: null` を足す（型検査が場所を教える）。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui/src/presenters packages/ui/src/runtime && npm run typecheck -w @agent-hangar/ui`
Expected: PASS、型検査 0 件

- [ ] **Step 5: コミット**

```bash
git commit packages/ui/src/presenters/cloudUsage.ts packages/ui/src/presenters/cloudUsage.test.ts packages/ui/src/presenters/settings.ts packages/ui/src/store/store.ts packages/ui/src/runtime/api.ts packages/ui/src/runtime/runtime.ts packages/ui/src/runtime/runtime.test.ts packages/ui/src/test/fakeApi.ts packages/ui/src/views/misc.test.tsx -m "feat(ui): present cloud usage for settings"
```

---

### Task 8: 設定の「使用量と費用」の段を描く

**Files:**
- Create: `packages/ui/src/views/CloudUsage.tsx`
- Modify: `packages/ui/src/views/SettingsScreen.tsx:418-424`（操作ボタンの段の後ろ）
- Modify: `packages/ui/src/styles/settings.css`（末尾）
- Test: `packages/ui/src/views/misc.test.tsx`

**Interfaces:**
- Consumes: `CloudUsageProps`（Task 7）
- Produces: `CloudUsage(props: CloudUsageProps)`（React の部品）

- [ ] **Step 1: 失敗する試験を書く**

`misc.test.tsx` に足す。

```tsx
import { CloudUsage } from './CloudUsage.tsx';
import type { CloudUsageProps } from '../presenters/cloudUsage.ts';

const USAGE: CloudUsageProps = {
  tiles: [
    { key: 'bill', label: '今月の請求', value: '$0.00', sub: '9/30 分まで', tone: 'ok' },
    { key: 'd1', label: 'D1 の書き込み（今日）', value: '68%', sub: '68,120 行', tone: 'warn' },
    { key: 'plan', label: 'プラン', value: 'Workers 無料', sub: 'R2 従量', tone: 'ok' },
  ],
  bars: [
    { label: 'D1 の書き込み', when: '今日', pct: 68.12, tickPct: 80, value: '68,120 / 100,000 行', tone: 'warn' },
    { label: 'R2 の保存', when: '今月', pct: 1.65, tickPct: null, value: '0.17 / 10 GB-月', tone: 'ok' },
    { label: 'R2 Infrequent Access Data Retrieval', when: '今月', pct: null, tickPct: null, value: '3 GB', tone: 'ok' },
  ],
  splitAfter: 1, legend: ['あと 11,880 行で同期を止めます · 9:00 に戻る'], source: 'Cloudflare の数 · 2 分前', strip: null, command: null,
};

describe('CloudUsage', () => {
  it('札と棒と添え書きを描く', () => {
    render(<CloudUsage {...USAGE} />);
    const sec = screen.getByRole('region', { name: '使用量と費用' });
    expect(within(sec).getByText('$0.00')).toBeTruthy();
    expect(within(sec).getByText('68%').closest('[data-tone]')?.getAttribute('data-tone')).toBe('warn');
    const meters = within(sec).getAllByRole('meter');
    expect(meters).toHaveLength(2);
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('68.12');
    expect(within(sec).getByText('3 GB')).toBeTruthy();
    expect(within(sec).getByText('Cloudflare の数 · 2 分前')).toBeTruthy();
  });
  it('停止の帯は alert、案内のコマンドは等幅で出す', () => {
    render(<CloudUsage {...USAGE} strip={{ tone: 'stop', text: '無料枠の 80% に届いたので同期を止めました。' }} command="npm run hangar -- setup cloud --usage-token" />);
    expect(screen.getByRole('alert').textContent).toContain('同期を止めました');
    expect(screen.getByText('npm run hangar -- setup cloud --usage-token').className).toContain('mono');
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/misc.test.tsx -t CloudUsage`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/views/CloudUsage.tsx`:

```tsx
import type { CloudUsageProps } from '../presenters/cloudUsage.ts';

/**
 * 設定の「使用量と費用」。上に札、下に全部の枠の棒（今日の枠、区切り、今月の枠）。
 * 試作 docs/superpowers/specs/2026-10-02-cloud-usage/usage-merged.html の左上が正本。
 * props だけで描き、状態を持たない。
 */
export function CloudUsage(props: CloudUsageProps) {
  return (
    <section className="cu" aria-label="使用量と費用">
      <h4 className="cu-h">使用量と費用</h4>
      <div className="cu-tiles">
        {props.tiles.map((t) => (
          <div key={t.key} className="cu-tile" data-tone={t.tone}>
            <div className="cu-k">{t.label}</div>
            <div className="cu-v">{t.value}<small>{t.sub}</small></div>
          </div>
        ))}
      </div>
      {props.strip && <div className="cu-strip" data-tone={props.strip.tone} role={props.strip.tone === 'stop' ? 'alert' : undefined}>{props.strip.text}</div>}
      <div className="cu-bars">
        {props.bars.map((b, i) => (
          <div key={b.label} className="cu-row-wrap">
            {i === props.splitAfter && i > 0 && <div className="cu-sep" aria-hidden="true" />}
            <div className="cu-row">
              <span>{b.label}<span className="cu-when">{b.when}</span></span>
              {b.pct === null ? <span /> : (
                <div className="cu-meter" data-tone={b.tone} role="meter" aria-label={b.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={b.pct}>
                  <i style={{ width: `${Math.min(100, b.pct)}%` }} />
                  {b.tickPct !== null && <span className="cu-tick" style={{ left: `${b.tickPct}%` }} />}
                </div>
              )}
              <span className="cu-n mono">{b.value}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="cu-legend">
        {props.legend.map((l) => <span key={l}>{l}</span>)}
        <span className="faint">{props.source}</span>
      </div>
      {props.command && <div className="mono faint cu-cmd">{props.command}</div>}
    </section>
  );
}
```

`SettingsScreen.tsx`：import に `CloudUsage` を足し、操作ボタンの `</div>`（参加トークンを表示のボタンを閉じる行）と `{props.cloud.joinToken !== null && <JoinToken ... />}` の間に足す。

```tsx
                  {/* 使用量と費用。操作ボタンの下、PC の一覧の上に置く（試作 usage-merged.html の「置き場所」）。 */}
                  {props.cloud.usage && <CloudUsage {...props.cloud.usage} />}
```

`settings.css` の末尾に足す。

```css
/* 設定の「使用量と費用」（2026-10-02 の決定。試作 usage-merged.html）。 */
.cu { margin-top: calc(var(--u) * 3); padding-top: calc(var(--u) * 3); border-top: 1px solid var(--line); }
.cu-h { margin: 0 0 calc(var(--u) * 2); font-size: var(--fs); font-weight: 650; }
.cu-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: calc(var(--u) * 2); }
.cu-tile { padding: calc(var(--u) * 2) calc(var(--u) * 2.5); border-radius: var(--r); background: var(--surface-2); }
.cu-tile[data-tone='warn'] { background: var(--st-paused-soft); }
.cu-tile[data-tone='warn'] .cu-v { color: var(--st-paused); }
.cu-tile[data-tone='stop'] { background: color-mix(in srgb, var(--error) 8%, var(--surface)); }
.cu-tile[data-tone='stop'] .cu-v { color: var(--error); }
.cu-tile[data-tone='muted'] .cu-v { color: var(--ink-3); }
.cu-k { font-size: var(--fs-xs); color: var(--ink-3); }
.cu-v { margin-top: 2px; font: 650 18px var(--font-mono); }
.cu-v small { margin-left: var(--u); font: 500 var(--fs-xs) var(--font-sans); color: var(--ink-2); }
.cu-strip { margin-top: calc(var(--u) * 3); padding: calc(var(--u) * 2) calc(var(--u) * 3); border-radius: var(--r); font-size: var(--fs-sm); }
.cu-strip[data-tone='stop'] { background: color-mix(in srgb, var(--error) 6%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--error) 30%, transparent); }
.cu-strip[data-tone='info'] { background: var(--surface-2); }
.cu-bars { display: grid; gap: calc(var(--u) * 2.25); margin-top: calc(var(--u) * 3.5); }
.cu-row { display: grid; grid-template-columns: 148px minmax(0, 1fr) 152px; gap: calc(var(--u) * 2.5); align-items: center; font-size: var(--fs-sm); }
.cu-when { margin-left: var(--u); font-size: var(--fs-xs); color: var(--ink-3); }
.cu-n { text-align: right; font-size: var(--fs-xs); color: var(--ink-2); }
.cu-sep { height: 1px; margin-bottom: calc(var(--u) * 2.25); background: var(--line); }
.cu-meter { position: relative; height: 6px; border-radius: var(--r-pill); background: color-mix(in srgb, var(--ink) 8%, transparent); }
.cu-meter > i { position: absolute; inset: 0 auto 0 0; border-radius: var(--r-pill); background: var(--accent); }
.cu-meter[data-tone='warn'] > i { background: var(--busy); }
.cu-meter[data-tone='stop'] > i { background: var(--error); }
.cu-tick { position: absolute; top: -4px; bottom: -4px; width: 2px; border-radius: 1px; background: var(--st-paused); }
.cu-legend { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 3); margin-top: var(--u); font-size: var(--fs-xs); color: var(--ink-2); }
.cu-cmd { margin-top: calc(var(--u) * 1.5); }
/* 狭い窓では、名前と数の列を縮めて棒を残す。 */
@media (max-width: 700px) { .cu-row { grid-template-columns: 110px minmax(0, 1fr) 120px; } }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run && npm run typecheck -w @agent-hangar/ui`
Expected: PASS（`styles/*.test.ts` のトークンや動きの見張りが落ちたら、その試験の決まりに合わせて CSS を直す）

- [ ] **Step 5: コミット**

```bash
git commit packages/ui/src/views/CloudUsage.tsx packages/ui/src/views/SettingsScreen.tsx packages/ui/src/styles/settings.css packages/ui/src/views/misc.test.tsx -m "feat(ui): usage and cost tiles and bars in cloud sync settings"
```

---

### Task 9: ヘッダーの「無料枠で停止」

**Files:**
- Modify: `packages/ui/src/presenters/shell.ts:20`（`SyncProps`）、`:68-78`（`syncProps`）
- Modify: `packages/ui/src/views/SyncStatus.tsx`（点の色）
- Modify: `packages/ui/src/styles/sync.css`（`data-reason`）
- Test: `packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/views/Shell.test.tsx`

**Interfaces:**
- Consumes: `SyncStatusBody.pausedReason`、`quotaPausedDay`（Task 5）
- Produces: `SyncProps.reason: 'quota' | 'user' | null`

- [ ] **Step 1: 失敗する試験を書く**

`presenters.test.ts` のヘッダーの同期の試験の近くに足す（このファイルで shell の presenter を呼んでいる関数名に合わせる）。

```ts
describe('ヘッダーの無料枠で停止', () => {
  const at = (iso: string) => Date.parse(iso);
  const paused = (o: Partial<SyncStatusBody>): SyncStatusBody => ({ state: 'paused', url: 'https://w', lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 1, claudeConfig: { enabled: false, confirmed: false }, skipped: [], sweepPending: 0, ...o });
  it('止めた日のうちは、戻る時刻を端末の時刻で言う', () => {
    const p = shellSync(paused({ pausedReason: 'quota', quotaPausedDay: '2026-10-02' }), at('2026-10-02T06:48:00Z'), 'Asia/Tokyo');
    expect(p).toMatchObject({ label: '無料枠で停止 · 9:00 に戻る', reason: 'quota', paused: true });
  });
  it('UTC の日が変わったら、枠は戻りましたと言う', () => {
    const p = shellSync(paused({ pausedReason: 'quota', quotaPausedDay: '2026-10-02' }), at('2026-10-03T00:00:01Z'), 'Asia/Tokyo');
    expect(p.label).toBe('無料枠で停止 · 枠は戻りました');
  });
  it('時差に依らない（ニューヨークでも同じ境目）', () => {
    const p = shellSync(paused({ pausedReason: 'quota', quotaPausedDay: '2026-10-02' }), at('2026-10-02T23:59:00Z'), 'America/New_York');
    expect(p.label).toBe('無料枠で停止 · 20:00 に戻る');
  });
  it('手で止めたときは今までどおり', () => {
    expect(shellSync(paused({ pausedReason: 'user' }), at('2026-10-02T06:48:00Z'), 'Asia/Tokyo')).toMatchObject({ label: '一時停止中', reason: 'user' });
  });
});
```
（`shellSync(sync, now, tz)` は、このファイルの組み立てで `store.sync` と `state.sync`（`toSyncState(sync)`）をそろえて `presentShell(...).sync` を返す小さな関数として、この Step で書く。）

`Shell.test.tsx` に足す。

```tsx
it('無料枠で止まったときは点に data-reason を付ける', () => {
  // このファイルの Header の描き方で sync に { ...SYNC, state: 'paused', paused: true, reason: 'quota', label: '無料枠で停止 · 9:00 に戻る' } を渡す
  expect(document.querySelector('.sync')?.getAttribute('data-reason')).toBe('quota');
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/presenters.test.ts -t 無料枠で停止`
Expected: FAIL

- [ ] **Step 3: 実装する**

`shell.ts` の `SyncProps` に `reason: 'quota' | 'user' | null` を足し、`syncProps` に時差の引数を通す（`presentShell` の呼び手は既定の `undefined` で端末の時差になる）。

```ts
const resetLabel = (now: number, tz?: string): string => {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return new Intl.DateTimeFormat('ja-JP', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(next);
};

function syncProps(state: State, store: Store, now: number, tz?: string): SyncProps {
  const s = state.sync;
  const reason = s.kind === 'paused' ? (store.sync?.pausedReason ?? 'user') : null;
  const quotaDay = store.sync?.quotaPausedDay ?? null;
  const today = new Date(now).toISOString().slice(0, 10);
  const label =
    s.kind === 'off' ? ''
    : reason === 'quota' ? (quotaDay !== null && quotaDay < today ? '無料枠で停止 · 枠は戻りました' : `無料枠で停止 · ${resetLabel(now, tz)} に戻る`)
    : s.kind === 'error' ? `${SYNC_STATE_LABEL.error}: ${s.message}`
    : s.kind !== 'idle' ? SYNC_STATE_LABEL[s.kind]
    : s.lastAt === null ? '同期の準備中'
    : `同期 ${relativeTime(s.lastAt, now)}`;
  return { visible: s.kind !== 'off', state: s.kind, label, pending: state.pending, sweepPending: store.sync?.sweepPending ?? 0, skipped: store.sync?.skipped.length ?? 0, paused: s.kind === 'paused', reason };
}
```

`SyncStatus.tsx` の外側の `<span className="sync" data-state={props.state}>` に `data-reason={props.reason ?? undefined}` を足し、文のリンクの class を `props.state === 'error' || props.reason === 'quota' ? 'mono sync-label sync-error' : 'mono sync-label faint'` にする。

`sync.css` の点の色の後ろに足す。

```css
/* 無料枠で止まったときは、手で止めたのと見分けがつくよう点を赤にする（2026-10-02 の決定 H1）。 */
.sync[data-reason='quota'] .sync-dot { background: var(--error); }
```

`SyncProps` を手で組んでいる試験（`Shell.test.tsx` など）には `reason: null` を足す。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run && npm run typecheck -w @agent-hangar/ui`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git commit packages/ui/src/presenters/shell.ts packages/ui/src/views/SyncStatus.tsx packages/ui/src/styles/sync.css packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/Shell.test.tsx -m "feat(ui): say when sync stopped at the free-tier limit"
```

---

### Task 10: setup でトークンを Worker に入れる

**Files:**
- Modify: `packages/cli/src/cloud.ts`（`installUsageToken`、`readUsageToken`、`runSetupCloud` の最後の問い）
- Modify: `packages/cli/src/index.ts:40-49`（`--usage-token`）
- Test: `packages/cli/src/cloud.test.ts`

**Interfaces:**
- Consumes: `WranglerRunner.run(args, input)`、`readCloudConfig`、`wranglerConfigPath`
- Produces:
  - `installUsageToken(o: { home: string; token: string; fetch?: typeof fetch; wrangler?: WranglerRunner; log?: (l: string) => void; cloudDir?: string }): Promise<void>`
  - `readUsageToken(): Promise<string>`
  - `USAGE_TOKEN_HELP: string[]`（作るトークンの案内）

- [ ] **Step 1: 失敗する試験を書く**

`cloud.test.ts` に足す（このファイルの偽の wrangler と cloud.json の作り方に合わせる）。

```ts
describe('installUsageToken', () => {
  const ACC = '0123456789abcdef0123456789abcdef';
  const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  const cfFetch = (o: { verify?: number; subs?: number; gql?: number } = {}) => {
    const calls: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      expect(url).not.toContain('tok-secret');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-secret');
      if (url.endsWith('/tokens/verify')) return o.verify ? new Response('{}', { status: o.verify }) : ok({ success: true, result: { status: 'active' } });
      if (url.endsWith('/subscriptions')) return o.subs ? new Response('{}', { status: o.subs }) : ok({ success: true, result: [] });
      if (url.endsWith('/graphql')) return o.gql ? new Response('{}', { status: o.gql }) : ok({ data: { viewer: { accounts: [{}] } } });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    return { f, calls };
  };

  it('確かめてから、二つの secret を標準入力で入れる。argv にトークンを出さない', async () => {
    const home = setupHome({ accountId: ACC, workerName: 'hangar' });
    const wr = fakeWrangler();
    const { f } = cfFetch();
    await installUsageToken({ home, token: 'tok-secret\n', fetch: f, wrangler: wr, log: () => {} });
    expect(wr.calls.map((c) => c.args.slice(0, 3))).toEqual([['secret', 'put', 'USAGE_API_TOKEN'], ['secret', 'put', 'CF_ACCOUNT_ID']]);
    expect(wr.calls.map((c) => c.input)).toEqual(['tok-secret\n', `${ACC}\n`]);
    for (const c of wr.calls) expect(c.args.join(' ')).not.toContain('tok-secret');
  });
  it('verify が通らなければ入れない', async () => {
    const home = setupHome({ accountId: ACC, workerName: 'hangar' });
    const wr = fakeWrangler();
    await expect(installUsageToken({ home, token: 'tok-secret', fetch: cfFetch({ verify: 401 }).f, wrangler: wr, log: () => {} })).rejects.toThrow('トークンが有効ではありません');
    expect(wr.calls).toHaveLength(0);
  });
  it('権限が足りなければ、足りない権限の名前を言う', async () => {
    const home = setupHome({ accountId: ACC, workerName: 'hangar' });
    await expect(installUsageToken({ home, token: 'tok-secret', fetch: cfFetch({ subs: 403 }).f, wrangler: fakeWrangler(), log: () => {} })).rejects.toThrow('Billing: Read');
    await expect(installUsageToken({ home, token: 'tok-secret', fetch: cfFetch({ gql: 403 }).f, wrangler: fakeWrangler(), log: () => {} })).rejects.toThrow('Account Analytics: Read');
  });
  it('参加しただけの端末では、setup した端末で入れるよう案内する', async () => {
    const home = setupHome({ accountId: null, workerName: null });
    await expect(installUsageToken({ home, token: 'tok-secret', fetch: cfFetch().f, wrangler: fakeWrangler(), log: () => {} })).rejects.toThrow('setup cloud を実行した PC');
  });
  it('空のトークンは断る', async () => {
    const home = setupHome({ accountId: ACC, workerName: 'hangar' });
    await expect(installUsageToken({ home, token: '  \n', fetch: cfFetch().f, wrangler: fakeWrangler(), log: () => {} })).rejects.toThrow('トークンが空です');
  });
});
```
（`setupHome` は cloud.json と wrangler の設定を一時ディレクトリに書く小さな関数、`fakeWrangler` は `run(args, input)` を記録して `{ code: 0, stdout: '', stderr: '' }` を返す偽物。このファイルに同じ役の道具があればそれを使う。）

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/cli/src/cloud.test.ts -t installUsageToken`
Expected: FAIL

- [ ] **Step 3: 実装する**

`cloud.ts` に足す。

```ts
// ---- 使用量のトークン ----

/** 作るトークンの案内。setup の問いと --usage-token の前に出す。 */
export const USAGE_TOKEN_HELP = [
  '使用量と費用を設定画面に出すには、読み取り専用の API トークンを Worker に入れます（無くても同期は動きます）。',
  '作り方: Cloudflare のダッシュボード → Manage account → Account API tokens → Create Token → Start from scratch',
  '  権限は二つだけ: Account Analytics: Read と Billing: Read（Entire Account）',
  '  1Password に保存し、op read "op://…" | npm run hangar -- setup cloud --usage-token で流し込めます。',
];

const CF_API = 'https://api.cloudflare.com/client/v4';

/** 標準入力からトークンを読む。端末なら伏せ字で尋ね、パイプなら全部を読む。argv には載せない。 */
export async function readUsageToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of process.stdin) {
      size += (c as Buffer).length;
      if (size > MAX_STDIN_BYTES) throw new Error('標準入力が長すぎます。トークンだけを渡してください');
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  holdStdin(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // 打った文字を画面に出さない。問いの文だけは書く。
  const prompt = '使用量のトークンを貼り付けてください（表示しません）: ';
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.includes(prompt)) process.stdout.write(prompt); };
  return new Promise<string>((resolve) => {
    let done = false;
    const finish = (a: string): void => { if (done) return; done = true; rl.close(); holdStdin(false); process.stdout.write('\n'); resolve(a); };
    rl.on('close', () => finish(''));
    rl.question(prompt, finish);
  });
}

/**
 * トークンを確かめてから Worker の secret に入れる。
 * 確かめるのは、有効か（tokens/verify）と、二つの権限があるか（subscriptions と GraphQL を 1 回ずつ）。
 */
export async function installUsageToken(o: { home: string; token: string; fetch?: typeof fetch; wrangler?: WranglerRunner; log?: (l: string) => void; cloudDir?: string }): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const fetchFn = o.fetch ?? realFetch;
  const token = o.token.trim();
  if (!token) throw new Error('トークンが空です');
  const read = readCloudConfig(o.home);
  if (read.state === 'broken') throw new Error(brokenConfigMessage(o.home));
  const conf = read.config;
  if (!conf || !conf.accountId || !conf.workerName) throw new Error('トークンは、hangar setup cloud を実行した PC で入れてください（この PC は参加しただけなので、Worker の設定を持っていません）');
  const accountId = conf.accountId;
  const headers = { authorization: `Bearer ${token}` };
  const status = async (path: string, init: RequestInit = {}): Promise<number> => {
    try { return (await fetchFn(`${CF_API}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } })).status; } catch { return 0; }
  };
  if ((await status(`/accounts/${accountId}/tokens/verify`)) !== 200) throw new Error('トークンが有効ではありません。値と、アカウントのトークンであることを確かめてください');
  if ((await status(`/accounts/${accountId}/subscriptions`)) !== 200) throw new Error('権限が足りません: Billing: Read を付けてください');
  const gql = await status('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{viewer{accounts(filter:{accountTag:"' + accountId + '"}){accountTag}}}' }) });
  if (gql !== 200) throw new Error('権限が足りません: Account Analytics: Read を付けてください');
  // wrangler を渡されたとき（試験と setup の続き）は、Worker の元の場所を探さない。
  const wr = (o.wrangler ?? new WranglerRunner({ cloudDir: o.cloudDir ?? requireCloudDir(), accountId: null, log })).withAccount(accountId);
  const cfg = wranglerConfigPath(o.home);
  for (const [name, value] of [['USAGE_API_TOKEN', token], ['CF_ACCOUNT_ID', accountId]] as const) {
    const put = await wr.run(['secret', 'put', name, '--config', cfg], value + '\n');
    if (put.code !== 0) throw new Error(`secret の登録に失敗しました（${name}）: ${cleanWranglerError(put.stderr || put.stdout).join(' ')}`);
  }
  log('使用量のトークンを Worker に入れました。数分のうちに、どの PC の設定画面にも使用量と費用が出ます。');
  log('外すときは: npx wrangler secret delete USAGE_API_TOKEN --config ' + cfg);
}
```
（試験の期待値は `token: 'tok-secret\n'` のまま `input` が `'tok-secret\n'` になることを見ているので、`value + '\n'` の `value` は trim 後の値で合う。偽の wrangler の `withAccount` は自分を返す形にする。）

`runSetupCloud` の `printJoinToken(log, joinToken);` の後ろに足す。

```ts
  // 使用量のトークンは任意。端末から打たれたときだけ尋ね、飛ばしても setup はここで終わる。
  if (process.stdin.isTTY && !o.skipUsageToken) {
    log('');
    for (const l of USAGE_TOKEN_HELP) log(l);
    if ((await askLine('使用量のトークンをいま入れますか（後からでも可） [y/N]: ')).trim().toLowerCase() === 'y') {
      await installUsageToken({ home: o.home, token: await readUsageToken(), fetch: fetchFn, wrangler: wr, log, cloudDir });
    }
  }
```
（`SetupCloudOptions` に `skipUsageToken?: boolean` を足す。既存の試験が尋ねられて止まらないよう、既存の `runSetupCloud` の試験は `skipUsageToken: true` を渡すか、標準入力が端末でない前提で通ることを確かめる。）

`index.ts` の `setup cloud` に足す。

```ts
  .option('--usage-token', '使用量と費用を出す読み取り専用のトークンを Worker に入れる（標準入力から受け取る）')
  .action(async (o: { name: string; rotateSecret?: boolean; usageToken?: boolean }) => {
    const home = hangarHome();
    if (o.usageToken) {
      for (const l of USAGE_TOKEN_HELP) console.log(l);
      await installUsageToken({ home, token: await readUsageToken() });
      return;
    }
    const device = readOrCreateDevice(home);
    await runSetupCloud({ home, device, name: o.name, rotateSecret: o.rotateSecret });
  });
```
（import に `installUsageToken, readUsageToken, USAGE_TOKEN_HELP` を足す。）

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run && npm run typecheck -w @agent-hangar/cli`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git commit packages/cli/src/cloud.ts packages/cli/src/cloud.test.ts packages/cli/src/index.ts -m "feat(cli): setup cloud --usage-token puts a read-only token on the Worker"
```

---

### Task 11: 文書、全体の確認、ビルド、実物での確認

**Files:**
- Modify: `docs/design.md`（Settings とクラウド同期の節）
- Modify: `docs/superpowers/specs/2026-10-02-cloud-usage/fixtures/subscriptions.json`（実物で取り直せたとき）

- [ ] **Step 1: 設計書へ移す**

`docs/design.md` の Settings の節に「使用量と費用」（札 3 枚と棒、状態ごとの姿、出どころ）を、クラウド同期の節に `GET /usage`、secret の名前、一時停止の間は取りに行かないこと、`setup cloud --usage-token` を、仕様書の語のまま短く書く。

- [ ] **Step 2: 全部の試験と型検査**

Run: `npx vitest run 2>&1 | tail -8 && npm run typecheck --workspaces --if-present 2>&1 | tail -5`
Expected: すべて PASS（日付依存で落ちる既存の 1 件があれば、それだと確かめて報告に書く）、型検査 0 件

- [ ] **Step 3: ビルド**

メモの決まり（返す前に必ず build）に従う。UI の vite build、デスクトップの bundle-server と tauri build を通す。

Run: `npm run build -w @agent-hangar/ui && npm run bundle-server -w @agent-hangar/desktop && npm run tauri -w @agent-hangar/desktop -- build`
（desktop の package 名は `apps/desktop/package.json` の name に合わせる。ビルドの後、メモの決まりどおり、利用者の npm run dev のサーバの扱いは起動ログで PID を確かめてから決める。ポート番号で止めない。）
Expected: どれも成功

- [ ] **Step 4: コミット**

```bash
git commit docs/design.md -m "docs: cloud usage and cost in settings"
```

- [ ] **Step 5: 実物での確認（利用者と一緒に行う）**

次は利用者の確認と操作が要るので、実装者は手順を報告に書いて止まる。オーケストレータが利用者に頼む。

1. ブランチを main へ入れてから `npm run hangar -- setup cloud` で Worker を配る（wrangler の設定の `main` がメインの checkout を指すため）。
2. `op read "op://Employee/agent-hangar Cloudflare usage token/credential" | npm run hangar -- setup cloud --usage-token`（Touch ID の承認が要る）。
3. `/Applications/Hangar.app` を入れ替えて開き、設定の「クラウド同期」に札と棒が出ること、D1 の今日の数が GraphQL を手で叩いた数と合うことを確かめる。
4. subscriptions の生の応答を取り直し、伏せ字にして `fixtures/subscriptions.json` を差し替える（項目の形が違えば collectUsage と試験を直す）。
```
