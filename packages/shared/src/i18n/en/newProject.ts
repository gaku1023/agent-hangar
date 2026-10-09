import type { newProjectKeys } from '../keys/newProject.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const newProjectEn: AreaDictionary<typeof newProjectKeys> = {
  'newProject.dialog.title': 'New project',
  'newProject.mode.aria': 'How to create',
  'newProject.mode.newDir': 'Create new folder',
  'newProject.mode.dir': 'Add existing folder',
  'newProject.field.name': 'Project name',
  'newProject.field.namePlaceholder': 'Name of the directory to create in the projects folder',
  'newProject.name.willCreate': 'Creates {path}',
  'newProject.gitInit.label': 'Run git init',
  'newProject.gitInit.description': 'Creates an empty repository',
  'newProject.field.folder': 'Folder',
  'newProject.search.placeholder': 'Search unregistered folders in the projects folder',
  'newProject.list.aria': 'Unregistered folders in the projects folder',
  'newProject.list.noMatch': 'No matches',
  'newProject.list.empty': 'No unregistered folders',
  'newProject.folder.pick': 'Choose another location…',
  'newProject.folder.or': 'or',
  'newProject.path.aria': 'Folder path',
  'newProject.path.placeholder': '/Users/you/… (type a path)',
  'newProject.footer.create': 'Create',
  'newProject.footer.createAndStart': 'Create and start',
};
