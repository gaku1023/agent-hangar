import type { MessageSpec } from '../messageSpec.ts';

/** セットアップのすゝめ。Claude Code に貼る一言と、同梱の md が無いときの断り。 */
export const setupGuideKeys = {
  'setupGuide.prompt.line': ['path', 'version', 'sha'],
  'setupGuide.error.missing': [],
  'setupGuide.launch.button': [],
  'setupGuide.launch.title': [],
  'setupGuide.quote.line': ['name', 'state', 'text'],
} as const satisfies MessageSpec;
