import type { SessionDto } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import type { PeerChatSlice } from '../store/peerChat.ts';

/**
 * ほかの PC の会話の画面に出す、相手の PC の名前。
 * 見張りが一度も相手から返事を得ていない（つながっていない）と、見張りの答えに相手の名前が載らない、または空のことがある。
 * そのときも名前を出せるよう、次の順で補う。
 * 1. 見張りの答えの名前。
 * 2. 見張りの答えの id を、同期で持っている PC の名簿（store.devices）で引いた名前。
 * 3. 会話のロックの PC の名前（見出しの「{PC} で実行中」と同じ出どころ）。
 * 4. 同期で持っている run の PC（動いている run、なければ最後の run。この PC のものは除く）を、名簿で引いた名前。
 * どれも無ければ空。
 */
export function peerChatDeviceName(store: Store, s: SessionDto, slice: PeerChatSlice): string {
  const known = (id: string): string => store.devices.find((d) => d.id === id)?.name ?? '';
  if (slice.device?.deviceName) return slice.device.deviceName;
  const fromSlice = slice.device ? known(slice.device.deviceId) : '';
  if (fromSlice) return fromSlice;
  if (s.lock?.deviceName) return s.lock.deviceName;
  const myId = store.device?.id ?? null;
  const runs = Object.values(store.runs).filter((r) => r.sessionId === s.id && r.deviceId !== myId);
  const run = runs.find((r) => r.endedAt === null) ?? runs.sort((a, b) => b.startedAt - a.startedAt)[0];
  return run ? known(run.deviceId) : '';
}
