import os from 'node:os';
import type { AccountAuthDto, AccountDto } from '@agent-hangar/shared';
import { spawn } from 'node:child_process';
import { openTargetCommand } from '../../platform/browser.ts';
import { findCodex } from '../../config/tools.ts';
import type { AgentWindows } from '../../usage/agentUsage.ts';
import { codexBaseEnv } from './env.ts';
import { launchCodexAppServer } from './launch.ts';
import { CodexRpcError, type CodexNotification } from './appServer.ts';
import { codexRateLimitsOf } from './usage.ts';

/**
 * Codex のアカウントの読み取りとログイン（計画の S2）。
 * 置き場（CODEX_HOME）ごとに短命の app-server を起こし、`account/read` などを読んで止める。
 * 最初のアカウントは dir が null で、CODEX_HOME を渡さない（~/.codex のまま）。
 * 読み取りの形とログインの方法は shared の型（AccountAuthDto、AccountDto.login）に寄せてある。
 */

export type CodexAccountRead = Pick<AccountAuthDto, 'loggedIn' | 'email' | 'plan'> & {
  chatgptAccountId: string | null;
};

export type CodexLoginMethod = NonNullable<AccountDto['login']>['method'];

export type CodexLoginState =
  | { status: 'starting' }
  | { status: 'waiting'; method: 'browser'; loginId: string; authUrl: string }
  | { status: 'waiting'; method: 'deviceCode'; loginId: string; userCode: string; verificationUrl: string }
  | { status: 'success' }
  | { status: 'failed'; error: string }
  | { status: 'canceled' }
  /** 別のアカウントのログインを始めたので取り消した。 */
  | { status: 'superseded' };

export type CodexLoginEvent = { accountId: string; state: CodexLoginState };

/** rpc の最小の口（試験が偽物を渡せるように）。 */
export type AccountRpc = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onAny(handler: (n: CodexNotification) => void): () => void;
  onClose(handler?: () => void): void;
};
export type AccountAppServer = { rpc: AccountRpc; stop: (o?: { graceMs?: number }) => Promise<void> };

export type CodexAccountDeps = {
  /** 置き場の dir（null は既定の ~/.codex）で app-server を起こして initialize まで済ませる。 */
  launch: (dir: string | null) => Promise<AccountAppServer>;
  /** authUrl などをブラウザで開く。 */
  openUrl: (url: string) => void;
};

export function defaultOpenUrl(url: string): void {
  const c = openTargetCommand(url);
  try {
    const child = spawn(c.file, c.args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch { /* 開けなくても URL は状態に残る */ }
}

export function defaultLaunch(dir: string | null): Promise<AccountAppServer> {
  const bin = findCodex();
  if (!bin) return Promise.reject(new Error('codex was not found'));
  const env = codexBaseEnv(bin);
  if (dir) env.CODEX_HOME = dir;
  return launchCodexAppServer({ bin, env, directory: os.tmpdir() });
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function parseAccountRead(r: unknown): CodexAccountRead {
  const acct = isRec(r) && isRec(r.account) ? r.account : null;
  if (!acct) return { loggedIn: false, email: null, plan: null, chatgptAccountId: null };
  const routing = isRec(r) && isRec(r.workspaceRouting) ? r.workspaceRouting : null;
  return {
    loggedIn: true,
    email: strOrNull(acct.email),
    plan: strOrNull(acct.planType),
    chatgptAccountId: routing ? strOrNull(routing.chatgptAccountId) : null,
  };
}

type ActiveLogin = {
  accountId: string;
  app: AccountAppServer;
  loginId: string | null;
  off: () => void;
  finished: boolean;
};

export class CodexAccountService {
  private active: ActiveLogin | null = null;
  private readonly states = new Map<string, CodexLoginState>();
  private readonly subs = new Set<(e: CodexLoginEvent) => void>();

  constructor(private readonly deps: CodexAccountDeps) {}

  private async withApp<T>(dir: string | null, f: (rpc: AccountRpc) => Promise<T>): Promise<T> {
    const app = await this.deps.launch(dir);
    try {
      return await f(app.rpc);
    } finally {
      await app.stop().catch(() => undefined);
    }
  }

  readAccount(dir: string | null): Promise<CodexAccountRead> {
    return this.withApp(dir, async (rpc) => parseAccountRead(await rpc.request('account/read', { refreshToken: false })));
  }

  /** 使用量。未ログイン（認証が要る）なら null。 */
  readRateLimits(dir: string | null): Promise<AgentWindows | null> {
    return this.withApp(dir, async (rpc) => {
      try {
        const r = await rpc.request<{ rateLimits?: unknown }>('account/rateLimits/read');
        return codexRateLimitsOf(isRec(r) ? r.rateLimits : null);
      } catch (e) {
        if (e instanceof CodexRpcError && /authentication required/i.test(e.message)) return null;
        throw e;
      }
    });
  }

  loginState(accountId: string): CodexLoginState | null {
    return this.states.get(accountId) ?? null;
  }

  /** ログインの状態の変化を購読する。外す関数を返す。 */
  onLoginChange(handler: (e: CodexLoginEvent) => void): () => void {
    this.subs.add(handler);
    return () => this.subs.delete(handler);
  }

  private set(accountId: string, state: CodexLoginState): void {
    this.states.set(accountId, state);
    for (const h of [...this.subs]) h({ accountId, state });
  }

  private async finish(a: ActiveLogin): Promise<void> {
    if (a.finished) return;
    a.finished = true;
    a.off();
    if (this.active === a) this.active = null;
    await a.app.stop().catch(() => undefined);
  }

  /** ログインは hangar 全体で同時に 1 つ。前のものがあれば取り消してから始める。 */
  async startLogin(accountId: string, dir: string | null, method: CodexLoginMethod): Promise<CodexLoginState> {
    const prev = this.active;
    if (prev) {
      this.active = null;
      await this.cancelActive(prev, 'superseded');
    }
    this.set(accountId, { status: 'starting' });
    let app: AccountAppServer;
    try {
      app = await this.deps.launch(dir);
    } catch (e) {
      const s: CodexLoginState = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
      this.set(accountId, s);
      return s;
    }
    const a: ActiveLogin = { accountId, app, loginId: null, off: () => undefined, finished: false };
    this.active = a;
    a.off = app.rpc.onAny((n) => {
      if (n.method !== 'account/login/completed' || !isRec(n.params)) return;
      if (a.loginId && n.params.loginId !== a.loginId) return;
      if (a.finished) return;
      this.set(accountId, n.params.success === true ? { status: 'success' } : { status: 'failed', error: strOrNull(n.params.error) ?? 'login failed' });
      void this.finish(a);
    });
    app.rpc.onClose(() => {
      if (a.finished) return;
      this.set(accountId, { status: 'failed', error: 'app-server closed' });
      void this.finish(a);
    });
    try {
      if (method === 'browser') {
        const r = await app.rpc.request<{ loginId: string; authUrl: string }>('account/login/start', { type: 'chatgpt' });
        a.loginId = r.loginId;
        if (a.finished) return this.states.get(accountId) ?? { status: 'canceled' };
        this.set(accountId, { status: 'waiting', method: 'browser', loginId: r.loginId, authUrl: r.authUrl });
        this.deps.openUrl(r.authUrl);
      } else {
        const r = await app.rpc.request<{ loginId: string; userCode: string; verificationUrl: string }>('account/login/start', { type: 'chatgptDeviceCode' });
        a.loginId = r.loginId;
        if (a.finished) return this.states.get(accountId) ?? { status: 'canceled' };
        this.set(accountId, { status: 'waiting', method: 'deviceCode', loginId: r.loginId, userCode: r.userCode, verificationUrl: r.verificationUrl });
      }
    } catch (e) {
      if (!a.finished) this.set(accountId, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
      await this.finish(a);
    }
    return this.states.get(accountId) ?? { status: 'canceled' };
  }

  /** そのアカウントのログインを取り消す。進行中でなければ何もしない。 */
  async cancelLogin(accountId: string): Promise<void> {
    const a = this.active;
    if (!a || a.accountId !== accountId) return;
    this.active = null;
    await this.cancelActive(a, 'canceled');
  }

  private async cancelActive(a: ActiveLogin, as: 'canceled' | 'superseded'): Promise<void> {
    if (a.finished) return;
    this.set(a.accountId, { status: as });
    if (a.loginId) await a.app.rpc.request('account/login/cancel', { loginId: a.loginId }).catch(() => undefined);
    await this.finish(a);
  }
}

export const codexAccounts = new CodexAccountService({ launch: defaultLaunch, openUrl: defaultOpenUrl });

export const readCodexAccount = (dir: string | null, svc: CodexAccountService = codexAccounts): Promise<CodexAccountRead> => svc.readAccount(dir);
export const readCodexRateLimits = (dir: string | null, svc: CodexAccountService = codexAccounts): Promise<AgentWindows | null> => svc.readRateLimits(dir);
export const startCodexLogin = (accountId: string, dir: string | null, method: CodexLoginMethod, svc: CodexAccountService = codexAccounts): Promise<CodexLoginState> => svc.startLogin(accountId, dir, method);
export const cancelCodexLogin = (accountId: string, svc: CodexAccountService = codexAccounts): Promise<void> => svc.cancelLogin(accountId);
