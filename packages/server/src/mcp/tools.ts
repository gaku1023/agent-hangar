import type { LaunchParams, LiveSessionDto, ProjectDto, ProjectStatus, ServerEvent, SessionDto, SummaryState, TranscriptEvent, UsageDto } from '@agent-hangar/shared';
import { listArtifacts } from '../artifacts/queries.ts';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import type { MemoStore } from '../projects/memo.ts';
import { addTodo, listTodos, setTodoDone } from '../projects/todos.ts';
import type { LaunchResult } from '../runs/manager.ts';
import { searchSessions } from '../search/search.ts';
import { readEvents } from '../transcript/read.ts';

export type ToolDeps = {
  db: Db;
  deviceId: string;
  port: number;
  live: () => LiveSessionDto[];
  runs: { start(params: LaunchParams): LaunchResult };
  hub: { broadcast(ev: ServerEvent): void };
  usage: () => UsageDto;
  memos: MemoStore;
};
/** セッション別 URL では、そのセッションに固定される。共通 URL では null。 */
export type ToolContext = { sessionId: string | null };

/** ツールの呼び出しが失敗したこと。MCP の層はこれを isError の応答に変える。 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export const TOOL_NAMES = [
  'list_projects', 'get_project', 'update_project', 'list_sessions', 'search_sessions', 'get_transcript',
  'create_session', 'set_session_summary', 'set_session_memo', 'get_usage', 'open_in_hangar',
] as const;

const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];
const STATES: SummaryState[] = ['in_progress', 'done', 'blocked', 'abandoned'];
/** 一覧で返す件数の既定値。呼び手が limit を指定すればそちらを使う。 */
const DEFAULT_LIST_LIMIT = 50;
/** get_project が添える直近のセッションの件数。 */
const RECENT_SESSIONS = 10;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

/**
 * 引数の session_id、無ければセッション別 URL のセッション。どちらも無ければ失敗させる。
 * セッション別 URL では、そのセッション以外の id を黙って無視せずに断る。
 * 黙って読み替えると、呼び手は別のセッションを触ったつもりのまま結果を受け取ってしまう。
 */
function sessionIdOf(ctx: ToolContext, args: Record<string, unknown>): string {
  const given = str(args.session_id);
  if (ctx.sessionId) {
    if (given && given !== ctx.sessionId) throw new ToolError(`この MCP の URL はセッション ${ctx.sessionId} 専用です。ほかの session_id は指定できません`);
    return ctx.sessionId;
  }
  if (!given) throw new ToolError('session_id が必要です（セッション別 URL では省略できます）');
  return given;
}

/**
 * セッション別 URL が閉じ込めるプロジェクト。
 * 共通 URL では undefined、そのセッションがまだプロジェクトに属していなければ null になる。
 */
function scopeProjectId(deps: ToolDeps, ctx: ToolContext): string | null | undefined {
  if (!ctx.sessionId) return undefined;
  return requireSession(deps, ctx.sessionId).projectId;
}

const NO_PROJECT = 'このセッションはまだプロジェクトに属していないため、プロジェクトの道具は使えません';

/** 引数の project_id を枠に照らし、枠の外を指していれば断る。返すのは枠そのものである。 */
function projectScope(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>): string | null | undefined {
  const scope = scopeProjectId(deps, ctx);
  const given = str(args.project_id);
  if (scope !== undefined && given && given !== scope) {
    throw new ToolError(scope === null ? NO_PROJECT : `この MCP の URL はプロジェクト ${scope} に閉じています。ほかの project_id は指定できません`);
  }
  return scope;
}

/** プロジェクトを 1 件に決める道具のための project_id。 */
function projectIdOf(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>): string {
  const scope = projectScope(deps, ctx, args);
  if (scope === null) throw new ToolError(NO_PROJECT);
  const id = scope ?? str(args.project_id);
  if (!id) throw new ToolError('project_id が必要です');
  return id;
}

/**
 * セッション 1 件の要点。
 * resume_command だけは Claude の UUID を使う。ほかの項目の id は hangar の sessions.id である。
 */
function sessionBrief(s: SessionDto) {
  return {
    id: s.id,
    name: s.name,
    project_id: s.projectId,
    cwd: s.cwd,
    live: s.live,
    started_at: s.startedAt,
    last_activity_at: s.lastActivityAt,
    memo: s.memo,
    summary: s.summary ? { title: s.summary.title, one_liner: s.summary.oneLiner, state: s.summary.state, source: s.summary.source } : null,
    resume_command: `claude -r ${s.providerSessionId}`,
  };
}

/** プロジェクトの TODO を MCP の綴りで返す。 */
function todoBriefs(deps: ToolDeps, projectId: string) {
  return listTodos(deps.db, projectId).map((t) => ({ id: t.id, text: t.text, done: t.done, session_id: t.sessionId }));
}

function requireSession(deps: ToolDeps, id: string): SessionDto {
  const s = getSession(deps.db, deps.live(), id);
  if (!s) throw new ToolError(`セッションが見つかりません: ${id}`);
  return s;
}

function requireProject(deps: ToolDeps, id: string): ProjectDto {
  const p = getProject(deps.db, deps.deviceId, deps.live(), id);
  if (!p) throw new ToolError(`プロジェクトが見つかりません: ${id}`);
  return p;
}

const url = (deps: ToolDeps, route: string) => `http://127.0.0.1:${deps.port}/#/${route}`;

export function listProjectsTool(deps: ToolDeps, ctx: ToolContext) {
  const scope = scopeProjectId(deps, ctx);
  return listProjects(deps.db, deps.deviceId, deps.live()).filter((p) => scope === undefined || p.id === scope).map((p) => ({
    id: p.id, name: p.name, status: p.status, path: p.path, resolved: p.resolved,
    open_todo_count: p.openTodoCount, running_count: p.runningCount, last_activity_at: p.lastActivityAt,
  }));
}

export function getProjectTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = projectIdOf(deps, ctx, args);
  const p = requireProject(deps, id);
  const memo = deps.memos.read(id)?.markdown ?? null;
  const todos = todoBriefs(deps, id);
  const recent = listSessions(deps.db, deps.live(), { projectId: id }).slice(0, RECENT_SESSIONS).map(sessionBrief);
  const artifacts = listArtifacts(deps.db, { projectId: id })
    .map((a) => ({ id: a.id, url: a.url, title: a.title, favicon: a.favicon, last_published_at: a.lastPublishedAt, version_count: a.versionCount }));
  return { id: p.id, name: p.name, status: p.status, path: p.path, resolved: p.resolved, last_activity_at: p.lastActivityAt, open_todo_count: p.openTodoCount, memo, todos, recent_sessions: recent, artifacts };
}

/** status、add_todos、toggle_todos、append_memo を受け、変えた表ごとにイベントを配る。 */
export function updateProjectTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = projectIdOf(deps, ctx, args);
  const row = deps.db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new ToolError(`プロジェクトが見つかりません: ${id}`);
  // status を「省略」と「型違いの値」で区別する。str() だけでは数値や null が黙って無視される。
  if (args.status !== undefined) {
    const status = args.status;
    if (typeof status !== 'string' || !STATUSES.includes(status as ProjectStatus)) throw new ToolError(`status は ${STATUSES.join('、')} のいずれかです`);
    upsertShared(deps.db, 'projects', { ...row, status }, deps.deviceId);
    deps.hub.broadcast({ type: 'project.upsert', project: getProject(deps.db, deps.deviceId, deps.live(), id)! });
  }
  const adds = strs(args.add_todos) ?? [];
  const toggles = strs(args.toggle_todos) ?? [];
  if (adds.length || toggles.length) {
    // 全部成功か全部失敗にする。
    // 途中で失敗して書き込みだけが残ると、todos.update を配らないまま DB が進み、UI と食い違ったまま気付けない。
    deps.db.transaction(() => {
      for (const t of adds) addTodo(deps.db, deps.deviceId, { projectId: id, text: t, sessionId: ctx.sessionId });
      for (const tid of toggles) {
        const cur = deps.db.prepare('select done from todos where id = ? and project_id = ? and deleted_at is null').get(tid, id) as { done: number } | undefined;
        if (!cur) throw new ToolError(`TODO が見つかりません: ${tid}`);
        setTodoDone(deps.db, deps.deviceId, tid, cur.done !== 1);
      }
    })();
    deps.hub.broadcast({ type: 'todos.update', projectId: id, todos: listTodos(deps.db, id) });
  }
  const append = typeof args.append_memo === 'string' ? args.append_memo : undefined;
  const appended = append !== undefined && append.trim() !== '';
  if (appended) {
    const cur = deps.memos.read(id)?.markdown ?? '';
    const memo = deps.memos.write(id, cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${append}` : append);
    deps.hub.broadcast({ type: 'memo.update', memo });
  }
  // TODO とメモの変更で ProjectDto の openTodoCount と memoHead が変わるので、最後にもう一度配る。
  const p = getProject(deps.db, deps.deviceId, deps.live(), id)!;
  if (adds.length || toggles.length || appended) deps.hub.broadcast({ type: 'project.upsert', project: p });
  return {
    project: { id: p.id, name: p.name, status: p.status, open_todo_count: p.openTodoCount },
    todos: todoBriefs(deps, id),
    memo: deps.memos.read(id)?.markdown ?? null,
  };
}

export function listSessionsTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const scope = projectScope(deps, ctx, args);
  let list = listSessions(deps.db, deps.live(), { projectId: scope === undefined ? str(args.project_id) : (scope ?? undefined) });
  // プロジェクトに属していないセッションの URL では、そのセッション自身だけを見せる。
  if (scope === null) list = list.filter((s) => s.id === ctx.sessionId);
  const running = bool(args.running);
  if (running !== undefined) list = list.filter((s) => (s.live !== null) === running);
  // 負数の limit を slice にそのまま渡すと末尾から削る意味になるので、下限を 0 で押さえる。
  const limit = Math.max(num(args.limit) ?? DEFAULT_LIST_LIMIT, 0);
  return list.slice(0, limit).map(sessionBrief);
}

export function searchSessionsTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const q = str(args.query) ?? '';
  const scope = projectScope(deps, ctx, args);
  // プロジェクトに属していないセッションの URL では、横断の検索を渡さない。
  if (scope === null) throw new ToolError(NO_PROJECT);
  const runningIds = new Set(deps.live().map((l) => l.sessionId));
  const r = searchSessions(deps.db, { q, projectId: scope ?? str(args.project_id), since: num(args.since), until: num(args.until), file: str(args.file), limit: num(args.limit) }, runningIds);
  const hits = r.hits.map((h) => {
    const s = getSession(deps.db, deps.live(), h.sessionId);
    return {
      session_id: h.sessionId,
      title: s?.summary?.title ?? s?.name ?? null,
      one_liner: s?.summary?.oneLiner ?? null,
      project_id: s?.projectId ?? null,
      last_activity_at: s?.lastActivityAt ?? null,
      match_count: h.matchCount,
      snippets: h.snippets,
      resume_command: s ? `claude -r ${s.providerSessionId}` : null,
    };
  });
  return { total: r.total, hits };
}

export function getTranscriptTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const includeTools = bool(args.include_tools) ?? false;
  const page = readEvents(deps.db, id, { fromSeq: num(args.from_seq), limit: num(args.limit) });
  // thinking と meta は外の AI に渡さない。ツールの呼び出しと結果は include_tools のときだけ渡す。
  const keep = (e: TranscriptEvent) =>
    e.kind === 'user' || e.kind === 'assistant' || e.kind === 'system' || e.kind === 'subagent'
    || (includeTools && (e.kind === 'tool_call' || e.kind === 'tool_result'));
  return { session_id: id, events: page.events.filter(keep), total: page.total, next_seq: page.nextSeq };
}

export function createSessionTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const projectId = projectIdOf(deps, ctx, args);
  const r = deps.runs.start({
    projectId, name: str(args.name), prompt: str(args.prompt), model: str(args.model),
    effort: str(args.effort), permissionMode: str(args.permission_mode), scratch: bool(args.scratch),
  });
  return { run_id: r.run.id, session_id: r.sessionId, tmux_name: r.run.tmuxName, url: url(deps, `session/${r.sessionId}`) };
}

export function setSessionSummaryTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const title = str(args.title);
  const oneLiner = str(args.one_liner);
  const body = str(args.body);
  const state = str(args.state);
  if (!title || !oneLiner || !body || !state) throw new ToolError('title、one_liner、body、state が必要です');
  if (!STATES.includes(state as SummaryState)) throw new ToolError(`state は ${STATES.join('、')} のいずれかです`);
  const turns = (deps.db.prepare('select turns from session_stats where session_id = ?').get(id) as { turns: number } | undefined)?.turns ?? 0;
  upsertShared(deps.db, 'session_summaries', {
    session_id: id, title, one_liner: oneLiner, body, state,
    next_steps: JSON.stringify(strs(args.next_steps) ?? []),
    source: 'in_session', source_id: null, source_model: null, based_on_turns: turns,
  }, deps.deviceId, 'session_id');
  deps.hub.broadcast({ type: 'session.upsert', session: getSession(deps.db, deps.live(), id)! });
  return { ok: true, session_id: id };
}

export function setSessionMemoTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const row = deps.db.prepare('select * from sessions where id = ?').get(id) as Record<string, unknown>;
  upsertShared(deps.db, 'sessions', { ...row, memo: typeof args.text === 'string' ? args.text : '' }, deps.deviceId);
  deps.hub.broadcast({ type: 'session.upsert', session: getSession(deps.db, deps.live(), id)! });
  return { ok: true, session_id: id };
}

/** statusline から届いた最新の使用率。まだ届いていない窓は null になる。 */
export function getUsageTool(deps: ToolDeps) {
  const u = deps.usage();
  const w = (x: { usedPercent: number; resetsAt: number | null } | null) => (x ? { used_percentage: x.usedPercent, resets_at: x.resetsAt } : null);
  return { five_hour: w(u.fiveHour), seven_day: w(u.sevenDay), updated_at: u.updatedAt };
}

export function openInHangarTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  // 実在しない ID を死んだリンクにして返さない。打ち間違いはここで失敗させる。
  const projectId = str(args.project_id) ? projectIdOf(deps, ctx, args) : undefined;
  if (projectId) {
    requireProject(deps, projectId);
    return { url: url(deps, `project/${projectId}`), deep_link: `hangar://project/${projectId}` };
  }
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  return { url: url(deps, `session/${id}`), deep_link: `hangar://session/${id}` };
}

/** 名前で振り分ける。MCP の層はこれを content に包むだけにする。 */
export function callTool(deps: ToolDeps, ctx: ToolContext, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'list_projects': return listProjectsTool(deps, ctx);
    case 'get_project': return getProjectTool(deps, ctx, args);
    case 'update_project': return updateProjectTool(deps, ctx, args);
    case 'list_sessions': return listSessionsTool(deps, ctx, args);
    case 'search_sessions': return searchSessionsTool(deps, ctx, args);
    case 'get_transcript': return getTranscriptTool(deps, ctx, args);
    case 'create_session': return createSessionTool(deps, ctx, args);
    case 'set_session_summary': return setSessionSummaryTool(deps, ctx, args);
    case 'set_session_memo': return setSessionMemoTool(deps, ctx, args);
    case 'get_usage': return getUsageTool(deps);
    case 'open_in_hangar': return openInHangarTool(deps, ctx, args);
    default: throw new ToolError(`知らないツールです: ${name}`);
  }
}
