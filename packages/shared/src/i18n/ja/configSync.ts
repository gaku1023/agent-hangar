import type { configSyncKeys } from '../keys/configSync.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const configSyncJa: AreaDictionary<typeof configSyncKeys> = {
  'configSync.error.unknownItem': '「{id}」は、届いている変更にありません',
  'configSync.error.held': '「{id}」は、この PC では適用できません（対応するプロジェクトが無いか、手元に運べない同名のファイルがあります）',
  'configSync.error.badTake': '「{id}」は競合ではないので、手元を採る選び方はできません',
  'configSync.error.duplicate': '「{id}」が重なっています',
  'configSync.error.emptyOrder': '適用する項目が選ばれていません',
  'configSync.error.unsentNotFound': '送らなかった項目「{id}」が見つかりません',
  'configSync.error.badBody': '要求の形が違います',
};
