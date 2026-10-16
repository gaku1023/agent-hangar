import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeOut } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

/**
 * 引き継ぎの頼み（takeovers）と応答（takeover_answers）を、Worker が共有表として受けて返せること。
 * Worker に新しい経路は足していない。行は POST /changes と GET /changes で運ぶ。
 */
const SECRET = 'join-secret-takeover';

let cloud: CloudHarness;
let tokA = '';
let tokB = '';

const join = async (id: string): Promise<string> => {
  const r = await cloud.SELF.fetch('https://x/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }),
  });
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

const push = (tok: string, changes: unknown): Promise<Response> =>
  cloud.SELF.fetch('https://x/changes', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ changes }),
  });

const pull = async (tok: string): Promise<{ changes: ChangeOut[] }> =>
  (await (await cloud.SELF.fetch('https://x/changes?since=0', { headers: { authorization: `Bearer ${tok}` } })).json()) as { changes: ChangeOut[] };

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  tokA = await join('pc-a');
  tokB = await join('pc-b');
});

afterEach(async () => {
  await cloud.dispose();
  resetSchemaCache();
});

describe('共有表 takeovers と takeover_answers', () => {
  it('POST /changes は takeovers と takeover_answers の行を受け、GET /changes で相手に渡す', async () => {
    const ask = {
      tableName: 'takeovers', rowId: 'ask-1', op: 'upsert', updatedAt: 100,
      payload: { id: 'ask-1', session_id: 's1', run_id: 'r1', target_device: 'pc-b', from_device: 'pc-a', requested_at: 100, mode: 'ask', cancelled_at: null, updated_at: 100, deleted_at: null, origin_device: 'pc-a' },
    };
    const answer = {
      tableName: 'takeover_answers', rowId: 'ask-1', op: 'upsert', updatedAt: 200,
      payload: { ask_id: 'ask-1', run_id: 'r1', result: 'stopped', answered_at: 200, transcript_sha256: 'a'.repeat(64), transcript_size: 42, updated_at: 200, deleted_at: null, origin_device: 'pc-b' },
    };
    const pushA = await push(tokA, [ask]);
    const pushB = await push(tokB, [answer]);
    expect(pushA.status).toBe(200);
    expect(pushB.status).toBe(200);
    const forB = await pull(tokB);
    expect(forB.changes.map((c) => c.tableName)).toContain('takeovers');
    expect(forB.changes.find((c) => c.tableName === 'takeovers')?.payload).toEqual(ask.payload);
    const forA = await pull(tokA);
    expect(forA.changes.map((c) => c.tableName)).toContain('takeover_answers');
    expect(forA.changes.find((c) => c.tableName === 'takeover_answers')?.payload).toEqual(answer.payload);
  });
});
