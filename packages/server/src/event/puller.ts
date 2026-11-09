import { EVENT_INBOX_ACK_MAX, openFromInbox, type EventFacts, type EventInboxItem, type InboxParcel, type ScheduleRunResult } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { CloudError } from '../sync/client.ts';
import type { InboxApi } from './inboxClient.ts';
import { CheckSuiteTracker, normalizeGithub, verifyGithubSignature } from './normalize.ts';
import { addEventRun, bindingsForInbox, finishEventRun, markDelivery, type BindingRow } from './store.ts';

/**
 * 受け箱から荷物を取りに行き、開き、確かめ、事実に直す（#563）。
 *
 * 取った荷物は 1 通ずつ次の順で扱う。
 * 1. 受け箱に結び付けが無ければ、何もせず ack する。
 * 2. 受け箱の秘密鍵で開く。開けなければ unparsable として結び付けの履歴に残す。
 * 3. GitHub の受け箱は、結び付けごとに hook の秘密の値で署名を確かめる。合わなければ signature として履歴に残す。
 *    続けて x-github-delivery で再送を弾く（結び付けごとに覚える）。配送の ID が無い荷物は、再送と見分けられないので unparsable にする。
 * 4. 外の webhook の受け箱には署名も配送の ID も無いので、確かめずに本文をそのまま事実にする。
 * 5. 受け入れた荷物の本文を JSON として読み、normalizeGithub で事実にする。扱わない種類は何も出さない。
 * 断った荷物も ack する。ack しないと、同じ荷物を何度も取り直すことになる。
 *
 * 取り方は、空のページが返るまで「取る、渡す、ack する」を繰り返す。1 ページは EVENT_INBOX_PULL_PAGE 通で、ack は 1 回に EVENT_INBOX_ACK_MAX 通までである。
 * 溢れた数（dropped）は、その受け箱の結び付けの履歴に `dropped:<数>` で残す。ack で Worker の数が 0 に戻る。
 * 同時に 2 つは走らせない。走っている間に頼まれた分は、まとめて 1 巡だけ後に回す。
 * 受け箱の ID と秘密鍵はログに出さない。ログに出すのは例外の名前だけである。
 * pull は投げない。失敗したら、そこまでに出したものを返して巡を閉じる。取れなかった荷物は Worker に残り、次の取得で拾う。
 */

/** 結び付けへ渡すもの。rejected は、荷物を受け入れなかった印（履歴にも残してある）。 */
export type PulledEvent =
  | { bindingId: string; facts: EventFacts; atStart: boolean }
  | { bindingId: string; rejected: 'signature' | 'unparsable' };

export type EventPullerDeps = {
  db: Db;
  /** 今の受け箱の口。同期が組み直されると別のものになるので、毎回引く。使えないとき（クラウド未設定、口の無い client）は null。 */
  api: () => Pick<InboxApi, 'pendingParcels' | 'ackParcels'> | null;
  /**
   * 1 ページ分の結果を渡す。ack の前に呼ぶ。投げても、取得は続ける。
   * 事実を結び付けに当てて動かす側（Task 5 の dispatcher）が受ける。
   */
  onPulled?: (events: PulledEvent[]) => void;
  /** 今の PC の gh のユーザー名。 */
  me?: () => string;
  now?: () => number;
  /** 失敗の知らせ。既定は例外の名前だけを console.error に出す。 */
  onError?: (e: unknown) => void;
};

type Reason = 'bell' | 'start';

/** 履歴の error 欄に入れる、機械が読む印。画面の文言は、画面を作る側が鍵から引く。 */
const REJECTED = (why: 'signature' | 'unparsable'): string => `rejected:${why}`;
const DROPPED = (count: number): string => `dropped:${count}`;

export class EventPuller {
  private current: Promise<PulledEvent[]> | null = null;
  private queued: { atStart: boolean; promise: Promise<PulledEvent[]> } | null = null;
  /** 荷物をまたいで、チェックスイートが全部終わったかを数える。 */
  private readonly suites = new CheckSuiteTracker();

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
        this.noteDropped(page.dropped);
        const events: PulledEvent[] = [];
        for (const item of items) events.push(...(await this.handle(item, atStart)));
        if (events.length > 0) {
          out.push(...events);
          try { this.deps.onPulled?.(events); } catch (e) { this.fail(e); }
        }
        const ids = items.map((i) => i.id);
        for (let at = 0; at < ids.length; at += EVENT_INBOX_ACK_MAX) await api.ackParcels(ids.slice(at, at + EVENT_INBOX_ACK_MAX));
      }
    } catch (e) {
      this.fail(e);
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

  private reject(b: BindingRow, why: 'signature' | 'unparsable'): PulledEvent {
    this.record(b, 'failed', REJECTED(why));
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

  private async handle(item: EventInboxItem, atStart: boolean): Promise<PulledEvent[]> {
    const bindings = bindingsForInbox(this.deps.db, item.inboxId);
    if (bindings.length === 0) return [];
    const parcel = await this.open(bindings, item);
    if (!parcel) return bindings.map((b) => this.reject(b, 'unparsable'));

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
      else out.push(this.reject(b, 'signature'));
    }
    if (signed.length === 0) return out;

    // 配送の ID で再送を弾く。ID の無い荷物は、再送かどうか分からないので受けない。
    const delivery = parcel.headers['x-github-delivery'];
    if (!delivery) {
      for (const b of signed) out.push(this.reject(b, 'unparsable'));
      return out;
    }
    const now = this.now();
    const fresh = signed.filter((b) => markDelivery(this.deps.db, b.id, delivery, now));
    if (fresh.length === 0) return out;

    const eventName = parcel.headers['x-github-event'];
    let payload: unknown;
    try {
      payload = JSON.parse(parcel.body);
    } catch {
      payload = undefined;
    }
    if (!eventName || payload === undefined) {
      for (const b of fresh) out.push(this.reject(b, 'unparsable'));
      return out;
    }
    // 荷物 1 通につき 1 回だけ事実に直す（チェックスイートの数えを、結び付けの数だけ進めない）。
    const facts = normalizeGithub(eventName, payload, this.deps.me?.() ?? '', { receivedAt: parcel.receivedAt, suites: this.suites });
    if (!facts) return out;
    for (const b of fresh) out.push({ bindingId: b.id, atStart, facts: { ...facts } });
    return out;
  }
}
