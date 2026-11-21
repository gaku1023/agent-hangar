import { RETENTION_SOON_DAYS, type SessionCountsDto, type SessionStatus } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

const DAY_MS = 86_400_000;

/**
 * 会話の件数の集計（SessionCountsDto）。
 * 画面が手元の全件（SessionDto）から数えていた値と同じになるよう、一覧の DTO（db/queries.ts の listSessions）と同じ読み方をする。
 * - 会話は消していないもの（deleted_at が null）。
 * - 状態は消していない session_states の行で、行が無いか status が null なら Active。
 * - 提案は states.ts の visibleCandidate と同じく、状態が無く、提案の時刻、状態、出どころがそろうもの。
 * - 本文の時刻は、この PC の主線の本文（transcript_files の agent_id と device_id が null）のいちばん新しい mtime（SessionDto.transcriptMtime）。
 * DTO を組まずに 1 回の問い合わせで数えるので、何千件あっても軽い。
 */
export function sessionCounts(db: Db, o: { retentionDays: number | null; now: number }): SessionCountsDto {
  const rows = db.prepare(`
select s.project_id p, s.provider prov, ss.status st,
  (ss.status is null and ss.candidate_at is not null and ss.candidate_status is not null and ss.candidate_source is not null) cand,
  (select max(t.mtime) from transcript_files t where t.session_id = s.id and t.agent_id is null and t.device_id is null) mt
from sessions s
left join session_states ss on ss.session_id = s.id and ss.deleted_at is null
where s.deleted_at is null`).all() as { p: string | null; prov: string; st: SessionStatus | null; cand: number | null; mt: number | null }[];
  const tabs: SessionCountsDto['tabs'] = { all: 0, proposed: 0, active: 0, paused: 0, done: 0, archived: 0 };
  const byProject: SessionCountsDto['byProject'] = {};
  const providers = { opencode: false, codex: false };
  const days = o.retentionDays;
  let soon = 0;
  let expired = 0;
  for (const r of rows) {
    if (r.st === null) tabs.active++;
    else if (r.st === 'paused' || r.st === 'done' || r.st === 'archived') tabs[r.st]++;
    if (r.st !== 'archived') tabs.all++;
    if (r.cand) tabs.proposed++;
    if (r.p !== null) {
      const p = byProject[r.p] ?? (byProject[r.p] = { count: 0, archived: 0 });
      p.count++;
      if (r.st === 'archived') p.archived++;
    }
    if (r.prov === 'opencode') providers.opencode = true;
    if (r.prov === 'codex') providers.codex = true;
    if (days !== null && r.mt !== null) {
      // 画面の isExpiringSoon と、保存期間を縮めたときの数え方（retentionDialog）と同じ。
      const expires = r.mt + days * DAY_MS;
      if (expires <= o.now + RETENTION_SOON_DAYS * DAY_MS) soon++;
      if (expires <= o.now) expired++;
    }
  }
  return { total: rows.length, tabs, byProject, providers, retention: days === null ? null : { days, soon, expired, at: o.now } };
}
