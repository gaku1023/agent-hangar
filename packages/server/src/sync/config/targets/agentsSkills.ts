import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSafeRelPath, type ConfigExecMark } from '@agent-hangar/shared';
import { ApplyError, type ApplyOptions, type ApplyPlan, type ApplyPlanItem, type ApplyResult } from '../apply.ts';
import { readApplyOrder } from '../applyOrder.ts';
import { GENERATION_META, STAMP_RE, stampLabel } from '../backups.ts';
import { ConfigBase } from '../base.ts';
import { MAX_ITEM_BYTES } from '../bundle.ts';
import { execMarksOf, type Blocked, type Collected, type LocalItem, type UnsentCandidate } from '../collect.ts';
import { kindOfRel } from '../ids.ts';
import { readInbox, readInboxBlob } from '../inbox.ts';
import { findSecret } from '../secrets.ts';
import { backupsRoot } from '../../../config/cloud.ts';
import type { ConfigTarget } from './types.ts';

/**
 * 共通の skills（`~/.agents/skills`、Codex と opencode が読む）。中身全部を `agents-skills:<相対>` で運ぶ。
 * 除外の決まり（node_modules、.git などの名前、同期自身の写し、1 MiB 超、リンク）は Claude の skills と同じ。
 * 古い版は運ばない項目なので別の対象にしてある（古い版の束を受けても消去に見えない）。
 * 書き戻しは Claude と同じ作法（先の元の中身を控える、途中で失敗したら戻す）で、控えは `backups/agents-skills-config/<時刻>/`。
 * 控えを取れなければ書かない。CLI と殻への接続は S11。
 */
export const AGENTS_SKILLS_NAME = 'agents-skills';
const PREFIX = `${AGENTS_SKILLS_NAME}:`;
const MAX_ITEMS = 5000;
const KEEP_GENERATIONS = 20;
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv']);

export const agentsSkillsId = (rel: string): string => `${PREFIX}${rel}`;

/** 運ぶ相対パスか。Claude の skills と同じ物差し（安全な相対パス、除外の名前、同期自身の写し）に通す。 */
const carriedRel = (rel: string): boolean => isSafeRelPath(rel) && kindOfRel(`skills/${rel}`) === 'skills';

export const agentsBackupsDir = (home: string): string => path.join(backupsRoot(home), 'agents-skills-config');

const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
const toPosix = (p: string): string => p.split(path.sep).join('/');
const fileOf = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- 集める ----

function readRegular(abs: string): { content: Buffer; mtime: number } | 'absent' | 'blocked' {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'blocked'; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_ITEM_BYTES) return 'blocked';
  try { return { content: fs.readFileSync(abs), mtime: Math.floor(st.mtimeMs) }; } catch { return 'blocked'; }
}

/** リンクと読めないディレクトリは辿らず onLink へ。除外の名前のディレクトリは降りない。 */
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

function collectSkills(root: string, allowedUnsent: ReadonlyMap<string, string>, maxItems: number): Collected {
  const blocked: Blocked = { ids: new Set(), prefixes: [] };
  const items: LocalItem[] = [];
  const unsent: UnsentCandidate[] = [];
  const out: Collected = { items, dropped: [], unsent, blocked };
  let st: fs.Stats;
  try { st = fs.statSync(root); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') blocked.prefixes.push(PREFIX); return out; }
  if (!st.isDirectory()) { blocked.prefixes.push(PREFIX); return out; }
  const blockRel = (rel: string): void => { blocked.ids.add(agentsSkillsId(rel)); blocked.prefixes.push(`${agentsSkillsId(rel)}/`); };
  const abss = walk(root, (link) => { const rel = toPosix(path.relative(root, link)); if (rel !== '') blockRel(rel); else blocked.prefixes.push(PREFIX); }).sort();
  for (const abs of abss) {
    const rel = toPosix(path.relative(root, abs));
    if (!carriedRel(rel)) continue;
    const id = agentsSkillsId(rel);
    const f = readRegular(abs);
    if (f === 'absent') continue;
    if (f === 'blocked') { blocked.ids.add(id); continue; }
    if (items.length >= maxItems) { blocked.ids.add(id); continue; }
    const hash = sha256(f.content);
    let withheld: 'secret' | null = null;
    if (!f.content.includes(0)) {
      const found = findSecret(f.content.toString('utf8'));
      if (found) {
        const uid = `secret:${id}`;
        const allowed = allowedUnsent.get(uid) === hash;
        unsent.push({ id: uid, kind: 'secret', itemId: id, label: rel, reason: `secret:${found}`, contentSha256: hash, allowed });
        if (!allowed) withheld = 'secret';
      }
    }
    // 実行の印は skills の決まり（拡張子、フロントマターの hooks、本文の !）をそのまま当てる。
    const marks: ConfigExecMark[] = execMarksOf(`skills/${rel}`, f.content);
    items.push({ id, kind: 'agents-skills', label: rel, sha256: hash, size: f.content.length, marks, content: f.content, mtime: f.mtime, target: rel, withheld });
  }
  return out;
}

// ---- 書き戻し ----

type Prep = { id: string; rel: string; sha: string; act: 'write' | 'remove' | 'keep'; plan: ApplyPlanItem; content: Buffer | null };

function prepare(home: string): Prep[] {
  const order = readApplyOrder(home);
  const mine = order ? order.items.filter((i) => i.id.startsWith(PREFIX)) : [];
  if (mine.length === 0) throw new ApplyError('no-order', '適用内容に、共通のスキルの項目がありません。');
  const inbox = readInbox(home);
  const stale = (id: string): ApplyError => new ApplyError('stale', `適用内容の項目が、現在の受信内容と一致しません（${id}）。他の PC の設定が更新された可能性があります。Hangar の設定で、適用する項目を選び直してください。`);
  const seen = new Set<string>();
  const out: Prep[] = [];
  for (const item of mine) {
    const rel = item.id.slice(PREFIX.length);
    if (!carriedRel(rel) || seen.has(item.id)) throw new ApplyError('broken-order', '適用内容が壊れています（項目が重なっているか、運ばない場所を指しています）。Hangar の設定で、適用する項目を選び直してください。');
    seen.add(item.id);
    if (item.target !== rel) throw new ApplyError('unsafe', `適用内容の書き込み先が項目と一致しません（${item.id}）。書き込みません。`);
    const remoteGone = item.sha256 === '';
    if (item.take === 'mine' && item.op !== 'conflict') throw new ApplyError('broken-order', '適用内容が壊れています（競合でない項目でこの PC の内容を採用する指定があります）。');
    if (item.take === 'remote' && (item.op === 'delete') !== remoteGone && item.op !== 'conflict') throw new ApplyError('broken-order', '適用内容が壊れています（操作と指紋が合いません）。');
    const act = item.take === 'mine' ? 'keep' : remoteGone ? 'remove' : 'write';
    let marks: ConfigExecMark[] = [];
    let content: Buffer | null = null;
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
      }
    }
    out.push({ id: item.id, rel, sha: item.sha256, act, content, plan: { id: item.id, kind: 'agents-skills', op: item.op, take: item.take, label: rel, marks, act } });
  }
  return out;
}

/** 確認に出す見立て。何も書かない。共通のスキルの項目だけを数える。 */
export function planAgentsSkills(o: { home: string }): ApplyPlan {
  const preps = prepare(o.home);
  const counts = { create: 0, overwrite: 0, delete: 0, conflictRemote: 0, conflictMine: 0 };
  const plans = preps.map((p) => p.plan);
  for (const p of plans) {
    if (p.op === 'conflict') counts[p.take === 'mine' ? 'conflictMine' : 'conflictRemote']++;
    else counts[p.op]++;
  }
  const writes = plans.filter((p) => p.act === 'write');
  const createdAt = readApplyOrder(o.home)?.createdAt ?? 0;
  // 共通の skills は、Codex と opencode が読んで実行する指示なので、書く分は全部「指示」に数える。
  return { createdAt, items: plans, counts, byKind: { 'agents-skills': plans.length }, instructions: writes.length, exec: writes.filter((p) => p.marks.length > 0) };
}

/** root の下の相対パスが書いてよい場所か。途中にリンクがある、途中がディレクトリでない、末尾が通常のファイルでない、なら ApplyError。root 自体がリンクなのは構わない。 */
function assertSafeTarget(root: string, rel: string): void {
  if (!carriedRel(rel)) throw new ApplyError('unsafe', `書き込み先の形が不正です（${rel}）。書きません。`);
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

function writeAtomic(file: string, data: Buffer, mode: number): void {
  const tmp = `${file}.hangar-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(tmp, data, { mode }); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

type Meta = { version: 1; kind: 'apply'; createdAt: number; created: string[]; createdDirs: string[]; base: Record<string, string | null> };

/** 先の元の中身を新しい世代に控える。取れなければ ApplyError で、何も書いていない。 */
function takeGeneration(o: { home: string; root: string; rels: string[]; baseIds: string[]; base: ConfigBase; now: number }): { name: string; dir: string } {
  const backups = agentsBackupsDir(o.home);
  let name = stampLabel(o.now);
  let dir = '';
  try {
    fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
    let ts = o.now;
    for (let tries = 0; ; tries++) {
      try { fs.mkdirSync(path.join(backups, name), { mode: 0o700 }); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 3600) throw e;
        ts += 1000;
        name = stampLabel(ts);
      }
    }
    dir = path.join(backups, name);
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
    const meta: Meta = { version: 1, kind: 'apply', createdAt: o.now, created, createdDirs: [...createdDirs], base: Object.fromEntries(o.baseIds.map((id) => [id, prev.get(id) ?? null])) };
    fs.writeFileSync(path.join(dir, GENERATION_META), JSON.stringify(meta) + '\n', { mode: 0o600 });
  } catch (e) {
    if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
    throw new ApplyError('write-failed', `控えの世代を作れませんでした（${errText(e)}）。何も書いていません。`);
  }
  return { name, dir };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) rec(path.join(d, e.name), r);
      else if (!(rel === '' && e.name === GENERATION_META)) out.push(r);
    }
  };
  rec(dir, '');
  return out.sort();
}

function rollback(root: string, gen: { name: string; dir: string }, cause: unknown): ApplyError {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(gen.dir, GENERATION_META), 'utf8')) as Meta;
    for (const rel of listFiles(gen.dir)) {
      const dest = fileOf(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeAtomic(dest, fs.readFileSync(fileOf(gen.dir, rel)), 0o644);
    }
    for (const rel of meta.created) fs.rmSync(fileOf(root, rel), { force: true });
    for (const d of [...meta.createdDirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
      try { fs.rmdirSync(fileOf(root, d)); } catch { /* 空でなければ利用者の物が入っているので残す */ }
    }
    fs.rmSync(gen.dir, { recursive: true, force: true });
    return new ApplyError('write-failed', `書き込みに失敗したので、元の状態へ戻しました（${errText(cause)}）。`);
  } catch (e2) {
    return new ApplyError('write-failed', `書き込みに失敗し（${errText(cause)}）、元へ戻す途中でも失敗しました（${errText(e2)}）。控えの世代 ${gen.name}（${agentsBackupsDir('<hangar の置き場>')}）から手で戻してください。`);
  }
}

function pruneGenerations(home: string): void {
  const root = agentsBackupsDir(home);
  let names: string[];
  try { names = fs.readdirSync(root).filter((n) => STAMP_RE.test(n)).sort(); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - KEEP_GENERATIONS))) {
    try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch { /* 次の機会に回す */ }
  }
}

function fingerprint(root: string, rels: string[]): string {
  const parts = [...new Set(rels)].sort().map((rel) => { try { return [rel, sha256(fs.readFileSync(fileOf(root, rel)))]; } catch { return [rel, null]; } });
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** write に渡す口。agentsSkillsDir は S11 が殻と CLI から渡す（ApplyOptions は claudeDir しか持たない）。 */
export type AgentsSkillsWriteOptions = ApplyOptions & { agentsSkillsDir?: string };

/** 指示書のうち共通のスキルの項目を `~/.agents/skills` へ書く。失敗したら元へ戻して ApplyError。指示書そのものは消さない（ほかの対象の項目が残るため。消すのは S11）。 */
export function runAgentsSkillsApply(o: AgentsSkillsWriteOptions): ApplyResult {
  const root = o.agentsSkillsDir;
  if (!root) throw new ApplyError('unsafe', '共通のスキルの置き場が指定されていません。書きません。');
  const now = o.now ? o.now() : Date.now();
  const preps = prepare(o.home);
  const ops = preps.filter((p) => p.act !== 'keep');
  for (const p of ops) assertSafeTarget(root, p.rel);
  if (o.expect !== undefined && fingerprint(root, ops.map((p) => p.rel)) !== o.expect) {
    throw new ApplyError('changed', '確認した後に、書く先のファイルが変わりました。何も書いていません。もう一度、書く中身を確かめてください。');
  }
  const base = new ConfigBase(o.db);
  const updateBase = (): void => {
    o.db.transaction(() => {
      for (const p of preps) { if (p.sha !== '' && p.act !== 'remove') base.set(p.id, p.sha, now); else base.remove(p.id); }
    })();
  };
  const result = (generation: string | null): ApplyResult => ({
    generation, keptMine: preps.length - ops.length,
    written: ops.filter((p) => p.act === 'write').length, removed: ops.filter((p) => p.act === 'remove').length,
    files: ops.map((p) => p.rel),
  });
  if (ops.length === 0) {
    try { updateBase(); } catch (e) { throw new ApplyError('write-failed', `基準の更新に失敗しました（${errText(e)}）。`); }
    return result(null);
  }
  const gen = takeGeneration({ home: o.home, root, rels: ops.map((p) => p.rel), baseIds: preps.map((p) => p.id), base, now });
  try {
    ops.forEach((p, i) => {
      o.onWrite?.(p.rel, i);
      const dest = fileOf(root, p.rel);
      if (p.act === 'remove') { fs.rmSync(dest, { force: true }); return; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let mode = 0o644;
      try { mode = fs.statSync(dest).mode & 0o777; } catch { /* 新しいファイル */ }
      writeAtomic(dest, p.content!, mode);
    });
    updateBase();
  } catch (e) {
    throw rollback(root, gen, e);
  }
  pruneGenerations(o.home);
  return result(gen.name);
}

export const agentsSkillsTarget: ConfigTarget = {
  name: AGENTS_SKILLS_NAME,
  owns: (id) => id.startsWith(PREFIX),
  parseId: (id) => {
    if (!id.startsWith(PREFIX)) return null;
    const rel = id.slice(PREFIX.length);
    return carriedRel(rel) ? { kind: 'agents-skills', ref: { type: 'file', rel } } : null;
  },
  // Codex か opencode のどちらかがその PC で有効で、設定の configTargets が入のときだけ。
  enabled: (ctx) => (ctx.codexEnabled || ctx.opencodeEnabled) && ctx.switches?.[AGENTS_SKILLS_NAME] === true,
  collect: (ctx) => collectSkills(ctx.agentsSkillsDir, ctx.allowedUnsent, ctx.maxItems ?? MAX_ITEMS),
  planWrite: (o) => planAgentsSkills(o),
  write: (o) => runAgentsSkillsApply(o),
  // 読まれて実行される指示なので、消去も含めて全部。承諾の仕方が自動なら要らない。
  needsApproval: (_item, approval) => approval === 'each',
  isMachineBound: () => false,
};
