import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveEpochKeys,
  openPeerChat,
  openPeerChatBlob,
  randomEpochKey,
  sealPeerChatReply,
  type PeerAskIn,
  type PeerAskResult,
  type PeerChatApi,
  type PeerChatItem,
  type PeerChatReply,
  type PeerChatRequest,
  type PeerChatState,
  type PeerKeyring,
  type ServerEvent,
} from '@agent-hangar/shared';
import { PeerChatViewer, PEER_CHAT_ITEMS_KEEP, PEER_CHAT_LEASE_MS, PEER_CHAT_MIN_GAP_MS, PEER_CHAT_OFFLINE_RETRY_MS, PEER_CHAT_RATE_RETRY_MS, PEER_CHAT_REWATCH_GAP_MS, PEER_CHAT_VIEWERS_PER_SOCKET, PEER_CHAT_WATCHES_MAX, type ViewTarget } from './viewer.ts';
import { PEER_CHAT_MIN_HANGAR_VERSION } from '@agent-hangar/shared';

const ME = 'pc-a';
const PEER = 'pc-b';
const SID = 's1';

// 試験が進める時計。sleep と after は進めるまで動かず、進めた分だけ期限の順に鳴らす。
function manualClock(start = 1_700_000_000_000) {
  let now = start;
  const timers: { due: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const tick = () => new Promise<void>((r) => setImmediate(r));
  // 暗号は実時間で終わるので、見張りの問い合わせが返るまで待つ（止まったままの問い合わせのために、待つのは 300 ms まで）。
  const busy: { current: () => number } = { current: () => 0 };
  const settle = async () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await tick();
    while (busy.current() > 0 && Date.now() - t0 < 300) await tick();
    for (let i = 0; i < 5; i++) await tick();
  };
  const add = (ms: number, fn: () => void) => {
    const t = { due: now + ms, fn, id: seq++ };
    timers.push(t);
    return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  };
  return {
    now: () => now,
    after: (ms: number, fn: () => void) => add(ms, fn),
    sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const cancel = add(ms, resolve);
      signal.addEventListener('abort', () => { cancel(); resolve(); }, { once: true });
    }),
    pending: () => timers.length,
    busy,
    settle,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.due - b.due || a.id - b.id);
        const next = timers[0];
        if (!next || next.due > target) break;
        timers.shift();
        now = Math.max(now, next.due);
        next.fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

type Clock = ReturnType<typeof manualClock>;
type HostAnswer = PeerChatReply | { status: number; reason?: 'offline' | 'duplicate' | 'rate' | null } | Error;
type AskRecord = { body: PeerAskIn; req: PeerChatRequest; signal: AbortSignal | undefined; at: number };

const item = (uuid: string, text = uuid): PeerChatItem => ({ uuid, at: 1, kind: 'assistant', text });
const askItem = (uuid: string, askId: string, answered = false): PeerChatItem => ({
  uuid, at: 2, kind: 'permission', text: 'run it?',
  ask: { askId, kind: 'permission', options: [{ key: '1', label: 'Yes' }], multi: false, allowText: false, ...(answered ? { answered: { by: { deviceId: PEER, deviceName: 'Mac' }, label: 'Yes', at: 3 } } : {}) },
});
const state = (items: PeerChatItem[], over: Partial<PeerChatState> = {}): PeerChatState => ({
  sessionId: SID, status: 'busy', items, queued: [], cursor: items.at(-1)?.uuid ?? null, truncated: false, ...over,
});
const ok = (s: PeerChatState): PeerChatReply => ({ ok: true, state: s });

let clock: Clock;
let ring: PeerKeyring;
let asks: AskRecord[];
let blobs: { askId: string; n: number; to: string; sealed: Uint8Array }[];
let answers: ((req: PeerChatRequest, signal: AbortSignal | undefined) => Promise<HostAnswer> | HostAnswer)[];
let fallback: (req: PeerChatRequest, signal: AbortSignal | undefined) => Promise<HostAnswer> | HostAnswer;
let events: Extract<ServerEvent, { type: 'peerChat.update' }>[];
let target: ViewTarget | { ok: false; reason: 'session-unknown' | 'not-claude' | 'not-remote' | 'device-unknown' };
let workerOk: boolean;
let linked: boolean;
let localCursor: string | null;
let ids: number;
let viewer: PeerChatViewer;
let api: PeerChatApi;
let drops: Map<string, { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp' }>;

const peerTarget = (over: Partial<ViewTarget> = {}): ViewTarget => ({ deviceId: PEER, deviceName: 'Mac', hangarVersion: '9.9.9', outdated: false, ...over });
// 止めた直後の開き直しは PEER_CHAT_REWATCH_GAP_MS 待たされるので、時計を進めて開く。
const reopen = async (o: { viewer: string; after?: string | null }) => {
  const p = viewer.open(SID, o);
  await clock.advance(PEER_CHAT_REWATCH_GAP_MS);
  return p;
};
const tails = () => asks.filter((a) => a.req.op.t === 'tail');
const updates = () => events.map(({ type: _t, ...u }) => u);

beforeEach(async () => {
  clock = manualClock();
  const keys = await deriveEpochKeys(1, randomEpochKey());
  ring = { current: () => keys, at: (n) => (n === 1 ? keys : null) };
  asks = [];
  blobs = [];
  answers = [];
  fallback = () => ok(state([]));
  events = [];
  target = { ok: true, ...peerTarget() } as never;
  workerOk = true;
  linked = true;
  localCursor = null;
  ids = 0;
  drops = new Map();
  api = {
    async ask(body, signal): Promise<PeerAskResult> {
      const req = await openPeerChat(ring, { requestId: body.askId, from: ME, to: body.to }, body.sealed);
      asks.push({ body, req, signal, at: clock.now() });
      const make = answers.shift() ?? fallback;
      const a = await make(req, signal);
      if (a instanceof Error) throw a;
      if ('status' in a) return { ok: false, status: a.status, reason: a.reason ?? null };
      return { ok: true, sealed: await sealPeerChatReply(ring, { requestId: body.askId, from: ME, to: body.to }, a) };
    },
    async putBlob(askId, n, to, sealed) { blobs.push({ askId, n, to, sealed }); },
  };
  viewer = new PeerChatViewer({
    selfId: ME,
    resolve: () => (('ok' in target && target.ok === false) ? target as never : { ok: true, target: target as ViewTarget }),
    link: () => (linked ? { api, ring: async () => ring } : null),
    workerOk: () => workerOk,
    version: '1.0.0',
    localCursor: () => localCursor,
    readImage: (ref) => drops.get(ref) ?? null,
    publish: (ev) => { events.push(ev as never); },
    clock,
    newId: () => `ask-${++ids}`,
  });
  clock.busy.current = () => viewer.inflight;
});

describe('見張りを始める（GET）', () => {
  it('手元の写しの最後の uuid から tail を頼み、返った状態を update にして返す', async () => {
    localCursor = 'local-9';
    answers.push(() => ok(state([item('u10'), item('u11')], { status: 'idle' })));
    const r = await viewer.open(SID, { viewer: 'v1' });
    expect(tails()[0]!.req.op).toMatchObject({ t: 'tail', after: 'local-9' });
    expect(tails()[0]!.req.sessionId).toBe(SID);
    expect(r).toEqual({ ok: true, device: { deviceId: PEER, deviceName: 'Mac' }, startedAfter: 'local-9', update: { sessionId: SID, link: 'online', replace: false, status: 'idle', items: [item('u10'), item('u11')], queued: [], cursor: 'u11' } });
  });

  it('after を明示すれば写しの代わりに使い、null なら頭から頼む', async () => {
    localCursor = 'local-9';
    await viewer.open(SID, { viewer: 'v1', after: 'x5' });
    expect(tails()[0]!.req.op).toMatchObject({ after: 'x5' });
    viewer.unwatch(SID, 'v1');
    await reopen({ viewer: 'v2', after: null });
    expect(tails().at(-1)!.req.op).toMatchObject({ after: null });
  });

  it('頼みは相手の PC 宛てで、askId を外側と封の中で同じにし、期限は 60 秒先にする', async () => {
    await viewer.open(SID, { viewer: 'v1' });
    const a = asks[0]!;
    expect(a.body).toMatchObject({ askId: 'ask-1', to: PEER });
    expect(a.req).toMatchObject({ v: 1, askId: 'ask-1', expiresAt: clock.now() + 60_000 });
  });

  it('最初の問い合わせは待たせず（waitMs 0）、その後の長いポーリングは 20 秒待たせる', async () => {
    answers.push(() => ok(state([item('u1')])));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    expect(tails()).toHaveLength(2);
    expect(tails()[0]!.body.waitMs).toBe(0);
    expect(tails()[1]!.body.waitMs).toBe(20_000);
    expect(tails()[1]!.req.op).toMatchObject({ after: 'u1' });
  });

  it('見張りが動いているあいだの 2 度目の GET は、貯めた項目の全部と同じ startedAfter を返し、問い合わせを増やさない', async () => {
    localCursor = 'local-9';
    answers.push(() => ok(state([item('u1')])));
    answers.push(() => ok(state([item('u2')])));
    await viewer.open(SID, { viewer: 'v1' });
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    const second = await viewer.open(SID, { viewer: 'v2' });
    expect(second.ok && second.startedAfter).toBe('local-9');
    expect(second.ok && second.update.items.map((i) => i.uuid)).toEqual(['u1', 'u2']);
  });
});

describe('流れ（peerChat.update）', () => {
  it('新しい項目が届くたびに update を流し、次の問い合わせの after は返ってきた cursor にする', async () => {
    answers.push(() => ok(state([item('u1')])));
    answers.push(() => ok(state([item('u2'), item('u3')], { status: 'idle' })));
    fallback = () => ok(state([], { status: 'idle', cursor: 'u3' }));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    expect(tails()[2]!.req.op).toMatchObject({ after: 'u3' });
    expect(updates()).toEqual([
      { sessionId: SID, link: 'online', replace: false, status: 'busy', items: [item('u1')], queued: [], cursor: 'u1' },
      { sessionId: SID, link: 'online', replace: false, status: 'idle', items: [item('u2'), item('u3')], queued: [], cursor: 'u3' },
    ]);
  });

  it('何も変わらない返事では update を流さない。状態か預かりが変われば、項目が無くても流す', async () => {
    answers.push(() => ok(state([item('u1')])));
    answers.push(() => ok(state([], { cursor: 'u1' })));
    answers.push(() => ok(state([], { cursor: 'u1', status: 'idle', queued: [{ queueId: 'q1', from: { deviceId: 'pc-c', deviceName: 'Linux' }, text: 'hi', images: 0, at: 5, state: 'waiting' }] })));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    expect(updates().map((u) => [u.status, u.items.length, u.queued.length])).toEqual([['busy', 1, 0], ['idle', 0, 1]]);
  });

  it('同じ uuid の項目は捨てる', async () => {
    answers.push(() => ok(state([item('u1'), item('u2')])));
    answers.push(() => ok(state([item('u2'), item('u3')])));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    expect(updates().map((u) => u.items.map((i) => i.uuid))).toEqual([['u1', 'u2'], ['u3']]);
  });

  it('許可の札は askId で畳む。uuid が変わっても重ねず、答えが付いたときだけ最初の uuid で流し直す', async () => {
    answers.push(() => ok(state([item('u1'), askItem('u1@ask:A', 'A')])));
    answers.push(() => ok(state([item('u2'), askItem('u2@ask:A', 'A')])));
    answers.push(() => ok(state([askItem('u2@ask:A', 'A', true)])));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    const flat = updates().map((u) => u.items.map((i) => [i.uuid, i.ask?.answered ? 'answered' : i.kind]));
    expect(flat).toEqual([
      [['u1', 'assistant'], ['u1@ask:A', 'permission']],
      [['u2', 'assistant']],
      [['u1@ask:A', 'answered']],
    ]);
  });

  it('答えの付いた札が同じ uuid のまま末尾に付け直されても、同じ uuid の重ね書きとして 1 度だけ流す', async () => {
    answers.push(() => ok(state([askItem('u1@ask:A', 'A'), item('u2')])));
    answers.push(() => ok(state([askItem('u1@ask:A', 'A', true)], { cursor: 'u2' })));
    fallback = () => ok(state([askItem('u1@ask:A', 'A', true)], { cursor: 'u2' }));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    expect(updates().map((u) => u.items.map((i) => [i.uuid, !!i.ask?.answered]))).toEqual([[['u1@ask:A', false], ['u2', false]], [['u1@ask:A', true]]]);
  });

  it('渡せずに消えた預かり（gone）は queueId ごとに 1 度だけ流し、5 分たったら覚えを捨てる。GET には数分以内の分が全部載る', async () => {
    const gone = [{ queueId: 'q1', reason: 'queue-expired' as const }];
    answers.push(() => ok(state([item('u1')], { gone })));
    answers.push(() => ok(state([], { cursor: 'u1', gone: [...gone, { queueId: 'q2', reason: 'session-unknown' as const }] })));
    answers.push(() => ok(state([], { cursor: 'u1', gone: [...gone, { queueId: 'q2', reason: 'session-unknown' as const }] })));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    expect(updates().map((u) => u.gone ?? [])).toEqual([[{ queueId: 'q1', reason: 'queue-expired' }], [{ queueId: 'q2', reason: 'session-unknown' }]]);
    const again = await viewer.open(SID, { viewer: 'v2' });
    expect(again.ok && again.update.gone?.map((g) => g.queueId)).toEqual(['q1', 'q2']);
  });

  it('truncated の返事は写しを捨てて差し替える（replace）。貯めた分も捨てる', async () => {
    answers.push(() => ok(state([item('u1'), item('u2')])));
    answers.push(() => ok(state([item('u50'), item('u51')], { truncated: true })));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    expect(updates()[1]).toMatchObject({ replace: true, items: [item('u50'), item('u51')], cursor: 'u51' });
    const again = await viewer.open(SID, { viewer: 'v2' });
    expect(again.ok && again.update).toMatchObject({ replace: true });
    expect(again.ok && again.update.items.map((i) => i.uuid)).toEqual(['u50', 'u51']);
  });

  it('貯める項目が溢れたら、古いものを捨てて replace にする', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => item(`m${i}`));
    answers.push(() => ok(state(many)));
    const r = await viewer.open(SID, { viewer: 'v1' });
    expect(r.ok && r.update.items).toHaveLength(1000);
    expect(r.ok && r.update.items[0]!.uuid).toBe('m200');
    expect(r.ok && r.update.replace).toBe(true);
  });
});

describe('相手がつながっていないとき', () => {
  it('409 の offline は offline の update を 1 度だけ流し、15 秒、30 秒と間を空けて頼み直す', async () => {
    fallback = () => ({ status: 409, reason: 'offline' });
    const r = await viewer.open(SID, { viewer: 'v1' });
    expect(r.ok && r.update.link).toBe('offline');
    expect(tails()).toHaveLength(1);
    await clock.advance(PEER_CHAT_OFFLINE_RETRY_MS[0] - 1);
    expect(tails()).toHaveLength(1);
    await clock.advance(1);
    expect(tails()).toHaveLength(2);
    await clock.advance(PEER_CHAT_OFFLINE_RETRY_MS[1] - 1);
    expect(tails()).toHaveLength(2);
    await clock.advance(1);
    expect(tails()).toHaveLength(3);
    // その後も 30 秒ごとで、詰まらない。10 分で 20 回に収まる。
    await clock.advance(10 * 60_000);
    expect(tails().length).toBeLessThanOrEqual(3 + 20);
    expect(updates().filter((u) => u.link === 'offline')).toHaveLength(1);
  });

  it('つながり直したら online の update を流す（項目が無くても）', async () => {
    answers.push(() => ({ status: 409, reason: 'offline' }));
    answers.push(() => ok(state([], { status: 'idle' })));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_OFFLINE_RETRY_MS[0]);
    expect(updates().map((u) => [u.link, u.status])).toEqual([['offline', null], ['online', 'idle']]);
  });

  it('offline のあいだも最後に知った状態を保つ', async () => {
    answers.push(() => ok(state([item('u1')], { status: 'busy' })));
    answers.push(() => ({ status: 409, reason: 'offline' }));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    expect(updates().at(-1)).toMatchObject({ link: 'offline', status: 'busy', items: [], cursor: 'u1' });
  });

  it('429 の rate は 30 秒空ける。呼び鈴が空振りの返事を続けても 0.7 秒より詰めない', async () => {
    answers.push(() => ({ status: 429, reason: 'rate' }));
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_RATE_RETRY_MS - 1);
    expect(tails()).toHaveLength(1);
    await clock.advance(1);
    expect(tails()).toHaveLength(2);
    // 以後は空の返事が即座に返り続ける。1 分で多くても 1 分 / 0.7 秒。
    const before = tails().length;
    await clock.advance(60_000);
    expect(tails().length - before).toBeLessThanOrEqual(Math.ceil(60_000 / PEER_CHAT_MIN_GAP_MS));
  });

  it('届かない（例外）や 504 は短い間から空けて頼み直し、3 回続いたら offline にする', async () => {
    fallback = () => new Error('boom');
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(1_000);
    await clock.advance(5_000);
    expect(tails()).toHaveLength(3);
    expect(updates().filter((u) => u.link === 'offline')).toHaveLength(1);
  });

  it('元の PC の断り（session-unknown など）は見張りを止めて reason つきで流す', async () => {
    answers.push(() => ({ ok: false, reason: 'not-claude' }));
    const r = await viewer.open(SID, { viewer: 'v1' });
    expect(r).toEqual({ ok: false, reason: 'not-claude', device: { deviceId: PEER, deviceName: 'Mac' } });
    expect(updates().at(-1)).toMatchObject({ reason: 'not-claude' });
    await clock.advance(5 * 60_000);
    expect(tails()).toHaveLength(1);
    expect(viewer.watching(SID)).toBe(false);
  });
});

describe('画面を閉じたら止まる', () => {
  it('unwatch で、待っている問い合わせを中止し、その後は頼まない', async () => {
    let signal: AbortSignal | undefined;
    answers.push(() => ok(state([item('u1')])));
    answers.push((_req, s) => { signal = s; return new Promise<HostAnswer>(() => {}); });
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    expect(tails()).toHaveLength(2);
    expect(signal?.aborted).toBe(false);
    viewer.unwatch(SID, 'v1');
    await clock.settle();
    expect(signal?.aborted).toBe(true);
    await clock.advance(10 * 60_000);
    expect(tails()).toHaveLength(2);
    expect(viewer.watching(SID)).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it('WebSocket の切断（dropSocket）でも止まる。ほかの画面が見ている間は止まらない', async () => {
    viewer.watchFromSocket(7, { type: 'peerChat.watch', sessionId: SID, viewer: 'tabA' });
    viewer.watchFromSocket(8, { type: 'peerChat.watch', sessionId: SID, viewer: 'tabB' });
    await vi.waitFor(() => expect(tails()).toHaveLength(1));
    viewer.dropSocket(7);
    expect(viewer.watching(SID)).toBe(true);
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    const n = tails().length;
    expect(n).toBeGreaterThan(1);
    viewer.dropSocket(8);
    expect(viewer.watching(SID)).toBe(false);
    await clock.advance(60_000);
    expect(tails()).toHaveLength(n);
  });

  it('2 人が見ているとき、片方の unwatch では続き、両方で止まる', async () => {
    await viewer.open(SID, { viewer: 'v1' });
    await viewer.open(SID, { viewer: 'v2' });
    viewer.unwatch(SID, 'v1');
    expect(viewer.watching(SID)).toBe(true);
    viewer.unwatch(SID, 'v2');
    expect(viewer.watching(SID)).toBe(false);
  });

  it('GET だけの見ている人は、更新が無いまま期限が過ぎると外れる。GET のたびに延びる', async () => {
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_LEASE_MS - 1_000);
    await viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_LEASE_MS - 1_000);
    expect(viewer.watching(SID)).toBe(true);
    await clock.advance(2_000);
    expect(viewer.watching(SID)).toBe(false);
  });

  it('WebSocket で見始めた人は期限では外れない', async () => {
    await viewer.open(SID, { viewer: 'v1' });
    viewer.watchFromSocket(7, { type: 'peerChat.watch', sessionId: SID, viewer: 'v1' });
    await clock.advance(PEER_CHAT_LEASE_MS * 3);
    expect(viewer.watching(SID)).toBe(true);
    viewer.dropSocket(7);
    expect(viewer.watching(SID)).toBe(false);
  });

  it('止めたあとで同じ会話を開き直すと、新しい見張りが写しの位置からやり直す', async () => {
    answers.push(() => ok(state([item('u1')])));
    await viewer.open(SID, { viewer: 'v1' });
    viewer.unwatch(SID, 'v1');
    localCursor = 'local-1';
    await reopen({ viewer: 'v1' });
    expect(tails().at(-1)!.req.op).toMatchObject({ after: 'local-1' });
  });
});

describe('見張りの上限と見ている人', () => {
  it('1 つの接続が同時に見られる会話は PEER_CHAT_VIEWERS_PER_SOCKET まで。超えたら too-many で断る', async () => {
    for (let i = 0; i < PEER_CHAT_VIEWERS_PER_SOCKET; i++) viewer.watchFromSocket(7, { type: 'peerChat.watch', sessionId: `s${i}`, viewer: `v${i}` });
    expect(events.filter((e) => e.reason)).toEqual([]);
    viewer.watchFromSocket(7, { type: 'peerChat.watch', sessionId: 'extra', viewer: 'vx' });
    expect(updates().at(-1)).toMatchObject({ sessionId: 'extra', reason: 'too-many' });
    expect(viewer.watching('extra')).toBe(false);
    // 別の接続は数えが別。ただし会話の総数の上限（PEER_CHAT_WATCHES_MAX）には当たる。
    viewer.watchFromSocket(8, { type: 'peerChat.watch', sessionId: 'other', viewer: 'v0' });
    expect(updates().at(-1)).toMatchObject({ sessionId: 'other', reason: 'too-many' });
  });

  it('会話の総数の上限を超える見張りは断り、見ている人のいない見張りを残さない', async () => {
    for (let i = 0; i < PEER_CHAT_WATCHES_MAX; i++) viewer.watchFromSocket(10 + i, { type: 'peerChat.watch', sessionId: `w${i}`, viewer: 'v' });
    const r = await viewer.open('overflow', { viewer: 'h1' });
    expect(r).toMatchObject({ ok: false, reason: 'too-many' });
    expect(viewer.watching('overflow')).toBe(false);
    // 見ている会話に加わるのは、上限に当たっても通る。
    expect((await viewer.open('w0', { viewer: 'h2' })).ok).toBe(true);
  });

  it('別の接続が同じ viewer ID で入っても、元の接続の見ている人を乗っ取れない', async () => {
    viewer.watchFromSocket(7, { type: 'peerChat.watch', sessionId: SID, viewer: 'tab' });
    viewer.watchFromSocket(8, { type: 'peerChat.watch', sessionId: SID, viewer: 'tab' });
    // 接続 8 が外れても、接続 7 の見張りは続く。
    viewer.dropSocket(8);
    expect(viewer.watching(SID)).toBe(true);
    // 接続 8 の unwatch は、接続 7 の見ている人を外さない。
    viewer.watchFromSocket(8, { type: 'peerChat.watch', sessionId: SID, viewer: 'tab' });
    viewer.unwatch(SID, 'tab', 8);
    expect(viewer.watching(SID)).toBe(true);
    viewer.unwatch(SID, 'tab', 7);
    expect(viewer.watching(SID)).toBe(false);
  });

  it('WebSocket で見始めた画面が unwatch したら、同じ ID の GET の期限を待たずに止まる', async () => {
    await viewer.open(SID, { viewer: 'tab' });
    viewer.watchFromSocket(7, { type: 'peerChat.watch', sessionId: SID, viewer: 'tab' });
    viewer.unwatch(SID, 'tab', 7);
    expect(viewer.watching(SID)).toBe(false);
  });

  it('止めてすぐ開き直しても、PEER_CHAT_REWATCH_GAP_MS が過ぎるまで新しい問い合わせを出さない', async () => {
    await viewer.open(SID, { viewer: 'v1' });
    viewer.unwatch(SID, 'v1');
    const before = tails().length;
    const p = viewer.open(SID, { viewer: 'v1' });
    await clock.advance(PEER_CHAT_REWATCH_GAP_MS - 1);
    expect(tails()).toHaveLength(before);
    await clock.advance(1);
    await p;
    expect(tails()).toHaveLength(before + 1);
  });

  it('溢れて捨てた項目の札の覚えも捨てる（あとで同じ札が来ても、無い項目の重ね書きにならない）', async () => {
    const filler = Array.from({ length: PEER_CHAT_ITEMS_KEEP }, (_, i) => item(`f${i}`));
    answers.push(() => ok(state([askItem('old@ask:A', 'A'), ...filler])));
    answers.push(() => ok(state([askItem('new@ask:A', 'A')], { cursor: 'new@ask:A' })));
    const first = await viewer.open(SID, { viewer: 'v1' });
    expect(first.ok && first.update.items.some((i) => i.ask)).toBe(false);
    await clock.advance(PEER_CHAT_MIN_GAP_MS);
    // 札 A は捨てた側の覚えが無いので、新しい項目として足される。
    expect(updates().at(-1)!.items.some((i) => i.uuid === 'new@ask:A')).toBe(true);
  });

  it('元の PC が offline と答えたときも、Worker の 409 と同じ 15 秒、30 秒の間を空ける', async () => {
    fallback = () => ({ ok: false, reason: 'offline' });
    const r = await viewer.open(SID, { viewer: 'v1' });
    expect(r.ok && r.update.link).toBe('offline');
    await clock.advance(PEER_CHAT_OFFLINE_RETRY_MS[0] - 1);
    expect(tails()).toHaveLength(1);
    await clock.advance(1);
    expect(tails()).toHaveLength(2);
    await clock.advance(PEER_CHAT_OFFLINE_RETRY_MS[1] - 1);
    expect(tails()).toHaveLength(2);
    await clock.advance(1);
    expect(tails()).toHaveLength(3);
    expect(updates().filter((u) => u.link === 'offline')).toHaveLength(1);
  });
});

describe('版の下限（PEER_CHAT_MIN_HANGAR_VERSION）', () => {
  const gated = (hangarVersion: string | null) => {
    target = { ok: true, ...peerTarget({ hangarVersion }) } as never;
    const v = new PeerChatViewer({
      selfId: ME, resolve: () => ({ ok: true, target: target as ViewTarget }), link: () => ({ api, ring: async () => ring }), workerOk: () => true,
      version: PEER_CHAT_MIN_HANGAR_VERSION, localCursor: () => null, readImage: () => null, publish: () => {}, clock, newId: () => 'x',
    });
    return v.op(SID, { t: 'interrupt' });
  };

  it('固定の版以上の相手を受ける。自分の版が新しくても、機能を持つ古い版の相手を断らない', async () => {
    for (const v of ['0.20.0-rc.1', '0.20.0-rc.2', '0.20.0', '0.20.1', '0.21.0', '1.0.0']) expect(await gated(v)).toMatchObject({ ok: true });
  });

  it('機能の前の版と、版の無い相手は device-outdated', async () => {
    for (const v of ['0.19.0', '0.19.9', null, 'dev']) expect(await gated(v)).toEqual({ ok: false, reason: 'device-outdated' });
  });
});

describe('入口の確かめ（gate）', () => {
  it('Worker の版が足りなければ worker-outdated で断り、頼まない', async () => {
    workerOk = false;
    expect(await viewer.open(SID, { viewer: 'v1' })).toMatchObject({ ok: false, reason: 'worker-outdated' });
    expect(await viewer.op(SID, { t: 'interrupt' })).toEqual({ ok: false, reason: 'worker-outdated' });
    expect(asks).toHaveLength(0);
  });

  it('相手の hangar が古ければ device-outdated、様子の欄が無くても device-outdated', async () => {
    target = { ok: true, ...peerTarget({ hangarVersion: '0.9.0' }) } as never;
    expect(await viewer.open(SID, { viewer: 'v1' })).toMatchObject({ ok: false, reason: 'device-outdated' });
    target = { ok: true, ...peerTarget({ hangarVersion: null, outdated: true }) } as never;
    expect(await viewer.open(SID, { viewer: 'v1' })).toMatchObject({ ok: false, reason: 'device-outdated' });
    expect(asks).toHaveLength(0);
  });

  it('同期に参加していなければ no-link', async () => {
    linked = false;
    expect(await viewer.open(SID, { viewer: 'v1' })).toMatchObject({ ok: false, reason: 'no-link' });
  });

  it('この PC の会話や Claude 以外の会話は、相手を引く段で断る', async () => {
    target = { ok: false, reason: 'not-remote' };
    expect(await viewer.open(SID, { viewer: 'v1' })).toEqual({ ok: false, reason: 'not-remote' });
    target = { ok: false, reason: 'not-claude' };
    expect(await viewer.op(SID, { t: 'interrupt' })).toEqual({ ok: false, reason: 'not-claude' });
  });

  it('WebSocket で見始めて断られたら、reason つきの update を流す', async () => {
    workerOk = false;
    viewer.watchFromSocket(7, { type: 'peerChat.watch', sessionId: SID, viewer: 'v1' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(updates()[0]).toMatchObject({ sessionId: SID, reason: 'worker-outdated', link: 'offline', items: [] });
    expect(viewer.watching(SID)).toBe(false);
  });
});

describe('ops', () => {
  it('send は頼みを封じて渡し、元の PC の答え（queueId）をそのまま返す', async () => {
    answers.push(() => ({ ok: true, queueId: 'q-9' }));
    const r = await viewer.op(SID, { t: 'send', text: 'こんにちは' });
    expect(r).toEqual({ ok: true, queueId: 'q-9' });
    expect(asks[0]!.req.op).toEqual({ t: 'send', text: 'こんにちは', images: [] });
    expect(asks[0]!.body).toMatchObject({ askId: 'ask-1', to: PEER, waitMs: 10_000 });
    expect(asks[0]!.req.expiresAt).toBe(clock.now() + 60_000);
  });

  it('元の PC の断りは reason のまま返す（画面が文を入力欄に戻す）', async () => {
    answers.push(() => ({ ok: false, reason: 'refused-by-setting' }));
    expect(await viewer.op(SID, { t: 'send', text: 'x' })).toEqual({ ok: false, reason: 'refused-by-setting' });
    answers.push(() => ({ ok: false, reason: 'resume-failed' }));
    expect(await viewer.op(SID, { t: 'resume-send', text: 'x' })).toEqual({ ok: false, reason: 'resume-failed' });
  });

  it('つながっていない（409 offline）、回数超え（429）、届かない、待ちの上限（504）を reason にする', async () => {
    answers.push(() => ({ status: 409, reason: 'offline' }));
    expect(await viewer.op(SID, { t: 'send', text: 'x' })).toEqual({ ok: false, reason: 'offline' });
    answers.push(() => ({ status: 429, reason: 'rate' }));
    expect(await viewer.op(SID, { t: 'send', text: 'x' })).toEqual({ ok: false, reason: 'rate' });
    answers.push(() => new Error('network'));
    expect(await viewer.op(SID, { t: 'send', text: 'x' })).toEqual({ ok: false, reason: 'unreachable' });
    answers.push(() => ({ status: 504 }));
    expect(await viewer.op(SID, { t: 'send', text: 'x' })).toEqual({ ok: false, reason: 'expired' });
    answers.push(() => ({ status: 413 }));
    expect(await viewer.op(SID, { t: 'send', text: 'x' })).toEqual({ ok: false, reason: 'too-large' });
  });

  it('大きすぎる文は頼まずに too-large', async () => {
    expect(await viewer.op(SID, { t: 'send', text: 'あ'.repeat(12_000) })).toEqual({ ok: false, reason: 'too-large' });
    expect(asks).toHaveLength(0);
  });

  it('answer、interrupt、cancel、files の op をそのまま運ぶ', async () => {
    answers.push(() => ({ ok: true, files: [{ path: 'a.ts', changed: true }] }));
    expect(await viewer.op(SID, { t: 'files', query: 'a' })).toEqual({ ok: true, files: [{ path: 'a.ts', changed: true }] });
    await viewer.op(SID, { t: 'answer', askId: 'A', keys: ['1'], text: 'x' });
    await viewer.op(SID, { t: 'cancel', queueId: 'q1' });
    await viewer.op(SID, { t: 'interrupt' });
    expect(asks.map((a) => a.req.op)).toEqual([{ t: 'files', query: 'a' }, { t: 'answer', askId: 'A', keys: ['1'], text: 'x' }, { t: 'cancel', queueId: 'q1' }, { t: 'interrupt' }]);
  });

  it('二重の頼みを避けるため、頼みごとに askId を新しくする', async () => {
    await viewer.op(SID, { t: 'interrupt' });
    await viewer.op(SID, { t: 'interrupt' });
    expect(asks.map((a) => a.body.askId)).toEqual(['ask-1', 'ask-2']);
  });

  it('画像は封じて /peer/blobs に置き、頼みには番号と大きさだけを載せる。元の PC は同じ askId で開ける', async () => {
    const png = new Uint8Array([1, 2, 3, 4, 5]);
    drops.set('shot.png', { bytes: png, mime: 'image/png' });
    answers.push(() => ({ ok: true, queueId: 'q1' }));
    const r = await viewer.op(SID, { t: 'send', text: 'see', images: ['shot.png'] });
    expect(r).toEqual({ ok: true, queueId: 'q1' });
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toMatchObject({ askId: 'ask-1', n: 0, to: PEER });
    expect(asks[0]!.req.op).toEqual({ t: 'send', text: 'see', images: [{ n: 0, mime: 'image/png', bytes: 5 }] });
    const opened = await openPeerChatBlob(ring, { requestId: 'ask-1', from: ME, to: PEER }, 0, blobs[0]!.sealed);
    expect([...opened]).toEqual([...png]);
    // 別の askId や番号では開けない。
    await expect(openPeerChatBlob(ring, { requestId: 'ask-2', from: ME, to: PEER }, 0, blobs[0]!.sealed)).rejects.toBeTruthy();
    await expect(openPeerChatBlob(ring, { requestId: 'ask-1', from: ME, to: PEER }, 1, blobs[0]!.sealed)).rejects.toBeTruthy();
  });

  it('画像が読めなければ image-missing、多すぎる・大きすぎるは too-large で、どちらも頼まない', async () => {
    expect(await viewer.op(SID, { t: 'send', text: 'x', images: ['nope.png'] })).toEqual({ ok: false, reason: 'image-missing' });
    drops.set('big.png', { bytes: new Uint8Array(5 * 1024 * 1024 + 1), mime: 'image/png' });
    expect(await viewer.op(SID, { t: 'send', text: 'x', images: ['big.png'] })).toEqual({ ok: false, reason: 'too-large' });
    for (let i = 0; i < 5; i++) drops.set(`i${i}.png`, { bytes: new Uint8Array([1]), mime: 'image/png' });
    expect(await viewer.op(SID, { t: 'send', text: 'x', images: ['i0.png', 'i1.png', 'i2.png', 'i3.png', 'i4.png'] })).toEqual({ ok: false, reason: 'too-large' });
    expect(asks).toHaveLength(0);
    expect(blobs).toHaveLength(0);
  });

  it('画像の置き場の失敗（429、413、例外）は頼まずに reason にする', async () => {
    drops.set('a.png', { bytes: new Uint8Array([1]), mime: 'image/png' });
    const put = vi.spyOn(api, 'putBlob');
    put.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 429 }));
    expect(await viewer.op(SID, { t: 'send', text: 'x', images: ['a.png'] })).toEqual({ ok: false, reason: 'rate' });
    put.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 413 }));
    expect(await viewer.op(SID, { t: 'send', text: 'x', images: ['a.png'] })).toEqual({ ok: false, reason: 'too-large' });
    put.mockRejectedValueOnce(new Error('network'));
    expect(await viewer.op(SID, { t: 'send', text: 'x', images: ['a.png'] })).toEqual({ ok: false, reason: 'unreachable' });
    expect(asks).toHaveLength(0);
  });

  it('答えに state が付いていて見張りが動いていれば、同じ畳み方で取り込み update を流す', async () => {
    answers.push(() => ok(state([item('u1'), askItem('u1@ask:A', 'A')])));
    await viewer.open(SID, { viewer: 'v1' });
    const before = events.length;
    answers.push(() => ({ ok: true, state: state([askItem('u1@ask:A', 'A', true)], { status: 'busy' }) }));
    const r = await viewer.op(SID, { t: 'answer', askId: 'A', keys: ['1'] });
    expect(r.ok).toBe(true);
    expect(events.length).toBe(before + 1);
    expect(updates().at(-1)!.items.map((i) => [i.uuid, !!i.ask?.answered])).toEqual([['u1@ask:A', true]]);
  });
});
