import type { Hono } from 'hono';
import type { TodoCandidateDto, TodoDto, TodoSuggestionDto } from '@agent-hangar/shared';
import { acceptTodo, addTodo, confirmTodo, listTodos, rejectTodo, removeTodo, reorderTodos, restoreTodos, setTodoDone, setTodoText } from '../../projects/todos.ts';
import { translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, projectOf, readJson, tooLargeResult } from './common.ts';

/** TODO の経路が使う依存。 */
export type TodoRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live'> & LanguageDeps;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);

/**
 * 取り消しで戻す TODO の 1 行を検査して取り出す。崩れていれば null を返し、呼び手は 400 にする。
 * 読むのは id、projectId、text、done、position、candidate、suggestion だけで、sessionId と updatedAt は戻さないので見ない。
 */
function restoreRowOf(v: unknown): TodoDto | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isStr(o.id) || !isStr(o.projectId) || !isStr(o.text) || typeof o.done !== 'boolean' || !Number.isInteger(o.position)) return null;
  const c = o.candidate as Record<string, unknown> | null | undefined;
  const s = o.suggestion as Record<string, unknown> | null | undefined;
  if (c !== null && (typeof c !== 'object' || !isStrOrNull(c.sessionId) || !isStrOrNull(c.note) || !isNum(c.at))) return null;
  if (s !== null && (typeof s !== 'object' || !isStrOrNull(s.note) || !isNum(s.at))) return null;
  return {
    id: o.id, projectId: o.projectId, text: o.text, done: o.done, position: o.position as number,
    sessionId: null, updatedAt: 0,
    candidate: c ? (c as TodoCandidateDto) : null,
    suggestion: s ? (s as TodoSuggestionDto) : null,
  };
}

/** TODO の経路。一覧、追加、文言と完了の書き換え、並べ替え、完了の候補の確定と却下、提案の受け入れ、削除、取り消しを持つ。 */
export function todoRoutes(api: Hono, deps: TodoRouteDeps): void {
  const tr = translatorOf(deps.language);
  const { db, deviceId } = deps;
  const requireProject = projectOf(deps);

  // TODO。変更のたびに、一覧とプロジェクト（未完の数）を、書いた行から配る層が配る。
  api.get('/projects/:id/todos', (c) => {
    const id = c.req.param('id');
    return requireProject(id) ? c.json(listTodos(db, id)) : c.json({ error: tr('project.error.notFound') }, 404);
  });
  api.post('/projects/:id/todos', async (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: tr('project.error.notFound') }, 404);
    const b = await readJson(c, BODY_LIMITS.todo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.todo, tr);
    const body = (b.value ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) return c.json({ error: tr('common.field.required', { field: 'text' }) }, 400);
    return c.json(addTodo(db, deviceId, { projectId: id, text: body.text }), 201);
  });
  // 並べ替え。ids は、そのプロジェクトの未完（提案を除く）の新しい並びで、そのプロジェクトの一覧を返す。
  // 画面の一覧が古く、今の行と合わない ID が混ざるときは 409 で、何も書かない。
  api.post('/projects/:id/todos/order', async (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: tr('project.error.notFound') }, 404);
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids) || !body.ids.every(isStr)) return c.json({ error: tr('common.field.send', { field: 'ids' }) }, 400);
    const todos = reorderTodos(db, deviceId, id, body.ids);
    if (!todos) return c.json({ error: tr('todo.error.orderMismatch') }, 409);
    return c.json(todos);
  });
  // 文言と完了の書き換え。どちらか、または両方を受ける。
  // 提案の行は、完了を付け外しできない（409）。そのときは文言も書かない。
  api.patch('/todos/:id', async (c) => {
    const b = await readJson(c, BODY_LIMITS.todo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.todo, tr);
    const body = (b.value ?? {}) as { done?: unknown; text?: unknown };
    if (body.done === undefined && body.text === undefined) return c.json({ error: tr('todo.error.patchEmpty') }, 400);
    if (body.done !== undefined && typeof body.done !== 'boolean') return c.json({ error: tr('common.field.mustBeBoolean', { field: 'done' }) }, 400);
    if (body.text !== undefined && typeof body.text !== 'string') return c.json({ error: tr('common.field.mustBeString', { field: 'text' }) }, 400);
    if (typeof body.text === 'string' && !body.text.trim()) return c.json({ error: tr('todo.error.emptyText') }, 400);
    const { done, text } = body as { done?: boolean; text?: string };
    const r = db.transaction((): TodoDto | 'not_found' | 'not_accepted' => {
      let t: TodoDto | null = null;
      if (done !== undefined) {
        t = setTodoDone(db, deviceId, c.req.param('id'), done);
        if (t?.suggestion) return 'not_accepted';
      }
      if (text !== undefined) t = setTodoText(db, deviceId, c.req.param('id'), text);
      return t ?? 'not_found';
    })();
    if (r === 'not_found') return c.json({ error: tr('todo.error.notFound') }, 404);
    if (r === 'not_accepted') return c.json({ error: tr('todo.error.notAccepted') }, 409);
    return c.json(r);
  });
  // 完了の候補の確定と却下。どちらも利用者の操作で、MCP からは呼べない。
  const notCandidate = () => tr('todo.error.notCandidate');
  api.post('/todos/:id/confirm', (c) => {
    const r = confirmTodo(db, deviceId, c.req.param('id'));
    if (!r) return c.json({ error: tr('todo.error.notFound') }, 404);
    if (r.result === 'not_accepted') return c.json({ error: tr('todo.error.notAccepted') }, 409);
    if (r.result === 'not_candidate') return c.json({ error: notCandidate() }, 409);
    return c.json(r.todo);
  });
  api.post('/todos/:id/reject', (c) => {
    const r = rejectTodo(db, deviceId, c.req.param('id'));
    if (!r) return c.json({ error: tr('todo.error.notFound') }, 404);
    if (r.result === 'not_candidate') return c.json({ error: notCandidate() }, 409);
    return c.json(r.todo);
  });
  // Claude の提案の受け入れ。利用者の操作で、MCP からは呼べない。見送りは DELETE（論理削除）で行う。
  api.post('/todos/:id/accept', (c) => {
    const r = acceptTodo(db, deviceId, c.req.param('id'));
    if (!r) return c.json({ error: tr('todo.error.notFound') }, 404);
    if (r.result === 'not_suggestion') return c.json({ error: tr('todo.error.notSuggestion') }, 409);
    return c.json(r.todo);
  });
  // 画面の取り消し（⌘Z）。渡した TODO の中身へ戻し、消した行は生き返らせる。
  // 見つからない行か、プロジェクトの違う行が混ざれば 409 で、何も書かない。
  api.post('/todos/restore', async (c) => {
    const b = await readJson(c, BODY_LIMITS.todoRestore);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.todoRestore, tr);
    const body = (b.value ?? {}) as { todos?: unknown };
    if (!Array.isArray(body.todos)) return c.json({ error: tr('common.field.send', { field: 'todos' }) }, 400);
    const rows = body.todos.map(restoreRowOf);
    if (rows.some((r) => r === null)) return c.json({ error: tr('common.field.send', { field: 'todos' }) }, 400);
    if (rows.some((r) => !r!.text.trim())) return c.json({ error: tr('todo.error.emptyText') }, 400);
    const todos = restoreTodos(db, deviceId, rows as TodoDto[]);
    if (!todos) return c.json({ error: tr('todo.error.restoreMismatch') }, 409);
    return c.json(todos);
  });
  api.delete('/todos/:id', (c) => {
    const t = removeTodo(db, deviceId, c.req.param('id'));
    if (!t) return c.json({ error: tr('todo.error.notFound') }, 404);
    return c.json(t);
  });
}
