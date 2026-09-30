import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHELL_MARKER, shellScriptPath } from '@agent-hangar/server';
import { runShellInstall, runShellUninstall, shellStatusLine } from './shell.ts';

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
  // バックグラウンドを使える claude と、管理設定で切られた claude の偽物。
  ok = path.join(dir, 'claude-ok');
  fs.writeFileSync(ok, '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  off = path.join(dir, 'claude-off');
  fs.writeFileSync(off, '#!/bin/sh\necho "disabled" >&2; exit 1\n', { mode: 0o755 });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const base = () => ({ home, zshrc, loginShell: '/bin/zsh', log: (s: string) => logs.push(s) });
let logs: string[] = [];
beforeEach(() => { logs = []; });

describe('hangar shell install', () => {
  it('行を見せて承諾を得てから足し、本体を置き、控えを取る', async () => {
    const asked: string[] = [];
    const r = await runShellInstall({ ...base(), claudeBin: ok, ask: async (q) => { asked.push(q); return true; } });
    expect(r.installed).toBe(true);
    expect(asked).toHaveLength(1);
    const rc = fs.readFileSync(zshrc, 'utf8');
    expect(rc.startsWith('export A=1\n')).toBe(true);
    expect(rc).toContain(SHELL_MARKER);
    expect(fs.existsSync(shellScriptPath(home))).toBe(true);
    expect(logs.some((l) => l.startsWith('控え: '))).toBe(true);
    // 二度目は聞かずに済ませる。
    const again = await runShellInstall({ ...base(), claudeBin: ok, ask: async () => { throw new Error('聞かない'); } });
    expect(again.installed).toBe(true);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe(rc);
  });
  it('断られたら書き換えない', async () => {
    const r = await runShellInstall({ ...base(), claudeBin: ok, ask: async () => false });
    expect(r.installed).toBe(false);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe('export A=1\n');
  });
  it('バックグラウンドを使えない Claude Code と、zsh でないログインシェルでは入れない', async () => {
    expect((await runShellInstall({ ...base(), claudeBin: off, yes: true })).installed).toBe(false);
    expect((await runShellInstall({ ...base(), claudeBin: null, yes: true })).installed).toBe(false);
    expect((await runShellInstall({ ...base(), loginShell: '/bin/bash', claudeBin: ok, yes: true })).installed).toBe(false);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe('export A=1\n');
  });
});

describe('hangar shell uninstall と status', () => {
  it('足した行だけを外し、状態を 1 行で出す', async () => {
    expect(shellStatusLine({ zshrc, claudeBin: ok })).toMatch(/まだです/);
    expect(shellStatusLine({ zshrc, claudeBin: off })).toMatch(/使えません/);
    await runShellInstall({ ...base(), claudeBin: ok, yes: true });
    expect(shellStatusLine({ zshrc, claudeBin: ok })).toMatch(/入っています/);
    expect(runShellUninstall({ zshrc, log: () => {} }).removed).toBe(true);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe('export A=1\n');
    expect(runShellUninstall({ zshrc, log: () => {} }).removed).toBe(false);
  });
});
