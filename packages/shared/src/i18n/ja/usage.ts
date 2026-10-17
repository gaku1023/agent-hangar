import type { usageKeys } from '../keys/usage.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const usageJa: AreaDictionary<typeof usageKeys> = {
  'usage.statusline.badPayload': 'ステータスラインの payload の形式が正しくありません',
  'usage.days.invalid': 'days は 1 から 365 の整数で指定してください',
};
