import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseBackgroundedId, parseJobs, parseProcStart, realProcOps, sameStartTime } from './procs.ts';

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

describe('parseProcStart', () => {
  it('UTC の ps の lstart を epoch のミリ秒に読む。1 桁の日の空白埋めも読む', () => {
    expect(parseProcStart('Thu Oct  2 02:30:05 2026')).toBe(Date.parse('2026-10-02T02:30:05.000Z'));
    expect(parseProcStart('Wed Sep 30 03:01:55 2026 ')).toBe(Date.parse('2026-09-30T03:01:55.000Z'));
  });
  it('読めない書式と暦に無い日は null', () => {
    for (const s of ['', 'garbage', '2026-10-02T02:30:05Z', 'Thu Foo  2 02:30:05 2026', 'Mon Feb 30 00:00:00 2026', 'Thu Oct  2 25:30:05 2026']) expect(parseProcStart(s), s).toBeNull();
  });
});

describe('realProcOps', () => {
  it('起動時刻を読み、止めて終わるまで待つ', async () => {
    // sleep は Windows に無いので、どの OS にもある Node を待たせる。
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const exited = new Promise((r) => child.on('exit', r));
    try {
      // macOS と Linux は ps の lstart、Windows は 100 ナノ秒単位の整数。
      expect(realProcOps.startTimeOf(pid)).toMatch(process.platform === 'win32' ? /^\d{17,19}$/ : /^\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
      // 読み取りは UTC で行う。手元の時刻帯で読むと、時刻帯の分だけずれる。
      expect(Math.abs(parseProcStart(realProcOps.startTimeOf(pid)!)! - Date.now())).toBeLessThan(10_000);
      // 子は親が回収するまでゾンビで残るので、回収を待ってから確かめる。
      const done = realProcOps.terminate(pid, 5000);
      await exited;
      expect(await done).toBe(true);
      expect(realProcOps.startTimeOf(pid)).toBeNull();
    } finally {
      // Windows は SIGKILL を受けない（kill EINVAL）。既定の止め方にする。
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
});
