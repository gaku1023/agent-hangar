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

  it('両方がクラウドに参加していて相手の行が古い（online でない）なら、SSH が登録済みでも SSH に落とさず device-offline', () => {
    const stale = peer({ last_seen_at: NOW - 60 * 60_000 });
    expect(choosePeerRoute(stale, deps(), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(stale, deps({ ssh: null }), NOW)).toEqual({ refuse: 'device-offline' });
  });

  it('Worker の版が足りなければ、SSH が登録済みでも SSH に落とさず device-outdated', () => {
    expect(choosePeerRoute(peer(), deps({ worker: false }), NOW)).toEqual({ refuse: 'device-outdated' });
    expect(choosePeerRoute(peer(), deps({ worker: false, ssh: null }), NOW)).toEqual({ refuse: 'device-outdated' });
  });

  it('SSH を使わない条件：未登録、相手がホスト鍵か宛先を知らせていない、封か token の鍵が無い。どれも device-offline か device-outdated になる', () => {
    const unjoined = (o: Parameters<typeof deps>[0] = {}) => deps({ cloud: false, ...o });
    expect(choosePeerRoute(peer(), unjoined({ ssh: { registered: () => false } }), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(peer({}, { ssh_host_key: null }), unjoined(), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(peer({}, { lan_ips: [] }), unjoined(), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(peer(), unjoined({ ssh: { ring: () => null } }), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(peer(), unjoined({ ssh: { tokensReady: () => false } }), NOW)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute(peer({ outdated: true }, null), unjoined(), NOW)).toEqual({ refuse: 'device-outdated' });
  });

  it('選んだ経路は 1 つで、SSH を選んだ後は SSH の口が断ってもクラウドの口には替わらない（乗り換えない）', async () => {
    const failing: PeerLaunchApi = { ...sshApi, put: () => Promise.reject(new PeerSshConnectError('ssh-unreachable')) } as PeerLaunchApi;
    const d = deps({ cloud: false, ssh: { api: () => failing } });
    // 手元がクラウドに未参加なので ssh を選ぶ。クラウドの口は、選ばれた経路に含まれない。
    const route = choosePeerRoute(peer(), d, NOW);
    if (!('via' in route)) throw new Error('refused');
    expect(route.via).toBe('ssh');
    await expect(route.api.put({ id: 'x', to: 'dev-mac', sealed: '1.x' })).rejects.toMatchObject({ reason: 'ssh-unreachable' });
    expect(route.api).toBe(failing);
  });
});

describe('peerVias', () => {
  it('list_devices の via に、使える経路を並べる', () => {
    expect(peerVias(peer(), deps())).toEqual(['cloud']);
    expect(peerVias(peer(), deps({ cloud: false }))).toEqual(['ssh']);
    expect(peerVias(peer(), deps({ ssh: null }))).toEqual(['cloud']);
    expect(peerVias(peer({ outdated: true }, null), deps())).toEqual([]);
  });
});
