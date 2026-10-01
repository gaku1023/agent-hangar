import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchParams, ReadinessDto, LaunchResultDto, LiveSessionDto, ResumeHereConflictDto, RetentionDto, RunDto, ServerEvent, SettingsDto, SummarizerTestDto, SyncStatusDto, TabDto } from '@agent-hangar/shared';
import { RetentionConflictError } from '../config/retention.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { MemoStore } from '../projects/memo.ts';
import { PromoteError } from '../projects/promote.ts';
import { proposeTodoDone } from '../projects/todos.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { RunError } from '../runs/manager.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { createApp, type AppDeps, type ConfigSyncApi, type ExternalApi, type RunsApi, type SummaryApi, type SummaryEnqueueOpts, type SyncApi } from './app.ts';

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
    start: vi.fn((p: LaunchParams): LaunchResultDto => { if (!p.projectId) throw new RunError(400, 'プロジェクトを選んでください'); return launched; }),
    resume: vi.fn((id: string): LaunchResultDto => { if (id === 'busy') throw new RunError(409, '実行中です'); return { ...launched, run: { ...run, kind: 'resume' } }; }),
    fork: vi.fn((): LaunchResultDto => ({ ...launched, sessionId: 's2', run: { ...run, kind: 'fork', sessionId: 's2' } })),
    attach: vi.fn((id: string): LaunchResultDto => { if (id === 'busy') throw new RunError(409, '実行中です'); return { ...launched, run: { ...run, kind: 'resume' } }; }),
    adopt: vi.fn(async (id: string): Promise<LaunchResultDto> => { if (id === 'busy') throw new RunError(409, '作業中です'); return { ...launched, run: { ...run, kind: 'resume' } }; }),
    kill: vi.fn((id: string): RunDto => { if (id !== 'r1') throw new RunError(404, '起動した Claude が見つかりません'); return { ...run, endedAt: 2, endReason: 'killed' }; }),
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
    jumpToPrompt: vi.fn(async (id: string) => { if (id === 'dead') throw new RunError(409, 'この Claude はもう終了しています'); return { found: true as const }; }),
    leaveTranscript: vi.fn(async () => ({ left: true })),
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

/** 同期の偽物。呼ばれた順を calls に残すので、経路が本当に部品を呼んだかを見られる。 */
const syncStatus: SyncStatusDto = { state: 'idle', url: 'https://h', lastPushAt: 100, lastPullAt: 200, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false } };
const calls: string[] = [];
let skipped: { key: string; attempts: number; message: string }[] = [];
let sweepPending: number | null = null;
let resumeHereResult: LaunchResultDto | ResumeHereConflictDto = launched;
const fakeSync = (): SyncApi => ({
  status: () => syncStatus,
  syncNow: async () => { calls.push('syncNow'); },
  setPaused: (p: boolean) => { calls.push(`pause:${p}`); },
  onFocus: async () => { calls.push('focus'); },
  pullBeforeLaunch: async () => { calls.push('beforeLaunch'); return true; },
});
const fakeConfigSync = (): ConfigSyncApi => ({
  preview: () => ({ entries: [{ path: 'CLAUDE.md', action: 'create' as const, localMtime: null, remoteMtime: 5, remoteDevice: 'mini', size: 3 }], confirmed: false }),
  pull: async () => { calls.push('configPull'); return { applied: 1, conflicts: 0 }; },
});
const READY: ReadinessDto = {
  tools: { tmux: { path: '/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: null, ok: false, problem: 'unset', version: null }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/w', exists: true, projectCount: 1 }, mcp: { registered: false, file: '/h/.claude.json' }, statusline: { command: null, scriptPath: null, installed: false },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
};
const RET: RetentionDto = { days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null, usage: null };
function fakeRetention() {
  return {
    current: vi.fn(() => RET),
    preview: vi.fn((days: number) => ({ days, path: '/c/settings.json', lines: [], baseSha256: 'abc', backupDir: '/h/backups/claude-config', projectedBytes: null })),
    write: vi.fn((days: number, sha: string): RetentionDto => { if (sha === 'stale') throw new RetentionConflictError(); return { ...RET, days, source: 'user', userValue: days }; }),
  };
}
/** 実行できる空のファイルを ws/bin に置く。パスの欄は保存の前に存在と実行権を確かめるので、実物が要る。 */
const exe = (name: string): string => {
  const p = path.join(ws, 'bin', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
  return p;
};
const syncDeps = () => ({
  sync: fakeSync(),
  syncSkipped: () => skipped,
  syncSweep: () => sweepPending,
  configSync: fakeConfigSync(),
  resumeHere: (id: string, overwrite: boolean) => { calls.push(`resumeHere:${id}:${overwrite}`); return resumeHereResult; },
  joinToken: () => 'tok-abc' as string | null,
  devices: () => [{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: 1, self: true, shell: null }],
  shellHook: () => ({ state: 'off' as const, zshrc: '/Users/me/.zshrc', line: 'x  # agent-hangar', command: 'hangar shell install' }),
  retention: fakeRetention(),
  readiness: async () => READY,
});

beforeEach(async () => {
  calls.length = 0;
  skipped = [];
  sweepPending = null;
  resumeHereResult = launched;
  dir = copyFixtureClaudeDir(); db = openDb(':memory:'); sent.length = 0;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-app-'));
  fs.mkdirSync(`${ws}/alpha`);
  const indexer = new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false });
  await indexer.fullScan();
  db.prepare('update sessions set cwd = ? where provider_session_id = ?').run(`${ws}/alpha`, SESSION_ALPHA);
  syncProjectsFromWorkspace(db, 'd', ws); assignSessions(db, 'd');
  let settings: SettingsDto = { workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null };
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
    ...syncDeps(),
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

  // .app は起動のたびに 4177 の /health を叩き、200 かつ ok が真で version が文字列のときだけ
  // 「hangar がいる」と見なす（apps/desktop/src-tauri/src/health.rs の is_healthy がこれに依存している）。
  // version を外すと .app は既存のサーバを見つけられず、同梱サーバの起動も諦める。
  // 片側だけ変えられないよう、応答の形をここで固定する。
  // .app は /health が返った後も ready が真になるまで起動画面に残り、index の件数を起動画面に出す（lib.rs の wait_for_ready）。
  // 鍵の要らない経路なので、載せるのは段階と件数だけにする。
  it('/health は ok と文字列の version に、起動が済んだかと索引の進み具合を添えて返す', async () => {
    const res = await get('/health', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: unknown };
    const total = deps.indexer.progress().total;
    expect(total).toBeGreaterThan(0);
    expect(body).toEqual({ ok: true, version: '0.0.0-test', ready: true, index: { phase: 'idle', done: total, total } });
    expect(typeof body.version).toBe('string');
  });
  it('起動の途中の /health は ready を偽にし、索引の今の件数を返す', async () => {
    const booting = createApp({ ...deps, ready: () => false, indexer: { progress: () => ({ phase: 'indexing', done: 412, total: 987 }), rebuild: async () => {} } });
    const body = await (await booting.request('/health')).json();
    expect(body).toEqual({ ok: true, version: '0.0.0-test', ready: false, index: { phase: 'indexing', done: 412, total: 987 } });
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
    expect(await r.json()).toEqual({ error: 'このセッションの本文はこの PC にありません' });
  });
  it('GET /api/sessions/:id/live はライブの要約を返し、無いセッションは 404', async () => {
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    const r = await json(await get(`/api/sessions/${id}/live`));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sessionId: id, intent: null });
    expect(Array.isArray(r.body.agents)).toBe(true);
    expect((await get('/api/sessions/ghost/live')).status).toBe(404);
  });
  it('検索', async () => {
    const { body } = await json(await get('/api/search?q=' + encodeURIComponent('チャンネル')));
    expect(body.total).toBe(1);
    expect((await json(await get('/api/search?q=channels'))).body.hits).toHaveLength(1);
    expect((await json(await get('/api/search?q='))).body).toEqual({ hits: [], total: 0 });
    // キーワードが無くても、触ったファイルで絞れる。
    expect((await json(await get('/api/search?q=&file=a.md'))).body.total).toBe(1);
    // 続きは offset で読む。件数は全件のまま。
    expect((await json(await get('/api/search?q=channels&offset=1'))).body).toEqual({ hits: [], total: 1 });
  });
  it('検索の状態の絞り込みは、実行中（作業中、休み、起動中）、入力待ち、終了に分ける', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    const total = async (live: string) => (await json(await get(`/api/search?q=channels&live=${live}`))).body.total;
    // run も Claude の一覧も無ければ終了。
    expect(await total('ended')).toBe(1);
    expect(await total('running')).toBe(0);
    // hangar の run が生きていれば、Claude の一覧に載る前でも起動中として実行中に数える。
    vi.mocked(runs.listAlive).mockReturnValue({ runs: [{ ...run, sessionId: alpha.id }], tabs: [] });
    expect(await total('running')).toBe(1);
    expect(await total('ended')).toBe(0);
    // 入力待ちは run があっても実行中に入れず、別に数える。
    const waiting: LiveSessionDto = { sessionId: SESSION_ALPHA, status: 'waiting', name: null, nameSource: null, cwd: ws, pid: 1 };
    app = createApp({ ...deps, live: () => [waiting] });
    expect(await total('waiting')).toBe(1);
    expect(await total('running')).toBe(0);
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
    vi.stubEnv('PATH', `/no/such/dir:${bin}`);
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
    try {
      const r = await patch({ codePath: '~/bin/hometool' });
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
    expect((await json(await get('/api/settings'))).body).toEqual({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null });
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
    expect(body.settings).toEqual({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null });
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
    expect((await post('/api/sessions/s1/attach')).status).toBe(201);
    expect((await post('/api/sessions/busy/attach')).status).toBe(409);
    expect((await post('/api/sessions/s1/adopt')).status).toBe(201);
    const a = await post('/api/sessions/busy/adopt');
    expect(a.status).toBe(409);
    expect((await a.json()).error).toBe('作業中です');
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
  it('指示へ跳ぶ、transcript を閉じる', async () => {
    const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const r = await post('/api/runs/r1/jump', { heads: ['一つめ', '二つめ'], index: 0, from: 'bottom' });
    expect(await r.json()).toEqual({ found: true });
    expect(runs.jumpToPrompt).toHaveBeenCalledWith('r1', ['一つめ', '二つめ'], 0, 'bottom');
    // 形の崩れた本文は RunManager に渡さない。長すぎる書き出し、範囲外の index、知らない向き。
    expect((await post('/api/runs/r1/jump', { heads: ['x'.repeat(17)], index: 0, from: 'top' })).status).toBe(400);
    expect((await post('/api/runs/r1/jump', { heads: ['a'], index: 1, from: 'top' })).status).toBe(400);
    expect((await post('/api/runs/r1/jump', { heads: ['a'], index: 0, from: 'side' })).status).toBe(400);
    expect((await post('/api/runs/r1/jump', { heads: Array(1001).fill('a'), index: 0, from: 'top' })).status).toBe(400);
    expect(runs.jumpToPrompt).toHaveBeenCalledTimes(1);
    expect((await post('/api/runs/dead/jump', { heads: ['a'], index: 0, from: 'top' })).status).toBe(409);
    expect(await (await post('/api/runs/r1/leave-transcript')).json()).toEqual({ left: true });
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
    // 終わった画面の右欄（変更したファイル）から、そのセッションが変えたファイルだけを開ける。
    const edited = '/Users/me/workspace/alpha/channels/a.md';
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: edited })).status).toBe(404);
    db.prepare('update event_index set file_path = ? where file_path = ?').run(`${ws}/alpha/a.md`, edited);
    fs.writeFileSync(`${ws}/alpha/a.md`, 'y');
    fs.writeFileSync(`${ws}/alpha/other.md`, 'z');
    (external.openEditor as ReturnType<typeof vi.fn>).mockClear();
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/a.md` })).status).toBe(204);
    expect(external.openEditor).toHaveBeenLastCalledWith({ target: `${ws}/alpha/a.md` });
    // あるファイルでも、そのセッションが変えていなければ開かない。
    // 綴りを変えて枠の外へ出るパスも同じ。
    const other = await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/other.md` });
    expect(other.status).toBe(404);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/x/../a.md` })).status).toBe(404);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: 'a.md' })).status).toBe(400);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: 3 })).status).toBe(400);
    // 別のセッションが編集したパスと、このセッションが読んだだけのパスは開かない。
    const indexRow = db.prepare("insert into event_index (session_id, seq, kind, byte_offset, byte_length, file_path_ref, tool_name, file_path) values (?, ?, 'tool_call', 0, 0, 'x', ?, ?)");
    indexRow.run('another-session', 900_001, 'Edit', `${ws}/alpha/other.md`);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/other.md` })).status).toBe(404);
    fs.writeFileSync(`${ws}/alpha/read.md`, 'r');
    indexRow.run(alpha.id, 900_002, 'Read', `${ws}/alpha/read.md`);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/read.md` })).status).toBe(404);
    // 変えたファイルが、その後ディレクトリに替わっていたら開かない。
    fs.mkdirSync(`${ws}/alpha/became-dir`);
    indexRow.run(alpha.id, 900_003, 'Write', `${ws}/alpha/became-dir`);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/became-dir` })).status).toBe(404);
    expect(external.openEditor).toHaveBeenCalledTimes(1);
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
      const uiSettings = { workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null };
      const ui = createApp({ db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, port: 4177, version: 'v', settings: () => uiSettings, updateSettings: () => uiSettings, live: () => [], indexer: { progress: () => ({ phase: 'idle', done: 0, total: 0 }), rebuild: async () => {} }, hub: { broadcast: () => {} }, runs: fakeRuns(), external: fakeExternal(), usage: new UsageTracker(db), memos, summary: fakeSummary(), promote: () => ({ projectId: list0ProjectId(), moved: false, reason: null }), ...syncDeps(), uiDist: dist });
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
      const uiSettings = { workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null };
      const ui = createApp({ db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, port: 4177, version: 'v', settings: () => uiSettings, updateSettings: () => uiSettings, live: () => [], indexer: { progress: () => ({ phase: 'idle', done: 0, total: 0 }), rebuild: async () => {} }, hub: { broadcast: () => {} }, runs: fakeRuns(), external: fakeExternal(), usage: new UsageTracker(db), memos, summary: fakeSummary(), promote: () => ({ projectId: list0ProjectId(), moved: false, reason: null }), ...syncDeps(), uiDist: dist });
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
    skipped = [{ key: 'transcripts/mini/u1.jsonl.gz', attempts: 3, message: '復号できません' }];
    expect((await json(await get('/api/sync/status'))).body.skipped).toEqual(skipped);
    expect((await json(await get('/api/bootstrap'))).body.sync.skipped).toEqual(skipped);
  });

  it('取り残しの残り件数が同期の状態に乗る', async () => {
    // 数えられないときは null で、0 件（追いついた）と区別できる。
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBeNull();
    sweepPending = 1500;
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBe(1500);
    expect((await json(await get('/api/bootstrap'))).body.sync.sweepPending).toBe(1500);
    // 今すぐ同期と一時停止の応答も同じ形で返す。画面はこの 3 つから付録を受け取る。
    expect((await json(await post('/api/sync/now'))).body.sweepPending).toBe(1500);
    expect((await json(await post('/api/sync/pause', { paused: true }))).body.sweepPending).toBe(1500);
    sweepPending = 0;
    expect((await json(await get('/api/sync/status'))).body.sweepPending).toBe(0);
  });

  it('掃除の口を渡さない端末では取り残しは null のまま', async () => {
    const { syncSweep: _drop, ...rest } = syncDeps();
    app = createApp({ ...deps, ...rest });
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

  it('同期が未設定なら設定の経路は 404 で、参加トークンは null', async () => {
    app = createApp({ ...deps, configSync: null, joinToken: () => null });
    expect((await get('/api/sync/config/preview')).status).toBe(404);
    expect((await post('/api/sync/config/pull')).status).toBe(404);
    expect((await json(await get('/api/sync/joinToken'))).body).toEqual({ token: null });
  });

  it('この PC で再開は 409 で写しとの大きさを返す', async () => {
    const id = (await json(await get('/api/sessions'))).body[0].id;
    expect((await json(await post(`/api/sessions/${id}/resume-here`))).body.sessionId).toBe('s1');
    resumeHereResult = { error: 'local_smaller', localSize: 10, remoteSize: 99 };
    const r = await json(await post(`/api/sessions/${id}/resume-here`, { overwrite: false }));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'local_smaller', localSize: 10, remoteSize: 99 });
    expect(calls).toEqual([`resumeHere:${id}:false`, `resumeHere:${id}:false`]);
  });

  it('この PC で再開の RunError は status と理由を返す', async () => {
    app = createApp({ ...deps, resumeHere: () => { throw new RunError(400, 'このセッションの本文がありません'); } });
    const r = await json(await post('/api/sessions/s1/resume-here', { overwrite: true }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'このセッションの本文がありません' });
  });

  it('起動と再開とフォークの前に pull を待つ', async () => {
    await post('/api/runs', { projectId: 'p1', name: 'n' });
    await post('/api/sessions/s1/resume');
    await post('/api/sessions/s1/fork');
    expect(calls.filter((c) => c === 'beforeLaunch')).toHaveLength(3);
  });

  it('他端末で走っている run はロックとして出る', async () => {
    // listSessions と getSession に自端末の ID を渡さないと、ロックは一切出ない。
    const all = (await json(await get('/api/sessions'))).body as { id: string; projectId: string | null }[];
    const target = all.find((s) => s.projectId !== null)!;
    const id = target.id;
    upsertShared(db, 'devices', { id: 'mini', name: 'mini', platform: 'darwin', last_seen_at: Date.now(), deleted_at: null }, 'mini');
    upsertShared(db, 'runs', {
      id: 'remote-run', session_id: id, device_id: 'mini', kind: 'start', tmux_name: 'hangar-remote',
      pid: null, launch_params: '{}', started_at: Date.now(), ended_at: null, end_reason: null, heartbeat_at: Date.now(), deleted_at: null,
    }, 'mini');
    const lock = { deviceId: 'mini', deviceName: 'mini', runId: 'remote-run', stale: false };
    expect((await json(await get('/api/sessions'))).body.find((s: { id: string }) => s.id === id).lock).toMatchObject(lock);
    expect((await json(await get(`/api/sessions/${id}`))).body.lock).toMatchObject(lock);
    expect((await json(await get('/api/bootstrap'))).body.sessions.find((s: { id: string }) => s.id === id).lock).toMatchObject(lock);
    const byProject = (await json(await get(`/api/sessions?projectId=${target.projectId!}`))).body as { id: string; lock: unknown }[];
    expect(byProject.find((s) => s.id === id)?.lock).toMatchObject(lock);
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
