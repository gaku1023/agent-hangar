import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { msg } from '../i18n/message.ts';
import { approveDeleteApproval, dismissDeleteApproval, listDeleteApprovals, PENDING_MAX, REJECT_HOLD_MS, rejectDeleteApproval, requestDeleteApproval } from './deleteApprovals.ts';
import { DeleteError } from './trash.ts';

let db: Db;
const addSession = (id: string, title: string, projectId: string | null = null) => {
  db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device, project_id, custom_title) values (?, 'claude-code', ?, '/w', 'd', 1, 'd', ?, ?)").run(id, `u-${id}`, projectId, title);
};
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("insert into projects (id, name, status, updated_at, origin_device) values ('p1', 'alpha', 'active', 1, 'd')").run();
  addSession('t1', '古い試し', 'p1');
  addSession('from', '片付け役');
  db.prepare('insert into session_stats (session_id, turns) values (?, ?)').run('t1', 7);
});
const req = (sessionId = 't1', now = 100) => requestDeleteApproval(db, { sessionId, fromSessionId: 'from', now }) as { outcome: string; id: string; created?: boolean };

describe('削除の承認', () => {
  it('依頼は承認待ちになり、題名、プロジェクト、ターン数、依頼元を添えて一覧に出る', () => {
    const r = req();
    expect(r).toMatchObject({ outcome: 'pending', created: true });
    expect(listDeleteApprovals(db)).toEqual([{ id: r.id, sessionId: 't1', title: '古い試し', project: 'alpha', turns: 7, from: '片付け役', requestedAt: 100, failure: null }]);
  });
  it('同じ会話への依頼を重ねても 1 行のまま', () => {
    const a = req(); const b = req('t1', 200);
    expect(b).toMatchObject({ id: a.id, outcome: 'pending', created: false });
    expect(listDeleteApprovals(db)).toHaveLength(1);
  });
  it('待ちが上限に達したら、それ以上は積まない', () => {
    for (let i = 0; i < PENDING_MAX; i++) { addSession(`x${i}`, `x${i}`); expect(req(`x${i}`).outcome).toBe('pending'); }
    expect(req().outcome).toBe('too_many');
    expect(listDeleteApprovals(db)).toHaveLength(PENDING_MAX);
  });
  it('承認すると消して行を外す', async () => {
    const r = req(); const trash = { deleteSession: vi.fn(async () => undefined) };
    expect(await approveDeleteApproval(db, trash, r.id)).toBe('deleted');
    expect(trash.deleteSession).toHaveBeenCalledWith('t1');
    expect(listDeleteApprovals(db)).toEqual([]);
  });
  it('動いていて消せなければ、理由を残して消さない。閉じると外れ、再度の依頼は承認待ちへ戻る', async () => {
    const r = req();
    const trash = { deleteSession: vi.fn(async () => { throw new DeleteError(409, msg('session.delete.running')); }) };
    expect(await approveDeleteApproval(db, trash, r.id)).toBe('failed');
    expect(listDeleteApprovals(db)[0]!.failure).toBe('running');
    expect(req('t1', 200)).toMatchObject({ outcome: 'pending', id: r.id });
    expect(listDeleteApprovals(db)[0]!.failure).toBeNull();
    await approveDeleteApproval(db, trash, r.id);
    expect(dismissDeleteApproval(db, r.id)).toBe(true);
    expect(listDeleteApprovals(db)).toEqual([]);
  });
  it('ゴミ箱へ移せないときは trash の理由になる。もう無い会話は消せたとして扱う', async () => {
    const r = req();
    expect(await approveDeleteApproval(db, { deleteSession: async () => { throw new DeleteError(500, msg('session.delete.running')); } }, r.id)).toBe('failed');
    expect(listDeleteApprovals(db)[0]!.failure).toBe('trash');
    req('t1', 200);
    expect(await approveDeleteApproval(db, { deleteSession: async () => { throw new DeleteError(404, msg('session.error.notFound')); } }, r.id)).toBe('deleted');
    expect(listDeleteApprovals(db)).toEqual([]);
  });
  it('断ると消さず、一覧から外れ、しばらくは再度の依頼も断られたまま。時間が過ぎれば頼める', async () => {
    const r = req(); const trash = { deleteSession: vi.fn(async () => undefined) };
    expect(rejectDeleteApproval(db, r.id, 500)).toBe(true);
    expect(listDeleteApprovals(db)).toEqual([]);
    expect(req('t1', 600).outcome).toBe('rejected');
    expect(listDeleteApprovals(db)).toEqual([]);
    expect(await approveDeleteApproval(db, trash, r.id)).toBe('missing');
    expect(trash.deleteSession).not.toHaveBeenCalled();
    expect(req('t1', 500 + REJECT_HOLD_MS + 1)).toMatchObject({ outcome: 'pending', created: true });
  });
  it('知らない id には何もしない', async () => {
    expect(await approveDeleteApproval(db, { deleteSession: async () => undefined }, 'nope')).toBe('missing');
    expect(rejectDeleteApproval(db, 'nope', 1)).toBe(false);
    expect(dismissDeleteApproval(db, 'nope')).toBe(false);
  });
  it('手で消した会話の依頼は一覧から外れ、戻しても蘇らない', () => {
    req();
    db.prepare("update sessions set deleted_at = 5 where id = 't1'").run();
    expect(listDeleteApprovals(db)).toEqual([]);
    db.prepare("update sessions set deleted_at = null where id = 't1'").run();
    expect(listDeleteApprovals(db)).toEqual([]);
  });
  it('依頼元が消えても一覧には出る（from は null）', () => {
    req(); db.prepare("update sessions set deleted_at = 5 where id = 'from'").run();
    expect(listDeleteApprovals(db)[0]!.from).toBeNull();
  });
  it('変えるたびに行の変化を知らせる', () => {
    const seen: string[] = []; const off = onRowChange((c) => { if (c.table === 'delete_approvals') seen.push(c.rowId); });
    const r = req(); rejectDeleteApproval(db, r.id, 1);
    off();
    expect(seen).toEqual([r.id, r.id]);
  });
});
