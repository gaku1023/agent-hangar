import type { phoneLaunchKeys } from '../keys/phoneLaunch.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const phoneLaunchJa: AreaDictionary<typeof phoneLaunchKeys> = {
  'phoneLaunch.label.plain': 'スマホから',
  'phoneLaunch.label.bypass': 'スマホから · Bypass permissions',
  'phoneLaunch.label.title': 'スマホから起動したセッション',
  'phoneLaunch.notice.head': 'スマホから起動',
  'phoneLaunch.notice.headBypass': 'スマホから起動 · Bypass permissions',
  'phoneLaunch.notice.title': '{phone} から起動：{project}（{mode}）',
  'phoneLaunch.notice.titleUnknown': 'スマホから起動：{project}（{mode}）',
  'phoneLaunch.notice.bypassNote': 'Claude はツールを使用する前に確認しません。心当たりがない場合は停止してください。',
  'phoneLaunch.notice.more': 'スマホから起動した他 {n} 件',
  'phoneLaunch.button.open': '開く',
  'phoneLaunch.button.stop': '停止',
};
