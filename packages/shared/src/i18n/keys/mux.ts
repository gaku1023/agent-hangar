import type { MessageSpec } from '../messageSpec.ts';

// psmux（Windows）と tmux が無いときの案内。ホームの帯、始める前のダイアログ、設定のツールの行が使う。
export const muxKeys = {
  'mux.status.notInstalled': ['name'],
  'mux.status.stillMissing': ['name'],
  'mux.action.recheck': [],
  'mux.action.checking': [],
  'mux.badge.installed': [],
  'mux.badge.missing': [],
  'mux.info.version': ['version'],
  'mux.desc.windows': [],
  'mux.desc.other': [],
  'mux.run.windows': [],
  'mux.run.other': [],
  'mux.guide.title': ['name'],
  'mux.guide.lead.windows': [],
  'mux.guide.lead.other': [],
  'mux.guide.recheck': [],
  'mux.guide.found.title': ['name'],
  'mux.guide.found.lead': ['version'],
  'mux.guide.found.leadNoVersion': [],
  'mux.guide.start': [],
} as const satisfies MessageSpec;
