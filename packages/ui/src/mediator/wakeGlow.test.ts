import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { initialState, transition } from './transition.ts';
import type { Input } from './types.ts';
import { WAKE_GLOW_KEPT } from './wakeGlow.ts';

const server = (event: Extract<Input, { kind: 'server' }>['event']): Input => ({ kind: 'server', event });
const seen = (id: string): Input => ({ kind: 'action', action: { type: 'wakeGlow.seen', id } });
const run = (input: Input, state = initialState()) => transition(state, initialStore(), input).state;

describe('起こした行の光り（wakeGlow）', () => {
  it('session.woken を受けると、その会話の印を時刻つきで覚える。同じ会話は 1 つにまとめる', () => {
    const a = run(server({ type: 'session.woken', id: 's1', at: 100 }));
    expect(a.wakeGlow).toEqual([{ id: 's1', at: 100 }]);
    const b = run(server({ type: 'session.woken', id: 's2', at: 200 }), a);
    const c = run(server({ type: 'session.woken', id: 's1', at: 300 }), b);
    expect(c.wakeGlow).toEqual([{ id: 's2', at: 200 }, { id: 's1', at: 300 }]);
  });
  it('光らせ終えたら、その印だけを下げる（1 度だけ光らせる）', () => {
    const a = run(server({ type: 'session.woken', id: 's1', at: 100 }));
    const b = run(server({ type: 'session.woken', id: 's2', at: 200 }), a);
    expect(run(seen('s1'), b).wakeGlow).toEqual([{ id: 's2', at: 200 }]);
    // 無い印の取り下げは、状態を動かさない。
    const same = initialState();
    expect(run(seen('x'), same)).toBe(same);
  });
  it('印は新しい方から数えて上限まで。行が出ないまま残った古い印は、新しい印が来たときに落ちる', () => {
    let s = initialState();
    for (let i = 0; i < WAKE_GLOW_KEPT + 3; i++) s = run(server({ type: 'session.woken', id: `s${i}`, at: i }), s);
    expect(s.wakeGlow).toHaveLength(WAKE_GLOW_KEPT);
    expect(s.wakeGlow[0]!.id).toBe('s3');
  });
});
