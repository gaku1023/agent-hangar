import { describe, expect, it, vi } from 'vitest';
import { aadFeed, open, type AccountsDto, type LiveSessionDto, type MobileFeed } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { noteIntent } from '../live/intents.ts';
import { FEED_DEBOUNCE_MS, FEED_SAFETY_MS, mobileKeyFor } from '../mobile/publisher.ts';
import type { CloudClient } from '../sync/client.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { bootMobile } from './mobile.ts';

const SECRET = 'join-secret-for-tests-0123456789abcdef';

function setup(o: { link?: boolean } = {}) {
  const db = openDb(':memory:');
  const timers = new FakeTimers();
  const client = new FakeCloudClient({ deviceId: 'pc-a', now: () => timers.now });
  let link: { client: CloudClient; joinSecret: string; url: string } | null = o.link === false ? null : { client, joinSecret: SECRET, url: 'https://w.example' };
  const registryListeners = new Set<(l: LiveSessionDto[]) => void>();
  const registry = {
    current: (): LiveSessionDto[] => [],
    onChange: (cb: (l: LiveSessionDto[]) => void) => { registryListeners.add(cb); return () => { registryListeners.delete(cb); }; },
  };
  const broadcasts: AccountsDto[] = [];
  const accounts = {
    store: { list: () => [{ id: 'primary', name: 'メイン', dir: '/x', color: '#2a57b8' }] },
    usage: { of: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }) },
    broadcast: (dto: AccountsDto) => { broadcasts.push(dto); },
  };
  const mobile = bootMobile({
    home: { db, device: { id: 'pc-a', name: 'PC A' } },
    delivery: { registry },
    runs: { accounts },
    sync: { canCarryMobile: () => true, mobileLink: () => link },
    timers,
  });
  return { db, timers, client, mobile, registryListeners, accounts, broadcasts, setLink: (l: typeof link) => { link = l; } };
}

const settle = (cond: () => boolean): Promise<void> => vi.waitFor(() => { if (!cond()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });

describe('bootMobile', () => {
  it('start で受信箱の素を 1 回書く。中身はこの PC の素で、参加の秘密の鍵で開ける', async () => {
    const { timers, client, mobile } = setup();
    mobile.start();
    await timers.advance(FEED_DEBOUNCE_MS);
    await settle(() => client.mobileFeeds.size === 1);
    const feed = await open<MobileFeed>(await mobileKeyFor(SECRET), aadFeed('pc-a'), client.mobileFeeds.get('pc-a')!.sealed);
    expect(feed).toMatchObject({ v: 1, deviceId: 'pc-a', deviceName: 'PC A', accounts: [{ id: 'primary', name: 'メイン' }] });
    mobile.stop();
  });

  it('登録の変化、意図、受信箱に関わる表の変化、アカウントの配りで nudge し、関わらない表では nudge しない', () => {
    const { db, mobile, registryListeners, accounts, broadcasts } = setup();
    mobile.start();
    const pub = mobile.publisher()!;
    const nudge = vi.spyOn(pub, 'nudge');
    for (const cb of registryListeners) cb([]);
    expect(nudge).toHaveBeenCalledTimes(1);
    noteIntent('s1');
    expect(nudge).toHaveBeenCalledTimes(2);
    for (const t of ['sessions', 'session_states', 'session_summaries', 'runs', 'project_roots']) touchRow(db, t, 'x');
    expect(nudge).toHaveBeenCalledTimes(7);
    touchRow(db, 'todos', 'x');
    touchRow(openDb(':memory:'), 'sessions', 'x');
    expect(nudge).toHaveBeenCalledTimes(7);
    // 使用率はアカウントの配り（accounts.update）と同じ時機で変わる。元の配りもそのまま届く。
    accounts.broadcast({} as AccountsDto);
    expect(nudge).toHaveBeenCalledTimes(8);
    expect(broadcasts).toHaveLength(1);
    mobile.stop();
    for (const cb of registryListeners) cb([]);
    noteIntent('s1');
    touchRow(db, 'sessions', 'x');
    accounts.broadcast({} as AccountsDto);
    expect(nudge).toHaveBeenCalledTimes(8);
    expect(registryListeners.size).toBe(0);
    expect(broadcasts).toHaveLength(2);
  });

  it('同期を設定していなければ書き手を作らず、設定が現れたら次のきっかけか見回りで作る', async () => {
    const { timers, client, mobile, setLink } = setup({ link: false });
    mobile.start();
    expect(mobile.publisher()).toBeNull();
    setLink({ client, joinSecret: SECRET, url: 'https://w.example' });
    await timers.advance(FEED_SAFETY_MS);
    expect(mobile.publisher()).not.toBeNull();
    await timers.advance(FEED_DEBOUNCE_MS);
    await settle(() => client.mobileFeeds.size === 1);
    // client が変わったら（cloud.json を拾い直した）書き手を組み直す。
    const before = mobile.publisher();
    setLink({ client: client.asDevice('pc-a'), joinSecret: SECRET, url: 'https://w.example' });
    noteIntent('s1');
    expect(mobile.publisher()).not.toBe(before);
    mobile.stop();
    expect(mobile.publisher()).toBeNull();
    expect(timers.pendingCount()).toBe(0);
  });
});
