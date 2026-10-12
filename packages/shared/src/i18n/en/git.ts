import type { gitKeys } from '../keys/git.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const gitEn: AreaDictionary<typeof gitKeys> = {
  'git.error.badIds': 'Send up to {max} session ids as a list',
  'git.error.noTree': 'This file is outside the git working tree',
};
