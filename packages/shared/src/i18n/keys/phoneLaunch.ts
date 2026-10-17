import type { MessageSpec } from '../messageSpec.ts';

/** スマホから起動したセッション（試作 F1）。右下の通知と、一覧の行とセッションの見出しのラベル。 */
export const phoneLaunchKeys = {
  'phoneLaunch.label.plain': [],
  'phoneLaunch.label.bypass': [],
  'phoneLaunch.label.title': [],
  'phoneLaunch.notice.head': [],
  'phoneLaunch.notice.headBypass': [],
  'phoneLaunch.notice.title': ['phone', 'project', 'mode'],
  'phoneLaunch.notice.titleUnknown': ['project', 'mode'],
  'phoneLaunch.notice.bypassNote': [],
  'phoneLaunch.button.open': [],
  'phoneLaunch.button.stop': [],
} as const satisfies MessageSpec;
