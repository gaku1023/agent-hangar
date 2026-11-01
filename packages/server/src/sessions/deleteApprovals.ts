import { randomUUID } from 'node:crypto';
import type { DeleteApprovalDto, DeleteApprovalFailure } from '@agent-hangar/shared';
import { touchRow } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { sessionTitleOf } from '../mobile/feed.ts';
import { DeleteError } from './trash.ts';

/**
 * MCP の delete_session の依頼を、利用者が答えるまで預かる（#547）。
 * 手元だけの表（delete_approvals）で、同期しない。依頼を受けた PC の画面と、その PC 宛てのスマホの操作でだけ答える。
 * 答える口は画面の HTTP とスマホの問い合わせだけで、MCP の道具には出さない（mcp/toolClasses.ts）。
 *
 * 状態は pending（待ち）、failed（承認したが消せなかった）、rejected（断った）の 3 つである。消せたら行を外す。
 * rejected の行は REJECT_HOLD_MS の間だけ残し、同じ会話への再度の依頼を断られたままにする。インジェクションされたエージェントが頼み続けても、利用者を煩わせないためである。
 */

/** 断った依頼を覚えておく長さ。過ぎれば同じ会話をまた頼める。 */
export const REJECT_HOLD_MS = 24 * 3_600_000;
/** 答えを待てる依頼の上限。超える依頼は積まない（帯が埋まらないように）。 */
export const PENDING_MAX = 20;

export type RequestOutcome = { outcome: 'pending'; id: string; created: boolean } | { outcome: 'rejected'; id: string } | { outcome: 'too_many' };
export type ApproveOutcome = 'deleted' | 'failed' | 'missing';

type Row = { id: string; session_id: string; from_session_id: string | null; requested_at: number; state: 'pending' | 'failed' | 'rejected'; decided_at: number | null; failure: DeleteApprovalFailure | null };

const TITLE_MAX = 80;
const clipTitle = (s: string): string => {
  const cs = [...s.replace(/\s+/g, ' ').trim()];
  return cs.length > TITLE_MAX ? `${cs.slice(0, TITLE_MAX - 1).join('')}…` : cs.join('');
};

const rowOf = (db: Db, id: string): Row | undefined => db.prepare('select * from delete_approvals where id = ?').get(id) as Row | undefined;

/** 依頼を預かる。同じ会話の行があれば増やさない。 */
export function requestDeleteApproval(db: Db, o: { sessionId: string; fromSessionId: string | null; now: number }): RequestOutcome {
  const cur = db.prepare('select * from delete_approvals where session_id = ?').get(o.sessionId) as Row | undefined;
  if (cur?.state === 'pending') return { outcome: 'pending', id: cur.id, created: false };
  if (cur?.state === 'failed') {
    db.prepare("update delete_approvals set state = 'pending', failure = null, requested_at = ? where id = ?").run(o.now, cur.id);
    touchRow(db, 'delete_approvals', cur.id);
    return { outcome: 'pending', id: cur.id, created: false };
  }
  if (cur?.state === 'rejected' && o.now - (cur.decided_at ?? 0) <= REJECT_HOLD_MS) return { outcome: 'rejected', id: cur.id };
  const open = (db.prepare("select count(*) c from delete_approvals where state != 'rejected'").get() as { c: number }).c;
  if (open >= PENDING_MAX) return { outcome: 'too_many' };
  const id = randomUUID();
  db.transaction(() => {
    if (cur) db.prepare('delete from delete_approvals where id = ?').run(cur.id);
    db.prepare("insert into delete_approvals (id, session_id, from_session_id, requested_at, state) values (?, ?, ?, ?, 'pending')").run(id, o.sessionId, o.fromSessionId, o.now);
  })();
  touchRow(db, 'delete_approvals', id);
  return { outcome: 'pending', id, created: true };
}

/**
 * 答えを待っている依頼と、消せなかった依頼。古い順に並べる。
 * 手で消した会話の行は、ここで外す（会話を戻しても依頼を蘇らせない）。
 */
export function listDeleteApprovals(db: Db): DeleteApprovalDto[] {
  db.prepare('delete from delete_approvals where session_id in (select id from sessions where deleted_at is not null)').run();
  const rows = db.prepare(`select a.*, p.name project, coalesce(st.turns, 0) turns from delete_approvals a
    join sessions s on s.id = a.session_id
    left join projects p on p.id = s.project_id and p.deleted_at is null
    left join session_stats st on st.session_id = s.id
    where a.state != 'rejected' order by a.requested_at, a.id`).all() as (Row & { project: string | null; turns: number })[];
  return rows.map((r) => {
    const from = r.from_session_id ? sessionTitleOf(db, r.from_session_id) : null;
    return {
      id: r.id, sessionId: r.session_id, title: clipTitle(sessionTitleOf(db, r.session_id) ?? ''), project: r.project, turns: r.turns,
      from: from === null ? null : clipTitle(from), requestedAt: r.requested_at, failure: r.state === 'failed' ? r.failure ?? 'trash' : null,
    };
  });
}

/** 承認して消す。待ちの行だけを受ける。もう無い会話（404）は消せたものとして扱う。 */
export async function approveDeleteApproval(db: Db, trash: { deleteSession(sessionId: string): Promise<void> }, id: string): Promise<ApproveOutcome> {
  const row = rowOf(db, id);
  if (row?.state !== 'pending') return 'missing';
  try {
    await trash.deleteSession(row.session_id);
  } catch (e) {
    const status = e instanceof DeleteError ? e.status : 500;
    if (status !== 404) {
      db.prepare("update delete_approvals set state = 'failed', failure = ? where id = ?").run(status === 409 ? 'running' : 'trash', id);
      touchRow(db, 'delete_approvals', id);
      if (!(e instanceof DeleteError)) console.error('[delete-approval] could not delete the session', e instanceof Error ? e.constructor.name : typeof e);
      return 'failed';
    }
  }
  db.prepare('delete from delete_approvals where id = ?').run(id);
  touchRow(db, 'delete_approvals', id);
  return 'deleted';
}

/** 断る。行は rejected にして残す。待ちの行だけを受ける。 */
export function rejectDeleteApproval(db: Db, id: string, now: number): boolean {
  const r = db.prepare("update delete_approvals set state = 'rejected', decided_at = ? where id = ? and state = 'pending'").run(now, id);
  if (r.changes === 0) return false;
  touchRow(db, 'delete_approvals', id);
  return true;
}

/** 消せなかった行を閉じる。 */
export function dismissDeleteApproval(db: Db, id: string): boolean {
  const r = db.prepare("delete from delete_approvals where id = ? and state = 'failed'").run(id);
  if (r.changes === 0) return false;
  touchRow(db, 'delete_approvals', id);
  return true;
}
