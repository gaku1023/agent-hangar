import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeOut } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { applyRemoteBatch, applyRemoteChange, writeMemoConflictCopy } from './apply.ts';

const ch = (over: Partial<ChangeOut> & { rowId: string; updatedAt: number }): ChangeOut => ({ seq: 1, tableName: 'projects', op: 'upsert', deviceId: 'b', payload: { id: over.rowId, name: 'remote', status: 'active', is_scratch: 0, updated_at: over.updatedAt, deleted_at: null, origin_device: 'b' }, ...over });
const o = { ownDeviceId: 'a', skipOwn: true };

describe('applyRemoteChange', () => {
  it('新しい行を書き、changes には追記しない', () => {
    const db = openDb(':memory:');
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 100 }), o)).toBe('applied');
    expect(db.prepare('select name, origin_device, updated_at from projects where id = ?').get('p1')).toEqual({ name: 'remote', origin_device: 'b', updated_at: 100 });
    expect((db.prepare('select count(*) c from changes').get() as { c: number }).c).toBe(0);
  });

  it('updated_at が同じか古い変更は飛ばす（LWW）', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'local', status: 'active' }, 'a');
    const local = (db.prepare('select updated_at from projects where id = ?').get('p1') as { updated_at: number }).updated_at;
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: local - 1 }), o)).toBe('skipped');
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: local }), o)).toBe('skipped');
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: local + 1 }), o)).toBe('applied');
    expect((db.prepare('select name from projects where id = ?').get('p1') as { name: string }).name).toBe('remote');
  });

  it('自端末の変更は skipOwn のときだけ飛ばし、知らない表と列は無視する', () => {
    const db = openDb(':memory:');
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1, deviceId: 'a' }), o)).toBe('skipped');
    expect(applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1, deviceId: 'a' }), { ...o, skipOwn: false })).toBe('applied');
    expect(applyRemoteChange(db, ch({ rowId: 'x', updatedAt: 1, tableName: 'nope' as never }), o)).toBe('skipped');
    const c = ch({ rowId: 'p2', updatedAt: 1 });
    c.payload = { ...c.payload, future_column: 'x', is_scratch: true, extra: { a: 1 } };
    expect(applyRemoteChange(db, c, o)).toBe('applied');
    expect((db.prepare('select is_scratch from projects where id = ?').get('p2') as { is_scratch: number }).is_scratch).toBe(1);
  });

  it('upsert は deleted_at を明示的に戻すので、削除された行が生き返る', () => {
    const db = openDb(':memory:');
    applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1 }), o);
    const del = ch({ rowId: 'p1', updatedAt: 2, op: 'delete' });
    applyRemoteChange(db, del, o);
    expect((db.prepare('select deleted_at from projects where id = ?').get('p1') as { deleted_at: number }).deleted_at).toBe(2);
    const revive = ch({ rowId: 'p1', updatedAt: 3 });
    revive.payload = { id: 'p1', name: 'back', status: 'active', is_scratch: 0, updated_at: 3, origin_device: 'b' };
    expect(applyRemoteChange(db, revive, o)).toBe('applied');
    expect(db.prepare('select name, deleted_at from projects where id = ?').get('p1')).toEqual({ name: 'back', deleted_at: null });
  });

  it('project_roots の同じ組が別の id で来たら新しい方だけを残す', () => {
    const db = openDb(':memory:');
    applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1 }), o);
    upsertShared(db, 'project_roots', { id: 'pr-local', project_id: 'p1', device_id: 'dev-b', path: '/local', resolved: 1 }, 'a');
    const local = (db.prepare('select updated_at from project_roots where id = ?').get('pr-local') as { updated_at: number }).updated_at;
    const root = (id: string, updatedAt: number): ChangeOut => ({ seq: 3, tableName: 'project_roots', rowId: id, op: 'upsert', deviceId: 'b', updatedAt, payload: { id, project_id: 'p1', device_id: 'dev-b', path: '/remote', resolved: 1, updated_at: updatedAt, deleted_at: null, origin_device: 'b' } });
    expect(applyRemoteChange(db, root('pr-remote', local - 1), o)).toBe('skipped');
    expect(applyRemoteChange(db, root('pr-remote', local + 1), o)).toBe('applied');
    expect(db.prepare('select id, path from project_roots').all()).toEqual([{ id: 'pr-remote', path: '/remote' }]);
  });

  it('delete は deleted_at を埋め、主キーが id 以外の表も書ける', () => {
    const db = openDb(':memory:');
    applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1 }), o);
    const del = ch({ rowId: 'p1', updatedAt: 2, op: 'delete' });
    del.payload = { ...del.payload, deleted_at: null };
    applyRemoteChange(db, del, o);
    expect((db.prepare('select deleted_at from projects where id = ?').get('p1') as { deleted_at: number }).deleted_at).toBe(2);
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'b' }, 'a');
    const sum: ChangeOut = { seq: 2, tableName: 'session_summaries', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt: 5, payload: { session_id: 's1', title: 't', one_liner: 'o', body: 'b', state: 'done', next_steps: '[]', source: 'baseline', source_model: null, based_on_turns: 1, updated_at: 5, deleted_at: null, origin_device: 'b' } };
    expect(applyRemoteChange(db, sum, o)).toBe('applied');
    expect((db.prepare('select title from session_summaries where session_id = ?').get('s1') as { title: string }).title).toBe('t');
  });
});

/** project_memos は利用者が手で書いた文章なので、上書きの前に負けた本文を呼び手へ渡す。 */
describe('applyRemoteChange のメモの競合', () => {
  const memo = (markdown: string, updatedAt: number): ChangeOut => ({ seq: 9, tableName: 'project_memos', rowId: 'p1', op: 'upsert', deviceId: 'b', updatedAt, payload: { project_id: 'p1', markdown, updated_at: updatedAt, deleted_at: null, origin_device: 'b' } });
  const seed = () => {
    const db = openDb(':memory:');
    applyRemoteChange(db, ch({ rowId: 'p1', updatedAt: 1 }), o);
    upsertShared(db, 'devices', { id: 'a', name: 'MacBook', platform: 'darwin' }, 'a');
    upsertShared(db, 'project_memos', { project_id: 'p1', markdown: '手元のメモ' }, 'a', 'project_id');
    return db;
  };

  it('本文が違えば手元の本文と端末名を渡してから上書きする', () => {
    const db = seed();
    const local = (db.prepare('select updated_at from project_memos where project_id = ?').get('p1') as { updated_at: number }).updated_at;
    const seen: { projectId: string; markdown: string; deviceName: string }[] = [];
    expect(applyRemoteChange(db, memo('相手のメモ', local + 1), { ...o, onMemoConflict: (x) => seen.push(x) })).toBe('applied');
    expect(seen).toEqual([{ projectId: 'p1', markdown: '手元のメモ', deviceName: 'MacBook' }]);
    expect((db.prepare('select markdown from project_memos where project_id = ?').get('p1') as { markdown: string }).markdown).toBe('相手のメモ');
  });

  it('本文が同じなら知らせない', () => {
    const db = seed();
    const local = (db.prepare('select updated_at from project_memos where project_id = ?').get('p1') as { updated_at: number }).updated_at;
    const seen: unknown[] = [];
    expect(applyRemoteChange(db, memo('手元のメモ', local + 1), { ...o, onMemoConflict: (x) => seen.push(x) })).toBe('applied');
    expect(seen).toEqual([]);
  });

  it('控えを残せなかったら上書きしない', () => {
    const db = seed();
    const local = (db.prepare('select updated_at from project_memos where project_id = ?').get('p1') as { updated_at: number }).updated_at;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(applyRemoteChange(db, memo('相手のメモ', local + 1), { ...o, onMemoConflict: () => { throw new Error('書けない'); } })).toBe('skipped');
    expect((db.prepare('select markdown from project_memos where project_id = ?').get('p1') as { markdown: string }).markdown).toBe('手元のメモ');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('applyRemoteBatch', () => {
  it('子が先に来ても親から順に適用し、適用した変更を返す', () => {
    const db = openDb(':memory:');
    const run: ChangeOut = { seq: 1, tableName: 'runs', rowId: 'r1', op: 'upsert', deviceId: 'b', updatedAt: 3, payload: { id: 'r1', session_id: 's1', device_id: 'b', kind: 'start', tmux_name: 'hangar-r1', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1, updated_at: 3, deleted_at: null, origin_device: 'b' } };
    const ses: ChangeOut = { seq: 2, tableName: 'sessions', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt: 2, payload: { id: 's1', provider: 'claude-code', provider_session_id: 'u1', project_id: null, name: null, cwd: '/x', first_prompt: null, ai_title: null, started_at: null, last_activity_at: null, home_device: 'b', memo: null, updated_at: 2, deleted_at: null, origin_device: 'b' } };
    const applied = applyRemoteBatch(db, [run, ses, ch({ rowId: 'p1', updatedAt: 1, deviceId: 'a' })], o);
    expect(applied.map((c) => c.tableName)).toEqual(['sessions', 'runs']);
    expect((db.prepare('select count(*) c from runs').get() as { c: number }).c).toBe(1);
  });

  it('親がどこにも無い行は 1 度やり直してから飛ばす', () => {
    const db = openDb(':memory:');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const orphan: ChangeOut = { seq: 1, tableName: 'runs', rowId: 'r1', op: 'upsert', deviceId: 'b', updatedAt: 3, payload: { id: 'r1', session_id: 'missing', device_id: 'b', kind: 'start', tmux_name: 'hangar-r1', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1, updated_at: 3, deleted_at: null, origin_device: 'b' } };
    const applied = applyRemoteBatch(db, [orphan, ch({ rowId: 'p1', updatedAt: 1 })], o);
    expect(applied.map((c) => c.rowId)).toEqual(['p1']);
    expect((db.prepare('select count(*) c from runs').get() as { c: number }).c).toBe(0);
    expect((db.prepare('select count(*) c from projects').get() as { c: number }).c).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

/** 負けたメモの写しは、畳んだ端末名で名付け、既にあるファイルを決して潰さない。 */
describe('writeMemoConflictCopy', () => {
  const dirs: string[] = [];
  const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-memo-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  const at = Date.UTC(2026, 8, 19, 3, 4, 5);
  const conflict = (deviceName: string, markdown = '手元のメモ') => ({ projectId: 'p1', markdown, deviceName });

  it('端末名を畳んでからファイル名に入れる', () => {
    const dir = tmp();
    const file = writeMemoConflictCopy(path.join(dir, 'memo.md'), conflict('さとうの Mac'), at);
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toMatch(/^memo\.conflict-Mac-\d{8}-\d{6}\.md$/);
    expect(fs.readFileSync(file, 'utf8')).toBe('手元のメモ');
  });

  it('畳むと何も残らない名前でも、端末ごとに違う名前になる', () => {
    const dir = tmp();
    const one = writeMemoConflictCopy(path.join(dir, 'memo.md'), conflict('さとうのマック'), at);
    const two = writeMemoConflictCopy(path.join(dir, 'memo.md'), conflict('たなかのマック'), at);
    expect(path.basename(one)).toMatch(/^memo\.conflict-device-[0-9a-f]{8}-\d{8}-\d{6}\.md$/);
    expect(path.basename(two)).not.toBe(path.basename(one));
  });

  it('同じ名前が既にあれば連番を足し、元のファイルを潰さない', () => {
    const dir = tmp();
    const first = writeMemoConflictCopy(path.join(dir, 'memo.md'), conflict('Mac', '1 つめ'), at);
    // 畳んだ名前は元と 1 対 1 ではないので、別の端末でも同じ名前に当たりうる。
    const second = writeMemoConflictCopy(path.join(dir, 'memo.md'), conflict('さとうの Mac', '2 つめ'), at);
    const third = writeMemoConflictCopy(path.join(dir, 'memo.md'), conflict('Mac', '3 つめ'), at);
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    expect(fs.readFileSync(first, 'utf8')).toBe('1 つめ');
    expect(fs.readFileSync(second, 'utf8')).toBe('2 つめ');
    expect(fs.readFileSync(third, 'utf8')).toBe('3 つめ');
    expect(fs.readdirSync(dir).sort()).toHaveLength(3);
  });

  it('メモの置き場がまだ無ければ作る', () => {
    const dir = tmp();
    const file = writeMemoConflictCopy(path.join(dir, 'projects', 'p1', 'memo.md'), conflict('Mac'), at);
    expect(fs.existsSync(file)).toBe(true);
  });
});

/**
 * セッションのメモは DB の列なので、隣に置く場所が無い。
 * 他端末の新しい版に負けた本文は、控えの入れ物に残してから上書きする。
 */
describe('applyRemoteChange のセッションのメモ', () => {
  let home: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.HANGAR_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
    process.env.HANGAR_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HANGAR_HOME; else process.env.HANGAR_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const memosDir = () => path.join(home, 'backups', 'memos');
  const listBackups = (): string[] => (fs.existsSync(memosDir()) ? fs.readdirSync(memosDir()).sort() : []);

  const seed = (memo: string | null, id = 's1') => {
    const db = openDb(':memory:');
    upsertShared(db, 'devices', { id: 'a', name: 'MacBook', platform: 'darwin' }, 'a');
    upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: `u-${id}`, cwd: '/x', home_device: 'a', memo }, 'a');
    return db;
  };

  const session = (id: string, memo: string | null, updatedAt: number): ChangeOut => ({
    seq: 7, tableName: 'sessions', rowId: id, op: 'upsert', deviceId: 'b', updatedAt,
    payload: { id, provider: 'claude-code', provider_session_id: `u-${id}`, project_id: null, name: null, cwd: '/x', first_prompt: null, ai_title: null, started_at: null, last_activity_at: null, home_device: 'a', memo, updated_at: updatedAt, deleted_at: null, origin_device: 'b' },
  });

  const localUpdatedAt = (db: ReturnType<typeof openDb>, id = 's1') => (db.prepare('select updated_at from sessions where id = ?').get(id) as { updated_at: number }).updated_at;

  it('負けた本文を控えの入れ物に残してから上書きする', () => {
    const db = seed('手元のセッションメモ');
    const seen: { sessionId: string; markdown: string; deviceName: string; backupFile: string }[] = [];
    const at = localUpdatedAt(db) + 1;
    expect(applyRemoteChange(db, session('s1', '相手のメモ', at), { ...o, onSessionMemoBackup: (x) => seen.push(x) })).toBe('applied');

    const files = listBackups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^session-s1-\d{8}-\d{6}\.md$/);
    expect(fs.readFileSync(path.join(memosDir(), files[0]!), 'utf8')).toBe('手元のセッションメモ');
    expect((db.prepare('select memo from sessions where id = ?').get('s1') as { memo: string }).memo).toBe('相手のメモ');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: 's1', markdown: '手元のセッションメモ', deviceName: 'MacBook' });
    expect(seen[0]?.backupFile).toBe(path.join(memosDir(), files[0]!));
  });

  it('消される側でも控えを残す（相手が memo を空にしたとき）', () => {
    const db = seed('消えると困る文章');
    const at = localUpdatedAt(db) + 1;
    expect(applyRemoteChange(db, session('s1', null, at), o)).toBe('applied');
    expect(listBackups()).toHaveLength(1);
    expect(fs.readFileSync(path.join(memosDir(), listBackups()[0]!), 'utf8')).toBe('消えると困る文章');
  });

  it('手元が空か、相手と同じなら何も書かない', () => {
    const empty = seed(null);
    expect(applyRemoteChange(empty, session('s1', '相手のメモ', localUpdatedAt(empty) + 1), o)).toBe('applied');
    const blank = seed('   ');
    expect(applyRemoteChange(blank, session('s1', '相手のメモ', localUpdatedAt(blank) + 1), o)).toBe('applied');
    const same = seed('同じ文章');
    expect(applyRemoteChange(same, session('s1', '同じ文章', localUpdatedAt(same) + 1), o)).toBe('applied');
    expect(listBackups()).toEqual([]);
  });

  it('payload に memo が無ければ上書きされないので控えも要らない', () => {
    const db = seed('手元のセッションメモ');
    const c = session('s1', null, localUpdatedAt(db) + 1);
    delete (c.payload as Record<string, unknown>).memo;
    expect(applyRemoteChange(db, c, o)).toBe('applied');
    expect(listBackups()).toEqual([]);
    expect((db.prepare('select memo from sessions where id = ?').get('s1') as { memo: string }).memo).toBe('手元のセッションメモ');
  });

  it('控えが書けなければ適用しない', () => {
    const db = seed('手元のセッションメモ');
    // 入れ物と同じ名前のファイルを置いて、控えを作れなくする。
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(memosDir(), 'not a directory');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(applyRemoteChange(db, session('s1', '相手のメモ', localUpdatedAt(db) + 1), o)).toBe('skipped');
    expect((db.prepare('select memo from sessions where id = ?').get('s1') as { memo: string }).memo).toBe('手元のセッションメモ');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('同じ秒に 2 度来ても既存の控えを潰さない', () => {
    const db = seed('1 つめ');
    applyRemoteChange(db, session('s1', '相手のメモ', localUpdatedAt(db) + 1), o);
    upsertShared(db, 'sessions', { ...(db.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>), memo: '2 つめ' }, 'a');
    applyRemoteChange(db, session('s1', 'さらに新しい', localUpdatedAt(db) + 1), o);
    const bodies = listBackups().map((f) => fs.readFileSync(path.join(memosDir(), f), 'utf8')).sort();
    expect(bodies).toEqual(['1 つめ', '2 つめ']);
  });

  it('入れ物は 0700、控えは 0600 にする', () => {
    const db = seed('手元のセッションメモ');
    applyRemoteChange(db, session('s1', '相手のメモ', localUpdatedAt(db) + 1), o);
    expect(fs.statSync(memosDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(memosDir(), listBackups()[0]!)).mode & 0o777).toBe(0o600);
  });

  it('他端末が寄こした ID をそのままパスに混ぜない', () => {
    const db = seed('手元のセッションメモ', '../evil');
    const at = localUpdatedAt(db, '../evil') + 1;
    expect(applyRemoteChange(db, session('../evil', '相手のメモ', at), o)).toBe('applied');
    const files = listBackups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^session-id-[0-9a-f]{16}-\d{8}-\d{6}\.md$/);
    expect(fs.existsSync(path.join(home, 'backups', 'evil'))).toBe(false);
  });
});
