import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountsDto, AgentAccountsDto } from '@agent-hangar/shared';
import { AccountAuth, type RunClaude } from '../provider/claude-code/config/accountAuth.ts';
import { AccountStore } from '../config/accounts.ts';
import { openDb, type Db } from '../db/open.ts';
import { CodexAccountService, type AccountAppServer, type AccountRpc } from '../provider/codex/account.ts';
import { CodexAccountAuth } from '../provider/codex/accountAuth.ts';
import { AgentUsageTracker } from '../usage/agentUsage.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { accountsRoutes, buildAccountsDto, type AccountsDeps } from './accounts.ts';

const run: RunClaude = async () => ({ code: 0, stdout: '{}' });
type Json = AccountsDto & AgentAccountsDto & { error?: string };

/** 偽の app-server。ログインは account/login/start に答えるだけで、自分では終わらない。 */
function fakeLaunch(opts: { read?: unknown } = {}) {
  const launched: (string | null)[] = [];
  const launch = async (dir: string | null): Promise<AccountAppServer> => {
    launched.push(dir);
    const rpc: AccountRpc = {
      async request(method: string) {
        if (method === 'account/read') return (opts.read ?? { account: { email: 'a@example.com', planType: 'plus' }, workspaceRouting: { chatgptAccountId: 'cg-1' } }) as never;
        if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: 4_000_000_000 }, planType: 'plus' } } as never;
        if (method === 'account/login/start') return { loginId: `L${launched.length}`, authUrl: `https://auth.example/${launched.length}` } as never;
        return {} as never;
      },
      onAny: () => () => undefined,
      onClose: () => undefined,
    };
    return { rpc, stop: async () => undefined };
  };
  return { launch, launched };
}

describe('Codex のアカウントの口と DTO', () => {
  let db: Db;
  let home: string;
  let userHome: string;
  let claudeDir: string;
  let codexDir: string;
  let enabled: boolean;
  let app: Hono;
  let sent: AccountsDto[];
  let deps: AccountsDeps;
  let launched: (string | null)[];
  let service: CodexAccountService;
  let agentUsage: AgentUsageTracker;
  let switchAccount: ReturnType<typeof vi.fn>;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Json };
  };

  beforeEach(() => {
    db = openDb(':memory:');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxa-home-'));
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxa-user-'));
    claudeDir = path.join(userHome, '.claude');
    codexDir = path.join(userHome, '.codex');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(path.join(codexDir, 'skills'), { recursive: true });
    enabled = true;
    sent = [];
    const fl = fakeLaunch();
    launched = fl.launched;
    service = new CodexAccountService({ launch: fl.launch, openUrl: () => undefined });
    agentUsage = new AgentUsageTracker();
    const codexStore = new AccountStore({ home, primaryDir: codexDir, homeDir: userHome, file: 'codex-accounts.json', dirPrefix: '.codex-' });
    switchAccount = vi.fn(async (sessionId: string) => ({ sessionId, run: { id: 'r9' }, tabs: [] }));
    deps = {
      db, store: new AccountStore({ home, primaryDir: claudeDir, homeDir: userHome }), primaryDir: claudeDir,
      auth: new AccountAuth({ claudeBin: () => '/bin/claude', run }),
      usage: new UsageTracker(db, { accountOf: () => 'primary' }),
      agentUsage,
      runs: { switchAccount } as unknown as AccountsDeps['runs'],
      broadcast: (a) => sent.push(a),
      codex: { store: codexStore, primaryDir: codexDir, auth: new CodexAccountAuth({ service, usage: agentUsage }), service, enabled: () => enabled },
    };
    app = new Hono();
    accountsRoutes(app, deps);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  it('A10: codexEnabled が切なら DTO に codex が無く、口は 404', async () => {
    enabled = false;
    expect(buildAccountsDto(deps).codex).toBeUndefined();
    expect('codex' in buildAccountsDto(deps)).toBe(false);
    expect((await call('GET', '/codex/accounts')).status).toBe(404);
    expect((await call('POST', '/codex/accounts/primary/login')).status).toBe(404);
    enabled = true;
    expect(buildAccountsDto(deps).codex?.accounts.map((a) => a.id)).toEqual(['primary']);
  });

  it('GET は最初のアカウントを dir null で読み、認証と使用量を載せる。agents はいまの Codex アカウントの枠', async () => {
    const first = await call('GET', '/codex/accounts');
    expect(first.status).toBe(200);
    expect(first.json.currentId).toBe('primary');
    expect(first.json.accounts[0]?.auth).toBeNull();
    await vi.waitFor(() => expect(deps.codex?.auth.get('primary')?.loggedIn).toBe(true));
    await vi.waitFor(() => expect(agentUsage.of('codex', 'primary')).not.toBeNull());
    expect(launched[0]).toBeNull();
    const dto = buildAccountsDto(deps);
    const a = dto.codex?.accounts[0];
    expect(a?.auth).toMatchObject({ loggedIn: true, email: 'a@example.com', plan: 'plus', orgName: null });
    expect(a?.usage.fiveHour?.usedPercent).toBe(9);
    expect(dto.agents?.codex?.fiveHour?.usedPercent).toBe(9);
    // 読むのは 1 度だけ（開き直しても、読んだものは読まない）。
    const n = launched.length;
    await call('GET', '/codex/accounts');
    expect(launched.length).toBe(n);
  });

  it('足す・いまのアカウント・名前の変更・外す。変わるたびに accounts.update を配る', async () => {
    const added = await call('POST', '/codex/accounts', { name: 'Work' });
    expect(added.status).toBe(201);
    const w = added.json.codex?.accounts.find((a) => a.name === 'Work');
    expect(w?.dir).toBe(path.join(userHome, '.codex-2'));
    // 置き場を作って、最初の置き場の項目へリンクが張られる。
    expect(fs.lstatSync(path.join(w!.dir, 'skills')).isSymbolicLink()).toBe(true);
    const sentBefore = sent.length;
    expect((await call('PUT', '/codex/accounts/current', { id: w!.id })).json.codex?.currentId).toBe(w!.id);
    expect(deps.codex?.store.current().id).toBe(w!.id);
    // Claude 側のいまのアカウントは変わらない。
    expect(deps.store.current().id).toBe('primary');
    expect((await call('PATCH', `/codex/accounts/${w!.id}`, { name: 'Job' })).json.codex?.accounts.some((a) => a.name === 'Job')).toBe(true);
    expect((await call('DELETE', `/codex/accounts/${w!.id}`)).json.codex?.accounts.map((a) => a.id)).toEqual(['primary']);
    expect(sent.length).toBeGreaterThan(sentBefore);
    expect((await call('GET', '/codex/accounts/preview?name=Foo')).json).toMatchObject({ dir: path.join(userHome, '.codex-foo'), suggested: true });
  });

  it('A5: ログインを 2 つ続けると、1 つ目が取り消し（cancelledBy 付き）の状態で DTO に出る', async () => {
    const w = (await call('POST', '/codex/accounts', { name: 'Work' })).json.codex!.accounts.find((a) => a.name === 'Work')!;
    launched.length = 0;
    expect((await call('POST', '/codex/accounts/primary/login', { method: 'browser' })).status).toBe(202);
    const afterFirst = buildAccountsDto(deps).codex!.accounts;
    expect(afterFirst.find((a) => a.id === 'primary')).toMatchObject({ loginRunning: true, login: { method: 'browser' } });
    // 最初のアカウントは CODEX_HOME を渡さない。
    expect(launched).toEqual([null]);
    expect((await call('POST', `/codex/accounts/${w.id}/login`, { method: 'deviceCode' })).status).toBe(202);
    expect(launched[1]).toBe(w.dir);
    const accts = buildAccountsDto(deps).codex!.accounts;
    const p = accts.find((a) => a.id === 'primary')!;
    expect(p.loginRunning).toBe(false);
    expect(p.login).toMatchObject({ method: 'browser', cancelledBy: 'Work' });
    expect(accts.find((a) => a.id === w.id)).toMatchObject({ loginRunning: true, login: { method: 'deviceCode' } });
    // 取り消すと、そのアカウントの札は消える。
    const cancelled = await call('POST', `/codex/accounts/${w.id}/login/cancel`);
    expect(cancelled.json.codex?.accounts.find((a) => a.id === w.id)?.login).toBeUndefined();
  });

  it('Codex の 2 つ目のアカウントで起こした会話は sessions に載り、メインへ付け替えたら外れる（無ければメインと読む）', async () => {
    const w = (await call('POST', '/codex/accounts', { name: 'Work' })).json.codex!.accounts.find((a) => a.name === 'Work')!;
    db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, origin_device, updated_at) values ('s-cx','codex','t1','/w','d','d',1)").run();
    const addRun = (id: string, at: number, params: unknown) =>
      db.prepare("insert into runs (id, session_id, device_id, kind, tmux_name, launch_params, pid, started_at, ended_at, end_reason, heartbeat_at, updated_at, origin_device) values (?, 's-cx', 'd', 'start', 'h', ?, null, ?, null, null, 1, 1, 'd')").run(id, JSON.stringify(params), at);
    addRun('r1', 1, { scratch: true, agent: 'codex', account: w.id });
    expect(buildAccountsDto(deps).codex?.sessions).toEqual({ 's-cx': w.id });
    addRun('r2', 2, { agent: 'codex', account: 'primary' });
    expect(buildAccountsDto(deps).codex?.sessions).toEqual({});
  });

  it('ログインの method が不正なら 400', async () => {
    expect((await call('POST', '/codex/accounts/primary/login', { method: 'carrier-pigeon' })).status).toBe(400);
  });

  it('Codex の会話の switch-account は Claude のいまのアカウントを変えない', async () => {
    const w = (await call('POST', '/codex/accounts', { name: 'Work' })).json.codex!.accounts.find((a) => a.name === 'Work')!;
    const claudeStore = deps.store;
    const claude = claudeStore.add({ name: 'C2' });
    db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, origin_device, updated_at) values ('s-cx','codex','t1','/w','d','d',1)").run();
    db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, origin_device, updated_at) values ('s-cl','claude-code','t2','/w','d','d',1)").run();
    expect((await call('POST', '/sessions/s-cx/switch-account', { account: w.id })).status).toBe(201);
    expect(claudeStore.current().id).toBe('primary');
    expect((await call('POST', '/sessions/s-cl/switch-account', { account: claude.id })).status).toBe(201);
    expect(claudeStore.current().id).toBe(claude.id);
  });
});
