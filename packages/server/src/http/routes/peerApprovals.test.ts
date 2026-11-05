import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PeerApprovalDto } from '@agent-hangar/shared';
import { PEER_APPROVAL_TTL_MS, PeerApprovals } from '../../peer/approvals.ts';
import { issueMcpSecret } from '../../runs/secrets.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let svc: PeerApprovals;
let sessionId: string;
const sent: string[] = [];
const refused: string[] = [];
const post = (p: string, headers: Record<string, string> = H) => app.request(p, { method: 'POST', headers });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  t = await testDeps();
  sent.length = 0; refused.length = 0;
  svc = new PeerApprovals({ db: t.db, send: async (row) => { sent.push(row.requestId); }, refuse: (o) => { refused.push(`${o.requestId}:${o.reason}`); } });
  t.deps.peerApprovals = svc;
  app = createApp(t.deps);
  sessionId = (t.db.prepare('select id from sessions limit 1').get() as { id: string }).id;
  svc.request({
    requestId: 'r1', callerSessionId: sessionId, to: 'dev-b', toName: 'laptop', projectId: null, scratch: true,
    request: { v: 1, createdAt: 1, parentSessionId: sessionId, projectId: null, scratch: true, agent: 'claude-code', account: '', permissionMode: '', model: '', prompt: '集計して' },
  });
});
afterEach(() => { svc.stop(); t.dispose(); });

describe('/api/peer-approvals', () => {
  it('bootstrap に載り、変わると一覧ごと配る', async () => {
    await flush();
    const ev = [...t.events].reverse().find((e) => e.type === 'peerApprovals.update') as { approvals: PeerApprovalDto[] };
    expect(ev.approvals).toMatchObject([{ id: 'r1', device: 'laptop', scratch: true, state: 'pending', ask: '集計して' }]);
    const boot = await (await app.request('/api/bootstrap', { headers: H })).json() as { peerApprovals: PeerApprovalDto[] };
    expect(boot.peerApprovals.map((a) => a.id)).toEqual(['r1']);
    expect(boot.peerApprovals[0]!.expiresAt).toBeGreaterThan(Date.now() + PEER_APPROVAL_TTL_MS - 5000);
  });
  it('承認すると頼みを置き、結果の札を配る', async () => {
    expect(await (await post('/api/peer-approvals/r1/approve')).json()).toEqual({ outcome: 'done' });
    expect(sent).toEqual(['r1']);
    await flush();
    const ev = [...t.events].reverse().find((e) => e.type === 'peerApprovals.update') as { approvals: PeerApprovalDto[] };
    expect(ev.approvals[0]!.state).toBe('approved');
  });
  it('断ると approval-denied を入れる。もう無い行は missing', async () => {
    expect(await (await post('/api/peer-approvals/r1/reject')).json()).toEqual({ ok: true });
    expect(refused).toEqual(['r1:approval-denied']);
    expect(await (await post('/api/peer-approvals/r1/approve')).json()).toEqual({ outcome: 'missing' });
  });
  it('MCP の秘密では答えられない。エージェントが自分で承認できないようにする', async () => {
    const secret = issueMcpSecret(t.db, sessionId, 1);
    const r = await post('/api/peer-approvals/r1/approve', { authorization: `Bearer ${secret}` });
    expect(r.status).toBe(401);
    expect(sent).toEqual([]);
  });
});
