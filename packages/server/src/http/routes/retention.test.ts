import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { H, RET, testDeps, type TestWorld } from '../testing.ts';

// 保持期間の経路（routes/retention.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  t = await testDeps();
  app = createApp(t.deps);
});
afterEach(() => { t.dispose(); });

describe('保持期間', () => {
  const send = (p: string, method: string, body: unknown) => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('bootstrap に載る', async () => {
    const r = await app.request('/api/bootstrap', { headers: H });
    expect((await r.json()).retention).toEqual(RET);
  });
  it('下見と書き込みは 1 以上 36500 以下の整数だけを受け付ける', async () => {
    for (const days of [0, -1, 1.5, '30', 36501, null]) {
      expect((await send('/api/retention/preview', 'POST', { days })).status).toBe(400);
      expect((await send('/api/retention', 'PUT', { days, baseSha256: 'abc' })).status).toBe(400);
    }
    expect((await (await send('/api/retention/preview', 'POST', { days: 365 })).json()).days).toBe(365);
    expect((await send('/api/retention', 'PUT', { days: 365 })).status).toBe(400);
  });
  it('指紋が古ければ 409 の retention_conflict', async () => {
    const r = await send('/api/retention', 'PUT', { days: 365, baseSha256: 'stale' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'retention_conflict' });
  });
  it('書けたら新しい値を返す。GET でも今の値を返す', async () => {
    expect(await (await send('/api/retention', 'PUT', { days: 365, baseSha256: 'abc' })).json()).toMatchObject({ days: 365, source: 'user' });
    expect(await (await app.request('/api/retention', { headers: H })).json()).toEqual(RET);
  });
});
