import type { LaunchParams, LiveSessionDto, ProjectDto, ProjectStatus, ServerEvent, SessionDto, SessionStateDto, SummaryState, TranscriptEvent, UsageDto } from '@agent-hangar/shared';
import { listArtifacts } from '../artifacts/queries.ts';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { addIntent, INTENT_MAX } from '../live/intents.ts';
import type { MemoStore } from '../projects/memo.ts';
import { addTodo, CANDIDATE_NOTE_MAX, listTodos, proposeTodoDone, setTodoDone, type ProposeOutcome } from '../projects/todos.ts';
import type { LaunchResult } from '../runs/manager.ts';
import { searchSessions } from '../search/search.ts';
import { getSessionState, proposeSessionState, setSessionState, StateInputError, type ProposeStateOutcome } from '../sessions/states.ts';
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
  'create_session', 'set_session_summary', 'set_turn_intent', 'set_session_memo', 'get_usage', 'open_in_hangar',
  'propose_session_status',
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

/** プロジェクトの TODO を MCP の綴りで返す。セッションは、自分が出した候補が残っているかをここで確かめる。 */
function todoBriefs(deps: ToolDeps, projectId: string) {
  return listTodos(deps.db, projectId).map((t) => ({ id: t.id, text: t.text, done: t.done, session_id: t.sessionId, candidate: t.candidate ? { session_id: t.candidate.sessionId, note: t.candidate.note } : null }));
}

type TodoOutcome = ProposeOutcome | 'reopened';

/** propose_done の引数を検査して取り出す。1 件でも崩れていれば全体を断る（どの TODO も書かない）。 */
function proposalsOf(v: unknown): { todoId: string; note: string }[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ToolError('propose_done は { todo_id, note } の配列です');
  return v.map((x) => {
    const o = (typeof x === 'object' && x !== null ? x : {}) as { todo_id?: unknown; note?: unknown };
    if (typeof o.todo_id !== 'string' || typeof o.note !== 'string') throw new ToolError('propose_done の各項目には todo_id と note の文字列が要ります');
    const note = o.note.trim();
    if (!note) throw new ToolError('propose_done の note（根拠の一文）が空です');
    if ([...note].length > CANDIDATE_NOTE_MAX) throw new ToolError(`propose_done の note は ${CANDIDATE_NOTE_MAX} 字までです`);
    return { todoId: o.todo_id, note };
  });
}

function requireSession(deps: ToolDeps, id: string): SessionDto {
  const s = getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId });
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
  const recent = listSessions(deps.db, deps.live(), { projectId: id, deviceId: deps.deviceId }).slice(0, RECENT_SESSIONS).map(sessionBrief);
  const artifacts = listArtifacts(deps.db, { projectId: id })
    .map((a) => ({ id: a.id, url: a.url, title: a.title, favicon: a.favicon, last_published_at: a.lastPublishedAt, version_count: a.versionCount }));
  return { id: p.id, name: p.name, status: p.status, path: p.path, resolved: p.resolved, last_activity_at: p.lastActivityAt, open_todo_count: p.openTodoCount, memo, todos, recent_sessions: recent, artifacts };
}

/** status、add_todos、toggle_todos、propose_done、append_memo を受け、変えた表ごとにイベントを配る。 */
export function updateProjectTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = projectIdOf(deps, ctx, args);
  const row = deps.db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new ToolError(`プロジェクトが見つかりません: ${id}`);
  // 検証は書き込みの前に全部済ませる。status だけ書いてから propose_done で断ると、呼び出し側は「何も起きなかった」と読む。
  const proposals = proposalsOf(args.propose_done);
  // status を「省略」と「型違いの値」で区別する。str() だけでは数値や null が黙って無視される。
  if (args.status !== undefined) {
    const status = args.status;
    if (typeof status !== 'string' || !STATUSES.includes(status as ProjectStatus)) throw new ToolError(`status は ${STATUSES.join('、')} のいずれかです`);
    upsertShared(deps.db, 'projects', { ...row, status }, deps.deviceId);
    deps.hub.broadcast({ type: 'project.upsert', project: getProject(deps.db, deps.deviceId, deps.live(), id)! });
  }
  const adds = strs(args.add_todos) ?? [];
  const toggles = strs(args.toggle_todos) ?? [];
  const results: { todo_id: string; outcome: TodoOutcome }[] = [];
  const todosTouched = adds.length > 0 || toggles.length > 0 || proposals.length > 0;
  if (todosTouched) {
    // 全部成功か全部失敗にする。
    // 途中で失敗して書き込みだけが残ると、todos.update を配らないまま DB が進み、UI と食い違ったまま気付けない。
    // MCP からは完了にしない。完了にするのは利用者だけなので、未完の反転は根拠なしの候補にする。
    deps.db.transaction(() => {
      for (const t of adds) addTodo(deps.db, deps.deviceId, { projectId: id, text: t, sessionId: ctx.sessionId });
      const ofProject = (tid: string) => {
        const cur = deps.db.prepare('select done from todos where id = ? and project_id = ? and deleted_at is null').get(tid, id) as { done: number } | undefined;
        if (!cur) throw new ToolError(`TODO が見つかりません: ${tid}`);
        return cur;
      };
      // 同じ ID が両方にあるときは根拠つきの提案を先に通す。toggle が先だと根拠なしの候補になり、根拠が捨てられる。
      for (const p of proposals) {
        ofProject(p.todoId);
        results.push({ todo_id: p.todoId, outcome: proposeTodoDone(deps.db, deps.deviceId, p.todoId, { sessionId: ctx.sessionId, note: p.note })!.outcome });
      }
      for (const tid of toggles) {
        if (ofProject(tid).done === 1) {
          setTodoDone(deps.db, deps.deviceId, tid, false);
          results.push({ todo_id: tid, outcome: 'reopened' });
        } else {
          results.push({ todo_id: tid, outcome: proposeTodoDone(deps.db, deps.deviceId, tid, { sessionId: ctx.sessionId, note: null })!.outcome });
        }
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
  if (todosTouched || appended) deps.hub.broadcast({ type: 'project.upsert', project: p });
  return {
    project: { id: p.id, name: p.name, status: p.status, open_todo_count: p.openTodoCount },
    todos: todoBriefs(deps, id),
    todo_results: results,
    memo: deps.memos.read(id)?.markdown ?? null,
  };
}

export function listSessionsTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const scope = projectScope(deps, ctx, args);
  let list = listSessions(deps.db, deps.live(), { projectId: scope === undefined ? str(args.project_id) : (scope ?? undefined), deviceId: deps.deviceId });
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
  // 状態では絞らないので、状態を返す関数は渡さない。
  const r = searchSessions(deps.db, { q, projectId: scope ?? str(args.project_id), since: num(args.since), until: num(args.until), file: str(args.file), limit: num(args.limit) });
  const hits = r.hits.map((h) => {
    const s = getSession(deps.db, deps.live(), h.sessionId, { deviceId: deps.deviceId });
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
  deps.hub.broadcast({ type: 'session.upsert', session: getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId })! });
  return { ok: true, session_id: id };
}

/**
 * このターンの意図を書く。要約（set_session_summary）とは粒度が違うので、別のツールにしてある。
 * 数え方は Array.from で文字単位にする（サロゲートの字を 2 字と数えない）。
 */
export function setTurnIntentTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (text.length === 0 || [...text].length > INTENT_MAX) throw new ToolError(`text は空白を除いて 1 字以上 ${INTENT_MAX} 字以下です`);
  const it = addIntent(deps.db, id, text, now);
  return { ok: true, session_id: id, at: it.at };
}

/**
 * このセッションの状態（Done か Paused）を提案する。
 * confirmed が true のときだけ状態にする。利用者が会話の中で選んだという申告で、hangar はそれを確かめられない。
 * その余地は利用者の決定（2026-10-01）として受け入れ、代わりに set_by を conversation にして後から分かるようにする。
 * 却下された提案は、そのセッションに新しい発言があるまで受け付けない（rejected_before）。
 * note と return_on の中身の検査は states.ts に任せる。ここでは型と status だけを見て、StateInputError を ToolError に変える。
 * 検査は書く前に済む。どれかに落ちたら何も書かず、何も配らない。
 */
export function proposeSessionStatusTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const status = args.status;
  if (status !== 'done' && status !== 'paused') throw new ToolError('status は done か paused です');
  if (args.note !== undefined && typeof args.note !== 'string') throw new ToolError('note は文字列です');
  if (args.return_on !== undefined && typeof args.return_on !== 'string') throw new ToolError('return_on は YYYY-MM-DD の形の文字列です');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new ToolError('confirmed は true か false です');
  const note = args.note ?? '';
  // Done は戻る日を持たないので、渡されても捨てる（すでに付いた状態との比べにも、この値を使う）。
  const returnOn = status === 'paused' ? args.return_on ?? null : null;
  try {
    let r: { outcome: ProposeStateOutcome; state: SessionStateDto };
    if (args.confirmed === true) {
      const cur = getSessionState(deps.db, id);
      r = cur && cur.status === status && cur.returnOn === returnOn
        ? { outcome: 'already_set', state: cur }
        : { outcome: 'set', state: setSessionState(deps.db, deps.deviceId, id, { status, note, returnOn, setBy: 'conversation', now }) };
    } else {
      r = proposeSessionState(deps.db, deps.deviceId, id, { status, note, returnOn, source: 'in_session', now });
    }
    if (r.outcome === 'set' || r.outcome === 'proposed') deps.hub.broadcast({ type: 'session.upsert', session: getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId })! });
    return { outcome: r.outcome, state: r.state };
  } catch (e) {
    if (e instanceof StateInputError) throw new ToolError(e.message);
    throw e;
  }
}

export function setSessionMemoTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const row = deps.db.prepare('select * from sessions where id = ?').get(id) as Record<string, unknown>;
  upsertShared(deps.db, 'sessions', { ...row, memo: typeof args.text === 'string' ? args.text : '' }, deps.deviceId);
  deps.hub.broadcast({ type: 'session.upsert', session: getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId })! });
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
    case 'set_turn_intent': return setTurnIntentTool(deps, ctx, args);
    case 'set_session_memo': return setSessionMemoTool(deps, ctx, args);
    case 'get_usage': return getUsageTool(deps);
    case 'open_in_hangar': return openInHangarTool(deps, ctx, args);
    case 'propose_session_status': return proposeSessionStatusTool(deps, ctx, args);
    default: throw new ToolError(`知らないツールです: ${name}`);
  }
}
