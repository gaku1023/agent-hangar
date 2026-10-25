import type { AgentAsk, AskSource } from '../../../agent/types.ts';
import { readPermissionHook } from './permission.ts';
import { readQuestionHook } from './question.ts';

/**
 * hook の入力（JSON を読んだもの）から、許可と質問を読む。
 * 1 つの入力は AskUserQuestion の出入りか、許可の確認（PermissionRequest）のどちらかで、両方にはならない。
 * どちらでもない出来事と、形の合わない入力は空にする。
 */
export function parseClaudeHook(body: unknown): AgentAsk[] {
  const asks: AgentAsk[] = [];
  const question = readQuestionHook(body);
  if (question) asks.push({ kind: 'question', providerSessionId: question.providerSessionId, hook: question });
  const permission = readPermissionHook(body);
  if (permission) asks.push({ kind: 'permission', providerSessionId: permission.providerSessionId, ask: permission.ask });
  return asks;
}

/**
 * Claude の許可と質問の面。
 * hangar が起こした claude の hook（launch/hookSettings.ts）が、台本を通して hangar の受け口（mcp/app.ts）へ入力を送ってくる。
 * 受け口はこの parseHook で読み、書くのは hangar の側（sessions/questionHook.ts、sessions/permissionAsks.ts）である。
 * 流してくる口（subscribe）は持たない。
 */
export const claudeAsks: AskSource = { parseHook: parseClaudeHook };
