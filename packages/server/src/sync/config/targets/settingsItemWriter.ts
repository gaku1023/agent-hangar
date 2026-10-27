import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigApplyOrderItemDto, ConfigExecMark, ConfigItemKind } from '@agent-hangar/shared';
import { ApplyError, assertSafeTarget, changedError, editSettings, errText, fileOf, localFingerprint, pruneGenerations, rollback, takeGeneration, writeAtomic, type ApplyAct, type ApplyOptions, type ApplyPlan, type ApplyPlanItem, type ApplyResult, type PlannedOp, type PlanReader, type SettingsEdit, type WritePaths } from '../apply.ts';
import { readApplyOrder } from '../applyOrder.ts';
import { ConfigBase } from '../base.ts';
import { parseItemId } from '../ids.ts';
import { readInbox, readInboxBlob } from '../inbox.ts';
import { MAX_ITEM_BYTES } from '../bundle.ts';
import type { HostOs } from './hookCommands.ts';

/**
 * settings.json の鍵を、受け手の手元と混ぜて書く項目（hooks、statusLine、plugins）の書き戻し。
 * 今の Claude の settings の書き方（apply.ts の editSettings、控えの世代、一時ファイルから rename、失敗したら戻す）に倣う。
 * 違いは 2 つ。鍵の値を「届いた値」で置き換えるのではなく、項目ごとの merge で手元だけの部分を残すこと。
 * 項目が台本のファイルを伴うとき、それも同じ世代に控えて書くこと。
 *
 * 指示書の項目のうち spec を持つ id だけを扱う。ほかの対象の項目は読み飛ばす（指示書を消すのも呼び手の役目）。
 */

export type FileWrite = { rel: string; data: Buffer; exec: boolean };

export type ItemSpec = {
  /** settings.json の鍵。 */
  key: string;
  /** 届いた中身を読む。形が悪い、保留すべきものは ApplyError を投げる。 */
  decode(blob: Buffer, from: { senderOs: HostOs | undefined }): { value: unknown; files: FileWrite[] };
  /** 手元の settings.json の中身（cur）と、届いた値（消去なら undefined）から、書く値を決める。undefined なら鍵を消す。 */
  merge(cur: Record<string, unknown>, remote: unknown): unknown;
  /** 承認の窓に出す印。 */
  marks(files: FileWrite[]): ConfigExecMark[];
};

type Prep = { item: ConfigApplyOrderItemDto; plan: ApplyPlanItem; spec: ItemSpec; value: unknown; files: FileWrite[] };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

function prepare(home: string, specs: ReadonlyMap<string, ItemSpec>): { createdAt: number; items: Prep[] } {
  const order = readApplyOrder(home);
  if (!order || order.items.length === 0) throw new ApplyError('no-order', '適用内容がありません。Hangar の設定で、適用する項目を選んでください。');
  const inbox = readInbox(home);
  const stale = (id: string): ApplyError => new ApplyError('stale', `適用内容の項目が、現在の受信内容と一致しません（${id}）。他の PC の設定が更新された可能性があります。Hangar の設定で、適用する項目を選び直してください。`);
  const items: Prep[] = [];
  const seen = new Set<string>();
  for (const item of order.items) {
    const spec = specs.get(item.id);
    if (!spec) continue;
    const parsed = parseItemId(item.id);
    if (!parsed || seen.has(item.id)) throw new ApplyError('broken-order', '適用内容が壊れています（項目が重なっています）。Hangar の設定で、適用する項目を選び直してください。');
    seen.add(item.id);
    if (item.target !== `settings.json#${spec.key}`) throw new ApplyError('unsafe', `適用内容の書き込み先が項目と一致しません（${item.id}）。書き込みません。`);
    const remoteGone = item.sha256 === '';
    if (item.take === 'mine' && item.op !== 'conflict') throw new ApplyError('broken-order', '適用内容が壊れています（競合でない項目でこの PC の内容を採用する指定があります）。');
    if (item.take === 'remote' && (item.op === 'delete') !== remoteGone && item.op !== 'conflict') throw new ApplyError('broken-order', '適用内容が壊れています（操作と指紋が合いません）。');
    const act: ApplyAct = item.take === 'mine' ? 'keep' : remoteGone ? 'remove' : 'write';
    let marks: ConfigExecMark[] = [];
    let value: unknown;
    let files: FileWrite[] = [];
    if (remoteGone) {
      if (inbox.some((e) => e.items.some((i) => i.id === item.id))) throw stale(item.id);
    } else {
      const holder = inbox.find((e) => e.deviceId === item.fromDeviceId);
      const mi = holder?.items.find((i) => i.id === item.id && i.sha256 === item.sha256);
      if (!holder || !mi) throw stale(item.id);
      marks = mi.marks;
      if (act === 'write') {
        const blob = readInboxBlob(home, item.fromDeviceId, item.sha256);
        if (!blob || sha(blob) !== item.sha256) throw stale(item.id);
        ({ value, files } = spec.decode(blob, { senderOs: holder.meta.os }));
        marks = spec.marks(files);
      }
    }
    items.push({ item, spec, value, files, plan: { id: item.id, kind: parsed.kind, op: item.op, take: item.take, label: spec.key, marks, act } });
  }
  return { createdAt: order.createdAt, items };
}

/** 書き戻しの見立て。何も書かない。保留すべきものがあれば ApplyError。 */
export function planItems(o: { home: string }, specs: ReadonlyMap<string, ItemSpec>): ApplyPlan {
  const { createdAt, items } = prepare(o.home, specs);
  const counts = { create: 0, overwrite: 0, delete: 0, conflictRemote: 0, conflictMine: 0 };
  const byKind: Partial<Record<ConfigItemKind, number>> = {};
  const plans = items.map((p) => p.plan);
  for (const p of plans) {
    if (p.op === 'conflict') counts[p.take === 'mine' ? 'conflictMine' : 'conflictRemote']++;
    else counts[p.op]++;
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  }
  return { createdAt, items: plans, counts, byKind, instructions: 0, exec: plans.filter((p) => p.act === 'write' && p.marks.length > 0) };
}

type FileOp = { rel: string; exec: boolean; data: Buffer | string };

/** 項目から、ファイルごとの書き込みを作る。settings.json は read があればそれで読む（先に同じファイルを書く対象の分を含めて見せるため）。 */
function buildItemOps(o: { claudeDir: string }, items: Prep[], read?: PlanReader): FileOp[] {
  const writes = items.filter((p) => p.plan.act !== 'keep');
  const ops: FileOp[] = [];
  for (const p of writes) for (const f of p.files) if (!ops.some((x) => x.rel === f.rel)) ops.push({ rel: f.rel, exec: f.exec, data: f.data });
  for (const op of ops) assertSafeTarget(o.claudeDir, op.rel);
  if (writes.length > 0) {
    assertSafeTarget(o.claudeDir, 'settings.json');
    let text: string | null = null;
    if (read) text = read(fileOf(o.claudeDir, 'settings.json'))?.toString('utf8') ?? null;
    else try { text = fs.readFileSync(fileOf(o.claudeDir, 'settings.json'), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ApplyError('settings-unreadable', 'settings.json を読み込めないため、設定のキーは書き込みません。'); }
    let cur: Record<string, unknown> = {};
    if (text !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new ApplyError('settings-unreadable', 'settings.json を読み込めないため、設定のキーは書き込みません（JSON として読めません）。'); }
      if (!isObject(parsed)) throw new ApplyError('settings-unreadable', 'settings.json を読み込めないため、設定のキーは書き込みません（中身がオブジェクトではありません）。');
      cur = parsed;
    }
    const edits: SettingsEdit[] = writes.map((p) => {
      const v = p.spec.merge(cur, p.plan.act === 'remove' ? undefined : p.value);
      return { key: p.spec.key, value: v, remove: v === undefined };
    });
    ops.push({ rel: 'settings.json', exec: false, data: editSettings(text, edits) });
  }
  return ops;
}

/** 書く先ごとの、書いた後の中身（承認の窓の差分と指紋）。何も書かない。 */
export function planItemOps(o: WritePaths, specs: ReadonlyMap<string, ItemSpec>, read?: PlanReader): PlannedOp[] {
  const { items } = prepare(o.home, specs);
  return buildItemOps(o, items, read).map((op) => ({ rel: op.rel, path: fileOf(o.claudeDir, op.rel), after: op.data }));
}

/** 書く。控えの世代を取れなければ何も書かない。失敗したら元へ戻す。指示書は消さない。 */
export function writeItems(o: ApplyOptions, specs: ReadonlyMap<string, ItemSpec>): ApplyResult {
  const now = o.now ? o.now() : Date.now();
  const { items } = prepare(o.home, specs);
  const keptMine = items.filter((p) => p.plan.act === 'keep').length;
  const ops = buildItemOps(o, items);
  if (o.expect !== undefined && localFingerprint(o.claudeDir, ops.map((op) => op.rel)) !== o.expect) throw changedError();

  const done = (generation: string | null): ApplyResult => ({ generation, keptMine, written: ops.length, removed: 0, files: ops.map((op) => op.rel) });
  const updateBase = (): void => {
    const base = new ConfigBase(o.db);
    o.db.transaction(() => {
      for (const p of items) {
        if (p.item.sha256 !== '' && p.plan.act !== 'remove') base.set(p.item.id, p.item.sha256, now);
        else base.remove(p.item.id);
      }
    })();
  };
  if (ops.length === 0) {
    try { updateBase(); } catch (e) { throw new ApplyError('write-failed', `基準の更新に失敗しました（${errText(e)}）。適用内容は削除していません。`); }
    return done(null);
  }

  let gen: { name: string; dir: string };
  try { gen = takeGeneration({ home: o.home, claudeDir: o.claudeDir, rels: ops.map((op) => op.rel), baseIds: items.map((p) => p.item.id), base: new ConfigBase(o.db), now, kind: 'apply' }); } catch (e) {
    if (e instanceof ApplyError) throw e;
    throw new ApplyError('write-failed', `バックアップの世代を作れませんでした（${errText(e)}）。何も書き込んでいません。`);
  }
  try {
    ops.forEach((op, i) => {
      o.onWrite?.(op.rel, i);
      const dest = fileOf(o.claudeDir, op.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // 権限は手元のものを保つ。新しいファイルは settings.json だけ自分専用にする。台本は、送り手が実行できる印を付けていた分だけ実行できるようにする（posix のみ）。
      let mode = op.rel === 'settings.json' ? 0o600 : op.exec && process.platform !== 'win32' ? 0o755 : 0o644;
      try { mode = (fs.statSync(dest).mode & 0o777) | (op.exec && process.platform !== 'win32' ? 0o100 : 0); } catch { /* 新しいファイル */ }
      writeAtomic(dest, op.data, mode);
    });
    updateBase();
  } catch (e) {
    throw rollback(o.claudeDir, gen, e, '書き込み');
  }
  pruneGenerations(o.home);
  return done(gen.name);
}

/**
 * 集めるときの settings.json の読み方。読めたら中身と mtime、無ければ absent、リンクや大きすぎ、JSON でない、オブジェクトでない、読めないは blocked
 * （相手の鍵を書き込めないので、同名の項目が届いても create と見てはいけない）。
 */
export function readSettingsForCollect(claudeDir: string): { json: Record<string, unknown>; mtime: number } | 'absent' | 'blocked' {
  const file = path.join(claudeDir, 'settings.json');
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'blocked'; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_ITEM_BYTES) return 'blocked';
  let json: unknown;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return 'blocked'; }
  return isObject(json) ? { json, mtime: Math.floor(st.mtimeMs) } : 'blocked';
}
