import path from 'node:path';
import { isSafeRelPath } from '@agent-hangar/shared';

/**
 * opencode の設定ファイル（opencode.json(c)、cli.json）の鍵の仕分けと、id の読み書き（SPEC 3 章）。
 * 読むだけの純粋な処理で、ファイルには触れない。
 *
 * id：
 * - `opencode:file:<入れ物からの相対パス>`
 * - `opencode:json:<鍵の道>`：opencode.json(c) の鍵 1 つ。道は `.` で区切り、各段は encodeURIComponent に `.` も符号化したもの（agent の名前に `.` があってよい）。
 * - `opencode:cli:<鍵の道>`：cli.json の鍵 1 つ。
 */

export const OC_FILE_PREFIX = 'opencode:file:';
export const OC_JSON_PREFIX = 'opencode:json:';
export const OC_CLI_PREFIX = 'opencode:cli:';

const encSeg = (s: string): string => encodeURIComponent(s).replace(/\./g, '%2E');
export const ocPathId = (prefix: string, segs: readonly string[]): string => `${prefix}${segs.map(encSeg).join('.')}`;

/** id の道を段に分ける。符号化が正規の形でない、空の段がある、のどれかなら null。 */
export function decodePathId(rest: string): string[] | null {
  if (rest === '') return null;
  const segs: string[] = [];
  for (const raw of rest.split('.')) {
    let s: string;
    try { s = decodeURIComponent(raw); } catch { return null; }
    if (s === '' || encSeg(s) !== raw) return null;
    segs.push(s);
  }
  return segs;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrOrObj = (v: unknown): boolean => isStr(v) || isObject(v);

// ---- ファイル ----

/** 運ぶ入れ物の下のディレクトリ。v1 形（単数）と v2 形（複数）は名前を変えずに運ぶ。 */
export const OC_DIRS = ['agents', 'agent', 'commands', 'command', 'skills', 'skill', 'plugins', 'plugin', 'themes'] as const;
/** 実行される指示や台本の置き場。他の PC から届いたときに承諾が要る。 */
const EXEC_DIRS = new Set(['agents', 'agent', 'commands', 'command', 'skills', 'skill', 'plugins', 'plugin']);
/** 設定の鍵として別に運ぶ、または PC の状態なので、ファイルとしては運ばない名前。 */
const DENY_ROOT = new Set(['opencode.json', 'opencode.jsonc', 'cli.json', 'tui.json', 'service.json', 'package.json', 'package-lock.json', 'bun.lock', 'bun.lockb', '.gitignore']);
const EXCLUDE_SEGMENTS = new Set(['node_modules', '.git', '__pycache__', '.venv', '.DS_Store']);
const OURS_RE = /\.conflict-[^/]*$|\.hangar-tmp-[^/]*$|\.part$/;

/** 運んでよいファイルの相対パスか。`{file:}` が指すファイルも運ぶので、置き場の外と設定そのもの以外は通す。 */
export function isCarriedRel(rel: string): boolean {
  if (!isSafeRelPath(rel)) return false;
  const segs = rel.split('/');
  if (segs.some((s) => EXCLUDE_SEGMENTS.has(s) || OURS_RE.test(s))) return false;
  if (segs.length === 1 && DENY_ROOT.has(rel)) return false;
  return true;
}

/** 実行の印の対象になる（承諾が要る）ファイルか。AGENTS.md と themes/ の下は本文とデータなので要らない。 */
export function isExecRel(rel: string): boolean {
  if (rel === 'AGENTS.md') return false;
  const top = rel.split('/')[0]!;
  return top !== 'themes';
}
export const isExecDir = (top: string): boolean => EXEC_DIRS.has(top);

// ---- opencode.json(c) ----

type Dropped = { key: string; reason: 'path' | 'machine' | 'unknown' };
export type OcJsonItem = { path: string[]; value: unknown };
export type OcJsonSort = {
  items: OcJsonItem[];
  /** 運ばない鍵と理由。key は id の形（`opencode:json:...`）。 */
  dropped: Dropped[];
  /** 知らない鍵の道。送れない。 */
  unknown: string[][];
  /** `{file:}` が指す、入れ物の中の相対パス（`{file:}` を含む項目ごと）。 */
  fileRefs: { path: string[]; rels: string[] }[];
};

const TOP_SCALAR = new Map<string, (v: unknown) => boolean>([
  ['model', isStr], ['small_model', isStr], ['share', isStr], ['theme', isStr],
  ['autoupdate', (v) => typeof v === 'boolean' || isStr(v)],
  ['compaction', isStrOrObj], ['permission', isStrOrObj],
]);
const AGENT_FIELDS = new Map<string, (v: unknown) => boolean>([
  ['prompt', isStr], ['description', isStr], ['mode', isStr], ['temperature', isNum], ['top_p', isNum], ['steps', isNum], ['permission', isStrOrObj],
]);
/** PC に依るので運ばない最上位の鍵（接続先、パスを指すもの）。mcp は S7 が別に扱う。 */
const MACHINE_TOP = new Set(['provider', 'providers', 'skills', 'plugin', 'plugins']);
const SILENT_TOP = new Set(['$schema', 'mcp']);

/** 絶対パスらしいか（POSIX の `/`、Windows のドライブ、UNC）。`~/` と URL は含めない。 */
export const isAbsolutePathLike = (s: string): boolean => s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\');

const FILE_REF_RE = /\{file:([^}]*)\}/g;
const ENV_REF_RE = /\{env:([^}]*)\}/g;

/** `{file:p}` の p が入れ物の中の相対パスなら、その相対パス（正規化済み）。外、絶対、`~`、壊れたものは null。 */
export function fileRefRel(p: string): string | null {
  const t = p.trim();
  if (t === '' || isAbsolutePathLike(t) || t.startsWith('~')) return null;
  const rel = path.posix.normalize(t.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (rel === '.' || rel.startsWith('../') || rel === '..') return null;
  return isCarriedRel(rel) ? rel : null;
}

function* stringsOf(v: unknown): Generator<string> {
  if (isStr(v)) yield v;
  else if (Array.isArray(v)) for (const x of v) yield* stringsOf(x);
  else if (isObject(v)) for (const x of Object.values(v)) yield* stringsOf(x);
}

/** 値の中の `{file:p}` の p を全部。 */
export function fileRefsOf(v: unknown): string[] {
  const out: string[] = [];
  for (const s of stringsOf(v)) for (const m of s.matchAll(FILE_REF_RE)) out.push(m[1]!);
  return out;
}
/** 値の中の `{env:X}` の X を全部（重複なし、出た順）。 */
export function envRefsOf(v: unknown): string[] {
  const out = new Set<string>();
  for (const s of stringsOf(v)) for (const m of s.matchAll(ENV_REF_RE)) if (m[1]!.trim() !== '') out.add(m[1]!.trim());
  return [...out];
}

/** opencode.json(c) の根を仕分ける。根がオブジェクトでなければ呼ばない。 */
export function sortOpencodeJson(root: Record<string, unknown>): OcJsonSort {
  const out: OcJsonSort = { items: [], dropped: [], unknown: [], fileRefs: [] };
  const idOf = (segs: string[]): string => ocPathId(OC_JSON_PREFIX, segs);
  const unknown = (segs: string[]): void => { out.unknown.push(segs); out.dropped.push({ key: idOf(segs), reason: 'unknown' }); };
  /** `{file:}` を見て、外を指すなら項目ごと保留にする。中なら、運ぶファイルに加える。 */
  const push = (segs: string[], value: unknown): void => {
    const refs = fileRefsOf(value);
    const rels: string[] = [];
    for (const p of refs) {
      const rel = fileRefRel(p);
      if (rel === null) { out.dropped.push({ key: idOf(segs), reason: 'path' }); return; }
      rels.push(rel);
    }
    out.items.push({ path: segs, value });
    if (rels.length > 0) out.fileRefs.push({ path: segs, rels });
  };

  for (const [k, v] of Object.entries(root)) {
    if (SILENT_TOP.has(k)) continue;
    if (MACHINE_TOP.has(k)) { out.dropped.push({ key: idOf([k]), reason: 'machine' }); continue; }
    const fits = TOP_SCALAR.get(k);
    if (fits) { if (fits(v)) push([k], v); else unknown([k]); continue; }
    if (k === 'instructions') {
      if (!Array.isArray(v) || !v.every(isStr)) { unknown([k]); continue; }
      const kept = v.filter((e) => !isAbsolutePathLike(e));
      if (kept.length < v.length) out.dropped.push({ key: idOf([k]), reason: 'path' });
      if (kept.length > 0) push([k], kept);
      continue;
    }
    if (k === 'agent' || k === 'agents') {
      if (!isObject(v)) { unknown([k]); continue; }
      for (const [name, a] of Object.entries(v)) {
        if (!isObject(a)) { unknown([k, name]); continue; }
        for (const [f, fv] of Object.entries(a)) {
          if (f === 'model') { out.dropped.push({ key: idOf([k, name, f]), reason: 'machine' }); continue; }
          const ok = AGENT_FIELDS.get(f);
          if (ok && ok(fv)) push([k, name, f], fv);
          else unknown([k, name, f]);
        }
      }
      continue;
    }
    unknown([k]);
  }
  return out;
}

/** 受け手が id から決まる鍵の道に、届いた値を書いてよいか（型の検査）。 */
export function jsonValueFits(segs: readonly string[], v: unknown): boolean {
  const k = segs[0]!;
  if (segs.length === 1) {
    if (k === 'instructions') return Array.isArray(v) && v.every(isStr);
    return TOP_SCALAR.get(k)?.(v) ?? false;
  }
  if ((k === 'agent' || k === 'agents') && segs.length === 3) return AGENT_FIELDS.get(segs[2]!)?.(v) ?? false;
  return false;
}

/** id の鍵の道が、運ぶ形か。 */
export function isCarriedJsonPath(segs: readonly string[]): boolean {
  const k = segs[0]!;
  if (segs.length === 1) return TOP_SCALAR.has(k) || k === 'instructions';
  return (k === 'agent' || k === 'agents') && segs.length === 3 && segs[2] !== 'model' && AGENT_FIELDS.has(segs[2]!);
}

/** 権限に関わる鍵か（承諾が要る。消去も、拒否を外して権限を広げうるので承諾に掛ける）。 */
export const isPermissionPath = (segs: readonly string[]): boolean => segs[segs.length - 1] === 'permission';

// ---- cli.json ----

export type OcCliItem = { path: string[]; value: unknown };

/** cli.json の根を仕分ける。plugins と attention.sounds は運ばない。attention は 1 段下まで分ける。 */
export function sortOpencodeCli(root: Record<string, unknown>): { items: OcCliItem[]; dropped: Dropped[] } {
  const items: OcCliItem[] = [];
  const dropped: Dropped[] = [];
  for (const [k, v] of Object.entries(root)) {
    if (k === '$schema') continue;
    if (k === 'plugins') { dropped.push({ key: ocPathId(OC_CLI_PREFIX, [k]), reason: 'machine' }); continue; }
    if (k === 'attention' && isObject(v)) {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk === 'sounds') dropped.push({ key: ocPathId(OC_CLI_PREFIX, [k, sk]), reason: 'machine' });
        else items.push({ path: [k, sk], value: sv });
      }
      continue;
    }
    if (k === 'attention') { items.push({ path: [k], value: v }); continue; }
    items.push({ path: [k], value: v });
  }
  return { items, dropped };
}

/** id の cli の鍵の道が、運ぶ形か。 */
export function isCarriedCliPath(segs: readonly string[]): boolean {
  const k = segs[0]!;
  if (k === '$schema' || k === 'plugins') return false;
  if (k === 'attention') return segs.length === 1 || (segs.length === 2 && segs[1] !== 'sounds');
  return segs.length === 1;
}
