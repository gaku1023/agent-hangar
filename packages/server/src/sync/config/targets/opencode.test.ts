import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ConfigApplyOrderItemDto, ConfigExecMark, ConfigInboxOp, ConfigItemKind } from '@agent-hangar/shared';
import { parse as parseJsonc } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../../db/open.ts';
import { ApplyError } from '../apply.ts';
import { writeApplyOrder } from '../applyOrder.ts';
import { listBackups } from '../backups.ts';
import { ConfigBase } from '../base.ts';
import { writeInbox } from '../inbox.ts';
import { ocPathId, OC_CLI_PREFIX, OC_JSON_PREFIX } from './opencodeKeys.ts';
import { allTargets, enabledTargetNames, targetNameOfId, type TargetContext } from './index.ts';
import { judge, type RemoteSnapshot } from '../threeWay.ts';
import { opencodeItemNotes, opencodeNotices, opencodeTarget, planOpencodeWrite, writeOpencode } from './opencode.ts';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();
let tmp: string;
let home: string;
let dir: string;
let db: Db;

const ctx = (o: Partial<TargetContext> = {}): TargetContext => ({
  db, deviceId: 'dev-a', home, claudeDir: path.join(tmp, 'claude'), allowedUnsent: new Map(),
  codexHome: path.join(tmp, 'codex'), codexEnabled: false, opencodeDir: dir, opencodeEnabled: true,
  agentsSkillsDir: path.join(tmp, 'agents'), claudeJsonPath: path.join(tmp, 'claude.json'), hangarSettingsPath: path.join(tmp, 'settings.json'),
  switches: { opencode: true }, ...o,
});
const put = (rel: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const get = (rel: string): string | null => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
const collect = (o: Partial<TargetContext> = {}) => opencodeTarget.collect(ctx(o));
const idsOf = (o: Partial<TargetContext> = {}): string[] => collect(o).items.map((i) => i.id);
const jid = (...segs: string[]): string => ocPathId(OC_JSON_PREFIX, segs);
const cid = (...segs: string[]): string => ocPathId(OC_CLI_PREFIX, segs);
const valueOf = (id: string): unknown => JSON.parse(collect().items.find((i) => i.id === id)!.content.toString('utf8'));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cfg-'));
  home = path.join(tmp, 'home');
  dir = path.join(tmp, 'opencode');
  fs.mkdirSync(home);
  fs.mkdirSync(dir);
  db = openDb(':memory:');
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('対象 opencode の登録', () => {
  it('本物の対象になり、束の targets に載る。有効でなければ載らない', () => {
    expect(allTargets().find((t) => t.name === 'opencode')!.placeholder).toBeUndefined();
    expect(enabledTargetNames(ctx())).toContain('opencode');
    expect(enabledTargetNames(ctx({ opencodeEnabled: false }))).not.toContain('opencode');
    expect(enabledTargetNames(ctx({ switches: {} }))).not.toContain('opencode');
  });
  it('id の持ち主。opencode:mcp: は S7 のもので、この対象は持たない', () => {
    expect(targetNameOfId('opencode:file:AGENTS.md')).toBe('opencode');
    expect(targetNameOfId(jid('model'))).toBe('opencode');
    expect(opencodeTarget.owns('opencode:mcp:x')).toBe(false);
    expect(targetNameOfId('file:CLAUDE.md')).toBe('claude');
  });
  it('切のとき（opencode を使っていない PC）は、入れ物があっても集めない', () => {
    put('AGENTS.md', 'x');
    expect(opencodeTarget.enabled(ctx({ opencodeEnabled: false }))).toBe(false);
  });
});

describe('ファイルを集める', () => {
  it('AGENTS.md、v1・v2 形のディレクトリ、themes を運ぶ。opencode.json や node_modules は運ばない', () => {
    for (const rel of ['AGENTS.md', 'agents/a.md', 'agent/b.md', 'commands/c.md', 'command/d.md', 'skills/s/SKILL.md', 'skill/t/SKILL.md', 'plugins/p.ts', 'plugin/q.ts', 'themes/x.json', 'plugins/node_modules/z/i.js', 'package.json', 'service.json', 'other/x.md']) put(rel, 'body');
    expect(idsOf().filter((i) => i.startsWith('opencode:file:'))).toEqual([
      'AGENTS.md', 'agent/b.md', 'agents/a.md', 'command/d.md', 'commands/c.md', 'plugin/q.ts', 'plugins/p.ts', 'skill/t/SKILL.md', 'skills/s/SKILL.md', 'themes/x.json',
    ].map((r) => `opencode:file:${r}`));
  });
  it('plugins は script の印、commands の ! は shell の印', () => {
    put('plugins/p.ts', 'export default {}');
    put('command/c.md', 'hi !`ls`');
    put('AGENTS.md', 'plain');
    const by = Object.fromEntries(collect().items.map((i) => [i.id, i.marks]));
    expect(by['opencode:file:plugins/p.ts']).toEqual(['script']);
    expect(by['opencode:file:command/c.md']).toEqual(['shell']);
    expect(by['opencode:file:AGENTS.md']).toEqual([]);
  });
  it('リンクは辿らず、その id を塞ぐ', () => {
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.writeFileSync(path.join(tmp, 'outside.md'), 'x');
    fs.symlinkSync(path.join(tmp, 'outside.md'), path.join(dir, 'agents', 'l.md'));
    const c = collect();
    expect(c.items).toEqual([]);
    expect(c.blocked.ids.has('opencode:file:agents/l.md')).toBe(true);
  });
  it('入れ物が無ければ空', () => {
    fs.rmSync(dir, { recursive: true });
    expect(collect().items).toEqual([]);
  });
});

describe('opencode.json(c) の鍵（SPEC 3 章）', () => {
  const FULL = `{
  // コメントは保つ
  "$schema": "https://opencode.ai/config.json",
  "model": "p/m",
  "small_model": "p/s",
  "compaction": { "auto": true },
  "permission": { "bash": "ask" },
  "share": "manual",
  "autoupdate": false,
  "theme": "tokyonight",
  "instructions": ["rules.md", "/abs/rules.md", "~/.claude/CLAUDE.md", "C:\\\\x\\\\y.md", "https://example.com/r.md"],
  "provider": { "x": { "options": { "apiKey": "k" } } },
  "skills": { "paths": ["/p"] },
  "plugin": ["npm-pkg", "/abs/plugin.js"],
  "mcp": { "m": { "type": "local", "command": ["x"] } },
  "agent": { "build": { "prompt": "p", "description": "d", "mode": "primary", "temperature": 0.1, "top_p": 0.5, "steps": 3, "permission": { "edit": "deny" }, "model": "p/m", "color": "red" } },
  "agents": { "plan": { "description": "pd" } },
  "mystery": 1,
}`;
  it('運ぶ鍵だけを運び、運ばない鍵と知らない鍵は理由つきで外す', () => {
    put('opencode.jsonc', FULL);
    const c = collect();
    expect(c.items.map((i) => i.id)).toEqual([
      jid('agent', 'build', 'description'), jid('agent', 'build', 'mode'), jid('agent', 'build', 'permission'), jid('agent', 'build', 'prompt'),
      jid('agent', 'build', 'steps'), jid('agent', 'build', 'temperature'), jid('agent', 'build', 'top_p'),
      jid('agents', 'plan', 'description'), jid('autoupdate'), jid('compaction'), jid('instructions'), jid('model'), jid('permission'), jid('share'), jid('small_model'), jid('theme'),
    ].sort());
    const reasons = Object.fromEntries(c.dropped.map((d) => [d.key, d.reason]));
    expect(reasons[jid('provider')]).toBe('machine');
    expect(reasons[jid('skills')]).toBe('machine');
    expect(reasons[jid('plugin')]).toBe('machine');
    expect(reasons[jid('agent', 'build', 'model')]).toBe('machine');
    expect(reasons[jid('instructions')]).toBe('path');
    expect(reasons[jid('mystery')]).toBe('unknown');
    expect(jid('mcp') in reasons).toBe(false);
    expect(c.items.every((i) => i.kind === 'opencode-config')).toBe(true);
  });
  it('絶対パスの instructions を運ばない。~ と URL と相対は運ぶ', () => {
    put('opencode.jsonc', FULL);
    expect(valueOf(jid('instructions'))).toEqual(['rules.md', '~/.claude/CLAUDE.md', 'https://example.com/r.md']);
  });
  it('絶対パスだけの instructions は項目を作らず、手元の項目として塞ぐ', () => {
    put('opencode.json', '{"instructions":["/a.md"]}');
    const c = collect();
    expect(c.items).toEqual([]);
    expect(c.blocked.ids.has(jid('instructions'))).toBe(true);
  });
  it('provider と skills.paths の中身を含めない（秘密の鍵も出ない）', () => {
    put('opencode.jsonc', FULL);
    const text = collect().items.map((i) => i.content.toString('utf8')).join('\n');
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('"/p"');
    expect(text).not.toContain('npm-pkg');
  });
  it('v1 形（agent）と v2 形（agents）は名前を変えずに運ぶ', () => {
    put('opencode.json', '{"agent":{"a":{"description":"1"}},"agents":{"b":{"description":"2"}}}');
    expect(idsOf()).toEqual([jid('agent', 'a', 'description'), jid('agents', 'b', 'description')]);
  });
  it('名前に . を含む agent も往復できる', () => {
    put('opencode.json', '{"agent":{"my.agent":{"mode":"subagent"}}}');
    const [item] = collect().items;
    expect(item!.id).toBe('opencode:json:agent.my%2Eagent.mode');
    expect(opencodeTarget.parseId(item!.id)!.ref).toEqual({ type: 'opencode-json', path: ['agent', 'my.agent', 'mode'] });
  });
  it('json と jsonc が両方あれば jsonc を正とし、知らせる', () => {
    put('opencode.json', '{"model":"from-json","share":"manual"}');
    put('opencode.jsonc', '{"model":"from-jsonc"}');
    expect(valueOf(jid('model'))).toBe('from-jsonc');
    expect(idsOf()).toEqual([jid('model')]);
    expect(opencodeNotices(dir)).toEqual([{ code: 'both-json-jsonc' }]);
    fs.rmSync(path.join(dir, 'opencode.json'));
    expect(opencodeNotices(dir)).toEqual([]);
  });
  it('知らない鍵は送れない「知らない鍵」として出す（値は載せない）', () => {
    put('opencode.json', '{"mystery":"secret-ish","agent":{"a":{"tools":{"x":true}}}}');
    const u = collect().unsent;
    expect(u.map((x) => [x.kind, x.itemId, x.reason, x.allowed])).toEqual([
      ['unknown-key', jid('agent', 'a', 'tools'), 'unknown-key', false],
      ['unknown-key', jid('mystery'), 'unknown-key', false],
    ]);
    expect(JSON.stringify(u)).not.toContain('secret-ish');
  });
  it('型の合わない値は運ばない', () => {
    put('opencode.json', '{"model":5,"agent":{"a":{"steps":"x"}}}');
    expect(idsOf()).toEqual([]);
  });
  it('壊れた設定ファイルは何も運ばず、書き込み側の id を塞ぐ', () => {
    put('opencode.jsonc', '{ "model": ');
    const c = collect();
    expect(c.items).toEqual([]);
    expect(c.blocked.prefixes).toContain('opencode:json:');
  });
  it('秘密らしい文字列のある項目は withheld で、送らなかった項目に出る', () => {
    put('opencode.json', '{"agent":{"a":{"prompt":"use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"}}}');
    const c = collect();
    expect(c.items[0]!.withheld).toBe('secret');
    expect(c.unsent.some((u) => u.kind === 'secret')).toBe(true);
  });
});

describe('{env:} と {file:}', () => {
  it('{env:X} はそのまま運び、受け手の環境に無い X を添える', () => {
    put('opencode.json', '{"agent":{"a":{"prompt":"key {env:HANGAR_TEST_NOPE_X} and {env:HANGAR_TEST_HAS}"}}}');
    const [item] = collect().items;
    expect(item!.content.toString('utf8')).toContain('{env:HANGAR_TEST_NOPE_X}');
    expect(opencodeItemNotes(item!, { HANGAR_TEST_HAS: '1' })).toEqual({ missingEnv: ['HANGAR_TEST_NOPE_X'] });
    expect(opencodeItemNotes(item!, { HANGAR_TEST_HAS: '1', HANGAR_TEST_NOPE_X: '' })).toEqual({ missingEnv: [] });
    expect(opencodeItemNotes({ id: 'opencode:file:AGENTS.md', content: Buffer.from('{env:Q}') }, {})).toEqual({ missingEnv: [] });
  });
  it('{file:p} が入れ物の中なら p も運ぶ', () => {
    put('opencode.json', '{"agent":{"a":{"prompt":"{file:./prompts/a.md}"}}}');
    put('prompts/a.md', 'prompt body');
    const c = collect();
    expect(c.items.map((i) => i.id)).toEqual(['opencode:file:prompts/a.md', jid('agent', 'a', 'prompt')]);
    expect(c.items[0]!.kind).toBe('opencode-file');
  });
  it('{file:p} が入れ物の外（絶対、~、..）なら項目ごと保留にし、手元の項目として塞ぐ', () => {
    put('opencode.json', '{"agent":{"a":{"prompt":"{file:/etc/x}"},"b":{"prompt":"{file:~/x}"},"c":{"prompt":"{file:../x}"},"d":{"prompt":"ok"}}}');
    const c = collect();
    expect(c.items.map((i) => i.id)).toEqual([jid('agent', 'd', 'prompt')]);
    for (const n of ['a', 'b', 'c']) {
      expect(c.dropped).toContainEqual({ key: jid('agent', n, 'prompt'), reason: 'path' });
      expect(c.blocked.ids.has(jid('agent', n, 'prompt'))).toBe(true);
    }
  });
  it('{file:} が opencode.json 自身を指すなら保留', () => {
    put('opencode.json', '{"agent":{"a":{"prompt":"{file:./opencode.json}"}}}');
    expect(idsOf()).toEqual([]);
  });
  it('受け手に届いた値が外を指していれば、機械固有として扱う', () => {
    const bad = { id: jid('agent', 'a', 'prompt'), kind: 'opencode-config' as const, content: Buffer.from(JSON.stringify('{file:/x}')) };
    expect(opencodeTarget.isMachineBound(bad)).toBe(true);
    expect(opencodeTarget.isMachineBound({ ...bad, content: Buffer.from(JSON.stringify('{file:./x}')) })).toBe(false);
    expect(opencodeTarget.isMachineBound({ id: jid('instructions'), kind: 'opencode-config', content: Buffer.from('["/a.md"]') })).toBe(true);
  });
});

describe('cli.json', () => {
  it('plugins と attention.sounds を除いて運ぶ。attention は 1 段下で分ける', () => {
    put('cli.json', '{"$schema":"x","theme":{"name":"nord"},"plugins":["/p.js"],"attention":{"volume":1,"sound":true,"sounds":{"done":"/x.wav"}},"scroll":{"speed":3}}');
    const c = collect();
    expect(c.items.map((i) => i.id)).toEqual([cid('attention', 'sound'), cid('attention', 'volume'), cid('scroll'), cid('theme')]);
    expect(c.items.every((i) => i.kind === 'opencode-cli')).toBe(true);
    expect(JSON.stringify(c.items.map((i) => i.content.toString()))).not.toContain('/x.wav');
    expect(c.dropped).toContainEqual({ key: cid('plugins'), reason: 'machine' });
    expect(c.dropped).toContainEqual({ key: cid('attention', 'sounds'), reason: 'machine' });
  });
  it('plugins と sounds の id は受け付けない', () => {
    expect(opencodeTarget.parseId(cid('plugins'))).toBeNull();
    expect(opencodeTarget.parseId(cid('attention', 'sounds'))).toBeNull();
    expect(opencodeTarget.parseId(cid('theme'))!.kind).toBe('opencode-cli');
  });
});

describe('id の検査', () => {
  it('運ばない場所と形の悪い id は null', () => {
    for (const id of ['opencode:file:opencode.json', 'opencode:file:../x', 'opencode:file:/x', 'opencode:file:node_modules/a', 'opencode:file:agents/a.conflict-1',
      jid('provider'), jid('agent', 'a', 'model'), jid('agent', 'a'), jid('skills', 'paths'), 'opencode:json:', 'opencode:json:agent..x', 'opencode:json:agent.a%zz.mode', 'opencode:json:agent.a.mo%64e'])
      expect(opencodeTarget.parseId(id), id).toBeNull();
    expect(opencodeTarget.parseId('opencode:file:agents/a.md')!.kind).toBe('opencode-file');
  });
});

describe('承諾（SPEC 4 章）', () => {
  const need = (id: string, kind: ConfigItemKind, op: ConfigInboxOp = 'overwrite', a: 'each' | 'auto' = 'each') => opencodeTarget.needsApproval({ id, kind, op }, a);
  it('agents・commands・skills・plugins は each で承諾が要る。AGENTS.md と themes は要らない', () => {
    for (const r of ['agents/a.md', 'agent/a.md', 'commands/c.md', 'command/c.md', 'skills/s/SKILL.md', 'skill/s/SKILL.md', 'plugins/p.ts', 'plugin/p.ts', 'prompts/x.md']) expect(need(`opencode:file:${r}`, 'opencode-file'), r).toBe(true);
    expect(need('opencode:file:AGENTS.md', 'opencode-file')).toBe(false);
    expect(need('opencode:file:themes/t.json', 'opencode-file')).toBe(false);
    expect(need('opencode:file:agents/a.md', 'opencode-file', 'delete')).toBe(false);
    expect(need('opencode:file:agents/a.md', 'opencode-file', 'create', 'auto')).toBe(false);
  });
  it('permission と agent(s).*.permission は each で要る（消去も）。ほかの鍵は要らない', () => {
    expect(need(jid('permission'), 'opencode-config')).toBe(true);
    expect(need(jid('permission'), 'opencode-config', 'delete')).toBe(true);
    expect(need(jid('agent', 'a', 'permission'), 'opencode-config')).toBe(true);
    expect(need(jid('agents', 'a', 'permission'), 'opencode-config')).toBe(true);
    expect(need(jid('permission'), 'opencode-config', 'overwrite', 'auto')).toBe(false);
    expect(need(jid('model'), 'opencode-config')).toBe(false);
    expect(need(jid('agent', 'a', 'prompt'), 'opencode-config')).toBe(false);
    expect(need(cid('theme'), 'opencode-cli')).toBe(false);
  });
});

describe('古い版の束との判定（SPEC 12 章）', () => {
  const snap = (targets?: string[]): RemoteSnapshot => ({ deviceId: 'B', at: 10, items: new Map(), ...(targets ? { targets: new Set(targets) } : {}) });
  const m = (o: Record<string, string>) => new Map(Object.entries(o));
  it('opencode を知らない古い版の束（targets 無し、claude のみ）では、opencode の項目は消去にも forget にもならない', () => {
    const local = m({ 'opencode:file:AGENTS.md': 'x', [jid('model')]: 'y', [cid('theme')]: 'z' });
    for (const old of [snap(), snap(['claude'])]) {
      const j = judge({ local, base: local, remotes: [old] });
      expect(j.actions).toEqual([]);
      expect(j.forget).toEqual([]);
    }
  });
  it('opencode を扱う束が持っていなければ、今までどおり delete', () => {
    const j = judge({ local: m({ [jid('model')]: 'y' }), base: m({ [jid('model')]: 'y' }), remotes: [snap(['claude', 'opencode'])] });
    expect(j.actions.map((a) => [a.id, a.op])).toEqual([[jid('model'), 'delete']]);
  });
});

// ---- 書き戻し ----

type OrderIn = { id: string; kind: ConfigItemKind; op: ConfigInboxOp; content?: string | null; take?: 'remote' | 'mine' };
function inbox(items: { id: string; kind: ConfigItemKind; content: string; marks?: ConfigExecMark[] }[], deviceId = 'dev-b'): void {
  const blobs = new Map<string, Buffer>();
  const mi = items.map((i) => { const b = Buffer.from(i.content); blobs.set(sha(b), b); return { id: i.id, kind: i.kind, sha256: sha(b), size: b.length, marks: i.marks ?? [] }; });
  writeInbox(home, deviceId, { manifest: { version: 1, deviceId, createdAt: NOW, items: mi }, blobs, skipped: 0 }, { bundleSha256: sha(deviceId), forRowSha256: 'r', at: NOW, itemCount: items.length, skipped: 0 });
}
const orderItem = (o: OrderIn): ConfigApplyOrderItemDto => {
  const parsed = opencodeTarget.parseId(o.id)!;
  const ref = parsed.ref;
  const rest = (p: string) => o.id.slice(p.length);
  const target = ref.type === 'opencode-file' ? ref.rel : ref.type === 'opencode-json' ? `opencode.json#${rest(OC_JSON_PREFIX)}` : `cli.json#${rest(OC_CLI_PREFIX)}`;
  return { id: o.id, kind: o.kind, op: o.op, take: o.take ?? 'remote', fromDeviceId: 'dev-b', sha256: o.content == null ? '' : sha(o.content), target };
};
const order = (...items: OrderIn[]): void => { writeApplyOrder(home, 'dev-a', items.map(orderItem), NOW); };
const val = (v: unknown): string => JSON.stringify(v);
const run = (extra: Record<string, unknown> = {}) => writeOpencode({ home, claudeDir: path.join(tmp, 'claude'), db, now: () => NOW, opencodeDir: dir, ...extra });
const fail = (fn: () => unknown): ApplyError => { try { fn(); } catch (e) { if (e instanceof ApplyError) return e; throw e; } throw new Error('投げられなかった'); };
const setup = (items: (OrderIn & { content: string })[]): void => {
  inbox(items.map((i) => ({ id: i.id, kind: i.kind, content: i.content })));
  order(...items);
};

describe('書き戻し：jsonc は体裁を保ち、json は整形し直す', () => {
  it('jsonc はコメントと並びを保ち、鍵だけ差し替える', () => {
    const src = '{\n  // 私のモデル\n  "model": "old",   "share": "manual", /* keep */\n  "mystery": 1\n}\n';
    put('opencode.jsonc', src);
    setup([{ id: jid('model'), kind: 'opencode-config', op: 'overwrite', content: val('new/m') }, { id: jid('theme'), kind: 'opencode-config', op: 'create', content: val('nord') }]);
    const r = run();
    const out = get('opencode.jsonc')!;
    expect(out).toContain('// 私のモデル');
    expect(out).toContain('/* keep */');
    expect(out).toContain('"mystery": 1');
    expect(out).toContain('"model": "new/m"');
    expect(out).toContain('"theme": "nord"');
    expect(r.written).toBe(1);
    expect(r.files).toEqual(['opencode.jsonc']);
  });
  it('json は 2 空白で整形し直す（1 行の json が複数行になる）。未知の鍵は保つ', () => {
    put('opencode.json', '{"model":"old","mystery":{"a":1}}');
    setup([{ id: jid('model'), kind: 'opencode-config', op: 'overwrite', content: val('new') }]);
    run();
    expect(get('opencode.json')).toBe('{\n  "model": "new",\n  "mystery": {\n    "a": 1\n  }\n}\n');
  });
  it('両方あれば jsonc に書く（opencode が勝たせる方）。json は触らない', () => {
    put('opencode.json', '{"model":"j"}');
    put('opencode.jsonc', '{"model":"c"}');
    setup([{ id: jid('model'), kind: 'opencode-config', op: 'overwrite', content: val('n') }]);
    run();
    expect(get('opencode.json')).toBe('{"model":"j"}');
    expect(JSON.parse(get('opencode.jsonc')!).model).toBe('n');
  });
  it('どちらも無ければ opencode.json を 2 空白で新規に作る', () => {
    setup([{ id: jid('agent', 'a', 'description'), kind: 'opencode-config', op: 'create', content: val('d') }]);
    run();
    expect(get('opencode.json')).toBe('{\n  "agent": {\n    "a": {\n      "description": "d"\n    }\n  }\n}\n');
  });
  it('消去は鍵を消し、空になった agent の表も消す', () => {
    put('opencode.jsonc', '{"agent":{"a":{"description":"d"},"b":{"mode":"x"}},"model":"m"}');
    order({ id: jid('agent', 'a', 'description'), kind: 'opencode-config', op: 'delete' }, { id: jid('model'), kind: 'opencode-config', op: 'delete' });
    run();
    expect(JSON.parse(get('opencode.jsonc')!)).toEqual({ agent: { b: { mode: 'x' } } });
  });
  it('instructions は手元の絶対パスの要素を残して差し替える', () => {
    put('opencode.jsonc', '{"instructions":["old.md","/mine/abs.md"]}');
    setup([{ id: jid('instructions'), kind: 'opencode-config', op: 'overwrite', content: val(['new.md']) }]);
    run();
    expect(JSON.parse(get('opencode.jsonc')!).instructions).toEqual(['new.md', '/mine/abs.md']);
  });
  it('手元の provider や知らない鍵は、鍵を書いても消えない', () => {
    put('opencode.jsonc', '{\n  "provider": {"x": {"options": {"apiKey": "local"}}}\n}\n');
    setup([{ id: jid('model'), kind: 'opencode-config', op: 'create', content: val('m') }]);
    run();
    expect(JSON.parse(get('opencode.jsonc')!)).toEqual({ provider: { x: { options: { apiKey: 'local' } } }, model: 'm' });
  });
  it('cli.json は体裁を保って鍵だけ差し替える', () => {
    put('cli.json', '{\n  // theme\n  "theme": {"name": "a"}, "plugins": ["/p.js"]\n}\n');
    setup([{ id: cid('theme'), kind: 'opencode-cli', op: 'overwrite', content: val({ name: 'nord' }) }]);
    run();
    const out = get('cli.json')!;
    expect(out).toContain('// theme');
    expect(parseJsonc(out)).toEqual({ theme: { name: 'nord' }, plugins: ['/p.js'] });
  });
  it('ファイルを書き、消す', () => {
    put('agents/old.md', 'old');
    setup([{ id: 'opencode:file:AGENTS.md', kind: 'opencode-file', op: 'create', content: 'rules' }, { id: 'opencode:file:plugins/p.ts', kind: 'opencode-file', op: 'create', content: 'code' }]);
    run();
    expect(get('AGENTS.md')).toBe('rules');
    expect(get('plugins/p.ts')).toBe('code');
    order({ id: 'opencode:file:agents/old.md', kind: 'opencode-file', op: 'delete' });
    run();
    expect(get('agents/old.md')).toBeNull();
  });
  it('書いた項目は基準に入り、消した項目は基準から消える', () => {
    setup([{ id: jid('model'), kind: 'opencode-config', op: 'create', content: val('m') }]);
    run();
    expect(new ConfigBase(db).all().get(jid('model'))).toBe(sha(val('m')));
    fs.rmSync(path.join(home, 'claude-config', 'inbox'), { recursive: true });
    order({ id: jid('model'), kind: 'opencode-config', op: 'delete' });
    run();
    expect(new ConfigBase(db).all().has(jid('model'))).toBe(false);
  });
});

describe('書き戻し：控えと安全', () => {
  it('書く前に backups/opencode-config/<時刻>/ に元の中身を控える', () => {
    put('opencode.jsonc', '{"model":"old"}');
    setup([{ id: jid('model'), kind: 'opencode-config', op: 'overwrite', content: val('new') }, { id: 'opencode:file:AGENTS.md', kind: 'opencode-file', op: 'create', content: 'x' }]);
    const r = run();
    const gdir = path.join(home, 'backups', 'opencode-config', r.generation!);
    expect(fs.readFileSync(path.join(gdir, 'opencode.jsonc'), 'utf8')).toBe('{"model":"old"}');
    const meta = JSON.parse(fs.readFileSync(path.join(gdir, '.hangar-apply.json'), 'utf8'));
    expect(meta.created).toEqual(['AGENTS.md']);
  });
  it('控えを取れなければ何も書かない', () => {
    put('opencode.jsonc', '{"model":"old"}');
    fs.mkdirSync(path.join(home, 'backups'));
    fs.writeFileSync(path.join(home, 'backups', 'opencode-config'), 'ファイルが邪魔をする');
    setup([{ id: jid('model'), kind: 'opencode-config', op: 'overwrite', content: val('new') }]);
    expect(() => run()).toThrow();
    expect(get('opencode.jsonc')).toBe('{"model":"old"}');
  });
  it('途中の失敗は元へ戻し、作ったファイルも消す', () => {
    put('opencode.jsonc', '{"model":"old"}');
    setup([{ id: 'opencode:file:AGENTS.md', kind: 'opencode-file', op: 'create', content: 'x' }, { id: jid('model'), kind: 'opencode-config', op: 'overwrite', content: val('new') }]);
    const e = fail(() => run({ onWrite: (_rel: string, i: number) => { if (i === 1) throw new Error('boom'); } }));
    expect(e.code).toBe('write-failed');
    expect(get('opencode.jsonc')).toBe('{"model":"old"}');
    expect(get('AGENTS.md')).toBeNull();
  });
  it('壊れた設定ファイルには書かない', () => {
    put('opencode.jsonc', '{ "model": ');
    setup([{ id: jid('theme'), kind: 'opencode-config', op: 'create', content: val('x') }]);
    expect(fail(() => run()).code).toBe('settings-unreadable');
    expect(get('opencode.jsonc')).toBe('{ "model": ');
  });
  it('リンクの先へは書かない', () => {
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(dir, 'agents'));
    setup([{ id: 'opencode:file:agents/a.md', kind: 'opencode-file', op: 'create', content: 'x' }]);
    expect(fail(() => run()).code).toBe('unsafe');
    expect(fs.readdirSync(path.join(tmp, 'elsewhere'))).toEqual([]);
  });
  it('型の合わない値、外を指す値、書き込み先の食い違いは書かない', () => {
    setup([{ id: jid('model'), kind: 'opencode-config', op: 'create', content: val(5) }]);
    expect(fail(() => run()).code).toBe('bad-content');
    setup([{ id: jid('agent', 'a', 'prompt'), kind: 'opencode-config', op: 'create', content: val('{file:/etc/x}') }]);
    expect(fail(() => run()).code).toBe('bad-content');
    setup([{ id: jid('model'), kind: 'opencode-config', op: 'create', content: val('m') }]);
    writeApplyOrder(home, 'dev-a', [{ ...orderItem({ id: jid('model'), kind: 'opencode-config', op: 'create', content: val('m') }), target: 'opencode.json#theme' }], NOW);
    expect(fail(() => run()).code).toBe('unsafe');
    expect(get('opencode.json')).toBeNull();
  });
  it('inbox と指紋が合わなければ stale', () => {
    inbox([{ id: jid('model'), kind: 'opencode-config', content: val('a') }]);
    order({ id: jid('model'), kind: 'opencode-config', op: 'create', content: val('b') });
    expect(fail(() => run()).code).toBe('stale');
  });
  it('他の対象の項目は見ない。指示書を消さない', () => {
    setup([{ id: jid('model'), kind: 'opencode-config', op: 'create', content: val('m') }]);
    run();
    expect(fs.existsSync(path.join(home, 'claude-config', 'apply-order.json'))).toBe(true);
  });
  it('競合で手元を採る項目は書かず、控えも作らない', () => {
    put('opencode.jsonc', '{"model":"mine"}');
    inbox([{ id: jid('model'), kind: 'opencode-config', content: val('theirs') }]);
    order({ id: jid('model'), kind: 'opencode-config', op: 'conflict', content: val('theirs'), take: 'mine' });
    const r = run();
    expect(r.keptMine).toBe(1);
    expect(r.generation).toBeNull();
    expect(get('opencode.jsonc')).toBe('{"model":"mine"}');
    expect(listBackups(home)).toEqual([]);
  });
  it('見立て：書く数と承諾が要る指示を数える', () => {
    setup([
      { id: 'opencode:file:agents/a.md', kind: 'opencode-file', op: 'create', content: 'x' },
      { id: 'opencode:file:AGENTS.md', kind: 'opencode-file', op: 'create', content: 'y' },
      { id: jid('model'), kind: 'opencode-config', op: 'overwrite', content: val('m') },
    ]);
    const p = planOpencodeWrite({ home });
    expect(p.counts).toMatchObject({ create: 2, overwrite: 1 });
    expect(p.instructions).toBe(1);
    expect(p.byKind).toEqual({ 'opencode-file': 2, 'opencode-config': 1 });
    expect(get('opencode.json')).toBeNull();
  });
});
