import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeSupportsBackground, ensureShellScript, installShellHook, SHELL_MARKER, shellHookInstalled, shellHookLine, shellHookState, shellInstallCommand, shellScriptPath, uninstallShellHook, zshrcPath } from './shellHook.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-shell-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('~/.zshrc の 1 行', () => {
  it('ホームの下なら $HOME からの相対で、本体が無ければ何もしない形にする', () => {
    expect(shellHookLine('/Users/me/.agent-hangar', '/Users/me')).toBe(`[ -f "$HOME/.agent-hangar/shell/claude.zsh" ] && source "$HOME/.agent-hangar/shell/claude.zsh"  ${SHELL_MARKER}`);
    expect(shellHookLine('/opt/hangar', '/Users/me')).toBe(`[ -f "/opt/hangar/shell/claude.zsh" ] && source "/opt/hangar/shell/claude.zsh"  ${SHELL_MARKER}`);
  });
  it('ZDOTDIR を立てていればそちらの .zshrc を使う', () => {
    expect(zshrcPath({}, '/Users/me')).toBe('/Users/me/.zshrc');
    expect(zshrcPath({ ZDOTDIR: '/Users/me/.config/zsh' }, '/Users/me')).toBe('/Users/me/.config/zsh/.zshrc');
  });
  it('足すときは控えを取り、二度足さず、外すときは目印の行だけを消す', () => {
    const rc = path.join(dir, '.zshrc');
    fs.writeFileSync(rc, 'export A=1\nalias ll="ls -l"\n');
    const line = shellHookLine(path.join(dir, '.agent-hangar'), dir);
    const a = installShellHook(rc, line, new Date(2026, 8, 30, 12, 0, 0));
    expect(a.changed).toBe(true);
    expect(fs.readFileSync(a.backup!, 'utf8')).toBe('export A=1\nalias ll="ls -l"\n');
    expect(fs.readFileSync(rc, 'utf8')).toBe(`export A=1\nalias ll="ls -l"\n${line}\n`);
    expect(shellHookInstalled(rc)).toBe(true);
    expect(installShellHook(rc, line).changed).toBe(false);
    // 置き場が変わったら、古い行を今の行に置き換える。
    const moved = shellHookLine('/opt/hangar', dir);
    installShellHook(rc, moved, new Date(2026, 8, 30, 12, 0, 1));
    expect(fs.readFileSync(rc, 'utf8')).toBe(`export A=1\nalias ll="ls -l"\n${moved}\n`);
    const u = uninstallShellHook(rc, new Date(2026, 8, 30, 12, 0, 2));
    expect(u.changed).toBe(true);
    expect(fs.readFileSync(rc, 'utf8')).toBe('export A=1\nalias ll="ls -l"\n');
    expect(shellHookInstalled(rc)).toBe(false);
    expect(uninstallShellHook(rc).changed).toBe(false);
  });
  it('~/.zshrc が無ければ作り、控えは取らない', () => {
    const rc = path.join(dir, '.zshrc');
    const r = installShellHook(rc, 'x  # agent-hangar');
    expect(r).toEqual({ changed: true, backup: null });
    expect(fs.readFileSync(rc, 'utf8')).toBe('x  # agent-hangar\n');
  });
});

describe('この PC の状態', () => {
  it('バックグラウンドを使えなければ unsupported、使えれば行の有無で on と off', () => {
    const rc = path.join(dir, '.zshrc');
    expect(shellHookState(rc, false)).toBe('unsupported');
    expect(shellHookState(rc, true)).toBe('off');
    fs.writeFileSync(rc, `x  ${SHELL_MARKER}\n`);
    expect(shellHookState(rc, true)).toBe('on');
  });
  it('claude agents --json が通るかでバックグラウンドを使えるかを見る', () => {
    const ok = path.join(dir, 'ok'); fs.writeFileSync(ok, '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
    const off = path.join(dir, 'off'); fs.writeFileSync(off, '#!/bin/sh\necho disabled >&2; exit 1\n', { mode: 0o755 });
    expect(claudeSupportsBackground(ok)).toBe(true);
    expect(claudeSupportsBackground(off)).toBe(false);
    expect(claudeSupportsBackground(null)).toBe(false);
  });
  it('入れるコマンドは、PATH の hangar、同梱の hangar の絶対パス、リポジトリの順に選ぶ', () => {
    expect(shellInstallCommand({ hangarOnPath: '/usr/local/bin/hangar', bundledHangar: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar' })).toBe('hangar shell install');
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar' })).toBe('/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install');
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: '/Applications/My Apps/Hangar.app/bin/hangar' })).toBe('"/Applications/My Apps/Hangar.app/bin/hangar" shell install');
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: null })).toBe('npm run hangar -- shell install');
    // npm run dev のサーバは PATH に node_modules/.bin を持つが、利用者のターミナルからは引けない。
    expect(shellInstallCommand({ hangarOnPath: '/w/agent-hangar/node_modules/.bin/hangar', bundledHangar: null })).toBe('npm run hangar -- shell install');
  });
});

const ZSH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : null;

/**
 * 包み方の本体を、本物の zsh で疑似端末の上に動かす。
 * 偽の claude は受け取った引数を 1 行ずつ記録し、--bg と agents には決まった出力を返す。
 */
function runWrapped(args: string, o: { bgFails?: boolean; agents?: string; tty?: boolean } = {}): string[] {
  const home = path.join(dir, 'home');
  ensureShellScript(home);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(dir, 'agents.json'), o.agents ?? '[]\n');
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    `echo "[$*]" >> "${log}"`,
    'case "$1" in',
    `  --bg) ${o.bgFails ? 'echo "Workspace not trusted." >&2; exit 1' : 'echo "Starting background service…" >&2; echo "backgrounded · abcd1234 (idle — send a prompt to start)"; echo "  claude agents             list sessions"'} ;;`,
    `  agents) cat "${path.join(dir, 'agents.json')}" ;;`,
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const inner = `source ${JSON.stringify(shellScriptPath(home))}; claude ${args}`;
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HANGAR_NO_WRAP: '' };
  // script(1) が疑似端末を用意するので、包み方は端末の上で動いていると見る。
  const r = o.tty === false
    ? spawnSync(ZSH!, ['-f', '-c', inner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnSync('/usr/bin/script', ['-q', '/dev/null', ZSH!, '-f', '-c', inner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.slice(1, -1));
}

const UUID = '480a20da-0b1b-4e20-b8f5-2b5c82124ecb';
const agentsWith = (kind: string) => `[\n  {\n    "id": "480a20da",\n    "cwd": "/x",\n    "kind": "${kind}",\n    "sessionId": "${UUID}",\n    "state": "blocked"\n  }\n]\n`;

describe.skipIf(!ZSH)('包み方の本体（zsh 上）', () => {
  it('対話の起動は --bg で起こし、出てきた id に attach する。引数はそのまま渡す', () => {
    expect(runWrapped('')).toEqual(['--bg', 'attach abcd1234']);
    expect(runWrapped('--model opus "直して"')).toEqual(['--bg --model opus 直して', 'attach abcd1234']);
  });
  it('サブコマンド、-p、-c、--help などは包まない', () => {
    expect(runWrapped('mcp list')).toEqual(['mcp list']);
    expect(runWrapped('-p hello')).toEqual(['-p hello']);
    expect(runWrapped('--model opus -p hello')).toEqual(['--model opus -p hello']);
    expect(runWrapped('-c')).toEqual(['-c']);
    expect(runWrapped('--version')).toEqual(['--version']);
  });
  it('端末でなければ包まない', () => {
    expect(runWrapped('', { tty: false })).toEqual(['']);
  });
  it('--bg が失敗したら素の claude を起こす', () => {
    expect(runWrapped('', { bgFails: true })).toEqual(['--bg', '']);
  });
  it('-r は id があるときだけ包み、バックグラウンドで動いていれば attach だけにする', () => {
    expect(runWrapped('-r')).toEqual(['-r']);
    expect(runWrapped('-r 検索の語')).toEqual(['-r 検索の語']);
    expect(runWrapped(`-r ${UUID}`)).toEqual(['agents --json', `--bg -r ${UUID}`, 'attach abcd1234']);
    expect(runWrapped(`--resume ${UUID}`, { agents: agentsWith('background') })).toEqual(['agents --json', 'attach 480a20da']);
    // 別のターミナルで動く対話の claude は素の claude に任せる。二重に開かないよう Claude が断る。
    expect(runWrapped(`-r ${UUID}`, { agents: agentsWith('interactive') })).toEqual(['agents --json', `-r ${UUID}`]);
  });
});
