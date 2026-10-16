import type { CloudPeer } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';

/**
 * 他の PC がこの長さより前から Worker に現れていなければ、その PC の run を古い（応答がない）とみなす（同期の版 6）。
 * Worker は最終確認（devices.last_seen_at）を 1 分おきにしか書かず、端末は 30 秒ごとに pull するので、生きている PC の年齢は 2 分ほどまで伸びる。
 * それより長く、取り違えない幅を取って 3 分にする。
 */
export const PEER_STALE_MS = 180_000;

/**
 * 1 台の PC について覚えていること。
 * lastSeenAt は Worker の時計の値で、変わったかどうか（画面へ配り直すか）だけに使う。
 * seenAt は、その時刻をこの PC の時計に置き直した値である。年齢と画面の「最終接続」はこちらで数える。
 * どちらも、Worker がまだその PC を見ていなければ null である。
 */
export type PeerSeen = { lastSeenAt: number | null; seenAt: number | null };
/** 鍵は端末 ID。null は、まだ一度も pull の応答を受け取っていないことを表す。 */
export type PeerBook = Map<string, PeerSeen>;

const KEY = 'peers';

/**
 * 最後に受け取った peers を読む。
 * 置き場は sync_state（端末ローカル、共有の changes に積まない）である。
 * プロセスを立て直しても残り、次の pull までは、受け取った時刻からこの PC の時計で歳を取り続ける。
 * 起動直後の最初の pull までは、止まっていた間の分だけ古く見える（版 5 までの heartbeat の行と同じふるまい）。
 */
export function readPeers(db: Db): PeerBook | null {
  return readRecord(db)?.book ?? null;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** 覚えの全体。at は受け取った時刻（この PC の時計）で、前の回の生死をその時刻で数え直すために持つ。 */
function readRecord(db: Db): { at: number; book: PeerBook } | null {
  const r = db.prepare('select value from sync_state where key = ?').get(KEY) as { value: string } | undefined;
  if (!r) return null;
  try {
    const v = JSON.parse(r.value) as { at?: unknown; peers?: Record<string, { lastSeenAt?: unknown; seenAt?: unknown }> } | null;
    const book: PeerBook = new Map();
    for (const [id, p] of Object.entries(v?.peers ?? {})) book.set(id, { lastSeenAt: num(p?.lastSeenAt), seenAt: num(p?.seenAt) });
    return { at: num(v?.at) ?? 0, book };
  } catch {
    return null;
  }
}

/** その PC の最終接続（この PC の時計）。知らなければ null。 */
export function peerSeenAt(book: PeerBook | null, deviceId: string): number | null {
  return book?.get(deviceId)?.seenAt ?? null;
}

/** その PC が古いか。受け取っていない、peers に居ない、Worker がまだ見ていない、年齢が PEER_STALE_MS を超えた、のどれでも古い。 */
export function peerStale(book: PeerBook | null, deviceId: string, now: number): boolean {
  const at = peerSeenAt(book, deviceId);
  return at === null || now - at > PEER_STALE_MS;
}

/**
 * pull の応答の peers を覚える。
 * 年齢は「Worker の now − lastSeenAt」で数え、受け取った時刻（この PC の時計）から引いて、この PC の時計の時刻に置き直す。
 * 2 つの Worker の時刻の差だけを使うので、PC どうしの時計のずれが入らない。
 *
 * 他の PC の生きた run を持つセッションのうち、その PC の生死が変わったものと、最終接続が進んだものを画面へ配り直す（touchRow）。
 * 生死は時間が経つだけでも変わる（最終接続が進まないまま 3 分を過ぎる）。その変わり目も、次の pull（30 秒ごと、一時停止中は 1 分ごと）で拾う。
 * 版 5 までは、他の PC の heartbeat の行が降りるたびに配り直していた。最終接続は Worker が 1 分おきにしか書かないので、配り直しもそれより増えない。
 */
export function recordPeers(db: Db, o: { selfDeviceId: string; peers: CloudPeer[]; workerNow: number; localNow: number }): void {
  const prev = readRecord(db);
  const before = prev?.book ?? null;
  const after: PeerBook = new Map();
  for (const p of o.peers) {
    if (typeof p?.id !== 'string') continue;
    const last = typeof p.lastSeenAt === 'number' && Number.isFinite(p.lastSeenAt) ? p.lastSeenAt : null;
    after.set(p.id, { lastSeenAt: last, seenAt: last === null ? null : o.localNow - Math.max(0, o.workerNow - last) });
  }
  db.prepare('insert into sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(KEY, JSON.stringify({ at: o.localNow, peers: Object.fromEntries(after) }));
  const runs = db.prepare('select distinct session_id, device_id from runs where ended_at is null and deleted_at is null and device_id <> ?').all(o.selfDeviceId) as { session_id: string; device_id: string }[];
  const touch = new Set<string>();
  for (const r of runs) {
    // 前の回の生死は、前の回に受け取った時刻で数える。画面が最後に受け取ったのはその時点の生死だからである。
    const flipped = peerStale(before, r.device_id, prev?.at ?? o.localNow) !== peerStale(after, r.device_id, o.localNow);
    const moved = (before?.get(r.device_id)?.lastSeenAt ?? null) !== (after.get(r.device_id)?.lastSeenAt ?? null);
    if (flipped || moved) touch.add(r.session_id);
  }
  for (const id of touch) touchRow(db, 'sessions', id);
}
