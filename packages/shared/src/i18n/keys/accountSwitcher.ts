import type { MessageSpec } from '../messageSpec.ts';

export const accountSwitcherKeys = {
  'accountSwitcher.face.aria': ['parts'],
  'accountSwitcher.face.fiveHour': ['percent'],
  'accountSwitcher.face.sevenDay': ['percent'],
  'accountSwitcher.dialog.aria': [],
  'accountSwitcher.menu.aria': [],
  'accountSwitcher.tag.current': [],
  'accountSwitcher.tag.session': [],
  'accountSwitcher.tag.switch': [],
  'accountSwitcher.footer.settings': [],
} as const satisfies MessageSpec;
