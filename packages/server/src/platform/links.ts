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
  readFileSync: (p: string) => Buffer;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (p: string) => void;
  copyFileSync: (from: string, to: string) => void;
  writeFileSync: (p: string, data: Buffer) => void;
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
  readFileSync: (p) => fs.readFileSync(p),
  renameSync: (a, b) => fs.renameSync(a, b),
  unlinkSync: (p) => fs.unlinkSync(p),
  copyFileSync: (a, b) => fs.copyFileSync(a, b),
  writeFileSync: (p, d) => fs.writeFileSync(p, d),
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

/** p がファイル（リンクならその先がファイル）か。 */
function isFileFollowing(f: LinkFs, p: string): boolean {
  try { return f.statSync(p).isFile(); } catch { return false; }
}

/** 両側がファイルで、バイト単位で同じか。 */
function sameFile(f: LinkFs, a: string, b: string): boolean {
  if (!isFileFollowing(f, a) || !isFileFollowing(f, b)) return false;
  try { return f.readFileSync(a).equals(f.readFileSync(b)); } catch { return false; }
}

/** 一時名。同じ置き場の中に置くので、rename が同じ区画で済む。 */
const tempNameOf = (link: string): string => `${link}.hangar-relink-${process.pid}`;

/**
 * link を一時名へ避けてからリンクを張る。張れなければ戻して投げる。成功したら一時名を消す（消せなくても投げない）。
 * 中身を捨てるのは、呼び手が同じ中身か退避を確かめたあとだけである。
 */
function replaceWithLink(f: LinkFs, platform: NodeJS.Platform, target: string, link: string, keepAs?: string): void {
  const tmp = keepAs ?? tempNameOf(link);
  f.renameSync(link, tmp);
  try { makeLink(f, platform, target, link); } catch (e) {
    try { f.renameSync(tmp, link); } catch { /* 戻せないときは一時名に残る */ }
    throw e;
  }
  if (keepAs === undefined) { try { f.unlinkSync(tmp); } catch { /* 残っても害は無い */ } }
}

/**
 * names の各項目について、dir/<name> が primaryDir/<name> を指すかを見る。make なら欠けているリンクを張る。
 * 最初の置き場に無い項目は飛ばす。リンクの場所に別のもの（実ファイル、実ディレクトリ、別の先を指すリンク）があれば、触らずに conflicts へ挙げる。
 * ただし、リンクの場所がファイル（別の先を指すリンクならその先）で、最初の置き場のファイルとバイト単位で同じなら、失うものが無いので、
 * make のときは張り直して created に入れ、make でないときは conflicts に入れない。ディレクトリは中身を統合できないので conflicts のまま。
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
    if (sameFile(f, link, target)) {
      if (!make) continue;
      try { replaceWithLink(f, platform, target, link); created.push(name); } catch { unlinked.push(name); }
      continue;
    }
    conflicts.push(name);
  }
  return { created, conflicts, unlinked };
}

/** conflicts のうち、両側がファイルで中身が違う（選んで直せる）名前。ディレクトリや壊れたリンクは入れない。 */
export function fixableConflicts(primaryDir: string, dir: string, conflicts: readonly string[], opts: LinkOptions = {}): string[] {
  const f = opts.fs ?? realFs;
  return conflicts.filter((n) => isFileFollowing(f, path.join(dir, n)) && isFileFollowing(f, path.join(primaryDir, n)));
}

/** 片側の様子。text は 256KB を超えるか NUL を含むと null（画面に文字として見せない）。 */
export type LinkSideDetail = { text: string | null; mtimeMs: number; size: number };
export type LinkConflictDetail = { name: string; kind: 'file' | 'dir'; mine: LinkSideDetail; shared: LinkSideDetail };

export const LINK_TEXT_LIMIT = 256 * 1024;

/** 修復を断った理由。経路が 400 にする。 */
export class LinkRepairError extends Error {
  constructor(readonly reason: 'name' | 'dir' | 'missing', message: string) { super(message); this.name = 'LinkRepairError'; }
}

/** name が 1 つの項目名か（パスの区切りや `..` を含まない）。 */
function checkName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name !== path.basename(name) || name.includes('/') || name.includes('\\')) {
    throw new LinkRepairError('name', `bad entry name: ${name}`);
  }
}

function sideOf(f: LinkFs, p: string, isFile: boolean): LinkSideDetail {
  let st: fs.Stats;
  try { st = f.statSync(p); } catch { st = f.lstatSync(p); }
  let text: string | null = null;
  if (isFile && st.size <= LINK_TEXT_LIMIT) {
    try {
      const buf = f.readFileSync(p);
      if (buf.length <= LINK_TEXT_LIMIT && !buf.includes(0)) text = buf.toString('utf8');
    } catch { text = null; }
  }
  return { text, mtimeMs: st.mtimeMs, size: st.size };
}

/** 衝突した 1 項目の両側の中身。選ぶ前に画面が差分を見せるのに使う。 */
export function linkConflictDetail(primaryDir: string, dir: string, name: string, opts: LinkOptions = {}): LinkConflictDetail {
  checkName(name);
  const f = opts.fs ?? realFs;
  const mine = path.join(dir, name);
  const shared = path.join(primaryDir, name);
  const bothFiles = isFileFollowing(f, mine) && isFileFollowing(f, shared);
  return { name, kind: bothFiles ? 'file' : 'dir', mine: sideOf(f, mine, bothFiles), shared: sideOf(f, shared, bothFiles) };
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** `YYYYMMDD-HHMMSS`（ローカル時刻）。 */
const stampOf = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** 退避先の名前。既にあれば -2、-3 と付けて重ねない。 */
function backupPathOf(f: LinkFs, base: string, now: Date): string {
  const first = `${base}.bak-hangar-${stampOf(now)}`;
  const taken = (p: string): boolean => { try { f.lstatSync(p); return true; } catch { return false; } };
  if (!taken(first)) return first;
  for (let i = 2; ; i++) if (!taken(`${first}-${i}`)) return `${first}-${i}`;
}

/**
 * 中身が違うファイルの衝突を、どちらかを残して直す。選ばなかった側は .bak-hangar-日時 に退避するので、何も失わない。
 * shared を残す：手元の dir/<name> を退避してリンクを張る。
 * mine を残す：最初の置き場のファイルを退避（写し）し、手元の中身を最初の置き場に書く（書き先がさらにリンクなら、たどって書く）。そのあとリンクを張る。
 * リンクが張れなければ手元のファイルを戻して投げる。ディレクトリは断る。既に共有へのリンクなら何もしない（backup は null）。
 */
export function resolveLinkConflict(primaryDir: string, dir: string, name: string, keep: 'mine' | 'shared', now: Date, opts: LinkOptions = {}): { name: string; keep: 'mine' | 'shared'; backup: string | null } {
  checkName(name);
  const f = opts.fs ?? realFs;
  const platform = opts.platform ?? process.platform;
  const mine = path.join(dir, name);
  const shared = path.join(primaryDir, name);
  let st: fs.Stats | null = null;
  try { st = f.lstatSync(mine); } catch { st = null; }
  if (st !== null && st.isSymbolicLink() && pointsTo(f, platform, dir, mine, shared)) return { name, keep, backup: null };
  if (!isFileFollowing(f, shared)) throw new LinkRepairError('missing', `no shared file: ${name}`);
  if (st === null) { makeLink(f, platform, shared, mine); return { name, keep, backup: null }; }
  if (!isFileFollowing(f, mine)) throw new LinkRepairError('dir', `not a file: ${name}`);
  if (keep === 'shared') {
    const backup = backupPathOf(f, mine, now);
    replaceWithLink(f, platform, shared, mine, backup);
    return { name, keep, backup };
  }
  const content = f.readFileSync(mine);
  const backup = backupPathOf(f, shared, now);
  f.copyFileSync(shared, backup);
  f.writeFileSync(shared, content);
  replaceWithLink(f, platform, shared, mine);
  return { name, keep, backup };
}
