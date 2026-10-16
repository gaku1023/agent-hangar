import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { initialState, transition } from './transition.ts';
import type { Input } from './types.ts';

const action = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });

describe('クラウド同期の参加と解除の操作', () => {
  it('どれも State を変えず、cloudMember の効果にして Runtime へ渡す', () => {
    const cases: [Extract<Input, { kind: 'action' }>['action'], unknown][] = [
      [{ type: 'cloud.join.plan', token: 't' }, { op: 'plan', token: 't' }],
      [{ type: 'cloud.join.go', overwrite: true }, { op: 'join', overwrite: true }],
      [{ type: 'cloud.join.cancel' }, { op: 'joinCancel' }],
      [{ type: 'cloud.device.revoke', id: 'b' }, { op: 'revoke', id: 'b' }],
      [{ type: 'cloud.revoke.dismiss' }, { op: 'revokeDismiss' }],
      [{ type: 'cloud.leave', revoke: false }, { op: 'leave', revoke: false }],
      [{ type: 'cloud.leave.dismiss' }, { op: 'leaveDismiss' }],
      [{ type: 'cloud.phone.pair' }, { op: 'pair' }],
      [{ type: 'cloud.phone.close' }, { op: 'pairClose' }],
    ];
    const s = initialState();
    for (const [a, command] of cases) {
      const r = transition(s, initialStore(), action(a));
      expect(r.state).toBe(s);
      expect(r.effects).toEqual([{ kind: 'cloudMember', command }]);
    }
  });
});
