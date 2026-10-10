import type { runtimeKeys } from '../keys/runtime.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const runtimeEn: AreaDictionary<typeof runtimeKeys> = {
  'runtime.notify.blocked': 'Notifications are turned off. Allow Hangar under Notifications in System Settings',
  'runtime.notify.denied': 'Notifications were not allowed',
  'runtime.notify.returnBody': 'Return time {time} has passed',
  'runtime.notify.returnBodyNote': 'Return time {time} has passed · {note}',
  'runtime.copy.failed': 'Could not copy. Select the text and press ⌘C',
  'runtime.shell.openLogFailed': 'Could not open the log',
  'runtime.shell.restartFailed': 'Could not restart',
  'runtime.shell.pickFolderFailed': 'Could not select the folder',
  'runtime.shell.restoreFailed': 'Could not restore the settings',
  'runtime.shell.unreadable': 'Could not read the response from the desktop app.',
  'runtime.tab.noClaude': 'Cannot open a shell tab because Claude is not running',
  'runtime.retention.previewLoading': 'Loading the diff. Wait a moment, then try again',
  'runtime.retention.set': 'Retention period set to {days}',
  'runtime.openTerminal.fellBack': 'Could not open in iTerm2, so opened in Terminal.app instead',
  'runtime.openTerminal.fellBackWindows': 'Windows Terminal was not found, so opened in the default terminal instead',
};
