import type { reportKeys } from '../keys/report.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const reportEn: AreaDictionary<typeof reportKeys> = {
  'report.tool.draft': 'Drafts a bug report or feature request for the hangar author (GitHub Issues of the public repository gaku1023/agent-hangar). This alone sends nothing. Use it only when the user wants to send a report or request to the author. kind bug needs symptom and steps; kind request needs problem and proposal. Optional: cause and fix for bug, alternatives for request, notes for both. Write in the user\'s language, concretely enough for the author to fix it. Do not include conversation contents, paths, project names or other private information. The tool fills in the environment and also masks private information mechanically. Follow the instructions in the result: show the full draft to the user and get their approval before calling submit_issue_report.',
  'report.tool.submit': 'Sends a draft made by draft_issue_report to the author as is. If gh is logged in it creates the issue; otherwise it opens the prefilled GitHub page in the browser and the user presses submit. Call it with confirmed set to true only after showing the full masked title and body to the user and they said to send it. Never call it without asking the user. To change the contents, call draft_issue_report again.',
  'report.param.kind': 'bug or request.',
  'report.param.confirmed': 'True only when the user read the full draft and said to send it.',
  'report.section.symptom': 'Symptom',
  'report.section.steps': 'Steps to reproduce',
  'report.section.cause': 'Suspected cause',
  'report.section.fix': 'Suggested fix',
  'report.section.notes': 'Notes',
  'report.section.problem': 'Problem',
  'report.section.proposal': 'Proposal',
  'report.section.alternatives': 'Alternatives',
  'report.section.environment': 'Environment',
  'report.env.unknown': 'unknown',
  'report.args.kindInvalid': 'kind must be bug or request',
  'report.args.titleRequired': 'title is required',
  'report.args.fieldRequired': '{field} is required for this kind',
  'report.draft.instructionsGh': 'Nothing has been sent yet. Show the title and body to the user in full, tell them how many private items were masked (redactions) and any similar issues (similar). If the same issue already exists, point to it instead of sending. When the user says to send it, pass draft_id and confirmed: true to submit_issue_report. The issue is created with gh and published under the user\'s GitHub account. The draft expires in 30 minutes.',
  'report.draft.instructionsBrowser': 'Nothing has been sent yet. Show the title and body to the user in full, tell them how many private items were masked (redactions) and any similar issues (similar). If the same issue already exists, point to it instead of sending. When the user says to send it, pass draft_id and confirmed: true to submit_issue_report. gh is not available, so the prefilled GitHub page opens in the browser and the user presses submit (a GitHub account is required). The draft expires in 30 minutes.',
  'report.submit.notConfirmed': 'The user has not approved. Show the full draft to the user and pass confirmed: true once they say to send it',
  'report.submit.draftNotFound': 'Draft {id} was not found (drafts expire in 30 minutes or after sending). Make a new one with draft_issue_report',
  'report.submit.browserNotice': 'Nothing has been sent yet. The new issue page on GitHub was opened in the browser. Ask the user to check it and press "Submit new issue". If it did not open, give them the url.',
  'report.submit.truncatedNote': '(The end of the body was cut because it was too long. The full text is in the Claude Code conversation.)',
};
