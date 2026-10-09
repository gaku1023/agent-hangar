import type { pauseKeys } from '../keys/pause.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const pauseJa: AreaDictionary<typeof pauseKeys> = {
  'pause.dialog.title': 'Paused にする',
  'pause.dialog.action': 'Paused にする',
  'pause.dialog.draftTag': '提案',
  'pause.session.unnamed': '（名前なし）',
  'pause.choices.aria': 'リマインダーの日付の候補',
  'pause.choice.today': '今日の夕方',
  'pause.choice.tomorrow': '明日',
  'pause.choice.monday': '月曜',
  'pause.choice.nextWeek': '来週',
  'pause.choice.pick': '日付を選択…',
  'pause.field.date': 'リマインダーの日付',
  'pause.field.time': 'リマインダーの時刻（任意）',
  'pause.field.timeHint': '空なら、その日のうち',
  'pause.field.reason': '理由',
  'pause.field.reasonPlaceholder': '明日の朝、本番の CPU の数字を見る',
  'pause.field.count': '{n} / {max} 字',
};
