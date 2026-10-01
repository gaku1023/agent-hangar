/**
 * 箱（container）の中だけをスクロールして、要素（item）を見える位置へ寄せる。
 * scrollIntoView は WebKit で overflow: hidden の外側の箱まで動かし、アプリ全体が戻れない位置へずれる（Tauri の窓と WebKit で実測）。
 * block: 'nearest' と同じく、見えていれば動かさず、はみ出した側へだけ寄せる。箱より高い要素は頭を上端に合わせる。
 */
export function revealWithin(container: HTMLElement, item: HTMLElement): void {
  const c = container.getBoundingClientRect();
  const r = item.getBoundingClientRect();
  if (r.top < c.top || r.height > c.height) container.scrollTop += r.top - c.top;
  else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
}
