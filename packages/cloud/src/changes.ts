import { Hono } from 'hono';
import {
  MAX_PUSH_BATCH,
  PULL_LIMIT,
  SHARED_TABLES,
  type ChangeIn,
  type ChangeOut,
  type PullChangesResponse,
  type PushChangesResponse,
  type SnapshotResponse,
} from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';

/** 前回の圧縮からこれだけ連番が進んだら、次の push の後で圧縮を試す。 */
export const COMPACT_EVERY = 200;
/** 受信からこれだけ経った変更だけを消す。 */
export const COMPACT_AGE_MS = 14 * 86_400_000;
/** これだけの間に来た端末を「生きている」とみなし、その全員が読み終えた分までしか消さない。 */
export const DEVICE_ACTIVE_MS = 30 * 86_400_000;

/** 圧縮で消し終えた連番の上端。`GET /changes?since=` がこれより古ければ、その端末は取りこぼしている。 */
export const META_CHANGES_FLOOR = 'changes_floor';
/** 最後に圧縮を試したときの最大連番。起動条件をここからの差で測る。 */
export const META_LAST_COMPACT_SEQ = 'last_compact_seq';

const TABLES = new Set<string>(SHARED_TABLES);
const keyOf = (c: { tableName: string; rowId: string }): string => `${c.tableName}:${c.rowId}`;

function isChange(v: unknown): v is ChangeIn {
  const c = v as Partial<ChangeIn> | null;
  return (
    !!c &&
    typeof c.tableName === 'string' &&
    TABLES.has(c.tableName) &&
    typeof c.rowId === 'string' &&
    c.rowId.length > 0 &&
    (c.op === 'upsert' || c.op === 'delete') &&
    typeof c.payload === 'object' &&
    c.payload !== null &&
    !Array.isArray(c.payload) &&
    typeof c.updatedAt === 'number' &&
    Number.isFinite(c.updatedAt)
  );
}

type ChangeRow = { seq: number; table_name: string; row_id: string; op: 'upsert' | 'delete'; payload: string; updated_at: number; device_id: string };

const toOut = (r: ChangeRow): ChangeOut => ({
  seq: r.seq,
  tableName: r.table_name as ChangeOut['tableName'],
  rowId: r.row_id,
  op: r.op,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  updatedAt: r.updated_at,
  deviceId: r.device_id,
});

const maxSeq = async (db: D1Database): Promise<number> => (await db.prepare('select ifnull(max(seq), 0) s from changes').first<{ s: number }>())!.s;

const clampLimit = (v: string | undefined): number => Math.min(Math.max(Number(v ?? PULL_LIMIT) || PULL_LIMIT, 1), PULL_LIMIT);

async function readMetaInt(db: D1Database, key: string): Promise<number> {
  const r = await db.prepare('select value from meta where key = ?').bind(key).first<{ value: string }>();
  const n = r ? Number(r.value) : 0;
  return Number.isFinite(n) ? n : 0;
}

const putMetaInt = (db: D1Database, key: string, value: number): D1PreparedStatement =>
  db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').bind(key, String(value));

/** 後戻りだけはさせない。floor が下がると、取りこぼしている端末を通してしまう。 */
const raiseMetaInt = (db: D1Database, key: string, value: number): D1PreparedStatement =>
  db
    .prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = max(cast(meta.value as integer), cast(excluded.value as integer))')
    .bind(key, String(value));

/**
 * 受信から 14 日を過ぎ、30 日以内に接続した全端末が読み終えた連番までの changes を消す。
 * rows は残すので、落ちた区間は `GET /rows` から取り直せる。
 *
 * 消した区間の上端を `meta.changes_floor` に書く。
 * これが無いと、離れていた端末が「その後の分だけ」を受け取って、間の変更を黙って永久に落とす。
 * 上端は「実際に消した最大の連番」である。消したものはすべてこれ以下なので、
 * `since >= floor` の端末が落とした変更は 1 件も無い。
 *
 * `last_compact_seq` は、消せなかったときも書く。
 * 書かないと、条件を満たさない間ずっと push のたびに端末の走査が走る。
 */
async function compact(db: D1Database, now: number, seq: number): Promise<void> {
  const active = await db
    .prepare('select min(last_pulled_seq) m from devices where last_seen_at is not null and last_seen_at > ?')
    .bind(now - DEVICE_ACTIVE_MS)
    .first<{ m: number | null }>();
  const upto = active?.m ?? 0;
  const cutoff = now - COMPACT_AGE_MS;
  const stmts: D1PreparedStatement[] = [putMetaInt(db, META_LAST_COMPACT_SEQ, seq)];
  if (upto > 0) {
    const doomed = await db
      .prepare('select ifnull(max(seq), 0) f from changes where seq <= ? and received_at < ?')
      .bind(upto, cutoff)
      .first<{ f: number }>();
    const floor = doomed?.f ?? 0;
    if (floor > 0) {
      stmts.push(db.prepare('delete from changes where seq <= ? and received_at < ?').bind(upto, cutoff));
      stmts.push(raiseMetaInt(db, META_CHANGES_FLOOR, floor));
    }
  }
  await db.batch(stmts);
}

export const changesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 端末から届いた変更を受ける。行ごとに `updated_at` の新しい方を採り、採った分だけ連番を振る。 */
changesApp.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { changes?: unknown } | null;
  if (!body || !Array.isArray(body.changes) || body.changes.length > MAX_PUSH_BATCH || !body.changes.every(isChange)) return c.json({ error: 'invalid body' }, 400);
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  // 同じ鍵の重複は updatedAt の大きい方だけを見る。
  const latest = new Map<string, ChangeIn>();
  let skipped = 0;
  for (const ch of body.changes as ChangeIn[]) {
    const k = keyOf(ch);
    const cur = latest.get(k);
    if (!cur) latest.set(k, ch);
    else {
      skipped++;
      if (ch.updatedAt > cur.updatedAt) latest.set(k, ch);
    }
  }
  const keys = [...latest.keys()];
  const current = new Map<string, number>();
  if (keys.length) {
    const rows = await db
      .prepare(`select k, updated_at from rows where k in (${keys.map(() => '?').join(',')})`)
      .bind(...keys)
      .all<{ k: string; updated_at: number }>();
    for (const r of rows.results) current.set(r.k, r.updated_at);
  }
  const stmts: D1PreparedStatement[] = [];
  let accepted = 0;
  for (const [k, ch] of latest) {
    const prev = current.get(k);
    if (prev !== undefined && prev >= ch.updatedAt) {
      skipped++;
      continue;
    }
    accepted++;
    const payload = JSON.stringify(ch.payload);
    stmts.push(
      db
        .prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id, received_at) values (?, ?, ?, ?, ?, ?, ?)')
        .bind(ch.tableName, ch.rowId, ch.op, payload, ch.updatedAt, device.id, now),
    );
    stmts.push(
      db
        .prepare(
          'insert into rows (k, table_name, row_id, op, payload, updated_at, device_id) values (?, ?, ?, ?, ?, ?, ?) on conflict(k) do update set op = excluded.op, payload = excluded.payload, updated_at = excluded.updated_at, device_id = excluded.device_id',
        )
        .bind(k, ch.tableName, ch.rowId, ch.op, payload, ch.updatedAt, device.id),
    );
  }
  stmts.push(db.prepare('update devices set last_seen_at = ? where id = ?').bind(now, device.id));
  await db.batch(stmts);
  const seq = await maxSeq(db);
  // 連番は 1 回の push で最大 40 飛ぶ。倍数に当たるかで測ると圧縮がほとんど走らないので、前回からの差で測る。
  if (accepted > 0 && seq - (await readMetaInt(db, META_LAST_COMPACT_SEQ)) >= COMPACT_EVERY) await compact(db, now, seq);
  const res: PushChangesResponse = { seq, accepted, skipped };
  return c.json(res);
});

/** 自端末以外の変更を連番の昇順で返す。圧縮で消えた区間を指されたら 410 で知らせる。 */
changesApp.get('/', async (c) => {
  const device = c.get('device');
  const db = c.env.DB;
  const since = Math.max(Number(c.req.query('since') ?? 0) || 0, 0);
  const limit = clampLimit(c.req.query('limit'));
  const floor = await readMetaInt(db, META_CHANGES_FLOOR);
  // 読み位置は進めない。進めると、この端末が落とした区間が二度と分からなくなる。
  if (since < floor) return c.json({ error: 'gone', floor }, 410);
  const rows = await db.prepare('select * from changes where seq > ? and device_id != ? order by seq limit ?').bind(since, device.id, limit + 1).all<ChangeRow>();
  const more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  // 最後まで返せたときは表全体の末尾まで進める。自端末の変更で止まったままにしないためである。
  const nextSeq = more ? page[page.length - 1]!.seq : Math.max(await maxSeq(db), since);
  await db.prepare('update devices set last_seen_at = ?, last_pulled_seq = max(last_pulled_seq, ?) where id = ?').bind(Date.now(), nextSeq, device.id).run();
  const res: PullChangesResponse = { changes: page.map(toOut), nextSeq, more };
  return c.json(res);
});

export const rowsApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** rows の写しを k 順に返す。新しい端末の初回 pull と、410 を受けた端末の取り直しが使う。自端末の行も含める。 */
rowsApp.get('/', async (c) => {
  const db = c.env.DB;
  const after = c.req.query('after') ?? '';
  const limit = clampLimit(c.req.query('limit'));
  const rows = await db
    .prepare('select 0 seq, table_name, row_id, op, payload, updated_at, device_id, k from rows where k > ? order by k limit ?')
    .bind(after, limit + 1)
    .all<ChangeRow & { k: string }>();
  const more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const res: SnapshotResponse = { changes: page.map(toOut), nextAfter: more ? page[page.length - 1]!.k : null, seq: await maxSeq(db) };
  return c.json(res);
});
