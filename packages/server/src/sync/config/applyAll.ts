import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigBackupGenerationDto, ConfigItemKind } from '@agent-hangar/shared';
import { backupsRoot } from '../../config/cloud.ts';
import {
  ApplyError, changedError, errText, loadOrder, plannedFile, planRestore, planRestoreFiles, readBuf, runRestore, undoGeneration,
  type ApplyOptions, type ApplyPlan, type ApplyResult, type PlannedFile, type PlannedFiles, type PlanPaths, type RestorePlan, type RestoreResult, type WritePaths,
} from './apply.ts';
import { deleteApplyOrder } from './applyOrder.ts';
import { listBackupsIn } from './backups.ts';
import { ConfigBase } from './base.ts';
import type { Db } from '../../db/open.ts';
import { allTargets, targetOfId, type ConfigTarget } from './targets/index.ts';
import type { TargetStore } from './targets/types.ts';

/**
 * 適用の指示書を、項目の持ち主の対象ごとに分けて書く（CLI の hangar config apply と殻の命令が走らせる）。
 *
 * 1. 指示書の項目を targetOfId で対象に振り分ける。持ち主のいない項目、枠だけの対象、書き方を持たない対象の項目があれば、何も書かずに断る。
 *    同じ write を持つ対象（claude と claude-keys2）は 1 回だけ呼ぶ。
 * 2. 全部の対象の見立て（planWrite と planOps）を先に作る。どれか 1 つでも書けない状態なら、何も書かずに断る。
 *    同じファイルを 2 つの対象が書くとき（settings.json を claude と claude-hooks が書く）、後の対象は前の対象の書いた後の中身を読んで見立てる。
 * 3. 承諾の窓で見せた指紋（expect）を、全部の書く先で取り直して比べる。違えば何も書かない。
 * 4. 控えの置き場を全部作れるか確かめる。作れなければ何も書かない。
 * 5. 対象ごとに write を呼ぶ（各対象が自分の控えを取り、失敗したら自分を戻す）。
 *    途中の対象が失敗したら、先に書いた対象を、その世代から戻し、基準も適用の前へ戻す（どこか 1 つが書けなければ、全部書かない）。
 * 6. 全部書けたら、指示書を消す（指示書を消すのはここだけ。各対象の write は消さない）。
 */

/** 承諾の窓の見立て。どの対象に書くかを添える。 */
export type ApplyAllPlan = ApplyPlan & { targets: string[] };
export type ApplyAllResult = ApplyResult & { generations: { target: string; name: string }[] };

type Writer = { key: string; target: ConfigTarget; names: string[] };

const writerKey = (t: ConfigTarget): string => t.writesWith ?? t.name;

function writersOf(home: string): { createdAt: number; writers: Writer[]; ids: string[] } {
  const order = loadOrder(home);
  const used = new Set<ConfigTarget>();
  for (const item of order.items) {
    const t = targetOfId(item.id);
    if (!t || t.placeholder || !t.planOps) throw new ApplyError('unknown-target', `この版の Hangar では書けない項目が適用内容にあります（${item.id}）。何も書いていません。`);
    used.add(t);
  }
  const writers: Writer[] = [];
  for (const t of allTargets()) {
    if (!used.has(t)) continue;
    const key = writerKey(t);
    const w = writers.find((x) => x.key === key);
    if (w) { w.names.push(t.name); continue; }
    // 同じ write を持つ対象のうち、登録の先のものを呼ぶ（どれを呼んでも同じ項目を書く）。
    const owner = allTargets().find((x) => writerKey(x) === key && used.has(x)) ?? t;
    writers.push({ key, target: owner, names: [t.name] });
  }
  // 控えを取らない対象（hangar の好み）は最後に書く。途中で失敗しても、先に書いた対象は控えから戻せる。
  writers.sort((a, b) => Number(!a.target.store) - Number(!b.target.store));
  return { createdAt: order.createdAt, writers, ids: order.items.map((i) => i.id) };
}

/** 確認に出す見立て。何も書かない。指示書が適用できる状態でなければ ApplyError。 */
export function planApplyAll(o: PlanPaths): ApplyAllPlan {
  const { createdAt, writers } = writersOf(o.home);
  const out: ApplyAllPlan = { createdAt, items: [], counts: { create: 0, overwrite: 0, delete: 0, conflictRemote: 0, conflictMine: 0 }, byKind: {}, instructions: 0, exec: [], targets: [] };
  for (const w of writers) {
    const p = w.target.planWrite(o);
    out.items.push(...p.items);
    for (const k of Object.keys(out.counts) as (keyof ApplyPlan['counts'])[]) out.counts[k] += p.counts[k];
    for (const [k, n] of Object.entries(p.byKind) as [ConfigItemKind, number][]) out.byKind[k] = (out.byKind[k] ?? 0) + n;
    out.instructions += p.instructions;
    out.exec.push(...p.exec);
    out.targets.push(...w.names);
  }
  return out;
}

type Composed = { files: PlannedFile[]; fingerprint: string; stable: string[] };

/** 全部の対象の書く先を、書く順に重ねて作る。同じファイルは 1 つにまとめ、差分は今の中身から最後に書く中身まで。 */
function compose(o: WritePaths, writers: Writer[]): Composed {
  const after = new Map<string, Buffer | null>();
  const entries = new Map<string, { rel: string; target: string; volatile: boolean }>();
  const read = (abs: string): Buffer | null => (after.has(abs) ? after.get(abs)! : readBuf(abs));
  for (const w of writers) {
    for (const op of w.target.planOps!(o, read)) {
      after.set(op.path, op.after === null ? null : Buffer.isBuffer(op.after) ? op.after : Buffer.from(op.after));
      const prev = entries.get(op.path);
      entries.set(op.path, { rel: op.rel, target: prev?.target ?? w.target.store?.name ?? w.target.name, volatile: (prev?.volatile ?? true) && op.volatile === true });
    }
  }
  const files: PlannedFile[] = [];
  const stable: string[] = [];
  for (const [abs, e] of entries) {
    const f = plannedFile(path.dirname(abs), path.basename(abs), readBuf(abs), after.get(abs) ?? null);
    files.push({ ...f, rel: e.rel, path: abs, target: e.target });
    if (!e.volatile) stable.push(abs);
  }
  return { files, fingerprint: fingerprintOf(stable), stable };
}

/** 書く先の今の中身の指紋（絶対パスと中身の指紋の並び）。無いものは null として数える。 */
function fingerprintOf(paths: string[]): string {
  const parts = [...new Set(paths)].sort().map((p) => {
    const b = readBuf(p);
    return [p, b === null ? null : crypto.createHash('sha256').update(b).digest('hex')];
  });
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** 適用の見立てを、書く先のファイルごとに作る。何も書かない。 */
export function planApplyAllFiles(o: WritePaths): PlannedFiles {
  const { writers } = writersOf(o.home);
  for (const w of writers) w.target.planWrite(o);
  const c = compose(o, writers);
  return { files: c.files, fingerprint: c.fingerprint };
}

/** 控えの置き場を作れて、書けるか。作れなければ、どの対象にも書かない。 */
function assertBackupsWritable(home: string, stores: TargetStore[]): void {
  for (const s of stores) {
    const dir = path.join(backupsRoot(home), s.backups);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
      throw new ApplyError('write-failed', `控えの世代を作れませんでした（${s.name}、${errText(e)}）。何も書いていません。`);
    }
  }
}

/** 指示書のとおりに、対象ごとの入れ物へ書く。どこか 1 つが書けなければ、先に書いた分も戻して ApplyError を投げる。 */
export function runApplyAll(o: ApplyOptions): ApplyAllResult {
  const { writers, ids } = writersOf(o.home);
  for (const w of writers) w.target.planWrite(o);
  const c = compose(o, writers);
  if (o.expect !== undefined && c.fingerprint !== o.expect) throw changedError();
  const stores = [...new Map(writers.flatMap((w) => (w.target.store ? [[w.target.store.backups, w.target.store] as const] : []))).values()];
  assertBackupsWritable(o.home, stores);

  let before: (readonly [string, string | null])[];
  try {
    const all = new ConfigBase(o.db).all();
    before = ids.map((id) => [id, all.get(id) ?? null] as const);
  } catch (e) {
    throw new ApplyError('write-failed', `基準を読めませんでした（${errText(e)}）。何も書いていません。`);
  }
  const done: { w: Writer; r: ApplyResult }[] = [];
  for (const w of writers) {
    let r: ApplyResult;
    try {
      r = w.target.write({ ...o, expect: undefined });
    } catch (e) {
      throw undoAll(o, done, before, e);
    }
    done.push({ w, r });
  }
  deleteApplyOrder(o.home);
  const generations = done.flatMap(({ w, r }) => (r.generation && w.target.store ? [{ target: w.target.store.name, name: r.generation }] : []));
  return {
    generation: generations[0]?.name ?? null,
    generations,
    written: done.reduce((n, d) => n + d.r.written, 0),
    removed: done.reduce((n, d) => n + d.r.removed, 0),
    keptMine: done.reduce((n, d) => n + d.r.keptMine, 0),
    files: done.flatMap((d) => d.r.files),
  };
}

/** 途中の対象が失敗したとき、先に書いた対象を世代から戻し、基準を適用の前へ戻す。 */
function undoAll(o: ApplyOptions, done: { w: Writer; r: ApplyResult }[], before: readonly (readonly [string, string | null])[], cause: unknown): ApplyError {
  const first = cause instanceof ApplyError ? cause : new ApplyError('write-failed', `書き込みに失敗しました（${errText(cause)}）。`);
  if (done.length === 0) return first;
  const left: string[] = [];
  for (const { w, r } of [...done].reverse()) {
    const store = w.target.store;
    if (!r.generation || !store) continue;
    try { undoGeneration(store.root(o), path.join(backupsRoot(o.home), store.backups, r.generation)); } catch { left.push(`hangar config restore --target ${store.name} ${r.generation}`); }
  }
  try {
    const base = new ConfigBase(o.db);
    const now = o.now ? o.now() : Date.now();
    o.db.transaction(() => { for (const [id, sha] of before) { if (sha === null) base.remove(id); else base.set(id, sha, now); } })();
  } catch { /* 基準が戻らなくても、次の同期で届いた変更として出直す */ }
  if (left.length > 0) return new ApplyError(first.code, `${first.message} ほかの対象に書いた分を元へ戻す途中でも失敗しました。${left.join('、')} で戻してください。`);
  return new ApplyError(first.code, `${first.message} ほかの対象に書いた分も、元へ戻しました。`);
}

// ---- 控えの世代（対象ごと） ----

/** 控えを取る対象の置き場。同じ置き場を持つ対象は 1 つにまとめる。 */
export function backupStores(): TargetStore[] {
  return [...new Map(allTargets().flatMap((t) => (t.store && !t.placeholder ? [[t.store.name, t.store] as const] : []))).values()];
}

function storeOf(name: string | undefined): TargetStore {
  const s = backupStores().find((x) => x.name === (name ?? 'claude'));
  if (!s) throw new ApplyError('no-generation', `その対象の控えはありません（${name}）。hangar config restore で一覧を見てください。`);
  return s;
}

/** 全部の対象の世代（新しい順）。Claude の世代の target は 'claude'。 */
export function listAllBackups(home: string): ConfigBackupGenerationDto[] {
  const out: ConfigBackupGenerationDto[] = [];
  for (const s of backupStores()) {
    for (const g of listBackupsIn(path.join(backupsRoot(home), s.backups))) out.push({ ...g, target: s.name });
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : a.target! < b.target! ? -1 : 1));
}

export type TargetRestoreOptions = WritePaths & { name: string; target?: string };

const restoreArgs = (o: TargetRestoreOptions) => {
  const s = storeOf(o.target);
  return { home: o.home, claudeDir: s.root(o), name: o.name, backups: path.join(backupsRoot(o.home), s.backups) };
};

export function planRestoreTarget(o: TargetRestoreOptions): RestorePlan { return planRestore(restoreArgs(o)); }
export function planRestoreTargetFiles(o: TargetRestoreOptions): PlannedFiles { return planRestoreFiles(restoreArgs(o)); }
export function runRestoreTarget(o: TargetRestoreOptions & { db?: Db; now?: () => number; expect?: string }): RestoreResult {
  return runRestore({ ...restoreArgs(o), db: o.db, now: o.now, expect: o.expect });
}
