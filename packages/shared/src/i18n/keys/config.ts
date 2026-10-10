import type { MessageSpec } from '../messageSpec.ts';

export const configKeys = {
  'config.lock.busy': [],
  'config.file.symlinkTooDeep': ['file'],
  'config.file.brokenJson': ['file'],
  'config.file.notObject': ['file'],
  'config.file.unreadableFormat': [],
} as const satisfies MessageSpec;
