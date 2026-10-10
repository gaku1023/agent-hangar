import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeOut } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { onSharedWrite, upsertShared } from '../db/shared.ts';
import { applyRemoteBatch, applyRemoteChange, writeMemoConflictCopy } from './apply.ts';
import { getSessionState, setSessionState } from '../sessions/states.ts';
import { expectMode } from '../../test/platform.ts';

const ch = (over: Partial<ChangeOut> & { rowId: string; updatedAt: number }): ChangeOut => ({ seq: 1, tableName: 'projects', op: 'upsert', deviceId: 'b', payload: { id: over.rowId, name: 'remote', status: 'active', is_scratch: 0, updated_at: over.updatedAt, deleted_at: null, origin_device: 'b' }, ...over });
const o = { ownDeviceId: 'a', skipOwn: true };

describe('applyRemoteChange', () => {
  it('TODO の候補の列は同期で往復する', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'a', status: 'active', is_scratch: 0 }, 'a');
    const payload = { id: 't1', project_id: 'p1', text: 'x', done: 0, position: 1, session_id: null, candidate_at: 7, candidate_session_id: 's9', candidate_note: '根拠', rejected_sessions: '["s1"]', updated_at: 100, deleted_at: null, origin_device: 'b' };
    expect(applyRemoteChange(db, { seq: 1, tableName: 'todos', rowId: 't1', op: 'upsert', deviceId: 'b', updatedAt: 100, payload }, o)).toBe('applied');
    expect(db.prepare('select candidate_at, candidate_session_id, candidate_note, rejected_sessions from todos where id = ?').get('t1')).toEqual({ candidate_at: 7, candidate_session_id: 's9', candidate_note: '根拠', rejected_sessions: '["s1"]' });
  });
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
  /** 呼び手が明に渡す置き場。控えはここに書かれる。 */
  let home: string;
  /** HANGAR_HOME が指す置き場。home を渡さなかったときだけ使われる。 */
  let envHome: string;
  let saved: string | undefined;
  /** 控えの置き場を明に渡す形。実物の ~/.agent-hangar には絶対に書かない。 */
  let so: { ownDeviceId: string; skipOwn: boolean; home: string };

  beforeEach(() => {
    saved = process.env.HANGAR_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
    envHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-env-'));
    // 落ちても実物へ書かないための二重の備え。テストが見るのは home の方である。
    process.env.HANGAR_HOME = envHome;
    so = { ...o, home };
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HANGAR_HOME; else process.env.HANGAR_HOME = saved;
    for (const d of [home, envHome]) fs.rmSync(d, { recursive: true, force: true });
  });

  const memosDir = (root = home) => path.join(root, 'backups', 'memos');
  const listBackups = (root = home): string[] => (fs.existsSync(memosDir(root)) ? fs.readdirSync(memosDir(root)).sort() : []);

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
    expect(applyRemoteChange(db, session('s1', '相手のメモ', at), { ...so, onSessionMemoBackup: (x) => seen.push(x) })).toBe('applied');

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
    expect(applyRemoteChange(db, session('s1', null, at), so)).toBe('applied');
    expect(listBackups()).toHaveLength(1);
    expect(fs.readFileSync(path.join(memosDir(), listBackups()[0]!), 'utf8')).toBe('消えると困る文章');
  });

  it('手元が空か、相手と同じなら何も書かない', () => {
    const empty = seed(null);
    expect(applyRemoteChange(empty, session('s1', '相手のメモ', localUpdatedAt(empty) + 1), so)).toBe('applied');
    const blank = seed('   ');
    expect(applyRemoteChange(blank, session('s1', '相手のメモ', localUpdatedAt(blank) + 1), so)).toBe('applied');
    const same = seed('同じ文章');
    expect(applyRemoteChange(same, session('s1', '同じ文章', localUpdatedAt(same) + 1), so)).toBe('applied');
    expect(listBackups()).toEqual([]);
  });

  it('payload に memo が無ければ上書きされないので控えも要らない', () => {
    const db = seed('手元のセッションメモ');
    const c = session('s1', null, localUpdatedAt(db) + 1);
    delete (c.payload as Record<string, unknown>).memo;
    expect(applyRemoteChange(db, c, so)).toBe('applied');
    expect(listBackups()).toEqual([]);
    expect((db.prepare('select memo from sessions where id = ?').get('s1') as { memo: string }).memo).toBe('手元のセッションメモ');
  });

  it('控えが書けなければ適用しない', () => {
    const db = seed('手元のセッションメモ');
    // 入れ物と同じ名前のファイルを置いて、控えを作れなくする。
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(memosDir(), 'not a directory');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(applyRemoteChange(db, session('s1', '相手のメモ', localUpdatedAt(db) + 1), so)).toBe('skipped');
    expect((db.prepare('select memo from sessions where id = ?').get('s1') as { memo: string }).memo).toBe('手元のセッションメモ');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('同じ秒に 2 度来ても既存の控えを潰さない', () => {
    const db = seed('1 つめ');
    applyRemoteChange(db, session('s1', '相手のメモ', localUpdatedAt(db) + 1), so);
    upsertShared(db, 'sessions', { ...(db.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>), memo: '2 つめ' }, 'a');
    applyRemoteChange(db, session('s1', 'さらに新しい', localUpdatedAt(db) + 1), so);
    const bodies = listBackups().map((f) => fs.readFileSync(path.join(memosDir(), f), 'utf8')).sort();
    expect(bodies).toEqual(['1 つめ', '2 つめ']);
  });

  it('入れ物は 0700、控えは 0600 にする', () => {
    const db = seed('手元のセッションメモ');
    applyRemoteChange(db, session('s1', '相手のメモ', localUpdatedAt(db) + 1), so);
    expectMode(memosDir(), 0o700);
    expectMode(path.join(memosDir(), listBackups()[0]!), 0o600);
  });

  it('home を渡さなければ hangarHome() に落ちる（呼び手は必ず渡すこと）', () => {
    const db = seed('手元のセッションメモ');
    expect(applyRemoteChange(db, session('s1', '相手のメモ', localUpdatedAt(db) + 1), o)).toBe('applied');
    expect(listBackups()).toEqual([]);
    expect(listBackups(envHome)).toHaveLength(1);
  });

  it('他端末が寄こした ID をそのままパスに混ぜない', () => {
    const db = seed('手元のセッションメモ', '../evil');
    const at = localUpdatedAt(db, '../evil') + 1;
    expect(applyRemoteChange(db, session('../evil', '相手のメモ', at), so)).toBe('applied');
    const files = listBackups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^session-id-[0-9a-f]{16}-\d{8}-\d{6}\.md$/);
    expect(fs.existsSync(path.join(home, 'backups', 'evil'))).toBe(false);
  });
});

describe('セッションの状態の同期', () => {
  const seedSession = (db: ReturnType<typeof openDb>) => upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'b' }, 'b');
  const stateChange = (updatedAt: number, payload: Record<string, unknown>): ChangeOut => ({
    seq: 1, tableName: 'session_states', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt,
    payload: { session_id: 's1', status: null, note: null, return_on: null, set_by: null, set_at: null, candidate_status: null, candidate_note: null, candidate_return_on: null, candidate_source: null, candidate_at: null, rejected_at: null, updated_at: updatedAt, deleted_at: null, origin_device: 'b', ...payload },
  });

  it('状態と提案の列は同期で往復する', () => {
    const a = openDb(':memory:');
    seedSession(a);
    setSessionState(a, 'a', 's1', { status: 'paused', note: '明日見る', returnOn: '2026-10-02', setBy: 'user', now: 100 });
    const sent = a.prepare("select payload, updated_at from changes where table_name = 'session_states'").get() as { payload: string; updated_at: number };
    const b = openDb(':memory:');
    seedSession(b);
    expect(applyRemoteChange(b, { seq: 1, tableName: 'session_states', rowId: 's1', op: 'upsert', deviceId: 'a', updatedAt: sent.updated_at, payload: JSON.parse(sent.payload) }, { ownDeviceId: 'b', skipOwn: true })).toBe('applied');
    expect(getSessionState(b, 's1')).toEqual(getSessionState(a, 's1'));
  });
  // Review Focus 1：後から上げた PC の一括 Done（updated_at 0）が、先に上げた PC で付けた状態に勝ってはいけない。
  it('先に上げた PC で付けた状態は、後から上げた PC の一括 Done に負けない', () => {
    const b = openDb(':memory:');
    seedSession(b);
    b.prepare("insert into session_states (session_id, status, set_by, set_at, updated_at, origin_device) values ('s1', 'done', 'import', 900, 0, 'import')").run();
    expect(applyRemoteChange(b, stateChange(50, { status: 'paused', note: '明日', return_on: '2026-10-02', set_by: 'user', set_at: 50 }), o)).toBe('applied');
    expect(getSessionState(b, 's1')).toMatchObject({ status: 'paused', returnOn: '2026-10-02', setBy: 'user' });
  });
  it('同じ束にセッションの行があれば、それを先に適用してから状態を適用する', () => {
    const db = openDb(':memory:');
    const session: ChangeOut = { seq: 2, tableName: 'sessions', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt: 10, payload: { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'b', updated_at: 10, deleted_at: null, origin_device: 'b' } };
    expect(applyRemoteBatch(db, [stateChange(20, { status: 'done', set_by: 'user', set_at: 20 }), session], o).map((c) => c.tableName)).toEqual(['sessions', 'session_states']);
  });
  // 表を持たない古い端末は、SHARED_TABLES に無い表の変更を捨てる。束のほかの変更は止めない。
  it('知らない表の変更は捨て、同じ束のほかの変更は適用する', () => {
    const db = openDb(':memory:');
    const applied = applyRemoteBatch(db, [{ ...ch({ rowId: 'x', updatedAt: 5 }), tableName: 'future_states' as never }, ch({ rowId: 'p1', updatedAt: 5 })], o);
    expect(applied.map((c) => c.rowId)).toEqual(['p1']);
  });
  it('共有テーブルの一覧から外した takeover_requests の変更は、表に書かずに捨てる', () => {
    const db = openDb(':memory:');
    expect(applyRemoteChange(db, { ...ch({ rowId: 'x', updatedAt: 5 }), tableName: 'takeover_requests' as never }, o)).toBe('skipped');
    expect(db.prepare('select count(*) c from takeover_requests').get()).toEqual({ c: 0 });
  });
  it('applyRemoteBatch は、当てた行だけを確定の後に行の変化の口へ知らせる。出どころは apply である', () => {
    // 画面へ配る層（events/publisher.ts）と同期の push のデバウンスが、この知らせを読む。
    // 表からイベントへの対応（状態・要約・セッション・run はセッション、ほかは表ごと）は events/publisher.test.ts が押さえる。
    const db = openDb(':memory:');
    seedSession(db);
    const seen: string[] = [];
    const writes: string[] = [];
    const off = onRowChange((c) => { if (c.db === db) seen.push(`${c.origin}:${c.op}:${c.table}:${c.rowId}:${db.inTransaction ? '中' : '外'}`); });
    const offWrite = onSharedWrite((t, id, d) => { if (d === db) writes.push(`${t}:${id}`); });
    const fresh = Date.now() + 60_000;
    applyRemoteBatch(db, [
      { seq: 2, tableName: 'session_states', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt: fresh, payload: { status: 'done', set_by: 'user', set_at: 1 } },
      { seq: 1, tableName: 'sessions', rowId: 's1', op: 'delete', deviceId: 'b', updatedAt: fresh, payload: { provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'b' } },
      // 手元の方が新しいので採らない行。
      { seq: 3, tableName: 'sessions', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt: 1, payload: { memo: '古い' } },
    ], o);
    off();
    offWrite();
    // 親から子の順（sessions が先）に、当てた 2 行だけが届く。
    expect(seen).toEqual(['apply:delete:sessions:s1:外', 'apply:upsert:session_states:s1:外']);
    // この端末の書き込みの購読（同期の push の契機）には届かない。降りた行を push し返さない。
    expect(writes).toEqual([]);
  });
});
