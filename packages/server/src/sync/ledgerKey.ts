import path from 'node:path';
import { isSafeKeyId } from '@agent-hangar/shared';
import type { AgentKind } from '../agent/types.ts';

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
 * 本文の台帳の鍵を、エージェントの種類ごとに求める。
 * Claude は transcriptLedgerKey そのもので、鍵は 1 字も変えない（上げた本文の台帳を引き直せなくなる）。
 * opencode は `opencode/<端末>/<会話>.json.gz` で、Claude の `transcripts/` と頭で分ける（台帳を引く問い合わせが混ざらない）。
 * opencode は子の会話（サブエージェント）も親の書き出しに入るので、サブエージェントの鍵は無い。
 */
export function ledgerKeyFor(provider: AgentKind, deviceId: string, sessionId: string, agentId: string | null): string {
  if (provider === 'claude-code') return transcriptLedgerKey(deviceId, sessionId, agentId);
  if (!isSafeKeyId(deviceId)) throw new Error('invalid device id');
  if (!isSafeKeyId(sessionId)) throw new Error('invalid session id');
  if (agentId !== null) throw new Error('opencode has no separate subagent transcripts');
  return `opencode/${deviceId}/${sessionId}.json.gz`;
}

/**
 * opencode の本文の写しの相対パス（封じたメタの path）。`projects/` の外に置く。
 * `projects/` の下に置くと、opencode を知らない版の PC が Claude の本文として取り込んでしまうからである（E1 で確かめた）。
 */
export function opencodeSyncPath(sessionId: string): string {
  if (!isSafeKeyId(sessionId)) throw new Error('invalid session id');
  return `opencode/${sessionId}.json`;
}

/** 封じたメタの path が opencode の本文の写しなら、その会話の ID を返す。違えば null。 */
export function opencodeSessionOfPath(rel: string): string | null {
  const m = /^opencode\/([^/]+)\.json$/.exec(rel);
  return m && isSafeKeyId(m[1]!) ? m[1]! : null;
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
