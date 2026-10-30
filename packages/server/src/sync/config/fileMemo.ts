import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigExecMark, ConfigItemKind } from '@agent-hangar/shared';
import { MAX_ITEM_BYTES } from './bundle.ts';
import type { LocalItem, UnsentCandidate } from './collect.ts';
import { findSecret } from './secrets.ts';

/**
 * 集める対象のファイルの読みの記憶。
 * 定期の同期は 1 分ごとに全部の項目を集めるが、ほとんどのファイルは前回から変わっていない。
 * そこで、パスごとに（mtime、大きさ、inode、ctime）が前回と同じなら、前回求めた指紋、秘密の検出、実行の印を使い、ファイルを読まない。
 *
 * 記憶するのは求めた値だけで、中身は持たない。中身が要るとき（束に詰める、など）に、項目の content を読んだ時点で読み直す。
 * そのとき指紋が記憶と違えば、stat が同じでも中身が変わっていたということなので、記憶を捨てて StaleContentError を投げる。
 * 記憶は、集める 1 周（startRound から endRound まで）で見なかったパスを落とす。
 */

/** 記憶した後で中身が変わっていた。呼び手は集め直してやり直す。 */
export class StaleContentError extends Error {
  constructor(readonly abs: string) { super('file content changed after it was collected'); this.name = 'StaleContentError'; }
}

type Entry = {
  key: string;
  sha256: string;
  size: number;
  secret: string | null;
  marks: Map<string, ConfigExecMark[]>;
  round: number;
  /** 書いた直後に読んだものは、同じ時刻の刻みの書き込みを見分けられないので、次は読み直す。 */
  racy: boolean;
};

const memo = new Map<string, Entry>();
let round = 0;
/** 集める 1 周で見ないまま溜まる場合の、念のための上限。 */
const MAX_ENTRIES = 50000;
const RACY_MTIME_MS = 2000;
const RACY_CTIME_MS = 50;

export function startRound(): void { round++; }
/** この周で見なかったパスを落とす。 */
export function endRound(): void { for (const [k, e] of memo) if (e.round !== round) memo.delete(k); }
/** 試験用。 */
export function clearFileMemo(): void { memo.clear(); }
export const fileMemoSize = (): number => memo.size;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export type RegularFile = {
  abs: string;
  sha256: string;
  size: number;
  mtime: number;
  /** 秘密らしい形の名前。無い、またはバイナリなら null。 */
  secret: string | null;
  /** 集めた時点の中身との一致を確かめて返す。違えば記憶を捨てて StaleContentError を投げる。 */
  content(): Buffer;
  /** 設定ファイルを解くときの読み。確かめずに今の中身を返す（集めた時点で読んでいればそれを返す）。 */
  read(): Buffer;
  /** 実行の印。key（印を決めるときの相対パス）ごとに記憶する。compute は中身が要るときだけ get を呼ぶ。 */
  marks(key: string, compute: (get: () => Buffer) => ConfigExecMark[]): ConfigExecMark[];
};

/** 読めたら中身の指紋など。無い（ENOENT）は 'absent'、あるのに運べない（リンク、普通のファイルでない、大きすぎる、読めない）は 'blocked'。 */
export function readRegular(abs: string): RegularFile | 'absent' | 'blocked' {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'blocked'; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_ITEM_BYTES) return 'blocked';
  const key = `${st.mtimeMs}:${st.size}:${st.ino}:${st.ctimeMs}`;
  let e = memo.get(abs);
  let fresh: Buffer | null = null;
  if (!e || e.key !== key || e.racy) {
    try { fresh = fs.readFileSync(abs); } catch { memo.delete(abs); return 'blocked'; }
    const binary = fresh.includes(0);
    const now = Date.now();
    e = { key, sha256: sha256(fresh), size: fresh.length, secret: binary ? null : findSecret(fresh.toString('utf8')), marks: new Map(), round, racy: now - st.mtimeMs < RACY_MTIME_MS || now - st.ctimeMs < RACY_CTIME_MS };
    if (memo.size >= MAX_ENTRIES) memo.clear();
    memo.set(abs, e);
  }
  e.round = round;
  const entry = e;
  const readNow = (): Buffer => fs.readFileSync(abs);
  return {
    abs, sha256: entry.sha256, size: entry.size, mtime: Math.floor(st.mtimeMs), secret: entry.secret,
    content: () => {
      if (fresh) return fresh;
      const b = readNow();
      if (sha256(b) !== entry.sha256) { if (memo.get(abs) === entry) memo.delete(abs); throw new StaleContentError(abs); }
      return b;
    },
    read: () => fresh ?? readNow(),
    marks: (k, compute) => {
      const hit = entry.marks.get(k);
      if (hit) return hit;
      const m = compute(() => fresh ?? readNow());
      entry.marks.set(k, m);
      return m;
    },
  };
}

/**
 * 集めた項目を作る。中身（content）は、読むときに読み直す形にして、集めた項目の一覧に全部の中身を載せない。
 * 秘密らしい文字列があれば unsent に候補を足し、「それでも送る」が効いていなければ withheld にする。
 */
export function fileItem(f: RegularFile, o: { id: string; kind: ConfigItemKind; label: string; target: string; marks: ConfigExecMark[]; allowedUnsent: ReadonlyMap<string, string>; unsent: UnsentCandidate[] }): LocalItem {
  let withheld: 'secret' | null = null;
  if (f.secret) {
    const uid = `secret:${o.id}`;
    const allowed = o.allowedUnsent.get(uid) === f.sha256;
    o.unsent.push({ id: uid, kind: 'secret', itemId: o.id, label: o.label, reason: `secret:${f.secret}`, contentSha256: f.sha256, allowed });
    if (!allowed) withheld = 'secret';
  }
  const item = { id: o.id, kind: o.kind, label: o.label, sha256: f.sha256, size: f.size, marks: o.marks, mtime: f.mtime, target: o.target, withheld } as LocalItem;
  Object.defineProperty(item, 'content', { get: () => f.content(), enumerable: true, configurable: true });
  return item;
}

/**
 * dir の下のファイルの絶対パスを、リンクを辿らず、除外の名前を降りずに集める。
 * リンクは辿らずに onLink へ渡す（ファイルかディレクトリかは辿らないと分からないので、どちらの id も塞げるように呼び手へ任せる）。
 * 読めないディレクトリも onLink へ渡す（中に何があるか分からない）。
 */
export function walk(dir: string, onLink: (abs: string) => void, exclude: ReadonlySet<string>, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onLink(dir); return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) { onLink(abs); continue; }
    if (e.isDirectory()) { if (!exclude.has(e.name)) walk(abs, onLink, exclude, out); } else out.push(abs);
  }
  return out;
}
