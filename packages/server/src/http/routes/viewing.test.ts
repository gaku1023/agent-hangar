import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isViewing, resetViewing, VIEWING_TTL_MS } from '../../live/viewing.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 画面がいま前に出して見ている会話を送る経路（POST /api/viewing）の試験。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
const post = (body: unknown) => app.request('/api/viewing', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => { resetViewing(); t = await testDeps(); app = createApp(t.deps); });
afterEach(() => { t.dispose(); resetViewing(); });

describe('POST /api/viewing', () => {
  it('画面ごとに見ている会話を置き、null で外す。送り直しが途切れたら見ていないとみなす', async () => {
    expect((await post({ client: 'a', sessionId: 's1' })).status).toBe(204);
    expect((await post({ client: 'b', sessionId: 's2' })).status).toBe(204);
    expect(isViewing('s1')).toBe(true);
    expect(isViewing('s2')).toBe(true);
    expect((await post({ client: 'a', sessionId: null })).status).toBe(204);
    expect(isViewing('s1')).toBe(false);
    expect(isViewing('s2', Date.now() + VIEWING_TTL_MS + 1)).toBe(false);
  });
  it('形の違う本文は 400 で、何も置かない', async () => {
    for (const b of [{}, { client: '', sessionId: 's1' }, { client: 'a', sessionId: 3 }, { client: 'x'.repeat(200), sessionId: 's1' }]) {
      expect((await post(b)).status).toBe(400);
    }
    expect(isViewing('s1')).toBe(false);
  });
});
