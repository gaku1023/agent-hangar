import fs from 'node:fs';
import path from 'node:path';
import { CODEX_ACCOUNT_LINK_GROUPS } from '@agent-hangar/shared';
import { linkEntries, type LinkOptions, type LinkResult } from '../../../platform/links.ts';

/**
 * Codex の 2 つ目以降の置き場で、最初の置き場（~/.codex）へのリンクにする項目。
 * 認証（auth.json）、sqlite 類、logs、キャッシュ、tmp、installation_id、version.json は分けたままにする。
 * 画面に見せる組（CODEX_ACCOUNT_LINK_GROUPS）と同じ項目で、ずれは試験が見張る。
 */
export const CODEX_LINKED_ENTRIES: readonly string[] = CODEX_ACCOUNT_LINK_GROUPS.flatMap((g) => g.entries);

/**
 * 置き場を作り、最初の置き場にある項目へリンクを張る。Claude の ensureAccountLinks と同じ契約である。
 * リンクの場所に別のもの（実ファイル、実ディレクトリ、別の先を指すリンク）があれば、触らずに conflicts へ挙げる。
 * 張れなかった項目（Windows の EPERM など）は、残りを止めずに unlinked へ挙げる。
 */
export function ensureCodexAccountLinks(primaryDir: string, dir: string, opts: LinkOptions = {}): LinkResult {
  if (path.resolve(primaryDir) === path.resolve(dir)) return { created: [], conflicts: [], unlinked: [] };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return linkEntries(primaryDir, dir, CODEX_LINKED_ENTRIES, true, opts);
}

/** 足す前の確かめ。何も作らず、何も書かない。挙げる名前と順は ensureCodexAccountLinks の conflicts と同じである。 */
export function inspectCodexAccountLinks(primaryDir: string, dir: string, opts: LinkOptions = {}): { exists: boolean; conflicts: string[] } {
  const exists = fs.existsSync(dir);
  if (!exists || path.resolve(primaryDir) === path.resolve(dir)) return { exists, conflicts: [] };
  return { exists, conflicts: linkEntries(primaryDir, dir, CODEX_LINKED_ENTRIES, false, opts).conflicts };
}
