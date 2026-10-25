import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { claudeAsks } from '../provider/claude-code/hooks/asks.ts';
import { issueMcpSecret } from '../runs/secrets.ts';
import { PermissionAsks } from '../sessions/permissionAsks.ts';
import { createMcpApp } from './app.ts';

/**
 * hook の受け口（/mcp/s/<id>/hook）。
 * hangar が起こした claude は、run の秘密だけを持っている。受け口はその秘密で開き、ほかのセッションの入口は開かない。
 */
let home: string;
let db: Db;
let sid: string;
let app: ReturnType<typeof createMcpApp>;
let asks: PermissionAsks;
const TOKEN = 'main-token';
const pre = { session_id: 'u1', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '色は？' }] }, tool_use_id: 't1' };
const post = (secret: string, body: unknown, id = sid) => app.request(`/s/${id}/hook`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const question = () => (db.prepare('select question from session_activity where session_id = ?').get(sid) as { question: string | null } | undefined)?.question;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-hook-'));
  db = openDb(':memory:');
  sid = ensureSession(db, 'u1', '/w', 'd');
  asks = new PermissionAsks();
  app = createMcpApp({ db, deviceId: 'd', port: 4177, token: TOKEN, live: () => [], runs: { start: () => { throw new Error('not in this test'); } },
    usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), permissionAsks: asks, asksOf: () => claudeAsks });
});
afterEach(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });

describe('hook の受け口', () => {
  it('run の秘密で開き、問いの文を書いて 204 を返す', async () => {
    const secret = issueMcpSecret(db, sid, 1);
    const r = await post(secret, pre);
    expect(r.status).toBe(204);
    expect(question()).toBe('色は？');
    expect((await post(secret, { ...pre, hook_event_name: 'PostToolUse' })).status).toBe(204);
    expect(question()).toBeNull();
  });

  it('許可の確認（PermissionRequest）は、許可待ちの中身として預けて 204 を返す', async () => {
    const secret = issueMcpSecret(db, sid, 1);
    const r = await post(secret, { session_id: 'u1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test', description: '試験' } });
    expect(r.status).toBe(204);
    const l = asks.apply([{ sessionId: 'u1', status: 'waiting', name: null, nameSource: null, cwd: '/w', pid: 1 }], Date.now())[0];
    expect(l?.permission).toEqual({ tool: 'Bash', input: 'npm test', description: '試験' });
  });

  it('鍵が無いか違えば 401 で、何も書かない', async () => {
    issueMcpSecret(db, sid, 1);
    expect((await post('wrong', pre)).status).toBe(401);
    const other = ensureSession(db, 'u2', '/w', 'd');
    const otherSecret = issueMcpSecret(db, other, 1);
    expect((await post(otherSecret, pre)).status).toBe(401);
    expect(question()).toBeUndefined();
  });

  it('読めない本文は 400、関係の無い出来事は書かずに 204', async () => {
    const secret = issueMcpSecret(db, sid, 1);
    expect((await post(secret, '{not json')).status).toBe(400);
    expect((await post(secret, { ...pre, tool_name: 'Bash' })).status).toBe(204);
    expect(question()).toBeUndefined();
  });

  it('本文はセッションの provider の driver の asks で読み、読む口の無いエージェントでは何も書かない', async () => {
    const seen: string[] = [];
    app = createMcpApp({ db, deviceId: 'd', port: 4177, token: TOKEN, live: () => [], runs: { start: () => { throw new Error('not in this test'); } },
      usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), permissionAsks: asks,
      asksOf: (provider) => { seen.push(provider); return provider === 'claude-code' ? claudeAsks : {}; } });
    const secret = issueMcpSecret(db, sid, 1);
    expect((await post(secret, pre)).status).toBe(204);
    expect(seen).toEqual(['claude-code']);
    expect(question()).toBe('色は？');
    db.prepare("update sessions set provider = 'opencode' where id = ?").run(sid);
    expect((await post(secret, { ...pre, hook_event_name: 'PostToolUse' })).status).toBe(204);
    expect(seen).toEqual(['claude-code', 'opencode']);
    expect(question()).toBe('色は？');
  });
});
