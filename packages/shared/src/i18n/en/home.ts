import type { homeKeys } from '../keys/home.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const homeEn: AreaDictionary<typeof homeKeys> = {
  'home.band.label': 'Home summary',
  'home.band.attention': 'Needs attention',
  'home.band.running': 'Running',
  'home.band.pending': 'Pending review',
  'home.band.attentionSummary': "Needs input {waiting}, today's reminders {reminders}",
  'home.band.runningSummary': 'Working {busy}, Idle {idle}',
  'home.band.pendingSummary': 'Suggestions {n}',
  'home.band.collapse': 'Collapse',
  'home.band.searchNote': 'Drawers are closed while searching',
  'home.band.waited': 'Waiting {time}',
  'home.band.working': 'Working {time}',
  'home.band.external': 'Running in an external terminal',
  'home.band.noDate': 'No date',
  'home.band.reminderTime': 'Reminder time {time}',
  'home.band.answer': 'Answer in terminal',
  'home.band.move': 'Move to Hangar',
  'home.band.open': 'Open',
  'home.band.changeDate': 'Change date',
  'home.band.confirm': 'Confirm',
  'home.band.dismiss': 'Dismiss',
  'home.band.actionFor': '{action}: {name}',
};
