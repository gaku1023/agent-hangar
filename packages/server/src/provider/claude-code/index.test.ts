import { describe, expect, it } from 'vitest';
import { claudeCodeProvider } from './index.ts';

const base = { systemPrompt: 'SYS', mcpUrl: 'http://127.0.0.1:4177/mcp/s/s1', token: 'tok' };
const BIN = '/opt/homebrew/bin/claude';

/** フラグの直後の値を取る。 */
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe('claudeCodeProvider.launchCommand', () => {
  it('渡された実行ファイルを先頭に置く。パスは呼び手が決める', () => {
    const argv = claudeCodeProvider.launchCommand(BIN, { ...base, mode: { kind: 'start', sessionUuid: 'u1' } });
    expect(argv[0]).toBe(BIN);
    expect(claudeCodeProvider.launchCommand('/another/claude', { ...base, mode: { kind: 'start', sessionUuid: 'u1' } })[0]).toBe('/another/claude');
  });
  it('新規は --session-id でその UUID を指定し、初期プロンプトを末尾に置く', () => {
    const argv = claudeCodeProvider.launchCommand(BIN, { ...base, mode: { kind: 'start', sessionUuid: 'u1' }, prompt: 'やって' });
    expect(valueOf(argv, '--session-id')).toBe('u1');
    expect(argv).not.toContain('-r');
    expect(argv.at(-1)).toBe('やって');
    expect(JSON.parse(valueOf(argv, '--mcp-config')!).mcpServers.hangar.url).toBe(base.mcpUrl);
  });
});

describe('claudeCodeProvider.resumeCommand', () => {
  it('再開は -r だけを付け、新しいセッションは作らない', () => {
    const argv = claudeCodeProvider.resumeCommand(BIN, base, { providerSessionId: 'u1' }, false);
    expect(argv[0]).toBe(BIN);
    expect(valueOf(argv, '-r')).toBe('u1');
    expect(argv).not.toContain('--session-id');
    expect(argv).not.toContain('--fork-session');
  });
  it('フォークは元の UUID から新しい UUID を分ける', () => {
    const argv = claudeCodeProvider.resumeCommand(BIN, base, { providerSessionId: 'u1' }, true, 'u2');
    const i = argv.indexOf('--fork-session');
    expect(argv.slice(i - 2, i + 3)).toEqual(['-r', 'u1', '--fork-session', '--session-id', 'u2']);
  });
  it('フォークで新しい UUID が無ければ投げる。--session-id が空の壊れたコマンドを作らない', () => {
    expect(() => claudeCodeProvider.resumeCommand(BIN, base, { providerSessionId: 'u1' }, true)).toThrow(/UUID/);
    expect(() => claudeCodeProvider.resumeCommand(BIN, base, { providerSessionId: 'u1' }, true, '  ')).toThrow(/UUID/);
  });
});
