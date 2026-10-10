import type { newProjectKeys } from '../keys/newProject.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const newProjectJa: AreaDictionary<typeof newProjectKeys> = {
  'newProject.dialog.title': '新しいプロジェクト',
  'newProject.mode.aria': '作り方',
  'newProject.mode.newDir': '新しいフォルダを作成',
  'newProject.mode.dir': '既存のフォルダを登録',
  'newProject.field.name': 'プロジェクト名',
  'newProject.field.namePlaceholder': 'プロジェクトの親フォルダに作るディレクトリの名前',
  'newProject.name.willCreate': '{path} を作成します',
  'newProject.gitInit.label': 'git init を実行',
  'newProject.gitInit.description': '空のリポジトリを作成します',
  'newProject.field.folder': 'フォルダ',
  'newProject.search.placeholder': 'プロジェクトの親フォルダの未登録のフォルダを検索',
  'newProject.list.aria': 'プロジェクトの親フォルダの未登録のフォルダ',
  'newProject.list.noMatch': '一致するものはありません',
  'newProject.list.empty': '未登録のフォルダはありません',
  'newProject.folder.pick': 'ほかの場所を選択…',
  'newProject.folder.or': 'または',
  'newProject.path.aria': 'フォルダのパス',
  'newProject.path.placeholder': '/Users/you/…（パスを入力）',
  'newProject.path.placeholderWindows': 'C:\\Users\\you\\…（パスを入力）',
  'newProject.footer.create': '作成',
  'newProject.footer.createAndStart': '作成して開始',
};
