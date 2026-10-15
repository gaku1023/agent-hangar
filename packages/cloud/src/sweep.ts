import { isSafeKeyId } from '@agent-hangar/shared';
import type { Env } from './env.ts';

/**
 * R2 と D1 の食い違いを後から拾う掃除である。
 *
 * `PUT /files/<key>` は R2 に本体を置いてから D1 の索引を書く（順は入れ替えられない。
 * 先に索引を書くと、倒れたときに「索引にあるのに降ろせない」になり、降ろす側が永久に 404 を踏む）。
 * 途中で倒れると、索引に無い本体が R2 に残る。倒れた回数だけ R2 の使用量が増える。
 *
 * 掃除そのものが無料枠を食っては本末転倒なので、次の 3 つで抑えている。
 *
 * - 走るのは 6 時間に 1 回だけである（`meta.last_sweep_at` を見て、先に取った 1 本だけが走る）。
 * - 1 回に見るのは R2 の 50 件と索引の 50 行までで、続きは `meta` に控えた続きから読む。
 * - 置いてから 1 時間たっていないものには触らない。書いている最中の 1 本を消さないためである。
 *
 * 猶予と参照の判定は「読んだ時点の写し」なので、読んでから消すまでの間に同じ鍵の `PUT` が着地すると、
 * 生きているものを消しうる（レビューの要修正 2 と 3）。
 * 索引の方は `delete` に猶予の条件を持たせて、消す文そのものが新しい行を外す形にした（窓は無い）。
 * R2 の方は条件付きの削除が無いので、消す直前に索引と `head` を取り直して窓を 1 往復ぶんまで縮めてある。
 *
 * 1 回の掃除が D1 に書くのは、当番の印と続きの控え 2 行の計 3 行に、消した索引の行を足したものである。
 * 消す索引の行は途中で倒れた分だけで、1 回に 50 行までである。
 * 1 日 4 回でも、ふつうは 12 行ほど、多くても 212 行である（無料枠は 1 日 10 万行）。
 * R2 の側は 1 回につき一覧が 1 回（class A）と存在の確認が 50 回（class B）までで、
 * 1 か月に直しても class A が 1 万分の 1 ほどにしかならない。
 *
 * 同じ回で、利用者が削除したセッションのクラウドの写しも消す（`sweepTrash`）。
 * 削除の印（共有テーブル `session_states` の `trashed_at`）から 30 日たち、その後に復元されていないものが対象である。
 * 見積もりは `sweepTrash` の説明に書いた。
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

/** 削除の印からこれだけたったセッションの写しを消す。ゴミ箱から戻す猶予である。 */
export const TRASH_KEEP_MS = 30 * 86_400_000;
/**
 * 1 回に読む `session_states` の行の数。
 * 対象の行は鍵を引く 1 文にそれぞれ 1 つ束縛するので、D1 の束縛の上限（1 文 100 個）から、ほかの束縛 2 つを引いた数に収める。
 */
export const TRASH_SCAN_LIMIT = 90;
/** 1 回に消す写しの鍵の数。 */
export const TRASH_KEY_LIMIT = 50;
/** 削除の印の読み位置（`rows.k`）。末尾まで読んだら空に戻す。 */
export const META_TRASH_CURSOR = 'trash_cursor';

export type SweepResult = {
  /** 索引に無いので消した R2 の鍵。 */
  bodies: string[];
  /** 本体が無いので消した索引の鍵。 */
  entries: string[];
  /** 削除の印から 30 日たったので消した写しの鍵（R2 と索引の両方から消した）。 */
  trashed: string[];
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
  const claim = await db.batch([
    db
      .prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value where cast(meta.value as integer) <= ?')
      .bind(META_SWEEP_AT, String(now), now - SWEEP_EVERY_MS),
  ]);
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
  const trashed = await sweepTrash(env, now);
  await db.batch([
    putMeta(db, META_SWEEP_CURSOR, bodies.cursor),
    putMeta(db, META_SWEEP_SEQ, String(entries.seq)),
    putMeta(db, META_TRASH_CURSOR, trashed.cursor),
  ]);
  return { bodies: bodies.deleted, entries: entries.deleted, trashed: trashed.deleted };
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
  const doomed = await unreferenced(env, old);
  if (doomed.length === 0) return { deleted: [], cursor: next };
  // 消す直前にもう一度確かめる。
  // 一覧と索引の引き当てはどちらも読んだ時点の写しなので、その間に着地した `PUT` を見ていない。
  // R2 に条件付きの削除は無いので窓を 0 にはできないが、ここで取り直せば 1 往復ぶんまで縮む。
  // `PUT` は R2 を先に、索引を後に書くので、索引まで終わっていれば引き当てが拾い、
  // 索引の手前で止まっていれば `uploaded` の新しさが拾う。
  const still = await unreferenced(env, doomed);
  const heads = await Promise.all(still.map((k) => env.BUCKET.head(k)));
  const safe = still.filter((_, i) => {
    const h = heads[i];
    return !!h && h.uploaded.getTime() < cutoff;
  });
  if (safe.length) await env.BUCKET.delete(safe);
  return { deleted: safe, cursor: next };
}

/** 索引に無い鍵だけを残す。 */
async function unreferenced(env: Env, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const known = await env.DB.prepare(`select key from files where key in (${keys.map(() => '?').join(',')})`)
    .bind(...keys)
    .all<{ key: string }>();
  const indexed = new Set(known.results.map((r) => r.key));
  return keys.filter((k) => !indexed.has(k));
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
  if (doomed.length === 0) return { deleted: [], seq: next };
  // 消す文そのものに猶予を持たせる。
  // 読んでから消すまでの間に同じ鍵の `PUT` が着地しても、その行の `uploaded_at` は猶予の中なので当たらない。
  // 鍵だけで消すと、置き直したばかりの生きている行を消して、上げた端末だけが 201 を握ったまま取り残される。
  await db.batch([db.prepare(`delete from files where key in (${doomed.map(() => '?').join(',')}) and uploaded_at < ?`).bind(...doomed, cutoff)]);
  // 実際に消えた鍵を引き直して返す。
  // 消した数だけを見て先頭から切り出すと、**数は合うのに鍵が合わない**（残ったのが先頭かもしれない）。
  // 残った鍵は次の回でまた見るので、ここで取りこぼす心配は無い。
  return { deleted: await unreferenced(env, doomed), seq: next };
}

/** `rows` の中で `session_states` の行が並ぶ範囲（`k` は `<表>:<行 ID>`）。`;` は `:` の次の文字である。 */
const STATES_FROM = 'session_states:';
const STATES_TO = 'session_states;';

/** 削除の印を読む列。payload の JSON は D1 の側で引き、Worker では解かない。 */
const MARK_COLS = "k, row_id, op, json_extract(payload, '$.trashed_at') t, json_extract(payload, '$.restored_at') r, json_extract(payload, '$.deleted_at') d";

type MarkRow = { k: string; row_id: string; op: string; t: unknown; r: unknown; d: unknown };

/**
 * 印から 30 日たち、その後に復元されていない行か。
 * 論理削除された行と、印の外れた行は対象にしない。
 * 復元は印を null にするが、印の時刻より新しい `restored_at` を持つ行が後勝ちで並ぶこともあるので、それも外す（端末の sync/apply.ts と同じ読み方）。
 */
function isDue(m: MarkRow, now: number): boolean {
  if (m.op !== 'upsert' || m.d !== null) return false;
  if (typeof m.t !== 'number' || m.t > now - TRASH_KEEP_MS) return false;
  return !(typeof m.r === 'number' && m.r > m.t);
}

/**
 * 削除の印から 30 日たったセッションのクラウドの写しを消す。
 *
 * 消すのは R2 の `transcripts/<端末>/<uuid>.jsonl.gz` と `transcripts/<端末>/<uuid>/subagents/...` の全端末分と、その索引（`files`）の行である。
 * 印は `session_states` の行、uuid は同じセッションの `sessions` の行（論理削除のまま payload に `provider_session_id` を持つ）から読む。
 * 鍵は端末ごとに `files.key` の範囲で引くので、索引の一意の索引をたどり、`files` を頭から読まない。
 * 端末の一覧は `devices` から取る。解除した端末も行は残るので、その端末が置いた写しも消える。
 *
 * 量は 2 つの上限で抑える。
 *
 * - 印の行は 1 回に `TRASH_SCAN_LIMIT` 行まで読み、続きは `meta.trash_cursor` に控える。印は消さないので、一度消し終えたセッションも巡るたびに読むが、鍵が 0 件なので書き込みは増えない。
 * - 消す鍵は 1 回に `TRASH_KEY_LIMIT` 個まで。入り切らなかったセッションは、次の回にそのセッションから読み直す。
 *
 * 置いてから `SWEEP_GRACE_MS` たっていない写しには触らない。復元のあと上げ直した 1 本を消さないためである。
 * 消す直前に印を読み直し、その間に復元が届いていたら消さない。
 * R2 に条件付きの削除は無いので、読み直しから消すまでの 1 往復の窓は残る（孤児の掃除と同じ）。
 * R2 を先に消し、索引を後に消す。間で倒れたら、本体の無い索引が残り、次の回に `sweepEntries` が拾う。
 *
 * 1 回の掃除で増える操作は次のとおりである。
 * D1 の読みは、印の行が 90 行まで、端末の数と写しの鍵の数のぶんの索引の行、印の読み直し、消えたかの引き直しで、多くても 300 行ほどである。
 * D1 への書き込みは、続きの控え 1 行と、消した索引の行（50 行まで）である。
 * 1 日 4 回でも、読みは 1,200 行ほど（無料枠は 1 日 500 万行）、書き込みは 4 行に消した分を足した 204 行まで（1 日 10 万行）である。
 * R2 は削除だけで、削除は class A にも class B にも数えられない（無料）。
 * 問い合わせの数は 1 回に 6 つで、要求ごとの上限（無料のプランで 50）に孤児の掃除と合わせても収まる。
 */
async function sweepTrash(env: Env, now: number): Promise<{ deleted: string[]; cursor: string }> {
  const db = env.DB;
  const at = (await readMeta(db, META_TRASH_CURSOR)) ?? '';
  const from = at > STATES_FROM && at < STATES_TO ? at : STATES_FROM;
  const page = (
    await db.prepare(`select ${MARK_COLS} from rows where k > ? and k < ? order by k limit ?`).bind(from, STATES_TO, TRASH_SCAN_LIMIT).all<MarkRow>()
  ).results;
  // 末尾まで読んだら先頭へ戻す。読み切っていなければ、次の回はこの続きから読む。
  const next = page.length < TRASH_SCAN_LIMIT ? '' : page[page.length - 1]!.k;
  const due = page.filter((m) => isDue(m, now));
  if (due.length === 0) return { deleted: [], cursor: next };

  const cutoff = now - SWEEP_GRACE_MS;
  // 端末ごとに `transcripts/<端末>/<uuid>` を頭に作り、索引をその範囲で引く。
  // `<頭>.` から `<頭>0` の手前までには、`<頭>.〜` と `<頭>/〜` だけが入る（`.` `/` `0` は文字の順で隣り合う）。
  // その中から主線とサブエージェントの形だけを残すので、名前が同じ頭で始まるほかのセッションの鍵は入らない。
  const found = (
    await db
      .prepare(
        `select x.sid, x.uuid, f.key from (select s.row_id sid, json_extract(s.payload, '$.provider_session_id') uuid, 'transcripts/' || d.id || '/' || json_extract(s.payload, '$.provider_session_id') head from rows s join devices d where s.k in (${due.map(() => '?').join(',')})) x join files f on f.key > x.head || '.' and f.key < x.head || '0' where (f.key = x.head || '.jsonl.gz' or substr(f.key, 1, length(x.head) + 11) = x.head || '/subagents/') and f.uploaded_at < ? order by x.sid, f.key limit ?`,
      )
      .bind(...due.map((m) => `sessions:${m.row_id}`), cutoff, TRASH_KEY_LIMIT + 1)
      .all<{ sid: string; uuid: unknown; key: string }>()
  ).results.filter((r) => typeof r.uuid === 'string' && isSafeKeyId(r.uuid));
  // 上限を超えたら、入り切らなかったセッションの手前までを済んだことにし、次の回はそのセッションから読み直す。
  let cursor = next;
  if (found.length > TRASH_KEY_LIMIT) {
    const stop = `${STATES_FROM}${found[TRASH_KEY_LIMIT]!.sid}`;
    const before = page.filter((m) => m.k < stop);
    cursor = before.length ? before[before.length - 1]!.k : at;
  }
  const taken = found.slice(0, TRASH_KEY_LIMIT);
  if (taken.length === 0) return { deleted: [], cursor };

  // 消す直前に印を読み直す。読んでからここまでの間に復元が届いていたら、そのセッションは消さない。
  const sids = [...new Set(taken.map((r) => r.sid))];
  const again = (
    await db.prepare(`select ${MARK_COLS} from rows where k in (${sids.map(() => '?').join(',')})`).bind(...sids.map((s) => `${STATES_FROM}${s}`)).all<MarkRow>()
  ).results;
  const still = new Set(again.filter((m) => isDue(m, now)).map((m) => m.row_id));
  const keys = taken.filter((r) => still.has(r.sid)).map((r) => r.key);
  if (keys.length === 0) return { deleted: [], cursor };
  await env.BUCKET.delete(keys);
  await db.batch([db.prepare(`delete from files where key in (${keys.map(() => '?').join(',')}) and uploaded_at < ?`).bind(...keys, cutoff)]);
  return { deleted: await unreferenced(env, keys), cursor };
}
