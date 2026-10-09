import type { usageKeys } from '../keys/usage.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const usageJa: AreaDictionary<typeof usageKeys> = {
  'usage.statusline.badPayload': 'statusline の payload の形が違います',
  'usage.days.invalid': 'days は 1 から 365 の整数です',
};
