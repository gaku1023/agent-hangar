import type { MessageSpec } from '../messageSpec.ts';

export const todoKeys = {
  'todo.error.notFound': [],
  'todo.error.notCandidate': [],
  'todo.error.emptyText': [],
  'todo.error.notSuggestion': [],
  'todo.error.notAccepted': [],
  'todo.error.orderMismatch': [],
  'todo.error.restoreMismatch': [],
  'todo.error.patchEmpty': [],
} as const satisfies MessageSpec;
