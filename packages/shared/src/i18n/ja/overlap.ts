import type { overlapKeys } from '../keys/overlap.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const overlapJa: AreaDictionary<typeof overlapKeys> = {
  'overlap.band.chip': '同じファイル {n}',
  'overlap.pop.title': '同じファイルを編集中',
  'overlap.card.summary': 'も {files} を編集しています（直近 10 分）',
  'overlap.sidebar.title': '{names} と同じファイルを編集中',
  'overlap.table.file': 'ファイル',
  'overlap.table.mine': 'このセッション',
  'overlap.table.theirs': '相手',
  'overlap.table.alternating': '交互',
  'overlap.pop.note': 'Edit と Write の呼び出しだけを数えます。Bash で書き換えた分は含みません。',
  'overlap.worktree.hint': '並べて実行するときは、worktree を使うと互いの変更を上書きしません。',
  'overlap.worktree.action': 'worktree で新しいセッション',
  'overlap.pop.dismiss': 'このファイルでは表示しない',
  'overlap.pop.open': '開く',
  'overlap.card.details': '詳細',
};
