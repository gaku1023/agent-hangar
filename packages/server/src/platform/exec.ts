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

/** npm の包みとして読む .cmd の大きさの上限。cmd-shim の包みは 1KB に満たない。 */
const SHIM_MAX_BYTES = 64 * 1024;

/**
 * npm が Windows の PATH に置く .cmd の包み（cmd-shim）が実行ファイル（.exe）を指していれば、その .exe の場所を返す。読めなければ file をそのまま返す。
 * .cmd は cmd.exe 越しにしか起こせず、改行や引用符や `&` を含む引数（初期プロンプトなど）を安全に渡せない。
 * 指す先が .exe なら、包みを通さずに直に起こせる。@opencode/cli 2.x の bin は `bin/opencode.exe` で、包みは `"%dp0%\node_modules\@opencode\cli\bin\opencode.exe" %*` の 1 行で起こす。
 * 指す先が node の台本（.js など）の包みは読み替えない。
 */
export function resolveNpmExeShim(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || !/\.cmd$/i.test(file)) return file;
  const text = readShim(file);
  if (text === null) return file;
  // 包みの最後の起動の行の、%dp0%（古い包みは %~dp0）から見た .exe の場所。後ろに %* が続くものだけを見る。
  const rel = [...text.matchAll(/"%~?dp0%?\\([^"\r\n]+?\.exe)"\s*%\*/gi)].at(-1)?.[1];
  if (!rel) return file;
  const target = path.join(path.dirname(file), ...rel.split(/[\\/]+/));
  return isFile(target) ? target : file;
}

/** Codex の対の包みの名前と、vendor の下の置き場の名前（@openai/codex の bin/codex.js の表と同じ）。 */
const CODEX_WIN_TARGET: Partial<Record<string, { pkg: string; triple: string }>> = {
  x64: { pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  arm64: { pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

/**
 * npm で入れた Codex（@openai/codex）の .cmd の包みから、本体の codex.exe の場所を返す。読めなければ file をそのまま返す。
 * 包みは node の台本（`node_modules\@openai\codex\bin\codex.js`）を指すので、resolveNpmExeShim では .exe に読み替えられない。
 * 台本は対の包み（@openai/codex-win32-x64 など）の `vendor/<triple>/bin/codex.exe` を起こすだけなので、その .exe を直に起こす。
 * 対の包みは @openai/codex の中に入れ子で入る（npm の既定）か、node_modules の直下に引き上げられる。古い版は @openai/codex の中の vendor に持つ。
 */
export function resolveCodexNpmShim(file: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform !== 'win32' || !/\.cmd$/i.test(file)) return file;
  const target = CODEX_WIN_TARGET[arch];
  if (!target) return file;
  const text = readShim(file);
  if (text === null || !/"%~?dp0%?\\node_modules\\@openai\\codex\\bin\\codex\.js"\s*%\*/i.test(text)) return file;
  const root = path.join(path.dirname(file), 'node_modules');
  const pkg = path.join(root, '@openai', 'codex');
  const tail = ['vendor', target.triple, 'bin', 'codex.exe'];
  const candidates = [
    path.join(pkg, 'node_modules', '@openai', target.pkg, ...tail),
    path.join(root, '@openai', target.pkg, ...tail),
    path.join(pkg, ...tail),
  ];
  return candidates.find(isFile) ?? file;
}

function readShim(file: string): string | null {
  try {
    if (fs.statSync(file).size > SHIM_MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
