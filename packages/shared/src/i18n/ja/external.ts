import type { externalKeys } from '../keys/external.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const externalJa: AreaDictionary<typeof externalKeys> = {
  'external.terminal.openFailed': 'Terminal.app で開けませんでした: {reason}',
  'external.terminal.windowsOpenFailed': '既定のターミナルで開けませんでした: {reason}',
  'external.terminal.badTarget': 'この名前かパスはターミナルで開けません: {target}',
  'external.editor.generic': 'エディタ',
  'external.editor.testTitle': 'hangar のエディタのテスト',
  'external.editor.testLine': 'この行（3 行目）が開いていれば、行の指定も効いています。',
  'external.editor.missing': '{name} が見つかりません',
  'external.editor.customMissing': 'エディタのコマンド {command} が見つかりません',
  'external.editor.badPath': 'このパスは {name} で開けません: {target}',
  'external.editor.badCommand': 'エディタのコマンドに {token} が入っていません。設定の「エディタ」で直してください',
  'external.editor.launchFailed': '{name} を起動できませんでした: {reason}',
};
