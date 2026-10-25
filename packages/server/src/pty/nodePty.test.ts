import { describe, expect, it } from 'vitest';
import { nodePtySpawn } from './nodePty.ts';

// 実物の node-pty。Windows の実物は nodePty.win.test.ts と nodePtyRace.win.test.ts が見る。
describe.skipIf(process.platform === 'win32')('nodePtySpawn（macOS と Linux の実物）', () => {
  // 端末の大きさの知らせは、WebSocket のメッセージの受け口から届く。そこで投げると、サーバのプロセスごと落ちる。
  // 子が終わった後に届くことは普通にある（タブを閉じる途中で、画面の大きさが変わる）。
  it('子が終わった後の resize で投げない', async () => {
    const p = nodePtySpawn('/bin/sh', ['-c', 'exit 0'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    expect(p.pid).toBeGreaterThan(0);
    await new Promise<void>((resolve) => { p.onExit(() => resolve()); });
    // 終わりの通知の後、node-pty が fd を閉じ終えるのを待つ。
    await new Promise((r) => setTimeout(r, 200));
    expect(() => p.resize(100, 30)).not.toThrow();
    expect(() => p.kill()).not.toThrow();
  });
});
