import { describe, expect, it } from 'vitest';
import { CLAUDE_CHILD_ENV } from '../provider/claude-code/compat/childEnv.ts';
import { errorText } from '../i18n/message.ts';
import { RunError } from './errors.ts';
import { decodeTerminalRequest, splitCodexTerminalArgs, splitOpencodeTerminalArgs, splitTerminalArgs, terminalAgentOf, terminalEnv } from './terminal.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const UUID = '480a20da-0b1b-4e20-b8f5-2b5c82124ecb';

describe('decodeTerminalRequest', () => {
  it('base64 の作業ディレクトリ、NUL 区切りの引数と環境変数を読む', () => {
    const r = decodeTerminalRequest({ cwd: b64('/w/日本語 dir'), args: b64(['--model', 'opus', '直して\nください'].join('\0')), env: b64('A=1\0B=x=y\0C=複数\n行\0') });
    expect(r).toEqual({ cwd: '/w/日本語 dir', args: ['--model', 'opus', '直して\nください'], env: { A: '1', B: 'x=y', C: '複数\n行' } });
  });
  it('最後の引数が空でも落とさない。末尾の NUL を捨てるのは env -0 の出力だけである', () => {
    expect(decodeTerminalRequest({ cwd: b64('/w'), args: b64('-n\0'), env: '' })?.args).toEqual(['-n', '']);
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

describe('terminalAgentOf（どのエージェントの起動か）', () => {
  it('agent の無い本文（古い包み方）は Claude Code にする', () => {
    expect(terminalAgentOf({ cwd: 'x', args: '', env: '' })).toBe('claude-code');
    expect(terminalAgentOf({ agent: 'claude' })).toBe('claude-code');
    expect(terminalAgentOf({ agent: 'claude-code' })).toBe('claude-code');
  });
  it('opencode はそのまま、知らない値は null', () => {
    expect(terminalAgentOf({ agent: 'opencode' })).toBe('opencode');
    expect(terminalAgentOf({ agent: 'gemini' })).toBeNull();
    expect(terminalAgentOf({ agent: 1 })).toBeNull();
  });
});

describe('splitOpencodeTerminalArgs（許可リスト方式）', () => {
  const none = { session: null, prompt: null, autoApprove: false, dir: null };
  it('引数が無ければ、何も写さない', () => {
    expect(splitOpencodeTerminalArgs([])).toEqual(none);
  });
  it('--auto、--prompt、-s、ディレクトリを写す。値を取るフラグの値をディレクトリと取り違えない', () => {
    expect(splitOpencodeTerminalArgs(['--auto', '--prompt', 'sub', 'dir'])).toEqual({ session: null, prompt: 'sub', autoApprove: true, dir: 'dir' });
    expect(splitOpencodeTerminalArgs(['--prompt=直して ください'])).toEqual({ ...none, prompt: '直して ください' });
    expect(splitOpencodeTerminalArgs(['-s', 'ses_abc123'])).toEqual({ ...none, session: 'ses_abc123' });
    expect(splitOpencodeTerminalArgs(['--session', 'ses_abc123', '--prompt', '-c'])).toEqual({ ...none, session: 'ses_abc123', prompt: '-c' });
    expect(splitOpencodeTerminalArgs(['--session=ses_abc123'])).toEqual({ ...none, session: 'ses_abc123' });
  });
  it('知らないフラグと、素通しにするフラグは断る。包み方は素の opencode に回す', () => {
    for (const a of [['-c'], ['--continue'], ['--server', 'http://x'], ['--standalone'], ['-h'], ['--model', 'x'], ['--auto=1'], ['--'], ['-v']]) {
      expect(() => splitOpencodeTerminalArgs(a), a.join(' ')).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
  it('値の無い値を取るフラグ、2 つ目のディレクトリ、サブコマンドは断る', () => {
    expect(() => splitOpencodeTerminalArgs(['--prompt'])).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => splitOpencodeTerminalArgs(['a', 'b'])).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => splitOpencodeTerminalArgs(['run', 'x'])).toThrow(expect.objectContaining({ status: 400 }));
  });
  it('会話の ID の形でない -s は、hangar の会話ではないので 404 で断る', () => {
    expect(() => splitOpencodeTerminalArgs(['-s', 'さっきの'])).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('terminalAgentOf（codex）', () => {
  it('codex はそのまま読む', () => {
    expect(terminalAgentOf({ agent: 'codex' })).toBe('codex');
  });
});

describe('splitCodexTerminalArgs（許可リスト方式）', () => {
  const none = { resume: null, prompt: null, model: null, effort: null, permission: null };
  it('引数が無ければ、何も写さない', () => {
    expect(splitCodexTerminalArgs([])).toEqual(none);
  });
  it('プロンプト、-m、-c model_reasoning_effort を写す。値を取るフラグの値をプロンプトと取り違えない', () => {
    expect(splitCodexTerminalArgs(['-m', 'gpt-x', '--model', 'gpt-y', '直して ください'])).toEqual({ ...none, model: 'gpt-y', prompt: '直して ください' });
    expect(splitCodexTerminalArgs(['--model=gpt-x'])).toEqual({ ...none, model: 'gpt-x' });
    expect(splitCodexTerminalArgs(['-c', 'model_reasoning_effort=high'])).toEqual({ ...none, effort: 'high' });
    expect(splitCodexTerminalArgs(['-c', 'model_reasoning_effort="low"', 'x'])).toEqual({ ...none, effort: 'low', prompt: 'x' });
    expect(splitCodexTerminalArgs(['--config=model_reasoning_effort=medium'])).toEqual({ ...none, effort: 'medium' });
    expect(splitCodexTerminalArgs(['-m', 'resume'])).toEqual({ ...none, model: 'resume' });
  });
  it('-s と -a は権限の 3 段へ写す。3 段に当たらない組は断る', () => {
    const perm = (a: string[]) => splitCodexTerminalArgs(a).permission;
    expect(perm(['-s', 'read-only'])).toBe('read-only');
    expect(perm(['-s', 'read-only', '-a', 'on-request'])).toBe('read-only');
    expect(perm(['-s', 'workspace-write'])).toBe('auto');
    expect(perm(['--sandbox=workspace-write', '--ask-for-approval', 'on-request'])).toBe('auto');
    expect(perm(['-a', 'on-request'])).toBe('auto');
    expect(perm(['-s', 'danger-full-access', '-a', 'never'])).toBe('full-access');
    for (const a of [['-s', 'danger-full-access'], ['-a', 'never'], ['-s', 'read-only', '-a', 'never'], ['-s', 'workspace-write', '-a', 'never'], ['-s', 'nonsense'], ['-a', 'untrusted']]) {
      expect(() => splitCodexTerminalArgs(a), a.join(' ')).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
  it('resume <ID> は再開として写し、ID の形でない resume は断る', () => {
    expect(splitCodexTerminalArgs(['resume', UUID])).toEqual({ ...none, resume: UUID });
    expect(splitCodexTerminalArgs(['-m', 'x', 'resume', UUID, '-s', 'read-only'])).toEqual({ ...none, resume: UUID, model: 'x', permission: 'read-only' });
    for (const a of [['resume'], ['resume', '--last'], ['resume', 'さっきの'], ['resume', UUID, 'もう 1 つ']]) {
      expect(() => splitCodexTerminalArgs(a), a.join(' ')).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
  it('知らないフラグ、素通しのサブコマンド、写せない -c、2 つ目のプロンプト、値の無いフラグは断る。包み方は素の codex に回す', () => {
    for (const a of [['--oss'], ['-C', '/x'], ['--search'], ['-p', 'x'], ['--dangerously-bypass-approvals-and-sandbox'], ['--'], ['-V'], ['-c', 'model="o3"'], ['-c', 'x'], ['exec', 'x'], ['login'], ['mcp', 'list'], ['fork', UUID], ['a', 'b'], ['-m'], ['--model']]) {
      expect(() => splitCodexTerminalArgs(a), a.join(' ')).toThrow(expect.objectContaining({ status: 400 }));
    }
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
  // 外の端末が Claude Code のセッションの中から起きていると、そのセッションの印を持っている。
  // 印を持ったまま hangar の tmux で claude を起こすと、子のセッションとして再開の一覧から外れる。
  it('Claude Code が子に立てる印は落とし、利用者の設定は残す', () => {
    const user = { CLAUDE_CONFIG_DIR: '/u/.claude-work', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_EFFORT_LEVEL: 'high', ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_MODEL: 'opus' };
    const env = { ...Object.fromEntries(CLAUDE_CHILD_ENV.map((n) => [n, 'x'])), ...user };
    expect(terminalEnv(env)).toEqual(user);
  });
  it('名前として読めない変数は落とす', () => {
    expect(terminalEnv({ 'BASH_FUNC_x%%': '() { :; }', '1A': 'x', 'A B': 'x', OK_1: 'y' })).toEqual({ OK_1: 'y' });
  });
});

describe('断る文の言語', () => {
  const caught = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } throw new Error('投げなかった'); };
  it('日本語と英語のどちらでも出せる', () => {
    const noId = caught(() => splitTerminalArgs(['-r']));
    expect(errorText('ja', noId)).toBe('会話の ID を指定せずに再開した会話は hangar で開けません');
    expect(errorText('en', noId)).toBe('A resume without a conversation ID cannot be opened in Hangar');
    const flag = caught(() => splitTerminalArgs(['--session-id=abc']));
    expect(errorText('ja', flag)).toBe('--session-id を指定して起動した会話は hangar で開けません');
    expect(errorText('en', flag)).toBe('A launch with --session-id cannot be opened in Hangar');
  });
});
