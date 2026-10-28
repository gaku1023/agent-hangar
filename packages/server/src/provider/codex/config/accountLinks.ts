import fs from 'node:fs';
import path from 'node:path';
import { CODEX_ACCOUNT_LINK_GROUPS } from '@agent-hangar/shared';

/**
 * Codex の 2 つ目以降の置き場で、最初の置き場（~/.codex）へのリンクにする項目。
 * 認証（auth.json）、sqlite 類、logs、キャッシュ、tmp、installation_id、version.json は分けたままにする。
 * 画面に見せる組（CODEX_ACCOUNT_LINK_GROUPS）と同じ項目で、ずれは試験が見張る。
 */
export const CODEX_LINKED_ENTRIES: readonly string[] = CODEX_ACCOUNT_LINK_GROUPS.flatMap((g) => g.entries);

type Found = { created: string[]; conflicts: string[] };

function scan(primaryDir: string, dir: string, make: boolean): Found {
  const created: string[] = [];
  const conflicts: string[] = [];
  for (const name of CODEX_LINKED_ENTRIES) {
    const target = path.join(primaryDir, name);
    if (!fs.existsSync(target)) continue;
    const link = path.join(dir, name);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(link); } catch { st = null; }
    if (st === null) {
      if (make) { fs.symlinkSync(target, link); created.push(name); }
      continue;
    }
    if (st.isSymbolicLink() && path.resolve(dir, fs.readlinkSync(link)) === path.resolve(target)) continue;
    conflicts.push(name);
  }
  return { created, conflicts };
}

/**
 * 置き場を作り、最初の置き場にある項目へリンクを張る。Claude の ensureAccountLinks と同じ契約である。
 * リンクの場所に別のもの（実ファイル、実ディレクトリ、別の先を指すリンク）があれば、触らずに conflicts へ挙げる。
 */
export function ensureCodexAccountLinks(primaryDir: string, dir: string): Found {
  if (path.resolve(primaryDir) === path.resolve(dir)) return { created: [], conflicts: [] };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return scan(primaryDir, dir, true);
}

/** 足す前の確かめ。何も作らず、何も書かない。挙げる名前と順は ensureCodexAccountLinks の conflicts と同じである。 */
export function inspectCodexAccountLinks(primaryDir: string, dir: string): { exists: boolean; conflicts: string[] } {
  const exists = fs.existsSync(dir);
  if (!exists || path.resolve(primaryDir) === path.resolve(dir)) return { exists, conflicts: [] };
  return { exists, conflicts: scan(primaryDir, dir, false).conflicts };
}
