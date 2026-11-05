import { describe, expect, it } from 'vitest';
import {
  deriveEpochKeys,
  openPeerResult,
  randomEpochKey,
  type EpochKeys,
  type LiveSessionDto,
  type PeerKeyring,
  type PeerLaunchResult,
} from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { getSpawn, recordSpawn } from '../sessions/spawns.ts';
import { CloudError } from '../sync/client.ts';
import { PEER_REPLY_MAX, PeerRelay } from './relay.ts';

const T0 = 1_800_000_000_000;

async function ringOf(): Promise<PeerKeyring> {
  const keys = new Map<number, EpochKeys>([[1, await deriveEpochKeys(1, randomEpochKey())]]);
  return { current: () => keys.get(1)!, at: (n) => keys.get(n) ?? null };
}

const entry = (sessionId: string, status: LiveSessionDto['status'], over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 1, ...over });

/** pc-b（この PC）の会話 1 つを、pc-a の親 parent-1 から起こされたものとして組む。 */
async function setup(o: { db?: Db } = {}) {
  const db = o.db ?? openDb(':memory:');
  const ring = await ringOf();
  let now = T0;
  let live: LiveSessionDto[] = [];
  let reply: { text: string; ts: number | null } | null = null;
  let summary: { summary: string | null; status: string | null } = { summary: '要約', status: 'working' };
  const id = ensureSession(db, 'u-child', '/w', 'pc-b');
  const failing = { on: false, status: 503 };
  const posted: { rid: string; seq: number; sealed: string }[] = [];
  const api = {
    postResult: async (rid: string, body: { seq: number; sealed: string }) => {
      if (failing.on) throw new CloudError(failing.status, 'x');
      posted.push({ rid, seq: body.seq, sealed: body.sealed });
      return { ok: true as const, duplicate: false };
    },
  };
  const make = (d: Db = db) => new PeerRelay({
    db: d, deviceId: 'pc-b', now: () => now, live: () => live, ring: async () => ring, api: () => api, canProcess: () => true,
    lastReply: () => reply, describe: () => ({ title: '子の会話', ...summary }),
  });
  const relay = make();
  const start = (hasPrompt = true) => {
    recordSpawn(db, 'pc-b', id, 'parent-1', now, { parentDeviceId: 'pc-a', childDeviceId: 'pc-b' });
    relay.onStarted({ requestId: 'req-1', from: 'pc-a', parentSessionId: 'parent-1', sessionId: id, title: '子の会話', hasPrompt });
  };
  /** 送った結果の封を開く。 */
  const results = async (): Promise<(PeerLaunchResult & { seq: number })[]> =>
    Promise.all(posted.map(async (p) => ({ ...(await openPeerResult(ring, { requestId: p.rid, from: 'pc-a', to: 'pc-b' }, p.seq, p.sealed)), seq: p.seq })));
  return {
    db, id, relay, make, start, results, failing, posted, ring,
    setLive: (l: LiveSessionDto[]) => { live = l; },
    setReply: (r: typeof reply) => { reply = r; },
    setSummary: (s: typeof summary) => { summary = s; },
    setNow: (t: number) => { now = t; },
    now: () => now,
    flush: async () => { await relay.flush(); },
  };
}

describe('PeerRelay', () => {
  it('起動の prompt のターンが idle で止まると、最後の返答と要約つきの結果が 1 件（テスト 9）', async () => {
    const t = await setup();
    t.start();
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setReply({ text: '終わりました', ts: T0 + 3000 });
    t.setNow(T0 + 4000);
    t.setLive([entry('u-child', 'idle')]);
    t.relay.check();
    await t.flush();
    const r = await t.results();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ seq: 1, sessionId: t.id, title: '子の会話', reason: 'idle', summary: '要約', status: 'working', lastReply: '終わりました', truncated: false });
    // もう一度見ても、同じ止まりは書かない。
    t.relay.check();
    await t.flush();
    expect(await t.results()).toHaveLength(1);
  });

  it('返答が本文に載るのを少し待ち、待っても載らなければ空の返答で書く', async () => {
    const t = await setup();
    t.start();
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setLive([entry('u-child', 'idle')]);
    t.setNow(T0 + 1000);
    t.relay.check();
    await t.flush();
    expect(await t.results()).toHaveLength(0);
    t.setNow(T0 + 7000);
    t.relay.check();
    await t.flush();
    expect(await t.results()).toMatchObject([{ reason: 'idle', lastReply: '' }]);
  });

  it('質問と許可で止まると理由つきで書き、そのあと idle でもう 1 件（テスト 9）', async () => {
    const t = await setup();
    t.start();
    t.setReply({ text: 'どちらにしますか', ts: T0 + 1000 });
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setNow(T0 + 2000);
    t.setLive([entry('u-child', 'waiting', { waitingFor: 'question' })]);
    t.relay.check();
    t.relay.check();
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setLive([entry('u-child', 'waiting', { waitingFor: 'permission' })]);
    t.setNow(T0 + 3000);
    t.relay.check();
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setLive([entry('u-child', 'idle')]);
    t.setReply({ text: '済み', ts: T0 + 3500 });
    t.relay.check();
    await t.flush();
    expect((await t.results()).map((r) => [r.seq, r.reason])).toEqual([[1, 'question'], [2, 'permission'], [3, 'idle']]);
  });

  it('利用者が直接打ったターンは返らず、send で入れたターンは返る（テスト 10）', async () => {
    const t = await setup();
    t.start();
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setReply({ text: '一回目', ts: T0 + 1000 });
    t.setLive([entry('u-child', 'idle')]);
    t.relay.check();
    await t.flush();
    expect(await t.results()).toHaveLength(1);
    // 利用者が直接打った
    t.setNow(T0 + 10_000);
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setReply({ text: '利用者のターンの返答', ts: T0 + 11_000 });
    t.setLive([entry('u-child', 'idle', { statusAt: T0 + 11_000 })]);
    t.relay.check();
    await t.flush();
    expect(await t.results()).toHaveLength(1);
    // 呼び出し元の send
    t.setNow(T0 + 20_000);
    expect(t.relay.arm(t.id)).toBe(true);
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setReply({ text: 'send の返答', ts: T0 + 21_000 });
    t.setLive([entry('u-child', 'idle')]);
    t.relay.check();
    await t.flush();
    const r = await t.results();
    expect(r.map((x) => [x.seq, x.lastReply])).toEqual([[1, '一回目'], [2, 'send の返答']]);
  });

  it('prompt なしの起動は印を付けない', async () => {
    const t = await setup();
    t.start(false);
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setLive([entry('u-child', 'idle')]);
    t.setReply({ text: 'x', ts: T0 + 100 });
    t.relay.check();
    await t.flush();
    expect(await t.results()).toHaveLength(0);
  });

  it('始まりが見えないまま猶予を過ぎた印は外す（ターンにならない入力）', async () => {
    const t = await setup();
    t.start();
    t.setLive([entry('u-child', 'idle')]);
    t.relay.check();
    t.setNow(T0 + 10 * 60_000);
    t.relay.check();
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setReply({ text: '利用者のターン', ts: T0 + 10 * 60_000 + 1 });
    t.setLive([entry('u-child', 'idle')]);
    t.relay.check();
    await t.flush();
    expect(await t.results()).toHaveLength(0);
  });

  it('長い返答は 6000 字で切り、truncated を真にする（テスト 13）', async () => {
    const t = await setup();
    t.start();
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setReply({ text: 'あ'.repeat(PEER_REPLY_MAX + 500), ts: T0 + 100 });
    t.setLive([entry('u-child', 'idle')]);
    t.relay.check();
    await t.flush();
    const [r] = await t.results();
    expect([...r!.lastReply]).toHaveLength(PEER_REPLY_MAX);
    expect(r!.truncated).toBe(true);
  });

  it('終了と削除で ended を 1 度だけ書き、結び付きを閉じる。その後は何も書かない（テスト 12）', async () => {
    const t = await setup();
    t.start();
    t.setReply({ text: '最後', ts: T0 + 100 });
    t.relay.onEnded(t.id);
    t.relay.onEnded(t.id);
    await t.flush();
    expect(await t.results()).toMatchObject([{ seq: 1, reason: 'ended', lastReply: '最後' }]);
    expect(getSpawn(t.db, 'pc-b', t.id)).toMatchObject({ relay: 'off' });
    // その後の登録の変化と、削除の前の呼びは書かない。
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setLive([entry('u-child', 'idle')]);
    t.relay.check();
    t.relay.onEnded(t.id);
    await t.flush();
    expect(await t.results()).toHaveLength(1);
  });

  it('同じ PC の中の入れ子と、頼まれていない会話では何も書かない', async () => {
    const t = await setup();
    const other = ensureSession(t.db, 'u-other', '/w', 'pc-b');
    recordSpawn(t.db, 'pc-b', other, 'parent-9', T0);
    t.relay.onEnded(other);
    t.relay.onEnded('nope');
    await t.flush();
    expect(await t.results()).toHaveLength(0);
  });

  it('seq は再起動をまたいで重複しない（新しい PeerRelay が続きから採る）', async () => {
    const t = await setup();
    t.start();
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setReply({ text: '1', ts: T0 + 100 });
    t.setLive([entry('u-child', 'idle')]);
    t.relay.check();
    await t.flush();
    const again = t.make();
    again.arm(t.id);
    t.setLive([entry('u-child', 'busy')]);
    again.check();
    t.setReply({ text: '2', ts: T0 + 200 });
    t.setLive([entry('u-child', 'idle')]);
    again.check();
    await again.flush();
    expect((await t.results()).map((r) => r.seq)).toEqual([1, 2]);
  });

  it('書けなかった結果は同じ seq で送り直す。届いた分は二度送らない', async () => {
    const t = await setup();
    t.start();
    t.failing.on = true;
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    t.setReply({ text: 'a', ts: T0 + 100 });
    t.setLive([entry('u-child', 'idle')]);
    t.relay.check();
    await t.flush();
    expect(t.posted).toHaveLength(0);
    t.failing.on = false;
    await t.flush();
    await t.flush();
    expect(t.posted.map((p) => p.seq)).toEqual([1]);
  });

  it('Worker が恒久的に断った結果（404）は送り直さない', async () => {
    const t = await setup();
    t.start();
    t.failing.on = true;
    t.failing.status = 404;
    t.relay.onEnded(t.id);
    await t.flush();
    t.failing.on = false;
    await t.flush();
    expect(t.posted).toHaveLength(0);
  });

  it('頼まれた PC の結び付きを切り離すと（relay が off）、止まりを書かない', async () => {
    const t = await setup();
    t.start();
    t.setLive([entry('u-child', 'busy')]);
    t.relay.check();
    const { closeSpawn } = await import('../sessions/spawns.ts');
    closeSpawn(t.db, 'pc-b', t.id, T0);
    t.setReply({ text: 'x', ts: T0 + 100 });
    t.setLive([entry('u-child', 'idle')]);
    t.relay.check();
    await t.flush();
    expect(await t.results()).toHaveLength(0);
  });
});
