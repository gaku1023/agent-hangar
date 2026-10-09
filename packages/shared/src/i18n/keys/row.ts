import type { MessageSpec } from '../messageSpec.ts';

export const rowKeys = {
  'row.mark.pr': ['n'],
  'row.mark.prPlain': [],
  'row.mark.note': [],
} as const satisfies MessageSpec;
