import { describe, expect, it, vi } from 'vitest';
import { CANNED_INPUT } from './input.ts';
import { LmStudioSummarizer } from './lmstudio.ts';
import { SummarizerError } from './types.ts';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const models = { data: [{ id: 'gemma-4-26b' }, { id: 'qwen3-27b' }] };
const completion = (content: string | null) => ({ choices: [{ message: { role: 'assistant', content } }], usage: { completion_tokens: 10 } });
const good = JSON.stringify({ title: 'README の更新', one_liner: 'Node 22 前提に導入手順を直した', body: '本文。', state: 'done', next_steps: ['CONTRIBUTING を見直す'] });

describe('LmStudioSummarizer', () => {
  it('available はモデル一覧で判定し、summarize は json_schema 付きで投げる', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url); calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith('/v1/models')) return ok(models);
      return ok(completion(good));
    }) as unknown as typeof fetch;
    const s = new LmStudioSummarizer({ baseUrl: 'http://127.0.0.1:1234', model: 'gemma-4-26b', fetch: fetchFn });
    expect(s.id).toBe('lmstudio');
    expect(await s.available()).toBe(true);
    expect(await s.listModels()).toEqual(['gemma-4-26b', 'qwen3-27b']);
    const out = await s.summarize(CANNED_INPUT);
    expect(out).toEqual({ title: 'README の更新', oneLiner: 'Node 22 前提に導入手順を直した', body: '本文。', state: 'done', nextSteps: ['CONTRIBUTING を見直す'] });
    const req = calls.at(-1)!;
    expect(req.url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(req.body).toMatchObject({ model: 'gemma-4-26b', temperature: 0.2, response_format: { type: 'json_schema', json_schema: { name: 'session_summary', strict: true } } });
    expect((req.body as { messages: { role: string; content: string }[] }).messages[1]!.content).toBe(CANNED_INPUT.text);
    const none = new LmStudioSummarizer({ baseUrl: 'http://127.0.0.1:1234', model: 'missing', fetch: fetchFn });
    expect(await none.available()).toBe(false);
  });
  it('model が null なら一覧の先頭を使う。本文が空なら失敗。繋がらなければ available は偽', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/models')) return ok(models);
      expect(JSON.parse(String(init!.body)).model).toBe('gemma-4-26b');
      return ok(completion(''));
    }) as unknown as typeof fetch;
    const s = new LmStudioSummarizer({ baseUrl: 'http://127.0.0.1:1234/', model: null, fetch: fetchFn });
    expect(await s.available()).toBe(true);
    await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(SummarizerError);
    await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(/空/);
    const down = new LmStudioSummarizer({ baseUrl: 'http://127.0.0.1:1', model: null, fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    expect(await down.available()).toBe(false);
    expect(await down.listModels()).toEqual([]);
  });
  it('JSON でない本文とスキーマ外の本文は失敗', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => (String(url).endsWith('/v1/models') ? ok(models) : ok(completion('not json')))) as unknown as typeof fetch;
    const s = new LmStudioSummarizer({ baseUrl: 'http://x', model: 'gemma-4-26b', fetch: fetchFn });
    await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(/JSON/);
    const f2 = vi.fn(async () => ok(completion(JSON.stringify({ title: 'x' })))) as unknown as typeof fetch;
    await expect(new LmStudioSummarizer({ baseUrl: 'http://x', model: 'm', fetch: f2 }).summarize(CANNED_INPUT)).rejects.toThrow(/形/);
    const f3 = vi.fn(async () => ok({ error: 'boom' }, 500)) as unknown as typeof fetch;
    await expect(new LmStudioSummarizer({ baseUrl: 'http://x', model: 'm', fetch: f3 }).summarize(CANNED_INPUT)).rejects.toThrow(/500/);
  });
});
