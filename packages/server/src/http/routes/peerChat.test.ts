import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PeerChatOpIn, PeerChatOpResult, PeerChatViewDto } from '@agent-hangar/shared';
import { issueMcpSecret } from '../../runs/secrets.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 見る側の PC の入口（routes/peerChat.ts）。中身の流れは peer/chat/viewer.test.ts で試している。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let opened: { id: string; viewer: string; after: string | null | undefined }[];
let ops: { id: string; op: PeerChatOpIn }[];
let viewDto: PeerChatViewDto;
let opResult: PeerChatOpResult;

const json = { ...H, 'content-type': 'application/json' };
const get = (q: string, headers: Record<string, string> = H) => app.request(`/api/sessions/s1/peer-chat${q}`, { headers });
const post = (b: unknown, headers: Record<string, string> = json) => app.request('/api/sessions/s1/peer-chat/ops', { method: 'POST', headers, body: JSON.stringify(b) });

beforeEach(async () => {
  t = await testDeps();
  opened = [];
  ops = [];
  viewDto = { ok: true, device: { deviceId: 'pc-b', deviceName: 'Mac' }, startedAfter: null, update: { sessionId: 's1', link: 'online', replace: false, status: 'idle', items: [], queued: [], cursor: null } };
  opResult = { ok: true, queueId: 'q1' };
  t.deps.peerChat = {
    open: async (id, o) => { opened.push({ id, viewer: o.viewer, after: o.after }); return viewDto; },
    op: async (id, op) => { ops.push({ id, op }); return opResult; },
  };
  app = createApp(t.deps);
});
afterEach(() => { t.dispose(); });

describe('GET /api/sessions/:id/peer-chat', () => {
  it('見張りを始めて、いまの状態を返す。after を省くと undefined（手元の写しの続き）、空なら null（頭から）で渡す', async () => {
    const r = await get('?viewer=tab-1');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(viewDto);
    await get('?viewer=tab-1&after=u9');
    await get('?viewer=tab-1&after=');
    expect(opened).toEqual([
      { id: 's1', viewer: 'tab-1', after: undefined },
      { id: 's1', viewer: 'tab-1', after: 'u9' },
      { id: 's1', viewer: 'tab-1', after: null },
    ]);
  });

  it('断りも 200 で返し、画面が読み取り専用に落とせるようにする', async () => {
    viewDto = { ok: false, reason: 'device-outdated', device: { deviceId: 'pc-b', deviceName: 'Mac' } };
    const r = await get('?viewer=tab-1');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(viewDto);
  });

  it('viewer が無い、形が違う、after が長すぎるのは 400', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get('?viewer=a%20b')).status).toBe(400);
    expect((await get(`?viewer=v&after=${'x'.repeat(300)}`)).status).toBe(400);
    expect(opened).toEqual([]);
  });

  it('認証が要る。MCP の秘密では呼べない', async () => {
    expect((await get('?viewer=v', {})).status).toBe(401);
    const secret = issueMcpSecret(t.db, 's1', 1);
    expect((await get('?viewer=v', { authorization: `Bearer ${secret}` })).status).toBe(401);
  });
});

describe('POST /api/sessions/:id/peer-chat/ops', () => {
  it('op を渡して、答えをそのまま返す', async () => {
    const r = await post({ t: 'send', text: 'こんにちは', images: ['a.png'] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, queueId: 'q1' });
    expect(ops).toEqual([{ id: 's1', op: { t: 'send', text: 'こんにちは', images: ['a.png'] } }]);
  });

  it('失敗の理由も 200 で返す（画面が入力欄に文を戻す）', async () => {
    opResult = { ok: false, reason: 'offline' };
    expect(await (await post({ t: 'send', text: 'x' })).json()).toEqual({ ok: false, reason: 'offline' });
  });

  it('answer、interrupt、cancel、files、resume-send を受ける。tail と知らない op は 400', async () => {
    for (const op of [{ t: 'answer', askId: 'A', keys: ['1'], text: 'x' }, { t: 'interrupt' }, { t: 'cancel', queueId: 'q' }, { t: 'files', query: 'a' }, { t: 'resume-send', text: 'go' }]) {
      expect((await post(op)).status).toBe(200);
    }
    expect(ops).toHaveLength(5);
    expect((await post({ t: 'tail', after: null, waitMs: 0 })).status).toBe(400);
    expect((await post({ t: 'nope' })).status).toBe(400);
    expect((await post({ t: 'send' })).status).toBe(400);
    expect((await post({ t: 'send', text: 'x', images: [1] })).status).toBe(400);
    expect((await post({ t: 'answer', askId: 'A', keys: 'x' })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect(ops).toHaveLength(5);
  });

  it('大きすぎる本文は 413', async () => {
    const r = await app.request('/api/sessions/s1/peer-chat/ops', { method: 'POST', headers: json, body: JSON.stringify({ t: 'send', text: 'x'.repeat(200 * 1024) }) });
    expect(r.status).toBe(413);
  });

  it('認証が要る', async () => {
    expect((await post({ t: 'interrupt' }, { 'content-type': 'application/json' })).status).toBe(401);
  });
});

describe('見る側の部品を持たない組み立て', () => {
  it('どちらの経路も出さない', async () => {
    delete t.deps.peerChat;
    const bare = createApp(t.deps);
    expect((await bare.request('/api/sessions/s1/peer-chat?viewer=v', { headers: H })).status).toBe(404);
    expect((await bare.request('/api/sessions/s1/peer-chat/ops', { method: 'POST', headers: json, body: '{"t":"interrupt"}' })).status).toBe(404);
  });
});
