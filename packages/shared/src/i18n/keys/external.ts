import type { MessageSpec } from '../messageSpec.ts';

export const externalKeys = {
  'external.terminal.openFailed': ['reason'],
  'external.terminal.windowsOpenFailed': ['reason'],
  'external.terminal.badTarget': ['target'],
  'external.editor.generic': [],
  'external.editor.testTitle': [],
  'external.editor.testLine': [],
  'external.editor.missing': ['name'],
  'external.editor.customMissing': ['command'],
  'external.editor.badPath': ['name', 'target'],
  'external.editor.badCommand': ['token'],
  'external.editor.launchFailed': ['name', 'reason'],
} as const satisfies MessageSpec;
