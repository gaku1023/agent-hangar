import { describe, expect, it } from 'vitest';
import type { SessionDto, SessionStateDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { notifyKeep } from './notify.ts';

/** 2026-10-05 の手元の時刻。 */
const at = (h: number, min = 0) => new Date(2026, 9, 5, h, min).getTime();
const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null, ...o });
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, name: id, live: null, state: null, lastActivityAt: 1, ...over } as unknown as SessionDto);
const storeOf = (...list: SessionDto[]): Store => ({ ...initialStore(), sessions: Object.fromEntries(list.map((s) => [s.id, s])) });

describe('notifyKeep', () => {
  it('通知センターに残してよいのは、いま入力待ちのセッションと、今日の戻る時刻を過ぎてまだ Paused のセッションの知らせ', () => {
    const store = storeOf(
      session('w2', { live: 'waiting', lastActivityAt: 1 }),
      session('w1', { live: 'waiting', lastActivityAt: 2 }),
      session('busy', { live: 'busy' }),
      session('due', { state: st({ status: 'paused', returnOn: '2026-10-05', returnTime: '13:30' }) }),
      session('later', { state: st({ status: 'paused', returnOn: '2026-10-05', returnTime: '21:50' }) }),
      session('resumed', { state: st({ status: 'done', returnOn: '2026-10-05', returnTime: '09:00' }) }),
    );
    expect(notifyKeep(store, at(14))).toEqual({ waiting: ['w1', 'w2'], returning: ['due'], limited: [] });
  });
  it('入力待ちの並びが変わっても、同じ顔ぶれなら同じ答えにする（殻を呼び直さない）', () => {
    const a = storeOf(session('a', { live: 'waiting', lastActivityAt: 1 }), session('b', { live: 'waiting', lastActivityAt: 2 }));
    const b = storeOf(session('a', { live: 'waiting', lastActivityAt: 3 }), session('b', { live: 'waiting', lastActivityAt: 2 }));
    expect(notifyKeep(a, at(9))).toEqual(notifyKeep(b, at(9)));
  });
  it('Done や Archived にしたセッションは、live が waiting のままでも入力待ちの知らせを残さない。Paused は残す', () => {
    const store = storeOf(
      session('done', { live: 'waiting', state: st({ status: 'done', setBy: 'user', setAt: 1 }) }),
      session('archived', { live: 'waiting', state: st({ status: 'archived', setBy: 'user', setAt: 1 }) }),
      session('paused', { live: 'waiting', state: st({ status: 'paused', setBy: 'user', setAt: 1 }) }),
      session('w', { live: 'waiting' }),
    );
    expect(notifyKeep(store, at(9)).waiting).toEqual(['paused', 'w']);
  });
  it('使用制限でリセットを待っているセッションの知らせを残す。リセット済みは入力待ちとして残す', () => {
    const limit = { kind: 'five_hour' as const, resetsAt: 1, auto: true, reset: false };
    const store = storeOf(
      session('lim', { live: 'idle', limit }),
      session('reset', { live: 'idle', limit: { ...limit, reset: true } }),
      session('busy', { live: 'busy', limit }),
    );
    expect(notifyKeep(store, at(9))).toEqual({ waiting: ['reset'], returning: [], limited: ['lim'] });
  });
  it('何も待っていなければ、どちらも空', () => {
    expect(notifyKeep(storeOf(session('x')), at(9))).toEqual({ waiting: [], returning: [], limited: [] });
  });
});
