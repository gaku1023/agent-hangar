// pty/nodePtyRace.win.test.ts が別のプロセスで起こす。実物の node-pty で、pty を何本も同時に閉じるのを繰り返す。
// node-pty 1.1.0 の conpty.node は、pty の表（ptyHandles）を錠なしで触っていた。
// 子の終わりを待つスレッドが表から消すのと、メインのスレッドの startProcess、resize、kill、connect が重なると、
// プロセスごと落ちる（0xC0000409、0xC0000005）。1.2.0-beta.13 から錠で守られている。
// このプロセスが落ちずに最後まで回り、終了コード 0 で終わることを試験が見る。
// 標準出力には何がいつ起きたかの記録を出す。試験が落ちたとき、その記録を添えて原因を追えるようにする。
import * as pty from 'node-pty';

const ROUNDS = Number(process.argv[2] ?? 30);
const WIDTH = 8;
const t0 = Date.now();
const log = (s: string): void => { console.log(`+${String(Date.now() - t0).padStart(6)}ms ${s}`); };

type Slot = { p: pty.IPty; ready: Promise<void>; exited: Promise<void>; done: boolean };

const timeout = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref(); });

const open = (): Slot => {
  const p = pty.spawn(process.env.ComSpec ?? 'cmd.exe', [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  const ready = new Promise<void>((resolve) => { const d = p.onData(() => { d.dispose(); resolve(); }); });
  const slot: Slot = { p, ready, exited: Promise.resolve(), done: false };
  slot.exited = new Promise<void>((resolve) => { p.onExit(() => { slot.done = true; resolve(); }); });
  return slot;
};

// 終わった後の resize は投げる（Cannot resize a pty that has already exited）。ここで見たいのは表の競合なので、投げたものは捨てる。
const quietly = (f: () => void): void => { try { f(); } catch { /* 終わっている */ } };

let stragglers = 0;
let batch = Array.from({ length: WIDTH }, open);
for (let round = 1; round <= ROUNDS; round++) {
  await Promise.race([Promise.all(batch.map((s) => s.ready)), timeout(10_000)]);
  // 同じ瞬間に、全部の大きさを変え、全部を閉じる。閉じ方は、node-pty の kill と、子だけを終わらせる hangar の閉じ方（pty/close.ts）を半分ずつにする。
  for (const s of batch) quietly(() => s.p.resize(100, 30));
  batch.forEach((s, i) => {
    if (i % 2 === 0) quietly(() => s.p.kill());
    // pid は pseudoconsole につないだ後に決まり、それまでは 0 である。Windows の process.kill(0) は自分を終わらせるので、0 のときは kill に回す。
    else quietly(() => { if (s.p.pid > 0) process.kill(s.p.pid); else s.p.kill(); });
  });
  // 前の組の終わりを待つスレッドが表から消している間に、次の組を起こし、大きさを変え続ける。
  const closing = batch;
  batch = round < ROUNDS ? Array.from({ length: WIDTH }, open) : [];
  const churn = setInterval(() => { for (const s of [...closing, ...batch]) quietly(() => s.p.resize(80 + (round % 40), 24 + (round % 10))); }, 1);
  await Promise.race([Promise.all(closing.map((s) => s.exited)), timeout(20_000)]);
  clearInterval(churn);
  const left = closing.filter((s) => !s.done).length;
  stragglers += left;
  log(`round ${round} closed${left ? ` (${left} not exited)` : ''}`);
}
log(`done rounds=${ROUNDS} stragglers=${stragglers}`);
process.exit(0);
