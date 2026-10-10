import type { commonKeys } from '../keys/common.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const commonJa: AreaDictionary<typeof commonKeys> = {
  'common.button.cancel': 'キャンセル',
  'common.field.send': '{field} を送ってください',
  'common.field.sendString': '{field} は文字列で送ってください',
  'common.field.required': '{field} は必須です',
  'common.field.mustBeString': '{field} は文字列です',
  'common.field.needed': '{field} が要ります',
  'common.field.mustBeBoolean': '{field} は true か false です',
  'common.file.sourceMissing': '元のファイルが見つかりません',
  'common.list.or': ' か ',
  'common.list.separator': '、',
  'common.chip.nameValue': '{name}、{value}',
  'common.popover.details': '詳細',
  'common.label.uncategorized': '未分類',
};
