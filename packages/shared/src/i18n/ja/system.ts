import type { systemKeys } from '../keys/system.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const systemJa: AreaDictionary<typeof systemKeys> = {
  'system.index.rebuildFailed': 'インデックスの再構築に失敗しました: {reason}',
  'system.opencode.disabled': 'opencode が有効になっていません。',
  'system.opencode.optionsFailed': 'opencode から一覧を取得できませんでした: {reason}',
};
