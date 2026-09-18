/**
 * 初回に開くための鍵付きの URL。
 * ページはこの鍵をクッキーに換え、URL からは消す。
 * 以後はブックマークから鍵無しで開ける。
 */
export function entryUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`;
}
