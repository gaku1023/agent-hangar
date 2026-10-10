import type { toastsKeys } from '../keys/toasts.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const toastsEn: AreaDictionary<typeof toastsKeys> = {
  'toasts.more.view': 'View {n} more in Home',
  'toasts.waiting.label': '{name} needs input',
  'toasts.waiting.labelQuestion': '{name} needs input: {question}',
  'toasts.blocked.title': 'Close the dialog to open this',
  'toasts.waiting.head': 'Needs input',
  'toasts.info.head': 'Notice',
  'toasts.error.head': 'Error',
  'toasts.error.more': 'Show more',
};
