import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigApplyOrderItemDto, ConfigInboxOp, ConfigItemKind } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../db/open.ts';
import { ApplyError, runApply } from './apply.ts';
import { writeApplyOrder } from './applyOrder.ts';
import { listBackups } from './backups.ts';
import { ConfigBase } from './base.ts';
import { listHistory } from './history.ts';
import { writeInbox } from './inbox.ts';
import { planRestoreItem, restorableItem, restoreHistory, restoreItem, withRestorable } from './restoreItem.ts';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();

let tmp: string;
let home: string;
let claudeDir: string;
let db: Db;
let clock: number;

const abs = (rel: string): string => path.join(claudeDir, ...rel.split('/'));
const write = (rel: string, text: string): void => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text); };
const read = (rel: string): string | null => { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; } };
const exists = (rel: string): boolean => fs.existsSync(abs(rel));
const ctx = () => ({ home, claudeDir, db, now: () => clock });
const base = () => new ConfigBase(db).all();
const fail = (fn: () => unknown): ApplyError => { try { fn(); } catch (e) { if (e instanceof ApplyError) return e; throw e; } throw new Error('投げられなかった'); };
const history = () => listHistory(db, () => null);

type In = { id: string; kind: ConfigItemKind; op: ConfigInboxOp; content: string | null; target: string };
const fileIn = (rel: string, op: ConfigInboxOp, content: string | null, kind: ConfigItemKind = 'commands'): In => ({ id: `file:${rel}`, kind, op, content, target: rel });
const keyIn = (key: string, op: ConfigInboxOp, value: unknown | null): In => ({ id: `settings:${key}`, kind: 'settings', op, content: value === null ? null : JSON.stringify(value), target: `settings.json#${key}` });

/** 他の PC の束と指示書を作り、適用する。履歴に 1 行できる。 */
function applyAll(...items: In[]): number {
  const blobs = new Map<string, Buffer>();
  const manifestItems = items.filter((i) => i.content !== null).map((i) => {
    const b = Buffer.from(i.content!);
    blobs.set(sha(b), b);
    return { id: i.id, kind: i.kind, sha256: sha(b), size: b.length, marks: [] };
  });
  writeInbox(home, 'dev-b', { manifest: { version: 1, deviceId: 'dev-b', createdAt: NOW, items: manifestItems }, blobs, skipped: 0 }, { bundleSha256: sha('b' + items.length), forRowSha256: 'row', at: NOW, itemCount: manifestItems.length, skipped: 0 });
  const order: ConfigApplyOrderItemDto[] = items.map((i) => ({ id: i.id, kind: i.kind, op: i.op, take: 'remote', fromDeviceId: 'dev-b', sha256: i.content === null ? '' : sha(i.content), target: i.target }));
  writeApplyOrder(home, 'dev-a', order, NOW);
  runApply(ctx());
  clock += 60_000;
  return history()[0]!.id;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-restore-item-'));
  home = path.join(tmp, 'home');
  claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(home);
  fs.mkdirSync(claudeDir);
  db = openDb(':memory:');
  clock = NOW;
});
afterEach(() => { try { db.close(); } catch { /* 閉じ済み */ } fs.rmSync(tmp, { recursive: true, force: true }); });

function seed(): number {
  write('commands/over.md', 'old');
  write('commands/del.md', 'bye');
  write('settings.json', '{\n  "model": "sonnet"\n}\n');
  const b = new ConfigBase(db);
  b.set('file:commands/over.md', sha('old'), NOW);
  b.set('file:commands/del.md', sha('bye'), NOW);
  b.set('settings:model', sha('"sonnet"'), NOW);
  return applyAll(
    fileIn('skills/x/SKILL.md', 'create', 'S', 'skills'),
    fileIn('commands/over.md', 'overwrite', 'O'),
    fileIn('commands/del.md', 'delete', null),
    keyIn('model', 'overwrite', 'opus'),
    keyIn('theme', 'create', 'dark'),
  );
}

describe('1 項目の戻し', () => {
  it('上書きした 1 項目だけが前の中身へ戻り、ほかの項目と手で足したファイルはそのまま。基準も戻り、戻す前を世代に控え、undone に入る', () => {
    const id = seed();
    write('commands/hand.md', 'mine');
    const r = restoreItem({ ...ctx(), historyId: id, itemId: 'file:commands/over.md' });
    expect(read('commands/over.md')).toBe('old');
    expect(read('commands/del.md')).toBeNull();
    expect(read('skills/x/SKILL.md')).toBe('S');
    expect(read('commands/hand.md')).toBe('mine');
    expect(JSON.parse(read('settings.json')!)).toEqual({ model: 'opus', theme: 'dark' });
    expect(base().get('file:commands/over.md')).toBe(sha('old'));
    expect(base().get('settings:model')).toBe(sha('"opus"'));
    expect(r.items).toEqual(['file:commands/over.md']);
    expect(r.restored).toEqual(['commands/over.md']);
    expect(r.safety).not.toBeNull();
    expect(listBackups(home).map((g) => g.name)).toContain(r.safety);
    expect(history()[0]!.undone).toEqual(['file:commands/over.md']);
    // 戻す前の状態の世代から戻せば、取り消せる。
    clock += 60_000;
    restoreItem({ ...ctx(), generation: r.safety!, target: 'claude', itemId: 'file:commands/over.md' });
    expect(read('commands/over.md')).toBe('O');
  });

  it('作られた項目（create）を戻すと消える。そのとき作られたディレクトリも空なら消える', () => {
    const id = seed();
    restoreItem({ ...ctx(), historyId: id, itemId: 'file:skills/x/SKILL.md' });
    expect(exists('skills/x/SKILL.md')).toBe(false);
    expect(exists('skills')).toBe(false);
    expect(read('commands/over.md')).toBe('O');
    expect(base().has('file:skills/x/SKILL.md')).toBe(false);
  });

  it('消された項目（delete）を戻すと元の中身で復活する', () => {
    const id = seed();
    restoreItem({ ...ctx(), historyId: id, itemId: 'file:commands/del.md' });
    expect(read('commands/del.md')).toBe('bye');
    expect(base().get('file:commands/del.md')).toBe(sha('bye'));
  });

  it('settings の 1 鍵が戻る。前に無かった鍵は消え、ほかの鍵は残る', () => {
    const id = seed();
    restoreItem({ ...ctx(), historyId: id, itemId: 'settings:model' });
    expect(JSON.parse(read('settings.json')!)).toEqual({ model: 'sonnet', theme: 'dark' });
    clock += 60_000;
    restoreItem({ ...ctx(), historyId: id, itemId: 'settings:theme' });
    expect(JSON.parse(read('settings.json')!)).toEqual({ model: 'sonnet' });
    expect([...history()[0]!.undone].sort()).toEqual(['settings:model', 'settings:theme']);
  });

  it('世代と対象と項目を直に指しても戻せる（履歴には載せない）', () => {
    seed();
    const gen = history()[0]!.generations[0]!;
    restoreItem({ ...ctx(), generation: gen.name, target: gen.target, itemId: 'file:commands/over.md' });
    expect(read('commands/over.md')).toBe('old');
    expect(history()[0]!.undone).toEqual([]);
  });

  it('同じ項目を 2 度は戻せない。その行に無い項目と、無い行は断る', () => {
    const id = seed();
    restoreItem({ ...ctx(), historyId: id, itemId: 'file:commands/over.md' });
    expect(fail(() => restoreItem({ ...ctx(), historyId: id, itemId: 'file:commands/over.md' })).code).toBe('already-undone');
    expect(fail(() => restoreItem({ ...ctx(), historyId: id, itemId: 'file:commands/none.md' })).code).toBe('not-in-history');
    expect(fail(() => restoreItem({ ...ctx(), historyId: 9999, itemId: 'file:commands/over.md' })).code).toBe('no-history');
  });

  it('見せた後に書く先が変わっていたら、何も戻さない', () => {
    const id = seed();
    const plan = planRestoreItem({ ...ctx(), historyId: id, itemId: 'file:commands/over.md' });
    expect(plan.restore).toEqual(['commands/over.md']);
    expect(plan.files.map((f) => f.rel)).toEqual(['commands/over.md']);
    write('commands/over.md', 'changed meanwhile');
    expect(fail(() => restoreItem({ ...ctx(), historyId: id, itemId: 'file:commands/over.md', expect: plan.fingerprint })).code).toBe('changed');
    expect(read('commands/over.md')).toBe('changed meanwhile');
  });
});

describe('履歴の 1 回分をまとめて戻す', () => {
  it('その行の全項目が戻り、undone に全部入る。戻す前の世代は 1 つ', () => {
    const id = seed();
    const before = listBackups(home).length;
    const r = restoreHistory({ ...ctx(), historyId: id });
    expect(read('commands/over.md')).toBe('old');
    expect(read('commands/del.md')).toBe('bye');
    expect(exists('skills/x/SKILL.md')).toBe(false);
    expect(JSON.parse(read('settings.json')!)).toEqual({ model: 'sonnet' });
    expect(base().get('file:commands/over.md')).toBe(sha('old'));
    expect(base().has('file:skills/x/SKILL.md')).toBe(false);
    expect([...history()[0]!.undone].sort()).toEqual(history()[0]!.items.map((i) => i.id).sort());
    expect(listBackups(home).length).toBe(before + 1);
    expect(r.items.length).toBe(5);
    expect(fail(() => restoreHistory({ ...ctx(), historyId: id })).code).toBe('already-undone');
  });

  it('一部が戻し済みなら、残りだけを戻す', () => {
    const id = seed();
    restoreItem({ ...ctx(), historyId: id, itemId: 'file:commands/over.md' });
    clock += 60_000;
    const r = restoreHistory({ ...ctx(), historyId: id });
    expect(r.items).not.toContain('file:commands/over.md');
    expect(r.items.length).toBe(4);
  });
});

describe('戻せない項目', () => {
  const hangarItem = { id: 'hangar:askStatusAtEnd', kind: 'hangar-pref', label: 'askStatusAtEnd', op: 'overwrite' };
  const addHangar = (id: number): void => {
    db.prepare('update config_history set items = ? where id = ?').run(JSON.stringify([...history()[0]!.items, hangarItem]), id);
  };

  it('hangar の好みは控えの世代が無いので戻せない。dto に戻せるかが出て、世代が消えたら全部戻せない', () => {
    expect(restorableItem('hangar:askStatusAtEnd')).toBe(false);
    expect(restorableItem('file:commands/a.md')).toBe(true);
    expect(restorableItem('settings:model')).toBe(true);
    const id = seed();
    const gen = history()[0]!.generations[0]!;
    addHangar(id);
    expect(fail(() => restoreItem({ ...ctx(), historyId: id, itemId: 'hangar:askStatusAtEnd' })).code).toBe('unsupported');
    const dto = withRestorable(history(), home);
    expect(dto[0]!.items.find((i) => i.id === 'hangar:askStatusAtEnd')!.restorable).toBe(false);
    expect(dto[0]!.items.find((i) => i.id === 'file:commands/over.md')!.restorable).toBe(true);
    fs.rmSync(path.join(home, 'backups', 'claude-config', gen.name), { recursive: true });
    expect(withRestorable(history(), home)[0]!.items.every((i) => i.restorable === false)).toBe(true);
    expect(fail(() => restoreItem({ ...ctx(), historyId: id, itemId: 'file:commands/over.md' })).code).toBe('no-generation');
  });

  it('まとめて戻すとき、戻せない項目は飛ばして残りを戻す', () => {
    const id = seed();
    addHangar(id);
    const r = restoreHistory({ ...ctx(), historyId: id });
    expect(r.items).not.toContain('hangar:askStatusAtEnd');
    expect(read('commands/over.md')).toBe('old');
  });
});
