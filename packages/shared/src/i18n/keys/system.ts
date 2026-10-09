import type { MessageSpec } from '../messageSpec.ts';

export const systemKeys = {
  'system.index.rebuildFailed': ['reason'],
} as const satisfies MessageSpec;
