import type { CloudUsageBody, CloudUsagePart } from '@agent-hangar/shared';

// Cache API は文書に「カスタムドメインの Worker と Pages Functions で機能する」とあり、workers.dev での動作は書かれていない。そのため isolate のメモリを使う（https://developers.cloudflare.com/workers/runtime-apis/cache/）。

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
    errors?: unknown[] | null;
    data?: { viewer?: { accounts?: { d1AnalyticsAdaptiveGroups?: Row<'rowsWritten'>[] | null; workersInvocationsAdaptive?: Row<'requests'>[] | null }[] } };
  };
  // GraphQL は権限の誤りを 200 と errors で返し、data を一部だけ埋めることがある。欠けた表を 0 と読まない。
  if (Array.isArray(body.errors) && body.errors.length > 0) throw failed(200);
  const acc = body.data?.viewer?.accounts?.[0];
  if (!acc || !Array.isArray(acc.d1AnalyticsAdaptiveGroups) || !Array.isArray(acc.workersInvocationsAdaptive)) throw failed(200);
  const sum = <K extends string>(rows: Row<K>[], key: K): number => rows.filter((r) => r.dimensions?.date === day).reduce((n, r) => n + (Number(r.sum?.[key]) || 0), 0);
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
  // トークンが失効したら、写しが残っていても三つとも null にする（仕様の「5. setup」）。写しも捨てて、入れ直した後に取り直す。
  if (errors.some((e) => e.message === INVALID_TOKEN_MESSAGE)) {
    resetUsageMemo();
    return { configured: true, fetchedAt: d.now, today: null, plan: null, month: null, errors };
  }
  // 出どころの時刻は今日の数のもの。プランと請求は 6 時間の写しなので、混ぜると今日の数まで古く見える。
  const ats = [plan.at, month.at].filter((v): v is number => v !== null);
  return { configured: true, fetchedAt: today.at ?? (ats.length ? Math.min(...ats) : d.now), today: today.value, plan: plan.value, month: month.value, errors };
}
