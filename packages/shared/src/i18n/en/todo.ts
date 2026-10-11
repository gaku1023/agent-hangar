import type { todoKeys } from '../keys/todo.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const todoEn: AreaDictionary<typeof todoKeys> = {
  'todo.error.notFound': 'To-do not found',
  'todo.error.notCandidate': 'This to-do is not a completion suggestion',
  'todo.error.emptyText': 'The to-do text is empty',
  'todo.error.notSuggestion': 'This to-do is not a suggestion from Claude',
  'todo.error.notAccepted': 'This to-do is a suggestion from Claude and has not been accepted yet',
  'todo.error.orderMismatch': 'The order does not match the current to-do list',
  'todo.error.restoreMismatch': 'A to-do to restore was not found or belongs to another project',
  'todo.error.patchEmpty': 'Send done or text',
};
