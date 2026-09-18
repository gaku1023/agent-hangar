import fs from 'node:fs';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { readNewLines } from '../provider/claude-code/lines.ts';
import { artifactCallOf, parsePublishedUrl, recordArtifactPublish } from '../artifacts/extract.ts';
import { indexTexts, normalizeRecord, recordFacts } from '../provider/claude-code/normalize.ts';
import { localDay } from '../usage/aggregate.ts';
import type { DiscoveredFile } from '../provider/types.ts';

export const INDEXER_VERSION = 1;
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const FTS_MAX_CHARS = 20000;

export type IndexFileOptions = { deviceId: string; indexerVersion?: number; cwdFallback?: string };
export type IndexFileResult = { sessionId: string; providerSessionId: string; appended: number; changed: boolean; badLines: number; artifactIds: string[] };

type TfRow = { path: string; session_id: string; agent_id: string | null; size: number; mtime: number; indexed_bytes: number; indexer_version: number };

/** 1 ファイル分の事実の積み上げ。主線だけが sessions と session_stats に反映する。 */
type Acc = {
  cwd?: string; firstTs?: number; lastTs?: number; firstPrompt?: string; lastPrompt?: string;
  aiTitle?: string; customTitle?: string; agentName?: string; prUrl?: string; model?: string; effort?: string;
  userTurns: number; input: number; output: number;
  daily: Map<string, { input: number; output: number }>;
};

/** provider と provider_session_id の組で sessions を引き、無ければ作って hangar 側の id を返す。 */
export function ensureSession(db: Db, providerSessionId: string, cwd: string, deviceId: string): string {
  const row = db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ?").get(providerSessionId) as { id: string } | undefined;
  if (row) return row.id;
  const id = newId();
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: providerSessionId, cwd, home_device: deviceId }, deviceId);
  return id;
}

/**
 * 1 つの transcript ファイルを索引化する。
 * 前回から size も mtime も版も変わっていなければ何もしない。
 * 版が違うか、ファイルが短くなっていたら、そのファイル分の索引を消して先頭から作り直す。
 * DB に置くのはバイト位置と検索用の本文だけで、記録そのものは保存しない。
 */
export function indexFile(db: Db, file: DiscoveredFile, opts: IndexFileOptions): IndexFileResult {
  const version = opts.indexerVersion ?? INDEXER_VERSION;
  const stat = fs.statSync(file.path);
  const mtime = Math.floor(stat.mtimeMs);
  const tf = db.prepare('select * from transcript_files where path = ?').get(file.path) as TfRow | undefined;
  const sameVersion = tf?.indexer_version === version;
  if (tf && sameVersion && tf.size === stat.size && tf.mtime === mtime) {
    return { sessionId: tf.session_id, providerSessionId: file.sessionId, appended: 0, changed: false, badLines: 0, artifactIds: [] };
  }
  const from = tf && sameVersion ? tf.indexed_bytes : 0;
  const read = readNewLines(file.path, from);
  const reset = read.reset || from === 0;
  const agentKey = file.agentId ?? '';

  const parsed: { offset: number; length: number; rec: unknown }[] = [];
  let badLines = 0;
  for (const l of read.lines) {
    try { parsed.push({ offset: l.offset, length: l.length, rec: JSON.parse(l.text) }); } catch { badLines++; }
  }

  const insEv = db.prepare('insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref, parent_agent, tool_name, file_path) values (?,?,?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('insert into event_fts (session_id, agent_id, seq, role, text) values (?,?,?,?,?)');

  let appended = 0;
  let sessionId = '';
  let artifactIdsOut: string[] = [];
  const run = db.transaction(() => {
    const facts = parsed.map((p) => recordFacts(p.rec));
    const cwd = facts.find((f) => f.cwd)?.cwd ?? opts.cwdFallback ?? '';
    sessionId = tf?.session_id ?? ensureSession(db, file.sessionId, cwd, opts.deviceId);
    if (reset) {
      db.prepare("delete from event_index where session_id = ? and ifnull(parent_agent, '') = ?").run(sessionId, agentKey);
      db.prepare("delete from event_fts where session_id = ? and ifnull(agent_id, '') = ?").run(sessionId, agentKey);
    }
    // 主線の作り直しでは、このセッションの版と呼び出しの控えを消してから積み直す。
    // サブエージェントのファイルだけの作り直しで主線の版を消さないよう、主線に限る。
    if (reset && file.agentId === null) {
      db.prepare('delete from artifact_versions where session_id = ? and deleted_at is null').run(sessionId);
      db.prepare('delete from artifact_calls where session_id = ?').run(sessionId);
    }
    // 主線の作り直しでは日別の集計も消す。サブエージェントのぶんは主線の次の走査で積み直される。
    if (reset && file.agentId === null) db.prepare('delete from usage_daily where session_id = ?').run(sessionId);
    const artifactIds = new Set<string>();
    const insCall = db.prepare('insert into artifact_calls (tool_id, session_id, file_path, description, favicon) values (?,?,?,?,?) on conflict(tool_id) do update set file_path = excluded.file_path, description = excluded.description, favicon = excluded.favicon');
    const getCall = db.prepare('select file_path, description, favicon from artifact_calls where tool_id = ? and session_id = ?');
    const projectOf = () => (db.prepare('select project_id from sessions where id = ?').get(sessionId) as { project_id: string | null }).project_id;
    // seq は主線とサブエージェントで別々に振り、続きは既存の最大値の次から始める。
    let seq = reset ? 0 : ((db.prepare("select max(seq) m from event_index where session_id = ? and ifnull(parent_agent, '') = ?").get(sessionId, agentKey) as { m: number | null }).m ?? -1) + 1;
    const acc: Acc = { userTurns: 0, input: 0, output: 0, daily: new Map() };
    parsed.forEach((p, i) => {
      const events = normalizeRecord(p.rec, seq, file.agentId);
      for (const ev of events) {
        const toolName = ev.kind === 'tool_call' ? ev.name : null;
        const filePath = ev.kind === 'tool_call' ? ev.filePath ?? null : null;
        insEv.run(sessionId, ev.seq, ev.kind, ev.ts ?? null, p.offset, p.length, file.path, file.agentId, toolName, filePath);
        if (ev.kind === 'tool_call' && ev.name === 'Artifact') {
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
    db.prepare(`insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version, last_error) values (?,?,?,?,?,?,?,null)
      on conflict(path) do update set session_id = excluded.session_id, agent_id = excluded.agent_id, size = excluded.size, mtime = excluded.mtime, indexed_bytes = excluded.indexed_bytes, indexer_version = excluded.indexer_version, last_error = null`)
      .run(file.path, sessionId, file.agentId, stat.size, mtime, read.nextByte, version);
    const upDaily = db.prepare('insert into usage_daily (session_id, day, input_tokens, output_tokens) values (?,?,?,?) on conflict(session_id, day) do update set input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens');
    for (const [day, v] of acc.daily) upDaily.run(sessionId, day, v.input, v.output);
    if (file.agentId === null) applySessionFacts(db, sessionId, acc, reset, opts.deviceId);
    else refreshFilesChanged(db, sessionId);
    artifactIdsOut = [...artifactIds];
  });
  run();
  return { sessionId, providerSessionId: file.sessionId, appended, changed: true, badLines, artifactIds: artifactIdsOut };
}

/** 編集系ツールが触ったファイル数を event_index から数え直す。サブエージェントの編集も含む。 */
function refreshFilesChanged(db: Db, sessionId: string): void {
  const marks = EDIT_TOOLS.map(() => '?').join(',');
  const n = (db.prepare(`select count(distinct file_path) c from event_index where session_id = ? and tool_name in (${marks}) and file_path is not null`).get(sessionId, ...EDIT_TOOLS) as { c: number }).c;
  db.prepare('insert into session_stats (session_id, files_changed) values (?, ?) on conflict(session_id) do update set files_changed = excluded.files_changed').run(sessionId, n);
}

/** 主線から得た事実を sessions と session_stats に重ねる。sessions は全列を読んでから差分を乗せて upsertShared に渡す。 */
function applySessionFacts(db: Db, sessionId: string, acc: Acc, reset: boolean, deviceId: string): void {
  const cur = db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...cur };
  if (acc.cwd && !cur.cwd) next.cwd = acc.cwd;
  if (acc.firstPrompt !== undefined && (reset || cur.first_prompt == null)) next.first_prompt = acc.firstPrompt;
  if (acc.aiTitle) next.ai_title = acc.aiTitle;
  const name = acc.customTitle ?? acc.agentName;
  if (name) next.name = name;
  if (acc.firstTs !== undefined) next.started_at = reset || cur.started_at == null ? acc.firstTs : Math.min(cur.started_at as number, acc.firstTs);
  if (acc.lastTs !== undefined) next.last_activity_at = reset || cur.last_activity_at == null ? acc.lastTs : Math.max(cur.last_activity_at as number, acc.lastTs);
  delete next.updated_at; delete next.origin_device;
  if (JSON.stringify(next) !== JSON.stringify(Object.fromEntries(Object.entries(cur).filter(([k]) => k !== 'updated_at' && k !== 'origin_device')))) {
    upsertShared(db, 'sessions', next, deviceId);
  }
  const st = db.prepare('select * from session_stats where session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  const base = reset || !st ? { turns: 0, input_tokens: 0, output_tokens: 0 } : { turns: st.turns as number, input_tokens: st.input_tokens as number, output_tokens: st.output_tokens as number };
  db.prepare(`insert into session_stats (session_id, turns, model, effort, pr_url, input_tokens, output_tokens, first_ts, last_ts, last_prompt) values (?,?,?,?,?,?,?,?,?,?)
    on conflict(session_id) do update set turns = excluded.turns, model = excluded.model, effort = excluded.effort, pr_url = excluded.pr_url, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, first_ts = excluded.first_ts, last_ts = excluded.last_ts, last_prompt = excluded.last_prompt`)
    .run(sessionId, base.turns + acc.userTurns, acc.model ?? (reset ? null : st?.model ?? null), acc.effort ?? (reset ? null : st?.effort ?? null), acc.prUrl ?? (reset ? null : st?.pr_url ?? null),
      base.input_tokens + acc.input, base.output_tokens + acc.output,
      acc.firstTs ?? (reset ? null : st?.first_ts ?? null), acc.lastTs ?? (reset ? null : st?.last_ts ?? null),
      acc.lastPrompt ?? (reset ? null : st?.last_prompt ?? null));
  refreshFilesChanged(db, sessionId);
}
