import type { MobilePeerApproval, PeerApprovalDto, PeerApprovalState, PeerLaunchRequest } from '@agent-hangar/shared';
import { touchRow } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { sessionTitleOf } from '../mobile/feed.ts';
import type { Timers } from '../sync/engine.ts';

/**
 * 別の PC へ、ほかのプロジェクトやクイックセッションを起こす頼みの承認待ち（D8）。
 * MCP の delete_session の承認（sessions/deleteApprovals.ts）と同じ流れで、手元だけの表（peer_approvals）に預かる。
 * 答えるのは、この PC の画面の HTTP とスマホの問い合わせだけで、MCP の道具には出さない。
 *
 * 待てるのは PEER_APPROVAL_TTL_MS で、過ぎれば approval-timeout を呼び出し元に入れる。期限は作った時刻から決まるので、再起動をまたいでも同じである。
 * 答えた行と時間切れの行は、画面が結果を見せる PEER_APPROVAL_HOLD_MS の間だけ残してから外す。
 */

/** 答えを待てる長さ。 */
export const PEER_APPROVAL_TTL_MS = 10 * 60_000;
/** 答えた後、結果の札を残す長さ。 */
export const PEER_APPROVAL_HOLD_MS = 3_000;
/** 積める待ちの上限。超える頼みは断る（帯が埋まらないように）。 */
export const PEER_APPROVAL_MAX = 20;

const ASK_MAX = 80;
const clip = (s: string, max: number): string => {
  const cs = [...s.replace(/\s+/g, ' ').trim()];
  return cs.length > max ? `${cs.slice(0, max - 1).join('')}…` : cs.join('');
};

type Row = {
  id: string; caller_session_id: string; to_device: string; to_name: string; project_id: string | null; scratch: number;
  request: string; created_at: number; state: PeerApprovalState; decided_at: number | null;
};

/** 呼び出し元に入れる断りの理由。launch-failed は、承認したのに頼みを置けなかったとき（と、待ちが上限のとき）である。 */
export type PeerApprovalRefusal = 'approval-denied' | 'approval-timeout' | 'launch-failed';

export type PeerApprovalDeps = {
  db: Db;
  now?: () => number;
  /** 承認された頼みを置く（経路を決め、封じて put し、呼ぶ側に記録する）。投げれば送れなかったことになる。 */
  send(row: { requestId: string; to: string; callerSessionId: string; request: PeerLaunchRequest }): Promise<void>;
  /** 呼び出し元の会話へ、断りを入力として送り込む（PeerOutbox.refuseLocal）。 */
  refuse(o: { requestId: string; to: string; callerSessionId: string; reason: PeerApprovalRefusal; detail?: string }): void;
  /** 承認待ちができたことを利用者へ知らせる。 */
  notify?(o: { callerSessionId: string; device: string; from: string | null }): void;
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

const rowOf = (db: Db, id: string): Row | undefined => db.prepare('select * from peer_approvals where id = ?').get(id) as Row | undefined;

function askOf(r: Row): string {
  try { return clip((JSON.parse(r.request) as { prompt?: string }).prompt ?? '', ASK_MAX); } catch { return ''; }
}

function projectNameOf(db: Db, id: string | null): string | null {
  if (id === null) return null;
  return (db.prepare('select name from projects where id = ?').get(id) as { name: string } | undefined)?.name ?? null;
}

/**
 * 画面に出す行。待ちのうち期限内のものと、答えた（または時間切れの）直後の行を、古い順に並べる。
 * 期限を過ぎた待ちは sweep が timeout にするまでの間も出さない。
 */
export function listPeerApprovals(db: Db, now: number): PeerApprovalDto[] {
  const rows = db.prepare('select * from peer_approvals order by created_at, id').all() as Row[];
  const out: PeerApprovalDto[] = [];
  for (const r of rows) {
    const expiresAt = r.created_at + PEER_APPROVAL_TTL_MS;
    if (r.state === 'pending' && now >= expiresAt) continue;
    if (r.state !== 'pending' && (r.decided_at === null || now - r.decided_at > PEER_APPROVAL_HOLD_MS)) continue;
    const from = sessionTitleOf(db, r.caller_session_id);
    out.push({ id: r.id, from: from === null || from === '' ? null : clip(from, ASK_MAX), device: r.to_name, project: projectNameOf(db, r.project_id), scratch: r.scratch === 1, ask: askOf(r), expiresAt, state: r.state });
  }
  return out;
}

/** スマホの受信箱の素に載せる行。待ちのうち期限内のものだけ。 */
export function mobilePeerApprovals(db: Db, now: number): MobilePeerApproval[] {
  return listPeerApprovals(db, now).filter((a) => a.state === 'pending').map((a) => ({ id: a.id, from: a.from, device: a.device, project: a.project, ask: a.ask, expiresAt: a.expiresAt }));
}

export class PeerApprovals {
  private readonly now: () => number;
  private readonly timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly deps: PeerApprovalDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? { setTimeout, clearTimeout };
  }

  /** 起動の手続きから呼ぶ。起きていなかった間に過ぎた期限を、すぐ処理する。 */
  start(): void {
    this.stopped = false;
    this.sweep();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /** 承認待ちを預かる。積めなければ launch-failed を呼び出し元に入れて false を返す。同じ ID は増やさない。 */
  request(o: { requestId: string; callerSessionId: string; to: string; toName: string; projectId: string | null; scratch: boolean; request: PeerLaunchRequest }): boolean {
    const db = this.deps.db;
    if (rowOf(db, o.requestId)) return true;
    const open = (db.prepare("select count(*) c from peer_approvals where state = 'pending'").get() as { c: number }).c;
    if (open >= PEER_APPROVAL_MAX) {
      this.deps.refuse({ requestId: o.requestId, to: o.to, callerSessionId: o.callerSessionId, reason: 'launch-failed', detail: 'too many pending approvals' });
      return false;
    }
    db.prepare("insert into peer_approvals (id, caller_session_id, to_device, to_name, project_id, scratch, request, created_at, state) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending')")
      .run(o.requestId, o.callerSessionId, o.to, o.toName, o.projectId, o.scratch ? 1 : 0, JSON.stringify(o.request), this.now());
    touchRow(db, 'peer_approvals', o.requestId);
    const from = sessionTitleOf(db, o.callerSessionId);
    try { this.deps.notify?.({ callerSessionId: o.callerSessionId, device: o.toName, from: from === '' ? null : from }); } catch (e) { console.error('[peer] could not notify the approval', e instanceof Error ? e.constructor.name : typeof e); }
    this.schedule();
    return true;
  }

  /** 承認して頼みを置く。待ちの行だけを受ける。続けて呼んでも置くのは 1 度である。 */
  async approve(id: string): Promise<'done' | 'failed' | 'missing'> {
    const db = this.deps.db;
    const row = rowOf(db, id);
    if (!row || row.state !== 'pending' || this.now() >= row.created_at + PEER_APPROVAL_TTL_MS) return 'missing';
    // 置く前に印を付ける。await の間に重ねて承認されても、2 度は置かない。
    db.prepare("update peer_approvals set state = 'approved', decided_at = ? where id = ? and state = 'pending'").run(this.now(), id);
    touchRow(db, 'peer_approvals', id);
    this.schedule();
    let request: PeerLaunchRequest;
    try {
      request = JSON.parse(row.request) as PeerLaunchRequest;
      await this.deps.send({ requestId: id, to: row.to_device, callerSessionId: row.caller_session_id, request });
    } catch (e) {
      db.prepare("update peer_approvals set state = 'failed', decided_at = ? where id = ?").run(this.now(), id);
      touchRow(db, 'peer_approvals', id);
      this.deps.refuse({ requestId: id, to: row.to_device, callerSessionId: row.caller_session_id, reason: 'launch-failed', detail: e instanceof Error ? e.message : String(e) });
      this.schedule();
      return 'failed';
    }
    return 'done';
  }

  /** 断る。approval-denied を呼び出し元に入れる。待ちの行だけを受ける。 */
  reject(id: string): boolean {
    const db = this.deps.db;
    const row = rowOf(db, id);
    if (!row || row.state !== 'pending' || this.now() >= row.created_at + PEER_APPROVAL_TTL_MS) return false;
    const r = db.prepare("update peer_approvals set state = 'denied', decided_at = ? where id = ? and state = 'pending'").run(this.now(), id);
    if (r.changes === 0) return false;
    touchRow(db, 'peer_approvals', id);
    this.deps.refuse({ requestId: id, to: row.to_device, callerSessionId: row.caller_session_id, reason: 'approval-denied' });
    this.schedule();
    return true;
  }

  /** 期限を過ぎた待ちを timeout にし、結果を見せ終えた行を外す。 */
  sweep(): void {
    if (this.stopped) return;
    const db = this.deps.db;
    const now = this.now();
    const rows = db.prepare('select * from peer_approvals').all() as Row[];
    for (const r of rows) {
      if (r.state === 'pending') {
        if (now < r.created_at + PEER_APPROVAL_TTL_MS) continue;
        const u = db.prepare("update peer_approvals set state = 'timeout', decided_at = ? where id = ? and state = 'pending'").run(now, r.id);
        if (u.changes === 0) continue;
        touchRow(db, 'peer_approvals', r.id);
        this.deps.refuse({ requestId: r.id, to: r.to_device, callerSessionId: r.caller_session_id, reason: 'approval-timeout' });
      } else if (r.decided_at === null || now - r.decided_at > PEER_APPROVAL_HOLD_MS) {
        db.prepare('delete from peer_approvals where id = ?').run(r.id);
        touchRow(db, 'peer_approvals', r.id);
      }
    }
    this.schedule();
  }

  /** 次に何かが起きる時刻（待ちの期限か、結果を外す時刻）に合わせて、タイマーを 1 つだけ張る。 */
  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const rows = this.deps.db.prepare('select state, created_at, decided_at from peer_approvals').all() as Pick<Row, 'state' | 'created_at' | 'decided_at'>[];
    let next = Infinity;
    for (const r of rows) next = Math.min(next, r.state === 'pending' ? r.created_at + PEER_APPROVAL_TTL_MS : (r.decided_at ?? 0) + PEER_APPROVAL_HOLD_MS + 1);
    if (next === Infinity) return;
    const wait = Math.min(Math.max(next - this.now(), 0), 2 ** 31 - 1);
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.sweep(); }, wait);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }
}
