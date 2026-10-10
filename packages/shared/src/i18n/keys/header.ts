import type { MessageSpec } from '../messageSpec.ts';

export const headerKeys = {
  'header.sync.off': [],
  'header.sync.idle': [],
  'header.sync.synced': ['time'],
  'header.sync.preparing': [],
  'header.sync.sending': [],
  'header.sync.receiving': [],
  'header.sync.paused': [],
  'header.sync.once': [],
  'header.sync.error': [],
  'header.sync.failed': [],
  'header.sync.errorDetail': ['message'],
  'header.sync.pausedError': ['message'],
  'header.sync.pausedErrorShort': [],
  'header.sync.limited': ['time'],
  'header.sync.pending': ['n'],
  'header.sync.sweepPending': ['n'],
  'header.sync.skipped': ['n'],
  'header.sync.title': ['text'],
  'header.sync.separator': [],
} as const satisfies MessageSpec;
