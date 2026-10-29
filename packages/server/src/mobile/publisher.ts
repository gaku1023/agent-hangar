import { createHash } from 'node:crypto';
import { aadFeed, fitFeed, seal, sealPhoneNotice, type MobileFeed } from '@agent-hangar/shared';
import { CloudError, type CloudClient } from '../sync/client.ts';
import type { Timers } from '../sync/engine.ts';
import type { PhoneKey } from '../sync/keyring.ts';
import type { PhoneKeySource } from '../sync/phoneKeys.ts';

/** 変化のあと、まとめて書くまでの待ち。 */
export const FEED_DEBOUNCE_MS = 2_000;
/** 同じ PC からの書き込みの最短の間。 */
export const FEED_MIN_GAP_MS = 15_000;
/** きっかけを取りこぼしても書き直す、安全網の間隔。 */
export const FEED_SAFETY_MS = 60_000;
/**
 * 中身が同じでも書き直す間隔。スマホは更新が 7 日より古い素を、去った PC のものとして隠す（packages/mobile の inbox.ts）。
 * 動きの無い PC でも消えないよう、1 日に 1 回は置き直す（PC 1 台につき 1 日 1 行）。
 */
export const FEED_REFRESH_MS = 24 * 60 * 60_000;

/** 未読の知らせ（notify_user）を、同じ会話ごとに 1 通へまとめる待ち。 */
export const UNREAD_COALESCE_MS = 3_000;
/** 1 回のまとめで送る未読の通知の数の上限。Worker は 1 台の PC から 1 分に 10 回までなので、入力待ちの分を残す。超えた分は捨てる（未読の数は手元に残る）。 */
export const UNREAD_MAX_PER_BATCH = 5;

export type FeedWriteResult = 'written' | 'unchanged' | 'skipped';

export type MobileFeedPublisherDeps = {
  /** 受信箱の素を組む（mobile/feed.ts の buildMobileFeed を包んだもの）。 */
  build: () => MobileFeed;
  client: CloudClient;
  /** スマホ用の鍵 M（名簿の phoneKey）。素は今の世代で封じ、その世代を添えて置く。 */
  phoneKeys: Pick<PhoneKeySource, 'current'>;
  deviceId: string;
  timers: Timers;
  /** 書いてよいか（boot/sync.ts の canCarryMobile）。偽のあいだは何も書かず、中身も覚えない。 */
  canWrite: () => boolean;
  /**
   * 外していないスマホが 1 台以上あるか（boot/mobile.ts が Worker の一覧で知ったもの）。
   * 偽のあいだは、要対応に新しく入った会話があってもスマホへの通知（POST /notices）を送らない。
   */
  hasPhones: () => boolean;
  /** 今の時刻。既定は Date.now。 */
  now?: () => number;
  /** 書き込みの失敗の受け手。既定はログに 1 行。 */
  onError?: (e: unknown) => void;
};

/** ログに出すのは種類だけにする。本文や秘密を含む文をそのまま出さない。 */
const defaultOnError = (e: unknown): void => {
  const status = (e as { status?: unknown } | null)?.status;
  console.error('[mobile] could not write the mobile feed; will retry on the next change', e instanceof Error ? e.constructor.name : typeof e, typeof status === 'number' ? status : '');
};

/**
 * スマホへの通知の失敗を記録する。送り直さない（受信箱の素は別に届く）。
 * 口を知らない古い Worker の 404 と、上限の 429 は、起きて当然のものなので記録しない。
 * ほかの失敗も種類と状態の番号だけを出し、題や PC の名前を含みうる文は出さない。
 */
const noteNoticeError = (e: unknown): void => {
  if (e instanceof CloudError && (e.status === 404 || e.status === 429)) return;
  const status = (e as { status?: unknown } | null)?.status;
  console.error('[mobile] could not send the phone notice', e instanceof Error ? e.constructor.name : typeof e, typeof status === 'number' ? status : '');
};

/** 要対応（スマホの受信箱の「要対応」）に出ている会話。受信箱と同じく、live の status が waiting のものである。 */
const waitingOf = (feed: MobileFeed) => feed.live.filter((l) => l.status === 'waiting');

/**
 * 受信箱の素を封じて Worker に置く（PUT /m/feed）。
 *
 * 封じる鍵はスマホ用の鍵 M の今の世代で、その世代（epoch）を素に添える。スマホは素の世代で M を選んで開く。
 * M がまだ無い（スマホを接続していない）あいだは書かない（skipped）。
 * 書くのは、中身（暗号化の前の JSON）と世代のハッシュが前に書いたものと違うときと、前に書いてから FEED_REFRESH_MS たったときだけである。
 * M の世代が進んだら（スマホの解除）、中身が同じでも新しい世代で書き直す。
 * 封じは IV が毎回乱数なので、封じた文字列のハッシュでは比べられない。
 * nudge は、変化を FEED_DEBOUNCE_MS 待ってまとめ、前の書き込みから FEED_MIN_GAP_MS あくまで次を書かない。
 * 間の中に来た変化は、間が明けたところで 1 回にまとめて書く。
 * 失敗したときはハッシュを覚えないので、次のきっかけで同じ中身でも書き直す。
 * nudge と、タイマーから走る書き込みは投げない。失敗は onError に渡す。
 *
 * 素を書けたら、前に書けた素の要対応の会話と比べ、新しく入った会話があればスマホへ通知を 1 回送る（POST /notices）。
 * 複数なら 1 回にまとめて件数を入れ、題と会話の ID は先に待ち始めた会話のものにする。
 * 通知の中身はスマホ用の鍵 M の今の世代で封じる（shared の sealPhoneNotice）。PC の名前は素の deviceName である。
 * 起動の後で最初に書けた素では送らない（前から要対応だった会話を鳴らさない）。前の集合はメモリにだけ持つ。
 * 同じ会話が要対応を出て、また入れば、もう 1 回送る。スマホが無い（hasPhones が偽）あいだは送らないが、集合は覚え直す。
 * 素の書き込みに失敗したら集合を覚えないので、その回の会話は次に書けたときに知らせる。
 * 通知の失敗は捨てる（noteNoticeError）。素の書き込みの結果は変えない。
 */
export class MobileFeedPublisher {
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private gap: ReturnType<typeof setTimeout> | null = null;
  private safety: ReturnType<typeof setInterval> | null = null;
  /** 間の中に来た変化があるか。 */
  private waiting = false;
  private stopped = false;
  private lastHash: string | null = null;
  private lastWrittenAt = 0;
  /** 受信箱の素を Worker から消した後か（最後のスマホを解除した後）。真のあいだは書かない。forget で解く。 */
  private dropped = false;
  /** 消す要求が済んだか（通った、または口を知らない Worker）。済んだら、forget まで 2 回目を送らない。 */
  private deleted = false;
  /** 前に書けた素で要対応だった会話の ID。起動の後でまだ 1 回も書けていなければ null。 */
  private lastWaiting: Set<string> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** まとめを待っている未読の知らせ。会話の ID ごとに、題、最後の文、回数。 */
  private pendingUnread = new Map<string, { title: string; text: string; n: number }>();
  private unreadTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最後に書けた素の PC の名前。未読の通知の pcName に入れる（まだ書けていなければ空）。 */
  private pcName = '';
  private readonly onError: (e: unknown) => void;

  constructor(private readonly deps: MobileFeedPublisherDeps) {
    this.onError = deps.onError ?? defaultOnError;
  }

  /** 中身が変わったかもしれない、という知らせ。 */
  nudge(): void {
    if (this.stopped) return;
    if (this.gap) { this.waiting = true; return; }
    if (this.debounce) return;
    this.debounce = this.deps.timers.setTimeout(() => { this.debounce = null; this.fire(); }, FEED_DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  /**
   * notify_user の知らせ（出し先に phone を含むもの）を 1 つ預かる。
   * 受信箱の素の書き込み（2 秒のデバウンスと 15 秒の間）とは別に、UNREAD_COALESCE_MS 待って、同じ会話の分を 1 通（kind unread、count は回数、本文は最後の文）にして送る。
   * 入力待ちの比較（lastWaiting）には混ぜない。スマホが無いか、止めた後なら何もしない。投げない。
   */
  noticeUnread(n: { sessionId: string; title: string; text: string }): void {
    if (this.stopped) return;
    const prev = this.pendingUnread.get(n.sessionId);
    this.pendingUnread.set(n.sessionId, { title: n.title, text: n.text, n: (prev?.n ?? 0) + 1 });
    if (this.unreadTimer) return;
    this.unreadTimer = this.deps.timers.setTimeout(() => { this.unreadTimer = null; void this.sendUnread(); }, UNREAD_COALESCE_MS);
    this.unreadTimer.unref?.();
  }

  private async sendUnread(): Promise<void> {
    const batch = [...this.pendingUnread.entries()].slice(0, UNREAD_MAX_PER_BATCH);
    this.pendingUnread = new Map();
    if (this.stopped || batch.length === 0) return;
    try {
      const post = this.deps.client.postNotice?.bind(this.deps.client);
      if (!post || !this.deps.hasPhones()) return;
      const key = await this.deps.phoneKeys.current();
      if (!key) return;
      for (const [sessionId, u] of batch) {
        if (this.stopped) return;
        const sealed = await sealPhoneNotice(key.key, key.epoch, { title: u.title, pcName: this.pcName, sessionId, count: u.n, kind: 'unread', body: u.text });
        await post(sealed, key.epoch);
      }
    } catch (e) {
      noteNoticeError(e);
    }
  }

  /** 前に書いた中身を忘れる。次の書き込みは、中身が同じでも書く（新しくつながったスマホに今の素を置く）。dropFeed の後も、ここで書けるようにする。 */
  forget(): void {
    this.lastHash = null;
    this.dropped = false;
    this.deleted = false;
  }

  /**
   * 最後のスマホを解除した後に、この PC の受信箱の素を Worker から消す（DELETE /m/feed）。以後は forget まで書かない。
   * 走っている書き込みを待ってから消す。消せた（口を知らない古い Worker の 404 と 405 も、消せるものが無いので消せた扱い）か、前に消してあれば true。
   * 倒れたときと client が口を持たないときは false で、消した扱いにしない。呼び手は次の見回りで呼び直す。投げない。
   */
  dropFeed(): Promise<boolean> {
    this.dropped = true;
    const run = this.chain.then(async () => {
      if (this.deleted) return true;
      const del = this.deps.client.deleteMobileFeed?.bind(this.deps.client);
      // 待っているあいだに forget（新しいスマホ）が来たら、消さない。
      if (!del || !this.dropped) return false;
      try {
        await del();
      } catch (e) {
        if (!(e instanceof CloudError && (e.status === 404 || e.status === 405))) {
          this.onError(e);
          return false;
        }
      }
      this.deleted = true;
      this.lastHash = null;
      return true;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 安全網を始め、起動の 1 回を予約する。 */
  start(): void {
    if (this.stopped || this.safety) return;
    this.safety = this.deps.timers.setInterval(() => this.nudge(), FEED_SAFETY_MS);
    this.safety.unref?.();
    this.nudge();
  }

  /** 以後は書かない。走っている書き込みは待たない（終わっても次を予約しない）。 */
  stop(): void {
    this.stopped = true;
    const t = this.deps.timers;
    if (this.debounce) t.clearTimeout(this.debounce);
    if (this.gap) t.clearTimeout(this.gap);
    if (this.safety) t.clearInterval(this.safety);
    this.debounce = this.gap = this.safety = null;
    if (this.unreadTimer) t.clearTimeout(this.unreadTimer);
    this.unreadTimer = null;
    this.pendingUnread = new Map();
    this.waiting = false;
  }

  /**
   * 間引きを通さず、今すぐ 1 回書く（間引きの間は、これの後にも始まる）。
   * 書いてよくないか、client が口を持たなければ skipped。中身が前と同じなら unchanged。
   * 書き込みの失敗はそのまま拒否で返す。書き込みは 1 本ずつ順に走らせる。
   */
  flushNow(): Promise<FeedWriteResult> {
    const run = this.chain.then(() => this.writeOnce());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private fire(): void {
    if (this.stopped) return;
    if (this.gap) { this.waiting = true; return; }
    this.flushNow().catch((e: unknown) => { this.onError(e); });
  }

  private startGap(): void {
    if (this.gap) this.deps.timers.clearTimeout(this.gap);
    this.gap = this.deps.timers.setTimeout(() => {
      this.gap = null;
      if (!this.waiting) return;
      this.waiting = false;
      this.fire();
    }, FEED_MIN_GAP_MS);
    this.gap.unref?.();
  }

  private async writeOnce(): Promise<FeedWriteResult> {
    const put = this.deps.client.putMobileFeed?.bind(this.deps.client);
    if (this.stopped || this.dropped || !put || !this.deps.canWrite()) return 'skipped';
    const key = await this.deps.phoneKeys.current();
    if (!key || this.stopped) return 'skipped';
    // 48 KiB を超えたら、done、returns、projects、待っていない live の順に古いものから落とし、live の文を詰める（shared の fitFeed）。
    const feed = fitFeed(this.deps.build());
    this.pcName = feed.deviceName;
    const hash = createHash('sha256').update(JSON.stringify([key.epoch, feed])).digest('hex');
    const now = (this.deps.now ?? Date.now)();
    if (hash === this.lastHash && now - this.lastWrittenAt < FEED_REFRESH_MS) return 'unchanged';
    const sealed = await seal(key.key, aadFeed(this.deps.deviceId), feed);
    if (this.stopped) return 'skipped';
    // 通っても倒れても、Worker に要求を 1 本出したら間を空ける。
    this.startGap();
    await put(sealed, key.epoch);
    this.lastHash = hash;
    this.lastWrittenAt = now;
    await this.noticeNew(feed, key);
    return 'written';
  }

  /** 書けた素の要対応の会話を覚え直し、新しく入った会話があればスマホへ通知を 1 回送る。投げない。 */
  private async noticeNew(feed: MobileFeed, key: PhoneKey): Promise<void> {
    const waiting = waitingOf(feed);
    const prev = this.lastWaiting;
    this.lastWaiting = new Set(waiting.map((l) => l.sessionId));
    if (prev === null) return;
    const fresh = waiting.filter((l) => !prev.has(l.sessionId)).sort((a, b) => a.statusAt - b.statusAt || a.sessionId.localeCompare(b.sessionId));
    const first = fresh[0];
    if (!first || this.stopped) return;
    try {
      const post = this.deps.client.postNotice?.bind(this.deps.client);
      if (!post || !this.deps.hasPhones()) return;
      const sealed = await sealPhoneNotice(key.key, key.epoch, { title: first.title || first.projectName, pcName: feed.deviceName, sessionId: first.sessionId, count: fresh.length });
      if (this.stopped) return;
      await post(sealed, key.epoch);
    } catch (e) {
      noteNoticeError(e);
    }
  }
}
