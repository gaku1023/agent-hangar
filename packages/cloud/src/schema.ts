import type { Env } from './env.ts';

/**
 * D1 の表である（互換の版 9、E2E の作り直し）。
 * 1 文を 1 行に書く（D1 の `exec` は改行で文を区切るので、複数行の文は使わない）。
 * 作り直しなので、版 8 までの D1 は読まず、列足しも移し替えもしない。
 * Worker が平文で持つのは、鍵、連番、時刻、端末の ID、鍵の世代だけである。
 * 行の中身、ファイルのパス、PC の名前は、PC が封じた BLOB（`sealed`、`sealed_meta`、`request`）の中にあり、Worker は開けない。
 * `meta` は、表を作ったときの印（`cloud_id`）や、掃除の読み位置を置く場所である。
 *
 * `rows` は共有テーブルの今の行で、1 つの鍵（`k`）に 1 行である。
 * `k` は PC が表名と行 ID から HMAC で求めた値なので、表名と行 ID は平文で残らない。
 * 連番（`seq`、autoincrement）を主キーにし、書き換えた行は表の末尾の連番を受け取り、`GET /changes?since=` はこの連番で差分を引く。
 * `devices` は IP と所在地を持たない。名前と OS は封じた名簿（`roster`）に置く。
 * `devices.last_pulled_seq` はいまは読まないが、列は残す。
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  'create table if not exists meta (key text primary key, value text not null)',
  'create table if not exists devices (id text primary key, kind text not null, token_hash text not null unique, joined_at integer not null, last_seen_at integer, last_pulled_seq integer not null default 0, revoked_at integer, expires_at integer)',
  'create table if not exists rows (seq integer primary key autoincrement, k text not null unique, op text not null, updated_at integer not null, device_id text not null, epoch integer not null, sealed blob not null)',
  'create table if not exists files (seq integer primary key autoincrement, key text not null unique, kind text not null, device_id text not null, size integer not null, stored_size integer not null, uploaded_at integer not null, epoch integer not null, sealed_meta blob not null)',
  'create index if not exists files_kind on files(kind, seq)',
  // 世代鍵を受け手ごとに封じた箱。受け手は PC の ID か recovery で、スマホの分は phone_keyboxes に分ける。
  'create table if not exists keyboxes (epoch integer not null, recipient text not null, created_at integer not null, sealed blob not null, primary key (epoch, recipient))',
  // 受け手ごとに引く索引（keys.ts の GET /keyboxes）。主キーは世代が先なので、これが無いと表を全部読む。
  'create index if not exists keyboxes_recipient on keyboxes(recipient, epoch)',
  'create table if not exists phone_keyboxes (epoch integer not null, recipient text not null, created_at integer not null, sealed blob not null, primary key (epoch, recipient))',
  // 名簿は 1 行だけで、version を条件にして書き換える。
  'create table if not exists roster (id integer primary key check (id = 1), version integer not null, updated_at integer not null, sealed blob not null)',
  // 参加コード。D1 にはコードのハッシュだけを置き、参加リクエスト（request）は封じたまま置く。
  // device_id はリクエストを置いた新しい PC の ID で、問い合わせと承認をこの ID に結び付ける。
  "create table if not exists join_codes (code_hash text primary key, created_by text not null, created_at integer not null, expires_at integer not null, used_at integer, status text not null default 'open', device_id text, request blob, request_at integer)",
  'create index if not exists join_codes_by on join_codes(created_by, created_at)',
  // スマホ向けの表。epoch はスマホ用の鍵の世代である。
  'create table if not exists mobile_feeds (device_id text primary key, sealed text not null, updated_at integer not null, epoch integer not null default 1)',
  'create table if not exists mobile_pairings (code_hash text primary key, created_by text not null, created_at integer not null, used_at integer, epoch integer not null default 1, request blob)',
  'create index if not exists mobile_pairings_by on mobile_pairings(created_by, created_at)',
  'create index if not exists mobile_pairings_at on mobile_pairings(created_at)',
  // スマホからの起動の依頼。中身（sealed、sealed_answer）は封をしたまま置き、Worker が平文で持つのは宛先と送り手と時刻と状態だけである。
  'create table if not exists launch_requests (id text primary key, target_device text not null, from_device text not null, sealed text not null, status text not null, created_at integer not null, claimed_at integer, answered_at integer, sealed_answer text, epoch integer not null default 1)',
  'create index if not exists launch_requests_target on launch_requests(target_device, status, created_at)',
  'create index if not exists launch_requests_from on launch_requests(from_device, created_at)',
  // 7 日より古い行を消す文（mobile.ts の POST /m/launches）が表を走査しないための索引。
  'create index if not exists launch_requests_at on launch_requests(created_at)',
];

/** 表を作ったときに 1 度だけ置く、このクラウドの印（meta の鍵）。PC は /health でこれを読み、作り直しを見分ける。 */
export const META_CLOUD_ID = 'cloud_id';

let ready: Promise<string> | null = null;

/** isolate ごとに 1 回だけスキーマを整え、このクラウドの印（cloud_id）を返す。 */
export function ensureSchema(env: Env): Promise<string> {
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

async function doEnsure(env: Env): Promise<string> {
  const db = env.DB;
  // 印は無いときだけ入れる。2 つの isolate が同時に入れても、先に入れた値が残り、同じ batch の読みは残った値を返す。
  const results = await db.batch([
    ...SCHEMA_STATEMENTS.map((s) => db.prepare(s)),
    db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do nothing').bind(META_CLOUD_ID, crypto.randomUUID()),
    db.prepare('select value from meta where key = ?').bind(META_CLOUD_ID),
  ]);
  const id = (results.at(-1)?.results?.[0] as { value?: string } | undefined)?.value;
  if (!id) throw new Error('cloud_id is missing');
  return id;
}
