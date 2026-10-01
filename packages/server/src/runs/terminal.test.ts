import { describe, expect, it } from 'vitest';
import { RunError } from './errors.ts';
import { decodeTerminalRequest, splitTerminalArgs, terminalEnv } from './terminal.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const UUID = '480a20da-0b1b-4e20-b8f5-2b5c82124ecb';

describe('decodeTerminalRequest', () => {
  it('base64 の作業ディレクトリ、NUL 区切りの引数と環境変数を読む', () => {
    const r = decodeTerminalRequest({ cwd: b64('/w/日本語 dir'), args: b64(['--model', 'opus', '直して\nください'].join('\0')), env: b64('A=1\0B=x=y\0C=複数\n行\0') });
    expect(r).toEqual({ cwd: '/w/日本語 dir', args: ['--model', 'opus', '直して\nください'], env: { A: '1', B: 'x=y', C: '複数\n行' } });
  });
  it('引数が無ければ空の配列にする', () => {
    expect(decodeTerminalRequest({ cwd: b64('/w'), args: '', env: '' })).toEqual({ cwd: '/w', args: [], env: {} });
  });
  it('形が違えば null を返す', () => {
    expect(decodeTerminalRequest(null)).toBeNull();
    expect(decodeTerminalRequest({ cwd: 1, args: '', env: '' })).toBeNull();
    expect(decodeTerminalRequest({ cwd: '', args: '', env: '' })).toBeNull();
    expect(decodeTerminalRequest({ cwd: b64('relative/dir'), args: '', env: '' })).toBeNull();
  });
});

describe('splitTerminalArgs', () => {
  it('-r と --resume の id を抜き出し、残りの引数はそのまま返す', () => {
    expect(splitTerminalArgs(['-r', UUID, '--model', 'opus'])).toEqual({ resume: UUID, rest: ['--model', 'opus'] });
    expect(splitTerminalArgs(['--resume', UUID])).toEqual({ resume: UUID, rest: [] });
    expect(splitTerminalArgs([`--resume=${UUID}`, '直して'])).toEqual({ resume: UUID, rest: ['直して'] });
    expect(splitTerminalArgs(['直して', '-n', 'x'])).toEqual({ resume: null, rest: ['直して', '-n', 'x'] });
  });
  it('id の無い -r と、検索の語の -r は断る。選ぶ画面は素の claude が出す', () => {
    expect(() => splitTerminalArgs(['-r'])).toThrow(RunError);
    expect(() => splitTerminalArgs(['-r', 'さっきの'])).toThrow(RunError);
  });
  it('hangar が組み立てる引数と重なるもの、意味が変わるものは断る', () => {
    for (const a of ['--session-id', '--append-system-prompt', '--append-system-prompt-file', '--fork-session', '-c', '--continue', '-p', '--print', '--bg', '--background']) {
      expect(() => splitTerminalArgs([a, 'x']), a).toThrow(RunError);
    }
    expect(() => splitTerminalArgs(['--session-id=abc'])).toThrow(RunError);
  });
  it('-- の後ろは引数として読まない', () => {
    expect(splitTerminalArgs(['--', '-p', 'について説明して'])).toEqual({ resume: null, rest: ['--', '-p', 'について説明して'] });
  });
});

describe('terminalEnv', () => {
  it('端末とシェルに固有の変数を落とし、ほかは残す', () => {
    const env = {
      PATH: '/usr/bin', HOME: '/Users/x', VIRTUAL_ENV: '/w/.venv', AWS_PROFILE: 'dev', LANG: 'ja_JP.UTF-8', COLORTERM: 'truecolor',
      TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%1', TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5', TERM_SESSION_ID: 'w0', ITERM_SESSION_ID: 'w0', ITERM_PROFILE: 'Default', LC_TERMINAL: 'iTerm2', LC_TERMINAL_VERSION: '3.5',
      SHLVL: '2', PWD: '/w', OLDPWD: '/', _: '/usr/bin/env', COLUMNS: '80', LINES: '24',
      HANGAR_NO_WRAP: '', HANGAR_RUN_ID: 'r', CLAUDECODE: '1', CLAUDE_CODE_SESSION_KIND: 'bg', CLAUDE_CODE_ENTRYPOINT: 'cli',
    };
    expect(terminalEnv(env)).toEqual({ PATH: '/usr/bin', HOME: '/Users/x', VIRTUAL_ENV: '/w/.venv', AWS_PROFILE: 'dev', LANG: 'ja_JP.UTF-8', COLORTERM: 'truecolor' });
  });
  it('名前として読めない変数は落とす', () => {
    expect(terminalEnv({ 'BASH_FUNC_x%%': '() { :; }', '1A': 'x', 'A B': 'x', OK_1: 'y' })).toEqual({ OK_1: 'y' });
  });
});
