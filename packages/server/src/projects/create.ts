import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from '../config/readiness.ts';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { isStrictlyUnder, samePath } from '../platform/paths.ts';
import { hasWorkspaceRoot, insertProject, linkProjectHere, normalizeDir } from './registry.ts';
import { enclosingProject, type EnclosingProject } from './link.ts';
import { causeOf, MessageError, msg, type Message } from '../i18n/message.ts';

/** 作れなかった理由。status はそのまま HTTP の状態にする。 */
export class ProjectCreateError extends MessageError {
  constructor(readonly status: 400 | 404 | 409, text: Message | string) {
    super(text);
    this.name = 'ProjectCreateError';
  }
}

/**
 * 登録しようとしたフォルダが、この PC で登録済みのプロジェクトの下にあるときの断り（409）。
 * enclosing は包むプロジェクト（いちばん深いもの）で、画面はそれを添えて「別のプロジェクトにする」を選ばせる。
 */
export class ProjectNestedError extends ProjectCreateError {
  constructor(readonly enclosing: EnclosingProject) {
    super(409, msg('project.create.nested', { name: enclosing.name }));
    this.name = 'ProjectNestedError';
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

/**
 * 新しいフォルダを作る場所を決める。
 * 呼び手が parent を渡せばそれを使い、無ければ設定の作成場所（workspaceRoot）を使う。
 * 作成場所は任意なので、どちらも無ければ 400 で断る（画面は Finder で場所を選ばせる）。
 * 先頭の ~ はホームに直し、相対パスはサーバの作業ディレクトリから解決されてしまうので断る。
 */
export function parentDirOf(workspaceRoot: string, parent?: string | null): string {
  const raw = typeof parent === 'string' && parent.trim() !== '' ? parent.trim() : hasWorkspaceRoot(workspaceRoot) ? workspaceRoot.trim() : null;
  if (raw === null) throw new ProjectCreateError(400, msg('project.create.noParent'));
  const full = expandHome(raw);
  if (!path.isAbsolute(full)) throw new ProjectCreateError(400, msg('project.create.pathMustBeAbsolute'));
  return full;
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

/** 作成場所（または呼び手が選んだ parent）の下に新しいフォルダを作り、プロジェクトにする。 */
export function createProjectDir(deps: CreateDeps, o: { name: string; gitInit: boolean; parent?: string | null }): { projectId: string; dir: string } {
  const name = checkDirName(o.name);
  const dir = makeProjectDir(parentDirOf(deps.workspaceRoot, o.parent), name, o.gitInit, deps.gitInit);
  const projectId = deps.db.transaction(() => insertProject(deps.db, deps.deviceId, name, dir))();
  return { projectId, dir };
}

/**
 * 既存のディレクトリをプロジェクトにする。
 * 同じパスが登録済みなら既存を返し、アーカイブなら Active に戻す（登録し直すのは、使うという意思の表れなので）。
 *
 * 0.6.1 から、次の 2 つを足した。
 * - 登録済みのプロジェクトの下のフォルダは、allowNested を明示したときだけ別のプロジェクトにする。
 *   明示が無ければ ProjectNestedError（409）で包むプロジェクトを返す。古い画面からの登録で、黙ってプロジェクトが分かれないためである。
 *   分けても、いまある会話は包む方に残る（assignSessions は未分類の会話しか動かさない）。分かれるのはこれからの会話である。
 * - linkTo を渡すと、新しく作らずに、そのプロジェクト（ほかの PC から届いた、この PC に場所の無いもの）のこの PC の場所にする。
 *   書き込みは「場所を再指定」と同じである（registry.ts の linkProjectHere）。名前は変えない。
 */
export function registerProjectDir(
  deps: { db: Db; deviceId: string; workspaceRoot: string },
  o: { path: string; name?: string; allowNested?: boolean; linkTo?: string },
): { projectId: string; created: boolean; linked?: true } {
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
  // ファイルシステムの根とホームフォルダも、ほぼすべての会話を取り込むので断る（作成場所が空でも断れるように、作成場所とは別に見る）。
  const home = normalizeDir(os.homedir());
  const root = hasWorkspaceRoot(deps.workspaceRoot) ? normalizeDir(expandHome(deps.workspaceRoot)) : null;
  if (dir === path.parse(dir).root || samePath(home, dir) || (root !== null && (samePath(root, dir) || isStrictlyUnder(root, dir)))) throw new ProjectCreateError(400, msg('project.create.rootNotAllowed'));
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new ProjectCreateError(400, msg('project.create.pathNotDir'));
  // SQL の文字列比較は大文字小文字と NFC・NFD を区別する。Windows では綴り違いも同じフォルダなので、JS で比べる。
  const known = (deps.db.prepare(`select r.project_id id, p.name, r.path from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.deleted_at is null and p.deleted_at is null`).all(deps.deviceId) as { id: string; name: string; path: string }[]).find((r) => samePath(r.path.normalize('NFC'), dir));
  if (known) {
    // 結び付け先と違うプロジェクトの場所なら、同じフォルダを指すプロジェクトが 2 つになるので断る（まとめるのは「場所を再指定」の確認から）。
    if (o.linkTo !== undefined && known.id !== o.linkTo) throw new ProjectCreateError(409, msg('project.resolve.sameFolder', { name: known.name }));
    const row = deps.db.prepare('select * from projects where id = ?').get(known.id) as Record<string, unknown>;
    if (row.status === 'archived') upsertShared(deps.db, 'projects', { ...row, status: 'active' }, deps.deviceId);
    return { projectId: known.id, created: false };
  }
  const enclosing = enclosingProject(deps.db, deps.deviceId, dir);
  if (enclosing && o.allowNested !== true) throw new ProjectNestedError(enclosing);
  if (o.linkTo !== undefined) {
    const target = deps.db.prepare('select id, name from projects where id = ? and deleted_at is null and is_scratch = 0').get(o.linkTo) as { id: string; name: string } | undefined;
    if (!target) throw new ProjectCreateError(404, msg('project.error.notFound'));
    // この PC に場所のあるプロジェクトを結び付けると、その場所を黙って動かしてしまう。動かすのは「場所を再指定」から行う。
    const placed = deps.db.prepare('select 1 from project_roots where project_id = ? and device_id = ? and resolved = 1 and deleted_at is null').get(target.id, deps.deviceId);
    if (placed) throw new ProjectCreateError(409, msg('project.link.hasPlace', { name: target.name }));
    linkProjectHere(deps.db, deps.deviceId, target.id, dir);
    return { projectId: target.id, created: false, linked: true };
  }
  return { projectId: insertProject(deps.db, deps.deviceId, name ?? path.basename(dir), dir), created: true };
}
