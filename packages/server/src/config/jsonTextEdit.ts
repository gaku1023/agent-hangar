import { isDeepStrictEqual } from 'node:util';
import type { RetentionPreviewLine } from '@agent-hangar/shared';
import { MessageError, msg } from '../i18n/message.ts';

/**
 * JSON の文字列を、最上位の 1 つのキーの値だけ書き換える。
 *
 * Claude Code の settings.json は `"key" : value` のように、JSON.stringify と違う書式で書かれていることがある。
 * 書き直すと全行が変わり、利用者は差分を読めず、設定の同期も全体を送り直す。
 * そこで文字列の上で値の範囲だけを差し替え、ほかの空白、改行、キーの順には触れない。
 * 書き換えた後に JSON として読み直し、狙ったキー以外が変わっていないことを確かめる。
 */
export class JsonTextEditError extends MessageError {
  constructor() { super(msg('config.file.unreadableFormat')); this.name = 'JsonTextEditError'; }
}

type Member = { keyStart: number; key: string; valueStart: number; valueEnd: number; scalar: boolean; sep: string };

const WS = new Set([' ', '\t', '\n', '\r']);

/** 最上位のオブジェクトのメンバーを、位置つきで拾う。形が読めなければ投げる。 */
function scanTopLevel(text: string, from: number): { open: number; close: number; members: Member[] } {
  let i = from;
  const skipWs = () => { while (i < text.length && WS.has(text[i]!)) i++; };
  const readString = (): string => {
    if (text[i] !== '"') throw new JsonTextEditError();
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) throw new JsonTextEditError();
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  // 値を 1 つ飛ばす。入れ子は深さを数えるだけで、中身は見ない（文字列だけは括弧を数えないように読む）。
  const skipValue = (): boolean => {
    const c = text[i];
    if (c === '"') { readString(); return true; }
    if (c === '{' || c === '[') {
      let depth = 0;
      while (i < text.length) {
        const d = text[i]!;
        if (d === '"') { readString(); continue; }
        if (d === '{' || d === '[') depth++;
        else if (d === '}' || d === ']') { depth--; if (depth === 0) { i++; return false; } }
        i++;
      }
      throw new JsonTextEditError();
    }
    const start = i;
    while (i < text.length && !WS.has(text[i]!) && text[i] !== ',' && text[i] !== '}') i++;
    if (i === start) throw new JsonTextEditError();
    return true;
  };
  skipWs();
  if (text[i] !== '{') throw new JsonTextEditError();
  const open = i;
  i++;
  const members: Member[] = [];
  skipWs();
  if (text[i] === '}') return { open, close: i, members };
  for (;;) {
    skipWs();
    const keyStart = i;
    const key = readString();
    const sepStart = i;
    skipWs();
    if (text[i] !== ':') throw new JsonTextEditError();
    i++;
    skipWs();
    const sep = text.slice(sepStart, i);
    const valueStart = i;
    const scalar = skipValue();
    members.push({ keyStart, key, valueStart, valueEnd: i, scalar, sep });
    skipWs();
    if (text[i] === ',') { i++; continue; }
    if (text[i] === '}') return { open, close: i, members };
    throw new JsonTextEditError();
  }
}

export function setTopLevelNumber(text: string, key: string, value: number): string {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const fresh = `${bom}{${eol}  ${JSON.stringify(key)}: ${value}${eol}}${eol}`;
  if (body.trim() === '') return fresh;
  let before: unknown;
  try { before = JSON.parse(body); } catch { throw new JsonTextEditError(); }
  if (!before || typeof before !== 'object' || Array.isArray(before)) throw new JsonTextEditError();
  const { open, members } = scanTopLevel(body, 0);
  if (members.length === 0) return fresh;
  const hits = members.filter((m) => m.key === key);
  if (hits.length > 1) throw new JsonTextEditError();
  let out: string;
  if (hits.length === 1) {
    const m = hits[0]!;
    if (!m.scalar) throw new JsonTextEditError();
    out = body.slice(0, m.valueStart) + String(value) + body.slice(m.valueEnd);
  } else {
    const first = members[0]!;
    // 最初のメンバーの前にある空白（改行と字下げ）を、そのまま新しい行の後ろにも置く。
    const lead = body.slice(open + 1, first.keyStart);
    out = body.slice(0, first.keyStart) + `${JSON.stringify(key)}${first.sep}${value},` + lead + body.slice(first.keyStart);
  }
  let after: unknown;
  try { after = JSON.parse(out); } catch { throw new JsonTextEditError(); }
  if (!isDeepStrictEqual(after, { ...(before as Record<string, unknown>), [key]: value })) throw new JsonTextEditError();
  return bom + out;
}

/** 変わった行と、その前後 1 行ずつ。設定ファイルは小さいので、頭と尻から一致を削るだけで足りる。 */
export function diffLines(before: string, after: string): RetentionPreviewLine[] {
  const split = (s: string) => (s === '' ? [] : s.replace(/^\uFEFF/, '').replace(/\r?\n$/, '').split(/\r?\n/));
  const a = split(before);
  const b = split(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: RetentionPreviewLine[] = [];
  if (head > 0) out.push({ kind: 'ctx', text: a[head - 1]! });
  for (const t of a.slice(head, a.length - tail)) out.push({ kind: 'del', text: t });
  for (const t of b.slice(head, b.length - tail)) out.push({ kind: 'add', text: t });
  if (tail > 0) out.push({ kind: 'ctx', text: a[a.length - tail]! });
  return out;
}

/*
 * ここから下は JSONC（コメントと末尾のカンマを許す JSON）の入れ子の書き換え。opencode の opencode.json に使う。
 * 利用者が手で書いたファイルなので、上と同じく文字列の上で狙った範囲だけを差し替え、コメント、空白、改行、キーの順には触れない。
 * 書き換えた後に読み直し、狙ったキー以外が変わっていないことを確かめる。
 */

type JObject = { open: number; close: number; members: JMember[] };
type JMember = { keyStart: number; key: string; sep: string; valueStart: number; valueEnd: number; obj: JObject | null; commaAt: number | null };

/** JSONC を位置つきで読む。オブジェクトはメンバーの位置まで、ほかの値は範囲だけを拾う。 */
class JsoncScanner {
  i = 0;
  constructor(readonly text: string) {}

  /** 空白とコメントを飛ばす。閉じていない塊のコメントは読めないものとする。 */
  skip(): void {
    const t = this.text;
    for (;;) {
      while (this.i < t.length && WS.has(t[this.i]!)) this.i++;
      if (t.startsWith('//', this.i)) {
        while (this.i < t.length && t[this.i] !== '\n') this.i++;
        continue;
      }
      if (t.startsWith('/*', this.i)) {
        const end = t.indexOf('*/', this.i + 2);
        if (end === -1) throw new JsonTextEditError();
        this.i = end + 2;
        continue;
      }
      return;
    }
  }

  string(): string {
    const t = this.text;
    if (t[this.i] !== '"') throw new JsonTextEditError();
    const start = this.i++;
    while (this.i < t.length && t[this.i] !== '"') this.i += t[this.i] === '\\' ? 2 : 1;
    if (this.i >= t.length) throw new JsonTextEditError();
    this.i++;
    try { return JSON.parse(t.slice(start, this.i)) as string; } catch { throw new JsonTextEditError(); }
  }

  /** 値を 1 つ読む。オブジェクトなら JObject を返す。 */
  value(): JObject | null {
    const t = this.text;
    const c = t[this.i];
    if (c === '{') return this.object();
    if (c === '[') {
      this.i++;
      this.skip();
      while (t[this.i] !== ']') {
        this.value();
        this.skip();
        if (t[this.i] === ',') { this.i++; this.skip(); continue; }
        if (t[this.i] !== ']') throw new JsonTextEditError();
      }
      this.i++;
      return null;
    }
    if (c === '"') { this.string(); return null; }
    const start = this.i;
    while (this.i < t.length && /[-+.0-9a-zA-Z]/.test(t[this.i]!)) this.i++;
    if (this.i === start) throw new JsonTextEditError();
    return null;
  }

  object(): JObject {
    const t = this.text;
    const open = this.i++;
    const members: JMember[] = [];
    this.skip();
    while (t[this.i] !== '}') {
      const keyStart = this.i;
      const key = this.string();
      const sepStart = this.i;
      this.skip();
      if (t[this.i] !== ':') throw new JsonTextEditError();
      this.i++;
      this.skip();
      const sep = t.slice(sepStart, this.i);
      const valueStart = this.i;
      const obj = this.value();
      const m: JMember = { keyStart, key, sep, valueStart, valueEnd: this.i, obj, commaAt: null };
      members.push(m);
      this.skip();
      if (t[this.i] === ',') { m.commaAt = this.i; this.i++; this.skip(); continue; }
      if (t[this.i] !== '}') throw new JsonTextEditError();
    }
    return { open, close: this.i++, members };
  }
}

/** 最上位のオブジェクトを読む。最上位がオブジェクトでなければ投げる。後ろにコメントと空白のほかがあっても投げる。 */
function scanJsonc(body: string): JObject {
  const s = new JsoncScanner(body);
  s.skip();
  if (body[s.i] !== '{') throw new JsonTextEditError();
  const top = s.object();
  s.skip();
  if (s.i !== body.length) throw new JsonTextEditError();
  return top;
}

/** JSONC を読む。コメントと末尾のカンマを除いて JSON として読む。空（BOM と空白だけ）なら空のオブジェクト。読めなければ JsonTextEditError。 */
export function parseJsonc(text: string): unknown {
  const body = text.replace(/^﻿/, '');
  if (body.trim() === '') return {};
  let out = '';
  let i = 0;
  const skipCommentsAndWs = (from: number): number => {
    let j = from;
    for (;;) {
      while (j < body.length && WS.has(body[j]!)) j++;
      if (body.startsWith('//', j)) { while (j < body.length && body[j] !== '\n') j++; continue; }
      if (body.startsWith('/*', j)) { const end = body.indexOf('*/', j + 2); if (end === -1) throw new JsonTextEditError(); j = end + 2; continue; }
      return j;
    }
  };
  while (i < body.length) {
    const c = body[i]!;
    if (c === '"') {
      const start = i++;
      while (i < body.length && body[i] !== '"') i += body[i] === '\\' ? 2 : 1;
      if (i >= body.length) throw new JsonTextEditError();
      i++;
      out += body.slice(start, i);
      continue;
    }
    if (body.startsWith('//', i) || body.startsWith('/*', i)) { i = skipCommentsAndWs(i); out += ' '; continue; }
    if (c === ',') {
      const next = skipCommentsAndWs(i + 1);
      if (body[next] === '}' || body[next] === ']') { i = next; continue; }
    }
    out += c;
    i++;
  }
  try { return JSON.parse(out) as unknown; } catch { throw new JsonTextEditError(); }
}

const lineStartOf = (text: string, pos: number): number => text.lastIndexOf('\n', pos - 1) + 1;
/** pos を含む行の頭の空白。 */
const indentOf = (text: string, pos: number): string => /^[ \t]*/.exec(text.slice(lineStartOf(text, pos)))![0];
/** pos の前が、行の頭から空白だけか。 */
const startsLine = (text: string, pos: number): boolean => text.slice(lineStartOf(text, pos), pos).trim() === '';

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 期待する中身（before の path に value を置いたもの、value が undefined なら消したもの）。 */
function expectedAfter(before: unknown, path: readonly string[], value: unknown): unknown {
  const root = structuredClone(before) as Record<string, unknown>;
  let cur = root;
  for (const k of path.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = path[path.length - 1]!;
  if (value === undefined) delete cur[last]; else cur[last] = structuredClone(value);
  return root;
}

/** 入れ子を path にそって下りる。途中が無ければ、そこで止まる。同じキーが 2 度あるときと、途中がオブジェクトでないときは投げる。 */
function walk(top: JObject, path: readonly string[]): { obj: JObject; depth: number; hit: JMember | null } {
  let obj = top;
  for (let d = 0; d < path.length; d++) {
    const hits = obj.members.filter((m) => m.key === path[d]);
    if (hits.length > 1) throw new JsonTextEditError();
    const hit = hits[0] ?? null;
    if (!hit) return { obj, depth: d, hit: null };
    if (d === path.length - 1) return { obj, depth: d, hit };
    if (!hit.obj) throw new JsonTextEditError();
    obj = hit.obj;
  }
  throw new JsonTextEditError();
}

/**
 * JSONC の path（オブジェクトのキーの並び）に value を置く。
 * キーがあればその値の範囲だけを置き換え、途中から無ければ、ある所までのオブジェクトの終わりに入れ子ごと 1 つ足す。
 * 足す行の字下げは隣のメンバーにそろえ、1 段の幅は最上位の字下げから決める（読めなければ 2 つ）。1 行に書いたオブジェクトには、その行の中で足す。
 * 途中の値がオブジェクトでないとき、同じキーが 2 度あるとき、読めないときは JsonTextEditError を投げる。
 */
export function setJsoncPath(text: string, path: readonly string[], value: unknown): string {
  if (!path.length) throw new JsonTextEditError();
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const before = parseJsonc(body);
  if (!isPlainObject(before)) throw new JsonTextEditError();
  const nest = (keys: readonly string[]): unknown => keys.reduceRight<unknown>((v, k) => ({ [k]: v }), value);
  if (/^\s*\{\s*\}\s*$/.test(body) || body.trim() === '') {
    const [first, ...rest] = path;
    return `${bom}{${eol}  ${JSON.stringify(first)}: ${JSON.stringify(nest(rest), null, 2).split('\n').join(`${eol}  `)}${eol}}${eol}`;
  }
  const top = scanJsonc(body);
  const firstTop = top.members[0];
  const unit = firstTop && startsLine(body, firstTop.keyStart) && indentOf(body, firstTop.keyStart) ? indentOf(body, firstTop.keyStart) : '  ';
  const multiline = (o: JObject): boolean => body.slice(o.open, o.close).includes('\n');
  const render = (v: unknown, indent: string): string => JSON.stringify(v, null, unit).split('\n').join(eol + indent);
  const { obj, depth, hit } = walk(top, path);
  let out: string;
  if (hit) {
    const inline = !multiline(obj);
    out = body.slice(0, hit.valueStart) + (inline ? JSON.stringify(value) : render(value, indentOf(body, hit.keyStart))) + body.slice(hit.valueEnd);
  } else {
    const key = path[depth]!;
    const v = nest(path.slice(depth + 1));
    const sib = obj.members[0];
    const sep = sib && !sib.sep.includes('\n') ? sib.sep : ': ';
    const last = obj.members[obj.members.length - 1];
    if (!last) {
      // 空のオブジェクト。複数行に開いて 1 つ置く。
      const outer = indentOf(body, obj.open);
      const inner = outer + unit;
      out = `${body.slice(0, obj.open + 1)}${eol}${inner}${JSON.stringify(key)}${sep}${render(v, inner)}${eol}${outer}${body.slice(obj.close)}`;
    } else if (!multiline(obj) || !startsLine(body, obj.close)) {
      const at = last.commaAt !== null ? last.commaAt + 1 : last.valueEnd;
      out = `${body.slice(0, at)}${last.commaAt !== null ? '' : ','} ${JSON.stringify(key)}${sep}${JSON.stringify(v)}${body.slice(at)}`;
    } else {
      const indent = startsLine(body, last.keyStart) ? indentOf(body, last.keyStart) : indentOf(body, obj.close) + unit;
      const line = lineStartOf(body, obj.close);
      const withComma = last.commaAt !== null ? body.slice(0, line) : `${body.slice(0, last.valueEnd)},${body.slice(last.valueEnd, line)}`;
      out = `${withComma}${indent}${JSON.stringify(key)}${sep}${render(v, indent)}${eol}${body.slice(line)}`;
    }
  }
  if (!isDeepStrictEqual(parseJsonc(out), expectedAfter(before, path, value))) throw new JsonTextEditError();
  return bom + out;
}

/** JSONC の path のメンバーを消す。無ければ何も変えない。カンマは前後の並びが崩れないように一緒に消す。 */
export function removeJsoncPath(text: string, path: readonly string[]): string {
  if (!path.length) throw new JsonTextEditError();
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = bom ? text.slice(1) : text;
  const before = parseJsonc(body);
  if (!isPlainObject(before) || body.trim() === '') return text;
  const top = scanJsonc(body);
  let obj = top;
  let hit: JMember | null = null;
  for (let d = 0; d < path.length; d++) {
    const hits = obj.members.filter((m) => m.key === path[d]);
    if (hits.length > 1) throw new JsonTextEditError();
    if (!hits[0]) return text;
    if (d === path.length - 1) { hit = hits[0]; break; }
    if (!hits[0].obj) return text;
    obj = hits[0].obj;
  }
  if (!hit) return text;
  const idx = obj.members.indexOf(hit);
  const next = obj.members[idx + 1];
  const prev = obj.members[idx - 1];
  let out: string;
  if (next) out = body.slice(0, hit.keyStart) + body.slice(next.keyStart);
  else if (prev && prev.commaAt !== null) out = body.slice(0, prev.commaAt) + body.slice(hit.commaAt !== null ? hit.commaAt + 1 : hit.valueEnd);
  else out = body.slice(0, obj.open + 1) + body.slice(obj.close);
  if (!isDeepStrictEqual(parseJsonc(out), expectedAfter(before, path, undefined))) throw new JsonTextEditError();
  return bom + out;
}
