import type { remoteShellKeys } from '../keys/remoteShell.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const remoteShellEn: AreaDictionary<typeof remoteShellKeys> = {
  'remoteShell.tab.title': 'Shell',
  'remoteShell.tab.connecting': 'Connecting',
  'remoteShell.reason.noSshd': 'No SSH server on {device}',
  'remoteShell.reason.unreachable': 'Cannot reach {device}',
  'remoteShell.reason.auth': 'The key was refused',
  'remoteShell.reason.hostKey': 'The host key does not match the synced fingerprint',
  'remoteShell.reason.noMux': 'Neither tmux nor psmux was found on {device}',
  'remoteShell.reason.noClient': 'This PC has no ssh',
  'remoteShell.reason.outdated': 'hangar on {device} is too old to connect',
  'remoteShell.reason.dropped': 'The connection dropped',
  'remoteShell.reason.badCwd': 'Cannot enter the working folder',
  'remoteShell.action.change': 'Change host',
  'remoteShell.addr.field': 'Host name or IP',
  'remoteShell.action.go': 'Connect',
  'remoteShell.action.retry': 'Try again',
};
