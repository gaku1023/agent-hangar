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
  // 論理削除したセッションはプロジェクト別でも数えないので、日別でも同じように外す。
  const days = (db.prepare(`
    select u.day day, sum(u.input_tokens) i, sum(u.output_tokens) o, count(distinct u.session_id) n
    from usage_daily u
    join sessions s on s.id = u.session_id
    where u.day >= ? and s.deleted_at is null
    group by u.day order by u.day desc`).all(since) as { day: string; i: number; o: number; n: number }[])
    .map((r) => ({ day: r.day, inputTokens: r.i, outputTokens: r.o, sessions: r.n }));
  // プロジェクト別も日別と同じ窓、同じ供給源（usage_daily）で束ねる。
  // session_stats の全期間の和を使うと、同じ画面に並ぶ 2 つの合計が突き合わせられない。
  // 先にセッションごとにまとめてから束ねるのは、推定コストをセッション 1 件につき一度だけ足すためである。
  const projects = (db.prepare(`
    with win as (
      select u.session_id sid, sum(u.input_tokens) i, sum(u.output_tokens) o
      from usage_daily u
      join sessions s on s.id = u.session_id
      where u.day >= ? and s.deleted_at is null
      group by u.session_id
    )
    select s.project_id pid, p.name name, sum(w.i) i, sum(w.o) o, count(*) n,
      sum(ls.cost_usd) cost, count(ls.cost_usd) cost_n
    from win w
    join sessions s on s.id = w.sid
    left join projects p on p.id = s.project_id
    left join session_live_stats ls on ls.provider_session_id = s.provider_session_id
    group by s.project_id
    order by i desc`).all(since) as { pid: string | null; name: string | null; i: number; o: number; n: number; cost: number | null; cost_n: number }[])
    .map((r) => ({ projectId: r.pid, name: r.name ?? '未分類', inputTokens: r.i, outputTokens: r.o, costUsd: r.cost_n > 0 ? r.cost : null, sessions: r.n }));
  return { days, projects };
}
