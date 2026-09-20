import fs from 'node:fs';
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
 * 床を 1 度だけ刻む。
 * 行が既にあれば何もしない。床が後ろへ動くと、まだ上げ切っていない本文が取り残されるからである。
 * 時刻として読めない値（0 以下、無限、NaN）を渡されたときは 0（床なし）を刻む。
 *
 * 呼び出し元は 2 つある。
 * 本筋は CLI で、クラウドの設定を作る（setup cloud）か参加する（join）ときに stampTranscriptsFrom が呼ぶ。
 * もう 1 つはサーバ起動時の保険で、床の無い cloud.json を見つけたときだけ効く。
 */
export function markTranscriptsFrom(state: SyncStateStore, floor: number): void {
  if (state.get(TRANSCRIPTS_FROM) !== null) return;
  state.set(TRANSCRIPTS_FROM, Number.isFinite(floor) && floor > 0 ? Math.floor(floor) : 0);
}

/**
 * クラウドを使い始めた時刻を home の索引に刻む。
 * cloud.json を書くのと同じ場所（setup cloud と join）から呼ぶ。
 *
 * 「使い始めた時刻」の本当の出どころはここである。
 * サーバ側の推測に任せると、床を刻まない古いサーバが先に起動した端末で床の無い隙が生まれる。
 * 実物では、その隙に入った新しいサーバが「もう同期した端末だ」と誤って判断し、
 * 上げないと決めた過去の本文を 105 件（148 MB）上げてしまった。
 *
 * 既に床があれば動かさないので、参加し直しても床は最初の参加のままである。
 * 戻り値は刻んだ後の床である。
 */
export function stampTranscriptsFrom(home: string, now: number): number {
  const db = openDb(dbPath(home));
  try {
    const state = new SyncStateStore(db);
    markTranscriptsFrom(state, now);
    return transcriptsFrom(state);
  } finally {
    db.close();
  }
}

/**
 * 床を home の索引から読む。
 * 索引がまだ無ければ 0（床なし）を返し、入れ物だけを作って帰ることはしない。
 * 「いまの床はどこか」を人に見せる道（hangar cloud status）のためにある。
 */
export function readTranscriptsFrom(home: string): number {
  const file = dbPath(home);
  if (!fs.existsSync(file)) return 0;
  const db = openDb(file);
  try {
    return transcriptsFrom(new SyncStateStore(db));
  } finally {
    db.close();
  }
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
