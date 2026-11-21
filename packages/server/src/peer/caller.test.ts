import { describe, expect, it } from 'vitest';

import type { PeerDeviceStatus, PeerKeyring, PeerLaunchApi } from '@agent-hangar/shared';
import { choosePeerRoute, peerVias } from './caller.ts';

const NOW = 1_800_000_000_000;
const cloudApi = { tag: 'cloud' } as unknown as PeerLaunchApi;
const ring = async (): Promise<PeerKeyring> => { throw new Error('unused'); };

const peer = (over: Partial<PeerDeviceStatus> = {}, status: Partial<NonNullable<PeerDeviceStatus['status']>> | null = {}): PeerDeviceStatus => ({
  device_id: 'dev-mac', name: 'Mac', platform: 'darwin', last_seen_at: NOW - 1000, outdated: false,
  status: status === null ? null : { accounts: [], agents: [], lan_ips: ['192.168.0.20'], ssh_host_key: 'SHA256:abc', hangar_version: '0.19.0', ...status },
  ...over,
});

function deps(o: { cloud?: boolean; worker?: boolean } = {}) {
  return {
    link: () => (o.cloud === false ? null : { api: cloudApi, ring }),
    workerOk: () => o.worker !== false,
  };
}

describe('choosePeerRoute（受け入れ 17）', () => {
  it('両方の PC がクラウドに参加していて Worker の版が足りれば、クラウド', () => {
    expect(choosePeerRoute(peer(), deps(), NOW)).toMatchObject({ via: 'cloud', api: cloudApi });
  });

  it('相手が SSH のホスト鍵と宛先を知らせていても、クラウドに未参加なら SSH に落とさず device-offline', () => {
    expect(choosePeerRoute(peer(), deps({ cloud: false }), NOW)).toEqual({ refuse: 'device-offline' });
  });

  it('相手の行が古い（online でない）なら device-offline', () => {
    expect(choosePeerRoute(peer({ last_seen_at: NOW - 60 * 60_000 }), deps(), NOW)).toEqual({ refuse: 'device-offline' });
  });

  it('Worker の版が足りなければ worker-outdated、相手の版が古ければ device-outdated、両方なら Worker を先に言う', () => {
    expect(choosePeerRoute(peer(), deps({ worker: false }), NOW)).toEqual({ refuse: 'worker-outdated' });
    expect(choosePeerRoute(peer({ outdated: true }, null), deps(), NOW)).toEqual({ refuse: 'device-outdated' });
    expect(choosePeerRoute(peer({ outdated: true }, null), deps({ worker: false }), NOW)).toEqual({ refuse: 'worker-outdated' });
  });
});

describe('peerVias', () => {
  it('list_devices の via は cloud だけで、使えなければ空', () => {
    expect(peerVias(peer(), deps())).toEqual(['cloud']);
    expect(peerVias(peer(), deps({ cloud: false }))).toEqual([]);
    expect(peerVias(peer({ outdated: true }, null), deps())).toEqual([]);
  });
});
