import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigApplyOrderItemDto, ConfigInboxOp, ConfigItemKind } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectMode, posixIt } from '../../../../test/platform.ts';
import { openDb, type Db } from '../../../db/open.ts';
import { ApplyError } from '../apply.ts';
import { readApplyOrder, writeApplyOrder } from '../applyOrder.ts';
import { ConfigBase } from '../base.ts';
import { canonicalJson } from '../settingsSort.ts';
import { writeInbox } from '../inbox.ts';
import { codexTomlId, parseItemId } from '../ids.ts';
import { judge, type RemoteSnapshot } from '../threeWay.ts';
import { claudeMcpTarget, planClaudeMcp, planClaudeMcpFiles, writeClaudeMcp } from './claudeMcp.ts';
import { codexMcpTarget, planCodexMcpFiles, writeCodexMcp } from './codexMcp.ts';
import { codexTarget, writeCodex } from './codex.ts';
import { enabledTargetNames, collectAll, targetNameOfId, type TargetContext } from './index.ts';
import { holdOfMcp, isHangarEntry, mcpIdOf, mcpSecret, CLAUDE_MCP_PREFIX, CODEX_MCP_PREFIX, OPENCODE_MCP_PREFIX } from './mcpCommon.ts';
import { opencodeMcpNotes, opencodeMcpTarget, writeOpencodeMcp } from './opencodeMcp.ts';
import { opencodeTarget, writeOpencode } from './opencode.ts';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();

/** 実物の ~/.claude.json の形を、値を作り物にして写した見本。Claude Code は JSON.stringify の 2 空白で書く。プロジェクトの中の mcpServers は読まない。 */
const CLAUDE_JSON = `${JSON.stringify({
  numStartups: 12,
  installMethod: 'native',
  projects: { '/work/example': { allowedTools: [], mcpServers: { inproject: { command: 'inproject-server' } } } },
  mcpServers: {
    hangar: { type: 'http', url: 'http://127.0.0.1:4177/mcp', headers: { Authorization: 'Bearer ${HANGAR_TOKEN}' } },
    docs: { type: 'http', url: 'https://mcp.example.com/mcp' },
    files: { type: 'stdio', command: 'npx', args: ['-y', '@example/files'], env: { ROOT: '/data' } },
  },
  tipsHistory: { a: 3 },
}, null, 2)}\n`;

const CODEX_TOML = `# my codex config
model = "m-main"   # trailing

[mcp_servers.docs]
url = "https://mcp.example.com/mcp"

[mcp_servers.files]
command = "npx"
args = ["-y", "@example/files"]

[mcp_servers.files.env]
ROOT = "/data"

[tui]
theme = "dark"
`;

const OPENCODE_JSONC = `{
  // my opencode config
  "model": "p/m",
  "mcp": {
    "docs": { "type": "remote", "url": "https://mcp.example.com/mcp" },
    "files": { "type": "local", "command": ["npx", "-y", "@example/files"], "environment": { "ROOT": "/data" } }
  }
}
`;

let tmp: string;
let hangarHome: string;
let codexHome: string;
let opencodeDir: string;
let claudeJson: string;
let db: Db;
const ctx = (o: Partial<TargetContext> = {}): TargetContext => ({
  db, deviceId: 'dev-a', home: tmp, claudeDir: path.join(tmp, 'claude'), allowedUnsent: new Map(),
  codexHome, codexEnabled: true, opencodeDir, opencodeEnabled: true,
  agentsSkillsDir: path.join(tmp, 'agents'), claudeJsonPath: claudeJson, hangarSettingsPath: path.join(tmp, 'settings.json'),
  switches: { 'claude-mcp': true, 'codex-mcp': true, 'opencode-mcp': true }, ...o,
});
const rd = (f: string): string => fs.readFileSync(f, 'utf8');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-'));
  hangarHome = path.join(tmp, 'hangar');
  codexHome = path.join(tmp, 'codex-home');
  opencodeDir = path.join(tmp, 'opencode');
  claudeJson = path.join(tmp, 'claude.json');
  for (const d of [hangarHome, codexHome, opencodeDir]) fs.mkdirSync(d);
  db = openDb(':memory:');
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('MCP の id と持ち主', () => {
  it('3 つの対象が別々に持つ。Claude や好みの鍵の対象は持たない', () => {
    expect(targetNameOfId('claude-mcp:docs')).toBe('claude-mcp');
    expect(targetNameOfId('codex:mcp:docs')).toBe('codex-mcp');
    expect(targetNameOfId('opencode:mcp:docs')).toBe('opencode-mcp');
    expect(codexTarget.owns('codex:mcp:docs')).toBe(false);
    expect(opencodeTarget.owns('opencode:mcp:docs')).toBe(false);
    expect(parseItemId('claude-mcp:docs')).toEqual({ kind: 'claude-mcp', ref: { type: 'claude-mcp', name: 'docs' } });
    expect(parseItemId('codex:mcp:docs')?.kind).toBe('codex-mcp');
    expect(parseItemId('opencode:mcp:docs')?.kind).toBe('opencode-mcp');
  });
  it('名前は符号化して往復する。hangar、空、往復しない形は解かない', () => {
    for (const n of ['my server', 'a.b', '日本語', 'x/y']) expect(parseItemId(mcpIdOf(CLAUDE_MCP_PREFIX, n))?.ref).toEqual({ type: 'claude-mcp', name: n });
    for (const id of ['claude-mcp:hangar', 'claude-mcp:HANGAR', 'codex:mcp:hangar', 'opencode:mcp:Hangar', 'claude-mcp:', 'claude-mcp:a b', 'claude-mcp:%ZZ', 'claude-mcp:__proto__']) expect(parseItemId(id), id).toBeNull();
  });
  it('codex の好みの鍵の道に mcp_servers は出ない（codex の対象は読み飛ばし、MCP の対象が別に集める）', () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), CODEX_TOML);
    const c = codexTarget.collect(ctx({ switches: { codex: true } }));
    expect(c.items.map((i) => i.id).filter((i) => i.includes('mcp'))).toEqual([]);
    expect(c.items.map((i) => i.id)).toContain(codexTomlId(['model']));
  });
});

describe('集める：Claude の ~/.claude.json', () => {
  beforeEach(() => fs.writeFileSync(claudeJson, CLAUDE_JSON));

  it('最上位の mcpServers だけを名前ごとに集め、URL も stdio も運び、hangar とプロジェクトの中のものは運ばない', () => {
    const c = claudeMcpTarget.collect(ctx());
    expect(c.items.map((i) => i.id)).toEqual(['claude-mcp:docs', 'claude-mcp:files']);
    expect(c.items.every((i) => i.kind === 'claude-mcp' && i.withheld === null && i.target.startsWith('.claude.json#mcpServers.'))).toBe(true);
    expect(JSON.parse(c.items[1]!.content.toString())).toEqual({ args: ['-y', '@example/files'], command: 'npx', env: { ROOT: '/data' }, type: 'stdio' });
    expect(c.items[1]!.marks).toEqual(['shell']);
    expect(c.items[0]!.marks).toEqual([]);
    expect(c.unsent).toEqual([]);
    expect(c.blocked.ids.has('claude-mcp:hangar')).toBe(false);
  });
  it('command が hangar を指す登録も、名前が違っても運ばない', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { mine: { command: '/Applications/Hangar.app/Contents/MacOS/hangar', args: ['mcp'] }, mine2: { command: 'hangar', args: [] }, mine3: { command: 'node', args: ['/x/agent-hangar/bin.js'] }, ok: { command: 'npx' } } }));
    expect(claudeMcpTarget.collect(ctx()).items.map((i) => i.id)).toEqual(['claude-mcp:ok']);
    expect(isHangarEntry('claude', 'x', { command: 'hangar.exe' })).toBe(true);
    expect(isHangarEntry('opencode', 'x', { type: 'local', command: ['hangar', 'mcp'] })).toBe(true);
  });
  it('入切の既定は切。入れても、その PC の入れ物が無ければ何も集めない', () => {
    expect(claudeMcpTarget.enabled(ctx({ switches: {} }))).toBe(false);
    expect(claudeMcpTarget.enabled(ctx())).toBe(true);
    expect(enabledTargetNames(ctx())).toEqual(expect.arrayContaining(['claude-mcp', 'codex-mcp', 'opencode-mcp']));
    fs.rmSync(claudeJson);
    expect(claudeMcpTarget.collect(ctx()).items).toEqual([]);
  });
  it('~/.claude.json が壊れている、リンクのときは、運べないものとして塞ぐ', () => {
    fs.writeFileSync(claudeJson, '{ broken');
    expect(claudeMcpTarget.collect(ctx()).blocked.prefixes).toContain('claude-mcp:');
  });
  it('形の読めない登録は運ばず、同名の項目が届いても上書きしないよう塞ぐ', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { bad: { type: 'http' }, bad2: 'x', ok: { command: 'npx' } } }));
    const c = claudeMcpTarget.collect(ctx());
    expect(c.items.map((i) => i.id)).toEqual(['claude-mcp:ok']);
    expect([...c.blocked.ids].sort()).toEqual(['claude-mcp:bad', 'claude-mcp:bad2']);
  });
});

describe('集める：Codex と opencode', () => {
  it('Codex の表を、小表ごと 1 項目で集める。その PC で Codex が無効なら集めない', () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), CODEX_TOML);
    const c = codexMcpTarget.collect(ctx());
    expect(c.items.map((i) => i.id)).toEqual(['codex:mcp:docs', 'codex:mcp:files']);
    expect(JSON.parse(c.items[1]!.content.toString())).toEqual({ args: ['-y', '@example/files'], command: 'npx', env: { ROOT: '/data' } });
    expect(codexMcpTarget.enabled(ctx({ codexEnabled: false }))).toBe(false);
    expect(codexMcpTarget.enabled(ctx({ switches: {} }))).toBe(false);
  });
  it('opencode の mcp を集める。jsonc が正。その PC で opencode が無効なら集めない', () => {
    fs.writeFileSync(path.join(opencodeDir, 'opencode.jsonc'), OPENCODE_JSONC);
    fs.writeFileSync(path.join(opencodeDir, 'opencode.json'), JSON.stringify({ mcp: { other: { type: 'remote', url: 'https://x' } } }));
    const c = opencodeMcpTarget.collect(ctx());
    expect(c.items.map((i) => i.id)).toEqual(['opencode:mcp:docs', 'opencode:mcp:files']);
    expect(opencodeMcpTarget.enabled(ctx({ opencodeEnabled: false }))).toBe(false);
  });
  it('3 つの入れ物から集め、opencode と codex の好みの対象には MCP が混ざらない', () => {
    fs.writeFileSync(claudeJson, CLAUDE_JSON);
    fs.writeFileSync(path.join(codexHome, 'config.toml'), CODEX_TOML);
    fs.writeFileSync(path.join(opencodeDir, 'opencode.jsonc'), OPENCODE_JSONC);
    const ids = collectAll(ctx({ switches: { 'claude-mcp': true, 'codex-mcp': true, 'opencode-mcp': true, codex: true, opencode: true } })).items.map((i) => i.id);
    expect(ids.filter((i) => i.includes('mcp'))).toEqual(['claude-mcp:docs', 'claude-mcp:files', 'codex:mcp:docs', 'codex:mcp:files', 'opencode:mcp:docs', 'opencode:mcp:files']);
    expect(ids.filter((i) => i.startsWith('opencode:json:') && i.includes('mcp'))).toEqual([]);
  });
});

describe('秘密', () => {
  const put = (servers: Record<string, unknown>): void => { fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: servers })); };

  it('既知の形の秘密が env や headers にあれば、送らずに「送らなかった項目」へ出す', () => {
    put({ a: { command: 'x', env: { KEY: `sk-ant-${'a'.repeat(30)}` } }, b: { type: 'http', url: 'https://x', headers: { 'X-Y': `ghp_${'b'.repeat(36)}` } } });
    const c = claudeMcpTarget.collect(ctx());
    expect(c.items.map((i) => [i.id, i.withheld])).toEqual([['claude-mcp:a', 'secret'], ['claude-mcp:b', 'secret']]);
    expect(c.unsent.map((u) => [u.id, u.kind, u.itemId, u.allowed, u.reason])).toEqual([
      ['secret:claude-mcp:a', 'secret', 'claude-mcp:a', false, 'secret:sk-ant-'], ['secret:claude-mcp:b', 'secret', 'claude-mcp:b', false, 'secret:ghp_'],
    ]);
    expect(JSON.stringify(c.unsent)).not.toContain('aaaaaaaa');
  });
  it('名前が秘密らしい鍵の直書きの値（トークン、Authorization、bearer_token、URL の問い合わせ、引数）も止める', () => {
    expect(mcpSecret('claude', { command: 'x', env: { API_TOKEN: 'abc123' } })).toBe('mcp-credential');
    expect(mcpSecret('claude', { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer abc123' } })).toBe('mcp-credential');
    expect(mcpSecret('codex', { url: 'https://x', bearer_token: 'abc123' })).toBe('mcp-credential');
    expect(mcpSecret('codex', { url: 'https://x', http_headers: { 'X-Api-Key': 'abc' } })).toBe('mcp-credential');
    expect(mcpSecret('opencode', { type: 'remote', url: 'https://x', headers: { Authorization: 'Bearer abc123' } })).toBe('mcp-credential');
    expect(mcpSecret('opencode', { type: 'local', command: ['x'], environment: { MY_SECRET: 'abc' } })).toBe('mcp-credential');
    expect(mcpSecret('claude', { type: 'http', url: 'https://x/mcp?api_key=abc123' })).toBe('mcp-credential');
    expect(mcpSecret('claude', { command: 'x', args: ['--token=abc123'] })).toBe('mcp-credential');
  });
  it('環境変数への参照や、秘密でない値は止めない', () => {
    expect(mcpSecret('claude', { command: 'x', env: { API_TOKEN: '${API_TOKEN}', ROOT: '/data' } })).toBeNull();
    expect(mcpSecret('claude', { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}' } })).toBeNull();
    expect(mcpSecret('codex', { url: 'https://x', bearer_token_env_var: 'MY_TOKEN', env_http_headers: { 'X-Key': 'MY_KEY' } })).toBeNull();
    expect(mcpSecret('opencode', { type: 'remote', url: 'https://x', headers: { Authorization: 'Bearer {env:TOKEN}' } })).toBeNull();
    expect(mcpSecret('claude', { command: 'x', args: ['--token=${TOKEN}'] })).toBeNull();
  });
  it('「それでも送る」を選んだ項目（同じ指紋）は送る。中身が変われば、また止まる', () => {
    put({ a: { command: 'x', env: { KEY: `sk-ant-${'a'.repeat(30)}` } } });
    const first = claudeMcpTarget.collect(ctx());
    const hash = first.items[0]!.sha256;
    const allowed = claudeMcpTarget.collect(ctx({ allowedUnsent: new Map([['secret:claude-mcp:a', hash]]) }));
    expect(allowed.items[0]!.withheld).toBeNull();
    expect(allowed.unsent[0]!.allowed).toBe(true);
    put({ a: { command: 'x', env: { KEY: `sk-ant-${'b'.repeat(30)}` } } });
    expect(claudeMcpTarget.collect(ctx({ allowedUnsent: new Map([['secret:claude-mcp:a', hash]]) })).items[0]!.withheld).toBe('secret');
  });
  it('Codex と opencode の秘密も同じように止める', () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.a]\nurl = "https://x"\nbearer_token = "abc123"\n');
    fs.writeFileSync(path.join(opencodeDir, 'opencode.json'), JSON.stringify({ mcp: { a: { type: 'remote', url: 'https://x', headers: { Authorization: 'Bearer abc' } } } }));
    expect(codexMcpTarget.collect(ctx()).items[0]!.withheld).toBe('secret');
    expect(opencodeMcpTarget.collect(ctx()).items[0]!.withheld).toBe('secret');
  });
});

describe('受け手の保留', () => {
  it('絶対パスの command が受け手に無ければ保留。あれば保留しない。相対の command は保留しない', () => {
    const none = { exists: () => false };
    expect(holdOfMcp('claude', { command: '/opt/tool/server' }, none)).toEqual({ reason: 'command-missing', path: '/opt/tool/server' });
    expect(holdOfMcp('claude', { command: 'C:\\tools\\server.exe' }, none)?.reason).toBe('command-missing');
    expect(holdOfMcp('claude', { command: '~/bin/server' }, { exists: (p) => p === path.join('/h', 'bin/server'), home: '/h' })).toBeNull();
    expect(holdOfMcp('claude', { command: '/opt/tool/server' }, { exists: () => true })).toBeNull();
    expect(holdOfMcp('claude', { command: 'npx' }, none)).toBeNull();
    expect(holdOfMcp('claude', { type: 'http', url: 'https://x' }, none)).toBeNull();
    expect(holdOfMcp('opencode', { type: 'local', command: ['/opt/x', 'a'] }, none)?.path).toBe('/opt/x');
    expect(holdOfMcp('codex', { command: 'npx', cwd: '/nowhere' }, none)?.path).toBe('/nowhere');
  });
  it('opencode は受け手の環境に無い {env:X} を知らせる', () => {
    const item = { id: 'opencode:mcp:a', content: Buffer.from(JSON.stringify({ type: 'remote', url: 'https://x', headers: { Authorization: 'Bearer {env:MCP_TOKEN_X}' } })) };
    expect(opencodeMcpNotes(item, {})).toEqual({ missingEnv: ['MCP_TOKEN_X'] });
    expect(opencodeMcpNotes(item, { MCP_TOKEN_X: '1' })).toEqual({ missingEnv: [] });
  });
});

describe('承諾', () => {
  it('設定が each のあいだは、作る・上書き・消去のどれも承諾が要る。auto なら要らない', () => {
    for (const t of [claudeMcpTarget, codexMcpTarget, opencodeMcpTarget]) {
      for (const op of ['create', 'overwrite', 'delete', 'conflict'] as const) {
        expect(t.needsApproval({ id: 'x:y', kind: 'claude-mcp', op }, 'each'), `${t.name} ${op}`).toBe(true);
        expect(t.needsApproval({ id: 'x:y', kind: 'claude-mcp', op }, 'auto')).toBe(false);
      }
    }
  });
});

describe('古い版の束', () => {
  const snap = (deviceId: string, at: number, items: Record<string, string>, targets?: string[]): RemoteSnapshot => ({
    deviceId, at, items: new Map(Object.entries(items).map(([id, sha256]) => [id, { sha256 }])), ...(targets ? { targets: new Set(targets) } : {}),
  });
  const m = (o: Record<string, string>) => new Map(Object.entries(o));
  const mine = { 'claude-mcp:a': 'x', 'codex:mcp:a': 'x', 'opencode:mcp:a': 'x', 'file:CLAUDE.md': 'h' };

  it('targets の無い束（古い版）にも、claude だけの束にも無いことは、消去にも forget にもならない', () => {
    for (const old of [snap('B', 10, { 'file:CLAUDE.md': 'h' }), snap('B', 10, { 'file:CLAUDE.md': 'h' }, ['claude'])]) {
      const j = judge({ local: m(mine), base: m(mine), remotes: [old] });
      expect(j.actions).toEqual([]);
      expect(j.forget).toEqual([]);
    }
  });
  it('MCP の対象を扱う相手が持っていなければ、今までどおり消去になる。対象ごとに数える', () => {
    const j = judge({ local: m(mine), base: m(mine), remotes: [snap('B', 10, { 'file:CLAUDE.md': 'h' }, ['claude', 'claude-mcp'])] });
    expect(j.actions.map((a) => [a.id, a.op])).toEqual([['claude-mcp:a', 'delete']]);
  });
  it('手元で切の対象の項目は create されない', () => {
    const j = judge({ local: m({}), base: m({}), remotes: [snap('B', 10, { 'codex:mcp:a': 'y' }, ['claude', 'codex-mcp'])], localTargets: new Set(['claude']) });
    expect(j.actions).toEqual([]);
  });
});

// ---- 書き戻し ----

type OrderIn = { id: string; kind: ConfigItemKind; op: ConfigInboxOp; value: unknown | undefined; target: string; take?: 'remote' | 'mine'; marks?: ('shell')[] };
const claudeItem = (name: string, op: ConfigInboxOp, value: unknown | undefined): OrderIn => ({ id: mcpIdOf(CLAUDE_MCP_PREFIX, name), kind: 'claude-mcp', op, value, target: `.claude.json#mcpServers.${name}` });
const codexItem = (name: string, op: ConfigInboxOp, value: unknown | undefined): OrderIn => ({ id: mcpIdOf(CODEX_MCP_PREFIX, name), kind: 'codex-mcp', op, value, target: `config.toml#mcp_servers.${name}` });
const ocItem = (name: string, op: ConfigInboxOp, value: unknown | undefined): OrderIn => ({ id: mcpIdOf(OPENCODE_MCP_PREFIX, name), kind: 'opencode-mcp', op, value, target: `opencode.json#mcp.${name}` });

function deliver(items: OrderIn[], extraContent: { id: string; kind: ConfigItemKind; op: ConfigInboxOp; content: string | null; target: string }[] = []): void {
  const blobs = new Map<string, Buffer>();
  const all = [...items.map((i) => ({ id: i.id, kind: i.kind, op: i.op, content: i.value === undefined ? null : canonicalJson(i.value), target: i.target, take: i.take })), ...extraContent.map((i) => ({ ...i, take: undefined as undefined }))];
  const manifestItems = all.filter((i) => i.content !== null).map((i) => { const b = Buffer.from(i.content!); blobs.set(sha(b), b); return { id: i.id, kind: i.kind, sha256: sha(b), size: b.length, marks: [] as never[] }; });
  writeInbox(hangarHome, 'dev-b', { manifest: { version: 1, deviceId: 'dev-b', createdAt: NOW, items: manifestItems, targets: ['claude', 'claude-mcp', 'codex', 'codex-mcp', 'opencode', 'opencode-mcp'] }, blobs, skipped: 0 }, { bundleSha256: sha('b'), forRowSha256: 'row', at: NOW, itemCount: manifestItems.length, skipped: 0, targets: ['claude', 'claude-mcp', 'codex', 'codex-mcp', 'opencode', 'opencode-mcp'] });
  const dtos: ConfigApplyOrderItemDto[] = all.map((o) => ({ id: o.id, kind: o.kind, op: o.op, take: o.take ?? 'remote', fromDeviceId: 'dev-b', sha256: o.content === null ? '' : sha(o.content), target: o.target }));
  writeApplyOrder(hangarHome, 'dev-a', dtos, NOW);
}
const present = { exists: () => true };
const opts = () => ({ home: hangarHome, claudeDir: path.join(tmp, 'claude'), db, now: () => NOW, claudeJsonPath: claudeJson, codexHome, opencodeDir, ...present });
const gens = (dir: string): string[] => { try { return fs.readdirSync(path.join(hangarHome, 'backups', dir)); } catch { return []; } };
const failOf = (fn: () => unknown): ApplyError => { try { fn(); } catch (e) { if (e instanceof ApplyError) return e; throw e; } throw new Error('投げられなかった'); };

describe('書き戻し：Claude の ~/.claude.json', () => {
  beforeEach(() => fs.writeFileSync(claudeJson, CLAUDE_JSON));
  const URL_ENTRY = { type: 'http', url: 'https://new.example.com/mcp' };
  const STDIO_ENTRY = { command: 'uvx', args: ['tool'], env: { MODE: 'x' } };

  it('URL も stdio も、名前の鍵だけを足す。ほかの鍵と整形は 1 文字も変えない', () => {
    deliver([claudeItem('remote1', 'create', URL_ENTRY), claudeItem('local1', 'create', STDIO_ENTRY)]);
    const r = writeClaudeMcp(opts());
    const out = rd(claudeJson);
    const j = JSON.parse(out);
    expect(j.mcpServers.remote1).toEqual(URL_ENTRY);
    expect(j.mcpServers.local1).toEqual(STDIO_ENTRY);
    // 足した 2 つを除くと、元の文書と同じ（hangar の登録、プロジェクトの中の mcpServers、ほかの鍵）。
    const without = { ...j, mcpServers: Object.fromEntries(Object.entries(j.mcpServers).filter(([k]) => k !== 'remote1' && k !== 'local1')) };
    expect(without).toEqual(JSON.parse(CLAUDE_JSON));
    // 元の行は 1 行も変わらず、元の並びのまま残る（足した行が間に入るだけ）。
    const outLines = out.split('\n').map((l) => l.replace(/,$/, ''));
    let at = 0;
    for (const line0 of CLAUDE_JSON.split('\n')) { const line = line0.replace(/,$/, ''); const i = outLines.indexOf(line, at); expect(i, line).toBeGreaterThanOrEqual(at); at = i + 1; }
    expect(out.endsWith('\n')).toBe(true);
    expect(r.files).toEqual(['claude.json']);
    expect(new ConfigBase(db).all().get('claude-mcp:remote1')).toBe(sha(canonicalJson(URL_ENTRY)));
  });
  it('上書きと消去も、名前の鍵だけ。消しても他の MCP と hangar の登録は残る', () => {
    deliver([claudeItem('docs', 'overwrite', { type: 'http', url: 'https://changed' }), claudeItem('files', 'delete', undefined)]);
    writeClaudeMcp(opts());
    const j = JSON.parse(rd(claudeJson));
    expect(j.mcpServers.docs.url).toBe('https://changed');
    expect(j.mcpServers.files).toBeUndefined();
    expect(j.mcpServers.hangar.url).toBe('http://127.0.0.1:4177/mcp');
    expect(j.projects['/work/example'].mcpServers.inproject).toBeDefined();
    expect(j.numStartups).toBe(12);
    expect(new ConfigBase(db).all().has('claude-mcp:files')).toBe(false);
  });
  it('書く直前に読み直す。控えを取ったあとに Claude Code が足した鍵を消さない', () => {
    deliver([claudeItem('remote1', 'create', URL_ENTRY)]);
    writeClaudeMcp({ ...opts(), onWrite: () => { const j = JSON.parse(rd(claudeJson)); j.numStartups = 99; j.newKey = { x: 1 }; fs.writeFileSync(claudeJson, JSON.stringify(j, null, 2) + '\n'); } });
    const j = JSON.parse(rd(claudeJson));
    expect(j.numStartups).toBe(99);
    expect(j.newKey).toEqual({ x: 1 });
    expect(j.mcpServers.remote1).toEqual(URL_ENTRY);
  });
  it('書いた直後に Claude Code が古い中身で上書きしたら、読み直しからやり直して、両方の変更を残す', () => {
    deliver([claudeItem('remote1', 'create', URL_ENTRY)]);
    const real = fs.renameSync.bind(fs);
    let hit = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      real(a, b);
      if (String(b) === claudeJson && hit++ === 0) { const j = JSON.parse(CLAUDE_JSON); j.numStartups = 50; fs.writeFileSync(claudeJson, `${JSON.stringify(j, null, 2)}\n`); }
    });
    try { writeClaudeMcp(opts()); } finally { spy.mockRestore(); }
    const j = JSON.parse(rd(claudeJson));
    expect(j.numStartups).toBe(50);
    expect(j.mcpServers.remote1).toEqual(URL_ENTRY);
  });
  it('何度やり直しても合わなければ、控えから戻して失敗にする（指示書は残す）', () => {
    deliver([claudeItem('remote1', 'create', URL_ENTRY)]);
    const real = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      real(a, b);
      if (String(b) === claudeJson) fs.writeFileSync(claudeJson, CLAUDE_JSON);
    });
    let err: ApplyError;
    try { err = failOf(() => writeClaudeMcp(opts())); } finally { spy.mockRestore(); }
    expect(err.code).toBe('write-failed');
    expect(rd(claudeJson)).toBe(CLAUDE_JSON);
    expect(readApplyOrder(hangarHome)).not.toBeNull();
    expect(new ConfigBase(db).all().has('claude-mcp:remote1')).toBe(false);
    expect(gens('claude-mcp-config')).toEqual([]);
  });
  it('控えを取る（自分専用）。控えは書く前の中身で、取れなければ書かない', () => {
    deliver([claudeItem('remote1', 'create', URL_ENTRY)]);
    const r = writeClaudeMcp(opts());
    const b = path.join(hangarHome, 'backups', 'claude-mcp-config', r.generation!, 'claude.json');
    expect(rd(b)).toBe(CLAUDE_JSON);
    expectMode(b, 0o600);
    // 控えの置き場が作れない（backups がファイル）なら、何も書かない。
    fs.rmSync(path.join(hangarHome, 'backups'), { recursive: true, force: true });
    fs.writeFileSync(path.join(hangarHome, 'backups'), 'not a dir');
    fs.writeFileSync(claudeJson, CLAUDE_JSON);
    deliver([claudeItem('remote2', 'create', URL_ENTRY)]);
    expect(failOf(() => writeClaudeMcp(opts())).code).toBe('write-failed');
    expect(rd(claudeJson)).toBe(CLAUDE_JSON);
  });
  it('見立ては何も書かない。差分と指紋を返し、指紋が合わなければ書かずに断る', () => {
    deliver([claudeItem('remote1', 'create', URL_ENTRY)]);
    const plan = planClaudeMcp({ home: hangarHome });
    expect(plan.counts.create).toBe(1);
    expect(plan.byKind).toEqual({ 'claude-mcp': 1 });
    const files = planClaudeMcpFiles({ home: hangarHome, claudeJsonPath: claudeJson });
    expect(files.files[0]).toMatchObject({ rel: 'claude.json', op: 'modify' });
    expect(files.files[0]!.lines.length).toBeGreaterThan(0);
    expect(rd(claudeJson)).toBe(CLAUDE_JSON);
    expect(gens('claude-mcp-config')).toEqual([]);
    fs.writeFileSync(claudeJson, CLAUDE_JSON.replace('"numStartups": 12', '"numStartups": 13'));
    expect(failOf(() => writeClaudeMcp({ ...opts(), expect: files.fingerprint })).code).toBe('changed');
    expect(rd(claudeJson)).toContain('"numStartups": 13');
  });
  it('hangar 自身の登録は書かない', () => {
    // 名前が hangar の id は、指示書の読み込みの段階で受け付けない（id が解けない）。
    deliver([claudeItem('hangar', 'create', { type: 'http', url: 'http://127.0.0.1:1/mcp' })]);
    expect(['no-order', 'broken-order']).toContain(failOf(() => writeClaudeMcp(opts())).code);
    deliver([claudeItem('sneaky', 'create', { command: '/Applications/Hangar.app/Contents/MacOS/hangar' })]);
    expect(failOf(() => writeClaudeMcp(opts())).code).toBe('unsafe');
    expect(rd(claudeJson)).toBe(CLAUDE_JSON);
  });
  it('受け手に無い絶対パスの command は、見立ても書き込みも断る（何も書かない）', () => {
    deliver([claudeItem('abs', 'create', { command: '/opt/nowhere/server' })]);
    const e1 = failOf(() => planClaudeMcp({ home: hangarHome, exists: () => false }));
    expect(e1.code).toBe('unsafe');
    expect(e1.message).toContain('/opt/nowhere/server');
    expect(failOf(() => writeClaudeMcp({ ...opts(), exists: () => false })).code).toBe('unsafe');
    expect(rd(claudeJson)).toBe(CLAUDE_JSON);
    expect(gens('claude-mcp-config')).toEqual([]);
    writeClaudeMcp({ ...opts(), exists: (p) => p === '/opt/nowhere/server' });
    expect(JSON.parse(rd(claudeJson)).mcpServers.abs.command).toBe('/opt/nowhere/server');
  });
  it('形の悪い値、書き込み先の食い違いは断る', () => {
    deliver([claudeItem('bad', 'create', { type: 'http' })]);
    expect(failOf(() => writeClaudeMcp(opts())).code).toBe('bad-content');
    deliver([{ ...claudeItem('docs', 'overwrite', URL_ENTRY), target: '.claude.json#mcpServers.other' }]);
    expect(failOf(() => writeClaudeMcp(opts())).code).toBe('unsafe');
    expect(rd(claudeJson)).toBe(CLAUDE_JSON);
  });
  it('~/.claude.json が壊れていれば書かない。リンクにも書かない', () => {
    fs.writeFileSync(claudeJson, '{ broken');
    deliver([claudeItem('remote1', 'create', URL_ENTRY)]);
    expect(failOf(() => writeClaudeMcp(opts())).code).toBe('settings-unreadable');
    expect(rd(claudeJson)).toBe('{ broken');
  });
  posixIt('リンクの ~/.claude.json には書かない（シンボリックリンクは symlink の作れる環境だけで確かめる）', () => {
    const real = path.join(tmp, 'real.json');
    fs.writeFileSync(real, CLAUDE_JSON);
    fs.rmSync(claudeJson);
    fs.symlinkSync(real, claudeJson);
    deliver([claudeItem('remote1', 'create', URL_ENTRY)]);
    expect(failOf(() => writeClaudeMcp(opts())).code).toBe('unsafe');
    expect(rd(real)).toBe(CLAUDE_JSON);
  });
  it('手元を残す指定だけなら何も書かず、基準だけ更新する。指示書は消さない', () => {
    deliver([{ ...claudeItem('docs', 'conflict', { type: 'http', url: 'https://remote' }), take: 'mine' }]);
    const r = writeClaudeMcp(opts());
    expect(r).toMatchObject({ generation: null, keptMine: 1, written: 0 });
    expect(rd(claudeJson)).toBe(CLAUDE_JSON);
    expect(readApplyOrder(hangarHome)).not.toBeNull();
  });
  it('~/.claude.json が無ければ作る（自分専用）', () => {
    fs.rmSync(claudeJson);
    deliver([claudeItem('remote1', 'create', URL_ENTRY)]);
    writeClaudeMcp(opts());
    expect(JSON.parse(rd(claudeJson))).toEqual({ mcpServers: { remote1: URL_ENTRY } });
    expectMode(claudeJson, 0o600);
  });
});

describe('書き戻し：Codex（好みの鍵と同じ config.toml）', () => {
  beforeEach(() => fs.writeFileSync(path.join(codexHome, 'config.toml'), CODEX_TOML));
  const cfg = (): string => rd(path.join(codexHome, 'config.toml'));
  const tomlItem = (p: string[], op: ConfigInboxOp, value: unknown) => ({ id: codexTomlId(p), kind: 'codex-config' as const, op, content: value === undefined ? null : JSON.stringify(value), target: `config.toml#${p.join('.')}` });

  it('表ごと（小表ごと）差し替え、コメントと他の表を保つ。消去は表ごと', () => {
    deliver([codexItem('files', 'overwrite', { url: 'https://other.example.com' }), codexItem('added', 'create', { command: 'uvx', args: ['t'], env: { A: 'b' } })]);
    writeCodexMcp(opts());
    const out = cfg();
    expect(out).toContain('# my codex config\nmodel = "m-main"   # trailing');
    expect(out).toContain('[mcp_servers.files]\nurl = "https://other.example.com"');
    expect(out).not.toContain('ROOT');
    expect(out).toContain('[mcp_servers.added.env]\nA = "b"');
    expect(out).toContain('[tui]\ntheme = "dark"');
    deliver([codexItem('docs', 'delete', undefined)]);
    writeCodexMcp(opts());
    expect(cfg()).not.toContain('mcp_servers.docs');
    expect(cfg()).toContain('[mcp_servers.files]');
  });
  it('好みの鍵の書き戻しと MCP の書き戻しが、互いの鍵を消さない（どちらの順でも）', () => {
    for (const order of ['codex-first', 'mcp-first'] as const) {
      fs.writeFileSync(path.join(codexHome, 'config.toml'), CODEX_TOML);
      deliver([codexItem('added', 'create', { url: 'https://added.example.com' }), codexItem('files', 'delete', undefined)], [tomlItem(['model'], 'overwrite', 'new-model'), tomlItem(['tui', 'theme'], 'overwrite', 'light')]);
      if (order === 'codex-first') { writeCodex({ ...opts() }); writeCodexMcp(opts()); } else { writeCodexMcp(opts()); writeCodex({ ...opts() }); }
      const out = cfg();
      expect(out, order).toContain('model = "new-model"   # trailing');
      expect(out, order).toContain('theme = "light"');
      expect(out, order).toContain('[mcp_servers.added]\nurl = "https://added.example.com"');
      expect(out, order).toContain('[mcp_servers.docs]');
      expect(out, order).not.toContain('mcp_servers.files');
      expect(out, order).toContain('# my codex config');
    }
  });
  it('見立ては config.toml の差分を返し、何も書かない', () => {
    deliver([codexItem('added', 'create', { url: 'https://added.example.com' })]);
    const p = planCodexMcpFiles({ home: hangarHome, codexHome });
    expect(p.files.map((f) => [f.rel, f.op])).toEqual([['config.toml', 'modify']]);
    expect(cfg()).toBe(CODEX_TOML);
  });
  it('config.toml が読めなければ書かない', () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'a = = 1\n');
    deliver([codexItem('added', 'create', { url: 'https://added.example.com' })]);
    expect(failOf(() => writeCodexMcp(opts())).code).toBe('settings-unreadable');
    expect(cfg()).toBe('a = = 1\n');
  });
  it('Codex の cwd が受け手に無ければ保留', () => {
    deliver([codexItem('c', 'create', { command: 'npx', cwd: '/nowhere/x' })]);
    expect(failOf(() => writeCodexMcp({ ...opts(), exists: () => false })).code).toBe('unsafe');
    expect(cfg()).toBe(CODEX_TOML);
  });
});

describe('書き戻し：opencode', () => {
  it('jsonc は体裁（コメント）を保って mcp の鍵だけ差し替え、好みの鍵の書き戻しと互いを消さない', () => {
    fs.writeFileSync(path.join(opencodeDir, 'opencode.jsonc'), OPENCODE_JSONC);
    deliver(
      [ocItem('added', 'create', { type: 'remote', url: 'https://added.example.com' }), ocItem('files', 'delete', undefined)],
      [{ id: 'opencode:json:model', kind: 'opencode-config', op: 'overwrite', content: JSON.stringify('p/other'), target: 'opencode.json#model' }],
    );
    writeOpencodeMcp(opts());
    writeOpencode({ ...opts(), opencodeDir });
    const out = rd(path.join(opencodeDir, 'opencode.jsonc'));
    expect(out).toContain('// my opencode config');
    expect(out).toContain('"model": "p/other"');
    expect(JSON.parse(out.replace(/\/\/.*$/m, '')).mcp.added.url).toBe('https://added.example.com');
    expect(JSON.parse(out.replace(/\/\/.*$/m, '')).mcp.docs.url).toBe('https://mcp.example.com/mcp');
    expect(JSON.parse(out.replace(/\/\/.*$/m, '')).mcp.files).toBeUndefined();
    expect(fs.existsSync(path.join(opencodeDir, 'opencode.json'))).toBe(false);
  });
  it('設定ファイルが無ければ opencode.json を 2 空白で作る。command が配列の stdio も受ける', () => {
    deliver([ocItem('local1', 'create', { type: 'local', command: ['uvx', 'tool'], environment: { A: 'b' } })]);
    writeOpencodeMcp(opts());
    // 運ぶ値の鍵は正規の並び（名前順）で届くので、書く並びもそれに従う。
    expect(rd(path.join(opencodeDir, 'opencode.json'))).toBe(`${JSON.stringify({ mcp: { local1: { command: ['uvx', 'tool'], environment: { A: 'b' }, type: 'local' } } }, null, 2)}\n`);
  });
  it('受け手に無い絶対パスの command（配列の先頭）は保留', () => {
    deliver([ocItem('abs', 'create', { type: 'local', command: ['/opt/nowhere/x', 'a'] })]);
    expect(failOf(() => writeOpencodeMcp({ ...opts(), exists: () => false })).code).toBe('unsafe');
    expect(fs.existsSync(path.join(opencodeDir, 'opencode.json'))).toBe(false);
  });
});
