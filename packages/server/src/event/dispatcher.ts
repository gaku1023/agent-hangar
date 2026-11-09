import { EVENT_HOURLY_MAX, t, type EventFacts, type Language, type ScheduleTarget } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import type { ScheduleOutcome } from '../schedule/runner.ts';
import { wakePaused } from '../sessions/wakePaused.ts';
import { sessionTitleOf } from '../mobile/feed.ts';
import { renderEventPrompt } from './prompt.ts';
import type { PulledEvent } from './puller.ts';
import { addEventRun, deleteBinding, expireBindings, failStaleRuns, finishEventRun, getBindingRow, listBindings, prOwner, setEventRunSession, updateBinding, type BindingRow } from './store.ts';

/**
 * 取った事実を結び付けに当てて動かす（#563）。
 *
 * 当てる：state が active の結び付けだけが動く。
 * puller は state も source.pr も source.labels も見ないので、ここで当てる。
 * - when：ci_done はどの結果にも、ci_failed は ci_done の failure にだけ当たる。
 *   そのほかは同じ名前のものに当たる。
 *   hook は外の webhook の結び付けに当たる。
 * - repo：GitHub の事実が repo を持たないときは、どの結び付けにも当てない。
 * - pr：結び付けが pr を持つなら、事実の number と同じものだけ。
 * - labels：結び付けが札を持つなら、事実の札のどれかと重なるものだけ。
 * 大文字小文字は区別しない。
 *
 * 動き：
 * - 起こす：会話が Paused のときだけ起こし、起こしたら結び付けを消す。
 *   Paused でなければ起こさずに消す。
 *   atStart の山でも、1 回の山でも、結び付けごとに最新の 1 件だけで起こす。
 *   動いていて渡せなかったときと、渡すのに失敗したときは、履歴に書く。
 *   結び付けは PR がまだ開いているときだけ残し、merged か closed のときは履歴を書いてから消す。
 * - 送る、作る、PR の持ち主へ送る：前の回が動いている間に届いた分は溜め、終わった後に 1 回にまとめて流す。
 *   1 時間に EVENT_HOURLY_MAX 回を超えて流そうとしたら、結び付けを held にして知らせる（履歴の error は held:hourly）。
 *   回数は手元の覚えで、起こし直すと数え直す。
 *   atStart の山（hangar を閉じていた間に溜まった荷物）は、利用者が選ぶまで動かさず heldForUser に置く。
 * - merged か closed が来たら、その PR を見ている起こす結び付けを消す。
 *   merged を待つ結び付けは、先に起こす。
 *
 * handle は投げない。
 * 事実ごとの失敗は履歴に残す。
 * 長い待ち（会話の終わりを待つ）は待たずに裏へ回し、すぐ返る。
 * 利用者が選ぶのを待つ事実は、メモリだけに持つ（Worker からは ack 済みなので、hangar を落とすと失われる）。
 */

export type DispatcherDeps = {
  db: Db;
  deviceId: string;
  now(): number;
  language(): Language;
  /**
   * 会話を起こす、または既存の会話へ送る。
   * 既存の会話が動いていて送れなければ 'busy'。
   */
  launch(s: { prompt: string; target: ScheduleTarget; plannedAt: number }): Promise<{ sessionId: string } | 'busy'>;
  /** その会話のターンが終わるか、入力待ちになるまで待つ。 */
  wait(sessionId: string): Promise<ScheduleOutcome>;
  /**
   * 今の PC の gh のユーザー名。
   * 分からなければ null（誰も自分とみなさない）。
   */
  me?: () => Promise<string | null>;
  /** 利用者への知らせ（画面の札）。 */
  notify?: (message: string) => void;
  /**
   * 利用者が選ぶのを待つ事実を積んだ。
   * 積んだ件数を渡す。
   */
  onHeldForUser?: (count: number) => void;
  /**
   * Paused の会話を、できごとで起こした。
   * 利用者が先に再開していた会話と、渡せなかった会話では呼ばない。
   * 画面が、その行が Active に入るときに 1 度だけ光らせるために使う。
   */
  onWoken?: (sessionId: string) => void;
  onError?: (e: unknown) => void;
  /**
   * 結び付けが消えた、または期限で消えた。
   * 受け箱を使う最後の結び付けが消えていれば、GitHub の webhook と受け箱を外す。
   * 何が消えたかは store の預かりが持つので、引数は無い。
   * 投げても、dispatcher は続ける。
   */
  releaseHooks?: () => void;
};

/**
 * 利用者が選ぶのを待つ事実。
 * 結び付けごとにまとめ、古い順に並べる。
 */
export type HeldEvent = { bindingId: string; facts: EventFacts[] };
export type HeldChoice = { bindingId: string; mode: 'latest' | 'all' | 'skip' };

/**
 * 結び付けごとに積む事実の上限。
 * 溢れたら古いものから捨てる。
 */
const HELD_PER_BINDING_MAX = 100;
const HOUR_MS = 60 * 60_000;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const sameName = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * 事実がこの結び付けの条件に当たるか。
 * state は見ない。
 */
export function matchesBinding(b: Pick<BindingRow, 'source'>, f: EventFacts): boolean {
  const s = b.source;
  if (s.kind === 'hook') return f.source === 'hook';
  if (f.source !== 'github') return false;
  // repo を持たない事実は、どの repo のものか分からないので当てない。
  if (!sameName(s.repo, f.repo)) return false;
  const when = s.when.some((w) => (w === 'ci_failed' ? f.event === 'ci_done' && f.outcome === 'failure' : w === f.event));
  if (!when) return false;
  if (s.pr !== undefined && f.number !== s.pr) return false;
  if (s.labels && s.labels.length > 0 && !(f.labels ?? []).some((l) => s.labels!.some((w) => w.toLowerCase() === l.toLowerCase()))) return false;
  return true;
}

type Unit = { pending: EventFacts[] };

export class EventDispatcher {
  /**
   * 動いている送る、作る（PR の持ち主へ送るは PR ごと）の単位。
   * 溜めた事実はここに置く。
   */
  private readonly units = new Map<string, Unit>();
  private readonly waking = new Set<string>();
  /**
   * 巡の終わりまで待たせている起こす事実。
   * 結び付けごとに最新の 1 件だけを持つ。
   */
  private readonly deferred = new Map<string, { b: BindingRow; facts: EventFacts }>();
  private readonly held = new Map<string, EventFacts[]>();
  private readonly recent = new Map<string, number[]>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly d: DispatcherDeps) {}

  /** 起動のときに、期限が過ぎた起こす結び付けを消し、前の回から動いたまま残った履歴を失敗で閉じる。 */
  start(): void {
    try { expireBindings(this.d.db, this.d.now()); } catch (e) { this.d.onError?.(e); }
    try { failStaleRuns(this.d.db, this.d.now()); } catch (e) { this.d.onError?.(e); }
    this.released();
  }

  /**
   * 結び付けを消したあとの webhook の後片付けを頼む。
   * 起動のときは、前の回の取り残しも進める。
   */
  private released(): void {
    try { this.d.releaseHooks?.(); } catch (e) { this.d.onError?.(e); }
  }

  /**
   * 取った事実を当てて動かす。
   * 投げない。
   * 動きは裏で進み、すぐ返る。
   * more が真なら、巡がまだ続く。
   * 起こすのは flushWakes まで待たせ、後のページにある新しい事実で上書きする。
   */
  async handle(events: PulledEvent[], opts: { more?: boolean } = {}): Promise<void> {
    const { db } = this.d;
    try { expireBindings(db, this.d.now()); } catch (e) { this.d.onError?.(e); }
    this.released();
    const wakes = new Map<string, { b: BindingRow; facts: EventFacts }>();
    const closed: { repo: string; number: number }[] = [];
    let heldNow = 0;
    for (const e of events) {
      try {
        if ('rejected' in e) continue;
        const f = e.facts;
        if ((f.event === 'merged' || f.event === 'closed') && f.repo && f.number !== undefined) closed.push({ repo: f.repo, number: f.number });
        const b = getBindingRow(db, e.bindingId);
        if (!b || b.state !== 'active' || !matchesBinding(b, f)) continue;
        if (b.action.kind === 'wake') (opts.more ? this.deferred : wakes).set(b.id, { b, facts: f });
        else if (e.atStart) { this.hold(b.id, [f]); heldNow++; }
        else this.enqueue(b, [f]);
      } catch (err) {
        this.d.onError?.(err);
      }
    }
    for (const { b, facts } of wakes.values()) this.track(this.wake(b, facts, facts.event === 'merged' || facts.event === 'closed'));
    for (const c of closed) {
      try { this.dropWakeBindingsOf(c.repo, c.number); } catch (err) { this.d.onError?.(err); }
    }
    if (heldNow > 0) {
      try { this.d.onHeldForUser?.(heldNow); } catch (err) { this.d.onError?.(err); }
    }
  }

  /**
   * 巡の終わり。
   * 待たせていた起こすを、結び付けごとに最新の 1 件で始める。
   * 巡の途中で失敗しても呼ばれる。
   */
  flushWakes(): void {
    const all = [...this.deferred.values()];
    this.deferred.clear();
    for (const { b, facts } of all) this.track(this.wake(b, facts, facts.event === 'merged' || facts.event === 'closed'));
  }

  /**
   * 利用者が選ぶのを待つ事実。
   * 結び付けが無くなったか active でなくなったものは落とす。
   */
  heldForUser(): HeldEvent[] {
    const out: HeldEvent[] = [];
    for (const [id, facts] of [...this.held]) {
      const b = getBindingRow(this.d.db, id);
      if (!b || b.state !== 'active') { this.held.delete(id); continue; }
      out.push({ bindingId: id, facts: [...facts] });
    }
    return out;
  }

  /**
   * 利用者の選びを流す。
   * latest は最新の 1 件、all は全部を 1 回にまとめて、skip は捨てる。
   * 選ばれなかったものは残す。
   * 流すのは裏で進め、始めたところで返る。
   */
  async runHeld(choices: HeldChoice[]): Promise<void> {
    for (const c of choices) {
      const facts = this.held.get(c.bindingId);
      if (!facts) continue;
      this.held.delete(c.bindingId);
      if (c.mode === 'skip') continue;
      try {
        const b = getBindingRow(this.d.db, c.bindingId);
        if (!b || b.state !== 'active') continue;
        this.enqueue(b, c.mode === 'latest' ? facts.slice(-1) : facts);
      } catch (e) {
        this.d.onError?.(e);
      }
    }
  }

  /**
   * 裏で進んでいる動きが全部終わるまで待つ。
   * 試験と、終了のときに使う。
   */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<void>): void {
    const q = p.catch((e: unknown) => { this.d.onError?.(e); }).finally(() => { this.inflight.delete(q); });
    this.inflight.add(q);
  }

  private hold(bindingId: string, facts: EventFacts[]): void {
    const cur = [...(this.held.get(bindingId) ?? []), ...facts];
    this.held.set(bindingId, cur.slice(-HELD_PER_BINDING_MAX));
  }

  private async me(): Promise<string | null> {
    try { return (await this.d.me?.()) ?? null; } catch { return null; }
  }

  /**
   * merged か closed の PR を見ている起こす結び付けを消す。
   * 起こしている最中のもの（waking）と、巡の終わりを待たせているもの（deferred）は消さない。
   * 起こし終えた wake が、結果を履歴に書いてから自分で消す。
   */
  private dropWakeBindingsOf(repo: string, number: number): void {
    let dropped = 0;
    for (const b of listBindings(this.d.db)) {
      if (this.waking.has(b.id) || this.deferred.has(b.id)) continue;
      if (b.action.kind === 'wake' && b.source.kind === 'github' && b.source.pr === number && sameName(b.source.repo, repo) && deleteBinding(this.d.db, b.id, this.d.now())) dropped++;
    }
    if (dropped > 0) this.released();
  }

  /**
   * Paused を起こす。
   * 起こせた、または利用者が先に再開していたときは、結び付けを消す。
   * 動いていて渡せなかったとき、渡すのに失敗したときは、履歴に書く。
   * 結び付けは、PR がまだ開いているときだけ残す。
   * final（merged か closed）のときは、もう次の事実が来ないので、履歴を書いてから消す。
   */
  private async wake(b: BindingRow, facts: EventFacts, final: boolean): Promise<void> {
    if (b.action.kind !== 'wake' || this.waking.has(b.id)) return;
    this.waking.add(b.id);
    const { db } = this.d;
    try {
      const sessionId = b.action.sessionId;
      const prompt = renderEventPrompt(b, [facts], this.d.language(), await this.me());
      const record = (result: 'skipped' | 'failed', error?: string): void => {
        const runId = addEventRun(db, { bindingId: b.id, now: this.d.now(), result: 'running' });
        finishEventRun(db, runId, { now: this.d.now(), result, ...(error ? { error } : {}) });
      };
      let got: Awaited<ReturnType<typeof wakePaused>>;
      try {
        got = await wakePaused({ db, deviceId: this.d.deviceId, deliver: (id, text) => this.d.launch({ prompt: text, target: { kind: 'session', sessionId: id }, plannedAt: this.d.now() }) }, sessionId, () => prompt);
      } catch (e) {
        record('failed', errText(e));
        if (final) this.giveUpWake(b, sessionId);
        return;
      }
      if (got === 'busy') {
        record('skipped');
        if (final) this.giveUpWake(b, sessionId);
        return;
      }
      if (got === 'woken') {
        try { this.d.onWoken?.(sessionId); } catch (e) { this.d.onError?.(e); }
      }
      // 起こした、または利用者が先に再開していた。
      // どちらも役目は終わり。
      deleteBinding(db, b.id, this.d.now());
      this.released();
    } finally {
      this.waking.delete(b.id);
    }
  }

  /**
   * 閉じた PR の起こすが失敗した。
   * もう次の事実が来ないので、会話の名前を添えて知らせ、結び付けを消す。
   */
  private giveUpWake(b: BindingRow, sessionId: string): void {
    try {
      const title = sessionTitleOf(this.d.db, sessionId) || sessionId;
      this.d.notify?.(t(this.d.language(), 'schedules.event.wakeFailed', { title }));
    } catch (e) {
      this.d.onError?.(e);
    }
    deleteBinding(this.d.db, b.id, this.d.now());
    this.released();
  }

  /**
   * 送る、作る系の事実を、動いている回があれば溜め、無ければ新しく流す。
   * PR の持ち主へ送るは PR ごとに分ける。
   */
  private enqueue(b: BindingRow, facts: EventFacts[]): void {
    const groups = new Map<string, EventFacts[]>();
    for (const f of facts) {
      const key = b.action.kind === 'send_pr_owner' ? `${b.id}#${f.number ?? ''}` : b.id;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const [key, group] of groups) {
      const unit = this.units.get(key);
      if (unit) { unit.pending.push(...group); continue; }
      const fresh: Unit = { pending: [] };
      this.units.set(key, fresh);
      this.track(this.drain(key, b.id, fresh, group));
    }
  }

  private async drain(key: string, bindingId: string, unit: Unit, first: EventFacts[]): Promise<void> {
    try {
      let batch = first;
      while (batch.length > 0) {
        const b = getBindingRow(this.d.db, bindingId);
        if (!b || b.state !== 'active') break;
        if (this.overCap(b)) break;
        await this.runOnce(b, batch);
        batch = unit.pending.splice(0);
      }
    } finally {
      this.units.delete(key);
    }
  }

  /**
   * 1 時間の回数を数え、上限に達していたら結び付けを held にして知らせる。
   * 流してよいときは回数を 1 つ足して false。
   */
  private overCap(b: BindingRow): boolean {
    const now = this.d.now();
    const list = (this.recent.get(b.id) ?? []).filter((at) => at > now - HOUR_MS);
    if (list.length < EVENT_HOURLY_MAX) {
      this.recent.set(b.id, [...list, now]);
      return false;
    }
    // 止めたら数えを空にする。
    // 利用者が再開したときに、同じ 1 時間の数えで、すぐ止め直されないようにする。
    this.recent.delete(b.id);
    updateBinding(this.d.db, b.id, { state: 'held' }, now);
    const runId = addEventRun(this.d.db, { bindingId: b.id, now, result: 'running' });
    finishEventRun(this.d.db, runId, { now, result: 'skipped', error: 'held:hourly' });
    try { this.d.notify?.(t(this.d.language(), 'schedules.event.heldHourly', { max: EVENT_HOURLY_MAX })); } catch (e) { this.d.onError?.(e); }
    return true;
  }

  private targetOf(b: BindingRow, batch: EventFacts[]): ScheduleTarget | null {
    const a = b.action;
    if (a.kind === 'send') return { kind: 'session', sessionId: a.sessionId };
    if (a.kind === 'new') return a;
    if (a.kind !== 'send_pr_owner' || b.source.kind !== 'github') return null;
    const number = batch[batch.length - 1]?.number ?? b.source.pr;
    const owner = number === undefined ? null : prOwner(this.d.db, b.source.repo, number);
    return owner ? { kind: 'session', sessionId: owner } : null;
  }

  /**
   * 1 回を流す。
   * runner.fire と同じ順で履歴に書く。
   */
  private async runOnce(b: BindingRow, batch: EventFacts[]): Promise<void> {
    const { db } = this.d;
    const now = this.d.now();
    const runId = addEventRun(db, { bindingId: b.id, now, result: 'running' });
    const finish = (o: { result: ScheduleOutcome['result'] | 'skipped'; error?: string }): void => finishEventRun(db, runId, { now: this.d.now(), ...o });
    try {
      const target = this.targetOf(b, batch);
      if (!target) { finish({ result: 'skipped', error: 'no_destination' }); return; }
      const prompt = renderEventPrompt(b, batch, this.d.language(), await this.me());
      const got = await this.d.launch({ prompt, target, plannedAt: now });
      if (got === 'busy') { finish({ result: 'skipped' }); return; }
      setEventRunSession(db, runId, got.sessionId);
      const o = await this.d.wait(got.sessionId);
      finish({ result: o.result, ...(o.error ? { error: o.error } : {}) });
    } catch (e) {
      finish({ result: 'failed', error: errText(e) });
    }
  }
}
