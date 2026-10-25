import { describe, expect, it } from 'vitest';
import { serveEnv, WINDOWS_SERVE_ALLOWLIST } from './env.ts';

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

  it('hangar の MCP の設定は OPENCODE_CONFIG_CONTENT の 1 つだけ足す（呼び手の OPENCODE_* は渡さないまま）', () => {
    const env = serveEnv('/opt/homebrew/bin/opencode', dirty, 'darwin', { configContent: '{"mcp":{}}' });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'LOGNAME', 'OPENCODE_CONFIG_CONTENT', 'PATH', 'SHELL', 'TMPDIR', 'USER']);
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"mcp":{}}');
  });

  it('置き場が固定の PATH に無ければ先頭に足す', () => {
    expect(serveEnv('/home/u/.opencode/bin/opencode', dirty, 'linux').PATH).toBe('/home/u/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('LANG が無ければ en_US.UTF-8 にする', () => {
    expect(serveEnv('/opt/homebrew/bin/opencode', { HOME: '/h' }, 'darwin').LANG).toBe('en_US.UTF-8');
  });

  // Windows で Explorer から起こした hangar の環境に近いもの。呼び手の印と、OS が配る鍵のうち渡さないもの（PSModulePath、COMPUTERNAME など）も混ぜる。
  const winDirty: NodeJS.ProcessEnv = {
    SystemRoot: 'C:\\WINDOWS', windir: 'C:\\WINDOWS', SystemDrive: 'C:', ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD',
    Path: 'C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\Program Files\\Git\\cmd;C:\\Users\\u\\AppData\\Roaming\\npm',
    USERPROFILE: 'C:\\Users\\u', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u', USERNAME: 'u',
    APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp', TMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
    ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files', ProgramData: 'C:\\ProgramData', CommonProgramFiles: 'C:\\Program Files\\Common Files',
    PROCESSOR_ARCHITECTURE: 'AMD64', NUMBER_OF_PROCESSORS: '8', OS: 'Windows_NT',
    PSModulePath: 'C:\\x', COMPUTERNAME: 'PC', NODE_OPTIONS: '--inspect',
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', HANGAR_RUN_ID: 'r1', HANGAR_TOKEN: 'secret', HANGAR_STOP_ON_STDIN_END: '1',
    OPENCODE_SERVER_PASSWORD: 'leak', OPENCODE_CONFIG: 'C:\\x\\opencode.json', ANTHROPIC_API_KEY: 'k',
  };
  const exe = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe';

  it('Windows は許可リストの鍵だけを写す', () => {
    const env = serveEnv(exe, winDirty, 'win32');
    expect(Object.keys(env).sort()).toEqual([...WINDOWS_SERVE_ALLOWLIST].sort());
    expect(env.SystemRoot).toBe('C:\\WINDOWS');
    expect(env.USERPROFILE).toBe('C:\\Users\\u');
    expect(env.APPDATA).toBe('C:\\Users\\u\\AppData\\Roaming');
    expect(env.TEMP).toBe('C:\\Users\\u\\AppData\\Local\\Temp');
  });

  it('Windows でも CLAUDE で始まる鍵と HANGAR_* と、呼び手の OPENCODE_* を 1 つも渡さない', () => {
    const keys = Object.keys(serveEnv(exe, winDirty, 'win32'));
    expect(keys.filter((k) => /^(CLAUDE|HANGAR_|OPENCODE_)/i.test(k))).toEqual([]);
    for (const k of ['ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'PSModulePath', 'COMPUTERNAME']) expect(keys).not.toContain(k);
  });

  it('Windows の PATH は呼び手の PATH を写し、opencode の置き場を先頭に足す。既にあれば足さない', () => {
    const dir = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin';
    expect(serveEnv(exe, winDirty, 'win32').PATH).toBe(`${dir};${winDirty.Path}`);
    expect(serveEnv('c:\\windows\\System32\\opencode.exe', winDirty, 'win32').PATH).toBe(winDirty.Path);
  });

  it('Windows の鍵は大文字小文字を問わずに拾い、許可リストの綴りで 1 つだけ渡す', () => {
    const env = serveEnv(exe, { SYSTEMROOT: 'C:\\WINDOWS', path: 'C:\\bin', userprofile: 'C:\\Users\\u', claudecode: '1', hangar_token: 's' }, 'win32');
    expect(env).toEqual({ SystemRoot: 'C:\\WINDOWS', USERPROFILE: 'C:\\Users\\u', PATH: `${exe.slice(0, exe.lastIndexOf('\\'))};C:\\bin` });
  });

  it('Windows で PATH が無ければ、置き場と System32 と SystemRoot にする', () => {
    expect(serveEnv('C:\\oc\\opencode.exe', { SystemRoot: 'D:\\Win' }, 'win32').PATH).toBe('C:\\oc;D:\\Win\\System32;D:\\Win');
    expect(serveEnv('C:\\oc\\opencode.exe', {}, 'win32').PATH).toBe('C:\\oc;C:\\Windows\\System32;C:\\Windows');
  });

  it('Windows でも hangar の MCP の設定は OPENCODE_CONFIG_CONTENT の 1 つだけ足す', () => {
    const env = serveEnv(exe, winDirty, 'win32', { configContent: '{"mcp":{}}' });
    expect(Object.keys(env).sort()).toEqual([...WINDOWS_SERVE_ALLOWLIST, 'OPENCODE_CONFIG_CONTENT'].sort());
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"mcp":{}}');
  });

  // 利用者が置き場を変えていれば、ふだんの opencode と同じ設定と DB を見るように渡す（段 G1 の申し送り）。
  const xdg = { XDG_DATA_HOME: '/d/data', XDG_CONFIG_HOME: '/d/config', XDG_CACHE_HOME: '/d/cache', XDG_STATE_HOME: '/d/state' };
  it('macOS と Linux は、利用者の XDG の置き場 4 つがあれば渡す（印は渡さないまま）', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const env = serveEnv('/opt/homebrew/bin/opencode', { ...dirty, ...xdg, XDG_RUNTIME_DIR: '/run/user/1' }, platform);
      expect(env).toMatchObject(xdg);
      expect(env.XDG_RUNTIME_DIR).toBeUndefined();
      expect(Object.keys(env).filter((k) => /^(CLAUDE|HANGAR_|OPENCODE_)/.test(k))).toEqual([]);
    }
  });
  it('XDG の置き場が無ければ足さない（空の値も渡さない）', () => {
    const env = serveEnv('/opt/homebrew/bin/opencode', { ...dirty, XDG_CONFIG_HOME: '' }, 'darwin');
    expect(Object.keys(env).filter((k) => k.startsWith('XDG_'))).toEqual([]);
  });
  it('Windows でも、利用者の XDG の置き場があれば許可リストに足して渡す', () => {
    const env = serveEnv(exe, { ...winDirty, xdg_config_home: 'C:\\x\\config', XDG_DATA_HOME: 'C:\\x\\data' }, 'win32');
    expect(env.XDG_CONFIG_HOME).toBe('C:\\x\\config');
    expect(env.XDG_DATA_HOME).toBe('C:\\x\\data');
    expect(env.XDG_CACHE_HOME).toBeUndefined();
    expect(Object.keys(env).filter((k) => /^(CLAUDE|HANGAR_|OPENCODE_)/i.test(k))).toEqual([]);
  });
});
