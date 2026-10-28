import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LANGUAGE } from '@agent-hangar/shared';
import { msg, render, type Message } from '../../../i18n/message.ts';
import { linkEntries, type LinkOptions, type LinkResult } from '../../../platform/links.ts';

/**
 * 2 つ目以降の置き場で、最初の置き場へのリンクにする項目。
 * 認証（.claude.json と Keychain）と、組織から配られる設定、キャッシュ、常駐のサービスの状態は入れない。
 * 実物で確かめた組である（docs/superpowers/specs/2026-10-06-account-switch-design.md）。
 */
export const LINKED_ENTRIES: readonly string[] = [
  'CLAUDE.md', 'settings.json', 'statusline-command.sh', 'history.jsonl', 'commands', 'skills', 'plugins', 'memory', 'projects',
  'file-history', 'paste-cache', 'plans', 'tasks', 'session-env', 'shell-snapshots', 'sessions', 'jobs',
];

/**
 * 置き場を作り、最初の置き場にある項目へリンクを張る。
 * リンクの場所に別のもの（実ファイル、実ディレクトリ、別の先を指すリンク）があれば、触らずに conflicts へ挙げる。
 * 黙って張り直すと、そこへ書かれた設定や履歴を失うためである。
 * 張れなかった項目（Windows の EPERM など）は、残りを止めずに unlinked へ挙げる（platform/links.ts）。
 */
export function ensureAccountLinks(primaryDir: string, dir: string, opts: LinkOptions = {}): LinkResult {
  if (path.resolve(primaryDir) === path.resolve(dir)) return { created: [], conflicts: [], unlinked: [] };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return linkEntries(primaryDir, dir, LINKED_ENTRIES, true, opts);
}

/**
 * 足す前の確かめ。場所が既にあるかと、リンクを張る名前に別のもの（実ファイル、実フォルダ、別の先を指すリンク）があるかを答える。
 * 何も作らず、何も書かない。挙げる名前と順は ensureAccountLinks の conflicts と同じである。
 */
export function inspectAccountLinks(primaryDir: string, dir: string, opts: LinkOptions = {}): { exists: boolean; conflicts: string[] } {
  const exists = fs.existsSync(dir);
  if (!exists || path.resolve(primaryDir) === path.resolve(dir)) return { exists, conflicts: [] };
  return { exists, conflicts: linkEntries(primaryDir, dir, LINKED_ENTRIES, false, opts).conflicts };
}

/**
 * リンクの場所に別のものが置かれているとき、または張れなかった項目があるときの文。言語は、出す側（経路、起動）が選ぶ。
 * 両方あれば、利用者が手で直せる conflicts を先に出す。
 */
export function linkProblemMessage(conflicts: string[], unlinked: string[] = []): Message | null {
  if (conflicts.length > 0) return msg('account.links.conflict', { names: conflicts });
  if (unlinked.length > 0) return msg('account.links.unlinked', { names: unlinked });
  return null;
}

/** 同じ文を、既定の言語（日本語）で返す。 */
export function linkProblem(conflicts: string[], unlinked: string[] = []): string | null {
  const m = linkProblemMessage(conflicts, unlinked);
  return m ? render(DEFAULT_LANGUAGE, m) : null;
}
