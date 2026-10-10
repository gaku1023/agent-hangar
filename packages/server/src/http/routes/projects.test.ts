import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFakeTool } from '../../../test/fake-bin.ts';
import type { ServerEvent } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { SESSION_OTHER } from '../../../test/fixtures.ts';
import { createApp, type AppDeps } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// プロジェクトの経路（routes/projects.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let dir: string;
let db: Db;
let ws: string;
let deps: AppDeps;
let sent: ServerEvent[];
/** ワークスペースから登録される唯一のプロジェクト alpha の id。 */
let list0ProjectId: () => string;
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

/** 実行できる空のファイルを ws/bin に置く。パスの欄は保存の前に存在と実行権を確かめるので、実物が要る。 */
const exe = (name: string): string => writeFakeTool(path.join(ws, 'bin'), name, { sh: '', cmd: '' });

beforeEach(async () => {
  t = await testDeps();
  ({ db, ws, deps } = t);
  dir = t.claudeDir; sent = t.events; list0ProjectId = t.alphaProjectId;
  app = createApp(deps);
});
afterEach(() => { t.dispose(); });

describe('routes', () => {
  it('プロジェクトの取得、状態変更、候補、解決', async () => {
    const { body: list } = await json(await get('/api/projects'));
    const id = list[0].id;
    expect((await json(await get(`/api/projects/${id}`))).body.name).toBe('alpha');
    const r = await app.request(`/api/projects/${id}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'paused' }) });
    expect((await r.json()).status).toBe('paused');
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id, status: 'paused' } });
    expect((await json(await get(`/api/projects/${id}/candidates?name=alp`))).body).toEqual([path.join(ws, 'alpha')]);
    const r2 = await app.request(`/api/projects/${id}/resolve`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'archive' }) });
    expect((await r2.json()).status).toBe('archived');
    expect((await get('/api/projects/nope')).status).toBe(404);
    const bad = await app.request(`/api/projects/${id}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'bogus' }) });
    expect(bad.status).toBe(400);
  });
  it('名前の変更は PATCH の name で行い、前後の空白を除き、変更を配る。空の名前は断る', async () => {
    const id = list0ProjectId();
    const patch = (body: unknown) => app.request(`/api/projects/${id}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await patch({ name: '  お店の画面  ' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id, name: 'お店の画面', status: 'active' });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id, name: 'お店の画面' } });
    // 名前と状態は一緒に変えられる。
    expect(await (await patch({ name: 'shop', status: 'paused' })).json()).toMatchObject({ name: 'shop', status: 'paused' });
    // 空の名前、文字列でない名前、何も変えない本文は 400。
    for (const bad of [{ name: '   ' }, { name: 3 }, {}]) expect((await patch(bad)).status).toBe(400);
    expect((await json(await get(`/api/projects/${id}`))).body.name).toBe('shop');
  });
  it('プロジェクトの作成', async () => {
    fs.mkdirSync(path.join(ws, 'beta'));
    const r = await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'beta', path: path.join(ws, 'beta') }) });
    expect(r.status).toBe(201);
    const p = await r.json();
    expect(p).toMatchObject({ name: 'beta', path: path.join(ws, 'beta'), resolved: true, status: 'active' });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: p.id } });
    expect((await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'x', path: '/nonexistent' }) })).status).toBe(400);
    expect((await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: '', path: ws }) })).status).toBe(400);
    // .. を含むパスは正規化してから入れる。生のまま入れると前方一致でセッションが当たらなくなる。
    const again = await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'beta again', path: path.join(ws, 'beta') + path.sep + '..' + path.sep + 'beta' }) });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(p.id);
    expect(db.prepare('select count(*) c from project_roots where deleted_at is null').get()).toEqual({ c: 2 });
    expect(db.prepare("select count(*) c from project_roots where path like '%..%'").get()).toEqual({ c: 0 });
  });
  const postProject = (body: unknown) => app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('新しいフォルダを作ってプロジェクトにする', async () => {
    const gitInit = vi.fn();
    app = createApp({ ...deps, gitInit });
    const r = await postProject({ kind: 'newDir', name: 'fresh', gitInit: true });
    expect(r.status).toBe(201);
    const p = await r.json();
    expect(p).toMatchObject({ name: 'fresh', path: path.join(ws, 'fresh'), resolved: true, status: 'active' });
    expect(gitInit).toHaveBeenCalledWith(path.join(ws, 'fresh'));
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: p.id } });
    expect((await postProject({ kind: 'newDir', name: 'fresh', gitInit: false })).status).toBe(409);
    const bad = await postProject({ kind: 'newDir', name: 'a/b', gitInit: false });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('名前はディレクトリ名として使える 1 字以上で、/ を含められません');
    expect((await postProject({ kind: 'newDir', gitInit: false })).status).toBe(400);
  });
  it('kind が dir なら既存のフォルダを登録し、名前を省けば basename にする', async () => {
    fs.mkdirSync(`${ws}/gamma`);
    const r = await postProject({ kind: 'dir', path: `${ws}/gamma` });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: 'gamma', path: path.join(ws, 'gamma') });
    expect((await postProject({ kind: 'other', path: ws })).status).toBe(400);
  });
  it('kind の無い本文は断る', async () => {
    fs.mkdirSync(`${ws}/gamma`);
    const r = await postProject({ name: 'gamma', path: `${ws}/gamma` });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('kind は newDir か dir です');
  });
  it('未登録のフォルダの一覧を返す', async () => {
    fs.mkdirSync(`${ws}/delta`);
    fs.mkdirSync(`${ws}/.secret`);
    const r = await get('/api/workspace/dirs');
    expect(r.status).toBe(200);
    const names = ((await r.json()) as { name: string }[]).map((d) => d.name);
    // alpha は beforeEach で登録済み。bin は exe() で作られることがある。
    expect(names).toContain('delta');
    expect(names).not.toContain('alpha');
    expect(names).not.toContain('.secret');
  });
  // 末尾の / や .. を生のまま入れると project_roots の前方一致に cwd が当たらず、
  // 直したつもりのプロジェクトにセッションが一件も紐づかない。
  it('repoint は正規化したパスを入れ、セッションが紐づく', async () => {
    const id = list0ProjectId();
    const moved = path.join(ws, 'moved');
    fs.mkdirSync(path.join(moved, 'src'), { recursive: true });
    // 紐づけ直しが動くのは未分類のセッションだけなので、1 件を moved の下に置く。
    const other = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_OTHER) as { id: string }).id;
    db.prepare('update sessions set cwd = ?, project_id = null where id = ?').run(path.join(moved, 'src'), other);
    const r = await post(`/api/projects/${id}/resolve`, { kind: 'repoint', path: `${path.join(ws, 'alpha', '..', 'moved')}/` });
    expect(r.status).toBe(200);
    expect(db.prepare('select path from project_roots where project_id = ? and deleted_at is null').get(id)).toEqual({ path: moved });
    expect((await json(await get(`/api/sessions/${other}`))).body.projectId).toBe(id);
  });
  // Windows のファイルシステムは大文字小文字を区別しない。綴り違いで同じフォルダを二重に登録しない。
  it.runIf(process.platform === 'win32')('Windows では、綴りの大文字小文字が違う同じフォルダを二重に登録しない', async () => {
    const post = (p: string) => app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'gamma', path: p }) });
    fs.mkdirSync(path.join(ws, 'gamma'));
    const first = await post(path.join(ws, 'gamma'));
    expect(first.status).toBe(201);
    const again = await post(path.join(ws, 'gamma').toUpperCase());
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe((await first.json()).id);
  });
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
});

// 経路は行を書くだけで、画面へのイベントは配る層（events/publisher.ts）が組む。
// 書いた行のイベントが、1 回だけ、最新の中身で届くことを経路ごとに押さえる。
describe('書いた行のイベントは配る層から届く', () => {
  const send = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const of = <T extends ServerEvent['type']>(type: T) => sent.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);
  const sessionsOf = async () => (await json(await get('/api/sessions'))).body as { id: string; projectId: string | null; providerSessionId: string }[];

  describe('プロジェクト', () => {
    it('状態を変えると、その project.upsert が 1 回だけ届く', async () => {
      const id = list0ProjectId();
      await send(`/api/projects/${id}`, { status: 'paused' }, 'PATCH');
      expect(sent).toEqual([{ type: 'project.upsert', project: expect.objectContaining({ id, status: 'paused' }) }]);
    });

    it('置き場を選び直すと、プロジェクトと、紐づけが変わったセッションだけが届く', async () => {
      const id = list0ProjectId();
      const all = await sessionsOf();
      const orphan = all.find((s) => s.projectId === null)!;
      const moved = path.join(ws, 'moved');
      fs.mkdirSync(moved);
      db.prepare('update sessions set cwd = ? where id = ?').run(moved, orphan.id);
      const r = await send(`/api/projects/${id}/resolve`, { kind: 'repoint', path: moved });
      expect(r.status).toBe(200);
      expect(of('project.upsert')).toEqual([{ type: 'project.upsert', project: expect.objectContaining({ id, path: moved, resolved: true }) }]);
      // 以前は絞り込めずに全件を流していた。紐づけが変わった 1 件だけになる。
      expect(of('session.upsert')).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id: orphan.id, projectId: id }) }]);
    });

    it('一覧から外すと、未分類に戻ったセッションが届き、消えたプロジェクトは届かない', async () => {
      const id = list0ProjectId();
      const mine = (await sessionsOf()).filter((s) => s.projectId === id).map((s) => s.id).sort();
      expect(mine.length).toBeGreaterThan(0);
      const r = await send(`/api/projects/${id}/resolve`, { kind: 'unlink' });
      expect(await r.json()).toEqual({ id, unlinked: true });
      expect(of('project.upsert')).toEqual([]);
      expect(of('session.upsert').map((e) => e.session.id).sort()).toEqual(mine);
      expect(of('session.upsert').every((e) => e.session.projectId === null)).toBe(true);
    });

    it('登録済みのフォルダを登録し直しても、行が変わらなければ何も届かない。アーカイブから戻したときは届く', async () => {
      const id = list0ProjectId();
      const again = await send('/api/projects', { kind: 'dir', path: path.join(ws, 'alpha') });
      expect(again.status).toBe(200);
      expect(sent).toEqual([]);
      await send(`/api/projects/${id}`, { status: 'archived' }, 'PATCH');
      sent.length = 0;
      await send('/api/projects', { kind: 'dir', path: path.join(ws, 'alpha') });
      expect(sent).toEqual([{ type: 'project.upsert', project: expect.objectContaining({ id, status: 'active' }) }]);
    });

    it('新しく登録すると、その project.upsert が 1 回だけ届く', async () => {
      fs.mkdirSync(path.join(ws, 'gamma'));
      const p = await (await send('/api/projects', { kind: 'dir', path: path.join(ws, 'gamma') })).json();
      expect(sent).toEqual([{ type: 'project.upsert', project: expect.objectContaining({ id: p.id, name: 'gamma' }) }]);
    });
  });
});
