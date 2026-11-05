import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertShared } from '../../db/shared.ts';
import { PeerSshStore } from '../../peer/ssh/config.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 設定「ほかの PC」の SSH の登録（routes/peerSsh.ts）と、/peer の入口が app に載ること。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let store: PeerSshStore;
beforeEach(async () => {
  t = await testDeps();
  store = new PeerSshStore(t.deps.home);
  const status = { accounts: [], agents: ['claude'], lan_ips: ['192.168.0.20'], ssh_host_key: 'SHA256:abc', hangar_version: '0.18.0' };
  upsertShared(t.deps.db, 'devices', { id: 'dev-mac', name: 'mac', platform: 'darwin', status: JSON.stringify(status), deleted_at: null }, 'dev-mac');
  upsertShared(t.deps.db, 'devices', { id: 'dev-old', name: 'old', platform: 'linux', status: null, deleted_at: null }, 'dev-old');
  app = createApp({ ...t.deps, peerSsh: { endpoint: { selfId: t.deps.deviceId, tokens: () => null, inbox: () => null }, store, hostKeyState: (id) => (id === 'dev-mac' ? 'ok' : 'unchecked') } });
});
afterEach(() => { t.dispose(); });

const json = { ...H, 'content-type': 'application/json' };
/** 鍵のパスは、試験を回す OS の絶対パスで書く（route は手元の OS の形で確かめる）。 */
const KEY = process.platform === 'win32' ? 'C:\\Users\\a\\.ssh\\id_ed25519' : '/home/a/.ssh/id_ed25519';

describe('/api/peer-ssh', () => {
  it('同期で知っている PC と、その登録と照合の様子を返す', async () => {
    const body = await (await app.request('/api/peer-ssh', { headers: H })).json();
    expect(body.devices).toEqual([
      { device_id: 'dev-mac', name: 'mac', platform: 'darwin', lan_ips: ['192.168.0.20'], ssh_host_key: 'SHA256:abc', ssh: null, hostKey: 'ok' },
      { device_id: 'dev-old', name: 'old', platform: 'linux', lan_ips: [], ssh_host_key: null, ssh: null, hostKey: 'none' },
    ]);
  });

  it('登録して読み、消せる', async () => {
    const put = await app.request('/api/peer-ssh/dev-mac', { method: 'PUT', headers: json, body: JSON.stringify({ user: 'alice', keyPath: KEY }) });
    expect(put.status).toBe(200);
    expect(store.get('dev-mac')).toEqual({ user: 'alice', keyPath: KEY, sshPort: 22, hangarPort: 4177 });
    const body = await (await app.request('/api/peer-ssh', { headers: H })).json();
    expect(body.devices[0].ssh.user).toBe('alice');
    expect(await (await app.request('/api/peer-ssh/dev-mac', { method: 'DELETE', headers: H })).json()).toEqual({ ok: true, removed: true });
    expect(store.get('dev-mac')).toBeNull();
  });

  it('知らない PC と誤った入力を断る', async () => {
    expect((await app.request('/api/peer-ssh/dev-x', { method: 'PUT', headers: json, body: JSON.stringify({ user: 'a', keyPath: '/k' }) })).status).toBe(404);
    const bad = await app.request('/api/peer-ssh/dev-mac', { method: 'PUT', headers: json, body: JSON.stringify({ user: '-oProxyCommand=x', keyPath: '/k' }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid', field: 'user' });
  });

  it('利用者の token が無ければ読めない。/peer は利用者の token を受けない', async () => {
    expect((await app.request('/api/peer-ssh')).status).toBe(401);
    expect((await app.request('/peer/health', { headers: H })).status).toBe(401);
  });
});
