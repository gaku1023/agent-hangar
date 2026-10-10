import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { COMPAT_VERSION } from '@agent-hangar/shared';
import type { ServerEvent } from '@agent-hangar/shared';
import { AccountAuth } from '../config/accountAuth.ts';
import { AccountStore } from '../config/accounts.ts';
import type { Db } from '../db/open.ts';
import type { MemoStore } from '../projects/memo.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import type { AccountsDeps } from './accounts.ts';
import { createApp, type AppDeps, type RunsApi } from './app.ts';
import { H, run, testDeps, TOKEN, type TestWorld } from './testing.ts';

// createApp 全体の組み立て（認証、本文の検査、MCP と UI の配り、アカウントの取り付け）の試験。経路ごとの試験は routes/*.test.ts にある。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let dir: string;
let db: Db;
let ws: string;
let deps: AppDeps;
let sent: ServerEvent[];
/** 偽物の口が呼ばれた順。testDeps の calls と同じ配列である。 */
let calls: string[];
let runs: RunsApi;
let usage: UsageTracker;
let memos: MemoStore;
/** ワークスペースから登録される唯一のプロジェクト alpha の id。 */
let list0ProjectId: () => string;
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  t = await testDeps();
  ({ db, ws, runs, usage, memos, deps, calls } = t);
  dir = t.claudeDir; sent = t.events; list0ProjectId = t.alphaProjectId;
  app = createApp(deps);
});
afterEach(() => { t.dispose(); });

describe('auth', () => {
  it('トークンが無ければ 401、Origin が違えば 403、/health は素通し', async () => {
    expect((await get('/api/bootstrap', {})).status).toBe(401);
    expect((await get('/api/bootstrap', { ...H, origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('/api/bootstrap', { cookie: `hangar_token=${TOKEN}` })).status).toBe(200);
    expect((await get('/health', {})).status).toBe(200);
  });

  // .app は起動のたびに 4177 の /health を叩き、200 かつ ok が真で version が文字列のときだけ
  // 「hangar がいる」と見なす（apps/desktop/src-tauri/src/health.rs の is_healthy がこれに依存している）。
  // version を外すと .app は既存のサーバを見つけられず、同梱サーバの起動も諦める。
  // 片側だけ変えられないよう、応答の形をここで固定する。
  // .app は /health が返った後も ready が真になるまで起動画面に残り、index の件数を起動画面に出す（lib.rs の wait_for_ready）。
  // 鍵の要らない経路なので、載せるのは段階と件数だけにする。
  // compat は互換の版番号で、殻は既存のサーバを、自分と同じ版のときだけ採る（health.rs の judge_existing）。外すと版 0 と読まれ、.app はそのサーバを採らない。
  // ready を外すと、.app はそのサーバを応答の無いものとして扱い、起動画面で待ったまま諦める（health.rs の boot_state）。
  it('/health は ok と文字列の version に、互換の版と、起動が済んだかと索引の進み具合を添えて返す', async () => {
    const res = await get('/health', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: unknown };
    const total = deps.indexer.progress().total;
    expect(total).toBeGreaterThan(0);
    expect(body).toEqual({ ok: true, version: '0.0.0-test', compat: COMPAT_VERSION, ready: true, index: { phase: 'idle', done: total, total } });
    expect(typeof body.version).toBe('string');
  });
  it('起動の途中の /health は ready を偽にし、索引の今の件数を返す', async () => {
    const booting = createApp({ ...deps, ready: () => false, indexer: { progress: () => ({ phase: 'indexing', done: 412, total: 987 }), rebuild: async () => {} } });
    const body = await (await booting.request('/health')).json();
    expect(body).toEqual({ ok: true, version: '0.0.0-test', compat: COMPAT_VERSION, ready: false, index: { phase: 'indexing', done: 412, total: 987 } });
  });

  it('許可する Origin は実際に待ち受けているポートに追随する', async () => {
    // 4177 以外で立てたとき、UI はそのポートの Origin を送る。決め打ちだと書き込みが全部 403 になる。
    const other = createApp({ ...deps, port: 4198 });
    // 403 かどうかだけを見たいので、状態を変えない本文を送る（存在しない path なので 400 になる）。
    const req = (origin: string) => other.request('/api/projects', { method: 'POST', headers: { ...H, origin, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'x', path: '/nonexistent' }) });
    for (const o of ['http://127.0.0.1:4198', 'http://localhost:4198', 'tauri://localhost']) {
      expect([o, (await req(o)).status]).toEqual([o, 400]);
    }
    // 無関係の Origin と、待ち受けていないポートは 403 のままにする。許可を広げない。
    // 開発用の Vite の 5173 も、配ったものでは断る。
    for (const o of ['https://evil.example', 'http://127.0.0.1:4177', 'http://localhost:4177', 'http://127.0.0.1:4199', 'http://127.0.0.1:5173', 'http://localhost:5173']) {
      expect([o, (await req(o)).status]).toEqual([o, 403]);
    }
    // MCP の入口も同じ考え方でそろえる。開発用の Vite だけは MCP に要らない。
    const mcp = (origin: string) => other.request('/mcp', { method: 'POST', headers: { ...H, origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
    expect((await mcp('http://127.0.0.1:4198')).status).toBe(200);
    expect((await mcp('http://127.0.0.1:4177')).status).toBe(403);
    expect((await mcp('https://evil.example')).status).toBe(403);
  });

  // 127.0.0.1 の別のポートは「同一サイト」なので、SameSite=Strict のクッキーが載る。
  // Content-Type を text/plain にすれば前検査も起きないので、クッキーだけで書き込めてしまっていた。
  // ブラウザは本文を送るとき必ず Content-Length を付ける。本文の型の検査はそれを見る。
  const cookieOnlyPost = (headers: Record<string, string>) => {
    const body = JSON.stringify({ kind: 'dir', name: 'x', path: '/nonexistent' });
    return app.request('/api/projects', { method: 'POST', headers: { cookie: `hangar_token=${TOKEN}`, 'content-length': String(body.length), ...headers }, body });
  };

  it('クッキーだけの書き込みは Sec-Fetch-Site で断る', async () => {
    // 5173 の Origin はもう許可一覧に無いので、まず Origin で 403 になる。
    expect((await cookieOnlyPost({ origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-site', 'content-type': 'text/plain;charset=UTF-8' })).status).toBe(403);
    // Origin を送らない経路でも、Sec-Fetch-Site が same-site なら断る。
    expect((await cookieOnlyPost({ 'sec-fetch-site': 'same-site', 'content-type': 'text/plain;charset=UTF-8' })).status).toBe(403);
    expect((await cookieOnlyPost({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' })).status).toBe(403);
    // どの検査で断ったかを分からせない。Origin の拒否と同じ応答にそろえる。
    const r = await cookieOnlyPost({ 'sec-fetch-site': 'same-site', 'content-type': 'application/json' });
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([403, 'origin not allowed']);
  });

  it('本文を送る要求は application/json だけを受ける', async () => {
    expect((await cookieOnlyPost({ 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain;charset=UTF-8' })).status).toBe(415);
    expect((await cookieOnlyPost({ 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    // 型が正しければ今までどおり経路まで届く（存在しない path なので 400 になる）。
    expect((await cookieOnlyPost({ 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })).status).toBe(400);
  });

  it('正しい経路は今までどおり通る', async () => {
    // Bearer を付けた curl は Sec-Fetch-Site を送らない。
    expect((await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'x', path: '/nonexistent' }) })).status).toBe(400);
    // 本文を持たない curl -X POST は Content-Length も Transfer-Encoding も付けない。今までどおり通す。
    expect((await app.request('/api/index/rebuild', { method: 'POST', headers: H })).status).toBe(202);
    // ブラウザで開いた UI は same-origin になる。
    expect((await cookieOnlyPost({ origin: 'http://127.0.0.1:4177', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })).status).toBe(400);
    // 本文を持たない POST は Content-Type を問わない。
    expect((await app.request('/api/index/rebuild', { method: 'POST', headers: { ...H, 'sec-fetch-site': 'same-origin' } })).status).toBe(202);
  });

  it('開発のときは Vite の 5173 を通す', async () => {
    vi.stubEnv('HANGAR_DEV', '1');
    try {
      // npm run dev では Vite のプロキシが Authorization を足して中継する。
      // ブラウザから見た宛先は 5173 なので Sec-Fetch-Site は same-origin、Origin は 5173 になる。
      const viaProxy = await app.request('/api/projects', { method: 'POST', headers: { ...H, origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'x', path: '/nonexistent' }) });
      expect(viaProxy.status).toBe(400);
      // 5173 のページが直に叩く形も、開発のときだけは通す。
      expect((await cookieOnlyPost({ origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-site', 'content-type': 'application/json' })).status).toBe(400);
      // 開発でも、まったく別のサイトからは通さない。
      expect((await cookieOnlyPost({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' })).status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('routes', () => {
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const alphaId = async () => { const { body } = await json(await get('/api/sessions')); return body.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA).id as string; };
  it('本文の上限はバイト数で測り、超えたら 413', async () => {
    const pid = list0ProjectId();
    // 日本語は 1 文字 3 バイト。文字数で測ると上限の 3 倍まで通ってしまう。
    expect((await post(`/api/projects/${pid}/memo`, { markdown: 'あ'.repeat(400 * 1024) }, 'PUT')).status).toBe(413);
    expect(memos.read(pid)).toBeNull();
    expect(sent.some((e) => e.type === 'memo.update')).toBe(false);
    expect((await post(`/api/projects/${pid}/todos`, { text: 'あ'.repeat(2000) })).status).toBe(413);
    expect((await post(`/api/projects/${pid}/artifacts`, { url: 'https://claude.ai/code/artifact/' + 'a'.repeat(3000) })).status).toBe(413);
    expect((await app.request('/api/ingest/statusline', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'あ'.repeat(100 * 1024) }) })).status).toBe(413);
    expect((await post(`/api/sessions/${await alphaId()}`, { memo: 'あ'.repeat(2000) }, 'PATCH')).status).toBe(413);
    // 経路ごとの指定が無い本文にも既定の上限が効く。
    expect((await post('/api/settings', { workspaceRoot: 'あ'.repeat(40 * 1024) }, 'PATCH')).status).toBe(413);
    const big = await post(`/api/projects/${pid}/memo`, { markdown: 'あ'.repeat(400 * 1024) }, 'PUT');
    expect((await big.json()).error).toMatch(/大きすぎます/);
    // 上限の内側はこれまでどおり通る。
    expect((await post(`/api/projects/${pid}/memo`, { markdown: 'あ'.repeat(1000) }, 'PUT')).status).toBe(200);
    expect((await post(`/api/projects/${pid}/todos`, { text: 'あ'.repeat(100) })).status).toBe(201);
  });
  it('MCP の経路が mount されている', async () => {
    const r = await app.request('/mcp', { method: 'POST', headers: { ...H, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
    expect(r.status).toBe(200);
    expect((await app.request('/mcp', { method: 'POST', body: '{}' })).status).toBe(401);
  });
  it('uiDist があれば 鍵付きの / でクッキーを配り、assets も配る', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-dist-'));
    try {
      fs.writeFileSync(path.join(dist, 'index.html'), '<html>hi</html>');
      fs.mkdirSync(path.join(dist, 'assets'));
      fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
      const ui = createApp({ ...deps, uiDist: dist });
      // 鍵を持たない GET / にはクッキーを配らない。curl 1 本でトークンが取れてはいけない。
      const bare = await ui.request('/');
      expect(bare.status).toBe(401);
      expect(bare.headers.get('set-cookie')).toBeNull();
      const notice = await bare.text();
      expect(notice).not.toContain(TOKEN);
      expect(notice).toContain('hangar start');
      // 起動した後に URL を見直す道も案内する。案内にトークンそのものは出さない。
      expect(notice).toContain('hangar url');
      expect(notice).toContain('ターミナルで <code>hangar url</code> を実行すれば');
      // 鍵が違うときも同じ扱いにする。
      const wrong = await ui.request('/?t=nope');
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get('set-cookie')).toBeNull();
      // 鍵付きで開くと、ここでクッキーに換わる。ブックマークから開き直せるよう Max-Age を付ける。
      const r = await ui.request(`/?t=${TOKEN}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('set-cookie')).toBe(`hangar_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      expect(await r.text()).toBe('<html>hi</html>');
      // 一度クッキーを持てば、鍵の無い URL でもそのまま開ける。
      const again = await ui.request('/', { headers: { cookie: `hangar_token=${TOKEN}` } });
      expect(again.status).toBe(200);
      expect(await again.text()).toBe('<html>hi</html>');
      const a = await ui.request('/assets/a.js');
      expect(a.status).toBe(200);
      expect(a.headers.get('content-type')).toBe('text/javascript');
      expect(await a.text()).toBe('console.log(1)');
      expect((await ui.request('/assets/../index.html')).status).toBe(404);
      expect((await ui.request('/assets/..%2Findex.html')).status).toBe(404);
      expect((await ui.request('/assets/%2e%2e/index.html')).status).toBe(404);
      expect((await ui.request('/assets/missing.js')).status).toBe(404);
      // 壊れたパーセント符号化は 500 ではなく 404 にする。
      expect((await ui.request('/assets/%ZZ')).status).toBe(404);
      expect((await ui.request('/assets/%E0%A4%A')).status).toBe(404);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
  it('/ は枠に嵌められない見出しを返す', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-dist-'));
    try {
      fs.writeFileSync(path.join(dist, 'index.html'), '<html>hi</html>');
      const ui = createApp({ ...deps, uiDist: dist });
      // SameSite=Strict はポートを数えない。手元の別のポートに置かれたページが、認証済みの UI を枠に入れられてしまう。
      for (const r of [await ui.request(`/?t=${TOKEN}`), await ui.request('/', { headers: { cookie: `hangar_token=${TOKEN}` } }), await ui.request('/')]) {
        expect(r.headers.get('x-frame-options')).toBe('DENY');
        const csp = r.headers.get('content-security-policy') ?? '';
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("object-src 'none'");
      }
      // 枠として要求されても、見出しが付いている以上ブラウザは描かない。
      const framed = await ui.request('/', { headers: { cookie: `hangar_token=${TOKEN}`, 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' } });
      expect(framed.headers.get('x-frame-options')).toBe('DENY');
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe('失敗の理由', () => {
  const patch = (p: string, body: unknown) => app.request(p, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const post = (p: string, body: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reason = async (r: Response) => ((await r.json()) as { error: string }).error;

  it('利用者に見える失敗は日本語で理由を返す', async () => {
    // UI は本文の error をそのままトーストに出す。経路によって英語と日本語が混ざらないようにする。
    const { body: list } = await json(await get('/api/projects'));
    const id = list[0].id;
    expect(await reason(await get('/api/projects/nope'))).toBe('プロジェクトが見つかりません');
    expect(await reason(await patch(`/api/projects/${id}`, { status: 'bogus' }))).toBe('ステータスは active、paused、done、archived のいずれかです');
    expect(await reason(await patch('/api/projects/nope', { status: 'done' }))).toBe('プロジェクトが見つかりません');
    expect(await reason(await post(`/api/projects/${id}/resolve`, { kind: 'bogus' }))).toBe('操作の種類が正しくありません。repoint、archive、unlink のいずれかを指定してください');
    expect(await reason(await post(`/api/projects/${id}/resolve`, { kind: 'repoint', path: `${ws}/nowhere` }))).toBe('指定したディレクトリが見つかりません。存在するディレクトリを選び直してください');
    expect(await reason(await post('/api/projects/nope/resolve', { kind: 'archive' }))).toBe('プロジェクトが見つかりません');
    expect(await reason(await get('/api/sessions/nope'))).toBe('セッションが見つかりません');
    expect(await reason(await patch('/api/settings', { token: 'stolen' }))).toBe('更新できる設定が含まれていません');
  });

  it('認証が通らない失敗は日本語で、Origin の拒否は機械向けの語を残す', async () => {
    // クッキーは UI の HTML を配る経路で発行するので、トークンが変わった後に
    // 開きっぱなしのタブが API を叩くと 401 になり、この文がそのままトーストに出る。
    expect(await reason(await get('/api/bootstrap', {}))).toBe('認証が切れました。ページを再読み込みしてください');
    // Origin の拒否は別サイトからの要求を入口で断る応答で、利用者の画面には届かない。
    expect(await reason(await get('/api/bootstrap', { ...H, origin: 'https://evil.example' }))).toBe('origin not allowed');
  });
});

describe('アカウントの取り付け', () => {
  let accountHome: string;
  let accountsApp: ReturnType<typeof createApp>;
  const post = (p: string, body: unknown) => accountsApp.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(() => {
    accountHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-app-acc-'));
    const primaryDir = path.join(accountHome, '.claude');
    fs.mkdirSync(path.join(primaryDir, 'projects'), { recursive: true });
    const store = new AccountStore({ home: accountHome, primaryDir, homeDir: accountHome });
    store.add({ name: '大学' });
    const second = store.list()[1]!.id;
    // 本文の statusline は、statusline の session_id から引いたアカウントの使用量に載る。
    const tracker = new UsageTracker(db, { accountOf: (sid) => (sid === SESSION_ALPHA ? second : 'primary') });
    const accounts: AccountsDeps = { db, store, primaryDir, usage: tracker, auth: new AccountAuth({ claudeBin: () => null }), runs: { switchAccount: vi.fn() } as unknown as AccountsDeps['runs'], broadcast: (a) => sent.push({ type: 'accounts.update', accounts: a }) };
    accountsApp = createApp({ ...deps, usage: tracker, accounts });
  });
  afterEach(() => { fs.rmSync(accountHome, { recursive: true, force: true }); });

  it('/bootstrap はいつも accounts を載せ、アカウントの経路はいつもある', async () => {
    const withAccounts = (await (await accountsApp.request('/api/bootstrap', { headers: H })).json()) as { accounts: { accounts: unknown[] } };
    expect(withAccounts.accounts.accounts).toHaveLength(2);
    const primaryOnly = (await (await get('/api/bootstrap')).json()) as { accounts: { accounts: { id: string }[] } };
    expect(primaryOnly.accounts.accounts.map((a) => a.id)).toEqual(['primary']);
    expect((await accountsApp.request('/api/accounts', { headers: H })).status).toBe(200);
    expect((await get('/api/accounts')).status).toBe(200);
  });

  it('リンクの点検は /bootstrap のときにし、statusline の配信では fs を触らない', async () => {
    const dir = path.join(accountHome, '.claude-2');
    expect(fs.existsSync(dir)).toBe(false);
    await accountsApp.request('/api/bootstrap', { headers: H });
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(accountHome, '.claude', 'projects'));
    fs.unlinkSync(path.join(dir, 'projects'));
    const limits = { rate_limits: { five_hour: { used_percentage: 47, resets_at: 4_000_000_000 }, seven_day: { used_percentage: 7, resets_at: 4_000_100_000 } } };
    expect((await post('/api/ingest/statusline', { session_id: SESSION_ALPHA, ...limits })).status).toBe(204);
    expect(fs.existsSync(path.join(dir, 'projects'))).toBe(false);
  });

  it('MCP の get_usage は、いつも accounts を返す', async () => {
    const usageOver = async (target: ReturnType<typeof createApp>) => {
      const res = await target.request('/mcp', { method: 'POST', headers: { ...H, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_usage', arguments: {} } }) });
      const text = await res.text();
      const json = (res.headers.get('content-type') ?? '').includes('text/event-stream') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())[0]! : text;
      return JSON.parse((JSON.parse(json) as { result: { content: { text: string }[] } }).result.content[0]!.text) as { accounts?: { name: string; current: boolean }[] };
    };
    expect((await usageOver(accountsApp)).accounts?.map((a) => [a.name, a.current])).toEqual([['メイン', true], ['大学', false]]);
    expect((await usageOver(app)).accounts?.map((a) => [a.name, a.current])).toEqual([['メイン', true]]);
  });

  it('アカウントの切り替えは、resume と同じく起動の前に同期の取り込みを待つ', async () => {
    const id = (await (await accountsApp.request('/api/accounts', { headers: H })).json() as { accounts: { id: string }[] }).accounts[1]!.id;
    calls.length = 0;
    await post('/api/sessions/s1/switch-account', { account: id });
    expect(calls).toEqual(['beforeLaunch']);
  });

  it('使用量は、動かしたアカウントの accounts.update で配る。最初のアカウントも同じ道で届く', async () => {
    sent.length = 0;
    const limits = { rate_limits: { five_hour: { used_percentage: 47, resets_at: 4_000_000_000 }, seven_day: { used_percentage: 7, resets_at: 4_000_100_000 } } };
    expect((await post('/api/ingest/statusline', { session_id: SESSION_ALPHA, ...limits })).status).toBe(204);
    expect(sent.find((e) => e.type === 'accounts.update')).toMatchObject({ accounts: { accounts: [{ id: 'primary', usage: { fiveHour: null } }, { usage: { fiveHour: { usedPercent: 47 } } }] } });
    sent.length = 0;
    expect((await post('/api/ingest/statusline', { session_id: SESSION_OTHER, ...limits })).status).toBe(204);
    expect(sent.find((e) => e.type === 'accounts.update')).toMatchObject({ accounts: { accounts: [{ id: 'primary', usage: { fiveHour: { usedPercent: 47 } } }, {}] } });
  });
});

describe('組み立ての必須の口', () => {
  it('アカウントと使用量の口は、どの組み立ても必ず渡す', () => {
    expectTypeOf<undefined>().not.toExtend<AppDeps['accounts']>();
    expectTypeOf<undefined>().not.toExtend<AppDeps['cloudUsage']>();
    // 起動の済み具合、同期の付録、互換、UI の置き場も、どの組み立ても必ず渡す。
    expectTypeOf<undefined>().not.toExtend<AppDeps['ready']>();
    expectTypeOf<undefined>().not.toExtend<AppDeps['syncSkipped']>();
    expectTypeOf<undefined>().not.toExtend<AppDeps['syncSweep']>();
    expectTypeOf<undefined>().not.toExtend<AppDeps['syncOncePass']>();
    expectTypeOf<undefined>().not.toExtend<AppDeps['compat']>();
    expectTypeOf<undefined>().not.toExtend<AppDeps['uiDist']>();
  });
});
