import type { promoteKeys } from '../keys/promote.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const promoteJa: AreaDictionary<typeof promoteKeys> = {
  'promote.dialog.title': 'プロジェクトに昇格',
  'promote.dialog.lead': '{name} の作業をプロジェクトの親フォルダの下に移します。',
  'promote.field.name': 'プロジェクト名',
  'promote.field.namePlaceholder': 'プロジェクトの親フォルダに作るディレクトリの名前',
  'promote.gitInit.label': 'git init を実行',
  'promote.gitInit.description': '空のリポジトリを作成してから移します',
  'promote.move.label': 'ファイルを移動',
  'promote.move.description': 'クイックセッションのファイルをプロジェクトの親フォルダへ移します',
  'promote.move.blocked': '実行中のセッションがあるので、ファイルは移動しません',
  'promote.dialog.action': '昇格',
  'promote.done.title': '{name} に昇格しました',
  'promote.done.moved': 'ファイルを移しました',
  'promote.done.notMoved': 'ファイルは移していません',
  'promote.done.close': '閉じる',
  'promote.done.openProject': 'プロジェクトを開く',
  'promote.done.startSession': 'ここで新しいセッションを開始',
};
