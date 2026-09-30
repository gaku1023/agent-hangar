import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RetentionDto, RetentionPreviewDto, RetentionUsageDto } from '@agent-hangar/shared';
import { timestampLabel } from '../sync/copy.ts';
import { acquireFileLock, resolveRealFile, writeFileAtomically } from './claudeFileWrite.ts';
import { backupsRoot } from './cloud.ts';
import { diffLines, setTopLevelNumber } from './jsonTextEdit.ts';

/**
 * Claude Code の会話の保持期間（cleanupPeriodDays）。
 * Claude Code は期間を過ぎた本文を、セッションを始めたあとの掃除で黙って消す（settings-reference）。
 * hangar はユーザー設定と組織の設定だけを読む。プロジェクトの設定と --settings は見ない（spec の範囲の外）。
 */
export const DEFAULT_RETENTION_DAYS = 30;
export const RETENTION_KEY = 'cleanupPeriodDays';
export type RetentionState = Omit<RetentionDto, 'usage'>;

const UNREADABLE = '設定ファイルを読み取れないので書き換えません';
const MANAGED = '組織の設定で決まっています';
const DAY = 86_400_000;
/** 増え方を見積もる窓。既定の保持期間と同じ長さにする。 */
const RATE_WINDOW_DAYS = 30;

/** Claude Code が受け付ける値か。1 以上の整数だけである（0 は検証で弾かれる）。 */
const validDays = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

/** 組織の設定の置き場。macOS と Linux のファイルだけを読む。MDM とコンソールから配る設定は読まない。 */
export function defaultManagedDir(): string | null {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (process.platform === 'linux') return '/etc/claude-code';
  return null;
}

/** JSON のオブジェクトとして読む。無ければ null、壊れていれば 'broken'。 */
function readObject(file: string): Record<string, unknown> | null | 'broken' {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'broken'; }
  try {
    const v = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : 'broken';
  } catch {
    return 'broken';
  }
}

/** 組織の設定の値。managed-settings.json の後に managed-settings.d を名前の順に読み、後の値が勝つ。 */
function managedDays(dir: string | null): number | null {
  if (!dir) return null;
  const files = [path.join(dir, 'managed-settings.json')];
  try {
    for (const f of fs.readdirSync(path.join(dir, 'managed-settings.d')).filter((n) => n.endsWith('.json')).sort()) files.push(path.join(dir, 'managed-settings.d', f));
  } catch {
    // drop-in の置き場が無いのは普通である。
  }
  let days: number | null = null;
  for (const f of files) {
    const o = readObject(f);
    if (o && o !== 'broken' && validDays(o[RETENTION_KEY])) days = o[RETENTION_KEY];
  }
  return days;
}

export function readRetention(o: { claudeDir: string; managedDir: string | null }): RetentionState {
  const user = readObject(path.join(o.claudeDir, 'settings.json'));
  const userValue = user && user !== 'broken' && validDays(user[RETENTION_KEY]) ? user[RETENTION_KEY] : null;
  const managed = managedDays(o.managedDir);
  if (managed !== null) return { days: managed, source: 'managed', userValue, writable: false, unwritableReason: MANAGED };
  if (user === 'broken') return { days: DEFAULT_RETENTION_DAYS, source: 'default', userValue: null, writable: false, unwritableReason: UNREADABLE };
  if (userValue !== null) return { days: userValue, source: 'user', userValue, writable: true, unwritableReason: null };
  return { days: DEFAULT_RETENTION_DAYS, source: 'default', userValue: null, writable: true, unwritableReason: null };
}

/**
 * <claudeDir>/projects の使用量。lstat でたどり、シンボリックリンクはたどらない。
 * 読めない段は飛ばす。重い走査なので、呼ぶのは起動の後と 1 時間ごとだけにする（RetentionService）。
 */
export async function measureUsage(o: { claudeDir: string; now: number }): Promise<RetentionUsageDto> {
  const since = o.now - RATE_WINDOW_DAYS * DAY;
  let bytes = 0;
  let recent = 0;
  const stack = [path.join(o.claudeDir, 'projects')];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      try {
        const st = await fs.promises.lstat(p);
        bytes += st.size;
        if (st.mtimeMs >= since) recent += st.size;
      } catch {
        // 数えている間に消えた。
      }
    }
  }
  let freeBytes = 0;
  try {
    const s = fs.statfsSync(fs.existsSync(o.claudeDir) ? o.claudeDir : path.dirname(o.claudeDir));
    freeBytes = s.bavail * s.bsize;
  } catch {
    // 空きを測れない置き場。0 として出し、画面は空きの欄を「分かりません」にする。
  }
  return { bytes, dailyBytes: Math.round(recent / RATE_WINDOW_DAYS), freeBytes, measuredAt: o.now };
}

/** 下見の後に、ほかの PC からの同期や手の編集でファイルが変わった。UI は下見を取り直す。 */
export class RetentionConflictError extends Error {
  constructor() { super('設定ファイルがほかで変わったので、読み直しました'); this.name = 'RetentionConflictError'; }
}

export type WriteRetentionOptions = { claudeDir: string; home: string; days: number; baseSha256: string; now?: Date; lockWaitMs?: number; staleLockMs?: number; onBeforeWrite?: () => void };

const BACKUP_SUBDIR = 'claude-config';
const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');
const settingsFile = (claudeDir: string): string => resolveRealFile(path.join(claudeDir, 'settings.json'));
/** 今の中身。無ければ null。 */
function readBytes(file: string): Buffer | null {
  try { return fs.readFileSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

export function previewRetention(o: { claudeDir: string; home: string; days: number; dailyBytes: number | null }): RetentionPreviewDto {
  const file = settingsFile(o.claudeDir);
  const bytes = readBytes(file);
  const before = bytes?.toString('utf8') ?? '';
  const after = setTopLevelNumber(before, RETENTION_KEY, o.days);
  return {
    days: o.days, path: file, lines: diffLines(before, after), baseSha256: bytes ? sha256(bytes) : '',
    backupDir: path.join(backupsRoot(o.home), BACKUP_SUBDIR),
    projectedBytes: o.dailyBytes === null ? null : Math.round(o.dailyBytes * o.days),
  };
}

/**
 * 控えを取る。同じ秒の控えがあれば -2、-3 と連番を足し、先の控えを潰さない。
 * 取れなければ投げる。呼び手はそのまま書くのをやめる。
 */
function backupSettings(file: string, home: string, now: Date): string {
  const dir = path.join(backupsRoot(home), BACKUP_SUBDIR, timestampLabel(now.getTime()));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = path.join(dir, 'settings.json');
  for (let i = 1; i <= 50; i++) {
    const dest = i === 1 ? base : `${base}-${i}`;
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    fs.chmodSync(dest, 0o600);
    return dest;
  }
  throw new Error('控えを置く名前が空いていません');
}

/**
 * cleanupPeriodDays の 1 か所だけを書き換える。claudeJson.ts と同じ作法に従う。
 * ロックを取ってから読み、下見の指紋と比べ、控えを取り、書く直前にもう一度読んで比べてから rename する。
 */
export function writeRetention(o: WriteRetentionOptions): { file: string; backup: string | null } {
  const file = settingsFile(o.claudeDir);
  const release = acquireFileLock(file, o.lockWaitMs ?? 2000, o.staleLockMs ?? 10_000);
  try {
    const bytes = readBytes(file);
    const cur = bytes ? sha256(bytes) : '';
    if (cur !== o.baseSha256) throw new RetentionConflictError();
    const after = setTopLevelNumber(bytes?.toString('utf8') ?? '', RETENTION_KEY, o.days);
    const backup = bytes ? backupSettings(file, o.home, o.now ?? new Date()) : null;
    o.onBeforeWrite?.();
    // Claude Code は hangar のロックを知らないので、書く直前にもう一度読んで割り込みを見つける。
    const again = readBytes(file);
    if ((again ? sha256(again) : '') !== cur) throw new RetentionConflictError();
    const mode = bytes ? fs.statSync(file).mode & 0o777 : 0o600;
    writeFileAtomically(file, after, mode);
    return { file, backup };
  } finally {
    release();
  }
}

export type RetentionServiceOptions = { claudeDir: string; home: string; managedDir: string | null; broadcast: (r: RetentionDto) => void; now?: () => number };

/** 起動の後に 1 度だけ測るまでの待ち。起動の索引づけと重ねない。 */
const FIRST_MEASURE_MS = 30_000;
const MEASURE_EVERY_MS = 3_600_000;
/** 読み直す周期。設定の送信（CONFIG_PUSH_MS）と同じにする。 */
const REFRESH_EVERY_MS = 60_000;

/**
 * 保持期間の今の値と使用量を持ち、変わったときだけ retention.changed を配る。
 * 使用量は重いので周期で測り、要求のたびには測らない。
 */
export class RetentionService {
  private state: RetentionState;
  private usage: RetentionUsageDto | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly now: () => number;

  constructor(private readonly o: RetentionServiceOptions) {
    this.now = o.now ?? Date.now;
    this.state = readRetention(o);
  }

  current(): RetentionDto { return { ...this.state, usage: this.usage }; }

  /** 読み直し、変わっていれば配る。 */
  refresh(): void {
    const next = readRetention(this.o);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.o.broadcast(this.current());
  }

  async measure(): Promise<void> {
    this.usage = await measureUsage({ claudeDir: this.o.claudeDir, now: this.now() });
    this.o.broadcast(this.current());
  }

  preview(days: number): RetentionPreviewDto {
    return previewRetention({ claudeDir: this.o.claudeDir, home: this.o.home, days, dailyBytes: this.usage?.dailyBytes ?? null });
  }

  write(days: number, baseSha256: string): RetentionDto {
    writeRetention({ claudeDir: this.o.claudeDir, home: this.o.home, days, baseSha256 });
    this.refresh();
    return this.current();
  }

  start(): void {
    const measure = () => void this.measure().catch((e: unknown) => console.error('[retention]', e instanceof Error ? e.message : e));
    this.timers.push(setTimeout(measure, FIRST_MEASURE_MS), setInterval(measure, MEASURE_EVERY_MS), setInterval(() => this.refresh(), REFRESH_EVERY_MS));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
