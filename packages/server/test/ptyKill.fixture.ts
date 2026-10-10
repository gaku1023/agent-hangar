// pty/nodePty.win.test.ts が別のプロセスで起こす。実物の node-pty で pty を閉じ、その標準エラーに node-pty の補助が何を出すかを見る。
import { nodePtySpawn } from '../src/pty/nodePty.ts';

const spawn = (): ReturnType<typeof nodePtySpawn> =>
  nodePtySpawn('cmd.exe', ['/d', '/c', 'ping -n 30 127.0.0.1'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });

const a = spawn();
a.onData(() => {});
a.onExit(() => { console.log('a exited'); });
// 1 つ目は動いている最中に閉じる。
setTimeout(() => a.kill(), 1000);

const b = spawn();
b.onData(() => {});
b.onExit(() => { console.log('b exited'); });
// 2 つ目は、勝手に終わってから閉じ直す（relay は終了のあとの close でも kill を呼ぶ）。
setTimeout(() => { b.write('\x03'); }, 1000);
setTimeout(() => { b.kill(); b.kill(); }, 3000);

// 補助のプロセスの失敗は、閉じてから数秒以内に標準エラーへ出る。それを待ってから終わる。
setTimeout(() => process.exit(0), 9000);
