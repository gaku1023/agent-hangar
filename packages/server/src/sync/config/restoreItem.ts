import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigHistoryDto } from '@agent-hangar/shared';
import { backupsRoot } from '../../config/cloud.ts';
import type { Db } from '../../db/open.ts';
import {
  ApplyError, assertSafeTarget, changedError, editSettings, fileOf, localFingerprint, openGeneration, plannedFile, pruneGenerations, readBuf, rollback, takeGeneration, writeAtomic,
  type GenerationMeta, type PlannedFile, type SettingsEdit, type WritePaths,
} from './apply.ts';
import { backupStores } from './applyAll.ts';
import { ConfigBase } from './base.ts';
import { markUndone, readHistoryRow } from './history.ts';
import { targetOfId } from './targets/index.ts';
import type { TargetStore } from './targets/types.ts';

/**
 * 1 項目の戻しと、履歴の 1 回分の戻し（計画 T5）。
 * 世代の戻し（apply.ts の runRestore）は世代の中身を丸ごと書き戻すが、こちらは項目に当たる分だけを、その世代の控えから戻す。
 *
 * - 戻し方は項目の指す先で決まる。ファイルの項目（file、codex-file、opencode-file、メモリ）は、そのファイルを世代の中身へ。世代の時点で無かったファイルは消す。
 *   settings.json の鍵の項目（settings:、フック、プラグイン）は、世代の settings.json のその鍵の値だけを今の settings.json へ書く（世代の時点で無かった鍵は消す）。ほかの鍵は触らない。
 *   フックが伴う台本のファイルは戻さない。手で戻すか、世代まるごとの戻しを使う。
 * - Codex の config.toml の鍵、opencode の JSON の鍵、MCP のサーバー、hangar の好みは、この仕組みでは戻せない（restorableItem が偽）。
 *   hangar の好みは控えの世代そのものを取らない。
 * - 戻す前の今の状態は、置き場ごとに kind 'restore' の世代として控える。失敗したら、その世代から元へ戻す。
 * - config_base のその項目は、世代が控えた適用前の値へ戻す。
 * - 履歴から戻したときは、config_history.undone に項目の id を足す。
 */

type FileSpec = { kind: 'file'; store: TargetStore; rel: string };
type SettingsSpec = { kind: 'settings'; store: TargetStore; key: string };
type MemorySpec = { kind: 'memory'; store: TargetStore; projectId: string; rel: string };
type Spec = FileSpec | SettingsSpec | MemorySpec;

function specOf(id: string): Spec | null {
  const t = targetOfId(id);
  const store = t?.store;
  if (!t || t.placeholder || !store) return null;
  const ref = t.parseId(id)?.ref;
  if (!ref) return null;
  if (ref.type === 'file' || ref.type === 'codex-file' || ref.type === 'opencode-file') return { kind: 'file', store, rel: ref.rel };
  if (ref.type === 'settings' && store.name === 'claude') return { kind: 'settings', store, key: ref.key };
  if (ref.type === 'memory') return { kind: 'memory', store, projectId: ref.projectId, rel: ref.rel };
  return null;
}

/** この項目を 1 つだけ戻す仕組みがあるか。控えの世代が残っているかは見ない。 */
export const restorableItem = (id: string): boolean => specOf(id) !== null;

const storeNamed = (name: string): TargetStore | undefined => backupStores().find((s) => s.name === name);
const backupsOf = (home: string, store: TargetStore): string => path.join(backupsRoot(home), store.backups);

/** 履歴の dto に、項目ごとの「いま戻せるか」を足す。世代の控えが消えていたり、戻し済みだったり、戻し方が無い項目は偽。 */
export function withRestorable(history: ConfigHistoryDto[], home: string): ConfigHistoryDto[] {
  return history.map((h) => ({
    ...h,
    items: h.items.map((i) => {
      const spec = specOf(i.id);
      const gen = spec ? h.generations.find((g) => g.target === spec.store.name) : undefined;
      const here = !!gen && fs.existsSync(path.join(backupsOf(home, spec!.store), gen.name));
      return { ...i, restorable: here && !h.undone.includes(i.id) };
    }),
  }));
}

export type ItemRestoreRequest =
  | { historyId: number; itemId?: string }
  | { generation: string; target: string; itemId: string };

type Entry = { id: string; spec: Spec; name: string };

function entriesOf(db: Db, req: ItemRestoreRequest): { entries: Entry[]; historyId: number | null } {
  if ('generation' in req) {
    const spec = specOf(req.itemId);
    if (!spec || spec.store.name !== req.target) throw new ApplyError('unsupported', `この項目は、その対象の世代からは戻せません（${req.itemId}）。`);
    return { entries: [{ id: req.itemId, spec, name: req.generation }], historyId: null };
  }
  const row = readHistoryRow(db, req.historyId);
  if (!row) throw new ApplyError('no-history', `その履歴がありません（${req.historyId}）。`);
  const one = req.itemId !== undefined;
  const wanted = one ? row.items.filter((i) => i.id === req.itemId) : row.items;
  if (one && wanted.length === 0) throw new ApplyError('not-in-history', `その履歴に、この項目はありません（${req.itemId}）。`);
  const entries: Entry[] = [];
  let undone = 0;
  for (const it of wanted) {
    if (row.undone.includes(it.id)) { undone++; continue; }
    const spec = specOf(it.id);
    const gen = spec ? row.generations.find((g) => g.target === spec.store.name) : undefined;
    if (!spec) {
      if (one) throw new ApplyError('unsupported', `この項目は 1 つだけ戻せません（${it.id}）。控えの世代が無いか、戻し方がありません。`);
      continue;
    }
    if (!gen) {
      if (one) throw new ApplyError('no-generation', `この項目の控えの世代が、履歴にありません（${it.id}）。`);
      continue;
    }
    entries.push({ id: it.id, spec, name: gen.name });
  }
  if (entries.length === 0) {
    if (undone > 0 && undone === wanted.length) throw new ApplyError('already-undone', one ? 'この項目はもう戻してあります。' : 'この履歴の項目は、もう全部戻してあります。');
    throw new ApplyError('unsupported', 'この履歴には、戻せる項目がありません。');
  }
  return { entries, historyId: req.historyId };
}

type FileOp = { id: string; rel: string; data: Buffer | null };
type Group = { store: TargetStore; root: string; name: string; dir: string; meta: GenerationMeta | null; genFiles: string[]; files: FileOp[]; settings: { id: string; edit: SettingsEdit }[]; ids: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const valueAt = (obj: Record<string, unknown>, key: string): unknown => {
  if (!key.startsWith('permissions.')) return obj[key];
  return isObject(obj.permissions) ? obj.permissions[key.slice('permissions.'.length)] : undefined;
};

/** メモリの項目の、設定の入れ物の中のパス。プロジェクトの場所の slug のうち、世代が触ったものから 1 つに決まるときだけ。 */
function memoryRel(db: Db, g: { files: string[]; meta: GenerationMeta | null }, spec: MemorySpec): string {
  const slugs = new Set((db.prepare('select path from project_roots where project_id = ? and deleted_at is null').all(spec.projectId) as { path: string }[]).map((r) => r.path.replace(/[^a-zA-Z0-9]/g, '-')));
  const tail = `/memory/${spec.rel}`;
  const hits = [...g.files, ...(g.meta?.created ?? [])].filter((r) => {
    if (!r.startsWith('projects/') || !r.endsWith(tail)) return false;
    const slug = r.slice('projects/'.length, r.length - tail.length);
    return slug !== '' && !slug.includes('/') && (slugs.size === 0 || slugs.has(slug));
  });
  if (new Set(hits).size !== 1) throw new ApplyError('not-in-generation', `その世代に、このメモリの項目のファイルが 1 つに決まりません（${spec.rel}）。`);
  return hits[0]!;
}

function groupsOf(o: WritePaths & { db: Db }, entries: Entry[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const e of entries) {
    const key = `${e.spec.store.name}\0${e.name}`;
    let g = byKey.get(key);
    if (!g) {
      const opened = openGeneration(o.home, e.name, backupsOf(o.home, e.spec.store));
      g = { store: e.spec.store, root: e.spec.store.root(o), name: e.name, dir: opened.dir, meta: opened.meta, genFiles: opened.files, files: [], settings: [], ids: [] };
      byKey.set(key, g);
    }
    const names = g.genFiles;
    g.ids.push(e.id);
    if (e.spec.kind === 'settings') {
      assertSafeTarget(g.root, 'settings.json');
      let value: unknown;
      if (names.includes('settings.json')) {
        let parsed: unknown;
        try { parsed = JSON.parse(fs.readFileSync(fileOf(g.dir, 'settings.json'), 'utf8')); } catch { throw new ApplyError('settings-unreadable', `世代の settings.json を読み込めません（${e.name}）。`); }
        if (!isObject(parsed)) throw new ApplyError('settings-unreadable', `世代の settings.json の中身がオブジェクトではありません（${e.name}）。`);
        value = valueAt(parsed, e.spec.key);
      } else if (!g.meta?.created.includes('settings.json')) {
        throw new ApplyError('not-in-generation', `その世代は、この項目を控えていません（${e.id}）。`);
      }
      g.settings.push({ id: e.id, edit: { key: e.spec.key, value, remove: value === undefined } });
      continue;
    }
    const rel = e.spec.kind === 'memory' ? memoryRel(o.db, { files: names, meta: g.meta }, e.spec) : e.spec.rel;
    assertSafeTarget(g.root, rel);
    if (names.includes(rel)) g.files.push({ id: e.id, rel, data: fs.readFileSync(fileOf(g.dir, rel)) });
    else if (g.meta?.created.includes(rel)) g.files.push({ id: e.id, rel, data: null });
    else throw new ApplyError('not-in-generation', `その世代は、この項目を控えていません（${e.id}）。`);
  }
  return [...byKey.values()];
}

const touched = (g: Group): string[] => [...new Set([...g.files.map((f) => f.rel), ...(g.settings.length > 0 ? ['settings.json'] : [])])];

function settingsAfter(g: Group, read: (abs: string) => Buffer | null): string {
  const text = read(fileOf(g.root, 'settings.json'))?.toString('utf8') ?? null;
  return editSettings(text, g.settings.map((s) => s.edit));
}

export type ItemRestorePlan = {
  /** 戻す世代の名前と対象。置き場が複数なら、1 つ目。 */
  name: string;
  target: string;
  /** 書き戻すファイルと、世代の時点で無かったため消すファイル（設定の入れ物からの相対パス）。 */
  restore: string[];
  remove: string[];
  /** 戻す項目の id。 */
  items: string[];
  files: PlannedFile[];
  fingerprint: string;
};

type Req = ItemRestoreRequest & WritePaths & { db: Db };

function fingerprintOf(groups: Group[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(groups.map((g) => [g.store.name, g.name, localFingerprint(g.root, touched(g))]))).digest('hex');
}

/** 戻す見立て。何も書かない。 */
export function planRestoreItem(o: Req): ItemRestorePlan {
  const { entries } = entriesOf(o.db, o);
  const groups = groupsOf(o, entries);
  const files: PlannedFile[] = [];
  const restore: string[] = [];
  const remove: string[] = [];
  for (const g of groups) {
    for (const f of g.files) {
      files.push({ ...plannedFile(g.root, f.rel, readBuf(fileOf(g.root, f.rel)), f.data), target: g.store.name });
      (f.data === null ? remove : restore).push(f.rel);
    }
    if (g.settings.length > 0) {
      files.push({ ...plannedFile(g.root, 'settings.json', readBuf(fileOf(g.root, 'settings.json')), Buffer.from(settingsAfter(g, readBuf))), target: g.store.name });
      restore.push('settings.json');
    }
  }
  return { name: groups[0]!.name, target: groups[0]!.store.name, restore, remove, items: entries.map((e) => e.id), files, fingerprint: fingerprintOf(groups) };
}

export type ItemRestoreResult = {
  /** 戻した項目の id。 */
  items: string[];
  restored: string[];
  removed: string[];
  /** 戻す前の状態を控えた世代（置き場ごと）。これを戻せば、戻しを取り消せる。 */
  safeties: { target: string; name: string }[];
  /** safeties の 1 つ目の名前。 */
  safety: string | null;
};

const modeOf = (file: string, fallback: number): number => { try { return fs.statSync(file).mode & 0o777; } catch { return fallback; } };

function runGroup(o: WritePaths & { db: Db }, g: Group, now: number): { name: string; restored: string[]; removed: string[] } {
  const rels = touched(g);
  const safety = takeGeneration({ home: o.home, claudeDir: g.root, rels, baseIds: g.ids, base: new ConfigBase(o.db), now, kind: 'restore', backups: backupsOf(o.home, g.store) });
  const restored: string[] = [];
  const removed: string[] = [];
  try {
    for (const f of g.files) {
      const dest = fileOf(g.root, f.rel);
      if (f.data === null) { fs.rmSync(dest, { force: true }); removed.push(f.rel); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeAtomic(dest, f.data, modeOf(dest, 0o644));
      restored.push(f.rel);
    }
    if (g.settings.length > 0) {
      const dest = fileOf(g.root, 'settings.json');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeAtomic(dest, settingsAfter(g, readBuf), modeOf(dest, 0o600));
      restored.push('settings.json');
    }
    if (g.meta) {
      const meta = g.meta;
      const base = new ConfigBase(o.db);
      o.db.transaction(() => {
        for (const id of g.ids) {
          if (!Object.hasOwn(meta.base, id)) continue;
          const sha = meta.base[id]!;
          if (sha === null) base.remove(id); else base.set(id, sha, now);
        }
      })();
    }
  } catch (e) {
    throw rollback(g.root, safety, e, '戻す操作');
  }
  // 世代が控えた「そのとき無かったディレクトリ」のうち、消したファイルの上のものは、空なら消す。
  for (const d of [...(g.meta?.createdDirs ?? [])].sort((a, b) => b.split('/').length - a.split('/').length)) {
    if (removed.some((r) => r.startsWith(`${d}/`))) { try { fs.rmdirSync(fileOf(g.root, d)); } catch { /* 空でなければ、利用者の物があるので残す */ } }
  }
  pruneGenerations(o.home, backupsOf(o.home, g.store));
  return { name: safety.name, restored, removed };
}

/**
 * 1 項目、または履歴の 1 回分を、世代の控えから戻す。
 * expect を渡すと、planRestoreItem で見せた書く先の指紋と比べ、違えば何も戻さない。
 */
export function restoreItem(o: Req & { now?: () => number; expect?: string }): ItemRestoreResult {
  const now = o.now ? o.now() : Date.now();
  const { entries, historyId } = entriesOf(o.db, o);
  const groups = groupsOf(o, entries);
  if (o.expect !== undefined && fingerprintOf(groups) !== o.expect) throw changedError();
  const out: ItemRestoreResult = { items: entries.map((e) => e.id), restored: [], removed: [], safeties: [], safety: null };
  for (const g of groups) {
    const r = runGroup(o, g, now);
    out.restored.push(...r.restored);
    out.removed.push(...r.removed);
    out.safeties.push({ target: g.store.name, name: r.name });
  }
  out.safety = out.safeties[0]?.name ?? null;
  if (historyId !== null) markUndone(o.db, historyId, out.items);
  return out;
}

/** 履歴の 1 回分（まだ戻していない、戻せる全項目）をまとめて戻す。 */
export function restoreHistory(o: WritePaths & { db: Db; historyId: number; now?: () => number; expect?: string }): ItemRestoreResult {
  return restoreItem(o);
}

export const planRestoreHistory = (o: WritePaths & { db: Db; historyId: number }): ItemRestorePlan => planRestoreItem(o);
