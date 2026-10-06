import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isAlive, parseStartTime, sameStartTime, startTimeOf, terminate, type ProcRun } from './proc.ts';

describe('parseStartTime', () => {
  it('ps の lstart を UTC として読む', () => {
    expect(parseStartTime('Thu Oct  2 02:30:05 2026')).toBe(Date.UTC(2026, 9, 2, 2, 30, 5));
  });
  // Windows の Claude Code は、1601 年からの 100 ナノ秒単位の整数を文字列で書く（2026-10-05 実測）。
  it('Windows の 100 ナノ秒単位の整数を読む', () => {
    // 2026-10-02T08:40:35.0009738Z
    expect(parseStartTime('134354040350009738')).toBe(Date.UTC(2026, 9, 2, 8, 40, 35, 0));
  });
  it('読めないものは null', () => {
    expect(parseStartTime('')).toBeNull();
    expect(parseStartTime('12345')).toBeNull();
    expect(parseStartTime('Thu Feb 30 02:30:05 2026')).toBeNull();
  });
});

describe('sameStartTime', () => {
  it('空白の並びの違いを吸い、数値は文字列として比べる', () => {
    expect(sameStartTime('Thu Oct  2 02:30:05 2026', 'Thu Oct 2 02:30:05 2026')).toBe(true);
    expect(sameStartTime('134354040350009738', ' 134354040350009738\r\n')).toBe(true);
    expect(sameStartTime('134354040350009738', '134354040350009739')).toBe(false);
  });
});

describe('startTimeOf（偽の実行）', () => {
  it('Windows は PowerShell に聞き、数字だけの答えを返す', () => {
    const calls: { file: string; args: string[] }[] = [];
    const run: ProcRun = (file, args) => { calls.push({ file, args }); return { status: 0, stdout: '134354040350009738\r\n' }; };
    expect(startTimeOf(6196, 'win32', run)).toBe('134354040350009738');
    expect(calls[0]!.file).toBe('powershell.exe');
    expect(calls[0]!.args.join(' ')).toContain('Get-Process -Id 6196');
  });
  // 聞く前に相手が消えたとき。PowerShell は失敗で終わる。
  it('相手が居なければ null', () => {
    expect(startTimeOf(6196, 'win32', () => ({ status: 1, stdout: '' }))).toBeNull();
    expect(startTimeOf(6196, 'win32', () => ({ status: 0, stdout: 'Get-Process : ...' }))).toBeNull();
    expect(startTimeOf(6196, 'darwin', () => ({ status: 1, stdout: '' }))).toBeNull();
  });
  it('整数でない pid は、何も起こさずに null', () => {
    let called = false;
    const run: ProcRun = () => { called = true; return { status: 0, stdout: '1' }; };
    expect(startTimeOf(1.5, 'win32', run)).toBeNull();
    expect(startTimeOf(-1, 'darwin', run)).toBeNull();
    expect(startTimeOf(Number.NaN, 'win32', run)).toBeNull();
    expect(called).toBe(false);
  });
});

describe('実物のプロセス', () => {
  it('起動時刻を読み、止めて終わるまで待つ', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const exited = new Promise((r) => child.once('exit', r));
    try {
      const started = startTimeOf(pid);
      expect(started).not.toBeNull();
      expect(Math.abs(parseStartTime(started!)! - Date.now())).toBeLessThan(15_000);
      // 2 回聞いても同じ値。PID の使い回しを見分ける鍵になる。
      expect(sameStartTime(started!, startTimeOf(pid)!)).toBe(true);
      expect(isAlive(pid)).toBe(true);
      const done = terminate(pid, 5000);
      await exited;
      expect(await done).toBe(true);
      expect(isAlive(pid)).toBe(false);
      expect(startTimeOf(pid)).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 20_000);
});
