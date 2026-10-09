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
