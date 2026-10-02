/**
 * 本文の幅や高さが動いている間の印。
 * 端末（TerminalPane）は、祖先にこの印がある間は寸法を合わせず、LAYOUT_SETTLED で 1 度だけ合わせる。
 * 合わせるたびに寸法をサーバへ送り、tmux が描き直すからである。
 * 左のナビ、右の欄、端末の上の案内の帯が使う。
 */
export const LAYOUT_MOVING_ATTR = 'data-layout-moving';
/** 動きが止まったことを知らせる window の出来事。 */
export const LAYOUT_SETTLED = 'hangar:layout-settled';

/**
 * 動きは重なる（帯が戻りながら伸び直す、案内と帯が一緒に動く、取り消した動きの後始末が遅れて届く）。
 * 要素ごとに数え、最後の 1 つが終わったときにだけ印を外して知らせる。
 * 先に終わった動きが印を外すと、残りの動きの間じゅう端末が寸法を合わせ続けてしまう。
 * begin には、取り消されたときも含め、必ず 1 つの end を対にする。
 */
const moving = new WeakMap<HTMLElement, number>();

export function beginLayoutMotion(el: HTMLElement): void {
  moving.set(el, (moving.get(el) ?? 0) + 1);
  el.setAttribute(LAYOUT_MOVING_ATTR, '');
}

export function endLayoutMotion(el: HTMLElement): void {
  const n = moving.get(el) ?? 0;
  // 対の無い end は数えない（数を負にせず、知らせもしない）。
  if (n <= 0) return;
  if (n > 1) { moving.set(el, n - 1); return; }
  moving.delete(el);
  el.removeAttribute(LAYOUT_MOVING_ATTR);
  window.dispatchEvent(new Event(LAYOUT_SETTLED));
}
