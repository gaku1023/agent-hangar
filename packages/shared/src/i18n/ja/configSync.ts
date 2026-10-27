import type { configSyncKeys } from '../keys/configSync.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const configSyncJa: AreaDictionary<typeof configSyncKeys> = {
  'configSync.error.unknownItem': '「{id}」は受信した変更にありません',
  'configSync.error.held': '「{id}」はこの PC に適用できません（対応するプロジェクトが無いか、同期できない同名のファイルがこの PC にあります）',
  'configSync.error.badTake': '「{id}」は競合していないため、この PC の内容を採用できません',
  'configSync.error.duplicate': '「{id}」が重複しています',
  'configSync.error.prefsFailed': 'Hangar の設定を書き込めませんでした（{message}）。何も適用していません',
  'configSync.error.emptyOrder': '適用する項目が選択されていません',
  'configSync.error.unsentUnknownKey': '扱えないキーは送信できません',
  'configSync.error.unsentNotFound': '未送信の項目「{id}」が見つかりません',
  'configSync.error.badBody': 'リクエストの形式が正しくありません',
};
