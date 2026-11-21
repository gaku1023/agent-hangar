/**
 * いま前に出して見ている会話（2026-11-21）。この PC の画面の分と、ほかの PC の分（live/viewingShare.ts）を合わせて見る。
 *
 * 画面（ui/src/runtime/runtime.ts）は、窓が見えていて前面にあり、会話の画面を開いているとき、その会話の id を送る（POST /api/viewing）。
 * 窓が裏に回ったか、会話の画面を離れたら null を送る。見ている間は VIEWING_HEARTBEAT_MS ごとに送り直す。
 * 送り直しが VIEWING_TTL_MS 途切れたら（窓を閉じた、画面が落ちた）、見ていないとみなす。
 *
 * 見ている会話には、未読を積まず、OS にもスマホにも知らせない。返答はその場で見えているからである。
 * どちらかの PC で見ていれば、どちらの PC からも出さない（2026-11-21）。
 * 画面は複数ありうる（アプリの窓とブラウザ）ので、画面ごとの鍵（client）で持つ。
 */

export const VIEWING_HEARTBEAT_MS = 30_000;
export const VIEWING_TTL_MS = 75_000;
const MAX_CLIENTS = 32;

const clients = new Map<string, { sessionId: string; at: number }>();
const changeListeners = new Set<() => void>();
let remote: (sessionId: string, now: number) => boolean = () => false;

/** 画面 client がいま見ている会話を置く。null は見ていない。この PC で見ている会話の組が変わったら購読へ知らせる。 */
export function noteViewing(client: string, sessionId: string | null, now = Date.now()): void {
  const before = localViewing(now).join('\n');
  clients.delete(client);
  if (sessionId !== null) {
    // 鍵は画面が作るので、数を抑える。古いものから捨てる。
    while (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value as string);
    clients.set(client, { sessionId, at: now });
  }
  if (localViewing(now).join('\n') !== before) {
    for (const cb of changeListeners) {
      try { cb(); } catch (e) { console.error('[viewing] a listener failed', e instanceof Error ? e.constructor.name : typeof e); }
    }
  }
}

/** この PC の画面で、いま前に出して見ている会話（重なりなし、並べたもの）。送り直しの途切れた画面は捨てる。 */
export function localViewing(now = Date.now()): string[] {
  const out = new Set<string>();
  for (const [k, v] of clients) {
    if (now - v.at > VIEWING_TTL_MS) { clients.delete(k); continue; }
    out.add(v.sessionId);
  }
  return [...out].sort();
}

/** この PC で見ている会話の組が変わったことの購読。戻り値を呼ぶと外す。ほかの PC へ配る（live/viewingShare.ts）のに使う。 */
export function onLocalViewingChange(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
}

/** ほかの PC で見ているかの判定をつなぐ。起動（live/viewingShare.ts の ViewingShare.start）が db を閉じ込めて渡す。 */
export function setRemoteViewing(fn: (sessionId: string, now: number) => boolean): void {
  remote = fn;
}

/** どちらかの PC の画面が、いまその会話を前に出して見ているか。 */
export function isViewing(sessionId: string, now = Date.now()): boolean {
  if (localViewing(now).includes(sessionId)) return true;
  try {
    return remote(sessionId, now);
  } catch (e) {
    console.error('[viewing] could not read the other PCs', e instanceof Error ? e.message : e);
    return false;
  }
}

/** 試験のために覚えを消す。 */
export function resetViewing(): void {
  clients.clear();
  changeListeners.clear();
  remote = () => false;
}
