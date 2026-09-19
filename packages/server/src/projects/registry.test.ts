import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { assignSession, assignSessions, candidateDirs, checkProjectRoots, resolveProject, syncProjectsFromWorkspace } from './registry.ts';

let ws: string;
let db: Db;
const DEV = 'dev-1';
function addSession(id: string, cwd: string) {
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: id, cwd, home_device: DEV }, DEV);
}
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  for (const d of ['alpha', 'beta', 'alpha-v2', '.hidden']) fs.mkdirSync(path.join(ws, d));
  db = openDb(':memory:');
  addSession('s-alpha', path.join(ws, 'alpha'));
  addSession('s-alpha-sub', path.join(ws, 'alpha', 'src'));
  addSession('s-other', '/somewhere/else');
});
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

const project = (id: string) => db.prepare('select * from projects where id = ?').get(id) as Record<string, unknown>;
const root = (projectId: string) => db.prepare('select * from project_roots where project_id = ? and device_id = ?').get(projectId, DEV) as Record<string, unknown>;
const sessionProject = (id: string) => (db.prepare('select project_id from sessions where id = ?').get(id) as { project_id: string | null }).project_id;

describe('syncProjectsFromWorkspace', () => {
  it('セッションのある直下ディレクトリだけをプロジェクトにする', () => {
    const r = syncProjectsFromWorkspace(db, DEV, ws);
    expect(r.created).toHaveLength(1);
    expect(project(r.created[0]!)).toMatchObject({ name: 'alpha', status: 'active', is_scratch: 0 });
    expect(root(r.created[0]!)).toMatchObject({ path: path.join(ws, 'alpha'), resolved: 1 });
  });
  it('二度呼んでも増えない', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    expect(syncProjectsFromWorkspace(db, DEV, ws).created).toEqual([]);
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 1 });
  });
  it('ルートが無ければ何もしない', () => {
    expect(syncProjectsFromWorkspace(db, DEV, path.join(ws, 'nope')).created).toEqual([]);
  });
});

describe('assignSessions', () => {
  it('cwd がルート以下のセッションを紐づけ、外のものは未分類のまま', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    expect(assignSessions(db, DEV)).toBe(2);
    expect(sessionProject('s-alpha')).toBe(pid);
    expect(sessionProject('s-alpha-sub')).toBe(pid);
    expect(sessionProject('s-other')).toBeNull();
  });
  it('最長一致のルートを選ぶ', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    upsertShared(db, 'projects', { id: 'p-src', name: 'src', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-src', project_id: 'p-src', device_id: DEV, path: path.join(ws, 'alpha', 'src'), resolved: 1 }, DEV);
    assignSessions(db, DEV);
    expect(sessionProject('s-alpha')).toBe(pid);
    expect(sessionProject('s-alpha-sub')).toBe('p-src');
  });
});

describe('assignSession', () => {
  it('1 件だけを紐づけ、最長一致のルートを選ぶ', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    upsertShared(db, 'projects', { id: 'p-src', name: 'src', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-src', project_id: 'p-src', device_id: DEV, path: path.join(ws, 'alpha', 'src'), resolved: 1 }, DEV);
    expect(assignSession(db, DEV, 's-alpha-sub')).toBe('p-src');
    expect(sessionProject('s-alpha-sub')).toBe('p-src');
    expect(sessionProject('s-alpha')).toBeNull();
    expect(assignSession(db, DEV, 's-alpha')).toBe(pid);
  });
  it('当たるルートが無いか、既に紐づいていれば null', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    expect(assignSession(db, DEV, 's-other')).toBeNull();
    expect(assignSession(db, DEV, 'いないセッション')).toBeNull();
    assignSession(db, DEV, 's-alpha');
    expect(assignSession(db, DEV, 's-alpha')).toBeNull();
  });
});

describe('checkProjectRoots', () => {
  it('消えたルートを unresolved、戻ったら recovered', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [], recovered: [] });
    fs.renameSync(path.join(ws, 'alpha'), path.join(ws, 'alpha-moved'));
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [pid], recovered: [] });
    expect(root(pid!).resolved).toBe(0);
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [], recovered: [] });
    fs.renameSync(path.join(ws, 'alpha-moved'), path.join(ws, 'alpha'));
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [], recovered: [pid] });
  });
});

describe('resolveProject', () => {
  it('repoint はパスを変えて再び紐づける', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    fs.renameSync(path.join(ws, 'alpha'), path.join(ws, 'alpha-moved'));
    checkProjectRoots(db, DEV);
    addSession('s-moved', path.join(ws, 'alpha-moved'));
    resolveProject(db, DEV, pid!, { kind: 'repoint', path: path.join(ws, 'alpha-moved') });
    expect(root(pid!)).toMatchObject({ path: path.join(ws, 'alpha-moved'), resolved: 1 });
    expect(sessionProject('s-moved')).toBe(pid);
  });
  // 末尾の / や .. が残ると longestMatch の前方一致（cwd === path か cwd.startsWith(path + '/')）が
  // 一件も当たらず、直したつもりのプロジェクトにセッションが永久に紐づかない。
  it('repoint のパスは正規化してから入れる', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    fs.renameSync(path.join(ws, 'alpha'), path.join(ws, 'alpha-moved'));
    checkProjectRoots(db, DEV);
    addSession('s-moved', path.join(ws, 'alpha-moved', 'src'));
    resolveProject(db, DEV, pid!, { kind: 'repoint', path: path.join(ws, 'beta', '..', 'alpha-moved') + '/' });
    expect(root(pid!)).toMatchObject({ path: path.join(ws, 'alpha-moved'), resolved: 1 });
    expect(sessionProject('s-moved')).toBe(pid);
  });
  it('archive は status を archived にする', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    resolveProject(db, DEV, pid!, { kind: 'archive' });
    expect(project(pid!).status).toBe('archived');
  });
  it('unlink はプロジェクトとルートを論理削除し、セッションを未分類に戻す', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    resolveProject(db, DEV, pid!, { kind: 'unlink' });
    expect(project(pid!).deleted_at).not.toBeNull();
    expect(root(pid!).deleted_at).not.toBeNull();
    expect(sessionProject('s-alpha')).toBeNull();
  });
});

describe('candidateDirs', () => {
  it('名前が近い直下ディレクトリを返す', () => {
    expect(candidateDirs(ws, 'alpha')).toEqual([path.join(ws, 'alpha'), path.join(ws, 'alpha-v2')]);
    expect(candidateDirs(ws, 'zzz')).toEqual([]);
  });
});
