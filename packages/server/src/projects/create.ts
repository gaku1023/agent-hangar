import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config/readiness.ts';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { isStrictlyUnder, samePath } from '../platform/paths.ts';
import { insertProject, normalizeDir } from './registry.ts';
import { causeOf, MessageError, msg, type Message } from '../i18n/message.ts';

/** 作れなかった理由。status はそのまま HTTP の状態にする。 */
export class ProjectCreateError extends MessageError {
  constructor(readonly status: 400 | 404 | 409, text: Message | string) {
    super(text);
    this.name = 'ProjectCreateError';
  }
}

export type CreateDeps = { db: Db; deviceId: string; workspaceRoot: string; gitInit?: (dir: string) => void };

const NAME_RULE = msg('project.create.nameRule');

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
  if (exists(dir)) throw new ProjectCreateError(409, msg('project.create.dirExists', { dir }));
  // ルートがファイルを指すなどで作れないのは設定の問題なので、500 にせず理由を添えて断る。
  const cannot = (e: unknown) => new ProjectCreateError(400, msg('project.create.cannotCreate', { dir, reason: causeOf(e) }));
  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  } catch (e) {
    throw cannot(e);
  }
  try {
    // recursive を付けないので、直前に誰かが作っていれば EEXIST で止まり、既にあるものを取り込まない。
    fs.mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectCreateError(409, msg('project.create.dirExists', { dir }));
    throw cannot(e);
  }
  try {
    if (gitInit) run(dir);
  } catch (e) {
    removeFreshDir(dir);
    throw new ProjectCreateError(400, msg('project.create.gitInitFailed', { reason: causeOf(e) }));
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
export function registerProjectDir(deps: { db: Db; deviceId: string; workspaceRoot: string }, o: { path: string; name?: string }): { projectId: string; created: boolean } {
  const name = o.name === undefined ? undefined : o.name.trim();
  if (name === '') throw new ProjectCreateError(400, msg('project.create.nameEmpty'));
  const raw = expandHome(o.path.trim());
  if (!raw) throw new ProjectCreateError(400, msg('project.create.pathNotDir'));
  // 相対パスはサーバの作業ディレクトリから解決されてしまい、利用者の思う場所にならない。
  if (!path.isAbsolute(raw)) throw new ProjectCreateError(400, msg('project.create.pathMustBeAbsolute'));
  // `..` や末尾の `/` が残ると project_roots の前方一致に cwd が当たらず、
  // そのプロジェクトには永久にセッションが紐づかない。必ず正規化してから入れる。
  const dir = normalizeDir(raw);
  // ルートやその上を登録すると、最も長い一致でワークスペースの下のセッションをすべて取り込み、
  // 直下のフォルダの自動の登録も止まる。Finder で何も選ばずに開くを押すとルートが返るので、ここで断る。
  const root = normalizeDir(expandHome(deps.workspaceRoot));
  if (dir === path.parse(dir).root || samePath(root, dir) || isStrictlyUnder(root, dir)) throw new ProjectCreateError(400, msg('project.create.rootNotAllowed'));
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new ProjectCreateError(400, msg('project.create.pathNotDir'));
  // SQL の文字列比較は大文字小文字と NFC・NFD を区別する。Windows では綴り違いも同じフォルダなので、JS で比べる。
  const known = (deps.db.prepare(`select r.project_id id, r.path from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.deleted_at is null and p.deleted_at is null`).all(deps.deviceId) as { id: string; path: string }[]).find((r) => samePath(r.path.normalize('NFC'), dir));
  if (known) {
    const row = deps.db.prepare('select * from projects where id = ?').get(known.id) as Record<string, unknown>;
    if (row.status === 'archived') upsertShared(deps.db, 'projects', { ...row, status: 'active' }, deps.deviceId);
    return { projectId: known.id, created: false };
  }
  return { projectId: insertProject(deps.db, deps.deviceId, name ?? path.basename(dir), dir), created: true };
}
