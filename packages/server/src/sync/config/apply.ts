import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSafeRelPath, type ConfigApplyOrderItemDto, type ConfigExecMark, type ConfigInboxOp, type ConfigItemKind } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { deleteApplyOrder, readApplyOrder } from './applyOrder.ts';
import { GENERATION_META, STAMP_RE, stampLabel } from './backups.ts';
import { ConfigBase } from './base.ts';
import { parseItemId, type ItemRef } from './ids.ts';
import { readInbox, readInboxBlob } from './inbox.ts';
import { applyOrderPath, configBackupsDir } from './paths.ts';
import { isAbsolutePathRule, valueFits } from './settingsSort.ts';

/**
 * 設定の同期の「適用」と「世代へ戻す」。`~/.claude` に書く唯一の場所である（全体計画の D9）。
 * 呼ぶのは、CLI の hangar config apply と hangar config restore、および殻の命令（どちらも同じこの処理を走らせる）だけで、サーバは呼ばない。
 *
 * 適用の流れ：
 * 1. 指示書（sync/config/applyOrder.ts）を読み、inbox（他の PC の束を開いた写し）と突き合わせて、全項目が書ける状態かを先に確かめる。
 *    1 つでも合わなければ何も書かずに断る（束が更新されて指示書が古くなったとき、書き込み先が id と合わないとき、リンクや通常でないファイルが途中にあるとき）。
 * 2. 書き込む先の元の中身を、世代（`<hangar の置き場>/backups/claude-config/<時刻>/`）に控える。新しく作る先の印も世代の記録に残す。
 * 3. 書く（一時ファイルに書いて rename）。途中で失敗したら、世代から元へ戻し、世代は消し、指示書は残す。
 * 4. 基準（config_base）を更新する。ここで失敗しても、書いたファイルを元へ戻す。
 * 5. 指示書を消す。古い世代は 20 個までに保つ。
 *
 * 運ばれてきた項目に実行の許可は付けない（旧実装は降りたスクリプトに付けていたが、他の PC からの実行経路になる）。
 * 手元の絶対パスの権限の規則は、届いた規則で消さずに残す（その規則は他の PC に運ばれないので、届いた側には元から無い）。
 */

export type ApplyErrorCode =
  | 'no-order' | 'broken-order' | 'stale' | 'unsafe' | 'bad-content' | 'settings-unreadable' | 'write-failed'
  | 'bad-name' | 'no-generation';

/** 利用者に見せる失敗。message は日本語の 1 文で、そのまま端末や殻のダイアログに出す。 */
export class ApplyError extends Error {
  constructor(readonly code: ApplyErrorCode, message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

const KEEP_GENERATIONS = 20;
const INSTRUCTION_KINDS = new Set<ConfigItemKind>(['skills', 'commands', 'agents']);
const PERMISSION_LISTS = new Set(['allow', 'ask', 'deny']);

export type ApplyAct = 'write' | 'remove' | 'keep';

export type ApplyPlanItem = {
  id: string;
  kind: ConfigItemKind;
  op: ConfigInboxOp;
  take: 'remote' | 'mine';
  /** 画面に出す名前。ファイルは設定の入れ物からの相対パス、settings は鍵、メモリは memory/ の下のパス。 */
  label: string;
  marks: ConfigExecMark[];
  /** write は中身を書く、remove は消す、keep は手元を残す（競合で自分を採る）。 */
  act: ApplyAct;
};

export type ApplyPlan = {
  createdAt: number;
  items: ApplyPlanItem[];
  counts: { create: number; overwrite: number; delete: number; conflictRemote: number; conflictMine: number };
  byKind: Partial<Record<ConfigItemKind, number>>;
  /** 書き込む skills、commands、agents の数。Claude が読んで実行する指示なので、確認で他と分けて見せる。 */
  instructions: number;
  /** 書き込む項目のうち、フック、コマンド実行、スクリプトの印のあるもの。 */
  exec: ApplyPlanItem[];
};

type Prepared = { item: ConfigApplyOrderItemDto; plan: ApplyPlanItem; ref: ItemRef; content: Buffer | null; value: unknown };

// ---- 指示書と inbox の突き合わせ ----

function loadOrder(home: string) {
  const order = readApplyOrder(home);
  if (order && order.items.length > 0) return order;
  if (order || !fs.existsSync(applyOrderPath(home))) throw new ApplyError('no-order', '適用の指示書がありません。Hangar の設定で、適用する項目を選んでください。');
  throw new ApplyError('broken-order', '適用の指示書が壊れているか、読めない形です。Hangar の設定で、適用する項目を選び直してください。');
}

/** 指示書の書き込み先が、id から決まる場所と同じか。違えば、指示書は信用しない。 */
function targetMatches(ref: ItemRef, target: string): boolean {
  if (ref.type === 'file') return target === ref.rel;
  if (ref.type === 'settings') return target === `settings.json#${ref.key}`;
  const m = /^projects\/[A-Za-z0-9-]+\/memory\/(.+)$/.exec(target);
  return !!m && isSafeRelPath(target) && m[1] === ref.rel;
}

const labelOf = (ref: ItemRef): string => (ref.type === 'file' ? ref.rel : ref.type === 'settings' ? ref.key : `memory/${ref.rel}`);

function contentFits(key: string, v: unknown): boolean {
  if (key.startsWith('permissions.')) {
    const sub = key.slice('permissions.'.length);
    if (PERMISSION_LISTS.has(sub)) return Array.isArray(v) && v.every((r) => typeof r === 'string');
    return typeof v === 'string';
  }
  return valueFits(key, v);
}

function prepare(home: string): { createdAt: number; items: Prepared[] } {
  const order = loadOrder(home);
  const inbox = readInbox(home);
  const stale = (id: string): ApplyError => new ApplyError('stale', `指示書の項目が、いまの受信の内容と合いません（${id}）。他の PC の設定が更新された可能性があります。Hangar の設定で、適用する項目を選び直してください。`);
  const seen = new Set<string>();
  const items: Prepared[] = [];
  for (const item of order.items) {
    const parsed = parseItemId(item.id);
    if (!parsed || seen.has(item.id)) throw new ApplyError('broken-order', '適用の指示書が壊れています（項目が重なっています）。Hangar の設定で、適用する項目を選び直してください。');
    seen.add(item.id);
    if (!targetMatches(parsed.ref, item.target)) throw new ApplyError('unsafe', `指示書の書き込み先が項目と合いません（${item.id}）。書きません。`);
    const remoteGone = item.sha256 === '';
    if (item.take === 'mine' && item.op !== 'conflict') throw new ApplyError('broken-order', '適用の指示書が壊れています（競合でない項目で手元を採る指定があります）。');
    if (item.take === 'remote' && (item.op === 'delete') !== remoteGone && item.op !== 'conflict') throw new ApplyError('broken-order', '適用の指示書が壊れています（操作と指紋が合いません）。');
    const act: ApplyAct = item.take === 'mine' ? 'keep' : remoteGone ? 'remove' : 'write';
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
        if (!blob || crypto.createHash('sha256').update(blob).digest('hex') !== item.sha256) throw stale(item.id);
        content = blob;
        if (parsed.ref.type === 'settings') {
          try { value = JSON.parse(blob.toString('utf8')); } catch { throw new ApplyError('bad-content', `届いた設定の値が読めません（${item.id}）。`); }
          if (!contentFits(parsed.ref.key, value)) throw new ApplyError('bad-content', `届いた設定の値が、その鍵の型に合いません（${item.id}）。`);
        }
      }
    }
    const plan: ApplyPlanItem = { id: item.id, kind: parsed.kind, op: item.op, take: item.take, label: labelOf(parsed.ref), marks, act };
    items.push({ item, plan, ref: parsed.ref, content, value });
  }
  return { createdAt: order.createdAt, items };
}

/** 確認に出す見立て。何も書かない。指示書が適用できる状態でなければ ApplyError。 */
export function planApply(o: { home: string }): ApplyPlan {
  const { createdAt, items } = prepare(o.home);
  const counts = { create: 0, overwrite: 0, delete: 0, conflictRemote: 0, conflictMine: 0 };
  const byKind: Partial<Record<ConfigItemKind, number>> = {};
  const plans = items.map((p) => p.plan);
  for (const p of plans) {
    if (p.op === 'conflict') counts[p.take === 'mine' ? 'conflictMine' : 'conflictRemote']++;
    else counts[p.op]++;
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  }
  const writes = plans.filter((p) => p.act === 'write');
  return {
    createdAt, items: plans, counts, byKind,
    instructions: writes.filter((p) => INSTRUCTION_KINDS.has(p.kind)).length,
    exec: writes.filter((p) => p.marks.length > 0),
  };
}

// ---- 書き込み先の安全 ----

/**
 * claudeDir の下の相対パスが、書いてよい場所か。途中にリンクがある、途中が通常のディレクトリでない、
 * 末尾が通常のファイルでない、のどれかなら ApplyError。まだ無い部分は、あってよい。
 * claudeDir 自体がリンクであることは構わない（会社と大学で入れ物を切り替える使い方がある）。
 */
function assertSafeTarget(claudeDir: string, rel: string): void {
  if (!isSafeRelPath(rel)) throw new ApplyError('unsafe', `書き込み先の形が不正です（${rel}）。書きません。`);
  const segs = rel.split('/');
  let cur = claudeDir;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]!);
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new ApplyError('unsafe', `書き込み先を調べられません（${rel}）。書きません。`);
    }
    if (st.isSymbolicLink()) throw new ApplyError('unsafe', `書き込み先の途中にシンボリックリンクがあります（${rel}）。リンクの先へは書きません。`);
    const last = i === segs.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) throw new ApplyError('unsafe', `書き込み先が通常のファイルまたはディレクトリではありません（${rel}）。書きません。`);
  }
}

// ---- 世代 ----

type GenerationMeta = {
  version: 1;
  kind: 'apply' | 'restore';
  createdAt: number;
  /** この世代を取った時点で無かった先。戻すときに消す。 */
  created: string[];
  /** この世代を取った時点で無かったディレクトリ。戻すとき、空なら消す。 */
  createdDirs: string[];
  /** この世代を取った時点の基準（項目の id から指紋。行が無かったものは null）。 */
  base: Record<string, string | null>;
};

const isMeta = (v: unknown): v is GenerationMeta => {
  const m = v as Partial<GenerationMeta> | null;
  const strs = (a: unknown): boolean => Array.isArray(a) && a.every((x) => typeof x === 'string');
  return !!m && m.version === 1 && strs(m.created) && strs(m.createdDirs) && !!m.base && typeof m.base === 'object' && Object.values(m.base).every((x) => x === null || typeof x === 'string');
};

function readMeta(dir: string): GenerationMeta | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(dir, GENERATION_META), 'utf8'));
    return isMeta(v) ? v : null;
  } catch { return null; }
}

const fileOf = (root: string, rel: string): string => path.join(root, ...rel.split('/'));

function writeAtomic(file: string, data: Buffer | string, mode: number): void {
  const tmp = `${file}.hangar-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** 先の元の中身を新しい世代に控える。控えるものが無くても、作った印のために世代は作る。 */
function takeGeneration(o: { home: string; claudeDir: string; rels: string[]; baseIds: string[]; base: ConfigBase | null; now: number; kind: GenerationMeta['kind'] }): { name: string; dir: string } {
  const root = configBackupsDir(o.home);
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
  const dir = path.join(root, name);
  try {
    const created: string[] = [];
    const createdDirs = new Set<string>();
    for (const rel of o.rels) {
      const src = fileOf(o.claudeDir, rel);
      const segs = rel.split('/');
      for (let i = 1; i < segs.length; i++) {
        const d = segs.slice(0, i).join('/');
        if (!fs.existsSync(fileOf(o.claudeDir, d))) createdDirs.add(d);
      }
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(fileOf(dir, rel)), { recursive: true });
        fs.copyFileSync(src, fileOf(dir, rel));
      } else created.push(rel);
    }
    const prev = o.base ? o.base.all() : new Map<string, string>();
    const meta: GenerationMeta = { version: 1, kind: o.kind, createdAt: o.now, created, createdDirs: [...createdDirs], base: Object.fromEntries(o.baseIds.map((id) => [id, prev.get(id) ?? null])) };
    fs.writeFileSync(path.join(dir, GENERATION_META), JSON.stringify(meta) + '\n', { mode: 0o600 });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new ApplyError('write-failed', `控えの世代を作れませんでした（${errText(e)}）。何も書いていません。`);
  }
  return { name, dir };
}

/** 世代の中のファイルの相対パス（記録は含まない）。リンクは読まない。 */
function generationFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (!(rel === '' && e.name === GENERATION_META)) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** 世代の中身を claudeDir へ戻し、世代の取った時点で無かった先と、そのときのディレクトリを消す。 */
function putBack(claudeDir: string, dir: string, files: string[], meta: GenerationMeta | null): void {
  for (const rel of files) {
    const dest = fileOf(claudeDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.hangar-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try { fs.copyFileSync(fileOf(dir, rel), tmp); fs.renameSync(tmp, dest); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }
  if (!meta) return;
  for (const rel of meta.created) fs.rmSync(fileOf(claudeDir, rel), { force: true });
  for (const d of [...meta.createdDirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    try { fs.rmdirSync(fileOf(claudeDir, d)); } catch { /* 空でなければ、利用者の物が入っているので残す */ }
  }
}

/** 古い世代を消して、新しい 20 個に保つ。時刻の名前でないもの（removed など）は触らない。 */
function pruneGenerations(home: string): void {
  const root = configBackupsDir(home);
  let names: string[];
  try { names = fs.readdirSync(root).filter((n) => STAMP_RE.test(n)).sort(); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - KEEP_GENERATIONS))) {
    try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch { /* 消せなくても控えは残る。次の機会に回す */ }
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 世代へ戻す途中の失敗を、世代から元へ戻す。戻せなければ、世代を残して手で戻す手掛かりを返す。 */
function rollback(claudeDir: string, gen: { name: string; dir: string }, cause: unknown, what: string): ApplyError {
  try {
    putBack(claudeDir, gen.dir, generationFiles(gen.dir), readMeta(gen.dir));
    fs.rmSync(gen.dir, { recursive: true, force: true });
    return new ApplyError('write-failed', `${what}に失敗したので、元の状態へ戻しました（${errText(cause)}）。`);
  } catch (e2) {
    return new ApplyError('write-failed', `${what}に失敗し（${errText(cause)}）、元へ戻す途中でも失敗しました（${errText(e2)}）。控えの世代 ${gen.name} から、hangar config restore ${gen.name} で戻してください。`);
  }
}

// ---- settings.json ----

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

type SettingsEdit = { key: string; value: unknown; remove: boolean };

/** settings.json の文字列に、鍵ごとの編集を当てる。並びと字下げと末尾の改行は保つ。 */
function editSettings(text: string | null, edits: SettingsEdit[]): string {
  const unreadable = (why: string): ApplyError => new ApplyError('settings-unreadable', `settings.json を読めないので、設定の鍵は書きません（${why}）。`);
  let obj: Record<string, unknown> = {};
  if (text !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw unreadable('JSON として読めません'); }
    if (!isObject(parsed)) throw unreadable('中身がオブジェクトではありません');
    obj = parsed;
  }
  for (const e of edits) {
    if (!e.key.startsWith('permissions.')) {
      if (e.remove) delete obj[e.key]; else obj[e.key] = e.value;
      continue;
    }
    const sub = e.key.slice('permissions.'.length);
    if (obj.permissions !== undefined && !isObject(obj.permissions)) throw unreadable('permissions がオブジェクトではありません');
    const perms = (obj.permissions as Record<string, unknown> | undefined) ?? {};
    if (PERMISSION_LISTS.has(sub)) {
      // 手元の絶対パスの規則は、他の PC には運ばれていない。届いた規則で消さずに残す。
      const local = Array.isArray(perms[sub]) ? (perms[sub] as unknown[]).filter((r): r is string => typeof r === 'string' && isAbsolutePathRule(r)) : [];
      const incoming = e.remove ? [] : (e.value as string[]);
      const merged = [...incoming, ...local.filter((r) => !incoming.includes(r))];
      if (merged.length === 0 && e.remove) delete perms[sub]; else perms[sub] = merged;
    } else if (e.remove) delete perms[sub];
    else perms[sub] = e.value;
    obj.permissions = perms;
  }
  const indent = text === null ? '  ' : (/^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ');
  const newline = text === null || text.endsWith('\n');
  return JSON.stringify(obj, null, indent) + (newline ? '\n' : '');
}

// ---- 適用 ----

type FileOp = { rel: string; remove: boolean; data: Buffer | string | null };

export type ApplyResult = {
  /** 控えた世代の名前。書くものが無かった（手元を残すだけの）ときは null。 */
  generation: string | null;
  written: number;
  removed: number;
  keptMine: number;
  /** 書いた、または消した先（設定の入れ物からの相対パス）。 */
  files: string[];
};

type ApplyOptions = {
  home: string;
  claudeDir: string;
  db: Db;
  now?: () => number;
  /** 試験が書き込みの途中の失敗を起こすための口。ファイルへ触る前に、何番目の操作かを渡す。 */
  onWrite?: (rel: string, index: number) => void;
};

function updateBase(db: Db, items: Prepared[], now: number): void {
  const base = new ConfigBase(db);
  db.transaction(() => {
    for (const p of items) {
      // 書いた項目は、手元と相手が同じになった。消した項目と、競合で相手が消していた手元を残す項目は、行を消す（手元だけの項目になる）。
      // 競合で手元を採る項目は、基準を相手の指紋に合わせる。手元が相手と前回の共通より新しいことになり、次の同期で手元が送られる。
      if (p.item.sha256 !== '' && p.plan.act !== 'remove') base.set(p.item.id, p.item.sha256, now);
      else base.remove(p.item.id);
    }
  })();
}

/** 指示書のとおりに `~/.claude` へ書く。失敗したら元へ戻し、指示書は残して ApplyError を投げる。 */
export function runApply(o: ApplyOptions): ApplyResult {
  const now = o.now ? o.now() : Date.now();
  const { items } = prepare(o.home);
  const ops: FileOp[] = [];
  const settings: SettingsEdit[] = [];
  for (const p of items) {
    if (p.plan.act === 'keep') continue;
    if (p.ref.type === 'settings') { settings.push({ key: p.ref.key, value: p.value, remove: p.plan.act === 'remove' }); continue; }
    ops.push({ rel: p.item.target, remove: p.plan.act === 'remove', data: p.content });
  }
  for (const op of ops) assertSafeTarget(o.claudeDir, op.rel);
  if (settings.length > 0) {
    assertSafeTarget(o.claudeDir, 'settings.json');
    let text: string | null = null;
    try { text = fs.readFileSync(fileOf(o.claudeDir, 'settings.json'), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ApplyError('settings-unreadable', 'settings.json を読めないので、設定の鍵は書きません。'); }
    ops.push({ rel: 'settings.json', remove: false, data: editSettings(text, settings) });
  }
  const keptMine = items.filter((p) => p.plan.act === 'keep').length;
  const done = (generation: string | null): ApplyResult => ({
    generation, keptMine,
    written: ops.filter((op) => !op.remove).length, removed: ops.filter((op) => op.remove).length,
    files: ops.map((op) => op.rel),
  });

  if (ops.length === 0) {
    try { updateBase(o.db, items, now); } catch (e) { throw new ApplyError('write-failed', `基準の更新に失敗しました（${errText(e)}）。指示書は残しています。`); }
    deleteApplyOrder(o.home);
    return done(null);
  }

  const gen = takeGeneration({ home: o.home, claudeDir: o.claudeDir, rels: ops.map((op) => op.rel), baseIds: items.map((p) => p.item.id), base: new ConfigBase(o.db), now, kind: 'apply' });
  try {
    ops.forEach((op, i) => {
      o.onWrite?.(op.rel, i);
      const dest = fileOf(o.claudeDir, op.rel);
      if (op.remove) { fs.rmSync(dest, { force: true }); return; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // 権限は手元のものを保つ。新しいファイルは、settings.json だけ自分専用にする。実行の許可は付けない。
      let mode = op.rel === 'settings.json' ? 0o600 : 0o644;
      try { mode = fs.statSync(dest).mode & 0o777; } catch { /* 新しいファイル */ }
      writeAtomic(dest, op.data as Buffer | string, mode);
    });
    updateBase(o.db, items, now);
  } catch (e) {
    throw rollback(o.claudeDir, gen, e, '書き込み');
  }
  deleteApplyOrder(o.home);
  pruneGenerations(o.home);
  return done(gen.name);
}

// ---- 世代へ戻す ----

export type RestorePlan = {
  name: string;
  /** 世代の中身を書き戻す先。 */
  restore: string[];
  /** その世代の時点で無かった先。あれば消す。 */
  remove: string[];
};

function openGeneration(home: string, name: string): { dir: string; meta: GenerationMeta | null; files: string[] } {
  if (!STAMP_RE.test(name)) throw new ApplyError('bad-name', `世代の名前が正しくありません（${name}）。hangar config restore で一覧を見てください。`);
  const dir = path.join(configBackupsDir(home), name);
  let isDir = false;
  try { isDir = fs.lstatSync(dir).isDirectory(); } catch { /* 無い */ }
  if (!isDir) throw new ApplyError('no-generation', `その世代がありません（${name}）。hangar config restore で一覧を見てください。`);
  return { dir, meta: readMeta(dir), files: generationFiles(dir) };
}

export function planRestore(o: { home: string; claudeDir: string; name: string }): RestorePlan {
  const g = openGeneration(o.home, o.name);
  const remove = (g.meta?.created ?? []).filter((rel) => fs.existsSync(fileOf(o.claudeDir, rel)));
  for (const rel of [...g.files, ...remove]) assertSafeTarget(o.claudeDir, rel);
  return { name: o.name, restore: g.files, remove };
}

export type RestoreResult = {
  restored: string[];
  removed: string[];
  /** 戻す前の状態を控えた世代。これを戻せば、戻しを取り消せる。 */
  safety: string;
  /** 基準を、適用の前の値へ戻したか。DB を渡さなかったとき、記録の無い古い世代のときは false。 */
  baseReverted: boolean;
};

/** 世代の中身へ戻す。戻す前の状態を、新しい世代として控える。 */
export function runRestore(o: { home: string; claudeDir: string; name: string; db?: Db; now?: () => number }): RestoreResult {
  const now = o.now ? o.now() : Date.now();
  const plan = planRestore(o);
  const g = openGeneration(o.home, o.name);
  const baseIds = g.meta ? Object.keys(g.meta.base) : [];
  const safety = takeGeneration({ home: o.home, claudeDir: o.claudeDir, rels: [...plan.restore, ...(g.meta?.created ?? [])], baseIds, base: o.db ? new ConfigBase(o.db) : null, now, kind: 'restore' });
  let baseReverted = false;
  try {
    putBack(o.claudeDir, g.dir, g.files, g.meta);
    if (o.db && g.meta) {
      const base = new ConfigBase(o.db);
      o.db.transaction(() => { for (const [id, sha] of Object.entries(g.meta!.base)) { if (sha === null) base.remove(id); else base.set(id, sha, now); } })();
      baseReverted = true;
    }
  } catch (e) {
    throw rollback(o.claudeDir, safety, e, '戻す操作');
  }
  pruneGenerations(o.home);
  return { restored: plan.restore, removed: plan.remove, safety: safety.name, baseReverted };
}
