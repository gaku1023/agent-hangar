/**
 * 画面の移り変わりの最中のクリックを、下の部品へ通す。
 * View Transitions の間は出る画面と入る画面の写しが画面を覆い、クリックはどこを押しても文書の根（<html>）に当たる。
 * そのままだと遷移の 0.4 秒ほど、サイドバーを続けて押しても効かない（Chrome と WebKit の両方で、写しに pointer-events: none を指定しても通らない）。
 * 根に当たった本物のクリックが来たら遷移を終わらせ、同じ位置にある部品へ同じクリックを渡し直す。
 */

/** クリックのうち、ここで読むところ。本物の MouseEvent の isTrusted は試験で作れないので、形だけを受ける。 */
export type ClickLike = Pick<MouseEvent, 'isTrusted' | 'target' | 'clientX' | 'clientY' | 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'preventDefault' | 'stopPropagation'>;

export type ClickThroughEnv = {
  /** 文書の根。遷移の写しに当たったクリックは、ここを的にして届く。 */
  root: Element;
  /** 動いている遷移を終わらせる。遷移があれば true。 */
  skip(): boolean;
  /** 遷移を終わらせた後の、その位置にある部品（document.elementFromPoint）。 */
  hit(x: number, y: number): Element | null;
};

export function clickThrough(e: ClickLike, env: ClickThroughEnv): void {
  // 渡し直したクリックは信頼されていないので、ここへ戻ってきても何もしない。
  if (!e.isTrusted || e.target !== env.root || !env.skip()) return;
  e.stopPropagation();
  e.preventDefault();
  const { clientX, clientY, button, metaKey, ctrlKey, shiftKey, altKey } = e;
  env.hit(clientX, clientY)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY, button, metaKey, ctrlKey, shiftKey, altKey }));
}
