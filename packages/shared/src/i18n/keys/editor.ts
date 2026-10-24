import type { MessageSpec } from '../messageSpec.ts';

/** エディタの選択（0.5.0）。「<名前> で開く」と、設定のエディタの欄と、見つからないときの面。 */
export const editorKeys = {
  'editor.open.named': ['name'],
  'editor.open.generic': [],
  'editor.open.namedFor': ['target', 'name'],
  'editor.open.genericFor': ['target'],
  'editor.open.namedAt': ['target', 'name', 'line'],
  'editor.open.genericAt': ['target', 'line'],
  'editor.missing.lastPath': ['path'],
  'editor.missing.settings': [],
  'editor.missing.once': ['name'],
  'editor.missing.recheck': [],
  'editor.missing.close': [],
} as const satisfies MessageSpec;
