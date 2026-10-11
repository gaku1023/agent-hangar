import type { TodoDto } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import type { Input, State, Step, TodoCall, TodoUndoEntry } from './types.ts';

/** 取り消しの積みの上限。古いものから捨てる。 */
export const TODO_UNDO_MAX = 30;

/** 操作の前の形を積み、API を 1 回呼ぶ。 */
function done(state: State, rows: TodoDto[], removed: string | null, call: TodoCall): Step {
  const entry: TodoUndoEntry = { projectId: rows[0]!.projectId, rows, removed };
  return { state: { ...state, todoUndo: [...state.todoUndo, entry].slice(-TODO_UNDO_MAX) }, effects: [{ kind: 'api.todo', call }] };
}

/**
 * todos 領域：TODO の操作と、その取り消し（⌘Z と、消した場所の帯の「元に戻す」）。
 * 操作の前の行の写しを積み、戻すときはサーバへ写しのまま書き戻す（POST /api/todos/restore）。
 * 逆の操作を組み立てない。完了の候補を確定した後の「戻す」で候補まで戻すには、写しを書き戻すのが一番確かだからである。
 * 写しは Store から取る。Store に無い TODO（消えた後に届いた操作）には何もしない。
 */
export function todosStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind !== 'action') return null;
  const i = input.action;
  const row = (id: string) => store.todos[id];
  const none: Step = { state, effects: [] };
  switch (i.type) {
    case 'todo.toggle': {
      const t = row(i.id);
      if (!t) return none;
      // 候補の欄を押したときは確定と同じに扱う。候補は未完なので、素直に反転すると done: false を送って何も起きない。
      return done(state, [t], null, t.candidate && !t.done ? { op: 'confirm', id: t.id } : { op: 'setDone', id: t.id, done: !t.done });
    }
    case 'todo.edit': {
      const t = row(i.id);
      const text = i.text.trim();
      // 空にして確定したときは、View が todo.remove を出す。ここへ空が届いても消さない。
      if (!t || !text || text === t.text) return none;
      return done(state, [t], null, { op: 'edit', id: t.id, text });
    }
    case 'todo.remove': case 'todo.dismiss': {
      const t = row(i.id);
      return t ? done(state, [t], t.id, { op: 'remove', id: t.id }) : none;
    }
    case 'todo.move': {
      const rows = i.ids.map(row).filter((t): t is TodoDto => !!t && t.projectId === i.projectId);
      return rows.length ? done(state, rows, null, { op: 'reorder', projectId: i.projectId, ids: i.ids }) : none;
    }
    case 'todo.confirm': case 'todo.reject': case 'todo.accept': {
      const t = row(i.id);
      const op = i.type === 'todo.confirm' ? 'confirm' : i.type === 'todo.reject' ? 'reject' : 'accept';
      return t ? done(state, [t], null, { op, id: t.id }) : none;
    }
    case 'todo.undo': {
      let at = -1;
      for (let k = state.todoUndo.length - 1; k >= 0; k--) {
        const u = state.todoUndo[k]!;
        if (u.projectId === i.projectId && (i.todoId === undefined || u.removed === i.todoId)) { at = k; break; }
      }
      if (at < 0) return none;
      const u = state.todoUndo[at]!;
      return { state: { ...state, todoUndo: state.todoUndo.filter((_, k) => k !== at) }, effects: [{ kind: 'api.todo', call: { op: 'restore', rows: u.rows } }] };
    }
    default: return null;
  }
}
