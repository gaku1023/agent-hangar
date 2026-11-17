// shared を入口（index.ts）から読むと PC 向けの表まで束に入るので、使うものだけを直に読む。
import { aadPhoneChat, aadPhoneChatReply, open, seal, MobilePairingError } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { PHONE_CHAT_MIN_WORKER_COMPAT } from '@agent-hangar/shared/src/compat.ts';
import type { PhoneChatIn } from '@agent-hangar/shared/src/mobile.ts';
import { parsePeerChatReply, peerAskInsertIndex, peerChatExpiresAt, type PeerChatItem, type PeerChatOp, type PeerChatQueued, type PeerChatReply, type PeerChatRequest, type PeerChatState, type PeerChatStatus } from '@agent-hangar/shared/src/peerChat.ts';
import { mobileHeaders, originOf, unpairedOf, workerCompatOf, type UnpairedReason } from './api.ts';
import type { Pairing, PhoneKey } from './store.ts';

/**
 * 会話の問い合わせ（POST /m/chat）が答えを返さなかった理由。
 * - pc-offline：宛先の PC が呼び鈴につないでいない（409、503）。
 * - pc-timeout：PC が待ちの間に答えなかった（504）。
 * - unsupported：口の無い古い Worker（応答の版の見出しが PHONE_CHAT_MIN_WORKER_COMPAT 未満）。
 * - not-found：宛先の PC が無いか、解除された（404）。
 * - too-large：本文か答えが大きすぎる（413、502）。
 * - unreadable：答えを開けないか、形が違う。
 */
export type ChatFailure = 'pc-offline' | 'pc-timeout' | 'unsupported' | 'not-found' | 'unreadable' | 'rate-limited' | 'too-large' | 'unpaired' | 'network' | 'server';

export class ChatError extends Error {
  constructor(
    readonly failure: ChatFailure,
    readonly status?: number,
    readonly unpairedReason?: UnpairedReason,
  ) {
    super(`chat: ${failure}${status ? ` (${status})` : ''}`);
    this.name = 'ChatError';
  }
}

/** tail 以外の頼み（send、answer、interrupt）が答えを待つ長さ。peer chat の操作と同じ。 */
export const CHAT_OP_WAIT_MS = 10_000;
/** tail の長い待ち。 */
export { PEER_CHAT_WAIT_MAX_MS as CHAT_TAIL_WAIT_MS } from '@agent-hangar/shared/src/peerChat.ts';

type CallOptions = {
  /** 宛先の PC の中の会話の ID。 */
  sessionId: string;
  /** Worker の時刻からスマホの時刻を引いた差（ms）。頼みの期限は Worker の時刻に寄せて決める。 */
  skewMs?: number;
  now?: () => number;
  signal?: AbortSignal;
};

function failureOf(status: number): ChatError {
  if (status === 401) return new ChatError('unpaired', 401);
  if (status === 404) return new ChatError('not-found', 404);
  if (status === 409 || status === 503) return new ChatError('pc-offline', status);
  if (status === 504) return new ChatError('pc-timeout', 504);
  if (status === 429) return new ChatError('rate-limited', 429);
  if (status === 413 || status === 502) return new ChatError('too-large', status);
  return new ChatError('server', status);
}

/**
 * 宛先の PC の会話に頼みを出し、答えを待つ（POST /m/chat）。
 * 頼みは peer chat の PeerChatRequest と同じ形で、スマホ用の鍵で aadPhoneChat(askId, 宛先) で封じる。答えは aadPhoneChatReply(askId) で開く。
 * PC の断り（ok: false）は答えとして返し、運びの失敗だけを ChatError で投げる。
 */
export async function chatCall(p: Pairing, key: PhoneKey, to: string, op: PeerChatOp, o: CallOptions): Promise<PeerChatReply> {
  const askId = globalThis.crypto.randomUUID();
  let origin: string;
  try {
    origin = originOf(p.url);
  } catch (e) {
    if (e instanceof MobilePairingError) throw new ChatError('unpaired');
    throw e;
  }
  const waitMs = op.t === 'tail' ? op.waitMs : CHAT_OP_WAIT_MS;
  const req: PeerChatRequest = { v: 1, askId, expiresAt: peerChatExpiresAt((o.now ?? Date.now)() + (o.skewMs ?? 0)), sessionId: o.sessionId, op };
  const sealed = await seal(key.key, aadPhoneChat(askId, to), req);
  const body: PhoneChatIn = { askId, to, sealed, epoch: key.epoch, waitMs };
  let res: Response;
  try {
    res = await fetch(`${origin}/m/chat`, {
      method: 'POST',
      headers: { ...mobileHeaders(p), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      ...(o.signal ? { signal: o.signal } : {}),
    });
  } catch {
    throw new ChatError('network');
  }
  const compat = workerCompatOf(res);
  if (compat !== null && compat < PHONE_CHAT_MIN_WORKER_COMPAT) throw new ChatError('unsupported', res.status);
  if (res.status === 401) throw new ChatError('unpaired', 401, (await unpairedOf(res)).reason);
  if (!res.ok) throw failureOf(res.status);
  let out: unknown;
  try {
    out = await res.json();
  } catch {
    throw new ChatError('unreadable', res.status);
  }
  const s = out && typeof out === 'object' ? (out as { sealed?: unknown }).sealed : undefined;
  if (typeof s !== 'string') throw new ChatError('unreadable', res.status);
  try {
    const reply = parsePeerChatReply(await open<unknown>(key.key, aadPhoneChatReply(askId), s));
    if (!reply) throw new ChatError('unreadable', res.status);
    return reply;
  } catch (e) {
    if (e instanceof ChatError) throw e;
    throw new ChatError('unreadable', res.status);
  }
}

/** 会話の頁の手元の写し。 */
export type ChatState = {
  items: PeerChatItem[];
  queued: PeerChatQueued[];
  status: PeerChatStatus | null;
  cursor: string | null;
};

export const emptyChat = (): ChatState => ({ items: [], queued: [], status: null, cursor: null });

/** 項目を uuid で重ね書きする。札は askId が同じものも置き換え、初めて見る札は札が呼んだ位置に入れる。 */
function upsert(items: PeerChatItem[], incoming: PeerChatItem[]): PeerChatItem[] {
  const out = [...items];
  for (const it of incoming) {
    let at = out.findIndex((x) => x.uuid === it.uuid);
    if (at < 0 && it.ask) at = out.findIndex((x) => x.ask?.askId === it.ask!.askId);
    if (at >= 0) out[at] = it;
    else if (it.ask) out.splice(peerAskInsertIndex(out, it), 0, it);
    else out.push(it);
  }
  return out;
}

/** tail の答えを手元の写しに重ねる。truncated なら手元を捨てて差し替える。 */
export function applyChatState(s: ChatState, st: PeerChatState): ChatState {
  return {
    items: st.truncated ? upsert([], st.items) : upsert(s.items, st.items),
    queued: st.queued,
    status: st.status,
    cursor: st.cursor ?? s.cursor,
  };
}
