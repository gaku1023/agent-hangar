import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigApplyOrderItemDto, ConfigInboxOp } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixIt } from '../../../../test/platform.ts';
import { openDb, type Db } from '../../../db/open.ts';
import { ApplyError } from '../apply.ts';
import { writeApplyOrder } from '../applyOrder.ts';
import { ConfigBase } from '../base.ts';
import { writeInbox } from '../inbox.ts';
import { judge, type RemoteSnapshot } from '../threeWay.ts';
import { agentsSkillsTarget, planAgentsSkills, runAgentsSkillsApply } from './agentsSkills.ts';
import { allTargets, collectAll, enabledTargetNames, parseTargetItemId, targetNameOfId, type TargetContext } from './index.ts';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
let tmp: string;
let home: string;
let skills: string;
let db: Db;

const ctx = (o: Partial<TargetContext> = {}): TargetContext => ({
  db, deviceId: 'd', home, claudeDir: path.join(tmp, 'claude'), allowedUnsent: new Map(),
  codexHome: path.join(tmp, 'codex'), codexEnabled: true, opencodeDir: path.join(tmp, 'opencode'), opencodeEnabled: false,
  agentsSkillsDir: skills, claudeJsonPath: path.join(tmp, 'claude.json'), hangarSettingsPath: path.join(tmp, 'settings.json'),
  switches: { 'agents-skills': true }, ...o,
});
const put = (rel: string, text: string | Buffer): void => { const f = path.join(skills, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const read = (rel: string): string | null => { try { return fs.readFileSync(path.join(skills, ...rel.split('/')), 'utf8'); } catch { return null; } };
const ids = (c: ReturnType<typeof collectAll>): string[] => c.items.map((i) => i.id);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
  home = path.join(tmp, 'hangar');
  skills = path.join(tmp, 'agents', 'skills');
  fs.mkdirSync(home, { recursive: true });
  db = openDb(':memory:');
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('agents-skills: 集める', () => {
  it('中身全部を agents-skills:<相対> で集める。placeholder ではない', () => {
    expect(agentsSkillsTarget.placeholder).toBeUndefined();
    put('review/SKILL.md', '# review\n');
    put('review/scripts/run.sh', 'echo hi\n');
    put('top.md', 'x');
    const c = collectAll(ctx());
    expect(ids(c)).toEqual(['agents-skills:review/SKILL.md', 'agents-skills:review/scripts/run.sh', 'agents-skills:top.md']);
    const first = c.items[0]!;
    expect(first.kind).toBe('agents-skills');
    expect(first.target).toBe('review/SKILL.md');
    expect(first.marks).toEqual([]);
    expect(c.items[1]!.marks).toEqual(['script']);
    expect(targetNameOfId('agents-skills:top.md')).toBe('agents-skills');
  });

  it('除外の名前、同期の写し、大きすぎるファイルは今の skills と同じに扱う', () => {
    put('a/node_modules/x.js', '1');
    put('a/.git/config', '1');
    put('a/.DS_Store', '1');
    put('a/SKILL.md.conflict-dev', '1');
    put('a/SKILL.md.part', '1');
    put('a/ok.md', '1');
    put('big.bin', Buffer.alloc((1 << 20) + 1));
    const c = collectAll(ctx());
    expect(ids(c)).toEqual(['agents-skills:a/ok.md']);
    expect(c.blocked.ids.has('agents-skills:big.bin')).toBe(true);
  });

  posixIt('リンクは辿らず、同名の項目が届いても上書きされないよう塞ぐ', () => {
    put('real/SKILL.md', 'x');
    fs.symlinkSync(path.join(skills, 'real'), path.join(skills, 'linked'));
    fs.symlinkSync(path.join(skills, 'real', 'SKILL.md'), path.join(skills, 'file-link.md'));
    const c = collectAll(ctx());
    expect(ids(c)).toEqual(['agents-skills:real/SKILL.md']);
    expect(c.blocked.ids.has('agents-skills:linked')).toBe(true);
    expect(c.blocked.prefixes).toContain('agents-skills:linked/');
    expect(c.blocked.ids.has('agents-skills:file-link.md')).toBe(true);
  });

  it('入れ物が無ければ空。秘密らしい文字列があれば送らない印を付ける', () => {
    expect(collectAll(ctx()).items).toEqual([]);
    put('s/SKILL.md', 'key = sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH');
    const c = collectAll(ctx());
    expect(c.items[0]!.withheld).toBe('secret');
    expect(c.unsent.map((u) => u.itemId)).toEqual(['agents-skills:s/SKILL.md']);
  });

  it('id の検査：運ばない場所と不正な相対パスは解けない', () => {
    expect(parseTargetItemId('agents-skills:a/b.md')).toEqual({ kind: 'agents-skills', ref: { type: 'file', rel: 'a/b.md' } });
    for (const bad of ['agents-skills:', 'agents-skills:../x', 'agents-skills:/abs', 'agents-skills:a/node_modules/x', 'agents-skills:a/.git/x', 'agents-skills:a.part']) {
      expect(parseTargetItemId(bad)).toBeNull();
    }
  });
});

describe('agents-skills: 入切と承諾', () => {
  it('Codex か opencode のどちらかが有効で、入のときだけ出す。どちらも無効なら入でも出さない', () => {
    put('a/SKILL.md', 'x');
    const on = (o: Partial<TargetContext>) => enabledTargetNames(ctx(o)).includes('agents-skills');
    expect(on({ codexEnabled: true, opencodeEnabled: false })).toBe(true);
    expect(on({ codexEnabled: false, opencodeEnabled: true })).toBe(true);
    expect(on({ codexEnabled: false, opencodeEnabled: false })).toBe(false);
    expect(on({ switches: {} })).toBe(false);
    expect(ids(collectAll(ctx({ codexEnabled: false, opencodeEnabled: false })))).toEqual([]);
    expect(allTargets().find((t) => t.name === 'agents-skills')!.enabled(ctx({ codexEnabled: false, opencodeEnabled: false }))).toBe(false);
  });

  it('承諾は、消去も含めて全部。自動なら要らない', () => {
    for (const op of ['create', 'overwrite', 'delete', 'conflict'] as ConfigInboxOp[]) {
      expect(agentsSkillsTarget.needsApproval({ id: 'agents-skills:a', kind: 'agents-skills', op }, 'each')).toBe(true);
      expect(agentsSkillsTarget.needsApproval({ id: 'agents-skills:a', kind: 'agents-skills', op }, 'auto')).toBe(false);
    }
    expect(agentsSkillsTarget.isMachineBound({ id: 'agents-skills:a', kind: 'agents-skills', content: Buffer.from('') })).toBe(false);
  });

  it('古い版の束（targets に無い）を受けても、消去にも forget にも見えない', () => {
    const m = (o: Record<string, string>) => new Map(Object.entries(o));
    const old: RemoteSnapshot = { deviceId: 'B', at: 10, items: new Map() };
    const j = judge({ local: m({ 'agents-skills:a/SKILL.md': 'x' }), base: m({ 'agents-skills:a/SKILL.md': 'x' }), remotes: [old] });
    expect(j.actions).toEqual([]);
    expect(j.forget).toEqual([]);
    const withTarget: RemoteSnapshot = { deviceId: 'C', at: 10, items: new Map(), targets: new Set(['claude', 'agents-skills']) };
    expect(judge({ local: m({ 'agents-skills:a/SKILL.md': 'x' }), base: m({ 'agents-skills:a/SKILL.md': 'x' }), remotes: [withTarget] }).actions.map((a) => a.op)).toEqual(['delete']);
  });
});

describe('agents-skills: 書き戻し', () => {
  function inbox(items: Record<string, string>, at = NOW): void {
    const blobs = new Map<string, Buffer>();
    const mi = Object.entries(items).map(([id, content]) => { const b = Buffer.from(content); blobs.set(sha(b), b); return { id, kind: 'agents-skills' as const, sha256: sha(b), size: b.length, marks: [] }; });
    writeInbox(home, 'dev-b', { manifest: { version: 1, deviceId: 'dev-b', createdAt: at, items: mi }, blobs, skipped: 0 }, { bundleSha256: sha('b' + at), forRowSha256: 'row', at, itemCount: mi.length, skipped: 0 });
  }
  const oi = (id: string, op: ConfigInboxOp, content: string | null, take: 'remote' | 'mine' = 'remote'): ConfigApplyOrderItemDto =>
    ({ id, kind: 'agents-skills', op, take, fromDeviceId: 'dev-b', sha256: content === null ? '' : sha(content), target: id.slice('agents-skills:'.length) });
  const order = (...items: ConfigApplyOrderItemDto[]): void => { writeApplyOrder(home, 'dev-a', items, NOW); };
  const opts = (o: Record<string, unknown> = {}) => ({ home, claudeDir: path.join(tmp, 'claude'), agentsSkillsDir: skills, db, now: () => NOW, ...o });
  const gens = (): string[] => { try { return fs.readdirSync(path.join(home, 'backups', 'agents-skills-config')); } catch { return []; } };

  it('作る・上書き・消す。控えは backups/agents-skills-config/<時刻>/、基準も更新する', () => {
    put('old/SKILL.md', 'mine-old');
    put('gone/SKILL.md', 'bye');
    inbox({ 'agents-skills:new/SKILL.md': 'new', 'agents-skills:old/SKILL.md': 'theirs' });
    order(oi('agents-skills:new/SKILL.md', 'create', 'new'), oi('agents-skills:old/SKILL.md', 'overwrite', 'theirs'), oi('agents-skills:gone/SKILL.md', 'delete', null));
    const plan = agentsSkillsTarget.planWrite({ home });
    expect(plan.counts).toMatchObject({ create: 1, overwrite: 1, delete: 1 });
    expect(plan.byKind).toEqual({ 'agents-skills': 3 });
    const r = agentsSkillsTarget.write(opts());
    expect(r).toMatchObject({ written: 2, removed: 1, keptMine: 0 });
    expect(read('new/SKILL.md')).toBe('new');
    expect(read('old/SKILL.md')).toBe('theirs');
    expect(read('gone/SKILL.md')).toBeNull();
    expect(gens()).toEqual(['20261010-120000']);
    const g = path.join(home, 'backups', 'agents-skills-config', '20261010-120000');
    expect(fs.readFileSync(path.join(g, 'old', 'SKILL.md'), 'utf8')).toBe('mine-old');
    expect(fs.readFileSync(path.join(g, 'gone', 'SKILL.md'), 'utf8')).toBe('bye');
    const base = new ConfigBase(db).all();
    expect(base.get('agents-skills:new/SKILL.md')).toBe(sha('new'));
    expect(base.has('agents-skills:gone/SKILL.md')).toBe(false);
  });

  it('途中で失敗したら元へ戻す（作ったファイルも消える）', () => {
    put('a/SKILL.md', 'mine');
    inbox({ 'agents-skills:a/SKILL.md': 'theirs', 'agents-skills:b/SKILL.md': 'b' });
    order(oi('agents-skills:a/SKILL.md', 'overwrite', 'theirs'), oi('agents-skills:b/SKILL.md', 'create', 'b'));
    expect(() => runAgentsSkillsApply(opts({ onWrite: (_r: string, i: number) => { if (i === 1) throw new Error('boom'); } }))).toThrow(ApplyError);
    expect(read('a/SKILL.md')).toBe('mine');
    expect(read('b/SKILL.md')).toBeNull();
    expect(fs.existsSync(path.join(skills, 'b'))).toBe(false);
    expect(gens()).toEqual([]);
  });

  it('控えを取れなければ書かない', () => {
    fs.writeFileSync(path.join(home, 'backups'), 'not a dir');
    inbox({ 'agents-skills:a/SKILL.md': 'x' });
    order(oi('agents-skills:a/SKILL.md', 'create', 'x'));
    expect(() => runAgentsSkillsApply(opts())).toThrow(/何も書いていません/);
    expect(read('a/SKILL.md')).toBeNull();
  });

  posixIt('途中にリンクがあれば、リンクの先へ書かず断る', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(outside, path.join(skills, 'evil'));
    inbox({ 'agents-skills:evil/SKILL.md': 'x' });
    order(oi('agents-skills:evil/SKILL.md', 'create', 'x'));
    expect(() => runAgentsSkillsApply(opts())).toThrow(/シンボリックリンク/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('受信内容と合わない指示書、ほかの対象の項目だけの指示書は断る', () => {
    inbox({ 'agents-skills:a/SKILL.md': 'x' });
    order(oi('agents-skills:a/SKILL.md', 'create', 'changed'));
    expect(() => runAgentsSkillsApply(opts())).toThrow(/一致しません/);
    order({ id: 'file:CLAUDE.md', kind: 'claude-md', op: 'create', take: 'remote', fromDeviceId: 'dev-b', sha256: sha('c'), target: 'CLAUDE.md' });
    expect(() => planAgentsSkills({ home })).toThrow(ApplyError);
    order(oi('agents-skills:a/SKILL.md', 'create', 'x'));
    expect(() => runAgentsSkillsApply({ ...opts(), agentsSkillsDir: undefined })).toThrow(ApplyError);
  });

  it('競合で手元を採る項目は書かず、基準だけ相手に合わせる', () => {
    put('a/SKILL.md', 'mine');
    inbox({ 'agents-skills:a/SKILL.md': 'theirs' });
    order(oi('agents-skills:a/SKILL.md', 'conflict', 'theirs', 'mine'));
    const r = runAgentsSkillsApply(opts());
    expect(r).toMatchObject({ generation: null, written: 0, keptMine: 1 });
    expect(read('a/SKILL.md')).toBe('mine');
    expect(new ConfigBase(db).all().get('agents-skills:a/SKILL.md')).toBe(sha('theirs'));
    expect(gens()).toEqual([]);
  });
});
