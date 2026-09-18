import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchParams, LaunchResultDto, RunDto, ServerEvent, SettingsDto, TabDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { RunError } from '../runs/manager.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { createApp, type ExternalApi, type RunsApi } from './app.ts';

let dir: string;
let db: Db;
let ws: string;
let app: ReturnType<typeof createApp>;
const sent: ServerEvent[] = [];
const TOKEN = 'test-token';
const H = { authorization: `Bearer ${TOKEN}` };
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

const run: RunDto = { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 };
const agentTab: TabDto = { id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null };
const shellTab: TabDto = { id: 't1', runId: 'r1', sessionId: 's1', kind: 'shell', title: 'シェル 1', tmuxName: 'hangar-r1-t1', createdAt: 2, closedAt: null };
const launched: LaunchResultDto = { run, sessionId: 's1', tabs: [agentTab] };
let runs: RunsApi;
let external: ExternalApi;

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
    getRun: vi.fn((id: string): RunDto | null => (id === 'r1' ? run : null)),
    getTab: vi.fn((id: string): TabDto | null => (id === 't1' ? shellTab : id === 'r1' ? agentTab : null)),
  };
}

function fakeExternal(): ExternalApi {
  return {
    openTerminal: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })),
    openDirTerminal: vi.fn(async () => ({ app: 'iterm' as const, fellBack: true })),
    openEditor: vi.fn(async () => {}),
  };
}

beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:'); sent.length = 0;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-app-'));
  fs.mkdirSync(`${ws}/alpha`);
  const indexer = new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false });
  await indexer.fullScan();
  db.prepare('update sessions set cwd = ? where provider_session_id = ?').run(`${ws}/alpha`, SESSION_ALPHA);
  syncProjectsFromWorkspace(db, 'd', ws); assignSessions(db, 'd');
  let settings: SettingsDto = { workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null };
  runs = fakeRuns();
  external = fakeExternal();
  app = createApp({ db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, port: 4177, version: '0.0.0-test', settings: () => settings, updateSettings: (p) => (settings = { ...settings, ...p }), live: () => [], indexer, hub: { broadcast: (e) => sent.push(e) }, runs, external });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); });

describe('auth', () => {
  it('トークンが無ければ 401、Origin が違えば 403、/health は素通し', async () => {
    expect((await get('/api/bootstrap', {})).status).toBe(401);
    expect((await get('/api/bootstrap', { ...H, origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('/api/bootstrap', { cookie: `hangar_token=${TOKEN}` })).status).toBe(200);
    expect((await get('/health', {})).status).toBe(200);
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
  it('本文ファイルが消えていれば 404', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    for (const f of fs.readdirSync(path.join(dir, 'projects'), { recursive: true }) as string[]) {
      if (f.includes(SESSION_ALPHA) && f.endsWith('.jsonl')) fs.rmSync(path.join(dir, 'projects', f));
    }
    const r = await get(`/api/sessions/${alpha.id}/events`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'transcript not found' });
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
    expect((await json(await get('/api/settings'))).body).toEqual({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null });
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
    expect(body.settings).toEqual({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null });
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
  it('MCP の経路が mount されている', async () => {
    const r = await app.request('/mcp', { method: 'POST', headers: { ...H, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
    expect(r.status).toBe(200);
    expect((await app.request('/mcp', { method: 'POST', body: '{}' })).status).toBe(401);
  });
  it('uiDist があれば / でクッキーを付けて index.html を返し、assets も配る', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-dist-'));
    try {
      fs.writeFileSync(path.join(dist, 'index.html'), '<html>hi</html>');
      fs.mkdirSync(path.join(dist, 'assets'));
      fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
      const ui = createApp({ db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, port: 4177, version: 'v', settings: () => ({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null }), updateSettings: () => ({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null }), live: () => [], indexer: { progress: () => ({ phase: 'idle', done: 0, total: 0 }), rebuild: async () => {} }, hub: { broadcast: () => {} }, runs: fakeRuns(), external: fakeExternal(), uiDist: dist });
      const r = await ui.request('/');
      expect(r.status).toBe(200);
      expect(r.headers.get('set-cookie')).toBe(`hangar_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
      expect(await r.text()).toBe('<html>hi</html>');
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
});
