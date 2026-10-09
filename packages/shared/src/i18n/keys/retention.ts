import type { MessageSpec } from '../messageSpec.ts';

export const retentionKeys = {
  'retention.days.invalid': [],
  'retention.preview.fingerprintMissing': [],
  'retention.unwritable.unreadable': [],
  'retention.unwritable.managed': [],
  'retention.unwritable.noDir': [],
  'retention.unwritable.generic': [],
  'retention.error.conflict': [],
  'retention.backup.noFreeName': [],
} as const satisfies MessageSpec;
