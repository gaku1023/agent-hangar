import { ConfigEditError, lineOf } from './errors.ts';

/**
 * 形を保つ編集のための TOML 読み取り。
 * 値の木と、文（表の見出し・鍵と値）ごとの行と文字位置を返す。
 * 厳しく読む（鍵の重複、表の重複、点のついた鍵で作った表を見出しで開く、インライン表の拡張は失敗）。
 */

export type ValueStyle = 'basic' | 'literal' | 'mlbasic' | 'mlliteral';

export interface VNode {
  type: 'string' | 'number' | 'boolean' | 'datetime' | 'array' | 'inline';
  start: number;
  end: number;
  value: unknown;
  style?: ValueStyle;
  items?: VNode[];
  entries?: { key: string; dotted: boolean; start: number; node: VNode }[];
}

export interface Stmt {
  kind: 'header' | 'aot' | 'kv';
  /** 見出しの道、または鍵の完全な道（表の道 + 鍵） */
  path: string[];
  secIdx: number;
  /** 0 から数えた行（両端を含む） */
  firstLine: number;
  lastLine: number;
  node?: VNode;
}

export interface Section {
  path: string[];
  aot: boolean;
  header?: Stmt;
  kvs: Stmt[];
}

export type Tree = Record<string, unknown>;

export interface TomlDoc {
  src: string;
  lineStarts: number[];
  tree: Tree;
  stmts: Stmt[];
  sections: Section[];
  /** 文が占める行 */
  covered: boolean[];
}

const mk = (): Tree => Object.create(null) as Tree;
const isObj = (v: unknown): v is Tree => typeof v === 'object' && v !== null && !Array.isArray(v);
const BARE = /^[A-Za-z0-9_-]+$/;
const keyId = (p: readonly string[]): string => p.join('\u0000');

export function datetimeValue(raw: string): Tree {
  const o = mk();
  o.$datetime = raw;
  return o;
}

export function isDatetimeValue(v: unknown): boolean {
  return isObj(v) && Object.keys(v).length === 1 && typeof v.$datetime === 'string';
}

export function parseToml(src: string): TomlDoc {
  let i = 0;
  const n = src.length;
  const fail = (msg: string, at = i): never => {
    throw new ConfigEditError('parse', `TOML として読めません（${msg}）`, lineOf(src, at));
  };

  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (src.charCodeAt(k) === 10) lineStarts.push(k + 1);
  const lineAt = (off: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const skipWs = (): void => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
  };
  const skipBlank = (): void => {
    for (;;) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else if (c === '#') while (i < n && src[i] !== '\n') i++;
      else return;
    }
  };
  const endOfLine = (): void => {
    skipWs();
    if (src[i] === '#') while (i < n && src[i] !== '\n') i++;
    if (i < n && src[i] === '\r' && src[i + 1] === '\n') i++;
    if (i < n && src[i] !== '\n') fail('値の後ろに余計な文字があります');
    if (i < n) i++;
  };

  const ESC: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  const readEscape = (): string => {
    // src[i] は '\' の次
    const c = src[i] as string;
    if (Object.hasOwn(ESC, c)) {
      i++;
      return ESC[c] as string;
    }
    if (c === 'u' || c === 'U') {
      const len = c === 'u' ? 4 : 8;
      const hex = src.slice(i + 1, i + 1 + len);
      if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) fail('\\u の後ろが 16 進数ではありません');
      const cp = Number.parseInt(hex, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('不正なコードポイントです');
      i += 1 + len;
      return String.fromCodePoint(cp);
    }
    return fail('不正なエスケープです');
  };
  const parseBasic = (): string => {
    const start = i;
    i++;
    let out = '';
    for (;;) {
      if (i >= n || src[i] === '\n') return fail('文字列が閉じていません', start);
      const c = src[i] as string;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        i++;
        out += readEscape();
      } else {
        out += c;
        i++;
      }
    }
  };
  const parseLiteral = (): string => {
    const start = i;
    const end = src.indexOf("'", i + 1);
    const nl = src.indexOf('\n', i + 1);
    if (end < 0 || (nl >= 0 && nl < end)) return fail('文字列が閉じていません', start);
    const s = src.slice(i + 1, end);
    i = end + 1;
    return s;
  };
  const parseMlBasic = (): string => {
    const start = i;
    i += 3;
    if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
    else if (src[i] === '\n') i++;
    let out = '';
    for (;;) {
      if (i >= n) return fail('複数行の文字列が閉じていません', start);
      if (src.startsWith('"""', i)) {
        let extra = 0;
        while (extra < 2 && src[i + 3 + extra] === '"') extra++;
        out += '"'.repeat(extra);
        i += 3 + extra;
        return out;
      }
      const c = src[i] as string;
      if (c === '\\') {
        i++;
        let j = i;
        while (src[j] === ' ' || src[j] === '\t') j++;
        if (src[j] === '\n' || (src[j] === '\r' && src[j + 1] === '\n')) {
          while (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r') j++;
          i = j;
        } else out += readEscape();
      } else {
        out += c;
        i++;
      }
    }
  };
  const parseMlLiteral = (): string => {
    const start = i;
    i += 3;
    if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
    else if (src[i] === '\n') i++;
    const from = i;
    for (;;) {
      if (i >= n) return fail('複数行の文字列が閉じていません', start);
      if (src.startsWith("'''", i)) {
        let extra = 0;
        while (extra < 2 && src[i + 3 + extra] === "'") extra++;
        const s = src.slice(from, i + extra);
        i += 3 + extra;
        return s;
      }
      i++;
    }
  };

  const parseKeyPart = (): string => {
    skipWs();
    const c = src[i];
    if (c === '"') return parseBasic();
    if (c === "'") return parseLiteral();
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
    if (!m) return fail('鍵が読めません');
    i += m[0].length;
    return m[0];
  };
  const parseKey = (): string[] => {
    const parts = [parseKeyPart()];
    for (;;) {
      skipWs();
      if (src[i] === '.') {
        i++;
        parts.push(parseKeyPart());
      } else return parts;
    }
  };

  const INT = /^[+-]?(0|[1-9](_?\d)*)$/;
  const FLOAT = /^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
  const DT = /^\d{4}-\d\d-\d\d([Tt ]\d\d:\d\d(:\d\d(\.\d+)?)?([Zz]|[+-]\d\d:\d\d)?)?$|^\d\d:\d\d(:\d\d(\.\d+)?)?$/;
  const markInline = (o: Tree, path: string[], status: Map<string, string>): void => {
    for (const [k, v] of Object.entries(o)) {
      if (isObj(v) && !isDatetimeValue(v)) {
        status.set(keyId([...path, k]), 'inline');
        markInline(v, [...path, k], status);
      }
    }
  };

  const parseValue = (): VNode => {
    const start = i;
    const c = src[i];
    if (c === '"' || c === "'") {
      const ml = src.startsWith(c.repeat(3), i);
      const s = c === '"' ? (ml ? parseMlBasic() : parseBasic()) : ml ? parseMlLiteral() : parseLiteral();
      const style: ValueStyle = c === '"' ? (ml ? 'mlbasic' : 'basic') : ml ? 'mlliteral' : 'literal';
      return { type: 'string', start, end: i, value: s, style };
    }
    if (c === '[') {
      i++;
      const items: VNode[] = [];
      for (;;) {
        skipBlank();
        if (i >= n) return fail('配列が閉じていません', start);
        if (src[i] === ']') {
          i++;
          break;
        }
        items.push(parseValue());
        skipBlank();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') return fail('配列の区切りが読めません');
      }
      return { type: 'array', start, end: i, value: items.map((x) => x.value), items };
    }
    if (c === '{') {
      i++;
      const obj = mk();
      const entries: NonNullable<VNode['entries']> = [];
      const status = new Map<string, string>();
      for (;;) {
        skipBlank();
        if (i >= n) return fail('インライン表が閉じていません', start);
        if (src[i] === '}') {
          i++;
          break;
        }
        const es = i;
        const parts = parseKey();
        skipWs();
        if (src[i] !== '=') return fail('= がありません');
        i++;
        skipWs();
        const node = parseValue();
        let t = obj;
        for (let k = 0; k < parts.length - 1; k++) {
          const p = parts[k] as string;
          const cur = t[p];
          if (cur === undefined) t = t[p] = mk();
          else if (isObj(cur) && status.get(keyId(parts.slice(0, k + 1))) === 'dotted') t = cur;
          else return fail(`インライン表の鍵 ${p} を広げられません`, es);
          status.set(keyId(parts.slice(0, k + 1)), 'dotted');
        }
        const last = parts[parts.length - 1] as string;
        if (Object.hasOwn(t, last)) return fail(`インライン表の鍵 ${last} が重複しています`, es);
        t[last] = node.value;
        entries.push({ key: parts[0] as string, dotted: parts.length > 1, start: es, node });
        skipBlank();
        if (src[i] === ',') i++;
        else if (src[i] !== '}') return fail('インライン表の区切りが読めません');
      }
      return { type: 'inline', start, end: i, value: obj, entries };
    }
    let j = i;
    while (j < n && !' \t\r\n#,]}'.includes(src[j] as string)) j++;
    let tok = src.slice(i, j);
    if (tok === '') return fail('値がありません');
    if (/^\d{4}-\d\d-\d\d$/.test(tok) && src[j] === ' ' && /^\d\d:/.test(src.slice(j + 1, j + 4))) {
      let k = j + 1;
      while (k < n && !' \t\r\n#,]}'.includes(src[k] as string)) k++;
      tok = src.slice(i, k);
      j = k;
    }
    i = j;
    if (tok === 'true' || tok === 'false') return { type: 'boolean', start, end: i, value: tok === 'true' };
    if (/^[+-]?inf$/.test(tok)) return { type: 'number', start, end: i, value: tok.startsWith('-') ? -Infinity : Infinity };
    if (/^[+-]?nan$/.test(tok)) return { type: 'number', start, end: i, value: Number.NaN };
    if (DT.test(tok)) return { type: 'datetime', start, end: i, value: datetimeValue(tok) };
    const radix = /^0([xob])([0-9a-fA-F_]+)$/.exec(tok);
    if (radix) {
      const base = radix[1] === 'x' ? 16 : radix[1] === 'o' ? 8 : 2;
      const digits = (radix[2] as string).replace(/_/g, '');
      const v = BigInt(`0${radix[1]}${digits}`);
      if (Number.isNaN(Number.parseInt(digits, base))) return fail(`数値が読めません: ${tok}`, start);
      return { type: 'number', start, end: i, value: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v };
    }
    if (INT.test(tok)) {
      const v = BigInt(tok.replace(/_/g, ''));
      return { type: 'number', start, end: i, value: v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v };
    }
    if (FLOAT.test(tok)) return { type: 'number', start, end: i, value: Number(tok.replace(/_/g, '')) };
    return fail(`値が読めません: ${tok}`, start);
  };

  // ---- 本体
  const root = mk();
  const status = new Map<string, string>();
  const stmts: Stmt[] = [];
  const sections: Section[] = [{ path: [], aot: false, kvs: [] }];
  let curObj: Tree = root;
  let curSec = 0;
  const covered: boolean[] = lineStarts.map(() => false);

  const walk = (parts: string[], upto: number, at: number): Tree => {
    let cur = root;
    for (let k = 0; k < upto; k++) {
      const key = parts[k] as string;
      let child = cur[key];
      const id = keyId(parts.slice(0, k + 1));
      if (child === undefined) {
        child = cur[key] = mk();
        status.set(id, 'implicit');
      } else if (Array.isArray(child)) {
        if (status.get(id) !== 'aot') return fail(`${parts.slice(0, k + 1).join('.')} は配列です`, at);
        child = child[child.length - 1];
      } else if (!isObj(child) || status.get(id) === 'inline') return fail(`${parts.slice(0, k + 1).join('.')} は表として開けません`, at);
      cur = child as Tree;
    }
    return cur;
  };

  for (;;) {
    skipBlank();
    if (i >= n) break;
    const sStart = i;
    const c = src[i];
    if (c === '[') {
      const aot = src[i + 1] === '[';
      i += aot ? 2 : 1;
      const path = parseKey();
      skipWs();
      if (aot ? !src.startsWith(']]', i) : src[i] !== ']') return fail('見出しが閉じていません');
      i += aot ? 2 : 1;
      const last = lineAt(i - 1);
      endOfLine();
      const parent = walk(path, path.length - 1, sStart);
      const leaf = path[path.length - 1] as string;
      const id = keyId(path);
      const existing = parent[leaf];
      if (aot) {
        if (existing === undefined) {
          parent[leaf] = [];
          status.set(id, 'aot');
        } else if (!Array.isArray(existing) || status.get(id) !== 'aot') return fail(`${path.join('.')} は表の配列にできません`, sStart);
        for (const k of [...status.keys()]) if (k.startsWith(`${id}\u0000`)) status.delete(k);
        curObj = mk();
        (parent[leaf] as unknown[]).push(curObj);
      } else {
        if (existing === undefined) {
          curObj = parent[leaf] = mk();
        } else if (isObj(existing) && status.get(id) === 'implicit') curObj = existing;
        else return fail(`表 ${path.join('.')} が重複しています`, sStart);
        status.set(id, 'explicit');
      }
      const stmt: Stmt = { kind: aot ? 'aot' : 'header', path, secIdx: sections.length, firstLine: lineAt(sStart), lastLine: last };
      sections.push({ path, aot, header: stmt, kvs: [] });
      curSec = sections.length - 1;
      stmts.push(stmt);
      continue;
    }
    const parts = parseKey();
    skipWs();
    if (src[i] !== '=') return fail('= がありません');
    i++;
    skipWs();
    const node = parseValue();
    const lastLine = lineAt(Math.max(i - 1, sStart));
    endOfLine();
    const sec = sections[curSec] as Section;
    let t = curObj;
    for (let k = 0; k < parts.length - 1; k++) {
      const p = parts[k] as string;
      const id = keyId([...sec.path, ...parts.slice(0, k + 1)]);
      const cur = t[p];
      if (cur === undefined) {
        t = t[p] = mk();
        status.set(id, 'dotted');
      } else if (isObj(cur) && status.get(id) === 'dotted') t = cur;
      else return fail(`${[...sec.path, ...parts.slice(0, k + 1)].join('.')} を点のついた鍵で広げられません`, sStart);
    }
    const leaf = parts[parts.length - 1] as string;
    if (Object.hasOwn(t, leaf)) return fail(`鍵 ${[...sec.path, ...parts].join('.')} が重複しています`, sStart);
    t[leaf] = node.value;
    if (isObj(node.value) && node.type === 'inline') {
      const full = [...sec.path, ...parts];
      status.set(keyId(full), 'inline');
      markInline(node.value, full, status);
    }
    const stmt: Stmt = { kind: 'kv', path: [...sec.path, ...parts], secIdx: curSec, firstLine: lineAt(sStart), lastLine, node };
    sec.kvs.push(stmt);
    stmts.push(stmt);
  }

  for (const s of stmts) for (let l = s.firstLine; l <= s.lastLine; l++) covered[l] = true;
  return { src, lineStarts, tree: root, stmts, sections, covered };
}

export { BARE };
