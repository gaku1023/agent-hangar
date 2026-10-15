import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CandidateNote, CloudSyncedKind } from '@agent-hangar/shared';
import { isUnder, pathKey, samePath } from '../platform/paths.ts';

/**
 * 会話したフォルダの候補に添える注記（セットアップのすゝめ、2026-10-15）。
 * Claude Code が利用者の環境を診断して、プロジェクトに登録するフォルダを選ぶときに読む。
 * どちらの判定も、パスの形と、差し替えられる問い合わせだけで決める（試験で OS をまたいで確かめるため）。
 */

/** Windows の形（ドライブ文字か UNC）のパスか。 */
const isWinStyle = (p: string): boolean => /^[A-Za-z]:[\\/]|^\\\\/.test(p);
/**
 * パスの形に合った path の関数。
 * macOS で Windows のパスを試験しても、同じ答えになるようにする。
 */
const pathOf = (p: string): path.PlatformPath => (isWinStyle(p) ? path.win32 : path.posix);

/**
 * クラウドの同期の判定に使う環境。
 * exists と realpath は、ファイルシステムへの問い合わせを差し替える口である。
 * realpath は引けなければ null を返す。
 */
export type CloudSyncEnv = {
  platform: NodeJS.Platform;
  homeDir: string;
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  realpath: (p: string) => string | null;
};

/** 動いている PC の環境。 */
export function defaultCloudSyncEnv(homeDir: string = os.homedir()): CloudSyncEnv {
  return {
    platform: process.platform,
    homeDir,
    env: process.env,
    exists: (p) => fs.existsSync(p),
    realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
  };
}

/**
 * Windows の OneDrive の置き場を指す環境変数。
 * 個人用と職場用で名前が分かれる。
 */
const ONEDRIVE_VARS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'] as const;

/**
 * 末尾の区切りを落とす。
 * ドライブの直下（C:\）と / は残す。
 */
function trimSep(p: string): string {
  const P = pathOf(p);
  const root = P.parse(p).root;
  return p.length > root.length ? p.replace(/[\\/]+$/, '') : p;
}

/**
 * フォルダがクラウドで同期されている場所にあるか。
 * macOS は iCloud（~/Library/Mobile Documents の下、実体がそこにあるもの、iCloud の「デスクトップと書類」）、
 * Windows は OneDrive（環境変数の置き場の下、ホームの直下の OneDrive の名前のフォルダの下）を見る。
 * ほかの OS は null。
 * 同期の中のフォルダでは、git の作業と同期が同じファイルを取り合うので、セットアップのすゝめが注意を促す。
 */
export function cloudSyncedOf(p: string, e: CloudSyncEnv): CloudSyncedKind | null {
  if (e.platform === 'darwin') {
    const mobile = path.posix.join(e.homeDir, 'Library', 'Mobile Documents');
    if (isUnder(p, mobile)) return 'icloud';
    const real = e.realpath(p);
    if (real !== null && isUnder(real, mobile)) return 'icloud';
    // 「デスクトップと書類」を iCloud に入れると、iCloud Drive の中に Desktop と Documents が現れる。
    for (const name of ['Desktop', 'Documents']) {
      if (isUnder(p, path.posix.join(e.homeDir, name)) && e.exists(path.posix.join(mobile, 'com~apple~CloudDocs', name))) return 'icloud';
    }
    return null;
  }
  if (e.platform === 'win32') {
    for (const v of ONEDRIVE_VARS) {
      const root = e.env[v]?.trim();
      if (root && isUnder(p, trimSep(root), 'win32')) return 'onedrive';
    }
    // 既知のフォルダ（デスクトップ、ドキュメント）を OneDrive へ移すと、ホームの直下の OneDrive（職場用は「OneDrive - 組織名」）の下に入る。
    const home = pathKey(trimSep(e.homeDir), 'win32');
    const key = pathKey(p, 'win32');
    if (key.startsWith(`${home}\\`)) {
      const first = key.slice(home.length + 1).split('\\')[0] ?? '';
      if (/^onedrive( - .+)?$/.test(first)) return 'onedrive';
    }
    return null;
  }
  return null;
}

/** 注記の判定に使う候補の項目。 */
export type NoteInput = { path: string; sessionCount: number; lastActivityAt: number | null; isGit: boolean };

/** 古いとみなす間隔（30 日）。 */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** dir そのものか、その直下か。 */
function atOrDirectlyUnder(p: string, dir: string): boolean {
  const P = pathOf(dir);
  return samePath(p, dir, isWinStyle(dir) ? 'win32' : 'linux') || samePath(P.dirname(p), dir, isWinStyle(dir) ? 'win32' : 'linux');
}

/**
 * 候補の注記の符号。
 * 並びは desktop-direct、downloads-direct、not-git、stale-30d、single-session の順である。
 * desktop-direct と downloads-direct は、そのフォルダそのものか直下のフォルダに付ける（散らばった作業か、落とした物を開いた場所であることが多い）。
 */
export function candidateNotes(c: NoteInput, e: { homeDir: string; now: number }): CandidateNote[] {
  const P = pathOf(e.homeDir);
  const out: CandidateNote[] = [];
  const p = isWinStyle(c.path) ? path.win32.normalize(c.path) : c.path;
  if (atOrDirectlyUnder(p, P.join(e.homeDir, 'Desktop'))) out.push('desktop-direct');
  if (atOrDirectlyUnder(p, P.join(e.homeDir, 'Downloads'))) out.push('downloads-direct');
  if (!c.isGit) out.push('not-git');
  if (c.lastActivityAt !== null && e.now - c.lastActivityAt > STALE_MS) out.push('stale-30d');
  if (c.sessionCount === 1) out.push('single-session');
  return out;
}
