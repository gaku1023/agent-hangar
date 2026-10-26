import type { MessageSpec } from '../messageSpec.ts';

export const paneKeys = {
  'pane.workspace.label': [],
  'pane.header.label': ['name'],
  'pane.toc.open': [],
  'pane.toc.close': [],
  'pane.header.remove': [],
  'pane.header.unzoom': [],
  'pane.empty.title': [],
  'pane.empty.lead': [],
  'pane.empty.hint': [],
  'pane.divider.title': [],
  'pane.divider.name': [],
  'pane.divider.valueText': ['percent'],
} as const satisfies MessageSpec;
