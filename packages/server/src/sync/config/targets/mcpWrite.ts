import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigApplyOrderItemDto, ConfigExecMark, ConfigInboxOp, ConfigItemKind } from '@agent-hangar/shared';
import { backupsRoot } from '../../../config/cloud.ts';
import { diffLines } from '../../../config/jsonTextEdit.ts';
import { ApplyError, type ApplyOptions, type ApplyPlan, type ApplyPlanItem, type ApplyResult, type PlannedFiles, type PlannedOp, type PlanReader } from '../apply.ts';
import { readApplyOrder } from '../applyOrder.ts';
import { GENERATION_META, STAMP_RE, stampLabel } from '../backups.ts';
import { ConfigBase } from '../base.ts';
import { ConfigEditError } from '../edit/index.ts';
import { readInbox, readInboxBlob } from '../inbox.ts';
import { canonicalJson } from '../settingsSort.ts';
import { holdOfMcp, isHangarEntry, mcpValueFits, parseMcpName, type McpFlavorKind, type McpHoldEnv } from './mcpCommon.ts';

/**
 * MCP の項目（claude-mcp、codex-mcp、opencode-mcp）の書き戻し。3 つの対象で共通の流れを持ち、書く先と書き方だけを McpFlavor で変える。
 *
 * 1. 指示書と inbox を突き合わせ、全項目が書ける状態かを先に確かめる。1 つでも合わなければ何も書かない。
 *    ここで、Hangar 自身の登録、形の悪い値、受け手に無い絶対パスの command（保留）を断る。
 * 2. 書く先のファイルを、世代（`<hangar の置き場>/backups/<対象>-config/<時刻>/`）に控える。取れなければ書かない。
 * 3. 書く直前にファイルを読み直し、名前の鍵だけを差し替えて、一時ファイルから rename する。
 *    ~/.claude.json は Claude Code も頻繁に書くので、書いた後にもう一度読み、自分の鍵が入っていて他の鍵が書く前のままかを確かめる。
 *    合わなければ読み直しからやり直し（3 回まで）、それでも合わなければ控えから戻して失敗にする。
 * 4. 基準（config_base）を更新する。指示書は消さない（消すのは適用の口、S11）。
 */

const KEEP_GENERATIONS = 20;
const RETRIES = 3;

export type McpEdit = { name: string; value: unknown; remove: boolean };

export type McpFlavor = {
  /** 対象名。 */
  name: string;
  kind: McpFlavorKind;
  idPrefix: string;
  itemKind: ConfigItemKind;
  /** 控えの置き場（`backups/` の下）。 */
  backupDir: string;
  /** 指示書の書き込み先の形（id から決まる）。 */
  targetOf(name: string): string;
  /** 文字列に、名前ごとの編集を当てる。体裁は保つ。失敗は ConfigEditError か ApplyError。 */
  edit(text: string | null, rel: string, edits: McpEdit[]): string;
  /** 文書の根（検算に使う）。 */
  root(text: string): unknown;
  /** 根の中の、MCP の表の道。 */
  tablePath: readonly string[];
};

export type McpWriteEnv = McpHoldEnv & { /** 書く先の入れ物と、そこからのファイルの相対パス。 */ root: string; rel: string };

type Prepared = { item: ConfigApplyOrderItemDto; plan: ApplyPlanItem; name: string; value: unknown };

const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const fileOf = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const canon = (v: unknown): string => canonicalJson(JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)) ?? 'null'));
const same = (a: unknown, b: unknown): boolean => {
  try { return canon(a) === canon(b); } catch { return false; }
};

export function mcpIsMine(f: McpFlavor, id: string): boolean {
  return id.startsWith(f.idPrefix);
}

// ---- 指示書の突き合わせ ----

function prepare(f: McpFlavor, home: string, env: McpHoldEnv): { createdAt: number; items: Prepared[] } {
  const order = readApplyOrder(home);
  if (!order) throw new ApplyError('no-order', '適用内容がありません。Hangar の設定で、適用する項目を選んでください。');
  const inbox = readInbox(home);
  const stale = (id: string): ApplyError => new ApplyError('stale', `適用内容の項目が、現在の受信内容と一致しません（${id}）。他の PC の設定が更新された可能性があります。Hangar の設定で、適用する項目を選び直してください。`);
  const seen = new Set<string>();
  const items: Prepared[] = [];
  for (const item of order.items) {
    if (!mcpIsMine(f, item.id)) continue;
    const name = parseMcpName(f.idPrefix, item.id);
    if (name === null || seen.has(item.id)) throw new ApplyError('broken-order', '適用内容が壊れています（項目が重なっているか、読めない項目があります）。Hangar の設定で、適用する項目を選び直してください。');
    seen.add(item.id);
    if (item.target !== f.targetOf(name)) throw new ApplyError('unsafe', `適用内容の書き込み先が項目と一致しません（${item.id}）。書き込みません。`);
    const remoteGone = item.sha256 === '';
    if (item.take === 'mine' && item.op !== 'conflict') throw new ApplyError('broken-order', '適用内容が壊れています（競合でない項目でこの PC の内容を採用する指定があります）。');
    if (item.take === 'remote' && (item.op === 'delete') !== remoteGone && item.op !== 'conflict') throw new ApplyError('broken-order', '適用内容が壊れています（操作と指紋が合いません）。');
    const act: ApplyPlanItem['act'] = item.take === 'mine' ? 'keep' : remoteGone ? 'remove' : 'write';
    let marks: ConfigExecMark[] = [];
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
        try { value = JSON.parse(blob.toString('utf8')); } catch { throw new ApplyError('bad-content', `届いた MCP サーバーの設定が読めません（${item.id}）。`); }
        if (!mcpValueFits(f.kind, value)) throw new ApplyError('bad-content', `届いた MCP サーバーの設定が、この形として読めません（${item.id}）。`);
        if (isHangarEntry(f.kind, name, value)) throw new ApplyError('unsafe', `Hangar 自身の MCP サーバーは書きません（${name}）。`);
        const hold = holdOfMcp(f.kind, value, env);
        if (hold) throw new ApplyError('unsafe', `MCP サーバーの起動コマンドがこの PC にないので、書きません（${hold.path}）。`);
      }
    }
    items.push({ item, name, value, plan: { id: item.id, kind: f.itemKind, op: item.op, take: item.take, label: name, marks, act } });
  }
  return { createdAt: order.createdAt, items };
}

export function planMcp(f: McpFlavor, o: { home: string }, env: McpHoldEnv = {}): ApplyPlan {
  const { createdAt, items } = prepare(f, o.home, env);
  if (items.length === 0) throw new ApplyError('no-order', `適用内容に ${f.name} の項目がありません。`);
  const counts = { create: 0, overwrite: 0, delete: 0, conflictRemote: 0, conflictMine: 0 };
  const plans = items.map((p) => p.plan);
  for (const p of plans) {
    if (p.op === 'conflict') counts[p.take === 'mine' ? 'conflictMine' : 'conflictRemote']++;
    else counts[p.op as ConfigInboxOp & ('create' | 'overwrite' | 'delete')]++;
  }
  // 起動コマンドを足す設定なので、承諾の窓では実行の印を付けて見せる。
  const writes = plans.filter((p) => p.act === 'write');
  return { createdAt, items: plans, counts, byKind: { [f.itemKind]: plans.length }, instructions: 0, exec: writes.filter((p) => p.marks.length > 0) };
}

// ---- 書き込み先 ----

function assertSafeFile(root: string, rel: string): void {
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
    if (i === segs.length - 1 ? !st.isFile() : !st.isDirectory()) throw new ApplyError('unsafe', `書き込み先が通常のファイルまたはディレクトリではありません（${rel}）。書きません。`);
  }
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ApplyError('settings-unreadable', `${path.basename(file)} を読めないので、MCP サーバーの設定は書きません。`);
  }
}

function editText(f: McpFlavor, text: string | null, rel: string, items: Prepared[]): string {
  const edits: McpEdit[] = items.filter((p) => p.plan.act !== 'keep').map((p) => ({ name: p.name, value: p.value, remove: p.plan.act === 'remove' }));
  try { return f.edit(text, rel, edits); } catch (e) {
    if (e instanceof ConfigEditError) throw new ApplyError(e.code === 'parse' || e.code === 'unsupported' ? 'settings-unreadable' : 'write-failed', `${rel} を読めない、または書けないので、MCP サーバーの設定は書きません（${e.message}）。`);
    throw e;
  }
}

/** 確認に出す見立て。何も書かない。 */
export function planMcpFiles(f: McpFlavor, o: { home: string }, env: McpWriteEnv): PlannedFiles {
  const { items } = prepare(f, o.home, env);
  const rel = env.rel;
  const writes = items.filter((p) => p.plan.act !== 'keep');
  const file = fileOf(env.root, rel);
  const before = readText(file);
  if (writes.length === 0) return { files: [], fingerprint: fingerprint(env.root, rel) };
  assertSafeFile(env.root, rel);
  const after = editText(f, before, rel, items);
  const op = before === null ? 'create' : 'modify';
  return { files: [{ rel, path: file, op, lines: diffLines(before ?? '', after).slice(0, 200), binary: false }], fingerprint: fingerprint(env.root, rel) };
}

/** 適用の口（applyAll）の見立て。書く先の中身は read で読む（同じファイルを先に書く対象の結果を重ねるため）。何も書かない。 */
export function planMcpOps(f: McpFlavor, o: { home: string }, env: McpWriteEnv, read: PlanReader): PlannedOp[] {
  const { items } = prepare(f, o.home, env);
  if (!items.some((p) => p.plan.act !== 'keep')) return [];
  assertSafeFile(env.root, env.rel);
  const file = fileOf(env.root, env.rel);
  const cur = read(file);
  return [{ rel: env.rel, path: file, after: editText(f, cur === null ? null : cur.toString('utf8'), env.rel, items) }];
}

function fingerprint(root: string, rel: string): string {
  let b: Buffer | null = null;
  try { b = fs.readFileSync(fileOf(root, rel)); } catch { /* 無いものは null */ }
  return sha256(JSON.stringify([[rel, b === null ? null : sha256(b)]]));
}

// ---- 世代 ----

type GenerationMeta = { version: 1; kind: 'apply'; createdAt: number; created: string[]; createdDirs: string[]; base: Record<string, string | null> };

const backupsDirOf = (home: string, f: McpFlavor): string => path.join(backupsRoot(home), f.backupDir);

function writeAtomic(file: string, data: string, mode: number): void {
  const tmp = `${file}.hangar-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(tmp, data, { mode }); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

function takeGeneration(o: { home: string; f: McpFlavor; root: string; rel: string; baseIds: string[]; base: ConfigBase; now: number }): { name: string; dir: string } {
  const backups = backupsDirOf(o.home, o.f);
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
    const src = fileOf(o.root, o.rel);
    const created: string[] = [];
    if (fs.existsSync(src)) {
      // 秘密が入りうるので、控えは自分専用にする。
      fs.copyFileSync(src, fileOf(dir, o.rel));
      fs.chmodSync(fileOf(dir, o.rel), 0o600);
    } else created.push(o.rel);
    const prev = o.base.all();
    const meta: GenerationMeta = { version: 1, kind: 'apply', createdAt: o.now, created, createdDirs: [], base: Object.fromEntries(o.baseIds.map((id) => [id, prev.get(id) ?? null])) };
    fs.writeFileSync(path.join(dir, GENERATION_META), JSON.stringify(meta) + '\n', { mode: 0o600 });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 作れていなければ消すものも無い */ }
    throw new ApplyError('write-failed', `控えの世代を作れませんでした（${errText(e)}）。何も書いていません。`);
  }
  return { name, dir };
}

function pruneGenerations(home: string, f: McpFlavor): void {
  const root = backupsDirOf(home, f);
  let names: string[];
  try { names = fs.readdirSync(root).filter((n) => STAMP_RE.test(n)).sort(); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - KEEP_GENERATIONS))) {
    try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch { /* 次の機会に回す */ }
  }
}

function rollback(root: string, rel: string, gen: { name: string; dir: string }, cause: unknown): ApplyError {
  try {
    const saved = fileOf(gen.dir, rel);
    if (fs.existsSync(saved)) {
      const dest = fileOf(root, rel);
      let mode = 0o600;
      try { mode = fs.statSync(dest).mode & 0o777; } catch { /* 無ければ自分専用 */ }
      writeAtomic(dest, fs.readFileSync(saved, 'utf8'), mode);
    } else fs.rmSync(fileOf(root, rel), { force: true });
    fs.rmSync(gen.dir, { recursive: true, force: true });
    return new ApplyError('write-failed', `書き込みに失敗したので、元の状態へ戻しました（${errText(cause)}）。`);
  } catch (e2) {
    return new ApplyError('write-failed', `書き込みに失敗し（${errText(cause)}）、元へ戻す途中でも失敗しました（${errText(e2)}）。控えは ${gen.dir} にあります。`);
  }
}

/** 根から MCP の表を取り、自分が書く名前を除いた残りを正規の文字列にする。書く前後で変わっていれば、別のプロセスが書いた。 */
function othersOf(f: McpFlavor, text: string, names: ReadonlySet<string>): string {
  const doc = structuredClone(f.root(text) ?? {}) as Record<string, unknown>;
  let table: unknown = doc;
  for (const seg of f.tablePath) table = isObject(table) ? table[seg] : undefined;
  if (isObject(table)) for (const n of names) delete table[n];
  return canon(doc);
}

/** 指示書のとおりに書く。失敗したら元へ戻し、指示書は残して ApplyError を投げる。 */
export function writeMcp(f: McpFlavor, o: ApplyOptions, env: McpWriteEnv): ApplyResult {
  const now = o.now ? o.now() : Date.now();
  const { items } = prepare(f, o.home, env);
  if (items.length === 0) throw new ApplyError('no-order', `適用内容に ${f.name} の項目がありません。`);
  const rel = env.rel;
  const keptMine = items.filter((p) => p.plan.act === 'keep').length;
  const writes = items.filter((p) => p.plan.act !== 'keep');
  const updateBase = (): void => {
    const base = new ConfigBase(o.db);
    o.db.transaction(() => {
      for (const p of items) {
        if (p.item.sha256 !== '' && p.plan.act !== 'remove') base.set(p.item.id, p.item.sha256, now);
        else base.remove(p.item.id);
      }
    })();
  };
  const done = (generation: string | null): ApplyResult => ({ generation, keptMine, written: generation === null ? 0 : 1, removed: 0, files: generation === null ? [] : [rel] });

  if (writes.length === 0) {
    try { updateBase(); } catch (e) { throw new ApplyError('write-failed', `基準の更新に失敗しました（${errText(e)}）。適用内容は削除していません。`); }
    return done(null);
  }
  assertSafeFile(env.root, rel);
  if (o.expect !== undefined && fingerprint(env.root, rel) !== o.expect) throw new ApplyError('changed', '確認した後に、書く先のファイルが変わりました。何も書いていません。もう一度、書く中身を確かめてください。');

  // 控えを取る前に、今の中身に当てられるかを確かめる（読めない入れ物には、控えも作らず断る）。
  editText(f, readText(fileOf(env.root, rel)), rel, items);

  const gen = takeGeneration({ home: o.home, f, root: env.root, rel, baseIds: items.map((p) => p.item.id), base: new ConfigBase(o.db), now });
  const dest = fileOf(env.root, rel);
  const names = new Set(writes.map((p) => p.name));
  try {
    o.onWrite?.(rel, 0);
    let lastWhy = '';
    let ok = false;
    for (let attempt = 0; attempt < RETRIES && !ok; attempt++) {
      // 書く直前に読み直す。控えを取ったあとに別のプロセスが書いていても、その内容の上に名前の鍵だけを足す。
      const before = readText(dest);
      const after = editText(f, before, rel, items);
      let mode = 0o600;
      try { mode = fs.statSync(dest).mode & 0o777; } catch { /* 新しいファイル */ }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeAtomic(dest, after, mode);
      // 書いた後に読み直し、自分の鍵が入っていて、ほかの鍵が書く前のままかを確かめる。
      const back = readText(dest);
      if (back === null) { lastWhy = '書いた直後にファイルが無くなりました'; continue; }
      const wrong = writes.find((p) => !same(readBack(f, back, p.name), p.plan.act === 'remove' ? undefined : p.value));
      if (wrong) { lastWhy = `書いた MCP サーバー（${wrong.name}）が、読み直しで合いません。別のプロセスに書き換えられた可能性があります`; continue; }
      if (before !== null && othersOf(f, back, names) !== othersOf(f, before, names)) { lastWhy = '書いた直後に、ほかの鍵が別のプロセスに書き換えられました'; continue; }
      ok = true;
    }
    if (!ok) throw new Error(lastWhy);
    updateBase();
  } catch (e) {
    throw rollback(env.root, rel, gen, e);
  }
  pruneGenerations(o.home, f);
  return done(gen.name);
}

function readBack(f: McpFlavor, text: string, name: string): unknown {
  let cur: unknown = f.root(text);
  for (const seg of [...f.tablePath, name]) cur = isObject(cur) ? cur[seg] : undefined;
  return cur;
}
