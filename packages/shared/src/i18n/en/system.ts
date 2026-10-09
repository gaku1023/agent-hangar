import type { systemKeys } from '../keys/system.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const systemEn: AreaDictionary<typeof systemKeys> = {
  'system.index.rebuildFailed': 'Failed to rebuild the index: {reason}',
};
