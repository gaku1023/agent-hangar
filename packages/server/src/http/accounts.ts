import type { Context, Hono } from 'hono';
import type { AccountsDto } from '@agent-hangar/shared';
import type { AccountAuth } from '../config/accountAuth.ts';
import { ensureAccountLinks, linkProblemMessage } from '../config/accountLinks.ts';
import { AccountError, PRIMARY_ACCOUNT_ID, type Account, type AccountStore } from '../config/accounts.ts';
import type { Db } from '../db/open.ts';
import { defaultLanguage, type GetLanguage } from '../i18n/language.ts';
import { causeOf, errorText, msg, render, translatorOf, type Message } from '../i18n/message.ts';
import { sessionAccounts } from '../db/queries.ts';
import { RunError, type RunManager } from '../runs/manager.ts';
import type { UsageTracker } from '../usage/statusline.ts';

export type AccountsDeps = { db: Db; store: AccountStore; auth: AccountAuth; usage: UsageTracker; runs: Pick<RunManager, 'switchAccount'>; primaryDir: string; broadcast: (accounts: AccountsDto) => void;
  /** 起動の前に待つこと（他端末の変更の取り込み）。resume と同じ扱いにするため、app.ts が渡す。 */
  beforeLaunch?: () => Promise<unknown>;
  /** 応答の文の言語。app.ts が渡す。渡さなければ日本語で出す。 */
  language?: GetLanguage };

/** リンクの問題。辞書の文か、OS が返した失敗の文である。 */
type LinkProblem = Message | string | null;

/** 置き場のリンクの具合。欠けているリンクはここで張り直し、別のものが置かれている項目だけを問題として返す。 */
function problemOf(primaryDir: string, a: Account): LinkProblem {
  if (a.id === PRIMARY_ACCOUNT_ID) return null;
  try { return linkProblemMessage(ensureAccountLinks(primaryDir, a.dir).conflicts); } catch (e) { return causeOf(e); }
}

/** アカウントの id ごとの、最後に点検したリンクの結果。AccountsDeps は app.ts で写されるので、共有の AccountStore に結ぶ。文にするのは配るときなので、言語を変えたあとも点検し直さずに済む。 */
const linkProblems = new WeakMap<AccountStore, Map<string, LinkProblem>>();
const memoOf = (store: AccountStore): Map<string, LinkProblem> => {
  let m = linkProblems.get(store);
  if (!m) { m = new Map(); linkProblems.set(store, m); }
  return m;
};
/** 全アカウントのリンクを点検して張り直し、結果を覚える。 */
const checkLinks = (deps: AccountsDeps): void => { for (const a of deps.store.list()) memoOf(deps.store).set(a.id, problemOf(deps.primaryDir, a)); };

/**
 * checkLinks が真のときだけ、リンクを点検して張り直す（fs を読み書きする）。
 * statusline・認証の変化・起動からの配信は偽のまま、最後に点検した結果を使い回す。点検していないアカウントは null。
 */
export function buildAccountsDto(deps: AccountsDeps, opts: { checkLinks?: boolean } = {}): AccountsDto {
  const list = deps.store.list();
  const known = new Set(list.map((a) => a.id));
  const memo = memoOf(deps.store);
  for (const id of [...memo.keys()]) if (!known.has(id)) memo.delete(id);
  if (opts.checkLinks) checkLinks(deps);
  const language = (deps.language ?? defaultLanguage)();
  const problemText = (p: LinkProblem): string | null => (p !== null && typeof p === 'object' ? render(language, p) : p);
  const sessions: Record<string, string> = {};
  for (const [sid, aid] of Object.entries(sessionAccounts(deps.db))) if (known.has(aid)) sessions[sid] = aid;
  return {
    currentId: deps.store.current().id,
    accounts: list.map((a) => ({
      ...a, primary: a.id === PRIMARY_ACCOUNT_ID, auth: deps.auth.get(a.id), usage: deps.usage.of(a.id), loginRunning: deps.auth.loginRunning(a.id), linkProblem: problemText(memo.get(a.id) ?? null),
    })),
    sessions,
  };
}

/** セッションが起動したとき（新規・再開・フォーク・ターミナルから）に accounts.update を配る。新しい run のアカウントが sessions に載るため。リンクは点検しない。 */
export function announceAccountsOnRunStarted(runs: Pick<RunManager, 'on'>, deps: AccountsDeps): () => void {
  return runs.on({ runStarted: () => deps.broadcast(buildAccountsDto(deps)) });
}

const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const v: unknown = await c.req.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
};

export function accountsRoutes(api: Hono, deps: AccountsDeps): void {
  const language = deps.language ?? defaultLanguage;
  const tr = translatorOf(language);
  const changed = (checkLinks = false) => { const d = buildAccountsDto(deps, { checkLinks }); deps.broadcast(d); return d; };
  /** AccountError と RunError を、その状態の JSON にして返す。 */
  const guard = async (c: Context, fn: () => Promise<Response> | Response): Promise<Response> => {
    try { return await fn(); } catch (e) {
      if (e instanceof AccountError || e instanceof RunError) return c.json({ error: errorText(language(), e) }, e.status);
      throw e;
    }
  };
  const must = (id: string): Account => {
    const a = deps.store.get(id);
    if (!a) throw new AccountError(404, msg('account.error.notFound'));
    return a;
  };

  api.get('/accounts', (c) => {
    // まだ読んでいない認証は裏で読み、終わったら accounts.update で届く。応答は待たない。
    for (const a of deps.store.list()) deps.auth.ensureChecked(a);
    return c.json(buildAccountsDto(deps, { checkLinks: true }));
  });

  api.post('/accounts', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    if (typeof b.name !== 'string' || (b.dir !== undefined && typeof b.dir !== 'string')) throw new AccountError(400, msg('account.request.nameAndDir'));
    const a = deps.store.add({ name: b.name, dir: b.dir as string | undefined });
    // 置き場とリンクはここで作る（点検と同じ）。リンクの場所に別のものがあっても、作れなくても、登録は通し、linkProblem として見せる。
    checkLinks(deps);
    await deps.auth.refresh(a);
    return c.json(changed(), 201);
  }));

  api.put('/accounts/current', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    if (typeof b.id !== 'string') throw new AccountError(400, msg('common.field.send', { field: 'id' }));
    deps.store.setCurrent(b.id);
    return c.json(changed());
  }));

  api.patch('/accounts/:id', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    const patch: { name?: string; color?: string } = {};
    if (b.name !== undefined) { if (typeof b.name !== 'string') throw new AccountError(400, msg('common.field.sendString', { field: 'name' })); patch.name = b.name; }
    if (b.color !== undefined) { if (typeof b.color !== 'string') throw new AccountError(400, msg('common.field.sendString', { field: 'color' })); patch.color = b.color; }
    deps.store.update(c.req.param('id'), patch);
    return c.json(changed());
  }));

  api.delete('/accounts/:id', (c) => guard(c, () => {
    const id = c.req.param('id');
    // ログインの途中なら、外す前に子プロセスを止める（外したあとも claude が待ち続けないように）。最初のアカウントは外せないので触らない。
    if (id !== PRIMARY_ACCOUNT_ID) deps.auth.cancelLogin(id);
    deps.store.remove(id);
    deps.auth.forget(id);
    return c.json(changed());
  }));

  api.post('/accounts/:id/login', (c) => guard(c, () => {
    const a = must(c.req.param('id'));
    try { ensureAccountLinks(deps.primaryDir, a.dir); } catch (e) { throw new AccountError(400, causeOf(e)); }
    const started = deps.auth.login(a);
    if (started === 'no-claude') throw new AccountError(400, msg('run.launch.claudeMissing', { label: msg('settings.label.claudePath') }));
    if (started === 'running') return c.json({ error: tr('account.login.alreadyRunning') }, 409);
    return c.json(changed(true), 202);
  }));

  api.post('/accounts/:id/login/cancel', (c) => guard(c, () => {
    deps.auth.cancelLogin(must(c.req.param('id')).id);
    return c.json(changed());
  }));

  api.post('/accounts/:id/refresh', (c) => guard(c, async () => {
    await deps.auth.refresh(must(c.req.param('id')));
    return c.json(changed());
  }));

  api.post('/sessions/:id/switch-account', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    if (typeof b.account !== 'string') throw new AccountError(400, msg('common.field.send', { field: 'account' }));
    await deps.beforeLaunch?.();
    const result = await deps.runs.switchAccount(c.req.param('id'), b.account);
    // セッション画面で選んだら、新しいセッションの既定もそのアカウントにする（設計書の決定）。
    deps.store.setCurrent(b.account);
    changed();
    return c.json(result as object, 201);
  }));
}
