import type { MessageSpec } from '../messageSpec.ts';

/** 作者への問い合わせ（server の report/ と、MCP の draft_issue_report・submit_issue_report）。 */
export const reportKeys = {
  'report.tool.draft': [],
  'report.tool.submit': [],
  'report.param.kind': [],
  'report.param.confirmed': [],
  'report.section.symptom': [],
  'report.section.steps': [],
  'report.section.cause': [],
  'report.section.fix': [],
  'report.section.notes': [],
  'report.section.problem': [],
  'report.section.proposal': [],
  'report.section.alternatives': [],
  'report.section.environment': [],
  'report.env.unknown': [],
  'report.args.kindInvalid': [],
  'report.args.titleRequired': [],
  'report.args.fieldRequired': ['field'],
  'report.draft.instructionsGh': [],
  'report.draft.instructionsBrowser': [],
  'report.submit.notConfirmed': [],
  'report.submit.draftNotFound': ['id'],
  'report.submit.browserNotice': [],
  'report.submit.truncatedNote': [],
} as const satisfies MessageSpec;
