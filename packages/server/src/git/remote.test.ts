import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitFolderOf, gitRemoteOf, normalizeRemote, sameRemote } from './remote.ts';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-remote-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('normalizeRemote', () => {
  it('ssh と https を同じ形（ホスト/パス）に読む', () => {
    for (const url of [
      'git@github.com:owner/repo.git',
      'github.com:owner/repo',
      'https://github.com/owner/repo.git',
      'https://github.com/owner/repo/',
      'http://github.com/owner/repo',
      'ssh://git@github.com/owner/repo.git',
      'ssh://git@github.com:22/owner/repo.git',
      'git://github.com/owner/repo.git',
      'git+ssh://git@github.com/owner/repo.git',
    ]) expect(normalizeRemote(url), url).toBe('github.com/owner/repo');
  });
  it('資格情報とトークン、問いの部分は入れない', () => {
    expect(normalizeRemote('https://user:ghp_secret@github.com/owner/repo.git')).toBe('github.com/owner/repo');
    expect(normalizeRemote('https://oauth2:glpat-xyz@gitlab.example.com/g/sub/repo.git?ref=1#frag')).toBe('gitlab.example.com/g/sub/repo');
    expect(normalizeRemote('https://user:ghp_secret@github.com/owner/repo.git')).not.toContain('secret');
  });
  it('ホストは小文字にし、パスの大文字小文字は残す', () => {
    expect(normalizeRemote('HTTPS://GitHub.COM/Owner/Repo.git')).toBe('github.com/Owner/Repo');
  });
  it('手元のパスと、読めないものは null', () => {
    for (const url of ['', '   ', '/srv/git/repo.git', 'file:///srv/git/repo.git', '../other', './x', 'C:\\repos\\x', 'C:/repos/x', 'https://github.com/', 'https://github.com']) {
      expect(normalizeRemote(url), url).toBeNull();
    }
  });
});

describe('sameRemote', () => {
  it('大文字小文字の違いは同じに見る。null は何とも同じでない', () => {
    expect(sameRemote('github.com/Owner/Repo', 'github.com/owner/repo')).toBe(true);
    expect(sameRemote('github.com/owner/a', 'github.com/owner/b')).toBe(false);
    expect(sameRemote(null, 'github.com/owner/repo')).toBe(false);
    expect(sameRemote(null, null)).toBe(false);
  });
});

/** .git/config を持つリポジトリを作る（git は起こさない）。 */
function repo(name: string, config: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), config);
  return dir;
}

describe('gitRemoteOf', () => {
  it('origin の url を正規化して返す', () => {
    const dir = repo('a', '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/up/a.git\n[remote "origin"]\n\turl = git@github.com:me/a.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    expect(gitRemoteOf(dir)).toBe('github.com/me/a');
  });
  it('origin が無ければ、最初の remote を使う', () => {
    const dir = repo('b', '[remote "upstream"]\n\turl=https://github.com/up/b\n[remote "fork"]\n\turl = https://github.com/fork/b\n');
    expect(gitRemoteOf(dir)).toBe('github.com/up/b');
  });
  it('remote が無いリポジトリ、手元のパスの remote は null', () => {
    expect(gitRemoteOf(repo('c', '[core]\n\tbare = false\n'))).toBeNull();
    expect(gitRemoteOf(repo('d', '[remote "origin"]\n\turl = /srv/git/d.git\n'))).toBeNull();
  });
  it('git でないフォルダと、リポジトリの中の下のフォルダは null（根だけを見る）', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    expect(gitRemoteOf(plain)).toBeNull();
    const dir = repo('e', '[remote "origin"]\n\turl = https://github.com/me/e\n');
    fs.mkdirSync(path.join(dir, 'pkg'));
    expect(gitRemoteOf(path.join(dir, 'pkg'))).toBeNull();
    expect(gitRemoteOf(path.join(tmp, 'nope'))).toBeNull();
  });
  it('worktree は元のリポジトリの config から読む', () => {
    const main = repo('main', '[remote "origin"]\n\turl = https://github.com/me/main.git\n');
    const gitdir = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    expect(gitRemoteOf(wt)).toBe('github.com/me/main');
    expect(gitFolderOf(wt)).toEqual({ git: true, worktree: true });
    expect(gitFolderOf(main)).toEqual({ git: true, worktree: false });
    expect(gitFolderOf(path.join(tmp, 'nope'))).toEqual({ git: false, worktree: false });
  });
  it('サブモジュール（.git がファイルで commondir の無いもの）は、その gitdir の config から読み、worktree としない', () => {
    const gitdir = path.join(tmp, 'parent', '.git', 'modules', 'sub');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'config'), '[remote "origin"]\n\turl = https://github.com/me/sub.git\n');
    const sub = path.join(tmp, 'parent', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    expect(gitRemoteOf(sub)).toBe('github.com/me/sub');
    expect(gitFolderOf(sub)).toEqual({ git: true, worktree: false });
  });
});
