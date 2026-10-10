import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';
import { initialStore } from '../store/store.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, initialStore(), i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const intent = (i: Extract<Input, { kind: 'intent' }>['intent']): Input => ({ kind: 'intent', intent: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const toggle = (projectId: string, section: 'archived') => intent({ type: 'project.section.toggle', projectId, section });

describe('プロジェクト画面の節を広げる（P3）', () => {
  it('はじめは何も広げていない', () => {
    expect(initialState().sectionsOpen).toEqual({});
  });
  it('Archived をプロジェクトごとに広げ、もう一度押すと畳む。効果は出さない', () => {
    const a = run([toggle('p1', 'archived')]);
    expect(a.state.sectionsOpen).toEqual({ p1: ['archived'] });
    expect(a.effects).toEqual([]);
    const b = run([toggle('p2', 'archived')], a.state);
    expect(b.state.sectionsOpen).toEqual({ p1: ['archived'], p2: ['archived'] });
    const c = run([toggle('p1', 'archived')], b.state);
    expect(c.state.sectionsOpen).toEqual({ p2: ['archived'] });
  });
  it('画面を移っても、戻れば広げたまま', () => {
    const a = run([toggle('p1', 'archived'), runtime({ type: 'hash.changed', route: { name: 'home' } }), runtime({ type: 'hash.changed', route: { name: 'project', id: 'p1' } })]);
    expect(a.state.sectionsOpen).toEqual({ p1: ['archived'] });
  });
});
