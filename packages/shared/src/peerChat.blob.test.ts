import { describe, expect, it } from 'vitest';
import { deriveEpochKeys, randomEpochKey, type EpochKeys } from './e2e/keys.ts';
import { E2eOpenError } from './e2e/seal.ts';
import type { PeerKeyring, PeerRoute } from './e2e/peer.ts';
import { PeerUnknownEpochError } from './e2e/peer.ts';
import { MOBILE_IMAGE_MAX_BYTES } from './mobile.ts';
import { aadPeerChat, aadPeerChatBlob, PEER_CHAT_BLOB_MAX_BYTES, PEER_CHAT_BLOB_OVERHEAD_BYTES, openPeerChatBlob, openPeerChatReply, sealPeerChatBlob, sealPeerChatReply, type PeerChatState } from './peerChat.ts';

async function ringOf(epochs: Record<number, string>, cur: number): Promise<PeerKeyring> {
  const keys = new Map<number, EpochKeys>();
  for (const [n, k] of Object.entries(epochs)) keys.set(Number(n), await deriveEpochKeys(Number(n), k));
  return { current: () => keys.get(cur)!, at: (n) => keys.get(n) ?? null };
}

const route: PeerRoute = { requestId: 'ask-1', from: 'pc-a', to: 'pc-b' };

describe('state.gone（送り主への、預かりが消えた知らせ）', () => {
  const base: PeerChatState = { sessionId: 's', status: 'idle', items: [], queued: [], cursor: null, truncated: false };
  it('封の往復で残り、知らない理由は形の違いになる', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const state: PeerChatState = { ...base, gone: [{ queueId: 'q1', reason: 'queue-expired' }, { queueId: 'q2', reason: 'session-unknown' }] };
    const sealed = await sealPeerChatReply(ring, route, { ok: true, state });
    expect(await openPeerChatReply(ring, route, sealed)).toEqual({ ok: true, state });
    await expect(sealPeerChatReply(ring, route, { ok: true, state: { ...base, gone: [{ queueId: 'q', reason: 'nope' as never }] } })).rejects.toThrow(TypeError);
  });
  it('gone が無い state はそのまま通る', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const back = await openPeerChatReply(ring, route, await sealPeerChatReply(ring, route, { ok: true, state: base }));
    expect(back).toEqual({ ok: true, state: base });
  });
});

describe('画像の封（PC どうし）', () => {
  it('往復でき、番号か宛先か askId が違えば開かない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const sealed = await sealPeerChatBlob(ring, route, 0, new Uint8Array([1, 2, 3, 4, 5]));
    expect(Array.from(await openPeerChatBlob(ring, route, 0, sealed))).toEqual([1, 2, 3, 4, 5]);
    await expect(openPeerChatBlob(ring, route, 1, sealed)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerChatBlob(ring, { ...route, to: 'pc-c' }, 0, sealed)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerChatBlob(ring, { ...route, requestId: 'other' }, 0, sealed)).rejects.toBeInstanceOf(E2eOpenError);
    expect(aadPeerChatBlob(1, route, 0)).not.toBe(aadPeerChat(1, route));
  });
  it('封は元の画像より PEER_CHAT_BLOB_OVERHEAD_BYTES だけ大きい。最大の画像は PEER_CHAT_BLOB_MAX_BYTES ちょうど', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    expect((await sealPeerChatBlob(ring, route, 0, new Uint8Array(10))).byteLength).toBe(10 + PEER_CHAT_BLOB_OVERHEAD_BYTES);
    expect((await sealPeerChatBlob(ring, route, 0, new Uint8Array(MOBILE_IMAGE_MAX_BYTES))).byteLength).toBe(PEER_CHAT_BLOB_MAX_BYTES);
  });
  it('世代の鍵が無ければ PeerUnknownEpochError', async () => {
    const a = await ringOf({ 1: randomEpochKey() }, 1);
    const b = await ringOf({ 2: randomEpochKey() }, 2);
    await expect(openPeerChatBlob(b, route, 0, await sealPeerChatBlob(a, route, 0, new Uint8Array([9])))).rejects.toBeInstanceOf(PeerUnknownEpochError);
  });
  it('短すぎる入力は開かない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    await expect(openPeerChatBlob(ring, route, 0, new Uint8Array([0, 0]))).rejects.toBeInstanceOf(E2eOpenError);
  });
});
