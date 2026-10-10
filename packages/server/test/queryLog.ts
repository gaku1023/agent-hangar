import type { Db } from '../src/db/open.ts';

/** 実行した問い合わせの SQL を、実行のたびに 1 件ずつ積む。 */
export type QueryLog = { db: Db; ran: string[] };

const RUNS = new Set(['get', 'all', 'run', 'iterate']);

/**
 * db を包み、prepare した文を実行するたびに SQL を ran へ積む。
 * 中身は元の db のまま動く。重さの試験で「何回引いたか」「どの計画で引いたか」を見るために使う。
 */
export function logQueries(db: Db): QueryLog {
  const ran: string[] = [];
  const wrapStatement = (st: object, sql: string) => new Proxy(st, {
    get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (typeof v !== 'function') return v;
      if (RUNS.has(String(p))) return (...a: unknown[]) => { ran.push(sql); return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return (v as (...x: unknown[]) => unknown).bind(t);
    },
  });
  const proxied = new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') return (sql: string) => wrapStatement(t.prepare(sql), sql);
      const v = Reflect.get(t, p) as unknown;
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { db: proxied, ran };
}

/**
 * event_index を session_id だけで引く計画（主線とサブエージェントを索引で分けられない）と、素通しに走査する計画の行を返す。
 * どちらも、長いセッションでは 1 回でそのセッションの全行を表まで見に行く。
 * 主線を `parent_agent is null` で絞ると、索引の式（ifnull(parent_agent, '')）に合わずこの形になる。
 */
export function unnarrowedScans(db: Db, sqls: string[]): string[] {
  const out: string[] = [];
  for (const sql of new Set(sqls)) {
    const params = (sql.match(/\?/g) ?? []).map(() => null);
    const plan = db.prepare(`explain query plan ${sql}`).all(...params) as { detail: string }[];
    for (const { detail } of plan) {
      if (/SCAN event_index\b/.test(detail) || /event_index USING (COVERING )?INDEX \w+ \(session_id=\?\)$/.test(detail)) out.push(`${detail} ← ${sql}`);
    }
  }
  return out;
}
