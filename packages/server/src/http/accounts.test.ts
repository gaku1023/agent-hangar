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
import { RunError } from '../runs/manager.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { accountsRoutes, type AccountsDeps } from './accounts.ts';

let db: Db;
let home: string;
let userHome: string;
let primaryDir: string;
let store: AccountStore;
let app: Hono;
let sent: AccountsDto[];
let switchAccount: ReturnType<typeof vi.fn>;
let order: string[];
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
  const deps: AccountsDeps = {
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
});
