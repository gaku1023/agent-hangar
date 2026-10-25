import { clampText, type LiveSessionDto, type MobileWaiting } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { readEvents } from '../transcript/read.ts';

// 入力待ちの中身（何を待っているかの 1 行）。スマホの受信箱（mobile/feed.ts）が、エージェントを問わず呼ぶ。
// どのエージェントも、待ちを境界の同じ形に入れてくる。
// 状態の面（LiveSource）の行の waitingFor と permission、許可と質問の面（AskSource）から hangar の書き手（sessions/questionHook.ts）が書く session_activity の問いである。
// Claude は hook から、opencode は serve の出来事の流れ（permission.asked、form.created）から書く（provider/opencode/live.ts、sessions/agentAsks.ts）。
// opencode の許可の tool は opencode の道具の名前（shell など）で、description は無い。form の問いは AskUserQuestion として書かれる。

/**
 * 入力待ちの中身。待っていなければ null。問いの文は session_activity、許可の中身は登録の permission から取る。
 * 画面の札（ui の presenters/live.ts の staleWait、shared の stopReasonOf）と同じく、今の待ちに合わない中身は出さない。
 * 許可の待ちでは、前の AskUserQuestion の問いが残っていても許可の中身を出す。
 * 問いの待ちでは、AskUserQuestion でない許可の中身を問いとして出さない。
 * Claude Code の版によっては AskUserQuestion の待ちに permission を書くので、許可の中身が AskUserQuestion なら問いとして扱う。
 * 許可でない待ち（other）で、最後の呼び出しにもう答えが出ていれば、その問いは済んだものなので出さない（staleWait）。
 */
export function waitingOf(db: Db, sessionId: string, live: LiveSessionDto): MobileWaiting | null {
  if (live.status !== 'waiting') return null;
  const act = db.prepare('select tool, tool_id, question from session_activity where session_id = ?').get(sessionId) as { tool: string; tool_id: string; question: string | null } | undefined;
  const asked = act?.tool === 'AskUserQuestion' && act.question ? act.question : null;
  const question = asked !== null && live.waitingFor === 'other' && answered(db, sessionId, act!.tool_id) ? null : asked;
  const p = live.permission;
  const asking = live.waitingFor === 'question' || p?.tool === 'AskUserQuestion';
  if (asking) return { kind: 'question', text: clampText(question) ?? '' };
  if (p) {
    const body = p.input.trim() || (p.description ?? '').trim();
    return { kind: live.waitingFor ?? 'permission', text: clampText(body ? `${p.tool}: ${body}` : p.tool) ?? '' };
  }
  if (question) return { kind: 'question', text: clampText(question) ?? '' };
  return { kind: live.waitingFor ?? 'other', text: '' };
}

/** 答えを探す主線の末尾の長さ。問いを待つ間は後ろに出来事が続かないので、答えがあればこの中にある。 */
const ANSWER_TAIL = 40;

/**
 * 呼び出し toolId に答え（tool_result）が出ているか。画面の札（presenters/live.ts の staleWait）が本文の出来事で見るのと同じものを、主線の末尾だけ読んで見る。
 * 読むのは索引で位置を引いた末尾の数件で、許可でない待ちの会話のときだけである。本文が無い、読めないときは、答えは無いものとする。
 */
function answered(db: Db, sessionId: string, toolId: string): boolean {
  try {
    return readEvents(db, sessionId, { latest: true, limit: ANSWER_TAIL }).events.some((e) => e.kind === 'tool_result' && e.toolId === toolId);
  } catch {
    return false;
  }
}
