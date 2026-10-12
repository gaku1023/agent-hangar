import fs from 'node:fs';

/**
 * トランスクリプトから読む git の手がかり。
 * branch は最後の行の gitBranch（Claude Code が行ごとに書く）で、セッションがどのブランチで作業したかを言う。切り離した HEAD（"HEAD"）は null にする。
 * cwd は最後の行の作業ディレクトリで、EnterWorktree で入った worktree はここに出る。
 * worktree は最後の worktree-state で、入っていればその名前と場所と枝。出たあと（worktreeSession が null）は null。
 */
export type TranscriptGitHint = { branch: string | null; cwd: string | null; worktree: { name: string; path: string; branch: string | null } | null };

/** 末尾から読む大きさ。長い会話でもここだけ読む。 */
const TAIL_BYTES = 256 * 1024;

const EMPTY: TranscriptGitHint = { branch: null, cwd: null, worktree: null };

/** 同じファイル（大きさと更新時刻）なら読み直さない。 */
const cache = new Map<string, { key: string; hint: TranscriptGitHint }>();
const MAX_CACHE = 500;

function remember(file: string, key: string, hint: TranscriptGitHint): TranscriptGitHint {
  cache.delete(file);
  cache.set(file, { key, hint });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
  return hint;
}

/** 本文の末尾から、git の手がかりを読む。読めなければ空の手がかり。 */
export function readGitHint(file: string, tailBytes: number = TAIL_BYTES): TranscriptGitHint {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) return EMPTY;
  const key = `${st.size}:${st.mtimeMs}:${tailBytes}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.hint;
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, tailBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return EMPTY;
  }
  const lines = text.split('\n');
  // 途中から読んだときの最初の行は切れているので捨てる。
  if (st.size > tailBytes) lines.shift();
  let branch: string | null | undefined;
  let cwd: string | undefined;
  let worktree: TranscriptGitHint['worktree'] | undefined;
  for (let i = lines.length - 1; i >= 0 && (branch === undefined || cwd === undefined || worktree === undefined); i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (rec.type === 'worktree-state' && worktree === undefined) {
      const w = rec.worktreeSession as Record<string, unknown> | null | undefined;
      worktree = w && typeof w.worktreeName === 'string' && typeof w.worktreePath === 'string' ? { name: w.worktreeName, path: w.worktreePath, branch: typeof w.worktreeBranch === 'string' ? w.worktreeBranch : null } : null;
    }
    if (branch === undefined && typeof rec.gitBranch === 'string' && rec.gitBranch !== '') branch = rec.gitBranch === 'HEAD' ? null : rec.gitBranch;
    if (cwd === undefined && typeof rec.cwd === 'string' && rec.cwd !== '') cwd = rec.cwd;
  }
  return remember(file, key, { branch: branch ?? null, cwd: cwd ?? null, worktree: worktree ?? null });
}
