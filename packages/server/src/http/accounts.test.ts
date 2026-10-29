import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDirPreviewDto, AccountsDto } from '@agent-hangar/shared';
import { AccountAuth, type RunClaude } from '../provider/claude-code/config/accountAuth.ts';
import { AccountStore } from '../config/accounts.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/write.ts';
import { RunError, type RunListener } from '../runs/manager.ts';
import { AgentUsageTracker } from '../usage/agentUsage.ts';
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
    expect(second.json.error).toContain('すでに始まっています');
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

  it('ログインの途中のアカウントを外すと、外す前にログインの子プロセスを止める。最初のアカウントは外せず、止めもしない', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    let aborted = 0;
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: (_b, _a, _e, _t, signal) => new Promise((_r, reject) => { signal?.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); }); }) });
    const cancel = vi.spyOn(auth, 'cancelLogin');
    const slow = new Hono();
    accountsRoutes(slow, { ...deps, auth });
    const send = (method: string, url: string) => slow.request(url, { method });
    expect((await send('POST', `/accounts/${id}/login`)).status).toBe(202);
    expect(auth.loginRunning(id)).toBe(true);
    expect((await send('POST', '/accounts/primary/login')).status).toBe(202);
    expect((await send('DELETE', '/accounts/primary')).status).toBe(400);
    expect(cancel).not.toHaveBeenCalled();
    const removed = await send('DELETE', `/accounts/${id}`);
    expect(removed.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith(id);
    expect(aborted).toBe(1);
    expect(auth.loginRunning(id)).toBe(false);
    expect(auth.loginRunning('primary')).toBe(true);
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
    switchAccount.mockRejectedValueOnce(new RunError(409, '前の Claude がまだ終了していません'));
    const res = await app.request('/sessions/s1/switch-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: id }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('まだ終了していません');
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

  describe('足す前の確かめ（GET /accounts/preview）', () => {
    const preview = async (q: Record<string, string>) => {
      const res = await app.request(`/accounts/preview?${new URLSearchParams(q).toString()}`);
      return { status: res.status, json: (await res.json()) as AccountDirPreviewDto & { error?: string } };
    };
    it('場所を打っていなければ、名前から候補を作って答える。何も作らない', async () => {
      const r = await preview({ name: 'univ' });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ name: 'univ', input: '', dir: path.join(userHome, '.claude-univ'), suggested: true, exists: false, conflicts: [], registeredAs: null });
      expect(fs.existsSync(path.join(userHome, '.claude-univ'))).toBe(false);
    });
    it('打った場所は ~ を読み、既にある場所の実ファイルを挙げる', async () => {
      fs.mkdirSync(path.join(userHome, '.claude-lab'));
      fs.writeFileSync(path.join(userHome, '.claude-lab', 'projects'), 'x');
      const r = await preview({ name: 'lab', dir: '~/.claude-lab' });
      expect(r.json).toEqual({ name: 'lab', input: '~/.claude-lab', dir: path.join(userHome, '.claude-lab'), suggested: false, exists: true, conflicts: ['projects'], registeredAs: null });
      expect(fs.readFileSync(path.join(userHome, '.claude-lab', 'projects'), 'utf8')).toBe('x');
    });
    it('登録済みの場所は、そのアカウントの名前を返す', async () => {
      const r = await preview({ name: 'x', dir: primaryDir });
      expect(r.json.registeredAs).toBe(store.primary().name);
    });
    it('相対パスは 400', async () => {
      const r = await preview({ name: 'x', dir: 'claude-x' });
      expect(r.status).toBe(400);
      expect(r.json.error).toBeTruthy();
    });
  });

  it('追加の場所は ~ から書ける', async () => {
    const r = await call('POST', '/accounts', { name: 'univ', dir: '~/.claude-univ' });
    expect(r.status).toBe(201);
    expect(r.json.accounts[1]!.dir).toBe(path.join(userHome, '.claude-univ'));
  });
});

describe('agents（Claude 以外のエージェントの枠）', () => {
  it('枠が無い間は agents を付けない。Claude の枠の形は変わらない', () => {
    const d = buildAccountsDto({ ...deps, agentUsage: new AgentUsageTracker() });
    expect('agents' in d).toBe(false);
    expect(buildAccountsDto(deps)).toEqual(buildAccountsDto({ ...deps, agentUsage: new AgentUsageTracker() }));
  });
  it('Codex の枠が届いたら agents.codex に付ける', () => {
    const t = new AgentUsageTracker({ now: () => 10 });
    t.set('codex', { fiveHour: { usedPercent: 5, resetsAt: 100 }, sevenDay: null, plan: 'plus' }, 9);
    expect(buildAccountsDto({ ...deps, agentUsage: t }).agents).toEqual({ codex: { fiveHour: { usedPercent: 5, resetsAt: 100 }, sevenDay: null, updatedAt: 9, plan: 'plus' } });
  });
});

describe('リンクの修復（Claude）', () => {
  type Conflicts = { accountId: string; agent: string; entries: { name: string; kind: string; mine: { text: string | null }; shared: { text: string | null } }[]; error?: string };
  const raw = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Conflicts & AccountsDto };
  };
  let dir: string;
  beforeEach(async () => {
    fs.writeFileSync(path.join(primaryDir, 'settings.json'), '{"shared":1}');
    dir = path.join(userHome, '.claude-univ');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"mine":1}');
    await call('POST', '/accounts', { name: '大学', dir });
  });

  it('中身が違うファイルは linkConflicts に出し、文は選んで直す文になる。ディレクトリは入れない', async () => {
    let r = await call('GET', '/accounts');
    const a = r.json.accounts[1]!;
    expect(a.linkConflicts).toEqual(['settings.json']);
    expect(a.linkProblem).toBe('settings.json が共有設定から外れています。残す方を選んで修復してください');
    expect(r.json.accounts[0]!.linkConflicts).toEqual([]);
    // ディレクトリが混じると、直せるファイルだけを挙げ、文は今のまま。
    fs.rmSync(path.join(dir, 'projects'));
    fs.mkdirSync(path.join(dir, 'projects'));
    r = await call('GET', '/accounts');
    expect(r.json.accounts[1]!.linkConflicts).toEqual(['settings.json']);
    expect(r.json.accounts[1]!.linkProblem).toContain('共有のリンクではありません');
  });

  it('中身が同じ実ファイルは、黙ってリンクに張り直す', async () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"shared":1}');
    const r = await call('GET', '/accounts');
    expect(r.json.accounts[1]).toMatchObject({ linkConflicts: [], linkProblem: null });
    expect(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink()).toBe(true);
  });

  it('GET link-conflicts は両側の中身を返す', async () => {
    const id = store.list()[1]!.id;
    const r = await raw('GET', `/accounts/${id}/link-conflicts`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ accountId: id, agent: 'claude-code', entries: [{ name: 'settings.json', kind: 'file', mine: { text: '{"mine":1}' }, shared: { text: '{"shared":1}' } }] });
  });

  it('POST で shared を残すと、手元は .bak-hangar- へ退避され、リンクになり、DTO の linkConflicts が空になる', async () => {
    const id = store.list()[1]!.id;
    const r = await raw('POST', `/accounts/${id}/link-conflicts`, { entries: [{ name: 'settings.json', keep: 'shared' }] });
    expect(r.status).toBe(200);
    expect(r.json.accounts[1]).toMatchObject({ linkConflicts: [], linkProblem: null });
    expect(fs.readlinkSync(path.join(dir, 'settings.json'))).toBe(path.join(primaryDir, 'settings.json'));
    const baks = fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.bak-hangar-'));
    expect(baks).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, baks[0]!), 'utf8')).toBe('{"mine":1}');
    expect(sent.at(-1)!.accounts[1]!.linkConflicts).toEqual([]);
  });

  it('POST で mine を残すと、共有側が書き換わり、元の共有側は退避される', async () => {
    const id = store.list()[1]!.id;
    expect((await raw('POST', `/accounts/${id}/link-conflicts`, { entries: [{ name: 'settings.json', keep: 'mine' }] })).status).toBe(200);
    expect(fs.readFileSync(path.join(primaryDir, 'settings.json'), 'utf8')).toBe('{"mine":1}');
    expect(fs.readdirSync(primaryDir).some((n) => n.startsWith('settings.json.bak-hangar-'))).toBe(true);
  });

  it('許さない名前、形の違う本文、最初のアカウント、知らない id を断る', async () => {
    const id = store.list()[1]!.id;
    expect((await raw('POST', `/accounts/${id}/link-conflicts`, { entries: [{ name: '../evil', keep: 'shared' }] })).status).toBe(400);
    expect((await raw('POST', `/accounts/${id}/link-conflicts`, { entries: [{ name: 'notes.txt', keep: 'shared' }] })).status).toBe(400);
    expect((await raw('POST', `/accounts/${id}/link-conflicts`, { entries: [{ name: 'settings.json', keep: 'x' }] })).status).toBe(400);
    expect((await raw('POST', `/accounts/${id}/link-conflicts`, {})).status).toBe(400);
    expect((await raw('GET', '/accounts/primary/link-conflicts')).status).toBe(400);
    expect((await raw('GET', '/accounts/nope/link-conflicts')).status).toBe(404);
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe('{"mine":1}');
  });

  it('ディレクトリの項目を直そうとすると 400 で、何も動かさない', async () => {
    const id = store.list()[1]!.id;
    fs.mkdirSync(path.join(dir, 'skills'));
    fs.mkdirSync(path.join(primaryDir, 'skills'));
    expect((await raw('POST', `/accounts/${id}/link-conflicts`, { entries: [{ name: 'skills', keep: 'shared' }] })).status).toBe(400);
    expect(fs.lstatSync(path.join(dir, 'skills')).isDirectory()).toBe(true);
  });
});

