import type { Context, Hono } from 'hono';
import type { AccountDirPreviewDto, AccountDto, AgentAccountsDto, UsageDto } from '@agent-hangar/shared';
import { AccountError, PRIMARY_ACCOUNT_ID, type Account, type AccountStore } from '../config/accounts.ts';
import { sessionAccounts } from '../db/queries.ts';
import { defaultLanguage } from '../i18n/language.ts';
import { causeOf, errorText, msg, render, type Message } from '../i18n/message.ts';
import { linkProblemMessage } from '../provider/claude-code/config/accountLinks.ts';
import type { CodexAccountService, CodexLoginMethod, CodexLoginState } from '../provider/codex/account.ts';
import type { CodexAccountAuth } from '../provider/codex/accountAuth.ts';
import { ensureCodexAccountLinks, inspectCodexAccountLinks } from '../provider/codex/config/accountLinks.ts';
import type { AccountsDeps } from './accounts.ts';

/** Codex のアカウントの口が頼るもの。設定の codexEnabled が切の間は、DTO にも口にも出さない。 */
export type CodexAccountsDeps = {
  store: AccountStore;
  /** 最初のアカウントの置き場（~/.codex）。 */
  primaryDir: string;
  auth: CodexAccountAuth;
  service: CodexAccountService;
  enabled: () => boolean;
};

type LinkProblem = Message | string | null;

/** ログインの方法と、最後に始めたアカウント。状態そのものは service が持ち、ここは画面に見せる形に直すのに要る分だけ覚える。 */
type LoginMemo = { methods: Map<string, CodexLoginMethod>; latest: string | null };
const loginMemos = new WeakMap<AccountStore, LoginMemo>();
const loginMemoOf = (store: AccountStore): LoginMemo => {
  let m = loginMemos.get(store);
  if (!m) { m = { methods: new Map(), latest: null }; loginMemos.set(store, m); }
  return m;
};
const linkProblems = new WeakMap<AccountStore, Map<string, LinkProblem>>();
const problemMemoOf = (store: AccountStore): Map<string, LinkProblem> => {
  let m = linkProblems.get(store);
  if (!m) { m = new Map(); linkProblems.set(store, m); }
  return m;
};

function problemOf(c: CodexAccountsDeps, a: Account): LinkProblem {
  if (a.id === PRIMARY_ACCOUNT_ID) return null;
  try { const r = ensureCodexAccountLinks(c.primaryDir, a.dir); return linkProblemMessage(r.conflicts, r.unlinked); } catch (e) { return causeOf(e); }
}
const checkLinks = (c: CodexAccountsDeps): void => { for (const a of c.store.list()) problemMemoOf(c.store).set(a.id, problemOf(c, a)); };

/** 進行中（starting、waiting）か。 */
const running = (s: CodexLoginState | null): boolean => s !== null && (s.status === 'starting' || s.status === 'waiting');

/** service の状態を、AccountDto.login の形にする。進行中と、後から始めたログインに取り消されたものだけ持つ。 */
function loginDtoOf(c: CodexAccountsDeps, a: Account): AccountDto['login'] | undefined {
  const s = c.service.loginState(a.id);
  if (!s) return undefined;
  const memo = loginMemoOf(c.store);
  const method: CodexLoginMethod = s.status === 'waiting' ? s.method : memo.methods.get(a.id) ?? 'browser';
  if (s.status === 'starting') return { method };
  if (s.status === 'waiting') {
    return s.method === 'deviceCode' ? { method, userCode: s.userCode, verificationUrl: s.verificationUrl } : { method };
  }
  if (s.status === 'superseded') {
    const by = memo.latest && memo.latest !== a.id ? c.store.get(memo.latest)?.name : undefined;
    return by ? { method, cancelledBy: by } : { method, cancelledBy: '' };
  }
  return undefined;
}

const usageOf = (deps: AccountsDeps, id: string): UsageDto => {
  const u = deps.agentUsage?.of('codex', id);
  return u ? { fiveHour: u.fiveHour, sevenDay: u.sevenDay, updatedAt: u.updatedAt } : { fiveHour: null, sevenDay: null, updatedAt: null };
};

/**
 * AccountsDto.codex に載せる組。codexEnabled が切、または Codex の store が無ければ undefined（項目ごと付けない）。
 * checkLinks が真のときだけ、リンクを点検して張り直す（Claude 側と同じ）。
 */
export function buildCodexAccountsDto(deps: AccountsDeps, opts: { checkLinks?: boolean } = {}): AgentAccountsDto | undefined {
  const c = deps.codex;
  if (!c || !c.enabled()) return undefined;
  const list = c.store.list();
  const known = new Set(list.map((a) => a.id));
  const memo = problemMemoOf(c.store);
  for (const id of [...memo.keys()]) if (!known.has(id)) memo.delete(id);
  if (opts.checkLinks) checkLinks(c);
  const language = (deps.language ?? defaultLanguage)();
  const problemText = (p: LinkProblem): string | null => (p !== null && typeof p === 'object' ? render(language, p) : p);
  const sessions: Record<string, string> = {};
  for (const [sid, aid] of Object.entries(sessionAccounts(deps.db, deps.deviceId))) if (known.has(aid)) sessions[sid] = aid;
  return {
    currentId: c.store.current().id,
    accounts: list.map((a): AccountDto => {
      const login = loginDtoOf(c, a);
      return {
        ...a, primary: a.id === PRIMARY_ACCOUNT_ID, auth: c.auth.get(a.id), usage: usageOf(deps, a.id),
        loginRunning: running(c.service.loginState(a.id)), linkProblem: problemText(memo.get(a.id) ?? null),
        ...(login ? { login } : {}),
      };
    }),
    sessions,
  };
}

const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const v: unknown = await c.req.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
};

/** /codex/accounts 系の口。Claude の accountsRoutes と同じ形で、認証とログインは Codex の app-server に頼む。changed は DTO を作って配る関数（accounts.ts が渡す）。 */
export function codexAccountsRoutes(api: Hono, deps: AccountsDeps, changed: (checkLinks?: boolean) => unknown): void {
  const language = deps.language ?? defaultLanguage;
  const guard = async (c: Context, fn: (cx: CodexAccountsDeps) => Promise<Response> | Response): Promise<Response> => {
    try {
      const cx = deps.codex;
      if (!cx || !cx.enabled()) return c.json({ error: render(language(), msg('account.error.notFound')) }, 404);
      return await fn(cx);
    } catch (e) {
      if (e instanceof AccountError) return c.json({ error: errorText(language(), e) }, e.status);
      throw e;
    }
  };
  const must = (cx: CodexAccountsDeps, id: string): Account => {
    const a = cx.store.get(id);
    if (!a) throw new AccountError(404, msg('account.error.notFound'));
    return a;
  };

  api.get('/codex/accounts', (c) => guard(c, (cx) => {
    for (const a of cx.store.list()) cx.auth.ensureChecked(a);
    return c.json(buildCodexAccountsDto(deps, { checkLinks: true }));
  }));

  api.get('/codex/accounts/preview', (c) => guard(c, (cx) => {
    const name = c.req.query('name') ?? '';
    const input = c.req.query('dir') ?? '';
    const suggested = input.trim() === '';
    const dir = suggested ? cx.store.suggestDir(name) : cx.store.resolveDir(input);
    const { exists, conflicts } = inspectCodexAccountLinks(cx.primaryDir, dir);
    const body: AccountDirPreviewDto = { name, input, dir, suggested, exists, conflicts, registeredAs: cx.store.byDir(dir)?.name ?? null };
    return c.json(body);
  }));

  api.post('/codex/accounts', (c) => guard(c, async (cx) => {
    const b = await bodyOf(c);
    if (typeof b.name !== 'string' || (b.dir !== undefined && typeof b.dir !== 'string')) throw new AccountError(400, msg('account.request.nameAndDir'));
    const a = cx.store.add({ name: b.name, dir: typeof b.dir === 'string' ? cx.store.resolveDir(b.dir) : undefined });
    checkLinks(cx);
    await cx.auth.refresh(a);
    return c.json(changed(), 201);
  }));

  api.put('/codex/accounts/current', (c) => guard(c, async (cx) => {
    const b = await bodyOf(c);
    if (typeof b.id !== 'string') throw new AccountError(400, msg('common.field.send', { field: 'id' }));
    cx.store.setCurrent(b.id);
    return c.json(changed());
  }));

  api.patch('/codex/accounts/:id', (c) => guard(c, async (cx) => {
    const b = await bodyOf(c);
    const patch: { name?: string; color?: string } = {};
    if (b.name !== undefined) { if (typeof b.name !== 'string') throw new AccountError(400, msg('common.field.sendString', { field: 'name' })); patch.name = b.name; }
    if (b.color !== undefined) { if (typeof b.color !== 'string') throw new AccountError(400, msg('common.field.sendString', { field: 'color' })); patch.color = b.color; }
    cx.store.update(c.req.param('id'), patch);
    return c.json(changed());
  }));

  api.delete('/codex/accounts/:id', (c) => guard(c, async (cx) => {
    const id = c.req.param('id');
    if (id !== PRIMARY_ACCOUNT_ID) await cx.service.cancelLogin(id);
    cx.store.remove(id);
    cx.auth.forget(id);
    return c.json(changed());
  }));

  api.post('/codex/accounts/:id/login', (c) => guard(c, async (cx) => {
    const a = must(cx, c.req.param('id'));
    const b = await bodyOf(c);
    if (b.method !== undefined && b.method !== 'browser' && b.method !== 'deviceCode') throw new AccountError(400, msg('common.field.sendString', { field: 'method' }));
    const method: CodexLoginMethod = b.method === 'deviceCode' ? 'deviceCode' : 'browser';
    try {
      const r = a.id === PRIMARY_ACCOUNT_ID ? null : ensureCodexAccountLinks(cx.primaryDir, a.dir);
      const problem = r ? linkProblemMessage(r.conflicts) : null;
      if (problem) throw new AccountError(400, problem);
    } catch (e) { if (e instanceof AccountError) throw e; throw new AccountError(400, causeOf(e)); }
    const memo = loginMemoOf(cx.store);
    memo.methods.set(a.id, method);
    memo.latest = a.id;
    // 最初のアカウントの置き場は CODEX_HOME を渡さない（null）。
    const state = await cx.service.startLogin(a.id, a.id === PRIMARY_ACCOUNT_ID ? null : a.dir, method);
    if (state.status === 'failed') return c.json({ error: state.error }, 400);
    return c.json(changed(true), 202);
  }));

  api.post('/codex/accounts/:id/login/cancel', (c) => guard(c, async (cx) => {
    await cx.service.cancelLogin(must(cx, c.req.param('id')).id);
    return c.json(changed());
  }));

  api.post('/codex/accounts/:id/refresh', (c) => guard(c, async (cx) => {
    await cx.auth.refresh(must(cx, c.req.param('id')));
    return c.json(changed());
  }));
}
