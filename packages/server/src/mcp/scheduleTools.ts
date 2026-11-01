import { isAgentKind, type ScheduleSpec, type ScheduleTarget } from '@agent-hangar/shared';
import { getSession } from '../db/queries.ts';
import { MessageError, msg } from '../i18n/message.ts';
import { createSchedule, getSchedule, listSchedules, updateSchedule } from '../schedule/store.ts';
import { parseSpec } from '../schedule/timing.ts';
import { projectIdOf, projectScope, ToolError, type ToolContext, type ToolDeps } from './tools.ts';

/**
 * 予定の MCP の道具（#549）。作る、変える、止める（enabled: false）までで、消す道具は持たない。
 * 消すと履歴ごと戻せないので、画面だけに置く（mcp/toolClasses.ts）。セッション別の URL では、そのプロジェクトの予定にだけ届く。
 */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** 平らな引数から予定の形を組む。形の検査は parseSpec に任せる。 */
function specArg(args: Record<string, unknown>, now: number): ScheduleSpec {
  const at = typeof args.at === 'string' ? new Date(args.at).getTime() : args.at;
  return parseSpec({ kind: args.kind, at, days: args.days, time: args.time, minutes: args.every_minutes }, now);
}

/** 新しい会話か既存の会話か。session_id があれば既存の会話で、枠の外の会話には届かない。 */
function targetArg(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>): { target: ScheduleTarget; projectId: string | null } {
  const sid = str(args.session_id);
  if (sid) {
    const s = getSession(deps.db, deps.live(), sid, { deviceId: deps.deviceId });
    if (!s) throw new ToolError(msg('mcp.error.sessionNotFound', { id: sid }));
    const scope = projectScope(deps, ctx, {});
    if (scope !== undefined && s.projectId !== scope) throw new ToolError(msg('schedules.error.outOfScope'));
    return { target: { kind: 'session', sessionId: sid }, projectId: s.projectId };
  }
  const projectId = projectIdOf(deps, ctx, args);
  const agent = args.agent;
  if (agent !== undefined && !isAgentKind(agent)) throw new ToolError(msg('run.agent.unknown', { agent: String(agent).slice(0, 40) }));
  return { target: { kind: 'new', projectId, ...(agent ? { agent } : {}) }, projectId };
}

/** MessageError を道具の断りにする。 */
function guarded<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof MessageError && !(e instanceof ToolError) && e.text) throw new ToolError(e.text);
    throw e;
  }
}

export function listSchedulesTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const scope = projectScope(deps, ctx, args);
  const id = scope === undefined ? str(args.project_id) : scope ?? '';
  return { schedules: listSchedules(deps.db, deps.deviceId, id) };
}

export function createScheduleTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  return guarded(() => {
    const spec = specArg(args, now);
    const { target, projectId } = targetArg(deps, ctx, args);
    return createSchedule(deps.db, { deviceId: deps.deviceId, prompt: typeof args.prompt === 'string' ? args.prompt : '', spec, target, projectId, fromSessionId: ctx.sessionId, now });
  });
}

export function updateScheduleTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  return guarded(() => {
    const id = str(args.schedule_id);
    if (!id) throw new ToolError(msg('schedules.error.idRequired'));
    const cur = getSchedule(deps.db, deps.deviceId, id);
    if (!cur) throw new ToolError(msg('schedules.error.notFound', { id }));
    const scope = projectScope(deps, ctx, {});
    if (scope !== undefined && cur.projectId !== scope) throw new ToolError(msg('schedules.error.outOfScope'));
    const moved = str(args.session_id) || str(args.project_id) ? targetArg(deps, ctx, args) : null;
    return updateSchedule(deps.db, id, {
      ...(typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
      ...(args.kind !== undefined ? { spec: specArg(args, now) } : {}),
      ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
      ...(moved ? moved : {}),
    }, now);
  });
}
