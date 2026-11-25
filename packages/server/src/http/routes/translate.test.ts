import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 英語の返答の翻訳の口（POST /api/translate）の試験。

let t: TestWorld;
const post = (app: ReturnType<typeof createApp>, body: unknown) => app.request('/api/translate', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => { t = await testDeps(); });
afterEach(() => { t.dispose(); });

describe('POST /api/translate', () => {
  it('翻訳が組まれていなければ unavailable', async () => {
    const r = await post(createApp(t.deps), { text: 'Hello world' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'unavailable' });
  });

  it('文をサービスへ渡し、その答えを返す', async () => {
    const translate = vi.fn(async (text: string) => ({ status: 'ok' as const, text: `訳:${text}` }));
    const r = await post(createApp({ ...t.deps, translate: { translate } }), { text: 'Hello world' });
    expect(await r.json()).toEqual({ status: 'ok', text: '訳:Hello world' });
    expect(translate).toHaveBeenCalledWith('Hello world');
  });

  it('text が文字でなければ 400', async () => {
    const r = await post(createApp({ ...t.deps, translate: { translate: vi.fn() } }), { text: 3 });
    expect(r.status).toBe(400);
  });
});
