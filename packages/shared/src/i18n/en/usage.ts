import type { usageKeys } from '../keys/usage.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const usageEn: AreaDictionary<typeof usageKeys> = {
  'usage.statusline.badPayload': 'The status line payload has the wrong shape',
  'usage.days.invalid': 'days must be an integer from 1 to 365',
};
