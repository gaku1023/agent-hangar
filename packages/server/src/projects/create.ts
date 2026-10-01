import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { insertProject, normalizeDir } from './registry.ts';

/** 作れなかった理由。status はそのまま HTTP の状態にする。 */
export class ProjectCreateError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'ProjectCreateError';
  }
}

export type CreateDeps = { db: Db; deviceId: string; workspaceRoot: string; gitInit?: (dir: string) => void };

export const NAME_RULE = '名前はディレクトリ名として使える 1 字以上で、/ を含められません';

const defaultGitInit = (dir: string) => {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
};

/** シンボリックリンクも「ある」と数える。リンク先が壊れていても上書きしないためである。 */
export function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** ディレクトリ名として使える名前か。前後の空白を除いた名前を返す。 */
export function checkDirName(raw: string): string {
  const name = raw.trim();
  const bad = !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.basename(name) !== name;
  if (bad) throw new ProjectCreateError(400, NAME_RULE);
  return name;
}

/**
 * 作ったばかりのディレクトリを片付ける。
 * 空のときと、git init が作った .git だけが入っているときに限って消す。
 * 見覚えのないものが入っていれば消さずに残す。
 * hangar は利用者のファイルを消さないので、片付けはここまでである。
 */
function removeFreshDir(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  if (entries.length === 0) {
    fs.rmdirSync(dir);
    return;
  }
  if (entries.length === 1 && entries[0] === '.git') {
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    fs.rmdirSync(dir);
  }
}

/** `<root>/<name>` を作り、選ばれていれば git init する。失敗したら作ったものを片付けて断る。 */
export function makeProjectDir(workspaceRoot: string, name: string, gitInit: boolean, run: (dir: string) => void = defaultGitInit): string {
  const dir = normalizeDir(path.join(workspaceRoot, name));
  if (exists(dir)) throw new ProjectCreateError(409, `${dir} は既にあります`);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  try {
    // recursive を付けないので、直前に誰かが作っていれば EEXIST で止まり、既にあるものを取り込まない。
    fs.mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectCreateError(409, `${dir} は既にあります`);
    throw e;
  }
  try {
    if (gitInit) run(dir);
  } catch (e) {
    removeFreshDir(dir);
    throw new ProjectCreateError(400, `git init に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
  return dir;
}

/** ワークスペースの下に新しいフォルダを作り、プロジェクトにする。 */
export function createProjectDir(deps: CreateDeps, o: { name: string; gitInit: boolean }): { projectId: string; dir: string } {
  const name = checkDirName(o.name);
  const dir = makeProjectDir(deps.workspaceRoot, name, o.gitInit, deps.gitInit);
  const projectId = deps.db.transaction(() => insertProject(deps.db, deps.deviceId, name, dir))();
  return { projectId, dir };
}

/**
 * 既存のディレクトリをプロジェクトにする。
 * 同じパスが登録済みなら既存を返し、アーカイブなら Active に戻す（登録し直すのは、使うという意思の表れなので）。
 */
export function registerProjectDir(deps: { db: Db; deviceId: string }, o: { path: string; name?: string }): { projectId: string; created: boolean } {
  const name = o.name === undefined ? undefined : o.name.trim();
  if (name === '') throw new ProjectCreateError(400, 'name を空にはできません');
  const raw = o.path.trim();
  // `..` や末尾の `/` が残ると project_roots の前方一致に cwd が当たらず、
  // そのプロジェクトには永久にセッションが紐づかない。必ず正規化してから入れる。
  const dir = raw ? normalizeDir(raw) : '';
  if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new ProjectCreateError(400, 'path が存在するディレクトリではありません');
  const known = deps.db.prepare(`select r.project_id id from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.path = ? and r.deleted_at is null and p.deleted_at is null`).get(deps.deviceId, dir) as { id: string } | undefined;
  if (known) {
    const row = deps.db.prepare('select * from projects where id = ?').get(known.id) as Record<string, unknown>;
    if (row.status === 'archived') upsertShared(deps.db, 'projects', { ...row, status: 'active' }, deps.deviceId);
    return { projectId: known.id, created: false };
  }
  return { projectId: insertProject(deps.db, deps.deviceId, name ?? path.basename(dir), dir), created: true };
}
