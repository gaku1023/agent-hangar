import type { externalKeys } from '../keys/external.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const externalJa: AreaDictionary<typeof externalKeys> = {
  'external.terminal.openFailed': 'Terminal.app で開けませんでした: {reason}',
  'external.terminal.windowsOpenFailed': '既定のターミナルで開けませんでした: {reason}',
  'external.terminal.badTarget': 'この名前かパスはターミナルで開けません: {target}',
  'external.editor.codeMissing': 'VS Code の code コマンドが見つかりません。設定の「{label}」を入力してください',
  'external.editor.badPath': 'このパスは VS Code で開けません: {target}',
  'external.editor.launchFailed': 'VS Code を起動できませんでした: {reason}',
};
