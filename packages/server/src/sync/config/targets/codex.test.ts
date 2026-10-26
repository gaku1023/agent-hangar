import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigApplyOrderItemDto, ConfigInboxOp, ConfigItemKind } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixIt } from '../../../../test/platform.ts';
import { openDb, type Db } from '../../../db/open.ts';
import { ApplyError } from '../apply.ts';
import { writeApplyOrder, readApplyOrder } from '../applyOrder.ts';
import { ConfigBase } from '../base.ts';
import { writeInbox } from '../inbox.ts';
import { codexFileId, codexTomlId, parseItemId } from '../ids.ts';
import { judge, type RemoteSnapshot } from '../threeWay.ts';
import { codexTarget, planCodexFiles, writeCodex, type CodexApplyOptions } from './codex.ts';
import { allTargets, collectAll, enabledTargetNames, targetNameOfId, type TargetContext } from './index.ts';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();

/** probe-codex.md の実物の config.toml を、値を伏せて写した見本。名前とパスは作り物。 */
const SAMPLE = `# my codex config
model = "m-main"            # /model が書く
model_reasoning_effort = "medium"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
notify = ["/opt/tool/notify.sh"]
future_unknown_key = true

[tui]
theme = "dark"
status_line = ["model", "cwd"]
screen_reader_detection_done = true

[tui.model_availability_nux]
"m-main" = 2

[features]
goals = true
hooks = true

[notice]
hide_full_access_warning = true

[notice.model_migrations]
"m-old" = "m-main"

[projects."/Users/example/work/proj"]
trust_level = "trusted"

[marketplaces.market]
source = "/Users/example/market"

[plugins."plug@market"]
enabled = true
installed_at = "2026-01-01"

[hooks.state]
seen = "x"

[mcp_servers.srv]
command = "node"
args = ["srv.js"]

[sandbox_workspace_write]
network_access = false
writable_roots = ["/Users/example/out"]

[tui.unknown_table_key]
x = 1
`;

let tmp: string;
let codexHome: string;
let hangarHome: string;
let db: Db;
let clock: number;
const ctx = (o: Partial<TargetContext> = {}): TargetContext => ({
  db, deviceId: 'dev-a', home: tmp, claudeDir: path.join(tmp, 'claude'), allowedUnsent: new Map(),
  codexHome, codexEnabled: true, opencodeDir: path.join(tmp, 'opencode'), opencodeEnabled: false,
  agentsSkillsDir: path.join(tmp, 'agents'), claudeJsonPath: path.join(tmp, 'claude.json'), hangarSettingsPath: path.join(tmp, 'settings.json'),
  switches: { codex: true }, ...o,
});
const abs = (rel: string): string => path.join(codexHome, ...rel.split('/'));
const put = (rel: string, text: string): void => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text); };
const read = (rel: string): string | null => { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; } };
const collect = (o: Partial<TargetContext> = {}) => codexTarget.collect(ctx(o));
const ids = (o: Partial<TargetContext> = {}): string[] => collect(o).items.map((i) => i.id);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-codex-'));
  codexHome = path.join(tmp, 'codex-home');
  hangarHome = path.join(tmp, 'hangar');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(hangarHome);
  db = openDb(':memory:');
  clock = NOW;
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('codex の id', () => {
  it('持ち主は codex。Claude の id や他の対象の id は持たない', () => {
    expect(targetNameOfId('codex:file:AGENTS.md')).toBe('codex');
    expect(targetNameOfId('codex:toml:model')).toBe('codex');
    expect(codexTarget.owns('file:AGENTS.md')).toBe(false);
    expect(codexTarget.owns('codex:mcp:srv')).toBe(false);
  });
  it('運ぶファイルの形だけを解く', () => {
    for (const rel of ['AGENTS.md', 'AGENTS.override.md', 'hooks.json', 'rules/mine.rules', 'skills/s/SKILL.md', 'skills/s/scripts/run.py', 'work.config.toml']) {
      expect(parseItemId(codexFileId(rel))?.kind, rel).toBe('codex-file');
    }
    for (const rel of ['rules/default.rules', 'rules/x.txt', 'rules/sub/y.rules', 'skills/.system/a/SKILL.md', 'config.toml', '.config.toml', 'auth.json', 'installation_id', '.sandbox/log', '.sandbox_migration', 'tmp/arg0/x', '../AGENTS.md', 'sessions/2026/a.jsonl']) {
      expect(parseItemId(codexFileId(rel)), rel).toBeNull();
    }
  });
  it('運ぶ鍵の道だけを解く。表そのもの、運ばない鍵、状態、知らない鍵は解かない', () => {
    for (const p of [['model'], ['tui', 'theme'], ['features', 'goals'], ['plugins', 'plug@market', 'enabled'], ['hooks', 'PreToolUse'], ['sandbox_workspace_write', 'network_access']]) {
      expect(parseItemId(codexTomlId(p))?.kind, p.join('.')).toBe('codex-config');
    }
    for (const p of [['tui'], ['notify'], ['projects', 'x'], ['notice', 'hide_full_access_warning'], ['hooks', 'state'], ['tui', 'model_availability_nux'], ['sandbox_workspace_write', 'writable_roots'], ['future_key'], ['plugins', 'p', 'installed_at'], ['mcp_servers', 's']]) {
      expect(parseItemId(codexTomlId(p)), p.join('.')).toBeNull();
    }
    expect(parseItemId('codex:toml:')).toBeNull();
    expect(parseItemId('codex:toml:tui..theme')).toBeNull();
  });
  it('プラグインの id に点があっても往復する', () => {
    const id = codexTomlId(['plugins', 'a.b@m', 'enabled']);
    expect(id).not.toContain('a.b');
    expect(parseItemId(id)?.ref).toEqual({ type: 'codex-toml', path: ['plugins', 'a.b@m', 'enabled'] });
  });
});

describe('config.toml の仕分け（実物を伏せた見本）', () => {
  beforeEach(() => put('config.toml', SAMPLE));

  it('運ぶ鍵だけが項目になる', () => {
    expect(ids().filter((i) => i.startsWith('codex:toml:'))).toEqual([
      'codex:toml:approval_policy', 'codex:toml:features.goals', 'codex:toml:features.hooks', 'codex:toml:model', 'codex:toml:model_reasoning_effort',
      'codex:toml:plugins.plug%40market.enabled', 'codex:toml:sandbox_mode', 'codex:toml:sandbox_workspace_write.network_access', 'codex:toml:tui.status_line', 'codex:toml:tui.theme',
    ]);
  });
  it('値は JSON で、コメントや書式は運ばない', () => {
    const c = collect();
    const model = c.items.find((i) => i.id === 'codex:toml:model')!;
    expect(model.content.toString()).toBe('"m-main"');
    expect(model.kind).toBe('codex-config');
    expect(model.target).toBe('config.toml#model');
    expect(c.items.find((i) => i.id === 'codex:toml:tui.status_line')!.content.toString()).toBe('["model","cwd"]');
  });
  it('運ばない（PC）の鍵は項目にならず、dropped に理由が載る', () => {
    const dropped = collect().dropped.map((d) => `${d.key}:${d.reason}`);
    expect(dropped).toEqual(expect.arrayContaining(['codex:notify:machine', 'codex:projects:machine', 'codex:marketplaces:machine', 'codex:sandbox_workspace_write.writable_roots:machine']));
  });
  it('運ばない（状態）の鍵は項目にも dropped にもならない', () => {
    const c = collect();
    const keys = [...c.items.map((i) => i.id), ...c.dropped.map((d) => d.key), ...c.unsent.map((u) => u.id)].join('\n');
    expect(keys).not.toMatch(/notice|model_availability_nux|screen_reader|hooks\.state|installed_at/);
  });
  it('表に無い鍵は「知らない鍵」で、運ばず、値は載せない', () => {
    const c = collect();
    const unk = c.unsent.filter((u) => u.kind === 'unknown-key');
    expect(unk.map((u) => u.label).sort()).toEqual(['future_unknown_key', 'tui.unknown_table_key']);
    expect(unk.every((u) => !u.allowed && u.reason === 'unknown-key')).toBe(true);
    expect(ids()).not.toContain('codex:toml:future_unknown_key');
  });
  it('mcp_servers は S7 の持ち分で、ここでは何も出さない', () => {
    const c = collect();
    expect([...c.items.map((i) => i.id), ...c.dropped.map((d) => d.key), ...c.unsent.map((u) => u.label)].join('\n')).not.toContain('mcp_servers');
  });
  it('絶対パスを値に持つ鍵は運ばない', () => {
    put('config.toml', 'model = "m"\ninstructions = "/Users/example/x.md"\n[tui]\ntheme = "C:\\\\Users\\\\x"\nstatus_line = ["a", "b"]\n');
    const c = collect();
    expect(c.items.map((i) => i.id)).toEqual(['codex:toml:model', 'codex:toml:tui.status_line']);
    expect(c.dropped.map((d) => `${d.key}:${d.reason}`).sort()).toEqual(['codex:instructions:path', 'codex:tui.theme:path']);
  });
  it('秘密らしい値のある項目は、送らずに unsent へ', () => {
    put('config.toml', 'model = "m"\ndeveloper_instructions = "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"\n');
    const c = collect();
    const it = c.items.find((i) => i.id === 'codex:toml:developer_instructions')!;
    expect(it.withheld).toBe('secret');
    expect(c.unsent.some((u) => u.kind === 'secret' && u.itemId === 'codex:toml:developer_instructions')).toBe(true);
  });
  it('config.toml が壊れていれば項目にせず、codex:toml: を塞ぐ', () => {
    put('config.toml', 'model = \n[[[');
    const c = collect();
    expect(c.items).toEqual([]);
    expect(c.blocked.prefixes).toContain('codex:toml:');
  });
  it('config.toml が無ければ何も出さない', () => {
    fs.rmSync(abs('config.toml'));
    expect(collect().items).toEqual([]);
  });
});

describe('ファイルの集め方', () => {
  it('運ぶものだけを集め、Codex が書く状態と Windows 固有の物は集めない', () => {
    for (const [rel, body] of Object.entries({
      'AGENTS.md': 'a', 'AGENTS.override.md': 'o', 'hooks.json': '{}', 'rules/mine.rules': 'r', 'rules/default.rules': 'learned', 'skills/s/SKILL.md': 's', 'skills/.system/x/SKILL.md': 'sys',
      'work.config.toml': 'model = "w"\n', 'installation_id': 'id', '.sandbox/sandbox.log': 'l', '.sandbox_migration': 'm', 'tmp/arg0/x': 'x', 'sessions/2026/a.jsonl': '{}', 'auth.json': '{"k":1}',
    })) put(rel, body);
    expect(ids()).toEqual(['codex:file:AGENTS.md', 'codex:file:AGENTS.override.md', 'codex:file:hooks.json', 'codex:file:rules/mine.rules', 'codex:file:skills/s/SKILL.md', 'codex:file:work.config.toml']);
  });
  it('実行の印：hooks.json は hooks、skills のスクリプトは script', () => {
    put('hooks.json', '{}'); put('skills/s/run.sh', 'echo'); put('skills/s/SKILL.md', 'hi');
    const by = Object.fromEntries(collect().items.map((i) => [i.id, i.marks]));
    expect(by['codex:file:hooks.json']).toEqual(['hooks']);
    expect(by['codex:file:skills/s/run.sh']).toEqual(['script']);
    expect(by['codex:file:skills/s/SKILL.md']).toEqual([]);
  });
  it('<名前>.config.toml は config.toml と同じ仕分けを通り、運べない鍵があれば運ばない', () => {
    put('ok.config.toml', 'model = "w"\n[tui]\ntheme = "x"\n');
    put('bad.config.toml', 'model = "w"\nnotify = ["/x/y"]\n');
    put('unk.config.toml', 'zzz = 1\n');
    const c = collect();
    expect(c.items.map((i) => i.id)).toEqual(['codex:file:ok.config.toml']);
    expect(c.dropped.map((d) => `${d.key}:${d.reason}`)).toEqual(expect.arrayContaining(['codex:file:bad.config.toml:machine']));
    expect(c.unsent.some((u) => u.kind === 'unknown-key' && u.itemId === 'codex:file:unk.config.toml')).toBe(true);
  });
  posixIt('リンクは辿らず、同名を塞ぐ', () => {
    fs.mkdirSync(abs('skills'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.symlinkSync(path.join(tmp, 'elsewhere'), abs('skills/linked'));
    fs.symlinkSync(path.join(tmp, 'elsewhere'), abs('AGENTS.md'));
    const c = collect();
    expect(c.items).toEqual([]);
    expect(c.blocked.ids.has('codex:file:AGENTS.md')).toBe(true);
    expect(c.blocked.prefixes).toContain('codex:file:skills/linked/');
  });
});

describe('有効でない PC では集めない', () => {
  beforeEach(() => { put('config.toml', SAMPLE); put('AGENTS.md', 'x'); });
  it('その PC で Codex が有効でなければ、入にしても集めず、束の対象にも載らない', () => {
    expect(ids({ codexEnabled: false })).toEqual([]);
    expect(collectAll(ctx({ codexEnabled: false })).items.filter((i) => i.id.startsWith('codex:'))).toEqual([]);
    expect(enabledTargetNames(ctx({ codexEnabled: false }))).not.toContain('codex');
  });
  it('設定で入にしていなければ集めない', () => {
    expect(collectAll(ctx({ switches: {} })).items.filter((i) => i.id.startsWith('codex:'))).toEqual([]);
    expect(enabledTargetNames(ctx({ switches: {} }))).not.toContain('codex');
  });
  it('有効で入なら、束の対象に載り、全体の集めにも入る', () => {
    expect(enabledTargetNames(ctx())).toContain('codex');
    expect(codexTarget.placeholder).toBeUndefined();
    expect(collectAll(ctx()).items.some((i) => i.id === 'codex:toml:model')).toBe(true);
  });
  it('本物の CODEX_HOME を読まない：codexHome を渡した場所だけを見る', () => {
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    expect(ids({ codexHome: other })).toEqual([]);
  });
});

describe('古い版の束との互換（SPEC 12 章）', () => {
  const snap = (items: Record<string, string>, targets?: string[]): RemoteSnapshot => ({ deviceId: 'B', at: 10, items: new Map(Object.entries(items).map(([id, s]) => [id, { sha256: s }])), ...(targets ? { targets: new Set(targets) } : {}) });
  const m = (o: Record<string, string>) => new Map(Object.entries(o));
  it('targets の無い束（古い版）を相手にしても、codex の項目は消去にも forget にもならない', () => {
    const j = judge({ local: m({ 'codex:toml:model': 'x', 'codex:file:AGENTS.md': 'y' }), base: m({ 'codex:toml:model': 'x', 'codex:file:AGENTS.md': 'y' }), remotes: [snap({})] });
    expect(j.actions).toEqual([]);
    expect(j.forget).toEqual([]);
  });
  it('claude だけと書いた束でも同じ', () => {
    const j = judge({ local: m({ 'codex:toml:model': 'x' }), base: m({ 'codex:toml:model': 'x' }), remotes: [snap({}, ['claude'])] });
    expect(j.actions).toEqual([]);
  });
  it('codex を扱う相手が持っていなければ、消去になる', () => {
    const j = judge({ local: m({ 'codex:toml:model': 'x' }), base: m({ 'codex:toml:model': 'x' }), remotes: [snap({}, ['claude', 'codex'])] });
    expect(j.actions.map((a) => [a.id, a.op])).toEqual([['codex:toml:model', 'delete']]);
  });
});

describe('承諾と PC に依る項目', () => {
  const need = (id: string, kind: ConfigItemKind, op: ConfigInboxOp, ap: 'each' | 'auto') => codexTarget.needsApproval({ id, kind, op }, ap);
  it('rules、skills、hooks.json、設定の profile は承諾が要る。AGENTS.md は要らない', () => {
    expect(need('codex:file:rules/a.rules', 'codex-file', 'create', 'each')).toBe(true);
    expect(need('codex:file:skills/s/SKILL.md', 'codex-file', 'overwrite', 'each')).toBe(true);
    expect(need('codex:file:hooks.json', 'codex-file', 'create', 'each')).toBe(true);
    expect(need('codex:file:w.config.toml', 'codex-file', 'create', 'each')).toBe(true);
    expect(need('codex:file:AGENTS.md', 'codex-file', 'create', 'each')).toBe(false);
    expect(need('codex:file:AGENTS.override.md', 'codex-file', 'create', 'each')).toBe(false);
  });
  it('承諾が要る鍵：approval_policy、sandbox_mode、[hooks]、[plugins.*]。消去も承諾に掛ける', () => {
    for (const p of [['approval_policy'], ['sandbox_mode'], ['hooks', 'PreToolUse'], ['plugins', 'p', 'enabled'], ['sandbox_workspace_write', 'network_access']]) {
      expect(need(codexTomlId(p), 'codex-config', 'overwrite', 'each'), p.join('.')).toBe(true);
      expect(need(codexTomlId(p), 'codex-config', 'delete', 'each'), p.join('.')).toBe(true);
    }
    expect(need(codexTomlId(['model']), 'codex-config', 'overwrite', 'each')).toBe(false);
    expect(need(codexTomlId(['tui', 'theme']), 'codex-config', 'create', 'each')).toBe(false);
  });
  it('承諾の仕方が auto なら要らない', () => {
    expect(need('codex:file:rules/a.rules', 'codex-file', 'create', 'auto')).toBe(false);
    expect(need(codexTomlId(['approval_policy']), 'codex-config', 'create', 'auto')).toBe(false);
  });
  it('絶対パスを値に持つ届いた項目は、その PC では適用しない', () => {
    const mb = (id: string, kind: ConfigItemKind, s: string) => codexTarget.isMachineBound({ id, kind, content: Buffer.from(s) });
    expect(mb(codexTomlId(['instructions']), 'codex-config', '"/Users/x/a.md"')).toBe(true);
    expect(mb(codexTomlId(['tui', 'theme']), 'codex-config', '"dark"')).toBe(false);
    expect(mb('codex:file:w.config.toml', 'codex-file', 'notify = ["/x/y"]\n')).toBe(true);
    expect(mb('codex:file:w.config.toml', 'codex-file', 'model = "m"\n')).toBe(false);
    expect(mb('codex:file:AGENTS.md', 'codex-file', 'see /Users/x')).toBe(false);
  });
});

// ---- 書き戻し ----

type OrderIn = { id: string; kind: ConfigItemKind; op: ConfigInboxOp; content: string | null; target: string; take?: 'remote' | 'mine' };
const toml = (p: string[], op: ConfigInboxOp, value: unknown | undefined): OrderIn => ({ id: codexTomlId(p), kind: 'codex-config', op, content: value === undefined ? null : JSON.stringify(value), target: `config.toml#${p.join('.')}` });
const file = (rel: string, op: ConfigInboxOp, content: string | null): OrderIn => ({ id: codexFileId(rel), kind: 'codex-file', op, content, target: rel });

function deliver(items: OrderIn[]): void {
  const blobs = new Map<string, Buffer>();
  const manifestItems = items.filter((i) => i.content !== null).map((i) => { const b = Buffer.from(i.content!); blobs.set(sha(b), b); return { id: i.id, kind: i.kind, sha256: sha(b), size: b.length, marks: [] }; });
  writeInbox(hangarHome, 'dev-b', { manifest: { version: 1, deviceId: 'dev-b', createdAt: NOW, items: manifestItems, targets: ['claude', 'codex'] }, blobs, skipped: 0 }, { bundleSha256: sha('b'), forRowSha256: 'row', at: NOW, itemCount: manifestItems.length, skipped: 0, targets: ['claude', 'codex'] });
  const dtos: ConfigApplyOrderItemDto[] = items.map((o) => ({ id: o.id, kind: o.kind, op: o.op, take: o.take ?? 'remote', fromDeviceId: 'dev-b', sha256: o.content === null ? '' : sha(o.content), target: o.target }));
  writeApplyOrder(hangarHome, 'dev-a', dtos, NOW);
}
const opts = (o: Partial<CodexApplyOptions> = {}): CodexApplyOptions => ({ home: hangarHome, claudeDir: path.join(tmp, 'claude'), db, now: () => clock, codexHome, ...o });
const backupsDir = (): string => path.join(hangarHome, 'backups', 'codex-config');
const gens = (): string[] => { try { return fs.readdirSync(backupsDir()); } catch { return []; } };
const failOf = (fn: () => unknown): ApplyError => { try { fn(); } catch (e) { if (e instanceof ApplyError) return e; throw e; } throw new Error('投げられなかった'); };

describe('書き戻し：config.toml', () => {
  const ORIG = '# top comment\nmodel = "old"   # trailing\n\n[tui]\n# theme note\ntheme = "dark"\nstatus_line = ["a"]\n\n[projects."/Users/example/p"]\ntrust_level = "trusted"\n';
  beforeEach(() => put('config.toml', ORIG));

  it('見立て：何も書かず、項目の作る・上書き・消去を数える', () => {
    deliver([toml(['model'], 'overwrite', 'new'), toml(['tui', 'theme'], 'delete', undefined), toml(['features', 'goals'], 'create', true)]);
    const plan = codexTarget.planWrite({ home: hangarHome });
    expect(plan.counts).toMatchObject({ create: 1, overwrite: 1, delete: 1 });
    expect(plan.byKind).toEqual({ 'codex-config': 3 });
    expect(read('config.toml')).toBe(ORIG);
    expect(gens()).toEqual([]);
    const files = planCodexFiles({ home: hangarHome, codexHome });
    expect(files.files.map((f) => [f.rel, f.op])).toEqual([['config.toml', 'modify']]);
    expect(files.files[0]!.lines.length).toBeGreaterThan(0);
  });

  it('鍵だけを差し替え、コメント、並び、他の鍵、状態の表を保つ', () => {
    deliver([toml(['model'], 'overwrite', 'new'), toml(['tui', 'status_line'], 'overwrite', ['x', 'y']), toml(['features', 'goals'], 'create', true)]);
    const r = writeCodex(opts());
    const out = read('config.toml')!;
    expect(out).toContain('# top comment\nmodel = "new"   # trailing');
    expect(out).toContain('# theme note\ntheme = "dark"');
    expect(out).toContain('status_line = ["x", "y"]');
    expect(out).toContain('[projects."/Users/example/p"]\ntrust_level = "trusted"');
    expect(out.indexOf('[tui]')).toBeLessThan(out.indexOf('[projects.'));
    expect(out).toMatch(/\[features\]\ngoals = true/);
    expect(r).toMatchObject({ written: 1, removed: 0, files: ['config.toml'] });
  });

  it('消去は鍵だけを消し、コメントと他の鍵を残す', () => {
    deliver([toml(['tui', 'status_line'], 'delete', undefined)]);
    writeCodex(opts());
    const out = read('config.toml')!;
    expect(out).not.toContain('status_line');
    expect(out).toContain('# theme note\ntheme = "dark"');
    expect(out).toContain('# top comment');
  });

  it('config.toml が無ければ作る', () => {
    fs.rmSync(abs('config.toml'));
    deliver([toml(['model'], 'create', 'm')]);
    writeCodex(opts());
    expect(read('config.toml')).toBe('model = "m"\n');
  });

  it('控えを取り、基準を更新し、指示書を消す', () => {
    deliver([toml(['model'], 'overwrite', 'new')]);
    const r = writeCodex(opts());
    expect(gens()).toEqual([r.generation]);
    expect(fs.readFileSync(path.join(backupsDir(), r.generation!, 'config.toml'), 'utf8')).toBe(ORIG);
    expect(new ConfigBase(db).all().get(codexTomlId(['model']))).toBe(sha('"new"'));
    expect(readApplyOrder(hangarHome)).toBeNull();
  });

  it('控えを取れなければ書かない', () => {
    fs.writeFileSync(path.join(hangarHome, 'backups'), 'a file, not a directory');
    deliver([toml(['model'], 'overwrite', 'new')]);
    expect(failOf(() => writeCodex(opts())).code).toBe('write-failed');
    expect(read('config.toml')).toBe(ORIG);
    expect(readApplyOrder(hangarHome)).not.toBeNull();
  });

  it('書いた後に読み直して違えば（別のプロセスが書き換えた）、元へ戻して失敗する', () => {
    deliver([toml(['model'], 'overwrite', 'new')]);
    const e = failOf(() => writeCodex(opts({ afterWrite: (rel) => { if (rel === 'config.toml') fs.appendFileSync(abs('config.toml'), 'sneaky = 1\n'); } })));
    expect(e.code).toBe('write-failed');
    expect(read('config.toml')).toBe(ORIG);
    expect(readApplyOrder(hangarHome)).not.toBeNull();
    expect(new ConfigBase(db).all().size).toBe(0);
  });

  it('確認の後に書く先が変わっていたら、何も書かない（expect）', () => {
    deliver([toml(['model'], 'overwrite', 'new')]);
    const planned = planCodexFiles({ home: hangarHome, codexHome });
    fs.appendFileSync(abs('config.toml'), '# edited meanwhile\n');
    expect(failOf(() => writeCodex(opts({ expect: planned.fingerprint }))).code).toBe('changed');
    expect(read('config.toml')).toContain('model = "old"');
  });

  it('config.toml が読めない形なら書かない', () => {
    put('config.toml', 'model = \n[[[');
    deliver([toml(['model'], 'overwrite', 'new')]);
    expect(failOf(() => writeCodex(opts())).code).toBe('settings-unreadable');
    expect(read('config.toml')).toBe('model = \n[[[');
  });

  it('運ばない鍵や絶対パスの値が届いても書かない', () => {
    deliver([toml(['instructions'], 'create', '/Users/x/y.md')]);
    expect(failOf(() => writeCodex(opts())).code).toBe('bad-content');
    expect(read('config.toml')).toBe(ORIG);
  });

  it('target が id から決まる場所と違う指示書は断る', () => {
    deliver([{ ...toml(['model'], 'overwrite', 'new'), target: 'config.toml#other' }]);
    expect(failOf(() => writeCodex(opts())).code).toBe('unsafe');
  });

  it('競合で手元を採る項目は書かず、基準だけ進める', () => {
    deliver([{ ...toml(['model'], 'conflict', 'new'), take: 'mine' }]);
    const r = writeCodex(opts());
    expect(r).toMatchObject({ written: 0, keptMine: 1, generation: null });
    expect(read('config.toml')).toBe(ORIG);
  });

  it('target.write と planWrite は同じ処理に繋がる（codexHome を渡す）', () => {
    deliver([toml(['model'], 'overwrite', 'new')]);
    codexTarget.write(opts());
    expect(read('config.toml')).toContain('model = "new"');
  });
});

describe('書き戻し：ファイル', () => {
  it('作る・上書き・消すを、控えつきで行う', () => {
    put('AGENTS.md', 'old'); put('rules/gone.rules', 'x');
    deliver([file('AGENTS.md', 'overwrite', 'new'), file('skills/s/SKILL.md', 'create', 'hi'), file('rules/gone.rules', 'delete', null)]);
    const plan = codexTarget.planWrite({ home: hangarHome });
    expect(plan.instructions).toBe(1);
    const r = writeCodex(opts());
    expect(read('AGENTS.md')).toBe('new');
    expect(read('skills/s/SKILL.md')).toBe('hi');
    expect(read('rules/gone.rules')).toBeNull();
    expect(r).toMatchObject({ written: 2, removed: 1 });
    const g = path.join(backupsDir(), r.generation!);
    expect(fs.readFileSync(path.join(g, 'AGENTS.md'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(g, 'rules', 'gone.rules'), 'utf8')).toBe('x');
  });
  it('途中で失敗したら、全部元へ戻す', () => {
    put('AGENTS.md', 'old'); put('config.toml', 'model = "old"\n');
    deliver([file('AGENTS.md', 'overwrite', 'new'), file('skills/s/SKILL.md', 'create', 'hi'), toml(['model'], 'overwrite', 'new')]);
    const e = failOf(() => writeCodex(opts({ onWrite: (_rel, i) => { if (i === 2) throw new Error('boom'); } })));
    expect(e.code).toBe('write-failed');
    expect(read('AGENTS.md')).toBe('old');
    expect(read('skills/s/SKILL.md')).toBeNull();
    expect(read('config.toml')).toBe('model = "old"\n');
    expect(gens()).toEqual([]);
  });
  posixIt('途中にリンクがある先へは書かない', () => {
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.symlinkSync(path.join(tmp, 'elsewhere'), abs('skills'));
    deliver([file('skills/s/SKILL.md', 'create', 'hi')]);
    expect(failOf(() => writeCodex(opts())).code).toBe('unsafe');
    expect(fs.readdirSync(path.join(tmp, 'elsewhere'))).toEqual([]);
  });
  it('codex の項目の無い指示書は断る', () => {
    writeApplyOrder(hangarHome, 'dev-a', [{ id: 'file:CLAUDE.md', kind: 'claude-md', op: 'create', take: 'remote', fromDeviceId: 'dev-b', sha256: sha('x'), target: 'CLAUDE.md' }], NOW);
    expect(failOf(() => writeCodex(opts())).code).toBe('no-order');
  });
  it('登録された対象の中に、枠でない codex がある', () => {
    expect(allTargets().find((t) => t.name === 'codex')).toBe(codexTarget);
  });
});
