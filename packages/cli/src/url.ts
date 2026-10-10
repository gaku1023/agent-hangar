import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hangarHome, openTargetCommand } from '@agent-hangar/server/src/cliEntry.ts';

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

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * url へすぐ移る HTML。macOS の外で鍵付きの URL を開くときに、ブラウザへはこのファイルのパスだけを渡す。
 * URL は属性の値と script の文字列に埋めるので、どちらからも抜けられない形に逃がす。
 */
export function redirectPage(url: string): string {
  const js = JSON.stringify(url).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${escapeHtml(url)}"><title>Hangar</title><script>location.replace(${js})</script>\n`;
}

/** 転送のページの置き場。hangar の置き場（本人だけが読める）に置き、鍵のファイル（token）の隣に並ぶ。 */
export const REDIRECT_FILE = 'open.html';

export type OpenInBrowserOptions = {
  /** 試験が差し替える。 */
  spawnFn?: typeof spawn;
  platform?: NodeJS.Platform;
  /** 転送のページを書く置き場。既定は hangar の置き場。 */
  home?: string;
};

/**
 * 鍵付きの URL をブラウザで開く。
 * `open <URL>` だと URL が argv に載り、同じ利用者のどのプロセスからも ps で読めてしまう。
 * macOS は osascript に標準入力から渡せば、argv は `-` だけで済む。
 * macOS の外には同じ口が無い。既定のブラウザは URL を自分の argv で受け取るので、URL ではなく、URL へ移るページのファイルを開かせる。
 * argv に載るのはファイルのパスだけで、鍵はファイルの中にある。ファイルは鍵のファイルと同じ、本人だけが読める置き場に置く。
 * 開く道具が無い（ENOENT）ときも CLI は落とさない。鍵付きの URL は呼び手が印字している。
 */
export function openInBrowser(url: string, o: OpenInBrowserOptions = {}): void {
  const spawnFn = o.spawnFn ?? spawn;
  const platform = o.platform ?? process.platform;
  if (platform === 'darwin') {
    const child = spawnFn('osascript', ['-'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    child.on('error', () => {});
    child.stdin?.end(openLocationScript(url));
    child.unref();
    return;
  }
  const home = o.home ?? hangarHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const page = path.join(home, REDIRECT_FILE);
  fs.writeFileSync(page, redirectPage(url), { mode: 0o600 });
  // mode は新しく作るときにしか効かないので、既にある分は chmod で直す。Windows では読み取り専用の切り替えにしかならないが、0600 は書ける側なので変わらない。
  fs.chmodSync(page, 0o600);
  const c = openTargetCommand(page, platform);
  const child = spawnFn(c.file, c.args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}
