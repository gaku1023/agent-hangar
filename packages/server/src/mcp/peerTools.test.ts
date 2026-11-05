import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SSH は今回のリリースで止めている。有効にした状態で試す。
vi.mock('../peer/ssh/enabled.ts', () => ({ PEER_SSH_ENABLED: true, whenPeerSshEnabled: <T>(f: () => T) => f() }));
import { deriveEpochKeys, openPeerLaunch, randomEpochKey, type DeviceStatus, type LiveSessionDto, type PeerKeyring, type PeerLaunchApi } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/write.ts';
import { getPeerRequest } from '../peer/outbox.ts';
import { PEER_ONLINE_MS, type PeerCallDeps } from '../peer/caller.ts';
import { PeerSshConnectError } from '../peer/ssh/link.ts';
import { aliveRunForSession } from '../runs/queries.ts';
import { recordSpawn } from '../sessions/spawns.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { callTool, TOOL_NAMES, type ToolDeps } from './tools.ts';

const ME = 'pc-a';
const PEER = 'pc-b';
const NOW = 10_000_000;

const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  accounts: [{ agent: 'claude-code', name: 'Work', logged_in: true }, { agent: 'codex', name: 'Sub', logged_in: false }],
  agents: ['claude-code', 'codex'], lan_ips: ['192.168.0.9'], ssh_host_key: null, hangar_version: '9.9.9', ...over,
});

let db: Db;
let a: FakeCloudClient;
let ring: PeerKeyring;
let workerOk: boolean;
let linkOk: boolean;
let deps: ToolDeps;
let caller: string;
let live: LiveSessionDto[];
let approvals: { requestId: string; to: string }[];
let approvalRequests: Record<string, unknown>[];

const ctx = () => ({ sessionId: caller });
const call = async (name: string, args: Record<string, unknown> = {}, c: { sessionId: string | null } = ctx()) => (await callTool(deps, c, name, args)) as Record<string, unknown>;
const putPeer = (over: { status?: DeviceStatus | null; lastSeen?: number; name?: string; id?: string } = {}) => {
  upsertShared(db, 'devices', { id: over.id ?? PEER, name: over.name ?? 'Mac', platform: 'darwin', last_seen_at: over.lastSeen ?? NOW - 60_000, ...(over.status === null ? {} : { status: JSON.stringify(over.status ?? status()) }) }, over.id ?? PEER);
};

beforeEach(async () => {
  db = openDb(':memory:');
  a = new FakeCloudClient({ deviceId: ME, now: () => NOW });
  await a.asDevice(PEER).wire.pullChanges(0, 10);
  const keys = await deriveEpochKeys(1, randomEpochKey());
  ring = { current: () => keys, at: (n) => (n === 1 ? keys : null) };
  workerOk = true;
  linkOk = true;
  approvals = [];
  approvalRequests = [];
  upsertShared(db, 'devices', { id: ME, name: 'Win', platform: 'win32', last_seen_at: NOW }, ME);
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, ME);
  upsertShared(db, 'projects', { id: 'p2', name: 'beta', status: 'active', is_scratch: 0 }, ME);
  caller = ensureSession(db, 'u1', '/w', ME);
  db.prepare('update sessions set project_id = ? where id = ?').run('p1', caller);
  live = [];
  const api: PeerLaunchApi = a.peerLaunch;
  const peer: PeerCallDeps = {
    link: () => (linkOk ? { api, ring: async () => ring } : null),
    workerOk: () => workerOk,
    now: () => NOW,
    version: '1.0.0',
    newId: () => 'req-1',
    requestApproval: (o) => { approvals.push({ requestId: o.requestId, to: o.to }); approvalRequests.push({ ...o.request, toName: o.toName, scratch: o.scratch }); },
  };
  deps = {
    db, deviceId: ME, port: 4177, live: () => live, peer,
    runs: { start: () => { throw new Error('local start must not run'); }, aliveRun: (id: string) => aliveRunForSession(db, id, ME, NOW), kill: () => { throw new Error('local kill must not run'); } },
    usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }),
    accounts: { store: { list: () => [{ id: 'primary', name: 'Main', dir: '/x', color: '#000' }, { id: 'a2', name: 'Work', dir: '/y', color: '#111' }], current: () => ({ id: 'primary', name: 'Main', dir: '/x', color: '#000' }), get: (id: string) => (id === 'a2' ? { id: 'a2', name: 'Work', dir: '/y', color: '#111' } : id === 'primary' ? { id: 'primary', name: 'Main', dir: '/x', color: '#000' } : null) } as never, usage: { of: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }) } },
  };
});
afterEach(() => { db.close(); });

describe('list_devices', () => {
  it('道具の名前に入っている', () => {
    expect(TOOL_NAMES).toContain('list_devices');
  });

  it('相手のアカウント、ログイン、エージェント、online、経路、版を返し、自分は含めない', async () => {
    putPeer();
    const r = (await call('list_devices')) as unknown as { devices: Record<string, unknown>[] };
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]).toEqual({
      device_id: PEER, name: 'Mac', platform: 'darwin', online: true, last_seen_at: NOW - 60_000, via: ['cloud'], outdated: false,
      accounts: [{ name: 'Work', agent: 'claude-code', logged_in: true }, { name: 'Sub', agent: 'codex', logged_in: false }],
      agents: ['claude-code', 'codex'], hangar_version: '9.9.9',
    });
  });

  it('last_seen_at が古い PC は online でない', async () => {
    putPeer({ lastSeen: NOW - PEER_ONLINE_MS - 1 });
    const r = (await call('list_devices')) as unknown as { devices: { online: boolean }[] };
    expect(r.devices[0]!.online).toBe(false);
  });

  it('様子の欄が無い PC も出し、outdated と分かる欄を付ける', async () => {
    putPeer({ status: null });
    const r = (await call('list_devices')) as unknown as { devices: Record<string, unknown>[] };
    expect(r.devices[0]).toMatchObject({ device_id: PEER, outdated: true, via: [], accounts: [], agents: [], hangar_version: null });
  });

  it('Worker の版が足りないときは経路が空になる', async () => {
    putPeer();
    workerOk = false;
    const r = (await call('list_devices')) as unknown as { devices: { via: string[] }[] };
    expect(r.devices[0]!.via).toEqual([]);
  });
});

describe('create_session の device', () => {
  it('device を省けば今までどおり手元で起こす', async () => {
    await expect(call('create_session', { project_id: 'p1' })).rejects.toThrow('local start must not run');
  });

  it('自分の名前を指せば手元で起こす', async () => {
    await expect(call('create_session', { project_id: 'p1', device: 'Win' })).rejects.toThrow('local start must not run');
  });

  it('同じプロジェクトなら封じて頼みを置き、記録して requested を返す。名前でも ID でも引ける', async () => {
    putPeer();
    const r = await call('create_session', { device: 'mac', prompt: 'やって', name: 'w', auto_approve: true, permission_mode: 'acceptEdits' });
    expect(r).toMatchObject({ status: 'requested', request_id: 'req-1' });
    const put = a.wire.peerLaunches.get('req-1')!;
    expect(put).toMatchObject({ to: PEER, from: ME, status: 'pending' });
    const req = await openPeerLaunch(ring, { requestId: 'req-1', from: ME, to: PEER }, put.sealed);
    expect(req).toMatchObject({ parentSessionId: caller, projectId: 'p1', scratch: false, agent: 'claude-code', prompt: 'やって', name: 'w', permissionMode: 'acceptEdits', autoApprove: true, account: '' });
    expect(getPeerRequest(db, 'req-1')).toMatchObject({ to_device: PEER, caller_session_id: caller, state: 'requested' });
    const r2 = await call('create_session', { device: PEER, prompt: 'もう一つ' });
    expect(r2.status).toBe('requested');
  });

  it('アカウントを省くと、呼び出し元の会話のアカウントの名前を callerAccount に入れる', async () => {
    putPeer();
    db.prepare('insert into runs (id, session_id, device_id, kind, tmux_name, started_at, heartbeat_at, launch_params, updated_at, origin_device) values (?,?,?,?,?,?,?,?,?,?)')
      .run('run-1', caller, ME, 'start', 't', 1, 1, JSON.stringify({ account: 'a2' }), 1, ME);
    await call('create_session', { device: PEER, prompt: 'x' });
    const req = await openPeerLaunch(ring, { requestId: 'req-1', from: ME, to: PEER }, a.wire.peerLaunches.get('req-1')!.sealed);
    expect(req).toMatchObject({ account: '', callerAccount: 'Work' });
  });

  it('アカウントを名指しすればそれを account に入れる', async () => {
    putPeer();
    await call('create_session', { device: PEER, prompt: 'x', account: 'Other' });
    const req = await openPeerLaunch(ring, { requestId: 'req-1', from: ME, to: PEER }, a.wire.peerLaunches.get('req-1')!.sealed);
    expect(req.account).toBe('Other');
  });

  it('自分が別の PC から起こされた会話からは depth-exceeded で、置かずに断る', async () => {
    putPeer();
    recordSpawn(db, ME, caller, 'remote-parent', NOW, { parentDeviceId: PEER, childDeviceId: ME });
    const r = await call('create_session', { device: PEER, prompt: 'x' });
    expect(r).toMatchObject({ status: 'refused', reason: 'depth-exceeded' });
    expect(a.wire.peerLaunches.size).toBe(0);
  });

  it('同じ PC の中で起こされた会話からは起こせる', async () => {
    putPeer();
    recordSpawn(db, ME, caller, 'local-parent', NOW);
    expect((await call('create_session', { device: PEER, prompt: 'x' })).status).toBe('requested');
  });

  it('知らない名前は device-unknown', async () => {
    putPeer();
    expect(await call('create_session', { device: 'Nope' })).toMatchObject({ status: 'refused', reason: 'device-unknown' });
  });

  it('様子の欄が無い PC は device-unknown でなく device-outdated', async () => {
    putPeer({ status: null });
    expect(await call('create_session', { device: 'Mac' })).toMatchObject({ status: 'refused', reason: 'device-outdated' });
    expect(a.wire.peerLaunches.size).toBe(0);
  });

  it('Worker の版が足りなければ device-outdated', async () => {
    putPeer();
    workerOk = false;
    expect(await call('create_session', { device: 'Mac' })).toMatchObject({ status: 'refused', reason: 'device-outdated' });
  });

  it('last_seen_at が古ければ device-offline', async () => {
    putPeer({ lastSeen: NOW - PEER_ONLINE_MS - 1 });
    expect(await call('create_session', { device: 'Mac' })).toMatchObject({ status: 'refused', reason: 'device-offline' });
  });

  it('クラウドに入っていなければ device-offline', async () => {
    putPeer();
    linkOk = false;
    expect(await call('create_session', { device: 'Mac' })).toMatchObject({ status: 'refused', reason: 'device-offline' });
  });

  it('ほかのプロジェクトやクイックセッションを名指しすると approval-pending で、頼みは置かない', async () => {
    putPeer();
    const r = await call('create_session', { device: 'Mac', project_id: 'p2', prompt: 'x' });
    expect(r).toMatchObject({ status: 'approval-pending', request_id: 'req-1' });
    expect(approvals).toEqual([{ requestId: 'req-1', to: PEER }]);
    expect(a.wire.peerLaunches.size).toBe(0);
    const q = await call('create_session', { device: 'Mac', scratch: true, prompt: 'x' });
    expect(q.status).toBe('approval-pending');
    // 承認されたら封じて置くので、頼みの中身は封じる前の値で渡す。
    expect(approvalRequests[0]).toMatchObject({ prompt: 'x', projectId: 'p2', scratch: false, parentSessionId: caller, toName: 'Mac' });
    expect(approvalRequests[1]).toMatchObject({ projectId: null, scratch: true });
  });

  it('呼び出し元の会話が無い共通の URL では断る', async () => {
    putPeer();
    await expect(call('create_session', { device: 'Mac', project_id: 'p1' }, { sessionId: null })).rejects.toThrow();
  });

  it('リモートで使えない引数は断る', async () => {
    putPeer();
    await expect(call('create_session', { device: 'Mac', worktree: 'w' })).rejects.toThrow();
  });
});

describe('create_session の device（SSH の予備、受け入れ 17・18）', () => {
  const sshStatus = () => status({ ssh_host_key: 'SHA256:abc' });
  const puts: string[] = [];
  const withSsh = (api: PeerLaunchApi): void => {
    puts.length = 0;
    deps.peer!.ssh = { registered: () => true, api: () => api, ring: () => async () => ring, tokensReady: () => true };
  };
  const sshApi = (over: Partial<PeerLaunchApi> = {}): PeerLaunchApi => ({ ...a.peerLaunch, put: async (b) => { puts.push(b.id); return { id: b.id, to: b.to, status: 'pending', sealedAnswer: null, resultSeq: 0, updatedAt: NOW }; }, ...over });

  it('クラウドに入っていなければ SSH で頼み、経路を ssh と記録する。クラウドには置かない', async () => {
    putPeer({ status: sshStatus() });
    linkOk = false;
    withSsh(sshApi());
    expect(await call('create_session', { device: 'Mac' })).toMatchObject({ status: 'requested', request_id: 'req-1' });
    expect(puts).toEqual(['req-1']);
    expect(a.wire.peerLaunches.size).toBe(0);
    expect(getPeerRequest(db, 'req-1')).toMatchObject({ via: 'ssh', state: 'requested' });
  });

  it('両方が参加していれば、SSH が登録済みでもクラウドで頼み、経路は cloud', async () => {
    putPeer({ status: sshStatus() });
    withSsh(sshApi());
    expect(await call('create_session', { device: 'Mac' })).toMatchObject({ status: 'requested' });
    expect(puts).toEqual([]);
    expect(a.wire.peerLaunches.has('req-1')).toBe(true);
    expect(getPeerRequest(db, 'req-1')).toMatchObject({ via: 'cloud' });
  });

  it('指紋の食い違いは ssh-host-key-mismatch で断る。何も記録せず、クラウドへも乗り換えない', async () => {
    putPeer({ status: sshStatus() });
    linkOk = false;
    withSsh(sshApi({ put: () => Promise.reject(new PeerSshConnectError('ssh-host-key-mismatch')) }));
    expect(await call('create_session', { device: 'Mac' })).toMatchObject({ status: 'refused', reason: 'ssh-host-key-mismatch' });
    expect(getPeerRequest(db, 'req-1')).toBeNull();
    expect(a.wire.peerLaunches.size).toBe(0);
  });

  it('つながらなければ ssh-unreachable で断る', async () => {
    putPeer({ status: sshStatus() });
    linkOk = false;
    withSsh(sshApi({ put: () => Promise.reject(new PeerSshConnectError('ssh-unreachable', 'network')) }));
    expect(await call('create_session', { device: 'Mac' })).toMatchObject({ status: 'refused', reason: 'ssh-unreachable' });
    expect(getPeerRequest(db, 'req-1')).toBeNull();
  });

  it('両方が参加していて相手が online でなければ、SSH が登録済みでも device-offline（SSH に落とさない）', async () => {
    putPeer({ status: sshStatus(), lastSeen: NOW - PEER_ONLINE_MS - 1 });
    withSsh(sshApi());
    expect(await call('create_session', { device: 'Mac' })).toMatchObject({ status: 'refused', reason: 'device-offline' });
    expect(puts).toEqual([]);
  });

  it('list_devices の via は、クラウドに未参加のときだけ ssh を出す', async () => {
    putPeer({ status: sshStatus() });
    withSsh(sshApi());
    const r = (await call('list_devices')) as unknown as { devices: { via: string[] }[] };
    expect(r.devices[0]!.via).toEqual(['cloud']);
    linkOk = false;
    const r2 = (await call('list_devices')) as unknown as { devices: { via: string[] }[] };
    expect(r2.devices[0]!.via).toEqual(['ssh']);
  });
});

describe('send_to_session と stop_session の別の PC への頼み（D16）', () => {
  /** 相手の PC で動いている、自分が起こした会話。 */
  const spawned = (parent = caller): string => {
    const id = ensureSession(db, 'uc', '/w', PEER);
    recordSpawn(db, ME, id, parent, NOW, { childDeviceId: PEER });
    db.prepare('insert into runs (id, session_id, device_id, kind, tmux_name, started_at, heartbeat_at, launch_params, updated_at, origin_device) values (?,?,?,?,?,?,?,?,?,?)')
      .run('run-c', id, PEER, 'start', 'hangar-c', 1, NOW, '{}', 1, PEER);
    return id;
  };
  const open = async () => openPeerLaunch(ring, { requestId: 'req-1', from: ME, to: PEER }, a.wire.peerLaunches.get('req-1')!.sealed);

  it('起こした相手への send は封じて置き、記録して requested を返す', async () => {
    putPeer();
    const id = spawned();
    const r = await call('send_to_session', { session_id: id, text: '続けて' });
    expect(r).toMatchObject({ status: 'requested', request_id: 'req-1' });
    expect(await open()).toMatchObject({ op: 'send', targetSessionId: id, parentSessionId: caller, prompt: '続けて', scratch: true, projectId: null, agent: 'claude-code', account: '', permissionMode: '', model: '' });
    expect(getPeerRequest(db, 'req-1')).toMatchObject({ to_device: PEER, caller_session_id: caller, op: 'send', child_session_id: id });
  });

  it('起こした相手への stop も同じ口で置く', async () => {
    putPeer();
    const id = spawned();
    const r = await call('stop_session', { session_id: id });
    expect(r).toMatchObject({ status: 'requested', request_id: 'req-1' });
    expect(await open()).toMatchObject({ op: 'stop', targetSessionId: id, prompt: '' });
  });

  it('SSH の経路の send は経路を ssh と記録し、張れなければ ssh-unreachable で断る', async () => {
    putPeer({ status: status({ ssh_host_key: 'SHA256:abc' }) });
    linkOk = false;
    const id = spawned();
    const puts: string[] = [];
    let fail = false;
    const api: PeerLaunchApi = { ...a.peerLaunch, put: async (b) => { if (fail) throw new PeerSshConnectError('ssh-unreachable'); puts.push(b.id); return { id: b.id, to: b.to, status: 'pending', sealedAnswer: null, resultSeq: 0, updatedAt: NOW }; } };
    deps.peer!.ssh = { registered: () => true, api: () => api, ring: () => async () => ring, tokensReady: () => true };
    expect(await call('send_to_session', { session_id: id, text: '続けて' })).toMatchObject({ status: 'requested' });
    expect(puts).toEqual(['req-1']);
    expect(getPeerRequest(db, 'req-1')).toMatchObject({ op: 'send', via: 'ssh' });
    fail = true;
    deps.peer!.newId = () => 'req-2';
    expect(await call('stop_session', { session_id: id })).toMatchObject({ status: 'refused', reason: 'ssh-unreachable' });
    expect(getPeerRequest(db, 'req-2')).toBeNull();
  });

  it('自分が起こしていない別の PC の会話は、今までどおり断り、何も置かない（受け入れ 14）', async () => {
    putPeer();
    const other = ensureSession(db, 'ux', '/w', PEER);
    db.prepare('insert into runs (id, session_id, device_id, kind, tmux_name, started_at, heartbeat_at, launch_params, updated_at, origin_device) values (?,?,?,?,?,?,?,?,?,?)')
      .run('run-x', other, PEER, 'start', 'hangar-x', 1, NOW, '{}', 1, PEER);
    await expect(call('send_to_session', { session_id: other, text: 'x' })).rejects.toThrow('Mac');
    await expect(call('stop_session', { session_id: other })).rejects.toThrow('Mac');
    expect(a.wire.peerLaunches.size).toBe(0);
  });

  it('別の会話が起こした相手にも触れない', async () => {
    putPeer();
    const id = spawned('someone-else');
    await expect(call('send_to_session', { session_id: id, text: 'x' })).rejects.toThrow('Mac');
    expect(a.wire.peerLaunches.size).toBe(0);
  });

  it('wait_for_session と read_session_screen は起こした相手でも断る', async () => {
    putPeer();
    const id = spawned();
    await expect(call('wait_for_session', { session_id: id, timeout_seconds: 0 })).rejects.toThrow('Mac');
    await expect(call('read_session_screen', { session_id: id })).rejects.toThrow('Mac');
  });

  it('古い版の相手には送らず device-outdated で断る', async () => {
    putPeer({ status: status({ hangar_version: '0.9.0' }) });
    const id = spawned();
    expect(await call('send_to_session', { session_id: id, text: 'x' })).toMatchObject({ status: 'refused', reason: 'device-outdated' });
    expect(await call('stop_session', { session_id: id })).toMatchObject({ status: 'refused', reason: 'device-outdated' });
    expect(a.wire.peerLaunches.size).toBe(0);
  });

  it('空白だけと長すぎる本文は断る。相手が落ちていれば device-offline', async () => {
    putPeer();
    const id = spawned();
    await expect(call('send_to_session', { session_id: id, text: '  ' })).rejects.toThrow();
    await expect(call('send_to_session', { session_id: id, text: 'あ'.repeat(8001) })).rejects.toThrow();
    putPeer({ lastSeen: NOW - PEER_ONLINE_MS - 1 });
    expect(await call('send_to_session', { session_id: id, text: 'x' })).toMatchObject({ status: 'refused', reason: 'device-offline' });
  });
});
