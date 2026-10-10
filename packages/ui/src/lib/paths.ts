/**
 * 画面に出すパスを扱う小さな関数。
 * パスはサーバの OS の形で届く（macOS と Linux は `/Users/a/proj`、Windows は `C:\Users\a\proj`）。
 * 画面を開いている PC とサーバは同じ PC なので、形はふつう画面の OS とそろうが、ここではまずパスの形そのもので見分ける。
 * 形から決まらないとき（`~` だけ、名前だけ）に限り、呼び手が渡す既定か、画面の OS（clientPlatform）に従う。
 *
 * Windows の形では `\` と `/` のどちらも区切りとして読む。
 * macOS と Linux の形では `\` は名前に使える字なので、区切りにしない（これまでの表示を変えないため）。
 */
import { clientPlatform } from '../keys.ts';

export type Sep = '/' | '\\';

const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/;

/** Windows の形のパスか。ドライブ（`C:`）、UNC（`\\server`）、`~\`、`\` を含む相対パスを Windows の形とみる。 */
export function isWindowsPath(p: string): boolean {
  if (DRIVE.test(p) || p.startsWith('\\\\')) return true;
  if (p.startsWith('/') || p.startsWith('~/')) return false;
  return p.includes('\\');
}

/** 区切りの位置か。Windows の形では `\` と `/` の両方、そうでなければ `/` だけ。 */
const sepTest = (win: boolean) => (c: string | undefined): boolean => c === '/' || (win && c === '\\');

/** 画面の OS の区切り。形から決まらないときの既定に使う。 */
const platformSep = (): Sep => (clientPlatform() === 'win32' ? '\\' : '/');

/**
 * パスの区切り。つなぐときはこの区切りで書き、元の書き方に合わせる。
 * Windows の形は `\` を含めば `\`、`/` だけで書かれていれば `/`、ドライブだけなら `\`。
 * 区切りが 1 つも無いもの（`~`、名前だけ）は、渡された既定（無ければ画面の OS の区切り）にする。
 */
export function pathSep(p: string, fallback?: Sep): Sep {
  if (isWindowsPath(p)) return p.includes('\\') || !p.includes('/') ? '\\' : '/';
  if (p.includes('/')) return '/';
  return fallback ?? platformSep();
}

/** 根だけのパスか（`/`、`C:`、`C:\`、`\\`）。 */
function isRoot(p: string): boolean {
  return /^[\\/]+$/.test(p) || /^[A-Za-z]:[\\/]*$/.test(p);
}

/** 末尾の区切りを外す。外すと根が欠けるもの（`/`、`C:\`）は、そのまま返す。 */
function trimEnd(p: string): string {
  if (isRoot(p)) return p;
  const isSep = sepTest(isWindowsPath(p));
  let end = p.length;
  while (end > 0 && isSep(p[end - 1])) end--;
  return end === 0 ? p : p.slice(0, end);
}

/** 最後の区切りの位置。無ければ -1。 */
function lastSep(p: string): number {
  const isSep = sepTest(isWindowsPath(p));
  for (let i = p.length - 1; i >= 0; i--) if (isSep(p[i])) return i;
  return -1;
}

/** 最後の区切りで分ける。dir は区切りを含む（`/w/app/` と `a.ts`）。区切りが無ければ dir は空。末尾の区切りは外さない。 */
export function splitLast(p: string): { dir: string; base: string } {
  const i = lastSep(p);
  return { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

/** 最後の名前。末尾の区切りは無視する。根だけのパス（`/`、`C:\`）は、そのまま返す。 */
export function baseName(p: string): string {
  if (isRoot(p)) return p;
  return splitLast(trimEnd(p)).base || p;
}

/** 根だけのパスか。名前を取り出せないパスを見分けるのに使う。 */
export function isRootPath(p: string): boolean {
  return p !== '' && isRoot(p);
}

/** 親のパス。末尾の区切りは付けない。親が根なら根（`/`、`C:\`）を、区切りが無ければ空を返す。 */
export function dirName(p: string): string {
  const { dir } = splitLast(trimEnd(p));
  if (dir === '') return '';
  return trimEnd(dir);
}

/**
 * 親のパスと名前をつなぐ。区切りは親の書き方に合わせ、末尾の区切りを重ねない。
 * 親に区切りが無いとき（`~` だけ）は、渡された既定（無ければ画面の OS の区切り）でつなぐ。
 */
export function joinPath(root: string, name: string, fallback?: Sep): string {
  if (root === '') return name;
  const sep = pathSep(root, fallback);
  const head = trimEnd(root);
  return sepTest(isWindowsPath(head))(head.at(-1)) ? `${head}${name}` : `${head}${sep}${name}`;
}

/** 末尾に区切りを 1 つ付ける。もう付いていれば、そのまま返す。 */
export function withTrailingSep(p: string): string {
  return sepTest(isWindowsPath(p))(p.at(-1)) ? p : `${p}${pathSep(p)}`;
}

/**
 * ホームの下の置き場を、~ で始まる形に縮める。区切りは元の書き方のまま残す。
 * ホームのディレクトリは View が知らないので、`/Users/<名前>/`、`/home/<名前>/`、`<ドライブ>:\Users\<名前>\` の形で見分ける。
 * ホームの下でなければそのまま返す。
 */
export function homePath(p: string): string {
  const posix = /^\/(?:Users|home)\/[^/]+(?:\/(.*))?$/.exec(p);
  if (posix) {
    const rest = posix[1] ?? '';
    return rest === '' ? '~' : `~/${rest}`;
  }
  const win = /^[A-Za-z]:([\\/])Users[\\/][^\\/]+(?:([\\/])(.*))?$/i.exec(p);
  if (!win) return p;
  const rest = trimEnd(win[3] ?? '');
  return rest === '' || isRoot(rest) ? '~' : `~${win[2]}${rest}`;
}

/**
 * 比べるための形。Windows の形は区切りを `/` にそろえ、大文字小文字を区別しない（Windows のファイルシステムに合わせる）。
 * 区切りの読み替えは字数を変えないので、そろえた形の長さで元のパスを切れる。
 */
function comparable(p: string, win: boolean): string {
  return win ? p.replaceAll('\\', '/') : p;
}

/** 根の下に入るときの頭（`/w/app/`、`c:/w/app/`）。根そのものなら `/` や `c:/` になる。 */
function underPrefix(root: string, win: boolean): string {
  const r = comparable(trimEnd(root), win);
  return r.endsWith('/') ? r : `${r}/`;
}

const sameHead = (p: string, prefix: string, win: boolean): boolean => {
  const head = p.slice(0, prefix.length);
  return win ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
};

/** 作業ディレクトリの下のパスは、その中からの相対にして短く見せる。外のパスと、作業ディレクトリそのものは、そのまま返す。 */
export function relPath(p: string, cwd: string): string {
  if (!cwd) return p;
  const win = isWindowsPath(cwd) || isWindowsPath(p);
  const prefix = underPrefix(cwd, win);
  const q = comparable(p, win);
  if (!sameHead(q, prefix, win)) return p;
  return p.slice(prefix.length) || p;
}

/** 根の下（直下でも深くても）にあるか。根そのもの（末尾に区切りの無い形）は下に含めない。 */
export function isUnder(p: string, root: string): boolean {
  const win = isWindowsPath(root) || isWindowsPath(p);
  const prefix = underPrefix(root, win);
  const q = comparable(p, win);
  return q.length >= prefix.length && sameHead(q, prefix, win);
}
