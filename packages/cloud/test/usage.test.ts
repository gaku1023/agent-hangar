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

  it('請求の行がまだ無い（期の初め）ときは $0 の今月を返し、期の始まりは空にする', async () => {
    const { fetch } = cf({ billable: () => new Response(JSON.stringify({ success: true, errors: [], result: [] }), { status: 200 }) });
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    expect(u.month).toEqual({ periodStart: '', throughDay: null, billedUsd: 0, currency: 'USD', services: [] });
    expect(u.errors).toEqual([]);
  });

  it('GraphQL が errors と一部の data を返したら、欠けた数を 0 と読まずに today を null にする', async () => {
    const partial = { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ dimensions: { date: '2026-10-01' }, sum: { rowsWritten: 5 } }], workersInvocationsAdaptive: null }] } }, errors: [{ message: 'not authorized for workersInvocationsAdaptive' }] };
    const { fetch } = cf({ graphql: () => new Response(JSON.stringify(partial), { status: 200 }) });
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    expect(u.today).toBeNull();
    expect(u.errors).toEqual([{ part: 'today', message: 'Cloudflare が誤りを返しました' }]);
    expect(JSON.stringify(u)).not.toContain('not authorized');
  });

  it('GraphQL の data に片方の表が無ければ today を null にする', async () => {
    const partial = { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } }, errors: null };
    const { fetch } = cf({ graphql: () => new Response(JSON.stringify(partial), { status: 200 }) });
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    expect(u.today).toBeNull();
  });

  it('写しが温まっていても、一つがトークン無効なら三つとも null にし、写しを捨てる', async () => {
    let deny = false;
    const forbid = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
    const { fetch, calls } = cf({ graphql: () => (deny ? forbid() : new Response(JSON.stringify(fixture('graphql-today')))) });
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    deny = true;
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW + TODAY_TTL_MS });
    expect([u.today, u.plan, u.month]).toEqual([null, null, null]);
    expect(u.errors).toEqual([{ part: 'today', message: INVALID_TOKEN_MESSAGE }]);
    // 写しを捨てたので、次は三つとも取り直す。
    calls.length = 0;
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW + TODAY_TTL_MS + 1 });
    expect(calls.map((c) => c.url.split('/').pop()).sort()).toEqual(['billable-usage', 'graphql', 'subscriptions']);
  });

  it('fetchedAt は今日の数を取った時刻（プランと請求の写しが古くても引きずられない）', async () => {
    const { fetch } = cf();
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW + TODAY_TTL_MS });
    expect(u.fetchedAt).toBe(NOW + TODAY_TTL_MS);
  });

  it('今日の数が取れなかったときの fetchedAt は残りの古いほう', async () => {
    let fail = false;
    const { fetch } = cf({ graphql: () => (fail ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(fixture('graphql-today')))) });
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    fail = true;
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW + TODAY_TTL_MS });
    expect(u.today).toBeNull();
    expect(u.fetchedAt).toBe(NOW);
  });

  it('fetchedAt は写しを取った時刻', async () => {
    const { fetch } = cf();
    await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW });
    const u = await collectUsage({ token: TOKEN, accountId: ACC, fetch, now: NOW + 60_000 });
    expect(u.fetchedAt).toBe(NOW);
  });
});
