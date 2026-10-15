import type { InterruptCause, InterruptedDto, InterruptedItemDto, LiveStatus, RunDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

/**
 * 中断の群（ホームの帯の「前回実行中」）の置き場。端末ローカルの表 interrupted_runs と run_last_live を読み書きする。
 *
 * 中断は、利用者が止めたのではなく、PC の再起動や tmux のサーバの停止で Claude が終わったことである。
 * 群は最後に記録した 1 つの束で、新しい束を記録すると前の束は捨てる。前の束の行は、一覧の「中断」の印（最後の run が lost のもの）としてだけ残る。
 */

const LIVE: ReadonlySet<string> = new Set(['busy', 'idle', 'waiting']);
const liveOf = (v: string | null): LiveStatus | null => (v !== null && LIVE.has(v) ? (v as LiveStatus) : null);

/** 生きた run の最後の状態を覚える。同じ値なら書かない。 */
export function noteLastLive(db: Db, runId: string, status: LiveStatus, at: number): void {
  db.prepare(`insert into run_last_live (run_id, status, at) values (?, ?, ?)
    on conflict(run_id) do update set status = excluded.status, at = excluded.at where run_last_live.status <> excluded.status`).run(runId, status, at);
}

/** 生きた run のもの以外の最後の状態を捨てる。中断を記録した後と、run が終わった後に呼ぶ。 */
export function pruneLastLive(db: Db, aliveRunIds: string[]): void {
  if (aliveRunIds.length === 0) { db.prepare('delete from run_last_live').run(); return; }
  db.prepare(`delete from run_last_live where run_id not in (${aliveRunIds.map(() => '?').join(',')})`).run(...aliveRunIds);
}

/**
 * 中断の束を記録する。空の束では何もしない（前の群を残す）。
 * 新しい束は前の束を置き換える。止まる前の状態は run_last_live から写す。
 */
export function recordInterruption(db: Db, runs: RunDto[], cause: InterruptCause, at: number): void {
  if (runs.length === 0) return;
  const lastLive = db.prepare('select status from run_last_live where run_id = ?');
  const ins = db.prepare('insert into interrupted_runs (run_id, session_id, at, cause, last_live, dismissed_at) values (?, ?, ?, ?, ?, null)');
  db.transaction(() => {
    db.prepare('delete from interrupted_runs').run();
    for (const r of runs) ins.run(r.id, r.sessionId, at, cause, (lastLive.get(r.id) as { status: string } | undefined)?.status ?? null);
  })();
}

/**
 * 中断の束からその run を外す。外したら true を返す。
 * 閉じた run を、tmux の画面が残っていたので生き返らせたときに使う（RunManager の revive）。動いている run は中断ではない。
 */
export function forgetInterruption(db: Db, runId: string): boolean {
  return db.prepare('delete from interrupted_runs where run_id = ?').run(runId).changes > 0;
}

/** 「再開しない」の印を付ける（dismissed が真）か、元に戻す。 */
export function setInterruptedDismissed(db: Db, runIds: string[], dismissed: boolean, now: number): void {
  if (runIds.length === 0) return;
  db.prepare(`update interrupted_runs set dismissed_at = ? where run_id in (${runIds.map(() => '?').join(',')})`).run(dismissed ? now : null, ...runIds);
}

type GroupRow = { run_id: string; session_id: string; at: number; cause: InterruptCause; last_live: string | null; ended_at: number | null; launch_params: string | null };

const accountIn = (launchParams: string | null): string | null => {
  if (!launchParams) return null;
  try {
    const a = (JSON.parse(launchParams) as { account?: unknown } | null)?.account;
    return typeof a === 'string' && a ? a : null;
  } catch { return null; }
};

/**
 * 中断の群。再開しないと決めた行、その後に起こし直したセッション（最後の run がこの run でない）、消したセッションは含めない。
 * 残りが無ければ null である。ステータス（Paused、Done、Archived）で除くのは画面の側である（session.upsert で変わるので）。
 */
export function interruptedGroup(db: Db): InterruptedDto | null {
  const rows = db.prepare(`
    select i.run_id, i.session_id, i.at, i.cause, i.last_live, r.ended_at, r.launch_params
    from interrupted_runs i
    join runs r on r.id = i.run_id and r.deleted_at is null
    join sessions s on s.id = i.session_id and s.deleted_at is null
    where i.dismissed_at is null
      and not exists (select 1 from runs later where later.session_id = i.session_id and later.deleted_at is null and later.id <> i.run_id and later.started_at >= r.started_at)
    order by i.rowid`).all() as GroupRow[];
  if (rows.length === 0) return null;
  const items = rows.map((r): InterruptedItemDto => ({ sessionId: r.session_id, runId: r.run_id, lastLive: liveOf(r.last_live), endedAt: r.ended_at ?? r.at, account: accountIn(r.launch_params) }));
  return { at: rows[0]!.at, cause: rows[0]!.cause, items };
}
