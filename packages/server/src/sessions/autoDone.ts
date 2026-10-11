import type { Db } from '../db/open.ts';

/**
 * 止まったセッションを自動で Done にする（2026-10-11 の利用者の決定）。
 * Active を「続きがあるもの」に保つためで、誰も片付けないセッションが Active に溜まるのを止める。
 *
 * 対象は、この端末で動いたもので、状態が無く、止まっているもののうち、次のどちらかに当たるもの。
 * - 使い捨て（disposable）：hangar の run が一度も無く、3 ターン以下。claude -p や試験、外のターミナルの短い問い。
 * - 要約が完了（summary）：会話の中か事後の要約の進捗が「完了」か「中止」。土台の要約は止まっていれば「完了」と書くので数えない。
 * 除くのは、Paused の提案があるもの（利用者に聞いている最中）、却下したもの、「Active に戻す」の後に動きが無いもの。
 * 他の端末のセッションはその端末に任せる。どの端末の run も生きていないことも見る。
 * 書いた後に resume して発言すれば、今までどおり状態は外れる（states.ts の stateClears）。
 */

/** 使い捨てとみなすターン数の上限。 */
export const DISPOSABLE_MAX_TURNS = 3;
/** 続けて対象だったものだけを Done にする間。再起動や「hangar に移動」で一瞬止まって見えるものを拾わない。 */
export const AUTO_DONE_SETTLE_MS = 60_000;
/** 見回りの間隔。 */
export const AUTO_DONE_POLL_MS = 15_000;

export type AutoDoneReason = 'disposable' | 'summary';
export type AutoDoneCandidate = { id: string; reason: AutoDoneReason };

type Row = { id: string; p: string; had_run: number; alive_run: number; turns: number; sum_source: string | null; sum_state: string | null };

/**
 * 状態の無い、この端末のセッションを、止まっているかどうかの材料と一緒に引く。
 * 左結合の列は行が無いと null なので、比べる式は ifnull で包む（null との比較は偽にも真にもならず、行ごと落ちる）。
 */
function activeRows(db: Db, deviceId: string): Row[] {
  return db.prepare(`
    select s.id, s.provider_session_id p,
      exists(select 1 from runs r where r.session_id = s.id and r.deleted_at is null) had_run,
      exists(select 1 from runs r where r.session_id = s.id and r.deleted_at is null and r.ended_at is null) alive_run,
      ifnull(ss.turns, 0) turns, sm.source sum_source, sm.state sum_state
    from sessions s
    left join session_states st on st.session_id = s.id and st.deleted_at is null
    left join session_stats ss on ss.session_id = s.id
    left join session_summaries sm on sm.session_id = s.id and sm.deleted_at is null
    where s.deleted_at is null and s.home_device = ?
      and st.status is null and st.rejected_at is null
      and not (ifnull(st.candidate_status, '') = 'paused' and st.candidate_at is not null)
      and not (st.set_at is not null and st.set_at >= ifnull(s.last_activity_at, 0))
  `).all(deviceId) as Row[];
}

const stopped = (r: Row, liveProviderIds: ReadonlySet<string>): boolean => r.alive_run === 0 && !liveProviderIds.has(r.p);
const realSummary = (r: Row): boolean => r.sum_source === 'in_session' || r.sum_source === 'post_hoc';

/** いま自動で Done にしてよいセッション。要約を待っているもの（pending）は、要約が書かれてから見る。 */
export function autoDoneCandidates(db: Db, deviceId: string, o: { liveProviderIds: ReadonlySet<string>; pending: ReadonlySet<string>; now: number }): AutoDoneCandidate[] {
  const out: AutoDoneCandidate[] = [];
  for (const r of activeRows(db, deviceId)) {
    if (!stopped(r, o.liveProviderIds) || o.pending.has(r.id)) continue;
    if (r.had_run === 0 && r.turns <= DISPOSABLE_MAX_TURNS) out.push({ id: r.id, reason: 'disposable' });
    else if (realSummary(r) && (r.sum_state === 'done' || r.sum_state === 'abandoned')) out.push({ id: r.id, reason: 'summary' });
  }
  return out;
}

/**
 * 事後要約を回すべきセッション。hangar の外で起こした 4 ターン以上のもので、要約が土台のまま止まったもの。
 * hangar の run は終わったときに要約が回るが、外のものは画面で開くまで回らず、「要約が完了」に当たらないまま残るためである。
 * since より後に最後に動いたものに限る。入れたばかりの利用者の過去の全履歴に要約を回して、使用量を食わないようにする。
 */
export function summaryCandidates(db: Db, deviceId: string, o: { liveProviderIds: ReadonlySet<string>; since: number }): string[] {
  const recent = new Set((db.prepare('select id from sessions where home_device = ? and ifnull(last_activity_at, 0) >= ?').all(deviceId, o.since) as { id: string }[]).map((r) => r.id));
  return activeRows(db, deviceId)
    .filter((r) => recent.has(r.id) && stopped(r, o.liveProviderIds) && r.had_run === 0 && r.turns > DISPOSABLE_MAX_TURNS && !realSummary(r))
    .map((r) => r.id);
}

export type AutoDoneWatchDeps = {
  /** いま対象のセッション（autoDoneCandidates）。 */
  candidates: () => AutoDoneCandidate[];
  /** Done にする。書いたら true（states.ts の markAutoDone）。 */
  mark: (sessionId: string) => boolean;
  /** 事後要約を回すべきセッション（summaryCandidates）。 */
  toSummarize: () => string[];
  /** 要約の待ち行列へ入れる。 */
  enqueue: (sessionId: string) => void;
  now?: () => number;
  settleMs?: number;
  log?: (message: string) => void;
};

/**
 * 止まったセッションを Done にする見張り。ParkWatch と同じく、続けて対象だったものだけを扱う。
 * 事後要約の待ち行列へは、同じセッションを 1 回だけ入れる。要約器が使えないときに、見回りのたびに入れ直さないためである。
 */
export class AutoDoneWatch {
  /** 対象として最初に見た時刻。対象から外れたら消す。 */
  private seen = new Map<string, number>();
  private enqueued = new Set<string>();

  constructor(private readonly deps: AutoDoneWatchDeps) {}

  /** 1 回見回る。Done にしたセッションの id を返す。 */
  tick(): string[] {
    const now = this.deps.now?.() ?? Date.now();
    const settle = this.deps.settleMs ?? AUTO_DONE_SETTLE_MS;
    for (const id of this.deps.toSummarize()) {
      if (this.enqueued.has(id)) continue;
      this.enqueued.add(id);
      this.deps.enqueue(id);
    }
    const ids = new Set(this.deps.candidates().map((c) => c.id));
    for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id);
    const marked: string[] = [];
    for (const id of ids) {
      const since = this.seen.get(id);
      if (since === undefined) { this.seen.set(id, now); continue; }
      if (now - since < settle) continue;
      this.seen.delete(id);
      try {
        if (this.deps.mark(id)) marked.push(id);
      } catch (e) {
        (this.deps.log ?? console.error)(`[auto-done] Done にできませんでした: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return marked;
  }
}
