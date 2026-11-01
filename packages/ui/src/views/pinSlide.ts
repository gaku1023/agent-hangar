import { motionEase, motionMs } from './primitives/motion.ts';
import { fadeIn, motionOn, slideFrom } from './primitives/motionKit.ts';

/**
 * ピン留めの「滑って移る」（試作 issue550 の A）。留めた行は元の場所からピンの段へ、外した行はグループの席へ滑る。
 * 段とスクロールする一覧をまたいで動くので、一覧の overflow に切られないよう、行の複製を body に置いて飛ばす。残りの行は前の位置から滑らせて席を詰める。
 * instant が真の間（行が移る 1 回の描画）は、一覧の出入りの動き（Sidebar の hangIn と hangOut）を止める。移った後の並びを測るために、すぐ最後の形にしておくためである。
 */
export const pinFlight = { instant: false };

/** 節の中の行とグループの見出しの位置。key は行の id か、g: を付けたグループの key。 */
export function measureRows(section: Element): Map<string, DOMRect> {
  const out = new Map<string, DOMRect>();
  for (const el of section.querySelectorAll<HTMLElement>('.side-live-row[data-id]')) out.set(el.dataset.id!, el.getBoundingClientRect());
  for (const el of section.querySelectorAll<HTMLElement>('[data-group] > .side-live-grp-h')) out.set(`g:${el.parentElement!.dataset.group}`, el.getBoundingClientRect());
  return out;
}

/** 行の複製を元の場所から行き先へ飛ばす。飛ぶ間は本物を隠す。行き先が見えない（畳んだグループの中）なら、元の場所で薄れて消える。 */
function fly(el: HTMLElement, from: DOMRect): void {
  const to = el.getBoundingClientRect();
  const hiddenTarget = to.height === 0;
  // 行き先が一覧の見えている範囲の外なら、一覧の端まで飛んで薄れる。
  const scroll = el.closest<HTMLElement>('.side-live-scroll')?.getBoundingClientRect();
  const top = !hiddenTarget && scroll && scroll.height > 0 ? Math.max(scroll.top, Math.min(scroll.bottom - to.height, to.top)) : to.top;
  const fades = hiddenTarget || top !== to.top;
  const end = hiddenTarget ? from : { left: to.left, top, width: to.width, height: to.height };
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.dataset.flight = 'true';
  ghost.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = `position:fixed;left:${end.left}px;top:${end.top}px;width:${end.width}px;height:${end.height}px;margin:0;z-index:40;pointer-events:none;box-sizing:border-box;padding-left:${getComputedStyle(el).paddingLeft};`;
  document.body.append(ghost);
  const dx = from.left - end.left;
  const dy = from.top - end.top;
  const drop = 'var(--glass-drop)';
  const anim = ghost.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(1.02)`, boxShadow: drop, background: 'rgba(255, 255, 255, 0.96)', opacity: 1 },
    { transform: 'none', boxShadow: fades ? drop : 'none', background: fades ? 'rgba(255, 255, 255, 0.96)' : 'rgba(255, 255, 255, 0)', opacity: fades ? 0 : 1 },
  ], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
  if (!fades) el.style.visibility = 'hidden';
  const done = () => { ghost.remove(); el.style.visibility = ''; };
  void anim.finished.then(done, done);
}

/**
 * 行が移った描画の後に呼ぶ。before は移る前の位置（measureRows）、moved は段に出入りした行の id。
 * 新しく現れた行（グループごと現れたときの見出しなど）は薄れから現す。
 */
export function slideRows(section: Element, before: Map<string, DOMRect>, moved: string[]): void {
  if (!motionOn(section)) return;
  const movedSet = new Set(moved);
  const each = (el: HTMLElement, key: string) => {
    const was = before.get(key);
    if (movedSet.has(key)) { if (was) fly(el, was); return; }
    if (was) slideFrom(el, was, el.getBoundingClientRect()); else fadeIn(el, '--dur-fast');
  };
  for (const el of section.querySelectorAll<HTMLElement>('.side-live-row[data-id]')) if (!el.closest('[data-leaving]')) each(el, el.dataset.id!);
  for (const el of section.querySelectorAll<HTMLElement>('[data-group]:not([data-leaving]) > .side-live-grp-h')) each(el, `g:${el.parentElement!.dataset.group}`);
}
