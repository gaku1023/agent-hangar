import { describe, expect, it } from 'vitest';
import type { PeerChatAsk } from '@agent-hangar/shared';
import { initialStore } from './store.ts';
import { askAnswered, askAnswerFailed, askAnswerStarted, askSettled, askUpdated, asksOf } from './localAsk.ts';

const ask = (askId: string, over: Partial<PeerChatAsk> = {}): PeerChatAsk => ({ askId, kind: 'permission', options: [{ key: 'a', label: '許可' }], multi: false, allowText: false, ...over });

describe('localAsk', () => {
  it('bootstrap の peerAsks を会話ごとの札にする。無ければ空として読む', () => {
    expect(asksOf(undefined)).toEqual({});
    expect(asksOf({ s1: ask('a1') })).toEqual({ s1: { ask: ask('a1'), pending: false, answered: null, gone: false } });
  });

  it('札が出たら置き、替わったら置き換え、閉じたら外す', () => {
    let s = askUpdated(initialStore(), 's1', ask('a1'));
    expect(s.localAsks.s1!.ask.askId).toBe('a1');
    s = askUpdated(s, 's1', ask('a2'));
    expect(s.localAsks.s1!.ask.askId).toBe('a2');
    s = askUpdated(s, 's1', null);
    expect(s.localAsks.s1).toBeUndefined();
  });

  it('同じ札の知らせは、送っている状態を壊さない', () => {
    let s = askUpdated(initialStore(), 's1', ask('a1'));
    s = askAnswerStarted(s, 's1', 'a1');
    s = askUpdated(s, 's1', ask('a1'));
    expect(s.localAsks.s1!.pending).toBe(true);
  });

  it('答えを送っている間は pending、通ったら記録を持ち、札が閉じても記録は残る', () => {
    let s = askAnswerStarted(askUpdated(initialStore(), 's1', ask('a1')), 's1', 'a1');
    expect(s.localAsks.s1!.pending).toBe(true);
    s = askAnswered(s, 's1', 'a1', 'Mac で 許可');
    expect(s.localAsks.s1).toMatchObject({ pending: false, answered: 'Mac で 許可' });
    s = askUpdated(s, 's1', null);
    expect(s.localAsks.s1!.answered).toBe('Mac で 許可');
    s = askSettled(s, 's1');
    expect(s.localAsks.s1).toBeUndefined();
  });

  it('答えの結果が着く前に札が閉じても、記録は着いたとき出る', () => {
    let s = askAnswerStarted(askUpdated(initialStore(), 's1', ask('a1')), 's1', 'a1');
    s = askUpdated(s, 's1', null);
    expect(s.localAsks.s1).toMatchObject({ pending: true, gone: true });
    s = askAnswered(s, 's1', 'a1', 'X');
    expect(s.localAsks.s1!.answered).toBe('X');
  });

  it('断られたら pending を解く。札がもう無ければ外す', () => {
    let s = askAnswerStarted(askUpdated(initialStore(), 's1', ask('a1')), 's1', 'a1');
    s = askAnswerFailed(s, 's1', 'a1');
    expect(s.localAsks.s1).toMatchObject({ pending: false, answered: null });
    s = askAnswerStarted(s, 's1', 'a1');
    s = askUpdated(s, 's1', null);
    s = askAnswerFailed(s, 's1', 'a1');
    expect(s.localAsks.s1).toBeUndefined();
  });

  it('別の札への結果は何もしない', () => {
    const s = askUpdated(initialStore(), 's1', ask('a2'));
    expect(askAnswered(s, 's1', 'a1', 'X')).toBe(s);
    expect(askAnswerFailed(s, 's1', 'a1')).toBe(s);
  });
});
