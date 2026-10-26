import type { PermissionAskDto } from '@agent-hangar/shared';
import type { AgentAsk, AskSource } from '../../agent/types.ts';
import type { QuestionHook } from '../claude-code/hooks/question.ts';
import type { CodexServerRequest } from './appServer.ts';

/**
 * Codex の許可と質問の面（docs/design.md「Codex の状態と許可」）。
 * 承認と質問は、app-server が購読した接続へ送ってくるサーバからの要求（`item/commandExecution/requestApproval` など）である。
 * hangar の接続は答えない（答えは TUI で行う）。ここは要求の中身を、画面の札と agent/waiting.ts の語彙の形に直すだけにする。
 * 許可の道具の名前は Claude に合わせる（命令は `Bash`、ファイルの変更は `Edit`、権限の追加は `Permissions`）。質問は AskUserQuestion の hook と同じ形で流す。
 */

export const CODEX_APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
] as const;

/** 待っている要求 1 つ。key は JSON-RPC の要求の ID。 */
export type CodexPending =
  | { key: string; threadId: string; kind: 'permission'; ask: PermissionAskDto }
  | { key: string; threadId: string; kind: 'question'; toolId: string; question: string | null };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** 権限の追加の中身を、行ごとの文にする（network、書く場所、読む場所）。分からなければ cwd。 */
export function permissionsText(params: Record<string, unknown>): string {
  const p = rec(params.permissions);
  const lines: string[] = [];
  if (rec(p.network).enabled === true) lines.push('network');
  const fs = rec(p.fileSystem);
  const write = strs(fs.write);
  const read = strs(fs.read);
  if (write.length) lines.push(`write ${write.join(', ')}`);
  if (read.length) lines.push(`read ${read.join(', ')}`);
  return lines.length ? lines.join('\n') : (str(params.cwd) ?? '');
}

/** サーバからの要求を、待ちの 1 件にする。承認と質問でない要求、threadId の無い値は null。入口の値は形を信じない。 */
export function codexPendingOf(r: CodexServerRequest): CodexPending | null {
  const p = rec(r.params);
  const threadId = str(p.threadId);
  if (threadId === null) return null;
  const key = String(r.id);
  switch (r.method) {
    case 'item/commandExecution/requestApproval':
      return { key, threadId, kind: 'permission', ask: { tool: 'Bash', input: str(p.command) ?? '', description: str(p.reason) } };
    case 'item/fileChange/requestApproval':
      return { key, threadId, kind: 'permission', ask: { tool: 'Edit', input: str(p.grantRoot) ?? '', description: str(p.reason) } };
    case 'item/permissions/requestApproval':
      return { key, threadId, kind: 'permission', ask: { tool: 'Permissions', input: permissionsText(p), description: str(p.reason) } };
    case 'item/tool/requestUserInput': {
      const q = rec(Array.isArray(p.questions) ? p.questions[0] : null);
      return { key, threadId, kind: 'question', toolId: str(p.itemId) ?? key, question: str(q.question) ?? str(q.header) };
    }
    case 'mcpServer/elicitation/request':
      return { key, threadId, kind: 'question', toolId: `elicitation-${key}`, question: str(p.message) ?? str(p.serverName) };
    default:
      return null;
  }
}

/** 質問が出たことを、Claude の AskUserQuestion の hook と同じ形にする（sessions/questionHook.ts がそのまま書ける）。 */
export function codexQuestionAsked(providerSessionId: string, q: Extract<CodexPending, { kind: 'question' }>): QuestionHook {
  return { kind: 'asked', providerSessionId, toolId: q.toolId, summary: q.question ?? '', question: q.question };
}

/** 許可と質問を流してくる口。状態の面（live.ts の CodexLive）が持つ。 */
export type CodexAskFeed = { onAsk(cb: (a: AgentAsk) => void): () => void };

/** Codex の許可と質問の面。hook は読まない（parseHook を持たない）。 */
export function codexAsks(feed: CodexAskFeed): AskSource {
  return { subscribe: (cb) => feed.onAsk(cb) };
}
