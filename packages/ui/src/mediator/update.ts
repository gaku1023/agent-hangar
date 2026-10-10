import type { UpdateCommand } from '../runtime/updater.ts';
import type { Input, State, Step } from './types.ts';

/**
 * update 領域：アプリの自動更新（段 5-4）。
 * 更新の段階（確認中、新しい版あり、取得中、準備完了、失敗）は殻の updater の結果で、Runtime しか知らない事実なので、Store が持つ（store/update.ts）。
 * ここは画面の操作を効果にするだけで、State は変えない（通知の切り替えの notify.ts と同じ作り）。
 * 効果は Runtime が runtime/updater.ts の run に渡す。
 */
export function updateStep(state: State, input: Input): Step | null {
  if (input.kind !== 'action') return null;
  const a = input.action;
  const command: UpdateCommand | null = a.type === 'update.check' ? { op: 'check' }
    : a.type === 'update.download' ? { op: 'download' }
      : a.type === 'update.install' ? { op: 'install' }
        : a.type === 'update.dismiss' ? { op: 'dismiss' }
          : a.type === 'update.notify' ? { op: 'notify', on: a.on }
            : null;
  return command ? { state, effects: [{ kind: 'update', command }] } : null;
}
