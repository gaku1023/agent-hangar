import { createHash } from 'node:crypto';
import { aadFeed, fitFeed, seal, type MobileFeed } from '@agent-hangar/shared';
import { CloudError, type CloudClient } from '../sync/client.ts';
import type { Timers } from '../sync/engine.ts';
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
  private chain: Promise<unknown> = Promise.resolve();
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
    return 'written';
  }
}
