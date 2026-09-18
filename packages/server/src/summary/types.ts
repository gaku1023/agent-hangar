import type { SummarizerId, SummaryState } from '@agent-hangar/shared';

export type SummaryInput = { sessionId: string; text: string; turns: number; running: boolean; titleHint: string | null };
export type SummaryOutput = { title: string; oneLiner: string; body: string; state: SummaryState; nextSteps: string[] };

/** 要約器は差し替え可能な部品。available が偽か summarize が失敗したら次の要約器へ回す。 */
export interface Summarizer {
  readonly id: SummarizerId;
  available(): Promise<boolean>;
  summarize(input: SummaryInput): Promise<SummaryOutput>;
}

export class SummarizerError extends Error {
  constructor(readonly id: SummarizerId, message: string) { super(message); this.name = 'SummarizerError'; }
}

/** フェーズ 0 の spike 12 と 13 で安定した JSON スキーマ。 */
export const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 40 },
    one_liner: { type: 'string', maxLength: 80 },
    body: { type: 'string' },
    state: { type: 'string', enum: ['in_progress', 'done', 'blocked', 'abandoned'] },
    next_steps: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: ['title', 'one_liner', 'body', 'state', 'next_steps'],
};

export const SUMMARY_SYSTEM_PROMPT = [
  '以下はコーディングエージェントのセッションログの抜粋です。日本語で、指定の JSON だけを返してください。',
  'title は名詞句（40 字まで）、one_liner は 1 文（80 字まで）、body は 2〜3 文、next_steps は具体的な行動（5 件まで）。',
  'state の判定：最後の発言がアシスタントの問いかけや確認で終わっていれば in_progress。依頼が果たされていれば done。',
  'エラーや権限や情報の不足で進めなくなっていれば blocked。途中で打ち切られていれば abandoned。',
  '先頭に「このセッションは現在も実行中」とあれば、完了と断定せず in_progress を選ぶ。',
].join('\n');

const STATES: SummaryState[] = ['in_progress', 'done', 'blocked', 'abandoned'];

/** スキーマの形を満たす値だけを SummaryOutput に直す。title か one_liner が空なら null。 */
export function parseSummaryOutput(v: unknown): SummaryOutput | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const oneLiner = typeof o.one_liner === 'string' ? o.one_liner.trim() : '';
  const body = typeof o.body === 'string' ? o.body.trim() : '';
  const state = typeof o.state === 'string' && STATES.includes(o.state as SummaryState) ? (o.state as SummaryState) : null;
  if (!title || !oneLiner || !state) return null;
  const nextSteps = Array.isArray(o.next_steps) ? o.next_steps.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  return { title, oneLiner, body, state, nextSteps };
}
