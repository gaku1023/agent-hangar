import type { DeviceDto, LiveSessionDto, ProjectDto, SessionDto, SessionLockDto, SessionStatsDto, SessionSummaryDto } from '@agent-hangar/shared';
import type { Db } from './open.ts';

/** sessions に要約と統計と本文の有無を左結合した 1 行。 */
type SessionRow = {
  id: string;
  provider: 'claude-code';
  provider_session_id: string;
  project_id: string | null;
  name: string | null;
  cwd: string;
  first_prompt: string | null;
  ai_title: string | null;
  started_at: number | null;
  last_activity_at: number | null;
  memo: string | null;
  has_transcript: number;
  has_local: number;
  project_is_scratch: number | null;
  scratch_root: string | null;
  sum_title: string | null;
  sum_one: string | null;
  sum_body: string | null;
  sum_state: SessionSummaryDto['state'] | null;
  sum_next: string | null;
  sum_source: SessionSummaryDto['source'] | null;
  sum_source_id: string | null;
  sum_model: string | null;
  sum_turns: number | null;
  sum_updated: number | null;
  st_turns: number | null;
  st_model: string | null;
  st_effort: string | null;
  st_files: number | null;
  st_pr: string | null;
  st_in: number | null;
  st_out: number | null;
  ls_model: string | null;
  ls_effort: string | null;
  ls_used: number | null;
  ls_size: number | null;
  ls_cost: number | null;
};

const SESSION_SELECT = `
select s.*, exists(select 1 from transcript_files t where t.session_id = s.id and t.agent_id is null) has_transcript,
  exists(select 1 from transcript_files t where t.session_id = s.id and t.agent_id is null and t.device_id is null) has_local,
  p.is_scratch project_is_scratch,
  (select r.path from project_roots r join projects sp on sp.id = r.project_id where r.device_id = s.home_device and sp.is_scratch = 1 and sp.deleted_at is null and r.deleted_at is null order by r.updated_at desc limit 1) scratch_root,
  m.title sum_title, m.one_liner sum_one, m.body sum_body, m.state sum_state, m.next_steps sum_next, m.source sum_source, m.source_id sum_source_id, m.source_model sum_model, m.based_on_turns sum_turns, m.updated_at sum_updated,
  st.turns st_turns, st.model st_model, st.effort st_effort, st.files_changed st_files, st.pr_url st_pr, st.input_tokens st_in, st.output_tokens st_out,
  ls.model ls_model, ls.effort ls_effort, ls.context_used ls_used, ls.context_size ls_size, ls.cost_usd ls_cost
from sessions s
left join projects p on p.id = s.project_id
left join session_summaries m on m.session_id = s.id and m.deleted_at is null
left join session_stats st on st.session_id = s.id
left join session_live_stats ls on ls.provider_session_id = s.provider_session_id
where s.deleted_at is null`;

/**
 * 表示名を決める。
 * 利用者が Claude Code 側で付けた名前、hangar で付けた名前、ai_title、最初の発言の先頭 40 字の順に採る。
 */
export function displayName(
  s: { name: string | null; ai_title: string | null; first_prompt: string | null },
  live: LiveSessionDto | undefined,
): string | null {
  if (live?.nameSource === 'user' && live.name) return live.name;
  if (s.name) return s.name;
  if (s.ai_title) return s.ai_title;
  if (s.first_prompt) return [...s.first_prompt].slice(0, 40).join('');
  return null;
}

/**
 * next_steps は JSON の文字列配列として保存されている。
 * 壊れていたら空にする。
 */
function parseNextSteps(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** コンテキスト使用率。分母が無いか 0 なら null。 */
export function contextPercent(used: number | null, size: number | null): number | null {
  if (used === null || size === null || size <= 0) return null;
  return Math.round((used / size) * 1000) / 10;
}

/** 他端末の run が生きているとみなす heartbeat の猶予。これを過ぎたロックは stale として見せる。 */
export const LOCK_STALE_MS = 120_000;

export type SessionQueryOptions = { projectId?: string; ids?: string[]; deviceId?: string; now?: () => number };

type LockRow = { session_id: string; run_id: string; device_id: string; device_name: string | null; heartbeat_at: number };

/**
 * 他端末で生きている run を、セッションごとに 1 つ拾う。
 * 自端末の run は「実行中」として live に出るので、ロックには含めない。
 * heartbeat が古い run もロックのままにして、stale を立てて「応答がありません」と見せる。
 */
function lockMap(db: Db, selfDeviceId: string | undefined, now: number): Map<string, SessionLockDto> {
  const out = new Map<string, SessionLockDto>();
  if (!selfDeviceId) return out;
  const rows = db.prepare(`
    select r.session_id, r.id run_id, r.device_id, d.name device_name, r.heartbeat_at
    from runs r left join devices d on d.id = r.device_id and d.deleted_at is null
    where r.ended_at is null and r.deleted_at is null and r.device_id <> ?
    order by r.heartbeat_at`).all(selfDeviceId) as LockRow[];
  // heartbeat の昇順なので、同じセッションでは後から来た新しい行が残る。
  for (const r of rows) {
    out.set(r.session_id, {
      deviceId: r.device_id,
      deviceName: r.device_name ?? r.device_id,
      runId: r.run_id,
      heartbeatAt: r.heartbeat_at,
      stale: now - r.heartbeat_at > LOCK_STALE_MS,
    });
  }
  return out;
}

function toSessionDto(r: SessionRow, liveMap: Map<string, LiveSessionDto>, locks: Map<string, SessionLockDto>): SessionDto {
  const live = liveMap.get(r.provider_session_id);
  const summary: SessionSummaryDto | null = r.sum_title !== null
    ? {
        title: r.sum_title,
        oneLiner: r.sum_one ?? '',
        body: r.sum_body ?? '',
        state: r.sum_state ?? 'done',
        nextSteps: parseNextSteps(r.sum_next),
        source: r.sum_source ?? 'baseline',
        sourceId: r.sum_source_id,
        sourceModel: r.sum_model,
        basedOnTurns: r.sum_turns ?? 0,
        updatedAt: r.sum_updated ?? 0,
      }
    : null;
  // statusline の値を優先し、無いときだけ索引の値を使う。
  const stats: SessionStatsDto = {
    turns: r.st_turns ?? 0,
    model: r.ls_model ?? r.st_model,
    effort: r.ls_effort ?? r.st_effort,
    filesChanged: r.st_files ?? 0,
    prUrl: r.st_pr,
    inputTokens: r.st_in ?? 0,
    outputTokens: r.st_out ?? 0,
    contextPercent: contextPercent(r.ls_used, r.ls_size),
    costUsd: r.ls_cost,
  };
  // スクラッチのルートの下で始まり、なお別のプロジェクトに属しているセッションを昇格の対象として印す。
  // cwd はそのセッションを持つ端末のパスなので、ルートも同じ端末のものだけを見る。
  // スクラッチの起動は必ず <root>/<yyyymmdd-HHmmss> に入るので、ルート自身は下に含めない。
  // projects/scratch.ts の isUnderScratch と同じ判定である。
  const underScratch = r.scratch_root !== null && r.cwd.startsWith(r.scratch_root + '/');
  return {
    id: r.id,
    provider: r.provider,
    providerSessionId: r.provider_session_id,
    projectId: r.project_id,
    name: displayName(r, live),
    cwd: r.cwd,
    fromScratch: underScratch && r.project_is_scratch !== 1,
    firstPrompt: r.first_prompt,
    aiTitle: r.ai_title,
    startedAt: r.started_at,
    lastActivityAt: r.last_activity_at,
    memo: r.memo,
    hasTranscript: r.has_transcript === 1,
    live: live?.status ?? null,
    summary,
    stats,
    lock: locks.get(r.id) ?? null,
    // 本文はあるが手元の主線が無いとき、閲覧の前に本文を降ろす必要がある。
    remoteOnly: r.has_transcript === 1 && r.has_local === 0,
  };
}

/** live レジストリを provider のセッション UUID で引けるようにする。 */
const liveMapOf = (live: LiveSessionDto[]) => new Map(live.map((l) => [l.sessionId, l]));

/**
 * セッション一覧。
 * last_activity_at の降順で、null は末尾に置く。
 */
export function listSessions(db: Db, live: LiveSessionDto[], opts: SessionQueryOptions = {}): SessionDto[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.projectId) {
    where.push('s.project_id = ?');
    args.push(opts.projectId);
  }
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    where.push(`s.id in (${opts.ids.map(() => '?').join(',')})`);
    args.push(...opts.ids);
  }
  const sql = `${SESSION_SELECT}${where.length ? ' and ' + where.join(' and ') : ''} order by s.last_activity_at desc nulls last, s.started_at desc nulls last, s.id`;
  const rows = db.prepare(sql).all(...args) as SessionRow[];
  const lm = liveMapOf(live);
  const locks = lockMap(db, opts.deviceId, opts.now ? opts.now() : Date.now());
  return rows.map((r) => toSessionDto(r, lm, locks));
}

export function getSession(db: Db, live: LiveSessionDto[], id: string, opts: { deviceId?: string; now?: () => number } = {}): SessionDto | null {
  const r = db.prepare(`${SESSION_SELECT} and s.id = ?`).get(id) as SessionRow | undefined;
  return r ? toSessionDto(r, liveMapOf(live), lockMap(db, opts.deviceId, opts.now ? opts.now() : Date.now())) : null;
}

/** Settings の端末一覧。最終確認の新しい順で、自端末に印を付ける。 */
export function listDevices(db: Db, selfId: string): DeviceDto[] {
  const rows = db.prepare('select id, name, platform, last_seen_at from devices where deleted_at is null order by last_seen_at desc nulls last, name')
    .all() as { id: string; name: string; platform: string; last_seen_at: number | null }[];
  return rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform, lastSeenAt: r.last_seen_at, self: r.id === selfId }));
}

/** projects にこの端末の project_roots と最終活動を左結合した 1 行。 */
type ProjectRow = {
  id: string;
  name: string;
  status: ProjectDto['status'];
  is_scratch: number;
  updated_at: number;
  path: string | null;
  resolved: number | null;
  last_activity_at: number | null;
  open_todos: number;
  memo_markdown: string | null;
};

const PROJECT_SELECT = `
select p.id, p.name, p.status, p.is_scratch, p.updated_at, r.path, r.resolved,
  (select max(s.last_activity_at) from sessions s where s.project_id = p.id and s.deleted_at is null) last_activity_at,
  (select count(*) from todos t where t.project_id = p.id and t.done = 0 and t.deleted_at is null) open_todos,
  (select m.markdown from project_memos m where m.project_id = p.id and m.deleted_at is null) memo_markdown
from projects p
left join project_roots r on r.project_id = p.id and r.device_id = ? and r.deleted_at is null
where p.deleted_at is null`;

/** メモの先頭。空行でない最初の行の先頭 80 字。 */
export function memoHead(markdown: string | null): string | null {
  if (!markdown) return null;
  const line = markdown.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line ? [...line].slice(0, 80).join('') : null;
}

function toProjectDto(r: ProjectRow, db: Db, liveIds: Set<string>): ProjectDto {
  const psids = (db.prepare('select provider_session_id p from sessions where project_id = ? and deleted_at is null').all(r.id) as { p: string }[]).map((x) => x.p);
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    isScratch: r.is_scratch === 1,
    path: r.path,
    resolved: r.resolved === 1,
    lastActivityAt: r.last_activity_at,
    runningCount: psids.filter((p) => liveIds.has(p)).length,
    openTodoCount: r.open_todos,
    memoHead: memoHead(r.memo_markdown),
    updatedAt: r.updated_at,
  };
}

/**
 * プロジェクト一覧。
 * 最終活動の降順で、null は末尾に置き、同順位は名前順。
 */
export function listProjects(db: Db, deviceId: string, live: LiveSessionDto[]): ProjectDto[] {
  const rows = db.prepare(`${PROJECT_SELECT} order by last_activity_at desc nulls last, p.name`).all(deviceId) as ProjectRow[];
  const liveIds = new Set(live.map((l) => l.sessionId));
  return rows.map((r) => toProjectDto(r, db, liveIds));
}

export function getProject(db: Db, deviceId: string, live: LiveSessionDto[], id: string): ProjectDto | null {
  const r = db.prepare(`${PROJECT_SELECT} and p.id = ?`).get(deviceId, id) as ProjectRow | undefined;
  return r ? toProjectDto(r, db, new Set(live.map((l) => l.sessionId))) : null;
}
