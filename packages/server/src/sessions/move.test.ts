import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeOut } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { indexFile } from '../../test/claudeIndex.ts';
import { assignSession, assignSessions, mergeProjects, resolveProject } from '../projects/registry.ts';
import { listTranscriptFiles } from '../provider/claude-code/transcript/discover.ts';
import { applyRemoteBatch } from '../sync/apply.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { MoveError, moveSession, pinnedProjectOf } from './move.ts';
import { getSessionState, setSessionState } from './states.ts';

/**
 * セッションを別のプロジェクトへ移す（docs/design.md の「プロジェクトの同定」の移動の決まり）。
 * 移した先は session_states.project_id に置き、sessions.project_id をそれに合わせ直す。
 * 索引、自動の振り分け、同期の取り込みで、古い所属に戻らないことを確かめる。
 */

const DEV = 'dev-1';
let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  upsertShared(db, 'projects', { id: 'pa', name: 'alpha', status: 'active', is_scratch: 0 }, DEV);
  upsertShared(db, 'projects', { id: 'pb', name: 'beta', status: 'active', is_scratch: 0 }, DEV);
  upsertShared(db, 'project_roots', { id: 'ra', project_id: 'pa', device_id: DEV, path: '/w/alpha', resolved: 1 }, DEV);
  upsertShared(db, 'project_roots', { id: 'rb', project_id: 'pb', device_id: DEV, path: '/w/beta', resolved: 1 }, DEV);
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w/alpha', home_device: DEV, project_id: 'pa' }, DEV);
});
afterEach(() => { db.close(); });

const projectOf = (id = 's1') => (db.prepare('select project_id from sessions where id = ?').get(id) as { project_id: string | null }).project_id;
const pinOf = (id = 's1') => (db.prepare('select project_id from session_states where session_id = ?').get(id) as { project_id: string | null } | undefined)?.project_id ?? null;

describe('moveSession（移す）', () => {
  it('移した先を session_states に書き、sessions の所属も合わせる。本文の cwd は変えない', () => {
    moveSession(db, DEV, 's1', 'pb');
    expect(pinOf()).toBe('pb');
    expect(projectOf()).toBe('pb');
    expect(db.prepare("select cwd from sessions where id = 's1'").get()).toEqual({ cwd: '/w/alpha' });
    expect(pinnedProjectOf(db, 's1')).toBe('pb');
    // どちらの行も同期に載る。
    const tables = (db.prepare("select table_name t from changes where row_id = 's1' and pushed_at is null").all() as { t: string }[]).map((r) => r.t).sort();
    expect(tables).toEqual(['session_states', 'sessions']);
  });
  it('状態を変えても、移した先は残る', () => {
    moveSession(db, DEV, 's1', 'pb');
    setSessionState(db, DEV, 's1', { status: 'done', setBy: 'user' });
    setSessionState(db, DEV, 's1', { status: null, setBy: 'user' });
    expect(pinOf()).toBe('pb');
    expect(getSessionState(db, 's1')).toMatchObject({ status: null });
  });
  it('無いプロジェクト、一覧から削除したプロジェクト、無いセッションへは移さない', () => {
    expect(() => moveSession(db, DEV, 's1', 'nope')).toThrow(MoveError);
    softDeleteShared(db, 'projects', 'pb', DEV);
    expect(() => moveSession(db, DEV, 's1', 'pb')).toThrow(MoveError);
    expect(() => moveSession(db, DEV, 'nope', 'pa')).toThrow(MoveError);
    expect(pinOf()).toBeNull();
    expect(projectOf()).toBe('pa');
  });
});

describe('自動の振り分けは移した先を保つ', () => {
  it('所属が外れたり古いプロジェクトに戻ったりしても、assignSessions は移した先へ戻す', () => {
    moveSession(db, DEV, 's1', 'pb');
    db.prepare("update sessions set project_id = null where id = 's1'").run();
    expect(assignSession(db, DEV, 's1')).toBe('pb');
    db.prepare("update sessions set project_id = 'pa' where id = 's1'").run();
    assignSessions(db, DEV);
    expect(projectOf()).toBe('pb');
  });
  it('移した先が一覧から消えたら、cwd からの自動の振り分けに戻る', () => {
    moveSession(db, DEV, 's1', 'pb');
    softDeleteShared(db, 'projects', 'pb', DEV);
    expect(pinnedProjectOf(db, 's1')).toBeNull();
    assignSessions(db, DEV);
    expect(projectOf()).toBe('pa');
  });
});

describe('同期の取り込みは移した先を保つ', () => {
  const stale = (updatedAt: number): ChangeOut => ({
    seq: 1, tableName: 'sessions', op: 'upsert', deviceId: 'other', rowId: 's1', updatedAt,
    payload: { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w/alpha', home_device: DEV, project_id: 'pa', updated_at: updatedAt, deleted_at: null, origin_device: 'other' },
  });
  it('移した後に、古い所属を持った sessions の upsert が届いても、移した先のまま', () => {
    moveSession(db, DEV, 's1', 'pb');
    const applied = applyRemoteBatch(db, [stale(Date.now() + 60_000)], { ownDeviceId: DEV, skipOwn: true });
    expect(applied).toHaveLength(1);
    expect(projectOf()).toBe('pb');
  });
  it('移した印（session_states）が後から届けば、その時点で sessions の所属を合わせる', () => {
    const t = Date.now() + 60_000;
    const st: ChangeOut = {
      seq: 2, tableName: 'session_states', op: 'upsert', deviceId: 'other', rowId: 's1', updatedAt: t,
      payload: { session_id: 's1', status: null, project_id: 'pb', updated_at: t, deleted_at: null, origin_device: 'other' },
    };
    applyRemoteBatch(db, [st], { ownDeviceId: DEV, skipOwn: true });
    expect(projectOf()).toBe('pb');
  });
});

describe('索引し直しても戻らない', () => {
  let dir: string;
  beforeEach(() => { dir = copyFixtureClaudeDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  it('移した後に本文を索引し直しても、移した先のまま。古い所属が混じっていても合わせ直す', () => {
    const main = () => listTranscriptFiles(dir).find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
    const { sessionId } = indexFile(db, main(), { deviceId: DEV });
    moveSession(db, DEV, sessionId, 'pb');
    db.prepare('update sessions set project_id = ? where id = ?').run('pa', sessionId);
    db.prepare('update transcript_files set indexer_version = 0').run();
    indexFile(db, main(), { deviceId: DEV });
    expect(projectOf(sessionId)).toBe('pb');
  });
});

describe('プロジェクトをまとめる・一覧から削除する', () => {
  it('まとめるときは、移した先もまとめ先へ付け替える', () => {
    upsertShared(db, 'projects', { id: 'pc', name: 'gamma', status: 'active', is_scratch: 0 }, DEV);
    moveSession(db, DEV, 's1', 'pb');
    mergeProjects(db, DEV, 'pb', 'pc');
    expect(pinOf()).toBe('pc');
    expect(projectOf()).toBe('pc');
  });
  it('一覧から削除する（unlink）ときは、移した先を null に戻す', () => {
    moveSession(db, DEV, 's1', 'pb');
    resolveProject(db, DEV, 'pb', { kind: 'unlink' });
    expect(pinOf()).toBeNull();
    expect(projectOf()).toBeNull();
    // 移した印が外れたので、cwd からの自動の振り分けで元のプロジェクトへ戻る。
    assignSessions(db, DEV);
    expect(projectOf()).toBe('pa');
  });
});
