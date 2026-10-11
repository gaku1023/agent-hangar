import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';
import { initialStore } from '../store/store.ts';
import { PROJECT_RAIL_KEY, readProjectRailFolded } from './projectRail.ts';

// プロジェクト画面の右パネルの節（TODO、指示とメモリ、アーティファクト）を折りたたんだ状態。プロジェクトごとに覚え、端末の localStorage に残す。

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, initialStore(), i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const fold = (id: string, section: 'todo' | 'instructions' | 'artifacts', open: boolean): Input => ({ kind: 'action', action: { type: 'project.railFold', id, section, open } });

describe('右パネルの節の折りたたみ（プロジェクトごと）', () => {
  it('はじめは、どのプロジェクトも 3 つとも開いている', () => {
    expect(initialState().projectRailFolded).toEqual({});
  });
  it('折りたたむと、そのプロジェクトの節だけを覚えて保存する', () => {
    const a = run([fold('alpha', 'artifacts', false)]);
    expect(a.state.projectRailFolded).toEqual({ alpha: ['artifacts'] });
    expect(a.effects).toEqual([{ kind: 'storage.save', key: PROJECT_RAIL_KEY, value: { alpha: ['artifacts'] } }]);
  });
  it('プロジェクトごとに別に覚える。並びは節の順にそろえる', () => {
    const a = run([fold('alpha', 'artifacts', false), fold('alpha', 'todo', false), fold('beta', 'instructions', false)]);
    expect(a.state.projectRailFolded).toEqual({ alpha: ['todo', 'artifacts'], beta: ['instructions'] });
  });
  it('開き直すと忘れ、全部開いたプロジェクトは鍵ごと消す', () => {
    const a = run([fold('alpha', 'artifacts', false), fold('alpha', 'todo', false), fold('alpha', 'artifacts', true)]);
    expect(a.state.projectRailFolded).toEqual({ alpha: ['todo'] });
    const b = run([fold('alpha', 'todo', true)], a.state);
    expect(b.state.projectRailFolded).toEqual({});
    expect(b.effects).toEqual([{ kind: 'storage.save', key: PROJECT_RAIL_KEY, value: {} }]);
  });
  it('同じ形への切り替えは何もしない（保存もしない）', () => {
    const a = run([fold('alpha', 'todo', true)]);
    expect(a.state.projectRailFolded).toEqual({});
    expect(a.effects).toEqual([]);
  });
  it('読み戻すとき、形の違う値（手で書き換えられたなど）は捨てる', () => {
    expect(readProjectRailFolded(null)).toEqual({});
    expect(readProjectRailFolded(['todo'])).toEqual({});
    expect(readProjectRailFolded({ alpha: ['artifacts', 'nope', 'todo', 'todo'], beta: 'todo', gamma: [] })).toEqual({ alpha: ['todo', 'artifacts'] });
  });
});
