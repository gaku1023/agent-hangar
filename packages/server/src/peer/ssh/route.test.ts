import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveEpochKeys,
  randomEpochKey,
  sealPeerLaunch,
  sealPeerResult,
  type LiveSessionDto,
  type PeerKeyring,
  type PeerLaunchApi,
  type PeerLaunchRequest,
  type PeerLaunchResult,
} from '@agent-hangar/shared';
import { openDb, type Db } from '../../db/open.ts';
import { ensureSession } from '../../indexer/write.ts';
import { getSpawn } from '../../sessions/spawns.ts';
import { PeerLaunchInbox } from '../launchInbox.ts';
import { PeerOutbox, getPeerRequest, recordPeerRequest } from '../outbox.ts';
import { PeerRelay } from '../relay.ts';
import { SshPeerInbox } from './inbox.ts';

/**
 * SSH の経路を、偽のトンネルで通して確かめる（受け入れ 17 の記録、20）。
 * 呼ぶ側（pc-a）の PeerOutbox は、トンネル越しの口で pc-b の /peer の受け口（SshPeerInbox）を叩く。
 * pc-b は SshPeerInbox の聞き手から PeerLaunchInbox を動かし、結果は PeerRelay が手元の口へ書く。
 */
const A = 'pc-a';
const B = 'pc-b';
const T0 = 1_800_000_000_000;

let dbA: Db;
let dbB: Db;
let clock: { t: number };
let ring: PeerKeyring;
let inbox: SshPeerInbox;
let tunnel: { up: boolean; connects: number };
let injected: string[];
let live: LiveSessionDto[];
let outbox: PeerOutbox;
let relay: PeerRelay;
let childId: string;
let callerId: string;
let reply: { text: string; ts: number | null } | null;
let dbs: Db[];

const entry = (sessionId: string, status: LiveSessionDto['status']): LiveSessionDto => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 1 });

/** トンネル越しの口。切れていれば fetch の失敗と同じ形で投げる。 */
function tunnelApi(): PeerLaunchApi {
  const guard = <T>(fn: () => Promise<T>): Promise<T> => (tunnel.up ? fn() : Promise.reject(new TypeError('fetch failed')));
  return {
    put: (body) => guard(async () => {
      const r = await inbox.put(A, { ...body, from: A });
      if (r === 'conflict') throw new Error('conflict');
      return r;
    }),
    outbox: (since) => guard(() => inbox.outbox(A, since)),
    results: (id, after) => guard(async () => {
      const r = await inbox.results(A, id, after);
      if (!r) throw new Error('not found');
      return r;
    }),
    claim: () => Promise.reject(new Error('unsupported')),
    answer: () => Promise.reject(new Error('unsupported')),
    postResult: () => Promise.reject(new Error('unsupported')),
  };
}

const request = (over: Partial<PeerLaunchRequest> = {}): PeerLaunchRequest => ({
  v: 1, createdAt: T0, parentSessionId: callerId, projectId: 'project-a', scratch: false, agent: 'claude-code', account: '', permissionMode: '', model: '', prompt: '調べて', ...over,
});

async function placeSsh(id = 'req-1'): Promise<void> {
  const sealed = await sealPeerLaunch(ring, { requestId: id, from: A, to: B }, request());
  await tunnelApi().put({ id, to: B, sealed, from: A });
  recordPeerRequest(dbA, { requestId: id, to: B, callerSessionId: callerId, now: clock.t, via: 'ssh' });
}

/** 受ける側が結果の行を書く（relay を通さない、連番だけの確かめ用）。 */
async function postResult(seq: number, text: string): Promise<void> {
  const body: PeerLaunchResult = { v: 1, at: clock.t, sessionId: childId, title: 'worker', reason: 'idle', summary: '', status: null, lastReply: text, truncated: false };
  await inbox.api.postResult('req-1', { seq, sealed: await sealPeerResult(ring, { requestId: 'req-1', from: A, to: B }, seq, body) });
}

beforeEach(async () => {
  dbA = openDb(':memory:');
  dbB = openDb(':memory:');
  dbs = [dbA, dbB];
  clock = { t: T0 };
  const keys = await deriveEpochKeys(1, randomEpochKey());
  ring = { current: () => keys, at: (n) => (n === 1 ? keys : null) };
  tunnel = { up: true, connects: 0 };
  injected = [];
  live = [];
  reply = null;
  callerId = ensureSession(dbA, 'u1', '/w', A);
  childId = ensureSession(dbB, 'u-child', '/w', B);
  inbox = new SshPeerInbox(dbB, B, () => clock.t);
  relay = new PeerRelay({
    db: dbB, deviceId: B, now: () => clock.t, live: () => live, ring: async () => ring,
    // 結果は頼みが来た経路で書く。SSH で来た頼みは手元の口へ書く。
    api: () => ({ postResult: (id, body) => (inbox.has(id) ? inbox.api.postResult(id, body) : Promise.reject(new Error('not ssh'))) }),
    canProcess: () => true,
    lastReply: () => reply,
    describe: () => ({ title: 'worker', summary: null, status: null }),
  });
  const receiver = new PeerLaunchInbox({
    db: dbB, api: inbox.api, ring: async () => ring, reread: async () => {}, deviceId: B,
    start: () => ({ run: { id: 'run-1', sessionId: childId } as never, sessionId: childId, tabs: [] }),
    hasProjectHere: () => true, accountByName: () => null, hasAgent: () => true, canProcess: () => true, now: () => clock.t,
    onStarted: (e) => relay.onStarted(e),
  });
  inbox.onReceive((l) => { void receiver.receive([l]); });
  outbox = new PeerOutbox({
    db: dbA, deviceId: A, api: () => null, sshApi: () => tunnelApi(), ring: () => ring, live: () => [entry('u1', 'idle')],
    inject: async (_id, text) => { injected.push(text); return true; },
    notify: () => {}, deviceName: () => 'Mac', now: () => clock.t,
  });
});
afterEach(() => { for (const d of dbs) d.close(); });

describe('SSH の経路の通し', () => {
  it('頼みは受けたらその場で処理され、答えと結果をトンネル越しに取れる。結果は SSH で来た頼みの口に書かれる', async () => {
    await placeSsh();
    // /peer の put の中で受け口が動く（呼び鈴は無い）。
    await vi.waitFor(async () => { expect((await inbox.outbox(A, 0)).launches[0]?.status).toBe('started'); });
    await outbox.syncSsh();
    expect(getPeerRequest(dbA, 'req-1')).toMatchObject({ state: 'started', via: 'ssh', child_session_id: childId });
    expect(getSpawn(dbA, A, childId)).toMatchObject({ childDeviceId: B });
    // 受けた側の結び付きは、頼んだ PC つきで残る。
    expect(getSpawn(dbB, B, childId)).toMatchObject({ parentDeviceId: A });
    // 起こした会話のターンが止まったら、relay が手元の口へ結果を書く。
    live = [entry('u-child', 'busy')];
    relay.check();
    reply = { text: '終わりました', ts: clock.t + 3000 };
    clock.t += 4000;
    live = [entry('u-child', 'idle')];
    relay.check();
    await relay.flush();
    expect((await inbox.results(A, 'req-1', 0))!.results).toHaveLength(1);
    await outbox.syncSsh();
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('終わりました');
  });

  it('ほかの送り手の頼みの結果は読めない。同じ ID の再送は冪等で、ほかの送り手の ID と重なれば conflict', async () => {
    await placeSsh();
    expect(await inbox.results('pc-x', 'req-1', 0)).toBeNull();
    const again = await inbox.put(A, { id: 'req-1', to: B, sealed: '1.x', from: A });
    expect(again).not.toBe('conflict');
    expect(await inbox.put('pc-x', { id: 'req-1', to: B, sealed: '1.x', from: 'pc-x' })).toBe('conflict');
    expect((await inbox.outbox('pc-x', 0)).launches).toEqual([]);
  });

  it('トンネルが切れても、張り直した後に受け取っていない分だけ取り、二重に入れない（受け入れ 20）', async () => {
    await placeSsh();
    await vi.waitFor(async () => { expect((await inbox.outbox(A, 0)).launches[0]?.status).toBe('started'); });
    await outbox.syncSsh();
    await postResult(1, '一つ目');
    await outbox.syncSsh();
    expect(injected).toHaveLength(1);
    // 切れている間に、相手が 2 件を書く。取りには行けない。
    tunnel.up = false;
    clock.t += 5000;
    await postResult(2, '二つ目');
    await postResult(3, '三つ目');
    await outbox.syncSsh();
    expect(injected).toHaveLength(1);
    expect(getPeerRequest(dbA, 'req-1')!.received_seq).toBe(1);
    // 張り直せたら、2 と 3 だけが入る。もう一度取っても増えない。
    tunnel.up = true;
    await outbox.syncSsh();
    expect(injected).toHaveLength(2);
    expect(injected.join('\n')).toContain('二つ目');
    expect(injected.join('\n')).toContain('三つ目');
    expect(injected.filter((x) => x.includes('一つ目'))).toHaveLength(1);
    await outbox.syncSsh();
    expect(injected).toHaveLength(2);
    expect(getPeerRequest(dbA, 'req-1')!.received_seq).toBe(3);
  });

  it('クラウドの頼みは SSH の口から読まず、SSH の頼みはクラウドの口から読まない（頼みごとに経路は 1 つ）', async () => {
    await placeSsh();
    await vi.waitFor(async () => { expect((await inbox.outbox(A, 0)).launches[0]?.status).toBe('started'); });
    const cloud = new PeerOutbox({
      db: dbA, deviceId: A, api: () => tunnelApi(), ring: () => ring, live: () => [], inject: async () => true, notify: () => {}, now: () => clock.t,
    });
    await cloud.sync();
    // クラウドの口で読んでも、via が ssh の行は進まない。
    expect(getPeerRequest(dbA, 'req-1')!.state).toBe('requested');
    await outbox.syncSsh();
    expect(getPeerRequest(dbA, 'req-1')!.state).toBe('started');
    expect(outbox.hasSshWork()).toBe(true);
  });

  it('張り直しを諦めたら、待っている頼みの呼び出し元に 1 度だけ入力で知らせる。頼みは終わらせず、つながれば続きを受ける', async () => {
    await placeSsh();
    await vi.waitFor(async () => { expect((await inbox.outbox(A, 0)).launches[0]?.status).toBe('started'); });
    await outbox.syncSsh();
    await outbox.noteSshGaveUp(B);
    await outbox.noteSshGaveUp(B);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('SSH');
    expect(getPeerRequest(dbA, 'req-1')!.state).toBe('started');
    await postResult(1, '続きの結果');
    await outbox.syncSsh();
    expect(injected).toHaveLength(2);
    expect(injected[1]).toContain('続きの結果');
  });

  it('受け取られないまま期限を過ぎた頼みは expired になり、claim もできない', async () => {
    const sealed = await sealPeerLaunch(ring, { requestId: 'late', from: A, to: B }, request());
    inbox.onReceive(null);
    await inbox.put(A, { id: 'late', to: B, sealed, from: A });
    clock.t += 10 * 60_000;
    expect((await inbox.outbox(A, 0)).launches[0]!.status).toBe('expired');
    expect(await inbox.api.claim('late')).toBe(false);
  });
});
