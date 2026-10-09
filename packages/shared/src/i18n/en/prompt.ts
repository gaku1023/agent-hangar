import type { promptKeys } from '../keys/prompt.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const promptEn: AreaDictionary<typeof promptKeys> = {
  'prompt.attachment.empty': 'The file is empty',
  'prompt.builtin.init': 'Create a CLAUDE.md that documents the codebase',
  'prompt.builtin.review': 'Review a pull request',
  'prompt.builtin.reviewHint': '[PR number]',
  'prompt.builtin.codeReview': 'Find mistakes in the current diff',
  'prompt.builtin.securityReview': 'Review the security of the changes on the branch',
  'prompt.builtin.loop': 'Repeat a prompt at a regular interval',
  'prompt.builtin.loopHint': '[interval] <prompt>',
  'prompt.builtin.schedule': 'Create a cloud agent that runs at a set time',
};
