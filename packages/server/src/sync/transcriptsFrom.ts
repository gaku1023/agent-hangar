import { dbPath } from '../config/paths.ts';
import { openDb } from '../db/open.ts';
import { SyncStateStore, type SyncStateKey } from './state.ts';

/**
 * 本文をどこから上げるかの床を覚える sync_state の鍵。
 *
 * 値はミリ秒の時刻で、取り残しの走査はこの時刻以降に動きのあった転記だけを拾う。
 * 0 は床なしで、手元の転記を全部拾う（この決まりが入る前と同じ振る舞いである）。
 *
 * メタデータ（セッションの一覧、要約、プロジェクト、TODO、メモ）はこの床を見ない。
 * 区切るのは本文だけである。
 */
export const TRANSCRIPTS_FROM: SyncStateKey = 'transcriptsFrom';

/**
 * 床を読む。
 * 行が無いときと、手で書き換えられて数として読めない値が入っているときは 0 にする。
 * 0 は床なしなので、読めない値のせいで本文が黙って上がらなくなることはない。
 */
export function transcriptsFrom(state: SyncStateStore): number {
  const v = state.getNumber(TRANSCRIPTS_FROM, 0);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * クラウドを使い始めた時刻を 1 度だけ刻む。
 * cloud.json を読めた起動のたびに呼ぶが、書くのは行が無い最初の 1 回だけである。
 *
 * cloud.json の joinedAt ではなくここで刻むのは、joinedAt が参加し直しと秘密の作り直しで
 * 今の時刻へ書き換わるからである。床が後ろへ動くと、まだ上げ切っていない本文が取り残される。
 *
 * 既にクラウドと同期していた端末には床を置かず、0（床なし）を刻む。
 * その端末は「走査が全部を拾う」約束で動いているので、途中で約束を変えない。
 * 同期したことがあるかどうかは、進み具合の lastSeq と filesSeq で見る。
 */
export function markTranscriptsFrom(state: SyncStateStore, now: number): void {
  if (state.get(TRANSCRIPTS_FROM) !== null) return;
  const joinedBefore = state.get('lastSeq') !== null || state.get('filesSeq') !== null;
  state.set(TRANSCRIPTS_FROM, joinedBefore ? 0 : now);
}

/**
 * 参加より前の本文も上げ直す道。
 * 床を 0（床なし）へ落とすだけなので、次の走査から手元の転記を全部拾うようになる。
 * 走査は床を 1 回ごとに読み直すので、サーバを立て直さなくても効く。
 * 戻り値は落とす前の床である（いつから上げていたかを利用者に見せるために返す）。
 */
export function backfillTranscripts(home: string): { from: number } {
  const db = openDb(dbPath(home));
  try {
    const state = new SyncStateStore(db);
    const from = transcriptsFrom(state);
    state.set(TRANSCRIPTS_FROM, 0);
    return { from };
  } finally {
    db.close();
  }
}
