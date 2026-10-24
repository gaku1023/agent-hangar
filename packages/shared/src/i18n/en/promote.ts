import type { promoteKeys } from '../keys/promote.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const promoteEn: AreaDictionary<typeof promoteKeys> = {
  'promote.dialog.title': 'Promote to project',
  'promote.field.name': 'Project name',
  'promote.field.namePlaceholder': 'Name of the new directory',
  'promote.gitInit.label': 'Run git init',
  'promote.move.label': 'Move files',
  'promote.move.blocked': 'Files are not moved because the session is running',
  'promote.dialog.action': 'Promote',
  'promote.done.title': 'Promoted {name} to a project',
  'promote.done.moved': 'Files were moved',
  'promote.done.notMoved': 'Files were not moved',
  'promote.done.close': 'Close',
  'promote.done.openProject': 'Open project',
  'promote.done.startSession': 'Start a new session here',
};
