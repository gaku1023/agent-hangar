import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent, SessionDto } from '@agent-hangar/shared';
import { mangleCwd } from './provider/claude-code/discover.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../test/fixtures.ts';
import { startServer } from './server.ts';

let home: string;
let claudeDir: string;
let ws: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = copyFixtureClaudeDir();
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

const tokenOf = () => fs.readFileSync(path.join(home, 'token'), 'utf8').trim();

/** 実際の Claude Code と同じ配置で、発言 1 つだけの本文ファイルを置く。 */
function writeTranscript(cwd: string, sessionId: string, text: string): void {
  const dir = path.join(claudeDir, 'projects', mangleCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const rec = { type: 'user', message: { role: 'user', content: text }, uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: '2026-09-01T10:00:00.000Z', cwd, sessionId };
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(rec) + '\n');
}

/** 配信を貯めておき、条件に合うものが来るまで待つ。待ち始める前に来たものも見る。 */
function collector(port: number, token: string) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const seen: ServerEvent[] = [];
  const waiters = new Set<() => void>();
  sock.on('message', (d) => { seen.push(JSON.parse(String(d)) as ServerEvent); for (const w of [...waiters]) w(); });
  const opened = new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); sock.once('error', reject); });
  return {
    opened,
    close: () => sock.terminate(),
    waitFor<T extends ServerEvent>(pred: (e: ServerEvent) => e is T, ms = 8000): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const check = () => { const hit = seen.find(pred); if (hit) { waiters.delete(check); clearTimeout(timer); resolve(hit); } };
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`event not seen: ${JSON.stringify(seen.map((e) => e.type))}`)); }, ms);
        waiters.add(check);
        check();
      });
    },
  };
}

/** 条件が満たされるまで一定間隔で試す。 */
async function until<T>(fn: () => Promise<T | null>, ms = 8000): Promise<T> {
  const limit = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > limit) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
      const token = tokenOf();
      const r = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
      expect(((await r.json()) as unknown[]).length).toBe(3);
    } finally {
      await s.close();
    }
  });

  it('起動後に現れたセッションにもプロジェクトを紐づけて配信する', async () => {
    const dir = path.join(ws, 'alpha');
    fs.mkdirSync(dir);
    // 起動時にプロジェクトが登録されるよう、ワークスペース配下のセッションを 1 つ置いておく。
    writeTranscript(dir, 'bbbbbbbb-0000-4000-8000-000000000001', 'first');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir }));
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    const c = collector(s.port, tokenOf());
    try {
      await c.opened;
      writeTranscript(dir, 'bbbbbbbb-0000-4000-8000-000000000002', 'second');
      const ev = await c.waitFor((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert' && e.session.providerSessionId === 'bbbbbbbb-0000-4000-8000-000000000002');
      expect(ev.session.projectId).not.toBeNull();
      const proj = await c.waitFor((e): e is Extract<ServerEvent, { type: 'project.upsert' }> => e.type === 'project.upsert' && e.project.id === ev.session.projectId);
      expect(proj.project.name).toBe('alpha');
    } finally {
      c.close();
      await s.close();
    }
  }, 20000);

  it('実行中の登録が消えたら要約の状態を done に書き替える', async () => {
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    const token = tokenOf();
    const stateOf = async (): Promise<string | null> => {
      const r = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
      const list = (await r.json()) as SessionDto[];
      return list.find((x) => x.providerSessionId === SESSION_ALPHA)?.summary?.state ?? null;
    };
    try {
      expect(await stateOf()).toBe('in_progress');
      fs.rmSync(path.join(claudeDir, 'sessions', '12345.json'));
      await until(async () => ((await stateOf()) === 'done' ? true : null));
    } finally {
      await s.close();
    }
  }, 20000);
});
