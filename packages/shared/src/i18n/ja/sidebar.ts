import type { sidebarKeys } from '../keys/sidebar.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const sidebarJa: AreaDictionary<typeof sidebarKeys> = {
  'sidebar.live.title': '実行中',
  'sidebar.live.label': '実行中のセッション',
  'sidebar.count.waiting': '、入力待ち {n}',
  'sidebar.live.rowTitle': '{name}（{waited}）',
  'sidebar.live.waited': '入力待ち {time}',
  'sidebar.live.menuLabel': '{name} の操作',
  'sidebar.live.stop': '停止',
  'sidebar.live.stopNote': 'Claude を終了します。トランスクリプトは残るので、あとで再開できます',
  'sidebar.live.stopExternal': '外部ターミナルで実行中',
  'sidebar.live.more': 'ほか {n} 件',
  'sidebar.toggle.open': 'サイドバーを開く',
  'sidebar.toggle.close': 'サイドバーを閉じる',
  'sidebar.toggle.tipOpen': '開く',
  'sidebar.toggle.tipClose': '閉じる',
  'sidebar.nav.label': '主ナビゲーション',
  'sidebar.nav.home': 'ホーム',
  'sidebar.nav.projects': 'プロジェクト',
  'sidebar.nav.settings': '設定',
};
