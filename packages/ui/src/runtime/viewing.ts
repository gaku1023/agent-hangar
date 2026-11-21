/**
 * いま前に出して見ている会話を、サーバへ知らせる（POST /api/viewing、server の live/viewing.ts）。
 *
 * サーバは、見ている会話には返答の終わりの未読を積まず、スマホへも知らせない。
 * 見ている会話は、窓が見えていて前面にあり、会話の画面を開いているときの、その会話である。ほかは null。
 * 変わったときに送り、見ている間は VIEWING_HEARTBEAT_MS ごとに送り直す（サーバは送り直しが途切れたら見ていないとみなす）。
 */

/** サーバの VIEWING_HEARTBEAT_MS と同じ。 */
export const VIEWING_HEARTBEAT_MS = 30_000;

export type ViewingReporterDeps = {
  /** いま見ている会話。見ていなければ null。 */
  current: () => string | null;
  send: (sessionId: string | null) => Promise<unknown>;
  setTimeout: (fn: () => void, ms: number) => unknown;
};

export function createViewingReporter(deps: ViewingReporterDeps) {
  let last: string | null = null;
  let gen = 0;
  let stopped = false;
  const send = (id: string | null) => { deps.send(id).catch(() => {}); };
  const report = (force = false): void => {
    if (stopped) return;
    const id = deps.current();
    if (!force && id === last) return;
    last = id;
    send(id);
    const g = ++gen;
    if (id !== null) deps.setTimeout(() => { if (g === gen) report(true); }, VIEWING_HEARTBEAT_MS);
  };
  return {
    /** 見ている会話が変わったかもしれないときに呼ぶ。変わっていなければ送らない。 */
    report: () => report(),
    /** 止める。見ていた会話があれば、見ていないと送る。 */
    stop: () => {
      if (stopped) return;
      gen++;
      if (last !== null) send(null);
      last = null;
      stopped = true;
    },
  };
}
