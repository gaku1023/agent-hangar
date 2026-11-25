import type { remoteShellKeys } from '../keys/remoteShell.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const remoteShellEn: AreaDictionary<typeof remoteShellKeys> = {
  'remoteShell.tab.title': 'Shell',
  'remoteShell.tab.connecting': 'Connecting',
  'remoteShell.reason.noSshd': '{device} is not accepting SSH',
  'remoteShell.reason.unreachable': 'Cannot reach {device}',
  'remoteShell.reason.auth': 'The key was refused',
  'remoteShell.reason.hostKey': 'The host key does not match the synced fingerprint',
  'remoteShell.reason.noMux': 'Neither tmux nor psmux was found',
  'remoteShell.reason.noClient': 'This PC has no ssh',
  'remoteShell.reason.outdated': 'The other hangar is too old to connect',
  'remoteShell.reason.dropped': 'The connection dropped',
  'remoteShell.reason.badCwd': 'Cannot enter the working folder',
  'remoteShell.action.change': 'Change address',
  'remoteShell.addr.field': 'Address',
  'remoteShell.action.go': 'Connect',
  'remoteShell.action.retry': 'Try again',
};
