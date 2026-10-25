import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFakeOpencodeLog, readFakeOpencodeRequests, writeFakeOpencode } from '../../../../test/fake-opencode.ts';
import { until } from '../../../../test/fake-opencode-events.ts';
import { isWindows } from '../../../../test/platform.ts';
import type { ProcRun } from '../../../platform/proc.ts';
import { isAlive } from './registry.ts';
import { serveEnv } from './env.ts';
import { authHeader, killGroup, newServePassword, pickFreePort, startServe, type ServeProcess } from './spawn.ts';

// 偽の opencode は、macOS と Linux は sh の台本から exec で node に替わり、Windows は .cmd の包みを cmd.exe が読んで node を子に起こす。
// Windows では serve の pid が cmd.exe のものになり、偽の opencode（node）はその子である。
describe('startServe', () => {
  let dir: string;
  const started: ServeProcess[] = [];
  const workDirs: string[] = [];
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-serve-')); });
  afterEach(async () => {
    for (const s of started.splice(0)) { killGroup(s.pid, 'SIGKILL'); await s.exited; }
    for (const w of workDirs.splice(0)) fs.rmSync(w, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('パスワードは 32 バイトの乱数で、起動ごとに変わる', () => {
    const a = newServePassword();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(newServePassword()).not.toBe(a);
  });

  it('127.0.0.1 の空きポートで起こし、認証つきの GET が通るまで待つ。パスワードは env だけで渡し argv に載せない', async () => {
    const { bin, logFile } = writeFakeOpencode(dir);
    const s = await startServe({ bin, env: serveEnv(bin) });
    started.push(s);
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    const ok = await fetch(`${s.url}/api/session/active`, { headers: { authorization: authHeader(s.password) } });
    expect(ok.status).toBe(200);
    expect((await fetch(`${s.url}/api/session/active`)).status).toBe(401);
    const start = readFakeOpencodeLog(logFile).find((e) => e.ev === 'start');
    if (start?.ev !== 'start') throw new Error('no start');
    expect(start.argv).toEqual(['serve', '--hostname', '127.0.0.1', '--port', String(s.port)]);
    expect(start.argv.join(' ')).not.toContain(s.password);
    expect(start.env.OPENCODE_SERVER_PASSWORD).toBe(s.password);
    if (!isWindows) expect(start.pid).toBe(s.pid);
  });

  it('会話のフォルダを作業フォルダにして起こし、応答の確かめの GET もその場所を指す', async () => {
    // Windows では動いているプロセスの作業フォルダを消せない（EBUSY）。serve を止めた後の afterEach で消す。
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-serve-work-'));
    workDirs.push(work);
    {
      const { bin, logFile, requestsFile } = writeFakeOpencode(dir);
      const s = await startServe({ bin, env: serveEnv(bin), directory: work });
      started.push(s);
      expect(s.directory).toBe(work);
      const start = readFakeOpencodeLog(logFile).find((e) => e.ev === 'start');
      if (start?.ev !== 'start') throw new Error('no start');
      expect(fs.realpathSync(start.cwd)).toBe(fs.realpathSync(work));
      const reqs = readFakeOpencodeRequests(requestsFile);
      expect(reqs.length).toBeGreaterThan(0);
      expect(reqs.map((r) => r.directory)).toEqual(reqs.map(() => work));
    }
  });

  it('ポートが塞がっていたら、取り直して起こす', async () => {
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
    const busyPort = (busy.address() as net.AddressInfo).port;
    try {
      const { bin, logFile } = writeFakeOpencode(dir);
      const ports = [busyPort];
      const s = await startServe({ bin, env: serveEnv(bin), pickPort: async () => ports.shift() ?? pickFreePort() });
      started.push(s);
      expect(s.port).not.toBe(busyPort);
      const exits = readFakeOpencodeLog(logFile).filter((e) => e.ev === 'exit').map((e) => e.ev === 'exit' && e.reason);
      expect(exits).toEqual(['port-in-use']);
    } finally {
      busy.close();
    }
  });

  it('database is locked で落ちたら、理由を locked にして投げる', async () => {
    const { bin } = writeFakeOpencode(dir, { failLockTimes: 1 });
    await expect(startServe({ bin, env: serveEnv(bin) })).rejects.toMatchObject({ reason: 'locked' });
  });

  it('止めるときは木ごと止める。serve が起こした子（Windows の cmd.exe の下の本体）も残らない', async () => {
    const { bin, logFile } = writeFakeOpencode(dir);
    const s = await startServe({ bin, env: serveEnv(bin) });
    started.push(s);
    const start = readFakeOpencodeLog(logFile).find((e) => e.ev === 'start');
    if (start?.ev !== 'start') throw new Error('no start');
    expect(killGroup(s.pid, 'SIGKILL')).toBe(true);
    await s.exited;
    await until(() => !isAlive(start.pid), 10_000);
  });
});

describe('killGroup（Windows、偽の実行）', () => {
  const calls: { file: string; args: string[] }[] = [];
  const answering = (status: number | null): ProcRun => (file, args) => { calls.push({ file, args }); return { status, stdout: '' }; };
  beforeEach(() => { calls.splice(0); });

  it('信号に依らず、taskkill でプロセスの木ごと強制で止める', () => {
    expect(killGroup(4242, 'SIGTERM', 'win32', answering(0))).toBe(true);
    expect(killGroup(4242, 'SIGKILL', 'win32', answering(0))).toBe(true);
    expect(calls).toEqual([
      { file: 'taskkill.exe', args: ['/PID', '4242', '/T', '/F'] },
      { file: 'taskkill.exe', args: ['/PID', '4242', '/T', '/F'] },
    ]);
  });

  it('taskkill が失敗したら、もう居ないなら偽', () => {
    // 999999 はふつう使われていない pid である。
    expect(killGroup(999_999, 'SIGTERM', 'win32', answering(128))).toBe(false);
  });

  it('整数でない pid には何も起こさない', () => {
    expect(killGroup(0, 'SIGTERM', 'win32', answering(0))).toBe(false);
    expect(killGroup(1.5, 'SIGTERM', 'win32', answering(0))).toBe(false);
    expect(calls).toEqual([]);
  });
});
