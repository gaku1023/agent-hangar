import type { connKeys } from '../keys/conn.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const connJa: AreaDictionary<typeof connKeys> = {
  'conn.banner.label': '接続の状態',
  'conn.hard.title': 'サーバに戻れません',
  'conn.hard.restartPrompt': 'アプリを再起動してください',
  'conn.hard.openLog': 'ログを開く',
  'conn.hard.restart': '再起動',
  'conn.hard.browserHint': 'アプリを再起動してください。ログ: {path}',
  'conn.hard.logName': 'ログの場所',
  'conn.hard.copyLocation': '場所をコピー',
  'conn.lost.title': '接続が切れています',
  'conn.lost.retryNow': '今すぐ再接続',
  'conn.stale.stopped': '画面の更新が止まっています',
  'conn.stale.since': '画面は {time}のまま止まっています',
  'conn.retry.in': '{n} 秒後に再接続します',
  'conn.retry.now': '再接続しています',
};
