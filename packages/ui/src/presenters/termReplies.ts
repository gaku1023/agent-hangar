import { isEnglishText, type TranscriptEvent } from '@agent-hangar/shared';

/** ターミナルに訳を重ねる返答の数の上限。画面に収まるのは新しい数通なので、古いものは探さない。 */
export const TERM_REPLY_MAX = 12;

/**
 * 動いている会話のターミナルに訳を重ねる返答（docs/design.md「英語の返答の翻訳」のターミナルの節）。
 * 対象は AI の返答（assistant）だけで、思考とツールの出力は外す。
 * 終わったターンの返答だけを返す。動いている間（busy）は、最後の指示より後の返答はまだ書いている途中とみなして外す。
 * 英語（isEnglishText）のものだけを、同じ文は 1 つにして、古い順に上限まで返す。
 */
export function finishedReplies(events: readonly TranscriptEvent[], busy: boolean): string[] {
  let open = events.length;
  if (busy) {
    for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === 'user') { open = i; break; }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = open - 1; i >= 0 && out.length < TERM_REPLY_MAX; i--) {
    const e = events[i]!;
    if (e.kind !== 'assistant' || seen.has(e.text)) continue;
    seen.add(e.text);
    if (isEnglishText(e.text)) out.push(e.text);
  }
  return out.reverse();
}
