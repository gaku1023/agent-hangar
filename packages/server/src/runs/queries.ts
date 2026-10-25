import { AGENT_LABEL, type EndReason, type RunDto, type RunKind, type TabDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { peerStale, readPeers, type PeerBook } from '../sync/peers.ts';

export type RunRow = { id: string; session_id: string; device_id: string; kind: RunKind; tmux_name: string; pid: number | null; launch_params: string; started_at: number; ended_at: number | null; end_reason: EndReason | null; heartbeat_at: number };
type TabRow = { id: string; run_id: string; tmux_name: string; title: string | null; created_at: number; closed_at: number | null };

/** 起動のときの launch_params に入っている権限モード。無い、空、文字列でない、JSON が壊れている、のどれも null。 */
function permissionModeIn(launchParams: string | null): string | null {
  if (!launchParams) return null;
  try {
    const v = (JSON.parse(launchParams) as { permissionMode?: unknown } | null)?.permissionMode;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function toRunDto(r: RunRow): RunDto {
  const permissionMode = permissionModeIn(r.launch_params);
  return { id: r.id, sessionId: r.session_id, deviceId: r.device_id, kind: r.kind, tmuxName: r.tmux_name, pid: r.pid, startedAt: r.started_at, endedAt: r.ended_at, endReason: r.end_reason, heartbeatAt: r.heartbeat_at, ...(permissionMode ? { permissionMode } : {}) };
}

const RUN_SELECT = 'select * from runs where deleted_at is null';

export function getRun(db: Db, id: string): RunDto | null {
  const r = db.prepare(`${RUN_SELECT} and id = ?`).get(id) as RunRow | undefined;
  return r ? toRunDto(r) : null;
}

export function listAliveRuns(db: Db, deviceId: string): RunDto[] {
  return (db.prepare(`${RUN_SELECT} and ended_at is null and device_id = ? order by started_at`).all(deviceId) as RunRow[]).map(toRunDto);
}

/**
 * そのセッションをふさいでいる生きた run（起動の新しい方）。無ければ null。
 * 自分の PC（selfDeviceId）の run は、いつもふさいでいるとみなす。
 * 他の PC の run は、その PC が古い（pull の応答の peers で、年齢が PEER_STALE_MS を超えた、居ない、まだ受け取っていない）ならふさいでいるとみなさない（同期の版 6）。
 * 画面のロックの stale（db/queries.ts の lockMap）と同じ判定なので、「応答がありません」と出ている run は、再開もフォークも止めない。
 */
export function aliveRunForSession(db: Db, sessionId: string, selfDeviceId: string, now: number = Date.now()): RunDto | null {
  const rows = db.prepare(`${RUN_SELECT} and ended_at is null and session_id = ? order by started_at desc, id desc`).all(sessionId) as RunRow[];
  let peers: PeerBook | null | undefined;
  for (const r of rows) {
    if (r.device_id === selfDeviceId) return toRunDto(r);
    if (peers === undefined) peers = readPeers(db);
    if (!peerStale(peers, r.device_id, now)) return toRunDto(r);
  }
  return null;
}

/** その端末のそのセッションの run のうち、最も新しく起きたもの（終わったものも含める）。 */
export function latestRunForSession(db: Db, sessionId: string, deviceId: string): RunDto | null {
  const r = db.prepare(`${RUN_SELECT} and session_id = ? and device_id = ? order by started_at desc limit 1`).get(sessionId, deviceId) as RunRow | undefined;
  return r ? toRunDto(r) : null;
}

/** 生きた run と、終了したが開いたシェルタブが残る run。シェルタブは Claude が終了しても残るので、UI のタブ列はこれを使う。 */
export function listActiveRuns(db: Db, deviceId: string): RunDto[] {
  const sql = `${RUN_SELECT} and device_id = ? and (ended_at is null or exists (select 1 from run_tabs t where t.run_id = runs.id and t.closed_at is null and t.deleted_at is null)) order by started_at`;
  return (db.prepare(sql).all(deviceId) as RunRow[]).map(toRunDto);
}

/**
 * タブ 0 はエージェントの tmux セッションそのもので、run_tabs に行を持たない。
 * 題は会話のエージェント（sessions.provider）で決める。opencode は画面のタブ（presenters/session.ts）と同じ「opencode」、それ以外は今どおり「Claude」。
 */
function agentTab(db: Db, r: RunRow): TabDto {
  const s = db.prepare('select provider from sessions where id = ?').get(r.session_id) as { provider: string } | undefined;
  const title = s?.provider === 'opencode' ? AGENT_LABEL.opencode : 'Claude';
  return { id: r.id, runId: r.id, sessionId: r.session_id, kind: 'agent', title, tmuxName: r.tmux_name, createdAt: r.started_at, closedAt: null };
}

function shellTab(t: TabRow, r: RunRow): TabDto {
  return { id: t.id, runId: t.run_id, sessionId: r.session_id, kind: 'shell', title: t.title ?? 'シェル', tmuxName: t.tmux_name, createdAt: t.created_at, closedAt: t.closed_at };
}

/** agent タブを先頭に、閉じていないシェルタブを作成順で返す。 */
export function listTabs(db: Db, runId: string): TabDto[] {
  const r = db.prepare(`${RUN_SELECT} and id = ?`).get(runId) as RunRow | undefined;
  if (!r) return [];
  const rows = db.prepare('select * from run_tabs where run_id = ? and closed_at is null and deleted_at is null order by created_at').all(runId) as TabRow[];
  return [agentTab(db, r), ...rows.map((t) => shellTab(t, r))];
}

/** run の id なら agent タブ。閉じたタブと消えた run は null。 */
export function getTab(db: Db, tabId: string): TabDto | null {
  const r = db.prepare(`${RUN_SELECT} and id = ?`).get(tabId) as RunRow | undefined;
  if (r) return agentTab(db, r);
  const t = db.prepare('select * from run_tabs where id = ? and closed_at is null and deleted_at is null').get(tabId) as TabRow | undefined;
  if (!t) return null;
  const run = db.prepare(`${RUN_SELECT} and id = ?`).get(t.run_id) as RunRow | undefined;
  return run ? shellTab(t, run) : null;
}
