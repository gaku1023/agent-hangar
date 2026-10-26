import { applyEdits, modify, parse, parseTree, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { ConfigEditError, deepEqual, detectEol, isPlainObject, lineOf } from './errors.ts';

/**
 * opencode.json(c) と cli.json の書き戻し。
 * jsonc はコメント、空行、鍵の並び、他の行の体裁を保ち、触った所だけを書き換える（opencode 自身もそうする）。
 * json は opencode が書くたびに 2 空白で整形し直すので、同じ整形で書く（formatJson）。
 * 壊れた入力と、JSON にできない値は ConfigEditError を投げる。何も書かない。
 */

/** 鍵の道。配列の要素は数で指す。 */
export type JsoncPath = readonly (string | number)[];

const PARSE_OPTS = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true } as const;

function parseJsonc(src: string): unknown {
  const errors: ParseError[] = [];
  const v: unknown = parse(src, errors, PARSE_OPTS);
  const first = errors[0];
  if (first) throw new ConfigEditError('parse', `jsonc として読めません（${printParseErrorCode(first.error)}）`, lineOf(src, first.offset));
  return v;
}

function assertRootObject(src: string, root: unknown): asserts root is Record<string, unknown> | undefined {
  if (root === undefined && src.trim() === '') return;
  if (!isPlainObject(root)) throw new ConfigEditError('unsupported', '根が { } でない文書には書けません');
}

function assertJsonValue(v: unknown, at = ''): void {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ConfigEditError('invalid-value', `JSON にできない数です${at}`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => assertJsonValue(x, `${at}[${i}]`));
  if (isPlainObject(v)) return Object.entries(v).forEach(([k, x]) => assertJsonValue(x, `${at}.${k}`));
  throw new ConfigEditError('invalid-value', `JSON にできない値です${at}`);
}

/** 道に沿って値を取る。無ければ undefined。 */
export function getIn(root: unknown, path: JsoncPath): unknown {
  let cur = root;
  for (const seg of path) {
    if (Array.isArray(cur) && typeof seg === 'number') cur = cur[seg];
    else if (isPlainObject(cur) && typeof seg === 'string' && Object.hasOwn(cur, seg)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** 期待する結果を、読み込んだ木に対して計算する（書いた後の検算に使う）。 */
function setIn(root: Record<string, unknown>, path: JsoncPath, value: unknown): void {
  let cur: unknown = root;
  path.forEach((seg, i) => {
    const last = i === path.length - 1;
    if (Array.isArray(cur)) {
      if (typeof seg !== 'number' || seg < 0 || seg > cur.length) throw new ConfigEditError('conflict', `配列に ${String(seg)} を足せません`);
      if (last) cur[seg] = value;
      else cur = cur[seg] ?? (cur[seg] = typeof path[i + 1] === 'number' ? [] : {});
    } else if (isPlainObject(cur)) {
      if (typeof seg !== 'string') throw new ConfigEditError('conflict', `表に数の鍵 ${seg} は足せません`);
      if (last) cur[seg] = value;
      else {
        const next = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
        if (next === undefined) cur = cur[seg] = typeof path[i + 1] === 'number' ? [] : {};
        else if (next !== null && typeof next === 'object') cur = next;
        else throw new ConfigEditError('conflict', `${path.slice(0, i + 1).join('.')} は値で、その下には足せません`);
      }
    } else throw new ConfigEditError('conflict', `${path.slice(0, i).join('.')} は値で、その下には足せません`);
  });
}

function removeIn(root: Record<string, unknown>, path: JsoncPath): void {
  const parent = getIn(root, path.slice(0, -1));
  const seg = path[path.length - 1];
  if (Array.isArray(parent) && typeof seg === 'number') parent.splice(seg, 1);
  else if (isPlainObject(parent) && typeof seg === 'string') delete parent[seg];
}

/** jsonc の鍵の道の値を読む。無ければ undefined。 */
export function getJsonc(src: string, path: JsoncPath): unknown {
  return getIn(parseJsonc(src), path);
}

function writeJsonc(src: string, path: JsoncPath, value: unknown, expected: unknown): string {
  const eol = detectEol(src);
  const base = src.trim() === '' ? '{}' : src;
  const edits = modify(base, [...path], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } });
  const out = applyEdits(base, edits);
  let after: unknown;
  try {
    after = parseJsonc(out);
  } catch {
    throw new ConfigEditError('verify', '書いた結果が jsonc として読めません');
  }
  if (!deepEqual(after, expected)) throw new ConfigEditError('verify', '書いた結果が狙った中身と違います');
  return out;
}

/** jsonc の鍵の道 1 つの値を差し替える・足す。無い入れ物は作る。コメントと体裁は保つ。 */
export function setJsonc(src: string, path: JsoncPath, value: unknown): string {
  if (path.length === 0) throw new ConfigEditError('unsupported', '根は差し替えられません');
  assertJsonValue(value);
  const root = parseJsonc(src);
  assertRootObject(src, root);
  const expected = clone(root ?? {}) as Record<string, unknown>;
  setIn(expected, path, clone(value));
  if (deepEqual(root ?? {}, expected) && root !== undefined) return src;
  return writeJsonc(src, path, value, expected);
}

/** jsonc の鍵の道 1 つを消す。無ければ何も変えない。 */
export function removeJsonc(src: string, path: JsoncPath): string {
  if (path.length === 0) throw new ConfigEditError('unsupported', '根は消せません');
  const root = parseJsonc(src);
  assertRootObject(src, root);
  if (root === undefined || getIn(root, path) === undefined) return src;
  const expected = clone(root);
  removeIn(expected, path);
  return writeJsonc(src, path, undefined, expected);
}

// ---- json（opencode.json など。opencode が 2 空白で整形し直すので同じ形で書く）

/** opencode が書くときと同じ整形（2 空白、末尾に改行）。 */
export function formatJson(value: unknown): string {
  assertJsonValue(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson(src: string): Record<string, unknown> {
  if (src.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(src);
  } catch (e) {
    throw new ConfigEditError('parse', `json として読めません（${(e as Error).message}）`);
  }
  if (!isPlainObject(v)) throw new ConfigEditError('unsupported', '根が { } でない文書には書けません');
  return v;
}

export function getJson(src: string, path: JsoncPath): unknown {
  return getIn(parseJson(src), path);
}

/** json の鍵の道の値を差し替える・足す。全体を 2 空白で整形し直す。鍵の並びと未知の鍵は保つ。 */
export function setJson(src: string, path: JsoncPath, value: unknown): string {
  if (path.length === 0) throw new ConfigEditError('unsupported', '根は差し替えられません');
  assertJsonValue(value);
  const root = parseJson(src);
  setIn(root, path, clone(value));
  return formatJson(root);
}

export function removeJson(src: string, path: JsoncPath): string {
  if (path.length === 0) throw new ConfigEditError('unsupported', '根は消せません');
  const root = parseJson(src);
  removeIn(root, path);
  return formatJson(root);
}
