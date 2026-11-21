import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveEpochKeys, openPeerLaunch, randomEpochKey, type DeviceStatus, type PeerKeyring, type PeerLaunchApi } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { PEER_ONLINE_MS, type PeerCallDeps } from './caller.ts';
import { getPeerRequest, SCREEN_CALLER } from './outbox.ts';
import { ownerOf, wakeOnOwner, WAKE_WAIT_MS } from './screenWake.ts';

const ME = 'pc-a';
const PEER = 'pc-b';
const T0 = 10_000_000;

const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({ accounts: [], agents: ['claude-code'], lan_ips: [], ssh_host_key: null, hangar_version: '9.9.9', ...over });

let db: Db;
let a: FakeCloudClient;
let ring: PeerKeyring;
let peer: PeerCallDeps;
let t: number;
let syncs: number;
let onSync: (() => void) | null;

const putPeer = (over: { status?: DeviceStatus | null; lastSeen?: number } = {}) => {
  upsertShared(db, 'devices', { id: PEER, name: 'Mac', platform: 'darwin', last_seen_at: over.lastSeen ?? T0 - 60_000, status: over.status === null ? null : JSON.stringify(over.status ?? status()) }, PEER);
};
const putRun = (id: string, device: string, startedAt: number) => {
  upsertShared(db, 'runs', { id, session_id: 's1', device_id: device, kind: 'start', tmux_name: `hangar-${id}`, pid: null, launch_params: '{}', started_at: startedAt, ended_at: startedAt + 1, end_reason: 'exited', heartbeat_at: startedAt }, device);
};
const wake = () => wakeOnOwner({
  db, deviceId: ME, peer, language: () => 'ja',
  sync: async () => { syncs++; onSync?.(); },
  sleep: async (ms) => { t += ms; },
}, 's1');
const answer = (state: 'done' | 'refused' | 'expired') => () => { db.prepare('update peer_outbox set state = ? where request_id = ?').run(state, 'req-1'); };

beforeEach(async () => {
  t = T0; syncs = 0; onSync = null;
  db = openDb(':memory:');
  a = new FakeCloudClient({ deviceId: ME, now: () => t });
  await a.asDevice(PEER).wire.pullChanges(0, 10);
  const keys = await deriveEpochKeys(1, randomEpochKey());
  ring = { current: () => keys, at: (n) => (n === 1 ? keys : null) };
  upsertShared(db, 'devices', { id: ME, name: 'Win', platform: 'win32', last_seen_at: T0 }, ME);
  const api: PeerLaunchApi = a.peerLaunch;
  peer = { link: () => ({ api, ring: async () => ring }), workerOk: () => true, now: () => t, version: '1.0.0', newId: () => 'req-1' };
  putPeer();
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: PEER, project_id: null }, PEER);
  putRun('r1', ME, T0 - 5000);
  putRun('r2', PEER, T0 - 1000);
});
afterEach(() => { db.close(); });

describe('ownerOf', () => {
  it('最後の run の PC を返す。手元か run が無ければ null', () => {
    expect(ownerOf(db, ME, 's1')).toEqual({ deviceId: PEER, name: 'Mac' });
    putRun('r3', ME, T0 - 10);
    expect(ownerOf(db, ME, 's1')).toBeNull();
    expect(ownerOf(db, ME, 'none')).toBeNull();
  });
});

describe('wakeOnOwner', () => {
  it('親の空の wake を封じて置き、相手が ok で答えれば woken-remote', async () => {
    onSync = answer('done');
    expect(await wake()).toBe('woken-remote');
    expect(getPeerRequest(db, 'req-1')).toMatchObject({ caller_session_id: SCREEN_CALLER, to_device: PEER, op: 'wake', child_session_id: 's1' });
    const put = (await a.asDevice(PEER).wire.pullChanges(0, 10)).peerLaunches ?? [];
    const opened = await openPeerLaunch(ring, { requestId: 'req-1', from: ME, to: PEER }, put[0]!.sealed);
    expect(opened).toMatchObject({ op: 'wake', parentSessionId: '', targetSessionId: 's1', prompt: '' });
  });

  it('断り（refused）や期限切れ（expired）なら fallback', async () => {
    onSync = answer('refused');
    expect(await wake()).toBe('fallback');
    db.prepare('delete from peer_outbox').run();
    onSync = answer('expired');
    expect(await wake()).toBe('fallback');
  });

  it('20 秒たっても答えが無ければ fallback で、途中で何度も同期を回す', async () => {
    expect(await wake()).toBe('fallback');
    expect(t - T0).toBeGreaterThanOrEqual(WAKE_WAIT_MS);
    expect(syncs).toBeGreaterThanOrEqual(3);
  });

  it('相手が古い版、黙っている、引けない、手元の run のときは、送らずに fallback', async () => {
    putPeer({ status: status({ hangar_version: '0.0.1' }) });
    expect(await wake()).toBe('fallback');
    putPeer({ lastSeen: T0 - PEER_ONLINE_MS - 1 });
    expect(await wake()).toBe('fallback');
    expect(getPeerRequest(db, 'req-1')).toBeNull();
    putPeer();
    peer = { ...peer, link: () => null };
    expect(await wake()).toBe('fallback');
    expect(getPeerRequest(db, 'req-1')).toBeNull();
    peer = { ...peer, link: () => ({ api: a.peerLaunch, ring: async () => ring }) };
    putRun('r3', ME, T0 - 10);
    expect(await wake()).toBe('fallback');
    expect(getPeerRequest(db, 'req-1')).toBeNull();
  });
});
