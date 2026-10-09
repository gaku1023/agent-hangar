import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { writeFakeTool } from '../../test/fake-bin.ts';
import { COMPAT_VERSION } from '@agent-hangar/shared';
import type { CompatDto, ServerEvent, SettingsDto } from '@agent-hangar/shared';
import { VERIFIED_CLAUDE_VERSION } from '../provider/claude-code/compat/version.ts';
import { AccountAuth } from '../config/accountAuth.ts';
import { AccountStore } from '../config/accounts.ts';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import type { MemoStore } from '../projects/memo.ts';
import { proposeTodoDone } from '../projects/todos.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import type { AccountsDeps } from './accounts.ts';
import { createApp, type AppDeps, type ExternalApi, type RunsApi, type SummaryApi, type SummaryEnqueueOpts } from './app.ts';
import { H, READY, RET, run, testDeps, TOKEN, type TestWorld } from './testing.ts';

let t: TestWorld;
let dir: string;
let db: Db;
let ws: string;
let app: ReturnType<typeof createApp>;
let deps: AppDeps;
let sent: ServerEvent[];
/** 偽物の口が呼ばれた順。testDeps の calls と同じ配列である。 */
let calls: string[];
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

let runs: RunsApi;
let external: ExternalApi;
let usage: UsageTracker;
let memos: MemoStore;
let summary: SummaryApi & { enqueued: [string, SummaryEnqueueOpts | undefined][] };
/** ワークスペースから登録される唯一のプロジェクト alpha の id。 */
let list0ProjectId: () => string;

/** 実行できる空のファイルを ws/bin に置く。パスの欄は保存の前に存在と実行権を確かめるので、実物が要る。 */
const exe = (name: string): string => writeFakeTool(path.join(ws, 'bin'), name, { sh: '', cmd: '' });

beforeEach(async () => {
  t = await testDeps();
  ({ db, ws, runs, external, usage, memos, summary, deps, calls } = t);
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
  it('bootstrap は全部を返す', async () => {
    const { status, body } = await json(await get('/api/bootstrap'));
    expect(status).toBe(200);
    expect(body.device).toEqual({ id: 'd', name: 'mac' });
    expect(body.projects).toHaveLength(1);
    expect(body.sessions).toHaveLength(3);
    expect(body.index.phase).toBe('idle');
    expect(body.version).toBe('0.0.0-test');
  });
  it('プロジェクトの取得、状態変更、候補、解決', async () => {
    const { body: list } = await json(await get('/api/projects'));
    const id = list[0].id;
    expect((await json(await get(`/api/projects/${id}`))).body.name).toBe('alpha');
    const r = await app.request(`/api/projects/${id}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'paused' }) });
    expect((await r.json()).status).toBe('paused');
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id, status: 'paused' } });
    expect((await json(await get(`/api/projects/${id}/candidates?name=alp`))).body).toEqual([path.join(ws, 'alpha')]);
    const r2 = await app.request(`/api/projects/${id}/resolve`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'archive' }) });
    expect((await r2.json()).status).toBe('archived');
    expect((await get('/api/projects/nope')).status).toBe(404);
    const bad = await app.request(`/api/projects/${id}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'bogus' }) });
    expect(bad.status).toBe(400);
  });
  it('設定の取得と更新', async () => {
    expect((await json(await get('/api/settings'))).body.workspaceRoot).toBe(ws);
    const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceRoot: path.join(ws, 'alpha') }) });
    expect(r.status).toBe(200);
    expect((await r.json()).workspaceRoot).toBe(path.join(ws, 'alpha'));
    // 保存の知らせは画面が欄の横に出すので、サーバからトーストは配らない。
    expect(sent.some((e) => e.type === 'toast')).toBe(false);
  });
  it('パスの欄は、保存する前に存在と実行権を確かめ、理由を欄の見出しで言う', async () => {
    const error = async (body: unknown) => {
      const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(r.status).toBe(400);
      return ((await r.json()) as { error: string }).error;
    };
    // 実在しないルートと、ファイルを指したルートは弾く。どちらも 500 にはしない。
    const missing = path.join(ws, 'no-such-root');
    expect(await error({ workspaceRoot: missing })).toBe(`「ワークスペースのルート」に ${missing} が見つかりません`);
    const asFile = path.join(ws, 'root-is-a-file');
    fs.writeFileSync(asFile, 'x');
    expect(await error({ workspaceRoot: asFile })).toBe(`「ワークスペースのルート」の ${asFile} はディレクトリではありません`);
    // ツールは、無い、ファイルでない、実行できないを分けて言う。
    expect(await error({ tmuxPath: path.join(ws, 'no-tmux') })).toBe(`「tmux のパス」に ${path.join(ws, 'no-tmux')} が見つかりません`);
    expect(await error({ claudePath: ws })).toBe(`「claude のパス」の ${ws} はファイルではありません`);
    expect(await error({ codePath: asFile })).toBe(`「code のパス」の ${asFile} には実行権がありません`);
    expect(await error({ nodePath: path.join(ws, 'no-node') })).toBe(`「Node のパス」に ${path.join(ws, 'no-node')} が見つかりません`);
    // 弾いた値は保存していない。
    expect((await json(await get('/api/settings'))).body).toMatchObject({ workspaceRoot: ws, tmuxPath: null, claudePath: null, codePath: null, nodePath: null });
  });
  // 名前だけ（tmux など）は PATH から探して確かめ、打たれたまま保存する。起動のときも PATH から探すからである。
  it('パスの欄は名前だけでも受け、PATH から探して確かめ、打たれたまま保存する', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const bin = path.dirname(exe('mytmux'));
    vi.stubEnv('PATH', ['/no/such/dir', bin].join(path.delimiter));
    try {
      const r = await patch({ tmuxPath: ' mytmux ' });
      expect(r.status).toBe(200);
      expect((await r.json()).tmuxPath).toBe('mytmux');
      expect((await json(await get('/api/settings'))).body.tmuxPath).toBe('mytmux');
      const missing = await patch({ tmuxPath: 'no-such-tool' });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toBe('「tmux のパス」の no-such-tool が PATH に見つかりません');
      // 相対パスは、サーバの作業ディレクトリで読むとどこを指すかが分からないので弾く。
      for (const rel of ['./mytmux', 'bin/mytmux']) {
        const bad = await patch({ claudePath: rel });
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as { error: string }).error).toBe('「claude のパス」は / か ~ で始まるパスか、tmux のようなコマンドの名前にしてください');
      }
      expect((await json(await get('/api/settings'))).body).toMatchObject({ tmuxPath: 'mytmux', claudePath: null });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  // 起動するときに ~ は直されないので、パスは ~ をホームに直した値で保存する。
  it('パスの欄の ~ はホームに直して保存する', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const tool = exe('hometool');
    vi.stubEnv('HOME', ws);
    vi.stubEnv('USERPROFILE', ws);
    try {
      // Windows の偽の道具は hometool.cmd になる。拡張子まで書いたパスで指す。
      const r = await patch({ codePath: `~/bin/${path.basename(tool)}` });
      expect(r.status).toBe(200);
      expect((await r.json()).codePath).toBe(tool);
      expect((await json(await get('/api/settings'))).body.codePath).toBe(tool);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('設定の誤りは、内部のキー名ではなく画面の欄の見出しと画面名「設定」で言う', async () => {
    const error = async (body: unknown) => {
      const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(r.status).toBe(400);
      return ((await r.json()) as { error: string }).error;
    };
    expect(await error({ workspaceRoot: '' })).toBe('「ワークスペースのルート」は空にできません');
    expect(await error({ claudeDir: ' ' })).toBe('「読み取り元」は空にできません');
    expect(await error({ tmuxPath: 3 })).toBe('「tmux のパス」の値の形が違います');
    expect(await error({ codePath: 3 })).toBe('「code のパス」の値の形が違います');
    expect(await error({ nodePath: 3 })).toBe('「Node のパス」の値の形が違います');
    expect(await error({ claudePath: 3 })).toBe('「claude のパス」の値の形が違います');
    expect(await error({ terminalApp: 'kitty' })).toBe('「ターミナルアプリ」は Terminal.app か iTerm2 から選んでください');
    expect(await error({ lmStudioUrl: 'ftp://x' })).toBe('「LM Studio の URL」は http か https で始まる URL にしてください');
    expect(await error({ lmStudioModel: 3 })).toBe('「モデル」の値の形が違います');
    expect(await error({ summaryFallback: 'yes' })).toBe('「LM Studio が使えないとき Claude へ切り替える」の値の形が違います');
    expect(await error({ summaryHourlyCap: 0 })).toBe('「1 時間の上限」は 1 から 200 までの整数にしてください');
    // 画面の入力と同じく 200 までにする。
    expect(await error({ summaryHourlyCap: 201 })).toBe('「1 時間の上限」は 1 から 200 までの整数にしてください');
    expect(await error({ allowExternalSummarizer: 'yes' })).toBe('「外部の要約器を許す」の値の形が違います');
    expect(await error({ syncClaudeConfig: 'yes' })).toBe('「Claude Code の設定を同期する」の値の形が違います');
    expect(await error({ lmStudioUrl: 'https://attacker.example.com' })).toBe('要約器の宛先は 127.0.0.1 か localhost だけです。会話の本文が送られるため、ほかの宛先は、設定の「外部の要約器を許す」を入れてから指定してください');
  });
  it('設定の更新は既知の項目だけを受け、値が空なら 400', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await patch({ workspaceRoot: '' })).status).toBe(400);
    expect((await patch({ workspaceRoot: 123 })).status).toBe(400);
    expect((await patch({ claudeDir: '  ' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ token: 'stolen' })).status).toBe(400);
    expect((await json(await get('/api/settings'))).body).toEqual({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null, language: 'ja' });
  });
  it('claudePath は保存でき、空なら null に戻る', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const claude = exe('claude');
    const r = await patch({ claudePath: ` ${claude} ` });
    expect(r.status).toBe(200);
    expect((await r.json()).claudePath).toBe(claude);
    expect((await json(await get('/api/settings'))).body.claudePath).toBe(claude);
    const r2 = await patch({ claudePath: '' });
    expect(r2.status).toBe(200);
    expect((await r2.json()).claudePath).toBeNull();
    expect((await patch({ claudePath: 7 })).status).toBe(400);
  });
  it('nodePath は保存でき、空なら null に戻る', async () => {
    const node = exe('node');
    const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ nodePath: ` ${node} ` }) });
    expect(r.status).toBe(200);
    expect((await r.json()).nodePath).toBe(node);
    expect((await json(await get('/api/settings'))).body.nodePath).toBe(node);
    expect((await json(await get('/api/bootstrap'))).body.settings.nodePath).toBe(node);
    const r2 = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ nodePath: '' }) });
    expect(r2.status).toBe(200);
    expect((await r2.json()).nodePath).toBeNull();
    // 文字列でも null でもない値は弾く。
    const r3 = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ nodePath: 7 }) });
    expect(r3.status).toBe(400);
  });
  it('ワークスペースのルートを変えるとプロジェクトを登録し直して配信する', async () => {
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-app2-'));
    try {
      fs.mkdirSync(`${ws2}/other`);
      const other = db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_OTHER) as { id: string };
      db.prepare('update sessions set cwd = ? where id = ?').run(`${ws2}/other`, other.id);
      sent.length = 0;
      const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceRoot: ws2 }) });
      expect(r.status).toBe(200);
      const created = db.prepare('select id from projects where name = ?').get('other') as { id: string } | undefined;
      expect(created).toBeDefined();
      expect(sent.some((e) => e.type === 'project.upsert' && e.project.id === created!.id)).toBe(true);
      const up = sent.find((e) => e.type === 'session.upsert' && e.session.id === other.id);
      expect(up).toBeDefined();
      expect((up as { session: { projectId: string | null } }).session.projectId).toBe(created!.id);
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });
  it('索引の作り直しは 202', async () => {
    const r = await app.request('/api/index/rebuild', { method: 'POST', headers: H });
    expect(r.status).toBe(202);
  });
  it('bootstrap は runs と tabs と新しい settings を含む', async () => {
    const { body } = await json(await get('/api/bootstrap'));
    expect(body.runs).toEqual([run]);
    expect(body.tabs).toHaveLength(2);
    expect(body.settings).toEqual({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null, language: 'ja' });
  });
  it('プロジェクトの作成', async () => {
    fs.mkdirSync(path.join(ws, 'beta'));
    const r = await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'beta', path: path.join(ws, 'beta') }) });
    expect(r.status).toBe(201);
    const p = await r.json();
    expect(p).toMatchObject({ name: 'beta', path: path.join(ws, 'beta'), resolved: true, status: 'active' });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: p.id } });
    expect((await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'x', path: '/nonexistent' }) })).status).toBe(400);
    expect((await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: '', path: ws }) })).status).toBe(400);
    // .. を含むパスは正規化してから入れる。生のまま入れると前方一致でセッションが当たらなくなる。
    const again = await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'beta again', path: path.join(ws, 'beta') + path.sep + '..' + path.sep + 'beta' }) });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(p.id);
    expect(db.prepare('select count(*) c from project_roots where deleted_at is null').get()).toEqual({ c: 2 });
    expect(db.prepare("select count(*) c from project_roots where path like '%..%'").get()).toEqual({ c: 0 });
  });
  const postProject = (body: unknown) => app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('新しいフォルダを作ってプロジェクトにする', async () => {
    const gitInit = vi.fn();
    app = createApp({ ...deps, gitInit });
    const r = await postProject({ kind: 'newDir', name: 'fresh', gitInit: true });
    expect(r.status).toBe(201);
    const p = await r.json();
    expect(p).toMatchObject({ name: 'fresh', path: path.join(ws, 'fresh'), resolved: true, status: 'active' });
    expect(gitInit).toHaveBeenCalledWith(path.join(ws, 'fresh'));
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: p.id } });
    expect((await postProject({ kind: 'newDir', name: 'fresh', gitInit: false })).status).toBe(409);
    const bad = await postProject({ kind: 'newDir', name: 'a/b', gitInit: false });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('名前はディレクトリ名として使える 1 字以上で、/ を含められません');
    expect((await postProject({ kind: 'newDir', gitInit: false })).status).toBe(400);
  });
  it('kind が dir なら既存のフォルダを登録し、名前を省けば basename にする', async () => {
    fs.mkdirSync(`${ws}/gamma`);
    const r = await postProject({ kind: 'dir', path: `${ws}/gamma` });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: 'gamma', path: path.join(ws, 'gamma') });
    expect((await postProject({ kind: 'other', path: ws })).status).toBe(400);
  });
  it('kind の無い本文は断る', async () => {
    fs.mkdirSync(`${ws}/gamma`);
    const r = await postProject({ name: 'gamma', path: `${ws}/gamma` });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('kind は newDir か dir です');
  });
  it('未登録のフォルダの一覧を返す', async () => {
    fs.mkdirSync(`${ws}/delta`);
    fs.mkdirSync(`${ws}/.secret`);
    const r = await get('/api/workspace/dirs');
    expect(r.status).toBe(200);
    const names = ((await r.json()) as { name: string }[]).map((d) => d.name);
    // alpha は beforeEach で登録済み。bin は exe() で作られることがある。
    expect(names).toContain('delta');
    expect(names).not.toContain('alpha');
    expect(names).not.toContain('.secret');
  });
  // 末尾の / や .. を生のまま入れると project_roots の前方一致に cwd が当たらず、
  // 直したつもりのプロジェクトにセッションが一件も紐づかない。
  it('repoint は正規化したパスを入れ、セッションが紐づく', async () => {
    const id = list0ProjectId();
    const moved = path.join(ws, 'moved');
    fs.mkdirSync(path.join(moved, 'src'), { recursive: true });
    // 紐づけ直しが動くのは未分類のセッションだけなので、1 件を moved の下に置く。
    const other = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_OTHER) as { id: string }).id;
    db.prepare('update sessions set cwd = ?, project_id = null where id = ?').run(path.join(moved, 'src'), other);
    const r = await post(`/api/projects/${id}/resolve`, { kind: 'repoint', path: `${path.join(ws, 'alpha', '..', 'moved')}/` });
    expect(r.status).toBe(200);
    expect(db.prepare('select path from project_roots where project_id = ? and deleted_at is null').get(id)).toEqual({ path: moved });
    expect((await json(await get(`/api/sessions/${other}`))).body.projectId).toBe(id);
  });
  // Windows のファイルシステムは大文字小文字を区別しない。綴り違いで同じフォルダを二重に登録しない。
  it.runIf(process.platform === 'win32')('Windows では、綴りの大文字小文字が違う同じフォルダを二重に登録しない', async () => {
    const post = (p: string) => app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dir', name: 'gamma', path: p }) });
    fs.mkdirSync(path.join(ws, 'gamma'));
    const first = await post(path.join(ws, 'gamma'));
    expect(first.status).toBe(201);
    const again = await post(path.join(ws, 'gamma').toUpperCase());
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe((await first.json()).id);
  });
  it('設定の新しい項目を検査する', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // 実物の置き場（/opt/homebrew/bin/tmux）は PC によって無いので、偽の道具を置いて指す。
    const tmuxBin = exe('tmux');
    expect(await (await patch({ terminalApp: 'iterm', tmuxPath: tmuxBin })).json()).toMatchObject({ terminalApp: 'iterm', tmuxPath: tmuxBin });
    expect((await patch({ terminalApp: 'kitty' })).status).toBe(400);
    expect((await patch({ tmuxPath: 3 })).status).toBe(400);
    expect((await (await patch({ codePath: null })).json()).codePath).toBeNull();
  });
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const alphaId = async () => { const { body } = await json(await get('/api/sessions')); return body.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA).id as string; };

  it('statusline の受け口と使用量', async () => {
    const first = { session_id: SESSION_ALPHA, model: { id: 'claude-opus-4-1' }, effort: 'high', context_window: { context_window_size: 200000, current_usage: null } };
    expect((await post('/api/ingest/statusline', first)).status).toBe(204);
    expect(sent.filter((e) => e.type === 'accounts.update')).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { providerSessionId: SESSION_ALPHA, stats: { model: 'claude-opus-4-1' } } });
    const second = { ...first, context_window: { context_window_size: 200000, current_usage: { input_tokens: 50000 } }, rate_limits: { five_hour: { used_percentage: 47, resets_at: 4_000_000_000 }, seven_day: { used_percentage: 7, resets_at: 4_000_100_000 } } };
    expect((await post('/api/ingest/statusline', second)).status).toBe(204);
    expect(sent.find((e) => e.type === 'accounts.update')).toMatchObject({ accounts: { accounts: [{ id: 'primary', usage: { fiveHour: { usedPercent: 47 }, sevenDay: { usedPercent: 7 } } }] } });
    expect((await json(await get('/api/usage'))).body).toMatchObject({ fiveHour: { usedPercent: 47 } });
    expect((await json(await get(`/api/sessions/${await alphaId()}`))).body.stats.contextPercent).toBe(25);
    expect((await app.request('/api/ingest/statusline', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: 'not json' })).status).toBe(400);
    // 認証は他の /api と同じ。トークンが無ければ受け付けない。
    expect((await app.request('/api/ingest/statusline', { method: 'POST', body: '{}' })).status).toBe(401);
    // 集計は今日から遡る窓で数えるので、時計を fixture の日付（2026-09-01）の近くに止めて測る。
    // 止めないと、fixture から 30 日を過ぎた日にこの試験だけが落ちる。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T12:00:00'));
    try {
      const agg = await json(await get('/api/usage/aggregate?days=30'));
      expect(agg.status).toBe(200);
      expect(agg.body.projects.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
    expect((await get('/api/usage/aggregate?days=0')).status).toBe(400);
    expect((await json(await get('/api/statusline'))).body).toEqual({ command: null, scriptPath: null, installed: false });
    expect((await json(await get('/api/shell-hook'))).body).toEqual({ state: 'off', zshrc: '/Users/me/.zshrc', line: 'x  # agent-hangar', command: 'hangar shell install' });
    // 準備の確かめは 1 つの読み取りにまとめてある。設定画面と空のホームが同じものを読む。
    expect((await json(await get('/api/readiness'))).body).toEqual(READY);
    expect((await json(await get('/api/bootstrap'))).body).toMatchObject({ accounts: { accounts: [{ id: 'primary', usage: { fiveHour: { usedPercent: 47 } } }] }, todos: [], artifacts: [], summaryPending: ['pending-1'] });
  });
  it('TODO とメモ', async () => {
    const pid = list0ProjectId();
    const a = await post(`/api/projects/${pid}/todos`, { text: '最初' });
    expect(a.status).toBe(201);
    const todo = await a.json();
    expect(todo).toMatchObject({ projectId: pid, text: '最初', done: false, position: 1 });
    expect(sent.at(-2)).toMatchObject({ type: 'todos.update', projectId: pid, todos: [{ id: todo.id }] });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: pid, openTodoCount: 1 } });
    expect((await post(`/api/projects/${pid}/todos`, { text: '  ' })).status).toBe(400);
    expect((await post('/api/projects/nope/todos', { text: 'x' })).status).toBe(404);
    expect((await (await post(`/api/todos/${todo.id}`, { done: true }, 'PATCH')).json()).done).toBe(true);
    expect((await post('/api/todos/nope', { done: true }, 'PATCH')).status).toBe(404);
    expect((await json(await get(`/api/projects/${pid}/todos`))).body).toHaveLength(1);
    expect((await app.request(`/api/todos/${todo.id}`, { method: 'DELETE', headers: H })).status).toBe(200);
    expect((await json(await get(`/api/projects/${pid}/todos`))).body).toEqual([]);
    expect((await json(await get(`/api/projects/${pid}/memo`))).body).toEqual({ projectId: pid, markdown: '', updatedAt: 0 });
    const m = await post(`/api/projects/${pid}/memo`, { markdown: '# alpha\n本文' }, 'PUT');
    expect((await m.json()).markdown).toBe('# alpha\n本文');
    expect(sent.at(-2)).toMatchObject({ type: 'memo.update', memo: { projectId: pid } });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { memoHead: '# alpha' } });
    expect(fs.readFileSync(memos.memoPath(pid), 'utf8')).toBe('# alpha\n本文');
    expect((await post(`/api/projects/${pid}/memo`, { markdown: 3 }, 'PUT')).status).toBe(400);
  });
  it('TODO の候補の確定と却下', async () => {
    const pid = list0ProjectId();
    const a = await (await post(`/api/projects/${pid}/todos`, { text: 'a' })).json();
    const b = await (await post(`/api/projects/${pid}/todos`, { text: 'b' })).json();
    // 候補でない未完は、確定も却下も 409 で断る。本文はトーストに出せる一文にする。
    const c409 = await post(`/api/todos/${a.id}/confirm`);
    expect(c409.status).toBe(409);
    expect((await c409.json()).error).toBe('この TODO は完了の候補ではありません');
    expect((await post(`/api/todos/${a.id}/reject`)).status).toBe(409);
    expect((await post('/api/todos/nope/confirm')).status).toBe(404);
    expect((await post('/api/todos/nope/reject')).status).toBe(404);

    proposeTodoDone(db, 'd', a.id, { sessionId: null, note: '直した' });
    proposeTodoDone(db, 'd', b.id, { sessionId: null, note: '直した' });
    sent.length = 0;
    const ok = await post(`/api/todos/${a.id}/confirm`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: a.id, done: true, candidate: null });
    expect(sent.map((e) => e.type)).toEqual(['todos.update', 'project.upsert']);
    // すでに完了なら何もせず 200。何も配らない。
    sent.length = 0;
    expect((await post(`/api/todos/${a.id}/confirm`)).status).toBe(200);
    expect(sent).toEqual([]);

    sent.length = 0;
    const rj = await post(`/api/todos/${b.id}/reject`);
    expect(rj.status).toBe(200);
    expect(sent.map((e) => e.type)).toEqual(['todos.update', 'project.upsert']);
    expect(await rj.json()).toMatchObject({ id: b.id, done: false, candidate: null });
    expect((await post(`/api/todos/${b.id}/reject`)).status).toBe(409);

    // 利用者のチェックの付け外しは候補を消す。
    proposeTodoDone(db, 'd', b.id, { sessionId: null, note: 'もう一度' });
    expect(await (await post(`/api/todos/${b.id}`, { done: false }, 'PATCH')).json()).toMatchObject({ done: false, candidate: null });
  });
  it('アーティファクト', async () => {
    const pid = list0ProjectId();
    const a = await post(`/api/projects/${pid}/artifacts`, { url: 'https://claude.ai/code/artifact/manual' });
    expect(a.status).toBe(201);
    const art = await a.json();
    expect(sent.at(-1)).toMatchObject({ type: 'artifact.upsert', artifact: { id: art.id } });
    expect((await post(`/api/projects/${pid}/artifacts`, { url: 'https://example.com' })).status).toBe(400);
    expect((await json(await get(`/api/artifacts?projectId=${pid}`))).body).toHaveLength(1);
    expect((await post(`/api/artifacts/${art.id}/open`)).status).toBe(204);
    expect(external.openUrl).toHaveBeenCalledWith('https://claude.ai/code/artifact/manual');
    expect((await post(`/api/artifacts/${art.id}/open-editor`)).status).toBe(404);
    expect((await post('/api/artifacts/nope/open')).status).toBe(404);
    // 入力の誤りは 400 のまま、DB の失敗は 500 にする。
    const bad = await post(`/api/projects/${pid}/artifacts`, { url: 'https://example.com' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/claude\.ai/);
    db.exec('drop table artifacts');
    const broken = await post(`/api/projects/${pid}/artifacts`, { url: 'https://claude.ai/code/artifact/manual-2' });
    expect(broken.status).toBe(500);
    expect((await broken.json()).error).toMatch(/追加できませんでした/);
  });
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
  it('要約器の設定を検査する', async () => {
    const patch = (body: unknown) => post('/api/settings', body, 'PATCH');
    expect(await (await patch({ lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5 })).json()).toMatchObject({ lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5 });
    expect((await patch({ lmStudioUrl: 'ftp://x' })).status).toBe(400);
    // host の無い URL は繋ぎ先にならない。
    expect((await patch({ lmStudioUrl: 'http://' })).status).toBe(400);
    expect((await patch({ lmStudioUrl: 'http' })).status).toBe(400);
    expect((await patch({ summaryHourlyCap: 0 })).status).toBe(400);
    expect((await patch({ summaryFallback: 'yes' })).status).toBe(400);
    expect((await (await patch({ lmStudioModel: null })).json()).lmStudioModel).toBeNull();
  });
  it('要約器の宛先は、既定ではループバックだけを受ける', async () => {
    const patch = (body: unknown) => post('/api/settings', body, 'PATCH');
    // 会話の本文はこの宛先へ送られる。外部のホストは、明示の許可が無ければ断る。
    const bad = await patch({ lmStudioUrl: 'https://attacker.example.com/collect' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/外部の要約器/);
    expect((await json(await get('/api/settings'))).body.lmStudioUrl).toBe('http://127.0.0.1:1234');
    for (const u of ['http://127.0.0.1:1234', 'http://localhost:4321', 'http://[::1]:1234']) {
      expect([u, (await patch({ lmStudioUrl: u })).status]).toEqual([u, 200]);
    }
    // 許しを立てたときだけ通り、外部の宛先であることは設定に残る。
    expect((await patch({ allowExternalSummarizer: true, lmStudioUrl: 'https://attacker.example.com/collect' })).status).toBe(200);
    expect((await json(await get('/api/settings'))).body).toMatchObject({ allowExternalSummarizer: true, lmStudioUrl: 'https://attacker.example.com/collect' });
    // 許しを下ろすときは、宛先も戻してもらう。外部のまま無効にはできない。
    expect((await patch({ allowExternalSummarizer: false })).status).toBe(400);
    expect((await patch({ allowExternalSummarizer: false, lmStudioUrl: 'http://127.0.0.1:1234' })).status).toBe(200);
    expect((await patch({ allowExternalSummarizer: 'yes' })).status).toBe(400);
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

describe('同期の経路', () => {
  const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('同期の経路も認証の下にある', async () => {
    // 参加トークンは全セッションの読み書き権を持つ。鍵の無い要求と別サイトからの要求は入口で断る。
    for (const p of ['/api/sync/status', '/api/sync/joinToken', '/api/devices', '/api/sync/config/preview']) {
      expect((await get(p, {})).status).toBe(401);
      expect((await get(p, { ...H, origin: 'https://evil.example' })).status).toBe(403);
    }
    const noAuth = await app.request('/api/sync/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }) });
    expect(noAuth.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('bootstrap に sync と devices が乗り、設定に syncClaudeConfig が出る', async () => {
    const { body } = await json(await get('/api/bootstrap'));
    expect(body.sync).toMatchObject({ state: 'idle', pending: 0, deviceCount: 2 });
    expect(body.devices).toEqual([{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: 1, self: true, shell: null }]);
    expect(body.settings.syncClaudeConfig).toBe(false);
    expect(body.sessions[0].lock).toBeNull();
    expect(body.sessions[0].remoteOnly).toBe(false);
  });

  it('status、now、pause、focus', async () => {
    expect((await json(await get('/api/sync/status'))).body.state).toBe('idle');
    expect((await json(await post('/api/sync/now'))).body.state).toBe('idle');
    expect((await post('/api/sync/pause', { paused: true })).status).toBe(200);
    expect((await post('/api/sync/pause', { paused: 'yes' })).status).toBe(400);
    expect((await post('/api/sync/focus')).status).toBe(202);
    expect(calls).toEqual(['syncNow', 'pause:true', 'focus']);
  });

  it('降ろすのを諦めた項目が同期の状態に乗る', async () => {
    // onError は 1 度しか鳴らないので、鳴った後に画面を開いた利用者はここでしか気付けない。
    t.sync.skipped = [{ key: 'transcripts/mini/u1.jsonl.gz', attempts: 3, message: '復号できません' }];
    expect((await json(await get('/api/sync/status'))).body.skipped).toEqual(t.sync.skipped);
    expect((await json(await get('/api/bootstrap'))).body.sync.skipped).toEqual(t.sync.skipped);
  });

  it('取り残しの残り件数が同期の状態に乗る', async () => {
    // 数えられないときは null で、0 件（追いついた）と区別できる。
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBeNull();
    t.sync.sweepPending = 1500;
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBe(1500);
    expect((await json(await get('/api/bootstrap'))).body.sync.sweepPending).toBe(1500);
    // 今すぐ同期と一時停止の応答も同じ形で返す。画面はこの 3 つから付録を受け取る。
    expect((await json(await post('/api/sync/now'))).body.sweepPending).toBe(1500);
    expect((await json(await post('/api/sync/pause', { paused: true }))).body.sweepPending).toBe(1500);
    t.sync.sweepPending = 0;
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBe(0);
  });

  it('掃除の口を渡さない端末では取り残しは null のまま', async () => {
    app = createApp({ ...deps, syncSweep: () => null });
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBeNull();
  });

  it('参加トークンと端末一覧と設定の下見', async () => {
    expect((await json(await get('/api/sync/joinToken'))).body).toEqual({ token: 'tok-abc' });
    expect((await json(await get('/api/devices'))).body).toHaveLength(1);
    const p = await json(await get('/api/sync/config/preview'));
    expect(p.body.entries[0]).toMatchObject({ path: 'CLAUDE.md', action: 'create' });
    expect((await json(await post('/api/sync/config/pull'))).body).toEqual({ applied: 1, conflicts: 0 });
    expect(calls).toEqual(['configPull']);
  });

  it('GET /api/sync/usage は今の値を、refresh=1 は取り直した値を返す', async () => {
    const dto = { source: 'unknown', fetchedAt: null, stale: false, notice: null, limits: { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 }, today: { d1RowsWritten: null, workersRequests: null, resetAt: 3 }, plan: null, month: null };
    const refreshed = { ...dto, today: { ...dto.today, d1RowsWritten: 9 } };
    app = createApp({ ...deps, cloudUsage: { current: () => dto as never, refresh: async () => refreshed as never } });
    expect((await json(await get('/api/sync/usage'))).body).toEqual(dto);
    expect((await json(await get('/api/sync/usage?refresh=1'))).body).toEqual(refreshed);
    expect((await json(await get('/api/bootstrap'))).body.cloudUsage).toEqual(dto);
  });

  it('使用量がまだ無ければ /api/sync/usage と bootstrap の cloudUsage は null', async () => {
    expect((await json(await get('/api/sync/usage'))).body).toBeNull();
    expect((await json(await get('/api/bootstrap'))).body.cloudUsage).toBeNull();
  });

  it('同期が未設定なら設定の経路は 404 で、参加トークンは null', async () => {
    app = createApp({ ...deps, configSync: null, joinToken: () => null });
    expect((await get('/api/sync/config/preview')).status).toBe(404);
    expect((await post('/api/sync/config/pull')).status).toBe(404);
    expect((await json(await get('/api/sync/joinToken'))).body).toEqual({ token: null });
  });
});

describe('設定の変更でロックを消さない', () => {
  it('ワークスペースを変えたときの配り直しにもロックが乗る', async () => {
    // 配り直しの 1 か所だけ deviceId が抜けていると、サーバはロックを持っているのに
    // 配信はロック無しの SessionDto を送り、UI の store がそれで置き換えて画面から消える。
    const all = (await json(await get('/api/sessions'))).body as { id: string; projectId: string | null }[];
    const orphan = all.find((s) => s.projectId === null)!;
    // このセッションが新しいワークスペースの下に入るようにして、紐づけ直しの配信に載せる。
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws2-'));
    try {
      fs.mkdirSync(path.join(ws2, 'beta'));
      db.prepare('update sessions set cwd = ? where id = ?').run(path.join(ws2, 'beta'), orphan.id);
      upsertShared(db, 'devices', { id: 'mini', name: 'mini', platform: 'darwin', last_seen_at: Date.now(), deleted_at: null }, 'mini');
      upsertShared(db, 'runs', {
        id: 'remote-run', session_id: orphan.id, device_id: 'mini', kind: 'start', tmux_name: 'hangar-remote',
        pid: null, launch_params: '{}', started_at: Date.now(), ended_at: null, end_reason: null, heartbeat_at: Date.now(), deleted_at: null,
      }, 'mini');
      sent.length = 0;
      const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceRoot: ws2 }) });
      expect(r.status).toBe(200);
      const upserts = sent.filter((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert');
      const mine = upserts.find((e) => e.session.id === orphan.id);
      expect(mine).toBeDefined();
      expect(mine!.session.lock).toMatchObject({ deviceId: 'mini', deviceName: 'mini', runId: 'remote-run' });
      // 配った後に引き直しても同じ姿である（配信だけが違う、という形を作らない）。
      expect((await json(await get(`/api/sessions/${orphan.id}`))).body.lock).toMatchObject({ deviceId: 'mini' });
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });
});

describe('設定の往復', () => {
  const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('SettingsDto の項目はすべて UI から往復できる', async () => {
    // 受け口に 1 つでも項目が足りないと、UI の操作は 400 で弾かれ、その機能が丸ごと死ぬ。
    // 実物の確認では syncClaudeConfig がそれで、Claude Code 設定の同期を UI から入れられなかった。
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws3-'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cd-'));
    try {
      // 1 項目ずつ送って、応答と GET の両方に載ることを見る。UI は 1 項目だけの patch を送る。
      const cases: [keyof SettingsDto, unknown][] = [
        ['workspaceRoot', ws2],
        ['claudeDir', dir2],
        ['tmuxPath', exe('tmux')],
        ['terminalApp', 'iterm'],
        ['codePath', exe('code')],
        ['lmStudioUrl', 'http://127.0.0.1:9999'],
        ['lmStudioModel', 'gemma-3'],
        ['summaryFallback', false],
        ['summaryHourlyCap', 7],
        ['allowExternalSummarizer', true],
        ['syncClaudeConfig', true],
        ['nodePath', exe('node')],
        ['claudePath', exe('claude')],
        ['language', 'en'],
      ];
      for (const [key, value] of cases) {
        const r = await patch({ [key]: value });
        expect([key, r.status]).toEqual([key, 200]);
        expect([key, (await r.json())[key]]).toEqual([key, value]);
        expect([key, (await json(await get('/api/settings'))).body[key]]).toEqual([key, value]);
      }
      // 受け口の項目が DTO の項目とそろっていることを、抜けが出たら落ちる形で見る。
      const dto = (await json(await get('/api/settings'))).body as SettingsDto;
      expect(cases.map(([k]) => k).sort()).toEqual(Object.keys(dto).sort());
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('言語の既定は日本語で、英語を保存して読める', async () => {
    expect((await json(await get('/api/settings'))).body.language).toBe('ja');
    expect((await json(await get('/api/bootstrap'))).body.settings.language).toBe('ja');
    const r = await patch({ language: 'en' });
    expect(r.status).toBe(200);
    expect((await r.json()).language).toBe('en');
    expect((await json(await get('/api/settings'))).body.language).toBe('en');
    expect((await json(await get('/api/bootstrap'))).body.settings.language).toBe('en');
    expect((await (await patch({ language: 'ja' })).json()).language).toBe('ja');
  });
  it('知らない言語は断り、保存した値を変えない', async () => {
    await patch({ language: 'en' });
    for (const v of ['fr', 'EN', '', null, 1, ['en']]) {
      const r = await patch({ language: v });
      expect([v, r.status]).toEqual([v, 400]);
      expect((await r.json()).error).toBe('「言語」は ja か en から選んでください');
    }
    expect((await json(await get('/api/settings'))).body.language).toBe('en');
  });

  // 前後の空白に意味は無い。パス系の設定と同じ扱いにそろえる。
  it('lmStudioModel は前後の空白を落として保存する', async () => {
    const r = await patch({ lmStudioModel: '  gemma-3  ' });
    expect(r.status).toBe(200);
    expect((await r.json()).lmStudioModel).toBe('gemma-3');
    expect((await json(await get('/api/settings'))).body.lmStudioModel).toBe('gemma-3');
    // 空白だけの文字列は「未設定」と同じに扱う。
    expect((await (await patch({ lmStudioModel: '   ' })).json()).lmStudioModel).toBeNull();
  });

  it('Claude Code 設定の同期は、入れて、切って、また入れられる', async () => {
    // UI のチェックは settings.update の patch を 1 つ送るだけである。
    for (const want of [true, false, true]) {
      const r = await patch({ syncClaudeConfig: want });
      expect(r.status).toBe(200);
      expect((await r.json()).syncClaudeConfig).toBe(want);
      expect((await json(await get('/api/bootstrap'))).body.settings.syncClaudeConfig).toBe(want);
    }
  });

  it('真偽値でない syncClaudeConfig は 400 で断る', async () => {
    const r = await patch({ syncClaudeConfig: 'yes' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('「Claude Code の設定を同期する」の値の形が違います');
  });
});

describe('保持期間', () => {
  const send = (p: string, method: string, body: unknown) => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('bootstrap に載る', async () => {
    const r = await app.request('/api/bootstrap', { headers: H });
    expect((await r.json()).retention).toEqual(RET);
  });
  it('下見と書き込みは 1 以上 36500 以下の整数だけを受け付ける', async () => {
    for (const days of [0, -1, 1.5, '30', 36501, null]) {
      expect((await send('/api/retention/preview', 'POST', { days })).status).toBe(400);
      expect((await send('/api/retention', 'PUT', { days, baseSha256: 'abc' })).status).toBe(400);
    }
    expect((await (await send('/api/retention/preview', 'POST', { days: 365 })).json()).days).toBe(365);
    expect((await send('/api/retention', 'PUT', { days: 365 })).status).toBe(400);
  });
  it('指紋が古ければ 409 の retention_conflict', async () => {
    const r = await send('/api/retention', 'PUT', { days: 365, baseSha256: 'stale' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'retention_conflict' });
  });
  it('書けたら新しい値を返す。GET でも今の値を返す', async () => {
    expect(await (await send('/api/retention', 'PUT', { days: 365, baseSha256: 'abc' })).json()).toMatchObject({ days: 365, source: 'user' });
    expect(await (await app.request('/api/retention', { headers: H })).json()).toEqual(RET);
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

describe('GET /api/prompt/commands', () => {
  it('読み取り元のスキルと組み込みを返す', async () => {
    const dir = path.join(deps.settings().claudeDir, 'skills', 'demo-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo-skill\ndescription: 試し\n---\n');
    const r = await json(await get('/api/prompt/commands'));
    expect(r.status).toBe(200);
    const list = (r.body as { commands: { name: string; source: string }[] }).commands;
    expect(list).toContainEqual(expect.objectContaining({ name: 'demo-skill', source: 'user', description: '試し' }));
    expect(list).toContainEqual(expect.objectContaining({ name: 'init', source: 'builtin' }));
  });
  it('projectId を渡すと、そのプロジェクトの .claude の下も読む', async () => {
    const id = list0ProjectId();
    const p = (await json(await get(`/api/projects/${id}`))).body as { path: string };
    const dir = path.join(p.path, '.claude', 'skills', 'proj-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: proj-skill\ndescription: x\n---\n');
    const r = await json(await get(`/api/prompt/commands?projectId=${id}`));
    expect((r.body as { commands: { name: string; source: string }[] }).commands).toContainEqual(expect.objectContaining({ name: 'proj-skill', source: 'project' }));
  });
  it('知らない projectId は 404', async () => {
    expect((await get('/api/prompt/commands?projectId=nope')).status).toBe(404);
  });
  it('トークンが無ければ 401', async () => {
    expect((await get('/api/prompt/commands', {})).status).toBe(401);
  });
});

describe('GET /api/prompt/files', () => {
  it('プロジェクトのファイルを問いで探して返す', async () => {
    const id = list0ProjectId();
    const p = (await json(await get(`/api/projects/${id}`))).body as { path: string };
    const probe = path.join(p.path, 'prompt-files-probe.ts');
    fs.writeFileSync(probe, 'x');
    try {
      const r = await json(await get(`/api/prompt/files?projectId=${id}&q=prompt-files-probe`));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ files: ['prompt-files-probe.ts'] });
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });
  it('projectId が無ければ 400、知らなければ 404', async () => {
    expect((await get('/api/prompt/files?q=a')).status).toBe(400);
    expect((await get('/api/prompt/files?projectId=nope&q=a')).status).toBe(404);
  });
});

describe('/api/drops', () => {
  // ブラウザは本文を送るとき必ず Content-Length を付ける。app.request は付けないので、実際の形に合わせてここで付ける。
  const post = (name: string, body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string> = {}) => app.request(`/api/drops?name=${encodeURIComponent(name)}`, { method: 'POST', body, headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength), ...headers } });

  it('本文を置き場に置き、パスと名前と大きさを返す', async () => {
    const r = await json(await post('画面 1.png', new Uint8Array([1, 2, 3])));
    expect(r.status).toBe(201);
    const d = r.body as { path: string; name: string; size: number };
    expect(d.name).toBe('画面 1.png');
    expect(d.size).toBe(3);
    expect(path.dirname(d.path)).toBe(path.join(deps.home, 'drops'));
    expect(path.basename(d.path)).toMatch(/^\d+-0-画面_1\.png$/);
    expect([...fs.readFileSync(d.path)]).toEqual([1, 2, 3]);
  });
  it('置いたファイルを名前で読める。画像は種類を付け、中身を勝手に解釈させない', async () => {
    const d = (await json(await post('a.png', new Uint8Array([9, 8])))).body as { path: string };
    const r = await get(`/api/drops/${encodeURIComponent(path.basename(d.path))}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([9, 8]);
  });
  it('画像でないものは、開かせずに落とす種類で返す', async () => {
    const d = (await json(await post('a.html', '<script>1</script>'))).body as { path: string };
    const r = await get(`/api/drops/${encodeURIComponent(path.basename(d.path))}`);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
  });
  it('置き場の外を指す名前は 404', async () => {
    fs.writeFileSync(path.join(deps.home, 'secret'), 's');
    for (const n of ['..%2Fsecret', '%2e%2e%2fsecret', '..', 'nope.png']) expect((await get(`/api/drops/${n}`)).status).toBe(404);
  });
  it('20 MB を超える本文は 413 で、何も置かない', async () => {
    const r = await post('big.bin', new Uint8Array(20 * 1024 * 1024 + 1));
    expect(r.status).toBe(413);
    expect(fs.existsSync(path.join(deps.home, 'drops')) ? fs.readdirSync(path.join(deps.home, 'drops')).filter((n) => n.endsWith('big.bin')) : []).toEqual([]);
  });
  it('413 の文言は、上限を MB で読ませる（20480KB ではなく 20MB）', async () => {
    const r = await post('big.bin', new Uint8Array(20 * 1024 * 1024 + 1));
    expect((await r.json()).error).toBe('本文が大きすぎます（上限は 20MB です）');
  });
  it('長さの申告が 20 MB を超えていれば、読む前に 413 にする', async () => {
    expect((await post('lie.bin', new Uint8Array([1]), { 'content-length': String(20 * 1024 * 1024 + 1) })).status).toBe(413);
  });
  it('置き場の中の、外を指すシンボリックリンクは読ませない', async () => {
    const outside = path.join(deps.home, 'outside-secret');
    fs.writeFileSync(outside, 's');
    const drops = path.join(deps.home, 'drops');
    fs.mkdirSync(drops, { recursive: true });
    fs.symlinkSync(outside, path.join(drops, 'link.png'));
    expect((await get('/api/drops/link.png')).status).toBe(404);
  });
  it('本文の型は application/octet-stream だけを受ける（text/plain は断る）', async () => {
    expect((await post('a.png', new Uint8Array([1]), { 'content-type': 'text/plain;charset=UTF-8' })).status).toBe(415);
    expect((await post('a.png', new Uint8Array([1]), { 'content-type': 'multipart/form-data; boundary=x' })).status).toBe(415);
  });
  it('octet-stream の例外は POST /api/drops だけで、ほかの経路は 415 のまま', async () => {
    const body = JSON.stringify({ paths: [] });
    const r = await app.request('/api/drops/existing', { method: 'POST', headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': String(body.length) }, body });
    expect(r.status).toBe(415);
    const p = await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': String(body.length) }, body });
    expect(p.status).toBe(415);
  });
  it('例外の経路でも、トークンと Sec-Fetch-Site の検査は効く', async () => {
    expect((await post('a.png', new Uint8Array([1]), { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post('a.png', new Uint8Array([1]), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post('a.png', new Uint8Array([1]), { origin: 'https://evil.example' })).status).toBe(403);
  });
  it('空の本文は 400', async () => {
    expect((await post('empty.png', new Uint8Array(0))).status).toBe(400);
  });
  it('existing は、渡したパスのうち、いまあるファイルだけを返す', async () => {
    const d = (await json(await post('a.png', new Uint8Array([1])))).body as { path: string };
    const r = await json(await app.request('/api/drops/existing', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ paths: [d.path, path.join(deps.home, 'drops', 'gone.png'), 42] }) }));
    expect(r.body).toEqual({ paths: [d.path] });
  });
  it('トークンが無ければ 401', async () => {
    expect((await app.request('/api/drops?name=a.png', { method: 'POST', body: new Uint8Array([1]) })).status).toBe(401);
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

describe('Claude Code との互換', () => {
  it('GET /api/compat は互換の口の答えをそのまま返し、口が無ければ確かめた版だけを返す', async () => {
    const COMPAT: CompatDto = { verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [{ contract: 'registry', value: 'status=thinking', version: '2.1.300', count: 2, firstSeenAt: 1, lastSeenAt: 2 }] };
    const withCompat = createApp({ ...deps, compat: async () => COMPAT });
    expect(await (await withCompat.request('/api/compat', { headers: H })).json()).toEqual(COMPAT);
    expect((await json(await get('/api/compat'))).body).toEqual({ verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: null, drifts: [] });
  });
});

// 経路は行を書くだけで、画面へのイベントは配る層（events/publisher.ts）が組む。
// 書いた行のイベントが、1 回だけ、最新の中身で届くことを経路ごとに押さえる。
describe('書いた行のイベントは配る層から届く', () => {
  const send = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const of = <T extends ServerEvent['type']>(type: T) => sent.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);
  const sessionsOf = async () => (await json(await get('/api/sessions'))).body as { id: string; projectId: string | null; providerSessionId: string }[];

  describe('プロジェクト', () => {
    it('状態を変えると、その project.upsert が 1 回だけ届く', async () => {
      const id = list0ProjectId();
      await send(`/api/projects/${id}`, { status: 'paused' }, 'PATCH');
      expect(sent).toEqual([{ type: 'project.upsert', project: expect.objectContaining({ id, status: 'paused' }) }]);
    });

    it('置き場を選び直すと、プロジェクトと、紐づけが変わったセッションだけが届く', async () => {
      const id = list0ProjectId();
      const all = await sessionsOf();
      const orphan = all.find((s) => s.projectId === null)!;
      const moved = path.join(ws, 'moved');
      fs.mkdirSync(moved);
      db.prepare('update sessions set cwd = ? where id = ?').run(moved, orphan.id);
      const r = await send(`/api/projects/${id}/resolve`, { kind: 'repoint', path: moved });
      expect(r.status).toBe(200);
      expect(of('project.upsert')).toEqual([{ type: 'project.upsert', project: expect.objectContaining({ id, path: moved, resolved: true }) }]);
      // 以前は絞り込めずに全件を流していた。紐づけが変わった 1 件だけになる。
      expect(of('session.upsert')).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id: orphan.id, projectId: id }) }]);
    });

    it('一覧から外すと、未分類に戻ったセッションが届き、消えたプロジェクトは届かない', async () => {
      const id = list0ProjectId();
      const mine = (await sessionsOf()).filter((s) => s.projectId === id).map((s) => s.id).sort();
      expect(mine.length).toBeGreaterThan(0);
      const r = await send(`/api/projects/${id}/resolve`, { kind: 'unlink' });
      expect(await r.json()).toEqual({ id, unlinked: true });
      expect(of('project.upsert')).toEqual([]);
      expect(of('session.upsert').map((e) => e.session.id).sort()).toEqual(mine);
      expect(of('session.upsert').every((e) => e.session.projectId === null)).toBe(true);
    });

    it('ワークスペースを変えると、新しく登録したプロジェクトと、そこへ入ったセッションが 1 回ずつ届く', async () => {
      const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-app3-'));
      try {
        fs.mkdirSync(path.join(ws2, 'other'));
        const other = db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_OTHER) as { id: string };
        db.prepare('update sessions set cwd = ? where id = ?').run(path.join(ws2, 'other'), other.id);
        await send('/api/settings', { workspaceRoot: ws2 }, 'PATCH');
        const created = (db.prepare('select id from projects where name = ?').get('other') as { id: string }).id;
        // 中身の変わっていない既存のプロジェクトは配らない。
        expect(of('project.upsert').map((e) => e.project.id)).toEqual([created]);
        // 入ったセッションの最終の活動が、プロジェクトの中身に載っている（紐づけた後に組んでいる）。
        expect(of('project.upsert')[0]!.project.lastActivityAt).not.toBeNull();
        expect(of('session.upsert')).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id: other.id, projectId: created }) }]);
      } finally {
        fs.rmSync(ws2, { recursive: true, force: true });
      }
    });

    it('登録済みのフォルダを登録し直しても、行が変わらなければ何も届かない。アーカイブから戻したときは届く', async () => {
      const id = list0ProjectId();
      const again = await send('/api/projects', { kind: 'dir', path: path.join(ws, 'alpha') });
      expect(again.status).toBe(200);
      expect(sent).toEqual([]);
      await send(`/api/projects/${id}`, { status: 'archived' }, 'PATCH');
      sent.length = 0;
      await send('/api/projects', { kind: 'dir', path: path.join(ws, 'alpha') });
      expect(sent).toEqual([{ type: 'project.upsert', project: expect.objectContaining({ id, status: 'active' }) }]);
    });

    it('新しく登録すると、その project.upsert が 1 回だけ届く', async () => {
      fs.mkdirSync(path.join(ws, 'gamma'));
      const p = await (await send('/api/projects', { kind: 'dir', path: path.join(ws, 'gamma') })).json();
      expect(sent).toEqual([{ type: 'project.upsert', project: expect.objectContaining({ id: p.id, name: 'gamma' }) }]);
    });
  });

  describe('セッション', () => {
    const alpha = async () => (await sessionsOf()).find((s) => s.providerSessionId === SESSION_ALPHA)!;

    it('statusline を受けると、そのセッションの session.upsert が 1 回だけ届く。知らないセッションでは届かない', async () => {
      const body = { session_id: SESSION_ALPHA, model: { id: 'claude-opus-4-1' }, effort: 'high', context_window: { context_window_size: 200000, current_usage: null } };
      await send('/api/ingest/statusline', body);
      expect(sent).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ providerSessionId: SESSION_ALPHA, stats: expect.objectContaining({ model: 'claude-opus-4-1' }) }) }]);
      sent.length = 0;
      await send('/api/ingest/statusline', { ...body, session_id: 'no-such-session' });
      expect(sent).toEqual([]);
    });
  });

  describe('TODO、メモ、アーティファクト', () => {
    it('TODO を足す、完了にする、消す、のどれでも一覧と未完の数が 1 回ずつ届く', async () => {
      const pid = list0ProjectId();
      const todo = await (await send(`/api/projects/${pid}/todos`, { text: 'やる' })).json();
      expect(sent).toEqual([
        { type: 'todos.update', projectId: pid, todos: [expect.objectContaining({ id: todo.id, done: false })] },
        { type: 'project.upsert', project: expect.objectContaining({ id: pid, openTodoCount: 1 }) },
      ]);
      sent.length = 0;
      await send(`/api/todos/${todo.id}`, { done: true }, 'PATCH');
      expect(sent).toEqual([
        { type: 'todos.update', projectId: pid, todos: [expect.objectContaining({ id: todo.id, done: true })] },
        { type: 'project.upsert', project: expect.objectContaining({ id: pid, openTodoCount: 0 }) },
      ]);
      sent.length = 0;
      await send(`/api/todos/${todo.id}`, undefined, 'DELETE');
      expect(sent).toEqual([{ type: 'todos.update', projectId: pid, todos: [] }, { type: 'project.upsert', project: expect.objectContaining({ id: pid }) }]);
    });

    it('メモを書くと、memo.update と、メモの頭を載せた project.upsert が 1 回ずつ届く', async () => {
      const pid = list0ProjectId();
      await send(`/api/projects/${pid}/memo`, { markdown: '# 見出し\n本文' }, 'PUT');
      expect(sent).toEqual([
        { type: 'memo.update', memo: expect.objectContaining({ projectId: pid, markdown: '# 見出し\n本文' }) },
        { type: 'project.upsert', project: expect.objectContaining({ id: pid, memoHead: '# 見出し' }) },
      ]);
    });

    it('URL を足すと artifact.upsert が 1 回だけ届く。同じ URL をもう一度足しても、行が変わらないので届かない', async () => {
      const pid = list0ProjectId();
      const url = 'https://claude.ai/code/artifact/abc123';
      const a = await (await send(`/api/projects/${pid}/artifacts`, { url })).json();
      expect(sent).toEqual([{ type: 'artifact.upsert', artifact: a }]);
      sent.length = 0;
      const again = await send(`/api/projects/${pid}/artifacts`, { url });
      expect(again.status).toBe(201);
      expect((await again.json()).id).toBe(a.id);
      expect(sent).toEqual([]);
    });
  });
});
