import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions } from '../projects/registry.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { createMcpApp } from './app.ts';
import { TOOL_NAMES } from './tools.ts';

let dir: string;
let db: Db;
let alphaId: string;
let app: ReturnType<typeof createMcpApp>;
const TOKEN = 'tok';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

beforeEach(async () => {
  dir = copyFixtureClaudeDir();
  db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  app = createMcpApp({ db, deviceId: 'd', port: 4177, token: TOKEN, live: () => [], hub: { broadcast: () => {} }, runs: { start: () => { throw new Error('not in this test'); } } });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** JSON でも SSE でも 1 件目の JSON-RPC 応答を取り出す。 */
async function rpc(path: string, method: string, params: unknown, id = 1, headers: Record<string, string> = H): Promise<{ status: number; body: { result?: Record<string, unknown>; error?: { message: string } } }> {
  const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: {} };
  const ct = res.headers.get('content-type') ?? '';
  const json = ct.includes('text/event-stream') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())[0]! : text;
  return { status: res.status, body: JSON.parse(json) };
}
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } };

describe('createMcpApp', () => {
  it('認証：トークン無しは 401、Origin 違いは 403', async () => {
    expect((await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await app.request('/', { method: 'POST', headers: { ...H, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
  });
  it('Origin 無しは通し、開発用の 5173 は通さない', async () => {
    // MCP クライアントは Origin を送らないので、無い要求を弾いてはいけない。
    expect((await rpc('/', 'initialize', INIT)).status).toBe(200);
    expect((await rpc('/', 'initialize', INIT, 1, { ...H, origin: 'http://127.0.0.1:4177' })).status).toBe(200);
    expect((await app.request('/', { method: 'POST', headers: { ...H, origin: 'http://localhost:5173' }, body: '{}' })).status).toBe(403);
  });
  it('initialize と tools/list', async () => {
    const init = await rpc('/', 'initialize', INIT);
    expect(init.status).toBe(200);
    expect((init.body.result!.serverInfo as { name: string }).name).toBe('agent-hangar');
    const list = await rpc('/', 'tools/list', {}, 2);
    const tools = list.body.result!.tools as { name: string; description: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    // 説明文は先頭が `agent-hangar:` である。含むだけの検査では、途中に紛れ込んでも通ってしまう。
    for (const t of tools) expect(t.description, t.name).toMatch(/^agent-hangar:/);
  });
  it('tools/call は結果を text に包む', async () => {
    const r = await rpc('/', 'tools/call', { name: 'list_projects', arguments: {} }, 3);
    const content = r.body.result!.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)[0].name).toBe('alpha');
    const bad = await rpc('/', 'tools/call', { name: 'get_project', arguments: { project_id: 'nope' } }, 4);
    expect(bad.body.result!.isError).toBe(true);
  });
  it('セッション別 URL では session_id を省ける。無いセッションは 404', async () => {
    const r = await rpc(`/s/${alphaId}`, 'tools/call', { name: 'set_session_memo', arguments: { text: 'from mcp' } }, 5);
    expect(JSON.parse((r.body.result!.content as { text: string }[])[0]!.text)).toEqual({ ok: true, session_id: alphaId });
    expect((db.prepare('select memo from sessions where id = ?').get(alphaId) as { memo: string }).memo).toBe('from mcp');
    expect((await app.request('/s/nope', { method: 'POST', headers: H, body: '{}' })).status).toBe(404);
  });
});
