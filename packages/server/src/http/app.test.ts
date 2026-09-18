import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent, SettingsDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { createApp } from './app.ts';

let dir: string;
let db: Db;
let ws: string;
let app: ReturnType<typeof createApp>;
const sent: ServerEvent[] = [];
const TOKEN = 'test-token';
const H = { authorization: `Bearer ${TOKEN}` };
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:'); sent.length = 0;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-app-'));
  fs.mkdirSync(`${ws}/alpha`);
  const indexer = new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false });
  await indexer.fullScan();
  db.prepare('update sessions set cwd = ? where provider_session_id = ?').run(`${ws}/alpha`, SESSION_ALPHA);
  syncProjectsFromWorkspace(db, 'd', ws); assignSessions(db, 'd');
  let settings: SettingsDto = { workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null };
  app = createApp({ db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, version: '0.0.0-test', settings: () => settings, updateSettings: (p) => (settings = { ...settings, ...p }), live: () => [], indexer, hub: { broadcast: (e) => sent.push(e) } });
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
  it('uiDist があれば / でクッキーを付けて index.html を返し、assets も配る', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-dist-'));
    try {
      fs.writeFileSync(path.join(dist, 'index.html'), '<html>hi</html>');
      fs.mkdirSync(path.join(dist, 'assets'));
      fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
      const ui = createApp({ db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, version: 'v', settings: () => ({ workspaceRoot: ws, claudeDir: dir }), updateSettings: (p) => ({ workspaceRoot: ws, claudeDir: dir, ...p }), live: () => [], indexer: { progress: () => ({ phase: 'idle', done: 0, total: 0 }), rebuild: async () => {} }, hub: { broadcast: () => {} }, uiDist: dist });
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
