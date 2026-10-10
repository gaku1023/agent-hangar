import type { MessageSpec } from '../messageSpec.ts';

export const configSyncKeys = {
  'configSync.error.unknownItem': ['id'],
  'configSync.error.held': ['id'],
  'configSync.error.badTake': ['id'],
  'configSync.error.duplicate': ['id'],
  'configSync.error.emptyOrder': [],
  'configSync.error.unsentNotFound': ['id'],
  'configSync.error.badBody': [],
} as const satisfies MessageSpec;
