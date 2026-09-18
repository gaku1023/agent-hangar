import fs from 'node:fs';
import path from 'node:path';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

export const SCRATCH_PROJECT_NAME = 'スクラッチ';

/** スクラッチのディレクトリの置き場。~/.agent-hangar/scratch である。 */
export function scratchRoot(home: string): string {
  return path.join(home, 'scratch');
}

/** この端末のスクラッチの擬似プロジェクト。無ければ作る。ルートは ~/.agent-hangar/scratch そのもの。 */
export function ensureScratchProject(db: Db, deviceId: string, home: string): string {
  const root = scratchRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const cur = db
    .prepare('select r.project_id id from project_roots r join projects p on p.id = r.project_id where r.device_id = ? and r.path = ? and r.deleted_at is null and p.deleted_at is null and p.is_scratch = 1')
    .get(deviceId, root) as { id: string } | undefined;
  if (cur) return cur.id;
  const id = newId();
  upsertShared(db, 'projects', { id, name: SCRATCH_PROJECT_NAME, status: 'active', is_scratch: 1 }, deviceId);
  upsertShared(db, 'project_roots', { id: newId(), project_id: id, device_id: deviceId, path: root, resolved: 1 }, deviceId);
  return id;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** <root>/<yyyymmdd-HHmmss> を作る。同じ秒に重なれば -2、-3 を付ける。 */
export function newScratchDir(home: string, now: Date = new Date()): string {
  const root = scratchRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let n = 1; ; n++) {
    const dir = path.join(root, n === 1 ? base : `${base}-${n}`);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir);
    return dir;
  }
}

/**
 * cwd がスクラッチのルートの下（ルートそのものは含まない）にあるか。
 * 綴りの違いで判定が変わらないよう、どちらも path.resolve で正規化してから比べる。
 * 末尾の区切り、重なった区切り、`.` と `..` はここで消える。
 * symlink までは辿らないので、cwd は保存されたときの綴りのまま比べられる。
 */
export function isUnderScratch(home: string, cwd: string): boolean {
  return path.resolve(cwd).startsWith(path.resolve(scratchRoot(home)) + path.sep);
}
