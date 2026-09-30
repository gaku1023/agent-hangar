import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { STATUSLINE_MARKER } from './statusline.ts';
import type { Settings } from './paths.ts';
import { checkToolPath, createReadiness, expandHome, hangarCommandPrefix, readMcpRegistration, ToolVersions } from './readiness.ts';

// 実物の ~/.claude と ~/.claude.json には触らない。どれも一時ディレクトリに作る。
let tmp: string;
let db: Db;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ready-'));
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 版を 1 行だけ出す偽のコマンドを置く。 */
function fakeTool(name: string, line: string, mode = 0o755): string {
  const p = path.join(tmp, 'bin', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `#!/bin/sh\necho '${line}'\n`, { mode });
  fs.chmodSync(p, mode);
  return p;
}

const baseSettings = (over: Partial<Settings> = {}): Settings => ({
  workspaceRoot: path.join(tmp, 'ws'), claudeDir: path.join(tmp, 'claude'), tmuxPath: null, terminalApp: 'terminal', codePath: null,
  lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null,
  ...over,
});

describe('expandHome', () => {
  it('先頭の ~ だけをホームに直す', () => {
    expect(expandHome('~/workspace', '/Users/me')).toBe('/Users/me/workspace');
    expect(expandHome('~', '/Users/me')).toBe('/Users/me');
    expect(expandHome('/a/~/b', '/Users/me')).toBe('/a/~/b');
  });
});

describe('checkToolPath', () => {
  it('空は unset、無いは missing、ディレクトリは notFile、実行権が無ければ notExecutable', () => {
    expect(checkToolPath(null, tmp)).toEqual({ path: null, ok: false, problem: 'unset' });
    expect(checkToolPath(path.join(tmp, 'nope'), tmp)).toMatchObject({ ok: false, problem: 'missing' });
    expect(checkToolPath(tmp, tmp)).toMatchObject({ ok: false, problem: 'notFile' });
    const plain = fakeTool('plain', 'x', 0o644);
    expect(checkToolPath(plain, tmp)).toMatchObject({ ok: false, problem: 'notExecutable' });
    const ok = fakeTool('tmux', 'tmux 3.4');
    expect(checkToolPath(ok, tmp)).toEqual({ path: ok, ok: true, problem: null });
  });
  it('~ で始まるパスはホームから読む', () => {
    const ok = fakeTool('claude', '2.3.1 (Claude Code)');
    expect(checkToolPath('~/bin/claude', tmp)).toEqual({ path: ok, ok: true, problem: null });
  });
});

describe('ToolVersions', () => {
  it('出力の最初の版らしい語を拾う', async () => {
    const v = new ToolVersions(3000);
    expect(await v.get(fakeTool('tmux', 'tmux 3.4'), ['-V'])).toBe('3.4');
    expect(await v.get(fakeTool('claude', '2.3.1 (Claude Code)'), ['--version'])).toBe('2.3.1');
    expect(await v.get(fakeTool('node', 'v22.9.0'), ['--version'])).toBe('v22.9.0');
    expect(await v.get(fakeTool('tmux-next', 'tmux next-3.5a'), ['-V'])).toBe('3.5a');
  });
  it('時間内に終わらなければ null を返して待ち続けない', async () => {
    const p = path.join(tmp, 'slow');
    fs.writeFileSync(p, '#!/bin/sh\nsleep 5\necho 1.0\n', { mode: 0o755 });
    const t0 = Date.now();
    expect(await new ToolVersions(200).get(p, ['--version'])).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('同じファイルは起こし直さず、覚えた版を返す', async () => {
    const p = fakeTool('count', '1.0');
    const log = path.join(tmp, 'count.log');
    fs.writeFileSync(p, `#!/bin/sh\necho x >> '${log}'\necho 1.0\n`, { mode: 0o755 });
    const v = new ToolVersions(3000);
    expect(await v.get(p, ['--version'])).toBe('1.0');
    expect(await v.get(p, ['--version'])).toBe('1.0');
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('readMcpRegistration', () => {
  it('mcpServers に hangar があるときだけ真。無いファイルと壊れたファイルは偽で、書き換えない', () => {
    const file = path.join(tmp, '.claude.json');
    expect(readMcpRegistration(file)).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { type: 'stdio' } } }));
    expect(readMcpRegistration(file)).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { hangar: { type: 'http', url: 'http://127.0.0.1:4177/mcp' } } }));
    expect(readMcpRegistration(file)).toBe(true);
    fs.writeFileSync(file, '{ 壊れている');
    expect(readMcpRegistration(file)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ 壊れている');
  });
});

describe('hangarCommandPrefix', () => {
  it('外のターミナルのコマンドと同じ呼び方を、ほかのコマンドにも使う', () => {
    expect(hangarCommandPrefix('hangar shell install')).toBe('hangar');
    expect(hangarCommandPrefix('/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install')).toBe('/Applications/Hangar.app/Contents/Resources/server/bin/hangar');
    expect(hangarCommandPrefix('npm run hangar -- shell install')).toBe('npm run hangar --');
  });
});

describe('createReadiness', () => {
  it('ツール、ワークスペース、MCP、statusline、コマンドを 1 つにまとめて返す', async () => {
    const tmux = fakeTool('tmux', 'tmux 3.4');
    const claude = fakeTool('claude', '2.3.1 (Claude Code)');
    const node = fakeTool('node', 'v22.9.0');
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true });
    const claudeDir = path.join(tmp, 'claude');
    fs.mkdirSync(claudeDir);
    const script = path.join(tmp, 'statusline.sh');
    fs.writeFileSync(script, `#!/bin/sh\n${STATUSLINE_MARKER}\n`);
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { command: script } }));
    const claudeJson = path.join(tmp, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { hangar: { type: 'http' } } }));
    // ワークスペースの直下から登録したプロジェクトを 1 つ、外のプロジェクトを 1 つ、スクラッチを 1 つ置く。
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: path.join(ws, 'alpha'), resolved: 1 }, 'd');
    upsertShared(db, 'projects', { id: 'p2', name: 'far', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r2', project_id: 'p2', device_id: 'd', path: '/elsewhere/far', resolved: 1 }, 'd');
    upsertShared(db, 'projects', { id: 'p3', name: 'scratch', status: 'active', is_scratch: 1 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r3', project_id: 'p3', device_id: 'd', path: path.join(ws, 'scratch'), resolved: 1 }, 'd');
    const settings = baseSettings({ tmuxPath: tmux, claudePath: claude, codePath: null, nodePath: node, workspaceRoot: ws, claudeDir });
    const read = createReadiness({ settings: () => settings, claudeDir, claudeJson, homeDir: tmp, db, deviceId: 'd', shellCommand: () => 'hangar shell install', timeoutMs: 3000 });
    const r = await read();
    expect(r.tools.tmux).toEqual({ path: tmux, ok: true, problem: null, version: '3.4' });
    expect(r.tools.claude).toEqual({ path: claude, ok: true, problem: null, version: '2.3.1' });
    expect(r.tools.code).toEqual({ path: null, ok: false, problem: 'unset', version: null });
    expect(r.tools.node).toEqual({ path: node, ok: true, problem: null, version: 'v22.9.0', auto: false });
    expect(r.workspace).toEqual({ path: ws, exists: true, projectCount: 1 });
    expect(r.mcp).toEqual({ registered: true, file: claudeJson });
    expect(r.statusline).toEqual({ command: script, scriptPath: script, installed: true });
    expect(r.commands).toEqual({ mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' });
  });
  it('Node の設定が空なら、サーバを動かしている Node を見せる', async () => {
    const read = createReadiness({ settings: () => baseSettings(), claudeDir: path.join(tmp, 'claude'), claudeJson: path.join(tmp, '.claude.json'), homeDir: tmp, db, deviceId: 'd', shellCommand: () => 'hangar shell install', serverNode: { path: '/opt/node/bin/node', version: 'v22.1.0' } });
    const r = await read();
    expect(r.tools.node).toEqual({ path: '/opt/node/bin/node', ok: true, problem: null, version: 'v22.1.0', auto: true });
    expect(r.workspace).toEqual({ path: path.join(tmp, 'ws'), exists: false, projectCount: 0 });
    expect(r.mcp.registered).toBe(false);
    expect(r.statusline).toEqual({ command: null, scriptPath: null, installed: false });
  });
});
