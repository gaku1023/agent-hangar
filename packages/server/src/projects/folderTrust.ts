import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceTrustDto } from '@agent-hangar/shared';
import { claudeJsonFor, trustFolders, untrustedFolders } from '../provider/claude-code/config/claudeJson.ts';
import { isUnder, samePath } from '../platform/paths.ts';
import { hasWorkspaceRoot, normalizeDir } from './registry.ts';
import { legacyScratchRoot, quickSessionsRoot } from './scratch.ts';

/**
 * フォルダの信頼（Claude Code の「このフォルダを信頼しますか」）を、hangar が前もって答えておく場所を決める。
 *
 * Claude Code 2.1.301 で実物を確かめた判定は次のとおり（docs/design.md の「フォルダの信頼」）。
 * - 作業フォルダから上へ親をたどり、どれかの projects.<path>.hasTrustDialogAccepted が true なら信頼済みとみなす。子の行に false が書いてあっても、親の true が効く。
 * - ただし git のリポジトリの中では、たどるのはリポジトリの根までである。リポジトリの外の親を信頼しても、中には及ばない。
 *
 * そこで、信頼する場所（置き場）は置き場そのものを信頼し、作業フォルダが置き場の下の git のリポジトリの中なら、その根も信頼する。
 * 置き場は、クイックセッションの 2 つの置き場（いつも）と、利用者が同意した作業フォルダ（hangar workspace set --trust）である。
 */

export type TrustPlacesInput = { hangarHome: string; trustedWorkspace: string | null };

/** 信頼する置き場。クイックセッションの置き場（quick-sessions と前の scratch）はいつも、作業フォルダは同意したときだけ。 */
export function trustedPlaces(o: TrustPlacesInput): string[] {
  const quick = [quickSessionsRoot(o.hangarHome), legacyScratchRoot(o.hangarHome)];
  return o.trustedWorkspace ? [...quick, o.trustedWorkspace] : quick;
}

/**
 * 同意を得た作業フォルダ。同意した場所（trustedWorkspaceRoot）が、いまの作業フォルダと同じときだけ返す。
 * 作業フォルダを別の場所に変えたら、前の同意は新しい場所には及ばない（設定の保存で消す）。
 */
export function trustedWorkspaceOf(s: { workspaceRoot: string; trustedWorkspaceRoot?: string | null }): string | null {
  if (!hasWorkspaceRoot(s.workspaceRoot) || !hasWorkspaceRoot(s.trustedWorkspaceRoot)) return null;
  return samePath(normalizeDir(s.workspaceRoot), normalizeDir(s.trustedWorkspaceRoot)) ? path.resolve(s.workspaceRoot) : null;
}

const hasGit = (dir: string): boolean => fs.existsSync(path.join(dir, '.git'));

/**
 * cwd で claude を起こす前に信頼済みにするフォルダ。置き場の外なら空。
 * 置き場そのものと、cwd から置き場までの間（置き場は除く）でいちばん近い git のリポジトリの根を返す。
 */
export function launchTrustDirs(cwd: string, places: string[]): string[] {
  const c = path.resolve(cwd);
  const place = places.map((p) => path.resolve(p)).filter((p) => isUnder(c, p)).sort((x, y) => y.length - x.length)[0];
  if (!place) return [];
  for (let d = c; !samePath(d, place); d = path.dirname(d)) {
    if (hasGit(d)) return [place, d];
    if (path.dirname(d) === d) break;
  }
  return [place];
}

/**
 * 作業フォルダに同意したときに信頼済みにするフォルダ。作業フォルダそのものと、直下の git のリポジトリである。
 * 直下のふつうのフォルダは親の信頼が及ぶので書かない。後から置いたリポジトリは、hangar から起こすときに launchTrustDirs が足す。
 */
export function workspaceTrustDirs(root: string): string[] {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  const repos = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => path.join(root, d.name))
    .filter(hasGit)
    .sort();
  return [root, ...repos];
}

export type FolderTrustDeps = {
  /** hangar のホーム（~/.agent-hangar）。 */
  hangarHome: string;
  /** 利用者のホーム。最初のアカウントの .claude.json はここの直下にある。 */
  homeDir: string;
  /** 同意を得た作業フォルダ。無ければ null。 */
  trustedWorkspace: () => string | null;
};

/**
 * claude を起こす直前に呼ぶ。cwd が置き場の下なら、起こす置き場（configDir、最初のアカウントは null）の .claude.json に信頼を書く。
 * 全部すでに信頼済みなら書かない。控えは hangar のホームの backups に置く。
 */
export function trustBeforeLaunch(deps: FolderTrustDeps, configDir: string | null, cwd: string): string[] {
  const dirs = launchTrustDirs(cwd, trustedPlaces({ hangarHome: deps.hangarHome, trustedWorkspace: deps.trustedWorkspace() }));
  if (dirs.length === 0) return [];
  return trustFolders(claudeJsonFor(configDir, deps.homeDir), dirs, { backupDir: path.join(deps.hangarHome, 'backups') }).added;
}

/**
 * 作業フォルダの信頼を、登録したアカウントの全部の .claude.json に書く（dryRun なら書かずに、書くものを返す）。
 * files は書く先の .claude.json。1 つが失敗しても残りは続け、失敗はその行に載せる。
 */
export function trustWorkspaceFolders(o: { root: string; files: string[]; backupDir: string; dryRun: boolean }): WorkspaceTrustDto {
  const dirs = workspaceTrustDirs(o.root);
  const files = o.files.map((file) => {
    try {
      if (o.dryRun) {
        const left = untrustedFolders(file, dirs);
        return { file, added: left ?? [], missing: left === null };
      }
      const r = trustFolders(file, dirs, { backupDir: o.backupDir });
      return { file, added: r.added, missing: r.missing };
    } catch (e) {
      return { file, added: [], missing: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { dryRun: o.dryRun, workspaceRoot: o.root, dirs, files };
}
