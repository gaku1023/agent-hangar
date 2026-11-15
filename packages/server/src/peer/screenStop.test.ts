import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveEpochKeys, openPeerLaunch, randomEpochKey, type DeviceStatus, type PeerKeyring, type PeerLaunchApi } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { PEER_ONLINE_MS, type PeerCallDeps } from './caller.ts';
import { getPeerRequest, SCREEN_CALLER } from './outbox.ts';
import { stopFromScreen } from './screenStop.ts';

const ME = 'pc-a';
const PEER = 'pc-b';
const NOW = 10_000_000;

const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({ accounts: [], agents: ['claude-code'], lan_ips: [], ssh_host_key: null, hangar_version: '9.9.9', ...over });

let db: Db;
let a: FakeCloudClient;
let ring: PeerKeyring;
let peer: PeerCallDeps;

const putPeer = (over: { status?: DeviceStatus | null; lastSeen?: number } = {}) => {
  upsertShared(db, 'devices', { id: PEER, name: 'Mac', platform: 'darwin', last_seen_at: over.lastSeen ?? NOW - 60_000, status: over.status === null ? null : JSON.stringify(over.status ?? status()) }, PEER);
};
const putRun = (id: string, device: string, ended: number | null = null) => {
  upsertShared(db, 'runs', { id, session_id: 's1', device_id: device, kind: 'start', tmux_name: `hangar-${id}`, pid: null, launch_params: '{}', started_at: NOW - 1000, ended_at: ended, end_reason: ended ? 'exited' : null, heartbeat_at: NOW - 1000 }, device);
};
const run = (sessionId = 's1') => stopFromScreen({ db, deviceId: ME, peer, language: () => 'ja' }, { sessionId });

beforeEach(async () => {
  db = openDb(':memory:');
  a = new FakeCloudClient({ deviceId: ME, now: () => NOW });
  await a.asDevice(PEER).wire.pullChanges(0, 10);
  const keys = await deriveEpochKeys(1, randomEpochKey());
  ring = { current: () => keys, at: (n) => (n === 1 ? keys : null) };
  upsertShared(db, 'devices', { id: ME, name: 'Win', platform: 'win32', last_seen_at: NOW }, ME);
  const api: PeerLaunchApi = a.peerLaunch;
  peer = { link: () => ({ api, ring: async () => ring }), workerOk: () => true, now: () => NOW, version: '1.0.0', newId: () => 'req-1' };
  putPeer();
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: PEER, project_id: null }, PEER);
  putRun('r1', PEER);
});
afterEach(() => { db.close(); });

describe('stopFromScreen', () => {
  it('会話のロックの PC に、親の会話が空の stop を封じて置き、画面の頼みとして記録する', async () => {
    expect(await run()).toEqual({ status: 'requested', requestId: 'req-1', device: 'Mac' });
    expect(getPeerRequest(db, 'req-1')).toMatchObject({ caller_session_id: SCREEN_CALLER, to_device: PEER, op: 'stop', child_session_id: 's1', state: 'requested' });
    const put = (await a.asDevice(PEER).wire.pullChanges(0, 10)).peerLaunches ?? [];
    expect(put).toHaveLength(1);
    const opened = await openPeerLaunch(ring, { requestId: 'req-1', from: ME, to: PEER }, put[0]!.sealed);
    expect(opened).toMatchObject({ op: 'stop', parentSessionId: '', targetSessionId: 's1', prompt: '' });
  });

  it('ほかの PC で動いていない会話は TypeError（ルートは 400）', async () => {
    await expect(run('nope')).rejects.toBeInstanceOf(TypeError);
    putRun('r1', PEER, NOW - 10);
    await expect(run()).rejects.toBeInstanceOf(TypeError);
  });

  it('黙った PC は device-offline、版が足りない PC は device-outdated で、置かずに断る', async () => {
    putPeer({ lastSeen: NOW - PEER_ONLINE_MS - 1 });
    expect(await run()).toMatchObject({ status: 'refused', reason: 'device-offline' });
    putPeer({ status: status({ hangar_version: '0.1.0' }) });
    expect(await run()).toMatchObject({ status: 'refused', reason: 'device-outdated' });
    expect(getPeerRequest(db, 'req-1')).toBeFalsy();
  });
});
