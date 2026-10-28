import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeMcpServers, instructionSources, readShareSources } from './sources.ts';

// Codex・opencode に渡す Claude Code の指示と MCP の読み手（share/sources.ts）の試験。
// 純粋な部分は exists の差し替えと JSON の値で、薄い読みの包みは実ファイルで確かめる。

// Windows でも通るよう、区切りは / にそろえて比べる。
const slash = (p: string) => p.replaceAll('\\', '/');
const fake = (...files: string[]) => (p: string) => files.includes(slash(p));
const paths = (r: { path: string; skipped?: string }[]) => r.map((f) => (f.skipped ? `${slash(f.path)}!${f.skipped}` : slash(f.path)));

describe('instructionSources', () => {
  const base = { cwd: '/home/u/ws/repo', claudeDir: '/home/u/.claude', homeDir: '/home/u' };
  it('利用者、祖先（外側から）、作業フォルダ、CLAUDE.local.md の順に、あるものだけを返す', () => {
    const exists = fake('/home/u/.claude/CLAUDE.md', '/home/u/ws/CLAUDE.md', '/home/u/ws/repo/CLAUDE.md', '/home/u/ws/repo/.claude/CLAUDE.md', '/home/u/ws/repo/CLAUDE.local.md');
    const r = instructionSources({ ...base, exists });
    expect(paths(r)).toEqual(['/home/u/.claude/CLAUDE.md', '/home/u/ws/CLAUDE.md', '/home/u/ws/repo/CLAUDE.md', '/home/u/ws/repo/.claude/CLAUDE.md', '/home/u/ws/repo/CLAUDE.local.md']);
    expect(r.map((f) => f.scope)).toEqual(['user', 'project', 'project', 'project', 'local']);
  });
  it('何も無ければ空', () => {
    expect(instructionSources({ ...base, exists: fake() })).toEqual([]);
  });
  it('同じフォルダに AGENTS.md があれば、そのフォルダの CLAUDE.md と .claude/CLAUDE.md は skipped: agentsMd', () => {
    const exists = fake('/home/u/ws/repo/CLAUDE.md', '/home/u/ws/repo/.claude/CLAUDE.md', '/home/u/ws/repo/AGENTS.md', '/home/u/ws/CLAUDE.md', '/home/u/ws/repo/CLAUDE.local.md');
    expect(paths(instructionSources({ ...base, exists }))).toEqual(['/home/u/ws/CLAUDE.md', '/home/u/ws/repo/CLAUDE.md!agentsMd', '/home/u/ws/repo/.claude/CLAUDE.md!agentsMd', '/home/u/ws/repo/CLAUDE.local.md']);
  });
  it('ホームより上へは行かない', () => {
    const exists = fake('/home/CLAUDE.md', '/CLAUDE.md', '/home/u/CLAUDE.md');
    expect(paths(instructionSources({ ...base, exists }))).toEqual(['/home/u/CLAUDE.md']);
  });
  it('ホームの外の作業フォルダは根まで上がる', () => {
    const exists = fake('/srv/CLAUDE.md', '/srv/app/CLAUDE.md', '/CLAUDE.md');
    expect(paths(instructionSources({ ...base, cwd: '/srv/app', exists }))).toEqual(['/CLAUDE.md', '/srv/CLAUDE.md', '/srv/app/CLAUDE.md']);
  });
  it('ホームの .claude/CLAUDE.md が利用者のファイルと同じなら、重ねない', () => {
    const exists = fake('/home/u/.claude/CLAUDE.md');
    expect(paths(instructionSources({ ...base, cwd: '/home/u', exists }))).toEqual(['/home/u/.claude/CLAUDE.md']);
  });
});

describe('claudeMcpServers', () => {
  const cwd = '/work/app';
  const run = (o: { claudeJson?: unknown; mcpJson?: unknown | null; env?: Record<string, string | undefined> }) => claudeMcpServers({ cwd, claudeJson: o.claudeJson ?? {}, mcpJson: o.mcpJson ?? null, env: o.env ?? {} });
  const byName = (r: ReturnType<typeof run>, n: string) => r.find((s) => s.name === n);

  it('利用者の stdio と http を中立の形にする', () => {
    const r = run({ claudeJson: { mcpServers: { a: { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } }, b: { type: 'http', url: 'https://e.test/mcp', headers: { Authorization: 'Bearer t' } }, c: { command: 'node' }, d: { type: 'sse', url: 'https://e.test/sse' } } } });
    expect(byName(r, 'a')).toEqual({ name: 'a', source: 'user', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } });
    expect(byName(r, 'b')).toEqual({ name: 'b', source: 'user', transport: 'http', url: 'https://e.test/mcp', headers: { Authorization: 'Bearer t' } });
    expect(byName(r, 'c')).toEqual({ name: 'c', source: 'user', transport: 'stdio', command: 'node' });
    expect(byName(r, 'd')).toMatchObject({ transport: 'sse', url: 'https://e.test/sse' });
  });
  it('そのフォルダの登録（projects[cwd]）を local として読む。鍵の末尾の / と NFD は同じフォルダ', () => {
    const nfd = '/work/ほげ'.normalize('NFD');
    const r = claudeMcpServers({ cwd: '/work/ほげ'.normalize('NFC'), claudeJson: { projects: { [`${nfd}/`]: { mcpServers: { l: { command: 'x' } } }, '/other': { mcpServers: { z: { command: 'z' } } } } }, mcpJson: null, env: {} });
    expect(r.map((s) => [s.name, s.source])).toEqual([['l', 'local']]);
  });
  it('同じ名前は local、project、user の順に強く、弱い方は返さない', () => {
    const r = run({
      claudeJson: { mcpServers: { n: { command: 'user' }, m: { command: 'user' } }, projects: { [cwd]: { mcpServers: { n: { command: 'local' } }, enableAllProjectMcpServers: true } } },
      mcpJson: { mcpServers: { n: { command: 'proj' }, m: { command: 'proj' } } },
    });
    expect(byName(r, 'n')).toMatchObject({ source: 'local', command: 'local' });
    expect(byName(r, 'm')).toMatchObject({ source: 'project', command: 'proj' });
    expect(r.filter((s) => s.name === 'n')).toHaveLength(1);
  });
  it('.mcp.json は承認済みだけ。enableAllProjectMcpServers か enabledMcpjsonServers にあるもの', () => {
    const mcpJson = { mcpServers: { ok: { command: 'a' }, no: { command: 'b' }, off: { command: 'c' } } };
    const none = run({ mcpJson });
    expect(none.map((s) => [s.name, s.skipped])).toEqual([['ok', 'unapproved'], ['no', 'unapproved'], ['off', 'unapproved']]);
    const some = run({ mcpJson, claudeJson: { projects: { [cwd]: { enabledMcpjsonServers: ['ok', 'off'], disabledMcpjsonServers: ['off'] } } } });
    expect(some.map((s) => [s.name, s.skipped])).toEqual([['ok', undefined], ['no', 'unapproved'], ['off', 'disabled']]);
    const all = run({ mcpJson, claudeJson: { projects: { [cwd]: { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['off'] } } } });
    expect(all.map((s) => [s.name, s.skipped])).toEqual([['ok', undefined], ['no', undefined], ['off', 'disabled']]);
  });
  it('承認は settings の鍵も見る。どれかで有効なら承認、無効の指定が勝つ', () => {
    const mcpJson = { mcpServers: { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' }, d: { command: 'd' } } };
    const r = claudeMcpServers({ cwd, claudeJson: {}, mcpJson, env: {}, settings: [{ enabledMcpjsonServers: ['a', 'c'] }, { enabledMcpjsonServers: ['b'], disabledMcpjsonServers: ['c'] }] });
    expect(r.map((s) => [s.name, s.skipped])).toEqual([['a', undefined], ['b', undefined], ['c', 'disabled'], ['d', 'unapproved']]);
    const all = claudeMcpServers({ cwd, claudeJson: {}, mcpJson, env: {}, settings: [{ enableAllProjectMcpServers: true }, { disabledMcpjsonServers: ['d'] }] });
    expect(all.map((s) => [s.name, s.skipped])).toEqual([['a', undefined], ['b', undefined], ['c', undefined], ['d', 'disabled']]);
    // .claude.json の側と settings の側は合わせて判定する。
    const mixed = claudeMcpServers({ cwd, claudeJson: { projects: { [cwd]: { enabledMcpjsonServers: ['a'] } } }, mcpJson, env: {}, settings: [{ enabledMcpjsonServers: ['b'] }, 'x', null] });
    expect(mixed.map((s) => [s.name, s.skipped])).toEqual([['a', undefined], ['b', undefined], ['c', 'unapproved'], ['d', 'unapproved']]);
  });
  it('Claude で切った（disabledMcpServers）ものは skipped: disabled', () => {
    const r = run({ claudeJson: { mcpServers: { a: { command: 'x' }, b: { command: 'y' } }, projects: { [cwd]: { disabledMcpServers: ['a'] } } } });
    expect(r.map((s) => [s.name, s.skipped])).toEqual([['a', 'disabled'], ['b', undefined]]);
  });
  it('hangar の名前は skipped: reserved', () => {
    expect(byName(run({ claudeJson: { mcpServers: { hangar: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } } }), 'hangar')?.skipped).toBe('reserved');
  });
  it('形の壊れたものは skipped: invalid（command も url も無い、型が未知、中身がオブジェクトでない）', () => {
    const r = run({ claudeJson: { mcpServers: { a: {}, b: { type: 'ws', url: 'x' }, c: 'str', d: { type: 'http' }, e: { command: 1 }, f: { url: 'https://e.test' } } } });
    expect(r.map((s) => [s.name, s.skipped])).toEqual([['a', 'invalid'], ['b', 'invalid'], ['c', 'invalid'], ['d', 'invalid'], ['e', 'invalid'], ['f', 'invalid']]);
  });
  it('${VAR} と ${VAR:-既定} を env で展開する。未定義で既定が無ければ skipped: missingEnv', () => {
    const r = run({
      claudeJson: { mcpServers: {
        a: { command: '${BIN}', args: ['--k', '${KEY:-dflt}', 'p-${HOME2}'], env: { T: '${TOKEN}' } },
        b: { type: 'http', url: '${BASE}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
        c: { command: 'x', args: ['${NOPE}'] },
        d: { type: 'http', url: 'https://e.test', headers: { X: '${NOPE2}' } },
      } },
      env: { BIN: 'npx', TOKEN: 's3', HOME2: 'h', BASE: 'https://e.test' },
    });
    expect(byName(r, 'a')).toEqual({ name: 'a', source: 'user', transport: 'stdio', command: 'npx', args: ['--k', 'dflt', 'p-h'], env: { T: 's3' } });
    expect(byName(r, 'b')).toMatchObject({ url: 'https://e.test/mcp', headers: { Authorization: 'Bearer s3' } });
    expect(byName(r, 'c')?.skipped).toBe('missingEnv');
    expect(byName(r, 'd')?.skipped).toBe('missingEnv');
  });
  it('空の env 値の ${VAR:-既定} は、定義済みならその値を使う', () => {
    const r = run({ claudeJson: { mcpServers: { a: { command: 'x', args: ['${V:-d}'] } } }, env: { V: '' } });
    expect(byName(r, 'a')?.args).toEqual(['']);
  });
  it('壊れた入力（null、配列、文字列）でも投げない', () => {
    for (const claudeJson of [null, [], 'x', 1, { mcpServers: [] }, { projects: 'x' }, { projects: { [cwd]: 'x' } }]) expect(run({ claudeJson })).toEqual([]);
    expect(run({ mcpJson: 'x' })).toEqual([]);
  });
});

describe('readShareSources', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-share-'))); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

  it('指示の本文と、.claude.json と .mcp.json を読んで渡す', () => {
    const home = path.join(root, 'home');
    const claudeDir = path.join(home, '.claude');
    const cwd = path.join(home, 'ws', 'repo');
    put(path.join(claudeDir, 'CLAUDE.md'), 'user body');
    put(path.join(cwd, 'CLAUDE.md'), 'repo body');
    put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { u: { command: 'x' } }, projects: { [cwd]: { enableAllProjectMcpServers: true } } }));
    put(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { p: { command: 'y' } } }));
    const r = readShareSources({ cwd, claudeDir, homeDir: home, claudeJsonPath: path.join(home, '.claude.json'), env: {} });
    expect(r.instructions.map((f) => [f.scope, f.text])).toEqual([['user', 'user body'], ['project', 'repo body']]);
    expect(r.mcp.map((s) => [s.name, s.source])).toEqual([['p', 'project'], ['u', 'user']]);
  });
  it('.mcp.json の承認を、設定フォルダ、作業フォルダの .claude/settings.json と settings.local.json から読む', () => {
    const home = path.join(root, 'home');
    const claudeDir = path.join(home, '.claude');
    const cwd = path.join(home, 'ws', 'repo');
    put(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' }, d: { command: 'd' } } }));
    put(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['a'] }));
    put(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['b', 'd'] }));
    put(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['c'], disabledMcpjsonServers: ['d'] }));
    const r = readShareSources({ cwd, claudeDir, homeDir: home, claudeJsonPath: path.join(home, '.claude.json'), env: {} });
    expect(r.mcp.map((s) => [s.name, s.skipped])).toEqual([['a', undefined], ['b', undefined], ['c', undefined], ['d', 'disabled']]);
  });
  it('ファイルが無い、壊れているときは空で返し、投げない', () => {
    const cwd = path.join(root, 'w');
    fs.mkdirSync(cwd);
    put(path.join(root, '.claude.json'), '{ broken');
    put(path.join(cwd, '.mcp.json'), 'nope');
    expect(readShareSources({ cwd, claudeDir: path.join(root, '.claude'), homeDir: root, claudeJsonPath: path.join(root, '.claude.json'), env: {} })).toEqual({ instructions: [], mcp: [] });
  });
});
