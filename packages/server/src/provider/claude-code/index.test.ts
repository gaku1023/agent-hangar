import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../../launch/args.ts';
import { claudeCodeProvider } from './index.ts';

const base = { systemPrompt: 'SYS', mcpUrl: 'http://127.0.0.1:4177/mcp/s/s1', token: 'tok' };

describe('claudeCodeProvider', () => {
  it('claude を先頭に置いた起動コマンドを返す', () => {
    const input = { ...base, mode: { kind: 'start' as const, sessionUuid: 'u1' }, prompt: 'やって' };
    expect(claudeCodeProvider.id).toBe('claude-code');
    expect(claudeCodeProvider.launchCommand(input)).toEqual(['claude', ...buildClaudeArgs(input)]);
  });
  it('再開とフォークのコマンドを返す', () => {
    const resume = claudeCodeProvider.resumeCommand(base, { providerSessionId: 'u1' }, false);
    expect(resume).toEqual(['claude', ...buildClaudeArgs({ ...base, mode: { kind: 'resume', sessionUuid: 'u1' } })]);
    const fork = claudeCodeProvider.resumeCommand(base, { providerSessionId: 'u1' }, true, 'u2');
    expect(fork).toEqual(['claude', ...buildClaudeArgs({ ...base, mode: { kind: 'fork', sessionUuid: 'u1', newSessionUuid: 'u2' } })]);
  });
  it('フォークで新しい UUID が無ければ投げる', () => {
    expect(() => claudeCodeProvider.resumeCommand(base, { providerSessionId: 'u1' }, true)).toThrow(/UUID/);
    expect(() => claudeCodeProvider.resumeCommand(base, { providerSessionId: 'u1' }, true, '  ')).toThrow(/UUID/);
  });
});
