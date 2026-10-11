import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstructionsDto, ProjectDto } from '@agent-hangar/shared';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 指示とメモリの経路（routes/instructions.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let alpha: ProjectDto;
beforeEach(async () => {
  t = await testDeps();
  app = createApp(t.deps);
  alpha = await (await app.request(`/api/projects/${t.alphaProjectId()}`, { headers: H })).json() as ProjectDto;
});
afterEach(() => { t.dispose(); });

const get = (id: string) => app.request(`/api/projects/${id}/instructions`, { headers: H });
const open = (id: string, body: unknown) => app.request(`/api/projects/${id}/instructions/open`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('GET /api/projects/:id/instructions', () => {
  it('ファイルが無ければ空で、available は真', async () => {
    const r = await get(alpha.id);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ projectId: alpha.id, available: true, files: [] });
  });

  it('プロジェクトの CLAUDE.md と、いまのアカウントの自動メモリを返す', async () => {
    fs.writeFileSync(path.join(alpha.path!, 'CLAUDE.md'), '# alpha');
    const mem = path.join(t.claudeDir, 'projects', alpha.path!.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- 覚え');
    const body = await (await get(alpha.id)).json() as InstructionsDto;
    expect(body.files.map((f) => [f.kind, f.markdown])).toEqual([['project', '# alpha'], ['memory', '- 覚え']]);
  });

  it('この PC にフォルダが無ければ available は偽で、files は空', async () => {
    fs.rmSync(alpha.path!, { recursive: true, force: true });
    expect(await (await get(alpha.id)).json()).toEqual({ projectId: alpha.id, available: false, files: [] });
  });

  it('知らないプロジェクトは 404', async () => {
    expect((await get('nope')).status).toBe(404);
  });
});

describe('POST /api/projects/:id/instructions/open', () => {
  it('あるファイルをエディタで開く', async () => {
    fs.writeFileSync(path.join(alpha.path!, 'CLAUDE.md'), '# alpha');
    const r = await open(alpha.id, { kind: 'project' });
    expect(r.status).toBe(204);
    expect(t.external.openEditor).toHaveBeenCalledWith({ target: path.join(alpha.path!, 'CLAUDE.md') });
  });

  it('無いファイルは作らずに 404', async () => {
    expect((await open(alpha.id, { kind: 'local' })).status).toBe(404);
    expect(fs.existsSync(path.join(alpha.path!, 'CLAUDE.local.md'))).toBe(false);
    expect(t.external.openEditor).not.toHaveBeenCalled();
  });

  it('決まった種類のほかは断る', async () => {
    for (const kind of ['../../etc/passwd', 'README', 1, undefined]) expect((await open(alpha.id, { kind })).status).toBe(400);
    expect(t.external.openEditor).not.toHaveBeenCalled();
  });

  it('知らないプロジェクトは 404', async () => {
    expect((await open('nope', { kind: 'project' })).status).toBe(404);
  });
});
