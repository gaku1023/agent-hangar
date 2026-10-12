import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OsNoticeFeed } from '../../sessions/stopNotices.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// デスクトップ通知の並び（routes/notify.ts）。殻が長いポーリングで読む。

let t: TestWorld;
let feed: OsNoticeFeed;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  t = await testDeps();
  feed = new OsNoticeFeed();
  app = createApp({ ...t.deps, osNotices: feed });
});
afterEach(() => { t.dispose(); });

describe('GET /api/notify/feed', () => {
  it('初めは今の番号だけを返し、続きは番号の後から返す', async () => {
    const first = await (await app.request('/api/notify/feed', { headers: H })).json();
    expect(first).toEqual({ boot: feed.boot, seq: 0, items: [] });
    feed.push({ kind: 'waiting', sessionId: 's1', title: '名前', body: '向きは？', bare: false });
    const next = await (await app.request(`/api/notify/feed?after=0&boot=${feed.boot}&wait=0`, { headers: H })).json();
    expect(next.items).toEqual([{ seq: 1, kind: 'waiting', sessionId: 's1', title: '名前', body: '向きは？', bare: false }]);
  });

  it('続きが無ければ、届くまで待って返す', async () => {
    const pending = app.request(`/api/notify/feed?after=0&boot=${feed.boot}&wait=5`, { headers: H });
    setTimeout(() => feed.push({ kind: 'limit', sessionId: 's1', title: 't', body: 'b', bare: false }), 20);
    expect((await (await pending).json()).items).toHaveLength(1);
  });

  it('閉じたら待っている読み手をすぐ返す', async () => {
    const pending = app.request(`/api/notify/feed?after=0&boot=${feed.boot}&wait=25`, { headers: H });
    setTimeout(() => feed.close(), 20);
    const t0 = Date.now();
    expect((await (await pending).json()).items).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('鍵が無ければ断る', async () => {
    expect((await app.request('/api/notify/feed')).status).toBe(401);
  });

  it('並びを持たないサーバは 404', async () => {
    const plain = createApp(t.deps);
    expect((await plain.request('/api/notify/feed', { headers: H })).status).toBe(404);
  });
});
