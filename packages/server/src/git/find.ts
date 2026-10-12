import fs from 'node:fs';
import path from 'node:path';
import { isExecutableFile } from '../platform/exec.ts';
import { which } from '../config/tools.ts';

// git の探し方。git の表示（status.ts）と、始める前の確認の git の行（config/readiness.ts）が使う。

export type GitHost = { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; which: (name: string) => string | null; isExec: (p: string) => boolean };

export function defaultGitHost(): GitHost {
  return { platform: process.platform, env: process.env, which: (n) => which(n), isExec: (p) => isExecutableFile(p) };
}

/** macOS の開発ツールの git。/usr/bin/git はこれを起こす入れ物である。 */
const MAC_DEVELOPER_GIT = ['/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git'];

/**
 * git の実行ファイルを探す。見つからなければ null。
 * macOS の /usr/bin/git は、コマンドライン・デベロッパツールが無いと、起こしただけで入れる窓を出す。開発ツールの git があるときだけ使う。
 * Windows は PATH（git.exe）に無ければ、Git for Windows の決まった場所（Program Files と、利用者ごとに入れた LOCALAPPDATA）を見る。
 */
export function findGit(h: GitHost = defaultGitHost()): string | null {
  const onPath = h.which('git');
  if (onPath) {
    if (h.platform === 'darwin' && onPath === '/usr/bin/git' && !MAC_DEVELOPER_GIT.some((p) => h.isExec(p))) return null;
    return onPath;
  }
  if (h.platform !== 'win32') return null;
  const bases = [h.env.ProgramFiles, h.env['ProgramFiles(x86)'], h.env.LOCALAPPDATA ? path.win32.join(h.env.LOCALAPPDATA, 'Programs') : undefined];
  for (const b of bases) {
    if (!b) continue;
    const p = path.win32.join(b, 'Git', 'cmd', 'git.exe');
    if (h.isExec(p)) return p;
  }
  return null;
}

export { gitInstallCommand } from '@agent-hangar/shared';

/** 見つけた git を覚えておく。毎回 PATH を歩かない。見つからなかったときは覚えず、入れた後に見つかるようにする。 */
let cached: string | null = null;
export function gitPath(): string | null {
  if (cached && fs.existsSync(cached)) return cached;
  cached = findGit();
  return cached;
}
