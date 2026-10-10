import type { mediatorKeys } from '../keys/mediator.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const mediatorEn: AreaDictionary<typeof mediatorKeys> = {
  'mediator.connection.caughtUp': 'Caught up with the latest state',
  'mediator.launch.pickProject': 'Select a project',
  'mediator.launch.adopting': 'Moving to Hangar',
  'mediator.promote.nameRequired': 'Enter a name',
  'mediator.promote.nameSlash': 'The name cannot contain / or \\',
  'mediator.promote.promoted': 'Promoted to project',
  'mediator.projectCreate.created': 'Project created',
  'mediator.screen.noWaiting': 'No sessions need input',
  'mediator.sessionView.splitNeedsTwoTabs': 'Two tabs are needed to split side by side',
  'mediator.settings.itermHint': 'The first time you open in iTerm2, macOS shows an automation permission dialog',
};
