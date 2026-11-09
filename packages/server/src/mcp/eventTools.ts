import { EVENT_DRAFTS_MAX, PR_CLAIM_DRAFTS_MAX, type EventAction, type EventSource } from '@agent-hangar/shared';
import { claimPr, countDrafts, countSessionDraftClaims, createBinding, hasClaim } from '../event/store.ts';
import { parseAllowAuthors, parsePassBody, parsePrompt, parseSource, REPO_RE } from '../event/validate.ts';
import { msg } from '../i18n/message.ts';
import { targetArg } from './scheduleTools.ts';
import { requireSession, sessionIdOf, ToolError, type ToolContext, type ToolDeps } from './tools.ts';

/**
 * 外のできごとの MCP の道具（#563）。
 * どちらも下書きを置くだけで、承認するまで何も動かない。
 * 承認は画面の道（http/routes/events.ts の PATCH）だけが受ける。
 * 承認のときに初めて、受け箱と GitHub の webhook ができる。
 * 応答に、webhook の URL、秘密、受け箱の ID と鍵は載せない（この層はそれらを持つ部品に触らない）。
 */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * この会話が PR を持つ印を、下書きとして置く。
 * 承認済み（active）の印は下書きに戻さない。
 */
export function claimPrTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const sessionId = sessionIdOf(ctx, args);
  requireSession(deps, sessionId);
  const repo = str(args.repo);
  const pr = args.pr;
  if (!repo || !REPO_RE.test(repo) || typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr <= 0) throw new ToolError(msg('schedules.event.error.invalid'));
  // 下書きは会話ごとに上限がある。
  // すでにある印の出し直しは数えない。
  if (!hasClaim(deps.db, { sessionId, repo, pr }) && countSessionDraftClaims(deps.db, sessionId) >= PR_CLAIM_DRAFTS_MAX) throw new ToolError(msg('mcp.event.tooManyClaims', { max: PR_CLAIM_DRAFTS_MAX }));
  claimPr(deps.db, { sessionId, repo, pr, state: 'draft' });
  const row = deps.db.prepare('select state from session_prs where session_id = ? and repo = ? and pr = ?').get(sessionId, repo, pr) as { state: 'draft' | 'active' };
  return { repo, pr, state: row.state };
}

/**
 * 動きを組む。
 * 起こす（wake）は、Paused の提案に添える wake_on からだけ作る。
 */
function actionOf(deps: ToolDeps, ctx: ToolContext, v: unknown, source: EventSource): EventAction {
  const o = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const { kind, ...rest } = o;
  if (kind === 'wake') throw new ToolError(msg('mcp.event.noWakeDraft'));
  if (kind === 'send') {
    if (!str(rest.session_id)) throw new ToolError(msg('mcp.args.sessionIdRequired'));
    const { target } = targetArg(deps, ctx, { session_id: rest.session_id });
    if (target.kind !== 'session') throw new ToolError(msg('schedules.event.error.invalid'));
    return { kind: 'send', sessionId: target.sessionId };
  }
  if (kind === 'send_pr_owner') {
    if (source.kind !== 'github') throw new ToolError(msg('schedules.event.error.invalid'));
    return { kind: 'send_pr_owner' };
  }
  if (kind === 'new') {
    // 会話を指す項目は渡せない。
    // 新しい会話の項目だけを、予定と同じ名前で受ける。
    const { session_id: _ignored, ...launch } = rest;
    const { target } = targetArg(deps, ctx, launch);
    if (target.kind !== 'new') throw new ToolError(msg('schedules.event.error.invalid'));
    return target;
  }
  throw new ToolError(msg('schedules.event.error.invalid'));
}

/**
 * 結び付けを下書きとして置く。
 * state は必ず draft で、受け箱の欄は空のまま。
 * 返すのは、画面で見分けるための id と、利用者が決めた中身だけである。
 */
export function draftEventBindingTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  const source = parseSource(args.source);
  // 下書きは全部で EVENT_DRAFTS_MAX 件まで。
  // 利用者が作る結び付けの上限（50 件）には数えない。
  if (countDrafts(deps.db) >= EVENT_DRAFTS_MAX) throw new ToolError(msg('mcp.event.tooManyDrafts', { max: EVENT_DRAFTS_MAX }));
  const action = actionOf(deps, ctx, args.action, source);
  const binding = createBinding(deps.db, {
    inboxId: '', inboxPublicKey: '', inboxPrivateKey: '',
    source, action, prompt: parsePrompt(args.prompt), passBody: parsePassBody(args.pass_body), allowAuthors: parseAllowAuthors(args.allow_authors),
    state: 'draft', fromSessionId: ctx.sessionId,
  }, now);
  const { id, state, source: s, action: a, prompt, passBody, allowAuthors } = binding;
  return { binding: { id, state, source: s, action: a, prompt, passBody, allowAuthors } };
}
