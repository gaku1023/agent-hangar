import { randomUUID } from 'node:crypto';
import { isAgentKind, isNotifyKind, isQuietStatus, notifyRulesOf, localDate, localTime, returnAtIso, returnAtMs, type AgentKind, type LaunchParams, type LiveSessionDto, type NotifyKind, type NotifyPreference, type PermissionAskDto, type ProjectDto, type ProjectStatus, type RunDto, type SessionDto, type SessionStateDto, type SummaryState, type TranscriptEvent, type UsageDto } from '@agent-hangar/shared';
import { listArtifacts } from '../artifacts/queries.ts';
import { PRIMARY_ACCOUNT_ID, type Account, type AccountStore } from '../config/accounts.ts';
import type { Db } from '../db/open.ts';
import { accountOfSession, getProject, getSession, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { addIntent, INTENT_MAX, noteIntent } from '../live/intents.ts';
import { addUnread, noteUnread, NOTIFY_TARGETS, type NotifyTarget } from '../live/unread.ts';
import { touchRow } from '../db/notify.ts';
import { addTodo, CANDIDATE_NOTE_MAX, listTodos, proposeTodoDone, setTodoDone, type ProposeOutcome } from '../projects/todos.ts';
import { defaultLanguage, type GetLanguage } from '../i18n/language.ts';
import { errorText, MessageError, msg, render, type Message } from '../i18n/message.ts';
import { agentEnabledLabel, type LaunchHooks, type LaunchResult } from '../runs/manager.ts';
import { searchSessions } from '../search/search.ts';
import { recordSpawn } from '../sessions/spawns.ts';
import { getSessionState, proposeSessionState, setSessionState, StateInputError, validateStateInput, type ProposeStateOutcome } from '../sessions/states.ts';
import { readEvents } from '../transcript/read.ts';
import { deviceOfSession } from '../runs/handover.ts';
import type { ReportService } from '../report/service.ts';
import { readSessionScreenTool, sendToSessionTool } from './screenTools.ts';

export type ToolDeps = {
  db: Db;
  deviceId: string;
  port: number;
  live: () => LiveSessionDto[];
  /** agentEnabled はそのエージェントを起こしてよいか（runs/manager.ts）。無ければ Claude Code だけを起こす。 */
  runs: {
    start(params: LaunchParams, hooks?: LaunchHooks): LaunchResult | Promise<LaunchResult>; agentEnabled?(kind: AgentKind): boolean;
    /** その鍵の起動前の準備が走っているか。無ければ準備を待たずに返すことはしない。 */
    prepRunning?(key: string): boolean;
    /** そのセッションの生きた run（どの PC のものでも）。無ければ null。stop_session と resume_session が使う。 */
    aliveRun?(sessionId: string): RunDto | null;
    /** UI の停止（DELETE /api/runs/:id）と同じ処理。 */
    kill?(runId: string): unknown;
    /** UI の再開（POST /api/sessions/:id/resume）と同じ処理。account は Claude Code の会話のときだけ渡す。 */
    resumeWith?(sessionId: string, o?: { account?: string; prepKey?: string }): LaunchResult | Promise<LaunchResult>;
    /** tmux の名前の画面にいま見えている文字。画面が無ければ null。無ければ read_session_screen は断る。 */
    readScreen?(tmuxName: string): string | null;
    /** tmux の名前の画面へ、text を 1 つの入力として貼り、submit なら Enter で確定する。届けられなければ投げる。無ければ send_to_session は断る。 */
    sendInput?(tmuxName: string, text: string, submit: boolean): Promise<void>;
  };
  /** 削除（DELETE /api/sessions/:id）と同じ処理。無ければ delete_session は知らない道具として断る。 */
  trash?: { deleteSession(sessionId: string): Promise<void> };
  usage: () => UsageDto;
  /** アカウントの口。無ければ get_usage は最初のアカウントの値だけを返し、create_session はアカウントを選ばない（runs.start がいまのアカウントで起こす）。 */
  accounts?: { store: Pick<AccountStore, 'list' | 'current' | 'get'>; usage: { of(accountId: string): UsageDto } };
  /** 道具の説明と結果の文の言語。渡さなければ日本語で出す。 */
  language?: GetLanguage;
  /** notify_user の出し先の設定（notifyPreference と、古いスイッチの unreadBadge、unreadOs、unreadPhone）。無ければ既定（全部入り）として読む。 */
  settings?: () => { notifyPreference?: NotifyPreference | null; unreadBadge?: boolean; unreadOs?: boolean; unreadPhone?: boolean };
  /** 設定の保存（PATCH /api/settings と同じ道）。保存して、変えた欄を全部の画面へ配る。無ければ set_notify_preference は知らない道具として断る。 */
  saveNotifyPreference?: (p: NotifyPreference) => void;
  /** hook から届いた許可の確認の預け先（sessions/permissionAsks.ts）。無ければ許可の確認は読まない。 */
  permissionAsks?: { put(providerSessionId: string, ask: PermissionAskDto, now: number): void };
  /** 作者への問い合わせの口（report/service.ts）。無ければ draft_issue_report と submit_issue_report は断る。 */
  report?: Pick<ReportService, 'draft' | 'submit'>;
  /** URL を既定のブラウザで開く口。問い合わせの送信で gh が使えないときに使う。 */
  openUrl?: (url: string) => Promise<void>;
  /** create_session と resume_session が起動を待つ上限（ミリ秒）。越えても準備が走っていれば、待たずに preparing で返す。渡さなければ LAUNCH_WAIT_MS。 */
  launchWaitMs?: number;
};
/** セッション別 URL では、そのセッションに固定される。共通 URL では null。 */
export type ToolContext = { sessionId: string | null };

/** ツールの呼び出しが失敗したこと。MCP の層はこれを、いまの言語の文にして isError の応答に変える。 */
export class ToolError extends MessageError {
  constructor(text: Message | string) {
    super(text);
    this.name = 'ToolError';
  }
}

/**
 * 道具の名前。
 * セッションのノートを書く set_session_memo は 0.4.0 で道具ごと外した（要約の set_session_summary と Paused の戻る日が役を担う）。
 * update_project の append_memo のように notice で答える形にしないのは、あちらは同じ呼び出しのほかの項目を書くためにエラーにしなかったのに対し、
 * こちらは道具が 1 つの仕事しか持たず、外した後の一覧に無い道具を呼ばれても、MCP の層が書かずに isError（道具が無い）で返すからである。
 * モデルにこの道具を使うよう指示したことも無いので、古い指示を覚えた Claude が呼び続けることもない。
 */
export const TOOL_NAMES = [
  'list_projects', 'get_project', 'update_project', 'list_sessions', 'search_sessions', 'get_transcript',
  'create_session', 'set_session_summary', 'set_turn_intent', 'get_usage', 'open_in_hangar',
  'propose_session_status', 'draft_issue_report', 'submit_issue_report',
  'stop_session', 'resume_session', 'delete_session',
  'send_to_session', 'read_session_screen', 'notify_user', 'set_notify_preference',
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
    if (given && given !== ctx.sessionId) throw new ToolError(msg('mcp.scope.sessionOnly', { sessionId: ctx.sessionId }));
    return ctx.sessionId;
  }
  if (!given) throw new ToolError(msg('mcp.args.sessionIdRequired'));
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

const NO_PROJECT = msg('mcp.scope.noProject');

/** 引数の project_id を枠に照らし、枠の外を指していれば断る。返すのは枠そのものである。 */
function projectScope(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>): string | null | undefined {
  const scope = scopeProjectId(deps, ctx);
  const given = str(args.project_id);
  if (scope !== undefined && given && given !== scope) {
    throw new ToolError(scope === null ? NO_PROJECT : msg('mcp.scope.projectOnly', { projectId: scope }));
  }
  return scope;
}

/** プロジェクトを 1 件に決める道具のための project_id。 */
function projectIdOf(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>): string {
  const scope = projectScope(deps, ctx, args);
  if (scope === null) throw new ToolError(NO_PROJECT);
  const id = scope ?? str(args.project_id);
  if (!id) throw new ToolError(msg('mcp.args.projectIdRequired'));
  return id;
}

/**
 * 会話を最後に動かした PC（run が無ければ作った PC）。here はこの PC か。
 * ほかの PC の会話は、パスやファイルの状態がこの PC と違うことがあるので、検索の結果と一覧に添える。
 */
function deviceBrief(deps: ToolDeps, sessionId: string): { name: string | null; platform: string | null; here: boolean } | null {
  const d = deviceOfSession(deps.db, sessionId);
  return d ? { name: d.name, platform: d.platform, here: d.id === deps.deviceId } : null;
}

/**
 * 再開の手立て。
 * この PC の素の `claude -r` で開ける会話だけ resume_command を返し、開けない会話は null にして resume_hint で案内する（#313）。
 * 開けないのは、他の PC が実行中のロックを持つ会話と、トランスクリプトが他の PC にしか無い会話（remoteOnly）である。
 * 画面が素の再開を閉じて「この PC で再開」に回す条件（ui の sessionActions）と同じ事実を、server の SessionDto から読む。
 * ロックを先に見るのも画面と同じで、ロックがあれば本文の在りかに関わらず、他の PC を停止しない限り再開できない。
 */
function resumeCommandOf(s: SessionDto): string | null {
  // 会話の ID がまだ決まっていない起動中の行（pending:…）は、どのエージェントでも再開できない。
  if (s.providerSessionId.startsWith('pending:')) return null;
  // Codex と opencode は、hangar の包み方（外のターミナルの codex と opencode）が受ける形と同じ。素の端末でも打てる。
  if (s.provider === 'codex') return `codex resume ${s.providerSessionId}`;
  if (s.provider === 'opencode') return `opencode -s ${s.providerSessionId}`;
  return `claude -r ${s.providerSessionId}`;
}

function resumeOf(deps: ToolDeps, s: SessionDto): { resume_command: string | null; resume_hint: string | null } {
  const hint = s.lock ? msg(s.lock.stale ? 'mcp.resumeHint.stale' : 'mcp.resumeHint.running', { device: s.lock.deviceName })
    : s.remoteOnly ? msg('mcp.resumeHint.remote') : null;
  if (!hint) return { resume_command: resumeCommandOf(s), resume_hint: null };
  return { resume_command: null, resume_hint: render((deps.language ?? defaultLanguage)(), hint) };
}

/**
 * セッション 1 件の要点。
 * resume_command だけは Claude の UUID を使う。ほかの項目の id は hangar の sessions.id である。
 */
function sessionBrief(deps: ToolDeps, s: SessionDto) {
  return {
    id: s.id,
    name: s.name,
    project_id: s.projectId,
    cwd: s.cwd,
    live: s.live,
    started_at: s.startedAt,
    last_activity_at: s.lastActivityAt,
    summary: s.summary ? { title: s.summary.title, one_liner: s.summary.oneLiner, state: s.summary.state, source: s.summary.source } : null,
    ...resumeOf(deps, s),
    device: deviceBrief(deps, s.id),
  };
}

/**
 * プロジェクトの TODO を MCP の綴りで返す。セッションは、自分が出した候補が残っているかをここで確かめる。
 * suggestion は、利用者がまだ受け入れていない提案に付く。受け入れられたか見送られたかも、ここで分かる。
 */
function todoBriefs(deps: ToolDeps, projectId: string) {
  return listTodos(deps.db, projectId).map((t) => ({
    id: t.id, text: t.text, done: t.done, session_id: t.sessionId,
    candidate: t.candidate ? { session_id: t.candidate.sessionId, note: t.candidate.note } : null,
    suggestion: t.suggestion ? { note: t.suggestion.note } : null,
  }));
}

type TodoOutcome = ProposeOutcome | 'reopened';

/** propose_done の引数を検査して取り出す。1 件でも崩れていれば全体を断る（どの TODO も書かない）。 */
function proposalsOf(v: unknown): { todoId: string; note: string }[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ToolError(msg('mcp.proposeDone.notArray'));
  return v.map((x) => {
    const o = (typeof x === 'object' && x !== null ? x : {}) as { todo_id?: unknown; note?: unknown };
    if (typeof o.todo_id !== 'string' || typeof o.note !== 'string') throw new ToolError(msg('mcp.proposeDone.badItem'));
    const note = o.note.trim();
    if (!note) throw new ToolError(msg('mcp.proposeDone.noteEmpty'));
    if ([...note].length > CANDIDATE_NOTE_MAX) throw new ToolError(msg('mcp.proposeDone.noteTooLong', { max: CANDIDATE_NOTE_MAX }));
    return { todoId: o.todo_id, note };
  });
}

/**
 * add_todos の引数を検査して取り出す。項目は文字列か { text, note } で、1 件でも崩れていれば全体を断る（どの TODO も書かない）。
 * note は提案の理由で、propose_done の根拠と同じ上限を持つ。空白だけなら null にする（理由は省ける）。
 * 文言が空白だけのときは、addTodo が断る。
 */
function addsOf(v: unknown): { text: string; note: string | null }[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ToolError(msg('mcp.addTodos.notArray'));
  return v.map((x) => {
    if (typeof x === 'string') return { text: x, note: null };
    const o = (typeof x === 'object' && x !== null ? x : {}) as { text?: unknown; note?: unknown };
    if (typeof o.text !== 'string' || (o.note !== undefined && o.note !== null && typeof o.note !== 'string')) throw new ToolError(msg('mcp.addTodos.badItem'));
    const note = typeof o.note === 'string' ? o.note.trim() : '';
    if ([...note].length > CANDIDATE_NOTE_MAX) throw new ToolError(msg('mcp.addTodos.noteTooLong', { max: CANDIDATE_NOTE_MAX }));
    return { text: o.text, note: note || null };
  });
}

function requireSession(deps: ToolDeps, id: string): SessionDto {
  const s = getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId });
  if (!s) throw new ToolError(msg('mcp.error.sessionNotFound', { id }));
  return s;
}

function requireProject(deps: ToolDeps, id: string): ProjectDto {
  const p = getProject(deps.db, deps.deviceId, deps.live(), id);
  if (!p) throw new ToolError(msg('mcp.error.projectNotFound', { id }));
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
  const todos = todoBriefs(deps, id);
  const recent = listSessions(deps.db, deps.live(), { projectId: id, deviceId: deps.deviceId }).slice(0, RECENT_SESSIONS).map((s) => sessionBrief(deps, s));
  const artifacts = listArtifacts(deps.db, { projectId: id })
    .map((a) => ({ id: a.id, url: a.url, title: a.title, icon: a.icon, last_published_at: a.lastPublishedAt, version_count: a.versionCount }));
  return { id: p.id, name: p.name, status: p.status, path: p.path, resolved: p.resolved, last_activity_at: p.lastActivityAt, open_todo_count: p.openTodoCount, todos, recent_sessions: recent, artifacts };
}

/**
 * status、add_todos、toggle_todos、propose_done を受けて書く。プロジェクトのノートは書かない（append_memo はやめた）。
 * 古い指示を覚えた Claude が append_memo を渡したときは、黙って捨てずに、やめたことと書く場所を notice で返す。エラーにはしないので、いっしょに渡したほかの項目は書く。
 * 画面へのイベントは、書いた行から配る層（events/publisher.ts）が配る。道具は hub を持たない。
 */
export function updateProjectTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = projectIdOf(deps, ctx, args);
  const row = deps.db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new ToolError(msg('mcp.error.projectNotFound', { id }));
  // 検証は書き込みの前に全部済ませる。status だけ書いてから propose_done で断ると、呼び出し側は「何も起きなかった」と読む。
  const proposals = proposalsOf(args.propose_done);
  const adds = addsOf(args.add_todos);
  // status を「省略」と「型違いの値」で区別する。str() だけでは数値や null が黙って無視される。
  if (args.status !== undefined) {
    const status = args.status;
    if (typeof status !== 'string' || !STATUSES.includes(status as ProjectStatus)) throw new ToolError(msg('mcp.args.oneOf', { values: STATUSES, field: 'status' }));
    upsertShared(deps.db, 'projects', { ...row, status }, deps.deviceId);
  }
  const toggles = strs(args.toggle_todos) ?? [];
  const results: { todo_id: string; outcome: TodoOutcome }[] = [];
  const todosTouched = adds.length > 0 || toggles.length > 0 || proposals.length > 0;
  if (todosTouched) {
    // 全部成功か全部失敗にする。
    // 途中で失敗して一部の書き込みだけが残ると、呼び出し側は「何も起きなかった」と読むのに DB だけが進む。
    // MCP からは完了にしない。完了にするのは利用者だけなので、未完の反転は根拠なしの候補にする。
    // MCP から足した TODO はすべて提案にする。確定の TODO を足すのは利用者だけである。
    deps.db.transaction(() => {
      for (const t of adds) addTodo(deps.db, deps.deviceId, { projectId: id, text: t.text, sessionId: ctx.sessionId, suggested: true, note: t.note });
      const ofProject = (tid: string) => {
        const cur = deps.db.prepare('select done from todos where id = ? and project_id = ? and deleted_at is null').get(tid, id) as { done: number } | undefined;
        if (!cur) throw new ToolError(msg('mcp.error.todoNotFound', { id: tid }));
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
  }
  const p = getProject(deps.db, deps.deviceId, deps.live(), id)!;
  return {
    project: { id: p.id, name: p.name, status: p.status, open_todo_count: p.openTodoCount },
    todos: todoBriefs(deps, id),
    todo_results: results,
    ...(args.append_memo !== undefined ? { notice: render((deps.language ?? defaultLanguage)(), msg('mcp.updateProject.memoRetired')) } : {}),
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
  return list.slice(0, limit).map((s) => sessionBrief(deps, s));
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
      ...(s ? resumeOf(deps, s) : { resume_command: null, resume_hint: null }),
      device: deviceBrief(deps, h.sessionId),
    };
  });
  return { total: r.total, hits };
}

export function getTranscriptTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  // 読むだけの道具なので、セッション別 URL でも別のセッションを指せる。
  // 画面からコピーした宛先の 1 行（session_id 入り）を渡された Claude が、そのセッションの様子を読むためである。
  const id = str(args.session_id) ?? sessionIdOf(ctx, args);
  requireSession(deps, id);
  const includeTools = bool(args.include_tools) ?? false;
  const page = readEvents(deps.db, id, { fromSeq: num(args.from_seq), limit: num(args.limit) });
  // thinking と meta は外の AI に渡さない。ツールの呼び出しと結果は include_tools のときだけ渡す。
  const keep = (e: TranscriptEvent) =>
    e.kind === 'user' || e.kind === 'assistant' || e.kind === 'system' || e.kind === 'subagent'
    || (includeTools && (e.kind === 'tool_call' || e.kind === 'tool_result'));
  return { session_id: id, events: page.events.filter(keep), total: page.total, next_seq: page.nextSeq };
}

/**
 * 起動を待つ上限。呼ぶ側（Claude Code）は MCP の呼び出しを 60 秒ほどで切るので、それより十分短くとる。
 * opencode の serve の立ち上がりは数秒なので、準備の無い起動はこの内に済み、これまでどおり run を添えて返す。
 */
export const LAUNCH_WAIT_MS = 15_000;

/**
 * 起動（runs.start か resumeWith）を待って結果を返す。
 * 上限を越えても終わらず、起動前の準備（接続先の準備のコマンド、LM Studio のモデル）が走っていれば、待たずに preparing で返す（#545）。
 * 準備は数分から 20 分かかり、そのまま待つと MCP の呼び出しが時間切れになって、結果も失敗の理由も呼んだ側に届かないためである。
 * 準備の進みは画面の札が鍵（prepKey）で拾い、返した後の失敗は reportLateFailure が起動元の会話の知らせにする。
 * 準備が走っていなければ（Claude Code、Codex、準備の前後の段）、1 秒ごとに見直しながら起動を待つ。
 */
function awaitLaunch(deps: ToolDeps, ctx: ToolContext, launch: Promise<LaunchResult>, o: { key: string | undefined; sessionId: () => string | null; name: string; done: (r: LaunchResult) => Record<string, unknown>; detached: (sessionId: string) => void }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let detached = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tryDetach = () => {
      if (settled) return;
      const id = o.sessionId();
      if (!o.key || !id || !deps.runs.prepRunning?.(o.key)) {
        timer = setTimeout(tryDetach, 1_000);
        return;
      }
      detached = true;
      o.detached(id);
      resolve({ session_id: id, preparing: true, url: url(deps, `session/${id}`), note: render(languageOf(deps), msg('mcp.launch.preparing')) });
    };
    timer = setTimeout(tryDetach, deps.launchWaitMs ?? LAUNCH_WAIT_MS);
    launch.then((r) => {
      settled = true;
      if (timer) clearTimeout(timer);
      if (!detached) resolve(o.done(r));
    }, (e: unknown) => {
      settled = true;
      if (timer) clearTimeout(timer);
      if (!detached) reject(e);
      else reportLateFailure(deps, ctx, o.name, e);
    });
  });
}

/**
 * preparing で返した後の起動の失敗を届ける。呼び出しはもう返っているので、ここで知らせないと理由がどこにも残らない。
 * ログ（desktop.log）には必ず書く。起動元の会話が分かれば、その会話の知らせ（未読、OS、スマホ。場面は ask）にする。
 */
function reportLateFailure(deps: ToolDeps, ctx: ToolContext, name: string, e: unknown): void {
  const reason = errorText(languageOf(deps), e);
  console.warn(`[mcp] launch of "${name}" failed after preparing: ${reason}`);
  if (!ctx.sessionId) return;
  const text = clipChars(render(languageOf(deps), msg('mcp.launch.failedLater', { name, reason })), INTENT_MAX);
  try {
    notifyUserTool(deps, ctx, { text, kind: 'ask' });
  } catch (err) {
    console.warn(`[mcp] could not notify the launch failure: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const clipChars = (s: string, max: number): string => {
  const cs = [...s];
  return cs.length > max ? `${cs.slice(0, max - 1).join('')}…` : s;
};

/** 準備の鍵。画面の鍵（ui/src/lib/prepKey.ts）と同じく、shared の isLaunchPrepKey が受ける形にする。 */
const languageOf = (deps: ToolDeps) => (deps.language ?? defaultLanguage)();

const newPrepKey = (): string => `mcp-${randomUUID().replaceAll('-', '')}`;

/** プロジェクトの確かめはその場で投げ、起動（runs.start）は awaitLaunch で待つ。MCP の層は await してから包む。 */
/**
 * agent と mode は UI の起動（POST /api/runs）と同じく runs.start にそのまま渡す。省けば Claude Code で、mode は Claude Code では start が捨てる。
 * worktree と add_dirs も start にそのまま渡す。意味は UI の新規ダイアログと同じ（worktree は claude の --worktree に渡す名前、add_dirs は --add-dir の追加ディレクトリ）。
 * Claude Code だけのもので、Codex と opencode に付けると start が UI と同じ文で断る（黙って捨てない）。
 * 知らない agent と、設定で有効でない agent は、黙って Claude Code にせず、start の前に UI と同じ文で断る。
 */
export function createSessionTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const projectId = projectIdOf(deps, ctx, args);
  const agent = args.agent;
  if (agent !== undefined && !isAgentKind(agent)) throw new ToolError(msg('run.agent.unknown', { agent: String(agent).slice(0, 40) }));
  if (agent !== undefined && agent !== 'claude-code' && !(deps.runs.agentEnabled?.(agent) ?? false)) throw new ToolError(msg('run.agent.disabled', { label: agentEnabledLabel(agent) }));
  const account = launchAccount(deps, ctx, args.account, agent ?? 'claude-code');
  // 準備をするのは ID を後で決める driver（opencode、Codex）だけで、Claude Code には鍵を付けない。
  const key = agent !== undefined && agent !== 'claude-code' ? newPrepKey() : undefined;
  // 呼んだセッションを起動元として残す。引き継ぎと、呼んだセッションが分からない共通の URL では残さない。
  const spawned = (id: string) => { if (ctx.sessionId && !bool(args.handoff)) recordSpawn(deps.db, id, ctx.sessionId, Date.now()); };
  let pending: string | null = null;
  const launch = Promise.resolve(deps.runs.start({
    projectId, name: str(args.name), prompt: str(args.prompt), model: str(args.model),
    effort: str(args.effort), permissionMode: str(args.permission_mode), scratch: bool(args.scratch),
    agent, mode: str(args.mode), ...(account ? { account: account.id } : {}),
    worktree: str(args.worktree), addDirs: strs(args.add_dirs), ...(key ? { prepKey: key } : {}),
  }, { onPending: (id) => { pending = id; } }));
  return awaitLaunch(deps, ctx, launch, {
    key, name: str(args.name) ?? agent ?? '', sessionId: () => pending,
    // 準備の間も、起こした会話を起動元の下に並べる。
    detached: (id) => { spawned(id); },
    done: (r) => {
      spawned(r.sessionId);
      return { run_id: r.run.id, session_id: r.sessionId, tmux_name: r.run.tmuxName, url: url(deps, `session/${r.sessionId}`), ...(account ? { account: account.name } : {}) };
    },
  });
}

/**
 * create_session で起こすアカウント。Claude Code のときだけ選び、ほかのエージェントでは null（アカウントを持たない）。
 * 明示されたら名前か id で引く。知らないものは、使える名前を添えて断る。黙っていまのアカウントで起こすと、頼まれたのと違う枠を使うためである。
 * 省けば、呼んだセッションがこの PC で最後に使ったアカウントを引き継ぐ。別セッションを起こしてと頼んだ会話と同じ枠で続けるのが自然なためである。
 * ヘッダで選んでいるアカウント（store.current）は最後に画面で選んだものにすぎず、呼んだ会話とは関係が無い。
 * ほかの PC の run は見ない（アカウントの id は PC ごとの設定。RunAccounts.accountFor と同じ）。
 * 呼んだセッションが分からない（共通の URL）か、この PC で動かしたことが無いか、そのアカウントが消えていれば、いま選んでいるアカウントにする。
 */
function launchAccount(deps: ToolDeps, ctx: ToolContext, given: unknown, agent: AgentKind): Account | null {
  const name = str(given);
  if (agent !== 'claude-code') {
    if (name !== undefined) throw new ToolError(msg('mcp.createSession.accountClaudeOnly'));
    return null;
  }
  const store = deps.accounts?.store;
  if (!store) return null;
  if (name !== undefined) return accountNamed(store, name);
  const inherited = ctx.sessionId ? accountOfSession(deps.db, ctx.sessionId, deps.deviceId) : null;
  return (inherited ? store.get(inherited) : null) ?? store.current();
}

/** 名前か id でアカウントを引く。知らなければ、使える名前を添えて断る。create_session と resume_session が共有する。 */
function accountNamed(store: Pick<AccountStore, 'list' | 'get'>, name: string): Account {
  const all = store.list();
  const hit = store.get(name) ?? all.find((a) => a.name === name);
  if (!hit) throw new ToolError(msg('mcp.createSession.accountUnknown', { account: name.slice(0, 40), names: all.map((a) => a.name) }));
  return hit;
}

/**
 * 会話の寿命の 3 つの道具は、セッション別 URL でも別のセッションを指せる（session_id が要る）。
 * 自分自身を止める・消すことだけを断る。呼び出しの途中で自分が落ちる、または動いたまま消えるため。
 */
function targetSession(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, selfMessage?: Message): SessionDto {
  const id = str(args.session_id);
  if (!id) throw new ToolError(msg('mcp.args.sessionIdRequired'));
  const s = requireSession(deps, id);
  if (selfMessage && ctx.sessionId === id) throw new ToolError(selfMessage);
  return s;
}

/** UI の停止と同じ runs.kill を通す。この PC の run だけ止められる。 */
export function stopSessionTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  if (!deps.runs.aliveRun || !deps.runs.kill) throw new ToolError(msg('mcp.error.unknownTool', { name: 'stop_session' }));
  const s = targetSession(deps, ctx, args, msg('mcp.stopSession.self'));
  const run = deps.runs.aliveRun(s.id);
  if (!run) throw new ToolError(msg('mcp.stopSession.notRunning'));
  if (run.deviceId !== deps.deviceId) throw new ToolError(msg('mcp.stopSession.otherDevice', { device: deviceBrief(deps, s.id)?.name ?? run.deviceId }));
  deps.runs.kill(run.id);
  return { ok: true, session_id: s.id, run_id: run.id };
}

/**
 * UI の再開と同じ runs.resumeWith を通す。3 つのエージェントとも、再開の道筋は resumeWith の中で分かれる。
 * account は Claude Code の会話のときだけ受ける。省けば resumeWith が最後に使ったアカウント（RunAccounts.lastUsed）で再開する。
 */
export function resumeSessionTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  if (!deps.runs.aliveRun || !deps.runs.resumeWith) throw new ToolError(msg('mcp.error.unknownTool', { name: 'resume_session' }));
  const s = targetSession(deps, ctx, args);
  if (deps.runs.aliveRun(s.id)) throw new ToolError(msg('mcp.resumeSession.running'));
  const given = str(args.account);
  let account: Account | null = null;
  if (s.provider !== 'claude-code') {
    if (given !== undefined) throw new ToolError(msg('mcp.createSession.accountClaudeOnly'));
  } else if (deps.accounts?.store) {
    const store = deps.accounts.store;
    if (given !== undefined) account = accountNamed(store, given);
    else {
      const last = accountOfSession(deps.db, s.id, deps.deviceId);
      account = (last ? store.get(last) ?? store.get(PRIMARY_ACCOUNT_ID) : null) ?? store.current();
    }
  }
  // 再開でも opencode は接続先の準備を走らせる。create_session と同じく、長い準備は待たずに返す。
  const key = s.provider !== 'claude-code' ? newPrepKey() : undefined;
  const launch = Promise.resolve(deps.runs.resumeWith(s.id, { ...(given !== undefined && account ? { account: account.id } : {}), ...(key ? { prepKey: key } : {}) }));
  return awaitLaunch(deps, ctx, launch, {
    key, name: sessionTitle(s), sessionId: () => s.id, detached: () => undefined,
    done: (r) => ({ run_id: r.run.id, session_id: r.sessionId, tmux_name: r.run.tmuxName, url: url(deps, `session/${r.sessionId}`), ...(account ? { account: account.name } : {}) }),
  });
}

/**
 * UI の削除と同じ trash.deleteSession を通す。どのセッションも、毎回 confirmed: true（利用者が会話の中で承認した）でなければ消さない。
 * 動いている会話の断り（409）は、deleteSession の文をそのまま返す。
 */
export function deleteSessionTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const trash = deps.trash;
  if (!trash) throw new ToolError(msg('mcp.error.unknownTool', { name: 'delete_session' }));
  const s = targetSession(deps, ctx, args, msg('mcp.deleteSession.self'));
  if (args.confirmed !== true) throw new ToolError(msg('mcp.deleteSession.confirm', { title: sessionTitle(s) }));
  return trash.deleteSession(s.id).then(() => ({ ok: true, session_id: s.id }));
}

/** 承認を求めるときに利用者へ見せる題名。名前、AI の題、最初の発言の順に引く。 */
function sessionTitle(s: SessionDto): string {
  return (s.name ?? s.summary?.title ?? s.aiTitle ?? s.firstPrompt ?? s.id).replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function setSessionSummaryTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const title = str(args.title);
  const oneLiner = str(args.one_liner);
  const body = str(args.body);
  const state = str(args.state);
  if (!title || !oneLiner || !body || !state) throw new ToolError(msg('mcp.summary.fieldsRequired'));
  if (!STATES.includes(state as SummaryState)) throw new ToolError(msg('mcp.args.oneOf', { values: STATES, field: 'state' }));
  const turns = (deps.db.prepare('select turns from session_stats where session_id = ?').get(id) as { turns: number } | undefined)?.turns ?? 0;
  upsertShared(deps.db, 'session_summaries', {
    session_id: id, title, one_liner: oneLiner, body, state,
    next_steps: JSON.stringify(strs(args.next_steps) ?? []),
    source: 'in_session', source_id: null, source_model: null, based_on_turns: turns,
  }, deps.deviceId, 'session_id');
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
  if (text.length === 0 || [...text].length > INTENT_MAX) throw new ToolError(msg('mcp.intent.badLength', { max: INTENT_MAX }));
  const it = addIntent(deps.db, id, text, now);
  noteIntent(id);
  return { ok: true, session_id: id, at: it.at };
}

/**
 * 利用者に見てほしい出力を出したことを知らせる。そのセッションの未読が 1 つ増え、画面へ配り、購読（OS の通知、スマホ）へ知らせる。
 * 長さの数え方と上限は set_turn_intent と同じ。道具の名前に state と status を入れない（sessions.test.ts の決まり）。
 * Done、Archived、Paused にしたセッションは、付けた後に休みから動き出すまで何も出さない（shared の isQuietStatus、sessions/wake.ts）。
 * 付けたターンの終わりの知らせで、サイドバーから消えた会話に未読が残り、通知が鳴るのを防ぐ（2026-10-31）。断らずに sent を空で返す。
 */
export function notifyUserTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  const id = sessionIdOf(ctx, args);
  const session = requireSession(deps, id);
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (text.length === 0 || [...text].length > INTENT_MAX) throw new ToolError(msg('mcp.intent.badLength', { max: INTENT_MAX }));
  // 場面。省くと done。
  if (args.kind !== undefined && !isNotifyKind(args.kind)) throw new ToolError(msg('mcp.notify.badKind'));
  const kind: NotifyKind = args.kind === undefined ? 'done' : (args.kind as NotifyKind);
  const rules = notifyRulesOf(deps.settings?.() ?? {});
  // 出し先。to が無ければ、決まりで kind を含む先。to があれば to の先（決まりで空の配列の先、つまりオフは勝つ）。
  let sent: NotifyTarget[];
  if (args.to !== undefined) {
    const to = args.to;
    if (!Array.isArray(to) || to.length === 0 || !to.every((x): x is NotifyTarget => NOTIFY_TARGETS.includes(x as NotifyTarget))) throw new ToolError(msg('mcp.notify.badTo'));
    sent = NOTIFY_TARGETS.filter((x) => to.includes(x) && rules[x].length > 0);
  } else {
    sent = NOTIFY_TARGETS.filter((x) => rules[x].includes(kind));
  }
  if (isQuietStatus(session.state?.status) && !session.woke) sent = [];
  let unread = session.unread?.count ?? 0;
  if (sent.length > 0) {
    if (sent.includes('unread')) {
      unread = addUnread(deps.db, id, text, now);
      touchRow(deps.db, 'sessions', id);
    }
    noteUnread(id, text, unread, sent);
  }
  return { ok: true, session_id: id, at: now, unread, sent };
}

/**
 * 知らせ方の決まり（設定の notifyPreference）を保存する。利用者の言葉をエージェントが出し先ごとの場面に直して渡す。
 * text と unread・os・phone は必須で、欠け、形の違い、kind でない要素は断る（空の配列はオフとして通す）。
 * whileFocused と merge は省けて、省けば今の値を保つ。返すのは保存した決まり（notifyRulesOf を通した形）。
 * 保存は設定の PATCH と同じ道（saveNotifyPreference）で、画面へも配る。
 */
export function setNotifyPreferenceTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  if (!deps.saveNotifyPreference) throw new ToolError(msg('mcp.error.unknownTool', { name: 'set_notify_preference' }));
  if (ctx.sessionId !== null) sessionIdOf(ctx, args);
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (text.length === 0) throw new ToolError(msg('mcp.notifyPref.badField', { field: 'text' }));
  const lists: Record<'unread' | 'os' | 'phone', NotifyKind[]> = { unread: [], os: [], phone: [] };
  for (const f of ['unread', 'os', 'phone'] as const) {
    const v = args[f];
    if (!Array.isArray(v) || !v.every(isNotifyKind)) throw new ToolError(msg('mcp.notifyPref.badField', { field: f }));
    lists[f] = [...new Set(v)];
  }
  for (const f of ['whileFocused', 'merge'] as const) {
    if (args[f] !== undefined && typeof args[f] !== 'boolean') throw new ToolError(msg('mcp.notifyPref.badField', { field: f }));
  }
  const now = notifyRulesOf(deps.settings?.() ?? {});
  const saved: NotifyPreference = { text, ...lists, whileFocused: (args.whileFocused as boolean | undefined) ?? now.whileFocused, merge: (args.merge as boolean | undefined) ?? now.merge };
  deps.saveNotifyPreference(saved);
  return notifyRulesOf({ notifyPreference: saved });
}

/**
 * このセッションの状態（Done か Paused）を提案する。
 * confirmed が true のときだけ状態にする。利用者が会話の中で選んだという申告で、hangar はそれを確かめられない。
 * その余地は利用者の決定（2026-10-01）として受け入れ、代わりに set_by を conversation にして後から分かるようにする。
 * 却下された提案は、そのセッションに新しい発言があるまで受け付けない（rejected_before）。
 * note と return_on の中身の検査は states.ts の validateStateInput に任せる。ここでは型と status だけを見て、StateInputError を ToolError に変える。
 * 検査は confirmed の有無によらず、already_set を比べる前に済ませる。どれかに落ちたら何も書かず、何も配らない。
 * 戻る時点は return_on（日付）と、任意の return_time（HH:MM）で受ける。どちらも手元の暦と時計で読み、返す状態にはオフセット付きの returnAt を添えて、どのゾーンで読んだかを残す。
 * 過去の時点はここで断る。states.ts では断らない（時刻を過ぎた提案を画面で確定でき、同期で届いた行も弾かないようにするため）。
 */
/** 状態と提案に、戻る時点をオフセット付きで添える（2026-10-05T13:30+09:00）。時刻が無ければ null。 */
function withReturnAt(state: SessionStateDto) {
  const at = (o: { returnOn: string | null; returnTime: string | null }) => (o.returnOn && o.returnTime ? returnAtIso(o.returnOn, o.returnTime) : null);
  return { ...state, returnAt: at(state), candidate: state.candidate ? { ...state.candidate, returnAt: at(state.candidate) } : null };
}

/**
 * 戻る時点が過去なら断る。時刻があれば時点で、無ければ日で比べる（今日の日付だけは「その日のうち」なので通す）。
 * 文には渡された時点と、比べた今をオフセット付きで入れる。呼び手のゾーンの読み違いに、文から気づけるようにする。
 */
function rejectPastReturn(returnOn: string | null, returnTime: string | null, now: number): void {
  if (returnOn === null) return;
  const today = localDate(now);
  const nowText = `${today} ${localTime(now)} ${returnAtIso(today, localTime(now))!.slice(-6)}`;
  if (returnTime !== null) {
    if (returnAtMs(returnOn, returnTime) <= now) throw new ToolError(msg('mcp.sessionStatus.pastReturnAt', { returnOn, returnTime, now: nowText }));
  } else if (returnOn < today) {
    throw new ToolError(msg('mcp.sessionStatus.pastReturnOn', { returnOn, now: nowText }));
  }
}

export function proposeSessionStatusTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const status = args.status;
  if (status !== 'done' && status !== 'paused') throw new ToolError(msg('mcp.sessionStatus.statusInvalid'));
  if (args.note !== undefined && typeof args.note !== 'string') throw new ToolError(msg('common.field.mustBeString', { field: 'note' }));
  if (args.return_on !== undefined && typeof args.return_on !== 'string') throw new ToolError(msg('mcp.sessionStatus.returnOnMustBeString'));
  if (args.return_time !== undefined && typeof args.return_time !== 'string') throw new ToolError(msg('mcp.sessionStatus.returnTimeMustBeString'));
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new ToolError(msg('common.field.mustBeBoolean', { field: 'confirmed' }));
  try {
    const given = args.note ?? '';
    const { returnOn, returnTime } = validateStateInput(status, { note: given, returnOn: args.return_on, returnTime: args.return_time, requireNote: true });
    rejectPastReturn(returnOn, returnTime, now);
    let r: { outcome: ProposeStateOutcome; state: SessionStateDto };
    if (args.confirmed === true) {
      const cur = getSessionState(deps.db, id);
      r = cur && cur.status === status && cur.returnOn === returnOn && cur.returnTime === returnTime
        ? { outcome: 'already_set', state: cur }
        : { outcome: 'set', state: setSessionState(deps.db, deps.deviceId, id, { status, note: given, returnOn, returnTime, setBy: 'conversation', requireNote: true, now }) };
    } else {
      r = proposeSessionState(deps.db, deps.deviceId, id, { status, note: given, returnOn, returnTime, source: 'in_session', now });
    }
    return { outcome: r.outcome, state: withReturnAt(r.state) };
  } catch (e) {
    if (e instanceof StateInputError) throw new ToolError(e.text ?? e.message);
    throw e;
  }
}

/** UsageDto を MCP の応答の形にする。まだ届いていない窓は null になる。 */
function usageBody(u: UsageDto) {
  const w = (x: { usedPercent: number; resetsAt: number | null } | null) => (x ? { used_percentage: x.usedPercent, resets_at: x.resetsAt } : null);
  return { five_hour: w(u.fiveHour), seven_day: w(u.sevenDay), updated_at: u.updatedAt };
}

/**
 * statusline から届いた最新の使用率。上の 3 項目は最初のアカウントの値のまま、accounts にアカウントごとの値を並べる。
 * メールアドレスなど認証の情報は入れない。
 */
export function getUsageTool(deps: ToolDeps) {
  const top = usageBody(deps.usage());
  if (!deps.accounts) return top;
  const currentId = deps.accounts.store.current().id;
  return { ...top, accounts: deps.accounts.store.list().map((a) => ({ name: a.name, current: a.id === currentId, ...usageBody(deps.accounts!.usage.of(a.id)) })) };
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

/** 作者への問い合わせの口。共通 URL でもセッション別 URL でも、枠に関わりなく使える（プロジェクトもセッションも指さない）。 */
function reportOf(deps: ToolDeps, name: string): NonNullable<ToolDeps['report']> {
  if (!deps.report) throw new ToolError(msg('mcp.error.unknownTool', { name }));
  return deps.report;
}

/**
 * 名前で振り分ける。MCP の層はこれを content に包むだけにする。
 * 問い合わせの 2 つと create_session は待つので Promise を返す。MCP の層は await してから包む。
 */
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
    case 'notify_user': return notifyUserTool(deps, ctx, args);
    case 'set_notify_preference': return setNotifyPreferenceTool(deps, ctx, args);
    case 'get_usage': return getUsageTool(deps);
    case 'open_in_hangar': return openInHangarTool(deps, ctx, args);
    case 'propose_session_status': return proposeSessionStatusTool(deps, ctx, args);
    case 'stop_session': return stopSessionTool(deps, ctx, args);
    case 'resume_session': return resumeSessionTool(deps, ctx, args);
    case 'delete_session': return deleteSessionTool(deps, ctx, args);
    case 'draft_issue_report': return reportOf(deps, name).draft(args);
    case 'submit_issue_report': return reportOf(deps, name).submit(args);
    case 'send_to_session': return sendToSessionTool(deps, ctx, args);
    case 'read_session_screen': return readSessionScreenTool(deps, ctx, args);
    default: throw new ToolError(msg('mcp.error.unknownTool', { name }));
  }
}
