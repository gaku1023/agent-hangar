import { describe, expect, it } from 'vitest';
import { LocalModelListing } from './available.ts';

const LM = 'http://127.0.0.1:1234/v1';

/** LM Studio か、OpenAI 互換のサーバーの偽物。呼ばれた道を calls に残す。down は、つながらないこと。 */
function fakeServer(o: { native?: unknown; openai?: unknown; down?: boolean }) {
  const calls: string[] = [];
  const f = (async (url: string | URL) => {
    const u = new URL(String(url));
    calls.push(`${u.host}${u.pathname}`);
    if (o.down) throw new TypeError('fetch failed');
    if (u.pathname === '/api/v1/models' && o.native !== undefined) return Response.json(o.native);
    if (u.pathname === '/v1/models' && o.openai !== undefined) return Response.json(o.openai);
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

const lmStudio = { models: [{ type: 'llm', key: 'gemma' }, { type: 'vlm', key: 'qwen3.8-27b-mlx' }, { type: 'embedding', key: 'nomic-embed' }] };

describe('LocalModelListing', () => {
  it('LM Studio の一覧から、ダウンロード済みのモデルを読む（埋め込みのモデルは外す）', async () => {
    const { f, calls } = fakeServer({ native: lmStudio });
    expect(await new LocalModelListing({ fetch: f }).list(LM)).toEqual({ kind: 'listed', models: ['gemma', 'qwen3.8-27b-mlx'] });
    expect(calls).toEqual(['127.0.0.1:1234/api/v1/models']);
  });

  it('LM Studio の口が無ければ、OpenAI 互換の {baseURL}/models を読む', async () => {
    const { f, calls } = fakeServer({ openai: { data: [{ id: 'llama3' }, { id: 'qwen3' }] } });
    expect(await new LocalModelListing({ fetch: f }).list('http://localhost:11434/v1/')).toEqual({ kind: 'listed', models: ['llama3', 'qwen3'] });
    expect(calls).toEqual(['localhost:11434/api/v1/models', 'localhost:11434/v1/models']);
  });

  it('つながらなければ unreachable', async () => {
    const { f } = fakeServer({ down: true });
    expect(await new LocalModelListing({ fetch: f }).list(LM)).toEqual({ kind: 'unreachable', origin: 'http://127.0.0.1:1234' });
  });

  it('答えはあるが一覧の形でなければ unknown（確かめられないので止めない）', async () => {
    const { f } = fakeServer({});
    expect(await new LocalModelListing({ fetch: f }).list(LM)).toEqual({ kind: 'unknown' });
  });

  it('この PC でない宛先は聞かずに unknown', async () => {
    const { f, calls } = fakeServer({ native: lmStudio });
    const l = new LocalModelListing({ fetch: f });
    expect(await l.list('https://api.example.com/v1')).toEqual({ kind: 'unknown' });
    expect(await l.list('http://192.168.1.20:1234/v1')).toEqual({ kind: 'unknown' });
    expect(await l.list(null)).toEqual({ kind: 'unknown' });
    expect(calls).toEqual([]);
  });

  it('取れた一覧は間をおかずに使い回し、間が過ぎるか fresh なら取り直す。つながらない答えは覚えない', async () => {
    let now = 0;
    const { f, calls } = fakeServer({ native: lmStudio });
    const l = new LocalModelListing({ fetch: f, now: () => now, ttlMs: 30_000 });
    await l.list(LM);
    now = 29_000;
    await l.list(LM);
    expect(calls).toHaveLength(1);
    await l.list(LM, { fresh: true });
    expect(calls).toHaveLength(2);
    now = 70_000;
    await l.list(LM);
    expect(calls).toHaveLength(3);

    const down = fakeServer({ down: true });
    const d = new LocalModelListing({ fetch: down.f, now: () => now });
    await d.list(LM);
    await d.list(LM);
    expect(down.calls).toHaveLength(4);
  });
});
