import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import type { MemoStore } from '../../projects/memo.ts';
import { proposeTodoDone } from '../../projects/todos.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// TODO の経路（routes/todos.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let db: Db;
let sent: ServerEvent[];
let memos: MemoStore;
/** ワークスペースから登録される唯一のプロジェクト alpha の id。 */
let list0ProjectId: () => string;
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  t = await testDeps();
  ({ db, memos } = t);
  sent = t.events; list0ProjectId = t.alphaProjectId;
  app = createApp(t.deps);
});
afterEach(() => { t.dispose(); });

describe('routes', () => {
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  it('TODO とメモ', async () => {
    const pid = list0ProjectId();
    const a = await post(`/api/projects/${pid}/todos`, { text: '最初' });
    expect(a.status).toBe(201);
    const todo = await a.json();
    expect(todo).toMatchObject({ projectId: pid, text: '最初', done: false, position: 1 });
    expect(sent.at(-2)).toMatchObject({ type: 'todos.update', projectId: pid, todos: [{ id: todo.id }] });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: pid, openTodoCount: 1 } });
    expect((await post(`/api/projects/${pid}/todos`, { text: '  ' })).status).toBe(400);
    expect((await post('/api/projects/nope/todos', { text: 'x' })).status).toBe(404);
    expect((await (await post(`/api/todos/${todo.id}`, { done: true }, 'PATCH')).json()).done).toBe(true);
    expect((await post('/api/todos/nope', { done: true }, 'PATCH')).status).toBe(404);
    expect((await json(await get(`/api/projects/${pid}/todos`))).body).toHaveLength(1);
    expect((await app.request(`/api/todos/${todo.id}`, { method: 'DELETE', headers: H })).status).toBe(200);
    expect((await json(await get(`/api/projects/${pid}/todos`))).body).toEqual([]);
    expect((await json(await get(`/api/projects/${pid}/memo`))).body).toEqual({ projectId: pid, markdown: '', updatedAt: 0 });
    const m = await post(`/api/projects/${pid}/memo`, { markdown: '# alpha\n本文' }, 'PUT');
    expect((await m.json()).markdown).toBe('# alpha\n本文');
    expect(sent.at(-2)).toMatchObject({ type: 'memo.update', memo: { projectId: pid } });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { memoHead: '# alpha' } });
    expect(fs.readFileSync(memos.memoPath(pid), 'utf8')).toBe('# alpha\n本文');
    expect((await post(`/api/projects/${pid}/memo`, { markdown: 3 }, 'PUT')).status).toBe(400);
  });
  it('TODO の候補の確定と却下', async () => {
    const pid = list0ProjectId();
    const a = await (await post(`/api/projects/${pid}/todos`, { text: 'a' })).json();
    const b = await (await post(`/api/projects/${pid}/todos`, { text: 'b' })).json();
    // 候補でない未完は、確定も却下も 409 で断る。本文はトーストに出せる一文にする。
    const c409 = await post(`/api/todos/${a.id}/confirm`);
    expect(c409.status).toBe(409);
    expect((await c409.json()).error).toBe('この TODO は完了の候補ではありません');
    expect((await post(`/api/todos/${a.id}/reject`)).status).toBe(409);
    expect((await post('/api/todos/nope/confirm')).status).toBe(404);
    expect((await post('/api/todos/nope/reject')).status).toBe(404);

    proposeTodoDone(db, 'd', a.id, { sessionId: null, note: '直した' });
    proposeTodoDone(db, 'd', b.id, { sessionId: null, note: '直した' });
    sent.length = 0;
    const ok = await post(`/api/todos/${a.id}/confirm`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: a.id, done: true, candidate: null });
    expect(sent.map((e) => e.type)).toEqual(['todos.update', 'project.upsert']);
    // すでに完了なら何もせず 200。何も配らない。
    sent.length = 0;
    expect((await post(`/api/todos/${a.id}/confirm`)).status).toBe(200);
    expect(sent).toEqual([]);

    sent.length = 0;
    const rj = await post(`/api/todos/${b.id}/reject`);
    expect(rj.status).toBe(200);
    expect(sent.map((e) => e.type)).toEqual(['todos.update', 'project.upsert']);
    expect(await rj.json()).toMatchObject({ id: b.id, done: false, candidate: null });
    expect((await post(`/api/todos/${b.id}/reject`)).status).toBe(409);

    // 利用者のチェックの付け外しは候補を消す。
    proposeTodoDone(db, 'd', b.id, { sessionId: null, note: 'もう一度' });
    expect(await (await post(`/api/todos/${b.id}`, { done: false }, 'PATCH')).json()).toMatchObject({ done: false, candidate: null });
  });
});

// 経路は行を書くだけで、画面へのイベントは配る層（events/publisher.ts）が組む。
// 書いた行のイベントが、1 回だけ、最新の中身で届くことを経路ごとに押さえる。
describe('書いた行のイベントは配る層から届く', () => {
  const send = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  describe('TODO、メモ、アーティファクト', () => {
    it('TODO を足す、完了にする、消す、のどれでも一覧と未完の数が 1 回ずつ届く', async () => {
      const pid = list0ProjectId();
      const todo = await (await send(`/api/projects/${pid}/todos`, { text: 'やる' })).json();
      expect(sent).toEqual([
        { type: 'todos.update', projectId: pid, todos: [expect.objectContaining({ id: todo.id, done: false })] },
        { type: 'project.upsert', project: expect.objectContaining({ id: pid, openTodoCount: 1 }) },
      ]);
      sent.length = 0;
      await send(`/api/todos/${todo.id}`, { done: true }, 'PATCH');
      expect(sent).toEqual([
        { type: 'todos.update', projectId: pid, todos: [expect.objectContaining({ id: todo.id, done: true })] },
        { type: 'project.upsert', project: expect.objectContaining({ id: pid, openTodoCount: 0 }) },
      ]);
      sent.length = 0;
      await send(`/api/todos/${todo.id}`, undefined, 'DELETE');
      expect(sent).toEqual([{ type: 'todos.update', projectId: pid, todos: [] }, { type: 'project.upsert', project: expect.objectContaining({ id: pid }) }]);
    });
  });
});
