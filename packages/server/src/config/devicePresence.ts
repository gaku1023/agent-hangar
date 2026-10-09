import type { ShellHookDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import type { DeviceInfo } from './paths.ts';

/** devices に最終確認を書き込む間隔。 */
export const DEVICE_TOUCH_MS = 600_000;

/**
 * 自端末の生存を devices に刻む。他端末の Settings の一覧と、ロックの端末名と、包み方の状態がここから出る。
 * devices.update は、この行の知らせから events/publisher.ts が配る。
 */
export function touchDevice(o: { db: Db; device: DeviceInfo; shellHook: () => Pick<ShellHookDto, 'state'>; now?: () => number }): void {
  const row = o.db.prepare('select * from devices where id = ?').get(o.device.id) as Record<string, unknown> | undefined;
  upsertShared(o.db, 'devices', { ...(row ?? {}), id: o.device.id, name: o.device.name, platform: o.device.platform, last_seen_at: (o.now ?? Date.now)(), shell_hook: o.shellHook().state, deleted_at: null }, o.device.id);
}

/**
 * 包み方の状態を測り、前に刻んだ値と違えば devices を刻み直す。
 * Settings を開いたときに測り直す。CLI で入れた直後に開けば、ここで他の PC にも知らせる。
 */
export function measureShellHook<T extends Pick<ShellHookDto, 'state'>>(o: { db: Db; deviceId: string; shellHook: () => T; touch: () => void }): T {
  const h = o.shellHook();
  const cur = o.db.prepare('select shell_hook from devices where id = ?').get(o.deviceId) as { shell_hook: string | null } | undefined;
  if (cur && cur.shell_hook !== h.state) o.touch();
  return h;
}
