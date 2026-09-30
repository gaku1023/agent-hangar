/**
 * Edit と MultiEdit の差分を、統合表示（GitHub と同じ上下に並べる形）の行に直す。
 * 差分は置き換える前と後の文字列から行ごとに取る。ファイル全体は読まない。
 */

export type DiffOp = { t: 'ctx' | 'add' | 'del'; text: string };
export type DiffLine = { t: 'ctx' | 'add' | 'del'; old: number | null; new: number | null; text: string } | { t: 'gap'; count: number };
export type DiffHunk = { header: string | null; lines: DiffLine[] };

/** 変わった所の前後に残す、変わらない行の数。 */
const CONTEXT = 2;
/** LCS の表の升の上限。これを超えたら、共通の頭と尻を除いた中身を全部消して全部足したことにする。 */
const LCS_CELLS = 4_000_000;

const splitLines = (s: string): string[] => (s === '' ? [] : s.split('\n'));

/** 行ごとの差分。共通の頭と尻を先に外し、残りを LCS で並べる。 */
export function diffOps(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  const mid: DiffOp[] = [];
  if (ma.length * mb.length > LCS_CELLS) {
    for (const t of ma) mid.push({ t: 'del', text: t });
    for (const t of mb) mid.push({ t: 'add', text: t });
  } else {
    // dp[i][j] は ma[i..] と mb[j..] の最長共通部分列の長さ。
    const n = ma.length;
    const m = mb.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = ma[i] === mb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) { mid.push({ t: 'ctx', text: ma[i]! }); i++; j++; }
      // 消した行を足した行より先に並べる。
      else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) mid.push({ t: 'del', text: ma[i++]! });
      else mid.push({ t: 'add', text: mb[j++]! });
    }
  }
  return [...a.slice(0, head).map((text) => ({ t: 'ctx' as const, text })), ...mid, ...b.slice(b.length - tail).map((text) => ({ t: 'ctx' as const, text }))];
}

/**
 * 1 か所の差分。start はその置き換えが始まる行の番号（分からなければ null）。
 * 置き換えは同じ行から始まるので、前と後の番号は同じ start から数える。
 * 変わらない行は、変わった所の前後 2 行だけを残し、2 行以上続く残りは畳んだ数（gap）にする。
 */
export function diffHunk(before: string, after: string, opts: { start: number | null }): { hunk: DiffHunk; added: number; removed: number } {
  const ops = diffOps(before, after);
  const lines: DiffLine[] = [];
  let o = opts.start;
  let nw = opts.start;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === 'add') { lines.push({ t: 'add', old: null, new: nw, text: op.text }); added++; if (nw !== null) nw++; }
    else if (op.t === 'del') { lines.push({ t: 'del', old: o, new: null, text: op.text }); removed++; if (o !== null) o++; }
    else { lines.push({ t: 'ctx', old: o, new: nw, text: op.text }); if (o !== null) o++; if (nw !== null) nw++; }
  }
  const oldCount = splitLines(before).length;
  const newCount = splitLines(after).length;
  const header = opts.start === null ? null : `@@ -${opts.start},${oldCount} +${opts.start},${newCount} @@`;
  return { hunk: { header, lines: foldContext(lines) }, added, removed };
}

/** 変わらない行の続きを、変わった所の前後 CONTEXT 行だけ残して畳む。隠れるのが 1 行だけなら畳まない。 */
function foldContext(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.t !== 'ctx') { out.push(lines[i++]!); continue; }
    let j = i;
    while (j < lines.length && lines[j]!.t === 'ctx') j++;
    const run = lines.slice(i, j);
    const keepHead = i > 0 ? CONTEXT : 0;
    const keepTail = j < lines.length ? CONTEXT : 0;
    const hidden = run.length - keepHead - keepTail;
    if (hidden >= 2) out.push(...run.slice(0, keepHead), { t: 'gap', count: hidden }, ...run.slice(run.length - keepTail));
    else out.push(...run);
    i = j;
  }
  return out;
}

/**
 * 編集の結果に付く cat -n の抜粋（「    40→本文」）から、after の最初の行が何行目かを読む。
 * 抜粋が無い、または見つからなければ null。
 */
export function snippetStart(result: string, after: string): number | null {
  const numbered = new Map<string, number>();
  for (const line of result.split('\n')) {
    const m = /^\s*(\d+)(?:→|\t)(.*)$/.exec(line);
    if (m && !numbered.has(m[2]!)) numbered.set(m[2]!, Number(m[1]));
  }
  if (numbered.size === 0) return null;
  const lines = after.split('\n');
  const k = lines.findIndex((l) => l.trim() !== '');
  if (k < 0) return null;
  const at = numbered.get(lines[k]!);
  return at === undefined ? null : at - k;
}
