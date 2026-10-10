import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'ptyKill.fixture.ts');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 実物の node-pty を Windows で閉じる。macOS と Linux では丸ごと飛ぶ。
describe.skipIf(process.platform !== 'win32')('nodePtySpawn の kill（Windows の実物）', () => {
  it('動いている pty を閉じても、終わった pty を閉じ直しても、node-pty の "AttachConsole failed" を標準エラーに残さない', async () => {
    const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture], { cwd: serverDir, windowsHide: true });
      let out = ''; let err = '';
      const t0 = Date.now();
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { err += `[+${Date.now() - t0}ms] ${d.toString()}`; });
      child.on('close', (code) => resolve({ code, out, err }));
    });
    // 落ちたときは、記録（標準出力）を添える。
    const why = `stdout:\n${r.out}`;
    expect(r.err, why).not.toContain('AttachConsole');
    expect(r.err, why).not.toContain('conpty_console_list_agent');
    expect(r.out, why).toContain('a exited');
    expect(r.code, why).toBe(0);
  }, 60_000);
});
