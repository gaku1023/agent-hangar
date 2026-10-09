import type { promoteKeys } from '../keys/promote.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const promoteEn: AreaDictionary<typeof promoteKeys> = {
  'promote.dialog.title': 'Promote to project',
  'promote.dialog.lead': 'The work of {name} will be moved under the projects folder.',
  'promote.field.name': 'Project name',
  'promote.field.namePlaceholder': 'Name of the directory to create in the projects folder',
  'promote.gitInit.label': 'Run git init',
  'promote.gitInit.description': 'Creates an empty repository, then moves the files',
  'promote.move.label': 'Move files',
  'promote.move.description': "Moves the quick session's files to the projects folder",
  'promote.move.blocked': 'Files are not moved because the session is running',
  'promote.dialog.action': 'Promote',
  'promote.done.title': 'Promoted {name} to a project',
  'promote.done.moved': 'Files were moved',
  'promote.done.notMoved': 'Files were not moved',
  'promote.done.close': 'Close',
  'promote.done.openProject': 'Open project',
  'promote.done.startSession': 'Start a new session here',
};
