import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFakeTool } from '../../../test/fake-bin.ts';
import type { ServerEvent } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { SESSION_OTHER } from '../../../test/fixtures.ts';
import { ensureSession } from '../../indexer/indexFile.ts';
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
    expect((await bad.json()).error).toBe('名前はディレクトリ名として使える 1 字以上で、/ と \\ を含められません');
    expect((await postProject({ kind: 'newDir', gitInit: false })).status).toBe(400);
  });
  // 作成場所は任意（2026-10-13）。空のときは、作る場所を画面が parent で渡す。
  it('作成場所が空なら、parent の無い newDir を断り、parent があればその下に作る', async () => {
    deps.updateSettings({ workspaceRoot: '' });
    const none = await postProject({ kind: 'newDir', name: 'fresh', gitInit: false });
    expect(none.status).toBe(400);
    expect((await none.json()).error).toBe('新しいフォルダを作る場所が決まっていません。場所を選んでください');
    const parent = path.join(ws, 'picked');
    fs.mkdirSync(parent);
    const r = await postProject({ kind: 'newDir', name: 'fresh', gitInit: false, parent });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: 'fresh', path: path.join(parent, 'fresh') });
  });
  it('kind が dir なら既存のフォルダを登録し、名前を省けば basename にする', async () => {
    fs.mkdirSync(`${ws}/gamma`);
    const r = await postProject({ kind: 'dir', path: `${ws}/gamma` });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: 'gamma', path: path.join(ws, 'gamma') });
    expect((await postProject({ kind: 'other', path: ws })).status).toBe(400);
  });
  it('フォルダを登録すると、その下の未分類のセッションをその場で紐づけ、ほかのものは動かさない', async () => {
    fs.mkdirSync(path.join(ws, 'gamma', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'gammaX'));
    const under = ensureSession(db, '22222222-2222-4222-8222-222222222222', path.join(ws, 'gamma', 'sub'), 'd');
    const beside = ensureSession(db, '33333333-3333-4333-8333-333333333333', path.join(ws, 'gammaX'), 'd');
    const projectOf = (id: string) => (db.prepare('select project_id from sessions where id = ?').get(id) as { project_id: string | null }).project_id;
    expect(projectOf(under)).toBeNull();
    const r = await postProject({ kind: 'dir', path: path.join(ws, 'gamma') });
    expect(r.status).toBe(201);
    const p = await r.json();
    expect(projectOf(under)).toBe(p.id);
    // 名前の前方一致だけで、隣のフォルダを取り込まない。
    expect(projectOf(beside)).toBeNull();
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
  // 他の PC が同じフォルダを別の ID で登録していると、同名のプロジェクトが 2 つ届く。
  // 届いた方の場所に、この PC で登録済みのフォルダを選んだら、黙って二重にせず、確かめてから 1 つにまとめる。
  it('repoint の先が別のプロジェクトの置き場なら 409 で相手を返し、merge を付けたら 1 つにまとめる', async () => {
    const id = list0ProjectId();
    upsertShared(db, 'projects', { id: 'p-win', name: 'alpha', status: 'active', is_scratch: 0 }, 'dev-win');
    upsertShared(db, 'project_roots', { id: 'r-win', project_id: 'p-win', device_id: 'dev-win', path: 'D:\\workspace\\alpha', resolved: 1 }, 'dev-win');
    upsertShared(db, 'sessions', { id: 's-win', provider: 'claude-code', provider_session_id: 's-win', cwd: 'D:\\workspace\\alpha', home_device: 'dev-win', project_id: 'p-win' }, 'dev-win');
    const r = await post('/api/projects/p-win/resolve', { kind: 'repoint', path: `${path.join(ws, 'alpha')}/` });
    expect(r.status).toBe(409);
    upsertShared(db, 'devices', { id: 'dev-win', name: 'DESKTOP-01', platform: 'win32', last_seen_at: 1 }, 'dev-win');
    const r409 = await post('/api/projects/p-win/resolve', { kind: 'repoint', path: `${path.join(ws, 'alpha')}/` });
    expect(await r409.json()).toMatchObject({
      code: 'project_same_folder',
      from: { projectId: 'p-win', name: 'alpha' },
      conflict: { projectId: id, name: 'alpha', path: path.join(ws, 'alpha') },
      // まとめた後の姿。この PC の場所と、届いた方の PC の場所を並べる。
      merged: { roots: [{ deviceName: null, path: path.join(ws, 'alpha'), here: true }, { deviceName: 'DESKTOP-01', path: 'D:\\workspace\\alpha', here: false }], fromSessions: 1 },
    });
    expect((await r.json()).error).toBe('このフォルダは、プロジェクト alpha の場所として登録済みです');
    // 断っただけで、何も書いていない。
    expect(db.prepare('select count(*) c from project_roots where project_id = ? and deleted_at is null').get('p-win')).toEqual({ c: 1 });
    const merged = await post('/api/projects/p-win/resolve', { kind: 'repoint', path: path.join(ws, 'alpha'), merge: true });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ id, name: 'alpha', path: path.join(ws, 'alpha') });
    expect((await json(await get('/api/sessions/s-win'))).body.projectId).toBe(id);
    expect((await json(await get('/api/projects'))).body.map((p: { id: string }) => p.id)).toEqual([id]);
    // 自分の今の置き場を選び直すのは、重複ではない。
    expect((await post(`/api/projects/${id}/resolve`, { kind: 'repoint', path: path.join(ws, 'alpha') })).status).toBe(200);
  });
  // 直す前の版では「場所を再指定」が重複を見なかったので、同じフォルダが既に 2 つのプロジェクトの場所になっていることがある。
  // 一覧はまとめる方に印（sameFolder）を付け、同じ確認を経てまとめられる。
  it('既に同じフォルダを場所にしている 2 つは、一覧で印を付け、同じ確認でまとめる', async () => {
    const id = list0ProjectId();
    const dir = path.join(ws, 'alpha');
    upsertShared(db, 'projects', { id: 'p-win', name: 'alpha', status: 'active', is_scratch: 0 }, 'dev-win');
    upsertShared(db, 'project_roots', { id: 'r-win', project_id: 'p-win', device_id: 'dev-win', path: 'D:\\workspace\\alpha', resolved: 1 }, 'dev-win');
    upsertShared(db, 'project_roots', { id: 'r-dup', project_id: 'p-win', device_id: 'd', path: dir, resolved: 1 }, 'd');
    const list = (await json(await get('/api/projects'))).body as { id: string; sameFolder?: unknown }[];
    expect(list.find((p) => p.id === 'p-win')?.sameFolder).toEqual({ projectId: id, name: 'alpha' });
    expect(list.find((p) => p.id === id)?.sameFolder).toBeNull();
    expect((await json(await get('/api/projects/p-win'))).body.sameFolder).toEqual({ projectId: id, name: 'alpha' });
    // 残す方から自分の場所を選び直しても、まとめる向きは変わらない。
    const r = await post(`/api/projects/${id}/resolve`, { kind: 'repoint', path: dir });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ from: { projectId: 'p-win' }, conflict: { projectId: id } });
    const merged = await post('/api/projects/p-win/resolve', { kind: 'repoint', path: dir, merge: true });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ id, sameFolder: null });
    expect(db.prepare('select device_id, path from project_roots where project_id = ? and deleted_at is null order by device_id').all(id)).toEqual([{ device_id: 'd', path: dir }, { device_id: 'dev-win', path: 'D:\\workspace\\alpha' }]);
  });
  it('スクラッチの場所と同じフォルダは、まとめずに断る', async () => {
    const id = list0ProjectId();
    const dir = path.join(ws, 'scratch');
    fs.mkdirSync(dir);
    upsertShared(db, 'projects', { id: 'p-s', name: 'scratch', status: 'active', is_scratch: 1 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r-s', project_id: 'p-s', device_id: 'd', path: dir, resolved: 1 }, 'd');
    for (const merge of [false, true]) {
      const r = await post(`/api/projects/${id}/resolve`, { kind: 'repoint', path: dir, merge });
      expect(r.status).toBe(409);
      const body = await r.json();
      expect(body.code).toBeUndefined();
      expect(body.error).toBe('このフォルダは、プロジェクト scratch の場所として登録済みです');
    }
    expect(db.prepare('select deleted_at from projects where id = ?').get(id)).toEqual({ deleted_at: null });
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
// 初日のプロジェクト（2026-10-13）。Claude Code と会話したフォルダの候補と、まとめての登録。
describe('会話したフォルダの候補', () => {
  const talk = (id: string, cwd: string) => upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: id, cwd, home_device: 'd', last_activity_at: 50 }, 'd');
  const post = (body: unknown) => app.request('/api/workspace/register', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  beforeEach(() => {
    app = createApp({ ...deps, candidateEnv: { homeDir: path.join(ws, 'home'), tmpDirs: [] } });
  });
  it('候補を返し、作成場所が空なら過半の親を作成場所の候補にする', async () => {
    const src = path.join(ws, 'src');
    for (const name of ['one', 'two']) { fs.mkdirSync(path.join(src, name), { recursive: true }); talk(`c-${name}`, path.join(src, name)); }
    talk('c-two-b', path.join(src, 'two'));
    const r = await json(await get('/api/workspace/candidates'));
    expect(r.status).toBe(200);
    expect(r.body.candidates.slice(0, 2)).toEqual([
      { path: path.join(src, 'two'), sessionCount: 2, lastActivityAt: 50, worktreeCount: 0 },
      { path: path.join(src, 'one'), sessionCount: 1, lastActivityAt: 50, worktreeCount: 0 },
    ]);
    // 作成場所が決まっているあいだは、作成場所の候補を出さない。
    expect(r.body.suggestedRoot).toBeNull();
    deps.updateSettings({ workspaceRoot: '' });
    app = createApp({ ...deps, candidateEnv: { homeDir: path.join(ws, 'home'), tmpDirs: [] } });
    expect((await json(await get('/api/workspace/candidates'))).body.suggestedRoot).toBe(src);
  });
  it('選んだフォルダをまとめて登録し、その下の未分類の会話を紐づけ直す。登録できないものは理由を返す', async () => {
    const one = path.join(ws, 'x', 'one');
    fs.mkdirSync(path.join(one, 'sub'), { recursive: true });
    talk('c-one', path.join(one, 'sub'));
    const r = await post({ paths: [one, path.join(ws, 'nope')] });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({ name: 'one', path: one });
    expect(body.failed).toEqual([{ path: path.join(ws, 'nope'), error: 'path が存在するディレクトリではありません' }]);
    expect((db.prepare("select project_id from sessions where id = 'c-one'").get() as { project_id: string }).project_id).toBe(body.projects[0].id);
  });
  it('paths が文字列の配列でなければ断る', async () => {
    for (const bad of [{}, { paths: 'x' }, { paths: [1] }]) expect((await post(bad)).status).toBe(400);
  });
});

// 0.6.2：フォルダの中から選んで登録する。入れ子と、ほかの PC から届いたプロジェクトへの結び付け。
describe('フォルダの中から登録する', () => {
  const send = (p: string, body: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  /** ほかの PC だけに場所を持つプロジェクト。 */
  function elsewhere(id: string, name: string, remote: string | null) {
    upsertShared(db, 'devices', { id: 'other', name: 'work-pc', platform: 'darwin' }, 'other');
    upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0, git_remote: remote }, 'other');
    upsertShared(db, 'project_roots', { id: `r-${id}`, project_id: id, device_id: 'other', path: `/Users/other/${name}`, resolved: 1 }, 'other');
  }
  function origin(dir: string, url: string) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
  }
  const rootHere = (id: string) => db.prepare("select path, resolved from project_roots where project_id = ? and device_id = 'd' and deleted_at is null").get(id);

  it('GET /api/workspace/children は親の直下を返し、parent が無いか読めなければ 400', async () => {
    const src = path.join(ws, 'src');
    origin(path.join(src, 'notes-app'), 'git@github.com:me/notes-app.git');
    elsewhere('far', 'notes', 'github.com/me/notes-app');
    const r = await json(await get(`/api/workspace/children?parent=${encodeURIComponent(src)}`));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ parent: src, enclosing: null, children: [expect.objectContaining({ name: 'notes-app', git: true, remote: 'github.com/me/notes-app', link: expect.objectContaining({ projectId: 'far', match: 'remote', deviceName: 'work-pc' }) })] });
    // 作成場所の直下には、登録済みの alpha が並ぶ。
    expect((await json(await get(`/api/workspace/children?parent=${encodeURIComponent(ws)}`))).body.children.find((c: { name: string }) => c.name === 'alpha')).toMatchObject({ registered: { projectId: list0ProjectId(), name: 'alpha' } });
    for (const q of ['', '?parent=', '?parent=relative', `?parent=${encodeURIComponent(path.join(ws, 'nope'))}`]) expect((await get(`/api/workspace/children${q}`)).status).toBe(400);
  });
  it('GET /api/workspace/inspect は、入れ子と結び付く候補を返す', async () => {
    const ui = path.join(ws, 'alpha', 'packages', 'ui');
    fs.mkdirSync(ui, { recursive: true });
    const r = await json(await get(`/api/workspace/inspect?path=${encodeURIComponent(ui)}`));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ path: ui, registered: null, enclosing: { projectId: list0ProjectId(), name: 'alpha', path: path.join(ws, 'alpha'), relative: path.join('packages', 'ui') }, link: null });
    const plain = path.join(ws, 'plain');
    fs.mkdirSync(plain);
    elsewhere('n', 'shop', null);
    expect((await json(await get(`/api/workspace/inspect?path=${encodeURIComponent(plain)}&name=shop`))).body.link).toMatchObject({ projectId: 'n', match: 'name' });
    expect((await get('/api/workspace/inspect')).status).toBe(400);
  });
  it('POST /api/projects の dir は、登録済みのプロジェクトの下なら 409 で包むプロジェクトを返し、allowNested で分ける', async () => {
    const ui = path.join(ws, 'alpha', 'ui');
    fs.mkdirSync(ui);
    const r = await send('/api/projects', { kind: 'dir', path: ui });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'このフォルダはプロジェクト alpha の中にあります', code: 'project_nested', enclosing: { projectId: list0ProjectId(), name: 'alpha', path: path.join(ws, 'alpha') } });
    const ok = await send('/api/projects', { kind: 'dir', path: ui, allowNested: true });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ name: 'ui', path: ui });
  });
  it('POST /api/projects の dir は、linkTo でほかの PC のプロジェクトをこの PC の場所に結び付ける', async () => {
    const dir = path.join(ws, 'x', 'notes-app');
    fs.mkdirSync(dir, { recursive: true });
    elsewhere('far', 'notes-app', null);
    const r = await send('/api/projects', { kind: 'dir', path: dir, linkTo: 'far' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: 'far', name: 'notes-app', path: dir, resolved: true });
    expect(rootHere('far')).toEqual({ path: dir, resolved: 1 });
    expect((await send('/api/projects', { kind: 'dir', path: path.join(ws, 'x'), linkTo: 3 })).status).toBe(400);
  });
  it('POST /api/workspace/register は、行ごとに結び付け先と入れ子の明示を受け、結び付けたものを linked に返す', async () => {
    const a = path.join(ws, 'x', 'a');
    const b = path.join(ws, 'x', 'b');
    const nested = path.join(ws, 'alpha', 'sub');
    for (const d of [a, b, nested]) fs.mkdirSync(d, { recursive: true });
    upsertShared(db, 'sessions', { id: 'c-a', provider: 'claude-code', provider_session_id: 'c-a', cwd: a, home_device: 'd', last_activity_at: 50 }, 'd');
    elsewhere('far', 'a-old', null);
    const r = await send('/api/workspace/register', { items: [{ path: a, linkTo: 'far' }, { path: b }, { path: nested }] });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.linked).toEqual(['far']);
    expect(body.projects.map((p: { name: string }) => p.name).sort()).toEqual(['a-old', 'b']);
    expect(body.failed).toEqual([{ path: nested, error: 'このフォルダはプロジェクト alpha の中にあります' }]);
    expect(rootHere('far')).toEqual({ path: a, resolved: 1 });
    // 結び付けた先へ、その下の未分類の会話が入る。
    expect((db.prepare("select project_id from sessions where id = 'c-a'").get() as { project_id: string }).project_id).toBe('far');
    const again = await send('/api/workspace/register', { items: [{ path: nested, allowNested: true }] });
    expect((await again.json()).projects).toEqual([expect.objectContaining({ name: 'sub', path: nested })]);
  });
  it('POST /api/workspace/register の items の形が違えば 400', async () => {
    for (const bad of [{ items: 'x' }, { items: [{}] }, { items: [{ path: 1 }] }, { items: [{ path: '/x', linkTo: 3 }] }, { items: [{ path: '/x', allowNested: 'yes' }] }, { paths: ['/x'], items: [] }]) {
      expect((await send('/api/workspace/register', bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

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
