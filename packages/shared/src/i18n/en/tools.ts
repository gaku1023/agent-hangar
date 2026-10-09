import type { toolsKeys } from '../keys/tools.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const toolsEn: AreaDictionary<typeof toolsKeys> = {
  'tools.edit.replaceAll': 'Replace all',
  'tools.edit.hunk': '@@ Edit {n} @@',
  'tools.edit.count': '{n} {n|edit|edits}',
  'tools.lines.count': '{n} {n|line|lines}',
  'tools.lines.range': 'Lines {from}–{to}',
  'tools.lines.from': 'From line {n}',
  'tools.write.created': 'New file',
  'tools.bash.exit': 'Exit {code}',
  'tools.bash.failed': 'Failed',
  'tools.search.count': '{n} {n|result|results}',
  'tools.todo.title': '{n} {n|to-do|to-dos}',
  'tools.todo.done': 'Done {n}',
  'tools.todo.status.completed': 'Done',
  'tools.todo.status.inProgress': 'In progress',
  'tools.todo.status.pending': 'Not started',
  'tools.find.files': '{n} {n|file|files}',
  'tools.find.none': 'None',
};
