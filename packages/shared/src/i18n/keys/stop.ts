import type { MessageSpec } from '../messageSpec.ts';

/**
 * 止まっている理由（許可待ち、使用制限、リセット済み）の文。
 * 画面（サイドバー、ホーム、一覧、現在の札、知らせの札、パレット、ヘッダー）と、サーバが組むデスクトップ通知が使う。
 */
export const stopKeys = {
  'stop.state.permission': [],
  'stop.state.limit': [],
  'stop.state.reset': [],
  'stop.kind.fiveHour': [],
  'stop.kind.weekly': [],
  'stop.kind.other': [],
  'stop.time.otherDay': ['date', 'time'],
  'stop.notify.permission': ['tool', 'input'],
  'stop.notify.permissionTool': ['tool'],
  'stop.notify.permissionBare': [],
  'stop.notify.limitTitle': ['kind'],
  'stop.notify.limitOne': ['name', 'time'],
  'stop.notify.limitMany': ['n', 'time'],
  'stop.notify.reset': [],
  'stop.waited.permission': ['time'],
  'stop.waited.reset': ['time'],
  'stop.limit.line': ['kind', 'time', 'auto'],
  'stop.limit.lineOther': ['time', 'auto'],
  'stop.limit.auto': [],
  'stop.limit.noAuto': [],
  'stop.limit.left': ['time'],
  'stop.limit.at': ['time'],
  'stop.limit.short': ['time'],
  'stop.permission.unknown': [],
  'stop.action.allow': [],
  'stop.action.continue': [],
  'stop.band.attentionSummary': ['waiting', 'permission', 'reminders'],
  'stop.band.attentionSummaryReset': ['waiting', 'permission', 'reset', 'reminders'],
  'stop.band.runningSummary': ['busy', 'idle', 'limit'],
} as const satisfies MessageSpec;
