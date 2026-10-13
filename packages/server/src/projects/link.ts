import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { gitRemoteOf, sameRemote } from '../git/remote.ts';
import { isStrictlyUnder, isUnder, samePath } from '../platform/paths.ts';

/**
 * フォルダとプロジェクトの関係（2026-10-14、0.6.1）。
 *
 * - 登録済み（registeredAt）：フォルダがこの PC のプロジェクトの場所そのもの。
 * - 別のプロジェクトの中（enclosingProject）：フォルダがこの PC のプロジェクトの場所の下にある。
 * - 結び付く候補（linkCandidateFor）：この PC に場所の無いプロジェクトのうち、
 *   git の remote が同じもの（強い一致）と、名前が同じで remote が食い違わないもの（弱い一致）。
 *   結び付けは「場所を再指定」と同じ書き込みである（registry.ts の linkProjectHere）。
 *
 * どれも登録済みの場所との比べで、綴りの違い（NFC と NFD、Windows の大文字小文字）は同じフォルダとして比べる。
 * registry.ts から呼ばれるので、ここからは registry.ts を読まない。
 */

export type ProjectRef = { projectId: string; name: string };
export type EnclosingProject = ProjectRef & { path: string };
/**
 * 結び付く候補。match は一致の強さ（remote は強い一致、name は弱い一致）。
 * deviceName と previousPath は、そのプロジェクトの場所を持つ PC の名前と、そこでのパスである。
 * この PC で場所が見つからなくなったもの（missing）は、deviceName が null で、previousPath がこの PC の前のパスである。
 */
export type LinkCandidate = ProjectRef & { match: 'remote' | 'name'; remote: string | null; deviceName: string | null; previousPath: string | null };

type RootRow = { project_id: string; name: string; path: string; resolved: number; is_scratch: number };

/** この PC の、消していない場所の行（プロジェクトも消していないもの）。 */
function liveRoots(db: Db, deviceId: string): RootRow[] {
  return db.prepare(`select r.project_id, p.name, r.path, r.resolved, p.is_scratch from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.deleted_at is null and p.deleted_at is null`).all(deviceId) as RootRow[];
}

/** dir がこの PC のプロジェクトの場所そのものなら、そのプロジェクト。無ければ null。 */
export function registeredAt(db: Db, deviceId: string, dir: string): ProjectRef | null {
  const d = dir.normalize('NFC');
  const hit = liveRoots(db, deviceId).find((r) => samePath(r.path.normalize('NFC'), d));
  return hit ? { projectId: hit.project_id, name: hit.name } : null;
}

/**
 * dir を下に持つ、この PC のプロジェクトのうち、いちばん深いもの。無ければ null。
 * 数えるのは、場所の見つかっているもの（セッションの紐づけの最長一致と同じ行）で、スクラッチは数えない。
 * includeSelf を付けると、dir が場所そのもののときも返す（まとめて登録の親フォルダの帯に使う）。
 */
export function enclosingProject(db: Db, deviceId: string, dir: string, o: { includeSelf?: boolean } = {}): EnclosingProject | null {
  const d = dir.normalize('NFC');
  const under = o.includeSelf ? isUnder : isStrictlyUnder;
  const hit = liveRoots(db, deviceId)
    .filter((r) => r.resolved === 1 && r.is_scratch === 0 && under(d, r.path.normalize('NFC')))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return hit ? { projectId: hit.project_id, name: hit.name, path: hit.path } : null;
}

/** この PC に場所の無いプロジェクト 1 件。結び付く候補を選ぶ元である。 */
export type PlacelessProject = ProjectRef & { remote: string | null; deviceName: string | null; previousPath: string | null };

/**
 * この PC に場所の無い（場所の行が無いか、見つからない）プロジェクト。
 * 消したもの、スクラッチ、アーカイブは入れない。アーカイブは、使わないと決めたものを黙って起こさないためである。
 * 並びは、新しく書かれた順である。
 */
export function placelessProjects(db: Db, deviceId: string): PlacelessProject[] {
  const rows = db.prepare(`select p.id, p.name, p.git_remote, mine.path mine_path from projects p
    left join project_roots mine on mine.project_id = p.id and mine.device_id = ? and mine.deleted_at is null
    where p.deleted_at is null and p.is_scratch = 0 and p.status <> 'archived' and (mine.id is null or mine.resolved = 0)
    order by p.updated_at desc, p.id`).all(deviceId) as { id: string; name: string; git_remote: string | null; mine_path: string | null }[];
  const other = db.prepare(`select r.path, d.name from project_roots r left join devices d on d.id = r.device_id and d.deleted_at is null
    where r.project_id = ? and r.device_id <> ? and r.deleted_at is null order by r.updated_at desc limit 1`);
  return rows.map((r) => {
    if (r.mine_path !== null) return { projectId: r.id, name: r.name, remote: r.git_remote, deviceName: null, previousPath: r.mine_path };
    const o = other.get(r.id, deviceId) as { path: string; name: string | null } | undefined;
    return { projectId: r.id, name: r.name, remote: r.git_remote, deviceName: o?.name ?? null, previousPath: o?.path ?? null };
  });
}

const nameKey = (s: string): string => s.normalize('NFC').trim().toLowerCase();

/**
 * フォルダ（名前と remote）に結び付く候補を 1 つ選ぶ。無ければ null。
 * remote が同じもの（強い一致）を先に、無ければ名前が同じで remote が食い違わないもの（弱い一致）を選ぶ。
 * 同じ強さが複数あれば、新しく書かれたもの（placelessProjects の並び）を選ぶ。
 * remote がどちらにもあって違うときは、名前が同じでも別のリポジトリなので候補にしない。
 */
export function linkCandidateFor(list: PlacelessProject[], folder: { name: string; remote: string | null }): LinkCandidate | null {
  const strong = folder.remote ? list.find((p) => sameRemote(p.remote, folder.remote)) : undefined;
  const key = nameKey(folder.name);
  const hit = strong ?? list.find((p) => nameKey(p.name) === key && !(p.remote && folder.remote && !sameRemote(p.remote, folder.remote)));
  if (!hit) return null;
  return { projectId: hit.projectId, name: hit.name, match: strong ? 'remote' : 'name', remote: hit.remote, deviceName: hit.deviceName, previousPath: hit.previousPath };
}

/**
 * プロジェクトの remote が空なら、この PC のフォルダから埋める。書いたら true。
 * 埋まっている値は書き換えない。PC ごとに remote が違うと（フォークなど）、起動のたびに書き合いになるからである。
 */
export function fillProjectRemote(db: Db, deviceId: string, projectId: string, dir: string): boolean {
  const row = db.prepare('select * from projects where id = ? and deleted_at is null').get(projectId) as Record<string, unknown> | undefined;
  if (!row || row.is_scratch === 1 || (typeof row.git_remote === 'string' && row.git_remote !== '')) return false;
  const remote = gitRemoteOf(dir);
  if (!remote) return false;
  upsertShared(db, 'projects', { ...row, git_remote: remote }, deviceId);
  return true;
}

/** この PC に場所のある（見つかっている）プロジェクトの remote の空きを埋める。索引の起動のときに呼ぶ。書いた数を返す。 */
export function fillProjectRemotes(db: Db, deviceId: string): number {
  const rows = db.prepare(`select p.id, r.path from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.resolved = 1 and r.deleted_at is null and p.deleted_at is null and p.is_scratch = 0
    and (p.git_remote is null or p.git_remote = '')`).all(deviceId) as { id: string; path: string }[];
  let n = 0;
  for (const r of rows) if (fillProjectRemote(db, deviceId, r.id, r.path)) n++;
  return n;
}
