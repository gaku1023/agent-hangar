import type { LaunchParams, LiveSessionDto, ProjectStatus, ServerEvent, SessionDto, SummaryState, TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
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

const NOT_YET = 'フェーズ 3 で対応します';
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

/** 引数の session_id、無ければセッション別 URL のセッション。どちらも無ければ失敗させる。 */
function sessionIdOf(ctx: ToolContext, args: Record<string, unknown>): string {
  const id = str(args.session_id) ?? ctx.sessionId;
  if (!id) throw new ToolError('session_id が必要です（セッション別 URL では省略できます）');
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

function requireSession(deps: ToolDeps, id: string): SessionDto {
  const s = getSession(deps.db, deps.live(), id);
  if (!s) throw new ToolError(`セッションが見つかりません: ${id}`);
  return s;
}

const url = (deps: ToolDeps, route: string) => `http://127.0.0.1:${deps.port}/#/${route}`;

export function listProjectsTool(deps: ToolDeps) {
  return listProjects(deps.db, deps.deviceId, deps.live()).map((p) => ({
    id: p.id, name: p.name, status: p.status, path: p.path, resolved: p.resolved,
    open_todo_count: p.openTodoCount, running_count: p.runningCount, last_activity_at: p.lastActivityAt,
  }));
}

export function getProjectTool(deps: ToolDeps, args: Record<string, unknown>) {
  const id = str(args.project_id);
  if (!id) throw new ToolError('project_id が必要です');
  const p = getProject(deps.db, deps.deviceId, deps.live(), id);
  if (!p) throw new ToolError(`プロジェクトが見つかりません: ${id}`);
  const memo = (deps.db.prepare('select markdown from project_memos where project_id = ? and deleted_at is null').get(id) as { markdown: string } | undefined)?.markdown ?? null;
  const todos = (deps.db.prepare('select id, text, done from todos where project_id = ? and deleted_at is null order by position').all(id) as { id: string; text: string; done: number }[])
    .map((t) => ({ id: t.id, text: t.text, done: t.done === 1 }));
  const recent = listSessions(deps.db, deps.live(), { projectId: id }).slice(0, RECENT_SESSIONS).map(sessionBrief);
  // アーティファクトの抽出はフェーズ 3 なので、いまは空で返す。
  return { id: p.id, name: p.name, status: p.status, path: p.path, resolved: p.resolved, last_activity_at: p.lastActivityAt, memo, todos, recent_sessions: recent, artifacts: [] };
}

export function updateProjectTool(deps: ToolDeps, args: Record<string, unknown>) {
  const id = str(args.project_id);
  if (!id) throw new ToolError('project_id が必要です');
  const row = deps.db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new ToolError(`プロジェクトが見つかりません: ${id}`);
  const status = str(args.status);
  if (status !== undefined) {
    if (!STATUSES.includes(status as ProjectStatus)) throw new ToolError(`status は ${STATUSES.join('、')} のいずれかです`);
    upsertShared(deps.db, 'projects', { ...row, status }, deps.deviceId);
    deps.hub.broadcast({ type: 'project.upsert', project: getProject(deps.db, deps.deviceId, deps.live(), id)! });
  }
  const ignored = ['add_todos', 'toggle_todos', 'append_memo'].filter((k) => args[k] !== undefined);
  const p = getProject(deps.db, deps.deviceId, deps.live(), id)!;
  return { project: { id: p.id, name: p.name, status: p.status }, not_yet: ignored.length ? { fields: ignored, message: NOT_YET } : null };
}

export function listSessionsTool(deps: ToolDeps, args: Record<string, unknown>) {
  let list = listSessions(deps.db, deps.live(), { projectId: str(args.project_id) });
  const running = bool(args.running);
  if (running !== undefined) list = list.filter((s) => (s.live !== null) === running);
  return list.slice(0, num(args.limit) ?? DEFAULT_LIST_LIMIT).map(sessionBrief);
}

export function searchSessionsTool(deps: ToolDeps, args: Record<string, unknown>) {
  const q = str(args.query) ?? '';
  const runningIds = new Set(deps.live().map((l) => l.sessionId));
  const r = searchSessions(deps.db, { q, projectId: str(args.project_id), since: num(args.since), until: num(args.until), file: str(args.file), limit: num(args.limit) }, runningIds);
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

export function createSessionTool(deps: ToolDeps, args: Record<string, unknown>) {
  const projectId = str(args.project_id);
  if (!projectId) throw new ToolError('project_id が必要です');
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
    source: 'in_session', source_model: null, based_on_turns: turns,
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

export function openInHangarTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const projectId = str(args.project_id);
  if (projectId) return { url: url(deps, `project/${projectId}`), deep_link: `hangar://project/${projectId}` };
  const id = sessionIdOf(ctx, args);
  return { url: url(deps, `session/${id}`), deep_link: `hangar://session/${id}` };
}

/** 名前で振り分ける。MCP の層はこれを content に包むだけにする。 */
export function callTool(deps: ToolDeps, ctx: ToolContext, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'list_projects': return listProjectsTool(deps);
    case 'get_project': return getProjectTool(deps, args);
    case 'update_project': return updateProjectTool(deps, args);
    case 'list_sessions': return listSessionsTool(deps, args);
    case 'search_sessions': return searchSessionsTool(deps, args);
    case 'get_transcript': return getTranscriptTool(deps, ctx, args);
    case 'create_session': return createSessionTool(deps, args);
    case 'set_session_summary': return setSessionSummaryTool(deps, ctx, args);
    case 'set_session_memo': return setSessionMemoTool(deps, ctx, args);
    // 使用量はフェーズ 3 の範囲なので、いまは断りだけを返す。
    case 'get_usage': return { not_yet: NOT_YET };
    case 'open_in_hangar': return openInHangarTool(deps, ctx, args);
    default: throw new ToolError(`知らないツールです: ${name}`);
  }
}
