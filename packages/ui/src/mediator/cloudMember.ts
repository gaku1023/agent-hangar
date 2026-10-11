import type { CloudMemberCommand } from '../runtime/cloudMember.ts';
import type { Input, State, Step } from './types.ts';

/**
 * cloud 領域：クラウド同期への参加と、PC の解除と、この PC の参加の解除（0.4.0）。
 * 段（宛先の確認、参加中、解除中など）は殻の命令の結果で、Runtime しか知らない事実なので、Store が持つ（store/cloudMember.ts）。
 * ここは画面の操作を効果にするだけで、State は変えない（更新の update.ts と同じ作り）。
 * 効果は Runtime が runtime/cloudMember.ts の run に渡す。
 */
export function cloudMemberStep(state: State, input: Input): Step | null {
  if (input.kind !== 'action') return null;
  const a = input.action;
  const command: CloudMemberCommand | null = a.type === 'cloud.join.plan' ? { op: 'plan', token: a.token }
    : a.type === 'cloud.join.go' ? { op: 'join', overwrite: a.overwrite }
      : a.type === 'cloud.join.cancel' ? { op: 'joinCancel' }
        : a.type === 'cloud.device.revoke' ? { op: 'revoke', id: a.id }
          : a.type === 'cloud.revoke.dismiss' ? { op: 'revokeDismiss' }
            : a.type === 'cloud.leave' ? { op: 'leave', revoke: a.revoke }
              : a.type === 'cloud.leave.dismiss' ? { op: 'leaveDismiss' }
                : null;
  return command ? { state, effects: [{ kind: 'cloudMember', command }] } : null;
}
