// pty/nodePtyRelease.win.test.ts が別のプロセスで起こす。実物の node-pty で cmd.exe の pty を何本も開いて閉じ、何が残るかを数える。
// node-pty 1.2.0-beta.15 は、子が自分で終わった経路で、conout の Worker（スレッド 1 本）と pseudoconsole（conhost.exe）を放さない。
// hangar の閉じ方（pty/close.ts）が両方を放すことを、このプロセスの Worker の終わりと、このプロセスを親に持つ conhost.exe の数で見る。
// 入力の pipe（conin）の fd も node-pty は閉じないので、このプロセスのハンドルの数が開け閉めの数だけ増えないことも見る。
// 最後の行に、数えた結果を JSON で出す。それより前の行は、何がいつ起きたかの記録である。
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { nodePtySpawn } from '../src/pty/nodePty.ts';

// Windows のパイプへの書き込みは非同期なので、捕まえなかった例外の文が出る前にプロセスが終わることがある。同期で書いてから終える。
for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(ev, (e: unknown) => {
    fs.writeSync(1, `${ev}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}

const KILLED = Number(process.argv[2] ?? 20);
const SELF_EXITED = Number(process.argv[3] ?? 5);
const t0 = Date.now();
const log = (s: string): void => { console.log(`+${String(Date.now() - t0).padStart(6)}ms ${s}`); };
const timeout = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref(); });

// node-pty は conout の Worker を、読み込んだ worker_threads の Worker で作る。作るたびに数え、'exit' を待てるようにする。
// node-pty は Worker を作る時にモジュールから引くので、読み込んだ後に差し替えても効く。
type Watched = { exited: boolean; done: Promise<void> };
const conoutWorkers: Watched[] = [];
const wt = createRequire(import.meta.url)('node:worker_threads') as typeof import('node:worker_threads');
const OrigWorker = wt.Worker;
wt.Worker = class extends OrigWorker {
  constructor(...a: ConstructorParameters<typeof OrigWorker>) {
    super(...a);
    if (!String(a[0]).includes('conoutSocketWorker')) return;
    const w: Watched = { exited: false, done: Promise.resolve() };
    w.done = new Promise<void>((r) => { this.once('exit', () => { w.exited = true; r(); }); });
    conoutWorkers.push(w);
  }
} as typeof OrigWorker;

// このプロセスを親に持つ conhost.exe の数。CreatePseudoConsole は、呼んだプロセスの子として conhost.exe を起こす。
// 引用の崩れを避けるため、PowerShell には UTF-16LE の Base64 で渡す。
const run = promisify(execFile);
const conhosts = async (): Promise<number> => {
  const cmd = `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} and Name='conhost.exe'").Count`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')], { windowsHide: true });
  return Number(stdout.trim());
};

// このプロセスのハンドルの数。数える PowerShell を起こすことでも少し揺れるので、増え方を開け閉めの数と比べる。
const handles = async (): Promise<number> => {
  const cmd = `(Get-Process -Id ${process.pid}).HandleCount`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')], { windowsHide: true });
  return Number(stdout.trim());
};

type Slot = { p: ReturnType<typeof nodePtySpawn>; ready: Promise<void>; exited: Promise<void>; done: boolean; worker: Watched | undefined };
const open = (args: string[]): Slot => {
  const before = conoutWorkers.length;
  const p = nodePtySpawn(process.env.ComSpec ?? 'cmd.exe', args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  const ready = new Promise<void>((resolve) => { p.onData(() => resolve()); });
  const slot: Slot = { p, ready, exited: Promise.resolve(), done: false, worker: conoutWorkers[before] };
  slot.exited = new Promise<void>((resolve) => { p.onExit(() => { slot.done = true; resolve(); }); });
  return slot;
};
const waitAll = async (ps: Promise<void>[], ms: number): Promise<void> => { await Promise.race([Promise.all(ps), timeout(ms)]); };

const baseline = await conhosts();
// ハンドルの数は、最初の pty で作られるもの（libuv の thread pool など）を除くため、1 本開け閉めしてから数える。
const warm = open([]);
await waitAll([warm.ready], 30_000);
warm.p.kill();
await waitAll([warm.exited, warm.worker?.done ?? Promise.resolve()], 15_000);
for (let i = 0; i < 15 && (await conhosts()) > baseline; i++) await timeout(1000);
const handlesBefore = await handles();
log(`baseline conhost=${baseline} handles=${handlesBefore}`);

// 動いている pty を閉じる。hangar の閉じ方（pty/close.ts）は、つないだ後（pid が決まった後）なら pseudoconsole を閉じる。
const killed = Array.from({ length: KILLED }, () => open([]));
await waitAll(killed.map((s) => s.ready), 30_000);
const ready = killed.filter((s) => s.p.pid > 0).length;
const during = await conhosts();
log(`opened ${KILLED} ready=${ready} conhost=${during}`);
for (const s of killed) s.p.kill();
await waitAll(killed.map((s) => s.exited), 30_000);
log(`killed exited=${killed.filter((s) => s.done).length}`);
await waitAll(killed.map((s) => s.worker?.done ?? Promise.resolve()), 15_000);
const killedWorkersExited = killed.filter((s) => s.worker?.exited).length;
log(`killed workers exited=${killedWorkersExited}`);
// conhost は pseudoconsole を閉じてから少しして終わる。元の数に戻るまで数え直す。
let after = await conhosts();
for (let i = 0; i < 15 && after > baseline; i++) { await timeout(1000); after = await conhosts(); }
const handlesAfterKilled = await handles();
log(`after conhost=${after} handles=${handlesAfterKilled}`);

// 子が自分で終わる pty。hangar は終わりを見たら conout の Worker を放す。conhost は上流の作りで残るので数えない。
const selfExited = Array.from({ length: SELF_EXITED }, () => open(['/c', 'exit 0']));
await waitAll(selfExited.map((s) => s.exited), 30_000);
// relay は終わった後の WebSocket の close でも kill を呼ぶ。閉じ直しても何もしないことも通す。
for (const s of selfExited) s.p.kill();
await waitAll(selfExited.map((s) => s.worker?.done ?? Promise.resolve()), 15_000);
const selfWorkersExited = selfExited.filter((s) => s.worker?.exited).length;
// 子が自分で終わった pty の出力の socket は、node-pty が終わりから 1 秒待って閉じる。それより後に数える。
// timeout は unref なので、ほかに待つものが無いこの時点で使うとプロセスが先に終わる。ref のままの timer で待つ。
await new Promise((r) => { setTimeout(r, 2000); });
const handlesAfterSelf = await handles();
log(`self exited=${selfExited.filter((s) => s.done).length} workers exited=${selfWorkersExited} handles=${handlesAfterSelf}`);

console.log(JSON.stringify({
  killed: KILLED, ready, baseline, during, after, handlesBefore, handlesAfterKilled, handlesAfterSelf,
  killedExited: killed.filter((s) => s.done).length, killedWorkers: killed.filter((s) => s.worker).length, killedWorkersExited,
  selfExited: selfExited.filter((s) => s.done).length, selfWorkers: selfExited.filter((s) => s.worker).length, selfWorkersExited,
}));
process.exit(0);
