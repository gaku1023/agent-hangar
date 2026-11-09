import { EVENT_INBOX_ACK_MAX, openFromInbox, type EventFacts, type EventInboxItem, type InboxParcel, type ScheduleRunResult } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { captureOutput, type CaptureOptions, type Captured } from '../platform/capture.ts';
import { needsShell } from '../platform/exec.ts';
import { findTool } from '../report/real.ts';
import { CloudError } from '../sync/client.ts';
import type { InboxApi } from './inboxClient.ts';
import { checkSuiteRef, normalizeGithub, outcomeOf, verifyGithubSignature } from './normalize.ts';
import { addEventRun, bindingsForInbox, finishEventRun, hasDelivery, markDelivery, type BindingRow } from './store.ts';

/**
 * 受け箱から荷物を取りに行き、開き、確かめ、事実に直す（#563）。
 *
 * 取った荷物は 1 通ずつ次の順で扱う。
 * 1. 受け箱に結び付けが無ければ、何もせず ack する。
 * 2. 受け箱の秘密鍵で開く。開けなければ unparsable として扱う。
 * 3. GitHub の受け箱は、結び付けごとに hook の秘密の値で署名を確かめる。合わなければ signature として扱う。
 *    続けて x-github-delivery で再送を弾く（結び付けごとに覚えている配送の ID と比べる）。配送の ID が無い荷物は、再送と見分けられないので unparsable にする。
 * 4. 外の webhook の受け箱には署名も配送の ID も無いので、確かめずに本文をそのまま事実にする。
 * 5. 受け入れた荷物の本文を JSON として読み、normalizeGithub で事実にする。扱わない種類は何も出さない。
 *    check_suite の completed は、同じ head の SHA のスイートを GitHub に問い合わせ（gh api）、全部終わったときだけ 1 件の ci_done にする。
 * 断った荷物も ack する。ack しないと、同じ荷物を何度も取り直すことになる。
 *
 * 取り方は、空のページが返るまで「取る、渡す、ack する」を繰り返す。1 ページは EVENT_INBOX_PULL_PAGE 通で、ack は 1 回に EVENT_INBOX_ACK_MAX 通までである。
 * 取りこぼさないため、覚えること（配送の ID、CI の済みの印、履歴の記録、溢れた数）は、そのページを onPulled が受け取ってから行う。
 * onPulled が投げたら、そのページは ack せず、覚えもせずに巡を止める。荷物は Worker に残り、次の取得でやり直す。
 * 断った荷物の履歴は、1 巡のあいだ結び付けごとに数え、巡の終わりに `rejected:<理由> x<数>` の 1 件にまとめる。偽の荷物が履歴の 5 件を押し出さないため。
 * 溢れた数（dropped）は、その受け箱の結び付けの履歴に `dropped:<数>` で残す。ack で Worker の数が 0 に戻る。
 * 同時に 2 つは走らせない。走っている間に頼まれた分は、まとめて 1 巡だけ後に回す。
 * 受け箱の ID と秘密鍵はログに出さない。ログに出すのは例外の名前だけである。
 * pull は投げない。失敗したら、そこまでに出したものを返して巡を閉じる。
 */

/** 結び付けへ渡すもの。rejected は、荷物を受け入れなかった印（履歴にも残してある）。 */
export type PulledEvent =
  | { bindingId: string; facts: EventFacts; atStart: boolean }
  | { bindingId: string; rejected: 'signature' | 'unparsable' };

/** GitHub の API を gh で呼ぶ口。apiPath は `repos/...` の形で、JSON を読んで返す。投げたら、呼び手は代わりの道に回る。 */
export type GhApi = (apiPath: string) => Promise<unknown>;

export type EventPullerDeps = {
  db: Db;
  /** 今の受け箱の口。同期が組み直されると別のものになるので、毎回引く。使えないとき（クラウド未設定、口の無い client）は null。 */
  api: () => Pick<InboxApi, 'pendingParcels' | 'ackParcels'> | null;
  /**
   * 1 ページ分の結果を渡す。ack の前に呼ぶ。投げたら、そのページは ack も記録もせずに巡を止める。
   * 事実を結び付けに当てて動かす側（Task 5 の dispatcher）が受ける。
   */
  onPulled?: (events: PulledEvent[]) => void;
  /** 今の PC の gh のユーザー名。 */
  me?: () => string;
  now?: () => number;
  /** 失敗の知らせ。既定は例外の名前だけを console.error に出す。 */
  onError?: (e: unknown) => void;
  /** CI の全スイートを見るための GitHub の口。既定は gh を探して呼ぶ。試験が差し替える。 */
  ghApi?: GhApi;
};

type Reason = 'bell' | 'start';

/** 履歴の error 欄に入れる、機械が読む印。画面の文言は、画面を作る側が鍵から引く。 */
const REJECTED = (why: 'signature' | 'unparsable', n: number): string => `rejected:${why} x${n}`;
const DROPPED = (count: number): string => `dropped:${count}`;

/** gh api の失敗。メッセージに受け箱や秘密は入れない。 */
class GhError extends Error {}

const GH_TIMEOUT_MS = 20_000;
type Capture = (file: string, args: string[], o: CaptureOptions) => Promise<Captured>;

/** gh を呼ぶたびに探して、API を叩く。見つからない、失敗した、JSON でないときは投げる。 */
export function ghApiRunner(env: NodeJS.ProcessEnv = process.env, capture: Capture = captureOutput): GhApi {
  return async (apiPath) => {
    const bin = findTool('gh', env);
    if (!bin) throw new GhError('gh not found');
    const r = await capture(bin, ['api', apiPath], { timeoutMs: GH_TIMEOUT_MS, env, shell: needsShell(bin) });
    if (r.code !== 0) throw new GhError(`gh exited with ${r.code}`);
    try {
      return JSON.parse(r.stdout) as unknown;
    } catch {
      throw new GhError('gh printed no JSON');
    }
  };
}

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;
/** まだ終わっていないスイートの status。 */
const OPEN_STATUSES: ReadonlySet<string> = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
const WORST = { success: 0, cancelled: 1, failure: 2 } as const;
/** CI を 1 件にまとめて出した印を覚える長さ。 */
const CI_MEMO_MS = 24 * 60 * 60_000;

type Verdict = { kind: 'pending' } | { kind: 'none' } | { kind: 'unknown' } | { kind: 'done'; outcome: NonNullable<EventFacts['outcome']>; fingerprint: string };

/**
 * head の SHA のスイートの一覧から、全部終わったかと成否を決める。
 * 一度も動かなかったスイート（latest_check_runs_count が 0）は数えない。
 * 終わっていないものが 1 つでもあれば pending。結論が stale のものは数えず、残りが無ければ none。
 * 失敗（failure、timed_out、知らない結論）が 1 つでもあれば failure、無くて cancelled があれば cancelled、それ以外は success（neutral と skipped は success）。
 * fingerprint は、数えたスイートの (id, conclusion, updated_at) を並べ順によらず固めたもの。
 * 一覧の形が読めないとき、動いたスイートが 1 つも無いときは unknown で、呼び手は完了したスイート 1 つの結果に戻る。
 */
export function judgeSuites(listing: unknown): Verdict {
  const suites = typeof listing === 'object' && listing !== null ? (listing as { check_suites?: unknown }).check_suites : undefined;
  if (!Array.isArray(suites)) return { kind: 'unknown' };
  const ran = suites.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && (s as { latest_check_runs_count?: unknown }).latest_check_runs_count !== 0);
  if (ran.length === 0) return { kind: 'unknown' };
  if (ran.some((s) => typeof s.status !== 'string' ? s.conclusion == null : OPEN_STATUSES.has(s.status))) return { kind: 'pending' };
  const counted = ran.filter((s) => s.conclusion !== 'stale');
  if (counted.length === 0) return { kind: 'none' };
  let outcome: NonNullable<EventFacts['outcome']> = 'success';
  for (const s of counted) {
    const o = outcomeOf(s.conclusion);
    if (WORST[o] > WORST[outcome]) outcome = o;
  }
  // 同じ結果をもう一度出さないための指紋。再実行すると、スイートの updated_at と結論が変わる。
  const fingerprint = JSON.stringify(counted.map((s) => [s.id, s.conclusion, s.updated_at]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  return { kind: 'done', outcome, fingerprint };
}

/** 1 ページのあいだに集める、渡し終えてから行うこと。 */
type Page = {
  /** このページの中で見た配送（結び付け ID と配送の ID）。同じページに再送が並んでも 1 回だけ出す。 */
  delivered: Set<string>;
  /** このページで出した CI の指紋（受け箱、repo、SHA ごと）と、gh を使えず 1 つで出したスイートの印。 */
  ci: Map<string, string>;
  commits: (() => void)[];
};

export class EventPuller {
  private current: Promise<PulledEvent[]> | null = null;
  private queued: { atStart: boolean; promise: Promise<PulledEvent[]> } | null = null;
  /**
   * 出した CI の印。メモリだけで持ち、CI_MEMO_MS で忘れる。
   * 受け箱、repo、SHA ごとに、最後に出したスイートの指紋を覚える。同じ指紋なら出さない（近くで 2 回完了しても 1 件）。再実行で指紋が変われば、また出す。
   * gh を使えず 1 つで出したときは、受け箱、repo、SHA、スイートの ID ごとに覚える。
   */
  private readonly ciMemo = new Map<string, { fingerprint: string; at: number }>();
  /** 1 巡のあいだに断った荷物の数（結び付けと理由ごと）。巡の終わりに履歴へ 1 件ずつ書く。 */
  private rejected = new Map<string, { binding: BindingRow; why: 'signature' | 'unparsable'; count: number }>();

  constructor(private readonly deps: EventPullerDeps) {}

  /**
   * 取りに行く。結果は、この巡で出した事実と断った印の全部（ページごとの分は onPulled にも渡している）。
   * 走っている巡があれば、その後ろに 1 巡だけ足し、同じ頼みはその 1 巡を分け合う。
   * reason が start の頼みが混ざった巡は、事実に atStart を付ける。
   */
  pull(reason: Reason): Promise<PulledEvent[]> {
    if (this.queued) {
      if (reason === 'start') this.queued.atStart = true;
      return this.queued.promise;
    }
    if (!this.current) return this.run(reason);
    const q: { atStart: boolean; promise: Promise<PulledEvent[]> } = { atStart: reason === 'start', promise: undefined as unknown as Promise<PulledEvent[]> };
    q.promise = this.current.then(() => undefined).then(() => {
      this.queued = null;
      return this.run(q.atStart ? 'start' : 'bell');
    });
    this.queued = q;
    return q.promise;
  }

  private run(reason: Reason): Promise<PulledEvent[]> {
    const p = this.pass(reason === 'start').finally(() => { if (this.current === p) this.current = null; });
    this.current = p;
    return p;
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private fail(e: unknown): void {
    // 版 12 より前の Worker は口を知らず 404 を返す。使えないだけなので、知らせない。
    if (e instanceof CloudError && e.status === 404) return;
    try {
      (this.deps.onError ?? ((x: unknown) => { console.error('[event] could not pull the inbox', x instanceof Error ? x.constructor.name : typeof x); }))(e);
    } catch { /* 知らせの失敗は捨てる */ }
  }

  /** 結び付けが 1 つも無い PC は、Worker に問い合わせない。呼び鈴を張るかどうかの判断にも使う。 */
  hasBindings(): boolean {
    return this.deps.db.prepare('select 1 from event_bindings limit 1').get() !== undefined;
  }

  private async pass(atStart: boolean): Promise<PulledEvent[]> {
    const out: PulledEvent[] = [];
    this.rejected = new Map();
    try {
      const api = this.deps.api();
      if (!api || !this.hasBindings()) return out;
      const seen = new Set<string>();
      for (;;) {
        const page = await api.pendingParcels();
        if (page.items.length === 0) {
          // 荷物は無いが、溢れた数が残っているなら、記録して数を戻す。
          if (page.dropped.length > 0) {
            this.noteDropped(page.dropped);
            await api.ackParcels([]);
          }
          break;
        }
        const items = page.items.filter((i) => !seen.has(i.id));
        // ack が効かず同じ荷物が戻り続けるときに、巡を終えられなくなるのを避ける。
        if (items.length === 0) break;
        for (const i of items) seen.add(i.id);
        const pg: Page = { delivered: new Set(), ci: new Map(), commits: [] };
        const events: PulledEvent[] = [];
        for (const item of items) events.push(...(await this.handle(item, atStart, pg)));
        if (events.length > 0) {
          try {
            this.deps.onPulled?.(events);
          } catch (e) {
            // 受け取れなかったページは、覚えも ack もしない。次の取得でやり直す。
            this.fail(e);
            return out;
          }
          out.push(...events);
        }
        for (const commit of pg.commits) commit();
        this.noteDropped(page.dropped);
        const ids = items.map((i) => i.id);
        for (let at = 0; at < ids.length; at += EVENT_INBOX_ACK_MAX) await api.ackParcels(ids.slice(at, at + EVENT_INBOX_ACK_MAX));
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.flushRejected();
    }
    return out;
  }

  private noteDropped(dropped: { inboxId: string; count: number }[]): void {
    for (const d of dropped) {
      for (const b of bindingsForInbox(this.deps.db, d.inboxId)) this.record(b, 'skipped', DROPPED(d.count));
    }
  }

  /** 結び付けの履歴に 1 件残す。 */
  private record(b: BindingRow, result: ScheduleRunResult, error: string): void {
    const now = this.now();
    const id = addEventRun(this.deps.db, { bindingId: b.id, now, result });
    finishEventRun(this.deps.db, id, { now, result, error });
  }

  /** 断った荷物の数を、巡の終わりに結び付けと理由ごとの 1 件にして書く。 */
  private flushRejected(): void {
    const all = [...this.rejected.values()];
    this.rejected = new Map();
    for (const r of all) {
      try { this.record(r.binding, 'failed', REJECTED(r.why, r.count)); } catch (e) { this.fail(e); }
    }
  }

  /** 荷物を断る。履歴の数え上げは、ページを渡し終えてから。 */
  private reject(b: BindingRow, why: 'signature' | 'unparsable', pg: Page): PulledEvent {
    pg.commits.push(() => {
      const key = `${b.id}|${why}`;
      const cur = this.rejected.get(key);
      if (cur) cur.count++;
      else this.rejected.set(key, { binding: b, why, count: 1 });
    });
    return { bindingId: b.id, rejected: why };
  }

  /** 秘密鍵を 1 つずつ試して開く。受け箱の結び付けは同じ鍵の対を持つのが普通で、違っても全部試す。 */
  private async open(bindings: BindingRow[], item: EventInboxItem): Promise<InboxParcel | null> {
    const keys = [...new Set(bindings.map((b) => b.inboxPrivateKey))];
    for (const key of keys) {
      try {
        return await openFromInbox(key, item.inboxId, item.sealed);
      } catch {
        // この鍵では開けない。理由は残さない（鍵にも受け箱にも関わる）。
      }
    }
    return null;
  }

  private async handle(item: EventInboxItem, atStart: boolean, pg: Page): Promise<PulledEvent[]> {
    const bindings = bindingsForInbox(this.deps.db, item.inboxId);
    if (bindings.length === 0) return [];
    const parcel = await this.open(bindings, item);
    if (!parcel) return bindings.map((b) => this.reject(b, 'unparsable', pg));

    const out: PulledEvent[] = [];
    const github = bindings.filter((b) => b.source.kind === 'github');
    const hooks = bindings.filter((b) => b.source.kind === 'hook');

    for (const b of hooks) {
      out.push({ bindingId: b.id, atStart, facts: { source: 'hook', event: 'hook', body: parcel.body, receivedAt: parcel.receivedAt } });
    }
    if (github.length === 0) return out;

    // 署名の合った結び付けだけが残る。
    const signed: BindingRow[] = [];
    for (const b of github) {
      if (b.hookSecret && verifyGithubSignature(b.hookSecret, parcel.body, parcel.headers['x-hub-signature-256'])) signed.push(b);
      else out.push(this.reject(b, 'signature', pg));
    }
    if (signed.length === 0) return out;

    // 配送の ID で再送を弾く。ID の無い荷物は、再送かどうか分からないので受けない。
    // 覚えるのは、ページを渡し終えてから（commits）。ここでは見るだけにする。
    const delivery = parcel.headers['x-github-delivery'];
    if (!delivery) {
      for (const b of signed) out.push(this.reject(b, 'unparsable', pg));
      return out;
    }
    const now = this.now();
    const fresh = signed.filter((b) => {
      const key = `${b.id}|${delivery}`;
      if (pg.delivered.has(key) || hasDelivery(this.deps.db, b.id, delivery, now)) return false;
      pg.delivered.add(key);
      pg.commits.push(() => { markDelivery(this.deps.db, b.id, delivery, now); });
      return true;
    });
    if (fresh.length === 0) return out;

    const eventName = parcel.headers['x-github-event'];
    let payload: unknown;
    try {
      payload = JSON.parse(parcel.body);
    } catch {
      payload = undefined;
    }
    if (!eventName || payload === undefined) {
      for (const b of fresh) out.push(this.reject(b, 'unparsable', pg));
      return out;
    }
    // 荷物 1 通につき 1 回だけ事実に直す。
    let facts = normalizeGithub(eventName, payload, this.deps.me?.() ?? '', { receivedAt: parcel.receivedAt });
    if (facts && eventName === 'check_suite') facts = await this.settleCi(item.inboxId, facts, payload, pg);
    if (!facts) return out;
    for (const b of fresh) out.push({ bindingId: b.id, atStart, facts: { ...facts } });
    return out;
  }

  /**
   * 完了したスイート 1 つの ci_done を、head の SHA の全スイートが終わったときの 1 件にする。
   * GitHub が repo の webhook に送る check_suite は completed だけなので、残りのスイートは gh api で問い合わせる。
   * まだ終わっていないものがあれば何も出さず（あとの completed が来る）、結論がすべて stale でも出さない。
   * 出すのは、数えたスイートの指紋が、(受け箱, repo, SHA) で最後に出したものと違うときだけにする。
   * 近くで 2 回完了しても指紋は同じなので 1 件になり、失敗のあとの再実行は指紋が変わるので、また出る。
   * 印は CI_MEMO_MS のあいだメモリに持ち、渡し終えてから付ける。
   * gh が無い、失敗した、一覧が読めないときは、完了したスイート 1 つの結果のまま出す。ログに出すのは例外の名前だけ。
   * そのときは (受け箱, repo, SHA, スイートの ID) ごとに 1 度だけ出す。
   */
  private async settleCi(inboxId: string, facts: EventFacts, payload: unknown, pg: Page): Promise<EventFacts | null> {
    const ref = checkSuiteRef(payload);
    if (!ref || !REPO_RE.test(ref.repo) || !SHA_RE.test(ref.sha)) return facts;
    const key = `${inboxId}|${ref.repo}|${ref.sha}`;
    const now = this.now();
    for (const [k, m] of this.ciMemo) if (now - m.at > CI_MEMO_MS) this.ciMemo.delete(k);
    /** 指紋が前に出したものと同じ（または同じページで出した）なら、出さない。出すなら、渡し終えてから覚える。 */
    const emit = (memoKey: string, fingerprint: string, out: EventFacts): EventFacts | null => {
      const last = pg.ci.get(memoKey) ?? this.ciMemo.get(memoKey)?.fingerprint;
      if (last === fingerprint) return null;
      pg.ci.set(memoKey, fingerprint);
      pg.commits.push(() => { this.ciMemo.set(memoKey, { fingerprint, at: now }); });
      return out;
    };
    const single = (): EventFacts | null => emit(`${key}|suite:${ref.suiteId}`, '', facts);
    let verdict: Verdict;
    try {
      verdict = judgeSuites(await (this.deps.ghApi ?? ghApiRunner())(`repos/${ref.repo}/commits/${ref.sha}/check-suites?per_page=100`));
    } catch (e) {
      console.error('[event] could not read the check suites', e instanceof Error ? e.constructor.name : typeof e);
      return single();
    }
    if (verdict.kind === 'pending' || verdict.kind === 'none') return null;
    if (verdict.kind === 'unknown') return single();
    return emit(key, verdict.fingerprint, { ...facts, outcome: verdict.outcome });
  }
}
