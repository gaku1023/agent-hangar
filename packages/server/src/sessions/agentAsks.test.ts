import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { routeAgentAsk } from './agentAsks.ts';
import { PermissionAsks } from './permissionAsks.ts';

let db: Db;
let oc: string;
let put: string[];
let asks: PermissionAsks;
beforeEach(() => {
  db = openDb(':memory:');
  oc = ensureSession(db, 'ses_oc1', '/w', 'd', 'opencode');
  ensureSession(db, 'u1', '/w', 'd');
  put = [];
  asks = new PermissionAsks(() => { put.push('kick'); });
});
afterEach(() => { db.close(); });

const questionOf = () => db.prepare('select tool, tool_id, question from session_activity where session_id = ?').get(oc);

describe('routeAgentAsk（流れてきた許可と問いを書く）', () => {
  it('問いは、そのエージェントの会話の行に書き、答えたら外す', () => {
    expect(routeAgentAsk(db, 'opencode', { kind: 'question', providerSessionId: 'ses_oc1', hook: { kind: 'asked', providerSessionId: 'ses_oc1', toolId: 'call_q', summary: '色は？', question: '色は？' } }, asks, 1)).toBe(true);
    expect(questionOf()).toEqual({ tool: 'AskUserQuestion', tool_id: 'call_q', question: '色は？' });
    expect(routeAgentAsk(db, 'opencode', { kind: 'question', providerSessionId: 'ses_oc1', hook: { kind: 'answered', providerSessionId: 'ses_oc1', toolId: 'call_q' } }, asks, 2)).toBe(true);
    expect(questionOf()).toEqual({ tool: 'AskUserQuestion', tool_id: 'call_q', question: null });
  });

  it('許可は預け、実行中の一覧の読み直しを繰り上げる', () => {
    expect(routeAgentAsk(db, 'opencode', { kind: 'permission', providerSessionId: 'ses_oc1', ask: { tool: 'shell', input: 'echo hi', description: null } }, asks, 1)).toBe(true);
    expect(put).toEqual(['kick']);
    const [l] = asks.apply([{ sessionId: 'ses_oc1', status: 'waiting', waitingFor: 'permission', name: null, nameSource: null, cwd: '/w', pid: 1, agent: 'opencode' }], 1);
    expect(l!.permission).toEqual({ tool: 'shell', input: 'echo hi', description: null });
  });

  it('知らない会話と、ほかのエージェントの会話には書かない', () => {
    expect(routeAgentAsk(db, 'opencode', { kind: 'question', providerSessionId: 'ses_none', hook: { kind: 'asked', providerSessionId: 'ses_none', toolId: 't', summary: 's', question: 'q' } }, asks, 1)).toBe(false);
    expect(routeAgentAsk(db, 'opencode', { kind: 'permission', providerSessionId: 'u1', ask: { tool: 'shell', input: 'x', description: null } }, asks, 1)).toBe(false);
    expect(put).toEqual([]);
    expect(questionOf()).toBeUndefined();
  });
});
