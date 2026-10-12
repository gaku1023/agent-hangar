import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGitHint } from './hint.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-hint-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const write = (lines: unknown[]) => {
  const f = path.join(tmp, 's.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
};

describe('readGitHint', () => {
  it('最後の gitBranch と cwd を読む', () => {
    const f = write([
      { type: 'user', cwd: '/w/alpha', gitBranch: 'main' },
      { type: 'assistant', cwd: '/w/alpha/.claude/worktrees/fix', gitBranch: 'worktree-fix' },
      { type: 'system', subtype: 'x' },
    ]);
    expect(readGitHint(f)).toEqual({ branch: 'worktree-fix', cwd: '/w/alpha/.claude/worktrees/fix', worktree: null });
  });
  it('worktree-state があれば、入っていた worktree を持つ。出たあとは持たない', () => {
    const entered = write([
      { type: 'user', cwd: '/w/alpha', gitBranch: 'main' },
      { type: 'worktree-state', worktreeSession: { worktreePath: '/w/alpha/.claude/worktrees/fix', worktreeName: 'fix', worktreeBranch: 'worktree-fix', originalCwd: '/w/alpha' } },
      { type: 'user', cwd: '/w/alpha/.claude/worktrees/fix', gitBranch: 'worktree-fix' },
    ]);
    expect(readGitHint(entered).worktree).toEqual({ name: 'fix', path: '/w/alpha/.claude/worktrees/fix', branch: 'worktree-fix' });
    const left = write([
      { type: 'worktree-state', worktreeSession: { worktreePath: '/w/alpha/.claude/worktrees/fix', worktreeName: 'fix', worktreeBranch: 'worktree-fix' } },
      { type: 'worktree-state', worktreeSession: null },
      { type: 'user', cwd: '/w/alpha', gitBranch: 'main' },
    ]);
    expect(readGitHint(left)).toEqual({ branch: 'main', cwd: '/w/alpha', worktree: null });
  });
  it('切り離した HEAD は枝の名前にしない。壊れた行と無いファイルは読み飛ばす', () => {
    const f = path.join(tmp, 'b.jsonl');
    fs.writeFileSync(f, `${JSON.stringify({ cwd: '/w', gitBranch: 'HEAD' })}\n{broken\n`);
    expect(readGitHint(f)).toEqual({ branch: null, cwd: '/w', worktree: null });
    expect(readGitHint(path.join(tmp, 'none.jsonl'))).toEqual({ branch: null, cwd: null, worktree: null });
  });
  it('末尾の決まった大きさだけを読む', () => {
    const f = write([{ cwd: '/old', gitBranch: 'old' }, ...Array.from({ length: 200 }, () => ({ type: 'progress', pad: 'x'.repeat(100) }))]);
    expect(readGitHint(f, 4096)).toEqual({ branch: null, cwd: null, worktree: null });
    expect(readGitHint(f)).toMatchObject({ branch: 'old', cwd: '/old' });
  });
});
