import type { accountSwitcherKeys } from '../keys/accountSwitcher.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const accountSwitcherEn: AreaDictionary<typeof accountSwitcherKeys> = {
  'accountSwitcher.face.aria': 'Switch account (current: {parts})',
  'accountSwitcher.face.fiveHour': '5-hour {percent}%',
  'accountSwitcher.face.sevenDay': 'Weekly {percent}%',
  'accountSwitcher.dialog.aria': 'Switch account',
  'accountSwitcher.menu.aria': 'Accounts',
  'accountSwitcher.tag.current': 'Current account',
  'accountSwitcher.tag.session': 'Account for this session',
  'accountSwitcher.tag.switch': 'Switch',
  'accountSwitcher.footer.add': 'Add account',
  'accountSwitcher.footer.settings': 'Account settings',
  'accountSwitcher.section.claude': 'Claude Code',
  'accountSwitcher.section.claudeHint': 'Click to switch',
  'accountSwitcher.section.codex': 'Codex',
  'accountSwitcher.codex.name': 'ChatGPT',
  'accountSwitcher.codex.updated': 'Updated {time}',
  'accountSwitcher.tag.codexSession': 'This session',
};
