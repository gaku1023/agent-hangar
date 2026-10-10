import type { primitivesKeys } from '../keys/primitives.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const primitivesJa: AreaDictionary<typeof primitivesKeys> = {
  'primitives.clamp.collapse': '折りたたむ',
  'primitives.clamp.expand': '全文を表示（残り {rest} 行）',
  'primitives.commandLine.copyLabel': '{name} をコピー',
  'primitives.listbox.placeholder': '選んでください',
  'primitives.listbox.search': '{label}を検索',
  'primitives.listbox.hintMove': '移動',
  'primitives.listbox.hintChoose': '決める',
  'primitives.rollingNumber.unavailable': '未取得',
  'primitives.stepper.decrease': '{label}を減らす',
  'primitives.stepper.increase': '{label}を増やす',
};
