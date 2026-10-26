import { agentsWithCap, type AgentUiCap } from '@agent-hangar/shared';
import { fadeIn, fadeOut, resizeFrom, slideFrom, staggerIn } from './primitives/motionKit.ts';

/**
 * 新しいセッションのエージェントの切り替えの動き（M1）。
 * 消える札は --dur-swap で薄れ、残る札は前の位置から新しい位置へ滑り（FLIP）、新しい札は --stagger ずつずれて浮き上がる。ダイアログの高さは resizeFrom で変える。
 * どの札がどのエージェントのものかは、要素の data-agent-only（そのエージェントの名前。複数なら空白で区切る）で見分ける。値は agentOnlyAttr が能力（AGENT_UI_CAPS）から作る。札の列は `.launch-chips` の子である。
 * エージェントの札（エージェントの絵を持つ残る札）は、名前の長さで変わる幅を前の幅から横に動かし、新しい絵を --dur-swap で現す。
 * 動かない環境（jsdom、reduced motion）では、薄れを待たずにすぐ入れ替わる。
 */

export const AGENT_ONLY_ATTR = 'data-agent-only';

/** その能力を持つエージェントだけに出す札の印。要素に展開して使う（`{...agentOnlyAttr('effort')}`）。 */
export function agentOnlyAttr(cap: AgentUiCap): { [AGENT_ONLY_ATTR]: string } {
  return { [AGENT_ONLY_ATTR]: agentsWithCap(cap).join(' ') };
}

/** 入れ替える直前の形。残る札の位置、エージェントの札の幅、ダイアログの高さ。 */
export type AgentSwapSnapshot = { dialog: HTMLElement; height: number; rects: Map<Element, DOMRect>; widths: Map<HTMLElement, number> };

const only = (root: HTMLElement, agent: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(`[${AGENT_ONLY_ATTR}~="${agent}"]`)];

/** 消える札（from のもの）を薄れさせ、薄れ終えたら、残る札の位置とダイアログの高さを覚えて返す。 */
export async function leaveAgent(dialog: HTMLElement, from: string): Promise<AgentSwapSnapshot> {
  const leaving = only(dialog, from);
  await Promise.all(leaving.map((el) => fadeOut(el, '--dur-swap')));
  const rects = new Map<Element, DOMRect>();
  const widths = new Map<HTMLElement, number>();
  for (const el of dialog.querySelectorAll('.launch-chips > *')) {
    if (leaving.includes(el as HTMLElement)) continue;
    rects.set(el, el.getBoundingClientRect());
    if (el instanceof HTMLElement && el.querySelector('.agent-icon')) widths.set(el, el.offsetWidth);
  }
  return { dialog, height: dialog.offsetHeight, rects, widths };
}

/** 入れ替えた後の描画で呼ぶ。残った札を滑らせ、新しい札（to のもの）を浮き上がらせ、ダイアログの高さを前の高さから動かす。 */
export function enterAgent(s: AgentSwapSnapshot, to: string): void {
  resizeFrom(s.dialog, s.height);
  for (const [el, before] of s.rects) if (el.isConnected && el instanceof HTMLElement) slideFrom(el, before, el.getBoundingClientRect());
  staggerIn(only(s.dialog, to));
  for (const [el, width] of s.widths) {
    if (!el.isConnected) continue;
    resizeFrom(el, width, 'x');
    const icon = el.querySelector<HTMLElement>('.agent-icon');
    if (icon) fadeIn(icon, '--dur-swap');
  }
}
