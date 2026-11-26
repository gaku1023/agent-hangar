import { isEnglishText, type TranscriptEvent } from '@agent-hangar/shared';

/** ターミナルに訳を重ねる返答の数の上限。画面に収まるのは新しい数通なので、古いものは探さない。 */
export const TERM_REPLY_MAX = 12;

/**
 * 動いている会話のターミナルに訳を重ねる返答（docs/design.md「英語の返答の翻訳」のターミナルの節）。
 * 対象は AI の返答（assistant）と思考（thinking）で、ツールの出力は外す。
 * 思考も含めるのは、Claude Code（2.1.332 以降）が思考の要約を返答と同じ ● の行で出し、末尾に「 · summary」を付けるためである。
 * 画面に出ていない思考は、書き換えの側（runtime/termRewrite.ts）で行が見つからないので何も起きない。
 * 終わったターンの返答だけを返す。動いている間（busy）は、最後の指示より後の返答はまだ書いている途中とみなして外す（終わりの印で閉じたターンは除く）。
 * 英語（isEnglishText）のものだけを、同じ文は 1 つにして、古い順に上限まで返す。
 */
export function finishedReplies(events: readonly TranscriptEvent[], busy: boolean): string[] {
  let open = events.length;
  // 質問の札で答えを待っている間は、そのターンの返答は書き終わっている（札の前に書いた文）。外さない。
  if (busy && pendingAsk(events) === null) {
    // 指示を送ると、記録に載るより先に busy になる。最後の指示の後のターンが終わりの印で閉じていれば、
    // 動いているのは記録にまだ無い新しいターンなので、どの返答も外さない（外すと、送った途端に直前の返答の訳が英語に戻る）。
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === 'system' && (e.subtype === 'turn_duration' || e.subtype === 'turn_aborted')) break;
      if (e.kind === 'user') { open = i; break; }
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = open - 1; i >= 0 && out.length < TERM_REPLY_MAX; i--) {
    const e = events[i]!;
    if ((e.kind !== 'assistant' && e.kind !== 'thinking') || seen.has(e.text)) continue;
    seen.add(e.text);
    if (isEnglishText(e.text)) out.push(e.text);
  }
  return out.reverse();
}

/** 答えを待っている質問の札（AskUserQuestion の呼び出しで、同じ toolId の結果がまだ無いもの）の入力。無ければ null。 */
function pendingAsk(events: readonly TranscriptEvent[]): unknown {
  const answered = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'tool_result') { answered.add(e.toolId); continue; }
    if (e.kind === 'tool_call' && e.name === 'AskUserQuestion') return answered.has(e.toolId) ? null : e.input;
  }
  return null;
}

/**
 * ターミナルの質問の札で訳す文（docs/design.md「英語の返答の翻訳」の質問の札）。
 * 答えを待っている札の、問いと選択肢の説明のうち英語のものを返す。選択肢の名前（label）は、送られる答えと同じ文字のまま残すので訳さない（2026-11-26 の試作で利用者が決めた）。
 */
export function pendingAskTexts(events: readonly TranscriptEvent[]): string[] {
  const input = pendingAsk(events) as { questions?: unknown } | null;
  const qs = input && Array.isArray(input.questions) ? input.questions : [];
  const out: string[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  for (const q of qs as { question?: unknown; options?: unknown }[]) {
    const question = str(q?.question);
    if (question) out.push(question);
    if (Array.isArray(q?.options)) for (const o of q.options as { description?: unknown }[]) { const d = str(o?.description); if (d) out.push(d); }
  }
  return out.filter((t) => isEnglishText(t));
}
