import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleDto } from '@agent-hangar/shared';
import { issueMcpSecret } from '../../runs/secrets.ts';
import { callTool, TOOL_NAMES, type ToolDeps } from '../../mcp/tools.ts';
import { PRIMARY_ACCOUNT_ID } from '../../config/accounts.ts';
import { listSchedules } from '../../schedule/store.ts';
import { TOOL_CLASSES, toolsNeedingApproval } from '../../mcp/toolClasses.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let projectId: string;
let sessionId: string;
const send = (m: string, p: string, body?: unknown) => app.request(p, { method: m, headers: { ...H, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const flush = () => new Promise((r) => setTimeout(r, 0));
const input = () => ({ prompt: 'p', spec: { kind: 'every', minutes: 30 }, target: { kind: 'new', projectId } });

beforeEach(async () => {
  t = await testDeps();
  app = createApp(t.deps);
  const s = t.db.prepare('select id, project_id from sessions where project_id is not null limit 1').get() as { id: string; project_id: string };
  sessionId = s.id;
  projectId = s.project_id;
});
afterEach(() => { t.dispose(); });

describe('/api/schedules', () => {
  it('作ると一覧ごと配り、bootstrap にも載る', async () => {
    const r = await send('POST', '/api/schedules', input());
    expect(r.status).toBe(200);
    const made = await r.json() as ScheduleDto;
    await flush();
    const ev = [...t.events].reverse().find((e) => e.type === 'schedules.update') as { schedules: ScheduleDto[] };
    expect(ev.schedules.map((s) => s.id)).toEqual([made.id]);
    const boot = await (await app.request('/api/bootstrap', { headers: H })).json() as { schedules: ScheduleDto[] };
    expect(boot.schedules[0]).toMatchObject({ id: made.id, enabled: true, projectId, runs: [] });
  });

  it('形の合わない予定は理由を添えて 400 にする', async () => {
    const r = await send('POST', '/api/schedules', { ...input(), spec: { kind: 'every', minutes: 1 } });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain('5');
    expect((await send('POST', '/api/schedules', { ...input(), prompt: ' ' })).status).toBe(400);
    expect((await send('POST', '/api/schedules', { ...input(), target: { kind: 'session', sessionId: 'nope' } })).status).toBe(400);
  });

  it('止める、再開する、変える、消す', async () => {
    const { id } = await (await send('POST', '/api/schedules', input())).json() as ScheduleDto;
    expect(await (await send('PATCH', `/api/schedules/${id}`, { enabled: false })).json()).toMatchObject({ enabled: false, nextAt: null });
    expect(await (await send('PATCH', `/api/schedules/${id}`, { enabled: true })).json()).toMatchObject({ enabled: true });
    expect(await (await send('PATCH', `/api/schedules/${id}`, { prompt: 'q', target: { kind: 'session', sessionId } })).json()).toMatchObject({ prompt: 'q', target: { kind: 'session', sessionId } });
    expect((await send('DELETE', `/api/schedules/${id}`)).status).toBe(200);
    expect((await send('DELETE', `/api/schedules/${id}`)).status).toBe(404);
  });

  it('今すぐ実行は実行の口へ渡す', async () => {
    const { id } = await (await send('POST', '/api/schedules', input())).json() as ScheduleDto;
    const runNow = vi.fn(() => 'busy' as const);
    t.deps.schedules = { runNow, deliver: async (i) => ({ sessionId: i }) };
    app = createApp(t.deps);
    expect(await (await send('POST', `/api/schedules/${id}/run`)).json()).toEqual({ outcome: 'busy' });
    expect(runNow).toHaveBeenCalledWith(id);
  });

  it('トークンが無ければ通さない', async () => {
    expect((await app.request('/api/schedules')).status).toBe(401);
    void issueMcpSecret;
  });
});

describe('POST /api/sessions/:id/try-now', () => {
  const pause = (note = '結果を見る') => t.db.prepare('select 1').get() && send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note });
  const state = () => t.db.prepare('select status from session_states where session_id = ?').get(sessionId) as { status: string | null } | undefined;
  const useDeliver = (deliver: (id: string, text: string) => Promise<{ sessionId: string } | 'busy'>) => { const f = vi.fn(deliver); t.deps.schedules = { runNow: () => 'missing', deliver: f }; app = createApp(t.deps); return f; };

  it('理由を渡してから Active にする', async () => {
    await pause();
    const deliver = useDeliver(async (id) => ({ sessionId: id }));
    expect((await send('POST', `/api/sessions/${sessionId}/try-now`)).status).toBe(200);
    expect(deliver.mock.calls[0]![0]).toBe(sessionId);
    expect(deliver.mock.calls[0]![1]).toContain('結果を見る');
    expect(state()?.status ?? null).toBeNull();
  });
  it('動いていて渡せなければ Paused のまま 409', async () => {
    await pause();
    useDeliver(async () => 'busy');
    expect((await send('POST', `/api/sessions/${sessionId}/try-now`)).status).toBe(409);
    expect(state()?.status).toBe('paused');
  });
  it('再開に失敗したら Paused のまま理由を返す', async () => {
    await pause();
    useDeliver(async () => { throw new Error('nope'); });
    const r = await send('POST', `/api/sessions/${sessionId}/try-now`);
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain('nope');
    expect(state()?.status).toBe('paused');
  });
  it('Paused でなければ渡さない', async () => {
    const deliver = useDeliver(async (id) => ({ sessionId: id }));
    expect((await send('POST', `/api/sessions/${sessionId}/try-now`)).status).toBe(409);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('予定の MCP の道具', () => {
  const tools = () => ({ db: t.db, deviceId: t.deps.deviceId, port: 1, live: () => [], runs: t.deps.runs, language: t.deps.language, usage: () => t.deps.usage.current() }) as unknown as ToolDeps;
  const create = (ctx: { sessionId: string | null }, over = {}) => callTool(tools(), ctx, 'create_schedule', { kind: 'every', every_minutes: 30, prompt: 'p', project_id: projectId, ...over }) as ScheduleDto;

  it('消す道具は無く、どれも承認の要らない分類に入っている', () => {
    expect(TOOL_NAMES.filter((n) => n.includes('schedule'))).toEqual(['list_schedules', 'create_schedule', 'update_schedule']);
    expect(TOOL_CLASSES.create_schedule.kind).toBe('drive');
    expect(toolsNeedingApproval()).not.toContain('create_schedule');
  });

  it('作り、変え、止める', () => {
    const s = create({ sessionId: null });
    expect(s.target).toEqual({ kind: 'new', projectId });
    const off = callTool(tools(), { sessionId: null }, 'update_schedule', { schedule_id: s.id, enabled: false }) as ScheduleDto;
    expect(off.enabled).toBe(false);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const changed = callTool(tools(), { sessionId: null }, 'update_schedule', { schedule_id: s.id, kind: 'once', at, enabled: true }) as ScheduleDto;
    expect(changed.spec.kind).toBe('once');
    expect((callTool(tools(), { sessionId: null }, 'list_schedules', {}) as { schedules: ScheduleDto[] }).schedules).toHaveLength(1);
  });

  it('既存の会話を宛先にできる。形の誤りは道具の断りになる', () => {
    expect(create({ sessionId: null }, { session_id: sessionId }).target).toEqual({ kind: 'session', sessionId });
    expect(() => create({ sessionId: null }, { every_minutes: 1 })).toThrow(/5/);
    expect(() => create({ sessionId: null }, { agent: 'nope' })).toThrow();
  });

  it('セッション別の URL では、そのプロジェクトの外に届かない', () => {
    const other = create({ sessionId: null });
    t.db.prepare('update schedules set project_id = ? where id = ?').run('other-project', other.id);
    const ctx = { sessionId };
    expect(() => callTool(tools(), ctx, 'update_schedule', { schedule_id: other.id, enabled: false })).toThrow();
    expect((callTool(tools(), ctx, 'list_schedules', {}) as { schedules: ScheduleDto[] }).schedules).toEqual([]);
    expect(() => create(ctx, { project_id: 'other-project' })).toThrow();
    expect(create(ctx).projectId).toBe(projectId);
  });
});

describe('予定の起動の項目', () => {
  const full = () => ({ kind: 'new', projectId, agent: 'claude-code', name: 'n', account: PRIMARY_ACCOUNT_ID, model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', worktree: 'w', addDirs: ['/x'] });
  const tools = (over = {}) => ({ db: t.db, deviceId: t.deps.deviceId, port: 1, live: () => [], runs: t.deps.runs, accounts: t.deps.accounts, language: t.deps.language, usage: () => t.deps.usage.current(), ...over }) as unknown as ToolDeps;
  const mcp = (ctx: { sessionId: string | null }, name: string, args: Record<string, unknown>) => callTool(tools(), ctx, name, args) as ScheduleDto;
  const mk = (over: Record<string, unknown> = {}) => mcp({ sessionId: null }, 'create_schedule', { kind: 'every', every_minutes: 30, prompt: 'p', project_id: projectId, ...over });

  it('全項目つきの予定を作ると、GET で同じ値が返り、アカウントの表示名が付く', async () => {
    const made = await (await send('POST', '/api/schedules', { ...input(), target: full() })).json() as ScheduleDto;
    expect(made.target).toEqual(full());
    expect(made.accountName).toBe('メイン');
    const list = await (await send('GET', '/api/schedules')).json() as { schedules: ScheduleDto[] };
    expect(list.schedules[0]).toMatchObject({ id: made.id, target: full(), accountName: 'メイン' });
  });

  it('消えたアカウントの id は表示名を引けず null で、古い形の予定は accountName が null のまま', async () => {
    const gone = await (await send('POST', '/api/schedules', { ...input(), target: { ...full(), account: 'no-such' } })).json() as ScheduleDto;
    expect(gone.accountName).toBeNull();
    const old = await (await send('POST', '/api/schedules', { ...input(), target: { kind: 'new', projectId, agent: 'opencode' } })).json() as ScheduleDto;
    expect(old.target).toStrictEqual({ kind: 'new', projectId, agent: 'opencode' });
    expect(old.accountName).toBeNull();
  });

  it('MCP で Codex のアカウントを名前で渡すと、Codex の組の id で保存し、表示名を引ける', () => {
    const cx = { id: 'cx1', name: '仕事', dir: '/c', color: 'x' };
    const codexStore = { list: () => [cx], get: (id: string) => (id === 'cx1' ? cx : undefined), current: () => cx };
    const deps = tools({ codexAccounts: codexStore, runs: { ...t.deps.runs, agentEnabled: () => true } });
    const made = callTool(deps, { sessionId: null }, 'create_schedule', { kind: 'every', every_minutes: 30, prompt: 'p', project_id: projectId, agent: 'codex', account: '仕事' }) as ScheduleDto;
    expect(made.target).toMatchObject({ agent: 'codex', account: 'cx1' });
    expect(made.accountName).toBe('仕事');
  });

  it('エージェントに合わない項目は 400 で、保存しない', async () => {
    const r = await send('POST', '/api/schedules', { ...input(), target: { kind: 'new', projectId, agent: 'codex', worktree: 'w' } });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain('worktree');
    expect(((await (await send('GET', '/api/schedules')).json()) as { schedules: unknown[] }).schedules).toEqual([]);
  });

  it('クイックセッションの予定は project_id が null で、プロジェクトの名前を持たない。絞った一覧には出ない', async () => {
    const q = await (await send('POST', '/api/schedules', { ...input(), target: { kind: 'new', projectId: null, scratch: true, agent: 'opencode', autoApprove: true } })).json() as ScheduleDto;
    expect(q).toMatchObject({ projectId: null, projectName: null, target: { kind: 'new', projectId: null, scratch: true, agent: 'opencode', autoApprove: true } });
    expect((t.db.prepare('select project_id from schedules where id = ?').get(q.id) as { project_id: string | null }).project_id).toBeNull();
    expect((await send('POST', '/api/schedules', { ...input(), target: { kind: 'new', projectId: null } })).status).toBe(400);
    expect(listSchedules(t.db, t.deps.deviceId, projectId).map((s) => s.id)).toEqual([]);
    expect(listSchedules(t.db, t.deps.deviceId).map((s) => s.id)).toEqual([q.id]);
  });

  it('PATCH で agent を替えるとき、合わない値は断り、合う形なら通る', async () => {
    const made = await (await send('POST', '/api/schedules', { ...input(), target: full() })).json() as ScheduleDto;
    expect((await send('PATCH', `/api/schedules/${made.id}`, { target: { ...full(), agent: 'codex' } })).status).toBe(400);
    const ok = await send('PATCH', `/api/schedules/${made.id}`, { target: { kind: 'new', projectId, agent: 'codex', model: 'gpt-5' } });
    expect(await ok.json()).toMatchObject({ target: { kind: 'new', projectId, agent: 'codex', model: 'gpt-5' } });
  });

  it('MCP の create_schedule に起動の項目を渡すと、target に入る', () => {
    const s = mk({ model: 'sonnet', effort: 'high', permission_mode: 'bypassPermissions', worktree: 'w', add_dirs: ['/x'], name: 'n', account: 'メイン' });
    expect(s.target).toEqual({ kind: 'new', projectId, name: 'n', account: PRIMARY_ACCOUNT_ID, model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions', worktree: 'w', addDirs: ['/x'] });
    expect(s.accountName).toBe('メイン');
    const o = mk({ agent: 'opencode', mode: 'plan', auto_approve: true, model: 'lmstudio/x' });
    expect(o.target).toEqual({ kind: 'new', projectId, agent: 'opencode', mode: 'plan', autoApprove: true, model: 'lmstudio/x' });
  });

  it('MCP でもエージェントに合わない項目と、知らないアカウントは断る', () => {
    expect(() => mk({ agent: 'codex', worktree: 'w' })).toThrow(/worktree/);
    expect(() => mk({ agent: 'opencode', account: 'a' })).toThrow(/account/);
    expect(() => mk({ auto_approve: true })).toThrow(/autoApprove/);
    expect(() => mk({ account: 'ないアカウント' })).toThrow(/ないアカウント/);
  });

  it('MCP の update_schedule は渡した項目だけ変え、渡さなかった項目を引き継ぎ、空の文字列で既定に戻す', () => {
    const s = mk({ model: 'sonnet', effort: 'high', worktree: 'w' });
    const u1 = mcp({ sessionId: null }, 'update_schedule', { schedule_id: s.id, model: 'opus' });
    expect(u1.target).toEqual({ kind: 'new', projectId, model: 'opus', effort: 'high', worktree: 'w' });
    const u2 = mcp({ sessionId: null }, 'update_schedule', { schedule_id: s.id, effort: '' });
    expect(u2.target).toEqual({ kind: 'new', projectId, model: 'opus', worktree: 'w' });
    expect(() => mcp({ sessionId: null }, 'update_schedule', { schedule_id: s.id, agent: 'codex' })).toThrow(/worktree/);
  });

  it('MCP の scratch は共通の URL からだけ作れ、プロジェクトを固定した URL では断る', () => {
    const q = mcp({ sessionId: null }, 'create_schedule', { kind: 'every', every_minutes: 30, prompt: 'p', scratch: true });
    expect(q).toMatchObject({ projectId: null, target: { kind: 'new', projectId: null, scratch: true } });
    expect(() => mcp({ sessionId }, 'create_schedule', { kind: 'every', every_minutes: 30, prompt: 'p', scratch: true })).toThrow();
    // 固定した URL からは、クイックセッションの予定に触れない（一覧にも出ない）。
    expect((callTool(tools(), { sessionId }, 'list_schedules', {}) as { schedules: ScheduleDto[] }).schedules).toEqual([]);
    expect(() => mcp({ sessionId }, 'update_schedule', { schedule_id: q.id, enabled: false })).toThrow();
  });
});
