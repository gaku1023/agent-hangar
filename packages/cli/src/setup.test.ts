import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSetupReport, runSetup } from './setup.ts';

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
