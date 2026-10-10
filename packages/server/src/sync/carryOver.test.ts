import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PULL_LIMIT, type ChangeIn } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { setSessionMemo } from '../sessions/notes.ts';
import { setSessionState } from '../sessions/states.ts';
import type { CloudClient } from './client.ts';
import { ORPHAN_KEEP_DAYS, SyncEngine } from './engine.ts';

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

const engine = (db: Db, device: string, over: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}): SyncEngine => {
  const e = new SyncEngine({ db, deviceId: device, client: device === 'a' ? cloud : cloud.asDevice(device), now: () => timers.now, timers, url: 'https://h', home: '/nonexistent-home', ...over });
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

const note = (s: string, updatedAt = 100, memo = 'メモ'): ChangeIn => ({ tableName: 'session_notes', rowId: s, op: 'upsert', updatedAt, payload: { session_id: s, name: null, memo, updated_at: updatedAt, deleted_at: null, origin_device: 'a' } });
const session = (s: string): ChangeIn => ({ tableName: 'sessions', rowId: s, op: 'upsert', updatedAt: 100, payload: { id: s, provider: 'claude-code', provider_session_id: `u-${s}`, cwd: '/w', home_device: 'a', updated_at: 100, deleted_at: null, origin_device: 'a' } });
const pushAll = async (all: ChangeIn[]) => { for (let i = 0; i < all.length; i += 40) await cloud.pushChanges(all.slice(i, i + 40)); };
const quiet = async (fn: (lines: () => string[]) => Promise<void>) => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { await fn(() => err.mock.calls.map((c) => c.join(' '))); } finally { err.mockRestore(); }
};

describe('持ち越しを抱えたまま落ちる', () => {
  it('差分の頁の途中でプロセスが落ちても、次の起動で持ち越した行が当たる', async () => {
    const b1 = engine(dbB, 'b');
    await b1.start();
    await b1.pullNow();
    // 1 頁目は子だけ、2 頁目に親が来る。
    await pushAll([...Array.from({ length: PULL_LIMIT }, (_, i) => note(id(i))), ...Array.from({ length: PULL_LIMIT }, (_, i) => session(id(i)))]);
    // 2 頁目を返さずに固まる相手。エンジンは 1 頁目を当てて区切りを進めた所で止まる。
    const real = cloud.asDevice('b');
    let pages = 0;
    let reached: () => void = () => {};
    const secondPage = new Promise<void>((r) => { reached = r; });
    const hanging = new Proxy(real, {
      get(target, prop, recv) {
        if (prop !== 'pullChanges') return Reflect.get(target, prop, recv) as unknown;
        return (since: number, limit: number) => {
          if (++pages >= 2) { reached(); return new Promise<never>(() => {}); }
          return target.pullChanges(since, limit);
        };
      },
    }) as CloudClient;
    const dying = engine(dbB, 'b', { client: hanging });
    void dying.pullNow();
    await secondPage;
    // ここでプロセスが落ちた。後片付け（finally）は走らない。区切りは 1 頁目の先に進んでいる。
    expect(Number((dbB.prepare("select value from sync_state where key = 'lastSeq'").get() as { value: string }).value)).toBeGreaterThan(0);
    expect(count(dbB, 'session_notes')).toBe(0);
    const b2 = engine(dbB, 'b');
    await b2.pullNow();
    expect(count(dbB, 'sessions')).toBe(PULL_LIMIT);
    expect(count(dbB, 'session_notes')).toBe(PULL_LIMIT);
  });

  it('当て直しが投げても、持ち越しは消えない', async () => {
    await quiet(async () => {
      await cloud.pushChanges([note('ghost')]);
      const b = engine(dbB, 'b');
      await b.start();
      await b.pullNow();
      // 当て直しの最中に DB が失敗する。この pull のトランザクションは、頁の適用が 1 つ目、当て直しが 2 つ目である。
      const tx = dbB.transaction.bind(dbB) as (fn: () => void) => unknown;
      let calls = 0;
      const spy = vi.spyOn(dbB, 'transaction').mockImplementation(((fn: () => void) => {
        if (++calls === 2) throw new Error('disk I/O error');
        return tx(fn);
      }) as never);
      await cloud.pushChanges([session('ghost')]);
      await b.pullNow();
      spy.mockRestore();
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(count(dbB, 'sessions')).toBe(1);
      expect(count(dbB, 'session_notes')).toBe(0);
      expect(dbB.prepare("select 1 from sync_state where key = 'orphans'").get()).toBeDefined();
      await b.pullNow();
      expect(count(dbB, 'session_notes')).toBe(1);
    });
  });
});

describe('持ち越した行と、新しい版', () => {
  it('持ち越した行より新しい版が先に当たっていたら、当て直しで古い版に戻らず、持ち越しも消える', async () => {
    await quiet(async () => {
      await cloud.pushChanges([note('ghost', 100, '古い版')]);
      const b = engine(dbB, 'b');
      await b.start();
      await b.pullNow();
      expect(dbB.prepare("select 1 from sync_state where key = 'orphans'").get()).toBeDefined();
      // 親と新しい版は、この PC が自分で書いた（降りてくる道を通らない）。
      upsertShared(dbB, 'sessions', { id: 'ghost', provider: 'claude-code', provider_session_id: 'u-ghost', cwd: '/w', home_device: 'b' }, 'b');
      setSessionMemo(dbB, 'b', 'ghost', '新しい版');
      await b.pullNow();
      expect(dbB.prepare('select memo from session_notes where session_id = ?').get('ghost')).toEqual({ memo: '新しい版' });
      expect(dbB.prepare("select 1 from sync_state where key = 'orphans'").get()).toBeUndefined();
    });
  });
});

describe('親が現れない行の寿命', () => {
  it(`${ORPHAN_KEEP_DAYS} 日たったら捨てて、記録に 1 行出す。それまでは覚えている`, async () => {
    await quiet(async (lines) => {
      expect(ORPHAN_KEEP_DAYS).toBe(30);
      await cloud.pushChanges([note('ghost')]);
      const b = engine(dbB, 'b');
      await b.start();
      await b.pullNow();
      timers.now += (ORPHAN_KEEP_DAYS - 1) * 86_400_000;
      await b.pullNow();
      expect(dbB.prepare("select 1 from sync_state where key = 'orphans'").get()).toBeDefined();
      timers.now += 2 * 86_400_000;
      await b.pullNow();
      expect(dbB.prepare("select 1 from sync_state where key = 'orphans'").get()).toBeUndefined();
      expect(lines().filter((l) => l.includes(`${ORPHAN_KEEP_DAYS} 日`) && l.includes('1 件'))).toHaveLength(1);
      // 捨てた後に親が届いても、もう当たらない。
      await cloud.pushChanges([session('ghost')]);
      await b.pullNow();
      expect(count(dbB, 'session_notes')).toBe(0);
    });
  });
});

describe('持ち越しの上限を超えたとき', () => {
  /** 版 17 の写しと同じく、時刻が 1 の名前とメモ。いちばん古い時刻なので、古い順に捨てると真っ先に消える。 */
  const copies = Array.from({ length: 30 }, (_, i) => note(id(i), 1, `メモ ${i}`));
  const parents = Array.from({ length: 30 }, (_, i) => session(id(i)));

  it('行を捨てずに、最初の写しをやり直す。やり直しで名前とメモが全部届く', async () => {
    await quiet(async () => {
      const b = engine(dbB, 'b', { maxCarriedRows: 10 });
      await b.start();
      await b.pullNow();
      // 子だけが先に差分で降りる。親はまだクラウドに無い。
      await pushAll(copies);
      await b.pullNow();
      expect(count(dbB, 'session_notes')).toBe(0);
      expect(dbB.prepare("select value from sync_state where key = 'snapshotDone'").get()).toBeUndefined();
      // 上限を超えても、持ち越した行は捨てていない。
      expect((JSON.parse((dbB.prepare("select value from sync_state where key = 'orphans'").get() as { value: string }).value) as unknown[]).length).toBe(30);
      await pushAll(parents);
      await b.pullNow();
      expect(count(dbB, 'sessions')).toBe(30);
      expect(count(dbB, 'session_notes')).toBe(30);
      expect(dbB.prepare("select value from sync_state where key = 'snapshotDone'").get()).toEqual({ value: '1' });
    });
  });

  it('やり直しは 1 回の起動につき 1 度まで。それでも超えたら古い順に捨てて記録に出し、名前とメモは最後に捨てる', async () => {
    await quiet(async (lines) => {
      const b = engine(dbB, 'b', { maxCarriedRows: 10 });
      await b.start();
      await b.pullNow();
      const run = (i: number): ChangeIn => ({ tableName: 'runs', rowId: `r${i}`, op: 'upsert', updatedAt: 5000 + i, payload: { id: `r${i}`, session_id: `nope${i}`, device_id: 'a', kind: 'start', tmux_name: 't', pid: null, launch_params: '{}', started_at: 1, ended_at: 2, end_reason: 'exit', heartbeat_at: 1, updated_at: 5000 + i, deleted_at: null, origin_device: 'a' } });
      // 親が永久に現れない行だけがクラウドにある。写しをやり直しても、そろわない。
      await pushAll([...copies.slice(0, 8), ...Array.from({ length: 8 }, (_, i) => run(i))]);
      await b.pullNow();
      expect(dbB.prepare("select value from sync_state where key = 'snapshotDone'").get()).toBeUndefined();
      await b.pullNow();
      // やり直した後も超えているので、今度は捨てる。輪にならないよう、写しの印は付いたままである。
      expect(dbB.prepare("select value from sync_state where key = 'snapshotDone'").get()).toEqual({ value: '1' });
      const kept = (JSON.parse((dbB.prepare("select value from sync_state where key = 'orphans'").get() as { value: string }).value) as { c: { tableName: string } }[]).map((x) => x.c.tableName);
      expect(kept).toHaveLength(10);
      expect(kept.filter((t) => t === 'session_notes')).toHaveLength(8);
      expect(lines().some((l) => l.includes('上限') && l.includes('6 件'))).toBe(true);
      await b.pullNow();
      expect(dbB.prepare("select value from sync_state where key = 'snapshotDone'").get()).toEqual({ value: '1' });
    });
  });
});
