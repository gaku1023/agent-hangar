import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { upsertShared } from '../db/shared.ts';
import type { Activity, AgentKind, IndexBatch, Limit } from '../agent/types.ts';
import { artifactCallOf, isArtifactPublish, parsePublishedUrl, recordArtifactPublish } from '../artifacts/extract.ts';
import { indexTexts } from '../provider/claude-code/transcript/normalize.ts';
import { pinnedProjectOf } from '../sessions/move.ts';
import { clearOnNewPrompt } from '../sessions/states.ts';
import { localDay } from '../usage/aggregate.ts';
import { stmt } from './statements.ts';

// 索引の DB に書く側。どのエージェントの束（agent/types.ts の IndexBatch）も、ここで同じ表に書く。
// 束を作る側（Claude は provider/claude-code/transcript/batch.ts）は DB を読み書きしない。
// 本文のファイルの読み進めた位置（transcript_files）は、ファイルを読む側の索引（indexer/indexFile.ts）が持つ。

export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const FTS_MAX_CHARS = 20000;

/**
 * 共有の sessions.last_activity_at を書き直すまでの最小の進み（同期の版 6）。
 * 実行中のセッションは本文が伸びるたびに進むので、毎回書くと端末が送る変更の 3 割ほどを占めていた。
 * ほかの事実が変わったときとターンの終わりには、5 分未満でも書く。
 * この PC の画面の時刻と並びは、手元の統計（session_stats.last_ts）で進む（db/queries.ts の SESSION_SELECT）。
 */
export const ACTIVITY_SHARE_MS = 5 * 60_000;

/**
 * 利用者が打った発言を出した claude のプロセスの起動時刻（epoch のミリ秒）を引く口。取れなければ null。
 * 状態を外すのは resume した後の発言だけなので、その見分けに使う。サーバでは sessions/promptProcess.ts を渡す。
 */
export type ProcessStartOf = (q: { sessionId: string; providerSessionId: string; promptTs: number }) => number | null;

/**
 * remote が真なら他端末から降ろした写しである。sessions と session_summaries には書かない。
 * origin は束の出どころで、日別の使用量の鍵（usage_daily.file_path）と、本文を DB に持つ束の event_index.file_path_ref に入る。
 * ファイルの束ではファイルのパスを渡す。省けば storedOrigin で決める。
 * sessionId は、呼び手が既に引いた hangar の会話の id である（transcript_files の行など）。渡せば、削除と写しの見送りの確かめを省く。
 */
export type WriteOptions = {
  deviceId: string; remote?: boolean; cwdFallback?: string; processStartOf?: ProcessStartOf; origin?: string; sessionId?: string;
  /**
   * モデル（`provider/model`）のコンテキストの長さを引く口。記録ごとに文脈の量を持つエージェント（opencode）の context_size を書くのに使う。
   * 本文に文脈の大きさが無いので、モデルの一覧から引く（boot/indexing.ts が opencode の選択肢の口をつなぐ）。引けなければ null で、前の値を残す。
   */
  contextSizeOf?: (model: string) => number | null;
};
/** skipped は、論理削除した会話か、まだ行の届いていない他端末の写しなので書かなかったこと。 */
export type WriteResult = { sessionId: string; appended: number; artifactIds: string[]; skipped: boolean };

/** 本文を DB に持つ束の出どころの名前。主線とサブエージェントで分ける。 */
export function storedOrigin(b: Pick<IndexBatch, 'agent' | 'providerSessionId' | 'agentId'>): string {
  return `${b.agent}:${b.providerSessionId}${b.agentId === null ? '' : `/${b.agentId}`}`;
}

/** 1 つの束の事実の積み上げ。主線だけが sessions と session_stats に反映する。 */
type Acc = {
  cwd?: string; firstTs?: number; lastTs?: number; firstPrompt?: string; lastPrompt?: string;
  aiTitle?: string; customTitle?: string; agentName?: string; prUrl?: string; model?: string; effort?: string;
  /** 利用者が打った発言（IndexRecord.typedPrompt）のうち、最も新しい時刻。状態を外す合図に使う。 */
  lastTypedPromptTs?: number;
  /** 主線の発言と返答の時刻の最大（session_stats.last_turn_ts）。 */
  lastTurnTs?: number;
  userTurns: number; input: number; output: number;
  /** 記録ごとの費用の和と、最後の文脈の量（RecordFacts.costUsd、contextTokens）。持たない束では undefined のまま。 */
  cost?: number; contextTokens?: number;
  /** 記録が持つモデルの文脈の長さ（RecordFacts.contextSize）。contextSizeOf が引けないときの代わりに使う。 */
  contextSize?: number;
  /** 束にモデルの切り替え（RecordFacts.modelSelected）があった。 */
  modelSelected?: boolean;
  daily: Map<string, { input: number; output: number }>;
  /** ターンの終わりの印か、入力待ちの問いが新しく出たか。last_activity_at の共有の間引きを外す合図である。 */
  turnEnded?: boolean;
};

export type SessionRow = { id: string; deleted_at: number | null };

/** provider と provider_session_id の組で sessions の行を引く。論理削除された行も返す。 */
export function sessionRow(db: Db, providerSessionId: string, provider: AgentKind): SessionRow | undefined {
  return stmt(db, 'select id, deleted_at from sessions where provider = ? and provider_session_id = ?').get(provider, providerSessionId) as SessionRow | undefined;
}

/**
 * provider と provider_session_id の組で sessions を引き、無ければ作って hangar 側の id を返す。
 * 論理削除された行でも、その id をそのまま返す。
 * sessions は (provider, provider_session_id) が unique なので、別の id で作り直すと insert が落ちる。
 * 削除された会話を索引に積み直さない判断は、書く前（writeBatch と indexFile の入口）に置いてある。
 * ここで消えた行を飛ばすと、本文の無いセッションを掃除する syncHistoryOnly と run の開始が行を作れなくなる。
 */
export function ensureSession(db: Db, providerSessionId: string, cwd: string, deviceId: string, provider: AgentKind = 'claude-code'): string {
  const row = sessionRow(db, providerSessionId, provider);
  if (row) return row.id;
  const id = newId();
  upsertShared(db, 'sessions', { id, provider, provider_session_id: providerSessionId, cwd, home_device: deviceId }, deviceId);
  return id;
}

/**
 * provider と provider_session_id の組で sessions を引く。無ければ null。
 * 論理削除された行は「無い」として扱う。他端末から降りてきた写しを、消したはずの会話に積み直さないためである。
 */
export function findSession(db: Db, providerSessionId: string, provider: AgentKind = 'claude-code'): string | null {
  const row = sessionRow(db, providerSessionId, provider);
  return row && row.deleted_at === null ? row.id : null;
}

/**
 * 束を書く前に、書いてよい会話かを確かめる。書かないなら、返す結果を作る。
 * 論理削除したセッションは掘り起こさない。
 * 一覧にも検索にも出ないまま event_index と event_fts と usage_daily だけが太り、
 * 使用量のゲージは usage_daily を見るので、消したはずの会話のトークンが数え直される。
 * 消えたセッションの本文が再び現れても、ここで見送るだけにする。
 * 既にある索引の行は消さない。行を消すかどうかは利用者の決めごとで、索引が勝手に決めてよいことではない。
 * 他端末の写しは sessions を作らない。行がまだ届いていなければ次の走査に回す。
 */
export function skipWrite(known: SessionRow | undefined, remote: boolean): WriteResult | null {
  if (known && known.deleted_at !== null) return { sessionId: known.id, appended: 0, artifactIds: [], skipped: true };
  if (remote && (!known || known.deleted_at !== null)) return { sessionId: '', appended: 0, artifactIds: [], skipped: true };
  return null;
}

/**
 * 束を索引の表に書く。1 つの取引で書く（呼び手の取引の中で呼べば、その中の区切りになる）。
 * reset なら、この位置（主線かサブエージェント）の本文の索引、検索、日別の使用量を消してから先頭として積む。
 * ファイルの束は本文を書かず、バイト位置を event_index に残す。本文を DB に持つ束は、出どころの名前を event_index に残し、イベントそのものを agent_events に写す。
 */
export function writeBatch(db: Db, b: IndexBatch, opts: WriteOptions): WriteResult {
  const remote = opts.remote === true;
  if (opts.sessionId === undefined) {
    const skip = skipWrite(sessionRow(db, b.providerSessionId, b.agent), remote);
    if (skip) return skip;
  }
  const origin = opts.origin ?? storedOrigin(b);
  const reset = b.reset;
  const agentKey = b.agentId ?? '';
  // 「いま何をしているか」は手元の主線だけから取る。サブエージェントと他端末の写しは見ない。
  const mainLocal = b.agentId === null && !remote;

  const insEv = stmt(db, 'insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref, parent_agent, tool_name, file_path) values (?,?,?,?,?,?,?,?,?,?)');
  const insFts = stmt(db, 'insert into event_fts (session_id, agent_id, seq, role, text) values (?,?,?,?,?)');
  // 本文を DB に持つ束（stored）は、イベントそのものを agent_events に写す（読むのは transcript/stored.ts）。
  const insBody = stmt(db, 'insert or replace into agent_events (session_id, agent_key, seq, body) values (?,?,?,?)');

  let out: WriteResult = { sessionId: '', appended: 0, artifactIds: [], skipped: false };
  const run = db.transaction(() => {
    const cwd = b.cwd ?? b.records.find((r) => r.facts.cwd)?.facts.cwd ?? opts.cwdFallback ?? '';
    const sessionId = opts.sessionId ?? (remote ? findSession(db, b.providerSessionId, b.agent)! : ensureSession(db, b.providerSessionId, cwd, opts.deviceId, b.agent));
    if (reset) {
      stmt(db, "delete from event_index where session_id = ? and ifnull(parent_agent, '') = ?").run(sessionId, agentKey);
      stmt(db, "delete from event_fts where session_id = ? and ifnull(agent_id, '') = ?").run(sessionId, agentKey);
      stmt(db, 'delete from agent_events where session_id = ? and agent_key = ?').run(sessionId, agentKey);
    }
    // 作り直しでも artifact_versions は消さない。
    // 同じ版を二重に積まない仕組みが recordArtifactPublish にあるので、積み直すだけで冪等になる。
    // 一度公開されたものが後から公開されなかったことにはならないので、残っていて正しい。
    // artifact_calls は結果が来るまでの端末ローカルの控えなので、主線の作り直しでは消してから積み直す。
    if (reset && b.agentId === null) stmt(db, 'delete from artifact_calls where session_id = ?').run(sessionId);
    // 日別の集計は和を持つので、作り直しでは消してから積み直さないと二重に数える。
    // 鍵に出どころ（ファイルのパス）を持たせてあるので、消すのはこの出どころのぶんだけでよい。
    // 主線を作り直しても、サブエージェントのファイル由来の日別はそのまま残る。
    if (reset) stmt(db, 'delete from usage_daily where session_id = ? and file_path = ?').run(sessionId, origin);
    // 本文を DB に持つ束は、同じ位置を手元の束（`opencode:<会話>`）とほかの PC の写しの束（`opencode:<会話>@<PC>`）が書き替え合う。
    // 作り直しでは、どちらの出どころの日別も消してから積む（ファイルの束が写しを選び替えたときに前の写しの日別を消すのと同じ。二重に数えない）。
    const storedBase = storedOrigin(b);
    if (reset && (origin === storedBase || origin.startsWith(`${storedBase}@`))) {
      stmt(db, 'delete from usage_daily where session_id = ? and (file_path = ? or substr(file_path, 1, ?) = ?)').run(sessionId, storedBase, storedBase.length + 1, `${storedBase}@`);
    }
    const artifactIds = new Set<string>();
    const insCall = stmt(db, 'insert into artifact_calls (tool_id, session_id, file_path, description, favicon) values (?,?,?,?,?) on conflict(tool_id) do update set file_path = excluded.file_path, description = excluded.description, favicon = excluded.favicon');
    const getCall = stmt(db, 'select file_path, description, favicon from artifact_calls where tool_id = ? and session_id = ?');
    // 同じ索引化の中でセッションのプロジェクトは変わらないので、一度引いたら覚えておく。
    let project: { id: string | null } | null = null;
    const projectOf = () => (project ??= { id: (stmt(db, 'select project_id from sessions where id = ?').get(sessionId) as { project_id: string | null }).project_id }).id;
    // seq は主線とサブエージェントで別々に振り、続きは既存の最大値の次から始める。束の中の seq はその上に乗せる。
    const base = reset ? 0 : ((stmt(db, "select max(seq) m from event_index where session_id = ? and ifnull(parent_agent, '') = ?").get(sessionId, agentKey) as { m: number | null }).m ?? -1) + 1;
    const acc: Acc = { userTurns: 0, input: 0, output: 0, daily: new Map() };
    let appended = 0;
    for (const r of b.records) {
      const events = r.events.map((e) => ({ ...e, seq: e.seq + base }));
      const offset = r.locator.kind === 'file' ? r.locator.offset : 0;
      const length = r.locator.kind === 'file' ? r.locator.length : 0;
      const ref = r.locator.kind === 'file' ? r.locator.path : origin;
      if (r.endsTurn) acc.turnEnded = true;
      for (const ev of events) {
        const toolName = ev.kind === 'tool_call' ? ev.name : null;
        const filePath = ev.kind === 'tool_call' ? ev.filePath ?? null : null;
        insEv.run(sessionId, ev.seq, ev.kind, ev.ts ?? null, offset, length, ref, b.agentId, toolName, filePath);
        if ((ev.kind === 'user' || ev.kind === 'assistant') && ev.ts !== undefined) acc.lastTurnTs = Math.max(acc.lastTurnTs ?? ev.ts, ev.ts);
        if (r.locator.kind === 'stored') insBody.run(sessionId, agentKey, ev.seq, JSON.stringify(ev));
        if (ev.kind === 'tool_call' && ev.name === 'Artifact' && isArtifactPublish(ev.input)) {
          const c = artifactCallOf(ev.input);
          insCall.run(ev.toolId, sessionId, c.filePath, c.description, c.favicon);
        } else if (ev.kind === 'tool_result') {
          const url = parsePublishedUrl(ev.text);
          const call = url ? (getCall.get(ev.toolId, sessionId) as { file_path: string | null; description: string | null; favicon: string | null } | undefined) : undefined;
          if (url && call) artifactIds.add(recordArtifactPublish(db, opts.deviceId, { sessionId, projectId: projectOf(), url, publishedAt: ev.ts ?? Date.now(), call: { filePath: call.file_path, description: call.description, favicon: call.favicon } }));
        }
      }
      for (const t of indexTexts(events)) insFts.run(sessionId, b.agentId, t.seq, t.role, t.text.slice(0, FTS_MAX_CHARS));
      appended += events.length;
      const f = r.facts;
      if (f.cwd && !acc.cwd) acc.cwd = f.cwd;
      if (f.ts !== undefined) { acc.firstTs = Math.min(acc.firstTs ?? f.ts, f.ts); acc.lastTs = Math.max(acc.lastTs ?? f.ts, f.ts); }
      if (f.isUserTurn) {
        const text = events.find((e) => e.kind === 'user');
        const head = text && text.kind === 'user' ? text.text.slice(0, 200) : '';
        acc.userTurns += 1;
        if (acc.firstPrompt === undefined) acc.firstPrompt = head;
        acc.lastPrompt = head;
      }
      if (f.ts !== undefined && r.typedPrompt) acc.lastTypedPromptTs = Math.max(acc.lastTypedPromptTs ?? f.ts, f.ts);
      if (f.aiTitle) acc.aiTitle = f.aiTitle;
      if (f.customTitle) acc.customTitle = f.customTitle;
      if (f.agentName) acc.agentName = f.agentName;
      if (f.prUrl) acc.prUrl = f.prUrl;
      if (f.model) acc.model = f.model;
      if (f.modelSelected) acc.modelSelected = true;
      if (f.effort) acc.effort = f.effort;
      if (f.costUsd !== undefined) acc.cost = (acc.cost ?? 0) + f.costUsd;
      if (f.contextTokens !== undefined) acc.contextTokens = f.contextTokens;
      if (f.contextSize !== undefined) acc.contextSize = f.contextSize;
      if (f.usage) {
        acc.input += f.usage.input; acc.output += f.usage.output;
        const day = localDay(f.ts ?? Date.now());
        const cur = acc.daily.get(day) ?? { input: 0, output: 0 };
        acc.daily.set(day, { input: cur.input + f.usage.input, output: cur.output + f.usage.output });
      }
    }
    if (mainLocal && (acc.cost !== undefined || acc.contextTokens !== undefined || acc.contextSize !== undefined || acc.modelSelected)) writeLiveStats(db, b.providerSessionId, acc, reset, opts.contextSizeOf);
    if (mainLocal && b.fold) {
      if (writeActivity(db, sessionId, reset, b.fold.activity)) acc.turnEnded = true;
      writeLimit(db, sessionId, reset, b.fold.limit);
    }
    const upDaily = stmt(db, 'insert into usage_daily (session_id, day, file_path, input_tokens, output_tokens) values (?,?,?,?,?) on conflict(session_id, file_path, day) do update set input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens');
    for (const [day, v] of acc.daily) upDaily.run(sessionId, day, origin, v.input, v.output);
    if (b.agentId !== null) refreshFilesChanged(db, sessionId);
    else if (remote) writeSessionStats(db, sessionId, acc, reset);
    else applySessionFacts(db, sessionId, acc, reset, opts.deviceId);
    // 利用者が新しく打った発言があれば、古くなった提案と却下の印を外す。resume した後の発言なら、状態も外して Active に戻す。
    // 同じプロセスの続きの発言かどうかは、発言を出したプロセスの起動時刻で見分ける。引く口が無ければ状態は外さない。
    // 手元の主線だけが書く。他端末の写しから外すと、持ち主の PC と同じ書き込みを二重に D1 へ送る。
    // 作り直しで前からある発言を読み直しても、状態を付けた時刻より前なので外れない。
    const promptTs = acc.lastTypedPromptTs;
    if (mainLocal && promptTs !== undefined) {
      clearOnNewPrompt(db, opts.deviceId, sessionId, promptTs, () => opts.processStartOf?.({ sessionId, providerSessionId: b.providerSessionId, promptTs }) ?? null);
    }
    out = { sessionId, appended, artifactIds: [...artifactIds], skipped: false };
  });
  run();
  return out;
}

/**
 * 記録ごとに費用と文脈の量を持つエージェント（opencode）の、会話の今の値を書く。Claude は statusline から同じ表へ書く（usage/statusline.ts）。
 * 費用は記録の和なので、続きの束では前の値に足し、作り直しでは置き換える。文脈の量とモデルは最後の値にする。
 * 文脈の大きさ（context_size）は本文に無いので、モデル（束のものか、前に書いたもの）の上限を contextSizeOf で引いて書く。
 * 引けなければ書かず、前の値を残す。
 * モデルの切り替えだけの束（opencode の model-switched）でも書く。返答を待たずに札のモデルと文脈の大きさを切り替えるためである。
 */
function writeLiveStats(db: Db, providerSessionId: string, acc: Acc, reset: boolean, contextSizeOf?: (model: string) => number | null): void {
  const prev = stmt(db, 'select cost_usd, model from session_live_stats where provider_session_id = ?').get(providerSessionId) as { cost_usd: number | null; model: string | null } | undefined;
  const prevCost = reset ? undefined : prev?.cost_usd;
  const cost = acc.cost === undefined ? (prevCost ?? null) : (prevCost ?? 0) + acc.cost;
  const model = acc.model ?? prev?.model ?? null;
  const size = (model !== null && contextSizeOf ? contextSizeOf(model) : null) ?? acc.contextSize ?? null;
  stmt(db, `insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)
    on conflict(provider_session_id) do update set model = coalesce(excluded.model, session_live_stats.model),
      context_used = coalesce(excluded.context_used, session_live_stats.context_used), context_size = coalesce(excluded.context_size, session_live_stats.context_size),
      cost_usd = excluded.cost_usd, updated_at = excluded.updated_at`)
    .run(providerSessionId, acc.model ?? null, null, acc.contextTokens ?? null, size, cost, Date.now());
}

/** 「いま何をしているか」を畳んで書く。新しい問いが出たら真を返す。 */
function writeActivity(db: Db, sessionId: string, reset: boolean, fold: (prev: Activity | null) => { next: Activity | null; asked: boolean }): boolean {
  const saved = reset ? undefined : (stmt(db, 'select tool, summary, tool_id, question from session_activity where session_id = ?').get(sessionId) as { tool: string; summary: string; tool_id: string; question: string | null } | undefined);
  const start: Activity | null = saved ? { tool: saved.tool, summary: saved.summary, toolId: saved.tool_id, question: saved.question } : null;
  const { next, asked } = fold(start);
  if (reset || next !== start) {
    if (next === null) stmt(db, 'delete from session_activity where session_id = ?').run(sessionId);
    else stmt(db, `insert into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,?)
      on conflict(session_id) do update set tool = excluded.tool, summary = excluded.summary, tool_id = excluded.tool_id, question = excluded.question, updated_at = excluded.updated_at`)
      .run(sessionId, next.tool, next.summary, next.toolId, next.question, Date.now());
  }
  return asked;
}

/** 使用制限で止まっているかを畳んで書く。作り直しでは先頭から畳み直す。 */
function writeLimit(db: Db, sessionId: string, reset: boolean, fold: (prev: Limit | null) => Limit | null): void {
  const saved = reset ? undefined : (stmt(db, 'select kind, resets_at, auto, hit_at from session_limits where session_id = ?').get(sessionId) as { kind: Limit['kind']; resets_at: number; auto: number; hit_at: number } | undefined);
  const start: Limit | null = saved ? { kind: saved.kind, resetsAt: saved.resets_at, auto: saved.auto === 1, hitAt: saved.hit_at } : null;
  const next = fold(start);
  if (!reset && next === start) return;
  if (next === null) stmt(db, 'delete from session_limits where session_id = ?').run(sessionId);
  else stmt(db, `insert into session_limits (session_id, kind, resets_at, auto, hit_at) values (?,?,?,?,?)
    on conflict(session_id) do update set kind = excluded.kind, resets_at = excluded.resets_at, auto = excluded.auto, hit_at = excluded.hit_at`)
    .run(sessionId, next.kind, next.resetsAt, next.auto ? 1 : 0, next.hitAt);
  // 行は手元だけの表なので、SessionDto（limit）を配り直してもらう。
  touchRow(db, 'sessions', sessionId);
}

/** 編集系ツールが触ったファイル数を event_index から数え直す。サブエージェントの編集も含む。 */
function refreshFilesChanged(db: Db, sessionId: string): void {
  const marks = EDIT_TOOLS.map(() => '?').join(',');
  const n = (stmt(db, `select count(distinct file_path) c from event_index where session_id = ? and tool_name in (${marks}) and file_path is not null`).get(sessionId, ...EDIT_TOOLS) as { c: number }).c;
  stmt(db, 'insert into session_stats (session_id, files_changed) values (?, ?) on conflict(session_id) do update set files_changed = excluded.files_changed').run(sessionId, n);
}

/**
 * 主線から得た事実を sessions と session_stats に重ねる。sessions は全列を読んでから差分を乗せて upsertShared に渡す。他端末の写しではこの関数を呼ばない。
 * 本文の題名（エージェントの側で付けた名前）は sessions.custom_title に書く。hangar で付けた名前（session_notes）には触らない。
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
  stmt(db, `insert into session_stats (session_id, turns, model, effort, pr_url, input_tokens, output_tokens, first_ts, last_ts, last_prompt, last_turn_ts) values (?,?,?,?,?,?,?,?,?,?,?)
    on conflict(session_id) do update set turns = excluded.turns, model = excluded.model, effort = excluded.effort, pr_url = excluded.pr_url, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, first_ts = excluded.first_ts, last_ts = excluded.last_ts, last_prompt = excluded.last_prompt, last_turn_ts = excluded.last_turn_ts`)
    .run(sessionId, base.turns + acc.userTurns, acc.model ?? (reset ? null : st?.model ?? null), acc.effort ?? (reset ? null : st?.effort ?? null), acc.prUrl ?? (reset ? null : st?.pr_url ?? null),
      base.input_tokens + acc.input, base.output_tokens + acc.output,
      acc.firstTs ?? (reset ? null : st?.first_ts ?? null), acc.lastTs ?? (reset ? null : st?.last_ts ?? null),
      acc.lastPrompt ?? (reset ? null : st?.last_prompt ?? null),
      acc.lastTurnTs ?? (reset ? null : st?.last_turn_ts ?? null));
  refreshFilesChanged(db, sessionId);
}
