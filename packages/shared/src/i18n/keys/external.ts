import type { MessageSpec } from '../messageSpec.ts';

export const externalKeys = {
  'external.terminal.openFailed': ['reason'],
  'external.terminal.windowsOpenFailed': ['reason'],
  'external.terminal.badTarget': ['target'],
  'external.editor.codeMissing': ['label'],
  'external.editor.badPath': ['target'],
  'external.editor.launchFailed': ['reason'],
} as const satisfies MessageSpec;
