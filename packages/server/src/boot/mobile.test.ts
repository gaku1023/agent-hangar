import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { aadAnswer, aadAsk, aadFeed, aadImage, aadLaunch, aadReply, COMPAT_HEADER, COMPAT_VERSION, MOBILE_BELL_MIN_WORKER_COMPAT, open, quotePath, seal, sealBytes, type MobileAsk, type AccountsDto, type CloudDevicesDto, type LaunchParams, type LiveSessionDto, type MobileFeed, type MobileLaunchAnswer, type MobileLaunchOut, type ServerEvent } from '@agent-hangar/shared';
import { upsertShared } from '../db/shared.ts';
import type { LaunchResult, RunListener } from '../runs/manager.ts';
import type { SyncListener } from '../sync/engine.ts';
import { openDb } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { noteIntent } from '../live/intents.ts';
import type { MobileLink } from '../mobile/pairer.ts';
import { FEED_DEBOUNCE_MS, FEED_MIN_GAP_MS, FEED_SAFETY_MS } from '../mobile/publisher.ts';
import type { BellTarget, CloudClient } from '../sync/client.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { fixedPhoneKeys, PHONE_KEY_1, phoneCryptoKey } from '../../test/phoneKeys.ts';
import { ANSWER_RESEND_TICK_MS, bootMobile, PHONE_RECHECK_MS } from './mobile.ts';

/** スマホ用の鍵 M[1]。どの試験でも同じ引き口を渡す（引き口が同じなら書き手を組み直さない）。 */
const PHONE_KEYS = fixedPhoneKeys();
const mobileKey = (): Promise<CryptoKey> => phoneCryptoKey(PHONE_KEY_1);
const linkOf = (client: CloudClient, url = 'https://w.example'): MobileLink => ({ client, url, phoneKeys: PHONE_KEYS, pairer: { watch: async () => 'pair-1', pairedFor: () => null } });

/** 同期の engine の真似。購読（on）だけを持ち、試験が launches を流す。 */
class FakeEngine {
  readonly listeners = new Set<SyncListener>();
  readonly pullNow = vi.fn(async () => ({ applied: 0 }));
  on(l: SyncListener): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  emitLaunches(l: MobileLaunchOut[]): void { for (const x of [...this.listeners]) x.launches?.(l); }
}

const device = (id: string, kind: 'pc' | 'mobile', revokedAt: number | null = null): CloudDevicesDto['devices'][number] => ({
  id, name: id, platform: kind === 'mobile' ? null : 'darwin', joinedAt: 1, lastSeenAt: 1, revokedAt, expiresAt: null, kind, self: id === 'pc-a',
});
const devicesDto = (devices: CloudDevicesDto['devices'], state: CloudDevicesDto['state'] = 'ok'): CloudDevicesDto => ({ state, devices, creator: true, message: null });
/** スマホが 1 台つながっている一覧。 */
const withPhone = (): CloudDevicesDto => devicesDto([device('pc-a', 'pc'), device('phone-1', 'mobile')]);
/** PC だけの一覧。 */
const noPhone = (): CloudDevicesDto => devicesDto([device('pc-a', 'pc'), device('pc-b', 'pc')]);

const homeDirs: string[] = [];
afterEach(() => { for (const d of homeDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup(o: { link?: boolean; canCarry?: () => boolean; mobileLink?: () => never; devices?: CloudDevicesDto } = {}) {
  const db = openDb(':memory:');
  const timers = new FakeTimers();
  const client = new FakeCloudClient({ deviceId: 'pc-a', now: () => timers.now });
  let link: MobileLink | null = o.link === false ? null : linkOf(client);
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
  const homeDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-boot-mobile-')), 'home');
  homeDirs.push(path.dirname(homeDir));
  const events: ServerEvent[] = [];
  const mobile = bootMobile({
    home: { db, device: { id: 'pc-a', name: 'PC A' }, home: homeDir },
    delivery: { registry, hub: { broadcast: (ev: ServerEvent) => { events.push(ev); } } },
    runs: { runs: { start, on }, accounts },
    sync,
    timers,
    now: () => timers.now,
  });
  return {
    db, timers, client, mobile, homeDir, registryListeners, accounts, broadcasts, start, runListeners, events,
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
  it('start で受信箱の素を 1 回書く。中身はこの PC の素で、スマホ用の鍵で開ける', async () => {
    const { timers, client, mobile } = setup();
    mobile.start();
    await timers.advance(FEED_DEBOUNCE_MS);
    await settle(() => client.mobileFeeds.size === 1);
    const feed = await open<MobileFeed>(await mobileKey(), aadFeed('pc-a'), client.mobileFeeds.get('pc-a')!.sealed);
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
    setLink(linkOf(client));
    await timers.advance(FEED_SAFETY_MS);
    expect(mobile.publisher()).not.toBeNull();
    await timers.advance(FEED_DEBOUNCE_MS);
    await settle(() => client.mobileFeeds.size === 1);
    // client が変わったら（cloud.json を拾い直した）書き手を組み直す。
    const before = mobile.publisher();
    setLink(linkOf(client.asDevice('pc-a')));
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

    const deletes = (s: ReturnType<typeof setup>, c: { calls: { method: string }[] } = s.client): number => c.calls.filter((x) => x.method === 'deleteMobileFeed').length;

    it('最後のスマホを外したら、見回りの読み直しで知り、受信箱の素を Worker から 1 回だけ消す', async () => {
      const s = setup();
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 1);
      expect(s.client.mobileFeeds.has('pc-a')).toBe(true);
      s.setDevices(devicesDto([device('pc-a', 'pc'), device('phone-1', 'mobile', 5)]));
      await s.timers.advance(PHONE_RECHECK_MS);
      await settle(() => deletes(s) === 1);
      expect(s.client.mobileFeeds.has('pc-a')).toBe(false);
      // 以後は消す要求も書き込みも出さない（読み直しが何度来ても）。
      s.accounts.broadcast({} as AccountsDto);
      await s.timers.advance(PHONE_RECHECK_MS);
      await s.timers.advance(PHONE_RECHECK_MS);
      await quiet();
      expect(deletes(s)).toBe(1);
      expect(writes(s)).toBe(1);
      expect(s.client.mobileFeeds.has('pc-a')).toBe(false);
      s.mobile.stop();
    });

    it('消した後にスマホがまたつながったら、素を置き直す', async () => {
      const s = setup();
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 1);
      s.uiLoads(noPhone());
      await settle(() => deletes(s) === 1);
      s.uiLoads(withPhone());
      await s.timers.advance(FEED_MIN_GAP_MS + FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 2);
      expect(s.client.mobileFeeds.has('pc-a')).toBe(true);
      s.mobile.stop();
    });

    it('スマホが一度も無かった PC は、消す要求を出さない', async () => {
      const s = setup({ devices: noPhone() });
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await quiet();
      await s.timers.advance(PHONE_RECHECK_MS);
      await quiet();
      expect(s.cloudDevices).toHaveBeenCalled();
      expect(deletes(s)).toBe(0);
      s.mobile.stop();
    });

    it('消すのに失敗したら、次の読み直しでやり直す', async () => {
      const s = setup();
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 1);
      s.setDevices(noPhone());
      s.client.offline = true;
      await s.timers.advance(PHONE_RECHECK_MS);
      await settle(() => deletes(s) === 1);
      s.client.offline = false;
      await s.timers.advance(PHONE_RECHECK_MS);
      await settle(() => deletes(s) === 2);
      expect(s.client.mobileFeeds.has('pc-a')).toBe(false);
      await s.timers.advance(PHONE_RECHECK_MS);
      await quiet();
      expect(deletes(s)).toBe(2);
      s.mobile.stop();
    });

    it('つなぎ先（cloud.json）が変わったら、スマホが有るという覚えを捨てて、5 分を待たずに読み直す', async () => {
      const s = setup();
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 1);
      expect(s.cloudDevices).toHaveBeenCalledTimes(1);
      const next = s.client.asDevice('pc-a');
      await next.health();
      // 新しいつなぎ先にはスマホが居ない。
      s.setDevices(noPhone());
      s.setLink(linkOf(next, 'https://w2.example'));
      await s.timers.advance(FEED_SAFETY_MS);
      await settle(() => s.cloudDevices.mock.calls.length === 2);
      // 新しいつなぎ先には書かず、前のつなぎ先に居たスマホのための消す要求も出さない。
      s.accounts.broadcast({} as AccountsDto);
      await s.timers.advance(FEED_MIN_GAP_MS + FEED_DEBOUNCE_MS);
      await quiet();
      expect(next.calls.filter((c) => c.method === 'putMobileFeed')).toHaveLength(0);
      expect(deletes(s, next)).toBe(0);
      s.mobile.stop();
    });

    it('つなぎ先が変わった後、新しい先にスマホが居れば新しい先へ書く', async () => {
      const s = setup();
      s.mobile.start();
      await s.timers.advance(FEED_DEBOUNCE_MS);
      await settle(() => writes(s) === 1);
      const next = s.client.asDevice('pc-a');
      await next.health();
      s.setLink(linkOf(next, 'https://w2.example'));
      await s.timers.advance(FEED_SAFETY_MS + FEED_DEBOUNCE_MS);
      await settle(() => next.calls.some((c) => c.method === 'putMobileFeed'));
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
      seal(await mobileKey(), aadLaunch(id, 'pc-a'), { v: 1, createdAt: Date.now(), projectId: 'project-a', scratch: false, accountId: 'primary', permissionMode: '', model: '', prompt: '会話 1 を始める', ...over });
    const deliver = async (s: ReturnType<typeof setup>, id: string, over: Record<string, unknown> = {}, from = 'phone'): Promise<void> => {
      s.client.asDevice(from).postLaunch({ id, targetDevice: 'pc-a', sealed: await sealedLaunch(id, over), epoch: 1 });
      s.engine().emitLaunches((await s.client.pullChanges(0, 10)).launches ?? []);
    };
    const answerOf = async (s: ReturnType<typeof setup>, id: string): Promise<MobileLaunchAnswer> => open<MobileLaunchAnswer>(await mobileKey(), aadAnswer(id), s.client.launches.get(id)!.sealedAnswer!);
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

    it('起こしたら画面に phone.launch を配る。スマホの名前は一覧（名簿）のスマホの名前で、知らないスマホは null', async () => {
      const s = setup({ devices: devicesDto([device('pc-a', 'pc'), { ...device('phone-1', 'mobile'), name: 'iPhone' }]) });
      placeProject(s.db);
      s.mobile.start();
      await s.cloudDevices();
      await deliver(s, 'l1', { permissionMode: 'bypassPermissions' }, 'phone-1');
      await settle(() => s.events.some((e) => e.type === 'phone.launch'));
      expect(s.events.filter((e) => e.type === 'phone.launch')).toEqual([{ type: 'phone.launch', launch: { sessionId: 's-new', phone: 'iPhone', projectId: 'project-a', scratch: false, permissionMode: 'bypassPermissions', title: '会話 1 を始める', at: expect.any(Number) } }]);
      await deliver(s, 'l2', {}, 'phone-9');
      await settle(() => s.events.filter((e) => e.type === 'phone.launch').length === 2);
      expect(s.events.filter((e) => e.type === 'phone.launch').at(-1)).toMatchObject({ launch: { phone: null, permissionMode: '' } });
      s.mobile.stop();
    });

    it('知らないスマホの ID で一覧を読み直すのは、同じ ID では最後の読み直しから 10 秒に 1 回まで', async () => {
      const s = setup({ devices: devicesDto([device('pc-a', 'pc')]) });
      placeProject(s.db);
      s.mobile.start();
      await s.cloudDevices();
      const launched = () => s.events.filter((e) => e.type === 'phone.launch').length;
      const reads = () => s.cloudDevices.mock.calls.length;
      const base = reads();
      await deliver(s, 'l1', {}, 'phone-9');
      await settle(() => launched() === 1);
      expect(reads()).toBe(base + 1);
      // 10 秒の内の同じ ID は読み直さない。違う ID は読み直す。
      await deliver(s, 'l2', {}, 'phone-9');
      await settle(() => launched() === 2);
      expect(reads()).toBe(base + 1);
      await deliver(s, 'l3', {}, 'phone-8');
      await settle(() => launched() === 3);
      expect(reads()).toBe(base + 2);
      // 10 秒たてば、同じ ID でも読み直し、名簿に入っていれば名前を出す。
      s.setDevices(devicesDto([device('pc-a', 'pc'), { ...device('phone-9', 'mobile'), name: 'iPhone' }]));
      await s.timers.advance(10_000);
      await deliver(s, 'l4', {}, 'phone-9');
      await settle(() => launched() === 4);
      expect(reads()).toBe(base + 3);
      expect(s.events.filter((e) => e.type === 'phone.launch').at(-1)).toMatchObject({ launch: { phone: 'iPhone' } });
      s.mobile.stop();
    });

    it('effort と画像つきの依頼を、hangar の home の drops に画像を置き、effort とパスつきの指示で起こす', async () => {
      const s = setup();
      placeProject(s.db);
      s.mobile.start();
      const key = await mobileKey();
      s.client.putBlob('l1', 0, await sealBytes(key, aadImage('l1', 0), new Uint8Array([7, 7, 7])));
      await deliver(s, 'l1', { effort: 'high', images: [{ n: 0, mime: 'image/png', bytes: 3 }] });
      await settle(() => s.client.launches.get('l1')!.status === 'started');
      const [f] = fs.readdirSync(path.join(s.homeDir, 'drops'));
      expect(s.start).toHaveBeenCalledWith({ projectId: 'project-a', account: 'primary', effort: 'high', prompt: `会話 1 を始める\n\n${quotePath(path.join(s.homeDir, 'drops', f!))}` });
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

  describe('呼び鈴', () => {
    /** Worker の /m/bell の真似。受けた見出しとつながりを覚える。 */
    async function fakeBellWorker() {
      const attempts: IncomingHttpHeaders[] = [];
      const conns: WsSocket[] = [];
      const received: string[] = [];
      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: (info, cb) => { attempts.push(info.req.headers); cb(true); } });
      wss.on('connection', (ws) => { conns.push(ws); ws.on('message', (d) => { received.push(d.toString()); }); });
      await new Promise<void>((r) => wss.once('listening', () => r()));
      const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/m/bell`;
      return { url, attempts, received, open: () => conns.filter((c) => c.readyState === c.OPEN), close: () => new Promise<void>((r) => { for (const c of conns) c.terminate(); wss.close(() => r()); }) };
    }
    const quiet = () => new Promise((r) => setTimeout(r, 40));

    async function bellSetup(o: { workerCompat?: number; devices?: CloudDevicesDto } = {}) {
      const w = await fakeBellWorker();
      const s = setup(o.devices ? { devices: o.devices } : {});
      s.client.workerCompat = o.workerCompat ?? COMPAT_VERSION;
      // Worker と 1 度話して版を覚える（本物は pull の応答で覚える）。
      // この PC の下限（MIN_WORKER_COMPAT）より古い Worker は断られるが、名乗った版は覚える。
      await s.client.health().catch(() => {});
      const bellTarget = vi.fn((): BellTarget => ({ url: w.url, headers: { authorization: 'Bearer pc-token', [COMPAT_HEADER]: String(COMPAT_VERSION) } }));
      (s.client as CloudClient).bellTarget = bellTarget;
      return { ...s, w, bellTarget };
    }
    const cleanups: (() => Promise<void> | void)[] = [];
    afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

    it('Worker の版が 8 以上でスマホが 1 台以上あれば、Bearer と互換の版でつなぐ。鳴ったら今の engine の pullNow を呼ぶ', async () => {
      const s = await bellSetup();
      cleanups.push(() => s.mobile.stop(), () => s.w.close());
      s.mobile.start();
      await settle(() => s.w.open().length === 1);
      expect(s.w.attempts[0]!.authorization).toBe('Bearer pc-token');
      expect(s.w.attempts[0]![COMPAT_HEADER]).toBe(String(COMPAT_VERSION));
      s.w.open()[0]!.send(JSON.stringify({ t: 'launch' }));
      await settle(() => s.engine().pullNow.mock.calls.length === 1);
    });

    it(`Worker の版が ${MOBILE_BELL_MIN_WORKER_COMPAT} 未満ならつながない`, async () => {
      const s = await bellSetup({ workerCompat: MOBILE_BELL_MIN_WORKER_COMPAT - 1 });
      cleanups.push(() => s.mobile.stop(), () => s.w.close());
      s.mobile.start();
      await quiet();
      await s.timers.advance(FEED_SAFETY_MS);
      await quiet();
      expect(s.w.attempts).toHaveLength(0);
    });

    it('スマホが 1 台も無ければつながず、現れたらつなぎ、外したら閉じる', async () => {
      const s = await bellSetup({ devices: noPhone() });
      cleanups.push(() => s.mobile.stop(), () => s.w.close());
      s.mobile.start();
      await quiet();
      expect(s.w.attempts).toHaveLength(0);
      s.uiLoads(withPhone());
      await settle(() => s.w.open().length === 1);
      s.uiLoads(devicesDto([device('pc-a', 'pc'), device('phone-1', 'mobile', 5)]));
      await settle(() => s.w.open().length === 0);
    });

    it('問い合わせに、この PC のプロジェクトの根で答え、封じた答えを返す', async () => {
      const s = await bellSetup();
      cleanups.push(() => s.mobile.stop(), () => s.w.close());
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-bell-'));
      fs.writeFileSync(path.join(root, 'one.ts'), 'x');
      upsertShared(s.db, 'projects', { id: 'project-a', name: 'project-a', status: 'active', is_scratch: 0 }, 'pc-a');
      upsertShared(s.db, 'project_roots', { id: 'r-a', project_id: 'project-a', device_id: 'pc-a', path: root, resolved: 1 }, 'pc-a');
      s.mobile.start();
      await settle(() => s.w.open().length === 1);
      const key = await mobileKey();
      const ws = s.w.open()[0]!;
      ws.send(JSON.stringify({ t: 'ask', id: 'q1', sealed: await seal(key, aadAsk('q1', 'pc-a'), { v: 1, kind: 'files', projectId: 'project-a', q: '' } satisfies MobileAsk), epoch: 1 }));
      ws.send(JSON.stringify({ t: 'ask', id: 'q2', sealed: await seal(key, aadAsk('q2', 'pc-a'), { v: 1, kind: 'files', projectId: 'project-none', q: '' } satisfies MobileAsk), epoch: 1 }));
      ws.send(JSON.stringify({ t: 'ask', id: 'q3', sealed: await seal(key, aadAsk('q3', 'pc-a'), { v: 1, kind: 'commands', projectId: null, accountId: 'nobody' } satisfies MobileAsk), epoch: 1 }));
      await settle(() => s.w.received.filter((x) => x.startsWith('{')).length === 3);
      const replies = new Map(s.w.received.filter((x) => x.startsWith('{')).map((x) => JSON.parse(x) as { t: string; id: string; sealed: string }).map((m) => [m.id, m]));
      expect(await open(key, aadReply('q1'), replies.get('q1')!.sealed)).toEqual({ files: [{ path: 'one.ts', changed: false }] });
      expect(await open(key, aadReply('q2'), replies.get('q2')!.sealed)).toEqual({ error: 'project-missing' });
      expect(await open(key, aadReply('q3'), replies.get('q3')!.sealed)).toEqual({ error: 'account-missing' });
    });

    it('リンクが変わったら古いのを閉じて組み直し、同期を外したら閉じる。stop でも閉じる', async () => {
      const s = await bellSetup();
      const w2 = await fakeBellWorker();
      cleanups.push(() => s.mobile.stop(), () => s.w.close(), () => w2.close());
      s.mobile.start();
      await settle(() => s.w.open().length === 1);
      const next = s.client.asDevice('pc-a');
      await next.health();
      (next as CloudClient).bellTarget = () => ({ url: w2.url, headers: { authorization: 'Bearer next-token' } });
      s.setLink(linkOf(next, 'https://w2.example'));
      await s.timers.advance(FEED_SAFETY_MS);
      await settle(() => s.w.open().length === 0 && w2.open().length === 1);
      expect(w2.attempts[0]!.authorization).toBe('Bearer next-token');
      s.setLink(null);
      await s.timers.advance(FEED_SAFETY_MS);
      await settle(() => w2.open().length === 0);
      s.setLink(linkOf(next, 'https://w2.example'));
      await s.timers.advance(FEED_SAFETY_MS);
      await settle(() => w2.open().length === 1);
      s.mobile.stop();
      await settle(() => w2.open().length === 0);
    });
  });
});
