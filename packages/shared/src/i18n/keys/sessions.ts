import type { MessageSpec } from '../messageSpec.ts';

export const sessionsKeys = {
  'sessions.list.count': ['n'],
} as const satisfies MessageSpec;
