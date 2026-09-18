import type { Db } from './open.ts';

/**
 * 同じ行について、まだ送っていない差分を捨てる。
 * 同期は後勝ちなので、送る前の差分は最後の 1 つだけあれば足りる。
 * 実行中のセッションは本文が伸びるたびに書き込まれるので、これが無いと changes が際限なく増える。
 */
function dropUnpushed(db: Db, table: string, rowId: string): void {
  db.prepare('delete from changes where table_name = ? and row_id = ? and pushed_at is null').run(table, rowId);
}

type SharedWriteListener = (table: string, rowId: string, db: Db) => void;

const writeListeners = new Set<SharedWriteListener>();

/** 外側のトランザクションの中で起きた書き込み。確定を待ってから配る。 */
type PendingNotice = { table: string; rowId: string; seq: number };
const pending = new Map<Db, PendingNotice[]>();

/**
 * 共有テーブルへの書き込みの後に呼ばれる購読を足す。
 * 同期エンジンが push のデバウンスに使う。
 * 戻り値を呼ぶと購読を外す。
 *
 * 呼ばれるのは、書き込みが確定した後である。
 * 外側のトランザクションに包まれているときは、その最外が確定するまで遅れる（そのぶん同期ではなくなる）。
 * 巻き戻ったときは呼ばれない。
 * 購読が投げても、他の購読にも書き込んだ側にも波及しない。
 */
export function onSharedWrite(cb: SharedWriteListener): () => void {
  writeListeners.add(cb);
  return () => { writeListeners.delete(cb); };
}

/** 購読を 1 つずつ包んで呼ぶ。1 つの失敗で残りと呼び手を巻き込まない。 */
function deliver(db: Db, table: string, rowId: string): void {
  for (const cb of [...writeListeners]) {
    try {
      cb(table, rowId, db);
    } catch (e) {
      // 例外のメッセージには秘密が載りうるので出さない。どの行で、どの種類の失敗かだけを残す。
      console.error(`[sync] 共有テーブルの購読が失敗しました（${table}:${rowId}、${e instanceof Error ? e.name : typeof e}）`);
    }
  }
}

/** 溜めた通知を配る。最外のトランザクションが終わってから呼ばれる。 */
function drain(db: Db): void {
  const queue = pending.get(db);
  if (!queue) return;
  pending.delete(db);
  try {
    if (!db.open) return;
    // 巻き戻っていれば changes の行ごと消えている。起きなかった書き込みを同期に乗せない。
    // 同じ行をもう一度書いたときも、古い方は dropUnpushed で消えているので新しい通知だけが残る。
    const alive = db.prepare('select 1 from changes where seq = ?');
    for (const p of queue) if (alive.get(p.seq) !== undefined) deliver(db, p.table, p.rowId);
  } catch (e) {
    console.error(`[sync] 溜めた書き込みの通知を配れませんでした（${e instanceof Error ? e.name : typeof e}）`);
  }
}

/**
 * 書き込みの後に購読へ知らせる。
 * 外側のトランザクションの中なら、確定を待ってから配る。
 * ここで配ってしまうと、購読は確定前の値（MemoStore.adoptFile が直す前の updated_at）を読み、
 * 購読が DB に書けばその書き込みごと外側の巻き戻しに巻き込まれる。
 */
function notify(db: Db, table: string, rowId: string, seq: number): void {
  if (db.inTransaction) {
    const queue = pending.get(db);
    if (queue) { queue.push({ table, rowId, seq }); return; }
    pending.set(db, [{ table, rowId, seq }]);
    // トランザクションの本体は同期なので、マイクロタスクは最外が終わってから走る。
    queueMicrotask(() => drain(db));
    return;
  }
  drain(db);
  deliver(db, table, rowId);
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
    const info = db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id) values (?,?,?,?,?,?)')
      .run(table, String(full[pk]), 'upsert', JSON.stringify(stored), full.updated_at, deviceId);
    return Number(info.lastInsertRowid);
  });
  notify(db, table, String(full[pk]), write());
}

/** 共有テーブルの行を論理削除し、changes に delete を追記する。 */
export function softDeleteShared(db: Db, table: string, id: string, deviceId: string, pk = 'id'): void {
  const now = Date.now();
  const write = db.transaction(() => {
    db.prepare(`update ${table} set deleted_at = ?, updated_at = ?, origin_device = ? where ${pk} = ?`).run(now, now, deviceId, id);
    const stored = db.prepare(`select * from ${table} where ${pk} = ?`).get(id);
    dropUnpushed(db, table, id);
    const info = db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id) values (?,?,?,?,?,?)')
      .run(table, id, 'delete', JSON.stringify(stored), now, deviceId);
    return Number(info.lastInsertRowid);
  });
  notify(db, table, id, write());
}
