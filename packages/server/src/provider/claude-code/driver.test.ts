import { describe, expect, it, vi } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { agentsOf } from '../../agent/agents.ts';
import type { AgentDriver, AgentLauncher, LaunchPlan, LaunchSpec, SessionMode } from '../../agent/types.ts';
import { createClaudeDriver, type ClaudeDriverDeps } from './driver.ts';

const BIN = '/opt/homebrew/bin/claude';
/** MCP の設定のファイル。driver が書く代わりに、このパスを返す偽物を渡す。 */
const mcpConfigPath = '/home/.agent-hangar/mcp/s1.json';

function driverWith(over: Partial<ClaudeDriverDeps> = {}) {
  return createClaudeDriver({
    home: '/home/.agent-hangar',
    nodeBin: () => '/usr/local/bin/node',
    hookScript: () => '/home/.agent-hangar/hooks/hook.mjs',
    droppedEnv: ['CLAUDECODE', 'HANGAR_PORT'],
    claudeBin: () => BIN,
    live: () => [],
    procs: () => ({ runClaude: async () => '' }),
    report: () => {},
    files: { mcpConfig: () => mcpConfigPath, hookSettings: () => undefined },
    ...over,
  });
}

const driver = driverWith();
const base: LaunchSpec = { cwd: '/work', instructions: [{ key: 'body', text: 'SYS' }], mcp: { url: 'http://127.0.0.1:4177/mcp/s/s1', secret: 'sec' }, hangarSessionId: 's1', env: {} };
const plan = (mode: SessionMode, spec: LaunchSpec = base, bin = BIN) => driver.launch.plan(bin, mode, spec).argv;

/** フラグの直後の値を取る。 */
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe('Claude の driver の起動（新規）', () => {
  it('渡された実行ファイルを先頭に置く。パスは呼び手が決める', () => {
    const argv = plan({ kind: 'start', id: 'u1' });
    expect(argv[0]).toBe(BIN);
    expect(plan({ kind: 'start', id: 'u1' }, base, '/another/claude')[0]).toBe('/another/claude');
  });
  it('新規は --session-id でその UUID を指定し、初期プロンプトを末尾に置く', () => {
    const argv = plan({ kind: 'start', id: 'u1' }, { ...base, prompt: 'やって' });
    expect(valueOf(argv, '--session-id')).toBe('u1');
    expect(argv).not.toContain('-r');
    expect(argv.at(-1)).toBe('やって');
    // トークンの入る JSON ではなく、0600 のファイルのパスを渡す。
    expect(valueOf(argv, '--mcp-config')).toBe(mcpConfigPath);
  });
});

describe('Claude の driver の起動（再開とフォーク）', () => {
  it('再開は -r だけを付け、新しいセッションは作らない', () => {
    const argv = plan({ kind: 'resume', id: 'u1' });
    expect(argv[0]).toBe(BIN);
    expect(valueOf(argv, '-r')).toBe('u1');
    expect(argv).not.toContain('--session-id');
    expect(argv).not.toContain('--fork-session');
  });
  it('フォークは元の UUID から新しい UUID を分ける', () => {
    const argv = plan({ kind: 'fork', id: 'u1', newId: 'u2' });
    const i = argv.indexOf('--fork-session');
    expect(argv.slice(i - 2, i + 3)).toEqual(['-r', 'u1', '--fork-session', '--session-id', 'u2']);
  });
  it('フォークで新しい UUID が無ければ投げる。--session-id が空の壊れたコマンドを作らない', () => {
    expect(() => plan({ kind: 'fork', id: 'u1' } as SessionMode)).toThrow(/UUID/);
    expect(() => plan({ kind: 'fork', id: 'u1', newId: '  ' })).toThrow(/UUID/);
  });
});

describe('Claude の driver が AgentDriver の起動の型を満たす', () => {
  it('種類は sessions.provider の値と同じで、agents から引ける', () => {
    const d: AgentDriver = driver;
    expect(d.kind).toBe('claude-code');
    const agents = agentsOf([d]);
    expect(agents.of('claude-code')).toBe(d);
    expect(() => agents.of('nope')).toThrow();
  });
  it('ID を先に決める。Claude は UUID を作る', () => {
    const launcher: AgentLauncher = driver.launch;
    const a = launcher.newSessionId?.();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(launcher.newSessionId?.()).not.toBe(a);
    // Claude は起こす前の下ごしらえを持たない。
    expect(launcher.materialize).toBeUndefined();
  });
  it('plan は MCP の設定を書いてそのパスを渡し、外す変数を返す。置き場が無ければ CLAUDE_CONFIG_DIR も外す', () => {
    const mcpConfig = vi.fn(() => mcpConfigPath);
    const hookSettings = vi.fn(() => '/home/.agent-hangar/hooks/s1.json');
    const d = driverWith({ files: { mcpConfig, hookSettings } });
    const p: LaunchPlan = d.launch.plan(BIN, { kind: 'start', id: 'u1' }, base);
    expect(mcpConfig).toHaveBeenCalledWith('/home/.agent-hangar', 's1', base.mcp.url, base.mcp.secret);
    expect(hookSettings).toHaveBeenCalledWith('/home/.agent-hangar', 's1', { node: '/usr/local/bin/node', script: '/home/.agent-hangar/hooks/hook.mjs', mcpConfigPath });
    expect(valueOf(p.argv, '--settings')).toBe('/home/.agent-hangar/hooks/s1.json');
    expect(valueOf(p.argv, '--append-system-prompt')).toBe('SYS');
    expect(p.env).toEqual({});
    expect(p.unset).toEqual(['CLAUDECODE', 'HANGAR_PORT', 'CLAUDE_CONFIG_DIR']);
    expect(d.launch.plan(BIN, { kind: 'start', id: 'u1' }, { ...base, env: { CLAUDE_CONFIG_DIR: '/acct' } }).unset).toEqual(['CLAUDECODE', 'HANGAR_PORT']);
  });
  it('hook の設定を書けなくても起こす。--settings を省き、失敗を知らせる', () => {
    const report = vi.fn();
    const d = driverWith({ report, files: { mcpConfig: () => mcpConfigPath, hookSettings: () => { throw new Error('disk'); } } });
    const argv = d.launch.plan(BIN, { kind: 'start', id: 'u1' }, base).argv;
    expect(argv).not.toContain('--settings');
    expect(report).toHaveBeenCalledWith('hook-settings', expect.any(Error));
  });
  it('release はバックグラウンドのセッションだけ claude stop で止め、止めにいったら true を返す', async () => {
    const runClaude = vi.fn(async () => '');
    const live = [{ sessionId: 'u1', background: { jobId: 'job1' } }] as unknown as LiveSessionDto[];
    const d = driverWith({ live: () => live, procs: () => ({ runClaude }) });
    expect(await d.launch.release({ providerSessionId: 'u1', cwd: '/no/such/dir' }, 'killed')).toBe(true);
    // cwd が無ければ hangar の置き場で走らせる。
    expect(runClaude).toHaveBeenCalledWith(BIN, ['stop', 'job1'], '/home/.agent-hangar');
    expect(await d.launch.release({ providerSessionId: 'u2', cwd: '/' }, 'parked')).toBe(false);
    // 画面が閉じれば claude も終わるので、tui-gone では何もしない。
    expect(await d.launch.release({ providerSessionId: 'u1', cwd: '/' }, 'tui-gone')).toBe(false);
    expect(runClaude).toHaveBeenCalledTimes(1);
    expect(await driverWith({ live: () => live, claudeBin: () => null }).launch.release({ providerSessionId: 'u1', cwd: '/' }, 'killed')).toBe(false);
  });
});
