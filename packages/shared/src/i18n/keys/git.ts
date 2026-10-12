import type { MessageSpec } from '../messageSpec.ts';

export const gitKeys = {
  'git.error.badIds': ['max'],
  'git.error.noTree': [],
} as const satisfies MessageSpec;
