import fs from 'node:fs';
import path from 'node:path';
import { backupsRoot } from '../config/cloud.ts';

/** 本文の控えを残す世代の数。これを超えた古い順に消す。 */
export const BACKUP_GENERATIONS = 20;

/**
 * 控えを新しい方から数えて `keep` 件だけ残し、古いものを消す。消した数を返す。
 *
 * 設定の控え（`backups/claude-config/`）は名前が `yyyyMMdd-HHmmss` のディレクトリなので
 * 辞書順がそのまま時刻順になるが、本文の控え（`<uuid>-<時刻>.jsonl`）とメモの控え
 * （`session-<ID>-<時刻>.md`）は名前が ID で始まるので、辞書順では時刻の順に並ばない。
 * そこで更新時刻で並べ、同じ秒に並んだものは名前で決める（控えは作った時刻がそのまま更新時刻になる）。
 *
 * 入れ物の中のディレクトリは触らない。`backups/` の下には `claude-config/` のような入れ物も並ぶ。
 * 消せなかったものは数えない。掃除は次の機会に回す。
 */
export function pruneBackupFiles(root: string, kind: string, keep: number): number {
  // 控えを全部消す刈り込みは作らない。
  const limit = Math.max(1, keep);
  const listed = listBackupFiles(root, kind);
  if (!listed || listed.files.length <= limit) return 0;
  const dated = listed.files;
  dated.sort((a, b) => b.mtime - a.mtime || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0));
  let removed = 0;
  for (const { n } of dated.slice(limit)) {
    try { fs.rmSync(path.join(listed.dir, n), { force: true }); removed++; } catch { /* 消せなくても控えは残る。 */ }
  }
  return removed;
}

/**
 * セッションの名前とメモの控え（backups/memos）のうち、日数に依らず残す件数。新しい方から数える。
 * 控えは、負けた名前とメモの唯一の置き場である。日数だけで刈ると、しばらく使わなかった PC を起こした時点で消える。
 */
export const MEMO_BACKUP_KEEP_COUNT = 200;

/**
 * 件数（MEMO_BACKUP_KEEP_COUNT）を超えた控えを保つ日数。超えた分のうち、これより古いものだけを刈る。
 * 1 回の pull で何件ぶつかっても、いま取った控えがその場で消えることはない。
 */
export const MEMO_BACKUP_KEEP_DAYS = 180;

/**
 * 更新時刻が `maxAgeMs` より古い控えを消す。消した数を返す。
 * `keepNewest` を渡すと、新しい方からその件数は、どれだけ古くても消さない。
 * 入れ物の扱い（リンクは断る、中のディレクトリとリンクには触らない）は `pruneBackupFiles` と同じである。
 * 更新時刻が読めないものは消さない。いつの控えか分からないものを、古いと決めつけない。
 */
export function pruneBackupFilesByAge(root: string, kind: string, maxAgeMs: number, now: number = Date.now(), keepNewest = 0): number {
  const listed = listBackupFiles(root, kind);
  if (!listed) return 0;
  const files = listed.files.sort((a, b) => b.mtime - a.mtime || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0)).slice(Math.max(0, keepNewest));
  let removed = 0;
  for (const { n, mtime } of files) {
    if (mtime === 0 || now - mtime <= maxAgeMs) continue;
    try { fs.rmSync(path.join(listed.dir, n), { force: true }); removed++; } catch { /* 消せなくても控えは残る。 */ }
  }
  return removed;
}

/** セッションの名前とメモの控えを刈る。新しい方から 200 件は残し、超えた分のうち 180 日より古いものだけを消す。`home` は hangar の home である。 */
export function pruneMemoBackups(home: string, now: number = Date.now()): number {
  return pruneBackupFilesByAge(backupsRoot(home), 'memos', MEMO_BACKUP_KEEP_DAYS * 86_400_000, now, MEMO_BACKUP_KEEP_COUNT);
}

/** 控えの入れ物の中のファイルと、その更新時刻。入れ物が無ければ null。 */
function listBackupFiles(root: string, kind: string): { dir: string; files: { n: string; mtime: number }[] } | null {
  // 入れ物そのものがリンクだと、readdir がリンクの先を開き、rm がその先のファイルを消す。
  // 控えを書く側（copy.ts の resolveUnder）はリンクを 1 区切りも辿らない決まりなので、消す側も揃える。
  if (kind === '' || kind === '.' || kind === '..' || kind.includes('/')) throw new Error('控えの種類の形が不正です');
  const dir = path.join(root, kind);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink()) throw new Error(`backups/${kind} がシンボリックリンクなので刈りません`);
  if (!st.isDirectory()) throw new Error(`backups/${kind} がディレクトリではありません`);
  let names: string[];
  try {
    // ここでのリンクは読み飛ばす。控えとして置いた覚えのないものを消さない。
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch (e) {
    // 入れ物がまだ無いのはふつうのことである（その種類の控えを 1 度も取っていない端末）。
    // それ以外は握り潰さない。握り潰すと、刈れていないことが誰にも見えないまま溜まり続ける。
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const files = names.map((n) => {
    // 読めないものは時刻 0 にする。件数で刈るときは最も古いものとして扱い、次の機会に消える。
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, n)).mtimeMs; } catch { /* 上のとおり */ }
    return { n, mtime };
  });
  return { dir, files };
}

/**
 * 本文とメモの控えを刈る口を作る。
 *
 * 本文の控えに残す数は `BACKUP_GENERATIONS`（20）にする。
 * 覚える数が 1 つで済み、「控えは直近 20 回ぶん」という説明が同じになる。
 * 本文の控えはセッション 1 本ぶんの大きさがあるので、これ以上は溜めない。
 * セッションの名前とメモの控えだけは、件数と日数の両方で刈る（`pruneMemoBackups`。新しい方から `MEMO_BACKUP_KEEP_COUNT` 件は残し、超えた分のうち `MEMO_BACKUP_KEEP_DAYS` 日より古いものだけを消す）。
 *
 * 刈るのは控えを取った後だけなので、「控えを取れなかったときは書き戻さない」という決まりには触らない。
 * いま取った控えは最も新しいので、この刈り込みで消えることはない。
 * 刈れなかったときは投げずにログへ残す。掃除の失敗で呼び手の仕事を止めない。
 */
export function backupPruner(home: string, log: (...a: unknown[]) => void = console.error): (kind: 'transcripts' | 'memos') => void {
  return (kind) => {
    try {
      if (kind === 'memos') pruneMemoBackups(home);
      else pruneBackupFiles(backupsRoot(home), kind, BACKUP_GENERATIONS);
    } catch (e) { log('[backups]', e instanceof Error ? e.message : e); }
  };
}
