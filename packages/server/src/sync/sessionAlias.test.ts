import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeIn } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/write.ts';
import { SyncEngine } from './engine.ts';

/** 同じ会話が PC ごとに別の ID を持つとき、届いた ID を手元の ID へ読み替える（#532）。 */

const OLD = 100;

const sessionRow = (over: Record<string, unknown> = {}, updatedAt = OLD): ChangeIn => ({
  tableName: 'sessions', rowId: 'other-id', op: 'upsert', updatedAt,
  payload: { id: 'other-id', provider: 'claude-code', provider_session_id: 'same', cwd: '/other-pc', home_device: 'c', first_prompt: '届いた発言', ai_title: '届いた題', started_at: 10, last_activity_at: 900, updated_at: updatedAt, deleted_at: null, origin_device: 'c', ...over },
});
const child = (tableName: 'session_summaries' | 'session_states' | 'session_notes', payload: Record<string, unknown>, updatedAt = OLD, rowId = 'other-id'): ChangeIn => ({
  tableName, rowId, op: 'upsert', updatedAt, payload: { session_id: rowId, updated_at: updatedAt, deleted_at: null, origin_device: 'c', ...payload },
});
const summary = (one_liner: string, updatedAt = OLD, rowId = 'other-id') => child('session_summaries', { title: '題', one_liner, body: '本文', state: 'done', next_steps: '[]', source: 'in_session', based_on_turns: 1 }, updatedAt, rowId);

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let err: ReturnType<typeof vi.spyOn>;
let engine: SyncEngine;
let localId: string;

const get = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
const unsent = () => (get('select count(*) c from changes where pushed_at is null') as { c: number }).c;

beforeEach(async () => {
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'a' });
  timers = new FakeTimers();
  timers.now = 1_000_000;
  // 行が届く前に手元の本文を索引すると、同じ会話に手元の ID ができる。
  localId = ensureSession(db, 'same', '/this-pc', 'b');
  db.prepare('update sessions set first_prompt = null, ai_title = ?, started_at = 50, last_activity_at = 500 where id = ?').run('手元の題', localId);
  engine = new SyncEngine({ db, deviceId: 'b', client: cloud.asDevice('b'), now: () => timers.now, timers, url: 'https://h', home: '/nonexistent-home' });
  await engine.start();
  await engine.pullNow();
});
afterEach(() => { engine.stop(); err.mockRestore(); });

describe('別の ID で届いた会話', () => {
  it('手元の行は ID も cwd も置き場の PC も変えず、足りない所だけ埋める', async () => {
    await cloud.pushChanges([sessionRow()]);
    await engine.pullNow();
    expect(get('select count(*) c from sessions')).toEqual({ c: 1 });
    expect(get('select id, cwd, home_device, first_prompt, started_at, last_activity_at from sessions')).toEqual({ id: localId, cwd: '/this-pc', home_device: 'b', first_prompt: '届いた発言', started_at: 10, last_activity_at: 900 });
    expect(get('select session_id from session_aliases where alias_id = ?', 'other-id')).toEqual({ session_id: localId });
  });

  it('子の行が親より先に届いても、手元の会話に当たり、持ち越しが残らない', async () => {
    await cloud.pushChanges([summary('ほかの PC の要約')]);
    await engine.pullNow();
    expect(get("select 1 x from sync_state where key = 'orphans'")).toBeDefined();
    await cloud.pushChanges([sessionRow()]);
    await engine.pullNow();
    expect(get('select one_liner from session_summaries where session_id = ?', localId)).toEqual({ one_liner: 'ほかの PC の要約' });
    expect(get("select 1 x from sync_state where key = 'orphans'")).toBeUndefined();
  });

  it('読み替えは上げ直さない', async () => {
    const before = unsent();
    await cloud.pushChanges([sessionRow(), summary('要約')]);
    await engine.pullNow();
    expect(unsent()).toBe(before);
  });

  it('寄せる前の削除の印と論理削除は手元の会話に当てない', async () => {
    await cloud.pushChanges([sessionRow({ deleted_at: 90 }), child('session_states', { status: 'done', trashed_at: 90 })]);
    await engine.pullNow();
    expect(get('select deleted_at from sessions where id = ?', localId)).toEqual({ deleted_at: null });
    expect(get('select status, trashed_at from session_states where session_id = ?', localId)).toEqual({ status: 'done', trashed_at: null });
  });

  it('寄せた後の削除の印は、ほかの PC で利用者が消したものとして当てる', async () => {
    await cloud.pushChanges([sessionRow()]);
    await engine.pullNow();
    const later = Date.now() + 1000;
    await cloud.pushChanges([child('session_states', { status: 'done', trashed_at: later }, later)]);
    await engine.pullNow();
    expect(get('select trashed_at from session_states where session_id = ?', localId)).toEqual({ trashed_at: later });
    expect(get('select deleted_at from sessions where id = ?', localId)).toEqual({ deleted_at: later });
  });

  it('手元の方が新しい行は残す', async () => {
    upsertShared(db, 'session_notes', { session_id: localId, name: '手元の名前' }, 'b', 'session_id', 5000);
    await cloud.pushChanges([sessionRow(), child('session_notes', { name: '古い名前' }, 200)]);
    await engine.pullNow();
    expect(get('select name from session_notes where session_id = ?', localId)).toEqual({ name: '手元の名前' });
  });

  it('子の行を指す列も読み替える', async () => {
    db.prepare("insert into projects (id, name, status, updated_at, origin_device) values ('p1', 'p', 'active', 1, 'c')").run();
    await cloud.pushChanges([
      sessionRow(),
      { tableName: 'runs', rowId: 'run-1', op: 'upsert', updatedAt: OLD, payload: { id: 'run-1', session_id: 'other-id', device_id: 'c', kind: 'resume', tmux_name: 't', launch_params: '{}', started_at: 1, heartbeat_at: 1, updated_at: OLD, origin_device: 'c' } },
      { tableName: 'todos', rowId: 'todo-1', op: 'upsert', updatedAt: OLD, payload: { id: 'todo-1', project_id: 'p1', text: 't', done: 0, position: 0, session_id: 'other-id', candidate_session_id: 'other-id', rejected_sessions: '["other-id"]', updated_at: OLD, origin_device: 'c' } },
    ]);
    await engine.pullNow();
    expect(get('select session_id from runs where id = ?', 'run-1')).toEqual({ session_id: localId });
    expect(get('select session_id, candidate_session_id, rejected_sessions from todos where id = ?', 'todo-1')).toEqual({ session_id: localId, candidate_session_id: localId, rejected_sessions: JSON.stringify([localId]) });
  });

  it('上限を超えて捨てた子の行を拾うため、最初の読み替えのあとに写しを 1 度だけ読み直す', async () => {
    const snapshotDone = () => get("select value from sync_state where key = 'snapshotDone'");
    expect(snapshotDone()).toBeDefined();
    await cloud.pushChanges([sessionRow()]);
    await engine.pullNow();
    expect(snapshotDone()).toBeUndefined();
    await engine.pullNow();
    expect(snapshotDone()).toBeDefined();
    await engine.pullNow();
    expect(snapshotDone()).toBeDefined();
  });

  it('手元の行とぶつからなければ、これまでどおり届いた ID で当たる', async () => {
    await cloud.pushChanges([sessionRow({ provider_session_id: 'another' })]);
    await engine.pullNow();
    expect(get('select id from sessions where provider_session_id = ?', 'another')).toEqual({ id: 'other-id' });
    expect(get('select 1 x from session_aliases')).toBeUndefined();
  });
});
