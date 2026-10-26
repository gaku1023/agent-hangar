import type { paneKeys } from '../keys/pane.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const paneJa: AreaDictionary<typeof paneKeys> = {
  'pane.workspace.label': '分割したセッション',
  'pane.header.label': 'ペイン: {name}',
  'pane.toc.open': '右パネルを開く',
  'pane.toc.close': '右パネルを閉じる',
  'pane.header.remove': '分割から外す',
  'pane.header.unzoom': '最大化を解除',
  'pane.empty.title': '空のペイン',
  'pane.empty.lead': 'このペインで開くセッションを選択してください',
  'pane.empty.hint': 'サイドバーからドラッグ＆ドロップもできます',
  'pane.divider.title': 'ドラッグでサイズ変更 / ダブルクリックで均等化',
  'pane.divider.name': 'ペインの境目',
  'pane.divider.valueText': '前のペイン {percent}%',
  'pane.drop.left': '左に分割',
  'pane.drop.right': '右に分割',
  'pane.drop.up': '上に分割',
  'pane.drop.down': '下に分割',
  'pane.drop.open': 'ここで開く',
  'pane.drop.swap': '位置を入れ替える',
  'pane.drop.self': '同じ位置には配置できません',
};
