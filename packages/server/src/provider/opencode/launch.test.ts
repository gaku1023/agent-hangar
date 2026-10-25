import { describe, expect, it } from 'vitest';
import type { LaunchSpec } from '../../agent/types.ts';
import { HANGAR_INSTRUCTION_KEY, hangarServeConfig, instructionValue, modelRefOf, planOpencode } from './launch.ts';

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  cwd: '/w/alpha',
  hangarSessionId: 'h1',
  mcp: { url: 'http://127.0.0.1:4177/mcp/s/h1', secret: 'run-secret' },
  instructions: [],
  env: {},
  ...over,
});
const serve = { url: 'http://127.0.0.1:40123', password: 'serve-password', pid: 1 };
const dropped = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'HANGAR_HOME'] as const;

describe('hangarServeConfig', () => {
  it('hangar の MCP を remote として、run の秘密を Authorization の header で渡す設定にする', () => {
    expect(JSON.parse(hangarServeConfig({ url: 'http://127.0.0.1:4177/mcp/s/h1', secret: 's3' }))).toEqual({
      mcp: { servers: { hangar: { type: 'remote', url: 'http://127.0.0.1:4177/mcp/s/h1', headers: { Authorization: 'Bearer s3' } } } },
    });
  });
  it('許可のひな形を渡されたら permissions に並びのまま入れる（規則は後に書いたものが勝つ）', () => {
    const rules = [{ action: 'shell', resource: '*', effect: 'ask' as const }, { action: 'shell', resource: 'ls *', effect: 'allow' as const }];
    expect(JSON.parse(hangarServeConfig({ url: 'u', secret: 's' }, rules)).permissions).toEqual(rules);
    expect(JSON.parse(hangarServeConfig({ url: 'u', secret: 's' }, null))).not.toHaveProperty('permissions');
  });
});

describe('modelRefOf', () => {
  it('provider/model の形を、最初の / で割る', () => {
    expect(modelRefOf('opencode/glm-5.3-flash-free')).toEqual({ providerID: 'opencode', id: 'glm-5.3-flash-free' });
    expect(modelRefOf('lmstudio/qwen/qwen3.8-27b')).toEqual({ providerID: 'lmstudio', id: 'qwen/qwen3.8-27b' });
  });
  it('割れない値と空は渡さない（opencode の既定のモデルで始まる）', () => {
    expect(modelRefOf(undefined)).toBeUndefined();
    expect(modelRefOf('sonnet')).toBeUndefined();
    expect(modelRefOf('/x')).toBeUndefined();
    expect(modelRefOf('x/')).toBeUndefined();
  });
});

describe('instructionValue', () => {
  it('段を区切りを足さずにつなぐ。段が無ければ null（PUT しない）', () => {
    expect(instructionValue([{ key: 'body', text: 'a\n' }, { key: 'live', text: 'b\n' }])).toBe('a\nb\n');
    expect(instructionValue([])).toBeNull();
    expect(HANGAR_INSTRUCTION_KEY).toBe('hangar');
  });
});

describe('planOpencode', () => {
  it('TUI を serve につなぎ、返った ID の会話を開く。パスワードは秘密の環境で渡し、argv にも tmux の環境にも載せない', () => {
    const plan = planOpencode('/opt/homebrew/bin/opencode', 'ses_abc', spec(), serve, dropped);
    expect(plan.argv).toEqual(['/opt/homebrew/bin/opencode', '/w/alpha', '--server', 'http://127.0.0.1:40123', '-s', 'ses_abc']);
    expect(plan.env).toEqual({});
    expect(plan.secretEnv).toEqual({ OPENCODE_PASSWORD: 'serve-password' });
    expect(plan.argv.join(' ')).not.toContain('serve-password');
    expect(plan.argv.join(' ')).not.toContain('run-secret');
    expect(plan.watchRemoteUrl).toBeFalsy();
  });
  it('--auto は自動承認がオンのときだけ付け、初期プロンプトは --prompt で渡す', () => {
    expect(planOpencode('oc', 'ses_1', spec({ autoApprove: false }), serve, dropped).argv).not.toContain('--auto');
    const plan = planOpencode('oc', 'ses_1', spec({ autoApprove: true, prompt: '直して' }), serve, dropped);
    expect(plan.argv).toEqual(['oc', '/w/alpha', '--server', 'http://127.0.0.1:40123', '-s', 'ses_1', '--auto', '--prompt', '直して']);
  });
  it('CLAUDE 系と HANGAR_* を外し、アカウントの置き場（CLAUDE_CONFIG_DIR）も持ち込まない', () => {
    const plan = planOpencode('oc', 'ses_1', spec({ env: { CLAUDE_CONFIG_DIR: '/x' } }), serve, dropped);
    expect(plan.unset).toEqual(expect.arrayContaining([...dropped, 'CLAUDE_CONFIG_DIR']));
  });
  it('Remote Control と Claude だけの指定は捨てる', () => {
    const plan = planOpencode('oc', 'ses_1', spec({ remoteControl: 'x', effort: 'high', addDirs: ['/a'], worktree: 'w' }), serve, dropped);
    expect(plan.argv).toEqual(['oc', '/w/alpha', '--server', 'http://127.0.0.1:40123', '-s', 'ses_1']);
  });
});
