import { DEFAULT_LANGUAGE, STATE_NOTE_MAX, t, type Language, type SummarizerId, type SummaryState } from '@agent-hangar/shared';
import { MessageError, type Message } from '../i18n/message.ts';

/** language は要約を書かせる言語。要約器への指示と、要約そのものの言語になる。無ければ日本語である。 */
export type SummaryInput = { sessionId: string; text: string; turns: number; running: boolean; titleHint: string | null; language?: Language };
/**
 * 要約が添えるセッションの状態の提案。proposed_status が none か、項目が無いときは付けない。
 * returnInDays は paused のときだけ持ち、1〜14 に収めてある。
 */
export type SummaryProposal = { status: 'done' | 'paused'; note: string; returnInDays: number | null };
/** model は実際に使ったモデルの名前。要約器が入れる（本文の JSON には無い）。 */
export type SummaryOutput = { title: string; oneLiner: string; body: string; state: SummaryState; nextSteps: string[]; proposal?: SummaryProposal; model?: string };

/** 要約器は差し替え可能な部品。available が偽か summarize が失敗したら次の要約器へ回す。 */
export interface Summarizer {
  readonly id: SummarizerId;
  available(): Promise<boolean>;
  summarize(input: SummaryInput): Promise<SummaryOutput>;
}

export class SummarizerError extends MessageError {
  constructor(readonly id: SummarizerId, text: Message | string) { super(text); this.name = 'SummarizerError'; }
}

/**
 * フェーズ 0 の spike 12 と 13 で安定した JSON スキーマに、セッションの状態の提案の 3 つを足したもの。
 * 3 つは必須にする。strict な json_schema では任意の項目をモデルが省けるので、判定をさせるには必須のほうが確かである。
 * 日数の範囲（1〜14）はスキーマに書かず、読むときに収める。spike で通したのは type、enum、maxLength、maxItems だけである。
 */
export const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 40 },
    one_liner: { type: 'string', maxLength: 80 },
    body: { type: 'string' },
    state: { type: 'string', enum: ['in_progress', 'done', 'blocked', 'abandoned'] },
    next_steps: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    proposed_status: { type: 'string', enum: ['done', 'paused', 'none'] },
    proposed_note: { type: 'string', maxLength: 200 },
    proposed_return_in_days: { type: 'integer' },
  },
  required: ['title', 'one_liner', 'body', 'state', 'next_steps', 'proposed_status', 'proposed_note', 'proposed_return_in_days'],
};

/**
 * 要約器に渡す指示。文は辞書の 1 つの鍵（summary.prompt.system）にある。
 * 指示の中の「このセッションは現在も実行中」は、入力の先頭に足す文（summary.input.running）と同じ言い方にそろえる。
 */
export const summarySystemPrompt = (language: Language = DEFAULT_LANGUAGE): string => t(language, 'summary.prompt.system');
/** 日本語の指示。 */
export const SUMMARY_SYSTEM_PROMPT = summarySystemPrompt();

const STATES: SummaryState[] = ['in_progress', 'done', 'blocked', 'abandoned'];

/** paused の提案で戻るまでに置ける日数の上限。 */
export const PROPOSAL_DAYS_MAX = 14;

/**
 * 状態の提案を読む。done と paused のほかは提案なしとする。
 * 根拠が空なら 1 文の要約で埋め、200 字で切る。提案の根拠は 1 字以上が要るためである。
 * paused の日数は整数に丸めて 1〜14 に収め、数でなければ 1（明日）にする。
 */
function parseProposal(o: Record<string, unknown>, oneLiner: string): SummaryProposal | null {
  const status = o.proposed_status;
  if (status !== 'done' && status !== 'paused') return null;
  const raw = typeof o.proposed_note === 'string' ? o.proposed_note.trim() : '';
  const note = [...(raw || oneLiner)].slice(0, STATE_NOTE_MAX).join('');
  if (status === 'done') return { status, note, returnInDays: null };
  const n = typeof o.proposed_return_in_days === 'number' && Number.isFinite(o.proposed_return_in_days) ? Math.round(o.proposed_return_in_days) : 1;
  return { status, note, returnInDays: Math.min(PROPOSAL_DAYS_MAX, Math.max(1, n)) };
}

/**
 * スキーマの形を満たす値だけを SummaryOutput に直す。title か one_liner が空なら null。
 * 状態の提案の 3 つは任意として読む。無いか none なら proposal の項目を付けない。
 */
export function parseSummaryOutput(v: unknown): SummaryOutput | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const oneLiner = typeof o.one_liner === 'string' ? o.one_liner.trim() : '';
  const body = typeof o.body === 'string' ? o.body.trim() : '';
  const state = typeof o.state === 'string' && STATES.includes(o.state as SummaryState) ? (o.state as SummaryState) : null;
  if (!title || !oneLiner || !state) return null;
  const nextSteps = Array.isArray(o.next_steps) ? o.next_steps.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  const proposal = parseProposal(o, oneLiner);
  return { title, oneLiner, body, state, nextSteps, ...(proposal ? { proposal } : {}) };
}
