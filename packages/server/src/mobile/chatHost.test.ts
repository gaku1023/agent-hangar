import { describe, expect, it } from 'vitest';
import { aadAsk, aadPhoneChat, aadPhoneChatReply, open, PEER_CHAT_REPLY_SEALED_MAX, peerChatExpiresAt, seal, type PeerChatReply, type PeerChatRequest } from '@agent-hangar/shared';
import { fixedPhoneKeys, PHONE_KEY_1, PHONE_KEY_2, phoneCryptoKey } from '../../test/phoneKeys.ts';
import type { PeerChatSender } from '../peer/chat/hostTypes.ts';
import { createPhoneChatEntry, type PhoneChatHost } from './chatHost.ts';

/**
 * スマホの会話の頼みの入口（呼び鈴の phone-chat の枠）。
 * スマホ用の鍵 M で開き、peer chat の宿主の同じ処理へ通し、答えを M で封じて返す。
 */

type Seen = { sender: PeerChatSender; id: string; req: PeerChatRequest | null };

/** 宿主の偽物。開けた頼みを覚え、決めた答えを封じさせる。 */
function fakeHost(reply: PeerChatReply = { ok: true }): PhoneChatHost & { seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    async handleRequest(sender, id, openFn, sealFn) {
      const req = await openFn().catch(() => null);
      seen.push({ sender, id, req });
      if (!req) return null;
      try { return await sealFn(reply); } catch { return await sealFn({ ok: false, reason: 'too-large' }); }
    },
  };
}

const request = (id: string, over: Partial<PeerChatRequest> = {}): PeerChatRequest => ({ v: 1, askId: id, expiresAt: peerChatExpiresAt(Date.now()), sessionId: 's1', op: { t: 'tail', after: null, waitMs: 0 }, ...over });

async function frame(id: string, o: { epoch?: number; to?: string; key?: string; body?: unknown; aad?: string } = {}) {
  const key = await phoneCryptoKey(o.key ?? PHONE_KEY_1);
  const sealed = await seal(key, o.aad ?? aadPhoneChat(id, o.to ?? 'pc-a'), o.body ?? request(id));
  return { t: 'phone-chat' as const, id, from: 'phone-1', epoch: o.epoch ?? 1, sealed };
}

function setup(reply?: PeerChatReply) {
  const host = fakeHost(reply);
  const entry = createPhoneChatEntry({ deviceId: 'pc-a', phoneKeys: fixedPhoneKeys({ 1: PHONE_KEY_1, 2: PHONE_KEY_2 }), host: () => host, phoneName: (id) => (id === 'phone-1' ? 'iPhone' : null) });
  return { host, entry };
}

describe('スマホの会話の頼みの入口', () => {
  it('M で開いて宿主へ渡し、答えを同じ世代の M と aadPhoneChatReply で封じる。送り主はスマホで、名前は名簿から引く', async () => {
    const { host, entry } = setup({ ok: true, queueId: 'q1' });
    const out = await entry.handle(await frame('c-1'));
    expect(out).toMatchObject({ t: 'phone-chat-reply', id: 'c-1', from: 'phone-1' });
    expect(host.seen).toEqual([{ sender: { id: 'phone-1', kind: 'phone', name: 'iPhone' }, id: 'c-1', req: request('c-1', { expiresAt: host.seen[0]!.req!.expiresAt }) }]);
    const reply = await open<PeerChatReply>(await phoneCryptoKey(PHONE_KEY_1), aadPhoneChatReply('c-1'), out!.sealed);
    expect(reply).toEqual({ ok: true, queueId: 'q1' });
  });

  it('名前の分からないスマホは、宿主の既定の名前に任せる（name を渡さない）', async () => {
    const { host, entry } = setup();
    const f = await frame('c-1');
    await entry.handle({ ...f, from: 'phone-9' });
    expect(host.seen[0]!.sender).toEqual({ id: 'phone-9', kind: 'phone' });
  });

  it('世代 2 で封じた頼みは世代 2 の鍵で開き、答えも世代 2 で封じる', async () => {
    const { entry } = setup();
    const out = await entry.handle(await frame('c-2', { epoch: 2, key: PHONE_KEY_2 }));
    expect(await open(await phoneCryptoKey(PHONE_KEY_2), aadPhoneChatReply('c-2'), out!.sealed)).toEqual({ ok: true });
  });

  it('開けない頼みには答えない（別の宛先、問い合わせの AAD、知らない世代、壊れた封、ID の食い違い、形の違う中身）', async () => {
    const { entry } = setup();
    expect(await entry.handle(await frame('c-1', { to: 'pc-b' }))).toBeNull();
    expect(await entry.handle(await frame('c-1', { aad: aadAsk('c-1', 'pc-a') }))).toBeNull();
    expect(await entry.handle(await frame('c-1', { epoch: 3 }))).toBeNull();
    expect(await entry.handle({ t: 'phone-chat', id: 'c-1', from: 'phone-1', epoch: 1, sealed: 'garbage' })).toBeNull();
    expect(await entry.handle(await frame('c-1', { body: request('c-other') }))).toBeNull();
    expect(await entry.handle(await frame('c-1', { body: { v: 1, askId: 'c-1' } }))).toBeNull();
  });

  it('答えの封が呼び鈴の上限を超えるなら too-large の断りを封じて返す', async () => {
    const big: PeerChatReply = { ok: true, files: Array.from({ length: 2000 }, (_, i) => ({ path: `${'x'.repeat(40)}-${i}`, changed: false })) };
    const { entry } = setup(big);
    const out = await entry.handle(await frame('c-1'));
    expect(out!.sealed.length).toBeLessThanOrEqual(PEER_CHAT_REPLY_SEALED_MAX);
    expect(await open(await phoneCryptoKey(PHONE_KEY_1), aadPhoneChatReply('c-1'), out!.sealed)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('宿主が無い（会話の宿主を組んでいない）ときは答えない', async () => {
    const entry = createPhoneChatEntry({ deviceId: 'pc-a', phoneKeys: fixedPhoneKeys({ 1: PHONE_KEY_1 }), host: () => null, phoneName: () => null });
    expect(await entry.handle(await frame('c-1'))).toBeNull();
  });
});
