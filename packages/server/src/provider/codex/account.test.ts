import { describe, expect, it } from 'vitest';
import { CodexRpcError, type CodexNotification } from './appServer.ts';
import { CodexAccountService, parseAccountRead, type AccountAppServer, type CodexLoginEvent } from './account.ts';

type Reply = unknown | Error | ((p: unknown) => unknown);

/** 偽物の app-server。method ごとの返事と、起動と停止の記録を持つ。 */
function fake(replies: Record<string, Reply>) {
  const calls: { method: string; params: unknown }[] = [];
  const handlers = new Set<(n: CodexNotification) => void>();
  const closeHandlers: (() => void)[] = [];
  const state = { stopped: false, dir: undefined as string | null | undefined };
  const app: AccountAppServer = {
    rpc: {
      async request(method, params) {
        calls.push({ method, params });
        const r = replies[method];
        if (r instanceof Error) throw r;
        return (typeof r === 'function' ? (r as (p: unknown) => unknown)(params) : r) as never;
      },
      onAny(h) { handlers.add(h); return () => handlers.delete(h); },
      onClose(h) { if (h) closeHandlers.push(h); },
    },
    async stop() { state.stopped = true; },
  };
  return { app, calls, state, emit: (method: string, params: unknown) => { for (const h of [...handlers]) h({ method, params }); }, close: () => closeHandlers.forEach((h) => h()) };
}

function service(apps: ReturnType<typeof fake>[]) {
  const opened: string[] = [];
  const launched: (string | null)[] = [];
  const svc = new CodexAccountService({
    launch: async (dir) => { launched.push(dir); const f = apps.shift()!; f.state.dir = dir; return f.app; },
    openUrl: (u) => opened.push(u),
  });
  return { svc, opened, launched };
}

describe('account/read', () => {
  it('未ログインの置き場は loggedIn false で、app-server を止める', async () => {
    const f = fake({ 'account/read': { account: null, requiresOpenaiAuth: true, workspaceRouting: null } });
    const { svc, launched } = service([f]);
    expect(await svc.readAccount(null)).toEqual({ loggedIn: false, email: null, plan: null, chatgptAccountId: null });
    expect(launched).toEqual([null]);
    expect(f.state.stopped).toBe(true);
  });
  it('ログイン済みは email と plan と chatgptAccountId を返す', async () => {
    const r = parseAccountRead({ account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' }, workspaceRouting: { chatgptAccountId: 'acc-1' } });
    expect(r).toEqual({ loggedIn: true, email: 'a@example.com', plan: 'plus', chatgptAccountId: 'acc-1' });
  });
  it('読めなかったときも app-server は止める', async () => {
    const f = fake({ 'account/read': new Error('boom') });
    const { svc } = service([f]);
    await expect(svc.readAccount('/x')).rejects.toThrow('boom');
    expect(f.state.stopped).toBe(true);
  });
});

describe('account/rateLimits/read', () => {
  it('窓を codexRateLimitsOf で読む', async () => {
    const f = fake({ 'account/rateLimits/read': { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1_800_100_000 }, planType: 'plus' } } });
    const { svc } = service([f]);
    const w = await svc.readRateLimits('/home/x');
    expect(w).not.toBeNull();
    expect(JSON.stringify(w)).toContain('12');
    expect(f.state.stopped).toBe(true);
  });
  it('未ログインの「認証が要る」エラーは null、ほかのエラーは投げる', async () => {
    const a = fake({ 'account/rateLimits/read': new CodexRpcError(-32600, 'codex account authentication required to read rate limits') });
    expect(await service([a]).svc.readRateLimits(null)).toBeNull();
    const b = fake({ 'account/rateLimits/read': new CodexRpcError(-32603, 'internal') });
    await expect(service([b]).svc.readRateLimits(null)).rejects.toThrow('internal');
  });
});

describe('ログイン', () => {
  const browser = { type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.example/x' };

  it('ブラウザ：authUrl を開き、completed(success) で成功にして app-server を止める', async () => {
    const f = fake({ 'account/login/start': browser });
    const { svc, opened } = service([f]);
    const events: CodexLoginEvent[] = [];
    svc.onLoginChange((e) => events.push(e));
    const s = await svc.startLogin('a1', '/home/a1', 'browser');
    expect(s).toEqual({ status: 'waiting', method: 'browser', loginId: 'L1', authUrl: 'https://auth.example/x' });
    expect(opened).toEqual(['https://auth.example/x']);
    expect(f.calls[0]).toEqual({ method: 'account/login/start', params: { type: 'chatgpt' } });
    expect(f.state.stopped).toBe(false);
    f.emit('account/login/completed', { loginId: 'L1', success: true, error: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.loginState('a1')).toEqual({ status: 'success' });
    expect(f.state.stopped).toBe(true);
    expect(events.map((e) => e.state.status)).toEqual(['starting', 'waiting', 'success']);
  });

  it('デバイスコード：ブラウザは開かず、userCode と verificationUrl を状態に持つ', async () => {
    const f = fake({ 'account/login/start': { type: 'chatgptDeviceCode', loginId: 'L2', userCode: 'ABCD-1234', verificationUrl: 'https://v.example' } });
    const { svc, opened } = service([f]);
    const s = await svc.startLogin('a1', '/h', 'deviceCode');
    expect(s).toEqual({ status: 'waiting', method: 'deviceCode', loginId: 'L2', userCode: 'ABCD-1234', verificationUrl: 'https://v.example' });
    expect(opened).toEqual([]);
    expect(f.calls[0].params).toEqual({ type: 'chatgptDeviceCode' });
  });

  it('失敗の通知は failed と error を残す', async () => {
    const f = fake({ 'account/login/start': browser });
    const { svc } = service([f]);
    await svc.startLogin('a1', '/h', 'browser');
    f.emit('account/login/completed', { loginId: 'L1', success: false, error: 'Login server error: Login cancelled' });
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.loginState('a1')).toEqual({ status: 'failed', error: 'Login server error: Login cancelled' });
    expect(f.state.stopped).toBe(true);
  });

  it('同時に 1 つ：新しいログインは前のを cancel し、前のアカウントに superseded を残す', async () => {
    const f1 = fake({ 'account/login/start': browser, 'account/login/cancel': { status: 'canceled' } });
    const f2 = fake({ 'account/login/start': { ...browser, loginId: 'L9' } });
    const { svc } = service([f1, f2]);
    await svc.startLogin('a1', '/h1', 'browser');
    await svc.startLogin('a2', '/h2', 'browser');
    expect(f1.calls.map((c) => c.method)).toEqual(['account/login/start', 'account/login/cancel']);
    expect(f1.calls[1].params).toEqual({ loginId: 'L1' });
    expect(f1.state.stopped).toBe(true);
    expect(svc.loginState('a1')).toEqual({ status: 'superseded' });
    expect(svc.loginState('a2')).toMatchObject({ status: 'waiting', loginId: 'L9' });
    expect(f2.state.stopped).toBe(false);
    // 前のログインの遅れて来た通知は無視される
    f1.emit('account/login/completed', { loginId: 'L1', success: false, error: 'Login cancelled' });
    expect(svc.loginState('a1')).toEqual({ status: 'superseded' });
  });

  it('cancelLogin：cancel を送って止め、canceled を残す。別のアカウントのものには何もしない', async () => {
    const f = fake({ 'account/login/start': browser, 'account/login/cancel': { status: 'canceled' } });
    const { svc } = service([f]);
    await svc.startLogin('a1', '/h', 'browser');
    await svc.cancelLogin('other');
    expect(f.state.stopped).toBe(false);
    await svc.cancelLogin('a1');
    expect(f.calls.map((c) => c.method)).toEqual(['account/login/start', 'account/login/cancel']);
    expect(svc.loginState('a1')).toEqual({ status: 'canceled' });
    expect(f.state.stopped).toBe(true);
  });

  it('start が失敗したら failed にして app-server を止める。launch の失敗も failed', async () => {
    const f = fake({ 'account/login/start': new Error('nope') });
    const { svc } = service([f]);
    expect(await svc.startLogin('a1', '/h', 'browser')).toEqual({ status: 'failed', error: 'nope' });
    expect(f.state.stopped).toBe(true);
    const bad = new CodexAccountService({ launch: async () => { throw new Error('codex was not found'); }, openUrl: () => undefined });
    expect(await bad.startLogin('a1', null, 'browser')).toEqual({ status: 'failed', error: 'codex was not found' });
  });

  it('待っている間に app-server の接続が切れたら failed にする', async () => {
    const f = fake({ 'account/login/start': browser });
    const { svc } = service([f]);
    await svc.startLogin('a1', '/h', 'browser');
    f.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.loginState('a1')).toEqual({ status: 'failed', error: 'app-server closed' });
  });
});
