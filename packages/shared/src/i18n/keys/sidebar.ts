import type { MessageSpec } from '../messageSpec.ts';

export const sidebarKeys = {
  'sidebar.live.title': [],
  'sidebar.live.label': [],
  'sidebar.count.waiting': ['n'],
  'sidebar.live.rowTitle': ['name', 'waited'],
  'sidebar.live.waited': ['time'],
  'sidebar.live.menuLabel': ['name'],
  'sidebar.live.stop': [],
  'sidebar.live.stopNote': [],
  'sidebar.live.stopExternal': [],
  'sidebar.live.more': ['n'],
  'sidebar.toggle.open': [],
  'sidebar.toggle.close': [],
  'sidebar.toggle.tipOpen': [],
  'sidebar.toggle.tipClose': [],
  'sidebar.nav.label': [],
  'sidebar.nav.home': [],
  'sidebar.nav.projects': [],
  'sidebar.nav.settings': [],
} as const satisfies MessageSpec;
