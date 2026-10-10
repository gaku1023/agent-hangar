import type { pauseKeys } from '../keys/pause.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const pauseEn: AreaDictionary<typeof pauseKeys> = {
  'pause.dialog.title': 'Mark as Paused',
  'pause.dialog.action': 'Mark as Paused',
  'pause.dialog.draftTag': 'Suggestion',
  'pause.session.unnamed': '(Untitled)',
  'pause.choices.aria': 'Reminder date options',
  'pause.choice.today': 'This evening',
  'pause.choice.tomorrow': 'Tomorrow',
  'pause.choice.monday': 'Monday',
  'pause.choice.nextWeek': 'Next week',
  'pause.choice.pick': 'Pick a date…',
  'pause.field.date': 'Reminder date',
  'pause.field.time': 'Reminder time (optional)',
  'pause.field.timeHint': 'If empty, any time that day',
  'pause.field.reason': 'Reason',
  'pause.field.reasonPlaceholder': 'Check the production CPU numbers tomorrow morning',
  'pause.field.count': '{n} / {max} characters',
};
