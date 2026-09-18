import { spawn } from 'node:child_process';

/**
 * 初回に開くための鍵付きの URL。
 * ページはこの鍵をクッキーに換え、URL からは消す。
 * 以後はブックマークから鍵無しで開ける。
 */
export function entryUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`;
}

/**
 * URL を開く AppleScript。
 * AppleScript の文字列を閉じてしまう引用符と、逃がし記号そのものを逃がす。
 */
export function openLocationScript(url: string): string {
  return `open location "${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
}

/**
 * 鍵付きの URL をブラウザで開く。
 * `open <URL>` だと URL が argv に載り、同じ利用者のどのプロセスからも ps で読めてしまう。
 * osascript に標準入力から渡せば、argv は `-` だけで済む。
 */
export function openInBrowser(url: string, spawnFn: typeof spawn = spawn): void {
  const child = spawnFn('osascript', ['-'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  child.stdin?.end(openLocationScript(url));
  child.unref();
}
