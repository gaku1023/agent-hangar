import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 道具（tmux、claude、code、node）の探し方。OS で変わるのは、PATH の区切り、実行できるかの見分け方、既知の置き場である。

/** PATH を項目に分ける。空の項目は飛ばす。Windows では項目を囲む引用符を外す。 */
export function splitPathEnv(pathEnv: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const items = (pathEnv ?? '').split(platform === 'win32' ? ';' : ':');
  return items.map((s) => (platform === 'win32' ? s.trim().replace(/^"(.*)"$/, '$1') : s)).filter(Boolean);
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** 名前に補う拡張子。Windows 以外は補わないので、空文字 1 つを返す。 */
export function pathExts(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [''];
  const raw = env.PATHEXT && env.PATHEXT.trim() !== '' ? env.PATHEXT : DEFAULT_PATHEXT;
  return raw.split(';').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * 実行できるファイルか。
 * macOS と Linux は実行権を見る。Windows には実行権が無いので、拡張子が PATHEXT にあるかで見る。
 */
export function isExecutableFile(p: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform === 'win32') return pathExts(env, platform).includes(path.extname(p).toLowerCase());
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 並べたディレクトリから、実行できるファイルとしてのコマンドを順に探す。 */
export function findInDirs(cmd: string, dirs: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const exts = pathExts(env, platform);
  // 拡張子まで書かれた名前（psmux.exe）は、そのまま探す。
  const names = platform === 'win32' && !exts.includes(path.extname(cmd).toLowerCase()) ? exts.map((e) => cmd + e) : [cmd];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (isExecutableFile(p, env, platform)) return p;
    }
  }
  return null;
}

/**
 * PATH に無くても見に行く置き場。
 * macOS の .app は PATH が /usr/bin:/bin:/usr/sbin:/sbin だけになる。Windows でも、入れた直後の道具は動いているプロセスの PATH に無い。
 * claude のネイティブ版はどの OS でもホームの .local/bin に入る。Windows の winget は Links に別名を置く。
 */
export function knownDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, homedir: string = os.homedir()): string[] {
  if (platform === 'win32') {
    const home = env.USERPROFILE ?? homedir;
    const dirs = [path.join(home, '.local', 'bin')];
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    return dirs;
  }
  const home = env.HOME ?? homedir;
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local')];
}

/**
 * 設定の値がコマンドの名前（tmux など）か。
 * 区切りを含まず ~ で始まらないものは、起動のときに PATH から探す。Windows ではドライブの指定（C:）も名前ではない。
 */
export function isCommandName(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (p.startsWith('~') || p.includes('/')) return false;
  if (platform === 'win32' && (p.includes('\\') || /^[A-Za-z]:/.test(p))) return false;
  return true;
}

/** .cmd と .bat は、Node が直には起こせない。cmd.exe を通す必要がある。 */
export function needsShell(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(file);
}

/** tmux の役を担う道具の名前。Windows では psmux を先に探す。psmux は tmux という別名でも入る。 */
export function MUX_NAMES(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['psmux', 'tmux'] : ['tmux'];
}
