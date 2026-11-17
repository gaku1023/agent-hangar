import type { MessageSpec } from '../messageSpec.ts';

export const summaryKeys = {
  'summary.claude.missing': [],
  'summary.claude.exited': ['code', 'detail'],
  'summary.claude.notJson': [],
  'summary.claude.noStructuredOutput': [],
  'summary.claude.badStructuredOutput': [],
  'summary.engine.unavailable': [],
  'summary.error.noTranscript': [],
  'summary.error.noEngine': [],
  'summary.input.omitted': ['n'],
  'summary.input.running': [],
  'summary.canned.text': [],
  'summary.prompt.system': [],
  'summary.prompt.jsonObject': ['schema'],
} as const satisfies MessageSpec;
