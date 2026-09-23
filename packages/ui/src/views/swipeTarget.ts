/**
 * 横スワイプを、指の下の箱に譲るかどうか。
 *
 * 譲るのは「本当に横へ流せる箱の中で、その向きにまだ流す余地がある」ときだけである。
 * `overflow: auto` の器（`.main`、`.tr`、`.list-scroll`）はどの画面にもあり、
 * 組版の綾で数 px はみ出すことがある。そこまで譲ると画面中でスワイプが死ぬので、はみ出しの量で線を引く。
 */

/** これ以下のはみ出しは組版の綾とみなす。実測では、譲りたい一覧の箱は 150px 以上はみ出していた。 */
export const SWIPE_OVERFLOW_SLACK = 8;

export function blocksSwipe(target: EventTarget | null, deltaX: number): boolean {
  // 打鍵の宛先は要素とは限らない（document や window に直に届くことがある）。その回は誰にも譲らない。
  for (let n = target instanceof Element ? target : null; n; n = n.parentElement) {
    const overflowX = getComputedStyle(n).overflowX;
    if (overflowX !== 'auto' && overflowX !== 'scroll') continue;
    if (n.scrollWidth - n.clientWidth <= SWIPE_OVERFLOW_SLACK) continue;
    const room = deltaX < 0 ? n.scrollLeft : n.scrollWidth - n.clientWidth - n.scrollLeft;
    if (room > 1) return true;
  }
  return false;
}
