import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, mcpConfigJson } from './args.ts';

const base = { systemPrompt: 'SYS', mcpUrl: 'http://127.0.0.1:4177/mcp/s/s1', token: 'tok' };

describe('mcpConfigJson', () => {
  it('hangar という名前の http サーバを Bearer 付きで書く', () => {
    expect(JSON.parse(mcpConfigJson('http://x/mcp/s/s1', 'tok'))).toEqual({ mcpServers: { hangar: { type: 'http', url: 'http://x/mcp/s/s1', headers: { Authorization: 'Bearer tok' } } } });
  });
});

describe('buildClaudeArgs', () => {
  it('可変長オプションを先頭に、プロンプトを末尾に置く', () => {
    const a = buildClaudeArgs({ ...base, mode: { kind: 'start', sessionUuid: 'u1' }, name: 'n', prompt: 'やって', model: 'opus', effort: 'high', permissionMode: 'default', worktree: 'wt', addDirs: ['/a', '/b'] });
    expect(a[0]).toBe('--mcp-config');
    expect(JSON.parse(a[1]!).mcpServers.hangar.url).toBe(base.mcpUrl);
    expect(a.slice(2, 6)).toEqual(['--add-dir', '/a', '--add-dir', '/b']);
    expect(a.slice(6)).toEqual(['--session-id', 'u1', '-n', 'n', '--append-system-prompt', 'SYS', '--model', 'opus', '--effort', 'high', '--permission-mode', 'default', '-w', 'wt', 'やって']);
  });
  it('空の項目は含めない', () => {
    const a = buildClaudeArgs({ ...base, mode: { kind: 'start', sessionUuid: 'u1' }, name: '', prompt: '', addDirs: [] });
    expect(a).toEqual(['--mcp-config', mcpConfigJson(base.mcpUrl, 'tok'), '--session-id', 'u1', '--append-system-prompt', 'SYS']);
  });
  it('再開とフォーク', () => {
    expect(buildClaudeArgs({ ...base, mode: { kind: 'resume', sessionUuid: 'u1' } }).slice(2)).toEqual(['-r', 'u1', '--append-system-prompt', 'SYS']);
    expect(buildClaudeArgs({ ...base, mode: { kind: 'fork', sessionUuid: 'u1', newSessionUuid: 'u2' } }).slice(2)).toEqual(['-r', 'u1', '--fork-session', '--session-id', 'u2', '--append-system-prompt', 'SYS']);
  });
});
