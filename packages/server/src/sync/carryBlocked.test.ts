import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeIn } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { SyncEngine } from './engine.ts';

/** 待っても当たらない持ち越しの行。毎回の pull で当て直すと、失敗の生成だけでサーバが約 1 秒止まっていた（#532）。 */

const remote: ChangeIn[] = [
  { tableName: 'session_notes', rowId: 'other-id', op: 'upsert', updatedAt: 100, payload: { session_id: 'other-id', name: 'メモ', updated_at: 100, deleted_at: null, origin_device: 'c' } },
];

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let err: ReturnType<typeof vi.spyOn>;
let engine: SyncEngine;

const count = (table: string) => (db.prepare(`select count(*) c from ${table}`).get() as { c: number }).c;
const logged = () => err.mock.calls.filter((c: unknown[]) => c.join(' ').includes('当てられなかった行が')).length;

beforeEach(async () => {
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'a' });
  timers = new FakeTimers();
  upsertShared(db, 'sessions', { id: 'local-id', provider: 'claude-code', provider_session_id: 'same', cwd: '/w', home_device: 'b' }, 'b');
  await cloud.pushChanges(remote);
  engine = new SyncEngine({ db, deviceId: 'b', client: cloud.asDevice('b'), now: () => timers.now, timers, url: 'https://h', home: '/nonexistent-home' });
  await engine.start();
  await engine.pullNow();
});
afterEach(() => { engine.stop(); err.mockRestore(); });

describe('待っても当たらない行', () => {
  it('親の行が手元に無いとき、次の pull から当て直さない', async () => {
    expect(count('session_notes')).toBe(0);
    const prepare = vi.spyOn(db, 'prepare');
    await engine.pullNow();
    await engine.pullNow();
    const inserts = prepare.mock.calls.filter((c) => /^insert into (sessions|session_notes)\b/.test(String(c[0])));
    prepare.mockRestore();
    expect(inserts).toHaveLength(0);
  });

  it('捨てずに覚えておき、記録は数が変わるまで繰り返さない', async () => {
    const before = logged();
    expect(before).toBe(1);
    await engine.pullNow();
    await engine.pullNow();
    expect(logged()).toBe(before);
    expect(db.prepare("select 1 from sync_state where key = 'orphans'").get()).toBeDefined();
  });

  it('親の行が届いたら、子も当たる', async () => {
    await cloud.pushChanges([{ tableName: 'sessions', rowId: 'other-id', op: 'upsert', updatedAt: 100, payload: { id: 'other-id', provider: 'claude-code', provider_session_id: 'other', cwd: '/w', home_device: 'c', updated_at: 100, deleted_at: null, origin_device: 'c' } }]);
    await engine.pullNow();
    expect(db.prepare('select name from session_notes where session_id = ?').get('other-id')).toEqual({ name: 'メモ' });
    expect(db.prepare("select 1 from sync_state where key = 'orphans'").get()).toBeUndefined();
  });

  it('未送信を数える問い合わせは、未送信だけの索引を使う', () => {
    const plan = db.prepare('explain query plan select count(*) c from changes where pushed_at is null').all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('changes_unpushed');
  });
});
