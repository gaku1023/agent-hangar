import type { editorKeys } from '../keys/editor.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const editorJa: AreaDictionary<typeof editorKeys> = {
  'editor.open.named': '{name} で開く',
  'editor.open.generic': 'エディタで開く',
  'editor.open.namedFor': '{target} を {name} で開く',
  'editor.open.genericFor': '{target} をエディタで開く',
  'editor.open.namedAt': '{target} の {line} 行目を {name} で開く',
  'editor.open.genericAt': '{target} の {line} 行目をエディタで開く',
  'editor.missing.lastPath': '最後に見つけた場所：{path}',
  'editor.missing.maybeMoved': 'アンインストールしたか、場所が変わった可能性があります。',
  'editor.missing.settings': '設定でエディタを選ぶ',
  'editor.missing.once': '今回は {name} で開く',
  'editor.missing.recheck': '再確認',
  'editor.missing.close': '閉じる',
};
