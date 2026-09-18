import type { LiveSessionDto, ProjectDto, SessionDto, SessionStatsDto, SessionSummaryDto } from '@agent-hangar/shared';
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
  sum_title: string | null;
  sum_one: string | null;
  sum_body: string | null;
  sum_state: SessionSummaryDto['state'] | null;
  sum_next: string | null;
  sum_source: SessionSummaryDto['source'] | null;
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
};

const SESSION_SELECT = `
select s.*, exists(select 1 from transcript_files t where t.session_id = s.id and t.agent_id is null) has_transcript,
  m.title sum_title, m.one_liner sum_one, m.body sum_body, m.state sum_state, m.next_steps sum_next, m.source sum_source, m.source_model sum_model, m.based_on_turns sum_turns, m.updated_at sum_updated,
  st.turns st_turns, st.model st_model, st.effort st_effort, st.files_changed st_files, st.pr_url st_pr, st.input_tokens st_in, st.output_tokens st_out
from sessions s
left join session_summaries m on m.session_id = s.id and m.deleted_at is null
left join session_stats st on st.session_id = s.id
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

function toSessionDto(r: SessionRow, liveMap: Map<string, LiveSessionDto>): SessionDto {
  const live = liveMap.get(r.provider_session_id);
  const summary: SessionSummaryDto | null = r.sum_title !== null
    ? {
        title: r.sum_title,
        oneLiner: r.sum_one ?? '',
        body: r.sum_body ?? '',
        state: r.sum_state ?? 'done',
        nextSteps: parseNextSteps(r.sum_next),
        source: r.sum_source ?? 'baseline',
        sourceModel: r.sum_model,
        basedOnTurns: r.sum_turns ?? 0,
        updatedAt: r.sum_updated ?? 0,
      }
    : null;
  const stats: SessionStatsDto = {
    turns: r.st_turns ?? 0,
    model: r.st_model,
    effort: r.st_effort,
    filesChanged: r.st_files ?? 0,
    prUrl: r.st_pr,
    inputTokens: r.st_in ?? 0,
    outputTokens: r.st_out ?? 0,
    // 文脈の残りと費用は Task 2 で列が入るまで null にする。
    contextPercent: null,
    costUsd: null,
  };
  return {
    id: r.id,
    provider: r.provider,
    providerSessionId: r.provider_session_id,
    projectId: r.project_id,
    name: displayName(r, live),
    cwd: r.cwd,
    fromScratch: false,
    firstPrompt: r.first_prompt,
    aiTitle: r.ai_title,
    startedAt: r.started_at,
    lastActivityAt: r.last_activity_at,
    memo: r.memo,
    hasTranscript: r.has_transcript === 1,
    live: live?.status ?? null,
    summary,
    stats,
  };
}

/** live レジストリを provider のセッション UUID で引けるようにする。 */
const liveMapOf = (live: LiveSessionDto[]) => new Map(live.map((l) => [l.sessionId, l]));

/**
 * セッション一覧。
 * last_activity_at の降順で、null は末尾に置く。
 */
export function listSessions(db: Db, live: LiveSessionDto[], opts: { projectId?: string; ids?: string[] } = {}): SessionDto[] {
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
  return rows.map((r) => toSessionDto(r, lm));
}

export function getSession(db: Db, live: LiveSessionDto[], id: string): SessionDto | null {
  const r = db.prepare(`${SESSION_SELECT} and s.id = ?`).get(id) as SessionRow | undefined;
  return r ? toSessionDto(r, liveMapOf(live)) : null;
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
};

const PROJECT_SELECT = `
select p.id, p.name, p.status, p.is_scratch, p.updated_at, r.path, r.resolved,
  (select max(s.last_activity_at) from sessions s where s.project_id = p.id and s.deleted_at is null) last_activity_at
from projects p
left join project_roots r on r.project_id = p.id and r.device_id = ? and r.deleted_at is null
where p.deleted_at is null`;

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
    openTodoCount: 0,
    memoHead: null,
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
