import { aadPhoneChat, aadPhoneChatReply, COMPAT_HEADER, open, parsePeerChatRequest, seal, type PeerChatReply } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChatState, chatCall, ChatError, emptyChat, type ChatFailure } from './chat.ts';
import { at1, makeKey } from './test/fixtures.ts';
import { json, WORKER } from './test/pairText.ts';

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
let key: CryptoKey;
let fetchMock: ReturnType<typeof vi.fn>;
let sent: { url: string; init: RequestInit; body: { askId: string; to: string; sealed: string; epoch: number; waitMs: number } }[];

beforeEach(async () => {
  key = await makeKey();
  sent = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function serve(reply: PeerChatReply | { http: number; body: unknown; compat?: number }): void {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as (typeof sent)[number]['body'];
    sent.push({ url, init, body });
    if ('http' in reply) {
      const res = json(reply.body, reply.http);
      if (reply.compat !== undefined) res.headers.set(COMPAT_HEADER, String(reply.compat));
      return res;
    }
    return json({ sealed: await seal(key, aadPhoneChatReply(body.askId), reply) });
  });
}

async function failureOf(p: Promise<unknown>): Promise<ChatFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ChatError);
    return (e as ChatError).failure;
  }
  throw new Error('失敗しなかった');
}

describe('chatCall', () => {
  it('頼みを aadPhoneChat(askId, 宛先) で封じて POST /m/chat に送り、答えを aadPhoneChatReply(askId) で開く', async () => {
    serve({ ok: true, queueId: 'q-1' });
    const r = await chatCall(pairing, at1(key, 3), 'pc-1', { t: 'send', text: 'こんにちは', images: [], waitMs: 10_000 }, { sessionId: 's-1', now: () => 1_000_000 });
    expect(r).toEqual({ ok: true, queueId: 'q-1' });
    const { url, init, body } = sent[0]!;
    expect(url).toBe(`${WORKER}/m/chat`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    expect(body.to).toBe('pc-1');
    expect(body.epoch).toBe(3);
    expect(body.waitMs).toBe(10_000);
    const req = parsePeerChatRequest(await open<unknown>(key, aadPhoneChat(body.askId, 'pc-1'), body.sealed));
    expect(req).toMatchObject({ v: 1, askId: body.askId, sessionId: 's-1', op: { t: 'send', text: 'こんにちは', images: [] } });
    expect(req!.expiresAt).toBe(1_000_000 + 60_000);
  });

  it('会話の ID を頼みに入れ、tail の待ちを waitMs に写す', async () => {
    serve({ ok: true });
    await chatCall(pairing, at1(key), 'pc-1', { t: 'tail', after: null, waitMs: 20_000 }, { sessionId: 's-1' });
    expect(sent[0]!.body.waitMs).toBe(20_000);
    const req = parsePeerChatRequest(await open<unknown>(key, aadPhoneChat(sent[0]!.body.askId, 'pc-1'), sent[0]!.body.sealed));
    expect(req!.sessionId).toBe('s-1');
  });

  it('PC の断りは ok: false のまま返す', async () => {
    serve({ ok: false, reason: 'refused-by-setting' });
    await expect(chatCall(pairing, at1(key), 'pc-1', { t: 'interrupt' }, { sessionId: 's-1' })).resolves.toEqual({ ok: false, reason: 'refused-by-setting' });
  });

  it.each<[number, ChatFailure]>([
    [401, 'unpaired'],
    [404, 'not-found'],
    [409, 'pc-offline'],
    [413, 'too-large'],
    [429, 'rate-limited'],
    [502, 'too-large'],
    [503, 'pc-offline'],
    [504, 'pc-timeout'],
    [500, 'server'],
  ])('HTTP %i は %s', async (status, failure) => {
    serve({ http: status, body: { error: 'x' }, compat: 13 });
    expect(await failureOf(chatCall(pairing, at1(key), 'pc-1', { t: 'interrupt' }, { sessionId: 's-1' }))).toBe(failure);
  });

  it('口の無い古い Worker（版 12 以下）は unsupported', async () => {
    serve({ http: 404, body: { error: 'not found' }, compat: 12 });
    expect(await failureOf(chatCall(pairing, at1(key), 'pc-1', { t: 'interrupt' }, { sessionId: 's-1' }))).toBe('unsupported');
  });

  it('通信の失敗は network、開けない答えは unreadable', async () => {
    fetchMock.mockRejectedValue(new TypeError('x'));
    expect(await failureOf(chatCall(pairing, at1(key), 'pc-1', { t: 'interrupt' }, { sessionId: 's-1' }))).toBe('network');
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ sealed: await seal(key, 'other', { ok: true }) }));
    expect(await failureOf(chatCall(pairing, at1(key), 'pc-1', { t: 'interrupt' }, { sessionId: 's-1' }))).toBe('unreadable');
  });
});

describe('applyChatState', () => {
  const user = (uuid: string, text: string) => ({ uuid, at: 1, kind: 'user' as const, text });
  const as = (uuid: string, text: string) => ({ uuid, at: 2, kind: 'assistant' as const, text });

  it('新しい項目を足し、同じ uuid は置き換え、cursor と状態を取る', () => {
    let s = applyChatState(emptyChat(), { sessionId: 's', status: 'busy', items: [user('a', '1'), as('b', '2')], queued: [], cursor: 'b', truncated: false });
    expect(s.items.map((i) => i.uuid)).toEqual(['a', 'b']);
    s = applyChatState(s, { sessionId: 's', status: 'idle', items: [as('b', '2 改'), as('c', '3')], queued: [], cursor: 'c', truncated: false });
    expect(s.items.map((i) => i.text)).toEqual(['1', '2 改', '3']);
    expect(s.cursor).toBe('c');
    expect(s.status).toBe('idle');
  });

  it('truncated なら手元を捨てて差し替える', () => {
    let s = applyChatState(emptyChat(), { sessionId: 's', status: 'busy', items: [user('a', '1')], queued: [], cursor: 'a', truncated: false });
    s = applyChatState(s, { sessionId: 's', status: 'busy', items: [as('z', 'new')], queued: [], cursor: 'z', truncated: true });
    expect(s.items.map((i) => i.uuid)).toEqual(['z']);
  });

  it('札は askId が同じなら置き換え、答えが付いたら answered を持つ', () => {
    const ask = (uuid: string, answered?: boolean) => ({ uuid, at: 3, kind: 'permission' as const, text: '', ask: { askId: 'k1', kind: 'permission' as const, options: [{ key: '1', label: 'はい' }], multi: false, allowText: false, ...(answered ? { answered: { by: { deviceId: 'd', deviceName: 'Mac' }, label: 'はい', at: 5 } } : {}) } });
    let s = applyChatState(emptyChat(), { sessionId: 's', status: 'waiting', items: [as('b', 'x'), ask('b@ask:k1')], queued: [], cursor: 'b', truncated: false });
    s = applyChatState(s, { sessionId: 's', status: 'busy', items: [ask('b@ask:k1', true)], queued: [], cursor: 'b', truncated: false });
    expect(s.items).toHaveLength(2);
    expect(s.items[1]!.ask!.answered?.label).toBe('はい');
  });
});
