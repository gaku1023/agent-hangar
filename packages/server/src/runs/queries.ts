import type { EndReason, RunDto, RunKind, TabDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

export type RunRow = { id: string; session_id: string; device_id: string; kind: RunKind; tmux_name: string; pid: number | null; launch_params: string; started_at: number; ended_at: number | null; end_reason: EndReason | null; heartbeat_at: number };
type TabRow = { id: string; run_id: string; tmux_name: string; title: string | null; created_at: number; closed_at: number | null };

export function toRunDto(r: RunRow): RunDto {
  return { id: r.id, sessionId: r.session_id, deviceId: r.device_id, kind: r.kind, tmuxName: r.tmux_name, pid: r.pid, startedAt: r.started_at, endedAt: r.ended_at, endReason: r.end_reason, heartbeatAt: r.heartbeat_at };
}

const RUN_SELECT = 'select * from runs where deleted_at is null';

export function getRun(db: Db, id: string): RunDto | null {
  const r = db.prepare(`${RUN_SELECT} and id = ?`).get(id) as RunRow | undefined;
  return r ? toRunDto(r) : null;
}

export function listAliveRuns(db: Db, deviceId: string): RunDto[] {
  return (db.prepare(`${RUN_SELECT} and ended_at is null and device_id = ? order by started_at`).all(deviceId) as RunRow[]).map(toRunDto);
}

export function aliveRunForSession(db: Db, sessionId: string): RunDto | null {
  const r = db.prepare(`${RUN_SELECT} and ended_at is null and session_id = ? order by started_at desc limit 1`).get(sessionId) as RunRow | undefined;
  return r ? toRunDto(r) : null;
}

/** 生きた run と、終了したが開いたシェルタブが残る run。シェルタブは Claude が終了しても残るので、UI のタブ列はこれを使う。 */
export function listActiveRuns(db: Db, deviceId: string): RunDto[] {
  const sql = `${RUN_SELECT} and device_id = ? and (ended_at is null or exists (select 1 from run_tabs t where t.run_id = runs.id and t.closed_at is null and t.deleted_at is null)) order by started_at`;
  return (db.prepare(sql).all(deviceId) as RunRow[]).map(toRunDto);
}

/** タブ 0 は Claude の tmux セッションそのもので、run_tabs に行を持たない。 */
function agentTab(r: RunRow): TabDto {
  return { id: r.id, runId: r.id, sessionId: r.session_id, kind: 'agent', title: 'Claude', tmuxName: r.tmux_name, createdAt: r.started_at, closedAt: null };
}

function shellTab(t: TabRow, r: RunRow): TabDto {
  return { id: t.id, runId: t.run_id, sessionId: r.session_id, kind: 'shell', title: t.title ?? 'シェル', tmuxName: t.tmux_name, createdAt: t.created_at, closedAt: t.closed_at };
}

/** agent タブを先頭に、閉じていないシェルタブを作成順で返す。 */
export function listTabs(db: Db, runId: string): TabDto[] {
  const r = db.prepare(`${RUN_SELECT} and id = ?`).get(runId) as RunRow | undefined;
  if (!r) return [];
  const rows = db.prepare('select * from run_tabs where run_id = ? and closed_at is null and deleted_at is null order by created_at').all(runId) as TabRow[];
  return [agentTab(r), ...rows.map((t) => shellTab(t, r))];
}

/** run の id なら agent タブ。閉じたタブと消えた run は null。 */
export function getTab(db: Db, tabId: string): TabDto | null {
  const r = db.prepare(`${RUN_SELECT} and id = ?`).get(tabId) as RunRow | undefined;
  if (r) return agentTab(r);
  const t = db.prepare('select * from run_tabs where id = ? and closed_at is null and deleted_at is null').get(tabId) as TabRow | undefined;
  if (!t) return null;
  const run = db.prepare(`${RUN_SELECT} and id = ?`).get(t.run_id) as RunRow | undefined;
  return run ? shellTab(t, run) : null;
}
