import type { SessionStateDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { getSessionState, setSessionState } from './states.ts';

export type WakeDeps = {
  db: Db;
  deviceId: string;
  /**
   * 会話へ文を渡す。
   * 動いていて渡せなければ 'busy'。
   * 止まっている会話は、渡す前に起こし直す。
   */
  deliver(sessionId: string, text: string): Promise<{ sessionId: string } | 'busy'>;
};

/**
 * Paused の会話を起こす。
 * 「今すぐ試す」（/sessions/:id/try-now）と、できごとで起こす結び付け（event/dispatcher.ts）が使う。
 * 渡せてから Active にする。
 * 渡せなければ Paused のまま残す。
 * Paused でなければ何も渡さず 'not_paused'、動いていて渡せなければ 'busy'。
 * 渡すのに失敗したときは、投げたまま Paused に残す。
 * 状態の setBy は user のままにする。
 * StateSetBy に event は無く、利用者が決めた Paused を解くので user で足りる。
 */
export async function wakePaused(d: WakeDeps, sessionId: string, text: (state: SessionStateDto) => string): Promise<'woken' | 'not_paused' | 'busy'> {
  const state = getSessionState(d.db, sessionId);
  if (state?.status !== 'paused') return 'not_paused';
  const got = await d.deliver(sessionId, text(state));
  if (got === 'busy') return 'busy';
  setSessionState(d.db, d.deviceId, sessionId, { status: null, setBy: 'user' });
  return 'woken';
}
