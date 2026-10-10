import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { createProjectDir, ProjectCreateError, registerProjectDir } from './create.ts';

let ws: string;
let db: Db;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-create-'));
  db = openDb(':memory:');
});
afterEach(() => { db.close(); fs.rmSync(ws, { recursive: true, force: true }); });

const deps = (over: { gitInit?: (dir: string) => void } = {}) => ({ db, deviceId: 'd', workspaceRoot: ws, gitInit: vi.fn(), ...over });
const rootOf = (id: string) => db.prepare('select path, resolved from project_roots where project_id = ? and device_id = ?').get(id, 'd');
const projectOf = (id: string) => db.prepare('select name, status, is_scratch from projects where id = ?').get(id);

describe('createProjectDir', () => {
  it('ワークスペースの下にフォルダを作り、git init し、プロジェクトとルートを作る', () => {
    const gitInit = vi.fn();
    const r = createProjectDir(deps({ gitInit }), { name: ' price-watcher ', gitInit: true });
    const dir = path.join(ws, 'price-watcher');
    expect(r.dir).toBe(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(gitInit).toHaveBeenCalledWith(dir);
    expect(projectOf(r.projectId)).toEqual({ name: 'price-watcher', status: 'active', is_scratch: 0 });
    expect(rootOf(r.projectId)).toEqual({ path: dir, resolved: 1 });
  });
  it('gitInit が偽なら git init を呼ばない', () => {
    const gitInit = vi.fn();
    createProjectDir(deps({ gitInit }), { name: 'p', gitInit: false });
    expect(gitInit).not.toHaveBeenCalled();
  });
  it('名前が空、. 、.. 、/ や \\ を含むなら 400 で断り、何も作らない', () => {
    for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b']) {
      expect(() => createProjectDir(deps(), { name, gitInit: false })).toThrow(ProjectCreateError);
    }
    expect(fs.readdirSync(ws)).toEqual([]);
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 0 });
  });
  it('同じ名前が既にあれば 409 で断り、既にあるものに触れない', () => {
    fs.mkdirSync(path.join(ws, 'taken'));
    fs.writeFileSync(path.join(ws, 'taken', 'keep.txt'), 'k');
    try {
      createProjectDir(deps(), { name: 'taken', gitInit: false });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProjectCreateError);
      expect((e as ProjectCreateError).status).toBe(409);
    }
    expect(fs.readFileSync(path.join(ws, 'taken', 'keep.txt'), 'utf8')).toBe('k');
  });
  it('git init に失敗したら作ったフォルダを片付けて 400 にする', () => {
    const gitInit = vi.fn((dir: string) => { fs.mkdirSync(path.join(dir, '.git')); throw new Error('no git'); });
    expect(() => createProjectDir(deps({ gitInit }), { name: 'broken', gitInit: true })).toThrow(/git init に失敗しました: no git/);
    expect(fs.existsSync(path.join(ws, 'broken'))).toBe(false);
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 0 });
  });
  it('ワークスペースのルートが作れなければ 400 にする', () => {
    fs.writeFileSync(path.join(ws, 'file'), '');
    const root = path.join(ws, 'file');
    expect(() => createProjectDir({ db, deviceId: 'd', workspaceRoot: root, gitInit: vi.fn() }, { name: 'p', gitInit: false })).toThrow(ProjectCreateError);
    expect(() => createProjectDir({ db, deviceId: 'd', workspaceRoot: root, gitInit: vi.fn() }, { name: 'p', gitInit: false })).toThrow(`${path.join(root, 'p')} を作れません: `);
    expect(() => createProjectDir({ db, deviceId: 'd', workspaceRoot: path.join(root, 'sub'), gitInit: vi.fn() }, { name: 'p', gitInit: false })).toThrow(/を作れません: /);
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 0 });
  });
  it('ワークスペースのルートが無ければ作る', () => {
    const nested = path.join(ws, 'not-yet', 'ws');
    const r = createProjectDir({ db, deviceId: 'd', workspaceRoot: nested, gitInit: vi.fn() }, { name: 'p', gitInit: false });
    expect(r.dir).toBe(path.join(nested, 'p'));
  });
});

describe('registerProjectDir', () => {
  it('既存のディレクトリを登録する。名前を省けば basename にする', () => {
    fs.mkdirSync(path.join(ws, 'old-kadai'));
    const r = registerProjectDir({ db, deviceId: 'd', workspaceRoot: ws }, { path: `${ws}/old-kadai/` });
    expect(r.created).toBe(true);
    expect(projectOf(r.projectId)).toMatchObject({ name: 'old-kadai', status: 'active' });
    expect(rootOf(r.projectId)).toEqual({ path: path.join(ws, 'old-kadai'), resolved: 1 });
  });
  it('名前を渡せばその名前にする。空の名前は 400', () => {
    fs.mkdirSync(path.join(ws, 'x'));
    expect(projectOf(registerProjectDir({ db, deviceId: 'd', workspaceRoot: ws }, { path: path.join(ws, 'x'), name: ' 表示名 ' }).projectId)).toMatchObject({ name: '表示名' });
    fs.mkdirSync(path.join(ws, 'y'));
    expect(() => registerProjectDir({ db, deviceId: 'd', workspaceRoot: ws }, { path: path.join(ws, 'y'), name: ' ' })).toThrow(ProjectCreateError);
  });
  it('無いパスとファイルは 400', () => {
    fs.writeFileSync(path.join(ws, 'file'), '');
    for (const p of ['/nonexistent-hangar', path.join(ws, 'file'), '']) {
      expect(() => registerProjectDir({ db, deviceId: 'd', workspaceRoot: ws }, { path: p })).toThrow('path が存在するディレクトリではありません');
    }
  });
  it('登録済みのパスなら既存を返し、.. を含んでも同じものに当てる', () => {
    fs.mkdirSync(path.join(ws, 'b'));
    const a = registerProjectDir({ db, deviceId: 'd', workspaceRoot: ws }, { path: path.join(ws, 'b') });
    const again = registerProjectDir({ db, deviceId: 'd', workspaceRoot: ws }, { path: `${ws}/b/../b`, name: '別名' });
    expect(again).toEqual({ projectId: a.projectId, created: false });
    expect(projectOf(a.projectId)).toMatchObject({ name: 'b' });
    expect(db.prepare('select count(*) c from project_roots').get()).toEqual({ c: 1 });
  });
  it('ワークスペースのルートと、その上のフォルダは 400 で断る', () => {
    for (const p of [ws, `${ws}/`, path.dirname(ws), '/']) {
      try {
        registerProjectDir({ db, deviceId: 'd', workspaceRoot: ws }, { path: p });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ProjectCreateError);
        expect((e as ProjectCreateError).status).toBe(400);
        expect((e as Error).message).toBe('プロジェクトの親フォルダやその上のフォルダはプロジェクトにできません');
      }
    }
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 0 });
  });
  it('相対パスは 400 で断る', () => {
    for (const p of ['x', './x', '../x']) {
      expect(() => registerProjectDir({ db, deviceId: 'd', workspaceRoot: ws }, { path: p })).toThrow('path は / か ~ で始まる絶対パスにしてください');
    }
  });
  it('先頭の ~/ はホームに直してから登録する', () => {
    const home = path.join(ws, 'home');
    fs.mkdirSync(path.join(home, 'kadai'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const r = registerProjectDir({ db, deviceId: 'd', workspaceRoot: path.join(ws, 'wsroot') }, { path: '~/kadai' });
      expect(rootOf(r.projectId)).toEqual({ path: path.join(home, 'kadai'), resolved: 1 });
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('登録済みのプロジェクトがアーカイブなら Active に戻す', () => {
    fs.mkdirSync(path.join(ws, 'arch'));
    upsertShared(db, 'projects', { id: 'p-arch', name: 'arch', status: 'archived', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r-arch', project_id: 'p-arch', device_id: 'd', path: path.join(ws, 'arch'), resolved: 1 }, 'd');
    expect(registerProjectDir({ db, deviceId: 'd', workspaceRoot: ws }, { path: path.join(ws, 'arch') })).toEqual({ projectId: 'p-arch', created: false });
    expect(projectOf('p-arch')).toMatchObject({ status: 'active' });
  });
});
