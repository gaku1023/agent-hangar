import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GIT_DIRTY_CAP, type GitDiffDto, type GitFileStatus, type GitTreeDto } from '@agent-hangar/shared';

// git を読むだけの部品（0.5.0 の git の表示）。hangar は git に書かない。
// どの呼び出しも --no-optional-locks を付け、index.lock を取らない。Claude や利用者の git と取り合わないためである。

/**
 * git を 1 回起こす口。stdout は文字列で返す。
 * timedOut は時間切れで止めたこと、capped は maxEntries（NUL で区切った項目の数）を超えたので止めたこと。
 * stderr は git が断った訳を読むためのもので、先頭の STDERR_MAX_BYTES までである（偽の口は持たなくてよい）。
 */
export type GitExec = (args: string[], o: { cwd: string; timeoutMs: number; maxEntries?: number; maxBytes?: number }) => Promise<{ code: number; stdout: string; stderr?: string; timedOut: boolean; capped: boolean }>;

/** stderr を覚える上限。断った訳の数行が読めればよい。 */
const STDERR_MAX_BYTES = 8 * 1024;

/** 一覧から何本も呼ぶので短く切る（入力欄の候補の git は 5 秒）。 */
export const GIT_STATUS_TIMEOUT_MS = 3000;
/** 差分の本文の上限。 */
export const GIT_DIFF_MAX_BYTES = 256 * 1024;

/** 実物の git を起こす。出力を数えながら読み、上限を超えたら止める。 */
export function spawnGit(gitFile: string): GitExec {
  return (args, o) => new Promise((resolve) => {
    const child = spawn(gitFile, ['--no-optional-locks', ...args], { cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let errBytes = 0;
    let bytes = 0;
    let nul = 0;
    let done = false;
    let timedOut = false;
    let capped = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errChunks).toString('utf8'), timedOut, capped });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); finish(1); }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (capped) return;
      chunks.push(d);
      bytes += d.length;
      if (o.maxEntries !== undefined) for (const b of d) if (b === 0) nul++;
      if ((o.maxEntries !== undefined && nul > o.maxEntries) || (o.maxBytes !== undefined && bytes > o.maxBytes)) {
        // 止めた子が終わってから返す（close で finish）。Windows では、終わる前の子がフォルダを掴んだままになる。
        capped = true;
        child.kill();
      }
    });
    // stderr は読み続ける（読まないと、たくさん書く git がパイプで詰まる）。覚えるのは先頭だけ。
    child.stderr.on('data', (d: Buffer) => {
      if (errBytes >= STDERR_MAX_BYTES) return;
      errChunks.push(d.subarray(0, STDERR_MAX_BYTES - errBytes));
      errBytes += d.length;
    });
    child.on('error', () => finish(127));
    child.on('close', (code) => finish(capped ? 0 : code ?? 1));
  });
}

export type StatusEntry = { status: GitFileStatus; rel: string };
export type ParsedStatus = { branch: string | null; head: string | null; ahead: number | null; behind: number | null; entries: StatusEntry[] };

/** XY の 2 文字から行の種類を決める。足したもの、消したもの、それ以外は変更。 */
function kindOf(xy: string): GitFileStatus {
  if (xy.includes('A')) return 'A';
  if (xy.includes('D')) return 'D';
  return 'M';
}

/** `git status --porcelain=v2 --branch -z` の出力を読む。途中で切れた最後の項目は捨てる。 */
export function parsePorcelainV2(out: string, cap: number = Number.POSITIVE_INFINITY): ParsedStatus {
  const r: ParsedStatus = { branch: null, head: null, ahead: null, behind: null, entries: [] };
  const fields = out.split('\0');
  // 最後の項目は NUL で終わっていなければ途中で切れている。
  if (!out.endsWith('\0')) fields.pop();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f === '') continue;
    if (f.startsWith('# ')) {
      const [, key, ...rest] = f.split(' ');
      const v = rest.join(' ');
      if (key === 'branch.oid') r.head = v === '(initial)' ? null : v.slice(0, 7);
      else if (key === 'branch.head') r.branch = v === '(detached)' ? null : v;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(v);
        if (m) { r.ahead = Number(m[1]); r.behind = Number(m[2]); }
      }
      continue;
    }
    if (r.entries.length >= cap) continue;
    const kind = f[0];
    if (kind === '1') r.entries.push({ status: kindOf(f.slice(2, 4)), rel: f.split(' ').slice(8).join(' ') });
    else if (kind === '2') { r.entries.push({ status: 'R', rel: f.split(' ').slice(9).join(' ') }); i++; }
    else if (kind === 'u') r.entries.push({ status: 'M', rel: f.split(' ').slice(10).join(' ') });
    else if (kind === '?') r.entries.push({ status: 'U', rel: f.slice(2) });
  }
  return r;
}

/** git の出力のパス（/ 区切り、Windows は C:/...）を、この OS のパスにする。 */
const nativePath = (cwd: string, p: string) => path.resolve(cwd, p);

/**
 * git が持ち主の違い（dubious ownership）で断ったときの、許す場所。git の訳の文から読み、持ち主の話でなければ null。
 * git が勧める `safe.directory <場所>` の行を先に読み、無ければ「repository at '<場所>'」を読む。
 * 訳の文は英語で読む（spawnGit は LC_ALL=C で起こす）。
 */
export function unsafeDirOf(stderr: string): string | null {
  if (!/dubious ownership/i.test(stderr)) return null;
  const add = /safe\.directory[ \t]+(.+?)[ \t]*\r?$/m.exec(stderr);
  // git は空白や引用符を含む場所を sh の形で囲む（' は '\''）。囲みを外して元の場所に戻す。
  if (add) return /^'.*'$/.test(add[1]!) ? add[1]!.slice(1, -1).replace(/'\\''/g, "'") : add[1]!;
  const at = /dubious ownership in repository at '([^'\r\n]+)'/i.exec(stderr);
  return at ? at[1]! : null;
}

/** 作業ツリーの場所。worktree は git worktree で足した作業ツリーのときの名前、mainRoot はその元の作業ツリーの根である。 */
export type TreeLocation = { root: string; worktree: string | null; mainRoot: string | null };

/**
 * 作業ツリーの根を見つける。git のリポジトリでなければ null。
 * 持ち主の違いで git が断ったら、git でないとはせず、断った場所を unsafe で返す（画面で訳と許し方を言うため）。
 * worktree は git worktree で足した作業ツリーのときの名前（根のフォルダ名）、mainRoot はその元の作業ツリーの根である。
 * 見分けは --git-dir と --git-common-dir の違いで、元の作業ツリーでは同じになる。
 */
export async function locateTree(cwd: string, exec: GitExec, timeoutMs: number = GIT_STATUS_TIMEOUT_MS): Promise<TreeLocation | { unsafe: string } | null> {
  if (!fs.existsSync(cwd)) return null;
  const r = await exec(['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], { cwd, timeoutMs });
  if (r.code !== 0) {
    const unsafe = r.timedOut ? null : unsafeDirOf(r.stderr ?? '');
    return unsafe ? { unsafe } : null;
  }
  const [top, gitDir, commonDir] = r.stdout.split(/\r?\n/);
  if (!top || !gitDir || !commonDir) return null;
  const root = nativePath(cwd, top);
  const dir = nativePath(cwd, gitDir);
  const common = nativePath(cwd, commonDir);
  if (dir === common) return { root, worktree: null, mainRoot: null };
  // 元の作業ツリーの .git の親が元の根である（裸のリポジトリから足した worktree では親が無いので null）。
  const mainRoot = path.basename(common) === '.git' ? path.dirname(common) : null;
  return { root, worktree: path.basename(root), mainRoot };
}

/**
 * 作業ツリーの状態を読む。時間内に答えなければ slow にして件数を持たない。
 * cap を超えたら数えるのをやめ、dirty を cap にして capped を立てる。untracked が偽なら未追跡を数えない（大きなリポジトリで時間切れになったあと）。
 */
export async function readTreeStatus(root: string, exec: GitExec, o: { now: number; cap?: number; timeoutMs?: number; untracked?: boolean; worktree?: string | null; mainRoot?: string | null }): Promise<{ tree: GitTreeDto; entries: StatusEntry[] }> {
  const cap = o.cap ?? GIT_DIRTY_CAP;
  const args = ['status', '--porcelain=v2', '--branch', '-z', ...(o.untracked === false ? ['--untracked-files=no'] : [])];
  // 見出しの行（4 つまで）と名前の変更の 2 つめの項目のぶん、少し余して止める。
  const r = await exec(args, { cwd: root, timeoutMs: o.timeoutMs ?? GIT_STATUS_TIMEOUT_MS, maxEntries: cap + 8 });
  const base = { root, worktree: o.worktree ?? null, mainRoot: o.mainRoot ?? null, at: o.now };
  if (r.timedOut || (r.code !== 0 && !r.capped)) return { tree: { ...base, branch: null, head: null, dirty: null, capped: false, slow: true, ahead: null, behind: null }, entries: [] };
  const p = parsePorcelainV2(r.stdout);
  const capped = r.capped || p.entries.length > cap;
  return { tree: { ...base, branch: p.branch, head: p.head, dirty: capped ? cap : p.entries.length, capped, slow: false, ahead: p.ahead, behind: p.behind }, entries: p.entries.slice(0, cap) };
}

/** 空の木。最初のコミットの前は HEAD が無いので、これと比べる。 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function baseRef(root: string, exec: GitExec): Promise<string> {
  const r = await exec(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, timeoutMs: GIT_STATUS_TIMEOUT_MS });
  return r.code === 0 ? 'HEAD' : EMPTY_TREE;
}

/** 先頭の 8 KB に NUL があればバイナリとみなす（git と同じ見分け方）。 */
function isBinaryFile(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(8000);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).includes(0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** ファイルの行の数（終わりの改行の無い最後の行も 1 行に数える）。 */
function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export type LineCounts = { added: number | null; deleted: number | null; binary: boolean };

/**
 * 行の増減。追跡しているものは `git diff <HEAD> --numstat -z` で、未追跡は中身の行を数える。
 * バイナリは数えない。entries の rel で引く表を返す。
 */
export async function numstatOf(root: string, exec: GitExec, entries: StatusEntry[]): Promise<Map<string, LineCounts>> {
  const out = new Map<string, LineCounts>();
  const tracked = entries.filter((e) => e.status !== 'U' && e.status !== 'C');
  if (tracked.length > 0) {
    const ref = await baseRef(root, exec);
    const r = await exec(['diff', ref, '--numstat', '-z', '--no-renames', '--no-ext-diff', '--', ...tracked.map((e) => e.rel)], { cwd: root, timeoutMs: GIT_STATUS_TIMEOUT_MS });
    if (r.code === 0) {
      for (const f of r.stdout.split('\0')) {
        const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(f);
        if (!m) continue;
        const binary = m[1] === '-';
        out.set(m[3]!, { added: binary ? null : Number(m[1]), deleted: binary ? null : Number(m[2]), binary });
      }
    }
  }
  for (const e of entries) {
    if (e.status !== 'U') continue;
    const file = path.join(root, e.rel);
    if (isBinaryFile(file)) { out.set(e.rel, { added: null, deleted: null, binary: true }); continue; }
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > GIT_DIFF_MAX_BYTES * 4) { out.set(e.rel, { added: null, deleted: 0, binary: false }); continue; }
      out.set(e.rel, { added: lineCount(fs.readFileSync(file, 'utf8')), deleted: 0, binary: false });
    } catch {
      out.set(e.rel, { added: null, deleted: null, binary: false });
    }
  }
  return out;
}

/** バイト数で切る。UTF-8 の途中で切らないよう、行の終わりまで戻す。 */
function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const cut = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  const nl = cut.lastIndexOf('\n');
  return { text: nl >= 0 ? cut.slice(0, nl + 1) : '', truncated: true };
}

/**
 * 1 つのファイルの作業ツリーとの差。追跡しているものは `git diff <HEAD> -U3` の統合形式で、見出し（diff --git など）は落として @@ から始める。
 * 未追跡のファイルは全部足した形にする。コミット済み（C）は差が無いので空。
 */
export async function diffFile(root: string, rel: string, status: GitFileStatus, exec: GitExec, maxBytes: number = GIT_DIFF_MAX_BYTES): Promise<GitDiffDto> {
  const file = path.join(root, rel);
  const base = { file, rel, status };
  if (status === 'C') return { ...base, text: '', truncated: false, binary: false };
  if (status === 'U') {
    if (isBinaryFile(file)) return { ...base, text: '', truncated: false, binary: true };
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch { /* 消えていれば空のまま */ }
    const n = lineCount(body);
    const lines = body === '' ? [] : body.replace(/\n$/, '').split('\n');
    const t = truncate(`@@ -0,0 +1,${n} @@\n${lines.map((l) => `+${l}\n`).join('')}`, maxBytes);
    return { ...base, ...t, binary: false };
  }
  const ref = await baseRef(root, exec);
  const r = await exec(['diff', ref, '--no-color', '--no-ext-diff', '--no-renames', '-U3', '--', rel], { cwd: root, timeoutMs: GIT_STATUS_TIMEOUT_MS, maxBytes: maxBytes * 2 });
  if (/^Binary files /m.test(r.stdout)) return { ...base, text: '', truncated: false, binary: true };
  const at = r.stdout.indexOf('\n@@');
  const body = r.stdout.startsWith('@@') ? r.stdout : at >= 0 ? r.stdout.slice(at + 1) : '';
  const t = truncate(body, maxBytes);
  return { ...base, text: t.text, truncated: t.truncated || r.capped, binary: false };
}
