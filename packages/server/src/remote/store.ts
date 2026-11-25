import type { Db } from '../db/open.ts';

/**
 * SSH のシェルタブの手元だけの表（版 73）。同期しないので、changes にも載せず upsertShared も通さない。
 * remote_name は相手の PC の端末の多重化に付けた会話の名前（hangar-ssh-<id>）。
 */
export type RemoteTabRow = { id: string; sessionId: string; deviceId: string; remoteName: string; title: string; createdAt: number; closedAt: number | null; killPending: boolean };

type Raw = { id: string; session_id: string; device_id: string; remote_name: string; title: string; created_at: number; closed_at: number | null; kill_pending: number };
const toRow = (r: Raw): RemoteTabRow => ({ id: r.id, sessionId: r.session_id, deviceId: r.device_id, remoteName: r.remote_name, title: r.title, createdAt: r.created_at, closedAt: r.closed_at, killPending: r.kill_pending !== 0 });

export function insertRemoteTab(db: Db, t: { id: string; sessionId: string; deviceId: string; remoteName: string; title: string; createdAt: number }): void {
  db.prepare('insert into remote_tabs (id, session_id, device_id, remote_name, title, created_at) values (?, ?, ?, ?, ?, ?)').run(t.id, t.sessionId, t.deviceId, t.remoteName, t.title, t.createdAt);
}

export function getRemoteTab(db: Db, id: string): RemoteTabRow | null {
  const r = db.prepare('select * from remote_tabs where id = ?').get(id) as Raw | undefined;
  return r ? toRow(r) : null;
}

/** 開いている（閉じていない）タブを、作った順に返す。sessionId があればその会話のものだけ。 */
export function listOpenRemoteTabs(db: Db, sessionId?: string): RemoteTabRow[] {
  const rows = (sessionId === undefined
    ? db.prepare('select * from remote_tabs where closed_at is null order by created_at, id').all()
    : db.prepare('select * from remote_tabs where closed_at is null and session_id = ? order by created_at, id').all(sessionId)) as Raw[];
  return rows.map(toRow);
}

/** 閉じた時刻を置く。すでに閉じていれば最初の時刻を保つ。 */
export function closeRemoteTab(db: Db, id: string, at: number): void {
  db.prepare('update remote_tabs set closed_at = ? where id = ? and closed_at is null').run(at, id);
}

export function setKillPending(db: Db, id: string, pending: boolean): void {
  db.prepare('update remote_tabs set kill_pending = ? where id = ?').run(pending ? 1 : 0, id);
}

export function markKillDone(db: Db, id: string): void { setKillPending(db, id, false); }

/** 閉じたのに相手のシェルを消せていないタブ。次にその PC へつながったときに消す。 */
export function listPendingKills(db: Db, deviceId: string): RemoteTabRow[] {
  return (db.prepare('select * from remote_tabs where device_id = ? and kill_pending = 1 order by created_at, id').all(deviceId) as Raw[]).map(toRow);
}

export function getRemoteHost(db: Db, deviceId: string): string | null {
  const r = db.prepare('select host from remote_ssh_hosts where device_id = ?').get(deviceId) as { host: string } | undefined;
  return r?.host ?? null;
}

/** 上書きの Host 名を置く。null なら消す。 */
export function setRemoteHost(db: Db, deviceId: string, host: string | null, at: number): void {
  if (host === null) { db.prepare('delete from remote_ssh_hosts where device_id = ?').run(deviceId); return; }
  db.prepare('insert into remote_ssh_hosts (device_id, host, updated_at) values (?, ?, ?) on conflict(device_id) do update set host = excluded.host, updated_at = excluded.updated_at').run(deviceId, host, at);
}

/** bootstrap 用。device id から Host 名。 */
export function listRemoteHosts(db: Db): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.prepare('select device_id, host from remote_ssh_hosts').all() as { device_id: string; host: string }[]) out[r.device_id] = r.host;
  return out;
}
