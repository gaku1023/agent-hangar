import fs from 'node:fs';
import path from 'node:path';
import type { FolderInspectDto, LinkCandidateDto, WorkspaceChildDto, WorkspaceChildrenDto } from '@agent-hangar/shared';
import { expandHome } from '../config/readiness.ts';
import type { Db } from '../db/open.ts';
import { gitFolderOf, gitRemoteOf } from '../git/remote.ts';
import { msg } from '../i18n/message.ts';
import { isUnder } from '../platform/paths.ts';
import { ProjectCreateError } from './create.ts';
import { enclosingProject, linkCandidateFor, placelessProjects, registeredAt, type PlacelessProject } from './link.ts';
import { normalizeDir } from './registry.ts';

/**
 * フォルダの中から選んで登録する（2026-10-14、0.6.2）。
 * まとめて登録のダイアログの「フォルダの中から」が親の直下を並べる一覧（workspaceChildren）と、
 * 新しいセッションと新しいプロジェクトのダイアログが選んだ 1 つのフォルダを確かめる問い合わせ（inspectFolder）。
 * どちらも読むだけで、行は書かない。
 */

/** 打たれたパスを、絶対で実在するフォルダの正規化した形にする。そうでなければ 400 で断る（登録と同じ文言）。 */
function existingDir(raw: string): string {
  const full = expandHome(raw.trim());
  if (!full) throw new ProjectCreateError(400, msg('project.create.pathNotDir'));
  if (!path.isAbsolute(full)) throw new ProjectCreateError(400, msg('project.create.pathMustBeAbsolute'));
  const dir = normalizeDir(full);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new ProjectCreateError(400, msg('project.create.pathNotDir'));
  return dir;
}

/**
 * 直下の隠しでないフォルダの名前を、Finder と同じ並び（数字は数の順、大文字小文字は区別しない）で返す。
 * 読めないフォルダ（macOS の保護されたフォルダなど）は、子が無いものとして扱う。
 */
function subdirNames(dir: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
}

type Talk = { cwd: string; n: number; last: number | null };

/** この PC の会話の作業フォルダごとの数と最後の活動。ほかの PC の会話のパスはその PC のものなので数えない。 */
function talksOf(db: Db, deviceId: string): Talk[] {
  return (db.prepare(`select cwd, count(*) n, max(last_activity_at) last from sessions
    where home_device = ? and deleted_at is null group by cwd`).all(deviceId) as Talk[]).map((t) => ({ ...t, cwd: t.cwd.normalize('NFC') }));
}

/** 1 行を組む。子（children）と、結び付く候補の重なりは呼び手が決める。 */
function rowOf(db: Db, deviceId: string, dir: string, talks: Talk[], placeless: PlacelessProject[]): WorkspaceChildDto {
  const { git, worktree } = gitFolderOf(dir);
  const remote = git ? gitRemoteOf(dir) : null;
  let sessionCount = 0;
  let lastActivityAt: number | null = null;
  for (const t of talks) {
    if (!isUnder(t.cwd, dir)) continue;
    sessionCount += t.n;
    if (t.last !== null && (lastActivityAt === null || t.last > lastActivityAt)) lastActivityAt = t.last;
  }
  const registered = registeredAt(db, deviceId, dir);
  // worktree は元のリポジトリと同じ remote を持つので、結び付けの先は元のリポジトリの行に任せる。
  const link = registered || worktree ? null : linkCandidateFor(placeless, { name: path.basename(dir), remote });
  return { name: path.basename(dir), path: dir, git, worktree, remote, sessionCount, lastActivityAt, registered, enclosing: enclosingProject(db, deviceId, dir), link, children: null };
}

/**
 * 同じプロジェクトに結び付く行が 2 つ以上あれば（同じリポジトリを 2 つ置いているなど）、1 行にだけ候補を残す。
 * 名前がプロジェクトと同じ行を、無ければ先の行を選ぶ。1 つのプロジェクトがこの PC に持てる場所は 1 つだからである。
 */
function dedupeLinks(rows: WorkspaceChildDto[]): void {
  const all = rows.flatMap((r) => [r, ...(r.children ?? [])]);
  const byProject = new Map<string, WorkspaceChildDto[]>();
  for (const r of all) if (r.link) byProject.set(r.link.projectId, [...(byProject.get(r.link.projectId) ?? []), r]);
  for (const group of byProject.values()) {
    if (group.length < 2) continue;
    const link = group[0]!.link as LinkCandidateDto;
    const keep = group.find((r) => r.name.normalize('NFC').toLowerCase() === link.name.normalize('NFC').toLowerCase()) ?? group[0]!;
    for (const r of group) if (r !== keep) r.link = null;
  }
}

/**
 * 親フォルダの直下の、隠しでないフォルダの一覧（GET /api/workspace/children）。名前順で、会話の無いフォルダも並べる。
 * git でなく中に git のフォルダを持つもの（~/src/clients など）は、1 段下の子も返す。
 * 親は ~ をホームに直す。相対パス、無いフォルダ、ファイルは 400 で断る。
 */
export function workspaceChildren(db: Db, deviceId: string, parent: string): WorkspaceChildrenDto {
  const dir = existingDir(parent);
  const talks = talksOf(db, deviceId);
  const placeless = placelessProjects(db, deviceId);
  const children = subdirNames(dir).map((name) => {
    const row = rowOf(db, deviceId, path.join(dir, name), talks, placeless);
    if (row.git) return row;
    const subs = subdirNames(row.path).map((n) => path.join(row.path, n));
    if (!subs.some((s) => gitFolderOf(s).git)) return row;
    return { ...row, children: subs.map((s) => rowOf(db, deviceId, s, talks, placeless)) };
  });
  dedupeLinks(children);
  return { parent: dir, enclosing: enclosingProject(db, deviceId, dir, { includeSelf: true }), children };
}

/**
 * 選んだ 1 つのフォルダの事前の問い合わせ（GET /api/workspace/inspect）。
 * 登録済みか、登録済みのプロジェクトの中か（その場所からの相対パスも）、結び付く候補があるかを返す。
 * name を渡すと、弱い一致（名前が同じ）はフォルダの名前ではなくその名前で見る（新しいプロジェクトのダイアログで名前を変えたとき）。
 */
export function inspectFolder(db: Db, deviceId: string, raw: string, name?: string): FolderInspectDto {
  const dir = existingDir(raw);
  const { git, worktree } = gitFolderOf(dir);
  const remote = git ? gitRemoteOf(dir) : null;
  const registered = registeredAt(db, deviceId, dir);
  const enclosing = registered ? null : enclosingProject(db, deviceId, dir);
  const linkName = name !== undefined && name.trim() !== '' ? name.trim() : path.basename(dir);
  const link = registered ? null : linkCandidateFor(placelessProjects(db, deviceId), { name: linkName, remote });
  return { path: dir, git, worktree, remote, registered, enclosing: enclosing ? { ...enclosing, relative: path.relative(enclosing.path, dir) } : null, link };
}
