import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { createApp, type ExternalApi } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// アーティファクトの経路（routes/artifacts.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let db: Db;
let sent: ServerEvent[];
let external: ExternalApi;
/** ワークスペースから登録される唯一のプロジェクト alpha の id。 */
let list0ProjectId: () => string;
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  t = await testDeps();
  ({ db, external } = t);
  sent = t.events; list0ProjectId = t.alphaProjectId;
  app = createApp(t.deps);
});
afterEach(() => { t.dispose(); });

describe('routes', () => {
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  it('アーティファクト', async () => {
    const pid = list0ProjectId();
    const a = await post(`/api/projects/${pid}/artifacts`, { url: 'https://claude.ai/code/artifact/manual' });
    expect(a.status).toBe(201);
    const art = await a.json();
    expect(sent.at(-1)).toMatchObject({ type: 'artifact.upsert', artifact: { id: art.id } });
    expect((await post(`/api/projects/${pid}/artifacts`, { url: 'https://example.com' })).status).toBe(400);
    expect((await json(await get(`/api/artifacts?projectId=${pid}`))).body).toHaveLength(1);
    expect((await post(`/api/artifacts/${art.id}/open`)).status).toBe(204);
    expect(external.openUrl).toHaveBeenCalledWith('https://claude.ai/code/artifact/manual');
    expect((await post(`/api/artifacts/${art.id}/open-editor`)).status).toBe(404);
    expect((await post('/api/artifacts/nope/open')).status).toBe(404);
    // 入力の誤りは 400 のまま、DB の失敗は 500 にする。
    const bad = await post(`/api/projects/${pid}/artifacts`, { url: 'https://example.com' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/claude\.ai/);
    db.exec('drop table artifacts');
    const broken = await post(`/api/projects/${pid}/artifacts`, { url: 'https://claude.ai/code/artifact/manual-2' });
    expect(broken.status).toBe(500);
    expect((await broken.json()).error).toMatch(/追加できませんでした/);
  });
});

// 経路は行を書くだけで、画面へのイベントは配る層（events/publisher.ts）が組む。
// 書いた行のイベントが、1 回だけ、最新の中身で届くことを経路ごとに押さえる。
describe('書いた行のイベントは配る層から届く', () => {
  const send = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  describe('TODO、メモ、アーティファクト', () => {
    it('URL を足すと artifact.upsert が 1 回だけ届く。同じ URL をもう一度足しても、行が変わらないので届かない', async () => {
      const pid = list0ProjectId();
      const url = 'https://claude.ai/code/artifact/abc123';
      const a = await (await send(`/api/projects/${pid}/artifacts`, { url })).json();
      expect(sent).toEqual([{ type: 'artifact.upsert', artifact: a }]);
      sent.length = 0;
      const again = await send(`/api/projects/${pid}/artifacts`, { url });
      expect(again.status).toBe(201);
      expect((await again.json()).id).toBe(a.id);
      expect(sent).toEqual([]);
    });
  });
});
