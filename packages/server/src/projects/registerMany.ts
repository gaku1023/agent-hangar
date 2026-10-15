import type { FolderRegisterItem, FolderRegisterOutcomeDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { ProjectCreateError, ProjectNestedError, registerProjectDir } from './create.ts';
import { assignSessions, syncProjectsFromWorkspace } from './registry.ts';

/**
 * まとめて登録の本体（POST /api/workspace/register）。
 * 1 件ずつ registerProjectDir で登録し、最後に未分類の会話をまとめて紐づけ直す。
 * 登録できなかったものは断らずに理由を添えて返し、ほかの登録は残す。
 * 試し（--dry-run）は、これを tryWrites で包んで呼ぶ。書き込みも検証も本物と同じ関数を通り、最後に巻き戻る。
 */
export type RegisterManyDeps = { db: Db; deviceId: string; workspaceRoot: string };

/** 断った理由の文。言語は経路が決める。 */
export type DescribeError = (e: ProjectCreateError) => string;

/**
 * いま未分類の会話（プロジェクトが無いか、消したプロジェクトに紐づいたまま）の id。
 * assignSessions が拾うのと同じ集まりで、登録の前後で比べて、その場で紐づいた数を数える。
 */
export function unassignedSessionIds(db: Db): Set<string> {
  return new Set((db.prepare(`select s.id from sessions s where s.deleted_at is null
    and (s.project_id is null or exists (select 1 from projects p where p.id = s.project_id and p.deleted_at is not null))`).all() as { id: string }[]).map((r) => r.id));
}

/** before にあった会話のうち、いまプロジェクトに入ったものを、プロジェクトごとに数える。 */
export function newlyAssignedCounts(db: Db, before: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db.prepare('select id, project_id from sessions where deleted_at is null and project_id is not null').all() as { id: string; project_id: string }[]) {
    if (before.has(r.id)) out.set(r.project_id, (out.get(r.project_id) ?? 0) + 1);
  }
  return out;
}

/**
 * 作成場所を root にしたときの、直下のフォルダの自動の登録（syncProjectsFromWorkspace）と紐づけ直しを走らせ、登録したものを返す。
 * 設定の保存（PATCH /api/settings）と同じ 2 つの関数を通す。試し（hangar workspace set --dry-run）は、これを tryWrites で包んで呼ぶ。
 * status は added（新しく作る）か linked（ほかの PC から届いたプロジェクトへ結び付ける）で、並びはパスの順である。
 */
export function workspaceSyncOutcomes(db: Db, deviceId: string, root: string): FolderRegisterOutcomeDto[] {
  const before = unassignedSessionIds(db);
  const r = syncProjectsFromWorkspace(db, deviceId, root);
  assignSessions(db, deviceId);
  const counts = newlyAssignedCounts(db, before);
  const row = db.prepare(`select p.name, r.path from projects p join project_roots r on r.project_id = p.id and r.device_id = ? and r.deleted_at is null where p.id = ?`);
  const one = (projectId: string, status: 'added' | 'linked'): FolderRegisterOutcomeDto => {
    const x = row.get(deviceId, projectId) as { name: string; path: string };
    return { path: x.path, status, projectId, name: x.name, sessionCount: counts.get(projectId) ?? 0 };
  };
  return [...r.created.map((id) => one(id, 'added')), ...r.linked.map((id) => one(id, 'linked'))].sort((a, b) => a.path.localeCompare(b.path));
}

/** 行ごとの結果を本文の並びで返す。同じプロジェクトに 2 行が当たったときは、紐づいた会話の数を先の行にだけ載せる。 */
export function registerFolders(deps: RegisterManyDeps, items: FolderRegisterItem[], describe: DescribeError): FolderRegisterOutcomeDto[] {
  const { db, deviceId } = deps;
  const before = unassignedSessionIds(db);
  const archived = new Set((db.prepare("select id from projects where status = 'archived' and deleted_at is null").all() as { id: string }[]).map((r) => r.id));
  const outcomes: FolderRegisterOutcomeDto[] = [];
  for (const it of items) {
    try {
      const r = registerProjectDir(deps, { path: it.path, allowNested: it.allowNested === true, linkTo: it.linkTo });
      const status = r.linked ? 'linked' : r.created ? 'added' : 'already';
      outcomes.push({ path: it.path, status, projectId: r.projectId, ...(status === 'already' && archived.has(r.projectId) ? { restored: true } : {}) });
    } catch (e) {
      if (e instanceof ProjectNestedError) outcomes.push({ path: it.path, status: 'nested', enclosing: e.enclosing, error: describe(e) });
      else if (e instanceof ProjectCreateError) outcomes.push({ path: it.path, status: 'error', error: describe(e) });
      else throw e;
    }
  }
  if (outcomes.some((o) => o.projectId !== undefined)) assignSessions(db, deviceId);
  const counts = newlyAssignedCounts(db, before);
  const name = db.prepare('select name from projects where id = ?');
  const seen = new Set<string>();
  for (const o of outcomes) {
    if (o.projectId === undefined) continue;
    o.name = (name.get(o.projectId) as { name: string } | undefined)?.name;
    o.sessionCount = seen.has(o.projectId) ? 0 : counts.get(o.projectId) ?? 0;
    seen.add(o.projectId);
  }
  return outcomes;
}
