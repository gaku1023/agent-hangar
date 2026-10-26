// pty/nodePtyRace.win.test.ts が別のプロセスで起こす。実物の node-pty で、pty を何本も同時に閉じるのを繰り返す。
// node-pty 1.1.0 の conpty.node は、pty の表（ptyHandles）を錠なしで触っていた。
// 子の終わりを待つスレッドが表から消すのと、メインのスレッドの startProcess、resize、kill、connect が重なると、
// プロセスごと落ちる（0xC0000409、0xC0000005）。1.2.0-beta.13 から錠で守られている。
// このプロセスが落ちずに最後まで回り、終了コード 0 で終わることを試験が見る。
// 標準出力には何がいつ起きたかの記録を出す。試験が落ちたとき、その記録を添えて原因を追えるようにする。
import * as fs from 'node:fs';
import * as pty from 'node-pty';

// Windows のパイプへの書き込みは非同期なので、捕まえなかった例外の文が出る前にプロセスが終わることがある。同期で書いてから終える。
for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(ev, (e: unknown) => {
    fs.writeSync(1, `${ev}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}

const ROUNDS = Number(process.argv[2] ?? 30);
const WIDTH = 8;
const t0 = Date.now();
const log = (s: string): void => { console.log(`+${String(Date.now() - t0).padStart(6)}ms ${s}`); };

type Slot = { p: pty.IPty; ready: Promise<void>; exited: Promise<void>; done: boolean };

// unref した timer で待つと、閉じた pty のほかに待つものが無いとき、top-level await を残したままプロセスが終わる（終了コード 13）。
// 残った timer は最後の process.exit で捨てるので、ref のままにする。
const timeout = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

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
  // 同じ瞬間に、全部の大きさを変え、全部を閉じる。閉じ方は hangar（pty/close.ts）と同じく、子のプロセスだけを終わらせる。
  // node-pty の kill は使わない。kill は子のコンソールのプロセスの一覧を補助のプロセスに取らせ、その全部に process.kill を送る。
  // 子が先に終わって pid が使い回されると、一覧がこのプロセスのコンソールのものになり、自分を終了コード 1 で止めることがある（CI で 2 回起きた）。
  // pty の表の競合は、子の終わりを待つスレッドが表から消すのと、メインのスレッドの起動と resize が重なることで起きるので、この閉じ方でも試せる。
  for (const s of batch) quietly(() => s.p.resize(100, 30));
  // pid は pseudoconsole につないだ後に決まり、それまでは 0 である。Windows の process.kill(0) は自分を終わらせるので、0 のものはつないでから閉じる。
  const stop = (s: Slot): void => quietly(() => { if (s.p.pid > 0) process.kill(s.p.pid); });
  for (const s of batch) { if (s.p.pid > 0) stop(s); else void s.ready.then(() => stop(s)); }
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
