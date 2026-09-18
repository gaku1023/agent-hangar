import { which } from '../src/config/tools.ts';

/** tmux の絶対パス。無ければ null で、tmux に依存するテストは describe.skipIf(!TMUX) で飛ばす。 */
export const TMUX: string | null = which('tmux');

/** 利用者の tmux サーバに触れないための専用ソケット名。 */
export function testSocketName(): string {
  return `hangar-test-${process.pid}`;
}

/** 条件が真になるまで待つ。制限時間を超えたら Error を投げる。 */
export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
