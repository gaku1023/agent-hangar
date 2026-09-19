import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { configKey, isSafeRelPath, type ConfigPreviewAction, type ConfigPreviewDto, type FileEntry, type FileMetaIn } from '@agent-hangar/shared';
import { backupsRoot } from '../config/cloud.ts';
import type { Db } from '../db/open.ts';
import type { CloudClient } from './client.ts';
import { safeDeviceLabel, timestampLabel } from './copy.ts';
import { decryptStream, encryptStream, sha256Hex } from './crypto.ts';
import type { Timers } from './engine.ts';
import type { SyncStateStore } from './state.ts';

/** 上げるときにホームの絶対パスをこの目印に置き換える。ホームの違う端末でも同じ指紋になる。 */
export const HOME_MARKER = '__HANGAR_HOME__';
/** 1 ファイルの上限。設定とメモにしては大きすぎるものは、上げも降ろしもしない。 */
export const CONFIG_MAX_BYTES = 1 << 20;
/** 控えを残す世代の数。これを超えた古い順に消す（利用者の決定 2 の危険 E2）。 */
export const BACKUP_GENERATIONS = 20;

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv']);
const EXCLUDE_FILES = new Set(['.DS_Store']);
const ROOT_FILES = ['CLAUDE.md', 'settings.json'];
const TREES = ['skills', 'memory'];
/** 同期そのものが作る名前。これを対象に入れると、競合の写しが端末間で無限に増える。 */
const OURS_RE = /\.conflict-[^/]*$|\.hangar-tmp-[^/]*$|\.part$/;
/** statusLine のスクリプトとして受け取ってよい名前の形。~/.claude の直下の実行物だけを通す。 */
const SCRIPT_RE = /^[^/]+\.(sh|bash|zsh|js|mjs|cjs|ts|py|rb|pl)$/;
/** 控えの世代のディレクトリ名（timestampLabel と同じ形）。 */
const STAMP_RE = /^\d{8}-\d{6}$/;
const BACKUP_SUBDIR = 'claude-config';
/**
 * まだ取り込んでいない相手の設定の一覧を残す `sync_state` の鍵。
 *
 * RemotePuller は onConfigEntries を呼んだ後に filesSeq を進めるので、
 * 確認を押さずにサーバを起こし直すと、同じ項目は二度と届かない。
 * 一覧をメモリだけに持つと、2 回目の起動で下見が永久に空になり、初回の確認に辿り着けなくなる。
 * SyncStateStore の鍵の型はこのモジュールから増やせないので、同じ表に自前の文で読み書きする。
 */
const PENDING_KEY = 'configPending';
/** 残す一覧の上限。初参加で全部が載ることがあるので、青天井にしない。 */
const MAX_PENDING = 2000;
/**
 * 競合の写しの名前を何回まで試すか。
 * 畳んだ端末名は元の名前と 1 対 1 ではない（「さとうの Mac」も「たなかの Mac」も Mac になる）ので、
 * 同じ秒に同じ名前が当たることがある。当たったら連番を足して、先にある写しを潰さない。
 */
const MAX_CONFLICT_TRIES = 50;
const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };
const toPosix = (p: string): string => p.split(path.sep).join('/');
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type ConfigFile = { rel: string; abs: string; size: number; mtime: number };

/**
 * 監視で拾う相対パスかどうか。
 * statusLine のスクリプトはここに入らないので、listConfigFiles が別に見る。
 */
export function isConfigPath(rel: string): boolean {
  if (!isSafeRelPath(rel)) return false;
  if (EXCLUDE_FILES.has(path.posix.basename(rel))) return false;
  // 段ごとに見る。`x.md.conflict-Mac-.../inner.md` のように、写しの名前のディレクトリの中も対象に戻さない。
  if (rel.split('/').some((seg) => EXCLUDE_DIRS.has(seg) || OURS_RE.test(seg))) return false;
  if (ROOT_FILES.includes(rel)) return true;
  if (TREES.some((t) => rel.startsWith(`${t}/`))) return true;
  return /^projects\/[^/]+\/memory\/.+/.test(rel);
}

/** ホームを指す書き方。どれも `~/.claude/...` と同じに読む。 */
const HOME_PREFIXES = ['~', '$HOME', '${HOME}', HOME_MARKER];

/**
 * コマンド行を語に割る。引用符で囲まれた分は 1 語にまとめる。
 * `sh ~/.claude/statusline.sh --short` のような書き方から道を取り出すために要る。
 */
function commandTokens(cmd: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(cmd); m !== null; m = re.exec(cmd)) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\(.)/g, '$1'));
    else if (m[2] !== undefined) out.push(m[2]);
    else out.push(m[3]!);
  }
  return out;
}

/**
 * 1 つの語を、claudeDir からの相対パスとして読む。外を指していれば null。
 * `~/.claude/x.sh` と `$HOME/.claude/x.sh` は、ホームの下の `.claude` ではなく claudeDir を指すものとして解く。
 * HANGAR_CLAUDE_DIR で置き場を変えていても、意味（設定の入れ物の中）が変わらないようにするためである。
 */
function relFromToken(token: string, claudeDir: string, homeDir: string): string | null {
  let rest: string | null = null;
  for (const prefix of HOME_PREFIXES) {
    if (token === prefix || token.startsWith(`${prefix}/`)) { rest = token.slice(prefix.length); break; }
  }
  let abs: string;
  if (rest !== null) {
    // `~/.claude/...` は設定の入れ物そのものを指す言い回しなので、claudeDir に読み替える。
    if (rest.startsWith('/.claude/')) abs = path.resolve(claudeDir, rest.slice('/.claude/'.length));
    else abs = path.resolve(homeDir, rest.replace(/^\//, ''));
  } else {
    abs = path.isAbsolute(token) ? path.resolve(token) : path.resolve(claudeDir, token);
  }
  const rel = toPosix(path.relative(claudeDir, abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !isSafeRelPath(rel)) return null;
  return OURS_RE.test(rel) ? null : rel;
}

/** settings.json の statusLine.command をそのまま返す。空と読めないものは null。 */
export function statusLineCommand(claudeDir: string): string | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')) as { statusLine?: { command?: string } };
    const cmd = s.statusLine?.command;
    return typeof cmd === 'string' && cmd.trim() !== '' ? cmd : null;
  } catch {
    // 読めない、JSON でない、statusLine が無い。どれも「スクリプトは無い」と同じに扱う。
    return null;
  }
}

/**
 * statusLine.command が指す ~/.claude 配下のスクリプトの相対パスを返す。
 *
 * コマンド行の先頭の 1 語だけを見ると、`sh ~/.claude/statusline.sh` のような書き方で
 * 先頭が `sh` になり、スクリプトが同期の対象から落ちる。
 * そこで語ごとに見て、設定の入れ物の中を指す最初の 1 つを採る。
 *
 * 道の形をした語（`/` を含むか、ホームを指す書き方で始まる語）は、実物が無くても採る。
 * 裸の名前（`statusline.sh`）は、実物があるときだけ採る。
 * この線引きが無いと、`sh` を `<claudeDir>/sh` と読んで取り違える。
 * `-` で始まる語は指定なので見ない。
 */
export function statusLineRel(claudeDir: string, homeDir: string = os.homedir()): string | null {
  const cmd = statusLineCommand(claudeDir);
  if (cmd === null) return null;
  for (const token of commandTokens(cmd)) {
    if (token.startsWith('-')) continue;
    const rel = relFromToken(token, claudeDir, homeDir);
    if (rel === null) continue;
    const shaped = token.includes('/') || HOME_PREFIXES.some((p) => token === p || token.startsWith(`${p}/`));
    if (shaped) return rel;
    try { if (fs.lstatSync(path.join(claudeDir, ...rel.split('/'))).isFile()) return rel; } catch { /* 無ければ次の語へ */ }
  }
  return null;
}

/** 同期する Claude Code の設定ファイルを相対パス順に集める。 */
export function listConfigFiles(claudeDir: string, homeDir: string = os.homedir()): ConfigFile[] {
  const found = new Map<string, ConfigFile>();
  const add = (abs: string): void => {
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return; }
    // シンボリックリンクを辿ると ~/.claude の外の中身を上げてしまう。辿らずに外す。
    if (st.isSymbolicLink() || !st.isFile() || st.size > CONFIG_MAX_BYTES) return;
    const rel = toPosix(path.relative(claudeDir, abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !isSafeRelPath(rel)) return;
    if (rel.split('/').some((seg) => OURS_RE.test(seg)) || EXCLUDE_FILES.has(path.posix.basename(rel))) return;
    found.set(rel, { rel, abs, size: st.size, mtime: Math.floor(st.mtimeMs) });
  };
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name) && !OURS_RE.test(e.name)) walk(abs); }
      else add(abs);
    }
  };
  for (const f of ROOT_FILES) add(path.join(claudeDir, f));
  for (const t of TREES) walk(path.join(claudeDir, t));
  const projects = path.join(claudeDir, 'projects');
  try {
    for (const p of fs.readdirSync(projects, { withFileTypes: true })) if (p.isDirectory()) walk(path.join(projects, p.name, 'memory'));
  } catch { /* projects が無ければ何もしない。 */ }
  const sl = statusLineRel(claudeDir, homeDir);
  if (sl) add(path.join(claudeDir, ...sl.split('/')));
  return [...found.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const MARKER_HEAD = '__HANGAR_HOME';
const MARKER_ESC = `${MARKER_HEAD}E`;
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ホームの絶対パスを目印に置き換える。$HOME の文字列はそのまま残す。
 *
 * 往復が閉じるように 2 つの細工をしている（レビューの中 2）。
 *
 * 1. 中身にもともとある `__HANGAR_HOME` を `__HANGAR_HOMEE` に逃がしてから置き換える。
 *    逃がさないと、`__HANGAR_HOME__` と書いた行が相手の端末でホームの絶対パスに化ける。
 *    このプロジェクト自身の memory はこの文字列を本文に含む。
 * 2. ホームのパスの後ろが、名前を続けられない文字か行末のときだけ置き換える。
 *    `/Users/me` と `/Users/meeting` を切り違えない。
 */
export function normalizeHome(text: string, home: string): string {
  const escaped = text.split(MARKER_HEAD).join(MARKER_ESC);
  if (!home) return escaped;
  return escaped.replace(new RegExp(`${reEscape(home)}(?=$|[^A-Za-z0-9_.\\-])`, 'g'), HOME_MARKER);
}

/** normalizeHome の逆。目印はホームに、逃がした分はもとの文字列に戻す。 */
export function denormalizeHome(text: string, home: string): string {
  return text.replace(new RegExp(`${reEscape(MARKER_HEAD)}(E|__)`, 'g'), (_m, tail: string) => (tail === '__' ? home : MARKER_HEAD));
}

/** UTF-8 のテキストとして扱えるか。NUL を含むものと往復できないものは扱わない。 */
export function isTextBuffer(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

/**
 * 枠そのものはリンクでも構わない（`~/.claude` を別の場所に張っている運用がある）。
 * 解いた実体を枠にして、その中から出ないことを見る。
 */
function fenceOf(root: string): string {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

/**
 * root の下の相対パスを、**段ごとに lstat しながら**絶対パスに直す。
 * 途中のどの段がシンボリックリンクでも投げる。
 *
 * 利用者の決定 12 は「シンボリックリンクは対象から外す」である。
 * 上げる側は歩きながらリンクを飛ばしていたが、降ろす側は末端しか見ていなかった。
 * `~/.claude/skills` が別の場所へのリンクだと、`path.join` はその先を指し、
 * `mkdirSync({ recursive: true })` も `rename` もリンクを辿って ~/.claude の外に書く。
 *
 * 塞ぎ方を「段ごとの lstat」にしたのは、外に出たかどうかを後から判定するのではなく、
 * **リンクを 1 度も辿らせない**方が意図に近いからである（決定 12 の言葉どおりである）。
 * 足りない段は recursive を使わず 1 段ずつ自分で作るので、作る途中でリンクを踏むこともない。
 * 最後に親の realpath が枠の中にあることも見て、競合状態の取りこぼしに備える
 * （`config/claudeJson.ts` と `projects/promote.ts` が同じ作法である）。
 */
function resolveUnder(root: string, rel: string, o: { create?: boolean } = {}): string {
  const segs = rel.split('/');
  if (segs.length === 0 || segs.some((s) => s === '' || s === '.' || s === '..')) throw new Error('相対パスの形が不正です');
  const fence = fenceOf(root);
  let cur = fence;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]!);
    const here = segs.slice(0, i + 1).join('/');
    let st: fs.Stats | null;
    try { st = fs.lstatSync(cur); } catch { st = null; }
    if (st?.isSymbolicLink()) throw new Error(`${here} がシンボリックリンクなので、設定の入れ物の外に出ます`);
    if (i === segs.length - 1) break;
    if (st && !st.isDirectory()) throw new Error(`${here} がディレクトリではありません`);
    if (!st && o.create) fs.mkdirSync(cur, { mode: 0o700 });
  }
  const parent = path.dirname(cur);
  let real: string;
  try { real = fs.realpathSync(parent); } catch { real = parent; }
  if (real !== fence && !real.startsWith(fence + path.sep)) throw new Error(`${rel} は設定の入れ物の外を指しています`);
  return cur;
}

/**
 * 同じ入れ物に一時ファイルを作ってから rename で被せる。
 * 直に書くと、途中で落ちたときに切れた settings.json が ~/.claude に残り、Claude Code がそれを読む。
 * mode を渡すと作るときの権限に使う（上書きでは元のファイルの権限をそのまま引き継ぐ）。
 * 呼び手は必ず resolveUnder で解いた abs を渡す。ここでは入れ物を作らない。
 */
function writeAtomically(abs: string, content: Buffer, mode: number): void {
  const tmp = `${abs}.hangar-tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // 作るときの mode は umask で削られるので、狙いどおりの権限に直してから被せる。
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 片付けられなくても本物は無事である */ }
    throw e;
  }
}

/**
 * まだ無い名前のときだけ書く。既にあれば false を返し、中身には一切触らない。
 * `wx` で開くので、確かめてから書くまでの隙間で割り込まれることがない。
 */
function writeNewFile(abs: string, content: Buffer, mode: number): boolean {
  let fd: number;
  try {
    fd = fs.openSync(abs, 'wx', mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.rmSync(abs, { force: true }); } catch { /* 片付けられなくても、名前は自分が作ったものである */ }
    throw e;
  } finally { fs.closeSync(fd); }
  // 作るときの mode は umask で削られるので、狙いどおりの権限に直す。
  fs.chmodSync(abs, mode);
  return true;
}

/**
 * 負けた方を `<名前>.conflict-<端末名>-<時刻>` として隣に残す（利用者の決定 6）。
 * 端末名は safeDeviceLabel で畳むので、同じ名前に当たりうる。
 * 当たったら連番を足す。写しが写しを潰したら、残す意味が無くなる。
 */
function writeConflictCopy(baseAbs: string, label: string, stamp: string, content: Buffer, mode: number): string {
  const dir = path.dirname(baseAbs);
  const prefix = `${path.basename(baseAbs)}.conflict-${label}-`;
  // 同じ中身の写しが既にあるなら作らない。
  // 手元が勝った競合の後の push が失敗し続けると、取り込みのたびに同じ写しが積もる（レビューの中 4）。
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { /* 読めなければ作る側に倒す */ }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const cand = path.join(dir, n);
    try {
      if (fs.lstatSync(cand).isFile() && fs.readFileSync(cand).equals(content)) return cand;
    } catch { /* 読めないものは比べない */ }
  }
  const head = `${baseAbs}.conflict-${label}-${stamp}`;
  for (let i = 1; i <= MAX_CONFLICT_TRIES; i++) {
    const cand = i === 1 ? head : `${head}-${i}`;
    if (writeNewFile(cand, content, mode)) return cand;
  }
  throw new Error('競合の写しを置く名前が空いていません');
}

/**
 * 書いた後、相手の更新時刻に揃える。
 * 揃えないと手元の時刻が必ず「今」になり、次から新旧の比較ができなくなる。
 * Task 14 の puller が降ろした本文に対してしているのと同じことである。
 */
function applyMtime(abs: string, mtime: number): void {
  try { fs.utimesSync(abs, new Date(mtime), new Date(mtime)); } catch { /* 揃えられなくても中身は正しい */ }
}

/**
 * 既存の権限を引き継ぐ。
 * 無ければ 0600 で置く。相手から届いただけのファイルに実行の許しは付けない（レビューの中 3）。
 * 実行できる形にするのは、`settings.json` の statusLine がそれを指したときだけで、取り込みの最後に行う。
 */
function modeFor(abs: string, _content: Buffer): number {
  try { return fs.lstatSync(abs).mode & 0o777; } catch { /* 無ければ既定に落ちる */ }
  return 0o600;
}

/**
 * 上書きの前に控えを取る。
 * 置き場は ~/.agent-hangar/backups/claude-config/<yyyyMMdd-HHmmss>/<相対パス> である。
 * 既存ファイルが無ければ控えは要らないので何もせず null を返す。
 * 写せなければ throw する。呼び手はそのファイルの書き戻しをやめ、次の pull に回す。
 *
 * 写す元も resolveUnder で解く。途中の段がリンクだと、~/.claude の外のファイルを控えに取ってしまう。
 * 同じ stamp に同じ相対パスの控えが既にあるときは、`-2`、`-3` と連番を足して**先にある控えを潰さない**。
 * 秒の分解能しか無いので、同じ秒に 2 度取り込むと利用者の元の中身が失われていた（レビューの中 1）。
 */
export function backupBeforeWrite(o: { home: string; claudeDir: string; rel: string; stamp: string }): string | null {
  const abs = resolveUnder(o.claudeDir, o.rel);
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const stampRoot = path.join(backupsRoot(o.home), BACKUP_SUBDIR, o.stamp);
  fs.mkdirSync(stampRoot, { recursive: true });
  const head = resolveUnder(stampRoot, o.rel, { create: true });
  for (let i = 1; i <= MAX_CONFLICT_TRIES; i++) {
    const dest = i === 1 ? head : `${head}-${i}`;
    // 控えも一時ファイルと rename で置く。途中までの控えは履歴として当てにならない。
    const tmp = `${dest}.hangar-tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      fs.copyFileSync(abs, tmp, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 残っても控えの置き場の中である */ }
      throw e;
    }
    try {
      // 空いている名前を `wx` で押さえてから被せる。rename だけだと先にある控えを潰す。
      fs.closeSync(fs.openSync(dest, 'wx', 0o600));
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 同上 */ }
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    try {
      fs.renameSync(tmp, dest);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 同上 */ }
      throw e;
    }
    return dest;
  }
  throw new Error('控えを置く名前が空いていません');
}

export type ClaudeConfigDeps = {
  db: Db; deviceId: string; deviceName: string; claudeDir: string; home: string;
  client: CloudClient; key: Buffer; state: SyncStateStore;
  enabled: () => boolean;
  onToast: (level: 'info' | 'error', message: string) => void;
  now?: () => number; debounceMs?: number; timers?: Timers; homeDir?: string;
  /** 控えを残す世代の数。既定は BACKUP_GENERATIONS。 */
  backupGenerations?: number;
};

type SyncRow = { sha256: string };

/**
 * 残しておいた一覧の 1 件が、相手の設定の項目として読めるか。
 * 自分で書いた JSON だが、手で書き換えられることも版が変わることもあるので、読むときに形を見る。
 */
function isConfigEntry(v: unknown): v is FileEntry {
  const e = v as Partial<FileEntry> | null;
  return (
    !!e && typeof e.key === 'string' && typeof e.path === 'string' && e.kind === 'config' &&
    typeof e.sha256 === 'string' && typeof e.size === 'number' && typeof e.mtime === 'number' &&
    typeof e.seq === 'number' && typeof e.deviceId === 'string' &&
    typeof e.uploadedAt === 'number' && typeof e.storedSize === 'number' && typeof e.encrypted === 'boolean'
  );
}
type Decision = { action: ConfigPreviewAction; localMtime: number | null; remoteNewer: boolean; blocked: string | null };

/**
 * Claude Code のユーザー設定を端末間で合わせる。
 * ~/.claude に書くのは、Settings で有効にして取り込みを確認したときだけである。
 * 書き戻しは必ず控えを取った後に行い、控えが取れなければ 1 バイトも書かない（利用者の決定 2）。
 */
export class ClaudeConfigSync {
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  /**
   * 同じ失敗を鳴らし続けないための覚え書き。鍵ごとに「鳴らしたときの中身の印」を持つ。
   *
   * 取り込みは 30 秒ごとに回るので、直しようのない 1 件（手元がリンクである、指紋が合わない、など）が
   * あると画面が鳴り続ける。索引器の reportedErrors と Task 14 の間引きと同じ考えで、
   * 最初の 1 度だけ鳴らし、中身が変わったら数え直す。
   * 起こし直すと忘れるので、そのときだけもう一度鳴る（Task 14 と同じ割り切りである）。
   */
  private readonly reportedErrors = new Map<string, string>();

  constructor(private readonly deps: ClaudeConfigDeps) {}

  /** 印が前と同じなら黙る。違えば鳴らして覚え直す。 */
  private reportOnce(id: string, stamp: string, message: string): void {
    if (this.reportedErrors.get(id) === stamp) return;
    this.reportedErrors.set(id, stamp);
    this.deps.onToast('error', message);
  }

  /** 片付いたら忘れる。次に同じところで転んだら、また 1 度だけ鳴る。 */
  private clearReported(id: string): void { this.reportedErrors.delete(id); }

  private get timers(): Timers { return this.deps.timers ?? REAL_TIMERS; }
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private homeDir(): string { return this.deps.homeDir ?? os.homedir(); }
  private confirmed(): boolean { return this.deps.state.get('configPullConfirmed') === '1'; }

  confirm(): void { this.deps.state.set('configPullConfirmed', true); }
  /** 自動の書き戻しをやめる。一度押したら二度と止められない形にしない（決定 2 の危険 E1）。 */
  unconfirm(): void { this.deps.state.set('configPullConfirmed', null); }
  /** まだ取り込んでいない相手の設定。メモリではなく sync_state から読むので、起こし直しても消えない。 */
  pendingRemote(): FileEntry[] { return this.readPending(); }

  private readPending(): FileEntry[] {
    const row = this.deps.db.prepare('select value from sync_state where key = ?').get(PENDING_KEY) as { value: string } | undefined;
    if (!row) return [];
    let v: unknown;
    try { v = JSON.parse(row.value); } catch { return []; }
    if (!Array.isArray(v)) return [];
    // 残した後に対象の決まりが変わっていることもあるので、読むたびに今の物差しで絞る。
    return v.filter(isConfigEntry).filter((e) => this.accepts(e));
  }

  private writePending(list: FileEntry[]): void {
    if (list.length === 0) {
      this.deps.db.prepare('delete from sync_state where key = ?').run(PENDING_KEY);
      return;
    }
    this.deps.db.prepare('insert into sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
      .run(PENDING_KEY, JSON.stringify(list.slice(0, MAX_PENDING)));
  }

  /** 残してある一覧に、今届いた分を重ねる。同じ鍵は新しい seq の方を採る。 */
  private mergePending(incoming: FileEntry[]): FileEntry[] {
    const byKey = new Map<string, FileEntry>();
    for (const e of this.readPending()) byKey.set(e.key, e);
    for (const e of incoming) {
      if (!isConfigEntry(e) || !this.accepts(e)) continue;
      const cur = byKey.get(e.key);
      if (!cur || e.seq >= cur.seq) byKey.set(e.key, e);
    }
    return [...byKey.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.deps.claudeDir, { recursive: true }, (_e, name) => {
        if (!name) return;
        const rel = toPosix(String(name));
        if (!isConfigPath(rel) && rel !== statusLineRel(this.deps.claudeDir, this.homeDir())) return;
        this.noteChanged();
      });
      this.watcher.on('error', (e) => this.deps.onToast('error', `設定の監視が止まりました: ${errorMessage(e)}`));
    } catch (e) {
      this.deps.onToast('error', `設定の監視を始められません: ${errorMessage(e)}`);
    }
    // 監視は「これから起きる変化」しか拾わない。
    // これだけだと、同期を入れて起こし直しても ~/.claude に触るまで 1 件も上がらない。
    // 起動のたびに 1 度だけ、まるごと走査してから上げる（file_sync と指紋が同じ分は上がらない）。
    this.noteChanged();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * 変化があったことを覚え、5 秒後にまとめて push する。
   * 既にタイマーがあれば引き直さない。書き込みが続く間も窓がずれない。
   */
  noteChanged(): void {
    if (this.timer) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.pushChanged(); }, this.deps.debounceMs ?? 5000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private normalizedBytes(buf: Buffer): Buffer {
    return isTextBuffer(buf) ? Buffer.from(normalizeHome(buf.toString('utf8'), this.homeDir()), 'utf8') : buf;
  }

  private syncedSha(key: string): string | null {
    return (this.deps.db.prepare('select sha256 from file_sync where key = ?').get(key) as SyncRow | undefined)?.sha256 ?? null;
  }

  private remember(e: { key: string; path: string; size: number; mtime: number; deviceId: string; seq: number }, sha: string): void {
    this.deps.db.prepare(`insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)
      on conflict(key) do update set path = excluded.path, device_id = excluded.device_id, sha256 = excluded.sha256, size = excluded.size, mtime = excluded.mtime, remote_seq = excluded.remote_seq, synced_at = excluded.synced_at`)
      .run(e.key, 'config', e.path, e.deviceId, sha, e.size, e.mtime, e.seq, this.now());
  }

  async pushChanged(): Promise<number> {
    if (!this.deps.enabled()) return 0;
    let n = 0;
    for (const f of listConfigFiles(this.deps.claudeDir, this.homeDir())) {
      try {
        const content = this.normalizedBytes(fs.readFileSync(f.abs));
        // 目印は元のパスより長いので、置き換えた後に上限を超えることがある。
        // 上げてしまうと、相手の端末では毎回断られて直らない（レビューの軽微 2）。
        if (content.length > CONFIG_MAX_BYTES) throw new Error('目印に置き換えると上限を超えます');
        const sha = sha256Hex(content);
        const key = configKey(this.deps.deviceId, f.rel);
        if (this.syncedSha(key) === sha) { this.clearReported(`push:${f.rel}`); continue; }
        const meta: FileMetaIn = { key, path: f.rel, kind: 'config', sha256: sha, size: content.length, mtime: f.mtime, encrypted: true };
        const body = new PassThrough();
        const pump = pipeline(Readable.from([content]), createGzip(), encryptStream(this.deps.key), body);
        let seq: number;
        try {
          const [r] = await Promise.all([this.deps.client.putFile(meta, body), pump]);
          seq = r.seq;
        } catch (e) {
          body.destroy();
          throw e;
        }
        this.remember({ ...meta, deviceId: this.deps.deviceId, seq }, sha);
        this.clearReported(`push:${f.rel}`);
        n++;
      } catch (e) {
        // 上げられない理由が直るまで中身は変わらないので、中身の印が同じうちは 1 度しか鳴らさない。
        this.reportOnce(`push:${f.rel}`, `${f.size}:${f.mtime}`, `${f.rel} の同期に失敗しました: ${errorMessage(e)}`);
      }
    }
    this.checkStatusLine();
    return n;
  }

  /**
   * statusLine.command からスクリプトの道を読み取れないときに知らせる。
   * 黙って落とすと、相手の端末には「存在しないスクリプトを指す settings.json」だけが降りる。
   * 片肺で降りるぶん、何も降りないより分かりにくい。
   * 中身が変わるまでは 1 度しか鳴らさない（コマンドの中身そのものはトーストに載せない）。
   */
  private checkStatusLine(): void {
    const cmd = statusLineCommand(this.deps.claudeDir);
    if (cmd === null) return;
    const id = 'statusline';
    if (statusLineRel(this.deps.claudeDir, this.homeDir()) !== null) { this.clearReported(id); return; }
    this.reportOnce(id, sha256Hex(cmd), 'settings.json の statusLine が指すスクリプトを ~/.claude の中に見つけられません。そのスクリプトは同期されません');
  }

  private deviceName(id: string): string {
    return (this.deps.db.prepare('select name from devices where id = ?').get(id) as { name: string } | undefined)?.name ?? id;
  }

  /**
   * 受け取ってよい相対パスか。
   * 相手の端末が申告した path は外から来た入力なので、claudeDir に繋ぐ前にここで断つ。
   * statusLine のスクリプトだけは isConfigPath の外にあるので、~/.claude の直下の実行物の形だけを通す。
   */
  private pullable(rel: string): boolean {
    if (typeof rel !== 'string' || !isSafeRelPath(rel) || OURS_RE.test(rel)) return false;
    if (isConfigPath(rel)) return true;
    if (rel === statusLineRel(this.deps.claudeDir, this.homeDir())) return true;
    return SCRIPT_RE.test(rel);
  }

  /**
   * 受け取ってよい項目か。
   * 相対パスの物差しに加えて、鍵と相対パスと端末が同じものを指していることも見る。
   * 鍵は `config/<端末 ID>/<相対パス>` なので、ここが揃っていなければ枠の付け替えである。
   */
  private accepts(e: FileEntry): boolean {
    if (e.deviceId === this.deps.deviceId || !this.pullable(e.path)) return false;
    try { return e.key === configKey(e.deviceId, e.path); } catch { return false; }
  }

  /**
   * 相対パスごとに、いちばん新しい端末の写しを 1 つ選ぶ。
   * 鍵が端末ごとに分かれたので、同じ `CLAUDE.md` が 2 台ぶん届く。
   * 更新時刻で新しい方を採り、同じなら後から上がった方（seq の大きい方）を採る。
   */
  private newestPerPath(list: FileEntry[]): FileEntry[] {
    const best = new Map<string, FileEntry>();
    for (const e of list) {
      const cur = best.get(e.path);
      if (!cur || e.mtime > cur.mtime || (e.mtime === cur.mtime && e.seq > cur.seq)) best.set(e.path, e);
    }
    return [...best.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** 相手の 1 件を、手元の状態と前回の同期と突き合わせて分類する。 */
  private decide(e: FileEntry): Decision {
    let abs: string;
    // 読むところから枠の中に閉じ込める。途中の段がリンクだと、~/.claude の外の中身を読んで比べてしまう。
    try { abs = resolveUnder(this.deps.claudeDir, e.path); } catch (err) {
      return { action: 'skip', localMtime: null, remoteNewer: false, blocked: errorMessage(err) };
    }
    let st: fs.Stats | null;
    try { st = fs.lstatSync(abs); } catch { st = null; }
    // 通常ファイル以外を rename で被せると、シンボリックリンクやディレクトリを黙って壊す。
    if (st && !st.isFile()) return { action: 'skip', localMtime: null, remoteNewer: false, blocked: '同じ名前の通常ファイル以外があります' };
    const localMtime = st ? Math.floor(st.mtimeMs) : null;
    const remoteNewer = localMtime === null || e.mtime >= localMtime;
    let localSha: string | null = null;
    if (st) {
      try { localSha = sha256Hex(this.normalizedBytes(fs.readFileSync(abs))); } catch (err) {
        return { action: 'skip', localMtime, remoteNewer, blocked: `手元の内容を読めません: ${errorMessage(err)}` };
      }
    }
    const synced = this.syncedSha(e.key);
    if (localSha === e.sha256) return { action: 'skip', localMtime, remoteNewer, blocked: null };
    if (localSha === null) return { action: 'create', localMtime, remoteNewer, blocked: null };
    // 手元の中身が「前回この端末から取ったまま」でも、相手の写しの方が古ければ上書きしない。
    // 取り込んだファイルの更新時刻は相手のものに揃えてあるので、この比較には意味がある。
    // 古い写しは競合として扱い、手元を残して相手の分を隣に置く。
    if (synced !== null && localSha === synced) return { action: remoteNewer ? 'overwrite' : 'conflict', localMtime, remoteNewer, blocked: null };
    return { action: 'conflict', localMtime, remoteNewer, blocked: null };
  }

  preview(entries?: FileEntry[]): ConfigPreviewDto {
    const list = this.newestPerPath((entries ?? this.readPending()).filter((e) => this.accepts(e)));
    const sorted = [...list];
    return {
      confirmed: this.confirmed(),
      entries: sorted.map((e) => {
        const d = this.decide(e);
        return { path: e.path, action: d.action, localMtime: d.localMtime, remoteMtime: e.mtime, remoteDevice: this.deviceName(e.deviceId), size: e.size };
      }),
    };
  }

  /**
   * 1 件を平文で受け取る。
   * 復号は pipeline() でつなぐ（裸の pipe だと未処理の error でプロセスが落ちる）。
   * 切り詰められた入力では error が出る前に最大 1 チャンク分が下流に流れるので、
   * 受け取った平文はここでは書かず、呼び手が指紋を確かめてから一時ファイル経由で置く。
   */
  private async fetchPlain(key: string): Promise<Buffer> {
    const body = await this.deps.client.getFile(key);
    const chunks: Buffer[] = [];
    let total = 0;
    await pipeline(body, decryptStream(this.deps.key), createGunzip(), async (source) => {
      for await (const c of source) {
        const b = c as Buffer;
        total += b.length;
        // 圧縮の申告は相手の端末が決めるので、展開した長さでも上限を見る。
        if (total > CONFIG_MAX_BYTES) throw new Error('設定ファイルが上限を超えています');
        chunks.push(b);
      }
    });
    return Buffer.concat(chunks);
  }

  /** 控えを取ってから書く。控えが取れなければ throw して、呼び手にそのファイルの書き戻しをやめさせる。 */
  private backupAndWrite(rel: string, abs: string, content: Buffer, stamp: string, mtime: number): boolean {
    const kept = backupBeforeWrite({ home: this.deps.home, claudeDir: this.deps.claudeDir, rel, stamp });
    writeAtomically(abs, content, modeFor(abs, content));
    applyMtime(abs, mtime);
    return kept !== null;
  }

  /**
   * 控えの世代を上限までに保つ（危険 E2 への手当て）。
   * 名前が yyyyMMdd-HHmmss なので、辞書順に並べれば古い順になる。
   */
  private pruneBackups(): void {
    const root = path.join(backupsRoot(this.deps.home), BACKUP_SUBDIR);
    const keep = Math.max(1, this.deps.backupGenerations ?? BACKUP_GENERATIONS);
    let names: string[];
    try { names = fs.readdirSync(root).filter((n) => STAMP_RE.test(n)); } catch { return; }
    if (names.length <= keep) return;
    for (const n of names.sort().slice(0, names.length - keep)) {
      try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch { /* 消せなくても控えは残る。掃除は次の機会に回す。 */ }
    }
  }

  async applyPull(entries: FileEntry[]): Promise<{ applied: number; conflicts: number; backedUp: number }> {
    // 確認の前でも一覧は覚える。Settings の「取り込み内容を確認」が乾いた一覧を出せるようにするためである。
    // 覚え先は sync_state なので、確認を押さないままサーバを起こし直しても消えない。
    const pending = this.mergePending(entries);
    this.writePending(pending);
    if (!this.deps.enabled() || !this.confirmed()) return { applied: 0, conflicts: 0, backedUp: 0 };
    let applied = 0;
    let conflicts = 0;
    let backedUp = 0;
    let localWon = false;
    const written = new Set<string>();
    // 片付いた鍵。失敗した分は一覧に残し、次の取り込みと次の起動でやり直せるようにする。
    const done = new Set<string>();
    // この回の控えの置き場。1 回の取り込みを 1 つのディレクトリにまとめ、何を書き換えたかがひとまとまりで残るようにする。
    const runStamp = timestampLabel(this.now());
    // 同じ相対パスに複数の端末の写しがあれば、新しい方だけを取り込む。
    const chosen = this.newestPerPath(pending);
    const winnerOf = new Map(chosen.map((e) => [e.path, e.key] as const));
    for (const e of chosen) {
      try {
        if (e.size > CONFIG_MAX_BYTES) throw new Error('設定ファイルが上限を超えています');
        const d = this.decide(e);
        if (d.blocked !== null) { this.reportOnce(`pull:${e.key}`, e.sha256, `${e.path} を取り込めません: ${d.blocked}`); continue; }
        if (d.action === 'skip') { this.remember(e, e.sha256); done.add(e.key); this.clearReported(`pull:${e.key}`); continue; }
        const raw = await this.fetchPlain(e.key);
        // 平文の指紋で突き合わせる。鍵は全端末で共通なので、復号できたという事実だけでは差し替えを見抜けない。
        if (sha256Hex(raw) !== e.sha256) throw new Error('SHA-256 が一致しません');
        const content = isTextBuffer(raw) ? Buffer.from(denormalizeHome(raw.toString('utf8'), this.homeDir()), 'utf8') : raw;
        // 書く直前にもう一度解く。足りない段はここで 1 段ずつ作る（recursive はリンクを辿るので使わない）。
        const abs = resolveUnder(this.deps.claudeDir, e.path, { create: true });
        if (d.action === 'conflict' && !d.remoteNewer) {
          // 手元の方が新しい。相手の分を隣に置くだけで、手元は触らない。控えも要らない。
          const other = writeConflictCopy(abs, safeDeviceLabel(this.deviceName(e.deviceId)), runStamp, content, 0o600);
          conflicts++;
          localWon = true;
          this.deps.onToast('info', `${e.path} が競合しました。相手の内容を ${path.basename(other)} に置きました`);
        } else if (d.action === 'conflict') {
          // 相手の方が新しい。控えを先に取り、取れたときだけ手元の写しを隣に残して書き換える。
          const r = this.backupAndWriteConflict(e.path, abs, content, runStamp, e.mtime);
          if (r.kept) backedUp++;
          conflicts++;
          this.deps.onToast('info', `${e.path} が競合しました。手元の内容を ${path.basename(r.keep)} に残しました`);
        } else if (this.backupAndWrite(e.path, abs, content, runStamp, e.mtime)) backedUp++;
        written.add(e.path);
        this.remember(e, e.sha256);
        done.add(e.key);
        this.clearReported(`pull:${e.key}`);
        applied++;
      } catch (err) {
        // 控えに失敗した分もここに落ちる。そのファイルは書き戻していないので、次の pull でやり直す。
        // 一覧に残る分は毎回ここへ来るので、相手の中身が変わるまでは 1 度しか鳴らさない。
        this.reportOnce(`pull:${e.key}`, e.sha256, `${e.path} の取り込みに失敗しました: ${errorMessage(err)}`);
      }
    }
    if (backedUp > 0) {
      this.deps.onToast('info', `上書きした ${backedUp} 件の控えを ~/.agent-hangar/backups/${BACKUP_SUBDIR}/${runStamp}/ に置きました`);
      this.pruneBackups();
    }
    this.markStatusLineExecutable(written);
    // 勝った写しが片付いたなら、同じ相対パスで負けた写しも用済みである。
    for (const e of pending) {
      const w = winnerOf.get(e.path);
      if (w !== undefined && w !== e.key && done.has(w)) done.add(e.key);
    }
    // 片付いた分だけ一覧から落とす。残りは次の取り込みと次の起動でもう一度出る。
    this.writePending(pending.filter((e) => !done.has(e.key)));
    // 手元が勝った競合は、相手に追いつかせるためにすぐ push する。
    if (localWon) await this.pushChanged();
    return { applied, conflicts, backedUp };
  }

  /**
   * この回に書いたものが statusLine の指し先なら、最後に実行の許しを付ける。
   * 相手から届いただけのファイルは 0600 で置くので（レビューの中 3）、
   * 同じ回に settings.json が先に届いていても後に届いていても、ここで一度だけ揃う。
   */
  private markStatusLineExecutable(written: Set<string>): void {
    const sl = statusLineRel(this.deps.claudeDir, this.homeDir());
    if (!sl || !written.has(sl)) return;
    try {
      const abs = resolveUnder(this.deps.claudeDir, sl);
      const mode = fs.lstatSync(abs).mode & 0o777;
      if ((mode & 0o100) === 0) fs.chmodSync(abs, mode | 0o100);
    } catch (e) {
      this.deps.onToast('error', `${sl} に実行の許しを付けられません: ${errorMessage(e)}`);
    }
  }

  /**
   * 競合で相手が勝つ側の書き込み。
   * 控え、手元の写し、上書きの順に行う。控えが取れなければ写しも作らず、~/.claude は 1 バイトも変わらない。
   */
  private backupAndWriteConflict(rel: string, abs: string, content: Buffer, stamp: string, mtime: number): { kept: string | null; keep: string } {
    const kept = backupBeforeWrite({ home: this.deps.home, claudeDir: this.deps.claudeDir, rel, stamp });
    const local = fs.readFileSync(abs);
    const keep = writeConflictCopy(abs, safeDeviceLabel(this.deps.deviceName), stamp, local, modeFor(abs, local));
    writeAtomically(abs, content, modeFor(abs, content));
    applyMtime(abs, mtime);
    return { kept, keep };
  }
}
