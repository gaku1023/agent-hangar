/**
 * 本文と設定の出し入れ、他端末の本文の取り込み、使用量の取りに行きを止めるか。
 * 互換の版で止まっているときは、利用者が頼んだ 1 巡の最中でも止める（その 1 巡のメタデータの送受信が先に試し直し、まだ合わなければまた止まっている）。
 * 上限で退いている間も、利用者が頼んだ 1 巡の最中でも止める（その 1 巡のメタデータの送受信が先に試し直し、まだ上限ならまた退いている）。
 * この PC が同期から解除されている間も、1 巡の最中でも止める（参加し直すまで、どの要求も 401 で断られる）。
 * 一時停止のあいだは止めるが、利用者が「今すぐ同期」で頼んだ 1 巡の最中だけは通す（PausedPass）。
 */
export function syncHalted(o: { paused: boolean; oncePass: boolean; compatBlocked: boolean; limited: boolean; revoked?: boolean }): boolean {
  return o.compatBlocked || o.revoked === true || o.limited || (o.paused && !o.oncePass);
}
