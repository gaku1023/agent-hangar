import type { MessageSpec } from '../messageSpec.ts';

export const dbKeys = {
  'db.backup.failed': ['file', 'cause'],
  'db.backup.symlink': [],
  'db.open.tooOld': ['file', 'found', 'baseline'],
} as const satisfies MessageSpec;
