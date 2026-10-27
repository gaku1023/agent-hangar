import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigApplyOrderItemDto, ConfigExecMark, ConfigItemKind, ConfigUnsentKind } from '@agent-hangar/shared';
import { backupsRoot } from '../../../config/cloud.ts';
import { ApplyError, type ApplyOptions, type ApplyPlan, type ApplyPlanItem, type ApplyResult, type PlannedOp, type PlanReader, type WritePaths } from '../apply.ts';
import { OPENCODE_STORE } from './stores.ts';
import { readApplyOrder } from '../applyOrder.ts';
import { GENERATION_META, stampLabel } from '../backups.ts';
import { ConfigBase } from '../base.ts';
import { MAX_ITEM_BYTES } from '../bundle.ts';
import { execMarksOf, type Collected, type LocalItem, type UnsentCandidate } from '../collect.ts';
import { readInbox, readInboxBlob } from '../inbox.ts';
import type { ItemRef } from '../ids.ts';
import { findSecret } from '../secrets.ts';
import { canonicalJson } from '../settingsSort.ts';
import { ConfigEditError, getJsonc, removeJson, removeJsonc, setJson, setJsonc } from '../edit/index.ts';
import { getIn } from '../edit/jsonc.ts';
import {
  decodePathId, envRefsOf, fileRefRel, fileRefsOf, isAbsolutePathLike, isCarriedCliPath, isCarriedJsonPath, isCarriedRel, isExecRel, isPermissionPath,
  jsonValueFits, OC_CLI_PREFIX, OC_DIRS, OC_FILE_PREFIX, OC_JSON_PREFIX, ocPathId, sortOpencodeCli, sortOpencodeJson,
} from './opencodeKeys.ts';
import type { ConfigTarget, ParsedId, TargetContext } from './types.ts';

/**
 * opencode（`$XDG_CONFIG_HOME/opencode`、既定 `~/.config/opencode`）。設計書 2・3 章。
 *
 * - ファイル：AGENTS.md、agents/・agent/、commands/・command/、skills/・skill/、plugins/・plugin/、themes/。
 *   opencode.json(c) の `{file:}` が入れ物の中を指すとき、そのファイルも運ぶ。
 * - opencode.json(c) の鍵：id は `opencode:json:<道>`。jsonc があれば jsonc を正とする（opencode も両方読み、jsonc を優先する）。
 * - cli.json の鍵：id は `opencode:cli:<道>`。plugins と attention.sounds は運ばない。
 * - 書き戻しは、jsonc と cli.json は鍵だけ差し替えて体裁を保ち、json は opencode が書くのと同じ 2 空白で整形し直す。
 *   書く前に `<hangar の置き場>/backups/opencode-config/<時刻>/` に控える。取れなければ書かない。
 * - MCP（`mcp.<名前>`、`opencode:mcp:`）はこの対象では運ばない。
 */
export const OPENCODE_TARGET_NAME = 'opencode';

const CONFIG_JSON = 'opencode.json';
const CONFIG_JSONC = 'opencode.jsonc';
const CLI_JSON = 'cli.json';
const KEEP_GENERATIONS = 20;

// ---- 読む ----

const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');
const toPosix = (p: string): string => p.split(path.sep).join('/');
const fileOf = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv']);

function readRegular(abs: string): { content: Buffer; mtime: number } | 'absent' | 'blocked' {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'blocked'; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_ITEM_BYTES) return 'blocked';
  try { return { content: fs.readFileSync(abs), mtime: Math.floor(st.mtimeMs) }; } catch { return 'blocked'; }
}

function walk(dir: string, onLink: (abs: string) => void, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onLink(dir); return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) { onLink(abs); continue; }
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(abs, onLink, out); } else out.push(abs);
  }
  return out;
}

/** 実行の印。plugins の下は全部 script、agents・commands・skills は Claude と同じ見方。 */
function marksOf(rel: string, content: Buffer): ConfigExecMark[] {
  const [top, ...rest] = rel.split('/');
  if (top === 'plugins' || top === 'plugin') return rest.length > 0 ? ['script'] : [];
  const mapped = top === 'agent' ? 'agents' : top === 'command' ? 'commands' : top === 'skill' ? 'skills' : null;
  return mapped && rest.length > 0 ? execMarksOf(`${mapped}/${rest.join('/')}`, content) : [];
}

/** 両方あるときの正は jsonc。 */
function configFileName(dir: string): string | null {
  for (const n of [CONFIG_JSONC, CONFIG_JSON]) { try { fs.lstatSync(path.join(dir, n)); return n; } catch { /* 無い */ } }
  return null;
}

/** opencode.json と opencode.jsonc が両方ある。opencode は両方読み jsonc を優先し、書くのは json なので、画面で知らせる。 */
export type OpencodeNotice = { code: 'both-json-jsonc' };
export function opencodeNotices(opencodeDir: string): OpencodeNotice[] {
  const has = (n: string): boolean => { try { fs.lstatSync(path.join(opencodeDir, n)); return true; } catch { return false; } };
  return has(CONFIG_JSON) && has(CONFIG_JSONC) ? [{ code: 'both-json-jsonc' }] : [];
}

/** 受け手の環境に無い `{env:X}` の X。opencode は無い変数を空文字にして黙って壊れるので、項目に添えて知らせる。 */
export function opencodeItemNotes(item: { id: string; content: Buffer }, env: NodeJS.ProcessEnv = process.env): { missingEnv: string[] } {
  if (!item.id.startsWith(OC_JSON_PREFIX) && !item.id.startsWith(OC_CLI_PREFIX)) return { missingEnv: [] };
  let v: unknown;
  try { v = JSON.parse(item.content.toString('utf8')); } catch { return { missingEnv: [] }; }
  return { missingEnv: envRefsOf(v).filter((x) => env[x] === undefined) };
}

function collectOpencode(ctx: TargetContext): Collected {
  const dir = ctx.opencodeDir;
  const out: Collected = { items: [], dropped: [], unsent: [], blocked: { ids: new Set(), prefixes: [] } };
  const blocked = out.blocked;
  const blockAll = (): void => { blocked.prefixes.push(OC_FILE_PREFIX, OC_JSON_PREFIX, OC_CLI_PREFIX); };
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') blockAll(); return out; }
  if (!st.isDirectory()) { blockAll(); return out; }

  const maxItems = ctx.maxItems ?? 5000;
  const items = new Map<string, LocalItem>();
  const add = (id: string, kind: ConfigItemKind, label: string, target: string, content: Buffer, marks: ConfigExecMark[], mtime: number | null): void => {
    if (items.has(id)) return;
    if (items.size >= maxItems) { blocked.ids.add(id); return; }
    const hash = sha256(content);
    let withheld: 'secret' | null = null;
    if (!content.includes(0)) {
      const found = findSecret(content.toString('utf8'));
      if (found) {
        const allowed = ctx.allowedUnsent.get(`secret:${id}`) === hash;
        out.unsent.push({ id: `secret:${id}`, kind: 'secret', itemId: id, label, reason: `secret:${found}`, contentSha256: hash, allowed } satisfies UnsentCandidate);
        if (!allowed) withheld = 'secret';
      }
    }
    items.set(id, { id, kind, label, sha256: hash, size: content.length, marks, content, mtime, target, withheld });
  };

  const blockRel = (rel: string): void => { blocked.ids.add(`${OC_FILE_PREFIX}${rel}`); blocked.prefixes.push(`${OC_FILE_PREFIX}${rel}/`); };
  const addFile = (rel: string, abs: string): void => {
    if (!isCarriedRel(rel)) return;
    const f = readRegular(abs);
    if (f === 'absent') return;
    if (f === 'blocked') { blocked.ids.add(`${OC_FILE_PREFIX}${rel}`); return; }
    add(`${OC_FILE_PREFIX}${rel}`, 'opencode-file', rel, rel, f.content, marksOf(rel, f.content), f.mtime);
  };
  addFile('AGENTS.md', path.join(dir, 'AGENTS.md'));
  for (const top of OC_DIRS) {
    let s: fs.Stats;
    try { s = fs.lstatSync(path.join(dir, top)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') blockRel(top); continue; }
    if (s.isSymbolicLink() || !s.isDirectory()) { blockRel(top); continue; }
    for (const abs of walk(path.join(dir, top), (link) => blockRel(toPosix(path.relative(dir, link)))).sort()) addFile(toPosix(path.relative(dir, abs)), abs);
  }

  /** 設定ファイルを読んで根のオブジェクトを返す。読めなければその前置を塞ぐ。 */
  const readRoot = (name: string | null, prefix: string): { root: Record<string, unknown>; mtime: number | null } | null => {
    if (name === null) return null;
    const f = readRegular(path.join(dir, name));
    if (f === 'absent') return null;
    if (f === 'blocked') { blocked.prefixes.push(prefix); return null; }
    let root: unknown;
    try { root = getJsonc(f.content.toString('utf8'), []); } catch { blocked.prefixes.push(prefix); return null; }
    if (root === undefined) return null;
    if (root === null || typeof root !== 'object' || Array.isArray(root)) { blocked.prefixes.push(prefix); return null; }
    return { root: root as Record<string, unknown>, mtime: f.mtime };
  };

  const main = readRoot(configFileName(dir), OC_JSON_PREFIX);
  if (main) {
    const sorted = sortOpencodeJson(main.root);
    for (const d of sorted.dropped) out.dropped.push({ key: d.key, reason: d.reason });
    for (const u of sorted.unknown) {
      const itemId = ocPathId(OC_JSON_PREFIX, u);
      out.unsent.push({ id: `unknown-key:${itemId}`, kind: 'unknown-key' as ConfigUnsentKind, itemId, label: u.join('.'), reason: 'unknown-key', contentSha256: sha256(itemId), allowed: false });
    }
    const emitted = new Set<string>();
    for (const it of sorted.items) {
      const id = ocPathId(OC_JSON_PREFIX, it.path);
      emitted.add(id);
      add(id, 'opencode-config', it.path.join('.'), `${CONFIG_JSON}#${id.slice(OC_JSON_PREFIX.length)}`, Buffer.from(canonicalJson(it.value)), [], main.mtime);
    }
    // 外を指す `{file:}` や絶対パスだけの instructions で運べなかった項目は、手元にあるので塞ぐ（相手の同名の項目で上書きしない）。
    for (const d of sorted.dropped) if (d.reason === 'path' && !emitted.has(d.key)) blocked.ids.add(d.key);
    for (const r of sorted.fileRefs) for (const rel of r.rels) addFile(rel, fileOf(dir, rel));
  }

  const cli = readRoot(CLI_JSON, OC_CLI_PREFIX);
  if (cli) {
    const sorted = sortOpencodeCli(cli.root);
    for (const d of sorted.dropped) out.dropped.push({ key: d.key, reason: d.reason });
    for (const it of sorted.items) {
      const id = ocPathId(OC_CLI_PREFIX, it.path);
      add(id, 'opencode-cli', it.path.join('.'), `${CLI_JSON}#${id.slice(OC_CLI_PREFIX.length)}`, Buffer.from(canonicalJson(it.value)), [], cli.mtime);
    }
  }

  out.items = [...items.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  out.unsent.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// ---- id ----

const isOwn = (id: string): boolean => id.startsWith(OC_FILE_PREFIX) || id.startsWith(OC_JSON_PREFIX) || id.startsWith(OC_CLI_PREFIX);

function parseOpencodeId(id: string): ParsedId | null {
  if (id.startsWith(OC_FILE_PREFIX)) {
    const rel = id.slice(OC_FILE_PREFIX.length);
    return isCarriedRel(rel) ? { kind: 'opencode-file', ref: { type: 'opencode-file', rel } } : null;
  }
  if (id.startsWith(OC_JSON_PREFIX)) {
    const segs = decodePathId(id.slice(OC_JSON_PREFIX.length));
    return segs && isCarriedJsonPath(segs) ? { kind: 'opencode-config', ref: { type: 'opencode-json', path: segs } } : null;
  }
  if (id.startsWith(OC_CLI_PREFIX)) {
    const segs = decodePathId(id.slice(OC_CLI_PREFIX.length));
    return segs && isCarriedCliPath(segs) ? { kind: 'opencode-cli', ref: { type: 'opencode-cli', path: segs } } : null;
  }
  return null;
}

// ---- 書く ----

type Prepared = { item: ConfigApplyOrderItemDto; plan: ApplyPlanItem; ref: ItemRef; content: Buffer | null; value: unknown };

const targetOfRef = (ref: ItemRef, id: string): string | null => {
  if (ref.type === 'opencode-file') return ref.rel;
  if (ref.type === 'opencode-json') return `${CONFIG_JSON}#${id.slice(OC_JSON_PREFIX.length)}`;
  if (ref.type === 'opencode-cli') return `${CLI_JSON}#${id.slice(OC_CLI_PREFIX.length)}`;
  return null;
};
const labelOfRef = (ref: ItemRef): string => (ref.type === 'opencode-file' ? ref.rel : ref.type === 'opencode-json' || ref.type === 'opencode-cli' ? ref.path.join('.') : '');

/** 指示書のうち opencode の項目を、inbox と突き合わせて書ける状態か確かめる。他の対象の項目は見ない。 */
function prepare(home: string): { createdAt: number; items: Prepared[] } {
  const order = readApplyOrder(home);
  if (!order) throw new ApplyError('no-order', '適用内容がありません。Hangar の設定で、適用する項目を選んでください。');
  const inbox = readInbox(home);
  const stale = (id: string): ApplyError => new ApplyError('stale', `適用内容の項目が、現在の受信内容と一致しません（${id}）。他の PC の設定が更新された可能性があります。Hangar の設定で、適用する項目を選び直してください。`);
  const seen = new Set<string>();
  const items: Prepared[] = [];
  for (const item of order.items) {
    if (!isOwn(item.id)) continue;
    const parsed = parseOpencodeId(item.id);
    if (!parsed || seen.has(item.id)) throw new ApplyError('broken-order', '適用内容が壊れています（項目が重なっているか、読めない項目があります）。Hangar の設定で、適用する項目を選び直してください。');
    seen.add(item.id);
    if (targetOfRef(parsed.ref, item.id) !== item.target) throw new ApplyError('unsafe', `適用内容の書き込み先が項目と一致しません（${item.id}）。書き込みません。`);
    const remoteGone = item.sha256 === '';
    if (item.take === 'mine' && item.op !== 'conflict') throw new ApplyError('broken-order', '適用内容が壊れています（競合でない項目でこの PC の内容を採用する指定があります）。');
    if (item.take === 'remote' && (item.op === 'delete') !== remoteGone && item.op !== 'conflict') throw new ApplyError('broken-order', '適用内容が壊れています（操作と指紋が合いません）。');
    const act: ApplyPlanItem['act'] = item.take === 'mine' ? 'keep' : remoteGone ? 'remove' : 'write';
    let marks: ConfigExecMark[] = [];
    let content: Buffer | null = null;
    let value: unknown;
    if (remoteGone) {
      if (inbox.some((e) => e.items.some((i) => i.id === item.id))) throw stale(item.id);
    } else {
      const holder = inbox.find((e) => e.deviceId === item.fromDeviceId);
      const mi = holder?.items.find((i) => i.id === item.id && i.sha256 === item.sha256);
      if (!mi) throw stale(item.id);
      marks = mi.marks;
      if (act === 'write') {
        const blob = readInboxBlob(home, item.fromDeviceId, item.sha256);
        if (!blob || sha256(blob) !== item.sha256) throw stale(item.id);
        content = blob;
        if (parsed.ref.type !== 'opencode-file') {
          try { value = JSON.parse(blob.toString('utf8')); } catch { throw new ApplyError('bad-content', `届いた設定の値が読めません（${item.id}）。`); }
          if (parsed.ref.type === 'opencode-json' && !jsonValueFits(parsed.ref.path, value)) throw new ApplyError('bad-content', `届いた設定の値が、その鍵の型に合いません（${item.id}）。`);
          if (parsed.ref.type === 'opencode-json' && isMachineBoundValue(parsed.ref.path, value)) throw new ApplyError('bad-content', `届いた設定の値が、この PC では使えない場所を指しています（${item.id}）。`);
        }
      }
    }
    items.push({ item, plan: { id: item.id, kind: parsed.kind, op: item.op, take: item.take, label: labelOfRef(parsed.ref), marks, act }, ref: parsed.ref, content, value });
  }
  return { createdAt: order.createdAt, items };
}

/** 絶対パスの instructions の要素、入れ物の外を指す `{file:}` を持つ値。 */
function isMachineBoundValue(segs: readonly string[], v: unknown): boolean {
  if (segs.length === 1 && segs[0] === 'instructions' && Array.isArray(v) && v.some((e) => typeof e === 'string' && isAbsolutePathLike(e))) return true;
  return fileRefsOf(v).some((p) => fileRefRel(p) === null);
}

export function planOpencodeWrite(o: { home: string }): ApplyPlan {
  const { createdAt, items } = prepare(o.home);
  if (items.length === 0) throw new ApplyError('no-order', '適用内容に opencode の項目がありません。');
  const counts = { create: 0, overwrite: 0, delete: 0, conflictRemote: 0, conflictMine: 0 };
  const byKind: Partial<Record<ConfigItemKind, number>> = {};
  const plans = items.map((p) => p.plan);
  for (const p of plans) {
    if (p.op === 'conflict') counts[p.take === 'mine' ? 'conflictMine' : 'conflictRemote']++;
    else counts[p.op]++;
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  }
  const writes = plans.filter((p) => p.act === 'write');
  const execFile = (p: ApplyPlanItem): boolean => p.kind === 'opencode-file' && isExecRel(p.label);
  return { createdAt, items: plans, counts, byKind, instructions: writes.filter(execFile).length, exec: writes.filter((p) => p.marks.length > 0) };
}

type FileOp = { rel: string; remove: boolean; data: Buffer | string | null };

/** dir の下の相対パスが、書いてよい場所か（途中にリンクが無く、末尾が通常のファイル）。 */
function assertSafeTarget(dir: string, rel: string): void {
  const segs = rel.split('/');
  let cur = dir;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]!);
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new ApplyError('unsafe', `書き込み先を調べられません（${rel}）。書きません。`);
    }
    if (st.isSymbolicLink()) throw new ApplyError('unsafe', `書き込み先の途中にシンボリックリンクがあります（${rel}）。リンクの先へは書きません。`);
    if (i === segs.length - 1 ? !st.isFile() : !st.isDirectory()) throw new ApplyError('unsafe', `書き込み先が通常のファイルまたはディレクトリではありません（${rel}）。書きません。`);
  }
}

type KeyEdit = { path: string[]; value: unknown; remove: boolean };

/** 設定ファイルの文字列に、鍵ごとの編集を当てる。jsonc は体裁を保ち、json は 2 空白で整形し直す。 */
function editConfig(text: string | null, edits: KeyEdit[], jsonc: boolean, name: string): string {
  const set = jsonc ? setJsonc : setJson;
  const del = jsonc ? removeJsonc : removeJson;
  let cur = text ?? '';
  try {
    for (const e of edits) {
      const p = e.path;
      if (e.path.length === 1 && e.path[0] === 'instructions') {
        // 手元の絶対パスの要素は他の PC に運ばれていない。届いた値で消さずに残す。
        const local = getIn(getJsonc(cur, []), p);
        const keep = Array.isArray(local) ? local.filter((x): x is string => typeof x === 'string' && isAbsolutePathLike(x)) : [];
        const incoming = e.remove ? [] : (e.value as string[]);
        const merged = [...incoming, ...keep.filter((x) => !incoming.includes(x))];
        cur = merged.length === 0 ? del(cur, p) : set(cur, p, merged);
        continue;
      }
      cur = e.remove ? del(cur, p) : set(cur, p, e.value);
      // agent の項目を全部消して空になった表は残さない。
      if (e.remove && p.length === 3) {
        const parent = getIn(getJsonc(cur, []), p.slice(0, 2));
        if (parent && typeof parent === 'object' && !Array.isArray(parent) && Object.keys(parent).length === 0) cur = del(cur, p.slice(0, 2));
      }
    }
  } catch (e) {
    if (e instanceof ConfigEditError) throw new ApplyError(e.code === 'parse' || e.code === 'unsupported' ? 'settings-unreadable' : 'write-failed', `${name} を読めない、または書けないので、設定の鍵は書きません（${e.message}）。`);
    throw e;
  }
  return cur;
}

function buildOps(dir: string, items: Prepared[], readOver?: PlanReader): FileOp[] {
  const ops: FileOp[] = [];
  const json: KeyEdit[] = [];
  const cli: KeyEdit[] = [];
  for (const p of items) {
    if (p.plan.act === 'keep') continue;
    const remove = p.plan.act === 'remove';
    if (p.ref.type === 'opencode-file') ops.push({ rel: p.ref.rel, remove, data: p.content });
    else if (p.ref.type === 'opencode-json') json.push({ path: p.ref.path, value: p.value, remove });
    else if (p.ref.type === 'opencode-cli') cli.push({ path: p.ref.path, value: p.value, remove });
  }
  for (const op of ops) assertSafeTarget(dir, op.rel);
  const read = (name: string): string | null => {
    assertSafeTarget(dir, name);
    if (readOver) return readOver(path.join(dir, name))?.toString('utf8') ?? null;
    try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ApplyError('settings-unreadable', `${name} を読めないので、設定の鍵は書きません。`); return null; }
  };
  if (json.length > 0) {
    // 両方あるときは、opencode が勝たせる jsonc に書く。無ければ opencode が新規に作るのと同じ opencode.json。
    const name = configFileName(dir) ?? CONFIG_JSON;
    ops.push({ rel: name, remove: false, data: editConfig(read(name), json, name === CONFIG_JSONC, name) });
  }
  if (cli.length > 0) ops.push({ rel: CLI_JSON, remove: false, data: editConfig(read(CLI_JSON), cli, true, CLI_JSON) });
  return ops;
}

// ---- 控えと書き込み ----

function writeAtomic(file: string, data: Buffer | string, mode: number): void {
  const tmp = `${file}.hangar-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(tmp, data, { mode }); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

const backupDir = (home: string): string => path.join(backupsRoot(home), 'opencode-config');

/** 書く先の元の中身を新しい世代に控える。控えを作れなければ ApplyError で、何も書かない。 */
function takeGeneration(o: { home: string; dir: string; rels: string[]; baseIds: string[]; base: ConfigBase; now: number }): { name: string; dir: string; created: string[]; createdDirs: string[] } {
  const root = backupDir(o.home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let ts = o.now;
  let name = stampLabel(ts);
  for (let tries = 0; ; tries++) {
    try { fs.mkdirSync(path.join(root, name), { mode: 0o700 }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 3600) throw e;
      ts += 1000;
      name = stampLabel(ts);
    }
  }
  const gdir = path.join(root, name);
  try {
    const created: string[] = [];
    const createdDirs = new Set<string>();
    for (const rel of o.rels) {
      const segs = rel.split('/');
      for (let i = 1; i < segs.length; i++) { const d = segs.slice(0, i).join('/'); if (!fs.existsSync(fileOf(o.dir, d))) createdDirs.add(d); }
      const src = fileOf(o.dir, rel);
      if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(fileOf(gdir, rel)), { recursive: true }); fs.copyFileSync(src, fileOf(gdir, rel)); } else created.push(rel);
    }
    const prev = o.base.all();
    const meta = { version: 1, kind: 'apply', createdAt: o.now, created, createdDirs: [...createdDirs], base: Object.fromEntries(o.baseIds.map((id) => [id, prev.get(id) ?? null])) };
    fs.writeFileSync(path.join(gdir, GENERATION_META), JSON.stringify(meta) + '\n', { mode: 0o600 });
    return { name, dir: gdir, created, createdDirs: [...createdDirs] };
  } catch (e) {
    fs.rmSync(gdir, { recursive: true, force: true });
    throw new ApplyError('write-failed', `控えの世代を作れませんでした（${errText(e)}）。何も書いていません。`);
  }
}

/** 失敗したとき、控えから元へ戻す。戻せなければ世代を残して手掛かりを返す。 */
function rollback(dir: string, gen: { name: string; dir: string; created: string[]; createdDirs: string[]; rels: string[] }, cause: unknown): ApplyError {
  try {
    for (const rel of gen.rels) {
      const saved = fileOf(gen.dir, rel);
      if (fs.existsSync(saved)) { const dest = fileOf(dir, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(saved, dest); }
    }
    for (const rel of gen.created) fs.rmSync(fileOf(dir, rel), { force: true });
    for (const d of [...gen.createdDirs].sort((a, b) => b.split('/').length - a.split('/').length)) { try { fs.rmdirSync(fileOf(dir, d)); } catch { /* 空でなければ残す */ } }
    fs.rmSync(gen.dir, { recursive: true, force: true });
    return new ApplyError('write-failed', `書き込みに失敗したので、元の状態へ戻しました（${errText(cause)}）。`);
  } catch (e2) {
    return new ApplyError('write-failed', `書き込みに失敗し（${errText(cause)}）、元へ戻す途中でも失敗しました（${errText(e2)}）。控えの世代 ${gen.name} は ${gen.dir} に残してあります。`);
  }
}

function pruneGenerations(home: string): void {
  const root = backupDir(home);
  let names: string[];
  try { names = fs.readdirSync(root).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort(); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - KEEP_GENERATIONS))) { try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch { /* 次の機会に回す */ } }
}

function updateBase(db: ApplyOptions['db'], items: Prepared[], now: number): void {
  const base = new ConfigBase(db);
  db.transaction(() => {
    for (const p of items) {
      if (p.item.sha256 !== '' && p.plan.act !== 'remove') base.set(p.item.id, p.item.sha256, now);
      else base.remove(p.item.id);
    }
  })();
}

/**
 * 指示書のうち opencode の項目を、入れ物へ書く。控えを取れなければ書かない。失敗したら元へ戻す。
 * 指示書そのものは消さない（他の対象の項目が残るので、消すのは呼び出し側）。
 */
export function writeOpencode(o: ApplyOptions): ApplyResult {
  const dir = OPENCODE_STORE.root(o);
  const now = o.now ? o.now() : Date.now();
  const { items } = prepare(o.home);
  const ops = buildOps(dir, items);
  const keptMine = items.filter((p) => p.plan.act === 'keep').length;
  const result = (generation: string | null): ApplyResult => ({
    generation, keptMine, written: ops.filter((op) => !op.remove).length, removed: ops.filter((op) => op.remove).length, files: ops.map((op) => op.rel),
  });
  if (ops.length === 0) {
    try { updateBase(o.db, items, now); } catch (e) { throw new ApplyError('write-failed', `基準の更新に失敗しました（${errText(e)}）。`); }
    return result(null);
  }
  const rels = ops.map((op) => op.rel);
  const gen = takeGeneration({ home: o.home, dir, rels, baseIds: items.map((p) => p.item.id), base: new ConfigBase(o.db), now });
  try {
    ops.forEach((op, i) => {
      o.onWrite?.(op.rel, i);
      const dest = fileOf(dir, op.rel);
      if (op.remove) { fs.rmSync(dest, { force: true }); return; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let mode = op.rel === CONFIG_JSON || op.rel === CONFIG_JSONC || op.rel === CLI_JSON ? 0o600 : 0o644;
      try { mode = fs.statSync(dest).mode & 0o777; } catch { /* 新しいファイル */ }
      writeAtomic(dest, op.data as Buffer | string, mode);
    });
    updateBase(o.db, items, now);
  } catch (e) {
    throw rollback(dir, { ...gen, rels }, e);
  }
  pruneGenerations(o.home);
  return result(gen.name);
}

/** 書く先ごとの、書いた後の中身（承諾の窓の差分と指紋）。何も書かない。 */
export function planOpencodeOps(o: WritePaths, read?: PlanReader): PlannedOp[] {
  const dir = OPENCODE_STORE.root(o);
  const { items } = prepare(o.home);
  return buildOps(dir, items, read).map((op) => ({ rel: op.rel, path: fileOf(dir, op.rel), after: op.remove ? null : op.data }));
}

// ---- 対象 ----

/** 権限に関わる鍵は、消去も承諾に掛ける（拒否を外して権限を広げうる）。 */
function needsApprovalOf(item: { id: string; kind: ConfigItemKind; op: string }, approval: string): boolean {
  if (approval !== 'each') return false;
  const parsed = parseOpencodeId(item.id);
  if (!parsed) return false;
  if (parsed.ref.type === 'opencode-file') return item.op !== 'delete' && isExecRel(parsed.ref.rel);
  if (parsed.ref.type === 'opencode-json') return isPermissionPath(parsed.ref.path);
  return false;
}

export const opencodeTarget: ConfigTarget = {
  name: OPENCODE_TARGET_NAME,
  owns: isOwn,
  parseId: parseOpencodeId,
  // 設定の opencodeEnabled（その PC で opencode を使っているか）と、対象ごとの入切の両方が要る。
  enabled: (ctx) => ctx.opencodeEnabled && ctx.switches?.['opencode'] === true,
  collect: collectOpencode,
  planWrite: (o: { home: string }) => planOpencodeWrite(o),
  write: (o: ApplyOptions) => writeOpencode(o),
  planOps: (o, read) => planOpencodeOps(o, read),
  store: OPENCODE_STORE,
  needsApproval: needsApprovalOf,
  isMachineBound: (item) => {
    const parsed = parseOpencodeId(item.id);
    if (!parsed || parsed.ref.type !== 'opencode-json') return false;
    try { return isMachineBoundValue(parsed.ref.path, JSON.parse(item.content.toString('utf8'))); } catch { return false; }
  },
};
