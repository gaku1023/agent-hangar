import { describe, expect, it } from 'vitest';
import type { PeerDeviceStatus, PeerKeyring, PeerLaunchApi } from '@agent-hangar/shared';
import { choosePeerRoute, peerVias, type PeerSshRouteDeps } from './caller.ts';
import { PeerSshConnectError } from './ssh/link.ts';

const NOW = 1_800_000_000_000;
const cloudApi = { tag: 'cloud' } as unknown as PeerLaunchApi;
const sshApi = { tag: 'ssh' } as unknown as PeerLaunchApi;
const ring = async (): Promise<PeerKeyring> => { throw new Error('unused'); };

const peer = (over: Partial<PeerDeviceStatus> = {}, status: Partial<NonNullable<PeerDeviceStatus['status']>> | null = {}): PeerDeviceStatus => ({
  device_id: 'dev-mac', name: 'Mac', platform: 'darwin', last_seen_at: NOW - 1000, outdated: false,
  status: status === null ? null : { accounts: [], agents: [], lan_ips: ['192.168.0.20'], ssh_host_key: 'SHA256:abc', hangar_version: '0.19.0', ...status },
  ...over,
});

function deps(o: { cloud?: boolean; worker?: boolean; ssh?: Partial<PeerSshRouteDeps> | null } = {}) {
  const ssh: PeerSshRouteDeps | undefined = o.ssh === null ? undefined : { registered: () => true, api: () => sshApi, ring: () => ring, tokensReady: () => true, ...o.ssh };
  return {
    link: () => (o.cloud === false ? null : { api: cloudApi, ring }),
    workerOk: () => o.worker !== false,
    ...(ssh ? { ssh } : {}),
  };
}

describe('choosePeerRoute（受け入れ 17）', () => {
  it('両方の PC がクラウドに参加していて Worker の版が足りれば、SSH が登録済みでもクラウド', () => {
    const r = choosePeerRoute(peer(), deps(), NOW);
    expect(r).toMatchObject({ via: 'cloud', api: cloudApi });
  });

  it('呼ぶ側の手元がクラウドに未参加で、SSH が登録済みなら SSH', () => {
    expect(choosePeerRoute(peer(), deps({ cloud: false }), NOW)).toMatchObject({ via: 'ssh', api: sshApi });
  });

  it('相手の行が古い（last_seen_at が鮮度の外）なら、SSH が登録済みなら SSH、無ければ device-offline', () => {
    const stale = peer({ last_seen_at: NOW - 60 * 60_000 });
    expect(choosePeerRoute(stale, deps(), NOW)).toMatchObject({ via: 'ssh' });
    expect(choosePeerRoute(stale, deps({ ssh: null }), NOW)).toEqual({ refuse: 'device-offline' });
  });

  it('Worker の版が足りなければ、SSH があれば SSH、無ければ device-outdated（封の鍵は参加していれば持つ）', () => {
    expect(choosePeerRoute(peer(), deps({ worker: false }), NOW)).toMatchObject({ via: 'ssh' });
    expect(choosePeerRoute(peer(), deps({ worker: false, ssh: null }), NOW)).toEqual({ refuse: 'device-outdated' });
  });

  it('SSH を使わない条件：未登録、相手がホスト鍵か宛先を知らせていない、封か token の鍵が無い。どれも device-offline か device-outdated になる', () => {
    const offline = { last_seen_at: NOW - 60 * 60_000 };
    expect(choosePeerRoute(peer(offline), deps({ ssh: { registered: () => false } }), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(peer(offline, { ssh_host_key: null }), deps(), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(peer(offline, { lan_ips: [] }), deps(), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(peer(offline), deps({ ssh: { ring: () => null } }), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(peer(offline), deps({ ssh: { tokensReady: () => false } }), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(peer({ outdated: true }, null), deps(), NOW)).toEqual({ refuse: 'device-outdated' });
  });

  it('選んだ経路は 1 つで、SSH を選んだ後は SSH の口が断ってもクラウドの口には替わらない（乗り換えない）', async () => {
    let cloudUsed = 0;
    const failing: PeerLaunchApi = { ...sshApi, put: () => Promise.reject(new PeerSshConnectError('ssh-unreachable')) } as PeerLaunchApi;
    const d = deps({ cloud: true, ssh: { api: () => failing } });
    // 相手の行が古いので ssh を選ぶ。クラウドの口は、選ばれた経路に含まれない。
    const route = choosePeerRoute(peer({ last_seen_at: NOW - 60 * 60_000 }), { ...d, link: () => { cloudUsed++; return { api: cloudApi, ring }; } }, NOW);
    if (!('via' in route)) throw new Error('refused');
    expect(route.via).toBe('ssh');
    await expect(route.api.put({ id: 'x', to: 'dev-mac', sealed: '1.x' })).rejects.toMatchObject({ reason: 'ssh-unreachable' });
    expect(route.api).toBe(failing);
  });
});

describe('peerVias', () => {
  it('list_devices の via に、使える経路を並べる', () => {
    expect(peerVias(peer(), deps())).toEqual(['cloud', 'ssh']);
    expect(peerVias(peer(), deps({ cloud: false }))).toEqual(['ssh']);
    expect(peerVias(peer(), deps({ ssh: null }))).toEqual(['cloud']);
    expect(peerVias(peer({ outdated: true }, null), deps())).toEqual([]);
  });
});
