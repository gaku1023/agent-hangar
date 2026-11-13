import { randomUUID } from 'node:crypto';
import type { AutoApprovalDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

/**
 * 統括が許可の方針に沿って自分で出した許可の記録（手元だけの表 auto_approvals、版 59）。
 * 書いてからキーを打ち、打てなければ消す（orchestrator/asks.ts）。記録の無い自動の許可を残さない。
 */

/** 道具の主な引数を残す長さの上限（文字）。 */
export const AUTO_APPROVAL_INPUT_MAX = 2000;
/** 記録を残す長さ。これより古い行は書くときに捨てる。 */
export const AUTO_APPROVAL_KEEP_MS = 90 * 86_400_000;
/** 一覧の既定と上限の件数。 */
export const AUTO_APPROVAL_LIST_DEFAULT = 20;
export const AUTO_APPROVAL_LIST_MAX = 200;

type Row = { id: string; at: number; session_id: string; title: string; tool: string; input: string; label: string; reason: string; policy_text: string | null };

/** 1 行書いて id を返す。書けなければ投げる（呼び手は打たない）。 */
export function insertAutoApproval(db: Db, a: Omit<AutoApprovalDto, 'id'>): string {
  const id = randomUUID();
  db.prepare('delete from auto_approvals where at < ?').run(a.at - AUTO_APPROVAL_KEEP_MS);
  db.prepare('insert into auto_approvals (id, at, session_id, title, tool, input, label, reason, policy_text) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, a.at, a.sessionId, a.title, a.tool, a.input.slice(0, AUTO_APPROVAL_INPUT_MAX), a.label, a.reason, a.policyText);
  return id;
}

/** 打てなかった答えの行を消す。 */
export function deleteAutoApproval(db: Db, id: string): void {
  db.prepare('delete from auto_approvals where id = ?').run(id);
}

/** 新しい順の記録。since（ミリ秒）より前の行は含めない。 */
export function listAutoApprovals(db: Db, o: { limit?: number; since?: number }): AutoApprovalDto[] {
  const limit = Math.min(Math.max(Math.floor(o.limit ?? AUTO_APPROVAL_LIST_DEFAULT), 1), AUTO_APPROVAL_LIST_MAX);
  const rows = db.prepare('select * from auto_approvals where at >= ? order by at desc, rowid desc limit ?').all(o.since ?? 0, limit) as Row[];
  return rows.map((r) => ({ id: r.id, at: r.at, sessionId: r.session_id, title: r.title, tool: r.tool, input: r.input, label: r.label, reason: r.reason, policyText: r.policy_text }));
}
