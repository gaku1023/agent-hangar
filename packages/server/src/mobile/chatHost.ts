import { aadPhoneChat, aadPhoneChatReply, open, parsePeerChatReply, parsePeerChatRequest, PEER_CHAT_REPLY_SEALED_MAX, seal, type PeerChatReply, type PeerChatRequest, type PhoneChatBellAsk, type PhoneChatBellReply } from '@agent-hangar/shared';
import type { PeerChatHost } from '../peer/chat/host.ts';
import type { PhoneKeySource } from '../sync/phoneKeys.ts';

/**
 * スマホの会話の頼み（呼び鈴の phone-chat の枠、互換の版 13）の入口。
 *
 * 封はスマホ用の鍵 M の、枠が名乗る世代で開く。AAD は aadPhoneChat(頼みの ID, この PC) で、別の PC に渡った頼みや、問い合わせ（ask:）の封は開けない。
 * 中身は peer chat の PeerChatRequest と同じ形で、開けたら peer chat の宿主の同じ op の処理へ通す（PeerChatHost.handleRequest）。
 * 送り主は枠の from（Worker が端末トークンで決めたスマホの ID）で、名前は名簿から引く。
 * 答えは同じ世代の M と aadPhoneChatReply(頼みの ID) で封じ、呼び鈴の上限（PEER_CHAT_REPLY_SEALED_MAX）を超えるなら too-large の断りに替える。
 * 開けない頼みには答えない（スマホの待ちは Worker が切る）。投げない。
 */

export type PhoneChatHost = Pick<PeerChatHost, 'handleRequest'>;

export type PhoneChatEntryDeps = {
  /** この PC の端末 ID（封の宛先）。 */
  deviceId: string;
  phoneKeys: Pick<PhoneKeySource, 'at'>;
  /** peer chat の宿主。組んでいなければ null で、頼みには答えない。 */
  host(): PhoneChatHost | null;
  /** スマホの名前（Worker の端末の一覧から）。分からなければ null で、宿主の既定の名前に任せる。 */
  phoneName(phoneId: string): string | null;
};

export type PhoneChatEntry = {
  handle(frame: PhoneChatBellAsk): Promise<PhoneChatBellReply | null>;
};

export function createPhoneChatEntry(d: PhoneChatEntryDeps): PhoneChatEntry {
  return {
    async handle(frame) {
      try {
        const host = d.host();
        if (!host) return null;
        const phoneKey = await d.phoneKeys.at(frame.epoch);
        if (!phoneKey) return null;
        const key = phoneKey.key;
        const openReq = async (): Promise<PeerChatRequest | null> => {
          const req = parsePeerChatRequest(await open<unknown>(key, aadPhoneChat(frame.id, d.deviceId), frame.sealed));
          return req && req.askId === frame.id ? req : null;
        };
        const sealReply = async (reply: PeerChatReply): Promise<string> => {
          const v = parsePeerChatReply(reply);
          if (!v) throw new TypeError('bad reply shape');
          const sealed = await seal(key, aadPhoneChatReply(frame.id), v);
          if (sealed.length > PEER_CHAT_REPLY_SEALED_MAX) throw new TypeError('sealed reply too large');
          return sealed;
        };
        const name = d.phoneName(frame.from);
        const sealed = await host.handleRequest({ id: frame.from, kind: 'phone', ...(name ? { name } : {}) }, frame.id, openReq, sealReply);
        return sealed === null ? null : { t: 'phone-chat-reply', id: frame.id, from: frame.from, sealed };
      } catch (e) {
        console.error('[mobile] could not answer the phone chat', e instanceof Error ? e.constructor.name : typeof e);
        return null;
      }
    },
  };
}
