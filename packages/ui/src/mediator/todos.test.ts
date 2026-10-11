import { describe, expect, it } from 'vitest';
import type { TodoDto } from '@agent-hangar/shared';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { TODO_UNDO_MAX } from './todos.ts';

const todo = (id: string, o: Partial<TodoDto> = {}): TodoDto => ({ id, projectId: 'p1', text: id, done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null, suggestion: null, ...o });
const storeWith = (...todos: TodoDto[]): Store => ({ ...initialStore(), todos: Object.fromEntries(todos.map((t) => [t.id, t])) });
const action = (i: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: i });

function run(store: Store, inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, store, i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}

describe('TODO の操作と取り消し', () => {
  it('完了の切り替えは、今の値の逆を送り、前の行を積む', () => {
    const t = todo('a');
    const r = run(storeWith(t), [action({ type: 'todo.toggle', id: 'a' })]);
    expect(r.effects).toEqual([{ kind: 'api.todo', call: { op: 'setDone', id: 'a', done: true } }]);
    expect(r.state.todoUndo).toEqual([{ projectId: 'p1', rows: [t], removed: null }]);
  });

  it('完了の候補の欄を押したときは確定にする（素直に反転すると done: false を送って何も起きない）', () => {
    const t = todo('a', { candidate: { sessionId: 's', note: 'n', at: 1 } });
    const r = run(storeWith(t), [action({ type: 'todo.toggle', id: 'a' })]);
    expect(r.effects).toEqual([{ kind: 'api.todo', call: { op: 'confirm', id: 'a' } }]);
  });

  it('Store に無い TODO には何もしない', () => {
    const r = run(storeWith(), [action({ type: 'todo.toggle', id: 'x' }), action({ type: 'todo.remove', id: 'x' }), action({ type: 'todo.edit', id: 'x', text: 'y' })]);
    expect(r.effects).toEqual([]);
    expect(r.state.todoUndo).toEqual([]);
  });

  it('文言の編集は前後の空白を落として送る。同じ文言や空の文言では何もしない', () => {
    const t = todo('a', { text: '前' });
    const store = storeWith(t);
    expect(run(store, [action({ type: 'todo.edit', id: 'a', text: '  後 ' })]).effects).toEqual([{ kind: 'api.todo', call: { op: 'edit', id: 'a', text: '後' } }]);
    expect(run(store, [action({ type: 'todo.edit', id: 'a', text: '前 ' })]).effects).toEqual([]);
    expect(run(store, [action({ type: 'todo.edit', id: 'a', text: '  ' })]).effects).toEqual([]);
  });

  it('消すときは、消した TODO の ID を添えて積む', () => {
    const t = todo('a');
    const r = run(storeWith(t), [action({ type: 'todo.remove', id: 'a' })]);
    expect(r.effects).toEqual([{ kind: 'api.todo', call: { op: 'remove', id: 'a' } }]);
    expect(r.state.todoUndo).toEqual([{ projectId: 'p1', rows: [t], removed: 'a' }]);
  });

  it('並べ替えは新しい並びを送り、並びにある行の前の形を積む', () => {
    const a = todo('a', { position: 1 }), b = todo('b', { position: 2 });
    const r = run(storeWith(a, b), [action({ type: 'todo.move', projectId: 'p1', ids: ['b', 'a'] })]);
    expect(r.effects).toEqual([{ kind: 'api.todo', call: { op: 'reorder', projectId: 'p1', ids: ['b', 'a'] } }]);
    expect(r.state.todoUndo).toEqual([{ projectId: 'p1', rows: [b, a], removed: null }]);
  });

  it('提案の受け入れと見送り、完了の候補の確定と却下も積む', () => {
    const s = todo('s', { suggestion: { note: null, at: 1 } }), c = todo('c', { candidate: { sessionId: null, note: null, at: 1 } });
    const r = run(storeWith(s, c), [action({ type: 'todo.accept', id: 's' }), action({ type: 'todo.dismiss', id: 's' }), action({ type: 'todo.confirm', id: 'c' }), action({ type: 'todo.reject', id: 'c' })]);
    expect(r.effects).toEqual([
      { kind: 'api.todo', call: { op: 'accept', id: 's' } },
      { kind: 'api.todo', call: { op: 'remove', id: 's' } },
      { kind: 'api.todo', call: { op: 'confirm', id: 'c' } },
      { kind: 'api.todo', call: { op: 'reject', id: 'c' } },
    ]);
    expect(r.state.todoUndo.map((u) => u.removed)).toEqual([null, 's', null, null]);
  });

  it('戻すと、そのプロジェクトの最後の操作の前の形を書き戻し、積みから外す', () => {
    const a = todo('a'), b = todo('b', { projectId: 'p2' });
    const store = storeWith(a, b);
    const r = run(store, [action({ type: 'todo.toggle', id: 'a' }), action({ type: 'todo.toggle', id: 'b' }), action({ type: 'todo.undo', projectId: 'p1' })]);
    expect(r.effects.at(-1)).toEqual({ kind: 'api.todo', call: { op: 'restore', rows: [a] } });
    expect(r.state.todoUndo).toEqual([{ projectId: 'p2', rows: [b], removed: null }]);
  });

  it('todoId を添えると、その TODO を消した操作を戻す（帯の「元に戻す」）', () => {
    const a = todo('a'), b = todo('b');
    const r = run(storeWith(a, b), [action({ type: 'todo.remove', id: 'a' }), action({ type: 'todo.toggle', id: 'b' }), action({ type: 'todo.undo', projectId: 'p1', todoId: 'a' })]);
    expect(r.effects.at(-1)).toEqual({ kind: 'api.todo', call: { op: 'restore', rows: [a] } });
    expect(r.state.todoUndo.map((u) => u.rows[0]!.id)).toEqual(['b']);
  });

  it('戻すものが無ければ何もしない', () => {
    expect(run(storeWith(), [action({ type: 'todo.undo', projectId: 'p1' })]).effects).toEqual([]);
  });

  it(`積みは新しい ${TODO_UNDO_MAX} 件までにする`, () => {
    const t = todo('a');
    const inputs = Array.from({ length: TODO_UNDO_MAX + 5 }, () => action({ type: 'todo.toggle', id: 'a' }));
    expect(run(storeWith(t), inputs).state.todoUndo).toHaveLength(TODO_UNDO_MAX);
  });
});
