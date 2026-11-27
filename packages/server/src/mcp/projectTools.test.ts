import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProjectTool, promoteSessionTool, type ProjectToolDeps, type RouteOutcome } from './projectTools.ts';

const WS = path.resolve('/w');

function setup(o: { workspaceRoot?: string; createOutcome?: RouteOutcome; promoteOutcome?: RouteOutcome; quick?: string | null } = {}) {
  const creates: Record<string, unknown>[] = [];
  const promotes: { id: string; body: Record<string, unknown> }[] = [];
  const deps: ProjectToolDeps = {
    workspaceRoot: () => o.workspaceRoot ?? WS,
    quickDir: () => (o.quick === undefined ? '/home/.agent-hangar/quick-sessions/q1' : o.quick),
    createProject: async (body) => { creates.push(body); return o.createOutcome ?? { ok: true, status: 201, body: { id: 'p-new', name: body.name ?? 'beta', path: body.path ?? path.join(WS, String(body.name)) } }; },
    promoteSession: async (id, body) => { promotes.push({ id, body }); return o.promoteOutcome ?? { ok: true, status: 201, body: { project: { id: 'p-promoted', name: body.name, path: path.join(WS, String(body.name)) }, moved: true, reason: null } }; },
  };
  return { deps, creates, promotes };
}

const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error; } throw new Error('断られなかった'); };

describe('create_project', () => {
  it('confirmed が無ければ何も作らず、登録する場所を見せて利用者に聞かせる', async () => {
    const { deps, creates } = setup();
    const r = await createProjectTool(deps, { name: 'beta', path: '/x/beta' }) as Record<string, unknown>;
    expect(creates).toEqual([]);
    expect(r).toMatchObject({ status: 'needs_confirmation', proposed: { action: 'register', name: 'beta', path: '/x/beta' } });
    expect(typeof r.note).toBe('string');
  });

  it('path を省けば、作成場所の下に name のフォルダを作る案になる', async () => {
    const { deps } = setup();
    const r = await createProjectTool(deps, { name: 'beta' }) as Record<string, unknown>;
    expect(r).toMatchObject({ status: 'needs_confirmation', proposed: { action: 'create', name: 'beta', path: path.join(WS, 'beta'), git_init: true } });
  });

  it('confirmed: true で、既存のフォルダは画面と同じ dir の登録に渡す', async () => {
    const { deps, creates } = setup();
    const r = await createProjectTool(deps, { name: 'beta', path: '/x/beta', confirmed: true });
    expect(creates).toEqual([{ kind: 'dir', path: '/x/beta', name: 'beta' }]);
    expect(r).toMatchObject({ status: 'created', project_id: 'p-new' });
  });

  it('confirmed: true で path が無ければ、画面と同じ newDir に git_init を添えて渡す', async () => {
    const { deps, creates } = setup();
    await createProjectTool(deps, { name: 'beta', git_init: false, confirmed: true });
    expect(creates).toEqual([{ kind: 'newDir', name: 'beta', gitInit: false }]);
  });

  it('登録済みのフォルダなら already_registered を返す（画面の 200）', async () => {
    const { deps } = setup({ createOutcome: { ok: true, status: 200, body: { id: 'p-old', name: 'beta', path: '/x/beta' } } });
    expect(await createProjectTool(deps, { path: '/x/beta', confirmed: true })).toMatchObject({ status: 'already_registered', project_id: 'p-old' });
  });

  it('画面の経路の断りの文で断る', async () => {
    const { deps } = setup({ createOutcome: { ok: false, status: 400, error: 'フォルダがありません' } });
    expect((await fail(createProjectTool(deps, { path: '/nope', confirmed: true }))).message).toContain('フォルダがありません');
  });

  it('name も path も無い、名前がフォルダ名にならない、confirmed が真偽でないときは、聞く前に断る', async () => {
    const { deps, creates } = setup();
    await fail(createProjectTool(deps, {}));
    await fail(createProjectTool(deps, { name: '../evil' }));
    await fail(createProjectTool(deps, { name: 'beta', confirmed: 'yes' }));
    await fail(createProjectTool(deps, { path: 'relative/dir' }));
    expect(creates).toEqual([]);
  });

  it('作成場所が空で path も無ければ、聞く前に断る', async () => {
    const { deps } = setup({ workspaceRoot: '' });
    await fail(createProjectTool(deps, { name: 'beta' }));
  });
});

describe('promote_session', () => {
  it('confirmed が無ければ何も動かさず、作る場所と移すかを見せる。既定は画面と同じく git init も移動もする', async () => {
    const { deps, promotes } = setup();
    const r = await promoteSessionTool(deps, 's1', { name: 'beta' }) as Record<string, unknown>;
    expect(promotes).toEqual([]);
    expect(r).toMatchObject({ status: 'needs_confirmation', proposed: { session_id: 's1', name: 'beta', path: path.join(WS, 'beta'), git_init: true, move_files: true } });
  });

  it('confirmed: true で画面と同じ昇格の経路に渡し、project_id を返す', async () => {
    const { deps, promotes } = setup();
    const r = await promoteSessionTool(deps, 's1', { name: 'beta', git_init: false, move_files: false, confirmed: true });
    expect(promotes).toEqual([{ id: 's1', body: { name: 'beta', gitInit: false, moveFiles: false } }]);
    expect(r).toMatchObject({ status: 'promoted', project_id: 'p-promoted', path: path.join(WS, 'beta'), moved: true });
  });

  it('ファイルを移せなかったときは、理由と、ファイルが残っている場所を返す', async () => {
    const { deps } = setup({ promoteOutcome: { ok: true, status: 201, body: { project: { id: 'p2', name: 'beta', path: '/w/beta' }, moved: false, reason: 'Claude が実行中のため' } } });
    expect(await promoteSessionTool(deps, 's1', { name: 'beta', confirmed: true })).toMatchObject({ moved: false, reason: 'Claude が実行中のため', files_left_in: '/home/.agent-hangar/quick-sessions/q1' });
  });

  it('同じ名前のフォルダがあって 409 なら、create_project で登録する道を添えて断る', async () => {
    const { deps } = setup({ promoteOutcome: { ok: false, status: 409, error: 'すでにあります' } });
    const e = await fail(promoteSessionTool(deps, 's1', { name: 'beta', confirmed: true }));
    expect(e.message).toContain('すでにあります');
    expect(e.message).toContain('create_project');
  });

  it('クイックセッションでない会話は、聞く前に断る', async () => {
    const { deps, promotes } = setup({ quick: null });
    await fail(promoteSessionTool(deps, 's1', { name: 'beta' }));
    expect(promotes).toEqual([]);
  });

  it('name が無いか、フォルダ名にならなければ断る', async () => {
    const { deps } = setup();
    await fail(promoteSessionTool(deps, 's1', {}));
    await fail(promoteSessionTool(deps, 's1', { name: 'a/b' }));
  });
});
