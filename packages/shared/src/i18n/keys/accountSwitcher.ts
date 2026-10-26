import type { MessageSpec } from '../messageSpec.ts';

export const accountSwitcherKeys = {
  'accountSwitcher.face.aria': ['parts'],
  'accountSwitcher.face.fiveHour': ['percent'],
  'accountSwitcher.face.sevenDay': ['percent'],
  'accountSwitcher.dialog.aria': [],
  'accountSwitcher.menu.aria': [],
  'accountSwitcher.footer.add': [],
  'accountSwitcher.footer.settings': [],
  'accountSwitcher.section.claude': [],
  'accountSwitcher.section.claudeHint': [],
  'accountSwitcher.section.codex': [],
  'accountSwitcher.codex.name': [],
  'accountSwitcher.codex.updated': ['time'],
  'accountSwitcher.tag.codexSession': [],
} as const satisfies MessageSpec;
