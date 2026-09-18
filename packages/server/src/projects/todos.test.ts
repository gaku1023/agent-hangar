import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { addTodo, listTodos, removeTodo, setTodoDone } from './todos.ts';

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
