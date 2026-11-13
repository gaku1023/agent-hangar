import type { Db } from '../db/open.ts';
import { isSpawnedBy } from '../sessions/spawns.ts';

/**
 * 統括が関わった会話（docs/design.md「統括」の出来事の種類）。
 * turn.done と session.ended は、統括が起こした会話か、統括が直近に send_to_session した会話だけを出来事にする。
 * 利用者が手元で使っている会話の終わりまで全部読ませると、常駐の使用量が跳ねるためである。
 *
 * 起こした会話は session_spawns（MCP の create_session が書く）で引く。
 * 送った印はメモリだけに持ち、その会話の終わりを統括へ伝えたら使い切る（forgetSend）。
 * 印は送った会話ごとに持つので、統括でない会話の送信も覚えるが、出来事の側が統括の id で引くので混ざらない。
 */

/** 送った印を覚えておく長さ。送ったまま終わりを伝えないで残った印を捨てる。 */
const SEND_KEEP_MS = 24 * 60 * 60_000;

const sends = new WeakMap<Db, Map<string, number>>();
const keyOf = (from: string, to: string): string => `${from}\u0000${to}`;

/** from の会話が to の会話へ送った（MCP の send_to_session）。 */
export function noteSessionSend(db: Db, from: string, to: string, at: number): void {
  let m = sends.get(db);
  if (!m) sends.set(db, (m = new Map()));
  for (const [k, t] of m) if (at - t > SEND_KEEP_MS) m.delete(k);
  m.set(keyOf(from, to), at);
}

/** 送った印を使い切る。 */
export function forgetSend(db: Db, from: string, to: string): void {
  sends.get(db)?.delete(keyOf(from, to));
}

/** self（統括）が id の会話に関わっているか。 */
export function involvedWith(db: Db, deviceId: string, self: string, id: string): boolean {
  return sends.get(db)?.has(keyOf(self, id)) === true || isSpawnedBy(db, deviceId, self, id);
}
