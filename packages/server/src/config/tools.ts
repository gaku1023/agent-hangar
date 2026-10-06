import type { Settings } from './paths.ts';
import { findInDirs, knownDirs, MUX_NAMES, splitPathEnv } from '../platform/exec.ts';

/** PATH を読む。Windows の環境変数は大文字小文字を区別しないが、試験が渡す素のオブジェクトは区別する。 */
const pathOf = (env: NodeJS.ProcessEnv): string | undefined => env.PATH ?? env.Path;

/**
 * PATH だけからコマンドの絶対パスを探す。
 * 名前だけの設定（tmux など）は、起動のときに子プロセスが PATH から探すので、確かめるときも同じ所だけを見る。
 */
export function findOnPath(cmd: string, pathEnv: string | undefined = pathOf(process.env)): string | null {
  return findInDirs(cmd, splitPathEnv(pathEnv));
}

/**
 * 子プロセスを起こさずにコマンドの絶対パスを探す。
 * macOS の .app を Finder から起こすと PATH は `/usr/bin:/bin:/usr/sbin:/sbin` だけになるので、既知の置き場も自分で見に行く。
 */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return findInDirs(cmd, [...splitPathEnv(pathOf(env)), ...knownDirs(env)], env);
}

/** tmux の役を担う道具を探す。Windows では psmux を先に見る。 */
export function whichMux(whichFn: (cmd: string) => string | null = which): string | null {
  for (const name of MUX_NAMES()) {
    const found = whichFn(name);
    if (found) return found;
  }
  return null;
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
  return { ...s, tmuxPath: s.tmuxPath ?? whichMux(whichFn), codePath: s.codePath ?? whichFn('code'), claudePath, toolsResolved: true };
}
