import type { Context, Hono } from 'hono';
import type { AccountsDto } from '@agent-hangar/shared';
import type { AccountAuth } from '../config/accountAuth.ts';
import { ensureAccountLinks, linkProblem } from '../config/accountLinks.ts';
import { AccountError, PRIMARY_ACCOUNT_ID, type Account, type AccountStore } from '../config/accounts.ts';
import type { Db } from '../db/open.ts';
import { sessionAccounts } from '../db/queries.ts';
import { RunError, type RunManager } from '../runs/manager.ts';
import type { UsageTracker } from '../usage/statusline.ts';

export type AccountsDeps = { db: Db; store: AccountStore; auth: AccountAuth; usage: UsageTracker; runs: Pick<RunManager, 'switchAccount'>; primaryDir: string; broadcast: (accounts: AccountsDto) => void };

/** 置き場のリンクの具合。欠けているリンクはここで張り直し、別のものが置かれている項目だけを問題として返す。 */
function problemOf(primaryDir: string, a: Account): string | null {
  if (a.id === PRIMARY_ACCOUNT_ID) return null;
  try { return linkProblem(ensureAccountLinks(primaryDir, a.dir).conflicts); } catch (e) { return e instanceof Error ? e.message : String(e); }
}

export function buildAccountsDto(deps: AccountsDeps): AccountsDto {
  const known = new Set(deps.store.list().map((a) => a.id));
  const sessions: Record<string, string> = {};
  for (const [sid, aid] of Object.entries(sessionAccounts(deps.db))) if (known.has(aid)) sessions[sid] = aid;
  return {
    currentId: deps.store.current().id,
    accounts: deps.store.list().map((a) => ({
      ...a, primary: a.id === PRIMARY_ACCOUNT_ID, auth: deps.auth.get(a.id), usage: deps.usage.of(a.id), loginRunning: deps.auth.loginRunning(a.id), linkProblem: problemOf(deps.primaryDir, a),
    })),
    sessions,
  };
}

const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const v: unknown = await c.req.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
};

export function accountsRoutes(api: Hono, deps: AccountsDeps): void {
  const dto = () => buildAccountsDto(deps);
  const changed = () => { const d = dto(); deps.broadcast(d); return d; };
  /** AccountError と RunError を、その状態の JSON にして返す。 */
  const guard = async (c: Context, fn: () => Promise<Response> | Response): Promise<Response> => {
    try { return await fn(); } catch (e) {
      if (e instanceof AccountError || e instanceof RunError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };
  const must = (id: string): Account => {
    const a = deps.store.get(id);
    if (!a) throw new AccountError(404, 'アカウントが見つかりません');
    return a;
  };

  api.get('/accounts', (c) => c.json(dto()));

  api.post('/accounts', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    if (typeof b.name !== 'string' || (b.dir !== undefined && typeof b.dir !== 'string')) throw new AccountError(400, 'name（文字列）と、任意で dir（絶対パス）を送ってください');
    const a = deps.store.add({ name: b.name, dir: b.dir as string | undefined });
    // 置き場とリンクはここで作る。リンクの場所に別のものがあっても登録は通し、linkProblem として見せる。
    ensureAccountLinks(deps.primaryDir, a.dir);
    await deps.auth.refresh(a);
    return c.json(changed(), 201);
  }));

  api.put('/accounts/current', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    if (typeof b.id !== 'string') throw new AccountError(400, 'id を送ってください');
    deps.store.setCurrent(b.id);
    return c.json(changed());
  }));

  api.patch('/accounts/:id', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    const patch: { name?: string; color?: string } = {};
    if (b.name !== undefined) { if (typeof b.name !== 'string') throw new AccountError(400, 'name は文字列で送ってください'); patch.name = b.name; }
    if (b.color !== undefined) { if (typeof b.color !== 'string') throw new AccountError(400, 'color は文字列で送ってください'); patch.color = b.color; }
    deps.store.update(c.req.param('id'), patch);
    return c.json(changed());
  }));

  api.delete('/accounts/:id', (c) => guard(c, () => {
    const id = c.req.param('id');
    deps.store.remove(id);
    deps.auth.forget(id);
    return c.json(changed());
  }));

  api.post('/accounts/:id/login', (c) => guard(c, () => {
    const a = must(c.req.param('id'));
    ensureAccountLinks(deps.primaryDir, a.dir);
    deps.auth.login(a);
    return c.json(changed(), 202);
  }));

  api.post('/accounts/:id/refresh', (c) => guard(c, async () => {
    await deps.auth.refresh(must(c.req.param('id')));
    return c.json(changed());
  }));

  api.post('/sessions/:id/switch-account', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    if (typeof b.account !== 'string') throw new AccountError(400, 'account を送ってください');
    const result = await deps.runs.switchAccount(c.req.param('id'), b.account);
    // セッション画面で選んだら、新しいセッションの既定もそのアカウントにする（設計書の決定）。
    deps.store.setCurrent(b.account);
    changed();
    return c.json(result as object, 201);
  }));
}
