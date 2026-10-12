import { limitReset, stopReasonOf, type LimitKind, type LiveSessionDto, type SessionLimitDto, type StopReason } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

/**
 * 一覧の多くのセッションについて、止まっている理由（shared の stopReasonOf）を引く関数を作る。
 * 検索の絞り込み（is:permission、is:limited）と、入力待ちの数え方（リセット済みを入力待ちに数える）に使う。
 * 手元の表（session_activity、session_limits）を 1 回ずつ読んで、Claude のセッションの id で引けるようにしておく。
 */
export function stopReasonsOf(db: Db, live: readonly LiveSessionDto[], now: number): { reason(providerSessionId: string): StopReason | null; limit(providerSessionId: string): SessionLimitDto | null } {
  const liveOf = new Map(live.map((l) => [l.sessionId, l]));
  const acts = new Map((db.prepare('select s.provider_session_id psid, a.tool, a.question from session_activity a join sessions s on s.id = a.session_id').all() as { psid: string; tool: string; question: string | null }[]).map((r) => [r.psid, r]));
  const lims = new Map((db.prepare('select s.provider_session_id psid, l.kind, l.resets_at, l.auto from session_limits l join sessions s on s.id = l.session_id').all() as { psid: string; kind: LimitKind; resets_at: number; auto: number }[]).map((r) => [r.psid, r]));
  const limit = (psid: string): SessionLimitDto | null => {
    const r = lims.get(psid);
    return r && liveOf.has(psid) ? { kind: r.kind, resetsAt: r.resets_at, auto: r.auto === 1, reset: limitReset(r.resets_at, now, r.auto === 1) } : null;
  };
  return {
    limit,
    reason(psid) {
      const l = liveOf.get(psid);
      if (!l) return null;
      const a = acts.get(psid);
      return stopReasonOf({ live: l.status, waitingFor: l.waitingFor ?? null, permission: l.permission ?? null, activity: a ? { tool: a.tool, summary: '', question: a.question } : null, limit: limit(psid) });
    },
  };
}
