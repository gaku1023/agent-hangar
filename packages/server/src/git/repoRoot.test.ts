import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitRootOf, repoRoot } from './repoRoot.ts';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-reporoot-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** .git をフォルダで持つリポジトリと、その worktree を作る（git は起こさない）。 */
function repoWithWorktree(): { repo: string; wt: string } {
  const repo = path.join(tmp, 'repo');
  const gitdir = path.join(repo, '.git', 'worktrees', 'wt');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  const wt = path.join(repo, '.claude', 'worktrees', 'wt');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
  fs.mkdirSync(path.join(repo, 'pkg', 'a'), { recursive: true });
  return { repo, wt };
}

describe('gitRootOf', () => {
  it('リポジトリの中のフォルダは、リポジトリの根にまとめる', () => {
    const { repo } = repoWithWorktree();
    expect(gitRootOf(path.join(repo, 'pkg', 'a'))).toEqual({ root: repo, found: true, worktree: false });
  });
  it('worktree とその中のフォルダは、元のリポジトリの根にまとめ、worktree の印を立てる', () => {
    const { repo, wt } = repoWithWorktree();
    expect(gitRootOf(wt)).toEqual({ root: repo, found: true, worktree: true });
    expect(gitRootOf(path.join(wt, 'src'))).toEqual({ root: repo, found: true, worktree: true });
  });
  it('git の外は、渡したフォルダそのもの', () => {
    const dir = path.join(tmp, 'plain', 'x');
    fs.mkdirSync(dir, { recursive: true });
    expect(gitRootOf(dir)).toEqual({ root: dir, found: false, worktree: false });
    expect(repoRoot(dir)).toBe(dir);
  });
  it('無いフォルダも、上へたどって決める', () => {
    const { repo } = repoWithWorktree();
    expect(repoRoot(path.join(repo, 'gone', 'deep'))).toBe(repo);
  });
});
