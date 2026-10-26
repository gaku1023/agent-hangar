import type { sidebarKeys } from '../keys/sidebar.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const sidebarEn: AreaDictionary<typeof sidebarKeys> = {
  'sidebar.live.title': 'Running',
  'sidebar.live.label': 'Running sessions',
  'sidebar.count.waiting': ', needs input {n}',
  'sidebar.live.rowTitle': '{name} ({waited})',
  'sidebar.live.waited': 'Waiting {time}',
  'sidebar.live.stop': 'Stop',
  'sidebar.live.stopExternal': 'Running in an external terminal',
  'sidebar.toggle.open': 'Open sidebar',
  'sidebar.toggle.close': 'Close sidebar',
  'sidebar.toggle.tipOpen': 'Open',
  'sidebar.toggle.tipClose': 'Close',
  'sidebar.width.label': 'Sidebar width',
  'sidebar.width.valueText': '{width}px',
  'sidebar.width.tip': 'Drag to resize. Double-click to reset',
  'sidebar.nav.label': 'Main navigation',
  'sidebar.nav.home': 'Home',
  'sidebar.nav.projects': 'Projects',
  'sidebar.nav.settings': 'Settings',
  'sidebar.live.paneBadge': 'Pane {n}',
};
