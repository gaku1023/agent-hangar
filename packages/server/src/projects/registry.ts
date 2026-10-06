import fs from 'node:fs';
import path from 'node:path';
import { newId, type ResolveAction } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { isStrictlyUnder, isUnder, pathKey, samePath } from '../platform/paths.ts';

/**
 * パスを比べられる形にそろえる。`..` や末尾の `/` を除き、Unicode を NFC にする。
 * macOS は Finder などで作った名前を NFD（デ＝テ＋濁点）で持つことがあり、readdir もその形で返す。
 * transcript の cwd は NFC で来るので、そろえないと同じフォルダでも文字列が一致しない。
 * APFS は正規化の違いを区別しないので、NFC にしたパスでもそのまま開ける。
 */
export function normalizeDir(p: string): string {
  return path.resolve(p).normalize('NFC');
}

type RootRow = { id: string; project_id: string; device_id: string; path: string; resolved: number; deleted_at: number | null };

/** ルート直下の、隠しでないディレクトリを名前順に返す。 */
function childDirs(root: string): string[] {
  // 無いパスも、ディレクトリでないパスも「子は無い」として扱う。
  // 設定でワークスペースのルートにファイルを指されたときに 500 にしないため。
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => normalizeDir(path.join(root, d.name)))
    .sort();
}

/** プロジェクト行と、この端末のルート（解決済み）を作る。作ったプロジェクトの id を返す。 */
export function insertProject(db: Db, deviceId: string, name: string, dir: string): string {
  const id = newId();
  upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0 }, deviceId);
  upsertShared(db, 'project_roots', { id: newId(), project_id: id, device_id: deviceId, path: dir, resolved: 1 }, deviceId);
  return id;
}

/** ワークスペース直下のディレクトリのうち、セッションを持つものをプロジェクトとして登録する。 */
export function syncProjectsFromWorkspace(db: Db, deviceId: string, workspaceRoot: string): { created: string[] } {
  const created: string[] = [];
  // SQL の文字列比較では NFC と NFD が一致しないので、正規化してから JS で比べる。
  const cwds = (db.prepare('select distinct cwd from sessions where deleted_at is null').all() as { cwd: string }[]).map((r) => r.cwd.normalize('NFC'));
  const known = knownRoots(db, deviceId);
  for (const dir of childDirs(workspaceRoot)) {
    if (!cwds.some((c) => isUnder(c, dir))) continue;
    if (known.has(pathKey(dir))) continue;
    created.push(insertProject(db, deviceId, path.basename(dir), dir));
  }
  return { created };
}

export type WorkspaceDir = { name: string; path: string };

/** この端末の、論理削除されていないルートのパスの比べる鍵（NFC にしてから pathKey）。 */
function knownRoots(db: Db, deviceId: string): Set<string> {
  return new Set((db.prepare('select path from project_roots where device_id = ? and deleted_at is null').all(deviceId) as { path: string }[]).map((r) => pathKey(r.path.normalize('NFC'))));
}

/**
 * ワークスペース直下の、まだプロジェクトになっていないディレクトリ。
 * 新しいセッションのダイアログの検索と、作成のダイアログの一覧に出す。
 * 一覧から削除したプロジェクトのフォルダは、ルートが論理削除されているので未登録に数える。
 */
export function listWorkspaceDirs(db: Db, deviceId: string, workspaceRoot: string): WorkspaceDir[] {
  const known = knownRoots(db, deviceId);
  return childDirs(workspaceRoot).filter((dir) => !known.has(pathKey(dir))).map((dir) => ({ name: path.basename(dir), path: dir }));
}

/**
 * 起動中に現れた未分類のセッションのための、その場の自動登録。
 * cwd がワークスペース直下のディレクトリ（またはその下）にあり、そのディレクトリが実在し、隠しでなく、未登録なら、
 * 起動時の syncProjectsFromWorkspace と同じ規則でプロジェクトにして id を返す。
 * ワークスペースの外とワークスペースそのものは null（未分類に残し、利用者に知らせる）。
 */
export function registerWorkspaceChildOf(db: Db, deviceId: string, workspaceRoot: string, cwd: string): string | null {
  const root = normalizeDir(workspaceRoot);
  const c = normalizeDir(cwd);
  if (!isStrictlyUnder(c, root)) return null;
  const head = path.relative(root, c).split(/[\\/]/)[0]!;
  if (head.startsWith('.')) return null;
  const dir = path.join(root, head);
  // 実在は、NFC にしたパスを開いてではなく、直下の一覧に載っているかで確かめる。
  // ディスク上の名前が NFD のとき、正規化を区別するファイルシステム（Linux など）では NFC のパスでは開けない。
  if (!childDirs(root).some((d) => samePath(d, dir))) return null;
  if (knownRoots(db, deviceId).has(pathKey(dir))) return null;
  return insertProject(db, deviceId, head, dir);
}

/**
 * ワークスペースの直下から登録したプロジェクトの数。
 * この PC で解決済みのルートのうち、親がワークスペースのものを数える。スクラッチと消したものは入れない。
 */
export function workspaceProjectCount(db: Db, deviceId: string, workspaceRoot: string): number {
  const rows = db.prepare(`select r.path from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.resolved = 1 and r.deleted_at is null and p.deleted_at is null and p.is_scratch = 0`).all(deviceId) as { path: string }[];
  const root = path.resolve(workspaceRoot);
  return rows.filter((r) => samePath(path.dirname(r.path), root)).length;
}

/** この端末の解決済みルートを返す。 */
function resolvedRoots(db: Db, deviceId: string): RootRow[] {
  return db.prepare('select * from project_roots where device_id = ? and resolved = 1 and deleted_at is null').all(deviceId) as RootRow[];
}

/** cwd を含むルートのうち、最も深いものを返す。NFC と NFD の違いは無視する。 */
function longestMatch(roots: RootRow[], cwd: string): RootRow | undefined {
  const c = cwd.normalize('NFC');
  return roots.filter((r) => isUnder(c, r.path.normalize('NFC'))).sort((a, b) => b.path.length - a.path.length)[0];
}

/** 未分類のセッションを、この端末の解決済みルートの最長一致で紐づける。 */
export function assignSessions(db: Db, deviceId: string): number {
  const roots = resolvedRoots(db, deviceId);
  const sessions = db.prepare('select * from sessions where project_id is null and deleted_at is null').all() as Record<string, unknown>[];
  let n = 0;
  for (const s of sessions) {
    const match = longestMatch(roots, s.cwd as string);
    if (!match) continue;
    upsertShared(db, 'sessions', { ...s, project_id: match.project_id }, deviceId);
    n++;
  }
  return n;
}

/**
 * 未分類のセッション 1 件を、この端末の解決済みルートの最長一致で紐づける。
 * 紐づけたらプロジェクトの id を返し、既に紐づいているか当たるルートが無ければ null を返す。
 */
export function assignSession(db: Db, deviceId: string, sessionId: string): string | null {
  const s = db.prepare('select * from sessions where id = ? and project_id is null and deleted_at is null').get(sessionId) as Record<string, unknown> | undefined;
  if (!s) return null;
  const match = longestMatch(resolvedRoots(db, deviceId), s.cwd as string);
  if (!match) return null;
  upsertShared(db, 'sessions', { ...s, project_id: match.project_id }, deviceId);
  return match.project_id;
}

/** この端末のルートの存在を確かめ、消えたものと戻ったものを報告する。 */
export function checkProjectRoots(db: Db, deviceId: string): { unresolved: string[]; recovered: string[] } {
  const out = { unresolved: [] as string[], recovered: [] as string[] };
  const roots = db.prepare('select * from project_roots where device_id = ? and deleted_at is null').all(deviceId) as RootRow[];
  for (const r of roots) {
    const exists = fs.existsSync(r.path);
    if (exists && r.resolved === 0) { upsertShared(db, 'project_roots', { ...r, resolved: 1 }, deviceId); out.recovered.push(r.project_id); }
    if (!exists && r.resolved === 1) { upsertShared(db, 'project_roots', { ...r, resolved: 0 }, deviceId); out.unresolved.push(r.project_id); }
  }
  return out;
}

/** 未解決のプロジェクトに対する操作を適用する。unlink は行の論理削除だけで、ディレクトリには触れない。 */
export function resolveProject(db: Db, deviceId: string, projectId: string, action: ResolveAction): void {
  const root = db.prepare('select * from project_roots where project_id = ? and device_id = ? and deleted_at is null').get(projectId, deviceId) as RootRow | undefined;
  const project = db.prepare('select * from projects where id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!project) return;
  switch (action.kind) {
    case 'repoint': {
      // `..` や末尾の `/` が残ると longestMatch の前方一致に cwd が当たらず、
      // そのプロジェクトには永久にセッションが紐づかない。必ず正規化してから入れる。
      // 新規登録（POST /api/projects）と同じ扱いである。
      const dir = normalizeDir(action.path);
      if (root) upsertShared(db, 'project_roots', { ...root, path: dir, resolved: 1 }, deviceId);
      else upsertShared(db, 'project_roots', { id: newId(), project_id: projectId, device_id: deviceId, path: dir, resolved: 1 }, deviceId);
      assignSessions(db, deviceId);
      return;
    }
    case 'archive':
      upsertShared(db, 'projects', { ...project, status: 'archived' }, deviceId);
      return;
    case 'unlink': {
      const sessions = db.prepare('select * from sessions where project_id = ?').all(projectId) as Record<string, unknown>[];
      for (const s of sessions) upsertShared(db, 'sessions', { ...s, project_id: null }, deviceId);
      if (root) softDeleteShared(db, 'project_roots', root.id, deviceId);
      softDeleteShared(db, 'projects', projectId, deviceId);
      return;
    }
  }
}

/** 名前が近い直下ディレクトリを名前順に返す。 */
export function candidateDirs(workspaceRoot: string, name: string): string[] {
  const needle = name.toLowerCase();
  return childDirs(workspaceRoot).filter((dir) => {
    const base = path.basename(dir).toLowerCase();
    return base.includes(needle) || needle.includes(base) || (needle.length >= 3 && base.startsWith(needle.slice(0, 3)));
  });
}
