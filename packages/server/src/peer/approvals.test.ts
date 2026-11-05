import type { PeerLaunchRequest } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onRowChange } from '../db/notify.ts';
import { openDb, type Db } from '../db/open.ts';
import { listPeerApprovals, mobilePeerApprovals, PEER_APPROVAL_HOLD_MS, PEER_APPROVAL_MAX, PEER_APPROVAL_TTL_MS, PeerApprovals, type PeerApprovalDeps } from './approvals.ts';

let db: Db;
let now: number;
const sent: string[] = [];
const refused: { requestId: string; reason: string; detail?: string }[] = [];
const notices: string[] = [];

const request = (over: Partial<PeerLaunchRequest> = {}): PeerLaunchRequest => ({
  v: 1, createdAt: 1, parentSessionId: 'caller', projectId: 'p1', scratch: false, agent: 'claude-code', account: '', permissionMode: '', model: '', prompt: '目次の見出しを直して', ...over,
});
const make = (over: Partial<PeerApprovalDeps> = {}): PeerApprovals => new PeerApprovals({
  db, now: () => now,
  send: async (row) => { sent.push(row.requestId); },
  refuse: (o) => { refused.push(o); },
  notify: (o) => { notices.push(`${o.from ?? ""}>${o.device}`); },
  ...over,
});
const ask = (svc: PeerApprovals, id = 'r1', o: Partial<Parameters<PeerApprovals['request']>[0]> = {}) => svc.request({ requestId: id, callerSessionId: 'caller', to: 'dev-b', toName: 'laptop', projectId: 'p1', scratch: false, request: request(), ...o });

beforeEach(() => {
  db = openDb(':memory:');
  now = 1_000_000;
  sent.length = 0; refused.length = 0; notices.length = 0;
  db.prepare("insert into projects (id, name, status, updated_at, origin_device) values ('p1', 'docs-site', 'active', 1, 'd')").run();
  db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device, custom_title) values ('caller', 'claude-code', 'u1', '/w', 'd', 1, 'd', 'ログイン修正')").run();
});

describe('別の PC への起動の承認', () => {
  it('承認待ちは一覧に、呼び出し元の題名、PC、プロジェクト、頼みの先頭、期限を添えて出る', () => {
    ask(make());
    expect(listPeerApprovals(db, now)).toEqual([{ id: 'r1', from: 'ログイン修正', device: 'laptop', project: 'docs-site', scratch: false, ask: '目次の見出しを直して', expiresAt: now + PEER_APPROVAL_TTL_MS, state: 'pending' }]);
  });
  it('クイックセッションはプロジェクトを持たず、scratch で示す', () => {
    ask(make(), 'q1', { projectId: null, scratch: true, request: request({ projectId: null, scratch: true }) });
    expect(listPeerApprovals(db, now)[0]).toMatchObject({ project: null, scratch: true });
  });
  it('同じ頼みの ID を重ねても 1 行のまま。待ちが上限なら積まない', () => {
    const svc = make();
    ask(svc); ask(svc);
    expect(listPeerApprovals(db, now)).toHaveLength(1);
    for (let i = 0; i < PEER_APPROVAL_MAX - 1; i++) ask(svc, `x${i}`);
    expect(listPeerApprovals(db, now)).toHaveLength(PEER_APPROVAL_MAX);
    expect(ask(svc, 'over')).toBe(false);
    expect(refused).toMatchObject([{ requestId: 'over', reason: 'launch-failed' }]);
    expect(listPeerApprovals(db, now)).toHaveLength(PEER_APPROVAL_MAX);
  });
  it('承認すると頼みを置き、結果の札を短く残してから外す', async () => {
    const svc = make();
    ask(svc);
    expect(await svc.approve('r1')).toBe('done');
    expect(sent).toEqual(['r1']);
    expect(listPeerApprovals(db, now)[0]).toMatchObject({ id: 'r1', state: 'approved' });
    now += PEER_APPROVAL_HOLD_MS + 1;
    svc.sweep();
    expect(listPeerApprovals(db, now)).toEqual([]);
    expect(refused).toEqual([]);
  });
  it('断ると approval-denied を呼び出し元に入れ、何も置かない', () => {
    const svc = make();
    ask(svc);
    expect(svc.reject('r1')).toBe(true);
    expect(sent).toEqual([]);
    expect(refused).toMatchObject([{ requestId: 'r1', to: 'dev-b', callerSessionId: 'caller', reason: 'approval-denied' }]);
    expect(listPeerApprovals(db, now)[0]).toMatchObject({ state: 'denied' });
    expect(svc.reject('r1')).toBe(false);
  });
  it('10 分で approval-timeout を入れる。承認も断るももう受けない', async () => {
    const svc = make();
    ask(svc);
    now += PEER_APPROVAL_TTL_MS - 1;
    svc.sweep();
    expect(refused).toEqual([]);
    now += 1;
    svc.sweep();
    expect(refused).toMatchObject([{ requestId: 'r1', reason: 'approval-timeout' }]);
    expect(listPeerApprovals(db, now)[0]).toMatchObject({ state: 'timeout' });
    expect(await svc.approve('r1')).toBe('missing');
    expect(svc.reject('r1')).toBe(false);
    expect(sent).toEqual([]);
    svc.sweep();
    expect(refused).toHaveLength(1);
  });
  it('期限を過ぎた行は、sweep の前でも承認を受けず、sweep で timeout にする', async () => {
    const svc = make();
    ask(svc);
    now += PEER_APPROVAL_TTL_MS + 5;
    expect(await svc.approve('r1')).toBe('missing');
    expect(sent).toEqual([]);
    svc.sweep();
    expect(refused).toMatchObject([{ reason: 'approval-timeout' }]);
  });
  it('再起動をまたいでも、期限は作った時刻で決まる', () => {
    ask(make());
    now += PEER_APPROVAL_TTL_MS + 1;
    const again = make();
    again.start();
    expect(refused).toMatchObject([{ requestId: 'r1', reason: 'approval-timeout' }]);
    again.stop();
  });
  it('送れなかったら failed にして、launch-failed を呼び出し元に入れる', async () => {
    const svc = make({ send: async () => { throw new Error('offline'); } });
    ask(svc);
    expect(await svc.approve('r1')).toBe('failed');
    expect(refused).toMatchObject([{ requestId: 'r1', reason: 'launch-failed' }]);
    expect(listPeerApprovals(db, now)[0]).toMatchObject({ state: 'failed' });
  });
  it('承認を 2 度続けても、頼みは 1 度しか置かない', async () => {
    const svc = make();
    ask(svc);
    const [a, b] = await Promise.all([svc.approve('r1'), svc.approve('r1')]);
    expect([a, b].sort()).toEqual(['done', 'missing']);
    expect(sent).toEqual(['r1']);
  });
  it('承認待ちができたことを知らせる。会話の題名が分かれば添える', () => {
    ask(make());
    expect(notices).toHaveLength(1);
    expect(notices).toEqual(['ログイン修正>laptop']);
  });
  it('スマホの素には、待ちのうち期限内のものだけを載せる', () => {
    const svc = make();
    ask(svc); ask(svc, 'r2');
    svc.reject('r2');
    expect(mobilePeerApprovals(db, now)).toEqual([{ id: 'r1', from: 'ログイン修正', device: 'laptop', project: 'docs-site', ask: '目次の見出しを直して', expiresAt: now + PEER_APPROVAL_TTL_MS }]);
    expect(mobilePeerApprovals(db, now + PEER_APPROVAL_TTL_MS)).toEqual([]);
  });
  it('行が変わるたびに peer_approvals の変化を配る', () => {
    const seen: string[] = [];
    const off = onRowChange((c) => { if (c.db === db && c.table === 'peer_approvals') seen.push(`${c.rowId}`); });
    const svc = make();
    ask(svc);
    svc.reject('r1');
    now += PEER_APPROVAL_HOLD_MS + 1;
    svc.sweep();
    off();
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });
  it('頼みの中身は封じる前の値のまま取り出せる', async () => {
    const rows: unknown[] = [];
    const svc = make({ send: async (row) => { rows.push(row.request); } });
    ask(svc);
    await svc.approve('r1');
    expect(rows).toMatchObject([{ prompt: '目次の見出しを直して', projectId: 'p1', parentSessionId: 'caller' }]);
  });
  it('タイマーは次の期限に合わせて 1 つだけ張り、止めれば外す', () => {
    const timers = { setTimeout: vi.fn(() => 1 as never), clearTimeout: vi.fn() };
    const svc = make({ timers: timers as never });
    ask(svc);
    expect(timers.setTimeout).toHaveBeenCalled();
    svc.stop();
    expect(timers.clearTimeout).toHaveBeenCalled();
  });
});
