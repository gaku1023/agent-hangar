import type { externalKeys } from '../keys/external.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const externalEn: AreaDictionary<typeof externalKeys> = {
  'external.terminal.openFailed': 'Could not open it in Terminal.app: {reason}',
  'external.terminal.windowsOpenFailed': 'Could not open it in the default terminal: {reason}',
  'external.terminal.badTarget': 'This name or path cannot be opened in a terminal: {target}',
  'external.editor.generic': 'the editor',
  'external.editor.testTitle': 'hangar editor test',
  'external.editor.testLine': 'If this line (line 3) is shown, line numbers work too.',
  'external.editor.missing': '{name} was not found',
  'external.editor.customMissing': 'The editor command {command} was not found',
  'external.editor.badPath': 'This path cannot be opened in {name}: {target}',
  'external.editor.badCommand': 'The editor command has no {token}. Fix it under Editor in Settings',
  'external.editor.launchFailed': 'Could not start {name}: {reason}',
};
