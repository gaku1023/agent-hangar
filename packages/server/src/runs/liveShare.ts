import type { LiveStatus, StopReason } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

/** 手元で状態が変わってから共有の行へ書くまで、idle と busy を保留する長さ。短い往復で書き込みが増えすぎないようにする。 */
export const LIVE_SHARE_HOLD_MS = 3000;

type Target = { status: LiveStatus; reason: StopReason | null };
type Pending = Target & { since: number; timer: ReturnType<typeof setTimeout> };

/**
 * この PC の run の状態（作業中、入力待ち、休みと、止まっている理由）を、runs の行の live_status・live_reason・live_at に載せる。
 * ほかの PC のサイドバーが点と待ちの時間に使う。書き手はその run の PC だけである。
 * 変わったときだけ書く（同じ状態の書き直しはしない。以前の heartbeat の書き直しとは違う）。
 * waiting はすぐ書く（ほかの PC が早く知りたい。急ぎの push にもなる）。idle と busy は holdMs だけ保留し、その間に戻ったら書かない。
 */
export class LiveShare {
  private pending = new Map<string, Pending>();
  private holdMs: number;
  private now: () => number;

  constructor(private deps: { db: Db; deviceId: string; holdMs?: number; now?: () => number }) {
    this.holdMs = deps.holdMs ?? LIVE_SHARE_HOLD_MS;
    this.now = deps.now ?? Date.now;
  }

  /** run の今の状態を知らせる。何度呼んでも、変わったときだけ書く。 */
  observe(runId: string, status: LiveStatus, reason: StopReason | null): void {
    const at = this.now();
    const row = this.deps.db.prepare('select live_status, live_reason from runs where id = ?').get(runId) as { live_status: string | null; live_reason: string | null } | undefined;
    if (!row) return;
    const p = this.pending.get(runId);
    if (row.live_status === status && row.live_reason === reason) {
      this.cancel(runId);
      return;
    }
    if (status === 'waiting') {
      this.cancel(runId);
      this.write(runId, { status, reason }, at);
      return;
    }
    if (p && p.status === status && p.reason === reason) return;
    this.cancel(runId);
    const timer = setTimeout(() => {
      const cur = this.pending.get(runId);
      this.pending.delete(runId);
      if (cur) this.write(runId, cur, cur.since);
    }, this.holdMs);
    timer.unref?.();
    this.pending.set(runId, { status, reason, since: at, timer });
  }

  /** 保留を捨てる。run が終わったとき、生きた run でなくなったときに呼ぶ。 */
  forget(runId: string): void {
    this.cancel(runId);
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }

  private cancel(runId: string): void {
    const p = this.pending.get(runId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(runId);
  }

  private write(runId: string, t: Target, at: number): void {
    const row = this.deps.db.prepare('select * from runs where id = ? and ended_at is null and deleted_at is null').get(runId) as Record<string, unknown> | undefined;
    if (!row) return;
    if (row.live_status === t.status && row.live_reason === t.reason) return;
    // 状態が同じで理由だけが変わったときは、その状態になった時刻を保つ。
    const liveAt = row.live_status === t.status && typeof row.live_at === 'number' ? row.live_at : at;
    upsertShared(this.deps.db, 'runs', { ...row, live_status: t.status, live_reason: t.reason, live_at: liveAt }, this.deps.deviceId);
  }
}
