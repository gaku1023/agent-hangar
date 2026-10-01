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

export function latestIntent(db: Db, sessionId: string): TurnIntent | null {
  return (db.prepare('select at, text from turn_intents where session_id = ? order by at desc limit 1').get(sessionId) as TurnIntent | undefined) ?? null;
}
