import { clampText, DEFAULT_LANGUAGE, permissionToolLabel, translator, type Language, type LiveSessionDto, type MobileWaiting, type TranscriptEvent } from '@agent-hangar/shared';
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
 * 道具の名前は利用者に見せる形にする（FolderTrust は「ディレクトリの信頼」）。言語は呼び手が渡し、無ければ既定（日本語）。
 * 許可でない待ち（other）で、最後の呼び出しにもう答えが出ていれば、その問いは済んだものなので出さない（staleWait）。
 */
export function waitingOf(db: Db, sessionId: string, live: LiveSessionDto, language: Language = DEFAULT_LANGUAGE): MobileWaiting | null {
  if (live.status !== 'waiting') return null;
  const act = db.prepare('select tool, tool_id, question from session_activity where session_id = ?').get(sessionId) as { tool: string; tool_id: string; question: string | null } | undefined;
  const asked = act?.tool === 'AskUserQuestion' && act.question ? act.question : null;
  const question = asked !== null && live.waitingFor === 'other' && answered(db, sessionId, act!.tool_id) ? null : asked;
  const p = live.permission;
  const asking = live.waitingFor === 'question' || p?.tool === 'AskUserQuestion';
  if (asking) return { kind: 'question', text: clampText(question) ?? '' };
  if (p) {
    const tool = permissionToolLabel(translator(language), p.tool);
    const body = p.input.trim() || (p.description ?? '').trim();
    return { kind: live.waitingFor ?? 'permission', text: clampText(body ? `${tool}: ${body}` : tool) ?? '' };
  }
  if (question) return { kind: 'question', text: clampText(question) ?? '' };
  return { kind: live.waitingFor ?? 'other', text: '' };
}

/** 待っている AskUserQuestion の問い（最初の問いの文と、その選択肢の label）。 */
export type PendingQuestion = { text: string; options: string[] };

/**
 * 待っている AskUserQuestion の問いを、hook と本文に残ったものから読む。問いが無ければ null。
 * 文は session_activity（hook か本文の索引が書く）、選択肢はその呼び出し（tool_id）の入力の最初の問いの options から取る。
 * 画面の札が読めないとき（hangar の外の端末、札が描かれる前）に、統括へ中身を伝えるのに使う（orchestrator/asks.ts）。
 * 本文がまだ索引に入っていない、読めないときは、選択肢を空にする。
 */
export function pendingQuestionOf(db: Db, sessionId: string): PendingQuestion | null {
  const act = db.prepare('select tool, tool_id, question from session_activity where session_id = ?').get(sessionId) as { tool: string; tool_id: string; question: string | null } | undefined;
  if (act?.tool !== 'AskUserQuestion' || !act.question) return null;
  return { text: act.question, options: optionsOf(db, sessionId, act.tool_id) };
}

/** 呼び出し toolId の入力の、最初の問いの選択肢の label。読めなければ空。 */
function optionsOf(db: Db, sessionId: string, toolId: string): string[] {
  let call: TranscriptEvent | undefined;
  try {
    call = readEvents(db, sessionId, { latest: true, limit: ANSWER_TAIL }).events.find((e) => e.kind === 'tool_call' && e.toolId === toolId);
  } catch {
    return [];
  }
  if (call?.kind !== 'tool_call' || call.name !== 'AskUserQuestion') return [];
  const questions = (call.input as { questions?: unknown } | null)?.questions;
  const options = Array.isArray(questions) ? (questions[0] as { options?: unknown } | null)?.options : undefined;
  if (!Array.isArray(options)) return [];
  return options.flatMap((o) => {
    const label = (o as { label?: unknown } | null)?.label;
    return typeof label === 'string' && label.trim() !== '' ? [label] : [];
  });
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
