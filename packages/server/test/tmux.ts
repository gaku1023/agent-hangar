import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which } from '../src/config/tools.ts';

/**
 * tmux の絶対パス。無ければ null で、tmux に依存するテストは describe.skipIf(!TMUX) で飛ばす。
 * Windows では常に null にする。ここを使う試験は sh や bash を前提に書いてあり、後始末で kill-server を呼ぶ。
 * psmux の kill-server は利用者のセッションまで落とすので、psmux を相手にする試験は tmux/psmux.win.test.ts に分けてある。
 */
export const TMUX: string | null = process.platform === 'win32' ? null : which('tmux');

/** 作ったソケットの置き場。ワーカーが終わるときにまとめて消す。 */
const socketDirs: string[] = [];
let hooked = false;

/**
 * 利用者の tmux サーバに触れないための専用ソケット。
 * kill-server ではソケットの inode が残るので、`-L` の名前ではなく `-S` のパスで渡し、
 * 一時ディレクトリの中に置いてディレクトリごと消せるようにする。
 */
export function testSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-sock-'));
  socketDirs.push(dir);
  if (!hooked) {
    hooked = true;
    // afterAll を書き忘れたファイルがあっても置き去りにしない。
    process.once('exit', () => {
      for (const d of socketDirs) fs.rmSync(d, { recursive: true, force: true });
    });
  }
  return path.join(dir, 'tmux.sock');
}

/** そのソケットの置き場ごと消す。tmux サーバを落としてから呼ぶ。 */
export function removeTestSocket(socketPath: string): void {
  fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
}

/** 条件が真になるまで待つ。制限時間を超えたら Error を投げる。 */
export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** その文字列を引数に持つプロセスが、まだ居るか。pgrep の無い環境（Windows）では居ないことにする。 */
function hasProcessMentioning(needles: string[]): boolean {
  const pattern = needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '';
}

/**
 * 試験の後始末でディレクトリを消す。
 * tmux の kill-server はペインのプロセスに SIGHUP を送って戻るだけで、その終わりを待たない。
 * 起動の途中だった包み（hangar-run.sh）は HUP を無視する区間があり、消している最中や消した後に logs を作って、
 * 「ENOTEMPTY」で afterEach が落ちたり、一時ディレクトリが残ったりしていた（負荷の高い全体の試験で時々）。
 * そこで、各ディレクトリの logs/ を引数に持つプロセス（包みとその tee）が居なくなるのを条件にして待ち、それから消す。
 * ディレクトリ全体で見ないのは、`fake-claude stop` のように 30 秒生きるだけで何も書かないプロセスを待たないためである。
 * 時間の上限は、プロセスが残り続ける異常のときに止まるための安全弁で、通常の経路では使わない。
 */
export async function removeDirsWhenIdle(dirs: string[], timeoutMs = 8000): Promise<void> {
  const logs = dirs.filter((d) => fs.existsSync(d)).map((d) => path.join(d, 'logs') + path.sep);
  const until = Date.now() + timeoutMs;
  while (logs.length > 0 && hasProcessMentioning(logs) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
