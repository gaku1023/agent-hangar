import type { gitKeys } from '../keys/git.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const gitJa: AreaDictionary<typeof gitKeys> = {
  'git.error.badIds': 'セッション ID を {max} 件までの配列で指定してください',
  'git.error.noTree': 'git の作業ツリーの外のファイルです',
};
