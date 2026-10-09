import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { MemoStore } from '../projects/memo.ts';
import { assignSessions } from '../projects/registry.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { createMcpApp } from './app.ts';
import { TOOL_NAMES } from './tools.ts';

let dir: string;
let home: string;
let db: Db;
let alphaId: string;
let app: ReturnType<typeof createMcpApp>;
const TOKEN = 'tok';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

beforeEach(async () => {
  dir = copyFixtureClaudeDir();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcpapp-'));
  db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  app = createMcpApp({ db, deviceId: 'd', port: 4177, token: TOKEN, live: () => [], runs: { start: () => { throw new Error('not in this test'); } },
    usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), memos: new MemoStore({ db, deviceId: 'd', home }) });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

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
  it('propose_session_status の説明文は、聞かずに confirmed を立てないよう求める', async () => {
    const list = await rpc('/', 'tools/list', {}, 6);
    const tools = list.body.result!.tools as { name: string; description: string }[];
    expect(tools.find((t) => t.name === 'propose_session_status')!.description).toBe('agent-hangar: このセッションの状態（Done か Paused）を提案する。利用者が会話の中で選んだときだけ confirmed を true にする。利用者に聞かずに true にしてはいけない。');
  });
  it('propose_session_status の引数には説明が載る', async () => {
    const list = await rpc('/', 'tools/list', {}, 7);
    const tools = list.body.result!.tools as { name: string; inputSchema: { properties: Record<string, { description?: string }> } }[];
    const props = tools.find((t) => t.name === 'propose_session_status')!.inputSchema.properties;
    expect(props.note!.description).toBe('根拠の一文。必須（1〜200 字）');
    expect(props.return_on!.description).toBe('戻る日。YYYY-MM-DD（手元の暦。過去の日は不可）。paused では必須');
    expect(props.return_time!.description).toBe('戻る時刻。HH:MM（24 時間、00:00〜23:59、手元の時刻）。確かめる時刻に意味があるときだけ渡す。省くと「その日のうち」になる。return_on と合わせて過去になる時点は不可');
    expect(props.confirmed!.description).toBe('利用者が会話の中で選んだときだけ true');
  });
  it('search_sessions は provider を引数に持たず、古い呼び手が渡しても断らない', async () => {
    const list = await rpc('/', 'tools/list', {}, 8);
    const tools = list.body.result!.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    expect(Object.keys(tools.find((t) => t.name === 'search_sessions')!.inputSchema.properties).sort()).toEqual(['file', 'limit', 'project_id', 'query', 'since', 'until']);
    const r = await rpc('/', 'tools/call', { name: 'search_sessions', arguments: { query: 'チャンネル', provider: 'claude-code' } }, 9);
    expect(r.body.result!.isError).toBeUndefined();
    const content = r.body.result!.content as { text: string }[];
    expect(JSON.parse(content[0]!.text).hits.length).toBeGreaterThan(0);
  });
});

describe('言語', () => {
  let language: 'ja' | 'en';
  const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;
  const textOf = (r: Awaited<ReturnType<typeof rpc>>) => (r.body.result!.content as { text: string }[])[0]!.text;
  beforeEach(() => {
    language = 'en';
    app = createMcpApp({ db, deviceId: 'd', port: 4177, token: TOKEN, live: () => [], runs: { start: () => { throw new Error('not in this test'); } },
      usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), memos: new MemoStore({ db, deviceId: 'd', home }), language: () => language });
  });

  it('英語では、道具の説明と引数の説明がすべて英語になる', async () => {
    const list = await rpc('/', 'tools/list', {}, 2);
    const tools = list.body.result!.tools as { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.description, t.name).toMatch(/^agent-hangar: [A-Z]/);
      expect(JAPANESE.test(JSON.stringify(t)), t.name).toBe(false);
    }
    const propose = tools.find((t) => t.name === 'propose_session_status')!;
    expect(propose.description).toBe('agent-hangar: Suggests a status for this session (Done or Paused). Set confirmed to true only when the user chose it in the conversation. Never set it to true without asking the user.');
    expect(propose.inputSchema.properties.return_on!.description).toBe('Reminder date. YYYY-MM-DD (local calendar; past dates are not allowed). Required for paused');
  });

  it('英語では、道具の失敗が英語で返り、下の層の検査の文も同じ言語で出る', async () => {
    const missing = await rpc('/', 'tools/call', { name: 'get_project', arguments: { project_id: 'nope' } }, 3);
    expect(missing.body.result!.isError).toBe(true);
    expect(textOf(missing)).toBe('Project not found: nope');
    expect(textOf(await rpc('/', 'tools/call', { name: 'update_project', arguments: { project_id: 'p1', propose_done: [{ todo_id: 'x', note: ' ' }] } }, 4))).toBe('The note (one-sentence reason) in propose_done is empty');
    expect(textOf(await rpc(`/s/${alphaId}`, 'tools/call', { name: 'propose_session_status', arguments: { status: 'paused', note: 'x' } }, 5))).toBe('Paused needs a reminder date');
    expect(textOf(await rpc(`/s/${alphaId}`, 'tools/call', { name: 'get_transcript', arguments: { session_id: 'other' } }, 6))).toBe(`This MCP URL is for session ${alphaId} only. You cannot specify another session_id`);
  });

  it('言語は要求のたびに読む', async () => {
    const call = () => rpc('/', 'tools/call', { name: 'get_project', arguments: { project_id: 'nope' } }, 7);
    expect(textOf(await call())).toBe('Project not found: nope');
    language = 'ja';
    expect(textOf(await call())).toBe('プロジェクトが見つかりません: nope');
  });
});
