import type { phoneLaunchKeys } from '../keys/phoneLaunch.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const phoneLaunchEn: AreaDictionary<typeof phoneLaunchKeys> = {
  'phoneLaunch.label.plain': 'From phone',
  'phoneLaunch.label.bypass': 'From phone · Bypass permissions',
  'phoneLaunch.label.title': 'Session started from a phone',
  'phoneLaunch.notice.head': 'Started from phone',
  'phoneLaunch.notice.headBypass': 'Started from phone · Bypass permissions',
  'phoneLaunch.notice.title': 'Started from {phone}: {project} ({mode})',
  'phoneLaunch.notice.titleUnknown': 'Started from a phone: {project} ({mode})',
  'phoneLaunch.notice.bypassNote': 'Claude will use tools without asking first. If you did not expect this, stop the session.',
  'phoneLaunch.button.open': 'Open',
  'phoneLaunch.button.stop': 'Stop',
};
