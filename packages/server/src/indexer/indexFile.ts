import fs from 'node:fs';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { upsertShared } from '../db/shared.ts';
import { readNewLines } from '../provider/claude-code/transcript/lines.ts';
import { artifactCallOf, isArtifactPublish, parsePublishedUrl, recordArtifactPublish } from '../artifacts/extract.ts';
import { indexTexts, isTypedPrompt, normalizeRecord, recordFacts } from '../provider/claude-code/transcript/normalize.ts';
import { pinnedProjectOf } from '../sessions/move.ts';
import { clearOnNewPrompt } from '../sessions/states.ts';
import { foldActivity, type Activity } from '../provider/claude-code/transcript/activity.ts';
import { foldLimit, type Limit } from '../provider/claude-code/transcript/limit.ts';
import { transcriptWatcher, type TranscriptCompat } from '../provider/claude-code/compat/transcript.ts';
import { localDay } from '../usage/aggregate.ts';
import { stmt } from './statements.ts';
import type { DiscoveredFile } from '../provider/claude-code/types.ts';

export const INDEXER_VERSION = 1;
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const FTS_MAX_CHARS = 20000;

/**
 * 利用者が打った発言を出した claude のプロセスの起動時刻（epoch のミリ秒）を引く口。取れなければ null。
 * 状態を外すのは resume した後の発言だけなので、その見分けに使う。サーバでは sessions/promptProcess.ts を渡す。
 */
export type ProcessStartOf = (q: { sessionId: string; providerSessionId: string; promptTs: number }) => number | null;
/**
 * remote が true なら他端末から降ろした写しである。sessions と session_summaries には書かない。
 * compat を渡すと、手元の本文の行を Claude Code との互換の契約で見張る（他端末の写しは見ない）。
 * stat は呼び手が直前に取ったファイルの大きさと更新時刻である。渡せば、ここでもう一度 statSync しない。
 */
export type IndexFileOptions = { deviceId: string; indexerVersion?: number; cwdFallback?: string; remote?: boolean; processStartOf?: ProcessStartOf; compat?: TranscriptCompat; stat?: FileStat };
/** ファイルの大きさと更新時刻。fs.Stats をそのまま渡してよい。 */
export type FileStat = { size: number; mtimeMs: number };
export type IndexFileResult = { sessionId: string; providerSessionId: string; appended: number; changed: boolean; badLines: number; artifactIds: string[]; skipped: boolean };

type TfRow = { path: string; session_id: string; agent_id: string | null; size: number; mtime: number; indexed_bytes: number; indexer_version: number };

/** 1 ファイル分の事実の積み上げ。主線だけが sessions と session_stats に反映する。 */
type Acc = {
  cwd?: string; firstTs?: number; lastTs?: number; firstPrompt?: string; lastPrompt?: string;
  aiTitle?: string; customTitle?: string; agentName?: string; prUrl?: string; model?: string; effort?: string;
  /** 利用者が打った発言（isTypedPrompt）のうち、最も新しい時刻。状態を外す合図に使う。 */
  lastTypedPromptTs?: number;
  userTurns: number; input: number; output: number;
  daily: Map<string, { input: number; output: number }>;
  /** ターンの終わりの印（system の turn_duration）か、入力待ちの問いが新しく出たか。last_activity_at の共有の間引きを外す合図である。 */
  turnEnded?: boolean;
};

/**
 * 共有の sessions.last_activity_at を書き直すまでの最小の進み（同期の版 6）。
 * 実行中のセッションは本文が伸びるたびに進むので、毎回書くと端末が送る変更の 3 割ほどを占めていた。
 * ほかの事実が変わったときとターンの終わりには、5 分未満でも書く。
 * この PC の画面の時刻と並びは、手元の統計（session_stats.last_ts）で進む（db/queries.ts の SESSION_SELECT）。
 */
export const ACTIVITY_SHARE_MS = 5 * 60_000;

type SessionRow = { id: string; deleted_at: number | null };

/** provider と provider_session_id の組で sessions の行を引く。論理削除された行も返す。 */
function sessionRow(db: Db, providerSessionId: string): SessionRow | undefined {
  return stmt(db, "select id, deleted_at from sessions where provider = 'claude-code' and provider_session_id = ?").get(providerSessionId) as SessionRow | undefined;
}

/**
 * provider と provider_session_id の組で sessions を引き、無ければ作って hangar 側の id を返す。
 * 論理削除された行でも、その id をそのまま返す。
 * sessions は (provider, provider_session_id) が unique なので、別の id で作り直すと insert が落ちる。
 * 削除された会話を索引に積み直さない判断は indexFile の入口に置いてある。
 * ここで消えた行を飛ばすと、本文の無いセッションを掃除する syncHistoryOnly と run の開始が行を作れなくなる。
 */
export function ensureSession(db: Db, providerSessionId: string, cwd: string, deviceId: string): string {
  const row = sessionRow(db, providerSessionId);
  if (row) return row.id;
  const id = newId();
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: providerSessionId, cwd, home_device: deviceId }, deviceId);
  return id;
}

/**
 * provider と provider_session_id の組で sessions を引く。無ければ null。
 * 論理削除された行は「無い」として扱う。他端末から降りてきた写しを、消したはずの会話に積み直さないためである。
 */
export function findSession(db: Db, providerSessionId: string): string | null {
  const row = sessionRow(db, providerSessionId);
  return row && row.deleted_at === null ? row.id : null;
}

/**
 * 先頭からの索引が抜けたファイルを、先頭から読み直させる（版を 0 にする）。直した件数を返す。
 * 前の版の forgetTranscriptFile は、移った先のパスの索引まで消して読み進めた位置だけを残した。そのファイルは続きしか積まれていない。
 * 索引がある（読めた行がある）のに先頭の行の索引が無いものを壊れたと見る。起動のたびに呼んでも、揃ったものには触らない。
 */
export function markTruncatedForReindex(db: Db): number {
  return stmt(db, `update transcript_files set indexer_version = 0
    where indexer_version <> 0
      and exists (select 1 from event_index e where e.session_id = transcript_files.session_id and ifnull(e.parent_agent, '') = ifnull(transcript_files.agent_id, '') and e.file_path_ref = transcript_files.path)
      and not exists (select 1 from event_index e where e.session_id = transcript_files.session_id and ifnull(e.parent_agent, '') = ifnull(transcript_files.agent_id, '') and e.file_path_ref = transcript_files.path and e.byte_offset = 0)`).run().changes;
}

/**
 * 索引化をやめたファイルの索引と行を消す。同じ位置のファイルは常に 1 つだけ索引化する前提に立つ。
 * keepUsage を立てると、日別の使用量（usage_daily）は残す。セッションの削除（sessions/trash.ts）が使う。
 * 実際に使った量なので、会話を消しても集計からは消さない。ゴミ箱から戻して索引し直すときは、先頭からの作り直しで同じファイル由来のぶんを消してから積むので、二重に数えない。
 */
export function forgetTranscriptFile(db: Db, filePath: string, o: { keepUsage?: boolean } = {}): void {
  const row = stmt(db, 'select session_id, agent_id from transcript_files where path = ?').get(filePath) as { session_id: string; agent_id: string | null } | undefined;
  if (!row) return;
  const agentKey = row.agent_id ?? '';
  const run = db.transaction(() => {
    stmt(db, "delete from event_index where session_id = ? and ifnull(parent_agent, '') = ?").run(row.session_id, agentKey);
    stmt(db, "delete from event_fts where session_id = ? and ifnull(agent_id, '') = ?").run(row.session_id, agentKey);
    // 日別の集計はこのファイル由来のぶんを鍵に持っている。
    // 残すと、同じ会話を別のパス（写しから手元へ切り替わったとき）で積み直したぶんと足し合わさり、
    // event_index が正しいのに使用量のゲージだけが静かに倍になる。indexFile の reset 側と同じ 1 文である。
    if (!o.keepUsage) stmt(db, 'delete from usage_daily where session_id = ? and file_path = ?').run(row.session_id, filePath);
    // 「いま何をしているか」は主線の行だけが持つ。主線のファイルそのものを手放すときは、
    // 残すと後で息を吹き返したセッションに、答え済みの問いなど古い「いま」を見せてしまう。
    // サブエージェントのファイルを手放すだけなら、主線の行はそのまま正しいので触らない。
    if (row.agent_id === null) stmt(db, 'delete from session_activity where session_id = ?').run(row.session_id);
    // 使用制限の行も主線のものである。
    if (row.agent_id === null) stmt(db, 'delete from session_limits where session_id = ?').run(row.session_id);
    stmt(db, 'delete from transcript_files where path = ?').run(filePath);
    // 上の 2 つの delete は位置ごとに消すので、同じ位置を別のパスで読んでいたぶんも消える。
    // EnterWorktree は本文を worktree 用の projects の下へ移すので、移った先を読み終えた後に元のパスを手放す順がありうる。
    // そのパスの読み進めた位置だけが残ると、続きしか積まれず、最初の依頼が目次から抜ける。版を 0 にして先頭から読み直させる。
    stmt(db, "update transcript_files set indexer_version = 0 where session_id = ? and ifnull(agent_id, '') = ?").run(row.session_id, agentKey);
  });
  run();
}

/**
 * 前に索引化したときから、大きさも更新時刻も索引の版も変わっていないか。
 * indexFile が何もせずに返す条件そのもので、呼び手が先に引いた行で同じ判定をして indexFile を呼ばずに済ませるのに使う。
 */
export function isUnchanged(tf: { size: number; mtime: number; indexer_version: number }, stat: FileStat, version = INDEXER_VERSION): boolean {
  return tf.indexer_version === version && tf.size === stat.size && tf.mtime === Math.floor(stat.mtimeMs);
}

/**
 * 1 つの transcript ファイルを索引化する。
 * 前回から size も mtime も版も変わっていなければ何もしない。
 * 版が違うか、ファイルが短くなっていたら、そのファイル分の索引を消して先頭から作り直す。
 * DB に置くのはバイト位置と検索用の本文だけで、記録そのものは保存しない。
 */
export function indexFile(db: Db, file: DiscoveredFile, opts: IndexFileOptions): IndexFileResult {
  const version = opts.indexerVersion ?? INDEXER_VERSION;
  const stat = opts.stat ?? fs.statSync(file.path);
  const mtime = Math.floor(stat.mtimeMs);
  const tf = stmt(db, 'select * from transcript_files where path = ?').get(file.path) as TfRow | undefined;
  const remote = opts.remote === true;
  // 論理削除したセッションは掘り起こさない。
  // 一覧にも検索にも出ないまま event_index と event_fts と usage_daily だけが太り、
  // 使用量のゲージは usage_daily を見るので、消したはずの会話のトークンが数え直される。
  // 消えたセッションのファイルが再び現れても、ここで見送るだけにする。
  // 既にある索引の行は消さない。行を消すかどうかは利用者の決めごとで、走査が勝手に決めてよいことではない。
  const known = tf
    ? (stmt(db, 'select id, deleted_at from sessions where id = ?').get(tf.session_id) as SessionRow | undefined)
    : sessionRow(db, file.sessionId);
  if (known && known.deleted_at !== null) {
    return { sessionId: known.id, providerSessionId: file.sessionId, appended: 0, changed: false, badLines: 0, artifactIds: [], skipped: true };
  }
  // 他端末の写しは sessions を作らない。行がまだ届いていなければ次の走査に回す。
  if (remote && !tf && findSession(db, file.sessionId) === null) {
    return { sessionId: '', providerSessionId: file.sessionId, appended: 0, changed: false, badLines: 0, artifactIds: [], skipped: true };
  }
  const sameVersion = tf?.indexer_version === version;
  if (tf && isUnchanged(tf, stat, version)) {
    return { sessionId: tf.session_id, providerSessionId: file.sessionId, appended: 0, changed: false, badLines: 0, artifactIds: [], skipped: false };
  }
  const from = tf && sameVersion ? tf.indexed_bytes : 0;
  const read = readNewLines(file.path, from);
  const reset = read.reset || from === 0;
  const agentKey = file.agentId ?? '';
  // 「いま何をしているか」は手元の主線だけから取る。サブエージェントと他端末の写しは見ない。
  const mainLocal = file.agentId === null && !remote;
  // 形式のずれの見張り。手元の本文だけを見る。他端末の写しは、その端末の claude の版で書かれている。
  const watch = opts.compat && !remote ? transcriptWatcher(opts.compat) : null;

  const parsed: { offset: number; length: number; rec: unknown }[] = [];
  let badLines = 0;
  for (const l of read.lines) {
    try { parsed.push({ offset: l.offset, length: l.length, rec: JSON.parse(l.text) }); } catch { badLines++; }
  }

  const insEv = stmt(db, 'insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref, parent_agent, tool_name, file_path) values (?,?,?,?,?,?,?,?,?,?)');
  const insFts = stmt(db, 'insert into event_fts (session_id, agent_id, seq, role, text) values (?,?,?,?,?)');

  let appended = 0;
  let sessionId = '';
  let artifactIdsOut: string[] = [];
  const run = db.transaction(() => {
    const facts = parsed.map((p) => recordFacts(p.rec));
    const cwd = facts.find((f) => f.cwd)?.cwd ?? opts.cwdFallback ?? '';
    sessionId = tf?.session_id ?? (remote ? findSession(db, file.sessionId)! : ensureSession(db, file.sessionId, cwd, opts.deviceId));
    if (reset) {
      stmt(db, "delete from event_index where session_id = ? and ifnull(parent_agent, '') = ?").run(sessionId, agentKey);
      stmt(db, "delete from event_fts where session_id = ? and ifnull(agent_id, '') = ?").run(sessionId, agentKey);
    }
    // 作り直しでも artifact_versions は消さない。
    // 同じ版を二重に積まない仕組みが recordArtifactPublish にあるので、積み直すだけで冪等になる。
    // 一度公開されたものが後から公開されなかったことにはならないので、残っていて正しい。
    // artifact_calls は結果が来るまでの端末ローカルの控えなので、主線の作り直しでは消してから積み直す。
    if (reset && file.agentId === null) stmt(db, 'delete from artifact_calls where session_id = ?').run(sessionId);
    // 日別の集計は和を持つので、作り直しでは消してから積み直さないと二重に数える。
    // 鍵にファイルのパスを持たせてあるので、消すのはこのファイル由来のぶんだけでよい。
    // 主線を作り直しても、サブエージェントのファイル由来の日別はそのまま残る。
    if (reset) stmt(db, 'delete from usage_daily where session_id = ? and file_path = ?').run(sessionId, file.path);
    const artifactIds = new Set<string>();
    const insCall = stmt(db, 'insert into artifact_calls (tool_id, session_id, file_path, description, favicon) values (?,?,?,?,?) on conflict(tool_id) do update set file_path = excluded.file_path, description = excluded.description, favicon = excluded.favicon');
    const getCall = stmt(db, 'select file_path, description, favicon from artifact_calls where tool_id = ? and session_id = ?');
    // 同じ索引化の中でセッションのプロジェクトは変わらないので、一度引いたら覚えておく。
    let project: { id: string | null } | null = null;
    const projectOf = () => (project ??= { id: (stmt(db, 'select project_id from sessions where id = ?').get(sessionId) as { project_id: string | null }).project_id }).id;
    // seq は主線とサブエージェントで別々に振り、続きは既存の最大値の次から始める。
    let seq = reset ? 0 : ((stmt(db, "select max(seq) m from event_index where session_id = ? and ifnull(parent_agent, '') = ?").get(sessionId, agentKey) as { m: number | null }).m ?? -1) + 1;
    const acc: Acc = { userTurns: 0, input: 0, output: 0, daily: new Map() };
    const loadActivity = stmt(db, 'select tool, summary, tool_id, question from session_activity where session_id = ?');
    const saved = mainLocal && !reset ? (loadActivity.get(sessionId) as { tool: string; summary: string; tool_id: string; question: string | null } | undefined) : undefined;
    const startActivity: Activity | null = saved ? { tool: saved.tool, summary: saved.summary, toolId: saved.tool_id, question: saved.question } : null;
    let activity = startActivity;
    // 使用制限で止まっているか。手元の主線だけが持つ。作り直しでは先頭から畳み直す。
    const savedLimit = mainLocal && !reset ? (stmt(db, 'select kind, resets_at, auto, hit_at from session_limits where session_id = ?').get(sessionId) as { kind: Limit['kind']; resets_at: number; auto: number; hit_at: number } | undefined) : undefined;
    const startLimit: Limit | null = savedLimit ? { kind: savedLimit.kind, resetsAt: savedLimit.resets_at, auto: savedLimit.auto === 1, hitAt: savedLimit.hit_at } : null;
    let limit = startLimit;
    parsed.forEach((p, i) => {
      // 受け口が投げても、見張りのせいで索引の取引を巻き戻さない。
      try { watch?.(p.rec); } catch { /* 見張りは振る舞いを変えない */ }
      const events = normalizeRecord(p.rec, seq, file.agentId);
      if (mainLocal) {
        const was = activity;
        activity = foldActivity(activity, events);
        if (activity?.question && activity.question !== was?.question) acc.turnEnded = true;
      }
      if (events.some((e) => e.kind === 'system' && e.subtype === 'turn_duration')) acc.turnEnded = true;
      if (mainLocal) limit = foldLimit(limit, p.rec, events);
      for (const ev of events) {
        const toolName = ev.kind === 'tool_call' ? ev.name : null;
        const filePath = ev.kind === 'tool_call' ? ev.filePath ?? null : null;
        insEv.run(sessionId, ev.seq, ev.kind, ev.ts ?? null, p.offset, p.length, file.path, file.agentId, toolName, filePath);
        if (ev.kind === 'tool_call' && ev.name === 'Artifact' && isArtifactPublish(ev.input)) {
          const c = artifactCallOf(ev.input);
          insCall.run(ev.toolId, sessionId, c.filePath, c.description, c.favicon);
        } else if (ev.kind === 'tool_result') {
          const url = parsePublishedUrl(ev.text);
          const call = url ? (getCall.get(ev.toolId, sessionId) as { file_path: string | null; description: string | null; favicon: string | null } | undefined) : undefined;
          if (url && call) artifactIds.add(recordArtifactPublish(db, opts.deviceId, { sessionId, projectId: projectOf(), url, publishedAt: ev.ts ?? Date.now(), call: { filePath: call.file_path, description: call.description, favicon: call.favicon } }));
        }
      }
      for (const t of indexTexts(events)) insFts.run(sessionId, file.agentId, t.seq, t.role, t.text.slice(0, FTS_MAX_CHARS));
      seq += events.length;
      appended += events.length;
      const f = facts[i]!;
      if (f.cwd && !acc.cwd) acc.cwd = f.cwd;
      if (f.ts !== undefined) { acc.firstTs = Math.min(acc.firstTs ?? f.ts, f.ts); acc.lastTs = Math.max(acc.lastTs ?? f.ts, f.ts); }
      if (f.isUserTurn) {
        const text = events.find((e) => e.kind === 'user');
        const head = text && text.kind === 'user' ? text.text.slice(0, 200) : '';
        acc.userTurns += 1;
        if (acc.firstPrompt === undefined) acc.firstPrompt = head;
        acc.lastPrompt = head;
      }
      if (f.ts !== undefined && isTypedPrompt(p.rec, f)) acc.lastTypedPromptTs = Math.max(acc.lastTypedPromptTs ?? f.ts, f.ts);
      if (f.aiTitle) acc.aiTitle = f.aiTitle;
      if (f.customTitle) acc.customTitle = f.customTitle;
      if (f.agentName) acc.agentName = f.agentName;
      if (f.prUrl) acc.prUrl = f.prUrl;
      if (f.model) acc.model = f.model;
      if (f.effort) acc.effort = f.effort;
      if (f.usage) {
        acc.input += f.usage.input; acc.output += f.usage.output;
        const day = localDay(f.ts ?? Date.now());
        const cur = acc.daily.get(day) ?? { input: 0, output: 0 };
        acc.daily.set(day, { input: cur.input + f.usage.input, output: cur.output + f.usage.output });
      }
    });
    if (mainLocal && (reset || activity !== startActivity)) {
      if (activity === null) stmt(db, 'delete from session_activity where session_id = ?').run(sessionId);
      else stmt(db, `insert into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,?)
        on conflict(session_id) do update set tool = excluded.tool, summary = excluded.summary, tool_id = excluded.tool_id, question = excluded.question, updated_at = excluded.updated_at`)
        .run(sessionId, activity.tool, activity.summary, activity.toolId, activity.question, Date.now());
    }
    if (mainLocal && (reset || limit !== startLimit)) {
      if (limit === null) stmt(db, 'delete from session_limits where session_id = ?').run(sessionId);
      else stmt(db, `insert into session_limits (session_id, kind, resets_at, auto, hit_at) values (?,?,?,?,?)
        on conflict(session_id) do update set kind = excluded.kind, resets_at = excluded.resets_at, auto = excluded.auto, hit_at = excluded.hit_at`)
        .run(sessionId, limit.kind, limit.resetsAt, limit.auto ? 1 : 0, limit.hitAt);
      // 行は手元だけの表なので、SessionDto（limit）を配り直してもらう。
      touchRow(db, 'sessions', sessionId);
    }
    stmt(db, `insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version, last_error) values (?,?,?,?,?,?,?,?,null)
      on conflict(path) do update set session_id = excluded.session_id, agent_id = excluded.agent_id, device_id = excluded.device_id, size = excluded.size, mtime = excluded.mtime, indexed_bytes = excluded.indexed_bytes, indexer_version = excluded.indexer_version, last_error = null`)
      .run(file.path, sessionId, file.agentId, file.deviceId, stat.size, mtime, read.nextByte, version);
    const upDaily = stmt(db, 'insert into usage_daily (session_id, day, file_path, input_tokens, output_tokens) values (?,?,?,?,?) on conflict(session_id, file_path, day) do update set input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens');
    for (const [day, v] of acc.daily) upDaily.run(sessionId, day, file.path, v.input, v.output);
    if (file.agentId !== null) refreshFilesChanged(db, sessionId);
    else if (remote) writeSessionStats(db, sessionId, acc, reset);
    else applySessionFacts(db, sessionId, acc, reset, opts.deviceId);
    // 利用者が新しく打った発言があれば、古くなった提案と却下の印を外す。resume した後の発言なら、状態も外して Active に戻す。
    // 同じプロセスの続きの発言かどうかは、発言を出したプロセスの起動時刻で見分ける。引く口が無ければ状態は外さない。
    // 手元の主線だけが書く。他端末の写しから外すと、持ち主の PC と同じ書き込みを二重に D1 へ送る。
    // 作り直しで前からある発言を読み直しても、状態を付けた時刻より前なので外れない。
    const promptTs = acc.lastTypedPromptTs;
    if (mainLocal && promptTs !== undefined) {
      clearOnNewPrompt(db, opts.deviceId, sessionId, promptTs, () => opts.processStartOf?.({ sessionId, providerSessionId: file.sessionId, promptTs }) ?? null);
    }
    artifactIdsOut = [...artifactIds];
  });
  run();
  return { sessionId, providerSessionId: file.sessionId, appended, changed: true, badLines, artifactIds: artifactIdsOut, skipped: false };
}

/** 編集系ツールが触ったファイル数を event_index から数え直す。サブエージェントの編集も含む。 */
function refreshFilesChanged(db: Db, sessionId: string): void {
  const marks = EDIT_TOOLS.map(() => '?').join(',');
  const n = (stmt(db, `select count(distinct file_path) c from event_index where session_id = ? and tool_name in (${marks}) and file_path is not null`).get(sessionId, ...EDIT_TOOLS) as { c: number }).c;
  stmt(db, 'insert into session_stats (session_id, files_changed) values (?, ?) on conflict(session_id) do update set files_changed = excluded.files_changed').run(sessionId, n);
}

/**
 * 主線から得た事実を sessions と session_stats に重ねる。sessions は全列を読んでから差分を乗せて upsertShared に渡す。他端末の写しではこの関数を呼ばない。
 * 本文の題名（Claude Code の側で付けた名前）は sessions.custom_title に書く。hangar で付けた名前（session_notes）には触らない。
 * 利用者が移したセッションは、所属を移した先に合わせ直す。
 */
function applySessionFacts(db: Db, sessionId: string, acc: Acc, reset: boolean, deviceId: string): void {
  const cur = stmt(db, 'select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...cur };
  if (acc.cwd && !cur.cwd) next.cwd = acc.cwd;
  if (acc.firstPrompt !== undefined && (reset || cur.first_prompt == null)) next.first_prompt = acc.firstPrompt;
  if (acc.aiTitle) next.ai_title = acc.aiTitle;
  const title = acc.customTitle ?? acc.agentName;
  if (title) next.custom_title = title;
  if (acc.firstTs !== undefined) next.started_at = reset || cur.started_at == null ? acc.firstTs : Math.min(cur.started_at as number, acc.firstTs);
  if (acc.lastTs !== undefined) next.last_activity_at = reset || cur.last_activity_at == null ? acc.lastTs : Math.max(cur.last_activity_at as number, acc.lastTs);
  // 所属は本文から読み取る事実ではなく利用者が決めることなので、移した先（sessions/move.ts）があればそれに合わせ直す。
  // 古い所属が同期で書き戻されていても、ここで直した値が上がる。
  const pin = pinnedProjectOf(db, sessionId);
  if (pin !== null) next.project_id = pin;
  delete next.updated_at; delete next.origin_device;
  const base = Object.fromEntries(Object.entries(cur).filter(([k]) => k !== 'updated_at' && k !== 'origin_device'));
  if (JSON.stringify(next) !== JSON.stringify(base) && !onlyActivityCreeps(base, next, acc, reset)) {
    upsertShared(db, 'sessions', next, deviceId);
  }
  writeSessionStats(db, sessionId, acc, reset);
}

/**
 * 変わったのが last_activity_at の小さな進み（ACTIVITY_SHARE_MS 未満）だけか。そうなら共有の行を書かない。
 * 比べる相手は手元の sessions の値で、それは最後に共有した値である（間引いた進みは手元にも書かない）。
 * ターンの終わりと、作り直し（reset）では間引かない。
 */
function onlyActivityCreeps(base: Record<string, unknown>, next: Record<string, unknown>, acc: Acc, reset: boolean): boolean {
  if (reset || acc.turnEnded) return false;
  const prev = base.last_activity_at;
  const now = next.last_activity_at;
  if (typeof prev !== 'number' || typeof now !== 'number') return false;
  if (now - prev >= ACTIVITY_SHARE_MS) return false;
  return JSON.stringify({ ...next, last_activity_at: prev }) === JSON.stringify(base);
}

/** 索引から導いた統計。session_stats は端末ローカルの表なので、他端末の写しから書いてよい。 */
function writeSessionStats(db: Db, sessionId: string, acc: Acc, reset: boolean): void {
  const st = stmt(db, 'select * from session_stats where session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  const base = reset || !st ? { turns: 0, input_tokens: 0, output_tokens: 0 } : { turns: st.turns as number, input_tokens: st.input_tokens as number, output_tokens: st.output_tokens as number };
  stmt(db, `insert into session_stats (session_id, turns, model, effort, pr_url, input_tokens, output_tokens, first_ts, last_ts, last_prompt) values (?,?,?,?,?,?,?,?,?,?)
    on conflict(session_id) do update set turns = excluded.turns, model = excluded.model, effort = excluded.effort, pr_url = excluded.pr_url, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, first_ts = excluded.first_ts, last_ts = excluded.last_ts, last_prompt = excluded.last_prompt`)
    .run(sessionId, base.turns + acc.userTurns, acc.model ?? (reset ? null : st?.model ?? null), acc.effort ?? (reset ? null : st?.effort ?? null), acc.prUrl ?? (reset ? null : st?.pr_url ?? null),
      base.input_tokens + acc.input, base.output_tokens + acc.output,
      acc.firstTs ?? (reset ? null : st?.first_ts ?? null), acc.lastTs ?? (reset ? null : st?.last_ts ?? null),
      acc.lastPrompt ?? (reset ? null : st?.last_prompt ?? null));
  refreshFilesChanged(db, sessionId);
}
