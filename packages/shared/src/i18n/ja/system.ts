import type { systemKeys } from '../keys/system.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const systemJa: AreaDictionary<typeof systemKeys> = {
  'system.index.rebuildFailed': '索引の再構築に失敗しました: {reason}',
};
