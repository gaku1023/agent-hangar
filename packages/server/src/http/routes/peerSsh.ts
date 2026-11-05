import type { Hono } from 'hono';
import { readPeerStatuses } from '../../config/deviceStatus.ts';
import { isPeerDeviceId, parsePeerSshEntry, type PeerSshEntry } from '../../peer/ssh/config.ts';
import type { HostKeyState } from '../../peer/ssh/connector.ts';
import type { AppDeps } from '../deps.ts';

/**
 * 設定「ほかの PC」の SSH の登録（画面は T14）。
 * - GET    /api/peer-ssh            同期で知っているほかの PC と、その登録と照合の様子。
 * - PUT    /api/peer-ssh/:deviceId  登録する（user、keyPath、sshPort、hangarPort）。
 * - DELETE /api/peer-ssh/:deviceId  登録を消す。
 * 宛先の IP とホスト鍵の指紋は同期の値をそのまま見せ、ここでは書かない。
 */

/** 1 台分の見え方。hostKey は同期に指紋があるか、照合の様子はどうか。 */
export type PeerSshDeviceDto = {
  device_id: string;
  name: string;
  platform: string;
  lan_ips: string[];
  ssh_host_key: string | null;
  ssh: PeerSshEntry | null;
  hostKey: HostKeyState | 'none';
};

export type PeerSshRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'peerSsh'>;

export function peerSshRoutes(api: Hono, deps: PeerSshRouteDeps): void {
  const ssh = deps.peerSsh;
  if (!ssh) return;
  const peers = () => readPeerStatuses(deps.db, deps.deviceId);

  api.get('/peer-ssh', (c) => {
    const reg = ssh.store.list();
    const devices: PeerSshDeviceDto[] = peers().map((p) => ({
      device_id: p.device_id,
      name: p.name,
      platform: p.platform,
      lan_ips: p.status?.lan_ips ?? [],
      ssh_host_key: p.status?.ssh_host_key ?? null,
      ssh: reg[p.device_id] ?? null,
      hostKey: p.status?.ssh_host_key ? ssh.hostKeyState(p.device_id) : 'none',
    }));
    return c.json({ devices });
  });

  api.put('/peer-ssh/:deviceId', async (c) => {
    const id = c.req.param('deviceId');
    if (!isPeerDeviceId(id) || !peers().some((p) => p.device_id === id)) return c.json({ error: 'unknown device' }, 404);
    const r = parsePeerSshEntry(await c.req.json().catch(() => null));
    if (!r.ok) return c.json({ error: 'invalid', field: r.error }, 400);
    ssh.store.set(id, r.entry);
    return c.json({ ok: true, ssh: r.entry });
  });

  api.delete('/peer-ssh/:deviceId', (c) => {
    const id = c.req.param('deviceId');
    if (!isPeerDeviceId(id)) return c.json({ error: 'unknown device' }, 404);
    return c.json({ ok: true, removed: ssh.store.remove(id) });
  });
}
