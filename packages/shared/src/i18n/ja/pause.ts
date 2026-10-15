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
  'pause.field.timeHint': '空の場合は、その日になるとホームに表示されます',
  'pause.field.reason': '理由',
  'pause.field.reasonPlaceholder': '明日の朝、本番の CPU 使用率を確認する',
  'pause.field.count': '{n} / {max} 文字',
  'pause.choice.none': '日付なし',
  'pause.field.timeHintNone': '日付なしの場合、ホームの「今日」には表示されません。一覧の Paused で確認できます',
};
