import { describe, expect, it, vi } from 'vitest';
import type { PeerChatItem, PeerChatOpIn, PeerChatOpResult, PeerChatTurn, PeerChatUpdate, PeerChatViewDto } from '@agent-hangar/shared';
import { applyServerEvent, initialStore, type Store } from '../store/store.ts';
import { joinedItems } from '../store/peerChat.ts';
import { createPeerChatRunner } from './peerChat.ts';

const item = (uuid: string): PeerChatItem => ({ uuid, at: 1, kind: 'user', text: uuid });
const turn = (uuid: string): PeerChatTurn => ({ uuid, at: 1, text: uuid, tools: 0 });
const update = (over: Partial<PeerChatUpdate> = {}): PeerChatUpdate => ({ sessionId: 's1', link: 'online', replace: false, status: 'busy', items: [item('c'), item('d')], queued: [], cursor: 'c1', ...over });
const view = (over: Partial<PeerChatUpdate> = {}): PeerChatViewDto => ({ ok: true, device: { deviceId: 'd-mac', deviceName: 'Mac' }, startedAfter: null, update: update(over) });
const ids = (xs: { uuid: string }[]) => xs.map((x) => x.uuid);

function rig(open: () => Promise<PeerChatViewDto>, op: (s: string, b: PeerChatOpIn) => Promise<PeerChatOpResult>) {
  let store: Store = initialStore();
  const runner = createPeerChatRunner({ open, op, send: () => {}, get: () => store.peerChat, set: (peerChat) => { store = { ...store, peerChat }; }, after: () => () => {} });
  const slice = () => store.peerChat.s1!;
  // WebSocket の更新。runtime.ts と同じく、Store に入れたあとで noteUpdate を呼ぶ。
  const push = (u: PeerChatUpdate) => { store = applyServerEvent(store, { type: 'peerChat.update', ...u }); runner.noteUpdate('s1'); };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const opened = async () => { runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' }); await tick(); };
  return { runner, slice, push, tick, opened };
}

describe('ほかの PC の会話の目次を頼む時機（runtime/peerChat）', () => {
  it('開いたとき、turnCount があれば目次を 1 度だけ頼み、行が入る', async () => {
    const op = vi.fn(async (_s: string, _b: PeerChatOpIn): Promise<PeerChatOpResult> => ({ ok: true, turns: { rows: [turn('c')], total: 1, more: false } }));
    const t = rig(async () => view({ turnCount: 1 }), op);
    await t.opened();
    await t.tick();
    expect(op).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledWith('s1', { t: 'turns' });
    expect(ids(t.slice().turns)).toEqual(['c']);
    expect(t.slice().turnsLoaded).toBe(true);
  });

  it('turnCount が無い（古い相手）ときは目次を頼まない', async () => {
    const op = vi.fn(async (): Promise<PeerChatOpResult> => ({ ok: true }));
    const t = rig(async () => view(), op);
    await t.opened();
    t.push(update());
    await t.tick();
    expect(op).not.toHaveBeenCalled();
  });

  it('更新のたびには頼まず、turnCount が変わったときだけ頼み直す（前の古い行は残る）', async () => {
    const op = vi.fn(async (_s: string, _b: PeerChatOpIn): Promise<PeerChatOpResult> => ({ ok: true, turns: { rows: [turn('t1'), turn('t2')], total: 2, more: false } }));
    const t = rig(async () => view({ turnCount: 2 }), op);
    await t.opened();
    await t.tick();
    expect(op).toHaveBeenCalledTimes(1);
    t.push(update({ turnCount: 2, items: [item('e')] }));
    t.push(update({ turnCount: 2, items: [item('f')] }));
    await t.tick();
    expect(op).toHaveBeenCalledTimes(1);
    op.mockResolvedValueOnce({ ok: true, turns: { rows: [turn('t2'), turn('t3')], total: 3, more: true } });
    t.push(update({ turnCount: 3 }));
    await t.tick();
    expect(op).toHaveBeenCalledTimes(2);
    expect(ids(t.slice().turns)).toEqual(['t1', 't2', 't3']);
  });

  it('頼んでいる間にまた変わったら、終わってから 1 度だけ頼み直す', async () => {
    let release: (r: PeerChatOpResult) => void = () => {};
    const op = vi.fn((_s: string, _b: PeerChatOpIn) => new Promise<PeerChatOpResult>((r) => { release = r; }));
    const t = rig(async () => view({ turnCount: 1 }), op);
    await t.opened();
    t.push(update({ turnCount: 2 }));
    t.push(update({ turnCount: 3 }));
    expect(op).toHaveBeenCalledTimes(1);
    release({ ok: true, turns: { rows: [turn('t1')], total: 1, more: false } });
    await t.tick();
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('さらに読む（turnsMore）は、先頭の行の uuid を before に付けて頼み、頭に足す', async () => {
    const op = vi.fn(async (_s: string, b: PeerChatOpIn): Promise<PeerChatOpResult> => (b.t === 'turns' && b.before ? { ok: true, turns: { rows: [turn('t0')], total: 3, more: false } } : { ok: true, turns: { rows: [turn('t1'), turn('t2')], total: 3, more: true } }));
    const t = rig(async () => view({ turnCount: 3 }), op);
    await t.opened();
    await t.tick();
    t.runner.run({ op: 'turnsMore', sessionId: 's1' });
    await t.tick();
    expect(op).toHaveBeenLastCalledWith('s1', { t: 'turns', before: 't1' });
    expect(ids(t.slice().turns)).toEqual(['t0', 't1', 't2']);
    expect(t.slice().turnsMore).toBe(false);
  });
});

describe('目次の行を押したときの跳びと、古い分の読み足し（runtime/peerChat）', () => {
  const noTurns = async (): Promise<PeerChatOpResult> => ({ ok: true });

  it('本文に既にある行は、頼まずにそこへ跳ぶ', async () => {
    const op = vi.fn(noTurns);
    const t = rig(async () => view(), op);
    await t.opened();
    t.runner.run({ op: 'jump', sessionId: 's1', uuid: 'd' });
    expect(t.slice().jump).toEqual({ uuid: 'd', n: 1 });
    t.runner.run({ op: 'jump', sessionId: 's1', uuid: 'd' });
    expect(t.slice().jump).toEqual({ uuid: 'd', n: 2 });
    expect(op).not.toHaveBeenCalled();
  });

  it('本文に無い行は、from を行の uuid、before を今の先頭にして頼み、頭に足してから跳ぶ（読み足しの間は jumping）', async () => {
    let release: (r: PeerChatOpResult) => void = () => {};
    const op = vi.fn((_s: string, _b: PeerChatOpIn) => new Promise<PeerChatOpResult>((r) => { release = r; }));
    const t = rig(async () => view(), op);
    await t.opened();
    t.runner.run({ op: 'jump', sessionId: 's1', uuid: 'a' });
    expect(op).toHaveBeenCalledWith('s1', { t: 'older', before: 'c', from: 'a' });
    expect(t.slice().jumping).toBe('a');
    release({ ok: true, older: { items: [item('a'), item('b')], more: false } });
    await t.tick();
    expect(ids(joinedItems(t.slice()))).toEqual(['a', 'b', 'c', 'd']);
    expect(t.slice().jumping).toBeNull();
    expect(t.slice().jump).toEqual({ uuid: 'a', n: 1 });
  });

  it('予算で入りきらない（more）ときは、続きを頼み足して、穴のないまま頭に足す', async () => {
    const op = vi.fn(async (_s: string, b: PeerChatOpIn): Promise<PeerChatOpResult> => {
      if (b.t !== 'older') return { ok: true };
      return b.from === 'a' ? { ok: true, older: { items: [item('a'), item('b')], more: true } } : { ok: true, older: { items: [item('b'), item('x')], more: false } };
    });
    const t = rig(async () => view(), op);
    await t.opened();
    t.runner.run({ op: 'jump', sessionId: 's1', uuid: 'a' });
    await t.tick();
    await t.tick();
    expect(op).toHaveBeenCalledWith('s1', { t: 'older', before: 'c', from: 'b' });
    expect(ids(joinedItems(t.slice()))).toEqual(['a', 'b', 'x', 'c', 'd']);
    expect(t.slice().jump?.uuid).toBe('a');
  });

  it('頼みが断られたら跳ばず、jumping を外す', async () => {
    const t = rig(async () => view(), async () => ({ ok: false, reason: 'offline' }));
    await t.opened();
    t.runner.run({ op: 'jump', sessionId: 's1', uuid: 'a' });
    await t.tick();
    expect(t.slice().jumping).toBeNull();
    expect(t.slice().jump).toBeNull();
    expect(ids(t.slice().older)).toEqual([]);
  });

  it('上への読み足しは、before を今の先頭にして頼み、more が偽になれば、もう頼まない', async () => {
    const op = vi.fn(async (_s: string, _b: PeerChatOpIn): Promise<PeerChatOpResult> => ({ ok: true, older: { items: [item('a'), item('b')], more: false } }));
    const t = rig(async () => view(), op);
    await t.opened();
    t.runner.run({ op: 'older', sessionId: 's1' });
    expect(t.slice().loadingOlder).toBe(true);
    t.runner.run({ op: 'older', sessionId: 's1' });
    await t.tick();
    expect(op).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledWith('s1', { t: 'older', before: 'c' });
    expect(ids(joinedItems(t.slice()))).toEqual(['a', 'b', 'c', 'd']);
    expect(t.slice()).toMatchObject({ olderMore: false, loadingOlder: false });
    t.runner.run({ op: 'older', sessionId: 's1' });
    await t.tick();
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('古い相手（older の答えが空）は more を偽にして、頼み続けない', async () => {
    const op = vi.fn(noTurns);
    const t = rig(async () => view(), op);
    await t.opened();
    t.runner.run({ op: 'older', sessionId: 's1' });
    await t.tick();
    expect(t.slice().olderMore).toBe(false);
  });
});
