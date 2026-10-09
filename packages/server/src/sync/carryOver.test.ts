import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PULL_LIMIT, type ChangeIn } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { setSessionMemo } from '../sessions/notes.ts';
import { setSessionState } from '../sessions/states.ts';
import { SyncEngine } from './engine.ts';

/**
 * 親の行より先に降りてきた子の行の持ち越し。
 *
 * 最初の写し（GET /rows）は鍵の辞書順で頁ごとに降りる。
 * `runs:`、`session_notes:`、`session_states:`、`session_summaries:` は、どれも親の `sessions:` より前に並ぶ。
 * 親がまだ無い子の行は外部キーで落ちる。落ちた行を頁をまたいで持ち越し、最後に当て直す。
 */

const N = PULL_LIMIT + 100;
const id = (i: number) => `s${String(i).padStart(4, '0')}`;

let dbA: Db;
let dbB: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
const engines: SyncEngine[] = [];

beforeEach(() => {
  dbA = openDb(':memory:');
  dbB = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'a' });
  timers = new FakeTimers();
});
afterEach(() => { for (const e of engines.splice(0)) e.stop(); });

const engine = (db: Db, device: string): SyncEngine => {
  const e = new SyncEngine({ db, deviceId: device, client: device === 'a' ? cloud : cloud.asDevice(device), now: () => timers.now, timers, url: 'https://h', home: '/nonexistent-home' });
  engines.push(e);
  return e;
};
const count = (db: Db, table: string) => (db.prepare(`select count(*) c from ${table}`).get() as { c: number }).c;

/** 1 台目に N 本のセッションと、その子の行を作って上げる。 */
async function seedA(child: (sessionId: string, i: number) => void): Promise<void> {
  const a = engine(dbA, 'a');
  await a.start();
  dbA.transaction(() => {
    for (let i = 0; i < N; i++) {
      upsertShared(dbA, 'sessions', { id: id(i), provider: 'claude-code', provider_session_id: `u${i}`, cwd: '/w', home_device: 'a' }, 'a');
      child(id(i), i);
    }
  })();
  await a.pushNow();
  expect(cloud.rows.size).toBe(N * 2);
}

describe('最初の写しで、親より先に降りた子の行', () => {
  it(`${N} 本のセッションの名前とメモを、空の PC が全部受け取る`, async () => {
    await seedA((s, i) => setSessionMemo(dbA, 'a', s, `メモ ${i}`));
    const b = engine(dbB, 'b');
    await b.start();
    await b.pullNow();
    expect(count(dbB, 'sessions')).toBe(N);
    expect(count(dbB, 'session_notes')).toBe(N);
    expect((dbB.prepare('select memo from session_notes where session_id = ?').get(id(N - 1)) as { memo: string }).memo).toBe(`メモ ${N - 1}`);
    expect(b.status().error).toBeNull();
  });

  it('セッションの状態（session_states）も全部受け取る', async () => {
    await seedA((s) => { setSessionState(dbA, 'a', s, { status: 'done', setBy: 'user' }); });
    const b = engine(dbB, 'b');
    await b.start();
    await b.pullNow();
    expect(count(dbB, 'session_states')).toBe(N);
  });

  it('run（runs）も全部受け取る', async () => {
    await seedA((s, i) => upsertShared(dbA, 'runs', { id: `r${i}`, session_id: s, device_id: 'a', kind: 'start', tmux_name: `t${i}`, pid: null, launch_params: '{}', started_at: 1, ended_at: 2, end_reason: 'exit', heartbeat_at: 1 }, 'a'));
    const b = engine(dbB, 'b');
    await b.start();
    await b.pullNow();
    expect(count(dbB, 'runs')).toBe(N);
  });

  it('当てた行は、持ち越した分も含めて applied として知らせる', async () => {
    await seedA((s, i) => setSessionMemo(dbA, 'a', s, `メモ ${i}`));
    const b = engine(dbB, 'b');
    const applied: string[] = [];
    b.on({ applied: (c) => applied.push(`${c.tableName}:${c.rowId}`) });
    await b.start();
    await b.pullNow();
    expect(new Set(applied).size).toBe(N * 2);
  });
});

describe('差分の頁をまたぐ親子', () => {
  it('子が前の頁、親が後の頁に来ても、1 巡の終わりに当たる', async () => {
    const b = engine(dbB, 'b');
    await b.start();
    await b.pullNow();
    // 子を先に、親を頁の外に積む（親を書き直すと、親の方が後ろの連番になる）。
    const note = (s: string): ChangeIn => ({ tableName: 'session_notes', rowId: s, op: 'upsert', updatedAt: 100, payload: { session_id: s, name: null, memo: 'メモ', updated_at: 100, deleted_at: null, origin_device: 'a' } });
    const session = (s: string): ChangeIn => ({ tableName: 'sessions', rowId: s, op: 'upsert', updatedAt: 100, payload: { id: s, provider: 'claude-code', provider_session_id: `u-${s}`, cwd: '/w', home_device: 'a', updated_at: 100, deleted_at: null, origin_device: 'a' } });
    const all = [...Array.from({ length: N }, (_, i) => note(id(i))), ...Array.from({ length: N }, (_, i) => session(id(i)))];
    for (let i = 0; i < all.length; i += 40) await cloud.pushChanges(all.slice(i, i + 40));
    await b.pullNow();
    expect(count(dbB, 'sessions')).toBe(N);
    expect(count(dbB, 'session_notes')).toBe(N);
  });
});

describe('最後まで親が現れなかった行', () => {
  const orphan: ChangeIn = { tableName: 'session_notes', rowId: 'ghost', op: 'upsert', updatedAt: 100, payload: { session_id: 'ghost', name: null, memo: '親のいないメモ', updated_at: 100, deleted_at: null, origin_device: 'a' } };
  const parent: ChangeIn = { tableName: 'sessions', rowId: 'ghost', op: 'upsert', updatedAt: 100, payload: { id: 'ghost', provider: 'claude-code', provider_session_id: 'u-ghost', cwd: '/w', home_device: 'a', updated_at: 100, deleted_at: null, origin_device: 'a' } };

  it('黙って捨てず、数を記録に出し、同期は止めない。区切りは進める', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await cloud.pushChanges([orphan]);
      const b = engine(dbB, 'b');
      await b.start();
      await b.pullNow();
      expect(count(dbB, 'session_notes')).toBe(0);
      expect(b.status().error).toBeNull();
      expect(dbB.prepare("select value from sync_state where key = 'snapshotDone'").get()).toEqual({ value: '1' });
      const lines = err.mock.calls.map((c) => c.join(' '));
      expect(lines.some((l) => l.includes('親の行が無い') && l.includes('1 件') && l.includes('session_notes'))).toBe(true);
    } finally { err.mockRestore(); }
  });

  it('持ち越して覚えておき、後の pull で親が届いたら当てる', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await cloud.pushChanges([orphan]);
      const b = engine(dbB, 'b');
      await b.start();
      await b.pullNow();
      expect(count(dbB, 'session_notes')).toBe(0);
      // 親は後から、別の pull で届く。子はもう差分には載らない。
      await cloud.pushChanges([parent]);
      await b.pullNow();
      expect(dbB.prepare('select memo from session_notes where session_id = ?').get('ghost')).toEqual({ memo: '親のいないメモ' });
      // 当たったら、覚えを消す。
      expect(dbB.prepare("select 1 from sync_state where key = 'orphans'").get()).toBeUndefined();
    } finally { err.mockRestore(); }
  });

  it('覚えは再起動をまたぐ', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await cloud.pushChanges([orphan]);
      const b1 = engine(dbB, 'b');
      await b1.start();
      await b1.pullNow();
      b1.stop();
      await cloud.pushChanges([parent]);
      const b2 = engine(dbB, 'b');
      await b2.start();
      await b2.pullNow();
      expect(count(dbB, 'session_notes')).toBe(1);
    } finally { err.mockRestore(); }
  });
});
