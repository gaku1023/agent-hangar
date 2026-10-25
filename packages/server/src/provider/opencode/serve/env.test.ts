import { describe, expect, it } from 'vitest';
import { serveEnv, ServeUnsupportedError } from './env.ts';

// hangar を Claude Code のセッションから起こしたときにサーバの環境に入っている印と、opencode が読む設定の鍵を混ぜる。
const dirty: NodeJS.ProcessEnv = {
  HOME: '/Users/u', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', TMPDIR: '/var/folders/x/', LANG: 'ja_JP.UTF-8',
  PATH: '/Users/u/.nvm/bin:/usr/bin',
  CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_SSE_PORT: '1234',
  HANGAR_RUN_ID: 'r1', HANGAR_TOKEN: 'secret', HANGAR_CLOUD_DIR: '/x',
  OPENCODE_SERVER_PASSWORD: 'leak', OPENCODE_CONFIG: '/x/opencode.json', ANTHROPIC_API_KEY: 'k',
};

describe('serveEnv', () => {
  it('macOS は決まった鍵と固定の PATH だけを渡す', () => {
    const env = serveEnv('/opt/homebrew/bin/opencode', dirty, 'darwin');
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER']);
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(env.LANG).toBe('ja_JP.UTF-8');
  });

  it('CLAUDE で始まる鍵と HANGAR_* と、呼び手の OPENCODE_* を 1 つも渡さない', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const keys = Object.keys(serveEnv('/home/u/.opencode/bin/opencode', dirty, platform));
      expect(keys.filter((k) => k.startsWith('CLAUDE'))).toEqual([]);
      expect(keys.filter((k) => k.startsWith('HANGAR_'))).toEqual([]);
      expect(keys.filter((k) => k.startsWith('OPENCODE_'))).toEqual([]);
      expect(keys).not.toContain('ANTHROPIC_API_KEY');
    }
  });

  it('置き場が固定の PATH に無ければ先頭に足す', () => {
    expect(serveEnv('/home/u/.opencode/bin/opencode', dirty, 'linux').PATH).toBe('/home/u/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('LANG が無ければ en_US.UTF-8 にする', () => {
    expect(serveEnv('/opt/homebrew/bin/opencode', { HOME: '/h' }, 'darwin').LANG).toBe('en_US.UTF-8');
  });

  it('Windows の許可リストは G1 で決めるので、まだ起こさない', () => {
    expect(() => serveEnv('C:\\oc\\opencode.cmd', dirty, 'win32')).toThrow(ServeUnsupportedError);
  });
});
