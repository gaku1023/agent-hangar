/**
 * 鍵付きの URL で開かれたときに、URL から鍵だけを消す。
 * サーバはこの HTML を配る時点で鍵をクッキーに換えているので、URL に残す理由はもう無い。
 * ブラウザの履歴と、画面を見ている人の目に鍵を晒し続けないための後始末である。
 * 消したかどうかを返す。
 */
export function stripEntryToken(href: string, replace: (url: string) => void): boolean {
  const u = new URL(href);
  if (!u.searchParams.has('t')) return false;
  u.searchParams.delete('t');
  replace(`${u.pathname}${u.search}${u.hash}`);
  return true;
}
