import type { MessageSpec } from '../messageSpec.ts';

export const connKeys = {
  'conn.banner.label': [],
  'conn.hard.title': [],
  'conn.hard.restartPrompt': [],
  'conn.hard.openLog': [],
  'conn.hard.restart': [],
  'conn.hard.browserHint': ['path'],
  'conn.hard.logName': [],
  'conn.hard.copyLocation': [],
  'conn.lost.title': [],
  'conn.lost.retryNow': [],
  'conn.stale.stopped': [],
  'conn.stale.since': ['time'],
  'conn.retry.in': ['n'],
  'conn.retry.now': [],
} as const satisfies MessageSpec;
