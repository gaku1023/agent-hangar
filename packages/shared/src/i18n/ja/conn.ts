import type { connKeys } from '../keys/conn.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const connJa: AreaDictionary<typeof connKeys> = {
  'conn.banner.label': '接続の状態',
  'conn.hard.title': 'サーバーに接続できません',
  'conn.hard.restartPrompt': 'アプリを再起動してください',
  'conn.hard.openLog': 'ログを開く',
  'conn.hard.restart': '再起動',
  'conn.hard.browserHint': 'アプリを再起動してください。ログ: {path}',
  'conn.hard.logName': 'ログのパス',
  'conn.hard.copyLocation': 'パスをコピー',
  'conn.lost.title': '接続が切れました',
  'conn.lost.retryNow': '今すぐ再接続',
  'conn.stale.stopped': '画面の更新が停止しています',
  'conn.stale.since': '画面の最終更新：{time}',
  'conn.retry.in': '{n} 秒後に再接続します',
  'conn.retry.now': '再接続中…',
};
