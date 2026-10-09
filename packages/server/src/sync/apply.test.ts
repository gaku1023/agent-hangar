import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeOut } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { onSharedWrite, upsertShared } from '../db/shared.ts';
import { applyRemoteBatch, applyRemoteChange, writeMemoConflictCopy } from './apply.ts';
import { getSessionNote, setSessionMemo, setSessionName } from '../sessions/notes.ts';
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
 * セッションの名前とメモは session_notes の行として運ぶ。
 * sessions の行（索引が本文の伸びるたびに書き直す）が降りても、名前とメモは変わらない。
 */
describe('セッションの名前とメモの同期', () => {
  const seed = () => {
    const db = openDb(':memory:');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u-s1', cwd: '/x', home_device: 'a' }, 'a');
    return db;
  };
  type TestDb = ReturnType<typeof seed>;
  const note = (updatedAt: number, payload: Record<string, unknown>, over: Partial<ChangeOut> = {}): ChangeOut => ({
    seq: 1, tableName: 'session_notes', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt,
    payload: { session_id: 's1', name: null, memo: null, updated_at: updatedAt, deleted_at: null, origin_device: 'b', ...payload }, ...over,
  });
  /** 版 16 までの端末がクラウドに残した、古い形の sessions の payload。name と memo を列として持つ。 */
  const oldSession = (updatedAt: number, name: string | null, memo: string | null): ChangeOut => ({
    seq: 7, tableName: 'sessions', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt,
    payload: { id: 's1', provider: 'claude-code', provider_session_id: 'u-s1', project_id: null, name, cwd: '/x', first_prompt: '向こうの最初の発言', ai_title: null, started_at: null, last_activity_at: null, home_device: 'a', memo, updated_at: updatedAt, deleted_at: null, origin_device: 'b' },
  });
  /** 控えの置き場を明に渡す。実物の home には絶対に書かない。 */
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const so = () => ({ ...o, home });
  const memosDir = () => path.join(home, 'backups', 'memos');
  const backups = (): string[] => (fs.existsSync(memosDir()) ? fs.readdirSync(memosDir()).sort() : []);
  const noteRow = (db: TestDb) => db.prepare('select name, memo, updated_at, origin_device, deleted_at from session_notes where session_id = ?').get('s1');
  const future = () => Date.now() + 60_000;

  it('名前とメモの行は同期で往復する', () => {
    const db = seed();
    expect(applyRemoteChange(db, note(100, { name: '向こうの名前', memo: '向こうのメモ' }), o)).toBe('applied');
    expect(noteRow(db)).toEqual({ name: '向こうの名前', memo: '向こうのメモ', updated_at: 100, origin_device: 'b', deleted_at: null });
    expect(getSessionNote(db, 's1')).toEqual({ name: '向こうの名前', memo: '向こうのメモ' });
  });

  it('新しい方が勝つ。同じ時刻なら手元を残す', () => {
    const db = seed();
    setSessionMemo(db, 'a', 's1', '手元のメモ');
    const local = (db.prepare('select updated_at u from session_notes where session_id = ?').get('s1') as { u: number }).u;
    expect(applyRemoteChange(db, note(local - 1, { memo: '古い' }), o)).toBe('skipped');
    expect(applyRemoteChange(db, note(local, { memo: '同じ時刻' }), o)).toBe('skipped');
    expect(getSessionNote(db, 's1')).toEqual({ name: null, memo: '手元のメモ' });
    expect(applyRemoteChange(db, note(local + 1, { memo: '新しい' }), so())).toBe('applied');
    expect(getSessionNote(db, 's1')).toEqual({ name: null, memo: '新しい' });
  });

  it('古い形の sessions の payload（name と memo を含む）が降りても、手元の名前とメモを壊さない', () => {
    const db = seed();
    setSessionName(db, 'a', 's1', '手元の名前');
    setSessionMemo(db, 'a', 's1', '手元のメモ');
    const before = noteRow(db);
    // sessions の行としては新しいので当たる。name と memo は、もう無い列なので捨てる。
    expect(applyRemoteChange(db, oldSession(future(), null, null), o)).toBe('applied');
    expect(applyRemoteChange(db, oldSession(future() + 1, '向こうの古い名前', '向こうの古いメモ'), o)).toBe('applied');
    expect(noteRow(db)).toEqual(before);
    // sessions の側の、いまもある列は当たっている。
    expect((db.prepare('select first_prompt f from sessions where id = ?').get('s1') as { f: string }).f).toBe('向こうの最初の発言');
  });

  it('古い形の sessions の payload から、名前とメモの行を勝手に作らない', () => {
    const db = seed();
    expect(applyRemoteChange(db, oldSession(future(), '向こうの古い名前', '向こうの古いメモ'), o)).toBe('applied');
    expect(noteRow(db)).toBeUndefined();
  });

  it('sessions の行が何度降りても、同じ束の名前とメモはそのまま当たる', () => {
    const db = seed();
    const t = future();
    const applied = applyRemoteBatch(db, [
      note(t, { name: '向こうの名前', memo: '向こうのメモ' }, { seq: 2 }),
      { ...oldSession(t + 5, null, null), seq: 3 },
    ], o);
    expect(applied.map((c) => c.tableName)).toEqual(['sessions', 'session_notes']);
    expect(getSessionNote(db, 's1')).toEqual({ name: '向こうの名前', memo: '向こうのメモ' });
  });

  it('同じ束にセッションの行があれば、それを先に適用してから名前とメモを適用する', () => {
    const db = openDb(':memory:');
    const session: ChangeOut = { seq: 9, tableName: 'sessions', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt: 100, payload: { id: 's1', provider: 'claude-code', provider_session_id: 'u-s1', cwd: '/x', home_device: 'b', updated_at: 100, deleted_at: null, origin_device: 'b' } };
    expect(applyRemoteBatch(db, [note(100, { memo: 'メモ' }), session], o)).toHaveLength(2);
    expect(getSessionNote(db, 's1')).toEqual({ name: null, memo: 'メモ' });
  });

  it('相手が消した名前とメモは、新しければ消える（空にするのも後勝ちの 1 つである）。負けたメモは控えに残る', () => {
    const db = seed();
    setSessionMemo(db, 'a', 's1', '手元のメモ');
    expect(applyRemoteChange(db, note(future(), { name: null, memo: null }), so())).toBe('applied');
    expect(getSessionNote(db, 's1')).toEqual({ name: null, memo: null });
    expect(backups().map((f) => fs.readFileSync(path.join(memosDir(), f), 'utf8'))).toEqual(['手元のメモ']);
  });

  describe('負けた名前とメモの控え', () => {
    it('メモが別の中身で上書きされるとき、手元のメモを控えに残してから上書きし、呼び手へ知らせる', () => {
      const db = seed();
      upsertShared(db, 'devices', { id: 'a', name: 'MacBook', platform: 'darwin' }, 'a');
      setSessionMemo(db, 'a', 's1', '手元のメモ');
      const told: unknown[] = [];
      expect(applyRemoteChange(db, note(future(), { memo: '向こうのメモ' }), { ...so(), onSessionMemoBackup: (x: unknown) => told.push(x) })).toBe('applied');
      expect(backups()).toHaveLength(1);
      expect(backups()[0]).toMatch(/^session-s1-\d{8}-\d{6}\.md$/);
      const file = path.join(memosDir(), backups()[0]!);
      expect(fs.readFileSync(file, 'utf8')).toBe('手元のメモ');
      expect(told).toEqual([{ sessionId: 's1', markdown: '手元のメモ', deviceName: 'MacBook', backupFile: file }]);
      expect(getSessionNote(db, 's1')).toEqual({ name: null, memo: '向こうのメモ' });
      expectMode(memosDir(), 0o700);
      expectMode(file, 0o600);
    });

    it('名前だけが負けたときは名前の 1 行を、名前もメモも負けたときは名前の 1 行とメモを残す', () => {
      const db = seed();
      setSessionName(db, 'a', 's1', '手元の名前');
      setSessionMemo(db, 'a', 's1', '手元のメモ');
      applyRemoteChange(db, note(future(), { name: '向こうの名前', memo: '手元のメモ' }), so());
      expect(fs.readFileSync(path.join(memosDir(), backups()[0]!), 'utf8')).toBe('名前：手元の名前\n');
      const db2 = seed();
      setSessionName(db2, 'a', 's1', '手元の名前');
      setSessionMemo(db2, 'a', 's1', '手元のメモ');
      fs.rmSync(memosDir(), { recursive: true, force: true });
      applyRemoteChange(db2, note(future(), { name: null, memo: '向こうのメモ' }), so());
      expect(fs.readFileSync(path.join(memosDir(), backups()[0]!), 'utf8')).toBe('名前：手元の名前\n\n手元のメモ');
    });

    it('中身が同じ、手元が空、手元の行が無い、採らない（古い）ときは控えを作らない', () => {
      const same = seed();
      setSessionName(same, 'a', 's1', '名前');
      setSessionMemo(same, 'a', 's1', 'メモ');
      expect(applyRemoteChange(same, note(future(), { name: '名前', memo: 'メモ' }), so())).toBe('applied');
      const empty = seed();
      upsertShared(empty, 'session_notes', { session_id: 's1', name: null, memo: '  ', deleted_at: null }, 'a', 'session_id');
      expect(applyRemoteChange(empty, note(future(), { name: '向こうの名前', memo: '向こうのメモ' }), so())).toBe('applied');
      expect(applyRemoteChange(seed(), note(100, { memo: '向こうのメモ' }), so())).toBe('applied');
      const older = seed();
      setSessionMemo(older, 'a', 's1', '手元のメモ');
      expect(applyRemoteChange(older, note(1, { memo: '古い' }), so())).toBe('skipped');
      expect(backups()).toEqual([]);
    });

    it('sessions の行が降りても控えは作らない（索引の書き直しは名前とメモに触らない）', () => {
      const db = seed();
      setSessionMemo(db, 'a', 's1', '手元のメモ');
      expect(applyRemoteChange(db, oldSession(future(), null, null), so())).toBe('applied');
      expect(backups()).toEqual([]);
    });

    it('控えが書けなければ適用しない', () => {
      const db = seed();
      setSessionMemo(db, 'a', 's1', '手元のメモ');
      // 入れ物の場所にファイルを置いて、作れなくする。
      fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
      fs.writeFileSync(memosDir(), 'x');
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(applyRemoteChange(db, note(future(), { memo: '向こうのメモ' }), so())).toBe('skipped');
      } finally { err.mockRestore(); }
      expect(getSessionNote(db, 's1')).toEqual({ name: null, memo: '手元のメモ' });
    });

    it('同じ秒に 2 度来ても既存の控えを潰さず、他端末が寄こした ID をそのままパスに混ぜない', () => {
      const db = seed();
      setSessionMemo(db, 'a', 's1', '1 つ目');
      applyRemoteChange(db, note(future(), { memo: '2 つ目' }), so());
      applyRemoteChange(db, note(future() + 1, { memo: '3 つ目' }), so());
      expect(backups().map((f) => fs.readFileSync(path.join(memosDir(), f), 'utf8')).sort()).toEqual(['1 つ目', '2 つ目']);
      const evil = '../../evil';
      db.pragma('foreign_keys = OFF');
      db.prepare('insert into session_notes (session_id, name, memo, updated_at, deleted_at, origin_device) values (?,?,?,?,?,?)').run(evil, null, '手元', 1, null, 'a');
      applyRemoteChange(db, note(future(), { session_id: evil, memo: '向こう' }, { rowId: evil }), so());
      expect(backups().some((f) => /^session-id-[0-9a-f]{16}-/.test(f))).toBe(true);
      expect(fs.existsSync(path.join(home, 'evil'))).toBe(false);
    });
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
