import type { externalKeys } from '../keys/external.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const externalEn: AreaDictionary<typeof externalKeys> = {
  'external.terminal.openFailed': 'Could not open it in Terminal.app: {reason}',
  'external.terminal.windowsOpenFailed': 'Could not open it in the default terminal: {reason}',
  'external.terminal.badTarget': 'This name or path cannot be opened in a terminal: {target}',
  'external.editor.codeMissing': 'The code command of VS Code was not found. Enter the "{label}" in Settings',
  'external.editor.badPath': 'This path cannot be opened in VS Code: {target}',
  'external.editor.launchFailed': 'Could not start VS Code: {reason}',
};
