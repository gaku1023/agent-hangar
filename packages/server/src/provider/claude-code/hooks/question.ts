import { firstQuestion } from '../transcript/activity.ts';
import { toolSummary } from '../transcript/normalize.ts';

/**
 * hangar が起こした claude の hook から届く、AskUserQuestion の出入り。
 *
 * Windows の実機（Claude Code 2.1.296）で、AskUserQuestion だけを呼んだ回に、入力待ちの間はトランスクリプトから問いの文が取れなかった。
 * そのときホームの要対応と通知は「入力待ちです」になる。
 * hook は呼び出しの入力をそのまま渡すので、トランスクリプトを待たずに問いの文が取れる。
 * asked は PreToolUse（問いを出す直前）、answered は PostToolUse と PostToolUseFailure（答えた後と、取り消した後）である。
 */
export type QuestionHook =
  | { kind: 'asked'; providerSessionId: string; toolId: string; summary: string; question: string | null }
  | { kind: 'answered'; providerSessionId: string; toolId: string };

const TOOL = 'AskUserQuestion';

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * hook の入力（JSON を読んだもの）から、AskUserQuestion の出入りを読む。
 * ほかの道具と出来事、サブエージェントの呼び出し（agent_id がある）、欠けた値は null にする。
 * 入口に届く値は claude が書いたもので、形を信じない。
 */
export function readQuestionHook(body: unknown): QuestionHook | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.tool_name !== TOOL || b.agent_id !== undefined) return null;
  const providerSessionId = text(b.session_id);
  const toolId = text(b.tool_use_id);
  if (providerSessionId === null || toolId === null) return null;
  if (b.hook_event_name === 'PreToolUse') return { kind: 'asked', providerSessionId, toolId, summary: toolSummary(TOOL, b.tool_input), question: firstQuestion(b.tool_input) };
  if (b.hook_event_name === 'PostToolUse' || b.hook_event_name === 'PostToolUseFailure') return { kind: 'answered', providerSessionId, toolId };
  return null;
}
