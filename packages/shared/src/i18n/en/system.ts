import type { systemKeys } from '../keys/system.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const systemEn: AreaDictionary<typeof systemKeys> = {
  'system.index.rebuildFailed': 'Failed to rebuild the index: {reason}',
  'system.opencode.disabled': 'opencode is not enabled.',
  'system.opencode.optionsFailed': 'Could not get the list from opencode: {reason}',
};
