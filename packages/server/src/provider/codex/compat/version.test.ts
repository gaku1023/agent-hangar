import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakeCodex } from '../../../../test/fake-codex.ts';
import { posixIt } from '../../../../test/platform.ts';
import { codexBaseEnv } from '../env.ts';
import { codexVersionOf, judgeCodexVersion, LocalCodex } from './version.ts';

describe('codexVersionOf と judgeCodexVersion', () => {
  it('--version の出力から版を取り出す', () => {
    expect(codexVersionOf('codex-cli 0.164.0\n')).toBe('codex-cli 0.164.0'.match(/\d+\.\d+\.\d+/)![0]);
    expect(codexVersionOf('codex-cli 0.165.0-alpha.2')).toBe('0.165.0');
    expect(codexVersionOf('')).toBeNull();
    expect(codexVersionOf('error: unknown option')).toBeNull();
  });
  it('0.165.x の中だけ検証済み', () => {
    expect(judgeCodexVersion('0.165.0')).toBe('verified');
    expect(judgeCodexVersion('0.165.7')).toBe('verified');
    expect(judgeCodexVersion('0.164.9')).toBe('unverified');
    expect(judgeCodexVersion('0.166.0')).toBe('unverified');
    expect(judgeCodexVersion('1.164.0')).toBe('unverified');
  });
  it('読めない版は unknown', () => {
    expect(judgeCodexVersion(null)).toBe('unknown');
    expect(judgeCodexVersion('latest')).toBe('unknown');
  });
  it('範囲は引数で替えられる', () => {
    expect(judgeCodexVersion('0.165.2', '0.165.x')).toBe('verified');
    expect(judgeCodexVersion('0.164.1', '0.164.0')).toBe('unverified');
  });
});

describe('codexBaseEnv', () => {
  const src: NodeJS.ProcessEnv = { HOME: '/Users/me', USER: 'me', LANG: 'ja_JP.UTF-8', PATH: '/x/bin', CLAUDECODE: '1', HANGAR_TOKEN: 's', CODEX_HOME: '/other', OPENAI_API_KEY: 'k' };
  posixIt('空の環境に、codex と hangar の node の置き場を PATH へ足す。呼び手の印と CODEX_HOME は渡さない', () => {
    const env = codexBaseEnv('/opt/codex/bin/codex', src, 'darwin', '/Users/me/.nvm/versions/node/v22/bin/node');
    expect(env).toEqual({ HOME: '/Users/me', USER: 'me', LANG: 'ja_JP.UTF-8', PATH: '/opt/codex/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.nvm/versions/node/v22/bin' });
  });
  posixIt('node が固定の PATH の中にあれば足さない', () => {
    const env = codexBaseEnv('/opt/homebrew/bin/codex', {}, 'linux', '/usr/bin/node');
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });
  it('どの OS でも CLAUDE と HANGAR で始まる鍵を持たない', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const env = codexBaseEnv(platform === 'win32' ? 'C:\\codex\\codex.exe' : '/c/codex', { ...src, SystemRoot: 'C:\\Windows' }, platform, platform === 'win32' ? 'C:\\node\\node.exe' : '/n/node');
      expect(Object.keys(env).filter((k) => /^(CLAUDE|HANGAR)/i.test(k))).toEqual([]);
      expect(env.CODEX_HOME).toBeUndefined();
    }
  });
});

describe('LocalCodex', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-codex-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('見つからなければ found が偽', async () => {
    expect(await new LocalCodex({ bin: () => null }).status()).toEqual({ found: false, version: null, verified: false, loggedIn: false });
    expect(await new LocalCodex({ bin: () => path.join(dir, 'nope') }).status()).toEqual({ found: false, version: null, verified: false, loggedIn: false });
  });
  it('版とログインを読む（login status が 0 ならログイン済み）', async () => {
    const bin = writeFakeCodex(dir, { version: '0.165.2' });
    expect(await new LocalCodex({ bin: () => bin, codexHome: dir }).status()).toEqual({ found: true, version: '0.165.2', verified: true, loggedIn: true });
  });
  it('ログインしていなければ loggedIn が偽。範囲の外なら verified が偽', async () => {
    const bin = writeFakeCodex(dir, { version: '0.170.0', loggedIn: false });
    expect(await new LocalCodex({ bin: () => bin, codexHome: dir }).status()).toEqual({ found: true, version: '0.170.0', verified: false, loggedIn: false });
  });
  it('版は同じファイルなら打ち直さず、ログインは聞くたびに打つ。呼び手の印は渡さない', async () => {
    const logFile = path.join(dir, 'log.jsonl');
    const bin = writeFakeCodex(dir, { logFile });
    const c = new LocalCodex({ bin: () => bin, codexHome: dir, env: { HOME: dir, CLAUDECODE: '1', HANGAR_TOKEN: 's' } });
    await c.status();
    await c.status();
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> });
    expect(lines.filter((l) => l.argv[0] === '--version')).toHaveLength(1);
    expect(lines.filter((l) => l.argv[0] === 'login')).toHaveLength(2);
    for (const l of lines) {
      expect(Object.keys(l.env).filter((k) => /^(CLAUDE|HANGAR)/.test(k))).toEqual([]);
      expect(l.env.PATH).toContain(path.dirname(process.execPath));
    }
  });
  it('login status が時間切れなら loggedIn は null（分からない）。版は読める', async () => {
    const bin = writeFakeCodex(dir, { version: '0.165.2', loginHang: true });
    expect(await new LocalCodex({ bin: () => bin, codexHome: dir, timeoutMs: 600 }).status()).toEqual({ found: true, version: '0.165.2', verified: true, loggedIn: null });
  });
  it('版は一時の CODEX_HOME で読み、本物の置き場には何も作らせない。.codex が無ければ login status は起こさず未ログイン', async () => {
    const logFile = path.join(dir, 'log.jsonl');
    const bin = writeFakeCodex(dir, { logFile });
    const home = path.join(dir, 'nohome');
    const c = new LocalCodex({ bin: () => bin, codexHome: home });
    expect(await c.status()).toEqual({ found: true, version: '0.165.0', verified: true, loggedIn: false });
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> });
    expect(lines.map((l) => l.argv[0])).toEqual(['--version']);
    expect(lines[0]!.env.CODEX_HOME).toBeTruthy();
    expect(lines[0]!.env.CODEX_HOME).not.toBe(home);
    expect(fs.existsSync(lines[0]!.env.CODEX_HOME!)).toBe(false); // 打ったあとに消してある
    expect(fs.existsSync(home)).toBe(false);
  });
  it('.codex が既にあれば login status は本物のログインを読む（CODEX_HOME は渡さない）', async () => {
    const logFile = path.join(dir, 'log.jsonl');
    const bin = writeFakeCodex(dir, { logFile });
    const home = path.join(dir, 'real');
    fs.mkdirSync(home);
    expect(await new LocalCodex({ bin: () => bin, codexHome: home }).status()).toMatchObject({ loggedIn: true });
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> });
    expect(lines.find((l) => l.argv[0] === 'login')!.env.CODEX_HOME).toBeUndefined();
  });
  it('起こせない codex は、拒否せず読めなかった答えにする', async () => {
    const bin = path.join(dir, 'codex');
    fs.writeFileSync(bin, 'not executable');
    expect(await new LocalCodex({ bin: () => bin, codexHome: dir }).status()).toEqual({ found: true, version: null, verified: false, loggedIn: false });
  });
});
