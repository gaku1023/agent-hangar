import type { connKeys } from '../keys/conn.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const connEn: AreaDictionary<typeof connKeys> = {
  'conn.banner.label': 'Connection status',
  'conn.hard.title': 'Cannot reach the server',
  'conn.hard.restartPrompt': 'Restart the app',
  'conn.hard.openLog': 'Open log',
  'conn.hard.restart': 'Restart',
  'conn.hard.browserHint': 'Restart the app. Log: {path}',
  'conn.hard.logName': 'Log location',
  'conn.hard.copyLocation': 'Copy location',
  'conn.lost.title': 'Connection lost',
  'conn.lost.retryNow': 'Reconnect now',
  'conn.stale.stopped': 'The screen has stopped updating',
  'conn.stale.since': 'The screen stopped updating {time}',
  'conn.retry.in': 'Reconnecting in {n} s',
  'conn.retry.now': 'Reconnecting',
};
