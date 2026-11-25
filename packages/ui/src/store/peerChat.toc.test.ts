import { describe, expect, it } from 'vitest';
import type { PeerChatItem, PeerChatTurn, PeerChatUpdate } from '@agent-hangar/shared';
import { applyOlder, applyTurns, applyUpdate, emptySlice, joinedItems } from './peerChat.ts';

const item = (uuid: string): PeerChatItem => ({ uuid, at: 1, kind: 'assistant', text: uuid });
const turn = (uuid: string): PeerChatTurn => ({ uuid, at: 1, text: uuid, tools: 0 });
const upd = (over: Partial<PeerChatUpdate> = {}): PeerChatUpdate => ({ sessionId: 's1', link: 'online', replace: false, status: 'busy', items: [], queued: [], cursor: 'c', ...over });
const live = (items: string[]) => applyUpdate(emptySlice('v'), upd({ items: items.map(item) }));
const ids = (xs: { uuid: string }[]) => xs.map((x) => x.uuid);

describe('目次と古い分の継ぎ目（store/peerChat）', () => {
  it('turnCount を覚える。無い更新（古い相手）では null のまま', () => {
    expect(applyUpdate(emptySlice('v'), upd()).turnCount).toBeNull();
    const s = applyUpdate(emptySlice('v'), upd({ turnCount: 5 }));
    expect(s.turnCount).toBe(5);
    expect(applyUpdate(s, upd()).turnCount).toBe(5);
    expect(applyUpdate(s, upd({ turnCount: 6 })).turnCount).toBe(6);
  });

  it('古い分は本文の頭に足り、同じ項目は重ねず、more を覚える', () => {
    const s = applyOlder({ ...live(['c', 'd']), loadingOlder: true }, [item('a'), item('b'), item('c')], true);
    expect(ids(s.older)).toEqual(['a', 'b']);
    expect(ids(joinedItems(s))).toEqual(['a', 'b', 'c', 'd']);
    expect(s.olderMore).toBe(true);
    expect(s.loadingOlder).toBe(false);
    const t = applyOlder(s, [item('x')], false);
    expect(ids(joinedItems(t))).toEqual(['x', 'a', 'b', 'c', 'd']);
    expect(t.olderMore).toBe(false);
  });

  it('末尾の更新（tail の update）は古い分を消さない。末尾が重なって来ても二重にならない', () => {
    let s = applyOlder(live(['c', 'd']), [item('a'), item('b')], true);
    s = applyUpdate(s, upd({ items: [item('e')] }));
    expect(ids(joinedItems(s))).toEqual(['a', 'b', 'c', 'd', 'e']);
    s = applyUpdate(s, upd({ items: [item('b'), item('c')], replace: false }));
    expect(ids(joinedItems(s))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('replace が古い分とつながる（重なる）ときは古い分を残し、つながらないときは捨てて more を開け直す', () => {
    const base = applyOlder(live(['c', 'd']), [item('a'), item('b')], false);
    const joined = applyUpdate(base, upd({ replace: true, items: [item('d'), item('e')] }));
    expect(ids(joinedItems(joined))).toEqual(['a', 'b', 'c', 'd', 'e']);
    const gap = applyUpdate(base, upd({ replace: true, items: [item('x'), item('y')] }));
    expect(ids(joinedItems(gap))).toEqual(['x', 'y']);
    expect(gap.olderMore).toBe(true);
  });

  it('目次の最新の頁は、前に読んだ古い行を残してつなぐ。つながらなければ差し替える', () => {
    let s = applyTurns({ ...live(['a']), turnCount: 3 }, { rows: [turn('t1'), turn('t2'), turn('t3')], total: 3, more: true }, null);
    expect(ids(s.turns)).toEqual(['t1', 't2', 't3']);
    expect(s.turnsMore).toBe(true);
    s = applyTurns(s, { rows: [turn('t0')], total: 4, more: false }, 't1');
    expect(ids(s.turns)).toEqual(['t0', 't1', 't2', 't3']);
    expect(s.turnsMore).toBe(false);
    const again = applyTurns(s, { rows: [turn('t3'), turn('t4')], total: 5, more: true }, null);
    expect(ids(again.turns)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(again.turnsMore).toBe(false);
    const far = applyTurns(s, { rows: [turn('t8'), turn('t9')], total: 9, more: true }, null);
    expect(ids(far.turns)).toEqual(['t8', 't9']);
    expect(far.turnsMore).toBe(true);
    expect(far.turnsLoaded).toBe(true);
  });
});
