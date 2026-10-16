import { spawn, type ChildProcess } from 'node:child_process';
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

/** 鍵の無い URL。端末に出してよい（鍵が入っていない）。開くと 401 の案内の画面になる。 */
export function bareUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** hangar open がブラウザを開けたときの 1 行。鍵はブラウザへだけ渡したので、端末にも履歴にも残らない。 */
export function openedMessage(port: number): string {
  return `ブラウザで開きました（${bareUrl(port)}）。`;
}

/**
 * hangar open がブラウザを開けなかったときの案内。
 * 鍵付きの URL をここで出すと、開けなかった場面ほど端末の表示や履歴に鍵が残る。
 * 鍵の無い URL と、鍵の出し方（hangar url）だけを案内する。hangar url は鍵付きの URL を出すので、人に見せないよう添える。
 */
export function openFailedMessage(port: number): string {
  return [
    `ブラウザを開けませんでした。${bareUrl(port)} を手動で開いてください。`,
    'トークンが必要なときは、hangar url でトークン付きの URL を表示できます。その URL にはトークンが含まれているため、他の人に見せないでください。',
  ].join('\n');
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
 * 開く道具が無い（ENOENT）ときも CLI は落とさない。
 * 戻り値は、開けたか。道具が 0 で終われば true、起こせない・0 以外・信号で終われば false。
 * 呼び手は、開けなかったときも鍵付きの URL を端末へ出さない（openFailedMessage）。
 * 道具が終わらないときは、待たずに true とする（既定のブラウザが前面で居座る道具もある）。
 */
export function openInBrowser(url: string, o: OpenInBrowserOptions = {}): Promise<boolean> {
  const spawnFn = o.spawnFn ?? spawn;
  const platform = o.platform ?? process.platform;
  if (platform === 'darwin') {
    const child = spawnFn('osascript', ['-'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    const result = outcome(child);
    child.stdin?.end(openLocationScript(url));
    return result;
  }
  const home = o.home ?? hangarHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const page = path.join(home, REDIRECT_FILE);
  fs.writeFileSync(page, redirectPage(url), { mode: 0o600 });
  // mode は新しく作るときにしか効かないので、既にある分は chmod で直す。Windows では読み取り専用の切り替えにしかならないが、0600 は書ける側なので変わらない。
  fs.chmodSync(page, 0o600);
  const c = openTargetCommand(page, platform);
  const child = spawnFn(c.file, c.args, { stdio: 'ignore', detached: true, windowsHide: true });
  const result = outcome(child);
  return result;
}

/** 開く道具が居座る場合に、結果を待つ長さ。 */
const OPEN_WAIT_MS = 5_000;

/**
 * 子の終わり方から、開けたかを決める。error の受け手を必ず付けるので、起こせなくても CLI は落ちない。
 * 結果が出るまでは子を unref しない。先に unref すると、親は子の終わりを待たずに終わってしまい、何も印字されない。
 * 結果が出たら unref して、子を切り離す。
 */
function outcome(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => { clearTimeout(timer); child.unref(); resolve(ok); };
    const timer = setTimeout(() => done(true), OPEN_WAIT_MS);
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
  });
}
