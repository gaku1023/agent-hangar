import type { editorKeys } from '../keys/editor.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const editorEn: AreaDictionary<typeof editorKeys> = {
  'editor.open.named': 'Open in {name}',
  'editor.open.generic': 'Open in editor',
  'editor.open.namedFor': 'Open {target} in {name}',
  'editor.open.genericFor': 'Open {target} in the editor',
  'editor.open.namedAt': 'Open line {line} of {target} in {name}',
  'editor.open.genericAt': 'Open line {line} of {target} in the editor',
  'editor.missing.lastPath': 'Last found at: {path}',
  'editor.missing.maybeMoved': 'It may have been uninstalled or moved.',
  'editor.missing.settings': 'Choose an editor in Settings',
  'editor.missing.once': 'Open in {name} this time',
  'editor.missing.recheck': 'Check again',
  'editor.missing.close': 'Close',
};
