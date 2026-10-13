import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ProjectCreateError } from './create.ts';
import { inspectFolder, workspaceChildren } from './folders.ts';

// フォルダの中から選んで登録する（2026-10-14、0.6.1）。親の直下を並べる一覧と、1 つのフォルダの事前の問い合わせ。

let tmp: string;
let src: string;
let db: Db;
const DEV = 'dev-1';
const OTHER = 'dev-2';

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-folders-')));
  src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  db = openDb(':memory:');
  upsertShared(db, 'devices', { id: OTHER, name: 'work-pc', platform: 'darwin' }, OTHER);
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function repo(dir: string, url?: string) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), url ? `[remote "origin"]\n\turl = ${url}\n` : '[core]\n');
}
function talk(id: string, cwd: string, at: number, device = DEV) {
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: id, cwd, home_device: device, last_activity_at: at }, device);
}
function here(id: string, name: string, dir: string) {
  upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0 }, DEV);
  upsertShared(db, 'project_roots', { id: `h-${id}`, project_id: id, device_id: DEV, path: dir, resolved: 1 }, DEV);
}
function elsewhere(id: string, name: string, remote: string | null) {
  upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0, git_remote: remote }, OTHER);
  upsertShared(db, 'project_roots', { id: `r-${id}`, project_id: id, device_id: OTHER, path: `/Users/other/src/${name}`, resolved: 1 }, OTHER);
}

describe('workspaceChildren', () => {
  it('直下の隠しでないフォルダを名前順に並べ、git の印、remote、会話の数と最後の活動を添える', () => {
    repo(path.join(src, 'notes-app'), 'git@github.com:me/notes-app.git');
    fs.mkdirSync(path.join(src, 'Zeta'));
    fs.mkdirSync(path.join(src, 'alpha'));
    fs.mkdirSync(path.join(src, 'item10'));
    fs.mkdirSync(path.join(src, 'item9'));
    fs.mkdirSync(path.join(src, '.hidden'));
    fs.writeFileSync(path.join(src, 'file.txt'), '');
    talk('a', path.join(src, 'notes-app'), 10);
    talk('b', path.join(src, 'notes-app', 'pkg'), 30);
    // ほかの PC の会話は数えない（パスはその PC のものである）。
    talk('c', path.join(src, 'notes-app'), 99, OTHER);
    const r = workspaceChildren(db, DEV, src);
    expect(r.parent).toBe(src);
    expect(r.enclosing).toBeNull();
    expect(r.children.map((c) => c.name)).toEqual(['alpha', 'item9', 'item10', 'notes-app', 'Zeta']);
    expect(r.children.find((c) => c.name === 'notes-app')).toEqual({
      name: 'notes-app', path: path.join(src, 'notes-app'), git: true, worktree: false, remote: 'github.com/me/notes-app',
      sessionCount: 2, lastActivityAt: 30, registered: null, enclosing: null, link: null, children: null,
    });
    expect(r.children.find((c) => c.name === 'alpha')).toMatchObject({ git: false, remote: null, sessionCount: 0, lastActivityAt: null, children: null });
  });
  it('登録済みの行はそのプロジェクトを、ほかの PC のプロジェクトと結び付く行は候補を添える', () => {
    fs.mkdirSync(path.join(src, 'mine'));
    here('m', 'mine', path.join(src, 'mine'));
    repo(path.join(src, 'infra'), 'https://github.com/me/infra.git');
    elsewhere('far', 'infra-old', 'github.com/me/infra');
    fs.mkdirSync(path.join(src, 'docs'));
    elsewhere('d', 'docs', null);
    const r = workspaceChildren(db, DEV, src);
    const row = (n: string) => r.children.find((c) => c.name === n)!;
    expect(row('mine')).toMatchObject({ registered: { projectId: 'm', name: 'mine' }, link: null });
    expect(row('infra').link).toEqual({ projectId: 'far', name: 'infra-old', match: 'remote', remote: 'github.com/me/infra', deviceName: 'work-pc', previousPath: '/Users/other/src/infra-old' });
    expect(row('docs').link).toMatchObject({ projectId: 'd', match: 'name' });
  });
  it('同じプロジェクトに結び付く行が 2 つあれば、名前の同じ行（無ければ先の行）にだけ候補を添える', () => {
    repo(path.join(src, 'app'), 'https://github.com/me/app.git');
    repo(path.join(src, 'app-copy'), 'https://github.com/me/app.git');
    elsewhere('far', 'app', 'github.com/me/app');
    const r = workspaceChildren(db, DEV, src);
    expect(r.children.map((c) => [c.name, c.link?.projectId ?? null])).toEqual([['app', 'far'], ['app-copy', null]]);
  });
  it('git でなく中に git のフォルダを持つものは、1 段下の子も返す', () => {
    const clients = path.join(src, 'clients');
    repo(path.join(clients, 'acme'));
    fs.mkdirSync(path.join(clients, 'notes'));
    fs.mkdirSync(path.join(clients, '.cache'));
    fs.mkdirSync(path.join(src, 'plain', 'sub'), { recursive: true });
    talk('x', path.join(clients, 'acme'), 5);
    const r = workspaceChildren(db, DEV, src);
    const c = r.children.find((x) => x.name === 'clients')!;
    expect(c).toMatchObject({ git: false, sessionCount: 1 });
    expect(c.children!.map((x) => [x.name, x.git, x.sessionCount, x.children])).toEqual([['acme', true, 1, null], ['notes', false, 0, null]]);
    // 中に git が無ければ開かない。
    expect(r.children.find((x) => x.name === 'plain')!.children).toBeNull();
  });
  it('worktree の印と、別のプロジェクトの中の印を付ける。親そのものがプロジェクトの中なら親にも付ける', () => {
    const top = path.join(tmp, 'hangar');
    repo(top);
    here('h', 'hangar', top);
    const gitdir = path.join(top, '.git', 'worktrees', 'wt');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = path.join(top, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    fs.mkdirSync(path.join(top, 'packages'));
    const r = workspaceChildren(db, DEV, top);
    expect(r.enclosing).toEqual({ projectId: 'h', name: 'hangar', path: top });
    expect(r.children.find((c) => c.name === 'wt')).toMatchObject({ git: true, worktree: true, link: null, enclosing: { projectId: 'h' } });
    expect(r.children.find((c) => c.name === 'packages')).toMatchObject({ enclosing: { projectId: 'h', path: top } });
    // 親の下のフォルダを親にしても、帯は包むプロジェクトを指す。
    expect(workspaceChildren(db, DEV, path.join(top, 'packages')).enclosing).toEqual({ projectId: 'h', name: 'hangar', path: top });
  });
  it('親は ~ をホームに直す。相対パス、無いフォルダ、ファイルは 400 で断る', () => {
    fs.writeFileSync(path.join(tmp, 'f'), '');
    for (const p of ['src', path.join(tmp, 'nope'), path.join(tmp, 'f'), '']) {
      expect(() => workspaceChildren(db, DEV, p)).toThrow(ProjectCreateError);
    }
  });
});

describe('inspectFolder', () => {
  it('登録済みのプロジェクトの下のフォルダは、包むプロジェクトと相対パスを返す', () => {
    const top = path.join(tmp, 'agent-hangar');
    fs.mkdirSync(path.join(top, 'packages', 'ui'), { recursive: true });
    here('h', 'agent-hangar', top);
    expect(inspectFolder(db, DEV, path.join(top, 'packages', 'ui') + path.sep)).toEqual({
      path: path.join(top, 'packages', 'ui'), git: false, worktree: false, remote: null, registered: null,
      enclosing: { projectId: 'h', name: 'agent-hangar', path: top, relative: path.join('packages', 'ui') },
      link: null,
    });
    expect(inspectFolder(db, DEV, top)).toMatchObject({ registered: { projectId: 'h', name: 'agent-hangar' }, enclosing: null, link: null });
  });
  it('ほかの PC から届いた同じプロジェクトがあれば、結び付く候補を返す。name を渡せばその名前で弱い一致を見る', () => {
    const dir = path.join(src, 'notes-app');
    repo(dir, 'git@github.com:me/notes-app.git');
    elsewhere('far', 'notes', 'github.com/me/notes-app');
    expect(inspectFolder(db, DEV, dir)).toMatchObject({ git: true, remote: 'github.com/me/notes-app', link: { projectId: 'far', match: 'remote', deviceName: 'work-pc' } });
    const plain = path.join(src, 'plain');
    fs.mkdirSync(plain);
    elsewhere('n', '表示名', null);
    expect(inspectFolder(db, DEV, plain).link).toBeNull();
    expect(inspectFolder(db, DEV, plain, '表示名').link).toMatchObject({ projectId: 'n', match: 'name' });
  });
});
