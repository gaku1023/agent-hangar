import { describe, expect, it, vi } from 'vitest';
import { AccountAuth, accountEnv, parseAuthStatus, type RunClaude } from './accountAuth.ts';
import type { Account } from './accounts.ts';

const primary: Account = { id: 'primary', name: '会社', dir: '/h/.claude', color: '#2a57b8' };
const univ: Account = { id: 'a1', name: '大学', dir: '/h/.claude-2', color: '#7a4a9e' };
const OK = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'taro@example.ac.jp', orgName: 'Example University', subscriptionType: 'enterprise' });

describe('accountEnv', () => {
  it('最初のアカウントは CLAUDE_CONFIG_DIR を外し、ほかは置き場を入れる。API キーの類は渡さない', () => {
    const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/stale', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o' };
    expect(accountEnv(primary, base)).toEqual({ PATH: '/bin' });
    expect(accountEnv(univ, base)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-2' });
  });
});

describe('parseAuthStatus', () => {
  it('必要な 4 つだけを取り出す', () => {
    expect(parseAuthStatus(OK, 5)).toEqual({ loggedIn: true, email: 'taro@example.ac.jp', plan: 'enterprise', orgName: 'Example University', checkedAt: 5 });
  });
  it('未ログインは loggedIn だけ偽で、ほかは null', () => {
    expect(parseAuthStatus('{"loggedIn":false}', 5)).toEqual({ loggedIn: false, email: null, plan: null, orgName: null, checkedAt: 5 });
  });
  it('JSON でない出力、loggedIn の無い出力は null', () => {
    expect(parseAuthStatus('Not logged in', 5)).toBeNull();
    expect(parseAuthStatus('{"email":"x"}', 5)).toBeNull();
  });
});

describe('AccountAuth', () => {
  it('置き場を環境変数で渡して auth status を呼び、結果を覚える', async () => {
    const run = vi.fn<RunClaude>(async () => ({ code: 0, stdout: OK }));
    const onChange = vi.fn();
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run, now: () => 9, onChange });
    expect(auth.get('a1')).toBeNull();
    expect((await auth.refresh(univ))?.plan).toBe('enterprise');
    expect(run).toHaveBeenCalledWith('/bin/claude', ['auth', 'status', '--json'], expect.objectContaining({ CLAUDE_CONFIG_DIR: '/h/.claude-2' }), 10_000);
    expect(auth.get('a1')?.email).toBe('taro@example.ac.jp');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('claude が無い、失敗した、JSON でないときは null を覚え、投げない', async () => {
    const none = new AccountAuth({ claudeBin: () => null, run: vi.fn() });
    expect(await none.refresh(univ)).toBeNull();
    const boom = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => { throw new Error('ETIMEDOUT'); } });
    expect(await boom.refresh(univ)).toBeNull();
    const junk = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => ({ code: 1, stdout: 'oops' }) });
    expect(await junk.refresh(univ)).toBeNull();
    expect(junk.get('a1')).toBeNull();
  });

  it('終了コードが 0 でなくても、標準出力が読めれば未ログインとして覚える', async () => {
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => ({ code: 1, stdout: '{"loggedIn":false}' }) });
    expect((await auth.refresh(univ))?.loggedIn).toBe(false);
  });

  it('login は claude auth login を起こし、終わったら状態を読み直す。走っている間の二度目は起こさない', async () => {
    let finish: (v: { code: number | null; stdout: string }) => void = () => {};
    const calls: string[][] = [];
    const run: RunClaude = (_bin, args) => {
      calls.push(args);
      if (args[1] === 'login') return new Promise((r) => { finish = r; });
      return Promise.resolve({ code: 0, stdout: OK });
    };
    const onChange = vi.fn();
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run, onChange });
    expect(auth.login(univ)).toBe(true);
    expect(auth.loginRunning('a1')).toBe(true);
    expect(auth.login(univ)).toBe(false);
    finish({ code: 0, stdout: '' });
    await vi.waitFor(() => expect(auth.get('a1')?.loggedIn).toBe(true));
    expect(auth.loginRunning('a1')).toBe(false);
    expect(calls).toEqual([['auth', 'login'], ['auth', 'status', '--json']]);
    expect(onChange).toHaveBeenCalled();
  });

  it('forget で覚えた状態を捨てる', async () => {
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => ({ code: 0, stdout: OK }) });
    await auth.refresh(univ);
    auth.forget('a1');
    expect(auth.get('a1')).toBeNull();
  });

  it('ensureChecked は、まだ読んでいないアカウントを裏で 1 回だけ読む。失敗しても読んだと数える', async () => {
    const run = vi.fn<RunClaude>(async () => ({ code: 0, stdout: OK }));
    const onChange = vi.fn();
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run, onChange });
    auth.ensureChecked(univ);
    auth.ensureChecked(univ);
    await vi.waitFor(() => expect(auth.get('a1')?.loggedIn).toBe(true));
    auth.ensureChecked(univ);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    const failing = vi.fn<RunClaude>(async () => { throw new Error('no claude'); });
    const auth2 = new AccountAuth({ claudeBin: () => '/bin/claude', run: failing });
    auth2.ensureChecked(univ);
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));
    auth2.ensureChecked(univ);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(auth2.get('a1')).toBeNull();
  });

  it('ensureChecked は、読み込みかログインが走っている間は起こさず、forget のあとは読み直す', async () => {
    let release: (v: { code: number | null; stdout: string }) => void = () => {};
    const run = vi.fn<RunClaude>((_b, args) => (args[1] === 'login' ? new Promise((r) => { release = r; }) : Promise.resolve({ code: 0, stdout: OK })));
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run });
    auth.login(univ);
    auth.ensureChecked(univ);
    expect(run).toHaveBeenCalledTimes(1);
    release({ code: 0, stdout: '' });
    await vi.waitFor(() => expect(auth.get('a1')?.loggedIn).toBe(true));
    expect(run).toHaveBeenCalledTimes(2);

    const slow = vi.fn<RunClaude>(() => new Promise((r) => { release = r; }));
    const auth2 = new AccountAuth({ claudeBin: () => '/bin/claude', run: slow });
    const pending = auth2.refresh(univ);
    auth2.ensureChecked(univ);
    expect(slow).toHaveBeenCalledTimes(1);
    release({ code: 0, stdout: OK });
    await pending;

    auth2.forget('a1');
    auth2.ensureChecked(univ);
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it('setOnChange で、あとから通知先を結べる', async () => {
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => ({ code: 0, stdout: OK }) });
    const onChange = vi.fn();
    auth.setOnChange(onChange);
    await auth.refresh(univ);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
