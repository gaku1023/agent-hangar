import type { Db } from '../../db/open.ts';
import { readPeerStatuses } from '../../config/deviceStatus.ts';
import { aliveRunForSession } from '../../runs/queries.ts';
import { dbTranscriptReader, transcriptTail } from './tail.ts';
import type { ViewResolve } from './viewer.ts';

/**
 * 画面が開いた会話の、相手の PC を決める（見る側の PC が使う。peer/chat/viewer.ts の resolve）。
 * 決め方は次の順で、最初に当たったものを採る。
 * 1. ほかの PC に、止まっていない run がある（実行中。古い PC の run は数えない）。
 * その PC。
 * この PC の run なら not-remote。
 * 2. 止まっているときは、最後の run の PC。
 * この PC なら not-remote。
 * 3. run の記録が無くても、ほかの PC から降ろした本文の写しがあれば、その PC。
 * なければ not-remote。
 * 対象は Claude Code の会話だけである（Codex と opencode は今の画面のまま）。
 */
export function resolveViewTarget(db: Db, selfId: string, sessionId: string, now: number): ViewResolve {
  const s = db.prepare('select provider from sessions where id = ? and deleted_at is null').get(sessionId) as { provider: string } | undefined;
  if (!s) return { ok: false, reason: 'session-unknown' };
  if (s.provider !== 'claude-code') return { ok: false, reason: 'not-claude' };
  const alive = aliveRunForSession(db, sessionId, selfId, now);
  let device: string | null = alive?.deviceId ?? null;
  if (!alive) {
    const last = db.prepare('select device_id from runs where session_id = ? and deleted_at is null order by started_at desc limit 1').get(sessionId) as { device_id: string } | undefined;
    device = last?.device_id ?? null;
    if (device === null) {
      const copy = db.prepare("select device_id from transcript_files where session_id = ? and agent_id is null and device_id is not null and agent = 'claude-code' order by mtime desc limit 1").get(sessionId) as { device_id: string } | undefined;
      device = copy?.device_id ?? null;
    }
  }
  if (device === null || device === selfId) return { ok: false, reason: 'not-remote' };
  const peer = readPeerStatuses(db, selfId).find((p) => p.device_id === device);
  if (!peer) return { ok: false, reason: 'device-unknown' };
  return { ok: true, target: { deviceId: peer.device_id, deviceName: peer.name, hangarVersion: peer.status?.hangar_version ?? null, outdated: peer.outdated } };
}

/**
 * 手元に降ろした本文の写しの、最後の項目の uuid（tail の after に渡す。元の PC の transcriptTail と同じ数え方）。
 * 写しが無い、読めない、項目が無いときは null（元の PC から頭に近いところを取る）。
 */
export function localCursorOf(db: Db, sessionId: string): string | null {
  try {
    return transcriptTail(sessionId, null, 1, { readTranscript: dbTranscriptReader(db, { copies: true }), pendingAsk: () => null }).cursor;
  } catch {
    return null;
  }
}
