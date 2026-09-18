import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { isUnderScratch, scratchRoot } from './scratch.ts';

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

type Move = { moved: boolean; reason: string | null };

/** 移した 1 件。copied は rename が使えずコピーで移したもので、巻き戻しても移動先に残る。 */
type Done = { name: string; copied: boolean };

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 移動元の実体を求める。
 * cwd がスクラッチの下にあっても、シンボリックリンクなら指す先は外かもしれない。
 * 実体がスクラッチの下に無ければ、外のファイルを動かさないために断る。
 */
function resolveScratchDir(home: string, from: string): { real: string } | { reason: string } {
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(scratchRoot(home));
  } catch (e) {
    return { reason: `スクラッチの置き場を確かめられなかったため、ファイルは移動しませんでした（${why(e)}）` };
  }
  try {
    real = fs.realpathSync(from);
  } catch {
    return { reason: `${from} が見つかりませんでした` };
  }
  if (!real.startsWith(realRoot + path.sep)) {
    return { reason: `${from} はスクラッチの外（${real}）を指しているため、ファイルは移動しませんでした` };
  }
  return { real };
}

/**
 * 移したものを元に戻す。
 * 戻せなかったものは名前を返し、呼ぶ側が利用者に何がどこにあるかを伝える。
 * 巻き戻しでもファイルは消さない。コピーで移したものは移動先にも残す。
 */
function rollback(from: string, to: string, done: Done[]): string[] {
  const left: string[] = [];
  for (const m of [...done].reverse()) {
    const src = path.join(from, m.name);
    const dst = path.join(to, m.name);
    try {
      // 元に同じ名前が現れていれば、上書きになるので触らない。
      if (exists(src)) {
        left.push(m.name);
        continue;
      }
      if (m.copied) {
        fs.cpSync(dst, src, { recursive: true });
        left.push(m.name);
      } else {
        fs.renameSync(dst, src);
      }
    } catch {
      left.push(m.name);
    }
  }
  return left;
}

/**
 * スクラッチのディレクトリの中身を移し、空になった元を消す。
 * 先に移動先の衝突を全部調べ、1 つでもぶつかれば何も移動しない。
 * 中身の移動は同じボリュームなので rename で足りる。
 * 途中で失敗したら移したものを戻し、生の例外は外へ出さずに理由の文にして返す。
 */
function moveContents(from: string, to: string): Move {
  let names: string[];
  try {
    // 名前順に移す。失敗したときにどこまで進んだかを追えるようにするためである。
    names = fs.readdirSync(from).sort();
  } catch (e) {
    return { moved: false, reason: `${from} の中身を読めませんでした（${why(e)}）` };
  }
  const clash = names.find((name) => exists(path.join(to, name)));
  if (clash) return { moved: false, reason: `移動先に ${clash} が既にあるため、ファイルは移動しませんでした。手で移してください` };

  const done: Done[] = [];
  for (const name of names) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    try {
      fs.renameSync(src, dst);
      done.push({ name, copied: false });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
        // 別ボリュームなど rename が使えないときはコピーしてから消す。
        try {
          fs.cpSync(src, dst, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
          done.push({ name, copied: true });
          continue;
        } catch (e2) {
          return { moved: false, reason: undoneReason(from, to, done, name, why(e2)) };
        }
      }
      return { moved: false, reason: undoneReason(from, to, done, name, why(e)) };
    }
  }
  try {
    // 空になったときだけ消える。何か残っていれば ENOTEMPTY で落ちるので、取りこぼしに気付ける。
    fs.rmdirSync(from);
  } catch (e) {
    return { moved: true, reason: `ファイルは ${to} へ移しましたが、${from} を消せませんでした（${why(e)}）` };
  }
  return { moved: true, reason: null };
}

/** 移動の途中で止まったときの理由の文。巻き戻しを試みてから、何がどこにあるかを述べる。 */
function undoneReason(from: string, to: string, done: Done[], name: string, cause: string): string {
  const left = rollback(from, to, done);
  const head = `${name} を移せませんでした（${cause}）`;
  if (done.length === 0) return `${head}。ファイルは ${from} にそのまま残っています`;
  if (left.length === 0) return `${head}。先に移したものは ${from} に戻しました。ファイルは移動していません`;
  return `${head}。${left.join('、')} は ${to} にも残っています。${from} と ${to} の両方を確かめてください`;
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
  const src = resolveScratchDir(deps.home, s.cwd);
  if ('reason' in src) return { projectId, moved: false, reason: src.reason };
  return { projectId, ...moveContents(src.real, dir) };
}
