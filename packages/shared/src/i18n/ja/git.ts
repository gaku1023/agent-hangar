import type { gitKeys } from '../keys/git.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const gitJa: AreaDictionary<typeof gitKeys> = {
  'git.error.badIds': 'セッションの id を {max} 件までの並びで送ってください',
  'git.error.noTree': 'git の作業ツリーの外のファイルです',
};
