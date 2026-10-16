import type { DeviceRow } from './env.ts';

/**
 * 最終確認を書き直す間隔（同期の版 6）。
 * push、pull、本文の PUT のたびに書くと、PC 1 台で 1 日に数万行を書く。
 * 他の PC の生存は「Worker の now − lastSeenAt」で見て、約 3 分（端末の PEER_STALE_MS）で古いとみなすので、1 分の粗さで足りる。
 */
export const TOUCH_EVERY_MS = 60_000;

/**
 * 最後に同期した時刻を書く文。
 * 持つのは PC ごとに最後の 1 件だけで、履歴は持たない。
 * IP と所在地は保存しない（互換の版 9）。
 */
export function touchDevice(db: D1Database, deviceId: string, now: number): D1PreparedStatement {
  return db.prepare('update devices set last_seen_at = ? where id = ?').bind(now, deviceId);
}

/**
 * 書く必要があるときだけ、最終確認を書く文を返す。要らなければ null である。
 * 認証で読んだ行（`device`）を見るので、判定のために D1 を読み直さない。
 * 前回から TOUCH_EVERY_MS たったときに書く。
 */
export function touchIfDue(db: D1Database, device: DeviceRow, now: number): D1PreparedStatement | null {
  const last = device.last_seen_at;
  const due = last === null || last === undefined || now - last >= TOUCH_EVERY_MS;
  return due ? touchDevice(db, device.id, now) : null;
}
