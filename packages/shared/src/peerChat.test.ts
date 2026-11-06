import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from './e2e/bytes.ts';
import { deriveEpochKeys, randomEpochKey, type EpochKeys } from './e2e/keys.ts';
import { E2eOpenError, sealJson } from './e2e/seal.ts';
import type { PeerKeyring, PeerRoute } from './e2e/peer.ts';
import { PeerUnknownEpochError } from './e2e/peer.ts';
import * as shared from './index.ts';
import { COMPAT_VERSION } from './compat.ts';
import { PEER_BELL_KINDS } from './peerCloud.ts';
import {
  aadPeerChat,
  aadPeerChatReply,
  checkPeerChatRequest,
  openPeerChat,
  openPeerChatReply,
  parsePeerChatRequest,
  PEER_CHAT_CLOCK_SKEW_MS,
  PEER_CHAT_IMAGES_MAX,
  PEER_CHAT_REFUSALS,
  PEER_CHAT_REPLY_SEALED_MAX,
  PEER_CHAT_SEALED_MAX,
  PEER_CHAT_TEXT_MAX_BYTES,
  PEER_CHAT_TTL_MS,
  PEER_CHAT_WAIT_MAX_MS,
  peerChatExpiresAt,
  sealPeerChat,
  sealPeerChatReply,
  type PeerChatReply,
  type PeerChatRequest,
  type PeerChatState,
} from './peerChat.ts';

async function ringOf(epochs: Record<number, string>, cur: number): Promise<PeerKeyring> {
  const keys = new Map<number, EpochKeys>();
  for (const [n, k] of Object.entries(epochs)) keys.set(Number(n), await deriveEpochKeys(Number(n), k));
  return { current: () => keys.get(cur)!, at: (n) => keys.get(n) ?? null };
}

const NOW = 1_700_000_000_000;
const route: PeerRoute = { requestId: 'ask-1', from: 'pc-a', to: 'pc-b' };
const req = (op: PeerChatRequest['op'], over: Partial<PeerChatRequest> = {}): PeerChatRequest => ({ v: 1, askId: 'ask-1', expiresAt: NOW + PEER_CHAT_TTL_MS, sessionId: 'sess-1', op, ...over });
const img = { n: 0, mime: 'image/png' as const, bytes: 1234 };

const ops: PeerChatRequest['op'][] = [
  { t: 'tail', after: null, waitMs: 0 },
  { t: 'tail', after: 'uuid-9', waitMs: PEER_CHAT_WAIT_MAX_MS },
  { t: 'send', text: 'こんにちは', images: [] },
  { t: 'send', text: '', images: [img] },
  { t: 'answer', askId: 'perm-1', keys: ['1'] },
  { t: 'answer', askId: 'q-1', keys: ['1', '3'], text: '自由記述' },
  { t: 'interrupt' },
  { t: 'resume-send', text: '再開して送る', images: [img] },
  { t: 'cancel', queueId: 'q-7' },
  { t: 'files', query: 'src/' },
];

const state: PeerChatState = {
  sessionId: 'sess-1',
  status: 'waiting',
  items: [
    { uuid: 'u1', at: NOW, kind: 'user', text: 'やって', from: { deviceId: 'pc-a', deviceName: 'A' } },
    { uuid: 'u2', at: NOW + 1, kind: 'tool', text: 'Bash', tool: { name: 'Bash', summary: 'ls', ok: true } },
    {
      uuid: 'u3',
      at: NOW + 2,
      kind: 'permission',
      text: 'Bash を実行しますか',
      ask: { askId: 'perm-1', kind: 'permission', tool: 'Bash', input: 'rm x', options: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }], multi: false, allowText: false, answered: { by: { deviceId: 'pc-a', deviceName: 'A' }, label: 'Yes', at: NOW + 3 } },
    },
  ],
  queued: [{ queueId: 'q-1', from: { deviceId: 'pc-a', deviceName: 'A' }, text: '後で', images: 0, at: NOW, state: 'waiting' }],
  cursor: 'u3',
  truncated: false,
};

describe('互換の版と呼び鈴の種類', () => {
  it('互換の版は 11、呼び鈴の種類に chat がある', () => {
    expect(COMPAT_VERSION).toBe(11);
    expect(PEER_BELL_KINDS).toContain('chat');
  });
  it('パッケージの入口から取れる', () => {
    expect(shared.sealPeerChat).toBe(sealPeerChat);
    expect(shared.openPeerChat).toBe(openPeerChat);
    expect(shared.PEER_CHAT_REFUSALS).toBe(PEER_CHAT_REFUSALS);
  });
});

describe('会話の頼みの封', () => {
  it('どの op も往復する', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    for (const op of ops) {
      const r = req(op);
      expect(await openPeerChat(ring, route, await sealPeerChat(ring, route, r)), JSON.stringify(op)).toEqual(r);
    }
  });

  it('頼みの askId と宛先の requestId が違えば封じない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    await expect(sealPeerChat(ring, { ...route, requestId: 'ask-2' }, req(ops[0]!))).rejects.toBeInstanceOf(TypeError);
  });

  it('AAD の from、to、ask_id を入れ替えると開けない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const sealed = await sealPeerChat(ring, route, req(ops[0]!));
    const swaps: PeerRoute[] = [
      { ...route, requestId: 'ask-2' },
      { ...route, from: 'pc-c' },
      { ...route, to: 'pc-c' },
      { requestId: route.requestId, from: route.to, to: route.from },
    ];
    for (const r of swaps) await expect(openPeerChat(ring, r, sealed)).rejects.toBeInstanceOf(E2eOpenError);
    expect(aadPeerChat(1, route)).not.toBe(aadPeerChatReply(1, route));
  });

  it('本体を壊すと開けない。知らない世代は PeerUnknownEpochError', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const sealed = await sealPeerChat(ring, route, req(ops[0]!));
    const [ep, b64] = sealed.split('.') as [string, string];
    const raw = fromBase64Url(b64)!;
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    await expect(openPeerChat(ring, route, `${ep}.${toBase64Url(raw)}`)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerChat(ring, route, `9.${b64}`)).rejects.toBeInstanceOf(PeerUnknownEpochError);
  });

  it('頼みの封と答えの封は取り違えて開けない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const sealed = await sealPeerChat(ring, route, req(ops[0]!));
    await expect(openPeerChatReply(ring, route, sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('鍵で正しく封じられていても、op の形が不正なら開けない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const keys = ring.current();
    const forge = async (v: unknown) => `1.${toBase64Url(await sealJson(keys.peer, aadPeerChat(1, route), v))}`;
    await expect(openPeerChat(ring, route, await forge({ ...req(ops[0]!), op: { t: 'nope' } }))).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerChat(ring, route, await forge({ ...req(ops[0]!), v: 2 }))).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerChat(ring, route, await forge('x'))).rejects.toBeInstanceOf(E2eOpenError);
    // 頼みの askId が AAD の requestId と違う封も開けない。
    await expect(openPeerChat(ring, route, await forge(req(ops[0]!, { askId: 'ask-9' })))).rejects.toBeInstanceOf(E2eOpenError);
  });
});

describe('頼みの形の検査', () => {
  it('不正な op を断る', () => {
    const bad: unknown[] = [
      null,
      'x',
      [],
      { ...req(ops[0]!), v: 2 },
      { ...req(ops[0]!), askId: '' },
      { ...req(ops[0]!), expiresAt: 'x' },
      { ...req(ops[0]!), sessionId: 1 },
      { ...req(ops[0]!), op: undefined },
      req({ t: 'unknown' } as never),
      req({ t: 'tail', after: 1, waitMs: 0 } as never),
      req({ t: 'tail', after: null, waitMs: -1 }),
      req({ t: 'tail', after: null, waitMs: PEER_CHAT_WAIT_MAX_MS + 1 }),
      req({ t: 'tail', after: null, waitMs: 1.5 }),
      req({ t: 'tail', after: null } as never),
      req({ t: 'send', text: 1, images: [] } as never),
      req({ t: 'send', text: 'a' } as never),
      req({ t: 'send', text: 'a', images: [{ n: 0, mime: 'image/gif', bytes: 1 }] } as never),
      req({ t: 'send', text: 'a', images: [{ n: -1, mime: 'image/png', bytes: 1 }] }),
      req({ t: 'send', text: 'a', images: Array.from({ length: PEER_CHAT_IMAGES_MAX + 1 }, (_, n) => ({ ...img, n })) }),
      req({ t: 'resume-send', text: 'a', images: 'x' } as never),
      req({ t: 'answer', askId: '', keys: ['1'] }),
      req({ t: 'answer', askId: 'a', keys: 'x' } as never),
      req({ t: 'answer', askId: 'a', keys: [1] } as never),
      req({ t: 'answer', askId: 'a', keys: ['1'], text: 3 } as never),
      req({ t: 'cancel', queueId: '' }),
      req({ t: 'cancel' } as never),
      req({ t: 'files' } as never),
      req({ t: 'files', query: 3 } as never),
    ];
    for (const b of bad) expect(parsePeerChatRequest(b), JSON.stringify(b)).toBeNull();
    for (const op of ops) expect(parsePeerChatRequest(req(op))).not.toBeNull();
  });

  it('知らない欄は読み捨てる', () => {
    const r = parsePeerChatRequest({ ...req({ t: 'interrupt' }), extra: 1, op: { t: 'interrupt', extra: 2 } });
    expect(r).toEqual(req({ t: 'interrupt' }));
  });
});

describe('期限と大きさ', () => {
  it('expiresAt を過ぎた頼みは expired で断る。ちょうどは通す', () => {
    const r = req(ops[0]!);
    expect(checkPeerChatRequest(r, r.expiresAt)).toEqual({ ok: true });
    expect(checkPeerChatRequest(r, r.expiresAt + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('期限が遠い未来の頼みは expired で断る。時計のずれの幅までは通す', () => {
    const at = (expiresAt: number) => checkPeerChatRequest(req(ops[0]!, { expiresAt }), NOW);
    expect(at(NOW + PEER_CHAT_TTL_MS + PEER_CHAT_CLOCK_SKEW_MS)).toEqual({ ok: true });
    expect(at(NOW + PEER_CHAT_TTL_MS + PEER_CHAT_CLOCK_SKEW_MS + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(at(NOW + 365 * 86_400_000)).toEqual({ ok: false, reason: 'expired' });
    expect(PEER_CHAT_CLOCK_SKEW_MS).toBe(5_000);
  });

  it('期限は作った時刻の 60 秒後', () => {
    expect(PEER_CHAT_TTL_MS).toBe(60_000);
    expect(peerChatExpiresAt(NOW)).toBe(NOW + 60_000);
  });

  it('本文が上限（UTF-8 のバイト数）を超えれば too-large、上限ちょうどは通す', () => {
    const at = (text: string) => checkPeerChatRequest(req({ t: 'send', text, images: [] }), NOW);
    expect(at('a'.repeat(PEER_CHAT_TEXT_MAX_BYTES))).toEqual({ ok: true });
    expect(at('a'.repeat(PEER_CHAT_TEXT_MAX_BYTES + 1))).toEqual({ ok: false, reason: 'too-large' });
    // 日本語は 1 字 3 バイトなので、字数では上限の 3 分の 1 で超える。
    expect(at('あ'.repeat(Math.floor(PEER_CHAT_TEXT_MAX_BYTES / 3) + 1))).toEqual({ ok: false, reason: 'too-large' });
    expect(checkPeerChatRequest(req({ t: 'resume-send', text: 'a'.repeat(PEER_CHAT_TEXT_MAX_BYTES + 1), images: [] }), NOW)).toEqual({ ok: false, reason: 'too-large' });
    expect(checkPeerChatRequest(req({ t: 'answer', askId: 'a', keys: ['1'], text: 'a'.repeat(PEER_CHAT_TEXT_MAX_BYTES + 1) }), NOW)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('上限は Worker の本文 96 KiB と答えの上限に収まる', () => {
    expect(PEER_CHAT_SEALED_MAX).toBeLessThan(96 * 1024);
    expect(PEER_CHAT_REPLY_SEALED_MAX).toBe(shared.MOBILE_REPLY_MAX_BYTES);
  });

  it('本文が上限を超える頼みは封じない（上限ちょうどは、どんな並びでも封の上限に収まる）', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    await expect(sealPeerChat(ring, route, req({ t: 'send', text: 'a'.repeat(PEER_CHAT_TEXT_MAX_BYTES + 1), images: [] }))).rejects.toBeInstanceOf(TypeError);
    // 制御文字は JSON で 6 倍に膨らみ、乱数なので gzip も効かない最悪の並び。
    const bytes = new Uint8Array(PEER_CHAT_TEXT_MAX_BYTES);
    crypto.getRandomValues(bytes);
    const noisy = Array.from(bytes, (x) => String.fromCharCode(x % 32)).join('');
    const sealed = await sealPeerChat(ring, route, req({ t: 'send', text: noisy, images: [] }));
    expect(sealed.length).toBeLessThanOrEqual(PEER_CHAT_SEALED_MAX);
  });
});

describe('答えの封', () => {
  it('ok と断りが往復する', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const replies: PeerChatReply[] = [
      { ok: true, state },
      { ok: true, queueId: 'q-1' },
      { ok: true },
      { ok: true, files: [{ path: 'a.ts', changed: true }] },
      ...PEER_CHAT_REFUSALS.map((reason) => ({ ok: false as const, reason })),
    ];
    for (const r of replies) expect(await openPeerChatReply(ring, route, await sealPeerChatReply(ring, route, r)), JSON.stringify(r)).toEqual(r);
  });

  it('断りの理由は計画の 11 個', () => {
    expect([...PEER_CHAT_REFUSALS]).toEqual(['offline', 'refused-by-setting', 'not-claude', 'session-unknown', 'expired', 'already-answered', 'ask-mismatch', 'resume-failed', 'queue-expired', 'too-large', 'rate', 'host-error']);
  });

  it('AAD が違えば開けず、形が不正な答えは封じも開けもしない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const sealed = await sealPeerChatReply(ring, route, { ok: true, state });
    await expect(openPeerChatReply(ring, { ...route, requestId: 'ask-2' }, sealed)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(sealPeerChatReply(ring, route, { ok: false, reason: 'nope' } as never)).rejects.toBeInstanceOf(TypeError);
    await expect(sealPeerChatReply(ring, route, { ok: true, state: { ...state, status: 'x' } } as never)).rejects.toBeInstanceOf(TypeError);
    await expect(sealPeerChatReply(ring, route, { ok: true, state: { ...state, items: [{ ...state.items[0]!, kind: 'x' }] } } as never)).rejects.toBeInstanceOf(TypeError);
    const keys = ring.current();
    const forged = `1.${toBase64Url(await sealJson(keys.peer, aadPeerChatReply(1, route), { ok: false, reason: 'nope' }))}`;
    await expect(openPeerChatReply(ring, route, forged)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('答えの封が上限を超えるなら封じない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const noisy = Array.from({ length: 2 }, () => {
      const bytes = new Uint8Array(40_000);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (x) => String.fromCharCode(33 + (x % 90))).join('');
    }).join('');
    await expect(sealPeerChatReply(ring, route, { ok: true, state: { ...state, items: [{ uuid: 'u', at: NOW, kind: 'assistant', text: noisy }] } })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('peerChatAcceptOf', () => {
  it('項目が無いときと true は受ける。false だけが受けない', () => {
    expect(shared.peerChatAcceptOf({})).toBe(true);
    expect(shared.peerChatAcceptOf({ peerChatAcceptFromPeers: true })).toBe(true);
    expect(shared.peerChatAcceptOf({ peerChatAcceptFromPeers: false })).toBe(false);
  });
});

describe('PeerChatState.gone', () => {
  const base = { sessionId: 's', status: 'idle', items: [], queued: [], cursor: null, truncated: false };
  it('渡せずに消えた預かりを答えの形検査が残す。形の違う gone は答え全体を断る', () => {
    const ok = shared.parsePeerChatReply({ ok: true, state: { ...base, gone: [{ queueId: 'q1', reason: 'queue-expired', extra: 1 }] } });
    expect(ok).toEqual({ ok: true, state: { ...base, gone: [{ queueId: 'q1', reason: 'queue-expired' }] } });
    expect(shared.parsePeerChatReply({ ok: true, state: { ...base, gone: [{ queueId: 'q1', reason: 'nope' }] } })).toBeNull();
    expect(shared.parsePeerChatReply({ ok: true, state: { ...base, gone: 'x' } })).toBeNull();
    expect(shared.parsePeerChatReply({ ok: true, state: base })).toEqual({ ok: true, state: base });
  });
});

describe('画像の封（sealPeerChatBlob と openPeerChatBlob）', () => {
  it('同じ世代の鍵、route、番号でだけ開ける', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const sealed = await shared.sealPeerChatBlob(ring, route, 2, bytes);
    expect([...(await shared.openPeerChatBlob(ring, route, 2, sealed))]).toEqual([1, 2, 3, 250]);
    await expect(shared.openPeerChatBlob(ring, route, 3, sealed)).rejects.toBeTruthy();
    await expect(shared.openPeerChatBlob(ring, { ...route, requestId: 'ask-2' }, 2, sealed)).rejects.toBeTruthy();
    await expect(shared.openPeerChatBlob(ring, { ...route, from: 'pc-c' }, 2, sealed)).rejects.toBeTruthy();
    const other = new Uint8Array(sealed);
    new DataView(other.buffer).setUint32(0, 7, false);
    await expect(shared.openPeerChatBlob(ring, route, 2, other)).rejects.toBeInstanceOf(PeerUnknownEpochError);
    await expect(shared.openPeerChatBlob(ring, route, 2, new Uint8Array([0, 0]))).rejects.toBeInstanceOf(E2eOpenError);
    expect(new DataView(sealed.buffer).getUint32(0, false)).toBe(1);
  });

  it('封は、先頭の世代 4 バイトと iv と tag の 28 バイトを画像の大きさに足したものになる', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const sealed = await shared.sealPeerChatBlob(ring, route, 0, new Uint8Array(1000));
    expect(sealed.byteLength).toBe(1000 + shared.PEER_CHAT_BLOB_OVERHEAD_BYTES);
  });
});

describe('画面からの WebSocket の本文（parsePeerChatClientMsg）', () => {
  it('watch と unwatch を読む。after は省略、null、文字列のどれでも読む', () => {
    expect(shared.parsePeerChatClientMsg('{"type":"peerChat.watch","sessionId":"s1","viewer":"tab-1"}')).toEqual({ type: 'peerChat.watch', sessionId: 's1', viewer: 'tab-1' });
    expect(shared.parsePeerChatClientMsg('{"type":"peerChat.watch","sessionId":"s1","viewer":"tab-1","after":null}')).toEqual({ type: 'peerChat.watch', sessionId: 's1', viewer: 'tab-1', after: null });
    expect(shared.parsePeerChatClientMsg('{"type":"peerChat.watch","sessionId":"s1","viewer":"tab-1","after":"u9"}')).toEqual({ type: 'peerChat.watch', sessionId: 's1', viewer: 'tab-1', after: 'u9' });
    expect(shared.parsePeerChatClientMsg('{"type":"peerChat.unwatch","sessionId":"s1","viewer":"tab-1"}')).toEqual({ type: 'peerChat.unwatch', sessionId: 's1', viewer: 'tab-1' });
  });

  it('形が違う、知らない種類、壊れた JSON は null', () => {
    for (const raw of ['nope', '{}', '{"type":"x","sessionId":"s","viewer":"v"}', '{"type":"peerChat.watch","sessionId":"","viewer":"v"}', '{"type":"peerChat.watch","sessionId":"s","viewer":"a b"}', '{"type":"peerChat.watch","sessionId":"s","viewer":"v","after":3}', '{"type":"peerChat.unwatch","sessionId":"s"}']) {
      expect(shared.parsePeerChatClientMsg(raw)).toBeNull();
    }
  });
});
