import type { AgentKind, SessionLaunchSettingsDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { accountOfSession } from '../db/queries.ts';

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * 「複製」の新規ダイアログに入れる値（GET /api/sessions/:id/launch-settings）。
 * 再開の run には指定が無いので、新しい run から順に見て、最初に指定のあった run の値を採る。
 * 本文（prompt）と worktree は引き継がない。アカウントは PC ごとの設定なので、この PC の run からだけ読む。
 */
export function launchSettingsOf(db: Db, deviceId: string, sessionId: string): SessionLaunchSettingsDto | null {
  const session = db.prepare('select provider from sessions where id = ? and deleted_at is null').get(sessionId) as { provider: AgentKind } | undefined;
  if (!session) return null;
  const out: SessionLaunchSettingsDto = { agent: session.provider, model: null, effort: null, permissionMode: null, mode: null, addDirs: [], account: accountOfSession(db, sessionId, deviceId) };
  const rows = db.prepare('select launch_params from runs where session_id = ? and deleted_at is null order by started_at desc, id desc').all(sessionId) as { launch_params: string | null }[];
  for (const r of rows) {
    let p: Record<string, unknown> | null = null;
    try { p = JSON.parse(r.launch_params ?? 'null') as Record<string, unknown> | null; } catch { continue; }
    if (p === null || typeof p !== 'object') continue;
    const addDirs = Array.isArray(p.addDirs) ? p.addDirs.filter((d): d is string => typeof d === 'string') : [];
    const found = { model: text(p.model), effort: text(p.effort), permissionMode: text(p.permissionMode), mode: text(p.mode), addDirs };
    if (found.model === null && found.effort === null && found.permissionMode === null && found.mode === null && addDirs.length === 0) continue;
    return { ...out, ...found };
  }
  return out;
}
