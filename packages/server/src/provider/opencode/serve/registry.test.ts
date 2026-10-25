import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakeOpencode } from '../../../../test/fake-opencode.ts';
import { posixDescribe, posixIt } from '../../../../test/platform.ts';
import { serveEnv } from './env.ts';
import { isAlive, ServeRegistry, sweepLeftoverServes } from './registry.ts';
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

// 本物のプロセスを起こして止める。プロセスのまとまりへの信号と ps が POSIX のものなので、Windows では飛ばす。
posixDescribe('sweepLeftoverServes', () => {
  let dir: string;
  const pids: number[] = [];
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-serve-sweep-')); });
  afterEach(() => {
    for (const pid of pids.splice(0)) killGroup(pid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  posixIt('前の hangar が残した serve を止め、記録を空にする', async () => {
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

  posixIt('pid が別のプロセスに使い回されていたら止めない。終わった pid は記録から消すだけ', async () => {
    // serve でないプロセス（コマンドが違う）と、同じ pid の serve でも起動時刻が違うもの（使い回し）を、どちらも残す。
    const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
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
