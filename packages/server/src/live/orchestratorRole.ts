import type { LiveSessionDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

/**
 * 実行中の一覧のうち、統括の会話に role: 'orchestrator' を足す足し付け（agent/liveHub.ts の LiveEnrich の前段）。
 * 設定の orchestrator.sessionId は hangar の会話の id で、一覧の sessionId は Claude の id なので、sessions の行で引き合わせる。
 * 統括は Claude Code の会話だけである。付ける物が無ければ同じ配列を返す。
 */
export function markOrchestrator(db: Db, orchestratorId: () => string | null): (live: LiveSessionDto[]) => LiveSessionDto[] {
  return (live) => {
    const id = orchestratorId();
    if (id === null || live.length === 0) return live;
    const row = db.prepare("select provider_session_id as p from sessions where id = ? and provider = 'claude-code' and deleted_at is null").get(id) as { p: string } | undefined;
    if (!row || !live.some((l) => l.sessionId === row.p && l.agent === undefined)) return live;
    return live.map((l) => (l.sessionId === row.p && l.agent === undefined ? { ...l, role: 'orchestrator' as const } : l));
  };
}
