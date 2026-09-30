import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseBackgroundedId, parseJobs, realProcOps, sameStartTime } from './procs.ts';

describe('parseBackgroundedId', () => {
  it('名前の有無どちらでも id を拾い、無ければ null', () => {
    expect(parseBackgroundedId('backgrounded · a6860899 (idle — send a prompt to start)\n  claude agents')).toBe('a6860899');
    expect(parseBackgroundedId('backgrounded · a173ca6d · wrap-test (idle — send a prompt to start)')).toBe('a173ca6d');
    expect(parseBackgroundedId('Error: something went wrong')).toBeNull();
  });
});

describe('parseJobs', () => {
  it('バックグラウンドのセッションだけを拾い、読めなければ null', () => {
    const out = JSON.stringify([
      { id: 'eebc61e7', cwd: '/x', kind: 'background', sessionId: 'eebc61e7-14c3', state: 'done' },
      { pid: 9815, cwd: '/y', kind: 'interactive', sessionId: '0f2d2c20-9a4a', status: 'waiting' },
    ], null, 2);
    expect(parseJobs(out)).toEqual([{ id: 'eebc61e7', sessionId: 'eebc61e7-14c3' }]);
    expect(parseJobs('disabled')).toBeNull();
    expect(parseJobs('{}')).toBeNull();
  });
});

describe('sameStartTime', () => {
  it('空白の並びの違いは同じと見なす', () => {
    expect(sameStartTime('Wed Sep  3 03:01:55 2026', 'Wed Sep 3 03:01:55 2026')).toBe(true);
    expect(sameStartTime('Wed Sep 30 03:01:55 2026  ', 'Wed Sep 30 03:01:55 2026')).toBe(true);
    expect(sameStartTime('Wed Sep 30 03:01:55 2026', 'Wed Sep 30 03:01:56 2026')).toBe(false);
  });
});

describe('realProcOps', () => {
  it('起動時刻を読み、SIGTERM で止めて終わるまで待つ', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const pid = child.pid!;
    const exited = new Promise((r) => child.on('exit', r));
    try {
      expect(realProcOps.startTimeOf(pid)).toMatch(/^\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
      // 子は親が回収するまでゾンビで残るので、回収を待ってから確かめる。
      const done = realProcOps.terminate(pid, 5000);
      await exited;
      expect(await done).toBe(true);
      expect(realProcOps.startTimeOf(pid)).toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  });
});
