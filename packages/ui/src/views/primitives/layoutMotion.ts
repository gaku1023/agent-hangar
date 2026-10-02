/**
 * 本文の幅や高さが動いている間の印。
 * 端末（TerminalPane）は、祖先にこの印がある間は寸法を合わせず、LAYOUT_SETTLED で 1 度だけ合わせる。
 * 合わせるたびに寸法をサーバへ送り、tmux が描き直すからである。
 * 左のナビ、右の欄、端末の上の案内の帯が使う。
 */
export const LAYOUT_MOVING_ATTR = 'data-layout-moving';
/** 動きが止まったことを知らせる window の出来事。 */
export const LAYOUT_SETTLED = 'hangar:layout-settled';

export function beginLayoutMotion(el: HTMLElement): void {
  el.setAttribute(LAYOUT_MOVING_ATTR, '');
}

export function endLayoutMotion(el: HTMLElement): void {
  el.removeAttribute(LAYOUT_MOVING_ATTR);
  window.dispatchEvent(new Event(LAYOUT_SETTLED));
}
