import type { summaryKeys } from '../keys/summary.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const summaryEn: AreaDictionary<typeof summaryKeys> = {
  'summary.claude.missing': 'claude was not found',
  'summary.claude.exited': 'claude exited with {code}: {detail}',
  'summary.claude.notJson': 'The output is not JSON',
  'summary.claude.noStructuredOutput': 'The output has no structured_output',
  'summary.claude.badStructuredOutput': 'structured_output does not match the schema',
  'summary.lmstudio.noModel': 'LM Studio has no model',
  'summary.lmstudio.unreachable': 'Cannot connect to LM Studio: {reason}',
  'summary.lmstudio.redirected': 'The summary engine address returned a redirect. Nothing is sent to the redirect target. Check the "{label}" in Settings',
  'summary.lmstudio.badStatus': 'LM Studio returned {status}',
  'summary.lmstudio.emptyContent': 'The response was empty (it may be a thinking model)',
  'summary.lmstudio.notJson': 'The response is not JSON',
  'summary.lmstudio.badShape': 'The response does not match the schema',
  'summary.engine.unavailable': 'Not available (cannot connect, or the limit has been reached)',
  'summary.error.noTranscript': 'There is no transcript',
  'summary.error.noEngine': 'There is no summary engine',
  'summary.input.omitted': '[... {n} items omitted ...]',
  'summary.input.running': 'This session is still running.',
  'summary.canned.text': '[user] The setup steps in the README are out of date. Rewrite them for Node 22 and npm workspaces.\n[assistant] I will read the current README and rewrite the setup and development sections.\n[tool] Read README.md\n[tool] Edit README.md\n[assistant] I rewrote the setup steps as three steps (Node 22, npm ci, npm run dev) and removed the pnpm instructions. The CI section now assumes the same setup.\n[user] Thanks. Please update CONTRIBUTING.md for the same setup.\n[tool] Edit CONTRIBUTING.md\n[assistant] I updated the development environment section of CONTRIBUTING.md. I found no other outdated instructions.',
  'summary.prompt.system': "The following is an excerpt from the session log of a coding agent. Reply in English, with only the specified JSON.\ntitle is a noun phrase (up to 40 characters), one_liner is one sentence (up to 80 characters), body is two to three sentences, and next_steps are concrete actions (up to 5).\nHow to decide state: if the last message ends with a question or a request for confirmation from the assistant, choose in_progress. If the request has been fulfilled, choose done.\nIf the work cannot proceed because of an error, a permission, or missing information, choose blocked. If it was cut off partway, choose abandoned.\nIf the excerpt begins with \"This session is still running\", do not conclude that it is finished; choose in_progress.\nHow to decide proposed_status: if what was asked is finished and nothing is left to check, choose done. If it is finished but something is left to check, choose paused. If it is still in progress, choose none.\nproposed_note is the reason for the decision in one sentence (up to 200 characters). For paused, write what to come back and check. For none, use an empty string.\nproposed_return_in_days is the number of days until coming back when the status is paused (1 to 14). If it is not paused, use 0.\nIf the excerpt begins with \"This session is still running\", choose none for proposed_status.",
};
