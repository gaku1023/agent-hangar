import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { CANNED_INPUT } from './input.ts';
import { LmStudioSummarizer } from './lmstudio.ts';
import { SummarizerError } from './types.ts';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const models = { data: [{ id: 'gemma-4-26b' }, { id: 'qwen3-27b' }] };
const completion = (content: string | null, model = 'gemma-4-26b') => ({ model, choices: [{ message: { role: 'assistant', content } }], usage: { completion_tokens: 10 } });
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
    expect(out).toEqual({ title: 'README の更新', oneLiner: 'Node 22 前提に導入手順を直した', body: '本文。', state: 'done', nextSteps: ['CONTRIBUTING を見直す'], model: 'gemma-4-26b' });
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
  it('使ったモデルの名前を返す。応答が名乗らなければ投げたモデル名を使う', async () => {
    const withModel = vi.fn(async (url: RequestInfo | URL) => (String(url).endsWith('/v1/models') ? ok(models) : ok(completion(good, 'qwen3-27b')))) as unknown as typeof fetch;
    // model が null でも、実際に選ばれたモデルの名前が入る。
    expect((await new LmStudioSummarizer({ baseUrl: 'http://x', model: null, fetch: withModel }).summarize(CANNED_INPUT)).model).toBe('qwen3-27b');
    const noModel = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/v1/models')) return ok(models);
      return ok({ choices: [{ message: { content: good } }] });
    }) as unknown as typeof fetch;
    expect((await new LmStudioSummarizer({ baseUrl: 'http://x', model: 'gemma-4-26b', fetch: noModel }).summarize(CANNED_INPUT)).model).toBe('gemma-4-26b');
    expect((await new LmStudioSummarizer({ baseUrl: 'http://x', model: null, fetch: noModel }).summarize(CANNED_INPUT)).model).toBe('gemma-4-26b');
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
  it('リダイレクトを追わない。3xx は失敗として扱う', async () => {
    const seen: (string | undefined)[] = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.redirect);
      if (String(url).endsWith('/v1/models')) return ok(models);
      return new Response(null, { status: 307, headers: { location: 'http://moved.example/collect' } });
    }) as unknown as typeof fetch;
    const s = new LmStudioSummarizer({ baseUrl: 'http://127.0.0.1:1234', model: 'gemma-4-26b', fetch: fetchFn });
    await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(SummarizerError);
    await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(/リダイレクト/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r === 'manual')).toBe(true);
  });
  it('実測。307 を返す宛先へ投げても、飛ばし先には本文が届かない', async () => {
    // 手元だけで閉じた再現。A も B も 127.0.0.1 に立て、外へは 1 バイトも出さない。
    const got: { path: string; body: string }[] = [];
    const b = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { got.push({ path: req.url ?? '', body }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    });
    await new Promise<void>((r) => b.listen(0, '127.0.0.1', r));
    const bPort = (b.address() as { port: number }).port;
    const a = http.createServer((req, res) => {
      if ((req.url ?? '').endsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(models)); return; }
      res.writeHead(307, { location: `http://127.0.0.1:${bPort}/collect` });
      res.end();
    });
    await new Promise<void>((r) => a.listen(0, '127.0.0.1', r));
    const aPort = (a.address() as { port: number }).port;
    try {
      const s = new LmStudioSummarizer({ baseUrl: `http://127.0.0.1:${aPort}`, model: 'gemma-4-26b', timeoutMs: 5000 });
      await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(/リダイレクト/);
      expect(got).toEqual([]);
    } finally {
      await new Promise<void>((r) => a.close(() => r()));
      await new Promise<void>((r) => b.close(() => r()));
    }
  });
});
