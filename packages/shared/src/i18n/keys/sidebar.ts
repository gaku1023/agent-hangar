import type { MessageSpec } from '../messageSpec.ts';

export const sidebarKeys = {
  'sidebar.live.label': [],
  'sidebar.count.waiting': ['n'],
  'sidebar.count.unread': ['n'],
  'sidebar.live.rowTitle': ['name', 'waited'],
  'sidebar.live.waited': ['time'],
  'sidebar.live.stop': [],
  'sidebar.live.stopExternal': [],
  'sidebar.toggle.open': [],
  'sidebar.toggle.close': [],
  'sidebar.toggle.tipOpen': [],
  'sidebar.toggle.tipClose': [],
  'sidebar.width.label': [],
  'sidebar.width.valueText': ['width'],
  'sidebar.width.tip': [],
  'sidebar.nav.label': [],
  'sidebar.nav.home': [],
  'sidebar.nav.projects': [],
  'sidebar.nav.settings': [],
} as const satisfies MessageSpec;
