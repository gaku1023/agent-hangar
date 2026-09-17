import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { copyFixtureClaudeDir } from '../test/fixtures.ts';
import { startServer } from './server.ts';

let home: string;
let claudeDir: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = copyFixtureClaudeDir();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

describe('startServer', () => {
  it('WebSocket と keep-alive の接続が残っていても close は 2 秒以内に終わる', async () => {
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    expect(s.port).toBeGreaterThan(0);
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?token=${token}`);
    const ready = await new Promise<string>((resolve, reject) => { ws.once('message', (d) => resolve(String(d))); ws.once('error', reject); });
    expect(JSON.parse(ready).type).toBe('ready');
    // close フレームに応えない相手。ブラウザのタブが止まっているときや代理を挟むときに起こる。
    const stalled = net.connect(s.port, '127.0.0.1');
    await new Promise<void>((r) => stalled.once('connect', r));
    stalled.write(`GET /ws?token=${token} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const upgraded = await new Promise<string>((r) => stalled.once('data', (d) => r(String(d))));
    expect(upgraded.startsWith('HTTP/1.1 101')).toBe(true);
    // fetch は keep-alive で接続を残す。
    const health = await fetch(`http://127.0.0.1:${s.port}/health`);
    expect(health.status).toBe(200);
    await health.text();
    const result = await Promise.race([
      s.close().then(() => 'closed'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 2000)),
    ]);
    expect(result).toBe('closed');
    ws.terminate();
    stalled.destroy();
  });

  it('claudeDir を渡すと settings ではなくそれを読む', async () => {
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
      const r = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
      expect(((await r.json()) as unknown[]).length).toBe(3);
    } finally {
      await s.close();
    }
  });
});
