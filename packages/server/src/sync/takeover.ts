import { TAKEOVER_TIMEOUT_MS, type TakeoverDto, type TakeoverStage } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { sessionLock } from '../db/queries.ts';
import type { Timers } from './engine.ts';
import { answerOf, askOf, cancelAsk, setAskForce, writeAsk, type TakeoverAnswer, type TakeoverAsk } from './takeoverRows.ts';

/**
 * 「この PC で再開」の頼む側。ほかの PC で動いている会話を止めてもらい、その最後の本文が降りてくるのを待つ。
 *
 * 流れは、頼みの行を書いて送り（asking）、相手の応答を待ち（waiting）、相手が止まったあと台帳に本文の版が降りきるのを待つ（receiving）、である。
 * 降りきった版は応答に載った sha256 と大きさで見分ける。古い本文のまま再開しないためである。
 * 頼みの行の書き手は頼む側だけ、応答の書き手は頼まれた側だけなので、取り下げと応答が行き違っても消し合わない。
 * 取り下げた後に届いた応答は、状態を捨ててあるので何も起こさない。
 * 待ちの状態は会話ごとにメモリだけに持つ。サーバを立て直せば消え、画面は取り下げと同じ扱いになる。頼みの行は残る。
 */

/** 待つ間、相手の応答を取りに行く間隔。ふだんの pull の周期（30 秒）は変えない。 */
export const TAKEOVER_POLL_MS = 5_000;

const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };

export type TakeoverServiceDeps = {
  db: Db;
  /** この PC。 */
  deviceId: string;
  /** 頼みの行をクラウドへ運べるか。Worker の版が足りないとき、同期が一時停止や停止のときは偽。偽のときは行を書かない。 */
  canCarry(): boolean;
  /** 書いた行をすぐ送る。 */
  pushNow(): Promise<void>;
  /** 行と本文の写しを 1 回ずつ取りに行く。 */
  pull(): Promise<void>;
  broadcast(dto: TakeoverDto): void;
  now?: () => number;
  timers?: Timers;
};

type Handle = ReturnType<typeof setTimeout>;
type State = {
  sessionId: string;
  deviceName: string;
  /** 止めてもらう PC と run。ロックが無かったときは null。 */
  target: string | null;
  runId: string | null;
  /** 書いた頼みの行。行を書かなかったとき（ロックが無い、運べない）は null。 */
  askId: string | null;
  stage: TakeoverStage;
  startedAt: number;
  deadline: number;
  poll: Handle | null;
  stopAt: Handle | null;
  pulling: boolean;
};

const ACTIVE: ReadonlySet<TakeoverStage> = new Set(['asking', 'waiting', 'receiving']);

/** この PC が書いた、取り下げも削除もされていない頼み。run を渡せばその run あてだけ。新しい順の先頭。 */
function liveAsks(db: Db, self: string, sessionId: string, runId?: string): TakeoverAsk[] {
  const rows = db.prepare(`
    select id from takeovers
    where from_device = ? and session_id = ? and cancelled_at is null and deleted_at is null${runId === undefined ? '' : ' and run_id = ?'}
    order by requested_at desc, id desc
  `).all(...(runId === undefined ? [self, sessionId] : [self, sessionId, runId])) as { id: string }[];
  return rows.map((r) => askOf(db, r.id)).filter((a): a is TakeoverAsk => a !== null);
}

/**
 * 応答の本文の版が、手元の台帳（file_sync）に降りきっているか。
 * 応答の sha256 が null（相手に上げた本文が無い）なら台帳を見ずに真。あれば、台帳の sha256 と大きさが応答と同じになるまで偽。
 */
function landed(db: Db, sessionId: string, target: string, a: TakeoverAnswer): boolean {
  if (a.transcriptSha256 === null) return true;
  const uuid = (db.prepare('select provider_session_id p from sessions where id = ?').get(sessionId) as { p: string } | undefined)?.p ?? null;
  if (!uuid) return false;
  const led = db.prepare('select sha256, size from file_sync where key = ?').get(`transcripts/${target}/${uuid}.jsonl.gz`) as { sha256: string; size: number } | undefined;
  return !!led && led.sha256 === a.transcriptSha256 && led.size === a.transcriptSize;
}

/**
 * 「この PC で再開」を通してよいか。生きたロックのある会話は、頼まずには引き継げない。
 * 通すのは、ロックが無い、ロックが stale（Worker が相手の PC を 3 分より前から見ていない、sync/peers.ts）、
 * またはこの PC が書いた取り下げていない頼みがロックの run を指し、force であるか、応答があって本文の版が台帳に降りきっているときである。
 */
export function resumeHereAllowed(db: Db, self: string, sessionId: string, now: number): { ok: true } | { ok: false; deviceName: string } {
  const lock = sessionLock(db, self, sessionId, now);
  if (!lock || lock.stale) return { ok: true };
  for (const ask of liveAsks(db, self, sessionId, lock.runId)) {
    if (ask.mode === 'force') return { ok: true };
    const a = answerOf(db, ask.id);
    if (a && landed(db, sessionId, ask.targetDevice, a)) return { ok: true };
  }
  return { ok: false, deviceName: lock.deviceName };
}

const logError = (what: string, e: unknown): void => { console.error('[takeover]', what, e instanceof Error ? e.message : e); };

export class TakeoverService {
  private readonly states = new Map<string, State>();
  /** 頼みを運べないまま force で進めた会話と、そのときの run。行が無いので、再開を通す印をメモリに持つ。 */
  private readonly forcedBare = new Map<string, string>();
  private stopped = false;
  private readonly now: () => number;
  private readonly timers: Timers;

  constructor(private readonly deps: TakeoverServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  private dto(st: State): TakeoverDto {
    return { sessionId: st.sessionId, deviceName: st.deviceName, stage: st.stage, startedAt: st.startedAt, deadline: st.deadline };
  }

  get(sessionId: string): TakeoverDto | null {
    const st = this.states.get(sessionId);
    return st ? this.dto(st) : null;
  }

  /** 頼みを運べないまま force で進めた会話か（run が同じときだけ真）。再開の経路が、行の無い force を通すのに使う。 */
  forcedWithoutRow(sessionId: string, runId: string): boolean {
    return this.forcedBare.get(sessionId) === runId;
  }

  /**
   * 引き継ぎを始める。最初の段を返す（以後の段は broadcast で届く）。
   * ロックが無ければ行を書かずに ready。stale か force なら force の頼みを書いて ready。
   * 生きたロックでは、運べなければ行を書かずに timeout、運べれば ask を書いて asking。
   */
  start(sessionId: string, o: { force: boolean }): TakeoverDto {
    this.drop(sessionId);
    const t = this.now();
    const lock = sessionLock(this.deps.db, this.deps.deviceId, sessionId, t);
    const st: State = {
      sessionId, deviceName: lock?.deviceName ?? '', target: lock?.deviceId ?? null, runId: lock?.runId ?? null, askId: null,
      stage: 'asking', startedAt: t, deadline: t + TAKEOVER_TIMEOUT_MS, poll: null, stopAt: null, pulling: false,
    };
    this.states.set(sessionId, st);
    if (!lock) return this.settle(st, 'ready');
    const carry = this.deps.canCarry();
    const existing = liveAsks(this.deps.db, this.deps.deviceId, sessionId, lock.runId)[0] ?? null;
    if (lock.stale || o.force || existing?.mode === 'force') {
      if (carry) {
        st.askId = this.writeForce(st, existing);
        this.pushQuietly();
      } else if (existing?.mode !== 'force') {
        // 行を書けないので、再開を通す印だけをメモリに持つ。応答の無い ask が前からあっても同じ。
        this.forcedBare.set(sessionId, lock.runId);
      }
      return this.settle(st, 'ready');
    }
    if (!carry) return this.settle(st, 'timeout');
    return this.ask(st, existing);
  }

  /** 「もう少し待つ」。いまから同じ長さを足して待ち直す。始めていない会話は null。運べなければ timeout のまま。 */
  extend(sessionId: string): TakeoverDto | null {
    const st = this.states.get(sessionId);
    if (!st) return null;
    if (st.stage === 'ready' || st.stage === 'cancelled') return this.dto(st);
    if (!this.deps.canCarry()) {
      if (ACTIVE.has(st.stage)) return this.settle(st, 'timeout');
      return this.dto(st);
    }
    const t = this.now();
    st.deadline = t + TAKEOVER_TIMEOUT_MS;
    if (st.stage === 'asking' && st.askId !== null) {
      // 頼みを送っている最中は段を変えない（送り終えれば waiting へ進む）。期限だけ延ばして時計を張り直す。
      this.arm(st);
      this.broadcast(st);
      return this.dto(st);
    }
    if (st.askId === null) {
      // 運べなかったときに始めた会話。いまの様子を見直して頼みを書く。
      const lock = sessionLock(this.deps.db, this.deps.deviceId, sessionId, t);
      if (!lock) return this.settle(st, 'ready');
      st.deviceName = lock.deviceName; st.target = lock.deviceId; st.runId = lock.runId;
      return this.ask(st, liveAsks(this.deps.db, this.deps.deviceId, sessionId, lock.runId)[0] ?? null);
    }
    st.stage = 'waiting';
    this.arm(st);
    this.broadcast(st);
    this.evaluate(st);
    return this.dto(st);
  }

  /** 取り下げる。頼みに取り下げを書いて送り、状態を捨てて cancelled を 1 度配る。その後に届く応答は何も起こさない。 */
  cancel(sessionId: string): void {
    const st = this.states.get(sessionId);
    const ids = new Set(liveAsks(this.deps.db, this.deps.deviceId, sessionId).map((a) => a.id));
    if (st?.askId) ids.add(st.askId);
    const t = this.now();
    for (const id of ids) cancelAsk(this.deps.db, this.deps.deviceId, id, t);
    if (ids.size > 0) this.pushQuietly();
    this.forcedBare.delete(sessionId);
    if (!st) return;
    this.disarm(st);
    this.states.delete(sessionId);
    st.stage = 'cancelled';
    this.broadcast(st);
  }

  /** 応答や台帳の行が届いたとき。待っている会話だけ確かめ直す。 */
  noteApplied(): void {
    if (this.stopped) return;
    for (const st of [...this.states.values()]) {
      if (st.stage === 'waiting' || st.stage === 'receiving') this.evaluate(st);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const st of this.states.values()) this.disarm(st);
    this.states.clear();
    this.forcedBare.clear();
  }

  // ---- 内側 ----

  /** 前の状態を、何も配らずに捨てる。始め直すときに使う。 */
  private drop(sessionId: string): void {
    const old = this.states.get(sessionId);
    if (old) this.disarm(old);
    this.states.delete(sessionId);
    this.forcedBare.delete(sessionId);
  }

  /** force の頼みを用意する。すでに行があれば force に切り替え、無ければ書く。行の id を返す。 */
  private writeForce(st: State, existing: TakeoverAsk | null): string {
    const { db, deviceId } = this.deps;
    const t = this.now();
    if (existing) {
      if (existing.mode !== 'force') setAskForce(db, deviceId, existing.id, t);
      return existing.id;
    }
    return writeAsk(db, deviceId, { sessionId: st.sessionId, runId: st.runId!, targetDevice: st.target!, mode: 'force', now: t }).id;
  }

  /** ask の頼みを用意して asking にし、送り終えたら waiting へ進める。 */
  private ask(st: State, existing: TakeoverAsk | null): TakeoverDto {
    st.askId = existing?.id ?? writeAsk(this.deps.db, this.deps.deviceId, { sessionId: st.sessionId, runId: st.runId!, targetDevice: st.target!, mode: 'ask', now: this.now() }).id;
    st.stage = 'asking';
    this.arm(st);
    this.broadcast(st);
    const out = this.dto(st);
    void this.deps.pushNow().catch((e: unknown) => logError('頼みをすぐには送れませんでした', e)).then(() => {
      // 送っている間に取り下げや打ち切りがあれば、段を戻さない。
      if (this.stopped || this.states.get(st.sessionId) !== st || st.stage !== 'asking') return;
      st.stage = 'waiting';
      this.broadcast(st);
      this.evaluate(st);
    });
    return out;
  }

  private pushQuietly(): void {
    void this.deps.pushNow().catch((e: unknown) => logError('頼みをすぐには送れませんでした', e));
  }

  /** 打ち切りの時計と、取りに行く間隔を張る。張り直すときは先に外す。 */
  private arm(st: State): void {
    this.disarm(st);
    const left = Math.max(0, st.deadline - this.now());
    st.stopAt = this.timers.setTimeout(() => {
      st.stopAt = null;
      if (!this.stopped && this.states.get(st.sessionId) === st && ACTIVE.has(st.stage)) this.settle(st, 'timeout');
    }, left);
    (st.stopAt as { unref?: () => void }).unref?.();
    st.poll = this.timers.setInterval(() => { void this.tick(st); }, TAKEOVER_POLL_MS);
    (st.poll as { unref?: () => void }).unref?.();
  }

  private disarm(st: State): void {
    if (st.stopAt) this.timers.clearTimeout(st.stopAt);
    if (st.poll) this.timers.clearInterval(st.poll);
    st.stopAt = null; st.poll = null;
  }

  /** 取りに行く間隔ごと。待っている間だけ、行と本文の写しを取りに行き、取れたら確かめる。 */
  private async tick(st: State): Promise<void> {
    if (this.stopped || this.states.get(st.sessionId) !== st) return;
    if (st.stage !== 'waiting' && st.stage !== 'receiving') return;
    if (st.pulling) return;
    st.pulling = true;
    try { await this.deps.pull(); } catch (e) { logError('取りに行けませんでした', e); } finally { st.pulling = false; }
    if (!this.stopped && this.states.get(st.sessionId) === st && (st.stage === 'waiting' || st.stage === 'receiving')) this.evaluate(st);
  }

  /**
   * 応答を見て段を決める。応答が無ければそのまま。
   * 応答の本文の版が null なら台帳を見ずに ready。あれば、台帳の sha256 と大きさが応答と同じになるまで receiving のまま待つ。
   */
  private evaluate(st: State): void {
    if (!st.askId) return;
    const a = answerOf(this.deps.db, st.askId);
    if (!a) return;
    if (!st.target || !landed(this.deps.db, st.sessionId, st.target, a)) {
      this.settle(st, 'receiving');
      return;
    }
    this.settle(st, 'ready');
  }

  /** 段を変えて配る。同じ段への移りは配らない。終わりの段（ready、timeout）では取りに行くのをやめる。 */
  private settle(st: State, stage: TakeoverStage): TakeoverDto {
    if (st.stage !== stage) {
      st.stage = stage;
      this.broadcast(st);
    }
    if (!ACTIVE.has(stage)) this.disarm(st);
    return this.dto(st);
  }

  private broadcast(st: State): void {
    this.deps.broadcast(this.dto(st));
  }
}
