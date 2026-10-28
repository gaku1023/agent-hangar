import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hangarServeConfig } from '../provider/opencode/launch.ts';
import { opencodeShareConfig, opencodeShareFor, userOpencodeConfig } from './opencode.ts';
import type { ShareFile, ShareMcp } from './sources.ts';

// opencode へ渡す Claude Code の指示と MCP の変換（share/opencode.ts）の試験。

const file = (p: string, extra: Partial<ShareFile> = {}): ShareFile => ({ path: p, scope: 'project', ...extra });
const run = (o: { files?: ShareFile[]; mcp?: ShareMcp[]; names?: string[]; user?: string[] }) =>
  opencodeShareConfig({ files: o.files ?? [], mcp: o.mcp ?? [], opencodeMcpNames: new Set(o.names ?? []), userInstructions: o.user ?? [] });

describe('opencodeShareConfig 指示', () => {
  it('skipped でないファイルの絶対パスを instructions に並べる', () => {
    const r = run({ files: [file('/a/CLAUDE.md'), file('/b/CLAUDE.md', { skipped: 'agentsMd' }), file('/c/CLAUDE.local.md', { scope: 'local' })] });
    expect(r.config.instructions).toEqual(['/a/CLAUDE.md', '/c/CLAUDE.local.md']);
    expect(r.report.files.map((f) => f.skipped)).toEqual([undefined, 'agentsMd', undefined]);
  });
  it('利用者の instructions を先に並べ、重複は除く', () => {
    const r = run({ files: [file('/a/CLAUDE.md'), file('/u/x.md')], user: ['/u/x.md', 'docs/*.md'] });
    expect(r.config.instructions).toEqual(['/u/x.md', 'docs/*.md', '/a/CLAUDE.md']);
  });
  it('渡すものが無ければ instructions を出さない（利用者の値を上書きしない）', () => {
    expect(run({ user: ['/u/x.md'] }).config).toEqual({});
    expect(run({ files: [file('/b', { skipped: 'agentsMd' })], user: ['/u/x.md'] }).config).toEqual({});
  });
});

describe('opencodeShareConfig MCP', () => {
  const stdio: ShareMcp = { name: 's', source: 'user', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } };
  const http: ShareMcp = { name: 'h', source: 'user', transport: 'http', url: 'https://h/mcp', headers: { A: 'b' } };
  const sse: ShareMcp = { name: 'e', source: 'local', transport: 'sse', url: 'https://e/sse' };
  it('stdio は local、http と sse は remote に変える', () => {
    const r = run({ mcp: [stdio, http, sse] });
    expect(r.config.mcp).toEqual({ servers: {
      s: { type: 'local', command: ['npx', '-y', 'x'], environment: { K: 'v' } },
      h: { type: 'remote', url: 'https://h/mcp', headers: { A: 'b' } },
      e: { type: 'remote', url: 'https://e/sse' },
    } });
  });
  it('args と env が無い stdio は command だけ', () => {
    expect(run({ mcp: [{ name: 'p', source: 'user', transport: 'stdio', command: 'x' }] }).config.mcp).toEqual({ servers: { p: { type: 'local', command: ['x'] } } });
  });
  it('opencode に同じ名前があれば渡さず、理由は conflict', () => {
    const r = run({ mcp: [stdio, http], names: ['s'] });
    expect(Object.keys(r.config.mcp!.servers)).toEqual(['h']);
    expect(r.report.mcp).toEqual([{ name: 's', source: 'user', transport: 'stdio', skipped: 'conflict' }, { name: 'h', source: 'user', transport: 'http' }]);
  });
  it('読み手が渡さないとしたものは、その理由のまま渡さない', () => {
    const r = run({ mcp: [{ name: 'd', source: 'user', transport: 'stdio', skipped: 'disabled' }] });
    expect(r.config).toEqual({});
    expect(r.report.mcp[0]!.skipped).toBe('disabled');
  });
});

describe('hangarServeConfig に重ねる', () => {
  const m = { url: 'http://h/mcp', secret: 's' };
  it('渡さない（null か空）なら、今までと同じ JSON', () => {
    const base = hangarServeConfig(m);
    expect(hangarServeConfig(m, null, {}, null)).toBe(base);
    expect(hangarServeConfig(m, null, {}, {})).toBe(base);
  });
  it('instructions と mcp を重ね、hangar の MCP と extra を消さない', () => {
    const j = JSON.parse(hangarServeConfig(m, null, { small_model: 'x/y' }, { instructions: ['/a'], mcp: { servers: { s: { type: 'local', command: ['c'] }, hangar: { evil: 1 } } } }));
    expect(j.instructions).toEqual(['/a']);
    expect(j.small_model).toBe('x/y');
    expect(Object.keys(j.mcp.servers).sort()).toEqual(['hangar', 's']);
    expect(j.mcp.servers.hangar).toEqual({ type: 'remote', url: 'http://h/mcp', headers: { Authorization: 'Bearer s' } });
  });
});

describe('userOpencodeConfig と opencodeShareFor', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'share-oc-'))); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const w = (p: string, text: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

  it('グローバルとプロジェクト（上の階も）の instructions と mcp の名前を読む（jsonc も）', () => {
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'ws', 'repo');
    w(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ instructions: ['/g.md'], mcp: { old: {}, servers: { new1: {} } } }));
    w(path.join(dir, 'ws', 'opencode.jsonc'), '{ // c\n "instructions": ["/w.md", "/g.md"], "mcp": { "servers": { "p": {} } } }');
    fs.mkdirSync(cwd, { recursive: true });
    const r = userOpencodeConfig({ home, cwd, env: {} });
    expect(r.instructions).toEqual(['/g.md', '/w.md']);
    expect([...r.mcpNames].sort()).toEqual(['new1', 'old', 'p']);
  });
  it('壊れた設定は空として扱い、投げない', () => {
    const home = path.join(dir, 'home');
    w(path.join(home, '.config', 'opencode', 'opencode.json'), '{ broken');
    expect(userOpencodeConfig({ home, cwd: dir, env: {} })).toEqual({ instructions: [], mcpNames: new Set() });
  });
  it('設定が切なら null、入なら実ファイルから組む', () => {
    const home = path.join(dir, 'home');
    const claudeDir = path.join(dir, 'claude');
    const cwd = path.join(dir, 'proj');
    w(path.join(claudeDir, 'CLAUDE.md'), 'hi');
    w(path.join(cwd, 'CLAUDE.md'), 'proj');
    w(path.join(dir, 'cj', '.claude.json'), JSON.stringify({ mcpServers: { s: { command: 'x' } } }));
    const base = { cwd, home, homeDir: home, claudeDir, claudeJsonPath: path.join(dir, 'cj', '.claude.json'), env: {} };
    expect(opencodeShareFor({ ...base, share: { instructions: false, mcp: false } })).toBeNull();
    const on = opencodeShareFor({ ...base, share: { instructions: true, mcp: false } });
    expect(on).toEqual({ instructions: [path.join(claudeDir, 'CLAUDE.md'), path.join(cwd, 'CLAUDE.md')] });
    const mcpOn = opencodeShareFor({ ...base, share: { instructions: false, mcp: true } });
    expect(mcpOn).toEqual({ mcp: { servers: { s: { type: 'local', command: ['x'] } } } });
  });
});
