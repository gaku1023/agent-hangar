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
  if (!isSafeRelPath(rel) || OURS_RE.test(rel)) return false;
  if (EXCLUDE_FILES.has(path.posix.basename(rel))) return false;
  if (rel.split('/').some((seg) => EXCLUDE_DIRS.has(seg))) return false;
  if (ROOT_FILES.includes(rel)) return true;
  if (TREES.some((t) => rel.startsWith(`${t}/`))) return true;
  return /^projects\/[^/]+\/memory\/.+/.test(rel);
}

/**
 * コマンド行の先頭の 1 語を、claudeDir からの相対パスとして読む。
 * `~/.claude/x.sh` と `$HOME/.claude/x.sh` は、ホームの下の `.claude` ではなく claudeDir を指すものとして解く。
 * HANGAR_CLAUDE_DIR で置き場を変えていても、意味（設定の入れ物の中）が変わらないようにするためである。
 */
function relFromCommand(cmd: string, claudeDir: string, homeDir: string): string | null {
  const t = cmd.trim();
  if (!t) return null;
  const quoted = /^"([^"]+)"|^'([^']+)'/.exec(t);
  const first = quoted ? (quoted[1] ?? quoted[2])! : t.split(/\s+/)[0]!;
  let rest: string | null = null;
  for (const prefix of ['~', '$HOME', '${HOME}', HOME_MARKER]) {
    if (first === prefix || first.startsWith(`${prefix}/`)) { rest = first.slice(prefix.length); break; }
  }
  let abs: string;
  if (rest !== null) {
    // `~/.claude/...` は設定の入れ物そのものを指す言い回しなので、claudeDir に読み替える。
    if (rest.startsWith('/.claude/')) abs = path.resolve(claudeDir, rest.slice('/.claude/'.length));
    else abs = path.resolve(homeDir, rest.replace(/^\//, ''));
  } else {
    abs = path.isAbsolute(first) ? path.resolve(first) : path.resolve(claudeDir, first);
  }
  const rel = toPosix(path.relative(claudeDir, abs));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && isSafeRelPath(rel) ? rel : null;
}

/** settings.json の statusLine.command が ~/.claude 配下を指していれば、その相対パスを返す。 */
export function statusLineRel(claudeDir: string, homeDir: string = os.homedir()): string | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')) as { statusLine?: { command?: string } };
    const cmd = s.statusLine?.command;
    if (typeof cmd !== 'string' || !cmd) return null;
    const rel = relFromCommand(cmd, claudeDir, homeDir);
    return rel && !OURS_RE.test(rel) ? rel : null;
  } catch {
    // 読めない、JSON でない、statusLine が無い。どれも「スクリプトは無い」と同じに扱う。
    return null;
  }
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
    if (OURS_RE.test(rel) || EXCLUDE_FILES.has(path.posix.basename(rel))) return;
    found.set(rel, { rel, abs, size: st.size, mtime: Math.floor(st.mtimeMs) });
  };
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(abs); }
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

/** ホームの絶対パスを目印に置き換える。$HOME の文字列はそのまま残す。 */
export function normalizeHome(text: string, home: string): string { return text.split(home).join(HOME_MARKER); }
export function denormalizeHome(text: string, home: string): string { return text.split(HOME_MARKER).join(home); }

/** UTF-8 のテキストとして扱えるか。NUL を含むものと往復できないものは扱わない。 */
export function isTextBuffer(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

/**
 * 同じ入れ物に一時ファイルを作ってから rename で被せる。
 * 直に書くと、途中で落ちたときに切れた settings.json が ~/.claude に残り、Claude Code がそれを読む。
 * mode を渡すと作るときの権限に使う（上書きでは元のファイルの権限をそのまま引き継ぐ）。
 */
function writeAtomically(abs: string, content: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
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
  fs.mkdirSync(path.dirname(abs), { recursive: true });
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
  const head = `${baseAbs}.conflict-${label}-${stamp}`;
  for (let i = 1; i <= MAX_CONFLICT_TRIES; i++) {
    const cand = i === 1 ? head : `${head}-${i}`;
    if (writeNewFile(cand, content, mode)) return cand;
  }
  throw new Error('競合の写しを置く名前が空いていません');
}

/** 既存の権限を引き継ぐ。無ければ、shebang のあるものだけ実行できる形にする。 */
function modeFor(abs: string, content: Buffer): number {
  try { return fs.statSync(abs).mode & 0o777; } catch { /* 無ければ既定に落ちる */ }
  return content.subarray(0, 2).toString() === '#!' ? 0o700 : 0o600;
}

/**
 * 上書きの前に控えを取る。
 * 置き場は ~/.agent-hangar/backups/claude-config/<yyyyMMdd-HHmmss>/<相対パス> である。
 * 既存ファイルが無ければ控えは要らないので何もせず null を返す。
 * 写せなければ throw する。呼び手はそのファイルの書き戻しをやめ、次の pull に回す。
 */
export function backupBeforeWrite(o: { home: string; claudeDir: string; rel: string; stamp: string }): string | null {
  const abs = path.join(o.claudeDir, ...o.rel.split('/'));
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const dest = path.join(backupsRoot(o.home), BACKUP_SUBDIR, o.stamp, ...o.rel.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 控えも一時ファイルと rename で置く。途中までの控えは履歴として当てにならない。
  const tmp = `${dest}.hangar-tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    fs.copyFileSync(abs, tmp, fs.constants.COPYFILE_EXCL);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 残っても控えの置き場の中である */ }
    throw e;
  }
  return dest;
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
type Decision = { action: ConfigPreviewAction; localMtime: number | null; remoteNewer: boolean; blocked: string | null };

/**
 * Claude Code のユーザー設定を端末間で合わせる。
 * ~/.claude に書くのは、Settings で有効にして取り込みを確認したときだけである。
 * 書き戻しは必ず控えを取った後に行い、控えが取れなければ 1 バイトも書かない（利用者の決定 2）。
 */
export class ClaudeConfigSync {
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastRemote: FileEntry[] = [];

  constructor(private readonly deps: ClaudeConfigDeps) {}

  private get timers(): Timers { return this.deps.timers ?? REAL_TIMERS; }
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private homeDir(): string { return this.deps.homeDir ?? os.homedir(); }
  private confirmed(): boolean { return this.deps.state.get('configPullConfirmed') === '1'; }

  confirm(): void { this.deps.state.set('configPullConfirmed', true); }
  pendingRemote(): FileEntry[] { return this.lastRemote; }

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
        const sha = sha256Hex(content);
        const key = configKey(f.rel);
        if (this.syncedSha(key) === sha) continue;
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
        n++;
      } catch (e) {
        this.deps.onToast('error', `${f.rel} の同期に失敗しました: ${errorMessage(e)}`);
      }
    }
    return n;
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

  /** 相手の 1 件を、手元の状態と前回の同期と突き合わせて分類する。 */
  private decide(e: FileEntry): Decision {
    const abs = path.join(this.deps.claudeDir, ...e.path.split('/'));
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
    if (synced !== null && localSha === synced) return { action: 'overwrite', localMtime, remoteNewer, blocked: null };
    return { action: 'conflict', localMtime, remoteNewer, blocked: null };
  }

  preview(entries?: FileEntry[]): ConfigPreviewDto {
    const list = (entries ?? this.lastRemote).filter((e) => e.deviceId !== this.deps.deviceId && this.pullable(e.path));
    const sorted = [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
  private backupAndWrite(rel: string, content: Buffer, stamp: string): boolean {
    const kept = backupBeforeWrite({ home: this.deps.home, claudeDir: this.deps.claudeDir, rel, stamp });
    const abs = path.join(this.deps.claudeDir, ...rel.split('/'));
    writeAtomically(abs, content, modeFor(abs, content));
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
    this.lastRemote = entries.filter((e) => e.deviceId !== this.deps.deviceId && this.pullable(e.path));
    if (!this.deps.enabled() || !this.confirmed()) return { applied: 0, conflicts: 0, backedUp: 0 };
    let applied = 0;
    let conflicts = 0;
    let backedUp = 0;
    let localWon = false;
    // この回の控えの置き場。1 回の取り込みを 1 つのディレクトリにまとめ、何を書き換えたかがひとまとまりで残るようにする。
    const runStamp = timestampLabel(this.now());
    for (const e of this.lastRemote) {
      try {
        if (e.size > CONFIG_MAX_BYTES) throw new Error('設定ファイルが上限を超えています');
        const d = this.decide(e);
        if (d.blocked !== null) { this.deps.onToast('error', `${e.path} を取り込めません: ${d.blocked}`); continue; }
        if (d.action === 'skip') { this.remember(e, e.sha256); continue; }
        const raw = await this.fetchPlain(e.key);
        // 平文の指紋で突き合わせる。鍵は全端末で共通なので、復号できたという事実だけでは差し替えを見抜けない。
        if (sha256Hex(raw) !== e.sha256) throw new Error('SHA-256 が一致しません');
        const content = isTextBuffer(raw) ? Buffer.from(denormalizeHome(raw.toString('utf8'), this.homeDir()), 'utf8') : raw;
        const abs = path.join(this.deps.claudeDir, ...e.path.split('/'));
        if (d.action === 'conflict' && !d.remoteNewer) {
          // 手元の方が新しい。相手の分を隣に置くだけで、手元は触らない。控えも要らない。
          const other = writeConflictCopy(abs, safeDeviceLabel(this.deviceName(e.deviceId)), runStamp, content, 0o600);
          conflicts++;
          localWon = true;
          this.deps.onToast('info', `${e.path} が競合しました。相手の内容を ${path.basename(other)} に置きました`);
        } else if (d.action === 'conflict') {
          // 相手の方が新しい。控えを先に取り、取れたときだけ手元の写しを隣に残して書き換える。
          const r = this.backupAndWriteConflict(e.path, abs, content, runStamp);
          if (r.kept) backedUp++;
          conflicts++;
          this.deps.onToast('info', `${e.path} が競合しました。手元の内容を ${path.basename(r.keep)} に残しました`);
        } else if (this.backupAndWrite(e.path, content, runStamp)) backedUp++;
        this.remember(e, e.sha256);
        applied++;
      } catch (err) {
        // 控えに失敗した分もここに落ちる。そのファイルは書き戻していないので、次の pull でやり直す。
        this.deps.onToast('error', `${e.path} の取り込みに失敗しました: ${errorMessage(err)}`);
      }
    }
    if (backedUp > 0) {
      this.deps.onToast('info', `上書きした ${backedUp} 件の控えを ~/.agent-hangar/backups/${BACKUP_SUBDIR}/${runStamp}/ に置きました`);
      this.pruneBackups();
    }
    // 手元が勝った競合は、相手に追いつかせるためにすぐ push する。
    if (localWon) await this.pushChanged();
    return { applied, conflicts, backedUp };
  }

  /**
   * 競合で相手が勝つ側の書き込み。
   * 控え、手元の写し、上書きの順に行う。控えが取れなければ写しも作らず、~/.claude は 1 バイトも変わらない。
   */
  private backupAndWriteConflict(rel: string, abs: string, content: Buffer, stamp: string): { kept: string | null; keep: string } {
    const kept = backupBeforeWrite({ home: this.deps.home, claudeDir: this.deps.claudeDir, rel, stamp });
    const local = fs.readFileSync(abs);
    const keep = writeConflictCopy(abs, safeDeviceLabel(this.deps.deviceName), stamp, local, modeFor(abs, local));
    writeAtomically(abs, content, modeFor(abs, content));
    return { kept, keep };
  }
}
