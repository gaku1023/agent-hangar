import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Settings } from './paths.ts';

const KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

/**
 * 手元にしか無いツールの置き場所。
 * claude のネイティブ版は `~/.local/bin` に、古い npm 版は `~/.claude/local` に入る。
 * .app を Finder から起こすと PATH は `/usr/bin:/bin:/usr/sbin:/sbin` だけになるので、
 * ここを自分で見に行かなければ claude は見つからない。
 */
function homeDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? os.homedir();
  return [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local')];
}

/** 並べたディレクトリから、実行できるファイルとしてのコマンドを順に探す。 */
function findIn(cmd: string, dirs: string[]): string | null {
  for (const d of dirs) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* 次へ */ }
  }
  return null;
}

/**
 * PATH だけからコマンドの絶対パスを探す。
 * 名前だけの設定（tmux など）は、起動のときに子プロセスが PATH から探すので、確かめるときも同じ所だけを見る。
 */
export function findOnPath(cmd: string, pathEnv: string | undefined = process.env.PATH): string | null {
  return findIn(cmd, (pathEnv ?? '').split(':').filter(Boolean));
}

/** 子プロセスを起こさずにコマンドの絶対パスを探す。GUI 起動の貧弱な PATH でも Homebrew と手元の置き場所を見る。 */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return findIn(cmd, [...(env.PATH ?? '').split(':').filter(Boolean), ...KNOWN_DIRS, ...homeDirs(env)]);
}

/**
 * 設定に無いツールのパスを探して埋める。既に入っている値は変えない。
 * 探すのは最初の一度だけにする。毎回埋め直すと、利用者が Settings で空にした tmuxPath が
 * 次の起動で which の結果に戻ってしまい、「tmux を使わない」設定が固定できない。
 *
 * 後から足した項目は `toolsResolved` では止めない。
 * 既に使っている settings.json には `toolsResolved: true` が入っているので、
 * 一括で止めると新しい項目が永久に埋まらないからである。
 * 「まだ探していない」は項目が無いこと（undefined）で表し、
 * 利用者が Settings で空にした null とは区別する。
 */
export function resolveToolPaths(s: Settings, whichFn: (cmd: string) => string | null = which): Settings {
  const claudePath = s.claudePath === undefined ? whichFn('claude') : s.claudePath;
  if (s.toolsResolved) return s.claudePath === undefined ? { ...s, claudePath } : s;
  return { ...s, tmuxPath: s.tmuxPath ?? whichFn('tmux'), codePath: s.codePath ?? whichFn('code'), claudePath, toolsResolved: true };
}
