import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'ptyRace.fixture.ts');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUNDS = 30;

// node-pty 1.1.0 の Windows の conpty.node は、pty を何本も同時に閉じるとプロセスごと落ちることがあった（0xC0000409、0xC0000005）。
// 実機では、8 本を同時に閉じるのを 13 巡ほど繰り返すと落ちた。1.2.0-beta.13 で錠が入ったので、その版より前へ戻すとここで落ちうる。
// 落ちるのはプロセスごとなので、別のプロセスで回し、その終了コードを見る。macOS と Linux では丸ごと飛ぶ。
describe('node-pty の pty の表の競合（Windows の実物）', () => {
  it.skipIf(process.platform !== 'win32')(`8 本を同時に閉じるのを ${ROUNDS} 巡繰り返しても、プロセスが落ちない`, async () => {
    const r = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, String(ROUNDS)], { cwd: serverDir, windowsHide: true });
      let out = ''; let err = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      child.on('close', (code, signal) => resolve({ code, signal, out, err }));
    });
    // 落ちたときは、終了コード（0xC0000409 なら 3221226505）と記録を添える。
    const why = `code=${r.code} (0x${(r.code ?? 0).toString(16)}) signal=${r.signal}\nstdout:\n${r.out}\nstderr:\n${r.err}`;
    expect(r.out, why).toContain(`done rounds=${ROUNDS}`);
    expect(r.code, why).toBe(0);
  }, 300_000);
});
