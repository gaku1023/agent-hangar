import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which } from '../src/config/tools.ts';

/** tmux の絶対パス。無ければ null で、tmux に依存するテストは describe.skipIf(!TMUX) で飛ばす。 */
export const TMUX: string | null = which('tmux');

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
