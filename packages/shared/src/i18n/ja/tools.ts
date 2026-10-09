import type { toolsKeys } from '../keys/tools.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const toolsJa: AreaDictionary<typeof toolsKeys> = {
  'tools.edit.replaceAll': 'すべて置き換え',
  'tools.edit.hunk': '@@ {n} か所目 @@',
  'tools.edit.count': '{n} か所',
  'tools.lines.count': '{n} 行',
  'tools.lines.range': '{from}〜{to} 行',
  'tools.lines.from': '{n} 行から',
  'tools.write.created': '新しいファイル',
  'tools.bash.exit': '終了 {code}',
  'tools.bash.failed': '失敗',
  'tools.search.count': '{n} 件',
  'tools.todo.title': 'TODO {n} 件',
  'tools.todo.done': '済み {n}',
  'tools.todo.status.completed': '済み',
  'tools.todo.status.inProgress': '作業中',
  'tools.todo.status.pending': '未着手',
  'tools.find.files': '{n} ファイル',
  'tools.find.none': 'なし',
};
