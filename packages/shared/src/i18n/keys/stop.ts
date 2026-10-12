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
} as const satisfies MessageSpec;
