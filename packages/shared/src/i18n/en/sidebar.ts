import type { sidebarKeys } from '../keys/sidebar.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const sidebarEn: AreaDictionary<typeof sidebarKeys> = {
  'sidebar.live.title': 'Running',
  'sidebar.live.label': 'Running sessions',
  'sidebar.count.waiting': ', needs input {n}',
  'sidebar.live.rowTitle': '{name} ({waited})',
  'sidebar.live.waited': 'Waiting {time}',
  'sidebar.live.menuLabel': 'Actions for {name}',
  'sidebar.live.stop': 'Stop',
  'sidebar.live.stopNote': 'Ends Claude. The conversation record is kept, so you can resume later',
  'sidebar.live.stopExternal': 'Running in an external terminal',
  'sidebar.live.more': '{n} more',
  'sidebar.toggle.open': 'Open sidebar',
  'sidebar.toggle.close': 'Close sidebar',
  'sidebar.toggle.tipOpen': 'Open',
  'sidebar.toggle.tipClose': 'Close',
  'sidebar.nav.label': 'Main navigation',
  'sidebar.nav.home': 'Home',
  'sidebar.nav.projects': 'Projects',
  'sidebar.nav.settings': 'Settings',
};
