// test/fake-claude.ts のテスト。
// vitest は src/**/*.test.ts しか集めないため、補助の置き場（test/）ではなくここに置く。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readArgs, writeFakeClaude } from '../../test/fake-claude.ts';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-fake-claude-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('writeFakeClaude', () => {
  it('引数と HANGAR_RUN_ID を記録し、改行を含む引数も 1 要素で返す', () => {
    const dir = tmpDir();
    const { bin, argsFile } = writeFakeClaude(dir, { sleepSec: 0 });
    const injected = ['あなたは hangar の中で動いている。', '', '- 1 行目', '- 2 行目', '', '終わり', '', '', '最後'].join('\n');
    expect(injected.split('\n').length - 1).toBe(8);

    const r = spawnSync(bin, ['--append-system-prompt', injected, '-p', 'やること'], {
      encoding: 'utf8',
      env: { ...process.env, HANGAR_RUN_ID: 'run-42' },
    });
    expect(r.status).toBe(0);

    const args = readArgs(argsFile);
    expect(args).toHaveLength(5);
    expect(args[1]).toBe(injected);
    expect(args).toEqual(['--append-system-prompt', injected, '-p', 'やること', 'run-42']);
    expect(args.at(-1)).toBe('run-42');
  });

  it('引数が無くても HANGAR_RUN_ID だけを返す', () => {
    const dir = tmpDir();
    const { bin, argsFile } = writeFakeClaude(dir, { sleepSec: 0 });
    const r = spawnSync(bin, [], { encoding: 'utf8', env: { ...process.env, HANGAR_RUN_ID: 'run-1' } });
    expect(r.status).toBe(0);
    expect(readArgs(argsFile)).toEqual(['run-1']);
  });

  it('HANGAR_RUN_ID が無ければ末尾は空文字になる', () => {
    const dir = tmpDir();
    const { bin, argsFile } = writeFakeClaude(dir, { sleepSec: 0 });
    const env = { ...process.env };
    delete env.HANGAR_RUN_ID;
    const r = spawnSync(bin, ['-p'], { encoding: 'utf8', env });
    expect(r.status).toBe(0);
    expect(readArgs(argsFile)).toEqual(['-p', '']);
  });

  it('exitCode で終わる', () => {
    const dir = tmpDir();
    const { bin } = writeFakeClaude(dir, { sleepSec: 0, exitCode: 3 });
    expect(spawnSync(bin, [], { encoding: 'utf8' }).status).toBe(3);
  });

  it('sleepSec の間は終わらず、その前に引数を記録する', async () => {
    const dir = tmpDir();
    const { bin, argsFile } = writeFakeClaude(dir, { sleepSec: 2 });
    const { spawn } = await import('node:child_process');
    const child = spawn(bin, ['-p'], { env: { ...process.env, HANGAR_RUN_ID: 'run-2' } });
    try {
      await new Promise<void>((resolve, reject) => {
        const until = Date.now() + 3000;
        const tick = () => {
          if (fs.existsSync(argsFile) && readArgs(argsFile).length === 2) return resolve();
          if (Date.now() > until) return reject(new Error('args file not written'));
          setTimeout(tick, 20);
        };
        tick();
      });
      expect(child.exitCode).toBe(null);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
