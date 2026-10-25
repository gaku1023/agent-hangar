import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakeOpencode } from '../../../../test/fake-opencode.ts';
import { isWindows, posixIt } from '../../../../test/platform.ts';
import type { ProcRun } from '../../../platform/proc.ts';
import { serveEnv } from './env.ts';
import { isAlive, isOurServe, ServeRegistry, sweepLeftoverServes, windowsProbeAll } from './registry.ts';
import { killGroup, startServe } from './spawn.ts';

describe('ServeRegistry', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-serve-reg-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('pid と起動時刻を書き、消せる。置き場が無ければ作る', () => {
    const reg = new ServeRegistry(path.join(dir, 'opencode', 'serves.json'));
    expect(reg.list()).toEqual([]);
    reg.add({ sessionId: 's1', pid: 10, port: 4100, startedAt: 1000 });
    reg.add({ sessionId: 's2', pid: 11, port: 4101, startedAt: 2000 });
    reg.remove(10);
    expect(new ServeRegistry(path.join(dir, 'opencode', 'serves.json')).list()).toEqual([{ sessionId: 's2', pid: 11, port: 4101, startedAt: 2000 }]);
  });

  it('壊れたファイルは空として読む', () => {
    const file = path.join(dir, 'serves.json');
    fs.writeFileSync(file, '{not json');
    expect(new ServeRegistry(file).list()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify([{ pid: 'x' }, { sessionId: 's', pid: 3, port: 1, startedAt: 1 }]));
    expect(new ServeRegistry(file).list()).toEqual([{ sessionId: 's', pid: 3, port: 1, startedAt: 1 }]);
  });
});

// 本物のプロセスを起こして止める。macOS と Linux は ps で見てまとまりへ信号を送り、Windows は PowerShell で見て taskkill で木ごと止める。
describe('sweepLeftoverServes', () => {
  let dir: string;
  const pids: number[] = [];
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-serve-sweep-')); });
  afterEach(() => {
    for (const pid of pids.splice(0)) killGroup(pid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('前の hangar が残した serve を止め、記録を空にする', async () => {
    const { bin } = writeFakeOpencode(path.join(dir, 'oc'));
    const s = await startServe({ bin, env: serveEnv(bin) });
    pids.push(s.pid);
    const reg = new ServeRegistry(path.join(dir, 'serves.json'));
    reg.add({ sessionId: 's1', pid: s.pid, port: s.port, startedAt: s.startedAt });
    const r = await sweepLeftoverServes(reg, { graceMs: 1000 });
    expect(r.stopped).toEqual([s.pid]);
    await s.exited;
    expect(isAlive(s.pid)).toBe(false);
    expect(reg.list()).toEqual([]);
  });

  // Windows には SIGTERM が無く、最初から木ごと強制で止める。
  posixIt('SIGTERM で降りない serve は、間をおいて SIGKILL で止める', async () => {
    const { bin } = writeFakeOpencode(path.join(dir, 'oc'), { ignoreTerm: true });
    const s = await startServe({ bin, env: serveEnv(bin) });
    pids.push(s.pid);
    const reg = new ServeRegistry(path.join(dir, 'serves.json'));
    reg.add({ sessionId: 's1', pid: s.pid, port: s.port, startedAt: s.startedAt });
    const t0 = Date.now();
    await sweepLeftoverServes(reg, { graceMs: 300 });
    await s.exited;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(isAlive(s.pid)).toBe(false);
  });

  it('pid が別のプロセスに使い回されていたら止めない。終わった pid は記録から消すだけ', async () => {
    // serve でないプロセス（コマンドが違う）と、同じ pid の serve でも起動時刻が違うもの（使い回し）を、どちらも残す。
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: !isWindows, stdio: 'ignore' });
    const otherPid = other.pid ?? 0;
    pids.push(otherPid);
    const { bin } = writeFakeOpencode(path.join(dir, 'oc'));
    const s = await startServe({ bin, env: serveEnv(bin) });
    pids.push(s.pid);
    const reg = new ServeRegistry(path.join(dir, 'serves.json'));
    reg.add({ sessionId: 'a', pid: otherPid, port: 4100, startedAt: Date.now() });
    reg.add({ sessionId: 'b', pid: s.pid, port: s.port, startedAt: s.startedAt - 3_600_000 });
    reg.add({ sessionId: 'c', pid: 999_999, port: 4102, startedAt: Date.now() });
    const r = await sweepLeftoverServes(reg, { graceMs: 300 });
    expect(r.stopped).toEqual([]);
    expect(isAlive(otherPid)).toBe(true);
    expect(isAlive(s.pid)).toBe(true);
    expect(reg.list()).toEqual([]);
  });
});

describe('isOurServe', () => {
  const rec = { sessionId: 's', pid: 10, port: 4100, startedAt: 1_000_000 };
  it('コマンド行の serve と記録したポートと、起動の時刻が合うときだけ真', () => {
    const at = (command: string, elapsedMs = 5_000) => isOurServe(rec, () => ({ elapsedMs, command }), rec.startedAt + 5_000);
    expect(at('/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 4100')).toBe(true);
    expect(at('/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 4101')).toBe(false);
    expect(at('/usr/bin/sleep 30')).toBe(false);
    expect(at('/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 4100', 3_600_000)).toBe(false);
  });
  it('Windows のコマンド行の引用符（cmd.exe 越しの .cmd、空白を含む場所）を読み飛ばす', () => {
    const at = (command: string) => isOurServe(rec, () => ({ elapsedMs: 5_000, command }), rec.startedAt + 5_000);
    expect(at('C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\a b\\oc\\opencode.cmd" serve --hostname 127.0.0.1 --port 4100"')).toBe(true);
    expect(at('"C:\\Users\\a b\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe" serve --hostname 127.0.0.1 --port 4100')).toBe(true);
  });
});

describe('windowsProbeAll（偽の実行）', () => {
  // 2026-10-02T08:40:35Z を 1601 年からの 100 ナノ秒で書いたもの。
  const FT = '134354040350009738';
  const T = Date.UTC(2026, 9, 2, 8, 40, 35);
  it('PowerShell を 1 回だけ打ち、pid ごとに起動からの時間とコマンド行を返す', () => {
    const calls: { file: string; args: string[] }[] = [];
    const run: ProcRun = (file, args) => {
      calls.push({ file, args });
      return { status: 0, stdout: `10\t${FT}\t"C:\\oc\\opencode.exe" serve --hostname 127.0.0.1 --port 4100\r\n11\t${FT}\t\r\n` };
    };
    const probe = windowsProbeAll([10, 11, 12], run, () => T + 7_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('powershell.exe');
    expect(calls[0]!.args.join(' ')).toContain('ProcessId=10 OR ProcessId=11 OR ProcessId=12');
    expect(probe(10)).toEqual({ elapsedMs: 7_000, command: '"C:\\oc\\opencode.exe" serve --hostname 127.0.0.1 --port 4100' });
    // コマンド行の読めないプロセス（権限の無いもの）は、空のコマンド行で返す。居ないものは null。
    expect(probe(11)).toEqual({ elapsedMs: 7_000, command: '' });
    expect(probe(12)).toBeNull();
  });
  it('整数でない pid は問いに入れない。1 つも無ければ打たない。PowerShell が失敗したら、どれも居ないものとして読む', () => {
    let called = 0;
    const fail: ProcRun = () => { called++; return { status: 1, stdout: '' }; };
    expect(windowsProbeAll([-1, 1.5], fail)(-1)).toBeNull();
    expect(called).toBe(0);
    expect(windowsProbeAll([10], fail)(10)).toBeNull();
    expect(called).toBe(1);
  });
});
