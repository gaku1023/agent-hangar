import type { externalKeys } from '../keys/external.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const externalJa: AreaDictionary<typeof externalKeys> = {
  'external.terminal.openFailed': 'Terminal.app で開けませんでした: {reason}',
  'external.editor.codeMissing': 'VS Code の code コマンドが見つかりません。設定の「{label}」を入れてください',
  'external.editor.badPath': 'このパスは VS Code で開けません: {target}',
  'external.editor.launchFailed': 'VS Code を起動できませんでした: {reason}',
};
