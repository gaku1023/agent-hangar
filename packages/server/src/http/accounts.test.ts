import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountsDto } from '@agent-hangar/shared';
import { AccountAuth, type RunClaude } from '../config/accountAuth.ts';
import { AccountStore } from '../config/accounts.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { RunError, type RunListener } from '../runs/manager.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { accountsRoutes, announceAccountsOnRunStarted, buildAccountsDto, type AccountsDeps } from './accounts.ts';

let db: Db;
let home: string;
let userHome: string;
let primaryDir: string;
let store: AccountStore;
let app: Hono;
let sent: AccountsDto[];
let switchAccount: ReturnType<typeof vi.fn>;
let order: string[];
let deps: AccountsDeps;
let ensureChecked: ReturnType<typeof vi.spyOn>;
const OK = JSON.stringify({ loggedIn: true, email: 'taro@example.ac.jp', orgName: 'Example University', subscriptionType: 'enterprise' });
const run: RunClaude = async (_b, args) => ({ code: 0, stdout: args[1] === 'status' ? OK : '' });
const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as AccountsDto & { error?: string } };
};

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ah-home-'));
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ah-user-'));
  primaryDir = path.join(userHome, '.claude');
  fs.mkdirSync(path.join(primaryDir, 'projects'), { recursive: true });
  store = new AccountStore({ home, primaryDir, homeDir: userHome });
  sent = [];
  order = [];
  switchAccount = vi.fn(async (sessionId: string) => { order.push('switch'); return { sessionId, run: { id: 'r9' }, tabs: [] }; });
  const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run });
  ensureChecked = vi.spyOn(auth, 'ensureChecked');
  deps = {
    db, store, primaryDir,
    auth,
    beforeLaunch: async () => { order.push('before'); },
    usage: new UsageTracker(db, { accountOf: () => 'primary' }),
    runs: { switchAccount } as unknown as AccountsDeps['runs'],
    broadcast: (a) => sent.push(a),
  };
  app = new Hono();
  accountsRoutes(app, deps);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(userHome, { recursive: true, force: true });
});

describe('アカウントの HTTP', () => {
  it('はじめは最初のアカウントだけ', async () => {
    const r = await call('GET', '/accounts');
    expect(r.status).toBe(200);
    expect(r.json.currentId).toBe('primary');
    expect(r.json.accounts).toHaveLength(1);
    expect(r.json.accounts[0]).toMatchObject({ id: 'primary', primary: true, dir: primaryDir, loginRunning: false, linkProblem: null });
    expect(r.json.sessions).toEqual({});
  });

  it('追加すると置き場を作ってリンクを張り、認証を読み、配る', async () => {
    const r = await call('POST', '/accounts', { name: '大学' });
    expect(r.status).toBe(201);
    const a = r.json.accounts[1]!;
    expect(a).toMatchObject({ name: '大学', primary: false, dir: path.join(userHome, '.claude-2'), linkProblem: null });
    expect(fs.readlinkSync(path.join(a.dir, 'projects'))).toBe(path.join(primaryDir, 'projects'));
    expect(a.auth).toMatchObject({ loggedIn: true, email: 'taro@example.ac.jp', plan: 'enterprise' });
    expect(sent.at(-1)?.accounts).toHaveLength(2);
  });

  it('既にある置き場を登録するとき、リンクの場所に実物があれば linkProblem に出す（登録は通す）', async () => {
    const dir = path.join(userHome, '.claude-univ');
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    const r = await call('POST', '/accounts', { name: '大学', dir });
    expect(r.status).toBe(201);
    expect(r.json.accounts[1]!.linkProblem).toContain('projects');
  });

  it('名前の重複と形の違う本文は 400、知らない id は 404', async () => {
    await call('POST', '/accounts', { name: '大学' });
    expect((await call('POST', '/accounts', { name: '大学' })).status).toBe(400);
    expect((await call('POST', '/accounts', { name: 5 })).status).toBe(400);
    expect((await call('PATCH', '/accounts/nope', { name: 'x' })).status).toBe(404);
    expect((await call('PUT', '/accounts/current', { id: 'nope' })).status).toBe(404);
    expect((await call('DELETE', '/accounts/primary')).status).toBe(400);
  });

  it('いまのアカウントを変え、名前を変え、消す', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    expect((await call('PUT', '/accounts/current', { id })).json.currentId).toBe(id);
    expect((await call('PATCH', `/accounts/${id}`, { name: '学校' })).json.accounts[1]!.name).toBe('学校');
    const r = await call('DELETE', `/accounts/${id}`);
    expect(r.json.accounts).toHaveLength(1);
    expect(r.json.currentId).toBe('primary');
  });

  it('login は 202 で返し、refresh は認証を読み直す', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    expect((await call('POST', `/accounts/${id}/login`)).status).toBe(202);
    expect((await call('POST', `/accounts/${id}/refresh`)).json.accounts[1]!.auth?.loggedIn).toBe(true);
  });

  it('login は、もう走っていれば 409、claude が無ければ 400 で理由を返し、cancel で止められる', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: (_b, _a, _e, _t, signal) => new Promise((_r, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted'))); }) });
    const slow = new Hono();
    accountsRoutes(slow, { ...deps, auth });
    const post = async (url: string) => {
      const res = await slow.request(url, { method: 'POST' });
      return { status: res.status, json: (await res.json()) as AccountsDto & { error?: string } };
    };
    const first = await post(`/accounts/${id}/login`);
    expect(first.status).toBe(202);
    expect(first.json.accounts[1]!.loginRunning).toBe(true);
    const second = await post(`/accounts/${id}/login`);
    expect(second.status).toBe(409);
    expect(second.json.error).toContain('もう始まっています');
    const cancelled = await post(`/accounts/${id}/login/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.accounts[1]!.loginRunning).toBe(false);
    expect(((await (await slow.request('/accounts')).json()) as AccountsDto).accounts[1]!.loginRunning).toBe(false);
    // 走っていなくても 200。
    expect((await post(`/accounts/${id}/login/cancel`)).status).toBe(200);

    const none = new Hono();
    accountsRoutes(none, { ...deps, auth: new AccountAuth({ claudeBin: () => null, run }) });
    const res = await none.request(`/accounts/${id}/login`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('claude が見つかりません');
  });

  it('login は、リンクを張れなければその理由を 400 で返し、ログインは始めない', async () => {
    const dir = path.join(userHome, '.claude-file');
    fs.writeFileSync(dir, 'x');
    const id = (await call('POST', '/accounts', { name: '大学', dir })).json.accounts[1]!.id;
    const r = await call('POST', `/accounts/${id}/login`);
    expect(r.status).toBe(400);
    expect(r.json.error?.length).toBeGreaterThan(0);
    expect(deps.auth.loginRunning(id)).toBe(false);
  });

  it('最初のアカウント以外で最後に動かしたセッションを sessions に載せる', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    const s = ensureSession(db, '11111111-1111-4111-8111-111111111111', '/w', 'd');
    upsertShared(db, 'runs', { id: 'r1', session_id: s, device_id: 'd', kind: 'start', tmux_name: 't', pid: null, launch_params: JSON.stringify({ account: id }), started_at: 1, ended_at: 2, end_reason: 'exited', heartbeat_at: 1 }, 'd');
    expect((await call('GET', '/accounts')).json.sessions).toEqual({ [s]: id });
  });

  it('セッションの切り替えは RunManager に渡し、成功したらいまのアカウントも変える', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    const res = await app.request('/sessions/s1/switch-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: id }) });
    expect(res.status).toBe(201);
    expect(switchAccount).toHaveBeenCalledWith('s1', id);
    expect(store.current().id).toBe(id);
  });

  it('切り替えを断られたら、その状態と文言を返し、いまのアカウントは変えない', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    switchAccount.mockRejectedValueOnce(new RunError(409, '前の Claude がまだ終わっていません'));
    const res = await app.request('/sessions/s1/switch-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: id }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('まだ終わっていません');
    expect(store.current().id).toBe('primary');
  });

  it('一覧を開くと、まだ読んでいないアカウントを裏で読みに行く（応答は待たない）', async () => {
    await call('POST', '/accounts', { name: '大学' });
    ensureChecked.mockClear();
    const r = await call('GET', '/accounts');
    expect(r.status).toBe(200);
    expect((ensureChecked.mock.calls as unknown[][]).map((c) => (c[0] as { id: string }).id)).toEqual(['primary', r.json.accounts[1]!.id]);
  });

  it('切り替えは、起動の前に beforeLaunch を待つ', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    await app.request('/sessions/s1/switch-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: id }) });
    expect(order).toEqual(['before', 'switch']);
  });

  it('リンクの点検は GET /accounts や追加・login・bootstrap のときだけで、使用量などからの配信は最後の結果を使い回す', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    const dir = store.get(id)!.dir;
    // 点検のあとで、リンクの場所に実物が置かれる。
    fs.unlinkSync(path.join(dir, 'projects'));
    fs.mkdirSync(path.join(dir, 'projects'));
    // statusline や認証の変化からの配信（点検しない）は、最後の結果（問題なし）のまま。
    expect(buildAccountsDto(deps).accounts[1]!.linkProblem).toBeNull();
    expect((await call('PUT', '/accounts/current', { id })).json.accounts[1]!.linkProblem).toBeNull();
    expect(sent.at(-1)!.accounts[1]!.linkProblem).toBeNull();
    // GET /accounts は点検し直す。
    expect((await call('GET', '/accounts')).json.accounts[1]!.linkProblem).toContain('projects');
    // 点検したあとは、その結果を使い回す（実物を片付けても、次の点検まで変わらない）。
    fs.rmSync(path.join(dir, 'projects'), { recursive: true });
    expect(buildAccountsDto(deps).accounts[1]!.linkProblem).toContain('projects');
    expect(buildAccountsDto(deps, { checkLinks: true }).accounts[1]!.linkProblem).toBeNull();
  });

  it('点検していないアカウントの linkProblem は null', async () => {
    const dir = path.join(userHome, '.claude-univ');
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    store.add({ name: '大学', dir });
    expect(buildAccountsDto(deps).accounts[1]!.linkProblem).toBeNull();
    expect(buildAccountsDto(deps, { checkLinks: true }).accounts[1]!.linkProblem).toContain('projects');
  });

  it('login のときも点検する', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    const dir = store.get(id)!.dir;
    fs.unlinkSync(path.join(dir, 'projects'));
    fs.mkdirSync(path.join(dir, 'projects'));
    const r = await call('POST', `/accounts/${id}/login`);
    expect(r.status).toBe(202);
    expect(r.json.accounts[1]!.linkProblem).toContain('projects');
  });

  it('追加のとき、置き場を作れなくても登録は通し、linkProblem に文を出して配る', async () => {
    // 置き場の場所に通常のファイルがある。
    const dir = path.join(userHome, '.claude-file');
    fs.writeFileSync(dir, 'x');
    const r = await call('POST', '/accounts', { name: '大学', dir });
    expect(r.status).toBe(201);
    expect(r.json.accounts).toHaveLength(2);
    expect(typeof r.json.accounts[1]!.linkProblem).toBe('string');
    expect(r.json.accounts[1]!.linkProblem!.length).toBeGreaterThan(0);
    expect(sent.at(-1)?.accounts).toHaveLength(2);
    expect((await call('GET', '/accounts')).json.accounts).toHaveLength(2);
  });

  it('セッションの起動で accounts.update を配る（新しい run のアカウントが sessions に載る）', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    const listeners: RunListener[] = [];
    announceAccountsOnRunStarted({ on: (l) => { listeners.push(l); return () => {}; } }, deps);
    expect(listeners).toHaveLength(1);
    sent.length = 0;
    const s = ensureSession(db, '11111111-1111-4111-8111-111111111111', '/w', 'd');
    upsertShared(db, 'runs', { id: 'r1', session_id: s, device_id: 'd', kind: 'start', tmux_name: 't', pid: null, launch_params: JSON.stringify({ account: id }), started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'd');
    listeners[0]!.runStarted!({ sessionId: s } as Parameters<NonNullable<RunListener['runStarted']>>[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessions).toEqual({ [s]: id });
  });
});
