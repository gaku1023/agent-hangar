import type { paneKeys } from '../keys/pane.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const paneEn: AreaDictionary<typeof paneKeys> = {
  'pane.workspace.label': 'Split sessions',
  'pane.header.label': 'Pane: {name}',
  'pane.toc.open': 'Open right panel',
  'pane.toc.close': 'Close right panel',
  'pane.header.remove': 'Remove Pane',
  'pane.header.unzoom': 'Restore',
  'pane.empty.title': 'Empty Pane',
  'pane.empty.lead': 'Select a session to open in this pane',
  'pane.empty.hint': 'Or drag a session from the sidebar',
  'pane.divider.title': 'Drag to resize / Double-click to equalize',
  'pane.divider.name': 'Pane divider',
  'pane.divider.valueText': 'First pane {percent}%',
  'pane.drop.left': 'Split Left',
  'pane.drop.right': 'Split Right',
  'pane.drop.up': 'Split Up',
  'pane.drop.down': 'Split Down',
  'pane.drop.open': 'Open Here',
  'pane.drop.swap': 'Swap Panes',
  'pane.drop.self': 'Cannot drop on same pane',
};
