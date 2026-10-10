import type { composerKeys } from '../keys/composer.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const composerJa: AreaDictionary<typeof composerKeys> = {
  'composer.source.project': 'プロジェクト',
  'composer.source.user': '自分の',
  'composer.source.plugin': 'プラグイン',
  'composer.source.builtin': '組み込み',
  'composer.group.frequent': 'よく使う',
  'composer.group.project': 'このプロジェクト',
  'composer.group.user': '自分の',
  'composer.group.plugin': 'プラグイン',
  'composer.group.builtin': '組み込み',
  'composer.card.remove': '{name} を削除',
  'composer.card.sending': '送っています',
  'composer.attach.tooLarge': '{name} は 20 MB を超えているので添付できません',
  'composer.attach.failed': '{name} を添付できませんでした（{reason}）',
  'composer.attach.unavailable': '添付は使えません',
  'composer.tool.skill': 'スキル',
  'composer.tool.file': 'ファイル',
  'composer.tool.fileNeedsProject': 'プロジェクトを選択すると使えます',
  'composer.tool.attach': '添付',
  'composer.tool.pasteHint': '画像は {keys} でも貼れます',
  'composer.list.fileLabel': 'ファイル',
  'composer.list.commandLabel': 'スキルとコマンド',
  'composer.list.failed': '読めませんでした',
  'composer.list.recentFiles': '最近変えたファイル',
  'composer.cards.label': '添付',
};
