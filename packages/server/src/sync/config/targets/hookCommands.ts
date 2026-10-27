/**
 * hooks と statusLine の command を読む（SPEC 6 章）。
 * command の中のパスを、`~`、`$HOME`、`%USERPROFILE%`、ホームの絶対パスのどれも「ホームの下」に読み替え、
 * `~/.claude` の下を指すか、外を指すか、hangar の包みを指すかを判定する。純粋な関数で、ファイルは読まない。
 */

export type HostOs = 'darwin' | 'win32' | 'linux';

/** ホームの絶対パスの代わりに束へ入れる目印。降ろすときに各 PC のホームへ戻す。 */
export const HOME_MARK = '__HANGAR_HOME__';

export const hostOs = (): HostOs => (process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux');

export type CommandRefs = {
  /** `~/.claude` の下を指す、読み出し側のファイル（`~/.claude` からの相対パス、`/` 区切り）。 */
  files: string[];
  /** `~/.claude` の外（ホームの別の場所、他の絶対パス、知らない環境変数の下）を指す語がある。 */
  outside: boolean;
  /** hangar 自身の包み（hangar-run、~/.agent-hangar の下、hangar statusline）を指す。 */
  wrapper: boolean;
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ホームの絶対パスにあたる正規表現。区切りは `\` と `/` のどちらも許し、Windows は大文字小文字を区別しない。 */
function homeRe(home: string, os: HostOs): RegExp {
  const parts = home.split(/[\\/]+/).filter((p) => p !== '');
  const lead = /^[\\/]/.test(home) && !/^[\\/]{2}/.test(home) ? '[\\\\/]' : /^[\\/]{2}/.test(home) ? '[\\\\/]{2}' : '';
  const body = lead + parts.map(escapeRe).join('[\\\\/]+');
  return new RegExp(`${body}(?![A-Za-z0-9_.\\-])`, os === 'win32' ? 'gi' : 'g');
}

/** ホームの絶対パスを目印に置き換える。`~`、`$HOME`、`%USERPROFILE%` の形は、どの PC でも読めるのでそのまま。 */
export function toPortable(cmd: string, home: string, os: HostOs = hostOs()): string {
  if (home === '') return cmd;
  return cmd.replace(homeRe(home, os), HOME_MARK);
}

/** 目印を、この PC のホームへ戻す。 */
export function fromPortable(cmd: string, home: string): string {
  return cmd.split(HOME_MARK).join(home);
}

/** ホームを指す書き方を全部 `~` にそろえる。判定のためだけで、書く中身は変えない。 */
function tildeForm(cmd: string, home: string, os: HostOs): string {
  let s = cmd.split(HOME_MARK).join('~');
  if (home !== '') s = s.replace(homeRe(home, os), '~');
  s = s.replace(/%USERPROFILE%/gi, '~');
  s = s.replace(/\$\{HOME\}/g, '~').replace(/\$HOME(?![A-Za-z0-9_])/g, '~');
  return s;
}

type Word = { text: string; afterRedirect: boolean };

/** 引用符を考えて語に分ける。引用符の外の空白、`| & ; ( ) < >` で区切る。`>` と `<` の次の語には印を付ける（出力先は読み出しではない）。 */
function words(s: string): Word[] {
  const out: Word[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  let redirect = false;
  let pendingRedirect = false;
  const flush = (): void => {
    if (has) { out.push({ text: cur, afterRedirect: redirect }); redirect = false; }
    cur = ''; has = false;
    if (pendingRedirect) { redirect = true; pendingRedirect = false; }
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && c === '\\' && s[i + 1] === '"') { cur += '"'; i++; continue; }
      cur += c; has = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && (s[i + 1] === ' ' || s[i + 1] === '"' || s[i + 1] === "'")) { cur += s[i + 1]!; has = true; i++; continue; }
    if (c === '>' || c === '<') {
      // `2>` の 2 は語の一部ではなく番号。単独の数字だけの語は捨てる。
      if (has && /^\d+$/.test(cur)) { cur = ''; has = false; }
      flush(); pendingRedirect = true; continue;
    }
    if (/\s/.test(c) || c === '|' || c === '&' || c === ';' || c === '(' || c === ')') { flush(); continue; }
    cur += c; has = true;
  }
  flush();
  return out;
}

const WRAPPER_RE = /hangar-run\.(?:sh|mjs)|[\\/]\.agent-hangar(?:[\\/]|$)|~[\\/]\.agent-hangar|\bhangar\s+statusline\b/i;
/** 出力の捨て場など、どの PC にもあって中身の無いデバイス。外を指すものとは数えない。 */
const SAFE_DEVICES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr']);

/** `~/.claude` からの相対パスを整える。`..` を含むなら null（外へ出うる）。 */
function relInClaude(rest: string): string | null {
  const segs = rest.split('/').filter((x) => x !== '' && x !== '.');
  if (segs.some((x) => x === '..')) return null;
  return segs.join('/');
}

export function analyzeCommand(cmd: string, home: string, os: HostOs = hostOs()): CommandRefs {
  const refs: CommandRefs = { files: [], outside: false, wrapper: WRAPPER_RE.test(cmd) };
  const norm = tildeForm(cmd, home, os);
  if (WRAPPER_RE.test(norm)) refs.wrapper = true;
  const files = new Set<string>();
  for (const w of words(norm)) {
    // `--opt=値` と `NAME=値` は値を見る。
    const m = /^(?:--?[A-Za-z][\w-]*|[A-Za-z_]\w*)=(.*)$/s.exec(w.text);
    const t = (m ? m[1]! : w.text).replace(/\\(?!["'])/g, '/');
    if (t === '') continue;
    if (/^\/[A-Za-z?](?::\w*)?$/.test(t)) continue; // cmd.exe の /c /k などのフラグ
    if (t === '~' || t.startsWith('~/')) {
      const rest = t === '~' ? '' : t.slice(2);
      if (rest === '.claude' || rest.startsWith('.claude/')) {
        const rel = relInClaude(rest.slice('.claude'.length));
        if (rel === null) refs.outside = true;
        else if (rel !== '' && !w.afterRedirect && !rest.endsWith('/')) files.add(rel);
      } else refs.outside = true;
      continue;
    }
    if (t.startsWith('~')) { refs.outside = true; continue; } // ~user/...
    if (/^[A-Za-z]:\//.test(t) || t.startsWith('//')) { refs.outside = true; continue; }
    if (t.startsWith('/')) { if (!SAFE_DEVICES.has(t)) refs.outside = true; continue; }
    // 知らない環境変数の下（$CLAUDE_PROJECT_DIR/... など）は、この PC のどこかを指す。
    if (/^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%)\//.test(t)) refs.outside = true;
  }
  refs.files = [...files].sort();
  return refs;
}

/** 運んでよいファイルの置き場か。他の項目の置き場（skills など）、状態、秘密は運ばない。 */
const DENY_NAMES = new Set(['settings.json', 'settings.local.json', '.credentials.json', '.claude.json']);
const DENY_TOP = new Set(['projects', 'plugins', 'todos', 'shell-snapshots', 'statsig', 'ide', 'sessions', 'cache', 'logs', 'skills', 'commands', 'agents', 'memory', 'backups', 'node_modules', '.git']);
export function isCarriedHookFile(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  if (DENY_NAMES.has(rel) || DENY_TOP.has(segs[0]!)) return false;
  if (/\.(log|lock|pid|tmp)$/i.test(rel) || /\.conflict-|\.hangar-tmp-|\.part$/.test(rel)) return false;
  if (segs.length === 1 && (rel === 'CLAUDE.md' || rel === 'keybindings.json')) return false;
  return true;
}
