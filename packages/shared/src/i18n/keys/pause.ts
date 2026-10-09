import type { MessageSpec } from '../messageSpec.ts';

export const pauseKeys = {
  'pause.dialog.title': [],
  'pause.dialog.action': [],
  'pause.dialog.draftTag': [],
  'pause.session.unnamed': [],
  'pause.choices.aria': [],
  'pause.choice.today': [],
  'pause.choice.tomorrow': [],
  'pause.choice.monday': [],
  'pause.choice.nextWeek': [],
  'pause.choice.pick': [],
  'pause.field.date': [],
  'pause.field.time': [],
  'pause.field.timeHint': [],
  'pause.field.reason': [],
  'pause.field.reasonPlaceholder': [],
  'pause.field.count': ['n', 'max'],
} as const satisfies MessageSpec;
