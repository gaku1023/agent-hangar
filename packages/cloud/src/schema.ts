import type { Env } from './env.ts';

/**
 * D1 の表である。
 * 1 文を 1 行に書く（D1 の `exec` は改行で文を区切るので、複数行の文は使わない）。
 * `meta` は変更ログの圧縮が `changes_floor` と `last_compact_seq` を置く場所である。
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  'create table if not exists meta (key text primary key, value text not null)',
  'create table if not exists join_secrets (id text primary key, secret_hash text not null unique, created_at integer not null, revoked_at integer)',
  'create table if not exists devices (id text primary key, name text not null, platform text not null, token_hash text not null unique, joined_at integer not null, last_seen_at integer, last_pulled_seq integer not null default 0)',
  'create table if not exists rows (k text primary key, table_name text not null, row_id text not null, op text not null, payload text not null, updated_at integer not null, device_id text not null)',
  'create table if not exists changes (seq integer primary key autoincrement, table_name text not null, row_id text not null, op text not null, payload text not null, updated_at integer not null, device_id text not null, received_at integer not null)',
  'create index if not exists changes_device on changes(device_id, seq)',
  'create table if not exists files (seq integer primary key autoincrement, key text not null unique, path text not null, kind text not null, device_id text not null, sha256 text not null, size integer not null, stored_size integer not null, mtime integer not null, encrypted integer not null, uploaded_at integer not null)',
  'create index if not exists files_kind on files(kind, seq)',
];

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
  await env.DB.batch(SCHEMA_STATEMENTS.map((s) => env.DB.prepare(s)));
  const hash = env.JOIN_SECRET_HASH?.trim();
  if (!hash) return;
  const known = await env.DB.prepare('select revoked_at from join_secrets where secret_hash = ?').bind(hash).first<{ revoked_at: number | null }>();
  // 既に知っている秘密なら、有効でも回収済みでも何もしない。
  // 一度回収した秘密を復活させてはいけない。
  // `ensureSchema` は cold start のたびに走るので、復活を許すと D1 での回収が次の起動で必ず取り消される。
  // 古い秘密を持ったままの端末が hangar setup cloud をやり直すと、回収した秘密が戻り、新しい秘密が回収されてしまう。
  if (known) return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('update join_secrets set revoked_at = ? where revoked_at is null').bind(now),
    // 同時に来た要求どうしがぶつかっても、先に入れた行をそのままにする。
    env.DB
      .prepare('insert into join_secrets (id, secret_hash, created_at, revoked_at) values (?, ?, ?, null) on conflict(secret_hash) do nothing')
      .bind(crypto.randomUUID(), hash, now),
  ]);
}
