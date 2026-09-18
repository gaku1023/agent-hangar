/** スキーマのマイグレーション一覧。version の昇順で一度だけ適用する。 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
create table devices (
  id text primary key, name text not null, platform text not null,
  last_seen_at integer, updated_at integer not null, deleted_at integer, origin_device text not null
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
create table run_tabs (
  id text primary key, run_id text not null references runs(id),
  tmux_name text not null, title text, created_at integer not null, closed_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table session_summaries (
  session_id text primary key references sessions(id),
  title text not null, one_liner text not null, body text not null,
  state text not null check (state in ('in_progress','done','blocked','abandoned')),
  next_steps text not null,
  source text not null check (source in ('baseline','in_session','post_hoc')),
  source_model text, based_on_turns integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table todos (
  id text primary key, project_id text not null references projects(id),
  text text not null, done integer not null default 0, position integer not null,
  session_id text references sessions(id),
  updated_at integer not null, deleted_at integer, origin_device text not null
);
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
create table takeover_requests (
  id text primary key, run_id text not null references runs(id),
  from_device text not null, requested_at integer not null,
  state text not null check (state in ('requested','acked','forced','cancelled')),
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table changes (
  seq integer primary key autoincrement,
  table_name text not null, row_id text not null,
  op text not null check (op in ('upsert','delete')),
  payload text not null,
  updated_at integer not null, device_id text not null,
  pushed_at integer
);
`,
  },
  {
    version: 2,
    sql: `
create table transcript_files (
  path text primary key, session_id text not null, agent_id text,
  size integer not null, mtime integer not null, indexed_bytes integer not null,
  indexer_version integer not null, last_error text
);
create index transcript_files_session on transcript_files(session_id);
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
create table usage_snapshots (
  at integer primary key, payload text not null
);
create table sync_state (key text primary key, value text not null);
create table settings_local (key text primary key, value text not null);
`,
  },
  {
    version: 3,
    sql: `
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
create table usage_daily (
  session_id text not null, day text not null,
  input_tokens integer not null default 0, output_tokens integer not null default 0,
  primary key (session_id, day)
);
create index artifact_versions_session on artifact_versions(session_id);
create index todos_project on todos(project_id, position);
`,
  },
  {
    // usage_daily の鍵に「どのファイル由来か」を足す。
    // 主線を作り直すときに、そのファイルのぶんだけを消せるようにするため。
    // 既存の行はセッション単位の和なので、そのセッションの主線のファイルに寄せて移す。
    // 主線のファイルが transcript_files に無い行は移し先が無いので空文字のままにする。
    // この行は索引の作り直しでは消えず、そのセッションが積み直されるときに主線のファイルの行と並ぶ。
    version: 4,
    sql: `
alter table usage_daily rename to usage_daily_v3;
create table usage_daily (
  session_id text not null, day text not null, file_path text not null,
  input_tokens integer not null default 0, output_tokens integer not null default 0,
  primary key (session_id, file_path, day)
);
insert into usage_daily (session_id, day, file_path, input_tokens, output_tokens)
  select u.session_id, u.day,
    ifnull((select t.path from transcript_files t where t.session_id = u.session_id and t.agent_id is null order by t.path limit 1), ''),
    u.input_tokens, u.output_tokens
  from usage_daily_v3 u;
drop table usage_daily_v3;
create index artifact_versions_artifact on artifact_versions(artifact_id);
`,
  },
  {
    // どの要約器が書いた要約かを持つ列を足す。
    // これまでは source_model（モデルの名前）しか無く、UI が名前から種類を当てていた。
    // 既存の行の値はモデルの名前なので、どの要約器が書いたかは分からない。
    // 推測して焼き付けると、後から嘘だったことを確かめられなくなるので、null のままにして UI では不明と出す。
    version: 5,
    sql: `
alter table session_summaries add column source_id text;
`,
  },
];
