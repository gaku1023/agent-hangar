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
 * 旧実装は file_sync の行と R2 の config/<端末>/<相対パス>で動いていた（版 19 が、その記録を消す）。この 3 表は旧実装の記録とは別である。
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
 * 版 19。旧実装の設定の同期（段 4 の PR 18 で消した）が端末に残した記録を、1 回だけ消す。
 *
 * - file_sync の kind が config の行は、旧実装が取り込んだ相手の設定ファイルの台帳だった。
 * - sync_state の configPullConfirmed（取り込みの確認の印）と configPending（まだ取り込んでいない相手の設定の一覧）も旧実装のものである。
 * - sync_state の skipped:(config) は、旧実装の取り込みが 3 回続けて失敗したときの降ろしの諦めの控えである。
 *   残すと「諦めた本文」として画面に出続け、取り直しが設定の項目を本文として降ろそうとする。
 * 設定の同期の作り直しの表（config_*）と、本文の記録（kind が transcript の file_sync、ほかの skipped:）には触らない。
 */
const V19_DROP_LEGACY_CONFIG_SQL = `
delete from file_sync where kind = 'config';
delete from sync_state where key in ('configPullConfirmed', 'configPending', 'skipped:(config)');
`;

/**
 * 版 20。todos に Claude の提案の 2 列を足す。
 * suggested_at が null でなければ、MCP の update_project の add_todos で Claude が足した提案で、利用者はまだ受け入れていない。
 * suggested_note は提案の理由で、無ければ null。受け入れると両方を null に戻す。既存の行は null のままで、提案ではない。
 * 同期は行を JSON の payload のまま運ぶので、クラウドにマイグレーションは要らない（版 10 の完了の候補の列と同じ）。
 * 列を持たない古い端末は、適用のときに自分の表に無い列を捨てるので、提案は確定の TODO として見える。
 */
const V20_TODO_SUGGESTION_SQL = `
alter table todos add column suggested_at integer;
alter table todos add column suggested_note text;
`;

/**
 * 版 21。セッションのノート（session_notes.memo）を落とす（0.4.0）。名前（session_notes.name）は残す。
 *
 * ノートは使われておらず、要約（set_session_summary）と Paused の戻る日がその役を担うので、画面からも MCP からも外した。
 * 列を残さずに落とすのは、読み書きする口が無いのに列だけがあると、後から誰かが読んで、もう書かれない値を正と取り違えるからである。
 * - 中身は、当てる前に取る DB の控え（backups/db、db/backup.ts）に残る。ほかの表へは写さない。
 * - 行は消さない。名前が空でノートだけがあった行も、名前が null の行として残す。
 *   消すと、同じセッションの古い形の sessions の payload が降りたときに、手元に行が無いと見て作り直す（sync/apply.ts の adoptNoteFromOldSession）など、
 *   名前の同期の決着が変わる。名前が null の行は、画面にも MCP にも何も出さない。
 * - changes には積まない。表の形をこの PC で変えるだけで、他の PC の行には触らない。
 * - 古い版の PC と同期で混ざっても壊れない。
 *   古い版が送ってくる payload の memo は、適用（sync/apply.ts の applyRemoteChange）が手元の表に無い列として捨てる。
 *   この版が送る payload は行の全列なので memo の項目を持たず、古い版の適用は payload に無い列を上書きしないので、古い版の手元のノートは消えない。
 *   クラウド（Worker）は行を JSON の payload のまま運ぶので、マイグレーションは要らない。
 */
const V21_DROP_SESSION_MEMO_SQL = `
alter table session_notes drop column memo;
`;

/**
 * 版 22。中断の再開と、同じファイルの編集の警告に使う端末ローカルの表を足す（0.5.0）。どれも同期しない。
 *
 * - interrupted_runs は、中断の群（ホームの帯の「前回実行中」）の行である。
 *   起動の見回りで tmux のセッションが無かった run（cause が restart）と、hangar が動いている間に tmux のサーバごと消えた run（mux）を、1 つの束として持つ。
 *   at は束を記録した時刻、last_live は止まる前の最後の状態（busy、waiting、idle。分からなければ null）、dismissed_at は「再開しない」と決めた時刻である。
 *   新しい束を記録すると、前の束の行は消す（runs/interrupted.ts）。
 * - run_last_live は、生きた run ごとの最後の状態（Claude の登録の status）である。中断の群の並びと行の文に使う。
 * - session_overlaps は、同じファイルを別のセッションと編集していることの写しで、payload は SessionOverlapDto の JSON である。
 *   見張り（sessions/overlap.ts）が書き直し、セッションの行に左結合して配る。
 * - overlap_dismissals は「このファイルでは表示しない」の印である。2 つのセッションの id は小さい方を session_a に置く。
 */
const V22_RESUME_CONFLICT_SQL = `
create table interrupted_runs (
  run_id text primary key,
  session_id text not null,
  at integer not null,
  cause text not null check (cause in ('restart','mux')),
  last_live text,
  dismissed_at integer
);
create table run_last_live (
  run_id text primary key,
  status text not null,
  at integer not null
);
create table session_overlaps (
  session_id text primary key,
  payload text not null,
  updated_at integer not null
);
create table overlap_dismissals (
  session_a text not null,
  session_b text not null,
  path text not null,
  at integer not null,
  primary key (session_a, session_b, path)
);
`;

/**
 * 版 23。使用制限で止まっているセッション（session_limits）。端末ローカルで、同期しない。
 *
 * 索引が主線の本文の合成の行（error が rate_limit）から書き、次の指示か返答が載ったら消す（provider/claude-code/transcript/limit.ts）。
 * セッションが実行中から外れたときも消す（sessions/liveChange.ts）。再開した後に、前の run の使用制限を出さないためである。
 * - kind は枠（five_hour、weekly、other）、resets_at はリセットの時刻（ミリ秒）、hit_at は当たった時刻（ミリ秒）。
 * - auto は、Claude Code が自動の続きを予約したと本文に書いたこと（1 か 0）。
 * session_activity とは分ける。activity はツールの呼び出しが無いと行を持たないが、使用制限は呼び出しの前にも当たる。
 */
const V23_SESSION_LIMITS_SQL = `
create table session_limits (
  session_id text primary key,
  kind text not null,
  resets_at integer not null,
  auto integer not null default 0,
  hit_at integer not null
);
`;

/**
 * 版 24。projects に git の remote（git_remote）を足す（0.6.1）。
 *
 * 値は正規化した形（`github.com/owner/repo`。ssh と https を同じに読み、資格情報とトークンは入れない。git/remote.ts の normalizeRemote）。
 * ほかの PC から届いたプロジェクトと、この PC のフォルダを同じものと見分けるのに使う（projects/link.ts）。
 * 場所を持つ PC が、登録と結び付けと索引の起動のときに、空のものだけを埋める。git でないフォルダのプロジェクトは null のままである。
 * 同期は行を JSON の payload のまま運ぶので、クラウド（Worker）にマイグレーションは要らず、互換の版も変えない（版 20 の TODO の提案の列と同じ）。
 * 列を持たない古い PC は、適用のときに自分の表に無い列を捨てる。古い PC が送る payload はこの列を持たず、適用は payload に無い列を上書きしないので、埋めた値は消えない。
 */
const V24_PROJECT_REMOTE_SQL = `
alter table projects add column git_remote text;
`;

/**
 * 版 25。session_states に利用者が移した先（project_id）と削除の印（trashed_at）を足す（2026-10-16）。
 *
 * 所属と削除は利用者が決めることなので、本文から読み取れる事実を置く sessions ではなく、利用者の操作でしか書かれない session_states に置く。
 * 索引の書き直しや、古い所属を持った sessions の後勝ちで戻らないようにするためである。
 * - project_id は移した先。null なら cwd からの自動の振り分けに従う。sessions.project_id はこれに合わせ直す（sessions/move.ts）。
 *   外部キーは付けない。同期の最初の写しは session_states が projects より先に降りることがあり、一覧から削除した先を指す行も残りうるからである。読む側が生きているプロジェクトだけを採る。
 * - trashed_at は削除の印。null なら生きている。行の論理削除の deleted_at とは別物である。
 * 同期は行を JSON の payload のまま運ぶので、クラウド（Worker）にマイグレーションは要らず、互換の版も変えない（版 24 と同じ）。
 * 列を持たない古い PC は、適用のときに自分の表に無い列を捨てる。
 */
const V25_SESSION_PLACEMENT_SQL = `
alter table session_states add column project_id text;
alter table session_states add column trashed_at integer;
`;

/**
 * 版 26。セッションの削除（sessions/trash.ts）のための端末ローカルの表を 2 つ足す（2026-10-16）。
 * どちらも同期に載らない。共有の列（updated_at など）を持たない。
 * - trashed_transcripts は、この PC がゴミ箱へ移した本文（主線の jsonl とサブエージェントのフォルダ）の元のパスの控えである。
 *   同じパスに主線のファイルが戻ってきたら、削除の印を外して索引し直す（ゴミ箱から戻す復元）。
 * - trash_applied は、この PC が削除の印を処理し終えたセッションと、そのときの印の時刻である。
 *   印を受け取るたびに同じ処理をくり返さないためで、印が付け直されたら時刻が変わるので処理し直す。
 */
const V26_SESSION_TRASH_SQL = `
create table trashed_transcripts (
  path text primary key,
  session_id text not null,
  kind text not null check (kind in ('file','dir')),
  trashed_at integer not null
);
create index trashed_transcripts_session on trashed_transcripts(session_id);
create table trash_applied (
  session_id text primary key,
  trashed_at integer not null
);
`;

/**
 * 版 27。session_states に restored_at（明示の復元の時刻）を足す（2026-10-16）。
 * 削除の印（trashed_at）は、明示の復元でしか外れない。
 * 印を受け取る前のほかの PC が同じ行を書く（自動の Done、状態の変更）と、印の無い行が後勝ちで届く。
 * 取り込み（sync/apply.ts）は、届いた行の restored_at が手元の印より新しいときだけ印を外し、そうでなければ印を保って上げ直す。
 * 版 25 と同じく列を足すだけなので、クラウド（Worker）にマイグレーションは要らず、互換の版も変えない。
 */
const V27_SESSION_RESTORED_SQL = `
alter table session_states add column restored_at integer;
`;

/**
 * 版 28。ほかの PC で動いている会話を止めて引き継ぐための共有表を 2 つ足す（2026-10-16）。
 * - takeovers は、引き継ぐ側が書く「止めて」の頼みである。mode が ask なら相手の返事を待ち、force なら待たずに引き継ぐ印である。
 * - takeover_answers は、頼まれた側が書く応答である。止めたか（stopped）、すでに動いていなかったか（not_running）と、最後に上げた本文の sha256 と大きさを載せる。
 * 同期する表には check を付けない。後の版が値を足しても、古い PC の適用が落ちないようにするためである。
 * 外部キーも付けない。頼みは相手の行より先に届きうる一時の行だからである。
 * クラウド（Worker）のマイグレーションは要らない（行は JSON の payload のまま運ぶ）。表を知る版は、同期の版 6 に含めた（互換の版 6）。
 * run の状態（作業中、入力待ち、アイドル）は共有の行に載せない。同期の版 6 で heartbeat を共有しなくなり、載せる機会が無いためである。
 */
const V28_TAKEOVER_SQL = `
create table takeovers (
  id text primary key, session_id text not null, run_id text not null,
  target_device text not null, from_device text not null, requested_at integer not null,
  mode text not null, cancelled_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create index takeovers_target on takeovers(target_device, run_id);
create table takeover_answers (
  ask_id text primary key, run_id text not null, result text not null, answered_at integer not null,
  transcript_sha256 text, transcript_size integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
`;

/**
 * スマホからの起動の依頼のうち、この PC が扱い終えたもの（版 29）。同期しない（この PC だけの記録）。
 * 起こす前に Worker で claim し、起こしたら答えを送る前にここへ書く。答えを送れなくても、同じ依頼を二度起こさない。
 * result は started か、断った理由（bad-payload、expired、project-missing、account-missing、launch-failed）。
 */
const V29_MOBILE_LAUNCHES_SQL = `
create table mobile_launches (id text primary key, handled_at integer not null, result text not null);
`;

/**
 * --remote-control で起こした run の画面から拾った Remote Control の URL（mobile/remoteUrl.ts）。
 * 会話ごとに最新の 1 つを残す。at は拾った時刻で、受信箱は今の run の起動より後に拾ったものだけを使う。
 * その PC の claude につなぐ URL なので、同期しない。
 */
const V30_RUN_REMOTE_URLS_SQL = `
create table run_remote_urls (session_id text primary key, url text not null, at integer not null);
`;

/**
 * スマホからの起動の依頼に返した答えの控え（版 31）。
 * sealed_answer はスマホ用の鍵で封じた答え、ok はその ok、answered は Worker が答えを受け取った（または 409 で、もう受け取れない）か。
 * 答えを送れなかった行は、扱ってから 10 分のあいだ、同じ封のまま送り直す（mobile/launchInbox.ts）。
 * 版 29 の前からある行は封を持たないので、送り直さない。
 */
const V31_MOBILE_LAUNCH_ANSWERS_SQL = `
alter table mobile_launches add column sealed_answer text;
alter table mobile_launches add column ok integer;
alter table mobile_launches add column answered integer not null default 0;
`;

/**
 * この PC が上げた本文の世代の控え（版 32）。
 * R2 の鍵名は世代の `/index` の鍵の HMAC なので、世代を回した後に上げ直した本文は、世代ごとに別の鍵名で残る。
 * ゴミ箱の掃除（sync/trashSweep.ts）は、ここから上げた世代を引いて鍵名を求め直し、DELETE /blobs で消す。
 * ledger_key は台帳（file_sync）と同じ形の鍵（sync/ledgerKey.ts）で、DB の外には出さない。
 * 端末ローカルの表で、同期しない。
 */
const V32_BLOB_UPLOADS_SQL = `
create table blob_uploads (ledger_key text not null, epoch integer not null, primary key (ledger_key, epoch));
`;

/**
 * スマホの依頼で起こした会話の印（版 33、試作 F1）。
 * session_id は起こした会話の ID、permission_mode は依頼の権限モード（空は既定）。起こせなかった依頼はどちらも null。
 * 会話の一覧はこれを引いて SessionDto.fromPhone を載せる（ラベル「スマホから」）。
 * 共有の sessions に列を足すと同期の形が変わるので、起こした PC の手元の表に置く。他の PC ではラベルが付かない。
 */
const V33_MOBILE_LAUNCH_SESSION_SQL = `
alter table mobile_launches add column session_id text;
alter table mobile_launches add column permission_mode text;
create index mobile_launches_session on mobile_launches(session_id);
`;

/**
 * 同じ URL の Artifact を、2 台が別々の ID で記録したときの付け替え（版 34）。
 * artifacts.url は unique なので、同期で届いた方と手元の方のどちらかしか残せない。ID の小さい方を残す（sync/apply.ts の settleArtifactUrl）。
 * alias_id は残さなかった方の ID、artifact_id は残した方の ID である。その ID を指す版が後から届いたら、残した方へ付け替える。
 * 端末ローカルの表で、同期しない。どの PC も、両方の行を受け取った時点で同じ表を作る。
 */
const V34_ARTIFACT_ALIASES_SQL = `
create table artifact_aliases (alias_id text primary key, artifact_id text not null);
`;

/**
 * 本文を DB に持つエージェント（opencode）の本文（版 35）。
 * opencode の本文は serve の API（`/api/session/{id}/message`）から読み、正規化したイベント（TranscriptEvent）にして、ここに 1 行 1 イベントで写す（provider/opencode/transcript/）。
 * opencode の SQLite は読まない。
 * 位置（session_id、agent_key、seq）は event_index と同じ番号で、agent_key は主線なら空、サブエージェントなら agentId である。
 * 書くのは索引の書き手（indexer/write.ts）だけで、event_index と同じ取引で書く。読むのは transcript/stored.ts である。
 * event_index に本文の列を足さずに別の表にしたのは、Claude の行（本文はファイルにある）に空の列を増やさず、本文を持つ行だけをこの表で数え、消し、作り直せるようにするためである。
 * 端末ローカルの表で、同期しない（ほかの PC へは opencode の export を上げる。段 E）。
 */
const V35_AGENT_EVENTS_SQL = `
create table agent_events (
  session_id text not null,
  agent_key text not null,
  seq integer not null,
  body text not null,
  primary key (session_id, agent_key, seq)
) without rowid;
`;

/**
 * 最後の入力・返答の時刻（版 36）。終わった会話の見出しの「終了 N 分前」はこれで数える（ui の presentLeadCard）。
 * last_ts は本文の最後の記録の時刻で、返答の後に書かれる system の記録（離席中の要約など）でも進むので、別の列にする。
 * 主線の発言（user）と返答（assistant）の時刻の最大で、索引の書き手（indexer/write.ts）が書く。今ある行は event_index から埋める。
 * 端末ローカルの表で、同期しない。
 */
const V36_LAST_TURN_TS_SQL = `
alter table session_stats add column last_turn_ts integer;
update session_stats set last_turn_ts = (select max(e.ts) from event_index e
  where e.session_id = session_stats.session_id and e.parent_agent is null and e.kind in ('user', 'assistant'));
`;

/**
 * 本文の索引（transcript_files）に、どのエージェントの本文かを持たせる列（版 37）。
 * 索引が複数のファイル型のエージェントを受けるので、置き場から消えた本文の片付けや読み手の選び分けが、エージェントごとにできるようにする。
 * 今ある行はすべて Claude Code の本文である（ファイル型は Claude だけだった）。端末ローカルの表で、同期しない。
 */
const V37_TRANSCRIPT_FILES_AGENT_SQL = `
alter table transcript_files add column agent text not null default 'claude-code';
`;

/**
 * 版 38。config_unsent の kind に 'unknown-key'（知らない鍵）を足す。
 * 表は端末ローカルの「送らなかった項目」。check 制約を替えるので作り直し、中身（「それでも送る」の印を含む）は写す。
 */
const V38_CONFIG_UNSENT_UNKNOWN_KEY_SQL = `
create table config_unsent_new (
  id text primary key,
  kind text not null check (kind in ('permission-rule','secret','unknown-key')),
  item_id text not null,
  label text not null,
  reason text not null,
  content_sha256 text not null,
  allowed integer not null default 0,
  found_at integer not null
);
insert into config_unsent_new select id, kind, item_id, label, reason, content_sha256, allowed, found_at from config_unsent;
drop table config_unsent;
alter table config_unsent_new rename to config_unsent;
`;

/**
 * 版 39 は、エージェントが notify_user で知らせた未読の表を足す。
 * 手元だけの表で、同期しない。count は開くまでにたまった回数、latest_text と latest_at は最後の知らせである。
 * session_activity とは分ける。あちらは索引の作り直しで積み直すが、未読は利用者がまだ見ていないという事実なので、作り直しで消えてはならない。
 * セッションを消すとき（sessions/trash.ts）に、行も片付ける。
 */
/**
 * MCP の create_session で起こした会話の起動元（呼んだセッション）。手元だけの表で、同期しない。
 * 引き継ぎ（handoff）で起こした会話は残さない。画面は起動元の下に入れ子で並べる。
 */
/**
 * 同じ会話がほかの PC で別の ID を持つときの読み替え（版 42）。
 * alias_id は届いた ID、session_id は手元の ID、merged_at は読み替えを覚えた時刻である（sync/apply.ts の settleSessionId）。
 * 端末ローカルの表で、同期しない。
 */
const V42_SESSION_ALIASES_SQL = `
create table session_aliases (alias_id text primary key, session_id text not null, merged_at integer not null);
`;

// 未送信の行は少ないのに、数えるたびに changes を全部読んでいた。送るときの並び（seq）も同じ索引で引ける。
const V41_CHANGES_UNPUSHED_SQL = `
create index changes_unpushed on changes(seq) where pushed_at is null;
`;

const V40_SESSION_SPAWNS_SQL = `
create table session_spawns (
  session_id text primary key,
  parent_id text not null,
  created_at integer not null
);
`;

/**
 * MCP の delete_session の依頼を、利用者が答えるまで預かる表（#547）。手元だけの表で、同期しない。会話 1 つに 1 行。
 */
const V44_DELETE_APPROVALS_SQL = `
create table delete_approvals (
  id text primary key,
  session_id text not null unique,
  from_session_id text,
  requested_at integer not null,
  state text not null,
  decided_at integer,
  failure text
);
`;

const V39_SESSION_UNREAD_SQL = `
create table session_unread (
  session_id text primary key,
  count integer not null,
  latest_text text,
  latest_at integer not null
);
`;

/**
 * 版 43。session_states にピン留めの時刻（pinned_at）を足す（2026-11-02）。
 * ピンは利用者が決める会話の属性で、2 台の PC で同期するので、状態や移した先と同じ行に置く。null は留めていないこと。
 * 版 25 と同じく列を足すだけなので、クラウド（Worker）にマイグレーションは要らず、互換の版も変えない。
 */
const V43_SESSION_PINNED_SQL = `
alter table session_states add column pinned_at integer;
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
  { version: 19, sql: V19_DROP_LEGACY_CONFIG_SQL },
  { version: 20, sql: V20_TODO_SUGGESTION_SQL },
  { version: 21, sql: V21_DROP_SESSION_MEMO_SQL },
  { version: 22, sql: V22_RESUME_CONFLICT_SQL },
  { version: 23, sql: V23_SESSION_LIMITS_SQL },
  { version: 24, sql: V24_PROJECT_REMOTE_SQL },
  { version: 25, sql: V25_SESSION_PLACEMENT_SQL },
  { version: 26, sql: V26_SESSION_TRASH_SQL },
  { version: 27, sql: V27_SESSION_RESTORED_SQL },
  { version: 28, sql: V28_TAKEOVER_SQL },
  { version: 29, sql: V29_MOBILE_LAUNCHES_SQL },
  { version: 30, sql: V30_RUN_REMOTE_URLS_SQL },
  { version: 31, sql: V31_MOBILE_LAUNCH_ANSWERS_SQL },
  { version: 32, sql: V32_BLOB_UPLOADS_SQL },
  { version: 33, sql: V33_MOBILE_LAUNCH_SESSION_SQL },
  { version: 34, sql: V34_ARTIFACT_ALIASES_SQL },
  { version: 35, sql: V35_AGENT_EVENTS_SQL },
  { version: 36, sql: V36_LAST_TURN_TS_SQL },
  { version: 37, sql: V37_TRANSCRIPT_FILES_AGENT_SQL },
  { version: 38, sql: V38_CONFIG_UNSENT_UNKNOWN_KEY_SQL },
  { version: 39, sql: V39_SESSION_UNREAD_SQL },
  { version: 40, sql: V40_SESSION_SPAWNS_SQL },
  { version: 41, sql: V41_CHANGES_UNPUSHED_SQL },
  { version: 42, sql: V42_SESSION_ALIASES_SQL },
  { version: 43, sql: V43_SESSION_PINNED_SQL },
  { version: 44, sql: V44_DELETE_APPROVALS_SQL },
];
