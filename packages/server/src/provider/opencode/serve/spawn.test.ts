import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { readFakeOpencodeLog, writeFakeOpencode } from '../../../../test/fake-opencode.ts';
import { posixDescribe, posixIt } from '../../../../test/platform.ts';
import { serveEnv } from './env.ts';
import { authHeader, killGroup, newServePassword, pickFreePort, startServe, type ServeProcess } from './spawn.ts';

// 偽の opencode は sh の台本から node を起こす。止め方（プロセスのまとまりへの信号）が POSIX のものなので、Windows では飛ばす。
posixDescribe('startServe', () => {
  let dir: string;
  const started: ServeProcess[] = [];
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-serve-')); });
  afterEach(async () => {
    for (const s of started.splice(0)) { killGroup(s.pid, 'SIGKILL'); await s.exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  posixIt('パスワードは 32 バイトの乱数で、起動ごとに変わる', () => {
    const a = newServePassword();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(newServePassword()).not.toBe(a);
  });

  posixIt('127.0.0.1 の空きポートで起こし、認証つきの GET が通るまで待つ。パスワードは env だけで渡し argv に載せない', async () => {
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
    expect(start.pid).toBe(s.pid);
  });

  posixIt('ポートが塞がっていたら、取り直して起こす', async () => {
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

  posixIt('database is locked で落ちたら、理由を locked にして投げる', async () => {
    const { bin } = writeFakeOpencode(dir, { failLockTimes: 1 });
    await expect(startServe({ bin, env: serveEnv(bin) })).rejects.toMatchObject({ reason: 'locked' });
  });
});
