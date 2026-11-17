import type { Db } from '../db/open.ts';

/**
 * 統括の会話を再開できるか（見張りの resumable）。行が消えていないことが前提。
 * Claude Code は hangar の本文の写し（transcript_files）があるときだけ再開する。run が早く終わって本文の無いまま残った行は、新しく起こす。
 * Codex（thread/resume）と opencode（serve の会話）は相手の側に会話があり、hangar の写しは要らない。相手の会話の id があれば再開する。
 * 写しで判定すると Codex と opencode は常に「消えた」になり、指定の変更や hangar の再起動のたびに新しい会話が起きていた。
 */
export function orchestratorResumable(db: Db, sessionId: string): boolean {
  const row = db.prepare('select provider, provider_session_id psid from sessions where id = ? and deleted_at is null').get(sessionId) as { provider: string; psid: string | null } | undefined;
  if (!row) return false;
  if (row.provider !== 'claude-code') return !!row.psid;
  return !!db.prepare('select 1 from transcript_files where session_id = ? and agent_id is null limit 1').get(sessionId);
}
