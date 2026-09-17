import fs from 'node:fs';
import path from 'node:path';
import { newId, type ResolveAction } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';

type RootRow = { id: string; project_id: string; device_id: string; path: string; resolved: number; deleted_at: number | null };

/** ルート直下の、隠しでないディレクトリを名前順に返す。 */
function childDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => path.join(root, d.name))
    .sort();
}

/** cwd がそのディレクトリ以下にあるセッションが 1 つ以上あるかを返す。 */
function hasSessionUnder(db: Db, dir: string): boolean {
  return db.prepare("select 1 from sessions where deleted_at is null and (cwd = ? or cwd like ? escape '\\') limit 1")
    .get(dir, dir.replace(/[%_\\]/g, (c) => '\\' + c) + '/%') !== undefined;
}

/** ワークスペース直下のディレクトリのうち、セッションを持つものをプロジェクトとして登録する。 */
export function syncProjectsFromWorkspace(db: Db, deviceId: string, workspaceRoot: string): { created: string[] } {
  const created: string[] = [];
  for (const dir of childDirs(workspaceRoot)) {
    if (!hasSessionUnder(db, dir)) continue;
    const exists = db.prepare('select 1 from project_roots where device_id = ? and path = ? and deleted_at is null').get(deviceId, dir);
    if (exists) continue;
    const id = newId();
    upsertShared(db, 'projects', { id, name: path.basename(dir), status: 'active', is_scratch: 0 }, deviceId);
    upsertShared(db, 'project_roots', { id: newId(), project_id: id, device_id: deviceId, path: dir, resolved: 1 }, deviceId);
    created.push(id);
  }
  return { created };
}

/** 未分類のセッションを、この端末の解決済みルートの最長一致で紐づける。 */
export function assignSessions(db: Db, deviceId: string): number {
  const roots = db.prepare('select * from project_roots where device_id = ? and resolved = 1 and deleted_at is null').all(deviceId) as RootRow[];
  const sessions = db.prepare('select * from sessions where project_id is null and deleted_at is null').all() as Record<string, unknown>[];
  let n = 0;
  for (const s of sessions) {
    const cwd = s.cwd as string;
    const match = roots.filter((r) => cwd === r.path || cwd.startsWith(r.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
    if (!match) continue;
    upsertShared(db, 'sessions', { ...s, project_id: match.project_id }, deviceId);
    n++;
  }
  return n;
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
    case 'repoint':
      if (root) upsertShared(db, 'project_roots', { ...root, path: action.path, resolved: 1 }, deviceId);
      else upsertShared(db, 'project_roots', { id: newId(), project_id: projectId, device_id: deviceId, path: action.path, resolved: 1 }, deviceId);
      assignSessions(db, deviceId);
      return;
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
