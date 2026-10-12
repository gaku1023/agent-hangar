import { describe, expect, it } from 'vitest';
import { readPermissionHook } from './permission.ts';

// Claude Code の PermissionRequest の hook が標準入力に渡す形（2.1.296 の本体の定義から）。tool_use_id は持たない。
const bash = { session_id: 'u1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf ./build/cache', description: '古いキャッシュを消す' }, permission_suggestions: [] };

describe('readPermissionHook', () => {
  it('Bash は命令の全文と説明を取る', () => {
    expect(readPermissionHook(bash)).toEqual({ providerSessionId: 'u1', ask: { tool: 'Bash', input: 'rm -rf ./build/cache', description: '古いキャッシュを消す' } });
  });

  it('ファイルを触る道具はパス、取りに行く道具は URL を取る', () => {
    expect(readPermissionHook({ ...bash, tool_name: 'Write', tool_input: { file_path: '/w/a.ts', content: 'x' } })?.ask).toEqual({ tool: 'Write', input: '/w/a.ts', description: null });
    expect(readPermissionHook({ ...bash, tool_name: 'WebFetch', tool_input: { url: 'https://example.com/', prompt: 'p' } })?.ask).toEqual({ tool: 'WebFetch', input: 'https://example.com/', description: null });
  });

  it('知らない形の入力は道具の名前だけにする', () => {
    expect(readPermissionHook({ ...bash, tool_name: 'mcp__x__y', tool_input: { a: 1 } })?.ask).toEqual({ tool: 'mcp__x__y', input: '', description: null });
    expect(readPermissionHook({ ...bash, tool_input: null })?.ask).toEqual({ tool: 'Bash', input: '', description: null });
  });

  it('長い命令は切る', () => {
    const long = 'x'.repeat(5000);
    expect(readPermissionHook({ ...bash, tool_input: { command: long } })?.ask.input.length).toBeLessThanOrEqual(2000);
  });

  it('サブエージェントの許可も読む（同じ端末に出るため）', () => {
    expect(readPermissionHook({ ...bash, agent_id: 'a1' })?.ask.tool).toBe('Bash');
  });

  it('ほかの出来事、欠けた値は読まない', () => {
    expect(readPermissionHook({ ...bash, hook_event_name: 'PreToolUse' })).toBeNull();
    expect(readPermissionHook({ ...bash, session_id: '' })).toBeNull();
    expect(readPermissionHook({ ...bash, tool_name: 3 })).toBeNull();
    expect(readPermissionHook(null)).toBeNull();
  });
});
