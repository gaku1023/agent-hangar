import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakeTool } from '../../../../test/fake-bin.ts';
import { posixIt } from '../../../../test/platform.ts';
import { agentsJsonDrifts, authStatusDrifts, BUILTIN_SUBCOMMANDS, claudeVersionOf, parseHelp, printJsonDrifts, readClaudeHelp, subcommandsFromHelp } from './cli.ts';

const HELP = [
  'Usage: claude [options] [command] [prompt]',
  '',
  'Claude Code - starts an interactive session by default, use -p/--print for',
  'non-interactive output',
  '',
  'Arguments:',
  '  prompt                                Your prompt',
  '',
  'Options:',
  '  --add-dir <directories...>            Additional directories to allow tool',
  '                                        access to',
  '  --allowedTools, --allowed-tools <tools...>',
  '      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)',
  '      Edit")',
  '  -c, --continue                        Continue the most recent conversation in',
  '  --cloud [description|session_id|url]  Create a cloud session with the given',
  '  -p, --print                           Print response and exit (useful for',
  '',
  'Commands:',
  '  agents [options]                      Manage background agents',
  '  attach <id|name>                      Open a background session in this',
  '                                        terminal. <id> is the short id that',
  '  plugin|plugins                        Manage Claude Code plugins',
  '  purge [options] [path]                Delete all Claude Code state for a',
  '  stop|kill <id>                        Stop a background session. Its',
  '  update|upgrade                        Check for updates and install if',
  '',
].join('\n');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('parseHelp', () => {
  it('Commands の節からサブコマンドを、Options の節から引数を読む。別名は両方を入れ、説明の続きの行は読まない', () => {
    expect(parseHelp(HELP)).toEqual({
      subcommands: ['agents', 'attach', 'kill', 'plugin', 'plugins', 'purge', 'stop', 'update', 'upgrade'],
      options: ['--add-dir', '--allowed-tools', '--allowedTools', '--cloud', '--continue', '--print', '-c', '-p'],
    });
  });
  it('Commands の節が無ければ null', () => {
    expect(parseHelp('Usage: claude\n\nOptions:\n  -p, --print  Print\n')).toBeNull();
    expect(parseHelp('')).toBeNull();
  });
  it('CRLF の改行でも読む', () => {
    expect(parseHelp(HELP.replace(/\n/g, '\r\n'))?.subcommands).toContain('purge');
  });
  it('名前の形でない語は、サブコマンドに入れない', () => {
    expect(parseHelp('Commands:\n  good  x\n  bad;touch  y\n  $(x)  z\n  Upper  w\n')?.subcommands).toEqual(['good']);
  });
});

describe('claudeVersionOf', () => {
  it('claude --version の出力から版を取り出す', () => {
    expect(claudeVersionOf('2.1.292 (Claude Code)\n')).toBe('2.1.292');
    expect(claudeVersionOf('error')).toBeNull();
  });
});

describe('subcommandsFromHelp', () => {
  it('読めた一覧を使い、組み込みの一覧との差をずれとして返す', () => {
    const r = subcommandsFromHelp('Commands:\n  agents  x\n  newcmd  y\n');
    expect(r.subcommands).toEqual(['agents', 'newcmd']);
    expect(r.drifts).toContainEqual({ contract: 'cli', value: 'subcommand.added=newcmd', version: null });
    expect(r.drifts).toContainEqual({ contract: 'cli', value: 'subcommand.removed=purge', version: null });
    expect(r.drifts.some((d) => d.value === 'subcommand.removed=agents')).toBe(false);
  });
  it('出力が無ければ、ずれ無しで組み込みの一覧を使う', () => {
    expect(subcommandsFromHelp(null)).toEqual({ subcommands: BUILTIN_SUBCOMMANDS, drifts: [] });
    expect(subcommandsFromHelp('  ')).toEqual({ subcommands: BUILTIN_SUBCOMMANDS, drifts: [] });
  });
  it('Commands の節が無い出力は、組み込みの一覧を使い、ずれを 1 件だけ返す', () => {
    expect(subcommandsFromHelp('Usage: claude\nUnknown format\n')).toEqual({ subcommands: BUILTIN_SUBCOMMANDS, drifts: [{ contract: 'cli', value: 'help.commands=(missing)', version: null }] });
  });
  it('組み込みの一覧は 2.1.292 の Commands で、--help に無い daemon と project を持たない', () => {
    expect(BUILTIN_SUBCOMMANDS).toContain('purge');
    expect(BUILTIN_SUBCOMMANDS).not.toContain('daemon');
    expect(BUILTIN_SUBCOMMANDS).not.toContain('project');
  });
});

describe('readClaudeHelp', () => {
  // 偽の claude は sh で書く。Windows の .cmd では固まる claude を真似られないので飛ばす。
  posixIt('出力を返し、固まった claude は時間で切って null を返す。無い claude も null', async () => {
    const ok = writeFakeTool(path.join(tmp, 'ok'), 'claude', { sh: 'echo "Commands:"', cmd: 'echo Commands:' });
    expect(await readClaudeHelp(ok)).toBe('Commands:\n');
    // exec で sleep に入れ替える。sh の子に残すと、切った後も出力の管を握られて戻りが遅れる。
    const slow = writeFakeTool(path.join(tmp, 'slow'), 'claude', { sh: 'exec sleep 10', cmd: '' });
    const t0 = Date.now();
    expect(await readClaudeHelp(slow, 300)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await readClaudeHelp(path.join(tmp, 'missing'))).toBeNull();
  });
  posixIt('0 以外で終わった claude は null', async () => {
    const bad = writeFakeTool(path.join(tmp, 'bad'), 'claude', { sh: 'echo "Commands:"; exit 3', cmd: 'exit /b 3' });
    expect(await readClaudeHelp(bad)).toBeNull();
  });
});

const c = (value: string) => ({ contract: 'cli', value, version: null });

describe('authStatusDrifts', () => {
  it('loggedIn があればずれは無い。出力が空なら見ない', () => {
    expect(authStatusDrifts('{"loggedIn":false}')).toEqual([]);
    expect(authStatusDrifts('')).toEqual([]);
  });
  it('JSON でない、オブジェクトでない、loggedIn が無い出力を返す', () => {
    expect(authStatusDrifts('Not logged in')).toEqual([c('auth-status=(not-json)')]);
    expect(authStatusDrifts('[]')).toEqual([c('auth-status=(not-object)')]);
    expect(authStatusDrifts('{"email":"x"}')).toEqual([c('auth-status.loggedIn=(missing)')]);
  });
});

describe('agentsJsonDrifts', () => {
  it('対話とバックグラウンドの行はずれを出さない。バックグラウンドの行だけ id と sessionId を見る', () => {
    expect(agentsJsonDrifts(JSON.stringify([{ kind: 'interactive', sessionId: 's1' }, { kind: 'background', id: 'b1', sessionId: 's2' }]))).toEqual([]);
    expect(agentsJsonDrifts('')).toEqual([]);
  });
  it('形の違いを種類ごとに 1 つだけ返す。知らない種類の行も、バックグラウンドと同じく id と sessionId を見る', () => {
    expect(agentsJsonDrifts('disabled')).toEqual([c('agents-json=(not-json)')]);
    expect(agentsJsonDrifts('{"sessions":[]}')).toEqual([c('agents-json=(not-array)')]);
    expect(agentsJsonDrifts(JSON.stringify([{ kind: 'remote' }, { kind: 'remote' }, { kind: 'background', sessionId: 's' }, 3]))).toEqual([
      c('agents-json.kind=remote'), c('agents-json.id=(missing)'), c('agents-json.sessionId=(missing)'), c('agents-json.row=(not-object)'),
    ]);
  });
});

describe('printJsonDrifts', () => {
  it('structured_output があればずれは無い', () => {
    expect(printJsonDrifts('{"type":"result","structured_output":{}}')).toEqual([]);
  });
  it('JSON でない、オブジェクトでない、structured_output が無い出力を返す', () => {
    expect(printJsonDrifts('oops')).toEqual([c('print-json=(not-json)')]);
    expect(printJsonDrifts('[]')).toEqual([c('print-json=(not-object)')]);
    expect(printJsonDrifts('{"type":"result"}')).toEqual([c('print-json.structured_output=(missing)')]);
  });
});
