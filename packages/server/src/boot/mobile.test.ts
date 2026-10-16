import { describe, expect, it, vi } from 'vitest';
import { aadAnswer, aadFeed, aadLaunch, open, seal, type AccountsDto, type CloudDevicesDto, type LaunchParams, type LiveSessionDto, type MobileFeed, type MobileLaunchAnswer, type MobileLaunchOut } from '@agent-hangar/shared';
import { upsertShared } from '../db/shared.ts';
import type { LaunchResult, RunListener } from '../runs/manager.ts';
import type { SyncListener } from '../sync/engine.ts';
import { openDb } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { noteIntent } from '../live/intents.ts';
import { FEED_DEBOUNCE_MS, FEED_MIN_GAP_MS, FEED_SAFETY_MS, mobileKeyFor } from '../mobile/publisher.ts';
import type { CloudClient } from '../sync/client.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { ANSWER_RESEND_TICK_MS, bootMobile, PHONE_RECHECK_MS } from './mobile.ts';

const SECRET = 'join-secret-for-tests-0123456789abcdef';

/** 同期の engine の真似。購読（on）だけを持ち、試験が launches を流す。 */
class FakeEngine {
  readonly listeners = new Set<SyncListener>();
  on(l: SyncListener): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  emitLaunches(l: MobileLaunchOut[]): void { for (const x of [...this.listeners]) x.launches?.(l); }
}

const device = (id: string, kind: 'pc' | 'mobile', revokedAt: number | null = null): CloudDevicesDto['devices'][number] => ({
  id, name: id, platform: kind === 'mobile' ? 'mobile' : 'darwin', joinedAt: 1, lastSeenAt: 1, revokedAt, lastIp: null, lastCity: null, lastRegion: null, lastCountry: null, kind, self: id === 'pc-a',
});
const devicesDto = (devices: CloudDevicesDto['devices'], state: CloudDevicesDto['state'] = 'ok'): CloudDevicesDto => ({ state, devices, creator: true, message: null });
/** スマホが 1 台つながっている一覧。 */
const withPhone = (): CloudDevicesDto => devicesDto([device('pc-a', 'pc'), device('phone-1', 'mobile')]);
/** PC だけの一覧。 */
const noPhone = (): CloudDevicesDto => devicesDto([device('pc-a', 'pc'), device('pc-b', 'pc')]);

function setup(o: { link?: boolean; canCarry?: () => boolean; mobileLink?: () => never; devices?: CloudDevicesDto } = {}) {
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
  const start = vi.fn((params: LaunchParams): LaunchResult => ({ run: { id: 'run-1', sessionId: 's-new' } as LaunchResult['run'], sessionId: 's-new', tabs: [] }));
  const runListeners = new Set<RunListener>();
  const on = (l: RunListener): (() => void) => { runListeners.add(l); return () => { runListeners.delete(l); }; };
  let engine = new FakeEngine();
  let devices = o.devices ?? withPhone();
  const deviceListeners = new Set<(d: CloudDevicesDto) => void>();
  const cloudDevices = vi.fn(async (): Promise<CloudDevicesDto> => {
    const d = devices;
    for (const cb of [...deviceListeners]) cb(d);
    return d;
  });
  const sync = {
    canCarryMobile: o.canCarry ?? (() => true),
    mobileLink: o.mobileLink ?? (() => link),
    get engine() { return engine; },
    cloudDevices,
    onCloudDevices: (cb: (d: CloudDevicesDto) => void) => { deviceListeners.add(cb); return () => { deviceListeners.delete(cb); }; },
  };
  const mobile = bootMobile({
    home: { db, device: { id: 'pc-a', name: 'PC A' } },
    delivery: { registry },
    runs: { runs: { start, on }, accounts },
    sync,
    timers,
    now: () => timers.now,
  });
  return {
    db, timers, client, mobile, registryListeners, accounts, broadcasts, start, runListeners,
    engine: () => engine,
    setEngine: (e: FakeEngine) => { engine = e; },
    setLink: (l: typeof link) => { link = l; },
    cloudDevices,
    deviceListeners,
    /** Worker の一覧を差し替える。次の読み直しから効く。 */
    setDevices: (d: CloudDevicesDto) => { devices = d; },
    /** 設定の画面の読み込み（GET /api/sync/cloud-devices）で一覧が届いたことにする。 */
    uiLoads: (d: CloudDevicesDto) => { devices = d; for (const cb of [...deviceListeners]) cb(d); },
  };
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

  it('run の画面から Remote Control の URL を拾ったら nudge し、止めたら購読を外す', () => {
    const { mobile, runListeners } = setup();
    mobile.start();
    const nudge = vi.spyOn(mobile.publisher()!, 'nudge');
    for (const l of runListeners) l.remoteUrl?.({ runId: 'run-1', sessionId: 's1', url: 'https://claude.ai/code/session_01AbCd' });
    expect(nudge).toHaveBeenCalledTimes(1);
    mobile.stop();
    expect(runListeners.size).toBe(0);
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

  describe('スマホがつながっているときだけ書く', () => {
    const writes = (s: ReturnType<typeof setup>): number => s.client.calls.filter((c) => c.method === 'putMobileFeed').length;
    const quiet = (): Promise<void> => new Promise((r) => { setTimeout(r, 20); });

    it('スマホが 1 台も無ければ書かない（外したスマホも数えない）', async () => {
      const s = setup({ devices: devicesDto([device('pc-a', 'pc'), device('phone-1', 'mobile', 5)]) });
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await quiet();
      await s.timers.advance(FEED_SAFETY_MS);
      await quiet();
      expect(s.cloudDevices).toHaveBeenCalled();
      expect(writes(s)).toBe(0);
      s.mobile.stop();
    });

    it('一覧が分からない（読めない）あいだは書かない。読み直しは見回りの間隔より詰めない', async () => {
      const s = setup({ devices: devicesDto([], 'unreachable') });
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await quiet();
      expect(writes(s)).toBe(0);
      expect(s.cloudDevices).toHaveBeenCalledTimes(1);
      // きっかけが続いても読みに行かない。
      for (let i = 0; i < 5; i++) s.accounts.broadcast({} as AccountsDto);
      await quiet();
      expect(s.cloudDevices).toHaveBeenCalledTimes(1);
      await s.timers.advance(FEED_SAFETY_MS);
      await quiet();
      expect(s.cloudDevices).toHaveBeenCalledTimes(2);
      expect(writes(s)).toBe(0);
      s.mobile.stop();
    });

    it('Worker と話せる（canCarryMobile）までは一覧を読みに行かない', async () => {
      let carry = false;
      const s = setup({ canCarry: () => carry });
      s.mobile.start();
      await s.timers.advance(FEED_SAFETY_MS);
      expect(s.cloudDevices).not.toHaveBeenCalled();
      carry = true;
      await s.timers.advance(FEED_SAFETY_MS);
      expect(s.cloudDevices).toHaveBeenCalledTimes(1);
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 1);
      s.mobile.stop();
    });

    it('最初のスマホが現れたら（設定の画面の読み込みで知ったら）すぐ書く', async () => {
      const s = setup({ devices: noPhone() });
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await quiet();
      expect(writes(s)).toBe(0);
      s.uiLoads(withPhone());
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 1);
      s.mobile.stop();
    });

    it('スマホを外したら、見回りの読み直し（PHONE_RECHECK_MS）で知って書かなくなる', async () => {
      const s = setup();
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 1);
      s.setDevices(devicesDto([device('pc-a', 'pc'), device('phone-1', 'mobile', 5)]));
      await s.timers.advance(PHONE_RECHECK_MS);
      await quiet();
      expect(s.cloudDevices).toHaveBeenCalledTimes(2);
      // 中身を変えても書かない。
      s.accounts.store.list = () => [{ id: 'primary', name: 'メイン 2', dir: '/x', color: '#2a57b8' }];
      s.accounts.broadcast({} as AccountsDto);
      await s.timers.advance(FEED_MIN_GAP_MS + FEED_DEBOUNCE_MS);
      await quiet();
      expect(writes(s)).toBe(1);
      s.mobile.stop();
    });

    it('外した後にまたスマホがつながったら、中身が同じでも書き直す', async () => {
      const s = setup();
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 1);
      s.uiLoads(noPhone());
      s.uiLoads(withPhone());
      await s.timers.advance(FEED_MIN_GAP_MS + FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 2);
      s.mobile.stop();
    });

    it('止めたら一覧の購読を外す', () => {
      const s = setup();
      s.mobile.start();
      expect(s.deviceListeners.size).toBe(1);
      s.mobile.stop();
      expect(s.deviceListeners.size).toBe(0);
    });
  });

  it('start の最初の組み立てが投げても、サーバの起動を止めない', () => {
    const { mobile } = setup({ mobileLink: () => { throw new Error('cloud.json を読めない'); } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => mobile.start()).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    mobile.stop();
  });

  describe('起動の依頼', () => {
    const sealedLaunch = async (id: string, over: Record<string, unknown> = {}): Promise<string> =>
      seal(await mobileKeyFor(SECRET), aadLaunch(id, 'pc-a'), { v: 1, createdAt: Date.now(), projectId: 'project-a', scratch: false, accountId: 'primary', permissionMode: '', model: '', prompt: '会話 1 を始める', ...over });
    const deliver = async (s: ReturnType<typeof setup>, id: string, over: Record<string, unknown> = {}): Promise<void> => {
      s.client.asDevice('phone').postLaunch({ id, targetDevice: 'pc-a', sealed: await sealedLaunch(id, over) });
      s.engine().emitLaunches((await s.client.pullChanges(0, 10)).launches ?? []);
    };
    const answerOf = async (s: ReturnType<typeof setup>, id: string): Promise<MobileLaunchAnswer> => open<MobileLaunchAnswer>(await mobileKeyFor(SECRET), aadAnswer(id), s.client.launches.get(id)!.sealedAnswer!);
    const placeProject = (db: ReturnType<typeof setup>['db'], deviceId = 'pc-a') => {
      upsertShared(db, 'projects', { id: 'project-a', name: 'project-a', status: 'active', is_scratch: 0 }, 'pc-a');
      upsertShared(db, 'project_roots', { id: `r-${deviceId}`, project_id: 'project-a', device_id: deviceId, path: '/w/project-a', resolved: 1 }, 'pc-a');
    };

    it('pull で届いた依頼でこの PC の場所のあるプロジェクトに会話を起こし、受信箱の素を書き直す', async () => {
      const s = setup();
      placeProject(s.db);
      s.mobile.start();
      const nudge = vi.spyOn(s.mobile.publisher()!, 'nudge');
      await deliver(s, 'l1');
      await settle(() => s.client.launches.get('l1')!.status === 'started');
      expect(s.start).toHaveBeenCalledWith({ projectId: 'project-a', account: 'primary', prompt: '会話 1 を始める' });
      expect(await answerOf(s, 'l1')).toMatchObject({ ok: true, sessionId: 's-new' });
      expect(nudge).toHaveBeenCalled();
      s.mobile.stop();
    });

    it('ほかの PC にしか場所の無いプロジェクトは project-missing、知らないアカウントは account-missing', async () => {
      const s = setup();
      placeProject(s.db, 'pc-b');
      s.mobile.start();
      await deliver(s, 'l1');
      await deliver(s, 'l2', { scratch: true, projectId: null, accountId: 'account-z' });
      await settle(() => s.client.launches.get('l2')!.status === 'failed');
      expect(await answerOf(s, 'l1')).toMatchObject({ ok: false, reason: 'project-missing' });
      expect(await answerOf(s, 'l2')).toMatchObject({ ok: false, reason: 'account-missing' });
      expect(s.start).not.toHaveBeenCalled();
      s.mobile.stop();
    });

    it('Worker が版 6（canCarryMobile が偽）のあいだは依頼を扱わない', async () => {
      const s = setup({ canCarry: () => false });
      placeProject(s.db);
      s.mobile.start();
      await deliver(s, 'l1');
      await new Promise((r) => { setTimeout(r, 20); });
      expect(s.client.calls.filter((c) => c.method === 'claimLaunch')).toHaveLength(0);
      expect(s.client.launches.get('l1')!.status).toBe('pending');
      s.mobile.stop();
    });

    it('答えを送れなかった依頼は、送り直しの見回り（ANSWER_RESEND_TICK_MS）で控えた答えを送り直す', async () => {
      const s = setup();
      placeProject(s.db);
      s.mobile.start();
      const answer = vi.spyOn(s.client, 'answerLaunch').mockRejectedValueOnce(new Error('offline'));
      await deliver(s, 'l1');
      await settle(() => answer.mock.calls.length === 1);
      await new Promise((r) => { setTimeout(r, 10); });
      expect(s.client.launches.get('l1')!.status).toBe('claimed');
      await s.timers.advance(ANSWER_RESEND_TICK_MS);
      await settle(() => s.client.launches.get('l1')!.status === 'started');
      expect(s.start).toHaveBeenCalledTimes(1);
      expect(await answerOf(s, 'l1')).toMatchObject({ ok: true, sessionId: 's-new' });
      s.mobile.stop();
      expect(s.timers.pendingCount()).toBe(0);
    });

    it('engine が組み直されたら新しい engine を購読し直し、止めたら購読を外す', async () => {
      const s = setup();
      placeProject(s.db);
      s.mobile.start();
      const old = s.engine();
      s.setEngine(new FakeEngine());
      // 組み直しは見回りかきっかけで拾う。
      await s.timers.advance(FEED_SAFETY_MS);
      expect(old.listeners.size).toBe(0);
      expect(s.engine().listeners.size).toBe(1);
      await deliver(s, 'l1');
      await settle(() => s.client.launches.get('l1')!.status === 'started');
      s.mobile.stop();
      expect(s.engine().listeners.size).toBe(0);
    });
  });
});
