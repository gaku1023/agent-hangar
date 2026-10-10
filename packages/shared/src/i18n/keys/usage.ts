import type { MessageSpec } from '../messageSpec.ts';

export const usageKeys = {
  'usage.statusline.badPayload': [],
  'usage.days.invalid': [],
} as const satisfies MessageSpec;
