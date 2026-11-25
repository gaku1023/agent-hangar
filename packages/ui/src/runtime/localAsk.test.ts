import { describe, expect, it, vi } from 'vitest';
import { translator, type PeerChatAsk } from '@agent-hangar/shared';
import { askUpdated } from '../store/localAsk.ts';
import { initialStore, type Store } from '../store/store.ts';
import { createLocalAskRunner, type LocalAskAnswerResult } from './localAsk.ts';

const ask: PeerChatAsk = { askId: 'a1', kind: 'permission', options: [{ key: 'once', label: '1 回だけ許可' }], multi: false, allowText: false };

function setup(result: () => Promise<LocalAskAnswerResult>) {
  let store: Store = askUpdated({ ...initialStore(), device: { id: 'd', name: 'Mac' } }, 's1', ask);
  const answer = vi.fn(result);
  const failed = vi.fn();
  const delivered = vi.fn();
  const runner = createLocalAskRunner({ answer, get: () => store, set: (s) => { store = s; }, failed, delivered, t: () => translator('ja') });
  return { runner, answer, failed, delivered, store: () => store };
}

describe('createLocalAskRunner', () => {
  it('送っている間は pending で、通ったら記録の文を持つ', async () => {
    let release!: (r: LocalAskAnswerResult) => void;
    const s = setup(() => new Promise((res) => { release = res; }));
    const p = s.runner.run({ op: 'answer', sessionId: 's1', askId: 'a1', keys: ['once'] });
    expect(s.store().localAsks.s1!.pending).toBe(true);
    expect(s.answer).toHaveBeenCalledWith('s1', { askId: 'a1', keys: ['once'] });
    release({ ok: true, label: '1 回だけ許可' });
    await p;
    expect(s.store().localAsks.s1).toMatchObject({ pending: false, answered: 'Mac で 1 回だけ許可' });
    expect(s.delivered).toHaveBeenCalledWith('s1');
    expect(s.failed).not.toHaveBeenCalled();
  });

  it('text があれば本文に載せる', async () => {
    const s = setup(async () => ({ ok: true, label: 'x' }));
    await s.runner.run({ op: 'answer', sessionId: 's1', askId: 'a1', keys: [], text: 'はい' });
    expect(s.answer).toHaveBeenCalledWith('s1', { askId: 'a1', keys: [], text: 'はい' });
  });

  it('断られたら pending を解き、断りの知らせを出す', async () => {
    const s = setup(async () => ({ ok: false, reason: 'already-answered' }));
    await s.runner.run({ op: 'answer', sessionId: 's1', askId: 'a1', keys: ['once'] });
    expect(s.store().localAsks.s1).toMatchObject({ pending: false, answered: null });
    expect(s.failed).toHaveBeenCalledWith('s1');
    expect(s.delivered).not.toHaveBeenCalled();
  });

  it('通信が落ちても同じ扱い', async () => {
    const s = setup(async () => { throw new Error('net'); });
    await s.runner.run({ op: 'answer', sessionId: 's1', askId: 'a1', keys: ['once'] });
    expect(s.store().localAsks.s1!.pending).toBe(false);
    expect(s.failed).toHaveBeenCalledWith('s1');
  });

  it('別の札や、もう無い札には送らない', async () => {
    const s = setup(async () => ({ ok: true, label: 'x' }));
    await s.runner.run({ op: 'answer', sessionId: 's1', askId: 'other', keys: ['once'] });
    await s.runner.run({ op: 'answer', sessionId: 's9', askId: 'a1', keys: ['once'] });
    expect(s.answer).not.toHaveBeenCalled();
  });

  it('settle は記録を片付ける', async () => {
    const s = setup(async () => ({ ok: true, label: '許可' }));
    await s.runner.run({ op: 'answer', sessionId: 's1', askId: 'a1', keys: ['once'] });
    await s.runner.run({ op: 'settle', sessionId: 's1' });
    expect(s.store().localAsks.s1).toBeUndefined();
  });
});
