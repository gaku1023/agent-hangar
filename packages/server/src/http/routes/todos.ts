import type { Hono } from 'hono';
import { addTodo, confirmTodo, listTodos, rejectTodo, removeTodo, setTodoDone } from '../../projects/todos.ts';
import type { AppDeps } from '../deps.ts';
import { BODY_LIMITS, projectOf, readJson, tooLargeResult } from './common.ts';

/** TODO の経路が使う依存。 */
export type TodoRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live'>;

/** TODO の経路。一覧、追加、完了の切り替え、完了の候補の確定と却下、削除を持つ。 */
export function todoRoutes(api: Hono, deps: TodoRouteDeps): void {
  const { db, deviceId } = deps;
  const requireProject = projectOf(deps);

  // TODO。変更のたびに、一覧とプロジェクト（未完の数）を、書いた行から配る層が配る。
  api.get('/projects/:id/todos', (c) => {
    const id = c.req.param('id');
    return requireProject(id) ? c.json(listTodos(db, id)) : c.json({ error: 'プロジェクトが見つかりません' }, 404);
  });
  api.post('/projects/:id/todos', async (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    const b = await readJson(c, BODY_LIMITS.todo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.todo);
    const body = (b.value ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) return c.json({ error: 'text は必須です' }, 400);
    return c.json(addTodo(db, deviceId, { projectId: id, text: body.text }), 201);
  });
  api.patch('/todos/:id', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { done?: unknown };
    if (typeof body.done !== 'boolean') return c.json({ error: 'done は true か false です' }, 400);
    const t = setTodoDone(db, deviceId, c.req.param('id'), body.done);
    if (!t) return c.json({ error: 'TODO が見つかりません' }, 404);
    return c.json(t);
  });
  // 完了の候補の確定と却下。どちらも利用者の操作で、MCP からは呼べない。
  const NOT_CANDIDATE = 'この TODO は完了の候補ではありません';
  api.post('/todos/:id/confirm', (c) => {
    const r = confirmTodo(db, deviceId, c.req.param('id'));
    if (!r) return c.json({ error: 'TODO が見つかりません' }, 404);
    if (r.result === 'not_candidate') return c.json({ error: NOT_CANDIDATE }, 409);
    return c.json(r.todo);
  });
  api.post('/todos/:id/reject', (c) => {
    const r = rejectTodo(db, deviceId, c.req.param('id'));
    if (!r) return c.json({ error: 'TODO が見つかりません' }, 404);
    if (r.result === 'not_candidate') return c.json({ error: NOT_CANDIDATE }, 409);
    return c.json(r.todo);
  });
  api.delete('/todos/:id', (c) => {
    const t = removeTodo(db, deviceId, c.req.param('id'));
    if (!t) return c.json({ error: 'TODO が見つかりません' }, 404);
    return c.json(t);
  });
}
