import os from 'node:os';
import path from 'node:path';
import type { Settings } from './paths.ts';
import { findInDirs, knownDirs, MUX_NAMES, resolveNpmExeShim, splitPathEnv } from '../platform/exec.ts';

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

/**
 * opencode を探す（ベータ）。PATH の次に公式の install の台本の置き場（~/.opencode/bin）を見て、最後に既知の置き場を見る。
 * 台本はシェルの rc で PATH の先頭に足すだけなので、Finder から起こした .app の PATH には入らない。
 * 台本で入れた人のシェルでは Homebrew より先に引かれるので、既知の置き場（/opt/homebrew/bin など）より前に置く。
 * 設定には場所を埋めない。見つけた場所は、版を読むたびと起動のたびにこれで引き直す。
 * Windows で npm の .cmd の包みを見つけたら、包みが指す .exe を返す（platform/exec.ts の resolveNpmExeShim）。
 */
export function findOpencode(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) ?? os.homedir();
  const found = findInDirs('opencode', [...splitPathEnv(pathOf(env)), path.join(home, '.opencode', 'bin'), ...knownDirs(env)], env);
  // Windows で npm で入れた opencode は、PATH に opencode.cmd（npm の包み）が置かれる。包みが指す opencode.exe を直に起こす。
  return found === null ? null : resolveNpmExeShim(found);
}

/**
 * codex を探す（ベータ）。PATH と既知の置き場だけを見る。ChatGPT.app の同梱の codex は使わない（版が利用者の入れたものと別で、hangar の確かめた版を持てないため）。
 * 設定には場所を埋めない。見つけた場所は、版を読むたびと起動のたびにこれで引き直す。
 */
export function findCodex(env: NodeJS.ProcessEnv = process.env): string | null {
  const found = which('codex', env);
  return found === null ? null : resolveNpmExeShim(found);
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
  // エディタは設定に場所を埋めない。開くたびに表の場所から探す（external/editors.ts）。
  return { ...s, tmuxPath: s.tmuxPath ?? whichMux(whichFn), claudePath, toolsResolved: true };
}
