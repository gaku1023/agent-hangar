import type { MessageSpec } from '../messageSpec.ts';

export const platformKeys = {
  'platform.capture.stdoutTooLarge': ['max'],
  'platform.capture.timeout': ['ms'],
} as const satisfies MessageSpec;
