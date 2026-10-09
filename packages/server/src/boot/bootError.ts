import fs from 'node:fs';
import path from 'node:path';
import { DbBackupError } from '../db/backup.ts';
import { DbTooOldError } from '../db/open.ts';

/** 置き場に書く、起動の失敗のファイルの名前。 */
export const BOOT_ERROR_FILE = 'boot-error.json';

/**
 * 起動の失敗の種類。殻はこれで失敗の札の文を日英の表から引く。
 * 互換の版の合わない別のサーバが 4177 で動いている失敗は、サーバが起きる前に殻が決めるので、ここには入れない。
 */
export type BootErrorKind = 'server-exited' | 'port-in-use' | 'db-too-old' | 'db-backup-failed';

/**
 * boot-error.json の中身。文は持たない。
 * 見出しや次にすることの文は、殻の読み込みの頁が kind と params から表で引く。
 * detail だけは例外の文そのもので、利用者に見せる記録として札に添える。
 */
export type BootError = { kind: BootErrorKind; params: Record<string, string | number>; detail: string };

export function bootErrorPath(home: string): string {
  return path.join(home, BOOT_ERROR_FILE);
}

/** 起動に失敗した例外を、失敗の種類へ分ける。ここで知らない例外は server-exited に落とす。 */
export function classifyBootError(e: unknown): BootError {
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof DbBackupError) return { kind: 'db-backup-failed', params: { file: e.file, dir: path.dirname(e.file) }, detail };
  if (e instanceof DbTooOldError) return { kind: 'db-too-old', params: { file: e.file, found: e.found, baseline: e.baseline }, detail };
  if (isAddrInUse(e)) {
    // listen の失敗は port と address を持つ。読めた分だけを入れる。
    const params: Record<string, string | number> = {};
    if (typeof e.port === 'number') params.port = e.port;
    if (typeof e.address === 'string') params.host = e.address;
    return { kind: 'port-in-use', params, detail };
  }
  return { kind: 'server-exited', params: {}, detail };
}

function isAddrInUse(e: unknown): e is { code: 'EADDRINUSE'; port?: unknown; address?: unknown } {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'EADDRINUSE';
}

/**
 * 起動に失敗した理由を `<home>/boot-error.json` に書く。書けたら true。
 * 一時のファイルへ書いてから改名するので、殻が書きかけを読むことは無い。
 * 書けなくても投げない。呼び手は元の失敗の報告と終了コードを守らなければならず、書き込みの失敗がそれを隠してはならないからである。
 * 置き場がまだ無いうちの失敗（置き場を作る前に落ちたとき）でも書けるよう、置き場は作る。
 */
export function writeBootError(home: string, e: unknown): boolean {
  const file = bootErrorPath(home);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify(classifyBootError(e), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 残っても読まれない名前である */ }
    console.error('[boot] boot-error.json を書けませんでした', err instanceof Error ? err.message : err);
    return false;
  }
}

/** 古い boot-error.json を消す。無くても、消せなくても投げない。 */
export function clearBootError(home: string): void {
  try {
    fs.rmSync(bootErrorPath(home), { force: true });
  } catch { /* 消せなくても起動は止めない。殻は更新の時刻でも古さを見分ける */ }
}
