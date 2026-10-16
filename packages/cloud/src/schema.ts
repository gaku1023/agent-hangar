import { cleanupLegacyConfig, cleanupStage1 } from './cleanup.ts';
import type { Env } from './env.ts';

/** 版 6 の `rows` の列。新しい D1 の作成と、版 5 までの D1 の移行（`migrateRowsV6`）で同じ形を使う。 */
const ROWS_COLUMNS = 'seq integer primary key autoincrement, k text not null unique, table_name text not null, row_id text not null, op text not null, payload text not null, updated_at integer not null, device_id text not null';

/**
 * D1 の表である。
 * 1 文を 1 行に書く（D1 の `exec` は改行で文を区切るので、複数行の文は使わない）。
 * `meta` は、1 回だけ走る後始末と移行の印や、掃除の読み位置を置く場所である。
 *
 * `rows` は共有テーブルの今の行で、1 つの鍵（`表:行 ID`）に 1 行である（同期の版 6）。
 * `files` と同じく、連番（`seq`、autoincrement）を主キーにし、鍵を一意にする。
 * 行を書き換えるときは消してから入れ直すので、書き換えた行は表の末尾の連番を受け取り、`GET /changes?since=` はこの連番で差分を引く。
 * 版 5 までの変更ログ（`changes`）と、その圧縮は持たない。版 5 までの D1 は `migrateRowsV6` が 1 回だけ作り直す。
 * `devices.last_pulled_seq` は版 5 までの圧縮が使っていた列で、いまは読まない。参加の文（join.ts）が 0 を入れるので、列は残す。
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  'create table if not exists meta (key text primary key, value text not null)',
  'create table if not exists join_secrets (id text primary key, secret_hash text not null unique, created_at integer not null, revoked_at integer)',
  'create table if not exists devices (id text primary key, name text not null, platform text not null, token_hash text not null unique, joined_at integer not null, last_seen_at integer, last_pulled_seq integer not null default 0, revoked_at integer, last_ip text, last_city text, last_region text, last_country text)',
  `create table if not exists rows (${ROWS_COLUMNS})`,
  'create table if not exists files (seq integer primary key autoincrement, key text not null unique, path text not null, kind text not null, device_id text not null, sha256 text not null, size integer not null, stored_size integer not null, mtime integer not null, encrypted integer not null, uploaded_at integer not null)',
  'create index if not exists files_kind on files(kind, seq)',
  // スマホ向けの表（互換の版 7）。rows には足さないので、版 6 の PC は何も見ず、締め出されもしない（mobile.ts）。
  'create table if not exists mobile_feeds (device_id text primary key, sealed text not null, updated_at integer not null)',
  'create table if not exists mobile_pairings (code_hash text primary key, created_by text not null, created_at integer not null, used_at integer)',
  'create index if not exists mobile_pairings_by on mobile_pairings(created_by, created_at)',
];

/**
 * 後から devices に足した列（互換の版 5、0.4.0）。
 * `create table if not exists` は既にある表に列を足さないので、版 4 までの Worker が作った D1 には、起動のたびの用意で足す。
 * 足すのは無い列だけで、2 回目からは表の列を読むだけで帰る。
 */
export const DEVICE_ADDED_COLUMNS: readonly [name: string, type: string][] = [
  ['revoked_at', 'integer'],
  ['last_ip', 'text'],
  ['last_city', 'text'],
  ['last_region', 'text'],
  ['last_country', 'text'],
  // PC かスマホか（互換の版 7）。前からある行は PC である。
  ['kind', "text not null default 'pc'"],
];

/**
 * devices に無い列を足す。
 * 別の isolate が同時に足していれば `duplicate column name` で落ちるが、そのときは足せているので握る。
 */
async function addDeviceColumns(env: Env): Promise<void> {
  const have = new Set((await env.DB.prepare('pragma table_info(devices)').all<{ name: string }>()).results.map((c) => c.name));
  for (const [name, type] of DEVICE_ADDED_COLUMNS) {
    if (have.has(name)) continue;
    try {
      await env.DB.prepare(`alter table devices add column ${name} ${type}`).run();
    } catch (e) {
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
}

/** 版 5 までの `rows` を版 6 の形へ作り直した印（meta の鍵）。移行の batch の先頭で入れる。 */
export const META_ROWS_V6 = 'rows_v6';

const rowsHasSeq = async (db: D1Database): Promise<boolean> =>
  (await db.prepare('pragma table_info(rows)').all<{ name: string }>()).results.some((c) => c.name === 'seq');

/**
 * 版 5 までの `rows`（鍵が主キーで連番を持たない）を、版 6 の形へ作り直す文の束である。1 つの batch（1 つの取引）で流す。
 *
 * 先頭の文は、印の行を `on conflict` 無しで入れる。
 * 2 つの isolate が同時に移行を始めると、後の方はこの一意制約で束ごと落ち、何も変えない。
 * 印が無いと、後の方が移行済みの表をもう一度作り直し、連番を振り直してしまう。
 *
 * 連番は旧い高水位 H より上から、`updated_at` と鍵の順に振る。
 * H は `meta.seq_high`（版 5 の圧縮が刻んだ高水位）と `changes` の最大の連番の大きい方である。
 * 端末の読み位置（since）はどれも H 以下なので、移行の後に 1 回だけ全部の行を取り直し、取りこぼさない。
 * `rows` が空でも、次に書く行が H より上の連番を受け取るように、H の番兵の行を入れてから消す（autoincrement は消した行の連番も覚えている）。
 * `rename` のときに `sqlite_sequence` が新しい名前へ追従することは、miniflare で確かめた（2026-10-16）。
 */
export async function rowsV6Statements(db: D1Database, now: number): Promise<D1PreparedStatement[]> {
  const hasChanges = !!(await db.prepare("select 1 x from sqlite_master where type = 'table' and name = 'changes'").first<{ x: number }>());
  const fromChanges = hasChanges ? '(select ifnull(max(seq), 0) from changes)' : '0';
  const high = `max(${fromChanges}, ifnull((select cast(value as integer) from meta where key = 'seq_high'), 0))`;
  return [
    db.prepare('insert into meta (key, value) values (?, ?)').bind(META_ROWS_V6, String(now)),
    db.prepare(`create table rows_v6 (${ROWS_COLUMNS})`),
    db.prepare(`insert into rows_v6 (seq, k, table_name, row_id, op, payload, updated_at, device_id) select ${high}, '', '', '', 'delete', '{}', 0, '' where ${high} > 0`),
    db.prepare(
      `insert into rows_v6 (seq, k, table_name, row_id, op, payload, updated_at, device_id) select h.v + row_number() over (order by r.updated_at, r.k), r.k, r.table_name, r.row_id, r.op, r.payload, r.updated_at, r.device_id from rows r, (select ${high} v) h`,
    ),
    db.prepare("delete from rows_v6 where k = ''"),
    db.prepare('drop table rows'),
    db.prepare('alter table rows_v6 rename to rows'),
    db.prepare('drop table if exists changes'),
  ];
}

/**
 * 版 5 までの D1 なら、`rows` を版 6 の形へ作り直す。既に版 6 の形なら何もしない。
 * 別の isolate と競って束ごと落ちたら、もう一度形を確かめ、作り直されていれば済んだものとする。
 */
export async function migrateRowsV6(db: D1Database, now: number): Promise<'none' | 'migrated' | 'raced'> {
  if (await rowsHasSeq(db)) return 'none';
  try {
    await db.batch(await rowsV6Statements(db, now));
    return 'migrated';
  } catch (e) {
    if (await rowsHasSeq(db)) return 'raced';
    throw e;
  }
}

let ready: Promise<void> | null = null;

/** isolate ごとに 1 回だけスキーマを整え、Worker の secret にある参加用の秘密のハッシュを D1 に写す。 */
export function ensureSchema(env: Env): Promise<void> {
  if (!ready)
    ready = doEnsure(env).catch((e) => {
      ready = null;
      throw e;
    });
  return ready;
}

export function resetSchemaCache(): void {
  ready = null;
}

async function doEnsure(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch(SCHEMA_STATEMENTS.map((s) => env.DB.prepare(s)));
  await addDeviceColumns(env);
  // 版 5 までの rows を 1 回だけ作り直す。新しい D1 では上の文が最初から版 6 の形で作るので、形を読むだけで帰る。
  await migrateRowsV6(env.DB, now);
  // 段 1 で消したものが残した行を 1 回だけ片付ける。落ちても例外を投げず、次の cold start でまた試す（cleanup.ts）。
  await cleanupStage1(env, now);
  // 旧実装の設定の同期の本体と索引を 1 回だけ消す。段 4 の PR 18 が関門を開けた（cleanup.ts）。
  await cleanupLegacyConfig(env, now);
  const hash = env.JOIN_SECRET_HASH?.trim();
  if (!hash) return;
  const known = await env.DB.prepare('select revoked_at from join_secrets where secret_hash = ?').bind(hash).first<{ revoked_at: number | null }>();
  // 既に知っている秘密なら、有効でも回収済みでも何もしない。
  // 一度回収した秘密を復活させてはいけない。
  // `ensureSchema` は cold start のたびに走るので、復活を許すと D1 での回収が次の起動で必ず取り消される。
  // 古い秘密を持ったままの端末が hangar setup cloud をやり直すと、回収した秘密が戻り、新しい秘密が回収されてしまう。
  if (known) return;
  await env.DB.batch([
    env.DB.prepare('update join_secrets set revoked_at = ? where revoked_at is null').bind(now),
    // 同時に来た要求どうしがぶつかっても、先に入れた行をそのままにする。
    env.DB
      .prepare('insert into join_secrets (id, secret_hash, created_at, revoked_at) values (?, ?, ?, null) on conflict(secret_hash) do nothing')
      .bind(crypto.randomUUID(), hash, now),
  ]);
}
