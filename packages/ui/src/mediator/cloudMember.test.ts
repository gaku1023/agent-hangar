import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { initialState, transition } from './transition.ts';
import type { Input } from './types.ts';

const action = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });

describe('クラウド同期の参加と解除の操作', () => {
  it('どれも State を変えず、cloudMember の効果にして Runtime へ渡す', () => {
    const cases: [Extract<Input, { kind: 'action' }>['action'], unknown][] = [
      [{ type: 'cloud.join.check', url: 'https://h' }, { op: 'check', url: 'https://h' }],
      [{ type: 'cloud.join.request', code: 'K7QM2XFD' }, { op: 'request', code: 'K7QM2XFD' }],
      [{ type: 'cloud.join.reenter' }, { op: 'joinReenter' }],
      [{ type: 'cloud.join.cancel' }, { op: 'joinCancel' }],
      [{ type: 'cloud.add.open' }, { op: 'addOpen' }],
      [{ type: 'cloud.add.approve' }, { op: 'addApprove' }],
      [{ type: 'cloud.add.reject' }, { op: 'addReject' }],
      [{ type: 'cloud.add.close' }, { op: 'addClose' }],
      [{ type: 'cloud.device.revoke', id: 'b' }, { op: 'revoke', id: 'b' }],
      [{ type: 'cloud.revoke.dismiss' }, { op: 'revokeDismiss' }],
      [{ type: 'cloud.leave', revoke: false }, { op: 'leave', revoke: false }],
      [{ type: 'cloud.leave.dismiss' }, { op: 'leaveDismiss' }],
      [{ type: 'cloud.phone.pair' }, { op: 'pair' }],
      [{ type: 'cloud.phone.close' }, { op: 'pairClose' }],
      [{ type: 'cloud.phone.revoke', id: 'p1' }, { op: 'phoneRevoke', id: 'p1' }],
      [{ type: 'cloud.phone.undo' }, { op: 'phoneUndo' }],
      [{ type: 'cloud.recovery.ask' }, { op: 'recoveryAsk' }],
      [{ type: 'cloud.recovery.reissue' }, { op: 'recoveryReissue' }],
      [{ type: 'cloud.recovery.saved' }, { op: 'recoverySaved' }],
      [{ type: 'cloud.recovery.reveal' }, { op: 'recoveryReveal' }],
      [{ type: 'cloud.recovery.confirm', tail: 'K2VB' }, { op: 'recoveryConfirm', tail: 'K2VB' }],
      [{ type: 'cloud.recovery.retry' }, { op: 'recoveryRetry' }],
      [{ type: 'cloud.recovery.close' }, { op: 'recoveryClose' }],
    ];
    const s = initialState();
    for (const [a, command] of cases) {
      const r = transition(s, initialStore(), action(a));
      expect(r.state).toBe(s);
      expect(r.effects).toEqual([{ kind: 'cloudMember', command }]);
    }
  });
});
