import type { SessionDto } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import type { PeerChatSlice } from '../store/peerChat.ts';

/**
 * ほかの PC の会話の画面に出す、相手の PC の名前。
 * 見張りが一度も相手から返事を得ていない（つながっていない）と、見張りの答えに相手の名前が載らない、または空のことがある。
 * そのときも名前を出せるよう、次の順で補う。
 * 1. 見張りの答えの名前。
 * 2. 見張りの答えの id を、同期で持っている PC の名簿（store.devices）で引いた名前。
 * 3. 会話のロックの PC の名前（見出しの「{PC} で実行中」と同じ出どころ）。ただし応答が途絶えたロック（stale）は使わない。
 * サーバが相手を決める基準（peer/chat/viewTarget.ts）は、応答のある run の PC を先に採り、古い PC の run は数えないので、応答のあるロックとだけ一致する。
 * 4. 同期で持っている、この PC 以外の run の PC。会話のそれが 1 台に定まるときだけ使う（複数の PC に run があれば、取り違えるので使わない）。
 * 5. 応答が途絶えたロックの PC。ほかの PC の run が分からないか、同じ PC のものだけのときに限る。
 * どれも無ければ空（別の PC の名前を当てるより、空の方がよい）。
 */
export function peerChatDeviceName(store: Store, s: SessionDto, slice: PeerChatSlice): string {
  const known = (id: string): string => store.devices.find((d) => d.id === id)?.name ?? '';
  if (slice.device?.deviceName) return slice.device.deviceName;
  const fromSlice = slice.device ? known(slice.device.deviceId) : '';
  if (fromSlice) return fromSlice;
  const lock = s.lock;
  if (lock && !lock.stale && lock.deviceName) return lock.deviceName;
  const myId = store.device?.id ?? null;
  const ids = new Set(Object.values(store.runs).filter((r) => r.sessionId === s.id && r.deviceId !== myId).map((r) => r.deviceId));
  if (ids.size === 1) {
    const id = [...ids][0]!;
    return known(id) || (lock?.deviceId === id ? lock.deviceName : '');
  }
  if (ids.size === 0 && lock) return lock.deviceName;
  return '';
}
