import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareClaudeVersions } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_OPENCODE_FLAGS, BUILTIN_OPENCODE_SUBCOMMANDS, BUILTIN_OPENCODE_VALUE_FLAGS,
  isOpencodeCliDrift, opencodeSubcommandsFromHelp, parseOpencodeHelp,
} from './cli.ts';

const HELP = [
  'DESCRIPTION',
  '  OpenCode command line interface',
  '',
  'USAGE',
  '  opencode <subcommand> [flags] [<directory>]',
  '',
  'ARGUMENTS',
  '  directory string    Directory to start OpenCode in (optional)',
  '',
  'FLAGS',
  '  --standalone            Run with a private server instead of the background service',
  '  --server string         Connect to a server URL instead of the background service',
  '  --continue, -c          Continue the last session',
  '  --session, -s string    Session ID to continue, or to create if it does not exist',
  '',
  'GLOBAL FLAGS',
  '  --help, -h                            Show help information',
  '  --log-level <all|trace|debug>         Sets the minimum log level (choices: all, trace,',
  '                                        debug)',
  '',
  'SUBCOMMANDS',
  '  upgrade, update    Upgrade OpenCode to the latest or a specific version',
  '  mini               Start the minimal interactive interface',
  '  serve              Start the v2 API and web server',
  '',
].join('\n');

describe('parseOpencodeHelp', () => {
  it('SUBCOMMANDS の節からサブコマンドを、FLAGS と GLOBAL FLAGS の節から引数を読む。別名は両方を入れる', () => {
    expect(parseOpencodeHelp(HELP)).toEqual({
      subcommands: ['mini', 'serve', 'update', 'upgrade'],
      flags: ['--continue', '--help', '--log-level', '--server', '--session', '--standalone', '-c', '-h', '-s'],
      valueFlags: ['--log-level', '--server', '--session', '-s'],
    });
  });
  it('ARGUMENTS と USAGE の節の語は読まない。説明の中の語と続きの行も読まない', () => {
    const h = parseOpencodeHelp(HELP)!;
    expect(h.subcommands).not.toContain('directory');
    expect(h.subcommands).not.toContain('opencode');
    expect(h.flags).not.toContain('debug');
  });
  it('SUBCOMMANDS の節が無いか、1 つも読めなければ null', () => {
    expect(parseOpencodeHelp('USAGE\n  opencode\n\nFLAGS\n  --auto  Auto\n')).toBeNull();
    expect(parseOpencodeHelp('SUBCOMMANDS\n')).toBeNull();
    expect(parseOpencodeHelp('')).toBeNull();
  });
  it('Claude の形（Commands:）は読まない', () => {
    expect(parseOpencodeHelp('Commands:\n  agents  Manage agents\n')).toBeNull();
  });
  it('CRLF の改行でも読む', () => {
    expect(parseOpencodeHelp(HELP.replace(/\n/g, '\r\n'))?.subcommands).toContain('upgrade');
  });
  it('名前の形でない語は、サブコマンドに入れない', () => {
    expect(parseOpencodeHelp('SUBCOMMANDS\n  good  x\n  bad;touch  y\n  $(x), ok  z\n  Upper  w\n')?.subcommands).toEqual(['good', 'ok']);
  });
  it('サブコマンドの行に引数が付いていても、名前だけを読む', () => {
    expect(parseOpencodeHelp('SUBCOMMANDS\n  attach <url>, at    Attach\n')?.subcommands).toEqual(['at', 'attach']);
  });
});

const c = (value: string) => ({ contract: 'cli', value, version: null });

describe('opencodeSubcommandsFromHelp', () => {
  it('読めた一覧を使い、組み込みの一覧との差と、知らないフラグをずれとして返す', () => {
    const r = opencodeSubcommandsFromHelp('FLAGS\n  --auto    x\n  --newflag string  y\n\nSUBCOMMANDS\n  run    x\n  newcmd    y\n');
    expect(r.subcommands).toEqual(['newcmd', 'run']);
    expect(r.drifts).toContainEqual(c('subcommand.added=newcmd'));
    expect(r.drifts).toContainEqual(c('subcommand.removed=serve'));
    expect(r.drifts).toContainEqual(c('flag.added=--newflag'));
    expect(r.drifts.some((d) => d.value === 'subcommand.removed=run')).toBe(false);
    expect(r.drifts.some((d) => d.value === 'flag.added=--auto')).toBe(false);
  });
  it('出力が無ければ、ずれ無しで組み込みの一覧を使う', () => {
    expect(opencodeSubcommandsFromHelp(null)).toEqual({ subcommands: BUILTIN_OPENCODE_SUBCOMMANDS, drifts: [] });
    expect(opencodeSubcommandsFromHelp('  ')).toEqual({ subcommands: BUILTIN_OPENCODE_SUBCOMMANDS, drifts: [] });
  });
  it('SUBCOMMANDS の節が無い出力は、組み込みの一覧を使い、ずれを 1 件だけ返す', () => {
    expect(opencodeSubcommandsFromHelp('Usage: opencode\nUnknown format\n')).toEqual({
      subcommands: BUILTIN_OPENCODE_SUBCOMMANDS, drifts: [c('help.subcommands=(missing)')],
    });
  });
});

describe('組み込みの一覧', () => {
  it('サブコマンドは 2.1.4 の 18 個で、別名の upgrade と update を両方持つ。1.x にしか無いものは持たない', () => {
    expect(BUILTIN_OPENCODE_SUBCOMMANDS).toHaveLength(18);
    expect(BUILTIN_OPENCODE_SUBCOMMANDS).toEqual(expect.arrayContaining(['upgrade', 'update', 'mini', 'run', 'serve']));
    for (const old of ['attach', 'export', 'import', 'db', 'agent', 'github', 'pr', 'web']) expect(BUILTIN_OPENCODE_SUBCOMMANDS).not.toContain(old);
    expect([...BUILTIN_OPENCODE_SUBCOMMANDS]).toEqual([...BUILTIN_OPENCODE_SUBCOMMANDS].sort());
  });
  it('値を取るフラグは、フラグの一覧に入っている', () => {
    for (const f of BUILTIN_OPENCODE_VALUE_FLAGS) expect(BUILTIN_OPENCODE_FLAGS).toContain(f);
    expect(BUILTIN_OPENCODE_VALUE_FLAGS).toEqual(expect.arrayContaining(['-s', '--session', '--server', '--prompt', '--log-level']));
    expect(BUILTIN_OPENCODE_VALUE_FLAGS).not.toContain('--auto');
  });
});

describe('isOpencodeCliDrift', () => {
  it('組み込みの一覧に入った増と、組み込みの一覧から外れた減は、もうずれでない', () => {
    expect(isOpencodeCliDrift('subcommand.added=serve')).toBe(false);
    expect(isOpencodeCliDrift('subcommand.added=newcmd')).toBe(true);
    expect(isOpencodeCliDrift('subcommand.removed=attach')).toBe(false);
    expect(isOpencodeCliDrift('subcommand.removed=serve')).toBe(true);
    expect(isOpencodeCliDrift('flag.added=--auto')).toBe(false);
    expect(isOpencodeCliDrift('flag.added=--newflag')).toBe(true);
  });
  it('欠けと知らない形の値はずれのまま', () => {
    expect(isOpencodeCliDrift('help.subcommands=(missing)')).toBe(true);
    expect(isOpencodeCliDrift('odd')).toBe(true);
  });
});

// 見本は packages/server/test/fixtures/opencode/<版>/help.txt。採り方は同じ置き場の README.md にある。
const FIXTURE_OPENCODE_DIR = fileURLToPath(new URL('../../../../test/fixtures/opencode', import.meta.url));
const fixtureVersions = fs.readdirSync(FIXTURE_OPENCODE_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
  .map((e) => e.name)
  .sort(compareClaudeVersions);
const readHelp = (v: string) => fs.readFileSync(path.join(FIXTURE_OPENCODE_DIR, v, 'help.txt'), 'utf8');

describe('見本の help.txt', () => {
  it('見本が 1 つ以上ある', () => {
    expect(fixtureVersions.length).toBeGreaterThan(0);
  });
  for (const v of fixtureVersions) {
    it(`${v} の help から、サブコマンドと値を取るフラグを読む`, () => {
      const h = parseOpencodeHelp(readHelp(v));
      expect(h).not.toBeNull();
      expect(h!.subcommands.length).toBeGreaterThan(5);
      expect(h!.flags).toEqual(expect.arrayContaining(['--server', '--session', '-s', '--prompt', '--auto']));
      expect(h!.valueFlags).toEqual(expect.arrayContaining(['--server', '--session', '-s', '--prompt']));
      expect(h!.valueFlags).not.toContain('--auto');
      expect(h!.subcommands).not.toContain('directory');
    });
  }
  // 組み込みの一覧は最も新しい版に合わせる。古い見本とは違ってよいので、最も新しい見本でだけ確かめる。
  it('最も新しい見本のサブコマンドとフラグは、組み込みの一覧と同じで、ずれは無い', () => {
    const text = readHelp(fixtureVersions.at(-1)!);
    expect(opencodeSubcommandsFromHelp(text)).toEqual({ subcommands: [...BUILTIN_OPENCODE_SUBCOMMANDS], drifts: [] });
    const h = parseOpencodeHelp(text)!;
    expect(h.flags).toEqual([...BUILTIN_OPENCODE_FLAGS]);
    expect(h.valueFlags).toEqual([...BUILTIN_OPENCODE_VALUE_FLAGS]);
  });
});
