import type { accountSwitcherKeys } from '../keys/accountSwitcher.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const accountSwitcherJa: AreaDictionary<typeof accountSwitcherKeys> = {
  'accountSwitcher.face.aria': 'アカウントを切り替え（現在は {parts}）',
  'accountSwitcher.face.fiveHour': '5 時間 {percent}%',
  'accountSwitcher.face.sevenDay': '週 {percent}%',
  'accountSwitcher.dialog.aria': 'アカウントを切り替え',
  'accountSwitcher.menu.aria': 'アカウント',
  'accountSwitcher.footer.add': 'アカウントを追加',
  'accountSwitcher.footer.settings': 'アカウントの設定',
  'accountSwitcher.section.claude': 'Claude Code',
  'accountSwitcher.section.claudeHint': 'クリックで切り替え',
  'accountSwitcher.section.codex': 'Codex',
  'accountSwitcher.codex.name': 'ChatGPT',
  'accountSwitcher.codex.updated': '最終更新 {time}',
  'accountSwitcher.tag.codexSession': 'このセッション',
};
