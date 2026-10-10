import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LANGUAGE } from '@agent-hangar/shared';
import { msg, render, type Message } from '../../../i18n/message.ts';

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
 */
export function ensureAccountLinks(primaryDir: string, dir: string): { created: string[]; conflicts: string[] } {
  const created: string[] = [];
  const conflicts: string[] = [];
  if (path.resolve(primaryDir) === path.resolve(dir)) return { created, conflicts };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of LINKED_ENTRIES) {
    const target = path.join(primaryDir, name);
    if (!fs.existsSync(target)) continue;
    const link = path.join(dir, name);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(link); } catch { st = null; }
    if (st === null) { fs.symlinkSync(target, link); created.push(name); continue; }
    if (st.isSymbolicLink() && path.resolve(dir, fs.readlinkSync(link)) === path.resolve(target)) continue;
    conflicts.push(name);
  }
  return { created, conflicts };
}

/** リンクの場所に別のものが置かれているときの文。言語は、出す側（経路、起動）が選ぶ。 */
export function linkProblemMessage(conflicts: string[]): Message | null {
  if (conflicts.length === 0) return null;
  return msg('account.links.conflict', { names: conflicts });
}

/** 同じ文を、既定の言語（日本語）で返す。 */
export function linkProblem(conflicts: string[]): string | null {
  const m = linkProblemMessage(conflicts);
  return m ? render(DEFAULT_LANGUAGE, m) : null;
}
