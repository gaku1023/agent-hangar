import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_ALPHA } from '../../../test/fixtures.ts';
import { hasGit, makeRepo } from '../../../test/git.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// git の表示の経路（routes/git.ts）。実物の git で、ワークスペースの alpha をリポジトリにして読む。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let repo: string;
let alpha: string;
const get = (p: string) => app.request(p, { headers: H });
const post = (p: string, body: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  t = await testDeps();
  app = createApp(t.deps);
  repo = fs.realpathSync.native(path.join(t.ws, 'alpha'));
  alpha = (t.db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  t.db.prepare('update sessions set cwd = ? where id = ?').run(repo, alpha);
});
afterEach(() => { t.dispose(); });

describe.skipIf(!hasGit)('git の経路', () => {
  beforeEach(() => {
    makeRepo(repo, { 'a.md': 'one\n', 'b.md': 'b\n' });
    // フィクスチャの本文の編集のパスを、このリポジトリの a.md に向ける。
    t.db.prepare("update event_index set file_path = ? where session_id = ? and tool_name in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')").run(path.join(repo, 'a.md'), alpha);
    fs.writeFileSync(path.join(repo, 'a.md'), 'ONE\n');
    fs.writeFileSync(path.join(repo, 'b.md'), 'B\n');
  });

  it('一覧の git は、見えている行のセッションだけを返す', async () => {
    const r = await post('/api/git/sessions', { ids: [alpha, 'nope'] });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.sessions[alpha]).toMatchObject({ state: 'ok', root: repo });
    expect(body.trees[repo]).toMatchObject({ branch: 'main', dirty: 2 });
    expect(Object.keys(body.sessions)).toEqual([alpha]);
    expect((await post('/api/git/sessions', { ids: 'x' })).status).toBe(400);
    expect((await post('/api/git/sessions', { ids: Array.from({ length: 201 }, (_, i) => `s${i}`) })).status).toBe(400);
  });

  it('変更したファイル、差分、編集を返す。ほかのファイルの差分は返さない', async () => {
    const ch = await (await get(`/api/sessions/${alpha}/changes`)).json();
    expect(ch.files.map((f: { rel: string; status: string }) => [f.rel, f.status])).toEqual([['a.md', 'M']]);
    expect(ch.others.map((f: { rel: string }) => f.rel)).toEqual(['b.md']);
    const q = encodeURIComponent(path.join(repo, 'a.md'));
    const d = await (await get(`/api/sessions/${alpha}/diff?file=${q}`)).json();
    expect(d.text).toContain('-one\n+ONE\n');
    expect((await get(`/api/sessions/${alpha}/diff?file=${encodeURIComponent(path.join(repo, 'b.md'))}`)).status).toBe(404);
    expect((await get(`/api/sessions/${alpha}/diff`)).status).toBe(400);
    const e = await (await get(`/api/sessions/${alpha}/edits?file=${q}`)).json();
    expect(e.file).toBe(path.join(repo, 'a.md'));
    expect(e.edits.length).toBeGreaterThan(0);
    expect((await get(`/api/sessions/${alpha}/edits?file=${encodeURIComponent(path.join(repo, 'b.md'))}`)).status).toBe(404);
    expect((await get('/api/sessions/nope/changes')).status).toBe(404);
  });

  it('プロジェクトのブランチと worktree を返す', async () => {
    const body = await (await get(`/api/projects/${t.alphaProjectId()}/git`)).json();
    expect(body.root).toMatchObject({ root: repo, branch: 'main' });
    expect(body.worktrees).toEqual([]);
    expect((await get('/api/projects/nope/git')).status).toBe(404);
  });
});
