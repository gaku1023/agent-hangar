import type { todoKeys } from '../keys/todo.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const todoJa: AreaDictionary<typeof todoKeys> = {
  'todo.error.notFound': 'TODO が見つかりません',
  'todo.error.notCandidate': 'この TODO は完了の候補ではありません',
  'todo.error.emptyText': 'TODO の本文が空です',
};
