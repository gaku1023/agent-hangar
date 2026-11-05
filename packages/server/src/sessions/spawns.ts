import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';

/**
 * 親子の結び付き（session_spawns）。同期する共有表で、子の会話 1 つに 1 行である（主キーは子の session_id）。
 * 親は MCP の create_session を呼んだ会話で、子は起こされた会話である。親と子が別の PC にあることもある（別の PC への起動、D17）。
 *
 * 行の状態は 3 つある。
 * - 生きていて relay が on：子のターンの結果を親へ返し続ける。
 * - 生きていて relay が off：「終わった」を返し終えた。入れ子の見た目は残すが、結果は返さない（D15）。
 * - deleted_at がある：利用者が起動元から切り離したか、親か子が消えた。入れ子も結果の返却もなくなる。
 * 状態を別の行にせず同じ行の列に持つのは、行の主キーが子の会話で、親子の PC のどちらからも同じ行として見えるからである。
 * 2 台が同時に書いたときは updated_at の新しい方が勝つ。off と削除は一方向にしか進まないので、起こし直し（recordSpawn）以外では on に戻らない。
 */
export type SpawnLink = {
  childId: string;
  parentId: string;
  parentDeviceId: string;
  childDeviceId: string;
  relay: 'on' | 'off';
  closedAt: number | null;
  createdAt: number;
};

type SpawnRow = { session_id: string; parent_id: string; parent_device_id: string | null; child_device_id: string | null; relay: string; closed_at: number | null; created_at: number };

function linkOf(r: SpawnRow, deviceId: string): SpawnLink {
  // 起動時の埋め直しの前の行（null）は、この PC の中の結び付きとして読む。
  return {
    childId: r.session_id, parentId: r.parent_id,
    parentDeviceId: r.parent_device_id ?? deviceId, childDeviceId: r.child_device_id ?? deviceId,
    relay: r.relay === 'off' ? 'off' : 'on', closedAt: r.closed_at, createdAt: r.created_at,
  };
}

/**
 * 会話の起動元を残す。同じ会話を 2 度残したら、後の起動元で置き換え、返し続ける状態に戻す。
 * 親と子の PC は、省けばどちらもこの PC である（同じ PC の中の create_session）。
 * 残したら会話の行を触り、画面の一覧に入れ子を配る。
 */
export function recordSpawn(db: Db, deviceId: string, sessionId: string, parentId: string, now: number, o: { parentDeviceId?: string; childDeviceId?: string } = {}): void {
  if (sessionId === parentId) return;
  upsertShared(db, 'session_spawns', {
    session_id: sessionId, parent_id: parentId, created_at: now,
    parent_device_id: o.parentDeviceId ?? deviceId, child_device_id: o.childDeviceId ?? deviceId,
    relay: 'on', closed_at: null, deleted_at: null,
  }, deviceId, 'session_id');
  touchRow(db, 'sessions', sessionId);
}

/** 生きている結び付き 1 件。無ければ null。 */
export function getSpawn(db: Db, deviceId: string, childId: string): SpawnLink | null {
  const r = db.prepare('select session_id, parent_id, parent_device_id, child_device_id, relay, closed_at, created_at from session_spawns where session_id = ? and deleted_at is null').get(childId) as SpawnRow | undefined;
  return r ? linkOf(r, deviceId) : null;
}

/** 利用者が起動元から外した。入れ子も結果の返却もなくなり、両方の PC から消える。親の状態が変わっても戻らない。 */
export function forgetSpawn(db: Db, deviceId: string, sessionId: string): void {
  if (getSpawn(db, deviceId, sessionId) === null) return;
  softDeleteShared(db, 'session_spawns', sessionId, deviceId, 'session_id');
  touchRow(db, 'sessions', sessionId);
}

/** 会話を消すとき、その会話が子の行と、その会話が親の行を全部切る。起動元が消えた子は、平らに並ぶ。 */
export function forgetSpawnsOf(db: Db, deviceId: string, sessionId: string): void {
  const rows = db.prepare('select session_id from session_spawns where (session_id = ? or parent_id = ?) and deleted_at is null').all(sessionId, sessionId) as { session_id: string }[];
  for (const r of rows) softDeleteShared(db, 'session_spawns', r.session_id, deviceId, 'session_id');
}

/** 「終わった」を返し終えた。結び付きの行は残して（入れ子はそのまま）、結果を返すのだけをやめる。すでに切れていれば何もしない。 */
export function closeSpawn(db: Db, deviceId: string, childId: string, now: number): void {
  const r = db.prepare('select * from session_spawns where session_id = ? and deleted_at is null and relay = ?').get(childId, 'on') as Record<string, unknown> | undefined;
  if (!r) return;
  upsertShared(db, 'session_spawns', { ...r, relay: 'off', closed_at: now }, deviceId, 'session_id');
}

/**
 * 起動時に、まだ PC の ID を持たない行（版 47 より前の行）を手元の ID で埋める。親も子もこの PC である。
 * 埋めた行は同期の行として積まれ、ほかの PC にも届く。何度呼んでも同じ。
 */
export function backfillSpawnDevices(db: Db, deviceId: string): void {
  const rows = db.prepare('select * from session_spawns where parent_device_id is null or child_device_id is null').all() as Record<string, unknown>[];
  for (const r of rows) {
    upsertShared(db, 'session_spawns', { ...r, parent_device_id: r.parent_device_id ?? deviceId, child_device_id: r.child_device_id ?? deviceId }, deviceId, 'session_id', Math.max(Date.now(), Number(r.updated_at ?? 0) + 1));
  }
}

/**
 * T6（受ける側）。この PC の会話のターンの結果を、別の PC の親へ返し続けるか。
 * 子がこの PC にあり、親が別の PC にあり、返し続けている（relay が on）ときだけ、その結び付きを返す。
 * 同じ PC の中の入れ子は結果を返さないので、null を返す。
 */
export function relayTarget(db: Db, deviceId: string, childId: string): SpawnLink | null {
  const l = getSpawn(db, deviceId, childId);
  return l && l.childDeviceId === deviceId && l.parentDeviceId !== deviceId && l.relay === 'on' ? l : null;
}

/**
 * T7（呼ぶ側）。別の PC の子から届いた結果を受けてよいか。
 * 親がこの PC にあり、子が fromDevice にあり、返し続けている（relay が on）ときだけ true。
 * 切り離した後や「終わった」の後に届いた結果は受けない。
 */
export function acceptsResultFrom(db: Db, deviceId: string, childId: string, fromDevice: string): boolean {
  const l = getSpawn(db, deviceId, childId);
  return !!l && l.parentDeviceId === deviceId && l.childDeviceId === fromDevice && l.relay === 'on';
}

/**
 * T8（MCP）。callerSessionId が、targetSessionId を自分で起こした相手か（D16）。
 * 親がこの PC の callerSessionId で、生きている結び付きがあれば true。相手が別の PC にあっても同じ。
 * 「終わった」の後（relay が off）でも、切り離すまでは起こした相手のままである。
 */
export function isSpawnedBy(db: Db, deviceId: string, callerSessionId: string, targetSessionId: string): boolean {
  const l = getSpawn(db, deviceId, targetSessionId);
  return !!l && l.parentId === callerSessionId && l.parentDeviceId === deviceId;
}

/**
 * 深さの検査（D11）。この PC の会話が、別の PC から起こされたものか。
 * そうなら、この会話はさらに別の PC には起こせない。同じ PC の中の入れ子では false である。
 */
export function isSpawnedFromOtherDevice(db: Db, deviceId: string, sessionId: string): boolean {
  const l = getSpawn(db, deviceId, sessionId);
  return !!l && l.childDeviceId === deviceId && l.parentDeviceId !== deviceId;
}
