import type { Db } from '../db/open.ts';

/** 意図の本文の上限。長い意図は横目で読めない。 */
export const INTENT_MAX = 200;

export type TurnIntent = { at: number; text: string };

/** 意図を積む。同じミリ秒に 2 度来たら、後の方を 1 ミリ秒ずつずらして両方残す。 */
export function addIntent(db: Db, sessionId: string, text: string, now: number): TurnIntent {
  let at = now;
  const taken = db.prepare('select 1 from turn_intents where session_id = ? and at = ?');
  while (taken.get(sessionId, at)) at++;
  db.prepare('insert into turn_intents (session_id, at, text) values (?, ?, ?)').run(sessionId, at, text);
  return { at, text };
}

const intentListeners = new Set<(sessionId: string) => void>();

/**
 * 意図が積まれたときの購読を足す。戻り値を呼ぶと外す。
 * 知らせるのは書いた側（mcp/tools.ts の setTurnIntentTool）で、addIntent の後に noteIntent を呼ぶ。
 * 購読はプロセスに 1 つの集まりである。受信箱の素（mobile/publisher.ts）が書き直しのきっかけにする。
 */
export function onIntent(cb: (sessionId: string) => void): () => void {
  intentListeners.add(cb);
  return () => { intentListeners.delete(cb); };
}

/** 意図が積まれたことを購読へ知らせる。購読が投げても、書いた側にも他の購読にも波及させない。 */
export function noteIntent(sessionId: string): void {
  for (const cb of intentListeners) {
    try { cb(sessionId); } catch (e) { console.error('[intent] a listener failed', e instanceof Error ? e.constructor.name : typeof e); }
  }
}

export function latestIntent(db: Db, sessionId: string): TurnIntent | null {
  return (db.prepare('select at, text from turn_intents where session_id = ? order by at desc limit 1').get(sessionId) as TurnIntent | undefined) ?? null;
}
