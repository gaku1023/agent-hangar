import type { NotifyKind } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

export type UnreadRow = { count: number; latest: string | null; at: number };


/**
 * 未読は session_states の 1 つの事実として 2 台で同期する（版 67、2026-11-21）。時刻の列は unread_changed_at で、取り込みは事実ごとの後勝ち（sync/apply.ts の mergeFacts）。
 * 積むのは会話を動かしている PC（notify_user、ターンの終わりの受け皿、預かり）、既読と未読に戻すのはどちらの PC でもよい。どちらで既読にしても両方で既読になる。
 * 書き込みは急ぐ（db/shared.ts の isUrgentWrite）。呼び鈴でもう 1 台に 2 秒以内に届く。
 */
const UNREAD_COLS = ['unread_count', 'unread_text', 'unread_at', 'unread_kind', 'unread_device'] as const;

/** 書き手の PC の ID。起動のときに bindUnreadDevice で結ぶ。呼び方（addUnread の引数）を変えずに同期の書き込みにするためである。 */
const devices = new WeakMap<Db, string>();

/**
 * この DB に書く PC の ID を結ぶ（boot で 1 回）。結ばれていない DB（試験）は 'local' として書く。
 */
export function bindUnreadDevice(db: Db, deviceId: string): void {
  devices.set(db, deviceId);
}

const deviceOf = (db: Db): string => devices.get(db) ?? 'local';

type UnreadCols = { unread_count: number | null; unread_text: string | null; unread_at: number | null; unread_kind: string | null; unread_device: string | null; unread_changed_at: number | null; updated_at: number };

const unreadCols = (db: Db, sessionId: string) => db.prepare(`select ${UNREAD_COLS.join(', ')}, unread_changed_at, updated_at from session_states where session_id = ?`).get(sessionId) as UnreadCols | undefined;
const sessionExists = (db: Db, sessionId: string): boolean => db.prepare('select 1 from sessions where id = ?').get(sessionId) !== undefined;

/**
 * 未読の列だけを書く。ほかの事実の列には触れない（行が無ければ、状態の無い Active の行を作る）。
 * 事実の時刻は at と、手元の時刻より 1 だけ後の遅い方にする。見てから書いた変更が、時計の進んだ PC の行に負けないためである（setSessionPinned と同じ）。
 */
function writeUnread(db: Db, sessionId: string, cols: Record<(typeof UNREAD_COLS)[number], unknown>, at: number, cur: UnreadCols | undefined): void {
  const stamp = Math.max(at, (cur?.unread_changed_at ?? 0) + 1, (cur?.updated_at ?? 0) + 1);
  upsertShared(db, 'session_states', { session_id: sessionId, ...cols, unread_changed_at: stamp }, deviceOf(db), 'session_id', stamp);
}

/** ミュートした会話か（session_states.muted_at）。sessions/states.ts の isSessionMuted と同じ読み方で、循環の import を避けて ここに置く。 */
function mutedRow(db: Db, sessionId: string): boolean {
  const r = db.prepare('select muted_at from session_states where session_id = ? and deleted_at is null').get(sessionId) as { muted_at: number | null } | undefined;
  return (r?.muted_at ?? null) !== null;
}

/**
 * 未読を 1 つ積む。count を 1 つ増やし、最後の本文と時刻と場面を置き換える。戻り値は積んだ後の count である。
 * 会話の行が無い id には積まず、0 を返す。
 * o.kind は知らせの場面で、受け取った PC が自分の知らせ方の決まりを引くのに使う（live/unreadArrive.ts）。省けば done。
 */
export function addUnread(db: Db, sessionId: string, text: string, now: number, o: { kind?: NotifyKind } = {}): number {
  if (!sessionExists(db, sessionId)) return 0;
  // ミュートした会話（静かな会話）には積まない。どの道（notify_user、ターンの終わり、預かり、別の PC の問い）から来ても、ここで 1 か所で止める。
  if (mutedRow(db, sessionId)) return 0;
  const cur = unreadCols(db, sessionId);
  const count = (cur?.unread_count ?? 0) + 1;
  writeUnread(db, sessionId, { unread_count: count, unread_text: text, unread_at: now, unread_kind: o.kind ?? 'done', unread_device: deviceOf(db) }, now, cur);
  return count;
}

/**
 * 利用者が未読に戻す。未読が無いときだけ 1 にし、エージェントの知らせではないので本文も場面も持たない。
 * すでに未読があれば、数も本文も変えない。OS とスマホへは知らせない（noteUnread を呼ばない。届いた PC も鳴らさない）。
 */
export function markUnread(db: Db, sessionId: string, now: number): void {
  if (!sessionExists(db, sessionId)) return;
  const cur = unreadCols(db, sessionId);
  if ((cur?.unread_count ?? 0) > 0) return;
  writeUnread(db, sessionId, { unread_count: 1, unread_text: null, unread_at: now, unread_kind: null, unread_device: deviceOf(db) }, now, cur);
}

/** 既読にする。未読が無ければ何もせず、false を返す（画面へも配らず、同期にも載せない）。 */
export function markSeen(db: Db, sessionId: string, now = Date.now()): boolean {
  const cur = unreadCols(db, sessionId);
  if (!cur || (cur.unread_count ?? 0) <= 0) return false;
  writeUnread(db, sessionId, { unread_count: null, unread_text: null, unread_at: null, unread_kind: null, unread_device: null }, now, cur);
  return true;
}

/** 会話ごと片付けるときに、未読の列を手元だけで空にする（sessions/trash.ts）。削除の印は別に同期するので、ここは押し上げない。 */
export function forgetUnread(db: Db, sessionId: string): void {
  db.prepare(`update session_states set ${UNREAD_COLS.map((c) => `${c} = null`).join(', ')} where session_id = ?`).run(sessionId);
}

/** 今の未読。無ければ null。kind は最後の知らせの場面（未読に戻したものは null）、device は数えた PC。 */
export function readUnread(db: Db, sessionId: string): (UnreadRow & { kind: NotifyKind | null; device: string | null }) | null {
  const cur = unreadCols(db, sessionId);
  if (!cur || (cur.unread_count ?? 0) <= 0) return null;
  return { count: cur.unread_count!, latest: cur.unread_text, at: cur.unread_at ?? 0, kind: (cur.unread_kind as NotifyKind | null) ?? null, device: cur.unread_device };
}

type ArrivedListener = (db: Db, sessionId: string) => void;
const arrivedListeners = new Set<ArrivedListener>();

/**
 * ほかの PC が積んだ未読が同期で届いたときの購読（sync/apply.ts の applyRemoteBatch が、確定の後に呼ぶ）。戻り値を呼ぶと外す。
 * 数が増え、場面のある（未読に戻したのではない）行だけが来る。鳴らすかは聞く側が決める（live/unreadArrive.ts）。
 */
export function onUnreadArrived(cb: ArrivedListener): () => void {
  arrivedListeners.add(cb);
  return () => { arrivedListeners.delete(cb); };
}

/** 届いた未読を購読へ渡す。購読が投げても、取り込みにも他の購読にも波及させない。 */
export function noteUnreadArrived(db: Db, sessionId: string): void {
  for (const cb of arrivedListeners) {
    try { cb(db, sessionId); } catch (e) { console.error('[unread] a listener failed', e instanceof Error ? e.constructor.name : typeof e); }
  }
}

/** 未読の列を DTO の形にする。count が 1 以上のときだけ返し、無ければ null。 */
export function unreadOf(row: { unread_count: number | null; unread_text: string | null; unread_at: number | null; unread_device?: string | null }, self?: string): (UnreadRow & { elsewhere?: true }) | null {
  if (row.unread_count === null || row.unread_count <= 0) return null;
  // ほかの PC が数えた未読には印を付ける。設定 sidebarOtherPcs が切なら、画面は数えない（ui の store.ts の unreadSessionIds）。
  const elsewhere = self !== undefined && row.unread_device != null && row.unread_device !== self;
  return { count: row.unread_count, latest: row.unread_text, at: row.unread_at ?? 0, ...(elsewhere ? { elsewhere: true as const } : {}) };
}

/** notify_user の出し先。unread は未読の数、os は OS の通知、phone はスマホの通知。 */
export const NOTIFY_TARGETS = ['unread', 'os', 'phone'] as const;
export type NotifyTarget = (typeof NOTIFY_TARGETS)[number];

/**
 * 知らせの添え書き。kind は場面（done、ask、progress）。
 * immediate は、ターンの終わりを待たずに出す印である。エージェントの notify_user ではなく、hangar が代わりに知らせるもの（承認待ち、起動の失敗）に付ける。
 * unreadHeld は、未読の数をまだ積んでいない印である。積むのは預かり（live/unreadHold.ts）で、ターンを抜けたときに積む（2026-11-11）。
 */
export type UnreadMeta = { kind: NotifyKind; immediate?: boolean; unreadHeld?: boolean };
type UnreadListener = (sessionId: string, text: string, count: number, sent: NotifyTarget[], meta: UnreadMeta) => void;
const unreadListeners = new Set<UnreadListener>();
const readyListeners = new Set<UnreadListener>();

/**
 * 未読が増えたときの購読を足す。戻り値を呼ぶと外す。
 * 知らせるのは書いた側（mcp/tools.ts の notifyUserTool）で、addUnread の後に noteUnread を呼ぶ。onIntent と同じ形である。
 * OS の通知とスマホの通知はこれを直に聞かず、ターンの終わりまで預かった後の onUnreadReady を聞く（live/unreadHold.ts）。
 */
export function onUnread(cb: UnreadListener): () => void {
  unreadListeners.add(cb);
  return () => { unreadListeners.delete(cb); };
}

/**
 * OS の通知とスマホの通知に出してよくなった知らせの購読。戻り値を呼ぶと外す。
 * notify_user は最後の返答を書く前に呼ばれるので、done と ask はそのターンが終わるまで預かってから流れてくる（live/unreadHold.ts の UnreadHold）。
 */
export function onUnreadReady(cb: UnreadListener): () => void {
  readyListeners.add(cb);
  return () => { readyListeners.delete(cb); };
}

const mutedGuards = new Set<(sessionId: string) => boolean>();

/**
 * noteUnread の入口の守りを足す。真を返した会話の知らせは購読へ渡さない。戻り値を呼ぶと外す。
 * noteUnread は db を持たないので、起動（boot/runs.ts）が db を閉じ込めた判定（isSessionMuted）を渡す。
 */
export function guardMutedUnread(muted: (sessionId: string) => boolean): () => void {
  mutedGuards.add(muted);
  return () => { mutedGuards.delete(muted); };
}

const fire = (set: Set<UnreadListener>, sessionId: string, text: string, count: number, sent: NotifyTarget[], meta: UnreadMeta): void => {
  for (const cb of set) {
    try { cb(sessionId, text, count, sent, meta); } catch (e) { console.error('[unread] a listener failed', e instanceof Error ? e.constructor.name : typeof e); }
  }
};

/** 知らせを購読へ渡す。sent は設定を通って実際に出す先で、購読者は os と phone を見て送る。count は積んだ後の数（unread を出さなかったときは今の数）。購読が投げても、書いた側にも他の購読にも波及させない。 */
export function noteUnread(sessionId: string, text: string, count: number, sent: NotifyTarget[], meta: UnreadMeta = { kind: 'done' }): void {
  // ミュートした会話（静かな会話）の知らせは、OS とスマホへの預かり（UnreadHold）にも渡さない。
  for (const muted of mutedGuards) if (muted(sessionId)) return;
  fire(unreadListeners, sessionId, text, count, sent, meta);
}

/** 出してよくなった知らせを onUnreadReady の購読へ渡す。呼ぶのは預かり（UnreadHold）と、返答の終わりの数え（NotifyFallback）である。 */
export function noteUnreadReady(sessionId: string, text: string, count: number, sent: NotifyTarget[], meta: UnreadMeta = { kind: 'done' }): void {
  // 預かっている間にミュートされた会話も、出す前に止める。
  for (const muted of mutedGuards) if (muted(sessionId)) return;
  fire(readyListeners, sessionId, text, count, sent, meta);
}
