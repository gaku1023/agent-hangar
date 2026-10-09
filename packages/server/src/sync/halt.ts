/**
 * Claude Code 設定の同期が外と話してよいか。
 * 切っているときはもちろん、一時停止のあいだも押し出さない。
 * 「一時停止」は外と話すのをやめることで、Cloudflare の上限で退いている間も同じである（そのあいだの状態は paused で、isPaused に出る）。
 * 利用者が「今すぐ同期」で頼んだ 1 巡の最中は、呼び手が paused を false にして渡す（boot/sync.ts の isPaused）。
 * `ClaudeConfigSync` は `enabled()` しか見ないので、判定はこちらで組み立てて渡す。
 */
export function configSyncActive(o: { syncClaudeConfig: boolean; paused: boolean }): boolean {
  return o.syncClaudeConfig && !o.paused;
}

/**
 * 本文と設定の出し入れ、他端末の本文の取り込み、使用量の取りに行きを止めるか。
 * 互換の版で止まっているときは、利用者が頼んだ 1 巡の最中でも止める（その 1 巡のメタデータの送受信が先に試し直し、まだ合わなければまた止まっている）。
 * 上限で退いている間も、利用者が頼んだ 1 巡の最中でも止める（その 1 巡のメタデータの送受信が先に試し直し、まだ上限ならまた退いている）。
 * 一時停止のあいだは止めるが、利用者が「今すぐ同期」で頼んだ 1 巡の最中だけは通す（PausedPass）。
 */
export function syncHalted(o: { paused: boolean; oncePass: boolean; compatBlocked: boolean; limited: boolean }): boolean {
  return o.compatBlocked || o.limited || (o.paused && !o.oncePass);
}
