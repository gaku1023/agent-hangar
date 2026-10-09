import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agent-hangar/shared';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// メモの経路（routes/memos.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let sent: ServerEvent[];
/** ワークスペースから登録される唯一のプロジェクト alpha の id。 */
let list0ProjectId: () => string;

beforeEach(async () => {
  t = await testDeps();
  sent = t.events; list0ProjectId = t.alphaProjectId;
  app = createApp(t.deps);
});
afterEach(() => { t.dispose(); });

// 経路は行を書くだけで、画面へのイベントは配る層（events/publisher.ts）が組む。
// 書いた行のイベントが、1 回だけ、最新の中身で届くことを経路ごとに押さえる。
describe('書いた行のイベントは配る層から届く', () => {
  const send = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  describe('TODO、メモ、アーティファクト', () => {
    it('メモを書くと、memo.update と、メモの頭を載せた project.upsert が 1 回ずつ届く', async () => {
      const pid = list0ProjectId();
      await send(`/api/projects/${pid}/memo`, { markdown: '# 見出し\n本文' }, 'PUT');
      expect(sent).toEqual([
        { type: 'memo.update', memo: expect.objectContaining({ projectId: pid, markdown: '# 見出し\n本文' }) },
        { type: 'project.upsert', project: expect.objectContaining({ id: pid, memoHead: '# 見出し' }) },
      ]);
    });
  });
});
