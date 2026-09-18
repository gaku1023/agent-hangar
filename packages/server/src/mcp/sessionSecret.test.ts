import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { authMiddleware } from '../http/auth.ts';
import { IndexerService } from '../indexer/service.ts';
import { MemoStore } from '../projects/memo.ts';
import { assignSessions } from '../projects/registry.ts';
import { issueMcpSecret, mcpSecretFor, revokeMcpSecret } from '../runs/secrets.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { createMcpApp } from './app.ts';

/**
 * 閉じ込めの要。
 * run に配る秘密は、その run のセッションの入口だけを開ける。
 * 本体のトークンを claude に渡してしまうと、claude は自分の --mcp-config を読んで共通 /mcp に回れる。
 */

let dir: string;
let home: string;
let db: Db;
let alphaId: string;
let app: ReturnType<typeof createMcpApp>;
let api: Hono;
const TOKEN = 'main-token';
const PORT = 4177;
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
const headers = (secret: string) => ({ authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });

beforeEach(async () => {
  dir = copyFixtureClaudeDir();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcpsecret-'));
  db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  app = createMcpApp({ db, deviceId: 'd', port: PORT, token: TOKEN, live: () => [], hub: { broadcast: () => {} }, runs: { start: () => { throw new Error('not in this test'); } },
    usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), memos: new MemoStore({ db, deviceId: 'd', home }) });
  // /api は本体のトークンだけを見る。MCP と同じ入口の検査を通す。
  api = new Hono();
  api.use('*', authMiddleware(TOKEN, PORT));
  api.get('/bootstrap', (c) => c.json({ ok: true }));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

describe('セッション別の秘密', () => {
  it('自分の /mcp/s/<id> だけを通り、共通 /mcp も 401 になる', async () => {
    const secret = issueMcpSecret(db, alphaId, 1);
    expect(secret).not.toBe(TOKEN);
    expect((await app.request(`/s/${alphaId}`, { method: 'POST', headers: headers(secret), body })).status).toBe(200);
    expect((await app.request('/', { method: 'POST', headers: headers(secret), body })).status).toBe(401);
  });
  it('/api は秘密を受け付けない', async () => {
    const secret = issueMcpSecret(db, alphaId, 1);
    expect((await api.request('/bootstrap', { headers: headers(secret) })).status).toBe(401);
    expect((await api.request('/bootstrap', { headers: headers(TOKEN) })).status).toBe(200);
  });
  it('他のセッションの入口は、その秘密では開かない', async () => {
    const other = (db.prepare('select id from sessions where id <> ?').get(alphaId) as { id: string }).id;
    const secret = issueMcpSecret(db, alphaId, 1);
    issueMcpSecret(db, other, 1);
    expect((await app.request(`/s/${other}`, { method: 'POST', headers: headers(secret), body })).status).toBe(401);
  });
  it('本体のトークンは共通にもセッション別にも通る', async () => {
    issueMcpSecret(db, alphaId, 1);
    expect((await app.request('/', { method: 'POST', headers: headers(TOKEN), body })).status).toBe(200);
    expect((await app.request(`/s/${alphaId}`, { method: 'POST', headers: headers(TOKEN), body })).status).toBe(200);
  });
  it('無効にした秘密はもう通らない', async () => {
    const secret = issueMcpSecret(db, alphaId, 1);
    expect(mcpSecretFor(db, alphaId)).toBe(secret);
    revokeMcpSecret(db, alphaId);
    expect(mcpSecretFor(db, alphaId)).toBeNull();
    expect((await app.request(`/s/${alphaId}`, { method: 'POST', headers: headers(secret), body })).status).toBe(401);
  });
  it('秘密を出し直すと前の秘密は通らない', async () => {
    const first = issueMcpSecret(db, alphaId, 1);
    const second = issueMcpSecret(db, alphaId, 2);
    expect(second).not.toBe(first);
    expect((await app.request(`/s/${alphaId}`, { method: 'POST', headers: headers(first), body })).status).toBe(401);
    expect((await app.request(`/s/${alphaId}`, { method: 'POST', headers: headers(second), body })).status).toBe(200);
  });
});
