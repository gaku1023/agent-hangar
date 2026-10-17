import type { CloudMemberCommand } from '../runtime/cloudMember.ts';
import type { Input, State, Step } from './types.ts';

/**
 * cloud 領域：参加コードでの参加と「PC を追加」、PC の解除と、この PC の参加の解除。
 * 段（接続先の確認、承認待ち、解除中など）は殻の命令とサーバーの結果で、Runtime しか知らない事実なので、Store が持つ（store/cloudMember.ts）。
 * ここは画面の操作を効果にするだけで、State は変えない（更新の update.ts と同じ作り）。
 * 効果は Runtime が runtime/cloudMember.ts の run に渡す。
 */
export function cloudMemberStep(state: State, input: Input): Step | null {
  if (input.kind !== 'action') return null;
  const command = commandOf(input.action);
  return command ? { state, effects: [{ kind: 'cloudMember', command }] } : null;
}

function commandOf(a: Extract<Input, { kind: 'action' }>['action']): CloudMemberCommand | null {
  switch (a.type) {
    case 'cloud.join.check': return { op: 'check', url: a.url };
    case 'cloud.join.request': return { op: 'request', code: a.code };
    case 'cloud.join.reenter': return { op: 'joinReenter' };
    case 'cloud.join.cancel': return { op: 'joinCancel' };
    case 'cloud.add.open': return { op: 'addOpen' };
    case 'cloud.add.approve': return { op: 'addApprove' };
    case 'cloud.add.reject': return { op: 'addReject' };
    case 'cloud.add.close': return { op: 'addClose' };
    case 'cloud.device.revoke': return { op: 'revoke', id: a.id };
    case 'cloud.revoke.dismiss': return { op: 'revokeDismiss' };
    case 'cloud.leave': return { op: 'leave', revoke: a.revoke };
    case 'cloud.leave.dismiss': return { op: 'leaveDismiss' };
    case 'cloud.phone.pair': return { op: 'pair' };
    case 'cloud.phone.close': return { op: 'pairClose' };
    case 'cloud.phone.revoke': return { op: 'phoneRevoke', id: a.id };
    case 'cloud.phone.undo': return { op: 'phoneUndo' };
    case 'cloud.recovery.ask': return { op: 'recoveryAsk' };
    case 'cloud.recovery.reissue': return { op: 'recoveryReissue' };
    case 'cloud.recovery.saved': return { op: 'recoverySaved' };
    case 'cloud.recovery.reveal': return { op: 'recoveryReveal' };
    case 'cloud.recovery.confirm': return { op: 'recoveryConfirm', tail: a.tail };
    case 'cloud.recovery.retry': return { op: 'recoveryRetry' };
    case 'cloud.recovery.close': return { op: 'recoveryClose' };
    default: return null;
  }
}
