import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAuth, accountEnv, parseAuthStatus, type RunClaude } from './accountAuth.ts';
import type { Drift } from '../compat/types.ts';
import type { Account } from '../../../config/accounts.ts';

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

  it('auth status の形が違えば、ずれとして知らせる', async () => {
    const seen: Drift[] = [];
    const run = vi.fn<RunClaude>(async () => ({ code: 0, stdout: 'Not logged in' }));
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run, now: () => 9, compat: { note: (d) => seen.push(d) } });
    expect(await auth.refresh(univ)).toBeNull();
    expect(seen).toEqual([{ contract: 'cli', value: 'auth-status=(not-json)', version: null }]);
    run.mockResolvedValueOnce({ code: 0, stdout: OK });
    await auth.refresh(univ);
    expect(seen).toHaveLength(1);
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
    expect(auth.login(univ)).toBe('started');
    expect(auth.loginRunning('a1')).toBe(true);
    expect(auth.login(univ)).toBe('running');
    finish({ code: 0, stdout: '' });
    await vi.waitFor(() => expect(auth.get('a1')?.loggedIn).toBe(true));
    expect(auth.loginRunning('a1')).toBe(false);
    expect(calls).toEqual([['auth', 'login'], ['auth', 'status', '--json']]);
    expect(onChange).toHaveBeenCalled();
  });

  it('login は、claude が無ければ no-claude、走っていれば running を返す', () => {
    const none = new AccountAuth({ claudeBin: () => null, run: vi.fn() });
    expect(none.login(univ)).toBe('no-claude');
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: () => new Promise(() => {}) });
    expect(auth.login(univ)).toBe('started');
    expect(auth.login(univ)).toBe('running');
  });

  it('cancelLogin は走っているログインを止め、認証は読み直さない', async () => {
    const calls: string[][] = [];
    let aborted = false;
    const run: RunClaude = (_bin, args, _env, _ms, signal) => {
      calls.push(args);
      return new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); });
    };
    const onChange = vi.fn();
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run, onChange });
    auth.login(univ);
    expect(auth.cancelLogin('a1')).toBe(true);
    await vi.waitFor(() => expect(auth.loginRunning('a1')).toBe(false));
    expect(aborted).toBe(true);
    expect(calls).toEqual([['auth', 'login']]);
    expect(onChange).toHaveBeenCalled();
    expect(auth.cancelLogin('a1')).toBe(false);
  });

  it('中止したあとすぐログインし直しても、古い鎖が新しいログインを巻き込まない', async () => {
    const calls: string[][] = [];
    const run: RunClaude = (_bin, args, _env, _ms, signal) => {
      calls.push(args);
      if (args[1] !== 'login') return Promise.resolve({ code: 0, stdout: OK });
      return new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
    };
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run });
    auth.login(univ);
    auth.cancelLogin('a1');
    expect(auth.login(univ)).toBe('started');
    await new Promise((r) => setTimeout(r, 10));
    expect(auth.loginRunning('a1')).toBe(true);
    expect(calls).toEqual([['auth', 'login'], ['auth', 'login']]);
    expect(auth.cancelLogin('a1')).toBe(true);
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

  describe('通知先が投げても', () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    const boom = () => { throw new Error('配信に失敗'); };
    beforeEach(() => { rejections.length = 0; process.on('unhandledRejection', onRejection); });
    afterEach(() => { process.off('unhandledRejection', onRejection); });
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it('ensureChecked は未処理の rejection にならず、状態は読める', async () => {
      const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => ({ code: 0, stdout: OK }), onChange: boom });
      auth.ensureChecked(univ);
      await settle();
      expect(rejections).toEqual([]);
      expect(auth.get('a1')?.loggedIn).toBe(true);
    });

    it('login は未処理の rejection にならず、loginRunning は偽へ戻り、状態は読める', async () => {
      let finish: (v: { code: number | null; stdout: string }) => void = () => {};
      const run: RunClaude = (_b, args) => (args[1] === 'login' ? new Promise((r) => { finish = r; }) : Promise.resolve({ code: 0, stdout: OK }));
      const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run, onChange: boom });
      expect(auth.login(univ)).toBe('started');
      expect(auth.loginRunning('a1')).toBe(true);
      finish({ code: 0, stdout: '' });
      await settle();
      expect(rejections).toEqual([]);
      expect(auth.loginRunning('a1')).toBe(false);
      expect(auth.get('a1')?.loggedIn).toBe(true);
    });

    it('refresh を待つ側（HTTP）にも投げ返さない', async () => {
      const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => ({ code: 0, stdout: OK }), onChange: boom });
      await expect(auth.refresh(univ)).resolves.toMatchObject({ loggedIn: true });
    });
  });
});
