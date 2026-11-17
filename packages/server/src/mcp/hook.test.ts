import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { claudeAsks } from '../provider/claude-code/hooks/asks.ts';
import { issueMcpSecret } from '../runs/secrets.ts';
import { HookDecisions } from '../sessions/hookDecisions.ts';
import { PermissionAsks } from '../sessions/permissionAsks.ts';
import { createMcpApp } from './app.ts';
import { agentsOf } from '../agent/agents.ts';
import { upsertShared } from '../db/shared.ts';
import { createOpencodeDriver } from '../provider/opencode/driver.ts';

/**
 * hook の受け口（/mcp/s/<id>/hook）。
 * hangar が起こした claude は、run の秘密だけを持っている。受け口はその秘密で開き、ほかのセッションの入口は開かない。
 */
let home: string;
let db: Db;
let sid: string;
let app: ReturnType<typeof createMcpApp>;
let asks: PermissionAsks;
let decisions: HookDecisions;
const TOKEN = 'main-token';
const pre = { session_id: 'u1', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '色は？' }] }, tool_use_id: 't1' };
const post = (secret: string, body: unknown, id = sid) => app.request(`/s/${id}/hook`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const question = () => (db.prepare('select question from session_activity where session_id = ?').get(sid) as { question: string | null } | undefined)?.question;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-hook-'));
  db = openDb(':memory:');
  sid = ensureSession(db, 'u1', '/w', 'd');
  asks = new PermissionAsks();
  decisions = new HookDecisions();
  app = createMcpApp({ db, deviceId: 'd', port: 4177, token: TOKEN, live: () => [], runs: { start: () => { throw new Error('not in this test'); } },
    usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), permissionAsks: asks, hookDecisions: decisions, asksOf: () => claudeAsks });
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

  it('許可の確認（PermissionRequest）は、許可待ちの中身として預け、待ちの id を 200 で返す（待ちの表が無ければ 204）', async () => {
    const secret = issueMcpSecret(db, sid, 1);
    const r = await post(secret, { session_id: 'u1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test', description: '試験' } });
    expect(r.status).toBe(200);
    const l = asks.apply([{ sessionId: 'u1', status: 'waiting', name: null, nameSource: null, cwd: '/w', pid: 1 }], Date.now())[0];
    expect(l?.permission).toEqual({ tool: 'Bash', input: 'npm test', description: '試験' });
  });

  it('opencode の会話の hook は、driver が読まないので何も書かずに 204 を返す（投げない）', async () => {
    const oc = createOpencodeDriver({ serves: () => null, droppedEnv: [] });
    app = createMcpApp({ db, deviceId: 'd', port: 4177, token: TOKEN, live: () => [], runs: { start: () => { throw new Error('not in this test'); } },
      usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), permissionAsks: asks, asksOf: (p) => agentsOf([oc]).of(p).asks });
    upsertShared(db, 'sessions', { id: 'h-oc', provider: 'opencode', provider_session_id: 'ses_1', cwd: '/w', home_device: 'd' }, 'd');
    const secret = issueMcpSecret(db, 'h-oc', 1);
    const r = await post(secret, pre, 'h-oc');
    expect(r.status).toBe(204);
    expect(db.prepare('select question from session_activity where session_id = ?').get('h-oc')).toBeUndefined();
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

describe('hook の受け口：答えの待ち（PermissionRequest の同期の hook）', () => {
  const perm = { session_id: 'u1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } };
  const decision = (secret: string, body: unknown, id = sid) => app.request(`/s/${id}/decision`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('許可の確認は待ちを開け、id を 200 で返す。/decision が、決めた答えを返す', async () => {
    const secret = issueMcpSecret(db, sid, 1);
    const r = await post(secret, perm);
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    expect(await (await decision(secret, { id, waitMs: 20 })).json()).toEqual({ t: 'pending' });
    decisions.decide(sid, { kind: 'permission', tool: 'Bash', input: 'npm test' }, { kind: 'permission', behavior: 'allow' });
    expect(await (await decision(secret, { id, waitMs: 20 })).json()).toEqual({ t: 'answer', output: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } });
  });

  it('許可待ちの中身の預けは今までどおり行う', async () => {
    const secret = issueMcpSecret(db, sid, 1);
    await post(secret, perm);
    expect(asks.apply([{ sessionId: 'u1', status: 'waiting', name: null, nameSource: null, cwd: '/w', pid: 1 }], Date.now())[0]?.permission).toMatchObject({ tool: 'Bash', input: 'npm test' });
  });

  it('画面で先に問いに答えられたら（PostToolUse）、待ちが閉じて gone を返す', async () => {
    const secret = issueMcpSecret(db, sid, 1);
    const uq = { session_id: 'u1', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '色は？' }] } };
    const { id } = (await (await post(secret, uq)).json()) as { id: string };
    await post(secret, { ...pre, hook_event_name: 'PostToolUse' });
    expect(await (await decision(secret, { id, waitMs: 20 })).json()).toEqual({ t: 'gone' });
  });

  it('hook の会話がそのセッションのものでなければ待ちを開けない（204）', async () => {
    const secret = issueMcpSecret(db, sid, 1);
    expect((await post(secret, { ...perm, session_id: 'other' })).status).toBe(204);
  });

  it('/decision は鍵が違えば 401、別のセッションの待ちは gone', async () => {
    const secret = issueMcpSecret(db, sid, 1);
    const { id } = (await (await post(secret, perm)).json()) as { id: string };
    expect((await decision('wrong', { id })).status).toBe(401);
    const other = ensureSession(db, 'u2', '/w', 'd');
    const secret2 = issueMcpSecret(db, other, 1);
    expect(await (await decision(secret2, { id, waitMs: 10 }, other)).json()).toEqual({ t: 'gone' });
  });
});
