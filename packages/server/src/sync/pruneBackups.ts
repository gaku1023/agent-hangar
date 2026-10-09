import fs from 'node:fs';
import path from 'node:path';
import { backupsRoot } from '../config/cloud.ts';
import { BACKUP_GENERATIONS } from './claudeConfig.ts';

/**
 * 控えを新しい方から数えて `keep` 件だけ残し、古いものを消す。消した数を返す。
 *
 * 設定の控え（`claudeConfig.ts` の `pruneBackups`）は名前が `yyyyMMdd-HHmmss` のディレクトリなので
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
  // 入れ物そのものがリンクだと、readdir がリンクの先を開き、rm がその先のファイルを消す。
  // 控えを書く側（copy.ts の resolveUnder）はリンクを 1 区切りも辿らない決まりなので、消す側も揃える。
  if (kind === '' || kind === '.' || kind === '..' || kind.includes('/')) throw new Error('控えの種類の形が不正です');
  const dir = path.join(root, kind);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return 0;
  if (st.isSymbolicLink()) throw new Error(`backups/${kind} がシンボリックリンクなので刈りません`);
  if (!st.isDirectory()) throw new Error(`backups/${kind} がディレクトリではありません`);
  let names: string[];
  try {
    // ここでのリンクは読み飛ばす。控えとして置いた覚えのないものを消さない。
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch (e) {
    // 入れ物がまだ無いのはふつうのことである（その種類の控えを 1 度も取っていない端末）。
    // それ以外は握り潰さない。握り潰すと、刈れていないことが誰にも見えないまま溜まり続ける。
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  if (names.length <= limit) return 0;
  const dated = names.map((n) => {
    // 読めないものは最も古いものとして扱う。次の機会に消える。
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, n)).mtimeMs; } catch { /* 上のとおり */ }
    return { n, mtime };
  });
  dated.sort((a, b) => b.mtime - a.mtime || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0));
  let removed = 0;
  for (const { n } of dated.slice(limit)) {
    try { fs.rmSync(path.join(dir, n), { force: true }); removed++; } catch { /* 消せなくても控えは残る。 */ }
  }
  return removed;
}

/**
 * 本文とメモの控えの世代を刈る口を作る。
 *
 * 残す数は設定の控えと同じ `BACKUP_GENERATIONS`（20）にする。
 * 覚える数が 1 つで済み、「控えは直近 20 回ぶん」という説明が 3 種類すべてで同じになる。
 * 本文の控えはセッション 1 本ぶんの大きさがあるので、これ以上は溜めない。
 *
 * 刈るのは控えを取った後だけなので、「控えを取れなかったときは書き戻さない」という決まりには触らない。
 * いま取った控えは最も新しいので、この刈り込みで消えることはない。
 * 刈れなかったときは投げずにログへ残す。掃除の失敗で呼び手の仕事を止めない。
 */
export function backupPruner(home: string, log: (...a: unknown[]) => void = console.error): (kind: 'transcripts' | 'memos') => void {
  return (kind) => {
    try { pruneBackupFiles(backupsRoot(home), kind, BACKUP_GENERATIONS); }
    catch (e) { log('[backups]', e instanceof Error ? e.message : e); }
  };
}
