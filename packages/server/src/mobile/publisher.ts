import { createHash } from 'node:crypto';
import { aadFeed, deriveMobileKey, fitFeed, seal, type MobileFeed } from '@agent-hangar/shared';
import type { CloudClient } from '../sync/client.ts';
import type { Timers } from '../sync/engine.ts';

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
  joinSecret: string;
  deviceId: string;
  timers: Timers;
  /** 書いてよいか（boot/sync.ts の canCarryMobile）。偽のあいだは何も書かず、中身も覚えない。 */
  canWrite: () => boolean;
  /** 今の時刻。既定は Date.now。 */
  now?: () => number;
  /** 書き込みの失敗の受け手。既定はログに 1 行。 */
  onError?: (e: unknown) => void;
};

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

/**
 * 参加の秘密からスマホ用の鍵を導く。同じ秘密なら前に導いた鍵を返す（HKDF を毎回回さない）。
 * 覚えるのは最後の 1 つだけである。秘密を作り直したときは開き直しで新しい秘密になる。
 */
export function mobileKeyFor(joinSecret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === joinSecret) return cachedKey.key;
  const key = deriveMobileKey(joinSecret);
  const entry = { secret: joinSecret, key };
  cachedKey = entry;
  // 導けなかったときは覚えない。次の呼び出しで導き直す。
  key.catch(() => { if (cachedKey === entry) cachedKey = null; });
  return key;
}

/** ログに出すのは種類だけにする。本文や秘密を含む文をそのまま出さない。 */
const defaultOnError = (e: unknown): void => {
  const status = (e as { status?: unknown } | null)?.status;
  console.error('[mobile] could not write the mobile feed; will retry on the next change', e instanceof Error ? e.constructor.name : typeof e, typeof status === 'number' ? status : '');
};

/**
 * 受信箱の素を封じて Worker に置く（PUT /m/feed）。
 *
 * 書くのは、中身（暗号化の前の JSON）のハッシュが前に書いたものと違うときと、前に書いてから FEED_REFRESH_MS たったときだけである。
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

  /** 前に書いた中身を忘れる。次の書き込みは、中身が同じでも書く（新しくつながったスマホに今の素を置く）。 */
  forget(): void {
    this.lastHash = null;
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
    if (this.stopped || !put || !this.deps.canWrite()) return 'skipped';
    // 48 KiB を超えたら、done、returns、projects、待っていない live の順に古いものから落とし、live の文を詰める（shared の fitFeed）。
    const feed = fitFeed(this.deps.build());
    const hash = createHash('sha256').update(JSON.stringify(feed)).digest('hex');
    const now = (this.deps.now ?? Date.now)();
    if (hash === this.lastHash && now - this.lastWrittenAt < FEED_REFRESH_MS) return 'unchanged';
    const sealed = await seal(await mobileKeyFor(this.deps.joinSecret), aadFeed(this.deps.deviceId), feed);
    if (this.stopped) return 'skipped';
    // 通っても倒れても、Worker に要求を 1 本出したら間を空ける。
    this.startGap();
    await put(sealed);
    this.lastHash = hash;
    this.lastWrittenAt = now;
    return 'written';
  }
}
