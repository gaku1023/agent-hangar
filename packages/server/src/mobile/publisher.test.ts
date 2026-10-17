import { describe, expect, it, vi } from 'vitest';
import { aadFeed, importMobileKey, MOBILE_FEED_MAX_BYTES, MOBILE_MIN_WORKER_COMPAT, open, openPhoneNotice, type MobileFeed, type MobileLiveItem } from '@agent-hangar/shared';
import { CloudError } from '../sync/client.ts';
import { testCloudConfig } from '../../test/cloudConfig.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { fixedPhoneKeys, PHONE_KEY_1, PHONE_KEY_2, phoneCryptoKey } from '../../test/phoneKeys.ts';
import { Keyring } from '../sync/keyring.ts';
import type { PhoneKeySource } from '../sync/phoneKeys.ts';
import { FEED_DEBOUNCE_MS, FEED_MIN_GAP_MS, FEED_REFRESH_MS, FEED_SAFETY_MS, MobileFeedPublisher } from './publisher.ts';

const mKey = (): Promise<CryptoKey> => phoneCryptoKey(PHONE_KEY_1);

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

function setup(o: { canWrite?: () => boolean; minWorkerCompat?: number; phoneKeys?: Pick<PhoneKeySource, 'current'>; hasPhones?: () => boolean } = {}) {
  const timers = new FakeTimers();
  const client = new FakeCloudClient({ deviceId: 'pc-a', now: () => timers.now, ...(o.minWorkerCompat !== undefined ? { minWorkerCompat: o.minWorkerCompat } : {}) });
  let feed = feedOf('会話 1');
  const errors: unknown[] = [];
  const pub = new MobileFeedPublisher({
    build: () => feed,
    client,
    phoneKeys: o.phoneKeys ?? fixedPhoneKeys(),
    deviceId: 'pc-a',
    timers,
    now: () => timers.now,
    canWrite: o.canWrite ?? (() => true),
    hasPhones: o.hasPhones ?? (() => true),
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
    await expect(client.putMobileFeed('x', 1)).rejects.toMatchObject({ status: 404 });
  });

  it('受信箱の素はスマホ用の鍵で開け、PC の世代鍵の用途の鍵では開けない。世代を添えて置く', async () => {
    const { client, pub } = setup();
    expect(await pub.flushNow()).toBe('written');
    const stored = client.mobileFeeds.get('pc-a');
    expect(stored).toBeDefined();
    expect(stored!.epoch).toBe(1);
    const opened = await open<MobileFeed>(await mKey(), aadFeed('pc-a'), stored!.sealed);
    expect(opened).toEqual(feedOf('会話 1'));
    await expect(open(await mKey(), aadFeed('pc-b'), stored!.sealed)).rejects.toThrow();
    // PC の世代鍵から導いた用途の鍵（行、名簿、本文）では開けない。
    const epochKeys = (await Keyring.fromConfig(testCloudConfig())).current();
    for (const k of [epochKeys.row, epochKeys.roster, await importMobileKey(epochKeys.fileBytes)]) {
      await expect(open(k, aadFeed('pc-a'), stored!.sealed)).rejects.toThrow();
    }
  });

  it('スマホ用の鍵がまだ無い（スマホを接続していない）あいだは書かない', async () => {
    const { pub, writes } = setup({ phoneKeys: fixedPhoneKeys({}) });
    expect(await pub.flushNow()).toBe('skipped');
    expect(writes()).toBe(0);
  });

  it('スマホ用の鍵の世代が進んだら、中身が同じでも新しい世代で書き直す', async () => {
    const keys: Record<number, string> = { 1: PHONE_KEY_1 };
    const { client, pub } = setup({ phoneKeys: { current: () => fixedPhoneKeys(keys).current() } });
    expect(await pub.flushNow()).toBe('written');
    expect(await pub.flushNow()).toBe('unchanged');
    keys[2] = PHONE_KEY_2;
    expect(await pub.flushNow()).toBe('written');
    const stored = client.mobileFeeds.get('pc-a')!;
    expect(stored.epoch).toBe(2);
    expect(await open<MobileFeed>(await phoneCryptoKey(PHONE_KEY_2), aadFeed('pc-a'), stored.sealed)).toEqual(feedOf('会話 1'));
    await expect(open(await mKey(), aadFeed('pc-a'), stored.sealed)).rejects.toThrow();
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
    const pub = new MobileFeedPublisher({ build: () => { throw new Error('boom'); }, client, phoneKeys: fixedPhoneKeys(), deviceId: 'pc-a', timers, canWrite: () => { throw new Error('bad'); }, hasPhones: () => true, onError: (e) => errors.push(e) });
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
    const opened = await open<MobileFeed>(await mKey(), aadFeed('pc-a'), client.mobileFeeds.get('pc-a')!.sealed);
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
});

/** 実行中の会話の 1 行。status が waiting なら要対応（スマホの受信箱の「要対応」）。 */
const liveOf = (sessionId: string, status: MobileLiveItem['status'], o: Partial<MobileLiveItem> = {}): MobileLiveItem => ({
  sessionId, projectId: 'p1', projectName: 'project-a', title: `題 ${sessionId}`, accountId: 'primary', status, statusAt: 10, startedAt: 1,
  waiting: status === 'waiting' ? { kind: 'permission', text: 'Bash: ls' } : null, intent: null, rcUrl: null, ...o,
});
const withLive = (live: MobileLiveItem[], n = 0): MobileFeed => ({ ...feedOf(`会話 ${n}`), live });

describe('MobileFeedPublisher のスマホへの通知', () => {
  const notices = (s: ReturnType<typeof setup>) => s.client.notices;

  it('要対応に新しく入った会話があれば、素を書いたあとに通知を 1 回送る。中身はスマホ用の鍵で開ける', async () => {
    const s = setup();
    s.setFeed(withLive([liveOf('s1', 'busy')]));
    expect(await s.pub.flushNow()).toBe('written');
    s.setFeed(withLive([liveOf('s1', 'waiting')]));
    expect(await s.pub.flushNow()).toBe('written');
    expect(notices(s)).toHaveLength(1);
    const n = notices(s)[0]!;
    expect(n.epoch).toBe(1);
    expect(await openPhoneNotice(await mKey(), n.sealed)).toEqual({ title: '題 s1', pcName: 'PC A', sessionId: 's1', count: 1 });
  });

  it('起動の直後の最初の書き込みでは、既に要対応だった会話を知らせない', async () => {
    const s = setup();
    s.setFeed(withLive([liveOf('s1', 'waiting')]));
    expect(await s.pub.flushNow()).toBe('written');
    expect(notices(s)).toHaveLength(0);
  });

  it('同じ会話が要対応のままなら送らない。要対応を出てまた入れば、もう 1 回送る', async () => {
    const s = setup();
    s.setFeed(withLive([]));
    await s.pub.flushNow();
    s.setFeed(withLive([liveOf('s1', 'waiting')], 1));
    await s.pub.flushNow();
    s.setFeed(withLive([liveOf('s1', 'waiting', { waiting: { kind: 'question', text: '次は?' } })], 2));
    expect(await s.pub.flushNow()).toBe('written');
    expect(notices(s)).toHaveLength(1);
    s.setFeed(withLive([liveOf('s1', 'busy')], 3));
    await s.pub.flushNow();
    s.setFeed(withLive([liveOf('s1', 'waiting')], 4));
    await s.pub.flushNow();
    expect(notices(s)).toHaveLength(2);
  });

  it('新しく入った会話が複数なら、1 回の通知に件数を入れ、題は先に待ち始めた会話のもの', async () => {
    const s = setup();
    s.setFeed(withLive([liveOf('s0', 'waiting')]));
    await s.pub.flushNow();
    s.setFeed(withLive([liveOf('s0', 'waiting'), liveOf('s2', 'waiting', { statusAt: 30 }), liveOf('s3', 'waiting', { statusAt: 20 }), liveOf('s4', 'idle')], 1));
    await s.pub.flushNow();
    expect(notices(s)).toHaveLength(1);
    expect(await openPhoneNotice(await mKey(), notices(s)[0]!.sealed)).toEqual({ title: '題 s3', pcName: 'PC A', sessionId: 's3', count: 2 });
  });

  it('スマホが 1 台も無いときは送らない。後からスマホが現れても、その前から待っていた会話は鳴らさない', async () => {
    let phones = false;
    const s = setup({ hasPhones: () => phones });
    s.setFeed(withLive([]));
    await s.pub.flushNow();
    s.setFeed(withLive([liveOf('s1', 'waiting')], 1));
    expect(await s.pub.flushNow()).toBe('written');
    expect(notices(s)).toHaveLength(0);
    phones = true;
    s.setFeed(withLive([liveOf('s1', 'waiting')], 2));
    await s.pub.flushNow();
    expect(notices(s)).toHaveLength(0);
  });

  it('素の書き込みに失敗したら、その回の会話は次に書けたときに知らせる', async () => {
    const s = setup();
    s.setFeed(withLive([]));
    await s.pub.flushNow();
    s.setFeed(withLive([liveOf('s1', 'waiting')]));
    s.client.offline = true;
    await expect(s.pub.flushNow()).rejects.toBeInstanceOf(CloudError);
    s.client.offline = false;
    expect(await s.pub.flushNow()).toBe('written');
    expect(notices(s)).toHaveLength(1);
  });

  it('通知の失敗（口を知らない Worker の 404、上限の 429、倒れた要求）は捨て、素の書き手は止まらない', async () => {
    const s = setup();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      s.setFeed(withLive([]));
      await s.pub.flushNow();
      s.client.wire.noticeRoute = false;
      s.setFeed(withLive([liveOf('s1', 'waiting')]));
      expect(await s.pub.flushNow()).toBe('written');
      s.client.wire.noticeRoute = true;
      (s.client as { postNotice?: unknown }).postNotice = async () => { throw new CloudError(429, '{"error":"rate limited"}'); };
      s.setFeed(withLive([liveOf('s2', 'waiting')]));
      expect(await s.pub.flushNow()).toBe('written');
      (s.client as { postNotice?: unknown }).postNotice = async () => { throw new Error('秘密の題'); };
      s.setFeed(withLive([liveOf('s3', 'waiting')]));
      expect(await s.pub.flushNow()).toBe('written');
      expect(s.errors).toEqual([]);
      // 404 と 429 は記録しない。ほかの失敗は種類だけを 1 行残し、中身は出さない。
      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logged.mock.calls)).not.toContain('秘密');
      // 書き手はその後も書く。
      s.setFeed(withLive([liveOf('s3', 'waiting')], 9));
      expect(await s.pub.flushNow()).toBe('written');
      expect(s.writes()).toBe(5);
    } finally {
      logged.mockRestore();
    }
  });

  it('client が通知の口を持たなければ送らずに書く', async () => {
    const s = setup();
    (s.client as { postNotice?: unknown }).postNotice = undefined;
    s.setFeed(withLive([]));
    await s.pub.flushNow();
    s.setFeed(withLive([liveOf('s1', 'waiting')]));
    expect(await s.pub.flushNow()).toBe('written');
    expect(notices(s)).toHaveLength(0);
  });
});
