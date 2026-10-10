import type { MessageSpec } from '../messageSpec.ts';

export const newProjectKeys = {
  'newProject.dialog.title': [],
  'newProject.mode.aria': [],
  'newProject.mode.newDir': [],
  'newProject.mode.dir': [],
  'newProject.field.name': [],
  'newProject.field.namePlaceholder': [],
  'newProject.name.willCreate': ['path'],
  'newProject.gitInit.label': [],
  'newProject.gitInit.description': [],
  'newProject.field.folder': [],
  'newProject.search.placeholder': [],
  'newProject.list.aria': [],
  'newProject.list.noMatch': [],
  'newProject.list.empty': [],
  'newProject.folder.pick': [],
  'newProject.folder.or': [],
  'newProject.path.aria': [],
  'newProject.path.placeholder': [],
  'newProject.footer.create': [],
  'newProject.footer.createAndStart': [],
} as const satisfies MessageSpec;
