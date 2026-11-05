import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveEpochKeys, PEER_LAUNCH_TTL_MS, randomEpochKey, sealPeerAnswer, sealPeerResult,
  type LiveSessionDto, type PeerKeyring, type PeerLaunchApi, type PeerLaunchResult, type PeerRoute,
} from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/write.ts';
import { acceptsResultFrom, forgetSpawn, getSpawn } from '../sessions/spawns.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { PeerOutbox, recordPeerRequest } from './outbox.ts';

const ME = 'pc-a';
const PEER = 'pc-b';
const REQ = 'req-1';
const route: PeerRoute = { requestId: REQ, from: ME, to: PEER };
const SEALED = '1.c2VhbGVk';

let db: Db;
let clock: { t: number };
let a: FakeCloudClient;
let b: FakeCloudClient;
let ring: PeerKeyring;
let live: LiveSessionDto[];
let injected: { id: string; text: string }[];
let notices: { id: string | null; text: string; anchor: string | null }[];
let injectOk: boolean;
let caller: string;
let ob: PeerOutbox;
let api: PeerLaunchApi;

const entry = (sessionId: string, status: LiveSessionDto['status'], over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 1, ...over });

async function ringOf(): Promise<PeerKeyring> {
  const keys = await deriveEpochKeys(1, randomEpochKey());
  return { current: () => keys, at: (n) => (n === 1 ? keys : null) };
}

/** 頼みを置き、記録するところまで。 */
async function place(id = REQ): Promise<void> {
  await a.peerLaunch.put({ id, to: PEER, sealed: SEALED });
  recordPeerRequest(db, { requestId: id, to: PEER, callerSessionId: caller, now: clock.t });
}
/** 相手の PC が受け取って started と答えたところまで。 */
async function started(sessionId = 'child-1', id = REQ): Promise<void> {
  await b.peerLaunch.claim(id);
  await b.peerLaunch.answer(id, true, await sealPeerAnswer(ring, { ...route, requestId: id }, { ok: true, sessionId, title: 'worker' }));
}
async function refused(reason: 'project-missing' | 'account-logged-out', id = REQ): Promise<void> {
  await b.peerLaunch.claim(id);
  await b.peerLaunch.answer(id, false, await sealPeerAnswer(ring, { ...route, requestId: id }, { ok: false, reason }));
}
async function result(seq: number, over: Partial<PeerLaunchResult> = {}, r: PeerRoute = route): Promise<void> {
  const body: PeerLaunchResult = { v: 1, at: clock.t, sessionId: 'child-1', title: 'worker', reason: 'idle', summary: '要約です', status: 'in_progress', lastReply: '最後の返答です', truncated: false, ...over };
  await b.peerLaunch.postResult(r.requestId, { seq, sealed: await sealPeerResult(ring, r, seq, body) });
}

beforeEach(async () => {
  db = openDb(':memory:');
  clock = { t: 1_000_000 };
  a = new FakeCloudClient({ deviceId: ME, now: () => clock.t });
  b = a.asDevice(PEER);
  await b.pullChanges(0, 10);
  ring = await ringOf();
  caller = ensureSession(db, 'u1', '/w', ME);
  live = [entry('u1', 'idle')];
  injected = [];
  notices = [];
  injectOk = true;
  api = a.peerLaunch;
  ob = new PeerOutbox({
    db, deviceId: ME, api: () => api, ring: () => ring, live: () => live,
    inject: async (id, text) => { if (injectOk) injected.push({ id, text }); return injectOk; },
    notify: (id, text, anchor) => { notices.push({ id, text, anchor: anchor ?? null }); },
    deviceName: (id) => (id === PEER ? 'Mac' : null),
    now: () => clock.t,
  });
});
afterEach(() => { db.close(); });

describe('PeerOutbox の答え', () => {
  it('started なら、結び付きを子の PC つきで残し、その子の結果を受けてよくなる', async () => {
    await place();
    await started();
    await ob.sync();
    expect(getSpawn(db, ME, 'child-1')).toMatchObject({ parentId: caller, parentDeviceId: ME, childDeviceId: PEER, relay: 'on' });
    expect(acceptsResultFrom(db, ME, 'child-1', PEER)).toBe(true);
    // 起動に成功した答えは入力にしない（呼び出し元の create_session は started を返す）。
    expect(injected).toEqual([]);
  });

  it('断りの答えは、理由つきで呼び出し元に入る。結び付きは作らない', async () => {
    await place();
    await refused('project-missing');
    await ob.sync();
    expect(getSpawn(db, ME, 'child-1')).toBeNull();
    expect(injected).toHaveLength(1);
    expect(injected[0]!.id).toBe(caller);
    expect(injected[0]!.text).toContain('Mac');
    expect(injected[0]!.text).toContain('ディレクトリがありません');
    await ob.sync();
    expect(injected).toHaveLength(1);
  });

  it('呼び鈴が無くても、30 秒ごとの取得（tick）で届く。受け取られないまま期限を過ぎたら expired が入る（受け入れ 15）', async () => {
    await place();
    await ob.tick();
    expect(injected).toEqual([]);
    clock.t += PEER_LAUNCH_TTL_MS + 1_000;
    await ob.tick();
    expect(injected).toHaveLength(1);
    expect(injected[0]!.text).toContain('期限が過ぎました');
    await ob.tick();
    expect(injected).toHaveLength(1);
  });

  it('start() は間隔ごとに tick を回し、止められる', async () => {
    const ticks: (() => void)[] = [];
    let cleared = 0;
    const timers = {
      setTimeout, clearTimeout,
      setInterval: ((fn: () => void) => { ticks.push(fn); return 1 as never; }) as unknown as typeof setInterval,
      clearInterval: (() => { cleared += 1; }) as unknown as typeof clearInterval,
    };
    const o = new PeerOutbox({ db, deviceId: ME, api: () => api, ring: () => ring, live: () => live, inject: async (id, text) => { injected.push({ id, text }); return true; }, notify: () => {}, now: () => clock.t, timers });
    await place();
    await refused('account-logged-out');
    const stop = o.start();
    expect(ticks).toHaveLength(1);
    ticks[0]!();
    await vi_waitFor(() => injected.length === 1);
    stop();
    expect(cleared).toBe(1);
  });
});

async function vi_waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

describe('PeerOutbox の結果の送り込み（D14）', () => {
  beforeEach(async () => {
    await place();
    await started();
  });

  it('idle で止まったら、相手の PC 名・会話の名前と ID・要約・最後の返答が 1 通で入る（受け入れ 9）', async () => {
    await result(1);
    await ob.sync();
    expect(injected).toHaveLength(1);
    const t = injected[0]!.text;
    expect(injected[0]!.id).toBe(caller);
    for (const s of ['Mac', 'worker', 'child-1', '要約です', '最後の返答です', '入力を待っています']) expect(t).toContain(s);
    expect(t).not.toContain('途中までです');
  });

  it('質問と許可で止まったときは、理由つきで入る', async () => {
    await result(1, { reason: 'question', lastReply: 'どちらにしますか' });
    await result(2, { reason: 'permission', lastReply: '' });
    await ob.sync();
    const t = injected.map((x) => x.text).join('\n');
    expect(t).toContain('答えを待っています');
    expect(t).toContain('許可を待っています');
  });

  it('切った最後の返答は、切ったと分かる（受け入れ 13）', async () => {
    await result(1, { truncated: true });
    await ob.sync();
    expect(injected[0]!.text).toContain('途中までです');
  });

  it('呼び出し元がターンの最中なら預かり、止まってから 1 通にまとめて入る（受け入れ 11）', async () => {
    live = [entry('u1', 'busy')];
    await result(1, { lastReply: '一つ目' });
    await result(2, { lastReply: '二つ目' });
    await ob.sync();
    expect(injected).toEqual([]);
    expect(notices).toEqual([]);
    // 許可待ちもターンの途中。
    live = [entry('u1', 'waiting', { waitingFor: 'permission' })];
    await ob.flush();
    expect(injected).toEqual([]);
    live = [entry('u1', 'idle')];
    await ob.flush();
    expect(injected).toHaveLength(1);
    expect(injected[0]!.text).toContain('一つ目');
    expect(injected[0]!.text).toContain('二つ目');
    await ob.flush();
    expect(injected).toHaveLength(1);
  });

  it('止められていれば、預かったまま未読と通知で 1 度だけ知らせ、再開したら渡す', async () => {
    live = [];
    await result(1);
    await ob.sync();
    await ob.flush();
    expect(injected).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.id).toBe(caller);
    expect(notices[0]!.text).toContain('Mac');
    expect(notices[0]!.text).toContain('再開');
    live = [entry('u1', 'idle')];
    await ob.flush();
    expect(injected).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it('入力の口が届けられなかったら、預かったままにして次に渡す', async () => {
    injectOk = false;
    await result(1);
    await ob.sync();
    expect(injected).toEqual([]);
    injectOk = true;
    await ob.flush();
    expect(injected).toHaveLength(1);
  });

  it('呼び出し元が消されていれば、入力にせず利用者への通知だけ。繰り返さない（受け入れ 11）', async () => {
    upsertShared(db, 'sessions', { id: 'child-1', provider: 'claude-code', provider_session_id: 'uc', cwd: '/w', home_device: PEER }, PEER);
    softDeleteShared(db, 'sessions', caller, ME);
    await result(1);
    await ob.sync();
    await ob.flush();
    expect(injected).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.id).toBeNull();
    // 軸は、起こした会話（OS とスマホの通知がそれを開く）。
    expect(notices[0]!.anchor).toBe('child-1');
    expect(notices[0]!.text).toContain('消えている');
    // 2 回目以降の報告では通知しない。
    await result(2, { lastReply: '二つ目' });
    await ob.sync();
    expect(notices).toHaveLength(1);
    expect(injected).toEqual([]);
  });
});

describe('PeerOutbox の終わりと二重の防ぎ', () => {
  beforeEach(async () => {
    await place();
    await started();
  });

  it('ended は 1 度だけ入り、結び付きが切れて、その後の結果は入らない（受け入れ 12）', async () => {
    await result(1);
    await result(2, { reason: 'ended', lastReply: '' });
    await result(3, { lastReply: 'また来た' });
    await ob.sync();
    const t = injected.map((x) => x.text).join('\n');
    expect(t.match(/終了しました/g)).toHaveLength(1);
    expect(t).not.toContain('また来た');
    expect(getSpawn(db, ME, 'child-1')).toMatchObject({ relay: 'off' });
    await result(4, { lastReply: 'さらに来た' });
    await ob.sync();
    expect(injected.map((x) => x.text).join('\n')).not.toContain('さらに来た');
  });

  it('stopped は入るが、結び付きは切れず、その後の結果も入る', async () => {
    await result(1, { reason: 'stopped', lastReply: '' });
    await result(2, { lastReply: '再開後の返答' });
    await ob.sync();
    const t = injected.map((x) => x.text).join('\n');
    expect(t).toContain('再開後の返答');
    expect(getSpawn(db, ME, 'child-1')).toMatchObject({ relay: 'on' });
  });

  it('同じ seq は二度入れない。取得の起点を戻しても、口が after を無視して返し直しても（受け入れ 20）', async () => {
    await result(1);
    await ob.sync();
    expect(injected).toHaveLength(1);
    db.prepare("delete from sync_state where key = 'peerOutboxSince'").run();
    api = { ...a.peerLaunch, results: async (id, _after) => a.peerLaunch.results(id, 0) };
    await ob.sync();
    await ob.sync();
    expect(injected).toHaveLength(1);
    await result(2, { lastReply: '二つ目' });
    await ob.sync();
    expect(injected).toHaveLength(2);
    expect(injected[1]!.text).toContain('二つ目');
  });

  it('結び付きが無い子（切り離した後）の結果は捨てる。連番は進めるので、止まらない', async () => {
    await ob.sync();
    forgetSpawn(db, ME, 'child-1');
    await result(1, { lastReply: '切り離し後' });
    await ob.sync();
    expect(injected).toEqual([]);
    expect((db.prepare('select received_seq from peer_outbox where request_id = ?').get(REQ) as { received_seq: number }).received_seq).toBe(1);
  });

  it('答えと違う会話の結果は捨てる', async () => {
    await result(1, { sessionId: 'someone-else', lastReply: 'なりすまし' });
    await ob.sync();
    expect(injected).toEqual([]);
  });

  it('開けない封（向きの違う AAD）は捨てて連番を進め、後の結果は入る', async () => {
    await result(1, { lastReply: '偽の封' }, { requestId: REQ, from: PEER, to: ME });
    await result(2, { lastReply: '本物' });
    await ob.sync();
    expect(injected).toHaveLength(1);
    expect(injected[0]!.text).toContain('本物');
    expect(injected[0]!.text).not.toContain('偽の封');
  });

  it('知らない世代の封は、連番を進めずに残し、鍵が届いたら入る', async () => {
    const other = await ringOf();
    const real = ring;
    ring = { current: () => real.current(), at: () => null };
    await result(1);
    await ob.sync();
    expect(injected).toEqual([]);
    ring = real;
    void other;
    await ob.sync();
    expect(injected).toHaveLength(1);
  });

  it('頼みの行を作る前の ID や、記録に無い頼みの状態は無視する', async () => {
    await a.peerLaunch.put({ id: 'not-mine', to: PEER, sealed: SEALED });
    await ob.sync();
    expect(injected).toEqual([]);
  });

  describe('承認で決まる断り（refuseLocal）', () => {
    it('承認を断られたら approval-denied を、時間切れなら approval-timeout を、呼び出し元に入力として入れる', async () => {
      await ob.refuseLocal({ requestId: 'ap-1', to: PEER, callerSessionId: caller, reason: 'approval-denied' });
      expect(injected).toHaveLength(1);
      expect(injected[0]!.id).toBe(caller);
      expect(injected[0]!.text).toContain('Mac');
      expect(injected[0]!.text).toContain('承認しませんでした');
      await ob.refuseLocal({ requestId: 'ap-2', to: PEER, callerSessionId: caller, reason: 'approval-timeout' });
      expect(injected[1]!.text).toContain('時間内に承認しませんでした');
    });
    it('同じ頼みの断りは 1 度しか入れない', async () => {
      await ob.refuseLocal({ requestId: 'ap-1', to: PEER, callerSessionId: caller, reason: 'approval-denied' });
      await ob.refuseLocal({ requestId: 'ap-1', to: PEER, callerSessionId: caller, reason: 'approval-timeout' });
      expect(injected).toHaveLength(1);
    });
    it('呼び出し元が止まっていれば預かって通知し、再開したら入れる', async () => {
      live = [];
      await ob.refuseLocal({ requestId: 'ap-1', to: PEER, callerSessionId: caller, reason: 'approval-denied' });
      expect(injected).toEqual([]);
      expect(notices).toHaveLength(1);
      live = [entry('u1', 'idle')];
      await ob.flush();
      expect(injected).toHaveLength(1);
    });
  });
});

describe('PeerOutbox の send と stop の答え', () => {
  const SEND = 'req-send';
  const sendRoute: PeerRoute = { requestId: SEND, from: ME, to: PEER };
  const placeSend = async (op: 'send' | 'stop' = 'send'): Promise<void> => {
    await a.peerLaunch.put({ id: SEND, to: PEER, sealed: SEALED });
    recordPeerRequest(db, { requestId: SEND, to: PEER, callerSessionId: caller, now: clock.t, op, childSessionId: 'child-1' });
    await b.peerLaunch.claim(SEND);
  };
  beforeEach(async () => {
    await place();
    await started();
    await ob.sync();
  });

  it('受け取られれば、結び付きも入力も作らず終わる', async () => {
    await placeSend();
    await b.peerLaunch.answer(SEND, true, await sealPeerAnswer(ring, sendRoute, { ok: true, sessionId: 'child-1', title: 'worker' }));
    await ob.sync();
    expect(db.prepare('select state, op from peer_outbox where request_id = ?').get(SEND)).toEqual({ state: 'done', op: 'send' });
    expect(injected).toEqual([]);
    expect(getSpawn(db, ME, 'child-1')!.childDeviceId).toBe(PEER);
  });

  it('断られれば、その理由を呼び出し元に入力で返す。起こした相手の結び付きには触れない', async () => {
    await placeSend();
    await b.peerLaunch.answer(SEND, false, await sealPeerAnswer(ring, sendRoute, { ok: false, reason: 'not-spawned-by-caller' }));
    await ob.sync();
    expect(db.prepare('select state, reason from peer_outbox where request_id = ?').get(SEND)).toEqual({ state: 'refused', reason: 'not-spawned-by-caller' });
    expect(injected).toHaveLength(1);
    expect(injected[0]!.id).toBe(caller);
    expect(getSpawn(db, ME, 'child-1')).not.toBeNull();
  });

  it('期限が切れても、同じく入力で返す', async () => {
    await a.peerLaunch.put({ id: SEND, to: PEER, sealed: SEALED });
    recordPeerRequest(db, { requestId: SEND, to: PEER, callerSessionId: caller, now: clock.t, op: 'stop', childSessionId: 'child-1' });
    clock.t += PEER_LAUNCH_TTL_MS + 1000;
    await ob.sync();
    expect(db.prepare('select state from peer_outbox where request_id = ?').get(SEND)).toEqual({ state: 'expired' });
    expect(injected).toHaveLength(1);
  });
});
