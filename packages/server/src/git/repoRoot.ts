import fs from 'node:fs';
import path from 'node:path';

/**
 * git のリポジトリの根を、子プロセスを起こさずに探す。
 * dir から上へたどり、最初に見つけた .git の場所を根にする。
 * worktree（.git がファイル）は gitdir の commondir をたどり、元のリポジトリの根にする（worktree は true）。
 * git の外なら dir そのものを返す（found は false）。
 * 指示とメモリの欄（自動メモリの場所）と、Claude Code と会話したフォルダの候補（projects/candidates.ts）が使う。
 */
export function gitRootOf(dir: string): { root: string; found: boolean; worktree: boolean } {
  for (let d = dir; ; d = path.dirname(d)) {
    const dotGit = path.join(d, '.git');
    let st: fs.Stats | null = null;
    try { st = fs.statSync(dotGit); } catch { st = null; }
    if (st?.isDirectory()) return { root: d, found: true, worktree: false };
    if (st?.isFile()) {
      let text = '';
      try { text = fs.readFileSync(dotGit, 'utf8'); } catch { return { root: d, found: true, worktree: false }; }
      const m = /^gitdir:\s*(.+)$/m.exec(text);
      if (!m) return { root: d, found: true, worktree: false };
      const gitdir = path.resolve(d, m[1]!.trim());
      try {
        const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
        return path.basename(common) === '.git' ? { root: path.dirname(common), found: true, worktree: true } : { root: d, found: true, worktree: false };
      } catch {
        return { root: d, found: true, worktree: false };
      }
    }
    if (path.dirname(d) === d) return { root: dir, found: false, worktree: false };
  }
}

/** git のリポジトリの根。worktree は元のリポジトリの根で、git の外なら dir そのものである（gitRootOf）。 */
export function repoRoot(dir: string): string {
  return gitRootOf(dir).root;
}
