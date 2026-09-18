import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchParams, LaunchResultDto, RunDto, ServerEvent, SettingsDto, SummarizerTestDto, TabDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { MemoStore } from '../projects/memo.ts';
import { PromoteError } from '../projects/promote.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { RunError } from '../runs/manager.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { createApp, type AppDeps, type ExternalApi, type RunsApi, type SummaryApi, type SummaryEnqueueOpts } from './app.ts';

let dir: string;
let db: Db;
let ws: string;
let app: ReturnType<typeof createApp>;
let deps: AppDeps;
const sent: ServerEvent[] = [];
const TOKEN = 'test-token';
const H = { authorization: `Bearer ${TOKEN}` };
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

const run: RunDto = { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 };
const agentTab: TabDto = { id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null };
const shellTab: TabDto = { id: 't1', runId: 'r1', sessionId: 's1', kind: 'shell', title: 'シェル 1', tmuxName: 'hangar-r1-t1', createdAt: 2, closedAt: null };
const launched: LaunchResultDto = { run, sessionId: 's1', tabs: [agentTab] };
const endedRun: RunDto = { ...run, id: 'dead', tmuxName: 'hangar-dead', endedAt: 9, endReason: 'exited' };
const deadAgentTab: TabDto = { ...agentTab, id: 'dead', runId: 'dead', tmuxName: 'hangar-dead' };
const deadShellTab: TabDto = { ...shellTab, id: 'dead-t1', runId: 'dead', tmuxName: 'hangar-dead-t1' };
let runs: RunsApi;
let external: ExternalApi;
let usage: UsageTracker;
let memos: MemoStore;
let summary: SummaryApi & { enqueued: [string, SummaryEnqueueOpts | undefined][] };
/** ワークスペースから登録される唯一のプロジェクト alpha の id。 */
let list0ProjectId: () => string;
const testResult: SummarizerTestDto = { ok: true, id: 'lmstudio', ms: 5, summary: { title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [], source: 'post_hoc', sourceId: 'lmstudio', sourceModel: null, basedOnTurns: 3 } };

/** 経路の検査だけをしたいので、RunManager は呼び出しを記録する偽物に差し替える。 */
function fakeRuns(): RunsApi {
  return {
    start: vi.fn((p: LaunchParams): LaunchResultDto => { if (!p.projectId) throw new RunError(400, 'projectId は必須です'); return launched; }),
    resume: vi.fn((id: string): LaunchResultDto => { if (id === 'busy') throw new RunError(409, '実行中です'); return { ...launched, run: { ...run, kind: 'resume' } }; }),
    fork: vi.fn((): LaunchResultDto => ({ ...launched, sessionId: 's2', run: { ...run, kind: 'fork', sessionId: 's2' } })),
    kill: vi.fn((id: string): RunDto => { if (id !== 'r1') throw new RunError(404, 'run が見つかりません'); return { ...run, endedAt: 2, endReason: 'killed' }; }),
    openTab: vi.fn((): TabDto => shellTab),
    closeTab: vi.fn((): TabDto => ({ ...shellTab, closedAt: 3 })),
    listAlive: vi.fn((): { runs: RunDto[]; tabs: TabDto[] } => ({ runs: [run], tabs: [agentTab, shellTab] })),
    getRun: vi.fn((id: string): RunDto | null => (id === 'r1' ? run : id === 'dead' ? endedRun : null)),
    getTab: vi.fn((id: string): TabDto | null => (id === 't1' ? shellTab : id === 'r1' ? agentTab : id === 'dead' ? deadAgentTab : id === 'dead-t1' ? deadShellTab : null)),
    // 終了した run の Claude のタブだけは繋がせない。繋ぎ先の tmux セッションがもう無い。
    attachTarget: vi.fn((id: string): TabDto | null => {
      const t = id === 't1' ? shellTab : id === 'r1' ? agentTab : id === 'dead' ? deadAgentTab : id === 'dead-t1' ? deadShellTab : null;
      return t && t.kind === 'agent' && t.runId === 'dead' ? null : t;
    }),
  };
}

function fakeExternal(): ExternalApi {
  return {
    openTerminal: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })),
    openDirTerminal: vi.fn(async () => ({ app: 'iterm' as const, fellBack: true })),
    openEditor: vi.fn(async () => {}),
    openUrl: vi.fn(async () => {}),
  };
}

function fakeSummary(): SummaryApi & { enqueued: [string, SummaryEnqueueOpts | undefined][] } {
  const s: SummaryApi & { enqueued: [string, SummaryEnqueueOpts | undefined][] } = {
    enqueued: [],
    enqueue: (id, opts) => { s.enqueued.push([id, opts]); return true; },
    pending: () => ['pending-1'],
    test: async () => testResult,
    listModels: async () => ['gemma'],
  };
  return s;
}

beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:'); sent.length = 0;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-app-'));
  fs.mkdirSync(`${ws}/alpha`);
  const indexer = new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false });
  await indexer.fullScan();
  db.prepare('update sessions set cwd = ? where provider_session_id = ?').run(`${ws}/alpha`, SESSION_ALPHA);
  syncProjectsFromWorkspace(db, 'd', ws); assignSessions(db, 'd');
  let settings: SettingsDto = { workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false };
  runs = fakeRuns();
  external = fakeExternal();
  usage = new UsageTracker(db);
  memos = new MemoStore({ db, deviceId: 'd', home: ws });
  summary = fakeSummary();
  list0ProjectId = () => (db.prepare("select id from projects where name = 'alpha'").get() as { id: string }).id;
  deps = {
    db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, port: 4177, version: '0.0.0-test',
    settings: () => settings, updateSettings: (p) => (settings = { ...settings, ...p }), live: () => [], indexer,
    hub: { broadcast: (e) => sent.push(e) }, runs, external, usage, memos, summary,
    promote: (o) => { if (o.name === 'taken') throw new PromoteError(409, 'あります'); return { projectId: list0ProjectId(), moved: o.moveFiles, reason: null }; },
  };
  app = createApp(deps);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); });

describe('auth', () => {
  it('トークンが無ければ 401、Origin が違えば 403、/health は素通し', async () => {
    expect((await get('/api/bootstrap', {})).status).toBe(401);
    expect((await get('/api/bootstrap', { ...H, origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('/api/bootstrap', { cookie: `hangar_token=${TOKEN}` })).status).toBe(200);
    expect((await get('/health', {})).status).toBe(200);
  });
  it('許可する Origin は実際に待ち受けているポートに追随する', async () => {
    // 4177 以外で立てたとき、UI はそのポートの Origin を送る。決め打ちだと書き込みが全部 403 になる。
    const other = createApp({ ...deps, port: 4198 });
    // 403 かどうかだけを見たいので、状態を変えない本文を送る（存在しない path なので 400 になる）。
    const req = (origin: string) => other.request('/api/projects', { method: 'POST', headers: { ...H, origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', path: '/nonexistent' }) });
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
    const body = JSON.stringify({ name: 'x', path: '/nonexistent' });
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
    expect((await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', path: '/nonexistent' }) })).status).toBe(400);
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
      const viaProxy = await app.request('/api/projects', { method: 'POST', headers: { ...H, origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', path: '/nonexistent' }) });
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
    expect((await json(await get(`/api/projects/${id}/candidates?name=alp`))).body).toEqual([`${ws}/alpha`]);
    const r2 = await app.request(`/api/projects/${id}/resolve`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'archive' }) });
    expect((await r2.json()).status).toBe('archived');
    expect((await get('/api/projects/nope')).status).toBe(404);
    const bad = await app.request(`/api/projects/${id}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'bogus' }) });
    expect(bad.status).toBe(400);
  });
  it('セッションと本文とサブエージェント', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    expect((await json(await get(`/api/sessions/${alpha.id}`))).body.name).toBe('channels-cleanup');
    const { body: page } = await json(await get(`/api/sessions/${alpha.id}/events?fromSeq=0&limit=5`));
    expect(page.events).toHaveLength(5);
    expect(page.nextSeq).toBe(5);
    expect((await json(await get(`/api/sessions/${alpha.id}/subagents`))).body).toEqual(['abc123']);
    expect((await json(await get(`/api/sessions/${alpha.id}/events?agentId=abc123`))).body.events).toHaveLength(2);
    expect((await get('/api/sessions/nope')).status).toBe(404);
  });
  it('本文は最新の側からも、その手前へも読める', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    const { body: latest } = await json(await get(`/api/sessions/${alpha.id}/events?latest=1&limit=5`));
    expect(latest.events.map((e: { seq: number }) => e.seq)).toEqual([12, 13, 14, 15, 16]);
    expect(latest.total).toBe(17);
    // 末尾から読んだページに「次の前向きのページ」は無い。
    expect(latest.nextSeq).toBeNull();
    const { body: older } = await json(await get(`/api/sessions/${alpha.id}/events?before=12&limit=5`));
    expect(older.events.map((e: { seq: number }) => e.seq)).toEqual([7, 8, 9, 10, 11]);
    // 先頭より古い行は無い。
    expect((await json(await get(`/api/sessions/${alpha.id}/events?before=0`))).body.events).toEqual([]);
  });
  it('本文ファイルが消えていれば 404', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    for (const f of fs.readdirSync(path.join(dir, 'projects'), { recursive: true }) as string[]) {
      if (f.includes(SESSION_ALPHA) && f.endsWith('.jsonl')) fs.rmSync(path.join(dir, 'projects', f));
    }
    const r = await get(`/api/sessions/${alpha.id}/events`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'このセッションの本文ファイルが見つかりません。Settings の「索引を作り直す」を試してください' });
  });
  it('検索', async () => {
    const { body } = await json(await get('/api/search?q=' + encodeURIComponent('チャンネル')));
    expect(body.total).toBe(1);
    expect((await json(await get('/api/search?q=channels'))).body.hits).toHaveLength(1);
    expect((await json(await get('/api/search?q='))).body).toEqual({ hits: [], total: 0 });
  });
  it('設定の取得と更新', async () => {
    expect((await json(await get('/api/settings'))).body.workspaceRoot).toBe(ws);
    const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceRoot: '/tmp/x' }) });
    expect((await r.json()).workspaceRoot).toBe('/tmp/x');
    expect(sent.some((e) => e.type === 'toast' && e.level === 'info')).toBe(true);
  });
  it('設定の更新は既知の項目だけを受け、値が空なら 400', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await patch({ workspaceRoot: '' })).status).toBe(400);
    expect((await patch({ workspaceRoot: 123 })).status).toBe(400);
    expect((await patch({ claudeDir: '  ' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ token: 'stolen' })).status).toBe(400);
    expect((await json(await get('/api/settings'))).body).toEqual({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false });
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
    expect(body.settings).toEqual({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false });
  });
  it('起動、再開、フォーク、停止', async () => {
    const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const r = await post('/api/runs', { projectId: 'p1', name: 'n' });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual(launched);
    expect(runs.start).toHaveBeenCalledWith({ projectId: 'p1', name: 'n' });
    expect((await post('/api/runs', {})).status).toBe(400);
    expect((await post('/api/runs')).status).toBe(400);
    expect((await post('/api/sessions/s1/resume')).status).toBe(201);
    expect((await post('/api/sessions/busy/resume')).status).toBe(409);
    const f = await post('/api/sessions/s1/fork');
    expect((await f.json()).sessionId).toBe('s2');
    const k = await app.request('/api/runs/r1', { method: 'DELETE', headers: H });
    expect((await k.json()).endReason).toBe('killed');
    expect((await app.request('/api/runs/nope', { method: 'DELETE', headers: H })).status).toBe(404);
    expect((await json(await get('/api/runs'))).body.tabs).toHaveLength(2);
  });
  it('タブの追加と削除', async () => {
    const r = await app.request('/api/runs/r1/tabs', { method: 'POST', headers: H });
    expect(r.status).toBe(201);
    expect((await r.json()).tmuxName).toBe('hangar-r1-t1');
    const d = await app.request('/api/runs/r1/tabs/t1', { method: 'DELETE', headers: H });
    expect((await d.json()).closedAt).toBe(3);
    expect(runs.closeTab).toHaveBeenCalledWith('t1');
    // 別の run の URL から他人のタブを閉じさせない。閉じると相手の tmux セッションが落ちる。
    expect((await app.request('/api/runs/r2/tabs/t1', { method: 'DELETE', headers: H })).status).toBe(404);
    expect((await app.request('/api/runs/r1/tabs/nope', { method: 'DELETE', headers: H })).status).toBe(404);
    expect(runs.closeTab).toHaveBeenCalledTimes(1);
  });
  it('ターミナルで開く、VS Code で開く', async () => {
    const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(await (await post('/api/runs/r1/open-terminal', { tabId: 't1' })).json()).toEqual({ app: 'terminal', fellBack: false });
    expect(external.openTerminal).toHaveBeenCalledWith({ tmuxName: 'hangar-r1-t1' });
    await post('/api/runs/r1/open-terminal', {});
    expect(external.openTerminal).toHaveBeenLastCalledWith({ tmuxName: 'hangar-r1' });
    expect((await post('/api/runs/r1/open-terminal', { tabId: 'nope' })).status).toBe(404);
    expect((await post('/api/runs/nope/open-terminal', {})).status).toBe(404);
    // 終了した run の Claude のタブは開かせない。素の名前で attach すると同じ run のシェルタブに落ちる。
    expect((await post('/api/runs/dead/open-terminal', {})).status).toBe(409);
    expect((await post('/api/runs/dead/open-terminal', { tabId: 'dead' })).status).toBe(409);
    // シェルタブは run が終わった後も開いてよい。
    expect((await post('/api/runs/dead/open-terminal', { tabId: 'dead-t1' })).status).toBe(200);
    expect(external.openTerminal).toHaveBeenLastCalledWith({ tmuxName: 'hangar-dead-t1' });
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`)).status).toBe(204);
    expect(external.openEditor).toHaveBeenCalledWith({ target: `${ws}/alpha` });
    expect((await post('/api/sessions/nope/open-editor')).status).toBe(404);
    const { body: list } = await json(await get('/api/projects'));
    expect((await post(`/api/projects/${list[0].id}/open-editor`)).status).toBe(204);
    expect(await (await post(`/api/projects/${list[0].id}/open-terminal`)).json()).toEqual({ app: 'iterm', fellBack: true });
    (external.openEditor as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('code が無い'));
    const bad = await post(`/api/sessions/${alpha.id}/open-editor`);
    expect(bad.status).toBe(500);
    expect((await bad.json()).error).toBe('code が無い');
  });
  it('外部連携の失敗は、トークンを伏せて 1 行に切り詰めて返す', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    const fail = (message: string) => (external.openEditor as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(message));
    fail(`spawn failed: --mcp-config {"token":"${TOKEN}"}\n2 行目`);
    const r = await post(`/api/sessions/${alpha.id}/open-editor`);
    expect(r.status).toBe(500);
    const msg = (await r.json()).error as string;
    expect(msg).not.toContain(TOKEN);
    expect(msg).toContain('***');
    expect(msg).not.toContain('2 行目');
    fail('あ'.repeat(500));
    const long = await post(`/api/sessions/${alpha.id}/open-editor`);
    expect(((await long.json()).error as string).length).toBeLessThanOrEqual(201);
  });
  it('プロジェクトの作成', async () => {
    fs.mkdirSync(`${ws}/beta`);
    const r = await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'beta', path: `${ws}/beta` }) });
    expect(r.status).toBe(201);
    const p = await r.json();
    expect(p).toMatchObject({ name: 'beta', path: `${ws}/beta`, resolved: true, status: 'active' });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: p.id } });
    expect((await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', path: '/nonexistent' }) })).status).toBe(400);
    expect((await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: '', path: ws }) })).status).toBe(400);
    // .. を含むパスは正規化してから入れる。生のまま入れると前方一致でセッションが当たらなくなる。
    const again = await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'beta again', path: `${ws}/beta/../beta` }) });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(p.id);
    expect(db.prepare('select count(*) c from project_roots where deleted_at is null').get()).toEqual({ c: 2 });
    expect(db.prepare("select count(*) c from project_roots where path like '%..%'").get()).toEqual({ c: 0 });
  });
  it('設定の新しい項目を検査する', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(await (await patch({ terminalApp: 'iterm', tmuxPath: '/opt/homebrew/bin/tmux' })).json()).toMatchObject({ terminalApp: 'iterm', tmuxPath: '/opt/homebrew/bin/tmux' });
    expect((await patch({ terminalApp: 'kitty' })).status).toBe(400);
    expect((await patch({ tmuxPath: 3 })).status).toBe(400);
    expect((await (await patch({ codePath: null })).json()).codePath).toBeNull();
  });
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const alphaId = async () => { const { body } = await json(await get('/api/sessions')); return body.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA).id as string; };

  it('statusline の受け口と使用量', async () => {
    const first = { session_id: SESSION_ALPHA, model: { id: 'claude-opus-4-1' }, effort: 'high', context_window: { context_window_size: 200000, current_usage: null } };
    expect((await post('/api/ingest/statusline', first)).status).toBe(204);
    expect(sent.filter((e) => e.type === 'usage.update')).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { providerSessionId: SESSION_ALPHA, stats: { model: 'claude-opus-4-1' } } });
    const second = { ...first, context_window: { context_window_size: 200000, current_usage: { input_tokens: 50000 } }, rate_limits: { five_hour: { used_percentage: 47, resets_at: 1 }, seven_day: { used_percentage: 7, resets_at: 2 } } };
    expect((await post('/api/ingest/statusline', second)).status).toBe(204);
    expect(sent.find((e) => e.type === 'usage.update')).toMatchObject({ usage: { fiveHour: { usedPercent: 47 }, sevenDay: { usedPercent: 7 } } });
    expect((await json(await get('/api/usage'))).body).toMatchObject({ fiveHour: { usedPercent: 47 } });
    expect((await json(await get(`/api/sessions/${await alphaId()}`))).body.stats.contextPercent).toBe(25);
    expect((await app.request('/api/ingest/statusline', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: 'not json' })).status).toBe(400);
    // 認証は他の /api と同じ。トークンが無ければ受け付けない。
    expect((await app.request('/api/ingest/statusline', { method: 'POST', body: '{}' })).status).toBe(401);
    const agg = await json(await get('/api/usage/aggregate?days=30'));
    expect(agg.status).toBe(200);
    expect(agg.body.projects.length).toBeGreaterThan(0);
    expect((await get('/api/usage/aggregate?days=0')).status).toBe(400);
    expect((await json(await get('/api/statusline'))).body).toEqual({ command: null, scriptPath: null, installed: false });
    expect((await json(await get('/api/bootstrap'))).body).toMatchObject({ usage: { fiveHour: { usedPercent: 47 } }, todos: [], artifacts: [], summaryPending: ['pending-1'] });
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
  it('セッションのメモ、昇格、要約', async () => {
    const id = await alphaId();
    const r = await post(`/api/sessions/${id}`, { memo: '一行' }, 'PATCH');
    expect((await r.json()).memo).toBe('一行');
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { id, memo: '一行' } });
    expect((await post('/api/sessions/nope', { memo: 'x' }, 'PATCH')).status).toBe(404);
    const p = await post(`/api/sessions/${id}/promote`, { name: 'newp', gitInit: false, moveFiles: true });
    expect(p.status).toBe(201);
    expect(await p.json()).toMatchObject({ moved: true, reason: null, project: { id: list0ProjectId() }, session: { id } });
    expect((await post(`/api/sessions/${id}/promote`, { name: 'taken', gitInit: false, moveFiles: false })).status).toBe(409);
    expect((await post(`/api/sessions/${id}/promote`, { gitInit: false })).status).toBe(400);
    const s = await post(`/api/sessions/${id}/summarize`);
    expect(s.status).toBe(202);
    // 手動の作り直しは土台かどうかもレジストリも問わない。
    expect(summary.enqueued).toContainEqual([id, { force: true }]);
    await get(`/api/sessions/${id}/events?latest=1`);
    // セッションを開いたときは既定のまま（土台かどうかとレジストリの両方を見る）。
    // 画面を開く呼び出しは最新の側を求める呼び出しなので、契機はそこに付ける。
    expect(summary.enqueued).toContainEqual([id, undefined]);
    summary.enqueued.length = 0;
    await get(`/api/sessions/${id}/events?fromSeq=5`);
    await get(`/api/sessions/${id}/events?before=5`);
    await get(`/api/sessions/${id}/events?latest=1&agentId=abc123`);
    expect(summary.enqueued).toEqual([]);
    expect((await json(await get('/api/summarizer/models'))).body).toEqual({ models: ['gemma'] });
    expect((await json(await post('/api/summarizer/test'))).body).toEqual(testResult);
  });
  it('要約の受け付けが投げても呼び手の操作は成立する', async () => {
    // 要約は補助の機能なので、受け付けに失敗しても 500 にしない。GET /events と同じ扱いにそろえる。
    const id = await alphaId();
    summary.enqueue = () => { throw new Error('要約器が壊れています'); };
    const r = await post(`/api/sessions/${id}/summarize`);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: false });
    expect((await get(`/api/sessions/${id}/events?latest=1`)).status).toBe(200);
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
      const uiSettings = { workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false };
      const ui = createApp({ db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, port: 4177, version: 'v', settings: () => uiSettings, updateSettings: () => uiSettings, live: () => [], indexer: { progress: () => ({ phase: 'idle', done: 0, total: 0 }), rebuild: async () => {} }, hub: { broadcast: () => {} }, runs: fakeRuns(), external: fakeExternal(), usage: new UsageTracker(db), memos, summary: fakeSummary(), promote: () => ({ projectId: list0ProjectId(), moved: false, reason: null }), uiDist: dist });
      // 鍵を持たない GET / にはクッキーを配らない。curl 1 本でトークンが取れてはいけない。
      const bare = await ui.request('/');
      expect(bare.status).toBe(401);
      expect(bare.headers.get('set-cookie')).toBeNull();
      const notice = await bare.text();
      expect(notice).not.toContain(TOKEN);
      expect(notice).toContain('hangar start');
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
      const uiSettings = { workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false };
      const ui = createApp({ db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, port: 4177, version: 'v', settings: () => uiSettings, updateSettings: () => uiSettings, live: () => [], indexer: { progress: () => ({ phase: 'idle', done: 0, total: 0 }), rebuild: async () => {} }, hub: { broadcast: () => {} }, runs: fakeRuns(), external: fakeExternal(), usage: new UsageTracker(db), memos, summary: fakeSummary(), promote: () => ({ projectId: list0ProjectId(), moved: false, reason: null }), uiDist: dist });
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
