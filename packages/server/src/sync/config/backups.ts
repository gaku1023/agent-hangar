import fs from 'node:fs';
import path from 'node:path';
import type { ConfigBackupGenerationDto } from '@agent-hangar/shared';
import { configBackupsDir } from './paths.ts';

/**
 * 適用の前に取った控えの世代の一覧（設定の「この世代に戻す」の元）。
 * 世代の名前は `yyyyMMdd-HHmmss`（手元の時刻。sync/copy.ts の timestampLabel）で、中に `<相対パス>` のファイルが入る。
 * 数えるだけで、書き戻す操作は殻の命令の役目である（D9）。
 * `removed/` のような時刻の名前でないものは、世代として数えない。
 */
export const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

/** 世代の直下に置く、戻し方の記録（作った印、基準の前の値）。控えたファイルではないので数えない。書くのは apply.ts。 */
export const GENERATION_META = '.hangar-apply.json';

const pad = (n: number): string => String(n).padStart(2, '0');

/** 世代の名前。手元の時刻の `yyyyMMdd-HHmmss`（sync/copy.ts の timestampLabel と同じ形）。 */
export function stampLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function countFiles(dir: string, top = true): number {
  let n = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    if (top && e.name === GENERATION_META) continue;
    n += e.isDirectory() ? countFiles(path.join(dir, e.name), false) : 1;
  }
  return n;
}

/** 新しい世代が先。 */
export function listBackups(home: string): ConfigBackupGenerationDto[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(configBackupsDir(home), { withFileTypes: true }); } catch { return []; }
  const out: ConfigBackupGenerationDto[] = [];
  for (const e of entries) {
    const m = STAMP_RE.exec(e.name);
    if (!m || !e.isDirectory()) continue;
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    out.push({ name: e.name, at: Number.isFinite(at) ? at : null, files: countFiles(path.join(configBackupsDir(home), e.name)) });
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}
