import path from 'node:path';
import { isSafeKeyId } from '@agent-hangar/shared';
import type { AgentKind } from '../agent/types.ts';
import { agentOfSyncPath, AGENT_SYNC } from './agentSync.ts';

// 鍵の組み立ては agentSync.ts の表にある（エージェントごとの「同期の単位」）。ここは従来の名前の入口である。
export { opencodeSessionOfPath, opencodeSyncPath, transcriptLedgerKey } from './agentSync.ts';

/**
 * 手元の台帳（file_sync）と、上げるのを諦めた控え（sync_state の `skipped:`）の鍵。
 * この PC の DB の中だけで使い、Worker と R2 には出さない。
 * R2 の鍵名は e2e/names.ts の blobKey 系（HMAC）で、世代ごとに変わるので台帳の鍵には使えない。
 * 形は版 8 までの R2 の鍵名と同じにしてある。
 * 引き継ぎ（sync/takeover.ts）、再開の写し（sync/copy.ts）、削除（sessions/trash.ts）が、台帳をこの形で引くからである。
 */

/** 本文の台帳の鍵を、エージェントの種類ごとに求める（AGENT_SYNC[provider].ledgerKey）。Claude の鍵は 1 字も変えない。 */
export function ledgerKeyFor(provider: AgentKind, deviceId: string, sessionId: string, agentId: string | null): string {
  return AGENT_SYNC[provider].ledgerKey(deviceId, sessionId, agentId);
}

/**
 * 写しの相対パス（`projects/<フォルダ>/` の下か、専用の形の `opencode/<会話>.json`）から、台帳の鍵を求める。形が違えば null。
 * 上げる側の ledgerKeyFor と同じ鍵になる（Claude は `<uuid>.jsonl` が `<uuid>.jsonl.gz` に、サブエージェントはその下に）。
 */
export function ledgerKeyOfPath(deviceId: string, rel: string): string | null {
  if (!isSafeKeyId(deviceId)) return null;
  const own = agentOfSyncPath(rel);
  if (own !== null) return ledgerKeyFor(own.provider, deviceId, own.sessionId, null);
  const parts = path.posix.normalize(rel).split('/');
  const suffix = parts.slice(2).join('/');
  if (parts[0] !== 'projects' || parts.length < 3 || suffix === '' || parts.includes('..')) return null;
  return `transcripts/${deviceId}/${suffix}.gz`;
}
