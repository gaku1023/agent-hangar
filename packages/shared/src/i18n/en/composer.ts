import type { composerKeys } from '../keys/composer.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const composerEn: AreaDictionary<typeof composerKeys> = {
  'composer.source.project': 'Project',
  'composer.source.user': 'Personal',
  'composer.source.plugin': 'Plugin',
  'composer.source.builtin': 'Built-in',
  'composer.group.frequent': 'Frequently used',
  'composer.group.project': 'This project',
  'composer.group.user': 'Personal',
  'composer.group.plugin': 'Plugins',
  'composer.group.builtin': 'Built-in',
  'composer.card.remove': 'Remove {name}',
  'composer.card.sending': 'Sending',
  'composer.attach.tooLarge': '{name} is over 20 MB and cannot be attached',
  'composer.attach.failed': 'Could not attach {name} ({reason})',
  'composer.attach.unavailable': 'Attachments are not available',
  'composer.tool.skill': 'Skills',
  'composer.tool.file': 'Files',
  'composer.tool.fileNeedsProject': 'Select a project to use this',
  'composer.tool.attach': 'Attach',
  'composer.tool.pasteHint': 'You can also paste images with {keys}',
  'composer.list.fileLabel': 'Files',
  'composer.list.commandLabel': 'Skills and commands',
  'composer.list.failed': 'Could not load',
  'composer.list.recentFiles': 'Changed files',
  'composer.cards.label': 'Attachments',
};
