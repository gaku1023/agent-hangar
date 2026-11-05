import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { PeerLaunchPut, PeerLaunchStatus } from '@agent-hangar/shared';
import { authMiddleware } from '../http/auth.ts';
import { Keyring } from '../sync/keyring.ts';
import { testCloudConfig, testKey } from '../../test/cloudConfig.ts';
import { PEER_FROM_HEADER, peerRoutes, type PeerInbox } from './endpoint.ts';
import { PeerSshUnsupportedError, sshPeerLaunchApi, sshPeerProbe } from './ssh/client.ts';
import { issuePeerToken, keyringPeerTokenKeys, type PeerTokenKeys } from './ssh/token.ts';

const SEALED = `1.${'A'.repeat(40)}`;
const keysOf = async (n = 3): Promise<PeerTokenKeys> => keyringPeerTokenKeys(Keyring.fromConfig(testCloudConfig({ epochs: { '1': testKey(n) }, currentEpoch: 1 })));

/** 受け口の偽物。置かれた頼みを覚えて、Worker と同じ意味で答える。 */
function fakeInbox() {
  const puts: { from: string; body: PeerLaunchPut }[] = [];
  const owner = new Map<string, string>();
  const status = (id: string): PeerLaunchStatus => ({ id, to: 'pc-b', status: 'pending', sealedAnswer: null, resultSeq: 0, updatedAt: 5 });
  const inbox: PeerInbox = {
    put: async (from, body) => {
      if (owner.has(body.id) && owner.get(body.id) !== from) return 'conflict';
      owner.set(body.id, from);
      puts.push({ from, body });
      return status(body.id);
    },
    outbox: async (from, since) => ({ now: 9, launches: [...owner].filter(([, f]) => f === from).map(([id]) => status(id)).filter(() => since <= 5) }),
    results: async (from, id, after) => (owner.get(id) === from ? { results: [{ seq: after + 1, sealed: SEALED, createdAt: 7 }], more: false } : null),
  };
  return { inbox, puts };
}

/** hangar の本体と同じく、/peer を app に載せる。 */
async function setup(o: { inbox?: PeerInbox | null; keys?: PeerTokenKeys | null } = {}) {
  const keys = o.keys === undefined ? await keysOf() : o.keys;
  const fake = fakeInbox();
  const app = new Hono();
  app.route('/peer', peerRoutes({ selfId: 'pc-b', tokens: () => keys, inbox: () => (o.inbox === undefined ? fake.inbox : o.inbox) }));
  const fetchApp = ((url: string, init?: RequestInit) => Promise.resolve(app.request(url, init))) as typeof fetch;
  return { app, fake, fetchApp, keys };
}

const tokenFor = async (from: string, to: string, n = 3): Promise<string> => (await issuePeerToken(await keysOf(n), from, to))!;

describe('/peer の入口', () => {
  it('トンネル越しのクライアントで頼みを置き、状態と結果を読める', async () => {
    const s = await setup();
    const api = sshPeerLaunchApi({ baseUrl: () => 'http://127.0.0.1:50000', selfId: 'pc-a', peerId: 'pc-b', tokens: () => s.keys, fetch: s.fetchApp });
    expect(await api.put({ id: 'req-1', to: 'pc-b', sealed: SEALED })).toMatchObject({ id: 'req-1', status: 'pending' });
    expect(s.fake.puts).toEqual([{ from: 'pc-a', body: { id: 'req-1', to: 'pc-b', sealed: SEALED, from: 'pc-a' } }]);
    expect((await api.outbox(0)).launches.map((l) => l.id)).toEqual(['req-1']);
    expect(await api.results('req-1', 3)).toEqual({ results: [{ seq: 4, sealed: SEALED, createdAt: 7 }], more: false });
    await expect(api.claim('req-1')).rejects.toBeInstanceOf(PeerSshUnsupportedError);
    await expect(api.answer('req-1', true, SEALED)).rejects.toBeInstanceOf(PeerSshUnsupportedError);
    await expect(api.postResult('req-1', { seq: 1, sealed: SEALED })).rejects.toBeInstanceOf(PeerSshUnsupportedError);
  });

  it('利用者の token、別のグループの token、別の PC 宛ての token、名乗りの違う token を断る', async () => {
    const s = await setup();
    const userToken = 'f'.repeat(64);
    const cases: [string, Record<string, string>][] = [
      ['user token', { authorization: `Bearer ${userToken}`, [PEER_FROM_HEADER]: 'pc-a' }],
      ['other group', { authorization: `Bearer ${await tokenFor('pc-a', 'pc-b', 9)}`, [PEER_FROM_HEADER]: 'pc-a' }],
      ['other target', { authorization: `Bearer ${await tokenFor('pc-a', 'pc-c')}`, [PEER_FROM_HEADER]: 'pc-a' }],
      ['wrong from', { authorization: `Bearer ${await tokenFor('pc-a', 'pc-b')}`, [PEER_FROM_HEADER]: 'pc-x' }],
      ['no from', { authorization: `Bearer ${await tokenFor('pc-a', 'pc-b')}` }],
      ['self as from', { authorization: `Bearer ${await tokenFor('pc-b', 'pc-b')}`, [PEER_FROM_HEADER]: 'pc-b' }],
      ['none', {}],
    ];
    for (const [, headers] of cases) expect((await s.app.request('/peer/health', { headers })).status).toBe(401);
    // 利用者の token をクッキーで送っても通らない。
    expect((await s.app.request('/peer/health', { headers: { cookie: `hangar_token=${userToken}` } })).status).toBe(403);
  });

  it('ブラウザから来た要求は token が正しくても断る', async () => {
    const s = await setup();
    const ok = { authorization: `Bearer ${await tokenFor('pc-a', 'pc-b')}`, [PEER_FROM_HEADER]: 'pc-a' };
    expect((await s.app.request('/peer/health', { headers: ok })).status).toBe(200);
    for (const extra of <Record<string, string>[]>[{ origin: 'http://127.0.0.1:4177' }, { 'sec-fetch-site': 'same-origin' }, { cookie: 'a=b' }]) {
      expect((await s.app.request('/peer/health', { headers: { ...ok, ...extra } })).status).toBe(403);
    }
  });

  it('/peer の下に /mcp や /api は無い', async () => {
    const s = await setup();
    const ok = { authorization: `Bearer ${await tokenFor('pc-a', 'pc-b')}`, [PEER_FROM_HEADER]: 'pc-a' };
    for (const p of ['/peer/mcp', '/peer/api/sessions']) {
      const r = await s.app.request(p, { method: 'POST', headers: { ...ok, 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(404);
    }
  });

  it('PC どうしの token は /api（と同じ照合の /mcp）を通らない', async () => {
    const userToken = 'f'.repeat(64);
    const api = new Hono();
    api.use('*', authMiddleware(userToken, 4177));
    api.get('/x', (c) => c.json({ ok: true }));
    const peerToken = await tokenFor('pc-a', 'pc-b');
    expect((await api.request('/x', { headers: { authorization: `Bearer ${peerToken}`, [PEER_FROM_HEADER]: 'pc-a' } })).status).toBe(401);
    expect((await api.request('/x', { headers: { authorization: `Bearer ${userToken}` } })).status).toBe(200);
  });

  it('頼みの形を確かめる', async () => {
    const s = await setup();
    const h = { authorization: `Bearer ${await tokenFor('pc-a', 'pc-b')}`, [PEER_FROM_HEADER]: 'pc-a', 'content-type': 'application/json' };
    const post = (body: unknown, headers: Record<string, string> = h) => s.app.request('/peer/launches', { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ id: 'r/1', to: 'pc-b', sealed: SEALED })).status).toBe(400);
    expect((await post({ id: 'r1', to: 'pc-c', sealed: SEALED })).status).toBe(404);
    expect((await post({ id: 'r1', to: 'pc-b', sealed: SEALED, from: 'pc-x' })).status).toBe(403);
    expect((await post({ id: 'r1', to: 'pc-b', sealed: 'not-sealed' })).status).toBe(400);
    expect((await post({ id: 'r1', to: 'pc-b', sealed: SEALED }, { ...h, 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post({ id: 'r1', to: 'pc-b', sealed: SEALED })).status).toBe(200);
    // 別の送り手が同じ ID を使うと 409。
    const other = { ...h, authorization: `Bearer ${await tokenFor('pc-c', 'pc-b')}`, [PEER_FROM_HEADER]: 'pc-c' };
    expect((await post({ id: 'r1', to: 'pc-b', sealed: SEALED }, other)).status).toBe(409);
    // 送り手の頼みでない結果は 404。
    expect((await s.app.request('/peer/launches/r1/results?after=0', { headers: other })).status).toBe(404);
  });

  it('受け口がまだ無ければ 503、同期を設定していなければ 401', async () => {
    const s = await setup({ inbox: null });
    const h = { authorization: `Bearer ${await tokenFor('pc-a', 'pc-b')}`, [PEER_FROM_HEADER]: 'pc-a' };
    expect((await s.app.request('/peer/launches/mine', { headers: h })).status).toBe(503);
    const n = await setup({ keys: null });
    expect((await n.app.request('/peer/health', { headers: h })).status).toBe(401);
  });

  it('確かめは、相手の device_id が宛先と同じときだけ ok', async () => {
    const s = await setup();
    const probe = sshPeerProbe({ selfId: 'pc-a', tokens: () => s.keys, fetch: s.fetchApp });
    expect(await probe('http://127.0.0.1:1', 'pc-b')).toBe('ok');
    // 宛先を取り違えると token が合わず refused。
    expect(await probe('http://127.0.0.1:1', 'pc-z')).toBe('refused');
    const down = sshPeerProbe({ selfId: 'pc-a', tokens: () => s.keys, fetch: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch });
    expect(await down('http://127.0.0.1:1', 'pc-b')).toBe('down');
  });
});
