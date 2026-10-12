import type { launchKeys } from '../keys/launch.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const launchEn: AreaDictionary<typeof launchKeys> = {
  'launch.injection.none': '(none)',
  'launch.injection.body': "You are a session started from agent-hangar.\nProject: {projectName} ({projectPath})\nOpen to-dos: {todos}\nYou can look up past sessions with the MCP tools search_sessions and get_transcript.\nWhen you complete a request, when the approach changes significantly, or when you interrupt the work,\nupdate the title, a two-to-three-sentence summary, the state, and the next steps with set_session_summary.\nWhen you judge that a to-do is finished, pass the to-do ID and a one-sentence reason to propose_done of update_project.\nOnly the user marks a to-do as done. Do not suggest anything that has not been verified.\n",
  'launch.injection.status': "Only when the work is clearly finished, at the end of that turn, ask \"What do you want to do with this session?\" with AskUserQuestion. The options are \"Mark as Done\", \"Paused · <reminder date, plus the time if the time matters> (what to come back and check)\", and \"Keep going\".\nThe work is clearly finished when the user signals the end (such as \"thanks\", \"that's it for now\", \"merged\", or \"done for today\"), when everything that was asked is done and no next steps remain, or when the user says they are waiting for something outside (CI, a review, a check tomorrow, and so on).\nDo not ask when you have only finished one step, when you have only answered a question, in the middle of a round of fixes, when the user keeps giving the next instruction, or when next steps remain. When in doubt, do not ask.\nWhen you do not ask, write the state honestly with set_session_summary. If it is clear that the work is waiting on something, make only the suggestion to propose_session_status, without confirmed.\nIf the user chooses Done or Paused, pass it to propose_session_status with confirmed: true. If the user moves on to the next instruction without answering, make only the suggestion, without confirmed.\nFor Paused, pass the reminder date in return_on (YYYY-MM-DD), and when the time of the check is fixed, also pass return_time (HH:MM, local time). Do not write the time only in the note text.\n",
  'launch.injection.live': "When you start a turn and when you change approach, write what you will do in this turn and why, in one or two sentences, with set_turn_intent.\nWrite the description of Bash and Agent calls in English, briefly (about 40 characters).\n",
  'launch.mcpConfig.badId': 'This id cannot be used as the name of a settings file',
  'launch.add.label': 'Add a setting',
  'launch.chip.account': 'Account',
  'launch.chip.addDirs': 'Additional directories',
  'launch.chip.effort': 'Effort level',
  'launch.chip.model': 'Model',
  'launch.chip.name': 'Name',
  'launch.chip.worktree': 'worktree',
  'launch.chips.label': 'Launch settings',
  'launch.edit.addDirsHint': 'One per line',
  'launch.edit.modelOther': 'Another model name',
  'launch.edit.namePlaceholder': 'Name shown in the list',
  'launch.edit.worktreePlaceholder': 'Empty for the usual working directory',
  'launch.permission.label': 'Permission mode',
  'launch.permission.previous': 'Previous',
  'launch.value.default': 'Default',
  'launch.value.dirCount': '{n} added',
  'launch.value.none': 'None',
};
