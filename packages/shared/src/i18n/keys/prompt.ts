import type { MessageSpec } from '../messageSpec.ts';

export const promptKeys = {
  'prompt.attachment.empty': [],
  'prompt.builtin.init': [],
  'prompt.builtin.review': [],
  'prompt.builtin.reviewHint': [],
  'prompt.builtin.codeReview': [],
  'prompt.builtin.securityReview': [],
  'prompt.builtin.loop': [],
  'prompt.builtin.loopHint': [],
  'prompt.builtin.schedule': [],
} as const satisfies MessageSpec;
