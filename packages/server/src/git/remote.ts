import fs from 'node:fs';
import path from 'node:path';

/**
 * git の remote を、PC をまたいで同じリポジトリと見分けるための形にそろえる（`<ホスト>/<パス>`。例 `github.com/owner/repo`）。
 * ssh（`git@host:owner/repo.git`、`ssh://git@host:22/owner/repo`）と https を同じ形に読む。
 * 資格情報（`user:token@`）、ポート、問い（`?`）と断片（`#`）、末尾の `.git` と `/` は入れない。
 * ホストは小文字にし、パスの大文字小文字は残す（比べるときは sameRemote が大文字小文字を無視する）。
 * 手元のパス（`/srv/repo.git`、`file://`、`../x`、`C:\x`）と、パスの無いものは null である。ほかの PC と比べる意味が無いからである。
 */
export function normalizeRemote(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  let host: string;
  let rest: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (scheme) {
    if (scheme[1]!.toLowerCase() === 'file') return null;
    const body = scheme[2]!;
    const slash = body.indexOf('/');
    const authority = slash < 0 ? body : body.slice(0, slash);
    rest = slash < 0 ? '' : body.slice(slash + 1);
    // 資格情報は @ の前にある。ポートは : の後ろにある。
    host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
  } else {
    // scp の形（[user@]host:path）。1 字のホストは Windows のドライブ（C:\、C:/）なので取らない。
    const scp = /^(?:[^@/\\\s]+@)?([^:/\\\s]{2,}):(.+)$/.exec(url);
    if (!scp) return null;
    host = scp[1]!;
    rest = scp[2]!;
  }
  host = host.toLowerCase();
  const p = rest.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '');
  if (!host || !p) return null;
  return `${host}/${p}`;
}

/** 2 つの remote（正規化した形）が同じリポジトリか。大文字小文字は無視する。どちらかが null なら同じでない。 */
export function sameRemote(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * dir の直下の .git から、git の管理の場所（config を読む場所）と、worktree かどうかを求める。
 * .git がフォルダならそこ、ファイル（worktree とサブモジュール）なら gitdir の先で、commondir があればその先を使う。
 * dir の直下に .git が無ければ null（git の外か、リポジトリの中の下のフォルダ）。
 */
function gitDirOf(dir: string): { configDir: string; worktree: boolean } | null {
  const dotGit = path.join(dir, '.git');
  const st = fs.statSync(dotGit, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isDirectory()) return { configDir: dotGit, worktree: false };
  if (!st.isFile()) return null;
  let text: string;
  try { text = fs.readFileSync(dotGit, 'utf8'); } catch { return null; }
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const gitdir = path.resolve(dir, m[1]!.trim());
  try {
    const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
    return { configDir: common, worktree: true };
  } catch {
    return { configDir: gitdir, worktree: false };
  }
}

/**
 * dir が git のフォルダ（直下に .git を持つ）か、worktree か。子プロセスは起こさない。
 * リポジトリの中の下のフォルダは git のフォルダに数えない（フォルダの一覧の git の印に使う）。
 */
export function gitFolderOf(dir: string): { git: boolean; worktree: boolean } {
  const g = gitDirOf(dir);
  return { git: g !== null, worktree: g?.worktree ?? false };
}

/**
 * git の config から remote の url を読む。origin を先に、無ければファイルの中で最初の remote を使う。
 * include や insteadOf の書き換えは見ない。
 */
function remoteUrlOf(configText: string): string | null {
  const urls = new Map<string, string>();
  let section: string | null = null;
  for (const line of configText.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('[')) {
      const m = /^\[\s*remote\s+"([^"]*)"\s*\]/i.exec(s);
      section = m ? m[1]! : null;
      continue;
    }
    if (section === null || urls.has(section)) continue;
    const kv = /^url\s*=\s*(.*)$/i.exec(s);
    if (kv) urls.set(section, kv[1]!.replace(/^"(.*)"$/, '$1').trim());
  }
  return urls.get('origin') ?? urls.values().next().value ?? null;
}

/**
 * dir のリポジトリの remote を、正規化した形で返す（normalizeRemote）。
 * 見るのは dir の直下の .git だけである。リポジトリの中の下のフォルダを登録したプロジェクトに、親のリポジトリの remote を付けないためである。
 * worktree は元のリポジトリの config を読む。git でない、remote が無い、読めないときは null。
 */
export function gitRemoteOf(dir: string): string | null {
  const g = gitDirOf(dir);
  if (!g) return null;
  let text: string;
  try { text = fs.readFileSync(path.join(g.configDir, 'config'), 'utf8'); } catch { return null; }
  const url = remoteUrlOf(text);
  return url ? normalizeRemote(url) : null;
}
