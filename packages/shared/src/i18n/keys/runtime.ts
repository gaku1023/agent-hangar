import type { MessageSpec } from '../messageSpec.ts';

export const runtimeKeys = {
  'runtime.notify.blocked': [],
  'runtime.notify.denied': [],
  'runtime.notify.returnBody': ['time'],
  'runtime.notify.returnBodyNote': ['time', 'note'],
  'runtime.copy.failed': ['keys'],
  'runtime.shell.openLogFailed': [],
  'runtime.shell.restartFailed': [],
  'runtime.shell.pickFolderFailed': [],
  'runtime.shell.restoreFailed': [],
  'runtime.shell.unreadable': [],
  'runtime.tab.noClaude': [],
  'runtime.retention.previewLoading': [],
  'runtime.retention.set': ['days'],
  'runtime.openTerminal.fellBack': [],
  'runtime.openTerminal.fellBackWindows': [],
} as const satisfies MessageSpec;
