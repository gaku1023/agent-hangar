import { aadAsk, aadReply, COMPAT_HEADER, open, seal, type MobileAsk, type MobileReply } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askPc, AskError, ASK_DEBOUNCE_MS, createAsker, debounce, FILES_CACHE_MS, type AskFailure } from './ask.ts';
import { makeKey } from './test/fixtures.ts';
import { json, WORKER } from './test/pairText.ts';

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
let key: CryptoKey;
let fetchMock: ReturnType<typeof vi.fn>;
let asks: { url: string; init: RequestInit; body: { id: string; targetDevice: string; sealed: string } }[];

beforeEach(async () => {
  key = await makeKey();
  asks = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** POST /m/ask を受け、中身を開いて reply を封じて返す。reply が関数なら、開いた問い合わせから答えを作る。 */
function serve(reply: MobileReply | ((a: MobileAsk) => MobileReply) | { http: number; body: unknown; text?: boolean }): void {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { id: string; targetDevice: string; sealed: string };
    asks.push({ url, init, body });
    if ('http' in reply) return reply.text ? new Response(String(reply.body), { status: reply.http }) : json(reply.body, reply.http);
    const a = await open<MobileAsk>(key, aadAsk(body.id, body.targetDevice), body.sealed);
    const r = typeof reply === 'function' ? reply(a) : reply;
    return json({ sealed: await seal(key, aadReply(body.id), r) });
  });
}

async function failureOf(p: Promise<unknown>): Promise<AskFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AskError);
    return (e as AskError).reason;
  }
  throw new Error('失敗しなかった');
}

describe('askPc', () => {
  it('問い合わせを aadAsk(id, 宛先) で封じて POST /m/ask に送り、答えを aadReply(id) で開く', async () => {
    serve({ files: [{ path: 'src/a.ts', changed: true }] });
    const r = await askPc(pairing, key, 'pc-1', { kind: 'files', projectId: 'p-a', q: 'a' });
    expect(r).toEqual({ files: [{ path: 'src/a.ts', changed: true }] });
    expect(asks).toHaveLength(1);
    const { url, init, body } = asks[0]!;
    expect(url).toBe(`${WORKER}/m/ask`);
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok-1');
    expect(h[COMPAT_HEADER]).toBeTruthy();
    expect(body.targetDevice).toBe('pc-1');
    // 封の中身は平文で運ばない。
    expect(JSON.stringify(body)).not.toContain('p-a');
    expect(await open<MobileAsk>(key, aadAsk(body.id, 'pc-1'), body.sealed)).toEqual({ v: 1, kind: 'files', projectId: 'p-a', q: 'a' });
  });

  it('503 は pc-offline、504 は pc-timeout', async () => {
    serve({ http: 503, body: { error: 'pc-offline' } });
    expect(await failureOf(askPc(pairing, key, 'pc-1', { kind: 'commands', projectId: null, accountId: 'acc-1' }))).toBe('pc-offline');
    serve({ http: 504, body: { error: 'pc-timeout' } });
    expect(await failureOf(askPc(pairing, key, 'pc-1', { kind: 'commands', projectId: null, accountId: 'acc-1' }))).toBe('pc-timeout');
  });

  it('開けない答え、別の id の封、形の違う答えは unreadable', async () => {
    fetchMock.mockImplementation(async () => json({ sealed: await seal(key, aadReply('other'), { files: [] }) }));
    expect(await failureOf(askPc(pairing, key, 'pc-1', { kind: 'files', projectId: 'p-a', q: '' }))).toBe('unreadable');
    serve({ nope: 1 } as unknown as MobileReply);
    expect(await failureOf(askPc(pairing, key, 'pc-1', { kind: 'files', projectId: 'p-a', q: '' }))).toBe('unreadable');
    fetchMock.mockImplementation(async () => json({ nothing: true }));
    expect(await failureOf(askPc(pairing, key, 'pc-1', { kind: 'files', projectId: 'p-a', q: '' }))).toBe('unreadable');
  });

  it('PC の断りは理由ごとに分ける', async () => {
    serve({ error: 'project-missing' });
    expect(await failureOf(askPc(pairing, key, 'pc-1', { kind: 'files', projectId: 'p-a', q: '' }))).toBe('project-missing');
    serve({ error: 'account-missing' });
    expect(await failureOf(askPc(pairing, key, 'pc-1', { kind: 'commands', projectId: 'p-a', accountId: 'x' }))).toBe('account-missing');
  });

  it('Worker の断りを分ける（宛先なしの 404 と、口の無い古い Worker の 404 も分ける）', async () => {
    const q = () => askPc(pairing, key, 'pc-1', { kind: 'files', projectId: 'p-a', q: '' });
    serve({ http: 404, body: { error: 'not found' } });
    expect(await failureOf(q())).toBe('not-found');
    serve({ http: 404, body: '404 Not Found', text: true });
    expect(await failureOf(q())).toBe('unsupported');
    serve({ http: 429, body: { error: 'too many asks' } });
    expect(await failureOf(q())).toBe('rate-limited');
    serve({ http: 401, body: { error: 'unauthorized' } });
    expect(await failureOf(q())).toBe('unpaired');
    serve({ http: 502, body: { error: 'reply too large' } });
    expect(await failureOf(q())).toBe('server');
    fetchMock.mockRejectedValue(new TypeError('offline'));
    expect(await failureOf(q())).toBe('network');
  });

  it('答えの中の形の違う行は落とし、説明は切らずに文字列だけ通す', async () => {
    serve({
      commands: [
        { name: 'review', description: 'レビュー', kind: 'skill' },
        { name: 3, description: 'x', kind: 'skill' },
        { name: 'compact', description: '要約', kind: 'command' },
        { name: 'bad', description: 'x', kind: 'other' },
      ],
    } as unknown as MobileReply);
    const r = await askPc(pairing, key, 'pc-1', { kind: 'commands', projectId: null, accountId: 'acc-1' });
    expect(r).toEqual({
      commands: [
        { name: 'review', description: 'レビュー', kind: 'skill' },
        { name: 'compact', description: '要約', kind: 'command' },
      ],
    });
  });
});

describe('createAsker', () => {
  const cmds: MobileReply = { commands: [{ name: 'review', description: 'レビュー', kind: 'skill' }] };

  it('同じ PC、プロジェクト、アカウントの commands は 1 回だけ問い合わせる', async () => {
    serve(cmds);
    const a = createAsker(pairing, key);
    expect(await a.commands('pc-1', 'p-a', 'acc-1')).toEqual([{ name: 'review', description: 'レビュー', kind: 'skill' }]);
    await a.commands('pc-1', 'p-a', 'acc-1');
    expect(asks).toHaveLength(1);
    await a.commands('pc-1', 'p-a', 'acc-2');
    await a.commands('pc-2', 'p-a', 'acc-1');
    await a.commands('pc-1', null, 'acc-1');
    expect(asks).toHaveLength(4);
  });

  it('失敗した commands は覚えず、次で問い合わせ直す', async () => {
    serve({ http: 503, body: { error: 'pc-offline' } });
    const a = createAsker(pairing, key);
    await expect(a.commands('pc-1', 'p-a', 'acc-1')).rejects.toBeInstanceOf(AskError);
    serve(cmds);
    expect(await a.commands('pc-1', 'p-a', 'acc-1')).toHaveLength(1);
    expect(asks).toHaveLength(2);
  });

  it('files は同じ q を 30 秒覚える', async () => {
    let t = 1_000_000;
    serve((q) => ({ files: [{ path: `${q.kind === 'files' ? q.q : ''}.ts`, changed: false }] }));
    const a = createAsker(pairing, key, { now: () => t });
    expect(await a.files('pc-1', 'p-a', 'ap')).toEqual([{ path: 'ap.ts', changed: false }]);
    t += FILES_CACHE_MS - 1;
    await a.files('pc-1', 'p-a', 'ap');
    expect(asks).toHaveLength(1);
    await a.files('pc-1', 'p-a', 'app');
    await a.files('pc-2', 'p-a', 'ap');
    expect(asks).toHaveLength(3);
    t += 2;
    await a.files('pc-1', 'p-a', 'ap');
    expect(asks).toHaveLength(4);
  });
});

describe('debounce', () => {
  it('打つたびの問い合わせは 250 ms 待ち、最後の 1 つだけを出す', () => {
    vi.useFakeTimers();
    expect(ASK_DEBOUNCE_MS).toBe(250);
    const d = debounce();
    const seen: string[] = [];
    d.run(() => seen.push('a'));
    vi.advanceTimersByTime(100);
    d.run(() => seen.push('ap'));
    vi.advanceTimersByTime(249);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(['ap']);
    d.run(() => seen.push('app'));
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(seen).toEqual(['ap']);
  });
});
