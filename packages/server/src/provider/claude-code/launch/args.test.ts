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

  it('hook の設定ファイルは --mcp-config の直後に --settings で渡す', () => {
    // --mcp-config は可変長なので、次のオプションで区切る。--settings は値を 1 つだけ取る。
    const a = buildClaudeArgs({ ...base, settingsPath: '/home/.agent-hangar/mcp/s1.settings.json', mode: { kind: 'start', sessionUuid: 'u1' }, addDirs: ['/a'], prompt: 'やって' });
    expect(a.slice(0, 6)).toEqual(['--mcp-config', base.mcpConfigPath, '--settings', '/home/.agent-hangar/mcp/s1.settings.json', '--add-dir', '/a']);
    expect(a.at(-1)).toBe('やって');
  });

  it('再開とフォーク', () => {
    expect(buildClaudeArgs({ ...base, mode: { kind: 'resume', sessionUuid: 'u1' } }).slice(2)).toEqual(['-r', 'u1', '--append-system-prompt', 'SYS']);
    expect(buildClaudeArgs({ ...base, mode: { kind: 'fork', sessionUuid: 'u1', newSessionUuid: 'u2' } }).slice(2)).toEqual(['-r', 'u1', '--fork-session', '--session-id', 'u2', '--append-system-prompt', 'SYS']);
  });

  it('remoteControl が文字列なら --remote-control と名前が続く（名前は別の要素で、プロンプトは末尾のまま）', () => {
    const a = buildClaudeArgs({ ...base, mode: { kind: 'start', sessionUuid: 'u1' }, remoteControl: '会話 1', prompt: 'やって' });
    const i = a.indexOf('--remote-control');
    expect(i).toBeGreaterThan(-1);
    expect(a[i + 1]).toBe('会話 1');
    expect(a.at(-1)).toBe('やって');
  });

  it('remoteControl が null か未指定なら付かない', () => {
    expect(buildClaudeArgs({ ...base, mode: { kind: 'start', sessionUuid: 'u1' }, remoteControl: null })).not.toContain('--remote-control');
    expect(buildClaudeArgs({ ...base, mode: { kind: 'start', sessionUuid: 'u1' } })).not.toContain('--remote-control');
  });

  it('再開とフォークでも付く', () => {
    for (const mode of [{ kind: 'resume', sessionUuid: 'u1' }, { kind: 'fork', sessionUuid: 'u1', newSessionUuid: 'u2' }] as const) {
      const a = buildClaudeArgs({ ...base, mode, remoteControl: 'project-a' });
      expect(a[a.indexOf('--remote-control') + 1]).toBe('project-a');
    }
  });
});
