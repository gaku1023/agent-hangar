import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PullChangesResponse, SnapshotResponse } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

/**
 * 引き継ぎの頼み（takeovers）と応答（takeover_answers）を、Worker が共有表として受けて返せること。
 * Worker に新しい経路は足していない。行は POST /changes と GET /changes で運ぶ。
 * 同期の版 6 から、Worker は rows に連番を振って差分を引く。引き継ぎの 2 表も同じ番号で運ぶ（互換の版 6 に含めた）。
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

const pull = async (tok: string, since = 0): Promise<PullChangesResponse> =>
  (await (await cloud.SELF.fetch(`https://x/changes?since=${since}`, { headers: { authorization: `Bearer ${tok}` } })).json()) as PullChangesResponse;

const snapshot = async (tok: string): Promise<SnapshotResponse> =>
  (await (await cloud.SELF.fetch('https://x/rows', { headers: { authorization: `Bearer ${tok}` } })).json()) as SnapshotResponse;

const askRow = (updatedAt: number, cancelledAt: number | null = null) => ({
  tableName: 'takeovers', rowId: 'ask-1', op: 'upsert', updatedAt,
  payload: { id: 'ask-1', session_id: 's1', run_id: 'r1', target_device: 'pc-b', from_device: 'pc-a', requested_at: 100, mode: 'ask', cancelled_at: cancelledAt, updated_at: updatedAt, deleted_at: null, origin_device: 'pc-a' },
});
const answerRow = (updatedAt: number) => ({
  tableName: 'takeover_answers', rowId: 'ask-1', op: 'upsert', updatedAt,
  payload: { ask_id: 'ask-1', run_id: 'r1', result: 'stopped', answered_at: updatedAt, transcript_sha256: 'a'.repeat(64), transcript_size: 42, updated_at: updatedAt, deleted_at: null, origin_device: 'pc-b' },
});

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
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

  it('行は rows の連番で降り、書き換えた頼みは末尾の新しい番号で入り直し、古い書き込みは採らない', async () => {
    expect((await push(tokA, [askRow(100)])).status).toBe(200);
    const first = await pull(tokB);
    expect(first.changes).toHaveLength(1);
    const askSeq = first.changes[0]!.seq;
    expect(first.changes[0]).toMatchObject({ tableName: 'takeovers', rowId: 'ask-1', deviceId: 'pc-a' });
    expect(first.nextSeq).toBeGreaterThanOrEqual(askSeq);
    // 頼んだ側の生存は、pull の応答の peers で見える。
    expect(first.peers.map((p) => p.id)).toEqual(['pc-a', 'pc-b']);

    // 応答は自分の行なので、相手の次の pull にだけ降りる。
    expect((await push(tokB, [answerRow(200)])).status).toBe(200);
    const forA = await pull(tokA);
    expect(forA.changes.map((c) => c.tableName)).toEqual(['takeover_answers']);
    expect(forA.changes[0]!.seq).toBeGreaterThan(askSeq);

    // 取り下げは同じ行の書き換えで、区切りより後ろの番号で入り直す。
    expect((await push(tokA, [askRow(300, 300)])).status).toBe(200);
    const again = await pull(tokB, first.nextSeq);
    expect(again.changes).toHaveLength(1);
    expect(again.changes[0]).toMatchObject({ tableName: 'takeovers', rowId: 'ask-1' });
    expect(again.changes[0]!.seq).toBeGreaterThan(forA.changes[0]!.seq);
    expect(again.changes[0]!.payload).toMatchObject({ cancelled_at: 300 });

    // 遅れて届いた古い書き込みは採らない。
    expect((await push(tokA, [askRow(150)])).status).toBe(200);
    expect((await pull(tokB, again.nextSeq)).changes).toEqual([]);

    // 新しい PC の初回の取り込み（GET /rows）にも、2 表の今の行が入る。
    const snap = await snapshot(tokA);
    expect(snap.changes.map((c) => `${c.tableName}:${c.rowId}`).sort()).toEqual(['takeover_answers:ask-1', 'takeovers:ask-1']);
    expect(snap.changes.find((c) => c.tableName === 'takeovers')!.payload).toMatchObject({ cancelled_at: 300 });
  });
});
