import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveEpochKeys, randomEpochKey, type DeviceStatus, type PeerDeviceDto, type PeerLaunchOutcomeDto } from '@agent-hangar/shared';
import { upsertShared } from '../../db/shared.ts';
import { issueMcpSecret } from '../../runs/secrets.ts';
import { getPeerRequest, SCREEN_CALLER } from '../../peer/outbox.ts';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 新規ダイアログの PC の選択（routes/peerLaunch.ts）。

const PEER = 'pc-b';
let t: TestWorld;
let app: ReturnType<typeof createApp>;
let cloud: FakeCloudClient;

const status: DeviceStatus = { accounts: [{ agent: 'claude-code', name: 'Work', logged_in: true }], agents: ['claude-code'], lan_ips: [], ssh_host_key: null, hangar_version: '9.9.9' };
const json = { ...H, 'content-type': 'application/json' };
const post = (b: unknown, headers: Record<string, string> = json) => app.request('/api/peer-launch', { method: 'POST', headers, body: JSON.stringify(b) });

beforeEach(async () => {
  t = await testDeps();
  cloud = new FakeCloudClient({ deviceId: t.deps.deviceId, now: () => Date.now() });
  await cloud.asDevice(PEER).wire.pullChanges(0, 10);
  const keys = await deriveEpochKeys(1, randomEpochKey());
  const ring = { current: () => keys, at: (n: number) => (n === 1 ? keys : null) };
  upsertShared(t.db, 'devices', { id: PEER, name: 'Mac', platform: 'darwin', last_seen_at: Date.now(), status: JSON.stringify(status) }, PEER);
  upsertShared(t.db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, PEER);
  upsertShared(t.db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: PEER, path: '/w/alpha', resolved: 1 }, PEER);
  t.deps.peerCall = { link: () => ({ api: cloud.peerLaunch, ring: async () => ring }), workerOk: () => true, newId: () => 'req-1' };
  app = createApp(t.deps);
});
afterEach(() => { t.dispose(); });

describe('/api/peers と /api/peer-launch', () => {
  it('GET /api/peers は、ほかの PC の様子と頼めるかを返す', async () => {
    const body = await (await app.request('/api/peers', { headers: H })).json() as { peers: PeerDeviceDto[] };
    expect(body.peers).toEqual([{ id: PEER, name: 'Mac', platform: 'darwin', state: 'ready', accounts: [{ name: 'Work', agent: 'claude-code', loggedIn: true }], agents: ['claude-code'], projects: ['p1'] }]);
  });

  it('POST は頼みを置いて requested を返し、親の会話の無い頼みとして記録する', async () => {
    const r = await post({ device: 'Mac', projectId: 'p1', scratch: false, agent: 'claude-code', account: 'Work', prompt: '直して' });
    expect(r.status).toBe(200);
    expect(await r.json() as PeerLaunchOutcomeDto).toEqual({ status: 'requested', requestId: 'req-1', device: 'Mac' });
    expect(getPeerRequest(t.db, 'req-1')).toMatchObject({ caller_session_id: SCREEN_CALLER, to_device: PEER });
  });

  it('置く前に断れるものは、reason と文で返す', async () => {
    const r = await (await post({ device: 'Mac', projectId: 'p1', scratch: false, agent: 'claude-code', account: 'Nobody' })).json() as PeerLaunchOutcomeDto;
    expect(r).toMatchObject({ status: 'refused', reason: 'account-missing', message: expect.stringContaining('Mac') });
    expect(getPeerRequest(t.db, 'req-1')).toBeNull();
  });

  it('形の合わない本体は 400', async () => {
    expect((await post({ device: 'Mac', projectId: null, scratch: false, agent: 'claude-code' })).status).toBe(400);
    expect((await post({ device: 'Mac', scratch: true, projectId: null, agent: 'nope' })).status).toBe(400);
  });

  it('MCP の秘密では呼べない。エージェントが承認なしで別の PC に起こす道にしない', async () => {
    const sid = (t.db.prepare('select id from sessions limit 1').get() as { id: string } | undefined)?.id ?? 's1';
    const secret = issueMcpSecret(t.db, sid, 1);
    const h = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
    expect((await post({ device: 'Mac', scratch: true, projectId: null, agent: 'claude-code' }, h)).status).toBe(401);
    expect((await app.request('/api/peers', { headers: h })).status).toBe(401);
  });
});
