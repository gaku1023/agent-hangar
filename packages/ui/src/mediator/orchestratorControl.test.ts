import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { initialState, transition } from './transition.ts';

describe('柱のメニューの操作', () => {
  it('会話を新しくする・停止・再開は、統括の効果にする', () => {
    for (const op of ['fresh', 'stop', 'wake'] as const) {
      const r = transition(initialState(), initialStore(), { kind: 'action', action: { type: 'orchestrator.control', op } });
      expect(r.effects).toEqual([{ kind: 'orchestrator', command: { op } }]);
    }
  });
});
