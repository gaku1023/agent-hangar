import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSafeRelPath, type ConfigApplyOrderItemDto, type ConfigExecMark, type ConfigInboxOp, type ConfigItemKind } from '@agent-hangar/shared';
import { backupsRoot } from '../../../config/cloud.ts';
import { diffLines } from '../../../config/jsonTextEdit.ts';
import type { Db } from '../../../db/open.ts';
import { ApplyError, type ApplyOptions, type ApplyPlan, type ApplyPlanItem, type ApplyResult, type PlannedFile, type PlannedFiles, type PlannedOp, type PlanReader, type WritePaths } from '../apply.ts';
import { readApplyOrder } from '../applyOrder.ts';
import { GENERATION_META, STAMP_RE, stampLabel } from '../backups.ts';
import { ConfigBase } from '../base.ts';
import { CODEX_CONFIG_FILE, parseItemId, type ItemRef } from '../ids.ts';
import { readInbox, readInboxBlob } from '../inbox.ts';
import { ConfigEditError, getToml, removeToml, setToml } from '../edit/index.ts';
import { hasAbsolutePath, profileIsClean, valueFitsPath } from './codexKeys.ts';
import { defaultTargetPaths } from './paths.ts';

/**
 * Codex の書き戻し（`$CODEX_HOME` に書く）。Claude の apply.ts と同じ流れで、書く先と書き方だけが違う。
 *
 * 1. 指示書（applyOrder）と inbox を突き合わせ、Codex の項目が全部書ける状態かを先に確かめる。1 つでも合わなければ何も書かない。
 * 2. 書く先の元の中身を、世代（`<hangar の置き場>/backups/codex-config/<時刻>/`）に控える。取れなければ書かない。
 * 3. 書く。config.toml は鍵ごとに差し替え、コメントと並びを保つ（S2 の setToml・removeToml）。他のファイルは一時ファイルから rename する。
 *    config.toml を書いた後は、読み直して書いたとおりかを確かめる。Codex の常駐（app-server）が同時に書き換えていたら合わず、元へ戻して失敗にする。
 * 4. 失敗したら、世代から元へ戻し、世代は消し、指示書は残す。
 * 5. 基準（config_base）を更新する。指示書が Codex の項目だけなら消す。古い世代は 20 個までに保つ。
 *
 * 呼ぶのは CLI と殻の適用の口（S11 で繋ぐ）。サーバは呼ばない。
 */

const KEEP_GENERATIONS = 20;
const SCRIPT_ONLY = new Set<string>(['rules', 'skills']);

/** codexHome は適用の口が渡す。無ければ CODEX_HOME、その次に `~/.codex`。afterWrite は試験が書いた直後の別のプロセスの書き込みを真似るための口。 */
/** 書く口。入れ物（codexHome）と、書いた直後の割り込みの口（afterWrite）は ApplyOptions が持つ。 */
export type CodexApplyOptions = ApplyOptions;

const codexHomeOf = (o: { codexHome?: string }): string => o.codexHome ?? defaultTargetPaths(process.env, os.homedir()).codexHome;
const codexBackupsDir = (home: string): string => path.join(backupsRoot(home), 'codex-config');
const fileOf = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');
const isCodexId = (id: string): boolean => id.startsWith('codex:file:') || id.startsWith('codex:toml:');

type Prepared = { item: ConfigApplyOrderItemDto; plan: ApplyPlanItem; ref: ItemRef; content: Buffer | null; value: unknown };

/** 承認の窓で「実行や指示」と数える Codex のファイル。 */
const isInstructionRel = (rel: string): boolean => rel === 'hooks.json' || SCRIPT_ONLY.has(rel.split('/')[0]!) || rel.endsWith('.config.toml');

function prepare(home: string): { createdAt: number; items: Prepared[] } {
  const order = readApplyOrder(home);
  const mine = order?.items.filter((i) => isCodexId(i.id)) ?? [];
  if (!order || mine.length === 0) {
    if (order || !fs.existsSync(path.join(home, 'claude-config', 'apply-order.json'))) throw new ApplyError('no-order', '適用内容がありません。Hangar の設定で、適用する項目を選んでください。');
    throw new ApplyError('broken-order', '適用内容が壊れているか、読み取れない形式です。Hangar の設定で、適用する項目を選び直してください。');
  }
  const inbox = readInbox(home);
  const stale = (id: string): ApplyError => new ApplyError('stale', `適用内容の項目が、現在の受信内容と一致しません（${id}）。他の PC の設定が更新された可能性があります。Hangar の設定で、適用する項目を選び直してください。`);
  const seen = new Set<string>();
  const items: Prepared[] = [];
  for (const item of mine) {
    const parsed = parseItemId(item.id);
    if (!parsed || seen.has(item.id)) throw new ApplyError('broken-order', '適用内容が壊れています（項目が重なっています）。Hangar の設定で、適用する項目を選び直してください。');
    seen.add(item.id);
    const ref = parsed.ref;
    const want = ref.type === 'codex-file' ? ref.rel : ref.type === 'codex-toml' ? `${CODEX_CONFIG_FILE}#${ref.path.join('.')}` : null;
    if (want === null || item.target !== want) throw new ApplyError('unsafe', `適用内容の書き込み先が項目と一致しません（${item.id}）。書き込みません。`);
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
        const bad = (): ApplyError => new ApplyError('bad-content', `受信した設定の値が、キーの型に合わないか、この PC では使えません（${item.id}）。`);
        if (ref.type === 'codex-toml') {
          try { value = JSON.parse(blob.toString('utf8')); } catch { throw new ApplyError('bad-content', `受信した設定の値を読み込めません（${item.id}）。`); }
          if (!valueFitsPath(ref.path, value) || hasAbsolutePath(value)) throw bad();
        } else if (ref.type === 'codex-file' && ref.rel.endsWith('.config.toml') && !profileIsClean(blob)) throw bad();
      }
    }
    const label = ref.type === 'codex-file' ? ref.rel : ref.type === 'codex-toml' ? ref.path.join('.') : item.id;
    items.push({ item, plan: { id: item.id, kind: parsed.kind, op: item.op, take: item.take, label, marks, act }, ref, content, value });
  }
  return { createdAt: order.createdAt, items };
}

/** 確認に出す見立て。何も書かない。 */
export function planCodex(o: { home: string }): ApplyPlan {
  const { createdAt, items } = prepare(o.home);
  const counts = { create: 0, overwrite: 0, delete: 0, conflictRemote: 0, conflictMine: 0 };
  const byKind: Partial<Record<ConfigItemKind, number>> = {};
  const plans = items.map((p) => p.plan);
  for (const p of plans) {
    if (p.op === 'conflict') counts[p.take === 'mine' ? 'conflictMine' : 'conflictRemote']++;
    else counts[p.op as ConfigInboxOp & ('create' | 'overwrite' | 'delete')]++;
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  }
  const writes = plans.filter((p) => p.act === 'write');
  return {
    createdAt, items: plans, counts, byKind,
    instructions: items.filter((p) => p.plan.act === 'write' && p.ref.type === 'codex-file' && isInstructionRel(p.ref.rel)).length,
    exec: writes.filter((p) => p.marks.length > 0),
  };
}

// ---- 書き込み先の安全 ----

/** codexHome の下の相対パスが、書いてよい場所か。途中にリンクがある、途中が通常のディレクトリでない、末尾が通常のファイルでない、のどれかなら ApplyError。 */
function assertSafeTarget(root: string, rel: string): void {
  if (!isSafeRelPath(rel)) throw new ApplyError('unsafe', `書き込み先の形が不正です（${rel}）。書きません。`);
  const segs = rel.split('/');
  let cur = root;
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

type FileOp = { rel: string; remove: boolean; data: Buffer | string | null };

function buildOps(codexHome: string, items: Prepared[], read?: PlanReader): FileOp[] {
  const ops: FileOp[] = [];
  const edits: { path: string[]; value: unknown; remove: boolean }[] = [];
  for (const p of items) {
    if (p.plan.act === 'keep') continue;
    if (p.ref.type === 'codex-toml') { edits.push({ path: p.ref.path, value: p.value, remove: p.plan.act === 'remove' }); continue; }
    if (p.ref.type === 'codex-file') ops.push({ rel: p.ref.rel, remove: p.plan.act === 'remove', data: p.content });
  }
  for (const op of ops) assertSafeTarget(codexHome, op.rel);
  if (edits.length > 0) {
    assertSafeTarget(codexHome, CODEX_CONFIG_FILE);
    let text: string | null = null;
    if (read) text = read(fileOf(codexHome, CODEX_CONFIG_FILE))?.toString('utf8') ?? null;
    else try { text = fs.readFileSync(fileOf(codexHome, CODEX_CONFIG_FILE), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ApplyError('settings-unreadable', 'config.toml を読み込めないため、設定のキーは書き込みません。'); }
    let out = text ?? '';
    for (const e of edits) {
      try { out = e.remove ? removeToml(out, e.path) : setToml(out, e.path, e.value); } catch (err) {
        if (err instanceof ConfigEditError) {
          if (err.code === 'parse') throw new ApplyError('settings-unreadable', `config.toml を読み込めないため、設定のキーは書き込みません（${err.message}）。`);
          throw new ApplyError('bad-content', `config.toml に書けない値です（${e.path.join('.')}、${err.message}）。`);
        }
        throw err;
      }
    }
    if (text !== null || out !== '') ops.push({ rel: CODEX_CONFIG_FILE, remove: false, data: out });
  }
  return ops;
}

// ---- 見せる中身と、書く直前の確かめ ----

function readBuf(file: string): Buffer | null {
  try { return fs.readFileSync(file); } catch { return null; }
}

/** 書く先の今の中身の指紋。無いものは null として数える。 */
function localFingerprint(root: string, rels: string[]): string {
  const parts = [...new Set(rels)].sort().map((rel) => {
    const b = readBuf(fileOf(root, rel));
    return [rel, b === null ? null : sha256(b)];
  });
  return sha256(JSON.stringify(parts));
}

const changedError = (): ApplyError => new ApplyError('changed', '確認した後に、書く先のファイルが変わりました。何も書き込んでいません。もう一度、書く中身を確かめてください。');

function plannedFile(root: string, rel: string, before: Buffer | null, after: Buffer | string | null): PlannedFile {
  const op = after === null ? 'remove' : before === null ? 'create' : 'modify';
  const a = after === null ? null : Buffer.isBuffer(after) ? after : Buffer.from(after);
  const binary = (before?.includes(0) ?? false) || (a?.includes(0) ?? false);
  const lines = binary ? [] : diffLines(before?.toString('utf8') ?? '', a?.toString('utf8') ?? '').slice(0, 200);
  return { rel, path: fileOf(root, rel), op, lines, binary };
}

/** 書く先ごとの、書いた後の中身（承認の窓の差分と指紋）。何も書かない。 */
export function planCodexOps(o: WritePaths, read?: PlanReader): PlannedOp[] {
  const root = codexHomeOf(o);
  const { items } = prepare(o.home);
  return buildOps(root, items, read).map((op) => ({ rel: op.rel, path: fileOf(root, op.rel), after: op.remove ? null : op.data }));
}

/** 適用の見立てを、書く先のファイルごとに作る。何も書かない。 */
export function planCodexFiles(o: { home: string; codexHome?: string }): PlannedFiles {
  const root = codexHomeOf(o);
  const { items } = prepare(o.home);
  const ops = buildOps(root, items);
  return {
    files: ops.map((op) => plannedFile(root, op.rel, readBuf(fileOf(root, op.rel)), op.remove ? null : op.data)),
    fingerprint: localFingerprint(root, ops.map((op) => op.rel)),
  };
}

// ---- 世代 ----

type GenerationMeta = { version: 1; kind: 'apply'; createdAt: number; created: string[]; createdDirs: string[]; base: Record<string, string | null> };

function writeAtomic(file: string, data: Buffer | string, mode: number): void {
  const tmp = `${file}.hangar-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(tmp, data, { mode }); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

function takeGeneration(o: { home: string; root: string; rels: string[]; baseIds: string[]; base: ConfigBase; now: number }): { name: string; dir: string } {
  const backups = codexBackupsDir(o.home);
  let ts = o.now;
  let name = stampLabel(ts);
  let dir = path.join(backups, name);
  try {
    fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
    for (let tries = 0; ; tries++) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 3600) throw e;
        ts += 1000;
        name = stampLabel(ts);
        dir = path.join(backups, name);
      }
    }
    const created: string[] = [];
    const createdDirs = new Set<string>();
    for (const rel of o.rels) {
      const segs = rel.split('/');
      for (let i = 1; i < segs.length; i++) {
        const d = segs.slice(0, i).join('/');
        if (!fs.existsSync(fileOf(o.root, d))) createdDirs.add(d);
      }
      const src = fileOf(o.root, rel);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(fileOf(dir, rel)), { recursive: true });
        fs.copyFileSync(src, fileOf(dir, rel));
      } else created.push(rel);
    }
    const prev = o.base.all();
    const meta: GenerationMeta = { version: 1, kind: 'apply', createdAt: o.now, created, createdDirs: [...createdDirs], base: Object.fromEntries(o.baseIds.map((id) => [id, prev.get(id) ?? null])) };
    fs.writeFileSync(path.join(dir, GENERATION_META), JSON.stringify(meta) + '\n', { mode: 0o600 });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 作れていなければ消すものも無い */ }
    throw new ApplyError('write-failed', `バックアップの世代を作れませんでした（${errText(e)}）。何も書き込んでいません。`);
  }
  return { name, dir };
}

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

function putBack(root: string, dir: string): void {
  let meta: GenerationMeta | null = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, GENERATION_META), 'utf8')) as GenerationMeta; } catch { /* 記録が無ければ、控えたものだけ戻す */ }
  for (const rel of generationFiles(dir)) {
    const dest = fileOf(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeAtomic(dest, fs.readFileSync(fileOf(dir, rel)), fs.statSync(fileOf(dir, rel)).mode & 0o777);
  }
  if (!meta) return;
  for (const rel of meta.created) fs.rmSync(fileOf(root, rel), { force: true });
  for (const d of [...meta.createdDirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    try { fs.rmdirSync(fileOf(root, d)); } catch { /* 空でなければ、利用者の物が入っているので残す */ }
  }
}

function pruneGenerations(home: string): void {
  const root = codexBackupsDir(home);
  let names: string[];
  try { names = fs.readdirSync(root).filter((n) => STAMP_RE.test(n)).sort(); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - KEEP_GENERATIONS))) {
    try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch { /* 次の機会に回す */ }
  }
}

function rollback(root: string, gen: { name: string; dir: string }, cause: unknown, what: string): ApplyError {
  try {
    putBack(root, gen.dir);
    fs.rmSync(gen.dir, { recursive: true, force: true });
    return new ApplyError('write-failed', `${what}に失敗したため、元の状態に戻しました（${errText(cause)}）。`);
  } catch (e2) {
    return new ApplyError('write-failed', `${what}に失敗し（${errText(cause)}）、元に戻す途中でも失敗しました（${errText(e2)}）。バックアップは ${gen.dir} にあります。`);
  }
}

function updateBase(db: Db, items: Prepared[], now: number): void {
  const base = new ConfigBase(db);
  db.transaction(() => {
    for (const p of items) {
      if (p.item.sha256 !== '' && p.plan.act !== 'remove') base.set(p.item.id, p.item.sha256, now);
      else base.remove(p.item.id);
    }
  })();
}

/** 指示書のとおりに `$CODEX_HOME` へ書く。失敗したら元へ戻し、指示書は残して ApplyError を投げる。 */
export function writeCodex(o: CodexApplyOptions): ApplyResult {
  const root = codexHomeOf(o);
  const now = o.now ? o.now() : Date.now();
  const { items } = prepare(o.home);
  const ops = buildOps(root, items);
  if (o.expect !== undefined && localFingerprint(root, ops.map((op) => op.rel)) !== o.expect) throw changedError();
  const keptMine = items.filter((p) => p.plan.act === 'keep').length;
  const done = (generation: string | null): ApplyResult => ({
    generation, keptMine,
    written: ops.filter((op) => !op.remove).length, removed: ops.filter((op) => op.remove).length,
    files: ops.map((op) => op.rel),
  });

  if (ops.length === 0) {
    try { updateBase(o.db, items, now); } catch (e) { throw new ApplyError('write-failed', `基準の更新に失敗しました（${errText(e)}）。適用内容は削除していません。`); }
    return done(null);
  }

  const gen = takeGeneration({ home: o.home, root, rels: ops.map((op) => op.rel), baseIds: items.map((p) => p.item.id), base: new ConfigBase(o.db), now });
  try {
    ops.forEach((op, i) => {
      o.onWrite?.(op.rel, i);
      const dest = fileOf(root, op.rel);
      if (op.remove) { fs.rmSync(dest, { force: true }); o.afterWrite?.(op.rel); return; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // 権限は手元のものを保つ。新しいファイルは自分専用にする。実行の許可は付けない。
      let mode = op.rel === CODEX_CONFIG_FILE ? 0o600 : 0o644;
      try { mode = fs.statSync(dest).mode & 0o777; } catch { /* 新しいファイル */ }
      writeAtomic(dest, op.data as Buffer | string, mode);
      o.afterWrite?.(op.rel);
      if (op.rel === CODEX_CONFIG_FILE) {
        // Codex の常駐が同時に書き換えていないか、書いた後に読み直して確かめる。
        const back = readBuf(dest);
        if (back === null || sha256(back) !== sha256(op.data as Buffer | string)) throw new Error('config.toml が、書いた直後に別のプロセスに書き換えられました');
        for (const p of items) if (p.ref.type === 'codex-toml' && p.plan.act === 'write' && getToml(back.toString('utf8'), p.ref.path) === undefined) throw new Error(`書いた鍵 ${p.ref.path.join('.')} が読み直しで見つかりません`);
      }
    });
    updateBase(o.db, items, now);
  } catch (e) {
    throw rollback(root, gen, e, '書き込み');
  }
  pruneGenerations(o.home);
  return done(gen.name);
}
