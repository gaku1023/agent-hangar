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
  if (busy) {
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
