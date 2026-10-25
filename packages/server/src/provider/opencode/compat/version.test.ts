import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakeNodeTool } from '../../../../test/fake-bin.ts';
import { posixIt } from '../../../../test/platform.ts';
import { serveEnv } from '../serve/env.ts';
import { judgeOpencodeVersion, LocalOpencode, opencodeProbeEnv, opencodeVersionOf } from './version.ts';

describe('opencodeVersionOf', () => {
  it('--version の出力から版を取り出す', () => {
    expect(opencodeVersionOf('2.1.4\n')).toBe('2.1.4');
    expect(opencodeVersionOf('opencode 2.1.10')).toBe('2.1.10');
    expect(opencodeVersionOf('1.14.3')).toBe('1.14.3');
  });
  it('版の形が無ければ null', () => {
    expect(opencodeVersionOf('')).toBeNull();
    expect(opencodeVersionOf('error: unknown option')).toBeNull();
    expect(opencodeVersionOf('2.1')).toBeNull();
  });
});

describe('judgeOpencodeVersion', () => {
  it('確かめた範囲（2.1.x）の中', () => {
    expect(judgeOpencodeVersion('2.1.0')).toBe('verified');
    expect(judgeOpencodeVersion('2.1.4')).toBe('verified');
    expect(judgeOpencodeVersion('2.1.99')).toBe('verified');
  });
  it('範囲の外', () => {
    expect(judgeOpencodeVersion('2.0.9')).toBe('unverified');
    expect(judgeOpencodeVersion('2.2.0')).toBe('unverified');
    expect(judgeOpencodeVersion('3.0.0')).toBe('unverified');
    expect(judgeOpencodeVersion('0.9.0')).toBe('unverified');
  });
  it('1.x は API の形が違う古い系統として分ける', () => {
    expect(judgeOpencodeVersion('1.0.0')).toBe('legacy');
    expect(judgeOpencodeVersion('1.14.3')).toBe('legacy');
  });
  it('読めない版', () => {
    expect(judgeOpencodeVersion(null)).toBe('unknown');
    expect(judgeOpencodeVersion('')).toBe('unknown');
    expect(judgeOpencodeVersion('latest')).toBe('unknown');
  });
  it('範囲は引数で替えられる', () => {
    expect(judgeOpencodeVersion('2.2.1', '2.2.x')).toBe('verified');
    expect(judgeOpencodeVersion('2.1.4', '2.x')).toBe('verified');
    expect(judgeOpencodeVersion('2.1.4', '2.1.4')).toBe('verified');
    expect(judgeOpencodeVersion('2.1.5', '2.1.4')).toBe('unverified');
  });
});

describe('opencodeProbeEnv', () => {
  // 呼び手の環境（hangar を Claude Code のセッションから起こしたときの印、hangar 自身の印）を持ち込まない。
  const src: NodeJS.ProcessEnv = {
    HOME: '/Users/me', USER: 'me', LOGNAME: 'me', SHELL: '/bin/zsh', TMPDIR: '/tmp/x/', LANG: 'ja_JP.UTF-8', PATH: '/Users/me/.nvm/bin:/usr/bin',
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', HANGAR_TOKEN: 'secret', HANGAR_CLOUD_DIR: '/c', OPENCODE_SERVER_PASSWORD: 'p', NODE_OPTIONS: '--inspect', ANTHROPIC_API_KEY: 'k',
  };
  posixIt('macOS と Linux は決まった鍵だけを渡し、PATH は opencode の置き場と固定の最小にする', () => {
    const env = opencodeProbeEnv('/Users/me/.opencode/bin/opencode', src, 'darwin');
    expect(env).toEqual({
      HOME: '/Users/me', USER: 'me', LOGNAME: 'me', SHELL: '/bin/zsh', TMPDIR: '/tmp/x/', LANG: 'ja_JP.UTF-8',
      PATH: '/Users/me/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    });
  });
  posixIt('無い鍵は足さない。LANG が無ければ en_US.UTF-8', () => {
    const env = opencodeProbeEnv('/opt/homebrew/bin/opencode', { HOME: '/h', CLAUDECODE: '1' }, 'linux');
    expect(env).toEqual({ HOME: '/h', LANG: 'en_US.UTF-8', PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' });
  });
  it('どの OS でも CLAUDE と HANGAR で始まる鍵を持たない', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const env = opencodeProbeEnv(platform === 'win32' ? 'C:\\tools\\opencode.exe' : '/x/opencode', { ...src, SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' }, platform);
      expect(Object.keys(env).filter((k) => /^(CLAUDE|HANGAR_|OPENCODE_|NODE_OPTIONS|ANTHROPIC_)/.test(k))).toEqual([]);
    }
  });
  it('Windows の版を読む環境は、serve を起こす環境と同じ許可リストにする', () => {
    const win = { ...src, SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', Path: 'C:\\Windows\\system32' };
    expect(opencodeProbeEnv('C:\\tools\\opencode.exe', win, 'win32')).toEqual(serveEnv('C:\\tools\\opencode.exe', win, 'win32'));
  });
});

describe('LocalOpencode', () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-opencode-'));
    log = path.join(dir, 'calls.jsonl');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** 呼ばれるたびに引数と環境を 1 行ずつ書き、out を出す偽の opencode。 */
  const fakeOpencode = (out: string, code = 0): string => writeFakeNodeTool(path.join(dir, 'bin'), 'opencode', `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\\n');
process.stdout.write(${JSON.stringify(out)});
process.exit(${code});
`);
  const calls = (): { args: string[]; env: Record<string, string> }[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> }) : []);
  const callerEnv: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', HANGAR_TOKEN: 'secret' };

  posixIt('--version を空の環境で 1 回だけ打ち、何度聞いても同じ答えを返す', async () => {
    const bin = fakeOpencode('2.1.4\n');
    const local = new LocalOpencode({ bin: () => bin, env: callerEnv });
    const [a, b] = await Promise.all([local.status(), local.status()]);
    const c = await local.status();
    for (const s of [a, b, c]) expect(s).toEqual({ found: true, version: '2.1.4', verified: true });
    const got = calls();
    expect(got).toHaveLength(1);
    expect(got[0]!.args).toEqual(['--version']);
    // 偽の bin を起こす包み（sh）と Node が足す鍵（PWD、SHLVL、_ など）のほかは、決まった鍵だけである。
    const keys = Object.keys(got[0]!.env).filter((k) => !['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING'].includes(k));
    expect(keys.every((k) => ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'PATH'].includes(k))).toBe(true);
    expect(Object.keys(got[0]!.env).filter((k) => k.startsWith('CLAUDE') || k.startsWith('HANGAR_'))).toEqual([]);
    expect(got[0]!.env.PATH!.split(':')[0]).toBe(path.dirname(bin));
  });

  posixIt('ファイルが替わったら（更新したら）読み直す', async () => {
    const bin = fakeOpencode('2.1.4\n');
    const local = new LocalOpencode({ bin: () => bin, env: callerEnv });
    expect((await local.status()).version).toBe('2.1.4');
    fakeOpencode('2.2.0-beta.1\n');
    fs.utimesSync(bin, new Date(), new Date(Date.now() + 5000));
    expect(await local.status()).toEqual({ found: true, version: '2.2.0', verified: false });
    expect(calls()).toHaveLength(2);
  });

  posixIt('1.x は見つかったが未検証', async () => {
    const bin = fakeOpencode('1.14.3\n');
    expect(await new LocalOpencode({ bin: () => bin, env: callerEnv }).status()).toEqual({ found: true, version: '1.14.3', verified: false });
  });

  posixIt('版が読めなければ version は null で未検証。同じファイルなら打ち直さない', async () => {
    const bin = fakeOpencode('something went wrong\n', 1);
    const local = new LocalOpencode({ bin: () => bin, env: callerEnv });
    expect(await local.status()).toEqual({ found: true, version: null, verified: false });
    expect(await local.status()).toEqual({ found: true, version: null, verified: false });
    expect(calls()).toHaveLength(1);
  });

  it('見つからなければ何も起こさない', async () => {
    expect(await new LocalOpencode({ bin: () => null }).status()).toEqual({ found: false, version: null, verified: false });
    // 消えたファイルを指していても、見つからないと答える。
    expect(await new LocalOpencode({ bin: () => path.join(dir, 'gone', 'opencode') }).status()).toEqual({ found: false, version: null, verified: false });
  });
});
