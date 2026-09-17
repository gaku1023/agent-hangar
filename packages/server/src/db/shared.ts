import type { Db } from './open.ts';

/**
 * 同じ行について、まだ送っていない差分を捨てる。
 * 同期は後勝ちなので、送る前の差分は最後の 1 つだけあれば足りる。
 * 実行中のセッションは本文が伸びるたびに書き込まれるので、これが無いと changes が際限なく増える。
 */
function dropUnpushed(db: Db, table: string, rowId: string): void {
  db.prepare('delete from changes where table_name = ? and row_id = ? and pushed_at is null').run(table, rowId);
}

/** 共有テーブルへの書き込み。updated_at と origin_device を補い、changes に追記する。 */
export function upsertShared(db: Db, table: string, row: Record<string, unknown>, deviceId: string, pk = 'id'): void {
  const full: Record<string, unknown> = { ...row, updated_at: Date.now(), origin_device: deviceId };
  const cols = Object.keys(full);
  const sets = cols.filter((c) => c !== pk).map((c) => `${c} = excluded.${c}`).join(', ');
  const sql = `insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')}) on conflict(${pk}) do update set ${sets}`;
  const write = db.transaction(() => {
    db.prepare(sql).run(...cols.map((c) => full[c] as unknown));
    const stored = db.prepare(`select * from ${table} where ${pk} = ?`).get(full[pk]);
    dropUnpushed(db, table, String(full[pk]));
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
    dropUnpushed(db, table, id);
    db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id) values (?,?,?,?,?,?)')
      .run(table, id, 'delete', JSON.stringify(stored), now, deviceId);
  });
  write();
}
