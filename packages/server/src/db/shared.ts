import type { Db } from './open.ts';

/** 共有テーブルへの書き込み。updated_at と origin_device を補い、changes に追記する。 */
export function upsertShared(db: Db, table: string, row: Record<string, unknown>, deviceId: string, pk = 'id'): void {
  const full: Record<string, unknown> = { ...row, updated_at: Date.now(), origin_device: deviceId };
  const cols = Object.keys(full);
  const sets = cols.filter((c) => c !== pk).map((c) => `${c} = excluded.${c}`).join(', ');
  const sql = `insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')}) on conflict(${pk}) do update set ${sets}`;
  const write = db.transaction(() => {
    db.prepare(sql).run(...cols.map((c) => full[c] as unknown));
    const stored = db.prepare(`select * from ${table} where ${pk} = ?`).get(full[pk]);
    db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id) values (?,?,?,?,?,?)')
      .run(table, String(full[pk]), 'upsert', JSON.stringify(stored), full.updated_at, deviceId);
  });
  write();
}

/** 共有テーブルの行を論理削除し、changes に delete を追記する。 */
export function softDeleteShared(db: Db, table: string, id: string, deviceId: string, pk = 'id'): void {
  const now = Date.now();
  const write = db.transaction(() => {
    db.prepare(`update ${table} set deleted_at = ?, updated_at = ?, origin_device = ? where ${pk} = ?`).run(now, now, deviceId, id);
    const stored = db.prepare(`select * from ${table} where ${pk} = ?`).get(id);
    db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id) values (?,?,?,?,?,?)')
      .run(table, id, 'delete', JSON.stringify(stored), now, deviceId);
  });
  write();
}
