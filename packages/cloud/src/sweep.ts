import type { Env } from './env.ts';
import { META_D1_ROWS_PREFIX, meteredBatch } from './meter.ts';

/**
 * R2 と D1 の食い違いを後から拾う掃除である。
 *
 * `PUT /files/<key>` は R2 に本体を置いてから D1 の索引を書く（順は入れ替えられない。
 * 先に索引を書くと、倒れたときに「索引にあるのに降ろせない」になり、降ろす側が永久に 404 を踏む）。
 * `DELETE` は逆に索引から消す。
 * どちらも途中で倒れると、索引に無い本体が R2 に残る。倒れた回数だけ R2 の使用量が増える。
 *
 * 掃除そのものが無料枠を食っては本末転倒なので、次の 3 つで抑えている。
 *
 * - 走るのは 6 時間に 1 回だけである（`meta.last_sweep_at` を見て、先に取った 1 本だけが走る）。
 * - 1 回に見るのは R2 の 50 件と索引の 50 行までで、続きは `meta` に控えた続きから読む。
 * - 置いてから 1 時間たっていないものには触らない。書いている最中の 1 本を消さないためである。
 *
 * 1 回の掃除が D1 に書くのは、続きの控えと日ごとの台帳で 10 行ほどである。
 * 1 日 4 回でも 50 行に届かない（無料枠は 1 日 10 万行）。
 * R2 の側は 1 回につき一覧が 1 回（class A）と存在の確認が 50 回（class B）までで、
 * 1 か月に直しても class A が 1 万分の 1 ほどにしかならない。
 */

/** 最後に掃除を始めた時刻。これを条件付きで書き換えられた 1 本だけが掃除に進む。 */
export const META_SWEEP_AT = 'last_sweep_at';
/** R2 の一覧の続き。1 巡したら空に戻す。 */
export const META_SWEEP_CURSOR = 'sweep_cursor';
/** 索引（`files`）の続き。末尾まで読んだら 0 に戻す。 */
export const META_SWEEP_SEQ = 'sweep_seq';

/** 掃除の間隔。1 日 4 回である。 */
export const SWEEP_EVERY_MS = 6 * 3_600_000;
/** 置いてからこれだけ経ったものだけを見る。書き込みの途中のものを消さないための猶予である。 */
export const SWEEP_GRACE_MS = 3_600_000;
/** 1 回に一覧する R2 の鍵の数。D1 の束縛の上限（1 文 100 個）に収まる数にしてある。 */
export const SWEEP_LIST_LIMIT = 50;
/** 1 回に確かめる索引の行数。 */
export const SWEEP_INDEX_LIMIT = 50;
/** 日ごとの台帳（`d1_rows:<yyyy-MM-dd>`）を残す日数。掃除のついでに古い行を刈る。 */
export const LEDGER_KEEP_DAYS = 7;

export type SweepResult = {
  /** 索引に無いので消した R2 の鍵。 */
  bodies: string[];
  /** 本体が無いので消した索引の鍵。 */
  entries: string[];
};

const readMeta = async (db: D1Database, key: string): Promise<string | null> => {
  const r = await db.prepare('select value from meta where key = ?').bind(key).first<{ value: string }>();
  return r ? r.value : null;
};

const putMeta = (db: D1Database, key: string, value: string): D1PreparedStatement =>
  db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').bind(key, value);

/**
 * この isolate が最後に当番を取りにいった時刻。
 * `GET /files` は端末が何度も叩く経路なので、毎回 D1 へ取りにいくと往復だけが増える。
 * 覚えておけば、ふつうの要求は D1 に触らずに帰れる。isolate が死んでも困らない（次が取りにいくだけである）。
 */
let triedAt = 0;

/** テスト専用。isolate をまたいだ覚えを落とす。 */
export function resetSweepThrottle(): void {
  triedAt = 0;
}

/**
 * 掃除の当番を 1 本だけ取る。
 *
 * 条件付きの 1 文で取るので、同時に来た要求どうしでも走るのは 1 本だけである
 * （`where` が通らなかった側は `changes` が 0 になる）。
 * 取れなければ null を返し、何もしない。
 */
export async function sweepIfDue(env: Env, now: number): Promise<SweepResult | null> {
  if (now - triedAt < SWEEP_EVERY_MS) return null;
  triedAt = now;
  const db = env.DB;
  const claim = await meteredBatch(
    db,
    [
      db
        .prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value where cast(meta.value as integer) <= ?')
        .bind(META_SWEEP_AT, String(now), now - SWEEP_EVERY_MS),
    ],
    now,
  );
  if (Number(claim[0]?.meta?.changes ?? 0) !== 1) return null;
  return sweepOnce(env, now);
}

/**
 * 1 回ぶん掃除する。当番の取り合いは見ないので、呼ぶのは `sweepIfDue` かテストからだけにすること。
 * 例外は呼び手へ投げる。掃除は落ちても次の回で続きから拾えるので、握り潰す必要は無い。
 */
export async function sweepOnce(env: Env, now: number): Promise<SweepResult> {
  const db = env.DB;
  const bodies = await sweepBodies(env, now);
  const entries = await sweepEntries(env, now);
  const stmts = [putMeta(db, META_SWEEP_CURSOR, bodies.cursor), putMeta(db, META_SWEEP_SEQ, String(entries.seq))];
  // 日ごとの台帳は放っておくと 1 年で 365 行になる。掃除のついでに古い分を落とす。
  const keepFrom = `${META_D1_ROWS_PREFIX}${new Date(now - LEDGER_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)}`;
  stmts.push(db.prepare('delete from meta where key like ? and key < ?').bind(`${META_D1_ROWS_PREFIX}%`, keepFrom));
  await meteredBatch(db, stmts, now);
  return { bodies: bodies.deleted, entries: entries.deleted };
}

/** R2 を一覧し、索引に無い本体を消す。 */
async function sweepBodies(env: Env, now: number): Promise<{ deleted: string[]; cursor: string }> {
  const cutoff = now - SWEEP_GRACE_MS;
  const cursor = (await readMeta(env.DB, META_SWEEP_CURSOR)) ?? '';
  const listed = await env.BUCKET.list({ limit: SWEEP_LIST_LIMIT, cursor: cursor === '' ? undefined : cursor });
  // 続きは、まだ先があるときだけ控える。末尾まで来たら空に戻して次の回は先頭から読み直す。
  const next = listed.truncated ? listed.cursor : '';
  const old = listed.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
  if (old.length === 0) return { deleted: [], cursor: next };
  const known = await env.DB.prepare(`select key from files where key in (${old.map(() => '?').join(',')})`)
    .bind(...old)
    .all<{ key: string }>();
  const indexed = new Set(known.results.map((r) => r.key));
  const doomed = old.filter((k) => !indexed.has(k));
  if (doomed.length) await env.BUCKET.delete(doomed);
  return { deleted: doomed, cursor: next };
}

/** 索引を順に読み、本体の無い行を消す。 */
async function sweepEntries(env: Env, now: number): Promise<{ deleted: string[]; seq: number }> {
  const db = env.DB;
  const cutoff = now - SWEEP_GRACE_MS;
  const at = Number((await readMeta(db, META_SWEEP_SEQ)) ?? 0);
  const from = Number.isSafeInteger(at) && at > 0 ? at : 0;
  const rows = await db
    .prepare('select seq, key, uploaded_at from files where seq > ? order by seq limit ?')
    .bind(from, SWEEP_INDEX_LIMIT)
    .all<{ seq: number; key: string; uploaded_at: number }>();
  // 末尾まで読んだら先頭へ戻す。読み切っていなければ、次の回はこの続きから読む。
  const next = rows.results.length < SWEEP_INDEX_LIMIT ? 0 : rows.results[rows.results.length - 1]!.seq;
  const old = rows.results.filter((r) => r.uploaded_at < cutoff);
  if (old.length === 0) return { deleted: [], seq: next };
  const found = await Promise.all(old.map((r) => env.BUCKET.head(r.key)));
  const doomed = old.filter((_, i) => found[i] === null).map((r) => r.key);
  if (doomed.length) {
    await meteredBatch(db, [db.prepare(`delete from files where key in (${doomed.map(() => '?').join(',')})`).bind(...doomed)], now);
  }
  return { deleted: doomed, seq: next };
}
