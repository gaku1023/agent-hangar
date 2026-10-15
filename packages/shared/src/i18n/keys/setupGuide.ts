import type { MessageSpec } from '../messageSpec.ts';

/** セットアップのすゝめ。Claude Code に貼る一言と、同梱の md が無いときの断り。 */
export const setupGuideKeys = {
  'setupGuide.prompt.line': ['path', 'version', 'sha'],
  'setupGuide.error.missing': [],
} as const satisfies MessageSpec;
