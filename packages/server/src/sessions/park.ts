import type { LiveStatus } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { getSession } from '../db/queries.ts';
import type { LiveSession } from '../provider/types.ts';

/**
 * 区切り（Paused・Done・Archived）を付けたのに、休みのまま残っているセッションの id。
 * 判定は一覧に載せる parked と同じもの（shared の isParked）を使う。画面が実行中から外すものと、ここで止めるものを揃えるためである。
 * 同じ会話に登録が 2 つ以上あるときは返さない。hangar の run と外のターミナルの両方で開いていると、
 * 休みなのがどちらのプロセスか決められず、作業中の run を落としかねない。
 * deviceId は、起動時刻の代わりに使う run をこの端末のものに限るために渡す。
 * 休みの会話だけを引くので、動いている会話が多くても軽い。
 */
export function parkedSessionIds(db: Db, live: readonly LiveSession[], deviceId?: string): string[] {
  const entries = new Map<string, number>();
  for (const l of live) entries.set(l.sessionId, (entries.get(l.sessionId) ?? 0) + 1);
  const out: string[] = [];
  for (const l of live) {
    if (l.status !== 'idle' || entries.get(l.sessionId) !== 1) continue;
    const row = db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(l.sessionId) as { id: string } | undefined;
    if (row && getSession(db, [l], row.id, deviceId ? { deviceId } : {})?.parked) out.push(row.id);
  }
  return out;
}

/** 動き（作業中・休み・入力待ち）が変わった会話の id（Claude の UUID）。出入りしたものは含めない。 */
export function statusChanged(prev: ReadonlyMap<string, LiveStatus>, live: readonly LiveSession[]): string[] {
  return live.filter((l) => prev.has(l.sessionId) && prev.get(l.sessionId) !== l.status).map((l) => l.sessionId);
}

/** 休みがこの長さ続いたら止める。ターンの終わりの一瞬の休みや、すぐ次の発言が来る場合に止めないための間である。 */
export const PARK_SETTLE_MS = 10_000;

export type ParkWatchDeps = {
  /** いま区切り済みで休みのセッションの id（parkedSessionIds）。 */
  parkedIds: () => string[];
  /** そのセッションの Claude を止める。止めるものがあれば true（RunManager.park）。 */
  stop: (sessionId: string) => boolean;
  now?: () => number;
  settleMs?: number;
  log?: (message: string) => void;
};

/**
 * 区切りを付けたセッションが休みになったら、Claude を止める見張り。
 * 会話の中で Paused を選んだ時点では Claude はまだ最後の返答を書いているので、休みになるのを待つ。
 * 止めにいくのは、休みが続く間に 1 回だけである。外のターミナルの会話のように止められないものを、周期のたびに触らない。
 */
export class ParkWatch {
  /** 休みを最初に見た時刻と、もう止めにいったか。休みを抜けたら消す。 */
  private seen = new Map<string, { since: number; tried: boolean }>();

  constructor(private readonly deps: ParkWatchDeps) {}

  /** そのセッションの動きが変わった。休みの数え直しにする。見回りの合間に一瞬だけ作業中になった場合を拾う。 */
  reset(sessionId: string): void {
    this.seen.delete(sessionId);
  }

  /** 1 回見回る。止めたセッションの id を返す。 */
  tick(): string[] {
    const now = this.deps.now?.() ?? Date.now();
    const settle = this.deps.settleMs ?? PARK_SETTLE_MS;
    const parked = new Set(this.deps.parkedIds());
    for (const id of this.seen.keys()) if (!parked.has(id)) this.seen.delete(id);
    const stopped: string[] = [];
    for (const id of parked) {
      const cur = this.seen.get(id);
      if (!cur) { this.seen.set(id, { since: now, tried: false }); continue; }
      if (cur.tried || now - cur.since < settle) continue;
      cur.tried = true;
      try {
        if (this.deps.stop(id)) stopped.push(id);
      } catch (e) {
        (this.deps.log ?? console.error)(`[park] 区切りを付けたセッションを止められませんでした: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return stopped;
  }
}
