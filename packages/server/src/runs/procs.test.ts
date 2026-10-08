import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeAndExitScript, writeFakeNodeTool, writeFakeTool } from '../../test/fake-bin.ts';
import { posixIt } from '../../test/platform.ts';
import type { Drift } from '../provider/claude-code/compat/types.ts';
import { parseJobs, parseProcStart, realProcOps, realProcOpsWith, sameStartTime } from './procs.ts';

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

describe('realProcOpsWith', () => {
  // 偽の claude は sh で書く。Windows の .cmd は spawnSync で直に起こせないので飛ばす。
  posixIt('agents --json の形が違えば、読まずにずれとして知らせる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-procs-'));
    try {
      const bin = writeFakeTool(dir, 'claude', { sh: `echo '{"sessions":[]}'`, cmd: '' });
      const seen: Drift[] = [];
      expect(realProcOpsWith({ note: (d) => seen.push(d) }).listJobs(bin)).toBeNull();
      expect(seen).toEqual([{ contract: 'cli', value: 'agents-json=(not-array)', version: null }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  // バックグラウンドのセッションが多いと、agents --json はパイプの容量（8KB〜16KB）を越える。
  // claude はパイプへ非同期に書いて書き切る前に終わるので、パイプで読むと JSON が途中で切れ、1 件も拾えなくなる。
  posixIt('agents --json がパイプの容量を越えても、最後まで読んで全部拾う', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-procs-'));
    try {
      const rows = Array.from({ length: 500 }, (_, i) => ({ id: `job${i}`, cwd: `/work/project-${i}`, kind: 'background', sessionId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, state: 'done' }));
      const text = JSON.stringify(rows, null, 2);
      expect(text.length).toBeGreaterThan(64 * 1024);
      const bin = writeFakeNodeTool(dir, 'claude', writeAndExitScript(text));
      const seen: Drift[] = [];
      const jobs = realProcOpsWith({ note: (d) => seen.push(d) }).listJobs(bin);
      expect(jobs).toHaveLength(500);
      expect(jobs?.at(-1)).toEqual({ id: 'job499', sessionId: '00000000-0000-0000-0000-000000000499' });
      expect(seen).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
