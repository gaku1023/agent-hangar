import type { PermissionAskDto } from '@agent-hangar/shared';
import type { AgentAsk, AskSource } from '../../agent/types.ts';
import type { QuestionHook } from '../claude-code/hooks/question.ts';
import type { OpencodeForm, OpencodePermissionRequest } from './client.ts';

/**
 * opencode の許可と質問の面（docs/design.md「opencode の状態」）。
 * opencode は hook を持たないので、serve の出来事の流れ（`permission.asked`、`form.created`）と取り直しの答えから、状態の面（live.ts）が拾って流す。
 * 書くのは hangar の側（sessions/agentAsks.ts から sessions/questionHook.ts、sessions/permissionAsks.ts）で、ここは形を直すだけにする。
 */

/**
 * 許可の確認を、画面の札の形にする。
 * tool は opencode の道具の名前（2.x の Bash は `shell`）、input は許すかを聞いている中身（shell なら命令の全文）を改行でつないだもの。
 * opencode の shell には説明の引数が無いので、description は無い。
 */
export function permissionAskOf(p: OpencodePermissionRequest): PermissionAskDto {
  return { tool: p.action, input: p.resources.join('\n'), description: null };
}

/** form の呼び出しの ID。question の道具の form は道具の呼び出しの ID を持つので、本文の呼び出しと同じ ID になる。無ければ form の ID。 */
export function formToolIdOf(f: OpencodeForm): string {
  return f.metadata?.tool?.id ?? f.id;
}

/** form の最初の問いの文。項目の説明（description）が問いの文で、無ければ見出し、それも無ければ form の題名にする。 */
export function formQuestionOf(f: OpencodeForm): string | null {
  const first = f.fields[0];
  return first?.description ?? first?.title ?? (f.title || null);
}

/** form が出たことを、Claude の AskUserQuestion の hook と同じ形にする（sessions/questionHook.ts がそのまま書ける）。 */
export function questionAskedOf(providerSessionId: string, f: OpencodeForm): QuestionHook {
  const question = formQuestionOf(f);
  return { kind: 'asked', providerSessionId, toolId: formToolIdOf(f), summary: question ?? '', question };
}

/** 許可と問いを流してくる口。状態の面（live.ts の OpencodeLive）が持つ。 */
export type AskFeed = { onAsk(cb: (a: AgentAsk) => void): () => void };

/** opencode の許可と質問の面。hook は読まない（parseHook を持たない）。 */
export function opencodeAsks(feed: AskFeed): AskSource {
  return { subscribe: (cb) => feed.onAsk(cb) };
}
