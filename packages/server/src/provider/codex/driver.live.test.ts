import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AgentAsk, LaunchSpec } from '../../agent/types.ts';
import { writeFakeCodex } from '../../../test/fake-codex.ts';
import { posixDescribe } from '../../../test/platform.ts';
import { LaunchQueue } from '../opencode/serve/queue.ts';
import { createCodexDriver, type CodexDriver } from './driver.ts';
import { createCodexLive } from './live.ts';

const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// 偽の codex の app-server に、driver が live・asks（B4）をつなぐ。起動したら写しに載り、止めたら消える。
posixDescribe('Codex の driver と状態の面のつなぎ（B3a + B4）', () => {
  let dir: string;
  let cwd: string;
  const drivers: CodexDriver[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxl-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxlw-'));
  });
  afterEach(async () => {
    for (const d of drivers.splice(0)) await d.launch.release({ sessionId: 's1', providerSessionId: '', cwd }, 'killed');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const make = (home = path.join(dir, 'home')) => {
    const bin = writeFakeCodex(path.join(dir, 'bin'), { turnMs: 30_000 });
    const surface = createCodexLive({ log: () => undefined });
    const d = createCodexDriver({
      bin: () => bin, home, droppedEnv: [], graceMs: 500, mcpPollMs: 10, mcpWaitMs: 1000, queue: new LaunchQueue(),
      live: surface.live, asks: surface.asks, report: () => undefined,
    });
    drivers.push(d);
    const asked: AgentAsk[] = [];
    d.asks.subscribe!((a) => asked.push(a));
    return { d, asked };
  };
  const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
    cwd, hangarSessionId: 's1', instructions: [], mcp: { url: 'http://127.0.0.1:4177/mcp/s/s1', secret: 's' }, env: {}, ...over,
  });
  const rows = (d: CodexDriver) => d.live.current();

  it('初期プロンプトあり：起動したら実行中として写り、止めたら消える', async () => {
    const { d } = make();
    const r = (await d.launch.materialize!({ kind: 'start' }, spec({ prompt: 'work' }))) as { providerSessionId: string };
    await until(() => rows(d).some((x) => x.status === 'busy'));
    expect(rows(d)[0]).toMatchObject({ sessionId: r.providerSessionId, agent: 'codex', cwd, pid: d.served('s1')!.pid });
    expect(await d.launch.release({ sessionId: 's1', providerSessionId: r.providerSessionId, cwd }, 'killed')).toBe(true);
    expect(rows(d)).toEqual([]);
  });

  it('承認待ち：許可の中身が行と asks に載り、止めたら消える', async () => {
    const { d, asked } = make();
    const r = (await d.launch.materialize!({ kind: 'start' }, spec({ prompt: 'ask:command' }))) as { providerSessionId: string };
    await until(() => rows(d).some((x) => x.status === 'waiting'));
    expect(rows(d)[0]).toMatchObject({ status: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash' } });
    expect(asked.length).toBeGreaterThan(0);
    await d.launch.release({ sessionId: 's1', providerSessionId: r.providerSessionId, cwd }, 'killed');
    expect(rows(d)).toEqual([]);
  });

  it('初期プロンプトなし：TUI がつないで ID が分かったら写り、止めたら消える', async () => {
    const { d } = make();
    const r = (await d.launch.materialize!({ kind: 'start' }, spec())) as { providerSessionId: string; lateSessionId: Promise<string> };
    expect(rows(d)).toEqual([]);
    const info = d.served('s1')!;
    const ws = new WebSocket(`${info.url}/?tui=1&cwd=${encodeURIComponent(cwd)}`, { headers: { authorization: `Bearer ${info.token}` } });
    await new Promise((res) => ws.once('open', res));
    const id = await r.lateSessionId;
    await until(() => rows(d).length === 1);
    expect(rows(d)[0]).toMatchObject({ sessionId: id, agent: 'codex', status: 'idle' });
    await d.launch.release({ sessionId: 's1', providerSessionId: id, cwd }, 'killed');
    expect(rows(d)).toEqual([]);
    ws.close();
  });

  it('hangar を起こし直したあと：引き継いだ app-server につなぎ直して写り、止めたら消える', async () => {
    const a = make();
    const r = (await a.d.launch.materialize!({ kind: 'start' }, spec({ prompt: 'work' }))) as { providerSessionId: string };
    const b = make();
    expect(b.d.launch.reattach!({ sessionId: 's1', providerSessionId: r.providerSessionId, cwd })).toBe(true);
    await until(() => rows(b.d).some((x) => x.status === 'busy'));
    expect(rows(b.d)[0]).toMatchObject({ sessionId: r.providerSessionId });
    await b.d.launch.release({ sessionId: 's1', providerSessionId: r.providerSessionId, cwd }, 'killed');
    expect(rows(b.d)).toEqual([]);
  });
});
