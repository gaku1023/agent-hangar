import type { MessageSpec } from '../messageSpec.ts';

export const mediatorKeys = {
  'mediator.connection.caughtUp': [],
  'mediator.launch.pickProject': [],
  'mediator.launch.adopting': [],
  'mediator.promote.nameRequired': [],
  'mediator.promote.nameSlash': [],
  'mediator.promote.promoted': [],
  'mediator.projectCreate.created': [],
  'mediator.screen.noWaiting': [],
  'mediator.pane.alreadyOpen': [],
  'mediator.pane.lastPane': [],
  'mediator.sessionView.splitNeedsTwoTabs': [],
  'mediator.settings.itermHint': [],
} as const satisfies MessageSpec;
