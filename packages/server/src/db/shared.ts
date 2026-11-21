import { noteWrite, onRowChange } from './notify.ts';
import type { Db } from './open.ts';

/**
 * 同じ行について、まだ送っていない差分を捨てる。
 * 同期は後勝ちなので、送る前の差分は最後の 1 つだけあれば足りる。
 * 実行中のセッションは本文が伸びるたびに書き込まれるので、これが無いと changes が際限なく増える。
 */
function dropUnpushed(db: Db, table: string, rowId: string): void {
  db.prepare('delete from changes where table_name = ? and row_id = ? and pushed_at is null').run(table, rowId);
}

/**
 * 共有テーブルへの書き込みの後に呼ばれる購読を足す。戻り値を呼ぶと購読を外す。
 * 行の変化の口（db/notify.ts の onRowChange）のうち、この端末の書き込み（write）だけを渡す薄い包みである。
 * 同期で降りた行（apply）と、書き込みを伴わない知らせ（touch）は渡さない。
 * 呼ばれる時機と、巻き戻りや購読の失敗の扱いは onRowChange と同じである。
 */
export function onSharedWrite(cb: (table: string, rowId: string, db: Db) => void): () => void {
  return onRowChange((c) => { if (c.origin === 'write') cb(c.table, c.rowId, c.db); });
}

/**
 * ほかの PC に早く見せたい書き込みか。
 * run の新規と、ended_at が空から入った書き込み、run の live_status が waiting に変わった書き込み、会話（sessions）の新規、未読の数が変わった session_states、開いて見ている会話の組が変わった devices だけである。
 * 会話の更新（本文の伸びで sessions は何度も書かれる）や run の pid と heartbeat の更新は含めない。
 * 書く前の行を読んで決める。
 */
function isUrgentWrite(db: Db, table: string, row: Record<string, unknown>, pk: string): boolean {
  if (table === 'devices') return 'viewing' in row && viewingMoved(db, row, pk);
  if (table === 'session_states') return 'unread_changed_at' in row && unreadMoved(db, row, pk);
  if (table !== 'runs' && table !== 'sessions') return false;
  const before = db.prepare(`select * from ${table} where ${pk} = ?`).get(row[pk]) as Record<string, unknown> | undefined;
  if (!before) return true;
  if (table !== 'runs') return false;
  // 入力待ちに変わったこと（live_status、runs/liveShare.ts）も急ぐ。作業中や休みへの変化は普段の送りに相乗りする。
  if (row.live_status === 'waiting' && before.live_status !== 'waiting') return true;
  return before.ended_at == null && row.ended_at != null;
}

/**
 * いま開いて見ている会話の組が変わる書き込みか（live/viewingShare.ts）。
 * もう 1 台が知らせを止めるのに使うので、2 秒以内に見せる。見ている間の刻み直し（組は同じ）は普段の送りに相乗りする。
 */
function viewingMoved(db: Db, row: Record<string, unknown>, pk: string): boolean {
  const before = db.prepare(`select viewing from devices where ${pk} = ?`).get(row[pk]) as { viewing: string | null } | undefined;
  return (before?.viewing ?? '[]') !== (row.viewing ?? '[]');
}

/**
 * 未読の数が変わる書き込みか（積む、既読にする、未読に戻す。live/unread.ts）。
 * 未読はもう 1 台にも 2 秒以内に見せる（2026-11-21、未読の同期）。ほかの事実（状態、ピン）だけの書き込みは普段の送りに相乗りする。
 */
function unreadMoved(db: Db, row: Record<string, unknown>, pk: string): boolean {
  const before = db.prepare(`select unread_count from session_states where ${pk} = ?`).get(row[pk]) as { unread_count: number | null } | undefined;
  return (before?.unread_count ?? null) !== (row.unread_count ?? null);
}

/**
 * 書く行の updated_at を決める。
 * 手元の行の updated_at より 1 ミリ秒以上後にする（Evolu の HLC に倣った）。
 * 同期は updated_at の後勝ちなので、時計の進んだ PC が書いた行を取り込んだ後に今の時刻で書くと、その行に負けて黙って捨てられる。
 * 手元の行より後にしておけば、見てから書いた変更は必ず勝つ。
 */
function stampAfter(db: Db, table: string, pk: string, id: unknown, at: number): number {
  const prev = db.prepare(`select updated_at from ${table} where ${pk} = ?`).get(id) as { updated_at: number | null } | undefined;
  const last = Number(prev?.updated_at);
  return Number.isFinite(last) ? Math.max(at, last + 1) : at;
}

/**
 * 共有テーブルへの書き込み。updated_at と origin_device を補い、changes に追記する。
 * at は updated_at に使う時刻で、省けば今の時刻である。同期で届いた行より確実に新しく書き直したいとき（sync/apply.ts）だけ渡す。
 * どちらでも、手元の行の updated_at より前にはしない（stampAfter）。
 */
export function upsertShared(db: Db, table: string, row: Record<string, unknown>, deviceId: string, pk = 'id', at = Date.now()): void {
  const urgent = isUrgentWrite(db, table, row, pk);
  const write = db.transaction(() => {
    const full: Record<string, unknown> = { ...row, updated_at: stampAfter(db, table, pk, row[pk], at), origin_device: deviceId };
    const cols = Object.keys(full);
    const sets = cols.filter((c) => c !== pk).map((c) => `${c} = excluded.${c}`).join(', ');
    const sql = `insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')}) on conflict(${pk}) do update set ${sets}`;
    db.prepare(sql).run(...cols.map((c) => full[c] as unknown));
    const stored = db.prepare(`select * from ${table} where ${pk} = ?`).get(full[pk]);
    dropUnpushed(db, table, String(full[pk]));
    const info = db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id) values (?,?,?,?,?,?)')
      .run(table, String(full[pk]), 'upsert', JSON.stringify(stored), full.updated_at, deviceId);
    return Number(info.lastInsertRowid);
  });
  noteWrite(db, table, String(row[pk]), 'upsert', write(), urgent);
}

/** 共有テーブルの行を論理削除し、changes に delete を追記する。 */
export function softDeleteShared(db: Db, table: string, id: string, deviceId: string, pk = 'id'): void {
  const write = db.transaction(() => {
    const now = Date.now();
    const stamp = stampAfter(db, table, pk, id, now);
    db.prepare(`update ${table} set deleted_at = ?, updated_at = ?, origin_device = ? where ${pk} = ?`).run(now, stamp, deviceId, id);
    const stored = db.prepare(`select * from ${table} where ${pk} = ?`).get(id);
    dropUnpushed(db, table, id);
    const info = db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id) values (?,?,?,?,?,?)')
      .run(table, id, 'delete', JSON.stringify(stored), stamp, deviceId);
    return Number(info.lastInsertRowid);
  });
  noteWrite(db, table, id, 'delete', write());
}
