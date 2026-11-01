import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeleteApprovalDto } from '@agent-hangar/shared';
import { requestDeleteApproval } from '../../sessions/deleteApprovals.ts';
import { issueMcpSecret } from '../../runs/secrets.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let sessionId: string;
const deleteSession = vi.fn(async () => undefined);
const post = (p: string, headers: Record<string, string> = H) => app.request(p, { method: 'POST', headers });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  t = await testDeps();
  deleteSession.mockClear();
  t.deps.trash = { deleteSession };
  app = createApp(t.deps);
  sessionId = (t.db.prepare('select id from sessions limit 1').get() as { id: string }).id;
});
afterEach(() => { t.dispose(); });

describe('/api/delete-approvals', () => {
  it('bootstrap に依頼が載り、変わると一覧ごと配る', async () => {
    const r = requestDeleteApproval(t.db, { sessionId, fromSessionId: null, now: 1 }) as { id: string };
    await flush();
    const ev = [...t.events].reverse().find((e) => e.type === 'deleteApprovals.update') as { approvals: DeleteApprovalDto[] };
    expect(ev.approvals.map((a) => a.id)).toEqual([r.id]);
    const boot = await (await app.request('/api/bootstrap', { headers: H })).json() as { deleteApprovals: DeleteApprovalDto[] };
    expect(boot.deleteApprovals.map((a) => a.id)).toEqual([r.id]);
  });
  it('承認すると消す。断ると消さない', async () => {
    const a = requestDeleteApproval(t.db, { sessionId, fromSessionId: null, now: 1 }) as { id: string };
    expect(await (await post(`/api/delete-approvals/${a.id}/reject`)).json()).toEqual({ ok: true });
    expect(deleteSession).not.toHaveBeenCalled();
    t.db.prepare('delete from delete_approvals').run();
    const b = requestDeleteApproval(t.db, { sessionId, fromSessionId: null, now: 1 }) as { id: string };
    expect(await (await post(`/api/delete-approvals/${b.id}/approve`)).json()).toEqual({ outcome: 'deleted' });
    expect(deleteSession).toHaveBeenCalledWith(sessionId);
  });
  it('MCP の秘密では答えられない。エージェントが自分で承認できないようにする', async () => {
    const a = requestDeleteApproval(t.db, { sessionId, fromSessionId: null, now: 1 }) as { id: string };
    const secret = issueMcpSecret(t.db, sessionId, 1);
    const r = await post(`/api/delete-approvals/${a.id}/approve`, { authorization: `Bearer ${secret}` });
    expect(r.status).toBe(401);
    expect(deleteSession).not.toHaveBeenCalled();
  });
});
