import { MessageError } from '../../i18n/message.ts';
import { describe, expect, it } from 'vitest';
import type { LaunchSpec } from '../../agent/types.ts';
import { CodexLaunchError, codexAppServerConfig, codexPermissionOf, MCP_TOKEN_ENV, planCodex } from './launcher.ts';
import { TUI_TOKEN_ENV } from './appServer.ts';

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  cwd: '/w/a', hangarSessionId: 's1', instructions: [], mcp: { url: 'http://127.0.0.1:4177/mcp/s/s1', secret: 'mcp-secret' }, env: {}, ...over,
});
const remote = { args: ['--remote', 'ws://127.0.0.1:9', '--remote-auth-token-env', TUI_TOKEN_ENV], env: { [TUI_TOKEN_ENV]: 'tui-token' } };

describe('権限の 3 段', () => {
  it('空と未指定は自動（workspace-write と on-request）', () => {
    expect(codexPermissionOf(undefined)).toBe('auto');
    expect(codexPermissionOf('')).toBe('auto');
  });
  it('3 段の名前を受ける。知らない値は断る', () => {
    expect(codexPermissionOf('read-only')).toBe('read-only');
    expect(codexPermissionOf('auto')).toBe('auto');
    expect(codexPermissionOf('full-access')).toBe('full-access');
    expect(() => codexPermissionOf('plan')).toThrow(CodexLaunchError);
  });
});

describe('app-server に渡す設定（-c）', () => {
  it('MCP は url と、トークンを入れた環境変数の名前と、道具の承認を approve で渡す。トークンの値は載せない', () => {
    const c = codexAppServerConfig(spec(), 'auto');
    expect(c).toContain('mcp_servers.hangar.url="http://127.0.0.1:4177/mcp/s/s1"');
    expect(c).toContain(`mcp_servers.hangar.bearer_token_env_var="${MCP_TOKEN_ENV}"`);
    expect(c).toContain('mcp_servers.hangar.default_tools_approval_mode="approve"');
    expect(c.join('\n')).not.toContain('mcp-secret');
  });
  it('追記は段をつないで developer_instructions に渡す。段が無ければ渡さない（model_instructions_file は使わない）', () => {
    const c = codexAppServerConfig(spec({ instructions: [{ key: 'body', text: 'a "b"\n' }, { key: 'status', text: 'c\n' }] }), 'auto');
    expect(c).toContain('developer_instructions="a \\"b\\"\\nc\\n"');
    expect(c.join('\n')).not.toContain('model_instructions_file');
    expect(codexAppServerConfig(spec(), 'auto').some((x) => x.startsWith('developer_instructions='))).toBe(false);
  });
  it('推論と権限の組を渡す。モデルが指定されていればモデルも渡す', () => {
    const c = codexAppServerConfig(spec({ effort: 'high', model: 'gpt-x' }), 'read-only');
    expect(c).toContain('model_reasoning_effort="high"');
    expect(c).toContain('model="gpt-x"');
    expect(c).toContain('sandbox_mode="read-only"');
    expect(c).toContain('approval_policy="on-request"');
    expect(codexAppServerConfig(spec(), 'full-access')).toEqual(expect.arrayContaining(['sandbox_mode="danger-full-access"', 'approval_policy="never"']));
  });
  it('推論に TOML を壊す文字が入っていたら断る', () => {
    expect(() => codexAppServerConfig(spec({ effort: 'high"\nx=1' }), 'auto')).toThrow(CodexLaunchError);
  });
});

describe('TUI の argv と環境', () => {
  it('新しい会話は --remote だけでつなぐ（resume を付けない）。権限の 3 段は -s と -a で渡す', () => {
    const p = planCodex('/bin/codex', { kind: 'start', id: 'pending:x' }, spec(), remote, ['CLAUDE_X']);
    expect(p.argv).toEqual(['/bin/codex', '--remote', 'ws://127.0.0.1:9', '--remote-auth-token-env', TUI_TOKEN_ENV, '-s', 'workspace-write', '-a', 'on-request']);
  });
  it('ID が分かっているときは resume <ID> でつなぐ。モデルと推論も渡す', () => {
    const p = planCodex('/bin/codex', { kind: 'start', id: '01a-b' }, spec({ model: 'gpt-x', effort: 'low', mode: 'read-only' }), remote, []);
    expect(p.argv).toEqual(['/bin/codex', '--remote', 'ws://127.0.0.1:9', '--remote-auth-token-env', TUI_TOKEN_ENV, '-m', 'gpt-x', '-c', 'model_reasoning_effort="low"', '-s', 'read-only', '-a', 'on-request', 'resume', '01a-b']);
  });
  it('フルアクセスは danger-full-access と never', () => {
    const p = planCodex('/bin/codex', { kind: 'start', id: 'pending:x' }, spec({ mode: 'full-access' }), remote, []);
    expect(p.argv.slice(-4)).toEqual(['-s', 'danger-full-access', '-a', 'never']);
  });
  it('token は argv に載せず、秘密の環境（secretEnv）にだけ置く。CODEX_HOME とアカウントの置き場は外す', () => {
    const p = planCodex('/bin/codex', { kind: 'start', id: 'pending:x' }, spec(), remote, ['HANGAR_X']);
    expect(p.argv.join(' ')).not.toContain('tui-token');
    expect(p.secretEnv).toEqual({ [TUI_TOKEN_ENV]: 'tui-token' });
    expect(p.env).toEqual({});
    expect(p.unset).toEqual(expect.arrayContaining(['HANGAR_X', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']));
  });
  it('再開は resume <ID>、フォークは新しい ID を resume でつなぐ。ID の無い（pending:）ものは、分かる断りにする', () => {
    expect(planCodex('/bin/codex', { kind: 'resume', id: 'a' }, spec(), remote, []).argv.slice(-2)).toEqual(['resume', 'a']);
    expect(planCodex('/bin/codex', { kind: 'fork', id: 'a', newId: 'b' }, spec(), remote, []).argv.slice(-2)).toEqual(['resume', 'b']);
    expect(() => planCodex('/bin/codex', { kind: 'resume', id: 'pending:x' }, spec(), remote, [])).toThrow(MessageError);
  });
});
