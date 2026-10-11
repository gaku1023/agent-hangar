import type { todoKeys } from '../keys/todo.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const todoJa: AreaDictionary<typeof todoKeys> = {
  'todo.error.notFound': 'TODO が見つかりません',
  'todo.error.notCandidate': 'この TODO は完了の候補ではありません',
  'todo.error.emptyText': 'TODO の本文が空です',
  'todo.error.notSuggestion': 'この TODO は Claude の提案ではありません',
  'todo.error.notAccepted': 'この TODO は Claude の提案で、まだ受け入れていません',
  'todo.error.orderMismatch': 'TODO の並びが今の一覧と合いません',
  'todo.error.restoreMismatch': '元に戻す TODO が見つからないか、別のプロジェクトのものです',
  'todo.error.patchEmpty': 'done か text を送ってください',
};
