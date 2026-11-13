import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertAutoApproval } from '../../orchestrator/autoApprovals.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 統括の柱が使う口（GET /api/orchestrator/approvals、POST /api/orchestrator/send）の試験。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const row = (at: number, tool = 'Read') => ({ at, sessionId: 's1', title: '調べもの', tool, input: '/a/b', label: 'Yes', reason: '読むだけ', policyText: '読むだけなら通す' });

beforeEach(async () => { t = await testDeps(); app = createApp(t.deps); });
afterEach(() => { t.dispose(); });

describe('GET /api/orchestrator/approvals', () => {
  it('自動許可の記録を新しい順に返し、limit で切る', async () => {
    insertAutoApproval(t.db, row(100));
    insertAutoApproval(t.db, row(200, 'Grep'));
    const all = await (await app.request('/api/orchestrator/approvals', { headers: H })).json();
    expect(all.approvals.map((a: { at: number }) => a.at)).toEqual([200, 100]);
    const one = await (await app.request('/api/orchestrator/approvals?limit=1', { headers: H })).json();
    expect(one.approvals).toHaveLength(1);
  });
});

describe('POST /api/orchestrator/send', () => {
  it('統括が居なければ 409 で、何も送らない', async () => {
    const r = await post('/api/orchestrator/send', { text: 'こんにちは' });
    expect(r.status).toBe(409);
    expect(t.runs.sendInput).not.toHaveBeenCalled();
  });
  it('統括の run の窓へ文を送り、待つ側の印も残す', async () => {
    t.deps.updateSettings({ orchestrator: { enabled: true, sessionId: 'orch-1', model: 'sonnet', effort: 'medium' } });
    (t.runs.listAlive as ReturnType<typeof import('vitest').vi.fn>).mockReturnValue({ runs: [{ id: 'r9', sessionId: 'orch-1', tmuxName: 'hg-orch' }], tabs: [] });
    const r = await post('/api/orchestrator/send', { text: '[voice] 進み具合は' });
    expect(r.status).toBe(200);
    expect(t.runs.sendInput).toHaveBeenCalledWith('hg-orch', '[voice] 進み具合は', true);
  });
  it('空の文と、文字でない値は 400', async () => {
    t.deps.updateSettings({ orchestrator: { enabled: true, sessionId: 'orch-1', model: 'sonnet', effort: 'medium' } });
    expect((await post('/api/orchestrator/send', { text: '  ' })).status).toBe(400);
    expect((await post('/api/orchestrator/send', { text: 3 })).status).toBe(400);
  });
});
