import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHARED_TABLES } from '@agent-hangar/shared';
import { upsertShared } from '../../db/shared.ts';
import { createAddressBook } from '../../remote/addresses.ts';
import { RemoteShellService, type LinkLike, type RemoteShellEvent } from '../../remote/service.ts';
import { getRemoteHost, getRemoteTab } from '../../remote/store.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// SSH のシェルタブの経路（routes/remoteShell.ts）。サービスは本物で、link だけを偽にする。

const PEER = 'pc-b';
let t: TestWorld;
let app: ReturnType<typeof createApp>;
let svc: RemoteShellService;
let sent: RemoteShellEvent[];
let links: string[][];

const req = (method: string, p: string, body?: unknown) => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

beforeEach(async () => {
  t = await testDeps();
  sent = [];
  links = [];
  upsertShared(t.db, 'devices', { id: PEER, name: 'Win', platform: 'win32', last_seen_at: 1, status: null }, PEER);
  upsertShared(t.db, 'sessions', { id: 'rs1', provider: 'claude-code', provider_session_id: 'u-rs1', cwd: '/x', home_device: PEER, project_id: null }, PEER);
  upsertShared(t.db, 'runs', { id: 'rr1', session_id: 'rs1', device_id: PEER, kind: 'start', tmux_name: 'hangar-x', pid: null, launch_params: '{}', started_at: 5, ended_at: null, end_reason: null, heartbeat_at: 5 }, PEER);
  let n = 0;
  svc = new RemoteShellService({
    db: t.db, selfId: 'd', broadcast: (ev) => { sent.push(ev); },
    linkDeps: { db: t.db, spawn: () => { throw new Error('no'); }, addressBook: createAddressBook() },
    newId: () => `rt${++n}`, now: () => 7,
    makeLink: () => { const calls: string[] = []; links.push(calls); const l: LinkLike = { start: async () => {}, retry: async () => {}, write: () => {}, resize: () => {}, detach: () => { calls.push('detach'); }, close: async () => { calls.push('close'); }, closeUnattached: async () => { calls.push('closeUnattached'); } }; return l; },
  });
  app = createApp({ ...t.deps, remoteShell: svc });
});
afterEach(() => { t.dispose(); });

describe('POST /api/sessions/:id/remote-tabs', () => {
  it('持ち主の PC が別なら 201 で RemoteTabDto（status が無くても開ける）', async () => {
    const r = await req('POST', '/api/sessions/rs1/remote-tabs');
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ id: 'rt1', sessionId: 'rs1', deviceId: PEER, title: 'Win', createdAt: 7 });
    expect(sent).toEqual([{ type: 'remoteTab.upsert', tab: { id: 'rt1', sessionId: 'rs1', deviceId: PEER, title: 'Win', createdAt: 7 } }]);
  });
  it('持ち主が引けない会話は 404', async () => {
    expect((await req('POST', '/api/sessions/nope/remote-tabs')).status).toBe(404);
  });
  it('サービスを持たない組み立てでは経路が無い', async () => {
    const bare = createApp(t.deps);
    expect((await bare.request('/api/sessions/rs1/remote-tabs', { method: 'POST', headers: H })).status).toBe(404);
  });
});

describe('DELETE /api/remote-tabs/:id', () => {
  it('204 で閉じ、closed を配る。つないでいなければ一時の link で閉じる', async () => {
    await req('POST', '/api/sessions/rs1/remote-tabs');
    const r = await req('DELETE', '/api/remote-tabs/rt1');
    expect(r.status).toBe(204);
    await svc.idle();
    expect(getRemoteTab(t.db, 'rt1')?.closedAt).toBe(7);
    expect(sent.at(-1)).toEqual({ type: 'remoteTab.closed', id: 'rt1' });
    expect(links).toEqual([['closeUnattached']]);
  });
  it('知らないタブは 404', async () => {
    expect((await req('DELETE', '/api/remote-tabs/nope')).status).toBe(404);
  });
});

describe('PUT /api/devices/:deviceId/ssh-host', () => {
  it('Host 名を置いて 204、remoteHost.changed を配る。null で外す', async () => {
    expect((await req('PUT', `/api/devices/${PEER}/ssh-host`, { host: 'win-box' })).status).toBe(204);
    expect(getRemoteHost(t.db, PEER)).toBe('win-box');
    expect((await req('PUT', `/api/devices/${PEER}/ssh-host`, { host: null })).status).toBe(204);
    expect(getRemoteHost(t.db, PEER)).toBeNull();
    expect(sent).toEqual([{ type: 'remoteHost.changed', deviceId: PEER, host: 'win-box' }, { type: 'remoteHost.changed', deviceId: PEER, host: null }]);
  });
  it.each([['-oProxyCommand=x'], ['a b'], ["a'b"], ['a"b'], ['a\nb'], ['a'.repeat(254)], [''], [3]])('検査に落ちる Host は 400: %j', async (host) => {
    expect((await req('PUT', `/api/devices/${PEER}/ssh-host`, { host })).status).toBe(400);
    expect(getRemoteHost(t.db, PEER)).toBeNull();
  });
  it('host の欄が無い本文は 400', async () => {
    expect((await req('PUT', `/api/devices/${PEER}/ssh-host`, {})).status).toBe(400);
  });
});

describe('bootstrap と同期', () => {
  it('bootstrap に開いているタブと上書きの Host を載せる', async () => {
    await req('POST', '/api/sessions/rs1/remote-tabs');
    await req('PUT', `/api/devices/${PEER}/ssh-host`, { host: 'win-box' });
    const body = await (await req('GET', '/api/bootstrap')).json();
    expect(body.remoteTabs).toEqual([{ id: 'rt1', sessionId: 'rs1', deviceId: PEER, title: 'Win', createdAt: 7 }]);
    expect(body.remoteHosts).toEqual({ [PEER]: 'win-box' });
  });
  it('経路で開け閉めしても、同期の送り出し（changes）に行が増えない', async () => {
    expect(SHARED_TABLES).not.toContain('remote_tabs');
    const count = () => (t.db.prepare("select count(*) c from changes where table_name in ('remote_tabs', 'remote_ssh_hosts')").get() as { c: number }).c;
    const all = () => (t.db.prepare('select count(*) c from changes').get() as { c: number }).c;
    const before = all();
    await req('POST', '/api/sessions/rs1/remote-tabs');
    await req('PUT', `/api/devices/${PEER}/ssh-host`, { host: 'win-box' });
    await req('DELETE', '/api/remote-tabs/rt1');
    await svc.idle();
    expect(all()).toBe(before);
    expect(count()).toBe(0);
  });
});
