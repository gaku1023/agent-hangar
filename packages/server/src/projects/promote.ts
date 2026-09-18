import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { isUnderScratch } from './scratch.ts';

export class PromoteError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'PromoteError';
  }
}

export type PromoteDeps = {
  db: Db;
  deviceId: string;
  home: string;
  workspaceRoot: string;
  runAlive: (sessionId: string) => boolean;
  gitInit?: (dir: string) => void;
};

export type PromoteResult = { projectId: string; moved: boolean; reason: string | null };

const defaultGitInit = (dir: string) => {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
};

/** シンボリックリンクも「ある」と数える。リンク先が壊れていても上書きしないためである。 */
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
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
 * スクラッチのディレクトリの中身を移し、空になった元を消す。
 * 先に移動先の衝突を全部調べ、1 つでもぶつかれば何も移動しない。
 * 中身の移動は同じボリュームなので rename で足りる。
 */
function moveContents(from: string, to: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(from);
  } catch {
    return `${from} が見つかりませんでした`;
  }
  const clash = names.find((name) => exists(path.join(to, name)));
  if (clash) return `移動先に ${clash} が既にあるため、ファイルは移動しませんでした。手で移してください`;
  for (const name of names) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    try {
      fs.renameSync(src, dst);
    } catch (e) {
      // 別ボリュームなど rename が使えないときはコピーしてから消す。
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
  }
  // 空になったときだけ消える。何か残っていれば ENOTEMPTY で落ちるので、取りこぼしに気付ける。
  fs.rmdirSync(from);
  return null;
}

/**
 * スクラッチのセッションをプロジェクトに昇格する。
 * 設計文書の手順 1 から 4 をこの順で行い、run が生きていればファイルは移動しない。
 */
export function promoteSession(
  deps: PromoteDeps,
  o: { sessionId: string; name: string; gitInit: boolean; moveFiles: boolean },
): PromoteResult {
  const s = deps.db.prepare('select id, cwd from sessions where id = ? and deleted_at is null').get(o.sessionId) as { id: string; cwd: string } | undefined;
  if (!s) throw new PromoteError(404, 'セッションが見つかりません');
  const name = o.name.trim();
  const bad = !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.basename(name) !== name;
  if (bad) throw new PromoteError(400, '名前はディレクトリ名として使える 1 字以上で、/ を含められません');
  if (!isUnderScratch(deps.home, s.cwd)) throw new PromoteError(400, 'このセッションはスクラッチではありません');
  const dir = path.join(deps.workspaceRoot, name);
  if (exists(dir)) throw new PromoteError(409, `${dir} は既にあります`);

  // 1. ディレクトリを作り、必要なら git init。失敗したら作ったものを片付けて終える。
  fs.mkdirSync(deps.workspaceRoot, { recursive: true });
  try {
    // recursive を付けないので、直前に誰かが作っていれば EEXIST で止まり、既にあるものを取り込まない。
    fs.mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new PromoteError(409, `${dir} は既にあります`);
    throw e;
  }
  try {
    if (o.gitInit) (deps.gitInit ?? defaultGitInit)(dir);
  } catch (e) {
    removeFreshDir(dir);
    throw new PromoteError(400, `git init に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. プロジェクトとこの端末のルート。3. セッションの紐づけ。
  const projectId = newId();
  const write = deps.db.transaction(() => {
    upsertShared(deps.db, 'projects', { id: projectId, name, status: 'active', is_scratch: 0 }, deps.deviceId);
    upsertShared(deps.db, 'project_roots', { id: newId(), project_id: projectId, device_id: deps.deviceId, path: dir, resolved: 1 }, deps.deviceId);
    const row = deps.db.prepare('select * from sessions where id = ?').get(s.id) as Record<string, unknown>;
    upsertShared(deps.db, 'sessions', { ...row, project_id: projectId }, deps.deviceId);
  });
  write();

  // 4. run がすべて終わっていればファイルを移す。生きていれば移さず、その旨を返す。
  if (!o.moveFiles) return { projectId, moved: false, reason: null };
  if (deps.runAlive(s.id)) return { projectId, moved: false, reason: 'run が実行中のためファイルは移動しませんでした。終了後に手で移してください' };
  const reason = moveContents(s.cwd, dir);
  return { projectId, moved: reason === null, reason };
}
