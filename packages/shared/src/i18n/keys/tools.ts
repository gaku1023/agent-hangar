import type { MessageSpec } from '../messageSpec.ts';

export const toolsKeys = {
  'tools.edit.replaceAll': [],
  'tools.edit.hunk': ['n'],
  'tools.edit.count': ['n'],
  'tools.lines.count': ['n'],
  'tools.lines.range': ['from', 'to'],
  'tools.lines.from': ['n'],
  'tools.write.created': [],
  'tools.bash.exit': ['code'],
  'tools.bash.failed': [],
  'tools.search.count': ['n'],
  'tools.todo.title': ['n'],
  'tools.todo.done': ['n'],
  'tools.todo.status.completed': [],
  'tools.todo.status.inProgress': [],
  'tools.todo.status.pending': [],
  'tools.find.files': ['n'],
  'tools.find.none': [],
} as const satisfies MessageSpec;
