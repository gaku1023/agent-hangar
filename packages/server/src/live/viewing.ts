/**
 * この PC の画面がいま前に出して見ている会話（2026-11-21）。
 *
 * 画面（ui/src/runtime/runtime.ts）は、窓が見えていて前面にあり、会話の画面を開いているとき、その会話の id を送る（POST /api/viewing）。
 * 窓が裏に回ったか、会話の画面を離れたら null を送る。見ている間は VIEWING_HEARTBEAT_MS ごとに送り直す。
 * 送り直しが VIEWING_TTL_MS 途切れたら（窓を閉じた、画面が落ちた）、見ていないとみなす。
 *
 * 見ている会話には、未読を積まず、スマホへも知らせない。返答はその場で見えているからである。
 * OS の通知は殻が窓の前後で決める（知らせ方の whileFocused）ので、ここでは止めない。
 * 画面は複数ありうる（アプリの窓とブラウザ）ので、画面ごとの鍵（client）で持つ。
 */

export const VIEWING_HEARTBEAT_MS = 30_000;
export const VIEWING_TTL_MS = 75_000;
const MAX_CLIENTS = 32;

const clients = new Map<string, { sessionId: string; at: number }>();

/** 画面 client がいま見ている会話を置く。null は見ていない。 */
export function noteViewing(client: string, sessionId: string | null, now = Date.now()): void {
  clients.delete(client);
  if (sessionId === null) return;
  // 鍵は画面が作るので、数を抑える。古いものから捨てる。
  while (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value as string);
  clients.set(client, { sessionId, at: now });
}

/** どれかの画面が、いまその会話を前に出して見ているか。 */
export function isViewing(sessionId: string, now = Date.now()): boolean {
  for (const [k, v] of clients) {
    if (now - v.at > VIEWING_TTL_MS) { clients.delete(k); continue; }
    if (v.sessionId === sessionId) return true;
  }
  return false;
}

/** 試験のために覚えを消す。 */
export function resetViewing(): void {
  clients.clear();
}
