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
      { name: 'git', found: false, path: null },
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

// 作成場所は任意（2026-10-13）。新しい利用者は空から始まり、報告でも任意と言う。
describe('runSetup の作成場所', () => {
  it('--workspace を渡さない新しい利用者は空のままにし、任意であることと決め方を言う', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-'));
    const r = runSetup({ home, claudeDir: path.join(home, 'claude-empty'), which: () => null });
    expect(r.workspaceRoot).toBe('');
    expect(r.workspaceExists).toBe(false);
    expect(formatSetupReport(r)).toContain('新しいフォルダの作成場所: 未設定（任意。hangar setup --workspace <dir> で決められます）');
    fs.rmSync(home, { recursive: true, force: true });
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

  // psmux 3.4.0 未満はホイールが ↑ に化ける（issue #245）。報告に注意と上げ方を添える。
  it('psmux が 3.4.0 未満なら、止まることと外の PowerShell で打つことを添えて上げ方を言う', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-'));
    const read: string[] = [];
    const r = runSetup({ home, claudeDir: path.join(home, 'claude-empty'), platform: 'win32', which: (c) => (c === 'psmux' ? 'C:\\tools\\psmux.exe' : null), readMuxVersion: (p) => { read.push(p); return '3.3.8'; } });
    expect(read).toEqual(['C:\\tools\\psmux.exe']);
    expect(r.tools[0]).toEqual({ name: 'tmux', found: true, path: 'C:\\tools\\psmux.exe', outdated: { version: '3.3.8', min: '3.4.0' } });
    const text = formatSetupReport(r);
    expect(text).toContain('注意: psmux 3.3.8 は古い版です');
    expect(text).toContain('実行中のセッションは止まります');
    expect(text).toContain('外の PowerShell');
    expect(text).toContain('Get-Process psmux -ErrorAction SilentlyContinue | Stop-Process -Force; winget upgrade marlocarlo.psmux; tmux -V');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('3.4.0 以上か版が読めなければ何も添えず、macOS では版を読まない', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-'));
    const which = (c: string) => (c === 'psmux' || c === 'tmux' ? 'C:\\tools\\psmux.exe' : null);
    for (const v of ['3.4.0', null]) {
      const r = runSetup({ home, claudeDir: path.join(home, 'claude-empty'), platform: 'win32', which, readMuxVersion: () => v });
      expect(r.tools[0]).toEqual({ name: 'tmux', found: true, path: 'C:\\tools\\psmux.exe' });
      expect(formatSetupReport(r)).not.toContain('注意: psmux');
    }
    let asked = false;
    runSetup({ home, claudeDir: path.join(home, 'claude-empty'), platform: 'darwin', which, readMuxVersion: () => { asked = true; return '3.3'; } });
    expect(asked).toBe(false);
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
