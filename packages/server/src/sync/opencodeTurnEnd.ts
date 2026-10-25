import type { OpencodeEventListener } from '../provider/opencode/live.ts';

/**
 * opencode のターンの終わりを表す出来事。作業（execution）の終わりで、成功、失敗、中断のどれでもよい。
 * 状態の面（provider/opencode/live.ts）が作業中を外すのと同じ出来事である。
 */
export const OPENCODE_TURN_ENDED: ReadonlySet<string> = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

/**
 * opencode の本文を上げる契機のうち、ターンの終わり（docs/design.md「opencode の本文の同期」）。
 *
 * opencode の本文は opencode の SQLite にあり、Claude のように本文のファイルの変化を見張れない。
 * そこで serve の出来事の流れ（live.ts の onEvent）からターンの終わりを拾い、上げる側の待ち行列に入れる。
 * 書き出しと上げ直しの間隔は上げる側（sync/uploader.ts の noteOpencode）が持つ。ここでは書き出さない。
 * run の終わりの契機は Claude と同じ sync/flushOnRunEnd.ts で、会話の ID で flushSession を 2 回呼ぶ。
 *
 * 上げる側はその都度引く。同期を設定していない間（null）と、設定が現れて組み直した後の両方で、同じ受け手が使えるようにするためである。
 * 戻り値は受け手を外す関数である。
 */
export function uploadOnOpencodeTurnEnd(
  events: (cb: OpencodeEventListener) => () => void,
  uploader: () => { noteOpencode(sessionId: string): void } | null,
): () => void {
  return events((providerSessionId, type) => {
    if (!OPENCODE_TURN_ENDED.has(type)) return;
    uploader()?.noteOpencode(providerSessionId);
  });
}
