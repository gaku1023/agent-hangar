import type { LiveStatus } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { getSession } from '../db/queries.ts';
import type { LiveSession } from '../provider/claude-code/types.ts';

/**
 * 区切り（Done・Archived）を付けたのに、休みのまま残っているセッションの id。Paused は戻ってくる会話なので含めない。
 * 判定は一覧に載せる parked と同じもの（shared の isParked）を使う。画面が実行中から外すものと、ここで止めるものを揃えるためである。
 * 使用制限でリセットを待っている会話（session_limits の行があり、リセットから猶予の内）は返さない。
 * 止めると、Claude Code が予約した自動の続きごと消えるからである。休みに見えても、リセットを待っている。
 * 同じ会話に登録が 2 つ以上あるときは返さない。hangar の run と外のターミナルの両方で開いていると、
 * 休みなのがどちらのプロセスか決められず、作業中の run を落としかねない。
 * deviceId は、起動時刻の代わりに使う run をこの端末のものに限るために渡す。opencode の行には起動時刻（procStart）が無いので、run の始まりで見る。
 * live は Claude の登録と opencode の状態の面の行を合わせたもので、行の agent（省けば Claude Code）とセッションの provider の組で突き合わせる。
 * 休みの会話だけを引くので、動いている会話が多くても軽い。
 */
export function parkedSessionIds(db: Db, live: readonly LiveSession[], deviceId?: string): string[] {
  const entries = new Map<string, number>();
  for (const l of live) entries.set(keyOf(l), (entries.get(keyOf(l)) ?? 0) + 1);
  const marked = markedIdle(db, live);
  const out: string[] = [];
  for (const l of live) {
    // 区切りの無いものは、セッションの行を組まずに外す。待機中に休みの会話が多くても軽くする。
    if (l.status !== 'idle' || entries.get(keyOf(l)) !== 1 || !marked.has(keyOf(l))) continue;
    const row = db.prepare('select id from sessions where provider = ? and provider_session_id = ? and deleted_at is null').get(providerOf(l), l.sessionId) as { id: string } | undefined;
    if (row && getSession(db, [l], row.id, deviceId ? { deviceId } : {})?.parked) out.push(row.id);
  }
  return out;
}

/** 行のエージェント（省けば Claude Code）。 */
const providerOf = (l: LiveSession): string => l.agent ?? 'claude-code';
/** エージェントと会話の ID の組。Claude と opencode の会話の ID を取り違えないために、組で数える。 */
const keyOf = (l: LiveSession): string => `${providerOf(l)}\0${l.sessionId}`;

/** 休みの会話のうち、Done か Archived の付いたものの組（keyOf）。1 回の問い合わせで引く。 */
function markedIdle(db: Db, live: readonly LiveSession[]): Set<string> {
  const idle = [...new Set(live.filter((l) => l.status === 'idle').map((l) => l.sessionId))];
  if (idle.length === 0) return new Set();
  const rows = db.prepare(`select s.provider p, s.provider_session_id id from sessions s join session_states ss on ss.session_id = s.id and ss.deleted_at is null
    where s.deleted_at is null and ss.status in ('done', 'archived') and s.provider_session_id in (${idle.map(() => '?').join(',')})`).all(...idle) as { p: string; id: string }[];
  const marked = new Set(rows.map((r) => `${r.p}\0${r.id}`));
  return new Set(live.filter((l) => l.status === 'idle' && marked.has(keyOf(l))).map(keyOf));
}

/**
 * 止める候補になりうる会話（Done か Archived の付いた休みの会話）があるか。
 * 休みの見張りは、これが偽の間は登録を読み直さない（boot/runs.ts）。待機中に 2 秒ごとに登録とセッションの行を読まないためである。
 */
export function hasMarkedIdle(db: Db, live: readonly LiveSession[]): boolean {
  return markedIdle(db, live).size > 0;
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
  /** 設定のスイッチ（settings の autoPark）。偽の間は休みの一覧も読まず、何も止めない。省けば常に入り。 */
  enabled?: () => boolean;
};

/**
 * 区切りを付けたセッションが休みになったら、Claude を止める見張り。
 * 会話の中で Done を選んだ時点では Claude はまだ最後の返答を書いているので、休みになるのを待つ。
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
    // 切っている間は数えを捨てる。入れ直したら、休みを最初から数える。
    if (this.deps.enabled && !this.deps.enabled()) { this.seen.clear(); return []; }
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
