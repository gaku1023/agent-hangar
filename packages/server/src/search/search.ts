import { toFtsQuery, type SearchHitDto, type SearchParamsDto, type SearchResultDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SNIPPETS_PER_HIT = 3;

/** like の部分一致に使う文字列を作る。ワイルドカードと逃げ文字は逃がす。 */
function likePattern(s: string): string {
  return '%' + s.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
}

/**
 * event_fts を全文検索し、session_id ごとに件数と抜粋をまとめて返す。
 * 検索語は toFtsQuery でトークンごとに二重引用符で包み、複数語は AND になる。
 * running の判定は DB に無いので、実行中の provider_session_id の集合を第三引数で受ける。
 */
export function searchSessions(db: Db, params: SearchParamsDto, runningIds: Set<string> = new Set()): SearchResultDto {
  const match = toFtsQuery(params.q);
  if (!match) return { hits: [], total: 0 };
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const where: string[] = ['f.text match ?', 's.deleted_at is null'];
  const args: unknown[] = [match];
  if (params.projectId) { where.push('s.project_id = ?'); args.push(params.projectId); }
  if (params.since !== undefined) { where.push('s.last_activity_at >= ?'); args.push(params.since); }
  if (params.until !== undefined) { where.push('s.last_activity_at < ?'); args.push(params.until); }
  if (params.file) {
    where.push("exists (select 1 from event_index e where e.session_id = s.id and e.file_path like ? escape '\\')");
    args.push(likePattern(params.file));
  }
  const sql = `select s.id sid, s.provider_session_id psid, count(*) n
    from event_fts f join sessions s on s.id = f.session_id
    where ${where.join(' and ')}
    group by s.id
    order by n desc, s.last_activity_at desc`;
  let rows = db.prepare(sql).all(...args) as { sid: string; psid: string; n: number }[];
  if (params.running !== undefined) rows = rows.filter((r) => runningIds.has(r.psid) === params.running);
  const total = rows.length;
  const snip = db.prepare(`select seq, role, snippet(event_fts, 4, '', '', '…', 12) text from event_fts where session_id = ? and text match ? limit ${SNIPPETS_PER_HIT}`);
  const hits: SearchHitDto[] = rows.slice(0, limit).map((r) => ({
    sessionId: r.sid,
    matchCount: r.n,
    snippets: snip.all(r.sid, match) as SearchHitDto['snippets'],
  }));
  return { hits, total };
}
