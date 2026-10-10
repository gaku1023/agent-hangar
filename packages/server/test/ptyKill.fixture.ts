// pty/nodePty.win.test.ts が別のプロセスで起こす。実物の node-pty で pty を閉じ、その標準エラーに node-pty の補助が何を出すかを見る。
// 標準出力には、何がいつ起きたかの記録を出す。試験が落ちたとき、その記録を添えて原因を追えるようにする。
import { nodePtySpawn } from '../src/pty/nodePty.ts';

const t0 = Date.now();
const log = (s: string): void => { console.log(`+${String(Date.now() - t0).padStart(5)}ms ${s}`); };

const realKill = process.kill.bind(process);
process.kill = ((pid: number, signal?: string | number) => { log(`process.kill(${pid})`); return realKill(pid, signal); }) as typeof process.kill;

// 本番の子（tmux attach）と同じく、孫を持たない 1 つのプロセスを pty の下に置く。
// cmd.exe の下で ping を回すと、孫が出力し続けるので node-pty の終了の通知が数秒遅れ、本番とは違う道筋になる。
const spawn = (name: string, lifeMs: number): ReturnType<typeof nodePtySpawn> => {
  const p = nodePtySpawn(process.execPath, ['-e', `setInterval(() => process.stdout.write('.'), 200); setTimeout(() => process.exit(0), ${lifeMs})`], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  log(`${name} spawned pid=${p.pid}`);
  let first = true;
  p.onData(() => { if (first) { first = false; log(`${name} first data`); } });
  p.onExit((e) => log(`${name} exited code=${e.exitCode}`));
  return p;
};

const a = spawn('a', 60_000);
// 1 つ目は動いている最中に閉じる。
setTimeout(() => { log('a kill()'); a.kill(); }, 1000);

const b = spawn('b', 1500);
// 2 つ目は、勝手に終わってから閉じ直す（relay は終了のあとの close でも kill を呼ぶ）。
setTimeout(() => { log('b kill() x2'); b.kill(); b.kill(); }, 3000);

// 補助のプロセスの失敗は、閉じてから数秒以内に標準エラーへ出る。それを待ってから終わる。
setTimeout(() => { log('done'); process.exit(0); }, 10_000);
