import type { MessageSpec } from '../messageSpec.ts';

export const todoKeys = {
  'todo.error.notFound': [],
  'todo.error.notCandidate': [],
  'todo.error.emptyText': [],
} as const satisfies MessageSpec;
