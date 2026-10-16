import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { upsertShared } from '../db/shared.ts';
import { PEER_STALE_MS, peerSeenAt, peerStale, readPeers, recordPeers } from './peers.ts';

const SELF = 'dev-a';
const W = 5_000_000_000_000; // Worker の時計
const L = 1_700_000_000_000; // この PC の時計（Worker とずれている）

function seed(): Db {
  const db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'dev-b' }, 'dev-b');
  upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 'u2', cwd: '/w', home_device: SELF }, SELF);
  upsertShared(db, 'runs', { id: 'rb', session_id: 's1', device_id: 'dev-b', kind: 'start', tmux_name: 'hangar-rb', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'dev-b');
  upsertShared(db, 'runs', { id: 'ra', session_id: 's2', device_id: SELF, kind: 'start', tmux_name: 'hangar-ra', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, SELF);
  return db;
}

function touched(db: Db, fn: () => void): string[] {
  const seen: string[] = [];
  const off = onRowChange((c) => { if (c.db === db && c.origin === 'touch') seen.push(`${c.table}:${c.rowId}`); });
  try { fn(); } finally { off(); }
  return seen;
}

describe('他の PC の生存（pull の応答の peers）', () => {
  it('一度も受け取っていなければ、どの PC も古い', () => {
    const db = seed();
    expect(readPeers(db)).toBeNull();
    expect(peerStale(readPeers(db), 'dev-b', L)).toBe(true);
    expect(peerSeenAt(readPeers(db), 'dev-b')).toBeNull();
  });

  it('年齢は Worker の 2 つの時刻の差で数え、この PC の時計に置き直して持つ', () => {
    const db = seed();
    recordPeers(db, { selfDeviceId: SELF, peers: [{ id: 'dev-b', lastSeenAt: W - 40_000 }, { id: SELF, lastSeenAt: W }], workerNow: W, localNow: L });
    const book = readPeers(db);
    expect(peerSeenAt(book, 'dev-b')).toBe(L - 40_000);
    expect(peerStale(book, 'dev-b', L)).toBe(false);
    // ちょうど PEER_STALE_MS はまだ古くない。1 ms 過ぎたら古い。
    expect(peerStale(book, 'dev-b', L - 40_000 + PEER_STALE_MS)).toBe(false);
    expect(peerStale(book, 'dev-b', L - 40_000 + PEER_STALE_MS + 1)).toBe(true);
  });

  it('Worker の時計で未来の lastSeenAt は年齢 0 に丸める', () => {
    const db = seed();
    recordPeers(db, { selfDeviceId: SELF, peers: [{ id: 'dev-b', lastSeenAt: W + 5_000 }], workerNow: W, localNow: L });
    expect(peerSeenAt(readPeers(db), 'dev-b')).toBe(L);
  });

  it('lastSeenAt が null の PC と、peers に居ない PC は古い', () => {
    const db = seed();
    recordPeers(db, { selfDeviceId: SELF, peers: [{ id: 'dev-b', lastSeenAt: null }], workerNow: W, localNow: L });
    const book = readPeers(db);
    expect(peerStale(book, 'dev-b', L)).toBe(true);
    expect(peerStale(book, 'dev-c', L)).toBe(true);
  });

  it('覚えは sync_state に残り、立て直した後もこの PC の時計で歳を取る', () => {
    const db = seed();
    recordPeers(db, { selfDeviceId: SELF, peers: [{ id: 'dev-b', lastSeenAt: W }], workerNow: W, localNow: L });
    expect(db.prepare("select count(*) c from sync_state where key = 'peers'").get()).toEqual({ c: 1 });
    // 共有の changes には積まない。
    expect(db.prepare("select count(*) c from changes where table_name = 'sync_state'").get()).toEqual({ c: 0 });
    const later = readPeers(db);
    expect(peerStale(later, 'dev-b', L + 10 * 60_000)).toBe(true);
  });

  it('他の PC の生きた run のセッションを、生死が変わったときと最終接続が進んだときだけ配り直す', () => {
    const db = seed();
    // 初めて受け取って生きていると分かった。
    expect(touched(db, () => recordPeers(db, { selfDeviceId: SELF, peers: [{ id: 'dev-b', lastSeenAt: W }], workerNow: W, localNow: L }))).toEqual(['sessions:s1']);
    // 何も変わっていない。
    expect(touched(db, () => recordPeers(db, { selfDeviceId: SELF, peers: [{ id: 'dev-b', lastSeenAt: W }], workerNow: W + 30_000, localNow: L + 30_000 }))).toEqual([]);
    // 最終接続が進んだ。
    expect(touched(db, () => recordPeers(db, { selfDeviceId: SELF, peers: [{ id: 'dev-b', lastSeenAt: W + 60_000 }], workerNow: W + 60_000, localNow: L + 60_000 }))).toEqual(['sessions:s1']);
    // 最終接続は進まないまま、古くなった。
    expect(touched(db, () => recordPeers(db, { selfDeviceId: SELF, peers: [{ id: 'dev-b', lastSeenAt: W + 60_000 }], workerNow: W + 60_000 + PEER_STALE_MS + 1, localNow: L + 60_000 + PEER_STALE_MS + 1 }))).toEqual(['sessions:s1']);
  });
});
