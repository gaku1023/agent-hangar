import type { stopKeys } from '../keys/stop.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const stopJa: AreaDictionary<typeof stopKeys> = {
  'stop.state.permission': '許可待ち',
  'stop.state.limit': '使用制限',
  'stop.state.reset': 'リセット済み',
  'stop.kind.fiveHour': '5 時間',
  'stop.kind.weekly': '週',
  'stop.kind.other': '使用制限',
  'stop.time.otherDay': '{date} {time}',
  'stop.notify.permission': '許可待ち：{tool} {input}',
  'stop.notify.permissionTool': '許可待ち：{tool}',
  'stop.notify.permissionBare': '許可待ちです',
  'stop.notify.limitTitle': '使用制限（{kind}）',
  'stop.notify.limitOne': '{name} が止まりました。{time} にリセットされます',
  'stop.notify.limitMany': '{n} 件のセッションが止まりました。{time} にリセットされます',
  'stop.notify.reset': '使用制限がリセットされました。続きを指示してください',
};
