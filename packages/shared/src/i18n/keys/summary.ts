import type { MessageSpec } from '../messageSpec.ts';

export const summaryKeys = {
  'summary.claude.missing': [],
  'summary.claude.exited': ['code', 'detail'],
  'summary.claude.notJson': [],
  'summary.claude.noStructuredOutput': [],
  'summary.claude.badStructuredOutput': [],
  'summary.lmstudio.noModel': [],
  'summary.lmstudio.unreachable': ['reason'],
  'summary.lmstudio.redirected': ['label'],
  'summary.lmstudio.badStatus': ['status'],
  'summary.lmstudio.emptyContent': [],
  'summary.lmstudio.notJson': [],
  'summary.lmstudio.badShape': [],
  'summary.engine.unavailable': [],
  'summary.error.noTranscript': [],
  'summary.error.noEngine': [],
  'summary.input.omitted': ['n'],
  'summary.input.running': [],
  'summary.prompt.system': [],
} as const satisfies MessageSpec;
