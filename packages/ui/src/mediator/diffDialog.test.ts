import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

// 差分のダイアログ（0.5.0 の git の表示、試作の 2-5 の A）。開いているかと、選んだファイルと出どころだけを State に持つ。中身は Store にある。

const action = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });
const run = (state: State, a: Extract<Input, { kind: 'action' }>['action']) => transition(state, initialStore(), action(a));

describe('差分のダイアログ', () => {
  it('開く、ファイルを選ぶ、出どころを替える、閉じる', () => {
    let s = run(initialState(), { type: 'diff.open', sessionId: 's1', file: '/w/a.ts' }).state;
    expect(s.overlay).toEqual({ kind: 'diff', sessionId: 's1', file: '/w/a.ts', source: null });
    s = run(s, { type: 'diff.select', file: '/w/b.ts' }).state;
    s = run(s, { type: 'diff.source', source: 'session' }).state;
    expect(s.overlay).toEqual({ kind: 'diff', sessionId: 's1', file: '/w/b.ts', source: 'session' });
    expect(run(s, { type: 'overlay.close' }).state.overlay).toEqual({ kind: 'none' });
  });
  it('ファイルを渡さなければ、選ぶのは画面に任せる（最初の未コミット）', () => {
    expect(run(initialState(), { type: 'diff.open', sessionId: 's1' }).state.overlay).toEqual({ kind: 'diff', sessionId: 's1', file: null, source: null });
  });
  it('決めるまで閉じないダイアログの上には重ねない。開いていないときの選ぶ操作は何もしない', () => {
    const confirm = { ...initialState(), overlay: { kind: 'newProject' as const } };
    expect(run(confirm, { type: 'diff.open', sessionId: 's1' }).state.overlay).toEqual({ kind: 'newProject' });
    expect(run(initialState(), { type: 'diff.select', file: '/w/a.ts' }).state.overlay).toEqual({ kind: 'none' });
  });
});
