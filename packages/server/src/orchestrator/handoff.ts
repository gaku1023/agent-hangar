import type { Translate } from '@agent-hangar/shared';

/**
 * 統括を新しい会話に切り替えたとき、新しい統括の最初の入力にする引き継ぎ（docs/design.md「統括」の切り替えの手順 4）。
 * hangar が記録から組み、古い統括のメモ（write_handoff）があれば添える。メモが無くても組める。
 */

/** 利用者の最近の言葉の数（前の会話の利用者の入力の末尾から）。 */
export const HANDOFF_USER_WORDS = 3;
/** 古い統括のメモの上限（字）。write_handoff もこの長さで受ける。 */
export const HANDOFF_MEMO_MAX = 4000;
/** 利用者の言葉 1 つの上限（字）。 */
const WORD_MAX = 300;

export type HandoffInput = {
  /** 前の統括の会話の id。 */
  previousId: string;
  /** 前の統括が起こした・送った会話のうち、動いているもの。 */
  active: { id: string; title: string }[];
  /** 預かり中の問い（許可の札と質問）。 */
  asks: { kind: string; id: string; title: string }[];
  /** 許可の方針（利用者の言葉）。無ければ null。 */
  policy: string | null;
  /** 前の会話の利用者の入力（古い順）。末尾の HANDOFF_USER_WORDS 個を使う。 */
  userWords: string[];
  /** 古い統括のメモ。書けなかったら null。 */
  memo: string | null;
};

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function buildHandoff(tr: Translate, h: HandoffInput): string {
  const out = [tr('mcp.orchestrator.handoffHead', { previous: h.previousId })];
  if (h.active.length > 0) {
    out.push('', tr('mcp.orchestrator.handoffActive'));
    for (const s of h.active) out.push(tr('mcp.orchestrator.handoffSessionLine', { id: s.id, title: oneLine(s.title) }));
  }
  if (h.asks.length > 0) {
    out.push('', tr('mcp.orchestrator.handoffAsks'));
    for (const a of h.asks) out.push(tr('mcp.orchestrator.handoffAskLine', { kind: a.kind, id: a.id, title: oneLine(a.title) }));
  }
  const policy = h.policy === null ? '' : oneLine(h.policy);
  if (policy !== '') out.push('', tr('mcp.orchestrator.handoffPolicy', { policy }));
  const words = h.userWords.map((w) => oneLine(w).slice(0, WORD_MAX)).filter((w) => w !== '').slice(-HANDOFF_USER_WORDS);
  if (words.length > 0) {
    out.push('', tr('mcp.orchestrator.handoffUserWords'));
    for (const w of words) out.push(tr('mcp.orchestrator.handoffWordLine', { text: w }));
  }
  const memo = h.memo === null ? '' : h.memo.trim().slice(0, HANDOFF_MEMO_MAX);
  out.push('', memo === '' ? tr('mcp.orchestrator.handoffNoMemo') : `${tr('mcp.orchestrator.handoffMemo')}\n${memo}`);
  return out.join('\n');
}
