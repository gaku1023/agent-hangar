import type { AgentAsk, AgentKind } from '../agent/types.ts';
import type { Db } from '../db/open.ts';
import { applyPermissionHook, type PermissionAsks } from './permissionAsks.ts';
import { applyQuestionHook } from './questionHook.ts';

/**
 * エージェントが流してきた許可と問い（agent/types.ts の AskSource.subscribe、いまは opencode）を書く。
 * hook の受け口（mcp/app.ts）と同じ書き手を使う。問いは session_activity へ（sessions/questionHook.ts）、許可は預かりへ（sessions/permissionAsks.ts）。
 * hook と違って URL に hangar の会話の ID が無いので、エージェントの種類と、そのエージェントの会話の ID から引く。
 * 行が無い会話（消した会話、ほかのエージェントの会話）には書かない。書いたら true。
 */
export function routeAgentAsk(db: Db, agent: AgentKind, ask: AgentAsk, permissionAsks: Pick<PermissionAsks, 'put'>, now: number): boolean {
  const row = db.prepare('select id from sessions where provider = ? and provider_session_id = ? and deleted_at is null').get(agent, ask.providerSessionId) as { id: string } | undefined;
  if (!row) return false;
  if (ask.kind === 'question') return applyQuestionHook(db, row.id, ask.hook, now);
  return applyPermissionHook(db, row.id, { providerSessionId: ask.providerSessionId, ask: ask.ask }, permissionAsks, now);
}
