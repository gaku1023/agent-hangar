import { describe, expect, it, vi } from 'vitest';
import type { PeerDeviceStatus, PeerKeyring, PeerLaunchApi } from '@agent-hangar/shared';
import { choosePeerRoute, peerVias } from '../caller.ts';
import { PEER_SSH_ENABLED, whenPeerSshEnabled } from './enabled.ts';

/** SSH を止めている状態（今回のリリースの既定）。定数は差し替えない。 */
describe('SSH を止めている状態', () => {
  const peer: PeerDeviceStatus = {
    device_id: 'dev-mac', name: 'Mac', platform: 'darwin', last_seen_at: 1, outdated: false,
    status: { accounts: [], agents: [], lan_ips: ['192.168.0.20'], ssh_host_key: 'SHA256:abc', hangar_version: '0.19.0' },
  };
  const ring = async (): Promise<PeerKeyring> => { throw new Error('unused'); };
  // 手元がクラウドに未参加で、SSH が登録済みという、有効なら ssh が選ばれる条件。
  const deps = {
    link: () => null,
    workerOk: () => true,
    ssh: { registered: () => true, api: () => ({}) as PeerLaunchApi, ring: () => ring, tokensReady: () => true },
  };

  it('定数は false', () => {
    expect(PEER_SSH_ENABLED).toBe(false);
  });

  it('経路は ssh を選ばず、via にも出さない。断りは device-offline か device-outdated だけ', () => {
    expect(choosePeerRoute(peer, deps, 1_000)).toEqual({ refuse: 'device-offline' });
    expect(choosePeerRoute({ ...peer, outdated: true, status: null }, deps, 1_000)).toEqual({ refuse: 'device-outdated' });
    expect(peerVias(peer, deps)).toEqual([]);
  });

  it('部品を組まない（トンネルも ssh の子プロセスも起こさない）ので、/peer も /api/peer-ssh も載らない', () => {
    const make = vi.fn(() => ({ spawned: true }));
    expect(whenPeerSshEnabled(make)).toBeNull();
    expect(make).not.toHaveBeenCalled();
  });
});
