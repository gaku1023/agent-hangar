import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from './args.ts';

const base = { systemPrompt: 'SYS', mcpConfigPath: '/home/.agent-hangar/mcp/s1.json' };

describe('buildClaudeArgs', () => {
  it('可変長オプションを先頭に、プロンプトを末尾に置く', () => {
    const a = buildClaudeArgs({ ...base, mode: { kind: 'start', sessionUuid: 'u1' }, name: 'n', prompt: 'やって', model: 'opus', effort: 'high', permissionMode: 'default', worktree: 'wt', addDirs: ['/a', '/b'] });
    expect(a[0]).toBe('--mcp-config');
    expect(a[1]).toBe(base.mcpConfigPath);
    expect(a.slice(2, 6)).toEqual(['--add-dir', '/a', '--add-dir', '/b']);
    expect(a.slice(6)).toEqual(['--session-id', 'u1', '-n', 'n', '--append-system-prompt', 'SYS', '--model', 'opus', '--effort', 'high', '--permission-mode', 'default', '-w', 'wt', 'やって']);
  });

  it('トークンを argv に載せない', () => {
    // argv はプロセスの外から読める。MCP の設定は 0600 のファイルに置き、パスだけを渡す。
    const token = 'a1b2c3d4'.repeat(8);
    const a = buildClaudeArgs({ ...base, mode: { kind: 'start', sessionUuid: 'u1' }, prompt: 'やって' });
    expect(a.join(' ')).not.toContain(token);
    expect(a.join(' ')).not.toContain('Bearer');
    expect(a.join(' ')).not.toContain('mcpServers');
  });

  it('空の項目は含めない', () => {
    const a = buildClaudeArgs({ ...base, mode: { kind: 'start', sessionUuid: 'u1' }, name: '', prompt: '', addDirs: [] });
    expect(a).toEqual(['--mcp-config', base.mcpConfigPath, '--session-id', 'u1', '--append-system-prompt', 'SYS']);
  });

  it('再開とフォーク', () => {
    expect(buildClaudeArgs({ ...base, mode: { kind: 'resume', sessionUuid: 'u1' } }).slice(2)).toEqual(['-r', 'u1', '--append-system-prompt', 'SYS']);
    expect(buildClaudeArgs({ ...base, mode: { kind: 'fork', sessionUuid: 'u1', newSessionUuid: 'u2' } }).slice(2)).toEqual(['-r', 'u1', '--fork-session', '--session-id', 'u2', '--append-system-prompt', 'SYS']);
  });
});
