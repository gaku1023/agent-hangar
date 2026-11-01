import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleDto } from '@agent-hangar/shared';
import { issueMcpSecret } from '../../runs/secrets.ts';
import { callTool, TOOL_NAMES, type ToolDeps } from '../../mcp/tools.ts';
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
    t.deps.schedules = { runNow };
    app = createApp(t.deps);
    expect(await (await send('POST', `/api/schedules/${id}/run`)).json()).toEqual({ outcome: 'busy' });
    expect(runNow).toHaveBeenCalledWith(id);
  });

  it('トークンが無ければ通さない', async () => {
    expect((await app.request('/api/schedules')).status).toBe(401);
    void issueMcpSecret;
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
