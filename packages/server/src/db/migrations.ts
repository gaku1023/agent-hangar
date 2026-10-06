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
    // 既存の行をどう扱うかは version 6 で改めている。
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
  {
    // version 4 より前の日別の行は「どのファイル由来か」を持たない。
    // どのファイルに寄せても、作り直しの消し方が正しくならない。
    // 主線に寄せれば、そのセッションを作り直したときにサブエージェントぶんまで消える。
    // どのファイルでもない印にすれば、作り直しの delete に当たらず同じ日を二重に数える。
    // なので寄せるのをやめて空にし、索引済みの印を 0 に戻して全ファイルを作り直しに回す。
    // 日別は次の全走査で積み直され、そこから先はファイル別に正しく消せる。
    // 代償は、積み直しが終わるまで日別が欠けることと、全走査が一度だけ重くなることである。
    version: 6,
    sql: `
delete from usage_daily;
update transcript_files set indexer_version = 0;
`,
  },
  {
    // run ごとの MCP の秘密。本体のトークンとは別の鍵を claude に配るための置き場である。
    // 端末ローカルの表にする（共有テーブルの列を持たないので、同期の changes にも載らない）。
    // サーバの再起動をまたいで生きる run があるので、メモリではなくここに置く。
    version: 7,
    sql: `
create table mcp_secrets (
  session_id text primary key,
  secret text not null,
  created_at integer not null
);
`,
  },
  {
    // クラウド同期のための列と表。
    // transcript_files.device_id は、その本文がどの端末のものかを持つ（他端末から降ろした本文と自分の本文を分けるため）。
    // 既存の行は自分の端末のものだが、ここで焼き付けずに null のままにする。
    // 端末の id は DB ではなく device.json にあり、マイグレーションからは読めないからである。
    // file_sync は R2 との同期の台帳で、同じ内容を二度上げないための指紋と、上げたときの seq を持つ。
    version: 8,
    sql: `
alter table transcript_files add column device_id text;
create index transcript_files_device on transcript_files(session_id, device_id);
create table file_sync (
  key text primary key, kind text not null, path text not null, device_id text not null,
  sha256 text not null, size integer not null, mtime integer not null,
  remote_seq integer, synced_at integer not null
);
create index file_sync_path on file_sync(kind, path);
`,
  },
  {
    // 実行中のセッションが最後に呼んだツールと、答えを待っている AskUserQuestion の問い。Home の札に出す。
    // 端末ローカルの表にする（共有テーブルの列を持たないので、同期の changes にも載らない）。
    // 主線のトランスクリプトの追記を読むたびに書き直し、索引の作り直しでは先頭から積み直す。
    // 既存の索引は作り直さないので、上げた直後は次の追記が来るまで空である。
    version: 9,
    sql: `
create table session_activity (
  session_id text primary key,
  tool text not null,
  summary text not null,
  tool_id text not null,
  question text,
  updated_at integer not null
);
`,
  },
  {
    // TODO の完了の候補。セッションが「片付いた」と判断しても完了にはせず、利用者が確かめるまで候補として持つ。
    // 共有テーブルの列なので同期の payload に載る。D1 は行を JSON のまま持つので、クラウド側のマイグレーションは要らない。
    // 列を持たない古い端末は、適用のときに自分の表に無い列を捨てる（sync/apply.ts の tableColumns）。
    // rejected_sessions は、この TODO の候補を却下されたセッション ID の JSON 配列である。
    version: 10,
    sql: `
alter table todos add column candidate_at integer;
alter table todos add column candidate_session_id text;
alter table todos add column candidate_note text;
alter table todos add column rejected_sessions text not null default '[]';
`,
  },
  {
    // 外のターミナルで起動した claude を hangar で開けるようにする包み方（hangar shell install）を、この端末に入れたか。
    // on / off / unsupported。端末の行に載せて同期し、Settings でどの PC に入っているかを並べる。
    // 列を持たない古い端末は、適用のときに自分の表に無い列を捨てる（sync/apply.ts の tableColumns）。
    version: 11,
    sql: `
alter table devices add column shell_hook text;
`,
  },
  {
    // セッションが set_turn_intent で書いた「このターンで何のために何をするか」。右ペインの意図の段に出す。
    // そのターンのあいだしか意味を持たないので端末ローカルの表にし、同期しない（D1 の書き込みの枠を使わない）。
    version: 12,
    sql: `
create table turn_intents (
  session_id text not null,
  at integer not null,
  text text not null,
  primary key (session_id, at)
);
`,
  },
  {
    // セッションの状態（Paused・Done・Archived）と Claude の提案。設計は docs/superpowers/specs/2026-10-01-session-status-design.md。
    // sessions に列を足さないのは、sessions の行が索引のたびに全列で書き直され（indexFile の applySessionFacts）、
    // 同期が行ごとの後勝ちなので、別の PC で付けた状態が、本文を持つ PC の索引で上書きされるからである。
    // 共有テーブルなので同期に載る。D1 は行を JSON のまま持つので、クラウド側のマイグレーションは要らない。
    //
    // 導入のときに、生きているセッションをまとめて Done にする（利用者の決定）。
    // この行は changes に積まない。各 PC が自分のマイグレーションで同じ行を作るので、送る必要が無い。
    // 1,221 行を D1 へ送ると、無料枠の書き込みを無駄に使う。
    // updated_at は 0 にする。先に上げた PC で利用者が付けた状態が、後から上げた PC の一括 Done に後勝ちで負けないようにするためである。
    // origin_device は、端末の id を DB から読めないので（version 8 の注記と同じ）'import' と書く。
    // set_at は秒の精度の今で、これより前の発言では状態を外さない（sessions/states.ts の clearOnNewPrompt）。
    version: 13,
    sql: `
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
  updated_at integer not null, deleted_at integer, origin_device text not null
);
insert into session_states (session_id, status, set_by, set_at, updated_at, origin_device)
  select id, 'done', 'import', cast(strftime('%s', 'now') as integer) * 1000, 0, 'import' from sessions where deleted_at is null;
`,
  },
  {
    // Paused の戻る時刻（HH:MM、手元の時刻）。日付は return_on のまま持ち、時刻は別の列にする。
    // 同じ列に日時を入れると、上げていない PC が同期で受け取ったときに日付として読めなくなる。別の列なら、知らない列として捨てるだけで済む。
    // 既存の行は null のままで、「その日のうち」として今までどおり読む。
    version: 14,
    sql: `
alter table session_states add column return_time text;
alter table session_states add column candidate_return_time text;
`,
  },
  {
    // 使用量のスナップショットに、どのアカウントのセッションから届いたかを持つ。
    // この表は同期しない（手元だけ）ので、列を足してもほかの PC には影響しない。
    // 既存の行は null のままで、最初のアカウントとして読む。
    // runs の索引は手元の DB の作りで、同期の対象ではない。accountOfSession の全表走査をなくす。
    version: 15,
    sql: `
alter table usage_snapshots add column account text;
create index usage_snapshots_account_at on usage_snapshots (account, at);
create index if not exists runs_session_started on runs (session_id, started_at);
`,
  },
];
