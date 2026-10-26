import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigApplyOrderItemDto, ConfigInboxOp, ConfigItemKind } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../db/open.ts';
import { ApplyError, planApply, planApplyFiles, runApply, type ApplyOptions } from './apply.ts';
import { listAllBackups, planRestoreTarget, runRestoreTarget } from './applyAll.ts';
import { readApplyOrder, writeApplyOrder } from './applyOrder.ts';
import { ConfigBase } from './base.ts';
import { codexTomlId } from './ids.ts';
import { writeInbox } from './inbox.ts';
import { agentsSkillsId } from './targets/agentsSkills.ts';
import { fakeTarget } from './targets/fakeTarget.ts';
import { registerTarget } from './targets/index.ts';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();

let tmp: string;
let home: string;
let db: Db;
const dirs = () => ({ claudeDir: path.join(tmp, 'claude'), codexHome: path.join(tmp, 'codex'), opencodeDir: path.join(tmp, 'opencode'), agentsSkillsDir: path.join(tmp, 'agents', 'skills') });
const opts = (o: Partial<ApplyOptions> = {}): ApplyOptions => ({ home, db, now: () => NOW, userHome: tmp, ...dirs(), ...o });
const at = (root: keyof ReturnType<typeof dirs>, rel: string): string => path.join(dirs()[root], ...rel.split('/'));
const read = (root: keyof ReturnType<typeof dirs>, rel: string): string | null => { try { return fs.readFileSync(at(root, rel), 'utf8'); } catch { return null; } };
const put = (root: keyof ReturnType<typeof dirs>, rel: string, text: string): void => { fs.mkdirSync(path.dirname(at(root, rel)), { recursive: true }); fs.writeFileSync(at(root, rel), text); };
const gens = (backups: string): string[] => { try { return fs.readdirSync(path.join(home, 'backups', backups)).sort(); } catch { return []; } };
const failOf = (fn: () => unknown): ApplyError => { try { fn(); } catch (e) { if (e instanceof ApplyError) return e; throw e; } throw new Error('投げられなかった'); };

type In = { id: string; kind: ConfigItemKind; op: ConfigInboxOp; content: string | null; target: string };
function deliver(items: In[]): void {
  const blobs = new Map<string, Buffer>();
  const manifestItems = items.filter((i) => i.content !== null).map((i) => { const b = Buffer.from(i.content!); blobs.set(sha(b), b); return { id: i.id, kind: i.kind, sha256: sha(b), size: b.length, marks: [] }; });
  const targets = ['claude', 'claude-plugins', 'codex', 'opencode', 'agents-skills'];
  writeInbox(home, 'dev-b', { manifest: { version: 1, deviceId: 'dev-b', createdAt: NOW, items: manifestItems, targets }, blobs, skipped: 0 }, { bundleSha256: sha('b'), forRowSha256: 'row', at: NOW, itemCount: manifestItems.length, skipped: 0, targets });
  const dtos: ConfigApplyOrderItemDto[] = items.map((o) => ({ id: o.id, kind: o.kind, op: o.op, take: 'remote', fromDeviceId: 'dev-b', sha256: o.content === null ? '' : sha(o.content), target: o.target }));
  writeApplyOrder(home, 'dev-a', dtos, NOW);
}

const claudeFile = (rel: string, content: string): In => ({ id: `file:${rel}`, kind: 'commands', op: 'overwrite', content, target: rel });
const skill = (rel: string, content: string): In => ({ id: agentsSkillsId(rel), kind: 'agents-skills', op: 'create', content, target: rel });
const codexModel = (v: string): In => ({ id: codexTomlId(['model']), kind: 'codex-config', op: 'overwrite', content: JSON.stringify(v), target: 'config.toml#model' });
const ocModel = (v: string): In => ({ id: 'opencode:json:model', kind: 'opencode-config', op: 'create', content: JSON.stringify(v), target: 'opencode.json#model' });

const CODEX_ORIG = '# keep me\nmodel = "old"\n';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-apply-all-'));
  home = path.join(tmp, 'hangar');
  fs.mkdirSync(home);
  db = openDb(':memory:');
  put('claudeDir', 'commands/a.md', 'a0');
  put('codexHome', 'config.toml', CODEX_ORIG);
  fs.mkdirSync(dirs().opencodeDir, { recursive: true });
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const MIXED = (): In[] => [claudeFile('commands/a.md', 'A'), skill('demo/SKILL.md', 'S'), codexModel('new'), ocModel('m')];

describe('指示書を持ち主の対象ごとに分けて書く', () => {
  it('混ざった指示書は、各対象の入れ物にだけ書く（共通のスキルを ~/.claude に書かない）。全部書けたら指示書を消す', () => {
    deliver(MIXED());
    const plan = planApply({ home });
    expect(plan.counts).toMatchObject({ create: 2, overwrite: 2 });
    const r = runApply(opts());
    expect(read('claudeDir', 'commands/a.md')).toBe('A');
    expect(read('agentsSkillsDir', 'demo/SKILL.md')).toBe('S');
    expect(fs.existsSync(at('claudeDir', 'demo/SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(dirs().claudeDir, 'skills'))).toBe(false);
    expect(read('codexHome', 'config.toml')).toBe('# keep me\nmodel = "new"\n');
    expect(JSON.parse(read('opencodeDir', 'opencode.json')!)).toEqual({ model: 'm' });
    expect(readApplyOrder(home)).toBeNull();
    // 控えは対象ごとの置き場に 1 つずつ
    expect(r.generations!.map((g) => g.target).sort()).toEqual(['agents-skills', 'claude', 'codex', 'opencode']);
    for (const b of ['claude-config', 'codex-config', 'opencode-config', 'agents-skills-config']) expect(gens(b)).toHaveLength(1);
    expect(listAllBackups(home).map((g) => g.target ?? 'claude').sort()).toEqual(['agents-skills', 'claude', 'codex', 'opencode']);
    const base = new ConfigBase(db).all();
    for (const i of MIXED()) expect(base.get(i.id)).toBe(sha(i.content!));
  });

  it('見立ての書く先は、対象ごとの入れ物の絶対パスで、対象の名前を添える', () => {
    deliver(MIXED());
    const f = planApplyFiles(opts());
    expect(f.files.map((x) => [x.target, x.path, x.op]).sort()).toEqual([
      ['agents-skills', at('agentsSkillsDir', 'demo/SKILL.md'), 'create'],
      ['claude', at('claudeDir', 'commands/a.md'), 'modify'],
      ['codex', at('codexHome', 'config.toml'), 'modify'],
      ['opencode', at('opencodeDir', 'opencode.json'), 'create'],
    ].sort());
    expect(read('claudeDir', 'commands/a.md')).toBe('a0');
  });

  it('同じ settings.json を 2 つの対象が書くときは、後の対象が前の対象の結果に重ねる（見立ても 1 つにまとめる）', () => {
    put('claudeDir', 'settings.json', '{\n  "theme": "dark"\n}\n');
    deliver([
      { id: 'settings:model', kind: 'settings', op: 'create', content: '"opus"', target: 'settings.json#model' },
      { id: 'settings:enabledPlugins', kind: 'plugins', op: 'create', content: JSON.stringify({ 'p@m': true }), target: 'settings.json#enabledPlugins' },
    ]);
    const f = planApplyFiles(opts());
    expect(f.files).toHaveLength(1);
    const added = f.files[0]!.lines.filter((l) => l.kind === 'add').map((l) => l.text).join('\n');
    expect(added).toContain('"model"');
    expect(added).toContain('"enabledPlugins"');
    runApply(opts({ expect: f.fingerprint }));
    expect(JSON.parse(read('claudeDir', 'settings.json')!)).toEqual({ theme: 'dark', model: 'opus', enabledPlugins: { 'p@m': true } });
  });

  it('書き方を持たない対象の項目があれば、何も書かずに断る', () => {
    const off = registerTarget(fakeTarget('fake'));
    try {
      deliver([claudeFile('commands/a.md', 'A'), { id: 'fake:x', kind: 'codex-file', op: 'create', content: '1', target: 'x' }]);
      expect(failOf(() => runApply(opts())).code).toBe('unknown-target');
      expect(failOf(() => planApplyFiles(opts())).code).toBe('unknown-target');
      expect(read('claudeDir', 'commands/a.md')).toBe('a0');
      expect(readApplyOrder(home)).not.toBeNull();
    } finally { off(); }
  });

  it('持ち主の分からない項目の入った指示書は、読めない指示書として断る（何も書かない）', () => {
    deliver([claudeFile('commands/a.md', 'A'), { id: 'future:thing', kind: 'settings', op: 'create', content: '1', target: 'x' }]);
    expect(failOf(() => runApply(opts())).code).toBe('broken-order');
    expect(read('claudeDir', 'commands/a.md')).toBe('a0');
  });

  it('見立てのあとに、どれかの対象の書く先が変わっていたら、どこにも書かない', () => {
    deliver(MIXED());
    const f = planApplyFiles(opts());
    put('codexHome', 'config.toml', CODEX_ORIG + 'x = 1\n');
    expect(failOf(() => runApply(opts({ expect: f.fingerprint }))).code).toBe('changed');
    expect(read('claudeDir', 'commands/a.md')).toBe('a0');
    expect(fs.existsSync(at('agentsSkillsDir', 'demo/SKILL.md'))).toBe(false);
  });
});

describe('控えが取れなければ 1 バイトも書かない（対象ごと）', () => {
  for (const backups of ['claude-config', 'codex-config', 'opencode-config', 'agents-skills-config']) {
    it(`${backups} の置き場を作れないときは、どの対象にも書かない`, () => {
      fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
      fs.writeFileSync(path.join(home, 'backups', backups), 'a file, not a directory');
      deliver(MIXED());
      const e = failOf(() => runApply(opts()));
      expect(e.code).toBe('write-failed');
      expect(read('claudeDir', 'commands/a.md')).toBe('a0');
      expect(fs.existsSync(dirs().agentsSkillsDir)).toBe(false);
      expect(read('codexHome', 'config.toml')).toBe(CODEX_ORIG);
      expect(fs.existsSync(at('opencodeDir', 'opencode.json'))).toBe(false);
      expect(readApplyOrder(home)).not.toBeNull();
      expect(new ConfigBase(db).all().size).toBe(0);
    });
  }

  it('途中の対象が書けなければ（Codex の config.toml が書いた直後に書き換えられた）、先に書いた対象も戻し、基準も戻す', () => {
    new ConfigBase(db).set('file:commands/a.md', sha('a0'), NOW - 1);
    deliver(MIXED());
    const e = failOf(() => runApply(opts({ afterWrite: (rel) => { if (rel === 'config.toml') fs.appendFileSync(at('codexHome', 'config.toml'), 'sneaky = 1\n'); } })));
    expect(e.code).toBe('write-failed');
    expect(e.message).toContain('ほかの対象に書いた分も、元へ戻しました');
    expect(read('claudeDir', 'commands/a.md')).toBe('a0');
    expect(read('codexHome', 'config.toml')).toBe(CODEX_ORIG);
    expect(fs.existsSync(at('agentsSkillsDir', 'demo/SKILL.md'))).toBe(false);
    expect(fs.existsSync(at('opencodeDir', 'opencode.json'))).toBe(false);
    expect(readApplyOrder(home)).not.toBeNull();
    expect([...new ConfigBase(db).all()]).toEqual([['file:commands/a.md', sha('a0')]]);
    for (const b of ['claude-config', 'codex-config', 'opencode-config', 'agents-skills-config']) expect(gens(b)).toEqual([]);
  });
});

describe('世代へ戻す（対象ごと）', () => {
  it('Codex、opencode、共通のスキル、Claude の世代を、それぞれの入れ物へ戻す', () => {
    deliver(MIXED());
    const r = runApply(opts());
    const name = (t: string): string => r.generations!.find((g) => g.target === t)!.name;

    const cp = planRestoreTarget({ ...opts(), target: 'codex', name: name('codex') });
    expect(cp.restore).toEqual(['config.toml']);
    runRestoreTarget({ ...opts(), target: 'codex', name: name('codex') });
    expect(read('codexHome', 'config.toml')).toBe(CODEX_ORIG);
    expect(read('claudeDir', 'commands/a.md')).toBe('A');

    runRestoreTarget({ ...opts(), target: 'opencode', name: name('opencode') });
    expect(fs.existsSync(at('opencodeDir', 'opencode.json'))).toBe(false);

    const ap = planRestoreTarget({ ...opts(), target: 'agents-skills', name: name('agents-skills') });
    expect(ap.remove).toEqual(['demo/SKILL.md']);
    runRestoreTarget({ ...opts(), target: 'agents-skills', name: name('agents-skills') });
    expect(fs.existsSync(at('agentsSkillsDir', 'demo/SKILL.md'))).toBe(false);

    runRestoreTarget({ ...opts(), name: name('claude') });
    expect(read('claudeDir', 'commands/a.md')).toBe('a0');
    // 戻す前の状態も、同じ対象の置き場に新しい世代として控える
    expect(gens('codex-config')).toHaveLength(2);
    expect(new ConfigBase(db).all().get(codexTomlId(['model']))).toBeUndefined();
  });

  it('知らない対象の世代は断る', () => {
    expect(failOf(() => planRestoreTarget({ ...opts(), target: 'nope', name: '20261027-120000' })).code).toBe('no-generation');
  });
});
