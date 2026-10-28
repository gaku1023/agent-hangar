import fs from 'node:fs';
import path from 'node:path';

/**
 * アカウントの置き場から最初の置き場へ張るリンク（Claude と Codex の accountLinks が使う）。
 *
 * Windows では、開発者モードが切で管理者でないプロセスはシンボリックリンクを作れない（EPERM）。
 * ジャンクションは管理者なしで張れるので、ディレクトリはジャンクションにする。
 * ファイルにはジャンクションが使えないので、シンボリックリンク（'file'）を試す。
 * 1 つの項目で張れなくても投げず、残りを張り続けて、張れなかった項目を unlinked に挙げる。
 */

/** 使う fs の口。試験が差し替える。 */
export type LinkFs = {
  existsSync: (p: string) => boolean;
  lstatSync: (p: string) => fs.Stats;
  statSync: (p: string) => fs.Stats;
  readlinkSync: (p: string) => string;
  symlinkSync: (target: string, link: string, type?: fs.symlink.Type | null) => void;
};

export type LinkOptions = { platform?: NodeJS.Platform; fs?: LinkFs };

/** 張った項目、別のものが置かれている項目、張れなかった項目。 */
export type LinkResult = { created: string[]; conflicts: string[]; unlinked: string[] };

const realFs: LinkFs = {
  existsSync: fs.existsSync,
  lstatSync: (p) => fs.lstatSync(p),
  statSync: (p) => fs.statSync(p),
  readlinkSync: (p) => fs.readlinkSync(p),
  symlinkSync: (target, link, type) => fs.symlinkSync(target, link, type),
};

/** Windows のジャンクションの readlink は `\\?\C:\...`（や `\??\C:\...`）の形で返ることがあるので、頭を外す。 */
export function normalizeLinkTarget(raw: string): string {
  if (raw.startsWith('\\\\?\\') || raw.startsWith('\\??\\')) return raw.slice(4);
  return raw;
}

/** link が target を指すリンク（Windows ではジャンクションも含む）か。 */
function pointsTo(f: LinkFs, platform: NodeJS.Platform, dir: string, link: string, target: string): boolean {
  const got = path.resolve(dir, normalizeLinkTarget(f.readlinkSync(link)));
  const want = path.resolve(target);
  return platform === 'win32' ? got.toLowerCase() === want.toLowerCase() : got === want;
}

/** win32 では、元がディレクトリならジャンクション、ファイルなら 'file'。ほかは型を渡さない。 */
function makeLink(f: LinkFs, platform: NodeJS.Platform, target: string, link: string): void {
  if (platform !== 'win32') { f.symlinkSync(target, link); return; }
  f.symlinkSync(target, link, f.statSync(target).isDirectory() ? 'junction' : 'file');
}

/**
 * names の各項目について、dir/<name> が primaryDir/<name> を指すかを見る。make なら欠けているリンクを張る。
 * 最初の置き場に無い項目は飛ばす。リンクの場所に別のもの（実ファイル、実ディレクトリ、別の先を指すリンク）があれば、触らずに conflicts へ挙げる。
 */
export function linkEntries(primaryDir: string, dir: string, names: readonly string[], make: boolean, opts: LinkOptions = {}): LinkResult {
  const f = opts.fs ?? realFs;
  const platform = opts.platform ?? process.platform;
  const created: string[] = [];
  const conflicts: string[] = [];
  const unlinked: string[] = [];
  for (const name of names) {
    const target = path.join(primaryDir, name);
    if (!f.existsSync(target)) continue;
    const link = path.join(dir, name);
    let st: fs.Stats | null = null;
    try { st = f.lstatSync(link); } catch { st = null; }
    if (st === null) {
      if (!make) continue;
      try { makeLink(f, platform, target, link); created.push(name); } catch { unlinked.push(name); }
      continue;
    }
    if (st.isSymbolicLink() && pointsTo(f, platform, dir, link, target)) continue;
    conflicts.push(name);
  }
  return { created, conflicts, unlinked };
}
