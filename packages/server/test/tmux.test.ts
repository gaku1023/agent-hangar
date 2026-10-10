import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeDirsWhenIdle } from './tmux.ts';

describe.skipIf(process.platform === 'win32')('removeDirsWhenIdle', () => {
  it('そのディレクトリを引数に持つプロセスが書き終えるのを待ってから消し、後から作り直されない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-idle-'));
    // 遅れて起きる書き手。tmux の中の包み（hangar-run.sh）が、試験の終わり際にログを作るのと同じ形である。
    const writer = spawn('sh', ['-c', 'sleep 0.4; mkdir -p "$(dirname "$1")"; echo x >> "$1"', 'sh', path.join(dir, 'logs', 'a')], { stdio: 'ignore' });
    const exited = new Promise((r) => writer.on('exit', r));
    await removeDirsWhenIdle([dir]);
    await exited;
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('書き手が居なければすぐ消す。無いパスは黙って飛ばす', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-idle-'));
    fs.mkdirSync(path.join(dir, 'a'));
    const t0 = Date.now();
    await removeDirsWhenIdle([dir, path.join(dir, 'nope-x')]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
