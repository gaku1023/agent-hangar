import type { ScheduleSpec, ScheduleTarget } from '@agent-hangar/shared';
import { getSession } from '../db/queries.ts';
import { MessageError, msg } from '../i18n/message.ts';
import { accountNamerOf, createSchedule, getSchedule, listSchedules, updateSchedule, type AccountNamer } from '../schedule/store.ts';
import { parseNewTarget } from '../schedule/target.ts';
import { parseSpec } from '../schedule/timing.ts';
import { accountNamed, projectIdOf, projectScope, ToolError, type ToolContext, type ToolDeps } from './tools.ts';

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

type NewTarget = Extract<ScheduleTarget, { kind: 'new' }>;

/** 新しい会話の起動の項目の引数（create_session と同じ名前）と、予定の target の項目名の対応。 */
const LAUNCH_ARGS: readonly [arg: string, key: string][] = [
  ['agent', 'agent'], ['name', 'name'], ['account', 'account'], ['model', 'model'], ['effort', 'effort'], ['permission_mode', 'permissionMode'],
  ['worktree', 'worktree'], ['add_dirs', 'addDirs'], ['mode', 'mode'], ['auto_approve', 'autoApprove'],
];

/** 渡された起動の項目があるか（project_id と scratch は含まない）。 */
const hasLaunchArgs = (args: Record<string, unknown>): boolean => LAUNCH_ARGS.some(([a]) => args[a] !== undefined);

/**
 * 新しい会話か既存の会話か。session_id があれば既存の会話で、枠の外の会話には届かない。
 * base（変えるときの、いまの新しい会話の宛先）があれば、渡されなかった項目はそこから引き継ぐ。空の文字列は、その項目を既定に戻す。
 * エージェントに合わない項目は、保存の前に parseNewTarget が断る。
 */
function targetArg(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, base?: NewTarget): { target: ScheduleTarget; projectId: string | null } {
  const sid = str(args.session_id);
  if (sid) {
    const s = getSession(deps.db, deps.live(), sid, { deviceId: deps.deviceId });
    if (!s) throw new ToolError(msg('mcp.error.sessionNotFound', { id: sid }));
    const scope = projectScope(deps, ctx, {});
    if (scope !== undefined && s.projectId !== scope) throw new ToolError(msg('schedules.error.outOfScope'));
    return { target: { kind: 'session', sessionId: sid }, projectId: s.projectId };
  }
  const scratch = args.scratch === true || (args.scratch === undefined && !str(args.project_id) && base?.scratch === true);
  let projectId: string | null;
  if (scratch) {
    // プロジェクトを固定した URL からは、プロジェクトを持たない予定を作れない。
    if (projectScope(deps, ctx, {}) !== undefined) throw new ToolError(msg('schedules.error.scratchScoped'));
    projectId = null;
  } else {
    projectId = projectIdOf(deps, ctx, !str(args.project_id) && base?.projectId ? { ...args, project_id: base.projectId } : args);
  }
  // 宛先（プロジェクトかクイックセッション）が変わるなら、元の cwd は引き継がない。
  const moved = base !== undefined && (base.projectId !== projectId || (base.scratch === true) !== scratch);
  const raw: Record<string, unknown> = { kind: 'new', projectId, ...(scratch ? { scratch: true } : {}), ...(base && !moved && base.cwd ? { cwd: base.cwd } : {}) };
  for (const [arg, key] of LAUNCH_ARGS) {
    const given = args[arg];
    const prev = base ? (base as Record<string, unknown>)[key] : undefined;
    // 渡されなかった項目は、変える前の宛先から引き継ぐ。エージェントに合わなくなった項目は、parseNewTarget が断る。
    if (given !== undefined) raw[key] = given;
    else if (prev !== undefined) raw[key] = prev;
  }
  const effective = raw.agent ?? 'claude-code';
  // Claude Code と Codex のアカウントは、名前か id で渡せる（組は別）。保存するのは id である。
  const store = effective === 'claude-code' ? deps.accounts?.store : effective === 'codex' ? deps.codexAccounts : undefined;
  if (typeof args.account === 'string' && args.account.trim() && store) raw.account = accountNamed(store, args.account.trim()).id;
  const target = parseNewTarget(raw, (a) => deps.runs.agentEnabled?.(a) ?? false);
  return { target, projectId: target.projectId };
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

/** 予定の札に出すアカウントの表示名の引き方。Claude Code と Codex は別の組から引く。 */
const namesOf = (deps: ToolDeps): AccountNamer | undefined => (deps.accounts ? accountNamerOf({ store: deps.accounts.store, ...(deps.codexAccounts ? { codex: { store: deps.codexAccounts } } : {}) }) : undefined);

export function listSchedulesTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const scope = projectScope(deps, ctx, args);
  const id = scope === undefined ? str(args.project_id) : scope ?? '';
  return { schedules: listSchedules(deps.db, deps.deviceId, id, namesOf(deps)) };
}

export function createScheduleTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  return guarded(() => {
    const spec = specArg(args, now);
    const { target, projectId } = targetArg(deps, ctx, args);
    return createSchedule(deps.db, { deviceId: deps.deviceId, prompt: typeof args.prompt === 'string' ? args.prompt : '', spec, target, projectId, fromSessionId: ctx.sessionId, now, names: namesOf(deps) });
  });
}

export function updateScheduleTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  return guarded(() => {
    const id = str(args.schedule_id);
    if (!id) throw new ToolError(msg('schedules.error.idRequired'));
    const names = namesOf(deps);
    const cur = getSchedule(deps.db, deps.deviceId, id, names);
    if (!cur) throw new ToolError(msg('schedules.error.notFound', { id }));
    const scope = projectScope(deps, ctx, {});
    if (scope !== undefined && cur.projectId !== scope) throw new ToolError(msg('schedules.error.outOfScope'));
    // 宛先か起動の項目が渡されたら宛先を組み直す。新しい会話の予定の項目は、渡されなかったものを引き継ぐ。
    const touched = str(args.session_id) || str(args.project_id) || args.scratch !== undefined || hasLaunchArgs(args);
    const moved = touched ? targetArg(deps, ctx, args, cur.target.kind === 'new' ? cur.target : { kind: 'new', projectId: cur.projectId }) : null;
    return updateSchedule(deps.db, id, {
      ...(typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
      ...(args.kind !== undefined ? { spec: specArg(args, now) } : {}),
      ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
      ...(moved ? moved : {}),
    }, now, names);
  });
}
