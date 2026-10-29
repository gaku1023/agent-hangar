import type { sidebarKeys } from '../keys/sidebar.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const sidebarJa: AreaDictionary<typeof sidebarKeys> = {
  'sidebar.live.label': '実行中のセッション',
  'sidebar.count.waiting': '、入力待ち {n}',
  'sidebar.count.unread': '、未読 {n} 件',
  'sidebar.live.rowTitle': '{name}（{waited}）',
  'sidebar.live.waited': '入力待ち {time}',
  'sidebar.live.stop': '停止',
  'sidebar.live.stopExternal': '外部ターミナルで実行中',
  'sidebar.toggle.open': 'サイドバーを開く',
  'sidebar.toggle.close': 'サイドバーを閉じる',
  'sidebar.toggle.tipOpen': '開く',
  'sidebar.toggle.tipClose': '閉じる',
  'sidebar.width.label': 'サイドバーの幅',
  'sidebar.width.valueText': '{width}px',
  'sidebar.width.tip': 'ドラッグして幅を変更、ダブルクリックでリセット',
  'sidebar.nav.label': 'メインナビゲーション',
  'sidebar.nav.home': 'ホーム',
  'sidebar.nav.projects': 'プロジェクト',
  'sidebar.nav.settings': '設定',
};
