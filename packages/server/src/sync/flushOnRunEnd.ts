import type { RunDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

/**
 * run の終了から 2 度目の flushSession までの待ち。
 * Claude は終了の直前まで本文に書き足すので、終了の直後の 1 回だけだと最後の数行が上がらない。
 */
export const FLUSH_AGAIN_MS = 5_000;

/**
 * run が終わったセッションの本文を、待たずに上げる受け手を作る。RunManager.on の runEnded に渡す。
 * 終了の直後に 1 回。Claude は終わる直前まで書き足すので、少し置いてもう 1 回上げ直す。
 * 同期を設定していない端末（uploader が null）では何もしない。
 */
export function flushOnRunEnded(o: { db: Db; uploader: { flushSession(uuid: string): Promise<void> } | null; againMs?: number }): (run: Pick<RunDto, 'sessionId'>) => void {
  return (r) => {
    const uuid = (o.db.prepare('select provider_session_id p from sessions where id = ?').get(r.sessionId) as { p: string } | undefined)?.p;
    if (!uuid) return;
    void o.uploader?.flushSession(uuid);
    const again = setTimeout(() => { void o.uploader?.flushSession(uuid); }, o.againMs ?? FLUSH_AGAIN_MS);
    again.unref();
  };
}
