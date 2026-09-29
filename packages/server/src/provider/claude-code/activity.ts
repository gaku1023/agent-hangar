import type { TranscriptEvent } from '@agent-hangar/shared';

/**
 * 実行中のセッションが最後に何をしたか。Home の札に出す。
 * toolId は、AskUserQuestion の答え（tool_result）がどの呼び出しへのものかを見分けるために持つ。
 */
export type Activity = { tool: string; summary: string; toolId: string; question: string | null };

/** 札の 1 行に収まらない問いは、ここで切っておく。 */
const QUESTION_MAX = 300;

/**
 * AskUserQuestion の入力から、最初の問いの文を取り出す。
 * 入力は { questions: [{ question, header, options, multiSelect }] } の形である。
 * 形が崩れていれば null を返し、札は決まりの文を出す。
 */
export function firstQuestion(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const first = questions[0] as { question?: unknown } | null;
  const text = typeof first?.question === 'string' ? first.question.replace(/\s+/g, ' ').trim() : '';
  return text === '' ? null : text.slice(0, QUESTION_MAX);
}

/**
 * 正規化した出来事を順に畳み、最後のツール呼び出しを残す。
 * AskUserQuestion の問いは、その呼び出しへの tool_result が来たら答えが済んだとして消す。
 * 呼び出しが 1 つも無ければ、前の値をそのまま返す。
 */
export function foldActivity(prev: Activity | null, events: TranscriptEvent[]): Activity | null {
  let cur = prev;
  for (const ev of events) {
    if (ev.kind === 'tool_call') {
      cur = { tool: ev.name, summary: ev.summary, toolId: ev.toolId, question: ev.name === 'AskUserQuestion' ? firstQuestion(ev.input) : null };
    } else if (ev.kind === 'tool_result' && cur !== null && cur.question !== null && ev.toolId === cur.toolId) {
      cur = { ...cur, question: null };
    }
  }
  return cur;
}
