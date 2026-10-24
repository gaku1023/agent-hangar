import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { enclosingProject, fillProjectRemotes, linkCandidateFor, placelessProjects, registeredAt } from './link.ts';

// ほかの PC から届いたプロジェクトと、この PC のフォルダを結び付ける候補（2026-10-14）。
// 強い一致は git の remote が同じもの、弱い一致は名前が同じで remote が食い違わないもの。

let tmp: string;
let db: Db;
const DEV = 'dev-1';
const OTHER = 'dev-2';

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-link-')));
  db = openDb(':memory:');
  upsertShared(db, 'devices', { id: OTHER, name: 'work-pc', platform: 'darwin' }, OTHER);
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** ほかの PC だけに場所を持つプロジェクト。 */
function elsewhere(id: string, name: string, remote: string | null, extra: Record<string, unknown> = {}) {
  upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0, git_remote: remote, ...extra }, OTHER);
  upsertShared(db, 'project_roots', { id: `r-${id}`, project_id: id, device_id: OTHER, path: `/Users/other/src/${name}`, resolved: 1 }, OTHER);
}
/** この PC に場所を持つプロジェクト。 */
function here(id: string, name: string, dir: string, extra: Record<string, unknown> = {}) {
  upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0, ...extra }, DEV);
  upsertShared(db, 'project_roots', { id: `h-${id}`, project_id: id, device_id: DEV, path: dir, resolved: 1 }, DEV);
}
/** .git/config に origin を書いたリポジトリ。 */
function repo(dir: string, url: string | null) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), url ? `[remote "origin"]\n\turl = ${url}\n` : '[core]\n');
}

describe('linkCandidateFor', () => {
  it('remote が同じものは強い一致で、名前が違っても候補にする', () => {
    elsewhere('p1', 'notes', 'github.com/me/notes-app');
    const c = linkCandidateFor(placelessProjects(db, DEV), { name: 'notes-app', remote: 'github.com/Me/notes-app' });
    expect(c).toEqual({ projectId: 'p1', name: 'notes', match: 'remote', remote: 'github.com/me/notes-app', deviceName: 'work-pc', previousPath: '/Users/other/src/notes' });
  });
  it('名前が同じで remote が食い違わないものは弱い一致（どちらかの remote が無い）', () => {
    elsewhere('p1', 'infra', null);
    expect(linkCandidateFor(placelessProjects(db, DEV), { name: 'infra', remote: 'github.com/me/infra' })).toMatchObject({ projectId: 'p1', match: 'name' });
    elsewhere('p2', 'docs', 'github.com/me/docs');
    expect(linkCandidateFor(placelessProjects(db, DEV), { name: 'docs', remote: null })).toMatchObject({ projectId: 'p2', match: 'name' });
    // 名前の大文字小文字と NFC と NFD の違いは同じに見る。
    elsewhere('p3', 'ご注文', null);
    expect(linkCandidateFor(placelessProjects(db, DEV), { name: 'ご注文'.normalize('NFD'), remote: null })).toMatchObject({ projectId: 'p3' });
    expect(linkCandidateFor(placelessProjects(db, DEV), { name: 'INFRA', remote: null })).toMatchObject({ projectId: 'p1' });
  });
  it('名前が同じでも remote が食い違えば候補にしない', () => {
    elsewhere('p1', 'app', 'github.com/me/app');
    expect(linkCandidateFor(placelessProjects(db, DEV), { name: 'app', remote: 'github.com/someone/app' })).toBeNull();
  });
  it('強い一致を弱い一致より先に選ぶ', () => {
    elsewhere('weak', 'tool', null);
    elsewhere('strong', 'tool-old', 'github.com/me/tool');
    expect(linkCandidateFor(placelessProjects(db, DEV), { name: 'tool', remote: 'github.com/me/tool' })).toMatchObject({ projectId: 'strong', match: 'remote' });
  });
  it('この PC に場所のあるもの、消したもの、クイックセッション、アーカイブは候補にしない', () => {
    here('h1', 'mine', path.join(tmp, 'mine'));
    elsewhere('gone', 'gone', null, { deleted_at: 1 });
    elsewhere('arch', 'arch', null, { status: 'archived' });
    upsertShared(db, 'projects', { id: 'scr', name: 'scratch', status: 'active', is_scratch: 1 }, OTHER);
    const list = placelessProjects(db, DEV);
    for (const name of ['mine', 'gone', 'arch', 'scratch']) expect(linkCandidateFor(list, { name, remote: null }), name).toBeNull();
  });
  it('この PC の場所が見つからなくなったもの（missing）は、この PC の前のパスを添えて候補にする', () => {
    upsertShared(db, 'projects', { id: 'm', name: 'moved', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'rm', project_id: 'm', device_id: DEV, path: '/old/moved', resolved: 0 }, DEV);
    expect(linkCandidateFor(placelessProjects(db, DEV), { name: 'moved', remote: null })).toEqual({ projectId: 'm', name: 'moved', match: 'name', remote: null, deviceName: null, previousPath: '/old/moved' });
  });
});

describe('registeredAt と enclosingProject', () => {
  it('登録済みの場所そのものと、その下を見分ける', () => {
    const top = path.join(tmp, 'agent-hangar');
    fs.mkdirSync(path.join(top, 'packages', 'ui'), { recursive: true });
    here('p', 'agent-hangar', top);
    expect(registeredAt(db, DEV, top)).toEqual({ projectId: 'p', name: 'agent-hangar' });
    expect(registeredAt(db, DEV, path.join(top, 'packages'))).toBeNull();
    expect(enclosingProject(db, DEV, path.join(top, 'packages', 'ui'))).toEqual({ projectId: 'p', name: 'agent-hangar', path: top });
    // 場所そのものは「中」ではない。含めるときは includeSelf。
    expect(enclosingProject(db, DEV, top)).toBeNull();
    expect(enclosingProject(db, DEV, top, { includeSelf: true })).toEqual({ projectId: 'p', name: 'agent-hangar', path: top });
    expect(enclosingProject(db, DEV, tmp)).toBeNull();
  });
  it('いちばん深い場所を返し、クイックセッションと、消したプロジェクトと、見つからない場所は数えない', () => {
    const top = path.join(tmp, 'mono');
    here('outer', 'mono', top);
    here('inner', 'pkg', path.join(top, 'pkg'));
    expect(enclosingProject(db, DEV, path.join(top, 'pkg', 'src'))).toMatchObject({ projectId: 'inner' });
    here('s', 'scratch', path.join(tmp, 'scr'), { is_scratch: 1 });
    expect(enclosingProject(db, DEV, path.join(tmp, 'scr', 'x'))).toBeNull();
    here('d', 'dead', path.join(tmp, 'dead'), { deleted_at: 1 });
    expect(enclosingProject(db, DEV, path.join(tmp, 'dead', 'x'))).toBeNull();
    expect(registeredAt(db, DEV, path.join(tmp, 'dead'))).toBeNull();
  });
});

describe('fillProjectRemotes', () => {
  it('この PC に場所のあるプロジェクトのうち、remote が空のものだけを埋める', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    const c = path.join(tmp, 'c');
    repo(a, 'git@github.com:me/a.git');
    repo(b, 'https://github.com/me/b-new.git');
    fs.mkdirSync(c);
    here('a', 'a', a);
    here('b', 'b', b, { git_remote: 'github.com/me/b' });
    here('c', 'c', c);
    elsewhere('o', 'o', null);
    expect(fillProjectRemotes(db, DEV)).toBe(1);
    const remote = (id: string) => (db.prepare('select git_remote from projects where id = ?').get(id) as { git_remote: string | null }).git_remote;
    expect(remote('a')).toBe('github.com/me/a');
    // 埋まっている値は書き換えない。PC ごとに remote が違うと、起動のたびに書き合いになるからである。
    expect(remote('b')).toBe('github.com/me/b');
    expect(remote('c')).toBeNull();
    expect(remote('o')).toBeNull();
    // 二度目は何も書かない。
    expect(fillProjectRemotes(db, DEV)).toBe(0);
  });
});
