import type { MessageSpec } from '../messageSpec.ts';

export const toastsKeys = {
  'toasts.more.view': ['n'],
  'toasts.waiting.label': ['name'],
  'toasts.waiting.labelQuestion': ['name', 'question'],
  'toasts.blocked.title': [],
  'toasts.waiting.head': [],
  'toasts.info.head': [],
  'toasts.error.head': [],
  'toasts.error.more': [],
  'toasts.opencodeVersion.head': [],
  'toasts.opencodeVersion.who': ['version'],
  'toasts.opencodeVersion.title': ['version'],
  'toasts.opencodeVersion.body': ['range'],
  'toasts.opencodeVersion.settings': [],
  'toasts.opencodeVersion.continue': [],
} as const satisfies MessageSpec;
