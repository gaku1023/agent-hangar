import type { todoKeys } from '../keys/todo.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const todoEn: AreaDictionary<typeof todoKeys> = {
  'todo.error.notFound': 'To-do not found',
  'todo.error.notCandidate': 'This to-do is not a completion suggestion',
  'todo.error.emptyText': 'The to-do text is empty',
};
