import { ConfigEditError, deepEqual, detectEol, isPlainObject } from './errors.ts';
import { getIn } from './jsonc.ts';
import { BARE, isDatetimeValue, parseToml, type Section, type Stmt, type Tree, type TomlDoc, type ValueStyle, type VNode } from './tomlParse.ts';

/**
 * Codex の config.toml の書き戻し。コメント、空行、鍵の並び、引用の形を保って、鍵の道 1 つだけを差し替える・足す・消す。
 * 依存は足さず自前で書いた（理由は PR の説明）。
 * 壊れた入力と TOML にできない値は ConfigEditError を投げる。何も書かない（文字列を返すだけの関数）。
 * 書いた結果は読み直して、狙った中身と合うか確かめる。合わなければ 'verify' で失敗する。
 */

export type TomlPath = readonly string[];

const isTable = (v: unknown): v is Tree => isPlainObject(v) && !isDatetimeValue(v);
const startsWith = (path: readonly string[], prefix: readonly string[]): boolean => prefix.length <= path.length && prefix.every((p, i) => path[i] === p);
const samePath = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && startsWith(a, b);

// ---- 値の書式

function fmtKey(k: string): string {
  return BARE.test(k) ? k : fmtBasic(k);
}

function fmtBasic(s: string): string {
  return `"${escapeBasic(s, false)}"`;
}

function escapeBasic(s: string, keepNewline: boolean): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += keepNewline ? '\n' : '\\n';
    else if (ch === '\t') out += keepNewline ? '\t' : '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}

function fmtStringLike(s: string, style: ValueStyle | undefined, lead = false): string {
  const nl = lead || s.startsWith('\n') ? '\n' : '';
  const plain = !/[\u0000-\u001f\u007f]/.test(s);
  if (style === 'literal' && plain && !s.includes("'")) return `'${s}'`;
  if (style === 'mlliteral' && !s.includes("'''") && !s.endsWith("'") && !/[\u0000-\u0008\u000b-\u001f\u007f\r]/.test(s)) return `'''${nl}${s}'''`;
  if (style === 'mlbasic') return `"""${nl}${escapeBasic(s, true)}"""`;
  return fmtBasic(s);
}

function fmtInline(v: unknown): string {
  if (typeof v === 'string') return fmtBasic(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : v === Infinity ? 'inf' : v === -Infinity ? '-inf' : String(v);
  if (isDatetimeValue(v)) return (v as { $datetime: string }).$datetime;
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[${v.map(fmtInline).join(', ')}]`;
  if (isTable(v)) {
    const es = Object.entries(v);
    return es.length === 0 ? '{}' : `{ ${es.map(([k, x]) => `${fmtKey(k)} = ${fmtInline(x)}`).join(', ')} }`;
  }
  throw new ConfigEditError('invalid-value', 'TOML にできない値です');
}

function assertTomlValue(v: unknown, at = ''): void {
  if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'bigint') return;
  if (Array.isArray(v)) return v.forEach((x, i) => assertTomlValue(x, `${at}[${i}]`));
  if (isPlainObject(v)) return Object.entries(v).forEach(([k, x]) => assertTomlValue(x, `${at}.${k}`));
  throw new ConfigEditError('invalid-value', `TOML にできない値です${at}（null と undefined は TOML に無い）`);
}

/** 表を [見出し] の節として書く。子の表は子の節にする。 */
function renderSection(path: readonly string[], obj: Tree): string[] {
  const entries = Object.entries(obj);
  const scalars = entries.filter(([, v]) => !isTable(v));
  const tables = entries.filter(([, v]) => isTable(v));
  const lines: string[] = [];
  if (scalars.length > 0 || tables.length === 0) {
    lines.push(`[${path.map(fmtKey).join('.')}]`);
    for (const [k, v] of scalars) lines.push(`${fmtKey(k)} = ${fmtInline(v)}`);
  }
  for (const [k, v] of tables) {
    if (lines.length > 0) lines.push('');
    lines.push(...renderSection([...path, k], v as Tree));
  }
  return lines;
}

// ---- 既存の値を、形を保って差し替える

function spaces(s: string): string {
  return /^[ \t]*/.exec(s)?.[0] ?? '';
}

function stitch(src: string, node: VNode, patches: { start: number; end: number; text: string }[]): string {
  let out = src.slice(node.start, node.end);
  for (const p of [...patches].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, p.start - node.start) + p.text + out.slice(p.end - node.start);
  }
  return out;
}

function freshLike(v: unknown, sample: VNode | undefined): string {
  if (typeof v === 'string' && sample?.type === 'string') return fmtStringLike(v, sample.style);
  return fmtInline(v);
}

function patchValue(src: string, node: VNode, v: unknown): string {
  const raw = src.slice(node.start, node.end);
  if (deepEqual(node.value, v)) return raw;
  if (typeof v === 'string' && node.type === 'string') return fmtStringLike(v, node.style, /^('''|""")\r?\n/.test(raw));
  if (Array.isArray(v) && node.type === 'array') return patchArray(src, node, v);
  if (isTable(v) && node.type === 'inline') return patchInline(src, node, v);
  return fmtInline(v);
}

function cleanGap(gap: string, eol: string): string {
  if (!gap.includes('#')) return gap;
  return `,${eol}${spaces(gap.slice(gap.lastIndexOf('\n') + 1))}`;
}

function patchArray(src: string, node: VNode, arr: unknown[]): string {
  const items = node.items as VNode[];
  if (arr.length === 0) return '[]';
  if (items.length === 0) return fmtInline(arr);
  if (arr.length === items.length) {
    return stitch(
      src,
      node,
      items.flatMap((it, k) => (deepEqual(it.value, arr[k]) ? [] : [{ start: it.start, end: it.end, text: patchValue(src, it, arr[k]) }])),
    );
  }
  const eol = detectEol(src);
  const pool = items.map((it) => ({ it, used: false }));
  const texts = arr.map((x, k) => {
    const hit = pool.find((p) => !p.used && deepEqual(p.it.value, x));
    if (hit) {
      hit.used = true;
      return src.slice(hit.it.start, hit.it.end);
    }
    return freshLike(x, items[Math.min(k, items.length - 1)]);
  });
  const multi = src.slice(node.start, node.end).includes('\n');
  const gaps = items.slice(1).map((it, k) => src.slice((items[k] as VNode).end, it.start));
  let tail = multi ? '' : ', ';
  if (gaps.length > 0) tail = cleanGap(gaps[gaps.length - 1] as string, eol);
  else if (multi) {
    const lineStart = src.lastIndexOf('\n', (items[0] as VNode).start) + 1;
    const ind = spaces(src.slice(lineStart, (items[0] as VNode).start));
    tail = ind === src.slice(lineStart, (items[0] as VNode).start) ? `,${eol}${ind}` : ', ';
  }
  let body = texts[0] as string;
  for (let k = 1; k < texts.length; k++) body += (k - 1 < gaps.length ? (gaps[k - 1] as string) : tail) + texts[k];
  const first = items[0] as VNode;
  const last = items[items.length - 1] as VNode;
  return src.slice(node.start, first.start) + body + src.slice(last.end, node.end);
}

function patchInline(src: string, node: VNode, obj: Tree): string {
  const entries = node.entries as NonNullable<VNode['entries']>;
  const raw = src.slice(node.start, node.end);
  if (entries.some((e) => e.dotted) || raw.includes('\n')) return fmtInline(obj);
  const oldKeys = entries.map((e) => e.key);
  const newKeys = Object.keys(obj);
  const entryText = (e: (typeof entries)[number], v: unknown): string => {
    const valueText = patchValue(src, e.node, v);
    return src.slice(e.start, e.node.start) + valueText;
  };
  if (newKeys.length === oldKeys.length && newKeys.every((k) => oldKeys.includes(k))) {
    return stitch(
      src,
      node,
      entries.flatMap((e) => (deepEqual(e.node.value, obj[e.key]) ? [] : [{ start: e.node.start, end: e.node.end, text: patchValue(src, e.node, obj[e.key]) }])),
    );
  }
  if (newKeys.length === 0) return '{}';
  const open = raw.startsWith('{ ') ? '{ ' : '{';
  const close = open === '{ ' ? ' }' : '}';
  const parts = [
    ...entries.filter((e) => Object.hasOwn(obj, e.key)).map((e) => entryText(e, obj[e.key])),
    ...newKeys.filter((k) => !oldKeys.includes(k)).map((k) => `${fmtKey(k)} = ${fmtInline(obj[k])}`),
  ];
  return open + parts.join(', ') + close;
}

// ---- 行の操作

class Editor {
  src: string;
  readonly eol: string;
  constructor(
    src: string,
    private readonly doc: TomlDoc,
  ) {
    this.src = src;
    this.eol = detectEol(src);
  }
  private lineText(l: number): string {
    const s = this.doc.lineStarts[l] as number;
    const e = this.doc.lineStarts[l + 1] ?? this.doc.src.length;
    return this.doc.src.slice(s, e).replace(/\r?\n$/, '');
  }
  isBlank(l: number): boolean {
    return l >= 0 && l < this.doc.lineStarts.length && this.lineText(l).trim() === '';
  }
  /** 見出しの直前に続くコメント行も含めた先頭行 */
  attachedStart(line: number): number {
    let l = line;
    while (l - 1 >= 0 && !this.doc.covered[l - 1] && this.lineText(l - 1).trim().startsWith('#')) l--;
    return l;
  }
  offsetOfLine(l: number): number {
    return this.doc.lineStarts[l] ?? this.doc.src.length;
  }
}

interface Range {
  start: number;
  end: number;
  text: string;
}

function applyRanges(src: string, ranges: Range[]): string {
  let out = src;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  return out;
}

function insertLinesAfter(ed: Editor, doc: TomlDoc, line: number, lines: string[]): Range {
  const off = doc.lineStarts[line + 1] ?? doc.src.length;
  const needNl = off === doc.src.length && doc.src.length > 0 && !doc.src.endsWith('\n');
  return { start: off, end: off, text: (needNl ? ed.eol : '') + lines.map((l) => l + ed.eol).join('') };
}

function sectionEnd(s: Section): number {
  return Math.max(s.header?.lastLine ?? -1, ...s.kvs.map((k) => k.lastLine));
}

// ---- 公開の関数

/** 鍵の道の今の値を読む。無ければ undefined。表の配列は配列で返す。 */
export function getToml(src: string, path: TomlPath): unknown {
  return getIn(parseToml(src).tree, path);
}

function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (isTable(v)) {
    const o: Tree = Object.create(null) as Tree;
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (!(isTable(p) && Object.keys(p).length === 0)) o[k] = p;
    }
    return o;
  }
  return v;
}

function cloneTree<T>(v: T): T {
  if (Array.isArray(v)) return v.map(cloneTree) as T;
  if (isPlainObject(v)) {
    const o: Tree = Object.create(null) as Tree;
    for (const [k, x] of Object.entries(v)) o[k] = cloneTree(x);
    return o as T;
  }
  return v;
}

function setInTree(root: Tree, path: readonly string[], value: unknown): void {
  let cur = root;
  path.forEach((seg, i) => {
    if (i === path.length - 1) cur[seg] = cloneTree(value);
    else {
      const next = cur[seg];
      if (next === undefined) cur = cur[seg] = Object.create(null) as Tree;
      else if (isTable(next)) cur = next;
      else throw new ConfigEditError('conflict', `${path.slice(0, i + 1).join('.')} は値で、その下には足せません`);
    }
  });
}

function guardAot(doc: TomlDoc, path: readonly string[], allowEqual: boolean): void {
  for (const s of doc.sections) {
    if (s.aot && startsWith(path, s.path) && !(allowEqual && s.path.length === path.length)) {
      throw new ConfigEditError('unsupported', `${s.path.join('.')} は表の配列で、その中は書き換えられません`);
    }
  }
}

function checkPrefixes(doc: TomlDoc, path: readonly string[]): void {
  for (let i = 1; i < path.length; i++) {
    const v = getIn(doc.tree, path.slice(0, i));
    if (v !== undefined && !isTable(v)) throw new ConfigEditError('conflict', `${path.slice(0, i).join('.')} は値で、その下には足せません`);
  }
}

function verify(out: string, expected: Tree): string {
  let after: TomlDoc;
  try {
    after = parseToml(out);
  } catch {
    throw new ConfigEditError('verify', '書いた結果が TOML として読めません');
  }
  if (!deepEqual(prune(after.tree), prune(expected))) throw new ConfigEditError('verify', '書いた結果が狙った中身と違います');
  return out;
}

/** 鍵の道 1 つの値を差し替える・足す。値が表（オブジェクト）なら表ごとの差し替えで、無い鍵は消え、変わらない鍵の体裁は残る。 */
export function setToml(src: string, path: TomlPath, value: unknown): string {
  if (path.length === 0) throw new ConfigEditError('unsupported', '根は差し替えられません');
  assertTomlValue(value);
  const doc = parseToml(src);
  guardAot(doc, path, false);
  checkPrefixes(doc, path);
  const expected = cloneTree(doc.tree);
  setInTree(expected, path, value);
  const out = setImpl(src, path, value);
  return out === src ? src : verify(out, expected);
}

/** 鍵の道 1 つを消す。表なら子の表ごと、頭のコメントごと。無ければ何も変えない。 */
export function removeToml(src: string, path: TomlPath): string {
  if (path.length === 0) throw new ConfigEditError('unsupported', '根は消せません');
  const doc = parseToml(src);
  guardAot(doc, path, true);
  if (getIn(doc.tree, path) === undefined) return src;
  const expected = cloneTree(doc.tree);
  const parent = getIn(expected, path.slice(0, -1));
  if (isTable(parent)) delete parent[path[path.length - 1] as string];
  const out = removeImpl(src, path);
  return out === src ? src : verify(out, expected);
}

function setImpl(src: string, path: readonly string[], value: unknown): string {
  const doc = parseToml(src);
  const existing = getIn(doc.tree, path);
  if (isTable(value) && isTable(existing)) {
    let out = src;
    for (const k of Object.keys(existing)) if (!Object.hasOwn(value, k)) out = removeImpl(out, [...path, k]);
    for (const [k, v] of Object.entries(value)) out = setImpl(out, [...path, k], v);
    return out;
  }
  if (isTable(existing)) return setImpl(removeImpl(src, path), path, value);
  return upsert(src, doc, path, value);
}

function upsert(src: string, doc: TomlDoc, path: readonly string[], value: unknown): string {
  const exact = doc.stmts.find((s) => s.kind === 'kv' && samePath(s.path, path));
  if (exact?.node) {
    if (deepEqual(exact.node.value, value)) return src;
    return applyRanges(src, [{ start: exact.node.start, end: exact.node.end, text: patchValue(src, exact.node, value) }]);
  }
  const anc = doc.stmts.find((s) => s.kind === 'kv' && s.path.length < path.length && startsWith(path, s.path));
  if (anc?.node) {
    if (anc.node.type !== 'inline') throw new ConfigEditError('conflict', `${anc.path.join('.')} は表ではなく、その下には足せません`);
    const obj = cloneTree(anc.node.value) as Tree;
    setInTree(obj, path.slice(anc.path.length), value);
    return applyRanges(src, [{ start: anc.node.start, end: anc.node.end, text: patchValue(src, anc.node, obj) }]);
  }
  const ed = new Editor(src, doc);
  const secs = doc.sections;
  let host = secs[0] as Section;
  for (const s of secs) if (!s.aot && s.path.length < path.length && startsWith(path, s.path) && s.path.length >= host.path.length) host = s;
  const rel = path.slice(host.path.length);
  const dotted = rel.length > 1 ? [...host.kvs].reverse().find((k) => k.path.length > host.path.length + 1 && k.path[host.path.length] === rel[0]) : undefined;
  const kvLine = `${rel.map(fmtKey).join('.')} = ${fmtInline(value)}`;
  if (dotted) return applyRanges(src, [insertLinesAfter(ed, doc, dotted.lastLine, [kvLine])]);

  if (!isTable(value) && rel.length === 1) {
    const lastKv = host.kvs[host.kvs.length - 1];
    if (lastKv) return applyRanges(src, [insertLinesAfter(ed, doc, lastKv.lastLine, [kvLine])]);
    if (host.header) return applyRanges(src, [insertLinesAfter(ed, doc, host.header.lastLine, [kvLine])]);
    const firstHeader = secs[1]?.header;
    if (firstHeader) {
      const off = ed.offsetOfLine(ed.attachedStart(firstHeader.firstLine));
      return applyRanges(src, [{ start: off, end: off, text: kvLine + ed.eol + ed.eol }]);
    }
    return applyRanges(src, [appendAtEnd(ed, src, [kvLine], false)]);
  }

  // 新しい節を作る
  const lines = isTable(value) ? renderSection(path, value) : [`[${path.slice(0, -1).map(fmtKey).join('.')}]`, `${fmtKey(path[path.length - 1] as string)} = ${fmtInline(value)}`];
  let anchor: Section | undefined;
  let best = 0;
  for (const s of secs.slice(1)) {
    let l = 0;
    while (l < s.path.length && l < path.length && s.path[l] === path[l]) l++;
    if (l >= best && l > 0) {
      best = l;
      anchor = s;
    }
  }
  const next = anchor ? secs[secs.indexOf(anchor) + 1] : undefined;
  if (next?.header) {
    const at = ed.attachedStart(next.header.firstLine);
    const off = ed.offsetOfLine(at);
    const lead = ed.isBlank(at - 1) ? '' : ed.eol;
    return applyRanges(src, [{ start: off, end: off, text: lead + lines.map((l) => l + ed.eol).join('') + ed.eol }]);
  }
  return applyRanges(src, [appendAtEnd(ed, src, lines, true)]);
}

function appendAtEnd(ed: Editor, src: string, lines: string[], blankBefore: boolean): Range {
  const hasContent = src.trim() !== '';
  let lead = '';
  if (src.length > 0 && !src.endsWith('\n')) lead += ed.eol;
  if (blankBefore && hasContent && !/\n[ \t]*\r?\n$/.test(src + (lead ? '\n' : ''))) lead += ed.eol;
  return { start: src.length, end: src.length, text: lead + lines.map((l) => l + ed.eol).join('') };
}

function removeImpl(src: string, path: readonly string[]): string {
  const doc = parseToml(src);
  if (getIn(doc.tree, path) === undefined) return src;
  const anc = doc.stmts.find((s) => s.kind === 'kv' && s.path.length < path.length && startsWith(path, s.path));
  if (anc?.node) {
    if (anc.node.type !== 'inline') throw new ConfigEditError('unsupported', `${anc.path.join('.')} の中は書き換えられません`);
    const obj = cloneTree(anc.node.value) as Tree;
    const rel = path.slice(anc.path.length);
    const parent = rel.length === 1 ? obj : getIn(obj, rel.slice(0, -1));
    if (isTable(parent)) delete parent[rel[rel.length - 1] as string];
    return applyRanges(src, [{ start: anc.node.start, end: anc.node.end, text: patchValue(src, anc.node, obj) }]);
  }
  const ed = new Editor(src, doc);
  const lastLine = doc.lineStarts.length - 1;
  const removedSecs = new Set<number>();
  const ranges: Range[] = [];
  let reachedEnd = false;
  doc.sections.forEach((s, k) => {
    if (k === 0 || !startsWith(s.path, path)) return;
    removedSecs.add(k);
    const header = s.header as Stmt;
    const from = ed.attachedStart(header.firstLine);
    const nextSec = doc.sections[k + 1];
    const to = nextSec?.header ? ed.attachedStart(nextSec.header.firstLine) - 1 : lastLine;
    if (!nextSec) reachedEnd = true;
    ranges.push({ start: ed.offsetOfLine(from), end: ed.offsetOfLine(to + 1), text: '' });
  });
  for (const st of doc.stmts) {
    if (st.kind !== 'kv' || removedSecs.has(st.secIdx) || !startsWith(st.path, path)) continue;
    ranges.push({ start: ed.offsetOfLine(st.firstLine), end: ed.offsetOfLine(st.lastLine + 1), text: '' });
  }
  let out = applyRanges(src, ranges);
  if (reachedEnd) out = out.replace(/(\r?\n)([ \t]*\r?\n)+$/, '$1');
  return out;
}
