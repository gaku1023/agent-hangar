import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mcpAddArgs, mcpRemoveArgs, runMcpInstall, runMcpUninstall } from './mcp.ts';

describe('mcpAddArgs', () => {
  it('名前と URL を先に、--header を最後に置く', () => {
    const a = mcpAddArgs({ port: 4177, token: 'tok' });
    expect(a).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'hangar', 'http://127.0.0.1:4177/mcp', '--header', 'Authorization: Bearer tok']);
    expect(a.indexOf('--header')).toBe(a.length - 2);
    expect(mcpRemoveArgs()).toEqual(['mcp', 'remove', '--scope', 'user', 'hangar']);
  });
});

describe('runMcpInstall', () => {
  it('claude mcp add を呼び、成功と失敗を報告する。メッセージにトークンを出さない', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-'));
    const calls: string[][] = [];
    const ok = runMcpInstall({ home, port: 4177, exec: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: 'Added', stderr: '' }; } });
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    expect(calls[0]![0]).toBe('claude');
    expect(calls[0]!.at(-1)).toBe(`Authorization: Bearer ${token}`);
    expect(ok.ok).toBe(true);
    expect(ok.message).not.toContain(token);
    const ng = runMcpInstall({ home, port: 4177, exec: () => ({ status: 1, stdout: '', stderr: 'claude: command not found' }) });
    expect(ng).toEqual({ ok: false, message: 'claude mcp add に失敗しました: claude: command not found' });
    expect(runMcpUninstall({ exec: () => ({ status: 0, stdout: '', stderr: '' }) }).ok).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
