export type Migration = { version: number; sql: string };

/**
 * 起点の版。
 * 版 1 から版 16 までのマイグレーションを、版 16 と同じスキーマを作る 1 本に畳んだ（2026-10-09）。
 * 新しい DB は起点を当てるとこの版になる。
 * これより古い版の DB は、上げる道を持たないので、openDb が開かずに断る（db/open.ts の DbTooOldError）。
 * 畳む前のマイグレーションは試験の側（packages/server/test/legacyMigrations.ts）に残してあり、
 * 起点が同じスキーマを作ることを db/baseline.test.ts が突き合わせる。
 */
export const BASELINE_VERSION = 16;

/**
 * 起点のスキーマ。行は 1 つも入れない。
 * 畳む前のマイグレーションのうち行を書き換えていたもの（版 6、版 13、版 16）は、空の DB では何もしないので、ここには無い。
 *
 * 注記は create 文の外に書く。文の中に書くと、sqlite_master が持つ SQL に注記まで残る。
 * 列の並びは、畳む前に `alter table add column` で足した順のまま（足した列が末尾）にしてある。
 * 版 1 から上がってきた DB と、起点から作った DB で、表の形を同じにするためである。
 */
const BASELINE_SQL = `
-- 共有テーブル。updated_at、deleted_at、origin_device を持ち、書き込みは changes に積まれて同期に載る。
-- shell_hook は、外のターミナルの claude を hangar で開く包み（hangar shell install）を、この端末に入れたか。on / off / unsupported。
create table devices (
  id text primary key, name text not null, platform text not null,
  last_seen_at integer, updated_at integer not null, deleted_at integer, origin_device text not null,
  shell_hook text
);
create table projects (
  id text primary key, name text not null,
  status text not null check (status in ('active','paused','done','archived')),
  is_scratch integer not null default 0,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table project_roots (
  id text primary key, project_id text not null references projects(id),
  device_id text not null, path text not null,
  resolved integer not null default 1,
  updated_at integer not null, deleted_at integer, origin_device text not null,
  unique (project_id, device_id)
);
create table sessions (
  id text primary key,
  provider text not null,
  provider_session_id text not null,
  project_id text references projects(id),
  name text,
  cwd text not null,
  first_prompt text, ai_title text,
  started_at integer, last_activity_at integer,
  home_device text not null,
  memo text,
  updated_at integer not null, deleted_at integer, origin_device text not null,
  unique (provider, provider_session_id)
);
create index sessions_project on sessions(project_id, last_activity_at);
create table runs (
  id text primary key, session_id text not null references sessions(id),
  device_id text not null,
  kind text not null check (kind in ('start','resume','fork')),
  tmux_name text not null, pid integer,
  launch_params text not null,
  started_at integer not null, ended_at integer, end_reason text,
  heartbeat_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
-- accountOfSession の全表走査をなくすための索引。
create index runs_session_started on runs (session_id, started_at);
create table run_tabs (
  id text primary key, run_id text not null references runs(id),
  tmux_name text not null, title text, created_at integer not null, closed_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
-- source_id は、どの要約器が書いた要約か。この列ができる前の行は null で、UI では不明と出す。
create table session_summaries (
  session_id text primary key references sessions(id),
  title text not null, one_liner text not null, body text not null,
  state text not null check (state in ('in_progress','done','blocked','abandoned')),
  next_steps text not null,
  source text not null check (source in ('baseline','in_session','post_hoc')),
  source_model text, based_on_turns integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null,
  source_id text
);
-- candidate_ で始まる列は完了の候補。セッションが「片付いた」と判断しても完了にはせず、利用者が確かめるまで候補として持つ。
-- rejected_sessions は、この TODO の候補を却下されたセッション ID の JSON 配列である。
create table todos (
  id text primary key, project_id text not null references projects(id),
  text text not null, done integer not null default 0, position integer not null,
  session_id text references sessions(id),
  updated_at integer not null, deleted_at integer, origin_device text not null,
  candidate_at integer,
  candidate_session_id text,
  candidate_note text,
  rejected_sessions text not null default '[]'
);
create index todos_project on todos(project_id, position);
create table project_memos (
  project_id text primary key references projects(id),
  markdown text not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table artifacts (
  id text primary key, project_id text references projects(id),
  url text not null unique, title text, description text, favicon text,
  first_published_at integer not null, last_published_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table artifact_versions (
  id text primary key, artifact_id text not null references artifacts(id),
  session_id text not null references sessions(id), file_path text, published_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create index artifact_versions_session on artifact_versions(session_id);
create index artifact_versions_artifact on artifact_versions(artifact_id);
create table takeover_requests (
  id text primary key, run_id text not null references runs(id),
  from_device text not null, requested_at integer not null,
  state text not null check (state in ('requested','acked','forced','cancelled')),
  updated_at integer not null, deleted_at integer, origin_device text not null
);
-- セッションの状態（Paused、Done、Archived）と Claude の提案。設計は docs/superpowers/specs/2026-10-01-session-status-design.md。
-- sessions の列にしないのは、sessions の行が索引のたびに全列で書き直され、同期が行ごとの後勝ちなので、
-- 別の PC で付けた状態が、本文を持つ PC の索引で上書きされるからである。
-- return_time と candidate_return_time は Paused の戻る時刻（HH:MM、手元の時刻）で、日付は return_on のまま持つ。
-- 同じ列に日時を入れると、上げていない PC が同期で受け取ったときに日付として読めなくなる。
create table session_states (
  session_id text primary key references sessions(id),
  status text check (status in ('paused','done','archived')),
  note text,
  return_on text,
  set_by text check (set_by in ('user','conversation','import')),
  set_at integer,
  candidate_status text check (candidate_status in ('paused','done')),
  candidate_note text,
  candidate_return_on text,
  candidate_source text check (candidate_source in ('in_session','exit','post_hoc')),
  candidate_at integer,
  rejected_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null,
  return_time text,
  candidate_return_time text
);
-- 同期へ送る差分の列。
create table changes (
  seq integer primary key autoincrement,
  table_name text not null, row_id text not null,
  op text not null check (op in ('upsert','delete')),
  payload text not null,
  updated_at integer not null, device_id text not null,
  pushed_at integer
);

-- ここから下は端末ローカルの表。共有テーブルの列を持たないので、同期の changes には載らない。
-- device_id は、その本文がどの端末のものかを持つ（他端末から降ろした本文と自分の本文を分けるため）。
-- この列ができる前の行は null である。端末の id は DB ではなく device.json にあり、マイグレーションからは読めない。
create table transcript_files (
  path text primary key, session_id text not null, agent_id text,
  size integer not null, mtime integer not null, indexed_bytes integer not null,
  indexer_version integer not null, last_error text,
  device_id text
);
create index transcript_files_session on transcript_files(session_id);
create index transcript_files_device on transcript_files(session_id, device_id);
create table event_index (
  id integer primary key,
  session_id text not null, seq integer not null,
  kind text not null,
  ts integer, byte_offset integer not null, byte_length integer not null,
  file_path_ref text not null,
  parent_agent text,
  tool_name text, file_path text
);
create unique index event_index_pos on event_index(session_id, ifnull(parent_agent, ''), seq);
create index event_index_tool on event_index(session_id, tool_name);
create virtual table event_fts using fts5 (
  session_id unindexed, agent_id unindexed, seq unindexed, role, text,
  tokenize = 'trigram'
);
create table session_stats (
  session_id text primary key,
  turns integer not null default 0,
  model text, effort text,
  files_changed integer not null default 0,
  pr_url text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  first_ts integer, last_ts integer,
  last_prompt text
);
-- account は、どのアカウントのセッションから届いたか。null は最初のアカウントとして読む。
create table usage_snapshots (
  at integer primary key, payload text not null,
  account text
);
create index usage_snapshots_account_at on usage_snapshots (account, at);
create table sync_state (key text primary key, value text not null);
create table settings_local (key text primary key, value text not null);
create table session_live_stats (
  provider_session_id text primary key,
  model text, effort text,
  context_used integer, context_size integer,
  cost_usd real,
  updated_at integer not null
);
create table artifact_calls (
  tool_id text primary key, session_id text not null,
  file_path text, description text, favicon text
);
-- 鍵に「どのファイル由来か」を持つ。主線を作り直すときに、そのファイルのぶんだけを消せるようにするため。
create table usage_daily (
  session_id text not null, day text not null, file_path text not null,
  input_tokens integer not null default 0, output_tokens integer not null default 0,
  primary key (session_id, file_path, day)
);
-- run ごとの MCP の秘密。本体のトークンとは別の鍵を claude に配るための置き場である。
-- サーバの再起動をまたいで生きる run があるので、メモリではなくここに置く。
create table mcp_secrets (
  session_id text primary key,
  secret text not null,
  created_at integer not null
);
-- R2 との同期の台帳。同じ内容を二度上げないための指紋と、上げたときの seq を持つ。
create table file_sync (
  key text primary key, kind text not null, path text not null, device_id text not null,
  sha256 text not null, size integer not null, mtime integer not null,
  remote_seq integer, synced_at integer not null
);
create index file_sync_path on file_sync(kind, path);
-- 実行中のセッションが最後に呼んだツールと、答えを待っている AskUserQuestion の問い。Home の札に出す。
-- 主線のトランスクリプトの追記を読むたびに書き直し、索引の作り直しでは先頭から積み直す。
create table session_activity (
  session_id text primary key,
  tool text not null,
  summary text not null,
  tool_id text not null,
  question text,
  updated_at integer not null
);
-- セッションが set_turn_intent で書いた「このターンで何のために何をするか」。右ペインの意図の段に出す。
-- そのターンのあいだしか意味を持たないので、同期しない。
create table turn_intents (
  session_id text not null,
  at integer not null,
  text text not null,
  primary key (session_id, at)
);
`;

/**
 * 版 17 が sessions から写した名前とメモ（session_notes の行）に付ける updated_at。写しの印である。
 *
 * どの PC でも同じ、固定の小さな値にする。本物の書き込みの時刻（Date.now()）より必ず古い。
 * - 上げた後の本物の書き込みは、どの PC がいつ上がっても、その PC の写しに必ず勝つ。
 *   元の sessions の行の時刻を使うと、まだ上げていない PC では索引がその時刻を進め続けるので、
 *   後から上がった PC の古い写しが、先に上がった PC で書き直した名前やメモに勝ちうる。
 * - 2 台の写しは必ず同じ時刻になる。中身が違うときの決着は sync/apply.ts の applyRemoteChange にある
 *   （先にクラウドへ上がった写しに、どの PC も揃える）。
 * - クラウドに残る古い形の sessions の payload から名前とメモを拾って作る行も、この時刻にする（同じく写しである）。
 * 0 は「時刻なし」と紛れるので使わない。
 */
export const MIGRATED_NOTE_AT = 1;

/**
 * 版 17。セッションの名前とメモを、sessions から別の表 session_notes へ移す。
 *
 * sessions の行は索引が本文の伸びるたびに全列で書き直し、同期はその行ごとの後勝ちで運ぶ。
 * 名前とメモが sessions の列にあると、別の PC で付けた名前やメモを、本文を持つ PC の索引が古い値で上書きする。
 * 状態（session_states）を分けたのと同じ理由である。
 *
 * - 写すのは、名前かメモのどちらかに中身がある行だけである。空の行は作らない。
 *   空の行を作ると、後から上がった PC の空の行が、先に上がった PC の名前やメモに勝ちうる。
 * - 写した行の updated_at は、どの PC でも同じ固定の定数（MIGRATED_NOTE_AT）にする。当てた時刻にも、元の sessions の行の時刻にもしない。
 *   どちらも、後から上がった PC の写し（古い中身）が、先に上がった PC で上げた後に付けた名前やメモに勝ちうる。
 *   origin_device は、元の sessions の行のものをそのまま使う。
 * - 写した行は、まだ送っていない差分として changes に積む。積まないと、クラウドには名前もメモも上がらない。
 *   端末の id はマイグレーションから読めないので、差分の device_id には元の行の origin_device を入れる（送るときには使わない）。
 * - sessions.custom_title は、索引が本文から拾う題名（Claude Code の側で付けた名前）である。
 *   これまでは同じ name の列に索引も書いていた。索引が書く事実として sessions の側に分ける。
 *   過去の name がどちらの由来かは見分けられないので、全部を session_notes へ写し、custom_title は空から始める。
 */
const V17_SESSION_NOTES_SQL = `
create table session_notes (
  session_id text primary key references sessions(id),
  name text,
  memo text,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
insert into session_notes (session_id, name, memo, updated_at, deleted_at, origin_device)
  select id,
    case when trim(name, ' ' || char(9) || char(10) || char(13)) = '' then null else name end,
    case when trim(memo, ' ' || char(9) || char(10) || char(13)) = '' then null else memo end,
    ${MIGRATED_NOTE_AT}, null, origin_device
  from sessions
  where ifnull(trim(name, ' ' || char(9) || char(10) || char(13)), '') <> ''
     or ifnull(trim(memo, ' ' || char(9) || char(10) || char(13)), '') <> '';
insert into changes (table_name, row_id, op, payload, updated_at, device_id)
  select 'session_notes', session_id, 'upsert',
    json_object('session_id', session_id, 'name', name, 'memo', memo, 'updated_at', updated_at, 'deleted_at', deleted_at, 'origin_device', origin_device),
    updated_at, origin_device
  from session_notes order by session_id;
alter table sessions add column custom_title text;
alter table sessions drop column name;
alter table sessions drop column memo;
`;

/**
 * 版 18。Claude Code の設定の同期の作り直し（docs/superpowers/specs/2026-10-09-config-sync-rebuild-design.md）の 3 表。
 * 旧実装（sync/claudeConfig.ts）は file_sync の行と R2 の config/<端末>/<相対パス>で動いており、この 3 表には触らない。
 *
 * - config_snapshots は共有テーブルで、PC ごとに 1 行（主キーは端末の ID）。その PC がいま送っている束の指紋と、目録（manifest）を持つ。
 *   目録の JSON が大きすぎる（クラウドの 1 行の上限 128 KiB に近い）ときは null にする。束の中にも同じ目録があり、受け手はそちらを読む。
 * - config_base は端末ローカルで、項目ごとに「最後に両方の PC で同じだった中身の指紋」を持つ。3 方向の判定の共通の祖先である。
 * - config_unsent は端末ローカルで、送らなかった項目（落とした絶対パスの権限の規則、秘密らしい文字列のあった項目）。
 *   allowed は「それでも送る」を押した印で、content_sha256 が変わったら無効になる（呼び手が見る）。
 */
const V18_CONFIG_SYNC_SQL = `
create table config_snapshots (
  device_id text primary key,
  bundle_sha256 text not null,
  bundle_size integer not null,
  item_count integer not null,
  manifest text,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table config_base (
  item_id text primary key,
  sha256 text not null,
  synced_at integer not null
);
create table config_unsent (
  id text primary key,
  kind text not null check (kind in ('permission-rule','secret')),
  item_id text not null,
  label text not null,
  reason text not null,
  content_sha256 text not null,
  allowed integer not null default 0,
  found_at integer not null
);
`;

/**
 * スキーマのマイグレーション一覧。version の昇順で一度だけ適用する。
 * 先頭は起点である。スキーマを変えるときは、起点を書き換えずに、次の版を末尾に足す。
 * 起点の SQL に残る sessions.name と sessions.memo は、版 17 が落とす。
 */
export const MIGRATIONS: Migration[] = [
  { version: BASELINE_VERSION, sql: BASELINE_SQL },
  { version: 17, sql: V17_SESSION_NOTES_SQL },
  { version: 18, sql: V18_CONFIG_SYNC_SQL },
];
