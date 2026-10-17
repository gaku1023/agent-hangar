import path from 'node:path';
import { isSafeKeyId } from '@agent-hangar/shared';

/**
 * 手元の台帳（file_sync）と、上げるのを諦めた控え（sync_state の `skipped:`）の鍵。
 *
 * この PC の DB の中だけで使い、Worker と R2 には出さない。
 * R2 の鍵名は e2e/names.ts の transcriptBlobKey（HMAC）で、世代ごとに変わるので台帳の鍵には使えない。
 * 形は版 8 までの R2 の鍵名と同じにしてある。
 * 引き継ぎ（sync/takeover.ts）、再開の写し（sync/copy.ts）、削除（sessions/trash.ts）が、台帳をこの形で引くからである。
 *
 * ID は他端末から届いた値が混ざる経路があるので、組み立ての側でも形を検査する。
 * 検査が無いと、スラッシュ入りのセッション ID がサブエージェントの鍵と衝突する。
 */
export function transcriptLedgerKey(deviceId: string, sessionUuid: string, agentId: string | null): string {
  if (!isSafeKeyId(deviceId)) throw new Error('invalid device id');
  if (!isSafeKeyId(sessionUuid)) throw new Error('invalid session id');
  if (agentId !== null && !isSafeKeyId(agentId)) throw new Error('invalid subagent id');
  return agentId === null ? `transcripts/${deviceId}/${sessionUuid}.jsonl.gz` : `transcripts/${deviceId}/${sessionUuid}/subagents/agent-${agentId}.jsonl.gz`;
}

/**
 * 写しの相対パス（`projects/<フォルダ>/` の下）から、台帳の鍵を求める。形が違えば null。
 * 上げる側の transcriptLedgerKey と同じ鍵になる（`<uuid>.jsonl` は `<uuid>.jsonl.gz` に、サブエージェントはその下に）。
 */
export function ledgerKeyOfPath(deviceId: string, rel: string): string | null {
  if (!isSafeKeyId(deviceId)) return null;
  const parts = path.posix.normalize(rel).split('/');
  const suffix = parts.slice(2).join('/');
  if (parts[0] !== 'projects' || parts.length < 3 || suffix === '' || parts.includes('..')) return null;
  return `transcripts/${deviceId}/${suffix}.gz`;
}
