import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchSpec } from '../../agent/types.ts';
import { materializeOpencode, type MaterializeDeps } from './launch.ts';
import { ORCHESTRATOR_OPENCODE_RULES, type OpencodePermissionRule } from './permissionPreset.ts';
import type { ServeInfo } from './serve/manager.ts';

/**
 * 統括の opencode（LaunchSpec.handsOff）の下ごしらえ。
 * 統括の規則は、許可のひな形と利用者の規則の有無にかかわらず、serve の設定と会話の permissions の両方に重ねる。
 * 会話の permissions は opencode が agent の規則（利用者の agent ごとの規則を含む）より後に照らすので、利用者の規則に勝つ。
 */
let server: http.Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => { server ? server.close(() => r()) : r(); });
  server = null;
});

type Seen = { method: string; path: string; body: unknown };
async function fakeServe(o: { patchStatus?: number } = {}): Promise<{ serve: ServeInfo; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      seen.push({ method: req.method ?? '', path: p, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && p === '/api/session') res.end(JSON.stringify({ data: { id: 'ses_new' } }));
      else if (req.method === 'PATCH' && p.startsWith('/api/session/')) { res.statusCode = o.patchStatus ?? 200; res.end('{}'); }
      else if (p === '/api/mcp') res.end(JSON.stringify({ data: [{ name: 'hangar', status: { status: 'connected' } }] }));
      else res.end('{}');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { serve: { url: `http://127.0.0.1:${port}`, password: 'pw', port, pid: 1 } as unknown as ServeInfo, seen };
}

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  cwd: '/h/orchestrator',
  hangarSessionId: 'h1',
  mcp: { url: 'http://127.0.0.1:4177/mcp/s/h1', secret: 'run-secret' },
  instructions: [],
  env: {},
  ...over,
});

const PRESET: OpencodePermissionRule[] = [{ action: 'shell', resource: '*', effect: 'ask' }];

function depsOf(serve: ServeInfo, configs: string[]): MaterializeDeps {
  return {
    serves: { ensure: async (_id, o) => { configs.push(o?.configContent ?? ''); return serve; }, get: () => serve, stop: async () => undefined },
    permissions: () => PRESET,
    report: () => undefined,
    sleep: async () => undefined,
  };
}

describe('ORCHESTRATOR_OPENCODE_RULES', () => {
  it('全部を断ってから hangar の MCP の道具だけを通す（後に書いた規則が勝つ）', () => {
    expect(ORCHESTRATOR_OPENCODE_RULES[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(ORCHESTRATOR_OPENCODE_RULES.at(-1)).toEqual({ action: 'hangar_*', resource: '*', effect: 'allow' });
  });
});

describe('materializeOpencode の統括', () => {
  it('新しい会話は、統括の規則を serve の設定と会話の作成の両方に載せ、ひな形は使わない', async () => {
    const { serve, seen } = await fakeServe();
    const configs: string[] = [];
    const r = await materializeOpencode(depsOf(serve, configs), { kind: 'start' }, spec({ handsOff: true }));
    expect(r.providerSessionId).toBe('ses_new');
    expect(JSON.parse(configs[0]!).permissions).toEqual(ORCHESTRATOR_OPENCODE_RULES);
    const create = seen.find((s) => s.method === 'POST' && s.path === '/api/session');
    expect((create?.body as { permissions?: unknown }).permissions).toEqual(ORCHESTRATOR_OPENCODE_RULES);
  });

  it('再開では、会話の permissions を統括の規則に当て直す', async () => {
    const { serve, seen } = await fakeServe();
    const configs: string[] = [];
    await materializeOpencode(depsOf(serve, configs), { kind: 'resume', id: 'ses_1' }, spec({ handsOff: true }));
    expect(JSON.parse(configs[0]!).permissions).toEqual(ORCHESTRATOR_OPENCODE_RULES);
    const patch = seen.find((s) => s.method === 'PATCH' && s.path === '/api/session/ses_1');
    expect(patch?.body).toEqual({ permissions: ORCHESTRATOR_OPENCODE_RULES });
  });

  it('再開で会話の permissions を当て直せなければ、起こさずに断る', async () => {
    const { serve } = await fakeServe({ patchStatus: 500 });
    await expect(materializeOpencode(depsOf(serve, []), { kind: 'resume', id: 'ses_1' }, spec({ handsOff: true }))).rejects.toThrow();
  });

  it('統括でない会話は今までどおり、ひな形を serve に重ね、会話の permissions は送らない', async () => {
    const { serve, seen } = await fakeServe();
    const configs: string[] = [];
    await materializeOpencode(depsOf(serve, configs), { kind: 'start' }, spec());
    expect(JSON.parse(configs[0]!).permissions).toEqual(PRESET);
    const create = seen.find((s) => s.method === 'POST' && s.path === '/api/session');
    expect(create?.body).not.toHaveProperty('permissions');
    await materializeOpencode(depsOf(serve, []), { kind: 'resume', id: 'ses_2' }, spec());
    expect(seen.some((s) => s.method === 'PATCH')).toBe(false);
  });
});
