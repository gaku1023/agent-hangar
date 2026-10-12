import type { stopKeys } from '../keys/stop.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const stopEn: AreaDictionary<typeof stopKeys> = {
  'stop.state.permission': 'Needs permission',
  'stop.state.limit': 'Usage limit',
  'stop.state.reset': 'Limit reset',
  'stop.kind.fiveHour': '5-hour',
  'stop.kind.weekly': 'Weekly',
  'stop.kind.other': 'Usage limit',
  'stop.time.otherDay': '{date} {time}',
  'stop.notify.permission': 'Needs permission: {tool} {input}',
  'stop.notify.permissionTool': 'Needs permission: {tool}',
  'stop.notify.permissionBare': 'Waiting for your permission',
  'stop.notify.limitTitle': 'Usage limit ({kind})',
  'stop.notify.limitOne': '{name} stopped. Resets at {time}',
  'stop.notify.limitMany': '{n} sessions stopped. Resets at {time}',
  'stop.notify.reset': 'Your usage limit has reset. Tell Claude to continue',
};
