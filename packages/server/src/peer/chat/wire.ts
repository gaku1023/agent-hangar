import { parsePeerChatClientMsg } from '@agent-hangar/shared';
import type { EventHub } from '../../ws/hub.ts';
import type { PeerChatViewer } from './viewer.ts';

/**
 * 画面の WebSocket（ws/hub.ts）と、ほかの PC の会話の見張り（peer/chat/viewer.ts）を結ぶ。
 * 画面が peerChat.watch を送ると見張りを始め、peerChat.unwatch で外れる。
 * 接続が切れたら、その接続で見始めた人を全員外す。
 * 見ている人がいなくなった会話の長いポーリングは、見張りの側で止まる。
 * 形の違う本文は捨てる。
 */
export function attachPeerChatSocket(hub: Pick<EventHub, 'onMessage' | 'onClose'>, viewer: Pick<PeerChatViewer, 'watchFromSocket' | 'unwatch' | 'dropSocket'>): void {
  hub.onMessage((client, raw) => {
    const msg = parsePeerChatClientMsg(raw);
    if (!msg) return;
    if (msg.type === 'peerChat.watch') viewer.watchFromSocket(client, msg);
    else viewer.unwatch(msg.sessionId, msg.viewer, client);
  });
  hub.onClose((client) => { viewer.dropSocket(client); });
}
