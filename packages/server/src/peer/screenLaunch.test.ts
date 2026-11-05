import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveEpochKeys, openPeerLaunch, randomEpochKey, type DeviceStatus, type PeerKeyring, type PeerLaunchApi, type PeerLaunchBody } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { PEER_ONLINE_MS, type PeerCallDeps } from './caller.ts';
import { getPeerRequest, SCREEN_CALLER } from './outbox.ts';
import { launchFromScreen, listPeersForScreen } from './screenLaunch.ts';

const ME = 'pc-a';
const PEER = 'pc-b';
const NOW = 10_000_000;

const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  accounts: [{ agent: 'claude-code', name: 'Work', logged_in: true }, { agent: 'claude-code', name: 'Out', logged_in: false }, { agent: 'codex', name: 'Sub', logged_in: true }],
  agents: ['claude-code', 'codex'], lan_ips: [], ssh_host_key: null, hangar_version: '9.9.9', ...over,
});

let db: Db;
let a: FakeCloudClient;
let ring: PeerKeyring;
let workerOk: boolean;
let peer: PeerCallDeps;

const putPeer = (over: { status?: DeviceStatus | null; lastSeen?: number } = {}) => {
  upsertShared(db, 'devices', { id: PEER, name: 'Mac', platform: 'darwin', last_seen_at: over.lastSeen ?? NOW - 60_000, status: over.status === null ? null : JSON.stringify(over.status ?? status()) }, PEER);
};
const body = (over: Partial<PeerLaunchBody> = {}): PeerLaunchBody => ({ device: 'Mac', projectId: 'p1', scratch: false, agent: 'claude-code', prompt: '見出しを直して', ...over });
const run = (b: PeerLaunchBody) => launchFromScreen({ db, deviceId: ME, peer, language: () => 'ja' }, b);

beforeEach(async () => {
  db = openDb(':memory:');
  a = new FakeCloudClient({ deviceId: ME, now: () => NOW });
  await a.asDevice(PEER).wire.pullChanges(0, 10);
  const keys = await deriveEpochKeys(1, randomEpochKey());
  ring = { current: () => keys, at: (n) => (n === 1 ? keys : null) };
  workerOk = true;
  upsertShared(db, 'devices', { id: ME, name: 'Win', platform: 'win32', last_seen_at: NOW }, ME);
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, ME);
  upsertShared(db, 'projects', { id: 'p2', name: 'beta', status: 'active', is_scratch: 0 }, ME);
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: PEER, path: '/w/alpha', resolved: 1 }, PEER);
  upsertShared(db, 'project_roots', { id: 'r2', project_id: 'p2', device_id: ME, path: 'C:/w/beta', resolved: 1 }, ME);
  const api: PeerLaunchApi = a.peerLaunch;
  peer = { link: () => ({ api, ring: async () => ring }), workerOk: () => workerOk, now: () => NOW, version: '1.0.0', newId: () => 'req-1' };
  putPeer();
});
afterEach(() => { db.close(); });

describe('listPeersForScreen', () => {
  it('相手の様子（アカウント、エージェント、置き場のあるプロジェクト、頼めるか）を返す。自分は含めない', () => {
    expect(listPeersForScreen(db, ME, peer, NOW)).toEqual([{
      id: PEER, name: 'Mac', platform: 'darwin', state: 'ready',
      accounts: [{ name: 'Work', agent: 'claude-code', loggedIn: true }, { name: 'Out', agent: 'claude-code', loggedIn: false }, { name: 'Sub', agent: 'codex', loggedIn: true }],
      agents: ['claude-code', 'codex'], projects: ['p1'],
    }]);
  });
  it('last_seen_at が古いと offline、様子の欄が無い PC と版が足りない PC は outdated、Worker の版が足りなくても outdated', () => {
    putPeer({ lastSeen: NOW - PEER_ONLINE_MS - 1 });
    expect(listPeersForScreen(db, ME, peer, NOW)[0]!.state).toBe('offline');
    putPeer({ status: null });
    expect(listPeersForScreen(db, ME, peer, NOW)[0]!.state).toBe('outdated');
    putPeer({ status: status({ hangar_version: '0.1.0' }) });
    expect(listPeersForScreen(db, ME, peer, NOW)[0]!.state).toBe('outdated');
    putPeer();
    workerOk = false;
    expect(listPeersForScreen(db, ME, peer, NOW)[0]!.state).toBe('outdated');
  });
  it('消えたプロジェクトと、未解決の置き場は数えない', () => {
    db.prepare("update project_roots set resolved = 0 where id = 'r1'").run();
    expect(listPeersForScreen(db, ME, peer, NOW)[0]!.projects).toEqual([]);
  });
});

describe('launchFromScreen', () => {
  it('頼みを封じて置き、親の会話が空の頼みとして記録する。承認は通らない（D8）', async () => {
    const r = await run(body({ projectId: 'p1', account: 'Work', model: 'sonnet', permissionMode: 'acceptEdits', name: '直す' }));
    expect(r).toEqual({ status: 'requested', requestId: 'req-1', device: 'Mac' });
    const row = getPeerRequest(db, 'req-1');
    expect(row).toMatchObject({ caller_session_id: SCREEN_CALLER, to_device: PEER, op: 'launch', state: 'requested' });
    const put = (await a.asDevice(PEER).wire.pullChanges(0, 10)).peerLaunches ?? [];
    expect(put).toHaveLength(1);
    const opened = await openPeerLaunch(ring, { requestId: 'req-1', from: ME, to: PEER }, put[0]!.sealed);
    expect(opened).toMatchObject({ parentSessionId: '', projectId: 'p1', scratch: false, agent: 'claude-code', account: 'Work', model: 'sonnet', permissionMode: 'acceptEdits', prompt: '見出しを直して', name: '直す' });
  });

  it('ほかのプロジェクトも、クイックセッションも、承認なしで置く。クイックは置き場を見ない', async () => {
    expect((await run(body({ projectId: 'p2' }))).status).toBe('refused');
    upsertShared(db, 'project_roots', { id: 'r3', project_id: 'p2', device_id: PEER, path: '/w/beta', resolved: 1 }, PEER);
    expect((await run(body({ projectId: 'p2' }))).status).toBe('requested');
    expect((await run({ ...body(), projectId: null, scratch: true })).status).toBe('requested');
  });

  it('置く前に断る：device-unknown、device-offline、device-outdated、project-missing、account-missing、account-logged-out、agent-missing', async () => {
    const refusal = async (b: PeerLaunchBody) => { const r = await run(b); return r.status === 'refused' ? r.reason : r.status; };
    expect(await refusal(body({ device: 'Nobody' }))).toBe('device-unknown');
    expect(await refusal(body({ projectId: 'p2' }))).toBe('project-missing');
    expect(await refusal(body({ account: 'Ghost' }))).toBe('account-missing');
    expect(await refusal(body({ account: 'Out' }))).toBe('account-logged-out');
    // 名前は同じでもエージェントが違えば別のアカウント。
    expect(await refusal(body({ account: 'Sub' }))).toBe('account-missing');
    expect(await refusal(body({ agent: 'codex', account: 'Sub' }))).toBe('requested');
    expect(await refusal(body({ agent: 'opencode' }))).toBe('agent-missing');
    putPeer({ lastSeen: NOW - PEER_ONLINE_MS - 1 });
    expect(await refusal(body())).toBe('device-offline');
    putPeer({ status: null });
    expect(await refusal(body())).toBe('device-outdated');
    // 断ったものは何も置かない。
    expect((await a.asDevice(PEER).wire.pullChanges(0, 10)).peerLaunches ?? []).toHaveLength(1);
  });

  it('断りには画面に出す文を付ける', async () => {
    const r = await run(body({ projectId: 'p2' }));
    expect(r).toMatchObject({ status: 'refused', reason: 'project-missing', message: expect.stringContaining('Mac') });
  });

  it('形の合わない本体は投げる（呼び手は 400 にする）', async () => {
    await expect(run({ ...body(), agent: 'nope' as never })).rejects.toThrow();
    await expect(run({ ...body(), projectId: null, scratch: false })).rejects.toThrow();
    await expect(run({ ...body(), projectId: 'p1', scratch: true })).rejects.toThrow();
  });
});
