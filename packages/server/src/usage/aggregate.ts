import type { UsageAggregateDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** ミリ秒の時刻をローカル時刻の YYYY-MM-DD にする。 */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** jsonl の usage から導いたトークン数を、日別とプロジェクト別に束ねる。副情報なので推定コストは statusline の値の和だけを出す。 */
export function aggregateUsage(db: Db, opts: { days: number; now?: number }): UsageAggregateDto {
  const now = opts.now ?? Date.now();
  const since = localDay(now - (opts.days - 1) * 86_400_000);
  const days = (db.prepare('select day, sum(input_tokens) i, sum(output_tokens) o, count(distinct session_id) n from usage_daily where day >= ? group by day order by day desc').all(since) as { day: string; i: number; o: number; n: number }[])
    .map((r) => ({ day: r.day, inputTokens: r.i, outputTokens: r.o, sessions: r.n }));
  const projects = (db.prepare(`
    select s.project_id pid, p.name name, sum(st.input_tokens) i, sum(st.output_tokens) o, count(*) n,
      sum(ls.cost_usd) cost, count(ls.cost_usd) cost_n
    from sessions s
    join session_stats st on st.session_id = s.id
    left join projects p on p.id = s.project_id
    left join session_live_stats ls on ls.provider_session_id = s.provider_session_id
    where s.deleted_at is null
    group by s.project_id
    order by i desc`).all() as { pid: string | null; name: string | null; i: number; o: number; n: number; cost: number | null; cost_n: number }[])
    .map((r) => ({ projectId: r.pid, name: r.name ?? '未分類', inputTokens: r.i, outputTokens: r.o, costUsd: r.cost_n > 0 ? r.cost : null, sessions: r.n }));
  return { days, projects };
}
