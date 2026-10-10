import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSetupReport, runSetup, whichCmd } from './setup.ts';

describe('runSetup', () => {
  it('ホームを作り、ツールとワークスペースを報告する', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const r = runSetup({ home, workspaceRoot: ws, claudeDir: path.join(home, 'claude-empty'), which: (c) => (c === 'tmux' ? '/opt/homebrew/bin/tmux' : null) });
    expect(fs.existsSync(path.join(home, 'token'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'device.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).workspaceRoot).toBe(ws);
    expect(r.tools).toEqual([
      { name: 'tmux', found: true, path: '/opt/homebrew/bin/tmux' },
      { name: 'claude', found: false, path: null },
      { name: 'code', found: false, path: null },
    ]);
    expect(r.workspaceExists).toBe(true);
    const text = formatSetupReport(r);
    expect(text).toContain('tmux: /opt/homebrew/bin/tmux');
    expect(text).toContain('claude: 見つかりません');
    expect(r.statusline).toEqual({ command: null, scriptPath: null, installed: false });
    expect(text).toContain('statusline: スクリプトが見つかりません');
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true });
  });
});

describe('runSetup（Windows）', () => {
  it('tmux の役は psmux を先に探す', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-'));
    const asked: string[] = [];
    const r = runSetup({ home, claudeDir: path.join(home, 'claude-empty'), platform: 'win32', which: (c) => { asked.push(c); return c === 'psmux' ? 'C:\\tools\\psmux.exe' : null; } });
    expect(r.tools[0]).toEqual({ name: 'tmux', found: true, path: 'C:\\tools\\psmux.exe' });
    expect(asked[0]).toBe('psmux');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('Windows では、ワークスペースの ~\\ もホームに直す', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-'));
    const r = runSetup({ home, workspaceRoot: '~\\ws-hangar-test', claudeDir: path.join(home, 'claude-empty'), platform: 'win32', which: () => null });
    expect(r.workspaceRoot).toBe(path.resolve(path.join(os.homedir(), 'ws-hangar-test')));
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('whichCmd', () => {
  it('which を起こさず、PATH から探す。Windows では PATHEXT の拡張子を補う', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-which-'));
    fs.writeFileSync(path.join(dir, 'psmux.exe'), '');
    const env = { PATH: `C:\\nowhere;${dir}`, PATHEXT: '.COM;.EXE' };
    expect(whichCmd('psmux', env, 'win32')).toBe(path.join(dir, 'psmux.exe'));
    expect(whichCmd('missing', env, 'win32')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
