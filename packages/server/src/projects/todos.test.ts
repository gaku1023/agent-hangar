import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { addTodo, confirmTodo, listTodos, proposeTodoDone, rejectTodo, removeTodo, setTodoDone } from './todos.ts';

function seed() {
  const db = openDb(':memory:');
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'projects', { id: 'p2', name: 'beta', status: 'active', is_scratch: 0 }, 'd');
  // todos.session_id は sessions(id) への外部キーなので、紐付ける先を実際に作っておく。
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 's1', cwd: '/tmp/alpha', home_device: 'd' }, 'd');
  return db;
}

describe('todos', () => {
  it('追加は position を伸ばし、一覧は position 順', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: '  最初 ' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: '次', sessionId: 's1' });
    addTodo(db, 'd', { projectId: 'p2', text: '別' });
    expect(a).toMatchObject({ projectId: 'p1', text: '最初', done: false, position: 1, sessionId: null });
    expect(b).toMatchObject({ position: 2, sessionId: 's1' });
    expect(listTodos(db, 'p1').map((t) => t.text)).toEqual(['最初', '次']);
    expect(listTodos(db).map((t) => t.text)).toEqual(['最初', '次', '別']);
    expect(() => addTodo(db, 'd', { projectId: 'p1', text: '   ' })).toThrow();
  });
  it('完了の切り替えと削除。削除した番号は再利用しない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(setTodoDone(db, 'd', a.id, true)).toMatchObject({ id: a.id, done: true });
    expect(setTodoDone(db, 'd', 'nope', true)).toBeNull();
    expect(removeTodo(db, 'd', a.id)).toMatchObject({ id: a.id });
    expect(listTodos(db, 'p1')).toEqual([]);
    expect(removeTodo(db, 'd', a.id)).toBeNull();
    expect(addTodo(db, 'd', { projectId: 'p1', text: 'b' }).position).toBe(2);
    // 書き込みは 4 回だが、未送信の差分は同じ行ごとに 1 つへまとまる（design.md の「未送信の行は同じ (table_name, row_id) ごとに 1 行へまとめてよい」）。
    // 残るのは a の delete と b の upsert の 2 行である。
    const ops = db.prepare("select row_id, op from changes where table_name = 'todos' order by seq").all() as { row_id: string; op: string }[];
    expect(ops.map((o) => o.op)).toEqual(['delete', 'upsert']);
    expect(ops.map((o) => o.row_id)).toEqual([a.id, expect.any(String)]);
  });
});

describe('完了の候補', () => {
  const row = (db: ReturnType<typeof seed>, id: string) => db.prepare('select done, candidate_at, candidate_session_id, candidate_note, rejected_sessions from todos where id = ?').get(id);

  it('候補を出しても完了にはせず、出したセッションと根拠を持つ', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(a.candidate).toBeNull();
    const r = proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: '直して確かめた', now: 500 });
    expect(r).toEqual({ outcome: 'proposed', todo: expect.objectContaining({ id: a.id, done: false, candidate: { sessionId: 's1', note: '直して確かめた', at: 500 } }) });
    expect(row(db, a.id)).toEqual({ done: 0, candidate_at: 500, candidate_session_id: 's1', candidate_note: '直して確かめた', rejected_sessions: '[]' });
    expect(proposeTodoDone(db, 'd', 'nope', { sessionId: 's1', note: 'x' })).toBeNull();
  });

  it('すでに候補なら根拠を上書きせず、完了なら何もしない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: '最初の根拠', now: 500 });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: '書き換え', now: 900 })?.outcome).toBe('already_candidate');
    expect(row(db, a.id)).toMatchObject({ candidate_at: 500, candidate_note: '最初の根拠' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: 'b' });
    setTodoDone(db, 'd', b.id, true);
    expect(proposeTodoDone(db, 'd', b.id, { sessionId: 's1', note: 'x' })?.outcome).toBe('already_done');
    expect(row(db, b.id)).toMatchObject({ done: 1, candidate_at: null });
  });

  it('確定は完了にして候補を消す。完了済みは何もせず、候補でない未完は断る', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(confirmTodo(db, 'd', a.id)?.result).toBe('not_candidate');
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' });
    expect(confirmTodo(db, 'd', a.id)).toEqual({ result: 'confirmed', todo: expect.objectContaining({ done: true, candidate: null }) });
    expect(row(db, a.id)).toMatchObject({ done: 1, candidate_at: null, candidate_session_id: null, candidate_note: null });
    expect(confirmTodo(db, 'd', a.id)?.result).toBe('already_done');
    expect(confirmTodo(db, 'd', 'nope')).toBeNull();
  });

  it('却下は未完に戻し、出したセッションを一度だけ積み、同じセッションからは出し直せない', () => {
    const db = seed();
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 's2', cwd: '/tmp/alpha', home_device: 'd' }, 'd');
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(rejectTodo(db, 'd', a.id)?.result).toBe('not_candidate');
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' });
    expect(rejectTodo(db, 'd', a.id)).toEqual({ result: 'rejected', todo: expect.objectContaining({ done: false, candidate: null }) });
    expect(row(db, a.id)).toMatchObject({ done: 0, candidate_at: null, rejected_sessions: '["s1"]' });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'もう一度' })?.outcome).toBe('rejected_before');
    // 別のセッションなら出せる。そのセッションを却下すると積み足される。
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's2', note: '別' })?.outcome).toBe('proposed');
    rejectTodo(db, 'd', a.id);
    expect(row(db, a.id)).toMatchObject({ rejected_sessions: '["s1","s2"]' });
    expect(rejectTodo(db, 'd', 'nope')).toBeNull();
  });

  it('セッションの分からない候補は、却下しても積まないので出し直せる', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    proposeTodoDone(db, 'd', a.id, { sessionId: null, note: null });
    expect(listTodos(db, 'p1')[0]!.candidate).toMatchObject({ sessionId: null, note: null });
    rejectTodo(db, 'd', a.id);
    expect(row(db, a.id)).toMatchObject({ rejected_sessions: '[]' });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: null, note: null })?.outcome).toBe('proposed');
  });

  it('利用者がチェックを付け外しすると候補は消え、開き直しても却下の記録は残す', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' });
    rejectTodo(db, 'd', a.id);
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 's2', cwd: '/tmp/alpha', home_device: 'd' }, 'd');
    proposeTodoDone(db, 'd', a.id, { sessionId: 's2', note: 'n' });
    expect(setTodoDone(db, 'd', a.id, true)).toMatchObject({ done: true, candidate: null });
    expect(setTodoDone(db, 'd', a.id, false)).toMatchObject({ done: false, candidate: null });
    expect(row(db, a.id)).toMatchObject({ candidate_at: null, rejected_sessions: '["s1"]' });
  });

  it('完了かつ候補という矛盾した行は、完了として読み、候補は無いものとする', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    // 同期でしか起きない形を直接作る。
    db.prepare('update todos set done = 1, candidate_at = 5, candidate_session_id = ? where id = ?').run('s1', a.id);
    expect(listTodos(db, 'p1')[0]).toMatchObject({ done: true, candidate: null });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' })?.outcome).toBe('already_done');
    expect(confirmTodo(db, 'd', a.id)?.result).toBe('already_done');
  });

  it('rejected_sessions が壊れていても投げずに空として読む', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    db.prepare("update todos set rejected_sessions = 'not json' where id = ?").run(a.id);
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' })?.outcome).toBe('proposed');
  });
});
