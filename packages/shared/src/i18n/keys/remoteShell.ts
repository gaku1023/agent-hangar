import type { MessageSpec } from '../messageSpec.ts';

export const remoteShellKeys = {
  'remoteShell.tab.title': [],
  'remoteShell.tab.connecting': [],
  'remoteShell.reason.noSshd': ['device'],
  'remoteShell.reason.unreachable': ['device'],
  'remoteShell.reason.auth': [],
  'remoteShell.reason.hostKey': [],
  'remoteShell.reason.noMux': ['device'],
  'remoteShell.reason.noClient': [],
  'remoteShell.reason.outdated': ['device'],
  'remoteShell.reason.dropped': [],
  'remoteShell.reason.badCwd': [],
  'remoteShell.action.change': [],
  'remoteShell.addr.field': [],
  'remoteShell.action.go': [],
  'remoteShell.action.retry': [],
} as const satisfies MessageSpec;
