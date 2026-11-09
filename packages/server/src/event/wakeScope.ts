import type { Db } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { getSessionState } from '../sessions/states.ts';
import { deleteBinding, listBindings } from './store.ts';

/**
 * 起こす結び付けは、作った Paused のあいだだけ生きる（#563）。
 * 会話が Paused を離れたら（手で再開、Done、新しい発言、他の PC からの同期、削除）、その会話の起こす結び付けを消す。
 * Paused のまま書き直したとき（理由や戻る日を変えたとき）は、何もしない。
 * 起こした会話の結び付けも、起こした側が Active にした時点でここで消える。
 */

/** Paused でない会話の起こす結び付けを消す。sessionId を省くと全部の会話を見る（起動のときの片付け）。消した数を返す。 */
export function dropStaleWakes(db: Db, sessionId?: string, now: number = Date.now()): number {
  let dropped = 0;
  const paused = new Map<string, boolean>();
  for (const b of listBindings(db)) {
    if (b.action.kind !== 'wake') continue;
    const sid = b.action.sessionId;
    if (sessionId !== undefined && sid !== sessionId) continue;
    if (!paused.has(sid)) paused.set(sid, getSessionState(db, sid)?.status === 'paused');
    if (!paused.get(sid) && deleteBinding(db, b.id, now)) dropped++;
  }
  return dropped;
}

/**
 * 会話の状態の行の変化を見張る。
 * この PC で書いたもの（write）も、同期で降りてきたもの（apply）も拾う。
 * 結び付けを消したら onDropped を呼ぶ（webhook と受け箱の後片付けを頼む）。
 * 戻り値を呼ぶと見張りをやめる。
 */
export function watchWakeScope(db: Db, onDropped: () => void, onError?: (e: unknown) => void): () => void {
  return onRowChange((c) => {
    if (c.db !== db || c.table !== 'session_states' || c.origin === 'touch') return;
    try {
      if (dropStaleWakes(db, c.rowId) > 0) onDropped();
    } catch (e) {
      onError?.(e);
    }
  });
}
