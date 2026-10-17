import type { promoteKeys } from '../keys/promote.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const promoteJa: AreaDictionary<typeof promoteKeys> = {
  'promote.dialog.title': 'プロジェクトにする',
  'promote.dialog.lead': '{name} の作業を新しいプロジェクトのディレクトリに移動します。',
  'promote.field.name': 'プロジェクト名',
  'promote.field.namePlaceholder': '新しく作成するディレクトリの名前',
  'promote.gitInit.label': 'git init を実行',
  'promote.gitInit.description': '空のリポジトリを作成してから移動します',
  'promote.move.label': 'ファイルを移動',
  'promote.move.description': 'クイックセッションのファイルを新しいプロジェクトのディレクトリへ移動します',
  'promote.move.blocked': '実行中のセッションがあるため、ファイルは移動しません',
  'promote.dialog.action': 'プロジェクトにする',
  'promote.done.title': 'プロジェクト {name} を作成しました',
  'promote.done.moved': 'ファイルを移動しました',
  'promote.done.notMoved': 'ファイルは移動していません',
  'promote.done.close': '閉じる',
  'promote.done.openProject': 'プロジェクトを開く',
  'promote.done.startSession': 'ここで新しいセッションを開始',
};
