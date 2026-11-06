import type { Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';

/**
 * 元の PC の前の人に、ほかの PC から来た文を知らせる表示（試作 peer-chat の 5B）。
 * band は、預かっている間に端末の下へ出す帯の文。預かりが無ければ null。
 * flash は、渡した直後の札の文。key は渡した時刻で、同じ札を二度出さず、続けて渡したときは出し直す鍵に使う。
 * 札を何秒出すかは時計を持つ view が決める（PEER_FLASH_MS）。この関数は時刻を読まない。
 * どちらも無い会話は null を返す。
 */
export type PeerOriginProps = { band: string | null; flash: { text: string; key: number } | null };

/** 札を出しておく長さ（ミリ秒）。 */
export const PEER_FLASH_MS = 3000;

export function presentPeerOrigin(store: Store, sessionId: string, t: Translate): PeerOriginProps | null {
  const queued = store.peerQueued[sessionId] ?? [];
  const delivered = store.peerDelivered[sessionId] ?? null;
  if (queued.length === 0 && !delivered) return null;
  // 送り主の名前は、同じ PC を 1 回にして、預かった順に並べる。
  const devices = [...new Set(queued.map((q) => q.from.deviceName))].join('、');
  return {
    band: queued.length > 0 ? t('terminal.peer.queued', { devices, n: queued.length }) : null,
    flash: delivered ? { text: t('terminal.peer.delivered', { device: delivered.from.deviceName }), key: delivered.at } : null,
  };
}
