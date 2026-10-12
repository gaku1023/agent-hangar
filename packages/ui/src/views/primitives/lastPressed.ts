/**
 * いちばん最後に押したボタン。押した場所のそばに面を出す部品（エディタが見つからないときの面）が使う。
 * WebKit はボタンを押してもフォーカスを移さないので、document.activeElement では取れない。押し下げを先回りで覚える。
 */
let last: Element | null = null;
let installed = false;

export function installLastPressed(doc: Document = document): void {
  if (installed) return;
  installed = true;
  doc.addEventListener('pointerdown', (e) => {
    const el = e.target instanceof Element ? e.target.closest('button, [role="button"], a') : null;
    if (el) last = el;
  }, true);
}

/** 最後に押したボタンが、まだ頁にあればそれを返す。 */
export function lastPressed(): Element | null {
  return last && last.isConnected ? last : null;
}
