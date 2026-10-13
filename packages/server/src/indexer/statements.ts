import type { Statement } from 'better-sqlite3';
import type { Db } from '../db/open.ts';

const cache = new WeakMap<Db, Map<string, Statement>>();

/**
 * 同じ SQL の文を DB ごとに 1 度だけ準備して使い回す。
 * 索引は 1 回の走査でファイルの数だけ同じ問い合わせを引くので、そのたびに prepare すると SQL の解析だけで CPU を食う
 * （数千ファイルの置き場で、変化の無い 1 周にファイルの数の 2 倍の prepare が走っていた）。
 * 文は get、all、run でだけ使い、iterate で開いたままにしないので、使い回しても重ならない。
 */
export function stmt(db: Db, sql: string): Statement {
  let byDb = cache.get(db);
  if (!byDb) {
    byDb = new Map();
    cache.set(db, byDb);
  }
  let s = byDb.get(sql);
  if (!s) {
    s = db.prepare(sql);
    byDb.set(sql, s);
  }
  return s;
}
