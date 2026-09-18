import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { promoteSession, PromoteError, type PromoteDeps } from './promote.ts';
import { ensureScratchProject, newScratchDir } from './scratch.ts';

let home: string;
let ws: string;
let db: Db;
let scratchId: string;
let dir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pro-home-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pro-ws-'));
  db = openDb(':memory:');
  scratchId = ensureScratchProject(db, 'd', home);
  dir = newScratchDir(home);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'B');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: dir, home_device: 'd', project_id: scratchId }, 'd');
  upsertShared(db, 'sessions', { id: 's9', provider: 'claude-code', provider_session_id: 'u9', cwd: '/elsewhere', home_device: 'd', project_id: null }, 'd');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

const deps = (over: Partial<PromoteDeps> = {}): PromoteDeps => ({ db, deviceId: 'd', home, workspaceRoot: ws, runAlive: () => false, gitInit: vi.fn(), ...over });

describe('promoteSession', () => {
  it('ディレクトリとプロジェクトを作り、セッションを移し、ファイルを移動する', () => {
    const gitInit = vi.fn();
    const r = promoteSession(deps({ gitInit }), { sessionId: 's1', name: 'newproj', gitInit: true, moveFiles: true });
    expect(r.moved).toBe(true);
    expect(r.reason).toBeNull();
    expect(gitInit).toHaveBeenCalledWith(path.join(ws, 'newproj'));
    expect(fs.readFileSync(path.join(ws, 'newproj', 'a.txt'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(ws, 'newproj', 'sub', 'b.txt'), 'utf8')).toBe('B');
    expect(fs.existsSync(dir)).toBe(false);
    expect(db.prepare('select name, is_scratch from projects where id = ?').get(r.projectId)).toEqual({ name: 'newproj', is_scratch: 0 });
    expect(db.prepare('select path from project_roots where project_id = ? and device_id = ?').get(r.projectId, 'd')).toEqual({ path: path.join(ws, 'newproj') });
    // cwd は変えない。昇格後に再開するとスクラッチのままである。
    expect(db.prepare('select project_id, cwd from sessions where id = ?').get('s1')).toEqual({ project_id: r.projectId, cwd: dir });
  });

  it('run が生きていれば移動せず、理由を返す。gitInit が偽なら呼ばない', () => {
    const gitInit = vi.fn();
    const r = promoteSession(deps({ runAlive: () => true, gitInit }), { sessionId: 's1', name: 'p2', gitInit: false, moveFiles: true });
    expect(r).toMatchObject({ moved: false, reason: expect.stringContaining('実行中') });
    expect(gitInit).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'p2'))).toBe(true);
    expect(promoteSession(deps(), { sessionId: 's1', name: 'p3', gitInit: false, moveFiles: false })).toMatchObject({ moved: false, reason: null });
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true);
  });

  it('検査：無いセッション、悪い名前、スクラッチ外、既存のディレクトリ', () => {
    expect(() => promoteSession(deps(), { sessionId: 'nope', name: 'x', gitInit: false, moveFiles: false })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => promoteSession(deps(), { sessionId: 's1', name: '', gitInit: false, moveFiles: false })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => promoteSession(deps(), { sessionId: 's1', name: 'a/b', gitInit: false, moveFiles: false })).toThrow(PromoteError);
    expect(() => promoteSession(deps(), { sessionId: 's1', name: '..', gitInit: false, moveFiles: false })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => promoteSession(deps(), { sessionId: 's9', name: 'x', gitInit: false, moveFiles: false })).toThrow(expect.objectContaining({ status: 400 }));
    fs.mkdirSync(path.join(ws, 'taken'));
    fs.writeFileSync(path.join(ws, 'taken', 'keep.txt'), 'KEEP');
    expect(() => promoteSession(deps(), { sessionId: 's1', name: 'taken', gitInit: false, moveFiles: false })).toThrow(expect.objectContaining({ status: 409 }));
    expect(fs.readFileSync(path.join(ws, 'taken', 'keep.txt'), 'utf8')).toBe('KEEP');
    expect(db.prepare("select count(*) c from projects where name = 'taken'").get()).toEqual({ c: 0 });
  });

  it('git init が失敗したら作ったディレクトリを消して 400', () => {
    const d = deps({ gitInit: (dest) => { fs.mkdirSync(path.join(dest, '.git')); throw new Error('git が無い'); } });
    expect(() => promoteSession(d, { sessionId: 's1', name: 'fail', gitInit: true, moveFiles: false })).toThrow(/git が無い/);
    expect(fs.existsSync(path.join(ws, 'fail'))).toBe(false);
    expect(db.prepare("select count(*) c from projects where name = 'fail'").get()).toEqual({ c: 0 });
  });

  it('git init が失敗しても、.git 以外のものが残っていればディレクトリを消さない', () => {
    const d = deps({ gitInit: (dest) => { fs.writeFileSync(path.join(dest, 'important.txt'), 'X'); throw new Error('途中で落ちた'); } });
    expect(() => promoteSession(d, { sessionId: 's1', name: 'keep', gitInit: true, moveFiles: false })).toThrow(expect.objectContaining({ status: 400 }));
    expect(fs.readFileSync(path.join(ws, 'keep', 'important.txt'), 'utf8')).toBe('X');
    expect(db.prepare("select count(*) c from projects where name = 'keep'").get()).toEqual({ c: 0 });
  });

  it('移動先に同じ名前のものがあれば、何も移動せず理由を返す', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'scratch');
    const d = deps({ gitInit: (dest) => { fs.mkdirSync(path.join(dest, '.git')); fs.writeFileSync(path.join(dest, '.git', 'HEAD'), 'fresh'); } });
    const r = promoteSession(d, { sessionId: 's1', name: 'clash', gitInit: true, moveFiles: true });
    expect(r).toMatchObject({ moved: false, reason: expect.stringContaining('.git') });
    // 移動先は上書きされず、スクラッチ側も残る。
    expect(fs.readFileSync(path.join(ws, 'clash', '.git', 'HEAD'), 'utf8')).toBe('fresh');
    expect(fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8')).toBe('scratch');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('A');
    expect(fs.existsSync(path.join(ws, 'clash', 'a.txt'))).toBe(false);
  });

  it('スクラッチのディレクトリが既に無ければ、移動せず理由を返す', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    const r = promoteSession(deps(), { sessionId: 's1', name: 'gone', gitInit: false, moveFiles: true });
    expect(r).toMatchObject({ moved: false, reason: expect.stringContaining('見つかりません') });
    expect(db.prepare('select project_id from sessions where id = ?').get('s1')).toEqual({ project_id: r.projectId });
  });
});
