import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'ptyRelease.fixture.ts');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KILLED = 20;
const SELF_EXITED = 5;

type Counts = {
  killed: number; ready: number; baseline: number; during: number; after: number;
  killedExited: number; killedWorkers: number; killedWorkersExited: number;
  selfExited: number; selfWorkers: number; selfWorkersExited: number;
  handlesBefore: number; handlesAfterKilled: number; handlesAfterSelf: number;
};

// node-pty 1.2.0-beta.15 の Windows は、子が自分で終わった経路で conout の Worker と pseudoconsole（conhost.exe）を放さない。
// 実機では、端末を開け閉めするたびにスレッドが 1 本、私用メモリが約 16MB 増えて減らず、約 2,100 回でサーバが heap out of memory で落ちた。
// hangar の閉じ方（pty/close.ts）で閉じたあと、Worker が終わり、conhost.exe が元の数に戻ることを、別のプロセスで数える。macOS と Linux では丸ごと飛ぶ。
describe.skipIf(process.platform !== 'win32')('nodePtySpawn の解放（Windows の実物）', () => {
  it(`cmd.exe の pty を ${KILLED} 本開いて閉じると、conout の Worker が終わり、conhost.exe が残らない`, async () => {
    const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, String(KILLED), String(SELF_EXITED)], { cwd: serverDir, windowsHide: true });
      let out = ''; let err = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      child.on('close', (code) => resolve({ code, out, err }));
    });
    // 落ちたときは、記録（標準出力と標準エラー）を添える。
    const why = `code=${r.code}\nstdout:\n${r.out}\nstderr:\n${r.err}`;
    expect(r.code, why).toBe(0);
    const c = JSON.parse(r.out.trim().split(/\r?\n/).at(-1) ?? '{}') as Counts;
    expect(c.ready, why).toBe(KILLED);
    // 開いている間に数えられていなければ、閉じた後の数が戻ったことも確かめられない。
    expect(c.during, why).toBeGreaterThanOrEqual(c.baseline + KILLED);
    expect(c.killedExited, why).toBe(KILLED);
    expect(c.killedWorkers, why).toBe(KILLED);
    expect(c.killedWorkersExited, why).toBe(KILLED);
    expect(c.after, why).toBeLessThanOrEqual(c.baseline);
    // 子が自分で終わったときも、Worker は放す。
    expect(c.selfExited, why).toBe(SELF_EXITED);
    expect(c.selfWorkers, why).toBe(SELF_EXITED);
    expect(c.selfWorkersExited, why).toBe(SELF_EXITED);
    // 入力の pipe（conin）の fd を閉じなければ、1 本ごとにハンドルが 1 つ増える。揺れを見込んで、本数の半分より少ないこと。
    // 子が自分で終わった pty は、上流の作りで pseudoconsole が残り、その分のハンドルも残るので、ここでは見ない。
    expect(c.handlesAfterKilled - c.handlesBefore, why).toBeLessThan(KILLED / 2);
    // 補助のプロセス（conpty_console_list_agent）を起こさないので、その失敗も出ない。
    expect(r.err, why).not.toContain('AttachConsole');
    expect(r.err, why).not.toContain('conpty_console_list_agent');
  }, 180_000);
});
