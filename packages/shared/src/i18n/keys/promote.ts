import type { MessageSpec } from '../messageSpec.ts';

export const promoteKeys = {
  'promote.dialog.title': [],
  'promote.dialog.lead': ['name'],
  'promote.field.name': [],
  'promote.field.namePlaceholder': [],
  'promote.gitInit.label': [],
  'promote.gitInit.description': [],
  'promote.move.label': [],
  'promote.move.description': [],
  'promote.move.blocked': [],
  'promote.dialog.action': [],
  'promote.done.title': ['name'],
  'promote.done.moved': [],
  'promote.done.notMoved': [],
  'promote.done.close': [],
  'promote.done.openProject': [],
  'promote.done.startSession': [],
} as const satisfies MessageSpec;
