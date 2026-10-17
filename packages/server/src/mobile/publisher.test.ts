import { describe, expect, it, vi } from 'vitest';
import { aadFeed, deriveMobileKey, MOBILE_FEED_MAX_BYTES, MOBILE_MIN_WORKER_COMPAT, open, type MobileFeed } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { FEED_DEBOUNCE_MS, FEED_MIN_GAP_MS, FEED_REFRESH_MS, FEED_SAFETY_MS, MobileFeedPublisher, mobileKeyFor } from './publisher.ts';

const SECRET = 'join-secret-for-tests-0123456789abcdef';

const feedOf = (title: string): MobileFeed => ({
  v: 1,
  deviceId: 'pc-a',
  deviceName: 'PC A',
  accounts: [],
  projects: [{ id: 'p1', name: 'project-a', lastUsedAt: null }],
  live: [],
  returns: [],
  done: [{ sessionId: 's1', projectName: 'project-a', title, oneLiner: null, doneAt: 1 }],
});

function setup(o: { canWrite?: () => boolean; minWorkerCompat?: number } = {}) {
  const timers = new FakeTimers();
  const client = new FakeCloudClient({ deviceId: 'pc-a', now: () => timers.now, ...(o.minWorkerCompat !== undefined ? { minWorkerCompat: o.minWorkerCompat } : {}) });
  let feed = feedOf('会話 1');
  const errors: unknown[] = [];
  const pub = new MobileFeedPublisher({
    build: () => feed,
    client,
    joinSecret: SECRET,
    deviceId: 'pc-a',
    timers,
    now: () => timers.now,
    canWrite: o.canWrite ?? (() => true),
    onError: (e) => errors.push(e),
  });
  const writes = (): number => client.calls.filter((c) => c.method === 'putMobileFeed').length;
  return { timers, client, pub, writes, errors, setFeed: (f: MobileFeed) => { feed = f; } };
}

/** 封じは Web Crypto の非同期で、偽の時計の flush では流れ切らないことがあるので、実時間で待つ。 */
const settle = (cond: () => boolean): Promise<void> => vi.waitFor(() => { if (!cond()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });

describe('MobileFeedPublisher', () => {
  it('間隔の定数', () => {
    expect(FEED_DEBOUNCE_MS).toBe(2_000);
    expect(FEED_MIN_GAP_MS).toBe(15_000);
    expect(FEED_SAFETY_MS).toBe(60_000);
  });

  it('nudge を 2 秒の間に 10 回呼んでも書き込みは 1 回', async () => {
    const { timers, pub, writes } = setup();
    for (let i = 0; i < 10; i++) {
      pub.nudge();
      await timers.advance(150);
    }
    await timers.advance(FEED_DEBOUNCE_MS);
    await settle(() => writes() === 1);
    await timers.advance(100);
    expect(writes()).toBe(1);
  });

  it('前の書き込みから 15 秒たつまで次を書かない', async () => {
    const { timers, pub, writes, setFeed } = setup();
    pub.nudge();
    await timers.advance(FEED_DEBOUNCE_MS);
    await settle(() => writes() === 1);
    setFeed(feedOf('会話 2'));
    pub.nudge();
    await timers.advance(FEED_DEBOUNCE_MS + 1_000);
    expect(writes()).toBe(1);
    await timers.advance(FEED_MIN_GAP_MS - FEED_DEBOUNCE_MS - 1_000 - 10);
    expect(writes()).toBe(1);
    // 15 秒の間に来た変化は、間が明けたところで 1 回にまとめて書く。
    await timers.advance(20);
    await settle(() => writes() === 2);
  });

  it('中身が同じなら書かない（unchanged）', async () => {
    const { pub, writes, setFeed } = setup();
    expect(await pub.flushNow()).toBe('written');
    expect(await pub.flushNow()).toBe('unchanged');
    expect(writes()).toBe(1);
    setFeed(feedOf('会話 2'));
    expect(await pub.flushNow()).toBe('written');
    expect(writes()).toBe(2);
  });

  it('forget の後は、中身が同じでも書き直す（新しくつながったスマホに素を置く）', async () => {
    const { pub, writes } = setup();
    expect(await pub.flushNow()).toBe('written');
    pub.forget();
    expect(await pub.flushNow()).toBe('written');
    expect(writes()).toBe(2);
  });

  it('中身が同じでも、前に書いてから 1 日たったら書き直す（スマホは 7 日より古い素を隠す）', async () => {
    const { timers, pub, writes } = setup();
    expect(FEED_REFRESH_MS).toBe(24 * 60 * 60_000);
    expect(await pub.flushNow()).toBe('written');
    timers.now += FEED_REFRESH_MS - 1;
    expect(await pub.flushNow()).toBe('unchanged');
    timers.now += 1;
    expect(await pub.flushNow()).toBe('written');
    expect(writes()).toBe(2);
  });

  it('canWrite が false（版 6 の Worker）なら書かない', async () => {
    let ok = false;
    const { timers, pub, writes } = setup({ canWrite: () => ok });
    expect(await pub.flushNow()).toBe('skipped');
    pub.nudge();
    await timers.advance(FEED_DEBOUNCE_MS * 2);
    expect(writes()).toBe(0);
    // 書けるようになったら、ハッシュを覚えていないので次のきっかけで書く。
    ok = true;
    expect(await pub.flushNow()).toBe('written');
  });

  it('偽の Worker が版 6 なら PUT /m/feed を断る', async () => {
    // 今の PC の下限（MIN_WORKER_COMPAT）は 9 なので、版 6 の Worker とはそもそも話さない。口の分岐だけを見るため、下限を下げる。
    const { client } = setup({ minWorkerCompat: 0 });
    client.workerCompat = MOBILE_MIN_WORKER_COMPAT - 1;
    await expect(client.putMobileFeed('x')).rejects.toMatchObject({ status: 404 });
  });

  it('書いた sealed は deriveMobileKey(joinSecret) と aadFeed(deviceId) で開ける', async () => {
    const { client, pub } = setup();
    expect(await pub.flushNow()).toBe('written');
    const stored = client.mobileFeeds.get('pc-a');
    expect(stored).toBeDefined();
    const opened = await open<MobileFeed>(await deriveMobileKey(SECRET), aadFeed('pc-a'), stored!.sealed);
    expect(opened).toEqual(feedOf('会話 1'));
    await expect(open(await deriveMobileKey(SECRET), aadFeed('pc-b'), stored!.sealed)).rejects.toThrow();
  });

  it('書き込みが失敗したら、次のきっかけでもう一度書く', async () => {
    const { timers, client, pub, writes, errors } = setup();
    client.offline = true;
    pub.nudge();
    await timers.advance(FEED_DEBOUNCE_MS);
    await settle(() => errors.length === 1);
    expect(client.mobileFeeds.size).toBe(0);
    client.offline = false;
    // 同じ中身でも、ハッシュを覚えていないので書く。
    pub.nudge();
    await timers.advance(FEED_MIN_GAP_MS + FEED_DEBOUNCE_MS);
    await settle(() => client.mobileFeeds.size === 1);
    expect(writes()).toBe(2);
  });

  it('nudge の失敗は投げない（同期の輪や登録の購読へ波及しない）', async () => {
    const timers = new FakeTimers();
    const client = new FakeCloudClient({ deviceId: 'pc-a' });
    const errors: unknown[] = [];
    const pub = new MobileFeedPublisher({ build: () => { throw new Error('boom'); }, client, joinSecret: SECRET, deviceId: 'pc-a', timers, canWrite: () => { throw new Error('bad'); }, onError: (e) => errors.push(e) });
    expect(() => pub.nudge()).not.toThrow();
    await timers.advance(FEED_DEBOUNCE_MS);
    await settle(() => errors.length === 1);
  });

  it('48 KiB を超える素は古い done から落としてから封じる', async () => {
    const { client, pub, setFeed } = setup();
    const big = feedOf('x');
    big.done = Array.from({ length: 400 }, (_, i) => ({ sessionId: `s${i}`, projectName: 'project-a', title: '会話'.repeat(60), oneLiner: null, doneAt: i }));
    setFeed(big);
    expect(await pub.flushNow()).toBe('written');
    const opened = await open<MobileFeed>(await deriveMobileKey(SECRET), aadFeed('pc-a'), client.mobileFeeds.get('pc-a')!.sealed);
    expect(new TextEncoder().encode(JSON.stringify(opened)).length).toBeLessThanOrEqual(MOBILE_FEED_MAX_BYTES);
    expect(opened.done.length).toBeLessThan(400);
  });

  it('start は 60 秒ごとの安全網で書き直しを試み、stop の後は書かない', async () => {
    const { timers, pub, writes, setFeed } = setup();
    pub.start();
    await timers.advance(FEED_DEBOUNCE_MS);
    await settle(() => writes() === 1);
    setFeed(feedOf('会話 2'));
    await timers.advance(FEED_SAFETY_MS + FEED_DEBOUNCE_MS);
    await settle(() => writes() === 2);
    pub.stop();
    setFeed(feedOf('会話 3'));
    pub.nudge();
    await timers.advance(FEED_SAFETY_MS * 2);
    expect(writes()).toBe(2);
    expect(await pub.flushNow()).toBe('skipped');
    expect(timers.pendingCount()).toBe(0);
  });

  it('dropFeed は DELETE /m/feed を 1 回だけ呼び、Worker の素の行が消え、以後は書かない', async () => {
    const { timers, client, pub, writes } = setup();
    expect(await pub.flushNow()).toBe('written');
    expect(client.mobileFeeds.has('pc-a')).toBe(true);
    expect(await pub.dropFeed()).toBe(true);
    expect(client.mobileFeeds.has('pc-a')).toBe(false);
    expect(await pub.dropFeed()).toBe(true);
    expect(client.calls.filter((c) => c.method === 'deleteMobileFeed')).toHaveLength(1);
    // canWrite が真でも、消した後は書かない（nudge も flushNow も）。
    pub.nudge();
    await timers.advance(FEED_DEBOUNCE_MS + FEED_MIN_GAP_MS);
    expect(await pub.flushNow()).toBe('skipped');
    expect(writes()).toBe(1);
    expect(client.mobileFeeds.has('pc-a')).toBe(false);
  });

  it('dropFeed の後でも forget（新しいスマホが現れた）で書き直せる。もう一度消すこともできる', async () => {
    const { client, pub, writes } = setup();
    await pub.flushNow();
    await pub.dropFeed();
    pub.forget();
    expect(await pub.flushNow()).toBe('written');
    expect(writes()).toBe(2);
    expect(await pub.dropFeed()).toBe(true);
    expect(client.calls.filter((c) => c.method === 'deleteMobileFeed')).toHaveLength(2);
  });

  it('dropFeed は書き込みの途中を待ち、その後に消す（消した後に書き込みが残らない）', async () => {
    const { client, pub } = setup();
    const w = pub.flushNow();
    const d = pub.dropFeed();
    await w;
    expect(await d).toBe(true);
    expect(client.mobileFeeds.has('pc-a')).toBe(false);
  });

  it('dropFeed が倒れたら false を返して消した扱いにせず、次の呼び出しでやり直す', async () => {
    const { client, pub } = setup();
    await pub.flushNow();
    client.offline = true;
    expect(await pub.dropFeed()).toBe(false);
    client.offline = false;
    expect(client.mobileFeeds.has('pc-a')).toBe(true);
    expect(await pub.dropFeed()).toBe(true);
    expect(client.mobileFeeds.has('pc-a')).toBe(false);
  });

  it('消す口を知らない Worker（404）には何も消せないので、やり直さない', async () => {
    // 今の PC の下限（MIN_WORKER_COMPAT）は 9 なので、版 7 の Worker とはそもそも話さない。口の分岐だけを見るため、下限を下げる。
    const { client, pub } = setup({ minWorkerCompat: 0 });
    client.workerCompat = MOBILE_MIN_WORKER_COMPAT;
    expect(await pub.dropFeed()).toBe(true);
    expect(await pub.dropFeed()).toBe(true);
    expect(client.calls.filter((c) => c.method === 'deleteMobileFeed')).toHaveLength(1);
  });

  it('client が口を持たなければ dropFeed は false', async () => {
    const { client, pub } = setup();
    (client as { deleteMobileFeed?: unknown }).deleteMobileFeed = undefined;
    expect(await pub.dropFeed()).toBe(false);
  });

  it('鍵は参加の秘密ごとに 1 回だけ導く', () => {
    expect(mobileKeyFor(SECRET)).toBe(mobileKeyFor(SECRET));
    expect(mobileKeyFor(SECRET + 'x')).not.toBe(mobileKeyFor(SECRET));
  });
});
