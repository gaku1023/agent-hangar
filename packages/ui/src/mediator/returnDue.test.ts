import { describe, expect, it } from 'vitest';
import type { SessionDto, SessionStateDto } from '@agent-hangar/shared';
import { dueReturnKeys, nextReturnAt, readReturnSeen, RETURN_SEEN_KEY, returnStep, sessionIdOfReturnKey } from './returnDue.ts';
import { initialState } from './transition.ts';
import type { State } from './types.ts';

/** 2026-10-05（月）。時刻は手元の時刻で作る。 */
const at = (h: number, min = 0, d = 5) => new Date(2026, 9, d, h, min).getTime();
const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null, ...o });
const paused = (id: string, returnOn: string | null, returnTime: string | null): SessionDto => ({ id, name: id, state: st({ status: 'paused', note: `${id} を見る`, returnOn, returnTime, setBy: 'user', setAt: 1 }) } as unknown as SessionDto);
const sessions = (...list: SessionDto[]) => Object.fromEntries(list.map((s) => [s.id, s]));
const due = (keys: string[]) => ({ kind: 'runtime' as const, event: { type: 'return.due' as const, keys } });

describe('dueReturnKeys', () => {
  const all = sessions(
    paused('timer', '2026-10-05', '13:30'), paused('night', '2026-10-05', '21:50'), paused('allday', '2026-10-05', null),
    paused('old', '2026-10-03', '09:00'), paused('next', '2026-10-06', '09:00'), paused('broken', '2026-10-05', '25:00'),
    { id: 'done', name: 'done', state: st({ status: 'done', returnOn: '2026-10-05', returnTime: '09:00' }) } as unknown as SessionDto,
    { id: 'legacy', name: 'legacy' } as unknown as SessionDto,
  );
  it('時刻つきの Paused のうち、今日その時刻を過ぎたものだけを、時点を含む鍵で返す', () => {
    expect(dueReturnKeys(all, at(13, 29))).toEqual([]);
    expect(dueReturnKeys(all, at(13, 30))).toEqual(['timer|2026-10-05 13:30']);
    expect(dueReturnKeys(all, at(22))).toEqual(['night|2026-10-05 21:50', 'timer|2026-10-05 13:30']);
  });
  it('日付だけの Paused、前の日に過ぎたもの、形の違う時刻は知らせない', () => {
    const keys = dueReturnKeys(all, at(23, 59));
    for (const id of ['allday', 'old', 'broken', 'done', 'legacy', 'next']) expect(keys.some((k) => k.startsWith(`${id}|`)), id).toBe(false);
    // 日が変わると、昨日の分は外れる。
    expect(dueReturnKeys(all, at(9, 0, 6))).toEqual(['next|2026-10-06 09:00']);
  });
  it('鍵からセッションの id を取り出せる', () => {
    expect(sessionIdOfReturnKey('timer|2026-10-05 13:30')).toBe('timer');
  });
});

describe('nextReturnAt', () => {
  it('これから来るいちばん近い時点を返す。無ければ null', () => {
    const all = sessions(paused('timer', '2026-10-05', '13:30'), paused('night', '2026-10-05', '21:50'), paused('next', '2026-10-06', '09:00'), paused('allday', '2026-10-07', null));
    expect(nextReturnAt(all, at(12))).toBe(at(13, 30));
    expect(nextReturnAt(all, at(13, 30))).toBe(at(21, 50));
    expect(nextReturnAt(all, at(22))).toBe(at(9, 0, 6));
    expect(nextReturnAt(all, at(10, 0, 6))).toBeNull();
  });
});

describe('returnStep', () => {
  const K1 = 'timer|2026-10-05 13:30';
  const K2 = 'night|2026-10-05 21:50';
  // 右下の札は入力待ちだけになった（PR 29）。戻る時刻は OS の通知と、ベルの一覧の行（presenters/notices.ts）で知らせる。
  it('新しく過ぎたものに通知の効果を出し、知らせた鍵を覚える。画面の状態は増やさない', () => {
    const r = returnStep(initialState(), due([K1]))!;
    expect(r.state.returnSeen).toEqual([K1]);
    expect('returnToasts' in r.state).toBe(false);
    expect(r.effects).toEqual([{ kind: 'notify.return', sessionId: 'timer' }, { kind: 'storage.save', key: RETURN_SEEN_KEY, value: [K1] }]);
  });
  it('すでに知らせた鍵では、通知も出さない（1 回だけ）', () => {
    const seen: State = { ...initialState(), returnSeen: [K1] };
    const r = returnStep(seen, due([K1, K2]))!;
    expect(r.effects).toEqual([{ kind: 'notify.return', sessionId: 'night' }, { kind: 'storage.save', key: RETURN_SEEN_KEY, value: [K1, K2] }]);
    // 同じ並びがもう一度届いても何もしない。
    expect(returnStep(r.state, due([K1, K2]))).toEqual({ state: r.state, effects: [] });
  });
  it('過ぎたものから外れたら（resume や付け直し）、鍵を忘れる。時刻を付け直せばまた知らせる', () => {
    const first = returnStep(initialState(), due([K1]))!.state;
    const gone = returnStep(first, due([]))!;
    expect(gone.state.returnSeen).toEqual([]);
    expect(gone.effects).toEqual([{ kind: 'storage.save', key: RETURN_SEEN_KEY, value: [] }]);
    const again = returnStep(gone.state, due(['timer|2026-10-05 15:00']))!;
    expect(again.effects[0]).toEqual({ kind: 'notify.return', sessionId: 'timer' });
  });
  it('いま開いているセッションでも通知の効果は出す（窓が背面かはランタイムが見る）', () => {
    const open: State = { ...initialState(), screen: { name: 'session', id: 'timer' } };
    const r = returnStep(open, due([K1]))!;
    expect(r.effects[0]).toEqual({ kind: 'notify.return', sessionId: 'timer' });
  });
  it('ほかの入力は扱わない（札を下げる意図は無くなった）', () => {
    expect(returnStep(initialState(), { kind: 'runtime', event: { type: 'window.focus' } })).toBeNull();
    expect(returnStep(initialState(), { kind: 'intent', intent: { type: 'nav.go', to: { name: 'home' } } })).toBeNull();
  });
});

describe('readReturnSeen', () => {
  it('文字列の並びだけを通し、壊れた値は空にする', () => {
    expect(readReturnSeen(['a|2026-10-05 13:30', 5, null])).toEqual(['a|2026-10-05 13:30']);
    expect(readReturnSeen(undefined)).toEqual([]);
    expect(readReturnSeen('x')).toEqual([]);
  });
});
