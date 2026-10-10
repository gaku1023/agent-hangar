import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 歩いて探すときの深さと件数の上限。大きなフォルダで返事を止めないためである。 */
const MAX_DEPTH = 6;
const MAX_FILES = 5000;
/** 歩くときに訪ねるフォルダの数の上限。空のフォルダが山ほどある木でも長く走らないためである。 */
export const MAX_WALK_DIRS = 2000;
/** git が返した一覧のうち覚えておく件数。根ごとのメモリを抑えるためである。 */
const MAX_GIT_FILES = 200_000;
/** 問いが空のときに返す、最近変えたものの件数。 */
const RECENT_COUNT = 20;
/** 問いが空のとき、作業中のものとして見る件数。 */
const MAX_CHANGED = 200;
/** 問いが空のとき、最近のコミットを何件さかのぼるか。 */
const RECENT_COMMITS = 30;
/** 消えたものを落とした後でも一覧が埋まるように、余分に取る候補の数。 */
const EXTRA_CANDIDATES = 20;
/** 一覧を覚えておく長さ。打つたびに git を呼ばないためである。 */
const CACHE_MS = 10_000;
/** git が止まったり壊れたりした根で、git を呼び直さずにおく長さ。 */
const GIT_FAILURE_MS = 60_000;
/** 一覧を覚えておく根の数。最近使ったものから残す。 */
const MAX_ROOTS = 8;
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules']);

type Entry = { at: number; files: string[]; isGit: boolean };

const cache = new Map<string, Entry>();
/** 根ごとの、進行中の一覧づくり。打つたびに来る呼び出しが 1 つの仕事を分け合う。 */
const inflight = new Map<string, Promise<Entry>>();
/** 根ごとの、git が失敗した時刻。 */
const gitFailedAt = new Map<string, number>();

/** 外へ出る呼び出しの差し込み口。本番は git を非同期で呼ぶだけで、試験が差し替えて失敗や回数を確かめる。 */
export const fileSearchDeps = {
  git: runGit as (root: string, args: string[]) => Promise<string>,
};

function runGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // 引数は配列で渡す。根はプロジェクトの登録から来たもので、問いは git に渡さない。
    execFile('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** git の「ここは作業ツリーではない」は終了コード 128。これは失敗ではなく、ただの git でないフォルダである。 */
const isNotGit = (e: unknown) => (e as { code?: unknown } | null)?.code === 128;

const splitNul = (out: string) => out.split('\0').filter(Boolean);

/** 古いものから捨てて、数を抑えて覚える。Map は入れた順を保つので、触るたびに入れ直せば最近使った順になる。 */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as string);
}

function noteGitFailure(root: string) {
  remember(gitFailedAt, root, Date.now(), MAX_ROOTS * 4);
}

function gitRecentlyFailed(root: string): boolean {
  const at = gitFailedAt.get(root);
  return at !== undefined && Date.now() - at < GIT_FAILURE_MS;
}

function walk(root: string): string[] {
  const out: string[] = [];
  let dirs = 0;
  const visit = (dir: string, rel: string, depth: number) => {
    if (out.length >= MAX_FILES || dirs >= MAX_WALK_DIRS) return;
    dirs++;
    let list: fs.Dirent[];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      // リンクはたどらない。プロジェクトの外へ出ないためである。
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth >= MAX_DEPTH || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        visit(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) out.push(r);
    }
  };
  visit(root, '', 0);
  return out;
}

async function load(root: string): Promise<Entry> {
  let isDir = false;
  try { isDir = (await fs.promises.stat(root)).isDirectory(); } catch { /* 無いフォルダ */ }
  if (!isDir) return { at: Date.now(), files: [], isGit: false };
  if (!gitRecentlyFailed(root)) {
    let inside = false;
    try {
      // 根がリポジトリの下のフォルダでもよいので、.git の有無ではなく git に尋ねる。
      inside = (await fileSearchDeps.git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
    } catch (e) {
      if (!isNotGit(e)) noteGitFailure(root);
    }
    if (inside) {
      try {
        // -c：追跡しているもの、-o と --exclude-standard：追跡していないが無視もしていないもの。-z：改行や日本語の名前を逃がさずに受ける。
        const out = await fileSearchDeps.git(root, ['ls-files', '-z', '-c', '-o', '--exclude-standard']);
        return { at: Date.now(), files: splitNul(out).slice(0, MAX_GIT_FILES), isGit: true };
      } catch {
        noteGitFailure(root);
      }
    }
  }
  return { at: Date.now(), files: walk(root), isGit: false };
}

async function entryFor(root: string): Promise<Entry> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    remember(cache, root, hit, MAX_ROOTS);
    return hit;
  }
  let p = inflight.get(root);
  if (!p) {
    p = load(root)
      .then((e) => { remember(cache, root, e, MAX_ROOTS); return e; })
      .finally(() => { inflight.delete(root); });
    inflight.set(root, p);
  }
  return p;
}

const isFileNow = (root: string, rel: string) => {
  try { return fs.statSync(path.join(root, rel)).isFile(); } catch { return false; }
};

/**
 * 問いに合うものを、ファイル名の頭、ファイル名の途中、パスの途中の順に並べる。同じなら短いパスを先にする。
 * 候補は git と歩いた結果のどちらも / で区切る。Windows で打った \ の区切りは / に読み替えてから比べる。
 */
export function rankFiles(files: string[], query: string, limit: number): string[] {
  const q = query.toLowerCase().replaceAll('\\', '/');
  const inPath = q.includes('/');
  const scored: { f: string; r: number }[] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    const r = inPath ? (lower.includes(q) ? 2 : 3) : base.startsWith(q) ? 0 : base.includes(q) ? 1 : lower.includes(q) ? 2 : 3;
    if (r < 3) scored.push({ f, r });
  }
  return scored.sort((a, b) => a.r - b.r || a.f.length - b.f.length || a.f.localeCompare(b.f)).slice(0, limit).map((x) => x.f);
}

/** git のフォルダの最近：作業中（変えた、新しい）を新しい順に、続けて最近のコミットに入ったものを。全件の stat はしない。 */
async function gitRecents(root: string, n: number): Promise<string[]> {
  if (gitRecentlyFailed(root)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  try {
    const changed = [...new Set(splitNul(await fileSearchDeps.git(root, ['ls-files', '-z', '-m', '-o', '--exclude-standard'])))].slice(0, MAX_CHANGED);
    const withTime: { f: string; t: number }[] = [];
    for (const f of changed) {
      // 消えたものや、一覧の後で消えたものは stat が落ちるので飛ばす。
      try { const s = fs.statSync(path.join(root, f)); if (s.isFile()) withTime.push({ f, t: s.mtimeMs }); } catch { /* 飛ばす */ }
    }
    for (const x of withTime.sort((a, b) => b.t - a.t)) { out.push(x.f); seen.add(x.f); }
    let log = '';
    try {
      // --relative：根がリポジトリの下のフォルダでも、その中だけを根からの相対パスで返す。
      log = await fileSearchDeps.git(root, ['log', '-n', String(RECENT_COMMITS), '--name-only', '--relative', '--pretty=format:', '-z']);
    } catch (e) {
      if (!isNotGit(e)) throw e; // コミットがまだ無いだけ（128）なら、作業中のものだけを返す
    }
    for (const f of splitNul(log)) {
      if (out.length >= n) break;
      if (seen.has(f) || !isFileNow(root, f)) continue;
      seen.add(f);
      out.push(f);
    }
  } catch {
    noteGitFailure(root);
    return [];
  }
  return out.slice(0, n);
}

/** git でないフォルダの最近：歩いた結果（上限つき）を stat して新しい順に。 */
function walkRecents(root: string, files: string[], n: number): string[] {
  const withTime: { f: string; t: number }[] = [];
  for (const f of files) {
    try { withTime.push({ f, t: fs.statSync(path.join(root, f)).mtimeMs }); } catch { /* 一覧の後で消えたもの */ }
  }
  return withTime.sort((a, b) => b.t - a.t).slice(0, n).map((x) => x.f);
}

/**
 * 初期プロンプト欄の `@` の候補。プロジェクトの根からの相対パスを返す。
 * 問いが空のときは、最近変えたものを新しい順に返す。
 */
export async function listProjectFiles(root: string, query: string, limit = 50): Promise<string[]> {
  const entry = await entryFor(root);
  const q = query.trim();
  if (q) {
    // 追跡しているが消したものを落とす。落とした分を補えるよう、少し多めに取る。
    return rankFiles(entry.files, q, limit + EXTRA_CANDIDATES).filter((f) => isFileNow(root, f)).slice(0, limit);
  }
  const n = Math.min(limit, RECENT_COUNT);
  return entry.isGit ? gitRecents(root, n) : walkRecents(root, entry.files, n);
}
