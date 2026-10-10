import type { accountSwitcherKeys } from '../keys/accountSwitcher.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const accountSwitcherJa: AreaDictionary<typeof accountSwitcherKeys> = {
  'accountSwitcher.face.aria': 'アカウントを切り替え（現在は {parts}）',
  'accountSwitcher.face.fiveHour': '5 時間 {percent}%',
  'accountSwitcher.face.sevenDay': '週 {percent}%',
  'accountSwitcher.dialog.aria': 'アカウントを切り替え',
  'accountSwitcher.menu.aria': 'アカウント',
  'accountSwitcher.tag.current': '現在のアカウント',
  'accountSwitcher.tag.session': 'このセッションのアカウント',
  'accountSwitcher.tag.switch': '切り替える',
  'accountSwitcher.footer.settings': 'アカウントの設定',
};
