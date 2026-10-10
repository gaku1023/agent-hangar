import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHELL_MARKER, shellScriptPath } from '@agent-hangar/server';
import { runShellInstall, runShellUninstall, shellStatusLine } from './shell.ts';
import { posixDescribe } from '../../server/test/platform.ts';

let dir: string;
let home: string;
let zshrc: string;
let ok: string;
let off: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-shell-'));
  home = path.join(dir, '.agent-hangar');
  zshrc = path.join(dir, '.zshrc');
  fs.writeFileSync(zshrc, 'export A=1\n');
  // 実行できる tmux と、実行できないファイル。包み方は hangar の tmux の中で claude を起こすので、tmux が要る。
  ok = path.join(dir, 'tmux-ok');
  fs.writeFileSync(ok, '#!/bin/sh\n', { mode: 0o755 });
  off = path.join(dir, 'tmux-off');
  fs.writeFileSync(off, '', { mode: 0o644 });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const base = () => ({ home, zshrc, loginShell: '/bin/zsh', log: (s: string) => logs.push(s) });
let logs: string[] = [];
beforeEach(() => { logs = []; });

// zsh の包み。Windows の包みは次の区切りで作る。
posixDescribe('hangar shell install', () => {
  it('行を見せて承諾を得てから足し、本体を置き、控えを取る', async () => {
    const asked: string[] = [];
    const r = await runShellInstall({ ...base(), tmuxPath: ok, ask: async (q) => { asked.push(q); return true; } });
    expect(r.installed).toBe(true);
    expect(asked).toHaveLength(1);
    const rc = fs.readFileSync(zshrc, 'utf8');
    expect(rc.startsWith('export A=1\n')).toBe(true);
    expect(rc).toContain(SHELL_MARKER);
    expect(fs.existsSync(shellScriptPath(home))).toBe(true);
    // 本体には hangar の接続先、トークンのファイル、tmux のパスを埋め込む。トークンそのものは書かない。
    const body = fs.readFileSync(shellScriptPath(home), 'utf8');
    expect(body).toContain("__agent_hangar_url='http://127.0.0.1:4177'");
    expect(body).toContain(`__agent_hangar_token_file='${path.join(home, 'token')}'`);
    expect(body).toContain(`__agent_hangar_tmux='${ok}'`);
    expect(logs.some((l) => l.startsWith('控え: '))).toBe(true);
    // 二度目は聞かずに済ませる。
    const again = await runShellInstall({ ...base(), tmuxPath: ok, ask: async () => { throw new Error('聞かない'); } });
    expect(again.installed).toBe(true);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe(rc);
  });
  it('断られたら書き換えない', async () => {
    const r = await runShellInstall({ ...base(), tmuxPath: ok, ask: async () => false });
    expect(r.installed).toBe(false);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe('export A=1\n');
  });
  it('tmux が無い PC と、zsh でないログインシェルでは入れない', async () => {
    expect((await runShellInstall({ ...base(), tmuxPath: off, yes: true })).installed).toBe(false);
    expect((await runShellInstall({ ...base(), tmuxPath: null, yes: true })).installed).toBe(false);
    expect((await runShellInstall({ ...base(), loginShell: '/bin/bash', tmuxPath: ok, yes: true })).installed).toBe(false);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe('export A=1\n');
  });
});

// zsh の包み。Windows の包みは次の区切りで作る。
posixDescribe('hangar shell uninstall と status', () => {
  it('足した行だけを外し、状態を 1 行で出す', async () => {
    expect(shellStatusLine({ zshrc, tmuxPath: ok })).toMatch(/まだです/);
    expect(shellStatusLine({ zshrc, tmuxPath: off })).toMatch(/使えません/);
    await runShellInstall({ ...base(), tmuxPath: ok, yes: true });
    expect(shellStatusLine({ zshrc, tmuxPath: ok })).toMatch(/入っています/);
    expect(runShellUninstall({ zshrc, log: () => {} }).removed).toBe(true);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe('export A=1\n');
    expect(runShellUninstall({ zshrc, log: () => {} }).removed).toBe(false);
  });
});

// Windows では包みを作らない（2026-10-10 の決定）。どの OS の上でも、Windows として確かめる。
describe('hangar shell（Windows）', () => {
  it('install は何も書かずに、Windows では使えないと言う', async () => {
    const r = await runShellInstall({ ...base(), loginShell: '', tmuxPath: ok, platform: 'win32', yes: true });
    expect(r.installed).toBe(false);
    expect(logs.join('\n')).toMatch(/Windows/);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe('export A=1\n');
    expect(fs.existsSync(shellScriptPath(home))).toBe(false);
  });

  it('status は Windows では使えないと言う', () => {
    expect(shellStatusLine({ zshrc, tmuxPath: ok, platform: 'win32' })).toMatch(/Windows では使えません/);
  });
});
