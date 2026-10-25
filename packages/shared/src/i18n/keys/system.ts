import type { MessageSpec } from '../messageSpec.ts';

export const systemKeys = {
  'system.index.rebuildFailed': ['reason'],
  'system.opencode.disabled': [],
  'system.opencode.optionsFailed': ['reason'],
} as const satisfies MessageSpec;
