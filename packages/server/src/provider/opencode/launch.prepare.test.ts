import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchPrepAsked, LaunchPreps } from '../../runs/launchPrep.ts';
import { prepareModels, type MaterializeDeps } from './launch.ts';
import type { LocalModelsDeps } from './localModels/prepare.ts';
import type { ServeInfo } from './serve/manager.ts';

const GB = 1024 ** 3;
const LM = 'http://127.0.0.1:1234/v1';

let server: http.Server | null = null;
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-launch-prep-')); });
afterEach(async () => {
  await new Promise<void>((r) => { server ? server.close(() => r()) : r(); });
  server = null;
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * 起きたばかりの serve の偽物。実物の 2.1.4 は、起きて数百 ms の間 `/api/provider` を空で答え、`/api/config` と `/api/model` は初めから揃っている。
 * providerRowsAfter 回目の問いから rows を答える。configProviders は設定の層の providers（2.x の形、settings.baseURL）。
 */
async function serveStarting(o: { providerRowsAfter: number; rows: { id: string; baseURL?: string }[]; configProviders: Record<string, unknown> }): Promise<{ serve: ServeInfo; providerAsks: () => number }> {
  let asks = 0;
  server = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    res.setHeader('content-type', 'application/json');
    if (p === '/api/config') {
      res.end(JSON.stringify([{ type: 'document', info: { model: { providerID: 'lmstudio', model: 'gemma' }, providers: o.configProviders } }, { type: 'directory' }]));
    } else if (p === '/api/model') {
      res.end(JSON.stringify({ data: [{ providerID: 'lmstudio', id: 'gemma', name: 'Gemma', limit: { context: 131_072 } }] }));
    } else if (p === '/api/provider') {
      asks++;
      res.end(JSON.stringify({ data: asks > o.providerRowsAfter ? o.rows.map((r) => ({ id: r.id, name: r.id, ...(r.baseURL ? { settings: { baseURL: r.baseURL } } : {}) })) : [] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { serve: { url: `http://127.0.0.1:${port}`, password: 'pw', port, pid: 1 } as unknown as ServeInfo, providerAsks: () => asks };
}

/** LM Studio の偽物。gemma は手で 8192 に載せてある。 */
function fakeLm() {
  const calls: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${init?.method ?? 'GET'} ${u.host}${u.pathname}`);
    if (u.pathname === '/api/v1/models') {
      return Response.json({ models: [{ type: 'llm', key: 'gemma', size_bytes: 15 * GB, max_context_length: 262_144, loaded_instances: [{ id: 'gemma', config: { context_length: 8192 } }] }] });
    }
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

const preps = new LaunchPreps({ broadcast: () => undefined });
const local = (f: typeof fetch): LocalModelsDeps => ({ home, context: () => 65_536, isRunning: () => false, totalmem: () => 64 * GB, fetch: f });
const deps = (sleeps: number[]): MaterializeDeps => ({
  serves: {} as MaterializeDeps['serves'],
  report: () => undefined,
  sleep: async (ms) => { sleeps.push(ms); },
});
const spec = () => ({ cwd: home, instructions: [], mcp: { url: 'http://x', secret: 's' }, hangarSessionId: 'h1', env: {}, prep: { run: preps.begin(undefined), choice: {} } });

describe('prepareModels（起きたばかりの serve）', () => {
  it('/api/provider がまだ空でも、設定の層の baseURL から LM Studio を見つけ、手で短く載せたモデルについて聞く', async () => {
    const { serve } = await serveStarting({ providerRowsAfter: Infinity, rows: [], configProviders: { lmstudio: { name: 'LM Studio (local)', settings: { apiKey: 'x', baseURL: LM } } } });
    const lm = fakeLm();
    await expect(prepareModels(deps([]), local(lm.f), serve, spec())).rejects.toBeInstanceOf(LaunchPrepAsked);
    expect(lm.calls).toEqual(['GET 127.0.0.1:1234/api/v1/models']);
  });

  it('1.x の書き方（provider と options.baseURL）の層も読む', async () => {
    const { serve } = await serveStarting({ providerRowsAfter: Infinity, rows: [], configProviders: {} });
    server!.removeAllListeners('request');
    server!.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      res.setHeader('content-type', 'application/json');
      if (p === '/api/config') res.end(JSON.stringify([{ info: { model: 'lmstudio/gemma', provider: { lmstudio: { options: { baseURL: LM } } } } }]));
      else if (p === '/api/model') res.end(JSON.stringify({ data: [{ providerID: 'lmstudio', id: 'gemma', limit: { context: 131_072 } }] }));
      else res.end(JSON.stringify({ data: [] }));
    });
    const lm = fakeLm();
    await expect(prepareModels(deps([]), local(lm.f), serve, spec())).rejects.toBeInstanceOf(LaunchPrepAsked);
    expect(lm.calls).toEqual(['GET 127.0.0.1:1234/api/v1/models']);
  });

  it('設定に baseURL の無い接続先（opencode に組み込みの宛先）は、/api/provider に行が出るまで短く聞き直す', async () => {
    const { serve, providerAsks } = await serveStarting({ providerRowsAfter: 2, rows: [{ id: 'lmstudio', baseURL: LM }], configProviders: {} });
    const lm = fakeLm();
    const sleeps: number[] = [];
    await expect(prepareModels(deps(sleeps), local(lm.f), serve, spec())).rejects.toBeInstanceOf(LaunchPrepAsked);
    expect(providerAsks()).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(lm.calls).toEqual(['GET 127.0.0.1:1234/api/v1/models']);
  });

  it('行も baseURL も出ない接続先は、待ちの上限で諦め、LM Studio に触らずに返る', async () => {
    const { serve } = await serveStarting({ providerRowsAfter: Infinity, rows: [], configProviders: {} });
    const lm = fakeLm();
    const sleeps: number[] = [];
    await prepareModels(deps(sleeps), local(lm.f), serve, spec());
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3000);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(lm.calls).toEqual([]);
  });
});
