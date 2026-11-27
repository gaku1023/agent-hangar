import path from 'node:path';
import { defaultLanguage, type GetLanguage } from '../i18n/language.ts';
import { msg, render } from '../i18n/message.ts';
import { checkDirName, parentDirOf } from '../projects/create.ts';
import { ToolError } from './tools.ts';

/**
 * プロジェクトを作る MCP の道具（create_project と promote_session、issue #870）。
 * quick session で試していた作業を、会話の中から途中でプロジェクトにするための口である。
 *
 * どちらもフォルダを作るかファイルを動かすので、confirmed: true のときだけ実行する（update_settings と同じ型、2026-11-27 に利用者と決めた）。
 * confirmed が無ければ何も書かずに、作る場所を返す。エージェントはそれを利用者に見せて聞き、選ばれたら呼び直す。
 * hangar はその申告を確かめられないので、守るのはうっかりの作成までである。何も消さず、移したファイルは巻き戻せる（projects/promote.ts）。
 *
 * 実行は画面と同じ POST /api/projects と POST /api/sessions/:id/promote の処理に投げ（http/app.ts の projectAccessOf）、
 * 名前と場所の検査、未分類の会話の紐づけ、画面への配りはそちらに任せる。
 */
export type RouteOutcome = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; error: string };

export type ProjectToolDeps = {
  /** 設定の作成場所。空なら path を省いた作成と昇格は断る。 */
  workspaceRoot: () => string;
  /** そのセッションがクイックセッションなら、その作業フォルダ。そうでなければ null。 */
  quickDir: (sessionId: string) => string | null;
  /** 画面と同じ POST /api/projects の処理。 */
  createProject: (body: Record<string, unknown>) => Promise<RouteOutcome>;
  /** 画面と同じ POST /api/sessions/:id/promote の処理。 */
  promoteSession: (sessionId: string, body: Record<string, unknown>) => Promise<RouteOutcome>;
  language?: GetLanguage;
};

const optBool = (args: Record<string, unknown>, field: string): boolean | undefined => {
  const v = args[field];
  if (v !== undefined && typeof v !== 'boolean') throw new ToolError(msg('common.field.mustBeBoolean', { field }));
  return v;
};
const optStr = (args: Record<string, unknown>, field: string): string | undefined => {
  const v = args[field];
  if (v !== undefined && typeof v !== 'string') throw new ToolError(msg('common.field.required', { field }));
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const note = (deps: ProjectToolDeps) => render((deps.language ?? defaultLanguage)(), msg('mcp.project.needsConfirmation'));

/**
 * 既存のフォルダを登録するか、path を省けば作成場所の下に name のフォルダを作る。
 * 登録済みのフォルダなら新しく作らず、そのプロジェクトを返す（画面と同じ）。
 */
export async function createProjectTool(deps: ProjectToolDeps, args: Record<string, unknown>) {
  const confirmed = optBool(args, 'confirmed');
  const gitInit = optBool(args, 'git_init') ?? true;
  const given = optStr(args, 'path');
  const rawName = optStr(args, 'name');
  if (given === undefined && rawName === undefined) throw new ToolError(msg('common.field.required', { field: 'name' }));
  // 相対パスはサーバの作業ディレクトリから解かれてしまうので、聞く前に断る。~ は画面と同じく登録の側で直す。
  if (given !== undefined && !given.startsWith('~') && !path.isAbsolute(given)) throw new ToolError(msg('project.create.pathMustBeAbsolute'));
  const name = rawName === undefined ? undefined : given === undefined ? checkDirName(rawName) : rawName;
  const where = given ?? path.join(parentDirOf(deps.workspaceRoot()), name!);
  if (confirmed !== true) {
    return {
      status: 'needs_confirmation',
      proposed: { action: given === undefined ? 'create' : 'register', name: name ?? path.basename(where), path: where, ...(given === undefined ? { git_init: gitInit } : {}) },
      note: note(deps),
    };
  }
  const body = given === undefined ? { kind: 'newDir', name, gitInit } : { kind: 'dir', path: given, ...(name !== undefined ? { name } : {}) };
  const r = await deps.createProject(body);
  if (!r.ok) throw new ToolError(r.error);
  return { status: r.status === 201 ? 'created' : 'already_registered', project_id: r.body.id, name: r.body.name, path: r.body.path ?? where };
}

/**
 * クイックセッションをプロジェクトに昇格する。作る場所は作成場所の下の name で、画面の昇格と同じ。
 * 会話がまだ動いていれば、ファイルは移さない（昇格の処理が断る）。そのときは残った場所を返し、エージェントが利用者に伝えられるようにする。
 */
export async function promoteSessionTool(deps: ProjectToolDeps, sessionId: string, args: Record<string, unknown>) {
  const confirmed = optBool(args, 'confirmed');
  const gitInit = optBool(args, 'git_init') ?? true;
  const moveFiles = optBool(args, 'move_files') ?? true;
  const rawName = optStr(args, 'name');
  if (rawName === undefined) throw new ToolError(msg('common.field.required', { field: 'name' }));
  const name = checkDirName(rawName);
  const quick = deps.quickDir(sessionId);
  if (quick === null) throw new ToolError(msg('project.promote.notScratch'));
  if (confirmed !== true) {
    return {
      status: 'needs_confirmation',
      proposed: { session_id: sessionId, name, path: path.join(parentDirOf(deps.workspaceRoot()), name), git_init: gitInit, move_files: moveFiles },
      note: note(deps),
    };
  }
  const r = await deps.promoteSession(sessionId, { name, gitInit, moveFiles });
  if (!r.ok) throw new ToolError(r.status === 409 ? msg('mcp.project.promoteExists', { error: r.error }) : r.error);
  const project = (r.body.project ?? {}) as Record<string, unknown>;
  const moved = r.body.moved === true;
  return {
    status: 'promoted', project_id: project.id, name: project.name, path: project.path, moved,
    ...(typeof r.body.reason === 'string' ? { reason: r.body.reason } : {}),
    ...(moveFiles && !moved ? { files_left_in: quick } : {}),
  };
}
