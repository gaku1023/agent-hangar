import fs from 'node:fs';
import path from 'node:path';
import type { RetentionDto, RetentionUsageDto } from '@agent-hangar/shared';

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
